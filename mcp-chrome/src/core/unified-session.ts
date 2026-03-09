/**
 * 统一会话管理器
 *
 * 支持两种模式：
 * 1. Extension 模式：通过 Chrome Extension 操作用户浏览器（推荐）
 * 2. CDP 模式：通过 Chrome DevTools Protocol 操作（Fallback）
 */

import {ExtensionBridge} from '../extension/index.js'
import {getSession as getCdpSession} from './session.js'
import type {CdpResultObject, TargetInfo, WaitUntil} from './types.js'
import {extractCdpValue, formatCdpException, MODIFIER_KEYS} from './types.js'

export type ConnectionMode = 'extension' | 'cdp' | 'none'
export type InputMode = 'stealth' | 'precise'  // stealth=JS模拟, precise=debugger API

interface UnifiedSessionState {
    url: string
    title: string
}

class UnifiedSessionManager {
    private static instance: UnifiedSessionManager
    private static readonly CONNECTION_COOLDOWN            = 30000 // 连接失败后 30 秒内不重试
    private extensionBridge: ExtensionBridge | null        = null
    private inputMode: InputMode                           = 'precise'  // 默认使用 precise 模式，可绕过 CSP 限制
    private currentMousePosition: { x: number; y: number } = {x: 0, y: 0}  // 跟踪鼠标位置
    /** 当前按下的修饰键位掩码 */
    private modifiers                                      = 0
    private lastConnectionFailure                          = 0
    private tabSwitchLock: Promise<void>                   = Promise.resolve()  // 串行化 tab 切换，防止并发竞态
    private requireExtension                               = false  // 指定 tabId 或 frame 时为 true，禁止 CDP 回退
    private currentFrameOffset: { x: number; y: number } | null = null  // iframe 在主页面的偏移量（withFrame 期间有效）

    private constructor() {
    }

    static getInstance(): UnifiedSessionManager {
        if (!UnifiedSessionManager.instance) {
            UnifiedSessionManager.instance = new UnifiedSessionManager()
        }
        return UnifiedSessionManager.instance
    }

    /**
     * 启动 Unix Socket 服务器，等待 Native Host 连接
     */
    async startExtensionServer(): Promise<void> {
        if (this.extensionBridge) {
            return // 已经启动
        }

        this.extensionBridge = new ExtensionBridge()

        try {
            await this.extensionBridge.start()
            console.error(`[MCP] Extension HTTP server listening on port ${this.extensionBridge.getPort()}`)
        } catch (error) {
            console.error('[MCP] Failed to start Extension server:', error)
            this.extensionBridge = null
        }
    }

    /**
     * 获取当前连接模式
     */
    getMode(): ConnectionMode {
        if (this.extensionBridge?.isConnected()) {
            return 'extension'
        }
        if (getCdpSession().isConnected()) {
            return 'cdp'
        }
        return 'none'
    }

    /**
     * 获取当前输入模式
     */
    getInputMode(): InputMode {
        return this.inputMode
    }

    /**
     * 获取当前 iframe 在主页面的偏移量（仅 withFrame 期间有效）
     */
    getFrameOffset(): { x: number; y: number } | null {
        return this.currentFrameOffset
    }

    /**
     * 获取当前鼠标位置
     */
    getMousePosition(): { x: number; y: number } {
        return {...this.currentMousePosition}
    }

    /**
     * 设置输入模式
     * @param mode 'stealth' - JS 事件模拟（推荐，不触发调试提示）
     *             'precise' - debugger API（精确但会有调试提示）
     */
    setInputMode(mode: InputMode): void {
        this.inputMode = mode
        console.error(`[MCP] Input mode set to: ${mode}`)
    }

    /**
     * 是否 Extension 已连接
     */
    isExtensionConnected(): boolean {
        return this.extensionBridge?.isConnected() ?? false
    }

    /**
     * 是否启用了 Extension 模式（不管当前是否连接）
     * 用于判断应该使用哪种模式
     */
    isExtensionModeEnabled(): boolean {
        return this.extensionBridge !== null
    }

    /**
     * 启动浏览器（CDP 模式）或等待 Extension 连接
     */
    async launch(options: {
        port?: number
        executablePath?: string
        headless?: boolean
        userDataDir?: string
        incognito?: boolean
        timeout?: number
        stealth?: 'off' | 'safe' | 'aggressive'
    } = {}): Promise<TargetInfo & { mode: ConnectionMode }> {
        // 优先检查 Extension 是否已连接，如果断开则等待重连（受 timeout 约束）
        if (await this.ensureExtensionConnected(options.timeout)) {
            // createTab 会设置 currentTabId，需要加锁
            const tab = await this.withTabLock(async () => {
                return this.extensionBridge!.createTab(undefined, options.timeout)
            })
            return {
                targetId: String(tab.id),
                type: 'page',
                url: tab.url,
                title: tab.title,
                mode: 'extension',
            }
        }

        // Fallback 到 CDP 模式
        const target = await getCdpSession().launch(options)
        return {
            ...target,
            mode: 'cdp',
        }
    }

    /**
     * 列出所有页面
     */
    async listTargets(): Promise<Array<TargetInfo & {
        mode: ConnectionMode
        managed?: boolean
        isActive?: boolean
        windowId?: number
        index?: number
        pinned?: boolean
        incognito?: boolean
        status?: string
    }>> {
        // 优先使用 Extension，如果断开则等待重连
        if (await this.ensureExtensionConnected()) {
            const tabs         = await this.extensionBridge!.listTabs()
            const currentTabId = this.extensionBridge!.getCurrentTabId()
            return tabs.map(tab => ({
                targetId: String(tab.id),
                type: 'page',
                url: tab.url,
                title: tab.title,
                mode: 'extension' as ConnectionMode,
                managed: tab.managed,
                isActive: tab.id === currentTabId,
                windowId: tab.windowId,
                index: tab.index,
                pinned: tab.pinned,
                incognito: tab.incognito,
                status: tab.status,
            }))
        }

        if (getCdpSession().isConnected()) {
            const targets         = await getCdpSession().listTargets()
            const currentTargetId = getCdpSession().getState()?.targetId
            return targets.map(t => ({
                ...t,
                mode: 'cdp' as ConnectionMode,
                isActive: t.targetId === currentTargetId,
            }))
        }

        return []
    }

