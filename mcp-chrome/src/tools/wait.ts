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
import { formatErrorResponse, formatResponse, getSession, getUnifiedSession, TimeoutError } from '../core/index.js'
import { DEFAULT_TIMEOUT, type ElementState, type Target } from '../core/types.js'
import { targetToFindParams, targetZodSchema } from './schema.js'

/** 轮询间隔（毫秒） */
const POLL_INTERVAL = 100

interface DiagnosticsStart {
    consoleCount: number
    networkCount: number
}

async function captureDiagnosticsStart(
    unifiedSession: ReturnType<typeof getUnifiedSession>
): Promise<DiagnosticsStart> {
    await unifiedSession.enableConsole()
    await unifiedSession.enableNetwork()
    const consoleLogs = await unifiedSession.getConsoleLogs()
    const network = await unifiedSession.getNetworkRequests()
    return { consoleCount: consoleLogs.length, networkCount: network.length }
}

async function captureDiagnosticsDelta(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    start: DiagnosticsStart
): Promise<Record<string, unknown>> {
    const consoleLogs = await unifiedSession.getConsoleLogs()
    const network = await unifiedSession.getNetworkRequests()
    return {
        console: consoleLogs
            .slice(start.consoleCount)
            .filter((item) => ['error', 'warning', 'warn'].includes(item.level))
            .slice(-20),
        failedRequests: network
            .slice(start.networkCount)
            .filter((item) => item.errorText || (item.status !== undefined && item.status >= 400))
            .slice(-20),
    }
}

async function withDiagnostics<T extends Record<string, unknown>>(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    enabled: boolean | undefined,
    action: () => Promise<T>
): Promise<T & { diagnostics?: Record<string, unknown> }> {
    const start = enabled ? await captureDiagnosticsStart(unifiedSession) : undefined
    const result: T & { diagnostics?: Record<string, unknown> } = await action()
    if (start) {
        result.diagnostics = await captureDiagnosticsDelta(unifiedSession, start)
    }
    return result
}

async function getExtensionNavigationSnapshot(
    unifiedSession: ReturnType<typeof getUnifiedSession>
): Promise<{ readyState: string; url: string; title: string }> {
    const targetId = unifiedSession.getCurrentTargetId()
    if (!targetId) {
        throw new Error('没有当前页面，请先 browse attach 或先 browse open 创建受控页面')
    }

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

/**
 * wait 参数 schema
 */
const waitSchema = z.object({
    for: z.enum(['element', 'navigation', 'time', 'idle']).describe('等待类型'),
    target: targetZodSchema.optional().describe('目标元素（for=element 时必填；navigation/time/idle 不需要）'),
    state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional().describe('元素状态（element）'),
    ms: z.number().optional().describe('毫秒（time：等待时长；idle：DOM mutation 静默期，默认 500ms）'),
    diagnostics: z.boolean().optional().describe('执行后返回新增 console error/warning 和失败网络请求摘要'),
    tabId: z
        .string()
        .optional()
        .describe(
            '目标 Tab ID（可选，仅 Extension 模式），不指定则使用当前 attach 的 tab，可操作非当前 attach 的 tab，CDP 模式下不支持此参数'
        ),
    timeout: z.number().optional().describe('超时'),
    frame: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
            'iframe 定位（可选，仅 Extension 模式），CSS 选择器（如 "iframe#main"）或索引（如 0），不指定则在主框架操作'
        ),
})

/**
 * wait 工具处理器
 */
