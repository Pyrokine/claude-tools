/**
 * SSH File Operations - 文件操作
 */

import { spawn } from 'child_process'
import type { OpenSshConnection } from './openssh.js'
import { OpenSshError } from './openssh.js'
import { createHash, randomBytes } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SFTPWrapper, Stats } from 'ssh2'
import { checkWindowsAcl, windowsAclScript } from './windows-acl.js'
import { matchesDirectoryExclude } from './directory-verification.js'
import { extractFileMode, FILE_CREATE_MODE_MASK, formatFileMode, formatFilePermissions } from './file-mode.js'
import { sessionManager } from './session-manager.js'
import { SftpOperationTimeoutError, withSftpOperationTimeout } from './sftp-timeout.js'
import { escapeShellArg, expandTilde } from './tools/utils.js'
import {
    encodedPowershell,
    remoteDirname,
    remoteJoin,
    remoteNormalize,
    remotePathModule,
    remoteShellPath,
    windowsCaseSemanticsScript,
} from './remote-platform.js'
import { ExternalTransferCapability, FileInfo, TransferProgress } from './types.js'
import { ensureUtf8Boundary, isUtf8ContinuationByte } from './utf8.js'

// 文件类型 mode 常量
const S_IFMT = 0o170000 // 文件类型位掩码
const S_IFDIR = 0o40000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

// rsync 可用性缓存（per alias，连接存续期内不变,disconnect 时由 SessionManager 主动清理）
const RSYNC_CACHE_TTL_MS = 5 * 60_000
const LOCAL_PROCESS_OUTPUT_LIMIT = 200_000

type RsyncProbeResult = {
    available: boolean
    status: 'available' | 'unavailable' | 'timeout' | 'error' | 'skipped'
    duration: number
    retryable: boolean
    exitCode?: number
    failureKind?: string
    error?: string
    reason?: string
}

const rsyncCache = new Map<string, { value: RsyncProbeResult; expiresAt: number }>()
const rsyncAliasGenerations = new Map<string, number>()
let rsyncGlobalGeneration = 0

type RsyncGeneration = {
    global: number
    alias: number
}

type LocalProcessResult = {
    status: number | null
    stdout: string
    stderr: string
    error?: Error
    timedOut?: boolean
}

function appendLimitedOutput(current: string, chunk: string): string {
    if (current.length >= LOCAL_PROCESS_OUTPUT_LIMIT) {
        return current
    }
    return (current + chunk).slice(0, LOCAL_PROCESS_OUTPUT_LIMIT)
}

function runLocalProcess(
    command: string,
    args: string[],
    timeout: number,
    env?: NodeJS.ProcessEnv,
    connection?: OpenSshConnection
): Promise<LocalProcessResult> {
    return new Promise((resolve) => {
        let stdout = ''
        let stderr = ''
        let settled = false
        let timedOut = false
        let killTimer: NodeJS.Timeout | undefined
        connection?.assertCurrent()
        const child = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: env ?? process.env,
            windowsHide: true,
            detached: connection !== undefined,
        })
        connection?.trackProcess(child, true)
        const kill = (signal: NodeJS.Signals): void => {
            if (connection && child.pid) {
                try {
                    process.kill(-child.pid, signal)
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
                        console.error('Local process cleanup failed:', error)
                }
            } else child.kill(signal)
        }
        const timer = setTimeout(() => {
            timedOut = true
            kill('SIGTERM')
            killTimer = setTimeout(() => kill('SIGKILL'), 5000)
        }, timeout)
        child.stdout.on('data', (chunk: Buffer) => {
            stdout = appendLimitedOutput(stdout, chunk.toString('utf-8'))
        })
        child.stderr.on('data', (chunk: Buffer) => {
            stderr = appendLimitedOutput(stderr, chunk.toString('utf-8'))
        })
        child.on('error', (error) => {
            if (settled) {
                return
            }
            settled = true
            clearTimeout(timer)
            if (killTimer) {
                clearTimeout(killTimer)
            }
            resolve({ status: null, stdout, stderr, error, timedOut })
        })
        child.on('close', (status) => {
            if (settled) {
                return
            }
            settled = true
            clearTimeout(timer)
            if (killTimer) {
                clearTimeout(killTimer)
            }
            resolve({ status, stdout, stderr, timedOut })
        })
    })
}

function getRsyncGeneration(alias: string): RsyncGeneration {
    return {
        global: rsyncGlobalGeneration,
        alias: rsyncAliasGenerations.get(alias) ?? 0,
    }
}

function isCurrentRsyncGeneration(alias: string, generation: RsyncGeneration): boolean {
    const current = getRsyncGeneration(alias)
    return current.global === generation.global && current.alias === generation.alias
}

function assertCurrentRsyncGeneration(alias: string, generation: RsyncGeneration): void {
    if (!isCurrentRsyncGeneration(alias, generation)) {
        throw new Error(`SSH session '${alias}' changed during rsync setup; retry the sync on the current session`)
    }
}

/** 由 SessionManager.disconnect 调用,防止 alias 重连后读到旧主机的判断 */
export function clearRsyncCache(alias?: string): void {
    if (alias === undefined) {
        rsyncCache.clear()
        ++rsyncGlobalGeneration
    } else {
        for (const key of rsyncCache.keys()) {
            if (key.startsWith(`${alias}\0`)) {
                rsyncCache.delete(key)
            }
        }
        rsyncAliasGenerations.set(alias, (rsyncAliasGenerations.get(alias) ?? 0) + 1)
    }
}

function positiveIntegerEnv(name: string, defaultValue: number): number {
    const value = Number(process.env[name])
    return Number.isInteger(value) && value > 0 ? value : defaultValue
}

/** SFTP 并发上限,避免单 SSH session 上太多 channel */
const SFTP_PARALLEL_LIMIT = positiveIntegerEnv('SSH_MCP_SFTP_PARALLEL', 8)
const SFTP_SYNC_MAX_FILES = positiveIntegerEnv('SSH_MCP_SFTP_MAX_FILES', 10_000)
const SFTP_SYNC_MAX_DIRECTORIES = positiveIntegerEnv('SSH_MCP_SFTP_MAX_DIRECTORIES', 2_000)
const SFTP_SYNC_MAX_DEPTH = positiveIntegerEnv('SSH_MCP_SFTP_MAX_DEPTH', 64)
const SFTP_SYNC_MAX_BYTES = positiveIntegerEnv('SSH_MCP_SFTP_MAX_BYTES', 10 * 1024 * 1024 * 1024)

type SftpTraversalState = {
    files: number
    directories: number
    bytes: number
    activeDirectories?: Set<string>
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error('SFTP operation aborted')
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw abortError(signal)
    }
}

function assertSftpTraversalBudget(state: SftpTraversalState, depth: number, currentPath: string): void {
    if (depth > SFTP_SYNC_MAX_DEPTH) {
        throw new Error(`SFTP sync traversal depth exceeded at ${currentPath} (max ${SFTP_SYNC_MAX_DEPTH})`)
    }
    if (state.files > SFTP_SYNC_MAX_FILES) {
        throw new Error(`SFTP sync file count exceeded at ${currentPath} (max ${SFTP_SYNC_MAX_FILES})`)
    }
    if (state.directories > SFTP_SYNC_MAX_DIRECTORIES) {
        throw new Error(`SFTP sync directory count exceeded at ${currentPath} (max ${SFTP_SYNC_MAX_DIRECTORIES})`)
    }
    if (state.bytes > SFTP_SYNC_MAX_BYTES) {
        throw new Error(`SFTP sync byte budget exceeded at ${currentPath} (max ${SFTP_SYNC_MAX_BYTES})`)
    }
}

function recordSftpDirectory(state: SftpTraversalState, depth: number, currentPath: string): void {
    state.directories++
    assertSftpTraversalBudget(state, depth, currentPath)
}

function recordSftpFile(state: SftpTraversalState, size: number, depth: number, currentPath: string): void {
    state.files++
    state.bytes += size
    assertSftpTraversalBudget(state, depth, currentPath)
}

/**
 * 简单的并发控制：把异步任务限制在 limit 个 in-flight,串行入队
 */
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
    if (items.length === 0) {
        return
    }
    const it = items[Symbol.iterator]()
    const runners: Promise<void>[] = []
    let failed = false
    for (let i = 0; i < Math.min(limit, items.length); i++) {
        runners.push(
            (async () => {
                while (!failed) {
                    const next = it.next()
                    if (next.done) {
                        return
                    }
                    try {
                        await worker(next.value)
                    } catch (error) {
                        failed = true
                        throw error
                    }
                }
            })()
        )
    }
    const settled = await Promise.allSettled(runners)
    const failure = settled.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') {
        throw failure.reason
    }
}

/**
 * 校验本地路径是否在 SSH_MCP_FILE_OPS_ALLOW_DIRS 白名单内
 *
 * 默认未设置环境变量时不限制（保留灵活性）
 * 设置后,所有 upload/download/sync 的本地路径必须在白名单目录之一内,否则抛出错误
 *
 * 格式：path.delimiter 分隔的绝对路径列表（POSIX `:`,Windows `;`）,如 `/tmp:/home/user/work`
 * 安全性：路径会通过 fs.realpathSync 解析 symlink,防止 symlink 逃出白名单
 */
export function convertRsyncPath(value: string, profile: 'posix' | 'native-win32' | 'msys2' | 'cygwin'): string {
    if (profile === 'native-win32' || profile === 'posix') {
        return value
    }
    const drive = /^([a-zA-Z]):[\\/](.*)$/.exec(value)
    if (drive) {
        const prefix = profile === 'cygwin' ? '/cygdrive/' : '/'
        return `${prefix}${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`
    }
    if (value.startsWith('\\\\')) {
        return `//${value.slice(2).replace(/\\/g, '/')}`
    }
    return value.replace(/\\/g, '/')
}

export function quoteRsyncSshArg(
    value: string | number,
    profile: 'posix' | 'native-win32' | 'msys2' | 'cygwin' = 'posix'
): string {
    const text = String(value)
    if (/[\r\n\0]/.test(text)) {
        throw new Error('rsync SSH argument contains a newline or NUL')
    }
    return profile === 'posix' ? escapeShellArg(text) : `"${text.replace(/([\\"])/g, '\\$1')}"`
}

function configuredAllowDirectories(): { configured: boolean; directories: string[] } {
    const allowEnv = process.env.SSH_MCP_FILE_OPS_ALLOW_DIRS
    const configuredPaths = allowEnv?.split(path.delimiter).filter((item) => item.trim().length > 0) ?? []
    return {
        configured: configuredPaths.length > 0,
        directories: configuredPaths.flatMap((directory) => {
            try {
                return [fs.realpathSync(directory)]
            } catch {
                return []
            }
        }),
    }
}

