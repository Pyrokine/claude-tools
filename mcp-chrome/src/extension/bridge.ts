/**
 * Extension Bridge
 *
 * 封装与 Chrome Extension 的通信，提供与 CDP 类似的接口
 * 使用 HTTP + WebSocket 实现
 */

import {
    type ActionableClickResult,
    type BrowserTopology,
    type CookieFilter,
    DriverCapabilityError,
    type IBrowserDriver,
    type ListedTarget,
    type ManagedPageResult,
    type MovePageOptions,
    type NewTabResult,
    type NewWindowOptions,
    type PageManagementResult,
    type ResizeWindowOptions,
    type ScreenshotResult,
    type SetCookieParams,
} from '../core/browser-driver.js'
import type { ConsoleLogEntry, NetworkRequestEntry } from '../core/types.js'
import { ExtensionHttpServer } from './http-server.js'

/** RPC 传输余量（毫秒）：给网络往返和 Extension 处理留出的额外时间 */
const RPC_MARGIN = 5000
/** goBack/goForward 信号窗口（毫秒）：Extension 等待导航开始的上限 */
const NAV_SIGNAL_WINDOW = 5000

interface SimplePageState {
    url: string
    title: string
    managed?: boolean
}

interface ExtensionTabSummary {
    id: number
    url: string
    title: string
    active?: boolean
    windowId?: number
    index?: number
    groupId?: number
    pinned?: boolean
    incognito?: boolean
    managed?: boolean
    status?: string
}

interface ExtensionManagedPageResult {
    success: boolean
    tab: ExtensionTabSummary
    managedBefore: boolean
    managedAfter: boolean
}

interface ExtensionPageChangeResult {
    success: boolean
    targetId?: string
    windowId?: number
    before?: ExtensionTabSummary | BrowserTopology['windows'][number] | null
    after?: ExtensionTabSummary | BrowserTopology['windows'][number] | null
}

export interface ExtensionBridgeOptions {
    port?: number
    timeout?: number
}

export class ExtensionBridge implements IBrowserDriver {
    private httpServer: ExtensionHttpServer
    private currentTabId: number | null = null
    private currentFrameId: number = 0
    private state: SimplePageState | null = null

    constructor(options: ExtensionBridgeOptions = {}) {
        this.httpServer = new ExtensionHttpServer({
            port: options.port,
            autoPort: true,
        })
    }

    async start(): Promise<void> {
        await this.httpServer.start()

        // Extension 重连后自动恢复 attach 状态
        this.httpServer.on('connected', () => {
            if (this.currentTabId !== null) {
                const tabId = this.currentTabId
                this.httpServer.sendCommand('debugger_attach', { tabId }).catch((err: Error) => {
                    console.error('[Bridge] 重连后 debugger re-attach 失败:', err.message)
                })
            }
        })
    }

    async stop(): Promise<void> {
        await this.httpServer.stop()
    }

    isConnected(): boolean {
        return this.httpServer.isConnected()
    }

    /**
     * 等待连接建立
     * @param timeout 超时时间（毫秒），0 表示无限等待（默认）
     */
    async waitForConnection(timeout = 0): Promise<boolean> {
        return this.httpServer.waitForConnection(timeout)
    }

    getPort(): number {
        return this.httpServer.getPort()
    }

    // ==================== Tab 操作 ====================

    async listTabs(): Promise<ExtensionTabSummary[]> {
        const result = await this.httpServer.sendCommand('tabs_list', {})
        return result as ExtensionTabSummary[]
    }

    async listWindows(): Promise<BrowserTopology> {
        const result = await this.httpServer.sendCommand('tabs_topology', {})
        const topology = result as BrowserTopology
        return {
            ...topology,
            windows: topology.windows.map((window) => ({
                ...window,
                tabs: window.tabs.map((tab) => ({
                    ...tab,
                    targetId: String(tab.id),
                    type: tab.type ?? 'page',
                })),
            })),
        }
    }

