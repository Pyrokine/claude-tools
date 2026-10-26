import { spawn, type ChildProcess } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { PassThrough, Transform } from 'stream'
import type { CommandChannel, OpenSshMasterInfo, SSHConnectionConfig } from './types.js'
import { escapeShellArg, expandTilde } from './tools/utils.js'
import { validateConfigFile } from './security.js'

const CONFIG_OUTPUT_LIMIT = 512 * 1024
const CONTROL_OUTPUT_LIMIT = 16 * 1024

export class OpenSshError extends Error {
    constructor(
        message: string,
        readonly details: Record<string, unknown>
    ) {
        super(message)
        this.name = 'OpenSshError'
    }
}

function invalidConfig(message: string): never {
    throw new OpenSshError(message, { code: 'invalid_openssh_config', backend: 'openssh', retryable: false })
}

async function captureSsh(
    args: string[],
    timeout: number,
    maxBytes: number,
    signal?: AbortSignal,
    track?: (child: ChildProcess) => void
): Promise<{ stdout: string; stderr: string; status: number | null }> {
    return new Promise((resolve, reject) => {
        const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal })
        track?.(child)
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let bytes = 0
        let failure: Error | undefined
        const timer = setTimeout(() => {
            failure = new OpenSshError(`OpenSSH request timed out after ${timeout}ms`, {
                code: 'openssh_timeout',
                backend: 'openssh',
                timeout,
                operationStatus: 'unknown',
                retryable: false,
            })
            child.kill('SIGKILL')
        }, timeout)
        const collect =
            (chunks: Buffer[]) =>
            (chunk: Buffer): void => {
                bytes += chunk.length
                if (bytes > maxBytes) {
                    failure ??= new OpenSshError('OpenSSH response exceeded its output limit', {
                        code: 'openssh_output_limit',
                        backend: 'openssh',
                        maxBytes,
                        retryable: false,
                    })
                    child.kill('SIGKILL')
                } else {
                    chunks.push(chunk)
                }
            }
        child.stdout.on('data', collect(stdout))
        child.stderr.on('data', collect(stderr))
        child.once('error', (error) => {
            failure ??= error
        })
        child.once('close', (status) => {
            clearTimeout(timer)
            if (failure) reject(failure)
            else
                resolve({
                    stdout: Buffer.concat(stdout).toString('utf8'),
                    stderr: Buffer.concat(stderr).toString('utf8'),
                    status,
                })
        })
    })
}

export async function resolveOpenSshConfig(input: {
    configHost?: string
    configPath?: string
    host?: string
    username?: string
    port?: number
    controlPath?: string
    readyTimeout?: number
}): Promise<{ host: string; username: string; port: number; controlPath: string }> {
    if (process.platform === 'win32') {
        throw new OpenSshError('The OpenSSH master backend requires a local POSIX platform', {
            code: 'unsupported_backend',
            backend: 'openssh',
            capability: 'local_platform',
            retryable: false,
        })
    }
    const destination = input.configHost ?? input.host
    if (!destination || destination.startsWith('-') || /[\0\r\n]/.test(destination)) {
        invalidConfig('An OpenSSH host or configHost is required')
    }
    const args = ['-G', '-T', '-o', 'BatchMode=yes', '-o', 'PermitLocalCommand=no']
    if (input.configPath) {
        const configPath = path.resolve(expandTilde(input.configPath))
        validateConfigFile(configPath)
        args.push('-F', configPath)
    }
    if (input.configHost && input.host) args.push('-o', `HostName=${input.host}`)
    if (input.username) args.push('-l', input.username)
    if (input.port !== undefined) args.push('-p', String(input.port))
    if (input.controlPath) args.push('-S', path.resolve(expandTilde(input.controlPath)))
    args.push('--', destination)
    const result = await captureSsh(args, input.readyTimeout ?? 30_000, CONFIG_OUTPUT_LIMIT)
    if (result.status !== 0) invalidConfig(`OpenSSH configuration could not be resolved: ${result.stderr.trim()}`)
    const config = new Map<string, string>()
    for (const line of result.stdout.split('\n')) {
        const separator = line.indexOf(' ')
        if (separator > 0 && !config.has(line.slice(0, separator))) {
            config.set(line.slice(0, separator), line.slice(separator + 1))
        }
    }
    const host = config.get('hostname') ?? ''
    const username = config.get('user') ?? ''
    const port = Number(config.get('port'))
    const controlPath = config.get('controlpath')
    if (!host || host.startsWith('-') || /[\s\0]/.test(host) || !username || /[\s:@\0]/.test(username)) {
        invalidConfig('OpenSSH returned an invalid host or user')
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) invalidConfig('OpenSSH returned an invalid port')
    if (!controlPath || controlPath === 'none' || /[\0\r\n]/.test(controlPath)) {
        invalidConfig('OpenSSH requires an existing ControlPath; configure it or pass controlPath')
    }
    return { host, username, port, controlPath: path.resolve(expandTilde(controlPath)) }
}

