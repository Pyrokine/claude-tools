/**
 * PTY 会话管理器
 *
 * 负责 PTY 会话的完整生命周期：创建、读写、调整大小、关闭
 */

import xterm from '@xterm/headless'
import type { ClientChannel } from 'ssh2'
import { StringDecoder } from 'string_decoder'
import type { PtyCloseResult, PtyOptions, PtyReadResult, PtySessionInfo, PtyWriteResult } from './types.js'

const Terminal = xterm.Terminal as typeof import('@xterm/headless').Terminal
type TerminalType = import('@xterm/headless').Terminal

export const HARD_PTY_BUFFER_SIZE = 16 * 1024 * 1024

/** PTY 创建所需的外部依赖 */
export interface PtyDependencies {
    /** 通过 alias 获取 SSH client 并执行命令 */
    execPty(alias: string, command: string, options: PtyOptions): Promise<ClientChannel>
}

interface PtySession {
    id: string
    alias: string
    command: string
    stream: ClientChannel
    terminal: TerminalType
    rows: number
    cols: number
    createdAt: number
    lastInputAt: number | null
    lastOutputAt: number | null
    lastReadAt: number
    rawBuffer: Buffer
    unreadRawBytes: number
    rawBufferTruncated: boolean
    maxBufferSize: number
    decoder: StringDecoder
    decoderEnded: boolean
    active: boolean
    closedAt: number | null
}

export class PtyManager {
    private sessions: Map<string, PtySession> = new Map()
    private idCounter = 0
    private readonly defaultBufferSize = 1024 * 1024 // 1MB
    // 默认 idle timeout 1 小时,超时未读的 pty 自动回收
    private readonly idleTimeoutMs = Number(process.env.SSH_MCP_PTY_IDLE_TIMEOUT_MS) || 3600_000
    private readonly closedRetentionMs = Number(process.env.SSH_MCP_PTY_CLOSED_RETENTION_MS) || 300_000
    private idleSweeper: NodeJS.Timeout | null = null

    constructor() {
        this.startIdleSweeper()
    }

    async start(deps: PtyDependencies, alias: string, command: string, options: PtyOptions = {}): Promise<string> {
        const ptyId = this.generateId()
        const rows = options.rows ?? 24
        const cols = options.cols ?? 80
        const maxBufferSize = this.normalizeBufferSize(options.bufferSize)

        const stream = await deps.execPty(alias, command, options)

        // 创建 xterm headless 终端仿真器
        const terminal = new Terminal({ rows, cols, allowProposedApi: true })

        const ptySession: PtySession = {
            id: ptyId,
            alias,
            command,
            stream,
            terminal,
            rows,
            cols,
            createdAt: Date.now(),
            lastInputAt: null,
            lastOutputAt: null,
            lastReadAt: Date.now(),
            rawBuffer: Buffer.alloc(0),
            unreadRawBytes: 0,
            rawBufferTruncated: false,
            maxBufferSize,
            decoder: new StringDecoder('utf8'),
            decoderEnded: false,
            active: true,
            closedAt: null,
        }

        // 监听输出数据
        stream.on('data', (data: Buffer) => {
            if (!ptySession.active || ptySession.decoderEnded) {
                return
            }
            ptySession.lastOutputAt = Date.now()
            this.appendRaw(ptySession, data)
            this.appendOutput(ptySession, ptySession.decoder.write(data))
        })

        stream.on('close', () => {
            if (!this.sessions.has(ptyId)) {
                return
            }
            this.endDecoder(ptySession)
            ptySession.active = false
            ptySession.closedAt = Date.now()
        })

        stream.on('error', (err: Error) => {
            if (!this.sessions.has(ptyId)) {
                return
            }
            this.endDecoder(ptySession)
            ptySession.active = false
            ptySession.closedAt = Date.now()
            terminal.write(`\n[PTY Error: ${err.message}]`)
        })

        this.sessions.set(ptyId, ptySession)
        return ptyId
    }

    write(ptyId: string, data: string): PtyWriteResult {
        const session = this.getSession(ptyId)
        if (!session.active) {
            throw new Error(`PTY session '${ptyId}' is closed`)
        }
        session.lastInputAt = Date.now()
        return {
            accepted: true,
            backpressured: !session.stream.write(data),
        }
    }

    read(ptyId: string, options: { mode?: 'screen' | 'raw'; clear?: boolean } = {}): PtyReadResult {
        const session = this.getSession(ptyId)
        const mode = options.mode ?? 'screen'
        const clear = options.clear !== false
        const unreadRawBytes = session.unreadRawBytes
        const rawBufferTruncated = session.rawBufferTruncated

        let data: string
        let dataBase64: string | undefined
        if (mode === 'screen') {
            data = this.getScreenContent(session.terminal)
        } else {
            data = session.rawBuffer.toString('utf8')
            dataBase64 = session.rawBuffer.toString('base64')
            if (clear) {
                session.rawBuffer = Buffer.alloc(0)
                session.unreadRawBytes = 0
                session.rawBufferTruncated = false
            }
        }

        session.lastReadAt = Date.now()
        return {
            data,
            dataBase64,
            active: session.active,
            rows: session.rows,
            cols: session.cols,
            lastInputAt: session.lastInputAt,
            lastOutputAt: session.lastOutputAt,
            lastReadAt: session.lastReadAt,
            unreadRawBytes,
            rawBufferLimit: session.maxBufferSize,
            rawBufferTruncated,
            foregroundProcess: session.command,
        }
    }