    /**
     * 导航到 URL
     */
    async navigate(url: string, options: { wait?: WaitUntil; timeout?: number } = {}): Promise<void> {
        if (await this.ensureExtensionConnected(options.timeout)) {
            // 加锁保护 currentTabId，防止并发 withTabId 将命令路由到临时切换的 tab
            await this.withTabLock(async () => {
                await this.extensionBridge!.navigate(url, {
                    waitUntil: options.wait,
                    timeout: options.timeout,
                })
            })
            return
        }

        await getCdpSession().navigate(url, options)
    }

    /**
     * 后退
     */
    async goBack(timeout?: number): Promise<{ navigated: boolean }> {
        if (await this.ensureExtensionConnected(timeout)) {
            return this.withTabLock(async () => {
                const result = await this.extensionBridge!.goBack(timeout)
                return {navigated: result.navigated}
            })
        }
        return getCdpSession().goBack(timeout)
    }

    /**
     * 前进
     */
    async goForward(timeout?: number): Promise<{ navigated: boolean }> {
        if (await this.ensureExtensionConnected(timeout)) {
            return this.withTabLock(async () => {
                const result = await this.extensionBridge!.goForward(timeout)
                return {navigated: result.navigated}
            })
        }
        return getCdpSession().goForward(timeout)
    }

    /**
     * 刷新
     */
    async reload(options: { ignoreCache?: boolean; waitUntil?: string; timeout?: number } = {}): Promise<void> {
        if (await this.ensureExtensionConnected(options.timeout)) {
            await this.withTabLock(async () => {
                await this.extensionBridge!.reload(options.ignoreCache, options.waitUntil, options.timeout)
            })
            return
        }
        await getCdpSession().reload(options)
    }

    /**
     * 读取页面（Accessibility Tree）
     */
    async readPage(options?: {
        filter?: string
        depth?: number
        maxLength?: number
        refId?: string
    }): Promise<{ pageContent: string; viewport: { width: number; height: number }; error?: string }> {
        if (await this.ensureExtensionConnected()) {
            return this.extensionBridge!.readPage(options)
        }

        // CDP 模式使用 getPageState
        const state    = await getCdpSession().getPageState()
        const elements = state.elements || []

        // 构建简单的文本表示
        const lines = elements.map(e => {
            let line = e.role
            if (e.name) {
                line += ` "${e.name}"`
            }
            return line
        })

        return {
            pageContent: lines.join('\n'),
            viewport: state.viewport,
        }
    }

    /**
     * 截图
     */
    async screenshot(options?: {
        format?: string;
        quality?: number;
        fullPage?: boolean;
        scale?: number;
        clip?: { x: number; y: number; width: number; height: number }
    }): Promise<string> {
        if (await this.ensureExtensionConnected()) {
            const result = await this.extensionBridge!.screenshot(options)
            return result.data
        }

        return getCdpSession().screenshot(options?.fullPage, options?.scale, options?.format, options?.quality, options?.clip)
    }

    /**
     * 点击元素
     */
    async click(refId: string): Promise<void> {
        if (await this.ensureExtensionConnected()) {
            await this.extensionBridge!.click(refId)
            return
        }

        // CDP 模式需要通过 Locator
        throw new Error('CDP 模式下请使用 input 工具的 click action')
    }

    /**
     * 输入文本
     */
    async type(refId: string, text: string, clear = false): Promise<void> {
        if (await this.ensureExtensionConnected()) {
            await this.extensionBridge!.type(refId, text, clear)
            return
        }

        throw new Error('CDP 模式下请使用 input 工具')
    }

    /**
     * 滚动
     */
    async scroll(x: number, y: number, refId?: string): Promise<void> {
        if (await this.ensureExtensionConnected()) {
            await this.extensionBridge!.scroll(x, y, refId)
            return
        }

        await getCdpSession().mouseWheel(x, y)
    }

