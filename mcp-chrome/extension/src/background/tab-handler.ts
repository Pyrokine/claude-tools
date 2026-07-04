import type { BrowserTopology, ManagedTabChangeResult, ManagedWindowChangeResult, TabInfo, WindowInfo } from '../types'
import { ExpectedOperationError } from '../types/expected-errors'
import {
    TabGroupAddSchema,
    TabGroupCreateSchema,
    TabsActivateSchema,
    TabsAdoptSchema,
    TabsCloseSchema,
    TabsCreateSchema,
    TabsListSchema,
    TabsMoveSchema,
    TabsPinSchema,
    TabsReleaseSchema,
    TabsReorderSchema,
    WindowCloseSchema,
    WindowCreateSchema,
    WindowFocusSchema,
    WindowResizeSchema,
} from '../types/schemas'
import { ActionContext, assertManagedTab, tabToInfo } from './action-utils'
import { NavigationHandler } from './navigation-handler'
import { isManagedTab, markManagedTab, setMcpTabGroupId, setMcpWindowId, unmarkManagedTab } from './tab-state'

function windowToInfo(window: chrome.windows.Window, context: ActionContext): WindowInfo {
    const tabs = (window.tabs ?? [])
        .filter((tab) => tab.id !== undefined)
        .map((tab) => tabToInfo(tab, context))
        .sort((a, b) => a.index - b.index)
    const activeTab = tabs.find((tab) => tab.active)
    return {
        id: window.id!,
        focused: window.focused ?? false,
        type: window.type ?? 'normal',
        state: window.state,
        incognito: window.incognito ?? false,
        alwaysOnTop: window.alwaysOnTop ?? false,
        left: window.left,
        top: window.top,
        width: window.width,
        height: window.height,
        tabCount: tabs.length,
        activeTabId: activeTab?.id,
        tabs,
    }
}

async function getWindowInfo(windowId: number, context: ActionContext): Promise<WindowInfo> {
    const window = await chrome.windows.get(windowId, { populate: true })
    return windowToInfo(window, context)
}

function structuredOperationError(
    code: string,
    message: string,
    suggestion: string,
    context: Record<string, unknown>
): ExpectedOperationError {
    return new ExpectedOperationError(JSON.stringify({ error: { code, message, suggestion, context } }))
}

const WINDOW_FOCUS_OBSERVE_TIMEOUT_MS = 1000
const WINDOW_FOCUS_OBSERVE_INTERVAL_MS = 100

async function delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForWindowFocus(windowId: number, context: ActionContext): Promise<WindowInfo> {
    const deadline = Date.now() + WINDOW_FOCUS_OBSERVE_TIMEOUT_MS
    let info = await getWindowInfo(windowId, context)

    while (!info.focused && Date.now() < deadline) {
        await delay(WINDOW_FOCUS_OBSERVE_INTERVAL_MS)
        info = await getWindowInfo(windowId, context)
    }

    return info
}

