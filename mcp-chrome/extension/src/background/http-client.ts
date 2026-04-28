/**
 * HTTP/WebSocket Client — 多连接版
 *
 * Extension 侧的通信客户端：
 * - 自动发现所有 MCP Server（扫描端口范围）
 * - 同时连接多个 Server，每个连接独立管理
 * - WebSocket 双向通信
 * - 自动重连（指数退避）
 * - 心跳检测（连接存活确认）
 */

const PORT_RANGE_START = 19222
const PORT_RANGE_END = 19299
const HEALTH_CHECK_TIMEOUT = 500
const MAX_RECONNECT_DELAY = 30000
const HEARTBEAT_TIMEOUT = 20000

interface ServerConnection {
    ws: WebSocket
    heartbeatTimer: ReturnType<typeof setTimeout> | null
}

type MessageHandler = (message: { id: string; action: string; params: unknown }, port: number) => void
type StatusHandler = (status: 'connected' | 'disconnected' | 'connecting', connectedCount: number) => void

export class HttpClient {
    private connections = new Map<number, ServerConnection>()
    private messageHandler: MessageHandler | null = null
    private statusHandler: StatusHandler | null = null
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null
    private reconnectAttempts = 0
    private shouldReconnect = true
    private connecting = false

    onMessage(handler: MessageHandler): void {
        this.messageHandler = handler
    }

    onStatusChange(handler: StatusHandler): void {
        this.statusHandler = handler
    }

    /**
     * 扫描所有端口，连接所有健康的 MCP Server（跳过已连接的）
     */
    async connect(): Promise<{ connected: number; ports: number[] }> {
        if (this.connecting) {
            return { connected: this.connections.size, ports: this.getConnectedPorts() }
        }

        this.stopReconnect()
        this.connecting = true
        this.shouldReconnect = true

        const wasConnected = this.connections.size > 0

        if (!wasConnected) {
            this.statusHandler?.('connecting', 0)
        }

        try {
            const healthyPorts = await this.discoverServers()

            if (healthyPorts.length === 0 && this.connections.size === 0) {
                this.statusHandler?.('disconnected', 0)
                this.scheduleReconnect()
                return { connected: 0, ports: [] }
            }

            // 连接所有尚未连接的健康端口
            const newPorts = healthyPorts.filter((p) => !this.connections.has(p))
            const results = await Promise.allSettled(newPorts.map((port) => this.connectToPort(port)))

            const successCount = results.filter((r) => r.status === 'fulfilled' && r.value).length

            if (successCount > 0) {
                this.reconnectAttempts = 0
            }

            const ports = this.getConnectedPorts()

            if (ports.length === 0 && this.shouldReconnect) {
                this.scheduleReconnect()
            }

            return { connected: ports.length, ports }
        } finally {
            this.connecting = false
        }
    }

    disconnect(): void {
        this.shouldReconnect = false
        this.stopReconnect()

        for (const [port, conn] of this.connections) {
            this.stopHeartbeat(port)
            conn.ws.close()
        }
        this.connections.clear()
        this.statusHandler?.('disconnected', 0)
    }

    isConnected(): boolean {
        return this.connections.size > 0
    }

    getConnectedPorts(): number[] {
        return Array.from(this.connections.keys()).sort((a, b) => a - b)
    }

    sendResponse(id: string, success: boolean, data?: unknown, error?: string, port?: number): void {
        if (port === undefined) {
            console.error('[HTTP] Cannot send response: no port specified')
            return
        }

        const conn = this.connections.get(port)
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
            console.error(`[HTTP] Cannot send response to port ${port}: not connected`)
            return
        }

