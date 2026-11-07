/**
 * 统一会话管理器
 *
 * 支持两种模式：
 * 1. Extension 模式：通过 Chrome Extension 操作用户浏览器（推荐）
 * 2. CDP 模式：通过 Chrome DevTools Protocol 操作（Fallback）
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { eventRefTarget, type BrowserEventAction, type EventCommand } from './browser-events.js'
import type {
    BrowserRequestContext,
    CookieFilter,
    CookieScope,
    FrameSelection,
    SemanticTarget,
    UserActionKind,
} from './browser-driver.js'
import { setTimeout as delay } from 'node:timers/promises'
import { Script } from 'node:vm'
import { ExtensionBridge, type ExtensionConnectionInfo } from '../extension/index.js'
import {
    type ActionableClickResult,
    type BrowserTopology,
    DriverCapabilityError,
    type GroupManagementResult,
    type GroupPagesOptions,
    type IBrowserDriver,
    type ListedTarget,
    type ManagedPageResult,
    type MovePageOptions,
    type NewPageOptions,
    type NewTabResult,
    type NewWindowOptions,
    type PageManagementResult,
    type PageMetadata,
    type ResizeWindowOptions,
    type SetCookieParams,
    type StaleContextRetryPolicy,
    type TargetListOptions,
    type UpdateGroupOptions,
    type UpdatePageOptions,
} from './browser-driver.js'
import {
    isNativeExecutionResultUnknown,
    getErrorSource,
    getErrorPageContext,
    OsMouseError,
    PagePreconditionError,
    setErrorPageContext,
    setErrorSource,
    StructuredToolError,
    TargetNotFoundError,
    TimeoutError,
} from './errors.js'
import { isExtensionDisconnected } from './extension-errors.js'
import {
    asViewportMetrics,
    osLeftClick,
    resolveTurnstileOsClickPoint,
    type NativePointerProbe,
    type TurnstileOsClickInput,
    type ViewportMetrics,
} from './os-mouse.js'
import { getKeyDefinition, getSession as getCdpSession } from './session.js'
import {
    type CdpResultObject,
    type ChallengeState,
    DEFAULT_TIMEOUT,
    EvaluateResultTooLargeError,
    extractCdpValue,
    formatCdpException,
    isKnownNonSerializableRemoteObject,
    MODIFIER_KEYS,
    NonSerializableEvaluateResultError,
    type TargetInfo,
    type WaitUntil,
} from './types.js'
import { remainingNavigationTimeout, waitForNavigationQueue, withNavigationBudget } from './utils.js'

export type ConnectionMode = 'extension' | 'cdp' | 'none'
type ActiveConnectionMode = Exclude<ConnectionMode, 'none'>
export type InputMode = 'stealth' | 'precise' // stealth=JS模拟, precise=debugger API

export interface EvaluateOptions {
    staleContextRetry?: StaleContextRetryPolicy
    fileOutput?: boolean
    userAction?: UserActionKind
}

export interface EvaluationMetadata {
    retryAttempted: boolean
    retryReason?: string
    staleContextRetry: StaleContextRetryPolicy
    frameContext: Record<string, unknown>
}

interface CdpPropertyDescriptor {
    name: string
    value?: CdpResultObject
    enumerable?: boolean
    wasThrown?: boolean
}

interface CdpMaterializeState {
    seen: Set<string>
    nodes: number
    chars: number
    maxChars: number
}

interface UnifiedSessionState {
    url: string
    title: string
    managed?: boolean
}

interface TargetRestoration {
    status: 'restored' | 'cleared' | 'previous_target_closed' | 'failed'
    previousTargetId: string | null
    temporaryTargetId: string
    currentTargetId: string | null
    error?: string
    cleanupError?: string
}

class UnifiedSessionManager {
    private static instance: UnifiedSessionManager
    private static readonly CONNECTION_COOLDOWN = 30000 // 连接失败后 30 秒内不重试
    private static readonly CDP_MATERIALIZE_MAX_DEPTH = 8
    private static readonly CDP_MATERIALIZE_MAX_NODES = 2000
    private static readonly CDP_MATERIALIZE_MAX_CHARS = 1_000_000
    private static readonly CDP_MATERIALIZE_MAX_FILE_CHARS = 16 * 1024 * 1024
    private extensionBridge: ExtensionBridge | null = null
    private inputMode: InputMode = 'precise' // 默认使用 precise 模式，可绕过 CSP 限制
    private currentMousePosition: { x: number; y: number } = { x: 0, y: 0 } // 跟踪鼠标位置
    private mouseFrameContext: { targetId: string; frameId: number; documentId?: string } | undefined
    /** 当前按下的修饰键位掩码 */
    private modifiers = 0
    /** 当前按下的所有键（用于 Puppeteer 风格的 rawKeyDown/autoRepeat 长按重复） */
    private pressedKeys = new Set<string>()
    private lastConnectionFailure = 0
    private activeMode: ActiveConnectionMode | null = null
    private cdpExplicitlySelected = false
    private extensionChallengeStateUnsupported = false
    private unsupportedChallengeStateBundleHash: string | null = null
    private tabSwitchLock: Promise<void> = Promise.resolve() // 串行化 tab 切换，防止并发竞态
    private readonly tabLockContext = new AsyncLocalStorage<
        BrowserRequestContext & {
            session: UnifiedSessionManager
            inputKeys?: Set<string>
            inputCleanup?: () => Promise<void>
            restoreTargetAfterPreparationFailure?: boolean
            restoreTargetAfterLookup?: boolean
            mode?: ActiveConnectionMode
            targetRestoration?: TargetRestoration
        }
    >()

    private requireExtension = false // 指定 tabId 或 frame 时为 true，禁止 CDP 回退
    private currentFrameOffset: { x: number; y: number } | null = null // iframe 在主页面的偏移量（withFrame 期间有效）
    private lastEvaluationMetadata: EvaluationMetadata | undefined
    private readonly pageMetadata = new Map<string, PageMetadata>()

    private constructor() {
        getCdpSession().requestContext = () => this.tabLockContext.getStore()
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

        this.extensionBridge = new ExtensionBridge({ requestContext: () => this.tabLockContext.getStore() })

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
        const scopedMode = this.tabLockContext.getStore()?.mode
        if (scopedMode) {
            return scopedMode
        }
        if (this.activeMode === 'extension' && this.extensionBridge?.isConnected()) {
            return 'extension'
        }
        if (this.activeMode === 'cdp' && this.cdpExplicitlySelected && getCdpSession().isConnected()) {
            return 'cdp'
        }
        if (this.extensionBridge?.isConnected()) {
            this.activeMode = 'extension'
            this.cdpExplicitlySelected = false
            return 'extension'
        }
        if (getCdpSession().isConnected()) {
            this.activeMode = 'cdp'
            return 'cdp'
        }
        this.activeMode = null
        return 'none'
    }

    async setActiveMode(mode: ActiveConnectionMode, cdpExplicitlySelected = false): Promise<void> {
        await this.withTabLock(async () => {
            this.activeMode = mode
            this.cdpExplicitlySelected = mode === 'cdp' && cdpExplicitlySelected
        })
    }

    /**
     * 获取当前输入模式
     */
    getInputMode(): InputMode {
        return this.inputMode
    }

    getCurrentTargetId(): string | null {
        const mode = this.getMode()
        if (mode === 'extension') {
            return this.extensionBridge?.getCurrentTargetId() ?? null
        }
        if (mode === 'cdp') {
            return getCdpSession().getCurrentTargetId()
        }
        return null
    }

    getPageMetadata(targetId: string): PageMetadata {
        return (
            this.pageMetadata.get(this.metadataKey(targetId)) ?? {
                origin: 'unknown',
                createdBy: 'unknown',
                createdAt: null,
                lastUsedAt: null,
            }
        )
    }

    async setPageMetadata(
        targetId: string,
        updates: { taskHint?: string | null; note?: string | null }
    ): Promise<PageMetadata> {
        await this.getPageSnapshot(targetId)
        if (this.getMode() === 'extension') {
            const driver = await this.getDriver()
            if (!driver.setPageMetadata) {
                throw new DriverCapabilityError('Extension 不支持持久页面备注，请成套更新 Server 和 Extension')
            }
            const metadata = await driver.setPageMetadata(targetId, updates)
            this.pageMetadata.set(this.metadataKey(targetId), metadata)
            return metadata
        }
        const metadata = { ...this.getPageMetadata(targetId) }
        if (updates.taskHint !== undefined) {
            if (updates.taskHint === null) {
                delete metadata.taskHint
            } else {
                metadata.taskHint = updates.taskHint
            }
        }
        if (updates.note !== undefined) {
            if (updates.note === null) {
                delete metadata.note
            } else {
                metadata.note = updates.note
            }
        }
        this.pageMetadata.set(this.metadataKey(targetId), metadata)
        return metadata
    }

    /**
     * 获取当前 iframe 在主页面的偏移量（仅 withFrame 期间有效）
     */
    getFrameOffset(): { x: number; y: number } | null {
        return this.currentFrameOffset
    }

    consumeLastEvaluationMetadata(): EvaluationMetadata | undefined {
        const metadata = this.lastEvaluationMetadata
        this.lastEvaluationMetadata = undefined
        return metadata
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
        return this.activeMode === 'extension' && (this.extensionBridge?.isConnected() ?? false)
    }

    isExtensionAvailable(): boolean {
        return this.extensionBridge?.isConnected() ?? false
    }

    getExtensionConnectionInfo(): ExtensionConnectionInfo | undefined {
        return this.extensionBridge?.getConnectionInfo()
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
        this.assertRequestActive()
        const explicitProcess = [
            options.port,
            options.executablePath,
            options.headless,
            options.userDataDir,
            options.incognito,
        ].some((value) => value !== undefined)
        if (explicitProcess && getCdpSession().isConnected()) {
            throw new DriverCapabilityError('显式启动参数要求新的独立浏览器；当前已有 CDP 连接，未关闭或替换现有浏览器')
        }
        const extensionReady =
            explicitProcess || this.cdpExplicitlySelected ? false : await this.ensureExtensionConnected(options.timeout)
        this.assertRequestActive()
        // 优先检查 Extension 是否已连接，如果断开则等待重连（受 timeout 约束）
        if (extensionReady) {
            // newPage 会设置 currentTabId，需要加锁
            const result = await this.withTabLock(async () => {
                return this.extensionBridge!.newPage(undefined, options.timeout)
            })
            this.activeMode = 'extension'
            this.cdpExplicitlySelected = false
            this.recordPageUse(result.targetId, true)
            if (result.metadata) {
                this.rememberPageMetadata(result.targetId, result.metadata)
            }
            return {
                targetId: result.targetId,
                type: result.type ?? 'page',
                url: result.url,
                title: result.title,
                managed: result.managed,
                mode: 'extension',
            }
        }

        // Fallback 到 CDP 模式
        const target = await getCdpSession().launch(options)
        this.activeMode = 'cdp'
        this.cdpExplicitlySelected = explicitProcess
        this.recordPageUse(target.targetId, target.targetCreated ?? target.reused !== true)
        return {
            ...target,
            mode: 'cdp',
        }
    }

    /**
     * 列出所有页面
     */
    async listTargets(
        timeout?: number,
        options?: TargetListOptions
    ): Promise<
        Array<
            TargetInfo &
                Omit<ListedTarget, 'id'> & {
                    mode: ConnectionMode
                    managed?: boolean
                    isActive?: boolean
                    windowId?: number
                    index?: number
                    pinned?: boolean
                    incognito?: boolean
                    status?: string
                    revision?: string
                    metadata: PageMetadata
                }
        >
    > {
        const mode = this.getMode()
        if (mode === 'none') {
            return []
        }
        const deadline = timeout === undefined ? undefined : Date.now() + timeout
        const driver = await this.getDriver(timeout)
        const targets = await driver.listTargets(
            deadline === undefined ? undefined : remainingNavigationTimeout(deadline),
            options
        )
        const liveKeys = new Set(targets.map((t) => `${mode}:${t.targetId ?? String(t.id)}`))
        for (const key of this.pageMetadata.keys()) {
            if (key.startsWith(`${mode}:`) && !liveKeys.has(key)) {
                this.pageMetadata.delete(key)
            }
        }
        for (const target of targets) {
            if (target.metadata) {
                this.rememberPageMetadata(target.targetId ?? String(target.id), target.metadata)
            }
        }
        return targets.map(({ id, ...target }) => ({
            ...target,
            targetId: target.targetId ?? String(id),
            type: target.type ?? 'page',
            mode,
            ...(mode === 'extension' ? { isActive: target.active ?? false } : {}),
            metadata: this.getPageMetadata(target.targetId ?? String(id)),
        }))
    }

    async listTopology(timeout?: number, options?: TargetListOptions): Promise<BrowserTopology | null> {
        const mode = this.getMode()
        if (mode === 'none') {
            return null
        }
        const deadline = timeout === undefined ? undefined : Date.now() + timeout
        const driver = await this.getDriver(timeout)
        if (!driver.listWindows) {
            return null
        }
        const topology = await driver.listWindows(
            deadline === undefined ? undefined : remainingNavigationTimeout(deadline),
            options
        )
        for (const tab of topology.windows.flatMap((window) => window.tabs)) {
            if (tab.metadata) {
                this.rememberPageMetadata(tab.targetId ?? String(tab.id), tab.metadata)
            }
        }
        return topology
    }

    async setReadAccess(targetId: string, allow: boolean): Promise<Record<string, unknown>> {
        const driver = await this.getDriver()
        if (!driver.setReadAccess) {
            throw new DriverCapabilityError('普通只读授权仅支持 Extension 模式，未执行')
        }
        return this.withTabLock(() => driver.setReadAccess!(targetId, allow))
    }

    async adoptPage(targetId: string): Promise<ManagedPageResult> {
        const driver = await this.getDriver()
        if (!driver.adoptPage) {
            throw new DriverCapabilityError('adoptPage 仅支持 Extension 模式')
        }
        return this.withTabLock(() => driver.adoptPage!(targetId))
    }

    async releasePage(targetId: string): Promise<ManagedPageResult> {
        const driver = await this.getDriver()
        if (!driver.releasePage) {
            throw new DriverCapabilityError('releasePage 仅支持 Extension 模式')
        }
        return this.withTabLock(() => driver.releasePage!(targetId))
    }

    async movePage(targetId: string, options: MovePageOptions): Promise<PageManagementResult> {
        const driver = await this.getDriver()
        if (!driver.movePage) {
            throw new DriverCapabilityError('movePage 仅支持 Extension 模式')
        }
        return driver.movePage(targetId, options)
    }

    async updatePage(targetId: string, options: UpdatePageOptions): Promise<PageManagementResult> {
        const driver = await this.getDriver()
        if (!driver.updatePage) {
            throw new DriverCapabilityError('updatePage 原生 tab 配置仅支持 Extension 模式')
        }
        return this.withTabLock(() => driver.updatePage!(targetId, options))
    }

    async groupPages(targetIds: string[], options: GroupPagesOptions): Promise<GroupManagementResult> {
        const driver = await this.getDriver()
        if (!driver.groupPages) {
            throw new DriverCapabilityError('groupPages 仅支持 Extension 模式')
        }
        return this.withTabLock(() => driver.groupPages!(targetIds, options))
    }

    async ungroupPages(targetIds: string[]): Promise<GroupManagementResult> {
        const driver = await this.getDriver()
        if (!driver.ungroupPages) {
            throw new DriverCapabilityError('ungroupPages 仅支持 Extension 模式')
        }
        return this.withTabLock(() => driver.ungroupPages!(targetIds))
    }

    async updateGroup(groupId: number, options: UpdateGroupOptions): Promise<GroupManagementResult> {
        const driver = await this.getDriver()
        if (!driver.updateGroup) {
            throw new DriverCapabilityError('updateGroup 仅支持 Extension 模式')
        }
        return this.withTabLock(() => driver.updateGroup!(groupId, options))
    }

    async moveGroup(
        groupId: number,
        options: Pick<MovePageOptions, 'windowId' | 'index'>
    ): Promise<GroupManagementResult> {
        const driver = await this.getDriver()
        if (!driver.moveGroup) {
            throw new DriverCapabilityError('moveGroup 仅支持 Extension 模式')
        }
        return this.withTabLock(() => driver.moveGroup!(groupId, options))
    }

    async reorderPage(targetId: string, index: number): Promise<PageManagementResult> {
        const driver = await this.getDriver()
        if (!driver.reorderPage) {
            throw new DriverCapabilityError('reorderPage 仅支持 Extension 模式')
        }
        return driver.reorderPage(targetId, index)
    }

    async pinPage(targetId: string, pinned: boolean): Promise<PageManagementResult> {
        const driver = await this.getDriver()
        if (!driver.pinPage) {
            throw new DriverCapabilityError('pinPage 仅支持 Extension 模式')
        }
        return driver.pinPage(targetId, pinned)
    }

    async activatePageWithAffected(targetId: string): Promise<PageManagementResult> {
        const driver = await this.getDriver()
        if (!driver.activatePageWithAffected) {
            throw new DriverCapabilityError('当前浏览器驱动不支持激活页面状态返回')
        }
        return this.withTabLock(() => driver.activatePageWithAffected!(targetId))
    }

    async focusWindow(windowId: number): Promise<PageManagementResult> {
        const driver = await this.getDriver()
        if (!driver.focusWindow) {
            throw new DriverCapabilityError('focusWindow 仅支持 Extension 模式')
        }
        return driver.focusWindow(windowId)
    }

    async resizeWindow(windowId: number, options: ResizeWindowOptions): Promise<PageManagementResult> {
        const driver = await this.getDriver()
        if (!driver.resizeWindow) {
            throw new DriverCapabilityError('resizeWindow 仅支持 Extension 模式')
        }
        return driver.resizeWindow(windowId, options)
    }

    async updateWindow(windowId: number, options: ResizeWindowOptions): Promise<PageManagementResult> {
        const driver = await this.getDriver()
        if (!driver.updateWindow) {
            throw new DriverCapabilityError('updateWindow 仅支持 Extension 模式')
        }
        return this.withTabLock(() => driver.updateWindow!(windowId, options))
    }

    async newWindow(options: NewWindowOptions): Promise<PageManagementResult> {
        const driver = await this.getDriver()
        if (!driver.newWindow) {
            throw new DriverCapabilityError('newWindow 仅支持 Extension 模式')
        }
        return this.withTabLock(async () => {
            const result = await driver.newWindow!(options)
            if (result.after && 'tabs' in result.after) {
                for (const tab of result.after.tabs) {
                    const targetId = tab.targetId ?? String(tab.id)
                    this.recordPageUse(targetId, targetId !== options.targetId)
                }
            } else if (result.targetId) {
                this.recordPageUse(result.targetId, options.targetId === undefined)
            }
            return result
        })
    }

    async closeWindow(windowId: number): Promise<PageManagementResult> {
        const driver = await this.getDriver()
        if (!driver.closeWindow) {
            throw new DriverCapabilityError('closeWindow 仅支持 Extension 模式')
        }
        return this.withTabLock(async () => {
            const result = await driver.closeWindow!(windowId)
            if (result.before && 'tabs' in result.before) {
                for (const tab of result.before.tabs) {
                    this.pageMetadata.delete(this.metadataKey(tab.targetId ?? String(tab.id)))
                }
            }
            return result
        })
    }

    /**
     * 导航到 URL
     */
    async navigate(url: string, options: { wait?: WaitUntil; timeout?: number } = {}): Promise<void> {
        const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT)
        const driver = await this.getDriver(remainingNavigationTimeout(deadline))
        const navigate = () =>
            driver.navigate(url, { wait: options.wait, timeout: remainingNavigationTimeout(deadline) })
        await (this.getMode() === 'extension' ? this.withTabLock(navigate, deadline) : navigate())
    }

    async goBack(timeout = DEFAULT_TIMEOUT): Promise<{ navigated: boolean }> {
        const deadline = Date.now() + timeout
        const driver = await this.getDriver(remainingNavigationTimeout(deadline))
        const result = await this.withTabLock(() => driver.goBack(remainingNavigationTimeout(deadline)), deadline)
        return { navigated: result.navigated }
    }

    async goForward(timeout = DEFAULT_TIMEOUT): Promise<{ navigated: boolean }> {
        const deadline = Date.now() + timeout
        const driver = await this.getDriver(remainingNavigationTimeout(deadline))
        const result = await this.withTabLock(() => driver.goForward(remainingNavigationTimeout(deadline)), deadline)
        return { navigated: result.navigated }
    }

    async reload(options: { ignoreCache?: boolean; waitUntil?: string; timeout?: number } = {}): Promise<void> {
        const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT)
        const driver = await this.getDriver(remainingNavigationTimeout(deadline))
        await this.withTabLock(
            () => driver.reload(options.ignoreCache, options.waitUntil, remainingNavigationTimeout(deadline)),
            deadline
        )
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
    }): Promise<import('./browser-driver.js').ScreenshotResult> {
        return (await this.getDriver()).screenshot(options)
    }

    /**
     * 点击元素
     */
    async click(refId: string): Promise<void> {
        const driver = await this.getDriver()
        await driver.click(refId, undefined, this.modifiers)
    }

    /**
     * 带 actionability 检查的点击（Extension 模式）
     *
     * 返回结构化结果，让调用方知道操作是否真正生效
     */
    async actionableClick(
        refId: string,
        force = false,
        button: 'left' | 'middle' | 'right' | 'back' | 'forward' = 'left',
        clickCount = 1,
        point?: { x: number; y: number }
    ): Promise<ActionableClickResult> {
        const driver = await this.getDriver()
        if (point) {
            this.currentMousePosition = { x: point.x, y: point.y }
            this.rememberMouseFrame()
        }
        if (this.inputMode === 'stealth' || force) {
            if (button === 'left' && clickCount === 1) {
                return driver.actionableClick(refId, force, undefined, this.modifiers)
            }
        }
        if (!force) {
            const result = await driver.checkActionability(refId)
            if (!result.success) {
                return result
            }
            if (result.clickPoint) {
                this.currentMousePosition = { ...result.clickPoint }
                this.rememberMouseFrame()
            }
        }
        if (force) {
            const { x, y } = this.currentMousePosition
            await driver.stealthClick(x, y, button, clickCount, refId, undefined, this.modifiers)
        } else {
            try {
                await this.mouseClick(button, clickCount, refId)
            } catch (error) {
                const code = (error as { code?: string } | null)?.code
                if (
                    code !== 'NATIVE_INPUT_UNAVAILABLE' ||
                    !this.isExtensionConnected() ||
                    button !== 'left' ||
                    clickCount !== 1 ||
                    this.modifiers !== 0
                ) {
                    throw error
                }
                const result = await driver.actionableClick(refId, false, undefined, this.modifiers)
                return { ...result, warning: '后台元素单击使用合成事件，isTrusted=false，未激活标签页' }
            }
        }
        return { success: true }
    }

    /**
     * dispatch 模式输入（Extension MAIN 世界，兼容 React/Vue 受控组件）
     */
    async dispatchInput(refId: string, text: string): Promise<{ success: boolean; error?: string }> {
        const driver = await this.getDriver()
        return driver.dispatchInput(refId, text)
    }

    /**
     * HTML5 drag/drop（Extension MAIN 世界，与 refId 创建侧共享 __mcpElementMap）
     */
    async dragAndDrop(
        srcRefId: string,
        dstRefId: string
    ): Promise<{ success: boolean; error?: string; code?: string }> {
        const driver = await this.getDriver()
        return driver.dragAndDrop(srcRefId, dstRefId)
    }

    /**
     * 获取元素 computed style（Extension 受控页为 MAIN，只读 documentId 授权为 ISOLATED）
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
     * @param options iframe stale context 重试策略，默认 never
     * @param _retried 内部重试标记，外部不应传入
     */
    async evaluate<T>(
        code: string,
        mode?: InputMode,
        timeout?: number,
        args?: unknown[],
        options: EvaluateOptions = {},
        _retried = false
    ): Promise<T> {
        this.assertRequestActive()
        this.lastEvaluationMetadata = undefined
        const effectiveMode = mode ?? this.inputMode
        const hasArgs = args !== undefined

        // stealth 模式：args 只能通过字符串拼接（chrome.scripting 不支持协议级参数传递）
        let expression = code
        if (hasArgs && effectiveMode === 'stealth') {
            const argsStr = args.map((a) => JSON.stringify(a)).join(', ')
            expression = `(${code})(${argsStr})`
        }

        const cdpScript = hasArgs ? code : expression

        if (!_retried && !hasArgs && /\breturn\b/.test(code)) {
            try {
                new Script(code)
            } catch (error) {
                if (error instanceof SyntaxError && /Illegal return statement/.test(error.message)) {
                    return this.evaluate<T>(`(() => { ${code} })()`, mode, timeout, undefined, options, true)
                }
            }
        }
        if (timeout !== undefined) {
            // 轮询上下文：快速失败，端到端预算受控
            if (!this.isExtensionConnected()) {
                this.assertCdpFallbackAllowed()
                return await this.evaluateViaCdp<T>(cdpScript, args, timeout, options)
            }
        } else {
            // 非轮询上下文：允许等待重连；连接失败时回退 CDP
            if (!(await this.ensureExtensionConnected())) {
                return await this.evaluateViaCdp<T>(cdpScript, args, timeout, options)
            }
        }

        // Extension 路径
        if (effectiveMode === 'precise') {
            return await this.evaluateViaExtensionPrecise<T>(code, expression, args, timeout, options)
        }
        return await this.evaluateViaExtensionStealth<T>(expression, timeout, options.userAction)
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

    async getTextByRef(refId: string): Promise<string> {
        return this.extensionReadBridge().getText(undefined, refId)
    }

    async getHtmlByRef(refId: string, outer = true): Promise<string> {
        return this.extensionReadBridge().getHtml(undefined, outer, refId)
    }

    async getAttributeByRef(refId: string, attribute: string): Promise<string | null> {
        return this.extensionReadBridge().getAttribute(undefined, refId, attribute)
    }

    async getComputedStyleByRef(refId: string, prop: string): Promise<string | null> {
        return this.extensionReadBridge().getComputedStyle(refId, prop)
    }

    async findAtPoint(x: number, y: number, matchIndex?: number, timeout?: number) {
        return this.extensionReadBridge().find(undefined, undefined, undefined, timeout, { x, y }, matchIndex)
    }

    async getHtmlWithImagesByRef(refId: string) {
        return this.extensionReadBridge().getHtmlWithImages(undefined, true, refId)
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
        const targetId = this.getCurrentTargetId()
        const metadata = await driver.getMetadata()
        const target = (await this.listTargets()).find((page) => page.targetId === targetId)
        if (!target) {
            throw new TargetNotFoundError(targetId ?? 'current')
        }
        return { ...metadata, managed: target.managed ?? false, metadata: target.metadata }
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
     * @param semanticOrMatchIndex 语义名称条件，或兼容旧调用的匹配序号
     * @param matchIndex 匹配序号，从 0 开始，指定时只返回该位置
     */
    async find(
        selector?: string,
        text?: string,
        xpath?: string,
        timeout?: number,
        semanticOrMatchIndex?: SemanticTarget | number,
        matchIndex?: number
    ): Promise<
        Array<{
            refId: string
            tag: string
            text: string
            rect: { x: number; y: number; width: number; height: number }
        }>
    > {
        const semantic = typeof semanticOrMatchIndex === 'object' ? semanticOrMatchIndex : undefined
        matchIndex = typeof semanticOrMatchIndex === 'number' ? semanticOrMatchIndex : matchIndex
        this.assertRequestActive()
        if (timeout !== undefined) {
            // 轮询上下文：快速失败，端到端预算受控
            if (this.isExtensionConnected()) {
                return this.extensionBridge!.find(selector, text, xpath, timeout, semantic, matchIndex)
            }
            this.assertCdpFallbackAllowed()
            return getCdpSession().find(selector, text, xpath, timeout, semantic, matchIndex)
        }

        // 非轮询上下文：允许等待重连，断连时 fallback CDP
        const driver = await this.getDriver()
        return this.withExtensionRetry(
            () =>
                driver === this.extensionBridge
                    ? this.extensionBridge.find(selector, text, xpath, undefined, semantic, matchIndex)
                    : getCdpSession().find(selector, text, xpath, undefined, semantic, matchIndex),
            () => getCdpSession().find(selector, text, xpath, undefined, semantic, matchIndex)
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

    async getFrames(): Promise<Record<string, unknown>> {
        const driver = await this.getDriver()
        if (!driver.getFrames) {
            return { frames: [] }
        }
        return driver.getFrames()
    }

    /**
     * 获取 Cookies
     */
    async getCookies(filter?: CookieFilter): Promise<unknown> {
        return (await this.getDriver()).getCookies(filter)
    }

    async setCookie(params: SetCookieParams): Promise<void> {
        const driver = await this.getDriver()
        await driver.setCookie(params)
    }

    async deleteCookie(url: string, name: string, scope?: CookieScope): Promise<void> {
        return (await this.getDriver()).deleteCookie(url, name, scope)
    }

    async clearCookies(filter?: CookieFilter): Promise<{ count: number }> {
        if (!filter || (!filter.url && !filter.domain)) {
            throw new Error(
                'clearCookies 必须带 url 或 domain 过滤参数，name 只能在该范围内进一步过滤（防止跨站误清同名 cookie）'
            )
        }
        return (await this.getDriver()).clearCookies(filter)
    }

    /**
     * 创建新页面
     */
    async newPage(url?: string, options?: NewPageOptions, timeout?: number): Promise<TargetInfo & NewTabResult> {
        const driver = await this.getDriver()
        const isExt = this.isExtensionConnected()
        const op = async (): Promise<TargetInfo & NewTabResult> => {
            const result = await driver.newPage(url, timeout, options)
            this.recordPageUse(result.targetId, true)
            if (result.metadata) {
                this.rememberPageMetadata(result.targetId, result.metadata)
            } else if (!isExt && (options?.taskHint !== undefined || options?.note !== undefined)) {
                await this.setPageMetadata(result.targetId, options)
            }
            return {
                ...result,
                targetId: result.targetId,
                type: result.type ?? 'page',
                url: result.url,
                title: result.title,
                managed: result.managed,
            }
        }
        // Extension 模式 createTab 设置 currentTabId,需要加锁防止并发竞态
        return isExt ? this.withTabLock(op) : op()
    }

    /**
     * 关闭页面
     */
    async closePage(targetId: string): Promise<void | PageManagementResult> {
        if (!targetId) {
            throw new DriverCapabilityError('closePage 需要显式 targetId，未关闭页面')
        }
        const driver = await this.getDriver()
        const isExt = this.isExtensionConnected()
        const op = async () => {
            const result = await driver.closePage(targetId)
            this.pageMetadata.delete(this.metadataKey(targetId))
            return result
        }
        if (isExt) {
            return this.withTabLock(op)
        }
        return op()
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
        this.recordPageUse(targetId)
    }

    /**
     * 串行化所有 tab 切换操作，防止并发请求互相覆盖 currentTabId，
     * 调用者：selectPage/activatePage/adoptPage/releasePage/newPage/closePage/navigate/reload/launch/withTabId
     *
     * 同一请求内的嵌套调用可重入，恢复状态只保存在当前请求的 AsyncLocalStorage 中
     */
    assertRequestActive(scope: BrowserRequestContext | undefined = this.tabLockContext.getStore()): void {
        if (scope?.budgetError) {
            throw scope.budgetError
        }
        scope?.signal?.throwIfAborted()
        if (scope?.deadline !== undefined && Date.now() >= scope.deadline) {
            throw setErrorSource(
                new StructuredToolError('TIMEOUT', 'Request timeout before dispatch', '请检查页面状态后再提交操作', {
                    actionExecuted: false,
                    actionStatus: 'not_started',
                    retryable: false,
                }),
                'budget'
            )
        }
    }

    async withUserAction<T>(
        kind: UserActionKind,
        fn: () => Promise<T>,
        restoreTargetAfterPreparationFailure = false
    ): Promise<T> {
        return this.withTabLock(async () => {
            const scope = this.tabLockContext.getStore()!
            const previous = scope.userAction
            const action: NonNullable<BrowserRequestContext['userAction']> = {
                kind,
                dispatched: false,
                phase: 'preparation',
            }
            scope.userAction = action
            try {
                return await fn()
            } catch (error) {
                if (restoreTargetAfterPreparationFailure && !action.dispatched && action.phase === 'preparation') {
                    scope.restoreTargetAfterPreparationFailure = true
                }
                throw this.annotateUserActionError(error)
            } finally {
                if (previous?.kind === kind && action.dispatched) {
                    previous.dispatched = true
                }
                scope.userAction = previous
            }
        })
    }

    annotateUserActionError(error: unknown): unknown {
        const scope = this.tabLockContext.getStore()
        if (scope && error instanceof Error && getErrorSource(error) === 'budget') {
            scope.budgetError ??= error
        }
        const action = scope?.userAction
        const uncertain = getErrorSource(error) !== 'page' && isNativeExecutionResultUnknown(error)
        const outputFailure =
            getErrorSource(error) !== 'page' &&
            error instanceof StructuredToolError &&
            error.code === 'NON_SERIALIZABLE_EVALUATE_RESULT' &&
            getErrorPageContext(error)?.contextPhase === 'preparation'
        const preparing =
            action &&
            !action.dispatched &&
            (uncertain ||
                outputFailure ||
                getErrorPageContext(error)?.keyboardFocusPreparation === true ||
                getErrorPageContext(error)?.frameResolutionPreparation === true ||
                action.phase === 'precondition' ||
                error instanceof PagePreconditionError)
        return setErrorPageContext(error, {
            contextPhase: preparing
                ? error instanceof PagePreconditionError
                    ? 'precondition'
                    : action.phase
                : 'action',
        })
    }

    async prepareKeyboardFocus(timeout?: number): Promise<string | undefined> {
        if (this.getMode() !== 'extension' || this.inputMode !== 'precise') {
            return undefined
        }
        const scope = this.tabLockContext.getStore()!
        if (scope.keyboardFocus) {
            return undefined
        }
        const bridge = this.extensionBridge!
        const targetId = bridge.getCurrentTargetId()
        if (!targetId) {
            throw new TargetNotFoundError('没有当前原生按键目标')
        }
        const focus: NonNullable<BrowserRequestContext['keyboardFocus']> = { id: randomUUID(), targetId }
        scope.keyboardFocus = focus
        try {
            this.assertRequestActive()
            const result = await bridge.acquireKeyboardFocus(focus.id, timeout)
            if (result.changed) {
                focus.warning = '原生按键期间文档临时报告 visible；操作结束后恢复原设置，实际标签页与窗口焦点保持'
            }
            this.assertRequestActive()
            return focus.warning
        } catch (error) {
            throw setErrorPageContext(error, { keyboardFocusPreparation: true })
        }
    }

    async withInputCleanup<T>(fn: () => Promise<T>): Promise<T> {
        const scope = this.tabLockContext.getStore()!
        const keysBefore = new Set(this.pressedKeys)
        const driver = this.getMode() === 'extension' ? this.extensionBridge : getCdpSession()
        const targetId = driver?.getCurrentTargetId()
        const frameId = driver?.getCurrentFrameId?.()
        const documentId =
            this.extensionBridge === driver ? this.extensionBridge?.getCurrentFrameDocumentId?.() : undefined
        const keys = new Set<string>()
        scope.inputKeys = keys
        const cleanup = async (releaseUnknown = false) => {
            if (
                !releaseUnknown &&
                !scope.signal?.aborted &&
                !scope.budgetError &&
                (scope.deadline === undefined || Date.now() < scope.deadline)
            ) {
                return
            }
            scope.inputCleanup = undefined
            if (![...keys].some((key) => !keysBefore.has(key))) {
                return
            }
            const cleanupDeadline = Date.now() + 1000
            try {
                await this.tabLockContext.run(
                    {
                        ...scope,
                        signal: undefined,
                        deadline: cleanupDeadline,
                        inputCleanup: undefined,
                        userAction: undefined,
                        budgetError: undefined,
                        pendingPageCondition: null,
                    },
                    async () => {
                        const bridge = driver === this.extensionBridge ? this.extensionBridge : null
                        const previousTarget = driver?.getCurrentTargetId()
                        const previousFrame = driver?.getCurrentFrameId?.()
                        const previousDocument = bridge?.getCurrentFrameDocumentId?.()
                        const inputContext =
                            !bridge && targetId && (targetId !== previousTarget || frameId !== previousFrame)
                                ? { targetId, frameId }
                                : undefined
                        try {
                            if (bridge && targetId) {
                                bridge.setCurrentTargetId(targetId)
                                if (frameId !== undefined) {
                                    bridge.setCurrentFrameId(frameId, documentId)
                                }
                            }
                            for (const key of keys) {
                                if (keysBefore.has(key)) {
                                    continue
                                }
                                try {
                                    await this.keyUp(key, remainingNavigationTimeout(cleanupDeadline), inputContext)
                                } catch (error) {
                                    console.warn('[MCP] Cancelled input key release failed:', key, error)
                                }
                            }
                        } finally {
                            if (bridge && previousTarget !== undefined) {
                                bridge.setCurrentTargetId(previousTarget)
                                if (previousFrame !== undefined) {
                                    bridge.setCurrentFrameId(previousFrame, previousDocument)
                                }
                            }
                        }
                    }
                )
            } catch (error) {
                console.warn('[MCP] Cancelled input scope cleanup failed:', error)
            }
        }
        scope.inputCleanup = cleanup
        let failed = false
        let primaryError: unknown
        let cleanupError: StructuredToolError | undefined
        let value: T
        try {
            value = await fn()
        } catch (error) {
            failed = true
            primaryError = error
            if (scope.keyboardFocus?.warning) {
                setErrorPageContext(error, { keyboardFocusWarning: scope.keyboardFocus.warning })
            }
            throw error
        } finally {
            await cleanup(failed && isNativeExecutionResultUnknown(primaryError))
            const focus = scope.keyboardFocus
            if (focus && driver === this.extensionBridge) {
                scope.inputCleanup = undefined
                const releaseKeys =
                    failed ||
                    Boolean(scope.signal?.aborted || scope.budgetError) ||
                    (scope.deadline !== undefined && Date.now() >= scope.deadline)
                let result: { restored: boolean; errors: string[] }
                try {
                    result = await this.tabLockContext.run(
                        {
                            ...scope,
                            signal: undefined,
                            deadline: Date.now() + 4000,
                            budgetError: undefined,
                            userAction: undefined,
                            pendingPageCondition: null,
                            keyboardFocus: undefined,
                            inputCleanup: undefined,
                        },
                        () => this.extensionBridge!.releaseKeyboardFocus(focus, releaseKeys)
                    )
                    if (releaseKeys && result.restored) {
                        for (const key of keys) {
                            if (!keysBefore.has(key)) {
                                this.pressedKeys.delete(key)
                                this.modifiers &= ~(MODIFIER_KEYS[key] ?? 0)
                            }
                        }
                    }
                } catch (error) {
                    result = { restored: false, errors: [error instanceof Error ? error.message : String(error)] }
                } finally {
                    scope.keyboardFocus = undefined
                }
                if (!result.restored) {
                    if (failed) {
                        setErrorPageContext(primaryError, { keyboardFocusCleanup: result })
                    } else {
                        cleanupError = new StructuredToolError(
                            'KEYBOARD_FOCUS_CLEANUP_FAILED',
                            '原生按键已执行，焦点状态恢复未完成',
                            '请读取当前页面与 Extension 日志',
                            {
                                failureStage: 'cleanup',
                                retryable: false,
                                keyboardFocusCleanup: result,
                            }
                        )
                    }
                }
            }
        }
        if (cleanupError) {
            throw cleanupError
        }
        return value
    }

    async wait(ms: number): Promise<void> {
        this.assertRequestActive()
        await delay(ms, undefined, { signal: this.tabLockContext.getStore()?.signal })
        this.assertRequestActive()
    }

    async withMetadataContext<T>(fn: () => Promise<T>, deadline?: number, signal?: AbortSignal): Promise<T> {
        const mode = this.getMode()
        return this.tabLockContext.run(
            { session: this, deadline, signal, mode: mode === 'none' ? undefined : mode },
            async () => {
                this.assertRequestActive()
                return fn()
            }
        )
    }

    async withTabLock<T>(fn: () => Promise<T>, deadline?: number, signal?: AbortSignal): Promise<T> {
        signal?.throwIfAborted()
        if (this.tabLockContext.getStore()?.session === this) {
            this.assertRequestActive()
            if (deadline !== undefined) {
                remainingNavigationTimeout(deadline)
            }
            return fn()
        }
        const previousLock = this.tabSwitchLock
        let releaseLock: () => void
        this.tabSwitchLock = new Promise<void>((resolve) => {
            releaseLock = resolve
        })
        let acquired = false
        try {
            await waitForNavigationQueue(previousLock, deadline, signal)
            acquired = true
            signal?.throwIfAborted()
            return await this.tabLockContext.run({ session: this, deadline, signal }, async () => {
                const scope = this.tabLockContext.getStore()!
                try {
                    return await fn()
                } finally {
                    try {
                        if (
                            scope.signal?.aborted ||
                            scope.budgetError ||
                            (scope.deadline !== undefined && Date.now() >= scope.deadline)
                        ) {
                            await scope.inputCleanup?.()
                        }
                    } finally {
                        scope.inputKeys = undefined
                        scope.inputCleanup = undefined
                    }
                }
            })
        } finally {
            if (acquired) {
                releaseLock!()
            } else {
                void previousLock.then(releaseLock!, releaseLock!)
            }
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
    async withTabId<T>(targetId: string | undefined, fn: () => Promise<T>, deadline?: number): Promise<T> {
        return this.withTabLock(async () => {
            const remaining = () => (deadline === undefined ? undefined : remainingNavigationTimeout(deadline))
            const mode = this.getMode()
            const scope = this.tabLockContext.getStore()!
            if (mode !== 'none') {
                scope.mode = mode
            }
            if (!targetId) {
                const current = this.getCurrentTargetId()
                if (current) {
                    this.recordPageUse(current)
                }
                const previousRequireExtension = this.requireExtension
                const previousCdpSelection = this.cdpExplicitlySelected
                if (mode === 'extension') {
                    this.requireExtension = true
                } else if (mode === 'cdp') {
                    this.cdpExplicitlySelected = true
                }
                try {
                    return await fn()
                } finally {
                    this.requireExtension = previousRequireExtension
                    this.cdpExplicitlySelected = previousCdpSelection
                }
            }
            if (mode === 'none') {
                throw new DriverCapabilityError('浏览器未连接，无法选择目标页面')
            }
            const driver = mode === 'extension' ? this.extensionBridge! : getCdpSession()
            const targets = await driver.listTargets(remaining())
            if (!targets.some((target) => (target.targetId ?? String(target.id)) === targetId)) {
                throw new DriverCapabilityError(`目标页面 ${targetId} 不存在于当前 ${mode} 连接`)
            }
            const previousId = driver.getCurrentTargetId()
            const previousRequireExtension = this.requireExtension
            const previousCdpSelection = this.cdpExplicitlySelected
            const previousMode = this.activeMode
            if (mode === 'extension') {
                this.requireExtension = true
            } else {
                this.cdpExplicitlySelected = true
            }
            try {
                if (targetId !== previousId) {
                    await driver.selectPage(targetId, remaining())
                }
                this.activeMode = mode
                this.recordPageUse(targetId)
                return await fn()
            } finally {
                this.requireExtension = previousRequireExtension
                this.cdpExplicitlySelected = previousCdpSelection
                this.activeMode = previousMode
                if (targetId !== previousId) {
                    const restoration: TargetRestoration = {
                        status: previousId ? 'restored' : 'cleared',
                        previousTargetId: previousId,
                        temporaryTargetId: targetId,
                        currentTargetId: null,
                    }
                    const independentCleanup =
                        (scope.restoreTargetAfterPreparationFailure === true ||
                            scope.restoreTargetAfterLookup === true) &&
                        (scope.signal?.aborted === true ||
                            scope.budgetError !== undefined ||
                            (scope.deadline !== undefined && Date.now() >= scope.deadline))
                    scope.restoreTargetAfterPreparationFailure = undefined
                    scope.restoreTargetAfterLookup = undefined
                    const cleanupDeadline = independentCleanup ? Date.now() + 1000 : deadline
                    const cleanupRemaining = () =>
                        cleanupDeadline === undefined ? undefined : remainingNavigationTimeout(cleanupDeadline)
                    await this.tabLockContext.run(
                        independentCleanup
                            ? {
                                  ...scope,
                                  signal: undefined,
                                  deadline: cleanupDeadline,
                                  budgetError: undefined,
                                  userAction: undefined,
                                  pendingPageCondition: null,
                                  keyboardFocus: undefined,
                                  inputCleanup: undefined,
                              }
                            : scope,
                        async () => {
                            let clearTarget = true
                            try {
                                if (previousId) {
                                    const targets = await driver.listTargets(cleanupRemaining())
                                    if (
                                        targets.some((target) => (target.targetId ?? String(target.id)) === previousId)
                                    ) {
                                        await driver.selectPage(previousId, cleanupRemaining())
                                        clearTarget = false
                                    } else {
                                        restoration.status = 'previous_target_closed'
                                    }
                                }
                            } catch (error) {
                                restoration.status = 'failed'
                                restoration.error = error instanceof Error ? error.message : String(error)
                            }
                            if (clearTarget) {
                                try {
                                    if (mode === 'extension') {
                                        driver.setCurrentTargetId(null)
                                    } else {
                                        await getCdpSession().deselectPage(
                                            cleanupDeadline === undefined
                                                ? undefined
                                                : Math.max(0, cleanupDeadline - Date.now())
                                        )
                                    }
                                } catch (error) {
                                    const message = error instanceof Error ? error.message : String(error)
                                    if (restoration.error) {
                                        restoration.cleanupError = message
                                    } else {
                                        restoration.status = 'failed'
                                        restoration.error = message
                                    }
                                }
                            }
                        }
                    )
                    restoration.currentTargetId = driver.getCurrentTargetId()
                    scope.targetRestoration = restoration
                }
            }
        }, deadline)
    }

    preserveTargetAfterLookup(): void {
        const scope = this.tabLockContext.getStore()
        if (scope) {
            scope.restoreTargetAfterLookup = true
        }
    }

    getTargetRestoration(): TargetRestoration | undefined {
        return this.tabLockContext.getStore()?.targetRestoration
    }

    async getPageSnapshot(
        targetId?: string,
        timeout?: number
    ): Promise<{ targetId: string; url: string; revision: string | null; warning?: string }> {
        const mode = this.getMode()
        if (mode === 'none') {
            throw new DriverCapabilityError('浏览器未连接，无法读取页面状态')
        }
        const id = targetId ?? this.getCurrentTargetId()
        if (!id) {
            throw new DriverCapabilityError('没有操作目标，请先选择页面')
        }
        const snapshot =
            mode === 'extension'
                ? await this.extensionBridge!.getPageSnapshot(id, timeout)
                : await getCdpSession().getPageSnapshot(id, timeout)
        this.recordPageUse(id)
        const nativeMetadata = (snapshot as typeof snapshot & { metadata?: PageMetadata }).metadata
        if (nativeMetadata) {
            this.rememberPageMetadata(id, nativeMetadata)
        }
        return snapshot
    }

    async withPageCondition<T>(
        condition: { targetId?: string; expectedUrl?: string; expectedRevision?: string },
        fn: () => Promise<T>,
        deadline?: number
    ): Promise<T> {
        let contextPhase: 'action' | 'precondition' = 'action'
        try {
            if (condition.expectedUrl === undefined && condition.expectedRevision === undefined) {
                return await fn()
            }
            return await this.withTabLock(async () => {
                contextPhase = 'precondition'
                const userAction = this.tabLockContext.getStore()?.userAction
                if (userAction) {
                    userAction.phase = 'precondition'
                }
                const mode = this.getMode()
                const targetId = condition.targetId ?? this.getCurrentTargetId()
                if (mode === 'none' || !targetId) {
                    throw new DriverCapabilityError('没有操作目标，请先选择页面')
                }
                const driver = mode === 'extension' ? this.extensionBridge! : getCdpSession()
                const previousRequireExtension = this.requireExtension
                const previousCdpSelection = this.cdpExplicitlySelected
                const previousMode = this.activeMode
                if (mode === 'extension') {
                    this.requireExtension = true
                } else {
                    this.cdpExplicitlySelected = true
                }
                try {
                    const snapshot = await driver.getPageSnapshot(
                        targetId,
                        deadline === undefined ? undefined : remainingNavigationTimeout(deadline)
                    )
                    if (snapshot.revision === null) {
                        throw new StructuredToolError(
                            'DRIVER_CAPABILITY_ERROR',
                            '当前 Extension 不支持原子页面条件，未执行操作',
                            '更新 Extension 后再使用 expectedUrl 或 expectedRevision',
                            {
                                targetId,
                                actionExecuted: false,
                                actionStatus: 'not_started',
                                failureStage: 'precondition',
                            }
                        )
                    }
                    if (
                        (condition.expectedUrl !== undefined && snapshot.url !== condition.expectedUrl) ||
                        (condition.expectedRevision !== undefined && snapshot.revision !== condition.expectedRevision)
                    ) {
                        throw new PagePreconditionError({
                            targetId,
                            expectedUrl: condition.expectedUrl ?? null,
                            expectedRevision: condition.expectedRevision ?? null,
                            actualUrl: snapshot.url,
                            actualRevision: snapshot.revision,
                        })
                    }
                    driver.setPageCondition({
                        targetId,
                        expectedUrl: condition.expectedUrl,
                        expectedRevision: condition.expectedRevision,
                    })
                    contextPhase = 'action'
                    if (userAction) {
                        userAction.phase = 'preparation'
                    }
                    return await fn()
                } finally {
                    driver.setPageCondition(null)
                    this.requireExtension = previousRequireExtension
                    this.cdpExplicitlySelected = previousCdpSelection
                    this.activeMode = previousMode
                }
            }, deadline)
        } catch (error) {
            throw setErrorPageContext(error, { contextPhase })
        }
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
    async withFrame<T>(frame: FrameSelection | undefined, fn: () => Promise<T>, deadline?: number): Promise<T> {
        if (frame === undefined) {
            return fn()
        }
        const scope = this.tabLockContext.getStore()
        deadline = deadline === undefined ? scope?.deadline : Math.min(deadline, scope?.deadline ?? deadline)
        const driver = await this.getDriver(deadline === undefined ? undefined : remainingNavigationTimeout(deadline))
        const { frameId, offset, frameContext } = await driver
            .resolveFrame(frame, deadline === undefined ? undefined : remainingNavigationTimeout(deadline))
            .catch((error: unknown) => {
                if (!scope?.userAction?.dispatched) {
                    if (scope) {
                        scope.restoreTargetAfterPreparationFailure = true
                    }
                    throw setErrorPageContext(error, { contextPhase: 'preparation', frameResolutionPreparation: true })
                }
                throw error
            })
        const previousFrameId = driver.getCurrentFrameId()
        const extension = driver === this.extensionBridge ? this.extensionBridge : undefined
        const previousDocument = extension?.getCurrentFrameDocumentId?.()
        const previousOffset = this.currentFrameOffset
        if (extension) {
            extension.setCurrentFrameId(
                frameId,
                typeof frameContext?.documentId === 'string' ? frameContext.documentId : undefined
            )
        } else {
            driver.setCurrentFrameId(frameId)
        }
        this.currentFrameOffset = offset
        try {
            return await fn()
        } catch (error) {
            throw setErrorPageContext(error, { frameContext: { selection: frame, frameId, ...frameContext } })
        } finally {
            this.currentFrameOffset = previousOffset
            if (extension) {
                extension.setCurrentFrameId(previousFrameId, previousDocument)
            } else {
                driver.setCurrentFrameId(previousFrameId)
            }
        }
    }

    hasBrowserEventObservation(targetId?: string): boolean {
        return this.getMode() === 'cdp' || this.extensionBridge?.hasBrowserEventObservation(targetId) === true
    }

    async browserEvents(
        action: BrowserEventAction,
        command: EventCommand,
        targetId?: string,
        timeout = DEFAULT_TIMEOUT,
        signal?: AbortSignal,
        deadline = Date.now() + timeout
    ): Promise<Record<string, unknown>> {
        const refTarget = command.ref ? eventRefTarget(command.ref) : undefined
        const mode = refTarget?.backend ?? this.getMode()
        if (targetId && refTarget && targetId !== refTarget.targetId) {
            throw new DriverCapabilityError('Browser event ref target mismatch')
        }
        const driver = mode === 'extension' ? this.extensionBridge : mode === 'cdp' ? getCdpSession() : null
        if (!driver) {
            throw new DriverCapabilityError('Browser event backend is not connected')
        }
        const id = refTarget?.targetId ?? targetId ?? driver.getCurrentTargetId() ?? undefined
        const scope = this.tabLockContext.getStore()
        return this.tabLockContext.run(
            {
                session: this,
                signal: signal ?? scope?.signal,
                deadline: Math.min(scope?.deadline ?? Infinity, deadline),
            },
            () => driver.browserEvents(action, command, id, timeout)
        )
    }

    async browserFetchCommand(
        method: string,
        params?: Record<string, unknown>,
        targetId?: string,
        signal?: AbortSignal
    ): Promise<unknown> {
        const mode = this.getMode()
        const driver = mode === 'extension' ? this.extensionBridge : mode === 'cdp' ? getCdpSession() : null
        if (!driver?.browserFetchCommand) {
            throw new DriverCapabilityError('Fetch control backend unavailable')
        }
        const scope = this.tabLockContext.getStore()
        return this.tabLockContext.run(
            {
                ...scope,
                session: this,
                signal: signal ?? scope?.signal,
                deadline: Math.min(scope?.deadline ?? Infinity, Date.now() + DEFAULT_TIMEOUT),
            },
            () => driver.browserFetchCommand!(method, params, targetId)
        )
    }

    async suspendBrowserEventsForChallenge(): Promise<Record<string, unknown>> {
        const driver = await this.getDriver()
        return driver.suspendBrowserEventsForChallenge
            ? driver.suspendBrowserEventsForChallenge()
            : { suspended: false, reason: 'backend capability unavailable' }
    }

    /**
     * 获取当前状态
     */
    getState(): UnifiedSessionState | null {
        // driver.getState() 两侧都返回 DriverState | null（{url, title}），SessionState 含 targetId 是其超集，结构兼容
        if (this.getMode() === 'extension') {
            return this.extensionBridge!.getState()
        }
        return getCdpSession().getState()
    }

    async getLiveState(timeout?: number): Promise<UnifiedSessionState | null> {
        if (this.getMode() !== 'extension') {
            return getCdpSession().getLiveState(timeout)
        }
        const targetId = this.extensionBridge!.getCurrentTargetId()
        if (!targetId) {
            return null
        }
        const targets = await this.extensionBridge!.listTargets(timeout)
        const target = targets.find((item) => item.targetId === targetId)
        if (!target) {
            return null
        }
        return {
            url: target.url,
            title: target.title,
            managed: target.managed,
        }
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
    async keyDown(key: string, commands?: string[], timeout?: number): Promise<void> {
        const deadline = timeout === undefined ? undefined : Date.now() + timeout
        const driver = await this.getDriver(timeout)
        const remaining = () => (deadline === undefined ? undefined : remainingNavigationTimeout(deadline))
        const isExt = this.isExtensionConnected()

        // 预检查：stealth + commands 必然抛错，要在任何状态变更前抛出，避免 modifiers 污染
        if (isExt && this.inputMode === 'stealth' && commands && commands.length > 0) {
            throw new Error(
                'commands 参数不支持 stealth 输入模式，请先调用 manage action=inputMode inputMode=precise 切换后重试'
            )
        }

        // Puppeteer 风格：连续 keyDown 同 key → rawKeyDown + autoRepeat（长按重复）
        this.tabLockContext.getStore()?.inputKeys?.add(key)
        const isRepeat = this.pressedKeys.has(key)
        const nextModifiers = MODIFIER_KEYS[key] ? this.modifiers | MODIFIER_KEYS[key] : this.modifiers

        if (!isExt) {
            await getCdpSession().keyDown(key, commands, { rawKeyDown: isRepeat, autoRepeat: isRepeat }, remaining())
            this.modifiers = nextModifiers
            this.pressedKeys.add(key)
            return
        }

        if (isExt && this.inputMode === 'stealth') {
            await driver.stealthKey(key, 'down', this.getModifierNames(nextModifiers), remaining())
            this.modifiers = nextModifiers
            this.pressedKeys.add(key)
            return
        }

        const def = getKeyDefinition(key)
        await driver.inputKey(
            isRepeat ? 'rawKeyDown' : 'keyDown',
            {
                key: def.key,
                code: def.code,
                ...(commands && commands.length > 0 ? {} : { text: def.text }),
                windowsVirtualKeyCode: def.keyCode,
                modifiers: nextModifiers,
                commands,
                autoRepeat: isRepeat || undefined,
            },
            remaining()
        )
        this.modifiers = nextModifiers
        this.pressedKeys.add(key)
    }

    /**
     * 释放键盘按键
     */
    async keyUp(key: string, timeout?: number, inputContext?: { targetId: string; frameId?: number }): Promise<void> {
        const deadline = timeout === undefined ? undefined : Date.now() + timeout
        const driver = await this.getDriver(timeout)
        const remaining = () => (deadline === undefined ? undefined : remainingNavigationTimeout(deadline))
        const isExt = this.isExtensionConnected()
        const nextModifiers = MODIFIER_KEYS[key] ? this.modifiers & ~MODIFIER_KEYS[key] : this.modifiers

        if (!isExt) {
            if (inputContext) {
                await getCdpSession().keyUp(key, remaining(), { ...inputContext, modifiers: nextModifiers })
            } else {
                await getCdpSession().keyUp(key, remaining())
            }
        } else if (this.inputMode === 'stealth') {
            await driver.stealthKey(key, 'up', this.getModifierNames(nextModifiers), remaining())
        } else {
            const def = getKeyDefinition(key)
            await driver.inputKey(
                'keyUp',
                {
                    key: def.key,
                    code: def.code,
                    windowsVirtualKeyCode: def.keyCode,
                    modifiers: nextModifiers,
                },
                remaining()
            )
        }
        this.modifiers = nextModifiers
        this.pressedKeys.delete(key)
        this.tabLockContext.getStore()?.inputKeys?.delete(key)
    }

    /**
     * 输入文本
     */
    async typeText(text: string, delay = 0, timeout?: number): Promise<void> {
        const startedAt = Date.now()
        const driver = await this.getDriver()
        const remaining = timeout === undefined ? undefined : Math.max(0, timeout - (Date.now() - startedAt))
        const isExt = this.isExtensionConnected()
        if (isExt && this.inputMode === 'stealth') {
            await driver.stealthType(text, delay, remaining)
        } else {
            await driver.inputType(text, delay, remaining)
        }
    }

    /**
     * 鼠标移动
     */
    async mouseMove(x: number, y: number, timeout?: number): Promise<void> {
        const startedAt = Date.now()
        const driver = await this.getDriver(timeout)
        const remaining = timeout === undefined ? undefined : timeout - (Date.now() - startedAt)
        if (remaining !== undefined && remaining <= 0) {
            throw new TimeoutError('input timeout before mouse movement')
        }
        const isExt = this.isExtensionConnected()
        if (!isExt) {
            ;({ x, y } = await getCdpSession().mapFramePoint({ x, y }, remaining))
        }
        if (isExt && this.inputMode === 'stealth') {
            await driver.stealthMouse('mousemove', x, y, undefined, remaining, this.modifiers)
        } else {
            await driver.inputMouse('mouseMoved', x, y, { modifiers: this.modifiers }, remaining)
        }
        this.currentMousePosition = { x, y }
        this.rememberMouseFrame()
    }

    /**
     * 鼠标按下
     */
    async mouseDown(button: 'left' | 'middle' | 'right' | 'back' | 'forward' = 'left', clickCount = 1): Promise<void> {
        return this.withMouseFrame(async () => {
            const { x, y } = this.currentMousePosition
            const driver = await this.getDriver()
            const isExt = this.isExtensionConnected()
            if (isExt && this.inputMode === 'stealth') {
                await driver.stealthMouse('mousedown', x, y, button, undefined, this.modifiers)
            } else {
                await driver.inputMouse('mousePressed', x, y, {
                    button,
                    clickCount,
                    modifiers: this.modifiers,
                })
            }
        })
    }

    /**
     * 鼠标释放
     */
    async mouseUp(button: 'left' | 'middle' | 'right' | 'back' | 'forward' = 'left', clickCount = 1): Promise<void> {
        return this.withMouseFrame(async () => {
            const { x, y } = this.currentMousePosition
            const driver = await this.getDriver()
            const isExt = this.isExtensionConnected()
            if (isExt && this.inputMode === 'stealth') {
                await driver.stealthMouse('mouseup', x, y, button, undefined, this.modifiers)
            } else {
                await driver.inputMouse('mouseReleased', x, y, {
                    button,
                    clickCount,
                    modifiers: this.modifiers,
                })
            }
        })
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
        return this.withMouseFrame(async () => {
            const driver = await this.getDriver()
            const isExt = this.isExtensionConnected()
            if (isExt && (this.inputMode === 'stealth' || button === 'right')) {
                const { x, y } = this.currentMousePosition
                // stealth 通过单次脚本注入完成所有 mouse/click/dblclick/contextmenu 事件
                // refId 透传：嵌套 iframe overlay 场景下绕过 elementFromPoint 命中外层 IFRAME 的问题
                await driver.stealthClick(x, y, button, clickCount, refId, undefined, this.modifiers)
                return
            }
            // CDP 每次 mousePressed/mouseReleased 递增 clickCount，让浏览器合成 dblclick/tripleclick
            for (let i = 1; i <= clickCount; i++) {
                let pressRejected = false
                try {
                    await this.mouseDown(button, i)
                } catch (error) {
                    pressRejected = error instanceof StructuredToolError && error.context.actionExecuted === false
                    throw error
                } finally {
                    if (!pressRejected) {
                        const { x, y } = this.currentMousePosition
                        await driver.inputMouse('mouseReleased', x, y, {
                            button,
                            clickCount: i,
                            modifiers: this.modifiers,
                        })
                    }
                }
            }
        })
    }

    /**
     * Turnstile 点击：同页控件走页面鼠标；Cloudflare iframe 只在已聚焦窗口的活动受控 tab 上使用系统鼠标
     */
    // noinspection JSUnusedGlobalSymbols — resolveChallenge 通过 ChallengeHost 结构类型调用
    async clickTurnstile(
        snapshot: TurnstileOsClickInput,
        timeout?: number,
        signal?: AbortSignal,
        refreshSnapshot?: (timeout?: number) => Promise<TurnstileOsClickInput>
    ): Promise<void> {
        const scope = this.tabLockContext.getStore()
        signal ??= scope?.signal
        signal?.throwIfAborted()
        const deadline =
            timeout === undefined ? scope?.deadline : Math.min(Date.now() + timeout, scope?.deadline ?? Infinity)
        const remaining = () => {
            signal?.throwIfAborted()
            return deadline === undefined ? undefined : remainingNavigationTimeout(deadline)
        }
        if (snapshot.clickSource !== 'iframe') {
            const point = snapshot.clickPoint
            if (!point) {
                throw new OsMouseError(
                    'TURNSTILE_OS_CLICK_UNAVAILABLE',
                    '页面未返回可点击的 Turnstile 坐标',
                    '重新检查页面状态后再重试；交互式验证码无法自动完成'
                )
            }
            const driver = await withNavigationBudget(() => this.getDriver(remaining()), deadline, signal)
            if (this.isExtensionConnected()) {
                await withNavigationBudget(
                    () => driver.stealthClick(point.x, point.y, 'left', 1, undefined, remaining()),
                    deadline,
                    signal
                )
                return
            }
            const clickPoint = await withNavigationBudget(
                () => getCdpSession().mapFramePoint(point, remaining()),
                deadline,
                signal
            )
            this.currentMousePosition = clickPoint
            await withNavigationBudget(
                () => driver.inputMouse('mouseMoved', clickPoint.x, clickPoint.y, { modifiers: this.modifiers }),
                deadline,
                signal
            )
            await withNavigationBudget(
                () =>
                    getCdpSession().inputMouse(
                        'mousePressed',
                        clickPoint.x,
                        clickPoint.y,
                        {
                            button: 'left',
                            clickCount: 1,
                            modifiers: this.modifiers,
                            releaseAfterPress: true,
                        },
                        remaining()
                    ),
                deadline,
                signal
            )
            return
        }
        if (this.getMode() !== 'extension' || !this.extensionBridge) {
            throw new OsMouseError(
                'TURNSTILE_OS_CLICK_UNAVAILABLE',
                'Cloudflare iframe 需要 Extension 模式下的系统鼠标点击',
                '先确认 Chrome Extension 已连接，把受控测试页放到已经聚焦的窗口并保持该 tab 为活动页后重试；混合窗口不会调用 focusWindow',
                { mode: this.getMode() }
            )
        }
        const targetId = this.getCurrentTargetId()
        if (!targetId) {
            throw new OsMouseError(
                'TURNSTILE_OS_CLICK_UNAVAILABLE',
                '没有当前受控页面，无法使用系统鼠标点击 Turnstile',
                '先 browse attach 到受控测试页，把该页放到已经聚焦的窗口并保持为活动 tab 后重试'
            )
        }
        const topology = await withNavigationBudget(() => this.listTopology(remaining()), deadline, signal)
        const windowInfo = topology?.windows.find((item) =>
            item.tabs.some((tab) => String(tab.id) === targetId || tab.targetId === targetId)
        )
        const tab = windowInfo?.tabs.find((item) => String(item.id) === targetId || item.targetId === targetId)
        if (!windowInfo || !tab) {
            throw new OsMouseError(
                'TURNSTILE_OS_CLICK_UNAVAILABLE',
                '找不到当前受控页面所在窗口，无法使用系统鼠标点击 Turnstile',
                '先 browse list 确认受控测试页仍在，再把它放到已经聚焦的窗口后重试'
            )
        }
        if (tab.managed !== true) {
            throw new OsMouseError(
                'TURNSTILE_OS_CLICK_UNAVAILABLE',
                '当前页面不是受控测试页，拒绝系统鼠标点击',
                '只对 assistant 创建或 adopt 的受控测试页使用 Turnstile 系统鼠标'
            )
        }
        if (!windowInfo.focused) {
            throw new OsMouseError(
                'TURNSTILE_OS_CLICK_UNAVAILABLE',
                '当前窗口未聚焦，拒绝系统鼠标点击',
                '把受控测试页放到已经聚焦的窗口并保持该 tab 为活动页后重试；混合窗口不会调用 focusWindow'
            )
        }
        const activeTabId = windowInfo.activeTabId
        if (tab.active !== true && (activeTabId === undefined || String(activeTabId) !== targetId)) {
            throw new OsMouseError(
                'TURNSTILE_OS_CLICK_UNAVAILABLE',
                '受控测试页不是当前窗口的活动 tab，拒绝系统鼠标点击',
                '先把受控测试页设为该窗口的活动 tab，且窗口已经聚焦后再重试'
            )
        }
        await withNavigationBudget(() => this.extensionBridge!.debuggerDetach(undefined, remaining()), deadline, signal)
        const pointerId = process.platform === 'linux' ? randomUUID() : undefined
        let pointerDocumentId: string | undefined
        const resolvePoint = async (refresh: boolean, probe?: NativePointerProbe) => {
            const current =
                refresh && refreshSnapshot
                    ? await withNavigationBudget(() => refreshSnapshot(remaining()), deadline, signal)
                    : snapshot
            if (
                !current.clickPoint ||
                current.clickSource !== 'iframe' ||
                current.clickTargetKind !== snapshot.clickTargetKind ||
                current.url !== snapshot.url
            ) {
                throw new OsMouseError(
                    'TURNSTILE_OS_CLICK_UNAVAILABLE',
                    '系统鼠标按下前，页面或验证控件已变化',
                    '重新检查页面验证状态后再重试'
                )
            }
            const viewport = await withNavigationBudget(() => this.readViewportMetrics(0), deadline, signal)
            const refreshedTopology = await withNavigationBudget(() => this.listTopology(remaining()), deadline, signal)
            const refreshedWindow = refreshedTopology?.windows.find((item) =>
                item.tabs.some((candidate) => String(candidate.id) === targetId || candidate.targetId === targetId)
            )
            const refreshedTab = refreshedWindow?.tabs.find(
                (candidate) => String(candidate.id) === targetId || candidate.targetId === targetId
            )
            const refreshedActiveTabId = refreshedWindow?.activeTabId
            if (
                !refreshedWindow?.focused ||
                refreshedTab?.managed !== true ||
                (refreshedTab.active !== true &&
                    (refreshedActiveTabId === undefined || String(refreshedActiveTabId) !== targetId))
            ) {
                throw new OsMouseError(
                    'TURNSTILE_OS_CLICK_UNAVAILABLE',
                    '系统鼠标点击前，受控测试页的窗口或活动 tab 已变化',
                    '重新聚焦受控测试页并保持为活动 tab 后重试'
                )
            }
            const frameOffset = this.currentFrameOffset
            const clickPoint = frameOffset
                ? { x: current.clickPoint.x + frameOffset.x, y: current.clickPoint.y + frameOffset.y }
                : current.clickPoint
            const estimate = await withNavigationBudget(
                () =>
                    resolveTurnstileOsClickPoint(
                        { ...current, clickPoint, screenPoint: null, viewport },
                        { deadline, signal }
                    ),
                deadline,
                signal
            )
            if (!pointerId || !probe) {
                return estimate
            }
            const request = await probe()
            const origin = (await withNavigationBudget(
                () =>
                    this.extensionBridge!.getViewportMetrics(
                        0,
                        { operation: 'read', id: pointerId, documentId: pointerDocumentId, ...request },
                        remaining()
                    ),
                deadline,
                signal
            )) as { x?: number; y?: number }
            if (
                typeof origin.x !== 'number' ||
                !Number.isFinite(origin.x) ||
                typeof origin.y !== 'number' ||
                !Number.isFinite(origin.y)
            ) {
                throw new OsMouseError(
                    'TURNSTILE_OS_CLICK_UNAVAILABLE',
                    '未取得可信原生指针原点',
                    '重新检查当前受控页面'
                )
            }
            return {
                x: Math.round(origin.x + clickPoint.x * viewport.devicePixelRatio),
                y: Math.round(origin.y + clickPoint.y * viewport.devicePixelRatio),
            }
        }
        let clickError: { error: unknown } | undefined
        try {
            if (pointerId) {
                const started = (await withNavigationBudget(
                    () =>
                        this.extensionBridge!.getViewportMetrics(0, { operation: 'start', id: pointerId }, remaining()),
                    deadline,
                    signal
                )) as { documentId?: string }
                pointerDocumentId = started.documentId
                if (!pointerDocumentId) {
                    throw new OsMouseError(
                        'TURNSTILE_OS_CLICK_UNAVAILABLE',
                        '原生指针观察器未取得文档身份',
                        '重新检查当前受控页面'
                    )
                }
            }
            const screen = await resolvePoint(false)
            // 请求取消后仍须等待必要的鼠标释放完成，再结束 tab 锁
            await osLeftClick(screen.x, screen.y, {
                deadline,
                signal,
                refreshPoint: (probe) => resolvePoint(true, probe),
            })
        } catch (error) {
            clickError = { error }
        }
        if (pointerId) {
            try {
                await this.tabLockContext.run(
                    {
                        ...scope,
                        session: this,
                        signal: undefined,
                        deadline: Date.now() + 5000,
                        budgetError: undefined,
                        userAction: undefined,
                        pendingPageCondition: null,
                        keyboardFocus: undefined,
                        inputCleanup: undefined,
                    },
                    () => this.extensionBridge!.getViewportMetrics(0, { operation: 'stop', id: pointerId }, 5000)
                )
            } catch (error) {
                console.warn('[MCP] Native pointer observer cleanup failed:', error)
                if (clickError?.error instanceof Error) {
                    Object.assign(clickError.error, { pointerCleanupError: error })
                }
                clickError ??= { error }
            }
        }
        if (clickError) {
            throw clickError.error
        }
    }

    // noinspection JSUnusedGlobalSymbols — resolveChallenge 通过 ChallengeHost 结构类型调用
    async inspectChallenge(
        options: {
            challengeSelectors: string[]
            deniedSelectors: string[]
            widgetSelectors: string[]
            verifyButtonSelectors: string[]
            frameSelectors: string[]
            titleNeedles: string[]
            textMarkers: string[]
            originResponsePendingTextMarkers: string[]
        },
        timeout?: number
    ): Promise<unknown> {
        if (this.getMode() !== 'extension' || !this.extensionBridge) {
            throw new Error('challenge_inspect 仅在 Extension 模式可用')
        }
        const deadline = timeout === undefined ? undefined : Date.now() + timeout
        const state = await withNavigationBudget(() => this.getLiveState(), deadline)
        const title = (state?.title ?? '').trim().toLowerCase().replace(/…/g, '...')
        const challengeTitle = options.titleNeedles.some((needle) => title.includes(needle.toLowerCase()))
        const detach = () =>
            withNavigationBudget(
                () =>
                    this.extensionBridge!.debuggerDetach(
                        undefined,
                        deadline === undefined ? undefined : remainingNavigationTimeout(deadline)
                    ),
                deadline
            )
        if (challengeTitle) {
            await detach()
        }
        const snapshot = await this.extensionBridge.inspectChallenge(
            options,
            deadline === undefined ? undefined : remainingNavigationTimeout(deadline)
        )
        if (!challengeTitle && snapshot && typeof snapshot === 'object') {
            const evidence = snapshot as {
                turnstilePresent?: boolean
                originResponsePending?: boolean
                selectorHits?: string[]
                textHits?: string[]
            }
            if (
                evidence.turnstilePresent ||
                (!evidence.originResponsePending &&
                    ((evidence.selectorHits?.length ?? 0) > 0 || (evidence.textHits?.length ?? 0) > 0))
            ) {
                await detach()
            }
        }
        return snapshot
    }

    /**
     * 鼠标滚轮
     */
    async mouseWheel(
        deltaX: number,
        deltaY: number,
        timeout?: number,
        point?: { x: number; y: number }
    ): Promise<void> {
        this.assertRequestActive()
        const deadline = timeout === undefined ? undefined : Date.now() + timeout
        const remaining = () => (deadline === undefined ? undefined : remainingNavigationTimeout(deadline))
        const driver = await this.getDriver(remaining())
        this.assertRequestActive()
        const { x, y } = point ?? this.currentMousePosition
        const dispatch = () =>
            driver.inputMouse('mouseWheel', x, y, { deltaX, deltaY, modifiers: this.modifiers }, remaining())
        if (point) {
            await dispatch()
        } else {
            await this.withMouseFrame(dispatch)
        }
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

    async getNetworkRequests(options: { urlPattern?: string; clear?: boolean } = {}): Promise<
        Array<{
            url: string
            method: string
            status?: number
            type: string
            timestamp: number
            duration?: number
            errorText?: string
            sequence?: number
            challenge?: boolean
        }>
    > {
        return (await this.getDriver()).getNetworkRequests(options)
    }

    // noinspection JSUnusedGlobalSymbols — resolveChallenge 通过 ChallengeHost 结构类型调用
    async getChallengeState(): Promise<ChallengeState | null> {
        const mode = this.getMode()
        if (mode === 'none') {
            return null
        }
        const extensionBundleHash = this.extensionBridge?.getConnectionInfo().extensionBackgroundBundleHash ?? null
        if (mode === 'extension' && this.extensionChallengeStateUnsupported) {
            if (this.unsupportedChallengeStateBundleHash === extensionBundleHash) {
                return null
            }
            this.extensionChallengeStateUnsupported = false
        }
        try {
            const challengeRequired = await (await this.getDriver()).getChallengeState()
            return challengeRequired ? { state: 'pending', mode } : null
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const errorCode =
                error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
            if (
                mode === 'extension' &&
                (errorCode === 'UNKNOWN_ACTION' || message.includes('Unknown action: network_challenge_state'))
            ) {
                this.extensionChallengeStateUnsupported = true
                this.unsupportedChallengeStateBundleHash = extensionBundleHash
                console.warn('[MCP] Extension 未实现 network_challenge_state，改用页面标题和 DOM 检测 Cloudflare')
                return null
            }
            throw error
        }
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

    private extensionReadBridge(): ExtensionBridge {
        if (this.getMode() !== 'extension' || !this.extensionBridge?.isConnected()) {
            throw new DriverCapabilityError('定向读取需要已连接的 Extension')
        }
        return this.extensionBridge
    }

    private metadataKey(targetId: string): string {
        return `${this.getMode()}:${targetId}`
    }

    private rememberPageMetadata(targetId: string, metadata: PageMetadata): void {
        const lastUsedAt = this.getPageMetadata(targetId).lastUsedAt
        this.pageMetadata.set(this.metadataKey(targetId), {
            ...metadata,
            lastUsedAt: lastUsedAt && lastUsedAt > (metadata.lastUsedAt ?? '') ? lastUsedAt : metadata.lastUsedAt,
        })
    }

    private recordPageUse(targetId: string, created = false): void {
        const metadata = this.getPageMetadata(targetId)
        this.pageMetadata.set(this.metadataKey(targetId), {
            ...metadata,
            origin: created ? 'created' : metadata.origin,
            createdBy: created ? 'mcp-chrome' : metadata.createdBy,
            createdAt: created ? new Date().toISOString() : metadata.createdAt,
            lastUsedAt: new Date().toISOString(),
        })
    }

    private evaluateViaCdp<T>(
        script: string,
        args: unknown[] | undefined,
        timeout: number | undefined,
        options: EvaluateOptions
    ): Promise<T> {
        const session = getCdpSession()
        if (session.getCurrentFrameId() !== 0 && options.staleContextRetry === 'readOnly') {
            return Promise.reject(
                new StructuredToolError(
                    'DRIVER_CAPABILITY_ERROR',
                    'CDP iframe 暂不支持 readOnly context 重试，脚本未执行',
                    '使用 Extension precise 执行无副作用脚本，或显式使用 never 并独立核对结果',
                    { actionExecuted: false, actionStatus: 'not_started', failureStage: 'context', retryable: false }
                )
            )
        }
        return session.evaluate<T>(script, args, timeout, options.userAction)
    }

    private async evaluateViaExtensionPrecise<T>(
        code: string,
        expression: string,
        args: unknown[] | undefined,
        timeout?: number,
        options: EvaluateOptions = {}
    ): Promise<T> {
        const hasArgs = args !== undefined
        const currentFrameId = this.extensionBridge!.getCurrentFrameId()
        const staleContextRetry = options.staleContextRetry ?? 'never'

        // precise + args + 主 frame：使用 callFunctionOn 避免大 payload 字符串拼接
        if (hasArgs && currentFrameId === 0) {
            return this.callFunctionOn<T>(code, args!, timeout, options)
        }

        if (currentFrameId !== 0) {
            // iframe：args 仍用字符串拼接（evaluateInFrame 使用 expression 字符串）
            let iframeExpression = expression
            if (hasArgs) {
                const argsStr = args!.map((a) => JSON.stringify(a)).join(', ')
                iframeExpression = `(${code})(${argsStr})`
            }
            const result = (await this.extensionBridge!.evaluateInFrame(
                currentFrameId,
                iframeExpression,
                timeout,
                staleContextRetry,
                options.userAction
            )) as {
                result?: CdpResultObject<T>
                exceptionDetails?: { text: string; exception?: { className?: string; description?: string } }
                retryAttempted?: boolean
                retryReason?: string
                staleContextRetry?: StaleContextRetryPolicy
                frameContext?: Record<string, unknown>
            }
            if (result.frameContext) {
                this.lastEvaluationMetadata = {
                    retryAttempted: result.retryAttempted === true,
                    retryReason: result.retryReason,
                    staleContextRetry: result.staleContextRetry ?? staleContextRetry,
                    frameContext: result.frameContext,
                }
            }
            return this.checkCdpResult<T>(result)
        }

        const params: Record<string, unknown> = {
            expression,
            returnByValue: false,
            awaitPromise: true,
        }
        if (timeout !== undefined) {
            params.timeout = timeout
        }
        const result = (await this.extensionBridge!.debuggerSend(
            'Runtime.evaluate',
            params,
            undefined,
            timeout,
            options.userAction
        )) as {
            result?: CdpResultObject<T>
            exceptionDetails?: { text: string; exception?: { className?: string; description?: string } }
        }
        if (result.exceptionDetails) {
            throw setErrorSource(new Error(formatCdpException(result.exceptionDetails)), 'page')
        }
        return this.materializeCdpResult<T>(result.result, timeout, options.fileOutput)
    }

    private async evaluateViaExtensionStealth<T>(
        expression: string,
        timeout?: number,
        userAction?: UserActionKind
    ): Promise<T> {
        return (await this.extensionBridge!.evaluate(expression, undefined, timeout, userAction)) as T
    }

    private async readViewportMetrics(frameId?: number): Promise<ViewportMetrics> {
        let raw: unknown
        try {
            raw = await this.extensionBridge!.getViewportMetrics(frameId)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw new OsMouseError(
                'TURNSTILE_OS_CLICK_UNAVAILABLE',
                `卸掉 debugger 后无法读取视口: ${message}`,
                '把受控测试页放到已经聚焦的窗口并保持该 tab 为活动页后重试；混合窗口不会调用 focusWindow'
            )
        }
        const viewport = asViewportMetrics(raw)
        if (!viewport) {
            throw new OsMouseError(
                'TURNSTILE_OS_CLICK_UNAVAILABLE',
                '卸掉 debugger 后读到的视口无效',
                '把受控测试页放到已经聚焦的窗口并保持该 tab 为活动页后重试；混合窗口不会调用 focusWindow'
            )
        }
        return viewport
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
            if (
                !isNativeExecutionResultUnknown(err) &&
                (isExtensionDisconnected(err) || msg.includes('not connected'))
            ) {
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
            throw setErrorSource(new Error(formatCdpException(result.exceptionDetails)), 'page')
        }
        return extractCdpValue<T>(result.result)
    }

    private async materializeCdpResult<T>(
        result: CdpResultObject<T> | undefined,
        timeout?: number,
        fileOutput = false
    ): Promise<T> {
        if (!result?.objectId) {
            return extractCdpValue<T>(result)
        }
        try {
            return await this.materializeRemoteObject<T>(
                result,
                timeout,
                {
                    seen: new Set(),
                    nodes: 0,
                    chars: 0,
                    maxChars: fileOutput
                        ? UnifiedSessionManager.CDP_MATERIALIZE_MAX_FILE_CHARS
                        : UnifiedSessionManager.CDP_MATERIALIZE_MAX_CHARS,
                },
                0
            )
        } finally {
            this.extensionBridge!.debuggerSend('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {})
        }
    }

    private async materializeRemoteObject<T>(
        result: CdpResultObject,
        timeout: number | undefined,
        state: CdpMaterializeState,
        depth: number
    ): Promise<T> {
        if (!result.objectId) {
            return this.trackMaterializedValue(extractCdpValue<T>(result as CdpResultObject<T>), state, depth)
        }
        if (isKnownNonSerializableRemoteObject(result) || state.seen.has(result.objectId)) {
            throw new NonSerializableEvaluateResultError(result)
        }

        this.trackMaterializedNode(result, state, depth)
        state.seen.add(result.objectId)
        try {
            const properties = (await this.extensionBridge!.debuggerSend(
                'Runtime.getProperties',
                {
                    objectId: result.objectId,
                    ownProperties: true,
                    accessorPropertiesOnly: false,
                    generatePreview: false,
                },
                undefined,
                timeout
            )) as {
                result?: CdpPropertyDescriptor[]
                exceptionDetails?: { text: string; exception?: { className?: string; description?: string } }
            }
            if (properties.exceptionDetails) {
                throw setErrorSource(new Error(formatCdpException(properties.exceptionDetails)), 'page')
            }

            const descriptors = properties.result ?? []
            state.nodes += descriptors.length
            this.assertMaterializeBudget(state, depth, result)

            if (result.subtype === 'array') {
                const length = descriptors.find((descriptor) => descriptor.name === 'length')?.value?.value
                if (
                    typeof length !== 'number' ||
                    !Number.isInteger(length) ||
                    length < 0 ||
                    length > UnifiedSessionManager.CDP_MATERIALIZE_MAX_NODES
                ) {
                    this.throwMaterializeLimit(state, depth, result)
                }
                const populated = descriptors.filter(
                    (descriptor) =>
                        /^\d+$/.test(descriptor.name) &&
                        Number(descriptor.name) < (length as number) &&
                        descriptor.value
                ).length
                const holes = (length as number) - populated
                state.nodes += holes
                state.chars += holes * 5
                this.assertMaterializeBudget(state, depth, result)
                const array: unknown[] = new Array(length as number)
                for (const descriptor of descriptors) {
                    if (!descriptor.value || !/^\d+$/.test(descriptor.name)) {
                        continue
                    }
                    const index = Number(descriptor.name)
                    if (index >= UnifiedSessionManager.CDP_MATERIALIZE_MAX_NODES) {
                        this.throwMaterializeLimit(state, depth, result)
                    }
                    this.trackMaterializedPropertyName(descriptor.name, state, depth, result)
                    array[index] = await this.materializePropertyValue(descriptor.value, timeout, state, depth + 1)
                }
                return array as T
            }

            const object: Record<string, unknown> = {}
            for (const descriptor of descriptors) {
                if (!descriptor.enumerable || descriptor.wasThrown || !descriptor.value) {
                    continue
                }
                this.trackMaterializedPropertyName(descriptor.name, state, depth, result)
                Object.defineProperty(object, descriptor.name, {
                    value: await this.materializePropertyValue(descriptor.value, timeout, state, depth + 1),
                    enumerable: true,
                    configurable: true,
                    writable: true,
                })
            }
            return object as T
        } finally {
            state.seen.delete(result.objectId)
        }
    }

    private async materializePropertyValue(
        value: CdpResultObject,
        timeout: number | undefined,
        state: CdpMaterializeState,
        depth: number
    ): Promise<unknown> {
        if (!value.objectId) {
            return this.trackMaterializedValue(extractCdpValue(value), state, depth)
        }
        try {
            return await this.materializeRemoteObject(value, timeout, state, depth)
        } finally {
            this.extensionBridge!.debuggerSend('Runtime.releaseObject', { objectId: value.objectId }).catch(() => {})
        }
    }

    private trackMaterializedNode(result: CdpResultObject, state: CdpMaterializeState, depth: number): void {
        state.nodes += 1
        state.chars += result.description?.length ?? 0
        this.assertMaterializeBudget(state, depth, result)
    }

    private trackMaterializedPropertyName(
        name: string,
        state: CdpMaterializeState,
        depth: number,
        result: CdpResultObject
    ): void {
        state.chars += name.length
        this.assertMaterializeBudget(state, depth, result)
    }

    private trackMaterializedValue<T>(value: T, state: CdpMaterializeState, depth: number): T {
        state.nodes += 1
        state.chars += this.estimateSerializedLength(value)
        this.assertMaterializeBudget(state, depth)
        return value
    }

    private estimateSerializedLength(value: unknown): number {
        if (value === undefined) {
            return 'undefined'.length
        }
        try {
            return JSON.stringify(value)?.length ?? String(value).length
        } catch {
            return String(value).length
        }
    }

    private assertMaterializeBudget(state: CdpMaterializeState, depth: number, result?: CdpResultObject): void {
        if (
            depth > UnifiedSessionManager.CDP_MATERIALIZE_MAX_DEPTH ||
            state.nodes > UnifiedSessionManager.CDP_MATERIALIZE_MAX_NODES ||
            state.chars > state.maxChars
        ) {
            this.throwMaterializeLimit(state, depth, result)
        }
    }

    private throwMaterializeLimit(state: CdpMaterializeState, depth: number, result?: CdpResultObject): never {
        const exceeded =
            depth > UnifiedSessionManager.CDP_MATERIALIZE_MAX_DEPTH
                ? 'depth'
                : state.nodes > UnifiedSessionManager.CDP_MATERIALIZE_MAX_NODES
                  ? 'nodes'
                  : 'chars'
        throw new EvaluateResultTooLargeError({
            exceeded,
            depth,
            nodes: state.nodes,
            chars: state.chars,
            maxDepth: UnifiedSessionManager.CDP_MATERIALIZE_MAX_DEPTH,
            maxNodes: UnifiedSessionManager.CDP_MATERIALIZE_MAX_NODES,
            maxChars: state.maxChars,
            type: result?.type,
            subtype: result?.subtype,
            className: result?.className,
            description: result?.description?.slice(0, 200),
        })
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
        this.assertRequestActive()
        const scopedMode = this.tabLockContext.getStore()?.mode
        if (scopedMode === 'extension') {
            if (!this.extensionBridge?.isConnected()) {
                throw new DriverCapabilityError('Extension 已断开，当前请求保留原后端，未改用 CDP')
            }
            return this.extensionBridge
        }
        if (scopedMode === 'cdp') {
            if (!getCdpSession().isConnected()) {
                throw new DriverCapabilityError('CDP 已断开，当前请求保留原后端，未改用 Extension')
            }
            return getCdpSession()
        }
        if (this.activeMode === 'cdp' && this.cdpExplicitlySelected && getCdpSession().isConnected()) {
            this.assertCdpFallbackAllowed()
            return getCdpSession()
        }
        if (await this.ensureExtensionConnected(timeout)) {
            this.activeMode = 'extension'
            this.cdpExplicitlySelected = false
            return this.extensionBridge!
        }
        this.activeMode = 'cdp'
        this.cdpExplicitlySelected = false
        return getCdpSession()
    }

    private async ensureExtensionConnected(maxWait?: number): Promise<boolean> {
        this.assertRequestActive()
        if (!this.extensionBridge) {
            return this.assertCdpFallbackAllowed()
        }
        if (this.activeMode === 'cdp' && this.cdpExplicitlySelected && getCdpSession().isConnected()) {
            return this.assertCdpFallbackAllowed()
        }
        if (this.extensionBridge.isConnected()) {
            this.activeMode = 'extension'
            this.cdpExplicitlySelected = false
            return true
        }
        // CDP 已连接时跳过 Extension 等待，直接使用 CDP 回退
        if (getCdpSession().isConnected()) {
            this.activeMode = 'cdp'
            this.cdpExplicitlySelected = false
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
        const scope = this.tabLockContext.getStore()
        const connected = await withNavigationBudget(
            () => this.extensionBridge!.waitForConnection(waitTimeout),
            scope?.deadline,
            scope?.signal
        )
        this.assertRequestActive()
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
    private async callFunctionOn<T>(
        code: string,
        args: unknown[],
        timeout?: number,
        options: EvaluateOptions = {}
    ): Promise<T> {
        const buildFallbackExpression = () => `(${code})(${args.map((a) => JSON.stringify(a)).join(', ')})`
        const globalResult = (await this.extensionBridge!.debuggerSend(
            'Runtime.evaluate',
            {
                expression: 'globalThis',
                returnByValue: false,
            },
            undefined,
            timeout
        )) as { result?: CdpResultObject }
        const globalObjectId = globalResult.result?.objectId
        if (!globalObjectId) {
            console.warn('[MCP] Runtime.evaluate 未返回 globalThis objectId，改用表达式传递 evaluate args')
            const fallbackExpression = buildFallbackExpression()
            return this.evaluateViaExtensionPrecise<T>(
                fallbackExpression,
                fallbackExpression,
                undefined,
                timeout,
                options
            )
        }

        try {
            const params: Record<string, unknown> = {
                functionDeclaration: code,
                objectId: globalObjectId,
                arguments: args.map((a) => ({ value: a })),
                returnByValue: false,
                awaitPromise: true,
            }
            if (timeout !== undefined) {
                params.timeout = timeout
            }

            const result = (await this.extensionBridge!.debuggerSend(
                'Runtime.callFunctionOn',
                params,
                undefined,
                timeout,
                options.userAction
            )) as {
                result?: CdpResultObject<T>
                exceptionDetails?: { text: string; exception?: { className?: string; description?: string } }
            }

            if (result.exceptionDetails) {
                throw setErrorSource(new Error(formatCdpException(result.exceptionDetails)), 'page')
            }
            return await this.materializeCdpResult<T>(result.result, timeout, options.fileOutput)
        } finally {
            this.extensionBridge!.debuggerSend('Runtime.releaseObject', {
                objectId: globalObjectId,
            }).catch(() => {})
        }
    }

    private async withMouseFrame<T>(fn: () => Promise<T>): Promise<T> {
        const bridge = this.isExtensionConnected() ? this.extensionBridge : null
        const original =
            this.mouseFrameContext?.targetId === this.getCurrentTargetId() ? this.mouseFrameContext : undefined
        if (!bridge || !original) {
            return fn()
        }
        const frameId = bridge.getCurrentFrameId()
        const documentId = bridge.getCurrentFrameDocumentId()
        bridge.setCurrentFrameId(original.frameId, original.documentId)
        try {
            return await fn()
        } finally {
            bridge.setCurrentFrameId(frameId, documentId)
        }
    }

    private rememberMouseFrame(): void {
        const bridge = this.isExtensionConnected() ? this.extensionBridge : null
        const targetId = bridge?.getCurrentTargetId()
        this.mouseFrameContext =
            bridge && targetId
                ? {
                      targetId,
                      frameId: bridge.getCurrentFrameId(),
                      documentId: bridge.getCurrentFrameDocumentId(),
                  }
                : undefined
    }

    // ==================== Debugger 直接访问 ====================
}

/**
 * 获取统一会话管理器实例
 */
export function getUnifiedSession(): UnifiedSessionManager {
    return UnifiedSessionManager.getInstance()
}
