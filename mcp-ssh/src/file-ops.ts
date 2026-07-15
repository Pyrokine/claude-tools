/**
 * SSH File Operations - 文件操作
 */

import { spawn } from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { StringDecoder } from 'string_decoder'
import { SFTPWrapper, Stats } from 'ssh2'
import { matchesDirectoryExclude } from './directory-verification.js'
import { sessionManager } from './session-manager.js'
import { escapeShellArg, expandTilde } from './tools/utils.js'
import { ExternalTransferCapability, FileInfo, TransferProgress } from './types.js'

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

function runLocalProcess(command: string, args: string[], timeout: number): Promise<LocalProcessResult> {
    return new Promise((resolve) => {
        let stdout = ''
        let stderr = ''
        let settled = false
        let timedOut = false
        let killTimer: NodeJS.Timeout | undefined
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        const timer = setTimeout(() => {
            timedOut = true
            child.kill('SIGTERM')
            killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
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

/** 由 SessionManager.disconnect 调用,防止 alias 重连后读到旧主机的判断 */
export function clearRsyncCache(alias?: string): void {
    if (alias === undefined) {
        rsyncCache.clear()
    } else {
        rsyncCache.delete(alias)
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

class SftpOperationTimeoutError extends Error {
    constructor(readonly timeout: number) {
        super(`SFTP operation timed out after ${timeout}ms; remote transfer state is unknown`)
        this.name = 'SftpOperationTimeoutError'
    }
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
    for (let i = 0; i < Math.min(limit, items.length); i++) {
        runners.push(
            (async () => {
                while (true) {
                    const next = it.next()
                    if (next.done) {
                        return
                    }
                    await worker(next.value)
                }
            })()
        )
    }
    await Promise.all(runners)
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
function quoteRsyncSshArg(value: string | number): string {
    return escapeShellArg(String(value))
}

function getAllowListStatus(localPath: string): { configured: boolean; matched?: boolean } {
    const allowEnv = process.env.SSH_MCP_FILE_OPS_ALLOW_DIRS
    const allowDirs = allowEnv?.split(path.delimiter).filter((item) => item.trim().length > 0) ?? []
    if (allowDirs.length === 0) {
        return { configured: false }
    }
    const resolvedLocal = resolvePathOrAncestor(localPath)
    const matched = allowDirs.some((dir) => {
        try {
            const resolvedDir = fs.realpathSync(dir)
            const rel = path.relative(resolvedDir, resolvedLocal)
            return !rel.startsWith('..') && !path.isAbsolute(rel)
        } catch {
            return false
        }
    })
    return { configured: true, matched }
}

function validateLocalPathAgainstAllowList(localPath: string): void {
    const allowList = getAllowListStatus(localPath)
    if (allowList.configured && !allowList.matched) {
        throw new Error('localPath 不在 SSH_MCP_FILE_OPS_ALLOW_DIRS 允许目录内')
    }
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
        mode: (stats.mode & 0o777).toString(8).padStart(4, '0'),
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
function sftpStat(sftp: SFTPWrapper, remotePath: string): Promise<Stats> {
    return new Promise((resolve, reject) => {
        sftp.stat(remotePath, (err, stats) => {
            if (err) {
                reject(err)
            } else {
                resolve(stats)
            }
        })
    })
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
    const sftp = await sessionManager.getSftp(alias)
    try {
        return await sftpExists(sftp, remotePath)
    } finally {
        sftp.end()
    }
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
            if (!settled) {
                settled = true
                detachAbort()
                if (closeSftp) {
                    sftp.end()
                }
                resolve({ success: true, size: totalSize })
            }
        })

        if (signal?.aborted) {
            cleanup(abortError(signal))
            return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        readStream.pipe(writeStream)
    })
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
    signal?: AbortSignal
): Promise<{ success: boolean; size: number; createMode: string }> {
    throwIfAborted(signal)
    localPath = expandTilde(localPath)
    validateLocalPathAgainstAllowList(localPath)
    if (!fs.existsSync(localPath)) {
        throw new Error('Local file not found')
    }

    // 用 lstat 拒绝顶层 symlink，与 ssh_sync 顶层 followSymlinks=false 行为一致；
    // 单文件接口不引入 followSymlinks 选项，需走 symlink 请用 ssh_sync
    const lstats = fs.lstatSync(localPath)
    if (lstats.isSymbolicLink()) {
        throw new Error('Refusing to upload symlink at top level (use ssh_sync with followSymlinks=true to traverse)')
    }
    if (lstats.isDirectory()) {
        throw new Error('UPLOAD_PATH_IS_DIRECTORY: localPath is a directory, use ssh_sync for directory upload')
    }
    if (!lstats.isFile()) {
        throw new Error('UPLOAD_PATH_IS_NOT_FILE: localPath is not a regular file')
    }

    const sftp = sharedSftp ?? (await sessionManager.getSftp(alias))
    const totalSize = lstats.size

    const safeCreateMode = (createMode ?? lstats.mode) & 0o777
    const result = await pipeWithProgress(
        fs.createReadStream(localPath),
        sftp.createWriteStream(remotePath, { mode: safeCreateMode }),
        sftp,
        totalSize,
        onProgress,
        !sharedSftp,
        signal
    )
    return { ...result, createMode: safeCreateMode.toString(8).padStart(4, '0') }
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
    signal?: AbortSignal
): Promise<{ success: boolean; size: number }> {
    throwIfAborted(signal)
    localPath = expandTilde(localPath)
    validateLocalPathAgainstAllowList(localPath)
    const sftp = sharedSftp ?? (await sessionManager.getSftp(alias))
    try {
        const totalSize = (await sftpStat(sftp, remotePath)).size

        // 确保本地目录存在
        const localDir = path.dirname(localPath)
        if (!fs.existsSync(localDir)) {
            fs.mkdirSync(localDir, { recursive: true })
        }

        return await pipeWithProgress(
            sftp.createReadStream(remotePath),
            fs.createWriteStream(localPath),
            sftp,
            totalSize,
            onProgress,
            !sharedSftp,
            signal
        )
    } catch (error) {
        if (!sharedSftp) {
            sftp.end()
        }
        throw error
    }
}

export const DEFAULT_READ_FILE_MAX_BYTES = 1024 * 1024
export const HARD_READ_FILE_MAX_BYTES = 16 * 1024 * 1024

type ReadFileSampleKind = 'full' | 'head' | 'tail' | 'range' | 'line_range'

type ReadFileOptions = {
    maxBytes?: number
    offset?: number
    tail?: boolean
    lineRange?: string
}

type NormalizedReadFileOptions = ReadFileOptions & { maxBytes: number }

type ReadFileResult = {
    content: string
    size: number
    total_size: number
    read_offset: number
    read_bytes: number
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
}

function emptyReadResult(totalSize: number, sampleKind: ReadFileSampleKind, readOffset: number = 0): ReadFileResult {
    return {
        content: '',
        size: totalSize,
        total_size: totalSize,
        read_offset: readOffset,
        read_bytes: 0,
        remaining_bytes: Math.max(0, totalSize - readOffset),
        sample_kind: sampleKind,
        truncated: readOffset < totalSize,
    }
}

export function buildLineRangeAwkProgram(start: number, end: number): string {
    return [
        'BEGIN { written = 0; actual_start = 0; actual_end = 0; byte_limit = 0; saw_after = 0; full_body = 0 }',
        `NR >= ${start} && NR <= ${end} {`,
        '    if (actual_start == 0) { actual_start = NR }',
        '    actual_end = NR',
        '    remaining = max - written',
        '    if (remaining <= 0) { byte_limit = 1; exit }',
        '    body_length = length($0)',
        '    if (body_length >= remaining) {',
        '        printf "%s", substr($0, 1, remaining)',
        '        written += remaining',
        '        if (body_length > remaining) { byte_limit = 1; exit }',
        '        full_body = 1',
        '        next',
        '    }',
        '    printf "%s\\n", $0',
        '    written += body_length + 1',
        '    full_body = 0',
        '}',
        `NR > ${end} { if (full_body) { byte_limit = 1 } saw_after = 1; exit }`,
        'END {',
        '    if (full_body && final_terminated) { byte_limit = 1 }',
        '    printf "__MCP_LINE_META__%d:%d:%d:%d:%d\\n", actual_start, actual_end, written, byte_limit, saw_after > "/dev/stderr"',
        '}',
    ].join('\n')
}

async function readLineRange(
    alias: string,
    remotePath: string,
    totalSize: number,
    maxBytes: number,
    lineRange: string
): Promise<ReadFileResult> {
    const { start, end } = parseLineRange(lineRange)
    const awkProgram = buildLineRangeAwkProgram(start, end)
    const escapedPath = escapeShellArg(remotePath)
    const command = [
        `last_byte=$(tail -c 1 -- ${escapedPath} 2>/dev/null | od -An -tu1 | tr -d ' ')`,
        'if [ "$last_byte" = "10" ]; then terminated=1; else terminated=0; fi',
        `LC_ALL=C awk -v max=${maxBytes} -v final_terminated="$terminated" ${escapeShellArg(awkProgram)} ${escapedPath} | base64 | tr -d '\\n'`,
        'status=${PIPESTATUS[0]}',
        'printf "__MCP_LINE_END__%s\\n" "$terminated" >&2',
        'exit "$status"',
    ].join('; ')
    const result = await sessionManager.exec(alias, `bash -c ${escapeShellArg(command)}`, {
        timeout: 30000,
        useLoginUser: true,
        maxOutputSize: Math.ceil(maxBytes / 3) * 4 + 4096,
    })
    if (!result.success) {
        const message =
            result.stderr.trim() ||
            result.stdout.trim() ||
            `remote lineRange command failed with exit code ${result.exitCode}`
        throw new Error(message)
    }
    const metadataMatch = result.stderr.match(/__MCP_LINE_META__(\d+):(\d+):(\d+):([01]):([01])/)
    const terminatedMatch = result.stderr.match(/__MCP_LINE_END__([01])/)
    if (!metadataMatch || !terminatedMatch) {
        throw new Error('remote lineRange command returned incomplete metadata')
    }
    const actualStart = Number(metadataMatch[1])
    const actualEnd = Number(metadataMatch[2])
    const encoded = result.stdout.trim()
    if (encoded && (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0)) {
        throw new Error('remote lineRange command returned malformed base64 content')
    }
    let rawContent = Buffer.from(encoded, 'base64')
    const metadataByteLimitReached = metadataMatch[4] === '1'
    const sawAfter = metadataMatch[5] === '1'
    const finalLineTerminated = terminatedMatch[1] === '1'
    if (!sawAfter && !metadataByteLimitReached && !finalLineTerminated && rawContent.at(-1) === 0x0a) {
        rawContent = rawContent.subarray(0, -1)
    }
    const decoder = new StringDecoder('utf8')
    const content = decoder.write(rawContent)
    const incompleteUtf8 = decoder.end().length > 0
    const readBytes = Buffer.byteLength(content, 'utf8')
    const byteLimitReached = metadataByteLimitReached || incompleteUtf8
    const eof = !sawAfter && !byteLimitReached
    return {
        content,
        size: totalSize,
        total_size: totalSize,
        read_offset: 0,
        read_bytes: readBytes,
        sample_kind: 'line_range',
        truncated: byteLimitReached || sawAfter,
        line_start: actualStart || undefined,
        line_end: actualEnd || undefined,
        eof,
        byte_limit_reached: byteLimitReached,
        final_line_terminated: actualEnd === 0 ? undefined : finalLineTerminated,
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

    const sftp = await sessionManager.getSftp(alias)
    let actualSize: number
    try {
        actualSize = (await sftpStat(sftp, remotePath)).size
    } catch (error) {
        sftp.end()
        throw error
    }

    if (readOptions.lineRange) {
        sftp.end()
        return readLineRange(alias, remotePath, actualSize, readOptions.maxBytes, readOptions.lineRange)
    }

    if (actualSize === 0) {
        sftp.end()
        return emptyReadResult(0, readOptions.tail ? 'tail' : readOptions.offset !== undefined ? 'range' : 'full')
    }

    const readOffset = readOptions.tail
        ? Math.max(0, actualSize - readOptions.maxBytes)
        : Math.min(readOptions.offset ?? 0, actualSize)
    const readSize = Math.min(actualSize - readOffset, readOptions.maxBytes)
    const sampleKind: ReadFileSampleKind = readOptions.tail
        ? 'tail'
        : readOptions.offset !== undefined
          ? 'range'
          : actualSize <= readOptions.maxBytes
            ? 'full'
            : 'head'

    if (readSize === 0) {
        sftp.end()
        return emptyReadResult(actualSize, sampleKind, readOffset)
    }

    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []

        const readStream = sftp.createReadStream(remotePath, {
            start: readOffset,
            end: readOffset + readSize - 1,
        })

        readStream.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
        })

        readStream.on('end', () => {
            sftp.end()
            const buffer = Buffer.concat(chunks)
            const remainingBytes = Math.max(0, actualSize - readOffset - buffer.length)
            resolve({
                content: buffer.toString('utf-8'),
                size: actualSize,
                total_size: actualSize,
                read_offset: readOffset,
                read_bytes: buffer.length,
                remaining_bytes: remainingBytes,
                sample_kind: sampleKind,
                truncated: readOffset > 0 || remainingBytes > 0,
            })
        })

        readStream.on('error', (err: Error) => {
            sftp.end()
            reject(err)
        })
    })
}

/**
 * 写入远程文件
 */
export async function writeFile(
    alias: string,
    remotePath: string,
    content: string,
    append: boolean = false
): Promise<{ success: boolean; size: number }> {
    const sftp = await sessionManager.getSftp(alias)
    const flags = append ? 'a' : 'w'
    const contentBuffer = Buffer.from(content, 'utf-8')

    return new Promise((resolve, reject) => {
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
    })
}

/**
 * 列出目录内容
 */
export async function listDir(
    alias: string,
    remotePath: string,
    showHidden: boolean = false,
    sharedSftp?: SFTPWrapper
): Promise<FileInfo[]> {
    const sftp = sharedSftp ?? (await sessionManager.getSftp(alias))
    const closeWhenDone = !sharedSftp

    return new Promise((resolve, reject) => {
        sftp.readdir(remotePath, (err, list) => {
            if (err) {
                if (closeWhenDone) {
                    sftp.end()
                }
                reject(err)
                return
            }

            const files: FileInfo[] = list
                .filter((item) => showHidden || !item.filename.startsWith('.'))
                .map((item) => ({
                    name: item.filename,
                    path: path.posix.join(remotePath, item.filename),
                    size: item.attrs.size,
                    isDirectory: (item.attrs.mode & S_IFMT) === S_IFDIR,
                    isFile: (item.attrs.mode & S_IFMT) === S_IFREG,
                    isSymlink: (item.attrs.mode & S_IFMT) === S_IFLNK,
                    permissions: formatPermissions(item.attrs.mode),
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
    })
}

/**
 * 获取文件信息
 */
export async function getFileInfo(alias: string, remotePath: string): Promise<FileInfo> {
    const sftp = await sessionManager.getSftp(alias)

    return new Promise((resolve, reject) => {
        sftp.stat(remotePath, (err, stats) => {
            sftp.end()

            if (err) {
                reject(err)
                return
            }

            resolve({
                name: path.posix.basename(remotePath),
                path: remotePath,
                size: stats.size,
                isDirectory: (stats.mode & S_IFMT) === S_IFDIR,
                isFile: (stats.mode & S_IFMT) === S_IFREG,
                isSymlink: (stats.mode & S_IFMT) === S_IFLNK,
                permissions: formatPermissions(stats.mode),
                owner: stats.uid,
                group: stats.gid,
                mtime: new Date(stats.mtime * 1000),
                atime: new Date(stats.atime * 1000),
            })
        })
    })
}

/**
 * 创建目录
 */
export async function mkdir(alias: string, remotePath: string, recursive: boolean = false): Promise<boolean> {
    if (recursive) {
        // 通过 exec 实现递归创建
        const result = await sessionManager.exec(alias, `mkdir -p ${escapeShellArg(remotePath)}`)
        if (!result.success || result.exitCode !== 0) {
            const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
            throw new Error(`Remote mkdir failed for ${remotePath}: ${detail}`)
        }
        return true
    }

    const sftp = await sessionManager.getSftp(alias)
    return new Promise((resolve, reject) => {
        sftp.mkdir(remotePath, (err) => {
            sftp.end()
            if (err) {
                reject(err)
            } else {
                resolve(true)
            }
        })
    })
}

/**
 * 检查远程是否安装 rsync
 */
export async function checkRsync(alias: string, timeout: number = 10_000): Promise<RsyncProbeResult> {
    const cached = rsyncCache.get(alias)
    if (cached !== undefined && cached.expiresAt > Date.now()) {
        return cached.value
    }

    const startedAt = Date.now()
    try {
        const result = await sessionManager.exec(alias, 'command -v rsync', {
            timeout,
            useLoginUser: true,
            maxOutputSize: 4096,
        })
        const duration = Date.now() - startedAt
        if (result.success && result.exitCode === 0 && result.stdout.trim().length > 0) {
            const probe: RsyncProbeResult = {
                available: true,
                status: 'available',
                duration,
                retryable: false,
                exitCode: result.exitCode,
            }
            rsyncCache.set(alias, { value: probe, expiresAt: Date.now() + RSYNC_CACHE_TTL_MS })
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
            rsyncCache.set(alias, { value: probe, expiresAt: Date.now() + RSYNC_CACHE_TTL_MS })
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

    const capabilityStartedAt = Date.now()
    const capability = sessionManager.getExternalTransferCapability(alias)
    let sourceIsDirectory: boolean
    if (direction === 'upload') {
        if (!fs.existsSync(localPath)) {
            throw new Error(`Local source does not exist: ${localPath}`)
        }
        const linkStats = fs.lstatSync(localPath)
        if (linkStats.isSymbolicLink() && !options.followSymlinks) {
            throw new Error('Refusing to sync a top-level symlink; set followSymlinks=true to traverse its target')
        }
        sourceIsDirectory = (options.followSymlinks ? fs.statSync(localPath) : linkStats).isDirectory()
    } else {
        sourceIsDirectory = (await getFileInfo(alias, remotePath)).isDirectory
    }
    if (sourceIsDirectory && options.recursive === false) {
        throw new Error('recursive=false is not supported for directory sources; use a file source or enable recursion')
    }

    const preflightTimeout = options.preflightTimeout ?? 10_000
    const rsyncProbe: RsyncProbeResult = capability.rsyncEligible
        ? await checkRsync(alias, preflightTimeout)
        : {
              available: false,
              status: 'skipped',
              duration: 0,
              retryable: false,
              reason: capability.decisionReason,
          }
    const resolvedOptions: SyncOptions = { ...options, sourceIsDirectory }
    const capabilityDuration = Date.now() - capabilityStartedAt
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
            ? await syncWithRsync(alias, localPath, remotePath, direction, resolvedOptions, capability)
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
    capability: ExternalTransferCapability
): Promise<SyncResult> {
    const checkCommand = os.platform() === 'win32' ? 'where' : 'which'
    const checkResult = await runLocalProcess(checkCommand, ['rsync'], options.preflightTimeout ?? 10_000)
    if (checkResult.status !== 0) {
        const fallback = await syncWithSftpWithTimeout(alias, localPath, remotePath, direction, options)
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
    const sshOptions = [
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
    if (capability.keyPath) {
        sshOptions.push('-i', capability.keyPath)
    }
    const destination = `${capability.username}@${capability.host}`
    const connectStartedAt = Date.now()
    const connectResult = await runLocalProcess('ssh', [...sshOptions, destination, 'true'], connectTimeout)
    const connectDuration = Date.now() - connectStartedAt
    if (connectResult.error || connectResult.status !== 0) {
        const fallback = await syncWithSftpWithTimeout(alias, localPath, remotePath, direction, options)
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

    const sshCmd = ['ssh', ...sshOptions].map(quoteRsyncSshArg).join(' ')
    const rsyncLocalPath =
        options.sourceIsDirectory && direction === 'upload' && !localPath.endsWith(path.sep)
            ? `${localPath}${path.sep}`
            : localPath
    const rsyncRemotePath =
        options.sourceIsDirectory && direction === 'download' && !remotePath.endsWith('/')
            ? `${remotePath}/`
            : remotePath
    // remoteSpec 作为单独 argv 元素，不经 shell 解析
    const remoteSpec = `${destination}:${rsyncRemotePath}`
    // 在 path 参数前插 `--`，明确剩余为路径而非选项（双重保险）
    const rsyncArgs =
        direction === 'upload'
            ? [...args, '-e', sshCmd, '--', rsyncLocalPath, remoteSpec]
            : [...args, '-e', sshCmd, '--', remoteSpec, localPath]

    try {
        const operationTimeout = options.operationTimeout ?? 600_000
        const result = await runLocalProcess('rsync', rsyncArgs, operationTimeout)

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
            const fallback = await syncWithSftpWithTimeout(alias, localPath, remotePath, direction, options)
            const warning = `rsync 失败原因: ${reason}${stderr ? ` | stderr: ${stderr}` : ''} | 已 fallback 到 SFTP（性能可能较差）`
            console.warn(`[mcp-ssh] ${warning}`)
            return {
                ...fallback,
                connectDuration,
                connectStatus: 'completed',
                fallbackReason: 'rsync_operation_failed',
                output: fallback.output ? `${warning}\n\n${fallback.output}` : warning,
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
        // rsync 启动异常发生在传输进程建立前，可安全改用 SFTP
        const fallback = await syncWithSftpWithTimeout(alias, localPath, remotePath, direction, options)
        const warning = `rsync 异常: ${e instanceof Error ? e.message : String(e)} | 已 fallback 到 SFTP（性能可能较差）`
        console.warn(`[mcp-ssh] ${warning}`)
        return {
            ...fallback,
            connectDuration,
            connectStatus: 'completed',
            fallbackReason: 'rsync_execution_error',
            output: fallback.output ? `${warning}\n\n${fallback.output}` : warning,
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

    merge(result: DirectoryTransferResult): void {
        this.result.fileCount += result.fileCount
        this.result.totalSize += result.totalSize
        this.result.skippedSymlinks += result.skippedSymlinks
        this.result.skippedUnsupported += result.skippedUnsupported
        for (const itemPath of result.unsupportedSamples) {
            if (this.result.unsupportedSamples.length < 10) {
                this.result.unsupportedSamples.push(itemPath)
            }
        }
        this.result.added += result.added
        this.result.updated += result.updated
        this.result.failed += result.failed
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
        warnings.push(`skipped ${skippedSymlinks} symlink(s) (set followSymlinks=true to traverse)`)
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

function hashLocalFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256')
        const stream = fs.createReadStream(filePath)
        stream.on('data', (chunk) => hash.update(chunk))
        stream.on('error', reject)
        stream.on('end', () => resolve(hash.digest('hex')))
    })
}

async function hashRemoteFile(
    alias: string,
    remotePath: string
): Promise<{
    status: 'available' | 'error'
    digest?: string
    exitCode?: number
    failureKind?: string
    retryable: boolean
    error?: string
}> {
    const result = await sessionManager.exec(alias, `sha256sum ${escapeShellArg(remotePath)} | awk '{print $1}'`, {
        timeout: 30000,
        useLoginUser: true,
        maxOutputSize: 4096,
    })
    if (!result.success) {
        return {
            status: 'error',
            exitCode: result.exitCode,
            failureKind: result.failureKind,
            retryable: result.failureKind !== 'remote_command',
            error: result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`,
        }
    }
    const digest = result.stdout.trim().split(/\s+/)[0]
    if (!/^[a-fA-F0-9]{64}$/.test(digest)) {
        return {
            status: 'error',
            exitCode: result.exitCode,
            failureKind: result.failureKind,
            retryable: false,
            error: 'remote SHA-256 command returned an invalid digest',
        }
    }
    return { status: 'available', digest, retryable: false }
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
            exitCode: remoteHash.exitCode,
            failureKind: remoteHash.failureKind,
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

async function resolveSftpUploadFileTarget(alias: string, localPath: string, remotePath: string): Promise<string> {
    if (remotePath.endsWith('/')) {
        return path.posix.join(remotePath, path.basename(localPath))
    }
    try {
        const info = await getFileInfo(alias, remotePath)
        if (info.isDirectory) {
            return path.posix.join(remotePath, path.basename(localPath))
        }
    } catch (error) {
        if (!isSftpMissingError(error)) {
            throw error
        }
        // Missing remote targets are handled by uploadFile below.
    }
    return remotePath
}

function resolveSftpDownloadFileTarget(remotePath: string, localPath: string): string {
    if (localPath.endsWith(path.sep)) {
        fs.mkdirSync(localPath, { recursive: true })
        return path.join(localPath, path.posix.basename(remotePath))
    }
    if (fs.existsSync(localPath) && fs.statSync(localPath).isDirectory()) {
        return path.join(localPath, path.posix.basename(remotePath))
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
    const operation = syncWithSftp(alias, localPath, remotePath, direction, {
        ...options,
        signal: controller.signal,
    })
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<SyncResult>((resolve) => {
        timer = setTimeout(() => {
            controller.abort(new SftpOperationTimeoutError(timeout))
            resolve({
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
    options: SyncOptions
): Promise<SyncResult> {
    throwIfAborted(options.signal)
    const warnings: string[] = []
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
                throw new Error(
                    'recursive=false is not supported for directory sources; use a file source or enable recursion'
                )
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
                    options.signal
                )
                return buildDirectorySyncResult(result, warnings)
            }
            const targetRemotePath = await resolveSftpUploadFileTarget(alias, localPath, remotePath)
            const existed = await remoteExists(alias, targetRemotePath)
            const { size } = await uploadFile(
                alias,
                localPath,
                targetRemotePath,
                undefined,
                undefined,
                undefined,
                options.signal
            )
            return {
                ...buildSyncResult(1, size, warnings, 0, { added: existed ? 0 : 1, updated: existed ? 1 : 0 }),
                verification: await buildSingleFileVerification(alias, localPath, targetRemotePath, 'upload'),
            }
        }

        // download
        const info = await getFileInfo(alias, remotePath)
        if (info.isDirectory && options.recursive === false) {
            throw new Error(
                'recursive=false is not supported for directory sources; use a file source or enable recursion'
            )
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
                options.signal
            )
            return buildDirectorySyncResult(result, warnings)
        }
        const targetLocalPath = resolveSftpDownloadFileTarget(remotePath, localPath)
        const existed = fs.existsSync(targetLocalPath)
        const { size } = await downloadFile(alias, remotePath, targetLocalPath, undefined, undefined, options.signal)
        return {
            ...buildSyncResult(1, size, warnings, 0, { added: existed ? 0 : 1, updated: existed ? 1 : 0 }),
            verification: await buildSingleFileVerification(alias, targetLocalPath, remotePath, 'download'),
        }
    } catch (err) {
        if (err instanceof SftpOperationTimeoutError) {
            return {
                success: false,
                method: 'sftp',
                operationStatus: 'unknown',
                timedOut: true,
                retryable: true,
                stats: { added: 0, updated: 0, deleted: 0, skipped: 0, failed: 1 },
                output: err.message,
            }
        }
        return {
            success: false,
            method: 'sftp',
            operationStatus: 'failed',
            stats: { added: 0, updated: 0, deleted: 0, skipped: 0, failed: 1 },
            output: err instanceof Error ? err.message : String(err),
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
    relativeBase: string = ''
): Promise<DirectoryTransferResult> {
    throwIfAborted(signal)
    const accumulator = new DirectoryTransferAccumulator()

    recordSftpDirectory(traversal, depth, localPath)
    const ownSftp = !sharedSftp
    const sftp = sharedSftp ?? (await sessionManager.getSftp(alias))
    const activeDirectories = (traversal.activeDirectories ??= new Set())
    const realPath = fs.realpathSync(localPath)
    if (activeDirectories.has(realPath)) {
        accumulator.addSkippedSymlink()
        if (ownSftp) {
            sftp.end()
        }
        return accumulator.toResult()
    }
    activeDirectories.add(realPath)

    try {
        await mkdir(alias, remotePath, true)
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
                console.warn(`[ssh_sync] skipping symlink: ${itemLocalPath}`)
                accumulator.addSkippedSymlink()
                continue
            }
            if (stats.isDirectory()) {
                subDirItems.push(item)
            } else if (stats.isFile()) {
                recordSftpFile(traversal, stats.size, depth, itemLocalPath)
                fileItems.push({ name: item, stats })
            } else {
                accumulator.addSkippedUnsupported(itemRelativePath)
            }
        }

        // 文件并发上传
        await runWithConcurrency(fileItems, SFTP_PARALLEL_LIMIT, async ({ name, stats }) => {
            const itemLocalPath = path.join(localPath, name)
            const itemRemotePath = path.posix.join(remotePath, name)
            const existed = await sftpExists(sftp, itemRemotePath)
            try {
                await uploadFile(alias, itemLocalPath, itemRemotePath, undefined, sftp, undefined, signal)
                accumulator.addFile(stats.size, existed)
            } catch (error) {
                accumulator.addFailed()
                throw error
            }
        })

        // 子目录串行递归
        for (const item of subDirItems) {
            const itemLocalPath = path.join(localPath, item)
            const itemRemotePath = path.posix.join(remotePath, item)
            const result = await uploadDirectory(
                alias,
                itemLocalPath,
                itemRemotePath,
                exclude,
                sftp,
                followSymlinks,
                traversal,
                depth + 1,
                signal,
                relativeBase ? `${relativeBase}/${item}` : item
            )
            accumulator.merge(result)
        }
    } finally {
        activeDirectories.delete(realPath)
        if (ownSftp) {
            sftp.end()
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
    relativeBase: string = ''
): Promise<DirectoryTransferResult> {
    throwIfAborted(signal)
    const accumulator = new DirectoryTransferAccumulator()

    recordSftpDirectory(traversal, depth, remotePath)
    const ownSftp = !sharedSftp
    const sftp = sharedSftp ?? (await sessionManager.getSftp(alias))

    try {
        if (!fs.existsSync(localPath)) {
            fs.mkdirSync(localPath, { recursive: true })
        }

        const items = await listDir(alias, remotePath, true, sftp)
        throwIfAborted(signal)
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
            const result = await downloadDirectory(
                alias,
                item.path,
                itemLocalPath,
                exclude,
                sftp,
                traversal,
                depth + 1,
                signal,
                relativeBase ? `${relativeBase}/${item.name}` : item.name
            )
            accumulator.merge(result)
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

/**
 * 格式化权限字符串
 */
function formatPermissions(mode: number): string {
    const fileType = mode & S_IFMT
    const type = fileType === S_IFDIR ? 'd' : fileType === S_IFLNK ? 'l' : fileType === S_IFREG ? '-' : '?'

    const perms = [
        mode & 0o400 ? 'r' : '-',
        mode & 0o200 ? 'w' : '-',
        mode & 0o100 ? 'x' : '-',
        mode & 0o040 ? 'r' : '-',
        mode & 0o020 ? 'w' : '-',
        mode & 0o010 ? 'x' : '-',
        mode & 0o004 ? 'r' : '-',
        mode & 0o002 ? 'w' : '-',
        mode & 0o001 ? 'x' : '-',
    ]

    return type + perms.join('')
}
