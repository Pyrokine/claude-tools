import { spawnSync } from 'node:child_process'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import ssh2, { type ServerHostKeyAlgorithm } from 'ssh2'
import { validateKnownHostsPath } from './security.js'
import type { ConnectionFailureDetails } from './types.js'
import { checkWindowsAcl, checkWindowsKnownHostsIntegrity } from './windows-acl.js'

export interface HostKeyTrust {
    status: 'known' | 'added'
    fingerprint: string
}

export class HostKeyError extends Error {
    readonly hostKey?: ConnectionFailureDetails['hostKey']

    constructor(message: string, options?: ErrorOptions & { hostKey?: ConnectionFailureDetails['hostKey'] }) {
        super(message, options)
        this.name = 'HostKeyError'
        this.hostKey = options?.hostKey
    }
}

function assertIntegrity(filePath: string): void {
    if (process.platform === 'win32') {
        checkWindowsKnownHostsIntegrity(filePath)
        return
    }
    let current = filePath
    for (;;) {
        const stats = fs.statSync(current)
        const trustedOwner = stats.uid === 0 || stats.uid === process.getuid?.()
        const stickyDirectory = stats.isDirectory() && (stats.mode & 0o1000) !== 0
        if (!trustedOwner || ((stats.mode & 0o022) !== 0 && !stickyDirectory)) {
            throw new HostKeyError(`known_hosts has an untrusted owner or writer: ${current}`)
        }
        const parent = path.dirname(current)
        if (parent === current) {
            return
        }
        current = parent
    }
}

function localProcessDomain(deadline: number): string | undefined {
    // A hostname alone cannot distinguish shared homes or different PID namespaces.
    if (process.platform === 'linux') {
        try {
            const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
            const namespace = fs.readlinkSync('/proc/self/ns/pid')
            if (/^[\da-f-]{36}$/.test(boot) && /^pid:\[\d+]$/.test(namespace)) {
                return `${boot}:${namespace}`
            }
        } catch {
            // Unavailable process-domain evidence leaves stale owners unverifiable.
        }
    }
    if (process.platform === 'darwin' || process.platform === 'win32') {
        const script =
            "$ErrorActionPreference = 'Stop'\n" +
            "Add-Type -TypeDefinition @'\n" +
            'using System;\n' +
            'using System.Runtime.InteropServices;\n' +
            'public static class McpBootEnvironment {\n' +
            '    [StructLayout(LayoutKind.Sequential)]\n' +
            '    private struct BootEnvironment {\n' +
            '        public Guid BootIdentifier;\n' +
            '        public uint FirmwareType;\n' +
            '        public ulong BootFlags;\n' +
            '    }\n' +
            '    [DllImport("ntdll.dll", ExactSpelling = true)]\n' +
            '    private static extern int NtQuerySystemInformation(int ' +
            'informationClass,\n' +
            '        out BootEnvironment information, int length, out int ' +
            'returnLength);\n' +
            '    public static string Read() {\n' +
            '        BootEnvironment information;\n' +
            '        int length;\n' +
            '        int size = Marshal.SizeOf(typeof(BootEnvironment));\n' +
            '        // SystemBootEnvironmentInformation (90), ' +
            'SYSTEM_BOOT_ENVIRONMENT_INFORMATION.\n' +
            '        int status = NtQuerySystemInformation(90, out information, size, ' +
            'out length);\n' +
            '        if (status != 0 || length != size) throw new ' +
            'InvalidOperationException("Boot identity query failed");\n' +
            '        return information.BootIdentifier.ToString("D");\n' +
            '    }\n' +
            '}\n' +
            "'@\n" +
            '[Console]::Write([McpBootEnvironment]::Read())'
        const windows = process.platform === 'win32'
        const result = spawnSync(
            windows ? 'powershell.exe' : '/usr/sbin/sysctl',
            windows
                ? [
                      '-NoProfile',
                      '-NonInteractive',
                      '-EncodedCommand',
                      Buffer.from(script, 'utf16le').toString('base64'),
                  ]
                : ['-n', 'kern.bootsessionuuid'],
            {
                timeout: Math.max(1, Math.min(5000, deadline - Date.now())),
                encoding: 'utf8',
                windowsHide: true,
                maxBuffer: 16_384,
            }
        )
        const boot = result.stdout?.trim().toLowerCase()
        if (
            !result.error &&
            result.status === 0 &&
            /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(boot) &&
            boot !== '00000000-0000-0000-0000-000000000000'
        ) {
            return `${process.platform}:${boot}`
        }
    }
    return undefined
}