    /** IBrowserDriver 接口：列出所有 tab，统一为 ListedTarget 形式（id 字符串化以保持跨 driver 兼容） */
    async listTargets(): Promise<ListedTarget[]> {
        const tabs = await this.listTabs()
        return tabs.map((tab) => this.tabToTarget(tab))
    }

    async createTab(
        url?: string,
        timeout?: number
    ): Promise<{ id: number; url: string; title: string; managed?: boolean }> {
        const rpcTimeout = timeout !== undefined ? timeout + RPC_MARGIN : undefined
        const result = await this.httpServer.sendCommand(
            'tabs_create',
            {
                url,
                active: false,
                waitUntil: 'load',
                timeout,
            },
            rpcTimeout
        )
        const tab = result as ExtensionTabSummary
        // 自动切换到新创建的 tab，后续操作立即生效
        this.currentTabId = tab.id
        this.updateState(tab)
        return tab
    }

    /** IBrowserDriver 接口：新建页面（targetId 为字符串化的 chrome tab id） */
    async newPage(url?: string, timeout?: number): Promise<NewTabResult> {
        const tab = await this.createTab(url, timeout)
        return {
            targetId: String(tab.id),
            url: tab.url,
            title: tab.title,
            type: 'page',
            managed: tab.managed,
        }
    }

    async closeTab(tabId: number): Promise<PageManagementResult> {
        const result = (await this.httpServer.sendCommand('tabs_close', { tabId })) as ExtensionPageChangeResult
        if (this.currentTabId === tabId) {
            this.currentTabId = null
            this.state = null
        }
        return this.normalizePageChange(result)
    }

    /** IBrowserDriver 接口：关闭页面（targetId 是 chrome tab id 的字符串形式，省略时关闭当前 tab） */
    async closePage(targetId?: string): Promise<PageManagementResult> {
        const tabId = targetId !== undefined ? this.parseTargetId(targetId) : this.currentTabId
        if (tabId === null) {
            throw new DriverCapabilityError('没有可关闭的页面，请指定 targetId')
        }
        return this.closeTab(tabId)
    }

    async adoptPage(targetId: string): Promise<ManagedPageResult> {
        const tabId = this.parseTargetId(targetId)
        const result = (await this.httpServer.sendCommand('tabs_adopt', { tabId })) as ExtensionManagedPageResult
        this.currentTabId = result.tab.id
        this.updateState(result.tab)
        return {
            target: this.tabToTarget(result.tab),
            managedBefore: result.managedBefore,
            managedAfter: result.managedAfter,
        }
    }

    async releasePage(targetId: string): Promise<ManagedPageResult> {
        const tabId = this.parseTargetId(targetId)
        const result = (await this.httpServer.sendCommand('tabs_release', { tabId })) as ExtensionManagedPageResult
        if (this.currentTabId === result.tab.id) {
            this.currentTabId = null
            this.state = null
        }
        return {
            target: this.tabToTarget(result.tab),
            managedBefore: result.managedBefore,
            managedAfter: result.managedAfter,
        }
    }

    async movePage(targetId: string, options: MovePageOptions): Promise<PageManagementResult> {
        const tabId = this.parseTargetId(targetId)
        const result = (await this.httpServer.sendCommand('tabs_move', {
            tabId,
            windowId: options.windowId,
            index: options.index,
            active: options.activate,
        })) as ExtensionPageChangeResult
        return this.normalizePageChange(result)
    }

    async reorderPage(targetId: string, index: number): Promise<PageManagementResult> {
        const tabId = this.parseTargetId(targetId)
        const result = (await this.httpServer.sendCommand('tabs_reorder', {
            tabId,
            index,
        })) as ExtensionPageChangeResult
        return this.normalizePageChange(result)
    }

    async pinPage(targetId: string, pinned: boolean): Promise<PageManagementResult> {
        const tabId = this.parseTargetId(targetId)
        const result = (await this.httpServer.sendCommand('tabs_pin', { tabId, pinned })) as ExtensionPageChangeResult
        return this.normalizePageChange(result)
    }

    async focusWindow(windowId: number): Promise<PageManagementResult> {
        const result = (await this.httpServer.sendCommand('window_focus', { windowId })) as ExtensionPageChangeResult
        return this.normalizePageChange(result)
    }