function isPathInsideDirectory(directory: string, targetPath: string): boolean {
    const relative = path.relative(directory, targetPath)
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function getAllowListStatus(localPath: string): { configured: boolean; matched?: boolean } {
    const allowList = configuredAllowDirectories()
    if (!allowList.configured) {
        return { configured: false }
    }
    const resolvedLocal = resolvePathOrAncestor(localPath)
    return {
        configured: true,
        matched: allowList.directories.some((directory) => isPathInsideDirectory(directory, resolvedLocal)),
    }
}

function validateLocalPathAgainstAllowList(localPath: string): void {
    const allowList = getAllowListStatus(localPath)
    if (allowList.configured && !allowList.matched) {
        throw new Error('localPath 不在 SSH_MCP_FILE_OPS_ALLOW_DIRS 允许目录内')
    }
}

export function validateLocalPathPolicy(localPath: string): void {
    validateLocalPathAgainstAllowList(expandTilde(localPath))
}

function resolvePathOrAncestor(p: string): string {
    const absolute = path.isAbsolute(p) ? p : path.resolve(p)
    try {
        return fs.realpathSync(absolute)
    } catch {
        // 不存在,向上找到第一个存在的祖先
        let dir = absolute
        let tail = ''
        while (dir !== path.dirname(dir)) {
            const parent = path.dirname(dir)
            tail = tail ? path.join(path.basename(dir), tail) : path.basename(dir)
            if (fs.existsSync(parent)) {
                return path.join(fs.realpathSync(parent), tail)
            }
            dir = parent
        }
        return absolute
    }
}

type ValidatedLocalUploadSource = {
    expandedPath: string
    linkStats: fs.Stats
    stats: fs.Stats
}

function validateLocalUploadSource(
    localPath: string,
    followSymlinks: boolean,
    symlinkError: string
): ValidatedLocalUploadSource {
    const expandedPath = expandTilde(localPath)
    validateLocalPathAgainstAllowList(expandedPath)
    if (!fs.existsSync(expandedPath)) {
        throw new Error(`Local source does not exist: ${expandedPath}`)
    }
    const linkStats = fs.lstatSync(expandedPath)
    if (linkStats.isSymbolicLink() && !followSymlinks) {
        throw new Error(symlinkError)
    }
    if (followSymlinks && getAllowListStatus(expandedPath).configured) {
        throw new Error(
            'followSymlinks=true cannot be combined with SSH_MCP_FILE_OPS_ALLOW_DIRS because ' +
                'symlink targets can change during transfer'
        )
    }
    return {
        expandedPath,
        linkStats,
        stats: linkStats.isSymbolicLink() ? fs.statSync(expandedPath) : linkStats,
    }
}

export function validateUploadFileSource(localPath: string): ValidatedLocalUploadSource {
    const source = validateLocalUploadSource(
        localPath,
        false,
        'Refusing to upload symlink at top level (use ssh_sync with followSymlinks=true to traverse)'
    )
    if (source.stats.isDirectory()) {
        throw new Error('UPLOAD_PATH_IS_DIRECTORY: localPath is a directory, use ssh_sync for directory upload')
    }
    if (!source.stats.isFile()) {
        throw new Error('UPLOAD_PATH_IS_NOT_FILE: localPath is not a regular file')
    }
    return source
}

export function validateSyncUploadSource(
    localPath: string,
    followSymlinks: boolean = false
): ValidatedLocalUploadSource {
    return validateLocalUploadSource(
        localPath,
        followSymlinks,
        'Refusing to sync a top-level symlink; set followSymlinks=true to traverse its target'
    )
}

export function probeLocalPath(localPath: string, followSymlinks: boolean = false) {
    const expanded = expandTilde(localPath)
    const resolvedPath = resolvePathOrAncestor(expanded)
    const allowList = getAllowListStatus(expanded)
    if (!fs.existsSync(expanded)) {
        return { exists: false, inputPath: localPath, expandedPath: expanded, resolvedPath, allowList }
    }
    const linkStats = fs.lstatSync(expanded)
    const stats = followSymlinks ? fs.statSync(expanded) : linkStats
    return {
        exists: true,
        inputPath: localPath,
        expandedPath: expanded,
        resolvedPath,
        size: stats.size,
        mode: formatFileMode(stats.mode),
        modeValue: extractFileMode(stats.mode),
        mtimeMs: Math.round(stats.mtimeMs),
        isSymlink: linkStats.isSymbolicLink(),
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        allowList,
    }
}

/**
 * sftp.stat 的 Promise 包装
 */
async function getSftpWithinDeadline(alias: string, timeout?: number): Promise<SFTPWrapper> {
    const request = sessionManager.getSftp(alias)
    return withSftpOperationTimeout(request, timeout, () => {
        void request.then(
            (sftp) => sftp.end(),
            () => undefined
        )
    })
}

function withSftpDeadline<T>(sftp: SFTPWrapper, operation: Promise<T>, timeout?: number): Promise<T> {
    return withSftpOperationTimeout(operation, timeout, () => sftp.end())
}

function sftpStat(sftp: SFTPWrapper, remotePath: string, timeout?: number): Promise<Stats> {
    return withSftpDeadline(
        sftp,
        new Promise((resolve, reject) => {
            sftp.stat(remotePath, (err, stats) => {
                if (err) {
                    reject(err)
                } else {
                    resolve(stats)
                }
            })
        }),
        timeout
    )
}

function isSftpMissingError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false
    }
    const code = 'code' in error ? (error as { code?: unknown }).code : undefined
    if (code === 2 || code === 'ENOENT') {
        return true
    }
    const message = error instanceof Error ? error.message : String(error)
    return /no such file|not found/i.test(message)
}

function isLocalMissingError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

async function sftpExists(sftp: SFTPWrapper, remotePath: string): Promise<boolean> {
    try {
        await sftpStat(sftp, remotePath)
        return true
    } catch (error) {
        if (isSftpMissingError(error)) {
            return false
        }
        throw error
    }
}

async function remoteExists(alias: string, remotePath: string): Promise<boolean> {
    const sftp = await getSftpWithinDeadline(alias)
    try {
        return await sftpExists(sftp, remotePath)
    } finally {
        sftp.end()
    }
}

export async function hashRemoteFileDigest(
    alias: string,
    remotePath: string,
    algorithm: 'md5' | 'sha256',
    timeout?: number,
    limits?: { maxBytes: number; expectedSize: number }
): Promise<string> {
    const connection = sessionManager.getOpenSshConnection(alias)
    if (connection)
        return connection.hashFile(remotePath, algorithm, timeout ?? 600_000, limits?.maxBytes, limits?.expectedSize)
    const sftp = await getSftpWithinDeadline(alias, timeout)
    return withSftpDeadline(
        sftp,
        new Promise((resolve, reject) => {
            const hash = createHash(algorithm)
            const stream = sftp.createReadStream(remotePath)
            let settled = false
            let bytes = 0
            const finish = (error?: Error): void => {
                if (settled) {
                    return
                }
                settled = true
                sftp.end()
                if (error) {
                    reject(error)
                } else {
                    resolve(hash.digest('hex'))
                }
            }
            stream.on('data', (chunk: Buffer) => {
                if (settled) return
                bytes += chunk.length
                if (limits && (bytes > limits.maxBytes || bytes > limits.expectedSize)) {
                    stream.destroy()
                    finish(new Error('Remote file grew or exceeded the verification byte budget'))
                } else hash.update(chunk)
            })
            stream.once('error', finish)
            stream.once('end', () =>
                finish(
                    limits && bytes !== limits.expectedSize
                        ? new Error('Remote file changed during verification')
                        : undefined
                )
            )
        }),
        timeout
    )
}

export async function atomicReplaceCapability(
    alias: string,
    timeout?: number
): Promise<{ atomicReplaceSupported: boolean; reason?: string }> {
    const sftp = await getSftpWithinDeadline(alias, timeout)
    try {
        // ssh2 checks this negotiated extension before sending ext_openssh_rename.
        const extensions = (sftp as SFTPWrapper & { _extensions?: Record<string, string> })._extensions
        return extensions?.['posix-rename@openssh.com'] === '1'
            ? { atomicReplaceSupported: true }
            : { atomicReplaceSupported: false, reason: 'posix-rename@openssh.com was not negotiated' }
    } finally {
        sftp.end()
    }
}

export class RemoteRenameNotStartedError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'RemoteRenameNotStartedError'
    }
}

export async function renameRemoteFile(
    alias: string,
    sourcePath: string,
    targetPath: string,
    replaceExisting: boolean = false,
    timeout?: number
): Promise<void> {
    const sftp = await getSftpWithinDeadline(alias, timeout)
    return withSftpDeadline(
        sftp,
        new Promise((resolve, reject) => {
            const callback = (error?: Error | null): void => {
                sftp.end()
                if (error) {
                    reject(error)
                } else {
                    resolve()
                }
            }
            try {
                if (replaceExisting) {
                    sftp.ext_openssh_rename(sourcePath, targetPath, callback)
                } else {
                    sftp.rename(sourcePath, targetPath, callback)
                }
            } catch (error) {
                sftp.end()
                reject(
                    new RemoteRenameNotStartedError(
                        `SFTP rename request was not sent: ${error instanceof Error ? error.message : String(error)}`
                    )
                )
            }
        }),
        timeout
    )
}

export async function removeRemoteFile(alias: string, remotePath: string, timeout?: number): Promise<void> {
    const sftp = await getSftpWithinDeadline(alias, timeout)
    return withSftpDeadline(
        sftp,
        new Promise((resolve, reject) => {
            sftp.unlink(remotePath, (error) => {
                sftp.end()
                if (error && !isSftpMissingError(error)) {
                    reject(error)
                } else {
                    resolve()
                }
            })
        }),
        timeout
    )
}

/**
 * 带进度追踪的流传输
 */