    /**
     * 执行 JavaScript
     *
     * 双路径策略（同 find()）：
     * - 传入 timeout（轮询上下文）：isExtensionConnected() 快速失败，端到端预算受控
     * - 不传 timeout（一次性调用）：ensureExtensionConnected() 允许等待重连（最多 30s）
     *
     * stealth 模式：使用 chrome.scripting.executeScript（受 CSP 限制）
     * precise 模式：使用 debugger API Runtime.evaluate（可绕过 CSP）
     *
     * 使用 args 时 script 必须是函数表达式，如 "(x) => x + 1"。
     * precise 模式通过 callFunctionOn 传递参数（支持大 payload），stealth 模式仍用字符串拼接。
     * @param code JavaScript 代码
     * @param mode 执行模式（stealth/precise）
     * @param timeout 端到端预算（毫秒），同时作为脚本执行超时和 sendCommand 的端到端预算
     * @param args 传递给函数的参数
     */
    async evaluate<T>(code: string, mode?: InputMode, timeout?: number, args?: unknown[], _retried?: boolean): Promise<T> {
        const effectiveMode = mode ?? this.inputMode
        const hasArgs       = args && args.length > 0

        // stealth 模式：args 只能通过字符串拼接（chrome.scripting 不支持协议级参数传递）
        let expression = code
        if (hasArgs && effectiveMode === 'stealth') {
            const argsStr = args.map(a => JSON.stringify(a)).join(', ')
            expression    = `(${code})(${argsStr})`
        }

        const cdpScript = hasArgs ? code : expression

        try {

        if (timeout !== undefined) {
            // 轮询上下文：快速失败，端到端预算受控
            if (!this.isExtensionConnected()) {
                this.assertCdpFallbackAllowed()
                return getCdpSession().evaluate<T>(cdpScript, args, timeout)
            }
        } else {
            // 非轮询上下文：允许等待重连；连接失败时回退 CDP
            if (!(await this.ensureExtensionConnected())) {
                return getCdpSession().evaluate<T>(cdpScript, args, timeout)
            }
        }

        // Extension 路径
        const currentFrameId = this.extensionBridge!.getCurrentFrameId()
        if (effectiveMode === 'precise') {
            // precise + args + 主 frame：使用 callFunctionOn 避免大 payload 字符串拼接
            if (hasArgs && currentFrameId === 0) {
                return this.callFunctionOn<T>(code, args, timeout)
            }

            if (currentFrameId !== 0) {
                // iframe：args 仍用字符串拼接（evaluateInFrame 使用 expression 字符串）
                let iframeExpression = expression
                if (hasArgs) {
                    const argsStr    = args.map(a => JSON.stringify(a)).join(', ')
                    iframeExpression = `(${code})(${argsStr})`
                }
                const result = await this.extensionBridge!.evaluateInFrame(
                    currentFrameId,
                    iframeExpression,
                    timeout,
                ) as {
                    result?: CdpResultObject<T>
                    exceptionDetails?: { text: string; exception?: { className?: string; description?: string } }
                }
                if (result.exceptionDetails) {
                    throw new Error(formatCdpException(result.exceptionDetails))
                }
                return extractCdpValue<T>(result.result)
            }

            // 主 frame，无 args：直接 Runtime.evaluate
            const params: Record<string, unknown> = {
                expression,
                returnByValue: true,
                awaitPromise: true,
            }
            if (timeout !== undefined) {
                params.timeout = timeout
            }
            // timeout 即端到端预算，直接作为 RPC 超时（不额外加 margin）
            const result = await this.extensionBridge!.debuggerSend('Runtime.evaluate', params, undefined, timeout) as {
                result?: CdpResultObject<T>
                exceptionDetails?: { text: string; exception?: { className?: string; description?: string } }
            }

            if (result.exceptionDetails) {
                throw new Error(formatCdpException(result.exceptionDetails))
            }
            return extractCdpValue<T>(result.result)
        }
        return await this.extensionBridge!.evaluate(expression, timeout, timeout) as T
        } catch (err) {
            // 裸 return 语句导致语法错误时，自动包裹 IIFE 重试（仅一次）
            if (!_retried && !hasArgs) {
                const msg = err instanceof Error ? err.message : String(err)
                if (/Illegal return statement|'return' not inside function|Unexpected token 'return'/.test(msg)) {
                    const wrapped = `(() => { ${code} })()`
                    return this.evaluate<T>(wrapped, mode, timeout, undefined, true)
                }
            }
            throw err
        }
    }

    /**
     * 获取页面文本
     */
    async getText(selector?: string): Promise<string> {
        if (await this.ensureExtensionConnected()) {
            return this.extensionBridge!.getText(selector)
        }

        if (selector) {
            return getCdpSession().evaluate<string>(
                `(s => document.querySelector(s)?.textContent || '')`,
                [selector],
            )
        }
        return getCdpSession().evaluate<string>('document.body.innerText')
    }

    /**
     * 获取页面 HTML
     */
    async getHtml(selector?: string, outer = true): Promise<string> {
        if (await this.ensureExtensionConnected()) {
            return this.extensionBridge!.getHtml(selector, outer)
        }

        if (selector) {
            const prop = outer ? 'outerHTML' : 'innerHTML'
            return getCdpSession().evaluate<string>(
                `((s, p) => { const el = document.querySelector(s); return el ? el[p] : ''; })`,
                [selector, prop],
            )
        }
        return getCdpSession().evaluate<string>('document.documentElement.outerHTML')
    }

    /**
     * 获取页面 HTML + 图片元信息
     */
    async getHtmlWithImages(selector?: string, outer = true): Promise<{
        html: string
        images: Array<{ index: number; src: string; dataSrc: string; alt: string; width: number; height: number; naturalWidth: number; naturalHeight: number }>
    }> {
        if (await this.ensureExtensionConnected()) {
            return this.extensionBridge!.getHtmlWithImages(selector, outer)
        }

        // CDP 模式：evaluate 注入函数
        const selectorArg = JSON.stringify(selector ?? null)
        return getCdpSession().evaluate<{
            html: string
            images: Array<{ index: number; src: string; dataSrc: string; alt: string; width: number; height: number; naturalWidth: number; naturalHeight: number }>
        }>(`(function() {
            var root = ${selectorArg} ? document.querySelector(${selectorArg}) : document.documentElement;
            if (!root) return {html: '', images: []};
            var html = ${selectorArg}
                ? (${outer} ? root.outerHTML : root.innerHTML)
                : document.documentElement.outerHTML;
            var imgList = [];
            if (root.tagName === 'IMG') imgList.push(root);
            root.querySelectorAll('img').forEach(function(img) { imgList.push(img); });
            var images = [];
            for (var i = 0; i < imgList.length; i++) {
                var img = imgList[i];
                images.push({index: i, src: img.src, dataSrc: (function() { var raw = img.dataset.src || img.dataset.lazySrc || img.dataset.original || ''; if (!raw) return ''; try { return new URL(raw, location.href).href } catch(e) { return raw } })(), alt: img.alt, width: img.width, height: img.height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight});
            }
            return {html: html, images: images};
        })()`)
    }

    /**
     * 获取页面元信息
     */
    async getMetadata(): Promise<Record<string, unknown>> {
        if (await this.ensureExtensionConnected()) {
            return this.extensionBridge!.getMetadata()
        }

        // CDP 模式：evaluate 注入函数
        return getCdpSession().evaluate<Record<string, unknown>>(`(function() {
            function meta(name) {
                var el = document.querySelector('meta[name="'+name+'"],meta[property="'+name+'"]');
                return el ? el.content || undefined : undefined;
            }
            var og = {}, tw = {};
            document.querySelectorAll('meta[property^="og:"]').forEach(function(m) { og[m.getAttribute('property')] = m.content || ''; });
            document.querySelectorAll('meta[name^="twitter:"]').forEach(function(m) { tw[m.getAttribute('name')] = m.content || ''; });
            var jsonLd = [];
            document.querySelectorAll('script[type="application/ld+json"]').forEach(function(s) {
                try { jsonLd.push(JSON.parse(s.textContent || '')); } catch(e) {}
            });
            var alternates = [];
            document.querySelectorAll('link[rel="alternate"]').forEach(function(l) {
                alternates.push({href: l.href, type: l.getAttribute('type') || undefined, hreflang: l.getAttribute('hreflang') || undefined});
            });
            var feeds = [];
            document.querySelectorAll('link[type="application/rss+xml"],link[type="application/atom+xml"]').forEach(function(l) {
                feeds.push({href: l.href, type: l.getAttribute('type'), title: l.getAttribute('title') || undefined});
            });
            return {
                title: document.title,
                description: meta('description'),
                canonical: (document.querySelector('link[rel="canonical"]') || {}).href || undefined,
                charset: document.characterSet,
                viewport: meta('viewport'),
                og: og, twitter: tw, jsonLd: jsonLd, alternates: alternates, feeds: feeds
            };
        })()`)
    }

