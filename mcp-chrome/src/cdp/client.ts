/**
 * CDP (Chrome DevTools Protocol) 客户端
 *
 * 基于 WebSocket 实现，不依赖 Puppeteer
 * 参考 Puppeteer 的实现原理，但更轻量
 */

import { EventEmitter } from 'events'
import { AsyncLocalStorage } from 'async_hooks'
import WebSocket from 'ws'
import { CDPError, ConnectionRefusedError, getErrorSource, TimeoutError } from '../core/errors.js'
import { DEFAULT_TIMEOUT } from '../core/types.js'
import type { BrowserRequestContext, UserActionKind } from '../core/browser-driver.js'
import { remainingNavigationTimeout, withNavigationBudget } from '../core/utils.js'

/**
 * CDP 消息回调
 */
interface PendingCallback {
    resolve: (result: unknown) => void
    reject: (error: Error) => void
    method: string
    retainOnCancel?: boolean
    abandoned?: boolean
    cleanup?: { result: unknown; error?: unknown }
}

/**
 * waitForEvent 活跃等待者
 */
interface EventWaiter {
    event: string
    listener: CDPEventListener
    timer: NodeJS.Timeout
    reject: (error: Error) => void
}

/**
 * CDP 事件监听器
 */
type CDPEventListener = (params: unknown, sessionId?: string) => void

/**
 * CDP 客户端
 */
export class CDPClient extends EventEmitter {
    /** 默认命令超时 */
    private static readonly DEFAULT_COMMAND_TIMEOUT = DEFAULT_TIMEOUT
    private ws: WebSocket | null = null
    private callbacks = new Map<number, PendingCallback>()
    private nextId = 1
    private eventListeners = new Map<string, Set<CDPEventListener>>()
    private activeEventWaiters = new Set<EventWaiter>()
    private readonly nativeEventContext = new AsyncLocalStorage<boolean>()

    constructor(private readonly requestContext?: () => BrowserRequestContext | undefined) {
        super()
    }

