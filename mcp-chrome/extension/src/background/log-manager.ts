import type { ConsoleMessage, NetworkRequest } from '../types'

type PendingRequest = {
    url: string
    method: string
    type: string
    timestamp: number
    frameId?: string
    status?: number
    challenge?: boolean
    _monotonic: number
    /** wallclock 添加时间,用于超龄诊断 */
    _addedAt: number
    _ttlWarned?: boolean
}

const PENDING_TTL_MS = 60_000
const PENDING_MAX_PER_TAB = 500
const PENDING_SWEEP_INTERVAL_MS = 30_000

function isCloudflareChallenge(headers: Record<string, unknown> | undefined): boolean {
    if (!headers) {
        return false
    }

    return Object.entries(headers).some(
        ([name, value]) => name.toLowerCase() === 'cf-mitigated' && String(value).toLowerCase() === 'challenge'
    )
}

export class LogManager {
    private consoleMessages = new Map<number, ConsoleMessage[]>()
    private networkRequests = new Map<number, NetworkRequest[]>()
    private consoleSequences = new Map<number, number>()
    private networkSequences = new Map<number, number>()
    private challengeRequired = new Map<number, boolean>()
    private mainFrameIds = new Map<number, string>()
    private pendingRequests = new Map<number, Map<string, PendingRequest>>()
    private pendingUncertain = new Set<number>()
    private networkObserved = new Set<number>()
    private sweepTimer: ReturnType<typeof setInterval> | null = null

    constructor() {
        this.startSweep()
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
        this.assignConsoleSequences(tabId, messages)
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

    isChallengeRequired(tabId: number): boolean {
        return this.challengeRequired.get(tabId) === true
    }

    setMainFrameId(tabId: number, frameId: string): void {
        this.mainFrameIds.set(tabId, frameId)
    }

    /** 替换 network 请求列表 */
    setNetwork(tabId: number, requests: NetworkRequest[]): void {
        this.assignNetworkSequences(tabId, requests)
        this.networkRequests.set(tabId, requests)
    }

    /** 取 pending 请求 Map（navigation-handler 用于过滤进行中的请求） */
    getPending(tabId: number): Map<string, PendingRequest> | undefined {
        return this.pendingRequests.get(tabId)
    }

    /** pending 跟踪曾丢失，networkidle 不能据此判定为空闲 */
    isPendingUncertain(tabId: number): boolean {
        return this.pendingUncertain.has(tabId)
    }

    isNetworkObserved(tabId: number): boolean {
        return this.networkObserved.has(tabId)
    }

    markNetworkObserved(tabId: number): void {
        this.networkObserved.add(tabId)
    }

    /** debugger 断开后请求结束事件不可恢复，保持不确定状态直到新主文档或 tab cleanup */
    handleDebuggerDetach(tabId: number): void {
        this.networkObserved.delete(tabId)
        this.pendingRequests.delete(tabId)
        this.pendingUncertain.add(tabId)
        this.mainFrameIds.delete(tabId)
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
            this.assignConsoleSequences(tabId, [message])
            messages.push(message)
            if (messages.length > 1100) {
                messages.splice(0, messages.length - 1000)
            }
            this.consoleMessages.set(tabId, messages)
        }

        if (method === 'Network.requestWillBeSent') {
            this.networkObserved.add(tabId)
            const p = params as {
                requestId: string
                request: { url: string; method: string }
                type: string
                timestamp: number
                wallTime: number
                frameId?: string
            }
            let tabPending = this.pendingRequests.get(tabId)
            const beginsMainDocument =
                p.type.toLowerCase() === 'document' &&
                p.frameId !== undefined &&
                p.frameId === this.mainFrameIds.get(tabId) &&
                !tabPending?.has(p.requestId)
            if (beginsMainDocument) {
                tabPending = new Map()
                this.pendingRequests.set(tabId, tabPending)
                this.pendingUncertain.delete(tabId)
            } else if (!tabPending) {
                tabPending = new Map()
                this.pendingRequests.set(tabId, tabPending)
            }
            // 保留有界的请求详情；一旦丢失进行中请求，networkidle 必须保持不确定状态
            if (!tabPending.has(p.requestId) && tabPending.size >= PENDING_MAX_PER_TAB) {
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
                    const wasUncertain = this.pendingUncertain.has(tabId)
                    this.pendingUncertain.add(tabId)
                    if (!wasUncertain) {
                        console.warn(
                            `[MCP] Pending request tracking exceeded ${PENDING_MAX_PER_TAB} entries for tab ${tabId}; networkidle will remain unavailable until tab cleanup`
                        )
                    }
                }
            }
            tabPending.set(p.requestId, {
                url: p.request.url,
                method: p.request.method,
                type: p.type,
                timestamp: Math.round(p.wallTime * 1000),
                frameId: p.frameId,
                _monotonic: p.timestamp,
                _addedAt: Date.now(),
            })
        }

