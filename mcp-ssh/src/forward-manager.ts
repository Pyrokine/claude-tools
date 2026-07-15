/**
 * 端口转发管理器
 *
 * 负责本地/远程端口转发的完整生命周期
 */

import * as net from 'net'
import type { Client, ClientChannel } from 'ssh2'
import type { ForwardCloseOptions, ForwardCloseResult, PortForwardInfo } from './types.js'

/** 端口转发所需的外部依赖 */
export interface ForwardDependencies {
    /** 获取 SSH client */
    getClient(alias: string): Client
}

interface ForwardSession {
    id: string
    alias: string
    type: 'local' | 'remote'
    localHost: string
    localPort: number
    remoteHost: string
    remotePort: number
    server?: net.Server
    createdAt: number
    active: boolean
    /** 当前活跃 socket 数（仅 local forward 跟踪） */
    activeConnections: number
    /** 上次有连接活动的时间 */
    lastActivityAt: number
    connections: Set<{ destroy(): void }>
    listenerReleased: boolean
    remoteUnforwarded: boolean
    closePromise?: Promise<void>
}

// tcp connection 事件处理函数类型
type TcpConnectionHandler = (
    info: { destIP: string; destPort: number; srcIP: string; srcPort: number },
    accept: () => ClientChannel,
    reject: () => void
) => void

/** 每个 SSH session 的 dispatcher 状态 */
interface DispatcherState {
    handler: TcpConnectionHandler
    client: Client
}

export class ForwardManager {
    private sessions: Map<string, ForwardSession> = new Map()
    private dispatchers: Map<string, DispatcherState> = new Map() // alias → dispatcher
    private dependencies: ForwardDependencies | null = null
    private idCounter = 0
    // 默认 idle timeout 1 小时,长时间无连接活动的 forward 自动关闭
    private readonly idleTimeoutMs = Number(process.env.SSH_MCP_FORWARD_IDLE_TIMEOUT_MS) || 3600_000
    private idleSweeper: NodeJS.Timeout | null = null

    constructor() {
        this.startIdleSweeper()
    }

    async forwardLocal(
        deps: ForwardDependencies,
        alias: string,
        localPort: number,
        remoteHost: string,
        remotePort: number,
        localHost: string = '127.0.0.1'
    ): Promise<{ forwardId: string; localPort: number }> {
        this.dependencies = deps
        const client = deps.getClient(alias)
        const forwardId = this.generateId()

        return new Promise((resolve, reject) => {
            const fwdState: { ref: ForwardSession | null } = { ref: null }
            const server = net.createServer((socket) => {
                const fwd = fwdState.ref
                if (fwd) {
                    fwd.activeConnections += 1
                    fwd.lastActivityAt = Date.now()
                }
                if (fwd) {
                    fwd.connections.add(socket)
                }
                const onClose = () => {
                    if (fwd) {
                        fwd.connections.delete(socket)
                        fwd.activeConnections = Math.max(0, fwd.activeConnections - 1)
                        fwd.lastActivityAt = Date.now()
                    }
                }
                socket.once('close', onClose)
                client.forwardOut(
                    socket.remoteAddress || '127.0.0.1',
                    socket.remotePort || 0,
                    remoteHost,
                    remotePort,
                    (err, stream) => {
                        if (err) {
                            socket.end()
                            return
                        }
                        socket.pipe(stream).pipe(socket)
                    }
                )
            })

            server.on('error', (err) => {
                reject(new Error(`Local forward failed: ${err.message}`))
            })

            server.listen(localPort, localHost, () => {
                const addr = server.address()
                const actualPort =
                    addr && typeof addr === 'object' && typeof addr.port === 'number' ? addr.port : localPort
                const session: ForwardSession = {
                    id: forwardId,
                    alias,
                    type: 'local',
                    localHost,
                    localPort: actualPort,
                    remoteHost,
                    remotePort,
                    server,
                    createdAt: Date.now(),
                    active: true,
                    activeConnections: 0,
                    lastActivityAt: Date.now(),
                    connections: new Set(),
                    listenerReleased: false,
                    remoteUnforwarded: false,
                }
                this.sessions.set(forwardId, session)
                fwdState.ref = session
                resolve({ forwardId, localPort: actualPort })
            })
        })
    }

