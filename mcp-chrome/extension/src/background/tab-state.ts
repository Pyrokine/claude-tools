/**
 * Managed tab/window 状态与 storage 恢复。
 */

const STORAGE_KEY = 'mcp_managed_tab_ids'
const CREATED_KEY = 'mcp_created_tab_ids'

let mcpTabGroupId: number | null = null
let mcpWindowId: number | null = null
const managedTabIds = new Set<number>()
const createdTabIds = new Set<number>()

export function isCreatedTab(tabId: number): boolean {
    return createdTabIds.has(tabId)
}

export function getMcpTabGroupId(): number | null {
    return mcpTabGroupId
}

export function getMcpWindowId(): number | null {
    return mcpWindowId
}

export function setMcpTabGroupId(groupId: number | null): void {
    mcpTabGroupId = groupId
}

export function setMcpWindowId(windowId: number | null): void {
    mcpWindowId = windowId
}

export async function markManagedTab(tabId: number, created = false): Promise<void> {
    managedTabIds.add(tabId)
    if (created) {
        createdTabIds.add(tabId)
    }
    await chrome.storage.session.set({
        [STORAGE_KEY]: [...managedTabIds],
        [CREATED_KEY]: [...createdTabIds],
    })
}

export async function unmarkManagedTab(tabId: number): Promise<void> {
    managedTabIds.delete(tabId)
    createdTabIds.delete(tabId)
    await chrome.storage.session.set({
        [STORAGE_KEY]: [...managedTabIds],
        [CREATED_KEY]: [...createdTabIds],
    })
}

export function isManagedTab(
    tab: chrome.tabs.Tab,
    context: { mcpTabGroupId: number | null; mcpWindowId: number | null }
): boolean {
    if (tab.id !== undefined && managedTabIds.has(tab.id)) {
        return true
    }
    return context.mcpTabGroupId !== null && tab.groupId === context.mcpTabGroupId
}

/** Extension 启动时调用，从 storage 恢复 managed tab 集合 */
export async function restoreManagedTabs(): Promise<void> {
    const result = await chrome.storage.session.get([STORAGE_KEY, CREATED_KEY])
    const stored: number[] = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : []
    const created: number[] = Array.isArray(result[CREATED_KEY]) ? result[CREATED_KEY] : []
    for (const id of stored) {
        managedTabIds.add(id)
    }
    for (const id of created) {
        createdTabIds.add(id)
    }
    // 清理 storage 中已关闭的 tab
    const tabs = await chrome.tabs.query({})
    const existingIds = new Set(tabs.map((t) => t.id).filter((id): id is number => id !== undefined))
    for (const id of managedTabIds) {
        if (!existingIds.has(id)) {
            managedTabIds.delete(id)
        }
    }
    for (const id of createdTabIds) {
        if (!existingIds.has(id)) {
            createdTabIds.delete(id)
        }
    }
    await chrome.storage.session.set({ [STORAGE_KEY]: [...managedTabIds], [CREATED_KEY]: [...createdTabIds] })
}
