import { ExpectedOperationError } from '../types/expected-errors.js'
import type { LogManager } from './log-manager.js'
import { assertActionActive, type ActionContext } from './action-utils.js'

interface KeyboardFocusLease {
    id: string
    owner: string
    epoch: number
    frameId: number
    documentId: string
    changed: boolean
    state: 'active' | 'releasing' | 'released'
    keys: Map<string, Record<string, unknown>>
    modifiers: number
    timer?: ReturnType<typeof setTimeout>
    cleanup?: Promise<{ restored: boolean; errors: string[] }>
}

function keyboardFocusError(code: string, message: string): ExpectedOperationError {
    return new ExpectedOperationError(
        JSON.stringify({
            error: { code, message, context: { actionExecuted: false, actionStatus: 'not_started', retryable: false } },
        }),
        false
    )
}

export class DebuggerBlockedError extends ExpectedOperationError {
    readonly code = 'DEBUGGER_BLOCKED'

    readonly suggestion =
        '当前 tab 的 chrome.debugger 被其他调试器占用。请关闭 DevTools 或其他调试扩展，换用未被占用的 managed tab，或在不需要 debugger 的场景改用 mode="stealth"'

    readonly context: { tabId: number }

    constructor(tabId: number) {
        super(
            `Debugger blocked on tab ${tabId} (another debugger attached). ` +
                'Close other DevTools extensions (React DevTools, etc.) to enable full functionality.'
        )
        this.name = 'DebuggerBlockedError'
        this.context = { tabId }
    }

    // noinspection JSUnusedGlobalSymbols — background/index.ts 通过结构化 toJSON 调用
    toJSON(): object {
        return {
            error: {
                code: this.code,
                message: this.message,
                suggestion: this.suggestion,
                context: this.context,
            },
        }
    }
}

export class DebuggerManager {
    beforeDetach?: (tabId: number, reason: string, owner?: string | null) => Promise<Record<string, unknown>>
    onCleanup?: (tabId: number) => void
    private attachedTabs = new Set<number>()
    /** debugger 被其他扩展占用的 tab（如 React DevTools） */
    private debuggerBlocked = new Set<number>()
    /** debugger 占用时的重试节流：tabId -> 下一次允许 attach 的时间戳（ms） */
    private debuggerBlockedRetryAfter = new Map<number, number>()
    /** 按 tabId 缓存的执行上下文（由 Runtime.executionContextCreated 事件填充） */
    private executionContexts = new Map<
        number,
        Array<{ id: number; frameId: string; isDefault: boolean; sessionId?: string }>
    >()

    private pendingAttach = new Map<number, Promise<void>>()
    private frameSessions = new Map<number, Map<string, string>>()
    /** cleanup epoch per tab：每次 cleanupTab 自增,attach Promise 完成时比对,避免与并发 cleanup 之间的状态漂移 */
    private cleanupEpoch = new Map<number, number>()
    /** setupListeners 幂等标志,防止热重载多实例叠加注册 */
    private listenersBound = false
    private eventConsumers = new Set<(tabId: number, method: string, params: unknown, sessionId?: string) => void>()

    private focusStates = new Map<number, boolean>()
    private focusVersions = new Map<number, number>()
    private keyboardFocusLeases = new Map<number, KeyboardFocusLease>()

    constructor(private logManager: LogManager) {}

