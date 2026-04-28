import type { TabInfo } from '../types'
import {
    TabGroupAddSchema,
    TabGroupCreateSchema,
    TabsActivateSchema,
    TabsCloseSchema,
    TabsCreateSchema,
    TabsListSchema,
} from '../types/schemas'
import { ActionContext } from './action-utils'
import { NavigationHandler } from './navigation-handler'
import { setMcpTabGroupId, setMcpWindowId } from './tab-state'

export class TabHandler {
    constructor(private navigationHandler: NavigationHandler) {}

    async tabsList(params: unknown, context: ActionContext): Promise<TabInfo[]> {
        const p = TabsListSchema.parse(params) ?? {}
        const queryInfo: chrome.tabs.QueryInfo = {}

        if (p.windowId) {
            queryInfo.windowId = p.windowId
        }
        if (p.active !== undefined) {
            queryInfo.active = p.active
        }

        const tabs = await chrome.tabs.query(queryInfo)

        return tabs
            .filter((tab) => tab.id !== undefined)
            .map((tab) => ({
                id: tab.id!,
                url: tab.url || '',
                title: tab.title || '',
                active: tab.active,
                windowId: tab.windowId,
                index: tab.index,
                groupId: tab.groupId,
                pinned: tab.pinned,
                incognito: tab.incognito,
                managed: context.mcpTabGroupId !== null && tab.groupId === context.mcpTabGroupId,
                status: tab.status || 'unknown',
            }))
    }

    async tabsCreate(params: unknown, context: ActionContext): Promise<TabInfo> {
        const p = TabsCreateSchema.parse(params) ?? {}

        const createProps: chrome.tabs.CreateProperties = {
            url: p.url || 'about:blank',
            active: p.active !== false,
        }

        let initialTabIdToCleanup: number | undefined

        if (p.windowId) {
            createProps.windowId = p.windowId
        } else {
            // 未指定窗口时，使用/创建 MCP 专属窗口（避免污染用户工作窗口）
            let targetWindowId: number | null = context.mcpWindowId
            if (targetWindowId !== null) {
                try {
                    await chrome.windows.get(targetWindowId)
                } catch {
                    targetWindowId = null
                }
            }
            // 纯度校验：window 里混入非 MCP tab（用户拖入，或 SW 重启后 windowId 实际是用户窗口）就丢弃重建
            // mcpTabGroupId 为 null 时视为不可验证，保守重建
            if (targetWindowId !== null) {
                const existingTabs = await chrome.tabs.query({ windowId: targetWindowId })
                const impure =
                    context.mcpTabGroupId === null || existingTabs.some((t) => t.groupId !== context.mcpTabGroupId)
                if (impure) {
                    targetWindowId = null
                }
            }
            if (targetWindowId === null) {
                // 新建 MCP 专属 window 时必须同步重置 mcpTabGroupId
                // 否则旧 group 在别的 window 时，chrome.tabs.group 会把新 tab 静默拽到旧 group 所在 window（破坏隔离）
                setMcpTabGroupId(null)
                const newWindow = await chrome.windows.create({
                    type: 'normal',
                    focused: false,
                    url: 'about:blank',
                })
                if (newWindow?.id) {
                    targetWindowId = newWindow.id
                    setMcpWindowId(newWindow.id)
                    initialTabIdToCleanup = newWindow.tabs?.[0]?.id
                }
            }
            if (targetWindowId !== null) {
                createProps.windowId = targetWindowId
            }
        }

        const tab = await chrome.tabs.create(createProps)

        // 清理新建 MCP window 自带的初始 about:blank tab
        if (initialTabIdToCleanup !== undefined && initialTabIdToCleanup !== tab.id) {
            try {
                await chrome.tabs.remove(initialTabIdToCleanup)
            } catch {
                // tab 可能已被关闭，忽略
            }
        }

        // 加入 MCP Chrome 分组（自动创建或复用）
        // Linux Chrome 有时对刚创建的 normal window 判定为非 normal，chrome.tabs.group 会抛
        // "Tabs can only be moved to and from normal windows"；此时放弃分组，tab 仍在新 window 里（isolation 已达成）
        let actualGroupId = tab.groupId ?? -1
        let managed = false
        if (tab.id) {
            let groupId: number | null = p.groupId ?? context.mcpTabGroupId
            if (groupId !== null && groupId !== undefined) {
                try {
                    await chrome.tabs.group({ tabIds: [tab.id], groupId })
                    actualGroupId = groupId
                    managed = true
                } catch {
                    // 分组可能已被删除，重新创建
                    groupId = null
                }
            }
            if (groupId === null || groupId === undefined) {
                // Linux Chrome 对刚创建的 normal window 偶尔判定为非 normal，group 会抛
                // "Tabs can only be moved to and from normal windows"；延迟重试一次
                const tryCreateGroup = async () => {
                    const newGroupId = await chrome.tabs.group({ tabIds: [tab.id!] })
                    await chrome.tabGroups.update(newGroupId, { title: 'MCP Chrome', color: 'cyan' })
                    setMcpTabGroupId(newGroupId)
                    actualGroupId = newGroupId
                    managed = true
                }
                try {
                    await tryCreateGroup()
                } catch {
                    try {
                        await new Promise((r) => setTimeout(r, 300))
                        await tryCreateGroup()
                    } catch (err) {
                        // 极少数场景下分组仍失败，tab 已在正确 window 内，isolation 已达成；分组仅视觉辅助，跳过
                        console.warn('[MCP] chrome.tabs.group 两次重试均失败，tab 未加入 MCP 分组:', err)
                    }
                }
            }
        }

        // 等待页面加载
        if (p.waitUntil && tab.id) {
            await this.navigationHandler.waitForNavigation(tab.id, p.waitUntil, p.timeout)
        }

        return {
            id: tab.id!,
            url: tab.url || '',
            title: tab.title || '',
            active: tab.active,
            windowId: tab.windowId,
            index: tab.index,
            groupId: actualGroupId,
            pinned: tab.pinned,
            incognito: tab.incognito,
            managed,
            status: tab.status || 'unknown',
        }
    }

