import { ExpectedOperationError } from '../types/expected-errors'
import { EvaluateInFrameSchema, GetAllFramesSchema, ResolveFrameSchema } from '../types/schemas'
import { assertScriptable, getFrameOffset, getTargetTabId } from './action-utils.js'
import type { DebuggerManager } from './debugger-manager.js'

export class FrameResolver {
    constructor(private debuggerManager: DebuggerManager) {}

    async resolveFrame(params: unknown): Promise<{ frameId: number; offset: { x: number; y: number } | null }> {
        const p = ResolveFrameSchema.parse(params)

        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)

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
                let target: HTMLIFrameElement | null = null
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

    async getAllFrames(params: unknown): Promise<{
        frames: Array<{ frameId: number; parentFrameId: number; url: string }>
    }> {
        const p = GetAllFramesSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)

        const frames = await chrome.webNavigation.getAllFrames({ tabId })
        if (!frames) {
            throw new Error('Failed to get frames')
        }

        return {
            frames: frames.map((f) => ({
                frameId: f.frameId,
                parentFrameId: f.parentFrameId,
                url: f.url,
            })),
        }
    }

    /**
     * 在指定 iframe 中以 precise 模式执行 JS
     *
     * 通过 Runtime.enable 获取 iframe 的执行上下文 ID，
     * 然后用 Runtime.evaluate + contextId 在 iframe 主世界中执行代码，绕过 CSP
     */
    async evaluateInFrame(params: unknown): Promise<unknown> {
        const p = EvaluateInFrameSchema.parse(params)
        const returnByValue = (params as { returnByValue?: boolean })?.returnByValue
        const awaitPromise = (params as { awaitPromise?: boolean })?.awaitPromise

        const tabId = await getTargetTabId(p.tabId)
        await this.debuggerManager.ensureAttached(tabId)

        // 获取 Extension frameId 对应的 URL
        const extFrames = await chrome.webNavigation.getAllFrames({ tabId })
        if (!extFrames) {
            throw new Error('Failed to enumerate frames')
        }
        const targetFrame = extFrames.find((f) => f.frameId === p.frameId)
        if (!targetFrame) {
            throw new ExpectedOperationError(`Frame ${p.frameId} not found`)
        }

        // 获取 CDP frame tree，通过 URL 匹配找到 CDP frameId
        const treeResult = (await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree')) as {
            frameTree: { frame: { id: string; url: string }; childFrames?: Array<unknown> }
        }
        const cdpFrameIds = this.findCdpFrameIds(treeResult.frameTree, targetFrame.url)
        if (cdpFrameIds.length === 0) {
            throw new Error(`Cannot resolve CDP frame for URL: ${targetFrame.url}`)
        }
        if (cdpFrameIds.length > 1) {
            throw new ExpectedOperationError(
                `Multiple CDP frames (${cdpFrameIds.length}) match URL "${targetFrame.url}". ` +
                    'Cannot uniquely identify target iframe for precise evaluate. ' +
                    'Use stealth mode or ensure iframes have distinct URLs.'
            )
        }
        const cdpFrameId = cdpFrameIds[0]

        // 确保 Runtime 域已启用以收集执行上下文
        // 首次调用时 enable 会触发所有已存在上下文的事件；
        // 后续调用复用缓存（由 onEvent 持久监听保持一致性）
        let contexts = this.debuggerManager.getExecutionContexts(tabId)
        if (contexts.length === 0) {
            await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable')
        }

        // 轮询等待目标 frame 的主世界上下文（无论 contexts 是否已有其他 frame 的条目）
        let targetCtx = contexts.find((c) => c.frameId === cdpFrameId && c.isDefault)
        if (!targetCtx) {
            const maxAttempts = Math.ceil((p.timeout ?? 2000) / 100)
            for (let i = 0; i < maxAttempts; i++) {
                await new Promise((resolve) => setTimeout(resolve, 100))
                contexts = this.debuggerManager.getExecutionContexts(tabId)
                targetCtx = contexts.find((c) => c.frameId === cdpFrameId && c.isDefault)
                if (targetCtx) {
                    break
                }
            }
        }

        if (!targetCtx) {
            throw new Error(`No execution context for frame (CDP: ${cdpFrameId}, contexts: ${contexts.length})`)
        }

        // 在目标上下文中执行
        const evalParams: Record<string, unknown> = {
            contextId: targetCtx.id,
            expression: p.expression,
            returnByValue: returnByValue ?? true,
            awaitPromise: awaitPromise ?? true,
        }
        if (p.timeout !== undefined) {
            evalParams.timeout = p.timeout
        }

        return await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', evalParams)
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
