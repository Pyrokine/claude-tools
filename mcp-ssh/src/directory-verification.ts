import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { SFTPWrapper, Stats } from 'ssh2'
import { formatFileMode } from './file-mode.js'
import type { OpenSshConnection } from './openssh.js'
import { remoteJoin } from './remote-platform.js'
import { withSftpOperationTimeout } from './sftp-timeout.js'
import { escapeShellArg } from './tools/utils.js'
import type { RemotePathStyle } from './types.js'

export type DirectoryVerificationControl = { deadline: number; signal: AbortSignal }

export function remainingVerificationTimeout(control: DirectoryVerificationControl): number {
    if (control.signal.aborted) {
        throw control.signal.reason
    }
    const remaining = control.deadline - Date.now()
    if (remaining <= 0) {
        throw new Error('directory verification exhausted the sync operation timeout')
    }
    return remaining
}

async function withDirectoryVerificationBudget<T>(
    action: () => Promise<T>,
    control?: DirectoryVerificationControl,
    cancel?: () => void
): Promise<T> {
    if (!control) {
        return action()
    }
    const timeout = remainingVerificationTimeout(control)
    const result = await withSftpOperationTimeout(action(), timeout, () => cancel?.(), control.signal)
    remainingVerificationTimeout(control)
    return result
}

export const DIRECTORY_VERIFY_MAX_ENTRIES = 50_000
export const DIRECTORY_VERIFY_MAX_MISMATCHES = 20
export const DIRECTORY_VERIFY_DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024
export const DIRECTORY_VERIFY_DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024
export const DIRECTORY_VERIFY_MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024
export const DIRECTORY_VERIFY_MAX_TOTAL_BYTES = 16 * 1024 * 1024 * 1024

export type DirectoryVerifyRequest = {
    count?: boolean
    sha256?: boolean
    owner?: boolean
    mode?: boolean
    aclSddl?: string
    deletions?: boolean
    staleFiles?: boolean
    maxEntries?: number
    maxFileBytes?: number
    maxTotalBytes?: number
}

type ManifestEntry = {
    path: string
    type: 'file' | 'directory'
    size: number
    mode: string
    owner: string
    sha256?: string
}

type DirectoryManifestLimitReason = 'entries' | 'file_bytes' | 'total_bytes' | 'depth'

export type DirectoryManifest = {
    entries: ManifestEntry[]
    count: number
    rootSha256: string
    limited: boolean
    limitReason?: DirectoryManifestLimitReason
    skippedSymlinks: number
    skippedUnsupported: number
    unsupportedSamples: string[]
}

function rootHash(entries: ManifestEntry[], control?: DirectoryVerificationControl): string {
    if (control) {
        remainingVerificationTimeout(control)
    }
    const hash = createHash('sha256')
    for (const entry of [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))) {
        if (control) {
            remainingVerificationTimeout(control)
        }
        hash.update(
            JSON.stringify({
                path: entry.path,
                type: entry.type,
                size: entry.size,
                sha256: entry.sha256,
            })
        )
        hash.update('\n')
    }
    return hash.digest('hex')
}

async function hashFile(
    filePath: string,
    size: number,
    maxBytes: number,
    control?: DirectoryVerificationControl
): Promise<string> {
    if (control) {
        remainingVerificationTimeout(control)
    }
    const stream = fs.createReadStream(filePath)
    try {
        return await withDirectoryVerificationBudget(
            async () => {
                const hash = createHash('sha256')
                let readBytes = 0
                for await (const chunk of stream) {
                    readBytes += Buffer.byteLength(chunk)
                    if (readBytes > maxBytes) {
                        throw new Error('local file grew beyond directory manifest hash budget')
                    }
                    hash.update(chunk)
                }
                if (readBytes !== size) {
                    throw new Error('local file changed during manifest hashing')
                }
                return hash.digest('hex')
            },
            control,
            () => {
                stream.destroy()
            }
        )
    } finally {
        stream.destroy()
    }
}

