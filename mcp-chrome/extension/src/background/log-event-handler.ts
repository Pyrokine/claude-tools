import type { ConsoleMessage, NetworkRequest } from '../types'
import { ExpectedOperationError } from '../types/expected-errors'
import {
    ConsoleClearSchema,
    ConsoleEnableSchema,
    ConsoleGetSchema,
    NetworkChallengeStateSchema,
    NetworkClearSchema,
    NetworkEnableSchema,
    NetworkGetSchema,
} from '../types/schemas'
import { type ActionContext, assertManagedTab, assertScriptable, getTargetTabId, isRestrictedUrl } from './action-utils'
import { DebuggerBlockedError, DebuggerManager } from './debugger-manager'
import { LogManager } from './log-manager'
import { getExistingTab } from './page-revision'

function wildcardSegmentMatches(value: string, segment: string, index: number): boolean {
    if (index + segment.length > value.length) {
        return false
    }

    for (let i = 0; i < segment.length; ++i) {
        const expected = segment[i]
        if (expected !== '?' && expected !== value[index + i]) {
            return false
        }
    }

    return true
}

function wildcardSegmentIndexOf(value: string, segment: string, start: number): number {
    if (!segment.includes('?')) {
        return value.indexOf(segment, start)
    }

    for (let i = start; i <= value.length - segment.length; ++i) {
        if (wildcardSegmentMatches(value, segment, i)) {
            return i
        }
    }

    return -1
}

function matchesUrlPattern(url: string, pattern: string): boolean {
    const value = url.toLowerCase()
    const normalizedPattern = pattern.toLowerCase().replace(/\*+/g, '*')

    if (!normalizedPattern.includes('*') && !normalizedPattern.includes('?')) {
        return value.includes(normalizedPattern)
    }

    const segments = normalizedPattern.split('*').filter((segment) => segment.length > 0)
    let position = 0

    for (const segment of segments) {
        const index = wildcardSegmentIndexOf(value, segment, position)
        if (index < 0) {
            return false
        }
        position = index + segment.length
    }

    return true
}

export class LogEventHandler {
    private consoleLocks = new Map<number, Promise<void>>()

    constructor(
        private logManager: LogManager,
        private debuggerManager: DebuggerManager
    ) {}

    async consoleEnable(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = ConsoleEnableSchema.parse(params) ?? {}
        const tabId = await this.getManagedTabId(p.tabId, context, 'console_enable')

        return this.withConsoleLock(tabId, () => this.enableConsole(tabId))
    }

    async consoleGet(params: unknown, context: ActionContext): Promise<{ messages: ConsoleMessage[] }> {
        const p = ConsoleGetSchema.parse(params) ?? {}
        const tabId = await this.getManagedTabId(p.tabId, context, 'console_get')

        return this.withConsoleLock(tabId, () => this.readConsole(tabId, p))
    }

    async consoleClear(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = ConsoleClearSchema.parse(params) ?? {}
        const tabId = await this.getManagedTabId(p.tabId, context, 'console_clear')

        return this.withConsoleLock(tabId, async () => {
            this.logManager.setConsole(tabId, [])
            await this.clearFallbackConsole(tabId)
            return { success: true }
        })
    }

    async networkEnable(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = NetworkEnableSchema.parse(params) ?? {}
        const tabId = await this.getManagedTabId(p.tabId, context, 'network_enable')

        try {
            await this.enableNetworkObservation(tabId)
        } catch (err) {
            if (!(err instanceof DebuggerBlockedError)) {
                throw err
            }
            // Debugger 被占用，networkGet 将通过 performance API fallback
        }

        if (!this.logManager.hasNetwork(tabId)) {
            this.logManager.setNetwork(tabId, [])
        }

        return { success: true }
    }