async function handleWait(args: z.infer<typeof waitSchema>): Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
}> {
    try {
        const unifiedSession = getUnifiedSession()
        const mode = unifiedSession.getMode()
        const timeout = args.timeout ?? DEFAULT_TIMEOUT

        return await unifiedSession.withTabId(args.tabId, async () => {
            return await unifiedSession.withFrame(args.frame, async () => {
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

                        return formatResponse(
                            await withDiagnostics(unifiedSession, args.diagnostics, async () => {
                                if (mode === 'extension') {
                                    await waitForElementExtension(unifiedSession, args.target!, state, timeout)
                                } else {
                                    const session = getSession()
                                    await waitForElement(session, args.target!, state, timeout)
                                }
                                return {
                                    success: true,
                                    waited: 'element',
                                    state,
                                    mode,
                                }
                            })
                        )
                    }

                    case 'navigation': {
                        const diagnosticsStart = args.diagnostics
                            ? await captureDiagnosticsStart(unifiedSession)
                            : undefined
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
                                const initial = await getExtensionNavigationSnapshot(unifiedSession)
                                if (unifiedSession.isExtensionConnected()) {
                                    initialUrl = initial.url
                                    initialTitle = initial.title
                                    sawLoading = initial.readyState !== 'complete'
                                }
                            } catch (err) {
                                sawLoading = true
                                navLastError = err instanceof Error ? err : new Error(String(err))
                            }

                            while (Date.now() - navStart < timeout) {
                                if (!unifiedSession.isExtensionConnected()) {
                                    navLastError = new Error('Extension 未连接')
                                    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
                                    continue
                                }
                                try {
                                    const pageInfo = await getExtensionNavigationSnapshot(unifiedSession)
                                    if (!unifiedSession.isExtensionConnected()) {
                                        navLastError = new Error('Extension 在查询导航状态期间断开')
                                        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
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
                                await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
                            }
                            if (!navCompleted) {
                                const msg = `等待导航完成超时 (${timeout}ms)`
                                throw new TimeoutError(navLastError ? `${msg}: ${navLastError.message}` : msg)
                            }

                            return formatResponse({
                                success: true,
                                waited: 'navigation',
                                url: navUrl,
                                title: navTitle,
                                mode,
                                ...(diagnosticsStart
                                    ? { diagnostics: await captureDiagnosticsDelta(unifiedSession, diagnosticsStart) }
                                    : {}),
                            })
                        }

                        // CDP 模式
                        const session = getSession()
                        await waitForNavigation(session, timeout)
                        const sessionState = session.getState()
                        return formatResponse({
                            success: true,
                            waited: 'navigation',
                            url: sessionState?.url,
                            title: sessionState?.title,
                            mode,
                            ...(diagnosticsStart
                                ? { diagnostics: await captureDiagnosticsDelta(unifiedSession, diagnosticsStart) }
                                : {}),
                        })
                    }

                    case 'time': {
                        if (!args.ms) {
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
                        await new Promise((resolve) => setTimeout(resolve, args.ms))
                        return formatResponse({
                            success: true,
                            waited: 'time',
                            ms: args.ms,
                        })
                    }

                    case 'idle': {
                        const diagnosticsStart = args.diagnostics
                            ? await captureDiagnosticsStart(unifiedSession)
                            : undefined
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
                                    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
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
                                        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
                                        continue
                                    }
                                    if (readyState === 'complete') {
                                        idleCompleted = true
                                        break
                                    }
                                } catch (err) {
                                    idleLastError = err instanceof Error ? err : new Error(String(err))
                                }
                                await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
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
                                try {
                                    const domStable = await new Promise<boolean>((resolve, reject) => {
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
                                    if (!domStable) {
                                        throw new TimeoutError(
                                            `等待页面 idle 超时 (${timeout}ms): DOM 未达到 ${quietPeriod}ms 静默`
                                        )
                                    }
                                    return formatResponse({
                                        success: true,
                                        waited: 'idle',
                                        domStable,
                                        mode,
                                        ...(diagnosticsStart
                                            ? {
                                                  diagnostics: await captureDiagnosticsDelta(
                                                      unifiedSession,
                                                      diagnosticsStart
                                                  ),
                                              }
                                            : {}),
                                    })
                                } catch (err) {
                                    if (err instanceof TimeoutError) {
                                        throw err
                                    }
                                    const message = err instanceof Error ? err.message : String(err)
                                    throw new TimeoutError(`等待页面 idle 超时 (${timeout}ms): ${message}`)
                                }
                            }

                            throw new TimeoutError(
                                `等待页面 idle 超时 (${timeout}ms): 剩余时间不足以完成 ${quietPeriod}ms DOM 静默检测`
                            )
                        }

                        // CDP 模式
                        const session = getSession()
                        await waitForNetworkIdle(session, timeout)
                        return formatResponse({
                            success: true,
                            waited: 'idle',
                            mode,
                            ...(diagnosticsStart
                                ? { diagnostics: await captureDiagnosticsDelta(unifiedSession, diagnosticsStart) }
                                : {}),
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
        }) // withTabId
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
    timeout: number
): Promise<void> {
    const startTime = Date.now()
    const retryDelay = POLL_INTERVAL
    const { selector, text, xpath, nth: nthParam } = targetToFindParams(target as Target & { nth?: number })
    const nth = nthParam ?? 0
    let lastError: Error | null = null

    while (true) {
        const elapsed = Date.now() - startTime
        if (elapsed >= timeout) {
            const msg = `等待元素 ${JSON.stringify(target)} 状态 ${state} 超时 (${timeout}ms)`
            throw new TimeoutError(lastError ? `${msg}: ${lastError.message}` : msg)
        }

        // 未连接时跳过 find()，避免阻塞超出用户 timeout
        if (!unifiedSession.isExtensionConnected()) {
            lastError = new Error('Extension 未连接')
            await new Promise((resolve) => setTimeout(resolve, retryDelay))
            continue
        }

        try {
            const remaining = timeout - elapsed
            const elements = await unifiedSession.find(selector, text, xpath, remaining)
            const found = elements.length > nth

            switch (state) {
                case 'attached':
                case 'visible': {
                    if (found) {
                        if (state === 'visible') {
                            const rect = elements[nth].rect
                            if (rect.width > 0 && rect.height > 0) {
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
                        const rect = elements[nth].rect
                        if (rect.width === 0 || rect.height === 0) {
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
                await new Promise((resolve) => setTimeout(resolve, retryDelay))
                continue
            }
            throw err
        }

        await new Promise((resolve) => setTimeout(resolve, retryDelay))
    }
}

/**
 * CDP 模式：等待元素
 */
async function waitForElement(
    session: ReturnType<typeof getSession>,
    target: Target,
    state: ElementState,
    timeout: number
): Promise<void> {
    const startTime = Date.now()
    const retryDelay = POLL_INTERVAL

    while (Date.now() - startTime < timeout) {
        try {
            const remaining = timeout - (Date.now() - startTime)
            const locator = session.createLocator(target, { timeout: remaining })

            switch (state) {
                case 'attached':
                case 'visible': {
                    // 尝试找到元素
                    await locator.find()

                    if (state === 'visible') {
                        // 还需要检查可见性
                        const box = await locator.getBoundingBox()
                        if (box.width > 0 && box.height > 0) {
                            return // 元素可见
                        }
                    } else {
                        return // 元素存在
                    }
                    break
                }

                case 'detached':
                case 'hidden': {
                    try {
                        await locator.find()
                        if (state === 'hidden') {
                            // 元素存在，检查是否隐藏
                            const box = await locator.getBoundingBox()
                            if (box.width === 0 || box.height === 0) {
                                return // 元素隐藏
                            }
                        }
                        // 元素仍然存在，继续等待
                    } catch {
                        // 元素不存在，符合预期
                        return
                    }
                    break
                }
            }
        } catch {
            // 元素未找到
            if (state === 'detached' || state === 'hidden') {
                return // 符合预期
            }
            // 继续等待
        }

        await new Promise((resolve) => setTimeout(resolve, retryDelay))
    }

    throw new TimeoutError(`等待元素 ${JSON.stringify(target)} 状态 ${state} 超时 (${timeout}ms)`)
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
async function waitForNetworkIdle(session: ReturnType<typeof getSession>, timeout: number): Promise<void> {
    await session.waitForNetworkIdle(timeout)
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
        (args) => handleWait(args)
    )
}