    /**
     * 批量从浏览器缓存获取资源内容
     *
     * 只调用一次 Page.enable + Page.getFrameTree，然后逐个获取资源。
     * 并发限制避免 CDP 连接拥塞。
     */
    async getResourceContentBatch(urls: string[], concurrency = 6): Promise<Map<string, { content: string; base64Encoded: boolean }>> {
        const results = new Map<string, { content: string; base64Encoded: boolean }>()
        if (urls.length === 0) {
            return results
        }

        try {
            await this.sendCdpCommand('Page.enable')
            const frameTree = await this.sendCdpCommand('Page.getFrameTree') as {
                frameTree: { frame: { id: string } }
            }
            const frameId = frameTree.frameTree.frame.id

            // 并发控制
            let idx = 0
            const next = async (): Promise<void> => {
                while (idx < urls.length) {
                    const url = urls[idx++]
                    try {
                        const result = await this.sendCdpCommand('Page.getResourceContent', {frameId, url}) as {
                            content: string
                            base64Encoded: boolean
                        }
                        results.set(url, result)
                    } catch {
                        // 单个资源获取失败不影响其他
                    }
                }
            }
            await Promise.all(Array.from({length: Math.min(concurrency, urls.length)}, () => next()))
        } catch {
            // Page.enable 或 getFrameTree 失败，返回空结果
        }

        return results
    }

    /**
     * 查找元素
     *
     * 双路径策略（约束：轮询/预算敏感调用必须传 timeout；一次性调用不传 timeout）：
     * - 传入 timeout（轮询上下文）：isExtensionConnected() 快速失败，不会主动等待重连；
     *   仅在"预检通过但竞态断连落入 sendCommand"时才发生预算内的连接等待
     * - 不传 timeout（一次性调用）：ensureExtensionConnected() 允许等待重连（最多 30s）
     * @param selector CSS 选择器
     * @param text 文本内容
     * @param xpath XPath 表达式
     * @param timeout 端到端预算（毫秒），包含连接等待和请求超时，传给 bridge.find → sendCommand
     */
    async find(selector?: string, text?: string, xpath?: string, timeout?: number): Promise<Array<{
        refId: string
        tag: string
        text: string
        rect: { x: number; y: number; width: number; height: number }
    }>> {
        if (timeout !== undefined) {
            // 轮询上下文：快速失败，端到端预算受控
            if (this.isExtensionConnected()) {
                return this.extensionBridge!.find(selector, text, xpath, timeout)
            }
            this.assertCdpFallbackAllowed()
            return this.findViaCdp(selector, text, xpath, timeout)
        }

        // 非轮询上下文：允许等待重连
        if (await this.ensureExtensionConnected()) {
            return this.extensionBridge!.find(selector, text, xpath)
        }
        return this.findViaCdp(selector, text, xpath)
    }

    /** CDP fallback：通过 Runtime.evaluate 注入 DOM 查询逻辑 */
    private async findViaCdp(selector?: string, text?: string, xpath?: string, timeout?: number): Promise<Array<{
        refId: string
        tag: string
        text: string
        rect: { x: number; y: number; width: number; height: number }
    }>> {
        return getCdpSession().evaluate<Array<{
            refId: string; tag: string; text: string
            rect: { x: number; y: number; width: number; height: number }
        }>>(`function(selector, text, xpath) {
            var elements;
            if (xpath) {
                elements = [];
                var xr = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                for (var i = 0; i < xr.snapshotLength; i++) {
                    var node = xr.snapshotItem(i);
                    if (node instanceof Element) elements.push(node);
                }
            } else if (selector) {
                elements = Array.from(document.querySelectorAll(selector));
            } else {
                elements = Array.from(document.querySelectorAll('*'));
            }
            var results = [];
            for (var j = 0; j < elements.length; j++) {
                var el = elements[j];
                if (text && !(el.textContent || '').includes(text)) continue;
                var rect = el.getBoundingClientRect();
                results.push({
                    refId: '',
                    tag: el.tagName.toLowerCase(),
                    text: (el.textContent || '').trim().substring(0, 100),
                    rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}
                });
                if (results.length >= 50) break;
            }
            return results;
        }`, [selector ?? null, text ?? null, xpath ?? null], timeout)
    }

    /**
     * 获取元素属性
     */
    async getAttribute(
        selector: string | undefined,
        refId: string | undefined,
        attribute: string,
    ): Promise<string | null> {
        if (await this.ensureExtensionConnected()) {
            return this.extensionBridge!.getAttribute(selector, refId, attribute)
        }

        throw new Error('CDP 模式下请使用 extract 工具')
    }

