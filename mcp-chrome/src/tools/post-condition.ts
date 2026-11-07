import { z } from 'zod'
import { sanitizeErrorMessage } from '../core/error-sanitizer.js'
import {
    CDPError,
    getErrorSource,
    isNativeExecutionResultUnknown,
    StructuredToolError,
    TimeoutError,
} from '../core/errors.js'
import { getUnifiedSession } from '../core/index.js'
import type { InputMode } from '../core/unified-session.js'
import { withNavigationBudget } from '../core/utils.js'

const POST_CONDITION_DEFAULT_TIMEOUT_MS = 3000
const POST_CONDITION_MAX_TIMEOUT_MS = 60_000
const POST_CONDITION_DEFAULT_INTERVAL_MS = 100
const POST_CONDITION_MIN_INTERVAL_MS = 50
const POST_CONDITION_MAX_INTERVAL_MS = 5000

export const postConditionSchema = z
    .object({
        text: z.string().optional().describe('等待页面文本包含该内容'),
        selector: z.string().optional().describe('等待 CSS selector 至少匹配一个元素'),
        urlIncludes: z.string().optional().describe('等待当前 URL 包含该字符串'),
        script: z.string().optional().describe('等待 JavaScript 表达式或函数返回 truthy'),
        exact: z.boolean().optional().describe('text 使用精确匹配，默认 false'),
        timeout: z
            .number()
            .int()
            .positive()
            .max(POST_CONDITION_MAX_TIMEOUT_MS)
            .optional()
            .describe('等待超时毫秒，默认 3000，最大 60000'),
        interval: z
            .number()
            .int()
            .min(POST_CONDITION_MIN_INTERVAL_MS)
            .max(POST_CONDITION_MAX_INTERVAL_MS)
            .optional()
            .describe('轮询间隔毫秒，默认 100，范围 50-5000'),
    })
    .refine((value) => value.text || value.selector || value.urlIncludes || value.script, {
        message: 'postCondition 至少需要 text、selector、urlIncludes、script 之一',
    })

export type PostCondition = z.infer<typeof postConditionSchema>
export type VerificationStatus = 'matched' | 'not_matched' | 'unavailable' | 'error'

interface CheckResult {
    name: string
    matched: boolean
    actual?: unknown
}

export interface PostConditionResult extends Record<string, unknown> {
    matched: boolean
    verificationStatus: VerificationStatus
    operation: string
    elapsedMs: number
    checks: CheckResult[]
    retryable: boolean
    error?: string
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + ms
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        do {
            await withNavigationBudget(
                () =>
                    new Promise<void>((resolve) => {
                        timer = setTimeout(resolve, ms)
                    }),
                undefined,
                signal
            )
            ms = deadline - Date.now()
        } while (ms > 0)
    } finally {
        clearTimeout(timer)
    }
}

function remainingMs(timeout: number, startedAt: number): number {
    return Math.max(0, timeout - (Date.now() - startedAt))
}

class PostConditionScriptError extends Error {}
class PostConditionReadError extends Error {}

function isTransientContextError(error: unknown): boolean {
    const source = getErrorSource(error)
    if (
        source === 'page' ||
        (error instanceof CDPError && (error.context.nativeCode === -32601 || error.context.nativeCode === -32602))
    ) {
        return false
    }
    const message = error instanceof Error ? error.message : String(error)
    return /FRAME_STALE_CONTEXT|execution context.*(?:destroyed|not found|invalid)|cannot find context|cannot find object|could not find object|object.*(?:not found|invalid)/i.test(
        message
    )
}

function isUnavailableError(error: unknown): boolean {
    const source = getErrorSource(error)
    if (
        error instanceof PostConditionScriptError ||
        source === 'page' ||
        (error instanceof CDPError && (error.context.nativeCode === -32601 || error.context.nativeCode === -32602))
    ) {
        return false
    }
    if (source === 'transport' || source === 'context' || source === 'budget' || source === 'cancelled') {
        return true
    }
    if (
        error instanceof CDPError &&
        ['Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.runScript'].includes(String(error.context.method)) &&
        isNativeExecutionResultUnknown(error)
    ) {
        return true
    }
    if (
        error instanceof TimeoutError ||
        (error instanceof StructuredToolError &&
            error.code === 'EXECUTION_RESULT_UNKNOWN' &&
            error.context.failureStage === 'rpc')
    ) {
        return true
    }
    const message = error instanceof Error ? error.message : String(error)
    // 原生调用失败与页面内抛出的同文案异常分别分类
    return (
        isTransientContextError(error) ||
        new RegExp(
            'FRAME_(?:STALE_CONTEXT|EVALUATION_FAILED|EVALUATION_TIMEOUT)|no frame with given id|execution context|cannot find context with specified id|debugger.*(?:detach|not attached)|' +
                'extension.*(?:disconnect|未连接)|not connected|cannot resolve cdp|' +
                'failed to attach|restricted|cannot access',
            'i'
        ).test(message)
    )
}

function boundedError(error: unknown): string {
    return sanitizeErrorMessage(error instanceof Error ? error.message : String(error)).slice(0, 500)
}

