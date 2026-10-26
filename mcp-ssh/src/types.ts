/**
 * SSH MCP Pro - 类型定义
 */

import type { Readable } from 'stream'

export interface CommandChannel extends Readable {
    readonly stderr: Readable
    readonly ready?: Promise<void>
    close(): void
}

export interface OpenSshMasterInfo {
    backend: 'openssh'
    masterReused: true
    identityStatus: 'master_trusted'
    masterPid: number
    observedLogin?: { uid: number; username: string; sshConnection?: string }
}

export const DEFAULT_EXEC_MAX_OUTPUT_SIZE = 10 * 1024 * 1024
export const HARD_EXEC_MAX_OUTPUT_SIZE = 50 * 1024 * 1024

export type RemotePlatform = 'posix' | 'windows'
export type CommandShell = 'posix' | 'cmd' | 'powershell'
export type RemotePathStyle = 'posix' | 'win32' | 'sftp-posix'
export type RsyncProfile = 'posix' | 'native-win32' | 'msys2' | 'cygwin'

export interface SSHConnectionConfig {
    backend?: 'ssh2' | 'openssh'
    controlPath?: string
    host: string
    port: number
    username: string
    password?: string
    privateKeyPath?: string
    privateKey?: string
    passphrase?: string
    agent?: string // "none" explicitly disables agent authentication and SSH_AUTH_SOCK fallback
    remotePlatform?: RemotePlatform
    commandShell?: CommandShell
    remotePathStyle?: RemotePathStyle
    rsyncExecutable?: string
    rsyncProfile?: RsyncProfile
    alias?: string
    template?: string
    runAs?: string
    defaultEnv?: Record<string, string>
    // 高级配置
    keepaliveInterval?: number // 心跳间隔（毫秒）
    keepaliveCountMax?: number // 最大心跳失败次数
    readyTimeout?: number // 连接超时（毫秒）
    // 环境配置
    env?: Record<string, string> // 环境变量
    lang?: string // LANG 设置
    shell?: string // Shell 类型
    // 跳板机
    jumpHost?: SSHConnectionConfig
}

export interface SSHSessionBrief {
    backend?: 'ssh2' | 'openssh'
    masterReused?: boolean
    identityStatus?: 'master_trusted'
    alias: string
    identity: string
    runAs?: string
    connected: boolean
    lastUsedAt: number
}

export interface SSHSessionDetail extends SSHSessionBrief {
    host: string
    port: number
    username: string
    authMethod: 'key' | 'password' | 'agent' | 'inline-key' | 'master'
    connectedAt: number
    hasJumpHost: boolean
    remotePlatform: RemotePlatform
    commandShell: CommandShell
    remotePathStyle: RemotePathStyle
}

export interface ExternalTransferCapability {
    backend?: 'ssh2' | 'openssh'
    controlPath?: string
    alias: string
    identity: string
    host: string
    port: number
    username: string
    authMethod: 'key-path' | 'password' | 'agent' | 'inline-key' | 'master'
    keyPath?: string
    hasJumpHost: boolean
    routeSafeForOpenSsh: boolean
    rsyncEligible: boolean
    decisionReason: string
    agent?: string
    rsyncExecutable?: string
    rsyncProfile?: RsyncProfile
    commandShell?: CommandShell
    remotePathStyle?: RemotePathStyle
}

export type ConnectionFailureStage =
    'preflight' | 'authentication' | 'ready_timeout' | 'transport_or_handshake' | 'unknown'

export type ConnectionStep = 'key_read' | 'jump_connect' | 'jump_forward' | 'target_connect'

export interface ConnectionFailureDetails {
    failureStage: ConnectionFailureStage
    connectionStep?: ConnectionStep
    retryable: boolean
    suggestion?: string
    keyAclStatus?: 'key_path_usable' | 'key_acl_insecure' | 'key_acl_unverified'
}

export interface ExecOptions {
    timeout?: number // 命令超时（毫秒）
    env?: Record<string, string> // 额外环境变量
    cwd?: string // 工作目录
    pty?: boolean // 是否使用 PTY
    maxOutputSize?: number // stdout/stderr 各自允许返回的 UTF-8 字节数
    // PTY 配置
    rows?: number
    cols?: number
    term?: string
    runAs?: string
    useLoginUser?: boolean
    loadProfile?: boolean
    skipSessionEnv?: boolean
}

