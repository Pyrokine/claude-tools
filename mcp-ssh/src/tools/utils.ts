/**
 * 工具共享响应格式化
 */

import * as os from 'os'
import * as path from 'path'

/**
 * 展开路径开头的 ~ 为用户 home 目录
 *
 * 仅支持 ~ 与 ~/...，不支持 ~user 形式
 */
export function expandTilde(p: string): string {
    if (p === '~') {
        return os.homedir()
    }
    if (p.startsWith('~/')) {
        return path.join(os.homedir(), p.slice(2))
    }
    return p
}

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

/**
 * 转义 shell 参数（使用单引号方式，防止命令注入）
 */
export function escapeShellArg(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`
}
