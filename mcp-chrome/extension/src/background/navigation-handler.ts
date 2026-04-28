import type { TabInfo, WaitUntil } from '../types'
import { ExpectedOperationError } from '../types/expected-errors'
import { GoBackSchema, GoForwardSchema, NavigateSchema, ReloadSchema } from '../types/schemas'
import { type ActionContext, getTargetTabId } from './action-utils.js'
import type { LogManager } from './log-manager.js'

export class NavigationHandler {
    constructor(private logManager: LogManager) {}

    async navigate(params: unknown, context: ActionContext): Promise<TabInfo> {
        const p = NavigateSchema.parse(params)

        const tabId = await getTargetTabId(p.tabId)
        await chrome.tabs.update(tabId, { url: p.url })

        if (p.waitUntil) {
            await this.waitForNavigation(tabId, p.waitUntil, p.timeout)
        }

        const tab = await chrome.tabs.get(tabId)
        return {
            id: tab.id!,
            url: tab.url || '',
            title: tab.title || '',
            active: tab.active,
            windowId: tab.windowId,
            index: tab.index,
            groupId: tab.groupId,
            pinned: tab.pinned,
            incognito: tab.incognito,
            managed: context.mcpTabGroupId !== null && tab.groupId === context.mcpTabGroupId,
            status: tab.status || 'unknown',
        }
    }

    async goBack(params: unknown): Promise<{ url: string; title: string; navigated: boolean }> {
        const p = GoBackSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)
        const beforeTab = await chrome.tabs.get(tabId)
        const beforeUrl = beforeTab.url

