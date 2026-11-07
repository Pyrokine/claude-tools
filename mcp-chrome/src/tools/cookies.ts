/**
 * cookies 工具
 *
 * Cookie 管理：
 * - get: 获取 cookies（支持多种过滤条件）
 * - set: 设置 cookie
 * - delete: 删除指定 cookie
 * - clear: 清空 cookies（支持按域名过滤）
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
    CWD_PATH_PREFIX,
    formatErrorResponse,
    formatResponse,
    getUnifiedSession,
    resolveScopedOutputPath,
    TMP_PATH_PREFIX,
    StructuredToolError,
    writePrivateFile,
} from '../core/index.js'
import { TEMP_OUTPUT_RETENTION } from '../core/utils.js'
import type { CookieFilter, CookieScope } from '../core/browser-driver.js'

/**
 * cookies 参数 schema
 */
const cookiesSchema = z.object({
    action: z.enum(['get', 'set', 'delete', 'clear']).describe('操作类型'),
    targetId: z.string().min(1).optional().describe('显式页面对应的 Cookie 存储上下文'),
    storeId: z.string().min(1).optional().describe('Extension CookieStore ID；与 targetId 同时提供时必须一致'),
    browserContextId: z.string().min(1).optional().describe('CDP BrowserContext ID'),
    partitionKey: z
        .object({
            topLevelSite: z.string().min(1).optional(),
            hasCrossSiteAncestor: z.boolean().optional(),
        })
        .optional()
        .describe('Cookie 分区；保留未分区 Cookie 的既有默认行为'),
    url: z.string().optional().describe('URL 过滤（get/clear/set/delete）'),
    name: z
        .string()
        .optional()
        .describe('Cookie 名称（get 至少带 name/domain/url 之一，set/delete 必填；clear 仅缩小 url/domain 范围）'),
    domain: z.string().optional().describe('域名过滤（get/clear）'),
    path: z.string().optional().describe('路径过滤（get）或设置路径（set）'),
    secure: z.boolean().optional().describe('只返回 secure cookies（get）或设置 secure 属性（set）'),
    session: z.boolean().optional().describe('只返回会话 cookies（get）'),
    value: z.string().optional().describe('Cookie 值（set）'),
    httpOnly: z.boolean().optional().describe('httpOnly 属性（set）'),
    sameSite: z.enum(['Strict', 'Lax', 'None']).optional().describe('SameSite 属性（set）'),
    expirationDate: z.number().optional().describe('过期时间戳（set）'),
    output: z
        .string()
        .optional()
        .describe(`输出文件路径（get），相对路径默认写入 ${TMP_PATH_PREFIX}，持久化到仓库请显式写 ${CWD_PATH_PREFIX}`),
})

/**
 * cookies 工具处理器
 */
