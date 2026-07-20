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

type ForwardLifecycle = 'pending' | 'active' | 'closing' | 'closed'

const MAX_PENDING_CHANNEL_OPENS_PER_ALIAS = 32

interface ForwardSession {
    id: string
    alias: string
    type: 'local' | 'remote'
    localHost: string
    localPort: number
    remoteHost: string
    remotePort: number
    server?: net.Server
    client: Client
    createdAt: number
    active: boolean
    lifecycle: ForwardLifecycle
    /** 当前活跃 socket 数（仅 local forward 跟踪） */
    activeConnections: number
    /** 上次有连接活动的时间 */
    lastActivityAt: number
    connections: Set<{ destroy(): void }>
    connectionDrainWaiters: Set<() => void>
    pendingChannelOpens: number
    channelOpenDrainWaiters: Set<() => void>
    listenerReleased: boolean
    remoteUnforwarded: boolean
    rejectCreation?: (error: Error) => void
    resolvePendingClose?: () => void
    rejectPendingClose?: (error: Error) => void
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
        for (const existing of this.sessions.values()) {
            if (
                existing.alias === alias &&
                existing.type === 'local' &&
                existing.lifecycle === 'closing' &&
                existing.pendingChannelOpens > 0
            ) {
                throw new Error(
                    `Alias '${alias}' still has an unresolved SSH channel open; retry closing the existing forward or disconnect the alias`
                )
            }
        }
        const client = deps.getClient(alias)
        const forwardId = this.generateId()
        const server = net.createServer()
        const session: ForwardSession = {
            id: forwardId,
            alias,
            type: 'local',
            localHost,
            localPort,
            remoteHost,
            remotePort,
            server,
            client,
            createdAt: Date.now(),
            active: false,
            lifecycle: 'pending',
            activeConnections: 0,
            lastActivityAt: Date.now(),
            connections: new Set(),
            connectionDrainWaiters: new Set(),
            pendingChannelOpens: 0,
            channelOpenDrainWaiters: new Set(),
            listenerReleased: false,
            remoteUnforwarded: false,
        }
        this.sessions.set(forwardId, session)

        server.on('connection', (socket) => {
            if (!this.isCurrent(session) || session.lifecycle !== 'active' || !session.active) {
                socket.destroy()
                return
            }
            if (this.pendingChannelOpensForAlias(alias) >= MAX_PENDING_CHANNEL_OPENS_PER_ALIAS) {
                console.warn(
                    `Local forward ${session.id} rejected a connection because alias '${alias}' already has ${MAX_PENDING_CHANNEL_OPENS_PER_ALIAS} pending SSH channel opens`
                )
                socket.destroy()
                return
            }
            session.activeConnections += 1
            session.lastActivityAt = Date.now()
            session.connections.add(socket)
            let stream: ClientChannel | undefined
            let closed = false
            const closeConnection = (): void => {
                if (closed) {
                    return
                }
                closed = true
                session.connections.delete(socket)
                if (stream) {
                    session.connections.delete(stream)
                    if (!stream.destroyed) {
                        stream.destroy()
                    }
                }
                if (!socket.destroyed) {
                    socket.destroy()
                }
                session.activeConnections = Math.max(0, session.activeConnections - 1)
                session.lastActivityAt = Date.now()
                if (session.activeConnections === 0) {
                    for (const resolve of session.connectionDrainWaiters) {
                        resolve()
                    }
                    session.connectionDrainWaiters.clear()
                }
            }
            socket.once('close', closeConnection)
            socket.once('error', closeConnection)
            const settleChannelOpen = (): void => {
                session.pendingChannelOpens = Math.max(0, session.pendingChannelOpens - 1)
                if (session.pendingChannelOpens === 0) {
                    for (const resolve of session.channelOpenDrainWaiters) {
                        resolve()
                    }
                    session.channelOpenDrainWaiters.clear()
                }
            }
            session.pendingChannelOpens += 1
            try {
                client.forwardOut(
                    socket.remoteAddress || '127.0.0.1',
                    socket.remotePort || 0,
                    remoteHost,
                    remotePort,
                    (err, connectedStream) => {
                        settleChannelOpen()
                        if (err || !this.isCurrent(session) || session.lifecycle !== 'active' || !session.active) {
                            connectedStream?.destroy()
                            closeConnection()
                            return
                        }
                        stream = connectedStream
                        session.connections.add(stream)
                        stream.once('close', closeConnection)
                        stream.once('error', closeConnection)
                        socket.pipe(stream).pipe(socket)
                    }
                )
            } catch {
                settleChannelOpen()
                closeConnection()
            }
        })