class OpenSshChannel extends PassThrough implements CommandChannel {
    readonly stderr = new PassThrough()
    readonly ready: Promise<void>
    private child: ChildProcess
    private resolveReady!: () => void
    private rejectReady!: (error: Error) => void

    constructor(args: string[], command: string, track: (child: ChildProcess) => void) {
        super({ emitClose: false })
        this.ready = new Promise((resolve, reject) => {
            this.resolveReady = resolve
            this.rejectReady = reject
        })
        // 消费者可能在等待通道就绪前收到进程错误
        void this.ready.catch(() => undefined)
        const token = randomBytes(32).toString('hex')
        const prefix = Buffer.from(`\x1eMCPSSH:${token}:`)
        const script =
            `printf ${escapeShellArg(`\x1eMCPSSH:${token}:START\x1f`)} >&2; ` +
            `sh -c ${escapeShellArg(command)}; status=$?; ` +
            `printf ${escapeShellArg(`\x1eMCPSSH:${token}:END:%s\x1f`)} "$status" >&2; exit "$status"`
        this.child = spawn('ssh', [...args, script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        track(this.child)
        let pending = Buffer.alloc(0)
        let remoteExitCode: number | undefined
        let started = false
        const resolveReady = this.resolveReady
        const markers = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                pending = Buffer.concat([pending, chunk])
                while (pending.length > 0) {
                    const index = pending.indexOf(prefix)
                    if (index < 0) {
                        let retained = Math.min(pending.length, prefix.length - 1)
                        while (
                            retained > 0 &&
                            !pending.subarray(pending.length - retained).equals(prefix.subarray(0, retained))
                        )
                            --retained
                        const count = pending.length - retained
                        this.push(pending.subarray(0, count))
                        pending = pending.subarray(count)
                        break
                    }
                    if (index > 0) {
                        this.push(pending.subarray(0, index))
                        pending = pending.subarray(index)
                    }
                    const end = pending.indexOf(0x1f, prefix.length)
                    if (end < 0 && pending.length <= prefix.length + 16) break
                    if (end < 0 || end > prefix.length + 16) {
                        this.push(pending.subarray(0, 1))
                        pending = pending.subarray(1)
                        continue
                    }
                    const marker = pending.subarray(prefix.length, end).toString('ascii')
                    if (marker === 'START' && !started) {
                        started = true
                        resolveReady()
                    } else if (/^END:(?:0|[1-9]\d{0,2})$/.test(marker) && Number(marker.slice(4)) <= 255) {
                        remoteExitCode = Number(marker.slice(4))
                    } else {
                        this.push(pending.subarray(0, end + 1))
                    }
                    pending = pending.subarray(end + 1)
                }
                callback()
            },
            flush(callback) {
                this.push(pending)
                pending = Buffer.alloc(0)
                callback()
            },
        })
        this.child.stdout!.pipe(this, { end: false })
        this.child.stderr!.pipe(markers).pipe(this.stderr)
        this.child.once('error', (error) => {
            this.rejectReady(error)
            if (!this.destroyed) this.emit('error', error)
        })
        this.child.once('close', (code, signal) => {
            if (remoteExitCode === undefined) {
                const error = new OpenSshError(
                    'OpenSSH channel ended without a remote exit status; remote state is unknown',
                    {
                        code: 'openssh_transport_error',
                        backend: 'openssh',
                        operationStatus: 'unknown',
                        retryable: false,
                        exitCode: code,
                        signal,
                    }
                )
                this.rejectReady(error)
                if (!this.destroyed) this.emit('error', error)
            }
            this.end()
            this.emit('close', remoteExitCode ?? null, signal)
        })
    }

    close(): void {
        this.destroy()
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        this.rejectReady(error ?? new Error('OpenSSH channel was closed'))
        this.child.kill('SIGKILL')
        this.stderr.destroy()
        callback(error)
    }
}

