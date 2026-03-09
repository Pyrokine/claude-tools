/**
 * 会话管理
 *
 * 管理浏览器会话，包括：
 * - CDP 客户端
 * - 反检测注入
 * - 页面状态
 * - 日志收集
 */

import {BehaviorSimulator, getAntiDetectionScript} from '../anti-detection/index.js'
import {BrowserLauncher, CDPClient, getBrowserWSEndpoint, getTargets} from '../cdp/index.js'
import {AutoWait} from './auto-wait.js'
import {NavigationTimeoutError, SessionNotFoundError, TargetNotFoundError} from './errors.js'
import {Locator} from './locator.js'
import {
    type CdpResultObject,
    type ConnectOptions,
    type ConsoleLogEntry,
    type Cookie,
    type CookieOptions,
    DEFAULT_TIMEOUT,
    extractCdpValue,
    formatCdpException,
    type LaunchOptions,
    MODIFIER_KEYS,
    type NetworkRequestEntry,
    type PageState,
    type Target,
    type TargetInfo,
    type WaitUntil,
} from './types.js'

/**
 * 会话状态
 */
interface SessionState {
    url: string;
    title: string;
    targetId: string;
}

/**
 * 会话管理器（单例）
 */
class SessionManager {
    private static instance: SessionManager
    // 日志收集（环形缓冲区，限制最大条数避免内存泄漏）
    private static readonly MAX_LOG_ENTRIES            = 1000
    private launcher: BrowserLauncher | null           = null
    private cdp: CDPClient | null                      = null
    private connectedPort: number                      = 0
    private sessionId: string | null                   = null
    private currentTargetId: string | null             = null
    private state: SessionState | null                 = null
    private behaviorSimulator                          = new BehaviorSimulator()
    private stealthMode: 'off' | 'safe' | 'aggressive' = 'safe'
    /** 当前按下的修饰键位掩码 */
    private modifiers                                  = 0
    // 操作锁（防止并发竞态）
    private operationLock: Promise<void>               = Promise.resolve()
    private consoleLogs: ConsoleLogEntry[]             = []
    private networkRequests: NetworkRequestEntry[]     = []
    private requestMap                                 = new Map<string, {
        url: string;
        method: string;
        type: string;
        timestamp: number
    }>()

    // 监听器安装标志（防止重复安装）
    private listenersInstalled = false

    private constructor() {
    }

    /**
     * 获取当前调试端口
     */
    get port(): number | null {
        return this.launcher?.port ?? (this.connectedPort || null)
    }

    static getInstance(): SessionManager {
        if (!SessionManager.instance) {
            SessionManager.instance = new SessionManager()
        }
        return SessionManager.instance
    }

    /**
     * 启动浏览器
     *
     * 如果指定了端口，会先尝试连接该端口上已运行的浏览器。
     * 只有连接失败时才启动新浏览器。
     */
    async launch(options: LaunchOptions = {}): Promise<TargetInfo> {
        return this.withLock(async () => {
            const port = options.port ?? 0

            // 如果指定了端口，先尝试连接已运行的浏览器
            if (port > 0) {
                try {
                    const endpoint = await getBrowserWSEndpoint('127.0.0.1', port)
                    // 连接成功，复用已有浏览器
                    this.resetState()
                    this.stealthMode = options.stealth ?? 'safe'
                    this.cdp         = new CDPClient()
                    await this.cdp.connect(endpoint, options.timeout)
                    // 记录端口（connect 模式没有 launcher）
                    this.connectedPort = port

                    // 获取现有页面
                    const targets  = await getTargets('127.0.0.1', port)
                    let pageTarget = targets.find((t) => t.type === 'page')

                    // 如果没有页面或 attach 失败，创建新 tab
                    if (pageTarget) {
                        try {
                            await this.attachToTargetInternal(pageTarget.id)
                        } catch {
                            // attach 失败，创建新 tab
                            pageTarget = undefined
                        }
                    }

                    if (!pageTarget) {
                        // 创建新 tab（在已有窗口）
                        const newTarget = await this.newPageInternal()
                        return {
                            ...newTarget,
                            reused: true,
                        }
                    }

                    return {
                        targetId: pageTarget.id,
                        type: pageTarget.type,
                        url: pageTarget.url,
                        title: pageTarget.title,
                        reused: true,
                    }
                } catch {
                    // 连接失败，继续启动新浏览器
                }
            }

            // 关闭现有会话
            this.resetState()

            // 保存 stealth 模式
            this.stealthMode = options.stealth ?? 'safe'

            // 启动浏览器
            this.launcher  = new BrowserLauncher()
            const endpoint = await this.launcher.launch(options)

            // 连接 CDP
            this.cdp = new CDPClient()
            await this.cdp.connect(endpoint, options.timeout)

            // 获取第一个页面
            const targets    = await getTargets('127.0.0.1', this.launcher.port)
            const pageTarget = targets.find((t) => t.type === 'page')

            if (!pageTarget) {
                throw new Error('未找到页面')
            }

            // 附加到页面
            await this.attachToTargetInternal(pageTarget.id)

            return {
                targetId: pageTarget.id,
                type: pageTarget.type,
                url: pageTarget.url,
                title: pageTarget.title,
            }
        })
    }

