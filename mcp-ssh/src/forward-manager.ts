/**
 * 端口转发管理器
 *
 * 负责本地/远程端口转发的完整生命周期
 */

import * as net from 'net'
import type {Client, ClientChannel} from 'ssh2'
import type {PortForwardInfo} from './types.js'

/** 端口转发所需的外部依赖 */
export interface ForwardDependencies {
    /** 获取 SSH client */
    getClient(alias: string): Client;
}

interface ForwardSession {
    id: string;
    alias: string;
    type: 'local' | 'remote';
    localHost: string;
    localPort: number;
    remoteHost: string;
    remotePort: number;
    server?: net.Server;
    createdAt: number;
    active: boolean;
}

// tcp connection 事件处理函数类型
type TcpConnectionHandler = (
    info: { destIP: string; destPort: number; srcIP: string; srcPort: number },
    accept: () => ClientChannel,
    reject: () => void,
) => void;

/** 每个 SSH session 的 dispatcher 状态 */
interface DispatcherState {
    handler: TcpConnectionHandler;
    client: Client;
}

export class ForwardManager {
    private sessions: Map<string, ForwardSession>     = new Map()
    private dispatchers: Map<string, DispatcherState> = new Map()  // alias → dispatcher
    private idCounter                                 = 0

    async forwardLocal(
        deps: ForwardDependencies,
        alias: string,
        localPort: number,
        remoteHost: string,
        remotePort: number,
        localHost: string = '127.0.0.1',
    ): Promise<string> {
        const client    = deps.getClient(alias)
        const forwardId = this.generateId()

        return new Promise((resolve, reject) => {
            const server = net.createServer((socket) => {
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
                    },
                )
            })

            server.on('error', (err) => {
                reject(new Error(`Local forward failed: ${err.message}`))
            })

            server.listen(localPort, localHost, () => {
                this.sessions.set(forwardId, {
                    id: forwardId,
                    alias,
                    type: 'local',
                    localHost,
                    localPort,
                    remoteHost,
                    remotePort,
                    server,
                    createdAt: Date.now(),
                    active: true,
                })
                resolve(forwardId)
            })
        })
    }

    async forwardRemote(
        deps: ForwardDependencies,
        alias: string,
        remotePort: number,
        localHost: string,
        localPort: number,
        remoteHost: string = '127.0.0.1',
    ): Promise<string> {
        const client    = deps.getClient(alias)
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
                })

                this.ensureTcpDispatcher(alias, client)
                resolve(forwardId)
            })
        })
    }

    close(forwardId: string, deps?: ForwardDependencies): boolean {
        const fwd = this.sessions.get(forwardId)
        if (!fwd) {
            return false
        }

        fwd.active = false

        if (fwd.type === 'local' && fwd.server) {
            try {
                fwd.server.close()
            } catch (e) {
                console.warn(`Forward ${forwardId} server close failed:`, (e as Error).message)
            }
        } else if (fwd.type === 'remote' && deps) {
            try {
                const client = deps.getClient(fwd.alias)
                client.unforwardIn(fwd.remoteHost, fwd.remotePort)
            } catch { /* session 可能已断开 */
            }
            this.removeTcpDispatcherIfEmpty(fwd.alias)
        }

        this.sessions.delete(forwardId)
        return true
    }

    /** 关闭指定 alias 的所有转发（disconnect 时调用，不需要 unforwardIn） */
    closeByAlias(alias: string): void {
        for (const [id, fwd] of this.sessions) {
            if (fwd.alias === alias) {
                fwd.active = false
                if (fwd.type === 'local' && fwd.server) {
                    try {
                        fwd.server.close()
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
            } catch { /* client 可能已关闭 */ }
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
                if (fwd.type === 'remote' &&
                    fwd.active &&
                    fwd.alias === alias &&
                    fwd.remoteHost === info.destIP &&
                    fwd.remotePort === info.destPort) {
                    const stream = accept()
                    const socket = net.createConnection(fwd.localPort, fwd.localHost)
                    socket.pipe(stream).pipe(socket)
                    socket.on('error', () => stream.close())
                    stream.on('error', () => socket.destroy())
                    return
                }
            }
            rejectConn()
        }

        this.dispatchers.set(alias, {handler, client})
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
                return  // 还有活跃的 remote forward
            }
        }

        state.client.removeListener('tcp connection', state.handler)
        this.dispatchers.delete(alias)
    }

    private generateId(): string {
        return `fwd_${++this.idCounter}_${Date.now()}`
    }
}
