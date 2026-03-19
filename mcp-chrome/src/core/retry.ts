/**
 * 重试策略
 *
 * 参考 Puppeteer Locator 的重试机制
 * RETRY_DELAY = 100ms
 */

import {TimeoutError} from './errors.js'
import {DEFAULT_TIMEOUT} from './types.js'

/**
 * 重试选项
 */
export interface RetryOptions {
    /** 超时时间（毫秒） */
    timeout?: number;
    /** 重试间隔（毫秒） */
    retryDelay?: number;
}

const DEFAULT_RETRY_DELAY = 100

/**
 * 带重试的函数执行
 *
 * 在超时时间内不断重试，直到成功或超时。
 * 超时后抛出最后一次的错误。
 *
 * @param fn 要执行的函数
 * @param options 重试选项
 * @returns 函数返回值
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    options: RetryOptions = {},
): Promise<T> {
    const { timeout = DEFAULT_TIMEOUT, retryDelay = DEFAULT_RETRY_DELAY } = options
    const deadline                                                        = Date.now() + timeout
    let lastError: Error | null                                           = null
    let attempts                                                          = 0

    while (Date.now() < deadline) {
        attempts++
        try {
            return await fn()
        } catch (error) {
            lastError = error as Error

            // 如果剩余时间不足以进行下一次重试，直接抛出错误
            if (Date.now() + retryDelay >= deadline) {
                break
            }

            await delay(retryDelay)
        }
    }

    // 超时，抛出最后的错误或超时错误
    if (lastError) {
        throw lastError
    }
    throw new TimeoutError(`操作超时 (${timeout}ms, ${attempts} 次尝试)`)
}

/**
 * 延迟
 */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