async function assertManagedWindow(windowId: number, context: ActionContext, action: string): Promise<WindowInfo> {
    const info = await getWindowInfo(windowId, context)
    if (context.mcpWindowId === windowId) {
        return info
    }
    const unmanagedTabs = info.tabs.filter((tab) => !tab.managed)
    if (info.tabs.length > 0 && unmanagedTabs.length === 0) {
        return info
    }
    throw structuredOperationError(
        'UNMANAGED_WINDOW',
        `${action} 拒绝操作非 MCP 管理的浏览器窗口`,
        '请先用 manage(action="newWindow") 创建受控窗口，或只传入全部 tab 都是 managed=true 的窗口',
        {
            action,
            windowId,
            tabCount: info.tabCount,
            unmanagedTabIds: unmanagedTabs.map((tab) => tab.id),
        }
    )
}

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

        return tabs.filter((tab) => tab.id !== undefined).map((tab) => tabToInfo(tab, context))
    }

    async tabsTopology(_params: unknown, context: ActionContext): Promise<BrowserTopology> {
        const [windows, tabGroups] = await Promise.all([
            chrome.windows.getAll({ populate: true }),
            chrome.tabGroups.query({}),
        ])
        const tree: WindowInfo[] = windows
            .filter((window) => window.id !== undefined)
            .map((window) => windowToInfo(window, context))
        const focusedWindow = tree.find((window) => window.focused)
        const activeTarget = focusedWindow?.tabs.find((tab) => tab.active)
        const groups = tabGroups.map((g) => ({
            id: g.id,
            title: g.title || '',
            color: g.color || '',
            windowId: g.windowId,
            collapsed: g.collapsed,
        }))
        return {
            windowCount: tree.length,
            focusedWindowId: focusedWindow?.id,
            activeTargetId: activeTarget ? String(activeTarget.id) : undefined,
            windows: tree,
            groups,
        }
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
            await markManagedTab(tab.id)
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
            managed: managed || isManagedTab(tab, context),
            status: tab.status || 'unknown',
        }
    }

    async tabsClose(params: unknown, context: ActionContext): Promise<ManagedTabChangeResult> {
        const p = TabsCloseSchema.parse(params)
        const tab = await assertManagedTab(p.tabId, context, 'tabs_close')
        const before = tabToInfo(tab, context)
        await chrome.tabs.remove(p.tabId)
        return { success: true, targetId: String(p.tabId), windowId: before.windowId, before, after: null }
    }

    async tabsActivate(params: unknown, context: ActionContext): Promise<TabInfo> {
        const p = TabsActivateSchema.parse(params)
        await assertManagedTab(p.tabId, context, 'tabs_activate')

        const tab = await chrome.tabs.update(p.tabId, { active: true })
        if (!tab) {
            throw new ExpectedOperationError('激活 tab 失败，Chrome 未返回 tab')
        }

        // 聚焦窗口
        if (tab.windowId !== undefined) {
            await chrome.windows.update(tab.windowId, { focused: true })
        }

        return tabToInfo(tab, context)
    }

    async tabsActivateManaged(params: unknown, context: ActionContext): Promise<ManagedTabChangeResult> {
        const p = TabsActivateSchema.parse(params)
        const tab = await assertManagedTab(p.tabId, context, 'tabs_activate')
        const before = tabToInfo(tab, context)
        const updatedTab = await chrome.tabs.update(p.tabId, { active: true })
        if (!updatedTab) {
            throw new ExpectedOperationError('激活 tab 失败，Chrome 未返回 tab')
        }
        if (updatedTab.windowId !== undefined) {
            await chrome.windows.update(updatedTab.windowId, { focused: true })
        }
        const after = tabToInfo(await chrome.tabs.get(p.tabId), context)
        return { success: true, targetId: String(p.tabId), windowId: after.windowId, before, after }
    }

    async tabsAdopt(
        params: unknown,
        context: ActionContext
    ): Promise<{ success: boolean; tab: TabInfo; managedBefore: boolean; managedAfter: boolean }> {
        const p = TabsAdoptSchema.parse(params)
        const tab = await chrome.tabs.get(p.tabId)
        const managedBefore = isManagedTab(tab, context)
        await markManagedTab(p.tabId)
        const updatedTab = await chrome.tabs.get(p.tabId)
        return {
            success: true,
            tab: tabToInfo(updatedTab, context),
            managedBefore,
            managedAfter: true,
        }
    }

    async tabsRelease(
        params: unknown,
        context: ActionContext
    ): Promise<{ success: boolean; tab: TabInfo; managedBefore: boolean; managedAfter: boolean }> {
        const p = TabsReleaseSchema.parse(params)
        const tab = await chrome.tabs.get(p.tabId)
        const managedBefore = isManagedTab(tab, context)
        if (context.mcpTabGroupId !== null && tab.groupId === context.mcpTabGroupId) {
            await chrome.tabs.ungroup(p.tabId)
        }
        await unmarkManagedTab(p.tabId)
        const updatedTab = await chrome.tabs.get(p.tabId)
        return {
            success: true,
            tab: tabToInfo(updatedTab, context),
            managedBefore,
            managedAfter: isManagedTab(updatedTab, context),
        }
    }

    async tabsMove(params: unknown, context: ActionContext): Promise<ManagedTabChangeResult> {
        const p = TabsMoveSchema.parse(params)
        const tab = await assertManagedTab(p.tabId, context, 'tabs_move')
        const before = tabToInfo(tab, context)
        await chrome.tabs.move(p.tabId, {
            index: p.index ?? -1,
            ...(p.windowId !== undefined ? { windowId: p.windowId } : {}),
        })
        if (p.active) {
            await chrome.tabs.update(p.tabId, { active: true })
        }
        const after = tabToInfo(await chrome.tabs.get(p.tabId), context)
        return { success: true, targetId: String(p.tabId), windowId: after.windowId, before, after }
    }

    async tabsReorder(params: unknown, context: ActionContext): Promise<ManagedTabChangeResult> {
        const p = TabsReorderSchema.parse(params)
        const tab = await assertManagedTab(p.tabId, context, 'tabs_reorder')
        const before = tabToInfo(tab, context)
        await chrome.tabs.move(p.tabId, { index: p.index })
        const after = tabToInfo(await chrome.tabs.get(p.tabId), context)
        return { success: true, targetId: String(p.tabId), windowId: after.windowId, before, after }
    }

    async tabsPin(params: unknown, context: ActionContext): Promise<ManagedTabChangeResult> {
        const p = TabsPinSchema.parse(params)
        const tab = await assertManagedTab(p.tabId, context, 'tabs_pin')
        const before = tabToInfo(tab, context)
        await chrome.tabs.update(p.tabId, { pinned: p.pinned })
        const after = tabToInfo(await chrome.tabs.get(p.tabId), context)
        return { success: true, targetId: String(p.tabId), windowId: after.windowId, before, after }
    }

    async windowFocus(params: unknown, context: ActionContext): Promise<ManagedWindowChangeResult> {
        const p = WindowFocusSchema.parse(params)
        const before = await assertManagedWindow(p.windowId, context, 'window_focus')
        await chrome.windows.update(p.windowId, { focused: true })
        const after = await waitForWindowFocus(p.windowId, context)
        if (!after.focused) {
            throw structuredOperationError(
                'WINDOW_FOCUS_NOT_OBSERVED',
                'focusWindow 已请求聚焦窗口，但 Chrome 未观测到目标窗口获得焦点',
                '请确认目标窗口属于 managed 测试窗口，并检查当前桌面环境是否允许浏览器扩展主动聚焦窗口；需要可见 tab 时可改用 manage(action="activatePage") 激活目标测试 tab',
                {
                    windowId: p.windowId,
                    beforeFocused: before.focused,
                    afterFocused: after.focused,
                    activeTabId: after.activeTabId,
                }
            )
        }
        return { success: true, windowId: p.windowId, before, after }
    }

    async windowResize(params: unknown, context: ActionContext): Promise<ManagedWindowChangeResult> {
        const p = WindowResizeSchema.parse(params)
        const before = await assertManagedWindow(p.windowId, context, 'window_resize')
        await chrome.windows.update(p.windowId, {
            ...(p.left !== undefined ? { left: p.left } : {}),
            ...(p.top !== undefined ? { top: p.top } : {}),
            ...(p.width !== undefined ? { width: p.width } : {}),
            ...(p.height !== undefined ? { height: p.height } : {}),
            ...(p.state !== undefined ? { state: p.state } : {}),
        })
        const after = await getWindowInfo(p.windowId, context)
        return { success: true, windowId: p.windowId, before, after }
    }

    async windowCreate(params: unknown, context: ActionContext): Promise<ManagedWindowChangeResult> {
        const p = WindowCreateSchema.parse(params)
        const window = await chrome.windows.create({
            url: p.url || 'about:blank',
            focused: p.focused ?? false,
            incognito: p.incognito,
            left: p.left,
            top: p.top,
            width: p.width,
            height: p.height,
            state: p.state,
            type: 'normal',
        })
        if (!window?.id) {
            throw new ExpectedOperationError('创建窗口失败，Chrome 未返回 windowId')
        }
        setMcpWindowId(window.id)
        const tabId = window.tabs?.[0]?.id
        if (tabId !== undefined) {
            await markManagedTab(tabId)
        }
        const after = await getWindowInfo(window.id, context)
        return {
            success: true,
            windowId: window.id,
            targetId: tabId !== undefined ? String(tabId) : undefined,
            before: null,
            after,
        }
    }

    async windowClose(params: unknown, context: ActionContext): Promise<ManagedWindowChangeResult> {
        const p = WindowCloseSchema.parse(params)
        const before = await getWindowInfo(p.windowId, context)
        const unmanagedTabs = before.tabs.filter((tab) => !tab.managed)
        if (unmanagedTabs.length > 0) {
            throw structuredOperationError(
                'WINDOW_HAS_UNMANAGED_TABS',
                'closeWindow 拒绝关闭含非托管 tab 的窗口',
                '请只关闭全 managed tabs 的受控窗口，或先用 manage(action="releasePage") 解除不需要关闭的受控 tab',
                {
                    windowId: p.windowId,
                    unmanagedTabIds: unmanagedTabs.map((tab) => tab.id),
                    managedTabIds: before.tabs.filter((tab) => tab.managed).map((tab) => tab.id),
                }
            )
        }
        for (const tab of before.tabs) {
            await unmarkManagedTab(tab.id)
        }
        await chrome.windows.remove(p.windowId)
        if (context.mcpWindowId === p.windowId) {
            setMcpWindowId(null)
        }
        return { success: true, windowId: p.windowId, before, after: null }
    }

    async tabGroupCreate(params: unknown): Promise<{ groupId: number; title: string; color: string }> {
        const p = TabGroupCreateSchema.parse(params)
        const tabIds = p.tabIds as [number, ...number[]]

        const groupId = (await chrome.tabs.group({ tabIds })) as number
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
