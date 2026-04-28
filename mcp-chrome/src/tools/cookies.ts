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
import { writeFile } from 'fs/promises'
import { resolve, sep } from 'path'
import { z } from 'zod'
import { formatErrorResponse, formatResponse, getUnifiedSession } from '../core/index.js'

/**
 * cookies 参数 schema
 */
const cookiesSchema = z.object({
    action: z.enum(['get', 'set', 'delete', 'clear']).describe('操作类型'),
    url: z.string().optional().describe('URL 过滤（get/clear/set/delete）'),
    name: z.string().optional().describe('Cookie 名称（get/set/delete 必填；clear 可作过滤）'),
    domain: z.string().optional().describe('域名过滤（get/clear）'),
    path: z.string().optional().describe('路径过滤（get）或设置路径（set）'),
    secure: z.boolean().optional().describe('只返回 secure cookies（get）或设置 secure 属性（set）'),
    session: z.boolean().optional().describe('只返回会话 cookies（get）'),
    value: z.string().optional().describe('Cookie 值（set）'),
    httpOnly: z.boolean().optional().describe('httpOnly 属性（set）'),
    sameSite: z.enum(['Strict', 'Lax', 'None']).optional().describe('SameSite 属性（set）'),
    expirationDate: z.number().optional().describe('过期时间戳（set）'),
    output: z.string().optional().describe('输出文件路径（get），若指定 cookies 导出为 JSON 文件'),
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

        switch (args.action) {
            case 'get': {
                // 构建过滤条件
                const filter: {
                    url?: string
                    name?: string
                    domain?: string
                    path?: string
                    secure?: boolean
                    session?: boolean
                } = {}
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
                    const cwd = process.cwd()
                    const safeOutput = resolve(cwd, args.output)
                    if (!safeOutput.startsWith(cwd + sep) && safeOutput !== cwd) {
                        return formatErrorResponse(new Error(`output 路径超出工作目录范围: ${args.output}`))
                    }
                    await writeFile(safeOutput, JSON.stringify(cookies, null, 2), 'utf-8')
                    return formatResponse({
                        success: true,
                        action: 'get',
                        output: safeOutput,
                        count: cookies.length,
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

                await unifiedSession.deleteCookie(args.url, args.name)

                return formatResponse({
                    success: true,
                    action: 'delete',
                    url: args.url,
                    name: args.name,
                })
            }

            case 'clear': {
                // 强制过滤：禁止无参数清全站（避免误删用户登录态）
                if (!args.url && !args.domain && !args.name) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: {
                                        code: 'INVALID_ARGUMENT',
                                        message:
                                            'cookies action=clear 必须带 name/domain/url 至少一个过滤参数（避免误删用户登录态）',
                                    },
                                }),
                            },
                        ],
                        isError: true,
                    }
                }

                // 构建过滤条件
                const filter: { url?: string; domain?: string; name?: string } = {}
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
                    count: result.count,
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
        (args) => handleCookies(args)
    )
}
