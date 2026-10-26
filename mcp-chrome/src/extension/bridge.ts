/**
 * Extension Bridge
 *
 * 封装与 Chrome Extension 的通信，提供与 CDP 类似的接口
 * 使用 HTTP + WebSocket 实现
 */

import {
    type ActionableClickResult,
    type BrowserTopology,
    type BrowserTabGroupInfo,
    type CookieFilter,
    DriverCapabilityError,
    type GroupManagementResult,
    type GroupPagesOptions,
    type IBrowserDriver,
    type ListedTarget,
    type ManagedPageResult,
    type MovePageOptions,
    type NewTabResult,
    type NewPageOptions,
    type NewWindowOptions,
    type PageManagementResult,
    type ResizeWindowOptions,
    type ScreenshotResult,
    type SetCookieParams,
    type StaleContextRetryPolicy,
    type UpdateGroupOptions,
    type UpdatePageOptions,
} from '../core/browser-driver.js'
import { creationError, StructuredToolError, TargetNotFoundError } from '../core/errors.js'
import { remainingNavigationTimeout } from '../core/utils.js'
import { type ConsoleLogEntry, DEFAULT_TIMEOUT, type NetworkRequestEntry } from '../core/types.js'
import { type ExtensionConnectionInfo, ExtensionHttpServer } from './http-server.js'

/** RPC 传输余量（毫秒）：给网络往返和 Extension 处理留出的额外时间 */
const RPC_MARGIN = 5000
const CONDITIONAL_ACTIONS = new Set([
    'tabs_close',
    'tabs_activate',
    'tabs_activate_managed',
    'tabs_adopt',
    'tabs_release',
    'tabs_read_access',
    'tabs_move',
    'tabs_reorder',
    'tabs_pin',
    'tabs_update',
    'navigate',
    'go_back',
    'go_forward',
    'reload',
    'click',
    'actionable_click',
    'dispatch_input',
    'drag_and_drop',
    'type',
    'scroll',
    'evaluate',
    'evaluate_in_frame',
    'debugger_send',
    'input_key',
    'input_mouse',
    'input_touch',
    'input_type',
    'stealth_click',
    'stealth_type',
    'stealth_key',
    'stealth_mouse',
    'stealth_inject',
])

interface SimplePageState {
    url: string
    title: string
    managed?: boolean
}

interface ExtensionTabSummary extends Omit<ListedTarget, 'id'> {
    id: number
}

interface ExtensionGroupChangeResult extends Omit<GroupManagementResult, 'tabsBefore' | 'tabsAfter'> {
    tabsBefore: ExtensionTabSummary[]
    tabsAfter: ExtensionTabSummary[]
}

interface ExtensionManagedPageResult {
    success: boolean
    tab: ExtensionTabSummary
    managedBefore: boolean
    managedAfter: boolean
    warnings?: string[]
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
    private pendingPageCondition: { targetId: string; expectedUrl?: string; expectedRevision?: string } | null = null