    resize(ptyId: string, rows: number, cols: number): boolean {
        const session = this.getSession(ptyId)
        if (!session.active) {
            throw new Error(`PTY session '${ptyId}' is closed`)
        }
        session.stream.setWindow(rows, cols, 0, 0)
        session.terminal.resize(cols, rows)
        session.rows = rows
        session.cols = cols
        return true
    }

    close(ptyId: string): PtyCloseResult {
        const session = this.sessions.get(ptyId)
        if (!session) {
            return {
                success: false,
                ptyId,
                status: 'not_found',
                retryable: false,
            }
        }

        if (session.active) {
            try {
                session.stream.close()
            } catch (error) {
                return {
                    success: false,
                    ptyId,
                    status: 'failed',
                    retryable: true,
                    error: error instanceof Error ? error.message : String(error),
                }
            }
        }
        this.endDecoder(session)

        try {
            session.terminal.dispose()
        } catch (error) {
            return {
                success: false,
                ptyId,
                status: session.active ? 'unknown' : 'failed',
                retryable: true,
                error: error instanceof Error ? error.message : String(error),
            }
        }
        session.active = false
        this.sessions.delete(ptyId)
        return {
            success: true,
            ptyId,
            status: 'closed',
            retryable: false,
        }
    }

    /** 关闭指定 alias 的所有 PTY 会话 */
    closeByAlias(alias: string): void {
        for (const [id, session] of this.sessions) {
            if (session.alias !== alias) {
                continue
            }
            const result = this.close(id)
            if (result.success) {
                continue
            }
            try {
                session.stream.destroy()
            } catch {
                // SSH 连接已失效，继续释放本地状态
            }
            this.endDecoder(session)
            try {
                session.terminal.dispose()
            } catch {
                // SSH 连接已失效，继续释放本地状态
            }
            session.active = false
            this.sessions.delete(id)
            console.warn(`PTY ${id} 在 SSH 连接失效时强制清理: ${result.status}`)
        }
    }

    list(): PtySessionInfo[] {
        const result: PtySessionInfo[] = []
        for (const [id, pty] of this.sessions) {
            result.push({
                id,
                alias: pty.alias,
                command: pty.command,
                rows: pty.rows,
                cols: pty.cols,
                createdAt: pty.createdAt,
                lastInputAt: pty.lastInputAt,
                lastOutputAt: pty.lastOutputAt,
                lastReadAt: pty.lastReadAt,
                bufferSize: pty.rawBuffer.length,
                unreadRawBytes: pty.unreadRawBytes,
                rawBufferLimit: pty.maxBufferSize,
                rawBufferTruncated: pty.rawBufferTruncated,
                foregroundProcess: pty.command,
                active: pty.active,
            })
        }
        return result
    }

    private appendOutput(session: PtySession, output: string): void {
        if (output.length === 0) {
            return
        }
        session.terminal.write(output)
    }

    private appendRaw(session: PtySession, data: Buffer): void {
        const appended = Buffer.concat([session.rawBuffer, data])
        if (appended.length > session.maxBufferSize) {
            session.rawBufferTruncated = true
        }
        session.rawBuffer = appended.subarray(Math.max(0, appended.length - session.maxBufferSize))
        session.unreadRawBytes = session.rawBuffer.length
    }

    private endDecoder(session: PtySession): void {
        if (session.decoderEnded) {
            return
        }
        session.decoderEnded = true
        this.appendOutput(session, session.decoder.end())
    }

    private normalizeBufferSize(bufferSize?: number): number {
        if (bufferSize === undefined) {
            return this.defaultBufferSize
        }
        if (!Number.isSafeInteger(bufferSize) || bufferSize <= 0 || bufferSize > HARD_PTY_BUFFER_SIZE) {
            throw new Error(`bufferSize 必须是 1 到 ${HARD_PTY_BUFFER_SIZE} 之间的整数`)
        }
        return bufferSize
    }

    private startIdleSweeper(): void {
        if (this.idleSweeper) {
            return
        }
        // 每 5 分钟扫一次,关闭超过 idleTimeout 未读的 pty
        this.idleSweeper = setInterval(() => this.sweepIdle(), 5 * 60_000)
        if (typeof this.idleSweeper.unref === 'function') {
            this.idleSweeper.unref()
        }
    }

    private sweepIdle(): void {
        const now = Date.now()
        for (const [id, session] of this.sessions) {
            if (!session.active) {
                const closedAt = session.closedAt ?? session.lastOutputAt ?? session.createdAt
                if (now - Math.max(closedAt, session.lastReadAt) > this.closedRetentionMs) {
                    this.close(id)
                }
                continue
            }
            if (now - session.lastReadAt > this.idleTimeoutMs) {
                console.warn(
                    `[mcp-ssh] PTY ${id} (alias=${session.alias}, command=${session.command}) idle ${Math.round(
                        (now - session.lastReadAt) / 1000
                    )}s > ${Math.round(this.idleTimeoutMs / 1000)}s, auto-closing`
                )
                this.close(id)
            }
        }
    }

    private getSession(ptyId: string): PtySession {
        const session = this.sessions.get(ptyId)
        if (!session) {
            throw new Error(`PTY session '${ptyId}' not found`)
        }
        return session
    }

    private generateId(): string {
        return `pty_${++this.idCounter}_${Date.now()}`
    }

    /** 从终端仿真器获取当前屏幕内容 */
    private getScreenContent(terminal: TerminalType): string {
        const buffer = terminal.buffer.active
        const start = buffer.viewportY
        const end = start + terminal.rows
        const lines: string[] = []
        for (let i = start; i < end; i++) {
            const line = buffer.getLine(i)
            if (line) {
                lines.push(line.translateToString(true))
            }
        }
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
            lines.pop()
        }
        return lines.join('\n')
    }
}