    async resizeWindow(windowId: number, options: ResizeWindowOptions): Promise<PageManagementResult> {
        const result = (await this.httpServer.sendCommand('window_resize', {
            windowId,
            ...options,
        })) as ExtensionPageChangeResult
        return this.normalizePageChange(result)
    }

    async newWindow(options: NewWindowOptions): Promise<PageManagementResult> {
        const result = (await this.httpServer.sendCommand('window_create', options)) as ExtensionPageChangeResult
        if (result.targetId) {
            this.currentTabId = this.parseTargetId(result.targetId)
            const after = result.after as BrowserTopology['windows'][number] | undefined
            const tab = after?.tabs.find((item) => String(item.id) === result.targetId)
            if (tab) {
                this.updateState(tab)
            }
        }
        return this.normalizePageChange(result)
    }

    async closeWindow(windowId: number): Promise<PageManagementResult> {
        const result = (await this.httpServer.sendCommand('window_close', { windowId })) as ExtensionPageChangeResult
        const before = result.before as BrowserTopology['windows'][number] | undefined
        if (before?.tabs.some((tab) => tab.id === this.currentTabId)) {
            this.currentTabId = null
            this.state = null
        }
        return this.normalizePageChange(result)
    }

    async activatePageWithAffected(targetId: string): Promise<PageManagementResult> {
        const tabId = this.parseTargetId(targetId)
        const result = (await this.httpServer.sendCommand('tabs_activate_managed', {
            tabId,
        })) as ExtensionPageChangeResult
        this.currentTabId = tabId
        const after = result.after as ExtensionTabSummary | undefined
        if (after) {
            this.updateState(after)
        }
        return this.normalizePageChange(result)
    }

    async activateTab(tabId: number): Promise<void> {
        const result = await this.httpServer.sendCommand('tabs_activate', { tabId })
        const tab = result as ExtensionTabSummary
        this.currentTabId = tab.id
        this.updateState(tab)
    }

    /** IBrowserDriver 接口：激活页面（切到前台） */
    async activatePage(targetId: string): Promise<void> {
        const tabId = this.parseTargetId(targetId)
        await this.activateTab(tabId)
    }

    /** IBrowserDriver 接口：选择操作目标 tab（不切换前台，只设置当前 currentTabId） */
    async selectPage(targetId: string): Promise<void> {
        const tabId = this.parseTargetId(targetId)
        const tabs = await this.listTabs()
        const tab = tabs.find((item) => item.id === tabId)
        if (!tab) {
            throw new DriverCapabilityError(`Tab ${targetId} 不存在，请先 browse(action="list") 查看可用页面`)
        }
        this.currentTabId = tab.id
        this.updateState(tab)
    }

    /** IBrowserDriver 接口：获取当前操作目标 ID（chrome tab id 的字符串形式） */
    getCurrentTargetId(): string | null {
        return this.currentTabId !== null ? String(this.currentTabId) : null
    }

    /** IBrowserDriver 接口：设置当前操作目标 ID */
    setCurrentTargetId(targetId: string | null): void {
        this.currentTabId = targetId !== null ? this.parseTargetId(targetId) : null
        if (targetId === null) {
            this.state = null
        }
    }

    async navigate(url: string, options?: { wait?: string; timeout?: number }): Promise<void> {
        if (this.currentTabId === null) {
            throw new DriverCapabilityError('没有当前页面，请先 browse attach 或先 browse open 创建受控页面')
        }
        const rpcTimeout = options?.timeout !== undefined ? options.timeout + RPC_MARGIN : undefined
        const params = {
            tabId: this.requireCurrentTabId(),
            url,
            waitUntil: options?.wait ?? 'load',
            timeout: options?.timeout,
        }
        const result = await this.httpServer.sendCommand('navigate', params, rpcTimeout)
        const tab = result as ExtensionTabSummary
        this.currentTabId = tab.id
        this.updateState(tab)
    }

    // ==================== 导航操作 ====================