export class OpenSshConnection {
    readonly info: OpenSshMasterInfo
    private readonly processes = new Map<ChildProcess, boolean>()
    private readonly socketIdentity: string
    private closed = false

    private constructor(
        readonly config: SSHConnectionConfig,
        socket: fs.Stats,
        pid: number
    ) {
        this.socketIdentity = `${socket.dev}:${socket.ino}`
        this.info = { backend: 'openssh', masterReused: true, identityStatus: 'master_trusted', masterPid: pid }
    }

    static async connect(config: SSHConnectionConfig, signal?: AbortSignal): Promise<OpenSshConnection> {
        if (
            process.platform === 'win32' ||
            config.remotePlatform === 'windows' ||
            config.commandShell === 'cmd' ||
            config.commandShell === 'powershell'
        ) {
            throw new OpenSshError('The OpenSSH master backend supports local and remote POSIX platforms', {
                code: 'unsupported_backend',
                backend: 'openssh',
                capability: 'platform',
                retryable: false,
            })
        }
        if (!config.controlPath) invalidConfig('OpenSSH requires a resolved controlPath')
        const socket = this.socket(config.controlPath)
        const args = this.arguments(config)
        const timeout = config.readyTimeout ?? 30_000
        const checked = await captureSsh(
            [...args.slice(0, -1), '-O', 'check', config.host],
            timeout,
            CONTROL_OUTPUT_LIMIT,
            signal
        )
        const pid = Number(/Master running \(pid=(\d+)\)/.exec(checked.stderr)?.[1])
        if (checked.status !== 0 || !Number.isSafeInteger(pid) || pid <= 0) {
            throw new OpenSshError(`OpenSSH master is unavailable: ${checked.stderr.trim()}`, {
                code: 'master_unavailable',
                backend: 'openssh',
                retryable: false,
            })
        }
        const connection = new OpenSshConnection(config, socket, pid)
        const abort = () => connection.close()
        signal?.addEventListener('abort', abort, { once: true })
        try {
            if (signal?.aborted) throw signal.reason
            const marker = randomBytes(32).toString('hex')
            const command = `printf ${escapeShellArg(`${marker}\\n`)}; id -u; id -un; printf '%s\\n' "$SSH_CONNECTION"`
            const observed = await captureSsh(
                [...args, command],
                timeout,
                CONTROL_OUTPUT_LIMIT,
                signal,
                connection.trackProcess
            )
            const start = observed.stdout.lastIndexOf(`${marker}\n`)
            const lines = observed.stdout.slice(start + marker.length + 1).split('\n')
            if (observed.status !== 0 || start < 0 || !/^\d+$/.test(lines[0]) || !lines[1]) {
                throw new OpenSshError('The existing OpenSSH master did not provide its login identity', {
                    code: 'master_identity_unavailable',
                    backend: 'openssh',
                    retryable: false,
                })
            }
            if (lines[1] !== config.username) {
                throw new OpenSshError('The existing master login does not match the requested user', {
                    code: 'master_identity_mismatch',
                    backend: 'openssh',
                    requestedUser: config.username,
                    observedUser: lines[1],
                    retryable: false,
                })
            }
            connection.info.observedLogin = {
                uid: Number(lines[0]),
                username: lines[1],
                sshConnection: lines[2] || undefined,
            }
            connection.assertCurrent()
            return connection
        } catch (error) {
            connection.close()
            throw error
        } finally {
            signal?.removeEventListener('abort', abort)
        }
    }

