/**
 * HTTP + WebSocket Server
 *
 * 替代 Unix Socket，提供更可靠的通信方式：
 * - HTTP 端点：健康检查、服务器信息
 * - WebSocket：双向实时通信
 * - 自动端口选择：19222-19299 范围
 * - 心跳检测：定期 ping 检测 Extension 存活
 */

import {EventEmitter} from 'events'
import {createServer, IncomingMessage, Server, ServerResponse} from 'http'
import {WebSocket, WebSocketServer} from 'ws'
import {DEFAULT_TIMEOUT} from '../core/types.js'

const SERVER_VERSION     = '1.3.0'
const DEFAULT_PORT       = 19222
const MAX_PORT           = 19299
const REQUEST_TIMEOUT    = DEFAULT_TIMEOUT
const HEARTBEAT_INTERVAL = 15000 // 每 15 秒发送一次 ping，下次 ping 前检查 pong

export interface HttpServerOptions {
    port?: number;
    autoPort?: boolean;
}

interface MessageHandler {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
}

export class ExtensionHttpServer extends EventEmitter {
    private server: Server | null                    = null
    private wss: WebSocketServer | null              = null
    private clientSocket: WebSocket | null           = null
    private port                                     = 0
    private messageHandlers                          = new Map<string, MessageHandler>()
    private extensionVersion: string | null          = null
    private heartbeatInterval: NodeJS.Timeout | null = null
    private pongReceived                             = false

    constructor(private options: HttpServerOptions = {}) {
        super()
    }

    async start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = createServer((req, res) => this.handleHttpRequest(req, res))