    async goBack(timeout?: number): Promise<{ url: string; title: string; navigated: boolean }> {
        if (this.currentTabId === null) {
            throw new DriverCapabilityError('没有当前页面，请先 browse attach 或先 browse open 创建受控页面')
        }
        // 默认：NAV_SIGNAL_WINDOW + 导航等待（默认 30s）+ RPC_MARGIN = 40s
        // 调用方传 timeout 时：timeout 即导航超时 + 信号窗口 + 传输余量
        const rpcTimeout =
            timeout !== undefined ? timeout + NAV_SIGNAL_WINDOW + RPC_MARGIN : 30000 + NAV_SIGNAL_WINDOW + RPC_MARGIN
        const params = {
            tabId: this.requireCurrentTabId(),
            waitUntil: 'load',
            timeout,
        }
        const result = (await this.httpServer.sendCommand('go_back', params, rpcTimeout)) as {
            url: string
            title: string
            navigated: boolean
        }
        this.updateState(result)
        return result
    }

    async goForward(timeout?: number): Promise<{ url: string; title: string; navigated: boolean }> {
        if (this.currentTabId === null) {
            throw new DriverCapabilityError('没有当前页面，请先 browse attach 或先 browse open 创建受控页面')
        }
        // 默认：NAV_SIGNAL_WINDOW + 导航等待（默认 30s）+ RPC_MARGIN = 40s
        // 调用方传 timeout 时：timeout 即导航超时 + 信号窗口 + 传输余量
        const rpcTimeout =
            timeout !== undefined ? timeout + NAV_SIGNAL_WINDOW + RPC_MARGIN : 30000 + NAV_SIGNAL_WINDOW + RPC_MARGIN
        const params = {
            tabId: this.requireCurrentTabId(),
            waitUntil: 'load',
            timeout,
        }
        const result = (await this.httpServer.sendCommand('go_forward', params, rpcTimeout)) as {
            url: string
            title: string
            navigated: boolean
        }
        this.updateState(result)
        return result
    }

    async reload(ignoreCache = false, waitUntil?: string, timeout?: number): Promise<void> {
        if (this.currentTabId === null) {
            throw new DriverCapabilityError('没有当前页面，请先 browse attach 或先 browse open 创建受控页面')
        }
        const rpcTimeout = timeout !== undefined ? timeout + RPC_MARGIN : undefined
        const params = {
            tabId: this.requireCurrentTabId(),
            ignoreCache,
            waitUntil: waitUntil ?? 'load',
            timeout,
        }
        const result = await this.httpServer.sendCommand('reload', params, rpcTimeout)
        const tab = result as ExtensionTabSummary
        this.updateState(tab)
    }

    async readPage(options?: {
        filter?: string
        depth?: number
        maxLength?: number
        refId?: string
    }): Promise<{ pageContent: string; viewport: { width: number; height: number }; error?: string }> {
        return (await this.httpServer.sendCommand('read_page', {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId || undefined,
            ...options,
        })) as { pageContent: string; viewport: { width: number; height: number }; error?: string }
    }

    // ==================== 页面内容 ====================

    async click(refId: string): Promise<void> {
        const result = (await this.httpServer.sendCommand('click', {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId || undefined,
            refId,
        })) as { success: boolean; error?: string }

        if (!result.success) {
            throw new Error(result.error || 'Click failed')
        }
    }

    // ==================== DOM 操作 ====================

    async actionableClick(refId: string, force?: boolean): Promise<ActionableClickResult> {
        return (await this.httpServer.sendCommand('actionable_click', {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId || undefined,
            refId,
            force: force ?? false,
        })) as ActionableClickResult
    }

    async checkActionability(refId: string): Promise<ActionableClickResult> {
        const result = (await this.httpServer.sendCommand('check_actionability', {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId || undefined,
            refId,
        })) as ActionableClickResult & { actionable?: boolean }
        return { ...result, success: result.success ?? result.actionable === true }
    }

    async dispatchInput(refId: string, text: string): Promise<{ success: boolean; error?: string }> {
        return (await this.httpServer.sendCommand('dispatch_input', {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId || undefined,
            refId,
            text,
        })) as { success: boolean; error?: string }
    }