    get isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN
    }

    /**
     * 连接到 CDP 端点
     */
    async connect(endpoint: string, timeout = DEFAULT_TIMEOUT): Promise<void> {
        const scope = this.requestContext?.()
        const signal = scope?.signal
        signal?.throwIfAborted()
        const deadline = Math.min(Date.now() + timeout, scope?.deadline ?? Infinity)
        timeout = remainingNavigationTimeout(deadline)
        return new Promise((resolve, reject) => {
            let socket: WebSocket
            try {
                socket = new WebSocket(endpoint, { perMessageDeflate: false })
            } catch {
                const match = endpoint.match(/ws:\/\/(?<host>[^:]+):(?<port>\d+)/)
                reject(
                    match
                        ? new ConnectionRefusedError(match.groups!.host, parseInt(match.groups!.port, 10))
                        : new CDPError(`无法连接到 ${endpoint}`)
                )
                return
            }
            this.ws = socket
            let settled = false
            const cleanup = () => {
                clearTimeout(timer)
                signal?.removeEventListener('abort', onAbort)
                socket.removeListener('open', onOpen)
            }
            const fail = (error: unknown) => {
                if (settled) {
                    return
                }
                settled = true
                cleanup()
                if (scope && error instanceof Error && getErrorSource(error) === 'budget') {
                    scope.budgetError ??= error
                }
                if (this.ws === socket) {
                    this.ws = null
                }
                socket.terminate()
                reject(error)
            }
            const onAbort = () => fail(signal?.reason ?? new Error('Request cancelled'))
            const timer = setTimeout(() => fail(new TimeoutError(`连接超时: ${endpoint} (${timeout}ms)`)), timeout)
            const onOpen = () => {
                try {
                    signal?.throwIfAborted()
                    remainingNavigationTimeout(deadline)
                } catch (error) {
                    fail(error)
                    return
                }
                settled = true
                cleanup()
                resolve()
            }
            socket.on('open', onOpen)
            socket.on('error', (error: Error) => {
                const match = endpoint.match(/ws:\/\/(?<host>[^:]+):(?<port>\d+)/)
                fail(
                    match && error.message.includes('ECONNREFUSED')
                        ? new ConnectionRefusedError(match.groups!.host, parseInt(match.groups!.port, 10))
                        : new CDPError(error.message)
                )
            })
            socket.on('message', (data: WebSocket.Data) => this.handleMessage(data))
            socket.on('close', () => {
                if (!settled) {
                    fail(new CDPError('CDP 连接在握手完成前关闭'))
                }
                if (this.ws === socket) {
                    this.handleClose()
                }
            })
            signal?.addEventListener('abort', onAbort, { once: true })
            if (signal?.aborted) {
                onAbort()
            }
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
        cleanup = false,
        dispatchedAction?: UserActionKind
    ): Promise<T> {
        const type = (params as { type?: string } | undefined)?.type
        const resourceCleanup =
            cleanup ||
            (method === 'Fetch.failRequest' && (params as { errorReason?: string })?.errorReason === 'Aborted') ||
            (method === 'Fetch.continueWithAuth' &&
                (params as { authChallengeResponse?: { response?: string } })?.authChallengeResponse?.response ===
                    'CancelAuth') ||
            method === 'Fetch.disable' ||
            method === 'Runtime.releaseObject' ||
            method === 'Runtime.releaseObjectGroup' ||
            (method === 'Input.dispatchKeyEvent' && type === 'keyUp') ||
            (method === 'Input.dispatchMouseEvent' && type === 'mouseReleased') ||
            (method === 'Input.dispatchTouchEvent' && (type === 'touchEnd' || type === 'touchCancel')) ||
            (method === 'Emulation.setTouchEmulationEnabled' && (params as { enabled?: boolean })?.enabled === false)
        const requestScope = this.nativeEventContext.getStore() ? undefined : this.requestContext?.()
        const userAction = requestScope?.userAction
        const scope = resourceCleanup ? undefined : requestScope
        if (scope?.signal?.aborted) {
            throw new CDPError(`CDP request cancelled before dispatch: ${method}`, {
                method,
                errorSource: 'cancelled',
                actionExecuted: false,
                actionStatus: 'not_started',
                retryable: false,
            })
        }
        if (scope?.deadline !== undefined) {
            const remaining = scope.deadline - Date.now()
            if (remaining <= 0) {
                throw new TimeoutError('CDP timeout before dispatch', {
                    method,
                    actionExecuted: false,
                    actionStatus: 'not_started',
                    retryable: false,
                })
            }
            timeout = Math.min(timeout, remaining)
        }
        if (!this.isConnected) {
            throw new CDPError('CDP 客户端未连接', {
                method,
                errorSource: 'transport',
                actionExecuted: false,
                actionStatus: 'not_started',
                retryable: false,
            })
        }

        const id = this.nextId++
        const message: Record<string, unknown> = { id, method }

        if (params !== undefined) {
            message.params = params
        }
        if (sessionId !== undefined) {
            message.sessionId = sessionId
        }

        const onAbandonedResult =
            method === 'Target.attachToTarget'
                ? async (result: unknown) => {
                      const { sessionId } = result as { sessionId: string }
                      await this.send('Target.detachFromTarget', { sessionId }, undefined, 1000, true)
                  }
                : undefined
        return new Promise((resolve, reject) => {
            const abandon = (error: Error) => {
                clearTimeout(timeoutId)
                signalCleanup()
                if (scope && this.callbacks.has(id) && getErrorSource(error) === 'budget') {
                    scope.budgetError ??= error
                }
                if (onAbandonedResult) {
                    // 业务等待结束后，资源响应仍由原命令负责，直到回收或连接关闭
                    callback.abandoned = true
                } else {
                    this.callbacks.delete(id)
                }
                reject(error)
            }
            const onAbort = () =>
                abandon(
                    new CDPError(`CDP request cancelled after dispatch: ${method}`, {
                        method,
                        errorSource: 'cancelled',
                        actionExecuted: 'unknown',
                        actionStatus: 'unknown',
                        retryable: false,
                    })
                )
            const signalCleanup = () => scope?.signal?.removeEventListener('abort', onAbort)
            const timeoutId = setTimeout(() => {
                abandon(
                    new CDPError(`CDP 命令超时: ${method} (${timeout}ms)`, {
                        method,
                        errorSource: 'budget',
                        actionExecuted: 'unknown',
                        actionStatus: 'unknown',
                        retryable: false,
                    })
                )
            }, timeout)

            const callback: PendingCallback = {
                resolve: (result: unknown) => {
                    clearTimeout(timeoutId)
                    signalCleanup()
                    if (callback.abandoned && onAbandonedResult) {
                        callback.cleanup = { result }
                        void Promise.resolve()
                            .then(() => onAbandonedResult(result))
                            .then(
                                () => this.callbacks.delete(id),
                                (error: unknown) => {
                                    callback.cleanup!.error = error
                                    console.warn('[MCP] CDP resource cleanup outcome unknown:', {
                                        id,
                                        method,
                                        result,
                                        error,
                                    })
                                }
                            )
                    } else {
                        this.callbacks.delete(id)
                        resolve(result as T)
                    }
                },
                reject: (error: Error) => {
                    clearTimeout(timeoutId)
                    signalCleanup()
                    this.callbacks.delete(id)
                    reject(error)
                },
                method,
                retainOnCancel: onAbandonedResult !== undefined,
            }
            this.callbacks.set(id, callback)

            try {
                this.ws!.send(JSON.stringify(message))
                if (
                    userAction &&
                    (userAction.kind === dispatchedAction ||
                        (userAction.kind === 'input' &&
                            (method.startsWith('Input.dispatch') || method === 'Input.insertText')))
                ) {
                    userAction.dispatched = true
                }
                scope?.signal?.addEventListener('abort', onAbort, { once: true })
                if (scope?.signal?.aborted) {
                    onAbort()
                }
            } catch (err) {
                clearTimeout(timeoutId)
                this.callbacks.delete(id)
                reject(
                    new CDPError(
                        `Failed to send CDP command ${method}: ${err instanceof Error ? err.message : 'Unknown error'}`,
                        { method, errorSource: 'transport' }
                    )
                )
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
     * close()/handleClose() 会立即 reject 所有活跃的等待者，不必等 timer 超时
     */
    waitForEvent<T = unknown>(
        event: string,
        predicate?: (params: T) => boolean,
        timeout = DEFAULT_TIMEOUT,
        sessionId?: string,
        signal?: AbortSignal
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            const listener: CDPEventListener = (params, eventSessionId) => {
                if (sessionId !== undefined && eventSessionId !== sessionId) {
                    return
                }
                if (!predicate || predicate(params as T)) {
                    cleanup()
                    resolve(params as T)
                }
            }
            const onAbort = () => {
                cleanup()
                reject(signal?.reason instanceof Error ? signal.reason : new Error(`等待事件已取消: ${event}`))
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
                signal?.removeEventListener('abort', onAbort)
                this.offEvent(event, listener)
                this.activeEventWaiters.delete(waiter)
            }

            this.activeEventWaiters.add(waiter)
            this.onEvent(event, listener)
            signal?.addEventListener('abort', onAbort, { once: true })
            if (signal?.aborted) {
                onAbort()
            }
        })
    }

    /**
     * 关闭连接
     *
     * 立即 reject 所有 pending callbacks 和 waitForEvent，
     * 然后发出 'disconnected' 信号供外部等待者（如 waitForAnyEvent）清理
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
            id?: number
            method?: string
            params?: unknown
            result?: unknown
            error?: { message: string; code?: number }
            sessionId?: string
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
                if (!callback.retainOnCancel) {
                    this.callbacks.delete(message.id)
                }
                if (message.error) {
                    const contextLost =
                        message.error.code === -32000 &&
                        new RegExp(
                            '^(?:Cannot find (?:context with specified id|default execution context|object with given id)|' +
                                'Could not find object with given id|Execution context was destroyed|' +
                                'No frame with given id found|Inspected target navigated or closed|' +
                                String.raw`Session with given id not found)\.?$`
                        ).test(message.error.message)
                    callback.reject(
                        new CDPError(`${callback.method}: ${message.error.message}`, {
                            method: callback.method,
                            protocolError: true,
                            errorSource: contextLost ? 'context' : 'protocol',
                            nativeCode: message.error.code,
                            ...([-32601, -32602].includes(message.error.code ?? 0)
                                ? { actionExecuted: false, actionStatus: 'not_started', retryable: false }
                                : {}),
                        })
                    )
                } else {
                    callback.resolve(message.result)
                }
            }
            return
        }

        // 原生事件及其异步后续处理独立于建立连接时的请求期限和取消
        if (message.method) {
            const { method, params, sessionId } = message
            this.nativeEventContext.run(true, () => {
                const listeners = this.eventListeners.get(method)
                if (listeners) {
                    for (const listener of listeners) {
                        try {
                            listener(params, sessionId)
                        } catch (error) {
                            console.error(`CDP 事件处理错误 (${method}):`, error)
                        }
                    }
                }
                // 也触发通用事件
                this.emit(method, params, sessionId)
            })
        }
    }

    /**
     * 立即 reject 所有 pending callbacks 和 waitForEvent 等待者
     */
    private rejectAllPending(reason: string): void {
        for (const [, callback] of this.callbacks) {
            callback.reject(
                new CDPError(reason, {
                    method: callback.method,
                    errorSource: 'transport',
                    actionExecuted: 'unknown',
                    actionStatus: 'unknown',
                    retryable: false,
                })
            )
        }
        this.callbacks.clear()

        for (const waiter of this.activeEventWaiters) {
            clearTimeout(waiter.timer)
            this.offEvent(waiter.event, waiter.listener)
            waiter.reject(new CDPError(reason, { errorSource: 'transport' }))
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
async function cdpHttpFetch<T>(
    host: string,
    port: number,
    path: string,
    timeout: number,
    signal?: AbortSignal
): Promise<T> {
    signal?.throwIfAborted()
    // noinspection HttpUrlsUsage — CDP 调试协议只支持 HTTP
    const url = `http://${host}:${port}${path}`
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
        onAbort()
    }
    const deadline = Date.now() + timeout
    const timeoutId = setTimeout(() => controller.abort(), timeout)
    try {
        return await withNavigationBudget(
            async () => {
                const response = await fetch(url, { signal: controller.signal })
                signal?.throwIfAborted()
                remainingNavigationTimeout(deadline)
                if (!response.ok) {
                    throw new ConnectionRefusedError(host, port)
                }
                return (await response.json()) as T
            },
            deadline,
            signal
        )
    } catch (error) {
        signal?.throwIfAborted()
        if (error instanceof TimeoutError || (error instanceof Error && error.name === 'AbortError')) {
            throw new TimeoutError(`连接超时: ${host}:${port} (${timeout}ms)`)
        }
        if (error instanceof ConnectionRefusedError || error instanceof SyntaxError) {
            throw error
        }
        throw new ConnectionRefusedError(host, port)
    } finally {
        clearTimeout(timeoutId)
        signal?.removeEventListener('abort', onAbort)
        controller.abort()
    }
}

/**
 * 获取浏览器 WebSocket 端点
 */
export async function getBrowserWSEndpoint(
    host: string,
    port: number,
    timeout: number = DEFAULT_HTTP_TIMEOUT,
    signal?: AbortSignal
): Promise<string> {
    const data = await cdpHttpFetch<{ webSocketDebuggerUrl: string }>(host, port, '/json/version', timeout, signal)
    return data.webSocketDebuggerUrl
}

/**
 * 获取所有可用的 targets
 */
export async function getTargets(
    host: string,
    port: number,
    timeout: number = DEFAULT_HTTP_TIMEOUT,
    signal?: AbortSignal
): Promise<Array<{ id: string; type: string; url: string; title: string; webSocketDebuggerUrl: string }>> {
    return cdpHttpFetch(host, port, '/json/list', timeout, signal)
}
