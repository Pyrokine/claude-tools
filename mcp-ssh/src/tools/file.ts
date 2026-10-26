/**
 * 文件操作工具组
 *
 * ssh_upload, ssh_download, ssh_read_file, ssh_write_file,
 * ssh_list_dir, ssh_file_info, ssh_mkdir, ssh_sync
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { z } from 'zod'
import {
    compareDirectoryManifests,
    createEmptyDirectoryManifest,
    createLocalDirectoryManifest,
    createRemoteDirectoryManifest,
    createOpenSshDirectoryManifest,
    matchesDirectoryExclude,
    DIRECTORY_VERIFY_MAX_ENTRIES,
    DIRECTORY_VERIFY_DEFAULT_MAX_FILE_BYTES,
    DIRECTORY_VERIFY_DEFAULT_MAX_TOTAL_BYTES,
    DIRECTORY_VERIFY_MAX_FILE_BYTES,
    DIRECTORY_VERIFY_MAX_TOTAL_BYTES,
    type DirectoryManifest,
    type DirectoryVerifyRequest,
} from '../directory-verification.js'
import { FILE_CREATE_MODE_MASK, formatFileMode, parseExpectedFileMode } from '../file-mode.js'
import * as fileOps from '../file-ops.js'
import { sessionManager } from '../session-manager.js'
import { withSftpOperationTimeout } from '../sftp-timeout.js'
import {
    encodedPowershell,
    quotePowershell,
    remoteDirname,
    remoteJoin,
    remotePathModule,
    remoteShellPath,
    sftpPath,
} from '../remote-platform.js'
import { buildTransferOutcome } from '../transfer-outcome.js'
import { operationTimeoutSchema } from './schema.js'
import { escapeShellArg, formatError, formatResult } from './utils.js'

// ========== Schemas ==========

const uploadSchema = z.object({
    alias: z.string().describe('连接别名'),
    localPath: z.string().describe('本地文件路径'),
    remotePath: z.string().describe('远程目标路径'),
    atomic: z.boolean().optional().describe('是否先上传到同目录临时文件，校验后 rename 到目标路径'),
    verifyOwner: z.union([z.string(), z.number()]).optional().describe('上传后校验远端 owner（用户名或 uid）'),
    verifyMode: z.string().optional().describe('上传后校验远端权限，例如 0644、4755 或 -rwsr-xr-x'),
    verifyMd5: z.boolean().optional().describe('上传后比对本地和远端 MD5'),
    verifySize: z.boolean().optional().describe('上传后校验文件大小'),
    verifyMtime: z.boolean().optional().describe('上传后返回并比较本地和远端 mtime'),
    timeout: operationTimeoutSchema.optional(),
})

const downloadSchema = z.object({
    alias: z.string().describe('连接别名'),
    remotePath: z.string().describe('远程文件路径'),
    localPath: z.string().describe('本地保存路径'),
    timeout: operationTimeoutSchema.optional(),
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
    offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('从 UTF-8 字符边界的字节偏移读取，与 tail/lineRange 互斥；使用上次返回的 next_offset'),
    tail: z.boolean().optional().describe('读取文件尾部 maxBytes 字节，与 offset/lineRange 互斥'),
    lineRange: z
        .string()
        .optional()
        .describe('通过 SFTP 按行号读取，格式为 "start-end" 或 "start"，与 offset/tail 互斥'),
    encoding: z
        .enum(['auto', 'utf8', 'utf16le', 'utf16be', 'gbk'])
        .optional()
        .describe('文本编码；auto 在文件起始处检测 UTF-16 BOM，否则用 UTF-8'),
    binary: z.boolean().optional().describe('无损 base64 输出，不执行文本解码'),
    timeout: operationTimeoutSchema.optional(),
})

const writeFileSchema = z.object({
    alias: z.string().describe('连接别名'),
    remotePath: z.string().describe('远程文件路径'),
    content: z.string().describe('要写入的内容'),
    append: z.boolean().optional().describe('是否追加模式，默认覆盖'),
    timeout: operationTimeoutSchema.optional(),
})

function compareDirectoryTimes(left: string, right: string): number {
    const milliseconds = Date.parse(left) - Date.parse(right)
    if (milliseconds !== 0) return milliseconds
    // 保留 ISO 8601 的亚毫秒部分，避免 Date.parse 截断时间边界
    const [leftFraction, rightFraction] = [left, right].map((value) =>
        (value.match(/\.(\d+)/)?.[1].slice(3) ?? '').replace(/0+$/, '')
    )
    return leftFraction < rightFraction ? -1 : leftFraction > rightFraction ? 1 : 0
}

const listDirSchema = z
    .object({
        alias: z.string().describe('连接别名'),
        remotePath: z.string().describe('远程目录路径'),
        showHidden: z.boolean().optional().describe('是否显示隐藏文件'),
        namePattern: z.string().optional().describe('名称通配模式，复用同步 exclude 的 * 和 ? 规则，区分大小写'),
        modifiedAfter: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe('修改时间下界，包含；使用带时区的 ISO 8601 时间'),
        modifiedBefore: z
            .string()
            .datetime({ offset: true })
            .optional()
            .describe('修改时间上界，不包含；使用带时区的 ISO 8601 时间'),
        offset: z.number().int().nonnegative().optional().describe('筛选并排序后的条目偏移，默认 0'),
        limit: z.number().int().positive().optional().describe('单页最多条数，使用任一新参数时默认 100'),
        maxBytes: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('响应 JSON 文本的 UTF-8 字节预算，包含分页元数据；使用任一新参数时默认 65536'),
        timeout: operationTimeoutSchema.optional(),
    })
    .refine(
        (args) =>
            args.modifiedAfter === undefined ||
            args.modifiedBefore === undefined ||
            compareDirectoryTimes(args.modifiedAfter, args.modifiedBefore) <= 0,
        { message: 'modifiedAfter must be at or before modifiedBefore', path: ['modifiedAfter'] }
    )

const fileInfoSchema = z.object({
    alias: z.string().describe('连接别名'),
    remotePath: z.string().describe('远程路径'),
    timeout: operationTimeoutSchema.optional(),
})

const mkdirSchema = z.object({
    alias: z.string().describe('连接别名'),
    remotePath: z.string().describe('远程目录路径'),
    recursive: z.boolean().optional().describe('是否递归创建，默认 false'),
    timeout: operationTimeoutSchema.optional(),
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
    preflightTimeout: z.number().int().positive().max(60000).optional().describe('传输能力预检超时，默认 10000ms'),
    connectTimeout: z.number().int().positive().max(120000).optional().describe('rsync SSH 连接超时，默认 30000ms'),
    operationTimeout: z.number().int().positive().max(3600000).optional().describe('同步操作超时，默认 600000ms'),
    verifyOwner: z.union([z.string(), z.number()]).optional().describe('upload 后校验远端 owner（用户名或 uid）'),
    verifyMode: z.string().optional().describe('upload 后校验远端权限，例如 0644、4755 或 -rwsr-xr-x'),
    verify: z
        .object({
            count: z.boolean().optional().describe('校验目录条目数'),
            sha256: z.boolean().optional().describe('校验文件 SHA-256 或目录 SHA-256 root manifest'),
            owner: z.boolean().optional().describe('逐项校验 owner'),
            mode: z.boolean().optional().describe('逐项校验 POSIX mode；Windows 不支持'),
            aclSddl: z
                .string()
                .min(1)
                .max(8192)
                .optional()
                .describe('Windows 远端文件或目录根路径的预期 DACL SDDL，独立于 POSIX mode/owner'),
            deletions: z.boolean().optional().describe('校验请求删除后没有额外条目'),
            staleFiles: z.boolean().optional().describe('校验没有旧文件残留'),
            maxEntries: z
                .number()
                .int()
                .positive()
                .max(DIRECTORY_VERIFY_MAX_ENTRIES)
                .optional()
                .describe('目录校验最大条目数，默认 10000，最大 50000'),
            maxFileBytes: z
                .number()
                .int()
                .positive()
                .max(DIRECTORY_VERIFY_MAX_FILE_BYTES)
                .optional()
                .describe('SHA-256 校验的单文件字节上限，默认 256MB，最大 4GB'),
            maxTotalBytes: z
                .number()
                .int()
                .positive()
                .max(DIRECTORY_VERIFY_MAX_TOTAL_BYTES)
                .optional()
                .describe('SHA-256 校验的总字节上限，默认 1GB，最大 16GB'),
        })
        .optional()
        .describe('有界文件或目录校验；count/deletions/staleFiles 仅适用于目录，未传时不执行额外远端扫描'),
})

// ========== Handlers ==========

const LARGE_UPLOAD_THRESHOLD = 100 * 1024 * 1024

type LocalPathProbe = ReturnType<typeof fileOps.probeLocalPath>
type VerificationFailureStage =
    | 'verification_timeout'
    | 'remote_probe'
    | 'remote_manifest_command'
    | 'remote_manifest_output'
    | 'remote_manifest_parse'
    | 'local_manifest'

class VerificationStageError extends Error {
    constructor(
        readonly failureStage: VerificationFailureStage,
        message: string,
        readonly retryable: boolean,
        readonly details?: Record<string, unknown>
    ) {
        super(message)
        this.name = 'VerificationStageError'
    }
}

function sftpOperationOutcome(error: unknown): Record<string, unknown> {
    if (!error || typeof error !== 'object') {
        return {}
    }
    const details = 'details' in error ? (error as { details?: unknown }).details : undefined
    if (details && typeof details === 'object' && 'operationStatus' in details) {
        return details as Record<string, unknown>
    }
    const cause = 'cause' in error ? (error as { cause?: unknown }).cause : undefined
    return sftpOperationOutcome(cause)
}

function formatFileOperationError(error: unknown) {
    const operationOutcome = sftpOperationOutcome(error)
    if (Object.keys(operationOutcome).length === 0) {
        return formatError(error)
    }
    return {
        ...formatResult({
            success: false,
            ...operationOutcome,
            error: error instanceof Error ? error.message : String(error),
        }),
        isError: true,
    }
}

function verificationErrorDetails(error: unknown): Record<string, unknown> {
    if (error instanceof VerificationStageError) {
        return {
            kind: 'error',
            failureStage: error.failureStage,
            error: error.message,
            retryable: error.retryable,
            ...error.details,
        }
    }
    return {
        kind: 'error',
        failureStage: 'remote_probe',
        error: error instanceof Error ? error.message : String(error),
        retryable: false,
    }
}

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
    if ('modeValue' in probe) {
        summary.modeValue = probe.modeValue
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

function normalizeRemotePath(alias: string, remotePath: string): string {
    return sftpPath(remotePath, sessionManager.getRemotePathStyle(alias))
}

async function probeRemoteParent(alias: string, remotePath: string, timeout?: number) {
    const parent = remoteDirname(sessionManager.getRemotePathStyle(alias), remotePath)
    const probeMethod = sessionManager.getOpenSshConnection(alias) ? ('openssh' as const) : ('sftp' as const)
    try {
        const result = await probeRemoteFile(alias, parent, timeout)
        return {
            exists: result.exists,
            isDirectory: result.exists ? result.isDirectory : false,
            probeMethod,
        }
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), probeMethod }
    }
}

function boundedDiagnostic(
    value: string,
    maxBytes: number = 2048
): { text: string; bytes: number; truncated: boolean } {
    const buffer = Buffer.from(value, 'utf8')
    if (buffer.length <= maxBytes) {
        return { text: value, bytes: buffer.length, truncated: false }
    }
    return {
        text: buffer.subarray(0, maxBytes).toString('utf8'),
        bytes: buffer.length,
        truncated: true,
    }
}

function commandFailureDetails(result: Awaited<ReturnType<typeof sessionManager.exec>>): Record<string, unknown> {
    const stderr = boundedDiagnostic(result.stderr)
    const stdout = boundedDiagnostic(result.stdout)
    return {
        exitCode: result.exitCode,
        failureKind: result.failureKind,
        timedOut: result.timedOut,
        stdout: stdout.text || undefined,
        stdoutBytes: result.stdoutBytes ?? stdout.bytes,
        stdoutTruncated: result.stdoutTruncated || stdout.truncated || undefined,
        stderr: stderr.text || undefined,
        stderrBytes: result.stderrBytes ?? stderr.bytes,
        stderrTruncated: result.stderrTruncated || stderr.truncated || undefined,
    }
}

async function hashRemoteFileMd5(alias: string, remotePath: string, timeout?: number): Promise<string> {
    try {
        return await fileOps.hashRemoteFileDigest(alias, remotePath, 'md5', timeout)
    } catch (error) {
        throw new VerificationStageError(
            'remote_probe',
            `Remote SFTP MD5 read failed: ${error instanceof Error ? error.message : String(error)}`,
            true,
            { operation: 'md5', probeMethod: 'sftp' }
        )
    }
}

async function resolveExpectedOwnerId(alias: string, owner: string | number, timeout: number = 10000): Promise<string> {
    const ownerText = String(owner)
    if (/^\d+$/.test(ownerText)) {
        return ownerText
    }
    const result = await sessionManager.exec(alias, `id -u ${escapeShellArg(ownerText)}`, {
        timeout,
        useLoginUser: true,
        maxOutputSize: 4096,
    })
    const ownerId = result.stdout.trim()
    if (!result.success || !/^\d+$/.test(ownerId)) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
        throw new VerificationStageError('remote_probe', `Remote owner lookup failed: ${detail}`, true, {
            operation: 'owner_lookup',
            ...commandFailureDetails(result),
        })
    }
    return ownerId
}

function isRemoteMissingError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false
    }
    const code = 'code' in error ? (error as { code?: unknown }).code : undefined
    const message = error instanceof Error ? error.message : String(error)
    return code === 2 || code === 'ENOENT' || /no such file|not found/i.test(message)
}

async function probeRemoteFile(alias: string, remotePath: string, timeout: number = 10000) {
    const probeMethod = sessionManager.getOpenSshConnection(alias) ? ('openssh' as const) : ('sftp' as const)
    let info: Awaited<ReturnType<typeof fileOps.getFileInfo>>
    try {
        info = await fileOps.getFileInfo(alias, remotePath, timeout)
    } catch (error) {
        if (isRemoteMissingError(error)) {
            return { exists: false as const, remotePath, probeMethod }
        }
        throw new VerificationStageError(
            'remote_probe',
            `Remote file stat failed: ${error instanceof Error ? error.message : String(error)}`,
            true,
            { operation: 'stat', probeMethod }
        )
    }
    return {
        exists: true as const,
        remotePath,
        probeMethod,
        ownerName: undefined,
        ownerId: info.owner,
        groupName: undefined,
        groupId: info.group,
        mode: formatFileMode(info.mode),
        modeValue: info.mode,
        permissions: info.permissions,
        size: info.size,
        mtimeMs: info.mtime.getTime(),
        fileType: info.isDirectory
            ? 'directory'
            : info.isFile
              ? 'regular file'
              : info.isSymlink
                ? 'symbolic link'
                : 'other',
        isDirectory: info.isDirectory,
        isFile: info.isFile,
    }
}

async function buildUploadVerification(
    args: z.infer<typeof uploadSchema>,
    local: ReturnType<typeof fileOps.probeLocalPath>,
    verificationRemotePath: string = args.remotePath
): Promise<Record<string, unknown>> {
    const remote = await probeRemoteFile(args.alias, verificationRemotePath, args.timeout)
    const checks: Record<string, unknown> = {}
    if (args.verifySize) {
        checks.size = local.exists && remote.exists ? local.size === remote.size : false
    }
    if (args.verifyMtime) {
        const mtimeDelta =
            local.exists && remote.exists ? Math.abs((local.mtimeMs ?? 0) - (remote.mtimeMs ?? 0)) : undefined
        checks.mtime = mtimeDelta !== undefined ? mtimeDelta < 2000 : false
    }
    if (args.verifyMode) {
        const expectedMode = normalizeExpectedMode(args.verifyMode)
        checks.mode = remote.exists && expectedMode !== undefined && remote.modeValue === expectedMode
    }
    if (args.verifyOwner !== undefined) {
        const expectedOwnerId = await resolveExpectedOwnerId(args.alias, args.verifyOwner, args.timeout)
        checks.owner = remote.exists && String(remote.ownerId) === expectedOwnerId
    }
    if (args.verifyMd5 && local.exists) {
        const [localMd5, remoteMd5] = await Promise.all([
            fileOps.hashLocalFile(local.resolvedPath, 'md5', args.timeout),
            hashRemoteFileMd5(args.alias, verificationRemotePath, args.timeout),
        ])
        checks.md5 = remoteMd5 ? localMd5 === remoteMd5 : undefined
        return {
            expected: {
                owner: args.verifyOwner,
                mode: args.verifyMode ? displayExpectedMode(args.verifyMode) : undefined,
                size: args.verifySize && local.exists ? local.size : undefined,
                mtimeMs: args.verifyMtime && local.exists ? local.mtimeMs : undefined,
                md5: localMd5,
            },
            actual: { ...remote, md5: remoteMd5 },
            local: { ...summarizeLocalPathProbe(local), md5: localMd5 },
            remote: { ...remote, md5: remoteMd5 },
            checks,
        }
    }
    return {
        expected: {
            owner: args.verifyOwner,
            mode: args.verifyMode ? displayExpectedMode(args.verifyMode) : undefined,
            size: args.verifySize && local.exists ? local.size : undefined,
            mtimeMs: args.verifyMtime && local.exists ? local.mtimeMs : undefined,
        },
        actual: remote,
        local: summarizeLocalPathProbe(local),
        remote,
        checks,
    }
}

function normalizeExpectedMode(mode: string): number | undefined {
    return parseExpectedFileMode(mode)
}

function displayExpectedMode(mode: string): string | undefined {
    const parsed = normalizeExpectedMode(mode)
    return parsed === undefined ? undefined : formatFileMode(parsed)
}

async function buildSyncVerificationChecks(
    args: z.infer<typeof syncSchema>,
    remote: Awaited<ReturnType<typeof probeRemoteFile>>
): Promise<Record<string, boolean>> {
    const checks: Record<string, boolean> = {}
    if (args.verifyOwner !== undefined) {
        const expectedOwnerId = await resolveExpectedOwnerId(args.alias, args.verifyOwner)
        checks.owner = remote.exists && String(remote.ownerId) === expectedOwnerId
    }
    if (args.verifyMode !== undefined) {
        const expectedMode = normalizeExpectedMode(args.verifyMode)
        checks.mode = remote.exists && expectedMode !== undefined && remote.modeValue === expectedMode
    }
    return checks
}

async function resolveSyncUploadVerificationPath(
    args: z.infer<typeof syncSchema>,
    local: ReturnType<typeof fileOps.probeLocalPath>,
    timeout: number
): Promise<string> {
    const requestedRemote = await probeRemoteFile(args.alias, args.remotePath, timeout)
    if (requestedRemote.exists && requestedRemote.isDirectory) {
        return remoteJoin(
            sessionManager.getRemotePathStyle(args.alias),
            args.remotePath,
            path.basename(local.expandedPath)
        )
    }
    if (!requestedRemote.exists && args.remotePath.endsWith('/')) {
        return remoteJoin(
            sessionManager.getRemotePathStyle(args.alias),
            args.remotePath,
            path.basename(local.expandedPath)
        )
    }
    return args.remotePath
}

async function buildSyncUploadVerification(
    args: z.infer<typeof syncSchema>,
    local: ReturnType<typeof fileOps.probeLocalPath>,
    timeout: number
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
            suggestion: '目录权限校验请使用 verify.owner 或 verify.mode',
        }
    }
    if (timeout <= 0) {
        throw new VerificationStageError(
            'verification_timeout',
            'sync operation timeout was exhausted before owner/mode verification started',
            true
        )
    }

    const verificationRemotePath = await resolveSyncUploadVerificationPath(args, local, timeout)
    const remote = await probeRemoteFile(args.alias, verificationRemotePath, timeout)
    const checks = await buildSyncVerificationChecks(args, remote)
    const matched = Object.values(checks).every(Boolean)
    return {
        kind: 'owner_mode',
        matched,
        expected: {
            owner: args.verifyOwner,
            mode: args.verifyMode,
            normalizedMode: args.verifyMode ? displayExpectedMode(args.verifyMode) : undefined,
        },
        requestedRemotePath: args.remotePath,
        remote,
        checks,
        suggestion: matched
            ? undefined
            : '同步已完成，但远端 owner/mode 与期望不一致；工具不会自动 chown/chmod，请按需用 ssh_exec 显式处理权限',
    }
}

async function captureRemoteDirectoryManifest(
    alias: string,
    remotePath: string,
    request: DirectoryVerifyRequest,
    exclude: string[] | undefined,
    followSymlinks: boolean | undefined,
    timeout: number
): Promise<DirectoryManifest> {
    const connection = sessionManager.getOpenSshConnection(alias)
    if (connection)
        return createOpenSshDirectoryManifest(connection, remotePath, request, timeout, exclude, followSymlinks)
    const requestSftp = sessionManager.getSftp(alias)
    const sftp = await withSftpOperationTimeout(requestSftp, timeout, () => {
        void requestSftp.then(
            (late) => late.end(),
            () => undefined
        )
    })
    try {
        return await withSftpOperationTimeout(
            createRemoteDirectoryManifest(
                sftp,
                remotePath,
                request,
                exclude,
                followSymlinks,
                sessionManager.getRemotePathStyle(alias)
            ),
            timeout,
            () => sftp.end()
        )
    } catch (error) {
        throw new VerificationStageError(
            'remote_manifest_output',
            error instanceof Error ? error.message : String(error),
            true
        )
    } finally {
        sftp.end()
    }
}

function directoryVerificationFollowsSymlinks(args: z.infer<typeof syncSchema>): boolean {
    return args.direction === 'upload' && args.followSymlinks === true
}

function deletionManifestRequest(request: DirectoryVerifyRequest): DirectoryVerifyRequest {
    return {
        ...request,
        count: false,
        sha256: false,
        owner: false,
        mode: false,
        deletions: false,
        staleFiles: false,
    }
}

async function captureDeletionBaseline(
    args: z.infer<typeof syncSchema>,
    remainingTimeout: () => number
): Promise<DirectoryManifest | undefined> {
    if (!args.verify?.deletions || args.dryRun) {
        return undefined
    }
    const request = deletionManifestRequest(args.verify)
    if (args.direction === 'upload') {
        const probeTimeout = remainingTimeout()
        if (probeTimeout <= 0) {
            throw new VerificationStageError(
                'verification_timeout',
                'sync operation timeout was exhausted before deletion baseline capture started',
                true
            )
        }
        const remote = await probeRemoteFile(args.alias, args.remotePath, probeTimeout)
        if (!remote.exists) {
            return createEmptyDirectoryManifest()
        }
        if (!remote.isDirectory) {
            throw new VerificationStageError(
                'remote_probe',
                'deletion verification requires the remote destination to be a directory',
                false,
                { remotePath: args.remotePath, fileType: remote.fileType }
            )
        }
        const manifestTimeout = remainingTimeout()
        if (manifestTimeout <= 0) {
            throw new VerificationStageError(
                'verification_timeout',
                'sync operation timeout was exhausted before deletion baseline manifest started',
                true
            )
        }
        return captureRemoteDirectoryManifest(
            args.alias,
            args.remotePath,
            request,
            args.exclude,
            directoryVerificationFollowsSymlinks(args),
            manifestTimeout
        )
    }

    const local = fileOps.probeLocalPath(args.localPath)
    if (!local.exists) {
        return createEmptyDirectoryManifest()
    }
    if (!local.isDirectory) {
        throw new VerificationStageError(
            'local_manifest',
            'deletion verification requires the local destination to be a directory',
            false,
            { localPath: args.localPath }
        )
    }
    try {
        return await createLocalDirectoryManifest(
            local.resolvedPath,
            request,
            args.exclude,
            directoryVerificationFollowsSymlinks(args)
        )
    } catch (error) {
        throw new VerificationStageError(
            'local_manifest',
            error instanceof Error ? error.message : String(error),
            false
        )
    }
}

async function buildSingleFileSyncVerification(
    args: z.infer<typeof syncSchema>,
    local: LocalPathProbe,
    timeout: number
): Promise<Record<string, unknown> | undefined> {
    if (!args.verify) return undefined
    if (args.dryRun)
        return { kind: 'single_file', skipped: true, reason: 'file verification is not executed during dryRun' }
    if (!local.exists || !local.isFile)
        throw new VerificationStageError(
            'local_manifest',
            'File verification requires the transferred local file',
            false
        )
    const deadline = Date.now() + timeout
    const remaining = (): number => {
        const value = deadline - Date.now()
        if (value <= 0)
            throw new VerificationStageError(
                'verification_timeout',
                'sync operation timeout was exhausted during file verification',
                true
            )
        return value
    }
    const remotePath =
        args.direction === 'upload'
            ? await resolveSyncUploadVerificationPath(args, local, remaining())
            : args.remotePath
    const remote = await probeRemoteFile(args.alias, remotePath, remaining())
    const checks: Record<string, boolean> = {
        file: remote.exists && remote.isFile,
        size: remote.exists && remote.size === local.size,
    }
    if (args.verify.owner)
        checks.owner = remote.exists && String(remote.ownerId) === String(fs.statSync(local.resolvedPath).uid)
    if (args.verify.mode) checks.mode = remote.exists && remote.modeValue === local.modeValue
    let localSha256: string | undefined
    let remoteSha256: string | undefined
    if (args.verify.sha256 && remote.exists && remote.isFile) {
        const maxBytes = Math.min(
            args.verify.maxFileBytes ?? DIRECTORY_VERIFY_DEFAULT_MAX_FILE_BYTES,
            args.verify.maxTotalBytes ?? DIRECTORY_VERIFY_DEFAULT_MAX_TOTAL_BYTES
        )
        if (local.size > maxBytes || remote.size > maxBytes)
            return { kind: 'single_file', skipped: true, reason: 'file verification byte budget exceeded', maxBytes }
        ;[localSha256, remoteSha256] = await Promise.all([
            fileOps.hashLocalFile(local.resolvedPath, 'sha256', remaining(), { maxBytes, expectedSize: local.size }),
            fileOps.hashRemoteFileDigest(args.alias, remotePath, 'sha256', remaining(), {
                maxBytes,
                expectedSize: remote.size,
            }),
        ])
        checks.sha256 = localSha256 === remoteSha256
        const after = await probeRemoteFile(args.alias, remotePath, remaining())
        if (
            !after.exists ||
            after.size !== remote.size ||
            after.mtimeMs !== remote.mtimeMs ||
            after.modeValue !== remote.modeValue ||
            after.ownerId !== remote.ownerId
        ) {
            throw new VerificationStageError('remote_probe', 'Remote file changed during sync verification', true)
        }
    } else if (args.verify.sha256) checks.sha256 = false
    if (args.verify.aclSddl) {
        const command = encodedPowershell(
            `$acl = Get-Acl -LiteralPath ${quotePowershell(remoteShellPath(remotePath, sessionManager.getRemotePathStyle(args.alias)))}; $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)`
        )
        const result = await sessionManager.exec(args.alias, command, {
            timeout: remaining(),
            useLoginUser: true,
            maxOutputSize: 8192,
        })
        if (!result.success || result.stdoutTruncated)
            throw new VerificationStageError('remote_probe', 'Windows remote ACL could not be verified', true)
        checks.acl = result.stdout.trim() === args.verify.aclSddl
    }
    return {
        kind: 'single_file',
        matched: Object.values(checks).every(Boolean),
        checks,
        direction: args.direction,
        remotePath,
        localPath: local.expandedPath,
        local: { ...summarizeLocalPathProbe(local), sha256: localSha256 },
        remote: { ...remote, sha256: remoteSha256 },
    }
}

async function buildDirectorySyncVerification(
    args: z.infer<typeof syncSchema>,
    local: ReturnType<typeof fileOps.probeLocalPath>,
    timeout: number,
    deletionBaseline?: DirectoryManifest
): Promise<Record<string, unknown> | undefined> {
    if (!args.verify) {
        return undefined
    }
    if (args.dryRun) {
        return { kind: 'directory', skipped: true, reason: 'directory verification is not executed during dryRun' }
    }
    if (!local.exists || !local.isDirectory) {
        return { kind: 'directory', skipped: true, reason: 'bounded directory verification requires a local directory' }
    }
    if (timeout <= 0) {
        throw new VerificationStageError(
            'verification_timeout',
            'sync operation timeout was exhausted before directory verification started',
            true
        )
    }
    const request: DirectoryVerifyRequest = args.verify
    const remoteManifest = await captureRemoteDirectoryManifest(
        args.alias,
        args.remotePath,
        request,
        args.exclude,
        directoryVerificationFollowsSymlinks(args),
        timeout
    )
    let localManifest: Awaited<ReturnType<typeof createLocalDirectoryManifest>>
    try {
        localManifest = await createLocalDirectoryManifest(
            local.resolvedPath,
            request,
            args.exclude,
            directoryVerificationFollowsSymlinks(args)
        )
    } catch (error) {
        throw new VerificationStageError(
            'local_manifest',
            error instanceof Error ? error.message : String(error),
            false
        )
    }
    const comparison =
        args.direction === 'upload'
            ? compareDirectoryManifests(localManifest, remoteManifest, request, deletionBaseline)
            : compareDirectoryManifests(remoteManifest, localManifest, request, deletionBaseline)
    if (
        remoteManifest.skippedSymlinks > 0 ||
        localManifest.skippedSymlinks > 0 ||
        (deletionBaseline?.skippedSymlinks ?? 0) > 0
    ) {
        comparison.suggestion =
            args.direction === 'upload' && !args.followSymlinks
                ? '排除符号链接后重新同步和校验，或显式设置 followSymlinks=true 上传并校验链接目标'
                : '排除符号链接后重新同步和校验；download 保持跳过链接目标，followSymlinks 仅适用于 upload'
    }
    if (request.aclSddl && !('skipped' in comparison)) {
        const command = encodedPowershell(
            `$acl = Get-Acl -LiteralPath ${quotePowershell(remoteShellPath(args.remotePath, sessionManager.getRemotePathStyle(args.alias)))}; $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)`
        )
        const result = await sessionManager.exec(args.alias, command, {
            timeout,
            useLoginUser: true,
            maxOutputSize: 8192,
        })
        if (!result.success || result.stdoutTruncated) {
            throw new VerificationStageError('remote_probe', 'Windows remote ACL could not be verified', true)
        }
        const aclMatch = result.stdout.trim() === request.aclSddl
        const checks = comparison.checks as Record<string, boolean>
        checks.acl = aclMatch
        comparison.matched = comparison.matched === true && aclMatch
        comparison.acl = { matched: aclMatch, expected: request.aclSddl, actual: result.stdout.trim() }
    }
    return comparison
}

function mergeSyncVerification(
    existing: Record<string, unknown> | undefined,
    ownerMode: Record<string, unknown> | undefined,
    content: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
    const parts = [existing, ownerMode, content].filter((part): part is Record<string, unknown> => Boolean(part))
    if (parts.length === 0) {
        return undefined
    }
    if (parts.length === 1) {
        return parts[0]
    }
    return {
        transport: existing,
        ownerMode,
        directory: content?.kind === 'directory' ? content : undefined,
        singleFile: content?.kind === 'single_file' ? content : undefined,
    }
}

async function cleanupRemotePath(alias: string, remotePath: string, timeout?: number): Promise<void> {
    try {
        await fileOps.removeRemoteFile(alias, remotePath, timeout)
    } catch (error) {
        throw new Error(
            `Temporary remote file cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
            {
                cause: error,
            }
        )
    }
}

export function createAtomicUploadPath(remotePath: string): string {
    return `${remotePath}.mcp-tmp-${process.pid}-${randomBytes(12).toString('hex')}`
}

function uploadPathDetails(
    args: z.infer<typeof uploadSchema>,
    verificationRemotePath: string,
    verification?: Record<string, unknown>
): Record<string, unknown> {
    return {
        finalRemotePath: args.remotePath,
        verifiedRemotePath: verification ? verificationRemotePath : undefined,
        verifiedTempRemotePath: verification && args.atomic ? verificationRemotePath : undefined,
    }
}

function addUploadVerificationPaths(
    verification: Record<string, unknown> | undefined,
    args: z.infer<typeof uploadSchema>,
    verificationRemotePath: string
): Record<string, unknown> | undefined {
    if (!verification) {
        return undefined
    }
    return {
        ...verification,
        ...uploadPathDetails(args, verificationRemotePath, verification),
    }
}

async function handleUpload(args: z.infer<typeof uploadSchema>) {
    try {
        args.remotePath = normalizeRemotePath(args.alias, args.remotePath)
        if (
            sessionManager.getRemotePlatform(args.alias) === 'windows' &&
            (args.verifyOwner !== undefined || args.verifyMode !== undefined)
        ) {
            return formatResult({
                success: false,
                code: 'unsupported_remote_platform',
                error: 'Windows SFTP owner/mode metadata cannot verify POSIX permissions; use Windows ACL verification',
            })
        }
    } catch (error) {
        return formatError(error)
    }
    let local: LocalPathProbe
    try {
        fileOps.validateUploadFileSource(args.localPath)
        local = fileOps.probeLocalPath(args.localPath)
    } catch (error) {
        local = fileOps.probeLocalPath(args.localPath)
        if (local.exists && local.isDirectory) {
            return uploadPathError('UPLOAD_PATH_IS_DIRECTORY', 'localPath is a directory', {
                local: summarizeLocalPathProbe(local),
                suggestion: '使用 ssh_sync 上传目录，或把 localPath 指向具体文件',
            })
        }
        return formatResult({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            diagnostics: { local: summarizeLocalPathProbe(local) },
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
    const remoteParent = await probeRemoteParent(args.alias, args.remotePath, args.timeout)
    let remoteBefore: Awaited<ReturnType<typeof probeRemoteFile>>
    try {
        remoteBefore = await probeRemoteFile(args.alias, args.remotePath, args.timeout)
    } catch (error) {
        return formatResult({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            diagnostics: {
                local: summarizeLocalPathProbe(local),
                remoteParent,
                remoteProbe: verificationErrorDetails(error),
                atomic: args.atomic === true,
            },
        })
    }
    let atomicReplaceSupported: boolean | null = null
    if (args.atomic && remoteBefore.exists) {
        try {
            const capability = await fileOps.atomicReplaceCapability(args.alias, args.timeout)
            atomicReplaceSupported = capability.atomicReplaceSupported
            if (!capability.atomicReplaceSupported) {
                return formatResult({
                    success: false,
                    code: 'atomic_replace_unsupported',
                    atomicReplaceSupported: false,
                    targetReplaced: false,
                    error: capability.reason,
                })
            }
        } catch (error) {
            return formatResult({
                success: false,
                code: 'atomic_replace_unverified',
                atomicReplaceSupported: null,
                targetReplaced: false,
                error: error instanceof Error ? error.message : String(error),
            })
        }
    }
    const sourceMode =
        local.exists && 'modeValue' in local && typeof local.modeValue === 'number'
            ? local.modeValue & FILE_CREATE_MODE_MASK
            : undefined
    const existingMode = remoteBefore.exists ? remoteBefore.modeValue & FILE_CREATE_MODE_MASK : undefined
    const createMode = args.atomic && existingMode !== undefined ? existingMode : sourceMode
    const tempRemotePath = args.atomic ? createAtomicUploadPath(args.remotePath) : args.remotePath
    const verificationRequested = Boolean(
        args.verifyOwner !== undefined ||
        args.verifyMode !== undefined ||
        args.verifyMd5 ||
        args.verifySize ||
        args.verifyMtime
    )

    let privateTempCreated = false
    let uploadedTempCreated = false
    try {
        if (args.atomic && sessionManager.getRemotePlatform(args.alias) === 'windows') {
            const shellPath = remoteShellPath(tempRemotePath, sessionManager.getRemotePathStyle(args.alias))
            await fileOps.prepareWindowsRemotePrivateFile(args.alias, tempRemotePath, args.timeout, shellPath)
            privateTempCreated = true
        }
        const uploadResult = await fileOps.uploadFile(
            args.alias,
            args.localPath,
            tempRemotePath,
            undefined,
            undefined,
            createMode,
            undefined,
            false,
            args.atomic === true && !privateTempCreated,
            args.timeout
        )
        uploadedTempCreated = args.atomic === true
        let verification: Record<string, unknown> | undefined
        let verificationError: unknown
        if (verificationRequested) {
            try {
                verification = await buildUploadVerification(args, local, tempRemotePath)
            } catch (error) {
                verificationError = error
                verification = verificationErrorDetails(error)
            }
        }
        verification = addUploadVerificationPaths(verification, args, tempRemotePath)
        const outcome = buildTransferOutcome(
            uploadResult.success,
            verificationRequested,
            verification,
            verificationError
        )
        const pathDetails = uploadPathDetails(args, tempRemotePath, verification)

        if (args.atomic && !outcome.success) {
            let cleanupWarning: string | undefined
            try {
                await cleanupRemotePath(args.alias, tempRemotePath, args.timeout)
            } catch (cleanupError) {
                cleanupWarning = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }
            const verificationMessage =
                verificationError instanceof Error ? verificationError.message : String(verificationError)
            return formatResult({
                ...uploadResult,
                ...outcome,
                message: `Atomic upload verification failed; existing target preserved: ${args.remotePath}`,
                error:
                    verificationError === undefined
                        ? `Atomic upload verification failed: ${args.remotePath}`
                        : `Atomic upload verification failed: ${verificationMessage}`,
                cleanupWarning,
                atomic: true,
                atomicReplaceSupported,
                targetReplaced: false,
                ...pathDetails,
                createMode: uploadResult.createMode,
                existingTargetModePreserved: remoteBefore.exists,
                suggestion: largeFileSuggestion,
                recommendedSync,
                diagnostics: {
                    local: summarizeLocalPathProbe(local),
                    remoteParent,
                    atomic: true,
                    tempRemotePath,
                },
                verification,
            })
        }

        if (args.atomic) {
            try {
                await fileOps.renameRemoteFile(
                    args.alias,
                    tempRemotePath,
                    args.remotePath,
                    remoteBefore.exists,
                    args.timeout
                )
            } catch (error) {
                const renameNotStarted = error instanceof fileOps.RemoteRenameNotStartedError
                const renameError = error instanceof Error ? error.message : String(error)
                let cleanupWarning: string | undefined
                try {
                    await cleanupRemotePath(args.alias, tempRemotePath, args.timeout)
                } catch (cleanupError) {
                    cleanupWarning = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                }
                return formatResult({
                    success: false,
                    transferSuccess: true,
                    operationStatus: renameNotStarted ? 'failed' : 'unknown',
                    retryable: true,
                    error: renameNotStarted
                        ? `Atomic SFTP rename request was not sent; target was not replaced: ${renameError}`
                        : `Atomic SFTP rename response failed; target replacement state is unknown: ${renameError}`,
                    cleanupWarning,
                    atomic: true,
                    atomicReplaceSupported,
                    targetReplaced: renameNotStarted ? false : null,
                    targetReplacementStatus: renameNotStarted ? 'not_replaced' : 'unknown',
                    ...pathDetails,
                    diagnostics: {
                        local: summarizeLocalPathProbe(local),
                        remoteParent,
                        atomic: true,
                        tempRemotePath,
                    },
                    verification,
                })
            }
        }

        const verificationMessage =
            verificationError instanceof Error ? verificationError.message : String(verificationError)
        return formatResult({
            ...uploadResult,
            ...outcome,
            message: outcome.success
                ? `Uploaded to ${args.remotePath}`
                : `Uploaded but verification failed: ${args.remotePath}`,
            error:
                verificationError === undefined
                    ? undefined
                    : `Upload completed, but verification failed: ${verificationMessage}`,
            atomic: args.atomic === true,
            atomicReplaceSupported,
            targetReplaced: args.atomic ? true : undefined,
            ...pathDetails,
            createMode: uploadResult.createMode,
            existingTargetModePreserved: remoteBefore.exists,
            suggestion: largeFileSuggestion,
            recommendedSync,
            diagnostics: {
                local: summarizeLocalPathProbe(local),
                remoteParent,
                atomic: args.atomic === true,
                tempRemotePath: args.atomic ? tempRemotePath : undefined,
            },
            verification,
        })
    } catch (error) {
        let cleanupWarning: string | undefined
        const shouldCleanupTemporaryUpload =
            args.atomic &&
            (privateTempCreated ||
                uploadedTempCreated ||
                (error instanceof fileOps.UploadFileError && error.remoteCreated))
        if (shouldCleanupTemporaryUpload) {
            try {
                await cleanupRemotePath(args.alias, tempRemotePath, args.timeout)
            } catch (cleanupError) {
                cleanupWarning = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }
        }
        return formatResult({
            success: false,
            ...sftpOperationOutcome(error),
            error: error instanceof Error ? error.message : String(error),
            cleanupWarning,
            atomicReplaceSupported,
            finalRemotePath: args.remotePath,
            diagnostics: {
                local: summarizeLocalPathProbe(local),
                remoteParent,
                remoteBefore,
                atomic: args.atomic === true,
                tempRemotePath: args.atomic ? tempRemotePath : undefined,
            },
        })
    }
}

async function handleDownload(args: z.infer<typeof downloadSchema>) {
    try {
        args.remotePath = normalizeRemotePath(args.alias, args.remotePath)
        const downloadResult = await fileOps.downloadFile(
            args.alias,
            args.remotePath,
            args.localPath,
            undefined,
            undefined,
            undefined,
            args.timeout
        )
        return formatResult({ ...downloadResult, message: `Downloaded to ${args.localPath}` })
    } catch (error) {
        return formatResult({
            success: false,
            ...sftpOperationOutcome(error),
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
        args.remotePath = normalizeRemotePath(args.alias, args.remotePath)
        const readResult = await fileOps.readFile(args.alias, args.remotePath, {
            maxBytes: args.maxBytes,
            offset: args.offset,
            tail: args.tail,
            lineRange: args.lineRange,
            encoding: args.encoding,
            binary: args.binary,
            timeout: args.timeout,
        })
        return formatResult({ success: true, ...readResult })
    } catch (error) {
        return formatFileOperationError(error)
    }
}

async function handleWriteFile(args: z.infer<typeof writeFileSchema>) {
    try {
        args.remotePath = normalizeRemotePath(args.alias, args.remotePath)
        const result = await fileOps.writeFile(args.alias, args.remotePath, args.content, args.append, args.timeout)
        return formatResult(result)
    } catch (error) {
        return formatFileOperationError(error)
    }
}

async function handleListDir(args: z.infer<typeof listDirSchema>) {
    try {
        args.remotePath = normalizeRemotePath(args.alias, args.remotePath)
        const files = await fileOps.listDir(
            args.alias,
            args.remotePath,
            args.showHidden,
            undefined,
            args.timeout,
            sessionManager.getRemotePathStyle(args.alias)
        )
        const bounded = [
            args.namePattern,
            args.modifiedAfter,
            args.modifiedBefore,
            args.offset,
            args.limit,
            args.maxBytes,
        ].some((value) => value !== undefined)
        if (!bounded) {
            return formatResult({ success: true, path: args.remotePath, count: files.length, files })
        }
        const patterns = args.namePattern === undefined ? undefined : [args.namePattern]
        const matching = files.filter(
            (file) =>
                (patterns === undefined || matchesDirectoryExclude(file.name, patterns)) &&
                (args.modifiedAfter === undefined ||
                    compareDirectoryTimes(file.mtime.toISOString(), args.modifiedAfter) >= 0) &&
                (args.modifiedBefore === undefined ||
                    compareDirectoryTimes(file.mtime.toISOString(), args.modifiedBefore) < 0)
        )
        const offset = args.offset ?? 0
        const limit = args.limit ?? 100
        const maxBytes = args.maxBytes ?? 65536
        const page = (count: number) =>
            formatResult({
                success: true,
                path: args.remotePath,
                count,
                files: matching.slice(offset, offset + count),
                total_count: matching.length,
                offset,
                has_more: offset + count < matching.length,
                next_offset: offset + count,
            })
        let lower = 0
        let upper = Math.min(limit, Math.max(0, matching.length - offset))
        let response = page(0)
        while (lower < upper) {
            const count = Math.ceil((lower + upper) / 2)
            const candidate = page(count)
            if (Buffer.byteLength(candidate.content[0].text, 'utf8') <= maxBytes) {
                lower = count
                response = candidate
            } else {
                upper = count - 1
            }
        }
        if (
            Buffer.byteLength(response.content[0].text, 'utf8') > maxBytes ||
            (lower === 0 && offset < matching.length)
        ) {
            const minimum = page(offset < matching.length ? 1 : 0)
            return {
                ...formatResult({
                    success: false,
                    code: 'LIST_DIR_MAX_BYTES_TOO_SMALL',
                    error: 'maxBytes is too small for directory page metadata and the next complete entry, if any',
                    offset,
                    next_offset: offset,
                    maxBytes,
                    requiredBytes: Buffer.byteLength(minimum.content[0].text, 'utf8'),
                }),
                isError: true,
            }
        }
        return response
    } catch (error) {
        return formatFileOperationError(error)
    }
}

async function handleFileInfo(args: z.infer<typeof fileInfoSchema>) {
    try {
        args.remotePath = normalizeRemotePath(args.alias, args.remotePath)
        const info = await fileOps.getFileInfo(
            args.alias,
            args.remotePath,
            args.timeout,
            sessionManager.getRemotePathStyle(args.alias)
        )
        return formatResult({ success: true, ...info })
    } catch (error) {
        return formatFileOperationError(error)
    }
}

async function handleMkdir(args: z.infer<typeof mkdirSchema>) {
    try {
        args.remotePath = normalizeRemotePath(args.alias, args.remotePath)
        const success = await fileOps.mkdir(
            args.alias,
            args.remotePath,
            args.recursive,
            undefined,
            args.timeout,
            sessionManager.getRemotePathStyle(args.alias)
        )
        return formatResult({ success, path: args.remotePath })
    } catch (error) {
        return formatFileOperationError(error)
    }
}

async function handleSync(args: z.infer<typeof syncSchema>) {
    const startedAt = Date.now()
    try {
        args.remotePath = normalizeRemotePath(args.alias, args.remotePath)
        const windows = sessionManager.getRemotePlatform(args.alias) === 'windows'
        if (
            windows &&
            (args.verifyOwner !== undefined || args.verifyMode !== undefined || args.verify?.owner || args.verify?.mode)
        ) {
            return formatResult({
                success: false,
                code: 'unsupported_remote_platform',
                error: 'Windows SFTP owner/mode metadata cannot verify POSIX permissions; use verify.aclSddl',
            })
        }
        if (!windows && args.verify?.aclSddl) {
            return formatResult({
                success: false,
                code: 'unsupported_remote_platform',
                error: 'verify.aclSddl requires a Windows remote platform',
            })
        }
    } catch (error) {
        return formatError(error)
    }
    if (args.verify?.deletions && args.delete !== true) {
        return formatResult({
            success: false,
            code: 'DELETION_VERIFICATION_REQUIRES_DELETE',
            error: 'verify.deletions=true requires delete=true',
        })
    }
    const operationTimeout = args.operationTimeout ?? 600_000
    const remainingTimeout = (): number => operationTimeout - (Date.now() - startedAt)
    try {
        if (args.direction === 'upload') {
            fileOps.validateSyncUploadSource(args.localPath, args.followSymlinks === true)
        } else {
            fileOps.validateLocalPathPolicy(args.localPath)
        }
    } catch (error) {
        return formatResult({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            diagnostics: {
                localBefore: summarizeLocalPathProbe(
                    fileOps.probeLocalPath(args.localPath, args.direction === 'upload' && args.followSymlinks === true)
                ),
            },
        })
    }
    const localBefore = fileOps.probeLocalPath(
        args.localPath,
        args.direction === 'upload' && args.followSymlinks === true
    )
    const diagnostics: Record<string, unknown> = {
        localBefore: summarizeLocalPathProbe(localBefore),
        remoteParent: await probeRemoteParent(args.alias, args.remotePath),
    }
    try {
        const remoteSource =
            args.direction === 'download'
                ? await fileOps.getFileInfo(args.alias, args.remotePath, remainingTimeout())
                : undefined
        const sourceIsDirectory =
            args.direction === 'upload' ? localBefore.exists && localBefore.isDirectory : remoteSource!.isDirectory
        if (!sourceIsDirectory && (args.verify?.count || args.verify?.deletions || args.verify?.staleFiles)) {
            return formatResult({
                success: false,
                transferSuccess: false,
                code: 'DIRECTORY_VERIFICATION_REQUIRES_DIRECTORY',
                error: 'verify.count, verify.deletions and verify.staleFiles require a directory source',
            })
        }
        const sourceSize = args.direction === 'upload' && localBefore.exists ? localBefore.size : remoteSource?.size
        const maxFileBytes = Math.min(
            args.verify?.maxFileBytes ?? DIRECTORY_VERIFY_DEFAULT_MAX_FILE_BYTES,
            args.verify?.maxTotalBytes ?? DIRECTORY_VERIFY_DEFAULT_MAX_TOTAL_BYTES
        )
        if (!sourceIsDirectory && args.verify?.sha256 && sourceSize !== undefined && sourceSize > maxFileBytes) {
            return formatResult({
                success: false,
                transferSuccess: false,
                verificationRequested: true,
                verificationSuccess: false,
                verificationStatus: 'skipped',
                code: 'VERIFICATION_BYTE_LIMIT',
                error: 'file verification byte budget exceeded before transfer',
                sourceSize,
                maxBytes: maxFileBytes,
            })
        }
        let deletionBaseline: DirectoryManifest | undefined
        try {
            deletionBaseline = await captureDeletionBaseline(args, remainingTimeout)
            if (deletionBaseline) {
                diagnostics.deletionBaseline = {
                    count: deletionBaseline.count,
                    limited: deletionBaseline.limited,
                    limitReason: deletionBaseline.limitReason,
                    skippedSymlinks: deletionBaseline.skippedSymlinks,
                    skippedUnsupported: deletionBaseline.skippedUnsupported,
                    unsupportedSamples: deletionBaseline.unsupportedSamples,
                }
            }
        } catch (error) {
            const verification = verificationErrorDetails(error)
            return formatResult({
                success: false,
                transferSuccess: false,
                verificationRequested: true,
                verificationSuccess: false,
                verificationStatus: 'error',
                failedChecks: ['deletions'],
                error: `Deletion baseline capture failed: ${error instanceof Error ? error.message : String(error)}`,
                verification,
                diagnostics,
            })
        }

        const transferTimeout = remainingTimeout()
        if (transferTimeout <= 0) {
            return formatResult({
                success: false,
                error: 'sync operation timeout was exhausted before transfer started',
                diagnostics,
            })
        }
        const syncResult = await fileOps.syncFiles(args.alias, args.localPath, args.remotePath, args.direction, {
            delete: args.delete,
            dryRun: args.dryRun,
            exclude: args.exclude,
            recursive: args.recursive,
            followSymlinks: args.followSymlinks,
            preflightTimeout: args.preflightTimeout,
            connectTimeout: args.connectTimeout,
            operationTimeout: transferTimeout,
            remotePathStyle: sessionManager.getRemotePathStyle(args.alias),
        })
        const localAfter = fileOps.probeLocalPath(
            args.localPath,
            args.direction === 'upload' && args.followSymlinks === true
        )
        diagnostics.localAfter = summarizeLocalPathProbe(localAfter)
        const transferredLocal =
            args.direction === 'download' && !sourceIsDirectory && localAfter.exists && localAfter.isDirectory
                ? fileOps.probeLocalPath(
                      path.join(
                          localAfter.expandedPath,
                          remotePathModule(sessionManager.getRemotePathStyle(args.alias)).basename(args.remotePath)
                      )
                  )
                : localAfter
        const verificationRequested = Boolean(
            args.verifyOwner !== undefined || args.verifyMode !== undefined || args.verify !== undefined
        )
        let verification: Record<string, unknown> | undefined
        let verificationError: unknown
        if (verificationRequested && syncResult.success) {
            try {
                const ownerModeVerification = await buildSyncUploadVerification(
                    args,
                    args.direction === 'upload' ? localBefore : localAfter,
                    remainingTimeout()
                )
                const contentVerification = sourceIsDirectory
                    ? await buildDirectorySyncVerification(
                          args,
                          args.direction === 'upload' ? localBefore : localAfter,
                          remainingTimeout(),
                          deletionBaseline
                      )
                    : await buildSingleFileSyncVerification(
                          args,
                          args.direction === 'upload' ? localBefore : transferredLocal,
                          remainingTimeout()
                      )
                verification = mergeSyncVerification(undefined, ownerModeVerification, contentVerification)
            } catch (error) {
                verificationError = error
                verification = mergeSyncVerification(undefined, verificationErrorDetails(error), undefined)
            }
        }
        const outcome = buildTransferOutcome(syncResult.success, verificationRequested, verification, verificationError)
        const verificationMessage =
            verificationError instanceof Error ? verificationError.message : String(verificationError)
        return formatResult({
            ...syncResult,
            ...outcome,
            error:
                verificationError === undefined
                    ? undefined
                    : `Sync completed, but verification failed: ${verificationMessage}`,
            transportVerification: syncResult.verification,
            verification,
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
            description: '上传本地文件到远程服务器。timeout 限制单个 SFTP 操作，超时后远端传输状态可能未知。',
            inputSchema: uploadSchema,
        },
        (args) => handleUpload(args)
    )

    server.registerTool(
        'ssh_download',
        {
            description:
                '从远程服务器原子下载文件。新文件使用 0600，替换普通文件时保留其 rwx 权限；symlink、目录和其他非普通目标会被拒绝。timeout 限制单个 SFTP 操作，超时后远端传输状态可能未知。',
            inputSchema: downloadSchema,
        },
        (args) => handleDownload(args)
    )

    server.registerTool(
        'ssh_read_file',
        {
            description: '读取远程文件内容。文本读取只返回完整 UTF-8 字符；后续读取使用响应中的 next_offset。',
            inputSchema: readFileSchema,
        },
        (args) => handleReadFile(args)
    )

    server.registerTool(
        'ssh_write_file',
        {
            description: '写入内容到远程文件。timeout 限制单个 SFTP 操作，超时后远端写入状态可能未知。',
            inputSchema: writeFileSchema,
        },
        (args) => handleWriteFile(args)
    )

    server.registerTool(
        'ssh_list_dir',
        {
            description:
                '列出远程目录内容，返回数值 mode 和 permissions 文本；名称与修改时间条件取交集，使用筛选或分页参数时默认最多 100 条、65536 UTF-8 字节，使用 next_offset 续查；完整 readdir 后分页，目录变化时不保证快照一致性',
            inputSchema: listDirSchema,
        },
        (args) => handleListDir(args)
    )

    server.registerTool(
        'ssh_file_info',
        {
            description: '获取远程文件信息（大小、数值 mode、权限文本、修改时间等）',
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

只有直连且使用已校验 key path 或可用 SSH agent 的 session 才探测 rsync；password、inline key 和 jump host session 使用 SFTP
满足 rsync 条件且本地、远端均可用 rsync 时使用 rsync，否则使用 SFTP
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
