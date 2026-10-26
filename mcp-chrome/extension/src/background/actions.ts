/**
 * Action 处理器
 *
 * 处理来自 MCP Server 的所有操作请求
 */

import { ExpectedOperationError } from '../types/expected-errors'
import type { TabInfo } from '../types'
import { assertManagedTab, getTargetTabId, type ActionContext } from './action-utils'
import { ContentHandler } from './content-handler'
import { CookieHandler } from './cookie-handler'
import { DebuggerHandler } from './debugger-handler'
import { DebuggerManager } from './debugger-manager'
import { FrameResolver } from './frame-resolver'
import { InputEventHandler } from './input-event-handler'
import { LogEventHandler } from './log-event-handler'
import { LogManager } from './log-manager'
import {
    advancePageRevision,
    assertPageCondition,
    forgetPageRevision,
    getExistingTab,
    pageRevision,
    pageSnapshot,
} from './page-revision'
import { NavigationHandler, remainingNavigationTimeout } from './navigation-handler'
import { StealthHandler } from './stealth-handler'
import { TabHandler } from './tab-handler'
import { hasReadGrant, setReadGrant } from './read-grants'
import { isManagedTab } from './tab-state'
import { TabsReadAccessSchema } from '../types/schemas'

type ActionFunction = (params: unknown, context: ActionContext) => Promise<unknown>