    async enableNetworkObservation(tabId: number): Promise<void> {
        await this.debuggerManager.ensureAttached(tabId)
        await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {})
        const frameTree = (await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree', {})) as {
            frameTree: { frame: { id: string } }
        }
        this.logManager.setMainFrameId(tabId, frameTree.frameTree.frame.id)
        await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {})
        if (!this.debuggerManager.isAttached(tabId)) {
            throw new ExpectedOperationError('Network 观测已中断，无法判断 networkidle')
        }
        this.logManager.markNetworkObserved(tabId)
    }

    async networkGet(params: unknown, context: ActionContext): Promise<{ requests: NetworkRequest[] }> {
        const p = NetworkGetSchema.parse(params) ?? {}
        const tabId = await this.getManagedTabId(p.tabId, context, 'network_get')

        let requests = this.logManager.getNetwork(tabId)

        const performanceSource = !this.debuggerManager.isAttached(tabId)
        if (performanceSource) {
            const latest = await this.readPerformanceNetwork(tabId, p.clear === true)
            const key = (request: NetworkRequest) =>
                JSON.stringify([request.url, request.type, request.timestamp, request.duration, request.status])
            const previous = new Map<string, NetworkRequest[]>()
            for (const request of requests.filter((item) => item.source === 'performance')) {
                const identity = key(request)
                const matches = previous.get(identity) ?? []
                matches.push(request)
                previous.set(identity, matches)
            }
            for (const request of latest) {
                const existing = previous.get(key(request))?.shift()
                if (existing) {
                    request.sequence = existing.sequence
                }
            }
            requests = [...requests.filter((item) => item.source !== 'performance'), ...latest].slice(-1000)
            this.logManager.setNetwork(tabId, requests)
        } else if (p.clear && !isRestrictedUrl((await getExistingTab(tabId)).url)) {
            await this.readPerformanceNetwork(tabId, true)
        }

        // 按 URL 通配符过滤，* 匹配任意字符，? 匹配单个字符
        if (p.urlPattern) {
            requests = requests.filter((r) => matchesUrlPattern(String(r.url ?? ''), p.urlPattern!))
        }

        if (p.clear) {
            this.logManager.setNetwork(tabId, [])
        }

        return { requests }
    }

    async networkClear(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = NetworkClearSchema.parse(params) ?? {}
        const tabId = await this.getManagedTabId(p.tabId, context, 'network_clear')
        if (!isRestrictedUrl((await getExistingTab(tabId)).url)) {
            await this.readPerformanceNetwork(tabId, true)
        }
        this.logManager.setNetwork(tabId, [])
        return { success: true }
    }

    async networkChallengeState(params: unknown, context: ActionContext): Promise<{ challengeRequired: boolean }> {
        const p = NetworkChallengeStateSchema.parse(params) ?? {}
        const tabId = await this.getManagedTabId(p.tabId, context, 'network_challenge_state')
        return { challengeRequired: this.logManager.isChallengeRequired(tabId) }
    }

    /** 卸载 fallback console hook，把残留日志合并到 logManager，并报告清理结果 */
    async flushAndUninstallConsoleHook(tabId: number): Promise<boolean> {
        try {
            const tab = await getExistingTab(tabId)
            if (isRestrictedUrl(tab.url)) {
                return true
            }
            const results = await chrome.scripting.executeScript({
                target: { tabId, frameIds: [0] },
                func: () => {
                    type ConsoleFn = (...args: unknown[]) => void
                    type ConsoleRecord = Record<string, ConsoleFn>
                    type ConsoleHookState = {
                        active: boolean
                        logs: unknown[]
                        originals: ConsoleRecord
                        wrappers: ConsoleRecord
                    }
                    type McpWindow = Window & { __mcpConsoleHook?: ConsoleHookState }
                    const mcpWin = window as McpWindow
                    const state = mcpWin.__mcpConsoleHook
                    if (!state) {
                        return []
                    }
                    const residual = state.logs.splice(0, state.logs.length)
                    state.active = false
                    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
                        const current = (console as unknown as ConsoleRecord)[level]
                        if (current === state.wrappers[level] && typeof state.originals[level] === 'function') {
                            Reflect.set(console, level, state.originals[level])
                        }
                    }
                    Reflect.deleteProperty(mcpWin, '__mcpConsoleHook')
                    return residual
                },
                world: 'MAIN',
            })
            const residual = (results[0]?.result as ConsoleMessage[]) ?? []
            const injectionError = (results[0] as { error?: { message?: string } } | undefined)?.error
            if (injectionError) {
                throw new Error(injectionError.message ?? String(injectionError))
            }
            if (residual.length > 0) {
                const existing = this.logManager.getConsole(tabId) ?? []
                this.logManager.setConsole(tabId, [...existing, ...residual])
            }
            return true
        } catch (e) {
            console.warn('[logs] flush console hook failed:', e)
            return false
        }
    }

    private async readPerformanceNetwork(tabId: number, clear: boolean): Promise<NetworkRequest[]> {
        await assertScriptable(tabId)
        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            world: 'ISOLATED',
            func: (clear: boolean) => {
                const state = window as Window & { __mcpNetworkClearedBefore?: number }
                const clearedBefore = state.__mcpNetworkClearedBefore ?? -1
                const navigation = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
                const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
                const requests = [
                    ...navigation.map((entry) => ({ entry, method: 'GET', type: 'Document' })),
                    ...resources.map((entry) => ({ entry, method: '', type: entry.initiatorType })),
                ]
                    .filter(({ entry }) => entry.startTime > clearedBefore)
                    .slice(-1000)
                    .map(({ entry, method, type }) => ({
                        source: 'performance' as const,
                        url: entry.name,
                        method,
                        type,
                        status: (entry as PerformanceResourceTiming & { responseStatus?: number }).responseStatus ?? 0,
                        timestamp: Math.round(entry.startTime + performance.timeOrigin),
                        duration: Math.round(entry.duration),
                    }))
                if (clear) {
                    state.__mcpNetworkClearedBefore = performance.now()
                }
                return requests
            },
            args: [clear],
        })
        if (!Array.isArray(results[0]?.result)) {
            throw new ExpectedOperationError('Performance network read did not return request records')
        }
        return results[0].result as NetworkRequest[]
    }

    private async enableConsole(tabId: number): Promise<{ success: boolean }> {
        try {
            await this.debuggerManager.ensureAttached(tabId)
            await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {})
            // Service Worker 重启后内存中的 blocked 状态会丢失，成功 attach 时仍需探测并卸载页面 hook
            await this.flushAndUninstallConsoleHook(tabId)
        } catch (err) {
            if (err instanceof DebuggerBlockedError) {
                await assertScriptable(tabId)
                await chrome.scripting.executeScript({
                    target: { tabId, frameIds: [0] },
                    func: () => {
                        type ConsoleFn = (...args: unknown[]) => void
                        type ConsoleRecord = Record<string, ConsoleFn>
                        type ConsoleHookState = {
                            active: boolean
                            logs: unknown[]
                            originals: ConsoleRecord
                            wrappers: ConsoleRecord
                        }
                        type McpWindow = Window & { __mcpConsoleHook?: ConsoleHookState }
                        const mcpWin = window as McpWindow

                        if (mcpWin.__mcpConsoleHook?.active) {
                            return
                        }
                        const state: ConsoleHookState = {
                            active: true,
                            logs: [],
                            originals: {},
                            wrappers: {},
                        }
                        mcpWin.__mcpConsoleHook = state
                        for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
                            state.originals[level] = (console as unknown as ConsoleRecord)[level]
                            state.wrappers[level] = (...args: unknown[]) => {
                                if (state.active) {
                                    state.logs.push({
                                        source: 'console-api',
                                        level,
                                        text: args.map(String).join(' '),
                                        timestamp: Date.now(),
                                    })
                                    if (state.logs.length > 1000) {
                                        state.logs.shift()
                                    }
                                }
                                state.originals[level].apply(console, args)
                            }
                            Reflect.set(console, level, state.wrappers[level])
                        }
                    },
                    world: 'MAIN',
                })
            } else {
                throw err
            }
        }

        if (!this.logManager.hasConsole(tabId)) {
            this.logManager.setConsole(tabId, [])
        }
        return { success: true }
    }

    private async readConsole(
        tabId: number,
        params: { level?: string; pattern?: string; clear?: boolean }
    ): Promise<{ messages: ConsoleMessage[] }> {
        let messages = this.logManager.getConsole(tabId)

        try {
            const tab = await getExistingTab(tabId)
            if (!isRestrictedUrl(tab.url)) {
                const results = await chrome.scripting.executeScript({
                    target: { tabId, frameIds: [0] },
                    func: () => {
                        type ConsoleHookState = { logs: unknown[] }
                        type McpWindow = Window & { __mcpConsoleHook?: ConsoleHookState }
                        const logs = (window as McpWindow).__mcpConsoleHook?.logs
                        return Array.isArray(logs) ? logs.splice(0, logs.length) : []
                    },
                    world: 'MAIN',
                })
                const injected = (results[0]?.result as ConsoleMessage[]) ?? []
                if (injected.length > 0) {
                    const seen = new Set<string>()
                    messages = [...messages, ...injected].filter((message) => {
                        const key = `${message.timestamp}|${message.text}`
                        if (seen.has(key)) {
                            return false
                        }
                        seen.add(key)
                        return true
                    })
                }
            }
        } catch (error) {
            console.warn('[logs] console fallback (executeScript) failed:', error)
        }

        this.logManager.setConsole(tabId, messages)
        messages = this.logManager.getConsole(tabId)

        if (params.level) {
            const target = params.level
            messages = messages.filter(
                (message) =>
                    message.level === target ||
                    (target === 'warning' && message.level === 'warn') ||
                    (target === 'warn' && message.level === 'warning')
            )
        }

        if (params.pattern) {
            const hasCatastrophicPattern =
                /(?:[+*]|\{[^}]*})\)[+*{]/.test(params.pattern) || /\([^()]*\|[^()]*\)[+*]/.test(params.pattern)
            if (!hasCatastrophicPattern) {
                try {
                    const regex = new RegExp(params.pattern, 'i')
                    const maxTestLength = 50000
                    messages = messages.filter((message) =>
                        regex.test(
                            message.text.length > maxTestLength ? message.text.slice(0, maxTestLength) : message.text
                        )
                    )
                } catch {
                    const pattern = params.pattern.toLowerCase()
                    messages = messages.filter((message) => message.text.toLowerCase().includes(pattern))
                }
            } else {
                const pattern = params.pattern.toLowerCase()
                messages = messages.filter((message) => message.text.toLowerCase().includes(pattern))
            }
        }

        if (params.clear) {
            this.logManager.setConsole(tabId, [])
            await this.clearFallbackConsole(tabId)
        }

        return { messages }
    }

    private async withConsoleLock<T>(tabId: number, action: () => Promise<T>): Promise<T> {
        const previous = this.consoleLocks.get(tabId) ?? Promise.resolve()
        let release = () => {}
        const current = new Promise<void>((resolve) => {
            release = resolve
        })
        const queued = previous.then(() => current)
        this.consoleLocks.set(tabId, queued)
        await previous
        try {
            return await action()
        } finally {
            release()
            if (this.consoleLocks.get(tabId) === queued) {
                this.consoleLocks.delete(tabId)
            }
        }
    }

    private async getManagedTabId(
        tabId: number | undefined,
        context: ActionContext,
        operation: string
    ): Promise<number> {
        const resolvedTabId = await getTargetTabId(tabId)
        await assertManagedTab(resolvedTabId, context, operation)
        return resolvedTabId
    }

    private async clearFallbackConsole(tabId: number): Promise<void> {
        try {
            const tab = await getExistingTab(tabId)
            if (isRestrictedUrl(tab.url)) {
                return
            }
            await chrome.scripting.executeScript({
                target: { tabId, frameIds: [0] },
                func: () => {
                    type ConsoleHookState = { logs: unknown[] }
                    type McpWindow = Window & { __mcpConsoleHook?: ConsoleHookState }
                    const logs = (window as McpWindow).__mcpConsoleHook?.logs
                    if (Array.isArray(logs)) {
                        logs.length = 0
                    }
                },
                world: 'MAIN',
            })
        } catch (e) {
            console.warn('[logs] console clear fallback (executeScript) failed:', e)
        }
    }
}