    async setFocusEmulation(tabId: number, enabled: boolean, leaseId?: string): Promise<unknown> {
        const lease = this.keyboardFocusLeases.get(tabId)
        if (leaseId && (!lease || lease.id !== leaseId || lease.epoch !== (this.cleanupEpoch.get(tabId) ?? 0))) {
            throw keyboardFocusError('KEYBOARD_FOCUS_EXPIRED', '原焦点作用域已失效，未更改新会话')
        }
        if (lease && lease.state !== 'released' && lease.id !== leaseId) {
            throw keyboardFocusError('KEYBOARD_FOCUS_BUSY', '该页正在执行其他请求的原生按键，未更改焦点模拟')
        }
        const epoch = this.cleanupEpoch.get(tabId) ?? 0
        const version = (this.focusVersions.get(tabId) ?? 0) + 1
        this.focusVersions.set(tabId, version)
        this.focusStates.delete(tabId)
        const result = await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled })
        if (
            this.attachedTabs.has(tabId) &&
            (this.cleanupEpoch.get(tabId) ?? 0) === epoch &&
            this.focusVersions.get(tabId) === version
        ) {
            this.focusStates.set(tabId, enabled)
        }
        return result
    }

    async acquireKeyboardFocus(
        tabId: number,
        id: string,
        frameId: number,
        documentId: string | undefined,
        context: ActionContext
    ): Promise<{ changed: boolean }> {
        const owner = context.serverInstanceId
        if (!owner) {
            throw keyboardFocusError('KEYBOARD_FOCUS_OWNER_REQUIRED', '原生按键准备缺少请求来源')
        }
        await this.ensureAttached(tabId)
        assertActionActive(context)
        const current = this.keyboardFocusLeases.get(tabId)
        if (current && current.state !== 'released') {
            throw keyboardFocusError('KEYBOARD_FOCUS_BUSY', '该页正在执行其他请求的原生按键')
        }
        const frame = await chrome.webNavigation.getFrame({ tabId, frameId })
        if (!frame?.documentId || (documentId && frame.documentId !== documentId)) {
            throw keyboardFocusError('FRAME_IDENTITY_CHANGED', '原生按键目标文档已变化，未派发按键')
        }
        const previous = this.focusStates.get(tabId)
        if (previous === undefined && !(await chrome.tabs.get(tabId)).active) {
            throw keyboardFocusError(
                'KEYBOARD_FOCUS_STATE_UNKNOWN',
                '后台页既有焦点模拟状态未知，未派发原生按键；可显式使用 stealth 或独立 CDP'
            )
        }
        assertActionActive(context)
        const lease: KeyboardFocusLease = {
            id,
            owner,
            frameId,
            documentId: frame.documentId,
            epoch: this.cleanupEpoch.get(tabId) ?? 0,
            changed: previous === false,
            state: 'active',
            keys: new Map(),
            modifiers: 0,
        }
        this.keyboardFocusLeases.set(tabId, lease)
        const expiresAt = context.deadline ?? Date.now() + 30000
        const stop = () => {
            void this.releaseKeyboardFocus(tabId, id, owner, true)
                .then((result) => {
                    if (!result.restored) {
                        console.error('[MCP] Keyboard focus cleanup failed:', result.errors)
                    }
                })
                .catch((error: unknown) => console.error('[MCP] Keyboard focus cleanup failed:', error))
        }
        const expire = () => {
            const remaining = expiresAt - Date.now()
            if (remaining > 0) {
                lease.timer = setTimeout(expire, remaining)
            } else {
                stop()
            }
        }
        lease.timer = setTimeout(expire, Math.max(0, expiresAt - Date.now()))
        context.signal?.addEventListener('abort', stop, { once: true })
        try {
            assertActionActive(context)
            if (lease.changed) {
                await this.setFocusEmulation(tabId, true, id)
            }
            assertActionActive(context)
            await this.assertKeyboardFocus(tabId, id, context)
            return { changed: lease.changed }
        } catch (error) {
            stop()
            throw error
        } finally {
            context.signal?.removeEventListener('abort', stop)
        }
    }

    async assertKeyboardFocus(tabId: number, id: string, context: ActionContext): Promise<void> {
        const lease = this.keyboardFocusLeases.get(tabId)
        if (
            !lease ||
            lease.id !== id ||
            lease.owner !== context.serverInstanceId ||
            lease.state !== 'active' ||
            lease.epoch !== (this.cleanupEpoch.get(tabId) ?? 0)
        ) {
            throw keyboardFocusError('KEYBOARD_FOCUS_EXPIRED', '原生按键请求的焦点作用域已失效，未派发按键')
        }
        const frame = await chrome.webNavigation.getFrame({ tabId, frameId: lease.frameId })
        if (
            this.keyboardFocusLeases.get(tabId) !== lease ||
            lease.state !== 'active' ||
            lease.epoch !== (this.cleanupEpoch.get(tabId) ?? 0)
        ) {
            throw keyboardFocusError('KEYBOARD_FOCUS_EXPIRED', '原生按键准备期间的焦点作用域已失效，未派发按键')
        }
        if (frame?.documentId !== lease.documentId) {
            throw keyboardFocusError('FRAME_IDENTITY_CHANGED', '原生按键目标文档已变化，未派发按键')
        }
        assertActionActive(context)
    }

    trackKeyboardInput(tabId: number, id: string, params: Record<string, unknown>, acknowledged = false): void {
        const lease = this.keyboardFocusLeases.get(tabId)
        if (!lease || lease.id !== id || lease.state !== 'active' || typeof params.key !== 'string') {
            return
        }
        if (!acknowledged && params.type === 'keyDown' && !params.autoRepeat) {
            lease.keys.set(params.key, params)
            lease.modifiers = Number(params.modifiers ?? lease.modifiers)
        } else if (acknowledged && params.type === 'keyUp') {
            lease.keys.delete(params.key)
            lease.modifiers = Number(params.modifiers ?? lease.modifiers)
        }
    }

    async releaseKeyboardFocus(
        tabId: number,
        id: string,
        owner: string | null | undefined,
        releaseKeys: boolean
    ): Promise<{ restored: boolean; errors: string[] }> {
        const lease = this.keyboardFocusLeases.get(tabId)
        if (!lease || lease.id !== id || lease.owner !== owner) {
            return { restored: false, errors: ['原生按键焦点作用域不存在或已由其他请求取得'] }
        }
        if (lease.cleanup) {
            return lease.cleanup
        }
        clearTimeout(lease.timer)
        lease.state = 'releasing'
        lease.cleanup = (async () => {
            const errors: string[] = []
            if (lease.epoch !== (this.cleanupEpoch.get(tabId) ?? 0)) {
                lease.state = 'released'
                return { restored: false, errors: ['原调试会话已失效，未修改新会话'] }
            }
            try {
                if (releaseKeys && lease.keys.size) {
                    const frame = await this.waitForKeyboardCleanup(
                        chrome.webNavigation.getFrame({ tabId, frameId: lease.frameId })
                    )
                    if (
                        frame?.documentId !== lease.documentId ||
                        this.keyboardFocusLeases.get(tabId) !== lease ||
                        lease.epoch !== (this.cleanupEpoch.get(tabId) ?? 0)
                    ) {
                        throw new Error('原文档或调试会话已变化，未向新上下文派发 keyUp')
                    }
                    const modifierBits: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
                    const releases = [...lease.keys.values()].map((key) => {
                        lease.modifiers &= ~(modifierBits[String(key.key)] ?? 0)
                        return chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
                            type: 'keyUp',
                            key: key.key,
                            code: key.code,
                            windowsVirtualKeyCode: key.windowsVirtualKeyCode,
                            modifiers: lease.modifiers,
                        })
                    })
                    await this.waitForKeyboardCleanup(Promise.all(releases))
                }
            } catch (error) {
                errors.push(`按键释放失败：${error instanceof Error ? error.message : String(error)}`)
            }
            try {
                if (lease.changed) {
                    await this.waitForKeyboardCleanup(this.setFocusEmulation(tabId, false, id))
                }
            } catch (error) {
                if (
                    lease.epoch === (this.cleanupEpoch.get(tabId) ?? 0) &&
                    this.keyboardFocusLeases.get(tabId) === lease
                ) {
                    this.focusStates.delete(tabId)
                }
                errors.push(`焦点恢复失败：${error instanceof Error ? error.message : String(error)}`)
            } finally {
                lease.keys.clear()
                lease.state = 'released'
            }
            return { restored: errors.length === 0, errors }
        })()
        return lease.cleanup
    }

    async releaseKeyboardFocusOwner(owner: string): Promise<void> {
        const results = await Promise.all(
            [...this.keyboardFocusLeases]
                .filter(([, lease]) => lease.owner === owner && lease.state !== 'released')
                .map(([tabId, lease]) => this.releaseKeyboardFocus(tabId, lease.id, owner, true))
        )
        const errors = results.flatMap((result) => result.errors)
        if (errors.length) {
            throw new Error(errors.join('; '))
        }
    }

    addEventConsumer(consumer: (tabId: number, method: string, params: unknown, sessionId?: string) => void): void {
        this.eventConsumers.add(consumer)
    }

    /** tabId 是否当前已 attach（外部只读） */
    isAttached(tabId: number): boolean {
        return this.attachedTabs.has(tabId)
    }

    /** debugger 是否被其他扩展占用（外部只读） */
    isBlocked(tabId: number): boolean {
        return this.debuggerBlocked.has(tabId)
    }

    /** 取指定 tab 的执行上下文列表（外部只读，缺省返回空数组） */
    getExecutionContexts(
        tabId: number
    ): Array<{ id: number; frameId: string; isDefault: boolean; sessionId?: string }> {
        return this.executionContexts.get(tabId) ?? []
    }

    async getFrameSessions(tabId: number): Promise<chrome.debugger.DebuggerSession[]> {
        await this.ensureAttached(tabId)
        const targets: chrome.debugger.DebuggerSession[] = [{ tabId }]
        for (let index = 0; index < targets.length; ++index) {
            await chrome.debugger.sendCommand(targets[index]!, 'Target.setAutoAttach', {
                autoAttach: true,
                waitForDebuggerOnStart: false,
                flatten: true,
                filter: [{ type: 'iframe', exclude: false }],
            })
            for (const sessionId of this.frameSessions.get(tabId)?.values() ?? []) {
                if (!targets.some((target) => target.sessionId === sessionId)) {
                    targets.push({ tabId, sessionId })
                }
            }
        }
        return targets
    }

    invalidateExecutionContext(tabId: number, contextId: number, sessionId?: string): void {
        const contexts = this.executionContexts.get(tabId)
        if (!contexts) {
            return
        }
        const next = contexts.filter((context) => context.id !== contextId || context.sessionId !== sessionId)
        if (next.length > 0) {
            this.executionContexts.set(tabId, next)
        } else {
            this.executionContexts.delete(tabId)
        }
    }

    setupListeners(): void {
        if (this.listenersBound) {
            return
        }
        this.listenersBound = true

        // 监听 debugger 断开（仅处理本实例 attach 过的 tab,避免与其他扩展冲突）
        chrome.debugger.onDetach.addListener((source, reason) => {
            if (!source.tabId || !this.attachedTabs.has(source.tabId)) {
                return
            }
            this.cleanupTab(source.tabId)
            this.logManager.handleDebuggerDetach(source.tabId)
            console.log(`[MCP] Debugger detached from tab ${source.tabId}: ${reason}`)
        })

        // 监听 debugger 事件（仅本实例 attach 过的 tab）
        chrome.debugger.onEvent.addListener((source, method, params) => {
            if (!source.tabId || !this.attachedTabs.has(source.tabId)) {
                return
            }
            const tabId = source.tabId

            // 日志相关事件委托给 LogManager
            this.logManager.handleEvent(tabId, method, params, source.sessionId)
            for (const consume of this.eventConsumers) {
                consume(tabId, method, params, source.sessionId)
            }

            if (method === 'Target.attachedToTarget') {
                const p = params as { sessionId: string; targetInfo: { targetId: string; type: string } }
                if (p.targetInfo.type === 'iframe') {
                    const sessions = this.frameSessions.get(tabId) ?? new Map<string, string>()
                    sessions.set(p.targetInfo.targetId, p.sessionId)
                    this.frameSessions.set(tabId, sessions)
                }
            }
            if (method === 'Target.detachedFromTarget') {
                const p = params as { sessionId: string }
                for (const [id, sessionId] of this.frameSessions.get(tabId) ?? []) {
                    if (sessionId === p.sessionId) {
                        this.frameSessions.get(tabId)!.delete(id)
                    }
                }
                this.executionContexts.set(
                    tabId,
                    (this.executionContexts.get(tabId) ?? []).filter((context) => context.sessionId !== p.sessionId)
                )
            }

            // 捕获执行上下文创建（用于 iframe 内 precise evaluate）
            if (method === 'Runtime.executionContextCreated') {
                const p = params as { context: { id: number; auxData?: { frameId?: string; isDefault?: boolean } } }
                const ctx = p.context
                if (ctx.auxData?.frameId) {
                    const contexts = (this.executionContexts.get(tabId) || []).filter(
                        (item) => item.id !== ctx.id || item.sessionId !== source.sessionId
                    )
                    contexts.push({
                        id: ctx.id,
                        frameId: ctx.auxData.frameId,
                        isDefault: ctx.auxData.isDefault ?? false,
                        ...(source.sessionId ? { sessionId: source.sessionId } : {}),
                    })
                    this.executionContexts.set(tabId, contexts)
                }
            }

            // 子 frame 导航会销毁旧上下文：及时移除，避免命中已失效的 contextId
            if (method === 'Runtime.executionContextDestroyed') {
                const p = params as { executionContextId: number }
                this.invalidateExecutionContext(tabId, p.executionContextId, source.sessionId)
            }

            // 上下文清除时重置
            if (method === 'Runtime.executionContextsCleared') {
                this.executionContexts.set(
                    tabId,
                    (this.executionContexts.get(tabId) ?? []).filter(
                        (context) => context.sessionId !== source.sessionId
                    )
                )
            }
        })
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
        let freshSession = true
        const attachPromise = chrome.debugger
            .attach({ tabId }, '1.3')
            .catch(async (err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err)
                if (!msg.includes('Another debugger') && !msg.includes('already attached')) {
                    throw err
                }
                freshSession = false
                // 外部会话拒绝此只读命令，继续返回占用错误，不 detach 或接管
                const proof = (await chrome.debugger
                    .sendCommand({ tabId }, 'Runtime.getIsolateId')
                    .catch(() => null)) as { id?: unknown } | null | undefined
                if ((this.cleanupEpoch.get(tabId) ?? 0) !== myEpoch) {
                    return
                }
                if (typeof proof?.id === 'string' && proof.id.trim().length > 0) {
                    return
                }
                this.debuggerBlocked.add(tabId)
                this.debuggerBlockedRetryAfter.set(tabId, Date.now() + 2000)
                throw new DebuggerBlockedError(tabId)
            })
            .then(async () => {
                // attach 成功但期间发生了 cleanup,丢弃成功结果（避免 onDetach 漏触发后 attachedTabs 漂移）
                if ((this.cleanupEpoch.get(tabId) ?? 0) !== myEpoch) {
                    return
                }
                this.attachedTabs.add(tabId)
                this.debuggerBlocked.delete(tabId)
                this.debuggerBlockedRetryAfter.delete(tabId)
                await chrome.debugger.sendCommand({ tabId }, 'Page.enable')
                if (freshSession && (this.cleanupEpoch.get(tabId) ?? 0) === myEpoch) {
                    this.focusStates.set(tabId, false)
                }
            })

        this.pendingAttach.set(tabId, attachPromise)
        try {
            await attachPromise
        } finally {
            if (this.pendingAttach.get(tabId) === attachPromise) {
                this.pendingAttach.delete(tabId)
            }
        }
    }

    cleanupTab(tabId: number): void {
        this.onCleanup?.(tabId)
        // 自增 epoch,使任何还在 in-flight 的 attach Promise 在完成时识别出"自己已过期"
        this.cleanupEpoch.set(tabId, (this.cleanupEpoch.get(tabId) ?? 0) + 1)
        this.attachedTabs.delete(tabId)
        clearTimeout(this.keyboardFocusLeases.get(tabId)?.timer)
        this.keyboardFocusLeases.delete(tabId)
        this.focusStates.delete(tabId)
        this.focusVersions.delete(tabId)
        this.debuggerBlocked.delete(tabId)
        this.debuggerBlockedRetryAfter.delete(tabId)
        this.executionContexts.delete(tabId)
        this.frameSessions.delete(tabId)
        this.pendingAttach.delete(tabId)
    }

    private async waitForKeyboardCleanup<T>(operation: Promise<T>): Promise<T> {
        const deadline = Date.now() + 1000
        let timer: ReturnType<typeof setTimeout>
        const timeout = new Promise<never>((_, reject) => {
            const expire = () => {
                const remaining = deadline - Date.now()
                if (remaining > 0) {
                    timer = setTimeout(expire, remaining)
                } else {
                    reject(new Error('Keyboard focus cleanup timeout'))
                }
            }
            timer = setTimeout(expire, 1000)
        })
        try {
            return await Promise.race([operation, timeout])
        } finally {
            clearTimeout(timer!)
        }
    }
}
