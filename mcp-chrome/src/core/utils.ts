import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { chmod, lstat, mkdir, open, opendir, readFile, realpath, rename, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { promisify } from 'util'

export const TMP_PATH_PREFIX = 'tmp:'
export const CWD_PATH_PREFIX = 'cwd:'

export type ScopedPathScope = 'tmp' | 'cwd'

export interface ResolvedScopedPath {
    absolutePath: string
    scope: ScopedPathScope
    root: string
}

const TEMP_SESSION_MARKER = '.mcp-chrome-session'
const TEMP_SESSION_TTL_MS = 24 * 60 * 60 * 1000
export const TEMP_OUTPUT_RETENTION =
    '受控临时会话超过 24 小时、所属进程退出后，后续启动时会清理；长期保留请使用 cwd: 输出'
const TEMP_MAX_ENTRIES = 256
const TEMP_MAX_BYTES = 128 * 1024 * 1024
const tempRoots = new Map<string, Promise<string>>()
const activeTempRoots = new Set<string>()
const writeLocks = new Map<string, Promise<void>>()
const execFileAsync = promisify(execFile)

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

async function restrictPrivatePath(path: string, directory: boolean): Promise<void> {
    if (process.platform !== 'win32') {
        await chmod(path, directory ? 0o700 : 0o600)
        return
    }
    const script = `
$ErrorActionPreference = 'Stop'
$p = $env:MCP_CHROME_PRIVATE_PATH
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$admins = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$allowed = @($current.Value, $system.Value, $admins.Value)
$acl = Get-Acl -LiteralPath $p
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $current.Value) { throw 'unexpected owner' }
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
    [void]$acl.RemoveAccessRuleSpecific($rule)
}
$inherit = if (${directory ? '$true' : '$false'}) {
    [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
} else {
    [System.Security.AccessControl.InheritanceFlags]::None
}
foreach ($sid in @($current, $system, $admins)) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit,
        [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $p -AclObject $acl
$actual = Get-Acl -LiteralPath $p
if (-not $actual.AreAccessRulesProtected -or
    $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $current.Value) { throw 'private ACL not applied' }
$ownerAllowed = $false
foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or
        $allowed -notcontains $rule.IdentityReference.Value) { throw 'unexpected ACL entry' }
    if ($rule.IdentityReference.Value -eq $current.Value -and
        ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
        [System.Security.AccessControl.FileSystemRights]::FullControl) { $ownerAllowed = $true }
}
if (-not $ownerAllowed) { throw 'owner cannot read private output' }
[Console]::WriteLine('usable')`
    try {
        const result = await execFileAsync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
            {
                env: { ...process.env, MCP_CHROME_PRIVATE_PATH: path },
                timeout: 10_000,
                windowsHide: true,
                maxBuffer: 16_384,
            }
        )
        if (result.stdout.trim() === 'usable') {
            return
        }
    } catch (error) {
        throw new Error(`privacy_not_enforced_on_windows: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
        })
    }
    throw new Error('privacy_not_enforced_on_windows: 私有 DACL 未通过验证')
}

async function assertRealDirectory(path: string): Promise<void> {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
        throw new Error(`受控临时目录不属于当前用户或不是普通目录: ${path}`)
    }
}

async function assertCurrentSession(root: string): Promise<void> {
    await assertRealDirectory(root)
    const markerPath = join(root, TEMP_SESSION_MARKER)
    const info = await lstat(markerPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256) {
        throw new Error('受控临时会话归属标记无效，拒绝写入')
    }
    const marker = await readFile(markerPath, 'utf8')
    if (marker !== JSON.stringify({ version: 1, session: basename(root), pid: process.pid })) {
        throw new Error('受控临时会话归属标记已变化，拒绝写入')
    }
}

async function cleanupExpiredSessions(root: string): Promise<void> {
    const entries = await opendir(root)
    const scan = async (): Promise<void> => {
        const started = Date.now()
        for (let inspected = 0; inspected < 128 && Date.now() - started <= 200; ++inspected) {
            const entry = await entries.read()
            if (!entry) {
                await entries.close()
                return
            }
            if (!entry.isDirectory() || !entry.name.startsWith('session-')) {
                continue
            }
            const path = join(root, entry.name)
            try {
                await assertRealDirectory(path)
                const markerPath = join(path, TEMP_SESSION_MARKER)
                const info = await lstat(markerPath)
                if (!info.isFile() || info.isSymbolicLink() || info.size > 256) {
                    continue
                }
                const marker: unknown = JSON.parse(await readFile(markerPath, 'utf8'))
                if (
                    !marker ||
                    typeof marker !== 'object' ||
                    !('session' in marker) ||
                    marker.session !== entry.name ||
                    !('pid' in marker) ||
                    typeof marker.pid !== 'number' ||
                    !Number.isSafeInteger(marker.pid) ||
                    marker.pid < 1 ||
                    !('version' in marker) ||
                    marker.version !== 1
                ) {
                    continue
                }
                const stats = await lstat(path)
                if (Date.now() - stats.mtimeMs <= TEMP_SESSION_TTL_MS) {
                    continue
                }
                try {
                    process.kill(marker.pid, 0)
                    continue
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                        continue
                    }
                }
                await rm(path, { recursive: true })
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    console.warn('[mcp-chrome] 受控临时会话清理失败:', error)
                }
            }
        }
        setImmediate(() => {
            void scan().catch(async (error: unknown) => {
                console.warn('[mcp-chrome] 受控临时会话扫描失败:', error)
                await entries.close().catch(() => undefined)
            })
        })
    }
    try {
        await scan()
    } catch (error) {
        await entries.close().catch(() => undefined)
        throw error
    }
}

export async function getControlledTempRoot(serverName: string): Promise<string> {
    const cached = tempRoots.get(serverName)
    if (cached) {
        const session = await cached
        await assertCurrentSession(session)
        return session
    }
    const initialize = (async () => {
        const root = join(tmpdir(), 'claude-tools', serverName)
        await mkdir(root, { recursive: true, mode: 0o700 })
        await assertRealDirectory(dirname(root))
        await assertRealDirectory(root)
        await restrictPrivatePath(root, true)
        await cleanupExpiredSessions(root)

        const name = `session-${randomUUID()}`
        const session = join(root, name)
        await mkdir(session, { mode: 0o700 })
        try {
            await restrictPrivatePath(session, true)
            const markerPath = join(session, TEMP_SESSION_MARKER)
            const handle = await open(markerPath, 'wx', 0o600)
            try {
                await restrictPrivatePath(markerPath, false)
                await handle.writeFile(JSON.stringify({ version: 1, session: name, pid: process.pid }))
            } finally {
                await handle.close()
            }
            const canonical = await realpath(session)
            activeTempRoots.add(canonical)
            return canonical
        } catch (error) {
            await rm(session, { recursive: true }).catch(() => undefined)
            throw error
        }
    })()
    tempRoots.set(serverName, initialize)
    try {
        return await initialize
    } catch (error) {
        tempRoots.delete(serverName)
        throw error
    }
}

export async function resolveScopedInputPath(rawPath: string, serverName: string): Promise<ResolvedScopedPath> {
    return resolveScopedPath(rawPath, serverName)
}

export async function resolveScopedOutputPath(rawPath: string, serverName: string): Promise<ResolvedScopedPath> {
    return resolveScopedPath(rawPath, serverName)
}

export async function ensureParentDir(path: string): Promise<void> {
    const parent = dirname(path)
    const managedRoot = [...activeTempRoots].find((root) => isWithinRoot(resolve(path), root))
    if (managedRoot) {
        await assertCurrentSession(managedRoot)
    }
    await mkdir(parent, { recursive: true, mode: 0o700 })
    if (managedRoot) {
        const canonicalParent = await realpath(parent)
        assertWithinRoot(canonicalParent, managedRoot)
        await restrictPrivatePath(canonicalParent, true)
    }
}

async function countMissingDirectories(root: string, parent: string): Promise<number> {
    let current = resolve(parent)
    let missing = 0
    while (current !== root) {
        if (!isWithinRoot(current, root) || missing > TEMP_MAX_ENTRIES) {
            throw new Error('受控临时会话输出路径超出目录范围或配额')
        }
        try {
            const info = await lstat(current)
            if (!info.isDirectory() || info.isSymbolicLink()) {
                throw new Error(`输出父路径不是普通目录: ${current}`)
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error
            }
            ++missing
        }
        current = dirname(current)
    }
    return missing
}

async function checkTempQuota(root: string, path: string, dataSize: number, additionalDirs: number): Promise<void> {
    if (dataSize > TEMP_MAX_BYTES) {
        throw new Error(`受控临时会话单文件超过 ${TEMP_MAX_BYTES} 字节上限`)
    }
    let entries = 0
    let bytes = 0
    const pending = [root]
    while (pending.length > 0) {
        const directory = pending.pop()!
        const files = await opendir(directory)
        for await (const entry of files) {
            const item = join(directory, entry.name)
            const stats = await lstat(item)
            if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
                throw new Error('受控临时会话包含无法计入配额的文件类型')
            }
            if (++entries > TEMP_MAX_ENTRIES) {
                throw new Error(`受控临时会话超过 ${TEMP_MAX_ENTRIES} 个文件或目录`)
            }
            bytes += stats.size
            if (bytes > TEMP_MAX_BYTES) {
                throw new Error(`受控临时会话超过 ${TEMP_MAX_BYTES} 字节上限`)
            }
            if (stats.isDirectory()) {
                pending.push(item)
            }
        }
    }
    let previousSize = 0
    let extraEntry = 1
    try {
        const existing = await lstat(path)
        if (!existing.isFile() || existing.isSymbolicLink()) {
            throw new Error(`不能覆盖非普通文件: ${path}`)
        }
        previousSize = existing.size
        extraEntry = 0
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
        }
    }
    if (
        entries + additionalDirs + extraEntry > TEMP_MAX_ENTRIES ||
        bytes - previousSize + dataSize + additionalDirs * 4096 > TEMP_MAX_BYTES
    ) {
        throw new Error(`受控临时会话超过 ${TEMP_MAX_ENTRIES} 项或 ${TEMP_MAX_BYTES} 字节上限`)
    }
}

export function isControlledTempOutput(path: string): boolean {
    return [...activeTempRoots].some((root) => isWithinRoot(resolve(path), root))
}

export async function writePrivateFile(path: string, data: string | Buffer, encoding?: BufferEncoding): Promise<void> {
    const root = [...activeTempRoots].find((item) => isWithinRoot(resolve(path), item))
    const write = async (): Promise<void> => {
        if (root) {
            const missing = await countMissingDirectories(root, dirname(path))
            await checkTempQuota(
                root,
                path,
                Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, encoding),
                missing
            )
        }
        await ensureParentDir(path)
        const tempPath = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`)
        const handle = await open(tempPath, 'wx', 0o600)
        let closed = false
        try {
            await restrictPrivatePath(tempPath, false)
            await handle.writeFile(data, encoding)
            await handle.close()
            closed = true
            await rename(tempPath, path)
        } catch (error) {
            if (!closed) {
                await handle.close().catch(() => undefined)
            }
            await rm(tempPath, { force: true }).catch(() => undefined)
            throw error
        }
    }
    if (!root) {
        return write()
    }
    const previous = writeLocks.get(root) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(write)
    writeLocks.set(root, next)
    try {
        await next
    } finally {
        if (writeLocks.get(root) === next) {
            writeLocks.delete(root)
        }
    }
}