    constructor(options: ExtensionBridgeOptions = {}) {
        this.httpServer = new ExtensionHttpServer({
            port: options.port,
            autoPort: true,
        })
        this.httpServer.setActionConditionProvider((action, params) => {
            const condition = this.pendingPageCondition
            if (!condition || !CONDITIONAL_ACTIONS.has(action)) {
                return undefined
            }
            const tabId = (params as { tabId?: number } | null)?.tabId
            if (tabId === undefined || String(tabId) !== condition.targetId) {
                throw new DriverCapabilityError('条件动作的目标与请求目标不一致，未执行动作')
            }
            this.pendingPageCondition = null
            return {
                ...(condition.expectedUrl !== undefined ? { expectedUrl: condition.expectedUrl } : {}),
                ...(condition.expectedRevision !== undefined ? { expectedRevision: condition.expectedRevision } : {}),
            }
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

    getConnectionInfo(): ExtensionConnectionInfo {
        return this.httpServer.getConnectionInfo()
    }

    // ==================== Tab 操作 ====================

    async listTabs(timeout?: number): Promise<ExtensionTabSummary[]> {
        const result = await this.httpServer.sendCommand('tabs_list', {}, timeout)
        return result as ExtensionTabSummary[]
    }

    async listWindows(timeout?: number): Promise<BrowserTopology> {
        const result = await this.httpServer.sendCommand('tabs_topology', {}, timeout)
        const topology = result as BrowserTopology
        const windows = topology.windows.map((window) => ({
            ...window,
            tabs: window.tabs.map((tab) => ({
                ...tab,
                targetId: String(tab.id),
                type: tab.type ?? 'page',
            })),
        }))
        if (Object.hasOwn(topology, 'groups') && !Array.isArray(topology.groups)) {
            throw new Error('Extension tabs_topology 返回的 groups 必须是数组')
        }
        const groups = topology.groups?.map((group) => {
            if (!group || typeof group !== 'object') {
                throw new Error('Extension tabs_topology 返回了无效分组')
            }
            const summary = group as Partial<BrowserTabGroupInfo>
            if (!Object.hasOwn(summary, 'tabIds') && !Object.hasOwn(summary, 'targetIds')) {
                if (!Number.isSafeInteger(summary.id) || !Number.isSafeInteger(summary.windowId)) {
                    throw new Error('Extension tabs_topology 的旧版分组缺少有效 id 或 windowId')
                }
                const members = windows
                    .filter((window) => window.id === summary.windowId)
                    .flatMap((window) => window.tabs)
                    .filter((tab) => tab.groupId === summary.id)
                if (members.some((tab) => !Number.isSafeInteger(tab.id))) {
                    throw new Error('Extension tabs_topology 的分组成员包含无效 tab ID')
                }
                return {
                    ...group,
                    tabIds: members.map((tab) => tab.id as number),
                    targetIds: members.map((tab) => tab.targetId),
                    index: group.index ?? members[0]?.index,
                }
            }
            if (!Array.isArray(group.tabIds) || !Array.isArray(group.targetIds)) {
                throw new Error('Extension tabs_topology 的分组成员必须同时提供 tabIds 和 targetIds 数组')
            }
            return group
        })
        return { ...topology, windows, ...(groups === undefined ? {} : { groups }) }
    }

    /** IBrowserDriver 接口：列出所有 tab，统一为 ListedTarget 形式（id 字符串化以保持跨 driver 兼容） */
    async listTargets(timeout?: number): Promise<ListedTarget[]> {
        const tabs = await this.listTabs(timeout)
        return tabs.map((tab) => this.tabToTarget(tab))
    }

    async createTab(url?: string, timeout?: number, options: NewPageOptions = {}): Promise<ExtensionTabSummary> {
        const rpcTimeout = (timeout ?? 30000) + RPC_MARGIN
        const result = await this.httpServer
            .sendCommand(
                'tabs_create',
                {
                    url,
                    active: false,
                    ...options,
                    waitUntil: 'load',
                    timeout,
                },
                rpcTimeout
            )
            .catch((error: unknown) => {
                throw creationError(error, {
                    action: 'tabs_create',
                    createdTargetId: null,
                    managed: null,
                    actionExecuted: 'unknown',
                    actionStatus: 'unknown',
                    failureStage: 'rpc',
                })
            })
        const tab = result as ExtensionTabSummary
        // 自动切换到新创建的 tab，后续操作立即生效
        this.currentTabId = tab.id
        this.updateState(tab)
        return tab
    }

    /** IBrowserDriver 接口：新建页面（targetId 为字符串化的 chrome tab id） */
    async newPage(url?: string, timeout?: number, options?: NewPageOptions): Promise<NewTabResult> {
        const tab = await this.createTab(url, timeout, options)
        return {
            ...this.tabToTarget(tab),
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

    /** IBrowserDriver 接口：只能关闭明确指定的 tab */
    async closePage(targetId: string): Promise<PageManagementResult> {
        if (!targetId) {
            throw new DriverCapabilityError('closePage 需要显式 targetId，未关闭页面')
        }
        return this.closeTab(this.parseTargetId(targetId))
    }

    async setReadAccess(targetId: string, allow: boolean): Promise<Record<string, unknown>> {
        return (await this.httpServer.sendCommand('tabs_read_access', {
            tabId: this.parseTargetId(targetId),
            allow,
        })) as Record<string, unknown>
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
            ...(result.warnings?.length ? { warnings: result.warnings } : {}),
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

    async updatePage(targetId: string, options: UpdatePageOptions): Promise<PageManagementResult> {
        const tabId = this.parseTargetId(targetId)
        const result = (await this.httpServer.sendCommand('tabs_update', {
            tabId,
            ...options,
        })) as ExtensionPageChangeResult
        const after = result.after as ExtensionTabSummary | undefined
        if (this.currentTabId === tabId && after) {
            this.updateState(after)
        }
        return this.normalizePageChange(result)
    }

    async groupPages(targetIds: string[], options: GroupPagesOptions): Promise<GroupManagementResult> {
        const tabIds = targetIds.map((id) => this.parseTargetId(id))
        if (
            options.groupId !== undefined &&
            [options.windowId, options.title, options.color, options.collapsed].some((value) => value !== undefined)
        ) {
            throw new DriverCapabilityError(
                '加入已有分组仅接受页面列表与 groupId；修改分组请用 updateGroup/moveGroup，未执行'
            )
        }
        const result =
            options.groupId !== undefined
                ? await this.httpServer.sendCommand('tabgroup_add', { tabIds, groupId: options.groupId })
                : await this.httpServer.sendCommand('tabgroup_create', { tabIds, ...options })
        return this.normalizeGroupChange(result as ExtensionGroupChangeResult)
    }

    async ungroupPages(targetIds: string[]): Promise<GroupManagementResult> {
        const result = await this.httpServer.sendCommand('tabgroup_remove', {
            tabIds: targetIds.map((id) => this.parseTargetId(id)),
        })
        return this.normalizeGroupChange(result as ExtensionGroupChangeResult)
    }

    async updateGroup(groupId: number, options: UpdateGroupOptions): Promise<GroupManagementResult> {
        const result = await this.httpServer.sendCommand('tabgroup_update', { groupId, ...options })
        return this.normalizeGroupChange(result as ExtensionGroupChangeResult)
    }

    async moveGroup(
        groupId: number,
        options: Pick<MovePageOptions, 'windowId' | 'index'>
    ): Promise<GroupManagementResult> {
        const result = await this.httpServer.sendCommand('tabgroup_move', { groupId, ...options })
        return this.normalizeGroupChange(result as ExtensionGroupChangeResult)
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

    async updateWindow(windowId: number, options: ResizeWindowOptions): Promise<PageManagementResult> {
        const result = (await this.httpServer.sendCommand('window_update', {
            windowId,
            ...options,
        })) as ExtensionPageChangeResult
        return this.normalizePageChange(result)
    }

    async newWindow(options: NewWindowOptions): Promise<PageManagementResult> {
        const { targetId, ...properties } = options
        const tabId = targetId !== undefined ? this.parseTargetId(targetId) : undefined
        const result = (await this.httpServer
            .sendCommand('window_create', {
                ...properties,
                ...(tabId !== undefined ? { tabId } : {}),
            })
            .catch((error: unknown) => {
                throw creationError(error, {
                    action: 'window_create',
                    createdTargetId: null,
                    managed: null,
                    actionExecuted: 'unknown',
                    actionStatus: 'unknown',
                    failureStage: 'rpc',
                })
            })) as ExtensionPageChangeResult
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
    async selectPage(targetId: string, timeout?: number): Promise<void> {
        const tabId = this.parseTargetId(targetId)
        const deadline = timeout === undefined ? undefined : Date.now() + timeout
        const tabs = await this.listTabs(timeout)
        if (deadline !== undefined) {
            remainingNavigationTimeout(deadline)
        }
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

    async getPageSnapshot(
        targetId: string,
        timeout?: number
    ): Promise<{ targetId: string; url: string; revision: string | null; warning?: string }> {
        const tabId = this.parseTargetId(targetId)
        const deadline = timeout === undefined ? undefined : Date.now() + timeout
        try {
            return (await this.httpServer.sendCommand('page_snapshot', { tabId }, timeout)) as {
                targetId: string
                url: string
                revision: string
            }
        } catch (error) {
            if (error instanceof Error && error.message === 'Unknown action: page_snapshot') {
                const tabs = await this.listTabs(
                    deadline === undefined ? undefined : remainingNavigationTimeout(deadline)
                )
                if (deadline !== undefined) {
                    remainingNavigationTimeout(deadline)
                }
                const tab = tabs.find((item) => item.id === tabId)
                if (!tab) {
                    throw new TargetNotFoundError(targetId)
                }
                return {
                    targetId,
                    url: tab.url,
                    revision: null,
                    warning: '当前 Extension 不支持页面 revision 或原子页面条件，仅返回当前 URL',
                }
            }
            if (
                error instanceof Error &&
                (error.message === `No tab with id: ${tabId}` || error.message === `No tab with id: ${tabId}.`)
            ) {
                const missing = new TargetNotFoundError(targetId)
                missing.context.nativeMessage = error.message
                throw missing
            }
            throw error
        }
    }

    setPageCondition(condition: { targetId: string; expectedUrl?: string; expectedRevision?: string } | null): void {
        this.pendingPageCondition = condition
    }

    /** IBrowserDriver 接口：设置当前操作目标 ID */
    setCurrentTargetId(targetId: string | null): void {
        this.currentTabId = targetId !== null ? this.parseTargetId(targetId) : null
        if (targetId === null) {
            this.state = null
        }
    }

    async navigate(url: string, options?: { wait?: string; timeout?: number }): Promise<void> {
        const result = await this.sendBudgetedCommand(
            'navigate',
            {
                tabId: this.requireCurrentTabId(),
                url,
                waitUntil: options?.wait ?? 'load',
            },
            options?.timeout
        )
        const tab = result as ExtensionTabSummary
        this.currentTabId = tab.id
        this.updateState(tab)
    }

    // ==================== 导航操作 ====================

    async goBack(timeout?: number): Promise<{ url: string; title: string; navigated: boolean }> {
        const result = (await this.sendBudgetedCommand(
            'go_back',
            {
                tabId: this.requireCurrentTabId(),
                waitUntil: 'load',
            },
            timeout
        )) as { url: string; title: string; navigated: boolean }
        this.updateState(result)
        return result
    }

    async goForward(timeout?: number): Promise<{ url: string; title: string; navigated: boolean }> {
        const result = (await this.sendBudgetedCommand(
            'go_forward',
            {
                tabId: this.requireCurrentTabId(),
                waitUntil: 'load',
            },
            timeout
        )) as { url: string; title: string; navigated: boolean }
        this.updateState(result)
        return result
    }

    async reload(ignoreCache = false, waitUntil?: string, timeout?: number): Promise<void> {
        const result = await this.sendBudgetedCommand(
            'reload',
            {
                tabId: this.requireCurrentTabId(),
                ignoreCache,
                waitUntil: waitUntil ?? 'load',
            },
            timeout
        )
        this.updateState(result as ExtensionTabSummary)
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
        timeout?: number,
        point?: { x: number; y: number },
        matchIndex?: number
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
                point,
                matchIndex,
            },
            timeout
        )) as Array<{
            refId: string
            tag: string
            text: string
            rect: { x: number; y: number; width: number; height: number }
        }>
    }

    async getText(selector?: string, refId?: string): Promise<string> {
        const result = (await this.httpServer.sendCommand('get_text', {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId || undefined,
            selector,
            refId,
        })) as { text: string }
        return result.text
    }

    async getHtml(selector?: string, outer = true, refId?: string): Promise<string> {
        const result = (await this.httpServer.sendCommand('get_html', {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId || undefined,
            selector,
            outer,
            refId,
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

    async getChallengeState(): Promise<boolean> {
        const result = (await this.httpServer.sendCommand('network_challenge_state', {
            tabId: this.requireCurrentTabId(),
        })) as { challengeRequired: boolean }
        return result.challengeRequired
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
        outer = true,
        refId?: string
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
            refId,
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

    async debuggerDetach(tabId?: number, timeout = DEFAULT_TIMEOUT): Promise<void> {
        await this.sendBudgetedCommand(
            'debugger_detach',
            {
                tabId: tabId ?? this.requireCurrentTabId(),
            },
            timeout
        )
    }

    async getViewportMetrics(frameId?: number): Promise<unknown> {
        const selectedFrameId = frameId ?? this.currentFrameId
        return this.httpServer.sendCommand('viewport_metrics', {
            tabId: this.requireCurrentTabId(),
            frameId: selectedFrameId || undefined,
        })
    }

    async inspectChallenge(
        params: {
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
        return this.sendBudgetedCommand(
            'challenge_inspect',
            {
                tabId: this.requireCurrentTabId(),
                frameId: this.currentFrameId || undefined,
                ...params,
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
        } = {},
        timeout?: number
    ): Promise<void> {
        await this.sendBudgetedCommand(
            'input_key',
            {
                tabId: this.requireCurrentTabId(),
                type,
                ...options,
            },
            timeout
        )
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
        } = {},
        timeout?: number
    ): Promise<void> {
        const params = { tabId: this.requireCurrentTabId(), type, x, y, ...options }
        if (timeout === undefined) {
            await this.httpServer.sendCommand('input_mouse', params)
        } else {
            await this.sendBudgetedCommand('input_mouse', params, timeout)
        }
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

    async inputType(text: string, delay = 0, timeout = DEFAULT_TIMEOUT): Promise<void> {
        await this.httpServer.sendCommand(
            'input_type',
            { tabId: this.requireCurrentTabId(), text, delay, deadline: Date.now() + timeout },
            timeout
        )
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
            errorText?: string
            sequence?: number
            challenge?: boolean
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
                errorText?: string
                sequence?: number
                challenge?: boolean
            }>
        }
        return result.requests
    }

    async stealthType(text: string, delay = 0, timeout = DEFAULT_TIMEOUT): Promise<void> {
        if (this.currentTabId === null) {
            throw new DriverCapabilityError('没有当前页面，请先 browse attach 或先 browse open 创建受控页面')
        }
        const params = {
            tabId: this.requireCurrentTabId(),
            frameId: this.currentFrameId !== null ? this.currentFrameId : undefined,
            text,
            delay,
            deadline: Date.now() + timeout,
        }
        await this.httpServer.sendCommand('stealth_type', params, timeout)
    }

    // ==================== Stealth 模式（JS 事件模拟，无 debugger）====================

    async stealthKey(
        key: string,
        type: 'down' | 'up' | 'press' = 'press',
        modifiers: string[] = [],
        timeout?: number
    ): Promise<void> {
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
        await this.sendBudgetedCommand('stealth_key', params, timeout)
    }

    async stealthClick(
        x: number,
        y: number,
        button = 'left',
        clickCount = 1,
        refId?: string,
        timeout = DEFAULT_TIMEOUT
    ): Promise<void> {
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
        await this.sendBudgetedCommand('stealth_click', params, timeout)
    }

    async stealthMouse(type: string, x: number, y: number, button = 'left', timeout?: number): Promise<void> {
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
        if (timeout === undefined) {
            await this.httpServer.sendCommand('stealth_mouse', params)
        } else {
            await this.sendBudgetedCommand('stealth_mouse', params, timeout)
        }
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
        timeout?: number,
        staleContextRetry: StaleContextRetryPolicy = 'never'
    ): Promise<{
        result?: { value?: unknown }
        exceptionDetails?: { text: string }
        retryAttempted?: boolean
        retryReason?: string
        staleContextRetry?: StaleContextRetryPolicy
        frameContext?: Record<string, unknown>
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
                staleContextRetry,
            },
            timeout
        )) as {
            result?: { value?: unknown }
            exceptionDetails?: { text: string }
            retryAttempted?: boolean
            retryReason?: string
            staleContextRetry?: StaleContextRetryPolicy
            frameContext?: Record<string, unknown>
        }
    }

    /**
     * 解析 iframe 选择器/索引 → frameId
     */
    async resolveFrame(
        frame: string | number,
        timeout?: number
    ): Promise<{
        frameId: number
        offset: { x: number; y: number } | null
        frameContext?: Record<string, unknown>
    }> {
        return (await this.sendBudgetedCommand(
            'resolve_frame',
            {
                tabId: this.requireCurrentTabId(),
                frame,
            },
            timeout
        )) as { frameId: number; offset: { x: number; y: number } | null; frameContext?: Record<string, unknown> }
    }

    private async sendBudgetedCommand(
        action:
            | 'navigate'
            | 'go_back'
            | 'go_forward'
            | 'reload'
            | 'stealth_click'
            | 'input_mouse'
            | 'input_key'
            | 'stealth_key'
            | 'resolve_frame'
            | 'stealth_mouse'
            | 'debugger_detach'
            | 'challenge_inspect',
        params: Record<string, unknown>,
        timeout = DEFAULT_TIMEOUT
    ): Promise<unknown> {
        const deadline = Date.now() + timeout
        const remaining = remainingNavigationTimeout(deadline)
        try {
            const result = await this.httpServer.sendCommand(
                action,
                { ...params, timeout: remaining, deadline },
                remaining
            )
            remainingNavigationTimeout(deadline)
            return result
        } catch (error) {
            if (error instanceof Error && error.message.startsWith(`Request timeout for action: ${action} (`)) {
                throw new StructuredToolError('TIMEOUT', error.message, '请回读实际页面，勿自动重放操作', {
                    actionExecuted: 'unknown',
                    actionStatus: 'unknown',
                    failureStage: 'rpc',
                    retryable: false,
                })
            }
            throw error
        }
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

    private normalizeGroupChange(result: ExtensionGroupChangeResult): GroupManagementResult {
        return {
            groupId: result.groupId,
            before: result.before,
            after: result.after,
            tabsBefore: result.tabsBefore.map((tab) => this.tabToTarget(tab)),
            tabsAfter: result.tabsAfter.map((tab) => this.tabToTarget(tab)),
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
        if (!/^(0|[1-9]\d*)$/.test(targetId)) {
            throw new DriverCapabilityError(`无效的 Tab ID: ${targetId}`)
        }
        const parsed = Number(targetId)
        if (!Number.isSafeInteger(parsed)) {
            throw new DriverCapabilityError(`无效的 Tab ID: ${targetId}`)
        }
        return parsed
    }

    private tabToTarget(tab: ExtensionTabSummary): ListedTarget {
        return {
            ...tab,
            targetId: String(tab.id),
            type: 'page',
        }
    }

    private updateState(page: { url: string; title: string; managed?: boolean }): void {
        this.state = { url: page.url, title: page.title, managed: page.managed }
    }
}
