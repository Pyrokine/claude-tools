import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { RemotePathStyle } from './types.js'
import { remoteJoin } from './remote-platform.js'
import { formatFileMode } from './file-mode.js'

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

function rootHash(entries: ManifestEntry[]): string {
    const hash = createHash('sha256')
    for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
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

async function hashFile(filePath: string, size: number, maxBytes: number): Promise<string> {
    const hash = createHash('sha256')
    let readBytes = 0
    for await (const chunk of fs.createReadStream(filePath)) {
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
}

function globPatternToRegExp(pattern: string): RegExp {
    let expression = ''
    for (let index = 0; index < pattern.length; ++index) {
        const character = pattern[index]
        if (character === '*' && pattern[index + 1] === '*') {
            expression += '.*'
            ++index
        } else if (character === '*') {
            expression += '[^/]*'
        } else if (character === '?') {
            expression += '[^/]'
        } else {
            expression += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        }
    }
    return new RegExp(`^${expression}$`)
}

const excludePatternCache = new Map<string, RegExp>()

export function matchesDirectoryExclude(relativePath: string, patterns: string[] | undefined): boolean {
    const normalizedPath = relativePath.replace(/^\.\//, '').replace(/^\//, '')
    const basename = path.posix.basename(normalizedPath)
    return Boolean(
        patterns?.some((pattern) => {
            const normalizedPattern = pattern.replace(/^\//, '')
            let regex = excludePatternCache.get(normalizedPattern)
            if (!regex) {
                regex = globPatternToRegExp(normalizedPattern)
                excludePatternCache.set(normalizedPattern, regex)
            }
            return regex.test(normalizedPattern.includes('/') ? normalizedPath : basename)
        })
    )
}

export async function createLocalDirectoryManifest(
    rootPath: string,
    request: DirectoryVerifyRequest,
    exclude?: string[],
    followSymlinks: boolean = false
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
    const rootStats = await fs.promises.stat(rootPath)
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
        const realPath = await fs.promises.realpath(currentPath)
        if (activeDirectories.has(realPath)) {
            skippedSymlinks++
            return
        }
        activeDirectories.add(realPath)
        try {
            for (const name of await fs.promises.readdir(currentPath)) {
                const relativePath = relativeBase ? `${relativeBase}/${name}` : name
                if (matchesDirectoryExclude(relativePath, exclude)) {
                    continue
                }
                if (entries.length >= maxEntries) {
                    limitReason = 'entries'
                    return
                }
                const fullPath = path.join(currentPath, name)
                const linkStats = await fs.promises.lstat(fullPath)
                if (linkStats.isSymbolicLink() && !followSymlinks) {
                    skippedSymlinks++
                    continue
                }
                const stats = linkStats.isSymbolicLink() ? await fs.promises.stat(fullPath) : linkStats
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
                            Math.min(maxFileBytes, maxTotalBytes - hashedBytes)
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
        rootSha256: rootHash(entries),
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
    style: RemotePathStyle = 'posix'
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
        new Promise((resolve, reject) => {
            sftp.stat(remotePath, (error, stats) => (error ? reject(error) : resolve(stats)))
        })
    const lstat = (remotePath: string): Promise<Stats> =>
        new Promise((resolve, reject) => {
            sftp.lstat(remotePath, (error, stats) => (error ? reject(error) : resolve(stats)))
        })
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
        const resolved = await new Promise<string>((resolve, reject) => {
            sftp.realpath(directory, (error, result) => (error ? reject(error) : resolve(result)))
        })
        if (active.has(resolved)) {
            ++skippedSymlinks
            return
        }
        active.add(resolved)
        const handle = await new Promise<Buffer>((resolve, reject) => {
            sftp.opendir(directory, (error, result) => (error ? reject(error) : resolve(result)))
        })
        try {
            while (!limitReason) {
                const batch = await new Promise<Array<{ filename: string; attrs: Stats }> | null>((resolve, reject) => {
                    sftp.readdir(handle, (error, list) => {
                        if (error && (error as Error & { code?: number }).code === 1) {
                            resolve(null)
                        } else if (error) {
                            reject(error)
                        } else {
                            resolve(list)
                        }
                    })
                })
                if (!batch || batch.length === 0) {
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
                    if (entries.length >= maxEntries) {
                        limitReason = 'entries'
                        break
                    }
                    const fullPath = join(directory, name)
                    const link = await lstat(fullPath)
                    if ((link.mode & 0o170000) === 0o120000 && !followSymlinks) {
                        ++skippedSymlinks
                        continue
                    }
                    const stats = (link.mode & 0o170000) === 0o120000 ? await stat(fullPath) : link
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
                            for await (const chunk of sftp.createReadStream(fullPath)) {
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
            await new Promise<void>((resolve, reject) =>
                sftp.close(handle, (error) => (error ? reject(error) : resolve()))
            )
        }
    }
    await visit(rootPath, '', 0)
    return {
        entries,
        count: entries.length,
        rootSha256: rootHash(entries),
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
            reason: 'directory verification skipped symbolic links; set followSymlinks=true to verify link targets',
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
