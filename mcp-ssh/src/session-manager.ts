/**
 * SSH Session Manager - 连接池管理
 *
 * 功能：
 * - 连接池复用
 * - 心跳保持
 * - 自动重连
 * - 会话持久化
 */

import xterm from '@xterm/headless'
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import {Client, ClientChannel, ConnectConfig, SFTPWrapper} from 'ssh2'
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

const Terminal = xterm.Terminal as typeof import('@xterm/headless').Terminal
type TerminalType = import('@xterm/headless').Terminal;

interface SSHSession {
    client: Client;
    config: SSHConnectionConfig;
    connectedAt: number;
    lastUsedAt: number;
    reconnectAttempts: number;
    connected: boolean;  // 通过事件监听维护的连接状态
    tcpDispatcher?: TcpConnectionHandler;  // remote forward 共享的 dispatcher
}

interface PtySession {
    id: string;
    alias: string;
    command: string;
    stream: ClientChannel;
    terminal: TerminalType;   // xterm headless 终端仿真器
    rows: number;
    cols: number;
    createdAt: number;
    lastReadAt: number;
    rawBuffer: string;        // 原始 ANSI 流
    maxBufferSize: number;
    active: boolean;
}

// tcp connection 事件处理函数类型
type TcpConnectionHandler = (
    info: { destIP: string; destPort: number; srcIP: string; srcPort: number },
    accept: () => ClientChannel,
    reject: () => void,
) => void;

interface ForwardSession {
    id: string;
    alias: string;
    type: 'local' | 'remote';
    localHost: string;
    localPort: number;
    remoteHost: string;
    remotePort: number;
    server?: net.Server;  // 本地转发的 TCP 服务器
    createdAt: number;
    active: boolean;
}

export class SessionManager {
    private sessions: Map<string, SSHSession>            = new Map()
    private ptySessions: Map<string, PtySession>         = new Map()
    private forwardSessions: Map<string, ForwardSession> = new Map()
    private ptyIdCounter                                 = 0
    private forwardIdCounter                             = 0
    private readonly persistPath: string
    private defaultKeepaliveInterval                     = 30000  // 30秒
    private defaultKeepaliveCountMax                     = 3
    private defaultTimeout                               = 30000  // 30秒
    private maxReconnectAttempts                         = 3
    private defaultMaxOutputSize                         = 10 * 1024 * 1024  // 10MB
    private reconnectDelay                               = 5000  // 5秒
    private defaultPtyBufferSize                         = 1024 * 1024  // 1MB

    constructor(persistPath?: string) {
        this.persistPath = persistPath || path.join(
                           process.env.HOME || '/tmp',
                           '.ssh-mcp-pro',
                           'sessions.json',
        )
        this.ensurePersistDir()
    }

    /**
     * 建立 SSH 连接
     */
    async connect(config: SSHConnectionConfig): Promise<string> {
        const alias = this.generateAlias(config)

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
            port: config.port || 22,
            username: config.username,
            readyTimeout: config.readyTimeout || this.defaultTimeout,
            keepaliveInterval: config.keepaliveInterval || this.defaultKeepaliveInterval,
            keepaliveCountMax: config.keepaliveCountMax || this.defaultKeepaliveCountMax,
        }

        // 认证方式
        if (config.password) {
            connectConfig.password = config.password
        }
        if (config.privateKeyPath) {
            connectConfig.privateKey = fs.readFileSync(config.privateKeyPath)
        }
        if (config.privateKey) {
            connectConfig.privateKey = config.privateKey
        }
        if (config.passphrase) {
            connectConfig.passphrase = config.passphrase
        }

