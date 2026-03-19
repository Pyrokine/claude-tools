/**
 * CDP (Chrome DevTools Protocol) 客户端
 *
 * 基于 WebSocket 实现，不依赖 Puppeteer
 * 参考 Puppeteer 的实现原理，但更轻量
 */

import {EventEmitter} from 'events'
import WebSocket from 'ws'
import {CDPError, ConnectionRefusedError, TimeoutError} from '../core/errors.js'
import {DEFAULT_TIMEOUT} from '../core/types.js'

/**
 * CDP 消息回调
 */
interface PendingCallback {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    method: string;
}

/**
 * waitForEvent 活跃等待者
 */
interface EventWaiter {
    event: string;
    listener: CDPEventListener;
    timer: NodeJS.Timeout;
    reject: (error: Error) => void;
}

/**
 * CDP 事件监听器
 */
type CDPEventListener = (params: unknown) => void;

/**
 * CDP 客户端
 */
export class CDPClient extends EventEmitter {
    /** 默认命令超时 */
    private static readonly DEFAULT_COMMAND_TIMEOUT = DEFAULT_TIMEOUT
    private ws: WebSocket | null                    = null
    private callbacks                               = new Map<number, PendingCallback>()
    private nextId                                  = 1
    private eventListeners                          = new Map<string, Set<CDPEventListener>>()
    private activeEventWaiters                      = new Set<EventWaiter>()

    get isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN
    }

    /**
     * 连接到 CDP 端点
     */
    async connect(endpoint: string, timeout = DEFAULT_TIMEOUT): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new TimeoutError(`连接超时: ${endpoint} (${timeout}ms)`))
            }, timeout)

            try {
                this.ws = new WebSocket(endpoint)
            } catch (error) {
                clearTimeout(timer)
                // 解析 host 和 port
                const match = endpoint.match(/ws:\/\/([^:]+):(\d+)/)
                if (match) {
                    reject(new ConnectionRefusedError(match[1], parseInt(match[2], 10)))
                } else {
                    reject(new CDPError(`无法连接到 ${endpoint}`))
                }
                return
            }

            this.ws.on('open', () => {
                clearTimeout(timer)
                resolve()
            })

            this.ws.on('error', (error: Error) => {
                clearTimeout(timer)
                // 解析 host 和 port
                const match = endpoint.match(/ws:\/\/([^:]+):(\d+)/)
                if (match && error.message.includes('ECONNREFUSED')) {
                    reject(new ConnectionRefusedError(match[1], parseInt(match[2], 10)))
                } else {
                    reject(new CDPError(error.message))
                }
            })

            this.ws.on('message', (data: WebSocket.Data) => {
                this.handleMessage(data)
            })

            this.ws.on('close', () => {
                this.handleClose()
            })
        })
    }

    /**
     * 发送 CDP 命令
     */
    async send<T = unknown>(
        method: string,
        params?: object,
        sessionId?: string,
        timeout: number = CDPClient.DEFAULT_COMMAND_TIMEOUT,
    ): Promise<T> {
        if (!this.isConnected) {
            throw new CDPError('CDP 客户端未连接')
        }

        const id                               = this.nextId++
        const message: Record<string, unknown> = { id, method }

        if (params !== undefined) {
            message.params = params
        }
        if (sessionId !== undefined) {
            message.sessionId = sessionId
        }

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.callbacks.delete(id)
                reject(new CDPError(`CDP 命令超时: ${method} (${timeout}ms)`))
            }, timeout)

            this.callbacks.set(id, {
                resolve: (result: unknown) => {
                    clearTimeout(timeoutId)
                    resolve(result as T)
                },
                reject: (error: Error) => {
                    clearTimeout(timeoutId)
                    reject(error)
                },
                method,
            })

            try {
                this.ws!.send(JSON.stringify(message))
            } catch (err) {
                clearTimeout(timeoutId)
                this.callbacks.delete(id)
                reject(new CDPError(`Failed to send CDP command ${method}: ${err instanceof Error ?
                                                                             err.message :
                                                                             'Unknown error'}`))
            }
        })
    }

    /**
     * 监听 CDP 事件
     */
    onEvent(event: string, listener: CDPEventListener): void {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, new Set())
        }
        this.eventListeners.get(event)!.add(listener)
    }

    /**
     * 移除 CDP 事件监听
     */
    offEvent(event: string, listener: CDPEventListener): void {
        const listeners = this.eventListeners.get(event)
        if (listeners) {
            listeners.delete(listener)
        }
    }

    /**
     * 等待特定事件
     *
     * close()/handleClose() 会立即 reject 所有活跃的等待者，不必等 timer 超时。
     */
    waitForEvent<T = unknown>(
        event: string,
        predicate?: (params: T) => boolean,
        timeout = DEFAULT_TIMEOUT,
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            const listener: CDPEventListener = (params) => {
                if (!predicate || predicate(params as T)) {
                    cleanup()
                    resolve(params as T)
                }
            }

            const waiter: EventWaiter = {
                event,
                listener,
                timer: setTimeout(() => {
                    cleanup()
                    reject(new TimeoutError(`等待事件超时: ${event} (${timeout}ms)`))
                }, timeout),
                reject,
            }

            const cleanup = () => {
                clearTimeout(waiter.timer)
                this.offEvent(event, listener)
                this.activeEventWaiters.delete(waiter)
            }

            this.activeEventWaiters.add(waiter)
            this.onEvent(event, listener)
        })
    }

    /**
     * 关闭连接
     *
     * 立即 reject 所有 pending callbacks 和 waitForEvent，
     * 然后发出 'disconnected' 信号供外部等待者（如 waitForAnyEvent）清理。
     */
    close(): void {
        this.rejectAllPending('连接主动关闭')
        this.eventListeners.clear()

        if (this.ws) {
            this.ws.close()
            this.ws = null
        }

        this.emit('disconnected')
    }

    /**
     * 处理收到的消息
     */
    private handleMessage(data: WebSocket.Data): void {
        let message: {
            id?: number;
            method?: string;
            params?: unknown;
            result?: unknown;
            error?: { message: string; code?: number };
        }

        try {
            message = JSON.parse(data.toString())
        } catch {
            console.error('CDP: 无法解析消息', data.toString())
            return
        }

        // 响应消息
        if (message.id !== undefined) {
            const callback = this.callbacks.get(message.id)
            if (callback) {
                this.callbacks.delete(message.id)
                if (message.error) {
                    callback.reject(
                        new CDPError(`${callback.method}: ${message.error.message}`),
                    )
                } else {
                    callback.resolve(message.result)
                }
            }
            return
        }

        // 事件消息
        if (message.method) {
            const listeners = this.eventListeners.get(message.method)
            if (listeners) {
                for (const listener of listeners) {
                    try {
                        listener(message.params)
                    } catch (error) {
                        console.error(`CDP 事件处理错误 (${message.method}):`, error)
                    }
                }
            }
            // 也触发通用事件
            this.emit(message.method, message.params)
        }
    }

    /**
     * 立即 reject 所有 pending callbacks 和 waitForEvent 等待者
     */
    private rejectAllPending(reason: string): void {
        for (const [, callback] of this.callbacks) {
            callback.reject(new CDPError(reason))
        }
        this.callbacks.clear()

        for (const waiter of this.activeEventWaiters) {
            clearTimeout(waiter.timer)
            this.offEvent(waiter.event, waiter.listener)
            waiter.reject(new CDPError(reason))
        }
        this.activeEventWaiters.clear()
    }

    /**
     * 处理连接关闭
     */
    private handleClose(): void {
        if (this.ws === null) {
            return
        }
        this.ws = null
        this.rejectAllPending('连接已关闭')
        this.eventListeners.clear()
        this.emit('disconnected')
    }
}

