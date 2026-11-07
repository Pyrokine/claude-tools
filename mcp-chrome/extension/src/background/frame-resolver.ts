import { ExpectedOperationError, wrapDebuggerError } from '../types/expected-errors'
import { EvaluateInFrameSchema, GetAllFramesSchema, ResolveFrameSchema } from '../types/schemas'
import {
    type ActionContext,
    type DomFrameSnapshot,
    assertActionActive,
    assertManagedTab,
    assertReadableTab,
    assertScriptable,
    getDomFrameSnapshot,
    getTargetTabId,
    probeCdpFrameOwner,
    resolveCdpFramePath,
} from './action-utils.js'
import type { DebuggerManager } from './debugger-manager.js'
import { readGrantDocumentId } from './read-grants.js'

export class FrameResolver {
    constructor(private debuggerManager: DebuggerManager) {}

    async resolveFrame(
        params: unknown,
        context: ActionContext
    ): Promise<{ frameId: number; offset: { x: number; y: number } | null; frameContext?: Record<string, unknown> }> {
        const p = ResolveFrameSchema.parse(params)
        const tabId = await getTargetTabId(p.tabId)
        const readable = await assertReadableTab(tabId, context, 'resolve_frame')
        await assertScriptable(tabId)
        const root = await this.getExtensionFrameIdentity(tabId, 0)
        if (readable.documentId && readable.documentId !== root.documentId) {
            throw new ExpectedOperationError('resolve_frame 授权文档已变化，未读取')
        }
        const selections = Array.isArray(p.frame) ? p.frame : [p.frame]
        let parentFrameId = 0
        let offset = { x: 0, y: 0 }
        const path: Array<Record<string, unknown>> = []
        let identity = root
        for (const selection of selections) {
            assertActionActive(context)
            const parent = await this.getExtensionFrameIdentity(tabId, parentFrameId)
            const snapshot = await getDomFrameSnapshot(
                tabId,
                parentFrameId,
                selection,
                parent.documentId,
                parent.url,
                context
            )
            const currentRoot = await this.getExtensionFrameIdentity(tabId, 0)
            if (
                currentRoot.documentId !== root.documentId ||
                (readable.documentId &&
                    (await readGrantDocumentId(context.serverInstanceId, tabId, () => assertActionActive(context))) !==
                        readable.documentId)
            ) {
                throw new ExpectedOperationError('resolve_frame 页面或授权已变化，未读取')
            }
            if (snapshot.selectionStatus !== 'found' || snapshot.selectedIndex === null) {
                throw this.frameEvaluationError(
                    snapshot.selectionStatus === 'invalid-selector'
                        ? 'INVALID_FRAME_SELECTOR'
                        : snapshot.selectionStatus === 'not-frame'
                          ? 'FRAME_NOT_IFRAME'
                          : 'FRAME_NOT_FOUND',
                    'iframe not found: ' + String(selection) + ' (' + snapshot.selectionStatus + ')',
                    {
                        tabId,
                        phase: 'frame_resolution',
                        selection,
                        path,
                        selectionStatus: snapshot.selectionStatus,
                        domFrameCount: snapshot.frames.length,
                    }
                )
            }
            const selected = snapshot.frames.find((frame) => frame.index === snapshot.selectedIndex)
            if (!selected || selected.frameId === null) {
                throw this.frameEvaluationError(
                    'FRAME_IDENTITY_UNAVAILABLE',
                    'Cannot map selected DOM iframe to one Chrome frameId',
                    { tabId, selection, path, candidateFrameIds: selected?.candidateFrameIds ?? [] }
                )
            }
            identity = await this.getExtensionFrameIdentity(tabId, selected.frameId)
            const currentParent = await this.getExtensionFrameIdentity(tabId, parentFrameId)
            if (
                identity.parentFrameId !== parentFrameId ||
                currentParent.documentId !== parent.documentId ||
                (identity.parentDocumentId && identity.parentDocumentId !== parent.documentId)
            ) {
                throw this.frameEvaluationError(
                    'FRAME_IDENTITY_CHANGED',
                    'Frame parent document changed during resolution',
                    { tabId, path, selection, actionExecuted: false }
                )
            }
            offset = { x: offset.x + selected.contentOffset.x, y: offset.y + selected.contentOffset.y }
            path.push({ selection, domIndex: selected.index, ...this.frameIdentitySummary(identity) })
            parentFrameId = identity.frameId
        }
        return {
            frameId: identity.frameId,
            offset,
            frameContext: { tabId, ...this.frameIdentitySummary(identity), domIndex: path.at(-1)?.domIndex, path },
        }
    }

