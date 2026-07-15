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
import {
    buildRemoteDirectoryManifestCommand,
    compareDirectoryManifests,
    createEmptyDirectoryManifest,
    createLocalDirectoryManifest,
    DIRECTORY_VERIFY_MAX_ENTRIES,
    DIRECTORY_VERIFY_MAX_FILE_BYTES,
    DIRECTORY_VERIFY_MAX_TOTAL_BYTES,
    parseRemoteDirectoryManifest,
    type DirectoryManifest,
    type DirectoryVerifyRequest,
} from '../directory-verification.js'
import * as fileOps from '../file-ops.js'
import { sessionManager } from '../session-manager.js'
import { buildTransferOutcome } from '../transfer-outcome.js'
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
    preflightTimeout: z.number().int().positive().max(60000).optional().describe('传输能力预检超时，默认 10000ms'),
    connectTimeout: z.number().int().positive().max(120000).optional().describe('rsync SSH 连接超时，默认 30000ms'),
    operationTimeout: z.number().int().positive().max(3600000).optional().describe('同步操作超时，默认 600000ms'),
    verifyOwner: z.union([z.string(), z.number()]).optional().describe('upload 后校验远端 owner（用户名或 uid）'),
    verifyMode: z.string().optional().describe('upload 后校验远端权限，例如 0644 或 -rw-r--r--'),
    verify: z
        .object({
            count: z.boolean().optional().describe('校验目录条目数'),
            sha256: z.boolean().optional().describe('校验 SHA-256 root manifest'),
            owner: z.boolean().optional().describe('逐项校验 owner'),
            mode: z.boolean().optional().describe('逐项校验 mode'),
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
        .describe('有界目录校验；未传时不执行额外远端扫描'),
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

async function hashRemoteFileMd5(alias: string, remotePath: string): Promise<string> {
    const result = await sessionManager.exec(alias, `md5sum ${escapeShellArg(remotePath)} | awk '{print $1}'`, {
        timeout: 30000,
        useLoginUser: true,
        maxOutputSize: 4096,
    })
    if (!result.success) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
        throw new VerificationStageError('remote_probe', `Remote MD5 command failed: ${detail}`, true, {
            operation: 'md5',
            ...commandFailureDetails(result),
        })
    }
    const digest = result.stdout.trim().split(/\s+/)[0]
    if (!/^[a-fA-F0-9]{32}$/.test(digest)) {
        throw new VerificationStageError('remote_probe', 'Remote MD5 command returned an invalid digest', false, {
            operation: 'md5',
            ...commandFailureDetails(result),
        })
    }
    return digest
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

async function probeRemoteFile(alias: string, remotePath: string, timeout: number = 10000) {
    const escapedRemotePath = escapeShellArg(remotePath)
    const command = [
        `if [ -e ${escapedRemotePath} ]; then`,
        `stat -c '%U\t%u\t%G\t%g\t%a\t%s\t%Y\t%F' ${escapedRemotePath};`,
        'else printf missing; fi',
    ].join(' ')
    const result = await sessionManager.exec(alias, command, {
        timeout,
        useLoginUser: true,
        maxOutputSize: 4096,
    })
    if (!result.success) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
        throw new VerificationStageError('remote_probe', `Remote stat command failed: ${detail}`, true, {
            operation: 'stat',
            ...commandFailureDetails(result),
        })
    }
    if (result.stdout.trim() === 'missing') {
        return { exists: false, remotePath, probeMethod: 'stat' as const }
    }
    const fields = result.stdout.trim().split('\t')
    if (fields.length !== 8) {
        throw new VerificationStageError('remote_probe', 'Remote stat command returned malformed output', false, {
            operation: 'stat',
            ...commandFailureDetails(result),
        })
    }
    const [ownerName, ownerId, groupName, groupId, mode, size, mtimeSeconds, fileType] = fields
    const ownerIdValue = Number(ownerId)
    const groupIdValue = Number(groupId)
    const sizeValue = Number(size)
    const mtimeValue = Number(mtimeSeconds)
    if (
        !Number.isSafeInteger(ownerIdValue) ||
        ownerIdValue < 0 ||
        !Number.isSafeInteger(groupIdValue) ||
        groupIdValue < 0 ||
        !Number.isSafeInteger(sizeValue) ||
        sizeValue < 0 ||
        !Number.isFinite(mtimeValue) ||
        !/^[0-7]{3,4}$/.test(mode)
    ) {
        throw new VerificationStageError('remote_probe', 'Remote stat command returned invalid metadata', false, {
            operation: 'stat',
            ...commandFailureDetails(result),
        })
    }
    return {
        exists: true,
        remotePath,
        probeMethod: 'stat' as const,
        ownerName,
        ownerId: ownerIdValue,
        groupName,
        groupId: groupIdValue,
        mode: mode.length === 3 ? `0${mode}` : mode,
        size: sizeValue,
        mtimeMs: mtimeValue * 1000,
        fileType,
        isDirectory: fileType === 'directory',
        isFile: fileType.startsWith('regular '),
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
    if (args.verifyMode) {
        const expectedMode = normalizeExpectedMode(args.verifyMode)
        checks.mode = remote.exists && expectedMode !== undefined && remote.mode === expectedMode
    }
    if (args.verifyOwner !== undefined) {
        const expectedOwner = String(args.verifyOwner)
        checks.owner = remote.exists && (String(remote.ownerId) === expectedOwner || remote.ownerName === expectedOwner)
    }
    if (args.verifyMd5 && local.exists) {
        const [localMd5, remoteMd5] = await Promise.all([
            hashLocalFileMd5(local.resolvedPath),
            hashRemoteFileMd5(args.alias, args.remotePath),
        ])
        checks.md5 = remoteMd5 ? localMd5 === remoteMd5 : undefined
        return {
            expected: {
                owner: args.verifyOwner,
                mode: args.verifyMode ? normalizeExpectedMode(args.verifyMode) : undefined,
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
            mode: args.verifyMode ? normalizeExpectedMode(args.verifyMode) : undefined,
            size: args.verifySize && local.exists ? local.size : undefined,
            mtimeMs: args.verifyMtime && local.exists ? local.mtimeMs : undefined,
        },
        actual: remote,
        local: summarizeLocalPathProbe(local),
        remote,
        checks,
    }
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
    local: ReturnType<typeof fileOps.probeLocalPath>,
    timeout: number
): Promise<string> {
    const requestedRemote = await probeRemoteFile(args.alias, args.remotePath, timeout)
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

async function captureRemoteDirectoryManifest(
    alias: string,
    remotePath: string,
    request: DirectoryVerifyRequest,
    exclude: string[] | undefined,
    followSymlinks: boolean | undefined,
    timeout: number
): Promise<DirectoryManifest> {
    const remoteCommand = buildRemoteDirectoryManifestCommand(remotePath, request, exclude, followSymlinks)
    let remoteResult: Awaited<ReturnType<typeof sessionManager.exec>>
    try {
        remoteResult = await sessionManager.exec(alias, remoteCommand, {
            timeout,
            useLoginUser: true,
            maxOutputSize: 16 * 1024 * 1024,
        })
    } catch (error) {
        const details =
            error && typeof error === 'object' && 'details' in error
                ? (error as { details?: Record<string, unknown> }).details
                : undefined
        throw new VerificationStageError(
            'remote_manifest_command',
            boundedDiagnostic(error instanceof Error ? error.message : String(error)).text,
            true,
            { timeout, ...details }
        )
    }
    if (!remoteResult.success) {
        const detail = boundedDiagnostic(
            remoteResult.stderr || remoteResult.stdout || 'remote directory manifest failed'
        )
        throw new VerificationStageError(
            'remote_manifest_command',
            detail.text,
            remoteResult.failureKind !== 'remote_command',
            {
                ...commandFailureDetails(remoteResult),
                diagnosticBytes: detail.bytes,
                diagnosticTruncated: detail.truncated || undefined,
            }
        )
    }
    if (remoteResult.stdoutTruncated) {
        throw new VerificationStageError(
            'remote_manifest_output',
            'remote directory manifest output exceeded the 16MB response limit',
            false,
            { maxOutputSize: 16 * 1024 * 1024 }
        )
    }
    try {
        return parseRemoteDirectoryManifest(remoteResult.stdout)
    } catch (error) {
        throw new VerificationStageError(
            'remote_manifest_parse',
            error instanceof Error ? error.message : String(error),
            false
        )
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
    return args.direction === 'upload'
        ? compareDirectoryManifests(localManifest, remoteManifest, request, deletionBaseline)
        : compareDirectoryManifests(remoteManifest, localManifest, request, deletionBaseline)
}

function mergeSyncVerification(
    existing: Record<string, unknown> | undefined,
    ownerMode: Record<string, unknown> | undefined,
    directory: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
    const parts = [existing, ownerMode, directory].filter((part): part is Record<string, unknown> => Boolean(part))
    if (parts.length === 0) {
        return undefined
    }
    if (parts.length === 1) {
        return parts[0]
    }
    return {
        transport: existing,
        ownerMode,
        directory,
    }
}

async function cleanupRemotePath(alias: string, remotePath: string): Promise<void> {
    const result = await sessionManager.exec(alias, `rm -f ${escapeShellArg(remotePath)}`, {
        timeout: 10000,
        useLoginUser: true,
        maxOutputSize: 4096,
    })
    if (!result.success) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`
        throw new Error(`Temporary remote file cleanup failed: ${detail}`)
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
    let remoteBefore: Awaited<ReturnType<typeof probeRemoteFile>>
    try {
        remoteBefore = await probeRemoteFile(args.alias, args.remotePath)
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
    const sourceMode =
        local.exists && 'mode' in local && typeof local.mode === 'string'
            ? Number.parseInt(local.mode, 8) & 0o777
            : undefined
    const existingMode =
        remoteBefore.exists && remoteBefore.mode ? Number.parseInt(remoteBefore.mode, 8) & 0o777 : undefined
    const createMode = args.atomic && existingMode !== undefined ? existingMode : sourceMode
    const tempRemotePath = args.atomic
        ? `${args.remotePath}.mcp-tmp-${process.pid}-${Date.now().toString(36)}`
        : args.remotePath

    try {
        const uploadResult = await fileOps.uploadFile(
            args.alias,
            args.localPath,
            tempRemotePath,
            undefined,
            undefined,
            createMode
        )
        if (args.atomic) {
            const rename = await sessionManager.exec(
                args.alias,
                `mv -f -- ${escapeShellArg(tempRemotePath)} ${escapeShellArg(args.remotePath)}`,
                { timeout: 30000, useLoginUser: true, maxOutputSize: 4096 }
            )
            if (!rename.success) {
                const renameError =
                    rename.stderr || rename.stdout || `atomic rename failed with exit code ${rename.exitCode}`
                let cleanupWarning: string | undefined
                try {
                    await cleanupRemotePath(args.alias, tempRemotePath)
                } catch (error) {
                    cleanupWarning = error instanceof Error ? error.message : String(error)
                }
                return formatResult({
                    success: false,
                    error: renameError,
                    cleanupWarning,
                    diagnostics: {
                        local: summarizeLocalPathProbe(local),
                        remoteParent,
                        atomic: true,
                        tempRemotePath,
                    },
                })
            }
        }
        const verificationRequested = Boolean(
            args.verifyOwner !== undefined ||
            args.verifyMode !== undefined ||
            args.verifyMd5 ||
            args.verifySize ||
            args.verifyMtime
        )
        let verification: Record<string, unknown> | undefined
        let verificationError: unknown
        if (verificationRequested) {
            try {
                verification = await buildUploadVerification(args, local)
            } catch (error) {
                verificationError = error
                verification = verificationErrorDetails(error)
            }
        }
        const outcome = buildTransferOutcome(
            uploadResult.success,
            verificationRequested,
            verification,
            verificationError
        )
        return formatResult({
            ...uploadResult,
            ...outcome,
            message: outcome.success
                ? `Uploaded to ${args.remotePath}`
                : `Uploaded but verification failed: ${args.remotePath}`,
            error:
                verificationError === undefined
                    ? undefined
                    : `Upload completed, but verification failed: ${verificationError instanceof Error ? verificationError.message : String(verificationError)}`,
            atomic: args.atomic === true,
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
        if (args.atomic) {
            try {
                await cleanupRemotePath(args.alias, tempRemotePath)
            } catch (cleanupError) {
                cleanupWarning = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }
        }
        return formatResult({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            cleanupWarning,
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
    const startedAt = Date.now()
    if (args.verify?.deletions && args.delete !== true) {
        return formatResult({
            success: false,
            code: 'DELETION_VERIFICATION_REQUIRES_DELETE',
            error: 'verify.deletions=true requires delete=true',
        })
    }
    const operationTimeout = args.operationTimeout ?? 600_000
    const remainingTimeout = (): number => operationTimeout - (Date.now() - startedAt)
    const localBefore = fileOps.probeLocalPath(
        args.localPath,
        args.direction === 'upload' && args.followSymlinks === true
    )
    const diagnostics: Record<string, unknown> = {
        localBefore: summarizeLocalPathProbe(localBefore),
        remoteParent: await probeRemoteParent(args.alias, args.remotePath),
    }
    try {
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
            throw new VerificationStageError(
                'verification_timeout',
                'sync operation timeout was exhausted before transfer started',
                true
            )
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
        })
        const localAfter = fileOps.probeLocalPath(
            args.localPath,
            args.direction === 'upload' && args.followSymlinks === true
        )
        diagnostics.localAfter = summarizeLocalPathProbe(localAfter)
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
                const directoryVerification = await buildDirectorySyncVerification(
                    args,
                    args.direction === 'upload' ? localBefore : localAfter,
                    remainingTimeout(),
                    deletionBaseline
                )
                verification = mergeSyncVerification(undefined, ownerModeVerification, directoryVerification)
            } catch (error) {
                verificationError = error
                verification = mergeSyncVerification(undefined, verificationErrorDetails(error), undefined)
            }
        }
        const outcome = buildTransferOutcome(syncResult.success, verificationRequested, verification, verificationError)
        return formatResult({
            ...syncResult,
            ...outcome,
            error:
                verificationError === undefined
                    ? undefined
                    : `Sync completed, but verification failed: ${verificationError instanceof Error ? verificationError.message : String(verificationError)}`,
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