/** 默认 HTTP 请求超时 */
const DEFAULT_HTTP_TIMEOUT = 10000

/**
 * 请求 CDP HTTP 接口（公共逻辑）
 */
async function cdpHttpFetch<T>(host: string, port: number, path: string, timeout: number): Promise<T> {
    // noinspection HttpUrlsUsage — CDP 调试协议只支持 HTTP
    const url        = `http://${host}:${port}${path}`
    const controller = new AbortController()
    const timeoutId  = setTimeout(() => controller.abort(), timeout)

    let response: Response
    try {
        response = await fetch(url, { signal: controller.signal })
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new TimeoutError(`连接超时: ${host}:${port} (${timeout}ms)`)
        }
        throw new ConnectionRefusedError(host, port)
    } finally {
        clearTimeout(timeoutId)
    }

    if (!response.ok) {
        throw new ConnectionRefusedError(host, port)
    }
    return (await response.json()) as T
}

/**
 * 获取浏览器 WebSocket 端点
 */
export async function getBrowserWSEndpoint(
    host: string,
    port: number,
    timeout: number = DEFAULT_HTTP_TIMEOUT,
): Promise<string> {
    const data = await cdpHttpFetch<{ webSocketDebuggerUrl: string }>(host, port, '/json/version', timeout)
    return data.webSocketDebuggerUrl
}

/**
 * 获取所有可用的 targets
 */
export async function getTargets(
    host: string,
    port: number,
    timeout: number = DEFAULT_HTTP_TIMEOUT,
): Promise<Array<{ id: string; type: string; url: string; title: string; webSocketDebuggerUrl: string }>> {
    return cdpHttpFetch(host, port, '/json/list', timeout)
}
