import { ExpectedOperationError } from '../types/expected-errors'
import { EvaluateInFrameSchema, GetAllFramesSchema, ResolveFrameSchema } from '../types/schemas'
import {
    type ActionContext,
    assertManagedTab,
    assertScriptable,
    getDomFrameSnapshot,
    getTargetTabId,
} from './action-utils.js'
import type { DebuggerManager } from './debugger-manager.js'

export class FrameResolver {
    constructor(private debuggerManager: DebuggerManager) {}

    async resolveFrame(
        params: unknown,
        context: ActionContext
    ): Promise<{ frameId: number; offset: { x: number; y: number } | null }> {
        const p = ResolveFrameSchema.parse(params)

        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'resolve_frame')

        const snapshot = await getDomFrameSnapshot(tabId, 0, p.frame)
        if (snapshot.selectionStatus !== 'found' || snapshot.selectedIndex === null) {
            const desc = typeof p.frame === 'number' ? `index ${p.frame}` : `selector "${p.frame}"`
            const detail = snapshot.selectionError ? `: ${snapshot.selectionError}` : ''
            throw new ExpectedOperationError(`iframe not found: ${desc} (${snapshot.selectionStatus})${detail}`)
        }

        const selected = snapshot.frames.find((frame) => frame.index === snapshot.selectedIndex)
        if (!selected || selected.frameId === null) {
            throw new ExpectedOperationError(
                JSON.stringify({
                    error: {
                        code: 'FRAME_IDENTITY_UNAVAILABLE',
                        message: 'Cannot map the selected DOM iframe to one Chrome frameId',
                        suggestion: '请等待 iframe 完成加载后重试；工具不会按 webNavigation 列表顺序选择其他 frame',
                        context: {
                            tabId,
                            selection: p.frame,
                            domIndex: snapshot.selectedIndex,
                            candidateFrameIds: selected?.candidateFrameIds ?? [],
                            domFrameCount: snapshot.frames.length,
                        },
                    },
                })
            )
        }

        return { frameId: selected.frameId, offset: selected.contentOffset }
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
        }>
    }> {
        const p = GetAllFramesSchema.parse(params) ?? {}
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'get_all_frames')

        const frames = await chrome.webNavigation.getAllFrames({ tabId })
        if (!frames) {
            throw new Error('Failed to get frames')
        }

        const snapshot = await getDomFrameSnapshot(tabId, 0)
        const domFramesByFrameId = new Map(
            snapshot.frames
                .filter((frame): frame is typeof frame & { frameId: number } => frame.frameId !== null)
                .map((frame) => [frame.frameId, frame] as const)
        )

        return {
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
        const originalFrame = await this.getExtensionFrameIdentity(tabId, p.frameId)
        let retryAttempted = false
        let retryReason: string | undefined
        const maxAttempts = p.staleContextRetry === 'readOnly' ? 2 : 1

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
            const identity = await this.getExtensionFrameIdentity(tabId, p.frameId)
            if (identity.parentFrameId !== originalFrame.parentFrameId || identity.frameId !== originalFrame.frameId) {
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
            const resolved = await this.resolveCdpFrame(tabId, identity.url)
            let contexts = this.debuggerManager.getExecutionContexts(tabId)
            if (contexts.length === 0 || attempt > 0) await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable')
            let targetCtx = contexts.find((item) => item.frameId === resolved.cdpFrameId && item.isDefault)
            const deadline = p.timeout === undefined ? Date.now() + 2000 : startedAt + p.timeout
            while (!targetCtx && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
                contexts = this.debuggerManager.getExecutionContexts(tabId)
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
            const evaluationTimeout = p.timeout === undefined ? undefined : p.timeout - (Date.now() - startedAt)
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
            const evalParams: Record<string, unknown> = {
                contextId: targetCtx.id,
                expression: p.expression,
                returnByValue: options.returnByValue ?? true,
                awaitPromise: options.awaitPromise ?? true,
                ...(evaluationTimeout !== undefined ? { timeout: evaluationTimeout } : {}),
            }
            try {
                const result = (await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', evalParams)) as Record<
                    string,
                    unknown
                >
                return {
                    ...result,
                    retryAttempted,
                    retryReason,
                    staleContextRetry: p.staleContextRetry,
                    frameContext: {
                        tabId,
                        extensionFrameId: identity.frameId,
                        parentFrameId: identity.parentFrameId,
                        url: identity.url.slice(0, 500),
                        originalUrl: originalFrame.url.slice(0, 500),
                        urlChanged: identity.url !== originalFrame.url,
                        cdpFrameId: resolved.cdpFrameId,
                        executionContextId: targetCtx.id,
                    },
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                const staleContext =
                    /context.*(?:destroyed|not found|invalid)|Cannot find context|Execution context/i.test(message)
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
                this.debuggerManager.invalidateExecutionContext(tabId, targetCtx.id)
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
            url: frame.url.slice(0, 500),
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
        if (!frame) throw new ExpectedOperationError(`Frame ${frameId} not found`)
        return frame
    }

    private async resolveCdpFrame(tabId: number, targetUrl: string): Promise<{ cdpFrameId: string }> {
        const treeResult = (await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree')) as {
            frameTree: { frame: { id: string; url: string }; childFrames?: Array<unknown> }
        }
        const candidates = this.findCdpFrameIds(treeResult.frameTree, targetUrl)
        if (candidates.length === 0) {
            throw this.frameEvaluationError('FRAME_CDP_UNAVAILABLE', 'Cannot resolve CDP frame for URL', {
                tabId,
                url: targetUrl.slice(0, 500),
                candidateCount: 0,
            })
        }
        if (candidates.length > 1) {
            throw this.frameEvaluationError(
                'FRAME_AMBIGUOUS',
                'Multiple CDP frames match the same URL; refusing to guess target',
                {
                    tabId,
                    url: targetUrl.slice(0, 500),
                    candidateCount: candidates.length,
                    candidates: candidates.slice(0, 10),
                }
            )
        }
        return { cdpFrameId: candidates[0] }
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

    /** 在 CDP frame tree 中递归收集所有匹配 URL 的 frameId */
    private findCdpFrameIds(
        node: { frame: { id: string; url: string }; childFrames?: Array<unknown> },
        targetUrl: string
    ): string[] {
        const results: string[] = []
        if (node.frame.url === targetUrl) {
            results.push(node.frame.id)
        }
        for (const child of (node.childFrames || []) as Array<typeof node>) {
            results.push(...this.findCdpFrameIds(child, targetUrl))
        }
        return results
    }
}