export interface ExecResult {
    success: boolean
    stdout: string
    stderr: string
    exitCode: number
    duration: number // 执行时间（毫秒）
    failureKind?: 'remote_command' | 'ssh_transport' | 'timeout'
    stdoutTruncated?: boolean
    stderrTruncated?: boolean
    maxOutputSize?: number
    stdoutHead?: string
    stdoutTail?: string
    stderrHead?: string
    stderrTail?: string
    stdoutBytes?: number
    stderrBytes?: number
    recommendedReadCommand?: string
    suggestion?: string
    emptyOutputFailure?: boolean
    loginUser?: string
    effectiveUser?: string
    identity?: string
    cwd?: string
    resolvedCwd?: string
    shell?: string
    profileLoaded?: boolean
    envInjectedKeys?: string[]
    timedOut?: boolean
}

export type OperationStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'

export interface OperationStartOptions {
    cwd?: string
    env?: Record<string, string>
    runAs?: string
    useLoginUser?: boolean
    loadProfile?: boolean
    maxOutputBytes?: number
    retentionMs?: number
    startTimeoutMs?: number
}

export interface OperationInfo {
    operationId: string
    alias: string
    status: OperationStatus
    pid: number | null
    processGroup: boolean
    markerVerified: boolean
    processCreatedAt?: string
    cancelRequested: boolean
    startedAt: number
    finishedAt: number | null
    expiresAt: number | null
    retentionMs: number
    exitCode: number | null
    signal: string | null
    stdoutBytes: number
    stderrBytes: number
    stdoutStoredBytes: number
    stderrStoredBytes: number
    stdoutTruncated: boolean
    stderrTruncated: boolean
    maxOutputBytes: number
    error?: string
}

export interface OperationReadResult extends OperationInfo {
    stdout: string
    stderr: string
    stdoutOffset: number
    stderrOffset: number
    nextStdoutOffset: number
    nextStderrOffset: number
    readBytes: number
    maxReadBytes: number
}

export interface OperationCancelResult extends OperationInfo {
    success: boolean
    cancelRequested: boolean
    retryable: boolean
    cancellationStatus: 'requested' | 'unknown' | 'unsupported' | 'not_applicable'
    verificationError?: string
}

export interface FileInfo {
    name: string
    path: string
    size: number
    isDirectory: boolean
    isFile: boolean
    isSymlink: boolean
    mode: number
    permissions: string
    owner: number
    group: number
    mtime: Date
    atime: Date
}

export interface TransferProgress {
    transferred: number
    total: number
    percent: number
}

// 持久化存储的会话配置（不含敏感信息）
export interface PersistedSession {
    alias: string
    host: string
    port: number
    username: string
    runAs?: string
    connectedAt: number
}

// PTY 会话配置
export interface PtyOptions {
    rows?: number
    cols?: number
    term?: string
    env?: Record<string, string>
    cwd?: string
    bufferSize?: number // 输出缓冲区大小，默认 1MB
}

// PTY 会话信息
export interface PtySessionInfo {
    id: string
    alias: string // SSH 连接别名
    command: string // 启动命令
    rows: number
    cols: number
    createdAt: number
    lastInputAt: number | null
    lastOutputAt: number | null
    lastReadAt: number
    bufferSize: number // 当前 raw 缓冲区的原始字节数
    unreadRawBytes: number
    rawBufferLimit: number
    rawBufferTruncated: boolean
    foregroundProcess: string
    active: boolean
}

export interface PtyReadResult {
    data: string
    dataBase64?: string
    active: boolean
    rows: number
    cols: number
    lastInputAt: number | null
    lastOutputAt: number | null
    lastReadAt: number
    unreadRawBytes: number
    rawBufferLimit: number
    rawBufferTruncated: boolean
    foregroundProcess: string
}

export interface PtyWriteResult {
    accepted: true
    backpressured: boolean
}

export type PtyCloseStatus = 'closed' | 'not_found' | 'failed' | 'unknown'

export interface PtyCloseResult {
    success: boolean
    ptyId: string
    status: PtyCloseStatus
    retryable: boolean
    error?: string
}

// 端口转发类型
export type ForwardType = 'local' | 'remote'

export type ForwardLifecycle = 'pending' | 'active' | 'closing' | 'closed'

// 端口转发信息
export interface PortForwardInfo {
    id: string
    alias: string // SSH 连接别名
    type: ForwardType
    localHost: string
    localPort: number
    remoteHost: string
    remotePort: number
    createdAt: number
    active: boolean
    lifecycle: ForwardLifecycle
    acceptingConnections: boolean
}

export type ForwardCloseMode = 'graceful' | 'force'

export interface ForwardCloseOptions {
    mode?: ForwardCloseMode
    timeoutMs?: number
}

export interface ForwardCloseResult {
    success: boolean
    forwardId: string
    type?: ForwardType
    closeMode: ForwardCloseMode
    listenerReleased: boolean
    remoteUnforwarded: boolean
    activeConnections: number
    retryable: boolean
    error?: string
}
