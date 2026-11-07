/**
 * wait 工具
 *
 * 等待条件：
 * - element: 等待元素出现/消失/可见/隐藏
 * - navigation: 等待导航完成
 * - time: 固定等待时间
 * - idle: 等待网络空闲
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
    ElementNotFoundError,
    formatErrorResponse,
    getSession,
    getUnifiedSession,
    TimeoutError,
    StructuredToolError,
} from '../core/index.js'
import { DEFAULT_TIMEOUT, type ElementState, type Target } from '../core/types.js'
import { remainingNavigationTimeout } from '../core/utils.js'
import { sanitizeUrlRecord } from './network-sanitizer.js'
import { withDiagnosticsResponse } from './diagnostics.js'
import { withPageContext } from './page-context.js'
import {
    frameZodSchema,
    pageTargetIdSchema,
    resolvePageTargetId,
    targetToFindParams,
    targetZodSchema,
} from './schema.js'
import { buildTargetDiagnostics, enrichTargetError, type TargetCandidate } from './target-diagnostics.js'

/** 轮询间隔（毫秒） */
const POLL_INTERVAL = 100
const NAVIGATION_SNAPSHOT_TIMEOUT = 1000

async function sleepWithinBudget(startedAt: number, timeout: number, interval: number): Promise<void> {
    const remaining = timeout - (Date.now() - startedAt)
    if (remaining > 0) {
        try {
            await getUnifiedSession().wait(Math.min(interval, remaining))
        } catch (error) {
            if (
                !(error instanceof StructuredToolError) ||
                error.code !== 'TIMEOUT' ||
                error.message !== 'Request timeout before dispatch' ||
                Date.now() - startedAt < timeout
            ) {
                throw error
            }
        }
    }
}

async function getExtensionNavigationSnapshot(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    timeout = NAVIGATION_SNAPSHOT_TIMEOUT
): Promise<{ readyState: string; url: string; title: string }> {
    const targetId = unifiedSession.getCurrentTargetId()
    if (!targetId) {
        throw new Error('没有当前页面，请先 browse attach 或先 browse open 创建受控页面')
    }

    try {
        const pageState = await unifiedSession.evaluate<{ readyState?: string; url?: string; title?: string }>(
            '({ readyState: document.readyState, url: location.href, title: document.title })',
            'stealth',
            timeout
        )
        return {
            readyState: pageState.readyState === 'complete' ? 'complete' : 'loading',
            url: pageState.url ?? '',
            title: pageState.title ?? '',
        }
    } catch {
        const targets = await unifiedSession.listTargets()
        const target = targets.find((item) => item.targetId === targetId)
        if (!target) {
            throw new Error(`Tab ${targetId} 不存在，请先 browse(action="list") 查看可用页面`)
        }

        return {
            readyState: target.status === 'complete' ? 'complete' : 'loading',
            url: target.url,
            title: target.title,
        }
    }
}

/**
 * wait 参数 schema
 */
const waitSchema = z.object({
    for: z.enum(['element', 'navigation', 'time', 'idle']).describe('等待类型'),
    target: targetZodSchema.optional().describe('目标元素（for=element 时必填；navigation/time/idle 不需要）'),
    state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional().describe('元素状态（element）'),
    ms: z
        .number()
        .optional()
        .describe('毫秒（time：等待时长；idle：Extension 为 DOM mutation 静默期，CDP 为网络静默期，默认 500ms）'),
    diagnostics: z.boolean().optional().describe('执行后返回新增 console error/warning 和失败网络请求摘要'),
    targetId: pageTargetIdSchema.describe('目标页面 ID（Extension 或 CDP），优先于默认操作目标'),
    tabId: pageTargetIdSchema.describe('旧版目标 Tab ID，与 targetId 相同语义，保留兼容'),
    timeout: z.number().optional().describe('超时'),
    frame: frameZodSchema.describe('iframe selector／索引或逐层路径（如 ["iframe#outer", 0]），省略时使用主文档'),
})

