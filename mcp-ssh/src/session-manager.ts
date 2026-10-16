/**
 * SSH Session Manager - 连接池管理
 *
 * 功能：
 * - 连接池复用
 * - 心跳保持
 * - 自动重连
 * - 会话持久化
 */

import { createHash, randomUUID } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Client, ClientChannel, ConnectConfig, ExecOptions as Ssh2ExecOptions, SFTPWrapper } from 'ssh2'
import { StringDecoder } from 'string_decoder'
import { isUtf8ContinuationByte, retainUtf8Suffix } from './utf8.js'
import { clearRsyncCache } from './file-ops.js'
import { ForwardManager } from './forward-manager.js'
import { OperationManager } from './operation-manager.js'
import { PtyManager } from './pty-manager.js'
import { buildRemoteCommand, encodedPowershell, quotePowershell, remotePathStyle } from './remote-platform.js'
import { sanitizeKeyError, validateKeyFile } from './security.js'
import { escapeShellArg, expandTilde } from './tools/utils.js'
import { checkWindowsAcl } from './windows-acl.js'
import {
    ConnectionFailureDetails,
    DEFAULT_EXEC_MAX_OUTPUT_SIZE,
    ExecOptions,
    ExecResult,
    ExternalTransferCapability,
    ForwardCloseOptions,
    ForwardCloseResult,
    HARD_EXEC_MAX_OUTPUT_SIZE,
    OperationCancelResult,
    OperationInfo,
    OperationReadResult,
    OperationStartOptions,
    PersistedSession,
    PortForwardInfo,
    PtyCloseResult,
    PtyOptions,
    PtyReadResult,
    PtySessionInfo,
    PtyWriteResult,
    SSHConnectionConfig,
    SSHSessionBrief,
    SSHSessionDetail,
} from './types.js'

interface SSHSession {
    client: Client
    config: SSHConnectionConfig
    connectedAt: number
    lastUsedAt: number
    reconnectAttempts: number
    connected: boolean // 通过事件监听维护的连接状态
    authAgent?: string
    manualClose: boolean // 标记主动关闭，阻止 close 事件触发自动重连
    /** 当前正在等待的重连定时器,disconnect 时需要清除以防 zombie 重连 */
    reconnectTimer?: NodeJS.Timeout
}

interface PendingConnection {
    client?: Client
    generation: number
    fingerprint: string
    cancel(error: Error): void
}

interface InFlightConnection {
    identity: string
    fingerprint: string
    promise: Promise<string>
}

interface SessionConnectionInfo {
    alias: string
    identity: string
    loginUser: string
    runAs?: string
    host: string
    port: number
    defaultEnvKeys: string[]
    envKeys: string[]
    hasJumpHost: boolean
    remotePlatform: 'posix' | 'windows'
    commandShell: 'posix' | 'cmd' | 'powershell'
    remotePathStyle: 'posix' | 'win32' | 'sftp-posix'
    keyAclStatus?: 'key_path_usable' | 'key_acl_insecure' | 'key_acl_unverified'
}

interface CommandContext {
    runAs?: string
    loadProfile?: boolean
    cwd?: string
    envInjectedKeys?: string[]
}

interface OutputPreview {
    stdout: string
    stderr: string
    stdoutTail: string
    stderrTail: string
    stdoutBytes: number
    stderrBytes: number
    stdoutTruncated?: boolean
    stderrTruncated?: boolean
    maxOutputSize?: number
}

const OUTPUT_PREVIEW_CHARS = 4096

class CommandError extends Error {
    constructor(
        message: string,
        readonly details: Record<string, unknown>
    ) {
        super(message)
        this.name = 'CommandError'
    }
}

class ConnectionError extends Error {
    constructor(
        message: string,
        readonly details: ConnectionFailureDetails
    ) {
        super(message)
        this.name = 'ConnectionError'
    }
}

export class SessionManager {
    private sessions: Map<string, SSHSession> = new Map()
    /** per-alias connect 进行中的 Promise,防止并发 connect 同一 alias 时重复建连 */
    private connectInFlight: Map<string, InFlightConnection> = new Map()
    private pendingConnections: Map<string, PendingConnection> = new Map()
    private connectionGenerations: Map<string, number> = new Map()
    private readonly ptyManager = new PtyManager()
    private readonly forwardManager = new ForwardManager()
    private readonly operationManager: OperationManager
    private readonly persistPath: string
    private persistQueue: Promise<void> = Promise.resolve()
    private defaultKeepaliveInterval = 30000 // 30秒
    private defaultKeepaliveCountMax = 3
    private defaultTimeout = 30000 // 30秒
    private maxReconnectAttempts = 3
    private defaultMaxOutputSize = DEFAULT_EXEC_MAX_OUTPUT_SIZE
    private reconnectDelay = 5000 // 5秒

    constructor(persistPath?: string) {
        this.persistPath = persistPath || path.join(os.homedir(), '.ssh-mcp-pro', 'sessions.json')
        this.operationManager = new OperationManager({
            openStream: (alias, command, marker, options, adopt) =>
                this.openOperationStream(alias, command, marker, options, adopt),
            cancelRemote: (alias, pid, marker, processGroup, options, processCreatedAt) =>
                this.cancelRemoteOperation(alias, pid, marker, processGroup, options, processCreatedAt),
        })
        this.ensurePersistDir()
    }

    /**
     * 建立 SSH 连接（per-alias mutex，防止并发 connect 同一 alias 重复建连）
     */
    async connect(config: SSHConnectionConfig): Promise<string> {
        const platform = config.remotePlatform ?? 'posix'
        const shell = config.commandShell ?? (platform === 'windows' ? 'powershell' : 'posix')
        if ((platform === 'windows') !== (shell !== 'posix')) {
            throw new CommandError('commandShell must match remotePlatform', {
                code: 'unsupported_remote_platform',
                platform,
                shell,
            })
        }
        if (platform === 'windows' && config.runAs) {
            throw new CommandError('runAs is not supported for Windows remote hosts', {
                code: 'unsupported_remote_platform',
            })
        }
        const alias = this.generateAlias(config)

        const fingerprint = this.connectionFingerprint(config)
        const requestedIdentity = this.configIdentity(config)
        const inFlight = this.connectInFlight.get(alias)
        if (inFlight) {
            if (inFlight.fingerprint !== fingerprint) {
                throw new CommandError(`Alias '${alias}' already has a different connection attempt in progress`, {
                    alias,
                    existingIdentity: inFlight.identity,
                    requestedIdentity,
                    suggestion: '请等待当前连接完成、换一个 alias，或先 ssh_disconnect 取消当前连接',
                })
            }
            return inFlight.promise
        }

        const generation = this.getConnectionGeneration(alias)
        let rejectCancellation: (error: Error) => void = () => undefined
        let cancelled = false
        const cancellation = new Promise<never>((_resolve, reject) => {
            rejectCancellation = reject
        })
        const pendingConnection: PendingConnection = {
            generation,
            fingerprint,
            cancel: (error) => {
                if (cancelled) {
                    return
                }
                cancelled = true
                try {
                    pendingConnection.client?.end()
                } catch {
                    /* client 可能尚未开始连接或已经关闭 */
                }
                rejectCancellation(error)
            },
        }
        this.pendingConnections.set(alias, pendingConnection)
        const connectAttempt = Promise.race([this.connectInternal(config, alias, pendingConnection), cancellation])
        const promise = connectAttempt.finally(() => {
            if (this.connectInFlight.get(alias)?.promise === promise) {
                this.connectInFlight.delete(alias)
            }
            if (this.pendingConnections.get(alias) === pendingConnection) {
                this.pendingConnections.delete(alias)
            }
        })
        this.connectInFlight.set(alias, { identity: requestedIdentity, fingerprint, promise })
        return promise
    }

