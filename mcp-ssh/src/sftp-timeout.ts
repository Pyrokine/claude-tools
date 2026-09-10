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
    onTimeout: () => void
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
            callback()
        }
        const timer = setTimeout(() => {
            settle(() => {
                try {
                    onTimeout()
                } catch {
                    // 超时响应优先于释放 SFTP channel 失败
                }
                reject(new SftpOperationTimeoutError(normalizedTimeout))
            })
        }, normalizedTimeout)
        operation.then(
            (value) => settle(() => resolve(value)),
            (error) => settle(() => reject(error))
        )
    })
}
