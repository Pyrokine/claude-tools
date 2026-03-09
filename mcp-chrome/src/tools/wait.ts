/**
 * wait 工具
 *
 * 等待条件：
 * - element: 等待元素出现/消失/可见/隐藏
 * - navigation: 等待导航完成
 * - time: 固定等待时间
 * - idle: 等待网络空闲
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {z} from 'zod'
import {formatErrorResponse, formatResponse, getSession, getUnifiedSession, TimeoutError} from '../core/index.js'
import {DEFAULT_TIMEOUT, type ElementState, type Target} from '../core/types.js'
import {targetToFindParams, targetZodSchema} from './schema.js'

/** 轮询间隔（毫秒） */
const POLL_INTERVAL = 100

/**
 * wait 参数 schema
 */
const waitSchema = z.object({
                                for: z.enum(['element', 'navigation', 'time', 'idle']).describe('等待类型'),
                                target: targetZodSchema.optional().describe(
                                    '目标元素（for=element 时必填；navigation/time/idle 不需要）'),
                                state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional().describe(
                                    '元素状态（element）'),
                                ms: z.number().optional().describe('毫秒（time）'),
                                tabId: z.string().optional().describe(
                                    '目标 Tab ID（可选，仅 Extension 模式）。不指定则使用当前 attach 的 tab。可操作非当前 attach 的 tab。CDP 模式下不支持此参数'),
                                timeout: z.number().optional().describe('超时'),
                                frame: z.union([z.string(), z.number()]).optional().describe(
                                    'iframe 定位（可选，仅 Extension 模式）。CSS 选择器（如 "iframe#main"）或索引（如 0）。不指定则在主框架操作'),
                            })

/**
 * wait 工具处理器
 */
