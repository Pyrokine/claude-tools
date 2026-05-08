/**
 * 统一会话管理器
 *
 * 支持两种模式：
 * 1. Extension 模式：通过 Chrome Extension 操作用户浏览器（推荐）
 * 2. CDP 模式：通过 Chrome DevTools Protocol 操作（Fallback）
 */

import { ExtensionBridge } from '../extension/index.js'
import type { IBrowserDriver, SetCookieParams } from './browser-driver.js'
import { isExtensionDisconnected } from './extension-errors.js'
import { getKeyDefinition, getSession as getCdpSession } from './session.js'
import type { CdpResultObject, TargetInfo, WaitUntil } from './types.js'
import { extractCdpValue, formatCdpException, MODIFIER_KEYS } from './types.js'

export type ConnectionMode = 'extension' | 'cdp' | 'none'
export type InputMode = 'stealth' | 'precise' // stealth=JS模拟, precise=debugger API

interface UnifiedSessionState {
    url: string
    title: string
}

class UnifiedSessionManager {
    private static instance: UnifiedSessionManager
    private static readonly CONNECTION_COOLDOWN = 30000 // 连接失败后 30 秒内不重试
    private extensionBridge: ExtensionBridge | null = null
    private inputMode: InputMode = 'precise' // 默认使用 precise 模式，可绕过 CSP 限制
    private currentMousePosition: { x: number; y: number } = { x: 0, y: 0 } // 跟踪鼠标位置
    /** 当前按下的修饰键位掩码 */
    private modifiers = 0
    /** 当前按下的所有键（用于 Puppeteer 风格的 rawKeyDown/autoRepeat 长按重复） */
    private pressedKeys = new Set<string>()
    private lastConnectionFailure = 0
    private tabSwitchLock: Promise<void> = Promise.resolve() // 串行化 tab 切换，防止并发竞态
    private requireExtension = false // 指定 tabId 或 frame 时为 true，禁止 CDP 回退
    private currentFrameOffset: { x: number; y: number } | null = null // iframe 在主页面的偏移量（withFrame 期间有效）

