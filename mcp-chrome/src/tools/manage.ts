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

/**
 * manage 参数 schema
 */
const manageSchema = z.object({
    action: z
        .enum(['newPage', 'closePage', 'clearCache', 'viewport', 'userAgent', 'emulate', 'inputMode', 'stealth', 'cdp'])
        .describe('管理操作'),
    inputMode: z
        .enum(['stealth', 'precise'])
        .optional()
        .describe(
            '输入模式（inputMode），precise=debugger API（默认，可绕过 CSP 但显示调试提示）；stealth=JS 事件模拟（不触发调试提示但受 CSP 限制，适用于反检测场景）'
        ),
    cdpMethod: z.string().optional().describe('CDP 方法名（cdp），如 Runtime.evaluate、Page.captureScreenshot'),
    cdpParams: z.record(z.unknown()).optional().describe('CDP 方法参数（cdp）'),
    targetId: z.string().optional().describe('目标页面 ID（closePage）'),
    cacheType: z
        .enum(['all', 'storage', 'cache'])
        .optional()
        .describe('清除类型（clearCache）；不再支持 cookies，请使用 cookies action=clear（强制 name/domain/url 过滤）'),
    width: z.number().optional().describe('视口宽度（viewport）'),
    height: z.number().optional().describe('视口高度（viewport）'),
    userAgent: z.string().optional().describe('User-Agent 字符串（userAgent）'),
    device: z.string().optional().describe('设备名称（emulate），如 iPhone 13, iPad Pro'),
})

/**
 * manage 工具处理器
 */
async function handleManage(args: z.infer<typeof manageSchema>): Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
}> {
    try {
        const unifiedSession = getUnifiedSession()
        const mode = unifiedSession.getMode()

        switch (args.action) {
            case 'newPage': {
                const target = await unifiedSession.newPage()
                return formatResponse({
                    success: true,
                    action: 'newPage',
                    target,
                    mode,
                })
            }

            case 'closePage': {
                await unifiedSession.closePage(args.targetId)
                return formatResponse({
                    success: true,
                    action: 'closePage',
                    targetId: args.targetId ?? 'current',
                    mode,
                })
            }

            case 'clearCache': {
                return await unifiedSession.withTabId(undefined, async () => {
                    const cacheType = (args.cacheType ?? 'all') as CacheType

                    if (mode === 'extension') {
                        // Extension 模式不支持清 storage/cache（需要 CDP）；cookies 清除统一走 cookies 工具（强制过滤）
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

                    return formatResponse({
                        success: true,
                        action: 'clearCache',
                        cacheType,
                        mode,
                    })
                })
            }

            case 'viewport': {
                return await unifiedSession.withTabId(undefined, async () => {
                    if (args.width === undefined || args.height === undefined) {
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        error: {
                                            code: 'INVALID_ARGUMENT',
                                            message: '设置视口需要 width 和 height 参数',
                                        },
                                    }),
                                },
                            ],
                            isError: true,
                        }
                    }

                    if (mode === 'extension') {
                        // Extension 模式：使用 debugger API 设置视口
                        await unifiedSession.sendCdpCommand('Emulation.setDeviceMetricsOverride', {
                            width: args.width,
                            height: args.height,
                            deviceScaleFactor: 1,
                            mobile: false,
                        })
                    } else {
                        const session = getSession()
                        await session.setViewport(args.width, args.height)
                    }
                    // 触发 resize 事件（Emulation API 不会自动触发）
                    await unifiedSession.evaluate('window.dispatchEvent(new Event("resize"))')

                    return formatResponse({
                        success: true,
                        action: 'viewport',
                        width: args.width,
                        height: args.height,
                        mode,
                    })
                })
            }

            case 'userAgent': {
                return await unifiedSession.withTabId(undefined, async () => {
                    if (!args.userAgent) {
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        error: {
                                            code: 'INVALID_ARGUMENT',
                                            message: '设置 User-Agent 需要 userAgent 参数',
                                        },
                                    }),
                                },
                            ],
                            isError: true,
                        }
                    }

                    if (mode === 'extension') {
                        // Extension 模式：使用 debugger API 设置 UA
                        await unifiedSession.sendCdpCommand('Emulation.setUserAgentOverride', {
                            userAgent: args.userAgent,
                        })
                    } else {
                        const session = getSession()
                        await session.setUserAgent(args.userAgent)
                    }

                    return formatResponse({
                        success: true,
                        action: 'userAgent',
                        userAgent: args.userAgent,
                        mode,
                    })
                })
            }

            case 'inputMode': {
                if (!args.inputMode) {
                    // 返回当前模式
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
                return formatResponse({
                    success: true,
                    action: 'inputMode',
                    inputMode: args.inputMode,
                    mode,
                })
            }

            case 'emulate': {
                return await unifiedSession.withTabId(undefined, async () => {
                    if (!args.device) {
                        // 列出可用设备
                        return formatResponse({
                            success: true,
                            action: 'emulate',
                            availableDevices: Object.keys(devices),
                        })
                    }

                    const device = devices[args.device]
                    if (!device) {
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        error: {
                                            code: 'INVALID_ARGUMENT',
                                            message: `未知设备: ${args.device}`,
                                            suggestion: `可用设备: ${Object.keys(devices).join(', ')}`,
                                        },
                                    }),
                                },
                            ],
                            isError: true,
                        }
                    }

                    if (mode === 'extension') {
                        // Extension 模式：使用 debugger API
                        await unifiedSession.sendCdpCommand('Emulation.setDeviceMetricsOverride', {
                            width: device.viewport.width,
                            height: device.viewport.height,
                            deviceScaleFactor: device.viewport.deviceScaleFactor || 1,
                            mobile: device.viewport.isMobile || false,
                        })
                        await unifiedSession.sendCdpCommand('Emulation.setUserAgentOverride', {
                            userAgent: device.userAgent,
                        })
                    } else {
                        const session = getSession()
                        await session.setViewport(device.viewport.width, device.viewport.height)
                        await session.setUserAgent(device.userAgent)
                    }
                    // 触发 resize 事件（Emulation API 不会自动触发）
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

            case 'stealth': {
                return await unifiedSession.withTabId(undefined, async () => {
                    await unifiedSession.injectStealth()
                    return formatResponse({
                        success: true,
                        action: 'stealth',
                        mode,
                        note: '已注入反检测脚本',
                    })
                })
            }

            case 'cdp': {
                return await unifiedSession.withTabId(undefined, async () => {
                    if (!args.cdpMethod) {
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        error: {
                                            code: 'INVALID_ARGUMENT',
                                            message: '缺少 cdpMethod 参数',
                                            suggestion:
                                                '请指定 CDP 方法名，如 Runtime.evaluate、Page.captureScreenshot',
                                        },
                                    }),
                                },
                            ],
                            isError: true,
                        }
                    }

                    try {
                        const result = await unifiedSession.sendCdpCommand(args.cdpMethod, args.cdpParams)
                        return formatResponse({
                            success: true,
                            action: 'cdp',
                            method: args.cdpMethod,
                            result,
                            mode,
                        })
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error)
                        // Extension 模式下某些 CDP 域不支持
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
 * 注册 manage 工具
 */
export function registerManageTool(server: McpServer): void {
    server.registerTool(
        'manage',
        {
            description: '页面与环境管理：新建页面、关闭页面、缓存、视口、UA、设备模拟',
            inputSchema: manageSchema,
        },
        (args) => handleManage(args)
    )
}
