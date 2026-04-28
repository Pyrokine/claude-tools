/**
 * Action 处理器
 *
 * 处理来自 MCP Server 的所有操作请求
 */

import type { ActionContext } from './action-utils'
import { ContentHandler } from './content-handler'
import { CookieHandler } from './cookie-handler'
import { DebuggerHandler } from './debugger-handler'
import { DebuggerManager } from './debugger-manager'
import { FrameResolver } from './frame-resolver'
import { InputEventHandler } from './input-event-handler'
import { LogEventHandler } from './log-event-handler'
import { LogManager } from './log-manager'
import { NavigationHandler } from './navigation-handler'
import { StealthHandler } from './stealth-handler'
import { TabHandler } from './tab-handler'

type ActionFunction = (params: unknown, context: ActionContext) => Promise<unknown>

export class ActionHandler {
    private actions: Map<string, ActionFunction> = new Map()
    private logManager = new LogManager()
    private debuggerManager = new DebuggerManager(this.logManager)
    private navigationHandler = new NavigationHandler(this.logManager)
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
            throw new Error(`Unknown action: ${action}`)
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

    private registerActions() {
        // Tab 操作
        this.actions.set('tabs_list', this.tabHandler.tabsList.bind(this.tabHandler))
        this.actions.set('tabs_create', this.tabHandler.tabsCreate.bind(this.tabHandler))
        this.actions.set('tabs_close', this.tabHandler.tabsClose.bind(this.tabHandler))
        this.actions.set('tabs_activate', this.tabHandler.tabsActivate.bind(this.tabHandler))

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
