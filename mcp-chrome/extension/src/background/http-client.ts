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
const PAIRING_TOKEN_STORAGE_KEY = 'mcp_pairing_token'
const ALLOW_INSECURE_NO_TOKEN_STORAGE_KEY = 'mcp_allow_insecure_no_token_v2'

interface ServerConnection {
    ws: WebSocket
    heartbeatTimer: ReturnType<typeof setTimeout> | null
    ready: boolean
    instanceId: string | null
    auth?: VerifiedAuth
    sent: number
    received: number
    sendChain: Promise<void>
    receiveChain: Promise<void>
    requests: Map<string, AbortController>
}

interface VerifiedAuth {
    clientNonce: string
    serverNonce: string
    clientProof: string
    session: string
    sendKey: string
    receiveKey: string
}

interface HealthResponse {
    status?: string
    port?: number
    instanceId?: string
    authRequired?: boolean
    auth?: {
        protocol?: number
        clientNonce?: string
        serverNonce?: string
        serverProof?: string
    }
}

type PortFailureKind = 'authentication' | 'protocol'

interface PortCheckResult {
    healthy: boolean
    failureKind?: PortFailureKind
    reason?: string
}

type Reply = (success: boolean, data?: unknown, error?: string) => void
type MessageHandler = (
    message: { id: string; action: string; params: unknown },
    port: number,
    signal: AbortSignal,
    reply: Reply
) => void | Promise<void>
type StatusHandler = (status: 'connected' | 'disconnected' | 'connecting', connectedCount: number) => void

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
}

function randomHex(bytes = 16): string {
    const data = new Uint8Array(bytes)
    crypto.getRandomValues(data)
    return bytesToHex(data)
}

let backgroundBundleHashPromise: Promise<string | undefined> | undefined

async function loadBackgroundBundleHash(): Promise<string | undefined> {
    try {
        const response = await fetch(chrome.runtime.getURL('service-worker-loader.js'), { cache: 'no-store' })
        if (!response.ok) {
            console.warn(`[HTTP] Cannot read Extension service worker loader: HTTP ${response.status}`)
            return undefined
        }
        const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer())
        return `sha256:${bytesToHex(new Uint8Array(digest))}`
    } catch (error) {
        console.warn(
            '[HTTP] Cannot compute Extension background bundle hash:',
            error instanceof Error ? error.message : String(error)
        )
        return undefined
    }
}

function getBackgroundBundleHash(): Promise<string | undefined> {
    backgroundBundleHashPromise ??= loadBackgroundBundleHash()
    return backgroundBundleHashPromise
}

async function hmacHex(token: string, payload: string): Promise<string> {
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey('raw', encoder.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
    ])
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
    return bytesToHex(new Uint8Array(signature))
}

export class HttpClient {
    private connections = new Map<number, ServerConnection>()
    private verifiedAuth = new Map<number, VerifiedAuth>()
    private verifiedInstanceIds = new Map<number, string>()
    private connectionClosedHandler: ((instanceId: string) => void) | null = null
    private messageHandler: MessageHandler | null = null
    private statusHandler: StatusHandler | null = null
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null
    private reconnectAttempts = 0
    private shouldReconnect = true
    private generation = 0
    private connectingGeneration: number | null = null
    private pendingHealthChecks = new Set<AbortController>()
    private pendingSockets = new Set<WebSocket>()
    private pairingToken: string | null = null
    private pairingTokenLoaded = false
    private allowInsecureNoToken: boolean | null = null
    private lastServerFailureSummary = ''
    private lastDiscoverySummary: string | null = null

    onMessage(handler: MessageHandler): void {
        this.messageHandler = handler
    }

    onStatusChange(handler: StatusHandler): void {
        this.statusHandler = handler
    }

    onConnectionClosed(handler: (instanceId: string) => void): void {
        this.connectionClosedHandler = handler
    }

    getConnectedServers(): Array<{ port: number; instanceId: string | null }> {
        return this.getConnectedPorts().map((port) => ({
            port,
            instanceId: this.connections.get(port)?.instanceId ?? null,
        }))
    }

