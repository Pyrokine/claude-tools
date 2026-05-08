/**
 * 会话管理
 *
 * 管理浏览器会话，包括：
 * - CDP 客户端
 * - 反检测注入
 * - 页面状态
 * - 日志收集
 */

import { BehaviorSimulator, getAntiDetectionScript } from '../anti-detection/index.js'
import { BrowserLauncher, CDPClient, getBrowserWSEndpoint, getTargets } from '../cdp/index.js'
import { AutoWait } from './auto-wait.js'
import {
    type ActionableClickResult,
    type CookieFilter,
    type DispatchInputResult,
    type DragAndDropResult,
    DriverCapabilityError,
    type FindResult,
    type FrameResolveResult,
    type HtmlWithImagesResult,
    type IBrowserDriver,
    type InputKeyOptions,
    type InputKeyType,
    type InputMouseOptions,
    type InputMouseType,
    type InputTouchPoint,
    type InputTouchType,
    type ListedTarget,
    type NewTabResult,
    type ReadPageOptions,
    type ReadPageResult,
    type ScreenshotResult,
    type SetCookieParams,
} from './browser-driver.js'
import { NavigationError, NavigationTimeoutError, SessionNotFoundError, TargetNotFoundError } from './errors.js'
import { Locator } from './locator.js'
import {
    type CdpResultObject,
    type ConnectOptions,
    type ConsoleLogEntry,
    type Cookie,
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
    url: string
    title: string
    targetId: string
}

/**
 * 会话管理器（单例）
 */
class SessionManager implements IBrowserDriver {
    private static instance: SessionManager
    // 日志收集（环形缓冲区，限制最大条数避免内存泄漏）
    private static readonly MAX_LOG_ENTRIES = 1000
    private launcher: BrowserLauncher | null = null
    private cdp: CDPClient | null = null
    private connectedPort: number = 0
    private sessionId: string | null = null
    private currentTargetId: string | null = null
    private state: SessionState | null = null
    private behaviorSimulator = new BehaviorSimulator()
    private stealthMode: 'off' | 'safe' | 'aggressive' = 'safe'
    /** 当前按下的修饰键位掩码 */
    private modifiers = 0
    // 操作锁（防止并发竞态）
    private operationLock: Promise<void> = Promise.resolve()
    private consoleLogs: ConsoleLogEntry[] = []
    private networkRequests: NetworkRequestEntry[] = []
    private requestMap = new Map<
        string,
        {
            url: string
            method: string
            type: string
            timestamp: number
            _monotonic: number
        }
    >()

    // 监听器安装标志（防止重复安装）
    private listenersInstalled = false

    private constructor() {}

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
     * 如果指定了端口，会先尝试连接该端口上已运行的浏览器，
     * 只有连接失败时才启动新浏览器
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
                    this.cdp = new CDPClient()
                    await this.cdp.connect(endpoint, options.timeout)
                    // 记录端口（connect 模式没有 launcher）
                    this.connectedPort = port

                    // 获取现有页面
                    const targets = await getTargets('127.0.0.1', port)
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
            this.launcher = new BrowserLauncher()
            const endpoint = await this.launcher.launch(options)

            // 连接 CDP
            this.cdp = new CDPClient()
            await this.cdp.connect(endpoint, options.timeout)

