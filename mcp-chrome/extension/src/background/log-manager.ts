import type { ConsoleMessage, NetworkRequest } from '../types'

type PendingRequest = {
    url: string
    method: string
    type: string
    timestamp: number
    _monotonic: number
    /** wallclock 添加时间,用于超龄回收 */
    _addedAt: number
}

const PENDING_TTL_MS = 60_000
const PENDING_MAX_PER_TAB = 500
const PENDING_SWEEP_INTERVAL_MS = 30_000

export class LogManager {
    private consoleMessages = new Map<number, ConsoleMessage[]>()
    private networkRequests = new Map<number, NetworkRequest[]>()
    private pendingRequests = new Map<number, Map<string, PendingRequest>>()
    private sweepTimer: ReturnType<typeof setInterval> | null = null

    constructor() {
        this.startSweep()
    }

    /** 用于 service worker 关闭等场景手动停止 sweeper */
    stopSweep(): void {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer)
            this.sweepTimer = null
        }
    }

    /** 是否已为 tab 初始化 console 缓冲（外部判定是否需要 init） */
    hasConsole(tabId: number): boolean {
        return this.consoleMessages.has(tabId)
    }

    /** 取 console 消息列表（外部只读，缺省空数组） */
    getConsole(tabId: number): ConsoleMessage[] {
        return this.consoleMessages.get(tabId) ?? []
    }

    // ---- 外部只读 / 受控写入访问器 ----

    /** 替换 console 消息列表（清理或覆盖场景） */
    setConsole(tabId: number, messages: ConsoleMessage[]): void {
        this.consoleMessages.set(tabId, messages)
    }

    /** 是否已为 tab 初始化 network 缓冲 */
    hasNetwork(tabId: number): boolean {
        return this.networkRequests.has(tabId)
    }

    /** 取 network 请求列表（外部只读，缺省空数组） */
    getNetwork(tabId: number): NetworkRequest[] {
        return this.networkRequests.get(tabId) ?? []
    }

    /** 替换 network 请求列表 */
    setNetwork(tabId: number, requests: NetworkRequest[]): void {
        this.networkRequests.set(tabId, requests)
    }

    /** 取 pending 请求 Map（navigation-handler 用于过滤进行中的请求） */
    getPending(tabId: number): Map<string, PendingRequest> | undefined {
        return this.pendingRequests.get(tabId)
    }

    handleEvent(tabId: number, method: string, params: unknown): void {
        if (method === 'Runtime.consoleAPICalled') {
            const p = params as {
                type: string
                args: Array<{ type: string; value?: unknown; description?: string }>
                timestamp: number
                stackTrace?: { callFrames: Array<{ url: string; lineNumber: number }> }
            }
            const message: ConsoleMessage = {
                source: 'console-api',
                level: p.type,
                text: p.args.map((arg) => arg.value ?? arg.description ?? '').join(' '),
                timestamp: Math.round(p.timestamp),
            }
            if (p.stackTrace?.callFrames?.[0]) {
                message.url = p.stackTrace.callFrames[0].url
                message.lineNumber = p.stackTrace.callFrames[0].lineNumber
            }
            const messages = this.consoleMessages.get(tabId) || []
            messages.push(message)
            // 批量删除：用 10% 缓冲 + splice，避免每次 shift 触发 O(N) 拷贝
            if (messages.length > 1100) {
                messages.splice(0, messages.length - 1000)
            }
            this.consoleMessages.set(tabId, messages)
        }

        if (method === 'Runtime.exceptionThrown') {
            const p = params as {
                timestamp: number
                exceptionDetails: {
                    text: string
                    exception?: { description?: string }
                    url?: string
                    lineNumber?: number
                }
            }
            const message: ConsoleMessage = {
                source: 'javascript',
                level: 'error',
                text: p.exceptionDetails.exception?.description || p.exceptionDetails.text,
                timestamp: Math.round(p.timestamp),
                url: p.exceptionDetails.url,
                lineNumber: p.exceptionDetails.lineNumber,
            }
            const messages = this.consoleMessages.get(tabId) || []
            messages.push(message)
            if (messages.length > 1100) {
                messages.splice(0, messages.length - 1000)
            }
            this.consoleMessages.set(tabId, messages)
        }

        if (method === 'Network.requestWillBeSent') {
            const p = params as {
                requestId: string
                request: { url: string; method: string }
                type: string
                timestamp: number
                wallTime: number
            }
            let tabPending = this.pendingRequests.get(tabId)
            if (!tabPending) {
                tabPending = new Map()
                this.pendingRequests.set(tabId, tabPending)
            }
            // 容量上限：超过 PENDING_MAX_PER_TAB 时删除最旧（按 _addedAt 升序）
            if (tabPending.size >= PENDING_MAX_PER_TAB) {
                let oldestKey: string | null = null
                let oldestAt = Infinity
                for (const [k, v] of tabPending) {
                    if (v._addedAt < oldestAt) {
                        oldestAt = v._addedAt
                        oldestKey = k
                    }
                }
                if (oldestKey !== null) {
                    tabPending.delete(oldestKey)
                }
            }
            tabPending.set(p.requestId, {
                url: p.request.url,
                method: p.request.method,
                type: p.type,
                timestamp: Math.round(p.wallTime * 1000),
                _monotonic: p.timestamp,
                _addedAt: Date.now(),
            })
        }

        if (method === 'Network.responseReceived') {
            const p = params as {
                requestId: string
                response: { status: number }
                timestamp: number
            }
            const tabPending = this.pendingRequests.get(tabId)
            const pending = tabPending?.get(p.requestId)
            if (pending) {
                const { _monotonic, _addedAt: _, ...requestData } = pending
                const requests = this.networkRequests.get(tabId) || []
                requests.push({
                    ...requestData,
                    status: p.response.status,
                    duration: Math.round((p.timestamp - _monotonic) * 1000),
                })
                if (requests.length > 1100) {
                    requests.splice(0, requests.length - 1000)
                }
                this.networkRequests.set(tabId, requests)
                tabPending!.delete(p.requestId)
            }
        }

        if (method === 'Network.loadingFailed') {
            const p = params as { requestId: string }
            this.pendingRequests.get(tabId)?.delete(p.requestId)
        }
    }

    cleanupTab(tabId: number): void {
        this.consoleMessages.delete(tabId)
        this.networkRequests.delete(tabId)
        this.pendingRequests.delete(tabId)
    }

    private startSweep(): void {
        if (this.sweepTimer) {
            return
        }
        this.sweepTimer = setInterval(() => this.sweepPending(), PENDING_SWEEP_INTERVAL_MS)
        // 在 Service Worker 中 setInterval 不会自动 unref,Worker 周期性活跃由 chrome.alarms 维持
    }

    private sweepPending(): void {
        const now = Date.now()
        for (const [tabId, tabPending] of this.pendingRequests) {
            for (const [requestId, req] of tabPending) {
                if (now - req._addedAt > PENDING_TTL_MS) {
                    tabPending.delete(requestId)
                    console.warn(
                        `[MCP] Pending request ${requestId} (${req.url}) ttl exceeded ${PENDING_TTL_MS}ms, cleaning`
                    )
                }
            }
            if (tabPending.size === 0) {
                this.pendingRequests.delete(tabId)
            }
        }
    }
}