        // 信号窗口：受 p.timeout 控制（上限 5s），默认 2s
        const signalTimeout = Math.min(p.timeout ?? 2000, 5000)
        // 先注册事件监听，再触发导航，避免错过瞬间完成的导航
        const navigationPromise = this.waitForNavigationSignal(tabId, beforeUrl, signalTimeout)
        try {
            await chrome.tabs.goBack(tabId)
        } catch {
            // chrome.tabs.goBack 在 chrome.tabs.update 产生的历史栈上可能失败
            // （Chrome 原生报错 "Cannot find a next page in history"），fallback 到 JS 层 history.back()
            await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: () => history.back(),
            })
        }
        const navigated = await navigationPromise

        if (navigated && p.waitUntil) {
            await this.waitForNavigation(tabId, p.waitUntil, p.timeout)
        }

        const tab = await chrome.tabs.get(tabId)
        return { url: tab.url || '', title: tab.title || '', navigated }
    }

    async goForward(params: unknown): Promise<{ url: string; title: string; navigated: boolean }> {
        const p = GoForwardSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)
        const beforeTab = await chrome.tabs.get(tabId)
        const beforeUrl = beforeTab.url

        // 信号窗口：受 p.timeout 控制（上限 5s），默认 2s
        const signalTimeout = Math.min(p.timeout ?? 2000, 5000)
        // 先注册事件监听，再触发导航，避免错过瞬间完成的导航
        const navigationPromise = this.waitForNavigationSignal(tabId, beforeUrl, signalTimeout)
        try {
            await chrome.tabs.goForward(tabId)
        } catch {
            // 同 goBack：fallback 到 JS 层 history.forward()
            await chrome.scripting.executeScript({
                target: { tabId },
                world: 'MAIN',
                func: () => history.forward(),
            })
        }
        const navigated = await navigationPromise

        if (navigated && p.waitUntil) {
            await this.waitForNavigation(tabId, p.waitUntil, p.timeout)
        }

        const tab = await chrome.tabs.get(tabId)
        return { url: tab.url || '', title: tab.title || '', navigated }
    }

    async reload(params: unknown): Promise<{ url: string; title: string }> {
        const p = ReloadSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)

        await chrome.tabs.reload(tabId, { bypassCache: p.ignoreCache ?? false })

        if (p.waitUntil) {
            await this.waitForNavigation(tabId, p.waitUntil, p.timeout)
        }

        const tab = await chrome.tabs.get(tabId)
        return { url: tab.url || '', title: tab.title || '' }
    }

    async waitForNavigation(tabId: number, waitUntil: WaitUntil, timeout = 30000): Promise<void> {
        const startTime = Date.now()

        if (waitUntil === 'domcontentloaded') {
            // DOMContentLoaded：事件监听 + 轮询兜底
            await new Promise<void>((resolve, reject) => {
                let settled = false
                const done = () => {
                    if (!settled) {
                        settled = true
                        cleanup()
                        resolve()
                    }
                }
                const fail = (err: Error) => {
                    if (!settled) {
                        settled = true
                        cleanup()
                        reject(err)
                    }
                }

                const onDCL = (details: { tabId: number; frameId: number }) => {
                    if (details.tabId === tabId && details.frameId === 0) {
                        done()
                    }
                }
                const timeoutId = setTimeout(() => fail(new ExpectedOperationError('Navigation timeout')), timeout)
                const cleanup = () => {
                    chrome.webNavigation.onDOMContentLoaded.removeListener(onDCL)
                    clearTimeout(timeoutId)
                }

                chrome.webNavigation.onDOMContentLoaded.addListener(onDCL)

                // 轮询兜底：tab.status === 'complete' 意味着 DOMContentLoaded 已过
                const checkStatus = async () => {
                    if (settled) {
                        return
                    }
                    try {
                        const tab = await chrome.tabs.get(tabId)
                        if (tab.status === 'complete') {
                            done()
                            return
                        }
                    } catch (e) {
                        fail(e as Error)
                        return
                    }
                    setTimeout(checkStatus, 100)
                }
                checkStatus()
            })
            return
        }

        // load / networkidle：等待 tab.status === 'complete'
        await new Promise<void>((resolve, reject) => {
            let settled = false
            const checkStatus = async () => {
                if (settled) {
                    return
                }
                if (Date.now() - startTime > timeout) {
                    settled = true
                    reject(new ExpectedOperationError('Navigation timeout'))
                    return
                }

                try {
                    const tab = await chrome.tabs.get(tabId)
                    if (tab.status === 'complete') {
                        settled = true
                        resolve()
                        return
                    }
                    setTimeout(checkStatus, 100)
                } catch (error) {
                    if (!settled) {
                        settled = true
                        reject(error)
                    }
                }
            }

            checkStatus()
        })

        // networkidle：等待 pendingRequests 为空（而非简单 sleep）
        if (waitUntil === 'networkidle') {
            const idleWindow = 500
            await new Promise<void>((resolve) => {
                let idleSince: number | null = null
                const checkIdle = () => {
                    const remaining = timeout - (Date.now() - startTime)
                    if (remaining <= 0) {
                        resolve()
                        return
                    }
                    const pending = this.logManager.getPending(tabId)
                    const hasPending = pending && pending.size > 0
                    if (hasPending) {
                        idleSince = null
                    } else if (idleSince === null) {
                        idleSince = Date.now()
                    }
                    if (!hasPending && idleSince !== null && Date.now() - idleSince >= idleWindow) {
                        resolve()
                        return
                    }
                    setTimeout(checkIdle, 100)
                }
                checkIdle()
            })
        }
    }

    /**
     * 事件驱动检测导航信号（用于 back/forward 导航判定）
     *
     * 三重信号源：
     * 1. chrome.webNavigation.onCommitted + forward_back qualifier — 精确匹配 back/forward 导航
     * 2. chrome.tabs.onUpdated URL 变化 — 常见场景
     * 3. chrome.tabs.onUpdated status=loading — 覆盖同 URL 历史条目
     *
     * 同时立即检查一次（处理导航在 listener 注册前已完成的情况）
     */
    private waitForNavigationSignal(tabId: number, beforeUrl: string | undefined, timeout: number): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            let settled = false

            const done = (result: boolean) => {
                if (settled) {
                    return
                }
                settled = true
                clearTimeout(timer)
                chrome.tabs.onUpdated.removeListener(tabListener)
                chrome.webNavigation.onCommitted.removeListener(navListener)
                resolve(result)
            }

            const timer = setTimeout(() => done(false), timeout)

            // webNavigation.onCommitted：仅匹配 forward_back qualifier，过滤无关导航避免误判
            const navListener = (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
                if (
                    details.tabId === tabId &&
                    details.frameId === 0 &&
                    details.transitionQualifiers?.includes('forward_back')
                ) {
                    done(true)
                }
            }

            const tabListener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
                if (updatedTabId !== tabId) {
                    return
                }
                // 仅 URL 实际变化时才视为导航触发；status='loading' 在不变 URL 的页内事件下也会出现，会误触发
                if (changeInfo.url && changeInfo.url !== beforeUrl) {
                    done(true)
                }
            }

            chrome.webNavigation.onCommitted.addListener(navListener)
            chrome.tabs.onUpdated.addListener(tabListener)

            // 立即检查一次，处理导航在 addListener 前已完成的竞态
            chrome.tabs
                .get(tabId)
                .then((tab) => {
                    if (tab.url !== beforeUrl) {
                        done(true)
                    }
                })
                .catch(() => {
                    done(false)
                })
        })
    }
}