    /**
     * 获取 Cookies
     */
    async getCookies(filter?: {
        url?: string
        name?: string
        domain?: string
        path?: string
        secure?: boolean
        session?: boolean
    }): Promise<unknown> {
        if (await this.ensureExtensionConnected()) {
            return this.extensionBridge!.getCookies(filter)
        }

        // CDP 模式：支持按字段过滤
        const urls    = filter?.url ? [filter.url] : undefined
        const cookies = await getCdpSession().getCookies(urls)
        if (!filter) {
            return cookies
        }

        return cookies.filter((c: {
            name?: string;
            domain?: string;
            path?: string;
            secure?: boolean;
            session?: boolean;
            expires?: number
        }) => {
            if (filter.name && c.name !== filter.name) {
                return false
            }
            if (filter.domain) {
                // 域名匹配：精确匹配或子域匹配（.example.com 匹配 sub.example.com）
                const filterDomain = filter.domain.replace(/^\./, '')
                const cookieDomain = (c.domain ?? '').replace(/^\./, '')
                if (cookieDomain !== filterDomain && !cookieDomain.endsWith('.' + filterDomain)) {
                    return false
                }
            }
            if (filter.path && c.path !== filter.path) {
                return false
            }
            if (filter.secure !== undefined && c.secure !== filter.secure) {
                return false
            }
            if (filter.session !== undefined) {
                // session cookie: expires 为 -1 或 0（CDP 返回 session cookie 的 expires 为 -1）
                const isSession = (c.expires ?? -1) <= 0
                if (filter.session !== isSession) {
                    return false
                }
            }
            return true
        })
    }

    /**
     * 设置 Cookie
     */
    async setCookie(name: string, value: string, options: {
        url?: string
        domain?: string
        path?: string
        secure?: boolean
        httpOnly?: boolean
        sameSite?: 'Strict' | 'Lax' | 'None'
        expirationDate?: number
    } = {}): Promise<void> {
        if (await this.ensureExtensionConnected()) {
            const state = this.extensionBridge!.getState()
            const url   = options.url || state?.url || 'http://localhost'

            // 转换 sameSite 值到 Chrome cookies API 格式
            let chromeSameSite: 'no_restriction' | 'lax' | 'strict' | 'unspecified' | undefined
            if (options.sameSite) {
                const sameSiteMap: Record<string, 'no_restriction' | 'lax' | 'strict'> = {
                    None: 'no_restriction',
                    Lax: 'lax',
                    Strict: 'strict',
                }
                chromeSameSite                                                         = sameSiteMap[options.sameSite]
            }

            await this.extensionBridge!.setCookie({
                                                      url,
                                                      name,
                                                      value,
                                                      domain: options.domain,
                                                      path: options.path,
                                                      secure: options.secure,
                                                      httpOnly: options.httpOnly,
                                                      sameSite: chromeSameSite,
                                                      expirationDate: options.expirationDate,
                                                  })
            return
        }

        await getCdpSession().setCookie(name, value, options)
    }

    /**
     * 删除 Cookie
     */
    async deleteCookie(url: string, name: string): Promise<void> {
        if (await this.ensureExtensionConnected()) {
            await this.extensionBridge!.deleteCookie(url, name)
            return
        }

        await getCdpSession().deleteCookie(name, url)
    }

    /**
     * 清空 Cookies
     */
    async clearCookies(filter?: { url?: string; domain?: string }): Promise<{ count: number }> {
        if (await this.ensureExtensionConnected()) {
            return await this.extensionBridge!.clearCookies(filter)
        }

        // CDP 模式：有 filter 时先获取匹配的 cookies 再逐条删除，无 filter 时清除全部
        if (filter && (filter.url || filter.domain)) {
            // 优先使用 url 过滤缩小范围，减少不必要的遍历
            const urls    = filter.url ? [filter.url] : undefined
            const cookies = await getCdpSession().getCookies(urls) as Array<{
                name: string; domain: string; path: string; secure: boolean
            }>
            let count     = 0
            for (const cookie of cookies) {
                // domain 进一步过滤（url 过滤后可能仍包含不匹配 domain 的 cookie）
                if (filter.domain) {
                    const filterDomain = filter.domain.replace(/^\./, '')
                    const cookieDomain = cookie.domain.replace(/^\./, '')
                    if (cookieDomain !== filterDomain && !cookieDomain.endsWith('.' + filterDomain)) {
                        continue
                    }
                }
                // 构造删除 URL：必须匹配 cookie 自身的 domain/path/secure
                const protocol  = cookie.secure ? 'https:' : 'http:'
                const domain    = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
                const deleteUrl = `${protocol}//${domain}${cookie.path}`
                await getCdpSession().deleteCookie(cookie.name, deleteUrl)
                count++
            }
            return {count}
        }

        await getCdpSession().clearCookies()
        return {count: -1}
    }

    /**
     * 创建新页面
     */
    async newPage(url?: string): Promise<TargetInfo> {
        if (await this.ensureExtensionConnected()) {
            // createTab 会设置 currentTabId，需要加锁
            const tab = await this.withTabLock(async () => {
                return this.extensionBridge!.createTab(url)
            })
            return {
                targetId: String(tab.id),
                type: 'page',
                url: tab.url,
                title: tab.title,
            }
        }

        const target = await getCdpSession().newPage()
        if (url) {
            await getCdpSession().navigate(url)
        }
        return target
    }

    /**
     * 关闭页面
     */
    async closePage(targetId?: string): Promise<void> {
        if (await this.ensureExtensionConnected()) {
            // closeTab 可能触发 currentTabId 重置，需要加锁
            await this.withTabLock(async () => {
                const tabId = targetId
                              ? this.parseTabId(targetId)
                              : this.extensionBridge!.getCurrentTabId()
                if (tabId === null) {
                    throw new Error('没有可关闭的页面，请指定 targetId')
                }
                await this.extensionBridge!.closeTab(tabId)
            })
            return
        }

        await getCdpSession().closePage(targetId)
    }

    /**
     * 激活页面（切到前台）
     */
    async activatePage(targetId: string): Promise<void> {
        if (await this.ensureExtensionConnected()) {
            const tabId = this.parseTabId(targetId)
            await this.withTabLock(async () => {
                await this.extensionBridge!.activateTab(tabId)
            })
            return
        }

        // CDP 模式：attach 到目标并切到前台
        await getCdpSession().attachToTarget(targetId)
        await getCdpSession().activateTarget(targetId)
    }

    /**
     * 选择要操作的页面（不切到前台，只设置当前操作目标）
     */
    async selectPage(targetId: string): Promise<void> {
        if (this.isExtensionConnected()) {
            const tabId = this.parseTabId(targetId)
            await this.withTabLock(async () => {
                this.extensionBridge!.setCurrentTabId(tabId)
            })
            return
        }
        // CDP 模式下需要 attach 到目标 target
        await getCdpSession().attachToTarget(targetId)
    }

