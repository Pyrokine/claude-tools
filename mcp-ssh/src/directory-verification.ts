import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { escapeShellArg } from './tools/utils.js'

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

type DirectoryManifestLimitReason = 'entries' | 'file_bytes' | 'total_bytes'

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

async function hashFile(filePath: string): Promise<string> {
    const hash = createHash('sha256')
    await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(filePath)
        stream.on('data', (chunk) => hash.update(chunk))
        stream.on('error', reject)
        stream.on('end', resolve)
    })
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
            mode: (rootStats.mode & 0o777).toString(8).padStart(4, '0'),
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
                        mode: (stats.mode & 0o777).toString(8).padStart(4, '0'),
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
                        hashedBytes += stats.size
                        sha256 = await hashFile(fullPath)
                    }
                    entries.push({
                        path: relativePath,
                        type: 'file',
                        size: stats.size,
                        mode: (stats.mode & 0o777).toString(8).padStart(4, '0'),
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

function buildExcludeRegexes(exclude: string[] | undefined): { path?: string; basename?: string } {
    const pathPatterns: string[] = []
    const basenamePatterns: string[] = []
    for (const pattern of exclude ?? []) {
        const normalized = pattern.replace(/^\//, '')
        const expression = globPatternToRegExp(normalized).source.replace(/^\^|\$$/g, '')
        if (normalized.includes('/')) {
            pathPatterns.push(expression)
        } else {
            basenamePatterns.push(expression)
        }
    }
    return {
        path: pathPatterns.length > 0 ? `^(${pathPatterns.join('|')})$` : undefined,
        basename: basenamePatterns.length > 0 ? `^(${basenamePatterns.join('|')})$` : undefined,
    }
}

export function buildRemoteDirectoryManifestCommand(
    rootPath: string,
    request: DirectoryVerifyRequest,
    exclude?: string[],
    followSymlinks: boolean = false
): string {
    const maxEntries = Math.min(request.maxEntries ?? 10_000, DIRECTORY_VERIFY_MAX_ENTRIES)
    const maxFileBytes = Math.min(
        request.maxFileBytes ?? DIRECTORY_VERIFY_DEFAULT_MAX_FILE_BYTES,
        DIRECTORY_VERIFY_MAX_FILE_BYTES
    )
    const maxTotalBytes = Math.min(
        request.maxTotalBytes ?? DIRECTORY_VERIFY_DEFAULT_MAX_TOTAL_BYTES,
        DIRECTORY_VERIFY_MAX_TOTAL_BYTES
    )
    const normalizedRoot = rootPath.replace(/\/+$/, '') || '/'
    const root = escapeShellArg(normalizedRoot)
    const includeHash = request.sha256 === true
    const excludeRegexes = buildExcludeRegexes(exclude)
    const pathExcludeRegex = excludeRegexes.path ? escapeShellArg(excludeRegexes.path) : undefined
    const basenameExcludeRegex = excludeRegexes.basename ? escapeShellArg(excludeRegexes.basename) : undefined
    const findFollow = followSymlinks ? '-L' : '-H'
    const script = [
        'set -euo pipefail',
        'export LC_ALL=C',
        `root=${root}`,
        '[ -d "$root" ] || { printf "remote directory does not exist\\n" >&2; exit 3; }',
        'count=0',
        'hashed_bytes=0',
        'skipped_symlinks=0',
        'skipped_unsupported=0',
        'unsupported_samples=()',
        'excluded_dirs=()',
        'while IFS= read -r -d "" item; do',
        '  if [ "$item" = "__MCP_FIND_ERROR__" ]; then exit 4; fi',
        '  if [ "$item" = "$root" ]; then rel=.; elif [ "$root" = / ]; then rel=${item#/}; else rel=${item#"$root"/}; fi',
        '  for excluded_dir in "${excluded_dirs[@]}"; do case "$rel" in "$excluded_dir"/*) continue 2;; esac; done',
        pathExcludeRegex
            ? `  if [ "$rel" != . ] && printf %s "$rel" | grep -Eq -- ${pathExcludeRegex}; then [ -d "$item" ] && excluded_dirs+=("$rel"); continue; fi`
            : '  :',
        basenameExcludeRegex
            ? `  base=${'${rel##*/}'}; if [ "$rel" != . ] && printf %s "$base" | grep -Eq -- ${basenameExcludeRegex}; then [ -d "$item" ] && excluded_dirs+=("$rel"); continue; fi`
            : '  :',
        followSymlinks
            ? '  :'
            : '  if [ "$rel" != . ] && [ -L "$item" ]; then skipped_symlinks=$((skipped_symlinks + 1)); continue; fi',
        '  if [ -d "$item" ]; then type=directory; size=0; elif [ -f "$item" ]; then type=file; size=$(stat -c %s -- "$item"); else skipped_unsupported=$((skipped_unsupported + 1)); if [ "${#unsupported_samples[@]}" -lt 10 ]; then unsupported_samples+=("$(printf %s "$rel" | base64 | tr -d "\\n")"); fi; continue; fi',
        '  count=$((count + 1))',
        `  if [ "$count" -gt ${maxEntries} ]; then printf '__MCP_LIMIT__\\tentries\\n'; break; fi`,
        '  raw_mode=$(stat -c %a -- "$item")',
        '  mode=$(printf \'%04o\' "$((8#$raw_mode & 0777))")',
        '  owner=$(stat -c %u -- "$item")',
        includeHash
            ? `  if [ "$type" = file ]; then
    if [ "$size" -gt ${maxFileBytes} ]; then printf '__MCP_LIMIT__\\tfile_bytes\\n'; break; fi
    next_hashed_bytes=$((hashed_bytes + size))
    if [ "$next_hashed_bytes" -gt ${maxTotalBytes} ]; then printf '__MCP_LIMIT__\\ttotal_bytes\\n'; break; fi
    hashed_bytes=$next_hashed_bytes
    digest=$(sha256sum -- "$item" | cut -d " " -f 1)
  else digest=; fi`
            : '  digest=',
        '  encoded=$(printf %s "$rel" | base64 | tr -d "\\n")',
        '  printf "%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n" "$encoded" "$type" "$size" "$mode" "$owner" "$digest"',
        `done < <({ find ${findFollow} "$root" -print0 || printf '%s\\0' '__MCP_FIND_ERROR__'; })`,
        'printf "__MCP_SKIPPED_SYMLINKS__\\t%s\\n" "$skipped_symlinks"',
        'printf "__MCP_SKIPPED_UNSUPPORTED__\\t%s\\n" "$skipped_unsupported"',
        'for sample in "${unsupported_samples[@]}"; do printf "__MCP_UNSUPPORTED_SAMPLE__\\t%s\\n" "$sample"; done',
    ].join('\n')
    return `bash -c ${escapeShellArg(script)}`
}

function decodeManifestPath(encodedPath: string): string {
    const decodedPath = Buffer.from(encodedPath, 'base64').toString('utf-8')
    if (
        !encodedPath ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedPath) ||
        encodedPath.length % 4 !== 0 ||
        !decodedPath ||
        decodedPath.length > 4096 ||
        decodedPath.includes('\0') ||
        path.posix.isAbsolute(decodedPath) ||
        decodedPath.split('/').includes('..')
    ) {
        throw new Error('remote directory verification returned malformed manifest path')
    }
    return decodedPath
}

export function parseRemoteDirectoryManifest(output: string): DirectoryManifest {
    const entries: ManifestEntry[] = []
    const paths = new Set<string>()
    let skippedSymlinks = 0
    let skippedUnsupported = 0
    const unsupportedSamples: string[] = []
    let limitReason: DirectoryManifestLimitReason | undefined
    for (const line of output.split('\n')) {
        if (!line) {
            continue
        }
        if (line.startsWith('__MCP_LIMIT__\t')) {
            const reason = line.slice('__MCP_LIMIT__\t'.length)
            if (reason === 'entries' || reason === 'file_bytes' || reason === 'total_bytes') {
                limitReason = reason
                continue
            }
            throw new Error('remote directory verification returned an unknown limit reason')
        }
        if (line.startsWith('__MCP_SKIPPED_SYMLINKS__\t')) {
            const count = Number(line.slice('__MCP_SKIPPED_SYMLINKS__\t'.length))
            if (!Number.isSafeInteger(count) || count < 0) {
                throw new Error('remote directory verification returned an invalid symlink count')
            }
            skippedSymlinks = count
            continue
        }
        if (line.startsWith('__MCP_SKIPPED_UNSUPPORTED__\t')) {
            const count = Number(line.slice('__MCP_SKIPPED_UNSUPPORTED__\t'.length))
            if (!Number.isSafeInteger(count) || count < 0) {
                throw new Error('remote directory verification returned an invalid unsupported entry count')
            }
            skippedUnsupported = count
            continue
        }
        if (line.startsWith('__MCP_UNSUPPORTED_SAMPLE__\t')) {
            const encodedPath = line.slice('__MCP_UNSUPPORTED_SAMPLE__\t'.length)
            const samplePath = decodeManifestPath(encodedPath)
            if (unsupportedSamples.length >= 10) {
                throw new Error('remote directory verification returned too many unsupported entry samples')
            }
            unsupportedSamples.push(samplePath)
            continue
        }
        const fields = line.split('\t')
        if (fields.length !== 6) {
            throw new Error('remote directory verification returned malformed manifest data')
        }
        const [encodedPath, type, sizeText, mode, owner, sha256] = fields
        const size = Number(sizeText)
        const entryPath = decodeManifestPath(encodedPath)
        if (
            paths.has(entryPath) ||
            (type !== 'file' && type !== 'directory') ||
            !Number.isSafeInteger(size) ||
            size < 0 ||
            !/^0[0-7]{3}$/.test(mode) ||
            !/^\d+$/.test(owner) ||
            (sha256 !== undefined && sha256 !== '' && !/^[a-f0-9]{64}$/.test(sha256))
        ) {
            throw new Error('remote directory verification returned malformed manifest data')
        }
        paths.add(entryPath)
        entries.push({
            path: entryPath,
            type,
            size,
            mode,
            owner,
            sha256: sha256 || undefined,
        })
    }
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
