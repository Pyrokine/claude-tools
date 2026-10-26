import { wrapDebuggerError } from '../types/expected-errors'
import { DebuggerAttachSchema, DebuggerDetachSchema, DebuggerSendSchema } from '../types/schemas'
import { type ActionContext, assertManagedTab, assertScriptable, getTargetTabId } from './action-utils'
import { DebuggerManager } from './debugger-manager'
import { LogManager } from './log-manager'
import { remainingNavigationTimeout } from './navigation-handler'

export class DebuggerHandler {
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

    async debuggerSend(params: unknown, context: ActionContext): Promise<unknown> {
        const p = DebuggerSendSchema.parse(params)
        const tabId = await this.getManagedDebuggableTabId(p.tabId, context, 'debugger_send')
        try {
            await this.debuggerManager.ensureAttached(tabId)
        } catch (error) {
            throw wrapDebuggerError(error, { tabId, phase: 'attach' })
        }
        if (p.method === 'Emulation.setDeviceMetricsOverride') {
            await chrome.tabs.setZoom(tabId, 1)
        }
        let result: unknown
        try {
            result = await chrome.debugger.sendCommand({ tabId }, p.method, p.params)
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
