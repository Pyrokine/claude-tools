import { setErrorPageContext } from '../core/errors.js'
import type { getUnifiedSession } from '../core/unified-session.js'
import { isControlledTempOutput, TEMP_OUTPUT_RETENTION } from '../core/utils.js'

type Session = ReturnType<typeof getUnifiedSession>
type Snapshot = Awaited<ReturnType<Session['getPageSnapshot']>>
type ToolResponse = {
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
    isError?: boolean
}

export async function withPageResponse<T extends ToolResponse>(
    session: Session,
    targetId: string | undefined,
    action: () => Promise<T>,
    creatingPage = false
): Promise<T> {
    return session.withTabLock(async () => {
        const defaultTargetIdBefore = session.getCurrentTargetId()
        const targetIdBefore = creatingPage ? null : (targetId ?? defaultTargetIdBefore)
        let before: Snapshot | null = null
        let response: T | undefined
        let failure: unknown
        let failed = false
        try {
            before = targetIdBefore ? await session.getPageSnapshot(targetIdBefore) : null
            response = await action()
        } catch (error) {
            failure = error
            failed = true
        }
        const first = response?.content[0]
        const data: unknown = first?.type === 'text' ? JSON.parse(first.text) : null
        const payload =
            data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null
        const createdTargetId = typeof payload?.createdTargetId === 'string' ? payload.createdTargetId : null
        const defaultTargetIdAfter = session.getCurrentTargetId()
        const actualTargetId = creatingPage
            ? (createdTargetId ?? defaultTargetIdAfter)
            : (targetId ?? targetIdBefore ?? defaultTargetIdAfter)
        let after: Snapshot | null = null
        let contextError: string | undefined
        if (actualTargetId && (!failed || before || !targetIdBefore)) {
            try {
                const targets = await session.listTargets()
                if (targets.some((page) => page.targetId === actualTargetId)) {
                    after = await session.getPageSnapshot(actualTargetId)
                }
            } catch (error) {
                contextError = error instanceof Error ? error.message : String(error)
            }
        }
        let browserActiveTargetId: string | null = null
        let browserActiveTargetStatus: 'reported' | 'unavailable' = 'unavailable'
        if (session.getMode() === 'extension') {
            try {
                const topology = await session.listTopology()
                if (topology) {
                    browserActiveTargetId = topology.activeTargetId ?? null
                    browserActiveTargetStatus = 'reported'
                }
            } catch (error) {
                contextError = error instanceof Error ? error.message : String(error)
            }
        }
        const targetRestoration = session.getTargetRestoration()
        const pageContext = {
            targetId: actualTargetId ?? null,
            targetSource: creatingPage
                ? createdTargetId
                    ? 'created'
                    : failed
                      ? 'unconfirmed'
                      : 'reused'
                : targetId
                  ? 'explicit'
                  : defaultTargetIdBefore
                    ? 'default'
                    : actualTargetId
                      ? 'created'
                      : 'none',
            before,
            after,
            defaultTargetIdBefore,
            defaultTargetIdAfter,
            defaultTargetChanged: defaultTargetIdBefore !== defaultTargetIdAfter,
            browserActiveTargetId,
            browserActiveTargetStatus,
            ...(contextError ? { contextError } : {}),
            ...(targetRestoration ? { targetRestoration } : {}),
        }
        if (failed) {
            throw setErrorPageContext(failure, pageContext)
        }
        if (first?.type === 'text' && payload) {
            const comparison = (payload.metadata as Record<string, unknown> | undefined)?.comparison as
                Record<string, unknown> | undefined
            const temporaryOutput =
                !response?.isError &&
                [payload.output, payload.path, comparison?.diffOutput].some(
                    (path) => typeof path === 'string' && isControlledTempOutput(path)
                )
            first.text = JSON.stringify(
                { ...payload, pageContext, ...(temporaryOutput ? { retention: TEMP_OUTPUT_RETENTION } : {}) },
                null,
                2
            )
        }
        return response!
    })
}

export function withPageContext<T extends ToolResponse>(
    session: Session,
    targetId: string | undefined,
    action: () => Promise<T>
): Promise<T> {
    return withPageResponse(session, targetId, () => session.withTabId(targetId, action))
}
