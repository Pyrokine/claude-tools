/**
 * 会话管理
 *
 * 管理浏览器会话，包括：
 * - CDP 客户端
 * - 反检测注入
 * - 页面状态
 * - 日志收集
 */

import { randomUUID } from 'node:crypto'
import {
    BROWSER_EVENT_METHODS,
    BrowserEventController,
    eventRefTarget,
    type BrowserEventAction,
    type EventCommand,
} from './browser-events.js'
import { browserEventCommandSchema } from './browser-event-schema.js'
import { installDomHelpers } from './dom-helpers.js'
import type {
    BrowserRequestContext,
    FrameSelection,
    SemanticTarget,
    CookieScope,
    UserActionKind,
} from './browser-driver.js'
import { BehaviorSimulator, getAntiDetectionScript } from '../anti-detection/index.js'
import { BrowserLauncher, CDPClient, getBrowserWSEndpoint, getTargets } from '../cdp/index.js'
import { assertScreenshotBase64Budget, assertScreenshotBudget } from '../tools/png.js'
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
    type InteractiveElementInfo,
    type ListedTarget,
    type NewPageOptions,
    type NewTabResult,
    type PageManagementResult,
    type ReadPageOptions,
    type ReadPageResult,
    type ScreenshotResult,
    type SetCookieParams,
    type StaleContextRetryPolicy,
} from './browser-driver.js'
import {
    CDPError,
    creationError,
    ElementNotFoundError,
    formatErrorResponse,
    NavigationError,
    NavigationTimeoutError,
    PagePreconditionError,
    SessionNotFoundError,
    setErrorSource,
    StructuredToolError,
    TargetNotFoundError,
    TimeoutError,
} from './errors.js'
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

import {
    remainingNavigationTimeout,
    waitForNavigationQueue,
    withNavigationBudget,
    withNavigationMetadata,
} from './utils.js'

function wildcardSegmentMatches(value: string, segment: string, index: number): boolean {
    if (index + segment.length > value.length) {
        return false
    }

    for (let i = 0; i < segment.length; ++i) {
        const expected = segment[i]
        if (expected !== '?' && expected !== value[index + i]) {
            return false
        }
    }

    return true
}

function wildcardSegmentIndexOf(value: string, segment: string, start: number): number {
    if (!segment.includes('?')) {
        return value.indexOf(segment, start)
    }

    for (let i = start; i <= value.length - segment.length; ++i) {
        if (wildcardSegmentMatches(value, segment, i)) {
            return i
        }
    }

    return -1
}

function matchesUrlPattern(url: string, pattern: string): boolean {
    const value = url.toLowerCase()
    const normalizedPattern = pattern.toLowerCase().replace(/\*+/g, '*')

    if (!normalizedPattern.includes('*') && !normalizedPattern.includes('?')) {
        return value.includes(normalizedPattern)
    }

    const segments = normalizedPattern.split('*').filter((segment) => segment.length > 0)
    let position = 0

    for (const segment of segments) {
        const index = wildcardSegmentIndexOf(value, segment, position)
        if (index < 0) {
            return false
        }
        position = index + segment.length
    }

    return true
}

