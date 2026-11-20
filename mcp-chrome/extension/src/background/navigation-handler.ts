import type { TabInfo, WaitUntil } from '../types'
import { ExpectedOperationError } from '../types/expected-errors'
import { GoBackSchema, GoForwardSchema, NavigateSchema, ReloadSchema } from '../types/schemas'
import {
    type ActionContext,
    assertActionActive,
    assertManagedTab,
    getTargetTabId,
    isRestrictedUrl,
    tabToInfo,
} from './action-utils.js'
import type { LogManager } from './log-manager.js'
import { getExistingTab } from './page-revision.js'

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

function navigationTimeout(actionExecuted: boolean): ExpectedOperationError {
    return new ExpectedOperationError(
        JSON.stringify({
            error: {
                code: 'TIMEOUT',
                message: 'Navigation timeout',
                context: { actionExecuted, actionStatus: actionExecuted ? 'unknown' : 'failed', retryable: false },
            },
        })
    )
}

export function remainingNavigationTimeout(deadline: number, actionExecuted = false): number {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
        throw navigationTimeout(actionExecuted)
    }
    return remaining
}

function navigationCancelled(actionExecuted = false): ExpectedOperationError {
    return new ExpectedOperationError(
        JSON.stringify({
            error: {
                code: 'REQUEST_CANCELLED',
                message: actionExecuted
                    ? 'Navigation cancelled after dispatch'
                    : 'Navigation cancelled before dispatch',
                context: {
                    actionExecuted: actionExecuted ? 'unknown' : false,
                    actionStatus: actionExecuted ? 'unknown' : 'not_started',
                    retryable: false,
                },
            },
        }),
        actionExecuted ? undefined : false
    )
}

function assertNavigationActive(context: ActionContext | undefined, actionExecuted = false): void {
    if (!actionExecuted) {
        assertActionActive(context)
    } else {
        if (context?.signal?.aborted) {
            throw navigationCancelled(true)
        }
        if (context?.deadline !== undefined) {
            remainingNavigationTimeout(context.deadline, true)
        }
    }
}

export class NavigationHandler {
    constructor(
        private logManager: LogManager,
        private enableNetworkObservation?: (tabId: number) => Promise<void>
    ) {}

    async navigate(params: unknown, context: ActionContext): Promise<TabInfo> {
        const p = NavigateSchema.parse(params)
        const deadline = Math.min(p.deadline ?? Date.now() + (p.timeout ?? 30000), context.deadline ?? Infinity)
        assertNavigationActive(context)
        remainingNavigationTimeout(deadline)
        const tabId = await this.waitForOperation(getTargetTabId(p.tabId), deadline, context)
        await this.waitForOperation(assertManagedTab(tabId, context, 'navigate'), deadline, context)
        if (p.waitUntil) {
            await this.runNavigationAction(
                tabId,
                p.waitUntil,
                deadline,
                () => chrome.tabs.update(tabId, { url: p.url }),
                p.url,
                context
            )
        } else {
            assertNavigationActive(context)
            remainingNavigationTimeout(deadline)
            await this.waitForOperation(chrome.tabs.update(tabId, { url: p.url }), deadline, context, true)
        }

        assertNavigationActive(context, true)
        remainingNavigationTimeout(deadline, true)
        const tab = await this.waitForOperation(getExistingTab(tabId), deadline, context, true)
        return tabToInfo(tab)
    }