    async tabsClose(params: unknown): Promise<{ success: boolean }> {
        const p = TabsCloseSchema.parse(params)
        await chrome.tabs.remove(p.tabId)
        return { success: true }
    }

    async tabsActivate(params: unknown, context: ActionContext): Promise<TabInfo> {
        const p = TabsActivateSchema.parse(params)

        const tab = await chrome.tabs.update(p.tabId, { active: true })

        // 聚焦窗口
        if (tab.windowId) {
            await chrome.windows.update(tab.windowId, { focused: true })
        }

        return {
            id: tab.id!,
            url: tab.url || '',
            title: tab.title || '',
            active: tab.active,
            windowId: tab.windowId,
            index: tab.index,
            groupId: tab.groupId,
            pinned: tab.pinned,
            incognito: tab.incognito,
            managed: context.mcpTabGroupId !== null && tab.groupId === context.mcpTabGroupId,
            status: tab.status || 'unknown',
        }
    }

    async tabGroupCreate(params: unknown): Promise<{ groupId: number; title: string; color: string }> {
        const p = TabGroupCreateSchema.parse(params)

        const groupId = await chrome.tabs.group({ tabIds: p.tabIds })
        const title = p.title || 'MCP Chrome'
        const color = p.color || 'cyan'

        await chrome.tabGroups.update(groupId, { title, color })

        return { groupId, title, color }
    }

    async tabGroupAdd(params: unknown, context: ActionContext): Promise<{ success: boolean; groupId: number }> {
        const p = TabGroupAddSchema.parse(params)

        const groupId = p.groupId ?? context.mcpTabGroupId
        if (groupId === null || groupId === undefined) {
            throw new Error('No tab group available')
        }

        await chrome.tabs.group({ tabIds: [p.tabId], groupId })

        return { success: true, groupId }
    }
}
