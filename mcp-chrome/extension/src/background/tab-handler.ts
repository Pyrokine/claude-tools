import type {
    BrowserTopology,
    ManagedGroupChangeResult,
    ManagedTabChangeResult,
    ManagedWindowChangeResult,
    TabGroupInfo,
    TabInfo,
    WindowInfo,
} from '../types'
import { ExpectedOperationError } from '../types/expected-errors'
import {
    TabGroupAddSchema,
    TabGroupCreateSchema,
    TabGroupMoveSchema,
    TabGroupRemoveSchema,
    TabGroupUpdateSchema,
    TabsActivateSchema,
    TabsAdoptSchema,
    TabsCloseSchema,
    TabsCreateSchema,
    TabsListSchema,
    TabsMoveSchema,
    TabsPinSchema,
    TabsReleaseSchema,
    TabsReorderSchema,
    TabsUpdateSchema,
    WindowCloseSchema,
    WindowCreateSchema,
    WindowFocusSchema,
    WindowUpdateSchema,
} from '../types/schemas'
import { ActionContext, assertManagedTab, tabToInfo } from './action-utils'
import { NavigationHandler } from './navigation-handler'
import { getExistingTab } from './page-revision'
import { isManagedTab, markManagedTab, setMcpTabGroupId, setMcpWindowId, unmarkManagedTab } from './tab-state'

