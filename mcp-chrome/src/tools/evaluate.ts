/**
 * evaluate 工具
 *
 * 在页面上下文执行 JavaScript
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { randomUUID } from 'crypto'
import { readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'
import { z } from 'zod'
import { formatErrorResponse, formatResponse, getUnifiedSession } from '../core/index.js'

/**
 * evaluate 参数 schema
 */
const evaluateSchema = z.object({
    script: z.string().optional().describe('JavaScript 代码（与 scriptFile 二选一）'),
    scriptFile: z
        .string()
        .optional()
        .describe('从文件读取 JavaScript 代码（与 script 二选一），指定后忽略 script 参数，路径限制在当前工作目录内'),
    args: z
        .array(z.unknown())
        .optional()
        .describe('传递给脚本的参数，使用时 script 必须是函数表达式，如 "(x, y) => x + y"，参数通过 IIFE 调用传入'),
    output: z
        .string()
        .optional()
        .describe('输出文件路径（可选），若指定字符串结果直接写入原始文本，其他类型序列化为 JSON'),
    timeout: z
        .number()
        .optional()
        .describe('超时（毫秒），Extension 模式作为端到端预算（含传输），CDP 模式作为脚本执行超时'),
    mode: z
        .enum(['stealth', 'precise'])
        .optional()
        .describe(
            '执行模式，precise（默认）使用 debugger API，可绕过 CSP；stealth 使用 JS 注入，不触发调试提示但受 CSP 限制'
        ),
    tabId: z
        .string()
        .optional()
        .describe(
            '目标 Tab ID（可选，仅 Extension 模式），不指定则使用当前 attach 的 tab，可操作非当前 attach 的 tab，CDP 模式下不支持此参数'
        ),
    frame: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
            'iframe 定位（可选，仅 Extension 模式），CSS 选择器（如 "iframe#main"）或索引（如 0），不指定则在主框架执行'
        ),
})

/**
 * evaluate 工具处理器
 */
async function handleEvaluate(args: z.infer<typeof evaluateSchema>): Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
}> {
    // 输入校验：在 try 外提前返回，避免 throw-catch-in-place
    let script = args.script
    const cwd = process.cwd()
    if (args.scriptFile) {
        const safePath = resolve(cwd, args.scriptFile)
        // 用尾部分隔符确保是路径边界，防止前缀同名目录绕过（如 ../cwd-evil/x.js）
        if (!safePath.startsWith(cwd + sep) && safePath !== cwd) {
            return formatErrorResponse(new Error(`scriptFile 路径超出工作目录范围: ${args.scriptFile}`))
        }
        try {
            script = await readFile(safePath, 'utf-8')
        } catch (error) {
            return formatErrorResponse(error)
        }
    }
    if (args.output) {
        const safeOutput = resolve(cwd, args.output)
        if (!safeOutput.startsWith(cwd + sep) && safeOutput !== cwd) {
            return formatErrorResponse(new Error(`output 路径超出工作目录范围: ${args.output}`))
        }
    }
    if (!script) {
        return formatErrorResponse(new Error('script 或 scriptFile 必须提供其一'))
    }

    try {
        const unifiedSession = getUnifiedSession()

        return await unifiedSession.withTabId(args.tabId, async () => {
            return await unifiedSession.withFrame(args.frame, async () => {
                const result = await unifiedSession.evaluate(script, args.mode, args.timeout, args.args as unknown[])
                const normalizedResult = result === undefined ? null : result

                if (args.output) {
                    const safeOutput = resolve(cwd, args.output)
                    // string 类型直接写入原始文本，其他类型 JSON 序列化
                    const content = typeof result === 'string' ? result : JSON.stringify(normalizedResult, null, 2)
                    await writeFile(safeOutput, content, 'utf-8')
                    return formatResponse({
                        success: true,
                        output: safeOutput,
                    })
                }

                const serialized = JSON.stringify({ success: true, result: normalizedResult }, null, 2)
                // 检测结果大小，超过 100KB 自动保存到文件
                if (serialized.length > 100_000) {
                    const suffix = typeof result === 'string' ? 'txt' : 'json'
                    const tmpPath = join(tmpdir(), `mcp-chrome-eval-${randomUUID()}.${suffix}`)
                    const fileContent = typeof result === 'string' ? result : JSON.stringify(normalizedResult, null, 2)
                    await writeFile(tmpPath, fileContent, 'utf-8')
                    return formatResponse({
                        success: true,
                        autoSaved: true,
                        path: tmpPath,
                        size: fileContent.length,
                        hint: '结果过大已自动保存到文件，请使用 Read 工具读取',
                    })
                }

                return formatResponse({ success: true, result: normalizedResult })
            })
        }) // withTabId
    } catch (error) {
        // 检测 CSP 错误，提示使用 precise 模式
        const errorMessage = error instanceof Error ? error.message : String(error)
        if (
            errorMessage.includes('CSP') ||
            errorMessage.includes('Content Security Policy') ||
            errorMessage.includes('unsafe-eval')
        ) {
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            error: {
                                code: 'CSP_BLOCKED',
                                message: 'CSP 限制：此页面禁止动态代码执行',
                                suggestion: '请添加 mode="precise" 参数使用 debugger API 绕过 CSP（会显示调试提示）',
                            },
                        }),
                    },
                ],
                isError: true,
            }
        }
        return formatErrorResponse(error)
    }
}

/**
 * 注册 evaluate 工具
 */
export function registerEvaluateTool(server: McpServer): void {
    server.registerTool(
        'evaluate',
        {
            description: '在页面上下文执行 JavaScript',
            inputSchema: evaluateSchema,
        },
        (args) => handleEvaluate(args)
    )
}