    getServerInstanceId(port: number): string | null {
        return this.connections.get(port)?.instanceId ?? null
    }

    async setPairingToken(token: string): Promise<void> {
        this.pairingToken = token.trim()
        this.pairingTokenLoaded = true
        this.disconnect()
        const generation = this.generation
        await chrome.storage.local.set({ [PAIRING_TOKEN_STORAGE_KEY]: this.pairingToken })
        if (generation === this.generation && this.pairingToken) {
            await this.connect()
        }
    }

    async hasPairingToken(): Promise<boolean> {
        return (await this.getPairingToken()).length > 0
    }

    async setAllowInsecureNoToken(allow: boolean): Promise<void> {
        this.allowInsecureNoToken = allow
        this.disconnect()
        const generation = this.generation
        await chrome.storage.local.set({ [ALLOW_INSECURE_NO_TOKEN_STORAGE_KEY]: allow })
        if (generation === this.generation && allow) {
            await this.connect()
        }
    }

    async isAllowInsecureNoToken(): Promise<boolean> {
        return await this.getAllowInsecureNoToken()
    }

    /**
     * 扫描所有端口，连接所有健康的 MCP Server（跳过已连接的）
     */
    async connect(): Promise<{ connected: number; ports: number[] }> {
        const generation = this.generation
        if (this.connectingGeneration === generation) {
            return { connected: this.connections.size, ports: this.getConnectedPorts() }
        }

        this.stopReconnect()
        this.connectingGeneration = generation
        this.shouldReconnect = true

        const wasConnected = this.connections.size > 0

        if (!wasConnected) {
            this.statusHandler?.('connecting', 0)
        }

        try {
            const healthyPorts = await this.discoverServers(generation)
            if (!this.isGenerationActive(generation)) {
                return { connected: this.connections.size, ports: this.getConnectedPorts() }
            }

            if (healthyPorts.length === 0 && this.connections.size === 0) {
                this.statusHandler?.('disconnected', 0)
                this.scheduleReconnect()
                return { connected: 0, ports: [] }
            }

            // 连接所有尚未连接的健康端口
            const newPorts = healthyPorts.filter((p) => !this.connections.has(p))
            const results = await Promise.allSettled(newPorts.map((port) => this.connectToPort(port, generation)))
            if (!this.isGenerationActive(generation)) {
                return { connected: this.connections.size, ports: this.getConnectedPorts() }
            }

            const successCount = results.filter((r) => r.status === 'fulfilled' && r.value).length
            const failedPorts = newPorts.filter(
                (_, index) => results[index].status !== 'fulfilled' || !results[index].value
            )
            if (failedPorts.length > 0) {
                console.debug(
                    `[HTTP] ${failedPorts.length} candidate WebSocket connection(s) rejected before open: ${failedPorts
                        .slice(0, 10)
                        .join(', ')}${failedPorts.length > 10 ? ', ...' : ''}`
                )
            }

            if (successCount > 0) {
                this.reconnectAttempts = 0
            }

            const ports = this.getConnectedPorts()

            if (ports.length === 0 && this.shouldReconnect) {
                this.scheduleReconnect()
            }

            return { connected: ports.length, ports }
        } finally {
            if (this.connectingGeneration === generation) {
                this.connectingGeneration = null
            }
        }
    }

    disconnect(): void {
        this.shouldReconnect = false
        this.generation += 1
        this.connectingGeneration = null
        this.lastDiscoverySummary = null
        this.lastServerFailureSummary = ''
        this.stopReconnect()

        for (const controller of this.pendingHealthChecks) {
            controller.abort()
        }
        this.pendingHealthChecks.clear()
        for (const ws of this.pendingSockets) {
            try {
                ws.close()
            } catch {
                // CONNECTING 状态的 socket 仍会由 generation 检查拒绝登记
            }
        }
        this.pendingSockets.clear()

        for (const [port, conn] of this.connections) {
            this.stopHeartbeat(port)
            const instanceId = conn.instanceId
            if (instanceId) {
                this.connectionClosedHandler?.(instanceId)
            }
            for (const controller of conn.requests.values()) {
                controller.abort()
            }
            conn.ws.close()
        }
        this.connections.clear()
        this.verifiedAuth.clear()
        this.verifiedInstanceIds.clear()
        this.statusHandler?.('disconnected', 0)
    }

