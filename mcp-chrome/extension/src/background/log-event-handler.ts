import type { ConsoleMessage, NetworkRequest } from '../types'
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
            await this.debuggerManager.ensureAttached(tabId)
            await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {})
            const frameTree = (await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree', {})) as {
                frameTree: { frame: { id: string } }
            }
            this.logManager.setMainFrameId(tabId, frameTree.frameTree.frame.id)
            // 初始化主 frame 后再启用 Network，避免子 frame 响应覆盖 tab 级 Challenge 状态
            await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {})
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

    async networkGet(params: unknown, context: ActionContext): Promise<{ requests: NetworkRequest[] }> {
        const p = NetworkGetSchema.parse(params) ?? {}
        const tabId = await this.getManagedTabId(p.tabId, context, 'network_get')

        let requests = this.logManager.getNetwork(tabId)

        if (requests.length === 0) {
            try {
                const tab = await chrome.tabs.get(tabId)
                if (!isRestrictedUrl(tab.url)) {
                    const results = await chrome.scripting.executeScript({
                        target: { tabId, frameIds: [0] },
                        func: () => {
                            const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
                            const navigation = performance.getEntriesByType(
                                'navigation'
                            ) as PerformanceNavigationTiming[]
                            return [
                                ...navigation.map((e) => ({
                                    url: e.name,
                                    method: 'GET',
                                    type: 'Document',
                                    status: 0,
                                    timestamp: Math.round(performance.timeOrigin),
                                    duration: Math.round(e.duration),
                                })),
                                ...resources.map((e) => ({
                                    url: e.name,
                                    method: '',
                                    type: e.initiatorType,
                                    status: 0,
                                    timestamp: Math.round(e.startTime + performance.timeOrigin),
                                    duration: Math.round(e.duration),
                                })),
                            ]
                        },
                        world: 'MAIN',
                    })
                    requests = (results[0]?.result as NetworkRequest[]) ?? []
                    this.logManager.setNetwork(tabId, requests)
                }
            } catch (e) {
                console.warn('[logs] network fallback (executeScript) failed:', e)
            }
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

        this.logManager.setNetwork(tabId, [])

        return { success: true }
    }

    async networkChallengeState(params: unknown, context: ActionContext): Promise<{ challengeRequired: boolean }> {
        const p = NetworkChallengeStateSchema.parse(params) ?? {}
        const tabId = await this.getManagedTabId(p.tabId, context, 'network_challenge_state')
        return { challengeRequired: this.logManager.isChallengeRequired(tabId) }
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
            const tab = await chrome.tabs.get(tabId)
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
            const tab = await chrome.tabs.get(tabId)
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

    /** 卸载 fallback console hook,把残留 logs 合并到 logManager,清空注入数组 */
    private async flushAndUninstallConsoleHook(tabId: number): Promise<void> {
        try {
            const tab = await chrome.tabs.get(tabId)
            if (isRestrictedUrl(tab.url)) {
                return
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
            if (residual.length > 0) {
                const existing = this.logManager.getConsole(tabId) ?? []
                this.logManager.setConsole(tabId, [...existing, ...residual])
            }
        } catch (e) {
            console.warn('[logs] flush console hook failed:', e)
        }
    }
}
