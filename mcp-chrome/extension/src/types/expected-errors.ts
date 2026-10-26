/**
 * 预期的操作错误（tab 关闭、超时、元素/frame 未找到、受限 URL、路径越界等）
 *
 * 标记此类错误为「预期错误」，让 Service Worker 用 console.warn 而非 console.error
 * 处理，避免污染 Extension 错误面板
 */
export class ExpectedOperationError extends Error {
    constructor(
        message: string,
        readonly actionExecuted?: false
    ) {
        super(message)
        this.name = 'ExpectedOperationError'
    }
}

export function isExpectedOperationError(err: unknown): boolean {
    return err instanceof ExpectedOperationError
}

// chrome.debugger 的预期拒绝保留失败响应，使用 warning 诊断
const EXPECTED_DEBUGGER_PATTERNS = [
    /Cannot access a chrome:\/\//i,
    /Cannot access a chrome-extension:\/\//i,
    /Cannot attach to .* tab/i,
    /Inspected target navigated or closed/i,
    /^No tab with (?:given )?id\b/i,
    /Detached while handling command/i,
    /Cannot find context with specified id/i,
    /Execution context was destroyed/i,
]

export function wrapDebuggerError(
    error: unknown,
    context: {
        tabId: number
        method?: string
        phase: 'attach' | 'detach' | 'command'
        frameContext?: Record<string, unknown>
    }
): Error {
    if (error instanceof ExpectedOperationError) {
        return error
    }
    const raw = error instanceof Error ? error.message : String(error)
    let message = raw
    let nativeCode: number | undefined
    try {
        const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown } | null
        if (typeof parsed?.message === 'string' && typeof parsed.code === 'number') {
            message = parsed.message
            nativeCode = parsed.code
        }
    } catch {
        // Chrome 也会直接返回未编码的消息
    }

    let reason: string
    let suggestion: string
    if (/^Debugger agent is not enabled\.?$/i.test(message)) {
        reason = 'domain_not_enabled'
        suggestion = '在当前调试会话显式启用 Debugger 域后，再请求该方法'
    } else if (/^No script for id:/i.test(message)) {
        reason = 'resource_not_found'
        suggestion = '从当前页面及调试会话重新读取 scriptId，再请求脚本内容'
    } else if (/^Cannot(?: not)? access browser-level commands\.?$/i.test(message)) {
        reason = 'browser_command_unavailable'
        suggestion = '该命令需要浏览器级 CDP 会话，请显式连接支持该命令的调试目标'
    } else if (context.phase === 'command' && message === 'Not allowed') {
        reason = 'command_not_allowed'
        suggestion = '当前调试会话拒绝此方法，请检查命令所需的权限和调试目标'
    } else if (/^(?:Object couldn't be returned by value|Object reference chain is too long)\.?$/i.test(message)) {
        reason = 'result_not_serializable'
        suggestion = '先检查动作产生的状态；再次调用时返回可序列化值，原脚本不会自动重放'
    } else if (nativeCode === -32601 || /^'[^']+' wasn't found\.?$/i.test(message)) {
        reason = 'method_not_found'
        suggestion = '检查当前调试协议支持的方法名，方法缺失不表示整个域不可用'
    } else if (EXPECTED_DEBUGGER_PATTERNS.some((pattern) => pattern.test(message))) {
        reason = 'target_unavailable'
        suggestion = '重新读取目标页面和调试上下文，再提交操作'
    } else {
        return error instanceof Error ? error : new Error(raw)
    }
    return new ExpectedOperationError(
        JSON.stringify({
            error: {
                code: 'CDP_ERROR',
                message: `${context.method ?? `chrome.debugger.${context.phase}`}: ${message}`,
                suggestion,
                context: {
                    nativeSource: 'chrome.debugger',
                    targetId: String(context.tabId),
                    method: context.method,
                    phase: context.phase,
                    nativeMessage: message,
                    ...(nativeCode !== undefined ? { nativeCode } : {}),
                    reason,
                    ...(context.frameContext ? { frameContext: context.frameContext } : {}),
                },
            },
        })
    )
}