/**
 * wait 工具处理器
 */
async function handleWait(
    args: z.infer<typeof waitSchema>,
    signal?: AbortSignal
): Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
}> {
    try {
        const unifiedSession = getUnifiedSession()
        const timeout = args.timeout ?? DEFAULT_TIMEOUT
        const deadline = Date.now() + timeout

        return await withPageContext(
            unifiedSession,
            resolvePageTargetId(args),
            async () => {
                return await unifiedSession.withFrame(args.frame, async () => {
                    const mode = unifiedSession.getMode()
                    switch (args.for) {
                        case 'element': {
                            if (!args.target) {
                                return {
                                    content: [
                                        {
                                            type: 'text',
                                            text: JSON.stringify({
                                                error: {
                                                    code: 'INVALID_ARGUMENT',
                                                    message: '等待元素需要 target 参数',
                                                },
                                            }),
                                        },
                                    ],
                                    isError: true,
                                }
                            }
                            const state = args.state ?? 'visible'

                            return withDiagnosticsResponse(unifiedSession, args.diagnostics, async () => {
                                if (mode === 'extension') {
                                    await waitForElementExtension(
                                        unifiedSession,
                                        args.target!,
                                        state,
                                        timeout,
                                        args.frame,
                                        deadline
                                    )
                                } else {
                                    const session = getSession()
                                    await waitForElement(
                                        session,
                                        args.target!,
                                        state,
                                        timeout,
                                        unifiedSession,
                                        args.frame,
                                        deadline
                                    )
                                }
                                return {
                                    success: true,
                                    waited: 'element',
                                    state,
                                    mode,
                                }
                            })
                        }

                        case 'navigation': {
                            return withDiagnosticsResponse(unifiedSession, args.diagnostics, async () => {
                                if (mode === 'extension') {
                                    const navStart = Date.now()
                                    let navCompleted = false
                                    let navLastError: Error | null = null
                                    let initialUrl: string | null = null
                                    let initialTitle: string | null = null
                                    let sawLoading = false
                                    let navUrl: string | null = null
                                    let navTitle: string | null = null

                                    try {
                                        const initial = await getExtensionNavigationSnapshot(
                                            unifiedSession,
                                            Math.min(timeout, NAVIGATION_SNAPSHOT_TIMEOUT)
                                        )
                                        if (unifiedSession.isExtensionConnected()) {
                                            initialUrl = initial.url
                                            initialTitle = initial.title
                                            sawLoading = initial.readyState !== 'complete'
                                        }
                                    } catch (err) {
                                        sawLoading = true
                                        navLastError = err instanceof Error ? err : new Error(String(err))
                                    }

                                    while (!navCompleted && Date.now() - navStart < timeout) {
                                        if (!unifiedSession.isExtensionConnected()) {
                                            navLastError = new Error('Extension 未连接')
                                            await sleepWithinBudget(navStart, timeout, POLL_INTERVAL)
                                            continue
                                        }
                                        try {
                                            const remaining = timeout - (Date.now() - navStart)
                                            const pageInfo = await getExtensionNavigationSnapshot(
                                                unifiedSession,
                                                Math.min(remaining, NAVIGATION_SNAPSHOT_TIMEOUT)
                                            )
                                            if (!unifiedSession.isExtensionConnected()) {
                                                navLastError = new Error('Extension 在查询导航状态期间断开')
                                                await sleepWithinBudget(navStart, timeout, POLL_INTERVAL)
                                                continue
                                            }

                                            if (pageInfo.readyState !== 'complete') {
                                                sawLoading = true
                                            } else {
                                                const changed =
                                                    (initialUrl !== null && pageInfo.url !== initialUrl) ||
                                                    (initialTitle !== null && pageInfo.title !== initialTitle)
                                                if (sawLoading || changed || initialUrl === null) {
                                                    navUrl = pageInfo.url
                                                    navTitle = pageInfo.title
                                                    navCompleted = true
                                                    break
                                                }
                                            }
                                        } catch (err) {
                                            navLastError = err instanceof Error ? err : new Error(String(err))
                                        }
                                        await sleepWithinBudget(navStart, timeout, POLL_INTERVAL)
                                    }
                                    if (!navCompleted) {
                                        const msg = `等待导航完成超时 (${timeout}ms)`
                                        throw new TimeoutError(navLastError ? `${msg}: ${navLastError.message}` : msg)
                                    }

                                    return sanitizeUrlRecord({
                                        success: true,
                                        waited: 'navigation',
                                        url: navUrl ?? undefined,
                                        title: navTitle,
                                        mode,
                                    })
                                }

                                const session = getSession()
                                await waitForNavigation(session, remainingNavigationTimeout(deadline))
                                let sessionState
                                try {
                                    sessionState = await session.getLiveState(remainingNavigationTimeout(deadline))
                                    if (!sessionState) {
                                        // noinspection ExceptionCaughtLocallyJS -- Snapshot failure status
                                        throw new Error('导航后页面状态不可用')
                                    }
                                } catch (error) {
                                    throw new StructuredToolError(
                                        'NAVIGATION_SNAPSHOT_FAILED',
                                        error instanceof Error ? error.message : String(error),
                                        '导航等待已完成，请读取当前页面状态；勿重复导航',
                                        { waitCompleted: true, failureStage: 'snapshot' }
                                    )
                                }
                                return sanitizeUrlRecord({
                                    success: true,
                                    waited: 'navigation',
                                    url: sessionState?.url,
                                    title: sessionState.title,
                                    mode,
                                })
                            })
                        }

                        case 'time': {
                            if (args.ms === undefined) {
                                return {
                                    content: [
                                        {
                                            type: 'text',
                                            text: JSON.stringify({
                                                error: {
                                                    code: 'INVALID_ARGUMENT',
                                                    message: '等待时间需要 ms 参数',
                                                },
                                            }),
                                        },
                                    ],
                                    isError: true,
                                }
                            }
                            return withDiagnosticsResponse(unifiedSession, args.diagnostics, async () => {
                                await unifiedSession.wait(args.ms!)
                                return {
                                    success: true,
                                    waited: 'time',
                                    ms: args.ms,
                                }
                            })
                        }

                        case 'idle': {
                            return withDiagnosticsResponse(unifiedSession, args.diagnostics, async () => {
                                if (mode === 'extension') {
                                    // Extension 模式：readyState complete + DOM mutation 静默检测
                                    const idleStart = Date.now()
                                    const quietPeriod = args.ms ?? 500
                                    let idleCompleted = false
                                    let idleLastError: Error | null = null

                                    // Phase 1: 等待 readyState === 'complete'
                                    while (Date.now() - idleStart < timeout) {
                                        if (!unifiedSession.isExtensionConnected()) {
                                            idleLastError = new Error('Extension 未连接')
                                            await sleepWithinBudget(idleStart, timeout, POLL_INTERVAL)
                                            continue
                                        }
                                        try {
                                            const remaining = timeout - (Date.now() - idleStart)
                                            const readyState = await unifiedSession.evaluate<string>(
                                                'document.readyState',
                                                undefined,
                                                remaining
                                            )
                                            if (!unifiedSession.isExtensionConnected()) {
                                                idleLastError = new Error('Extension 在 evaluate 期间断开')
                                                await sleepWithinBudget(idleStart, timeout, POLL_INTERVAL)
                                                continue
                                            }
                                            if (readyState === 'complete') {
                                                idleCompleted = true
                                                break
                                            }
                                        } catch (err) {
                                            idleLastError = err instanceof Error ? err : new Error(String(err))
                                        }
                                        await sleepWithinBudget(idleStart, timeout, POLL_INTERVAL)
                                    }
                                    if (!idleCompleted) {
                                        const msg = `等待页面加载超时 (${timeout}ms)`
                                        throw new TimeoutError(idleLastError ? `${msg}: ${idleLastError.message}` : msg)
                                    }

                                    // Phase 2: DOM mutation 静默检测
                                    // 注入 MutationObserver，等待 quietPeriod 毫秒内无 DOM 变更
                                    const mutationRemaining = timeout - (Date.now() - idleStart)
                                    const scriptTimeout = mutationRemaining - POLL_INTERVAL
                                    if (scriptTimeout > quietPeriod) {
                                        let domStable: boolean
                                        try {
                                            domStable = await new Promise<boolean>((resolve, reject) => {
                                                let settled = false
                                                const timer = setTimeout(() => {
                                                    settled = true
                                                    resolve(false)
                                                }, scriptTimeout)

                                                unifiedSession
                                                    .evaluate<boolean>(
                                                        `(function(quietMs, timeoutMs) {
                                                    return new Promise(function(resolve) {
                                                        var target = document.documentElement || document.body;
                                                        if (!target) {
                                                            resolve(false);
                                                            return;
                                                        }

                                                        var lastMutation = Date.now();
                                                        var settled = false;
                                                        var observer = new MutationObserver(function() {
                                                            lastMutation = Date.now();
                                                        });
                                                        var timer = setTimeout(function() {
                                                            finish(false);
                                                        }, timeoutMs);

                                                        function finish(value) {
                                                            if (settled) {
                                                                return;
                                                            }
                                                            settled = true;
                                                            clearTimeout(timer);
                                                            observer.disconnect();
                                                            resolve(value);
                                                        }

                                                        function check() {
                                                            var elapsed = Date.now() - lastMutation;
                                                            if (elapsed >= quietMs) {
                                                                finish(true);
                                                                return;
                                                            }
                                                            setTimeout(check, Math.min(100, quietMs - elapsed));
                                                        }

                                                        observer.observe(target, {
                                                            childList: true,
                                                            subtree: true,
                                                            characterData: true,
                                                            attributes: true
                                                        });
                                                        setTimeout(check, quietMs);
                                                    });
                                                })`,
                                                        undefined,
                                                        mutationRemaining,
                                                        [quietPeriod, scriptTimeout]
                                                    )
                                                    .then((value) => {
                                                        if (settled) {
                                                            return
                                                        }
                                                        settled = true
                                                        clearTimeout(timer)
                                                        resolve(value)
                                                    })
                                                    .catch((err: unknown) => {
                                                        if (settled) {
                                                            return
                                                        }
                                                        settled = true
                                                        clearTimeout(timer)
                                                        reject(err)
                                                    })
                                            })
                                        } catch (err) {
                                            if (err instanceof TimeoutError) {
                                                throw err
                                            }
                                            const message = err instanceof Error ? err.message : String(err)
                                            throw new TimeoutError(`等待页面 idle 超时 (${timeout}ms): ${message}`)
                                        }
                                        if (!domStable) {
                                            throw new TimeoutError(
                                                `等待页面 idle 超时 (${timeout}ms): DOM 未达到 ${quietPeriod}ms 静默`
                                            )
                                        }
                                        return {
                                            success: true,
                                            waited: 'idle',
                                            idleKind: 'dom_mutation',
                                            idlePeriodMs: quietPeriod,
                                            domStable,
                                            mode,
                                        }
                                    }

                                    throw new TimeoutError(
                                        `等待页面 idle 超时 (${timeout}ms): 剩余时间不足以完成 ${quietPeriod}ms DOM 静默检测`
                                    )
                                }

                                const session = getSession()
                                await waitForNetworkIdle(session, timeout, args.ms ?? 500)
                                return {
                                    success: true,
                                    waited: 'idle',
                                    idleKind: 'network',
                                    idlePeriodMs: args.ms ?? 500,
                                    mode,
                                }
                            })
                        }

                        default:
                            return {
                                content: [
                                    {
                                        type: 'text',
                                        text: JSON.stringify({
                                            error: {
                                                code: 'INVALID_ARGUMENT',
                                                message: `未知等待类型: ${args.for}`,
                                            },
                                        }),
                                    },
                                ],
                                isError: true,
                            }
                    }
                }) // withFrame
            },
            deadline,
            signal
        ) // withTabId
    } catch (error) {
        return formatErrorResponse(error)
    }
}

