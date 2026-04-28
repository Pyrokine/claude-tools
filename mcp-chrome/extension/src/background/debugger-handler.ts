import { ExpectedOperationError } from '../types/expected-errors'
import { DebuggerAttachSchema, DebuggerDetachSchema, DebuggerSendSchema } from '../types/schemas'
import { assertScriptable, getTargetTabId } from './action-utils'
import { DebuggerManager } from './debugger-manager'
import { LogManager } from './log-manager'

// chrome.debugger 透传的预期错误（异步竞态、目标受限），不是 bug，避免污染 Extension 错误面板
const EXPECTED_DEBUGGER_PATTERNS = [
    /Cannot access a chrome:\/\//i,
    /Cannot access a chrome-extension:\/\//i,
    /Cannot attach to .* tab/i,
    /Inspected target navigated or closed/i,
    /No tab with given id/i,
    /Detached while handling command/i,
]

function wrapDebuggerError(err: unknown): Error {
    const msg = err instanceof Error ? err.message : String(err)
    if (EXPECTED_DEBUGGER_PATTERNS.some((p) => p.test(msg))) {
        return new ExpectedOperationError(msg)
    }
    return err instanceof Error ? err : new Error(msg)
}

export class DebuggerHandler {
    constructor(
        private debuggerManager: DebuggerManager,
        private logManager: LogManager
    ) {}

    async debuggerAttach(params: unknown): Promise<{ success: boolean; tabId: number }> {
        const p = DebuggerAttachSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)
        try {
            await this.debuggerManager.ensureAttached(tabId)
        } catch (e) {
            throw wrapDebuggerError(e)
        }
        return { success: true, tabId }
    }

    async debuggerDetach(params: unknown): Promise<{ success: boolean }> {
        const p = DebuggerDetachSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)

        if (!this.debuggerManager.isAttached(tabId)) {
            return { success: true }
        }

        try {
            await chrome.debugger.detach({ tabId })
        } catch (e) {
            throw wrapDebuggerError(e)
        }
        // 走集中清理：cleanupTab 同时清 attachedTabs / debuggerBlocked* / executionContexts / pendingAttach
        // 避免逐个 Map 漏清导致后续 evaluate/screenshot 用到旧 contextId
        this.debuggerManager.cleanupTab(tabId)
        this.logManager.cleanupTab(tabId)

        return { success: true }
    }

    async debuggerSend(params: unknown): Promise<unknown> {
        const p = DebuggerSendSchema.parse(params)

        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)
        try {
            await this.debuggerManager.ensureAttached(tabId)
            return await chrome.debugger.sendCommand({ tabId }, p.method, p.params)
        } catch (e) {
            throw wrapDebuggerError(e)
        }
    }
}
