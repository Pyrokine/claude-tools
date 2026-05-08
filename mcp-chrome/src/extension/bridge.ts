/**
 * Extension Bridge
 *
 * 封装与 Chrome Extension 的通信，提供与 CDP 类似的接口
 * 使用 HTTP + WebSocket 实现
 */

import {
    type CookieFilter,
    DriverCapabilityError,
    type IBrowserDriver,
    type ListedTarget,
    type NewTabResult,
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

    async listTabs(): Promise<
        Array<{
            id: number
            url: string
            title: string
            active: boolean
            windowId?: number
            index?: number
            groupId?: number
            pinned?: boolean
            incognito?: boolean
            managed?: boolean
            status?: string
        }>
    > {
        const result = await this.httpServer.sendCommand('tabs_list', {})
        return result as Array<{
            id: number
            url: string
            title: string
            active: boolean
            windowId?: number
            index?: number
            groupId?: number
            pinned?: boolean
            incognito?: boolean
            managed?: boolean
            status?: string
        }>
    }

    /** IBrowserDriver 接口：列出所有 tab，统一为 ListedTarget 形式（id 字符串化以保持跨 driver 兼容） */
    async listTargets(): Promise<ListedTarget[]> {
        const tabs = await this.listTabs()
        return tabs.map((tab) => ({
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
        }))
    }

    async createTab(url?: string, timeout?: number): Promise<{ id: number; url: string; title: string }> {
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
        const tab = result as { id: number; url: string; title: string }
        // 自动切换到新创建的 tab，后续操作立即生效
        this.currentTabId = tab.id
        this.updateState(tab.url, tab.title)
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
        }
    }

    async closeTab(tabId: number): Promise<void> {
        await this.httpServer.sendCommand('tabs_close', { tabId })
        if (this.currentTabId === tabId) {
            this.currentTabId = null
            this.state = null
        }
    }

    /** IBrowserDriver 接口：关闭页面（targetId 是 chrome tab id 的字符串形式，省略时关闭当前 tab） */
    async closePage(targetId?: string): Promise<void> {
        const tabId = targetId !== undefined ? this.parseTargetId(targetId) : this.currentTabId
        if (tabId === null) {
            throw new DriverCapabilityError('没有可关闭的页面，请指定 targetId')
        }
        await this.closeTab(tabId)
    }

    async activateTab(tabId: number): Promise<void> {
        const result = await this.httpServer.sendCommand('tabs_activate', { tabId })
        const tab = result as { id: number; url: string; title: string }
        this.currentTabId = tab.id
        this.updateState(tab.url, tab.title)
    }

    /** IBrowserDriver 接口：激活页面（切到前台） */
    async activatePage(targetId: string): Promise<void> {
        const tabId = this.parseTargetId(targetId)
        await this.activateTab(tabId)
    }

    /** IBrowserDriver 接口：选择操作目标 tab（不切换前台，只设置当前 currentTabId） */
    async selectPage(targetId: string): Promise<void> {
        this.currentTabId = this.parseTargetId(targetId)
    }

    /** IBrowserDriver 接口：获取当前操作目标 ID（chrome tab id 的字符串形式） */
    getCurrentTargetId(): string | null {
        return this.currentTabId !== null ? String(this.currentTabId) : null
    }

    /** IBrowserDriver 接口：设置当前操作目标 ID */
    setCurrentTargetId(targetId: string | null): void {
        this.currentTabId = targetId !== null ? this.parseTargetId(targetId) : null
    }

    async navigate(url: string, options?: { wait?: string; timeout?: number }): Promise<void> {
        const rpcTimeout = options?.timeout !== undefined ? options.timeout + RPC_MARGIN : undefined
        const params: {
            tabId?: number
            url: string
            waitUntil: string
            timeout?: number
        } = {
            url,
            waitUntil: options?.wait ?? 'load',
            timeout: options?.timeout,
        }
        if (this.currentTabId !== null) {
            params.tabId = this.currentTabId
        }
        const result = await this.httpServer.sendCommand('navigate', params, rpcTimeout)
        const tab = result as { id: number; url: string; title: string }
        this.currentTabId = tab.id
        this.updateState(tab.url, tab.title)
    }

    // ==================== 导航操作 ====================

    async goBack(timeout?: number): Promise<{ url: string; title: string; navigated: boolean }> {
        // 默认：NAV_SIGNAL_WINDOW + 导航等待（默认 30s）+ RPC_MARGIN = 40s
        // 调用方传 timeout 时：timeout 即导航超时 + 信号窗口 + 传输余量
        const rpcTimeout =
            timeout !== undefined ? timeout + NAV_SIGNAL_WINDOW + RPC_MARGIN : 30000 + NAV_SIGNAL_WINDOW + RPC_MARGIN
        const params: { tabId?: number; waitUntil: string; timeout?: number } = {
            waitUntil: 'load',
            timeout,
        }
        if (this.currentTabId !== null) {
            params.tabId = this.currentTabId
        }
        const result = (await this.httpServer.sendCommand('go_back', params, rpcTimeout)) as {
            url: string
            title: string
            navigated: boolean
        }
        this.updateState(result.url, result.title)
        return result
    }

    async goForward(timeout?: number): Promise<{ url: string; title: string; navigated: boolean }> {
        // 默认：NAV_SIGNAL_WINDOW + 导航等待（默认 30s）+ RPC_MARGIN = 40s
        // 调用方传 timeout 时：timeout 即导航超时 + 信号窗口 + 传输余量
        const rpcTimeout =
            timeout !== undefined ? timeout + NAV_SIGNAL_WINDOW + RPC_MARGIN : 30000 + NAV_SIGNAL_WINDOW + RPC_MARGIN
        const params: { tabId?: number; waitUntil: string; timeout?: number } = {
            waitUntil: 'load',
            timeout,
        }
        if (this.currentTabId !== null) {
            params.tabId = this.currentTabId
        }
        const result = (await this.httpServer.sendCommand('go_forward', params, rpcTimeout)) as {
            url: string
            title: string
            navigated: boolean
        }
        this.updateState(result.url, result.title)
        return result
    }

    async reload(ignoreCache = false, waitUntil?: string, timeout?: number): Promise<void> {
        const rpcTimeout = timeout !== undefined ? timeout + RPC_MARGIN : undefined
        const params: {
            tabId?: number
            ignoreCache: boolean
            waitUntil: string
            timeout?: number
        } = {
            ignoreCache,
            waitUntil: waitUntil ?? 'load',
            timeout,
        }
        if (this.currentTabId !== null) {
            params.tabId = this.currentTabId
        }
        const result = await this.httpServer.sendCommand('reload', params, rpcTimeout)
        const tab = result as { url: string; title: string }
        this.updateState(tab.url, tab.title)
    }

    async readPage(options?: {
        filter?: string
        depth?: number
        maxLength?: number
        refId?: string
    }): Promise<{ pageContent: string; viewport: { width: number; height: number }; error?: string }> {
        return (await this.httpServer.sendCommand('read_page', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            ...options,
        })) as { pageContent: string; viewport: { width: number; height: number }; error?: string }
    }

    // ==================== 页面内容 ====================

    async click(refId: string): Promise<void> {
        const result = (await this.httpServer.sendCommand('click', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            refId,
        })) as { success: boolean; error?: string }

        if (!result.success) {
            throw new Error(result.error || 'Click failed')
        }
    }

    // ==================== DOM 操作 ====================

    async actionableClick(
        refId: string,
        force?: boolean
    ): Promise<{
        success: boolean
        error?: string
        reason?: string
        coveringElement?: string
    }> {
        return (await this.httpServer.sendCommand('actionable_click', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            refId,
            force: force ?? false,
        })) as { success: boolean; error?: string; reason?: string; coveringElement?: string }
    }

    async dispatchInput(refId: string, text: string): Promise<{ success: boolean; error?: string }> {
        return (await this.httpServer.sendCommand('dispatch_input', {
            tabId: this.currentTabId,
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
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            srcRefId,
            dstRefId,
        })) as { success: boolean; error?: string; code?: string }
    }

    async getComputedStyle(refId: string, prop: string): Promise<string | null> {
        return (await this.httpServer.sendCommand('get_computed_style', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            refId,
            prop,
        })) as string | null
    }

    async type(refId: string, text: string, clear = false): Promise<void> {
        const result = (await this.httpServer.sendCommand('type', {
            tabId: this.currentTabId,
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
            tabId: this.currentTabId,
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
                tabId: this.currentTabId,
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
            throw new Error(`evaluate 结果 JSON 解析失败: ${err}`)
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
                tabId: this.currentTabId,
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
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            selector,
        })) as { text: string }
        return result.text
    }

    async getHtml(selector?: string, outer = true): Promise<string> {
        const result = (await this.httpServer.sendCommand('get_html', {
            tabId: this.currentTabId,
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
            tabId: this.currentTabId,
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
            tabId: this.currentTabId,
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
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            selector,
            refId,
            attribute,
        })) as { value: string | null }
        return result.value
    }

    async getMetadata(): Promise<Record<string, unknown>> {
        return (await this.httpServer.sendCommand('get_metadata', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
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
                tabId: tabId ?? this.currentTabId,
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
            tabId: this.currentTabId,
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
            tabId: this.currentTabId,
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
            tabId: this.currentTabId,
            type,
            touchPoints,
        })
    }

    async inputType(text: string, delay = 0): Promise<void> {
        await this.httpServer.sendCommand('input_type', {
            tabId: this.currentTabId,
            text,
            delay,
        })
    }

    async consoleEnable(): Promise<void> {
        await this.httpServer.sendCommand('console_enable', {
            tabId: this.currentTabId,
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
            tabId: this.currentTabId,
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
            tabId: this.currentTabId,
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
            tabId: this.currentTabId,
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
        const params: {
            tabId?: number
            frameId?: number
            text: string
            delay: number
        } = {
            text,
            delay,
        }
        if (this.currentTabId !== null) {
            params.tabId = this.currentTabId
        }
        if (this.currentFrameId !== null) {
            params.frameId = this.currentFrameId
        }
        await this.httpServer.sendCommand('stealth_type', params)
    }

    // ==================== Stealth 模式（JS 事件模拟，无 debugger）====================

    async stealthKey(key: string, type: 'down' | 'up' | 'press' = 'press', modifiers: string[] = []): Promise<void> {
        const params: {
            tabId?: number
            frameId?: number
            key: string
            type: 'down' | 'up' | 'press'
            modifiers: string[]
        } = {
            key,
            type,
            modifiers,
        }
        if (this.currentTabId !== null) {
            params.tabId = this.currentTabId
        }
        if (this.currentFrameId !== null) {
            params.frameId = this.currentFrameId
        }
        await this.httpServer.sendCommand('stealth_key', params)
    }

    async stealthClick(x: number, y: number, button = 'left', clickCount = 1, refId?: string): Promise<void> {
        const params: {
            tabId?: number
            frameId?: number
            x: number
            y: number
            button: string
            clickCount: number
            refId?: string
        } = {
            x,
            y,
            button,
            clickCount,
        }
        if (this.currentTabId !== null) {
            params.tabId = this.currentTabId
        }
        if (this.currentFrameId !== null) {
            params.frameId = this.currentFrameId
        }
        if (typeof refId === 'string') {
            params.refId = refId
        }
        await this.httpServer.sendCommand('stealth_click', params)
    }

    async stealthMouse(type: string, x: number, y: number, button = 'left'): Promise<void> {
        const params: {
            tabId?: number
            frameId?: number
            type: string
            x: number
            y: number
            button: string
        } = {
            type,
            x,
            y,
            button,
        }
        if (this.currentTabId !== null) {
            params.tabId = this.currentTabId
        }
        if (this.currentFrameId !== null) {
            params.frameId = this.currentFrameId
        }
        await this.httpServer.sendCommand('stealth_mouse', params)
    }

    async stealthInject(): Promise<void> {
        const params: {
            tabId?: number
            frameId?: number
        } = {}
        if (this.currentTabId !== null) {
            params.tabId = this.currentTabId
        }
        if (this.currentFrameId !== null) {
            params.frameId = this.currentFrameId
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
                tabId: this.currentTabId,
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
            tabId: this.currentTabId,
            frame,
        })) as { frameId: number; offset: { x: number; y: number } | null }
    }

    private parseTargetId(targetId: string): number {
        const parsed = parseInt(targetId, 10)
        if (isNaN(parsed)) {
            throw new DriverCapabilityError(`无效的 Tab ID: ${targetId}`)
        }
        return parsed
    }

    private updateState(url: string, title: string): void {
        this.state = { url, title }
    }
}
