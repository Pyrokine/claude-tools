/**
 * 工具共享响应格式化
 */

/**
 * 格式化成功响应
 */
export function formatResult(data: unknown) {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    }
}

/**
 * 格式化错误响应
 */
export function formatError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }, null, 2) }],
        isError: true,
    }
}
