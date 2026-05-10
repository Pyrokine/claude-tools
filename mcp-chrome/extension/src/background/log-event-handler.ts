import type { ConsoleMessage, NetworkRequest } from '../types'
import {
    ConsoleClearSchema,
    ConsoleEnableSchema,
    ConsoleGetSchema,
    NetworkClearSchema,
    NetworkEnableSchema,
    NetworkGetSchema,
} from '../types/schemas'
import { assertScriptable, getTargetTabId, isRestrictedUrl } from './action-utils'
import { DebuggerBlockedError, DebuggerManager } from './debugger-manager'
import { LogManager } from './log-manager'

export class LogEventHandler {
    constructor(
        private logManager: LogManager,
        private debuggerManager: DebuggerManager
    ) {}

    async consoleEnable(params: unknown): Promise<{ success: boolean }> {
        const p = ConsoleEnableSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)

        // debugger 之前 blocked 现已可用 → 卸载 hook、把残留 logs 合并到 logManager 后清空
        const wasBlocked = this.debuggerManager.isBlocked(tabId)

        try {
            await this.debuggerManager.ensureAttached(tabId)
            // 启用 Runtime 域以接收控制台消息
            await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {})

            if (wasBlocked) {
                await this.flushAndUninstallConsoleHook(tabId)
            }
        } catch (err) {
            if (err instanceof DebuggerBlockedError) {
                // Fallback: 通过 scripting 注入 console 拦截器
                await assertScriptable(tabId)
                await chrome.scripting.executeScript({
                    target: { tabId, frameIds: [0] },
                    func: () => {
                        type McpWindow = Window & { __mcpConsoleHooked?: boolean; __mcpConsoleLogs?: unknown[] }
                        type ConsoleFn = (...args: unknown[]) => void
                        type ConsoleRecord = Record<string, ConsoleFn>
                        const mcpWin = window as McpWindow

                        if (mcpWin.__mcpConsoleHooked) {
                            return
                        }
                        mcpWin.__mcpConsoleHooked = true
                        const logs: unknown[] = []
                        mcpWin.__mcpConsoleLogs = logs
                        const orig: ConsoleRecord = {}
                        for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
                            orig[level] = (console as unknown as ConsoleRecord)[level]
                            Reflect.set(console, level, (...args: unknown[]) => {
                                logs.push({
                                    source: 'console-api',
                                    level,
                                    text: args.map(String).join(' '),
                                    timestamp: Date.now(),
                                })
                                if (logs.length > 1000) {
                                    logs.shift()
                                }
                                orig[level].apply(console, args)
                            })
                        }
                    },
                    world: 'MAIN',
                })
            } else {
                throw err
            }
        }

        // 初始化消息存储
        if (!this.logManager.hasConsole(tabId)) {
            this.logManager.setConsole(tabId, [])
        }

        return { success: true }
    }

    async consoleGet(params: unknown): Promise<{ messages: ConsoleMessage[] }> {
        const p = ConsoleGetSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)

        let messages = this.logManager.getConsole(tabId)

        // 永远尝试合并 fallback 数组（即使 debugger 已不再 blocked,可能仍有 hook 注入未卸载残留）
        try {
            const tab = await chrome.tabs.get(tabId)
            if (!isRestrictedUrl(tab.url)) {
                const results = await chrome.scripting.executeScript({
                    target: { tabId, frameIds: [0] },
                    func: () => {
                        type McpWindow = Window & { __mcpConsoleLogs?: unknown[] }
                        const mcpWin = window as McpWindow
                        return mcpWin.__mcpConsoleLogs ?? []
                    },
                    world: 'MAIN',
                })
                const injected = (results[0]?.result as ConsoleMessage[]) ?? []
                if (injected.length > 0) {
                    // 简单合并（按 timestamp 去重）
                    const seen = new Set<string>()
                    const all = [...messages, ...injected]
                    messages = all.filter((m) => {
                        const key = `${m.timestamp}|${m.text}`
                        if (seen.has(key)) {
                            return false
                        }
                        seen.add(key)
                        return true
                    })
                }
            }
        } catch (e) {
            console.warn('[logs] console fallback (executeScript) failed:', e)
        }

        // 按级别过滤（warning/warn 统一匹配）
        if (p.level) {
            const target = p.level
            messages = messages.filter(
                (m) =>
                    m.level === target ||
                    (target === 'warning' && m.level === 'warn') ||
                    (target === 'warn' && m.level === 'warning')
            )
        }

        // 按正则过滤（检测灾难性模式 + 限制输入长度，防止 ReDoS 阻塞后台线程）
        if (p.pattern) {
            // 检测典型灾难性回溯模式：
            //   嵌套量词 (x+)+、(x*)*、(x+)*、(x{n,})+
            //   交替重复 (a|b)+、(a|a)*（任一支重复）
            const hasCatastrophicPattern =
                /(?:[+*]|\{[^}]*})\)[+*{]/.test(p.pattern) || /\([^()]*\|[^()]*\)[+*]/.test(p.pattern)
            if (!hasCatastrophicPattern) {
                try {
                    const regex = new RegExp(p.pattern, 'i')
                    const MAX_TEST_LEN = 50000 // 单条消息最多测试 50KB
                    messages = messages.filter((m) => {
                        const text = m.text.length > MAX_TEST_LEN ? m.text.slice(0, MAX_TEST_LEN) : m.text
                        return regex.test(text)
                    })
                } catch {
                    // 正则无效时退化为字符串包含匹配
                    const pat = p.pattern.toLowerCase()
                    messages = messages.filter((m) => m.text.toLowerCase().includes(pat))
                }
            } else {
                // 灾难性模式退化为字符串包含匹配
                const pat = p.pattern.toLowerCase()
                messages = messages.filter((m) => m.text.toLowerCase().includes(pat))
            }
        }

        // 清除已读消息
        if (p.clear) {
            this.logManager.setConsole(tabId, [])
            // 同时清除 fallback 日志
            if (this.debuggerManager.isBlocked(tabId)) {
                try {
                    const tab = await chrome.tabs.get(tabId)
                    if (!isRestrictedUrl(tab.url)) {
                        await chrome.scripting.executeScript({
                            target: { tabId, frameIds: [0] },
                            func: () => {
                                type McpWindow = Window & { __mcpConsoleLogs?: unknown[] }
                                const mcpWin = window as McpWindow
                                mcpWin.__mcpConsoleLogs = []
                            },
                            world: 'MAIN',
                        })
                    }
                } catch (e) {
                    console.warn('[logs] console clear fallback (executeScript) failed:', e)
                }
            }
        }

        return { messages }
    }

    async consoleClear(params: unknown): Promise<{ success: boolean }> {
        const p = ConsoleClearSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)

        this.logManager.setConsole(tabId, [])

        return { success: true }
    }

    async networkEnable(params: unknown): Promise<{ success: boolean }> {
        const p = NetworkEnableSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)

        try {
            await this.debuggerManager.ensureAttached(tabId)
            // 启用 Network 域以接收网络事件
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

    async networkGet(params: unknown): Promise<{ requests: NetworkRequest[] }> {
        const p = NetworkGetSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)

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

        // 按 URL 通配符过滤（* 匹配任意字符，? 匹配单个字符）
        if (p.urlPattern) {
            try {
                // 转义正则元字符，仅保留 * 和 ? 的通配语义
                const escaped = p.urlPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
                const regex = new RegExp(pattern, 'i')
                requests = requests.filter((r) => regex.test(r.url))
            } catch {
                // 构造失败时退化为字符串包含匹配
                const pat = p.urlPattern.toLowerCase()
                requests = requests.filter((r) => r.url.toLowerCase().includes(pat))
            }
        }

        if (p.clear) {
            this.logManager.setNetwork(tabId, [])
        }

        return { requests }
    }

    async networkClear(params: unknown): Promise<{ success: boolean }> {
        const p = NetworkClearSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)

        this.logManager.setNetwork(tabId, [])

        return { success: true }
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
                    type McpWindow = Window & { __mcpConsoleHooked?: boolean; __mcpConsoleLogs?: unknown[] }
                    const w = window as McpWindow
                    const logs = w.__mcpConsoleLogs ?? []
                    w.__mcpConsoleLogs = []
                    w.__mcpConsoleHooked = false
                    return logs
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