    isConnected(): boolean {
        return this.getConnectedPorts().length > 0
    }

    getConnectedPorts(): number[] {
        return Array.from(this.connections)
            .filter(([, conn]) => conn.ready)
            .map(([port]) => port)
            .sort((a, b) => a - b)
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

        void this.sendMessage(conn, { id, success, data, error }).catch((error) => {
            console.warn('[HTTP] Response delivery failed:', error)
            conn.ws.close()
        })
    }

    private async getPairingToken(): Promise<string> {
        if (this.pairingTokenLoaded) {
            return this.pairingToken ?? ''
        }
        const result = await chrome.storage.local.get(PAIRING_TOKEN_STORAGE_KEY)
        if (this.pairingTokenLoaded) {
            return this.pairingToken ?? ''
        }
        this.pairingToken =
            typeof result[PAIRING_TOKEN_STORAGE_KEY] === 'string' ? result[PAIRING_TOKEN_STORAGE_KEY] : ''
        this.pairingTokenLoaded = true
        return this.pairingToken ?? ''
    }

    private async getAllowInsecureNoToken(): Promise<boolean> {
        if (this.allowInsecureNoToken !== null) {
            return this.allowInsecureNoToken
        }
        const result = await chrome.storage.local.get(ALLOW_INSECURE_NO_TOKEN_STORAGE_KEY)
        if (this.allowInsecureNoToken !== null) {
            return this.allowInsecureNoToken
        }
        // 与 server 侧默认一致：未显式关闭时允许本地自动连接；v2 key 避免旧版 false 值污染默认行为
        this.allowInsecureNoToken = result[ALLOW_INSECURE_NO_TOKEN_STORAGE_KEY] !== false
        return this.allowInsecureNoToken
    }

    private async connectToPort(port: number, generation: number): Promise<boolean> {
        // 已连接则跳过
        if (this.connections.has(port)) {
            return true
        }
        if (!this.isGenerationActive(generation)) {
            return false
        }

        return new Promise((resolve) => {
            const auth = this.verifiedAuth.get(port)
            const authQuery = auth
                ? `?protocol=2&clientNonce=${encodeURIComponent(auth.clientNonce)}` +
                  `&serverNonce=${encodeURIComponent(auth.serverNonce)}` +
                  `&clientProof=${encodeURIComponent(auth.clientProof)}`
                : ''
            const ws = new WebSocket(`ws://127.0.0.1:${port}/${authQuery}`)
            const conn: ServerConnection = {
                ws,
                auth,
                heartbeatTimer: null,
                ready: false,
                instanceId: this.verifiedInstanceIds.get(port) ?? null,
                sent: 0,
                received: 0,
                sendChain: Promise.resolve(),
                receiveChain: Promise.resolve(),
                requests: new Map(),
            }
            this.pendingSockets.add(ws)
            let resolved = false
            const finishCandidate = (result: boolean) => {
                if (resolved) {
                    return
                }
                resolved = true
                clearTimeout(connectionTimeout)
                this.pendingSockets.delete(ws)
                resolve(result)
            }
            const connectionTimeout = setTimeout(() => {
                finishCandidate(false)
                console.warn(`[HTTP] Authentication protocol v2 readiness timeout at port ${port}`)
                ws.close()
            }, 5000)
            const markReady = () => {
                if (!this.isGenerationActive(generation) || this.connections.get(port) !== conn) {
                    return
                }
                conn.ready = true
                this.resetHeartbeat(port)
                this.statusHandler?.('connected', this.getConnectedPorts().length)
                finishCandidate(true)
            }
            const hello = async () => {
                const backgroundBundleHash = await getBackgroundBundleHash()
                if (!this.isGenerationActive(generation) || this.connections.get(port) !== conn) {
                    return
                }
                await this.sendMessage(conn, {
                    type: 'hello',
                    version: chrome.runtime.getManifest().version,
                    ...(backgroundBundleHash ? { backgroundBundleHash } : {}),
                })
            }
            ws.onopen = () => {
                if (!this.isGenerationActive(generation) || resolved) {
                    finishCandidate(false)
                    ws.close()
                    return
                }
                this.connections.set(port, conn)
                if (!auth) {
                    markReady()
                    void hello().catch((error) => {
                        console.warn('[HTTP] Hello failed:', error)
                        ws.close()
                    })
                }
            }
            ws.onmessage = (event) => {
                conn.receiveChain = conn.receiveChain
                    .then(async () => {
                        if (!this.isGenerationActive(generation) || this.connections.get(port) !== conn) {
                            return
                        }
                        const payload = await this.receiveMessage(conn, event.data)
                        if (!this.isGenerationActive(generation) || this.connections.get(port) !== conn) {
                            return
                        }
                        if (auth && !conn.ready) {
                            if (JSON.parse(payload).type !== 'ready') {
                                throw new Error('Authenticated ready required')
                            }
                            await hello()
                            markReady()
                            return
                        }
                        this.handleMessage(payload, port, conn)
                    })
                    .catch((error) => {
                        console.warn(`[HTTP] Authentication protocol v2 rejected at port ${port}:`, error)
                        finishCandidate(false)
                        ws.close(1008, 'Authentication protocol v2 required')
                    })
            }
            ws.onclose = () => {
                this.pendingSockets.delete(ws)
                finishCandidate(false)
                this.removeConnection(port, ws)
            }
            ws.onerror = () => {
                finishCandidate(false)
                ws.close()
                this.removeConnection(port, ws)
            }
        })
    }