            // 获取第一个页面
            const targets = await getTargets('127.0.0.1', this.launcher.port)
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
            const { host = '127.0.0.1', port, timeout = DEFAULT_TIMEOUT, stealth = 'safe' } = options

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
            const targets = await getTargets(host, port)
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
    async listTargets(): Promise<ListedTarget[]> {
        this.ensureConnected()

        // 从 CDP 获取 targets
        const { targetInfos } = (await this.cdp!.send('Target.getTargets')) as {
            targetInfos: Array<{
                targetId: string
                type: string
                url: string
                title: string
            }>
        }

        return targetInfos
            .filter((t) => t.type === 'page')
            .map((t) => ({
                id: t.targetId,
                targetId: t.targetId,
                url: t.url,
                title: t.title,
                type: t.type,
                active: t.targetId === this.currentTargetId,
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
    async navigate(url: string, options: { wait?: WaitUntil; timeout?: number } = {}): Promise<void> {
        return this.withLock(async () => {
            this.ensureSession()

            const { wait = 'load', timeout = DEFAULT_TIMEOUT } = options

            // networkidle：先注册监听器再 navigate，避免 navigate 返回和监听器注册之间的竞态窗口
            // noinspection ES6MissingAwait — 故意不 await，Promise 在 navigate 完成后才消费
            const networkIdlePromise = wait === 'networkidle' ? this.startNetworkIdleWatcher(timeout) : null

            // 导航（传 timeout 防止 CDP 默认 30s 截断用户预算）
            const { errorText } = (await this.send('Page.navigate', { url }, timeout)) as {
                errorText?: string
            }

            if (errorText) {
                throw new NavigationError(url, errorText)
            }

            // 根据 wait 类型等待
            if (networkIdlePromise) {
                await networkIdlePromise
            } else {
                const eventName = wait === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired'
                await this.cdp!.waitForEvent(eventName, undefined, timeout)
            }

            // 更新状态
            await this.updateState()
        })
    }

    /**
     * 等待网络空闲（无进行中的请求且持续指定时间）
     *
     * close() 时通过 'disconnected' 信号立即 reject，不必等 timer 超时
     */
    async waitForNetworkIdle(timeout: number, idleTime: number = 500): Promise<void> {
        this.ensureSession()
        return this.buildNetworkIdlePromise(this.cdp!, timeout, idleTime)
    }

    /**
     * 等待导航完成（跨文档导航或同文档导航）
     */
    async waitForNavigation(timeout: number = DEFAULT_TIMEOUT): Promise<void> {
        this.ensureSession()
        await this.waitForAnyEvent(['Page.loadEventFired', 'Page.navigatedWithinDocument'], timeout)
    }

    /**
     * 后退
     */
    async goBack(timeout = DEFAULT_TIMEOUT): Promise<{ navigated: boolean }> {
        return this.withLock(async () => {
            this.ensureSession()
            const { currentIndex, entries } = await this.send<{
                currentIndex: number
                entries: Array<{ id: number; url: string; title: string }>
            }>('Page.getNavigationHistory', undefined, timeout)

            if (currentIndex <= 0) {
                return { navigated: false }
            }

            // 跨文档导航触发 loadEventFired，同文档导航（hash/pushState）触发 navigatedWithinDocument
            const waitPromise = this.waitForAnyEvent(['Page.loadEventFired', 'Page.navigatedWithinDocument'], timeout)
            // 预注册 rejection handler：若 send() 抛错导致 waitPromise 永远不被 await，
            // 其 timer reject 不会成为 unhandled rejection（Node 20 默认会退出进程）
            waitPromise.catch(() => {})
            await this.send('Page.navigateToHistoryEntry', { entryId: entries[currentIndex - 1].id }, timeout)
            await waitPromise
            await this.updateState()
            return { navigated: true }
        })
    }

    /**
     * 前进
     */
    async goForward(timeout = DEFAULT_TIMEOUT): Promise<{ navigated: boolean }> {
        return this.withLock(async () => {
            this.ensureSession()
            const { currentIndex, entries } = await this.send<{
                currentIndex: number
                entries: Array<{ id: number; url: string; title: string }>
            }>('Page.getNavigationHistory', undefined, timeout)

            if (currentIndex >= entries.length - 1) {
                return { navigated: false }
            }

            // 跨文档导航触发 loadEventFired，同文档导航（hash/pushState）触发 navigatedWithinDocument
            const waitPromise = this.waitForAnyEvent(['Page.loadEventFired', 'Page.navigatedWithinDocument'], timeout)
            waitPromise.catch(() => {})
            await this.send('Page.navigateToHistoryEntry', { entryId: entries[currentIndex + 1].id }, timeout)
            await waitPromise
            await this.updateState()
            return { navigated: true }
        })
    }

    /**
     * 刷新
     */
    async reload(ignoreCache = false, _waitUntil?: string, timeout = DEFAULT_TIMEOUT): Promise<void> {
        return this.withLock(async () => {
            this.ensureSession()

            const waitPromise = this.cdp!.waitForEvent('Page.loadEventFired', undefined, timeout)
            waitPromise.catch(() => {})

            await this.send('Page.reload', { ignoreCache }, timeout)

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
        // 整数点位：避免 sub-pixel 渲染时坐标命中元素边界外的情况（与 Playwright 一致）
        const ix = Math.round(x)
        const iy = Math.round(y)
        await this.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: ix,
            y: iy,
            modifiers: this.modifiers,
        })
        this.behaviorSimulator.setCurrentPosition({ x: ix, y: iy })
    }

    /**
     * 鼠标按下
     */
    async mouseDown(button: 'left' | 'middle' | 'right' | 'back' | 'forward' = 'left', clickCount = 1): Promise<void> {
        this.ensureSession()
        await this.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            button,
            clickCount,
            x: this.behaviorSimulator.getCurrentPosition().x,
            y: this.behaviorSimulator.getCurrentPosition().y,
            modifiers: this.modifiers,
        })
    }

    /**
     * 鼠标释放
     */
    async mouseUp(button: 'left' | 'middle' | 'right' | 'back' | 'forward' = 'left', clickCount = 1): Promise<void> {
        this.ensureSession()
        await this.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            button,
            clickCount,
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
     *
     * options.rawKeyDown=true 配合 options.autoRepeat=true 表示长按重复（与 Puppeteer 一致），
     * 上层 unified-session 维护 pressedKeys Set 决定是否启用
     */
    async keyDown(
        key: string,
        commands?: string[],
        options?: { rawKeyDown?: boolean; autoRepeat?: boolean }
    ): Promise<void> {
        this.ensureSession()
        if (MODIFIER_KEYS[key]) {
            this.modifiers |= MODIFIER_KEYS[key]
        }
        const keyDefinition = getKeyDefinition(key)
        const params: Record<string, unknown> = {
            type: options?.rawKeyDown ? 'rawKeyDown' : 'keyDown',
            modifiers: this.modifiers,
            ...keyDefinition,
        }
        if (commands && commands.length > 0) {
            delete params.text
            params.commands = commands
        }
        if (options?.autoRepeat) {
            params.autoRepeat = true
        }
        await this.send('Input.dispatchKeyEvent', params)
    }

    /**
     * 键盘释放
     */
    async keyUp(key: string): Promise<void> {
        this.ensureSession()
        const keyDefinition = getKeyDefinition(key)
        const nextModifiers = MODIFIER_KEYS[key] ? this.modifiers & ~MODIFIER_KEYS[key] : this.modifiers
        await this.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            modifiers: nextModifiers,
            ...keyDefinition,
        })
        this.modifiers = nextModifiers
    }

    /**
     * 输入文本
     */
    async type(text: string, delay = 0): Promise<void> {
        this.ensureSession()
        // 归一化换行：\r\n 和 \r 都视作单个 \n
        const normalized = text.replace(/\r\n?/g, '\n')
        for (const char of normalized) {
            if (char === '\n') {
                // Enter 键：char 通道不接受 \n，必须分发 keyDown + char('\r') + keyUp
                const enterParams = {
                    key: 'Enter',
                    code: 'Enter',
                    windowsVirtualKeyCode: 13,
                    nativeVirtualKeyCode: 13,
                    modifiers: this.modifiers,
                }
                await this.send('Input.dispatchKeyEvent', {
                    type: 'keyDown',
                    ...enterParams,
                })
                await this.send('Input.dispatchKeyEvent', {
                    type: 'char',
                    text: '\r',
                    ...enterParams,
                })
                await this.send('Input.dispatchKeyEvent', {
                    type: 'keyUp',
                    ...enterParams,
                })
            } else {
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
            }
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
        await this.dispatchTouch({ type: 'touchStart', touchPoints: [{ x, y }] })
    }

    /**
     * 触屏移动
     */
    async touchMove(x: number, y: number): Promise<void> {
        this.ensureSession()
        await this.dispatchTouch({ type: 'touchMove', touchPoints: [{ x, y }] })
    }

    /**
     * 触屏结束
     */
    async touchEnd(): Promise<void> {
        this.ensureSession()
        await this.dispatchTouch({ type: 'touchEnd', touchPoints: [] })
    }

    /**
     * 截图
     */
    async screenshot(
        options: {
            fullPage?: boolean
            scale?: number
            format?: string
            quality?: number
            clip?: { x: number; y: number; width: number; height: number }
        } = {}
    ): Promise<ScreenshotResult> {
        this.ensureSession()

        const { fullPage = false, scale, format, quality, clip } = options
        const effectiveFormat = format ?? 'png'
        const captureParams: Record<string, unknown> = { format: effectiveFormat }
        if (quality !== undefined && effectiveFormat !== 'png') {
            captureParams.quality = quality
        }
        if (clip) {
            captureParams.clip = { ...clip, scale: scale ?? 1 }
        }

        if (fullPage) {
            // 获取页面完整高度
            const sizeExpr =
                'JSON.stringify({ width: document.documentElement.scrollWidth, ' +
                'height: document.documentElement.scrollHeight })'
            const { result } = (await this.send('Runtime.evaluate', {
                expression: sizeExpr,
                returnByValue: true,
            })) as { result: { value: string } }

            let width: number, height: number
            try {
                ;({ width, height } = JSON.parse(result.value))
            } catch {
                throw new Error(`screenshot: 无法解析页面尺寸: ${result.value}`)
            }

            // 设置视口
            await this.send('Emulation.setDeviceMetricsOverride', {
                width,
                height,
                deviceScaleFactor: scale ?? 1,
                mobile: false,
            })

            try {
                const { data } = (await this.send('Page.captureScreenshot', captureParams)) as { data: string }
                return { data, format: effectiveFormat }
            } finally {
                try {
                    await this.send('Emulation.clearDeviceMetricsOverride')
                } catch {
                    // cleanup failure, ignore to preserve original error
                }
            }
        }

        const { data } = (await this.send('Page.captureScreenshot', captureParams)) as { data: string }
        return { data, format: effectiveFormat }
    }

    /**
     * 获取页面状态
     */
    async getPageState(): Promise<PageState> {
        this.ensureSession()

        // 获取基本信息
        const { result } = (await this.send('Runtime.evaluate', {
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
        const { nodes } = (await this.send('Accessibility.getFullAXTree')) as {
            nodes: Array<{
                role: { value: string }
                name?: { value: string }
                description?: { value: string }
                properties?: Array<{ name: string; value: { value: unknown } }>
            }>
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
                const props = n.properties ?? []
                const getProp = (name: string) => props.find((p) => p.name === name)?.value?.value

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

    async getPageHtml(selector?: string, outer = true): Promise<string> {
        this.ensureSession()
        if (selector) {
            const prop = outer ? 'outerHTML' : 'innerHTML'
            return this.evaluate<string>(
                `((s, p) => { const el = document.querySelector(s); return el ? el[p] : '' })`,
                [selector, prop]
            )
        }
        return this.evaluate<string>('document.documentElement.outerHTML')
    }

    /**
     * 获取页面文本（IBrowserDriver 接口）
     */
    async getPageText(selector?: string): Promise<string> {
        this.ensureSession()
        if (selector) {
            return this.evaluate<string>(`(s => document.querySelector(s)?.textContent || '')`, [selector])
        }
        return this.evaluate<string>('document.body.innerText')
    }

    // ==================== IBrowserDriver: 页面读取 ====================

    /** Extension readPage 等价物：CDP 通过 getPageState 构造 pageContent 文本 */
    async readPage(_options?: ReadPageOptions): Promise<ReadPageResult> {
        const state = await this.getPageState()
        const elements = state.elements ?? []
        const lines = elements.map((e) => {
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

    /** CDP 通过 evaluate 注入函数枚举 IMG */
    async getHtmlWithImages(selector?: string, outer = true): Promise<HtmlWithImagesResult> {
        const selectorArg = JSON.stringify(selector ?? null)
        return this.evaluate<HtmlWithImagesResult>(`(function() {
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
                images.push({
                    index: i, src: img.src,
                    dataSrc: (function() {
                        var raw = img.dataset.src || img.dataset.lazySrc || img.dataset.original || '';
                        if (!raw) return '';
                        try { return new URL(raw, location.href).href } catch(e) { return raw }
                    })(),
                    alt: img.alt, width: img.width, height: img.height,
                    naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight
                });
            }
            return {html: html, images: images};
        })()`)
    }

    /** CDP 通过 evaluate 注入收集 meta 标签和 og/twitter/jsonLd */
    async getMetadata(): Promise<Record<string, unknown>> {
        return this.evaluate<Record<string, unknown>>(`(function() {
            function meta(name) {
                var el = document.querySelector('meta[name="'+name+'"],meta[property="'+name+'"]');
                return el ? el.content || undefined : undefined;
            }
            var og = {}, tw = {};
            document.querySelectorAll('meta[property^="og:"]').forEach(function(m) {
                og[m.getAttribute('property')] = m.content || '';
            });
            document.querySelectorAll('meta[name^="twitter:"]').forEach(function(m) {
                tw[m.getAttribute('name')] = m.content || '';
            });
            var jsonLd = [];
            document.querySelectorAll('script[type="application/ld+json"]').forEach(function(s) {
                try { jsonLd.push(JSON.parse(s.textContent || '')); } catch(e) {}
            });
            var alternates = [];
            document.querySelectorAll('link[rel="alternate"]').forEach(function(l) {
                alternates.push({
                    href: l.href,
                    type: l.getAttribute('type') || undefined,
                    hreflang: l.getAttribute('hreflang') || undefined
                });
            });
            var feeds = [];
            var feedSel = 'link[type="application/rss+xml"],link[type="application/atom+xml"]';
            document.querySelectorAll(feedSel).forEach(function(l) {
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

    // ==================== IBrowserDriver: 元素查找 ====================

    /** CDP 通过 evaluate 注入 TreeWalker 查找元素 */
    async find(selector?: string, text?: string, xpath?: string, timeout?: number): Promise<FindResult[]> {
        return this.evaluate<FindResult[]>(
            `function(selector, text, xpath) {
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
            } else if (text) {
                // text-only：用 TreeWalker 仅遍历可能含目标文本的节点,避免 querySelectorAll('*') 的全树扫描和强制 layout
                elements = [];
                var lowerText = text;
                var walker = document.createTreeWalker(
                    document.body || document.documentElement,
                    NodeFilter.SHOW_ELEMENT,
                    {
                    acceptNode: function (n) {
                        var t = n.textContent || '';
                        if (!t.includes(lowerText)) return NodeFilter.FILTER_SKIP;
                        return NodeFilter.FILTER_ACCEPT;
                    }
                });
                while (walker.nextNode()) {
                    elements.push(walker.currentNode);
                    if (elements.length >= 200) break;
                }
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
        }`,
            [selector ?? null, text ?? null, xpath ?? null],
            timeout
        )
    }

    // ==================== IBrowserDriver: 元素操作（refId 类，CDP 不支持） ====================

    click(_refId: string): Promise<void> {
        return Promise.reject(new DriverCapabilityError('CDP 模式不支持 refId 点击,请使用 input 工具的坐标点击'))
    }

    actionableClick(_refId: string, _force?: boolean): Promise<ActionableClickResult> {
        return Promise.reject(new DriverCapabilityError('actionableClick 仅支持 Extension 模式'))
    }

    dispatchInput(_refId: string, _text: string): Promise<DispatchInputResult> {
        return Promise.reject(new DriverCapabilityError('dispatchInput 仅支持 Extension 模式'))
    }

    dragAndDrop(_srcRefId: string, _dstRefId: string): Promise<DragAndDropResult> {
        return Promise.reject(new DriverCapabilityError('dragAndDrop 仅支持 Extension 模式'))
    }

    getComputedStyle(_refId: string, _prop: string): Promise<string | null> {
        return Promise.reject(new DriverCapabilityError('getComputedStyle 仅支持 Extension 模式'))
    }

    typeRef(_refId: string, _text: string, _clear?: boolean): Promise<void> {
        return Promise.reject(new DriverCapabilityError('CDP 模式不支持 refId 输入,请使用 input 工具'))
    }

    /** scrollAt：CDP 模式没有 refId 概念,无视 refId 直接 mouseWheel（保持与原 unified-session 行为一致） */
    async scrollAt(x: number, y: number, _refId?: string): Promise<void> {
        await this.mouseWheel(x, y)
    }

    async getAttribute(
        selector: string | undefined,
        refId: string | undefined,
        attribute: string
    ): Promise<string | null> {
        if (refId !== undefined) {
            throw new DriverCapabilityError('CDP 模式不支持 refId 查询属性,请通过 selector')
        }
        if (!selector) {
            throw new DriverCapabilityError('getAttribute 需要 selector')
        }
        return this.evaluate<string | null>(
            `(s, a) => { const el = document.querySelector(s); return el ? el.getAttribute(a) : null }`,
            [selector, attribute]
        )
    }

    // ==================== IBrowserDriver: 输入（precise） ====================

    /** CDP 通用 inputKey 接口实现：直接转发 Input.dispatchKeyEvent，不维护 modifiers（由调用方提供） */
    async inputKey(type: InputKeyType, options: InputKeyOptions = {}): Promise<void> {
        this.ensureSession()
        const params: Record<string, unknown> = { type }
        if (options.key !== undefined) {
            params.key = options.key
        }
        if (options.code !== undefined) {
            params.code = options.code
        }
        if (options.text !== undefined) {
            params.text = options.text
        }
        if (options.unmodifiedText !== undefined) {
            params.unmodifiedText = options.unmodifiedText
        }
        if (options.location !== undefined) {
            params.location = options.location
        }
        if (options.isKeypad !== undefined) {
            params.isKeypad = options.isKeypad
        }
        if (options.autoRepeat !== undefined) {
            params.autoRepeat = options.autoRepeat
        }
        if (options.windowsVirtualKeyCode !== undefined) {
            params.windowsVirtualKeyCode = options.windowsVirtualKeyCode
        }
        if (options.modifiers !== undefined) {
            params.modifiers = options.modifiers
        }
        if (options.commands && options.commands.length > 0) {
            params.commands = options.commands
        }
        await this.send('Input.dispatchKeyEvent', params)
    }

    /** CDP 通用 inputMouse 接口实现：直接转发 Input.dispatchMouseEvent */
    async inputMouse(type: InputMouseType, x: number, y: number, options: InputMouseOptions = {}): Promise<void> {
        this.ensureSession()
        const params: Record<string, unknown> = {
            type,
            x: Math.round(x),
            y: Math.round(y),
        }
        if (options.button !== undefined) {
            params.button = options.button
        }
        if (options.clickCount !== undefined) {
            params.clickCount = options.clickCount
        }
        if (options.deltaX !== undefined) {
            params.deltaX = options.deltaX
        }
        if (options.deltaY !== undefined) {
            params.deltaY = options.deltaY
        }
        if (options.modifiers !== undefined) {
            params.modifiers = options.modifiers
        }
        await this.send('Input.dispatchMouseEvent', params)
        // mouseMoved 同步坐标到 BehaviorSimulator,与 mouseMove 方法保持一致
        if (type === 'mouseMoved') {
            this.behaviorSimulator.setCurrentPosition({ x: Math.round(x), y: Math.round(y) })
        }
    }

    /** CDP 通用 inputTouch 接口实现：临时启用 touch 模拟避免命令挂起 */
    async inputTouch(type: InputTouchType, touchPoints: InputTouchPoint[]): Promise<void> {
        this.ensureSession()
        await this.dispatchTouch({ type, touchPoints })
    }

    /** CDP inputType 接口实现：直接复用现有 type 方法 */
    inputType(text: string, delay = 0): Promise<void> {
        return this.type(text, delay)
    }

    // ==================== IBrowserDriver: Stealth（CDP 不支持） ====================

    stealthKey(_key: string, _type: 'down' | 'up' | 'press', _modifiers: string[]): Promise<void> {
        return Promise.reject(new DriverCapabilityError('Stealth 模式仅在 Extension 下可用,CDP 模式请使用 inputKey'))
    }

    stealthClick(_x: number, _y: number, _button?: string, _clickCount?: number, _refId?: string): Promise<void> {
        return Promise.reject(new DriverCapabilityError('Stealth 模式仅在 Extension 下可用,CDP 模式请使用 inputMouse'))
    }

    stealthMouse(_type: string, _x: number, _y: number, _button?: string): Promise<void> {
        return Promise.reject(new DriverCapabilityError('Stealth 模式仅在 Extension 下可用,CDP 模式请使用 inputMouse'))
    }

    stealthType(_text: string, _delay?: number): Promise<void> {
        return Promise.reject(new DriverCapabilityError('Stealth 模式仅在 Extension 下可用,CDP 模式请使用 inputType'))
    }

    stealthInject(): Promise<void> {
        return Promise.reject(
            new DriverCapabilityError(
                'CDP 模式 stealth 脚本在 connect/launch 时通过 stealth 参数自动注入,不支持后续手动注入'
            )
        )
    }

    // ==================== IBrowserDriver: 日志启用 ====================

    /** CDP 模式：Network/Runtime 域已在 attach 时启用,no-op */
    consoleEnable(): Promise<void> {
        return Promise.resolve()
    }

    /** CDP 模式：Network 域已在 attach 时启用,no-op */
    networkEnable(): Promise<void> {
        return Promise.resolve()
    }

    // ==================== IBrowserDriver: Tab/状态 ====================

    /** IBrowserDriver 接口：激活页面（attach + 切到前台） */
    async activatePage(targetId: string): Promise<void> {
        await this.attachToTarget(targetId)
        await this.activateTarget(targetId)
    }

    /** IBrowserDriver 接口：选择操作目标（attach 即可） */
    async selectPage(targetId: string): Promise<void> {
        await this.attachToTarget(targetId)
    }

    /** IBrowserDriver 接口：获取当前操作目标 ID */
    getCurrentTargetId(): string | null {
        return this.currentTargetId
    }

    /** IBrowserDriver 接口：设置当前操作目标 ID（attach 到指定 target） */
    setCurrentTargetId(targetId: string | null): void {
        // CDP 路径不支持同步 setCurrentTargetId（attach 是异步的）;
        // 调用方应使用 selectPage(targetId) 或 attachToTarget(targetId)
        if (targetId === null) {
            // 不允许同步清空 currentTargetId（会造成 sessionId 与 currentTargetId 状态漂移）
            // 上层应通过 closePage 路径主动清理
            return
        }
        if (targetId !== this.currentTargetId) {
            throw new DriverCapabilityError(
                'CDP 模式不支持同步切换 target,请用 selectPage(targetId) 或 attachToTarget(targetId)'
            )
        }
    }

    // ==================== IBrowserDriver: iframe（CDP 不支持） ====================

    resolveFrame(_frame: string | number): Promise<FrameResolveResult> {
        return Promise.reject(new DriverCapabilityError('iframe 穿透需要 Extension 模式'))
    }

    getCurrentFrameId(): number {
        // CDP 模式没有 frameId 概念,统一返回 0（主框架）
        return 0
    }

    setCurrentFrameId(frameId: number): void {
        if (frameId !== 0) {
            throw new DriverCapabilityError('iframe 穿透需要 Extension 模式')
        }
    }

    evaluateInFrame(
        _frameId: number,
        _expression: string,
        _timeout?: number
    ): Promise<{
        result?: { value?: unknown }
        exceptionDetails?: { text: string; exception?: { className?: string; description?: string } }
    }> {
        return Promise.reject(new DriverCapabilityError('iframe 穿透需要 Extension 模式'))
    }

    // ==================== IBrowserDriver: CDP 直通 ====================

    /**
     * 发送 CDP 命令（IBrowserDriver 接口）：
     * tabId 在 CDP 模式下忽略（CDP 单 session 概念不区分 tab）；
     * browser-level 域（Target/Browser/SystemInfo/DeviceAccess/IO）走 sendBrowserCommand
     */
    debuggerSend(
        method: string,
        params?: Record<string, unknown>,
        _tabId?: number,
        timeout?: number
    ): Promise<unknown> {
        const domain = method.split('.')[0]
        const browserLevelDomains = ['Target', 'Browser', 'SystemInfo', 'DeviceAccess', 'IO']
        if (browserLevelDomains.includes(domain)) {
            return this.sendBrowserCommand(method, params)
        }
        return this.send(method, params, timeout)
    }

    /**
     * 获取 Cookies
     */
    async getCookies(filter?: CookieFilter): Promise<Cookie[]> {
        this.ensureSession()
        const urls = filter?.url ? [filter.url] : undefined
        const { cookies } = (await this.send('Network.getCookies', urls ? { urls } : {})) as {
            cookies: Cookie[]
        }
        if (!filter) {
            return cookies
        }
        return cookies.filter((c) => {
            if (filter.name && c.name !== filter.name) {
                return false
            }
            if (filter.domain) {
                const fd = filter.domain.replace(/^\./, '')
                const cd = (c.domain ?? '').replace(/^\./, '')
                if (cd !== fd && !cd.endsWith('.' + fd)) {
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
                const isSession = ((c as unknown as { expires?: number }).expires ?? -1) <= 0
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
    async setCookie(params: SetCookieParams): Promise<void> {
        this.ensureSession()

        const url = params.url ?? this.state?.url ?? 'http://localhost'
        const { name, value, domain, path, httpOnly, secure, sameSite, expirationDate } = params
        await this.send('Network.setCookie', {
            name,
            value,
            url,
            ...(domain !== undefined && { domain }),
            ...(path !== undefined && { path }),
            ...(httpOnly !== undefined && { httpOnly }),
            ...(secure !== undefined && { secure }),
            ...(sameSite !== undefined && { sameSite }),
            ...(expirationDate !== undefined && { expires: expirationDate }),
        })
    }

    async deleteCookie(url: string, name: string): Promise<void> {
        this.ensureSession()
        const effectiveUrl = url || this.state?.url || 'http://localhost'
        await this.send('Network.deleteCookies', { name, url: effectiveUrl })
    }

    async clearCookies(filter?: CookieFilter): Promise<{ count: number }> {
        this.ensureSession()
        // Driver 级护栏：禁止无过滤的全站清除，必须带 url/domain/name 至少一项
        if (!filter || (!filter.url && !filter.domain && !filter.name)) {
            throw new Error('clearCookies 必须带 url/domain/name 至少一个过滤参数（防止误清全站 cookies）')
        }
        const urls = filter.url ? [filter.url] : undefined
        const { cookies } = (await this.send('Network.getCookies', urls ? { urls } : {})) as {
            cookies: Array<{ name: string; domain: string; path: string; secure: boolean }>
        }
        let count = 0
        for (const cookie of cookies) {
            if (filter.domain) {
                const fd = filter.domain.replace(/^\./, '')
                const cd = cookie.domain.replace(/^\./, '')
                if (cd !== fd && !cd.endsWith('.' + fd)) {
                    continue
                }
            }
            if (filter.name && cookie.name !== filter.name) {
                continue
            }
            const protocol = cookie.secure ? 'https:' : 'http:'
            const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
            const deleteUrl = `${protocol}//${domain}${cookie.path}`
            await this.send('Network.deleteCookies', { name: cookie.name, url: deleteUrl })
            count++
        }
        return { count }
    }

    async getConsoleLogs(
        options: { level?: string; pattern?: string; clear?: boolean } = {}
    ): Promise<ConsoleLogEntry[]> {
        let logs = this.consoleLogs
        const { level, pattern, clear } = options
        if (level && level !== 'all') {
            logs = logs.filter(
                (l) =>
                    l.level === level ||
                    (level === 'warning' && l.level === 'warn') ||
                    (level === 'warn' && l.level === 'warning')
            )
        }
        if (pattern) {
            const lp = pattern.toLowerCase()
            logs = logs.filter((l) => l.text.toLowerCase().includes(lp))
        }
        const result = logs.slice(-100)
        if (clear) {
            this.consoleLogs = []
        }
        return result
    }

    async getNetworkRequests(options: { urlPattern?: string; clear?: boolean } = {}): Promise<NetworkRequestEntry[]> {
        const { urlPattern, clear } = options
        let requests = this.networkRequests
        if (urlPattern) {
            try {
                // 转义正则元字符，仅保留 * 和 ? 的通配语义
                const escaped = urlPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
                const regex = new RegExp(pattern, 'i')
                requests = requests.filter((r) => regex.test(r.url))
            } catch {
                // 构造失败时退化为字符串包含匹配
                const pat = urlPattern.toLowerCase()
                requests = requests.filter((r) => r.url.toLowerCase().includes(pat))
            }
        }
        const result = requests.slice(-100)
        if (clear) {
            this.networkRequests = []
            this.requestMap.clear()
        }
        return result
    }

    /**
     * 清除日志
     */
    clearLogs(): void {
        this.consoleLogs = []
        this.networkRequests = []
        this.requestMap.clear()
    }

    /**
     * 执行 JavaScript
     */
    async evaluate<T>(script: string, args?: unknown[], timeout?: number): Promise<T> {
        this.ensureSession()

        // CDP 命令超时需大于脚本执行超时，给 WebSocket 通信留余量
        const CDP_MARGIN = 5000
        const sendTimeout = timeout !== undefined ? timeout + CDP_MARGIN : undefined

        // 有参数时使用 callFunctionOn：避免大 payload 字符串拼接，参数通过协议结构化传递
        if (args && args.length > 0) {
            const { result: globalResult } = (await this.send('Runtime.evaluate', {
                expression: 'globalThis',
                returnByValue: false,
            })) as { result: { objectId: string } }

            try {
                const callParams: Record<string, unknown> = {
                    functionDeclaration: script,
                    objectId: globalResult.objectId,
                    arguments: args.map((a) => ({ value: a })),
                    returnByValue: true,
                    awaitPromise: true,
                }
                if (timeout !== undefined) {
                    callParams.timeout = timeout
                }
                const { result, exceptionDetails } = (await this.send(
                    'Runtime.callFunctionOn',
                    callParams,
                    sendTimeout
                )) as {
                    result: CdpResultObject<T>
                    exceptionDetails?: { text: string; exception?: { description?: string } }
                }
                if (exceptionDetails) {
                    throw new Error(formatCdpException(exceptionDetails))
                }
                return extractCdpValue<T>(result)
            } finally {
                this.send('Runtime.releaseObject', { objectId: globalResult.objectId }).catch(() => {})
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
        const { result, exceptionDetails } = (await this.send('Runtime.evaluate', evalParams, sendTimeout)) as {
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
        await this.send('Emulation.setUserAgentOverride', { userAgent })
    }

    /**
     * 清除缓存
     *
     * 不再清 cookies：cookies 清除统一走 cookies action=clear（强制 name/domain/url 过滤）
     */
    async clearCache(type: 'all' | 'storage' | 'cache' = 'all'): Promise<void> {
        this.ensureSession()

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
     *
     * IBrowserDriver 接口：可选 url 参数，url 提供时新建后立即导航
     */
    async newPage(url?: string, _timeout?: number): Promise<NewTabResult> {
        const target = await this.withLock(async () => this.newPageInternal())
        if (url) {
            await this.navigate(url)
            return {
                targetId: target.targetId,
                url: this.state?.url ?? url,
                title: this.state?.title ?? '',
                type: 'page',
            }
        }
        return {
            targetId: target.targetId,
            url: target.url,
            title: target.title,
            type: 'page',
        }
    }

    /**
     * 激活页面（切到前台）
     */
    async activateTarget(targetId: string): Promise<void> {
        this.ensureConnected()
        // Target 域命令是 browser-level，不携带 sessionId
        await this.cdp!.send('Target.activateTarget', { targetId })
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

            await this.cdp!.send('Target.closeTarget', { targetId: id })

            // 如果关闭的是当前页面，清除会话状态
            if (id === this.currentTargetId) {
                this.sessionId = null
                this.currentTargetId = null
                this.state = null
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
     * 每次调用都检查连接状态，防止 close() 并发置空 this.cdp 后崩溃，
     * 多步操作（type 循环、fullPage 截图等）的 await 间隙可能被 close() 打断，
     * ensureSession() 确保在当前 tick 内 this.cdp 非空
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
     * 派发 CDP Input.dispatchTouchEvent，临时启用 touch 模拟避免命令挂起
     */
    private async dispatchTouch(params: Record<string, unknown>): Promise<void> {
        await this.send('Emulation.setTouchEmulationEnabled', { enabled: true })
        try {
            await this.send('Input.dispatchTouchEvent', params)
        } finally {
            try {
                await this.send('Emulation.setTouchEmulationEnabled', { enabled: false })
            } catch {
                // cleanup 失败不覆盖原始错误
            }
        }
    }

    /**
     * 在调用 navigate 之前注册网络空闲监听器，返回等待 idle 的 Promise
     * 预先注册避免 Page.navigate 返回和监听器注册之间遗漏早期请求
     */
    private startNetworkIdleWatcher(timeout: number, idleTime: number = 500): Promise<void> {
        this.ensureSession()
        return this.buildNetworkIdlePromise(this.cdp!, timeout, idleTime)
    }

    /**
     * 核心网络空闲等待逻辑
     *
     * 捕获 cdp 引用防止 close() 并发置 null，用局部 Set 追踪请求避免污染成员变量
     * close() 时通过 'disconnected' 信号立即 reject
     */
    private buildNetworkIdlePromise(cdp: CDPClient, timeout: number, idleTime: number): Promise<void> {
        const localPendingRequests = new Set<string>()

        return new Promise((resolve, reject) => {
            let idleTimer: NodeJS.Timeout | null = null
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
                const { requestId } = params as { requestId: string }
                localPendingRequests.add(requestId)
                checkIdle()
            }

            const onRequestEnd = (params: unknown) => {
                const { requestId } = params as { requestId: string }
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

            timeoutTimer = setTimeout(() => {
                cleanup()
                reject(new NavigationTimeoutError('networkidle', timeout))
            }, timeout)

            const onDisconnected = () => {
                cleanup()
                reject(new Error('CDP 连接已关闭'))
            }
            cdp.once('disconnected', onDisconnected)

            cdp.onEvent('Network.requestWillBeSent', onRequestStart)
            cdp.onEvent('Network.loadingFinished', onRequestEnd)
            cdp.onEvent('Network.loadingFailed', onRequestEnd)

            checkIdle()
        })
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
        const { sessionId } = (await this.cdp!.send('Target.attachToTarget', {
            targetId,
            flatten: true,
        })) as { sessionId: string }

        this.sessionId = sessionId
        this.currentTargetId = targetId

        // 初始化会话
        await this.initSession()
    }

    /**
     * 新建页面（内部版本，不加锁，供 launch 等已持锁方法调用）
     */
    private async newPageInternal(): Promise<TargetInfo> {
        this.ensureConnected()

        const { targetId } = (await this.cdp!.send('Target.createTarget', {
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
     * 供已持有 withLock 的方法调用（launch/connect），避免 close() 的 withLock 重入死锁，
     * 外部调用请使用 close()
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
        this.behaviorSimulator.setCurrentPosition({ x: 0, y: 0 })
        this.sessionId = null
        this.currentTargetId = null
        this.state = null
        this.listenersInstalled = false
        this.connectedPort = 0
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
     * 任一事件触发后清理所有监听器和超时定时器
     * close() 时通过 'disconnected' 信号立即 reject，不必等 timer 超时
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
                for (const { event, listener } of listeners) {
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
                listeners.push({ event, listener })
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
                type: string
                args: Array<{ value?: unknown; description?: string }>
                timestamp: number
                stackTrace?: { callFrames: Array<{ url: string; lineNumber: number }> }
            }
            this.consoleLogs.push({
                level: p.type,
                text: p.args.map((a) => a.value ?? a.description ?? '').join(' '),
                timestamp: Math.round(p.timestamp), // Runtime.Timestamp 已是 epoch 毫秒
                url: p.stackTrace?.callFrames[0]?.url,
                lineNumber: p.stackTrace?.callFrames[0]?.lineNumber,
            })
            // 环形缓冲区：批量裁剪到 800 条，均摊 O(n) 开销
            if (this.consoleLogs.length > SessionManager.MAX_LOG_ENTRIES) {
                this.consoleLogs.splice(0, this.consoleLogs.length - 800)
            }
        })

        // 网络请求
        this.cdp!.onEvent('Network.requestWillBeSent', (params: unknown) => {
            const p = params as {
                requestId: string
                request: { url: string; method: string }
                type: string
                timestamp: number
                wallTime: number
            }
            this.requestMap.set(p.requestId, {
                url: p.request.url,
                method: p.request.method,
                type: p.type,
                timestamp: Math.round(p.wallTime * 1000), // wallTime 是 epoch 秒 → epoch 毫秒
                _monotonic: p.timestamp, // MonotonicTime 用于 duration 计算
            })
        })

        this.cdp!.onEvent('Network.responseReceived', (params: unknown) => {
            const p = params as {
                requestId: string
                response: { status: number }
                timestamp: number
            }
            const request = this.requestMap.get(p.requestId)
            if (request) {
                const { _monotonic, ...requestData } = request
                this.networkRequests.push({
                    ...requestData,
                    status: p.response.status,
                    duration: Math.round((p.timestamp - _monotonic) * 1000),
                })
                // 环形缓冲区：批量裁剪到 800 条，均摊 O(n) 开销
                if (this.networkRequests.length > SessionManager.MAX_LOG_ENTRIES) {
                    this.networkRequests.splice(0, this.networkRequests.length - 800)
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

        const { url, title } = JSON.parse(result.result.value)
        this.state = {
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
export function getKeyDefinition(key: string): {
    key: string
    code: string
    keyCode: number
    text?: string
} {
    const definitions: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
        // 修饰键
        Control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
        Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
        Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
        Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
        // 功能键
        Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
        Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
        Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
        Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
        Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
        Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
        // 方向键
        ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
        ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
        ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
        ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
        // 其他常用键
        Home: { key: 'Home', code: 'Home', keyCode: 36 },
        End: { key: 'End', code: 'End', keyCode: 35 },
        PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
        PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    }

    // 如果是已知按键，返回定义
    if (definitions[key]) {
        return definitions[key]
    }

    // 如果是单个字符，生成定义
    if (key.length === 1) {
        // Windows VK code 对字母是大写 ASCII，对数字是数字 ASCII
        // 用 charCodeAt 的话 'a'=97 会被识别为键码 97（不是字母 A 的 0x41=65），导致快捷键无法匹配
        const vkCode = key >= 'a' && key <= 'z' ? key.toUpperCase().charCodeAt(0) : key.charCodeAt(0)
        const code =
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
            keyCode: vkCode,
            text: key,
        }
    }

    // 未知按键
    return { key, code: key, keyCode: 0 }
}

/**
 * 获取会话管理器实例
 */
export function getSession(): SessionManager {
    return SessionManager.getInstance()
}