function pipeWithProgress(
    readStream: NodeJS.ReadableStream,
    writeStream: NodeJS.WritableStream,
    sftp: SFTPWrapper,
    totalSize: number,
    onProgress?: (progress: TransferProgress) => void,
    closeSftp: boolean = true,
    signal?: AbortSignal
): Promise<{ success: boolean; size: number }> {
    return new Promise((resolve, reject) => {
        let settled = false
        const onAbort = (): void => cleanup(abortError(signal!))
        const detachAbort = (): void => signal?.removeEventListener('abort', onAbort)

        const cleanup = (err?: Error) => {
            if (settled) {
                return
            }
            settled = true
            detachAbort()
            // 先解管道并强制销毁两端，避免错误后流仍持有 sftp 资源
            try {
                readStream.unpipe(writeStream as NodeJS.WritableStream)
            } catch {
                /* ignore */
            }
            try {
                ;(readStream as NodeJS.ReadableStream & { destroy?: (error?: Error) => void }).destroy?.(err)
            } catch {
                /* ignore */
            }
            try {
                ;(writeStream as NodeJS.WritableStream & { destroy?: (error?: Error) => void }).destroy?.(err)
            } catch {
                /* ignore */
            }
            if (closeSftp) {
                sftp.end()
            }
            if (err) {
                reject(err)
            }
        }

        let transferred = 0

        readStream.on('data', (chunk: Buffer) => {
            transferred += chunk.length
            onProgress?.({
                transferred,
                total: totalSize,
                percent: totalSize > 0 ? Math.round((transferred / totalSize) * 100) : 100,
            })
        })

        readStream.on('error', (err: Error) => cleanup(err))
        writeStream.on('error', (err: Error) => cleanup(err))

        writeStream.on('close', () => {
            if (settled) {
                return
            }
            if (transferred !== totalSize) {
                cleanup(new Error(`Transfer size mismatch: expected ${totalSize} bytes, received ${transferred}`))
                return
            }
            settled = true
            detachAbort()
            if (closeSftp) {
                sftp.end()
            }
            resolve({ success: true, size: totalSize })
        })

        if (signal?.aborted) {
            cleanup(abortError(signal))
            return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        readStream.pipe(writeStream)
    })
}

export class UploadFileError extends Error {
    readonly details?: Record<string, unknown>

    constructor(
        message: string,
        readonly remoteCreated: boolean,
        options?: ErrorOptions
    ) {
        super(message, options)
        this.name = 'UploadFileError'
        const cause = options?.cause
        if (cause && typeof cause === 'object' && 'details' in cause) {
            this.details = (cause as { details?: Record<string, unknown> }).details
        }
    }
}

/**
 * 上传文件
 */
export async function uploadFile(
    alias: string,
    localPath: string,
    remotePath: string,
    onProgress?: (progress: TransferProgress) => void,
    sharedSftp?: SFTPWrapper,
    createMode?: number,
    signal?: AbortSignal,
    followSymlinks: boolean = false,
    exclusive: boolean = false,
    timeout?: number
): Promise<{ success: boolean; size: number; createMode: string }> {
    throwIfAborted(signal)
    const source = followSymlinks
        ? validateLocalUploadSource(
              localPath,
              true,
              'Refusing to upload symlink at top level (use ssh_sync with followSymlinks=true to traverse)'
          )
        : validateUploadFileSource(localPath)
    localPath = source.expandedPath
    const stats = source.stats
    if (stats.isDirectory()) {
        throw new Error('UPLOAD_PATH_IS_DIRECTORY: localPath is a directory, use ssh_sync for directory upload')
    }
    if (!stats.isFile()) {
        throw new Error('UPLOAD_PATH_IS_NOT_FILE: localPath is not a regular file')
    }

    const sftp = sharedSftp ?? (await getSftpWithinDeadline(alias, timeout))
    const totalSize = stats.size

    const safeCreateMode = (createMode ?? stats.mode) & FILE_CREATE_MODE_MASK
    const writeStream = sftp.createWriteStream(remotePath, { mode: safeCreateMode, flags: exclusive ? 'wx' : 'w' })
    let remoteCreated = false
    writeStream.once('open', () => {
        remoteCreated = true
    })
    try {
        const result = await withSftpDeadline(
            sftp,
            pipeWithProgress(
                fs.createReadStream(localPath),
                writeStream,
                sftp,
                totalSize,
                onProgress,
                !sharedSftp,
                signal
            ),
            timeout
        )
        return { ...result, createMode: formatFileMode(safeCreateMode) }
    } catch (error) {
        throw new UploadFileError(error instanceof Error ? error.message : String(error), remoteCreated, {
            cause: error,
        })
    }
}

async function existingDownloadTargetMode(localPath: string): Promise<number | undefined> {
    let stats: fs.Stats
    try {
        stats = await fs.promises.lstat(localPath)
    } catch (error) {
        if (isLocalMissingError(error)) {
            return undefined
        }
        throw error
    }
    if (!stats.isFile()) {
        throw new Error(`Refusing to replace a non-regular local target: ${localPath}`)
    }
    return stats.mode & FILE_CREATE_MODE_MASK
}

async function prepareDownloadTransfer(
    sftp: SFTPWrapper,
    remotePath: string,
    localDir: string,
    temporaryPath: string,
    closeSftpOnFailure: boolean,
    timeout?: number
): Promise<{
    totalSize: number
    readStream: NodeJS.ReadableStream
    writeStream: NodeJS.WritableStream
}> {
    let readStream: NodeJS.ReadableStream | undefined
    try {
        const totalSize = (await sftpStat(sftp, remotePath, timeout)).size
        if (!fs.existsSync(localDir)) {
            fs.mkdirSync(localDir, { recursive: true })
        }
        if (process.platform === 'win32') {
            const handle = await fs.promises.open(temporaryPath, 'wx', 0o600)
            await handle.close()
            if (checkWindowsAcl(temporaryPath, true) !== 'key_path_usable') {
                throw new Error('privacy_not_enforced_on_windows: temporary download file ACL could not be verified')
            }
        }
        readStream = sftp.createReadStream(remotePath)
        return {
            totalSize,
            readStream,
            writeStream: fs.createWriteStream(temporaryPath, {
                flags: process.platform === 'win32' ? 'r+' : 'wx',
                mode: 0o600,
            }),
        }
    } catch (error) {
        try {
            ;(readStream as (NodeJS.ReadableStream & { destroy?: () => void }) | undefined)?.destroy?.()
        } catch {
            /* ignore cleanup errors while preserving the transfer setup error */
        }
        if (closeSftpOnFailure) {
            sftp.end()
        }
        throw error
    }
}

/**
 * 下载文件
 */
export async function downloadFile(
    alias: string,
    remotePath: string,
    localPath: string,
    onProgress?: (progress: TransferProgress) => void,
    sharedSftp?: SFTPWrapper,
    signal?: AbortSignal,
    timeout?: number
): Promise<{ success: boolean; size: number; atomic: true }> {
    throwIfAborted(signal)
    localPath = expandTilde(localPath)
    validateLocalPathAgainstAllowList(localPath)
    const preservedMode = await existingDownloadTargetMode(localPath)
    const sftp = sharedSftp ?? (await getSftpWithinDeadline(alias, timeout))
    const localDir = path.dirname(localPath)
    const temporaryPath = path.join(
        localDir,
        `.${path.basename(localPath)}.mcp-tmp-${process.pid}-${randomBytes(8).toString('hex')}`
    )
    try {
        const { totalSize, readStream, writeStream } = await prepareDownloadTransfer(
            sftp,
            remotePath,
            localDir,
            temporaryPath,
            !sharedSftp,
            timeout
        )
        const result = await withSftpDeadline(
            sftp,
            pipeWithProgress(readStream, writeStream, sftp, totalSize, onProgress, !sharedSftp, signal),
            timeout
        )
        if (process.platform !== 'win32') {
            await fs.promises.chmod(temporaryPath, preservedMode ?? 0o600)
        }
        await fs.promises.rename(temporaryPath, localPath)
        return { ...result, atomic: true }
    } catch (error) {
        try {
            await fs.promises.unlink(temporaryPath)
        } catch (cleanupError) {
            if (!isLocalMissingError(cleanupError)) {
                throw new AggregateError([error, cleanupError], 'Download failed and temporary file cleanup failed', {
                    cause: cleanupError,
                })
            }
        }
        throw error
    }
}

export const DEFAULT_READ_FILE_MAX_BYTES = 1024 * 1024
export const HARD_READ_FILE_MAX_BYTES = 16 * 1024 * 1024

type ReadFileSampleKind = 'full' | 'head' | 'tail' | 'range' | 'line_range'

export type ReadEncoding = 'auto' | 'utf8' | 'utf16le' | 'utf16be' | 'gbk'

type ReadFileOptions = {
    encoding?: ReadEncoding
    binary?: boolean
    maxBytes?: number
    offset?: number
    tail?: boolean
    lineRange?: string
    timeout?: number
}

type NormalizedReadFileOptions = ReadFileOptions & { maxBytes: number }

type ReadFileResult = {
    content: string
    encoding?: ReadEncoding | 'base64'
    content_base64?: string
    size: number
    total_size: number
    read_offset: number
    requested_offset?: number
    read_bytes: number
    read_end?: number
    next_offset?: number
    remaining_bytes?: number
    sample_kind: ReadFileSampleKind
    truncated: boolean
    line_start?: number
    line_end?: number
    eof?: boolean
    byte_limit_reached?: boolean
    final_line_terminated?: boolean
}

function normalizeReadFileOptions(options?: number | ReadFileOptions): NormalizedReadFileOptions {
    if (typeof options === 'number') {
        return { maxBytes: options }
    }
    return { ...options, maxBytes: options?.maxBytes ?? DEFAULT_READ_FILE_MAX_BYTES }
}

function parseLineRange(lineRange: string): { start: number; end: number } {
    const match = /^(?<start>\d+)(?:-(?<end>\d+))?$/.exec(lineRange.trim())
    if (!match?.groups) {
        throw new Error('lineRange 必须使用 "start-end" 或 "start" 格式，例如 "120-180"')
    }
    const start = Number(match.groups.start)
    const end = match.groups.end ? Number(match.groups.end) : start
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
        throw new Error('lineRange 必须是从 1 开始且 end >= start 的行号范围')
    }
    return { start, end }
}

function validateReadFileOptions(options: NormalizedReadFileOptions): void {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
        throw new Error('maxBytes 必须是正整数')
    }
    if (options.maxBytes > HARD_READ_FILE_MAX_BYTES) {
        throw new Error(`maxBytes 不能超过 ${HARD_READ_FILE_MAX_BYTES}，请使用 offset、tail 或 lineRange 分块读取`)
    }
    if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)) {
        throw new Error('offset 必须是非负整数')
    }
    const selectors = [options.offset !== undefined, options.tail === true, options.lineRange !== undefined].filter(
        Boolean
    )
    if (selectors.length > 1) {
        throw new Error('offset、tail、lineRange 只能同时指定一个')
    }
    if (options.lineRange !== undefined) {
        parseLineRange(options.lineRange)
    }
    if (
        !options.binary &&
        options.offset !== undefined &&
        options.encoding?.startsWith('utf16') &&
        options.offset % 2 !== 0
    ) {
        throw new Error('UTF-16 offset must point to a complete code unit boundary')
    }
    if (!options.binary && options.encoding === 'gbk' && (options.offset !== undefined || options.tail)) {
        throw new Error('GBK byte offsets cannot prove character boundaries; use lineRange or binary=true')
    }
}

function emptyReadResult(
    totalSize: number,
    sampleKind: ReadFileSampleKind,
    readOffset: number = 0,
    binary: boolean = false
): ReadFileResult {
    return {
        content: '',
        content_base64: binary ? '' : undefined,
        encoding: binary ? 'base64' : undefined,
        size: totalSize,
        total_size: totalSize,
        read_offset: readOffset,
        read_bytes: 0,
        remaining_bytes: Math.max(0, totalSize - readOffset),
        sample_kind: sampleKind,
        truncated: readOffset < totalSize,
    }
}

function detectReadEncoding(firstBytes: Buffer, requested: ReadEncoding): Exclude<ReadEncoding, 'auto'> {
    if (requested !== 'auto') {
        return requested
    }
    if (firstBytes[0] === 0xff && firstBytes[1] === 0xfe) {
        return 'utf16le'
    }
    if (firstBytes[0] === 0xfe && firstBytes[1] === 0xff) {
        return 'utf16be'
    }
    return 'utf8'
}

function decodeReadBuffer(
    bytes: Buffer,
    encoding: Exclude<ReadEncoding, 'auto'>,
    binary: boolean,
    budgetTruncated: boolean,
    atFileStart: boolean
): { content: string; content_base64?: string; read_bytes: number } {
    if (binary) {
        return { content: bytes.toString('base64'), content_base64: bytes.toString('base64'), read_bytes: bytes.length }
    }
    const label =
        encoding === 'utf8' ? 'utf-8' : encoding === 'gbk' ? 'gbk' : encoding === 'utf16le' ? 'utf-16le' : 'utf-16be'
    const invalid = (): Error => new Error(`Invalid ${encoding} sequence or offset is not a character boundary`)
    const decoderOptions = { fatal: true, ignoreBOM: !atFileStart }
    const decoder = new TextDecoder(label, decoderOptions)
    let content: string
    try {
        // Streaming validation rejects malformed complete characters before considering an incomplete suffix.
        content = decoder.decode(bytes, { stream: true })
    } catch {
        throw invalid()
    }
    try {
        content += decoder.decode()
        return { content, read_bytes: bytes.length }
    } catch {
        if (!budgetTruncated) {
            throw invalid()
        }
    }
    // Only a byte-budget boundary may leave up to three bytes of an incomplete character.
    for (let end = bytes.length - 1; end >= Math.max(0, bytes.length - 3); --end) {
        try {
            content = new TextDecoder(label, decoderOptions).decode(bytes.subarray(0, end))
        } catch {
            continue
        }
        if (end === 0 && bytes.length > 0) {
            throw new Error(`maxBytes is too small to read the next ${encoding} character`)
        }
        return { content, read_bytes: end }
    }
    throw invalid()
}

async function readLineRange(
    sftp: SFTPWrapper,
    remotePath: string,
    totalSize: number,
    maxBytes: number,
    lineRange: string,
    encoding: ReadEncoding,
    binary: boolean,
    timeout?: number
): Promise<ReadFileResult> {
    const { start, end } = parseLineRange(lineRange)
    let stream: ReturnType<SFTPWrapper['createReadStream']>
    try {
        stream = sftp.createReadStream(remotePath)
    } catch (error) {
        sftp.end()
        throw error
    }
    const chunks: Buffer[] = []
    let line = 1
    let lineStart: number | undefined
    let lineEnd: number | undefined
    let size = 0
    let consumed = 0
    let byteLimitReached = false
    let sawAfter = false
    let encodingDetected = encoding !== 'auto'
    let detected: Exclude<ReadEncoding, 'auto'> = encoding === 'auto' ? 'utf8' : encoding
    let pending = Buffer.alloc(0)
    try {
        await withSftpDeadline(
            sftp,
            (async () => {
                for await (const part of stream) {
                    const chunk = Buffer.from(part)
                    consumed += chunk.length
                    if (consumed > 1024 * 1024 * 1024) {
                        throw new Error('lineRange scan exceeded the 1 GiB input budget')
                    }
                    // Preserve a split UTF-16 code unit across SFTP chunks.
                    const data = Buffer.concat([pending, chunk])
                    if (!encodingDetected && data.length < 2) {
                        pending = data
                        continue
                    }
                    if (!encodingDetected) {
                        detected = detectReadEncoding(data, encoding)
                        encodingDetected = true
                    }
                    const width = detected.startsWith('utf16') ? 2 : 1
                    const bigEndian = detected === 'utf16be'
                    const available = data.length - (data.length % width)
                    let segmentStart = 0
                    for (let index = 0; index < available; index += width) {
                        const newline =
                            width === 1
                                ? data[index] === 10
                                : bigEndian
                                  ? data[index] === 0 && data[index + 1] === 10
                                  : data[index] === 10 && data[index + 1] === 0
                        if (!newline) {
                            continue
                        }
                        if (line >= start && line <= end) {
                            const length = index + width - segmentStart
                            const remaining = maxBytes - size
                            if (length > remaining) {
                                if (remaining > 0) {
                                    chunks.push(data.subarray(segmentStart, segmentStart + remaining))
                                    size += remaining
                                    lineStart ??= line
                                }
                                byteLimitReached = true
                                stream.destroy()
                                break
                            }
                            chunks.push(data.subarray(segmentStart, index + width))
                            size += length
                            lineStart ??= line
                        }
                        ++line
                        segmentStart = index + width
                        if (line > end) {
                            sawAfter = segmentStart < data.length || consumed < totalSize
                            break
                        }
                    }
                    if (byteLimitReached || line > end) {
                        break
                    }
                    if (line >= start && line <= end && available > segmentStart) {
                        const length = available - segmentStart
                        const remaining = maxBytes - size
                        const taken = Math.min(length, remaining)
                        if (taken > 0) {
                            chunks.push(data.subarray(segmentStart, segmentStart + taken))
                            size += taken
                            lineStart ??= line
                        }
                        if (taken < length) {
                            byteLimitReached = true
                            stream.destroy()
                            break
                        }
                    }
                    pending = data.subarray(available)
                }
                if (!byteLimitReached && line <= end && line >= start && pending.length > 0) {
                    const taken = Math.min(pending.length, maxBytes - size)
                    if (taken > 0) {
                        chunks.push(pending.subarray(0, taken))
                        lineStart ??= line
                    }
                    byteLimitReached = taken < pending.length
                }
            })(),
            timeout
        )
    } finally {
        stream.destroy()
        sftp.end()
    }
    const raw = Buffer.concat(chunks)
    const decoded = decodeReadBuffer(raw, detected, binary, byteLimitReached, lineStart === 1)
    if (decoded.read_bytes < raw.length) {
        byteLimitReached = true
    }
    // Metadata describes the decoded prefix, not the bytes scanned or discarded at the budget boundary.
    let finalLineTerminated = false
    if (decoded.read_bytes > 0 && lineStart !== undefined) {
        const width = detected.startsWith('utf16') ? 2 : 1
        let returnedLine = lineStart
        for (let index = 0; index < decoded.read_bytes; index += width) {
            lineEnd = returnedLine
            finalLineTerminated =
                width === 1
                    ? raw[index] === 10
                    : index + 1 < decoded.read_bytes &&
                      (detected === 'utf16be'
                          ? raw[index] === 0 && raw[index + 1] === 10
                          : raw[index] === 10 && raw[index + 1] === 0)
            if (finalLineTerminated) {
                ++returnedLine
            }
        }
    } else {
        lineStart = undefined
    }
    const eof = !byteLimitReached && !sawAfter
    return {
        content: decoded.content,
        content_base64: decoded.content_base64,
        encoding: binary ? 'base64' : detected,
        size: totalSize,
        total_size: totalSize,
        read_offset: 0,
        read_bytes: decoded.read_bytes,
        sample_kind: 'line_range',
        truncated: byteLimitReached || !eof,
        line_start: lineStart,
        line_end: lineEnd,
        eof,
        byte_limit_reached: byteLimitReached,
        final_line_terminated: lineEnd === undefined ? undefined : finalLineTerminated,
    }
}