    /**
     * 连接到已运行的浏览器
     */
    async connect(options: ConnectOptions): Promise<TargetInfo> {
        return this.withLock(async () => {
            const {host = '127.0.0.1', port, timeout = DEFAULT_TIMEOUT, stealth = 'safe'} = options

            // 关闭现有会话
            this.resetState()

            // 保存 stealth 模式
            this.stealthMode = stealth

            // 获取 WebSocket 端点
            const endpoint = await getBrowserWSEndpoint(host, port)

            // 连接 CDP
            this.cdp = new CDPClient()
            await this.cdp.connect(endpoint, timeout)
            this.connectedPort = port

            // 获取第一个页面
            const targets    = await getTargets(host, port)
            const pageTarget = targets.find((t) => t.type === 'page')

            if (!pageTarget) {
                throw new Error('未找到页面')
            }

            // 附加到页面
            await this.attachToTargetInternal(pageTarget.id)

            return {
                targetId: pageTarget.id,
                type: pageTarget.type,
                url: pageTarget.url,
                title: pageTarget.title,
            }
        })
    }

    /**
     * 列出所有可用页面
     */
    async listTargets(): Promise<TargetInfo[]> {
        this.ensureConnected()

        // 从 CDP 获取 targets
        const {targetInfos} = (await this.cdp!.send('Target.getTargets')) as {
            targetInfos: Array<{
                targetId: string;
                type: string;
                url: string;
                title: string;
            }>;
        }

        return targetInfos
            .filter((t) => t.type === 'page')
            .map((t) => ({
                targetId: t.targetId,
                type: t.type,
                url: t.url,
                title: t.title,
            }))
    }

    /**
     * 附加到指定页面（外部入口，加锁）
     */
    async attachToTarget(targetId: string): Promise<void> {
        return this.withLock(async () => this.attachToTargetInternal(targetId))
    }

    /**
     * 导航到 URL
     */
    async navigate(
        url: string,
        options: { wait?: WaitUntil; timeout?: number } = {},
    ): Promise<void> {
        return this.withLock(async () => {
            this.ensureSession()

            const {wait = 'load', timeout = DEFAULT_TIMEOUT} = options

            // 导航（传 timeout 防止 CDP 默认 30s 截断用户预算）
            const {errorText} = (await this.send('Page.navigate', {url}, timeout)) as {
                errorText?: string;
            }

            if (errorText) {
                throw new NavigationTimeoutError(url, timeout)
            }

            // 根据 wait 类型等待
            if (wait === 'networkidle') {
                await this.waitForNetworkIdle(timeout)
            } else {
                const eventName =
                          wait === 'domcontentloaded'
                          ? 'Page.domContentEventFired'
                          : 'Page.loadEventFired'
                await this.cdp!.waitForEvent(eventName, undefined, timeout)
            }

            // 更新状态
            await this.updateState()
        })
    }

    /**
     * 等待网络空闲（无进行中的请求且持续指定时间）
     *
     * close() 时通过 'disconnected' 信号立即 reject，不必等 timer 超时。
     */
    async waitForNetworkIdle(timeout: number, idleTime: number = 500): Promise<void> {
        this.ensureSession()

        // 捕获当前 cdp 引用，防止 close() 并发置 null 导致回调崩溃
        const cdp = this.cdp!

        // 使用局部 Set 追踪本次等待的请求，避免污染成员变量
        const localPendingRequests = new Set<string>()

        return new Promise((resolve, reject) => {
            let idleTimer: NodeJS.Timeout | null    = null
            let timeoutTimer: NodeJS.Timeout | null = null

            const checkIdle = () => {
                if (localPendingRequests.size === 0) {
                    if (idleTimer === null) {
                        idleTimer = setTimeout(() => {
                            cleanup()
                            resolve()
                        }, idleTime)
                    }
                } else {
                    if (idleTimer !== null) {
                        clearTimeout(idleTimer)
                        idleTimer = null
                    }
                }
            }

            const onRequestStart = (params: unknown) => {
                const {requestId} = params as { requestId: string }
                localPendingRequests.add(requestId)
                checkIdle()
            }

            const onRequestEnd = (params: unknown) => {
                const {requestId} = params as { requestId: string }
                localPendingRequests.delete(requestId)
                checkIdle()
            }

            const cleanup = () => {
                if (idleTimer !== null) {
                    clearTimeout(idleTimer)
                }
                if (timeoutTimer !== null) {
                    clearTimeout(timeoutTimer)
                }
                cdp.offEvent('Network.requestWillBeSent', onRequestStart)
                cdp.offEvent('Network.loadingFinished', onRequestEnd)
                cdp.offEvent('Network.loadingFailed', onRequestEnd)
                cdp.removeListener('disconnected', onDisconnected)
            }

            // 超时处理
            timeoutTimer = setTimeout(() => {
                cleanup()
                reject(new NavigationTimeoutError('networkidle', timeout))
            }, timeout)

            const onDisconnected = () => {
                cleanup()
                reject(new Error('CDP 连接已关闭'))
            }
            cdp.once('disconnected', onDisconnected)

            // 监听网络事件
            cdp.onEvent('Network.requestWillBeSent', onRequestStart)
            cdp.onEvent('Network.loadingFinished', onRequestEnd)
            cdp.onEvent('Network.loadingFailed', onRequestEnd)

            // 初始检查
            checkIdle()
        })
    }