    async dragAndDrop(
        srcRefId: string,
        dstRefId: string
    ): Promise<{ success: boolean; error?: string; code?: string }> {
        return (await this.httpServer.sendCommand('drag_and_drop', {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId || undefined,
            srcRefId,
            dstRefId,
        })) as { success: boolean; error?: string; code?: string }
    }

    async getComputedStyle(refId: string, prop: string): Promise<string | null> {
        return (await this.httpServer.sendCommand('get_computed_style', {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId || undefined,
            refId,
            prop,
        })) as string | null
    }

    async type(refId: string, text: string, clear = false): Promise<void> {
        const result = (await this.httpServer.sendCommand('type', {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId || undefined,
            refId,
            text,
            clear,
        })) as { success: boolean; error?: string }

        if (!result.success) {
            throw new Error(result.error || 'Type failed')
        }
    }

    /** IBrowserDriver 接口别名（避开与字段名冲突的命名歧义） */
    typeRef(refId: string, text: string, clear = false): Promise<void> {
        return this.type(refId, text, clear)
    }

    async scroll(x: number, y: number, refId?: string): Promise<void> {
        await this.httpServer.sendCommand('scroll', {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId || undefined,
            x,
            y,
            refId,
        })
    }

    /** IBrowserDriver 接口别名 */
    scrollAt(x: number, y: number, refId?: string): Promise<void> {
        return this.scroll(x, y, refId)
    }

    async evaluate(code: string, _args?: unknown[], timeout?: number): Promise<unknown> {
        // _args 参数仅满足 IBrowserDriver 接口签名；ExtensionBridge 不消费 args（stealth 路径上层已字符串拼接）
        const rpcTimeout = timeout !== undefined ? timeout + RPC_MARGIN : undefined
        const result = (await this.httpServer.sendCommand(
            'evaluate',
            {
                tabId: this.requireCurrentTabId(),
                frameId: this.currentFrameId || undefined,
                code,
                timeout,
            },
            rpcTimeout
        )) as { success: boolean; result?: string; error?: string }

        if (!result.success) {
            throw new Error(result.error || 'Evaluate failed')
        }

        if (!result.result) {
            return undefined
        }
        try {
            return JSON.parse(result.result)
        } catch (err) {
            throw new Error(`evaluate 结果 JSON 解析失败: ${err}`, { cause: err })
        }
    }

    async find(
        selector?: string,
        text?: string,
        xpath?: string,
        timeout?: number
    ): Promise<
        Array<{
            refId: string
            tag: string
            text: string
            rect: { x: number; y: number; width: number; height: number }
        }>
    > {
        return (await this.httpServer.sendCommand(
            'find',
            {
                tabId: this.requireCurrentTabId(),
                frameId: this.currentFrameId || undefined,
                selector,
                text,
                xpath,
            },
            timeout
        )) as Array<{
            refId: string
            tag: string
            text: string
            rect: { x: number; y: number; width: number; height: number }
        }>
    }

    async getText(selector?: string): Promise<string> {
        const result = (await this.httpServer.sendCommand('get_text', {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId || undefined,
            selector,
        })) as { text: string }
        return result.text
    }

    async getHtml(selector?: string, outer = true): Promise<string> {
        const result = (await this.httpServer.sendCommand('get_html', {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId || undefined,
            selector,
            outer,
        })) as { html: string }
        return result.html
    }

    getPageHtml(selector?: string, outer = true): Promise<string> {
        return this.getHtml(selector, outer)
    }

    getPageText(selector?: string): Promise<string> {
        return this.getText(selector)
    }

    async getConsoleLogs(
        options: { level?: string; pattern?: string; clear?: boolean } = {}
    ): Promise<ConsoleLogEntry[]> {
        const messages = await this.consoleGet(options)
        return messages as ConsoleLogEntry[]
    }

    async getNetworkRequests(options: { urlPattern?: string; clear?: boolean } = {}): Promise<NetworkRequestEntry[]> {
        const requests = await this.networkGet(options)
        return requests as NetworkRequestEntry[]
    }