/**
 * 读取远程文件内容
 */
export async function readFile(
    alias: string,
    remotePath: string,
    options?: number | ReadFileOptions
): Promise<ReadFileResult> {
    const readOptions = normalizeReadFileOptions(options)
    validateReadFileOptions(readOptions)

    const sftp = await getSftpWithinDeadline(alias, readOptions.timeout)
    let actualSize: number
    try {
        actualSize = (await sftpStat(sftp, remotePath, readOptions.timeout)).size
    } catch (error) {
        sftp.end()
        throw error
    }

    if (readOptions.lineRange) {
        return readLineRange(
            sftp,
            remotePath,
            actualSize,
            readOptions.maxBytes,
            readOptions.lineRange,
            readOptions.encoding ?? 'auto',
            readOptions.binary === true,
            readOptions.timeout
        )
    }

    if (actualSize === 0) {
        sftp.end()
        return emptyReadResult(
            0,
            readOptions.tail ? 'tail' : readOptions.offset !== undefined ? 'range' : 'full',
            0,
            readOptions.binary === true
        )
    }

    const requestedOffset = readOptions.tail
        ? Math.max(0, actualSize - readOptions.maxBytes)
        : Math.min(readOptions.offset ?? 0, actualSize)
    const readSize = Math.min(actualSize - requestedOffset, readOptions.maxBytes)
    const sampleKind: ReadFileSampleKind = readOptions.tail
        ? 'tail'
        : readOptions.offset !== undefined
          ? 'range'
          : actualSize <= readOptions.maxBytes
            ? 'full'
            : 'head'

    if (readSize === 0) {
        sftp.end()
        return emptyReadResult(actualSize, sampleKind, requestedOffset, readOptions.binary === true)
    }

    let encoding = readOptions.encoding ?? 'auto'
    if (!readOptions.binary && encoding === 'auto' && requestedOffset > 0) {
        try {
            const first = await withSftpDeadline(
                sftp,
                new Promise<Buffer>((resolve, reject) => {
                    const stream = sftp.createReadStream(remotePath, { start: 0, end: 1 })
                    const chunks: Buffer[] = []
                    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
                    stream.once('error', reject)
                    stream.once('end', () => resolve(Buffer.concat(chunks)))
                }),
                readOptions.timeout
            )
            encoding = detectReadEncoding(first, 'auto')
        } catch (error) {
            sftp.end()
            throw error
        }
    }
    return withSftpDeadline(
        sftp,
        new Promise((resolve, reject) => {
            const chunks: Buffer[] = []
            let settled = false
            const finish = (error?: Error): void => {
                if (settled) {
                    return
                }
                settled = true
                sftp.end()
                if (error) {
                    reject(error)
                    return
                }

                try {
                    const buffer = Buffer.concat(chunks)
                    const detected = detectReadEncoding(buffer, encoding)
                    if (
                        !readOptions.binary &&
                        detected.startsWith('utf16') &&
                        !readOptions.tail &&
                        requestedOffset % 2
                    ) {
                        throw new Error(`Invalid ${detected} offset is not a character boundary`)
                    }
                    let contentStart = 0
                    if (!readOptions.binary && detected === 'utf8' && readOptions.tail && requestedOffset > 0) {
                        while (contentStart < buffer.length && isUtf8ContinuationByte(buffer[contentStart])) {
                            ++contentStart
                        }
                    } else if (!readOptions.binary && detected === 'utf8') {
                        ensureUtf8Boundary(buffer, 0, 'offset')
                    } else if (!readOptions.binary && detected.startsWith('utf16') && readOptions.tail) {
                        contentStart = requestedOffset % 2
                        if (requestedOffset > 0 && contentStart + 2 <= buffer.length) {
                            const firstUnit =
                                detected === 'utf16be'
                                    ? buffer.readUInt16BE(contentStart)
                                    : buffer.readUInt16LE(contentStart)
                            if (firstUnit >= 0xdc00 && firstUnit <= 0xdfff) {
                                contentStart += 2
                            }
                        }
                    }
                    if (!readOptions.binary && buffer.length > 0 && contentStart >= buffer.length) {
                        throw new Error(`maxBytes is too small to read a complete ${detected} tail character`)
                    }
                    const decoded = decodeReadBuffer(
                        buffer.subarray(contentStart),
                        detected,
                        readOptions.binary === true,
                        requestedOffset + buffer.length < actualSize,
                        requestedOffset + contentStart === 0
                    )
                    const contentBuffer = buffer.subarray(contentStart, contentStart + decoded.read_bytes)
                    const actualReadOffset = requestedOffset + contentStart
                    const nextOffset = actualReadOffset + contentBuffer.length
                    const remainingBytes = Math.max(0, actualSize - nextOffset)
                    resolve({
                        content: decoded.content,
                        content_base64: decoded.content_base64,
                        encoding: readOptions.binary ? 'base64' : detected,
                        size: actualSize,
                        total_size: actualSize,
                        read_offset: actualReadOffset,
                        requested_offset: requestedOffset,
                        read_bytes: contentBuffer.length,
                        read_end: nextOffset,
                        next_offset: nextOffset,
                        remaining_bytes: remainingBytes,
                        sample_kind: sampleKind,
                        truncated: actualReadOffset > 0 || remainingBytes > 0,
                    })
                } catch (processingError) {
                    reject(processingError)
                }
            }

            let readStream: ReturnType<SFTPWrapper['createReadStream']>
            try {
                readStream = sftp.createReadStream(remotePath, {
                    start: requestedOffset,
                    end: requestedOffset + readSize - 1,
                })
            } catch (error) {
                sftp.end()
                reject(error)
                return
            }

            readStream.on('data', (chunk: Buffer) => {
                chunks.push(chunk)
            })
            readStream.once('end', () => finish())
            readStream.once('error', (error: Error) => finish(error))
        }),
        readOptions.timeout
    )
}

export async function createEmptyRemoteFile(alias: string, remotePath: string, timeout?: number): Promise<void> {
    const sftp = await getSftpWithinDeadline(alias, timeout)
    try {
        await withSftpDeadline(
            sftp,
            new Promise<void>((resolve, reject) => {
                const stream = sftp.createWriteStream(remotePath, { flags: 'wx', mode: 0o600 })
                stream.once('error', reject)
                stream.once('close', resolve)
                stream.end()
            }),
            timeout
        )
    } finally {
        sftp.end()
    }
}

export async function prepareWindowsRemotePrivateFile(
    alias: string,
    remotePath: string,
    timeout?: number,
    shellPath: string = remotePath
): Promise<void> {
    await createEmptyRemoteFile(alias, remotePath, timeout)
    try {
        const acl = await sessionManager.exec(alias, encodedPowershell(windowsAclScript(shellPath, true)), {
            timeout,
            useLoginUser: true,
            maxOutputSize: 4096,
        })
        if (!acl.success || acl.stdout.trim() !== 'usable') {
            throw new Error('privacy_not_enforced_on_windows: remote temporary file ACL was not verified')
        }
    } catch (error) {
        try {
            await removeRemoteFile(alias, remotePath, timeout)
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                'privacy_not_enforced_on_windows: remote ACL check and cleanup failed',
                { cause: cleanupError }
            )
        }
        throw error
    }
}

/**
 * 写入远程文件
 */
export async function writeFile(
    alias: string,
    remotePath: string,
    content: string,
    append: boolean = false,
    timeout?: number
): Promise<{ success: boolean; size: number }> {
    const sftp = await getSftpWithinDeadline(alias, timeout)
    const flags = append ? 'a' : 'w'
    const contentBuffer = Buffer.from(content, 'utf-8')

    return withSftpDeadline(
        sftp,
        new Promise((resolve, reject) => {
            const writeStream = sftp.createWriteStream(remotePath, { flags })

            writeStream.on('close', () => {
                sftp.end()
                resolve({ success: true, size: contentBuffer.length })
            })

            writeStream.on('error', (err: Error) => {
                sftp.end()
                reject(err)
            })

            writeStream.write(contentBuffer)
            writeStream.end()
        }),
        timeout
    )
}

function validateSftpEntryName(filename: string): void {
    if (
        filename.length === 0 ||
        filename === '.' ||
        filename === '..' ||
        filename.includes('\0') ||
        filename.includes('/') ||
        filename.includes('\\')
    ) {
        throw new Error('SFTP directory listing returned an unsafe entry name')
    }
}

/**
 * 列出目录内容
 */
export async function listDir(
    alias: string,
    remotePath: string,
    showHidden: boolean = false,
    sharedSftp?: SFTPWrapper,
    timeout?: number,
    style: 'posix' | 'win32' | 'sftp-posix' = 'posix'
): Promise<FileInfo[]> {
    const sftp = sharedSftp ?? (await getSftpWithinDeadline(alias, timeout))
    const closeWhenDone = !sharedSftp

    return withSftpDeadline(
        sftp,
        new Promise((resolve, reject) => {
            sftp.readdir(remotePath, (err, list) => {
                if (err) {
                    if (closeWhenDone) {
                        sftp.end()
                    }
                    reject(err)
                    return
                }

                try {
                    for (const item of list) {
                        validateSftpEntryName(item.filename)
                    }
                } catch (error) {
                    if (closeWhenDone) {
                        sftp.end()
                    }
                    reject(error)
                    return
                }

                const files: FileInfo[] = list
                    .filter((item) => showHidden || !item.filename.startsWith('.'))
                    .map((item) => ({
                        name: item.filename,
                        path: remoteJoin(style, remotePath, item.filename),
                        size: item.attrs.size,
                        isDirectory: (item.attrs.mode & S_IFMT) === S_IFDIR,
                        isFile: (item.attrs.mode & S_IFMT) === S_IFREG,
                        isSymlink: (item.attrs.mode & S_IFMT) === S_IFLNK,
                        mode: extractFileMode(item.attrs.mode),
                        permissions: formatFilePermissions(item.attrs.mode),
                        owner: item.attrs.uid,
                        group: item.attrs.gid,
                        mtime: new Date(item.attrs.mtime * 1000),
                        atime: new Date(item.attrs.atime * 1000),
                    }))
                    .sort((a, b) => {
                        // 目录在前
                        if (a.isDirectory !== b.isDirectory) {
                            return a.isDirectory ? -1 : 1
                        }
                        return a.name.localeCompare(b.name)
                    })

                if (closeWhenDone) {
                    sftp.end()
                }
                resolve(files)
            })
        }),
        timeout
    )
}

/**
 * 获取文件信息
 */
