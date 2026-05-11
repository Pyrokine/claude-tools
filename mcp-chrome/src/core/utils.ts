import { mkdir, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'

export const TMP_PATH_PREFIX = 'tmp:'
export const CWD_PATH_PREFIX = 'cwd:'

export type ScopedPathScope = 'tmp' | 'cwd'

export interface ResolvedScopedPath {
    absolutePath: string
    scope: ScopedPathScope
    root: string
}

/**
 * 转义 XPath 字符串字面量（处理包含引号的值）
 *
 * 例如: "It's a \"test\"" => concat('It', "'", 's a "test"')
 */
export function escapeXPathString(str: string): string {
    if (!str.includes("'")) {
        return `'${str}'`
    }
    if (!str.includes('"')) {
        return `"${str}"`
    }
    // 同时包含单双引号，使用 concat() 拼接
    const parts: string[] = []
    let current = ''
    for (const char of str) {
        if (char === "'") {
            if (current) {
                parts.push(`'${current}'`)
                current = ''
            }
            parts.push(`"'"`)
        } else {
            current += char
        }
    }
    if (current) {
        parts.push(`'${current}'`)
    }
    return `concat(${parts.join(', ')})`
}

export async function getControlledTempRoot(serverName: string): Promise<string> {
    const root = join(tmpdir(), 'claude-tools', serverName)
    await mkdir(root, { recursive: true, mode: 0o700 })
    return root
}

export async function resolveScopedInputPath(rawPath: string, serverName: string): Promise<ResolvedScopedPath> {
    return resolveScopedPath(rawPath, serverName)
}

export async function resolveScopedOutputPath(rawPath: string, serverName: string): Promise<ResolvedScopedPath> {
    return resolveScopedPath(rawPath, serverName)
}

export async function ensureParentDir(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
}

async function resolveScopedPath(rawPath: string, serverName: string): Promise<ResolvedScopedPath> {
    const trimmedPath = rawPath.trim()
    if (!trimmedPath) {
        throw new Error('路径不能为空')
    }

    const cwdRoot = await realpath(process.cwd())
    const tempRoot = await getControlledTempRoot(serverName)
    const canonicalTempRoot = await realpath(tempRoot)

    if (trimmedPath.startsWith(CWD_PATH_PREFIX)) {
        const relativePath = trimmedPath.slice(CWD_PATH_PREFIX.length)
        return resolveRelativeScopedPath(relativePath, cwdRoot, 'cwd', 'cwd:')
    }
    if (trimmedPath.startsWith(TMP_PATH_PREFIX)) {
        const relativePath = trimmedPath.slice(TMP_PATH_PREFIX.length)
        return resolveRelativeScopedPath(relativePath, canonicalTempRoot, 'tmp', 'tmp:')
    }

    if (isAbsolute(trimmedPath)) {
        return resolveAbsoluteScopedPath(trimmedPath, cwdRoot, canonicalTempRoot)
    }

    return resolveRelativeScopedPath(trimmedPath, canonicalTempRoot, 'tmp')
}

async function resolveRelativeScopedPath(
    relativePath: string,
    root: string,
    scope: ScopedPathScope,
    prefix?: 'cwd:' | 'tmp:'
): Promise<ResolvedScopedPath> {
    if (!relativePath) {
        throw new Error(prefix ? `${prefix} 后面必须跟相对路径` : '路径不能为空')
    }
    if (isAbsolute(relativePath)) {
        throw new Error(prefix ? `${prefix} 只接受相对路径` : '相对路径不能是绝对路径')
    }
    if (relativePath.split(/[\\/]+/).some((segment) => segment === '..')) {
        throw new Error(prefix ? `${prefix} 路径不允许包含 .. 组件` : '相对路径不允许包含 .. 组件')
    }
    if (process.platform === 'win32' && relativePath.includes(':')) {
        throw new Error(
            prefix ? `${prefix} 路径在 Windows 上不允许包含 : 字符` : '相对路径在 Windows 上不允许包含 : 字符'
        )
    }

    const candidate = resolve(root, relativePath)
    const canonicalCandidate = await canonicalizeOrAncestor(candidate)
    assertWithinRoot(canonicalCandidate, root)
    return { absolutePath: candidate, scope, root }
}

async function resolveAbsoluteScopedPath(
    absolutePath: string,
    cwdRoot: string,
    tempRoot: string
): Promise<ResolvedScopedPath> {
    const canonicalCandidate = await canonicalizeOrAncestor(absolutePath)
    if (isWithinRoot(canonicalCandidate, tempRoot)) {
        return { absolutePath, scope: 'tmp', root: tempRoot }
    }
    if (isWithinRoot(canonicalCandidate, cwdRoot)) {
        return { absolutePath, scope: 'cwd', root: cwdRoot }
    }
    throw new Error(`路径超出允许范围: ${absolutePath}，仅允许受控临时目录或当前工作目录`)
}

async function canonicalizeOrAncestor(path: string): Promise<string> {
    try {
        return await realpath(path)
    } catch {
        const tail: string[] = []
        let current = resolve(path)
        while (true) {
            const parent = dirname(current)
            if (parent === current) {
                throw new Error(`无法解析路径: ${path}`)
            }
            tail.unshift(basename(current))
            current = parent
            try {
                return resolve(await realpath(current), ...tail)
            } catch {
                continue
            }
        }
    }
}

function assertWithinRoot(path: string, root: string): void {
    if (!isWithinRoot(path, root)) {
        throw new Error(`路径超出允许范围: ${path}，仅允许受控临时目录或当前工作目录`)
    }
}

function isWithinRoot(path: string, root: string): boolean {
    const pathFromRoot = relative(root, path)
    if (pathFromRoot === '') {
        return true
    }
    if (isAbsolute(pathFromRoot)) {
        return false
    }
    return !pathFromRoot.split(/[\\/]+/).some((segment) => segment === '..')
}
