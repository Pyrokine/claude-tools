/**
 * 预期的操作错误（tab 关闭、超时、元素/frame 未找到、受限 URL、路径越界等）
 *
 * 标记此类错误为「预期错误」，让 Service Worker 用 console.warn 而非 console.error
 * 处理，避免污染 Extension 错误面板
 */
export class ExpectedOperationError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ExpectedOperationError'
    }
}

export function isExpectedOperationError(err: unknown): boolean {
    return err instanceof ExpectedOperationError
}