export async function getFileInfo(
    alias: string,
    remotePath: string,
    timeout?: number,
    style: 'posix' | 'win32' | 'sftp-posix' = 'posix'
): Promise<FileInfo> {
    const connection = sessionManager.getOpenSshConnection(alias)
    let stats: Pick<Stats, 'mode' | 'size' | 'uid' | 'gid' | 'mtime' | 'atime'>
    if (connection) {
        stats = await connection.stat(remotePath, timeout ?? 600_000)
    } else {
        const sftp = await getSftpWithinDeadline(alias, timeout)
        try {
            stats = await sftpStat(sftp, remotePath, timeout)
        } finally {
            sftp.end()
        }
    }
    return {
        name: remotePathModule(style).basename(remotePath),
        path: remotePath,
        size: stats.size,
        isDirectory: (stats.mode & S_IFMT) === S_IFDIR,
        isFile: (stats.mode & S_IFMT) === S_IFREG,
        isSymlink: (stats.mode & S_IFMT) === S_IFLNK,
        mode: extractFileMode(stats.mode),
        permissions: formatFilePermissions(stats.mode),
        owner: stats.uid,
        group: stats.gid,
        mtime: new Date(stats.mtime * 1000),
        atime: new Date(stats.atime * 1000),
    }
}

function sftpMkdir(sftp: SFTPWrapper, remotePath: string, timeout?: number): Promise<void> {
    return withSftpDeadline(
        sftp,
        new Promise((resolve, reject) => {
            sftp.mkdir(remotePath, (error) => {
                if (error) {
                    reject(error)
                } else {
                    resolve()
                }
            })
        }),
        timeout
    )
}

async function ensureSftpDirectory(
    sftp: SFTPWrapper,
    remotePath: string,
    timeout?: number,
    style: 'posix' | 'win32' | 'sftp-posix' = 'posix'
): Promise<void> {
    const normalizedPath = remoteNormalize(style, remotePath)
    if (normalizedPath === '/' || normalizedPath === '.') {
        return
    }
    let existingMode: number | undefined
    try {
        existingMode = (await sftpStat(sftp, normalizedPath, timeout)).mode
    } catch (error) {
        if (!isSftpMissingError(error)) {
            throw error
        }
    }
    if (existingMode !== undefined) {
        if ((existingMode & S_IFMT) !== S_IFDIR) {
            throw new Error(`Remote path exists and is not a directory: ${normalizedPath}`)
        }
        return
    }

    const parent = remoteDirname(style, normalizedPath)
    if (style === 'sftp-posix' && /^\/\/[^/]+\/[^/]+\/?$/.test(normalizedPath) && parent !== normalizedPath) {
        throw new Error('SFTP UNC share root does not exist; refusing to create a network host path')
    }
    if (parent !== normalizedPath) {
        await ensureSftpDirectory(sftp, parent, timeout, style)
    }
    try {
        await sftpMkdir(sftp, normalizedPath, timeout)
    } catch (error) {
        try {
            const stats = await sftpStat(sftp, normalizedPath, timeout)
            if ((stats.mode & S_IFMT) === S_IFDIR) {
                return
            }
        } catch {
            // 保留原 mkdir 错误
        }
        throw error
    }
}

/**
 * 创建目录
 */
export async function mkdir(
    alias: string,
    remotePath: string,
    recursive: boolean = false,
    sharedSftp?: SFTPWrapper,
    timeout?: number,
    style: 'posix' | 'win32' | 'sftp-posix' = 'posix'
): Promise<boolean> {
    const sftp = sharedSftp ?? (await getSftpWithinDeadline(alias, timeout))
    return withSftpDeadline(
        sftp,
        (async () => {
            try {
                if (recursive) {
                    await ensureSftpDirectory(sftp, remotePath, timeout, style)
                } else {
                    await sftpMkdir(sftp, remotePath, timeout)
                }
                return true
            } finally {
                if (!sharedSftp) {
                    sftp.end()
                }
            }
        })(),
        timeout
    )
}

/**
 * 检查远程是否安装 rsync
 */
export async function checkRsync(
    alias: string,
    timeout: number = 10_000,
    executable: string = 'rsync',
    shell: 'posix' | 'cmd' | 'powershell' = 'posix'
): Promise<RsyncProbeResult> {
    const generation = getRsyncGeneration(alias)
    const cacheKey = `${alias}\0${shell}\0${executable}`
    const cached = rsyncCache.get(cacheKey)
    if (cached !== undefined && cached.expiresAt > Date.now()) {
        return cached.value
    }

    const startedAt = Date.now()
    try {
        if (/[\r\n\0]/.test(executable)) {
            throw new Error('Invalid rsync executable path')
        }
        const probeCommand =
            shell === 'posix'
                ? executable === 'rsync'
                    ? 'command -v rsync'
                    : `test -x ${escapeShellArg(executable)} && printf '%s\\n' ${escapeShellArg(executable)}`
                : shell === 'powershell'
                  ? `(Get-Command -ErrorAction Stop -Name '${executable.replace(/'/g, "''")}').Source`
                  : `where.exe "${executable.replace(/"/g, '""')}"`
        const result = await sessionManager.exec(alias, probeCommand, {
            timeout,
            useLoginUser: true,
            maxOutputSize: 4096,
        })
        const duration = Date.now() - startedAt
        if (!isCurrentRsyncGeneration(alias, generation)) {
            return {
                available: false,
                status: 'error',
                duration,
                retryable: true,
                error: `SSH session '${alias}' changed during rsync probe`,
            }
        }
        if (result.success && result.exitCode === 0 && result.stdout.trim().length > 0) {
            const probe: RsyncProbeResult = {
                available: true,
                status: 'available',
                duration,
                retryable: false,
                exitCode: result.exitCode,
            }
            rsyncCache.set(cacheKey, { value: probe, expiresAt: Date.now() + RSYNC_CACHE_TTL_MS })
            return probe
        }
        if (result.failureKind === 'timeout' || result.timedOut) {
            return {
                available: false,
                status: 'timeout',
                duration,
                retryable: true,
                exitCode: result.exitCode,
                failureKind: result.failureKind,
                error: result.stderr.trim() || result.stdout.trim() || `rsync probe timed out after ${timeout}ms`,
            }
        }
        if (result.failureKind === 'ssh_transport') {
            return {
                available: false,
                status: 'error',
                duration,
                retryable: true,
                exitCode: result.exitCode,
                failureKind: result.failureKind,
                error: result.stderr.trim() || result.stdout.trim() || 'SSH transport failed during rsync probe',
            }
        }
        if (result.exitCode === 1 && result.stderr.trim().length === 0) {
            const probe: RsyncProbeResult = {
                available: false,
                status: 'unavailable',
                duration,
                retryable: false,
                exitCode: result.exitCode,
            }
            rsyncCache.set(cacheKey, { value: probe, expiresAt: Date.now() + RSYNC_CACHE_TTL_MS })
            return probe
        }
        return {
            available: false,
            status: 'error',
            duration,
            retryable: result.failureKind !== 'remote_command',
            exitCode: result.exitCode,
            failureKind: result.failureKind,
            error:
                result.stderr.trim() || result.stdout.trim() || `rsync probe failed with exit code ${result.exitCode}`,
        }
    } catch (error) {
        return {
            available: false,
            status: 'error',
            duration: Date.now() - startedAt,
            retryable: true,
            error: error instanceof Error ? error.message : String(error),
        }
    }
}

type SyncOptions = {
    delete?: boolean
    dryRun?: boolean
    exclude?: string[]
    recursive?: boolean
    followSymlinks?: boolean
    preflightTimeout?: number
    connectTimeout?: number
    operationTimeout?: number
    sourceIsDirectory?: boolean
    signal?: AbortSignal
    remotePathStyle?: 'posix' | 'win32' | 'sftp-posix'
}

