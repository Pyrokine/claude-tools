import { InputEventHandler } from '../extension/src/background/input-event-handler'
import { ContentHandler } from '../extension/src/background/content-handler'
import { FrameResolver } from '../extension/src/background/frame-resolver'
import { StealthHandler } from '../extension/src/background/stealth-handler'
import { DebuggerManager } from '../extension/src/background/debugger-manager'
import { markManagedTab } from '../extension/src/background/tab-state'
import { recordDomFrameProbe } from '../extension/src/background/action-utils'

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'MCP_FRAME_PROBE') {
        sendResponse(recordDomFrameProbe(message, sender))
    }
    return false
})
const manager = new DebuggerManager({ handleEvent() {}, handleDebuggerDetach() {} } as never)
manager.setupListeners()
let input = new InputEventHandler(manager)
const content = new ContentHandler(manager)
const frameResolver = new FrameResolver(manager)
const stealth = new StealthHandler()
const context = { mcpTabGroupId: null, mcpWindowId: null }
const counts: Record<string, number> = {}
const debuggerApi = chrome.debugger as unknown as {
    sendCommand(target: chrome.debugger.DebuggerSession, method: string, params?: object): Promise<object>
}
const nativeCommand = debuggerApi.sendCommand.bind(chrome.debugger)
debuggerApi.sendCommand = (target, method, params) => {
    if (method.startsWith('Input.dispatch')) {
        counts.nativeInputDispatches = (counts.nativeInputDispatches ?? 0) + 1
    }
    return nativeCommand(target, method, params)
}
;(globalThis as unknown as Record<string, unknown>).c31f6 = {
    adopt: (tabId: number) => markManagedTab(tabId, 'adopted'),
    tabs: () => chrome.tabs.query({}),
    frames: (tabId: number) => chrome.webNavigation.getAllFrames({ tabId }),
    freshHandler: () => {
        input = new InputEventHandler(manager)
    },
    debug: async (tabId: number, method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
        await manager.ensureAttached(tabId)
        return chrome.debugger.sendCommand({ tabId, ...(sessionId ? { sessionId } : {}) }, method, params)
    },
    inputTouch: (params: unknown) => {
        counts.input_touch = (counts.input_touch ?? 0) + 1
        return input.inputTouch(params, context)
    },
    sessions: (tabId: number) => manager.getFrameSessions(tabId),
    attached: (tabId: number) => manager.isAttached(tabId),
    evaluate: (params: unknown) => {
        counts.evaluate = (counts.evaluate ?? 0) + 1
        return content.evaluate(params, context)
    },
    counts: () => ({ ...counts }),
    command: (action: string, params: unknown) => {
        counts[action] = (counts[action] ?? 0) + 1
        if (action === 'evaluate_in_frame') {
            return frameResolver.evaluateInFrame(params, context)
        }
        if (action === 'input_key') {
            return input.inputKey(params, context)
        }
        if (action === 'stealth_key') {
            return stealth.stealthKey(params, context)
        }
        if (action === 'input_mouse') {
            return input.inputMouse(params, context)
        }
        if (action === 'stealth_mouse') {
            return stealth.stealthMouse(params, context)
        }
        if (action === 'stealth_click') {
            return stealth.stealthClick(params, context)
        }
        if (action === 'click') {
            return content.click(params, context)
        }
        if (action === 'actionable_click') {
            return content.actionableClick(params, context)
        }
        throw new Error('Unexpected test command: ' + action)
    },
    script: async (tabId: number, frameId: number, expression: string) => {
        counts.layoutScript = (counts.layoutScript ?? 0) + 1
        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frameId] },
            world: 'MAIN',
            func: (code: string) => new Function('return (' + code + ')')(),
            args: [expression],
        })
        if (results[0] && 'error' in results[0] && results[0].error) {
            throw new Error(String(results[0].error))
        }
        return results[0]?.result
    },
}