    /**
     * 临时切换操作目标 tab，执行完后恢复
     *
     * 用于多 tab 并行场景：指定 tabId 时临时切换到该 tab 执行操作，
     * 不影响 browse attach 设置的默认 tab。
     *
     * 即使不传 tabId，也需要加锁：fn() 内调用 bridge 方法会读取 currentTabId，
     * 不加锁则并发的 withTabId(someId, ...) 可能在 fn() 执行中途修改 currentTabId。
     */
    async withTabId<T>(tabId: string | undefined, fn: () => Promise<T>): Promise<T> {
        // Extension 未连接时不需要锁和 tab 切换（CDP 模式无 currentTabId 竞态）
        if (!this.extensionBridge?.isConnected()) {
            if (tabId) {
                const previousRequireExtension = this.requireExtension
                this.requireExtension          = true
                try {
                    this.assertCdpFallbackAllowed()
                } finally {
                    this.requireExtension = previousRequireExtension
                }
            }
            return fn()
        }

        if (!tabId) {
            // 不切换 tab，但需要加锁保护 currentTabId 不被并发修改
            return this.withTabLock(fn)
        }

        const numericTabId = this.parseTabId(tabId)
        return this.withTabLock(async () => {
            const previousTabId = this.extensionBridge!.getCurrentTabId()
            this.extensionBridge!.setCurrentTabId(numericTabId)
            // tabId 明确指定时，禁止 CDP 回退（CDP 不感知 Extension tab）
            const previousRequireExtension = this.requireExtension
            this.requireExtension          = true
            try {
                return await fn()
            } finally {
                this.requireExtension = previousRequireExtension
                this.extensionBridge!.setCurrentTabId(previousTabId)
            }
        })
    }

    /**
     * 临时切换操作目标 iframe，执行完后恢复
     *
     * frame 支持 CSS 选择器（如 "iframe#main"）或索引（如 0）。
     * 内部通过 Extension 的 resolveFrame 将选择器解析为 Chrome frameId。
     *
     * 与 withTabId 配合使用时，应嵌套在 withTabId 内部：
     * withTabId(tabId, () => withFrame(frame, () => { ... }))
     */
    async withFrame<T>(frame: string | number | undefined, fn: () => Promise<T>): Promise<T> {
        if (frame === undefined) {
            return fn()
        }

        if (!this.extensionBridge?.isConnected()) {
            throw new Error('iframe 穿透需要 Extension 模式')
        }

        const {frameId, offset}        = await this.extensionBridge!.resolveFrame(frame)
        const previousFrameId          = this.extensionBridge!.getCurrentFrameId()
        const previousFrameOffset      = this.currentFrameOffset
        const previousRequireExtension = this.requireExtension
        this.extensionBridge!.setCurrentFrameId(frameId)
        this.currentFrameOffset = offset
        this.requireExtension   = true
        try {
            return await fn()
        } finally {
            this.requireExtension   = previousRequireExtension
            this.currentFrameOffset = previousFrameOffset
            this.extensionBridge!.setCurrentFrameId(previousFrameId)
        }
    }

    /**
     * 获取当前状态
     */
    getState(): UnifiedSessionState | null {
        if (this.extensionBridge?.isConnected()) {
            return this.extensionBridge.getState()
        }

        const cdpState = getCdpSession().getState()
        return cdpState ? {url: cdpState.url, title: cdpState.title} : null
    }

    /**
     * 关闭所有连接
     */
    async close(): Promise<void> {
        if (this.extensionBridge) {
            await this.extensionBridge.stop()
            this.extensionBridge = null
        }

        await getCdpSession().close()
    }

    /**
     * 按下键盘按键
     */
    async keyDown(key: string): Promise<void> {
        if (MODIFIER_KEYS[key]) {
            this.modifiers |= MODIFIER_KEYS[key]
        }
        if (await this.ensureExtensionConnected()) {
            if (this.inputMode === 'stealth') {
                await this.extensionBridge!.stealthKey(key, 'down', this.getModifierNames())
            } else {
                await this.extensionBridge!.inputKey('keyDown', {key, code: key, modifiers: this.modifiers})
            }
            return
        }
        await getCdpSession().keyDown(key)
    }

    /**
     * 释放键盘按键
     */
    async keyUp(key: string): Promise<void> {
        if (await this.ensureExtensionConnected()) {
            if (this.inputMode === 'stealth') {
                await this.extensionBridge!.stealthKey(key, 'up', this.getModifierNames())
            } else {
                await this.extensionBridge!.inputKey('keyUp', {key, code: key, modifiers: this.modifiers})
            }
            if (MODIFIER_KEYS[key]) {
                this.modifiers &= ~MODIFIER_KEYS[key]
            }
            return
        }
        if (MODIFIER_KEYS[key]) {
            this.modifiers &= ~MODIFIER_KEYS[key]
        }
        await getCdpSession().keyUp(key)
    }

    /**
     * 输入文本
     */
    async typeText(text: string, delay = 0): Promise<void> {
        if (await this.ensureExtensionConnected()) {
            if (this.inputMode === 'stealth') {
                await this.extensionBridge!.stealthType(text, delay)
            } else {
                await this.extensionBridge!.inputType(text, delay)
            }
            return
        }
        await getCdpSession().type(text, delay)
    }

    /**
     * 鼠标移动
     */
    async mouseMove(x: number, y: number): Promise<void> {
        this.currentMousePosition = {x, y}  // 更新位置
        if (await this.ensureExtensionConnected()) {
            if (this.inputMode === 'stealth') {
                await this.extensionBridge!.stealthMouse('mousemove', x, y)
            } else {
                await this.extensionBridge!.inputMouse('mouseMoved', x, y, {modifiers: this.modifiers})
            }
            return
        }
        await getCdpSession().mouseMove(x, y)
    }

