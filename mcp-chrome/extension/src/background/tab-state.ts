/** Managed page identities, task metadata and native group relationships */
import type { PageMetadata } from '../types'

const LEGACY_STORAGE_KEY = 'mcp_managed_tab_ids'
const STORAGE_KEY = 'mcp_managed_tabs_v1'
const GENERATION_KEY = 'mcp_managed_tabs_generation_v1'

interface ManagedTabRecord {
    tabId: number
    documentId: string | null
    managed: boolean
    origin: PageMetadata['origin']
    metadata: Omit<PageMetadata, 'origin'>
    trustedGroupId?: number
    trustedWindowId?: number
}

interface ManagedTabSnapshot {
    version: 1 | 2
    generation: string
    tabs: ManagedTabRecord[]
}

let mcpTabGroupId: number | null = null
let mcpWindowId: number | null = null
let storageUpdate: Promise<void> = Promise.resolve()
let initialization: Promise<void> | null = null
let generation = ''
let managedTabs = new Map<number, ManagedTabRecord>()

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

export function getManagedTabRecord(tabId: number): ManagedTabRecord | undefined {
    const record = managedTabs.get(tabId)
    return record ? { ...record, metadata: { ...record.metadata } } : undefined
}

export function getManagedTabMetadata(tabId: number): PageMetadata {
    const record = managedTabs.get(tabId)
    return record
        ? { ...record.metadata, origin: record.origin }
        : { origin: 'unknown', createdBy: 'unknown', createdAt: null, lastUsedAt: null }
}

async function documentIdForTab(tabId: number): Promise<string | null> {
    try {
        const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 })
        if (frame?.documentId) {
            return frame.documentId
        }
    } catch (error) {
        console.warn(`[MCP] Managed page ${tabId} identity unavailable; reload recovery is unavailable:`, error)
        return null
    }
    console.warn(`[MCP] Managed page ${tabId} identity unavailable; reload recovery is unavailable`)
    return null
}

async function commitManagedTabs(
    tabs: Map<number, ManagedTabRecord>,
    sessionGeneration: string,
    assertActive?: () => void
): Promise<void> {
    const snapshot: ManagedTabSnapshot = { version: 2, generation: sessionGeneration, tabs: [...tabs.values()] }
    assertActive?.()
    await chrome.storage.local.set({ [STORAGE_KEY]: snapshot })
    managedTabs = tabs
    generation = sessionGeneration
}

async function updateManagedTabs(
    update: (tabs: Map<number, ManagedTabRecord>) => Promise<boolean> | boolean,
    assertActive?: () => void
): Promise<void> {
    const operation = storageUpdate
        .catch(() => {})
        .then(async () => {
            assertActive?.()
            await restoreManagedTabs()
            assertActive?.()
            const next = new Map(
                [...managedTabs].map(([id, record]) => [id, { ...record, metadata: { ...record.metadata } }])
            )
            if (await update(next)) {
                await commitManagedTabs(next, generation, assertActive)
            }
        })
    storageUpdate = operation
    await operation
}

export async function markManagedTab(
    tabId: number,
    origin: PageMetadata['origin'] = 'adopted',
    updates: { taskHint?: string | null; note?: string | null } = {},
    assertActive?: () => void
): Promise<void> {
    await updateManagedTabs(async (tabs) => {
        const previous = tabs.get(tabId)
        const now = new Date().toISOString()
        const metadata = { ...getManagedTabMetadata(tabId), lastUsedAt: now }
        if (!previous?.managed || (origin === 'adopted' && previous.origin === 'unknown')) {
            metadata.origin = origin
            metadata.createdBy = origin === 'created' ? 'mcp-chrome' : 'unknown'
            metadata.createdAt = origin === 'created' ? now : null
        }
        for (const field of ['taskHint', 'note'] as const) {
            if (updates[field] === null) {
                delete metadata[field]
            } else if (updates[field] !== undefined) {
                metadata[field] = updates[field]
            }
        }
        const { origin: savedOrigin, ...savedMetadata } = metadata
        tabs.set(tabId, {
            ...previous,
            tabId,
            documentId: await documentIdForTab(tabId),
            managed: true,
            origin: savedOrigin,
            metadata: savedMetadata,
        })
        return true
    }, assertActive)
}

export async function updateManagedTabMetadata(
    tabId: number,
    updates: { taskHint?: string | null; note?: string | null },
    assertActive?: () => void
): Promise<PageMetadata> {
    await updateManagedTabs(async (tabs) => {
        const previous = tabs.get(tabId)
        const { origin, ...metadata } = getManagedTabMetadata(tabId)
        for (const field of ['taskHint', 'note'] as const) {
            if (updates[field] === null) {
                delete metadata[field]
            } else if (updates[field] !== undefined) {
                metadata[field] = updates[field]
            }
        }
        metadata.lastUsedAt = new Date().toISOString()
        tabs.set(tabId, {
            ...previous,
            tabId,
            documentId: previous?.documentId ?? (await documentIdForTab(tabId)),
            managed: previous?.managed ?? false,
            origin,
            metadata,
        })
        return true
    }, assertActive)
    return getManagedTabMetadata(tabId)
}

