/**
 * Action 处理器
 *
 * 处理来自 MCP Server 的所有操作请求
 */

import type {
    ClickParams,
    ConsoleMessage,
    CookiesClearParams,
    CookiesDeleteParams,
    CookiesGetParams,
    CookiesSetParams,
    DebuggerAttachParams,
    DebuggerDetachParams,
    DebuggerSendParams,
    ElementInfo,
    EvaluateParams,
    FindParams,
    GoBackParams,
    GoForwardParams,
    KeyEventParams,
    MouseEventParams,
    NavigateParams,
    NetworkRequest,
    ReadPageParams,
    ReadPageResult,
    ReloadParams,
    ResolveFrameParams,
    ScreenshotParams,
    ScreenshotResult,
    ScrollParams,
    TabGroupAddParams,
    TabGroupCreateParams,
    TabInfo,
    TabsActivateParams,
    TabsCloseParams,
    TabsCreateParams,
    TabsListParams,
    TouchEventParams,
    TypeParams,
    WaitUntil,
} from '../types'
import {setMcpTabGroupId} from './index'

interface ActionContext {
    mcpTabGroupId: number | null
}

type ActionFunction = (params: unknown, context: ActionContext) => Promise<unknown>

export class ActionHandler {
    private actions: Map<string, ActionFunction>                                                       = new Map()
    private attachedTabs: Set<number>                                                                  = new Set()
    private consoleMessages: Map<number, ConsoleMessage[]>                                             = new Map()
    private networkRequests: Map<number, NetworkRequest[]>                                             = new Map()
    /** 按 tabId 隔离的待匹配请求（不同 tab 的 requestId 可能重复） */
    private pendingRequests: Map<number, Map<string, {
        url: string;
        method: string;
        type: string;
        timestamp: number
    }>>                                                                                                = new Map()
    /** 按 tabId 缓存的执行上下文（由 Runtime.executionContextCreated 事件填充） */
    private executionContexts: Map<number, Array<{ id: number; frameId: string; isDefault: boolean }>> = new Map()
    private pendingAttach                                                                              = new Map<number, Promise<void>>()

    constructor() {
        this.registerActions()
        this.setupDebuggerListeners()
    }

    async execute(action: string, params: unknown, context: ActionContext): Promise<unknown> {
        const handler = this.actions.get(action)
        if (!handler) {
            throw new Error(`Unknown action: ${action}`)
        }
        return handler(params, context)
    }

    // ==================== Debugger 监听器 ====================

    private registerActions() {
        // Tab 操作
        this.actions.set('tabs_list', this.tabsList.bind(this))
        this.actions.set('tabs_create', this.tabsCreate.bind(this))
        this.actions.set('tabs_close', this.tabsClose.bind(this))
        this.actions.set('tabs_activate', this.tabsActivate.bind(this))

        // 导航操作
        this.actions.set('navigate', this.navigate.bind(this))
        this.actions.set('go_back', this.goBack.bind(this))
        this.actions.set('go_forward', this.goForward.bind(this))
        this.actions.set('reload', this.reload.bind(this))

        // 页面内容
        this.actions.set('read_page', this.readPage.bind(this))
        this.actions.set('screenshot', this.screenshot.bind(this))

        // DOM 操作
        this.actions.set('click', this.click.bind(this))
        this.actions.set('type', this.type.bind(this))
        this.actions.set('scroll', this.scroll.bind(this))
        this.actions.set('evaluate', this.evaluate.bind(this))
        this.actions.set('find', this.find.bind(this))

        // 页面内容提取
        this.actions.set('get_text', this.getText.bind(this))
        this.actions.set('get_html', this.getHtml.bind(this))
        this.actions.set('get_html_with_images', this.getHtmlWithImages.bind(this))
        this.actions.set('get_attribute', this.getAttribute.bind(this))
        this.actions.set('get_metadata', this.getMetadata.bind(this))

        // Cookies
        this.actions.set('cookies_get', this.cookiesGet.bind(this))
        this.actions.set('cookies_set', this.cookiesSet.bind(this))
        this.actions.set('cookies_delete', this.cookiesDelete.bind(this))
        this.actions.set('cookies_clear', this.cookiesClear.bind(this))

        // Tab Groups
        this.actions.set('tabgroup_create', this.tabGroupCreate.bind(this))
        this.actions.set('tabgroup_add', this.tabGroupAdd.bind(this))

        // Debugger (CDP) 操作 - precise 模式
        this.actions.set('debugger_attach', this.debuggerAttach.bind(this))
        this.actions.set('debugger_detach', this.debuggerDetach.bind(this))
        this.actions.set('debugger_send', this.debuggerSend.bind(this))

        // 输入事件（通过 CDP）- precise 模式
        this.actions.set('input_key', this.inputKey.bind(this))
        this.actions.set('input_mouse', this.inputMouse.bind(this))
        this.actions.set('input_touch', this.inputTouch.bind(this))
        this.actions.set('input_type', this.inputType.bind(this))

        // 输入事件（JS 模拟）- stealth 模式
        this.actions.set('stealth_click', this.stealthClick.bind(this))
        this.actions.set('stealth_type', this.stealthType.bind(this))
        this.actions.set('stealth_key', this.stealthKey.bind(this))
        this.actions.set('stealth_mouse', this.stealthMouse.bind(this))

        // 控制台日志
        this.actions.set('console_enable', this.consoleEnable.bind(this))
        this.actions.set('console_get', this.consoleGet.bind(this))
        this.actions.set('console_clear', this.consoleClear.bind(this))

        // 网络日志
        this.actions.set('network_enable', this.networkEnable.bind(this))
        this.actions.set('network_get', this.networkGet.bind(this))
        this.actions.set('network_clear', this.networkClear.bind(this))

        // 反检测
        this.actions.set('stealth_inject', this.stealthInject.bind(this))

        // iframe 穿透
        this.actions.set('resolve_frame', this.resolveFrame.bind(this))
        this.actions.set('get_all_frames', this.getAllFrames.bind(this))
        this.actions.set('evaluate_in_frame', this.evaluateInFrame.bind(this))
    }

    // ==================== Tab 操作 ====================

    private setupDebuggerListeners() {
        // 监听 debugger 断开
        chrome.debugger.onDetach.addListener((source, reason) => {
            if (source.tabId) {
                this.attachedTabs.delete(source.tabId)
                this.consoleMessages.delete(source.tabId)
                this.networkRequests.delete(source.tabId)
                this.pendingRequests.delete(source.tabId)
                this.executionContexts.delete(source.tabId)
                console.log(`[MCP] Debugger detached from tab ${source.tabId}: ${reason}`)
            }
        })

        // 监听 debugger 事件
        chrome.debugger.onEvent.addListener((source, method, params) => {
            if (!source.tabId) {
                return
            }

            // 捕获控制台消息
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
                    text: p.args.map(arg => arg.value ?? arg.description ?? '').join(' '),
                    timestamp: p.timestamp,
                }

                if (p.stackTrace?.callFrames?.[0]) {
                    message.url        = p.stackTrace.callFrames[0].url
                    message.lineNumber = p.stackTrace.callFrames[0].lineNumber
                }

                const messages = this.consoleMessages.get(source.tabId) || []
                messages.push(message)
                // 限制消息数量
                if (messages.length > 1000) {
                    messages.shift()
                }
                this.consoleMessages.set(source.tabId, messages)
            }

            // 捕获 JS 异常
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
                    timestamp: p.timestamp,
                    url: p.exceptionDetails.url,
                    lineNumber: p.exceptionDetails.lineNumber,
                }

