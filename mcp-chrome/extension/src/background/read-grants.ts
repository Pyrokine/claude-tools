import { getExistingTab, pageRevision } from './page-revision'

const KEY_PREFIX = 'mcp_read_grants_v4_'
const locks = new Map<string, Promise<void>>()
const revokedInstances = new Set<string>()

interface ReadGrant {
    tabId: number
    url: string
    documentId: string
    revision: string
}

async function getGrants(instanceId: string): Promise<ReadGrant[]> {
    const value: unknown = (await chrome.storage.session.get(KEY_PREFIX + instanceId))[KEY_PREFIX + instanceId]
    return Array.isArray(value)
        ? value.filter(
              (item): item is ReadGrant =>
                  item !== null &&
                  typeof item === 'object' &&
                  Number.isSafeInteger(item.tabId) &&
                  item.tabId >= 0 &&
                  typeof item.url === 'string' &&
                  typeof item.documentId === 'string' &&
                  item.documentId.length > 0 &&
                  typeof item.revision === 'string'
          )
        : []
}

async function update(instanceId: string, action: () => Promise<void>): Promise<void> {
    const previous = locks.get(instanceId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(action)
    locks.set(instanceId, next)
    try {
        await next
    } finally {
        if (locks.get(instanceId) === next) {
            locks.delete(instanceId)
        }
    }
}

export async function readGrantDocumentId(
    instanceId: string | null | undefined,
    tabId: number
): Promise<string | null> {
    if (!instanceId || revokedInstances.has(instanceId)) {
        return null
    }
    const tab = await getExistingTab(tabId)
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 })
    if (!frame?.documentId) {
        return null
    }
    const revision = pageRevision(tabId)
    const grant = (await getGrants(instanceId)).find(
        (item) => item.tabId === tabId && item.url === tab.url && item.documentId === frame.documentId
    )
    if (!grant || revokedInstances.has(instanceId)) {
        return null
    }
    if (grant.revision === revision) {
        return frame.documentId
    }
    if (grant.revision.split(':', 1)[0] === revision.split(':', 1)[0]) {
        return null
    }

    let documentId: string | null = null
    await update(instanceId, async () => {
        if (revokedInstances.has(instanceId)) {
            return
        }
        const currentTab = await getExistingTab(tabId)
        const currentFrame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 })
        const currentRevision = pageRevision(tabId)
        const grants = await getGrants(instanceId)
        const currentGrant = grants.find(
            (item) =>
                item.tabId === tabId &&
                item.url === currentTab.url &&
                item.documentId === currentFrame?.documentId &&
                (item.revision === currentRevision ||
                    item.revision.split(':', 1)[0] !== currentRevision.split(':', 1)[0])
        )
        if (!currentGrant || !currentFrame?.documentId) {
            return
        }
        currentGrant.revision = currentRevision
        await chrome.storage.session.set({ [KEY_PREFIX + instanceId]: grants })
        documentId = currentFrame.documentId
    })
    return revokedInstances.has(instanceId) ? null : documentId
}

export async function hasReadGrant(instanceId: string | null | undefined, tabId: number): Promise<boolean> {
    return (await readGrantDocumentId(instanceId, tabId)) !== null
}

export async function setReadGrant(
    instanceId: string,
    tabId: number,
    allow: boolean,
    expected?: { url: string; revision: string }
): Promise<void> {
    await update(instanceId, async () => {
        const grants = (revokedInstances.has(instanceId) ? [] : await getGrants(instanceId)).filter(
            (grant) => grant.tabId !== tabId
        )
        if (allow) {
            const tab = await getExistingTab(tabId)
            const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 })
            if (!frame?.documentId) {
                throw new Error('无法确认当前页面身份，未授予只读权限')
            }
            const revision = pageRevision(tabId)
            const currentTab = await getExistingTab(tabId)
            const currentFrame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 })
            if (
                currentTab.url !== tab.url ||
                currentFrame?.documentId !== frame.documentId ||
                pageRevision(tabId) !== revision ||
                (expected && (expected.url !== tab.url || expected.revision !== revision))
            ) {
                throw new Error('页面身份已变化，未授予只读权限')
            }
            grants.push({ tabId, url: tab.url ?? '', documentId: frame.documentId, revision })
        }
        await chrome.storage.session.set({ [KEY_PREFIX + instanceId]: grants })
        if (allow) {
            revokedInstances.delete(instanceId)
        }
    })
}

export async function revokeReadGrants(instanceId: string): Promise<void> {
    revokedInstances.add(instanceId)
    await update(instanceId, () => chrome.storage.session.remove(KEY_PREFIX + instanceId))
}

export async function revokeTabReadGrants(tabId: number): Promise<void> {
    const all = await chrome.storage.session.get(null)
    for (const key of Object.keys(all).filter((item) => item.startsWith(KEY_PREFIX))) {
        await setReadGrant(key.slice(KEY_PREFIX.length), tabId, false)
    }
}