    async screenshot(options?: {
        format?: string
        quality?: number
        fullPage?: boolean
        scale?: number
        clip?: { x: number; y: number; width: number; height: number }
    }): Promise<ScreenshotResult> {
        return (await this.httpServer.sendCommand('screenshot', {
            tabId: this.requireCurrentTabId(),
            ...options,
        })) as ScreenshotResult
    }

    async getHtmlWithImages(
        selector?: string,
        outer = true
    ): Promise<{
        html: string
        images: Array<{
            index: number
            src: string
            dataSrc: string
            alt: string
            width: number
            height: number
            naturalWidth: number
            naturalHeight: number
        }>
    }> {
        return (await this.httpServer.sendCommand('get_html_with_images', {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId || undefined,
            selector,
            outer,
        })) as {
            html: string
            images: Array<{
                index: number
                src: string
                dataSrc: string
                alt: string
                width: number
                height: number
                naturalWidth: number
                naturalHeight: number
            }>
        }
    }

    async getAttribute(
        selector: string | undefined,
        refId: string | undefined,
        attribute: string
    ): Promise<string | null> {
        const result = (await this.httpServer.sendCommand('get_attribute', {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId || undefined,
            selector,
            refId,
            attribute,
        })) as { value: string | null }
        return result.value
    }

    async getMetadata(): Promise<Record<string, unknown>> {
        return (await this.httpServer.sendCommand('get_metadata', {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId || undefined,
        })) as Record<string, unknown>
    }

    async getFrames(): Promise<Record<string, unknown>> {
        return (await this.httpServer.sendCommand('get_all_frames', {
            tabId: this.requireCurrentTabId(),
        })) as Record<string, unknown>
    }

    async getCookies(filter?: CookieFilter): Promise<
        Array<{
            name: string
            value: string
            domain: string
            path: string
            httpOnly: boolean
            secure: boolean
            sameSite?: string
            expirationDate?: number
            session?: boolean
        }>
    > {
        return (await this.httpServer.sendCommand('cookies_get', filter ?? {})) as Array<{
            name: string
            value: string
            domain: string
            path: string
            httpOnly: boolean
            secure: boolean
            sameSite?: string
            expirationDate?: number
            session?: boolean
        }>
    }

    // ==================== Cookies ====================

    async setCookie(params: SetCookieParams): Promise<void> {
        const sameSiteMap: Record<string, string> = { None: 'no_restriction', Lax: 'lax', Strict: 'strict' }
        const chromeSameSite = params.sameSite ? (sameSiteMap[params.sameSite] ?? params.sameSite) : undefined
        const url = params.url ?? this.state?.url ?? 'http://localhost'
        await this.httpServer.sendCommand('cookies_set', {
            ...params,
            url,
            ...(chromeSameSite !== undefined && { sameSite: chromeSameSite }),
        })
    }

    async deleteCookie(url: string, name: string): Promise<void> {
        await this.httpServer.sendCommand('cookies_delete', { url, name })
    }

    async clearCookies(filter?: CookieFilter): Promise<{ count: number }> {
        return (await this.httpServer.sendCommand('cookies_clear', filter ?? {})) as { count: number }
    }

    async debuggerSend(
        method: string,
        params?: Record<string, unknown>,
        tabId?: number,
        timeout?: number
    ): Promise<unknown> {
        return await this.httpServer.sendCommand(
            'debugger_send',
            {
                tabId: tabId ?? this.requireCurrentTabId(),
                method,
                params,
            },
            timeout
        )
    }

    // ==================== Debugger (CDP via Extension) ====================

    async inputKey(
        type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char',
        options: {
            key?: string
            code?: string
            text?: string
            unmodifiedText?: string
            location?: number
            isKeypad?: boolean
            autoRepeat?: boolean
            windowsVirtualKeyCode?: number
            modifiers?: number
            commands?: string[]
        } = {}
    ): Promise<void> {
        await this.httpServer.sendCommand('input_key', {
            tabId: this.requireCurrentTabId(),
            type,
            ...options,
        })
    }

