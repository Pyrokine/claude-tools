import { ExpectedOperationError } from '../types/expected-errors'
import { EvaluateInFrameSchema, GetAllFramesSchema, ResolveFrameSchema } from '../types/schemas'
import {
    type ActionContext,
    assertManagedTab,
    assertScriptable,
    getFrameOffset,
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

        // 获取所有 frames
        const allFrames = await chrome.webNavigation.getAllFrames({ tabId })
        if (!allFrames) {
            throw new Error('Failed to get frames')
        }

        // 所有非主框架的 iframe（包括嵌套），用于 URL 匹配
        const allChildFrames = allFrames.filter((f) => f.frameId !== 0)
        if (allChildFrames.length === 0) {
            throw new Error('No iframes found in page')
        }
        // 主框架的直接子 iframe，用于 DOM 索引匹配（与 querySelectorAll 语义一致）
        const directChildFrames = allFrames.filter((f) => f.parentFrameId === 0 && f.frameId !== 0)

        // 在主框架中查找目标 iframe 的信息
        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            world: 'MAIN',
            func: (frame: string | number) => {
                const iframes = Array.from(document.querySelectorAll('iframe, frame')) as HTMLIFrameElement[]
                let target: HTMLIFrameElement | null
                let index = -1

                if (typeof frame === 'number') {
                    if (frame < 0 || frame >= iframes.length) {
                        return null
                    }
                    target = iframes[frame]
                    index = frame
                } else {
                    target = document.querySelector(frame) as HTMLIFrameElement
                    if (target) {
                        index = iframes.indexOf(target)
                    }
                }

                if (!target) {
                    return null
                }

                // 获取绝对 URL
                let absoluteSrc = target.src || ''
                if (absoluteSrc && !absoluteSrc.startsWith('http') && !absoluteSrc.startsWith('about:')) {
                    try {
                        absoluteSrc = new URL(absoluteSrc, location.href).href
                    } catch {
                        /* keep original */
                    }
                }

                return { src: absoluteSrc, index }
            },
            args: [p.frame],
        })

        const info = results[0]?.result as { src: string; index: number } | null
        if (!info) {
            const desc = typeof p.frame === 'number' ? `index ${p.frame}` : `selector "${p.frame}"`
            throw new ExpectedOperationError(`iframe not found: ${desc}`)
        }

        // 策略 1: URL 精确匹配（在所有 frame 中搜索，支持嵌套 iframe）
        let matchedFrameId: number | undefined
        if (info.src) {
            const urlMatches = allChildFrames.filter((f) => f.url === info.src)
            if (urlMatches.length === 1) {
                matchedFrameId = urlMatches[0].frameId
            }
        }

        // 策略 2: 按 DOM 索引匹配（仅在直接子 frame 中匹配，与主框架 querySelectorAll 语义一致）
        if (matchedFrameId === undefined && info.index >= 0 && info.index < directChildFrames.length) {
            matchedFrameId = directChildFrames[info.index].frameId
        }

        if (matchedFrameId === undefined) {
            throw new Error(
                `Cannot resolve iframe to frameId. src: "${info.src}", ` +
                    `directChildren: ${directChildFrames.length}, allFrames: ${allChildFrames.length}`
            )
        }

        const offset = await getFrameOffset(tabId, matchedFrameId)
        return { frameId: matchedFrameId, offset }
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

        type DomFrame = {
            index: number
            url: string
            title: string | null
            name: string | null
            selector: string | null
            rect: { x: number; y: number; width: number; height: number }
        }

        let mainFrameInfo: {
            title: string | null
            rect: { x: number; y: number; width: number; height: number }
        } = { title: null, rect: { x: 0, y: 0, width: 0, height: 0 } }
        let domFrames: DomFrame[] = []
        try {
            const result = await chrome.scripting.executeScript({
                target: { tabId, frameIds: [0] },
                world: 'MAIN',
                func: () => ({
                    main: {
                        title: document.title || null,
                        rect: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
                    },
                    frames: Array.from(document.querySelectorAll('iframe, frame')).map((frame, index) => {
                        const el = frame as HTMLIFrameElement
                        const rect = el.getBoundingClientRect()
                        const selector = el.id
                            ? `#${CSS.escape(el.id)}`
                            : `${el.tagName.toLowerCase()}:nth-of-type(${index + 1})`
                        return {
                            index,
                            url: el.src || '',
                            title: el.title || null,
                            name: el.name || null,
                            selector,
                            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                        }
                    }),
                }),
            })
            const pageFrames = result[0]?.result as { main?: typeof mainFrameInfo; frames?: DomFrame[] } | undefined
            mainFrameInfo = pageFrames?.main ?? mainFrameInfo
            domFrames = pageFrames?.frames ?? []
        } catch {
            domFrames = []
        }

        const directChildFrames = frames.filter((frame) => frame.parentFrameId === 0 && frame.frameId !== 0)
        const getDomFrame = (frame: chrome.webNavigation.GetAllFrameResultDetails): DomFrame | undefined => {
            if (frame.parentFrameId !== 0) {
                return undefined
            }
            const directIndex = directChildFrames.findIndex((candidate) => candidate.frameId === frame.frameId)
            const byIndex = directIndex >= 0 ? domFrames[directIndex] : undefined
            if (byIndex) {
                return byIndex
            }
            const navigationMatches = directChildFrames.filter((candidate) => candidate.url === frame.url)
            const domMatches = domFrames.filter((candidate) => candidate.url === frame.url)
            return navigationMatches.length === 1 && domMatches.length === 1 ? domMatches[0] : undefined
        }

        return {
            frames: frames.map((frame, index) => {
                const isMainFrame = frame.frameId === 0
                const dom = isMainFrame ? undefined : getDomFrame(frame)
                return {
                    index,
                    frameId: frame.frameId,
                    parentFrameId: isMainFrame ? null : frame.parentFrameId,
                    url: frame.url,
                    title: isMainFrame ? mainFrameInfo.title : (dom?.title ?? null),
                    name: isMainFrame ? null : (dom?.name ?? null),
                    selector: isMainFrame ? null : (dom?.selector ?? null),
                    rect: isMainFrame ? mainFrameInfo.rect : (dom?.rect ?? null),
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

        for (let attempt = 0; attempt < 2; attempt++) {
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