    /**
     * 重新连接
     */
    async reconnect(alias: string): Promise<void> {
        const session = this.sessions.get(alias)
        if (!session) {
            throw new Error(`Session ${alias} not found`)
        }

        this.cancelPendingConnection(alias)
        session.manualClose = true
        session.connected = false
        if (session.reconnectTimer) {
            clearTimeout(session.reconnectTimer)
            session.reconnectTimer = undefined
        }
        this.invalidateAliasResources(alias)

        try {
            session.client.end()
        } catch {
            /* 忽略已关闭的连接 */
        }

        await this.connect(session.config)
    }

    /**
     * 断开连接
     */
    disconnect(alias: string): boolean {
        const pendingCancelled = this.cancelPendingConnection(alias)
        const session = this.sessions.get(alias)
        if (session) {
            session.manualClose = true
            // 清掉重连定时器,防止 disconnect 后还在尝试自动重连
            if (session.reconnectTimer) {
                clearTimeout(session.reconnectTimer)
                session.reconnectTimer = undefined
            }
            this.invalidateAliasResources(alias)
            try {
                session.client.end()
            } catch {
                /* 忽略已关闭的连接 */
            }
            this.sessions.delete(alias)
            this.persistSessions()
            return true
        }
        return pendingCancelled
    }

    /** 断开所有活跃会话（SIGINT/SIGTERM 时调用） */
    async disconnectAll(): Promise<void> {
        const aliases = new Set([...this.sessions.keys(), ...this.pendingConnections.keys()])
        for (const alias of aliases) {
            this.disconnect(alias)
        }
    }

    /**
     * 获取会话
     */
    getSession(alias: string): SSHSession {
        const session = this.sessions.get(alias)
        if (!session) {
            throw new Error(`Session '${alias}' not found. Use ssh_connect first.`)
        }
        if (!this.isAlive(session)) {
            throw new Error(`Session '${alias}' is disconnected. Use ssh_connect to reconnect.`)
        }
        session.lastUsedAt = Date.now()
        return session
    }

    listSessions(): SSHSessionBrief[] {
        return Array.from(this.sessions, ([alias, session]) => ({
            alias,
            identity: this.sessionIdentity(session),
            runAs: session.config.runAs,
            connected: this.isAlive(session),
            lastUsedAt: session.lastUsedAt,
        }))
    }

    listSessionDetails(): SSHSessionDetail[] {
        return Array.from(this.sessions, ([alias, session]) => ({
            alias,
            identity: this.sessionIdentity(session),
            host: session.config.host,
            port: session.config.port ?? 22,
            username: session.config.username,
            runAs: session.config.runAs,
            authMethod: session.config.privateKeyPath
                ? 'key'
                : session.config.privateKey
                  ? 'inline-key'
                  : session.config.password
                    ? 'password'
                    : 'agent',
            connected: this.isAlive(session),
            connectedAt: session.connectedAt,
            lastUsedAt: session.lastUsedAt,
            hasJumpHost: Boolean(session.config.jumpHost),
            remotePlatform: session.config.remotePlatform ?? 'posix',
            commandShell:
                session.config.commandShell ?? (session.config.remotePlatform === 'windows' ? 'powershell' : 'posix'),
            remotePathStyle: remotePathStyle(session.config.remotePlatform ?? 'posix', session.config.remotePathStyle),
        }))
    }

    getSessionConnectionInfo(alias: string): SessionConnectionInfo {
        const session = this.getSession(alias)
        const config = session.config
        return {
            alias,
            identity: this.sessionIdentity(session),
            loginUser: config.username,
            runAs: config.runAs,
            host: config.host,
            port: config.port ?? 22,
            defaultEnvKeys: config.defaultEnv ? Object.keys(config.defaultEnv) : [],
            envKeys: config.env ? Object.keys(config.env) : [],
            hasJumpHost: Boolean(config.jumpHost),
            remotePlatform: config.remotePlatform ?? 'posix',
            commandShell: config.commandShell ?? (config.remotePlatform === 'windows' ? 'powershell' : 'posix'),
            remotePathStyle: remotePathStyle(config.remotePlatform ?? 'posix', config.remotePathStyle),
            keyAclStatus:
                process.platform === 'win32' && config.privateKeyPath
                    ? checkWindowsAcl(expandTilde(config.privateKeyPath))
                    : undefined,
        }
    }

    requirePosixPrivilege(alias: string): void {
        if (this.getRemotePlatform(alias) === 'windows') {
            throw new CommandError('Remote Windows does not support su/sudo/runAs', {
                code: 'unsupported_remote_platform',
                remotePlatform: 'windows',
            })
        }
    }

    getRemotePlatform(alias: string): 'posix' | 'windows' {
        return this.getSession(alias).config.remotePlatform ?? 'posix'
    }

    getRemotePathStyle(alias: string): 'posix' | 'win32' | 'sftp-posix' {
        const config = this.getSession(alias).config
        return remotePathStyle(config.remotePlatform ?? 'posix', config.remotePathStyle)
    }

    getCommandShell(alias: string): 'posix' | 'cmd' | 'powershell' {
        const config = this.getSession(alias).config
        return config.commandShell ?? (config.remotePlatform === 'windows' ? 'powershell' : 'posix')
    }

    getExternalTransferCapability(alias: string): ExternalTransferCapability {
        const session = this.getSession(alias)
        const config = session.config
        const authMethod = config.privateKeyPath
            ? ('key-path' as const)
            : config.privateKey
              ? ('inline-key' as const)
              : config.password
                ? ('password' as const)
                : ('agent' as const)
        const hasJumpHost = Boolean(config.jumpHost)
        const routeSafeForOpenSsh = !hasJumpHost
        const expandedKeyPath = config.privateKeyPath ? expandTilde(config.privateKeyPath) : undefined
        const keyPathUsable = authMethod === 'key-path' && this.isOpenSshKeyPathUsable(expandedKeyPath!)
        const agent = session.authAgent ?? config.agent
        const agentAvailable = authMethod === 'agent' && this.isSshAgentAvailable(agent)
        const profileRequired =
            (process.platform === 'win32' || config.remotePlatform === 'windows') && !config.rsyncProfile
        const rsyncEligible = routeSafeForOpenSsh && (keyPathUsable || agentAvailable) && !profileRequired
        const decisionReason = hasJumpHost
            ? 'jump_host_route_requires_live_ssh_session'
            : authMethod === 'password'
              ? 'password_not_forwarded_to_openssh'
              : authMethod === 'inline-key'
                ? 'inline_private_key_not_written_to_disk'
                : authMethod === 'key-path' && !keyPathUsable
                  ? 'key_path_not_openssh_compatible'
                  : authMethod === 'agent' && !agentAvailable
                    ? agent
                        ? 'ssh_agent_not_openssh_compatible'
                        : 'ssh_agent_socket_unavailable'
                    : profileRequired
                      ? 'rsync_profile_required_for_windows'
                      : authMethod === 'key-path'
                        ? 'direct_openssh_compatible_key_path'
                        : 'direct_ssh_agent_socket'
        return {
            alias,
            identity: this.sessionIdentity(session),
            host: config.host,
            port: config.port ?? 22,
            username: config.username,
            authMethod,
            keyPath: keyPathUsable ? expandedKeyPath : undefined,
            hasJumpHost,
            routeSafeForOpenSsh,
            rsyncEligible,
            decisionReason,
            agent: config.agent === 'none' ? 'none' : agentAvailable ? agent : undefined,
            rsyncExecutable: config.rsyncExecutable,
            rsyncProfile: config.rsyncProfile,
            commandShell: config.commandShell ?? (config.remotePlatform === 'windows' ? 'powershell' : 'posix'),
            remotePathStyle: remotePathStyle(config.remotePlatform ?? 'posix', config.remotePathStyle),
        }
    }

    /**
     * 执行命令
     */
    async exec(alias: string, command: string, options: ExecOptions = {}): Promise<ExecResult> {
        const session = this.getSession(alias)
        const runAs = options.useLoginUser ? undefined : (options.runAs ?? session.config.runAs)
        if (runAs) {
            return this.execAsUser(alias, command, runAs, options)
        }
        return this.execDirect(alias, command, options, { cwd: options.cwd })
    }

