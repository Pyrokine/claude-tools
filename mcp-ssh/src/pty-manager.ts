/**
 * PTY 会话管理器
 *
 * 负责 PTY 会话的完整生命周期：创建、读写、调整大小、关闭
 */

import xterm from '@xterm/headless'
import type {ClientChannel} from 'ssh2'
import type {PtyOptions, PtySessionInfo} from './types.js'

const Terminal = xterm.Terminal as typeof import('@xterm/headless').Terminal
type TerminalType = import('@xterm/headless').Terminal;

/** PTY 创建所需的外部依赖 */
export interface PtyDependencies {
    /** 通过 alias 获取 SSH client 并执行命令 */
    execPty(alias: string, command: string, options: PtyOptions): Promise<ClientChannel>;
}

interface PtySession {
    id: string;
    alias: string;
    command: string;
    stream: ClientChannel;
    terminal: TerminalType;
    rows: number;
    cols: number;
    createdAt: number;
    lastReadAt: number;
    rawBuffer: string;
    maxBufferSize: number;
    active: boolean;
}

export class PtyManager {
    private sessions: Map<string, PtySession> = new Map()
    private idCounter                         = 0
    private readonly defaultBufferSize        = 1024 * 1024  // 1MB

    async start(
        deps: PtyDependencies,
        alias: string,
        command: string,
        options: PtyOptions = {},
    ): Promise<string> {
        const ptyId         = this.generateId()
        const rows          = options.rows || 24
        const cols          = options.cols || 80
        const maxBufferSize = options.bufferSize || this.defaultBufferSize

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
            lastReadAt: Date.now(),
            rawBuffer: '',
            maxBufferSize,
            active: true,
        }

        // 监听输出数据
        stream.on('data', (data: Buffer) => {
            if (!ptySession.active) {
                return
            }
            const chunk = data.toString('utf-8')
            // 写入终端仿真器（解析 ANSI 序列）
            terminal.write(chunk)
            // 同时保留原始流（用于 raw 模式）
            ptySession.rawBuffer += chunk
            if (ptySession.rawBuffer.length > maxBufferSize) {
                ptySession.rawBuffer = ptySession.rawBuffer.slice(-maxBufferSize)
            }
        })

        stream.on('close', () => {
            ptySession.active = false
        })

        stream.on('error', (err: Error) => {
            ptySession.active = false
            terminal.write(`\n[PTY Error: ${err.message}]`)
        })

        this.sessions.set(ptyId, ptySession)
        return ptyId
    }

    write(ptyId: string, data: string): boolean {
        const session = this.getSession(ptyId)
        if (!session.active) {
            throw new Error(`PTY session '${ptyId}' is closed`)
        }
        return session.stream.write(data)
    }

    read(
        ptyId: string,
        options: { mode?: 'screen' | 'raw'; clear?: boolean } = {},
    ): { data: string; active: boolean; rows: number; cols: number } {
        const session = this.getSession(ptyId)
        const mode    = options.mode || 'screen'
        const clear   = options.clear !== false

        let data: string
        if (mode === 'screen') {
            data = this.getScreenContent(session.terminal)
        } else {
            data = session.rawBuffer
            if (clear) {
                session.rawBuffer = ''
            }
        }

        session.lastReadAt = Date.now()
        return {
            data,
            active: session.active,
            rows: session.rows,
            cols: session.cols,
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

    close(ptyId: string): boolean {
        const session = this.sessions.get(ptyId)
        if (!session) {
            return false
        }
        try {
            session.stream.close()
        } catch (e) {
            console.warn(`PTY ${ptyId} stream close failed:`, (e as Error).message)
        }
        try {
            session.terminal.dispose()
        } catch (e) {
            console.warn(`PTY ${ptyId} terminal dispose failed:`, (e as Error).message)
        }
        session.active = false
        this.sessions.delete(ptyId)
        return true
    }

    /** 关闭指定 alias 的所有 PTY 会话 */
    closeByAlias(alias: string): void {
        for (const [id, session] of this.sessions) {
            if (session.alias === alias) {
                this.close(id)
            }
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
                            lastReadAt: pty.lastReadAt,
                            bufferSize: pty.rawBuffer.length,
                            active: pty.active,
                        })
        }
        return result
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
        const buffer          = terminal.buffer.active
        const lines: string[] = []
        for (let i = 0; i < terminal.rows; i++) {
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
