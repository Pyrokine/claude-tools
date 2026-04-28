/**
 * SSH Session Manager - 连接池管理
 *
 * 功能：
 * - 连接池复用
 * - 心跳保持
 * - 自动重连
 * - 会话持久化
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Client, ClientChannel, ConnectConfig, ExecOptions as Ssh2ExecOptions, SFTPWrapper } from 'ssh2'
import { clearRsyncCache } from './file-ops.js'
import { ForwardManager } from './forward-manager.js'
import { PtyManager } from './pty-manager.js'
import { sanitizeKeyError, validateKeyFile } from './security.js'
import { escapeShellArg, expandTilde } from './tools/utils.js'
import {
    ExecOptions,
    ExecResult,
    PersistedSession,
    PortForwardInfo,
    PtyOptions,
    PtySessionInfo,
    SSHConnectionConfig,
    SSHSessionInfo,
} from './types.js'

interface SSHSession {
    client: Client
    config: SSHConnectionConfig
    connectedAt: number
    lastUsedAt: number
    reconnectAttempts: number
    connected: boolean // 通过事件监听维护的连接状态
    manualClose: boolean // 标记主动关闭，阻止 close 事件触发自动重连
    /** 当前正在等待的重连定时器,disconnect 时需要清除以防 zombie 重连 */
    reconnectTimer?: NodeJS.Timeout
}

export class SessionManager {
    private sessions: Map<string, SSHSession> = new Map()
    /** per-alias connect 进行中的 Promise,防止并发 connect 同一 alias 时重复建连 */
    private connectInFlight: Map<string, Promise<string>> = new Map()
    private readonly ptyManager = new PtyManager()
    private readonly forwardManager = new ForwardManager()
    private readonly persistPath: string
    private defaultKeepaliveInterval = 30000 // 30秒
    private defaultKeepaliveCountMax = 3
    private defaultTimeout = 30000 // 30秒
    private maxReconnectAttempts = 3
    private defaultMaxOutputSize = 10 * 1024 * 1024 // 10*1024*1024 UTF-16 chars（ASCII 时约 10MB 字节）
    private reconnectDelay = 5000 // 5秒

    constructor(persistPath?: string) {
        this.persistPath = persistPath || path.join(os.homedir(), '.ssh-mcp-pro', 'sessions.json')
        this.ensurePersistDir()
    }

    /**
     * 建立 SSH 连接（per-alias mutex，防止并发 connect 同一 alias 重复建连）
     */
    async connect(config: SSHConnectionConfig): Promise<string> {
        const alias = this.generateAlias(config)

        // 复用同 alias 的 in-flight connect Promise
        const inFlight = this.connectInFlight.get(alias)
        if (inFlight) {
            return inFlight
        }

        const promise = this.connectInternal(config, alias).finally(() => {
            this.connectInFlight.delete(alias)
        })
        this.connectInFlight.set(alias, promise)
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

        session.manualClose = true
        session.connected = false

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
        const session = this.sessions.get(alias)
        if (session) {
            session.manualClose = true
            // 清掉重连定时器,防止 disconnect 后还在尝试自动重连
            if (session.reconnectTimer) {
                clearTimeout(session.reconnectTimer)
                session.reconnectTimer = undefined
            }
            // 清理关联的 PTY 和 forward 资源
            this.ptyManager.closeByAlias(alias)
            this.forwardManager.closeByAlias(alias)
            // 清理 file-ops 中的 rsync 可用性缓存,防止重连到不同主机后读到旧判断
            clearRsyncCache(alias)
            try {
                session.client.end()
            } catch {
                /* 忽略已关闭的连接 */
            }
            this.sessions.delete(alias)
            this.persistSessions()
            return true
        }
        return false
    }