    // ==================== 输入事件（通过 CDP）====================

    async inputMouse(
        type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel',
        x: number,
        y: number,
        options: {
            button?: 'left' | 'middle' | 'right' | 'back' | 'forward' | 'none'
            clickCount?: number
            deltaX?: number
            deltaY?: number
            modifiers?: number
        } = {}
    ): Promise<void> {
        await this.httpServer.sendCommand('input_mouse', {
            tabId: this.requireCurrentTabId(),
            type,
            x,
            y,
            ...options,
        })
    }

    async inputTouch(
        type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
        touchPoints: Array<{
            x: number
            y: number
            radiusX?: number
            radiusY?: number
            force?: number
            id?: number
        }>
    ): Promise<void> {
        await this.httpServer.sendCommand('input_touch', {
            tabId: this.requireCurrentTabId(),
            type,
            touchPoints,
        })
    }

    async inputType(text: string, delay = 0): Promise<void> {
        await this.httpServer.sendCommand('input_type', {
            tabId: this.requireCurrentTabId(),
            text,
            delay,
        })
    }

    async consoleEnable(): Promise<void> {
        await this.httpServer.sendCommand('console_enable', {
            tabId: this.requireCurrentTabId(),
        })
    }

    // ==================== 控制台日志 ====================

    async consoleGet(
        options: {
            level?: string
            pattern?: string
            clear?: boolean
        } = {}
    ): Promise<
        Array<{
            source: string
            level: string
            text: string
            timestamp: number
            url?: string
            lineNumber?: number
        }>
    > {
        const result = (await this.httpServer.sendCommand('console_get', {
            tabId: this.requireCurrentTabId(),
            ...options,
        })) as {
            messages: Array<{
                source: string
                level: string
                text: string
                timestamp: number
                url?: string
                lineNumber?: number
            }>
        }
        return result.messages
    }

    async networkEnable(): Promise<void> {
        await this.httpServer.sendCommand('network_enable', {
            tabId: this.requireCurrentTabId(),
        })
    }

    // ==================== 网络日志 ====================

    async networkGet(
        options: {
            urlPattern?: string
            clear?: boolean
        } = {}
    ): Promise<
        Array<{
            url: string
            method: string
            status?: number
            type: string
            timestamp: number
            duration?: number
        }>
    > {
        const result = (await this.httpServer.sendCommand('network_get', {
            tabId: this.requireCurrentTabId(),
            ...options,
        })) as {
            requests: Array<{
                url: string
                method: string
                status?: number
                type: string
                timestamp: number
                duration?: number
            }>
        }
        return result.requests
    }

    async stealthType(text: string, delay = 0): Promise<void> {
        if (this.currentTabId === null) {
            throw new DriverCapabilityError('没有当前页面，请先 browse attach 或先 browse open 创建受控页面')
        }
        const params = {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId !== null ? this.currentFrameId : undefined,
            text,
            delay,
        }
        await this.httpServer.sendCommand('stealth_type', params)
    }

    // ==================== Stealth 模式（JS 事件模拟，无 debugger）====================

    async stealthKey(key: string, type: 'down' | 'up' | 'press' = 'press', modifiers: string[] = []): Promise<void> {
        if (this.currentTabId === null) {
            throw new DriverCapabilityError('没有当前页面，请先 browse attach 或先 browse open 创建受控页面')
        }
        const params = {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId !== null ? this.currentFrameId : undefined,
            key,
            type,
            modifiers,
        }
        await this.httpServer.sendCommand('stealth_key', params)
    }

    async stealthClick(x: number, y: number, button = 'left', clickCount = 1, refId?: string): Promise<void> {
        if (this.currentTabId === null) {
            throw new DriverCapabilityError('没有当前页面，请先 browse attach 或先 browse open 创建受控页面')
        }
        const params: {
            tabId: number
            frameId?: number
            x: number
            y: number
            button: string
            clickCount: number
            refId?: string
        } = {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId !== null ? this.currentFrameId : undefined,
            x,
            y,
            button,
            clickCount,
        }
        if (typeof refId === 'string') {
            params.refId = refId
        }
        await this.httpServer.sendCommand('stealth_click', params)
    }

