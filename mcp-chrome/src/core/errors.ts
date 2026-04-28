/**
 * mcp-chrome 错误类型定义
 *
 * 设计原则：
 * - 每个错误都有明确的 code（便于程序处理）
 * - 每个错误都有 suggestion（便于用户理解如何修复）
 * - 每个错误都有 context（便于调试）
 * - 参考《代码整洁之道》§7.4：给出异常发生的环境说明
 */

import type { Target } from './types.js'

/**
 * 错误上下文
 */
export interface ErrorContext {
    [key: string]: unknown
}

/**
 * 浏览器错误基类
 */
export abstract class BrowserError extends Error {
    abstract readonly code: string
    abstract readonly suggestion: string
    readonly context: ErrorContext = {}

    protected constructor(message: string) {
        super(message)
        this.name = this.constructor.name
    }

    /**
     * 转换为 JSON 格式，用于 MCP 响应
     */
    // noinspection JSUnusedGlobalSymbols — 被 formatErrorResponse 动态调用
    toJSON(): object {
        const result: {
            error: {
                code: string
                message: string
                suggestion: string
                context?: ErrorContext
            }
        } = {
            error: {
                code: this.code,
                message: this.message,
                suggestion: this.suggestion,
            },
        }

        if (Object.keys(this.context).length > 0) {
            result.error.context = this.context
        }

        return result
    }
}

/**
 * 连接被拒绝错误
 */
export class ConnectionRefusedError extends BrowserError {
    readonly code = 'CONNECTION_REFUSED'
    readonly suggestion: string
    override readonly context: ErrorContext

    constructor(host: string, port: number) {
        super(`无法连接到 ${host}:${port}`)
        this.suggestion = `请确保浏览器已启动并开放了调试端口：
  google-chrome --remote-debugging-port=${port}

或者使用 browse(action="launch") 让 mcp-chrome 自动启动浏览器`
        this.context = { host, port }
    }
}

/**
 * 浏览器未找到错误
 */
export class BrowserNotFoundError extends BrowserError {
    readonly code = 'BROWSER_NOT_FOUND'
    readonly suggestion = `未找到 Chrome 浏览器，请指定 executablePath 参数：
  browse(action="launch", executablePath="/path/to/chrome")`

    constructor() {
        super('未找到 Chrome 浏览器')
    }
}

/**
 * 会话不存在错误
 */
export class SessionNotFoundError extends BrowserError {
    readonly code = 'SESSION_NOT_FOUND'
    readonly suggestion = '请先使用 browse(action="launch") 或 browse(action="connect") 连接浏览器'

    constructor() {
        super('浏览器会话不存在')
    }
}

/**
 * 页面/Target 不存在错误
 */
export class TargetNotFoundError extends BrowserError {
    readonly code = 'TARGET_NOT_FOUND'
    readonly suggestion = '请使用 browse(action="list") 查看可用页面'
    override readonly context: ErrorContext

    constructor(targetId: string) {
        super(`页面不存在: ${targetId}`)
        this.context = { targetId }
    }
}

/**
 * 元素未找到错误
 */
export class ElementNotFoundError extends BrowserError {
    readonly code = 'ELEMENT_NOT_FOUND'
    readonly suggestion: string
    readonly logs: string[]
    override readonly context: ErrorContext

    constructor(target: Target, timeout: number, logs: string[] = [], url?: string) {
        super(`元素未找到: ${JSON.stringify(target)}`)
        this.suggestion = `请检查 target 是否正确，或增加 timeout（当前: ${timeout}ms）`
        this.logs = logs
        this.context = { target, timeout }
        if (url) {
            this.context.url = url
        }
    }

    override toJSON(): object {
        // 日志去重并限制输出数量，避免重复日志刷屏
        const uniqueLogs = [...new Set(this.logs)]
        const maxLogs = 10
        const logsOutput =
            uniqueLogs.length > maxLogs
                ? [...uniqueLogs.slice(0, maxLogs), `... 共 ${uniqueLogs.length} 条（已省略）`]
                : uniqueLogs

        return {
            error: {
                code: this.code,
                message: this.message,
                suggestion: this.suggestion,
                context: this.context,
                logs: logsOutput,
            },
        }
    }
}