    async goBack(
        params: unknown,
        context: ActionContext
    ): Promise<{ url: string; title: string; navigated: boolean; managed: boolean }> {
        const p = GoBackSchema.parse(params) ?? {}
        const deadline = Math.min(p.deadline ?? Date.now() + (p.timeout ?? 30000), context.deadline ?? Infinity)
        assertNavigationActive(context)
        remainingNavigationTimeout(deadline)
        const tabId = await this.waitForOperation(getTargetTabId(p.tabId), deadline, context)
        await this.waitForOperation(assertManagedTab(tabId, context, 'go_back'), deadline, context)
        await this.prepareNetworkIdle(tabId, p.waitUntil, deadline, context)
        const beforeTab = await this.waitForOperation(getExistingTab(tabId), deadline, context)

        // 信号窗口受剩余预算控制，上限 5s，未传 timeout 时为 2s
        const signalTimeout = Math.min(p.timeout ?? 2000, 5000, remainingNavigationTimeout(deadline))
        const navigated = await this.navigateHistory(tabId, beforeTab, signalTimeout, 'back', deadline, context)

        if (navigated && p.waitUntil) {
            await this.waitForNavigation(tabId, p.waitUntil, remainingNavigationTimeout(deadline, true), context, true)
        }

        assertNavigationActive(context, true)
        remainingNavigationTimeout(deadline, true)
        const tab = await this.waitForOperation(getExistingTab(tabId), deadline, context, true)
        return { url: tab.url || '', title: tab.title || '', navigated, managed: true }
    }

    async goForward(
        params: unknown,
        context: ActionContext
    ): Promise<{ url: string; title: string; navigated: boolean; managed: boolean }> {
        const p = GoForwardSchema.parse(params) ?? {}
        const deadline = Math.min(p.deadline ?? Date.now() + (p.timeout ?? 30000), context.deadline ?? Infinity)
        assertNavigationActive(context)
        remainingNavigationTimeout(deadline)
        const tabId = await this.waitForOperation(getTargetTabId(p.tabId), deadline, context)
        await this.waitForOperation(assertManagedTab(tabId, context, 'go_forward'), deadline, context)
        await this.prepareNetworkIdle(tabId, p.waitUntil, deadline, context)
        const beforeTab = await this.waitForOperation(getExistingTab(tabId), deadline, context)

        // 信号窗口受剩余预算控制，上限 5s，未传 timeout 时为 2s
        const signalTimeout = Math.min(p.timeout ?? 2000, 5000, remainingNavigationTimeout(deadline))
        const navigated = await this.navigateHistory(tabId, beforeTab, signalTimeout, 'forward', deadline, context)

        if (navigated && p.waitUntil) {
            await this.waitForNavigation(tabId, p.waitUntil, remainingNavigationTimeout(deadline, true), context, true)
        }

        assertNavigationActive(context, true)
        remainingNavigationTimeout(deadline, true)
        const tab = await this.waitForOperation(getExistingTab(tabId), deadline, context, true)
        return { url: tab.url || '', title: tab.title || '', navigated, managed: true }
    }

    async reload(params: unknown, context: ActionContext): Promise<{ url: string; title: string; managed: boolean }> {
        const p = ReloadSchema.parse(params) ?? {}
        const deadline = Math.min(p.deadline ?? Date.now() + (p.timeout ?? 30000), context.deadline ?? Infinity)
        assertNavigationActive(context)
        remainingNavigationTimeout(deadline)
        const tabId = await this.waitForOperation(getTargetTabId(p.tabId), deadline, context)
        await this.waitForOperation(assertManagedTab(tabId, context, 'reload'), deadline, context)

        if (p.waitUntil) {
            await this.runNavigationAction(
                tabId,
                p.waitUntil,
                deadline,
                () => chrome.tabs.reload(tabId, { bypassCache: p.ignoreCache ?? false }),
                undefined,
                context
            )
        } else {
            assertNavigationActive(context)
            remainingNavigationTimeout(deadline)
            await this.waitForOperation(
                chrome.tabs.reload(tabId, { bypassCache: p.ignoreCache ?? false }),
                deadline,
                context,
                true
            )
        }

        assertNavigationActive(context, true)
        remainingNavigationTimeout(deadline, true)
        const tab = await this.waitForOperation(getExistingTab(tabId), deadline, context, true)
        return { url: tab.url || '', title: tab.title || '', managed: true }
    }

