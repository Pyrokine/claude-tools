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
import {
    devices,
    formatErrorResponse,
    formatResponse,
    getSession,
    getUnifiedSession,
    isNativeExecutionResultUnknown,
} from '../core/index.js'
import type { CacheType } from '../core/types.js'
import { withPageResponse } from './page-context.js'
import { pageConditionSchema } from './schema.js'

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

const manageSchema = z
    .object({
        ...pageConditionSchema,
        action: z
            .enum([
                'newPage',
                'pageMetadata',
                'closePage',
                'adoptPage',
                'releasePage',
                'grantReadAccess',
                'revokeReadAccess',
                'updatePage',
                'movePage',
                'reorderPage',
                'pinPage',
                'unpinPage',
                'activatePage',
                'focusWindow',
                'resizeWindow',
                'newWindow',
                'closeWindow',
                'updateWindow',
                'groupPages',
                'ungroupPages',
                'updateGroup',
                'moveGroup',
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
        targetId: z.string().optional().describe('目标页面 ID；newWindow 时将此受控页面移入新窗口'),
        targetIds: z.array(z.string().min(1)).min(1).optional().describe('groupPages/ungroupPages 的受控页面 ID 列表'),
        windowId: z
            .number()
            .int()
            .optional()
            .describe('窗口 ID；newPage/groupPages 指定所属窗口，movePage/moveGroup 指定目标窗口'),
        index: z
            .number()
            .int()
            .min(-1)
            .optional()
            .describe('页面或分组在窗口中的位置；移动时 -1 表示末尾，newPage 必须非负'),
        groupId: z
            .number()
            .int()
            .min(-1)
            .optional()
            .describe('分组 ID；newPage 的 -1 表示不分组，groupPages 省略时创建新组'),
        title: z.string().optional().describe('groupPages/updateGroup 的分组名称，可设为空字符串'),
        color: z
            .enum(['blue', 'cyan', 'green', 'grey', 'orange', 'pink', 'purple', 'red', 'yellow'])
            .optional()
            .describe('groupPages/updateGroup 的分组颜色'),
        collapsed: z.boolean().optional().describe('groupPages/updateGroup 是否折叠分组'),
        active: z
            .boolean()
            .optional()
            .describe('newPage 是否为窗口内活动页，默认 false；updatePage 只支持 true，不聚焦窗口'),
        pinned: z.boolean().optional().describe('newPage/updatePage 是否固定页面'),
        highlighted: z.boolean().optional().describe('updatePage 是否选中页面'),
        muted: z.boolean().optional().describe('updatePage 是否静音页面'),
        autoDiscardable: z.boolean().optional().describe('updatePage 是否允许浏览器自动丢弃页面内容'),
        openerTabId: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('newPage/updatePage 的来源 tab ID，必须位于同一窗口'),
        activate: z.boolean().optional().describe('movePage 后是否激活目标 tab'),
        focused: z
            .boolean()
            .optional()
            .describe('newWindow/updateWindow/resizeWindow 是否聚焦窗口；newWindow 默认 false'),
        drawAttention: z.boolean().optional().describe('updateWindow/resizeWindow 是否请求窗口提醒，不改变焦点'),
        windowType: z
            .enum(['normal', 'popup'])
            .optional()
            .describe('newWindow 的窗口类型，默认 normal；popup 只支持一个页面'),
        setSelfAsOpener: z.boolean().optional().describe('newWindow 是否将窗口创建者设为 window.opener'),
        incognito: z.boolean().optional().describe('newWindow 是否创建隐身窗口'),
        left: z.number().int().optional().describe('窗口左上角 x 坐标（newWindow/resizeWindow）'),
        top: z.number().int().optional().describe('窗口左上角 y 坐标（newWindow/resizeWindow）'),
        windowState: z
            .enum(['normal', 'minimized', 'maximized', 'fullscreen', 'locked-fullscreen'])
            .optional()
            .describe('窗口状态（newWindow/resizeWindow）'),
        url: z.string().min(1).optional().describe('newPage/newWindow 初始 URL，或 updatePage 的导航 URL'),
        urls: z
            .array(z.string().min(1))
            .min(1)
            .optional()
            .describe('newWindow 创建多个页面的初始 URL，与 url 互斥，可与 targetId 同时使用'),
        timeout: z.number().positive().optional().describe('newPage 的页面加载超时毫秒'),
        cacheType: z
            .enum(['all', 'storage', 'cache'])
            .optional()
            .describe(
                '清除类型（clearCache）；不再支持 cookies，请使用 cookies action=clear（强制 name/domain/url 过滤）'
            ),
        width: z.number().optional().describe('视口宽度（viewport）'),
        height: z.number().optional().describe('视口高度（viewport）'),
        userAgent: z.string().optional().describe('User-Agent 字符串（userAgent）'),
        device: z.string().optional().describe('设备名称（emulate），如 iPhone 13, iPad Pro'),
        taskHint: z.string().max(120).nullable().optional().describe('pageMetadata：任务提示，null 清除'),
        note: z.string().max(1000).nullable().optional().describe('pageMetadata：页面备注，null 清除'),
    })
    .strict()
    .superRefine((args, context) => {
        const scopes: Record<string, string[]> = {
            activate: ['movePage'],
            targetIds: ['groupPages', 'ungroupPages'],
            groupId: ['newPage', 'groupPages', 'updateGroup', 'moveGroup'],
            title: ['groupPages', 'updateGroup'],
            color: ['groupPages', 'updateGroup'],
            collapsed: ['groupPages', 'updateGroup'],
            active: ['newPage', 'updatePage'],
            pinned: ['newPage', 'updatePage'],
            openerTabId: ['newPage', 'updatePage'],
            highlighted: ['updatePage'],
            muted: ['updatePage'],
            autoDiscardable: ['updatePage'],
            index: ['newPage', 'movePage', 'reorderPage', 'moveGroup'],
            windowId: [
                'newPage',
                'movePage',
                'groupPages',
                'moveGroup',
                'focusWindow',
                'resizeWindow',
                'updateWindow',
                'closeWindow',
            ],
            focused: ['newWindow', 'updateWindow', 'resizeWindow'],
            drawAttention: ['updateWindow', 'resizeWindow'],
            windowType: ['newWindow'],
            setSelfAsOpener: ['newWindow'],
            incognito: ['newWindow'],
            urls: ['newWindow'],
            url: ['newPage', 'newWindow', 'updatePage'],
            timeout: ['newPage'],
            left: ['newWindow', 'resizeWindow', 'updateWindow'],
            top: ['newWindow', 'resizeWindow', 'updateWindow'],
            width: ['newWindow', 'resizeWindow', 'updateWindow', 'viewport'],
            height: ['newWindow', 'resizeWindow', 'updateWindow', 'viewport'],
            windowState: ['newWindow', 'resizeWindow', 'updateWindow'],
        }
        for (const [field, actions] of Object.entries(scopes)) {
            if (args[field as keyof typeof args] !== undefined && !actions.includes(args.action)) {
                context.addIssue({ code: 'custom', path: [field], message: `${args.action} 不支持 ${field}，未执行` })
            }
        }
        if (args.action === 'newPage') {
            if (args.index !== undefined && args.index < 0) {
                context.addIssue({ code: 'custom', path: ['index'], message: 'newPage 的 index 必须非负' })
            }
            if (args.pinned && args.groupId !== undefined && args.groupId >= 0) {
                context.addIssue({ code: 'custom', path: ['groupId'], message: 'pinned=true 与分组不兼容' })
            }
        } else if (args.groupId !== undefined && args.groupId < 0) {
            context.addIssue({ code: 'custom', path: ['groupId'], message: '此操作需要现有分组 ID' })
        }
        if (
            args.action === 'groupPages' &&
            args.groupId !== undefined &&
            [args.title, args.color, args.collapsed, args.windowId].some((value) => value !== undefined)
        ) {
            context.addIssue({
                code: 'custom',
                path: ['groupId'],
                message: '加入已有分组仅接受页面列表与 groupId；修改分组请用 updateGroup/moveGroup',
            })
        }
        if (args.action === 'newWindow' && args.url !== undefined && args.urls !== undefined) {
            context.addIssue({ code: 'custom', message: 'newWindow 的 url 与 urls 互斥' })
        }
        if (args.action === 'updatePage' && args.active === false) {
            context.addIssue({ code: 'custom', path: ['active'], message: 'updatePage 不支持 active=false，未执行' })
        }
        if (
            args.action === 'newWindow' &&
            args.windowType === 'popup' &&
            (args.urls?.length ?? (args.url !== undefined ? 1 : 0)) + (args.targetId !== undefined ? 1 : 0) > 1
        ) {
            context.addIssue({
                code: 'custom',
                path: ['windowType'],
                message: 'popup 只支持一个页面，请使用 normal 窗口',
            })
        }
        if (['newWindow', 'updateWindow', 'resizeWindow'].includes(args.action)) {
            for (const field of ['width', 'height'] as const) {
                const value = args[field]
                if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
                    context.addIssue({ code: 'custom', path: [field], message: '窗口尺寸必须是正整数' })
                }
            }
            if (
                ['minimized', 'maximized', 'fullscreen', 'locked-fullscreen'].includes(args.windowState ?? '') &&
                [args.left, args.top, args.width, args.height].some((value) => value !== undefined)
            ) {
                context.addIssue({
                    code: 'custom',
                    path: ['windowState'],
                    message: '非 normal 窗口状态不能与窗口位置或尺寸同时设置',
                })
            }
            if (
                args.action !== 'newWindow' &&
                ((args.focused === true && args.windowState === 'minimized') ||
                    (args.focused === false &&
                        ['maximized', 'fullscreen', 'locked-fullscreen'].includes(args.windowState ?? '')))
            ) {
                context.addIssue({ code: 'custom', path: ['focused'], message: 'focused 与窗口状态冲突' })
            }
        }
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
        const handler = async () => manageHandlers[args.action]({ unifiedSession, mode }, args)
        const pageActions: ManageArgs['action'][] = [
            'pageMetadata',
            'closePage',
            'adoptPage',
            'releasePage',
            'grantReadAccess',
            'revokeReadAccess',
            'updatePage',
            'movePage',
            'reorderPage',
            'pinPage',
            'unpinPage',
            'activatePage',
            'viewport',
            'userAgent',
            'emulate',
            'stealth',
            'cdp',
        ]
        const conditional = args.expectedUrl !== undefined || args.expectedRevision !== undefined
        if (args.action === 'emulate' && !args.device) {
            if (conditional) {
                return invalidArgument('设备目录查询不支持页面条件，未读取页面')
            }
            return await handler()
        }
        if (args.action === 'newPage' && args.targetId) {
            return invalidArgument('newPage 创建新页面，不接受已有 targetId')
        }
        if (conditional && !pageActions.includes(args.action)) {
            return invalidArgument(`${args.action} 不支持页面条件，未执行操作`)
        }
        if (
            conditional &&
            args.action === 'cdp' &&
            (!args.cdpMethod || /^(Target|Browser|SystemInfo|DeviceAccess|IO)\./.test(args.cdpMethod))
        ) {
            return invalidArgument('browser-level CDP 命令不支持页面条件，未执行操作')
        }
        const targetSelectionActions: ManageArgs['action'][] = ['viewport', 'userAgent', 'emulate', 'stealth', 'cdp']
        const run = () =>
            conditional
                ? targetSelectionActions.includes(args.action)
                    ? unifiedSession.withTabId(args.targetId, () => unifiedSession.withPageCondition(args, handler))
                    : unifiedSession.withPageCondition(args, handler)
                : handler()
        if (
            pageActions.includes(args.action) ||
            ['newPage', 'newWindow', 'pageMetadata', 'clearCache'].includes(args.action)
        ) {
            return await withPageResponse(
                unifiedSession,
                args.targetId,
                run,
                args.action === 'newPage' || (args.action === 'newWindow' && args.targetId === undefined)
            )
        }
        return await run()
    } catch (error) {
        return formatErrorResponse(error)
    }
}

async function handleNewPage({ unifiedSession }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    const target = await unifiedSession.newPage(
        args.url,
        {
            windowId: args.windowId,
            index: args.index,
            groupId: args.groupId,
            active: args.active,
            pinned: args.pinned,
            openerTabId: args.openerTabId,
        },
        args.timeout
    )
    return formatResponse({
        success: true,
        action: 'newPage',
        target,
        createdTargetId: target.targetId,
        metadata: unifiedSession.getPageMetadata(target.targetId),
        mode: unifiedSession.getMode(),
    })
}

async function handlePageMetadata({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (!args.targetId) {
        return invalidArgument('pageMetadata 需要 targetId 参数')
    }
    await unifiedSession.getPageSnapshot(args.targetId)
    const metadata =
        args.taskHint !== undefined || args.note !== undefined
            ? await unifiedSession.setPageMetadata(args.targetId, { taskHint: args.taskHint, note: args.note })
            : unifiedSession.getPageMetadata(args.targetId)
    return formatResponse({ success: true, action: 'pageMetadata', targetId: args.targetId, mode, metadata })
}

async function handleClosePage({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (!args.targetId) {
        return invalidArgument('closePage 需要 targetId 参数，未关闭页面')
    }
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

async function handleReadAccess({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (!args.targetId) {
        return invalidArgument(`${args.action} 需要 targetId，未修改权限`)
    }
    const result = await unifiedSession.setReadAccess(args.targetId, args.action === 'grantReadAccess')
    return formatResponse({ ...result, action: args.action, mode })
}

async function handleUpdatePage({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (!args.targetId) {
        return invalidArgument('updatePage 需要 targetId 参数，未执行')
    }
    const affected = await unifiedSession.updatePage(args.targetId, {
        url: args.url,
        active: args.active,
        pinned: args.pinned,
        highlighted: args.highlighted,
        muted: args.muted,
        autoDiscardable: args.autoDiscardable,
        openerTabId: args.openerTabId,
    })
    return formatAffectedResponse('updatePage', mode, affected)
}

async function handleGroupPages({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (!args.targetIds) {
        return invalidArgument('groupPages 需要 targetIds 参数，未执行')
    }
    const affected = await unifiedSession.groupPages(args.targetIds, {
        groupId: args.groupId,
        windowId: args.windowId,
        title: args.title,
        color: args.color,
        collapsed: args.collapsed,
    })
    return formatAffectedResponse('groupPages', mode, affected)
}

async function handleUngroupPages({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (!args.targetIds) {
        return invalidArgument('ungroupPages 需要 targetIds 参数，未执行')
    }
    return formatAffectedResponse('ungroupPages', mode, await unifiedSession.ungroupPages(args.targetIds))
}

async function handleUpdateGroup({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (args.groupId === undefined) {
        return invalidArgument('updateGroup 需要 groupId 参数，未执行')
    }
    const affected = await unifiedSession.updateGroup(args.groupId, {
        title: args.title,
        color: args.color,
        collapsed: args.collapsed,
    })
    return formatAffectedResponse('updateGroup', mode, affected)
}

async function handleMoveGroup({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (args.groupId === undefined || args.index === undefined) {
        return invalidArgument('moveGroup 需要 groupId 和 index 参数，未执行')
    }
    const affected = await unifiedSession.moveGroup(args.groupId, { windowId: args.windowId, index: args.index })
    return formatAffectedResponse('moveGroup', mode, affected)
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
        focused: args.focused,
        drawAttention: args.drawAttention,
    })
    return formatAffectedResponse('resizeWindow', mode, affected)
}

async function handleUpdateWindow({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (args.windowId === undefined) {
        return invalidArgument('updateWindow 需要 windowId 参数，未执行')
    }
    const affected = await unifiedSession.updateWindow(args.windowId, {
        left: args.left,
        top: args.top,
        width: args.width,
        height: args.height,
        state: args.windowState,
        focused: args.focused,
        drawAttention: args.drawAttention,
    })
    return formatAffectedResponse('updateWindow', mode, affected)
}

async function handleNewWindow({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    const affected = await unifiedSession.newWindow({
        url: args.urls ?? args.url,
        targetId: args.targetId,
        type: args.windowType,
        setSelfAsOpener: args.setSelfAsOpener,
        focused: args.focused,
        incognito: args.incognito,
        left: args.left,
        top: args.top,
        width: args.width,
        height: args.height,
        state: args.windowState,
    })
    return formatResponse({
        success: true,
        action: 'newWindow',
        mode,
        affected,
        ...(args.targetId === undefined
            ? { createdTargetId: affected.targetId ?? null }
            : { targetId: affected.targetId }),
    })
}

async function handleCloseWindow({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    if (args.windowId === undefined) {
        return invalidArgument('closeWindow 需要 windowId 参数')
    }
    const affected = await unifiedSession.closeWindow(args.windowId)
    return formatAffectedResponse('closeWindow', mode, affected)
}

async function handleClearCache({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    return unifiedSession.withTabId(args.targetId, async () => {
        const cacheType = (args.cacheType ?? 'all') as CacheType
        if (mode === 'extension') {
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            error: {
                                code: 'UNSUPPORTED_MODE',
                                message: 'Extension 模式不支持 clearCache，未执行清除操作',
                                suggestion:
                                    '清除 cookies 请使用 cookies action=clear（必须带 url 或 domain 过滤），' +
                                    '清除 storage/cache 请切换到 CDP 模式',
                            },
                            action: 'clearCache',
                            cacheType,
                            mode,
                            actionPerformed: false,
                        }),
                    },
                ],
                isError: true,
            }
        }
        const session = getSession()
        await session.clearCache(cacheType)
        return formatResponse({ success: true, action: 'clearCache', cacheType, mode })
    })
}

async function handleViewport({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    return unifiedSession.withTabId(args.targetId, async () => {
        if (args.width === undefined || args.height === undefined) {
            return invalidArgument('设置视口需要 width 和 height 参数')
        }
        await unifiedSession.sendCdpCommand('Emulation.setDeviceMetricsOverride', {
            width: args.width,
            height: args.height,
            deviceScaleFactor: 1,
            mobile: false,
        })
        await unifiedSession.sendCdpCommand('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
        await unifiedSession.sendCdpCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
        await unifiedSession.evaluate('window.dispatchEvent(new Event("resize"))', 'precise')
        return formatResponse({ success: true, action: 'viewport', width: args.width, height: args.height, mode })
    })
}

async function handleUserAgent({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    return unifiedSession.withTabId(args.targetId, async () => {
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
    if (!args.device) {
        return formatResponse({ success: true, action: 'emulate', availableDevices: Object.keys(devices) })
    }
    const device = devices[args.device]
    if (!device) {
        return invalidArgument(`未知设备: ${args.device}`, `可用设备: ${Object.keys(devices).join(', ')}`)
    }
    return unifiedSession.withTabId(args.targetId, async () => {
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
        await unifiedSession.evaluate('window.dispatchEvent(new Event("resize"))', 'precise')
        return formatResponse({
            success: true,
            action: 'emulate',
            device: args.device,
            viewport: device.viewport,
            mode,
        })
    })
}

async function handleStealth({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    return unifiedSession.withTabId(args.targetId, async () => {
        await unifiedSession.injectStealth()
        return formatResponse({ success: true, action: 'stealth', mode, note: '已注入反检测脚本' })
    })
}

async function handleCdp({ unifiedSession, mode }: ManageContext, args: ManageArgs): Promise<ManageResponse> {
    return unifiedSession.withTabId(args.targetId, async () => {
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
            const response = formatErrorResponse(error)
            if (isNativeExecutionResultUnknown(error)) {
                const payload = JSON.parse(response.content[0]!.text) as Record<string, unknown>
                Object.assign(payload, { actionExecuted: true, actionStatus: 'unknown', retryable: false })
                response.content[0]!.text = JSON.stringify(payload, null, 2)
            }
            return response
        }
    })
}

const manageHandlers: Record<ManageArgs['action'], ManageHandler> = {
    newPage: handleNewPage,
    pageMetadata: handlePageMetadata,
    closePage: handleClosePage,
    adoptPage: handleAdoptPage,
    releasePage: handleReleasePage,
    grantReadAccess: handleReadAccess,
    revokeReadAccess: handleReadAccess,
    updatePage: handleUpdatePage,
    movePage: handleMovePage,
    reorderPage: handleReorderPage,
    pinPage: handlePinPage,
    unpinPage: handleUnpinPage,
    activatePage: handleActivatePage,
    focusWindow: handleFocusWindow,
    resizeWindow: handleResizeWindow,
    newWindow: handleNewWindow,
    closeWindow: handleCloseWindow,
    updateWindow: handleUpdateWindow,
    groupPages: handleGroupPages,
    ungroupPages: handleUngroupPages,
    updateGroup: handleUpdateGroup,
    moveGroup: handleMoveGroup,
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
            description:
                '页面、窗口与分组管理：创建、更新、移动、关闭，受控页 adopt/release，分组成员、名称、颜色和折叠；缓存、视口、UA、设备模拟',
            inputSchema: manageSchema,
        },
        (args) => handleManage(args)
    )
}