    private static socket(controlPath: string): fs.Stats {
        let socket: fs.Stats
        try {
            socket = fs.statSync(controlPath)
        } catch {
            throw new OpenSshError('The existing OpenSSH control socket is unavailable', {
                code: 'master_unavailable',
                backend: 'openssh',
                retryable: false,
            })
        }
        if (!socket.isSocket() || socket.uid !== process.getuid?.()) {
            throw new OpenSshError('ControlPath must refer to a socket owned by the current user', {
                code: 'invalid_control_socket',
                backend: 'openssh',
                retryable: false,
            })
        }
        return socket
    }

    private static arguments(config: SSHConnectionConfig): string[] {
        return [
            '-F',
            '/dev/null',
            '-S',
            config.controlPath!,
            '-T',
            '-o',
            'ControlMaster=no',
            '-o',
            'BatchMode=yes',
            '-o',
            'ProxyCommand=/bin/false',
            '-o',
            'ProxyUseFdpass=no',
            '-o',
            'PermitLocalCommand=no',
            '-o',
            'ClearAllForwardings=yes',
            '-p',
            String(config.port),
            '-l',
            config.username,
            config.host,
        ]
    }

    arguments(): string[] {
        this.assertCurrent()
        return OpenSshConnection.arguments(this.config)
    }

    assertCurrent(): void {
        const socket = OpenSshConnection.socket(this.config.controlPath!)
        if (this.closed || `${socket.dev}:${socket.ino}` !== this.socketIdentity) {
            throw new OpenSshError('The OpenSSH master socket changed; reconnect the alias to bind it again', {
                code: 'master_changed',
                backend: 'openssh',
                retryable: false,
            })
        }
    }

    isAlive(): boolean {
        try {
            this.assertCurrent()
            process.kill(this.info.masterPid, 0)
            return true
        } catch {
            return false
        }
    }

    readonly trackProcess = (child: ChildProcess, processGroup: boolean = false): void => {
        this.processes.set(child, processGroup)
        child.once('close', () => this.processes.delete(child))
        if (this.closed) this.close()
    }

    open(command: string): CommandChannel & { ready: Promise<void> } {
        return new OpenSshChannel(this.arguments(), command, this.trackProcess)
    }

