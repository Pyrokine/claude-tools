/**
 * Managed tab/window 状态与 storage 恢复
 */

const STORAGE_KEY = 'mcp_managed_tab_ids'

let mcpTabGroupId: number | null = null
let mcpWindowId: number | null = null
let storageUpdate: Promise<void> = Promise.resolve()
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

async function updateManagedTabs(update: (ids: Set<number>) => Promise<void> | void): Promise<void> {
    const operation = storageUpdate
        .catch(() => {})
        .then(async () => {
            const next = new Set(managedTabIds)
            await update(next)
            await chrome.storage.session.set({ [STORAGE_KEY]: [...next] })
            managedTabIds.clear()
            for (const id of next) {
                managedTabIds.add(id)
            }
        })
    storageUpdate = operation
    await operation
}

export async function markManagedTab(tabId: number): Promise<void> {
    await updateManagedTabs((ids) => {
        ids.add(tabId)
    })
}

export async function unmarkManagedTab(tabId: number): Promise<void> {
    await updateManagedTabs((ids) => {
        ids.delete(tabId)
    })
}

export function isManagedTab(tab: Pick<chrome.tabs.Tab, 'id'>): boolean {
    return tab.id !== undefined && managedTabIds.has(tab.id)
}

/** Extension 启动时调用，只恢复当前浏览器会话中仍存在的受控 tab */
export async function restoreManagedTabs(): Promise<void> {
    await updateManagedTabs(async (ids) => {
        const result = await chrome.storage.session.get(STORAGE_KEY)
        const stored: unknown[] = Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : []
        const tabs = await chrome.tabs.query({})
        const existingIds = new Set(tabs.map((tab) => tab.id))
        ids.clear()
        for (const id of stored) {
            if (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 && existingIds.has(id)) {
                ids.add(id)
            }
        }
    })
}
