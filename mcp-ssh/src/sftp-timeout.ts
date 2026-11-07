import type { SFTPWrapper } from 'ssh2'

export const DEFAULT_SFTP_OPERATION_TIMEOUT_MS = 600_000
export const HARD_SFTP_OPERATION_TIMEOUT_MS = 3_600_000

export class SftpOperationTimeoutError extends Error {
    readonly details: Record<string, unknown>

    constructor(readonly timeout: number) {
        super(`SFTP operation timed out after ${timeout}ms; remote transfer state is unknown`)
        this.name = 'SftpOperationTimeoutError'
        this.details = {
            operationStatus: 'unknown',
            retryable: true,
            timeout,
        }
    }
}

export function normalizeSftpOperationTimeout(timeout: number | undefined): number {
    const normalized = timeout ?? DEFAULT_SFTP_OPERATION_TIMEOUT_MS
    if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > HARD_SFTP_OPERATION_TIMEOUT_MS) {
        throw new Error(`SFTP timeout must be between 1 and ${HARD_SFTP_OPERATION_TIMEOUT_MS}ms`)
    }
    return normalized
}

export function withSftpOperationTimeout<T>(
    operation: Promise<T>,
    timeout: number | undefined,
    onTimeout: () => void,
    signal?: AbortSignal
): Promise<T> {
    const normalizedTimeout = normalizeSftpOperationTimeout(timeout)
    return new Promise<T>((resolve, reject) => {
        let settled = false
        const settle = (callback: () => void): void => {
            if (settled) {
                return
            }
            settled = true
            clearTimeout(timer)
            signal?.removeEventListener('abort', abort)
            callback()
        }
        const cancel = (error: unknown): void =>
            settle(() => {
                try {
                    onTimeout()
                } catch {
                    // 保留取消或超时的原始错误
                }
                reject(error)
            })
        const abort = (): void => cancel(signal?.reason ?? new Error('SFTP operation cancelled'))
        const timer = setTimeout(() => cancel(new SftpOperationTimeoutError(normalizedTimeout)), normalizedTimeout)
        operation.then(
            (value) => settle(() => resolve(value)),
            (error) => settle(() => reject(error))
        )
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) {
            abort()
        }
    })
}

export function sftpOperationOutcome(error: unknown): Record<string, unknown> {
    if (!error || typeof error !== 'object') {
        return {}
    }
    const details = 'details' in error ? (error as { details?: unknown }).details : undefined
    if (details && typeof details === 'object' && 'operationStatus' in details) {
        return details as Record<string, unknown>
    }
    return sftpOperationOutcome('cause' in error ? error.cause : undefined)
}

/** 按流记录请求状态，CLOSE 以服务端应答为准 */
export class SftpWriteState {
    acknowledgedBytes = 0
    remoteCreated = false
    private pending = 0
    private unknownStage?: string
    private failureStage?: string
    private stage = 'open'

    constructor(readonly remotePath: string) {}

    track(sftp: SFTPWrapper): SFTPWrapper {
        return new Proxy(sftp, {
            get: (target, property, receiver): unknown => {
                const method: unknown = Reflect.get(target, property)
                if (typeof method !== 'function') {
                    return method
                }
                if (property === 'createWriteStream') {
                    return (...args: unknown[]) => Reflect.apply(method, receiver, args)
                }
                if (
                    property !== 'open' &&
                    property !== 'write' &&
                    property !== 'close' &&
                    property !== 'rename' &&
                    property !== 'ext_openssh_rename'
                ) {
                    return method.bind(target)
                }
                return (...args: unknown[]) => {
                    const stage = property === 'ext_openssh_rename' ? 'rename' : property
                    const callback = args.pop() as (...values: unknown[]) => void
                    this.stage = stage
                    ++this.pending
                    try {
                        return Reflect.apply(method, target, [
                            ...args,
                            (error: unknown, ...values: unknown[]) => {
                                --this.pending
                                if (error) {
                                    this.failureStage ??= stage
                                    const code = typeof error === 'object' && 'code' in error ? error.code : undefined
                                    // 数值 STATUS 为明确应答，6/7 表示连接丢失
                                    if (typeof code !== 'number' || code === 6 || code === 7) {
                                        this.unknownStage ??= stage
                                    }
                                } else if (stage === 'write') {
                                    this.acknowledgedBytes += Number(values[0])
                                } else if (stage === 'open') {
                                    this.remoteCreated = true
                                }
                                callback(error, ...values)
                            },
                        ])
                    } catch (error) {
                        --this.pending
                        this.failureStage ??= stage
                        throw error
                    }
                }
            },
        })
    }

    outcome(error: unknown): Record<string, unknown> {
        return {
            ...sftpOperationOutcome(error),
            operationStatus: this.pending > 0 || this.unknownStage ? 'unknown' : 'failed',
            retryable: false,
            remotePath: this.remotePath,
            failureStage: this.unknownStage ?? this.failureStage ?? this.stage,
            acknowledgedBytes: this.acknowledgedBytes,
        }
    }
}