    consume(command: string, consume: (chunk: Buffer) => void, timeout: number): Promise<void> {
        const stream = this.open(command)
        return new Promise((resolve, reject) => {
            let settled = false
            let stderr = Buffer.alloc(0)
            const finish = (error?: Error): void => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                if (error) {
                    stream.destroy()
                    reject(error)
                } else resolve()
            }
            const timer = setTimeout(
                () =>
                    finish(
                        new OpenSshError(`OpenSSH command timed out after ${timeout}ms`, {
                            code: 'openssh_timeout',
                            backend: 'openssh',
                            operationStatus: 'unknown',
                            timeout,
                            retryable: false,
                        })
                    ),
                timeout
            )
            stream.on('data', (chunk: Buffer) => {
                if (settled) return
                try {
                    consume(chunk)
                } catch (error) {
                    finish(error instanceof Error ? error : new Error(String(error)))
                }
            })
            stream.stderr.on('data', (chunk: Buffer) => {
                stderr = Buffer.concat([stderr, chunk.subarray(0, Math.max(0, 4096 - stderr.length))])
            })
            stream.on('error', finish)
            stream.on('close', (code: number | null) =>
                finish(
                    code === 0
                        ? undefined
                        : new OpenSshError(
                              `OpenSSH remote command failed: ${stderr.toString('utf8').trim() || `exit ${code}`}`,
                              {
                                  code: 'remote_command',
                                  backend: 'openssh',
                                  exitCode: code,
                                  stderr: stderr.toString('utf8'),
                                  retryable: false,
                              }
                          )
                )
            )
        })
    }

    async capture(command: string, timeout: number, maxBytes: number): Promise<Buffer> {
        const chunks: Buffer[] = []
        let size = 0
        await this.consume(
            command,
            (chunk) => {
                size += chunk.length
                if (size > maxBytes)
                    throw new OpenSshError('OpenSSH command exceeded its output budget', {
                        code: 'openssh_output_limit',
                        backend: 'openssh',
                        maxBytes,
                        retryable: false,
                    })
                chunks.push(chunk)
            },
            timeout
        )
        return Buffer.concat(chunks)
    }

    async stat(remotePath: string, timeout: number, follow: boolean = true) {
        const format = '%f\\0%s\\0%u\\0%g\\0%Y\\0%X\\0%d:%i:%s:%y:%z\\0'
        const bytes = await this.capture(
            `LC_ALL=C stat ${follow ? '-L ' : ''}--printf=${escapeShellArg(format)} -- ${escapeShellArg(remotePath)}`,
            timeout,
            4096
        )
        const fields = bytes.toString('utf8').split('\0')
        const values = [Number.parseInt(fields[0], 16), ...fields.slice(1, 6).map(Number)]
        if (fields.length !== 8 || !values.every(Number.isSafeInteger) || values[1] < 0) {
            throw new OpenSshError('OpenSSH stat returned invalid metadata', {
                code: 'invalid_remote_metadata',
                backend: 'openssh',
                retryable: false,
            })
        }
        return {
            mode: values[0],
            size: values[1],
            uid: values[2],
            gid: values[3],
            mtime: values[4],
            atime: values[5],
            stamp: fields[6],
        }
    }

    async hashFile(
        remotePath: string,
        algorithm: 'md5' | 'sha256',
        timeout: number,
        maxBytes?: number,
        expectedSize?: number
    ): Promise<string> {
        const deadline = Date.now() + timeout
        const remaining = (): number => {
            const value = deadline - Date.now()
            if (value <= 0)
                throw new OpenSshError('OpenSSH file verification exhausted its timeout', {
                    code: 'openssh_timeout',
                    backend: 'openssh',
                    operationStatus: 'unknown',
                    retryable: false,
                })
            return value
        }
        const before = await this.stat(remotePath, remaining())
        if ((before.mode & 0o170000) !== 0o100000) throw new Error('File hashing requires a regular remote file')
        if (
            (maxBytes !== undefined && before.size > maxBytes) ||
            (expectedSize !== undefined && before.size !== expectedSize)
        ) {
            throw new Error('Remote file size changed or exceeds the verification byte budget')
        }
        const hash = createHash(algorithm)
        let size = 0
        await this.consume(
            `head -c ${before.size + 1} -- ${escapeShellArg(remotePath)}`,
            (chunk) => {
                size += chunk.length
                if (size > before.size) throw new Error('Remote file grew during verification')
                hash.update(chunk)
            },
            remaining()
        )
        const after = await this.stat(remotePath, remaining())
        if (size !== before.size || before.stamp !== after.stamp)
            throw new Error('Remote file changed during verification')
        return hash.digest('hex')
    }

    close(): void {
        this.closed = true
        for (const [child, processGroup] of this.processes) {
            if (processGroup && child.pid) {
                try {
                    process.kill(-child.pid, 'SIGKILL')
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
                        console.error('OpenSSH process cleanup failed:', error)
                }
            } else child.kill('SIGKILL')
        }
    }
}