    private constructor() {}

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
        return { ...this.currentMousePosition }
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
    async launch(
        options: {
            port?: number
            executablePath?: string
            headless?: boolean
            userDataDir?: string
            incognito?: boolean
            timeout?: number
            stealth?: 'off' | 'safe' | 'aggressive'
        } = {}
    ): Promise<TargetInfo & { mode: ConnectionMode }> {
        // 优先检查 Extension 是否已连接，如果断开则等待重连（受 timeout 约束）
        if (await this.ensureExtensionConnected(options.timeout)) {
            // newPage 会设置 currentTabId，需要加锁
            const result = await this.withTabLock(async () => {
                return this.extensionBridge!.newPage(undefined, options.timeout)
            })
            return {
                targetId: result.targetId,
                type: result.type ?? 'page',
                url: result.url,
                title: result.title,
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
    async listTargets(): Promise<
        Array<
            TargetInfo & {
                mode: ConnectionMode
                managed?: boolean
                isActive?: boolean
                windowId?: number
                index?: number
                pinned?: boolean
                incognito?: boolean
                status?: string
            }
        >
    > {
        const mode = this.getMode()
        if (mode === 'none') {
            return []
        }
        const driver = await this.getDriver()
        const targets = await driver.listTargets()
        return targets.map((t) => ({
            targetId: t.targetId ?? String(t.id),
            type: t.type ?? 'page',
            url: t.url,
            title: t.title,
            mode,
            isActive: t.active ?? false,
            managed: t.managed,
            windowId: t.windowId,
            index: t.index,
            pinned: t.pinned,
            incognito: t.incognito,
            status: t.status,
        }))
    }

    /**
     * 导航到 URL
     */
    async navigate(url: string, options: { wait?: WaitUntil; timeout?: number } = {}): Promise<void> {
        const driver = await this.getDriver(options.timeout)
        await this.withTabLock(() => driver.navigate(url, { wait: options.wait, timeout: options.timeout }))
    }

    async goBack(timeout?: number): Promise<{ navigated: boolean }> {
        const driver = await this.getDriver(timeout)
        const result = await this.withTabLock(() => driver.goBack(timeout))
        return { navigated: result.navigated }
    }

    async goForward(timeout?: number): Promise<{ navigated: boolean }> {
        const driver = await this.getDriver(timeout)
        const result = await this.withTabLock(() => driver.goForward(timeout))
        return { navigated: result.navigated }
    }

    async reload(options: { ignoreCache?: boolean; waitUntil?: string; timeout?: number } = {}): Promise<void> {
        const driver = await this.getDriver(options.timeout)
        await this.withTabLock(() => driver.reload(options.ignoreCache, options.waitUntil, options.timeout))
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
        const driver = await this.getDriver()
        return driver.readPage(options)
    }

    /**
     * 截图
     */
    async screenshot(options?: {
        format?: string
        quality?: number
        fullPage?: boolean
        scale?: number
        clip?: { x: number; y: number; width: number; height: number }
    }): Promise<string> {
        const result = await (await this.getDriver()).screenshot(options)
        return result.data
    }

    /**
     * 点击元素
     */
    async click(refId: string): Promise<void> {
        const driver = await this.getDriver()
        await driver.click(refId)
    }

    /**
     * 带 actionability 检查的点击（Extension 模式）
     *
     * 返回结构化结果，让调用方知道操作是否真正生效
     */
    async actionableClick(
        refId: string,
        force?: boolean
    ): Promise<{
        success: boolean
        error?: string
        reason?: string
        coveringElement?: string
    }> {
        const driver = await this.getDriver()
        return driver.actionableClick(refId, force)
    }

    /**
     * dispatch 模式输入（ISOLATED 世界，兼容 React/Vue 受控组件）
     */
    async dispatchInput(refId: string, text: string): Promise<{ success: boolean; error?: string }> {
        const driver = await this.getDriver()
        return driver.dispatchInput(refId, text)
    }

    /**
     * HTML5 drag/drop（ISOLATED 世界，通过 refId 访问 __mcpElementMap 中的元素引用）
     */
    async dragAndDrop(
        srcRefId: string,
        dstRefId: string
    ): Promise<{ success: boolean; error?: string; code?: string }> {
        const driver = await this.getDriver()
        return driver.dragAndDrop(srcRefId, dstRefId)
    }

    /**
     * 获取元素 computed style（ISOLATED 世界）
     */
    async getComputedStyle(refId: string, prop: string): Promise<string | null> {
        const driver = await this.getDriver()
        return driver.getComputedStyle(refId, prop)
    }

    /**
     * 输入文本
     */
    async type(refId: string, text: string, clear = false): Promise<void> {
        const driver = await this.getDriver()
        await driver.typeRef(refId, text, clear)
    }

    /**
     * 滚动
     */
    async scroll(x: number, y: number, refId?: string): Promise<void> {
        const driver = await this.getDriver()
        await driver.scrollAt(x, y, refId)
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
     * 使用 args 时 script 必须是函数表达式，如 "(x) => x + 1"，
     * precise 模式通过 callFunctionOn 传递参数（支持大 payload），stealth 模式仍用字符串拼接
     * @param code JavaScript 代码
     * @param mode 执行模式（stealth/precise）
     * @param timeout 端到端预算（毫秒），同时作为脚本执行超时和 sendCommand 的端到端预算
     * @param args 传递给函数的参数
     * @param _retried 内部重试标记，外部不应传入
     */
    async evaluate<T>(
        code: string,
        mode?: InputMode,
        timeout?: number,
        args?: unknown[],
        _retried?: boolean
    ): Promise<T> {
        const entryStart = Date.now()
        const effectiveMode = mode ?? this.inputMode
        const hasArgs = args && args.length > 0

        // stealth 模式：args 只能通过字符串拼接（chrome.scripting 不支持协议级参数传递）
        let expression = code
        if (hasArgs && effectiveMode === 'stealth') {
            const argsStr = args.map((a) => JSON.stringify(a)).join(', ')
            expression = `(${code})(${argsStr})`
        }

        const cdpScript = hasArgs ? code : expression

        try {
            if (timeout !== undefined) {
                // 轮询上下文：快速失败，端到端预算受控
                if (!this.isExtensionConnected()) {
                    this.assertCdpFallbackAllowed()
                    return this.evaluateViaCdp<T>(cdpScript, args, timeout)
                }
            } else {
                // 非轮询上下文：允许等待重连；连接失败时回退 CDP
                if (!(await this.ensureExtensionConnected())) {
                    return this.evaluateViaCdp<T>(cdpScript, args, timeout)
                }
            }

            // Extension 路径
            if (effectiveMode === 'precise') {
                return this.evaluateViaExtensionPrecise<T>(code, expression, args, timeout)
            }
            return this.evaluateViaExtensionStealth<T>(expression, timeout)
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            // 计算重试时剩余预算（避免重试用满预算导致总耗时超额）
            const remainingTimeout =
                timeout !== undefined ? Math.max(0, timeout - (Date.now() - entryStart)) : undefined
            // Extension 断连时等待重连后重试一次
            if (!_retried && (isExtensionDisconnected(err) || msg.includes('not connected'))) {
                if (remainingTimeout !== undefined && remainingTimeout <= 0) {
                    throw err
                }
                await new Promise((r) => setTimeout(r, 2000))
                if (this.isExtensionConnected()) {
                    return this.evaluate<T>(code, mode, remainingTimeout, args, true)
                }
                // Extension 重连失败，尝试 CDP fallback
                if (!this.requireExtension) {
                    return this.evaluateViaCdp<T>(cdpScript, args, remainingTimeout)
                }
            }
            // 裸 return 语句导致语法错误时，自动包裹 IIFE 重试（仅一次）
            if (!_retried && !hasArgs) {
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
        return (await this.getDriver()).getPageText(selector)
    }

    async getHtml(selector?: string, outer = true): Promise<string> {
        return (await this.getDriver()).getPageHtml(selector, outer)
    }

    /**
     * 获取页面 HTML + 图片元信息
     */
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
        const driver = await this.getDriver()
        return driver.getHtmlWithImages(selector, outer)
    }

    /**
     * 获取页面元信息
     */
    async getMetadata(): Promise<Record<string, unknown>> {
        const driver = await this.getDriver()
        return driver.getMetadata()
    }

    /**
     * 批量从浏览器缓存获取资源内容
     *
     * 只调用一次 Page.enable + Page.getFrameTree，然后逐个获取资源，
     * 并发限制避免 CDP 连接拥塞
     */
    async getResourceContentBatch(
        urls: string[],
        concurrency = 6
    ): Promise<
        Map<
            string,
            {
                content: string
                base64Encoded: boolean
            }
        >
    > {
        const results = new Map<string, { content: string; base64Encoded: boolean }>()
        if (urls.length === 0) {
            return results
        }

        try {
            await this.sendCdpCommand('Page.enable')
            const frameTree = (await this.sendCdpCommand('Page.getFrameTree')) as {
                frameTree: { frame: { id: string } }
            }
            const frameId = frameTree.frameTree.frame.id

            // 并发控制
            let idx = 0
            const next = async (): Promise<void> => {
                while (idx < urls.length) {
                    const url = urls[idx++]
                    try {
                        const result = (await this.sendCdpCommand('Page.getResourceContent', { frameId, url })) as {
                            content: string
                            base64Encoded: boolean
                        }
                        results.set(url, result)
                    } catch (err) {
                        console.warn('[MCP] 资源获取失败:', url, err)
                    }
                }
            }
            await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => next()))
        } catch (err) {
            console.warn('[MCP] Page 域不可用，返回空资源列表:', err)
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
        if (timeout !== undefined) {
            // 轮询上下文：快速失败，端到端预算受控
            if (this.isExtensionConnected()) {
                return this.extensionBridge!.find(selector, text, xpath, timeout)
            }
            this.assertCdpFallbackAllowed()
            return getCdpSession().find(selector, text, xpath, timeout)
        }

        // 非轮询上下文：允许等待重连，断连时 fallback CDP
        const driver = await this.getDriver()
        return this.withExtensionRetry(
            () => driver.find(selector, text, xpath),
            () => getCdpSession().find(selector, text, xpath)
        )
    }

    /**
     * 获取元素属性
     */
    async getAttribute(
        selector: string | undefined,
        refId: string | undefined,
        attribute: string
    ): Promise<string | null> {
        const driver = await this.getDriver()
        return driver.getAttribute(selector, refId, attribute)
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
        return (await this.getDriver()).getCookies(filter)
    }

    async setCookie(params: SetCookieParams): Promise<void> {
        const driver = await this.getDriver()
        await driver.setCookie(params)
    }

    async deleteCookie(url: string, name: string): Promise<void> {
        return (await this.getDriver()).deleteCookie(url, name)
    }

    async clearCookies(filter?: { url?: string; domain?: string; name?: string }): Promise<{ count: number }> {
        return (await this.getDriver()).clearCookies(filter)
    }

    /**
     * 创建新页面
     */
    async newPage(url?: string): Promise<TargetInfo> {
        const driver = await this.getDriver()
        const isExt = this.isExtensionConnected()
        const op = async (): Promise<TargetInfo> => {
            const result = await driver.newPage(url)
            return {
                targetId: result.targetId,
                type: result.type ?? 'page',
                url: result.url,
                title: result.title,
            }
        }
        // Extension 模式 createTab 设置 currentTabId,需要加锁防止并发竞态
        return isExt ? this.withTabLock(op) : op()
    }

    /**
     * 关闭页面
     */
    async closePage(targetId?: string): Promise<void> {
        const driver = await this.getDriver()
        const isExt = this.isExtensionConnected()
        const op = () => driver.closePage(targetId)
        if (isExt) {
            await this.withTabLock(op)
        } else {
            await op()
        }
    }

    /**
     * 激活页面（切到前台）
     */
    async activatePage(targetId: string): Promise<void> {
        const driver = await this.getDriver()
        const isExt = this.isExtensionConnected()
        const op = () => driver.activatePage(targetId)
        if (isExt) {
            await this.withTabLock(op)
        } else {
            await op()
        }
    }

    /**
     * 选择要操作的页面（不切到前台，只设置当前操作目标）
     */
    async selectPage(targetId: string): Promise<void> {
        const driver = await this.getDriver()
        const isExt = this.isExtensionConnected()
        const op = () => driver.selectPage(targetId)
        if (isExt) {
            await this.withTabLock(op)
        } else {
            await op()
        }
    }

    /**
     * 临时切换操作目标 tab，执行完后恢复
     *
     * 用于多 tab 并行场景：指定 tabId 时临时切换到该 tab 执行操作，
     * 不影响 browse attach 设置的默认 tab
     *
     * 即使不传 tabId，也需要加锁：fn() 内调用 bridge 方法会读取 currentTabId，
     * 不加锁则并发的 withTabId(someId, ...) 可能在 fn() 执行中途修改 currentTabId
     */
    async withTabId<T>(tabId: string | undefined, fn: () => Promise<T>): Promise<T> {
        // Extension 未连接时不需要锁和 tab 切换（CDP 模式无 currentTabId 竞态）
        if (!this.extensionBridge?.isConnected()) {
            if (tabId) {
                const previousRequireExtension = this.requireExtension
                this.requireExtension = true
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

        const driver = this.extensionBridge!
        return this.withTabLock(async () => {
            const previousTargetId = driver.getCurrentTargetId()
            driver.setCurrentTargetId(tabId)
            // tabId 明确指定时，禁止 CDP 回退（CDP 不感知 Extension tab）
            const previousRequireExtension = this.requireExtension
            this.requireExtension = true
            try {
                return await fn()
            } finally {
                this.requireExtension = previousRequireExtension
                driver.setCurrentTargetId(previousTargetId)
            }
        })
    }

    /**
     * 临时切换操作目标 iframe，执行完后恢复
     *
     * frame 支持 CSS 选择器（如 "iframe#main"）或索引（如 0），
     * 内部通过 Extension 的 resolveFrame 将选择器解析为 Chrome frameId
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

        const driver = this.extensionBridge!
        const { frameId, offset } = await driver.resolveFrame(frame)
        const previousFrameId = driver.getCurrentFrameId()
        const previousFrameOffset = this.currentFrameOffset
        const previousRequireExtension = this.requireExtension
        driver.setCurrentFrameId(frameId)
        this.currentFrameOffset = offset
        this.requireExtension = true
        try {
            return await fn()
        } finally {
            // 字段赋值不会 throw,driver.setCurrentFrameId 是同步函数也不会 throw,无需嵌套 try
            this.requireExtension = previousRequireExtension
            this.currentFrameOffset = previousFrameOffset
            driver.setCurrentFrameId(previousFrameId)
        }
    }

    /**
     * 获取当前状态
     */
    getState(): UnifiedSessionState | null {
        // driver.getState() 两侧都返回 DriverState | null（{url, title}），SessionState 含 targetId 是其超集，结构兼容
        if (this.extensionBridge?.isConnected()) {
            return this.extensionBridge.getState()
        }
        return getCdpSession().getState()
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
    async keyDown(key: string, commands?: string[]): Promise<void> {
        const driver = await this.getDriver()
        const isExt = this.isExtensionConnected()

        // 预检查：stealth + commands 必然抛错，要在任何状态变更前抛出，避免 modifiers 污染
        if (isExt && this.inputMode === 'stealth' && commands && commands.length > 0) {
            throw new Error(
                'commands 参数不支持 stealth 输入模式，请先调用 manage action=inputMode inputMode=precise 切换后重试'
            )
        }

        // Puppeteer 风格：连续 keyDown 同 key → rawKeyDown + autoRepeat（长按重复）
        const isRepeat = this.pressedKeys.has(key)
        this.pressedKeys.add(key)

        if (MODIFIER_KEYS[key]) {
            this.modifiers |= MODIFIER_KEYS[key]
        }

        if (isExt && this.inputMode === 'stealth') {
            await driver.stealthKey(key, 'down', this.getModifierNames())
            return
        }

        const def = getKeyDefinition(key)
        await driver.inputKey(isRepeat ? 'rawKeyDown' : 'keyDown', {
            key: def.key,
            code: def.code,
            ...(commands && commands.length > 0 ? {} : { text: def.text }),
            windowsVirtualKeyCode: def.keyCode,
            modifiers: this.modifiers,
            commands,
            autoRepeat: isRepeat || undefined,
        })
    }

    /**
     * 释放键盘按键
     */
    async keyUp(key: string): Promise<void> {
        const driver = await this.getDriver()
        const isExt = this.isExtensionConnected()
        const nextModifiers = MODIFIER_KEYS[key] ? this.modifiers & ~MODIFIER_KEYS[key] : this.modifiers

        if (isExt && this.inputMode === 'stealth') {
            await driver.stealthKey(key, 'up', this.getModifierNames(nextModifiers))
        } else {
            const def = getKeyDefinition(key)
            await driver.inputKey('keyUp', {
                key: def.key,
                code: def.code,
                windowsVirtualKeyCode: def.keyCode,
                modifiers: nextModifiers,
            })
        }
        this.modifiers = nextModifiers
        this.pressedKeys.delete(key)
    }

    /**
     * 输入文本
     */
    async typeText(text: string, delay = 0): Promise<void> {
        const driver = await this.getDriver()
        const isExt = this.isExtensionConnected()
        if (isExt && this.inputMode === 'stealth') {
            await driver.stealthType(text, delay)
        } else {
            await driver.inputType(text, delay)
        }
    }

    /**
     * 鼠标移动
     */
    async mouseMove(x: number, y: number): Promise<void> {
        this.currentMousePosition = { x, y } // 更新位置
        const driver = await this.getDriver()
        const isExt = this.isExtensionConnected()
        if (isExt && this.inputMode === 'stealth') {
            await driver.stealthMouse('mousemove', x, y)
        } else {
            await driver.inputMouse('mouseMoved', x, y, { modifiers: this.modifiers })
        }
    }

    /**
     * 鼠标按下
     */
    async mouseDown(button: 'left' | 'middle' | 'right' | 'back' | 'forward' = 'left', clickCount = 1): Promise<void> {
        const { x, y } = this.currentMousePosition
        const driver = await this.getDriver()
        const isExt = this.isExtensionConnected()
        if (isExt && this.inputMode === 'stealth') {
            await driver.stealthMouse('mousedown', x, y, button)
        } else {
            await driver.inputMouse('mousePressed', x, y, {
                button,
                clickCount,
                modifiers: this.modifiers,
            })
        }
    }

    /**
     * 鼠标释放
     */
    async mouseUp(button: 'left' | 'middle' | 'right' | 'back' | 'forward' = 'left', clickCount = 1): Promise<void> {
        const { x, y } = this.currentMousePosition
        const driver = await this.getDriver()
        const isExt = this.isExtensionConnected()
        if (isExt && this.inputMode === 'stealth') {
            await driver.stealthMouse('mouseup', x, y, button)
        } else {
            await driver.inputMouse('mouseReleased', x, y, {
                button,
                clickCount,
                modifiers: this.modifiers,
            })
        }
    }

    /**
     * 鼠标点击（mousedown + mouseup + click 三合一）
     *
     * stealth 模式：原子操作（单次脚本注入完成 mouseover → mousedown → focus → mouseup → click）
     * precise / CDP 模式：mouseDown + mouseUp，浏览器自动合成原生 click 事件
     */
    async mouseClick(
        button: 'left' | 'middle' | 'right' | 'back' | 'forward' = 'left',
        clickCount = 1,
        refId?: string
    ): Promise<void> {
        const driver = await this.getDriver()
        const isExt = this.isExtensionConnected()
        if (this.inputMode === 'stealth' && isExt) {
            const { x, y } = this.currentMousePosition
            // stealth 通过单次脚本注入完成所有 mouse/click/dblclick/contextmenu 事件
            // refId 透传：嵌套 iframe overlay 场景下绕过 elementFromPoint 命中外层 IFRAME 的问题
            await driver.stealthClick(x, y, button, clickCount, refId)
            return
        }
        // CDP 每次 mousePressed/mouseReleased 递增 clickCount，让浏览器合成 dblclick/tripleclick
        for (let i = 1; i <= clickCount; i++) {
            await this.mouseDown(button, i)
            await this.mouseUp(button, i)
        }
    }

    /**
     * 鼠标滚轮
     */
    async mouseWheel(deltaX: number, deltaY: number): Promise<void> {
        const { x, y } = this.currentMousePosition
        const driver = await this.getDriver()
        await driver.inputMouse('mouseWheel', x, y, { deltaX, deltaY, modifiers: this.modifiers })
    }

    /**
     * 注入反检测脚本
     */
    async injectStealth(): Promise<void> {
        const driver = await this.getDriver()
        await driver.stealthInject()
    }

    /**
     * 触摸开始
     */
    async touchStart(x: number, y: number): Promise<void> {
        const driver = await this.getDriver()
        await driver.inputTouch('touchStart', [{ x, y, id: 0 }])
    }

    /**
     * 触摸移动
     */
    async touchMove(x: number, y: number): Promise<void> {
        const driver = await this.getDriver()
        await driver.inputTouch('touchMove', [{ x, y, id: 0 }])
    }

    /**
     * 触摸结束
     */
    async touchEnd(): Promise<void> {
        const driver = await this.getDriver()
        await driver.inputTouch('touchEnd', [])
    }

    // ==================== 键鼠输入 ====================
    // stealth 模式：使用 JS 事件模拟，不触发调试提示，推荐用于反检测场景
    // precise 模式：使用 debugger API，精确但会显示"扩展程序正在调试此浏览器"

    /**
     * 启用控制台日志捕获
     */
    async enableConsole(): Promise<void> {
        const driver = await this.getDriver()
        await driver.consoleEnable()
    }

    /**
     * 获取控制台日志
     */
    async getConsoleLogs(
        options: { level?: string; pattern?: string; clear?: boolean } = {}
    ): Promise<
        Array<{ source?: string; level: string; text: string; timestamp: number; url?: string; lineNumber?: number }>
    > {
        return (await this.getDriver()).getConsoleLogs(options)
    }

    async getNetworkRequests(
        options: { urlPattern?: string; clear?: boolean } = {}
    ): Promise<
        Array<{ url: string; method: string; status?: number; type: string; timestamp: number; duration?: number }>
    > {
        return (await this.getDriver()).getNetworkRequests(options)
    }

    async enableNetwork(): Promise<void> {
        const driver = await this.getDriver()
        await driver.networkEnable()
    }

    /**
     * 发送 CDP 命令（高级用法）
     *
     * Extension 模式：经 chrome.debugger.sendCommand 转发；
     * CDP 模式：driver 自动识别 browser-level 域（Target/Browser/SystemInfo/DeviceAccess/IO）vs page-level
     */
    async sendCdpCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
        const driver = await this.getDriver()
        return driver.debuggerSend(method, params)
    }

    private evaluateViaCdp<T>(script: string, args: unknown[] | undefined, timeout?: number): Promise<T> {
        return getCdpSession().evaluate<T>(script, args, timeout)
    }

    private async evaluateViaExtensionPrecise<T>(
        code: string,
        expression: string,
        args: unknown[] | undefined,
        timeout?: number
    ): Promise<T> {
        const hasArgs = args !== undefined && args.length > 0
        const currentFrameId = this.extensionBridge!.getCurrentFrameId()

        // precise + args + 主 frame：使用 callFunctionOn 避免大 payload 字符串拼接
        if (hasArgs && currentFrameId === 0) {
            return this.callFunctionOn<T>(code, args!, timeout)
        }

        if (currentFrameId !== 0) {
            // iframe：args 仍用字符串拼接（evaluateInFrame 使用 expression 字符串）
            let iframeExpression = expression
            if (hasArgs) {
                const argsStr = args!.map((a) => JSON.stringify(a)).join(', ')
                iframeExpression = `(${code})(${argsStr})`
            }
            const result = (await this.extensionBridge!.evaluateInFrame(currentFrameId, iframeExpression, timeout)) as {
                result?: CdpResultObject<T>
                exceptionDetails?: { text: string; exception?: { className?: string; description?: string } }
            }
            return this.checkCdpResult<T>(result)
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
        const result = (await this.extensionBridge!.debuggerSend('Runtime.evaluate', params, undefined, timeout)) as {
            result?: CdpResultObject<T>
            exceptionDetails?: { text: string; exception?: { className?: string; description?: string } }
        }
        return this.checkCdpResult<T>(result)
    }

    private async evaluateViaExtensionStealth<T>(expression: string, timeout?: number): Promise<T> {
        return (await this.extensionBridge!.evaluate(expression, undefined, timeout)) as T
    }

    /**
     * Extension 操作断连自动重试
     *
     * 操作失败且错误为断连类型时，等待 2 秒让 Extension 重连后重试一次，
     * 若重连失败且提供了 cdpFallback，则降级到 CDP 模式
     */
    private async withExtensionRetry<T>(operation: () => Promise<T>, cdpFallback?: () => Promise<T>): Promise<T> {
        try {
            return await operation()
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (isExtensionDisconnected(err) || msg.includes('not connected')) {
                // 等待 Extension 重连
                await new Promise((r) => setTimeout(r, 2000))
                if (this.isExtensionConnected()) {
                    return operation()
                }
                if (cdpFallback) {
                    this.assertCdpFallbackAllowed()
                    return cdpFallback()
                }
            }
            throw err
        }
    }

    /** 获取当前修饰键名称数组（stealth 模式用） */
    private getModifierNames(mask = this.modifiers): string[] {
        const names: string[] = []
        if (mask & MODIFIER_KEYS.Alt) {
            names.push('alt')
        }
        if (mask & MODIFIER_KEYS.Control) {
            names.push('ctrl')
        }
        if (mask & MODIFIER_KEYS.Meta) {
            names.push('meta')
        }
        if (mask & MODIFIER_KEYS.Shift) {
            names.push('shift')
        }
        return names
    }

    // ==================== 控制台日志 ====================

    /**
     * 校验 CDP 执行结果，有异常则抛出
     */
    private checkCdpResult<T>(result: {
        result?: CdpResultObject<T>
        exceptionDetails?: { text: string; exception?: { className?: string; description?: string } }
    }): T {
        if (result.exceptionDetails) {
            throw new Error(formatCdpException(result.exceptionDetails))
        }
        return extractCdpValue<T>(result.result)
    }

    /**
     * 检查 CDP 回退是否允许
     *
     * 当 requireExtension 为 true（tabId 或 frame 已指定）时，CDP 回退会操作错误目标，必须阻止，
     * 允许时返回 false（供 ensureExtensionConnected 直接返回），不允许时抛出
     */
    private assertCdpFallbackAllowed(): false {
        if (this.requireExtension) {
            throw new Error(
                'Extension 已断开，当前操作需要 Extension（指定 tabId 或 frame）时不可回退 CDP（操作目标不一致）'
            )
        }
        return false
    }

    /**
     * 确保 Extension 已连接，如果断开则等待重连
     * 返回 true 表示 Extension 可用，false 表示应 fallback 到 CDP
     *
     * 设计理念：Server 和 Extension 的启动时机完全独立，无任何要求
     * - 先装 Extension，一个月/一年后启动 Server → 能连上
     * - 先启动 Server，再打开 Chrome → 能连上
     * - 关闭再打开任何一方 → 能自动重连
     *
     * 超时设为 30 秒：足够等待 Extension 启动，但不会永远卡住
     *
     * @param timeout 调用方的端到端预算（毫秒），传入时取 min(timeout, 30000) 作为连接等待上限，
     *               避免工具 timeout 被连接等待吞掉，不传则使用默认 30s
     */
    private async getDriver(timeout?: number): Promise<IBrowserDriver> {
        if (await this.ensureExtensionConnected(timeout)) {
            return this.extensionBridge!
        }
        return getCdpSession()
    }

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
     * 参数通过 CDP 协议结构化传递，避免大 payload 字符串拼接导致的长度限制和转义问题，
     * 要求 code 必须是函数表达式（如 "(x) => x + 1"）
     */
    private async callFunctionOn<T>(code: string, args: unknown[], timeout?: number): Promise<T> {
        const globalResult = (await this.extensionBridge!.debuggerSend(
            'Runtime.evaluate',
            {
                expression: 'globalThis',
                returnByValue: false,
            },
            undefined,
            timeout
        )) as { result: { objectId: string } }

        try {
            const params: Record<string, unknown> = {
                functionDeclaration: code,
                objectId: globalResult.result.objectId,
                arguments: args.map((a) => ({ value: a })),
                returnByValue: true,
                awaitPromise: true,
            }
            if (timeout !== undefined) {
                params.timeout = timeout
            }
            const result = (await this.extensionBridge!.debuggerSend(
                'Runtime.callFunctionOn',
                params,
                undefined,
                timeout
            )) as {
                result?: CdpResultObject<T>
                exceptionDetails?: { text: string; exception?: { className?: string; description?: string } }
            }
            return this.checkCdpResult<T>(result)
        } finally {
            this.extensionBridge!.debuggerSend('Runtime.releaseObject', {
                objectId: globalResult.result.objectId,
            }).catch(() => {})
        }
    }

    /**
     * 串行化所有 tab 切换操作，防止并发请求互相覆盖 currentTabId，
     * 调用者：selectPage/activatePage/newPage/closePage/navigate/reload/launch/withTabId
     *
     * 注意：此锁不可重入，fn() 内禁止调用任何使用 withTabLock 的方法，否则会死锁，
     * 当前所有 fn() 只调用 bridge 的原子操作（createTab/navigate/evaluate 等），不存在此问题
     */
    private async withTabLock<T>(fn: () => Promise<T>): Promise<T> {
        const previousLock = this.tabSwitchLock
        let releaseLock: () => void
        this.tabSwitchLock = new Promise<void>((resolve) => {
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
}

/**
 * 获取统一会话管理器实例
 */
export function getUnifiedSession(): UnifiedSessionManager {
    return UnifiedSessionManager.getInstance()
}