    /**
     * 鼠标按下
     */
    async mouseDown(button: 'left' | 'middle' | 'right' | 'back' | 'forward' = 'left'): Promise<void> {
        const effectiveButton = (button === 'back' || button === 'forward') ? 'left' : button
        const {x, y}          = this.currentMousePosition  // 使用当前位置

        if (await this.ensureExtensionConnected()) {
            if (this.inputMode === 'stealth') {
                await this.extensionBridge!.stealthMouse('mousedown', x, y, effectiveButton)
            } else {
                await this.extensionBridge!.inputMouse(
                    'mousePressed',
                    x,
                    y,
                    {
                        button: effectiveButton,
                        clickCount: 1,
                        modifiers: this.modifiers,
                    },
                )
            }
            return
        }
        await getCdpSession().mouseDown(effectiveButton)
    }

    /**
     * 鼠标释放
     */
    async mouseUp(button: 'left' | 'middle' | 'right' | 'back' | 'forward' = 'left'): Promise<void> {
        const effectiveButton = (button === 'back' || button === 'forward') ? 'left' : button
        const {x, y}          = this.currentMousePosition  // 使用当前位置

        if (await this.ensureExtensionConnected()) {
            if (this.inputMode === 'stealth') {
                await this.extensionBridge!.stealthMouse('mouseup', x, y, effectiveButton)
            } else {
                await this.extensionBridge!.inputMouse(
                    'mouseReleased',
                    x,
                    y,
                    {button: effectiveButton, clickCount: 1, modifiers: this.modifiers},
                )
            }
            return
        }
        await getCdpSession().mouseUp(effectiveButton)
    }

    /**
     * 鼠标点击（mousedown + mouseup + click 三合一）
     *
     * stealth 模式：原子操作（单次脚本注入完成 mouseover → mousedown → focus → mouseup → click）
     * precise / CDP 模式：mouseDown + mouseUp，浏览器自动合成原生 click 事件
     */
    async mouseClick(button: 'left' | 'middle' | 'right' | 'back' | 'forward' = 'left'): Promise<void> {
        if (this.inputMode === 'stealth' && await this.ensureExtensionConnected()) {
            const effectiveButton = (button === 'back' || button === 'forward') ? 'left' : button
            const {x, y}         = this.currentMousePosition
            await this.extensionBridge!.stealthClick(x, y, effectiveButton)
            return
        }
        await this.mouseDown(button)
        await this.mouseUp(button)
    }

    // ==================== 键鼠输入 ====================
    // stealth 模式：使用 JS 事件模拟，不触发调试提示，推荐用于反检测场景
    // precise 模式：使用 debugger API，精确但会显示"扩展程序正在调试此浏览器"

    /**
     * 鼠标滚轮
     */
    async mouseWheel(deltaX: number, deltaY: number): Promise<void> {
        if (await this.ensureExtensionConnected()) {
            const {x, y} = this.currentMousePosition
            await this.extensionBridge!.inputMouse('mouseWheel', x, y, {deltaX, deltaY, modifiers: this.modifiers})
            return
        }
        await getCdpSession().mouseWheel(deltaX, deltaY)
    }

    /**
     * 注入反检测脚本
     */
    async injectStealth(): Promise<void> {
        if (await this.ensureExtensionConnected()) {
            await this.extensionBridge!.stealthInject()
            return
        }
        throw new Error('CDP 模式下 stealth 脚本在 connect/launch 时通过 stealth 参数自动注入，不支持后续手动注入')
    }

    /**
     * 触摸开始
     */
    async touchStart(x: number, y: number): Promise<void> {
        if (await this.ensureExtensionConnected()) {
            await this.extensionBridge!.inputTouch('touchStart', [{x, y, id: 0}])
            return
        }
        await getCdpSession().touchStart(x, y)
    }

    /**
     * 触摸移动
     */
    async touchMove(x: number, y: number): Promise<void> {
        if (await this.ensureExtensionConnected()) {
            await this.extensionBridge!.inputTouch('touchMove', [{x, y, id: 0}])
            return
        }
        await getCdpSession().touchMove(x, y)
    }

    /**
     * 触摸结束
     */
    async touchEnd(): Promise<void> {
        if (await this.ensureExtensionConnected()) {
            await this.extensionBridge!.inputTouch('touchEnd', [])
            return
        }
        await getCdpSession().touchEnd()
    }

    /**
     * 启用控制台日志捕获
     */
    async enableConsole(): Promise<void> {
        if (await this.ensureExtensionConnected()) {
            await this.extensionBridge!.consoleEnable()
            return
        }
        // CDP 模式已经在 logs 工具中实现
    }

