import { z } from 'zod'
import { sanitizeErrorMessage } from '../core/error-sanitizer.js'
import { getUnifiedSession } from '../core/index.js'
import type { InputMode } from '../core/unified-session.js'

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

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function remainingMs(timeout: number, startedAt: number): number {
    return Math.max(0, timeout - (Date.now() - startedAt))
}

function isUnavailableError(message: string): boolean {
    return /frame|execution context|debugger|extension.*(?:disconnect|未连接)|not connected|cannot resolve cdp|failed to attach|restricted|cannot access/i.test(
        message
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
    const nextTimeout = (): number => Math.max(1, remainingMs(timeout, startedAt))

    if (condition.text !== undefined) {
        const result = await unifiedSession.evaluate<{ matched: boolean; actual: string }>(
            `(expected, exact) => {
                const body = document.body
                if (!body) return { matched: false, actual: '' }
                const values = Array.from(body.querySelectorAll('input, textarea, select')).map((element) =>
                    element instanceof HTMLSelectElement
                        ? Array.from(element.selectedOptions).map((option) => option.value || option.textContent || '').join(' ')
                        : element instanceof HTMLInputElement && element.type === 'password'
                          ? ''
                          : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
                            ? element.value || ''
                            : '')
                const text = [body.textContent || '', ...values].join('\\n')
                return { matched: exact ? [body.textContent || '', ...values].some((value) => value === expected) : text.includes(expected), actual: text.slice(0, 500) }
            }`,
            mode,
            nextTimeout(),
            [condition.text, condition.exact === true]
        )
        checks.push({ name: 'text', matched: result.matched, actual: result.actual })
    }
    if (condition.selector !== undefined) {
        const count = await unifiedSession.evaluate<number>(
            '(selector) => document.querySelectorAll(selector).length',
            mode,
            nextTimeout(),
            [condition.selector]
        )
        checks.push({ name: 'selector', matched: count > 0, actual: { count } })
    }
    if (condition.urlIncludes !== undefined) {
        const url = await unifiedSession.evaluate<string>('location.href', mode, nextTimeout())
        checks.push({ name: 'urlIncludes', matched: url.includes(condition.urlIncludes), actual: url.slice(0, 500) })
    }
    if (condition.script !== undefined) {
        const value = await unifiedSession.evaluate<unknown>(condition.script, mode, nextTimeout())
        checks.push({ name: 'script', matched: Boolean(value), actual: value })
    }
    return checks
}

export async function waitForPostCondition(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    condition: PostCondition,
    operation: string,
    mode?: InputMode
): Promise<PostConditionResult> {
    const timeout = condition.timeout ?? POST_CONDITION_DEFAULT_TIMEOUT_MS
    const interval = condition.interval ?? POST_CONDITION_DEFAULT_INTERVAL_MS
    const startedAt = Date.now()
    let checks: CheckResult[] = []

    while (remainingMs(timeout, startedAt) > 0) {
        try {
            checks = await checkPostCondition(
                unifiedSession,
                condition,
                Math.max(1, remainingMs(timeout, startedAt)),
                mode
            )
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
            const message = boundedError(error)
            return {
                matched: false,
                verificationStatus: isUnavailableError(message) ? 'unavailable' : 'error',
                operation,
                elapsedMs: Date.now() - startedAt,
                checks,
                retryable: isUnavailableError(message),
                error: message,
            }
        }
        const waitMs = Math.min(interval, remainingMs(timeout, startedAt))
        if (waitMs > 0) await sleep(waitMs)
    }

    return {
        matched: false,
        verificationStatus: 'not_matched',
        operation,
        elapsedMs: Date.now() - startedAt,
        checks,
        retryable: true,
    }
}