    /**
     * 清理单个连接及其资源
     */
    private removeConnection(port: number, expectedSocket?: WebSocket): void {
        const conn = this.connections.get(port)
        if (!conn || (expectedSocket !== undefined && conn.ws !== expectedSocket)) {
            return
        }

        this.stopHeartbeat(port)
        for (const controller of conn.requests.values()) {
            controller.abort()
        }
        conn.requests.clear()
        this.connections.delete(port)
        this.verifiedAuth.delete(port)
        const instanceId = conn.instanceId
        this.verifiedInstanceIds.delete(port)
        if (instanceId) {
            this.connectionClosedHandler?.(instanceId)
        }

        if (this.connections.size > 0) {
            this.statusHandler?.('connected', this.connections.size)
        } else {
            this.statusHandler?.('disconnected', 0)
        }
        if (this.shouldReconnect) {
            this.scheduleReconnect()
        }
    }

    /**
     * 扫描端口范围，返回所有健康的 Server 端口
     *
     * 完整扫描整段范围，保证多 CC 并存时新启动的 server 能被发现
     */
    private async discoverServers(generation: number): Promise<number[]> {
        const checks = []
        for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
            checks.push(this.checkPort(port, generation).then((result) => ({ port, result })))
        }
        const results = await Promise.all(checks)
        if (!this.isGenerationActive(generation)) {
            return []
        }
        const healthyPorts = results.filter(({ result }) => result.healthy).map(({ port }) => port)
        const selectedFailures = results.filter(({ result }) => result.failureKind)

        const failureSummary = selectedFailures
            .slice(0, 10)
            .map(({ port, result }) => `${port} (${result.failureKind}: ${result.reason})`)
            .join(', ')
        if (failureSummary && failureSummary !== this.lastServerFailureSummary) {
            const omittedSuffix = selectedFailures.length > 10 ? ', ...' : ''
            console.warn(
                `[HTTP] ${selectedFailures.length} MCP Server candidate(s) rejected after health identification: ` +
                    failureSummary +
                    omittedSuffix
            )
        }
        this.lastServerFailureSummary = failureSummary

