/**
 * 路径与文件安全校验
 *
 * 限制 privateKeyPath / configPath 必须位于白名单目录下，
 * 加文件大小上限避免任意大文件被读取，
 * 错误消息脱敏避免 PEM 细节泄露
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const MAX_KEY_FILE_SIZE = 64 * 1024 // 私钥实际不会超过 64KB
const MAX_CONFIG_FILE_SIZE = 1024 * 1024 // SSH config 上限 1MB

function getAllowedDirs(): string[] {
    const base = [path.resolve(os.homedir(), '.ssh'), '/etc/ssh']
    const env =
        process.env.SSH_MCP_ALLOWED_KEY_DIRS?.split(path.delimiter)
            .map((d) => d.trim())
            .filter(Boolean) ?? []
    return [...base, ...env.map((d) => path.resolve(d))]
}

function isUnderAllowedDir(resolved: string): { ok: boolean; allowed: string[] } {
    const allowed = getAllowedDirs()
    const ok = allowed.some((dir) => resolved === dir || resolved.startsWith(dir + path.sep))
    return { ok, allowed }
}

/**
 * 校验私钥文件路径在白名单内，且大小不超限
 *
 * 双重校验：原路径（path.resolve 后）和真实路径（realpath 解析所有 symlink 后）都必须在白名单内，
 * 防止"白名单内的 symlink 指向白名单外文件"绕过
 */
export function validateKeyFile(p: string): void {
    const resolved = path.resolve(p)
    if (!isUnderAllowedDir(resolved).ok) {
        const { allowed } = isUnderAllowedDir(resolved)
        throw new Error(
            `Invalid private key path: must be under ${allowed.join(' or ')} ` +
                `(set SSH_MCP_ALLOWED_KEY_DIRS to extend, separated by '${path.delimiter}')`
        )
    }
    const real = fs.realpathSync(resolved)
    if (!isUnderAllowedDir(real).ok) {
        throw new Error(`Invalid private key path: symlink target falls outside the whitelist`)
    }

    const stats = fs.statSync(real)
    if (stats.size > MAX_KEY_FILE_SIZE) {
        throw new Error(`Private key file too large: ${stats.size} bytes (max ${MAX_KEY_FILE_SIZE})`)
    }
}

/**
 * 校验 SSH config 文件路径在白名单内，且大小不超限
 *
 * 同 validateKeyFile：原路径 + realpath 都必须在白名单
 */
export function validateConfigFile(p: string): void {
    const resolved = path.resolve(p)
    if (!isUnderAllowedDir(resolved).ok) {
        const { allowed } = isUnderAllowedDir(resolved)
        throw new Error(
            `Invalid config path: must be under ${allowed.join(' or ')} ` +
                `(set SSH_MCP_ALLOWED_KEY_DIRS to extend, separated by '${path.delimiter}')`
        )
    }
    const real = fs.realpathSync(resolved)
    if (!isUnderAllowedDir(real).ok) {
        throw new Error(`Invalid config path: symlink target falls outside the whitelist`)
    }

    const stats = fs.statSync(real)
    if (stats.size > MAX_CONFIG_FILE_SIZE) {
        throw new Error(`SSH config file too large: ${stats.size} bytes (max ${MAX_CONFIG_FILE_SIZE})`)
    }
}

/**
 * 脱敏 ssh2 keyParser 错误，避免 PEM 文件 cipher/kdf 字段被泄露
 */
export function sanitizeKeyError(message: string): string {
    const lower = message.toLowerCase()
    if (
        lower.includes('private key') ||
        lower.includes('pem') ||
        lower.includes('encrypted') ||
        lower.includes('passphrase') ||
        lower.includes('cipher')
    ) {
        return 'Invalid private key file'
    }
    return message
}