function validatePortableOutputPath(rawPath: string): void {
    if (
        rawPath !== rawPath.trim() ||
        /[<>"|?*]/.test(rawPath) ||
        [...rawPath].some((character) => character.charCodeAt(0) < 32) ||
        /^[/\\]{2}[.?][/\\]/.test(rawPath)
    ) {
        throw new Error('路径包含 Windows 不支持的字符或设备前缀')
    }
    const prefixed = rawPath.startsWith(TMP_PATH_PREFIX) || rawPath.startsWith(CWD_PATH_PREFIX)
    const value = rawPath.replace(/^(?:tmp:|cwd:)/, '')
    const drive = !prefixed && isAbsolute(value) && /^[a-zA-Z]:[\\/]/.test(value)
    const components = value.split(/[\\/]+/).filter(Boolean)
    for (let i = 0; i < components.length; i++) {
        const part = components[i]
        if (i === 0 && drive && /^[a-zA-Z]:$/.test(part)) {
            continue
        }
        if (part.endsWith(' ') || part.endsWith('.') || part.includes(':')) {
            throw new Error(`路径包含 Windows 不支持的组件: ${part}`)
        }
        const base = part.split('.')[0].toUpperCase()
        if (/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$)$/.test(base) || /^(?:COM|LPT)(?:[1-9¹²³])$/.test(base)) {
            throw new Error(`路径包含 Windows 保留设备名: ${part}`)
        }
    }
}