                const messages = this.consoleMessages.get(source.tabId) || []
                messages.push(message)
                if (messages.length > 1000) {
                    messages.shift()
                }
                this.consoleMessages.set(source.tabId, messages)
            }

            // 捕获网络请求发起
            if (method === 'Network.requestWillBeSent') {
                const p        = params as {
                    requestId: string
                    request: { url: string; method: string }
                    type: string
                    timestamp: number
                }
                let tabPending = this.pendingRequests.get(source.tabId)
                if (!tabPending) {
                    tabPending = new Map()
                    this.pendingRequests.set(source.tabId, tabPending)
                }
                tabPending.set(p.requestId, {
                    url: p.request.url,
                    method: p.request.method,
                    type: p.type,
                    timestamp: p.timestamp,
                })
            }

            // 捕获网络响应
            if (method === 'Network.responseReceived') {
                const p          = params as {
                    requestId: string
                    response: { status: number }
                    timestamp: number
                }
                const tabPending = this.pendingRequests.get(source.tabId)
                const pending    = tabPending?.get(p.requestId)
                if (pending) {
                    const requests = this.networkRequests.get(source.tabId) || []
                    requests.push({
                                      ...pending,
                                      status: p.response.status,
                                      duration: (p.timestamp - pending.timestamp) * 1000,
                                  })
                    if (requests.length > 1000) {
                        requests.shift()
                    }
                    this.networkRequests.set(source.tabId, requests)
                    tabPending!.delete(p.requestId)
                }
            }

            // 网络请求失败时清理
            if (method === 'Network.loadingFailed') {
                const p = params as { requestId: string }
                this.pendingRequests.get(source.tabId)?.delete(p.requestId)
            }

            // 捕获执行上下文创建（用于 iframe 内 precise evaluate）
            if (method === 'Runtime.executionContextCreated') {
                const p   = params as { context: { id: number; auxData?: { frameId?: string; isDefault?: boolean } } }
                const ctx = p.context
                if (ctx.auxData?.frameId) {
                    const contexts = this.executionContexts.get(source.tabId) || []
                    contexts.push({id: ctx.id, frameId: ctx.auxData.frameId, isDefault: ctx.auxData.isDefault ?? false})
                    this.executionContexts.set(source.tabId, contexts)
                }
            }

            // 子 frame 导航会销毁旧上下文：及时移除，避免命中已失效的 contextId
            if (method === 'Runtime.executionContextDestroyed') {
                const p        = params as { executionContextId: number }
                const contexts = this.executionContexts.get(source.tabId)
                if (contexts) {
                    const next = contexts.filter(c => c.id !== p.executionContextId)
                    if (next.length > 0) {
                        this.executionContexts.set(source.tabId, next)
                    } else {
                        this.executionContexts.delete(source.tabId)
                    }
                }
            }

            // 上下文清除时重置
            if (method === 'Runtime.executionContextsCleared') {
                this.executionContexts.delete(source.tabId)
            }
        })
    }

    private async tabsList(params: unknown, context: ActionContext): Promise<TabInfo[]> {
        const p                                = params as TabsListParams | undefined
        const queryInfo: chrome.tabs.QueryInfo = {}

        if (p?.windowId) {
            queryInfo.windowId = p.windowId
        }
        if (p?.active !== undefined) {
            queryInfo.active = p.active
        }

        const tabs = await chrome.tabs.query(queryInfo)

        return tabs.map(tab => ({
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
        }))
    }

    private async tabsCreate(params: unknown, context: ActionContext): Promise<TabInfo> {
        const p = params as TabsCreateParams | undefined

        const createProps: chrome.tabs.CreateProperties = {
            url: p?.url || 'about:blank',
            active: p?.active !== false,
        }

        if (p?.windowId) {
            createProps.windowId = p.windowId
        } else {
            // 未指定窗口时，使用最后激活的窗口
            const lastFocusedWindow = await chrome.windows.getLastFocused()
            if (lastFocusedWindow?.id) {
                createProps.windowId = lastFocusedWindow.id
            }
        }

        const tab = await chrome.tabs.create(createProps)

        // 加入 MCP Chrome 分组（自动创建或复用）
        let actualGroupId = tab.groupId ?? -1
        if (tab.id) {
            let groupId: number | null = p?.groupId ?? context.mcpTabGroupId
            if (groupId !== null && groupId !== undefined) {
                try {
                    await chrome.tabs.group({tabIds: [tab.id], groupId})
                    actualGroupId = groupId
                } catch {
                    // 分组可能已被删除，重新创建
                    groupId = null
                }
            }
            if (groupId === null || groupId === undefined) {
                const newGroupId = await chrome.tabs.group({tabIds: [tab.id]})
                await chrome.tabGroups.update(newGroupId, {title: 'MCP Chrome', color: 'cyan'})
                setMcpTabGroupId(newGroupId)
                actualGroupId = newGroupId
            }
        }

        // 等待页面加载
        if (p?.waitUntil && tab.id) {
            await this.waitForNavigation(tab.id, p.waitUntil, p.timeout)
        }

        return {
            id: tab.id!,
            url: tab.url || '',
            title: tab.title || '',
            active: tab.active,
            windowId: tab.windowId,
            index: tab.index,
            groupId: actualGroupId,
            pinned: tab.pinned,
            incognito: tab.incognito,
            managed: true,  // 新创建的 tab 自动加入 MCP Chrome 分组
            status: tab.status || 'unknown',
        }
    }

    private async tabsClose(params: unknown): Promise<{ success: boolean }> {
        const p = params as TabsCloseParams
        if (!p?.tabId) {
            throw new Error('tabId is required')
        }

        await chrome.tabs.remove(p.tabId)
        return {success: true}
    }

    // ==================== 导航操作 ====================

    private async tabsActivate(params: unknown, context: ActionContext): Promise<TabInfo> {
        const p = params as TabsActivateParams
        if (!p?.tabId) {
            throw new Error('tabId is required')
        }

        const tab = await chrome.tabs.update(p.tabId, {active: true})

        // 聚焦窗口
        if (tab.windowId) {
            await chrome.windows.update(tab.windowId, {focused: true})
        }

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

    private async navigate(params: unknown, context: ActionContext): Promise<TabInfo> {
        const p = params as NavigateParams
        if (!p?.url) {
            throw new Error('url is required')
        }

        const tabId = await this.getTargetTabId(p.tabId)
        await chrome.tabs.update(tabId, {url: p.url})

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

    private async goBack(params: unknown): Promise<{ url: string; title: string; navigated: boolean }> {
        const p         = params as GoBackParams | undefined
        const tabId     = await this.getTargetTabId(p?.tabId)
        const beforeTab = await chrome.tabs.get(tabId)
        const beforeUrl = beforeTab.url

        // 信号窗口：受 p.timeout 控制（上限 5s），默认 2s
        const signalTimeout     = Math.min(p?.timeout ?? 2000, 5000)
        // 先注册事件监听，再触发导航，避免错过瞬间完成的导航
        const navigationPromise = this.waitForNavigationSignal(tabId, beforeUrl, signalTimeout)
        await chrome.tabs.goBack(tabId)
        const navigated = await navigationPromise

        if (navigated && p?.waitUntil) {
            await this.waitForNavigation(tabId, p.waitUntil, p.timeout)
        }

        const tab = await chrome.tabs.get(tabId)
        return {url: tab.url || '', title: tab.title || '', navigated}
    }

    private async goForward(params: unknown): Promise<{ url: string; title: string; navigated: boolean }> {
        const p         = params as GoForwardParams | undefined
        const tabId     = await this.getTargetTabId(p?.tabId)
        const beforeTab = await chrome.tabs.get(tabId)
        const beforeUrl = beforeTab.url

        // 信号窗口：受 p.timeout 控制（上限 5s），默认 2s
        const signalTimeout     = Math.min(p?.timeout ?? 2000, 5000)
        // 先注册事件监听，再触发导航，避免错过瞬间完成的导航
        const navigationPromise = this.waitForNavigationSignal(tabId, beforeUrl, signalTimeout)
        await chrome.tabs.goForward(tabId)
        const navigated = await navigationPromise

        if (navigated && p?.waitUntil) {
            await this.waitForNavigation(tabId, p.waitUntil, p.timeout)
        }

        const tab = await chrome.tabs.get(tabId)
        return {url: tab.url || '', title: tab.title || '', navigated}
    }

    /**
     * 事件驱动检测导航信号（用于 back/forward 导航判定）
     *
     * 三重信号源：
     * 1. chrome.webNavigation.onCommitted + forward_back qualifier — 精确匹配 back/forward 导航
     * 2. chrome.tabs.onUpdated URL 变化 — 常见场景
     * 3. chrome.tabs.onUpdated status=loading — 覆盖同 URL 历史条目
     *
     * 同时立即检查一次（处理导航在 listener 注册前已完成的情况）。
     */
    private waitForNavigationSignal(tabId: number, beforeUrl: string | undefined, timeout: number): Promise<boolean> {
        return new Promise<boolean>(resolve => {
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
                if (details.tabId === tabId && details.frameId === 0 &&
                    details.transitionQualifiers?.includes('forward_back')) {
                    done(true)
                }
            }

            const tabListener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
                if (updatedTabId !== tabId) {
                    return
                }
                if (changeInfo.url && changeInfo.url !== beforeUrl) {
                    done(true)
                    return
                }
                if (changeInfo.status === 'loading') {
                    done(true)
                }
            }

            chrome.webNavigation.onCommitted.addListener(navListener)
            chrome.tabs.onUpdated.addListener(tabListener)

            // 立即检查一次，处理导航在 addListener 前已完成的竞态
            chrome.tabs.get(tabId).then(tab => {
                if (tab.url !== beforeUrl) {
                    done(true)
                }
            }).catch(() => {
                done(false)
            })
        })
    }

    // ==================== 页面内容 ====================

    private async reload(params: unknown): Promise<{ url: string; title: string }> {
        const p     = params as ReloadParams | undefined
        const tabId = await this.getTargetTabId(p?.tabId)

        await chrome.tabs.reload(tabId, {bypassCache: p?.ignoreCache ?? false})

        if (p?.waitUntil) {
            await this.waitForNavigation(tabId, p.waitUntil, p.timeout)
        }

        const tab = await chrome.tabs.get(tabId)
        return {url: tab.url || '', title: tab.title || ''}
    }

    private async readPage(params: unknown): Promise<ReadPageResult> {
        const p     = params as ReadPageParams | undefined
        const tabId = await this.getTargetTabId(p?.tabId)

        const results = await chrome.scripting.executeScript({
                                                                 target: {
                                                                     tabId,
                                                                     frameIds: [
                                                                         (p as { frameId?: number })?.frameId ??
                                                                         0,
                                                                     ],
                                                                 },
                                                                 func: generateAccessibilityTree,
                                                                 args: [
                                                                     p?.filter || 'all',
                                                                     p?.depth ?? 15,
                                                                     p?.maxLength ?? null,
                                                                     p?.refId ?? null,
                                                                 ],
                                                             })

        if (!results || results.length === 0) {
            throw new Error('Failed to read page')
        }

        return results[0].result as ReadPageResult
    }

    // ==================== DOM 操作 ====================

    private async screenshot(params: unknown): Promise<ScreenshotResult> {
        const p     = params as ScreenshotParams | undefined
        const tabId = await this.getTargetTabId(p?.tabId)

        // 使用 debugger API 截图（不需要 tab 在前台）
        await this.ensureDebuggerAttached(tabId)

        if (p?.fullPage) {
            // 获取页面完整尺寸
            const {result: sizeResult} = await chrome.debugger.sendCommand({tabId}, 'Runtime.evaluate', {
                expression: 'JSON.stringify({width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight})',
                returnByValue: true,
            }) as { result: { value: string } }
            const {width, height}      = JSON.parse(sizeResult.value)

            // 临时设置视口为页面完整尺寸
            await chrome.debugger.sendCommand({tabId}, 'Emulation.setDeviceMetricsOverride', {
                width, height, deviceScaleFactor: p?.scale ?? 1, mobile: false,
            })

            try {
                const effectiveFormat = p?.format || 'png'
                const result = await chrome.debugger.sendCommand({tabId}, 'Page.captureScreenshot', {
                    format: effectiveFormat,
                    ...(p?.quality !== undefined && effectiveFormat !== 'png' ? {quality: p.quality} : {}),
                }) as { data: string }
                return {data: result.data, format: effectiveFormat}
            } finally {
                await chrome.debugger.sendCommand({tabId}, 'Emulation.clearDeviceMetricsOverride')
            }
        }

        const effectiveFormat = p?.format || 'png'
        const result = await chrome.debugger.sendCommand({tabId}, 'Page.captureScreenshot', {
            format: effectiveFormat,
            ...(p?.quality !== undefined && effectiveFormat !== 'png' ? {quality: p.quality} : {}),
            ...(p?.clip ? {clip: {...p.clip, scale: p?.scale ?? 1}} : {}),
        }) as { data: string }

        return {
            data: result.data,
            format: p?.format || 'png',
        }
    }

    private async click(params: unknown): Promise<{ success: boolean }> {
        const p = params as ClickParams
        if (!p?.refId) {
            throw new Error('refId is required')
        }

        const tabId = await this.getTargetTabId(p.tabId)

        const results = await chrome.scripting.executeScript({
                                                                 target: {
                                                                     tabId,
                                                                     frameIds: [
                                                                         (p as { frameId?: number })?.frameId ??
                                                                         0,
                                                                     ],
                                                                 },
                                                                 func: performClick,
                                                                 args: [p.refId],
                                                             })

        return results[0].result as { success: boolean }
    }

    private async type(params: unknown): Promise<{ success: boolean }> {
        const p = params as TypeParams
        if (!p?.refId) {
            throw new Error('refId is required')
        }
        if (p.text === undefined) {
            throw new Error('text is required')
        }

        const tabId = await this.getTargetTabId(p.tabId)

        const results = await chrome.scripting.executeScript({
                                                                 target: {
                                                                     tabId,
                                                                     frameIds: [
                                                                         (p as { frameId?: number })?.frameId ??
                                                                         0,
                                                                     ],
                                                                 },
                                                                 func: performType,
                                                                 args: [p.refId, p.text, p.clear ?? false],
                                                             })

        return results[0].result as { success: boolean }
    }

    private async scroll(params: unknown): Promise<{ success: boolean; scrollX: number; scrollY: number }> {
        const p     = params as ScrollParams | undefined
        const tabId = await this.getTargetTabId(p?.tabId)

        const results = await chrome.scripting.executeScript({
                                                                 target: {
                                                                     tabId,
                                                                     frameIds: [
                                                                         (p as { frameId?: number })?.frameId ??
                                                                         0,
                                                                     ],
                                                                 },
                                                                 func: performScroll,
                                                                 args: [p?.x || 0, p?.y || 0, p?.refId ?? null],
                                                             })

        return results[0].result as { success: boolean; scrollX: number; scrollY: number }
    }

    private async evaluate(params: unknown): Promise<{ success: boolean; result?: string; error?: string }> {
        const p = params as EvaluateParams
        if (!p?.code) {
            throw new Error('code is required')
        }

        const tabId = await this.getTargetTabId(p.tabId)

        const results = await chrome.scripting.executeScript({
                                                                 target: {
                                                                     tabId,
                                                                     frameIds: [
                                                                         (p as { frameId?: number })?.frameId ??
                                                                         0,
                                                                     ],
                                                                 },
                                                                 func: executeCode,
                                                                 args: [p.code],
                                                             })

        return results[0].result as { success: boolean; result?: string; error?: string }
    }

    private async find(params: unknown): Promise<ElementInfo[]> {
        const p       = params as FindParams | undefined
        const tabId   = await this.getTargetTabId(p?.tabId)
        const frameId = (p as { frameId?: number })?.frameId ?? 0

        const results = await chrome.scripting.executeScript({
                                                                 target: {tabId, frameIds: [frameId]},
                                                                 func: findElements,
                                                                 args: [
                                                                     p?.selector ?? null,
                                                                     p?.text ?? null,
                                                                     p?.xpath ?? null,
                                                                 ],
                                                             })

        let elements = results[0].result as ElementInfo[]

        // iframe 坐标修正：将 iframe 内相对坐标转为页面绝对坐标
        if (frameId !== 0 && elements.length > 0) {
            const offset = await this.getFrameOffset(tabId, frameId)
            if (offset) {
                elements = elements.map(el => ({
                    ...el,
                    rect: {
                        x: el.rect.x + offset.x,
                        y: el.rect.y + offset.y,
                        width: el.rect.width,
                        height: el.rect.height,
                    },
                }))
            }
        }

        return elements
    }

    // ==================== 页面内容提取 ====================

    /**
     * 获取 iframe 在主页面中的偏移量
     *
     * 通过 frameId 反查 iframe URL，在主框架中定位 iframe 元素获取位置。
     * 当多个 iframe 共享同一 URL 时，优先按同 URL 的出现顺序匹配，避免取到第一个错误 iframe。
     * clientLeft/clientTop 补偿 iframe 的 border，确保坐标指向内容区域起点。
     */
    private async getFrameOffset(tabId: number, frameId: number): Promise<{ x: number; y: number } | null> {
        const allFrames = await chrome.webNavigation.getAllFrames({tabId})
        if (!allFrames) {
            return null
        }

        const childFrames = allFrames.filter(f => f.parentFrameId === 0 && f.frameId !== 0)
        const frameIndex  = childFrames.findIndex(f => f.frameId === frameId)
        if (frameIndex < 0) {
            return null
        }

        const targetFrame   = childFrames[frameIndex]
        const sameUrlFrames = childFrames.filter(f => f.url === targetFrame.url)
        const sameUrlIndex  = sameUrlFrames.findIndex(f => f.frameId === frameId)

        const results = await chrome.scripting.executeScript({
                                                                 target: {tabId, frameIds: [0]},
                                                                 func: (
                                                                     frameUrl: string,
                                                                     frameIndex: number,
                                                                     sameUrlIndex: number,
                                                                 ) => {
                                                                     const iframes = Array.from(document.querySelectorAll(
                                                                         'iframe, frame')) as HTMLIFrameElement[]

                                                                     const urlMatches = frameUrl ?
                                                                                        iframes.filter(iframe => iframe.src ===
                                                                                                                 frameUrl) :
                                                                         []
                                                                     let target: HTMLIFrameElement | undefined

                                                                     if (urlMatches.length === 1) {
                                                                         target = urlMatches[0]
                                                                     } else if (sameUrlIndex >=
                                                                                0 &&
                                                                                sameUrlIndex <
                                                                                urlMatches.length) {
                                                                         target = urlMatches[sameUrlIndex]
                                                                     } else if (frameIndex >=
                                                                                0 &&
                                                                                frameIndex <
                                                                                iframes.length) {
                                                                         target = iframes[frameIndex]
                                                                     } else if (urlMatches.length > 0) {
                                                                         target = urlMatches[0]
                                                                     }

                                                                     if (!target) {
                                                                         return null
                                                                     }
                                                                     const rect = target.getBoundingClientRect()
                                                                     return {
                                                                         x: rect.x + target.clientLeft,
                                                                         y: rect.y + target.clientTop,
                                                                     }
                                                                 },
                                                                 args: [targetFrame.url, frameIndex, sameUrlIndex],
                                                             })

        return results[0]?.result as { x: number; y: number } | null
    }

    private async getText(params: unknown): Promise<{ text: string }> {
        const p     = params as { tabId?: number; selector?: string }
        const tabId = await this.getTargetTabId(p?.tabId)

        const results = await chrome.scripting.executeScript({
                                                                 target: {
                                                                     tabId,
                                                                     frameIds: [
                                                                         (p as { frameId?: number })?.frameId ??
                                                                         0,
                                                                     ],
                                                                 },
                                                                 func: extractText,
                                                                 args: [p?.selector ?? null],
                                                             })

        return results[0].result as { text: string }
    }

    private async getHtml(params: unknown): Promise<{ html: string }> {
        const p     = params as { tabId?: number; selector?: string; outer?: boolean }
        const tabId = await this.getTargetTabId(p?.tabId)

        const results = await chrome.scripting.executeScript({
                                                                 target: {
                                                                     tabId,
                                                                     frameIds: [
                                                                         (p as { frameId?: number })?.frameId ??
                                                                         0,
                                                                     ],
                                                                 },
                                                                 func: extractHtml,
                                                                 args: [p?.selector ?? null, p?.outer ?? true],
                                                             })

        return results[0].result as { html: string }
    }

    private async getHtmlWithImages(params: unknown): Promise<{
        html: string
        images: Array<{
            index: number;
            src: string;
            dataSrc: string;
            alt: string;
            width: number;
            height: number;
            naturalWidth: number;
            naturalHeight: number
        }>
    }> {
        const p     = params as { tabId?: number; selector?: string; outer?: boolean }
        const tabId = await this.getTargetTabId(p?.tabId)

        const results = await chrome.scripting.executeScript({
                                                                 target: {
                                                                     tabId,
                                                                     frameIds: [
                                                                         (p as { frameId?: number })?.frameId ??
                                                                         0,
                                                                     ],
                                                                 },
                                                                 func: extractHtmlWithImages,
                                                                 args: [p?.selector ?? null, p?.outer ?? true],
                                                             })

        return results[0].result as {
            html: string
            images: Array<{
                index: number;
                src: string;
                dataSrc: string;
                alt: string;
                width: number;
                height: number;
                naturalWidth: number;
                naturalHeight: number
            }>
        }
    }

    // ==================== Cookies ====================

    private async getAttribute(params: unknown): Promise<{ value: string | null }> {
        const p = params as { tabId?: number; selector?: string; refId?: string; attribute: string }
        if (!p?.attribute) {
            throw new Error('attribute is required')
        }

        const tabId = await this.getTargetTabId(p?.tabId)

        const results = await chrome.scripting.executeScript({
                                                                 target: {
                                                                     tabId,
                                                                     frameIds: [
                                                                         (p as { frameId?: number })?.frameId ??
                                                                         0,
                                                                     ],
                                                                 },
                                                                 func: extractAttribute,
                                                                 args: [
                                                                     p.selector ?? null,
                                                                     p.refId ?? null,
                                                                     p.attribute,
                                                                 ],
                                                             })

        return results[0].result as { value: string | null }
    }

    private async getMetadata(params: unknown): Promise<Record<string, unknown>> {
        const p     = params as { tabId?: number }
        const tabId = await this.getTargetTabId(p?.tabId)

        const results = await chrome.scripting.executeScript({
                                                                 target: {
                                                                     tabId,
                                                                     frameIds: [
                                                                         (p as { frameId?: number })?.frameId ??
                                                                         0,
                                                                     ],
                                                                 },
                                                                 func: extractMetadata,
                                                             })

        return results[0].result as Record<string, unknown>
    }

    private async cookiesGet(params: unknown): Promise<chrome.cookies.Cookie[]> {
        const p = params as CookiesGetParams

        // 构建过滤条件
        const filter: chrome.cookies.GetAllDetails = {}
        if (p?.url) {
            filter.url = p.url
        }
        if (p?.name) {
            filter.name = p.name
        }
        if (p?.domain) {
            filter.domain = p.domain
        }
        if (p?.path) {
            filter.path = p.path
        }
        if (p?.secure !== undefined) {
            filter.secure = p.secure
        }
        if (p?.session !== undefined) {
            filter.session = p.session
        }

        return await chrome.cookies.getAll(filter)
    }

    private async cookiesSet(params: unknown): Promise<{ success: boolean }> {
        const p = params as CookiesSetParams
        if (!p?.url || !p?.name) {
            throw new Error('url and name are required')
        }

        await chrome.cookies.set({
                                     url: p.url,
                                     name: p.name,
                                     value: p.value || '',
                                     domain: p.domain,
                                     path: p.path,
                                     secure: p.secure,
                                     httpOnly: p.httpOnly,
                                     sameSite: p.sameSite,
                                     expirationDate: p.expirationDate,
                                 })

        return {success: true}
    }

    private async cookiesDelete(params: unknown): Promise<{ success: boolean }> {
        const p = params as CookiesDeleteParams
        if (!p?.url || !p?.name) {
            throw new Error('url and name are required')
        }

        await chrome.cookies.remove({
                                        url: p.url,
                                        name: p.name,
                                    })

        return {success: true}
    }

    // ==================== Tab Groups ====================

    private async cookiesClear(params: unknown): Promise<{ success: boolean; count: number }> {
        const p = params as CookiesClearParams

        // 构建过滤条件
        const filter: chrome.cookies.GetAllDetails = {}
        if (p?.url) {
            filter.url = p.url
        }
        if (p?.domain) {
            filter.domain = p.domain
        }

        const cookies = await chrome.cookies.getAll(filter)
        let count     = 0

        for (const cookie of cookies) {
            const protocol = cookie.secure ? 'https:' : 'http:'
            // cookie.domain 可能有前导点（如 .example.com），需要去掉以构建有效 URL
            const domain   = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
            const url      = `${protocol}//${domain}${cookie.path}`
            try {
                await chrome.cookies.remove({url, name: cookie.name})
                count++
            } catch {
                // 忽略删除失败的 cookie
            }
        }

        return {success: true, count}
    }

    private async tabGroupCreate(params: unknown): Promise<{ groupId: number; title: string; color: string }> {
        const p = params as TabGroupCreateParams
        if (!p?.tabIds?.length) {
            throw new Error('At least one tabId is required')
        }

        const groupId = await chrome.tabs.group({tabIds: p.tabIds})
        const title   = p.title || 'MCP Chrome'
        const color   = p.color || 'cyan'

        await chrome.tabGroups.update(groupId, {title, color})

        return {groupId, title, color}
    }

    // ==================== Debugger (CDP) 操作 ====================

    private async tabGroupAdd(params: unknown, context: ActionContext): Promise<{ success: boolean; groupId: number }> {
        const p = params as TabGroupAddParams
        if (!p?.tabId) {
            throw new Error('tabId is required')
        }

        const groupId = p.groupId ?? context.mcpTabGroupId
        if (groupId === null || groupId === undefined) {
            throw new Error('No tab group available')
        }

        await chrome.tabs.group({tabIds: [p.tabId], groupId})

        return {success: true, groupId}
    }

    private async debuggerAttach(params: unknown): Promise<{ success: boolean; tabId: number }> {
        const p     = params as DebuggerAttachParams | undefined
        const tabId = await this.getTargetTabId(p?.tabId)
        await this.ensureDebuggerAttached(tabId)
        return {success: true, tabId}
    }

    private async debuggerDetach(params: unknown): Promise<{ success: boolean }> {
        const p     = params as DebuggerDetachParams | undefined
        const tabId = await this.getTargetTabId(p?.tabId)

        if (!this.attachedTabs.has(tabId)) {
            return {success: true}
        }

        await chrome.debugger.detach({tabId})
        this.attachedTabs.delete(tabId)
        this.consoleMessages.delete(tabId)
        this.networkRequests.delete(tabId)
        this.pendingRequests.delete(tabId)

        return {success: true}
    }

    // ==================== 输入事件（通过 CDP）====================

    private async debuggerSend(params: unknown): Promise<unknown> {
        const p = params as DebuggerSendParams
        if (!p?.method) {
            throw new Error('method is required')
        }

        const tabId = await this.getTargetTabId(p.tabId)
        await this.ensureDebuggerAttached(tabId)

        return await chrome.debugger.sendCommand({tabId}, p.method, p.params)
    }

    private async inputKey(params: unknown): Promise<{ success: boolean }> {
        const p = params as KeyEventParams
        if (!p?.type) {
            throw new Error('type is required')
        }

        const tabId = await this.getTargetTabId(p.tabId)
        await this.ensureDebuggerAttached(tabId)

        const cdpParams: Record<string, unknown> = {
            type: p.type,
        }

        if (p.key) {
            cdpParams.key = p.key
        }
        if (p.code) {
            cdpParams.code = p.code
        }
        if (p.text) {
            cdpParams.text = p.text
        }
        if (p.windowsVirtualKeyCode !== undefined) {
            cdpParams.windowsVirtualKeyCode = p.windowsVirtualKeyCode
        }
        if (p.nativeVirtualKeyCode !== undefined) {
            cdpParams.nativeVirtualKeyCode = p.nativeVirtualKeyCode
        }
        if (p.modifiers !== undefined) {
            cdpParams.modifiers = p.modifiers
        }

        await chrome.debugger.sendCommand({tabId}, 'Input.dispatchKeyEvent', cdpParams)

        return {success: true}
    }

    private async inputMouse(params: unknown): Promise<{ success: boolean }> {
        const p = params as MouseEventParams
        if (!p?.type || p.x === undefined || p.y === undefined) {
            throw new Error('type, x, y are required')
        }

        const tabId = await this.getTargetTabId(p.tabId)
        await this.ensureDebuggerAttached(tabId)

        const cdpParams: Record<string, unknown> = {
            type: p.type,
            x: p.x,
            y: p.y,
        }

        if (p.button && p.button !== 'none') {
            cdpParams.button = p.button
        }
        if (p.clickCount !== undefined) {
            cdpParams.clickCount = p.clickCount
        }
        if (p.deltaX !== undefined) {
            cdpParams.deltaX = p.deltaX
        }
        if (p.deltaY !== undefined) {
            cdpParams.deltaY = p.deltaY
        }
        if (p.modifiers !== undefined) {
            cdpParams.modifiers = p.modifiers
        }

        await chrome.debugger.sendCommand({tabId}, 'Input.dispatchMouseEvent', cdpParams)

        return {success: true}
    }

    private async inputTouch(params: unknown): Promise<{ success: boolean }> {
        const p = params as TouchEventParams
        if (!p?.type || !p?.touchPoints) {
            throw new Error('type and touchPoints are required')
        }

        const tabId = await this.getTargetTabId(p.tabId)
        await this.ensureDebuggerAttached(tabId)

        const cdpParams: Record<string, unknown> = {
            type: p.type,
            touchPoints: p.touchPoints,
        }

        if (p.modifiers !== undefined) {
            cdpParams.modifiers = p.modifiers
        }

        await chrome.debugger.sendCommand({tabId}, 'Input.dispatchTouchEvent', cdpParams)

        return {success: true}
    }

    // ==================== 控制台日志 ====================

    private async inputType(params: unknown): Promise<{ success: boolean }> {
        const p = params as { tabId?: number; text: string; delay?: number }
        if (!p?.text) {
            throw new Error('text is required')
        }

        const tabId = await this.getTargetTabId(p.tabId)
        await this.ensureDebuggerAttached(tabId)

        const delay = p.delay ?? 0

        for (const char of p.text) {
            // 发送 char 事件
            await chrome.debugger.sendCommand({tabId}, 'Input.dispatchKeyEvent', {
                type: 'char',
                text: char,
            })

            if (delay > 0) {
                await new Promise(r => setTimeout(r, delay))
            }
        }

        return {success: true}
    }

    private async consoleEnable(params: unknown): Promise<{ success: boolean }> {
        const p     = params as { tabId?: number }
        const tabId = await this.getTargetTabId(p?.tabId)
        await this.ensureDebuggerAttached(tabId)

        // 启用 Runtime 域以接收控制台消息
        await chrome.debugger.sendCommand({tabId}, 'Runtime.enable', {})

        // 初始化消息存储
        if (!this.consoleMessages.has(tabId)) {
            this.consoleMessages.set(tabId, [])
        }

        return {success: true}
    }

    private async consoleGet(params: unknown): Promise<{ messages: ConsoleMessage[] }> {
        const p     = params as { tabId?: number; level?: string; pattern?: string; clear?: boolean }
        const tabId = await this.getTargetTabId(p?.tabId)

        let messages = this.consoleMessages.get(tabId) || []

        // 按级别过滤
        if (p?.level) {
            messages = messages.filter(m => m.level === p.level)
        }

        // 按正则过滤
        if (p?.pattern) {
            const regex = new RegExp(p.pattern, 'i')
            messages    = messages.filter(m => regex.test(m.text))
        }

        // 清除已读消息
        if (p?.clear) {
            this.consoleMessages.set(tabId, [])
        }

        return {messages}
    }

    // ==================== 网络日志 ====================

    private async consoleClear(params: unknown): Promise<{ success: boolean }> {
        const p     = params as { tabId?: number }
        const tabId = await this.getTargetTabId(p?.tabId)

        this.consoleMessages.set(tabId, [])

        return {success: true}
    }

    private async networkEnable(params: unknown): Promise<{ success: boolean }> {
        const p     = params as { tabId?: number }
        const tabId = await this.getTargetTabId(p?.tabId)
        await this.ensureDebuggerAttached(tabId)

        // 启用 Network 域以接收网络事件
        await chrome.debugger.sendCommand({tabId}, 'Network.enable', {})

        if (!this.networkRequests.has(tabId)) {
            this.networkRequests.set(tabId, [])
        }

        return {success: true}
    }

    private async networkGet(params: unknown): Promise<{ requests: NetworkRequest[] }> {
        const p     = params as { tabId?: number; urlPattern?: string; clear?: boolean }
        const tabId = await this.getTargetTabId(p?.tabId)

        let requests = this.networkRequests.get(tabId) || []

        // 按 URL 模式过滤
        if (p?.urlPattern) {
            const regex = new RegExp(p.urlPattern.replace(/\*/g, '.*'), 'i')
            requests    = requests.filter(r => regex.test(r.url))
        }

        if (p?.clear) {
            this.networkRequests.set(tabId, [])
        }

        return {requests}
    }

    // ==================== Debugger 辅助方法 ====================

    private async networkClear(params: unknown): Promise<{ success: boolean }> {
        const p     = params as { tabId?: number }
        const tabId = await this.getTargetTabId(p?.tabId)

        this.networkRequests.set(tabId, [])

        return {success: true}
    }

    /**
     * 确保 debugger 已附加到指定 tab
     *
     * 并发去重：多个并发请求对同一 tabId 调用时，只执行一次 attach，
     * 其余请求等待同一个 Promise 完成。
     */
    private async ensureDebuggerAttached(tabId: number): Promise<void> {
        if (this.attachedTabs.has(tabId)) {
            return
        }

        // 已有正在进行的 attach，等待它完成
        const pending = this.pendingAttach.get(tabId)
        if (pending) {
            await pending
            return
        }

        const attachPromise = chrome.debugger.attach({tabId}, '1.3').then(() => {
            this.attachedTabs.add(tabId)
        })

        this.pendingAttach.set(tabId, attachPromise)
        try {
            await attachPromise
        } finally {
            this.pendingAttach.delete(tabId)
        }
    }

    // ==================== Stealth 模式（JS 事件模拟）====================

    private async stealthClick(params: unknown): Promise<{ success: boolean }> {
        const p = params as { tabId?: number; x: number; y: number; button?: string }
        if (p.x === undefined || p.y === undefined) {
            throw new Error('x, y are required')
        }

        const tabId = await this.getTargetTabId(p?.tabId)

        const results = await chrome.scripting.executeScript({
                                                                 target: {
                                                                     tabId,
                                                                     frameIds: [
                                                                         (p as { frameId?: number })?.frameId ??
                                                                         0,
                                                                     ],
                                                                 },
                                                                 func: simulateMouseClick,
                                                                 args: [p.x, p.y, p.button || 'left'],
                                                             })

        return results[0].result as { success: boolean }
    }

    private async stealthType(params: unknown): Promise<{ success: boolean }> {
        const p = params as { tabId?: number; text: string; delay?: number }
        if (!p?.text) {
            throw new Error('text is required')
        }

        const tabId = await this.getTargetTabId(p?.tabId)

        const results = await chrome.scripting.executeScript({
                                                                 target: {
                                                                     tabId,
                                                                     frameIds: [
                                                                         (p as { frameId?: number })?.frameId ??
                                                                         0,
                                                                     ],
                                                                 },
                                                                 func: simulateKeyboardType,
                                                                 args: [p.text, p.delay || 0],
                                                             })

        return results[0].result as { success: boolean }
    }

    private async stealthKey(params: unknown): Promise<{ success: boolean }> {
        const p = params as { tabId?: number; key: string; type: 'down' | 'up' | 'press'; modifiers?: string[] }
        if (!p?.key) {
            throw new Error('key is required')
        }

        const tabId = await this.getTargetTabId(p?.tabId)

        const results = await chrome.scripting.executeScript({
                                                                 target: {
                                                                     tabId,
                                                                     frameIds: [
                                                                         (p as { frameId?: number })?.frameId ??
                                                                         0,
                                                                     ],
                                                                 },
                                                                 func: simulateKeyEvent,
                                                                 args: [p.key, p.type || 'press', p.modifiers || []],
                                                             })

        return results[0].result as { success: boolean }
    }

    private async stealthMouse(params: unknown): Promise<{ success: boolean }> {
        const p = params as { tabId?: number; type: string; x: number; y: number; button?: string }
        if (!p?.type || p.x === undefined || p.y === undefined) {
            throw new Error('type, x, y are required')
        }

        const tabId = await this.getTargetTabId(p?.tabId)

        const results = await chrome.scripting.executeScript({
                                                                 target: {
                                                                     tabId,
                                                                     frameIds: [
                                                                         (p as { frameId?: number })?.frameId ??
                                                                         0,
                                                                     ],
                                                                 },
                                                                 func: simulateMouseEvent,
                                                                 args: [p.type, p.x, p.y, p.button || 'left'],
                                                             })

        return results[0].result as { success: boolean }
    }

    private async stealthInject(params: unknown): Promise<{ success: boolean }> {
        const p     = params as { tabId?: number }
        const tabId = await this.getTargetTabId(p?.tabId)

        await chrome.scripting.executeScript({
                                                 target: {tabId, frameIds: [(p as { frameId?: number })?.frameId ?? 0]},
                                                 func: injectStealthScripts,
                                                 world: 'MAIN',  // 注入到主世界，覆盖原生属性
                                             })

        return {success: true}
    }

    // ==================== iframe 穿透 ====================

    /**
     * 解析 iframe 选择器/索引 → Chrome frameId
     *
     * 策略：
     * 1. 在主框架中找到 iframe 元素，获取其绝对 src URL 和 DOM 索引
     * 2. 通过 chrome.webNavigation.getAllFrames 获取所有子框架
     * 3. 先尝试 URL 精确匹配，再按 DOM 索引匹配
     */
    private async resolveFrame(params: unknown): Promise<{ frameId: number; offset: { x: number; y: number } | null }> {
        const p = params as ResolveFrameParams
        if (p.frame === undefined) {
            throw new Error('frame is required')
        }

        const tabId = await this.getTargetTabId(p.tabId)

        // 获取所有 frames
        const allFrames = await chrome.webNavigation.getAllFrames({tabId})
        if (!allFrames) {
            throw new Error('Failed to get frames')
        }

        // 主框架的直接子 iframe
        const childFrames = allFrames.filter(f => f.parentFrameId === 0 && f.frameId !== 0)
        if (childFrames.length === 0) {
            throw new Error('No iframes found in page')
        }

        // 在主框架中查找目标 iframe 的信息
        const results = await chrome.scripting.executeScript({
                                                                 target: {tabId, frameIds: [0]},
                                                                 func: (frame: string | number) => {
                                                                     const iframes                        = Array.from(
                                                                         document.querySelectorAll('iframe, frame')) as HTMLIFrameElement[]
                                                                     let target: HTMLIFrameElement | null = null
                                                                     let index                            = -1

                                                                     if (typeof frame === 'number') {
                                                                         if (frame <
                                                                             0 ||
                                                                             frame >=
                                                                             iframes.length) {
                                                                             return null
                                                                         }
                                                                         target = iframes[frame]
                                                                         index  = frame
                                                                     } else {
                                                                         target =
                                                                             document.querySelector(frame) as HTMLIFrameElement
                                                                         if (target) {
                                                                             index = iframes.indexOf(target)
                                                                         }
                                                                     }

                                                                     if (!target) {
                                                                         return null
                                                                     }

                                                                     // 获取绝对 URL
                                                                     let absoluteSrc = target.src || ''
                                                                     if (absoluteSrc &&
                                                                         !absoluteSrc.startsWith('http') &&
                                                                         !absoluteSrc.startsWith('about:')) {
                                                                         try {
                                                                             absoluteSrc =
                                                                                 new URL(
                                                                                     absoluteSrc,
                                                                                     location.href,
                                                                                 ).href
                                                                         } catch { /* keep original */
                                                                         }
                                                                     }

                                                                     return {src: absoluteSrc, index}
                                                                 },
                                                                 args: [p.frame],
                                                             })

        const info = results[0]?.result as { src: string; index: number } | null
        if (!info) {
            const desc = typeof p.frame === 'number' ? `index ${p.frame}` : `selector "${p.frame}"`
            throw new Error(`iframe not found: ${desc}`)
        }

        // 策略 1: URL 精确匹配
        let matchedFrameId: number | undefined
        if (info.src) {
            const urlMatches = childFrames.filter(f => f.url === info.src)
            if (urlMatches.length === 1) {
                matchedFrameId = urlMatches[0].frameId
            }
        }

        // 策略 2: 按 DOM 索引匹配
        if (matchedFrameId === undefined && info.index >= 0 && info.index < childFrames.length) {
            matchedFrameId = childFrames[info.index].frameId
        }

        if (matchedFrameId === undefined) {
            throw new Error(`Cannot resolve iframe to frameId. src: "${info.src}", childFrames: ${childFrames.length}`)
        }

        const offset = await this.getFrameOffset(tabId, matchedFrameId)
        return {frameId: matchedFrameId, offset}
    }

    /**
     * 获取页面所有 frame 信息
     */
    private async getAllFrames(params: unknown): Promise<{
        frames: Array<{ frameId: number; parentFrameId: number; url: string }>
    }> {
        const p     = params as { tabId?: number }
        const tabId = await this.getTargetTabId(p?.tabId)

        const frames = await chrome.webNavigation.getAllFrames({tabId})
        if (!frames) {
            throw new Error('Failed to get frames')
        }

        return {
            frames: frames.map(f => ({
                frameId: f.frameId,
                parentFrameId: f.parentFrameId,
                url: f.url,
            })),
        }
    }

    /**
     * 在指定 iframe 中以 precise 模式执行 JS
     *
     * 通过 Runtime.enable 获取 iframe 的执行上下文 ID，
     * 然后用 Runtime.evaluate + contextId 在 iframe 主世界中执行代码，绕过 CSP。
     */
    private async evaluateInFrame(params: unknown): Promise<unknown> {
        const p = params as {
            tabId?: number
            frameId: number
            expression: string
            returnByValue?: boolean
            awaitPromise?: boolean
            timeout?: number
        }
        if (p.frameId === undefined) {
            throw new Error('frameId is required')
        }
        if (!p.expression) {
            throw new Error('expression is required')
        }

        const tabId = await this.getTargetTabId(p.tabId)
        await this.ensureDebuggerAttached(tabId)

        // 获取 Extension frameId 对应的 URL
        const extFrames = await chrome.webNavigation.getAllFrames({tabId})
        if (!extFrames) {
            throw new Error('Failed to enumerate frames')
        }
        const targetFrame = extFrames.find(f => f.frameId === p.frameId)
        if (!targetFrame) {
            throw new Error(`Frame ${p.frameId} not found`)
        }

        // 获取 CDP frame tree，通过 URL 匹配找到 CDP frameId
        const treeResult  = await chrome.debugger.sendCommand({tabId}, 'Page.getFrameTree') as {
            frameTree: { frame: { id: string; url: string }; childFrames?: Array<unknown> }
        }
        const cdpFrameIds = this.findCdpFrameIds(treeResult.frameTree, targetFrame.url)
        if (cdpFrameIds.length === 0) {
            throw new Error(`Cannot resolve CDP frame for URL: ${targetFrame.url}`)
        }
        if (cdpFrameIds.length > 1) {
            throw new Error(
                `Multiple CDP frames (${cdpFrameIds.length}) match URL "${targetFrame.url}". `
                + 'Cannot uniquely identify target iframe for precise evaluate. '
                + 'Use stealth mode or ensure iframes have distinct URLs.',
            )
        }
        const cdpFrameId = cdpFrameIds[0]

        // 确保 Runtime 域已启用以收集执行上下文
        // 首次调用时 enable 会触发所有已存在上下文的事件；
        // 后续调用复用缓存（由 onEvent 持久监听保持一致性）
        let contexts = this.executionContexts.get(tabId) || []
        if (contexts.length === 0) {
            await chrome.debugger.sendCommand({tabId}, 'Runtime.enable')
            // 等待事件到达
            await new Promise(resolve => setTimeout(resolve, 100))
            contexts = this.executionContexts.get(tabId) || []
        }

        // 查找目标 frame 的主世界上下文
        const targetCtx = contexts.find(c => c.frameId === cdpFrameId && c.isDefault)
        if (!targetCtx) {
            throw new Error(`No execution context for frame (CDP: ${cdpFrameId}, contexts: ${contexts.length})`)
        }

        // 在目标上下文中执行
        const evalParams: Record<string, unknown> = {
            contextId: targetCtx.id,
            expression: p.expression,
            returnByValue: p.returnByValue ?? true,
            awaitPromise: p.awaitPromise ?? true,
        }
        if (p.timeout !== undefined) {
            evalParams.timeout = p.timeout
        }

        return await chrome.debugger.sendCommand({tabId}, 'Runtime.evaluate', evalParams)
    }

    /** 在 CDP frame tree 中递归收集所有匹配 URL 的 frameId */
    private findCdpFrameIds(
        node: { frame: { id: string; url: string }; childFrames?: Array<unknown> },
        targetUrl: string,
    ): string[] {
        const results: string[] = []
        if (node.frame.url === targetUrl) {
            results.push(node.frame.id)
        }
        for (const child of (node.childFrames || []) as Array<typeof node>) {
            results.push(...this.findCdpFrameIds(child, targetUrl))
        }
        return results
    }

    // ==================== 辅助方法 ====================

    private async getTargetTabId(tabId?: number): Promise<number> {
        if (tabId !== undefined && tabId !== null) {
            // 验证 tab 是否存在，避免对已关闭的 tab 操作时得到不明确的 Chrome API 错误
            try {
                await chrome.tabs.get(tabId)
            } catch {
                throw new Error(`Tab ${tabId} 不存在（可能已被关闭）`)
            }
            return tabId
        }

        const [activeTab] = await chrome.tabs.query({active: true, currentWindow: true})
        if (!activeTab?.id) {
            throw new Error('No active tab found')
        }
        return activeTab.id
    }

    private async waitForNavigation(tabId: number, waitUntil: WaitUntil, timeout = 30000): Promise<void> {
        const startTime = Date.now()

        if (waitUntil === 'domcontentloaded') {
            // DOMContentLoaded：事件监听 + 轮询兜底
            await new Promise<void>((resolve, reject) => {
                let settled = false
                const done  = () => {
                    if (!settled) {
                        settled = true
                        cleanup()
                        resolve()
                    }
                }
                const fail  = (err: Error) => {
                    if (!settled) {
                        settled = true
                        cleanup()
                        reject(err)
                    }
                }

                const onDCL     = (details: { tabId: number; frameId: number }) => {
                    if (details.tabId === tabId && details.frameId === 0) {
                        done()
                    }
                }
                const timeoutId = setTimeout(() => fail(new Error('Navigation timeout')), timeout)
                const cleanup   = () => {
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
            const checkStatus = async () => {
                if (Date.now() - startTime > timeout) {
                    reject(new Error('Navigation timeout'))
                    return
                }

                try {
                    const tab = await chrome.tabs.get(tabId)
                    if (tab.status === 'complete') {
                        resolve()
                        return
                    }
                    setTimeout(checkStatus, 100)
                } catch (error) {
                    reject(error)
                }
            }

            checkStatus()
        })

        // networkidle：额外等待确保没有新的网络请求，受 timeout 约束
        if (waitUntil === 'networkidle') {
            const remaining = timeout - (Date.now() - startTime)
            if (remaining > 0) {
                await new Promise(resolve => setTimeout(resolve, Math.min(500, remaining)))
            }
        }
    }
}

// ==================== 注入到页面的函数 ====================

// Accessibility Tree 生成
function generateAccessibilityTree(
    filter: string,
    maxDepth: number,
    maxLength: number | null,
    refId: string | null,
): { pageContent: string; viewport: { width: number; height: number }; error?: string } {
    // 初始化元素映射
    const win           = window as Window & {
        __mcpElementMap?: Record<string, WeakRef<Element>>
        __mcpRefCounter?: number
    }
    win.__mcpElementMap = win.__mcpElementMap || {}
    win.__mcpRefCounter = win.__mcpRefCounter || 0

    const lines: string[] = []

    function getRole(element: Element): string {
        const role = element.getAttribute('role')
        if (role) {
            return role
        }

        const tag  = element.tagName.toLowerCase()
        const type = element.getAttribute('type')

        const roleMap: Record<string, string> = {
            a: 'link',
            button: 'button',
            input: type === 'submit' || type === 'button' ? 'button'
                                                          : type === 'checkbox' ? 'checkbox'
                                                                                : type === 'radio' ?
                                                                                  'radio'
                                                                                                   :
                                                                                  type === 'file' ? 'button'
                                                                                                  : 'textbox',
            select: 'combobox',
            textarea: 'textbox',
            h1: 'heading', h2: 'heading', h3: 'heading',
            h4: 'heading', h5: 'heading', h6: 'heading',
            img: 'image',
            nav: 'navigation',
            main: 'main',
            header: 'banner',
            footer: 'contentinfo',
            section: 'region',
            article: 'article',
            aside: 'complementary',
            form: 'form',
            table: 'table',
            ul: 'list', ol: 'list',
            li: 'listitem',
            label: 'label',
        }

        return roleMap[tag] || 'generic'
    }

    function getName(element: Element): string {
        const tag = element.tagName.toLowerCase()

        // Select 元素
        if (tag === 'select') {
            const select   = element as HTMLSelectElement
            const selected = select.querySelector('option[selected]') || select.options[select.selectedIndex]
            if (selected?.textContent) {
                return selected.textContent.trim()
            }
        }

        // ARIA label
        const ariaLabel = element.getAttribute('aria-label')
        if (ariaLabel?.trim()) {
            return ariaLabel.trim()
        }

        // Placeholder
        const placeholder = element.getAttribute('placeholder')
        if (placeholder?.trim()) {
            return placeholder.trim()
        }

        // Title
        const title = element.getAttribute('title')
        if (title?.trim()) {
            return title.trim()
        }

        // Alt
        const alt = element.getAttribute('alt')
        if (alt?.trim()) {
            return alt.trim()
        }

        // Label for
        if (element.id) {
            const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`)
            if (label?.textContent?.trim()) {
                return label.textContent.trim()
            }
        }

        // Input value
        if (tag === 'input') {
            const input     = element as HTMLInputElement
            const inputType = input.type || ''
            if (inputType === 'submit' && input.value?.trim()) {
                return input.value.trim()
            }
            if (input.value && input.value.length < 50) {
                return input.value.trim()
            }
        }

        // Button/Link text
        if (['button', 'a', 'summary'].includes(tag)) {
            let text = ''
            for (const child of element.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                    text += child.textContent
                }
            }
            if (text.trim()) {
                return text.trim()
            }
        }

        // Heading text
        if (tag.match(/^h[1-6]$/)) {
            const text = element.textContent
            if (text?.trim()) {
                return text.trim().substring(0, 100)
            }
        }

        // Generic text content
        let textContent = ''
        for (const child of element.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                textContent += child.textContent
            }
        }
        if (textContent.trim().length >= 3) {
            const trimmed = textContent.trim()
            return trimmed.length > 100 ? trimmed.substring(0, 100) + '...' : trimmed
        }

        return ''
    }

    function isVisible(element: Element): boolean {
        const style = window.getComputedStyle(element)
        const el    = element as HTMLElement
        return style.display !== 'none'
               && style.visibility !== 'hidden'
               && style.opacity !== '0'
               && el.offsetWidth > 0
               && el.offsetHeight > 0
    }

    function isInteractive(element: Element): boolean {
        const tag = element.tagName.toLowerCase()
        return ['a', 'button', 'input', 'select', 'textarea', 'details', 'summary'].includes(tag)
               || element.getAttribute('onclick') !== null
               || element.getAttribute('tabindex') !== null
               || element.getAttribute('role') === 'button'
               || element.getAttribute('role') === 'link'
               || element.getAttribute('contenteditable') === 'true'
    }

    function isLandmark(element: Element): boolean {
        const tag = element.tagName.toLowerCase()
        return [
                   'h1',
                   'h2',
                   'h3',
                   'h4',
                   'h5',
                   'h6',
                   'nav',
                   'main',
                   'header',
                   'footer',
                   'section',
                   'article',
                   'aside',
               ].includes(tag)
               || element.getAttribute('role') !== null
    }

    function shouldInclude(element: Element, checkRefId: boolean): boolean {
        const tag = element.tagName.toLowerCase()

        if (['script', 'style', 'meta', 'link', 'title', 'noscript'].includes(tag)) {
            return false
        }

        if (filter !== 'all' && element.getAttribute('aria-hidden') === 'true') {
            return false
        }

        if (filter !== 'all' && !isVisible(element)) {
            return false
        }

        if (filter !== 'all' && !checkRefId) {
            const rect = element.getBoundingClientRect()
            if (!(rect.top < window.innerHeight && rect.bottom > 0 &&
                  rect.left < window.innerWidth && rect.right > 0)) {
                return false
            }
        }

        if (filter === 'interactive') {
            return isInteractive(element)
        }

        if (isInteractive(element)) {
            return true
        }
        if (isLandmark(element)) {
            return true
        }
        if (getName(element).length > 0) {
            return true
        }

        const role = getRole(element)
        return role !== 'generic' && role !== 'image'
    }

    function getOrCreateRef(element: Element): string {
        for (const [id, ref] of Object.entries(win.__mcpElementMap!)) {
            if (ref.deref() === element) {
                return id
            }
        }

        const newRefId                 = `ref_${++win.__mcpRefCounter!}`
        win.__mcpElementMap![newRefId] = new WeakRef(element)
        return newRefId
    }

    function traverse(element: Element, level: number, checkRefId: boolean) {
        if (level > maxDepth || !element || !element.tagName) {
            return
        }

        const include = shouldInclude(element, checkRefId) || (checkRefId && level === 0)

        if (include) {
            const role         = getRole(element)
            const name         = getName(element)
            const elementRefId = getOrCreateRef(element)

            let line = '  '.repeat(level) + role
            if (name) {
                line += ` "${name.replace(/\s+/g, ' ').replace(/"/g, '\\"')}"`
            }
            line += ` [${elementRefId}]`

            const href = element.getAttribute('href')
            if (href) {
                line += ` href="${href}"`
            }

            const type = element.getAttribute('type')
            if (type) {
                line += ` type="${type}"`
            }

            lines.push(line)

            // 处理 select 的 options
            if (element.tagName.toLowerCase() === 'select') {
                const select = element as HTMLSelectElement
                for (const option of select.options) {
                    let optLine   = '  '.repeat(level + 1) + 'option'
                    const optText = option.textContent?.trim() || ''
                    if (optText) {
                        optLine += ` "${optText.replace(/\s+/g, ' ').substring(0, 100).replace(/"/g, '\\"')}"`
                    }
                    if (option.selected) {
                        optLine += ' (selected)'
                    }
                    if (option.value && option.value !== optText) {
                        optLine += ` value="${option.value.replace(/"/g, '\\"')}"`
                    }
                    lines.push(optLine)
                }
            }
        }

        // 递归子元素
        if (element.children && level < maxDepth) {
            for (const child of element.children) {
                traverse(child, include ? level + 1 : level, checkRefId)
            }
        }
    }

    if (refId) {
        const ref = win.__mcpElementMap![refId]
        if (!ref) {
            return {
                error: `Element with ref_id '${refId}' not found`,
                pageContent: '',
                viewport: {width: window.innerWidth, height: window.innerHeight},
            }
        }
        const element = ref.deref()
        if (!element) {
            return {
                error: `Element with ref_id '${refId}' no longer exists`,
                pageContent: '',
                viewport: {width: window.innerWidth, height: window.innerHeight},
            }
        }
        traverse(element, 0, true)
    } else if (document.body) {
        traverse(document.body, 0, false)
    }

    // 清理失效引用
    for (const id of Object.keys(win.__mcpElementMap!)) {
        if (!win.__mcpElementMap![id].deref()) {
            delete win.__mcpElementMap![id]
        }
    }

    const content = lines.join('\n')

    if (maxLength && content.length > maxLength) {
        return {
            error: `Output exceeds ${maxLength} character limit (${content.length} characters)`,
            pageContent: '',
            viewport: {width: window.innerWidth, height: window.innerHeight},
        }
    }

    return {
        pageContent: content,
        viewport: {width: window.innerWidth, height: window.innerHeight},
    }
}

