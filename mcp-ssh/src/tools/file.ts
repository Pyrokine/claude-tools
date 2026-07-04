/**
 * 文件操作工具组
 *
 * ssh_upload, ssh_download, ssh_read_file, ssh_write_file,
 * ssh_list_dir, ssh_file_info, ssh_mkdir, ssh_sync
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import * as fileOps from '../file-ops.js'
import { sessionManager } from '../session-manager.js'
import { escapeShellArg, formatError, formatResult } from './utils.js'

// ========== Schemas ==========

const uploadSchema = z.object({
    alias: z.string().describe('连接别名'),
    localPath: z.string().describe('本地文件路径'),
    remotePath: z.string().describe('远程目标路径'),
    atomic: z.boolean().optional().describe('是否先上传到同目录临时文件，校验后 rename 到目标路径'),
    verifyOwner: z.union([z.string(), z.number()]).optional().describe('上传后校验远端 owner（用户名或 uid）'),
    verifyMode: z.string().optional().describe('上传后校验远端权限，例如 0644 或 -rw-r--r--'),
    verifyMd5: z.boolean().optional().describe('上传后比对本地和远端 MD5'),
    verifySize: z.boolean().optional().describe('上传后校验文件大小'),
    verifyMtime: z.boolean().optional().describe('上传后返回并比较本地和远端 mtime'),
})

const downloadSchema = z.object({
    alias: z.string().describe('连接别名'),
    remotePath: z.string().describe('远程文件路径'),
    localPath: z.string().describe('本地保存路径'),
})

const readFileSchema = z.object({
    alias: z.string().describe('连接别名'),
    remotePath: z.string().describe('远程文件路径'),
    maxBytes: z
        .number()
        .int()
        .positive()
        .max(fileOps.HARD_READ_FILE_MAX_BYTES)
        .optional()
        .describe('最大读取字节数，默认 1MB，最大 16MB'),
    offset: z.number().optional().describe('从指定字节偏移开始读取，与 tail/lineRange 互斥'),
    tail: z.boolean().optional().describe('读取文件尾部 maxBytes 字节，与 offset/lineRange 互斥'),
    lineRange: z.string().optional().describe('按行号读取，格式为 "start-end" 或 "start"，与 offset/tail 互斥'),
})

const writeFileSchema = z.object({
    alias: z.string().describe('连接别名'),
    remotePath: z.string().describe('远程文件路径'),
    content: z.string().describe('要写入的内容'),
    append: z.boolean().optional().describe('是否追加模式，默认覆盖'),
})

const listDirSchema = z.object({
    alias: z.string().describe('连接别名'),
    remotePath: z.string().describe('远程目录路径'),
    showHidden: z.boolean().optional().describe('是否显示隐藏文件'),
})

const fileInfoSchema = z.object({
    alias: z.string().describe('连接别名'),
    remotePath: z.string().describe('远程路径'),
})

const mkdirSchema = z.object({
    alias: z.string().describe('连接别名'),
    remotePath: z.string().describe('远程目录路径'),
    recursive: z.boolean().optional().describe('是否递归创建，默认 false'),
})

const syncSchema = z.object({
    alias: z.string().describe('连接别名'),
    localPath: z.string().describe('本地路径'),
    remotePath: z.string().describe('远程路径'),
    direction: z.enum(['upload', 'download']).describe('同步方向：upload（本地到远程）或 download（远程到本地）'),
    delete: z.boolean().optional().describe('删除目标端多余文件（类似 rsync --delete）'),
    dryRun: z.boolean().optional().describe('仅显示将执行的操作，不实际传输'),
    exclude: z.array(z.string()).optional().describe('排除模式列表（支持 * 和 ? 通配符）'),
    recursive: z.boolean().optional().describe('递归同步目录，默认 true'),
    followSymlinks: z
        .boolean()
        .optional()
        .describe('upload 时是否跟随本地 symlink，默认 false（跳过 symlink 并 warn，避免上传链接目标内容）'),
    verifyOwner: z.union([z.string(), z.number()]).optional().describe('upload 后校验远端 owner（用户名或 uid）'),
    verifyMode: z.string().optional().describe('upload 后校验远端权限，例如 0644 或 -rw-r--r--'),
})

// ========== Handlers ==========

const LARGE_UPLOAD_THRESHOLD = 100 * 1024 * 1024

type LocalPathProbe = ReturnType<typeof fileOps.probeLocalPath>

function summarizeLocalPathProbe(probe: LocalPathProbe): Record<string, unknown> {
    const summary: Record<string, unknown> = {
        exists: probe.exists,
        allowList: probe.allowList,
    }
    if ('size' in probe) {
        summary.size = probe.size
    }
    if ('mode' in probe) {
        summary.mode = probe.mode
    }
    if ('mtimeMs' in probe) {
        summary.mtimeMs = probe.mtimeMs
    }
    if ('isSymlink' in probe) {
        summary.isSymlink = probe.isSymlink
    }
    if ('isDirectory' in probe) {
        summary.isDirectory = probe.isDirectory
    }
    if ('isFile' in probe) {
        summary.isFile = probe.isFile
    }
    return summary
}

function uploadPathError(code: string, message: string, diagnostics: Record<string, unknown>) {
    return formatResult({
        success: false,
        code,
        error: message,
        diagnostics,
    })
}

async function probeRemoteParent(alias: string, remotePath: string) {
    const parent = path.posix.dirname(remotePath)
    const escapedParent = escapeShellArg(parent)
    const command = [
        `if [ -d ${escapedParent} ]; then`,
        `if [ -w ${escapedParent} ]; then printf writable; else printf not-writable; fi;`,
        'else printf missing; fi',
    ].join(' ')
    try {
        const result = await sessionManager.exec(alias, command, {
            timeout: 10000,
            useLoginUser: true,
            maxOutputSize: 4096,
        })
        const status = result.stdout.trim()
        return { exists: status !== 'missing', writable: status === 'writable' }
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
    }
}

function hashLocalFileMd5(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('md5')
        const stream = fs.createReadStream(filePath)
        stream.on('data', (chunk) => hash.update(chunk))
        stream.on('error', reject)
        stream.on('end', () => resolve(hash.digest('hex')))
    })
}

async function hashRemoteFileMd5(alias: string, remotePath: string): Promise<string | undefined> {
    const result = await sessionManager.exec(alias, `md5sum ${escapeShellArg(remotePath)} | awk '{print $1}'`, {
        timeout: 30000,
        useLoginUser: true,
        maxOutputSize: 4096,
    })
    const digest = result.stdout.trim().split(/\s+/)[0]
    return /^[a-fA-F0-9]{32}$/.test(digest) ? digest : undefined
}

function permissionStringToOctal(permissions: string): string | undefined {
    const bits = permissions.slice(-9)
    if (bits.length !== 9) {
        return undefined
    }
    const values = [bits.slice(0, 3), bits.slice(3, 6), bits.slice(6, 9)].map((part) => {
        let value = 0
        if (part[0] === 'r') {
            value += 4
        }
        if (part[1] === 'w') {
            value += 2
        }
        if (part[2] === 'x' || part[2] === 's' || part[2] === 't') {
            value += 1
        }
        return value
    })
    return `0${values.join('')}`
}

async function probeRemoteFile(alias: string, remotePath: string) {
    const escapedRemotePath = escapeShellArg(remotePath)
    const command = [
        `if [ -e ${escapedRemotePath} ]; then`,
        `stat -c '%U\t%u\t%G\t%g\t%a\t%s\t%Y\t%F' ${escapedRemotePath};`,
        'else printf missing; fi',
    ].join(' ')
    try {
        const result = await sessionManager.exec(alias, command, {
            timeout: 10000,
            useLoginUser: true,
            maxOutputSize: 4096,
        })
        if (result.stdout.trim() === 'missing') {
            return { exists: false, remotePath }
        }
        const [ownerName, ownerId, groupName, groupId, mode, size, mtimeSeconds, fileType] = result.stdout
            .trim()
            .split('\t')
        return {
            exists: true,
            remotePath,
            ownerName,
            ownerId: Number(ownerId),
            groupName,
            groupId: Number(groupId),
            mode: mode ? `0${mode}` : undefined,
            size: Number(size),
            mtimeMs: Number(mtimeSeconds) * 1000,
            fileType,
            isDirectory: fileType === 'directory',
            isFile: fileType?.startsWith('regular ') ?? false,
        }
    } catch {
        const info = await fileOps.getFileInfo(alias, remotePath)
        return {
            exists: true,
            remotePath,
            ownerId: info.owner,
            groupId: info.group,
            mode: permissionStringToOctal(info.permissions),
            permissions: info.permissions,
            size: info.size,
            mtimeMs: info.mtime.getTime(),
            isDirectory: info.isDirectory,
            isFile: info.isFile,
            isSymlink: info.isSymlink,
        }
    }
}

async function buildUploadVerification(
    args: z.infer<typeof uploadSchema>,
    local: ReturnType<typeof fileOps.probeLocalPath>
): Promise<Record<string, unknown>> {
    const remote = await probeRemoteFile(args.alias, args.remotePath)
    const checks: Record<string, unknown> = {}
    if (args.verifySize) {
        checks.size = local.exists && remote.exists ? local.size === remote.size : false
    }
    if (args.verifyMtime) {
        const mtimeDelta =
            local.exists && remote.exists ? Math.abs((local.mtimeMs ?? 0) - (remote.mtimeMs ?? 0)) : undefined
        checks.mtime = mtimeDelta !== undefined ? mtimeDelta < 2000 : false
    }
    if (args.verifyMode && remote.exists) {
        const expectedMode = normalizeExpectedMode(args.verifyMode)
        checks.mode = expectedMode !== undefined && remote.mode === expectedMode
    }
    if (args.verifyOwner && remote.exists) {
        const expectedOwner = String(args.verifyOwner)
        checks.owner = String(remote.ownerId) === expectedOwner || remote.ownerName === expectedOwner
    }
    if (args.verifyMd5 && local.exists) {
        const [localMd5, remoteMd5] = await Promise.all([
            hashLocalFileMd5(local.resolvedPath),
            hashRemoteFileMd5(args.alias, args.remotePath),
        ])
        checks.md5 = remoteMd5 ? localMd5 === remoteMd5 : undefined
        return {
            local: { ...summarizeLocalPathProbe(local), md5: localMd5 },
            remote: { ...remote, md5: remoteMd5 },
            checks,
        }
    }
    return { local: summarizeLocalPathProbe(local), remote, checks }
}

function normalizeExpectedMode(mode: string): string | undefined {
    const trimmed = mode.trim()
    if (/^[0-7]{3,4}$/.test(trimmed)) {
        return trimmed.length === 3 ? `0${trimmed}` : trimmed
    }
    return permissionStringToOctal(trimmed)
}

function buildSyncVerificationChecks(
    args: z.infer<typeof syncSchema>,
    remote: Awaited<ReturnType<typeof probeRemoteFile>>
): Record<string, boolean> {
    const checks: Record<string, boolean> = {}
    if (args.verifyOwner !== undefined) {
        const expectedOwner = String(args.verifyOwner)
        checks.owner = remote.exists && (String(remote.ownerId) === expectedOwner || remote.ownerName === expectedOwner)
    }
    if (args.verifyMode !== undefined) {
        const expectedMode = normalizeExpectedMode(args.verifyMode)
        checks.mode = remote.exists && expectedMode !== undefined && remote.mode === expectedMode
    }
    return checks
}

async function resolveSyncUploadVerificationPath(
    args: z.infer<typeof syncSchema>,
    local: ReturnType<typeof fileOps.probeLocalPath>
): Promise<string> {
    const requestedRemote = await probeRemoteFile(args.alias, args.remotePath)
    if (requestedRemote.exists && requestedRemote.isDirectory) {
        return path.posix.join(args.remotePath, path.basename(local.resolvedPath))
    }
    if (!requestedRemote.exists && args.remotePath.endsWith('/')) {
        return path.posix.join(args.remotePath, path.basename(local.resolvedPath))
    }
    return args.remotePath
}

async function buildSyncUploadVerification(
    args: z.infer<typeof syncSchema>,
    local: ReturnType<typeof fileOps.probeLocalPath>
): Promise<Record<string, unknown> | undefined> {
    if (args.verifyOwner === undefined && args.verifyMode === undefined) {
        return undefined
    }
    if (args.direction !== 'upload' || args.dryRun) {
        return {
            kind: 'owner_mode',
            skipped: true,
            reason: 'verifyOwner/verifyMode 只在非 dryRun 的 upload 场景校验远端 owner/mode',
        }
    }
    if (!local.exists || !local.isFile) {
        return {
            kind: 'owner_mode',
            skipped: true,
            reason: 'verifyOwner/verifyMode 只对单文件 upload 做后置校验，目录同步不会递归扫描远端权限',
            suggestion: '如需目录权限校验，请同步完成后对目标文件调用 ssh_file_info 或用 ssh_exec 执行显式检查',
        }
    }

    const verificationRemotePath = await resolveSyncUploadVerificationPath(args, local)
    const remote = await probeRemoteFile(args.alias, verificationRemotePath)
    const checks = buildSyncVerificationChecks(args, remote)
    const matched = Object.values(checks).every(Boolean)
    return {
        kind: 'owner_mode',
        matched,
        expected: {
            owner: args.verifyOwner,
            mode: args.verifyMode,
            normalizedMode: args.verifyMode ? normalizeExpectedMode(args.verifyMode) : undefined,
        },
        requestedRemotePath: args.remotePath,
        remote,
        checks,
        suggestion: matched
            ? undefined
            : '同步已完成，但远端 owner/mode 与期望不一致；工具不会自动 chown/chmod，请按需用 ssh_exec 显式处理权限',
    }
}

function mergeSyncVerification(
    existing: Record<string, unknown> | undefined,
    ownerMode: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
    if (!ownerMode) {
        return existing
    }
    if (!existing) {
        return ownerMode
    }
    return {
        ...existing,
        ownerMode,
    }
}

async function cleanupRemotePath(alias: string, remotePath: string): Promise<void> {
    await sessionManager.exec(alias, `rm -f ${escapeShellArg(remotePath)}`, {
        timeout: 10000,
        useLoginUser: true,
        maxOutputSize: 4096,
    })
}

async function applyRemoteMode(alias: string, remotePath: string, mode: string): Promise<void> {
    const result = await sessionManager.exec(alias, `chmod ${escapeShellArg(mode)} ${escapeShellArg(remotePath)}`, {
        timeout: 10000,
        useLoginUser: true,
        maxOutputSize: 4096,
    })
    if (!result.success) {
        throw new Error(result.stderr || result.stdout || `chmod failed with exit code ${result.exitCode}`)
    }
}

async function handleUpload(args: z.infer<typeof uploadSchema>) {
    const local = fileOps.probeLocalPath(args.localPath)
    if (local.exists && local.isDirectory) {
        return uploadPathError('UPLOAD_PATH_IS_DIRECTORY', 'localPath is a directory', {
            local: summarizeLocalPathProbe(local),
            suggestion: '使用 ssh_sync 上传目录，或把 localPath 指向具体文件',
        })
    }

    const largeFileSuggestion =
        local.exists && typeof local.size === 'number' && local.size >= LARGE_UPLOAD_THRESHOLD
            ? '大文件优先使用 ssh_sync，让 rsync 做增量传输'
            : undefined
    const recommendedSync =
        largeFileSuggestion && local.exists
            ? [
                  `ssh_sync(alias=${JSON.stringify(args.alias)}`,
                  `localPath=${JSON.stringify(args.localPath)}`,
                  `remotePath=${JSON.stringify(args.remotePath)}`,
                  'direction="upload")',
              ].join(', ')
            : undefined
    const remoteParent = await probeRemoteParent(args.alias, args.remotePath)
    const tempRemotePath = args.atomic
        ? `${args.remotePath}.mcp-tmp-${process.pid}-${Date.now().toString(36)}`
        : args.remotePath

    try {
        const uploadResult = await fileOps.uploadFile(args.alias, args.localPath, tempRemotePath)
        if (local.exists && 'mode' in local && typeof local.mode === 'string') {
            await applyRemoteMode(args.alias, tempRemotePath, local.mode)
        }
        if (args.atomic) {
            const rename = await sessionManager.exec(
                args.alias,
                `mv -f -- ${escapeShellArg(tempRemotePath)} ${escapeShellArg(args.remotePath)}`,
                { timeout: 30000, useLoginUser: true, maxOutputSize: 4096 }
            )
            if (!rename.success) {
                const renameError =
                    rename.stderr || rename.stdout || `atomic rename failed with exit code ${rename.exitCode}`
                await cleanupRemotePath(args.alias, tempRemotePath).catch(() => undefined)
                return formatResult({
                    success: false,
                    error: renameError,
                    diagnostics: {
                        local: summarizeLocalPathProbe(local),
                        remoteParent,
                        atomic: true,
                    },
                })
            }
        }
        return formatResult({
            ...uploadResult,
            message: `Uploaded to ${args.remotePath}`,
            atomic: args.atomic === true,
            suggestion: largeFileSuggestion,
            recommendedSync,
            diagnostics: {
                local: summarizeLocalPathProbe(local),
                remoteParent,
                atomic: args.atomic === true,
            },
            verification: await buildUploadVerification(args, local),
        })
    } catch (error) {
        if (args.atomic) {
            await cleanupRemotePath(args.alias, tempRemotePath).catch(() => undefined)
        }
        return formatResult({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            diagnostics: {
                local: summarizeLocalPathProbe(local),
                remoteParent,
                atomic: args.atomic === true,
            },
        })
    }
}

async function handleDownload(args: z.infer<typeof downloadSchema>) {
    try {
        const downloadResult = await fileOps.downloadFile(args.alias, args.remotePath, args.localPath)
        return formatResult({ ...downloadResult, message: `Downloaded to ${args.localPath}` })
    } catch (error) {
        return formatResult({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            diagnostics: {
                local: summarizeLocalPathProbe(fileOps.probeLocalPath(args.localPath)),
                localParent: summarizeLocalPathProbe(fileOps.probeLocalPath(path.dirname(args.localPath))),
                remoteParent: await probeRemoteParent(args.alias, args.remotePath),
            },
        })
    }
}

async function handleReadFile(args: z.infer<typeof readFileSchema>) {
    try {
        const readResult = await fileOps.readFile(args.alias, args.remotePath, {
            maxBytes: args.maxBytes,
            offset: args.offset,
            tail: args.tail,
            lineRange: args.lineRange,
        })
        return formatResult({ success: true, ...readResult })
    } catch (error) {
        return formatError(error)
    }
}

async function handleWriteFile(args: z.infer<typeof writeFileSchema>) {
    try {
        const result = await fileOps.writeFile(args.alias, args.remotePath, args.content, args.append)
        return formatResult(result)
    } catch (error) {
        return formatError(error)
    }
}

async function handleListDir(args: z.infer<typeof listDirSchema>) {
    try {
        const files = await fileOps.listDir(args.alias, args.remotePath, args.showHidden)
        return formatResult({
            success: true,
            path: args.remotePath,
            count: files.length,
            files,
        })
    } catch (error) {
        return formatError(error)
    }
}

async function handleFileInfo(args: z.infer<typeof fileInfoSchema>) {
    try {
        const info = await fileOps.getFileInfo(args.alias, args.remotePath)
        return formatResult({ success: true, ...info })
    } catch (error) {
        return formatError(error)
    }
}

async function handleMkdir(args: z.infer<typeof mkdirSchema>) {
    try {
        const success = await fileOps.mkdir(args.alias, args.remotePath, args.recursive)
        return formatResult({ success, path: args.remotePath })
    } catch (error) {
        return formatError(error)
    }
}

async function handleSync(args: z.infer<typeof syncSchema>) {
    const local = fileOps.probeLocalPath(args.localPath)
    const diagnostics = {
        local: summarizeLocalPathProbe(local),
        remoteParent: await probeRemoteParent(args.alias, args.remotePath),
    }
    try {
        const syncResult = await fileOps.syncFiles(args.alias, args.localPath, args.remotePath, args.direction, {
            delete: args.delete,
            dryRun: args.dryRun,
            exclude: args.exclude,
            recursive: args.recursive,
            followSymlinks: args.followSymlinks,
        })
        const ownerModeVerification = syncResult.success ? await buildSyncUploadVerification(args, local) : undefined
        return formatResult({
            ...syncResult,
            verification: mergeSyncVerification(syncResult.verification, ownerModeVerification),
            direction: args.direction,
            localPath: args.localPath,
            remotePath: args.remotePath,
            diagnostics,
        })
    } catch (error) {
        return formatResult({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            diagnostics,
        })
    }
}

// ========== Register ==========

export function registerFileTools(server: McpServer): void {
    server.registerTool(
        'ssh_upload',
        {
            description: '上传本地文件到远程服务器',
            inputSchema: uploadSchema,
        },
        (args) => handleUpload(args)
    )

    server.registerTool(
        'ssh_download',
        {
            description: '从远程服务器下载文件',
            inputSchema: downloadSchema,
        },
        (args) => handleDownload(args)
    )

    server.registerTool(
        'ssh_read_file',
        {
            description: '读取远程文件内容',
            inputSchema: readFileSchema,
        },
        (args) => handleReadFile(args)
    )

    server.registerTool(
        'ssh_write_file',
        {
            description: '写入内容到远程文件',
            inputSchema: writeFileSchema,
        },
        (args) => handleWriteFile(args)
    )

    server.registerTool(
        'ssh_list_dir',
        {
            description: '列出远程目录内容',
            inputSchema: listDirSchema,
        },
        (args) => handleListDir(args)
    )

    server.registerTool(
        'ssh_file_info',
        {
            description: '获取远程文件信息（大小、权限、修改时间等）',
            inputSchema: fileInfoSchema,
        },
        (args) => handleFileInfo(args)
    )

    server.registerTool(
        'ssh_mkdir',
        {
            description: '创建远程目录',
            inputSchema: mkdirSchema,
        },
        (args) => handleMkdir(args)
    )

    server.registerTool(
        'ssh_sync',
        {
            description: `智能文件同步（支持目录递归）

优先使用 rsync（如果本地和远程都安装了），否则回退到 SFTP
rsync 可实现增量传输，对大目录同步效率更高

用途：
- 同步本地目录到远程
- 从远程同步目录到本地
- 支持排除特定文件/目录

示例：
- 上传目录: ssh_sync(alias="server", localPath="/local/dir", remotePath="/remote/dir", direction="upload")
- 下载目录: ssh_sync(alias="server", localPath="/local/dir", remotePath="/remote/dir", direction="download")
- 排除文件: ssh_sync(..., exclude=["*.log", "node_modules"])`,
            inputSchema: syncSchema,
        },
        (args) => handleSync(args)
    )
}
