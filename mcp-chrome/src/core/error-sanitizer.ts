/**
 * 错误信息脱敏
 *
 * 在错误信息向 MCP 客户端 / Extension popup / 日志返回前剥离敏感路径
 *
 * 覆盖：
 * - file:// 与本地绝对路径（/home/<user>、/Users/<user>、C:\Users\<user>）
 * - chrome-extension://<id>/<path>
 * - V8 stack frame 行号信息
 * - 用户家目录残留
 *
 * 不覆盖（保留追溯能力）：
 * - 错误类型（ENOENT、EACCES）
 * - HTTP/CDP method 名
 * - 用户输入的资源标识（URL、tabId、refId）— 这些已经是用户已知值
 */

import * as os from 'os'
import * as path from 'path'

const homeDir = os.homedir()
const username = path.basename(homeDir)

const REDACT = '<redacted>'

/**
 * 对错误信息做脱敏,可对 string 或 Error 调用,返回脱敏后的 string
 */
export function sanitizeErrorMessage(input: unknown): string {
    let msg: string
    if (input instanceof Error) {
        msg = input.message
    } else if (typeof input === 'string') {
        msg = input
    } else {
        return String(input)
    }

    // 替换家目录路径（含 file:// 前缀和不带前缀两种）
    if (homeDir) {
        const escapedHome = homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        msg = msg.replace(new RegExp(`file://${escapedHome}`, 'g'), `file://${REDACT}`)
        msg = msg.replace(new RegExp(escapedHome, 'g'), REDACT)
    }
    if (username && username.length >= 2) {
        // 替换 /home/<user>/ /Users/<user>/ C:\Users\<user>\ 的非家目录残留
        const userEsc = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        msg = msg.replace(new RegExp(`/home/${userEsc}\\b`, 'g'), `/home/${REDACT}`)
        msg = msg.replace(new RegExp(`/Users/${userEsc}\\b`, 'g'), `/Users/${REDACT}`)
        msg = msg.replace(new RegExp(`\\\\Users\\\\${userEsc}\\b`, 'g'), `\\Users\\${REDACT}`)
    }

    // chrome-extension://<id>/<path> → chrome-extension://<id>/<redacted>
    msg = msg.replace(/chrome-extension:\/\/([a-z0-9]{32})\/[^\s)"']*/g, 'chrome-extension://$1/<redacted>')

    // V8 stack frame: " at func (file:line:col)" → " at func (...)"
    msg = msg.replace(/\(([^)]*\.[jt]s):\d+:\d+\)/g, '($1)')

    // node:internal stack 中的绝对路径
    msg = msg.replace(/at\s+\/[^\s:]+:\d+:\d+/g, 'at <internal>')

    return msg
}

/**
 * 对错误对象做脱敏,返回 string（用于直接拼到 message 字段）
 */
export function sanitizeError(err: unknown): string {
    if (err instanceof Error) {
        return sanitizeErrorMessage(err)
    }
    return sanitizeErrorMessage(String(err))
}