async function removeEmptyLock(directory: string): Promise<void> {
    try {
        await fs.promises.rmdir(directory)
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') {
            return
        }
        // Windows can report EPERM for a directory another writer has just populated.
        if (code === 'EPERM') {
            try {
                if ((await fs.promises.readdir(directory)).length > 0) {
                    return
                }
            } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
                    return
                }
                throw cause
            }
        }
        throw error
    }
}

async function removeLockOwner(directory: string, owner: string): Promise<void> {
    try {
        await fs.promises.unlink(path.join(directory, owner))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
        }
    }
    // A new owner's unique filename keeps this non-recursive removal from deleting its lock.
    await removeEmptyLock(directory)
}

async function inspectLock(
    directory: string,
    domain: string | undefined,
    preparation = false
): Promise<string | undefined> {
    try {
        const stats = await fs.promises.lstat(directory)
        if (stats.isFile()) {
            return 'legacy lock file has no verifiable owner; it was retained'
        }
        if (!stats.isDirectory()) {
            return 'lock owner identity could not be verified; it was retained'
        }
        assertIntegrity(directory)
        const entries = await fs.promises.readdir(directory)
        if (entries.length === 0 && !preparation) {
            await removeEmptyLock(directory)
            return
        }
        const match = entries.length === 1 ? /^owner-(?<pid>\d+)-(?<nonce>[\da-f]{32})\.json$/.exec(entries[0]) : null
        if (!match || (preparation && !directory.endsWith(`.prepare-${match.groups!.pid}-${match.groups!.nonce}`))) {
            return 'lock owner identity could not be verified; it was retained'
        }
        const ownerPath = path.join(directory, entries[0])
        const ownerStats = await fs.promises.lstat(ownerPath)
        if (!ownerStats.isFile() || ownerStats.size > 4096) {
            return 'lock owner identity could not be verified; it was retained'
        }
        assertIntegrity(ownerPath)
        let owner: { version?: number; pid?: number; domain?: string }
        try {
            owner = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8'))
        } catch (error) {
            if (error instanceof SyntaxError) {
                return 'lock owner identity could not be verified; it was retained'
            }
            throw error
        }
        if (
            !domain ||
            !owner ||
            owner.version !== 1 ||
            owner.domain !== domain ||
            owner.pid !== Number(match.groups!.pid) ||
            !Number.isSafeInteger(owner.pid) ||
            owner.pid <= 0
        ) {
            return 'lock belongs to an unverifiable local process domain; it was retained'
        }
        try {
            process.kill(owner.pid, 0)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
                await removeLockOwner(directory, entries[0])
                return
            }
            if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
                throw error
            }
            return 'lock owner liveness could not be verified (EPERM); it was retained'
        }
        return 'lock is held by a live process'
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return
        }
        if (preparation) {
            return 'preparation ownership could not be verified; it was retained'
        }
        throw error
    }
}

function decodeBase64(value: string): Buffer {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
        throw new HostKeyError('Invalid known_hosts key encoding')
    }
    const bytes = Buffer.from(value, 'base64')
    if (bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
        throw new HostKeyError('Invalid known_hosts key encoding')
    }
    return bytes
}

function matchesPattern(pattern: string, hostname: string): boolean {
    if (pattern.startsWith('|')) {
        const fields = pattern.split('|')
        if (fields.length !== 4 || fields[1] !== '1') {
            throw new HostKeyError('Unsupported or damaged hashed known_hosts hostname')
        }
        const salt = decodeBase64(fields[2])
        const expected = decodeBase64(fields[3])
        const actual = createHmac('sha1', salt).update(hostname).digest()
        return expected.length === actual.length && timingSafeEqual(expected, actual)
    }
    const expression = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
    return new RegExp(`^${expression}$`, 'i').test(hostname)
}