    async getAllFrames(
        params: unknown,
        context: ActionContext
    ): Promise<{
        frames: Array<{
            index: number
            frameId: number
            parentFrameId: number | null
            url: string
            title: string | null
            name: string | null
            selector: string | null
            rect: { x: number; y: number; width: number; height: number } | null
            unavailableReason?: string
        }>
        unavailableFrames?: DomFrameSnapshot['unavailableFrames']
    }> {
        const p = GetAllFramesSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)
        const readable = await assertReadableTab(tabId, context, 'get_all_frames')
        await assertScriptable(tabId)

        const frames = await chrome.webNavigation.getAllFrames({ tabId })
        if (!frames) {
            throw new Error('Failed to get frames')
        }

        const snapshot = await getDomFrameSnapshot(tabId, 0, undefined, readable.documentId, readable.tab.url, context)
        if (
            readable.documentId &&
            (await readGrantDocumentId(context.serverInstanceId, tabId, () => assertActionActive(context))) !==
                readable.documentId
        ) {
            throw new ExpectedOperationError('get_all_frames 页面已变化，未读取')
        }
        const domFramesByFrameId = new Map(
            snapshot.frames
                .filter((frame): frame is typeof frame & { frameId: number } => frame.frameId !== null)
                .map((frame) => [frame.frameId, frame] as const)
        )
        const unavailableFrames = new Map(snapshot.unavailableFrames?.map((frame) => [frame.frameId, frame.error]))

