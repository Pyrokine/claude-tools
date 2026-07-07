import { z } from 'zod'
import { getUnifiedSession } from '../core/index.js'

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

interface CheckResult {
    name: string
    matched: boolean
    actual?: unknown
}

interface TextCheckResult {
    matched: boolean
    actual: string
    truncated: boolean
}

class PostConditionError extends Error {
    readonly code = 'POST_CONDITION_FAILED'
    readonly suggestion =
        '工具动作已执行，但 postCondition 未满足。请检查页面状态、异步业务流程或放宽 postCondition 条件'

    constructor(readonly context: Record<string, unknown>) {
        super('postCondition 未满足，工具动作不能证明业务目标已经达成')
        this.name = 'PostConditionError'
    }

    toJSON(): object {
        return {
            error: {
                code: this.code,
                message: this.message,
                suggestion: this.suggestion,
                context: this.context,
            },
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function remainingMs(timeout: number, startedAt: number): number {
    return Math.max(0, timeout - (Date.now() - startedAt))
}

function nextCheckTimeout(timeout: number, startedAt: number): number {
    const remaining = remainingMs(timeout, startedAt)
    if (remaining <= 0) {
        throw new Error('postCondition 检查超时')
    }
    return Math.max(1, remaining)
}

async function checkPostCondition(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    condition: PostCondition,
    remainingTimeout: number
): Promise<CheckResult[]> {
    const checks: CheckResult[] = []
    const checkStartedAt = Date.now()

    if (condition.text !== undefined) {
        const result = await unifiedSession.evaluate<TextCheckResult>(
            `(expected, exact) => {
                const body = document.body
                const sampleLimit = 500
                const appendSample = (sample, value) =>
                    sample.length >= sampleLimit ? sample : sample + value.slice(0, sampleLimit - sample.length)
                const formatSample = (text) => ({
                    actual: text.length > sampleLimit ? text.slice(0, sampleLimit) + '...' : text,
                    truncated: text.length > sampleLimit,
                })
                if (!body) {
                    return { matched: false, actual: '', truncated: false }
                }

                const values = Array.from(body.querySelectorAll('input, textarea, select')).map((element) => {
                    if (element instanceof HTMLSelectElement) {
                        return Array.from(element.selectedOptions)
                            .map((option) => option.value || option.textContent || '')
                            .join(' ')
                    }
                    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
                        return element.value || ''
                    }
                    return ''
                })
                const bodyText = body.textContent || ''
                if (exact) {
                    const matched = bodyText === expected || values.some((value) => value === expected)
                    return { matched, ...formatSample([bodyText, ...values].join('\\n')) }
                }

                const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
                const segments = []
                let node = walker.nextNode()
                while (node) {
                    segments.push(node.nodeValue || '')
                    node = walker.nextNode()
                }
                segments.push(...values)
                const text = segments.join('\\n')
                return { matched: text.includes(expected), ...formatSample(text) }
            }`,
            undefined,
            nextCheckTimeout(remainingTimeout, checkStartedAt),
            [condition.text, condition.exact === true]
        )
        checks.push({
            name: 'text',
            matched: result.matched,
            actual: result.actual,
        })
    }

    if (condition.selector !== undefined) {
        const count = await unifiedSession.evaluate<number>(
            '(selector) => document.querySelectorAll(selector).length',
            undefined,
            nextCheckTimeout(remainingTimeout, checkStartedAt),
            [condition.selector]
        )
        checks.push({ name: 'selector', matched: count > 0, actual: { count } })
    }

    if (condition.urlIncludes !== undefined) {
        const url = await unifiedSession.evaluate<string>(
            'location.href',
            undefined,
            nextCheckTimeout(remainingTimeout, checkStartedAt)
        )
        checks.push({ name: 'urlIncludes', matched: url.includes(condition.urlIncludes), actual: url })
    }

    if (condition.script !== undefined) {
        const value = await unifiedSession.evaluate<unknown>(
            condition.script,
            undefined,
            nextCheckTimeout(remainingTimeout, checkStartedAt)
        )
        checks.push({ name: 'script', matched: Boolean(value), actual: value })
    }

    return checks
}

export async function waitForPostCondition(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    condition: PostCondition,
    operation: string
): Promise<Record<string, unknown>> {
    const timeout = condition.timeout ?? POST_CONDITION_DEFAULT_TIMEOUT_MS
    const interval = condition.interval ?? POST_CONDITION_DEFAULT_INTERVAL_MS
    const startedAt = Date.now()
    let lastChecks: CheckResult[] = []
    let lastError: string | undefined

    while (remainingMs(timeout, startedAt) > 0) {
        try {
            const checkTimeout = Math.max(1, Math.min(interval, remainingMs(timeout, startedAt)))
            lastChecks = await checkPostCondition(unifiedSession, condition, checkTimeout)
            lastError = undefined
            if (lastChecks.every((check) => check.matched)) {
                return {
                    matched: true,
                    operation,
                    elapsedMs: Date.now() - startedAt,
                    checks: lastChecks,
                }
            }
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
        }

        const waitMs = Math.min(interval, remainingMs(timeout, startedAt))
        if (waitMs <= 0) {
            break
        }
        await sleep(waitMs)
    }

    throw new PostConditionError({
        operation,
        timeout,
        checks: lastChecks,
        lastError,
    })
}