function isCloudflareChallenge(headers: Record<string, unknown> | undefined): boolean {
    if (!headers) {
        return false
    }

    return Object.entries(headers).some(
        ([name, value]) => name.toLowerCase() === 'cf-mitigated' && String(value).toLowerCase() === 'challenge'
    )
}

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
    requestContext?: () => BrowserRequestContext | undefined
    private launcher: BrowserLauncher | null = null
    private cdp: CDPClient | null = null
    private connectedPort: number = 0
    private sessionId: string | null = null
    private currentTargetId: string | null = null
    private state: SessionState | null = null
    private revisionEpoch = randomUUID()
    private revisions = new Map<string, number>()
    private pendingPageCondition: { targetId: string; expectedUrl?: string; expectedRevision?: string } | null = null
    private behaviorSimulator = new BehaviorSimulator()
    private stealthMode: 'off' | 'safe' | 'aggressive' = 'safe'
    /** 当前按下的修饰键位掩码 */
    private modifiers = 0
    // 操作锁（防止并发竞态）
    private operationLock: Promise<void> = Promise.resolve()
    private consoleLogs: ConsoleLogEntry[] = []
    private networkRequests: NetworkRequestEntry[] = []
    private targetLogs = new Map<string, { console: ConsoleLogEntry[]; network: NetworkRequestEntry[] }>()
    private nextConsoleLogSequence = 0
    private nextNetworkRequestSequence = 0
    private challengeRequired = false
    private runtimeEnabled = false
    private mainFrameId: string | null = null
    private mainFrameLoaderId: string | null = null
    private requestMap = new Map<
        string,
        {
            url: string
            method: string
            type: string
            timestamp: number
            frameId?: string
            loaderId?: string
            status?: number
            challenge?: boolean
            _monotonic: number
        }
    >()

    // 监听器安装标志（防止重复安装）
    private listenersInstalled = false
    private targetSessions = new Map<string, string>()
    private eventControllers = new Map<string, BrowserEventController>()
    private childSessions = new Map<string, string>()
    private frameSessions = new Map<string, string>()
    private contexts = new Map<string, Array<{ id: number; frameId: string; isDefault: boolean }>>()
    private frameScopes = new Map<
        number,
        {
            targetId: string
            frameId: string
            contextId: number
            sessionId: string
            owners: Array<{
                parentSessionId: string
                backendNodeId: number
                frameId: string
                sessionId: string
                contextId: number
            }>
        }
    >()

    private selectedFrame = 0
    private nextFrameHandle = 0

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
                            targetCreated: true,
                        }
                    }

                    return {
                        targetId: pageTarget.id,
                        type: pageTarget.type,
                        url: pageTarget.url,
                        title: pageTarget.title,
                        reused: true,
                        targetCreated: false,
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
            this.cdp = new CDPClient(() => this.requestContext?.())
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
    async listTargets(timeout?: number): Promise<ListedTarget[]> {
        this.ensureConnected()

        // 从 CDP 获取 targets
        const { targetInfos } = (await this.sendBrowserCommand('Target.getTargets', undefined, timeout)) as {
            targetInfos: Array<{
                targetId: string
                type: string
                url: string
                title: string
            }>
        }

        const liveIds = new Set(targetInfos.map((target) => target.targetId))
        for (const targetId of this.targetLogs.keys()) {
            if (!liveIds.has(targetId)) {
                this.targetLogs.delete(targetId)
            }
        }
        return targetInfos
            .filter((t) => t.type === 'page')
            .map((t) => ({
                id: t.targetId,
                targetId: t.targetId,
                url: t.url,
                title: t.title,
                type: t.type,
                revision: `${this.revisionEpoch}:${this.revisions.get(t.targetId) ?? 0}`,
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
        const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT)
        return this.withLock(async () => {
            this.ensureSession()

            const { wait = 'load' } = options
            const abortController = new AbortController()
            const requestSignal = this.requestContext?.()?.signal
            requestSignal?.throwIfAborted()
            const navigationWait = this.startNavigationWait(
                wait,
                remainingNavigationTimeout(deadline),
                requestSignal ? AbortSignal.any([abortController.signal, requestSignal]) : abortController.signal,
                false
            )
            navigationWait.promise.catch(() => {})
            navigationWait.markActionStarted()

            try {
                const { frameId, loaderId, errorText } = (await this.send(
                    'Page.navigate',
                    { url },
                    remainingNavigationTimeout(deadline)
                )) as {
                    frameId: string
                    loaderId?: string
                    errorText?: string
                }
                if (errorText) {
                    // noinspection ExceptionCaughtLocallyJS -- Report failure
                    throw new NavigationError(url, errorText)
                }
                if (loaderId) {
                    navigationWait.setExpectedLoader(frameId, loaderId)
                } else {
                    navigationWait.setExpectedSameDocument(frameId)
                }
            } catch (error) {
                abortController.abort(error)
                throw error
            }

            await navigationWait.promise
            await withNavigationMetadata(() => this.updateState(remainingNavigationTimeout(deadline)))
        }, deadline)
    }

    /**
     * 等待网络空闲（无进行中的请求且持续指定时间）
     *
     * close() 时通过 'disconnected' 信号立即 reject，不必等 timer 超时
     */
    async waitForNetworkIdle(timeout: number, idleTime: number = 500): Promise<void> {
        this.ensureSession()
        return this.buildNetworkIdlePromise(this.cdp!, timeout, idleTime, this.requestContext?.()?.signal)
    }

    /**
     * 等待导航完成（跨文档导航或同文档导航）
     */
    async waitForNavigation(timeout: number = DEFAULT_TIMEOUT): Promise<void> {
        this.ensureSession()
        await this.waitForAnyEvent(
            ['Page.loadEventFired', 'Page.navigatedWithinDocument', 'Page.frameNavigated'],
            timeout
        )
    }

    /**
     * 后退
     */
    async goBack(timeout = DEFAULT_TIMEOUT): Promise<{ navigated: boolean }> {
        const deadline = Date.now() + timeout
        return this.withLock(async () => {
            this.ensureSession()
            const { currentIndex, entries } = await this.send<{
                currentIndex: number
                entries: Array<{ id: number; url: string; title: string }>
            }>('Page.getNavigationHistory', undefined, remainingNavigationTimeout(deadline))

            if (currentIndex <= 0) {
                return { navigated: false }
            }

            const abortController = new AbortController()
            const requestSignal = this.requestContext?.()?.signal
            // 跨文档加载、主 frame BFCache 恢复和同文档导航分别提供完成事件
            const waitPromise = this.waitForAnyEvent(
                ['Page.loadEventFired', 'Page.navigatedWithinDocument', 'Page.frameNavigated'],
                remainingNavigationTimeout(deadline),
                requestSignal ? AbortSignal.any([abortController.signal, requestSignal]) : abortController.signal
            )
            // 预注册 rejection handler，发送失败时局部取消也会使等待 Promise reject
            waitPromise.catch(() => {})
            try {
                await this.send(
                    'Page.navigateToHistoryEntry',
                    { entryId: entries[currentIndex - 1].id },
                    remainingNavigationTimeout(deadline)
                )
            } catch (error) {
                abortController.abort(error)
                throw error
            }
            await waitPromise
            await withNavigationMetadata(() => this.updateState(remainingNavigationTimeout(deadline)))
            return { navigated: true }
        }, deadline)
    }

    /**
     * 前进
     */
    async goForward(timeout = DEFAULT_TIMEOUT): Promise<{ navigated: boolean }> {
        const deadline = Date.now() + timeout
        return this.withLock(async () => {
            this.ensureSession()
            const { currentIndex, entries } = await this.send<{
                currentIndex: number
                entries: Array<{ id: number; url: string; title: string }>
            }>('Page.getNavigationHistory', undefined, remainingNavigationTimeout(deadline))

            if (currentIndex >= entries.length - 1) {
                return { navigated: false }
            }

            const abortController = new AbortController()
            const requestSignal = this.requestContext?.()?.signal
            // 跨文档加载、主 frame BFCache 恢复和同文档导航分别提供完成事件
            const waitPromise = this.waitForAnyEvent(
                ['Page.loadEventFired', 'Page.navigatedWithinDocument', 'Page.frameNavigated'],
                remainingNavigationTimeout(deadline),
                requestSignal ? AbortSignal.any([abortController.signal, requestSignal]) : abortController.signal
            )
            waitPromise.catch(() => {})
            try {
                await this.send(
                    'Page.navigateToHistoryEntry',
                    { entryId: entries[currentIndex + 1].id },
                    remainingNavigationTimeout(deadline)
                )
            } catch (error) {
                abortController.abort(error)
                throw error
            }
            await waitPromise
            await withNavigationMetadata(() => this.updateState(remainingNavigationTimeout(deadline)))
            return { navigated: true }
        }, deadline)
    }

    /**
     * 刷新
     */
    async reload(ignoreCache = false, waitUntil: string = 'load', timeout = DEFAULT_TIMEOUT): Promise<void> {
        const deadline = Date.now() + timeout
        return this.withLock(async () => {
            this.ensureSession()

            const abortController = new AbortController()
            const requestSignal = this.requestContext?.()?.signal
            requestSignal?.throwIfAborted()
            const navigationWait = this.startNavigationWait(
                waitUntil as WaitUntil,
                remainingNavigationTimeout(deadline),
                requestSignal ? AbortSignal.any([abortController.signal, requestSignal]) : abortController.signal,
                true
            )
            navigationWait.promise.catch(() => {})
            navigationWait.markActionStarted()

            try {
                await this.send('Page.reload', { ignoreCache }, remainingNavigationTimeout(deadline))
            } catch (error) {
                abortController.abort(error)
                throw error
            }

            await navigationWait.promise
            await withNavigationMetadata(() => this.updateState(remainingNavigationTimeout(deadline)))
        }, deadline)
    }

    /**
     * 创建定位器
     */
    createLocator(target: Target, options?: { timeout?: number; nth?: number }): Locator {
        this.ensureSession()
        const frame = this.frameScopes.get(this.selectedFrame)
        return new Locator(this.cdp!, target, frame?.sessionId ?? this.sessionId!, {
            contextId: frame?.contextId,
            localPoint: frame
                ? async (timeout) => {
                      const deadline = Date.now() + timeout
                      for (const owner of frame.owners) {
                          if (
                              owner.parentSessionId === frame.sessionId &&
                              (await this.getFrameOwnerZoom(owner, remainingNavigationTimeout(deadline))) !== 1
                          ) {
                              return true
                          }
                      }
                      return false
                  }
                : undefined,
            mapPoint: (point, timeout) => this.mapFramePoint(point, timeout, false, frame),
            mapViewportPoint: (point, timeout) => this.mapFramePoint(point, timeout, true, frame),
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
        return new AutoWait(this.cdp!, this.frameScopes.get(this.selectedFrame)?.sessionId ?? this.sessionId!, options)
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
    async mouseMove(x: number, y: number, timeout?: number): Promise<void> {
        this.ensureSession()
        // 整数点位：避免 sub-pixel 渲染时坐标命中元素边界外的情况（与 Playwright 一致）
        const ix = Math.round(x)
        const iy = Math.round(y)
        await this.send(
            'Input.dispatchMouseEvent',
            {
                type: 'mouseMoved',
                x: ix,
                y: iy,
                modifiers: this.modifiers,
            },
            timeout
        )
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

    getModifiers(): number {
        return this.modifiers
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
        options?: { rawKeyDown?: boolean; autoRepeat?: boolean },
        timeout?: number
    ): Promise<void> {
        this.ensureSession()
        const nextModifiers = MODIFIER_KEYS[key] ? this.modifiers | MODIFIER_KEYS[key] : this.modifiers
        const keyDefinition = getKeyDefinition(key)
        const params: Record<string, unknown> = {
            type: options?.rawKeyDown ? 'rawKeyDown' : 'keyDown',
            modifiers: nextModifiers,
            ...keyDefinition,
        }
        if (commands && commands.length > 0) {
            delete params.text
            params.commands = commands
        }
        if (options?.autoRepeat) {
            params.autoRepeat = true
        }
        await this.send('Input.dispatchKeyEvent', params, timeout)
        this.modifiers = nextModifiers
    }

    /**
     * 键盘释放
     */
    async keyUp(
        key: string,
        timeout?: number,
        inputContext?: { targetId: string; frameId?: number; modifiers: number }
    ): Promise<void> {
        const keyDefinition = getKeyDefinition(key)
        const nextModifiers =
            inputContext?.modifiers ?? (MODIFIER_KEYS[key] ? this.modifiers & ~MODIFIER_KEYS[key] : this.modifiers)
        const params = { type: 'keyUp', modifiers: nextModifiers, ...keyDefinition }
        if (inputContext) {
            this.ensureConnected()
            const frame = inputContext.frameId ? this.frameScopes.get(inputContext.frameId) : undefined
            const sessionId = inputContext.frameId
                ? frame?.targetId === inputContext.targetId
                    ? frame.sessionId
                    : undefined
                : this.targetSessions.get(inputContext.targetId)
            if (!sessionId) {
                throw new DriverCapabilityError('Original input session is no longer available for key release')
            }
            this.revisions.set(inputContext.targetId, (this.revisions.get(inputContext.targetId) ?? 0) + 1)
            await this.cdp!.send('Input.dispatchKeyEvent', params, sessionId, timeout)
        } else {
            await this.send('Input.dispatchKeyEvent', params, timeout)
        }
        if (!inputContext || inputContext.targetId === this.currentTargetId) {
            this.modifiers = nextModifiers
        }
    }

    /**
     * 输入文本
     */
    async type(text: string, delay = 0, timeout = DEFAULT_TIMEOUT): Promise<void> {
        this.ensureSession()
        const deadline = Date.now() + timeout
        const remainingTimeout = () => {
            const remaining = deadline - Date.now()
            if (remaining <= 0) {
                throw new TimeoutError('input timeout during typing')
            }
            return remaining
        }
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
                const keyDownTimeout = remainingTimeout()
                try {
                    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...enterParams }, keyDownTimeout)
                    await this.send(
                        'Input.dispatchKeyEvent',
                        { type: 'char', text: '\r', ...enterParams },
                        remainingTimeout()
                    )
                } finally {
                    await this.send(
                        'Input.dispatchKeyEvent',
                        { type: 'keyUp', ...enterParams },
                        Math.max(1, deadline - Date.now())
                    )
                }
            } else {
                const keyDownTimeout = remainingTimeout()
                try {
                    await this.send(
                        'Input.dispatchKeyEvent',
                        { type: 'keyDown', modifiers: this.modifiers, text: char },
                        keyDownTimeout
                    )
                } finally {
                    await this.send(
                        'Input.dispatchKeyEvent',
                        { type: 'keyUp', modifiers: this.modifiers, text: char },
                        Math.max(1, deadline - Date.now())
                    )
                }
            }
            if (delay > 0) {
                await new Promise((r) => setTimeout(r, Math.min(delay, remainingTimeout())))
            }
        }
        remainingTimeout()
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
            captureParams.captureBeyondViewport = true
        }

        if (fullPage) {
            // 获取页面完整高度
            const sizeExpr =
                'JSON.stringify({ width: document.documentElement.scrollWidth, ' +
                'height: document.documentElement.scrollHeight, devicePixelRatio: window.devicePixelRatio })'
            const { result } = (await this.send('Runtime.evaluate', {
                expression: sizeExpr,
                returnByValue: true,
            })) as { result: { value: string } }

            let width: number, height: number, devicePixelRatio: number
            try {
                ;({ width, height, devicePixelRatio } = JSON.parse(result.value))
            } catch {
                throw new Error(`screenshot: 无法解析页面尺寸: ${result.value}`)
            }

            assertScreenshotBudget(width, height, (scale ?? 1) * devicePixelRatio)
            captureParams.clip = { x: 0, y: 0, width, height, scale: scale ?? 1 }
            captureParams.captureBeyondViewport = true
            const { data } = (await this.send('Page.captureScreenshot', captureParams)) as { data: string }
            assertScreenshotBase64Budget(data)
            return { data, format: effectiveFormat }
        }

        if (clip) {
            assertScreenshotBudget(clip.width, clip.height, scale ?? 1)
        } else {
            const metrics = (await this.send('Page.getLayoutMetrics')) as {
                cssVisualViewport?: { clientWidth: number; clientHeight: number }
                cssLayoutViewport?: { clientWidth: number; clientHeight: number }
            }
            const viewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport
            if (!viewport) {
                throw new Error('screenshot: 浏览器未返回 CSS 视口尺寸，未执行截图')
            }
            assertScreenshotBudget(viewport.clientWidth, viewport.clientHeight, 1)
        }
        const { data } = (await this.send('Page.captureScreenshot', captureParams)) as { data: string }
        assertScreenshotBase64Budget(data)
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
        const { nodes } = (await this.send(
            'Accessibility.getFullAXTree',
            this.selectedFrame ? { frameId: this.frameScopes.get(this.selectedFrame)?.frameId } : undefined
        )) as {
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
            await this.evaluate(`(${installDomHelpers.toString()})();`)
            const prop = outer ? 'outerHTML' : 'innerHTML'
            return this.evaluate<string>(
                `((s, p) => { const el = globalThis.__mcpDomHelpers.query({selector:s})[0]; return el ? el[p] : '' })`,
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
            await this.evaluate(`(${installDomHelpers.toString()})();`)
            return this.evaluate<string>(
                `(s => {
                    const element = globalThis.__mcpDomHelpers.query({selector:s})[0];
                    return element instanceof HTMLElement ? element.innerText : (element?.textContent ?? '');
                })`,
                [selector]
            )
        }
        return this.evaluate<string>('document.body.innerText')
    }

    // ==================== IBrowserDriver: 页面读取 ====================

    /** Extension readPage 等价物：CDP 通过页面 DOM 构造 pageContent 和 interactiveElements */
    async readPage(options?: ReadPageOptions & { target?: Target; timeout?: number }): Promise<ReadPageResult> {
        const state = await this.getPageState()
        const interactiveElements = await this.collectInteractiveElements(
            options?.depth,
            options?.target,
            options?.timeout
        )
        const lines = interactiveElements.map((e) => {
            let line = e.role
            if (e.name) {
                line += ` ${JSON.stringify(e.name)}`
            }
            if (e.type) {
                line += ` type=${JSON.stringify(e.type)}`
            }
            if (e.value !== undefined) {
                line += ` value=${JSON.stringify(e.value)}`
            }
            return line
        })
        return {
            pageContent: lines.join('\n'),
            viewport: state.viewport,
            interactiveElements,
        }
    }

    async collectInteractiveElements(
        depth?: number,
        target?: Target,
        timeout?: number
    ): Promise<InteractiveElementInfo[]> {
        const maxDepth = Number.isInteger(depth) && depth !== undefined && depth >= 0 ? depth : 15
        await this.evaluate(`(${installDomHelpers.toString()})();`, undefined, timeout)
        const script = `function() {
            var root = this;
            var maxDepth = ${maxDepth};
            function selectorFor(el) {
                if (!(el instanceof Element)) return '';
                if (el.id) return '#' + CSS.escape(el.id);
                var parts = [];
                var current = el;
                while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
                    var part = current.tagName.toLowerCase();
                    if (current.classList && current.classList.length) {
                        part += '.' + Array.from(current.classList)
                            .slice(0, 2)
                            .map(function(cls) { return CSS.escape(cls); })
                            .join('.');
                    }
                    var parent = current.parentElement;
                    if (parent) {
                        var siblings = Array.from(parent.children).filter(function(child) {
                            return child.tagName === current.tagName;
                        });
                        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
                    }
                    parts.unshift(part);
                    current = parent;
                }
                return parts.join(' > ');
            }
            function depthFor(el) {
                var depth = 0;
                var current = el;
                while (current !== root && (current.parentElement || current.getRootNode().host)) {
                    depth += 1;
                    current = current.parentElement || current.getRootNode().host;
                }
                return depth;
            }
            var selector = [
                'button,a[href],input,textarea,select,[role]',
                '[contenteditable="true"],[tabindex]:not([tabindex="-1"])'
            ].join(',');
            var elements = globalThis.__mcpDomHelpers.query({selector:selector}, root);
            if (root.nodeType === 1 && root.matches(selector)) elements.unshift(root);
            return elements.filter(function(el) {
                return depthFor(el) <= maxDepth;
            }).slice(0, 100).map(function(el, index) {
                var rect = el.getBoundingClientRect();
                var cx = rect.left + rect.width / 2;
                var cy = rect.top + rect.height / 2;
                var top = rect.width > 0 && rect.height > 0
                    ? globalThis.__mcpDomHelpers.deepElementFromPoint(cx, cy) : null;
                var style = getComputedStyle(el);
                var visible = rect.width > 0 && rect.height > 0 &&
                    style.visibility !== 'hidden' && style.display !== 'none';
                var name = globalThis.__mcpDomHelpers.accessibleName(el, true);
                var type = el.tagName.toLowerCase() === 'input' ? el.type : undefined;
                var value = type !== undefined && !['hidden','password','file'].includes(type) &&
                    (!name || !['button','submit','reset'].includes(type)) ? el.value : undefined;
                return {
                    refId: 'cdp-' + index,
                    role: globalThis.__mcpDomHelpers.role(el),
                    name: name,
                    ...(type !== undefined ? {type: type} : {}),
                    ...(value !== undefined ? {value: value} : {}),
                    selector: selectorFor(el),
                    visible: visible,
                    disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
                    bounds: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
                    covered: Boolean(visible && top && top !== el && !el.contains(top)),
                    frameId: 0
                };
            });
        }`
        if (target && 'x' in target && 'y' in target) {
            const elements = await this.evaluate<InteractiveElementInfo[] | null>(
                `(() => {
                    const root = globalThis.__mcpDomHelpers.deepElementFromPoint(${JSON.stringify(target.x)}, ${JSON.stringify(target.y)});
                    return root ? (${script}).call(root) : null;
                })()`,
                undefined,
                timeout
            )
            if (!elements) {
                throw new ElementNotFoundError(target, timeout ?? DEFAULT_TIMEOUT)
            }
            return elements
        }
        return target
            ? this.createLocator(target, timeout !== undefined ? { timeout } : undefined).evaluateOn<
                  InteractiveElementInfo[]
              >(script)
            : this.evaluate<InteractiveElementInfo[]>(`(${script}).call(document)`, undefined, timeout)
    }

    async getFrames(): Promise<Record<string, unknown>> {
        this.ensureSession()
        const frameTree = (await this.send('Page.getFrameTree')) as {
            frameTree: {
                frame: { id: string; parentId?: string; url: string; name?: string; mimeType?: string }
                childFrames?: Array<unknown>
            }
        }
        const frames: Array<Record<string, unknown>> = []
        const visit = (node: typeof frameTree.frameTree, parentFrameId?: string): void => {
            const index = frames.length
            frames.push({
                index,
                frameId: node.frame.id,
                parentFrameId: node.frame.parentId ?? parentFrameId ?? null,
                url: node.frame.url,
                title: index === 0 ? (this.state?.title ?? null) : null,
                name: node.frame.name ?? null,
                selector: null,
                rect: null,
                mimeType: node.frame.mimeType,
            })
            for (const child of node.childFrames ?? []) {
                visit(child as typeof frameTree.frameTree, node.frame.id)
            }
        }
        visit(frameTree.frameTree)
        return { frames }
    }

    /** CDP 通过 evaluate 注入函数枚举 IMG */
    async getHtmlWithImages(selector?: string, outer = true): Promise<HtmlWithImagesResult> {
        await this.evaluate(`(${installDomHelpers.toString()})();`)
        const selectorArg = JSON.stringify(selector ?? null)
        return this.evaluate<HtmlWithImagesResult>(`(function() {
            var root = ${selectorArg}
                ? globalThis.__mcpDomHelpers.query({selector:${selectorArg}})[0] : document.documentElement;
            if (!root) return {html: '', images: []};
            var html = ${selectorArg}
                ? (${outer} ? root.outerHTML : root.innerHTML)
                : document.documentElement.outerHTML;
            var imgList = [];
            if (root.tagName === 'IMG') imgList.push(root);
            globalThis.__mcpDomHelpers.query({selector:'img'},root).forEach(function(img) { imgList.push(img); });
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
                url: location.href,
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
    async find(
        selector?: string,
        text?: string,
        xpath?: string,
        timeout?: number,
        semanticOrMatchIndex?: SemanticTarget | number,
        matchIndex?: number
    ): Promise<FindResult[]> {
        const semantic = typeof semanticOrMatchIndex === 'object' ? semanticOrMatchIndex : undefined
        const nth = typeof semanticOrMatchIndex === 'number' ? semanticOrMatchIndex : matchIndex
        await this.evaluate(`(${installDomHelpers.toString()})();`, undefined, timeout)
        return this.evaluate<FindResult[]>(
            `function(selector, text, xpath, semantic, nth) {
            const elements = globalThis.__mcpDomHelpers.query({
                selector: selector ?? undefined, text: text ?? undefined,
                xpath: xpath ?? undefined, semantic: semantic ?? undefined
            });
            return (nth == null ? elements.slice(0,50) : elements.slice(nth,nth+1)).map(el => {
                const r = el.getBoundingClientRect();
                return {
                    refId: '', tag: el.tagName.toLowerCase(),
                    text: (el.textContent || '').trim().slice(0,100),
                    rect: {x:r.x,y:r.y,width:r.width,height:r.height}
                };
            });
        }`,
            [selector ?? null, text ?? null, xpath ?? null, semantic ?? null, nth ?? null],
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

    checkActionability(_refId: string): Promise<ActionableClickResult> {
        return Promise.reject(new DriverCapabilityError('checkActionability 仅支持 Extension 模式'))
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
        await this.evaluate(`(${installDomHelpers.toString()})();`)
        return this.evaluate<string | null>(
            `(s, a) => {
                const el = globalThis.__mcpDomHelpers.query({selector:s})[0];
                return el ? el.getAttribute(a) : null;
            }`,
            [selector, attribute]
        )
    }

    // ==================== IBrowserDriver: 输入（precise） ====================

    /** CDP 通用 inputKey 接口实现：直接转发 Input.dispatchKeyEvent，不维护 modifiers（由调用方提供） */
    async inputKey(type: InputKeyType, options: InputKeyOptions = {}, timeout?: number): Promise<void> {
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
        await this.send('Input.dispatchKeyEvent', params, timeout)
    }

    /** CDP 通用 inputMouse 接口实现：直接转发 Input.dispatchMouseEvent */
    async inputMouse(
        type: InputMouseType,
        x: number,
        y: number,
        options: InputMouseOptions & { releaseAfterPress?: boolean } = {},
        timeout?: number
    ): Promise<void> {
        const deadline = timeout === undefined ? undefined : Date.now() + timeout
        this.ensureSession()
        if (deadline !== undefined) {
            remainingNavigationTimeout(deadline)
        }
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
        if (type === 'mousePressed' && options.releaseAfterPress) {
            const cdp = this.cdp!
            const sessionId = this.sessionId ?? undefined
            let failed = false
            let failure: unknown
            try {
                await withNavigationBudget(
                    () =>
                        this.send(
                            'Input.dispatchMouseEvent',
                            params,
                            deadline === undefined ? undefined : remainingNavigationTimeout(deadline)
                        ),
                    deadline
                )
            } catch (error) {
                failed = true
                failure = error
            } finally {
                try {
                    await cdp.send('Input.dispatchMouseEvent', { ...params, type: 'mouseReleased' }, sessionId, 1000)
                } catch (error) {
                    if (failed) {
                        console.warn('[MCP] 鼠标释放清理失败，请检查原目标会话的鼠标状态')
                    } else {
                        failed = true
                        failure = error
                    }
                }
            }
            if (failed) {
                throw failure
            }
        } else {
            await this.send('Input.dispatchMouseEvent', params, timeout)
        }
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
    inputType(text: string, delay = 0, timeout?: number): Promise<void> {
        return this.type(text, delay, timeout)
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

    /** Runtime.enable 会暴露 CDP，只在需要 console 事件时再开 */
    async consoleEnable(): Promise<void> {
        await this.ensureRuntimeEnabled()
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

    async activatePageWithAffected(targetId: string): Promise<PageManagementResult> {
        return this.withLock(async () => {
            const before = (await this.listTargets()).find((target) => target.targetId === targetId)
            if (!before) {
                throw new TargetNotFoundError(targetId)
            }
            if (this.pendingPageCondition) {
                const condition = this.pendingPageCondition
                await this.assertPageCondition(targetId, condition.expectedUrl, condition.expectedRevision)
                this.pendingPageCondition = null
            }
            await this.activateTarget(targetId)
            const after = (await this.listTargets()).find((target) => target.targetId === targetId)
            if (!after) {
                throw new TargetNotFoundError(targetId)
            }
            return { targetId, before, after }
        })
    }

    /** IBrowserDriver 接口：选择操作目标（attach 即可） */
    async selectPage(targetId: string, timeout?: number): Promise<void> {
        const deadline = timeout === undefined ? undefined : Date.now() + timeout
        await this.withLock(() => this.attachToTargetInternal(targetId, deadline), deadline)
    }

    /** IBrowserDriver 接口：获取当前操作目标 ID */
    getCurrentTargetId(): string | null {
        return this.currentTargetId
    }

    async deselectPage(timeout?: number): Promise<void> {
        const sid = this.sessionId
        try {
            if (sid && this.cdp?.isConnected && !this.eventControllers.has(sid)) {
                await this.cdp.send('Target.detachFromTarget', { sessionId: sid }, undefined, timeout)
            }
        } finally {
            this.clearAttachedTargetState()
        }
    }

    async getPageSnapshot(
        targetId: string,
        timeout?: number
    ): Promise<{ targetId: string; url: string; revision: string }> {
        this.ensureConnected()
        const { targetInfo } = await this.sendBrowserCommand<{
            targetInfo: { targetId: string; url?: string; type: string }
        }>('Target.getTargetInfo', { targetId }, timeout)
        if (targetInfo.type !== 'page' || targetInfo.targetId !== targetId) {
            throw new TargetNotFoundError(targetId)
        }
        return {
            targetId,
            url: targetInfo.url ?? '',
            revision: `${this.revisionEpoch}:${this.revisions.get(targetId) ?? 0}`,
        }
    }

    setPageCondition(condition: { targetId: string; expectedUrl?: string; expectedRevision?: string } | null): void {
        this.pendingPageCondition = condition
    }

    async assertPageCondition(
        targetId: string,
        expectedUrl?: string,
        expectedRevision?: string,
        timeout?: number
    ): Promise<void> {
        const snapshot = await this.getPageSnapshot(targetId, timeout)
        if (
            (expectedUrl !== undefined && snapshot.url !== expectedUrl) ||
            (expectedRevision !== undefined && snapshot.revision !== expectedRevision)
        ) {
            throw new PagePreconditionError({
                targetId,
                expectedUrl: expectedUrl ?? null,
                expectedRevision: expectedRevision ?? null,
                actualUrl: snapshot.url,
                actualRevision: snapshot.revision,
            })
        }
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

    // ==================== IBrowserDriver: 原生 frame scope ====================

    async resolveFrame(frame: FrameSelection, timeout?: number): Promise<FrameResolveResult> {
        this.ensureSession()
        const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)
        const rootSid = this.sessionId!
        await this.cdp!.send(
            'Target.setAutoAttach',
            {
                autoAttach: true,
                waitForDebuggerOnStart: false,
                flatten: true,
                filter: [{ type: 'iframe', exclude: false }],
            },
            rootSid,
            remainingNavigationTimeout(deadline)
        )
        await this.cdp!.send('Runtime.enable', {}, rootSid, remainingNavigationTimeout(deadline))
        const tree = await this.cdp!.send<{ frameTree: { frame: { id: string } } }>(
            'Page.getFrameTree',
            {},
            rootSid,
            remainingNavigationTimeout(deadline)
        )
        let nativeFrame = tree.frameTree.frame.id
        let sid = rootSid
        const owners: NonNullable<ReturnType<typeof this.frameScopes.get>>['owners'] = []
        const path = Array.isArray(frame) ? frame : [frame]
        if (!path.length) {
            throw new DriverCapabilityError('Frame path must contain at least one selection')
        }
        for (const selection of path) {
            const context = (this.contexts.get(sid) ?? []).find((c) => c.frameId === nativeFrame && c.isDefault)
            if (!context) {
                throw new DriverCapabilityError(`Default execution context unavailable for frame ${nativeFrame}`)
            }
            const query =
                typeof selection === 'number'
                    ? `globalThis.__mcpDomHelpers.query({selector:'iframe,frame'})[${selection}]`
                    : `globalThis.__mcpDomHelpers.query({selector:${JSON.stringify(selection)}})[0]`
            const expression = `(${installDomHelpers.toString()})();${query}`
            const resolutionContext = {
                tabId: this.currentTargetId,
                phase: 'frame_resolution',
                selection,
                path,
                actionExecuted: false,
                actionStatus: 'not_started',
                retryable: false,
            }
            const result = await this.cdp!.send<{
                result: CdpResultObject
                exceptionDetails?: { text: string; exception?: { className?: string; description?: string } }
            }>(
                'Runtime.evaluate',
                { expression, contextId: context.id, returnByValue: false },
                sid,
                remainingNavigationTimeout(deadline)
            )
            if (result.exceptionDetails || !result.result.objectId) {
                const exception = result.exceptionDetails?.exception
                const invalidSelector =
                    exception?.className === 'SyntaxError' ||
                    (exception?.className === 'DOMException' && /^SyntaxError:/.test(exception.description ?? ''))
                if (result.exceptionDetails && !invalidSelector) {
                    throw new DriverCapabilityError('Frame selection failed: ' + result.exceptionDetails.text)
                }
                throw new StructuredToolError(
                    invalidSelector ? 'INVALID_FRAME_SELECTOR' : 'FRAME_NOT_FOUND',
                    'Frame selection did not resolve to a current frame element',
                    '请检查当前页面的 iframe selector 或 DOM 索引',
                    { ...resolutionContext, selectionStatus: invalidSelector ? 'invalid-selector' : 'not-found' }
                )
            }
            const objectSessionId = sid
            try {
                const descriptor = await this.cdp!.send<{
                    node: { nodeName: string; frameId?: string; backendNodeId: number }
                }>('DOM.describeNode', { objectId: result.result.objectId }, sid, remainingNavigationTimeout(deadline))
                if (!['IFRAME', 'FRAME'].includes(descriptor.node.nodeName) || !descriptor.node.frameId) {
                    const notFrame = !['IFRAME', 'FRAME'].includes(descriptor.node.nodeName)
                    throw new StructuredToolError(
                        notFrame ? 'FRAME_NOT_IFRAME' : 'FRAME_IDENTITY_UNAVAILABLE',
                        'Selected element does not identify a native child frame',
                        '请检查所选元素及当前 iframe 文档',
                        { ...resolutionContext, selectionStatus: notFrame ? 'not-frame' : 'found' }
                    )
                }
                nativeFrame = descriptor.node.frameId
                sid = this.frameSessions.get(nativeFrame) ?? sid
                await this.cdp!.send('Runtime.enable', {}, sid, remainingNavigationTimeout(deadline))
                if (!(this.contexts.get(sid) ?? []).some((c) => c.frameId === nativeFrame && c.isDefault)) {
                    const oopif = await this.cdp!.waitForEvent<{
                        context: { auxData?: { frameId?: string; isDefault?: boolean } }
                    }>(
                        'Runtime.executionContextCreated',
                        (p) => p.context.auxData?.frameId === nativeFrame && p.context.auxData.isDefault === true,
                        remainingNavigationTimeout(deadline),
                        undefined,
                        this.requestContext?.()?.signal
                    )
                    void oopif
                    sid = this.frameSessions.get(nativeFrame) ?? sid
                }
                const childContext = (this.contexts.get(sid) ?? []).find(
                    (c) => c.frameId === nativeFrame && c.isDefault
                )
                if (!childContext) {
                    throw new DriverCapabilityError('Frame execution context changed during selection')
                }
                owners.push({
                    parentSessionId: objectSessionId,
                    backendNodeId: descriptor.node.backendNodeId,
                    frameId: nativeFrame,
                    sessionId: sid,
                    contextId: childContext.id,
                })
            } finally {
                void this.cdp!.send(
                    'Runtime.releaseObject',
                    { objectId: result.result.objectId },
                    objectSessionId
                ).catch(() => {})
            }
        }
        const context = (this.contexts.get(sid) ?? []).find((c) => c.frameId === nativeFrame && c.isDefault)
        if (!context) {
            throw new DriverCapabilityError('Frame execution context changed during selection')
        }
        const handle = ++this.nextFrameHandle
        if (this.frameScopes.size > 64) {
            this.frameScopes.delete(this.frameScopes.keys().next().value!)
        }
        this.frameScopes.set(handle, {
            targetId: this.currentTargetId!,
            frameId: nativeFrame,
            contextId: context.id,
            sessionId: sid,
            owners,
        })
        return {
            frameId: handle,
            offset: null,
            frameContext: {
                backend: 'cdp',
                frameId: nativeFrame,
                contextId: context.id,
                sessionId: sid,
                selection: frame,
            },
        }
    }

    async mapFramePoint(
        point: { x: number; y: number },
        timeout = DEFAULT_TIMEOUT,
        viewportPoint = false,
        frame = this.frameScopes.get(this.selectedFrame)
    ): Promise<{ x: number; y: number }> {
        if (!frame) {
            return point
        }
        const deadline = Date.now() + timeout
        const remaining = () => remainingNavigationTimeout(deadline)
        let currentSession = frame.sessionId
        let local = !viewportPoint
        let mapped = point
        try {
            for (const owner of [...frame.owners].reverse()) {
                // Same-session quads already include every ancestor in that viewport.
                const sameViewport = !local && owner.parentSessionId === currentSession
                if (sameViewport && (await this.getFrameOwnerZoom(owner, remaining())) === 1) {
                    continue
                }
                if (sameViewport) {
                    // Descendant quads omit an ancestor iframe's CSS zoom. Undo their query viewport first.
                    const anchor = await this.cdp!.send<{ result: { objectId?: string } }>(
                        'Runtime.evaluate',
                        {
                            contextId: owner.contextId,
                            returnByValue: false,
                            expression: `(() => {
                            const walk=document.createTreeWalker(document,NodeFilter.SHOW_ELEMENT);
                            for(let el=walk.nextNode();el;el=walk.nextNode()) {
                                const r=el.getBoundingClientRect();
                                if (!(r.width>0 && r.height>0) || el.getClientRects().length!==1) continue;
                                let aligned=true;
                                for(let p=el;p;p=p.parentElement) {
                                    const s=getComputedStyle(p),m=new DOMMatrix(s.transform==='none'?undefined:s.transform);
                                    if(!m.is2D || Math.abs(m.b)>1e-12 || Math.abs(m.c)>1e-12 || m.a<=0 || m.d<=0 ||
                                        (s.rotate&&s.rotate!=='none'&&!/^(?:[xyz] )?0deg$/.test(s.rotate)) ||
                                        (s.scale&&s.scale!=='none'&&s.scale.split(/\\s+/).some(value=>Number(value)<=0))) {aligned=false;break}
                                }
                                if(aligned)return el;
                            }
                            return null;
                        })()`,
                        },
                        owner.sessionId,
                        remaining()
                    )
                    const objectId = anchor.result.objectId
                    if (!objectId) {
                        throw new Error('Frame zoom viewport anchor is unavailable')
                    }
                    try {
                        const {
                            result: { value: r },
                        } = await this.cdp!.send<{
                            result: { value: { x: number; y: number; width: number; height: number } }
                        }>(
                            'Runtime.callFunctionOn',
                            {
                                objectId,
                                functionDeclaration:
                                    'function(){const r=this.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}',
                                returnByValue: true,
                            },
                            owner.sessionId,
                            remaining()
                        )
                        const {
                            model: { border: q },
                        } = await this.cdp!.send<{ model: { border: number[] } }>(
                            'DOM.getBoxModel',
                            { objectId },
                            owner.sessionId,
                            remaining()
                        )
                        if (!(r.width > 0 && r.height > 0) || q.length !== 8 || !q.every(Number.isFinite)) {
                            throw new Error('Frame zoom viewport anchor is invalid')
                        }
                        const [a, b, c, d] = [
                            (q[2] - q[0]) / r.width,
                            (q[3] - q[1]) / r.width,
                            (q[6] - q[0]) / r.height,
                            (q[7] - q[1]) / r.height,
                        ]
                        const determinant = a * d - b * c
                        if (
                            Math.abs(determinant) < 1e-12 ||
                            Math.abs(q[4] - q[2] - q[6] + q[0]) > 0.001 ||
                            Math.abs(q[5] - q[3] - q[7] + q[1]) > 0.001
                        ) {
                            throw new Error('Frame zoom viewport anchor is singular or non-affine')
                        }
                        const dx = mapped.x - q[0],
                            dy = mapped.y - q[1]
                        mapped = { x: (d * dx - c * dy) / determinant + r.x, y: (a * dy - b * dx) / determinant + r.y }
                    } finally {
                        await this.cdp!.send('Runtime.releaseObject', { objectId }, owner.sessionId, 1000).catch(
                            (error: unknown) => console.warn('[MCP] Frame zoom anchor cleanup failed:', error)
                        )
                    }
                }
                if (
                    !(this.contexts.get(owner.sessionId) ?? []).some(
                        (c) => c.id === owner.contextId && c.frameId === owner.frameId
                    )
                ) {
                    throw new Error('Frame document identity changed before input')
                }
                const { node } = await this.cdp!.send<{ node: { frameId?: string } }>(
                    'DOM.describeNode',
                    { backendNodeId: owner.backendNodeId },
                    owner.parentSessionId,
                    remaining()
                )
                if (node.frameId !== owner.frameId) {
                    throw new Error('Frame owner identity changed before input')
                }
                const { model } = await this.cdp!.send<{ model: { content: number[] } }>(
                    'DOM.getBoxModel',
                    { backendNodeId: owner.backendNodeId },
                    owner.parentSessionId,
                    remaining()
                )
                const viewport = await this.cdp!.send<{
                    result: { value: { width: number; height: number } }
                    exceptionDetails?: unknown
                }>(
                    'Runtime.evaluate',
                    {
                        expression: '({width:innerWidth,height:innerHeight})',
                        contextId: owner.contextId,
                        returnByValue: true,
                    },
                    owner.sessionId,
                    remaining()
                )
                const { width, height } = viewport.result.value ?? {}
                const q = model.content
                if (
                    viewport.exceptionDetails ||
                    !(width > 0 && height > 0) ||
                    q.length !== 8 ||
                    !q.every(Number.isFinite)
                ) {
                    throw new Error('Frame content quad or viewport is unavailable')
                }
                const [a, b, c, d, e, f] = [
                    (q[2] - q[0]) / width,
                    (q[3] - q[1]) / width,
                    (q[6] - q[0]) / height,
                    (q[7] - q[1]) / height,
                    q[0],
                    q[1],
                ]
                if (
                    Math.abs(a * d - b * c) < 1e-12 ||
                    Math.abs(q[4] - q[2] - q[6] + q[0]) > 0.001 ||
                    Math.abs(q[5] - q[3] - q[7] + q[1]) > 0.001
                ) {
                    throw new Error('Frame content quad is singular or non-affine')
                }
                mapped = { x: a * mapped.x + c * mapped.y + e, y: b * mapped.x + d * mapped.y + f }
                currentSession = owner.parentSessionId
                local = false
            }
            return mapped
        } catch (error) {
            throw new StructuredToolError(
                'FRAME_GEOMETRY_UNAVAILABLE',
                error instanceof Error ? error.message : String(error),
                '重新读取 frame 的文档和布局后再执行输入',
                { actionExecuted: false, actionStatus: 'not_started', retryable: false }
            )
        }
    }

    getCurrentFrameId(): number {
        return this.selectedFrame
    }

    setCurrentFrameId(frameId: number): void {
        if (frameId && this.frameScopes.get(frameId)?.targetId !== this.currentTargetId) {
            throw new DriverCapabilityError('CDP frame scope is no longer available')
        }
        this.selectedFrame = frameId
    }

    async evaluateInFrame(
        frameId: number,
        expression: string,
        timeout?: number,
        _staleContextRetry?: StaleContextRetryPolicy
    ): Promise<{
        result?: { value?: unknown }
        exceptionDetails?: { text: string; exception?: { description?: string } }
    }> {
        const frame = this.frameScopes.get(frameId)
        if (!frame) {
            throw new DriverCapabilityError('CDP frame scope is no longer available')
        }
        return this.cdp!.send(
            'Runtime.evaluate',
            { expression, contextId: frame.contextId, returnByValue: true, awaitPromise: true, timeout },
            frame.sessionId,
            timeout
        )
    }

    async browserEvents(
        action: BrowserEventAction,
        command: EventCommand,
        targetId?: string,
        timeout?: number
    ): Promise<Record<string, unknown>> {
        this.ensureConnected()
        browserEventCommandSchema.parse({ action, command })
        const target = command.ref ? eventRefTarget(command.ref) : undefined
        if (target && (target.backend !== 'cdp' || (targetId && target.targetId !== targetId))) {
            throw new DriverCapabilityError('Browser event ref target mismatch')
        }
        const id = target?.targetId ?? targetId ?? this.currentTargetId
        const sid = id && this.targetSessions.get(id)
        if (!id || !sid) {
            throw new DriverCapabilityError('No observed CDP session for this target')
        }
        const controller = this.ensureEventController(id, sid)
        const scope = this.requestContext?.()
        scope?.signal?.throwIfAborted()
        if (scope?.deadline !== undefined && Date.now() >= scope.deadline) {
            throw new TimeoutError('Browser event deadline exceeded')
        }
        const abort = () => {
            void controller.abortPending('request cancelled')
        }
        scope?.signal?.addEventListener('abort', abort, { once: true })
        try {
            return await controller.command(
                action,
                {
                    ...command,
                    ...(action === 'download' && command.op === 'wait' && timeout
                        ? { timeout: Math.min(Number(command.timeout ?? timeout), timeout) }
                        : {}),
                },
                scope?.signal
            )
        } finally {
            scope?.signal?.removeEventListener('abort', abort)
        }
    }

    async browserFetchCommand(method: string, params?: Record<string, unknown>, targetId?: string): Promise<unknown> {
        const id = targetId ?? this.currentTargetId
        const sid = id && this.targetSessions.get(id)
        if (!id || !sid) {
            throw new DriverCapabilityError('No observed CDP session for this target')
        }
        return this.ensureEventController(id, sid).rawFetch(method, params)
    }

    async suspendBrowserEventsForChallenge(): Promise<Record<string, unknown>> {
        this.ensureSession()
        return this.ensureEventController(this.currentTargetId!, this.sessionId!).suspend('Cloudflare challenge')
    }

    // ==================== IBrowserDriver: CDP 直通 ====================

    /**
     * 发送 CDP 命令（IBrowserDriver 接口）：
     * tabId 在 CDP 模式下忽略（CDP 单 session 概念不区分 tab）；
     * browser-level 域（Target/Browser/SystemInfo/DeviceAccess/IO）走 sendBrowserCommand
     */
    async debuggerSend(
        method: string,
        params?: Record<string, unknown>,
        _tabId?: number,
        timeout?: number
    ): Promise<unknown> {
        if (method.startsWith('Fetch.')) {
            this.ensureSession()
            return this.ensureEventController(this.currentTargetId!, this.sessionId!).rawFetch(method, params)
        }
        const domain = method.split('.')[0]
        const browserLevelDomains = ['Target', 'Browser', 'SystemInfo', 'DeviceAccess', 'IO']
        if (browserLevelDomains.includes(domain)) {
            if (this.pendingPageCondition) {
                throw new DriverCapabilityError('浏览器级 CDP 命令不支持页面条件，未执行动作')
            }
            return this.sendBrowserCommand(method, params)
        }
        if (this.pendingPageCondition) {
            const condition = this.pendingPageCondition
            if (condition.targetId !== this.currentTargetId) {
                throw new PagePreconditionError({ targetId: condition.targetId, actualTargetId: this.currentTargetId })
            }
            await this.assertPageCondition(condition.targetId, condition.expectedUrl, condition.expectedRevision)
            this.pendingPageCondition = null
            if (
                this.currentTargetId &&
                method !== 'Runtime.evaluate' &&
                method !== 'Runtime.callFunctionOn' &&
                !method.startsWith('Input.') &&
                !method.startsWith('Emulation.')
            ) {
                this.revisions.set(this.currentTargetId, (this.revisions.get(this.currentTargetId) ?? 0) + 1)
            }
        }
        return this.send(method, params, timeout)
    }

    /**
     * 获取 Cookies
     */
    async getCookies(filter?: CookieFilter): Promise<Cookie[]> {
        if (
            ![filter?.name, filter?.domain, filter?.url].some((value) => value !== undefined && value.trim().length > 0)
        ) {
            throw new StructuredToolError(
                'INVALID_ARGUMENT',
                'cookies action=get 必须带非空 name、domain 或 url 过滤参数',
                '指定读取范围后再获取 Cookie',
                { actionExecuted: false, actionStatus: 'not_started', retryable: false }
            )
        }
        this.ensureSession()
        const urls = filter?.url ? [filter.url] : undefined
        const contextId = await this.cookieContext(filter)
        const scoped = filter?.targetId !== undefined || filter?.browserContextId !== undefined
        const { cookies } = scoped
            ? await this.sendBrowserCommand<{ cookies: Cookie[] }>(
                  'Storage.getCookies',
                  contextId ? { browserContextId: contextId } : {}
              )
            : await this.send<{ cookies: Cookie[] }>('Network.getCookies', urls ? { urls } : {})
        if (!filter) {
            return cookies
        }
        return cookies.filter((c) => {
            if (filter.url && scoped) {
                const url = new URL(filter.url)
                const domain = c.domain.replace(/^\./, '')
                if (url.hostname !== domain && !(c.domain.startsWith('.') && url.hostname.endsWith('.' + domain))) {
                    return false
                }
                const pathMatches =
                    url.pathname === c.path ||
                    (url.pathname.startsWith(c.path) && (c.path.endsWith('/') || url.pathname[c.path.length] === '/'))
                if (!pathMatches || (c.secure && url.protocol !== 'https:')) {
                    return false
                }
            }
            const partition = (
                c as Cookie & { partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean } }
            ).partitionKey
            if (
                filter.partitionKey &&
                (!partition ||
                    Object.entries(filter.partitionKey).some(
                        ([key, value]) => partition[key as keyof typeof partition] !== value
                    ))
            ) {
                return false
            }
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
        const contextId = await this.cookieContext(params)
        const cookie = {
            name,
            value,
            url,
            ...(domain !== undefined && { domain }),
            ...(path !== undefined && { path }),
            ...(httpOnly !== undefined && { httpOnly }),
            ...(secure !== undefined && { secure }),
            ...(sameSite !== undefined && { sameSite }),
            ...(expirationDate !== undefined && { expires: expirationDate }),
            ...(params.partitionKey ? { partitionKey: params.partitionKey } : {}),
        }
        if (params.targetId !== undefined || params.browserContextId !== undefined) {
            await this.sendBrowserCommand('Storage.setCookies', {
                cookies: [cookie],
                ...(contextId ? { browserContextId: contextId } : {}),
            })
        } else {
            const result = await this.send<{ success: boolean }>('Network.setCookie', cookie)
            if (!result.success) {
                throw new CDPError('Browser rejected the cookie')
            }
        }
    }

    async deleteCookie(
        url: string,
        name: string,
        scope?: CookieScope,
        exact?: { domain: string; path: string; onDeleteAttempt?: () => void; onAcknowledged?: () => void }
    ): Promise<void> {
        this.ensureSession()
        const contextId = await this.cookieContext(scope)
        const target = scope?.targetId ?? this.currentTargetId!
        const { targetInfo } = await this.sendBrowserCommand<{ targetInfo: { browserContextId?: string } }>(
            'Target.getTargetInfo',
            { targetId: target }
        )
        if (scope?.browserContextId !== undefined && contextId !== targetInfo.browserContextId) {
            throw new DriverCapabilityError('Cookie deletion requires a target in the selected browser context')
        }
        const cdp = this.cdp!
        let sid = this.targetSessions.get(target)
        let temporary = false
        if (!sid) {
            sid = (await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: target, flatten: true }))
                .sessionId
            temporary = true
        }
        let failure: unknown
        let failed = false
        try {
            exact?.onDeleteAttempt?.()
            await this.cdp!.send(
                'Network.deleteCookies',
                {
                    name,
                    ...(exact
                        ? { domain: exact.domain, path: exact.path }
                        : { url: url || this.state?.url || 'http://localhost' }),
                    ...(scope?.partitionKey ? { partitionKey: scope.partitionKey } : {}),
                },
                sid
            )
            exact?.onAcknowledged?.()
        } catch (error) {
            failed = true
            failure = error
        }
        if (temporary) {
            try {
                await cdp.send('Target.detachFromTarget', { sessionId: sid }, undefined, 1000, true)
            } catch (error) {
                if (!failed) {
                    throw error
                }
                const original = JSON.parse(formatErrorResponse(failure).content[0]!.text).error
                throw new StructuredToolError(
                    original.code,
                    original.message,
                    original.suggestion ?? '核对 Cookie 状态与目标连接，勿自动重放清除',
                    { ...original.context, cleanupError: JSON.parse(formatErrorResponse(error).content[0]!.text).error }
                )
            }
        }
        if (failed) {
            throw failure
        }
    }

    async clearCookies(filter?: CookieFilter): Promise<{ count: number }> {
        if (!filter || (!filter.url && !filter.domain)) {
            throw new Error('clearCookies requires url or domain')
        }
        this.ensureSession()
        const scope = { ...filter, targetId: filter.targetId ?? this.currentTargetId! }
        const cookies = await this.getCookies(scope)
        if (
            cookies.some((cookie) => 'partitionKeyOpaque' in cookie && !(cookie as Cookie & CookieScope).partitionKey)
        ) {
            throw new DriverCapabilityError('Cookie 分区身份不可序列化，未执行清除')
        }
        const progress = {
            count: 0,
            matched: cookies.length,
            attempted: 0,
            acknowledged: 0,
            alreadyAbsent: 0,
            failed: 0,
            unknown: 0,
            unprocessed: cookies.length,
            countSemantics: 'observed_present_then_absent',
        }
        for (const cookie of cookies) {
            const partitionKey = (cookie as Cookie & CookieScope).partitionKey
            const identityFilter = {
                ...scope,
                name: cookie.name,
                domain: cookie.domain,
                path: cookie.path,
                partitionKey,
            }
            const matches = (candidate: Cookie): boolean => {
                const candidatePartition = (candidate as Cookie & CookieScope).partitionKey
                return (
                    candidate.name === cookie.name &&
                    candidate.domain === cookie.domain &&
                    candidate.path === cookie.path &&
                    Boolean(candidatePartition) === Boolean(partitionKey) &&
                    candidatePartition?.topLevelSite === partitionKey?.topLevelSite &&
                    candidatePartition?.hasCrossSiteAncestor === partitionKey?.hasCrossSiteAncestor
                )
            }
            let phase = 'precheck'
            let deleteAttempted = false
            let acknowledged = false
            let cleanupFailure: { error: unknown } | undefined
            try {
                this.requestContext?.()?.signal?.throwIfAborted()
                if (!(await this.getCookies(identityFilter)).some(matches)) {
                    ++progress.alreadyAbsent
                    --progress.unprocessed
                    continue
                }
                phase = 'delete'
                ++progress.attempted
                --progress.unprocessed
                try {
                    await this.deleteCookie(
                        '',
                        cookie.name,
                        { ...scope, partitionKey },
                        {
                            domain: cookie.domain,
                            path: cookie.path,
                            onDeleteAttempt: () => {
                                deleteAttempted = true
                            },
                            onAcknowledged: () => {
                                acknowledged = true
                                ++progress.acknowledged
                            },
                        }
                    )
                } catch (error) {
                    if (!acknowledged) {
                        throw error
                    }
                    cleanupFailure = { error }
                }
                phase = 'verification'
                if ((await this.getCookies(identityFilter)).some(matches)) {
                    throw new StructuredToolError(
                        'COOKIE_STILL_PRESENT',
                        '浏览器确认请求后仍存在相同身份的 Cookie',
                        '读取该 Cookie 核对实际状态，勿自动重放清除',
                        {}
                    )
                }
                ++progress.count
                if (cleanupFailure) {
                    phase = 'cleanup'
                    throw cleanupFailure.error
                }
            } catch (error) {
                const cause = JSON.parse(formatErrorResponse(error).content[0]!.text).error
                if (phase === 'delete') {
                    if (
                        !deleteAttempted ||
                        cause.context?.actionExecuted === false ||
                        cause.context?.protocolError === true
                    ) {
                        ++progress.failed
                    } else {
                        ++progress.unknown
                    }
                } else if (phase === 'verification') {
                    if (cause.code === 'COOKIE_STILL_PRESENT') {
                        ++progress.failed
                    } else {
                        ++progress.unknown
                    }
                }
                const actionExecuted = progress.acknowledged > 0 ? true : progress.unknown > 0 ? 'unknown' : false
                throw new StructuredToolError(
                    'COOKIE_CLEAR_PARTIAL',
                    'Cookie 清除未全部完成',
                    '按清除进度读取实际 Cookie 状态，勿自动重放整个清除请求',
                    {
                        ...progress,
                        phase,
                        cause,
                        ...(cleanupFailure && phase !== 'cleanup'
                            ? {
                                  cleanupError: JSON.parse(formatErrorResponse(cleanupFailure.error).content[0]!.text)
                                      .error,
                              }
                            : {}),
                        actionExecuted,
                        actionStatus:
                            actionExecuted === false
                                ? 'not_started'
                                : actionExecuted === 'unknown'
                                  ? 'unknown'
                                  : 'partial',
                        retryable: false,
                    }
                )
            }
        }
        return progress
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
        const result = logs
        if (clear) {
            this.consoleLogs = []
        }
        return result
    }

    async getNetworkRequests(options: { urlPattern?: string; clear?: boolean } = {}): Promise<NetworkRequestEntry[]> {
        const { urlPattern, clear } = options
        let requests = this.networkRequests
        if (urlPattern) {
            requests = requests.filter((r) => matchesUrlPattern(String(r.url ?? ''), urlPattern))
        }
        const result = requests
        if (clear) {
            this.networkRequests = []
        }
        return result
    }

    async getChallengeState(): Promise<boolean> {
        return this.challengeRequired
    }

    /**
     * 清除日志
     */
    clearLogs(): void {
        this.consoleLogs = []
        this.networkRequests = []
    }

    /**
     * 执行 JavaScript
     */
    async evaluate<T>(script: string, args?: unknown[], timeout?: number, userAction?: UserActionKind): Promise<T> {
        this.ensureSession()

        // CDP 命令超时需大于脚本执行超时，给 WebSocket 通信留余量
        const CDP_MARGIN = 5000
        const sendTimeout = timeout !== undefined ? timeout + CDP_MARGIN : undefined

        // 有参数时使用 callFunctionOn：避免大 payload 字符串拼接，参数通过协议结构化传递
        if (args !== undefined) {
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
                    sendTimeout,
                    userAction
                )) as {
                    result: CdpResultObject<T>
                    exceptionDetails?: { text: string; exception?: { description?: string } }
                }
                if (exceptionDetails) {
                    throw setErrorSource(new Error(formatCdpException(exceptionDetails)), 'page')
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
        const { result, exceptionDetails } = (await this.send(
            'Runtime.evaluate',
            evalParams,
            sendTimeout,
            userAction
        )) as {
            result: CdpResultObject<T>
            exceptionDetails?: { text: string; exception?: { description?: string } }
        }

        if (exceptionDetails) {
            throw setErrorSource(new Error(formatCdpException(exceptionDetails)), 'page')
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
        if (type !== 'cache') {
            this.ensureEventController(this.currentTargetId!, this.sessionId!).assertNativeReady()
        }

        if (type === 'all' || type === 'cache') {
            await this.send('Network.clearBrowserCache')
        }
        if (type === 'all' || type === 'storage') {
            const result = await this.send<{
                exceptionDetails?: { text: string; exception?: { description?: string } }
            }>('Runtime.evaluate', {
                expression: `localStorage.clear(); sessionStorage.clear();`,
            })
            if (result.exceptionDetails) {
                throw new CDPError(`Storage cleanup failed: ${formatCdpException(result.exceptionDetails)}`, {
                    cacheCleared: type === 'all',
                    storageStatus: 'failed_or_partial',
                    actionExecuted: type === 'all' ? true : 'unknown',
                    actionStatus: type === 'all' ? 'partial' : 'unknown',
                    retryable: false,
                })
            }
        }
    }

    /**
     * 新建页面（外部入口，加锁）
     *
     * IBrowserDriver 接口：可选 url 参数，url 提供时新建后立即导航
     */
    async newPage(url?: string, timeout?: number, options: NewPageOptions = {}): Promise<NewTabResult> {
        if (
            Object.entries(options).some(([key, value]) => value !== undefined && key !== 'taskHint' && key !== 'note')
        ) {
            throw new DriverCapabilityError(
                'CDP 模式不支持 Chrome UI 的 newPage 配置参数，未创建页面；请使用 Extension 模式'
            )
        }
        const target = await this.withLock(async () => this.newPageInternal())
        if (url) {
            try {
                await this.navigate(url, { timeout })
            } catch (error) {
                throw creationError(error, {
                    action: 'newPage',
                    createdTargetId: target.targetId,
                    targetId: target.targetId,
                    managed: false,
                    actionExecuted: true,
                    actionStatus: 'partial',
                    failureStage: 'navigation',
                })
            }
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
    async closePage(targetId: string): Promise<void> {
        if (!targetId) {
            throw new TargetNotFoundError('targetId is required')
        }
        return this.withLock(async () => {
            this.ensureConnected()
            const targets = await this.listTargets()
            if (!targets.some((target) => target.targetId === targetId)) {
                throw new TargetNotFoundError(targetId)
            }
            const id = targetId
            if (this.pendingPageCondition) {
                const condition = this.pendingPageCondition
                await this.assertPageCondition(id, condition.expectedUrl, condition.expectedRevision)
                this.pendingPageCondition = null
            }
            const sid = this.targetSessions.get(id)
            if (sid) {
                await this.eventControllers.get(sid)?.dispose('page closed')
            }
            const result = (await this.cdp!.send('Target.closeTarget', { targetId: id })) as { success: boolean }
            if (!result.success) {
                throw new TargetNotFoundError(targetId)
            }
            this.revisions.delete(id)
            if (sid) {
                this.eventControllers.delete(sid)
                this.targetSessions.delete(id)
            }

            // 如果关闭的是当前页面，清除会话状态
            if (id === this.currentTargetId) {
                this.clearAttachedTargetState()
            }
            this.targetLogs.delete(id)
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
        await Promise.all(
            [...this.eventControllers.values()].map((controller) => controller.suspend('connection closing'))
        )
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

    async getLiveState(timeout?: number): Promise<SessionState | null> {
        if (!this.currentTargetId) {
            return this.state
        }
        this.ensureConnected()
        const { targetInfo } = await this.sendBrowserCommand<{
            targetInfo: { url?: string; title?: string; targetId: string }
        }>('Target.getTargetInfo', { targetId: this.currentTargetId }, timeout)
        this.state = {
            url: targetInfo.url ?? '',
            title: targetInfo.title ?? '',
            targetId: this.currentTargetId,
        }
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
    async send<T>(method: string, params?: object, timeout?: number, dispatchedAction?: UserActionKind): Promise<T> {
        const deadline = timeout === undefined ? undefined : Date.now() + timeout
        this.ensureSession()
        const mutation =
            method === 'Page.navigate' ||
            method === 'Page.navigateToHistoryEntry' ||
            method === 'Page.reload' ||
            method === 'Runtime.evaluate' ||
            method === 'Runtime.callFunctionOn' ||
            method.startsWith('Input.') ||
            method.startsWith('Emulation.')
        const condition = mutation ? this.pendingPageCondition : null
        if (condition) {
            if (condition.targetId !== this.currentTargetId) {
                throw new PagePreconditionError({
                    targetId: condition.targetId,
                    actualTargetId: this.currentTargetId,
                })
            }
            await this.assertPageCondition(
                condition.targetId,
                condition.expectedUrl,
                condition.expectedRevision,
                timeout
            )
            this.pendingPageCondition = null
        }
        const remaining = deadline === undefined ? undefined : remainingNavigationTimeout(deadline)
        const cleanupType = (params as { type?: string } | undefined)?.type
        const blocking =
            /^(?:Runtime\.(?:evaluate|callFunctionOn)|Input\.)/.test(method) &&
            !['mouseReleased', 'keyUp', 'touchEnd', 'touchCancel'].includes(cleanupType ?? '')
        if (blocking) {
            this.ensureEventController(this.currentTargetId!, this.sessionId!).assertNativeReady()
        }
        if (mutation && this.currentTargetId) {
            this.revisions.set(this.currentTargetId, (this.revisions.get(this.currentTargetId) ?? 0) + 1)
        }
        const frame = this.frameScopes.get(this.selectedFrame)
        const scoped = frame && (/^(?:Runtime|DOM|Accessibility)\./.test(method) || method === 'Input.dispatchKeyEvent')
        const sessionId = scoped ? frame.sessionId : this.sessionId!
        const nativeParams =
            scoped && method === 'Runtime.evaluate' ? { ...params, contextId: frame.contextId } : params
        const operation = this.cdp!.send<T>(method, nativeParams, sessionId, remaining, false, dispatchedAction)
        return blocking
            ? this.ensureEventController(this.currentTargetId!, this.sessionId!)
                  .race(operation)
                  .catch((error) => {
                      if ((error as { code?: string }).code === 'DIALOG_OPEN') {
                          throw new StructuredToolError(
                              'DIALOG_OPEN',
                              (error as Error).message,
                              'Read logs type=dialog and handle the observed ref; do not replay the original action',
                              (error as { context: Record<string, unknown> }).context
                          )
                      }
                      throw error
                  })
            : operation
    }

    /**
     * 发送 browser-level CDP 命令（不携带 sessionId）
     * 用于 Target.*、Browser.* 等浏览器级命令
     */
    sendBrowserCommand<T>(method: string, params?: object, timeout?: number): Promise<T> {
        this.ensureConnected()
        return this.cdp!.send(method, params, undefined, timeout)
    }

    /**
     * 派发 CDP Input.dispatchTouchEvent，临时启用 touch 模拟避免命令挂起
     */
    private async getFrameOwnerZoom(
        owner: { backendNodeId: number; parentSessionId: string },
        timeout: number
    ): Promise<number> {
        const deadline = Date.now() + timeout
        let objectId: string | undefined
        try {
            const { object } = await this.cdp!.send<{ object: { objectId?: string } }>(
                'DOM.resolveNode',
                { backendNodeId: owner.backendNodeId },
                owner.parentSessionId,
                remainingNavigationTimeout(deadline)
            )
            objectId = object.objectId
            if (!objectId) {
                throw new Error('Frame owner object is unavailable')
            }
            const { result, exceptionDetails } = await this.cdp!.send<{
                result: { value?: number }
                exceptionDetails?: unknown
            }>(
                'Runtime.callFunctionOn',
                { objectId, functionDeclaration: 'function(){return this.currentCSSZoom ?? 1}', returnByValue: true },
                owner.parentSessionId,
                remainingNavigationTimeout(deadline)
            )
            if (
                exceptionDetails ||
                typeof result.value !== 'number' ||
                !Number.isFinite(result.value) ||
                result.value <= 0
            ) {
                throw new Error('Frame owner CSS zoom is unavailable')
            }
            return result.value
        } catch (error) {
            throw new StructuredToolError(
                'FRAME_GEOMETRY_UNAVAILABLE',
                error instanceof Error ? error.message : String(error),
                '重新读取 frame 的文档和布局后再执行输入',
                { actionExecuted: false, actionStatus: 'not_started', retryable: false }
            )
        } finally {
            if (objectId) {
                await this.cdp!.send('Runtime.releaseObject', { objectId }, owner.parentSessionId, 1000).catch(
                    (error: unknown) => console.warn('[MCP] Frame zoom object cleanup failed:', error)
                )
            }
        }
    }

    private ensureEventController(targetId: string, sessionId: string): BrowserEventController {
        let controller = this.eventControllers.get(sessionId)
        if (!controller) {
            controller = new BrowserEventController(
                {
                    backend: 'cdp',
                    targetId,
                    owner: this.revisionEpoch,
                    nativeSessionId: sessionId,
                    generation: randomUUID(),
                },
                (method, params, childSessionId) => this.cdp!.send(method, params, childSessionId ?? sessionId)
            )
            this.eventControllers.set(sessionId, controller)
        }
        return controller
    }

    private async cookieContext(scope?: CookieScope): Promise<string | undefined> {
        if (scope?.storeId !== undefined) {
            throw new DriverCapabilityError('CookieStore IDs belong to Extension; CDP uses browserContextId')
        }
        if (scope?.partitionKey && !scope.partitionKey.topLevelSite) {
            throw new DriverCapabilityError('CDP partitionKey requires topLevelSite')
        }
        if (!scope?.targetId) {
            return scope?.browserContextId
        }
        const { targetInfo } = await this.sendBrowserCommand<{ targetInfo: { browserContextId?: string } }>(
            'Target.getTargetInfo',
            { targetId: scope.targetId }
        )
        if (scope.browserContextId !== undefined && scope.browserContextId !== targetInfo.browserContextId) {
            throw new DriverCapabilityError('Cookie target browser context does not match browserContextId')
        }
        return targetInfo.browserContextId
    }

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

    private navigationTimeout(wait: string, timeout: number, deadline: number): NavigationTimeoutError {
        const error = new NavigationTimeoutError(wait, timeout)
        const scope = this.requestContext?.()
        if (scope?.deadline !== undefined && deadline >= scope.deadline) {
            scope.budgetError ??= setErrorSource(error, 'budget')
        }
        return error
    }

    /** 在触发导航前注册相应等待器，并按主 frame loader 过滤生命周期事件 */
    private startNavigationWait(
        wait: WaitUntil,
        timeout: number,
        signal: AbortSignal | undefined,
        bindFromFrameNavigation: boolean
    ): {
        promise: Promise<void>
        markActionStarted: () => void
        setExpectedLoader: (frameId: string, loaderId: string) => void
        setExpectedSameDocument: (frameId: string) => void
    } {
        this.ensureSession()
        const cdp = this.cdp!
        const sessionId = this.sessionId!
        const deadline = Date.now() + timeout
        const baselineLoaderId = this.mainFrameLoaderId
        const lifecycleName =
            wait === 'domcontentloaded' ? 'DOMContentLoaded' : wait === 'load' ? 'load' : 'networkIdle'
        const seenLifecycle = new Set<string>()
        const seenSameDocumentFrames = new Set<string>()
        const sameDocumentPendingRequests = new Set<string>()
        let actionStarted = false
        let expectedFrameId: string | null = null
        let expectedLoaderId: string | null = null
        let expectedSameDocumentFrameId: string | null = null
        let sameDocumentIdleTimer: NodeJS.Timeout | null = null
        let settled = false
        let finish: () => void = () => {}
        let fail: (error: Error) => void = () => {}

        const lifecycleKey = (frameId: string, loaderId: string, name: string) =>
            JSON.stringify([frameId, loaderId, name])
        const completeIfSeen = () => {
            if (
                expectedFrameId !== null &&
                expectedLoaderId !== null &&
                seenLifecycle.has(lifecycleKey(expectedFrameId, expectedLoaderId, lifecycleName))
            ) {
                finish()
            }
        }
        const checkSameDocumentIdle = () => {
            if (
                settled ||
                expectedSameDocumentFrameId === null ||
                !seenSameDocumentFrames.has(expectedSameDocumentFrameId)
            ) {
                return
            }
            if (sameDocumentPendingRequests.size > 0) {
                if (sameDocumentIdleTimer !== null) {
                    clearTimeout(sameDocumentIdleTimer)
                    sameDocumentIdleTimer = null
                }
                return
            }
            if (sameDocumentIdleTimer === null) {
                sameDocumentIdleTimer = setTimeout(() => finish(), 500)
            }
        }
        const completeSameDocumentIfSeen = () => {
            if (expectedSameDocumentFrameId === null || !seenSameDocumentFrames.has(expectedSameDocumentFrameId)) {
                return
            }
            if (wait === 'networkidle') {
                checkSameDocumentIdle()
            } else {
                finish()
            }
        }
        const setExpectedLoader = (frameId: string, loaderId: string) => {
            if (settled || !loaderId) {
                return
            }
            expectedSameDocumentFrameId = null
            if (sameDocumentIdleTimer !== null) {
                clearTimeout(sameDocumentIdleTimer)
                sameDocumentIdleTimer = null
            }
            expectedFrameId = frameId
            expectedLoaderId = loaderId
            completeIfSeen()
        }
        const setExpectedSameDocument = (frameId: string) => {
            if (settled) {
                return
            }
            expectedSameDocumentFrameId = frameId
            completeSameDocumentIfSeen()
        }

        const promise = new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timeoutId)
                if (sameDocumentIdleTimer !== null) {
                    clearTimeout(sameDocumentIdleTimer)
                    sameDocumentIdleTimer = null
                }
                signal?.removeEventListener('abort', onAbort)
                cdp.offEvent('Page.frameNavigated', onFrameNavigated)
                cdp.offEvent('Page.lifecycleEvent', onLifecycleEvent)
                cdp.offEvent('Page.navigatedWithinDocument', onNavigatedWithinDocument)
                cdp.offEvent('Network.requestWillBeSent', onRequestStarted)
                cdp.offEvent('Network.loadingFinished', onRequestFinished)
                cdp.offEvent('Network.loadingFailed', onRequestFinished)
                cdp.removeListener('disconnected', onDisconnected)
            }
            finish = () => {
                if (settled) {
                    return
                }
                settled = true
                cleanup()
                resolve()
            }
            fail = (error: Error) => {
                if (settled) {
                    return
                }
                settled = true
                cleanup()
                reject(error)
            }
            const onFrameNavigated = (params: unknown, eventSessionId?: string) => {
                if (!actionStarted || !bindFromFrameNavigation || eventSessionId !== sessionId) {
                    return
                }
                const frame = (params as { frame?: { id?: string; parentId?: string; loaderId?: string } }).frame
                if (frame?.id && !frame.parentId && frame.loaderId && frame.loaderId !== baselineLoaderId) {
                    setExpectedLoader(frame.id, frame.loaderId)
                }
            }
            const onLifecycleEvent = (params: unknown, eventSessionId?: string) => {
                if (!actionStarted || eventSessionId !== sessionId) {
                    return
                }
                const event = params as { frameId?: string; loaderId?: string; name?: string }
                if (!event.frameId || !event.loaderId || !event.name) {
                    return
                }
                seenLifecycle.add(lifecycleKey(event.frameId, event.loaderId, event.name))
                completeIfSeen()
            }
            const onNavigatedWithinDocument = (params: unknown, eventSessionId?: string) => {
                if (!actionStarted || eventSessionId !== sessionId) {
                    return
                }
                const frameId = (params as { frameId?: string }).frameId
                if (frameId && frameId === this.mainFrameId) {
                    seenSameDocumentFrames.add(frameId)
                    completeSameDocumentIfSeen()
                }
            }
            const onRequestStarted = (params: unknown, eventSessionId?: string) => {
                if (!actionStarted || eventSessionId !== sessionId) {
                    return
                }
                const { requestId, loaderId } = params as { requestId?: string; loaderId?: string }
                if (requestId && loaderId !== '') {
                    sameDocumentPendingRequests.add(requestId)
                    checkSameDocumentIdle()
                }
            }
            const onRequestFinished = (params: unknown, eventSessionId?: string) => {
                if (!actionStarted || eventSessionId !== sessionId) {
                    return
                }
                const requestId = (params as { requestId?: string }).requestId
                if (requestId) {
                    sameDocumentPendingRequests.delete(requestId)
                    checkSameDocumentIdle()
                }
            }
            const onAbort = () => {
                fail(signal?.reason instanceof Error ? signal.reason : new Error('导航等待已取消'))
            }
            const onDisconnected = () => fail(new Error('CDP 连接已关闭'))
            const timeoutId = setTimeout(() => {
                if (!settled) {
                    fail(this.navigationTimeout(wait, timeout, deadline))
                }
            }, timeout)

            cdp.onEvent('Page.frameNavigated', onFrameNavigated)
            cdp.onEvent('Page.lifecycleEvent', onLifecycleEvent)
            cdp.onEvent('Page.navigatedWithinDocument', onNavigatedWithinDocument)
            if (wait === 'networkidle') {
                cdp.onEvent('Network.requestWillBeSent', onRequestStarted)
                cdp.onEvent('Network.loadingFinished', onRequestFinished)
                cdp.onEvent('Network.loadingFailed', onRequestFinished)
            }
            cdp.once('disconnected', onDisconnected)
            signal?.addEventListener('abort', onAbort, { once: true })
            if (signal?.aborted) {
                onAbort()
            }
        })

        return {
            promise,
            markActionStarted: () => {
                actionStarted = true
            },
            setExpectedLoader,
            setExpectedSameDocument,
        }
    }

    /**
     * 核心网络空闲等待逻辑
     *
     * 捕获 cdp 引用防止 close() 并发置 null，用局部 Set 追踪请求避免污染成员变量
     * close() 时通过 'disconnected' 信号立即 reject
     */
    private buildNetworkIdlePromise(
        cdp: CDPClient,
        timeout: number,
        idleTime: number,
        signal?: AbortSignal
    ): Promise<void> {
        // CDP 用空 loaderId 标识 Worker 请求，页面 session 可能只收到其开始事件
        const localPendingRequests = new Set(
            [...this.requestMap].filter(([, request]) => request.loaderId !== '').map(([requestId]) => requestId)
        )
        const sessionId = this.sessionId!
        const deadline = Date.now() + timeout

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

            const onRequestStart = (params: unknown, eventSessionId?: string) => {
                if (eventSessionId !== sessionId) {
                    return
                }
                const { requestId, loaderId } = params as { requestId: string; loaderId?: string }
                if (loaderId === '') {
                    return
                }
                localPendingRequests.add(requestId)
                checkIdle()
            }

            const onRequestEnd = (params: unknown, eventSessionId?: string) => {
                if (eventSessionId !== sessionId) {
                    return
                }
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
                signal?.removeEventListener('abort', onAbort)
                cdp.offEvent('Network.requestWillBeSent', onRequestStart)
                cdp.offEvent('Network.loadingFinished', onRequestEnd)
                cdp.offEvent('Network.loadingFailed', onRequestEnd)
                cdp.removeListener('disconnected', onDisconnected)
            }

            const onAbort = () => {
                cleanup()
                reject(signal?.reason instanceof Error ? signal.reason : new Error('网络空闲等待已取消'))
            }

            timeoutTimer = setTimeout(() => {
                cleanup()
                reject(this.navigationTimeout('networkidle', timeout, deadline))
            }, timeout)

            const onDisconnected = () => {
                cleanup()
                reject(new Error('CDP 连接已关闭'))
            }
            cdp.once('disconnected', onDisconnected)

            cdp.onEvent('Network.requestWillBeSent', onRequestStart)
            cdp.onEvent('Network.loadingFinished', onRequestEnd)
            cdp.onEvent('Network.loadingFailed', onRequestEnd)
            signal?.addEventListener('abort', onAbort, { once: true })
            if (signal?.aborted) {
                onAbort()
                return
            }

            checkIdle()
        })
    }

    /**
     * 附加到指定页面（内部版本，不加锁，供 launch/connect 等已持锁方法调用）
     */
    private async attachToTargetInternal(targetId: string, deadline?: number): Promise<void> {
        this.ensureConnected()

        // 如果已经附加到同一个 target，跳过
        if (this.currentTargetId === targetId && this.sessionId) {
            return
        }

        if (!this.targetSessions.has(targetId) && this.targetSessions.size >= 32) {
            throw new DriverCapabilityError(
                'CDP observed page capacity reached (32); close unused pages before attaching'
            )
        }
        this.clearAttachedTargetState()
        let sessionId = this.targetSessions.get(targetId)
        if (!sessionId) {
            const attached = await this.sendBrowserCommand<{ sessionId: string }>(
                'Target.attachToTarget',
                { targetId, flatten: true },
                deadline === undefined ? undefined : remainingNavigationTimeout(deadline)
            )
            sessionId = attached.sessionId
            this.targetSessions.set(targetId, sessionId)
        }
        this.sessionId = sessionId
        this.currentTargetId = targetId
        const logs = this.targetLogs.get(targetId)
        this.consoleLogs = logs?.console ?? []
        this.networkRequests = logs?.network ?? []

        // 初始化会话
        await this.initSession(deadline)
    }

    /**
     * 新建页面（内部版本，不加锁，供 launch 等已持锁方法调用）
     */
    private async newPageInternal(): Promise<TargetInfo> {
        this.ensureConnected()

        const { targetId } = (await this.cdp!.send('Target.createTarget', {
            url: 'about:blank',
        }).catch((error: unknown) => {
            throw creationError(error, {
                action: 'newPage',
                createdTargetId: null,
                managed: null,
                actionExecuted: 'unknown',
                actionStatus: 'unknown',
                failureStage: 'create',
            })
        })) as { targetId: string }

        try {
            await this.attachToTargetInternal(targetId)
        } catch (error) {
            throw creationError(error, {
                action: 'newPage',
                createdTargetId: targetId,
                targetId,
                managed: false,
                actionExecuted: true,
                actionStatus: 'partial',
                failureStage: 'attach',
            })
        }

        return {
            targetId,
            type: 'page',
            url: 'about:blank',
            title: '',
        }
    }

    private clearAttachedTargetState(): void {
        if (this.currentTargetId) {
            this.targetLogs.set(this.currentTargetId, { console: this.consoleLogs, network: this.networkRequests })
        }
        this.consoleLogs = []
        this.networkRequests = []
        this.requestMap.clear()
        this.challengeRequired = false
        this.runtimeEnabled = false
        this.mainFrameId = null
        this.mainFrameLoaderId = null
        this.modifiers = 0
        this.sessionId = null
        this.selectedFrame = 0
        this.currentTargetId = null
        this.state = null
    }

    private isCurrentSessionEvent(eventSessionId: string | undefined): boolean {
        return this.sessionId !== null && eventSessionId === this.sessionId
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

        this.clearAttachedTargetState()
        for (const controller of this.eventControllers.values()) {
            void controller.dispose('connection closed').catch(() => {})
        }
        this.eventControllers.clear()
        this.targetSessions.clear()
        this.childSessions.clear()
        this.frameSessions.clear()
        this.contexts.clear()
        this.frameScopes.clear()
        this.selectedFrame = 0
        this.targetLogs.clear()
        this.revisionEpoch = randomUUID()
        this.revisions.clear()
        this.pendingPageCondition = null
        this.behaviorSimulator.setCurrentPosition({ x: 0, y: 0 })
        this.listenersInstalled = false
        this.connectedPort = 0
    }

    /**
     * 串行执行操作（防止并发竞态）
     */
    private async withLock<T>(fn: () => Promise<T>, deadline?: number): Promise<T> {
        const signal = this.requestContext?.()?.signal
        signal?.throwIfAborted()
        const previousLock = this.operationLock
        let releaseLock: () => void
        this.operationLock = new Promise<void>((resolve) => {
            releaseLock = resolve
        })
        let acquired = false
        try {
            await waitForNavigationQueue(previousLock, deadline, signal)
            acquired = true
            signal?.throwIfAborted()
            return await fn()
        } catch (error) {
            if (deadline !== undefined) {
                const context = { actionExecuted: 'unknown', actionStatus: 'unknown', retryable: false }
                if (error instanceof CDPError && error.message.startsWith('CDP 命令超时: ')) {
                    throw new StructuredToolError('TIMEOUT', error.message, '请回读实际页面，勿自动重放导航', context)
                }
                if (error instanceof TimeoutError || error instanceof NavigationTimeoutError) {
                    Object.assign(error.context, context)
                }
            }
            throw error
        } finally {
            if (acquired) {
                releaseLock!()
            } else {
                void previousLock.then(releaseLock!, releaseLock!)
            }
        }
    }

    /**
     * 等待多个事件中的任一个触发
     *
     * 监听当前 session 的加载完成、主 frame BFCache 恢复和同文档导航，
     * 接受完成事件后清理所有监听器和超时定时器
     * close() 时通过 'disconnected' 信号立即 reject，不必等 timer 超时
     */
    private waitForAnyEvent(
        events: string[],
        timeout: number,
        signal = this.requestContext?.()?.signal
    ): Promise<void> {
        const deadline = Date.now() + timeout
        signal?.throwIfAborted()
        // 捕获当前 cdp 引用，防止 close() 并发置 null 导致回调崩溃
        const cdp = this.cdp
        const sessionId = this.sessionId
        if (!cdp || !sessionId) {
            return Promise.reject(new Error('CDP 连接已关闭'))
        }

        return new Promise((resolve, reject) => {
            const listeners: Array<{
                event: string
                listener: (params: unknown, eventSessionId?: string) => void
            }> = []

            const cleanup = () => {
                clearTimeout(timer)
                signal?.removeEventListener('abort', onAbort)
                for (const { event, listener } of listeners) {
                    cdp.offEvent(event, listener)
                }
                cdp.removeListener('disconnected', onDisconnected)
            }

            const onAbort = () => {
                cleanup()
                reject(signal?.reason ?? new Error('Request cancelled'))
            }
            const timer = setTimeout(() => {
                cleanup()
                reject(this.navigationTimeout('navigation', timeout, deadline))
            }, timeout)

            const onDisconnected = () => {
                cleanup()
                reject(new Error('CDP 连接已关闭'))
            }
            cdp.once('disconnected', onDisconnected)
            signal?.addEventListener('abort', onAbort, { once: true })
            if (signal?.aborted) {
                onAbort()
                return
            }

            for (const event of events) {
                const listener = (params: unknown, eventSessionId?: string) => {
                    if (eventSessionId !== sessionId) {
                        return
                    }
                    if (event === 'Page.frameNavigated') {
                        const navigation = params as {
                            type?: string
                            frame?: { id?: string; parentId?: string }
                        }
                        if (
                            navigation.type !== 'BackForwardCacheRestore' ||
                            navigation.frame?.id !== this.mainFrameId ||
                            navigation.frame.parentId
                        ) {
                            return
                        }
                    }
                    if (
                        event === 'Page.navigatedWithinDocument' &&
                        (params as { frameId?: string }).frameId !== this.mainFrameId
                    ) {
                        return
                    }
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
    private async initSession(deadline?: number): Promise<void> {
        const remaining = () => (deadline === undefined ? undefined : remainingNavigationTimeout(deadline))
        this.setupEventListeners()
        this.ensureEventController(this.currentTargetId!, this.sessionId!)
        // 启用必要的域
        await Promise.all([
            this.send('Page.enable', undefined, remaining()),
            this.send('DOM.enable', undefined, remaining()),
            this.send('Network.enable', undefined, remaining()),
            this.send('Log.enable', undefined, remaining()),
        ])
        await this.send('Page.setLifecycleEventsEnabled', { enabled: true }, remaining())
        const { frameTree } = await this.send<{ frameTree: { frame: { id: string; loaderId?: string } } }>(
            'Page.getFrameTree',
            undefined,
            remaining()
        )
        this.mainFrameId = frameTree.frame.id
        this.mainFrameLoaderId = frameTree.frame.loaderId ?? null

        // 根据 stealth 模式注入反检测脚本。不在当前文档 Runtime.evaluate，避免干扰 Cloudflare JS Challenge
        if (this.stealthMode !== 'off') {
            const script = getAntiDetectionScript(this.stealthMode)
            await this.send(
                'Page.addScriptToEvaluateOnNewDocument',
                {
                    source: script,
                },
                remaining()
            )
        }

        // 监听事件
        this.setupEventListeners()

        // 更新状态
        await this.updateState(remaining())
    }

    /**
     * 设置事件监听（幂等，只安装一次）
     */
    private setupEventListeners(): void {
        if (this.listenersInstalled) {
            return
        }
        this.listenersInstalled = true
        for (const method of BROWSER_EVENT_METHODS) {
            this.cdp!.onEvent(method, (params, sid) => {
                const root = sid && (this.childSessions.get(sid) ?? sid)
                if (root) {
                    this.eventControllers.get(root)?.handle(method, params, sid)
                }
            })
        }
        this.cdp!.onEvent('Runtime.executionContextCreated', (raw, sid) => {
            const c = (raw as { context: { id: number; auxData?: { frameId?: string; isDefault?: boolean } } }).context
            if (sid && c.auxData?.frameId) {
                const contexts = this.contexts.get(sid) ?? []
                contexts.push({ id: c.id, frameId: c.auxData.frameId, isDefault: c.auxData.isDefault === true })
                this.contexts.set(sid, contexts)
            }
        })
        this.cdp!.onEvent('Runtime.executionContextDestroyed', (raw, sid) => {
            if (sid) {
                this.contexts.set(
                    sid,
                    (this.contexts.get(sid) ?? []).filter(
                        (c) => c.id !== (raw as { executionContextId: number }).executionContextId
                    )
                )
            }
        })
        this.cdp!.onEvent('Runtime.executionContextsCleared', (_, sid) => {
            if (sid) {
                this.contexts.delete(sid)
            }
        })
        this.cdp!.onEvent('Target.attachedToTarget', (raw, parent) => {
            const p = raw as { sessionId: string; targetInfo: { type: string; targetId: string } }
            if (!parent || p.targetInfo.type !== 'iframe') {
                return
            }
            const root = this.childSessions.get(parent) ?? parent
            this.childSessions.set(p.sessionId, root)
            this.frameSessions.set(p.targetInfo.targetId, p.sessionId)
            void (async () => {
                await this.cdp!.send('Runtime.enable', {}, p.sessionId)
                await this.cdp!.send(
                    'Target.setAutoAttach',
                    {
                        autoAttach: true,
                        waitForDebuggerOnStart: false,
                        flatten: true,
                        filter: [{ type: 'iframe', exclude: false }],
                    },
                    p.sessionId
                )
            })().catch((error) => console.warn('[MCP] OOPIF context setup failed:', error))
        })
        this.cdp!.onEvent('Target.detachedFromTarget', (raw) => {
            const sid = (raw as { sessionId: string }).sessionId
            for (const [targetId, session] of this.targetSessions) {
                if (session !== sid) {
                    continue
                }
                const controller = this.eventControllers.get(sid)
                this.targetSessions.delete(targetId)
                this.eventControllers.delete(sid)
                if (this.currentTargetId === targetId) {
                    this.clearAttachedTargetState()
                }
                if (controller) {
                    void controller
                        .dispose('native target detached')
                        .catch((error) => console.warn('[MCP] Native target event cleanup outcome:', error))
                }
            }
            this.contexts.delete(sid)
            this.childSessions.delete(sid)
            for (const [id, session] of this.frameSessions) {
                if (session === sid) {
                    this.frameSessions.delete(id)
                }
            }
        })

        this.cdp!.onEvent('Page.frameNavigated', (params: unknown, eventSessionId?: string) => {
            const targetId = [...this.targetSessions].find(([, sid]) => sid === eventSessionId)?.[0]
            if (!targetId) {
                return
            }
            const frame = (params as { frame?: { id?: string; parentId?: string; loaderId?: string } }).frame
            if (frame?.id && !frame.parentId) {
                if (targetId === this.currentTargetId) {
                    this.mainFrameId = frame.id
                    this.mainFrameLoaderId = frame.loaderId ?? null
                }
                this.revisions.set(targetId, (this.revisions.get(targetId) ?? 0) + 1)
            }
        })
        this.cdp!.onEvent('Page.navigatedWithinDocument', (_params: unknown, eventSessionId?: string) => {
            const targetId = [...this.targetSessions].find(([, sid]) => sid === eventSessionId)?.[0]
            if (targetId) {
                this.revisions.set(targetId, (this.revisions.get(targetId) ?? 0) + 1)
            }
        })

        // 控制台日志
        this.cdp!.onEvent('Runtime.consoleAPICalled', (params: unknown, eventSessionId?: string) => {
            if (!this.isCurrentSessionEvent(eventSessionId)) {
                return
            }
            const p = params as {
                type: string
                args: Array<{ value?: unknown; description?: string }>
                timestamp: number
                stackTrace?: { callFrames: Array<{ url: string; lineNumber: number }> }
            }
            this.consoleLogs.push({
                sequence: ++this.nextConsoleLogSequence,
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

        this.cdp!.onEvent('Runtime.exceptionThrown', (params: unknown, eventSessionId?: string) => {
            if (!this.isCurrentSessionEvent(eventSessionId)) {
                return
            }
            const p = params as {
                timestamp: number
                exceptionDetails: {
                    text: string
                    exception?: { description?: string }
                    url?: string
                    lineNumber?: number
                }
            }
            this.consoleLogs.push({
                sequence: ++this.nextConsoleLogSequence,
                source: 'javascript',
                level: 'error',
                text: formatCdpException(p.exceptionDetails),
                timestamp: Math.round(p.timestamp),
                url: p.exceptionDetails.url,
                lineNumber: p.exceptionDetails.lineNumber,
            })
            if (this.consoleLogs.length > SessionManager.MAX_LOG_ENTRIES) {
                this.consoleLogs.splice(0, this.consoleLogs.length - 800)
            }
        })

        // 网络请求
        this.cdp!.onEvent('Network.requestWillBeSent', (params: unknown, eventSessionId?: string) => {
            if (!this.isCurrentSessionEvent(eventSessionId)) {
                return
            }
            const p = params as {
                requestId: string
                request: { url: string; method: string }
                type: string
                timestamp: number
                wallTime: number
                frameId?: string
                loaderId?: string
            }
            this.requestMap.set(p.requestId, {
                url: p.request.url,
                method: p.request.method,
                type: p.type,
                timestamp: Math.round(p.wallTime * 1000), // wallTime 是 epoch 秒 → epoch 毫秒
                frameId: p.frameId,
                loaderId: p.loaderId,
                _monotonic: p.timestamp, // MonotonicTime 用于 duration 计算
            })
        })

        this.cdp!.onEvent('Network.responseReceived', (params: unknown, eventSessionId?: string) => {
            if (!this.isCurrentSessionEvent(eventSessionId)) {
                return
            }
            const p = params as {
                requestId: string
                response: { status: number; headers?: Record<string, unknown> }
                timestamp: number
            }
            const request = this.requestMap.get(p.requestId)
            if (request) {
                const challenge = isCloudflareChallenge(p.response.headers)
                if (request.type.toLowerCase() === 'document' && request.frameId === this.mainFrameId) {
                    // 仅新的主文档响应可以解除已知 Challenge，清空日志不能解除该状态
                    this.challengeRequired = challenge
                }
                request.status = p.response.status
                request.challenge = challenge
            }
        })

        // 网络请求失败时写入日志再清理 requestMap，防止 diagnostics 丢失失败请求
        const finalizeRequest = (params: unknown, eventSessionId?: string) => {
            if (!this.isCurrentSessionEvent(eventSessionId)) {
                return
            }
            const p = params as { requestId: string; timestamp: number; errorText?: string; type?: string }
            const request = this.requestMap.get(p.requestId)
            if (request) {
                const { _monotonic, ...requestData } = request
                delete requestData.frameId
                delete requestData.loaderId
                this.networkRequests.push({
                    sequence: ++this.nextNetworkRequestSequence,
                    ...requestData,
                    type: p.type ?? requestData.type,
                    errorText: p.errorText,
                    duration: Math.round((p.timestamp - _monotonic) * 1000),
                })
                if (this.networkRequests.length > SessionManager.MAX_LOG_ENTRIES) {
                    this.networkRequests.splice(0, this.networkRequests.length - 800)
                }
            }
            this.requestMap.delete(p.requestId)
        }
        this.cdp!.onEvent('Network.loadingFinished', finalizeRequest)
        this.cdp!.onEvent('Network.loadingFailed', finalizeRequest)
    }

    /**
     * 更新页面状态
     */
    private async updateState(timeout?: number): Promise<void> {
        await this.getLiveState(timeout)
    }

    private async ensureRuntimeEnabled(): Promise<void> {
        if (this.runtimeEnabled) {
            return
        }
        this.ensureSession()
        await this.send('Runtime.enable')
        this.runtimeEnabled = true
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
