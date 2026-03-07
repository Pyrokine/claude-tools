/**
 * Extension Bridge
 *
 * 封装与 Chrome Extension 的通信，提供与 CDP 类似的接口
 * 使用 HTTP + WebSocket 实现
 */

import {ExtensionHttpServer} from './http-server.js'

/** RPC 传输余量（毫秒）：给网络往返和 Extension 处理留出的额外时间 */
const RPC_MARGIN        = 5000
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

export class ExtensionBridge {
    private httpServer: ExtensionHttpServer
    private currentTabId: number | null   = null
    private currentFrameId: number        = 0
    private state: SimplePageState | null = null

    constructor(options: ExtensionBridgeOptions = {}) {
        this.httpServer = new ExtensionHttpServer({
                                                      port: options.port,
                                                      autoPort: true,
                                                  })
    }

    async start(): Promise<void> {
        await this.httpServer.start()
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

    async listTabs(): Promise<Array<{
        id: number
        url: string
        title: string
        active: boolean
        groupId?: number
        managed?: boolean
    }>> {
        const result = await this.httpServer.sendCommand('tabs_list', {})
        return result as Array<{
            id: number;
            url: string;
            title: string;
            active: boolean;
            groupId?: number;
            managed?: boolean
        }>
    }

    async createTab(url?: string, timeout?: number): Promise<{ id: number; url: string; title: string }> {
        const rpcTimeout  = timeout !== undefined ? timeout + RPC_MARGIN : undefined
        const result      = await this.httpServer.sendCommand('tabs_create', {
            url,
            active: false,
            waitUntil: 'load',
            timeout,
        }, rpcTimeout)
        const tab         = result as { id: number; url: string; title: string }
        // 自动切换到新创建的 tab，后续操作立即生效
        this.currentTabId = tab.id
        this.updateState(tab.url, tab.title)
        return tab
    }

    async closeTab(tabId: number): Promise<void> {
        await this.httpServer.sendCommand('tabs_close', {tabId})
        if (this.currentTabId === tabId) {
            this.currentTabId = null
            this.state        = null
        }
    }

    async activateTab(tabId: number): Promise<void> {
        const result      = await this.httpServer.sendCommand('tabs_activate', {tabId})
        const tab         = result as { id: number; url: string; title: string }
        this.currentTabId = tab.id
        this.updateState(tab.url, tab.title)
    }

    // ==================== 导航操作 ====================

    async navigate(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void> {
        const rpcTimeout = options?.timeout !== undefined ? options.timeout + RPC_MARGIN : undefined
        const result     = await this.httpServer.sendCommand('navigate', {
            tabId: this.currentTabId,
            url,
            waitUntil: options?.waitUntil ?? 'load',
            timeout: options?.timeout,
        }, rpcTimeout)
        const tab        = result as { url: string; title: string }
        this.updateState(tab.url, tab.title)
    }

    async goBack(timeout?: number): Promise<{ url: string; title: string; navigated: boolean }> {
        // 默认：NAV_SIGNAL_WINDOW + 导航等待（默认 30s）+ RPC_MARGIN = 40s
        // 调用方传 timeout 时：timeout 即导航超时 + 信号窗口 + 传输余量
        const rpcTimeout = timeout !== undefined ?
                           timeout + NAV_SIGNAL_WINDOW + RPC_MARGIN :
                           30000 + NAV_SIGNAL_WINDOW + RPC_MARGIN
        const result     = await this.httpServer.sendCommand('go_back', {
            tabId: this.currentTabId,
            waitUntil: 'load',
            timeout,
        }, rpcTimeout) as { url: string; title: string; navigated: boolean }
        this.updateState(result.url, result.title)
        return result
    }

    async goForward(timeout?: number): Promise<{ url: string; title: string; navigated: boolean }> {
        // 默认：NAV_SIGNAL_WINDOW + 导航等待（默认 30s）+ RPC_MARGIN = 40s
        // 调用方传 timeout 时：timeout 即导航超时 + 信号窗口 + 传输余量
        const rpcTimeout = timeout !== undefined ?
                           timeout + NAV_SIGNAL_WINDOW + RPC_MARGIN :
                           30000 + NAV_SIGNAL_WINDOW + RPC_MARGIN
        const result     = await this.httpServer.sendCommand('go_forward', {
            tabId: this.currentTabId,
            waitUntil: 'load',
            timeout,
        }, rpcTimeout) as { url: string; title: string; navigated: boolean }
        this.updateState(result.url, result.title)
        return result
    }

    async reload(ignoreCache = false, waitUntil?: string, timeout?: number): Promise<void> {
        const rpcTimeout = timeout !== undefined ? timeout + RPC_MARGIN : undefined
        const result     = await this.httpServer.sendCommand('reload', {
            tabId: this.currentTabId,
            ignoreCache,
            waitUntil: waitUntil ?? 'load',
            timeout,
        }, rpcTimeout)
        const tab        = result as { url: string; title: string }
        this.updateState(tab.url, tab.title)
    }

    // ==================== 页面内容 ====================

    async readPage(options?: {
        filter?: string
        depth?: number
        maxLength?: number
        refId?: string
    }): Promise<{ pageContent: string; viewport: { width: number; height: number }; error?: string }> {
        return await this.httpServer.sendCommand('read_page', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            ...options,
        }) as { pageContent: string; viewport: { width: number; height: number }; error?: string }
    }

    async screenshot(options?: {
        format?: string;
        quality?: number;
        fullPage?: boolean;
        clip?: { x: number; y: number; width: number; height: number }
    }): Promise<{
        data: string;
        format: string
    }> {
        return await this.httpServer.sendCommand('screenshot', {
            tabId: this.currentTabId,
            ...options,
        }) as { data: string; format: string }
    }

    // ==================== DOM 操作 ====================

    async click(refId: string): Promise<void> {
        const result = await this.httpServer.sendCommand('click', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            refId,
        }) as { success: boolean; error?: string }

        if (!result.success) {
            throw new Error(result.error || 'Click failed')
        }
    }