export function matchesDirectoryExclude(
    relativePath: string,
    patterns: string[] | undefined,
    isDirectory: boolean = false
): boolean {
    const normalizedPath = relativePath.replace(/^\.\//, '').replace(/^\//, '')
    const basename = path.posix.basename(normalizedPath)
    return Boolean(
        patterns?.some((pattern) => {
            const directoryOnly = pattern.endsWith('/')
            if (directoryOnly && !isDirectory) {
                return false
            }
            const normalizedPattern = pattern.replace(/^\//, '').replace(/\/$/, '')
            const candidate = normalizedPattern.includes('/') ? normalizedPath : basename
            const matches = new Uint8Array(candidate.length + 1)
            matches[0] = 1
            for (let index = 0; index < normalizedPattern.length; ++index) {
                const character = normalizedPattern[index]
                const globstar = character === '*' && normalizedPattern[index + 1] === '*'
                if (globstar) {
                    ++index
                }
                let previous = matches[0]
                if (character !== '*') {
                    matches[0] = 0
                }
                for (let offset = 1; offset <= candidate.length; ++offset) {
                    const before = matches[offset]
                    const value = candidate[offset - 1]
                    if (character === '*') {
                        const canConsume = globstar ? /./.test(value) : value !== '/'
                        matches[offset] = before || (matches[offset - 1] && canConsume) ? 1 : 0
                    } else {
                        matches[offset] = previous && (character === '?' ? value !== '/' : character === value) ? 1 : 0
                    }
                    previous = before
                }
            }
            return matches[candidate.length] === 1
        })
    )
}

export async function createLocalDirectoryManifest(
    rootPath: string,
    request: DirectoryVerifyRequest,
    exclude?: string[],
    followSymlinks: boolean = false,
    control?: DirectoryVerificationControl
): Promise<DirectoryManifest> {
    const maxEntries = Math.min(request.maxEntries ?? 10_000, DIRECTORY_VERIFY_MAX_ENTRIES)
    const maxFileBytes = Math.min(
        request.maxFileBytes ?? DIRECTORY_VERIFY_DEFAULT_MAX_FILE_BYTES,
        DIRECTORY_VERIFY_MAX_FILE_BYTES
    )
    const maxTotalBytes = Math.min(
        request.maxTotalBytes ?? DIRECTORY_VERIFY_DEFAULT_MAX_TOTAL_BYTES,
        DIRECTORY_VERIFY_MAX_TOTAL_BYTES
    )
    const rootStats = await withDirectoryVerificationBudget(() => fs.promises.stat(rootPath), control)
    if (!rootStats.isDirectory()) {
        throw new Error(`directory verification root is not a directory: ${rootPath}`)
    }
    const entries: ManifestEntry[] = [
        {
            path: '.',
            type: 'directory',
            size: 0,
            mode: formatFileMode(rootStats.mode),
            owner: String(rootStats.uid),
        },
    ]
    const activeDirectories = new Set<string>()
    let hashedBytes = 0
    let skippedSymlinks = 0
    let skippedUnsupported = 0
    const unsupportedSamples: string[] = []
    let limitReason: DirectoryManifestLimitReason | undefined

    const visit = async (currentPath: string, relativeBase: string): Promise<void> => {
        const realPath = await withDirectoryVerificationBudget(() => fs.promises.realpath(currentPath), control)
        if (activeDirectories.has(realPath)) {
            skippedSymlinks++
            return
        }
        activeDirectories.add(realPath)
        try {
            for (const name of await withDirectoryVerificationBudget(() => fs.promises.readdir(currentPath), control)) {
                if (control) {
                    remainingVerificationTimeout(control)
                }
                const relativePath = relativeBase ? `${relativeBase}/${name}` : name
                if (matchesDirectoryExclude(relativePath, exclude)) {
                    continue
                }
                const fullPath = path.join(currentPath, name)
                const linkStats = await withDirectoryVerificationBudget(() => fs.promises.lstat(fullPath), control)
                const stats =
                    linkStats.isSymbolicLink() && followSymlinks
                        ? await withDirectoryVerificationBudget(() => fs.promises.stat(fullPath), control)
                        : linkStats
                if (matchesDirectoryExclude(relativePath, exclude, stats.isDirectory())) {
                    continue
                }
                if (entries.length >= maxEntries) {
                    limitReason = 'entries'
                    return
                }
                if (linkStats.isSymbolicLink() && !followSymlinks) {
                    skippedSymlinks++
                    continue
                }
                if (stats.isDirectory()) {
                    entries.push({
                        path: relativePath,
                        type: 'directory',
                        size: 0,
                        mode: formatFileMode(stats.mode),
                        owner: String(stats.uid),
                    })
                    await visit(fullPath, relativePath)
                    if (limitReason) {
                        return
                    }
                } else if (stats.isFile()) {
                    let sha256: string | undefined
                    if (request.sha256) {
                        if (stats.size > maxFileBytes) {
                            limitReason = 'file_bytes'
                            return
                        }
                        if (hashedBytes + stats.size > maxTotalBytes) {
                            limitReason = 'total_bytes'
                            return
                        }
                        sha256 = await hashFile(
                            fullPath,
                            stats.size,
                            Math.min(maxFileBytes, maxTotalBytes - hashedBytes),
                            control
                        )
                        hashedBytes += stats.size
                    }
                    entries.push({
                        path: relativePath,
                        type: 'file',
                        size: stats.size,
                        mode: formatFileMode(stats.mode),
                        owner: String(stats.uid),
                        sha256,
                    })
                } else {
                    ++skippedUnsupported
                    if (unsupportedSamples.length < 10) {
                        unsupportedSamples.push(relativePath)
                    }
                }
            }
        } finally {
            activeDirectories.delete(realPath)
        }
    }

    await visit(rootPath, '')
    return {
        entries,
        count: entries.length,
        rootSha256: rootHash(entries, control),
        limited: limitReason !== undefined,
        limitReason,
        skippedSymlinks,
        skippedUnsupported,
        unsupportedSamples,
    }
}

export async function createRemoteDirectoryManifest(
    sftp: SFTPWrapper,
    rootPath: string,
    request: DirectoryVerifyRequest,
    exclude?: string[],
    followSymlinks: boolean = false,
    style: RemotePathStyle = 'posix',
    control?: DirectoryVerificationControl
): Promise<DirectoryManifest> {
    const maxEntries = Math.min(request.maxEntries ?? 10_000, DIRECTORY_VERIFY_MAX_ENTRIES)
    const maxFileBytes = Math.min(
        request.maxFileBytes ?? DIRECTORY_VERIFY_DEFAULT_MAX_FILE_BYTES,
        DIRECTORY_VERIFY_MAX_FILE_BYTES
    )
    const maxTotalBytes = Math.min(
        request.maxTotalBytes ?? DIRECTORY_VERIFY_DEFAULT_MAX_TOTAL_BYTES,
        DIRECTORY_VERIFY_MAX_TOTAL_BYTES
    )
    const join = (parent: string, child: string): string => remoteJoin(style, parent, child)
    const stat = (remotePath: string): Promise<Stats> =>
        withDirectoryVerificationBudget(
            () =>
                new Promise((resolve, reject) => {
                    sftp.stat(remotePath, (error, stats) => (error ? reject(error) : resolve(stats)))
                }),
            control
        )
    const lstat = (remotePath: string): Promise<Stats> =>
        withDirectoryVerificationBudget(
            () =>
                new Promise((resolve, reject) => {
                    sftp.lstat(remotePath, (error, stats) => (error ? reject(error) : resolve(stats)))
                }),
            control
        )
    const root = await stat(rootPath)
    if ((root.mode & 0o170000) !== 0o040000) {
        throw new Error('remote directory verification root is not a directory')
    }
    const entry = (name: string, kind: 'file' | 'directory', stats: Stats, sha256?: string): ManifestEntry => ({
        path: name,
        type: kind,
        size: kind === 'file' ? stats.size : 0,
        mode: formatFileMode(stats.mode),
        owner: String(stats.uid),
        sha256,
    })
    const entries = [entry('.', 'directory', root)]
    let hashedBytes = 0
    let skippedSymlinks = 0
    let skippedUnsupported = 0
    const unsupportedSamples: string[] = []
    let limitReason: DirectoryManifestLimitReason | undefined
    const active = new Set<string>()
    const visit = async (directory: string, relative: string, depth: number): Promise<void> => {
        if (depth > 64) {
            limitReason = 'depth'
            return
        }
        const resolved = await withDirectoryVerificationBudget(
            () =>
                new Promise<string>((resolve, reject) => {
                    sftp.realpath(directory, (error, result) => (error ? reject(error) : resolve(result)))
                }),
            control
        )
        if (active.has(resolved)) {
            ++skippedSymlinks
            return
        }
        active.add(resolved)
        const handle = await withDirectoryVerificationBudget(
            () =>
                new Promise<Buffer>((resolve, reject) => {
                    sftp.opendir(directory, (error, result) => (error ? reject(error) : resolve(result)))
                }),
            control
        )
        try {
            while (!limitReason) {
                const batch = await withDirectoryVerificationBudget(
                    () =>
                        new Promise<Array<{ filename: string; attrs: Stats }> | null>((resolve, reject) => {
                            sftp.readdir(handle, (error, list) => {
                                if (error && (error as Error & { code?: number }).code === 1) {
                                    resolve(null)
                                } else if (error) {
                                    reject(error)
                                } else {
                                    resolve(list)
                                }
                            })
                        }),
                    control
                )
                if (!batch) {
                    break
                }
                for (const item of batch) {
                    const name = item.filename
                    if (!name || name.length > 1024 || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
                        throw new Error('remote directory verification returned unsafe entry name')
                    }
                    const relativePath = relative ? `${relative}/${name}` : name
                    if (matchesDirectoryExclude(relativePath, exclude)) {
                        continue
                    }
                    const fullPath = join(directory, name)
                    const link = await lstat(fullPath)
                    const stats = (link.mode & 0o170000) === 0o120000 && followSymlinks ? await stat(fullPath) : link
                    if (matchesDirectoryExclude(relativePath, exclude, (stats.mode & 0o170000) === 0o040000)) {
                        continue
                    }
                    if (entries.length >= maxEntries) {
                        limitReason = 'entries'
                        break
                    }
                    if ((link.mode & 0o170000) === 0o120000 && !followSymlinks) {
                        ++skippedSymlinks
                        continue
                    }
                    if ((stats.mode & 0o170000) === 0o040000) {
                        entries.push(entry(relativePath, 'directory', stats))
                        await visit(fullPath, relativePath, depth + 1)
                    } else if ((stats.mode & 0o170000) === 0o100000) {
                        if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
                            throw new Error('remote manifest returned an invalid file size')
                        }
                        let sha256: string | undefined
                        if (request.sha256) {
                            if (stats.size > maxFileBytes) {
                                limitReason = 'file_bytes'
                                break
                            }
                            if (hashedBytes + stats.size > maxTotalBytes) {
                                limitReason = 'total_bytes'
                                break
                            }
                            const digest = createHash('sha256')
                            let actualSize = 0
                            if (control) {
                                remainingVerificationTimeout(control)
                            }
                            const stream = sftp.createReadStream(fullPath)
                            try {
                                await withDirectoryVerificationBudget(
                                    async () => {
                                        for await (const chunk of stream) {
                                            actualSize += Buffer.byteLength(chunk)
                                            if (actualSize > maxFileBytes) {
                                                limitReason = 'file_bytes'
                                                break
                                            }
                                            if (hashedBytes + actualSize > maxTotalBytes) {
                                                limitReason = 'total_bytes'
                                                break
                                            }
                                            digest.update(chunk)
                                        }
                                    },
                                    control,
                                    () => {
                                        stream.destroy()
                                    }
                                )
                            } finally {
                                stream.destroy()
                            }
                            if (limitReason) {
                                break
                            }
                            if (actualSize !== stats.size) {
                                throw new Error('remote file changed during manifest hashing')
                            }
                            hashedBytes += actualSize
                            sha256 = digest.digest('hex')
                        }
                        entries.push(entry(relativePath, 'file', stats, sha256))
                    } else {
                        ++skippedUnsupported
                        if (unsupportedSamples.length < 10) {
                            unsupportedSamples.push(relativePath)
                        }
                    }
                    if (limitReason) {
                        break
                    }
                }
            }
        } finally {
            active.delete(resolved)
            if (!control?.signal.aborted) {
                await withDirectoryVerificationBudget(
                    () =>
                        new Promise<void>((resolve, reject) =>
                            sftp.close(handle, (error) => (error ? reject(error) : resolve()))
                        ),
                    control
                )
            }
        }
    }
    await visit(rootPath, '', 0)
    return {
        entries,
        count: entries.length,
        rootSha256: rootHash(entries, control),
        limited: limitReason !== undefined,
        limitReason,
        skippedSymlinks,
        skippedUnsupported,
        unsupportedSamples,
    }
}

export async function createOpenSshDirectoryManifest(
    connection: OpenSshConnection,
    rootPath: string,
    request: DirectoryVerifyRequest,
    timeout: number,
    exclude?: string[],
    followSymlinks: boolean = false,
    control?: DirectoryVerificationControl
): Promise<DirectoryManifest> {
    const deadline = Math.min(Date.now() + timeout, control?.deadline ?? Infinity)
    const remaining = (): number => {
        if (control) {
            remainingVerificationTimeout(control)
        }
        const value = deadline - Date.now()
        if (value <= 0) {
            throw new Error('OpenSSH directory verification exhausted its timeout')
        }
        return value
    }
    const maxEntries = Math.min(request.maxEntries ?? 10_000, DIRECTORY_VERIFY_MAX_ENTRIES)
    const maxFileBytes = Math.min(
        request.maxFileBytes ?? DIRECTORY_VERIFY_DEFAULT_MAX_FILE_BYTES,
        DIRECTORY_VERIFY_MAX_FILE_BYTES
    )
    const maxTotalBytes = Math.min(
        request.maxTotalBytes ?? DIRECTORY_VERIFY_DEFAULT_MAX_TOTAL_BYTES,
        DIRECTORY_VERIFY_MAX_TOTAL_BYTES
    )
    const rootBytes = await connection.capture(`realpath -ze -- ${escapeShellArg(rootPath)}`, remaining(), 64 * 1024)
    if (rootBytes.at(-1) !== 0) {
        throw new Error('OpenSSH realpath did not return a complete path')
    }
    const root = new TextDecoder('utf8', { fatal: true }).decode(rootBytes.subarray(0, -1))
    if (((await connection.stat(root, remaining())).mode & 0o170000) !== 0o040000) {
        throw new Error('remote directory verification root is not a directory')
    }
    const entries: ManifestEntry[] = []
    const unsupportedSamples: string[] = []
    let skippedSymlinks = 0
    let skippedUnsupported = 0
    let limitReason: DirectoryManifestLimitReason | undefined
    let pending = Buffer.alloc(0)
    const fields: string[] = []
    let metadataBytes = 0
    const metadataLimit = Math.min(128 * 1024 * 1024, Math.max(64 * 1024, maxEntries * 2048))
    const limit = new Error('OpenSSH manifest resource limit reached')
    const decoder = new TextDecoder('utf8', { fatal: true, ignoreBOM: true })
    const consumeEntry = (): void => {
        remaining()
        const [relative, kind, sizeText, modeText, owner, fullPath] = fields
        fields.length = 0
        const parts = relative.split('/')
        if (relative && (relative.startsWith('/') || parts.some((part) => !part || part === '.' || part === '..'))) {
            throw new Error('OpenSSH directory verification returned an unsafe relative path')
        }
        if (
            relative &&
            parts.some((_part, index) =>
                matchesDirectoryExclude(
                    parts.slice(0, index + 1).join('/'),
                    exclude,
                    index < parts.length - 1 || kind === 'd'
                )
            )
        ) {
            return
        }
        if (relative && parts.length > 64) {
            limitReason = 'depth'
            throw limit
        }
        if (entries.length >= maxEntries) {
            limitReason = 'entries'
            throw limit
        }
        if (kind === 'l') {
            ++skippedSymlinks
            return
        }
        if (kind !== 'f' && kind !== 'd') {
            ++skippedUnsupported
            if (unsupportedSamples.length < 10) {
                unsupportedSamples.push(relative)
            }
            return
        }
        const size = Number(sizeText)
        const mode = Number.parseInt(modeText, 8)
        if (
            !Number.isSafeInteger(size) ||
            size < 0 ||
            !/^[0-7]{1,4}$/.test(modeText) ||
            !/^\d+$/.test(owner) ||
            !fullPath
        ) {
            throw new Error('OpenSSH directory verification returned invalid file metadata')
        }
        entries.push({
            path: relative || '.',
            type: kind === 'd' ? 'directory' : 'file',
            size: kind === 'f' ? size : 0,
            mode: formatFileMode(mode),
            owner,
        })
    }
    const format = '%P\\0%y\\0%s\\0%m\\0%U\\0%p\\0'
    try {
        await connection.consume(
            'LC_ALL=C find ' +
                `${followSymlinks ? '-L' : '-P'}` +
                ' ' +
                `${escapeShellArg(root)}` +
                ' -maxdepth 65 -printf ' +
                `${escapeShellArg(format)}`,
            (chunk) => {
                metadataBytes += chunk.length
                if (metadataBytes > metadataLimit) {
                    limitReason = 'entries'
                    throw limit
                }
                pending = Buffer.concat([pending, chunk])
                let end: number
                while ((end = pending.indexOf(0)) >= 0) {
                    fields.push(decoder.decode(pending.subarray(0, end)))
                    pending = pending.subarray(end + 1)
                    if (fields.length === 6) {
                        consumeEntry()
                    }
                }
                if (pending.length > 64 * 1024) {
                    throw new Error('OpenSSH manifest field exceeded its byte budget')
                }
            },
            remaining()
        )
        if (pending.length || fields.length) {
            throw new Error('OpenSSH manifest ended with incomplete metadata')
        }
    } catch (error) {
        if (error !== limit) {
            throw error
        }
    }
    if (!limitReason && request.sha256) {
        let hashedBytes = 0
        for (const entry of entries) {
            if (entry.type !== 'file') {
                continue
            }
            if (entry.size > maxFileBytes) {
                limitReason = 'file_bytes'
                break
            }
            if (hashedBytes + entry.size > maxTotalBytes) {
                limitReason = 'total_bytes'
                break
            }
            entry.sha256 = await connection.hashFile(
                remoteJoin('posix', root, entry.path),
                'sha256',
                remaining(),
                Math.min(maxFileBytes, maxTotalBytes - hashedBytes),
                entry.size
            )
            hashedBytes += entry.size
        }
    }
    return {
        entries,
        count: entries.length,
        rootSha256: rootHash(entries, control),
        limited: limitReason !== undefined,
        limitReason,
        skippedSymlinks,
        skippedUnsupported,
        unsupportedSamples,
    }
}

export function createEmptyDirectoryManifest(): DirectoryManifest {
    const entries: ManifestEntry[] = []
    return {
        entries,
        count: 0,
        rootSha256: rootHash(entries),
        limited: false,
        skippedSymlinks: 0,
        skippedUnsupported: 0,
        unsupportedSamples: [],
    }
}

export function compareDirectoryManifests(
    expected: DirectoryManifest,
    actual: DirectoryManifest,
    request: DirectoryVerifyRequest,
    deletionBaseline?: DirectoryManifest
): Record<string, unknown> {
    if (expected.limited || actual.limited || (request.deletions && deletionBaseline?.limited)) {
        return {
            kind: 'directory',
            skipped: true,
            reason: 'directory verification resource limit reached',
            expectedCount: expected.count,
            actualCount: actual.count,
            expectedLimitReason: expected.limitReason,
            actualLimitReason: actual.limitReason,
            deletionBaselineLimitReason: deletionBaseline?.limitReason,
        }
    }
    if (
        expected.skippedSymlinks > 0 ||
        actual.skippedSymlinks > 0 ||
        (request.deletions && (deletionBaseline?.skippedSymlinks ?? 0) > 0)
    ) {
        return {
            kind: 'directory',
            skipped: true,
            reason: 'directory verification skipped symbolic links and cannot verify the complete requested tree',
            expectedSkippedSymlinks: expected.skippedSymlinks,
            actualSkippedSymlinks: actual.skippedSymlinks,
            deletionBaselineSkippedSymlinks: deletionBaseline?.skippedSymlinks,
        }
    }
    if (
        expected.skippedUnsupported > 0 ||
        actual.skippedUnsupported > 0 ||
        (request.deletions && (deletionBaseline?.skippedUnsupported ?? 0) > 0)
    ) {
        return {
            kind: 'directory',
            skipped: true,
            reason: 'directory verification skipped unsupported filesystem entries',
            expectedSkippedUnsupported: expected.skippedUnsupported,
            actualSkippedUnsupported: actual.skippedUnsupported,
            deletionBaselineSkippedUnsupported: deletionBaseline?.skippedUnsupported,
            expectedUnsupportedSamples: expected.unsupportedSamples,
            actualUnsupportedSamples: actual.unsupportedSamples,
            deletionBaselineUnsupportedSamples: deletionBaseline?.unsupportedSamples,
        }
    }
    const expectedByPath = new Map(expected.entries.map((entry) => [entry.path, entry]))
    const actualByPath = new Map(actual.entries.map((entry) => [entry.path, entry]))
    const mismatches: Array<Record<string, unknown>> = []
    let missing = 0
    let stale = 0
    let typeMismatch = 0
    let ownerMismatch = 0
    let modeMismatch = 0
    let contentMismatch = 0
    const addMismatch = (value: Record<string, unknown>): void => {
        if (mismatches.length < DIRECTORY_VERIFY_MAX_MISMATCHES) {
            mismatches.push(value)
        }
    }
    for (const [entryPath, expectedEntry] of expectedByPath) {
        const actualEntry = actualByPath.get(entryPath)
        if (!actualEntry) {
            missing++
            addMismatch({ path: entryPath, kind: 'missing' })
            continue
        }
        if (expectedEntry.type !== actualEntry.type) {
            typeMismatch++
            addMismatch({ path: entryPath, kind: 'type', expected: expectedEntry.type, actual: actualEntry.type })
            continue
        }
        if (request.owner && expectedEntry.owner !== actualEntry.owner) {
            ownerMismatch++
            addMismatch({ path: entryPath, kind: 'owner', expected: expectedEntry.owner, actual: actualEntry.owner })
        }
        if (request.mode && expectedEntry.mode !== actualEntry.mode) {
            modeMismatch++
            addMismatch({ path: entryPath, kind: 'mode', expected: expectedEntry.mode, actual: actualEntry.mode })
        }
        if (request.sha256 && expectedEntry.sha256 !== actualEntry.sha256) {
            contentMismatch++
            addMismatch({ path: entryPath, kind: 'sha256' })
        }
    }
    for (const entryPath of actualByPath.keys()) {
        if (!expectedByPath.has(entryPath)) {
            stale++
            addMismatch({ path: entryPath, kind: 'stale' })
        }
    }
    const deletionCandidates = deletionBaseline
        ? deletionBaseline.entries
              .map((entry) => entry.path)
              .filter((entryPath) => entryPath !== '.' && !expectedByPath.has(entryPath))
        : []
    const remainingDeletionCandidates = deletionCandidates.filter((entryPath) => actualByPath.has(entryPath))
    for (const entryPath of remainingDeletionCandidates) {
        addMismatch({ path: entryPath, kind: 'deletion_remaining' })
    }
    const checks = {
        entries: missing === 0 && typeMismatch === 0,
        count: request.count ? expected.count === actual.count : true,
        sha256: request.sha256 ? expected.rootSha256 === actual.rootSha256 : true,
        owner: request.owner ? ownerMismatch === 0 : true,
        mode: request.mode ? modeMismatch === 0 : true,
        deletions: request.deletions
            ? deletionBaseline !== undefined && remainingDeletionCandidates.length === 0
            : true,
        staleFiles: request.staleFiles ? stale === 0 : true,
    }
    return {
        kind: 'directory',
        matched: Object.values(checks).every(Boolean),
        checks,
        expected: { count: expected.count, rootSha256: request.sha256 ? expected.rootSha256 : undefined },
        actual: { count: actual.count, rootSha256: request.sha256 ? actual.rootSha256 : undefined },
        summary: {
            missing,
            stale,
            typeMismatch,
            ownerMismatch,
            modeMismatch,
            contentMismatch,
            deletionCandidates: deletionCandidates.length,
            deletedEntries: deletionCandidates.length - remainingDeletionCandidates.length,
            remainingDeletionCandidates: remainingDeletionCandidates.length,
        },
        deletionBaselineCaptured: deletionBaseline !== undefined,
        mismatchSamples: mismatches,
        mismatchSampleLimit: DIRECTORY_VERIFY_MAX_MISMATCHES,
    }
}