// 点击操作（高效模式）
function performClick(refId: string): { success: boolean; error?: string } {
    const win = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
    const ref = win.__mcpElementMap?.[refId]

    if (!ref) {
        return {success: false, error: `Element ${refId} not found`}
    }

    const element = ref.deref()
    if (!element) {
        return {success: false, error: `Element ${refId} no longer exists`}
    }

    // 滚动到元素位置
    element.scrollIntoView({behavior: 'smooth', block: 'center'})

    // 高效点击：直接调用 click()
    const el = element as HTMLElement
    el.focus()
    el.click()

    return {success: true}
}

// 输入操作（高效模式）
function performType(refId: string, text: string, clear: boolean): { success: boolean; error?: string } {
    const win = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
    const ref = win.__mcpElementMap?.[refId]

    if (!ref) {
        return {success: false, error: `Element ${refId} not found`}
    }

    const element = ref.deref()
    if (!element) {
        return {success: false, error: `Element ${refId} no longer exists`}
    }

    const el = element as HTMLInputElement | HTMLTextAreaElement
    el.focus()

    // 高效输入：直接设置 value
    if ('value' in el) {
        el.value = clear ? text : el.value + text
        el.dispatchEvent(new Event('input', {bubbles: true}))
        el.dispatchEvent(new Event('change', {bubbles: true}))
    } else if ((element as HTMLElement).contentEditable === 'true') {
        if (clear) {
            element.textContent = text
        } else {
            element.textContent = (element.textContent || '') + text
        }
        element.dispatchEvent(new Event('input', {bubbles: true}))
    }

    return {success: true}
}