    /**
     * 等待导航完成（跨文档导航或同文档导航）
     */
    async waitForNavigation(timeout: number = DEFAULT_TIMEOUT): Promise<void> {
        this.ensureSession()
        await this.waitForAnyEvent(
            ['Page.loadEventFired', 'Page.navigatedWithinDocument'],
            timeout,
        )
    }

    /**
     * 后退
     */
    async goBack(timeout = DEFAULT_TIMEOUT): Promise<{ navigated: boolean }> {
        return this.withLock(async () => {
            this.ensureSession()
            const {currentIndex, entries} = await this.send<{
                currentIndex: number
                entries: Array<{ id: number; url: string; title: string }>
            }>('Page.getNavigationHistory', undefined, timeout)

            if (currentIndex <= 0) {
                return {navigated: false}
            }

            // 跨文档导航触发 loadEventFired，同文档导航（hash/pushState）触发 navigatedWithinDocument
            const waitPromise = this.waitForAnyEvent(
                ['Page.loadEventFired', 'Page.navigatedWithinDocument'],
                timeout,
            )
            // 预注册 rejection handler：若 send() 抛错导致 waitPromise 永远不被 await，
            // 其 timer reject 不会成为 unhandled rejection（Node 20 默认会退出进程）
            waitPromise.catch(() => {
            })
            await this.send('Page.navigateToHistoryEntry', {entryId: entries[currentIndex - 1].id}, timeout)
            await waitPromise
            await this.updateState()
            return {navigated: true}
        })
    }

    /**
     * 前进
     */
    async goForward(timeout = DEFAULT_TIMEOUT): Promise<{ navigated: boolean }> {
        return this.withLock(async () => {
            this.ensureSession()
            const {currentIndex, entries} = await this.send<{
                currentIndex: number
                entries: Array<{ id: number; url: string; title: string }>
            }>('Page.getNavigationHistory', undefined, timeout)

            if (currentIndex >= entries.length - 1) {
                return {navigated: false}
            }

            // 跨文档导航触发 loadEventFired，同文档导航（hash/pushState）触发 navigatedWithinDocument
            const waitPromise = this.waitForAnyEvent(
                ['Page.loadEventFired', 'Page.navigatedWithinDocument'],
                timeout,
            )
            waitPromise.catch(() => {
            })
            await this.send('Page.navigateToHistoryEntry', {entryId: entries[currentIndex + 1].id}, timeout)
            await waitPromise
            await this.updateState()
            return {navigated: true}
        })
    }

    /**
     * 刷新
     */
    async reload(options: { ignoreCache?: boolean; timeout?: number } = {}): Promise<void> {
        return this.withLock(async () => {
            this.ensureSession()

            const {ignoreCache = false, timeout = DEFAULT_TIMEOUT} = options

            const waitPromise = this.cdp!.waitForEvent(
                'Page.loadEventFired',
                undefined,
                timeout,
            )
            waitPromise.catch(() => {
            })

            await this.send('Page.reload', {ignoreCache}, timeout)

            await waitPromise
            await this.updateState()
        })
    }

    /**
     * 创建定位器
     */
    createLocator(target: Target, options?: { timeout?: number; nth?: number }): Locator {
        this.ensureSession()
        return new Locator(this.cdp!, target, this.sessionId!, {
            ...options,
            nth: options?.nth ?? (target as { nth?: number }).nth,
            getUrl: () => this.state?.url,
        })
    }

    /**
     * 创建自动等待器
     */
    createAutoWait(options?: { timeout?: number }): AutoWait {
        this.ensureSession()
        return new AutoWait(this.cdp!, this.sessionId!, options)
    }

    /**
     * 获取行为模拟器
     */
    getBehaviorSimulator(): BehaviorSimulator {
        return this.behaviorSimulator
    }