async function verifyWindowsUploadNames(
    alias: string,
    localPath: string,
    remotePath: string,
    options: SyncOptions
): Promise<void> {
    const candidates: { parent: string; names: string[] }[] = []
    const style = options.remotePathStyle ?? sessionManager.getRemotePathStyle(alias)
    await uploadDirectory(
        alias,
        localPath,
        remotePath,
        options.exclude,
        undefined,
        options.followSymlinks === true,
        { files: 0, directories: 0, bytes: 0 },
        0,
        options.signal,
        '',
        style,
        (parent, names) => {
            if (names.length < 2) {
                return
            }
            // ASCII folding only screens candidates. Windows performs the authoritative comparison.
            // Any Unicode name requires remote comparison against every sibling, including ASCII names.
            const hasUnicode = names.some((name) => [...name].some((char) => char.charCodeAt(0) > 0x7f))
            if (hasUnicode || new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
                candidates.push({ parent, names })
            }
        }
    )
    const deadline = Date.now() + (options.preflightTimeout ?? 10_000)
    for (const { parent, names } of candidates) {
        let collision: string[] | null
        try {
            const timeout = deadline - Date.now()
            if (timeout <= 0) {
                throw new Error('name preflight timeout was exhausted')
            }
            const result = await sessionManager.exec(
                alias,
                encodedPowershell(windowsCaseSemanticsScript(remoteShellPath(parent, style), names)),
                { timeout, maxOutputSize: 65_536, useLoginUser: true, loadProfile: false }
            )
            if (
                !result.success ||
                result.exitCode !== 0 ||
                result.timedOut ||
                result.stdoutTruncated ||
                result.stderrTruncated
            ) {
                throw new Error(result.stderr || 'Windows case semantics query failed or returned truncated output')
            }
            const semantics = JSON.parse(result.stdout)
            if (
                typeof semantics?.caseSensitive !== 'boolean' ||
                !Object.hasOwn(semantics, 'collision') ||
                (semantics.collision !== null &&
                    (!Array.isArray(semantics.collision) ||
                        semantics.collision.length !== 2 ||
                        semantics.collision[0] === semantics.collision[1] ||
                        !semantics.collision.every(
                            (name: unknown) => typeof name === 'string' && names.includes(name)
                        ))) ||
                (semantics.caseSensitive && semantics.collision !== null)
            ) {
                throw new Error('Windows case semantics query returned incomplete fields')
            }
            collision = semantics.collision
        } catch (error) {
            throw new Error(
                `case_semantics_unverified: ${parent}: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error }
            )
        }
        if (collision) {
            throw new Error(`windows_filename_collision: ${parent}: ${collision.join(' / ')}`)
        }
    }
}

/**
 * 智能文件同步（根据连接能力选择 rsync 或 SFTP）
 *
 * @param alias SSH 连接别名
 * @param localPath 本地路径
 * @param remotePath 远程路径
 * @param direction 同步方向：'upload' 或 'download'
 * @param options 同步选项
 */
export async function syncFiles(
    alias: string,
    localPath: string,
    remotePath: string,
    direction: 'upload' | 'download',
    options: SyncOptions = {}
): Promise<SyncResult> {
    const startedAt = Date.now()
    localPath = expandTilde(localPath)
    validateLocalPathAgainstAllowList(localPath)
    if (remotePath === '~' || remotePath.startsWith('~/')) {
        throw new Error('remotePath must be absolute or relative to the SSH working directory; ~ is not supported')
    }

    let sourceIsDirectory: boolean
    if (direction === 'upload') {
        const source = validateSyncUploadSource(localPath, options.followSymlinks === true)
        localPath = source.expandedPath
        sourceIsDirectory = source.stats.isDirectory()
    } else {
        sourceIsDirectory = (await getFileInfo(alias, remotePath, undefined, options.remotePathStyle)).isDirectory
    }
    if (sourceIsDirectory && options.recursive === false) {
        throw new Error('recursive=false is not supported for directory sources; use a file source or enable recursion')
    }

    const capabilityStartedAt = Date.now()
    const rsyncGeneration = getRsyncGeneration(alias)
    if (direction === 'upload' && sourceIsDirectory && sessionManager.getRemotePlatform(alias) === 'windows') {
        await verifyWindowsUploadNames(alias, localPath, remotePath, options)
        assertCurrentRsyncGeneration(alias, rsyncGeneration)
    }
    const capability = sessionManager.getExternalTransferCapability(alias)
    const preflightTimeout = options.preflightTimeout ?? 10_000
    const connection = sessionManager.getOpenSshConnection(alias)
    if (connection) {
        await connection.capture(
            'command -v find stat head realpath >/dev/null && find --version >/dev/null && stat --version >/dev/null && head --version >/dev/null && realpath --version >/dev/null',
            preflightTimeout,
            4096
        )
    }
    const rsyncProbe: RsyncProbeResult = capability.rsyncEligible
        ? await checkRsync(alias, preflightTimeout, capability.rsyncExecutable, capability.commandShell)
        : {
              available: false,
              status: 'skipped',
              duration: 0,
              retryable: false,
              reason: capability.decisionReason,
          }
    assertCurrentRsyncGeneration(alias, rsyncGeneration)
    const resolvedOptions: SyncOptions = {
        ...options,
        sourceIsDirectory,
        remotePathStyle: options.remotePathStyle ?? capability.remotePathStyle ?? 'posix',
    }
    const capabilityDuration = Date.now() - capabilityStartedAt
    if (capability.backend === 'openssh' && !rsyncProbe.available) {
        throw new OpenSshError('The OpenSSH master backend requires remote rsync; no SFTP fallback is available', {
            code: 'unsupported_backend',
            backend: 'openssh',
            capability: 'rsync',
            reason: rsyncProbe.reason ?? rsyncProbe.error,
            retryable: false,
        })
    }
    const selectedTransport = capability.rsyncEligible && rsyncProbe?.available ? 'rsync' : 'sftp'
    const decisionReason = !capability.rsyncEligible
        ? capability.decisionReason
        : rsyncProbe?.status === 'available'
          ? capability.decisionReason
          : rsyncProbe?.status === 'unavailable'
            ? 'remote_rsync_unavailable'
            : rsyncProbe?.status === 'timeout'
              ? 'remote_rsync_probe_timeout'
              : 'remote_rsync_probe_failed'
    const operationStartedAt = Date.now()
    const result =
        selectedTransport === 'rsync'
            ? await syncWithRsync(alias, localPath, remotePath, direction, resolvedOptions, capability, rsyncGeneration)
            : await syncWithSftpWithTimeout(alias, localPath, remotePath, direction, resolvedOptions)
    const operationDuration = Date.now() - operationStartedAt
    const operationStatus = result.operationStatus ?? (result.success ? 'completed' : 'failed')
    const connectStatus = result.connectStatus ?? (selectedTransport === 'rsync' ? 'completed' : 'not_applicable')

    return {
        ...result,
        transport: result.method,
        selectedTransport,
        decisionReason,
        rsyncProbe,
        fallbackReason: result.fallbackReason,
        phaseDurations: {
            capabilityPreflight: capabilityDuration,
            connect: result.connectDuration,
            operation: operationDuration,
            total: Date.now() - startedAt,
        },
        phaseStatus: {
            capabilityPreflight:
                rsyncProbe?.status === 'timeout' || rsyncProbe?.status === 'error' ? 'failed' : 'completed',
            connect: connectStatus,
            operation: operationStatus,
        },
        direction,
        dryRun: options.dryRun === true,
        duration: Date.now() - startedAt,
    }
}

/**
 * 使用 rsync 同步文件
 * 通过本地执行 rsync 连接到远程（需要密钥认证或 ssh-agent）
 */
async function syncWithRsync(
    alias: string,
    localPath: string,
    remotePath: string,
    direction: 'upload' | 'download',
    options: SyncOptions,
    capability: ExternalTransferCapability,
    generation: RsyncGeneration
): Promise<SyncResult> {
    assertCurrentRsyncGeneration(alias, generation)
    const connection = sessionManager.getOpenSshConnection(alias)
    const fallbackToSftp = (reason: string): Promise<SyncResult> => {
        if (connection)
            throw new OpenSshError('OpenSSH master sync preflight failed; the selected backend was preserved', {
                code: 'openssh_sync_preflight',
                backend: 'openssh',
                reason,
                retryable: false,
            })
        return syncWithSftpWithTimeout(alias, localPath, remotePath, direction, options)
    }
    const checkCommand = os.platform() === 'win32' ? 'where' : 'which'
    const checkResult = await runLocalProcess(checkCommand, ['rsync'], options.preflightTimeout ?? 10_000)
    assertCurrentRsyncGeneration(alias, generation)
    if (checkResult.status !== 0) {
        const fallback = await fallbackToSftp(
            checkResult.timedOut ? 'local_rsync_preflight_timeout' : 'local_rsync_unavailable'
        )
        return {
            ...fallback,
            connectStatus: 'not_applicable',
            fallbackReason: checkResult.timedOut ? 'local_rsync_preflight_timeout' : 'local_rsync_unavailable',
        }
    }

    // 构建 rsync 参数
    const args: string[] = ['-avz', '--itemize-changes', '--stats']

    if (options.delete) {
        args.push('--delete')
    }
    if (options.dryRun) {
        args.push('--dry-run')
    }
    if (options.exclude) {
        for (const pattern of options.exclude) {
            args.push(`--exclude=${pattern}`)
        }
    }
    if (options.followSymlinks) {
        // -L / --copy-links: 跟随 symlink，上传链接目标内容（与 SFTP 路径 followSymlinks=true 行为一致）
        args.push('-L')
    } else {
        // -a 隐含 -l，显式关闭后默认跳过 symlink，与 SFTP 默认行为一致
        args.push('--no-links')
    }
    args.push('--no-devices', '--no-specials')

    // path 安全校验：以 `-` 起始的路径会被 rsync 当成选项解析（即便有 `--` 兜底，也避免 OS/rsync 实现差异）
    if (localPath.startsWith('-') || remotePath.startsWith('-')) {
        throw new Error('Invalid path: localPath and remotePath must not start with -')
    }

    // username/host 安全校验：拒绝 shell 元字符与 ssh 选项注入
    const sshIdentifierAllowed = /^[a-zA-Z0-9.:_-]+$/
    if (!sshIdentifierAllowed.test(capability.username)) {
        throw new Error(`Invalid username for rsync: "${capability.username}" 含非法字符`)
    }
    if (!sshIdentifierAllowed.test(capability.host)) {
        throw new Error(`Invalid host for rsync: "${capability.host}" 含非法字符`)
    }

    // 构建 rsync argv（不用 shell=true，避免 username/host 含 shell 元字符时注入）
    // ProxyCommand=none 显式禁用 ssh-config 中可能定义的 ProxyCommand,防止外部命令注入
    const connectTimeout = options.connectTimeout ?? 30_000
    const profile = capability.rsyncProfile ?? 'posix'
    const localRsyncPath = process.platform === 'win32' ? convertRsyncPath(localPath, profile) : localPath
    const remoteRsyncPath =
        capability.commandShell && capability.commandShell !== 'posix'
            ? convertRsyncPath(remoteShellPath(remotePath, capability.remotePathStyle ?? 'win32'), profile).replace(
                  /\\/g,
                  '/'
              )
            : remotePath
    const childEnv = { ...process.env }
    if (capability.agent === 'none') {
        delete childEnv.SSH_AUTH_SOCK
    } else if (capability.agent) {
        childEnv.SSH_AUTH_SOCK = capability.agent
    }
    const sshOptions = connection
        ? connection.arguments().slice(0, -1)
        : [
              '-p',
              String(capability.port),
              '-o',
              'StrictHostKeyChecking=accept-new',
              '-o',
              'BatchMode=yes',
              '-o',
              `ConnectTimeout=${Math.max(1, Math.ceil(connectTimeout / 1000))}`,
              '-o',
              'ProxyCommand=none',
          ]
    if (capability.agent === 'none') {
        sshOptions.push('-o', 'IdentityAgent=none')
    }
    if (capability.keyPath) {
        sshOptions.push('-i', capability.keyPath)
    }
    const destination = `${capability.username}@${capability.host}`
    const executable = capability.rsyncExecutable
    if (
        executable &&
        (/[\r\n\0]/.test(executable) || (capability.commandShell === 'cmd' && executable.includes('"')))
    ) {
        throw new Error('Invalid remote rsync executable')
    }
    const remoteCommand = executable
        ? capability.commandShell === 'powershell'
            ? `& '${executable.replace(/'/g, "''")}'`
            : capability.commandShell === 'cmd'
              ? `"${executable}"`
              : escapeShellArg(executable)
        : 'rsync'
    assertCurrentRsyncGeneration(alias, generation)
    const connectStartedAt = Date.now()
    const connectResult = await runLocalProcess(
        'ssh',
        [
            ...sshOptions,
            destination,
            capability.commandShell === 'powershell'
                ? 'powershell.exe -NoProfile -Command exit 0'
                : capability.commandShell === 'cmd'
                  ? 'cmd.exe /D /C exit 0'
                  : 'true',
        ],
        connectTimeout,
        childEnv,
        connection
    )
    const connectDuration = Date.now() - connectStartedAt
    assertCurrentRsyncGeneration(alias, generation)
    if (connectResult.error || connectResult.status !== 0) {
        const fallback = await fallbackToSftp(
            connectResult.stderr.trim() || connectResult.error?.message || 'rsync_connect_failed'
        )
        const fallbackReason = connectResult.timedOut ? 'rsync_connect_timeout' : 'rsync_connect_failed'
        const detail = connectResult.stderr.trim() || connectResult.error?.message
        return {
            ...fallback,
            connectDuration,
            connectStatus: 'failed',
            fallbackReason,
            output: detail
                ? `OpenSSH connect preflight failed: ${detail}\n${fallback.output ?? ''}`.trim()
                : fallback.output,
        }
    }

    if (capability.commandShell && capability.commandShell !== 'posix') {
        const remoteProbe = await runLocalProcess(
            'ssh',
            [...sshOptions, destination, `${remoteCommand} --version`],
            connectTimeout,
            childEnv
        )
        assertCurrentRsyncGeneration(alias, generation)
        if (remoteProbe.error || remoteProbe.status !== 0) {
            const fallback = await fallbackToSftp(
                remoteProbe.stderr.trim() || remoteProbe.error?.message || 'remote_rsync_unavailable'
            )
            const reason = remoteProbe.stderr.trim() || remoteProbe.error?.message || `exit code ${remoteProbe.status}`
            return {
                ...fallback,
                connectDuration,
                connectStatus: 'completed',
                fallbackReason: remoteProbe.timedOut
                    ? 'remote_rsync_command_timeout'
                    : 'remote_rsync_command_unavailable',
                output: `Remote rsync command preflight failed: ${reason}; ${fallback.output ?? ''}`.trim(),
            }
        }
    }

    const sshCmd = ['ssh', ...sshOptions].map((arg) => quoteRsyncSshArg(arg, profile)).join(' ')
    const rsyncLocalPath =
        options.sourceIsDirectory && direction === 'upload' && !localRsyncPath.endsWith('/')
            ? `${localRsyncPath}/`
            : localRsyncPath
    const rsyncRemotePath =
        options.sourceIsDirectory && direction === 'download' && !remoteRsyncPath.endsWith('/')
            ? `${remoteRsyncPath}/`
            : remoteRsyncPath
    // remoteSpec 作为单独 argv 元素，不经 shell 解析
    const remoteSpec = `${destination}:${rsyncRemotePath}`
    if (executable) {
        args.push(`--rsync-path=${remoteCommand}`)
    }
    if (connection || (capability.commandShell !== 'posix' && capability.commandShell !== undefined)) {
        args.push('--protect-args')
    }
    // 在 path 参数前插 `--`，明确剩余为路径而非选项（双重保险）
    const rsyncArgs =
        direction === 'upload'
            ? [...args, '-e', sshCmd, '--', rsyncLocalPath, remoteSpec]
            : [...args, '-e', sshCmd, '--', remoteSpec, localRsyncPath]

    try {
        assertCurrentRsyncGeneration(alias, generation)
        const operationTimeout = options.operationTimeout ?? 600_000
        const result = await runLocalProcess('rsync', rsyncArgs, operationTimeout, childEnv, connection)
        if (!isCurrentRsyncGeneration(alias, generation)) {
            return {
                success: false,
                method: 'rsync',
                connectDuration,
                connectStatus: 'completed',
                operationStatus: 'unknown',
                retryable: true,
                fallbackReason: 'ssh_session_changed',
                output: `SSH session '${alias}' changed during rsync; remote transfer state is unknown`,
            }
        }

        if (result.error || result.status !== 0) {
            const stderr = result.stderr.trim()
            const reason = result.timedOut
                ? `timed out after ${operationTimeout}ms`
                : (result.error?.message ?? `exit code ${result.status}`)
            if (result.timedOut) {
                return {
                    success: false,
                    method: 'rsync',
                    connectDuration,
                    connectStatus: 'completed',
                    operationStatus: 'unknown',
                    timedOut: true,
                    retryable: true,
                    fallbackReason: 'rsync_operation_timeout',
                    output: `rsync ${reason}${stderr ? ` | stderr: ${stderr}` : ''}; remote transfer state is unknown`,
                }
            }
            return {
                success: false,
                method: 'rsync',
                connectDuration,
                connectStatus: 'completed',
                operationStatus: 'unknown',
                retryable: true,
                fallbackReason: 'rsync_operation_failed',
                output: `rsync failed: ${reason}${stderr ? ` | stderr: ${stderr}` : ''}; remote transfer state is unknown`,
            }
        }

        const output = result.stdout
        const stats = parseRsyncStats(output)
        const filesTransferred = stats.added + stats.updated

        return {
            success: true,
            method: 'rsync',
            connectDuration,
            connectStatus: 'completed',
            operationStatus: 'completed',
            filesTransferred,
            stats,
            commandSummary: {
                tool: 'rsync',
                dryRun: options.dryRun === true,
                delete: options.delete === true,
                recursive: options.recursive !== false,
                followSymlinks: options.followSymlinks === true,
                excludeCount: options.exclude?.length ?? 0,
                usedKeyPath: Boolean(capability.keyPath),
            },
            output,
        }
    } catch (e) {
        if (!isCurrentRsyncGeneration(alias, generation)) {
            throw e
        }
        return {
            success: false,
            method: 'rsync',
            connectDuration,
            connectStatus: 'completed',
            operationStatus: 'unknown',
            retryable: true,
            fallbackReason: 'rsync_execution_error',
            output: `rsync execution failed: ${e instanceof Error ? e.message : String(e)}; remote transfer state is unknown`,
        }
    }
}

/**
 * 使用 SFTP 同步文件
 */
type SyncStats = {
    added: number
    updated: number
    deleted: number
    skipped: number
    failed: number
}

type DirectoryTransferResult = {
    fileCount: number
    totalSize: number
    skippedSymlinks: number
    skippedUnsupported: number
    unsupportedSamples: string[]
    added: number
    updated: number
    failed: number
}

class DirectoryTransferAccumulator {
    private readonly result: DirectoryTransferResult = {
        fileCount: 0,
        totalSize: 0,
        skippedSymlinks: 0,
        skippedUnsupported: 0,
        unsupportedSamples: [],
        added: 0,
        updated: 0,
        failed: 0,
    }

    addFile(size: number, existed: boolean): void {
        this.result.fileCount++
        this.result.totalSize += size
        if (existed) {
            this.result.updated++
        } else {
            this.result.added++
        }
    }

    addSkippedSymlink(): void {
        this.result.skippedSymlinks++
    }

    addSkippedUnsupported(itemPath: string): void {
        this.result.skippedUnsupported++
        if (this.result.unsupportedSamples.length < 10) {
            this.result.unsupportedSamples.push(itemPath)
        }
    }

    addFailed(): void {
        this.result.failed++
    }

    toResult(): DirectoryTransferResult {
        return { ...this.result }
    }
}

type SyncResult = {
    success: boolean
    method: 'rsync' | 'sftp'
    transport?: 'rsync' | 'sftp'
    selectedTransport?: 'rsync' | 'sftp'
    decisionReason?: string
    rsyncProbe?: RsyncProbeResult
    fallbackReason?: string
    phaseDurations?: {
        capabilityPreflight: number
        connect?: number
        operation: number
        total: number
    }
    phaseStatus?: {
        capabilityPreflight: 'completed' | 'failed'
        connect: 'completed' | 'failed' | 'not_applicable'
        operation: 'completed' | 'failed' | 'unknown'
    }
    connectDuration?: number
    connectStatus?: 'completed' | 'failed' | 'not_applicable'
    operationStatus?: 'completed' | 'failed' | 'unknown'
    timedOut?: boolean
    retryable?: boolean
    direction?: 'upload' | 'download'
    dryRun?: boolean
    duration?: number
    filesTransferred?: number
    bytesTransferred?: number
    skippedSymlinks?: number
    skippedUnsupported?: number
    unsupportedSamples?: string[]
    stats?: SyncStats
    verification?: Record<string, unknown>
    commandSummary?: Record<string, unknown>
    output?: string
}

function buildDirectorySyncResult(result: DirectoryTransferResult, warnings: string[]): SyncResult {
    const syncResult = buildSyncResult(result.fileCount, result.totalSize, warnings, result.skippedSymlinks, {
        added: result.added,
        updated: result.updated,
        skipped: result.skippedSymlinks + result.skippedUnsupported,
        failed: result.failed,
    })
    return {
        ...syncResult,
        skippedUnsupported: result.skippedUnsupported > 0 ? result.skippedUnsupported : undefined,
        unsupportedSamples: result.unsupportedSamples.length > 0 ? result.unsupportedSamples : undefined,
    }
}

function buildSyncResult(
    fileCount: number,
    totalSize: number,
    warnings: string[],
    skippedSymlinks: number = 0,
    stats?: Partial<SyncStats>
): SyncResult {
    if (skippedSymlinks > 0) {
        warnings.push(`skipped ${skippedSymlinks} symlink(s); link targets were not transferred`)
    }
    return {
        success: true,
        method: 'sftp',
        filesTransferred: fileCount,
        bytesTransferred: totalSize,
        skippedSymlinks: skippedSymlinks > 0 ? skippedSymlinks : undefined,
        stats: {
            added: stats?.added ?? 0,
            updated: stats?.updated ?? fileCount,
            deleted: stats?.deleted ?? 0,
            skipped: stats?.skipped ?? skippedSymlinks,
            failed: stats?.failed ?? 0,
        },
        output: warnings.length ? `Warning: ${warnings.join('; ')}` : undefined,
    }
}

function parseRsyncStats(output: string): SyncStats {
    const stats: SyncStats = { added: 0, updated: 0, deleted: 0, skipped: 0, failed: 0 }
    for (const line of output.split('\n')) {
        if (line.startsWith('*deleting')) {
            stats.deleted++
        } else if (/^>f\+{9}\s/.test(line)) {
            stats.added++
        } else if (/^>f/.test(line)) {
            stats.updated++
        }
    }
    const transferredMatch = output.match(/Number of regular files transferred:\s*(?<count>\d+)/)
    if (transferredMatch?.groups && stats.added + stats.updated === 0) {
        stats.updated = Number(transferredMatch.groups.count)
    }
    return stats
}

export function hashLocalFile(
    filePath: string,
    algorithm: 'md5' | 'sha256' = 'sha256',
    timeout?: number,
    limits?: { maxBytes: number; expectedSize: number }
): Promise<string> {
    return new Promise((resolve, reject) => {
        const before = fs.statSync(filePath)
        if (!before.isFile() || (limits && (before.size > limits.maxBytes || before.size !== limits.expectedSize))) {
            reject(new Error('Local file size changed or exceeds the verification byte budget'))
            return
        }
        const hash = createHash(algorithm)
        const stream = fs.createReadStream(filePath)
        let bytes = 0
        let settled = false
        const finish = (error?: Error): void => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            if (error) {
                stream.destroy()
                reject(error)
            } else resolve(hash.digest('hex'))
        }
        const timer =
            timeout === undefined
                ? undefined
                : setTimeout(() => finish(new Error(`Local file hashing timed out after ${timeout}ms`)), timeout)
        stream.on('data', (chunk) => {
            bytes += Buffer.byteLength(chunk)
            if (bytes > before.size || (limits && bytes > limits.maxBytes))
                finish(new Error('Local file grew during verification'))
            else hash.update(chunk)
        })
        stream.on('error', finish)
        stream.on('end', () => {
            try {
                const after = fs.statSync(filePath)
                const changed =
                    bytes !== before.size ||
                    after.size !== before.size ||
                    after.ino !== before.ino ||
                    after.dev !== before.dev ||
                    after.mtimeMs !== before.mtimeMs ||
                    after.ctimeMs !== before.ctimeMs
                finish(changed ? new Error('Local file changed during verification') : undefined)
            } catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)))
            }
        })
    })
}

