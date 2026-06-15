/**
 * manage 工具
 *
 * 页面与环境管理：
 * - newPage: 新建页面
 * - closePage: 关闭页面
 * - clearCache: 清除缓存
 * - viewport: 设置视口
 * - userAgent: 设置 User-Agent
 * - emulate: 设备模拟
 * - inputMode: 设置输入模式（stealth/precise）
 * - stealth: 注入反检测脚本
 * - cdp: 发送任意 CDP 命令（高级）
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { devices, formatErrorResponse, formatResponse, getSession, getUnifiedSession } from '../core/index.js'
import type { CacheType } from '../core/types.js'

function invalidArgument(
    message: string,
    suggestion?: string
): {
    content: Array<{ type: 'text'; text: string }>
    isError: true
} {
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    error: {
                        code: 'INVALID_ARGUMENT',
                        message,
                        ...(suggestion ? { suggestion } : {}),
                    },
                }),
            },
        ],
        isError: true,
    }
}

function formatAffectedResponse(
    action: string,
    mode: string,
    affected: unknown
): {
    content: Array<{ type: 'text'; text: string }>
} {
    return formatResponse({
        success: true,
        action,
        mode,
        affected,
    })
}

const manageSchema = z.object({
    action: z
        .enum([
            'newPage',
            'closePage',
            'adoptPage',
            'releasePage',
            'movePage',
            'reorderPage',
            'pinPage',
            'unpinPage',
            'activatePage',
            'focusWindow',
            'resizeWindow',
            'newWindow',
            'closeWindow',
            'clearCache',
            'viewport',
            'userAgent',
            'emulate',
            'inputMode',
            'stealth',
            'cdp',
        ])
        .describe('管理操作'),
    inputMode: z
        .enum(['stealth', 'precise'])
        .optional()
        .describe(
            '输入模式（inputMode），precise=debugger API（默认，可绕过 CSP 但显示调试提示）；stealth=JS 事件模拟（不触发调试提示但受 CSP 限制，适用于反检测场景）'
        ),
    cdpMethod: z.string().optional().describe('CDP 方法名（cdp），如 Runtime.evaluate、Page.captureScreenshot'),
    cdpParams: z.record(z.string(), z.unknown()).optional().describe('CDP 方法参数（cdp）'),
    targetId: z
        .string()
        .optional()
        .describe('目标页面 ID（closePage/adoptPage/releasePage/movePage/reorderPage/pinPage/unpinPage/activatePage）'),
    windowId: z.number().int().optional().describe('窗口 ID（movePage/focusWindow/resizeWindow/closeWindow）'),
    index: z.number().int().nonnegative().optional().describe('tab 顺序 index（movePage/reorderPage）'),
    activate: z.boolean().optional().describe('movePage 后是否激活目标 tab'),
    focused: z.boolean().optional().describe('newWindow 是否聚焦新窗口，默认 false'),
    incognito: z.boolean().optional().describe('newWindow 是否创建隐身窗口'),
    left: z.number().int().optional().describe('窗口左上角 x 坐标（newWindow/resizeWindow）'),
    top: z.number().int().optional().describe('窗口左上角 y 坐标（newWindow/resizeWindow）'),
    windowState: z
        .enum(['normal', 'minimized', 'maximized', 'fullscreen', 'locked-fullscreen'])
        .optional()
        .describe('窗口状态（newWindow/resizeWindow）'),
    url: z.string().optional().describe('newWindow 初始 URL'),
    cacheType: z
        .enum(['all', 'storage', 'cache'])
        .optional()
        .describe('清除类型（clearCache）；不再支持 cookies，请使用 cookies action=clear（强制 name/domain/url 过滤）'),
    width: z.number().optional().describe('视口宽度（viewport）'),
    height: z.number().optional().describe('视口高度（viewport）'),
    userAgent: z.string().optional().describe('User-Agent 字符串（userAgent）'),
    device: z.string().optional().describe('设备名称（emulate），如 iPhone 13, iPad Pro'),
})

type ManageArgs = z.infer<typeof manageSchema>

type ManageResponse = {
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
}

interface ManageContext {
    unifiedSession: ReturnType<typeof getUnifiedSession>
    mode: ReturnType<ReturnType<typeof getUnifiedSession>['getMode']>
}

type ManageHandler = (context: ManageContext, args: ManageArgs) => Promise<ManageResponse> | ManageResponse

async function handleManage(args: ManageArgs): Promise<ManageResponse> {
    try {
        const unifiedSession = getUnifiedSession()
        const mode = unifiedSession.getMode()
        return await manageHandlers[args.action]({ unifiedSession, mode }, args)
    } catch (error) {
        return formatErrorResponse(error)
    }
}

async function handleNewPage({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    const target = await unifiedSession.newPage(args.url)
    return formatResponse({ success: true, action: 'newPage', target, mode })
}

async function handleClosePage({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    const affected = await unifiedSession.closePage(args.targetId)
    return formatResponse({
        success: true,
        action: 'closePage',
        targetId: args.targetId ?? 'current',
        mode,
        ...(affected ? { affected } : {}),
    })
}

async function handleAdoptPage({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (!args.targetId) {
        return invalidArgument(
            'adoptPage 需要 targetId 参数',
            '请先使用 browse(action="list") 获取目标 tab 的 targetId'
        )
    }
    const result = await unifiedSession.adoptPage(args.targetId)
    return formatResponse({ success: true, action: 'adoptPage', mode, targetId: args.targetId, ...result })
}

async function handleReleasePage({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (!args.targetId) {
        return invalidArgument(
            'releasePage 需要 targetId 参数',
            '请先使用 browse(action="list") 获取目标 tab 的 targetId'
        )
    }
    const result = await unifiedSession.releasePage(args.targetId)
    return formatResponse({ success: true, action: 'releasePage', mode, targetId: args.targetId, ...result })
}

async function handleMovePage({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (!args.targetId) {
        return invalidArgument('movePage 需要 targetId 参数', '请先使用 browse(action="list") 获取目标 tab 的 targetId')
    }
    const affected = await unifiedSession.movePage(args.targetId, {
        windowId: args.windowId,
        index: args.index,
        activate: args.activate,
    })
    return formatAffectedResponse('movePage', mode, affected)
}

async function handleReorderPage({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (!args.targetId) {
        return invalidArgument(
            'reorderPage 需要 targetId 参数',
            '请先使用 browse(action="list") 获取目标 tab 的 targetId'
        )
    }
    if (args.index === undefined) {
        return invalidArgument('reorderPage 需要 index 参数')
    }
    const affected = await unifiedSession.reorderPage(args.targetId, args.index)
    return formatAffectedResponse('reorderPage', mode, affected)
}

async function handlePinPage({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (!args.targetId) {
        return invalidArgument('pinPage 需要 targetId 参数', '请先使用 browse(action="list") 获取目标 tab 的 targetId')
    }
    const affected = await unifiedSession.pinPage(args.targetId, true)
    return formatAffectedResponse('pinPage', mode, affected)
}

async function handleUnpinPage({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (!args.targetId) {
        return invalidArgument(
            'unpinPage 需要 targetId 参数',
            '请先使用 browse(action="list") 获取目标 tab 的 targetId'
        )
    }
    const affected = await unifiedSession.pinPage(args.targetId, false)
    return formatAffectedResponse('unpinPage', mode, affected)
}

async function handleActivatePage({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (!args.targetId) {
        return invalidArgument(
            'activatePage 需要 targetId 参数',
            '请先使用 browse(action="list") 获取目标 tab 的 targetId'
        )
    }
    const affected = await unifiedSession.activatePageWithAffected(args.targetId)
    return formatAffectedResponse('activatePage', mode, affected)
}

async function handleFocusWindow({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (args.windowId === undefined) {
        return invalidArgument('focusWindow 需要 windowId 参数')
    }
    const affected = await unifiedSession.focusWindow(args.windowId)
    return formatAffectedResponse('focusWindow', mode, affected)
}

async function handleResizeWindow({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (args.windowId === undefined) {
        return invalidArgument('resizeWindow 需要 windowId 参数')
    }
    const affected = await unifiedSession.resizeWindow(args.windowId, {
        left: args.left,
        top: args.top,
        width: args.width,
        height: args.height,
        state: args.windowState,
    })
    return formatAffectedResponse('resizeWindow', mode, affected)
}

async function handleNewWindow({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    const affected = await unifiedSession.newWindow({
        url: args.url,
        focused: args.focused,
        incognito: args.incognito,
        left: args.left,
        top: args.top,
        width: args.width,
        height: args.height,
        state: args.windowState,
    })
    return formatAffectedResponse('newWindow', mode, affected)
}

async function handleCloseWindow({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (args.windowId === undefined) {
        return invalidArgument('closeWindow 需要 windowId 参数')
    }
    const affected = await unifiedSession.closeWindow(args.windowId)
    return formatAffectedResponse('closeWindow', mode, affected)
}

async function handleClearCache({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    return unifiedSession.withTabId(undefined, async () => {
        const cacheType = (args.cacheType ?? 'all') as CacheType
        if (mode === 'extension') {
            return formatResponse({
                success: true,
                action: 'clearCache',
                cacheType,
                mode,
                warning:
                    'Extension 模式不支持 clearCache，如需清除 cookies 请使用 cookies action=clear（必须带 name/domain/url 过滤），如需清除 storage/cache 请切换到 CDP 模式',
            })
        }
        const session = getSession()
        await session.clearCache(cacheType)
        return formatResponse({ success: true, action: 'clearCache', cacheType, mode })
    })
}

async function handleViewport({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    return unifiedSession.withTabId(undefined, async () => {
        if (args.width === undefined || args.height === undefined) {
            return invalidArgument('设置视口需要 width 和 height 参数')
        }
        if (mode === 'extension') {
            await unifiedSession.sendCdpCommand('Emulation.setDeviceMetricsOverride', {
                width: args.width,
                height: args.height,
                deviceScaleFactor: 1,
                mobile: false,
            })
            await unifiedSession.sendCdpCommand('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
            await unifiedSession.sendCdpCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
        } else {
            const session = getSession()
            await session.setViewport(args.width, args.height)
        }
        await unifiedSession.evaluate('window.dispatchEvent(new Event("resize"))')
        return formatResponse({ success: true, action: 'viewport', width: args.width, height: args.height, mode })
    })
}

async function handleUserAgent({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    return unifiedSession.withTabId(undefined, async () => {
        if (!args.userAgent) {
            return invalidArgument('设置 User-Agent 需要 userAgent 参数')
        }
        if (mode === 'extension') {
            await unifiedSession.sendCdpCommand('Emulation.setUserAgentOverride', { userAgent: args.userAgent })
        } else {
            const session = getSession()
            await session.setUserAgent(args.userAgent)
        }
        return formatResponse({ success: true, action: 'userAgent', userAgent: args.userAgent, mode })
    })
}

function handleInputMode({ unifiedSession, mode }: ManageContext, args: ManageArgs): ManageResponse {
    if (!args.inputMode) {
        return formatResponse({
            success: true,
            action: 'inputMode',
            currentMode: unifiedSession.getInputMode(),
            availableModes: ['stealth', 'precise'],
            description: {
                stealth: 'JS 事件模拟，不触发调试提示，但受 CSP 限制（evaluate 可能失败）',
                precise: 'debugger API，可绕过 CSP，但显示"扩展程序正在调试此浏览器"',
            },
        })
    }
    unifiedSession.setInputMode(args.inputMode)
    return formatResponse({ success: true, action: 'inputMode', inputMode: args.inputMode, mode })
}

async function handleEmulate({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    return unifiedSession.withTabId(undefined, async () => {
        if (!args.device) {
            return formatResponse({ success: true, action: 'emulate', availableDevices: Object.keys(devices) })
        }
        const device = devices[args.device]
        if (!device) {
            return invalidArgument(`未知设备: ${args.device}`, `可用设备: ${Object.keys(devices).join(', ')}`)
        }
        if (mode === 'extension') {
            await unifiedSession.sendCdpCommand('Emulation.setDeviceMetricsOverride', {
                width: device.viewport.width,
                height: device.viewport.height,
                deviceScaleFactor: device.viewport.deviceScaleFactor || 1,
                mobile: device.viewport.isMobile || false,
            })
            await unifiedSession.sendCdpCommand('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
            await unifiedSession.sendCdpCommand('Emulation.setTouchEmulationEnabled', {
                enabled: device.viewport.hasTouch,
                maxTouchPoints: device.viewport.hasTouch ? 1 : 0,
            })
            await unifiedSession.sendCdpCommand('Emulation.setUserAgentOverride', { userAgent: device.userAgent })
        } else {
            const session = getSession()
            await session.setViewport(device.viewport.width, device.viewport.height)
            await session.setUserAgent(device.userAgent)
        }
        await unifiedSession.evaluate('window.dispatchEvent(new Event("resize"))')
        return formatResponse({
            success: true,
            action: 'emulate',
            device: args.device,
            viewport: device.viewport,
            mode,
        })
    })
}

async function handleStealth({ unifiedSession, mode }: ManageContext): Promise<ManageResponse> {
    return unifiedSession.withTabId(undefined, async () => {
        await unifiedSession.injectStealth()
        return formatResponse({ success: true, action: 'stealth', mode, note: '已注入反检测脚本' })
    })
}

async function handleCdp({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    return unifiedSession.withTabId(undefined, async () => {
        if (!args.cdpMethod) {
            return invalidArgument(
                '缺少 cdpMethod 参数',
                '请指定 CDP 方法名，如 Runtime.evaluate、Page.captureScreenshot'
            )
        }
        try {
            const result = await unifiedSession.sendCdpCommand(args.cdpMethod, args.cdpParams)
            return formatResponse({ success: true, action: 'cdp', method: args.cdpMethod, result, mode })
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error)
            if (
                mode === 'extension' &&
                (errorMessage.includes('not supported') || errorMessage.includes('not found'))
            ) {
                const domain = args.cdpMethod.split('.')[0]
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                error: {
                                    code: 'CDP_DOMAIN_NOT_SUPPORTED',
                                    message: `Extension 模式不支持 ${domain} 域`,
                                    suggestion:
                                        'Extension 模式可用域：Page、Runtime、Emulation、DOM、Input、Network，' +
                                        '如需完整 CDP 支持，请使用 CDP 模式（browse action="launch"）',
                                },
                            }),
                        },
                    ],
                    isError: true,
                }
            }
            return formatErrorResponse(error)
        }
    })
}

const manageHandlers: Record<ManageArgs['action'], ManageHandler> = {
    newPage: handleNewPage,
    closePage: handleClosePage,
    adoptPage: handleAdoptPage,
    releasePage: handleReleasePage,
    movePage: handleMovePage,
    reorderPage: handleReorderPage,
    pinPage: handlePinPage,
    unpinPage: handleUnpinPage,
    activatePage: handleActivatePage,
    focusWindow: handleFocusWindow,
    resizeWindow: handleResizeWindow,
    newWindow: handleNewWindow,
    closeWindow: handleCloseWindow,
    clearCache: handleClearCache,
    viewport: handleViewport,
    userAgent: handleUserAgent,
    emulate: handleEmulate,
    inputMode: handleInputMode,
    stealth: handleStealth,
    cdp: handleCdp,
}

export function registerManageTool(server: McpServer): void {
    server.registerTool(
        'manage',
        {
            description: '页面与环境管理：新建页面、关闭页面、受控页 adopt/release、缓存、视口、UA、设备模拟',
            inputSchema: manageSchema,
        },
        (args) => handleManage(args)
    )
}