async function resolveScopedPath(rawPath: string, serverName: string): Promise<ResolvedScopedPath> {
    validatePortableOutputPath(rawPath)
    if (!rawPath) {
        throw new Error('路径不能为空')
    }
    const cwdRoot = await realpath(process.cwd())
    if (rawPath.startsWith(CWD_PATH_PREFIX)) {
        return resolveRelativeScopedPath(rawPath.slice(CWD_PATH_PREFIX.length), cwdRoot, 'cwd', 'cwd:')
    }
    const tempRoot = await getControlledTempRoot(serverName)
    if (rawPath.startsWith(TMP_PATH_PREFIX)) {
        return resolveRelativeScopedPath(rawPath.slice(TMP_PATH_PREFIX.length), tempRoot, 'tmp', 'tmp:')
    }
    if (isAbsolute(rawPath)) {
        return resolveAbsoluteScopedPath(rawPath, cwdRoot, tempRoot)
    }
    return resolveRelativeScopedPath(rawPath, tempRoot, 'tmp')
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
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
        }
        const tail: string[] = []
        let current = resolve(path)
        while (true) {
            const parent = dirname(current)
            if (parent === current) {
                throw new Error(`无法解析路径: ${path}`, { cause: error })
            }
            tail.unshift(basename(current))
            current = parent
            try {
                return resolve(await realpath(current), ...tail)
            } catch (ancestorError) {
                if ((ancestorError as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw ancestorError
                }
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