// 滚动操作
function performScroll(x: number, y: number, refId: string | null): {
    success: boolean;
    scrollX: number;
    scrollY: number;
    error?: string
} {
    if (refId) {
        const win = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
        const ref = win.__mcpElementMap?.[refId]

        if (!ref) {
            return {success: false, error: `Element ${refId} not found`, scrollX: 0, scrollY: 0}
        }

        const element = ref.deref()
        if (!element) {
            return {success: false, error: `Element ${refId} no longer exists`, scrollX: 0, scrollY: 0}
        }

        element.scrollBy(x, y)
    } else {
        window.scrollBy(x, y)
    }

    return {success: true, scrollX: window.scrollX, scrollY: window.scrollY}
}

// 代码执行
function executeCode(code: string): { success: boolean; result?: string; error?: string } {
    try {
        // 使用 Function 构造函数替代 eval，更容易处理返回值
        const fn     = new Function(`return (${code})`)
        const result = fn()
        return {success: true, result: JSON.stringify(result)}
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error'
        // 检测 CSP 相关错误
        if (errorMsg.includes('Content Security Policy') || errorMsg.includes('\'unsafe-eval\'')) {
            return {
                success: false,
                error: `CSP 限制：此页面禁止动态代码执行。建议使用 extract 工具获取页面内容，或使用 CDP 模式。原始错误: ${errorMsg}`,
            }
        }
        return {success: false, error: errorMsg}
    }
}

