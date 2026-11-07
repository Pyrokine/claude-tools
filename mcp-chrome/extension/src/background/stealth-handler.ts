import { installDomHelpers } from '../../../src/core/dom-helpers.js'
import { ExpectedOperationError } from '../types/expected-errors'
import {
    StealthClickSchema,
    StealthInjectSchema,
    StealthKeySchema,
    StealthMouseSchema,
    StealthTypeSchema,
} from '../types/schemas'
import {
    type ActionContext,
    assertActionActive,
    assertManagedTab,
    assertScriptable,
    getTargetTabId,
} from './action-utils'
import { remainingNavigationTimeout } from './navigation-handler'
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
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'stealth_click', p.frameId)
        if (p.deadline !== undefined) {
            remainingNavigationTimeout(p.deadline)
        }

        const args: Parameters<typeof simulateMouseClick> = [
            p.x,
            p.y,
            p.button || 'left',
            p.clickCount ?? 1,
            p.refId ?? null,
            {
                altKey: Boolean((p.modifiers ?? 0) & 1),
                ctrlKey: Boolean((p.modifiers ?? 0) & 2),
                metaKey: Boolean((p.modifiers ?? 0) & 4),
                shiftKey: Boolean((p.modifiers ?? 0) & 8),
            },
        ]

        assertActionActive(context)
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
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'stealth_type', p.frameId)

        assertActionActive(context)
        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [p.frameId ?? 0] },
            world: 'MAIN',
            func: simulateKeyboardType,
            args: p.deadline === undefined ? [p.text, p.delay ?? 0] : [p.text, p.delay ?? 0, p.deadline],
        })

        const result = results[0]?.result as { success: boolean; error?: string } | undefined
        if (!result?.success) {
            throw new ExpectedOperationError(result?.error ?? 'stealth_type 未返回成功结果')
        }
        return result
    }

    async stealthKey(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = StealthKeySchema.parse(params)
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'stealth_key', p.frameId)
        if (p.deadline !== undefined) {
            remainingNavigationTimeout(p.deadline)
        }

        assertActionActive(context)
        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [p.frameId ?? 0] },
            world: 'MAIN',
            func: simulateKeyEvent,
            args:
                p.deadline === undefined
                    ? [p.key, p.type || 'press', p.modifiers || []]
                    : [p.key, p.type || 'press', p.modifiers || [], p.deadline],
        })

        return results[0].result as { success: boolean }
    }

    async stealthMouse(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = StealthMouseSchema.parse(params)
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'stealth_mouse', p.frameId)
        if (p.deadline !== undefined) {
            remainingNavigationTimeout(p.deadline)
        }

        assertActionActive(context)
        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [p.frameId ?? 0] },
            world: 'MAIN',
            func: simulateMouseEvent,
            args: [
                p.type,
                p.x,
                p.y,
                p.button || 'left',
                p.deadline ?? null,
                {
                    altKey: Boolean((p.modifiers ?? 0) & 1),
                    ctrlKey: Boolean((p.modifiers ?? 0) & 2),
                    metaKey: Boolean((p.modifiers ?? 0) & 4),
                    shiftKey: Boolean((p.modifiers ?? 0) & 8),
                },
            ],
        })

        return results[0].result as { success: boolean }
    }

    async stealthInject(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = StealthInjectSchema.parse(params) ?? {}
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'stealth_inject', p.frameId)

        assertActionActive(context)
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
        operation: string,
        frameId = 0
    ): Promise<number> {
        const resolvedTabId = await getTargetTabId(tabId)
        await assertManagedTab(resolvedTabId, context, operation)
        await assertScriptable(resolvedTabId)
        assertActionActive(context)
        const setup = await chrome.scripting.executeScript({
            target: { tabId: resolvedTabId, frameIds: [frameId] },
            world: 'MAIN',
            func: installDomHelpers,
        })
        if (!setup[0] || (setup[0] as { error?: unknown }).error) {
            throw new ExpectedOperationError('DOM helper installation failed before stealth input', false)
        }
        return resolvedTabId
    }
}