    /** 断开所有活跃会话（SIGINT/SIGTERM 时调用） */
    async disconnectAll(): Promise<void> {
        const aliases = Array.from(this.sessions.keys())
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

    /**
     * 列出所有会话
     */
    listSessions(): SSHSessionInfo[] {
        const result: SSHSessionInfo[] = []
        for (const [alias, session] of this.sessions) {
            result.push({
                alias,
                host: session.config.host,
                port: session.config.port || 22,
                username: session.config.username,
                connected: this.isAlive(session),
                connectedAt: session.connectedAt,
                lastUsedAt: session.lastUsedAt,
                env: session.config.env,
            })
        }
        return result
    }

    /**
     * 执行命令
     */
    async exec(alias: string, command: string, options: ExecOptions = {}): Promise<ExecResult> {
        const session = this.getSession(alias)
        const startTime = Date.now()
        const maxOutputSize = options.maxOutputSize ?? this.defaultMaxOutputSize
        const fullCommand = this.buildCommand(command, session, options)

        return new Promise((resolve, reject) => {
            const timeout = options.timeout ?? this.defaultTimeout
            let timeoutId: NodeJS.Timeout | null = null
            let stdout = ''
            let stderr = ''
            let stdoutTruncated = false
            let stderrTruncated = false

            const execOptions: Ssh2ExecOptions = {}

            // PTY 模式
            if (options.pty) {
                execOptions.pty = {
                    rows: options.rows || 24,
                    cols: options.cols || 80,
                    term: options.term || 'xterm-256color',
                }
            }

            session.client.exec(fullCommand, execOptions, (err, stream) => {
                if (err) {
                    reject(new Error(`Exec failed: ${err.message}`))
                    return
                }

                // 设置超时
                timeoutId = setTimeout(() => {
                    stream.close()
                    reject(new Error(`Command timed out after ${timeout}ms`))
                }, timeout)

                stream.on('close', (code: number) => {
                    if (timeoutId) {
                        clearTimeout(timeoutId)
                    }
                    resolve({
                        success: code === 0,
                        stdout: stdoutTruncated ? stdout + '\n... [truncated]' : stdout,
                        stderr: stderrTruncated ? stderr + '\n... [truncated]' : stderr,
                        exitCode: code,
                        duration: Date.now() - startTime,
                    })
                })

                stream.on('data', (data: Buffer) => {
                    if (!stdoutTruncated) {
                        const chunk = data.toString('utf-8')
                        if (stdout.length + chunk.length > maxOutputSize) {
                            stdout += chunk.slice(0, maxOutputSize - stdout.length)
                            stdoutTruncated = true
                        } else {
                            stdout += chunk
                        }
                    }
                })

                stream.stderr.on('data', (data: Buffer) => {
                    if (!stderrTruncated) {
                        const chunk = data.toString('utf-8')
                        if (stderr.length + chunk.length > maxOutputSize) {
                            stderr += chunk.slice(0, maxOutputSize - stderr.length)
                            stderrTruncated = true
                        } else {
                            stderr += chunk
                        }
                    }
                })
            })
        })
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
        // 校验用户名防止注入
        if (!this.isValidUsername(targetUser)) {
            throw new Error(`Invalid username: ${targetUser}`)
        }

        const { loadProfile = true, ...execOpts } = options

        const wrappedCommand = loadProfile ? `${this.getLoadProfileCommand()}${command}` : command

        const suCommand = `su - ${targetUser} -c ${this.escapeShellArg(wrappedCommand)}`
        return this.exec(alias, suCommand, execOpts)
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
        if (!sudoPassword) {
            return this.exec(alias, `sudo ${command}`, options)
        }
        const session = this.getSession(alias)
        const startTime = Date.now()
        const timeout = options.timeout ?? this.defaultTimeout
        const maxOutputSize = options.maxOutputSize ?? this.defaultMaxOutputSize
        const fullCommand = this.buildCommand(`sudo -S ${command}`, session, options)

        return new Promise<ExecResult>((resolve, reject) => {
            let settled = false
            let streamRef: ClientChannel | null = null
            const timeoutId = setTimeout(() => {
                if (settled) {
                    return
                }
                settled = true
                try {
                    streamRef?.close()
                } catch {
                    // ignore
                }
                reject(new Error(`Command timed out after ${timeout}ms`))
            }, timeout)

            session.client.exec(fullCommand, {}, (err, stream) => {
                if (err) {
                    clearTimeout(timeoutId)
                    settled = true
                    reject(new Error(`Exec failed: ${err.message}`))
                    return
                }

                streamRef = stream

                // 密码写入 stdin，sudo -S 从 stdin 读取，不出现在命令行
                stream.write(sudoPassword + '\n')
                stream.end()

                let stdout = ''
                let stderr = ''
                let stdoutTruncated = false
                let stderrTruncated = false

                stream.on('close', (code: number) => {
                    clearTimeout(timeoutId)
                    if (settled) {
                        return
                    }
                    settled = true
                    resolve({
                        success: code === 0,
                        stdout: stdoutTruncated ? stdout + '\n... [truncated]' : stdout,
                        stderr: stderrTruncated ? stderr + '\n... [truncated]' : stderr,
                        exitCode: code,
                        duration: Date.now() - startTime,
                    })
                })

                stream.on('data', (data: Buffer) => {
                    if (!stdoutTruncated) {
                        const chunk = data.toString('utf-8')
                        if (stdout.length + chunk.length > maxOutputSize) {
                            stdout += chunk.slice(0, maxOutputSize - stdout.length)
                            stdoutTruncated = true
                        } else {
                            stdout += chunk
                        }
                    }
                })

                stream.stderr.on('data', (data: Buffer) => {
                    if (!stderrTruncated) {
                        const chunk = data.toString('utf-8')
                        if (stderr.length + chunk.length > maxOutputSize) {
                            stderr += chunk.slice(0, maxOutputSize - stderr.length)
                            stderrTruncated = true
                        } else {
                            stderr += chunk
                        }
                    }
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
                if (err) {
                    reject(err)
                } else {
                    resolve(sftp)
                }
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

    ptyWrite(ptyId: string, data: string): boolean {
        return this.ptyManager.write(ptyId, data)
    }

    ptyRead(
        ptyId: string,
        options: { mode?: 'screen' | 'raw'; clear?: boolean } = {}
    ): { data: string; active: boolean; rows: number; cols: number } {
        return this.ptyManager.read(ptyId, options)
    }

    ptyResize(ptyId: string, rows: number, cols: number): boolean {
        return this.ptyManager.resize(ptyId, rows, cols)
    }

    ptyClose(ptyId: string): boolean {
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
    ): Promise<string> {
        return this.forwardManager.forwardRemote(
            { getClient: (a) => this.getSession(a).client },
            alias,
            remotePort,
            localHost,
            localPort,
            remoteHost
        )
    }

    forwardClose(forwardId: string): boolean {
        return this.forwardManager.close(forwardId, {
            getClient: (a) => this.getSession(a).client,
        })
    }

    forwardList(): PortForwardInfo[] {
        return this.forwardManager.list()
    }

    private async connectInternal(config: SSHConnectionConfig, alias: string): Promise<string> {
        // 检查是否已有活跃连接
        const existing = this.sessions.get(alias)
        if (existing && this.isAlive(existing)) {
            existing.lastUsedAt = Date.now()
            return alias
        }

        const client = new Client()

        // 构建连接配置
        const connectConfig: ConnectConfig = {
            host: config.host,
            port: config.port ?? 22,
            username: config.username,
            readyTimeout: config.readyTimeout ?? this.defaultTimeout,
            keepaliveInterval: config.keepaliveInterval ?? this.defaultKeepaliveInterval,
            keepaliveCountMax: config.keepaliveCountMax ?? this.defaultKeepaliveCountMax,
        }

        // 认证方式
        if (config.password) {
            connectConfig.password = config.password
        }
        if (config.privateKeyPath) {
            const keyPath = expandTilde(config.privateKeyPath)
            // 路径白名单 + 大小上限校验，避免任意文件读取
            validateKeyFile(keyPath)
            connectConfig.privateKey = fs.readFileSync(keyPath)
        }
        if (config.privateKey) {
            connectConfig.privateKey = config.privateKey
        }
        if (config.passphrase) {
            connectConfig.passphrase = config.passphrase
        }

        // 跳板机支持
        if (config.jumpHost) {
            const jumpAlias = await this.connect(config.jumpHost)
            const jumpSession = this.sessions.get(jumpAlias)
            if (jumpSession) {
                // 通过跳板机建立连接
                connectConfig.sock = await this.forwardConnection(jumpSession.client, config.host, config.port || 22)
            }
        }

        return new Promise((resolve, reject) => {
            client.on('ready', () => {
                const session: SSHSession = {
                    client,
                    config,
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

            client.on('error', (err) => {
                const session = this.sessions.get(alias)
                if (session && session.client === client) {
                    session.connected = false
                }
                const target = `${connectConfig.username}@${connectConfig.host}:${connectConfig.port}`
                const safeMessage = sanitizeKeyError(err.message)
                const suggestion = this.diagnoseConnectionError(err)
                reject(
                    new Error(
                        `SSH connection to ${target} failed: ${safeMessage}${suggestion ? ` (${suggestion})` : ''}`
                    )
                )
            })

            client.on('close', () => {
                const session = this.sessions.get(alias)
                if (session && session.client === client) {
                    session.connected = false
                    // 清理绑定旧 client 的 forward/PTY 资源
                    this.forwardManager.closeByAlias(alias)
                    this.ptyManager.closeByAlias(alias)
                    if (!session.manualClose) {
                        this.scheduleReconnect(alias)
                    }
                }
            })

            client.connect(connectConfig)
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
                        rows: options.rows || 24,
                        cols: options.cols || 80,
                        term: options.term || 'xterm-256color',
                    },
                },
                (err, stream) => {
                    if (err) {
                        reject(new Error(`PTY exec failed: ${err.message}`))
                    } else {
                        resolve(stream)
                    }
                }
            )
        })
    }

    private ensurePersistDir(): void {
        const dir = path.dirname(this.persistPath)
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
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
    private forwardConnection(jumpClient: Client, targetHost: string, targetPort: number): Promise<ClientChannel> {
        return new Promise((resolve, reject) => {
            jumpClient.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, stream) => {
                if (err) {
                    reject(err)
                } else {
                    resolve(stream)
                }
            })
        })
    }

    /**
     * 检查连接是否存活
     */
    private isAlive(session: SSHSession): boolean {
        return session.connected
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
            if (!current) {
                // disconnect 已经把 session 移除,不再重连
                return
            }
            current.reconnectTimer = undefined
            try {
                await this.reconnect(alias)
            } catch (err) {
                console.error(
                    `Auto-reconnect failed for ${alias} (${attempt}/${this.maxReconnectAttempts}):`,
                    (err as Error).message
                )
                // reconnect 失败后继续调度下一次尝试
                this.scheduleReconnect(alias)
            }
        }, this.reconnectDelay)
    }

    /**
     * 根据错误类型生成排查建议
     */
    private diagnoseConnectionError(err: Error & { code?: string }): string {
        const msg = err.message || ''
        const code = err.code || ''

        if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
            return 'check if SSH service is running on the target host'
        }
        if (code === 'ETIMEDOUT' || msg.includes('ETIMEDOUT') || msg.includes('Timed out')) {
            return 'check host reachability, firewall rules, or try a jump host'
        }
        if (code === 'ENOTFOUND' || msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) {
            return 'hostname cannot be resolved, check DNS or use IP address'
        }
        if (msg.includes('All configured authentication methods failed')) {
            return 'check password, key path, or key permissions (chmod 600)'
        }
        if (msg.includes('ECONNRESET') || msg.includes('Connection reset')) {
            return 'connection was reset by the remote host'
        }
        return ''
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
        options: { env?: Record<string, string>; cwd?: string }
    ): string {
        let fullCommand = command
        const env = { ...session.config.env, ...options.env }

        if (Object.keys(env).length > 0) {
            const validEntries = Object.entries(env).filter(([k]) => this.isValidEnvKey(k))
            if (validEntries.length > 0) {
                const envStr = validEntries.map(([k, v]) => `export ${k}=${this.escapeShellArg(v)}`).join('; ')
                fullCommand = `${envStr}; ${command}`
            }
        }

        if (options.cwd) {
            fullCommand = `cd ${this.escapeShellArg(options.cwd)} && ${fullCommand}`
        }
        return fullCommand
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
            // 不保存敏感信息（密码、密钥）
            data.push({
                alias,
                host: session.config.host,
                port: session.config.port || 22,
                username: session.config.username,
                connectedAt: session.connectedAt,
                env: session.config.env,
            })
        }
        fs.promises
            .writeFile(this.persistPath, JSON.stringify(data, null, 2), { mode: 0o600 })
            .catch((err: Error) => console.error('[SSH] 会话持久化写入失败:', err))
    }
}

// 全局单例
export const sessionManager = new SessionManager()
