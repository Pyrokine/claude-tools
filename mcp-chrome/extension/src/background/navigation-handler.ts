import type { TabInfo, WaitUntil } from '../types'
import { ExpectedOperationError } from '../types/expected-errors'
import { GoBackSchema, GoForwardSchema, NavigateSchema, ReloadSchema } from '../types/schemas'
import { type ActionContext, assertManagedTab, getTargetTabId, isRestrictedUrl, tabToInfo } from './action-utils.js'
import type { LogManager } from './log-manager.js'

function normalizeNavigationUrl(url: string | undefined): string | undefined {
    if (url === undefined) {
        return undefined
    }
    try {
        return new URL(url).href
    } catch {
        return url
    }
}

export class NavigationHandler {
    constructor(private logManager: LogManager) {}

    async navigate(params: unknown, context: ActionContext): Promise<TabInfo> {
        const p = NavigateSchema.parse(params)

        const tabId = await getTargetTabId(p.tabId)
        await assertManagedTab(tabId, context, 'navigate')
        if (p.waitUntil) {
            await this.runNavigationAction(
                tabId,
                p.waitUntil,
                p.timeout,
                () => chrome.tabs.update(tabId, { url: p.url }),
                p.url
            )
        } else {
            await chrome.tabs.update(tabId, { url: p.url })
        }

        const tab = await chrome.tabs.get(tabId)
        return tabToInfo(tab, context)
    }

    async goBack(
        params: unknown,
        context: ActionContext
    ): Promise<{ url: string; title: string; navigated: boolean; managed: boolean }> {
        const p = GoBackSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)
        await assertManagedTab(tabId, context, 'go_back')
        const beforeTab = await chrome.tabs.get(tabId)
        const beforeUrl = beforeTab.url

        // 信号窗口：受 p.timeout 控制（上限 5s），默认 2s
        const signalTimeout = Math.min(p.timeout ?? 2000, 5000)
        const navigated = await this.navigateHistory(tabId, beforeUrl, signalTimeout, 'back')

        if (navigated && p.waitUntil) {
            await this.waitForNavigation(tabId, p.waitUntil, p.timeout)
        }