async function handleCookies(args: z.infer<typeof cookiesSchema>): Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
}> {
    try {
        const unifiedSession = getUnifiedSession()
        const scope: CookieScope = {
            targetId: args.targetId,
            storeId: args.storeId,
            partitionKey: args.partitionKey,
            browserContextId: args.browserContextId,
        }

        switch (args.action) {
            case 'get': {
                if (
                    ![args.name, args.domain, args.url].some((value) => value !== undefined && value.trim().length > 0)
                ) {
                    throw new StructuredToolError(
                        'INVALID_ARGUMENT',
                        'cookies action=get 必须带非空 name、domain 或 url 过滤参数',
                        '用 name、domain 或 url 指定读取范围，targetId 和其他条件仅用于选择存储上下文或进一步过滤',
                        { actionExecuted: false, actionStatus: 'not_started', retryable: false }
                    )
                }
                // 构建过滤条件
                const filter: CookieFilter = { ...scope }
                if (args.url) {
                    filter.url = args.url
                }
                if (args.name) {
                    filter.name = args.name
                }
                if (args.domain) {
                    filter.domain = args.domain
                }
                if (args.path) {
                    filter.path = args.path
                }
                if (args.secure !== undefined) {
                    filter.secure = args.secure
                }
                if (args.session !== undefined) {
                    filter.session = args.session
                }

                const cookies = (await unifiedSession.getCookies(filter)) as Array<{
                    name: string
                    value: string
                    domain?: string
                    path?: string
                    secure?: boolean
                    httpOnly?: boolean
                    sameSite?: string
                    expirationDate?: number
                    session?: boolean
                }>

                if (args.output) {
                    const output = await resolveScopedOutputPath(args.output, 'mcp-chrome')
                    unifiedSession.assertRequestActive()
                    await writePrivateFile(output.absolutePath, JSON.stringify(cookies, null, 2), 'utf-8', () =>
                        unifiedSession.assertRequestActive()
                    )
                    return formatResponse({
                        success: true,
                        action: 'get',
                        output: output.absolutePath,
                        count: cookies.length,
                        ...(output.scope === 'tmp' ? { retention: TEMP_OUTPUT_RETENTION } : {}),
                    })
                }

                return formatResponse({
                    success: true,
                    action: 'get',
                    count: cookies.length,
                    cookies,
                })
            }

            case 'set': {
                if (!args.url) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: {
                                        code: 'INVALID_ARGUMENT',
                                        message: '设置 cookie 需要 url 参数',
                                    },
                                }),
                            },
                        ],
                        isError: true,
                    }
                }
                if (!args.name) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: {
                                        code: 'INVALID_ARGUMENT',
                                        message: '设置 cookie 需要 name 参数',
                                    },
                                }),
                            },
                        ],
                        isError: true,
                    }
                }
                if (args.value === undefined) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: {
                                        code: 'INVALID_ARGUMENT',
                                        message: '设置 cookie 需要 value 参数',
                                    },
                                }),
                            },
                        ],
                        isError: true,
                    }
                }

                await unifiedSession.setCookie({
                    ...scope,
                    name: args.name,
                    value: args.value,
                    url: args.url,
                    domain: args.domain,
                    path: args.path,
                    secure: args.secure,
                    httpOnly: args.httpOnly,
                    sameSite: args.sameSite,
                    expirationDate: args.expirationDate,
                })

                return formatResponse({
                    success: true,
                    action: 'set',
                    url: args.url,
                    name: args.name,
                })
            }

            case 'delete': {
                if (!args.url) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: {
                                        code: 'INVALID_ARGUMENT',
                                        message: '删除 cookie 需要 url 参数',
                                    },
                                }),
                            },
                        ],
                        isError: true,
                    }
                }
                if (!args.name) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: {
                                        code: 'INVALID_ARGUMENT',
                                        message: '删除 cookie 需要 name 参数',
                                    },
                                }),
                            },
                        ],
                        isError: true,
                    }
                }

                await unifiedSession.deleteCookie(args.url, args.name, scope)

                return formatResponse({
                    success: true,
                    action: 'delete',
                    url: args.url,
                    name: args.name,
                })
            }

            case 'clear': {
                // clear 必须限定到站点或域名，单独 name 会跨站删除同名 cookie
                if (!args.url && !args.domain) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: {
                                        code: 'INVALID_ARGUMENT',
                                        message:
                                            'cookies action=clear 必须带 url 或 domain 过滤参数；' +
                                            'name 只能在该范围内进一步过滤，避免误删其他站点的同名 cookie',
                                    },
                                }),
                            },
                        ],
                        isError: true,
                    }
                }

                // 构建过滤条件
                const filter: CookieFilter = { ...scope }
                if (args.url) {
                    filter.url = args.url
                }
                if (args.domain) {
                    filter.domain = args.domain
                }
                if (args.name) {
                    filter.name = args.name
                }

                const result = await unifiedSession.clearCookies(filter)

                return formatResponse({
                    success: true,
                    action: 'clear',
                    filter,
                    ...result,
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
 * 注册 cookies 工具
 */
export function registerCookiesTool(server: McpServer): void {
    server.registerTool(
        'cookies',
        {
            description: 'Cookie 管理：获取、设置、删除、清空',
            inputSchema: cookiesSchema,
        },
        (args, extra) =>
            getUnifiedSession()
                .withTabLock(() => handleCookies(args), undefined, extra?.signal)
                .catch((error: unknown) =>
                    formatErrorResponse(
                        extra?.signal?.aborted
                            ? new StructuredToolError(
                                  'CANCELLED',
                                  'Cookie 请求在开始前已取消',
                                  '读取实际 Cookie 状态后再提交操作',
                                  { actionExecuted: false, actionStatus: 'not_started', retryable: false }
                              )
                            : error
                    )
                )
    )
}