        conn.ws.send(JSON.stringify({ id, success, data, error }))
    }

    private async connectToPort(port: number): Promise<boolean> {
        // 已连接则跳过
        if (this.connections.has(port)) {
            return true
        }

        return new Promise((resolve) => {
            try {
                const url = `ws://127.0.0.1:${port}/`
                const ws = new WebSocket(url)
                let resolved = false

                const connectionTimeout = setTimeout(() => {
                    if (ws.readyState !== WebSocket.OPEN) {
                        ws.close()
                        if (!resolved) {
                            resolved = true
                            resolve(false)
                        }
                    }
                }, 5000)

                ws.onopen = () => {
                    clearTimeout(connectionTimeout)
                    resolved = true

                    const conn: ServerConnection = {
                        ws,
                        heartbeatTimer: null,
                    }
                    this.connections.set(port, conn)
                    this.resetHeartbeat(port)

                    // 版本握手
                    ws.send(JSON.stringify({ type: 'hello', version: chrome.runtime.getManifest().version }))

                    console.log(`[HTTP] Connected to MCP Server at port ${port} (total: ${this.connections.size})`)
                    this.statusHandler?.('connected', this.connections.size)

                    resolve(true)
                }

                ws.onmessage = (event) => {
                    this.handleMessage(event.data, port)
                }

                ws.onclose = () => {
                    console.log(`[HTTP] WebSocket closed for port ${port}`)
                    this.removeConnection(port)
                }

                ws.onerror = (error) => {
                    clearTimeout(connectionTimeout)
                    console.error(`[HTTP] WebSocket error for port ${port}:`, error)
                    if (resolved) {
                        // onopen 已触发后再 onerror：连接进入异常状态，清理资源
                        this.removeConnection(port)
                    } else {
                        resolved = true
                        resolve(false)
                    }
                }
            } catch {
                resolve(false)
            }
        })
    }

    /**
     * 清理单个连接及其资源
     */
    private removeConnection(port: number): void {
        const conn = this.connections.get(port)
        if (!conn) {
            return
        }

        this.stopHeartbeat(port)
        this.connections.delete(port)

        if (this.connections.size > 0) {
            this.statusHandler?.('connected', this.connections.size)
        } else {
            this.statusHandler?.('disconnected', 0)
            if (this.shouldReconnect) {
                this.scheduleReconnect()
            }
        }
    }

    /**
     * 扫描端口范围，返回所有健康的 Server 端口
     *
     * 完整扫描整段范围，保证多 CC 并存时新启动的 server 能被发现
     */
    private async discoverServers(): Promise<number[]> {
        const healthyPorts: number[] = []
        const checks = []
        for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
            checks.push(
                this.checkPort(port).then((ok) => {
                    if (ok) {
                        healthyPorts.push(port)
                    }
                })
            )
        }
        await Promise.all(checks)

        if (healthyPorts.length > 0) {
            console.log(
                `[HTTP] Found ${healthyPorts.length} MCP Server(s) at ports: ${healthyPorts
                    .sort((a, b) => a - b)
                    .join(', ')}`
            )
        } else {
            console.log('[HTTP] No MCP Server found in port range')
        }

        return healthyPorts.sort((a, b) => a - b)
    }

    private async checkPort(port: number): Promise<boolean> {
        try {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT)

            const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
                signal: controller.signal,
            })

            clearTimeout(timeoutId)
            return response.ok
        } catch {
            return false
        }
    }

    private handleMessage(data: string, port: number): void {
        try {
            const message = JSON.parse(data)

            // 心跳：收到 ping 说明连接存活，重置心跳计时器
            if (message.type === 'ping') {
                const conn = this.connections.get(port)
                conn?.ws.send(JSON.stringify({ type: 'pong' }))
                this.resetHeartbeat(port)
                return
            }

            // 命令请求
            if (message.action && message.id && this.messageHandler) {
                this.messageHandler(message, port)
            }
        } catch (error) {
            console.error(`[HTTP] Error parsing message from port ${port}:`, error)
        }
    }

    /**
     * 重置指定连接的心跳计时器
     */
    private resetHeartbeat(port: number): void {
        this.stopHeartbeat(port)

        const conn = this.connections.get(port)
        if (!conn) {
            return
        }

        conn.heartbeatTimer = setTimeout(() => {
            console.log(`[HTTP] Heartbeat timeout for port ${port}, closing connection`)
            const c = this.connections.get(port)
            if (c) {
                c.ws.close()
                // onclose 会触发 removeConnection
            }
        }, HEARTBEAT_TIMEOUT)
    }

    private stopHeartbeat(port: number): void {
        const conn = this.connections.get(port)
        if (conn?.heartbeatTimer) {
            clearTimeout(conn.heartbeatTimer)
            conn.heartbeatTimer = null
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer || !this.shouldReconnect) {
            return
        }

        this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 1000)
        const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts - 1), MAX_RECONNECT_DELAY)

        console.log(`[HTTP] Scheduling reconnect in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`)

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null
            if (this.shouldReconnect) {
                await this.connect()
            }
        }, delay)
    }

    private stopReconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
    }
}