    /**
     * 鼠标移动
     */
    async mouseMove(x: number, y: number): Promise<void> {
        this.ensureSession()
        await this.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x,
            y,
            modifiers: this.modifiers,
        })
        this.behaviorSimulator.setCurrentPosition({x, y})
    }

    /**
     * 鼠标按下
     */
    async mouseDown(
        button: 'left' | 'middle' | 'right' | 'back' | 'forward' = 'left',
    ): Promise<void> {
        this.ensureSession()
        await this.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            button,
            clickCount: 1,
            x: this.behaviorSimulator.getCurrentPosition().x,
            y: this.behaviorSimulator.getCurrentPosition().y,
            modifiers: this.modifiers,
        })
    }

    /**
     * 鼠标释放
     */
    async mouseUp(
        button: 'left' | 'middle' | 'right' | 'back' | 'forward' = 'left',
    ): Promise<void> {
        this.ensureSession()
        await this.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            button,
            clickCount: 1,
            x: this.behaviorSimulator.getCurrentPosition().x,
            y: this.behaviorSimulator.getCurrentPosition().y,
            modifiers: this.modifiers,
        })
    }

    /**
     * 滚轮
     */
    async mouseWheel(deltaX: number, deltaY: number): Promise<void> {
        this.ensureSession()
        const pos = this.behaviorSimulator.getCurrentPosition()
        await this.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: pos.x,
            y: pos.y,
            deltaX,
            deltaY,
            modifiers: this.modifiers,
        })
    }

    /**
     * 键盘按下
     */
    async keyDown(key: string): Promise<void> {
        this.ensureSession()
        if (MODIFIER_KEYS[key]) {
            this.modifiers |= MODIFIER_KEYS[key]
        }
        const keyDefinition = getKeyDefinition(key)
        await this.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            modifiers: this.modifiers,
            ...keyDefinition,
        })
    }

    /**
     * 键盘释放
     */
    async keyUp(key: string): Promise<void> {
        this.ensureSession()
        const keyDefinition = getKeyDefinition(key)
        await this.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            modifiers: this.modifiers,
            ...keyDefinition,
        })
        if (MODIFIER_KEYS[key]) {
            this.modifiers &= ~MODIFIER_KEYS[key]
        }
    }

    /**
     * 输入文本
     */
    async type(text: string, delay = 0): Promise<void> {
        this.ensureSession()
        for (const char of text) {
            await this.send('Input.dispatchKeyEvent', {
                type: 'keyDown',
                modifiers: this.modifiers,
                text: char,
            })
            await this.send('Input.dispatchKeyEvent', {
                type: 'keyUp',
                modifiers: this.modifiers,
                text: char,
            })
            if (delay > 0) {
                await new Promise((r) => setTimeout(r, delay))
            }
        }
    }

    /**
     * 触屏开始
     */
    async touchStart(x: number, y: number): Promise<void> {
        this.ensureSession()
        await this.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{x, y}],
        })
    }

    /**
     * 触屏移动
     */
    async touchMove(x: number, y: number): Promise<void> {
        this.ensureSession()
        await this.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{x, y}],
        })
    }

    /**
     * 触屏结束
     */
    async touchEnd(): Promise<void> {
        this.ensureSession()
        await this.send('Input.dispatchTouchEvent', {
            type: 'touchEnd',
            touchPoints: [],
        })
    }

    /**
     * 截图
     */
    async screenshot(
        fullPage = false,
        scale?: number,
        format?: string,
        quality?: number,
        clip?: { x: number; y: number; width: number; height: number },
    ): Promise<string> {
        this.ensureSession()

        const effectiveFormat = format ?? 'png'
        const captureParams: Record<string, unknown> = {format: effectiveFormat}
        if (quality !== undefined && effectiveFormat !== 'png') {
            captureParams.quality = quality
        }
        if (clip) {
            captureParams.clip = {...clip, scale: scale ?? 1}
        }

        if (fullPage) {
            // 获取页面完整高度
            const {result} = (await this.send('Runtime.evaluate', {
                expression:
                    'JSON.stringify({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })',
                returnByValue: true,
            })) as { result: { value: string } }

            const {width, height} = JSON.parse(result.value)

            // 设置视口
            await this.send('Emulation.setDeviceMetricsOverride', {
                width,
                height,
                deviceScaleFactor: scale ?? 1,
                mobile: false,
            })

            try {
                const {data} = (await this.send('Page.captureScreenshot', captureParams)) as { data: string }
                return data
            } finally {
                await this.send('Emulation.clearDeviceMetricsOverride')
            }
        }

        const {data} = (await this.send('Page.captureScreenshot', captureParams)) as { data: string }
        return data
    }

    /**
     * 获取页面状态
     */
    async getPageState(): Promise<PageState> {
        this.ensureSession()

        // 获取基本信息
        const {result} = (await this.send('Runtime.evaluate', {
            expression: `JSON.stringify({
        url: location.href,
        title: document.title,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        }
      })`,
            returnByValue: true,
        })) as { result: { value: string } }

        const state = JSON.parse(result.value) as PageState

        // 获取可交互元素
        await this.send('Accessibility.enable')
        const {nodes} = (await this.send('Accessibility.getFullAXTree')) as {
            nodes: Array<{
                role: { value: string };
                name?: { value: string };
                description?: { value: string };
                properties?: Array<{ name: string; value: { value: unknown } }>;
            }>;
        }

        const interactiveRoles = [
            'button',
            'link',
            'textbox',
            'checkbox',
            'radio',
            'combobox',
            'listbox',
            'menuitem',
            'tab',
            'slider',
            'spinbutton',
            'switch',
        ]

        state.elements = nodes
            .filter((n) => interactiveRoles.includes(n.role?.value?.toLowerCase() ?? ''))
            .map((n) => {
                const props   = n.properties ?? []
                const getProp = (name: string) =>
                    props.find((p) => p.name === name)?.value?.value

                return {
                    role: n.role?.value ?? '',
                    name: n.name?.value ?? '',
                    description: n.description?.value,
                    disabled: getProp('disabled') as boolean | undefined,
                    checked: getProp('checked') as boolean | undefined,
                    value: getProp('value') as string | undefined,
                }
            })

        return state
    }

    /**
     * 获取 Cookies
     * @param urls 可选，限制返回指定 URL 的 cookies
     */
    async getCookies(urls?: string[]): Promise<Cookie[]> {
        this.ensureSession()
        const params    = urls?.length ? {urls} : {}
        const {cookies} = (await this.send('Network.getCookies', params)) as {
            cookies: Cookie[];
        }
        return cookies
    }

    /**
     * 设置 Cookie
     */
    async setCookie(
        name: string,
        value: string,
        options: CookieOptions = {},
    ): Promise<void> {
        this.ensureSession()

        // 获取当前 URL
        const url = this.state?.url ?? 'http://localhost'

        await this.send('Network.setCookie', {
            name,
            value,
            url,
            ...options,
        })
    }

    /**
     * 删除 Cookie
     */
    async deleteCookie(name: string, url?: string): Promise<void> {
        this.ensureSession()
        const effectiveUrl = url ?? this.state?.url ?? 'http://localhost'
        await this.send('Network.deleteCookies', {name, url: effectiveUrl})
    }

    /**
     * 清除所有 Cookies
     */
    async clearCookies(): Promise<void> {
        this.ensureSession()
        await this.send('Network.clearBrowserCookies')
    }

    /**
     * 获取控制台日志
     */
    getConsoleLogs(level?: string, limit = 100): ConsoleLogEntry[] {
        let logs = this.consoleLogs
        if (level && level !== 'all') {
            logs = logs.filter((l) => l.level === level)
        }
        return logs.slice(-limit)
    }

    /**
     * 获取网络请求日志
     */
    getNetworkRequests(urlPattern?: string, limit = 100): NetworkRequestEntry[] {
        let requests = this.networkRequests
        if (urlPattern) {
            const regex = new RegExp(urlPattern.replace(/\*/g, '.*'))
            requests    = requests.filter((r) => regex.test(r.url))
        }
        return requests.slice(-limit)
    }

    /**
     * 清除日志
     */
    clearLogs(): void {
        this.consoleLogs     = []
        this.networkRequests = []
        this.requestMap.clear()
    }

    /**
     * 执行 JavaScript
     */
    async evaluate<T>(script: string, args?: unknown[], timeout?: number): Promise<T> {
        this.ensureSession()

        // CDP 命令超时需大于脚本执行超时，给 WebSocket 通信留余量
        const CDP_MARGIN  = 5000
        const sendTimeout = timeout !== undefined ? timeout + CDP_MARGIN : undefined

        // 有参数时使用 callFunctionOn：避免大 payload 字符串拼接，参数通过协议结构化传递
        if (args && args.length > 0) {
            const {result: globalResult} = (await this.send('Runtime.evaluate', {
                expression: 'globalThis',
                returnByValue: false,
            })) as { result: { objectId: string } }

            try {
                const callParams: Record<string, unknown> = {
                    functionDeclaration: script,
                    objectId: globalResult.objectId,
                    arguments: args.map(a => ({value: a})),
                    returnByValue: true,
                    awaitPromise: true,
                }
                if (timeout !== undefined) {
                    callParams.timeout = timeout
                }
                const {result, exceptionDetails} = (await this.send(
                    'Runtime.callFunctionOn',
                    callParams,
                    sendTimeout,
                )) as {
                    result: CdpResultObject<T>
                    exceptionDetails?: { text: string; exception?: { description?: string } }
                }
                if (exceptionDetails) {
                    throw new Error(formatCdpException(exceptionDetails))
                }
                return extractCdpValue<T>(result)
            } finally {
                this.send('Runtime.releaseObject', {objectId: globalResult.objectId}).catch(() => {
                })
            }
        }

        const evalParams: Record<string, unknown> = {
            expression: script,
            returnByValue: true,
            awaitPromise: true,
        }
        if (timeout !== undefined) {
            evalParams.timeout = timeout
        }
        const {result, exceptionDetails} = (await this.send('Runtime.evaluate', evalParams, sendTimeout)) as {
            result: CdpResultObject<T>
            exceptionDetails?: { text: string; exception?: { description?: string } }
        }

        if (exceptionDetails) {
            throw new Error(formatCdpException(exceptionDetails))
        }

        return extractCdpValue<T>(result)
    }

    /**
     * 设置视口
     */
    async setViewport(width: number, height: number): Promise<void> {
        this.ensureSession()
        await this.send('Emulation.setDeviceMetricsOverride', {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: false,
        })
    }

    /**
     * 设置 User-Agent
     */
    async setUserAgent(userAgent: string): Promise<void> {
        this.ensureSession()
        await this.send('Emulation.setUserAgentOverride', {userAgent})
    }

    /**
     * 清除缓存
     */
    async clearCache(type: 'all' | 'cookies' | 'storage' | 'cache' = 'all'): Promise<void> {
        this.ensureSession()

        if (type === 'all' || type === 'cookies') {
            await this.send('Network.clearBrowserCookies')
        }
        if (type === 'all' || type === 'cache') {
            await this.send('Network.clearBrowserCache')
        }
        if (type === 'all' || type === 'storage') {
            await this.send('Runtime.evaluate', {
                expression: `
          localStorage.clear();
          sessionStorage.clear();
        `,
            })
        }
    }

    /**
     * 新建页面（外部入口，加锁）
     */
    async newPage(): Promise<TargetInfo> {
        return this.withLock(async () => this.newPageInternal())
    }

    /**
     * 激活页面（切到前台）
     */
    async activateTarget(targetId: string): Promise<void> {
        this.ensureConnected()
        // Target 域命令是 browser-level，不携带 sessionId
        await this.cdp!.send('Target.activateTarget', {targetId})
    }

    /**
     * 关闭页面
     */
    async closePage(targetId?: string): Promise<void> {
        return this.withLock(async () => {
            this.ensureConnected()

            const id = targetId ?? this.currentTargetId
            if (!id) {
                throw new TargetNotFoundError('unknown')
            }

            await this.cdp!.send('Target.closeTarget', {targetId: id})

            // 如果关闭的是当前页面，清除会话状态
            if (id === this.currentTargetId) {
                this.sessionId       = null
                this.currentTargetId = null
                this.state           = null
            }
        })
    }

    /**
     * 关闭浏览器（外部接口）
     *
     * 两阶段关闭：
     * 1. 立即关闭 CDP 连接：reject 所有 pending callbacks 和 waitForEvent，
     *    发出 'disconnected' 信号通知 waitForAnyEvent/waitForNetworkIdle 等外部等待者
     * 2. 通过 withLock 串行化状态清理：等 withLock 中的操作处理完错误后再置空引用
     */
    async close(): Promise<void> {
        // Phase 1: 立即关闭 CDP 连接（reject pending callbacks，清除 event listeners）
        if (this.cdp) {
            this.cdp.close()
        }

        // Phase 2: 串行化状态清理（等 withLock 中的操作释放后再执行）
        await this.withLock(async () => {
            this.resetState()
        })
    }

    /**
     * 获取当前状态
     */
    getState(): SessionState | null {
        return this.state
    }

    /**
     * 是否已连接
     */
    isConnected(): boolean {
        return this.cdp !== null && this.cdp.isConnected
    }

    /**
     * 发送 CDP 命令（page-level，携带 sessionId）
     *
     * 每次调用都检查连接状态，防止 close() 并发置空 this.cdp 后崩溃。
     * 多步操作（type 循环、fullPage 截图等）的 await 间隙可能被 close() 打断，
     * ensureSession() 确保在当前 tick 内 this.cdp 非空。
     */
    send<T>(method: string, params?: object, timeout?: number): Promise<T> {
        this.ensureSession()
        return this.cdp!.send(method, params, this.sessionId ?? undefined, timeout)
    }

    /**
     * 发送 browser-level CDP 命令（不携带 sessionId）
     * 用于 Target.*、Browser.* 等浏览器级命令
     */
    sendBrowserCommand<T>(method: string, params?: object): Promise<T> {
        this.ensureConnected()
        return this.cdp!.send(method, params)
    }

    /**
     * 附加到指定页面（内部版本，不加锁，供 launch/connect 等已持锁方法调用）
     */
    private async attachToTargetInternal(targetId: string): Promise<void> {
        this.ensureConnected()

        // 如果已经附加到同一个 target，跳过
        if (this.currentTargetId === targetId && this.sessionId) {
            return
        }

        // 如果有之前的 session，先分离
        if (this.sessionId) {
            try {
                await this.cdp!.send('Target.detachFromTarget', {
                    sessionId: this.sessionId,
                })
            } catch {
                // 忽略分离错误
            }
        }

        // 附加到目标
        const {sessionId} = (await this.cdp!.send('Target.attachToTarget', {
            targetId,
            flatten: true,
        })) as { sessionId: string }

        this.sessionId       = sessionId
        this.currentTargetId = targetId

        // 初始化会话
        await this.initSession()
    }

    /**
     * 新建页面（内部版本，不加锁，供 launch 等已持锁方法调用）
     */
    private async newPageInternal(): Promise<TargetInfo> {
        this.ensureConnected()

        const {targetId} = (await this.cdp!.send('Target.createTarget', {
            url: 'about:blank',
        })) as { targetId: string }

        await this.attachToTargetInternal(targetId)

        return {
            targetId,
            type: 'page',
            url: 'about:blank',
            title: '',
        }
    }

    /**
     * 重置所有状态（同步，不加锁）
     *
     * 供已持有 withLock 的方法调用（launch/connect），避免 close() 的 withLock 重入死锁。
     * 外部调用请使用 close()。
     */
    private resetState(): void {
        if (this.cdp) {
            this.cdp.close()
            this.cdp = null
        }

        if (this.launcher) {
            this.launcher.close()
            this.launcher = null
        }

        this.clearLogs()
        this.modifiers = 0
        this.behaviorSimulator.setCurrentPosition({x: 0, y: 0})
        this.sessionId          = null
        this.currentTargetId    = null
        this.state              = null
        this.listenersInstalled = false
        this.connectedPort      = 0
    }

    /**
     * 串行执行操作（防止并发竞态）
     */
    private async withLock<T>(fn: () => Promise<T>): Promise<T> {
        const previousLock = this.operationLock
        let releaseLock: () => void
        this.operationLock = new Promise<void>((resolve) => {
            releaseLock = resolve
        })
        try {
            await previousLock
            return await fn()
        } finally {
            releaseLock!()
        }
    }

    /**
     * 等待多个事件中的任一个触发
     *
     * 用于同时监听跨文档导航 (loadEventFired) 和同文档导航 (navigatedWithinDocument)，
     * 任一事件触发后清理所有监听器和超时定时器。
     * close() 时通过 'disconnected' 信号立即 reject，不必等 timer 超时。
     */
    private waitForAnyEvent(events: string[], timeout: number): Promise<void> {
        // 捕获当前 cdp 引用，防止 close() 并发置 null 导致回调崩溃
        const cdp = this.cdp
        if (!cdp) {
            return Promise.reject(new Error('CDP 连接已关闭'))
        }

        return new Promise((resolve, reject) => {
            const listeners: Array<{ event: string; listener: (params: unknown) => void }> = []

            const cleanup = () => {
                clearTimeout(timer)
                for (const {event, listener} of listeners) {
                    cdp.offEvent(event, listener)
                }
                cdp.removeListener('disconnected', onDisconnected)
            }

            const timer = setTimeout(() => {
                cleanup()
                reject(new NavigationTimeoutError('navigation', timeout))
            }, timeout)

            const onDisconnected = () => {
                cleanup()
                reject(new Error('CDP 连接已关闭'))
            }
            cdp.once('disconnected', onDisconnected)

            for (const event of events) {
                const listener = () => {
                    cleanup()
                    resolve()
                }
                listeners.push({event, listener})
                cdp.onEvent(event, listener)
            }
        })
    }

    /**
     * 初始化会话
     */
    private async initSession(): Promise<void> {
        // 启用必要的域
        await Promise.all([
                              this.send('Page.enable'),
                              this.send('DOM.enable'),
                              this.send('Runtime.enable'),
                              this.send('Network.enable'),
                              this.send('Log.enable'),
                          ])

        // 根据 stealth 模式注入反检测脚本
        if (this.stealthMode !== 'off') {
            const script = getAntiDetectionScript(this.stealthMode)
            await this.send('Page.addScriptToEvaluateOnNewDocument', {
                source: script,
            })
            // 对当前页面立即执行反检测脚本
            await this.send('Runtime.evaluate', {
                expression: script,
            })
        }

        // 监听事件
        this.setupEventListeners()

        // 更新状态
        await this.updateState()
    }

    /**
     * 设置事件监听（幂等，只安装一次）
     */
    private setupEventListeners(): void {
        if (this.listenersInstalled) {
            return
        }
        this.listenersInstalled = true

        // 控制台日志
        this.cdp!.onEvent('Runtime.consoleAPICalled', (params: unknown) => {
            const p = params as {
                type: string;
                args: Array<{ value?: unknown; description?: string }>;
                timestamp: number;
                stackTrace?: { callFrames: Array<{ url: string; lineNumber: number }> };
            }
            this.consoleLogs.push({
                                      level: p.type,
                                      text: p.args.map((a) => a.value ?? a.description ?? '').join(' '),
                                      timestamp: p.timestamp,
                                      url: p.stackTrace?.callFrames[0]?.url,
                                      lineNumber: p.stackTrace?.callFrames[0]?.lineNumber,
                                  })
            // 环形缓冲区：超出上限时移除最旧的条目
            if (this.consoleLogs.length > SessionManager.MAX_LOG_ENTRIES) {
                this.consoleLogs.shift()
            }
        })

        // 网络请求
        this.cdp!.onEvent('Network.requestWillBeSent', (params: unknown) => {
            const p = params as {
                requestId: string;
                request: { url: string; method: string };
                type: string;
                timestamp: number;
            }
            this.requestMap.set(p.requestId, {
                url: p.request.url,
                method: p.request.method,
                type: p.type,
                timestamp: p.timestamp,
            })
        })

        this.cdp!.onEvent('Network.responseReceived', (params: unknown) => {
            const p       = params as {
                requestId: string;
                response: { status: number };
                timestamp: number;
            }
            const request = this.requestMap.get(p.requestId)
            if (request) {
                this.networkRequests.push({
                                              ...request,
                                              status: p.response.status,
                                              duration: (p.timestamp - request.timestamp) * 1000,
                                          })
                // 环形缓冲区：超出上限时移除最旧的条目
                if (this.networkRequests.length > SessionManager.MAX_LOG_ENTRIES) {
                    this.networkRequests.shift()
                }
                this.requestMap.delete(p.requestId)
            }
        })

        // 网络请求失败时清理 requestMap，防止泄漏
        this.cdp!.onEvent('Network.loadingFailed', (params: unknown) => {
            const p = params as { requestId: string }
            this.requestMap.delete(p.requestId)
        })
    }

    /**
     * 更新页面状态
     */
    private async updateState(): Promise<void> {
        const result = (await this.send('Runtime.evaluate', {
            expression: 'JSON.stringify({ url: location.href, title: document.title })',
            returnByValue: true,
        })) as { result: { value: string } }

        const {url, title} = JSON.parse(result.result.value)
        this.state         = {
            url,
            title,
            targetId: this.currentTargetId!,
        }
    }

    /**
     * 确保已连接
     */
    private ensureConnected(): void {
        if (!this.cdp || !this.cdp.isConnected) {
            throw new SessionNotFoundError()
        }
    }

    /**
     * 确保有活跃会话
     */
    private ensureSession(): void {
        this.ensureConnected()
        if (!this.sessionId) {
            throw new SessionNotFoundError()
        }
    }
}