async function hashRemoteFile(
    alias: string,
    remotePath: string
): Promise<{
    status: 'available' | 'error'
    digest?: string
    retryable: boolean
    error?: string
}> {
    try {
        const digest = await hashRemoteFileDigest(alias, remotePath, 'sha256')
        return { status: 'available', digest, retryable: false }
    } catch (error) {
        return {
            status: 'error',
            retryable: true,
            error: error instanceof Error ? error.message : String(error),
        }
    }
}

async function buildSingleFileVerification(
    alias: string,
    localPath: string,
    remotePath: string,
    direction: 'upload' | 'download'
): Promise<Record<string, unknown>> {
    try {
        const localStats = fs.statSync(localPath)
        const [remoteInfo, localSha256, remoteHash] = await Promise.all([
            getFileInfo(alias, remotePath),
            hashLocalFile(localPath),
            hashRemoteFile(alias, remotePath),
        ])
        return {
            kind: 'single_file',
            direction,
            status: remoteHash.status === 'available' ? 'completed' : 'error',
            failureStage: remoteHash.status === 'error' ? 'remote_hash' : undefined,
            retryable: remoteHash.retryable,
            error: remoteHash.error,
            hashAlgorithm: 'sha256',
            hashMatch: remoteHash.digest ? localSha256 === remoteHash.digest : undefined,
            local: {
                size: localStats.size,
                mode: (localStats.mode & 0o777).toString(8),
                mtimeMs: Math.round(localStats.mtimeMs),
                sha256: localSha256,
            },
            remote: {
                size: remoteInfo.size,
                permissions: remoteInfo.permissions,
                owner: remoteInfo.owner,
                group: remoteInfo.group,
                mtime: remoteInfo.mtime,
                sha256: remoteHash.digest,
            },
        }
    } catch (error) {
        return {
            kind: 'single_file',
            direction,
            status: 'error',
            failureStage: 'remote_metadata_or_hash',
            retryable: true,
            error: error instanceof Error ? error.message : String(error),
        }
    }
}

async function resolveSftpUploadFileTarget(
    alias: string,
    localPath: string,
    remotePath: string,
    style: 'posix' | 'win32' | 'sftp-posix' = 'posix'
): Promise<string> {
    if (remotePath.endsWith('/') || remotePath.endsWith('\\')) {
        return remoteJoin(style, remotePath, path.basename(localPath))
    }
    try {
        const info = await getFileInfo(alias, remotePath)
        if (info.isDirectory) {
            return remoteJoin(style, remotePath, path.basename(localPath))
        }
    } catch (error) {
        if (!isSftpMissingError(error)) {
            throw error
        }
        // Missing remote targets are handled by uploadFile below.
    }
    return remotePath
}

function resolveSftpDownloadFileTarget(
    remotePath: string,
    localPath: string,
    style: 'posix' | 'win32' | 'sftp-posix' = 'posix'
): string {
    if (localPath.endsWith(path.sep)) {
        fs.mkdirSync(localPath, { recursive: true })
        return path.join(localPath, remotePathModule(style).basename(remotePath))
    }
    if (fs.existsSync(localPath) && fs.statSync(localPath).isDirectory()) {
        return path.join(localPath, remotePathModule(style).basename(remotePath))
    }
    return localPath
}

async function syncWithSftpWithTimeout(
    alias: string,
    localPath: string,
    remotePath: string,
    direction: 'upload' | 'download',
    options: SyncOptions
): Promise<SyncResult> {
    const timeout = options.operationTimeout ?? 600_000
    const controller = new AbortController()
    const accumulator = new DirectoryTransferAccumulator()
    const warnings: string[] = []
    const operation = syncWithSftp(
        alias,
        localPath,
        remotePath,
        direction,
        {
            ...options,
            signal: controller.signal,
        },
        accumulator,
        warnings
    )
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<SyncResult>((resolve) => {
        timer = setTimeout(() => {
            controller.abort(new SftpOperationTimeoutError(timeout))
            resolve({
                ...buildDirectorySyncResult(accumulator.toResult(), [...warnings]),
                success: false,
                method: 'sftp',
                operationStatus: 'unknown',
                timedOut: true,
                retryable: true,
                output: `SFTP operation timed out after ${timeout}ms; remote transfer state is unknown`,
            })
        }, timeout)
    })
    const result = await Promise.race([operation, timedOut])
    if (timer) {
        clearTimeout(timer)
    }
    return result
}