// 提取文本
function extractText(selector: string | null): { text: string } {
    if (selector) {
        const element = document.querySelector(selector)
        return {text: element?.textContent || ''}
    }
    return {text: document.body.innerText}
}

// 提取 HTML
function extractHtml(selector: string | null, outer: boolean): { html: string } {
    if (selector) {
        const element = document.querySelector(selector)
        if (!element) {
            return {html: ''}
        }
        return {html: outer ? element.outerHTML : element.innerHTML}
    }
    return {html: document.documentElement.outerHTML}
}

// 提取 HTML + 图片元信息
function extractHtmlWithImages(selector: string | null, outer: boolean): {
    html: string
    images: Array<{
        index: number;
        src: string;
        dataSrc: string;
        alt: string;
        width: number;
        height: number;
        naturalWidth: number;
        naturalHeight: number
    }>
} {
    const root = selector ? document.querySelector(selector) : document.documentElement
    if (!root) {
        return {html: '', images: []}
    }

    const html = selector
                 ? (outer ? root.outerHTML : (root as HTMLElement).innerHTML)
                 : document.documentElement.outerHTML

    // 收集范围内所有 <img> 元素（文档顺序），含 root 自身
    const imgList: HTMLImageElement[] = []
    if (root.tagName === 'IMG') {
        imgList.push(root as HTMLImageElement)
    }
    root.querySelectorAll('img').forEach(img => imgList.push(img))
    const images = imgList.map((img, index) => ({
        index,
        src: img.src,                       // 绝对 URL（浏览器已解析）
        dataSrc: (() => { const raw = img.dataset.src || img.dataset.lazySrc || img.dataset.original || ''; if (!raw) return ''; try { return new URL(raw, location.href).href } catch { return raw } })(),  // 懒加载 URL（解析为绝对路径）
        alt: img.alt,
        width: img.width,                   // 渲染宽度
        height: img.height,                 // 渲染高度
        naturalWidth: img.naturalWidth,     // 原始宽度
        naturalHeight: img.naturalHeight,   // 原始高度
    }))

    return {html, images}
}

