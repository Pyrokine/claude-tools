/**
 * evaluate 工具
 *
 * 在页面上下文执行 JavaScript
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { readFile } from 'fs/promises'
import { z } from 'zod'
import {
    CWD_PATH_PREFIX,
    formatErrorResponse,
    formatResponse,
    getUnifiedSession,
    resolveScopedInputPath,
    resolveScopedOutputPath,
    TMP_PATH_PREFIX,
    writePrivateFile,
} from '../core/index.js'
import type { InputMode } from '../core/unified-session.js'
import { appendDiagnostics, finishDiagnostics, startDiagnostics } from './diagnostics.js'
import { postConditionSchema, waitForPostCondition } from './post-condition.js'

/**
 * evaluate 参数 schema
 */
const evaluateSchema = z.object({
    script: z.string().optional().describe('JavaScript 代码（与 scriptFile 二选一）'),
    scriptFile: z
        .string()
        .optional()
        .describe(
            `从文件读取 JavaScript 代码（与 script 二选一），相对路径默认从 ${TMP_PATH_PREFIX} 解析，仓库内文件请显式写 ${CWD_PATH_PREFIX}`
        ),
    args: z
        .array(z.unknown())
        .optional()
        .describe('传递给脚本的参数，使用时 script 必须是函数表达式，如 "(x, y) => x + y"，参数通过 IIFE 调用传入'),
    output: z
        .string()
        .optional()
        .describe(
            `输出文件路径（可选），相对路径默认写入 ${TMP_PATH_PREFIX}，持久化到仓库请显式写 ${CWD_PATH_PREFIX}，字符串结果直接写原始文本，其他类型写 JSON`
        ),
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
    diagnostics: z.boolean().optional().describe('执行后返回新增 console error/warning 和失败网络请求摘要'),
    postCondition: postConditionSchema
        .optional()
        .describe('脚本执行后要验证的页面状态；不传时 success 只表示脚本已执行并返回，不表示业务结果已达成'),
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
type ToolResponse = {
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
}

function cspErrorResponse(): ToolResponse {
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

function formatEvaluateErrorResponse(error: unknown): ToolResponse {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return errorMessage.includes('CSP') ||
        errorMessage.includes('Content Security Policy') ||
        errorMessage.includes('unsafe-eval')
        ? cspErrorResponse()
        : formatErrorResponse(error)
}

export function resolveEvaluateMode(mode: InputMode | undefined): InputMode {
    return mode ?? 'precise'
}

export function classifyEvaluateActionError(error: unknown): {
    actionExecuted: boolean
    actionStatus: 'failed' | 'unknown'
    retryable: boolean
} {
    const message = error instanceof Error ? error.message : String(error)
    const preActionTimeout = /tim(?:eout|ed out) before/i.test(message)
    const timedOut = !preActionTimeout && /Request timeout|timed out|timeout|超时/i.test(message)
    const pageEvaluationStarted =
        /Evaluation failed|exception|ReferenceError|TypeError|SyntaxError|RangeError|URIError/i.test(message)
    return {
        actionExecuted: timedOut || pageEvaluationStarted,
        actionStatus: timedOut ? 'unknown' : 'failed',
        retryable: /timeout|timed out|超时|disconnect|未连接|context|debugger|attach/i.test(message),
    }
}

function appendEvaluateFailureMetadata(
    response: ToolResponse,
    error: unknown,
    verificationRequested: boolean,
    overrides: Record<string, unknown> = {}
): Record<string, unknown> | undefined {
    const text = response.content[0]?.text
    if (!text) return undefined
    try {
        const payload = JSON.parse(text) as Record<string, unknown>
        const status = classifyEvaluateActionError(error)
        Object.assign(payload, status, {
            verificationRequested,
            verificationStatus: 'unavailable',
            failureStage: 'action',
            ...overrides,
        })
        return payload
    } catch {
        return undefined
    }
}

async function handleEvaluate(args: z.infer<typeof evaluateSchema>): Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
}> {
    // 输入校验：在 try 外提前返回，避免 throw-catch-in-place
    let script = args.script
    let outputPath: string | undefined
    if (args.scriptFile) {
        try {
            const resolvedScriptFile = await resolveScopedInputPath(args.scriptFile, 'mcp-chrome')
            script = await readFile(resolvedScriptFile.absolutePath, 'utf-8')
        } catch (error) {
            return formatErrorResponse(error)
        }
    }
    if (args.output) {
        try {
            outputPath = (await resolveScopedOutputPath(args.output, 'mcp-chrome')).absolutePath
        } catch (error) {
            return formatErrorResponse(error)
        }
    }
    if (!script) {
        return formatErrorResponse(new Error('script 或 scriptFile 必须提供其一'))
    }

    try {
        const unifiedSession = getUnifiedSession()

        return await unifiedSession.withTabId(args.tabId, async () => {
            return await unifiedSession.withFrame(args.frame, async () => {
                const diagnostics = await startDiagnostics(unifiedSession, args.diagnostics)
                const evaluationMode = resolveEvaluateMode(args.mode)
                let result: unknown
                let evaluationMetadata: ReturnType<typeof unifiedSession.consumeLastEvaluationMetadata>
                try {
                    result = await unifiedSession.evaluate(script, evaluationMode, args.timeout, args.args as unknown[])
                    evaluationMetadata = unifiedSession.consumeLastEvaluationMetadata()
                } catch (error) {
                    evaluationMetadata = unifiedSession.consumeLastEvaluationMetadata()
                    const response = formatEvaluateErrorResponse(error)
                    const payload = appendEvaluateFailureMetadata(response, error, Boolean(args.postCondition), {
                        ...(evaluationMetadata ?? {}),
                    })
                    if (payload) {
                        appendDiagnostics(payload, await finishDiagnostics(unifiedSession, diagnostics))
                        response.content[0].text = JSON.stringify(payload, null, 2)
                    }
                    return response
                }

                const normalizedResult = result === undefined ? null : result
                const postCondition = args.postCondition
                    ? await waitForPostCondition(unifiedSession, args.postCondition, 'evaluate', evaluationMode)
                    : undefined
                const payload: Record<string, unknown> = {
                    success: postCondition ? postCondition.verificationStatus === 'matched' : true,
                    actionExecuted: true,
                    actionStatus: 'completed',
                    verificationRequested: Boolean(postCondition),
                    verificationStatus: postCondition?.verificationStatus ?? 'unavailable',
                    failureStage:
                        postCondition && postCondition.verificationStatus !== 'matched' ? 'verification' : undefined,
                    retryable: postCondition?.retryable ?? false,
                    ...(evaluationMetadata ?? {}),
                    ...(postCondition ? { postCondition } : {}),
                }

                try {
                    if (outputPath) {
                        const content = typeof result === 'string' ? result : JSON.stringify(normalizedResult, null, 2)
                        await writePrivateFile(outputPath, content, 'utf-8')
                        payload.output = outputPath
                    } else {
                        const serialized = JSON.stringify(normalizedResult, null, 2)
                        if (serialized.length > 100_000) {
                            const suffix = typeof result === 'string' ? 'txt' : 'json'
                            const autoSavedPath = (
                                await resolveScopedOutputPath(
                                    `${TMP_PATH_PREFIX}evaluate/auto-${Date.now()}.${suffix}`,
                                    'mcp-chrome'
                                )
                            ).absolutePath
                            const fileContent = typeof result === 'string' ? result : serialized
                            await writePrivateFile(autoSavedPath, fileContent, 'utf-8')
                            Object.assign(payload, {
                                autoSaved: true,
                                path: autoSavedPath,
                                size: fileContent.length,
                                hint: '结果过大已自动保存到受控临时目录，请使用 Read 工具读取',
                            })
                        } else {
                            payload.result = normalizedResult
                        }
                    }
                } catch (error) {
                    const response = formatEvaluateErrorResponse(error)
                    const failurePayload = appendEvaluateFailureMetadata(response, error, Boolean(postCondition), {
                        actionExecuted: true,
                        actionStatus: 'completed',
                        verificationStatus: postCondition?.verificationStatus ?? 'unavailable',
                        failureStage: 'output',
                        retryable: false,
                        ...(postCondition ? { postCondition } : {}),
                    })
                    if (failurePayload) {
                        appendDiagnostics(failurePayload, await finishDiagnostics(unifiedSession, diagnostics))
                        response.content[0].text = JSON.stringify(failurePayload, null, 2)
                    }
                    return response
                }
                appendDiagnostics(payload, await finishDiagnostics(unifiedSession, diagnostics))
                return formatResponse(payload)
            })
        }) // withTabId
    } catch (error) {
        const response = formatEvaluateErrorResponse(error)
        const payload = appendEvaluateFailureMetadata(response, error, Boolean(args.postCondition))
        if (payload) {
            payload.diagnosticsStatus = args.diagnostics ? 'unavailable' : 'disabled'
            if (args.diagnostics) {
                payload.diagnosticsError = 'diagnostics 未能在 tab/frame 初始化失败前启动'
            }
            response.content[0].text = JSON.stringify(payload, null, 2)
        }
        return response
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