/**
 * Extension 模式：等待元素
 */
async function waitForElementExtension(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    target: Target,
    state: ElementState,
    timeout: number,
    frame?: import('../core/browser-driver.js').FrameSelection,
    deadline = Date.now() + timeout
): Promise<void> {
    unifiedSession.preserveTargetAfterLookup()
    const startTime = deadline - timeout
    const { selector, text, xpath, nth: nthParam, semantic } = targetToFindParams(target as Target & { nth?: number })
    const nth = nthParam ?? 0
    let lastError: Error | null = null
    let matchCount: number | null = null
    let candidates: TargetCandidate[] = []

    while (true) {
        const elapsed = Date.now() - startTime
        if (elapsed >= timeout) {
            throw new TimeoutError(
                `等待元素 ${JSON.stringify(target)} 状态 ${state} 超时 (${timeout}ms)`,
                await buildTargetDiagnostics(unifiedSession, target, {
                    nth,
                    timeout,
                    deadline: startTime + timeout,
                    frame,
                    matchCount,
                    lastState: state,
                    lastError,
                    candidates,
                })
            )
        }

        unifiedSession.assertRequestActive()
        // 未连接时跳过 find()，避免阻塞超出用户 timeout
        if (!unifiedSession.isExtensionConnected()) {
            lastError = new Error('Extension 未连接')
            await sleepWithinBudget(startTime, timeout, POLL_INTERVAL)
            continue
        }

        try {
            const remaining = timeout - elapsed
            const elements = await unifiedSession.find(selector, text, xpath, remaining, semantic)
            matchCount = elements.length < 50 ? elements.length : null
            candidates = elements
            const selected =
                nth < 50
                    ? elements[nth]
                    : (
                          await unifiedSession.find(
                              selector,
                              text,
                              xpath,
                              Math.max(1, timeout - (Date.now() - startTime)),
                              semantic,
                              nth
                          )
                      )[0]
            const found = selected !== undefined

            switch (state) {
                case 'attached':
                case 'visible': {
                    if (found) {
                        if (state === 'visible') {
                            const rect = selected!.rect
                            const display = await unifiedSession.getComputedStyleByRef(selected!.refId, 'display')
                            const visibility = await unifiedSession.getComputedStyleByRef(selected!.refId, 'visibility')
                            if (
                                display !== 'none' &&
                                visibility !== 'hidden' &&
                                visibility !== 'collapse' &&
                                rect.width > 0 &&
                                rect.height > 0
                            ) {
                                return
                            }
                        } else {
                            return
                        }
                    }
                    break
                }

                case 'detached':
                case 'hidden': {
                    if (!found) {
                        return
                    }
                    if (state === 'hidden' && found) {
                        const rect = selected!.rect
                        const display = await unifiedSession.getComputedStyleByRef(selected!.refId, 'display')
                        const visibility = await unifiedSession.getComputedStyleByRef(selected!.refId, 'visibility')
                        if (
                            display === 'none' ||
                            visibility === 'hidden' ||
                            visibility === 'collapse' ||
                            rect.width === 0 ||
                            rect.height === 0
                        ) {
                            return
                        }
                    }
                    break
                }
            }
        } catch (err) {
            // find() 在元素不存在时返回空数组（不抛异常），此处异常是真正的错误
            // 暂时性错误（RPC 超时、发送失败、连接断开）可重试，其他确定性错误立即抛出
            if (
                err instanceof Error &&
                /Request timeout|Failed to send|disconnect|未连接|stopped|replaced/i.test(err.message)
            ) {
                lastError = err
                await sleepWithinBudget(startTime, timeout, POLL_INTERVAL)
                continue
            }
            throw err
        }

        await sleepWithinBudget(startTime, timeout, POLL_INTERVAL)
    }
}

