import {
    StealthClickSchema,
    StealthInjectSchema,
    StealthKeySchema,
    StealthMouseSchema,
    StealthTypeSchema,
} from '../types/schemas'
import { assertScriptable, getTargetTabId } from './action-utils'
import {
    injectStealthScripts,
    simulateKeyboardType,
    simulateKeyEvent,
    simulateMouseClick,
    simulateMouseEvent,
} from './page-scripts'

export class StealthHandler {
    async stealthClick(params: unknown): Promise<{ success: boolean }> {
        const p = StealthClickSchema.parse(params)
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)

        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [p.frameId ?? 0] },
            world: 'MAIN',
            func: simulateMouseClick,
            args: [p.x, p.y, p.button || 'left', p.clickCount ?? 1, p.refId],
        })

        return results[0].result as { success: boolean }
    }

    async stealthType(params: unknown): Promise<{ success: boolean }> {
        const p = StealthTypeSchema.parse(params)
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)

        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [p.frameId ?? 0] },
            world: 'MAIN',
            func: simulateKeyboardType,
            args: [p.text, p.delay || 0],
        })

        return results[0].result as { success: boolean }
    }

    async stealthKey(params: unknown): Promise<{ success: boolean }> {
        const p = StealthKeySchema.parse(params)
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)

        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [p.frameId ?? 0] },
            world: 'MAIN',
            func: simulateKeyEvent,
            args: [p.key, p.type || 'press', p.modifiers || []],
        })

        return results[0].result as { success: boolean }
    }

    async stealthMouse(params: unknown): Promise<{ success: boolean }> {
        const p = StealthMouseSchema.parse(params)
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)

        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [p.frameId ?? 0] },
            world: 'MAIN',
            func: simulateMouseEvent,
            args: [p.type, p.x, p.y, p.button || 'left'],
        })

        return results[0].result as { success: boolean }
    }

    async stealthInject(params: unknown): Promise<{ success: boolean }> {
        const p = StealthInjectSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)

        await chrome.scripting.executeScript({
            target: { tabId, frameIds: [p.frameId ?? 0] },
            func: injectStealthScripts,
            world: 'MAIN', // 注入到主世界，覆盖原生属性
        })

        return { success: true }
    }
}
