import {
    StealthClickSchema,
    StealthInjectSchema,
    StealthKeySchema,
    StealthMouseSchema,
    StealthTypeSchema,
} from '../types/schemas'
import { type ActionContext, assertManagedTab, assertScriptable, getTargetTabId } from './action-utils'
import {
    injectStealthScripts,
    simulateKeyboardType,
    simulateKeyEvent,
    simulateMouseClick,
    simulateMouseEvent,
} from './page-scripts'

export class StealthHandler {
    async stealthClick(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = StealthClickSchema.parse(params)
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'stealth_click')

        const args: [number, number, string, number?, string?] =
            typeof p.refId === 'string'
                ? [p.x, p.y, p.button || 'left', p.clickCount ?? 1, p.refId]
                : [p.x, p.y, p.button || 'left', p.clickCount ?? 1]

        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [p.frameId ?? 0] },
            world: 'MAIN',
            func: simulateMouseClick,
            args,
        })

        return results[0].result as { success: boolean }
    }

    async stealthType(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = StealthTypeSchema.parse(params)
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'stealth_type')

        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [p.frameId ?? 0] },
            world: 'MAIN',
            func: simulateKeyboardType,
            args: [p.text, p.delay || 0],
        })

        return results[0].result as { success: boolean }
    }

    async stealthKey(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = StealthKeySchema.parse(params)
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'stealth_key')

        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [p.frameId ?? 0] },
            world: 'MAIN',
            func: simulateKeyEvent,
            args: [p.key, p.type || 'press', p.modifiers || []],
        })

        return results[0].result as { success: boolean }
    }

    async stealthMouse(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = StealthMouseSchema.parse(params)
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'stealth_mouse')

        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [p.frameId ?? 0] },
            world: 'MAIN',
            func: simulateMouseEvent,
            args: [p.type, p.x, p.y, p.button || 'left'],
        })

        return results[0].result as { success: boolean }
    }

    async stealthInject(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = StealthInjectSchema.parse(params) ?? {}
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'stealth_inject')

        await chrome.scripting.executeScript({
            target: { tabId, frameIds: [p.frameId ?? 0] },
            func: injectStealthScripts,
            world: 'MAIN', // 注入到主世界，覆盖原生属性
        })

        return { success: true }
    }

    private async getManagedScriptableTabId(
        tabId: number | undefined,
        context: ActionContext,
        operation: string
    ): Promise<number> {
        const resolvedTabId = await getTargetTabId(tabId)
        await assertManagedTab(resolvedTabId, context, operation)
        await assertScriptable(resolvedTabId)
        return resolvedTabId
    }
}