    /**
     * 获取控制台日志
     */
    async getConsoleLogs(options: {
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
        if (await this.ensureExtensionConnected()) {
            return this.extensionBridge!.consoleGet(options)
        }
        // CDP 模式需要单独实现
        return []
    }

    /**
     * 启用网络日志捕获
     */
    async enableNetwork(): Promise<void> {
        if (await this.ensureExtensionConnected()) {
            await this.extensionBridge!.networkEnable()
            return
        }
        // CDP 模式已在 session 中启用 Network.enable
    }

    /**
     * 获取网络请求日志
     */
    async getNetworkRequests(options: {
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
        if (await this.ensureExtensionConnected()) {
            return this.extensionBridge!.networkGet(options)
        }
        return []
    }

    /**
     * 发送 CDP 命令（高级用法）
     *
     * 自动识别 browser-level 域（Target、Browser、SystemInfo、DeviceAccess、IO）不携带 sessionId，
     * 其他域默认携带 sessionId（page-level 命令）。
     */
    async sendCdpCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
        if (await this.ensureExtensionConnected()) {
            return this.extensionBridge!.debuggerSend(method, params)
        }
        // CDP 模式：browser-level 域不携带 sessionId
        const domain              = method.split('.')[0]
        const browserLevelDomains = ['Target', 'Browser', 'SystemInfo', 'DeviceAccess', 'IO']
        if (browserLevelDomains.includes(domain)) {
            return getCdpSession().sendBrowserCommand(method, params)
        }
        return getCdpSession().send(method, params)
    }

    /** 获取当前修饰键名称数组（stealth 模式用） */
    private getModifierNames(): string[] {
        const names: string[] = []
        if (this.modifiers & 1) {
            names.push('alt')
        }
        if (this.modifiers & 2) {
            names.push('ctrl')
        }
        if (this.modifiers & 4) {
            names.push('meta')
        }
        if (this.modifiers & 8) {
            names.push('shift')
        }
        return names
    }

    // ==================== 控制台日志 ====================

    /**
     * 检查 CDP 回退是否允许
     *
     * 当 requireExtension 为 true（tabId 或 frame 已指定）时，CDP 回退会操作错误目标，必须阻止。
     * 允许时返回 false（供 ensureExtensionConnected 直接返回），不允许时抛出。
     */
    private assertCdpFallbackAllowed(): false {
        if (this.requireExtension) {
            throw new Error('Extension 已断开，当前操作需要 Extension（指定 tabId 或 frame）时不可回退 CDP（操作目标不一致）')
        }
        return false
    }

    /**
     * 确保 Extension 已连接，如果断开则等待重连
     * 返回 true 表示 Extension 可用，false 表示应 fallback 到 CDP
     *
     * 设计理念：Server 和 Extension 的启动时机完全独立，无任何要求。
     * - 先装 Extension，一个月/一年后启动 Server → 能连上
     * - 先启动 Server，再打开 Chrome → 能连上
     * - 关闭再打开任何一方 → 能自动重连
     *
     * 超时设为 30 秒：足够等待 Extension 启动，但不会永远卡住。
     *
     * @param maxWait 调用方的端到端预算（毫秒）。传入时取 min(maxWait, 30000) 作为连接等待上限，
     *               避免工具 timeout 被连接等待吞掉。不传则使用默认 30s。
     */
    private async ensureExtensionConnected(maxWait?: number): Promise<boolean> {
        if (!this.extensionBridge) {
            return this.assertCdpFallbackAllowed()
        }
        if (this.extensionBridge.isConnected()) {
            return true
        }
        // CDP 已连接时跳过 Extension 等待，直接使用 CDP 回退
        if (getCdpSession().isConnected()) {
            return this.assertCdpFallbackAllowed()
        }
        // 冷却期内不重复等待，避免每次操作都阻塞 30 秒
        if (Date.now() - this.lastConnectionFailure < UnifiedSessionManager.CONNECTION_COOLDOWN) {
            return this.assertCdpFallbackAllowed()
        }
        // Extension 服务器已启动但断开连接，等待重连
        const waitTimeout = maxWait !== undefined ? Math.min(maxWait, 30000) : 30000
        if (waitTimeout <= 0) {
            return this.assertCdpFallbackAllowed()
        }
        console.error(`[MCP] Waiting for Chrome Extension connection (${waitTimeout}ms timeout)...`)
        console.error('[MCP] Please ensure Chrome is running with MCP Chrome extension installed.')
        const connected = await this.extensionBridge.waitForConnection(waitTimeout)
        if (connected) {
            console.error('[MCP] Chrome Extension connected successfully')
            this.lastConnectionFailure = 0
            return true
        }
        console.error('[MCP] Chrome Extension connection timeout')
        this.lastConnectionFailure = Date.now()
        return this.assertCdpFallbackAllowed()
    }

    // ==================== 网络日志 ====================

    /**
     * 通过 callFunctionOn 执行函数调用
     *
     * 参数通过 CDP 协议结构化传递，避免大 payload 字符串拼接导致的长度限制和转义问题。
     * 要求 code 必须是函数表达式（如 "(x) => x + 1"）。
     */
    private async callFunctionOn<T>(code: string, args: unknown[], timeout?: number): Promise<T> {
        const globalResult = await this.extensionBridge!.debuggerSend('Runtime.evaluate', {
            expression: 'globalThis',
            returnByValue: false,
        }, undefined, timeout) as { result: { objectId: string } }

        try {
            const params: Record<string, unknown> = {
                functionDeclaration: code,
                objectId: globalResult.result.objectId,
                arguments: args.map(a => ({value: a})),
                returnByValue: true,
                awaitPromise: true,
            }
            if (timeout !== undefined) {
                params.timeout = timeout
            }
            const result = await this.extensionBridge!.debuggerSend(
                'Runtime.callFunctionOn',
                params,
                undefined,
                timeout,
            ) as {
                result?: CdpResultObject<T>
                exceptionDetails?: { text: string; exception?: { className?: string; description?: string } }
            }
            if (result.exceptionDetails) {
                throw new Error(formatCdpException(result.exceptionDetails))
            }
            return extractCdpValue<T>(result.result)
        } finally {
            this.extensionBridge!.debuggerSend('Runtime.releaseObject', {
                objectId: globalResult.result.objectId,
            }).catch(() => {
            })
        }
    }

    /**
     * 串行化所有 tab 切换操作，防止并发请求互相覆盖 currentTabId。
     * 调用者：selectPage/activatePage/newPage/closePage/navigate/reload/launch/withTabId。
     *
     * 注意：此锁不可重入。fn() 内禁止调用任何使用 withTabLock 的方法，否则会死锁。
     * 当前所有 fn() 只调用 bridge 的原子操作（createTab/navigate/evaluate 等），不存在此问题。
     */
    private async withTabLock<T>(fn: () => Promise<T>): Promise<T> {
        const previousLock = this.tabSwitchLock
        let releaseLock: () => void
        this.tabSwitchLock = new Promise<void>(resolve => {
            releaseLock = resolve
        })
        try {
            await previousLock
            return await fn()
        } finally {
            releaseLock!()
        }
    }

    // ==================== Debugger 直接访问 ====================

    /**
     * 解析 tab ID 字符串为数字，校验 NaN
     */
    private parseTabId(id: string): number {
        const tabId = parseInt(id, 10)
        if (isNaN(tabId)) {
            throw new Error(`无效的 Tab ID: ${id}`)
        }
        return tabId
    }

}

/**
 * 获取统一会话管理器实例
 */
export function getUnifiedSession(): UnifiedSessionManager {
    return UnifiedSessionManager.getInstance()
}