// 提取页面元信息
function extractMetadata(): Record<string, unknown> {
    const meta = (name: string): string | undefined =>
        (document.querySelector(`meta[name="${name}"],meta[property="${name}"]`) as HTMLMetaElement | null)
            ?.content || undefined

    return {
        title: document.title,
        description: meta('description'),
        canonical: (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)?.href || undefined,
        charset: document.characterSet,
        viewport: meta('viewport'),
        og: Object.fromEntries(
            Array.from(document.querySelectorAll('meta[property^="og:"]'))
                 .map(m => [m.getAttribute('property')!, (m as HTMLMetaElement).content ?? '']),
        ),
        twitter: Object.fromEntries(
            Array.from(document.querySelectorAll('meta[name^="twitter:"]'))
                 .map(m => [m.getAttribute('name')!, (m as HTMLMetaElement).content ?? '']),
        ),
        jsonLd: Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
                     .map(s => {
                         try {
                             return JSON.parse(s.textContent ?? '')
                         } catch {
                             return null
                         }
                     })
                     .filter(Boolean),
        alternates: Array.from(document.querySelectorAll('link[rel="alternate"]'))
                         .map(l => ({
                             href: (l as HTMLLinkElement).href,
                             type: l.getAttribute('type') || undefined,
                             hreflang: l.getAttribute('hreflang') || undefined,
                         })),
        feeds: Array.from(document.querySelectorAll('link[type="application/rss+xml"],link[type="application/atom+xml"]'))
                    .map(l => ({
                        href: (l as HTMLLinkElement).href,
                        type: l.getAttribute('type')!,
                        title: l.getAttribute('title') || undefined,
                    })),
    }
}

