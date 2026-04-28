/**
 * SSH File Operations - 文件操作
 */

import { execSync, spawnSync } from 'child_process'
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
const rsyncCache = new Map<string, { value: boolean; expiresAt: number }>()

/** 由 SessionManager.disconnect 调用,防止 alias 重连后读到旧主机的判断 */
export function clearRsyncCache(alias?: string): void {
    if (alias === undefined) {
        rsyncCache.clear()
    } else {
        rsyncCache.delete(alias)
    }
}

/** SFTP 并发上限,避免单 SSH session 上太多 channel */
const SFTP_PARALLEL_LIMIT = Number(process.env.SSH_MCP_SFTP_PARALLEL) || 8

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
function validateLocalPathAgainstAllowList(localPath: string): void {
    const allowEnv = process.env.SSH_MCP_FILE_OPS_ALLOW_DIRS
    if (!allowEnv) {
        return
    }
    const allowDirs = allowEnv
        .split(path.delimiter)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
    if (allowDirs.length === 0) {
        return
    }
    let resolvedLocal: string
    try {
        // 路径不存在时,向上找到第一个存在的祖先 realpathSync 后再拼接剩余
        resolvedLocal = resolvePathOrAncestor(localPath)
    } catch (e) {
        throw new Error(`无法解析路径 ${localPath}: ${e instanceof Error ? e.message : String(e)}`)
    }
    const inAllowList = allowDirs.some((dir) => {
        try {
            const resolvedDir = fs.realpathSync(dir)
            const rel = path.relative(resolvedDir, resolvedLocal)
            return !rel.startsWith('..') && !path.isAbsolute(rel)
        } catch {
            return false
        }
    })
    if (!inAllowList) {
        throw new Error(
            `localPath "${localPath}" 不在 SSH_MCP_FILE_OPS_ALLOW_DIRS 白名单内（白名单: ${allowDirs.join(', ')}）`
        )
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
        throw new Error(`Local file not found: ${localPath}`)
    }

    // 用 lstat 拒绝顶层 symlink，与 ssh_sync 顶层 followSymlinks=false 行为一致；
    // 单文件接口不引入 followSymlinks 选项，需走 symlink 请用 ssh_sync
    const lstats = fs.lstatSync(localPath)
    if (lstats.isSymbolicLink()) {
        throw new Error(
            `Refusing to upload symlink at top level: ${localPath} (use ssh_sync with followSymlinks=true to traverse)`
        )
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

/**
 * 读取远程文件内容
 */
export async function readFile(
    alias: string,
    remotePath: string,
    maxBytes: number = 1024 * 1024 // 默认最大 1MB
): Promise<{ content: string; size: number; truncated: boolean }> {
    const sftp = await sessionManager.getSftp(alias)
    const actualSize = (await sftpStat(sftp, remotePath)).size
    const truncated = actualSize > maxBytes

    // 处理空文件
    if (actualSize === 0) {
        sftp.end()
        return { content: '', size: 0, truncated: false }
    }

    const readSize = Math.min(actualSize, maxBytes)

    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []

        const readStream = sftp.createReadStream(remotePath, {
            start: 0,
            end: readSize - 1,
        })

        readStream.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
        })

        readStream.on('end', () => {
            sftp.end()
            const content = Buffer.concat(chunks).toString('utf-8')
            resolve({
                content,
                size: actualSize,
                truncated,
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
    localPath = expandTilde(localPath)
    validateLocalPathAgainstAllowList(localPath)
    const hasRsync = await checkRsync(alias)

    if (hasRsync) {
        return syncWithRsync(alias, localPath, remotePath, direction, options)
    }
    return syncWithSftp(alias, localPath, remotePath, direction, options)
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
    // 检查本地是否有 rsync
    let hasLocalRsync = false
    try {
        const cmd = os.platform() === 'win32' ? 'where rsync' : 'which rsync'
        execSync(cmd, { stdio: 'pipe' })
        hasLocalRsync = true
    } catch {
        // rsync 不可用，由 hasLocalRsync 标记处理
    }

    if (!hasLocalRsync) {
        // 本地没有 rsync，回退到 SFTP
        return syncWithSftp(alias, localPath, remotePath, direction, options)
    }

    // 获取会话信息以构建 rsync 命令
    const sessions = sessionManager.listSessions()
    const sessionInfo = sessions.find((s) => s.alias === alias)
    if (!sessionInfo) {
        throw new Error(`Session '${alias}' not found`)
    }

    // 构建 rsync 参数
    const args: string[] = ['-avz', '--progress']

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
        throw new Error(`Invalid path: must not start with '-' (localPath=${localPath}, remotePath=${remotePath})`)
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
    const sshCmd = `ssh -p ${sessionInfo.port} -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ProxyCommand=none`
    // remoteSpec 作为单独 argv 元素，不经 shell 解析
    const remoteSpec = `${sessionInfo.username}@${sessionInfo.host}:${remotePath}`
    // 在 path 参数前插 `--`，明确剩余为路径而非选项（双重保险）
    const rsyncArgs =
        direction === 'upload'
            ? [...args, '-e', sshCmd, '--', localPath, remoteSpec]
            : [...args, '-e', sshCmd, '--', remoteSpec, localPath]

    try {
        const result = spawnSync('rsync', rsyncArgs, {
            encoding: 'utf-8',
            timeout: 600000,
            stdio: ['pipe', 'pipe', 'pipe'],
        })

        if (result.error || result.status !== 0) {
            const stderr = (result.stderr ?? '').trim()
            const reason = result.error?.message ?? `exit code ${result.status}`
            const fallback = await syncWithSftp(alias, localPath, remotePath, direction, options)
            const warning = `rsync 失败原因: ${reason}${stderr ? ` | stderr: ${stderr}` : ''} | 已 fallback 到 SFTP（性能可能较差）`
            console.warn(`[mcp-ssh] ${warning}`)
            return {
                ...fallback,
                output: fallback.output ? `${warning}\n\n${fallback.output}` : warning,
            }
        }

        const output = result.stdout ?? ''
        // 解析 rsync 输出统计文件数
        const lines = output.split('\n')
        let filesTransferred = 0
        for (const line of lines) {
            if (
                line.trim() &&
                !line.startsWith('sending') &&
                !line.startsWith('receiving') &&
                !line.startsWith('total')
            ) {
                filesTransferred++
            }
        }

        return {
            success: true,
            method: 'rsync',
            filesTransferred,
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
type SyncResult = {
    success: boolean
    method: 'rsync' | 'sftp'
    filesTransferred?: number
    bytesTransferred?: number
    skippedSymlinks?: number
    output?: string
}

function buildSyncResult(
    fileCount: number,
    totalSize: number,
    warnings: string[],
    skippedSymlinks: number = 0
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
        output: warnings.length ? `Warning: ${warnings.join('; ')}` : undefined,
    }
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
        return {
            success: true,
            method: 'sftp',
            output:
                'Dry run mode: would transfer files via SFTP' +
                (warnings.length ? `. Warning: ${warnings.join('; ')}` : ''),
        }
    }

    try {
        if (direction === 'upload') {
            const stats = options.followSymlinks ? fs.statSync(localPath) : fs.lstatSync(localPath)
            if (stats.isSymbolicLink()) {
                throw new Error(
                    `Refusing to upload symlink at top level: ${localPath} (set followSymlinks=true to traverse)`
                )
            }
            if (stats.isDirectory() && options.recursive !== false) {
                const { fileCount, totalSize, skippedSymlinks } = await uploadDirectory(
                    alias,
                    localPath,
                    remotePath,
                    options.exclude,
                    undefined,
                    options.followSymlinks ?? false
                )
                return buildSyncResult(fileCount, totalSize, warnings, skippedSymlinks)
            }
            const { size } = await uploadFile(alias, localPath, remotePath)
            return buildSyncResult(1, size, warnings)
        }

        // download
        const info = await getFileInfo(alias, remotePath)
        if (info.isDirectory && options.recursive !== false) {
            const { fileCount, totalSize, skippedSymlinks } = await downloadDirectory(
                alias,
                remotePath,
                localPath,
                options.exclude
            )
            return buildSyncResult(fileCount, totalSize, warnings, skippedSymlinks)
        }
        const { size } = await downloadFile(alias, remotePath, localPath)
        return buildSyncResult(1, size, warnings)
    } catch (err) {
        return {
            success: false,
            method: 'sftp',
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
    followSymlinks: boolean = false
): Promise<{ fileCount: number; totalSize: number; skippedSymlinks: number }> {
    let fileCount = 0
    let totalSize = 0
    let skippedSymlinks = 0

    // 顶层调用时开启一个 SFTP 会话，递归调用复用
    const ownSftp = !sharedSftp
    const sftp = sharedSftp ?? (await sessionManager.getSftp(alias))

    try {
        // 确保远程目录存在
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
                skippedSymlinks++
                continue
            }
            if (stats.isDirectory()) {
                subDirItems.push(item)
            } else if (stats.isFile()) {
                fileItems.push({ name: item, stats })
            }
        }

        // 文件并发上传
        await runWithConcurrency(fileItems, SFTP_PARALLEL_LIMIT, async ({ name, stats }) => {
            const itemLocalPath = path.join(localPath, name)
            const itemRemotePath = path.posix.join(remotePath, name)
            await uploadFile(alias, itemLocalPath, itemRemotePath, undefined, sftp)
            fileCount++
            totalSize += stats.size
        })

        // 子目录串行递归
        for (const item of subDirItems) {
            const itemLocalPath = path.join(localPath, item)
            const itemRemotePath = path.posix.join(remotePath, item)
            const result = await uploadDirectory(alias, itemLocalPath, itemRemotePath, exclude, sftp, followSymlinks)
            fileCount += result.fileCount
            totalSize += result.totalSize
            skippedSymlinks += result.skippedSymlinks
        }
    } finally {
        if (ownSftp) {
            sftp.end()
        }
    }

    return { fileCount, totalSize, skippedSymlinks }
}

/**
 * 递归下载目录
 */
async function downloadDirectory(
    alias: string,
    remotePath: string,
    localPath: string,
    exclude?: string[],
    sharedSftp?: SFTPWrapper
): Promise<{ fileCount: number; totalSize: number; skippedSymlinks: number }> {
    let fileCount = 0
    let totalSize = 0
    let skippedSymlinks = 0

    // 顶层调用时开启一个 SFTP 会话，递归调用复用
    const ownSftp = !sharedSftp
    const sftp = sharedSftp ?? (await sessionManager.getSftp(alias))

    try {
        // 确保本地目录存在
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
                fileItems.push(item)
            } else if (item.isSymlink) {
                symlinkItems.push(item)
            } else {
                console.warn(`[ssh_sync] skipping unknown item type: ${item.path}`)
            }
        }

        await runWithConcurrency(fileItems, SFTP_PARALLEL_LIMIT, async (item) => {
            const itemLocalPath = path.join(localPath, item.name)
            await downloadFile(alias, item.path, itemLocalPath, undefined, sftp)
            fileCount++
            totalSize += item.size
        })

        for (const item of dirItems) {
            const itemLocalPath = path.join(localPath, item.name)
            const result = await downloadDirectory(alias, item.path, itemLocalPath, exclude, sftp)
            fileCount += result.fileCount
            totalSize += result.totalSize
            skippedSymlinks += result.skippedSymlinks
        }

        for (const item of symlinkItems) {
            console.warn(`[ssh_sync] skipping remote symlink: ${item.path}`)
            skippedSymlinks++
        }
    } finally {
        if (ownSftp) {
            sftp.end()
        }
    }

    return { fileCount, totalSize, skippedSymlinks }
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
