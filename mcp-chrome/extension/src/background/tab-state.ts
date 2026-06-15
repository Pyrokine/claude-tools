/**
 * Managed tab/window 状态与 storage 恢复。
 */

const STORAGE_KEY = 'mcp_managed_tab_ids'

let mcpTabGroupId: number | null = null
let mcpWindowId: number | null = null
const managedTabIds = new Set<number>()

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

export async function markManagedTab(tabId: number): Promise<void> {
    managedTabIds.add(tabId)
    await chrome.storage.local.set({ [STORAGE_KEY]: [...managedTabIds] })
}

export async function unmarkManagedTab(tabId: number): Promise<void> {
    managedTabIds.delete(tabId)
    await chrome.storage.local.set({ [STORAGE_KEY]: [...managedTabIds] })
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
    const result = await chrome.storage.local.get(STORAGE_KEY)
    const stored: number[] = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : []
    for (const id of stored) {
        managedTabIds.add(id)
    }
    // 清理 storage 中已关闭的 tab
    const tabs = await chrome.tabs.query({})
    const existingIds = new Set(tabs.map((t) => t.id).filter((id): id is number => id !== undefined))
    for (const id of managedTabIds) {
        if (!existingIds.has(id)) {
            managedTabIds.delete(id)
        }
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: [...managedTabIds] })
}
