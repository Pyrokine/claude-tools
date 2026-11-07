import { ActionHandler } from '../extension/src/background/actions'
import { recordDomFrameProbe } from '../extension/src/background/action-utils'
import { markManagedTab } from '../extension/src/background/tab-state'

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'MCP_FRAME_PROBE') {
        sendResponse(recordDomFrameProbe(message, sender))
    }
    return false
})
const nativeInputs: Array<{ target: chrome.debugger.DebuggerSession; method: string; params?: object }> = []
const nativeSend = chrome.debugger.sendCommand.bind(chrome.debugger)
chrome.debugger.sendCommand = async (target, method, params) => {
    if (method.startsWith('Input.dispatch')) {
        nativeInputs.push({ target, method, params })
    }
    return nativeSend(target, method, params)
}
const actions = new ActionHandler()
const context = { mcpTabGroupId: null, mcpWindowId: null, serverInstanceId: 'coordinates-isolated-fixture' }
;(globalThis as unknown as Record<string, unknown>).coordinates = {
    adopt: (tabId: number) => markManagedTab(tabId, 'adopted'),
    tabs: () => chrome.tabs.query({}),
    nativeInputs: () => nativeInputs,
    frames: (tabId: number) => chrome.webNavigation.getAllFrames({ tabId }),
    command: (action: string, params: unknown) => actions.execute(action, params, context),
    script: async (tabId: number, frameId: number, expression: string) => {
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