    async waitForNavigation(
        tabId: number,
        waitUntil: WaitUntil,
        timeout = 30000,
        context?: ActionContext,
        actionExecuted = false
    ): Promise<void> {
        const deadline = Math.min(Date.now() + timeout, context?.deadline ?? Infinity)
        assertNavigationActive(context, actionExecuted)
        await this.prepareNetworkIdle(tabId, waitUntil, deadline, context, actionExecuted)
        timeout = remainingNavigationTimeout(deadline, true)
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
                context?.signal?.removeEventListener('abort', onAbort)
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
                if (idleTimer !== null) {
                    clearTimeout(idleTimer)
                    idleTimer = null
                }
                const remaining = deadline - Date.now()
                if (remaining <= 0) {
                    fail(navigationTimeout(true))
                    return
                }
                const pending = this.logManager.getPending(tabId)
                if (!this.logManager.isNetworkObserved(tabId)) {
                    fail(new ExpectedOperationError('Network 观测已中断，无法判断 networkidle'))
                    return
                }
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
            const checkCurrentDocument = async () => {
                if (settled) {
                    return
                }
                try {
                    if (typeof chrome.webNavigation.getFrame === 'function') {
                        const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 })
                        if (settled) {
                            return
                        }
                        assertNavigationActive(context, actionExecuted)
                        remainingNavigationTimeout(deadline, true)
                        if (currentDocumentId === null && typeof frame?.documentId === 'string') {
                            currentDocumentId = frame.documentId
                        }
                    }
                    const tab = await getExistingTab(tabId)
                    if (settled) {
                        return
                    }
                    assertNavigationActive(context, actionExecuted)
                    remainingNavigationTimeout(deadline, true)
                    let ready = tab.status === 'complete'
                    if (!ready && currentDocumentId === null && waitUntil === 'domcontentloaded') {
                        const results = await chrome.scripting.executeScript({
                            target: { tabId, frameIds: [0] },
                            func: () => document.readyState,
                        })
                        if (settled) {
                            return
                        }
                        assertNavigationActive(context, actionExecuted)
                        remainingNavigationTimeout(deadline, true)
                        ready = results.some(
                            ({ frameId, result }) =>
                                frameId === 0 && (result === 'interactive' || result === 'complete')
                        )
                    }
                    if (ready) {
                        if (waitUntil === 'networkidle') {
                            checkIdle()
                        } else {
                            done()
                        }
                    }
                } catch (error) {
                    fail(error instanceof Error ? error : new Error(String(error)))
                }
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
                if (waitUntil === 'domcontentloaded') {
                    onCompleted(details)
                }
            }
            const onCompleted = (details: { tabId: number; frameId: number; documentId?: string }) => {
                if (!documentMatches(details)) {
                    if (currentDocumentId === null && details.tabId === tabId && details.frameId === 0) {
                        void checkCurrentDocument()
                    }
                    return
                }
                if (waitUntil === 'networkidle') {
                    checkIdle()
                } else {
                    done()
                }
            }
            const onAbort = () => fail(navigationCancelled(actionExecuted))
            const timeoutId = setTimeout(() => fail(navigationTimeout(true)), timeout)

            chrome.webNavigation.onCommitted.addListener(onCommitted)
            chrome.webNavigation.onDOMContentLoaded.addListener(onDOMContentLoaded)
            chrome.webNavigation.onCompleted.addListener(onCompleted)
            context?.signal?.addEventListener('abort', onAbort, { once: true })
            if (context?.signal?.aborted) {
                onAbort()
            }

            void checkCurrentDocument()
        })
    }

    private async waitForOperation<T>(
        operation: Promise<T>,
        deadline: number,
        context?: ActionContext,
        actionExecuted = false
    ): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined
        let onAbort: () => void = () => {}
        const stopped = new Promise<never>((_, reject) => {
            onAbort = () => reject(navigationCancelled(actionExecuted))
            const onTimeout = () => {
                const remaining = deadline - Date.now()
                if (remaining > 0) {
                    timer = setTimeout(onTimeout, remaining)
                } else {
                    reject(navigationTimeout(actionExecuted))
                }
            }
            timer = setTimeout(onTimeout, Math.max(0, deadline - Date.now()))
            context?.signal?.addEventListener('abort', onAbort, { once: true })
            if (context?.signal?.aborted) {
                onAbort()
            }
        })
        try {
            const result = await Promise.race([operation, stopped])
            assertNavigationActive(context, actionExecuted)
            remainingNavigationTimeout(deadline, actionExecuted)
            return result
        } finally {
            clearTimeout(timer)
            context?.signal?.removeEventListener('abort', onAbort)
        }
    }

    private async prepareNetworkIdle(
        tabId: number,
        waitUntil: WaitUntil | undefined,
        deadline: number,
        context?: ActionContext,
        actionExecuted = false
    ): Promise<void> {
        assertNavigationActive(context, actionExecuted)
        remainingNavigationTimeout(deadline, actionExecuted)
        if (waitUntil === 'networkidle') {
            await this.waitForOperation(
                this.enableNetworkObservation?.(tabId) ?? Promise.resolve(),
                deadline,
                context,
                actionExecuted
            )
            if (!this.logManager.isNetworkObserved(tabId)) {
                throw new ExpectedOperationError('Network 观测未建立，无法判断 networkidle')
            }
        }
    }

    private async runNavigationAction(
        tabId: number,
        waitUntil: WaitUntil,
        deadline: number,
        action: () => Promise<unknown>,
        expectedSameDocumentUrl?: string,
        context?: ActionContext
    ): Promise<void> {
        assertNavigationActive(context)
        remainingNavigationTimeout(deadline)
        await this.prepareNetworkIdle(tabId, waitUntil, deadline, context)
        const normalizedSameDocumentUrl = normalizeNavigationUrl(expectedSameDocumentUrl)
        let baselineDocumentId: string | null = null
        if (expectedSameDocumentUrl && typeof chrome.webNavigation.getFrame === 'function') {
            try {
                const frame = await this.waitForOperation(
                    chrome.webNavigation.getFrame({ tabId, frameId: 0 }),
                    deadline,
                    context
                )
                baselineDocumentId = typeof frame?.documentId === 'string' ? frame.documentId : null
            } catch (error) {
                if (error instanceof ExpectedOperationError) {
                    throw error
                }
                assertNavigationActive(context)
                remainingNavigationTimeout(deadline)
                // 无法识别当前 document 时不接受同文档完成信号，避免误用旧事件
            }
        }
        assertNavigationActive(context)
        remainingNavigationTimeout(deadline)
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
                context?.signal?.removeEventListener('abort', onAbort)
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
                if (idleTimer !== null) {
                    clearTimeout(idleTimer)
                    idleTimer = null
                }
                const remaining = deadline - Date.now()
                if (remaining <= 0) {
                    fail(navigationTimeout(actionStarted))
                    return
                }
                const pending = this.logManager.getPending(tabId)
                if (!this.logManager.isNetworkObserved(tabId)) {
                    fail(new ExpectedOperationError('Network 观测已中断，无法判断 networkidle'))
                    return
                }
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
            const onAbort = () => fail(navigationCancelled(actionStarted))
            const timeoutId = setTimeout(
                () => fail(navigationTimeout(actionStarted)),
                remainingNavigationTimeout(deadline)
            )

            chrome.webNavigation.onCommitted.addListener(onCommitted)
            chrome.webNavigation.onDOMContentLoaded.addListener(onDOMContentLoaded)
            chrome.webNavigation.onCompleted.addListener(onCompleted)
            chrome.webNavigation.onHistoryStateUpdated.addListener(onSameDocumentNavigation)
            chrome.webNavigation.onReferenceFragmentUpdated.addListener(onSameDocumentNavigation)
            context?.signal?.addEventListener('abort', onAbort, { once: true })
            if (context?.signal?.aborted) {
                onAbort()
            }
        })
        waitPromise.catch(() => {})

        const actionPromise = Promise.resolve().then(() => {
            assertNavigationActive(context)
            remainingNavigationTimeout(deadline)
            actionStarted = true
            return this.waitForOperation(action(), deadline, context, true)
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
        beforeTab: chrome.tabs.Tab,
        timeout: number,
        direction: 'back' | 'forward',
        deadline: number,
        context?: ActionContext
    ): Promise<boolean> {
        assertNavigationActive(context)
        // 未提交的浏览器导航会忽略旧文档发起的无激活 History 请求
        const frame =
            beforeTab.pendingUrl || isRestrictedUrl(beforeTab.url)
                ? null
                : await this.waitForOperation(chrome.webNavigation.getFrame({ tabId, frameId: 0 }), deadline, context)
        const navigation = this.waitForNavigationSignal(
            tabId,
            beforeTab.url,
            Math.min(timeout, remainingNavigationTimeout(deadline)),
            context
        )
        navigation.promise.catch(() => {})
        try {
            assertNavigationActive(context)
            remainingNavigationTimeout(deadline)
            if (frame && !frame.errorOccurred) {
                const results = await this.waitForOperation(
                    chrome.scripting
                        .executeScript({
                            target: frame.documentId
                                ? { tabId, documentIds: [frame.documentId] }
                                : { tabId, frameIds: [0] },
                            world: 'ISOLATED',
                            func: (step: 'back' | 'forward') => {
                                const navigation = (
                                    window as Window & {
                                        navigation?: {
                                            canGoBack: boolean
                                            canGoForward: boolean
                                            entries?: () => unknown[]
                                        }
                                    }
                                ).navigation
                                // Navigation API 的方向标记只覆盖同源历史
                                if (
                                    history.length <= 1 ||
                                    (navigation?.entries?.().length === history.length &&
                                        navigation[step === 'back' ? 'canGoBack' : 'canGoForward'] === false)
                                ) {
                                    return false
                                }
                                // tabs.goBack/goForward 会跳过未收到用户激活的自动导航条目
                                history[step]()
                                return true
                            },
                            args: [direction],
                        })
                        .catch((error: unknown) => {
                            const msg = error instanceof Error ? error.message : String(error)
                            if (/Cannot access|Frame with ID \d+ is showing error page/i.test(msg)) {
                                throw new ExpectedOperationError(msg)
                            }
                            throw error
                        }),
                    deadline,
                    context,
                    true
                )
                if (results?.[0]?.result === false) {
                    return false
                }
            } else {
                try {
                    await this.waitForOperation(
                        direction === 'back' ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId),
                        deadline,
                        context,
                        true
                    )
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error)
                    if (/Cannot find a (?:next|previous) page in history/i.test(msg)) {
                        return false
                    }
                    throw error
                }
            }
            if (!(await this.waitForOperation(navigation.promise, deadline, context, true))) {
                throw navigationTimeout(true)
            }
            return true
        } finally {
            navigation.cancel()
        }
    }

    /** 监听 history 导航和 URL 变化，取消时清理定时器与监听器 */
    private waitForNavigationSignal(
        tabId: number,
        beforeUrl: string | undefined,
        timeout: number,
        context?: ActionContext
    ): { promise: Promise<boolean>; cancel: () => void } {
        let cancel = () => {}
        const promise = new Promise<boolean>((resolve, reject) => {
            let settled = false

            const done = (result: boolean, error?: Error) => {
                if (settled) {
                    return
                }
                settled = true
                clearTimeout(timer)
                chrome.tabs.onUpdated.removeListener(tabListener)
                chrome.webNavigation.onCommitted.removeListener(navListener)
                context?.signal?.removeEventListener('abort', onAbort)
                if (error) {
                    reject(error)
                } else {
                    resolve(result)
                }
            }
            cancel = () => done(false)
            const onAbort = () => done(false, navigationCancelled(true))

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
            context?.signal?.addEventListener('abort', onAbort, { once: true })
            if (context?.signal?.aborted) {
                onAbort()
                return
            }

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