async function handleWait(args: z.infer<typeof waitSchema>): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}> {
    try {
        const unifiedSession = getUnifiedSession()
        const mode           = unifiedSession.getMode()
        const timeout        = args.timeout ?? DEFAULT_TIMEOUT

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

                        if (mode === 'extension') {
                            await waitForElementExtension(unifiedSession, args.target, state, timeout)
                        } else {
                            const session = getSession()
                            await waitForElement(session, args.target, state, timeout)
                        }

                        return formatResponse({
                                                  success: true,
                                                  waited: 'element',
                                                  state,
                                                  mode,
                                              })
                    }

                    case 'navigation': {
                        if (mode === 'extension') {
                            // Extension 模式：轮询 document.readyState 等待页面加载完成
                            const navStart                 = Date.now()
                            let navCompleted               = false
                            let navLastError: Error | null = null
                            while (Date.now() - navStart < timeout) {
                                if (!unifiedSession.isExtensionConnected()) {
                                    navLastError = new Error('Extension 未连接')
                                    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
                                    continue
                                }
                                try {
                                    const remaining  = timeout - (Date.now() - navStart)
                                    const readyState = await unifiedSession.evaluate<string>(
                                        'document.readyState',
                                        undefined,
                                        remaining,
                                    )
                                    // evaluate 带 timeout 时，Extension 断连会静默回退 CDP，返回错误 tab 的数据
                                    if (!unifiedSession.isExtensionConnected()) {
                                        navLastError = new Error('Extension 在 evaluate 期间断开')
                                        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
                                        continue
                                    }
                                    if (readyState === 'complete') {
                                        navCompleted = true
                                        break
                                    }
                                } catch (err) {
                                    // 页面正在导航中，evaluate 可能失败
                                    navLastError = err instanceof Error ? err : new Error(String(err))
                                }
                                await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
                            }
                            if (!navCompleted) {
                                const msg = `等待导航完成超时 (${timeout}ms)`
                                throw new TimeoutError(navLastError ? `${msg}: ${navLastError.message}` : msg)
                            }
                            // 从实际 tab 中查询 URL/title，而非依赖全局缓存状态（支持 tabId 参数）
                            const navRemaining          = timeout - (Date.now() - navStart)
                            let navUrl: string | null   = null
                            let navTitle: string | null = null
                            if (navRemaining > 0) {
                                try {
                                    const pageInfo = await unifiedSession.evaluate<{ url: string; title: string }>(
                                        '({url: location.href, title: document.title})', undefined, navRemaining,
                                    )
                                    // CDP 回退的数据来自错误 tab，丢弃
                                    if (unifiedSession.isExtensionConnected()) {
                                        navUrl   = pageInfo.url
                                        navTitle = pageInfo.title
                                    }
                                } catch {
                                    // 预算耗尽或连接断开，降级返回（导航本身已成功）
                                }
                            }
                            return formatResponse({
                                                      success: true,
                                                      waited: 'navigation',
                                                      url: navUrl,
                                                      title: navTitle,
                                                      mode,
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
                        if (mode === 'extension') {
                            // Extension 模式：等待 document.readyState === 'complete' + 额外网络静默期
                            const idleStart                 = Date.now()
                            let idleCompleted               = false
                            let idleLastError: Error | null = null
                            while (Date.now() - idleStart < timeout) {
                                if (!unifiedSession.isExtensionConnected()) {
                                    idleLastError = new Error('Extension 未连接')
                                    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
                                    continue
                                }
                                try {
                                    const remaining  = timeout - (Date.now() - idleStart)
                                    const readyState = await unifiedSession.evaluate<string>(
                                        'document.readyState',
                                        undefined,
                                        remaining,
                                    )
                                    // evaluate 带 timeout 时，Extension 断连会静默回退 CDP，返回错误 tab 的数据
                                    if (!unifiedSession.isExtensionConnected()) {
                                        idleLastError = new Error('Extension 在 evaluate 期间断开')
                                        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
                                        continue
                                    }
                                    if (readyState === 'complete') {
                                        idleCompleted = true
                                        break
                                    }
                                } catch (err) {
                                    idleLastError = err instanceof Error ? err : new Error(String(err))
                                }
                                await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
                            }
                            if (!idleCompleted) {
                                const msg = `等待网络空闲超时 (${timeout}ms)`
                                throw new TimeoutError(idleLastError ? `${msg}: ${idleLastError.message}` : msg)
                            }
                            // 额外等待确保网络请求结束，受 timeout 约束
                            const idleRemaining = timeout - (Date.now() - idleStart)
                            if (idleRemaining > 0) {
                                await new Promise(resolve => setTimeout(resolve, Math.min(500, idleRemaining)))
                            }
                            return formatResponse({
                                                      success: true,
                                                      waited: 'idle',
                                                      mode,
                                                  })
                        }

                        // CDP 模式
                        const session = getSession()
                        await waitForNetworkIdle(session, timeout)
                        return formatResponse({
                                                  success: true,
                                                  waited: 'idle',
                                                  mode,
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
    timeout: number,
): Promise<void> {
    const startTime                              = Date.now()
    const retryDelay                             = POLL_INTERVAL
    const {selector, text, xpath, nth: nthParam} = targetToFindParams(target as Target & { nth?: number })
    const nth                                    = nthParam ?? 0
    let lastError: Error | null                  = null

    while (true) {
        const elapsed = Date.now() - startTime
        if (elapsed >= timeout) {
            const msg = `等待元素 ${JSON.stringify(target)} 状态 ${state} 超时 (${timeout}ms)`
            throw new TimeoutError(lastError ? `${msg}: ${lastError.message}` : msg)
        }

        // 未连接时跳过 find()，避免阻塞超出用户 timeout
        if (!unifiedSession.isExtensionConnected()) {
            lastError = new Error('Extension 未连接')
            await new Promise(resolve => setTimeout(resolve, retryDelay))
            continue
        }

        try {
            const remaining = timeout - elapsed
            const elements  = await unifiedSession.find(selector, text, xpath, remaining)
            const found     = elements.length > nth

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
            // find() 在元素不存在时返回空数组（不抛异常），此处异常是真正的错误。
            // 暂时性错误（RPC 超时、发送失败、连接断开）可重试，其他确定性错误立即抛出
            if (err instanceof
                Error &&
                /Request timeout|Failed to send|disconnect|未连接|stopped|replaced/i.test(err.message)) {
                lastError = err
                await new Promise(resolve => setTimeout(resolve, retryDelay))
                continue
            }
            throw err
        }

        await new Promise(resolve => setTimeout(resolve, retryDelay))
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
): Promise<void> {
    const startTime  = Date.now()
    const retryDelay = POLL_INTERVAL

    while (Date.now() - startTime < timeout) {
        try {
            const remaining = timeout - (Date.now() - startTime)
            const locator   = session.createLocator(target, {timeout: remaining})

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

    throw new TimeoutError(
        `等待元素 ${JSON.stringify(target)} 状态 ${state} 超时 (${timeout}ms)`,
    )
}

/**
 * 等待导航完成（复用 session 的事件驱动实现）
 */
async function waitForNavigation(
    session: ReturnType<typeof getSession>,
    timeout: number,
): Promise<void> {
    await session.waitForNavigation(timeout)
}

/**
 * 等待网络空闲（复用 session 的事件驱动实现）
 */
async function waitForNetworkIdle(
    session: ReturnType<typeof getSession>,
    timeout: number,
): Promise<void> {
    await session.waitForNetworkIdle(timeout)
}

/**
 * 注册 wait 工具
 */
export function registerWaitTool(server: McpServer): void {
    server.registerTool('wait', {
        description: '等待条件：元素、导航、时间',
        inputSchema: waitSchema,
    }, (args) => handleWait(args))
}