    async type(refId: string, text: string, clear = false): Promise<void> {
        const result = await this.httpServer.sendCommand('type', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            refId,
            text,
            clear,
        }) as { success: boolean; error?: string }

        if (!result.success) {
            throw new Error(result.error || 'Type failed')
        }
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

    async evaluate(code: string, timeout?: number, budget?: number): Promise<unknown> {
        // budget 覆盖 rpcTimeout：轮询调用方传入端到端预算；一次性调用不传，保留 RPC_MARGIN
        const rpcTimeout = budget ?? (timeout !== undefined ? timeout + RPC_MARGIN : undefined)
        const result     = await this.httpServer.sendCommand('evaluate', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            code,
            timeout,
        }, rpcTimeout) as { success: boolean; result?: string; error?: string }

        if (!result.success) {
            throw new Error(result.error || 'Evaluate failed')
        }

        return result.result ? JSON.parse(result.result) : undefined
    }

    async find(selector?: string, text?: string, xpath?: string, timeout?: number): Promise<Array<{
        refId: string
        tag: string
        text: string
        rect: { x: number; y: number; width: number; height: number }
    }>> {
        return await this.httpServer.sendCommand('find', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            selector,
            text,
            xpath,
        }, timeout) as Array<{
            refId: string
            tag: string
            text: string
            rect: { x: number; y: number; width: number; height: number }
        }>
    }

    async getText(selector?: string): Promise<string> {
        const result = await this.httpServer.sendCommand('get_text', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            selector,
        }) as { text: string }
        return result.text
    }

    async getHtml(selector?: string, outer = true): Promise<string> {
        const result = await this.httpServer.sendCommand('get_html', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            selector,
            outer,
        }) as { html: string }
        return result.html
    }

    async getHtmlWithImages(selector?: string, outer = true): Promise<{
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
        return await this.httpServer.sendCommand('get_html_with_images', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            selector,
            outer,
        }) as {
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

    async getAttribute(
        selector: string | undefined,
        refId: string | undefined,
        attribute: string,
    ): Promise<string | null> {
        const result = await this.httpServer.sendCommand('get_attribute', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            selector,
            refId,
            attribute,
        }) as { value: string | null }
        return result.value
    }

    async getMetadata(): Promise<Record<string, unknown>> {
        return await this.httpServer.sendCommand('get_metadata', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
        }) as Record<string, unknown>
    }

    // ==================== Cookies ====================

    async getCookies(filter?: {
        url?: string
        name?: string
        domain?: string
        path?: string
        secure?: boolean
        session?: boolean
    }): Promise<unknown> {
        return await this.httpServer.sendCommand('cookies_get', filter ?? {})
    }

    async setCookie(params: {
        url: string
        name: string
        value?: string
        domain?: string
        path?: string
        secure?: boolean
        httpOnly?: boolean
        sameSite?: string
        expirationDate?: number
    }): Promise<void> {
        await this.httpServer.sendCommand('cookies_set', params)
    }

    async deleteCookie(url: string, name: string): Promise<void> {
        await this.httpServer.sendCommand('cookies_delete', {url, name})
    }

    async clearCookies(filter?: { url?: string; domain?: string }): Promise<{ count: number }> {
        return await this.httpServer.sendCommand('cookies_clear', filter ?? {}) as { count: number }
    }

    // ==================== Debugger (CDP via Extension) ====================

    async debuggerSend(
        method: string,
        params?: Record<string, unknown>,
        tabId?: number,
        timeout?: number,
    ): Promise<unknown> {
        return await this.httpServer.sendCommand('debugger_send', {
            tabId: tabId ?? this.currentTabId,
            method,
            params,
        }, timeout)
    }

    // ==================== 输入事件（通过 CDP）====================

    async inputKey(type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char', options: {
        key?: string
        code?: string
        text?: string
        windowsVirtualKeyCode?: number
        modifiers?: number
    } = {}): Promise<void> {
        await this.httpServer.sendCommand('input_key', {
            tabId: this.currentTabId,
            type,
            ...options,
        })
    }

    async inputMouse(
        type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel',
        x: number,
        y: number,
        options: {
            button?: 'left' | 'middle' | 'right'
            clickCount?: number
            deltaX?: number
            deltaY?: number
            modifiers?: number
        } = {},
    ): Promise<void> {
        await this.httpServer.sendCommand('input_mouse', {
            tabId: this.currentTabId,
            type,
            x,
            y,
            ...options,
        })
    }

    async inputTouch(type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', touchPoints: Array<{
        x: number
        y: number
        radiusX?: number
        radiusY?: number
        force?: number
        id?: number
    }>): Promise<void> {
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

    // ==================== 控制台日志 ====================

    async consoleEnable(): Promise<void> {
        await this.httpServer.sendCommand('console_enable', {
            tabId: this.currentTabId,
        })
    }

    async consoleGet(options: {
        level?: string
        pattern?: string
        clear?: boolean
    } = {}): Promise<Array<{
        source: string
        level: string
        text: string
        timestamp: number
        url?: string
        lineNumber?: number
    }>> {
        const result = await this.httpServer.sendCommand('console_get', {
            tabId: this.currentTabId,
            ...options,
        }) as {
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

    // ==================== 网络日志 ====================

    async networkEnable(): Promise<void> {
        await this.httpServer.sendCommand('network_enable', {
            tabId: this.currentTabId,
        })
    }

    async networkGet(options: {
        urlPattern?: string
        clear?: boolean
    } = {}): Promise<Array<{
        url: string
        method: string
        status?: number
        type: string
        timestamp: number
        duration?: number
    }>> {
        const result = await this.httpServer.sendCommand('network_get', {
            tabId: this.currentTabId,
            ...options,
        }) as {
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

    // ==================== Stealth 模式（JS 事件模拟，无 debugger）====================

    async stealthType(text: string, delay = 0): Promise<void> {
        await this.httpServer.sendCommand('stealth_type', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            text,
            delay,
        })
    }

    async stealthKey(key: string, type: 'down' | 'up' | 'press' = 'press', modifiers: string[] = []): Promise<void> {
        await this.httpServer.sendCommand('stealth_key', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            key,
            type,
            modifiers,
        })
    }

    async stealthClick(x: number, y: number, button = 'left'): Promise<void> {
        await this.httpServer.sendCommand('stealth_click', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            x,
            y,
            button,
        })
    }

    async stealthMouse(type: string, x: number, y: number, button = 'left'): Promise<void> {
        await this.httpServer.sendCommand('stealth_mouse', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
            type,
            x,
            y,
            button,
        })
    }

    async stealthInject(): Promise<void> {
        await this.httpServer.sendCommand('stealth_inject', {
            tabId: this.currentTabId,
            frameId: this.currentFrameId || undefined,
        })
    }

    // ==================== 状态管理 ====================

    getState(): SimplePageState | null {
        return this.state
    }

    getCurrentTabId(): number | null {
        return this.currentTabId
    }

    setCurrentTabId(tabId: number | null): void {
        this.currentTabId = tabId
    }

    getCurrentFrameId(): number {
        return this.currentFrameId
    }

    setCurrentFrameId(frameId: number): void {
        this.currentFrameId = frameId
    }

    /**
     * 在指定 iframe 中以 precise 模式执行 JS（通过 contextId 绕过 CSP）
     */
    async evaluateInFrame(frameId: number, expression: string, timeout?: number): Promise<{
        result?: { value?: unknown }
        exceptionDetails?: { text: string }
    }> {
        return await this.httpServer.sendCommand('evaluate_in_frame', {
            tabId: this.currentTabId,
            frameId,
            expression,
            returnByValue: true,
            awaitPromise: true,
            timeout,
        }, timeout) as { result?: { value?: unknown }; exceptionDetails?: { text: string } }
    }

    /**
     * 解析 iframe 选择器/索引 → frameId
     */
    async resolveFrame(frame: string | number): Promise<{ frameId: number; offset: { x: number; y: number } | null }> {
        return await this.httpServer.sendCommand('resolve_frame', {
            tabId: this.currentTabId,
            frame,
        }) as { frameId: number; offset: { x: number; y: number } | null }
    }

    private updateState(url: string, title: string): void {
        this.state = {url, title}
    }
}