/**
 * 获取按键定义
 */
function getKeyDefinition(key: string): {
    key: string;
    code: string;
    keyCode: number;
    text?: string;
} {
    const definitions: Record<
        string,
        { key: string; code: string; keyCode: number; text?: string }
    > = {
        // 修饰键
        Control: {key: 'Control', code: 'ControlLeft', keyCode: 17},
        Shift: {key: 'Shift', code: 'ShiftLeft', keyCode: 16},
        Alt: {key: 'Alt', code: 'AltLeft', keyCode: 18},
        Meta: {key: 'Meta', code: 'MetaLeft', keyCode: 91},
        // 功能键
        Enter: {key: 'Enter', code: 'Enter', keyCode: 13, text: '\r'},
        Tab: {key: 'Tab', code: 'Tab', keyCode: 9},
        Backspace: {key: 'Backspace', code: 'Backspace', keyCode: 8},
        Delete: {key: 'Delete', code: 'Delete', keyCode: 46},
        Escape: {key: 'Escape', code: 'Escape', keyCode: 27},
        Space: {key: ' ', code: 'Space', keyCode: 32, text: ' '},
        // 方向键
        ArrowUp: {key: 'ArrowUp', code: 'ArrowUp', keyCode: 38},
        ArrowDown: {key: 'ArrowDown', code: 'ArrowDown', keyCode: 40},
        ArrowLeft: {key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37},
        ArrowRight: {key: 'ArrowRight', code: 'ArrowRight', keyCode: 39},
        // 其他常用键
        Home: {key: 'Home', code: 'Home', keyCode: 36},
        End: {key: 'End', code: 'End', keyCode: 35},
        PageUp: {key: 'PageUp', code: 'PageUp', keyCode: 33},
        PageDown: {key: 'PageDown', code: 'PageDown', keyCode: 34},
    }

    // 如果是已知按键，返回定义
    if (definitions[key]) {
        return definitions[key]
    }

    // 如果是单个字符，生成定义
    if (key.length === 1) {
        const charCode = key.charCodeAt(0)
        const code     =
                  key >= 'a' && key <= 'z'
                  ? `Key${key.toUpperCase()}`
                  : key >= 'A' && key <= 'Z'
                    ? `Key${key}`
                    : key >= '0' && key <= '9'
                      ? `Digit${key}`
                      : `Key${key}`

        return {
            key,
            code,
            keyCode: charCode,
            text: key,
        }
    }

    // 未知按键
    return {key, code: key, keyCode: 0}
}

/**
 * 获取会话管理器实例
 */
export function getSession(): SessionManager {
    return SessionManager.getInstance()
}