/**
 * CDP 模式：等待元素
 */
async function waitForElement(
    session: ReturnType<typeof getSession>,
    target: Target,
    state: ElementState,
    timeout: number,
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    frame?: import('../core/browser-driver.js').FrameSelection,
    deadline = Date.now() + timeout
): Promise<void> {
    unifiedSession.preserveTargetAfterLookup()
    const startTime = deadline - timeout
    const lookupTimeout = timeout
    let diagnosticContext: Record<string, unknown> | undefined
    let lastLocator: ReturnType<typeof session.createLocator> | undefined
    let lastError: ElementNotFoundError | undefined
    while (Date.now() - startTime < lookupTimeout) {
        unifiedSession.assertRequestActive()
        try {
            const remaining = lookupTimeout - (Date.now() - startTime)
            const locator = session.createLocator(target, { timeout: remaining })
            lastLocator = locator

            switch (state) {
                case 'attached':
                case 'detached': {
                    await locator.find(false)
                    if (state === 'attached') {
                        return // 元素存在
                    }
                    // 元素仍然存在，继续等待
                    break
                }

                case 'visible':
                case 'hidden': {
                    // display:none 没有 CDP box model，DOMRect 仍可用于检查尺寸
                    const visible = await locator.evaluateOn<boolean>(
                        `function() {
                        const style = getComputedStyle(this);
                        const rect = this.getBoundingClientRect();
                        return style.display !== 'none' &&
                            style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
                            rect.width > 0 && rect.height > 0;
                    }`,
                        false
                    )
                    if (visible === (state === 'visible')) {
                        return
                    }
                    break
                }
            }
        } catch (error) {
            if (!(error instanceof ElementNotFoundError)) {
                throw error
            }
            if (state === 'detached' || state === 'hidden') {
                return // 元素不存在，符合预期
            }
            lastError = error
            // attached/visible 未找到时继续等待
        }

        if (!diagnosticContext && Date.now() < startTime + timeout) {
            diagnosticContext = await buildTargetDiagnostics(unifiedSession, target, {
                nth: (target as Target & { nth?: number }).nth ?? 0,
                timeout,
                deadline: startTime + timeout,
                frame,
                matchCount: lastLocator?.lastObservation?.matchCount ?? null,
                lastState: lastLocator?.lastObservation?.lastLocatorState ?? 'unobserved',
            })
        }
        await sleepWithinBudget(startTime, lookupTimeout, POLL_INTERVAL)
    }

    const error = new TimeoutError(`等待元素 ${JSON.stringify(target)} 状态 ${state} 超时 (${timeout}ms)`, {
        ...diagnosticContext,
        ...lastError?.context,
        ...lastLocator?.lastObservation,
        target,
        timeout,
    })
    if (!diagnosticContext) {
        await enrichTargetError(error, unifiedSession, target, { timeout, deadline: startTime + timeout, frame })
    }
    throw error
}

/**
 * 等待导航完成（复用 session 的事件驱动实现）
 */
async function waitForNavigation(session: ReturnType<typeof getSession>, timeout: number): Promise<void> {
    await session.waitForNavigation(timeout)
}

/**
 * 等待网络空闲（复用 session 的事件驱动实现）
 */
async function waitForNetworkIdle(
    session: ReturnType<typeof getSession>,
    timeout: number,
    idleTime: number
): Promise<void> {
    await session.waitForNetworkIdle(timeout, idleTime)
}

/**
 * 注册 wait 工具
 */
export function registerWaitTool(server: McpServer): void {
    server.registerTool(
        'wait',
        {
            description: '等待条件：元素、导航、时间',
            inputSchema: waitSchema,
        },
        (args, extra) => handleWait(args, extra?.signal)
    )
}