        if (method === 'Page.frameNavigated') {
            const p = params as { frame: { id: string; parentId?: string } }
            if (!p.frame.parentId) {
                this.mainFrameIds.set(tabId, p.frame.id)
            }
        }

        if (method === 'Network.responseReceived') {
            const p = params as {
                requestId: string
                response: { status: number; headers?: Record<string, unknown> }
            }
            const pending = this.pendingRequests.get(tabId)?.get(p.requestId)
            if (pending) {
                pending.status = p.response.status
                pending.challenge = isCloudflareChallenge(p.response.headers)
                if (
                    pending.type.toLowerCase() === 'document' &&
                    pending.frameId !== undefined &&
                    pending.frameId === this.mainFrameIds.get(tabId)
                ) {
                    // 只有主 frame 的新文档响应可以解除已知 Challenge
                    this.challengeRequired.set(tabId, pending.challenge)
                }
            }
        }

        if (method === 'Network.loadingFinished') {
            const p = params as { requestId: string; timestamp: number }
            this.finalizeRequest(tabId, p.requestId, p.timestamp)
        }

        if (method === 'Network.loadingFailed') {
            const p = params as { requestId: string; timestamp: number; errorText?: string }
            this.finalizeRequest(tabId, p.requestId, p.timestamp, p.errorText)
        }
    }

    cleanupTab(tabId: number): void {
        this.consoleMessages.delete(tabId)
        this.networkRequests.delete(tabId)
        this.consoleSequences.delete(tabId)
        this.networkSequences.delete(tabId)
        this.challengeRequired.delete(tabId)
        this.mainFrameIds.delete(tabId)
        this.pendingRequests.delete(tabId)
        this.pendingUncertain.delete(tabId)
        this.networkObserved.delete(tabId)
    }

    private finalizeRequest(tabId: number, requestId: string, timestamp: number, errorText?: string): void {
        const tabPending = this.pendingRequests.get(tabId)
        const pending = tabPending?.get(requestId)
        if (!pending) {
            return
        }

        const requests = this.networkRequests.get(tabId) || []
        requests.push({
            url: pending.url,
            method: pending.method,
            type: pending.type,
            timestamp: pending.timestamp,
            status: pending.status,
            challenge: pending.challenge,
            errorText,
            duration: Math.round((timestamp - pending._monotonic) * 1000),
        })
        this.assignNetworkSequences(tabId, requests.slice(-1))
        if (requests.length > 1100) {
            requests.splice(0, requests.length - 1000)
        }
        this.networkRequests.set(tabId, requests)
        tabPending!.delete(requestId)
        if (tabPending!.size === 0) {
            this.pendingRequests.delete(tabId)
        }
    }

    private assignConsoleSequences(tabId: number, messages: ConsoleMessage[]): void {
        let sequence = this.consoleSequences.get(tabId) ?? 0
        for (const message of messages) {
            if (message.sequence === undefined) {
                message.sequence = ++sequence
            } else {
                sequence = Math.max(sequence, message.sequence)
            }
        }
        this.consoleSequences.set(tabId, sequence)
    }

    private assignNetworkSequences(tabId: number, requests: NetworkRequest[]): void {
        let sequence = this.networkSequences.get(tabId) ?? 0
        for (const request of requests) {
            if (request.sequence === undefined) {
                request.sequence = ++sequence
            } else {
                sequence = Math.max(sequence, request.sequence)
            }
        }
        this.networkSequences.set(tabId, sequence)
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
        for (const tabPending of this.pendingRequests.values()) {
            for (const [requestId, req] of tabPending) {
                if (now - req._addedAt > PENDING_TTL_MS && !req._ttlWarned) {
                    req._ttlWarned = true
                    console.warn(
                        `[MCP] Pending request ${requestId} (${req.url}) has remained active for more than ${PENDING_TTL_MS}ms`
                    )
                }
            }
        }
    }
}