    async forwardRemote(
        deps: ForwardDependencies,
        alias: string,
        remotePort: number,
        localHost: string,
        localPort: number,
        remoteHost: string = '127.0.0.1'
    ): Promise<string> {
        this.dependencies = deps
        const client = deps.getClient(alias)
        const forwardId = this.generateId()

        return new Promise((resolve, reject) => {
            client.forwardIn(remoteHost, remotePort, (err) => {
                if (err) {
                    reject(new Error(`Remote forward failed: ${err.message}`))
                    return
                }

                this.sessions.set(forwardId, {
                    id: forwardId,
                    alias,
                    type: 'remote',
                    localHost,
                    localPort,
                    remoteHost,
                    remotePort,
                    createdAt: Date.now(),
                    active: true,
                    activeConnections: 0,
                    lastActivityAt: Date.now(),
                    connections: new Set(),
                    listenerReleased: false,
                    remoteUnforwarded: false,
                })

                this.ensureTcpDispatcher(alias, client)
                resolve(forwardId)
            })
        })
    }

    async close(
        forwardId: string,
        deps?: ForwardDependencies,
        options: ForwardCloseOptions = {}
    ): Promise<ForwardCloseResult> {
        const mode = options.mode ?? 'graceful'
        const timeoutMs = options.timeoutMs ?? 5000
        const fwd = this.sessions.get(forwardId)
        if (!fwd) {
            return {
                success: false,
                forwardId,
                closeMode: mode,
                listenerReleased: false,
                remoteUnforwarded: false,
                activeConnections: 0,
                retryable: false,
                error: 'Forward not found',
            }
        }

        if (mode === 'force') {
            for (const connection of fwd.connections) {
                connection.destroy()
            }
        }

        try {
            if (!fwd.closePromise) {
                fwd.closePromise =
                    fwd.type === 'local' ? this.closeLocalListener(fwd) : this.closeRemoteListener(fwd, deps)
                fwd.closePromise.catch(() => {
                    fwd.closePromise = undefined
                })
            }
            await this.withTimeout(fwd.closePromise, timeoutMs)
            fwd.active = false
            this.sessions.delete(forwardId)
            if (fwd.type === 'remote') {
                this.removeTcpDispatcherIfEmpty(fwd.alias)
            }
            return {
                success: true,
                forwardId,
                type: fwd.type,
                closeMode: mode,
                listenerReleased: fwd.listenerReleased,
                remoteUnforwarded: fwd.remoteUnforwarded,
                activeConnections: fwd.activeConnections,
                retryable: false,
            }
        } catch (error) {
            return {
                success: false,
                forwardId,
                type: fwd.type,
                closeMode: mode,
                listenerReleased: fwd.listenerReleased,
                remoteUnforwarded: fwd.remoteUnforwarded,
                activeConnections: fwd.activeConnections,
                retryable: true,
                error: error instanceof Error ? error.message : String(error),
            }
        }
    }

    /** 关闭指定 alias 的所有转发（disconnect 时调用，不需要 unforwardIn） */
    closeByAlias(alias: string): void {
        for (const [id, fwd] of this.sessions) {
            if (fwd.alias === alias) {
                fwd.active = false
                for (const connection of fwd.connections) {
                    connection.destroy()
                }
                if (fwd.type === 'local' && fwd.server) {
                    try {
                        fwd.server.close()
                        fwd.listenerReleased = !fwd.server.listening
                    } catch (e) {
                        console.warn(`Forward ${id} server close failed:`, (e as Error).message)
                    }
                }
                this.sessions.delete(id)
            }
        }
        // 清理该 alias 的 dispatcher
        const state = this.dispatchers.get(alias)
        if (state) {
            try {
                state.client.removeListener('tcp connection', state.handler)
            } catch {
                /* client 可能已关闭 */
            }
            this.dispatchers.delete(alias)
        }
    }

    list(): PortForwardInfo[] {
        const result: PortForwardInfo[] = []
        for (const [id, fwd] of this.sessions) {
            result.push({
                id,
                alias: fwd.alias,
                type: fwd.type,
                localHost: fwd.localHost,
                localPort: fwd.localPort,
                remoteHost: fwd.remoteHost,
                remotePort: fwd.remotePort,
                createdAt: fwd.createdAt,
                active: fwd.active,
            })
        }
        return result
    }

    private closeLocalListener(fwd: ForwardSession): Promise<void> {
        const server = fwd.server
        if (!server) {
            return Promise.reject(new Error('Local forward listener is unavailable'))
        }
        return new Promise((resolve, reject) => {
            try {
                server.close((error) => {
                    if (error) {
                        reject(error)
                    } else {
                        resolve()
                    }
                })
                fwd.listenerReleased = !server.listening
            } catch (error) {
                fwd.listenerReleased = !server.listening
                reject(error)
            }
        })
    }