    operationStart(alias: string, command: string, options: OperationStartOptions = {}): Promise<OperationInfo> {
        if (options.runAs || (this.getSession(alias).config.runAs && !options.useLoginUser)) {
            this.requirePosixPrivilege(alias)
        }
        return this.operationManager.start(alias, command, options)
    }

    operationStatus(operationId: string): OperationInfo {
        return this.operationManager.status(operationId)
    }

    operationRead(
        operationId: string,
        options: { stdoutOffset?: number; stderrOffset?: number; maxBytes?: number } = {}
    ): OperationReadResult {
        return this.operationManager.read(operationId, options)
    }

    operationCancel(operationId: string): Promise<OperationCancelResult> {
        return this.operationManager.cancel(operationId)
    }

    operationList(alias?: string): OperationInfo[] {
        return this.operationManager.list(alias)
    }

    /**
     * 以其他用户身份执行命令
     *
     * options.loadProfile 控制是否加载用户的 shell 配置（默认 true）
     * su -c 创建非交互式 shell，不会自动执行 rc 文件，
     * 但大多数用户的环境变量设置在 rc 文件中，因此默认加载
     * 支持 bash(.bashrc)、zsh(.zshrc) 及其他 shell(.profile)
     */
    async execAsUser(
        alias: string,
        command: string,
        targetUser: string,
        options: ExecOptions & { loadProfile?: boolean } = {}
    ): Promise<ExecResult> {
        this.requirePosixPrivilege(alias)
        // 校验用户名防止注入
        if (!this.isValidUsername(targetUser)) {
            throw new Error(`Invalid username: ${targetUser}`)
        }

        const { loadProfile = true, ...execOpts } = options
        const session = this.getSession(alias)
        const wrappedCommand = loadProfile ? `${this.getLoadProfileCommand()}${command}` : command
        const targetCommand = this.buildCommand(wrappedCommand, session, execOpts)
        const suCommand = `su - ${targetUser} -c ${this.escapeShellArg(targetCommand)}`
        const env = { ...session.config.defaultEnv, ...session.config.env, ...execOpts.env }

        return this.execDirect(
            alias,
            suCommand,
            { ...execOpts, env: undefined, cwd: undefined, runAs: undefined, useLoginUser: true, skipSessionEnv: true },
            {
                runAs: targetUser,
                loadProfile,
                cwd: execOpts.cwd,
                envInjectedKeys: Object.keys(env).filter((key) => this.isValidEnvKey(key)),
            }
        )
    }

    /**
     * 使用 sudo 执行命令
     *
     * 通过 stdin 传递密码，避免密码出现在进程列表和 audit 日志中
     */
    async execSudo(
        alias: string,
        command: string,
        sudoPassword?: string,
        options: ExecOptions = {}
    ): Promise<ExecResult> {
        this.requirePosixPrivilege(alias)
        if (!sudoPassword) {
            return this.exec(alias, `sudo ${command}`, options)
        }
        const session = this.getSession(alias)
        const startTime = Date.now()
        const timeout = options.timeout ?? this.defaultTimeout
        const maxOutputSize = this.normalizeMaxOutputSize(options.maxOutputSize)
        const runAs = options.useLoginUser ? undefined : (options.runAs ?? session.config.runAs)
        let fullCommand: string
        let context: CommandContext
        if (runAs) {
            if (!this.isValidUsername(runAs)) {
                throw new Error(`Invalid username: ${runAs}`)
            }
            const loadProfile = options.loadProfile ?? true
            const targetCommand = this.buildCommand(
                `${loadProfile ? this.getLoadProfileCommand() : ''}sudo -S ${command}`,
                session,
                options
            )
            const env = { ...session.config.defaultEnv, ...session.config.env, ...options.env }
            fullCommand = `su - ${runAs} -c ${this.escapeShellArg(targetCommand)}`
            context = {
                runAs,
                loadProfile,
                cwd: options.cwd,
                envInjectedKeys: Object.keys(env).filter((key) => this.isValidEnvKey(key)),
            }
        } else {
            fullCommand = this.buildCommand(`sudo -S ${command}`, session, options)
            context = { cwd: options.cwd }
        }

        return new Promise<ExecResult>((resolve, reject) => {
            let settled = false
            let streamRef: ClientChannel | null = null
            let stdout = ''
            let stderr = ''
            let stdoutTail = ''
            let stderrTail = ''
            let stdoutBytes = 0
            let stderrBytes = 0
            let stdoutKeptBytes = 0
            let stderrKeptBytes = 0
            let stdoutTruncated = false
            let stderrTruncated = false
            const stdoutDecoder = new StringDecoder('utf8')
            const stderrDecoder = new StringDecoder('utf8')
            let decodersEnded = false
            const appendStdout = (chunk: string): void => {
                stdoutTail = this.appendOutputTail(stdoutTail, chunk)
                if (!stdoutTruncated) {
                    const appended = this.appendWithinByteLimit(stdout, chunk, maxOutputSize - stdoutKeptBytes)
                    stdout = appended.text
                    stdoutKeptBytes += appended.appendedBytes
                    stdoutTruncated = appended.truncated
                }
            }
            const appendStderr = (chunk: string): void => {
                stderrTail = this.appendOutputTail(stderrTail, chunk)
                if (!stderrTruncated) {
                    const appended = this.appendWithinByteLimit(stderr, chunk, maxOutputSize - stderrKeptBytes)
                    stderr = appended.text
                    stderrKeptBytes += appended.appendedBytes
                    stderrTruncated = appended.truncated
                }
            }
            const endDecoders = (): void => {
                if (decodersEnded) {
                    return
                }
                decodersEnded = true
                appendStdout(stdoutDecoder.end())
                appendStderr(stderrDecoder.end())
            }
            const outputPreview = (): OutputPreview => ({
                stdout,
                stderr,
                stdoutTail,
                stderrTail,
                stdoutBytes,
                stderrBytes,
                stdoutTruncated,
                stderrTruncated,
                maxOutputSize,
            })
            const timeoutId = setTimeout(() => {
                if (settled) {
                    return
                }
                settled = true
                endDecoders()
                try {
                    streamRef?.close()
                } catch {
                    // ignore
                }
                reject(this.createCommandTimeoutError(alias, timeout, context, outputPreview()))
            }, timeout)

            session.client.exec(fullCommand, {}, (err, stream) => {
                if (!this.isCurrentSession(alias, session)) {
                    clearTimeout(timeoutId)
                    this.closeClientChannel(stream)
                    if (!settled) {
                        settled = true
                        endDecoders()
                        reject(new Error('Sudo exec was cancelled because the SSH session changed'))
                    }
                    return
                }
                if (err) {
                    clearTimeout(timeoutId)
                    if (!settled) {
                        settled = true
                        endDecoders()
                        reject(new Error(`Exec failed: ${err.message}`))
                    }
                    return
                }
                if (settled) {
                    this.closeClientChannel(stream)
                    return
                }

                streamRef = stream

                // 密码写入 stdin，sudo -S 从 stdin 读取，不出现在命令行
                stream.write(sudoPassword + '\n')
                stream.end()

                stream.on('close', (code: number) => {
                    clearTimeout(timeoutId)
                    if (settled) {
                        return
                    }
                    settled = true
                    endDecoders()
                    resolve({
                        success: code === 0,
                        stdout,
                        stderr,
                        exitCode: code,
                        duration: Date.now() - startTime,
                        failureKind: code === 0 ? undefined : 'remote_command',
                        stdoutTruncated: stdoutTruncated || undefined,
                        stderrTruncated: stderrTruncated || undefined,
                        ...this.outputMetadata(outputPreview()),
                        ...this.emptyOutputFailureMetadata(code, outputPreview()),
                        ...this.resultMetadata(session, options, context),
                    })
                })

                stream.on('data', (data: Buffer) => {
                    if (settled) {
                        return
                    }
                    stdoutBytes += data.length
                    appendStdout(stdoutDecoder.write(data))
                })

                stream.stderr.on('data', (data: Buffer) => {
                    if (settled) {
                        return
                    }
                    stderrBytes += data.length
                    appendStderr(stderrDecoder.write(data))
                })
            })
        })
    }