        return {
            ...(snapshot.unavailableFrames ? { unavailableFrames: snapshot.unavailableFrames } : {}),
            frames: frames.map((frame, index) => {
                const isMainFrame = frame.frameId === 0
                const dom = isMainFrame ? undefined : domFramesByFrameId.get(frame.frameId)
                return {
                    index,
                    frameId: frame.frameId,
                    parentFrameId: isMainFrame ? null : frame.parentFrameId,
                    url: frame.url,
                    title: isMainFrame ? snapshot.parent.title : (dom?.title ?? null),
                    name: isMainFrame ? null : (dom?.name ?? null),
                    selector: isMainFrame ? null : (dom?.selector ?? null),
                    rect: isMainFrame ? snapshot.parent.rect : (dom?.rect ?? null),
                    ...(unavailableFrames.has(frame.frameId)
                        ? { unavailableReason: unavailableFrames.get(frame.frameId) }
                        : {}),
                }
            }),
        }
    }

    /**
     * 在指定 iframe 中以 precise 模式执行 JS
     *
     * 通过 Runtime.enable 获取 iframe 的执行上下文 ID，
     * 然后用 Runtime.evaluate + contextId 在 iframe 主世界中执行代码，绕过 CSP
     */
    async evaluateInFrame(params: unknown, context: ActionContext): Promise<unknown> {
        const p = EvaluateInFrameSchema.parse(params)
        const options = params as { returnByValue?: boolean; awaitPromise?: boolean }
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'evaluate_in_frame')
        await this.debuggerManager.ensureAttached(tabId)
        const startedAt = Date.now()
        assertActionActive(context)
        const originalFrame = await this.getExtensionFrameIdentity(tabId, p.frameId)
        let retryAttempted = false
        let retryReason: string | undefined
        const maxAttempts = p.staleContextRetry === 'readOnly' ? 2 : 1

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            assertActionActive(context)
            const remaining = p.timeout === undefined ? undefined : p.timeout - (Date.now() - startedAt)
            if (remaining !== undefined && remaining <= 0) {
                throw this.frameEvaluationError(
                    'FRAME_EVALUATION_TIMEOUT',
                    'Frame evaluation timed out before resolution',
                    {
                        tabId,
                        extensionFrameId: p.frameId,
                        timeout: p.timeout,
                        retryAttempted,
                        retryReason,
                    }
                )
            }
            let identity = originalFrame
            let resolved: { cdpFrameId: string; querySessionId?: string; ownerSessionId?: string }
            try {
                identity = await this.getExtensionFrameIdentity(tabId, p.frameId)
                const resolutionDeadline = startedAt + (p.timeout ?? 2000)
                for (;;) {
                    if (
                        identity.parentFrameId !== originalFrame.parentFrameId ||
                        identity.frameId !== originalFrame.frameId
                    ) {
                        // noinspection ExceptionCaughtLocallyJS -- Report failure
                        throw this.frameEvaluationError(
                            'FRAME_IDENTITY_CHANGED',
                            'Frame identity changed before stale-context retry; refusing to guess target',
                            {
                                tabId,
                                retryAttempted,
                                retryReason,
                                originalFrame: this.frameIdentitySummary(originalFrame),
                                currentFrame: this.frameIdentitySummary(identity),
                            }
                        )
                    }
                    try {
                        resolved = await this.resolveCdpFrame(tabId, identity, context)
                        break
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error)
                        if (
                            !retryAttempted ||
                            message !== `No document with id ${identity.documentId} in tab with id ${tabId}`
                        ) {
                            // noinspection ExceptionCaughtLocallyJS -- Report failure
                            throw error
                        }
                        const remainingResolution = resolutionDeadline - Date.now()
                        if (remainingResolution <= 0) {
                            // noinspection ExceptionCaughtLocallyJS -- Report failure
                            throw new Error('Frame document resolution timed out after stale execution context', {
                                cause: error,
                            })
                        }
                        await new Promise((resolve) => setTimeout(resolve, Math.min(25, remainingResolution)))
                        identity = await this.getExtensionFrameIdentity(tabId, p.frameId)
                    }
                }
            } catch (error) {
                if (!retryAttempted) {
                    throw error
                }
                throw this.frameEvaluationError(
                    'FRAME_EVALUATION_FAILED',
                    (error instanceof Error ? error.message : String(error)).slice(0, 500),
                    {
                        tabId,
                        ...this.frameIdentitySummary(identity),
                        phase: 'retry_resolution',
                        retryAttempted,
                        retryReason,
                    }
                )
            }
            const queryTarget = { tabId, ...(resolved.querySessionId ? { sessionId: resolved.querySessionId } : {}) }
            let contexts = this.debuggerManager
                .getExecutionContexts(tabId)
                .filter((item) => item.sessionId === resolved.querySessionId)
            if (contexts.length === 0 || attempt > 0) {
                await chrome.debugger.sendCommand(queryTarget, 'Runtime.enable')
            }
            let targetCtx = contexts.find((item) => item.frameId === resolved.cdpFrameId && item.isDefault)
            const deadline = p.timeout === undefined ? Date.now() + 2000 : startedAt + p.timeout
            while (!targetCtx && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
                contexts = this.debuggerManager
                    .getExecutionContexts(tabId)
                    .filter((item) => item.sessionId === resolved.querySessionId)
                targetCtx = contexts.find((item) => item.frameId === resolved.cdpFrameId && item.isDefault)
            }
            if (!targetCtx) {
                throw this.frameEvaluationError('FRAME_CONTEXT_UNAVAILABLE', 'No execution context for frame', {
                    tabId,
                    ...this.frameIdentitySummary(identity),
                    cdpFrameId: resolved.cdpFrameId,
                    contextCount: contexts.length,
                    retryAttempted,
                    retryReason,
                })
            }
            const owner =
                identity.frameId === 0
                    ? 0
                    : identity.documentId
                      ? await probeCdpFrameOwner(
                            tabId,
                            identity.documentId,
                            resolved.cdpFrameId,
                            resolved.ownerSessionId,
                            context
                        )
                      : null
            const current = await this.getExtensionFrameIdentity(tabId, p.frameId)
            if (
                owner !== identity.frameId ||
                current.documentId !== identity.documentId ||
                current.url !== identity.url ||
                current.parentFrameId !== identity.parentFrameId ||
                !this.debuggerManager
                    .getExecutionContexts(tabId)
                    .some(
                        (item) =>
                            item.id === targetCtx!.id &&
                            item.frameId === resolved.cdpFrameId &&
                            item.isDefault &&
                            item.sessionId === resolved.querySessionId
                    )
            ) {
                throw this.frameEvaluationError('FRAME_IDENTITY_CHANGED', 'Frame identity changed before dispatch', {
                    tabId,
                    actionExecuted: false,
                    originalFrame: this.frameIdentitySummary(identity),
                    currentFrame: this.frameIdentitySummary(current),
                })
            }
            // 请求期限和脚本期限可分别缺省，任一缺省时仍需使用另一个预算
            // noinspection PointlessBooleanExpressionJS
            const evaluationTimeout =
                context.deadline === undefined && p.timeout === undefined
                    ? undefined
                    : Math.min(
                          context.deadline === undefined ? Infinity : context.deadline - Date.now(),
                          p.timeout === undefined ? Infinity : p.timeout - (Date.now() - startedAt)
                      )
            if (evaluationTimeout !== undefined && evaluationTimeout <= 0) {
                throw this.frameEvaluationError(
                    'FRAME_EVALUATION_TIMEOUT',
                    'Frame evaluation timed out before Runtime.evaluate',
                    {
                        tabId,
                        ...this.frameIdentitySummary(identity),
                        cdpFrameId: resolved.cdpFrameId,
                        executionContextId: targetCtx.id,
                        timeout: p.timeout,
                        retryAttempted,
                        retryReason,
                    }
                )
            }
            assertActionActive(context)
            const evalParams: Record<string, unknown> = {
                contextId: targetCtx.id,
                expression: p.expression,
                returnByValue: options.returnByValue ?? true,
                awaitPromise: options.awaitPromise ?? true,
                ...(evaluationTimeout !== undefined ? { timeout: evaluationTimeout } : {}),
            }
            try {
                const result = (await chrome.debugger.sendCommand(
                    queryTarget,
                    'Runtime.evaluate',
                    evalParams
                )) as Record<string, unknown>
                return {
                    ...result,
                    retryAttempted,
                    retryReason,
                    staleContextRetry: p.staleContextRetry,
                    frameContext: {
                        tabId,
                        ...this.frameIdentitySummary(identity),
                        originalUrl: this.frameUrlSummary(originalFrame.url).url,
                        urlChanged: identity.url !== originalFrame.url,
                        cdpFrameId: resolved.cdpFrameId,
                        executionContextId: targetCtx.id,
                    },
                }
            } catch (error) {
                const nativeError = wrapDebuggerError(error, {
                    tabId,
                    method: 'Runtime.evaluate',
                    phase: 'command',
                    frameContext: {
                        tabId,
                        ...this.frameIdentitySummary(identity),
                        cdpFrameId: resolved.cdpFrameId,
                        executionContextId: targetCtx.id,
                    },
                })
                const message = error instanceof Error ? error.message : String(error)
                const staleContext =
                    /context.*(?:destroyed|not found|invalid)|Cannot find context|Execution context/i.test(message)
                if (!staleContext && nativeError !== error) {
                    throw nativeError
                }
                if (attempt > 0) {
                    throw this.frameEvaluationError('FRAME_EVALUATION_FAILED', message.slice(0, 500), {
                        tabId,
                        ...this.frameIdentitySummary(identity),
                        cdpFrameId: resolved.cdpFrameId,
                        executionContextId: targetCtx.id,
                        retryAttempted,
                        retryReason,
                    })
                }
                if (!staleContext) {
                    throw error
                }
                if (p.staleContextRetry !== 'readOnly') {
                    throw this.frameEvaluationError(
                        'FRAME_STALE_CONTEXT',
                        'Execution context became stale; script was not replayed because staleContextRetry is never',
                        {
                            tabId,
                            ...this.frameIdentitySummary(identity),
                            cdpFrameId: resolved.cdpFrameId,
                            executionContextId: targetCtx.id,
                            retryAttempted: false,
                            staleContextRetry: p.staleContextRetry,
                        }
                    )
                }
                retryAttempted = true
                retryReason = message.slice(0, 500)
                this.debuggerManager.invalidateExecutionContext(tabId, targetCtx.id, resolved.querySessionId)
                if (p.timeout !== undefined && Date.now() - startedAt >= p.timeout) {
                    throw this.frameEvaluationError('FRAME_EVALUATION_TIMEOUT', message.slice(0, 500), {
                        tabId,
                        ...this.frameIdentitySummary(identity),
                        cdpFrameId: resolved.cdpFrameId,
                        executionContextId: targetCtx.id,
                        timeout: p.timeout,
                        retryAttempted,
                        retryReason,
                    })
                }
            }
        }
        throw new Error('Stale execution context retry exhausted')
    }

    private frameIdentitySummary(frame: chrome.webNavigation.GetAllFrameResultDetails): Record<string, unknown> {
        return {
            extensionFrameId: frame.frameId,
            parentFrameId: frame.parentFrameId,
            documentId: frame.documentId ?? null,
            ...this.frameUrlSummary(frame.url),
        }
    }

    private frameUrlSummary(value: string): { url: string | null; urlStatus: 'filtered' | 'unavailable' } {
        try {
            const parsed = new URL(value)
            parsed.username = ''
            parsed.password = ''
            parsed.search = ''
            parsed.hash = ''
            const url =
                parsed.protocol === 'data:' || parsed.protocol === 'javascript:'
                    ? parsed.protocol
                    : parsed.href.slice(0, 500)
            return { url, urlStatus: 'filtered' }
        } catch {
            return { url: null, urlStatus: 'unavailable' }
        }
    }

    private frameEvaluationError(
        code: string,
        message: string,
        context: Record<string, unknown>
    ): ExpectedOperationError {
        return new ExpectedOperationError(
            JSON.stringify({
                error: {
                    code,
                    message,
                    suggestion: '请重新读取 frame 列表和页面状态；若 frame 候选不唯一，请改用唯一 URL 或 selector',
                    context,
                },
            })
        )
    }

    private async getExtensionFrameIdentity(
        tabId: number,
        frameId: number
    ): Promise<chrome.webNavigation.GetAllFrameResultDetails> {
        const frames = await chrome.webNavigation.getAllFrames({ tabId })
        const frame = frames?.find((candidate) => candidate.frameId === frameId)
        if (!frame) {
            throw this.frameEvaluationError('FRAME_NOT_FOUND', `Frame ${frameId} not found`, {
                tabId,
                extensionFrameId: frameId,
                phase: 'frame_identity',
            })
        }
        return frame
    }

    private async resolveCdpFrame(
        tabId: number,
        frame: chrome.webNavigation.GetAllFrameResultDetails,
        context: ActionContext
    ): Promise<{ cdpFrameId: string; querySessionId?: string; ownerSessionId?: string }> {
        if (!frame.documentId) {
            throw this.frameEvaluationError(
                'FRAME_CDP_UNAVAILABLE',
                'Cannot verify a frame without document identity',
                {
                    tabId,
                    ...this.frameUrlSummary(frame.url),
                    candidateCount: 0,
                }
            )
        }
        const path = await resolveCdpFramePath(
            tabId,
            frame,
            await this.debuggerManager.getFrameSessions(tabId),
            context
        )
        const selected = path.at(-1)!
        const current = await this.getExtensionFrameIdentity(tabId, frame.frameId)
        if (
            current.documentId !== frame.documentId ||
            current.parentFrameId !== frame.parentFrameId ||
            current.url !== frame.url
        ) {
            throw this.frameEvaluationError('FRAME_IDENTITY_CHANGED', 'Frame document changed during owner probe', {
                tabId,
                actionExecuted: false,
                originalFrame: this.frameIdentitySummary(frame),
                currentFrame: this.frameIdentitySummary(current),
            })
        }
        return {
            cdpFrameId: selected.cdpFrameId,
            ...(selected.queryTarget.sessionId ? { querySessionId: selected.queryTarget.sessionId } : {}),
            ...(selected.ownerTarget.sessionId ? { ownerSessionId: selected.ownerTarget.sessionId } : {}),
        }
    }

    private async getManagedScriptableTabId(
        tabId: number | undefined,
        context: ActionContext,
        operation: string
    ): Promise<number> {
        const resolvedTabId = await getTargetTabId(tabId)
        await assertManagedTab(resolvedTabId, context, operation)
        await assertScriptable(resolvedTabId)
        return resolvedTabId
    }
}