// 提取属性
function extractAttribute(selector: string | null, refId: string | null, attribute: string): { value: string | null } {
    let element: Element | null = null

    if (refId) {
        const win = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
        const ref = win.__mcpElementMap?.[refId]
        element   = ref?.deref() ?? null
    } else if (selector) {
        element = document.querySelector(selector)
    }

    if (!element) {
        return {value: null}
    }

    // 特定属性使用 property 方式获取（运行时实际值，而非 HTML 初始值）
    const propertyAttributes = ['value', 'checked', 'selected', 'disabled', 'readOnly', 'indeterminate']
    if (propertyAttributes.includes(attribute)) {
        const el        = element as HTMLInputElement
        const propValue = el[attribute as keyof HTMLInputElement]
        if (typeof propValue === 'boolean') {
            return {value: propValue ? 'true' : 'false'}
        }
        return {value: propValue != null ? String(propValue) : null}
    }

    return {value: element.getAttribute(attribute)}
}

// 元素查找（支持 CSS 选择器、XPath、文本）
function findElements(
    selector: string | null,
    text: string | null,
    xpath: string | null,
): Array<{
    refId: string
    tag: string
    text: string
    rect: { x: number; y: number; width: number; height: number }
}> {
    const win           = window as Window & {
        __mcpElementMap?: Record<string, WeakRef<Element>>
        __mcpRefCounter?: number
    }
    win.__mcpElementMap = win.__mcpElementMap || {}
    win.__mcpRefCounter = win.__mcpRefCounter || 0

    const results: Array<{
        refId: string
        tag: string
        text: string
        rect: { x: number; y: number; width: number; height: number }
    }> = []

    let elements: Element[]

    if (xpath) {
        // XPath 查询
        elements          = []
        const xpathResult = document.evaluate(
            xpath,
            document,
            null,
            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
            null,
        )
        for (let i = 0; i < xpathResult.snapshotLength; i++) {
            const node = xpathResult.snapshotItem(i)
            if (node instanceof Element) {
                elements.push(node)
            }
        }
    } else if (selector) {
        // CSS 选择器查询
        elements = Array.from(document.querySelectorAll(selector))
    } else {
        // 无选择器时查询所有元素
        elements = Array.from(document.querySelectorAll('*'))
    }

    for (const element of elements) {
        if (text) {
            const elementText = element.textContent || ''
            if (!elementText.includes(text)) {
                continue
            }
        }

        // 查找或创建 refId
        let refId: string | null = null
        for (const [id, ref] of Object.entries(win.__mcpElementMap!)) {
            if (ref.deref() === element) {
                refId = id
                break
            }
        }

        if (!refId) {
            refId                       = `ref_${++win.__mcpRefCounter!}`
            win.__mcpElementMap![refId] = new WeakRef(element)
        }

        const rect = element.getBoundingClientRect()
        results.push({
                         refId,
                         tag: element.tagName.toLowerCase(),
                         text: (element.textContent || '').trim().substring(0, 100),
                         rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
                     })

        if (results.length >= 50) {
            break
        }
    }

    // 清理失效引用，防止 key 泄漏
    for (const id of Object.keys(win.__mcpElementMap!)) {
        if (!win.__mcpElementMap![id].deref()) {
            delete win.__mcpElementMap![id]
        }
    }

    return results
}