        const tab = await chrome.tabs.get(tabId)
        return { url: tab.url || '', title: tab.title || '', navigated, managed: true }
    }

    async goForward(
        params: unknown,
        context: ActionContext
    ): Promise<{ url: string; title: string; navigated: boolean; managed: boolean }> {
        const p = GoForwardSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)
        await assertManagedTab(tabId, context, 'go_forward')
        const beforeTab = await chrome.tabs.get(tabId)
        const beforeUrl = beforeTab.url

        // 信号窗口：受 p.timeout 控制（上限 5s），默认 2s
        const signalTimeout = Math.min(p.timeout ?? 2000, 5000)
        const navigated = await this.navigateHistory(tabId, beforeUrl, signalTimeout, 'forward')

        if (navigated && p.waitUntil) {
            await this.waitForNavigation(tabId, p.waitUntil, p.timeout)
        }

        const tab = await chrome.tabs.get(tabId)
        return { url: tab.url || '', title: tab.title || '', navigated, managed: true }
    }

    async reload(params: unknown, context: ActionContext): Promise<{ url: string; title: string; managed: boolean }> {
        const p = ReloadSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)
        await assertManagedTab(tabId, context, 'reload')

        if (p.waitUntil) {
            await this.runNavigationAction(tabId, p.waitUntil, p.timeout, () =>
                chrome.tabs.reload(tabId, { bypassCache: p.ignoreCache ?? false })
            )
        } else {
            await chrome.tabs.reload(tabId, { bypassCache: p.ignoreCache ?? false })
        }

        const tab = await chrome.tabs.get(tabId)
        return { url: tab.url || '', title: tab.title || '', managed: true }
    }

    async waitForNavigation(tabId: number, waitUntil: WaitUntil, timeout = 30000): Promise<void> {
        const startedAt = Date.now()
        let currentDocumentId: string | null = null

        await new Promise<void>((resolve, reject) => {
            let settled = false
            let idleSince: number | null = null
            let idleTimer: ReturnType<typeof setTimeout> | null = null
            const cleanup = () => {
                clearTimeout(timeoutId)
                if (idleTimer !== null) {
                    clearTimeout(idleTimer)
                }
                chrome.webNavigation.onCommitted.removeListener(onCommitted)
                chrome.webNavigation.onDOMContentLoaded.removeListener(onDOMContentLoaded)
                chrome.webNavigation.onCompleted.removeListener(onCompleted)
            }
            const done = () => {
                if (settled) {
                    return
                }
                settled = true
                cleanup()
                resolve()
            }
            const fail = (error: Error) => {
                if (settled) {
                    return
                }
                settled = true
                cleanup()
                reject(error)
            }
            const checkIdle = () => {
                if (settled) {
                    return
                }
                const remaining = timeout - (Date.now() - startedAt)
                if (remaining <= 0) {
                    fail(new ExpectedOperationError('Navigation timeout'))
                    return
                }
                const pending = this.logManager.getPending(tabId)
                const hasPending = pending !== undefined && pending.size > 0
                const uncertain = this.logManager.isPendingUncertain(tabId)
                if (hasPending || uncertain) {
                    idleSince = null
                } else if (idleSince === null) {
                    idleSince = Date.now()
                }
                if (!hasPending && !uncertain && idleSince !== null && Date.now() - idleSince >= 500) {
                    done()
                    return
                }
                idleTimer = setTimeout(checkIdle, Math.min(100, remaining))
            }
            const documentMatches = (details: { tabId: number; frameId: number; documentId?: string }) =>
                details.tabId === tabId &&
                details.frameId === 0 &&
                typeof details.documentId === 'string' &&
                details.documentId === currentDocumentId
            const onCommitted = (details: { tabId: number; frameId: number; documentId?: string }) => {
                if (details.tabId === tabId && details.frameId === 0 && typeof details.documentId === 'string') {
                    currentDocumentId = details.documentId
                }
            }
            const onDOMContentLoaded = (details: { tabId: number; frameId: number; documentId?: string }) => {
                if (waitUntil === 'domcontentloaded' && documentMatches(details)) {
                    done()
                }
            }
            const onCompleted = (details: { tabId: number; frameId: number; documentId?: string }) => {
                if (!documentMatches(details)) {
                    return
                }
                if (waitUntil === 'networkidle') {
                    checkIdle()
                } else {
                    done()
                }
            }
            const timeoutId = setTimeout(() => fail(new ExpectedOperationError('Navigation timeout')), timeout)

            chrome.webNavigation.onCommitted.addListener(onCommitted)
            chrome.webNavigation.onDOMContentLoaded.addListener(onDOMContentLoaded)
            chrome.webNavigation.onCompleted.addListener(onCompleted)

            void (async () => {
                try {
                    if (typeof chrome.webNavigation.getFrame === 'function') {
                        const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 })
                        if (currentDocumentId === null && typeof frame?.documentId === 'string') {
                            currentDocumentId = frame.documentId
                        }
                    }
                    const tab = await chrome.tabs.get(tabId)
                    if (tab.status === 'complete') {
                        if (waitUntil === 'networkidle') {
                            checkIdle()
                        } else {
                            done()
                        }
                    }
                } catch (error) {
                    fail(error instanceof Error ? error : new Error(String(error)))
                }
            })()
        })
    }

    private async runNavigationAction(
        tabId: number,
        waitUntil: WaitUntil,
        timeout: number | undefined,
        action: () => Promise<unknown>,
        expectedSameDocumentUrl?: string
    ): Promise<void> {
        const budget = timeout ?? 30000
        const startedAt = Date.now()
        const normalizedSameDocumentUrl = normalizeNavigationUrl(expectedSameDocumentUrl)
        let baselineDocumentId: string | null = null
        if (expectedSameDocumentUrl && typeof chrome.webNavigation.getFrame === 'function') {
            try {
                const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 })
                baselineDocumentId = typeof frame?.documentId === 'string' ? frame.documentId : null
            } catch {
                // 无法识别当前 document 时不接受同文档完成信号，避免误用旧事件
            }
        }
        let actionStarted = false
        let settled = false
        let currentDocumentId: string | null = null
        let idleSince: number | null = null
        let idleTimer: ReturnType<typeof setTimeout> | null = null
        let cancelWait: (error: Error) => void = () => {}

        const waitPromise = new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timeoutId)
                if (idleTimer !== null) {
                    clearTimeout(idleTimer)
                }
                chrome.webNavigation.onCommitted.removeListener(onCommitted)
                chrome.webNavigation.onDOMContentLoaded.removeListener(onDOMContentLoaded)
                chrome.webNavigation.onCompleted.removeListener(onCompleted)
                chrome.webNavigation.onHistoryStateUpdated.removeListener(onSameDocumentNavigation)
                chrome.webNavigation.onReferenceFragmentUpdated.removeListener(onSameDocumentNavigation)
            }
            const done = () => {
                if (settled) {
                    return
                }
                settled = true
                cleanup()
                resolve()
            }
            const fail = (error: Error) => {
                if (settled) {
                    return
                }
                settled = true
                cleanup()
                reject(error)
            }
            cancelWait = fail
            const checkIdle = () => {
                if (settled) {
                    return
                }
                const remaining = budget - (Date.now() - startedAt)
                if (remaining <= 0) {
                    fail(new ExpectedOperationError('Navigation timeout'))
                    return
                }
                const pending = this.logManager.getPending(tabId)
                const hasPending = pending !== undefined && pending.size > 0
                const uncertain = this.logManager.isPendingUncertain(tabId)
                if (hasPending || uncertain) {
                    idleSince = null
                } else if (idleSince === null) {
                    idleSince = Date.now()
                }
                if (!hasPending && !uncertain && idleSince !== null && Date.now() - idleSince >= 500) {
                    done()
                    return
                }
                idleTimer = setTimeout(checkIdle, Math.min(100, remaining))
            }
            const documentMatches = (details: { tabId: number; frameId: number; documentId?: string }) =>
                actionStarted &&
                details.tabId === tabId &&
                details.frameId === 0 &&
                typeof details.documentId === 'string' &&
                details.documentId === currentDocumentId
            const onCommitted = (details: { tabId: number; frameId: number; documentId?: string }) => {
                if (
                    actionStarted &&
                    details.tabId === tabId &&
                    details.frameId === 0 &&
                    typeof details.documentId === 'string'
                ) {
                    currentDocumentId = details.documentId
                }
            }
            const onDOMContentLoaded = (details: { tabId: number; frameId: number; documentId?: string }) => {
                if (waitUntil === 'domcontentloaded' && documentMatches(details)) {
                    done()
                }
            }
            const onCompleted = (details: { tabId: number; frameId: number; documentId?: string }) => {
                if (!documentMatches(details)) {
                    return
                }
                if (waitUntil === 'networkidle') {
                    checkIdle()
                } else if (waitUntil === 'load') {
                    done()
                }
            }
            const onSameDocumentNavigation = (details: {
                tabId: number
                frameId: number
                documentId?: string
                url?: string
            }) => {
                if (
                    !actionStarted ||
                    details.tabId !== tabId ||
                    details.frameId !== 0 ||
                    baselineDocumentId === null ||
                    details.documentId !== baselineDocumentId ||
                    normalizeNavigationUrl(details.url) !== normalizedSameDocumentUrl
                ) {
                    return
                }
                if (waitUntil === 'networkidle') {
                    checkIdle()
                } else {
                    done()
                }
            }
            const timeoutId = setTimeout(
                () => fail(new ExpectedOperationError('Navigation timeout')),
                Math.max(0, budget - (Date.now() - startedAt))
            )

            chrome.webNavigation.onCommitted.addListener(onCommitted)
            chrome.webNavigation.onDOMContentLoaded.addListener(onDOMContentLoaded)
            chrome.webNavigation.onCompleted.addListener(onCompleted)
            chrome.webNavigation.onHistoryStateUpdated.addListener(onSameDocumentNavigation)
            chrome.webNavigation.onReferenceFragmentUpdated.addListener(onSameDocumentNavigation)
        })
        waitPromise.catch(() => {})

        const remaining = () => Math.max(0, budget - (Date.now() - startedAt))
        const actionPromise = new Promise<void>((resolve, reject) => {
            const timeoutId = setTimeout(() => reject(new ExpectedOperationError('Navigation timeout')), remaining())
            actionStarted = true
            void Promise.resolve()
                .then(action)
                .then(() => resolve(), reject)
                .finally(() => clearTimeout(timeoutId))
        })
        actionPromise.catch((reason) => {
            cancelWait(reason instanceof Error ? reason : new Error(String(reason)))
        })

        const [actionResult, waitResult] = await Promise.allSettled([actionPromise, waitPromise])
        if (actionResult.status === 'rejected') {
            const error =
                actionResult.reason instanceof Error ? actionResult.reason : new Error(String(actionResult.reason))
            cancelWait(error)
            throw error
        }
        if (waitResult.status === 'rejected') {
            throw waitResult.reason
        }
    }

    private async navigateHistory(
        tabId: number,
        beforeUrl: string | undefined,
        timeout: number,
        direction: 'back' | 'forward'
    ): Promise<boolean> {
        const navigation = this.waitForNavigationSignal(tabId, beforeUrl, timeout)
        try {
            try {
                if (direction === 'back') {
                    await chrome.tabs.goBack(tabId)
                } else {
                    await chrome.tabs.goForward(tabId)
                }
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error)
                if (!/Cannot find a (?:next|previous) page in history/i.test(msg)) {
                    throw error
                }
                const tab = await chrome.tabs.get(tabId)
                if (!isRestrictedUrl(tab.url)) {
                    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 })
                    if (frame && !frame.errorOccurred) {
                        // 原生历史不可用时，仅在可注入的文档上尝试页面历史
                        await chrome.scripting
                            .executeScript({
                                target: { tabId },
                                world: 'MAIN',
                                func: (step: 'back' | 'forward') => history[step](),
                                args: [direction],
                            })
                            .catch((error: unknown) => {
                                const msg = error instanceof Error ? error.message : String(error)
                                if (/Cannot access|Frame with ID \d+ is showing error page/i.test(msg)) {
                                    throw new ExpectedOperationError(msg)
                                }
                                throw error
                            })
                    }
                }
            }
            return await navigation.promise
        } finally {
            navigation.cancel()
        }
    }

    /** 监听 history 导航和 URL 变化，取消时清理定时器与监听器 */
    private waitForNavigationSignal(
        tabId: number,
        beforeUrl: string | undefined,
        timeout: number
    ): { promise: Promise<boolean>; cancel: () => void } {
        let cancel = () => {}
        const promise = new Promise<boolean>((resolve) => {
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
            cancel = () => done(false)

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

            const tabListener = (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => {
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
        return { promise, cancel }
    }
}