async function checkPostCondition(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    condition: PostCondition,
    timeout: number,
    mode?: InputMode
): Promise<CheckResult[]> {
    const checks: CheckResult[] = []
    const startedAt = Date.now()
    const nextTimeout = (): number => {
        const remaining = remainingMs(timeout, startedAt)
        if (remaining <= 0) {
            throw new PostConditionReadError('后置验证剩余 timeout 已用尽')
        }
        return remaining
    }
    const read = async <T>(code: string, args?: unknown[]): Promise<T> => {
        try {
            return await unifiedSession.evaluate<T>(code, mode, nextTimeout(), args, { staleContextRetry: 'readOnly' })
        } catch (error) {
            if (isTransientContextError(error)) {
                throw new PostConditionReadError(error instanceof Error ? error.message : String(error), {
                    cause: error,
                })
            }
            throw error
        }
    }

    if (condition.text !== undefined) {
        const result = await read<{ matched: boolean; actual: string }>(
            `(expected, exact) => {
                const body = document.body
                if (!body) return { matched: false, actual: '' }
                const visible = (element) => {
                    if (typeof element.checkVisibility === 'function') {
                        return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
                    }
                    const style = getComputedStyle(element)
                    return element.getClientRects().length > 0 && style.display !== 'none' &&
                        style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0'
                }
                const values = Array.from(body.querySelectorAll('input, textarea, select'))
                    .filter(visible)
                    .map((element) =>
                        element instanceof HTMLSelectElement
                            ? Array.from(element.selectedOptions)
                                .map((option) => option.value || option.textContent || '')
                                .join(' ')
                            : element instanceof HTMLInputElement && element.type === 'password'
                              ? ''
                              : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
                                ? element.value || ''
                                : '')
                const sources = [visible(body) ? body.innerText || '' : '', ...values]
                const text = sources.join('\\n')
                const matchedSource = exact ? sources.find((value) => value === expected) : undefined
                const index = exact ? (matchedSource === undefined ? -1 : text.indexOf(matchedSource)) : text.indexOf(expected)
                const start = Math.max(0, index - 120)
                return { matched: index >= 0, actual: text.slice(start, start + 500) }
            }`,
            [condition.text, condition.exact === true]
        )
        checks.push({ name: 'text', matched: result.matched, actual: result.actual })
    }
    if (condition.selector !== undefined) {
        const count = await read<number>('(selector) => document.querySelectorAll(selector).length', [
            condition.selector,
        ])
        checks.push({ name: 'selector', matched: count > 0, actual: { count } })
    }
    if (condition.urlIncludes !== undefined) {
        const url = await read<string>('location.href')
        checks.push({ name: 'urlIncludes', matched: url.includes(condition.urlIncludes), actual: url.slice(0, 500) })
    }
    if (condition.script !== undefined) {
        const result = await unifiedSession.evaluate<{ matched: boolean; error?: string }>(
            `async (source) => {
                try {
                    const value = (0, eval)(source)
                    return { matched: Boolean(await (typeof value === 'function' ? value() : value)) }
                } catch (error) {
                    let message = 'Page script threw an unprintable value'
                    try { message = String(error).slice(0, 500) } catch {}
                    return { matched: false, error: message }
                }
            }`,
            mode,
            nextTimeout(),
            [condition.script]
        )
        if (result.error !== undefined) {
            throw new PostConditionScriptError(result.error)
        }
        checks.push({ name: 'script', matched: result.matched, actual: result.matched })
    }
    return checks
}

export async function waitForPostCondition(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    condition: PostCondition,
    operation: string,
    mode?: InputMode,
    deadline?: number,
    signal?: AbortSignal
): Promise<PostConditionResult> {
    const startedAt = Date.now()
    const timeout = Math.max(
        0,
        Math.min(condition.timeout ?? POST_CONDITION_DEFAULT_TIMEOUT_MS, (deadline ?? Infinity) - startedAt)
    )
    const interval = condition.interval ?? POST_CONDITION_DEFAULT_INTERVAL_MS
    let checks: CheckResult[] = []
    let readError: string | undefined

    while (remainingMs(timeout, startedAt) > 0) {
        try {
            checks = await withNavigationBudget(
                () => checkPostCondition(unifiedSession, condition, remainingMs(timeout, startedAt), mode),
                startedAt + timeout,
                signal
            )
            readError = undefined
            if (checks.every((check) => check.matched)) {
                return {
                    matched: true,
                    verificationStatus: 'matched',
                    operation,
                    elapsedMs: Date.now() - startedAt,
                    checks,
                    retryable: false,
                }
            }
        } catch (error) {
            if (
                error instanceof PostConditionReadError ||
                (!(error instanceof PostConditionScriptError) &&
                    getErrorSource(error) !== 'page' &&
                    getErrorSource(error) !== 'protocol' &&
                    remainingMs(timeout, startedAt) === 0)
            ) {
                readError = boundedError(error)
            } else {
                const unavailable = isUnavailableError(error)
                return {
                    matched: false,
                    verificationStatus: unavailable ? 'unavailable' : 'error',
                    operation,
                    elapsedMs: Date.now() - startedAt,
                    checks,
                    retryable: unavailable,
                    error: boundedError(error),
                }
            }
        }
        const remaining = remainingMs(timeout, startedAt)
        const waitMs = Math.min(interval, remaining)
        if (waitMs > 0) {
            await sleep(waitMs, signal)
        }
        if (remaining <= interval) {
            break
        }
    }

    return {
        matched: false,
        verificationStatus: readError || timeout === 0 ? 'unavailable' : 'not_matched',
        operation,
        elapsedMs: Date.now() - startedAt,
        checks,
        retryable: true,
        ...(readError ? { error: readError } : timeout === 0 ? { error: '后置验证开始前 timeout 已用尽' } : {}),
    }
}
