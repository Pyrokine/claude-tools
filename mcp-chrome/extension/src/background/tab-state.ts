/**
 * Managed tab/window 状态与 storage 恢复
 */

const LEGACY_STORAGE_KEY = 'mcp_managed_tab_ids'
const STORAGE_KEY = 'mcp_managed_tabs_v1'
const GENERATION_KEY = 'mcp_managed_tabs_generation_v1'

interface ManagedTabRecord {
    tabId: number
    documentId: string | null
}

interface ManagedTabSnapshot {
    version: 1
    generation: string
    tabs: ManagedTabRecord[]
}

let mcpTabGroupId: number | null = null
let mcpWindowId: number | null = null
let storageUpdate: Promise<void> = Promise.resolve()
let initialization: Promise<void> | null = null
let generation = ''
let managedTabs = new Map<number, string | null>()

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

async function documentIdForTab(tabId: number): Promise<string | null> {
    try {
        const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 })
        if (frame?.documentId) {
            return frame.documentId
        }
    } catch (error) {
        console.warn(
            `[MCP] Managed page ${tabId} has no document identity; automatic recovery after Extension reload is unavailable:`,
            error
        )
        return null
    }
    console.warn(
        `[MCP] Managed page ${tabId} has no document identity; automatic recovery after Extension reload is unavailable`
    )
    return null
}

async function commitManagedTabs(tabs: Map<number, string | null>, sessionGeneration: string): Promise<void> {
    const snapshot: ManagedTabSnapshot = {
        version: 1,
        generation: sessionGeneration,
        tabs: [...tabs].map(([tabId, documentId]) => ({ tabId, documentId })),
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: snapshot })
    managedTabs = tabs
    generation = sessionGeneration
}

async function updateManagedTabs(
    update: (tabs: Map<number, string | null>) => Promise<boolean> | boolean
): Promise<void> {
    const operation = storageUpdate
        .catch(() => {})
        .then(async () => {
            await restoreManagedTabs()
            const next = new Map(managedTabs)
            if (await update(next)) {
                await commitManagedTabs(next, generation)
            }
        })
    storageUpdate = operation
    await operation
}

export async function markManagedTab(tabId: number): Promise<void> {
    await updateManagedTabs(async (tabs) => {
        tabs.set(tabId, await documentIdForTab(tabId))
        return true
    })
}

export async function unmarkManagedTab(tabId: number): Promise<void> {
    await updateManagedTabs((tabs) => tabs.delete(tabId))
}

export async function updateManagedTabDocument(tabId: number): Promise<void> {
    await updateManagedTabs(async (tabs) => {
        if (!tabs.has(tabId)) {
            return false
        }
        tabs.set(tabId, await documentIdForTab(tabId))
        return true
    })
}

export function isManagedTab(tab: Pick<chrome.tabs.Tab, 'id'>): boolean {
    return tab.id !== undefined && managedTabs.has(tab.id)
}

/** 同代际恢复现有 tab，跨代际只恢复原生 documentId 匹配的页面 */
export function restoreManagedTabs(): Promise<void> {
    if (initialization === null) {
        initialization = (async () => {
            const session = await chrome.storage.session.get([GENERATION_KEY, LEGACY_STORAGE_KEY])
            const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as ManagedTabSnapshot | undefined
            if (
                stored !== undefined &&
                (stored === null || stored.version !== 1 || typeof stored.generation !== 'string' ||
                    !stored.generation || !Array.isArray(stored.tabs))
            ) {
                throw new Error('Invalid managed page storage snapshot')
            }
            const sessionGeneration = typeof session[GENERATION_KEY] === 'string' && session[GENERATION_KEY]
                ? session[GENERATION_KEY] as string
                : crypto.randomUUID()
            if (session[GENERATION_KEY] !== sessionGeneration) {
                await chrome.storage.session.set({ [GENERATION_KEY]: sessionGeneration })
            }
            const existingIds = new Set((await chrome.tabs.query({})).map((tab) => tab.id))
            const legacy: unknown[] = Array.isArray(session[LEGACY_STORAGE_KEY]) ? session[LEGACY_STORAGE_KEY] : []
            const records: ManagedTabRecord[] = stored?.tabs ?? legacy
                .filter((id): id is number => typeof id === 'number')
                .map((tabId) => ({ tabId, documentId: null }))
            const next = new Map<number, string | null>()
            for (const record of records) {
                if (
                    !record || !Number.isSafeInteger(record.tabId) || record.tabId < 0 || !existingIds.has(record.tabId)
                ) {
                    continue
                }
                const documentId = await documentIdForTab(record.tabId)
                if (
                    stored && stored.generation !== sessionGeneration &&
                    (typeof record.documentId !== 'string' || !record.documentId || record.documentId !== documentId)
                ) {
                    console.warn(
                        `[MCP] Managed page ${record.tabId} was not restored: native document identity does not match`
                    )
                    continue
                }
                next.set(record.tabId, documentId)
            }
            await commitManagedTabs(next, sessionGeneration)
            if (session[LEGACY_STORAGE_KEY] !== undefined) {
                try {
                    await chrome.storage.session.remove(LEGACY_STORAGE_KEY)
                } catch (error) {
                    console.warn('[MCP] Failed to remove migrated managed page IDs:', error)
                }
            }
        })()
        void initialization.catch(() => {
            initialization = null
        })
    }
    return initialization
}
