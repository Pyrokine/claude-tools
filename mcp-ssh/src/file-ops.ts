/**
 * SSH File Operations - 文件操作
 */

import { spawn } from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SFTPWrapper, Stats } from 'ssh2'
import { sessionManager } from './session-manager.js'
import { escapeShellArg, expandTilde } from './tools/utils.js'
import { FileInfo, TransferProgress } from './types.js'

// 文件类型 mode 常量
const S_IFMT = 0o170000 // 文件类型位掩码
const S_IFDIR = 0o40000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

// rsync 可用性缓存（per alias，连接存续期内不变,disconnect 时由 SessionManager 主动清理）
const RSYNC_CACHE_TTL_MS = 5 * 60_000
const LOCAL_PROCESS_OUTPUT_LIMIT = 200_000
const rsyncCache = new Map<string, { value: boolean; expiresAt: number }>()

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

export function probeLocalPath(localPath: string) {
    const expanded = expandTilde(localPath)
    const resolvedPath = resolvePathOrAncestor(expanded)
    const allowList = getAllowListStatus(expanded)
    if (!fs.existsSync(expanded)) {
        return { exists: false, inputPath: localPath, expandedPath: expanded, resolvedPath, allowList }
    }
    const stats = fs.lstatSync(expanded)
    return {
        exists: true,
        inputPath: localPath,
        expandedPath: expanded,
        resolvedPath,
        size: stats.size,
        mode: (stats.mode & 0o777).toString(8).padStart(4, '0'),
        mtimeMs: Math.round(stats.mtimeMs),
        isSymlink: stats.isSymbolicLink(),
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

async function sftpExists(sftp: SFTPWrapper, remotePath: string): Promise<boolean> {
    try {
        await sftpStat(sftp, remotePath)
        return true
    } catch {
        return false
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
    closeSftp: boolean = true
): Promise<{ success: boolean; size: number }> {
    return new Promise((resolve, reject) => {
        let settled = false

        const cleanup = (err?: Error) => {
            if (settled) {
                return
            }
            settled = true
            // 先解管道并强制销毁两端，避免错误后流仍持有 sftp 资源
            try {
                readStream.unpipe(writeStream as NodeJS.WritableStream)
            } catch {
                /* ignore */
            }
            try {
                ;(readStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
            } catch {
                /* ignore */
            }
            try {
                ;(writeStream as NodeJS.WritableStream & { destroy?: () => void }).destroy?.()
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
                if (closeSftp) {
                    sftp.end()
                }
                resolve({ success: true, size: totalSize })
            }
        })

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
    sharedSftp?: SFTPWrapper
): Promise<{ success: boolean; size: number }> {
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

    return pipeWithProgress(
        fs.createReadStream(localPath),
        sftp.createWriteStream(remotePath),
        sftp,
        totalSize,
        onProgress,
        !sharedSftp
    )
}

/**
 * 下载文件
 */
export async function downloadFile(
    alias: string,
    remotePath: string,
    localPath: string,
    onProgress?: (progress: TransferProgress) => void,
    sharedSftp?: SFTPWrapper
): Promise<{ success: boolean; size: number }> {
    localPath = expandTilde(localPath)
    validateLocalPathAgainstAllowList(localPath)
    const sftp = sharedSftp ?? (await sessionManager.getSftp(alias))
    const totalSize = (await sftpStat(sftp, remotePath)).size

    // 确保本地目录存在
    const localDir = path.dirname(localPath)
    if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true })
    }

    return pipeWithProgress(
        sftp.createReadStream(remotePath),
        fs.createWriteStream(localPath),
        sftp,
        totalSize,
        onProgress,
        !sharedSftp
    )
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
    remaining_bytes: number
    sample_kind: ReadFileSampleKind
    truncated: boolean
    line_start?: number
    line_end?: number
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

async function readLineRange(
    alias: string,
    remotePath: string,
    totalSize: number,
    maxBytes: number,
    lineRange: string
): Promise<ReadFileResult> {
    const { start, end } = parseLineRange(lineRange)
    const command = [
        `awk 'NR>=${start} && NR<=${end} { print } NR>${end} { exit }'`,
        escapeShellArg(remotePath),
        '|',
        'head',
        '-c',
        String(maxBytes),
    ].join(' ')
    const result = await sessionManager.exec(alias, command, {
        timeout: 30000,
        useLoginUser: true,
        maxOutputSize: maxBytes + 4096,
    })
    if (!result.success && result.stderr.trim().length > 0) {
        throw new Error(result.stderr.trim())
    }
    const readBytes = Buffer.byteLength(result.stdout, 'utf-8')
    return {
        content: result.stdout,
        size: totalSize,
        total_size: totalSize,
        read_offset: 0,
        read_bytes: readBytes,
        remaining_bytes: Math.max(0, totalSize - readBytes),
        sample_kind: 'line_range',
        truncated: readBytes >= maxBytes,
        line_start: start,
        line_end: end,
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
    const actualSize = (await sftpStat(sftp, remotePath)).size

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

    return new Promise((resolve, reject) => {
        const writeStream = sftp.createWriteStream(remotePath, { flags })

        writeStream.on('close', () => {
            sftp.end()
            resolve({ success: true, size: content.length })
        })

        writeStream.on('error', (err: Error) => {
            sftp.end()
            reject(err)
        })

        writeStream.write(content)
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
        return result.exitCode === 0
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
export async function checkRsync(alias: string): Promise<boolean> {
    const cached = rsyncCache.get(alias)
    if (cached !== undefined && cached.expiresAt > Date.now()) {
        return cached.value
    }
    try {
        const result = await sessionManager.exec(alias, 'which rsync')
        const available = result.exitCode === 0 && result.stdout.trim().length > 0
        rsyncCache.set(alias, { value: available, expiresAt: Date.now() + RSYNC_CACHE_TTL_MS })
        return available
    } catch {
        rsyncCache.set(alias, { value: false, expiresAt: Date.now() + RSYNC_CACHE_TTL_MS })
        return false
    }
}

/**
 * 智能文件同步（优先使用 rsync）
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
    options: {
        delete?: boolean // 删除目标端多余文件
        dryRun?: boolean // 仅显示将执行的操作
        exclude?: string[] // 排除模式
        recursive?: boolean // 递归同步目录
        followSymlinks?: boolean // upload 时是否跟随 symlink，默认 false（跳过并 warn）
    } = {}
): Promise<SyncResult> {
    const startedAt = Date.now()
    localPath = expandTilde(localPath)
    validateLocalPathAgainstAllowList(localPath)
    const hasRsync = await checkRsync(alias)
    const result = hasRsync
        ? await syncWithRsync(alias, localPath, remotePath, direction, options)
        : await syncWithSftp(alias, localPath, remotePath, direction, options)

    return {
        ...result,
        transport: result.method,
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
    options: {
        delete?: boolean
        dryRun?: boolean
        exclude?: string[]
        recursive?: boolean
        followSymlinks?: boolean
    }
): Promise<SyncResult> {
    const checkCommand = os.platform() === 'win32' ? 'where' : 'which'
    const checkResult = await runLocalProcess(checkCommand, ['rsync'], 10_000)
    if (checkResult.status !== 0) {
        // 本地没有 rsync，回退到 SFTP
        return syncWithSftp(alias, localPath, remotePath, direction, options)
    }

    // 获取会话信息以构建 rsync 命令
    const sessions = sessionManager.listSessions()
    const sessionInfo = sessions.find((s) => s.alias === alias)
    if (!sessionInfo) {
        throw new Error(`Session '${alias}' not found`)
    }

    // 密码认证无法透传给 rsync 的 ssh 子进程，直接走 SFTP
    if (sessionInfo.authMethod === 'password') {
        return syncWithSftp(alias, localPath, remotePath, direction, options)
    }

    // 构建 rsync 参数
    const args: string[] = ['-avz', '--itemize-changes', '--stats']

    if (options.delete) {
        args.push('--delete')
    }
    if (options.dryRun) {
        args.push('--dry-run')
    }
    if (options.recursive === false) {
        args.push('--dirs') // 不递归，只传输目录本身
    }
    if (options.exclude) {
        for (const pattern of options.exclude) {
            args.push(`--exclude=${pattern}`)
        }
    }
    if (options.followSymlinks) {
        // -L / --copy-links: 跟随 symlink，上传链接目标内容（与 SFTP 路径 followSymlinks=true 行为对齐）
        // 默认不传则用 rsync -a 自带的 -l：保留 symlink 本身，不上传目标内容
        args.push('-L')
    }

    // path 安全校验：以 `-` 起始的路径会被 rsync 当成选项解析（即便有 `--` 兜底，也避免 OS/rsync 实现差异）
    if (localPath.startsWith('-') || remotePath.startsWith('-')) {
        throw new Error('Invalid path: localPath and remotePath must not start with -')
    }

    // username/host 安全校验：拒绝 shell 元字符与 ssh 选项注入
    const sshIdentifierAllowed = /^[a-zA-Z0-9.:_-]+$/
    if (!sshIdentifierAllowed.test(sessionInfo.username)) {
        throw new Error(`Invalid username for rsync: "${sessionInfo.username}" 含非法字符`)
    }
    if (!sshIdentifierAllowed.test(sessionInfo.host)) {
        throw new Error(`Invalid host for rsync: "${sessionInfo.host}" 含非法字符`)
    }

    // 构建 rsync argv（不用 shell=true，避免 username/host 含 shell 元字符时注入）
    // ProxyCommand=none 显式禁用 ssh-config 中可能定义的 ProxyCommand,防止外部命令注入
    const sshParts = [
        'ssh',
        '-p',
        String(sessionInfo.port),
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'BatchMode=yes',
        '-o',
        'ProxyCommand=none',
    ]
    if (sessionInfo.keyPath) {
        sshParts.push('-i', sessionInfo.keyPath)
    }
    const sshCmd = sshParts.map(quoteRsyncSshArg).join(' ')
    // remoteSpec 作为单独 argv 元素，不经 shell 解析
    const remoteSpec = `${sessionInfo.username}@${sessionInfo.host}:${remotePath}`
    // 在 path 参数前插 `--`，明确剩余为路径而非选项（双重保险）
    const rsyncArgs =
        direction === 'upload'
            ? [...args, '-e', sshCmd, '--', localPath, remoteSpec]
            : [...args, '-e', sshCmd, '--', remoteSpec, localPath]

    try {
        const result = await runLocalProcess('rsync', rsyncArgs, 600000)

        if (result.error || result.status !== 0) {
            const stderr = result.stderr.trim()
            const reason = result.timedOut
                ? 'timed out after 600000ms'
                : (result.error?.message ?? `exit code ${result.status}`)
            const fallback = await syncWithSftp(alias, localPath, remotePath, direction, options)
            const warning = `rsync 失败原因: ${reason}${stderr ? ` | stderr: ${stderr}` : ''} | 已 fallback 到 SFTP（性能可能较差）`
            console.warn(`[mcp-ssh] ${warning}`)
            return {
                ...fallback,
                output: fallback.output ? `${warning}\n\n${fallback.output}` : warning,
            }
        }

        const output = result.stdout
        const stats = parseRsyncStats(output)
        const filesTransferred = stats.added + stats.updated

        return {
            success: true,
            method: 'rsync',
            filesTransferred,
            stats,
            commandSummary: {
                tool: 'rsync',
                dryRun: options.dryRun === true,
                delete: options.delete === true,
                recursive: options.recursive !== false,
                followSymlinks: options.followSymlinks === true,
                excludeCount: options.exclude?.length ?? 0,
                usedKeyPath: Boolean(sessionInfo.keyPath),
            },
            output,
        }
    } catch (e) {
        // rsync 执行异常，回退到 SFTP（保留原因供调用方追溯）
        const fallback = await syncWithSftp(alias, localPath, remotePath, direction, options)
        const warning = `rsync 异常: ${e instanceof Error ? e.message : String(e)} | 已 fallback 到 SFTP（性能可能较差）`
        console.warn(`[mcp-ssh] ${warning}`)
        return {
            ...fallback,
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
    added: number
    updated: number
    failed: number
}

class DirectoryTransferAccumulator {
    private readonly result: DirectoryTransferResult = {
        fileCount: 0,
        totalSize: 0,
        skippedSymlinks: 0,
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

    addFailed(): void {
        this.result.failed++
    }

    merge(result: DirectoryTransferResult): void {
        this.result.fileCount += result.fileCount
        this.result.totalSize += result.totalSize
        this.result.skippedSymlinks += result.skippedSymlinks
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
    direction?: 'upload' | 'download'
    dryRun?: boolean
    duration?: number
    filesTransferred?: number
    bytesTransferred?: number
    skippedSymlinks?: number
    stats?: SyncStats
    verification?: Record<string, unknown>
    commandSummary?: Record<string, unknown>
    output?: string
}

function buildDirectorySyncResult(result: DirectoryTransferResult, warnings: string[]): SyncResult {
    return buildSyncResult(result.fileCount, result.totalSize, warnings, result.skippedSymlinks, {
        added: result.added,
        updated: result.updated,
        failed: result.failed,
    })
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

async function hashRemoteFile(alias: string, remotePath: string): Promise<string | undefined> {
    const result = await sessionManager.exec(alias, `sha256sum ${escapeShellArg(remotePath)} | awk '{print $1}'`, {
        timeout: 30000,
        useLoginUser: true,
        maxOutputSize: 4096,
    })
    if (!result.success) {
        return undefined
    }
    const digest = result.stdout.trim().split(/\s+/)[0]
    return /^[a-fA-F0-9]{64}$/.test(digest) ? digest : undefined
}

async function buildSingleFileVerification(
    alias: string,
    localPath: string,
    remotePath: string,
    direction: 'upload' | 'download'
): Promise<Record<string, unknown>> {
    const localStats = fs.statSync(localPath)
    const remoteInfo = await getFileInfo(alias, remotePath)
    const [localSha256, remoteSha256] = await Promise.all([hashLocalFile(localPath), hashRemoteFile(alias, remotePath)])
    return {
        kind: 'single_file',
        direction,
        hashAlgorithm: 'sha256',
        hashMatch: remoteSha256 ? localSha256 === remoteSha256 : undefined,
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
            sha256: remoteSha256,
        },
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
    } catch {
        // Missing remote targets are handled by uploadFile below.
    }
    return remotePath
}

async function syncWithSftp(
    alias: string,
    localPath: string,
    remotePath: string,
    direction: 'upload' | 'download',
    options: {
        delete?: boolean
        dryRun?: boolean
        exclude?: string[]
        recursive?: boolean
        followSymlinks?: boolean
    }
): Promise<SyncResult> {
    const warnings: string[] = []
    if (options.delete) {
        warnings.push('delete option is not supported in SFTP mode (requires rsync)')
    }

    if (options.dryRun) {
        const localExists = fs.existsSync(localPath)
        const localStats = localExists ? fs.lstatSync(localPath) : undefined
        const remoteTargetExists = await remoteExists(alias, remotePath).catch(() => false)
        return {
            success: true,
            method: 'sftp',
            commandSummary: {
                dryRun: true,
                direction,
                recursive: options.recursive !== false,
                followSymlinks: options.followSymlinks === true,
                deleteRequested: options.delete === true,
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
            if (stats.isDirectory() && options.recursive !== false) {
                const result = await uploadDirectory(
                    alias,
                    localPath,
                    remotePath,
                    options.exclude,
                    undefined,
                    options.followSymlinks ?? false,
                    { files: 0, directories: 0, bytes: 0 },
                    0
                )
                return buildDirectorySyncResult(result, warnings)
            }
            const targetRemotePath = await resolveSftpUploadFileTarget(alias, localPath, remotePath)
            const existed = await remoteExists(alias, targetRemotePath)
            const { size } = await uploadFile(alias, localPath, targetRemotePath)
            return {
                ...buildSyncResult(1, size, warnings, 0, { added: existed ? 0 : 1, updated: existed ? 1 : 0 }),
                verification: await buildSingleFileVerification(alias, localPath, targetRemotePath, 'upload'),
            }
        }

        // download
        const info = await getFileInfo(alias, remotePath)
        if (info.isDirectory && options.recursive !== false) {
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
                0
            )
            return buildDirectorySyncResult(result, warnings)
        }
        const existed = fs.existsSync(localPath)
        const { size } = await downloadFile(alias, remotePath, localPath)
        return {
            ...buildSyncResult(1, size, warnings, 0, { added: existed ? 0 : 1, updated: existed ? 1 : 0 }),
            verification: await buildSingleFileVerification(alias, localPath, remotePath, 'download'),
        }
    } catch (err) {
        return {
            success: false,
            method: 'sftp',
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
    depth: number = 0
): Promise<DirectoryTransferResult> {
    const accumulator = new DirectoryTransferAccumulator()

    recordSftpDirectory(traversal, depth, localPath)
    const ownSftp = !sharedSftp
    const sftp = sharedSftp ?? (await sessionManager.getSftp(alias))

    try {
        await mkdir(alias, remotePath, true)

        const items = fs.readdirSync(localPath)
        // 先分类：目录串行（递归会自己并发文件）；文件并发上传，避免单 SSH session 上 channel 过多
        const subDirItems: string[] = []
        const fileItems: { name: string; stats: fs.Stats }[] = []
        for (const item of items) {
            if (exclude && exclude.some((pattern) => matchPattern(item, pattern))) {
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
            }
        }

        // 文件并发上传
        await runWithConcurrency(fileItems, SFTP_PARALLEL_LIMIT, async ({ name, stats }) => {
            const itemLocalPath = path.join(localPath, name)
            const itemRemotePath = path.posix.join(remotePath, name)
            const existed = await sftpExists(sftp, itemRemotePath)
            try {
                await uploadFile(alias, itemLocalPath, itemRemotePath, undefined, sftp)
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
                depth + 1
            )
            accumulator.merge(result)
        }
    } finally {
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
    depth: number = 0
): Promise<DirectoryTransferResult> {
    const accumulator = new DirectoryTransferAccumulator()

    recordSftpDirectory(traversal, depth, remotePath)
    const ownSftp = !sharedSftp
    const sftp = sharedSftp ?? (await sessionManager.getSftp(alias))

    try {
        if (!fs.existsSync(localPath)) {
            fs.mkdirSync(localPath, { recursive: true })
        }

        const items = await listDir(alias, remotePath, true, sftp)
        // 分类：文件并发下载,目录串行递归
        const fileItems: typeof items = []
        const dirItems: typeof items = []
        const symlinkItems: typeof items = []
        for (const item of items) {
            if (exclude && exclude.some((pattern) => matchPattern(item.name, pattern))) {
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
                console.warn(`[ssh_sync] skipping unknown item type: ${item.path}`)
            }
        }

        await runWithConcurrency(fileItems, SFTP_PARALLEL_LIMIT, async (item) => {
            const itemLocalPath = path.join(localPath, item.name)
            const existed = fs.existsSync(itemLocalPath)
            try {
                await downloadFile(alias, item.path, itemLocalPath, undefined, sftp)
                accumulator.addFile(item.size, existed)
            } catch (error) {
                accumulator.addFailed()
                throw error
            }
        })

        for (const item of dirItems) {
            const itemLocalPath = path.join(localPath, item.name)
            const result = await downloadDirectory(alias, item.path, itemLocalPath, exclude, sftp, traversal, depth + 1)
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
 * 简单的模式匹配（支持 * 和 ?）
 */
const matchPatternCache = new Map<string, RegExp>()

function matchPattern(name: string, pattern: string): boolean {
    let regex = matchPatternCache.get(pattern)
    if (!regex) {
        const regexPattern = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 转义特殊字符
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.')
        regex = new RegExp(`^${regexPattern}$`)
        matchPatternCache.set(pattern, regex)
    }
    return regex.test(name)
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