            const port = this.options.port ?? DEFAULT_PORT
            this.tryListen(port, resolve, reject)
        })
    }

    /**
     * 发送命令到 Extension
     * @param action 操作名称
     * @param params 操作参数
     * @param requestTimeout 端到端预算（毫秒），包含连接等待和请求超时。
     *                       不传则使用 REQUEST_TIMEOUT (30s)。
     *                       ≤0 直接失败。
     */
    async sendCommand(action: string, params: unknown = {}, requestTimeout?: number): Promise<unknown> {
        const budget = requestTimeout ?? REQUEST_TIMEOUT
        if (budget <= 0) {
            throw new Error(`Request timeout for action: ${action} (budget ${budget}ms)`)
        }

        const startTime = Date.now()
        let connectWait = 0

        if (!this.isConnected()) {
            const connectStart = Date.now()
            const connected    = await this.waitForConnection(budget)
            connectWait        = Date.now() - connectStart
            if (!connected) {
                throw new Error('Extension 未连接。请确保 Chrome 已打开并安装了 MCP Chrome Extension。')
            }
        }

        // 端到端预算：函数入口至今的总耗时从预算中扣除
        const remaining = budget - (Date.now() - startTime)
        if (remaining <= 0) {
            const detail = connectWait > 0
                           ? `budget ${budget}ms, connection wait ${connectWait}ms`
                           : `budget ${budget}ms`
            throw new Error(`Request timeout for action: ${action} (${detail})`)
        }

        return new Promise((resolve, reject) => {
            const messageId = this.generateId()
            const message   = { id: messageId, action, params }

            const timeout = setTimeout(() => {
                this.messageHandlers.delete(messageId)
                const detail = connectWait > 0
                               ? `budget ${budget}ms, connection wait ${connectWait}ms`
                               : `${budget}ms`
                reject(new Error(`Request timeout for action: ${action} (${detail})`))
            }, remaining)

            this.messageHandlers.set(messageId, { resolve, reject, timeout })

            try {
                this.clientSocket!.send(JSON.stringify(message))
            } catch (err) {
                clearTimeout(timeout)
                this.messageHandlers.delete(messageId)
                reject(new Error(`Failed to send command ${action}: ${err instanceof Error ?
                                                                      err.message :
                                                                      'Unknown error'}`))
            }
        })
    }

    async waitForConnection(timeout = 0): Promise<boolean> {
        if (this.isConnected()) {
            return true
        }

        return new Promise<boolean>((resolve) => {
            let timer: NodeJS.Timeout | undefined

            const onConnected = () => {
                if (timer) {
                    clearTimeout(timer)
                }
                resolve(true)
            }

            if (timeout > 0) {
                timer = setTimeout(() => {
                    this.removeListener('connected', onConnected)
                    resolve(false)
                }, timeout)
            }

            this.once('connected', onConnected)
        })
    }

    isConnected(): boolean {
        return this.clientSocket?.readyState === WebSocket.OPEN
    }

    getPort(): number {
        return this.port
    }

    async stop(): Promise<void> {
        this.stopHeartbeat()
        this.rejectPendingHandlers('Server stopped')

        this.clientSocket?.close()
        this.wss?.close()

        return new Promise(resolve => {
            if (this.server) {
                this.server.close(() => resolve())
            } else {
                resolve()
            }
        })
    }

    /**
     * 绑定成功后初始化 WebSocket Server
     */
    private setupWebSocket(): void {
        this.wss = new WebSocketServer({ server: this.server! })

        this.wss.on('connection', (ws, req) => {
            // Origin 校验：拒绝非 Extension 来源（如网页 JS 的跨域 WebSocket）。
            // 无 Origin 的连接（如 Extension Service Worker、curl 等本地工具）放行，
            // 安全性由 listen 绑定 127.0.0.1 保证（仅本机进程可达）。
            const origin = req.headers.origin
            if (origin && !origin.startsWith('chrome-extension://')) {
                console.error(`[HTTP] Rejected WebSocket connection from origin: ${origin}`)
                ws.close(4003, 'Forbidden origin')
                return
            }

            console.error('[HTTP] Extension connected')

            // 只允许一个客户端连接，关闭旧的
            if (this.clientSocket) {
                // 旧连接的 pending handlers 无法被新连接响应，立即 reject
                this.rejectPendingHandlers('Connection replaced by new client')
                this.clientSocket.close()
            }

            this.clientSocket = ws
            this.startHeartbeat()
            this.emit('connected')

            ws.on('message', (data) => {
                this.handleMessage(data.toString())
            })

            ws.on('close', () => {
                console.error('[HTTP] Extension disconnected')
                if (this.clientSocket === ws) {
                    this.clientSocket     = null
                    this.extensionVersion = null
                    this.stopHeartbeat()
                    // 立即 reject 所有 pending 请求，而非等待个别超时
                    this.rejectPendingHandlers('Extension disconnected')
                    this.emit('disconnected')
                }
            })

            ws.on('error', (error) => {
                console.error('[HTTP] WebSocket error:', error.message)
            })
        })
    }

    private tryListen(port: number, resolve: () => void, reject: (err: Error) => void): void {
        this.server!.once('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE' && this.options.autoPort !== false && port < MAX_PORT) {
                console.error(`[HTTP] Port ${port} already in use, trying ${port + 1}...`)
                this.tryListen(port + 1, resolve, reject)
            } else {
                reject(err)
            }
        })

        this.server!.listen(port, '127.0.0.1', () => {
            this.port = port
            this.setupWebSocket()
            console.error(`[HTTP] Server listening on http://127.0.0.1:${port}`)
            resolve()
        })
    }

    private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
        // Origin 校验：只允许 Chrome Extension 或无 Origin（如 curl 等本地工具）
        const origin = req.headers.origin
        if (origin && !origin.startsWith('chrome-extension://')) {
            res.writeHead(403)
            res.end(JSON.stringify({ error: 'Forbidden: only Chrome Extension origin allowed' }))
            return
        }

        // CORS 头：限制为请求来源（不使用通配符）
        res.setHeader('Access-Control-Allow-Origin', origin || '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
        res.setHeader('Content-Type', 'application/json')

        if (req.method === 'OPTIONS') {
            res.writeHead(204)
            res.end()
            return
        }

        const url = req.url ?? '/'

        if (url === '/api/health') {
            res.writeHead(200)
            res.end(JSON.stringify({ status: 'ok', port: this.port }))
            return
        }

        if (url === '/api/info') {
            res.writeHead(200)
            res.end(JSON.stringify({
                                       serverVersion: SERVER_VERSION,
                                       extensionVersion: this.extensionVersion,
                                       port: this.port,
                                       connected: this.isConnected(),
                                   }))
            return
        }

        res.writeHead(404)
        res.end(JSON.stringify({ error: 'Not found' }))
    }

    private handleMessage(data: string): void {
        try {
            const message = JSON.parse(data) as {
                id?: string;
                success?: boolean;
                data?: unknown;
                error?: string;
                type?: string;
                version?: string
            }

            // 心跳响应
            if (message.type === 'pong') {
                this.pongReceived = true
                return
            }

            // 版本握手
            if (message.type === 'hello') {
                this.extensionVersion = message.version ?? null
                const serverMajor     = SERVER_VERSION.split('.')[0]
                const extMajor        = (message.version ?? '0').split('.')[0]
                if (serverMajor !== extMajor) {
                    console.error(`[HTTP] ⚠ Version mismatch: Server ${SERVER_VERSION}, Extension ${message.version}. Please update both to the same major version.`)
                } else {
                    console.error(`[HTTP] Extension version: ${message.version}`)
                }
                return
            }

            // 响应消息
            if (message.id && this.messageHandlers.has(message.id)) {
                const handler = this.messageHandlers.get(message.id)!
                clearTimeout(handler.timeout)
                this.messageHandlers.delete(message.id)

                if (message.success) {
                    handler.resolve(message.data)
                } else {
                    handler.reject(new Error(message.error ?? 'Unknown error'))
                }
            }
        } catch (error) {
            console.error('[HTTP] Error parsing message:', error)
        }
    }

    /**
     * 启动心跳：定期发送 ping，检测 pong 响应
     * 如果 Extension 的 Service Worker 被 Chrome 杀死，TCP 连接可能不会立即关闭，
     * 心跳机制能及时检测到这种"半死"连接并清理。
     */
    private startHeartbeat(): void {
        this.stopHeartbeat()
        this.pongReceived = true // 初始认为存活

        this.heartbeatInterval = setInterval(() => {
            if (!this.clientSocket || this.clientSocket.readyState !== WebSocket.OPEN) {
                this.stopHeartbeat()
                return
            }

            // 检查上次 ping 是否收到了 pong
            if (!this.pongReceived) {
                console.error('[HTTP] Heartbeat timeout, closing dead connection')
                this.clientSocket.terminate() // 强制关闭，不等握手
                return
            }

            // 发送新的 ping
            this.pongReceived = false
            try {
                this.clientSocket.send(JSON.stringify({ type: 'ping' }))
            } catch {
                console.error('[HTTP] Failed to send heartbeat ping')
            }
        }, HEARTBEAT_INTERVAL)
    }

    private stopHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval)
            this.heartbeatInterval = null
        }
    }

    /**
     * 立即 reject 所有 pending 请求并清理
     */
    private rejectPendingHandlers(reason: string): void {
        for (const [, handler] of this.messageHandlers) {
            clearTimeout(handler.timeout)
            handler.reject(new Error(reason))
        }
        this.messageHandlers.clear()
    }

    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substring(2)
    }
}
