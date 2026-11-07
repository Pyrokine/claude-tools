import { ExpectedOperationError, wrapDebuggerError } from '../types/expected-errors'
import { DebuggerAttachSchema, DebuggerDetachSchema, DebuggerSendSchema, KeyboardFocusSchema } from '../types/schemas'
import {
    type ActionContext,
    assertActionActive,
    assertManagedTab,
    assertScriptable,
    getTargetTabId,
} from './action-utils'
import { DebuggerManager } from './debugger-manager'
import { LogManager } from './log-manager'
import { remainingNavigationTimeout } from './navigation-handler'
import type { BrowserEventHandler } from './browser-event-handler'

export class DebuggerHandler {
    browserEvents?: BrowserEventHandler
    constructor(
        private debuggerManager: DebuggerManager,
        private logManager: LogManager
    ) {}

    async debuggerAttach(params: unknown, context: ActionContext): Promise<{ success: boolean; tabId: number }> {
        const p = DebuggerAttachSchema.parse(params) ?? {}
        const tabId = await this.getManagedDebuggableTabId(p.tabId, context, 'debugger_attach')
        try {
            await this.debuggerManager.ensureAttached(tabId)
        } catch (error) {
            throw wrapDebuggerError(error, { tabId, phase: 'attach' })
        }
        return { success: true, tabId }
    }

    async debuggerDetach(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = DebuggerDetachSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)
        await assertManagedTab(tabId, context, 'debugger_detach')
        if (p.deadline !== undefined) {
            remainingNavigationTimeout(p.deadline)
        }

        if (!this.debuggerManager.isAttached(tabId)) {
            return { success: true }
        }

        try {
            const suspended = await this.debuggerManager.beforeDetach?.(
                tabId,
                'debugger detach',
                context.serverInstanceId
            )
            if (suspended?.suspended === false) {
                throw new ExpectedOperationError(
                    JSON.stringify({
                        error: {
                            code: 'EVENT_CLEANUP_UNKNOWN',
                            message: 'Fetch cleanup outcome unknown; debugger remains attached',
                            context: suspended,
                        },
                    })
                )
            }
            await chrome.debugger.detach({ tabId })
        } catch (error) {
            throw wrapDebuggerError(error, { tabId, phase: 'detach' })
        }
        // 走集中清理：cleanupTab 同时清 attachedTabs / debuggerBlocked* / executionContexts / pendingAttach
        // 避免逐个 Map 漏清导致后续 evaluate/screenshot 用到旧 contextId
        this.debuggerManager.cleanupTab(tabId)
        this.logManager.handleDebuggerDetach(tabId)

        return { success: true }
    }

    async keyboardFocus(params: unknown, context: ActionContext): Promise<unknown> {
        const p = KeyboardFocusSchema.parse(params)
        if (p.operation === 'release') {
            return this.debuggerManager.releaseKeyboardFocus(
                p.tabId,
                p.id,
                context.serverInstanceId,
                p.releaseKeys ?? false
            )
        }
        const tabId = await this.getManagedDebuggableTabId(p.tabId, context, 'keyboard_focus')
        return this.debuggerManager.acquireKeyboardFocus(tabId, p.id, p.frameId ?? 0, p.documentId, context)
    }

    async debuggerSend(params: unknown, context: ActionContext): Promise<unknown> {
        const p = DebuggerSendSchema.parse(params)
        const tabId = await this.getManagedDebuggableTabId(p.tabId, context, 'debugger_send')
        try {
            await this.debuggerManager.ensureAttached(tabId)
        } catch (error) {
            throw wrapDebuggerError(error, { tabId, phase: 'attach' })
        }
        if (p.method.startsWith('Fetch.') && this.browserEvents) {
            return this.browserEvents.rawFetch(tabId, p.method, p.params, context)
        }
        if (p.method === 'Emulation.setDeviceMetricsOverride') {
            await chrome.tabs.setZoom(tabId, 1)
        }
        let result: unknown
        try {
            assertActionActive(context)
            const runtimeParams =
                context.deadline !== undefined && /^Runtime\.(?:evaluate|callFunctionOn)$/.test(p.method)
                    ? {
                          ...p.params,
                          timeout: Math.min(
                              typeof p.params?.timeout === 'number' ? p.params.timeout : Infinity,
                              Math.max(1, context.deadline - Date.now())
                          ),
                      }
                    : p.params
            result =
                p.method === 'Emulation.setFocusEmulationEnabled' && typeof p.params?.enabled === 'boolean'
                    ? await this.debuggerManager.setFocusEmulation(tabId, p.params.enabled)
                    : await chrome.debugger.sendCommand({ tabId }, p.method, runtimeParams)
        } catch (error) {
            throw wrapDebuggerError(error, { tabId, method: p.method, phase: 'command' })
        }
        if (p.method === 'Network.disable') {
            this.logManager.handleDebuggerDetach(tabId)
        }
        return result
    }

    private async getManagedDebuggableTabId(
        tabId: number | undefined,
        context: ActionContext,
        operation: string
    ): Promise<number> {
        const resolvedTabId = await getTargetTabId(tabId)
        const tab = await assertManagedTab(resolvedTabId, context, operation)
        if (!/^about:blank(?:[?#]|$)/.test(tab.url ?? '')) {
            await assertScriptable(resolvedTabId)
        }
        return resolvedTabId
    }
}