const PAGE_MUTATIONS = new Set([
    'tabs_close',
    'tabs_activate',
    'tabs_activate_managed',
    'tabs_adopt',
    'tabs_release',
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

const MANAGED_PAGE_ONLY = new Set([
    'tabs_close',
    'tabs_activate',
    'tabs_activate_managed',
    'tabs_move',
    'tabs_reorder',
    'tabs_pin',
    'tabs_update',
    'navigate',
    'go_back',
    'go_forward',
    'reload',
    'screenshot',
    'evaluate',
    'evaluate_in_frame',
    'challenge_inspect',
    'viewport_metrics',
    'debugger_attach',
    'debugger_detach',
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
    'click',
    'actionable_click',
    'dispatch_input',
    'drag_and_drop',
    'type',
    'scroll',
    'check_actionability',
    'console_enable',
    'console_get',
    'console_clear',
    'network_enable',
    'network_get',
    'network_clear',
    'network_challenge_state',
])

const PAGE_READS = new Set([
    'tabs_read_access',
    'read_page',
    'find',
    'get_text',
    'get_html',
    'get_html_with_images',
    'get_attribute',
    'get_metadata',
    'get_computed_style',
    'resolve_frame',
    'get_all_frames',
])

export class ActionHandler {
    private actions: Map<string, ActionFunction> = new Map()
    private actionLocks = new Map<number, Promise<void>>()
    private logManager = new LogManager()
    private debuggerManager = new DebuggerManager(this.logManager)
    private navigationHandler = new NavigationHandler(this.logManager, (tabId) =>
        this.logEventHandler.enableNetworkObservation(tabId)
    )

    private frameResolver = new FrameResolver(this.debuggerManager)
    private tabHandler = new TabHandler(this.navigationHandler)
    private contentHandler = new ContentHandler(this.debuggerManager)
    private cookieHandler = new CookieHandler()
    private debuggerHandler = new DebuggerHandler(this.debuggerManager, this.logManager)
    private inputEventHandler = new InputEventHandler(this.debuggerManager)
    private logEventHandler = new LogEventHandler(this.logManager, this.debuggerManager)
    private stealthHandler = new StealthHandler()

    constructor() {
        this.registerActions()
        this.debuggerManager.setupListeners()
    }

    async execute(action: string, params: unknown, context: ActionContext): Promise<unknown> {
        const handler = this.actions.get(action)
        if (!handler) {
            throw new ExpectedOperationError(
                JSON.stringify({
                    error: {
                        code: 'UNKNOWN_ACTION',
                        message: `Unknown action: ${action}`,
                    },
                })
            )
        }
        if (action.startsWith('tabgroup_')) {
            const snapshot = await this.tabHandler.getGroupLockSnapshot(action, params, context)
            return this.withActionLocks(
                snapshot.map((tab) => tab.id!),
                async () => {
                    const current = await this.tabHandler.getGroupLockSnapshot(action, params, context)
                    const request = params as { tabId?: number; tabIds?: number[] }
                    const targets = (tabs: chrome.tabs.Tab[]) =>
                        action === 'tabgroup_update'
                            ? []
                            : action === 'tabgroup_move'
                              ? tabs
                              : tabs.filter((tab) => (request.tabIds ?? [request.tabId]).includes(tab.id))
                    const identity = (tabs: chrome.tabs.Tab[]) =>
                        targets(tabs).map((tab) => [tab.id, tab.groupId, tab.windowId])
                    if (JSON.stringify(identity(snapshot)) !== JSON.stringify(identity(current))) {
                        throw new ExpectedOperationError('分组成员或窗口已变化，未执行分组操作')
                    }
                    await Promise.all(targets(current).map((tab) => assertManagedTab(tab.id!, context, action)))
                    return handler(params, context)
                }
            )
        }
        const mutating = PAGE_MUTATIONS.has(action)
        if (mutating || MANAGED_PAGE_ONLY.has(action) || PAGE_READS.has(action)) {
            const request = params as {
                tabId?: number
                expectedUrl?: string
                expectedRevision?: string
                deadline?: number
            } | null
            const tabId = await getTargetTabId(request?.tabId)
            return this.withActionLocks([tabId], async () => {
                if (request?.deadline !== undefined) {
                    const deadline = (params as { deadline?: unknown } | null)?.deadline
                    if (deadline !== undefined && (typeof deadline !== 'number' || !Number.isFinite(deadline))) {
                        throw new ExpectedOperationError(
                            JSON.stringify({
                                error: {
                                    code: 'INVALID_ARGUMENT',
                                    message: 'Action deadline must be a finite number',
                                    context: { actionExecuted: false },
                                },
                            })
                        )
                    }
                    if (typeof deadline === 'number') {
                        remainingNavigationTimeout(deadline)
                    }
                }
                await assertPageCondition(tabId, request?.expectedUrl, request?.expectedRevision)
                if (MANAGED_PAGE_ONLY.has(action)) {
                    await assertManagedTab(tabId, context, action)
                }
                if (request?.deadline !== undefined) {
                    remainingNavigationTimeout(request.deadline)
                }
                const warnings: string[] = []
                if (action === 'tabs_release' && this.debuggerManager.isAttached(tabId)) {
                    try {
                        await this.debuggerHandler.debuggerDetach({ tabId }, context)
                    } catch (error) {
                        warnings.push(`debugger 清理失败：${error instanceof Error ? error.message : String(error)}`)
                    }
                }
                let result: unknown
                let actionExecuted = true
                try {
                    result = await handler(params, context)
                    if (action === 'tabs_close') {
                        forgetPageRevision(tabId)
                    }
                    if (action === 'tabs_release') {
                        if (
                            (result as { managedBefore: boolean }).managedBefore &&
                            !(await this.logEventHandler.flushAndUninstallConsoleHook(tabId))
                        ) {
                            warnings.push('console 监听清理失败，请检查 Extension 日志')
                        }
                        this.cleanupTab(tabId)
                        if (warnings.length) {
                            return { ...(result as object), warnings }
                        }
                    }
                    return result
                } catch (error) {
                    actionExecuted = !(error instanceof ExpectedOperationError && error.actionExecuted === false)
                    throw error
                } finally {
                    if (mutating && actionExecuted && action !== 'tabs_close') {
                        advancePageRevision(tabId)
                        if (action.startsWith('tabs_') || action === 'navigate') {
                            const info = result as
                                { id?: number; revision?: string; tab?: TabInfo; after?: TabInfo | null } | undefined
                            const after = info?.tab ?? info?.after ?? info
                            if (after?.id === tabId) {
                                after.revision = pageRevision(tabId)
                            }
                        }
                    }
                }
            })
        }
        return handler(params, context)
    }

    /**
     * 清理 tab 关闭后的 per-tab 状态，防止内存泄漏
     */
    cleanupTab(tabId: number): void {
        this.logManager.cleanupTab(tabId)
        this.debuggerManager.cleanupTab(tabId)
        this.inputEventHandler.cleanupTab(tabId)
    }

    private async withActionLocks<T>(tabIds: number[], action: () => Promise<T>): Promise<T> {
        const ids = [...new Set(tabIds)].sort((a, b) => a - b)
        const previous = Promise.all(ids.map((id) => this.actionLocks.get(id)))
        const operation = previous.then(action)
        const settled = operation.then(
            () => {},
            () => {}
        )
        for (const id of ids) {
            this.actionLocks.set(id, settled)
        }
        try {
            return await operation
        } finally {
            for (const id of ids) {
                if (this.actionLocks.get(id) === settled) {
                    this.actionLocks.delete(id)
                }
            }
        }
    }

    private registerActions() {
        // Tab 操作
        this.actions.set('page_snapshot', async (params) => {
            const tabId = (params as { tabId?: number } | null)?.tabId
            if (!Number.isSafeInteger(tabId) || tabId! < 0) {
                throw new ExpectedOperationError('page_snapshot 需要有效 tabId')
            }
            return pageSnapshot(tabId!)
        })
        this.actions.set('tabs_list', this.tabHandler.tabsList.bind(this.tabHandler))
        this.actions.set('tabs_topology', this.tabHandler.tabsTopology.bind(this.tabHandler))
        this.actions.set('tabs_create', this.tabHandler.tabsCreate.bind(this.tabHandler))
        this.actions.set('tabs_close', this.tabHandler.tabsClose.bind(this.tabHandler))
        this.actions.set('tabs_activate', this.tabHandler.tabsActivate.bind(this.tabHandler))
        this.actions.set('tabs_activate_managed', this.tabHandler.tabsActivateManaged.bind(this.tabHandler))
        this.actions.set('tabs_adopt', this.tabHandler.tabsAdopt.bind(this.tabHandler))
        this.actions.set('tabs_release', this.tabHandler.tabsRelease.bind(this.tabHandler))
        this.actions.set('tabs_read_access', async (params, context) => {
            const { tabId, allow } = TabsReadAccessSchema.parse(params)
            if (!context.serverInstanceId) {
                throw new ExpectedOperationError('缺少服务器实例身份，未修改只读权限')
            }
            const before = await pageSnapshot(tabId)
            await setReadGrant(context.serverInstanceId, tabId, allow, before)
            const allowed = await hasReadGrant(context.serverInstanceId, tabId)
            if (allowed !== allow) {
                throw new ExpectedOperationError('页面身份已变化，未授予只读权限')
            }
            return {
                success: true,
                targetId: String(tabId),
                allowed,
                managed: isManagedTab(await getExistingTab(tabId)),
                scope: 'ordinary-read',
                serverInstanceId: context.serverInstanceId,
                url: before.url,
                revision: before.revision,
            }
        })
        this.actions.set('tabs_move', this.tabHandler.tabsMove.bind(this.tabHandler))
        this.actions.set('tabs_reorder', this.tabHandler.tabsReorder.bind(this.tabHandler))
        this.actions.set('tabs_pin', this.tabHandler.tabsPin.bind(this.tabHandler))
        this.actions.set('tabs_update', this.tabHandler.tabsUpdate.bind(this.tabHandler))
        this.actions.set('window_focus', this.tabHandler.windowFocus.bind(this.tabHandler))
        this.actions.set('window_resize', this.tabHandler.windowResize.bind(this.tabHandler))
        this.actions.set('window_update', this.tabHandler.windowUpdate.bind(this.tabHandler))
        this.actions.set('window_create', this.tabHandler.windowCreate.bind(this.tabHandler))
        this.actions.set('window_close', this.tabHandler.windowClose.bind(this.tabHandler))

        // 导航操作
        this.actions.set('navigate', this.navigationHandler.navigate.bind(this.navigationHandler))
        this.actions.set('go_back', this.navigationHandler.goBack.bind(this.navigationHandler))
        this.actions.set('go_forward', this.navigationHandler.goForward.bind(this.navigationHandler))
        this.actions.set('reload', this.navigationHandler.reload.bind(this.navigationHandler))

        // 页面内容
        this.actions.set('read_page', this.contentHandler.readPage.bind(this.contentHandler))
        this.actions.set('screenshot', this.contentHandler.screenshot.bind(this.contentHandler))

        // DOM 操作
        this.actions.set('click', this.contentHandler.click.bind(this.contentHandler))
        this.actions.set('actionable_click', this.contentHandler.actionableClick.bind(this.contentHandler))
        this.actions.set('check_actionability', this.contentHandler.checkActionabilityAction.bind(this.contentHandler))
        this.actions.set('dispatch_input', this.contentHandler.dispatchInputAction.bind(this.contentHandler))
        this.actions.set('drag_and_drop', this.contentHandler.dragAndDropAction.bind(this.contentHandler))
        this.actions.set('get_computed_style', this.contentHandler.getComputedStyleAction.bind(this.contentHandler))
        this.actions.set('type', this.contentHandler.type.bind(this.contentHandler))
        this.actions.set('scroll', this.contentHandler.scroll.bind(this.contentHandler))
        this.actions.set('evaluate', this.contentHandler.evaluate.bind(this.contentHandler))
        this.actions.set('viewport_metrics', this.contentHandler.getViewportMetrics.bind(this.contentHandler))
        this.actions.set('challenge_inspect', this.contentHandler.inspectChallenge.bind(this.contentHandler))
        this.actions.set('find', this.contentHandler.find.bind(this.contentHandler))

        // 页面内容提取
        this.actions.set('get_text', this.contentHandler.getText.bind(this.contentHandler))
        this.actions.set('get_html', this.contentHandler.getHtml.bind(this.contentHandler))
        this.actions.set('get_html_with_images', this.contentHandler.getHtmlWithImages.bind(this.contentHandler))
        this.actions.set('get_attribute', this.contentHandler.getAttribute.bind(this.contentHandler))
        this.actions.set('get_metadata', this.contentHandler.getMetadata.bind(this.contentHandler))

        // Cookies
        this.actions.set('cookies_get', this.cookieHandler.cookiesGet.bind(this.cookieHandler))
        this.actions.set('cookies_set', this.cookieHandler.cookiesSet.bind(this.cookieHandler))
        this.actions.set('cookies_delete', this.cookieHandler.cookiesDelete.bind(this.cookieHandler))
        this.actions.set('cookies_clear', this.cookieHandler.cookiesClear.bind(this.cookieHandler))

        // Tab Groups
        this.actions.set('tabgroup_create', this.tabHandler.tabGroupCreate.bind(this.tabHandler))
        this.actions.set('tabgroup_add', this.tabHandler.tabGroupAdd.bind(this.tabHandler))
        this.actions.set('tabgroup_remove', this.tabHandler.tabGroupRemove.bind(this.tabHandler))
        this.actions.set('tabgroup_update', this.tabHandler.tabGroupUpdate.bind(this.tabHandler))
        this.actions.set('tabgroup_move', this.tabHandler.tabGroupMove.bind(this.tabHandler))

        // Debugger (CDP) 操作 - precise 模式
        this.actions.set('debugger_attach', this.debuggerHandler.debuggerAttach.bind(this.debuggerHandler))
        this.actions.set('debugger_detach', this.debuggerHandler.debuggerDetach.bind(this.debuggerHandler))
        this.actions.set('debugger_send', this.debuggerHandler.debuggerSend.bind(this.debuggerHandler))

        // 输入事件（通过 CDP）- precise 模式
        this.actions.set('input_key', this.inputEventHandler.inputKey.bind(this.inputEventHandler))
        this.actions.set('input_mouse', this.inputEventHandler.inputMouse.bind(this.inputEventHandler))
        this.actions.set('input_touch', this.inputEventHandler.inputTouch.bind(this.inputEventHandler))
        this.actions.set('input_type', this.inputEventHandler.inputType.bind(this.inputEventHandler))

        // 控制台日志
        this.actions.set('console_enable', this.logEventHandler.consoleEnable.bind(this.logEventHandler))
        this.actions.set('console_get', this.logEventHandler.consoleGet.bind(this.logEventHandler))
        this.actions.set('console_clear', this.logEventHandler.consoleClear.bind(this.logEventHandler))

        // 网络日志
        this.actions.set('network_enable', this.logEventHandler.networkEnable.bind(this.logEventHandler))
        this.actions.set('network_get', this.logEventHandler.networkGet.bind(this.logEventHandler))
        this.actions.set('network_clear', this.logEventHandler.networkClear.bind(this.logEventHandler))
        this.actions.set(
            'network_challenge_state',
            this.logEventHandler.networkChallengeState.bind(this.logEventHandler)
        )

        // 输入事件（JS 模拟）- stealth 模式
        this.actions.set('stealth_click', this.stealthHandler.stealthClick.bind(this.stealthHandler))
        this.actions.set('stealth_type', this.stealthHandler.stealthType.bind(this.stealthHandler))
        this.actions.set('stealth_key', this.stealthHandler.stealthKey.bind(this.stealthHandler))
        this.actions.set('stealth_mouse', this.stealthHandler.stealthMouse.bind(this.stealthHandler))

        // 反检测
        this.actions.set('stealth_inject', this.stealthHandler.stealthInject.bind(this.stealthHandler))

        // iframe 穿透
        this.actions.set('resolve_frame', this.frameResolver.resolveFrame.bind(this.frameResolver))
        this.actions.set('get_all_frames', this.frameResolver.getAllFrames.bind(this.frameResolver))
        this.actions.set('evaluate_in_frame', this.frameResolver.evaluateInFrame.bind(this.frameResolver))
    }
}