async function syncWithSftp(
    alias: string,
    localPath: string,
    remotePath: string,
    direction: 'upload' | 'download',
    options: SyncOptions,
    accumulator: DirectoryTransferAccumulator,
    warnings: string[]
): Promise<SyncResult> {
    throwIfAborted(options.signal)
    if (options.delete) {
        warnings.push('delete option is not supported in SFTP mode (requires rsync)')
    }

    if (options.dryRun) {
        const localExists = fs.existsSync(localPath)
        const localStats = localExists ? fs.lstatSync(localPath) : undefined
        const remoteTargetExists = await remoteExists(alias, remotePath)
        return {
            success: true,
            method: 'sftp',
            commandSummary: {
                dryRun: true,
                direction,
                recursive: options.recursive !== false,
                followSymlinks: options.followSymlinks === true,
                deleteRequested: options.delete === true,
                deleteSupported: options.delete ? false : undefined,
                excludeCount: options.exclude?.length ?? 0,
                localExists,
                localIsDirectory: localStats?.isDirectory(),
                localIsSymlink: localStats?.isSymbolicLink(),
                remoteTargetExists,
                wouldOverwrite: direction === 'upload' ? remoteTargetExists : localExists,
            },
            output:
                'Dry run mode: would transfer files via SFTP' +
                (warnings.length ? `. Warning: ${warnings.join('; ')}` : ''),
        }
    }

    if (options.delete) {
        return {
            success: false,
            method: 'sftp',
            stats: { added: 0, updated: 0, deleted: 0, skipped: 0, failed: 1 },
            output: 'delete option is not supported in SFTP mode (requires rsync)',
        }
    }

    try {
        if (direction === 'upload') {
            const stats = options.followSymlinks ? fs.statSync(localPath) : fs.lstatSync(localPath)
            if (stats.isSymbolicLink()) {
                return {
                    success: false,
                    method: 'sftp',
                    stats: { added: 0, updated: 0, deleted: 0, skipped: 0, failed: 1 },
                    output: 'Refusing to upload symlink at top level (set followSymlinks=true to traverse)',
                }
            }
            if (stats.isDirectory() && options.recursive === false) {
                return {
                    success: false,
                    method: 'sftp',
                    operationStatus: 'failed',
                    stats: { added: 0, updated: 0, deleted: 0, skipped: 0, failed: 1 },
                    output: 'recursive=false does not support directories; use a file source or enable recursion',
                }
            }
            if (stats.isDirectory()) {
                const result = await uploadDirectory(
                    alias,
                    localPath,
                    remotePath,
                    options.exclude,
                    undefined,
                    options.followSymlinks ?? false,
                    { files: 0, directories: 0, bytes: 0 },
                    0,
                    options.signal,
                    '',
                    options.remotePathStyle,
                    undefined,
                    accumulator
                )
                return buildDirectorySyncResult(result, warnings)
            }
            const targetRemotePath = await resolveSftpUploadFileTarget(
                alias,
                localPath,
                remotePath,
                options.remotePathStyle
            )
            const existed = await remoteExists(alias, targetRemotePath)
            const { size } = await uploadFile(
                alias,
                localPath,
                targetRemotePath,
                undefined,
                undefined,
                undefined,
                options.signal,
                options.followSymlinks === true
            )
            return {
                ...buildSyncResult(1, size, warnings, 0, { added: existed ? 0 : 1, updated: existed ? 1 : 0 }),
                verification: await buildSingleFileVerification(alias, localPath, targetRemotePath, 'upload'),
            }
        }

        // download
        const info = await getFileInfo(alias, remotePath, undefined, options.remotePathStyle)
        if (info.isDirectory && options.recursive === false) {
            return {
                success: false,
                method: 'sftp',
                operationStatus: 'failed',
                stats: { added: 0, updated: 0, deleted: 0, skipped: 0, failed: 1 },
                output: 'recursive=false is not supported for directory sources; use a file source or enable recursion',
            }
        }
        if (info.isDirectory) {
            const result = await downloadDirectory(
                alias,
                remotePath,
                localPath,
                options.exclude,
                undefined,
                {
                    files: 0,
                    directories: 0,
                    bytes: 0,
                },
                0,
                options.signal,
                '',
                options.remotePathStyle,
                accumulator
            )
            return buildDirectorySyncResult(result, warnings)
        }
        const targetLocalPath = resolveSftpDownloadFileTarget(remotePath, localPath, options.remotePathStyle)
        const existed = fs.existsSync(targetLocalPath)
        const { size } = await downloadFile(alias, remotePath, targetLocalPath, undefined, undefined, options.signal)
        return {
            ...buildSyncResult(1, size, warnings, 0, { added: existed ? 0 : 1, updated: existed ? 1 : 0 }),
            verification: await buildSingleFileVerification(alias, targetLocalPath, remotePath, 'download'),
        }
    } catch (err) {
        const result = buildDirectorySyncResult(accumulator.toResult(), warnings)
        const timedOut = err instanceof SftpOperationTimeoutError
        return {
            ...result,
            success: false,
            operationStatus: timedOut ? 'unknown' : 'failed',
            timedOut: timedOut || undefined,
            retryable: timedOut || undefined,
            stats: { ...result.stats!, failed: Math.max(1, result.stats!.failed) },
            output: [result.output, err instanceof Error ? err.message : String(err)].filter(Boolean).join('; '),
        }
    }
}

/**
 * 递归上传目录
 */
async function uploadDirectory(
    alias: string,
    localPath: string,
    remotePath: string,
    exclude?: string[],
    sharedSftp?: SFTPWrapper,
    followSymlinks: boolean = false,
    traversal: SftpTraversalState = { files: 0, directories: 0, bytes: 0 },
    depth: number = 0,
    signal?: AbortSignal,
    relativeBase: string = '',
    style: 'posix' | 'win32' | 'sftp-posix' = 'posix',
    inspectNames?: (parent: string, names: string[]) => void,
    accumulator: DirectoryTransferAccumulator = new DirectoryTransferAccumulator()
): Promise<DirectoryTransferResult> {
    throwIfAborted(signal)

    recordSftpDirectory(traversal, depth, localPath)
    const ownSftp = !sharedSftp && !inspectNames
    const sftp = inspectNames ? undefined : (sharedSftp ?? (await getSftpWithinDeadline(alias)))
    const activeDirectories = (traversal.activeDirectories ??= new Set())
    const realPath = fs.realpathSync(localPath)
    if (activeDirectories.has(realPath)) {
        accumulator.addSkippedSymlink()
        if (ownSftp) {
            sftp!.end()
        }
        return accumulator.toResult()
    }
    activeDirectories.add(realPath)

    try {
        validateLocalPathAgainstAllowList(localPath)
        if (!inspectNames) {
            await mkdir(alias, remotePath, true, sftp, undefined, style)
        }
        throwIfAborted(signal)

        const items = fs.readdirSync(localPath)
        // 先分类：目录串行（递归会自己并发文件）；文件并发上传，避免单 SSH session 上 channel 过多
        const subDirItems: string[] = []
        const fileItems: { name: string; stats: fs.Stats }[] = []
        for (const item of items) {
            const itemRelativePath = relativeBase ? `${relativeBase}/${item}` : item
            if (matchesDirectoryExclude(itemRelativePath, exclude)) {
                continue
            }
            const itemLocalPath = path.join(localPath, item)
            const stats = followSymlinks ? fs.statSync(itemLocalPath) : fs.lstatSync(itemLocalPath)
            if (!followSymlinks && stats.isSymbolicLink()) {
                if (!inspectNames) {
                    console.warn(`[ssh_sync] skipping symlink: ${itemLocalPath}`)
                }
                accumulator.addSkippedSymlink()
                continue
            }
            if (stats.isDirectory()) {
                if (activeDirectories.has(fs.realpathSync(itemLocalPath))) {
                    accumulator.addSkippedSymlink()
                    continue
                }
                subDirItems.push(item)
            } else if (stats.isFile()) {
                recordSftpFile(traversal, stats.size, depth, itemLocalPath)
                fileItems.push({ name: item, stats })
            } else {
                accumulator.addSkippedUnsupported(itemRelativePath)
            }
        }

        if (inspectNames) {
            inspectNames(remotePath, [...subDirItems, ...fileItems.map(({ name }) => name)])
        } else {
            // 文件并发上传
            await runWithConcurrency(fileItems, SFTP_PARALLEL_LIMIT, async ({ name, stats }) => {
                const itemLocalPath = path.join(localPath, name)
                const itemRemotePath = remoteJoin(style, remotePath, name)
                const existed = await sftpExists(sftp!, itemRemotePath)
                try {
                    await uploadFile(
                        alias,
                        itemLocalPath,
                        itemRemotePath,
                        undefined,
                        sftp,
                        undefined,
                        signal,
                        followSymlinks
                    )
                    accumulator.addFile(stats.size, existed)
                } catch (error) {
                    accumulator.addFailed()
                    throw error
                }
            })
        }

        // 子目录串行递归
        for (const item of subDirItems) {
            const itemLocalPath = path.join(localPath, item)
            const itemRemotePath = remoteJoin(style, remotePath, item)
            await uploadDirectory(
                alias,
                itemLocalPath,
                itemRemotePath,
                exclude,
                sftp,
                followSymlinks,
                traversal,
                depth + 1,
                signal,
                relativeBase ? `${relativeBase}/${item}` : item,
                style,
                inspectNames,
                accumulator
            )
        }
    } finally {
        activeDirectories.delete(realPath)
        if (ownSftp) {
            sftp!.end()
        }
    }

    return accumulator.toResult()
}

/**
 * 递归下载目录
 */
async function downloadDirectory(
    alias: string,
    remotePath: string,
    localPath: string,
    exclude?: string[],
    sharedSftp?: SFTPWrapper,
    traversal: SftpTraversalState = { files: 0, directories: 0, bytes: 0 },
    depth: number = 0,
    signal?: AbortSignal,
    relativeBase: string = '',
    style: 'posix' | 'win32' | 'sftp-posix' = 'posix',
    accumulator: DirectoryTransferAccumulator = new DirectoryTransferAccumulator()
): Promise<DirectoryTransferResult> {
    throwIfAborted(signal)

    recordSftpDirectory(traversal, depth, remotePath)
    const ownSftp = !sharedSftp
    const sftp = sharedSftp ?? (await getSftpWithinDeadline(alias))

    try {
        const items = await listDir(alias, remotePath, true, sftp, undefined, style)
        throwIfAborted(signal)
        if (process.platform === 'win32') {
            const localNames = new Map(
                (fs.existsSync(localPath) ? fs.readdirSync(localPath) : []).map((name) => [
                    name.normalize('NFC').toLowerCase(),
                    name,
                ])
            )
            const remoteNames = new Set<string>()
            for (const item of items) {
                const relativeName = relativeBase ? `${relativeBase}/${item.name}` : item.name
                if (matchesDirectoryExclude(relativeName, exclude) || (!item.isDirectory && !item.isFile)) {
                    continue
                }
                if (
                    /[<>:"/\\|?*]/.test(item.name) ||
                    [...item.name].some((char) => char.charCodeAt(0) < 32) ||
                    /[. ]$/.test(item.name) ||
                    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(item.name)
                ) {
                    throw new Error(`Remote entry cannot be represented as a Windows filename: ${relativeName}`)
                }
                const key = item.name.normalize('NFC').toLowerCase()
                if (remoteNames.has(key) || (localNames.has(key) && localNames.get(key) !== item.name)) {
                    throw new Error(`Windows local filename collision at ${relativeName}`)
                }
                remoteNames.add(key)
            }
        }
        if (!fs.existsSync(localPath)) {
            fs.mkdirSync(localPath, { recursive: true })
        }
        // 分类：文件并发下载,目录串行递归
        const fileItems: typeof items = []
        const dirItems: typeof items = []
        const symlinkItems: typeof items = []
        for (const item of items) {
            const itemRelativePath = relativeBase ? `${relativeBase}/${item.name}` : item.name
            if (matchesDirectoryExclude(itemRelativePath, exclude)) {
                continue
            }
            if (item.isDirectory) {
                dirItems.push(item)
            } else if (item.isFile) {
                recordSftpFile(traversal, item.size, depth, item.path)
                fileItems.push(item)
            } else if (item.isSymlink) {
                symlinkItems.push(item)
            } else {
                accumulator.addSkippedUnsupported(itemRelativePath)
            }
        }

        await runWithConcurrency(fileItems, SFTP_PARALLEL_LIMIT, async (item) => {
            const itemLocalPath = path.join(localPath, item.name)
            const existed = fs.existsSync(itemLocalPath)
            try {
                await downloadFile(alias, item.path, itemLocalPath, undefined, sftp, signal)
                accumulator.addFile(item.size, existed)
            } catch (error) {
                accumulator.addFailed()
                throw error
            }
        })

        for (const item of dirItems) {
            const itemLocalPath = path.join(localPath, item.name)
            await downloadDirectory(
                alias,
                item.path,
                itemLocalPath,
                exclude,
                sftp,
                traversal,
                depth + 1,
                signal,
                relativeBase ? `${relativeBase}/${item.name}` : item.name,
                style,
                accumulator
            )
        }

        for (const item of symlinkItems) {
            console.warn(`[ssh_sync] skipping remote symlink: ${item.path}`)
            accumulator.addSkippedSymlink()
        }
    } finally {
        if (ownSftp) {
            sftp.end()
        }
    }

    return accumulator.toResult()
}