        return new Promise((resolve, reject) => {
            session.rejectCreation = reject
            server.on('error', (err) => {
                if (!this.isCurrent(session)) {
                    return
                }
                if (session.lifecycle === 'pending') {
                    this.failPendingCreation(session, new Error(`Local forward failed: ${err.message}`))
                } else if (session.lifecycle !== 'closed') {
                    console.warn(`Local forward ${session.id} listener error: ${err.message}`)
                }
            })

            try {
                server.listen(localPort, localHost, () => {
                    if (!this.isCurrent(session) || session.lifecycle !== 'pending') {
                        this.closeServerAfterCancelledCreation(server)
                        return
                    }
                    const addr = server.address()
                    const actualPort =
                        addr && typeof addr === 'object' && typeof addr.port === 'number' ? addr.port : localPort
                    session.localPort = actualPort
                    session.lifecycle = 'active'
                    session.active = true
                    session.rejectCreation = undefined
                    resolve({ forwardId, localPort: actualPort })
                })
            } catch (error) {
                this.failPendingCreation(session, error instanceof Error ? error : new Error(String(error)))
            }
        })
    }

    async forwardRemote(
        deps: ForwardDependencies,
        alias: string,
        remotePort: number,
        localHost: string,
        localPort: number,
        remoteHost: string = '127.0.0.1'
    ): Promise<{ forwardId: string; remotePort: number }> {
        this.dependencies = deps
        const client = deps.getClient(alias)
        const forwardId = this.generateId()
        const session: ForwardSession = {
            id: forwardId,
            alias,
            type: 'remote',
            localHost,
            localPort,
            remoteHost,
            remotePort,
            client,
            createdAt: Date.now(),
            active: false,
            lifecycle: 'pending',
            activeConnections: 0,
            lastActivityAt: Date.now(),
            connections: new Set(),
            connectionDrainWaiters: new Set(),
            pendingChannelOpens: 0,
            channelOpenDrainWaiters: new Set(),
            listenerReleased: false,
            remoteUnforwarded: false,
        }
        this.sessions.set(forwardId, session)

        return new Promise((resolve, reject) => {
            session.rejectCreation = reject
            client.forwardIn(remoteHost, remotePort, (err, allocatedPort) => {
                if (err) {
                    if (this.isCurrent(session) && session.lifecycle === 'pending') {
                        this.failPendingCreation(session, new Error(`Remote forward failed: ${err.message}`))
                    } else if (this.isCurrent(session) && session.lifecycle === 'closing') {
                        this.completePendingRemoteCloseWithoutListener(session)
                    }
                    return
                }

                const actualPort =
                    Number.isSafeInteger(allocatedPort) && allocatedPort > 0
                        ? allocatedPort
                        : remotePort > 0
                          ? remotePort
                          : undefined
                if (actualPort === undefined) {
                    const error = new Error('Remote forward did not return the dynamically allocated port')
                    if (this.isCurrent(session) && session.lifecycle === 'pending') {
                        this.failPendingCreation(session, error)
                    } else if (this.isCurrent(session) && session.lifecycle === 'closing') {
                        this.failPendingRemoteClose(session, error)
                    }
                    return
                }

                if (this.isCurrent(session) && session.lifecycle === 'closing') {
                    session.remotePort = actualPort
                    this.unforwardPendingRemoteClose(session, actualPort)
                    return
                }
                if (!this.isCurrent(session) || session.lifecycle !== 'pending') {
                    this.unforwardCancelledCreation(session, actualPort)
                    return
                }

                session.remotePort = actualPort
                session.lifecycle = 'active'
                session.active = true
                session.rejectCreation = undefined
                this.ensureTcpDispatcher(alias, client)
                resolve({ forwardId, remotePort: actualPort })
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

        if (fwd.lifecycle === 'pending') {
            if (fwd.type === 'local') {
                this.cancelPendingCreation(fwd, 'Forward closed before listener creation completed')
                return {
                    success: true,
                    forwardId,
                    type: fwd.type,
                    closeMode: mode,
                    listenerReleased: true,
                    remoteUnforwarded: false,
                    activeConnections: 0,
                    retryable: false,
                }
            }
            this.beginPendingRemoteClose(fwd, 'Forward closed before listener creation completed')
        }

        if (mode === 'force') {
            for (const connection of fwd.connections) {
                connection.destroy()
            }
        }

        try {
            if (!fwd.closePromise) {
                fwd.lifecycle = 'closing'
                fwd.closePromise =
                    fwd.type === 'local' ? this.closeLocalListener(fwd) : this.closeRemoteListener(fwd, deps)
                fwd.closePromise.catch(() => {
                    if (this.isCurrent(fwd) && fwd.lifecycle === 'closing') {
                        if (fwd.active) {
                            fwd.lifecycle = 'active'
                        }
                        fwd.closePromise = undefined
                    }
                })
            }
            const channelOpenDrain = fwd.type === 'local' ? this.waitForChannelOpenDrain(fwd) : Promise.resolve()
            const closeCompletion =
                mode === 'force'
                    ? Promise.all([fwd.closePromise, this.waitForConnectionDrain(fwd), channelOpenDrain]).then(
                          () => undefined
                      )
                    : Promise.all([fwd.closePromise, channelOpenDrain]).then(() => undefined)
            await this.withTimeout(closeCompletion, timeoutMs)
            if (this.isCurrent(fwd) && fwd.lifecycle !== 'closed') {
                fwd.active = false
                fwd.lifecycle = 'closed'
                this.sessions.delete(forwardId)
                if (fwd.type === 'remote') {
                    this.removeTcpDispatcherIfEmpty(fwd.alias)
                }
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
            if (!this.isCurrent(fwd) || fwd.lifecycle === 'closed') {
                return {
                    success: true,
                    forwardId,
                    type: fwd.type,
                    closeMode: mode,
                    listenerReleased: fwd.type === 'local' ? !fwd.server?.listening : fwd.listenerReleased,
                    remoteUnforwarded: fwd.remoteUnforwarded,
                    activeConnections: fwd.activeConnections,
                    retryable: false,
                }
            }
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
        for (const fwd of this.sessions.values()) {
            if (fwd.alias !== alias) {
                continue
            }
            if (fwd.lifecycle === 'pending') {
                this.cancelPendingCreation(fwd, `SSH session '${alias}' disconnected during forward creation`)
                continue
            }

            fwd.active = false
            fwd.lifecycle = 'closed'
            for (const connection of fwd.connections) {
                connection.destroy()
            }
            this.sessions.delete(fwd.id)
            if (fwd.type === 'local' && fwd.server && !fwd.closePromise) {
                this.closeServerAfterCancelledCreation(fwd.server)
            }
            if (fwd.type === 'local' && fwd.server) {
                fwd.listenerReleased = !fwd.server.listening
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
            if (!fwd.active || (fwd.lifecycle !== 'active' && fwd.lifecycle !== 'closing')) {
                continue
            }
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

    private pendingChannelOpensForAlias(alias: string): number {
        let pending = 0
        for (const session of this.sessions.values()) {
            if (session.alias === alias && session.type === 'local' && session.lifecycle !== 'closed') {
                pending += session.pendingChannelOpens
            }
        }
        return pending
    }

    private waitForConnectionDrain(fwd: ForwardSession): Promise<void> {
        if (fwd.activeConnections === 0) {
            return Promise.resolve()
        }
        return new Promise((resolve) => {
            fwd.connectionDrainWaiters.add(resolve)
        })
    }

    private waitForChannelOpenDrain(fwd: ForwardSession): Promise<void> {
        if (fwd.pendingChannelOpens === 0) {
            return Promise.resolve()
        }
        return new Promise((resolve) => {
            fwd.channelOpenDrainWaiters.add(resolve)
        })
    }

    private closeLocalListener(fwd: ForwardSession): Promise<void> {
        const server = fwd.server
        if (!server) {
            return Promise.reject(new Error('Local forward listener is unavailable'))
        }
        return new Promise((resolve, reject) => {
            try {
                server.close((error) => {
                    if (this.isCurrent(fwd) && fwd.lifecycle === 'closing') {
                        fwd.listenerReleased = !server.listening
                    }
                    if (error) {
                        reject(error)
                    } else {
                        resolve()
                    }
                })
                if (this.isCurrent(fwd) && fwd.lifecycle === 'closing') {
                    fwd.listenerReleased = !server.listening
                }
            } catch (error) {
                if (this.isCurrent(fwd) && fwd.lifecycle === 'closing') {
                    fwd.listenerReleased = !server.listening
                }
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
                    if (this.isCurrent(fwd) && fwd.lifecycle === 'closing') {
                        fwd.remoteUnforwarded = true
                    }
                    resolve()
                }
            })
        })
    }

    private isCurrent(fwd: ForwardSession): boolean {
        return this.sessions.get(fwd.id) === fwd
    }

    private failPendingCreation(fwd: ForwardSession, error: Error): void {
        if (!this.isCurrent(fwd) || fwd.lifecycle !== 'pending') {
            return
        }
        fwd.active = false
        fwd.lifecycle = 'closed'
        this.sessions.delete(fwd.id)
        if (fwd.type === 'local' && fwd.server) {
            this.closeServerAfterCancelledCreation(fwd.server)
        }
        const reject = fwd.rejectCreation
        fwd.rejectCreation = undefined
        reject?.(error)
    }

    private beginPendingRemoteClose(fwd: ForwardSession, message: string): void {
        if (!this.isCurrent(fwd) || fwd.type !== 'remote' || fwd.lifecycle !== 'pending') {
            return
        }
        fwd.active = false
        fwd.lifecycle = 'closing'
        const rejectCreation = fwd.rejectCreation
        fwd.rejectCreation = undefined
        rejectCreation?.(new Error(message))
        fwd.closePromise = new Promise<void>((resolve, reject) => {
            fwd.resolvePendingClose = resolve
            fwd.rejectPendingClose = reject
        })
    }

    private completePendingRemoteCloseWithoutListener(fwd: ForwardSession): void {
        if (!this.isCurrent(fwd) || fwd.lifecycle !== 'closing') {
            return
        }
        fwd.remoteUnforwarded = true
        this.finishPendingRemoteClose(fwd)
    }

    private finishPendingRemoteClose(fwd: ForwardSession): void {
        const resolve = fwd.resolvePendingClose
        fwd.resolvePendingClose = undefined
        fwd.rejectPendingClose = undefined
        fwd.active = false
        fwd.lifecycle = 'closed'
        this.sessions.delete(fwd.id)
        this.removeTcpDispatcherIfEmpty(fwd.alias)
        resolve?.()
    }

    private failPendingRemoteClose(fwd: ForwardSession, error: Error): void {
        if (!this.isCurrent(fwd) || fwd.lifecycle !== 'closing') {
            return
        }
        fwd.closePromise = undefined
        const reject = fwd.rejectPendingClose
        fwd.resolvePendingClose = undefined
        fwd.rejectPendingClose = undefined
        reject?.(error)
    }

    private unforwardPendingRemoteClose(fwd: ForwardSession, actualPort: number): void {
        try {
            fwd.client.unforwardIn(fwd.remoteHost, actualPort, (error) => {
                if (!this.isCurrent(fwd) || fwd.lifecycle !== 'closing') {
                    return
                }
                if (error) {
                    this.failPendingRemoteClose(fwd, error)
                    return
                }
                fwd.remoteUnforwarded = true
                this.finishPendingRemoteClose(fwd)
            })
        } catch (error) {
            this.failPendingRemoteClose(fwd, error instanceof Error ? error : new Error(String(error)))
        }
    }

    private cancelPendingCreation(fwd: ForwardSession, message: string): void {
        this.failPendingCreation(fwd, new Error(message))
    }

    private closeServerAfterCancelledCreation(server: net.Server): void {
        try {
            server.close(() => undefined)
        } catch {
            /* listener 尚未创建或已关闭 */
        }
    }

    private unforwardCancelledCreation(fwd: ForwardSession, actualPort: number): void {
        try {
            fwd.client.unforwardIn(fwd.remoteHost, actualPort, (error) => {
                if (error) {
                    console.warn(`Cancelled remote forward ${fwd.id} cleanup failed: ${error.message}`)
                }
            })
        } catch (error) {
            console.warn(
                `Cancelled remote forward ${fwd.id} cleanup failed: ${error instanceof Error ? error.message : String(error)}`
            )
        }
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
                    fwd.lifecycle === 'active' &&
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