    async stealthMouse(type: string, x: number, y: number, button = 'left'): Promise<void> {
        if (this.currentTabId === null) {
            throw new DriverCapabilityError('没有当前页面，请先 browse attach 或先 browse open 创建受控页面')
        }
        const params = {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId !== null ? this.currentFrameId : undefined,
            type,
            x,
            y,
            button,
        }
        await this.httpServer.sendCommand('stealth_mouse', params)
    }

    async stealthInject(): Promise<void> {
        if (this.currentTabId === null) {
            throw new DriverCapabilityError('没有当前页面，请先 browse attach 或先 browse open 创建受控页面')
        }
        const params = {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId !== null ? this.currentFrameId : undefined,
        }
        await this.httpServer.sendCommand('stealth_inject', params)
    }

    getState(): SimplePageState | null {
        return this.state
    }

    // ==================== 状态管理 ====================

    getCurrentFrameId(): number {
        return this.currentFrameId
    }

    setCurrentFrameId(frameId: number): void {
        this.currentFrameId = frameId
    }

    /**
     * 在指定 iframe 中以 precise 模式执行 JS（通过 contextId 绕过 CSP）
     */
    async evaluateInFrame(
        frameId: number,
        expression: string,
        timeout?: number
    ): Promise<{
        result?: { value?: unknown }
        exceptionDetails?: { text: string }
    }> {
        return (await this.httpServer.sendCommand(
            'evaluate_in_frame',
            {
                tabId: this.requireCurrentTabId(),
                frameId,
                expression,
                returnByValue: true,
                awaitPromise: true,
                timeout,
            },
            timeout
        )) as { result?: { value?: unknown }; exceptionDetails?: { text: string } }
    }

    /**
     * 解析 iframe 选择器/索引 → frameId
     */
    async resolveFrame(frame: string | number): Promise<{ frameId: number; offset: { x: number; y: number } | null }> {
        return (await this.httpServer.sendCommand('resolve_frame', {
            tabId: this.requireCurrentTabId(),
            frame,
        })) as { frameId: number; offset: { x: number; y: number } | null }
    }

    private requireCurrentTabId(): number {
        if (this.currentTabId === null) {
            throw new DriverCapabilityError('没有当前页面，请先 browse attach 或先 browse open 创建受控页面')
        }
        return this.currentTabId
    }

    private normalizePageChange(result: ExtensionPageChangeResult): PageManagementResult {
        return {
            targetId: result.targetId,
            windowId: result.windowId,
            before: this.normalizeAffected(result.before),
            after: this.normalizeAffected(result.after),
        }
    }

    private normalizeAffected(
        value: ExtensionTabSummary | BrowserTopology['windows'][number] | null | undefined
    ): ListedTarget | BrowserTopology['windows'][number] | null | undefined {
        if (!value) {
            return value
        }
        if ('url' in value) {
            return this.tabToTarget(value)
        }
        return {
            ...value,
            tabs: value.tabs.map((tab) => this.tabToTarget(tab as ExtensionTabSummary)),
        }
    }

    private parseTargetId(targetId: string): number {
        const parsed = parseInt(targetId, 10)
        if (isNaN(parsed)) {
            throw new DriverCapabilityError(`无效的 Tab ID: ${targetId}`)
        }
        return parsed
    }

    private tabToTarget(tab: ExtensionTabSummary): ListedTarget {
        return {
            id: tab.id,
            targetId: String(tab.id),
            url: tab.url,
            title: tab.title,
            type: 'page',
            active: tab.active,
            windowId: tab.windowId,
            index: tab.index,
            groupId: tab.groupId,
            pinned: tab.pinned,
            incognito: tab.incognito,
            managed: tab.managed,
            status: tab.status,
        }
    }

    private updateState(page: { url: string; title: string; managed?: boolean }): void {
        this.state = { url: page.url, title: page.title, managed: page.managed }
    }
}
