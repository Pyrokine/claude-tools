/**
 * browse 工具
 *
 * 浏览器管理与导航：
 * - launch: 启动新浏览器
 * - connect: 连接已运行的浏览器
 * - list: 列出所有可用页面
 * - attach: 附加到指定页面
 * - open: 打开 URL
 * - back/forward: 前进后退
 * - refresh: 刷新
 * - close: 关闭指定页面
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { formatErrorResponse, formatResponse, getSession, getUnifiedSession } from '../core/index.js'
import { StructuredToolError } from '../core/errors.js'
import { DEFAULT_TIMEOUT, type WaitUntil } from '../core/types.js'
import { remainingNavigationTimeout } from '../core/utils.js'
import { challengeResultFields, resolveChallenge } from './challenge.js'
import { withDiagnosticsResponse } from './diagnostics.js'
import { withPageContext, withPageResponse } from './page-context.js'
import { pageConditionSchema } from './schema.js'

/**
 * browse 参数 schema
 */
const browseSchema = z.object({
    expectedUrl: pageConditionSchema.expectedUrl.describe(
        '动作执行前要求页面 URL 与此值一致；仅 open/back/forward/refresh/close 支持，不一致时不执行'
    ),
    expectedRevision: pageConditionSchema.expectedRevision.describe(
        '动作执行前要求页面 revision 与此值一致；从 browse list 获取，仅 open/back/forward/refresh/close 支持'
    ),
    action: z
        .enum(['launch', 'connect', 'list', 'attach', 'open', 'back', 'forward', 'refresh', 'close'])
        .describe('操作类型'),
    executablePath: z.string().optional().describe('Chrome 可执行文件路径（launch），不指定则自动查找'),
    incognito: z.boolean().optional().describe('是否以隐身模式启动（launch）'),
    headless: z.boolean().optional().describe('是否无头模式（launch），注意：无头模式易被检测'),
    userDataDir: z.string().optional().describe('用户数据目录（launch），指定后可复用登录状态'),
    stealth: z
        .enum(['off', 'safe', 'aggressive'])
        .optional()
        .describe('反检测模式（launch/connect），off=关闭，safe=最小改动（默认），aggressive=完整伪装'),
    port: z.coerce
        .number()
        .optional()
        .describe(
            'CDP 调试端口。只在 browse(action="connect") 中显式指定时选择 CDP；其他场景优先使用已连接的 Extension'
        ),
    host: z.string().optional().describe('调试主机（connect）'),
    targetId: z
        .string()
        .optional()
        .describe(
            '目标 ID（attach/close），从 list 结果中获取。close 必填，只关闭该页面。' +
                'Extension 模式为数字 Tab ID，CDP 模式为 WebSocket target ID，仅在当前 mode 下有效'
        ),
    details: z
        .enum(['summary', 'full'])
        .optional()
        .describe('list 默认摘要；full 返回完整原生属性，窗口仅以 targetIds 引用页面'),
    targetIds: z.array(z.string().min(1)).min(1).optional().describe('list 仅返回这些页面及其窗口/分组关系'),
    managedOnly: z.boolean().optional().describe('list 仅返回 managed=true 的页面，默认 false'),
    activate: z.boolean().optional().describe('是否激活 Tab（attach），默认 false 只设置操作目标不切到前台'),
    url: z.string().optional().describe('目标 URL（open）'),
    wait: z.enum(['load', 'domcontentloaded', 'networkidle']).optional().describe('等待条件（open/refresh）'),
    ignoreCache: z.boolean().optional().describe('刷新时是否忽略缓存（refresh）'),
    timeout: z.coerce
        .number()
        .optional()
        .describe('超时毫秒，open/back/forward/refresh 含页面加载和 Cloudflare Challenge 等待'),
    diagnostics: z
        .boolean()
        .optional()
        .describe(
            'open 后返回新增 console error/warning 和失败网络请求摘要。访问 Cloudflare 页面时默认不传；开启后会启用 debugger 日志采集'
        ),
})

/**
 * browse 工具处理器
 */
function pageStateMetadata(unifiedSession: ReturnType<typeof getUnifiedSession>): Record<string, unknown> {
    const state = unifiedSession.getState()
    return {
        url: state?.url,
        title: state?.title,
        managed: state?.managed ?? false,
    }
}

