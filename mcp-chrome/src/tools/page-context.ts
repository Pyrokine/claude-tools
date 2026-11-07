import { formatErrorResponse, getErrorPageContext, getErrorSource, setErrorPageContext } from '../core/errors.js'
import type { getUnifiedSession } from '../core/index.js'
import type { UserActionKind } from '../core/browser-driver.js'
import { sanitizeUrlRecord } from './network-sanitizer.js'
import { isControlledTempOutput, remainingNavigationTimeout, TEMP_OUTPUT_RETENTION } from '../core/utils.js'

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
    creatingPage = false,
    deadline?: number,
    signal?: AbortSignal,
    independentMetadata = false
): Promise<T> {
    const withContext = independentMetadata
        ? session.withMetadataContext.bind(session)
        : session.withTabLock.bind(session)
    return withContext(
        async () => {
            const remaining = () => (deadline === undefined ? undefined : remainingNavigationTimeout(deadline))
            const defaultTargetIdBefore = session.getCurrentTargetId()
            const targetIdBefore = creatingPage ? null : (targetId ?? defaultTargetIdBefore)
            let before: Snapshot | null = null
            let response: T | undefined
            let failure: unknown
            let failed = false
            let beforeReadFailed = false
            try {
                try {
                    before = targetIdBefore ? await session.getPageSnapshot(targetIdBefore, remaining()) : null
                } catch (error) {
                    beforeReadFailed = true
                    throw error
                }
                signal?.throwIfAborted()
                session.assertRequestActive?.()
                response = await action()
            } catch (error) {
                failure = error
                failed = true
            }
            const first = response?.content[0]
            const data: unknown = first?.type === 'text' ? JSON.parse(first.text) : null
            const payload =
                data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null
            const failureBody = failed ? JSON.parse(formatErrorResponse(failure).content[0]!.text) : null
            const responseError = payload?.error as { context?: Record<string, unknown> } | undefined
            const creationContext = (failureBody?.error?.context ?? responseError?.context) as
                Record<string, unknown> | undefined
            const createdId = payload?.createdTargetId ?? creationContext?.createdTargetId
            const createdTargetId = typeof createdId === 'string' ? createdId : null
            const defaultTargetIdAfter = session.getCurrentTargetId()
            const actualTargetId = creatingPage
                ? (createdTargetId ?? (failed || response?.isError ? null : defaultTargetIdAfter))
                : (targetId ?? targetIdBefore ?? defaultTargetIdAfter)
            let after: Snapshot | null = null
            let contextError: string | undefined
            const requestActive = () => {
                try {
                    signal?.throwIfAborted()
                    session.assertRequestActive?.()
                    if (
                        (failed && getErrorSource(failure) === 'budget') ||
                        (deadline !== undefined && Date.now() >= deadline)
                    ) {
                        contextError = '请求已结束，未继续读取页面状态'
                        return false
                    }
                    return true
                } catch (error) {
                    contextError = error instanceof Error ? error.message : String(error)
                    return false
                }
            }
            const activeAfterAction = requestActive()
            if (actualTargetId && failed && targetIdBefore && !before) {
                contextError = '操作前页面状态读取失败，未继续读取页面状态'
            }
            if (activeAfterAction && actualTargetId && (!failed || before || !targetIdBefore)) {
                try {
                    const targets = await session.listTargets(remaining(), { preserveDefaultTarget: true })
                    if (requestActive() && targets.some((page) => page.targetId === actualTargetId)) {
                        after = await session.getPageSnapshot(actualTargetId, remaining())
                    }
                } catch (error) {
                    contextError = error instanceof Error ? error.message : String(error)
                }
            }
            let browserActiveTargetId: string | null = null
            let browserActiveTargetStatus: 'reported' | 'unavailable' = 'unavailable'
            if (requestActive() && session.getMode() === 'extension') {
                try {
                    const topology = await session.listTopology(remaining(), { preserveDefaultTarget: true })
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
                        : failed || response?.isError
                          ? 'unconfirmed'
                          : 'reused'
                    : targetId
                      ? 'explicit'
                      : defaultTargetIdBefore
                        ? 'default'
                        : actualTargetId
                          ? 'created'
                          : 'none',
                before: before ? sanitizeUrlRecord(before) : null,
                after: after ? sanitizeUrlRecord(after) : null,
                defaultTargetIdBefore,
                defaultTargetIdAfter,
                defaultTargetChanged: defaultTargetIdBefore !== defaultTargetIdAfter,
                browserActiveTargetId,
                browserActiveTargetStatus,
                ...(contextError ? { contextError } : {}),
                ...(failed
                    ? {
                          contextPhase: beforeReadFailed
                              ? 'before'
                              : getErrorPageContext(failure)?.contextPhase === 'precondition'
                                ? 'precondition'
                                : getErrorPageContext(failure)?.contextPhase === 'preparation'
                                  ? 'preparation'
                                  : 'action',
                      }
                    : {}),
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
        },
        deadline,
        signal
    )
}

export function withPageContext<T extends ToolResponse>(
    session: Session,
    targetId: string | undefined,
    action: () => Promise<T>,
    deadline?: number,
    signal?: AbortSignal,
    userAction?: UserActionKind
): Promise<T> {
    const run = () => session.withTabId(targetId, action, deadline)
    return withPageResponse(
        session,
        targetId,
        userAction ? () => session.withUserAction(userAction, run) : run,
        false,
        deadline,
        signal
    )
}
