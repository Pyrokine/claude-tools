/**
 * logs 工具
 *
 * 浏览器日志：
 * - console: 控制台日志
 * - network: 网络请求日志
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { writeFile } from 'fs/promises'
import { z } from 'zod'
import {
    CWD_PATH_PREFIX,
    ensureParentDir,
    formatErrorResponse,
    formatResponse,
    getSession,
    getUnifiedSession,
    resolveScopedOutputPath,
    TMP_PATH_PREFIX,
} from '../core/index.js'

/**
 * logs 参数 schema
 */
const logsSchema = z.object({
    type: z.enum(['console', 'network']).describe('日志类型'),
    level: z.enum(['all', 'error', 'warning', 'info', 'debug']).optional().describe('日志级别过滤（console）'),
    urlPattern: z.string().optional().describe('URL 模式过滤（network），支持通配符'),
    limit: z.number().optional().describe('最大返回条数'),
    clear: z.boolean().optional().describe('获取后清除日志'),
    output: z
        .string()
        .optional()
        .describe(`输出文件路径，相对路径默认写入 ${TMP_PATH_PREFIX}，持久化到仓库请显式写 ${CWD_PATH_PREFIX}`),
    tabId: z
        .string()
        .optional()
        .describe(
            '目标 Tab ID（可选，仅 Extension 模式），不指定则使用当前 attach 的 tab，可操作非当前 attach 的 tab，CDP 模式下不支持此参数'
        ),
})

/**
 * logs 工具处理器
 */
async function handleLogs(args: z.infer<typeof logsSchema>): Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
}> {
    try {
        const unifiedSession = getUnifiedSession()
        const mode = unifiedSession.getMode()
        const limit = args.limit ?? 100

        return await unifiedSession.withTabId(args.tabId, async () => {
            switch (args.type) {
                case 'console': {
                    let logs: Array<{
                        source?: string
                        level: string
                        text: string
                        timestamp?: number
                        url?: string
                        lineNumber?: number
                    }>

                    if (mode === 'extension') {
                        // Extension 模式：使用 debugger API 获取控制台日志
                        await unifiedSession.enableConsole()
                        const extLogs = await unifiedSession.getConsoleLogs({
                            level: args.level === 'all' ? undefined : args.level,
                            clear: args.clear,
                        })
                        logs = extLogs.slice(0, limit)
                    } else {
                        // CDP 模式
                        const session = getSession()
                        const allLogs = await session.getConsoleLogs({
                            level: args.level === 'all' ? undefined : args.level,
                            clear: args.clear,
                        })
                        logs = allLogs.slice(-limit)
                    }

                    if (args.output) {
                        const outputPath = (await resolveScopedOutputPath(args.output, 'mcp-chrome')).absolutePath
                        await ensureParentDir(outputPath)
                        await writeFile(outputPath, JSON.stringify(logs, null, 2), 'utf-8')
                        return formatResponse({
                            success: true,
                            type: 'console',
                            output: outputPath,
                            count: logs.length,
                            mode,
                        })
                    }

                    return formatResponse({
                        success: true,
                        type: 'console',
                        logs,
                        mode,
                    })
                }

                case 'network': {
                    let requests: Array<{
                        url: string
                        method: string
                        status?: number
                        type: string
                        timestamp: number
                        duration?: number
                    }>

                    if (mode === 'extension') {
                        // Extension 模式：使用 debugger API 获取网络日志
                        await unifiedSession.enableNetwork()
                        const extRequests = await unifiedSession.getNetworkRequests({
                            urlPattern: args.urlPattern,
                            clear: args.clear,
                        })
                        requests = extRequests.slice(0, limit)
                    } else {
                        // CDP 模式
                        const session = getSession()
                        const allRequests = await session.getNetworkRequests({
                            urlPattern: args.urlPattern,
                            clear: args.clear,
                        })
                        requests = allRequests.slice(-limit)
                    }

                    if (args.output) {
                        const outputPath = (await resolveScopedOutputPath(args.output, 'mcp-chrome')).absolutePath
                        await ensureParentDir(outputPath)
                        await writeFile(outputPath, JSON.stringify(requests, null, 2), 'utf-8')
                        return formatResponse({
                            success: true,
                            type: 'network',
                            output: outputPath,
                            count: requests.length,
                            mode,
                        })
                    }

                    return formatResponse({
                        success: true,
                        type: 'network',
                        requests,
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
                                        message: `未知日志类型: ${args.type}`,
                                    },
                                }),
                            },
                        ],
                        isError: true,
                    }
            }
        }) // withTabId
    } catch (error) {
        return formatErrorResponse(error)
    }
}

/**
 * 注册 logs 工具
 */
export function registerLogsTool(server: McpServer): void {
    server.registerTool(
        'logs',
        {
            description: '浏览器日志：控制台日志、网络请求',
            inputSchema: logsSchema,
        },
        (args) => handleLogs(args)
    )
}