    /**
     * 获取 SFTP 客户端
     */
    getSftp(alias: string): Promise<SFTPWrapper> {
        const session = this.getSession(alias)
        return new Promise((resolve, reject) => {
            session.client.sftp((err, sftp) => {
                if (!this.isCurrentSession(alias, session)) {
                    this.destroySftp(sftp)
                    reject(new Error('SFTP request was cancelled because the SSH session changed'))
                    return
                }
                if (err) {
                    reject(err)
                    return
                }
                resolve(sftp)
            })
        })
    }

    async ptyStart(alias: string, command: string, options: PtyOptions = {}): Promise<string> {
        return this.ptyManager.start(
            {
                execPty: (a, cmd, opts) => this.execPtyStream(a, cmd, opts),
            },
            alias,
            command,
            options
        )
    }

    // ===== PTY 委托 =====

    ptyWrite(ptyId: string, data: string): PtyWriteResult {
        return this.ptyManager.write(ptyId, data)
    }

    ptyRead(ptyId: string, options: { mode?: 'screen' | 'raw'; clear?: boolean } = {}): PtyReadResult {
        return this.ptyManager.read(ptyId, options)
    }

    ptyResize(ptyId: string, rows: number, cols: number): boolean {
        return this.ptyManager.resize(ptyId, rows, cols)
    }

    ptyClose(ptyId: string): PtyCloseResult {
        return this.ptyManager.close(ptyId)
    }

    ptyList(): PtySessionInfo[] {
        return this.ptyManager.list()
    }

    async forwardLocal(
        alias: string,
        localPort: number,
        remoteHost: string,
        remotePort: number,
        localHost: string = '127.0.0.1'
    ): Promise<{ forwardId: string; localPort: number }> {
        return this.forwardManager.forwardLocal(
            { getClient: (a) => this.getSession(a).client },
            alias,
            localPort,
            remoteHost,
            remotePort,
            localHost
        )
    }

    // ===== Forward 委托 =====

    async forwardRemote(
        alias: string,
        remotePort: number,
        localHost: string,
        localPort: number,
        remoteHost: string = '127.0.0.1'
    ): Promise<{ forwardId: string; remotePort: number }> {
        return this.forwardManager.forwardRemote(
            { getClient: (a) => this.getSession(a).client },
            alias,
            remotePort,
            localHost,
            localPort,
            remoteHost
        )
    }

    forwardClose(forwardId: string, options: ForwardCloseOptions = {}): Promise<ForwardCloseResult> {
        return this.forwardManager.close(
            forwardId,
            {
                getClient: (a) => this.getSession(a).client,
            },
            options
        )
    }

    forwardList(): PortForwardInfo[] {
        return this.forwardManager.list()
    }

    private isSshAgentAvailable(socketPath?: string): boolean {
        if (!socketPath || socketPath === 'none' || socketPath === 'pageant') {
            return false // ssh2 can use Pageant, but the independent OpenSSH rsync process cannot inherit it.
        }
        if (process.platform === 'win32') {
            return /^\\\\\.\\pipe\\openssh-ssh-agent$/i.test(socketPath)
        }
        try {
            return fs.statSync(socketPath).isSocket()
        } catch {
            return false
        }
    }