function windowToInfo(window: chrome.windows.Window): WindowInfo {
    const tabs = (window.tabs ?? [])
        .filter((tab) => tab.id !== undefined)
        .map((tab) => tabToInfo(tab))
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

async function getWindowInfo(windowId: number): Promise<WindowInfo> {
    const window = await chrome.windows.get(windowId, { populate: true })
    return windowToInfo(window)
}

function groupToInfo(group: chrome.tabGroups.TabGroup, tabs: chrome.tabs.Tab[]): TabGroupInfo {
    const members = tabs
        .filter((tab) => tab.groupId === group.id && tab.id !== undefined)
        .sort((a, b) => a.index - b.index)
    return {
        id: group.id,
        title: group.title ?? '',
        color: group.color,
        windowId: group.windowId,
        collapsed: group.collapsed,
        shared: group.shared,
        index: members[0]?.index,
        tabIds: members.map((tab) => tab.id!),
        targetIds: members.map((tab) => String(tab.id)),
    }
}

function assertWindowOptions(options: chrome.windows.CreateData | chrome.windows.UpdateInfo, creating = false): void {
    const hasBounds = [options.left, options.top, options.width, options.height].some((value) => value !== undefined)
    if (hasBounds && ['minimized', 'maximized', 'fullscreen', 'locked-fullscreen'].includes(options.state ?? '')) {
        throw new ExpectedOperationError('INVALID_ARGUMENT: 非 normal 窗口状态不能与窗口位置或尺寸同时设置，未执行')
    }
    if (
        !creating &&
        ((options.focused === true && options.state === 'minimized') ||
            (options.focused === false &&
                ['maximized', 'fullscreen', 'locked-fullscreen'].includes(options.state ?? '')))
    ) {
        throw new ExpectedOperationError('INVALID_ARGUMENT: focused 与窗口状态冲突，未执行')
    }
}

function structuredOperationError(
    code: string,
    message: string,
    suggestion: string,
    context: Record<string, unknown>
): ExpectedOperationError {
    return new ExpectedOperationError(
        JSON.stringify({ error: { code, message, suggestion, context } }),
        context.actionExecuted === false ? false : undefined
    )
}

async function operationPreflight<T>(action: string, validate: () => Promise<T>): Promise<T> {
    try {
        return await validate()
    } catch (error) {
        throw structuredOperationError(
            error instanceof ExpectedOperationError ? 'INVALID_ARGUMENT' : 'PREFLIGHT_FAILED',
            error instanceof Error ? error.message : String(error),
            '请检查操作参数与目标状态后重试',
            { action, actionExecuted: false, actionStatus: 'not_started', failureStage: 'preflight' }
        )
    }
}

const WINDOW_OBSERVE_TIMEOUT_MS = 1000
const WINDOW_OBSERVE_INTERVAL_MS = 100

async function delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForWindowFocus(windowId: number): Promise<WindowInfo> {
    const deadline = Date.now() + WINDOW_OBSERVE_TIMEOUT_MS
    let info = await getWindowInfo(windowId)

    while (!info.focused && Date.now() < deadline) {
        await delay(WINDOW_OBSERVE_INTERVAL_MS)
        info = await getWindowInfo(windowId)
    }

    return info
}

async function waitForWindowGeometry(
    windowId: number,
    state: chrome.windows.UpdateInfo['state'],
    deadline: number
): Promise<WindowInfo> {
    let info = await getWindowInfo(windowId)
    let stable = 0
    while (Date.now() < deadline) {
        await delay(Math.min(WINDOW_OBSERVE_INTERVAL_MS, deadline - Date.now()))
        const next = await getWindowInfo(windowId)
        stable = (['state', 'left', 'top', 'width', 'height'] as const).every((key) => next[key] === info[key])
            ? stable + 1
            : 0
        info = next
        if ((state === undefined || info.state === state) && stable >= 2) {
            return info
        }
    }
    throw structuredOperationError(
        'WINDOW_UPDATE_NOT_OBSERVED',
        '窗口更新已请求，但 Chrome 未观测到稳定的目标状态和几何',
        '请用 browse list 核对窗口实际状态，勿自动重复更新',
        {
            action: 'window_update',
            windowId,
            requestedState: state ?? null,
            after: info,
            actionExecuted: true,
            actionStatus: 'partial',
            failureStage: 'observation',
        }
    )
}

export class TabHandler {
    constructor(private navigationHandler: NavigationHandler) {}

    async tabsList(params: unknown): Promise<TabInfo[]> {
        const p = TabsListSchema.parse(params) ?? {}
        const queryInfo: chrome.tabs.QueryInfo = {}

        if (p.windowId !== undefined) {
            queryInfo.windowId = p.windowId
        }
        if (p.active !== undefined) {
            queryInfo.active = p.active
        }

        const tabs = await chrome.tabs.query(queryInfo)

        return tabs.filter((tab) => tab.id !== undefined).map((tab) => tabToInfo(tab))
    }

    async tabsTopology(): Promise<BrowserTopology> {
        const [windows, tabGroups] = await Promise.all([
            chrome.windows.getAll({ populate: true }),
            chrome.tabGroups.query({}),
        ])
        const tree: WindowInfo[] = windows
            .filter((window) => window.id !== undefined)
            .map((window) => windowToInfo(window))
        const focusedWindow = tree.find((window) => window.focused)
        const activeTarget = focusedWindow?.tabs.find((tab) => tab.active)
        const tabs = windows.flatMap((window) => window.tabs ?? [])
        const groups = tabGroups.map((group) => groupToInfo(group, tabs))
        return {
            windowCount: tree.length,
            focusedWindowId: focusedWindow?.id,
            activeTargetId: activeTarget ? String(activeTarget.id) : undefined,
            windows: tree,
            groups,
        }
    }

    async tabsCreate(params: unknown, context: ActionContext): Promise<TabInfo> {
        const { p, explicitGroup, windowId } = await operationPreflight('tabs_create', async () => {
            const p = TabsCreateSchema.parse(params) ?? {}
            if (p.groupId !== undefined && p.groupId < -1) {
                throw new ExpectedOperationError('groupId 必须是 -1 或现有分组 ID，未创建页面')
            }
            if (p.pinned === true && p.groupId !== undefined && p.groupId >= 0) {
                throw new ExpectedOperationError('pinned=true 与标签分组不兼容，未创建页面')
            }
            const explicitGroup =
                p.groupId !== undefined && p.groupId >= 0 ? await chrome.tabGroups.get(p.groupId) : null
            const opener = p.openerTabId !== undefined ? await getExistingTab(p.openerTabId) : null
            const windowId = p.windowId ?? explicitGroup?.windowId ?? opener?.windowId
            if ((explicitGroup && explicitGroup.windowId !== windowId) || (opener && opener.windowId !== windowId)) {
                throw new ExpectedOperationError('windowId、groupId 或 openerTabId 不属于同一窗口，未创建页面')
            }
            return { p, explicitGroup, windowId }
        })
        const createProps: chrome.tabs.CreateProperties = {
            url: p.url ?? 'about:blank',
            active: p.active ?? false,
            index: p.index,
            pinned: p.pinned,
            openerTabId: p.openerTabId,
        }
        let initialTabIdToCleanup: number | undefined
        let effectiveGroupId: number | null = null
        const autoGroup =
            p.groupId === undefined &&
            p.windowId === undefined &&
            p.openerTabId === undefined &&
            p.index === undefined &&
            p.pinned !== true
        if (windowId !== undefined) {
            createProps.windowId = windowId
        } else {
            // 未指定窗口时复用缓存的 MCP 窗口，窗口关闭后重新创建
            let targetWindowId: number | null = context.mcpWindowId
            if (targetWindowId !== null) {
                try {
                    await chrome.windows.get(targetWindowId)
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error)
                    if (!/^No window with id: -?\d+\.?$/.test(message)) {
                        throw error
                    }
                    console.warn('[MCP] 原受控窗口已关闭，将创建新窗口:', error)
                    targetWindowId = null
                }
            }
            if (targetWindowId === null) {
                // 新建 MCP 专属 window 时必须同步重置 mcpTabGroupId
                setMcpTabGroupId(null)
                const newWindow = await chrome.windows.create({
                    type: 'normal',
                    focused: false,
                    url: 'about:blank',
                })
                if (newWindow?.id === undefined) {
                    throw new ExpectedOperationError('创建窗口失败，Chrome 未返回 windowId')
                }
                targetWindowId = newWindow.id
                setMcpWindowId(newWindow.id)
                initialTabIdToCleanup = newWindow.tabs?.[0]?.id
            } else if (autoGroup && context.mcpTabGroupId !== null) {
                const groups = await chrome.tabGroups.query({ windowId: targetWindowId })
                if (groups.some((group) => group.id === context.mcpTabGroupId)) {
                    effectiveGroupId = context.mcpTabGroupId
                }
            }
            createProps.windowId = targetWindowId
        }
        const tab = await chrome.tabs.create(createProps).catch((error: unknown) => {
            throw structuredOperationError(
                'CREATE_RESULT_UNKNOWN',
                String(error),
                '请用 browse list 核对实际页面，勿自动重复创建或删除',
                {
                    action: 'tabs_create',
                    createdTargetId: null,
                    windowId: createProps.windowId,
                    createdTargetIds: initialTabIdToCleanup !== undefined ? [String(initialTabIdToCleanup)] : [],
                    managed: null,
                    actionExecuted: 'unknown',
                    actionStatus: 'unknown',
                    failureStage: 'create',
                }
            )
        })
        if (tab.id === undefined) {
            throw structuredOperationError(
                'CREATE_RESULT_UNKNOWN',
                '创建页面未返回 tabId',
                '请用 browse list 核对实际页面',
                {
                    action: 'tabs_create',
                    createdTargetId: null,
                    windowId: tab.windowId,
                    managed: null,
                    actionExecuted: 'unknown',
                    actionStatus: 'unknown',
                    failureStage: 'create',
                }
            )
        }
        let failureStage = 'storage'
        try {
            await markManagedTab(tab.id)
            // 清理新建 MCP window 自带的初始 about:blank tab
            if (initialTabIdToCleanup !== undefined && initialTabIdToCleanup !== tab.id) {
                try {
                    await chrome.tabs.remove(initialTabIdToCleanup)
                } catch (error) {
                    console.warn('[MCP] 初始空白页面未能关闭:', error)
                }
            }
            const warnings: string[] = []
            failureStage = 'group'
            if (explicitGroup) {
                await chrome.tabs.group({ tabIds: [tab.id], groupId: explicitGroup.id })
                if (p.index !== undefined) {
                    failureStage = 'placement'
                    await chrome.tabs.move(tab.id, { index: p.index })
                }
            } else if (p.groupId === -1 && tab.groupId >= 0) {
                await chrome.tabs.ungroup(tab.id)
            } else if (autoGroup) {
                // 默认分组仅用于显示，失败时页面仍受控，返回实际状态与提示
                try {
                    const groupId = await chrome.tabs.group({
                        tabIds: [tab.id],
                        ...(effectiveGroupId !== null
                            ? { groupId: effectiveGroupId }
                            : { createProperties: { windowId: tab.windowId } }),
                    })
                    if (effectiveGroupId === null) {
                        await chrome.tabGroups.update(groupId, { title: 'MCP Chrome', color: 'cyan' })
                    }
                    setMcpTabGroupId(groupId)
                } catch (error) {
                    const message = `默认分组未完成：${error instanceof Error ? error.message : String(error)}`
                    warnings.push(message)
                    console.warn('[MCP]', message)
                }
            }
            // 等待页面加载
            failureStage = 'navigation'
            if (p.waitUntil) {
                await this.navigationHandler.waitForNavigation(tab.id, p.waitUntil, p.timeout)
            }
            failureStage = 'snapshot'
            return { ...tabToInfo(await getExistingTab(tab.id)), ...(warnings.length ? { warnings } : {}) }
        } catch (error) {
            throw structuredOperationError(
                'CREATE_INCOMPLETE',
                error instanceof Error ? error.message : String(error),
                '页面已创建，请用 browse list 核对状态，勿自动重复创建或删除',
                {
                    action: 'tabs_create',
                    targetId: String(tab.id),
                    createdTargetId: String(tab.id),
                    windowId: tab.windowId,
                    managed: isManagedTab(tab),
                    actionExecuted: true,
                    actionStatus: 'partial',
                    failureStage,
                }
            )
        }
    }

    async tabsUpdate(params: unknown, context: ActionContext): Promise<ManagedTabChangeResult> {
        const { tabId, properties, tab } = await operationPreflight('tabs_update', async () => {
            const { tabId, ...properties } = TabsUpdateSchema.parse(params)
            if (Object.values(properties).every((value) => value === undefined)) {
                throw new ExpectedOperationError('updatePage 需要至少一个页面配置参数，未执行')
            }
            if (properties.active === false) {
                throw new ExpectedOperationError(
                    'updatePage 不支持 active=false；激活其他页面请使用 activatePage，未执行'
                )
            }
            const tab = await assertManagedTab(tabId, context, 'tabs_update')
            if (properties.openerTabId !== undefined) {
                const opener = await getExistingTab(properties.openerTabId)
                if (opener.windowId !== tab.windowId || opener.id === tabId) {
                    throw new ExpectedOperationError('openerTabId 必须是同一窗口内的其他页面，未执行')
                }
            }
            return { tabId, properties, tab }
        })
        const before = tabToInfo(tab)
        await chrome.tabs.update(tabId, properties)
        const after = tabToInfo(await getExistingTab(tabId))
        return { success: true, targetId: String(tabId), windowId: after.windowId, before, after }
    }

    async tabsClose(params: unknown, context: ActionContext): Promise<ManagedTabChangeResult> {
        const p = TabsCloseSchema.parse(params)
        const tab = await assertManagedTab(p.tabId, context, 'tabs_close')
        const before = tabToInfo(tab)
        await chrome.tabs.remove(p.tabId)
        await unmarkManagedTab(p.tabId)
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

        return tabToInfo(await getExistingTab(p.tabId))
    }

    async tabsActivateManaged(params: unknown, context: ActionContext): Promise<ManagedTabChangeResult> {
        const p = TabsActivateSchema.parse(params)
        const tab = await assertManagedTab(p.tabId, context, 'tabs_activate')
        const before = tabToInfo(tab)
        const updatedTab = await chrome.tabs.update(p.tabId, { active: true })
        if (!updatedTab) {
            throw new ExpectedOperationError('激活 tab 失败，Chrome 未返回 tab')
        }
        if (updatedTab.windowId !== undefined) {
            await chrome.windows.update(updatedTab.windowId, { focused: true })
        }
        const after = tabToInfo(await getExistingTab(p.tabId))
        return { success: true, targetId: String(p.tabId), windowId: after.windowId, before, after }
    }

    async tabsAdopt(
        params: unknown
    ): Promise<{ success: boolean; tab: TabInfo; managedBefore: boolean; managedAfter: boolean }> {
        const p = TabsAdoptSchema.parse(params)
        const tab = await getExistingTab(p.tabId)
        const managedBefore = isManagedTab(tab)
        await markManagedTab(p.tabId)
        const updatedTab = await getExistingTab(p.tabId)
        return {
            success: true,
            tab: tabToInfo(updatedTab),
            managedBefore,
            managedAfter: true,
        }
    }

    async tabsRelease(
        params: unknown
    ): Promise<{ success: boolean; tab: TabInfo; managedBefore: boolean; managedAfter: boolean }> {
        const p = TabsReleaseSchema.parse(params)
        const tab = await getExistingTab(p.tabId)
        const managedBefore = isManagedTab(tab)
        await unmarkManagedTab(p.tabId)
        const updatedTab = await getExistingTab(p.tabId)
        return {
            success: true,
            tab: tabToInfo(updatedTab),
            managedBefore,
            managedAfter: isManagedTab(updatedTab),
        }
    }

    async tabsMove(params: unknown, context: ActionContext): Promise<ManagedTabChangeResult> {
        const p = TabsMoveSchema.parse(params)
        const tab = await assertManagedTab(p.tabId, context, 'tabs_move')
        const before = tabToInfo(tab)
        await chrome.tabs.move(p.tabId, {
            index: p.index ?? -1,
            ...(p.windowId !== undefined ? { windowId: p.windowId } : {}),
        })
        if (p.active !== undefined) {
            await chrome.tabs.update(p.tabId, { active: p.active })
        }
        const after = tabToInfo(await getExistingTab(p.tabId))
        return { success: true, targetId: String(p.tabId), windowId: after.windowId, before, after }
    }

    async tabsReorder(params: unknown, context: ActionContext): Promise<ManagedTabChangeResult> {
        const p = TabsReorderSchema.parse(params)
        const tab = await assertManagedTab(p.tabId, context, 'tabs_reorder')
        const before = tabToInfo(tab)
        await chrome.tabs.move(p.tabId, { index: p.index })
        const after = tabToInfo(await getExistingTab(p.tabId))
        return { success: true, targetId: String(p.tabId), windowId: after.windowId, before, after }
    }

    async tabsPin(params: unknown, context: ActionContext): Promise<ManagedTabChangeResult> {
        const p = TabsPinSchema.parse(params)
        const tab = await assertManagedTab(p.tabId, context, 'tabs_pin')
        const before = tabToInfo(tab)
        await chrome.tabs.update(p.tabId, { pinned: p.pinned })
        const after = tabToInfo(await getExistingTab(p.tabId))
        return { success: true, targetId: String(p.tabId), windowId: after.windowId, before, after }
    }

    async windowFocus(params: unknown): Promise<ManagedWindowChangeResult> {
        const p = WindowFocusSchema.parse(params)
        const before = await getWindowInfo(p.windowId)
        await chrome.windows.update(p.windowId, { focused: true })
        const after = await waitForWindowFocus(p.windowId)
        if (!after.focused) {
            throw structuredOperationError(
                'WINDOW_FOCUS_NOT_OBSERVED',
                'focusWindow 已请求聚焦窗口，但 Chrome 未观测到目标窗口获得焦点',
                '请检查桌面环境是否允许 Chrome 聚焦目标窗口，并用 browse list 核对实际焦点状态',
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

    async windowResize(params: unknown): Promise<ManagedWindowChangeResult> {
        return this.windowUpdate(params)
    }

    async windowUpdate(params: unknown): Promise<ManagedWindowChangeResult> {
        const { windowId, ...properties } = WindowUpdateSchema.parse(params)
        assertWindowOptions(properties)
        if (Object.values(properties).every((value) => value === undefined)) {
            throw new ExpectedOperationError('updateWindow 需要至少一个窗口配置参数，未执行')
        }
        const before = await getWindowInfo(windowId)
        const deadline = Date.now() + WINDOW_OBSERVE_TIMEOUT_MS
        const requestedState = properties.state
        const hasBounds = [properties.left, properties.top, properties.width, properties.height].some(
            (value) => value !== undefined
        )
        if (hasBounds && requestedState === 'normal' && before.state !== 'normal') {
            await chrome.windows.update(windowId, { state: 'normal' })
            await waitForWindowGeometry(windowId, requestedState, deadline)
            delete properties.state
        }
        await chrome.windows.update(windowId, properties)
        let after =
            hasBounds || requestedState !== undefined
                ? await waitForWindowGeometry(windowId, requestedState, deadline)
                : await getWindowInfo(windowId)
        if (properties.focused && !after.focused) {
            after = await waitForWindowFocus(windowId)
        }
        if (properties.focused && !after.focused) {
            throw structuredOperationError(
                'WINDOW_FOCUS_NOT_OBSERVED',
                'Chrome 未观测到目标窗口获得焦点',
                '请检查桌面环境是否允许聚焦窗口',
                { windowId, beforeFocused: before.focused, afterFocused: after.focused }
            )
        }
        return { success: true, windowId, before, after }
    }

    async windowCreate(params: unknown, context: ActionContext): Promise<ManagedWindowChangeResult> {
        const p = await operationPreflight('window_create', async () => {
            const p = WindowCreateSchema.parse(params)
            assertWindowOptions(p, true)
            const urlCount = Array.isArray(p.url) ? p.url.length : p.url !== undefined ? 1 : 0
            if (p.type === 'popup' && urlCount + (p.tabId !== undefined ? 1 : 0) > 1) {
                throw new ExpectedOperationError('popup 窗口只支持一个页面；多个页面请使用 normal 窗口，未创建窗口')
            }
            if (p.tabId !== undefined) {
                const tab = await assertManagedTab(p.tabId, context, 'window_create')
                if (p.incognito !== undefined && p.incognito !== tab.incognito) {
                    throw new ExpectedOperationError('已有页面不能迁移到不同的隐身状态，未创建窗口')
                }
            }
            return p
        })
        const window = await chrome.windows
            .create({
                url: p.url ?? (p.tabId === undefined ? 'about:blank' : undefined),
                tabId: p.tabId,
                focused: p.focused ?? false,
                incognito: p.incognito,
                left: p.left,
                top: p.top,
                width: p.width,
                height: p.height,
                state: p.state,
                type: p.type ?? 'normal',
                setSelfAsOpener: p.setSelfAsOpener,
            })
            .catch((error: unknown) => {
                throw structuredOperationError(
                    'CREATE_RESULT_UNKNOWN',
                    String(error),
                    '请用 browse list 核对实际窗口，勿自动重复创建或删除',
                    {
                        action: 'window_create',
                        createdTargetId: null,
                        managed: null,
                        actionExecuted: 'unknown',
                        actionStatus: 'unknown',
                        failureStage: 'create',
                    }
                )
            })
        if (window?.id === undefined) {
            throw structuredOperationError(
                'CREATE_RESULT_UNKNOWN',
                '创建窗口未返回 windowId',
                '请用 browse list 核对实际窗口',
                {
                    action: 'window_create',
                    createdTargetId: null,
                    managed: null,
                    actionExecuted: 'unknown',
                    actionStatus: 'unknown',
                    failureStage: 'create',
                }
            )
        }
        if ((window.type ?? p.type ?? 'normal') === 'normal') {
            setMcpWindowId(window.id)
        }
        let tabs = window.tabs ?? []
        let failureStage = 'snapshot'
        try {
            tabs = window.tabs ?? (await chrome.windows.get(window.id, { populate: true })).tabs ?? []
            const tabId = p.tabId ?? tabs[0]?.id
            failureStage = 'storage'
            for (const tab of tabs) {
                if (tab.id !== undefined) {
                    await markManagedTab(tab.id)
                }
            }
            failureStage = 'snapshot'
            const after = p.focused ? await waitForWindowFocus(window.id) : await getWindowInfo(window.id)
            return {
                success: true,
                windowId: window.id,
                targetId: tabId !== undefined ? String(tabId) : undefined,
                before: null,
                after,
            }
        } catch (error) {
            const tabId = p.tabId ?? tabs[0]?.id
            throw structuredOperationError(
                'CREATE_INCOMPLETE',
                error instanceof Error ? error.message : String(error),
                '窗口已创建，请用 browse list 核对状态，勿自动重复创建或删除',
                {
                    action: 'window_create',
                    windowId: window.id,
                    targetId: tabId !== undefined ? String(tabId) : null,
                    createdTargetId: tabId !== undefined && tabId !== p.tabId ? String(tabId) : null,
                    createdTargetIds: tabs
                        .filter((tab) => tab.id !== undefined && tab.id !== p.tabId)
                        .map((tab) => String(tab.id)),
                    managed: tabId !== undefined ? isManagedTab({ id: tabId }) : null,
                    targets: tabs.map((tab) => ({ targetId: String(tab.id), managed: isManagedTab(tab) })),
                    actionExecuted: true,
                    actionStatus: 'partial',
                    failureStage,
                }
            )
        }
    }

    async windowClose(params: unknown, context: ActionContext): Promise<ManagedWindowChangeResult> {
        const p = WindowCloseSchema.parse(params)
        const before = await getWindowInfo(p.windowId)
        const unmanagedTabs = before.tabs.filter((tab) => !tab.managed)
        if (unmanagedTabs.length > 0) {
            throw structuredOperationError(
                'WINDOW_HAS_UNMANAGED_TABS',
                'closeWindow 拒绝关闭含非托管 tab 的窗口',
                '请逐页关闭已获授权的受控页并保留其他页，整窗关闭需要全部成员页面的明确授权',
                {
                    windowId: p.windowId,
                    unmanagedTabIds: unmanagedTabs.map((tab) => tab.id),
                    managedTabIds: before.tabs.filter((tab) => tab.managed).map((tab) => tab.id),
                }
            )
        }
        await chrome.windows.remove(p.windowId)
        for (const tab of before.tabs) {
            await unmarkManagedTab(tab.id)
        }
        if (context.mcpWindowId === p.windowId) {
            setMcpWindowId(null)
        }
        return { success: true, windowId: p.windowId, before, after: null }
    }

    async getGroupLockSnapshot(action: string, params: unknown, context: ActionContext): Promise<chrome.tabs.Tab[]> {
        let tabIds: number[] = []
        let groupId: number | undefined
        switch (action) {
            case 'tabgroup_create':
                tabIds = TabGroupCreateSchema.parse(params).tabIds
                break
            case 'tabgroup_add': {
                const p = TabGroupAddSchema.parse(params)
                tabIds = p.tabIds ?? (p.tabId === undefined ? [] : [p.tabId])
                groupId = p.groupId ?? context.mcpTabGroupId ?? undefined
                break
            }
            case 'tabgroup_remove':
                tabIds = TabGroupRemoveSchema.parse(params).tabIds
                break
            case 'tabgroup_update':
                groupId = TabGroupUpdateSchema.parse(params).groupId
                break
            case 'tabgroup_move':
                groupId = TabGroupMoveSchema.parse(params).groupId
                break
        }
        const requested = await Promise.all(tabIds.map((id) => getExistingTab(id)))
        const groups = new Set(requested.map((tab) => tab.groupId).filter((id) => id >= 0))
        if (groupId !== undefined) {
            groups.add(groupId)
        }
        const tabs = await chrome.tabs.query({})
        const all = new Map(requested.map((tab) => [tab.id!, tab]))
        for (const tab of tabs) {
            if (groups.has(tab.groupId)) {
                all.set(tab.id!, tab)
            }
        }
        return [...all.values()].sort((a, b) => a.id! - b.id!)
    }

    async tabGroupCreate(params: unknown, context: ActionContext): Promise<ManagedGroupChangeResult> {
        const p = TabGroupCreateSchema.parse(params)
        return this.changeGroups(p.tabIds, context, 'tabgroup_create', async (tabs) => {
            const windowId = p.windowId ?? tabs[0]!.windowId
            if (p.windowId === undefined && tabs.some((tab) => tab.windowId !== windowId)) {
                throw new ExpectedOperationError('跨窗口创建分组需要指定 windowId，未执行')
            }
            const groupId = await chrome.tabs.group({
                tabIds: p.tabIds as [number, ...number[]],
                createProperties: { windowId },
            })
            await chrome.tabGroups.update(groupId, {
                title: p.title ?? 'MCP Chrome',
                color: p.color ?? 'cyan',
                collapsed: p.collapsed,
            })
            return groupId
        })
    }

    async tabGroupAdd(params: unknown, context: ActionContext): Promise<ManagedGroupChangeResult> {
        const p = TabGroupAddSchema.parse(params)

        const groupId = p.groupId ?? context.mcpTabGroupId
        if (groupId === null || groupId === undefined) {
            throw new ExpectedOperationError('groupPages 需要 groupId，未执行')
        }

        if ((p.tabId !== undefined) === (p.tabIds !== undefined)) {
            throw new ExpectedOperationError('tabId 与 tabIds 必须提供且只能提供一个，未执行')
        }
        const tabIds = p.tabIds ?? [p.tabId!]
        await chrome.tabGroups.get(groupId)
        return this.changeGroups(
            tabIds,
            context,
            'tabgroup_add',
            async () => {
                await chrome.tabs.group({ tabIds: tabIds as [number, ...number[]], groupId })
                return groupId
            },
            groupId
        )
    }

    async tabGroupRemove(params: unknown, context: ActionContext): Promise<ManagedGroupChangeResult> {
        const p = TabGroupRemoveSchema.parse(params)
        return this.changeGroups(p.tabIds, context, 'tabgroup_remove', async () => {
            await chrome.tabs.ungroup(p.tabIds as [number, ...number[]])
        })
    }

    async tabGroupUpdate(params: unknown): Promise<ManagedGroupChangeResult> {
        const { groupId, ...properties } = TabGroupUpdateSchema.parse(params)
        if (Object.values(properties).every((value) => value === undefined)) {
            throw new ExpectedOperationError('updateGroup 需要 title、color 或 collapsed，未执行')
        }
        const before = await chrome.tabGroups.get(groupId)
        const tabsBefore = await chrome.tabs.query({ groupId })
        await chrome.tabGroups.update(groupId, properties)
        const after = await chrome.tabGroups.get(groupId)
        const tabsAfter = await chrome.tabs.query({ groupId })
        return {
            success: true,
            groupId,
            before: [groupToInfo(before, tabsBefore)],
            after: [groupToInfo(after, tabsAfter)],
            tabsBefore: tabsBefore.map((tab) => tabToInfo(tab)),
            tabsAfter: tabsAfter.map((tab) => tabToInfo(tab)),
        }
    }

    async tabGroupMove(params: unknown, context: ActionContext): Promise<ManagedGroupChangeResult> {
        const { groupId, ...properties } = TabGroupMoveSchema.parse(params)
        await chrome.tabGroups.get(groupId)
        const tabs = await chrome.tabs.query({ groupId })
        return this.changeGroups(
            tabs.map((tab) => tab.id!),
            context,
            'tabgroup_move',
            async () => {
                await chrome.tabGroups.move(groupId, properties)
                return groupId
            },
            groupId
        )
    }

    private async changeGroups(
        tabIds: number[],
        context: ActionContext,
        action: string,
        operation: (tabs: chrome.tabs.Tab[]) => Promise<number | void>,
        destinationGroupId?: number
    ): Promise<ManagedGroupChangeResult> {
        const ids = [...new Set(tabIds)]
        if (!ids.length) {
            throw new ExpectedOperationError('分组没有可操作的页面，未执行')
        }
        const tabs = await Promise.all(ids.map((id) => assertManagedTab(id, context, action)))
        const groupIds = new Set(tabs.map((tab) => tab.groupId).filter((id) => id >= 0))
        if (destinationGroupId !== undefined) {
            groupIds.add(destinationGroupId)
        }
        const before = await this.groupInfos(groupIds)
        const tabsBefore = tabs.map((tab) => tabToInfo(tab))
        const current = await Promise.all(ids.map((id) => assertManagedTab(id, context, action)))
        if (
            current.some((tab, index) => tab.groupId !== tabs[index]!.groupId || tab.windowId !== tabs[index]!.windowId)
        ) {
            throw new ExpectedOperationError('分组成员或窗口已变化，未执行分组操作')
        }
        const groupId = await operation(tabs)
        if (groupId !== undefined) {
            groupIds.add(groupId)
        }
        const tabsAfter = await Promise.all(ids.map(async (id) => tabToInfo(await getExistingTab(id))))
        const after = await this.groupInfos(groupIds)
        return { success: true, ...(groupId !== undefined ? { groupId } : {}), before, after, tabsBefore, tabsAfter }
    }

    private async groupInfos(groupIds: Set<number>): Promise<TabGroupInfo[]> {
        const [groups, tabs] = await Promise.all([chrome.tabGroups.query({}), chrome.tabs.query({})])
        return groups.filter((group) => groupIds.has(group.id)).map((group) => groupToInfo(group, tabs))
    }
}