async function handleBrowse(args: z.infer<typeof browseSchema>): Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
}> {
    try {
        const deadline = Date.now() + (args.timeout ?? DEFAULT_TIMEOUT)
        const unifiedSession = getUnifiedSession()
        const cdpSession = getSession()

        // 优先使用 Extension 模式（如果启用了，即使当前断开也使用，会自动等待重连）
        const useExtension = unifiedSession.isExtensionModeEnabled()
        const conditional = args.expectedUrl !== undefined || args.expectedRevision !== undefined
        if (conditional && !['open', 'back', 'forward', 'refresh', 'close'].includes(args.action)) {
            throw new StructuredToolError(
                'INVALID_ARGUMENT',
                `${args.action} 不支持页面动作条件，未执行`,
                '仅 open/back/forward/refresh/close 接受 expectedUrl 和 expectedRevision',
                { action: args.action, actionExecuted: false }
            )
        }

        switch (args.action) {
            case 'launch': {
                return await withPageResponse(
                    unifiedSession,
                    undefined,
                    async () => {
                        // Extension 模式：直接创建新 Tab
                        if (useExtension) {
                            const target = await unifiedSession.launch({
                                port: args.port,
                                executablePath: args.executablePath,
                                headless: args.headless,
                                userDataDir: args.userDataDir,
                                incognito: args.incognito,
                                timeout: args.timeout,
                                stealth: args.stealth as 'off' | 'safe' | 'aggressive' | undefined,
                            })
                            return formatResponse({
                                success: true,
                                action: 'launch',
                                mode: target.mode,
                                note:
                                    target.mode === 'extension'
                                        ? 'Extension 模式：使用用户浏览器，共享登录状态'
                                        : '已启动新浏览器（Extension 未连接，fallback 到 CDP 模式）',
                                target,
                                createdTargetId:
                                    target.mode === 'extension' || target.targetCreated === true || !target.reused
                                        ? target.targetId
                                        : null,
                            })
                        }

                        // CDP 模式：启动新浏览器
                        const target = await unifiedSession.launch({
                            executablePath: args.executablePath,
                            port: args.port ?? 0,
                            incognito: args.incognito ?? false,
                            headless: args.headless ?? false,
                            userDataDir: args.userDataDir,
                            timeout: args.timeout ?? DEFAULT_TIMEOUT,
                            stealth: args.stealth as 'off' | 'safe' | 'aggressive' | undefined,
                        })
                        const reused = target.reused ?? false
                        return formatResponse({
                            success: true,
                            action: 'launch',
                            mode: 'cdp',
                            port: cdpSession.port,
                            reused,
                            note: reused
                                ? '已复用运行中的浏览器，保留登录状态'
                                : '已启动新浏览器，登录状态保存在 ~/.mcp-chrome/profile',
                            target,
                            createdTargetId: (target.targetCreated ?? !reused) ? target.targetId : null,
                        })
                    },
                    true
                )
            }

            case 'connect': {
                // 显式传 port 时走 CDP 连接（即使 Extension 服务器已启动）
                if (useExtension && !args.port) {
                    const connected = unifiedSession.isExtensionAvailable()
                    if (connected) {
                        unifiedSession.setActiveMode('extension')
                    }
                    return formatResponse({
                        success: connected,
                        action: 'connect',
                        mode: 'extension',
                        connected,
                        extension: unifiedSession.getExtensionConnectionInfo(),
                        note: connected
                            ? 'Extension 模式已连接，无需 connect'
                            : 'Extension 服务器已启动但未连接，请确保 Chrome 已运行且安装了 MCP Chrome 扩展',
                    })
                }

                if (!args.port) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: {
                                        code: 'INVALID_ARGUMENT',
                                        message: '缺少 port 参数',
                                        suggestion: '请指定 port 参数，例如：browse(action="connect", port=9222)',
                                    },
                                }),
                            },
                        ],
                        isError: true,
                    }
                }
                const port = args.port
                return await withPageResponse(
                    unifiedSession,
                    undefined,
                    async () => {
                        const target = await cdpSession.connect({
                            host: args.host ?? '127.0.0.1',
                            port,
                            timeout: args.timeout ?? DEFAULT_TIMEOUT,
                            stealth: args.stealth as 'off' | 'safe' | 'aggressive' | undefined,
                        })
                        unifiedSession.setActiveMode('cdp', true)
                        return formatResponse({
                            success: true,
                            action: 'connect',
                            mode: 'cdp',
                            port: args.port,
                            target,
                            createdTargetId: null,
                        })
                    },
                    true
                )
            }

            case 'list': {
                const mode = unifiedSession.getMode()
                const topology = await unifiedSession.listTopology()
                const allTargets = topology
                    ? topology.windows.flatMap((window) =>
                          window.tabs.map(({ id, ...tab }) => ({
                              ...tab,
                              targetId: tab.targetId ?? String(id),
                              type: tab.type ?? 'page',
                              mode,
                              isActive: tab.active ?? false,
                              metadata: unifiedSession.getPageMetadata(tab.targetId ?? String(id)),
                          }))
                      )
                    : await unifiedSession.listTargets()
                const requestedIds = args.targetIds ? new Set(args.targetIds) : null
                const filtered = requestedIds !== null || args.managedOnly === true
                const selected = allTargets.filter(
                    (tab) =>
                        (!requestedIds || requestedIds.has(tab.targetId)) && (!args.managedOnly || tab.managed === true)
                )
                const selectedIds = new Set(selected.map((tab) => tab.targetId))
                const detail = args.details ?? 'summary'
                const targets = selected.map((tab) => {
                    const { favIconUrl, ...native } = tab
                    const favicon = favIconUrl?.startsWith('data:')
                        ? { favIconInline: true }
                        : favIconUrl !== undefined
                          ? { favIconUrl }
                          : {}
                    if (detail === 'full') return { ...native, ...favicon }
                    return {
                        targetId: tab.targetId,
                        type: tab.type,
                        url: tab.url,
                        title: tab.title,
                        mode,
                        managed: tab.managed ?? false,
                        revision: tab.revision,
                        status: tab.status,
                        isActive: tab.isActive ?? false,
                        windowId: tab.windowId,
                        index: tab.index,
                        groupId: tab.groupId,
                        pinned: tab.pinned,
                        incognito: tab.incognito,
                        metadata: tab.metadata,
                    }
                })
                const windows = topology?.windows
                    .filter(
                        (window) =>
                            !filtered || window.tabs.some((tab) => selectedIds.has(tab.targetId ?? String(tab.id)))
                    )
                    .map(({ tabs, ...window }) => {
                        const targetIds = tabs
                            .map((tab) => tab.targetId ?? String(tab.id))
                            .filter((id) => selectedIds.has(id))
                        return {
                            ...(detail === 'full'
                                ? window
                                : {
                                      id: window.id,
                                      focused: window.focused,
                                      type: window.type,
                                      state: window.state,
                                      incognito: window.incognito,
                                      activeTabId: window.activeTabId,
                                  }),
                            tabCount: targetIds.length,
                            totalTabCount: window.tabCount,
                            targetIds,
                        }
                    })
                const groups = topology?.groups
                    .filter((group) => !filtered || group.targetIds.some((id) => selectedIds.has(id)))
                    .map((group) => ({
                        ...group,
                        targetIds: group.targetIds.filter((id) => selectedIds.has(id)),
                        tabIds: group.tabIds.filter((id) => selectedIds.has(String(id))),
                        totalTabCount: group.targetIds.length,
                    }))

                const result: Record<string, unknown> = {
                    success: true,
                    action: 'list',
                    mode,
                    details: detail,
                    targetCount: targets.length,
                    totalTargetCount: allTargets.length,
                    targets,
                    defaultTargetId: unifiedSession.getCurrentTargetId(),
                    ...(topology
                        ? {
                              windowCount: windows!.length,
                              totalWindowCount: topology.windowCount,
                              focusedWindowId: topology.focusedWindowId,
                              activeTargetId: topology.activeTargetId,
                              windows,
                              groups,
                          }
                        : {}),
                }

                // 当没有连接时，提供安装提示
                if (mode === 'none') {
                    result.note = '未连接浏览器，请确保 Chrome 已运行且 MCP Chrome 扩展已安装'
                }

                return formatResponse(result)
            }

            case 'attach': {
                if (!args.targetId) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: {
                                        code: 'INVALID_ARGUMENT',
                                        message: '缺少 targetId 参数',
                                        suggestion:
                                            '请先使用 browse(action="list") 获取可用页面，然后使用 targetId 附加',
                                    },
                                }),
                            },
                        ],
                        isError: true,
                    }
                }
                return await withPageResponse(unifiedSession, args.targetId, async () => {
                    if (args.activate) {
                        await unifiedSession.activatePage(args.targetId!)
                    } else {
                        await unifiedSession.selectPage(args.targetId!)
                    }
                    return formatResponse({
                        success: true,
                        action: 'attach',
                        mode: unifiedSession.getMode(),
                        targetId: args.targetId,
                        activated: args.activate ?? false,
                        ...pageStateMetadata(unifiedSession),
                    })
                })
            }

            case 'open': {
                return await withPageContext(
                    unifiedSession,
                    args.targetId,
                    async () => {
                        if (!args.url) {
                            return {
                                content: [
                                    {
                                        type: 'text',
                                        text: JSON.stringify({
                                            error: {
                                                code: 'INVALID_ARGUMENT',
                                                message: '缺少 url 参数',
                                                suggestion: '请指定 url 参数',
                                            },
                                        }),
                                    },
                                ],
                                isError: true,
                            }
                        }
                        const currentState = unifiedSession.getState()
                        if (
                            unifiedSession.getMode() === 'extension' &&
                            currentState !== null &&
                            currentState.managed !== true
                        ) {
                            return {
                                content: [
                                    {
                                        type: 'text',
                                        text: JSON.stringify(
                                            {
                                                error: {
                                                    code: 'UNMANAGED_TAB',
                                                    message: 'open 拒绝导航非托管 tab',
                                                    suggestion:
                                                        '请从 browse(action="list") 选择 managed=true 的 tab，' +
                                                        '或用 manage(action="newPage") 创建受控页面',
                                                    context: {
                                                        managed: currentState.managed ?? false,
                                                        url: currentState.url,
                                                        title: currentState.title,
                                                    },
                                                },
                                            },
                                            null,
                                            2
                                        ),
                                    },
                                ],
                                isError: true,
                            }
                        }
                        if (currentState === null) {
                            if (conditional) {
                                throw new Error('没有操作目标，未执行条件导航')
                            }
                            await unifiedSession.newPage(undefined, undefined, remainingNavigationTimeout(deadline))
                        }
                        return unifiedSession.withPageCondition(
                            args,
                            () =>
                                withDiagnosticsResponse(
                                    unifiedSession,
                                    args.diagnostics,
                                    async () => {
                                        await unifiedSession.navigate(args.url!, {
                                            wait: args.wait as WaitUntil,
                                            timeout: remainingNavigationTimeout(deadline),
                                        })
                                        const challenge = await resolveChallenge(
                                            unifiedSession,
                                            'open',
                                            'completed',
                                            Math.max(0, deadline - Date.now())
                                        )
                                        return {
                                            success: true,
                                            action: 'open',
                                            mode: unifiedSession.getMode(),
                                            ...pageStateMetadata(unifiedSession),
                                            ...challengeResultFields(challenge),
                                        }
                                    },
                                    deadline
                                ),
                            deadline
                        )
                    },
                    deadline
                )
            }

            case 'back': {
                return await withPageContext(
                    unifiedSession,
                    args.targetId,
                    () =>
                        unifiedSession.withPageCondition(
                            args,
                            () =>
                                withDiagnosticsResponse(
                                    unifiedSession,
                                    args.diagnostics,
                                    async () => {
                                        const result = await unifiedSession.goBack(remainingNavigationTimeout(deadline))
                                        const challenge = result.navigated
                                            ? await resolveChallenge(
                                                  unifiedSession,
                                                  'back',
                                                  'completed',
                                                  Math.max(0, deadline - Date.now())
                                              )
                                            : undefined
                                        return {
                                            success: true,
                                            action: 'back',
                                            mode: unifiedSession.getMode(),
                                            navigated: result.navigated,
                                            ...pageStateMetadata(unifiedSession),
                                            ...(result.navigated ? {} : { note: '无后退历史' }),
                                            ...(challenge ? challengeResultFields(challenge) : {}),
                                        }
                                    },
                                    deadline
                                ),
                            deadline
                        ),
                    deadline
                )
            }

            case 'forward': {
                return await withPageContext(
                    unifiedSession,
                    args.targetId,
                    () =>
                        unifiedSession.withPageCondition(
                            args,
                            () =>
                                withDiagnosticsResponse(
                                    unifiedSession,
                                    args.diagnostics,
                                    async () => {
                                        const result = await unifiedSession.goForward(
                                            remainingNavigationTimeout(deadline)
                                        )
                                        const challenge = result.navigated
                                            ? await resolveChallenge(
                                                  unifiedSession,
                                                  'forward',
                                                  'completed',
                                                  Math.max(0, deadline - Date.now())
                                              )
                                            : undefined
                                        return {
                                            success: true,
                                            action: 'forward',
                                            mode: unifiedSession.getMode(),
                                            navigated: result.navigated,
                                            ...pageStateMetadata(unifiedSession),
                                            ...(result.navigated ? {} : { note: '无前进历史' }),
                                            ...(challenge ? challengeResultFields(challenge) : {}),
                                        }
                                    },
                                    deadline
                                ),
                            deadline
                        ),
                    deadline
                )
            }

            case 'refresh': {
                return await withPageContext(
                    unifiedSession,
                    args.targetId,
                    () =>
                        unifiedSession.withPageCondition(
                            args,
                            () =>
                                withDiagnosticsResponse(
                                    unifiedSession,
                                    args.diagnostics,
                                    async () => {
                                        await unifiedSession.reload({
                                            ignoreCache: args.ignoreCache ?? false,
                                            waitUntil: args.wait,
                                            timeout: remainingNavigationTimeout(deadline),
                                        })
                                        const challenge = await resolveChallenge(
                                            unifiedSession,
                                            'refresh',
                                            'completed',
                                            Math.max(0, deadline - Date.now())
                                        )
                                        return {
                                            success: true,
                                            action: 'refresh',
                                            mode: unifiedSession.getMode(),
                                            ...pageStateMetadata(unifiedSession),
                                            ...challengeResultFields(challenge),
                                        }
                                    },
                                    deadline
                                ),
                            deadline
                        ),
                    deadline
                )
            }

            case 'close': {
                if (!args.targetId) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: {
                                        code: 'INVALID_ARGUMENT',
                                        message: 'close 需要 targetId 参数，避免在不同模式关闭不同范围的资源',
                                        suggestion:
                                            '请先使用 browse(action="list") 获取页面 targetId，再指定要关闭的页面',
                                    },
                                }),
                            },
                        ],
                        isError: true,
                    }
                }

                return await withPageResponse(unifiedSession, args.targetId, () =>
                    unifiedSession.withPageCondition(args, async () => {
                        const affected = await unifiedSession.closePage(args.targetId!)
                        return formatResponse({
                            success: true,
                            action: 'close',
                            mode: unifiedSession.getMode(),
                            targetId: args.targetId,
                            ...(affected ? { affected } : {}),
                        })
                    })
                )
            }

            default:
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                error: {
                                    code: 'INVALID_ARGUMENT',
                                    message: `未知操作: ${args.action}`,
                                },
                            }),
                        },
                    ],
                    isError: true,
                }
        }
    } catch (error) {
        return formatErrorResponse(error)
    }
}

/**
 * 注册 browse 工具
 */
export function registerBrowseTool(server: McpServer): void {
    server.registerTool(
        'browse',
        {
            description: [
                '浏览器管理与导航。默认优先使用已连接的 Chrome Extension 和用户真实 Chrome；',
                'Extension 不可用时才回退 CDP。仅 browse(action="connect", port=…) 会显式选择 CDP。',
                '过 Cloudflare 时，Extension 先被动等待真实 tab 标题恢复，避免先附加 debugger；',
                '只有持续出现可点击 Turnstile 时才点击。同页测试按钮走页面点击；',
                'Extension inspect 走 isolated world，不先挂 debugger。',
                'Cloudflare iframe 或宿主页验证按钮只在已聚焦窗口的活动受控 tab 上用系统鼠标，',
                'Linux 用窗口原点加边距，沿路径移动、悬停后再按下抬起，混合窗口不会调用 focusWindow。',
                'open/back/forward/refresh 的 timeout 包含等待。交互式验证码和 Access denied 无法自动完成',
            ].join(''),
            inputSchema: browseSchema,
        },
        (args) => handleBrowse(args)
    )
}