    private isOpenSshKeyPathUsable(keyPath: string): boolean {
        try {
            const stats = fs.statSync(keyPath)
            if (!stats.isFile()) {
                return false
            }
            if (process.platform === 'win32' && checkWindowsAcl(keyPath) !== 'key_path_usable') {
                return false
            }
            if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
                return false
            }
            const currentUid = process.getuid?.()
            return currentUid === undefined || stats.uid === currentUid
        } catch {
            return false
        }
    }

    private sessionIdentity(session: SSHSession): string {
        return this.configIdentity(session.config)
    }

    private configIdentity(config: SSHConnectionConfig): string {
        return `${config.username}@${config.host}:${config.port ?? 22}`
    }

    private connectionFingerprint(config: SSHConnectionConfig): string {
        const secretHash = (value: string | undefined): string | undefined =>
            value === undefined ? undefined : createHash('sha256').update(value).digest('hex')
        const sortedEntries = (values: Record<string, string> | undefined): [string, string][] | undefined =>
            values === undefined
                ? undefined
                : Object.entries(values).sort(([left], [right]) => left.localeCompare(right))
        const payload = (value: SSHConnectionConfig): Record<string, unknown> => ({
            host: value.host,
            port: value.port ?? 22,
            username: value.username,
            alias: value.alias,
            template: value.template,
            runAs: value.runAs,
            defaultEnv: sortedEntries(value.defaultEnv),
            env: sortedEntries(value.env),
            keepaliveInterval: value.keepaliveInterval,
            keepaliveCountMax: value.keepaliveCountMax,
            readyTimeout: value.readyTimeout,
            lang: value.lang,
            shell: value.shell,
            agent: value.agent,
            remotePlatform: value.remotePlatform ?? 'posix',
            commandShell: value.commandShell ?? (value.remotePlatform === 'windows' ? 'powershell' : 'posix'),
            remotePathStyle: remotePathStyle(value.remotePlatform ?? 'posix', value.remotePathStyle),
            rsyncExecutable: value.rsyncExecutable,
            rsyncProfile: value.rsyncProfile,
            password: secretHash(value.password),
            privateKeyPath: value.privateKeyPath ? path.resolve(expandTilde(value.privateKeyPath)) : undefined,
            privateKey: secretHash(value.privateKey),
            passphrase: secretHash(value.passphrase),
            jumpHost: value.jumpHost ? payload(value.jumpHost) : undefined,
        })
        return createHash('sha256')
            .update(JSON.stringify(payload(config)))
            .digest('hex')
    }

    private resultMetadata(
        session: SSHSession,
        options: ExecOptions,
        context: CommandContext
    ): Omit<Partial<ExecResult>, 'stdout' | 'stderr' | 'exitCode' | 'duration' | 'success'> {
        const env = options.skipSessionEnv
            ? { ...options.env }
            : { ...session.config.defaultEnv, ...session.config.env, ...options.env }
        return {
            loginUser: session.config.username,
            effectiveUser: context.runAs ?? session.config.username,
            identity: this.sessionIdentity(session),
            cwd: context.cwd ?? options.cwd,
            resolvedCwd: context.cwd ?? options.cwd,
            shell:
                session.config.commandShell ?? (session.config.remotePlatform === 'windows' ? 'powershell' : 'posix'),
            profileLoaded: context.loadProfile,
            envInjectedKeys: context.envInjectedKeys ?? Object.keys(env).filter((key) => this.isValidEnvKey(key)),
        }
    }

    private appendWithinByteLimit(
        current: string,
        chunk: string,
        available: number
    ): { text: string; appendedBytes: number; truncated: boolean } {
        const bytes = Buffer.from(chunk, 'utf8')
        if (bytes.length <= available) {
            return { text: current + chunk, appendedBytes: bytes.length, truncated: false }
        }
        let end = Math.max(0, available)
        while (end > 0 && end < bytes.length && isUtf8ContinuationByte(bytes[end])) {
            --end
        }
        return { text: current + bytes.subarray(0, end).toString('utf8'), appendedBytes: end, truncated: true }
    }

    private appendOutputTail(current: string, chunk: string): string {
        const next = Buffer.from(current + chunk, 'utf8')
        return retainUtf8Suffix(next, OUTPUT_PREVIEW_CHARS).toString('utf8')
    }

    private recommendedReadCommand(): string {
        return (
            '将远端命令输出重定向到文件，例如 command > /tmp/mcp-ssh-output.txt 2>&1，' +
            '再用 ssh_read_file(remotePath="/tmp/mcp-ssh-output.txt", tail=true, maxBytes=65536) 分块读取'
        )
    }

    private emptyOutputFailureMetadata(exitCode: number, preview: OutputPreview): Partial<ExecResult> {
        if (exitCode === 0 || preview.stdoutBytes > 0 || preview.stderrBytes > 0) {
            return {}
        }
        return {
            emptyOutputFailure: true,
            recommendedReadCommand: this.recommendedReadCommand(),
            suggestion:
                '远端命令以非零退出码结束，但没有 stdout/stderr。请检查 cwd、effectiveUser、shell/profile，' +
                '或用 set -x / 显式重定向输出到文件后再用 ssh_read_file 读取',
        }
    }

    private outputMetadata(preview: OutputPreview): Partial<ExecResult> {
        const truncated = preview.stdoutTruncated || preview.stderrTruncated
        return {
            stdoutBytes: preview.stdoutBytes,
            stderrBytes: preview.stderrBytes,
            stdoutHead: preview.stdoutTruncated
                ? this.appendWithinByteLimit('', preview.stdout, OUTPUT_PREVIEW_CHARS).text
                : undefined,
            stdoutTail: preview.stdoutTruncated ? preview.stdoutTail : undefined,
            stderrHead: preview.stderrTruncated
                ? this.appendWithinByteLimit('', preview.stderr, OUTPUT_PREVIEW_CHARS).text
                : undefined,
            stderrTail: preview.stderrTruncated ? preview.stderrTail : undefined,
            recommendedReadCommand: truncated ? this.recommendedReadCommand() : undefined,
            maxOutputSize: truncated ? preview.maxOutputSize : undefined,
            suggestion: truncated
                ? '输出已截断，请提高 maxOutputSize，或将远端输出重定向到文件后用 ssh_read_file 分块读取'
                : undefined,
        }
    }

    private normalizeMaxOutputSize(value: number | undefined): number {
        const maxOutputSize = value ?? this.defaultMaxOutputSize
        if (!Number.isInteger(maxOutputSize) || maxOutputSize <= 0 || maxOutputSize > HARD_EXEC_MAX_OUTPUT_SIZE) {
            throw new CommandError('Invalid maxOutputSize', {
                maxOutputSize,
                min: 1,
                max: HARD_EXEC_MAX_OUTPUT_SIZE,
                suggestion:
                    '使用 1 到 HARD_EXEC_MAX_OUTPUT_SIZE 之间的整数，超大输出请重定向到远端文件后用 ssh_read_file 分块读取',
            })
        }
        return maxOutputSize
    }

    private async openOperationStream(
        alias: string,
        command: string,
        marker: string,
        options: OperationStartOptions,
        adopt: (stream: ClientChannel) => void
    ): Promise<void> {
        const session = this.getSession(alias)
        const markerEnv = `MCP_SSH_OPERATION_MARKER=${this.escapeShellArg(marker)}`
        const markerLine = `__MCP_SSH_OPERATION__:${marker}:%s:%s\\n`
        const operationScript = this.escapeShellArg(
            `printf ${this.escapeShellArg(markerLine)} "$$" "$1" >&2; exec sh -c ${this.escapeShellArg(command)}`
        )
        const wrappedCommand =
            `if command -v setsid >/dev/null 2>&1; then ` +
            `exec env ${markerEnv} setsid -w sh -c ${operationScript} sh 1; ` +
            `else exec env ${markerEnv} sh -c ${operationScript} sh 0; fi`
        const runAs = options.useLoginUser ? undefined : (options.runAs ?? session.config.runAs)
        let fullCommand: string
        if (session.config.remotePlatform === 'windows') {
            if (runAs) {
                this.requirePosixPrivilege(alias)
            }
            const execution =
                session.config.commandShell === 'cmd'
                    ? `& cmd.exe /D /C ${quotePowershell(command)}`
                    : `& { ${command} }`
            const script = [
                `$operationMarker = ${quotePowershell(marker)}`,
                '$created = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks',
                '[Console]::Error.WriteLine("__MCP_SSH_OPERATION__:{0}:{1}:0:{2}", $operationMarker, $PID, $created)',
                execution,
                'if (-not $?) { exit 1 }',
            ].join('; ')
            fullCommand = this.buildCommand(encodedPowershell(script), session, options)
        } else if (runAs) {
            if (!this.isValidUsername(runAs)) {
                throw new Error(`Invalid username: ${runAs}`)
            }
            const loadProfile = options.loadProfile ?? true
            const targetCommand = this.buildCommand(
                `${loadProfile ? this.getLoadProfileCommand() : ''}${wrappedCommand}`,
                session,
                options
            )
            fullCommand = `su - ${runAs} -c ${this.escapeShellArg(targetCommand)}`
        } else {
            fullCommand = this.buildCommand(wrappedCommand, session, options)
        }

        return new Promise((resolve, reject) => {
            session.client.exec(fullCommand, {}, (error, stream) => {
                if (!this.isCurrentSession(alias, session)) {
                    this.closeClientChannel(stream)
                    reject(new Error('Operation start was cancelled because the SSH session changed'))
                    return
                }
                if (error) {
                    reject(new Error(`Operation start failed: ${error.message}`))
                    return
                }
                try {
                    adopt(stream)
                    resolve()
                } catch (adoptionError) {
                    this.closeClientChannel(stream)
                    reject(adoptionError)
                }
            })
        })
    }

    private async cancelRemoteOperation(
        alias: string,
        pid: number,
        marker: string,
        processGroup: boolean,
        options: OperationStartOptions,
        processCreatedAt?: string
    ): Promise<{ success: boolean; error?: string; cancellationStatus?: 'unknown' | 'unsupported' }> {
        if (this.getRemotePlatform(alias) === 'windows') {
            if (!processCreatedAt || !/^[1-9]\d*$/.test(processCreatedAt)) {
                return {
                    success: false,
                    cancellationStatus: 'unsupported',
                    error: 'unsupported_remote_platform: process creation time is unavailable',
                }
            }
            const script = [
                '$ErrorActionPreference = "Stop"',
                `$remotePid = ${pid}`,
                `$expectedTicks = ${quotePowershell(processCreatedAt)}`,
                `$expectedMarker = ${quotePowershell(marker)}`,
                '$process = Get-CimInstance Win32_Process -Filter "ProcessId=$remotePid"',
                'if (-not $process -or $process.CommandLine -notmatch "-EncodedCommand\\s+([A-Za-z0-9+/=]+)") { throw "process identity unavailable" }',
                '$script = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1]))',
                'if (-not $script.Contains($expectedMarker)) { throw "operation marker mismatch" }',
                '$start = (Get-Process -Id $remotePid).StartTime.ToUniversalTime().Ticks.ToString()',
                'if ($start -ne $expectedTicks) { throw "process creation time mismatch" }',
                'taskkill.exe /PID $remotePid /T /F',
                'if ($LASTEXITCODE -ne 0) { throw "tree termination failed" }',
            ].join('; ')
            try {
                const result = await this.exec(alias, encodedPowershell(script), {
                    useLoginUser: true,
                    timeout: 5000,
                    maxOutputSize: 4096,
                })
                return result.success
                    ? { success: true }
                    : { success: false, error: result.stderr || `Remote cancel exited with code ${result.exitCode}` }
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : String(error) }
            }
        }
        const expectedMarker = `MCP_SSH_OPERATION_MARKER=${marker}`
        const signalTarget = processGroup ? `-${pid}` : `${pid}`
        const command = [
            `pid=${pid}`,
            `expected=${this.escapeShellArg(expectedMarker)}`,
            'if [ ! -r "/proc/$pid/environ" ]; then printf "operation marker unavailable" >&2; exit 3; fi',
            'if ! tr "\\000" "\\n" < "/proc/$pid/environ" | grep -Fqx -- "$expected"; then ' +
                'printf "operation marker mismatch" >&2; exit 4; fi',
            `kill -TERM ${signalTarget}`,
        ].join('; ')
        try {
            const result = await this.exec(alias, command, {
                runAs: options.runAs,
                useLoginUser: options.useLoginUser,
                loadProfile: false,
                timeout: 5000,
                maxOutputSize: 4096,
            })
            return result.success
                ? { success: true }
                : { success: false, error: result.stderr || `Remote cancel exited with code ${result.exitCode}` }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    }

    private async execDirect(
        alias: string,
        command: string,
        options: ExecOptions = {},
        context: CommandContext = {}
    ): Promise<ExecResult> {
        const session = this.getSession(alias)
        const startTime = Date.now()
        const maxOutputSize = this.normalizeMaxOutputSize(options.maxOutputSize)
        const fullCommand = this.buildCommand(command, session, options)

        return new Promise((resolve, reject) => {
            const timeout = options.timeout ?? this.defaultTimeout
            let timeoutId: NodeJS.Timeout | null = null
            let stdout = ''
            let stderr = ''
            let stdoutTail = ''
            let stderrTail = ''
            let stdoutBytes = 0
            let stderrBytes = 0
            let stdoutKeptBytes = 0
            let stderrKeptBytes = 0
            let stdoutTruncated = false
            let stderrTruncated = false
            let settled = false
            let activeStream: ClientChannel | null = null
            const stdoutDecoder = new StringDecoder('utf8')
            const stderrDecoder = new StringDecoder('utf8')
            let decodersEnded = false

            const appendStdout = (chunk: string): void => {
                stdoutTail = this.appendOutputTail(stdoutTail, chunk)
                if (!stdoutTruncated) {
                    const appended = this.appendWithinByteLimit(stdout, chunk, maxOutputSize - stdoutKeptBytes)
                    stdout = appended.text
                    stdoutKeptBytes += appended.appendedBytes
                    stdoutTruncated = appended.truncated
                }
            }
            const appendStderr = (chunk: string): void => {
                stderrTail = this.appendOutputTail(stderrTail, chunk)
                if (!stderrTruncated) {
                    const appended = this.appendWithinByteLimit(stderr, chunk, maxOutputSize - stderrKeptBytes)
                    stderr = appended.text
                    stderrKeptBytes += appended.appendedBytes
                    stderrTruncated = appended.truncated
                }
            }
            const endDecoders = (): void => {
                if (decodersEnded) {
                    return
                }
                decodersEnded = true
                appendStdout(stdoutDecoder.end())
                appendStderr(stderrDecoder.end())
            }

            const execOptions: Ssh2ExecOptions = {}

            if (options.pty) {
                execOptions.pty = {
                    rows: options.rows ?? 24,
                    cols: options.cols ?? 80,
                    term: options.term ?? 'xterm-256color',
                }
            }

            const outputPreview = (): OutputPreview => ({
                stdout,
                stderr,
                stdoutTail,
                stderrTail,
                stdoutBytes,
                stderrBytes,
                stdoutTruncated,
                stderrTruncated,
                maxOutputSize,
            })

            const clearTimer = () => {
                if (timeoutId) {
                    clearTimeout(timeoutId)
                    timeoutId = null
                }
            }

            const rejectOnce = (error: Error) => {
                if (settled) {
                    return
                }
                settled = true
                endDecoders()
                clearTimer()
                activeStream?.close()
                reject(error)
            }

            timeoutId = setTimeout(() => {
                endDecoders()
                rejectOnce(this.createCommandTimeoutError(alias, timeout, context, outputPreview()))
            }, timeout)

            session.client.exec(fullCommand, execOptions, (err, stream) => {
                if (!this.isCurrentSession(alias, session)) {
                    this.closeClientChannel(stream)
                    rejectOnce(new Error('Exec was cancelled because the SSH session changed'))
                    return
                }
                if (err) {
                    rejectOnce(new Error(`Exec failed: ${err.message}`))
                    return
                }
                if (settled) {
                    this.closeClientChannel(stream)
                    return
                }

                activeStream = stream

                stream.on('close', (code: number) => {
                    if (settled) {
                        return
                    }
                    settled = true
                    endDecoders()
                    clearTimer()
                    resolve({
                        success: code === 0,
                        stdout,
                        stderr,
                        exitCode: code,
                        duration: Date.now() - startTime,
                        failureKind: code === 0 ? undefined : 'remote_command',
                        stdoutTruncated: stdoutTruncated || undefined,
                        stderrTruncated: stderrTruncated || undefined,
                        ...this.outputMetadata(outputPreview()),
                        ...this.emptyOutputFailureMetadata(code, outputPreview()),
                        ...this.resultMetadata(session, options, context),
                    })
                })

                stream.on('data', (data: Buffer) => {
                    if (settled) {
                        return
                    }
                    stdoutBytes += data.length
                    appendStdout(stdoutDecoder.write(data))
                })

                stream.stderr.on('data', (data: Buffer) => {
                    if (settled) {
                        return
                    }
                    stderrBytes += data.length
                    appendStderr(stderrDecoder.write(data))
                })
            })
        })
    }

    private async connectInternal(
        config: SSHConnectionConfig,
        alias: string,
        pendingConnection: PendingConnection
    ): Promise<string> {
        // 检查是否已有活跃连接
        const existing = this.sessions.get(alias)
        if (existing && this.isAlive(existing)) {
            const existingIdentity = this.sessionIdentity(existing)
            const requestedIdentity = this.configIdentity(config)
            if (this.connectionFingerprint(existing.config) !== pendingConnection.fingerprint) {
                throw new CommandError(`Alias '${alias}' is already connected with different session configuration`, {
                    alias,
                    existingIdentity,
                    requestedIdentity,
                    suggestion: '请换一个 alias，或先 ssh_disconnect 断开已有同名会话',
                })
            }
            existing.lastUsedAt = Date.now()
            return alias
        }

        const client = new Client()
        pendingConnection.client = client
        const readyTimeout = config.readyTimeout ?? this.defaultTimeout
        const connectConfig: ConnectConfig = {
            host: config.host,
            port: config.port ?? 22,
            username: config.username,
            readyTimeout,
            keepaliveInterval: config.keepaliveInterval ?? this.defaultKeepaliveInterval,
            keepaliveCountMax: config.keepaliveCountMax ?? this.defaultKeepaliveCountMax,
        }

        try {
            if (config.password) {
                connectConfig.password = config.password
            }
            if (config.privateKeyPath) {
                const keyPath = expandTilde(config.privateKeyPath)
                // 路径白名单 + 大小上限校验，避免任意文件读取
                validateKeyFile(keyPath)
                if (process.platform === 'win32') {
                    const aclStatus = checkWindowsAcl(keyPath)
                    if (aclStatus !== 'key_path_usable') {
                        throw new CommandError(`Private key ACL check failed: ${aclStatus}`, { code: aclStatus })
                    }
                }
                connectConfig.privateKey = fs.readFileSync(keyPath)
            }
            if (config.privateKey) {
                connectConfig.privateKey = config.privateKey
            }
            if (config.passphrase) {
                connectConfig.passphrase = config.passphrase
            }
            const agent =
                config.agent ??
                (!config.password && !config.privateKey && !config.privateKeyPath
                    ? process.env.SSH_AUTH_SOCK
                    : undefined)
            if (agent && agent !== 'none') {
                if (agent === 'pageant' && process.platform !== 'win32') {
                    throw new Error('Pageant authentication is only available on Windows')
                }
                if (agent !== 'pageant' && !agent.startsWith('\\\\.\\pipe\\') && !fs.existsSync(agent)) {
                    throw new Error('SSH agent socket or pipe is unavailable')
                }
                connectConfig.agent = agent
            }
        } catch (error) {
            throw this.createConnectionError(error, config, readyTimeout, 'key_read')
        }

        if (config.jumpHost) {
            const jumpConfig: SSHConnectionConfig = {
                ...config.jumpHost,
                readyTimeout: config.jumpHost.readyTimeout ?? readyTimeout,
            }
            let jumpAlias: string
            try {
                jumpAlias = await this.connect(jumpConfig)
            } catch (error) {
                if (error instanceof ConnectionError) {
                    throw new ConnectionError(error.message, {
                        ...error.details,
                        connectionStep: 'jump_connect',
                    })
                }
                throw this.createConnectionError(error, jumpConfig, jumpConfig.readyTimeout!, 'jump_connect')
            }
            const jumpSession = this.sessions.get(jumpAlias)
            if (!jumpSession || !this.isAlive(jumpSession)) {
                throw new ConnectionError(`Jump host session '${jumpAlias}' is unavailable`, {
                    failureStage: 'transport_or_handshake',
                    connectionStep: 'jump_connect',
                    retryable: true,
                    suggestion: '重新连接跳板机，或检查 jumpHost 配置和网络路径',
                })
            }
            connectConfig.sock = await this.forwardConnection(
                jumpSession.client,
                config.host,
                config.port ?? 22,
                readyTimeout
            )
        }

        if (!this.isCurrentPendingConnection(alias, pendingConnection)) {
            client.end()
            this.closeClientChannel(connectConfig.sock as ClientChannel | undefined)
            throw new Error(`Connection for alias '${alias}' was cancelled before SSH setup started`)
        }

        return new Promise((resolve, reject) => {
            let settled = false
            const clearPendingConnection = (): void => {
                if (this.pendingConnections.get(alias) === pendingConnection) {
                    this.pendingConnections.delete(alias)
                }
            }
            const rejectConnection = (error: unknown): void => {
                if (settled) {
                    return
                }
                settled = true
                clearPendingConnection()
                reject(this.createConnectionError(error, config, readyTimeout, 'target_connect'))
            }

            client.on('ready', () => {
                if (settled || !this.isCurrentPendingConnection(alias, pendingConnection)) {
                    clearPendingConnection()
                    client.end()
                    if (!settled) {
                        settled = true
                        reject(
                            this.createConnectionError(
                                new Error(`Connection for alias '${alias}' was cancelled before ready`),
                                config,
                                readyTimeout,
                                'target_connect'
                            )
                        )
                    }
                    return
                }
                settled = true
                clearPendingConnection()
                const session: SSHSession = {
                    client,
                    config,
                    authAgent: typeof connectConfig.agent === 'string' ? connectConfig.agent : undefined,
                    connectedAt: Date.now(),
                    lastUsedAt: Date.now(),
                    reconnectAttempts: 0,
                    connected: true,
                    manualClose: false,
                }
                this.sessions.set(alias, session)
                this.persistSessions()
                resolve(alias)
            })

            client.on('error', (error) => {
                const session = this.sessions.get(alias)
                if (session && session.client === client) {
                    session.connected = false
                }
                rejectConnection(error)
            })

            client.on('close', () => {
                const session = this.sessions.get(alias)
                if (session && session.client === client) {
                    session.connected = false
                    this.invalidateAliasResources(alias)
                    if (!session.manualClose) {
                        this.scheduleReconnect(alias)
                    }
                } else if (!settled) {
                    rejectConnection(new Error(`Connection for alias '${alias}' closed before ready`))
                }
            })

            try {
                client.connect(connectConfig)
                client.setNoDelay(true)
            } catch (error) {
                rejectConnection(error)
            }
        })
    }

    /**
     * 执行带 PTY 的命令，返回原始 stream（供 PtyManager 使用）
     */
    private execPtyStream(alias: string, command: string, options: PtyOptions): Promise<ClientChannel> {
        const session = this.getSession(alias)
        const fullCommand = this.buildCommand(command, session, { env: options.env, cwd: options.cwd })

        return new Promise((resolve, reject) => {
            session.client.exec(
                fullCommand,
                {
                    pty: {
                        rows: options.rows ?? 24,
                        cols: options.cols ?? 80,
                        term: options.term ?? 'xterm-256color',
                    },
                },
                (err, stream) => {
                    if (!this.isCurrentSession(alias, session)) {
                        this.closeClientChannel(stream)
                        reject(new Error('PTY start was cancelled because the SSH session changed'))
                        return
                    }
                    if (err) {
                        reject(new Error(`PTY exec failed: ${err.message}`))
                        return
                    }
                    resolve(stream)
                }
            )
        })
    }

    private ensurePersistDir(): void {
        const dir = path.dirname(this.persistPath)
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
        }
        if (process.platform === 'win32') {
            if (checkWindowsAcl(dir, true) !== 'key_path_usable') {
                throw new Error('privacy_not_enforced_on_windows: session directory ACL could not be verified')
            }
            if (fs.existsSync(this.persistPath) && checkWindowsAcl(this.persistPath, true) !== 'key_path_usable') {
                throw new Error('privacy_not_enforced_on_windows: existing session file ACL could not be verified')
            }
        }
    }

    /**
     * 生成连接别名
     */
    private generateAlias(config: SSHConnectionConfig): string {
        return config.alias || `${config.username}@${config.host}:${config.port}`
    }

    /**
     * 通过跳板机转发连接
     */
    private forwardConnection(
        jumpClient: Client,
        targetHost: string,
        targetPort: number,
        timeout: number
    ): Promise<ClientChannel> {
        return new Promise((resolve, reject) => {
            let settled = false
            const timer = setTimeout(() => {
                if (settled) {
                    return
                }
                settled = true
                reject(
                    new ConnectionError(`Jump host forwarding to ${targetHost}:${targetPort} timed out`, {
                        failureStage: 'ready_timeout',
                        connectionStep: 'jump_forward',
                        retryable: true,
                        suggestion: '检查跳板机到目标地址的网络路径，必要时提高 readyTimeout',
                    })
                )
            }, timeout)

            jumpClient.forwardOut('127.0.0.1', 0, targetHost, targetPort, (error, stream) => {
                if (settled) {
                    this.closeClientChannel(stream)
                    return
                }
                settled = true
                clearTimeout(timer)
                if (error) {
                    reject(
                        new ConnectionError(`Jump host forwarding to ${targetHost}:${targetPort} failed`, {
                            failureStage: 'transport_or_handshake',
                            connectionStep: 'jump_forward',
                            retryable: true,
                            suggestion: '检查跳板机到目标地址的网络路径、目标端口和防火墙',
                        })
                    )
                } else {
                    resolve(stream)
                }
            })
        })
    }

    private getConnectionGeneration(alias: string): number {
        return this.connectionGenerations.get(alias) ?? 0
    }

    private isCurrentPendingConnection(alias: string, pending: PendingConnection): boolean {
        return (
            this.pendingConnections.get(alias) === pending && this.getConnectionGeneration(alias) === pending.generation
        )
    }

    private cancelPendingConnection(alias: string): boolean {
        this.connectionGenerations.set(alias, this.getConnectionGeneration(alias) + 1)
        const pending = this.pendingConnections.get(alias)
        const inFlight = this.connectInFlight.delete(alias)
        if (!pending) {
            return inFlight
        }
        this.pendingConnections.delete(alias)
        pending.cancel(new Error(`Connection for alias '${alias}' was cancelled`))
        return true
    }

    private invalidateAliasResources(alias: string): void {
        // 连接身份变化后，旧 client 上的 operation、PTY、forward 和传输能力缓存均不再有效
        this.operationManager.markAliasDisconnected(alias)
        this.ptyManager.closeByAlias(alias)
        this.forwardManager.closeByAlias(alias)
        clearRsyncCache(alias)
    }

    /**
     * 检查连接是否存活
     */
    private isAlive(session: SSHSession): boolean {
        return session.connected
    }

    private isCurrentSession(alias: string, session: SSHSession): boolean {
        const currentSession = this.sessions.get(alias)
        return currentSession === session && currentSession.client === session.client && currentSession.connected
    }

    private closeClientChannel(stream: ClientChannel | undefined): void {
        try {
            stream?.destroy()
        } catch {
            // ignore
        }
        try {
            stream?.close()
        } catch {
            // ignore
        }
    }

    private destroySftp(sftp: SFTPWrapper | undefined): void {
        try {
            sftp?.destroy()
        } catch {
            // ignore
        }
    }

    /**
     * 调度自动重连（支持多次重试）
     */
    private scheduleReconnect(alias: string): void {
        const session = this.sessions.get(alias)
        if (!session || session.reconnectAttempts >= this.maxReconnectAttempts) {
            return
        }

        // 清掉旧的定时器,防止重复调度
        if (session.reconnectTimer) {
            clearTimeout(session.reconnectTimer)
        }

        session.reconnectAttempts++
        const attempt = session.reconnectAttempts

        session.reconnectTimer = setTimeout(async () => {
            const current = this.sessions.get(alias)
            if (current !== session || current.client !== session.client) {
                return
            }
            session.reconnectTimer = undefined
            try {
                await this.reconnect(alias)
            } catch (err) {
                console.error(
                    `Auto-reconnect failed for ${alias} (${attempt}/${this.maxReconnectAttempts}): ${(err as Error).message}`
                )
                if (this.sessions.get(alias) === session) {
                    this.scheduleReconnect(alias)
                }
            }
        }, this.reconnectDelay)
    }

    private createCommandTimeoutError(
        alias: string,
        timeout: number,
        context: CommandContext,
        preview?: OutputPreview
    ): CommandError {
        const output = preview ? this.outputMetadata(preview) : undefined
        return new CommandError(`Command timed out after ${timeout}ms`, {
            alias,
            timeout,
            timedOut: true,
            failureKind: 'timeout',
            runAs: context.runAs,
            loadProfile: context.loadProfile,
            cwd: context.cwd,
            remoteProcessKnown: false,
            stdoutHead: preview ? this.appendWithinByteLimit('', preview.stdout, OUTPUT_PREVIEW_CHARS).text : undefined,
            stdoutTail: preview?.stdoutTail,
            stderrHead: preview ? this.appendWithinByteLimit('', preview.stderr, OUTPUT_PREVIEW_CHARS).text : undefined,
            stderrTail: preview?.stderrTail,
            stdoutBytes: preview?.stdoutBytes,
            stderrBytes: preview?.stderrBytes,
            recommendedReadCommand: this.recommendedReadCommand(),
            output,
            suggestions: context.loadProfile
                ? ['设置 loadProfile=false 后重试', '提高 timeout', '长时间交互命令改用 ssh_pty_start']
                : [
                      '提高 timeout',
                      '长时间交互命令改用 ssh_pty_start',
                      '大输出命令重定向到远端文件后用 ssh_read_file 分块读取',
                  ],
        })
    }

    private createConnectionError(
        error: unknown,
        config: SSHConnectionConfig,
        readyTimeout: number,
        connectionStep: ConnectionFailureDetails['connectionStep']
    ): ConnectionError {
        if (error instanceof ConnectionError) {
            return new ConnectionError(error.message, {
                ...error.details,
                connectionStep: error.details.connectionStep ?? connectionStep,
            })
        }
        if (
            error instanceof CommandError &&
            (error.details.code === 'key_acl_insecure' || error.details.code === 'key_acl_unverified')
        ) {
            return new ConnectionError(error.message, {
                failureStage: 'preflight',
                connectionStep,
                retryable: false,
                keyAclStatus: error.details.code,
            })
        }
        const err = error instanceof Error ? error : new Error(String(error))
        const target = `${config.username}@${config.host}:${config.port ?? 22}`
        return new ConnectionError(`SSH connection to ${target} failed: ${sanitizeKeyError(err.message)}`, {
            ...this.classifyConnectionError(err, readyTimeout),
            connectionStep,
        })
    }

    private classifyConnectionError(
        err: Error & { code?: string; level?: string },
        readyTimeout: number
    ): ConnectionFailureDetails {
        const message = err.message || ''
        const code = err.code || ''
        if (message.includes('All configured authentication methods failed') || err.level === 'client-authentication') {
            return {
                failureStage: 'authentication',
                retryable: false,
                suggestion: '检查用户名、密码、keyPath、passphrase 和远端 authorized_keys',
            }
        }
        if (
            message.includes('Timed out while waiting for handshake') ||
            message.includes(`Timed out after ${readyTimeout}`)
        ) {
            return {
                failureStage: 'ready_timeout',
                retryable: true,
                suggestion: '检查网络路径、跳板机和服务端握手延迟，必要时提高 readyTimeout',
            }
        }
        if (code === 'ENOTFOUND' || message.includes('getaddrinfo')) {
            return { failureStage: 'preflight', retryable: false, suggestion: '检查 host 或 DNS 配置' }
        }
        if (
            code === 'ECONNREFUSED' ||
            code === 'ECONNRESET' ||
            code === 'ETIMEDOUT' ||
            message.includes('handshake') ||
            message.includes('ECONN')
        ) {
            return {
                failureStage: 'transport_or_handshake',
                retryable: code !== 'ECONNREFUSED',
                suggestion: '检查目标端口、防火墙、ProxyJump 和 SSH 服务状态',
            }
        }
        return { failureStage: 'unknown', retryable: false }
    }

    /**
     * 转义 shell 参数（使用单引号方式，防止命令注入）
     * 委托给 tools/utils.ts 的共享实现
     */
    private escapeShellArg(s: string): string {
        return escapeShellArg(s)
    }

    /**
     * 校验用户名（只允许字母、数字、下划线、连字符）
     */
    private isValidUsername(username: string): boolean {
        return /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(username)
    }

    /**
     * 校验环境变量名（只允许字母、数字、下划线，不能以数字开头）
     */
    private isValidEnvKey(key: string): boolean {
        return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)
    }

    /**
     * 构建完整命令：注入环境变量 + 切换工作目录
     */
    private buildCommand(
        command: string,
        session: SSHSession,
        options: { env?: Record<string, string>; cwd?: string; skipSessionEnv?: boolean }
    ): string {
        const env = options.skipSessionEnv
            ? { ...options.env }
            : { ...session.config.defaultEnv, ...session.config.env, ...options.env }
        const shell =
            session.config.commandShell ?? (session.config.remotePlatform === 'windows' ? 'powershell' : 'posix')
        return buildRemoteCommand(command, shell, options.cwd, env)
    }

    /**
     * 根据用户 shell 类型生成加载配置文件的命令
     * bash → .bashrc, zsh → .zshrc, 其他 → .profile
     */
    private getLoadProfileCommand(): string {
        return (
            'case "$(basename "$SHELL" 2>/dev/null)" in ' +
            'bash) [ -f ~/.bashrc ] && . ~/.bashrc ;; ' +
            'zsh) [ -f ~/.zshrc ] && . ~/.zshrc ;; ' +
            '*) [ -f ~/.profile ] && . ~/.profile ;; ' +
            'esac 2>/dev/null; '
        )
    }

    /**
     * 持久化会话信息（异步非阻塞，避免阻塞事件循环）
     */
    private persistSessions(): void {
        const data: PersistedSession[] = []
        for (const [alias, session] of this.sessions) {
            // 不保存敏感信息（密码、密钥、环境变量）
            data.push({
                alias,
                host: session.config.host,
                port: session.config.port ?? 22,
                username: session.config.username,
                runAs: session.config.runAs,
                connectedAt: session.connectedAt,
            })
        }
        if (process.platform === 'win32') {
            const temporary = `${this.persistPath}.${randomUUID()}.tmp`
            this.persistQueue = this.persistQueue
                .then(async () => {
                    try {
                        const handle = await fs.promises.open(temporary, 'wx', 0o600)
                        try {
                            if (checkWindowsAcl(temporary, true) !== 'key_path_usable') {
                                throw new Error(
                                    'privacy_not_enforced_on_windows: session file ACL could not be verified'
                                )
                            }
                            await handle.writeFile(JSON.stringify(data, null, 2))
                            await handle.sync()
                        } finally {
                            await handle.close()
                        }
                        await fs.promises.rename(temporary, this.persistPath)
                    } finally {
                        await fs.promises.rm(temporary, { force: true })
                    }
                })
                .catch((err: Error) => console.error('[SSH] 会话持久化写入失败:', err))
            return
        }
        fs.promises
            .writeFile(this.persistPath, JSON.stringify(data, null, 2), { mode: 0o600 })
            .catch((err: Error) => console.error('[SSH] 会话持久化写入失败:', err))
    }
}

// 全局单例
export const sessionManager = new SessionManager()
