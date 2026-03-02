/**
 * SSH File Operations - 文件操作
 */

import {execSync} from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import {SFTPWrapper, Stats} from 'ssh2'
import {sessionManager} from './session-manager.js'
import {FileInfo, TransferProgress} from './types.js'

// 文件类型 mode 常量
const S_IFDIR = 0o40000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

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
): Promise<{ success: boolean; size: number }> {
    return new Promise((resolve, reject) => {
        let settled = false

        const cleanup = (err?: Error) => {
            if (settled) {
                return
            }
            settled = true
            sftp.end()
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
                sftp.end()
                resolve({success: true, size: totalSize})
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
): Promise<{ success: boolean; size: number }> {
    if (!fs.existsSync(localPath)) {
        throw new Error(`Local file not found: ${localPath}`)
    }

    const sftp      = await sessionManager.getSftp(alias)
    const totalSize = fs.statSync(localPath).size

    return pipeWithProgress(
        fs.createReadStream(localPath),
        sftp.createWriteStream(remotePath),
        sftp, totalSize, onProgress,
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
): Promise<{ success: boolean; size: number }> {
    const sftp      = await sessionManager.getSftp(alias)
    const totalSize = (await sftpStat(sftp, remotePath)).size

    // 确保本地目录存在
    const localDir = path.dirname(localPath)
    if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, {recursive: true})
    }

    return pipeWithProgress(
        sftp.createReadStream(remotePath),
        fs.createWriteStream(localPath),
        sftp, totalSize, onProgress,
    )
}

/**
 * 读取远程文件内容
 */
export async function readFile(
    alias: string,
    remotePath: string,
    maxBytes: number = 1024 * 1024,  // 默认最大 1MB
): Promise<{ content: string; size: number; truncated: boolean }> {
    const sftp       = await sessionManager.getSftp(alias)
    const actualSize = (await sftpStat(sftp, remotePath)).size
    const truncated  = actualSize > maxBytes

    // 处理空文件
    if (actualSize === 0) {
        sftp.end()
        return {content: '', size: 0, truncated: false}
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
    append: boolean = false,
): Promise<{ success: boolean; size: number }> {
    const sftp  = await sessionManager.getSftp(alias)
    const flags = append ? 'a' : 'w'

    return new Promise((resolve, reject) => {
        const writeStream = sftp.createWriteStream(remotePath, {flags})

        writeStream.on('close', () => {
            sftp.end()
            resolve({success: true, size: content.length})
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
): Promise<FileInfo[]> {
    const sftp = await sessionManager.getSftp(alias)

    return new Promise((resolve, reject) => {
        sftp.readdir(remotePath, (err, list) => {
            if (err) {
                sftp.end()
                reject(err)
                return
            }

            const files: FileInfo[] = list
                .filter((item) => showHidden || !item.filename.startsWith('.'))
                .map((item) => ({
                    name: item.filename,
                    path: path.posix.join(remotePath, item.filename),
                    size: item.attrs.size,
                    isDirectory: (item.attrs.mode & S_IFDIR) !== 0,
                    isFile: (item.attrs.mode & S_IFREG) !== 0,
                    isSymlink: (item.attrs.mode & S_IFLNK) !== 0,
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

            sftp.end()
            resolve(files)
        })
    })
}

/**
 * 获取文件信息
 */
export async function getFileInfo(
    alias: string,
    remotePath: string,
): Promise<FileInfo> {
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
                        isDirectory: (stats.mode & S_IFDIR) !== 0,
                        isFile: (stats.mode & S_IFREG) !== 0,
                        isSymlink: (stats.mode & S_IFLNK) !== 0,
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
export async function mkdir(
    alias: string,
    remotePath: string,
    recursive: boolean = false,
): Promise<boolean> {
    if (recursive) {
        // 通过 exec 实现递归创建
        const result = await sessionManager.exec(alias, `mkdir -p "${remotePath}"`)
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
    try {
        const result = await sessionManager.exec(alias, 'which rsync')
        return result.exitCode === 0 && result.stdout.trim().length > 0
    } catch {
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
        delete?: boolean;       // 删除目标端多余文件
        dryRun?: boolean;       // 仅显示将执行的操作
        exclude?: string[];     // 排除模式
        recursive?: boolean;    // 递归同步目录
    } = {},
): Promise<SyncResult> {
    const hasRsync = await checkRsync(alias)

    if (hasRsync) {
        return syncWithRsync(alias, localPath, remotePath, direction, options)
    }
    return syncWithSftp(alias, localPath, remotePath, direction, options)
}

/**
 * 转义 shell 路径参数
 */
function escapeShellPath(p: string): string {
    return `'${p.replace(/'/g, '\'\\\'\'')}'`
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
        delete?: boolean;
        dryRun?: boolean;
        exclude?: string[];
        recursive?: boolean;
    },
): Promise<SyncResult> {
    // 检查本地是否有 rsync
    let hasLocalRsync = false
    try {
        execSync('which rsync', {stdio: 'pipe'})
        hasLocalRsync = true
    } catch {
    }

    if (!hasLocalRsync) {
        // 本地没有 rsync，回退到 SFTP
        return syncWithSftp(alias, localPath, remotePath, direction, options)
    }

    // 获取会话信息以构建 rsync 命令
    const sessions    = sessionManager.listSessions()
    const sessionInfo = sessions.find(s => s.alias === alias)
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
        args.push('--dirs')  // 不递归，只传输目录本身
    }
    if (options.exclude) {
        for (const pattern of options.exclude) {
            args.push(`--exclude=${escapeShellPath(pattern)}`)
        }
    }

    // 构建 rsync 命令（本地执行）
    // 注意：这需要密钥认证或 ssh-agent，密码认证不支持
    const sshCmd     = `ssh -p ${sessionInfo.port} -o StrictHostKeyChecking=no -o BatchMode=yes`
    const remoteSpec = `${sessionInfo.username}@${sessionInfo.host}:${escapeShellPath(remotePath)}`
    const rsyncCmd   = direction === 'upload'
                       ? `rsync ${args.join(' ')} -e "${sshCmd}" ${escapeShellPath(localPath)} ${remoteSpec}`
                       : `rsync ${args.join(' ')} -e "${sshCmd}" ${remoteSpec} ${escapeShellPath(localPath)}`

    try {
        const result = execSync(rsyncCmd, {
            encoding: 'utf-8',
            timeout: 600000,  // 10 分钟超时
            stdio: ['pipe', 'pipe', 'pipe'],
        })

        // 解析 rsync 输出统计文件数
        const lines          = result.split('\n')
        let filesTransferred = 0
        for (const line of lines) {
            if (line.trim() &&
                !line.startsWith('sending') &&
                !line.startsWith('receiving') &&
                !line.startsWith('total')) {
                filesTransferred++
            }
        }

        return {
            success: true,
            method: 'rsync',
            filesTransferred,
            output: result,
        }
    } catch {
        // rsync 失败（可能是密码认证），回退到 SFTP
        return syncWithSftp(alias, localPath, remotePath, direction, options)
    }
}

/**
 * 使用 SFTP 同步文件
 */
type SyncResult = {
    success: boolean;
    method: 'rsync' | 'sftp';
    filesTransferred?: number;
    bytesTransferred?: number;
    output?: string;
}

function buildSyncResult(
    fileCount: number,
    totalSize: number,
    warnings: string[],
): SyncResult {
    return {
        success: true,
        method: 'sftp',
        filesTransferred: fileCount,
        bytesTransferred: totalSize,
        output: warnings.length ? `Warning: ${warnings.join('; ')}` : undefined,
    }
}

async function syncWithSftp(
    alias: string,
    localPath: string,
    remotePath: string,
    direction: 'upload' | 'download',
    options: {
        delete?: boolean;
        dryRun?: boolean;
        exclude?: string[];
        recursive?: boolean;
    },
): Promise<SyncResult> {
    const warnings: string[] = []
    if (options.delete) {
        warnings.push('delete option is not supported in SFTP mode (requires rsync)')
    }

    if (options.dryRun) {
        return {
            success: true,
            method: 'sftp',
            output: 'Dry run mode: would transfer files via SFTP' +
                    (warnings.length ? `. Warning: ${warnings.join('; ')}` : ''),
        }
    }

    try {
        if (direction === 'upload') {
            const stats = fs.statSync(localPath)
            if (stats.isDirectory() && options.recursive !== false) {
                const {fileCount, totalSize} = await uploadDirectory(alias, localPath, remotePath, options.exclude)
                return buildSyncResult(fileCount, totalSize, warnings)
            }
            const {size} = await uploadFile(alias, localPath, remotePath)
            return buildSyncResult(1, size, warnings)
        }

        // download
        const info = await getFileInfo(alias, remotePath)
        if (info.isDirectory && options.recursive !== false) {
            const {fileCount, totalSize} = await downloadDirectory(alias, remotePath, localPath, options.exclude)
            return buildSyncResult(fileCount, totalSize, warnings)
        }
        const {size} = await downloadFile(alias, remotePath, localPath)
        return buildSyncResult(1, size, warnings)
    } catch (err: any) {
        return {
            success: false,
            method: 'sftp',
            output: err.message,
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
): Promise<{ fileCount: number; totalSize: number }> {
    let fileCount = 0
    let totalSize = 0

    // 确保远程目录存在
    await mkdir(alias, remotePath, true)

    const items = fs.readdirSync(localPath)
    for (const item of items) {
        // 检查排除模式
        if (exclude && exclude.some(pattern => matchPattern(item, pattern))) {
            continue
        }

        const itemLocalPath  = path.join(localPath, item)
        const itemRemotePath = path.posix.join(remotePath, item)
        const stats          = fs.statSync(itemLocalPath)

        if (stats.isDirectory()) {
            const result = await uploadDirectory(alias, itemLocalPath, itemRemotePath, exclude)
            fileCount += result.fileCount
            totalSize += result.totalSize
        } else if (stats.isFile()) {
            await uploadFile(alias, itemLocalPath, itemRemotePath)
            fileCount++
            totalSize += stats.size
        }
    }

    return {fileCount, totalSize}
}

/**
 * 递归下载目录
 */
async function downloadDirectory(
    alias: string,
    remotePath: string,
    localPath: string,
    exclude?: string[],
): Promise<{ fileCount: number; totalSize: number }> {
    let fileCount = 0
    let totalSize = 0

    // 确保本地目录存在
    if (!fs.existsSync(localPath)) {
        fs.mkdirSync(localPath, {recursive: true})
    }

    const items = await listDir(alias, remotePath, true)
    for (const item of items) {
        // 检查排除模式
        if (exclude && exclude.some(pattern => matchPattern(item.name, pattern))) {
            continue
        }

        const itemLocalPath = path.join(localPath, item.name)

        if (item.isDirectory) {
            const result = await downloadDirectory(alias, item.path, itemLocalPath, exclude)
            fileCount += result.fileCount
            totalSize += result.totalSize
        } else if (item.isFile) {
            await downloadFile(alias, item.path, itemLocalPath)
            fileCount++
            totalSize += item.size
        }
    }

    return {fileCount, totalSize}
}

/**
 * 简单的模式匹配（支持 * 和 ?）
 */
function matchPattern(name: string, pattern: string): boolean {
    const regexPattern = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // 转义特殊字符
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
    return new RegExp(`^${regexPattern}$`).test(name)
}

/**
 * 格式化权限字符串
 */
function formatPermissions(mode: number): string {
    const types: [number, string][] = [
        [S_IFDIR, 'd'],
        [S_IFLNK, 'l'],
        [S_IFREG, '-'],
    ]

    let type = '-'
    for (const [mask, char] of types) {
        if ((mode & mask) !== 0) {
            type = char
            break
        }
    }

    const perms = [
        (mode & 0o400) ? 'r' : '-',
        (mode & 0o200) ? 'w' : '-',
        (mode & 0o100) ? 'x' : '-',
        (mode & 0o040) ? 'r' : '-',
        (mode & 0o020) ? 'w' : '-',
        (mode & 0o010) ? 'x' : '-',
        (mode & 0o004) ? 'r' : '-',
        (mode & 0o002) ? 'w' : '-',
        (mode & 0o001) ? 'x' : '-',
    ]

    return type + perms.join('')
}
