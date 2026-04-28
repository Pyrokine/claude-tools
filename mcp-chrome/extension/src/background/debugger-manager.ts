import type { LogManager } from './log-manager.js'

export class DebuggerBlockedError extends Error {
    constructor(tabId: number) {
        super(
            `Debugger blocked on tab ${tabId} (another debugger attached). ` +
                'Close other DevTools extensions (React DevTools, etc.) to enable full functionality.'
        )
        this.name = 'DebuggerBlockedError'
    }
}

export class DebuggerManager {
    private attachedTabs = new Set<number>()
    /** debugger 被其他扩展占用的 tab（如 React DevTools） */
    private debuggerBlocked = new Set<number>()
    /** debugger 占用时的重试节流：tabId -> 下一次允许 attach 的时间戳（ms） */
    private debuggerBlockedRetryAfter = new Map<number, number>()
    /** 按 tabId 缓存的执行上下文（由 Runtime.executionContextCreated 事件填充） */
    private executionContexts = new Map<number, Array<{ id: number; frameId: string; isDefault: boolean }>>()
    private pendingAttach = new Map<number, Promise<void>>()
    /** cleanup epoch per tab：每次 cleanupTab 自增,attach Promise 完成时比对,避免与并发 cleanup 之间的状态漂移 */
    private cleanupEpoch = new Map<number, number>()
    /** setupListeners 幂等标志,防止热重载多实例叠加注册 */
    private listenersBound = false
    private boundOnDetach: ((source: chrome.debugger.Debuggee, reason: string) => void) | null = null
    private boundOnEvent: ((source: chrome.debugger.Debuggee, method: string, params?: unknown) => void) | null = null

    constructor(private logManager: LogManager) {}

    /** tabId 是否当前已 attach（外部只读） */
    isAttached(tabId: number): boolean {
        return this.attachedTabs.has(tabId)
    }

    /** debugger 是否被其他扩展占用（外部只读） */
    isBlocked(tabId: number): boolean {
        return this.debuggerBlocked.has(tabId)
    }

    /** 取指定 tab 的执行上下文列表（外部只读，缺省返回空数组） */
    getExecutionContexts(tabId: number): Array<{ id: number; frameId: string; isDefault: boolean }> {
        return this.executionContexts.get(tabId) ?? []
    }

    setupListeners(): void {
        if (this.listenersBound) {
            return
        }
        this.listenersBound = true

        // 监听 debugger 断开（仅处理本实例 attach 过的 tab,避免与其他扩展冲突）
        this.boundOnDetach = (source, reason) => {
            if (!source.tabId || !this.attachedTabs.has(source.tabId)) {
                return
            }
            this.cleanupTab(source.tabId)
            this.logManager.cleanupTab(source.tabId)
            console.log(`[MCP] Debugger detached from tab ${source.tabId}: ${reason}`)
        }
        chrome.debugger.onDetach.addListener(this.boundOnDetach)

        // 监听 debugger 事件（仅本实例 attach 过的 tab）
        this.boundOnEvent = (source, method, params) => {
            if (!source.tabId || !this.attachedTabs.has(source.tabId)) {
                return
            }
            const tabId = source.tabId

            // 日志相关事件委托给 LogManager
            this.logManager.handleEvent(tabId, method, params)

            // 捕获执行上下文创建（用于 iframe 内 precise evaluate）
            if (method === 'Runtime.executionContextCreated') {
                const p = params as { context: { id: number; auxData?: { frameId?: string; isDefault?: boolean } } }
                const ctx = p.context
                if (ctx.auxData?.frameId) {
                    const contexts = this.executionContexts.get(tabId) || []
                    contexts.push({
                        id: ctx.id,
                        frameId: ctx.auxData.frameId,
                        isDefault: ctx.auxData.isDefault ?? false,
                    })
                    this.executionContexts.set(tabId, contexts)
                }
            }

            // 子 frame 导航会销毁旧上下文：及时移除，避免命中已失效的 contextId
            if (method === 'Runtime.executionContextDestroyed') {
                const p = params as { executionContextId: number }
                const contexts = this.executionContexts.get(tabId)
                if (contexts) {
                    const next = contexts.filter((c) => c.id !== p.executionContextId)
                    if (next.length > 0) {
                        this.executionContexts.set(tabId, next)
                    } else {
                        this.executionContexts.delete(tabId)
                    }
                }
            }

            // 上下文清除时重置
            if (method === 'Runtime.executionContextsCleared') {
                this.executionContexts.delete(tabId)
            }
        }
        chrome.debugger.onEvent.addListener(this.boundOnEvent)
    }

    /** 拆除监听器（用于热重载 / 多实例场景） */
    dispose(): void {
        if (this.boundOnDetach) {
            chrome.debugger.onDetach.removeListener(this.boundOnDetach)
            this.boundOnDetach = null
        }
        if (this.boundOnEvent) {
            chrome.debugger.onEvent.removeListener(this.boundOnEvent)
            this.boundOnEvent = null
        }
        this.listenersBound = false
    }

    async ensureAttached(tabId: number): Promise<void> {
        if (this.attachedTabs.has(tabId)) {
            return
        }

        // 已有正在进行的 attach，等待它完成
        const pending = this.pendingAttach.get(tabId)
        if (pending) {
            await pending
            // 重新检查：pending 完成后 attach 可能已被 detach
            if (!this.attachedTabs.has(tabId)) {
                // fall through，重新尝试 attach
            } else {
                return
            }
        }

        if (this.debuggerBlocked.has(tabId)) {
            const retryAfter = this.debuggerBlockedRetryAfter.get(tabId) ?? 0
            if (Date.now() < retryAfter) {
                throw new DebuggerBlockedError(tabId)
            }
        }

        // 错误转换嵌入到 promise chain 中，确保所有 awaiter（包括并发场景下走 line 104
        // `await pending` 路径的第二个 caller）拿到的都是 DebuggerBlockedError 类型
        const myEpoch = this.cleanupEpoch.get(tabId) ?? 0
        const attachPromise = chrome.debugger.attach({ tabId }, '1.3').then(
            () => {
                // attach 成功但期间发生了 cleanup,丢弃成功结果（避免 onDetach 漏触发后 attachedTabs 漂移）
                if ((this.cleanupEpoch.get(tabId) ?? 0) !== myEpoch) {
                    return
                }
                this.attachedTabs.add(tabId)
                this.debuggerBlocked.delete(tabId)
                this.debuggerBlockedRetryAfter.delete(tabId)
            },
            (err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err)
                if (msg.includes('Another debugger') || msg.includes('already attached')) {
                    this.debuggerBlocked.add(tabId)
                    this.debuggerBlockedRetryAfter.set(tabId, Date.now() + 2000)
                    throw new DebuggerBlockedError(tabId)
                }
                throw err
            }
        )

        this.pendingAttach.set(tabId, attachPromise)
        try {
            await attachPromise
        } finally {
            this.pendingAttach.delete(tabId)
        }
    }

    cleanupTab(tabId: number): void {
        // 自增 epoch,使任何还在 in-flight 的 attach Promise 在完成时识别出"自己已过期"
        this.cleanupEpoch.set(tabId, (this.cleanupEpoch.get(tabId) ?? 0) + 1)
        this.attachedTabs.delete(tabId)
        this.debuggerBlocked.delete(tabId)
        this.debuggerBlockedRetryAfter.delete(tabId)
        this.executionContexts.delete(tabId)
        this.pendingAttach.delete(tabId)
    }
}
