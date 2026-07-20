/**
 * logs 工具
 *
 * 浏览器日志：
 * - console: 控制台日志
 * - network: 网络请求日志
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { stat } from 'fs/promises'
import { z } from 'zod'
import {
    CWD_PATH_PREFIX,
    formatErrorResponse,
    formatResponse,
    getSession,
    getUnifiedSession,
    resolveScopedOutputPath,
    TMP_PATH_PREFIX,
    writePrivateFile,
} from '../core/index.js'
import { sanitizeUrlRecord, sanitizeUrlRecords } from './network-sanitizer.js'

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

const DEFAULT_LOG_LIMIT = 100
const INLINE_NETWORK_URL_MAX_LENGTH = 2048

type PublicConsoleLevel = 'error' | 'warning' | 'info' | 'debug'

export function normalizeConsoleLogLevel(level: string): PublicConsoleLevel {
    switch (level.toLowerCase()) {
        case 'error':
        case 'assert':
            return 'error'
        case 'warning':
        case 'warn':
            return 'warning'
        case 'debug':
        case 'trace':
            return 'debug'
        default:
            return 'info'
    }
}

export function normalizeConsoleLog<T extends { level: string }>(
    log: T
): Omit<T, 'level'> & { level: PublicConsoleLevel } {
    return { ...log, level: normalizeConsoleLogLevel(log.level) }
}

export function boundInlineNetworkRequest<T extends { url: string }>(
    request: T
): T & {
    urlRedacted?: true
    urlOriginalLength?: number
    redactedQueryParameters?: string[]
    urlLength?: number
    urlTruncated?: true
} {
    const sanitized = sanitizeUrlRecord(request)
    if (sanitized.url.length <= INLINE_NETWORK_URL_MAX_LENGTH) {
        return sanitized
    }
    return {
        ...sanitized,
        url: sanitized.url.slice(0, INLINE_NETWORK_URL_MAX_LENGTH),
        urlLength: request.url.length,
        urlTruncated: true,
    }
}

function latestItems<T>(items: T[], limit: number): T[] {
    return items.slice(-limit)
}

function sampleKind(hasOutput: boolean, hasExplicitLimit: boolean): 'all' | 'latest' {
    if (!hasOutput) {
        return 'latest'
    }
    return hasExplicitLimit ? 'latest' : 'all'
}

async function writeLogsOutput(
    output: string,
    type: 'console' | 'network',
    logs: unknown[],
    metadata: Record<string, unknown>
): Promise<{ output: string; manifest: string; bytes: number }> {
    const outputPath = (await resolveScopedOutputPath(output, 'mcp-chrome')).absolutePath
    await writePrivateFile(outputPath, JSON.stringify(logs, null, 2), 'utf-8')
    const manifestPath = outputPath.replace(/\.[^/\\.]+$/, '') + '_manifest.json'
    const bytes = (await stat(outputPath)).size
    await writePrivateFile(
        manifestPath,
        JSON.stringify(
            {
                schema: 'mcp-chrome.logs.v1',
                type,
                outputPath,
                bytes,
                lines: logs.length,
                complete: metadata.sample_kind === 'all',
                ...metadata,
            },
            null,
            2
        ),
        'utf-8'
    )
    return { output: outputPath, manifest: manifestPath, bytes }
}

/**
 * logs 工具处理器
 */
async function handleLogs(args: z.infer<typeof logsSchema>): Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
}> {
    try {
        const unifiedSession = getUnifiedSession()
        const responseLimit = args.limit ?? DEFAULT_LOG_LIMIT

        return await unifiedSession.withTabId(args.tabId, async () => {
            const mode = unifiedSession.getMode()
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
                        logs = await unifiedSession.getConsoleLogs({ clear: args.clear })
                    } else {
                        // CDP 模式
                        const session = getSession()
                        logs = await session.getConsoleLogs({ clear: args.clear })
                    }

                    logs = sanitizeUrlRecords(logs.map(normalizeConsoleLog))
                    if (args.level && args.level !== 'all') {
                        logs = logs.filter((log) => log.level === args.level)
                    }

                    const hasExplicitLimit = args.limit !== undefined
                    const selectedLogs = args.output && !hasExplicitLimit ? logs : latestItems(logs, responseLimit)
                    const kind = sampleKind(Boolean(args.output), hasExplicitLimit)
                    if (args.output) {
                        const written = await writeLogsOutput(args.output, 'console', selectedLogs, {
                            sample_kind: kind,
                            limit_applied: hasExplicitLimit ? responseLimit : null,
                            total_buffered: logs.length,
                            level: args.level ?? 'all',
                            mode,
                        })
                        return formatResponse({
                            success: true,
                            type: 'console',
                            output: written.output,
                            manifest: written.manifest,
                            count: selectedLogs.length,
                            totalBuffered: logs.length,
                            sample_kind: kind,
                            bytes: written.bytes,
                            mode,
                        })
                    }

                    return formatResponse({
                        success: true,
                        type: 'console',
                        logs: selectedLogs,
                        count: selectedLogs.length,
                        totalBuffered: logs.length,
                        sample_kind: kind,
                        limit: responseLimit,
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
                        requests = await unifiedSession.getNetworkRequests({
                            urlPattern: args.urlPattern,
                            clear: args.clear,
                        })
                    } else {
                        // CDP 模式
                        const session = getSession()
                        requests = await session.getNetworkRequests({
                            urlPattern: args.urlPattern,
                            clear: args.clear,
                        })
                    }

                    requests = sanitizeUrlRecords(requests)
                    const hasExplicitLimit = args.limit !== undefined
                    const selectedRequests =
                        args.output && !hasExplicitLimit ? requests : latestItems(requests, responseLimit)
                    const kind = sampleKind(Boolean(args.output), hasExplicitLimit)
                    if (args.output) {
                        const written = await writeLogsOutput(args.output, 'network', selectedRequests, {
                            sample_kind: kind,
                            limit_applied: hasExplicitLimit ? responseLimit : null,
                            total_buffered: requests.length,
                            urlPattern: args.urlPattern,
                            mode,
                        })
                        return formatResponse({
                            success: true,
                            type: 'network',
                            output: written.output,
                            manifest: written.manifest,
                            count: selectedRequests.length,
                            totalBuffered: requests.length,
                            sample_kind: kind,
                            bytes: written.bytes,
                            mode,
                        })
                    }

                    return formatResponse({
                        success: true,
                        type: 'network',
                        requests: selectedRequests.map(boundInlineNetworkRequest),
                        count: selectedRequests.length,
                        totalBuffered: requests.length,
                        sample_kind: kind,
                        limit: responseLimit,
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