export async function setManagedTabGroup(tabId: number, groupId: number, windowId: number): Promise<void> {
    await updateManagedTabs((tabs) => {
        const record = tabs.get(tabId)
        if (!record?.managed || record.origin !== 'created') {
            return false
        }
        record.trustedGroupId = groupId
        record.trustedWindowId = windowId
        return true
    })
}

/** Native membership, never a group title, establishes reusable task groups */
export async function refreshManagedTabRelations(assertActive?: () => void): Promise<void> {
    await updateManagedTabs(async (records) => {
        const tabs = await chrome.tabs.query({})
        const byId = new Map(tabs.map((tab) => [tab.id, tab]))
        let changed = false
        const invalidGroups = new Set<number>()
        for (const record of records.values()) {
            if (record.trustedGroupId === undefined) {
                continue
            }
            const tab = byId.get(record.tabId)
            if (!tab || tab.groupId !== record.trustedGroupId || tab.windowId !== record.trustedWindowId) {
                delete record.trustedGroupId
                delete record.trustedWindowId
                changed = true
            }
        }
        for (const record of records.values()) {
            if (record.trustedGroupId === undefined) {
                continue
            }
            const members = tabs.filter((member) => member.groupId === record.trustedGroupId)
            if (
                members.some((member) => {
                    const owner = member.id === undefined ? undefined : records.get(member.id)
                    return (
                        !owner?.managed ||
                        owner.origin !== 'created' ||
                        owner.trustedGroupId !== record.trustedGroupId ||
                        owner.trustedWindowId !== member.windowId
                    )
                })
            ) {
                invalidGroups.add(record.trustedGroupId)
            }
        }
        for (const [id, record] of records) {
            if (!byId.has(id)) {
                records.delete(id)
                changed = true
            } else if (record.trustedGroupId !== undefined && invalidGroups.has(record.trustedGroupId)) {
                delete record.trustedGroupId
                delete record.trustedWindowId
                changed = true
            }
        }
        return changed
    }, assertActive)
}

export async function unmarkManagedTab(tabId: number, assertActive?: () => void): Promise<void> {
    await updateManagedTabs((tabs) => tabs.delete(tabId), assertActive)
}

export async function updateManagedTabDocument(tabId: number): Promise<void> {
    await updateManagedTabs(async (tabs) => {
        const record = tabs.get(tabId)
        if (!record) {
            return false
        }
        record.documentId = await documentIdForTab(tabId)
        return true
    })
}

export function isManagedTab(tab: Pick<chrome.tabs.Tab, 'id'>): boolean {
    return tab.id !== undefined && managedTabs.get(tab.id)?.managed === true
}

/** Same-generation restore preserves access; a new browser generation requires the exact native document */
export function restoreManagedTabs(): Promise<void> {
    if (initialization === null) {
        initialization = (async () => {
            const session = await chrome.storage.session.get([GENERATION_KEY, LEGACY_STORAGE_KEY])
            const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as ManagedTabSnapshot | undefined
            if (
                stored !== undefined &&
                (stored === null ||
                    ![1, 2].includes(stored.version) ||
                    typeof stored.generation !== 'string' ||
                    !stored.generation ||
                    !Array.isArray(stored.tabs))
            ) {
                throw new Error('Invalid managed page storage snapshot')
            }
            const sessionGeneration =
                typeof session[GENERATION_KEY] === 'string' && session[GENERATION_KEY]
                    ? (session[GENERATION_KEY] as string)
                    : crypto.randomUUID()
            if (session[GENERATION_KEY] !== sessionGeneration) {
                await chrome.storage.session.set({ [GENERATION_KEY]: sessionGeneration })
            }
            const existingIds = new Set((await chrome.tabs.query({})).map((tab) => tab.id))
            const legacy: unknown[] = Array.isArray(session[LEGACY_STORAGE_KEY]) ? session[LEGACY_STORAGE_KEY] : []
            const records =
                stored?.tabs ??
                legacy
                    .filter((id): id is number => typeof id === 'number')
                    .map((tabId) => ({ tabId, documentId: null }))
            const next = new Map<number, ManagedTabRecord>()
            for (const entry of records) {
                const record = entry as ManagedTabRecord
                if (
                    !record ||
                    !Number.isSafeInteger(record.tabId) ||
                    record.tabId < 0 ||
                    !existingIds.has(record.tabId)
                ) {
                    continue
                }
                const documentId = await documentIdForTab(record.tabId)
                if (
                    stored &&
                    stored.generation !== sessionGeneration &&
                    (typeof record.documentId !== 'string' || !record.documentId || record.documentId !== documentId)
                ) {
                    console.warn(
                        `[MCP] Managed page ${record.tabId} was not restored: native document identity differs`
                    )
                    continue
                }
                const current = stored?.version === 2
                next.set(record.tabId, {
                    tabId: record.tabId,
                    documentId,
                    managed: current ? record.managed : true,
                    origin: current ? record.origin : 'unknown',
                    metadata: current ? record.metadata : { createdBy: 'unknown', createdAt: null, lastUsedAt: null },
                    ...(current && record.trustedGroupId !== undefined
                        ? {
                              trustedGroupId: record.trustedGroupId,
                              trustedWindowId: record.trustedWindowId,
                          }
                        : {}),
                })
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