// ==================== Stealth 模式注入函数 ====================

// 模拟鼠标点击
function simulateMouseClick(x: number, y: number, button: string): { success: boolean } {
    const element = document.elementFromPoint(x, y)
    if (!element) {
        return {success: false}
    }

    const buttonCode   = button === 'right' ? 2 : button === 'middle' ? 1 : 0
    const eventOptions = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x + window.screenX,
        screenY: y + window.screenY,
        button: buttonCode,
        buttons: 2 ** buttonCode,
    }

    element.dispatchEvent(new MouseEvent('mouseover', eventOptions))
    element.dispatchEvent(new MouseEvent('mouseenter', {...eventOptions, bubbles: false}))
    element.dispatchEvent(new MouseEvent('mousemove', eventOptions))
    element.dispatchEvent(new MouseEvent('mousedown', eventOptions))

    // mousedown 时聚焦可聚焦元素
    if ('focus' in element && typeof (element as HTMLElement).focus === 'function') {
        (element as HTMLElement).focus()
    }

    element.dispatchEvent(new MouseEvent('mouseup', eventOptions))
    element.dispatchEvent(new MouseEvent('click', eventOptions))

    return {success: true}
}

// 模拟键盘输入
function simulateKeyboardType(text: string, _delay: number): { success: boolean; error?: string } {
    const activeElement = document.activeElement as HTMLElement | null

    if (!activeElement) {
        return {success: false, error: 'No active element'}
    }

    // 检查是否是可输入元素
    const isInputable = activeElement.tagName === 'INPUT' ||
                        activeElement.tagName === 'TEXTAREA' ||
                        activeElement.isContentEditable

    if (!isInputable) {
        return {success: false, error: `Active element is not inputable: ${activeElement.tagName}`}
    }

    for (const char of text) {
        const keyEventOptions = {
            bubbles: true,
            cancelable: true,
            key: char,
            code: char >= 'a' && char <= 'z' ? `Key${char.toUpperCase()}` :
                  char >= 'A' && char <= 'Z' ? `Key${char}` :
                  char >= '0' && char <= '9' ? `Digit${char}` : 'Key',
            charCode: char.charCodeAt(0),
            keyCode: char.charCodeAt(0),
            which: char.charCodeAt(0),
            view: window,
        }

        activeElement.dispatchEvent(new KeyboardEvent('keydown', keyEventOptions))
        activeElement.dispatchEvent(new KeyboardEvent('keypress', keyEventOptions))

        // 设置 value（input/textarea）或 textContent（contenteditable）
        if ('value' in activeElement) {
            (activeElement as HTMLInputElement).value += char
        } else if (activeElement.isContentEditable) {
            activeElement.textContent = (activeElement.textContent || '') + char
        }

        activeElement.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: char,
        }))

        activeElement.dispatchEvent(new KeyboardEvent('keyup', keyEventOptions))
    }

    activeElement.dispatchEvent(new Event('change', {bubbles: true}))

    return {success: true}
}

// 模拟单个按键事件
function simulateKeyEvent(key: string, type: string, modifiers: string[]): { success: boolean } {
    const activeElement = document.activeElement || document.body

    const keyEventOptions: KeyboardEventInit = {
        bubbles: true,
        cancelable: true,
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        view: window,
        ctrlKey: modifiers.includes('ctrl'),
        shiftKey: modifiers.includes('shift'),
        altKey: modifiers.includes('alt'),
        metaKey: modifiers.includes('meta'),
    }

    if (type === 'down' || type === 'press') {
        activeElement.dispatchEvent(new KeyboardEvent('keydown', keyEventOptions))
    }
    if (type === 'press') {
        activeElement.dispatchEvent(new KeyboardEvent('keypress', keyEventOptions))
    }
    if (type === 'up' || type === 'press') {
        activeElement.dispatchEvent(new KeyboardEvent('keyup', keyEventOptions))
    }

    return {success: true}
}

// 模拟鼠标事件
function simulateMouseEvent(type: string, x: number, y: number, button: string): { success: boolean } {
    const element    = document.elementFromPoint(x, y) || document.body
    const buttonCode = button === 'right' ? 2 : button === 'middle' ? 1 : 0

    const eventOptions = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x + window.screenX,
        screenY: y + window.screenY,
        button: buttonCode,
        buttons: type === 'mousedown' ? (1 << buttonCode) : 0,
    }

    element.dispatchEvent(new MouseEvent(type, eventOptions))

    // mousedown 时聚焦可聚焦元素
    if (type === 'mousedown' && 'focus' in element && typeof element.focus === 'function') {
        (element as HTMLElement).focus()
    }

    // mouseup 后自动触发 click 事件（模拟原生浏览器行为）
    if (type === 'mouseup') {
        element.dispatchEvent(new MouseEvent('click', eventOptions))
    }

    return {success: true}
}

// 注入反检测脚本
function injectStealthScripts(): void {
    // 覆盖 navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true,
    })

    // 覆盖 navigator.plugins（模拟真实浏览器）
    Object.defineProperty(navigator, 'plugins', {
        get: () => {
            const plugins     = [
                {name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer'},
                {name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai'},
                {name: 'Native Client', filename: 'internal-nacl-plugin'},
            ]
            // 反检测需要使用已废弃的 PluginArray/Plugin API，通过 globalThis 间接访问避免 TS6385
            const pluginArray = Object.create((globalThis as unknown as Record<string, {
                prototype: object
            }>).PluginArray.prototype)
            plugins.forEach((p, i) => {
                const plugin = Object.create((globalThis as unknown as Record<string, {
                    prototype: object
                }>).Plugin.prototype)
                Object.defineProperties(plugin, {
                    name: {value: p.name},
                    filename: {value: p.filename},
                    description: {value: ''},
                    length: {value: 0},
                })
                pluginArray[i] = plugin
            })
            Object.defineProperty(pluginArray, 'length', {value: plugins.length})
            return pluginArray
        },
        configurable: true,
    })

    // 覆盖 navigator.languages
    Object.defineProperty(navigator, 'languages', {
        get: () => ['zh-CN', 'zh', 'en-US', 'en'],
        configurable: true,
    })

    // 覆盖 chrome.runtime（隐藏扩展存在）
    const originalChrome = (window as unknown as { chrome?: unknown }).chrome
    if (originalChrome) {
        Object.defineProperty(window, 'chrome', {
            get: () => {
                const chrome = {...originalChrome as object}
                delete (chrome as { runtime?: unknown }).runtime
                return chrome
            },
            configurable: true,
        })
    }

    // 覆盖 Error.stack（移除扩展痕迹）
    ;(window as unknown as { Error: typeof Error }).Error = new Proxy(Error, {
        construct(target, args) {
            const error         = new target(...args)
            const originalStack = error.stack
            if (originalStack) {
                error.stack = originalStack
                    .split('\n')
                    .filter(line => !line.includes('chrome-extension://'))
                    .join('\n')
            }
            return error
        },
    })

    // 覆盖 Permissions API
    if (navigator.permissions) {
        const originalQuery         = navigator.permissions.query.bind(navigator.permissions)
        navigator.permissions.query = async (descriptor: PermissionDescriptor) => {
            if (descriptor.name === 'notifications') {
                return {state: 'prompt', onchange: null} as PermissionStatus
            }
            return originalQuery(descriptor)
        }
    }

    // 覆盖 WebGL 渲染器信息
    const originalGetParameter                   = WebGLRenderingContext.prototype.getParameter
    WebGLRenderingContext.prototype.getParameter = function (parameter: number) {
        if (parameter === 37445) {  // UNMASKED_VENDOR_WEBGL
            return 'Google Inc. (NVIDIA)'
        }
        if (parameter === 37446) {  // UNMASKED_RENDERER_WEBGL
            return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)'
        }
        return originalGetParameter.call(this, parameter)
    }

    console.log('[MCP Stealth] Anti-detection scripts injected')
}