        // 跳板机支持
        if (config.jumpHost) {
            const jumpAlias   = await this.connect(config.jumpHost)
            const jumpSession = this.sessions.get(jumpAlias)
            if (jumpSession) {
                // 通过跳板机建立连接
                connectConfig.sock = await this.forwardConnection(
                    jumpSession.client,
                    config.host,
                    config.port || 22,
                )
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
                }
                this.sessions.set(alias, session)
                this.persistSessions()
                resolve(alias)
            })

            client.on('error', (err) => {
                const session = this.sessions.get(alias)
                if (session) {
                    session.connected = false
                }
                reject(new Error(`SSH connection failed: ${err.message}`))
            })

            client.on('close', () => {
                const session = this.sessions.get(alias)
                if (session) {
                    session.connected = false
                    // 自动重连逻辑
                    if (session.reconnectAttempts < this.maxReconnectAttempts) {
                        session.reconnectAttempts++
                        setTimeout(() => {
                            this.reconnect(alias).catch((err) => {
                                console.error(`Auto-reconnect failed for ${alias}:`, err.message)
                            })
                        }, this.reconnectDelay)
                    }
                }
            })

            client.connect(connectConfig)
        })
    }

    /**
     * 重新连接
     */
    async reconnect(alias: string): Promise<void> {
        const session = this.sessions.get(alias)
        if (!session) {
            throw new Error(`Session ${alias} not found`)
        }

        try {
            session.client.end()
        } catch { /* 忽略已关闭的连接 */
        }

        await this.connect(session.config)
    }

    /**
     * 断开连接
     */
    disconnect(alias: string): boolean {
        const session = this.sessions.get(alias)
        if (session) {
            try {
                session.client.end()
            } catch { /* 忽略已关闭的连接 */
            }
            this.sessions.delete(alias)
            this.persistSessions()
            return true
        }
        return false
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
    async exec(
        alias: string,
        command: string,
        options: ExecOptions = {},
    ): Promise<ExecResult> {
        const session       = this.getSession(alias)
        const startTime     = Date.now()
        const maxOutputSize = options.maxOutputSize || this.defaultMaxOutputSize
        const fullCommand   = this.buildCommand(command, session, options)

        return new Promise((resolve, reject) => {
            const timeout                        = options.timeout || this.defaultTimeout
            let timeoutId: NodeJS.Timeout | null = null
            let stdout                           = ''
            let stderr                           = ''
            let stdoutTruncated                  = false
            let stderrTruncated                  = false

            const execOptions: any = {}

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
     * options.loadProfile 控制是否加载用户的 shell 配置（默认 true）。
     * su -c 创建非交互式 shell，不会自动执行 rc 文件，
     * 但大多数用户的环境变量设置在 rc 文件中，因此默认加载。
     * 支持 bash(.bashrc)、zsh(.zshrc) 及其他 shell(.profile)。
     */
    async execAsUser(
        alias: string,
        command: string,
        targetUser: string,
        options: ExecOptions & { loadProfile?: boolean } = {},
    ): Promise<ExecResult> {
        // 校验用户名防止注入
        if (!this.isValidUsername(targetUser)) {
            throw new Error(`Invalid username: ${targetUser}`)
        }

        const {loadProfile = true, ...execOpts} = options

        const wrappedCommand = loadProfile
                               ? `${this.getLoadProfileCommand()}${command}`
                               : command

        const suCommand = `su - ${targetUser} -c ${this.escapeShellArg(wrappedCommand)}`
        return this.exec(alias, suCommand, execOpts)
    }

    /**
     * 使用 sudo 执行命令
     */
    async execSudo(
        alias: string,
        command: string,
        sudoPassword?: string,
        options: ExecOptions = {},
    ): Promise<ExecResult> {
        let sudoCommand: string
        if (sudoPassword) {
            // 通过 stdin 传递密码（使用 escapeShellArg 转义）
            sudoCommand = `echo ${this.escapeShellArg(sudoPassword)} | sudo -S ${command}`
        } else {
            sudoCommand = `sudo ${command}`
        }
        return this.exec(alias, sudoCommand, options)
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

    /**
     * 启动持久化 PTY 会话
     */
    async ptyStart(
        alias: string,
        command: string,
        options: PtyOptions = {},
    ): Promise<string> {
        const session = this.getSession(alias)
        const ptyId   = this.generatePtyId()

        const rows          = options.rows || 24
        const cols          = options.cols || 80
        const term          = options.term || 'xterm-256color'
        const maxBufferSize = options.bufferSize || this.defaultPtyBufferSize
        const fullCommand   = this.buildCommand(command, session, options)

        return new Promise((resolve, reject) => {
            session.client.exec(
                fullCommand,
                {
                    pty: {rows, cols, term},
                },
                (err, stream) => {
                    if (err) {
                        reject(new Error(`PTY start failed: ${err.message}`))
                        return
                    }

                    // 创建 xterm headless 终端仿真器
                    const terminal = new Terminal({
                                                      rows,
                                                      cols,
                                                      allowProposedApi: true,
                                                  })

                    const ptySession: PtySession = {
                        id: ptyId,
                        alias,
                        command,
                        stream,
                        terminal,
                        rows,
                        cols,
                        createdAt: Date.now(),
                        lastReadAt: Date.now(),
                        rawBuffer: '',
                        maxBufferSize,
                        active: true,
                    }

                    // 监听输出数据
                    stream.on('data', (data: Buffer) => {
                        if (!ptySession.active) {
                            return
                        }
                        const chunk = data.toString('utf-8')
                        // 写入终端仿真器（解析 ANSI 序列）
                        terminal.write(chunk)
                        // 同时保留原始流（用于 raw 模式）
                        ptySession.rawBuffer += chunk
                        if (ptySession.rawBuffer.length > maxBufferSize) {
                            ptySession.rawBuffer = ptySession.rawBuffer.slice(-maxBufferSize)
                        }
                    })

                    stream.on('close', () => {
                        ptySession.active = false
                    })

                    stream.on('error', (err: Error) => {
                        ptySession.active = false
                        terminal.write(`\n[PTY Error: ${err.message}]`)
                    })

                    this.ptySessions.set(ptyId, ptySession)
                    resolve(ptyId)
                },
            )
        })
    }

    /**
     * 向 PTY 写入数据
     */
    ptyWrite(ptyId: string, data: string): boolean {
        const ptySession = this.ptySessions.get(ptyId)
        if (!ptySession) {
            throw new Error(`PTY session '${ptyId}' not found`)
        }
        if (!ptySession.active) {
            throw new Error(`PTY session '${ptyId}' is closed`)
        }
        return ptySession.stream.write(data)
    }

    /**
     * 读取 PTY 输出
     *
     * options.mode: 'screen' 返回当前屏幕内容，'raw' 返回原始 ANSI 流
     */
    ptyRead(
        ptyId: string,
        options: { mode?: 'screen' | 'raw'; clear?: boolean } = {},
    ): { data: string; active: boolean; rows: number; cols: number } {
        const ptySession = this.ptySessions.get(ptyId)
        if (!ptySession) {
            throw new Error(`PTY session '${ptyId}' not found`)
        }

        const mode  = options.mode || 'screen'
        const clear = options.clear !== false

        let data: string
        if (mode === 'screen') {
            // 返回当前屏幕内容（解析后的纯文本）
            data = this.getScreenContent(ptySession.terminal)
        } else {
            // 返回原始 ANSI 流
            data = ptySession.rawBuffer
            if (clear) {
                ptySession.rawBuffer = ''
            }
        }

        ptySession.lastReadAt = Date.now()
        return {
            data,
            active: ptySession.active,
            rows: ptySession.rows,
            cols: ptySession.cols,
        }
    }

    /**
     * 调整 PTY 窗口大小
     */
    ptyResize(ptyId: string, rows: number, cols: number): boolean {
        const ptySession = this.ptySessions.get(ptyId)
        if (!ptySession) {
            throw new Error(`PTY session '${ptyId}' not found`)
        }
        if (!ptySession.active) {
            throw new Error(`PTY session '${ptyId}' is closed`)
        }
        // 调整远程 PTY 窗口
        ptySession.stream.setWindow(rows, cols, 0, 0)
        // 调整本地终端仿真器
        ptySession.terminal.resize(cols, rows)
        ptySession.rows = rows
        ptySession.cols = cols
        return true
    }

    /**
     * 关闭 PTY 会话
     */
    ptyClose(ptyId: string): boolean {
        const ptySession = this.ptySessions.get(ptyId)
        if (!ptySession) {
            return false
        }
        try {
            ptySession.stream.close()
        } catch { /* 忽略清理异常 */
        }
        try {
            ptySession.terminal.dispose()
        } catch { /* 忽略清理异常 */
        }
        ptySession.active = false
        this.ptySessions.delete(ptyId)
        return true
    }

    /**
     * 列出所有 PTY 会话
     */
    ptyList(): PtySessionInfo[] {
        const result: PtySessionInfo[] = []
        for (const [id, pty] of this.ptySessions) {
            result.push({
                            id,
                            alias: pty.alias,
                            command: pty.command,
                            rows: pty.rows,
                            cols: pty.cols,
                            createdAt: pty.createdAt,
                            lastReadAt: pty.lastReadAt,
                            bufferSize: pty.rawBuffer.length,
                            active: pty.active,
                        })
        }
        return result
    }

    /**
     * 创建本地端口转发
     * 本地监听 localHost:localPort，转发到远程 remoteHost:remotePort
     */
    async forwardLocal(
        alias: string,
        localPort: number,
        remoteHost: string,
        remotePort: number,
        localHost: string = '127.0.0.1',
    ): Promise<string> {
        const session   = this.getSession(alias)
        const forwardId = this.generateForwardId()

        return new Promise((resolve, reject) => {
            const server = net.createServer((socket) => {
                session.client.forwardOut(
                    socket.remoteAddress || '127.0.0.1',
                    socket.remotePort || 0,
                    remoteHost,
                    remotePort,
                    (err, stream) => {
                        if (err) {
                            socket.end()
                            return
                        }
                        socket.pipe(stream).pipe(socket)
                    },
                )
            })

            server.on('error', (err) => {
                reject(new Error(`Local forward failed: ${err.message}`))
            })

            server.listen(localPort, localHost, () => {
                const fwdSession: ForwardSession = {
                    id: forwardId,
                    alias,
                    type: 'local',
                    localHost,
                    localPort,
                    remoteHost,
                    remotePort,
                    server,
                    createdAt: Date.now(),
                    active: true,
                }
                this.forwardSessions.set(forwardId, fwdSession)
                resolve(forwardId)
            })
        })
    }

    /**
     * 创建远程端口转发
     * 远程监听 remoteHost:remotePort，转发到本地 localHost:localPort
     */
    async forwardRemote(
        alias: string,
        remotePort: number,
        localHost: string,
        localPort: number,
        remoteHost: string = '127.0.0.1',
    ): Promise<string> {
        const session   = this.getSession(alias)
        const forwardId = this.generateForwardId()

        return new Promise((resolve, reject) => {
            session.client.forwardIn(remoteHost, remotePort, (err) => {
                if (err) {
                    reject(new Error(`Remote forward failed: ${err.message}`))
                    return
                }

                const fwdSession: ForwardSession = {
                    id: forwardId,
                    alias,
                    type: 'remote',
                    localHost,
                    localPort,
                    remoteHost,
                    remotePort,
                    createdAt: Date.now(),
                    active: true,
                }
                this.forwardSessions.set(forwardId, fwdSession)

                // 确保该 session 有共享的 tcp dispatcher
                this.ensureTcpDispatcher(session, alias)

                resolve(forwardId)
            })
        })
    }

    /**
     * 关闭端口转发
     */
    forwardClose(forwardId: string): boolean {
        const fwdSession = this.forwardSessions.get(forwardId)
        if (!fwdSession) {
            return false
        }

        fwdSession.active = false

        if (fwdSession.type === 'local' && fwdSession.server) {
            try {
                fwdSession.server.close()
            } catch { /* 忽略清理异常 */
            }
        } else if (fwdSession.type === 'remote') {
            const session = this.sessions.get(fwdSession.alias)
            if (session) {
                try {
                    session.client.unforwardIn(fwdSession.remoteHost, fwdSession.remotePort)
                } catch { /* 忽略清理异常 */
                }
                // 检查是否需要移除共享 dispatcher
                this.removeTcpDispatcherIfEmpty(session, fwdSession.alias)
            }
        }

        this.forwardSessions.delete(forwardId)
        return true
    }

    /**
     * 列出所有端口转发
     */
    forwardList(): PortForwardInfo[] {
        const result: PortForwardInfo[] = []
        for (const [id, fwd] of this.forwardSessions) {
            result.push({
                            id,
                            alias: fwd.alias,
                            type: fwd.type,
                            localHost: fwd.localHost,
                            localPort: fwd.localPort,
                            remoteHost: fwd.remoteHost,
                            remotePort: fwd.remotePort,
                            createdAt: fwd.createdAt,
                            active: fwd.active,
                        })
        }
        return result
    }

    private ensurePersistDir(): void {
        const dir = path.dirname(this.persistPath)
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, {recursive: true})
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
    ): Promise<ClientChannel> {
        return new Promise((resolve, reject) => {
            jumpClient.forwardOut(
                '127.0.0.1',
                0,
                targetHost,
                targetPort,
                (err, stream) => {
                    if (err) {
                        reject(err)
                    } else {
                        resolve(stream)
                    }
                },
            )
        })
    }

    /**
     * 检查连接是否存活
     */
    private isAlive(session: SSHSession): boolean {
        return session.connected
    }

    /**
     * 转义 shell 参数（使用单引号方式）
     */
    private escapeShellArg(s: string): string {
        return `'${s.replace(/'/g, '\'\\\'\'')}'`
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
        options: { env?: Record<string, string>; cwd?: string },
    ): string {
        let fullCommand = command
        const env       = {...session.config.env, ...options.env}

        if (Object.keys(env).length > 0) {
            const validEntries = Object.entries(env).filter(([k]) => this.isValidEnvKey(k))
            if (validEntries.length > 0) {
                const envStr = validEntries
                    .map(([k, v]) => `export ${k}=${this.escapeShellArg(v)}`)
                    .join('; ')
                fullCommand  = `${envStr}; ${command}`
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
        return 'case "$(basename "$SHELL" 2>/dev/null)" in ' +
               'bash) [ -f ~/.bashrc ] && . ~/.bashrc ;; ' +
               'zsh) [ -f ~/.zshrc ] && . ~/.zshrc ;; ' +
               '*) [ -f ~/.profile ] && . ~/.profile ;; ' +
               'esac 2>/dev/null; '
    }

    /**
     * 持久化会话信息
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
        try {
            fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2))
        } catch (e) {
            // 忽略写入错误
        }
    }

    /**
     * 生成 PTY 会话 ID
     */
    private generatePtyId(): string {
        return `pty_${++this.ptyIdCounter}_${Date.now()}`
    }

    /**
     * 从终端仿真器获取当前屏幕内容
     */
    private getScreenContent(terminal: TerminalType): string {
        const buffer          = terminal.buffer.active
        const lines: string[] = []
        for (let i = 0; i < terminal.rows; i++) {
            const line = buffer.getLine(i)
            if (line) {
                lines.push(line.translateToString(true))
            }
        }
        // 移除尾部空行
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
            lines.pop()
        }
        return lines.join('\n')
    }

    /**
     * 生成端口转发 ID
     */
    private generateForwardId(): string {
        return `fwd_${++this.forwardIdCounter}_${Date.now()}`
    }

    /**
     * 确保 SSH session 有共享的 tcp connection dispatcher
     * 所有 remote forward 共用一个 dispatcher，根据 destIP/destPort 路由
     */
    private ensureTcpDispatcher(session: SSHSession, alias: string): void {
        if (session.tcpDispatcher) {
            return  // 已存在
        }

        const dispatcher: TcpConnectionHandler = (info, accept, rejectConn) => {
            // 查找匹配的 remote forward
            for (const fwd of this.forwardSessions.values()) {
                if (fwd.type === 'remote' &&
                    fwd.active &&
                    fwd.alias === alias &&
                    fwd.remoteHost === info.destIP &&
                    fwd.remotePort === info.destPort) {
                    // 找到匹配的 forward，建立连接
                    const stream = accept()
                    const socket = net.createConnection(fwd.localPort, fwd.localHost)
                    socket.pipe(stream).pipe(socket)
                    socket.on('error', () => stream.close())
                    stream.on('error', () => socket.destroy())
                    return
                }
            }
            // 没有匹配的 forward，拒绝连接
            rejectConn()
        }

        session.tcpDispatcher = dispatcher
        session.client.on('tcp connection', dispatcher)
    }

    /**
     * 移除 SSH session 的 tcp dispatcher（当没有 remote forward 时）
     */
    private removeTcpDispatcherIfEmpty(session: SSHSession, alias: string): void {
        if (!session.tcpDispatcher) {
            return
        }

        // 检查是否还有该 session 的 remote forward
        for (const fwd of this.forwardSessions.values()) {
            if (fwd.type === 'remote' && fwd.alias === alias && fwd.active) {
                return  // 还有活跃的 remote forward
            }
        }

        // 没有了，移除 dispatcher
        session.client.removeListener('tcp connection', session.tcpDispatcher)
        session.tcpDispatcher = undefined
    }
}

// 全局单例
export const sessionManager = new SessionManager()