function matchesHost(patterns: string, hostname: string): boolean {
    let positive = false
    for (const value of patterns.split(',')) {
        const negative = value.startsWith('!')
        if (matchesPattern(negative ? value.slice(1) : value, hostname)) {
            if (negative) {
                return false
            }
            positive = true
        }
    }
    return positive
}

function knownHostName(host: string, port: number): string {
    const hostname = host.replace(/^\[(?<host>.*)]$/, '$1').toLowerCase()
    if (!hostname || /[\s,|!*?\0]/.test(hostname)) {
        throw new HostKeyError('Invalid hostname for known_hosts verification')
    }
    return port === 22 ? hostname : `[${hostname}]:${port}`
}

export class KnownHosts {
    constructor(
        private readonly userFile = path.join(os.homedir(), '.ssh', 'known_hosts'),
        private readonly systemFiles = process.platform === 'win32'
            ? [path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'ssh', 'ssh_known_hosts')]
            : ['/etc/ssh/ssh_known_hosts', '/etc/ssh/ssh_known_hosts2']
    ) {}

    getHostKeyAlgorithms(host: string, port: number): ServerHostKeyAlgorithm[] {
        const types = new Set<string>()
        for (const { type, revoked } of this.matchingKeys(knownHostName(host, port))) {
            if (!revoked) {
                types.add(type)
            }
        }
        const algorithms: ServerHostKeyAlgorithm[] = [
            'ssh-ed25519',
            'ecdsa-sha2-nistp256',
            'ecdsa-sha2-nistp384',
            'ecdsa-sha2-nistp521',
            'rsa-sha2-512',
            'rsa-sha2-256',
            'ssh-rsa',
        ]
        return algorithms.filter((algorithm) => types.has(algorithm.startsWith('rsa-sha2-') ? 'ssh-rsa' : algorithm))
    }

    async verify(
        host: string,
        port: number,
        rawKey: Buffer,
        signal?: AbortSignal,
        deadline = Date.now() + 5000
    ): Promise<HostKeyTrust> {
        const name = knownHostName(host, port)
        const parsed = ssh2.utils.parseKey(rawKey)
        if (parsed instanceof Error || Array.isArray(parsed) || parsed.type.includes('-cert-')) {
            throw new HostKeyError('Unsupported or damaged server host key')
        }
        const fingerprint = `SHA256:${createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '')}`
        const check = (): void => {
            signal?.throwIfAborted()
            if (Date.now() >= deadline) {
                throw new HostKeyError('known_hosts verification deadline exhausted')
            }
        }
        check()
        if (this.lookup(name, rawKey)) {
            return { status: 'known', fingerprint }
        }
        const real = validateKnownHostsPath(this.userFile)
        const parent = path.dirname(real)
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
        assertIntegrity(parent)
        const lockPath = `${real}.mcp-lock`
        const lockDeadline = Math.min(deadline, Date.now() + 5000)
        const domain = localProcessDomain(lockDeadline)
        const identity = `${process.pid}-${randomBytes(16).toString('hex')}`
        const preparation = `${lockPath}.prepare-${identity}`
        const owner = `owner-${identity}.json`
        let prepared = false
        let owned = false
        let file: fs.promises.FileHandle | undefined
        let appendStarted = false
        let result: HostKeyTrust | undefined
        const failures: unknown[] = []
        try {
            const prefix = `${path.basename(lockPath)}.prepare-`
            for (const entry of await fs.promises.readdir(parent)) {
                if (entry.startsWith(prefix) && /^\d+-[\da-f]{32}$/.test(entry.slice(prefix.length))) {
                    check()
                    await inspectLock(path.join(parent, entry), domain, true)
                }
            }
            check()
            await fs.promises.mkdir(preparation, { mode: 0o700 })
            prepared = true
            if (process.platform === 'win32' && checkWindowsAcl(preparation, true) !== 'key_path_usable') {
                throw new HostKeyError('known_hosts lock preparation permissions could not be verified')
            }
            await fs.promises.writeFile(
                path.join(preparation, owner),
                JSON.stringify({ version: 1, pid: process.pid, domain }),
                {
                    flag: 'wx',
                    mode: 0o600,
                }
            )
            assertIntegrity(path.join(preparation, owner))
            let waitingReason = 'another writer'
            while (!owned) {
                signal?.throwIfAborted()
                if (Date.now() >= lockDeadline) {
                    throw new HostKeyError(`known_hosts is locked: ${waitingReason}`)
                }
                let waiting = await inspectLock(lockPath, domain)
                waitingReason = waiting ?? waitingReason
                if (!waiting) {
                    check()
                    try {
                        // Await publication even if canceled, so ownership is recorded before cleanup.
                        await fs.promises.rename(preparation, lockPath)
                        prepared = false
                        owned = true
                    } catch (error) {
                        const code = (error as NodeJS.ErrnoException).code
                        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(code ?? '')) {
                            throw error
                        }
                        const target = await fs.promises.lstat(lockPath).catch((cause: NodeJS.ErrnoException) => {
                            if (cause.code !== 'ENOENT') {
                                throw cause
                            }
                        })
                        if (target?.isDirectory()) {
                            await removeEmptyLock(lockPath)
                        } else if ((code === 'EPERM' || code === 'EACCES') && !target?.isFile()) {
                            throw error
                        }
                        waiting = 'another writer published its lock'
                    }
                }
                if (!owned) {
                    if (Date.now() >= lockDeadline) {
                        throw new HostKeyError(`known_hosts is locked: ${waiting}`)
                    }
                    await delay(Math.min(25, lockDeadline - Date.now()), undefined, { signal })
                }
            }
            check()
            if (this.lookup(name, rawKey)) {
                result = { status: 'known', fingerprint }
            } else {
                const original = this.read(this.userFile, false)
                const existed = fs.existsSync(real)
                const before = existed ? fs.statSync(real) : undefined
                file = await fs.promises.open(
                    real,
                    existed ? fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0) : 'ax',
                    0o600
                )
                check()
                assertIntegrity(real)
                const opened = await file.stat()
                if (before && (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size)) {
                    throw new HostKeyError('known_hosts changed while opening it')
                }
                const entry =
                    `${original.length && !original.endsWith('\n') ? '\n' : ''}` +
                    `${name}` +
                    ' ' +
                    `${parsed.type}` +
                    ' ' +
                    `${rawKey.toString('base64')}` +
                    '\n'
                appendStarted = true
                await file.writeFile(entry)
                await file.sync()
                check()
                result = { status: 'added', fingerprint }
            }
        } catch (error) {
            failures.push(error)
        } finally {
            if (file) {
                try {
                    await file.close()
                    check()
                } catch (error) {
                    failures.push(error)
                }
            }
            if (owned) {
                try {
                    await fs.promises.unlink(path.join(lockPath, owner))
                    await removeEmptyLock(lockPath)
                } catch (error) {
                    failures.push(new HostKeyError('known_hosts lock release failed', { cause: error }))
                }
            }
            if (prepared) {
                try {
                    await removeLockOwner(preparation, owner)
                } catch (error) {
                    failures.push(new HostKeyError('known_hosts preparation cleanup failed', { cause: error }))
                }
            }
        }
        if (!failures.length) {
            try {
                check()
            } catch (error) {
                failures.push(error)
            }
        }
        if (failures.length) {
            const reasons = failures
                .map((error) => {
                    const cause =
                        error instanceof Error && error.cause
                            ? ` (${(error.cause as NodeJS.ErrnoException)?.code ?? ''} ${String(error.cause)})`
                            : ''
                    return `${(error as NodeJS.ErrnoException)?.code ?? ''} ${String(error)}${cause}`.trim()
                })
                .join('; ')
            if (!appendStarted && failures.length === 1 && (failures[0] instanceof HostKeyError || signal?.aborted)) {
                throw failures[0]
            }
            throw new HostKeyError(
                appendStarted
                    ? 'known_hosts append result is unknown; partial bytes may remain and were ' +
                          'not rolled back: ' +
                          `${reasons}`
                    : `known_hosts trust could not be saved: ${reasons}`,
                { cause: failures.length === 1 ? failures[0] : new AggregateError(failures) }
            )
        }
        return result!
    }

    private read(filePath: string, system: boolean): string {
        const real = validateKnownHostsPath(filePath, system)
        if (!fs.existsSync(real)) {
            return ''
        }
        assertIntegrity(real)
        const stats = fs.statSync(real)
        if (!stats.isFile() || stats.size > 8 * 1024 * 1024) {
            throw new HostKeyError('known_hosts must be a regular file no larger than 8 MiB')
        }
        return fs.readFileSync(real, 'utf8')
    }

    private *matchingKeys(
        hostname: string
    ): Generator<{ key: Buffer; type: string; revoked: boolean; file: string; line: number }> {
        const files = [
            [this.userFile, false],
            [`${this.userFile}2`, false],
            ...this.systemFiles.map((name) => [name, true]),
        ] as [string, boolean][]
        for (const [filePath, system] of files) {
            const lines = this.read(filePath, system).split(/\r?\n/)
            for (let index = 0; index < lines.length; ++index) {
                const line = lines[index].trim()
                if (!line || line.startsWith('#')) {
                    continue
                }
                const fields = line.split(/\s+/)
                const marker = fields[0].startsWith('@') ? fields.shift() : undefined
                if (!matchesHost(fields[0], hostname)) {
                    continue
                }
                if (marker === '@cert-authority' || fields[1]?.includes('-cert-v01@openssh.com')) {
                    throw new HostKeyError(
                        `Host certificates/CA entries require the OpenSSH backend: ${filePath}:${index + 1}`
                    )
                }
                if (marker && marker !== '@revoked') {
                    throw new HostKeyError(`Unsupported known_hosts marker: ${filePath}:${index + 1}`)
                }
                let key: Buffer
                try {
                    key = decodeBase64(fields[2] ?? '')
                    const parsed = ssh2.utils.parseKey(key)
                    if (parsed instanceof Error || parsed.type !== fields[1]) {
                        throw new Error('key type mismatch')
                    }
                } catch {
                    throw new HostKeyError(`Damaged matching known_hosts key: ${filePath}:${index + 1}`)
                }
                yield { key, type: fields[1], revoked: marker === '@revoked', file: filePath, line: index + 1 }
            }
        }
    }

    private lookup(hostname: string, rawKey: Buffer): boolean {
        let accepted = false
        const hostKey: NonNullable<ConnectionFailureDetails['hostKey']> = {
            keyType: (ssh2.utils.parseKey(rawKey) as ssh2.ParsedKey).type,
            fingerprint: `SHA256:${createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '')}`,
            knownKeys: [],
        }
        for (const { key, type, revoked, file, line } of this.matchingKeys(hostname)) {
            hostKey.knownKeys.push({
                keyType: type,
                fingerprint: `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`,
                file,
                line,
                revoked,
            })
            const matches = key.length === rawKey.length && timingSafeEqual(key, rawKey)
            if (revoked && matches) {
                throw new HostKeyError(
                    `Host key is revoked for ${hostname}: ${type} ${hostKey.fingerprint} at ${file}:${line}`,
                    { hostKey }
                )
            }
            if (!revoked && matches) {
                accepted = true
            }
        }
        if (hostKey.knownKeys.length && !accepted) {
            const stored = hostKey.knownKeys
                .map((entry) => `${entry.keyType} ${entry.fingerprint} at ${entry.file}:${entry.line}`)
                .join('; ')
            throw new HostKeyError(
                `Host key changed for ${hostname}; received ${hostKey.keyType} ${hostKey.fingerprint}; stored ${stored}; verify and update known_hosts before reconnecting`,
                { hostKey }
            )
        }
        return accepted
    }
}