        healthyPorts.sort((a, b) => a - b)
        const discoverySummary = healthyPorts.join(',')
        if (discoverySummary !== this.lastDiscoverySummary) {
            if (healthyPorts.length > 0) {
                console.log(`[HTTP] Found ${healthyPorts.length} MCP Server(s) at ports: ${healthyPorts.join(', ')}`)
            } else {
                console.debug('[HTTP] No MCP Server found in port range')
            }
            this.lastDiscoverySummary = discoverySummary
        }

        return healthyPorts
    }

    private async checkPort(port: number, generation: number): Promise<PortCheckResult> {
        const controller = new AbortController()
        this.pendingHealthChecks.add(controller)
        const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT)
        try {
            const token = await this.getPairingToken()
            if (!this.isGenerationActive(generation)) {
                return { healthy: false }
            }
            const clientNonce = randomHex()
            const response = await fetch(`http://127.0.0.1:${port}/api/health?clientNonce=${clientNonce}`, {
                signal: controller.signal,
            })
            if (!this.isGenerationActive(generation)) {
                return { healthy: false }
            }

            if (!response.ok) {
                return { healthy: false }
            }

            const health = (await response.json().catch(() => null)) as HealthResponse | null
            if (!this.isGenerationActive(generation)) {
                return { healthy: false }
            }
            if (!health || typeof health.authRequired !== 'boolean') {
                return { healthy: false }
            }
            if (typeof health.instanceId === 'string' && /^[0-9a-f]{32}$/.test(health.instanceId)) {
                this.verifiedInstanceIds.set(port, health.instanceId)
            } else {
                this.verifiedInstanceIds.delete(port)
            }
            if (health.authRequired) {
                if (!token) {
                    return { healthy: false, failureKind: 'authentication', reason: 'pairing token missing' }
                }
                if (
                    health.auth?.protocol !== 2 ||
                    health.port !== port ||
                    !health.instanceId ||
                    !/^[0-9a-f]{32}$/.test(health.instanceId) ||
                    health.auth.clientNonce !== clientNonce ||
                    !health.auth.serverNonce ||
                    !health.auth.serverProof
                ) {
                    return {
                        healthy: false,
                        failureKind: 'protocol',
                        reason: 'authentication protocol v2 required or endpoint mismatch',
                    }
                }
                const expected = await hmacHex(
                    token,
                    JSON.stringify([
                        'mcp-chrome',
                        2,
                        'server-proof',
                        clientNonce,
                        health.auth.serverNonce,
                        health.instanceId,
                        port,
                    ])
                )
                if (expected !== health.auth.serverProof) {
                    return { healthy: false, failureKind: 'authentication', reason: 'server proof mismatch' }
                }
                const clientProof = await hmacHex(
                    token,
                    JSON.stringify([
                        'mcp-chrome',
                        2,
                        'client-proof',
                        clientNonce,
                        health.auth.serverNonce,
                        health.instanceId,
                        port,
                    ])
                )
                const session = JSON.stringify([clientNonce, health.auth.serverNonce, health.instanceId, port])
                const sendKey = await hmacHex(token, JSON.stringify(['mcp-chrome', 2, 'key', 'extension', session]))
                const receiveKey = await hmacHex(token, JSON.stringify(['mcp-chrome', 2, 'key', 'server', session]))
                if (!this.isGenerationActive(generation)) {
                    return { healthy: false }
                }
                this.verifiedAuth.set(port, {
                    clientNonce,
                    serverNonce: health.auth.serverNonce,
                    clientProof,
                    session,
                    sendKey,
                    receiveKey,
                })
                return { healthy: true }
            }

            if (token) {
                return {
                    healthy: false,
                    failureKind: 'authentication',
                    reason: 'client token configured for no-token server',
                }
            }
            if (!(await this.getAllowInsecureNoToken())) {
                return { healthy: false, failureKind: 'authentication', reason: 'local no-token policy disabled' }
            }
            if (!this.isGenerationActive(generation)) {
                return { healthy: false }
            }
            this.verifiedAuth.delete(port)
            return health.status === 'ok'
                ? { healthy: true }
                : { healthy: false, failureKind: 'protocol', reason: 'health status is not ok' }
        } catch {
            return { healthy: false }
        } finally {
            clearTimeout(timeoutId)
            this.pendingHealthChecks.delete(controller)
        }
    }

    private isGenerationActive(generation: number): boolean {
        return generation === this.generation && this.shouldReconnect
    }

    private handleMessage(data: string, port: number, source = this.connections.get(port)): void {
        try {
            const message = JSON.parse(data)
            const conn = source
            if (!conn || this.connections.get(port) !== conn) {
                return
            }

            // 心跳：收到 ping 说明连接存活，重置心跳计时器
            if (message.type === 'ping') {
                void this.sendMessage(conn, { type: 'pong' }).catch((error) => {
                    console.warn('[HTTP] Pong failed:', error)
                    conn.ws.close()
                })
                this.resetHeartbeat(port)
                return
            }

            if (message.type === 'cancel' && typeof message.id === 'string') {
                conn.requests.get(message.id)?.abort()
                return
            }

            // 命令请求
            if (message.action && message.id && this.messageHandler) {
                if (conn.requests.has(message.id)) {
                    // noinspection ExceptionCaughtLocallyJS -- Report failure
                    throw new Error('Duplicate request id')
                }
                const controller = new AbortController()
                conn.requests.set(message.id, controller)
                const reply: Reply = (success, data, error) => {
                    if (this.connections.get(port) !== conn || conn.ws.readyState !== WebSocket.OPEN) {
                        return
                    }
                    void this.sendMessage(conn, { id: message.id, success, data, error }).catch((error) => {
                        console.warn('[HTTP] Response delivery failed:', error)
                        conn.ws.close()
                    })
                }
                void Promise.resolve()
                    .then(() => this.messageHandler?.(message, port, controller.signal, reply))
                    .catch((error) => reply(false, undefined, String(error)))
                    .finally(() => conn.requests.delete(message.id))
            }
        } catch (error) {
            console.error(`[HTTP] Error parsing message from port ${port}:`, error)
        }
    }

    private sendMessage(conn: ServerConnection, message: unknown): Promise<void> {
        const payload = JSON.stringify(message)
        const operation = conn.sendChain.then(async () => {
            if (conn.ws.readyState !== WebSocket.OPEN) {
                throw new Error('Connection closed')
            }
            if (!conn.auth) {
                conn.ws.send(payload)
                return
            }
            const seq = ++conn.sent
            const mac = await hmacHex(
                conn.auth.sendKey,
                JSON.stringify([2, conn.auth.session, 'extension', seq, payload])
            )
            if (conn.ws.readyState !== WebSocket.OPEN) {
                throw new Error('Connection closed')
            }
            conn.ws.send(JSON.stringify({ v: 2, session: conn.auth.session, seq, payload, mac }))
        })
        conn.sendChain = operation
        return operation
    }

    private async receiveMessage(conn: ServerConnection, data: string): Promise<string> {
        if (!conn.auth) {
            return data
        }
        const envelope = JSON.parse(data) as { v: number; session: string; seq: number; payload: string; mac: string }
        if (
            envelope.v !== 2 ||
            envelope.session !== conn.auth.session ||
            !Number.isSafeInteger(envelope.seq) ||
            envelope.seq !== conn.received + 1 ||
            typeof envelope.payload !== 'string' ||
            typeof envelope.mac !== 'string'
        ) {
            throw new Error('Invalid authenticated message or sequence')
        }
        const expected = await hmacHex(
            conn.auth.receiveKey,
            JSON.stringify([2, conn.auth.session, 'server', envelope.seq, envelope.payload])
        )
        if (expected !== envelope.mac) {
            throw new Error('Message authentication failed')
        }
        conn.received = envelope.seq
        return envelope.payload
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

        console.debug(`[HTTP] Scheduling reconnect in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`)

        const generation = this.generation
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null
            if (this.isGenerationActive(generation)) {
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
