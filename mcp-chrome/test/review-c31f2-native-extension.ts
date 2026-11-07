import { InputEventHandler } from '../extension/src/background/input-event-handler'
import { ContentHandler } from '../extension/src/background/content-handler'
import { FrameResolver } from '../extension/src/background/frame-resolver'
import { markManagedTab } from '../extension/src/background/tab-state'
import { recordDomFrameProbe } from '../extension/src/background/action-utils'
import { configureWheelFixture, readWheelFixture } from './review-c31f2-wheel-fixtures.mjs'

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'MCP_FRAME_PROBE') {
        sendResponse(recordDomFrameProbe(message, sender))
    }
    return false
})

const input = new InputEventHandler({} as never)
const content = new ContentHandler({} as never)
const frames = new FrameResolver({} as never)
const context = { mcpTabGroupId: null, mcpWindowId: null }

;(globalThis as unknown as Record<string, unknown>).c31f2 = {
    adopt: (tabId: number) =>
        markManagedTab(tabId, 'adopted', { taskHint: 'wheel 原生回归', note: '独立 profile 的临时合成页面' }),
    tabs: () => chrome.tabs.query({}),
    frames: (tabId: number) => chrome.webNavigation.getAllFrames({ tabId }),
    command: (action: string, params: unknown) => {
        if (action === 'input_mouse') {
            return input.inputMouse(params, context)
        }
        if (action === 'resolve_frame') {
            return frames.resolveFrame(params, context)
        }
        if (action === 'find') {
            return content.find(params, context)
        }
        if (action === 'scroll') {
            return content.scroll(params, context)
        }
        throw new Error('Unexpected native test action: ' + action)
    },
    configure: async (tabId: number, frameId: number, options: unknown) => {
        const result = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frameId] },
            world: 'MAIN',
            func: configureWheelFixture,
            args: [options],
        })
        return result[0]?.result
    },
    read: async (tabId: number, frameId: number) => {
        const result = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frameId] },
            world: 'MAIN',
            func: readWheelFixture,
        })
        return result[0]?.result
    },
}
