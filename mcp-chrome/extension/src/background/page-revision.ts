import { ExpectedOperationError } from '../types/expected-errors'

const epoch = crypto.randomUUID()
const revisions = new Map<number, number>()

export function pageRevision(tabId: number): string {
    return `${epoch}:${revisions.get(tabId) ?? 0}`
}

export function advancePageRevision(tabId: number): void {
    revisions.set(tabId, (revisions.get(tabId) ?? 0) + 1)
}

export function forgetPageRevision(tabId: number): void {
    revisions.delete(tabId)
}

export async function pageSnapshot(tabId: number): Promise<{ targetId: string; url: string; revision: string }> {
    const tab = await chrome.tabs.get(tabId)
    return { targetId: String(tabId), url: tab.url ?? '', revision: pageRevision(tabId) }
}

export async function assertPageCondition(
    tabId: number,
    expectedUrl?: string,
    expectedRevision?: string
): Promise<void> {
    const current = await pageSnapshot(tabId)
    if (
        (expectedUrl !== undefined && expectedUrl !== current.url) ||
        (expectedRevision !== undefined && expectedRevision !== current.revision)
    ) {
        throw new ExpectedOperationError(
            JSON.stringify({
                error: {
                    code: 'ACTION_PRECONDITION_FAILED',
                    message: '页面 URL 或 revision 已变化，未执行动作',
                    context: {
                        targetId: current.targetId,
                        expectedUrl: expectedUrl ?? null,
                        expectedRevision: expectedRevision ?? null,
                        actualUrl: current.url,
                        actualRevision: current.revision,
                        actionExecuted: false,
                    },
                },
            })
        )
    }
}