/**
 * 导航超时错误
 */
export class NavigationTimeoutError extends BrowserError {
    readonly code = 'NAVIGATION_TIMEOUT'
    readonly suggestion = '请检查网络连接，或增加超时时间'
    override readonly context: ErrorContext

    constructor(url: string, timeout: number) {
        super(`导航超时: ${url} (${timeout}ms)`)
        this.context = { url, timeout }
    }
}

/**
 * 导航网络错误（DNS 解析失败、连接拒绝等）
 */
export class NavigationError extends BrowserError {
    readonly code = 'NAVIGATION_ERROR'
    readonly suggestion = '请检查 URL 是否正确，以及网络连接是否正常'
    override readonly context: ErrorContext

    constructor(url: string, errorText: string) {
        super(`导航失败: ${url} (${errorText})`)
        this.context = { url, errorText }
    }
}

/**
 * 操作超时错误
 */
export class TimeoutError extends BrowserError {
    readonly code = 'TIMEOUT'
    readonly suggestion = '请增加超时时间，或检查操作条件是否能满足'

    constructor(message: string) {
        super(message)
    }
}

/**
 * CDP 协议错误
 */
export class CDPError extends BrowserError {
    readonly code = 'CDP_ERROR'
    readonly suggestion = '这是一个 CDP 协议错误，请检查操作是否正确'

    constructor(message: string) {
        super(message)
    }
}

/**
 * ZodError issue 类型
 */
interface ZodIssue {
    path: (string | number)[]
    message: string
    code?: string
}

/**
 * ZodError 类型检测
 */
function isZodError(error: unknown): error is Error & { issues: ZodIssue[] } {
    return (
        error !== null &&
        typeof error === 'object' &&
        'name' in error &&
        (error as Error).name === 'ZodError' &&
        'issues' in error &&
        Array.isArray((error as { issues: unknown }).issues)
    )
}

/**
 * 检测错误是否可能由 tab 不在前台导致
 */
function detectVisibilityHint(errorMessage: string): string | null {
    const msg = errorMessage.toLowerCase()
    const keywords = [
        'hidden',
        'visible',
        'visibility',
        'focus',
        'blur',
        'active tab',
        'not active',
        'capturevisibletab',
    ]
    if (keywords.some((kw) => msg.includes(kw))) {
        return '此操作可能需要 tab 在前台，请使用 browse(action="attach", targetId="<id>", activate=true) 激活目标 tab'
    }
    return null
}

/**
 * 格式化错误为 MCP 工具响应
 * 特别处理 ZodError，转换为结构化的 INVALID_ARGUMENT 错误
 * 自动检测 visibility 相关错误并添加 hint
 */
export function formatErrorResponse(error: unknown): {
    content: Array<{ type: 'text'; text: string }>
    isError: boolean
} {
    // 处理 ZodError
    if (isZodError(error)) {
        const fieldErrors = error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
        }))
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(
                        {
                            error: {
                                code: 'INVALID_ARGUMENT',
                                message: '参数验证失败',
                                fields: fieldErrors,
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

    // 处理 BrowserError（带 toJSON 方法）
    const err = error as Error & { toJSON?: () => object }
    const errorJson = err.toJSON?.() ?? {
        error: {
            code: 'UNKNOWN_ERROR',
            message: err.message ?? String(error),
        },
    }

    // 检测 visibility 相关错误，添加 hint
    const errorMessage = err.message ?? String(error)
    const hint = detectVisibilityHint(errorMessage)
    if (hint) {
        ;(errorJson as Record<string, unknown>).hint = hint
    }

    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(errorJson, null, 2),
            },
        ],
        isError: true,
    }
}

/**
 * 格式化成功响应为 MCP 工具响应
 */
export function formatResponse(data: unknown): {
    content: Array<{ type: 'text'; text: string }>
} {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    }
}