    private closeRemoteListener(fwd: ForwardSession, deps?: ForwardDependencies): Promise<void> {
        if (!deps) {
            return Promise.reject(new Error('SSH session is unavailable for remote unforward'))
        }
        return new Promise((resolve, reject) => {
            let client: Client
            try {
                client = deps.getClient(fwd.alias)
            } catch (error) {
                reject(error)
                return
            }
            client.unforwardIn(fwd.remoteHost, fwd.remotePort, (error) => {
                if (error) {
                    reject(error)
                } else {
                    fwd.remoteUnforwarded = true
                    resolve()
                }
            })
        })
    }

    private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Forward close timed out after ${timeoutMs}ms`)), timeoutMs)
            promise.then(
                (value) => {
                    clearTimeout(timer)
                    resolve(value)
                },
                (error) => {
                    clearTimeout(timer)
                    reject(error)
                }
            )
        })
    }

    private startIdleSweeper(): void {
        if (this.idleSweeper) {
            return
        }
        this.idleSweeper = setInterval(() => this.sweepIdle(), 5 * 60_000)
        if (typeof this.idleSweeper.unref === 'function') {
            this.idleSweeper.unref()
        }
    }

    private sweepIdle(): void {
        const now = Date.now()
        for (const [id, fwd] of this.sessions) {
            if (!fwd.active) {
                continue
            }
            if (fwd.activeConnections === 0 && now - fwd.lastActivityAt > this.idleTimeoutMs) {
                console.warn(
                    `[mcp-ssh] Forward ${id} (${fwd.type}, alias=${fwd.alias}) idle ${Math.round(
                        (now - fwd.lastActivityAt) / 1000
                    )}s with 0 connections > ${Math.round(this.idleTimeoutMs / 1000)}s, auto-closing`
                )
                void this.close(id, this.dependencies ?? undefined).then((result) => {
                    if (!result.success) {
                        console.warn(`[mcp-ssh] Forward ${id} auto-close failed: ${result.error}`)
                    }
                })
            }
        }
    }

    /**
     * 确保 SSH session 有共享的 tcp connection dispatcher
     * 所有 remote forward 共用一个 dispatcher，根据 destIP/destPort 路由
     */
    private ensureTcpDispatcher(alias: string, client: Client): void {
        if (this.dispatchers.has(alias)) {
            return
        }

        const handler: TcpConnectionHandler = (info, accept, rejectConn) => {
            for (const fwd of this.sessions.values()) {
                if (
                    fwd.type === 'remote' &&
                    fwd.active &&
                    fwd.alias === alias &&
                    fwd.remoteHost === info.destIP &&
                    fwd.remotePort === info.destPort
                ) {
                    const stream = accept()
                    const socket = net.createConnection(fwd.localPort, fwd.localHost)
                    fwd.connections.add(stream)
                    fwd.connections.add(socket)
                    fwd.activeConnections += 1
                    fwd.lastActivityAt = Date.now()
                    let closed = false
                    const onClose = () => {
                        if (closed) {
                            return
                        }
                        closed = true
                        fwd.connections.delete(stream)
                        fwd.connections.delete(socket)
                        fwd.activeConnections = Math.max(0, fwd.activeConnections - 1)
                        fwd.lastActivityAt = Date.now()
                    }
                    socket.pipe(stream).pipe(socket)
                    socket.on('error', () => stream.close())
                    socket.once('close', onClose)
                    stream.on('error', () => socket.destroy())
                    stream.once('close', onClose)
                    return
                }
            }
            rejectConn()
        }

        this.dispatchers.set(alias, { handler, client })
        client.on('tcp connection', handler)
    }

    /**
     * 移除 dispatcher（当没有活跃的 remote forward 时）
     */
    private removeTcpDispatcherIfEmpty(alias: string): void {
        const state = this.dispatchers.get(alias)
        if (!state) {
            return
        }

        for (const fwd of this.sessions.values()) {
            if (fwd.type === 'remote' && fwd.alias === alias && fwd.active) {
                return // 还有活跃的 remote forward
            }
        }

        state.client.removeListener('tcp connection', state.handler)
        this.dispatchers.delete(alias)
    }

    private generateId(): string {
        return `fwd_${++this.idCounter}_${Date.now()}`
    }
}
