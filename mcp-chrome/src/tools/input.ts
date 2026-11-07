/**
 * input 工具
 *
 * 键鼠输入：键盘、鼠标及任意组合（事件序列）
 *
 * 设计原则：
 * - 事件序列模型：所有键鼠操作本质是事件序列
 * - 支持任意组合：Ctrl+Alt+A+左键+右键+拖拽
 * - humanize 可选：行为模拟是可选功能
 */

import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { prepareUploadFiles, uploadInPage, type UploadPageResult } from '../core/file-upload.js'
import { z } from 'zod'
import { generateBezierPath, getMouseMoveDelay, getTypingDelay, randomDelay } from '../anti-detection/index.js'
import {
    BrowserError,
    ElementNotFoundError,
    getErrorPageContext,
    isNativeExecutionResultUnknown,
    StructuredToolError,
    TimeoutError,
} from '../core/errors.js'
import { formatErrorResponse, formatResponse, getSession, getUnifiedSession } from '../core/index.js'
import { DEFAULT_TIMEOUT, type InputEvent, type Target } from '../core/types.js'
import { ChallengeDeniedError, challengeResultFields, ChallengeTimeoutError, resolveChallenge } from './challenge.js'
import { appendDiagnostics, finishDiagnostics, startDiagnostics } from './diagnostics.js'
import { withPageContext } from './page-context.js'
import { postConditionSchema, waitForPostCondition } from './post-condition.js'
import {
    frameZodSchema,
    pageConditionSchema,
    pageTargetIdSchema,
    resolvePageTargetId,
    targetToFindParams,
    targetZodSchema,
} from './schema.js'
import { buildTargetDiagnostics, enrichTargetError, targetLookupTimeout } from './target-diagnostics.js'

import { installDomHelpers, type SemanticTarget } from '../core/dom-helpers.js'

const INPUT_WAIT_MAX_MS = 60_000
const TEXT_SELECTION_INPUT_TYPES = new Set(['text', 'search', 'tel', 'url', 'password'])

function throwInputTimeoutError(timeout: number): never {
    throw new Error(`input timeout before event dispatch (${timeout}ms)`)
}

function remainingInputTimeout(deadline: number): number {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
        throw new TimeoutError('input timeout during event execution')
    }
    return remaining
}

export function supportsTextSelection(tag: string, inputType?: string): boolean {
    return (
        tag.toLowerCase() === 'textarea' ||
        (tag.toLowerCase() === 'input' && TEXT_SELECTION_INPUT_TYPES.has((inputType ?? 'text').toLowerCase()))
    )
}

// noinspection JSUnusedGlobalSymbols — 回归测试从构建产物导入该 helper
export function replaceNthOccurrence(value: string, find: string, replacement: string, nth = 0): string | null {
    let index = -1
    for (let occurrence = 0; occurrence <= nth; occurrence++) {
        index = value.indexOf(find, index + (occurrence > 0 ? 1 : 0))
        if (index === -1) {
            return null
        }
    }
    return value.slice(0, index) + replacement + value.slice(index + find.length)
}

export function redactSensitiveInputData(value: unknown, sensitiveValues: readonly string[]): unknown {
    const secrets = [...new Set(sensitiveValues.filter((item) => item.length > 0))].sort(
        (left, right) => right.length - left.length
    )
    if (typeof value === 'string') {
        return secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value)
    }
    if (Array.isArray(value)) {
        return value.map((item) => redactSensitiveInputData(item, secrets))
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, redactSensitiveInputData(item, secrets)])
        )
    }
    return value
}

/**
 * InputEvent schema
 */
const inputEventSchema = z.object({
    type: z
        .enum([
            'keydown',
            'keyup',
            'click',
            'mousedown',
            'mouseup',
            'mousemove',
            'wheel',
            'touchstart',
            'touchmove',
            'touchend',
            'type',
            'upload',
            'wait',
            'select',
            'replace',
            'drag',
            'editorContext',
            'editorInsert',
            'editorCommand',
        ])
        .describe('事件类型'),
    key: z.string().optional().describe('按键（keydown/keyup）'),
    commands: z
        .array(z.string())
        .optional()
        .describe(
            '浏览器编辑命令（keydown 专用），如 selectAll、copy、paste、cut、undo、redo；' +
                '成功表示命令已分发，页面结果需用 postCondition 或 extract 验证'
        )
        .describe('用于跨平台快捷键场景，需要 inputMode=precise'),
    button: z.enum(['left', 'middle', 'right', 'back', 'forward']).optional().describe('鼠标按钮'),
    clickCount: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('鼠标点击次数（click，默认 1，设为 2 触发双击事件，设为 3 触发三击事件）'),
    target: targetZodSchema
        .optional()
        .describe(
            '目标元素（upload/mousemove/touchstart/touchmove 必填；click/mousedown/wheel/type/drag 可选；' +
                'select/replace 可选；drag 时为拖拽源；upload 支持隐藏文件控件）'
        ),
    to: targetZodSchema.optional().describe('拖拽目标元素（drag 事件必填）'),
    steps: z.number().optional().describe('移动步数（mousemove/touchmove）'),
    deltaX: z.number().optional().describe('水平滚动量'),
    deltaY: z.number().optional().describe('垂直滚动量'),
    text: z.string().max(10000).optional().describe('输入文本（type，最大 10000 字符）或替换文本（replace）'),
    files: z
        .array(z.string().min(1))
        .optional()
        .describe('upload 的 Server 本地文件路径，支持绝对、相对和 ~/ 路径；总大小须小于 50 MiB，空数组清空选择'),
    delay: z.number().min(0).max(100).optional().describe('按键间隔毫秒（type 事件最大 100ms，避免长时延 DoS）'),
    ms: z
        .number()
        .int()
        .min(0)
        .max(INPUT_WAIT_MAX_MS)
        .optional()
        .describe('等待毫秒（wait 事件最大 60000ms，且不能超过 input 剩余 timeout）'),
    find: z.string().optional().describe('要查找并选中的文本（select/replace）'),
    nth: z.number().optional().describe('第 N 个匹配（select/replace，从 0 开始，默认 0 即第一个）'),
    command: z.string().optional().describe('浏览器编辑命令（editorCommand），如 bold、italic、insertOrderedList'),
    mode: z
        .enum(['keyboard', 'controlled'])
        .optional()
        .describe(
            '输入模式（type），默认 keyboard；precise 键盘换行会派发 Enter 并触发页面 Enter 行为；' +
                'controlled 替换完整文本并触发 input/change，不派发 Enter，需 Extension 和 target；选区插入用 editorInsert'
        ),
    dispatch: z
        .boolean()
        .optional()
        .describe(
            'controlled 模式别名（type），替换完整文本并触发 input/change，不派发 Enter；默认 false 使用键盘事件，precise 换行会派发 Enter'
        ),
    force: z
        .boolean()
        .optional()
        .describe(
            '强制执行（click），跳过可操作性检查（可见性、遮挡检测等），直接在目标元素上触发事件，用于已知需要绕过检查的场景'
        ),
    forceReason: z.string().optional().describe('force=true 时必填，说明为什么需要跳过可操作性检查'),
})

/**
 * input 参数 schema
 */
const inputSchema = z.object({
    ...pageConditionSchema,
    events: z.array(inputEventSchema).describe('事件序列'),
    humanize: z.boolean().optional().describe('启用人类行为模拟（贝塞尔曲线移动、随机延迟）'),
    diagnostics: z
        .boolean()
        .optional()
        .describe(
            '执行后返回新增 console error/warning 和失败网络请求摘要。访问 Cloudflare 页面时默认不传；开启后会启用 debugger 日志采集'
        ),
    postCondition: postConditionSchema
        .optional()
        .describe('动作执行后要验证的页面状态；不传时 success 只表示事件已发出，不表示业务结果已达成'),
    targetId: pageTargetIdSchema.describe('目标页面 ID（Extension 或 CDP），优先于默认操作目标'),
    tabId: pageTargetIdSchema.describe('旧版目标 Tab ID，与 targetId 相同语义，保留兼容'),
    timeout: z
        .number()
        .optional()
        .describe(
            '超时毫秒，含 Cloudflare Challenge 等待、目标准备、鼠标移动、字符输入和延迟；到期后停止后续动作，不自动重放'
        ),
    frame: frameZodSchema.describe('iframe selector／索引或逐层路径（如 ["iframe#outer", 0]），省略时使用主文档'),
})

type InputToolResponse = {
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
}

function sanitizeInputResponse(
    response: InputToolResponse,
    events: ReadonlyArray<{ find?: string; text?: string; files?: string[] }>,
    sensitiveInput: boolean
): InputToolResponse {
    if (!response.isError && !sensitiveInput) {
        return response
    }
    const sensitiveValues = events
        .flatMap((event) => [event.find, event.text, ...(event.files ?? []).filter((path) => /[/\\]/.test(path))])
        .filter((value): value is string => !!value)
    for (const item of response.content) {
        try {
            const payload = JSON.parse(item.text) as Record<string, unknown>
            for (const key of ['warnings', 'eventResults', 'diagnostics', 'diagnosticsError']) {
                if (key in payload) {
                    payload[key] = redactSensitiveInputData(payload[key], sensitiveValues)
                }
            }
            const pageContext = payload.pageContext as Record<string, unknown> | undefined
            const postCondition = payload.postCondition as Record<string, unknown> | undefined
            const details = [
                payload.error,
                pageContext,
                pageContext?.before,
                pageContext?.after,
                postCondition,
                ...(Array.isArray(postCondition?.checks) ? postCondition.checks : []),
            ]
            for (const detail of details) {
                if (!detail || typeof detail !== 'object') {
                    continue
                }
                const record = detail as Record<string, unknown>
                for (const key of [
                    'message',
                    'suggestion',
                    'context',
                    'logs',
                    'contextError',
                    'url',
                    'title',
                    'actual',
                    'error',
                ]) {
                    if (key in record) {
                        record[key] = redactSensitiveInputData(record[key], sensitiveValues)
                    }
                }
            }
            if (sensitiveInput) {
                if (payload.diagnostics) {
                    payload.diagnostics = { redacted: true, reason: 'sensitive_input_or_unresolved_target' }
                }
                if (payload.diagnosticsError) {
                    payload.diagnosticsError = '敏感输入的诊断详情已隐藏'
                }
            }
            item.text = JSON.stringify(payload, null, 2)
        } catch {
            item.text = redactSensitiveInputData(item.text, sensitiveValues) as string
        }
    }
    return response
}

/**
 * input 工具处理器
 */
async function handleInput(args: z.infer<typeof inputSchema>, signal?: AbortSignal): Promise<InputToolResponse> {
    const inputStartedAt = Date.now()
    const deadline = args.timeout === undefined ? undefined : inputStartedAt + args.timeout
    let eventsExecuted = 0
    let actionMayHaveExecuted = false
    let actionExecutedUnknown = false
    let challengeFields: Record<string, unknown> = {}
    const privacy = { sensitive: false }
    const progress: { actionStatus: 'not_started' | 'failed' | 'unknown' | 'completed' } = {
        actionStatus: 'not_started',
    }
    let failureStage: 'action' | 'verification' | 'context' = 'action'
    try {
        if (args.events.length === 0) {
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            error: {
                                code: 'INVALID_ARGUMENT',
                                message: 'events 至少需要一个事件，未执行输入操作',
                            },
                            actionExecuted: false,
                            actionStatus: 'failed',
                        }),
                    },
                ],
                isError: true,
            }
        }
        const unifiedSession = getUnifiedSession()
        const humanize = args.humanize ?? false

        const response = await withPageContext(
            unifiedSession,
            resolvePageTargetId(args),
            async () => {
                return unifiedSession.withPageCondition(
                    args,
                    () =>
                        unifiedSession.withFrame(
                            args.frame,
                            async () => {
                                const mode = unifiedSession.getMode()
                                if (args.expectedUrl === undefined && args.expectedRevision === undefined) {
                                    challengeFields = challengeResultFields(
                                        await resolveChallenge(
                                            unifiedSession,
                                            'input',
                                            'not_started',
                                            deadline === undefined ? undefined : remainingInputTimeout(deadline)
                                        )
                                    )
                                }
                                const diagnostics = await startDiagnostics(unifiedSession, args.diagnostics, deadline)
                                const warnings: string[] = []
                                const eventResults: unknown[] = []
                                const session = mode === 'cdp' ? getSession() : undefined

                                try {
                                    await unifiedSession.withInputCleanup(async () => {
                                        for (const event of args.events) {
                                            unifiedSession.assertRequestActive()
                                            const eventTimeout =
                                                args.timeout === undefined
                                                    ? undefined
                                                    : Math.max(0, args.timeout - (Date.now() - inputStartedAt))
                                            if (eventTimeout !== undefined && eventTimeout <= 0) {
                                                throwInputTimeoutError(args.timeout!)
                                            }
                                            progress.actionStatus = 'failed'
                                            const result = await unifiedSession.withUserAction(
                                                'input',
                                                () =>
                                                    executeInputEvent(
                                                        {
                                                            unifiedSession,
                                                            session,
                                                            mode,
                                                            humanize,
                                                            timeout: eventTimeout,
                                                            frame: args.frame,
                                                            signal,
                                                            privacy,
                                                        },
                                                        event as InputEvent
                                                    ),
                                                event.type === 'keydown' &&
                                                    Boolean(event.commands?.length) &&
                                                    event.target !== undefined &&
                                                    'x' in event.target &&
                                                    'y' in event.target
                                            )
                                            ++eventsExecuted
                                            if (typeof result === 'string') {
                                                warnings.push(result)
                                            } else if (result) {
                                                eventResults.push(result)
                                            }
                                        }
                                        progress.actionStatus = 'completed'
                                    })
                                } catch (error) {
                                    const response = formatErrorResponse(error)
                                    const text = response.content[0]?.text
                                    if (
                                        (error instanceof ChallengeTimeoutError ||
                                            error instanceof ChallengeDeniedError) &&
                                        text
                                    ) {
                                        try {
                                            const payload = JSON.parse(text) as Record<string, unknown>
                                            Object.assign(payload, {
                                                eventsExecuted,
                                                remainingEventsNotExecuted: args.events.length - eventsExecuted,
                                                verificationRequested: Boolean(args.postCondition),
                                            })
                                            appendDiagnostics(
                                                payload,
                                                await finishDiagnostics(unifiedSession, diagnostics, deadline)
                                            )
                                            response.content[0].text = JSON.stringify(payload, null, 2)
                                        } catch {
                                            // 保留原始 Challenge 错误响应
                                        }
                                        return response
                                    }
                                    if (text) {
                                        try {
                                            const payload = JSON.parse(text) as Record<string, unknown>
                                            const message = error instanceof Error ? error.message : String(error)
                                            const timedOut = /timeout|超时/i.test(message)
                                            const preActionTimeout = /timeout.*before|超过 input 剩余 timeout/i.test(
                                                message
                                            )
                                            actionMayHaveExecuted =
                                                isNativeExecutionResultUnknown(error) || (timedOut && !preActionTimeout)
                                            const preconditionFailed =
                                                error !== null &&
                                                typeof error === 'object' &&
                                                'code' in error &&
                                                error.code === 'ACTION_PRECONDITION_FAILED'
                                            const executionContext =
                                                error instanceof StructuredToolError || error instanceof BrowserError
                                                    ? error.context
                                                    : undefined
                                            const contextPhase = getErrorPageContext(error)?.contextPhase
                                            const preparationFailure =
                                                contextPhase === 'preparation' || contextPhase === 'precondition'
                                            const explicitNotStarted =
                                                preparationFailure || executionContext?.actionExecuted === false
                                            actionExecutedUnknown =
                                                !explicitNotStarted && executionContext?.actionExecuted === 'unknown'
                                            actionMayHaveExecuted =
                                                (actionMayHaveExecuted ||
                                                    actionExecutedUnknown ||
                                                    executionContext?.actionExecuted === true) &&
                                                !preconditionFailed &&
                                                !explicitNotStarted
                                            const cleanupFailure = progress.actionStatus === 'completed'
                                            const keyboardFocusCleanup =
                                                getErrorPageContext(error)?.keyboardFocusCleanup ??
                                                executionContext?.keyboardFocusCleanup
                                            if (keyboardFocusCleanup) {
                                                payload.keyboardFocusCleanup = keyboardFocusCleanup
                                            }
                                            const keyboardWarning = getErrorPageContext(error)?.keyboardFocusWarning
                                            if (
                                                typeof keyboardWarning === 'string' &&
                                                !warnings.includes(keyboardWarning)
                                            ) {
                                                warnings.push(keyboardWarning)
                                            }
                                            if (warnings.length) {
                                                payload.warnings = warnings
                                            }
                                            if (cleanupFailure) {
                                                actionMayHaveExecuted = true
                                            }
                                            progress.actionStatus = cleanupFailure
                                                ? 'completed'
                                                : (preconditionFailed ||
                                                        preparationFailure ||
                                                        (explicitNotStarted &&
                                                            executionContext?.actionStatus === 'not_started')) &&
                                                    eventsExecuted === 0
                                                  ? 'not_started'
                                                  : actionMayHaveExecuted && executionContext?.actionStatus !== 'failed'
                                                    ? 'unknown'
                                                    : 'failed'
                                            payload.eventsExecuted = eventsExecuted
                                            payload.actionExecuted =
                                                eventsExecuted > 0
                                                    ? true
                                                    : actionExecutedUnknown
                                                      ? 'unknown'
                                                      : actionMayHaveExecuted
                                            payload.actionStatus = progress.actionStatus
                                            payload.verificationRequested = Boolean(args.postCondition)
                                            payload.verificationStatus = 'unavailable'
                                            if (preparationFailure) {
                                                payload.remainingEventsNotExecuted = args.events.length - eventsExecuted
                                            }
                                            payload.failureStage = preparationFailure
                                                ? contextPhase === 'precondition'
                                                    ? 'precondition'
                                                    : 'context'
                                                : (executionContext?.failureStage ?? 'action')
                                            payload.retryable =
                                                !preparationFailure &&
                                                executionContext?.retryable !== false &&
                                                eventsExecuted === 0 &&
                                                !actionMayHaveExecuted &&
                                                /timeout|超时|disconnect|未连接|context|debugger/i.test(message)
                                            appendDiagnostics(
                                                payload,
                                                await finishDiagnostics(unifiedSession, diagnostics, deadline)
                                            )
                                            response.content[0].text = JSON.stringify(payload, null, 2)
                                        } catch {
                                            // 保留原始错误响应
                                        }
                                    }
                                    return response
                                }

                                progress.actionStatus = 'completed'
                                failureStage = 'verification'
                                if (deadline === undefined || Date.now() < deadline) {
                                    Object.assign(
                                        challengeFields,
                                        challengeResultFields(
                                            await resolveChallenge(
                                                unifiedSession,
                                                'input',
                                                'completed',
                                                deadline === undefined ? undefined : remainingInputTimeout(deadline)
                                            )
                                        )
                                    )
                                } else {
                                    Object.assign(challengeFields, {
                                        challengeVerificationStatus: 'unavailable',
                                        challengeVerificationError: '输入已确认完成，剩余 timeout 已用尽',
                                    })
                                }
                                failureStage = 'context'
                                const result: Record<string, unknown> = {
                                    ...challengeFields,
                                    success: true,
                                    eventsExecuted,
                                    mode,
                                    actionExecuted: true,
                                    actionStatus: 'completed',
                                    verificationRequested: Boolean(args.postCondition),
                                    verificationStatus: 'unavailable',
                                    retryable: false,
                                }
                                if (warnings.length > 0) {
                                    result.warnings = warnings
                                }
                                if (eventResults.length > 0) {
                                    result.eventResults = eventResults
                                }
                                if (args.postCondition) {
                                    failureStage = 'verification'
                                    const postCondition = await waitForPostCondition(
                                        unifiedSession,
                                        args.postCondition,
                                        'input',
                                        undefined,
                                        deadline,
                                        signal
                                    )
                                    failureStage = 'context'
                                    result.postCondition = postCondition
                                    result.verificationStatus = postCondition.verificationStatus
                                    if (postCondition.verificationStatus !== 'matched') {
                                        result.success = false
                                        result.failureStage = 'verification'
                                    }
                                }
                                appendDiagnostics(
                                    result,
                                    await finishDiagnostics(unifiedSession, diagnostics, deadline)
                                )
                                return formatResponse(result)
                            },
                            deadline
                        ),
                    deadline
                ) // withPageCondition, withFrame, withInputCleanup
            },
            deadline,
            signal,
            'input'
        ) // withTabId
        return sanitizeInputResponse(response, args.events, privacy.sensitive)
    } catch (error) {
        const response = formatErrorResponse(error)
        const text = response.content[0]?.text
        if (text) {
            try {
                const payload = JSON.parse(text) as Record<string, unknown>
                const message = error instanceof Error ? error.message : String(error)
                const unavailableCondition =
                    eventsExecuted === 0 &&
                    !actionMayHaveExecuted &&
                    progress.actionStatus === 'not_started' &&
                    error instanceof StructuredToolError &&
                    error.code === 'DRIVER_CAPABILITY_ERROR' &&
                    error.context.actionExecuted === false &&
                    error.context.actionStatus === 'not_started' &&
                    error.context.failureStage === 'precondition'
                const preconditionFailed =
                    unavailableCondition ||
                    (error !== null &&
                        typeof error === 'object' &&
                        'code' in error &&
                        error.code === 'ACTION_PRECONDITION_FAILED')
                const executionContext =
                    error instanceof StructuredToolError || error instanceof BrowserError ? error.context : undefined
                const challengeFailure =
                    error instanceof ChallengeTimeoutError || error instanceof ChallengeDeniedError ? error : null
                const contextPhase = getErrorPageContext(error)?.contextPhase
                const preparationFailure =
                    progress.actionStatus === 'not_started' &&
                    (contextPhase === 'before' || contextPhase === 'precondition' || contextPhase === 'preparation')
                Object.assign(payload, {
                    ...challengeFields,
                    eventsExecuted,
                    remainingEventsNotExecuted: args.events.length - eventsExecuted,
                    actionExecuted: preparationFailure
                        ? false
                        : eventsExecuted > 0
                          ? true
                          : actionExecutedUnknown || executionContext?.actionExecuted === 'unknown'
                            ? 'unknown'
                            : executionContext?.actionExecuted === true || actionMayHaveExecuted,
                    actionStatus: preparationFailure
                        ? 'not_started'
                        : progress.actionStatus === 'completed'
                          ? 'completed'
                          : preconditionFailed && eventsExecuted === 0
                            ? 'not_started'
                            : challengeFailure
                              ? challengeFailure.actionStatus
                              : (executionContext?.actionStatus ??
                                (progress.actionStatus === 'not_started' ? 'failed' : progress.actionStatus)),
                    verificationRequested: Boolean(args.postCondition),
                    verificationStatus: challengeFailure
                        ? payload.verificationStatus
                        : (executionContext?.verificationStatus ?? 'unavailable'),
                    failureStage: preparationFailure
                        ? contextPhase === 'precondition'
                            ? 'precondition'
                            : 'context'
                        : unavailableCondition
                          ? 'precondition'
                          : (executionContext?.failureStage ?? failureStage),
                    retryable:
                        !preparationFailure &&
                        executionContext?.retryable !== false &&
                        progress.actionStatus !== 'completed' &&
                        eventsExecuted === 0 &&
                        !actionMayHaveExecuted &&
                        !preconditionFailed &&
                        /timeout|超时|disconnect|未连接|context|debugger|attach/i.test(message),
                    diagnosticsStatus: args.diagnostics ? 'unavailable' : 'disabled',
                })
                if (args.diagnostics) {
                    payload.diagnosticsError =
                        eventsExecuted > 0 || actionMayHaveExecuted
                            ? 'input 执行后未能取得 diagnostics'
                            : 'diagnostics 未能在 tab/frame 初始化失败前启动'
                }
                response.content[0].text = JSON.stringify(payload, null, 2)
            } catch {
                // 保留原始错误响应
            }
        }
        return sanitizeInputResponse(response, args.events, privacy.sensitive)
    }
}

/**
 * 文本坐标定位结果
 *
 * DOM 文本节点返回字符坐标（用于鼠标选择）；
 * input/textarea 返回 selectionRange 索引（用于 setSelectionRange）
 */
type TextLocateResult =
    | {
          type: 'coords'
          startX: number
          startY: number
          endX: number
          endY: number
          /** 被替换文本是否被格式化标签包裹（如 <code>、<strong>） */
          formatted?: string
      }
    | {
          type: 'range'
          formatted?: string
      }

interface InputLocateResult {
    type: 'input'
    inputType: string
    selectionStart: number
    selectionEnd: number
}

interface TextSelectionDiagnostics {
    scope: Record<string, unknown>
    activeElement: Record<string, unknown> | null
    selection: Record<string, unknown>
    candidates: Array<Record<string, unknown>>
}

type InputEventResult = string | Record<string, unknown> | undefined

interface InputExecutionContext {
    unifiedSession: ReturnType<typeof getUnifiedSession>
    session?: ReturnType<typeof getSession>
    mode: ReturnType<ReturnType<typeof getUnifiedSession>['getMode']>
    humanize: boolean
    timeout?: number
    frame?: import('../core/browser-driver.js').FrameSelection
    signal?: AbortSignal
    privacy?: { sensitive: boolean }
}

const unifiedOnlyEventTypes = new Set<InputEvent['type']>([
    'upload',
    'keydown',
    'keyup',
    'select',
    'replace',
    'editorContext',
    'editorInsert',
    'editorCommand',
])

async function executeInputEvent(context: InputExecutionContext, event: InputEvent): Promise<InputEventResult> {
    const timeout = context.timeout ?? DEFAULT_TIMEOUT
    const deadline = Date.now() + timeout
    try {
        if (context.mode === 'extension' || unifiedOnlyEventTypes.has(event.type)) {
            return await executeUnifiedEvent(
                {
                    unifiedSession: context.unifiedSession,
                    session: context.session,
                    mode: context.mode,
                    humanize: context.humanize,
                    timeout: context.timeout,
                    frame: context.frame,
                    signal: context.signal,
                    privacy: context.privacy,
                },
                event
            )
        }
        if (!context.session) {
            // noinspection ExceptionCaughtLocallyJS -- Report failure
            throw new Error('CDP 输入事件缺少 session')
        }
        await executeCdpEvent(context.session, event, context.humanize, context.timeout)
        return undefined
    } catch (error) {
        if (context.mode === 'cdp' && error instanceof ElementNotFoundError) {
            const target = error.context.target as Target
            await enrichTargetError(error, context.unifiedSession, target, { timeout, deadline, frame: context.frame })
        }
        throw error
    }
}

/**
 * 通过真实鼠标事件选中页面文本
 *
 * 两种策略：
 * - DOM 文本节点：TreeWalker + Range API 获取字符坐标 → Click + Shift+Click 模拟选区
 * - input/textarea：聚焦元素 → setSelectionRange() 直接设置选区
 *
 * @returns 格式化标签名（如 "code"），若被替换文本在格式化节点内
 */
/**
 * 命令与 editor 目标只定位并聚焦，不派发鼠标事件
 */
async function focusTargetForCommands(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    target: Target,
    timeout?: number,
    frame?: import('../core/browser-driver.js').FrameSelection
): Promise<void> {
    const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)
    if (unifiedSession.getMode() === 'cdp') {
        await focusCdpTarget(getSession(), target, remainingInputTimeout(deadline))
        return
    }
    const params = targetToFindParams(target as Target & { nth?: number })
    const nth0 = params.nth ?? 0
    const els =
        'x' in target && 'y' in target
            ? await unifiedSession.findAtPoint(target.x, target.y, nth0, remainingInputTimeout(deadline))
            : await unifiedSession.find(
                  params.selector,
                  params.text,
                  params.xpath,
                  remainingInputTimeout(deadline),
                  params.semantic,
                  nth0
              )
    if (els.length === 0) {
        throw new StructuredToolError(
            nth0 === 0 ? 'TARGET_NOT_FOUND' : 'TARGET_INDEX_OUT_OF_RANGE',
            `第 ${nth0} 个命令目标不存在: ${JSON.stringify(target)}`,
            '请检查 target、frame 和 target.nth，或先用 extract type=state 查看当前候选元素',
            await buildTargetDiagnosticContext(
                unifiedSession,
                target,
                null,
                nth0,
                remainingInputTimeout(deadline),
                '命令目标未找到',
                frame
            )
        )
    }
    const focused = await unifiedSession.evaluate(
        `(() => {
            if (Date.now() >= ${deadline}) throw new Error('input timeout before command focus')
            const ref = window.__mcpElementMap?.[${JSON.stringify(els[0].refId)}]
            const el = ref?.deref()
            if (!(el instanceof HTMLElement)) {
                return false
            }
            (${installDomHelpers.toString()})();
            el.focus({preventScroll: true})
            return globalThis.__mcpDomHelpers.activeElement() === el
        })()`,
        undefined,
        remainingInputTimeout(deadline)
    )
    if (focused !== true) {
        throw new StructuredToolError(
            'TARGET_FOCUS_FAILED',
            '命令目标未成功聚焦',
            '请检查目标是否可编辑、未 disabled 并处于正确 frame',
            await buildTargetDiagnosticContext(
                unifiedSession,
                target,
                null,
                nth0,
                remainingInputTimeout(deadline),
                '命令目标聚焦失败',
                frame
            )
        )
    }
}

export async function focusCdpTarget(
    session: ReturnType<typeof getSession>,
    target: Target,
    timeout?: number
): Promise<void> {
    const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)
    const focus = `function() {
        if (Date.now() >= ${deadline}) throw new Error('input timeout before command focus');
        if (!(this instanceof HTMLElement)) return false;
        (${installDomHelpers.toString()})();
        this.focus({preventScroll: true});
        return globalThis.__mcpDomHelpers.activeElement() === this;
    }`
    const focused =
        'x' in target && 'y' in target
            ? await session.evaluate<boolean | null>(
                  `(() => {
                      (${installDomHelpers.toString()})();
                      const el = globalThis.__mcpDomHelpers.deepElementFromPoint(${target.x}, ${target.y});
                      return el ? (${focus}).call(el) : null;
                  })()`,
                  undefined,
                  remainingInputTimeout(deadline)
              )
            : await session
                  .createLocator(target, { timeout: targetLookupTimeout(remainingInputTimeout(deadline)) })
                  .evaluateOn<boolean>(focus)
    if (focused === null) {
        throw new StructuredToolError('TARGET_NOT_FOUND', '目标坐标未命中元素', '请检查目标坐标是否在当前页面视口内', {
            target,
        })
    }
    if (!focused) {
        throw new StructuredToolError(
            'TARGET_FOCUS_FAILED',
            '目标元素未成功聚焦',
            '请检查目标是否可聚焦、未 disabled，并确认 target 指向当前页面元素',
            { target }
        )
    }
}

async function focusTargetIfNeeded(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    session: ReturnType<typeof getSession> | undefined,
    mode: InputExecutionContext['mode'],
    target: Target | undefined,
    timeout?: number,
    frame?: import('../core/browser-driver.js').FrameSelection
): Promise<void> {
    if (!target) {
        return
    }
    const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)
    if ('x' in target || 'y' in target) {
        await handleUnifiedClick(
            {
                unifiedSession,
                mode: unifiedSession.getMode(),
                humanize: false,
                timeout: remainingInputTimeout(deadline),
                frame,
            },
            { type: 'click', target }
        )
        return
    }
    if (mode === 'cdp') {
        if (!session) {
            throw new Error('CDP locator 聚焦缺少 session')
        }
        await focusCdpTarget(session, target, remainingInputTimeout(deadline))
        return
    }
    const params = targetToFindParams(target as Target & { nth?: number })
    const nth0 = params.nth ?? 0
    const els = await unifiedSession.find(
        params.selector,
        params.text,
        params.xpath,
        remainingInputTimeout(deadline),
        params.semantic,
        nth0
    )
    if (els.length === 0) {
        throw new StructuredToolError(
            nth0 === 0 ? 'TARGET_NOT_FOUND' : 'TARGET_INDEX_OUT_OF_RANGE',
            `第 ${nth0} 个匹配元素不存在: ${JSON.stringify(target)}`,
            '请检查 target、frame 和 target.nth，或先用 extract type=state 查看当前候选元素',
            await buildTargetDiagnosticContext(unifiedSession, target, null, nth0, timeout, '聚焦目标未找到', frame)
        )
    }
    remainingInputTimeout(deadline)
    const result = await unifiedSession.actionableClick(els[0].refId)
    if (!result.success) {
        throw new StructuredToolError(
            'ACTIONABILITY_FAILED',
            result.error || '目标元素无法聚焦',
            result.suggestions?.[0] ?? '请检查元素是否可见、未被遮挡并处于正确 frame',
            {
                ...result,
                ...(await buildTargetDiagnosticContext(
                    unifiedSession,
                    target,
                    null,
                    nth0,
                    timeout,
                    result.error || '目标元素无法聚焦',
                    frame
                )),
            }
        )
    }
}

async function collectTextSelectionDiagnostics(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    findText: string,
    scopeTarget: Target | undefined,
    occurrenceNth: number,
    scopeNth: number,
    scopeSelector: string | null,
    scopeText: string | null,
    scopeXpath: string | null,
    scopeSemantic: SemanticTarget | null,
    timeout?: number
): Promise<TextSelectionDiagnostics> {
    return await unifiedSession.evaluate<TextSelectionDiagnostics>(
        `function(findText, occurrenceNth, scopeNth, scopeTarget, scopeSelector, scopeText, scopeXpath, scopeSemantic) {
        (${installDomHelpers.toString()})();
        var helpers = globalThis.__mcpDomHelpers;
        function selectorFor(el) {
            if (!(el instanceof Element)) return null;
            if (el.id) return '#' + CSS.escape(el.id);
            var parts = [];
            var current = el;
            while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
                var part = current.tagName.toLowerCase();
                if (current.classList && current.classList.length) {
                    part += '.' + Array.from(current.classList)
                        .slice(0, 2)
                        .map(function(cls) { return CSS.escape(cls); })
                        .join('.');
                }
                var parent = current.parentElement;
                if (parent) {
                    var siblings = Array.from(parent.children).filter(function(child) {
                        return child.tagName === current.tagName;
                    });
                    if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
                }
                parts.unshift(part);
                current = parent;
            }
            return parts.join(' > ');
        }
        function summarizeElement(el) {
            if (!(el instanceof Element)) return null;
            var rect = el.getBoundingClientRect();
            var value = 'value' in el ? String(el.value || '') : '';
            var inputType = el instanceof HTMLInputElement ? (el.type || 'text').toLowerCase() : undefined;
            var sensitive = inputType === 'password';
            var text = sensitive
                ? (el.innerText || el.textContent || '')
                : (el.innerText || el.textContent || value || '');
            text = text.replace(new RegExp('\\\\s+', 'g'), ' ').trim();
            return {
                tag: el.tagName.toLowerCase(),
                id: el.id || undefined,
                selector: selectorFor(el),
                inputType: inputType,
                text: text ? text.slice(0, 160) : undefined,
                valuePreview: !sensitive && value ? value.slice(0, 160) : undefined,
                valueLength: value.length,
                hasValue: value.length > 0,
                redacted: sensitive || undefined,
                visible: rect.width > 0 && rect.height > 0,
                disabled: Boolean(el.disabled),
                readOnly: Boolean(el.readOnly),
                contentEditable: Boolean(el.isContentEditable),
                bounds: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}
            };
        }
        var root = document.body;
        if (scopeXpath || scopeSelector || scopeText || scopeSemantic) {
            root = helpers.query({
                selector:scopeSelector, text:scopeText, xpath:scopeXpath, semantic:scopeSemantic
            })[scopeNth];
        }
        var candidateElements = [];
        if (root instanceof Element) {
            candidateElements.push(root);
            var candidateSelector =
                'input, textarea, [contenteditable="true"], [role="textbox"], button, a';
            candidateElements = candidateElements.concat(
                helpers.query({selector:candidateSelector}, root).slice(0, 12)
            );
        }
        var active = helpers.activeElement();
        var activeIsPassword =
            active instanceof HTMLInputElement &&
            (active.type || 'text').toLowerCase() === 'password';
        var selection = window.getSelection();
        return {
            scope: {
                target: scopeTarget,
                targetNth: scopeNth,
                occurrenceNth: occurrenceNth,
                findLength: findText.length,
                selector: scopeSelector,
                text: scopeText,
                xpath: scopeXpath,
                rootFound: Boolean(root)
            },
            activeElement: summarizeElement(active),
            selection: {
                text: activeIsPassword ? undefined : (selection ? selection.toString().slice(0, 160) : ''),
                textLength: selection ? selection.toString().length : 0,
                redacted: activeIsPassword || undefined,
                collapsed: selection ? selection.isCollapsed : true,
                anchorNode: selection && selection.anchorNode ? selection.anchorNode.nodeName : null,
                focusNode: selection && selection.focusNode ? selection.focusNode.nodeName : null,
                inputSelection: active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') ? {
                    selectionStart: active.selectionStart,
                    selectionEnd: active.selectionEnd,
                    valuePreview: activeIsPassword ? undefined : String(active.value || '').slice(0, 160),
                    valueLength: String(active.value || '').length,
                    redacted: activeIsPassword || undefined
                } : undefined
            },
            candidates: candidateElements.map(summarizeElement).filter(Boolean)
        };
    }`,
        undefined,
        timeout,
        [findText, occurrenceNth, scopeNth, scopeTarget ?? null, scopeSelector, scopeText, scopeXpath, scopeSemantic]
    )
}

async function selectText(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    findText: string,
    scopeTarget?: Target,
    nth = 0,
    timeout?: number,
    privacy?: InputExecutionContext['privacy']
): Promise<string | undefined> {
    const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)
    const sensitiveBefore = privacy?.sensitive ?? false
    if (privacy) {
        privacy.sensitive = true
    }
    // 将 target 转为查询参数，传入注入脚本进行 DOM 查询
    let scopeSelector: string | null = null
    let scopeText: string | null = null
    let scopeXpath: string | null = null
    let scopeSemantic: SemanticTarget | null = null
    let scopeNth = 0
    if (scopeTarget && !('x' in scopeTarget) && !('y' in scopeTarget)) {
        const params = targetToFindParams(scopeTarget as Target & { nth?: number })
        scopeSelector = params.selector ?? null
        scopeText = params.text ?? null
        scopeXpath = params.xpath ?? null
        scopeSemantic = params.semantic ?? null
        scopeNth = params.nth ?? 0
    }

    // Step 1: 注入脚本定位文本
    //noinspection SpellCheckingInspection -- 模板中的坐标字段名
    const result = await unifiedSession.evaluate<
        | TextLocateResult
        | InputLocateResult
        | { type: 'notfound'; inputType?: string }
        | { type: 'unsupported'; tag: string; inputType: string; currentValue: string }
        | {
              type: 'noscope'
          }
        | null
    >(
        `function(findText, nth, scopeNth, scopeSelector, scopeText, scopeXpath, scopeSemantic) {
        (${installDomHelpers.toString()})();
        var helpers = globalThis.__mcpDomHelpers;
        // 确定搜索根节点
        var root = document.body;
        if (scopeXpath || scopeSelector || scopeText || scopeSemantic) {
            root = helpers.query({
                selector:scopeSelector, text:scopeText, xpath:scopeXpath, semantic:scopeSemantic
            })[scopeNth];
        }
        if (!root) return {type: 'noscope'};

        // input/textarea：value 不在 DOM 文本节点中
        var tag = root.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
            var val = root.value || '';
            var inputType = tag === 'INPUT' ? (root.type || 'text').toLowerCase() : 'textarea';
            var selectionCapable =
                tag === 'TEXTAREA' ||
                ['text', 'search', 'tel', 'url', 'password'].indexOf(inputType) !== -1;
            if (!selectionCapable) {
                return {
                    type: 'unsupported',
                    tag: tag.toLowerCase(),
                    inputType: inputType,
                    currentValue: String(val).slice(0, 160)
                };
            }
            var pos = -1;
            for (var n = 0; n <= nth; n++) {
                pos = val.indexOf(findText, pos + (n > 0 ? 1 : 0));
                if (pos === -1) return {type: 'notfound', inputType: inputType};
            }
            // 原子化：定位到 input 同时完成 focus + setSelectionRange，避免外层 mouseClick 聚焦不可靠
            root.focus();
            root.setSelectionRange(pos, pos + findText.length);
            return {type: 'input', inputType: inputType, selectionStart: pos, selectionEnd: pos + findText.length};
        }

        // 在子树中查找 input/textarea
        var inputs = helpers.query({selector:'input, textarea'}, root);
        for (var k = 0; k < inputs.length; k++) {
            var inp = inputs[k];
            var v = inp.value || '';
            var childType = inp.tagName === 'INPUT' ? (inp.type || 'text').toLowerCase() : 'textarea';
            var childSelectionCapable =
                inp.tagName === 'TEXTAREA' ||
                ['text', 'search', 'tel', 'url', 'password'].indexOf(childType) !== -1;
            var ip = -1;
            for (var n2 = 0; n2 <= nth; n2++) {
                ip = v.indexOf(findText, ip + (n2 > 0 ? 1 : 0));
                if (ip === -1) break;
            }
            if (ip !== -1 && !childSelectionCapable) {
                return {
                    type: 'unsupported',
                    tag: inp.tagName.toLowerCase(),
                    inputType: childType,
                    currentValue: String(v).slice(0, 160)
                };
            }
            if (ip !== -1) {
                inp.focus();
                inp.setSelectionRange(ip, ip + findText.length);
                return {type: 'input', inputType: childType, selectionStart: ip, selectionEnd: ip + findText.length};
            }
        }

        // DOM 文本节点：TreeWalker 遍历（限制规模防止大 DOM 阻塞）
        var MAX_TEXT_NODES = 10000;
        var MAX_TEXT_LENGTH = 500000;
        var pendingNodes = [root];
        var textNodes = [];
        var fullText = '';
        while (pendingNodes.length) {
            if (textNodes.length >= MAX_TEXT_NODES || fullText.length >= MAX_TEXT_LENGTH) break;
            var node = pendingNodes.pop();
            if (node.nodeType === Node.TEXT_NODE) {
                textNodes.push({node: node, start: fullText.length, length: node.textContent.length});
                fullText += node.textContent;
            } else {
                var children = Array.from(node.childNodes);
                for (var ci = children.length - 1; ci >= 0; --ci) pendingNodes.push(children[ci]);
                if (node.shadowRoot) pendingNodes.push(node.shadowRoot);
            }
        }

        // 查找第 nth 个匹配
        var idx = -1;
        for (var m = 0; m <= nth; m++) {
            idx = fullText.indexOf(findText, idx + (m > 0 ? 1 : 0));
            if (idx === -1) return {type: 'notfound'};
        }

        function findNodeOffset(globalOffset) {
            for (var i = 0; i < textNodes.length; i++) {
                var tn = textNodes[i];
                if (globalOffset >= tn.start && globalOffset < tn.start + tn.length)
                    return {node: tn.node, offset: globalOffset - tn.start};
            }
            var last = textNodes[textNodes.length - 1];
            return {node: last.node, offset: last.length};
        }

        var range = document.createRange();
        var s = findNodeOffset(idx);
        range.setStart(s.node, s.offset);
        range.setEnd(s.node, Math.min(s.offset + 1, s.node.textContent.length));
        var sr = range.getBoundingClientRect();
        if (!sr.width && !sr.height) return {type: 'notfound'};

        var e = findNodeOffset(idx + findText.length - 1);
        range.setStart(e.node, e.offset);
        range.setEnd(e.node, Math.min(e.offset + 1, e.node.textContent.length));
        var er = range.getBoundingClientRect();
        if (!er.width && !er.height) return {type: 'notfound'};

        // 检测格式化标签（<code>、<strong>、<em> 等）
        var FORMAT_TAGS = {CODE:1, STRONG:1, EM:1, B:1, I:1, MARK:1, U:1, S:1, DEL:1, SUB:1, SUP:1};
        var formatted = '';
        var startNode = s.node.parentElement;
        var endNode = e.node.parentElement;
        if (startNode === endNode && startNode && FORMAT_TAGS[startNode.tagName]) {
            formatted = startNode.tagName.toLowerCase();
        }

        // contenteditable 使用 DOM Range 建立精确选区；CDP 的 Shift+Click 会把整个编辑区选中。
        if (root instanceof HTMLElement && root.isContentEditable) {
            var selection = window.getSelection();
            if (!selection) return {type: 'notfound'};
            var selectionRange = document.createRange();
            selectionRange.setStart(s.node, s.offset);
            selectionRange.setEnd(e.node, Math.min(e.offset + 1, e.node.textContent.length));
            root.focus();
            selection.removeAllRanges();
            selection.addRange(selectionRange);
            return {type: 'range', formatted: formatted || undefined};
        }

        return {
            type: 'coords',
            startX: sr.x + 1,
            startY: sr.y + sr.height / 2,
            endX: er.x + er.width - 1,
            endY: er.y + er.height / 2,
            formatted: formatted || undefined
        };
    }`,
        undefined,
        remainingInputTimeout(deadline),
        [findText, nth, scopeNth, scopeSelector, scopeText, scopeXpath, scopeSemantic],
        { userAction: 'input' }
    )
    if (
        privacy &&
        result &&
        result.type !== 'noscope' &&
        (result.type !== 'notfound' || result.inputType !== undefined)
    ) {
        privacy.sensitive = sensitiveBefore || ('inputType' in result && result.inputType === 'password')
    }

    if (!result || result.type === 'noscope') {
        const diagnostics = await collectTextSelectionDiagnostics(
            unifiedSession,
            findText,
            scopeTarget,
            nth,
            scopeNth,
            scopeSelector,
            scopeText,
            scopeXpath,
            scopeSemantic,
            timeout
        )
        throw new StructuredToolError(
            'TEXT_SCOPE_NOT_FOUND',
            `未找到目标元素: ${JSON.stringify(scopeTarget)}`,
            '请检查 target 是否能定位到包含目标文本的元素，或先用 extract(state) 查看可交互元素',
            diagnostics as unknown as Record<string, unknown>
        )
    }
    if (result.type === 'unsupported') {
        throw new StructuredToolError(
            'UNSUPPORTED_SELECTION',
            `${result.tag}[type=${result.inputType}] 不支持文本 selection`,
            'select 只支持 textarea 和 text/search/tel/url/password input；请使用 type mode="controlled" 设置完整 value',
            {
                elementTag: result.tag,
                inputType: result.inputType,
                currentValue: result.currentValue,
                requestedFind: findText,
                recommendedMode: 'controlled',
            }
        )
    }
    if (result.type === 'notfound') {
        const diagnostics = await collectTextSelectionDiagnostics(
            unifiedSession,
            findText,
            scopeTarget,
            nth,
            scopeNth,
            scopeSelector,
            scopeText,
            scopeXpath,
            scopeSemantic,
            timeout
        )
        throw new StructuredToolError(
            'TEXT_NOT_FOUND',
            scopeTarget
                ? `目标元素内未找到文本 "${findText}"${nth > 0 ? `（第 ${nth} 个匹配）` : ''}`
                : `未找到文本: "${findText}"${nth > 0 ? `（第 ${nth} 个匹配）` : ''}`,
            '请检查 find 文本、nth 序号和 target 范围；context.candidates 提供了当前范围内的候选文本和 selector',
            diagnostics as unknown as Record<string, unknown>
        )
    }

    if (result.type === 'input') {
        // 注入脚本已完成 focus + setSelectionRange（原子化，避免外层 mouseClick 聚焦不可靠）
        return undefined
    }
    if (result.type === 'range') {
        return result.formatted
    }

    // DOM 文本节点：鼠标选择
    const coords = result

    // Step 2: 模拟鼠标选择
    await unifiedSession.mouseMove(coords.startX, coords.startY, remainingInputTimeout(deadline))
    remainingInputTimeout(deadline)
    await unifiedSession.mouseClick('left')

    remainingInputTimeout(deadline)
    try {
        await unifiedSession.keyDown('Shift')
        await unifiedSession.mouseMove(coords.endX, coords.endY, remainingInputTimeout(deadline))
        remainingInputTimeout(deadline)
        await unifiedSession.mouseClick('left')
    } catch (error) {
        try {
            await unifiedSession.keyUp('Shift')
        } catch (releaseError) {
            console.error('[MCP] Shift release failed after selection error:', releaseError)
        }
        throw error
    }
    await unifiedSession.keyUp('Shift')

    return coords.formatted
}

/**
 * 验证事件参数（两种执行模式共享），避免在 Extension/CDP 两个 switch 中重复校验
 */
function requiredEventParam(event: InputEvent, name: keyof InputEvent): never {
    throw new Error(`events[].${String(name)} 是 ${event.type} 事件的必填参数`)
}

function validateEvent(event: InputEvent): void {
    if (event.force && (event.type !== 'click' || !event.target || 'x' in event.target)) {
        throw new StructuredToolError(
            'INVALID_ARGUMENT',
            'force 仅支持带元素 target 的 click 事件，不能使用坐标或省略 target',
            '请指定 CSS、role、文本或其他元素定位方式',
            { actionExecuted: false }
        )
    }
    if (event.commands && event.commands.length > 0 && event.type !== 'keydown') {
        throw new Error(
            `events[].commands 只能用于 keydown 事件，当前事件类型为 ${event.type}，如需触发编辑命令，请把 commands 放在 keydown 事件上`
        )
    }
    if (event.force && !event.forceReason) {
        throw new Error('events[].forceReason 在 force=true 时必填')
    }
    switch (event.type) {
        case 'keydown':
        case 'keyup':
            if (!event.key) {
                requiredEventParam(event, 'key')
            }
            break
        case 'mousemove':
        case 'touchstart':
        case 'touchmove':
            if (!event.target) {
                requiredEventParam(event, 'target')
            }
            break
        case 'type':
            if (event.text === undefined) {
                requiredEventParam(event, 'text')
            }
            break
        case 'upload':
            if (
                !event.target ||
                'x' in event.target ||
                !Array.isArray(event.files) ||
                event.files.some((path) => typeof path !== 'string' || !path)
            ) {
                throw new StructuredToolError(
                    'INVALID_ARGUMENT',
                    'upload 需要元素 target 和 files 路径数组，空数组用于清空选择',
                    '请指定 input[type=file] 的 CSS、label、XPath 或其他元素定位',
                    { actionExecuted: false, actionStatus: 'not_started' }
                )
            }
            break
        case 'select':
            if (!event.find) {
                requiredEventParam(event, 'find')
            }
            break
        case 'replace':
            if (!event.find) {
                requiredEventParam(event, 'find')
            }
            if (event.text === undefined) {
                requiredEventParam(event, 'text')
            }
            break
        case 'drag':
            if (!event.target) {
                throw new Error('drag 事件需要 target 参数')
            }
            if (!event.to) {
                throw new Error('drag 事件需要 to 参数')
            }
            break
        case 'editorInsert':
            if (!event.text) {
                requiredEventParam(event, 'text')
            }
            break
        case 'editorCommand':
            if (!event.command) {
                requiredEventParam(event, 'command')
            }
            break
        case 'wait':
            if (event.ms === undefined) {
                requiredEventParam(event, 'ms')
            }
            break
    }
}

interface UnifiedInputContext {
    unifiedSession: ReturnType<typeof getUnifiedSession>
    session?: ReturnType<typeof getSession>
    mode: InputExecutionContext['mode']
    humanize: boolean
    timeout?: number
    frame?: import('../core/browser-driver.js').FrameSelection
    signal?: AbortSignal
    privacy?: InputExecutionContext['privacy']
}

type UnifiedInputHandler = (context: UnifiedInputContext, event: InputEvent) => Promise<InputEventResult>

async function executeUnifiedEvent(context: UnifiedInputContext, event: InputEvent): Promise<InputEventResult> {
    validateEvent(event)
    const handler = unifiedInputHandlers[event.type]
    if (!handler) {
        throw new Error(`未知事件类型: ${(event as { type: string }).type}`)
    }
    return handler(context, event)
}

const unifiedInputHandlers: Record<InputEvent['type'], UnifiedInputHandler> = {
    keydown: handleUnifiedKeyDown,
    keyup: handleUnifiedKeyUp,
    click: handleUnifiedClick,
    mousedown: handleUnifiedMouseDown,
    mouseup: handleUnifiedMouseUp,
    mousemove: handleUnifiedMouseMove,
    wheel: handleUnifiedWheel,
    touchstart: handleUnifiedTouchStart,
    touchmove: handleUnifiedTouchMove,
    touchend: handleUnifiedTouchEnd,
    type: handleUnifiedType,
    upload: handleUnifiedUpload,
    wait: handleUnifiedWait,
    select: handleUnifiedSelect,
    replace: handleUnifiedReplace,
    editorContext: handleUnifiedEditorContext,
    editorInsert: handleUnifiedEditorInsert,
    editorCommand: handleUnifiedEditorCommand,
    drag: handleUnifiedDrag,
}

async function handleUnifiedKeyDown(
    { unifiedSession, timeout, frame }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)
    if (
        unifiedSession.isExtensionConnected() &&
        unifiedSession.getInputMode() === 'stealth' &&
        event.commands &&
        event.commands.length > 0
    ) {
        throw new Error(
            'commands 参数不支持 stealth 输入模式，请先调用 manage action=inputMode inputMode=precise 切换后重试'
        )
    }
    if (event.commands && event.commands.length > 0 && event.target) {
        await focusTargetForCommands(unifiedSession, event.target, remainingInputTimeout(deadline), frame)
    }
    remainingInputTimeout(deadline)
    const warning = await unifiedSession.prepareKeyboardFocus(remainingInputTimeout(deadline))
    await unifiedSession.keyDown(event.key!, event.commands, remainingInputTimeout(deadline))
    return warning
}

async function handleUnifiedKeyUp(
    { unifiedSession, timeout }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)
    const warning = await unifiedSession.prepareKeyboardFocus(remainingInputTimeout(deadline))
    await unifiedSession.keyUp(event.key!, remainingInputTimeout(deadline))
    return warning
}

async function handleUnifiedClick(
    { unifiedSession, humanize, timeout, frame }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)
    const button = event.button ?? 'left'
    const clickCount = event.clickCount ?? 1
    if (!event.target) {
        await unifiedSession.mouseClick(button, clickCount)
        return undefined
    }

    const point = await getTargetPointExtension(
        unifiedSession,
        event.target,
        remainingInputTimeout(deadline),
        frame,
        !event.force
    )
    if (humanize) {
        for (const p of generateBezierPath(unifiedSession.getMousePosition(), point, event.steps)) {
            await unifiedSession.mouseMove(p.x, p.y, remainingInputTimeout(deadline))
            const remaining = remainingInputTimeout(deadline)
            await randomDelay(Math.min(getMouseMoveDelay(), remaining), Math.min(getMouseMoveDelay() * 2, remaining))
        }
    } else if (!point.refId || button !== 'left' || clickCount !== 1) {
        await unifiedSession.mouseMove(point.x, point.y, remainingInputTimeout(deadline))
    }
    remainingInputTimeout(deadline)
    if (point.refId) {
        const result = await unifiedSession.actionableClick(
            point.refId,
            event.force === true,
            button,
            clickCount,
            point
        )
        if (!result.success) {
            throw new StructuredToolError(
                'ACTIONABILITY_FAILED',
                result.error || 'Click failed',
                result.suggestions?.[0] ??
                    '请根据 context.rect、context.clickPoint 和 context.coveringElement 调整 target',
                result as unknown as Record<string, unknown>
            )
        }
        return result.warning
    } else {
        await unifiedSession.mouseClick(button, clickCount)
    }
    return undefined
}

async function handleUnifiedMouseDown(
    { unifiedSession, timeout, frame }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)
    if (event.target) {
        const point = await getTargetPointExtension(
            unifiedSession,
            event.target,
            remainingInputTimeout(deadline),
            frame
        )
        await unifiedSession.mouseMove(point.x, point.y, remainingInputTimeout(deadline))
    }
    remainingInputTimeout(deadline)
    await unifiedSession.mouseDown(event.button ?? 'left')
    return undefined
}

async function handleUnifiedMouseUp(
    { unifiedSession }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    await unifiedSession.mouseUp(event.button ?? 'left')
    return undefined
}

async function handleUnifiedMouseMove(
    { unifiedSession, humanize, timeout, frame }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)
    const point = await getTargetPointExtension(unifiedSession, event.target!, remainingInputTimeout(deadline), frame)

    if (humanize && event.steps && event.steps > 1) {
        const path = generateBezierPath(unifiedSession.getMousePosition(), point, event.steps)
        for (const p of path) {
            await unifiedSession.mouseMove(p.x, p.y, remainingInputTimeout(deadline))
            const remaining = remainingInputTimeout(deadline)
            await randomDelay(Math.min(getMouseMoveDelay(), remaining), Math.min(getMouseMoveDelay() * 2, remaining))
        }
    } else {
        await unifiedSession.mouseMove(point.x, point.y, remainingInputTimeout(deadline))
    }
    remainingInputTimeout(deadline)
    return undefined
}

async function handleUnifiedWheel(
    { unifiedSession, timeout, frame }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)
    let point: { x: number; y: number } | undefined
    if (event.target && 'x' in event.target && 'y' in event.target) {
        point = { x: event.target.x, y: event.target.y }
    } else if (event.target) {
        const {
            selector,
            text,
            xpath,
            nth: nthParam,
            semantic,
        } = targetToFindParams(event.target as Target & { nth?: number })
        const nth = nthParam ?? 0
        const elements = await unifiedSession.find(
            selector,
            text,
            xpath,
            remainingInputTimeout(deadline),
            semantic,
            nth
        )
        if (elements.length > 0) {
            remainingInputTimeout(deadline)
            await unifiedSession.scroll(event.deltaX ?? 0, event.deltaY ?? 0, elements[0].refId)
            return undefined
        }
        point = await getTargetPointExtension(
            unifiedSession,
            event.target,
            remainingInputTimeout(deadline),
            frame,
            true
        )
    }
    await unifiedSession.mouseWheel(event.deltaX ?? 0, event.deltaY ?? 0, remainingInputTimeout(deadline), point)
    return undefined
}

async function handleUnifiedTouchStart(
    { unifiedSession, timeout, frame }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    const point = await getTargetPointExtension(unifiedSession, event.target!, timeout, frame, true)
    await unifiedSession.touchStart(point.x, point.y)
    return undefined
}

async function handleUnifiedTouchMove(
    { unifiedSession, timeout, frame }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    const point = await getTargetPointExtension(unifiedSession, event.target!, timeout, frame, true)
    await unifiedSession.touchMove(point.x, point.y)
    return undefined
}

async function handleUnifiedTouchEnd({ unifiedSession }: UnifiedInputContext): Promise<InputEventResult> {
    await unifiedSession.touchEnd()
    return undefined
}

async function handleUnifiedUpload(
    { unifiedSession, session, mode, timeout, signal, privacy }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    if (privacy) {
        privacy.sensitive = true
    }
    const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)
    const key = `__mcpUpload_${randomUUID()}`
    let objectId: string | undefined
    let preparationStarted = false
    let dispatched = false
    const active = (): number => {
        signal?.throwIfAborted()
        unifiedSession.assertRequestActive()
        return remainingInputTimeout(deadline)
    }
    const invoke = async (
        operation: 'prepare' | 'commit' | 'cleanup',
        refId: string | null = null,
        payloads: Awaited<ReturnType<typeof prepareUploadFiles>> = []
    ): Promise<UploadPageResult> => {
        const args = [operation, key, refId, deadline, event.files!.length, payloads]
        const budget = active()
        if (operation === 'commit') {
            dispatched = true
        }
        if (mode !== 'cdp') {
            return unifiedSession.evaluate<UploadPageResult>(uploadInPage.toString(), undefined, budget, args, {
                userAction: operation === 'commit' ? 'input' : undefined,
            })
        }
        const response = await session!.send<{
            result?: { value?: UploadPageResult }
            exceptionDetails?: unknown
        }>(
            'Runtime.callFunctionOn',
            {
                objectId,
                functionDeclaration: uploadInPage.toString(),
                arguments: args.map((value) => ({ value })),
                returnByValue: true,
                awaitPromise: true,
            },
            budget,
            operation === 'commit' ? 'input' : undefined
        )
        if (response.exceptionDetails || !response.result?.value) {
            throw new Error('上传脚本没有返回执行状态')
        }
        return response.result.value
    }
    const checked = (result: UploadPageResult): UploadPageResult => {
        if (!result.success) {
            throw new StructuredToolError(
                'UPLOAD_FAILED',
                result.error ?? '上传失败',
                '请核对目标控件和页面状态后重新操作',
                { actionExecuted: result.actionExecuted, actionStatus: result.actionStatus, retryable: false }
            )
        }
        return result
    }
    try {
        active()
        let refId: string | null = null
        if (mode === 'cdp') {
            const nodeId = await session!
                .createLocator(event.target!, { timeout: targetLookupTimeout(active()) })
                .find()
            const resolved = await session!.send<{ object: { objectId?: string } }>(
                'DOM.resolveNode',
                { nodeId },
                active()
            )
            objectId = resolved.object.objectId
            if (!objectId) {
                // noinspection ExceptionCaughtLocallyJS
                throw new Error('上传目标引用已失效')
            }
        } else {
            const params = targetToFindParams(event.target as Target & { nth?: number })
            const elements = await unifiedSession.find(
                params.selector,
                params.text,
                params.xpath,
                active(),
                params.semantic,
                params.nth ?? 0
            )
            if (!elements.length) {
                // noinspection ExceptionCaughtLocallyJS
                throw new StructuredToolError(
                    'TARGET_NOT_FOUND',
                    '未找到上传控件',
                    '请检查 target、frame 和 target.nth',
                    {}
                )
            }
            refId = elements[0].refId
        }
        // evaluate 要求受控页面，读取本地文件前确认写权限并固定目标
        preparationStarted = true
        checked(await invoke('prepare', refId))
        const payloads = await prepareUploadFiles(event.files!, deadline, signal)
        active()
        const result = checked(await invoke('commit', null, payloads))
        return { type: 'upload', files: result.files }
    } catch (error) {
        const explicit =
            error instanceof StructuredToolError || error instanceof BrowserError ? error.context : undefined
        const actionExecuted = dispatched && explicit?.actionExecuted !== false
        throw new StructuredToolError(
            error instanceof StructuredToolError
                ? error.code
                : actionExecuted
                  ? 'UPLOAD_RESULT_UNKNOWN'
                  : 'UPLOAD_PREPARATION_FAILED',
            actionExecuted && explicit?.actionStatus === undefined
                ? '上传提交回执未能取得，请核对页面或站点收件结果'
                : error instanceof Error
                  ? error.message
                  : '上传准备失败',
            actionExecuted ? '请检查页面实际状态，勿自动重发上传' : '请检查目标、文件和连接后重试',
            {
                ...explicit,
                actionExecuted,
                actionStatus: actionExecuted ? (explicit?.actionStatus ?? 'unknown') : 'not_started',
                retryable: false,
            }
        )
    } finally {
        try {
            if (preparationStarted && Date.now() < deadline && !signal?.aborted) {
                await invoke('cleanup')
            }
        } catch {
            console.warn('[MCP] Upload target cleanup deferred to page deadline')
        }
        if (objectId) {
            try {
                await session!.send('Runtime.releaseObject', { objectId }, 1000)
            } catch {
                console.warn('[MCP] Upload remote object cleanup failed after context loss')
            }
        }
    }
}

async function handleUnifiedType(context: UnifiedInputContext, event: InputEvent): Promise<InputEventResult> {
    const { unifiedSession, humanize, timeout, frame } = context
    if (event.mode === 'controlled' || event.dispatch) {
        await inputControlled(unifiedSession, event, timeout, frame)
        return undefined
    }
    const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)

    if (event.target) {
        await handleUnifiedClick(
            { ...context, timeout: remainingInputTimeout(deadline) },
            { type: 'click', target: event.target }
        )
        if (!('x' in event.target)) {
            await focusTargetForCommands(unifiedSession, event.target, remainingInputTimeout(deadline), frame)
        }
    } else {
        const hasActiveFocus = await unifiedSession.evaluate<boolean>(
            `(() => {
                (${installDomHelpers.toString()})();
                const active = globalThis.__mcpDomHelpers.activeElement();
                return !!active && active !== document.body && active !== document.documentElement;
            })()`,
            undefined,
            remainingInputTimeout(deadline)
        )
        if (!hasActiveFocus) {
            throw new Error('type 事件在无 target 时需要页面已有焦点元素，请提供 target 或先 click 目标元素')
        }
    }

    const delay = event.delay ?? 0
    if (humanize) {
        for (const char of event.text!.replace(/\r\n?/g, '\n')) {
            await unifiedSession.typeText(char, 0, remainingInputTimeout(deadline))
            const remaining = remainingInputTimeout(deadline)
            await randomDelay(
                Math.min(getTypingDelay(delay), remaining),
                Math.min(getTypingDelay(delay) * 1.5, remaining)
            )
        }
        remainingInputTimeout(deadline)
    } else {
        await unifiedSession.typeText(event.text!, delay, remainingInputTimeout(deadline))
    }
    return undefined
}

function ensureWaitFitsTimeout(ms: number, timeout: number | undefined): void {
    if (timeout !== undefined && ms > timeout) {
        throw new Error(`events[].ms (${ms}ms) 超过 input 剩余 timeout (${timeout}ms)`)
    }
}

async function handleUnifiedWait({ timeout }: UnifiedInputContext, event: InputEvent): Promise<InputEventResult> {
    ensureWaitFitsTimeout(event.ms!, timeout)
    await getUnifiedSession().wait(event.ms!)
    return undefined
}

async function handleUnifiedSelect(
    { unifiedSession, session, mode, timeout, frame, privacy }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)
    const sensitiveBefore = privacy?.sensitive ?? false
    if (privacy) {
        privacy.sensitive = true
    }
    await focusTargetIfNeeded(unifiedSession, session, mode, event.target, remainingInputTimeout(deadline), frame)
    const selectionTarget = await unifiedSession.evaluate<{ tag: string; inputType?: string; value?: string } | null>(
        `(() => {
            (${installDomHelpers.toString()})();
            const el = globalThis.__mcpDomHelpers.activeElement();
            if (!(el instanceof HTMLInputElement)) return null;
            return {
                tag: 'input',
                inputType: (el.type || 'text').toLowerCase(),
                value: el.type === 'password' ? undefined : String(el.value || '').slice(0, 160)
            };
        })()`,
        undefined,
        remainingInputTimeout(deadline)
    )
    if (privacy) {
        privacy.sensitive = sensitiveBefore || selectionTarget?.inputType === 'password'
    }
    if (selectionTarget && !supportsTextSelection(selectionTarget.tag, selectionTarget.inputType)) {
        throw new StructuredToolError(
            'UNSUPPORTED_SELECTION',
            `input[type=${selectionTarget.inputType}] 不支持文本 selection`,
            '请改用 type mode="controlled" 设置完整 value，replace 事件会对这类 input 使用完整 value 更新路径',
            {
                elementTag: selectionTarget.tag,
                inputType: selectionTarget.inputType,
                currentValue: selectionTarget.value,
                requestedFind: event.find,
                recommendedMode: 'controlled',
            }
        )
    }
    await selectText(unifiedSession, event.find!, event.target, event.nth, remainingInputTimeout(deadline), privacy)
    return undefined
}

async function handleUnifiedReplace(
    { unifiedSession, session, mode, timeout, frame, privacy }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)
    const sensitiveBefore = privacy?.sensitive ?? false
    if (privacy) {
        privacy.sensitive = true
    }
    await focusTargetIfNeeded(unifiedSession, session, mode, event.target, remainingInputTimeout(deadline), frame)
    const directResult = await unifiedSession.evaluate<{
        handled: boolean
        success?: boolean
        tag?: string
        inputType?: string
        currentValue?: string
        requestedValue?: string
        actualValue?: string
        reason?: string
    }>(
        `function(findText, replacementText, nth) {
            (${installDomHelpers.toString()})();
            var el = globalThis.__mcpDomHelpers.activeElement();
            if (!(el instanceof HTMLInputElement)) return {handled: false};
            var type = (el.type || 'text').toLowerCase();
            if (['text', 'search', 'tel', 'url', 'password'].indexOf(type) !== -1) {
                return {handled: false, inputType: type};
            }
            var current = String(el.value || '');
            var pos = -1;
            for (var i = 0; i <= nth; i++) {
                pos = current.indexOf(findText, pos + (i > 0 ? 1 : 0));
                if (pos === -1) {
                    return {
                        handled: true,
                        success: false,
                        tag: 'input',
                        inputType: type,
                        currentValue: current.slice(0, 160),
                        reason: 'text_not_found'
                    };
                }
            }
            if (el.disabled || el.readOnly) {
                return {
                    handled: true,
                    success: false,
                    tag: 'input',
                    inputType: type,
                    currentValue: current.slice(0, 160),
                    reason: 'not_editable'
                };
            }
            var requested = current.slice(0, pos) + replacementText + current.slice(pos + findText.length);
            var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (!setter) {
                return {
                    handled: true,
                    success: false,
                    tag: 'input',
                    inputType: type,
                    currentValue: current.slice(0, 160),
                    requestedValue: requested.slice(0, 160),
                    reason: 'no_native_setter'
                };
            }
            setter.call(el, requested);
            el.dispatchEvent(new Event('input', {bubbles: true, composed: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
            var actual = String(el.value || '');
            return {
                handled: true,
                success: actual === requested,
                tag: 'input',
                inputType: type,
                currentValue: current.slice(0, 160),
                requestedValue: requested.slice(0, 160),
                actualValue: actual.slice(0, 160),
                reason: actual === requested ? undefined : 'value_not_applied'
            };
        }`,
        undefined,
        remainingInputTimeout(deadline),
        [event.find, event.text, event.nth ?? 0],
        { userAction: 'input' }
    )
    if (privacy) {
        privacy.sensitive = sensitiveBefore || directResult.inputType === 'password'
    }
    if (directResult.handled) {
        if (!directResult.success) {
            const valueNotApplied = directResult.reason === 'value_not_applied'
            throw new StructuredToolError(
                directResult.reason === 'text_not_found'
                    ? 'TEXT_NOT_FOUND'
                    : valueNotApplied
                      ? 'VALUE_NOT_APPLIED'
                      : 'UNSUPPORTED_SELECTION',
                directResult.reason === 'text_not_found'
                    ? `目标元素内未找到文本 "${event.find}"`
                    : valueNotApplied
                      ? '浏览器没有接受 replace 计算出的完整 value'
                      : '目标 input 不支持文本 selection，且无法安全更新完整 value',
                valueNotApplied
                    ? '请根据 actualValue 提供该 input type 接受的完整值，或使用 controlled type 设置合法值'
                    : '请使用 mode="controlled" 的 type 事件设置完整 value，或改用支持文本 selection 的 input 类型',
                {
                    elementTag: directResult.tag,
                    inputType: directResult.inputType,
                    currentValue: directResult.currentValue,
                    requestedFind: event.find,
                    requestedValue: directResult.requestedValue,
                    actualValue: directResult.actualValue,
                    recommendedMode: 'controlled',
                    reason: directResult.reason,
                }
            )
        }
        return {
            elementTag: directResult.tag,
            inputType: directResult.inputType,
            requestedValue: directResult.requestedValue,
            actualValue: directResult.actualValue,
            normalized: directResult.actualValue !== directResult.requestedValue,
        }
    }
    const formatted = await selectText(
        unifiedSession,
        event.find!,
        event.target,
        event.nth,
        remainingInputTimeout(deadline),
        privacy
    )
    let selectionConfirmed = false
    for (let i = 0; i < 25; i++) {
        const hasSelection = await unifiedSession.evaluate<boolean>(
            `(function() {
                (${installDomHelpers.toString()})();
            var el = globalThis.__mcpDomHelpers.activeElement();
                if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                    return el.selectionStart !== el.selectionEnd;
                }
                var sel = window.getSelection();
                return sel && !sel.isCollapsed;
            })()`,
            undefined,
            remainingInputTimeout(deadline)
        )
        if (hasSelection) {
            selectionConfirmed = true
            break
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(20, remainingInputTimeout(deadline))))
    }
    if (!selectionConfirmed) {
        throw new Error(`选区同步失败：文本 "${event.find}" 已定位但未能建立选区，无法执行替换`)
    }

    const replaceResult = await unifiedSession.evaluate<'ok' | 'readonly' | 'fallback'>(
        `function(replacementText) {
        (${installDomHelpers.toString()})();
            var el = globalThis.__mcpDomHelpers.activeElement();
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.setRangeText) {
            if (el.readOnly || el.disabled) return 'readonly';
            el.setRangeText(replacementText, el.selectionStart, el.selectionEnd, 'end');
            el.dispatchEvent(new Event('input', {bubbles: true, composed: true}));
            return 'ok';
        }
        var sel = window.getSelection();
        if (!sel || sel.isCollapsed) return 'readonly';
        var anchor = sel.anchorNode;
        var editable = anchor instanceof Element ? anchor : anchor && anchor.parentElement;
        while (editable && !editable.isContentEditable && editable !== document.body) {
            editable = editable.parentElement;
        }
        if (!editable || !editable.isContentEditable) return 'readonly';
        if (document.execCommand('insertText', false, replacementText)) return 'ok';
        return 'fallback';
    }`,
        undefined,
        remainingInputTimeout(deadline),
        [event.text],
        { userAction: 'input' }
    )
    if (replaceResult === 'readonly') {
        throw new Error(`目标元素不可编辑，已选中文本 "${event.find}" 但无法替换`)
    }
    if (replaceResult === 'fallback') {
        await unifiedSession.typeText(event.text!, 0, remainingInputTimeout(deadline))
    }
    if (formatted) {
        return `替换的文本原在 <${formatted}> 标签内，替换后格式可能丢失`
    }
    return undefined
}

async function handleUnifiedEditorContext(
    { unifiedSession, timeout, frame }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    return (await editorAction(unifiedSession, 'context', event, timeout, frame)) as Record<string, unknown>
}

async function handleUnifiedEditorInsert(
    { unifiedSession, timeout, frame }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    await editorAction(unifiedSession, 'insert', event, timeout, frame)
    return undefined
}

async function handleUnifiedEditorCommand(
    { unifiedSession, timeout, frame }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    await editorAction(unifiedSession, 'command', event, timeout, frame)
    return undefined
}

async function handleUnifiedDrag(
    { unifiedSession, timeout, frame }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    if (!event.target) {
        throw new Error('drag 事件需要 target 参数')
    }
    if (!event.to) {
        throw new Error('drag 事件需要 to 参数')
    }
    if ('x' in event.target || 'y' in event.target) {
        throw new Error('drag 的 target 不支持坐标类型，请使用选择器（css/text/xpath/role 等）')
    }
    if ('x' in event.to || 'y' in event.to) {
        throw new Error('drag 的 to 不支持坐标类型，请使用选择器（css/text/xpath/role 等）')
    }

    const srcParams = targetToFindParams(event.target as Target & { nth?: number })
    const dstParams = targetToFindParams(event.to as Target & { nth?: number })
    const srcNth = srcParams.nth ?? 0
    const dstNth = dstParams.nth ?? 0

    const attemptDrag = async (): Promise<{ success: boolean; error?: string; code?: string }> => {
        const srcEls = await unifiedSession.find(
            srcParams.selector,
            srcParams.text,
            srcParams.xpath,
            timeout,
            srcParams.semantic,
            srcNth
        )
        const dstEls = await unifiedSession.find(
            dstParams.selector,
            dstParams.text,
            dstParams.xpath,
            timeout,
            dstParams.semantic,
            dstNth
        )
        if (srcEls.length === 0) {
            throw new StructuredToolError(
                srcNth === 0 ? 'TARGET_NOT_FOUND' : 'TARGET_INDEX_OUT_OF_RANGE',
                `drag 源元素未找到: ${JSON.stringify(event.target)}`,
                '请检查 drag 源 target、frame 和 nth',
                await buildTargetDiagnosticContext(
                    unifiedSession,
                    event.target!,
                    null,
                    srcNth,
                    timeout,
                    'drag 源元素未找到',
                    frame
                )
            )
        }
        if (dstEls.length === 0) {
            throw new StructuredToolError(
                dstNth === 0 ? 'TARGET_NOT_FOUND' : 'TARGET_INDEX_OUT_OF_RANGE',
                `drag 目标元素未找到: ${JSON.stringify(event.to)}`,
                '请检查 drag 目标 to、frame 和 nth',
                await buildTargetDiagnosticContext(
                    unifiedSession,
                    event.to!,
                    null,
                    dstNth,
                    timeout,
                    'drag 目标元素未找到',
                    frame
                )
            )
        }
        return unifiedSession.dragAndDrop(srcEls[0].refId, dstEls[0].refId)
    }

    let dragResult = await attemptDrag()
    let retried = false
    if (!dragResult.success && dragResult.code === 'REF_STALE') {
        console.warn('[MCP] drag refId 失效，自动重试一次:', dragResult.error)
        dragResult = await attemptDrag()
        retried = true
    }
    if (!dragResult.success) {
        throw new Error(dragResult.error || 'drag 执行失败')
    }
    return retried ? 'drag 因 refId 失效已自动重试一次（可能是 React 等框架重渲染导致）' : undefined
}

/**
 * Extension 模式：获取目标点坐标
 *
 * iframe 坐标系修正：
 * - 原始坐标 {x, y}：用户意图为 iframe 相对坐标
 *   - precise 模式需加 offset 转为视口绝对坐标（CDP 用绝对坐标）
 *   - stealth 模式直接使用（在 iframe 内派发，本身就是相对坐标）
 * - 元素定位：find() 返回视口绝对坐标
 *   - precise 模式直接使用
 *   - stealth 模式需减 offset 转为 iframe 相对坐标
 */
async function inputControlled(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    event: InputEvent,
    timeout?: number,
    frame?: import('../core/browser-driver.js').FrameSelection
): Promise<void> {
    if (!event.target) {
        throw new Error('controlled 输入需要 target 参数定位输入元素')
    }
    if ('x' in event.target && 'y' in event.target) {
        throw new Error('controlled 输入不支持坐标型 target，请使用 CSS 选择器、role 或文本定位')
    }
    const {
        selector,
        text: searchText,
        xpath,
        nth: nthParam,
        semantic,
    } = targetToFindParams(event.target as Target & { nth?: number })
    const nth = nthParam ?? 0
    const elements = await unifiedSession.find(selector, searchText, xpath, timeout, semantic, nth)
    if (elements.length === 0) {
        throw new StructuredToolError(
            'TARGET_NOT_FOUND',
            `controlled 输入目标未找到: ${JSON.stringify(event.target)}`,
            '请检查 target 是否能定位到 input、textarea、select 或 contenteditable 元素；context.candidates 提供当前页面候选元素',
            await buildTargetDiagnosticContext(
                unifiedSession,
                event.target,
                null,
                nth,
                timeout,
                'controlled 输入目标未找到',
                frame
            )
        )
    }
    const result = await unifiedSession.dispatchInput(elements[0].refId, event.text ?? '')
    if (!result.success) {
        throw new StructuredToolError(
            'CONTROLLED_INPUT_FAILED',
            result.error || 'controlled 输入失败',
            '请检查目标元素是否可编辑、未 disabled，并确认当前 frame 与 target 匹配',
            await buildTargetDiagnosticContext(
                unifiedSession,
                event.target,
                null,
                nth,
                timeout,
                result.error || 'controlled 输入失败',
                frame
            )
        )
    }
}

async function buildTargetDiagnosticContext(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    target: Target,
    matchCount: number | null,
    nth: number,
    timeout?: number,
    reason = '目标元素未找到',
    frame?: import('../core/browser-driver.js').FrameSelection
): Promise<Record<string, unknown>> {
    return buildTargetDiagnostics(unifiedSession, target, {
        nth,
        timeout,
        frame,
        matchCount,
        lastState: reason,
    })
}

async function editorAction(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    action: 'context' | 'insert' | 'command',
    event: InputEvent,
    timeout?: number,
    frame?: import('../core/browser-driver.js').FrameSelection
): Promise<unknown> {
    const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)
    if (event.target) {
        await focusTargetForCommands(unifiedSession, event.target, remainingInputTimeout(deadline), frame)
    }

    return unifiedSession.evaluate(
        `function(action, text, command) {
            (${installDomHelpers.toString()})();
            var active = globalThis.__mcpDomHelpers.activeElement();
            var sel = window.getSelection();
            var editable = active;
            if (!editable || editable === document.body || editable === document.documentElement) {
                var anchor = sel && sel.anchorNode;
                editable = anchor instanceof Element ? anchor : anchor && anchor.parentElement;
                while (editable && !editable.isContentEditable && editable !== document.body) {
                    editable = editable.parentElement;
                }
            }
            var isInput = !!active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
            var isEditable = !!editable && editable.isContentEditable;
            if (!isInput && !isEditable) {
                throw new Error('editor 事件需要已聚焦 input、textarea 或 contenteditable 元素');
            }

            if (action === 'context') {
                var selectedText = '';
                if (isInput) {
                    selectedText = active.value.slice(active.selectionStart || 0, active.selectionEnd || 0);
                } else if (sel) {
                    selectedText = sel.toString();
                }
                return {
                    activeElement: active ? {
                        tag: active.tagName.toLowerCase(),
                        id: active.id || undefined,
                        isContentEditable: !!active.isContentEditable,
                        selectionStart: isInput ? active.selectionStart : undefined,
                        selectionEnd: isInput ? active.selectionEnd : undefined
                    } : null,
                    editableElement: editable ? {
                        tag: editable.tagName.toLowerCase(),
                        id: editable.id || undefined,
                        isContentEditable: !!editable.isContentEditable
                    } : null,
                    selectedText: selectedText,
                    selectionCollapsed: isInput
                        ? active.selectionStart === active.selectionEnd
                        : !sel || sel.isCollapsed
                };
            }

            if (action === 'insert') {
                if (isInput) {
                    active.setRangeText(text, active.selectionStart || 0, active.selectionEnd || 0, 'end');
                    active.dispatchEvent(new Event('input', {bubbles: true, composed: true}));
                    active.dispatchEvent(new Event('change', {bubbles: true}));
                    return {success: true};
                }
                if (document.execCommand('insertText', false, text)) {
                    return {success: true};
                }
                throw new Error('editorInsert 无法插入文本');
            }

            if (!document.execCommand(command, false, text || null)) {
                throw new Error('editorCommand 执行失败: ' + command);
            }
            return {success: true, command: command};
        }`,
        undefined,
        remainingInputTimeout(deadline),
        [action, event.text ?? '', event.command ?? ''],
        { userAction: 'input' }
    )
}

async function getTargetPointExtension(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    target: Target,
    timeout?: number,
    frame?: import('../core/browser-driver.js').FrameSelection,
    scroll = true
): Promise<{ x: number; y: number; refId?: string }> {
    const budget = timeout ?? DEFAULT_TIMEOUT
    const deadline = Date.now() + budget
    const remaining = (): number => {
        const value = deadline - Date.now()
        if (value <= 0) {
            throwInputTimeoutError(budget)
        }
        return value
    }
    if ('x' in target && 'y' in target) {
        return { x: target.x, y: target.y }
    }

    const { selector, text, xpath, nth: nthParam, semantic } = targetToFindParams(target as Target & { nth?: number })
    const nth = nthParam ?? 0
    const elements = await unifiedSession.find(selector, text, xpath, remaining(), semantic, nth)
    if (elements.length === 0) {
        throw new StructuredToolError(
            nth === 0 ? 'TARGET_NOT_FOUND' : 'TARGET_INDEX_OUT_OF_RANGE',
            `未找到目标元素: ${JSON.stringify(target)}`,
            '请检查 target 是否正确，或先用 extract type=state 查看 interactiveElements 候选',
            await buildTargetDiagnosticContext(unifiedSession, target, null, nth, timeout, '目标元素未找到', frame)
        )
    }

    // 视口外时滚动后重新取 rect：与 actionableClick (left+single) 行为对齐，
    // 否则非左键 / 多击的坐标路径在视口外坐标 dispatch，浏览器找不到元素，事件丢失
    const refId = elements[0].refId
    let rect = await unifiedSession.evaluate<{ x: number; y: number; width: number; height: number } | null>(
        `(async () => {
            const ref = window.__mcpElementMap?.[${JSON.stringify(refId)}];
            const el = ref?.deref();
            if (!el || !el.isConnected || el.ownerDocument !== document) return null;
            const r = el.getBoundingClientRect();
            if (${scroll} && (r.top < 0 || r.bottom > window.innerHeight ||
                r.left < 0 || r.right > window.innerWidth)) {
                const positions = [];
                for (let node = el; node; node = node.assignedSlot || node.parentElement || node.getRootNode?.().host) {
                    if (node !== document.scrollingElement) {
                        positions.push({ target: node, x: node.scrollLeft, y: node.scrollTop });
                    }
                }
                positions.push({ target: document, x: window.scrollX, y: window.scrollY });
                el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                const changed = positions.filter(({ target, x, y }) => target === document
                    ? x !== window.scrollX || y !== window.scrollY
                    : x !== target.scrollLeft || y !== target.scrollTop);
                if (changed.length) {
                    const channel = new MessageChannel();
                    const scrollTargets = new Set([window, document, ...positions.flatMap(({ target }) =>
                        [target, target.getRootNode?.() || document]),
                        ...globalThis.__mcpDomHelpers.elements().flatMap(node => node.shadowRoot ? [node.shadowRoot] : [])]);
                    let timer, frame, visibilityChanged, scrollChanged, scrollEnded;
                    try {
                        await new Promise((resolve, reject) => {
                            let turn = 0, previous;
                            const scrollPosition = target => target === document
                                ? [window.scrollX, window.scrollY] : [target.scrollLeft, target.scrollTop];
                            const observedScroll = new Map();
                            scrollChanged = event => {
                                const { target } = event, last = observedScroll.get(target);
                                if (last?.event === event && last.listenerTarget !== event.currentTarget) return;
                                if (!last || positions.some(position => position.target === target)) previous = undefined;
                                const offset = scrollPosition(target);
                                const offsets = last?.offsets || new Set();
                                offsets.add(offset.join(','));
                                observedScroll.set(target, { event, listenerTarget: event.currentTarget, offset, offsets });
                            };
                            scrollEnded = ({ target }) => {
                                const last = observedScroll.get(target), offset = scrollPosition(target);
                                if (last && offset.some((value, index) => value !== last.offset[index]) &&
                                    (positions.some(position => position.target === target) || !last.offsets.has(offset.join(',')))) {
                                    previous = undefined;
                                }
                            };
                            const observeScroll = target => {
                                target.addEventListener('scroll', scrollChanged, true);
                                target.addEventListener('scrollend', scrollEnded, true);
                            };
                            for (const target of scrollTargets) observeScroll(target);
                            const schedule = () => {
                                const currentTurn = ++turn;
                                if (frame !== undefined) cancelAnimationFrame(frame);
                                frame = undefined;
                                if (document.visibilityState === 'visible') {
                                    frame = requestAnimationFrame(() => {
                                        channel.port2.postMessage({ turn: currentTurn, rendered: true });
                                    });
                                } else {
                                    channel.port2.postMessage({ turn: currentTurn, rendered: false });
                                }
                            };
                            channel.port1.onmessage = ({ data }) => {
                                if (data.turn !== turn) return;
                                for (const node of globalThis.__mcpDomHelpers.elements()) {
                                    if (node.shadowRoot && !scrollTargets.has(node.shadowRoot)) {
                                        scrollTargets.add(node.shadowRoot);
                                        observeScroll(node.shadowRoot);
                                        previous = undefined;
                                    }
                                }
                                if (document.visibilityState === 'visible') {
                                    if (!data.rendered) {
                                        schedule();
                                        return;
                                    }
                                    const bounds = el.getBoundingClientRect();
                                    const current = [...positions.flatMap(({ target }) => scrollPosition(target)),
                                        bounds.x, bounds.y, bounds.width, bounds.height];
                                    if (!previous || !current.every((value, index) => value === previous[index])) {
                                        previous = current;
                                        schedule();
                                        return;
                                    }
                                }
                                resolve();
                            };
                            visibilityChanged = schedule;
                            document.addEventListener('visibilitychange', visibilityChanged);
                            schedule();
                            timer = setTimeout(() => reject(new Error(
                                'SCROLL_SETTLEMENT_TIMEOUT: rendering did not finish before the request deadline'
                            )), Math.max(1, ${deadline} - Date.now()));
                        });
                    } finally {
                        clearTimeout(timer);
                        if (frame !== undefined) cancelAnimationFrame(frame);
                        if (visibilityChanged) document.removeEventListener('visibilitychange', visibilityChanged);
                        if (scrollChanged) {
                            for (const target of scrollTargets) {
                                target.removeEventListener('scroll', scrollChanged, true);
                                target.removeEventListener('scrollend', scrollEnded, true);
                            }
                        }
                        channel.port1.close();
                        channel.port2.close();
                    }
                }
            }
            if (!el.isConnected || el.ownerDocument !== document) return null;
            const current = el.getBoundingClientRect();
            return { x: current.x, y: current.y, width: current.width, height: current.height };
        })()`,
        undefined,
        remaining()
    )
    remaining()

    if (!rect) {
        throw new StructuredToolError(
            'TARGET_NOT_FOUND',
            '目标元素引用已失效，未使用旧坐标派发事件',
            '请重新读取页面并确认 target',
            { target, refId, actionExecuted: false }
        )
    }

    if (frame !== undefined && scroll) {
        const refreshed = await unifiedSession.find(selector, text, xpath, remaining(), semantic, nth)
        if (!refreshed[0] || refreshed[0].refId !== refId) {
            throw new StructuredToolError('TARGET_NOT_FOUND', '滚动后目标元素已失效', '重新读取目标元素', {
                actionExecuted: false,
            })
        }
        rect = await unifiedSession.evaluate<{ x: number; y: number; width: number; height: number } | null>(
            `(() => {
                const el = window.__mcpElementMap?.[${JSON.stringify(refId)}]?.deref();
                if (!el || !el.isConnected || el.ownerDocument !== document) return null;
                const r = el.getBoundingClientRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height };
            })()`,
            undefined,
            remaining()
        )
        if (!rect) {
            throw new StructuredToolError('TARGET_NOT_FOUND', '最终定位时目标元素已失效', '重新读取目标元素', {
                target,
                refId,
                actionExecuted: false,
            })
        }
    }
    return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        refId,
    }
}

interface CdpInputContext {
    session: ReturnType<typeof getSession>
    humanize: boolean
    timeout?: number
}

type CdpInputHandler = (context: CdpInputContext, event: InputEvent) => Promise<void>

async function executeCdpEvent(
    session: ReturnType<typeof getSession>,
    event: InputEvent,
    humanize: boolean,
    timeout?: number
): Promise<void> {
    validateEvent(event)
    const handler = cdpInputHandlers[event.type]
    if (!handler) {
        throw new Error(`未知事件类型: ${(event as { type: string }).type}`)
    }
    await handler({ session, humanize, timeout }, event)
}

const cdpInputHandlers: Partial<Record<InputEvent['type'], CdpInputHandler>> = {
    click: handleCdpClick,
    mousedown: handleCdpMouseDown,
    mouseup: handleCdpMouseUp,
    mousemove: handleCdpMouseMove,
    wheel: handleCdpWheel,
    touchstart: handleCdpTouchStart,
    touchmove: handleCdpTouchMove,
    touchend: handleCdpTouchEnd,
    type: handleCdpType,
    wait: handleCdpWait,
    drag: handleCdpDrag,
}

async function handleCdpClick({ session, humanize, timeout }: CdpInputContext, event: InputEvent): Promise<void> {
    if (event.force) {
        const locator = session.createLocator(event.target!, {
            timeout: targetLookupTimeout(timeout ?? DEFAULT_TIMEOUT),
        })
        await locator.evaluateOn(`function() {
            if (!this.isConnected) throw new Error('目标元素已移除，未执行点击');
            const button = ${JSON.stringify(event.button ?? 'left')};
            const count = ${event.clickCount ?? 1};
            const codes = {left: 0, middle: 1, right: 2, back: 3, forward: 4};
            const masks = {left: 1, middle: 4, right: 2, back: 8, forward: 16};
            const rect = this.getBoundingClientRect();
            const base = {bubbles: true, cancelable: true, composed: true, view: window,
                button: codes[button], clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                altKey: ${Boolean(session.getModifiers() & 1)}, ctrlKey: ${Boolean(session.getModifiers() & 2)},
                metaKey: ${Boolean(session.getModifiers() & 4)}, shiftKey: ${Boolean(session.getModifiers() & 8)}};
            for (let detail = 1; detail <= count; ++detail) {
                const down = this.dispatchEvent(new MouseEvent('mousedown', {...base, detail, buttons: masks[button]}));
                if (down && button === 'left' && typeof this.focus === 'function') this.focus();
                this.dispatchEvent(new MouseEvent('mouseup', {...base, detail, buttons: 0}));
                const type = button === 'left' ? 'click' : button === 'right' ? 'contextmenu' : 'auxclick';
                this.dispatchEvent(new MouseEvent(type, {...base, detail, buttons: 0}));
                if (button === 'left' && detail === 2) {
                    this.dispatchEvent(new MouseEvent('dblclick', {...base, detail, buttons: 0}));
                }
            }
        }`)
        return
    }
    if (event.target) {
        await moveToTarget(session, event.target, humanize, timeout)
    }
    const cdpButton = event.button ?? 'left'
    const cdpClickCount = event.clickCount ?? 1
    for (let i = 1; i <= cdpClickCount; i++) {
        await session.mouseDown(cdpButton, i)
        await session.mouseUp(cdpButton, i)
    }
}

async function handleCdpMouseDown({ session, humanize, timeout }: CdpInputContext, event: InputEvent): Promise<void> {
    if (event.target) {
        await moveToTarget(session, event.target, humanize, timeout)
    }
    await session.mouseDown(event.button ?? 'left')
}

async function handleCdpMouseUp({ session }: CdpInputContext, event: InputEvent): Promise<void> {
    await session.mouseUp(event.button ?? 'left')
}

async function handleCdpMouseMove({ session, humanize, timeout }: CdpInputContext, event: InputEvent): Promise<void> {
    await moveToTarget(session, event.target!, humanize, timeout, event.steps)
}

async function handleCdpWheel({ session, humanize, timeout }: CdpInputContext, event: InputEvent): Promise<void> {
    if (event.target) {
        await moveToTarget(session, event.target, humanize, timeout)
    }
    await session.mouseWheel(event.deltaX ?? 0, event.deltaY ?? 0)
}

async function handleCdpTouchStart({ session, timeout }: CdpInputContext, event: InputEvent): Promise<void> {
    const point = await getTargetPoint(session, event.target!, timeout)
    await session.touchStart(point.x, point.y)
}

async function handleCdpTouchMove({ session, humanize, timeout }: CdpInputContext, event: InputEvent): Promise<void> {
    const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)
    const point = await getTargetPoint(session, event.target!, remainingInputTimeout(deadline))

    if (humanize && event.steps && event.steps > 1) {
        const current = session.getBehaviorSimulator().getCurrentPosition()
        const path = generateBezierPath(current, point, event.steps)
        for (const p of path) {
            remainingInputTimeout(deadline)
            await session.touchMove(p.x, p.y)
            const remaining = remainingInputTimeout(deadline)
            await randomDelay(Math.min(5, remaining), Math.min(15, remaining))
        }
    } else {
        remainingInputTimeout(deadline)
        await session.touchMove(point.x, point.y)
    }
    remainingInputTimeout(deadline)
}

async function handleCdpTouchEnd({ session }: CdpInputContext): Promise<void> {
    await session.touchEnd()
}

async function handleCdpType({ session, humanize, timeout }: CdpInputContext, event: InputEvent): Promise<void> {
    if (event.dispatch || event.mode === 'controlled') {
        throw new Error('controlled/dispatch 输入需要 Extension 连接，当前为 CDP 模式')
    }
    const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)
    if (event.target) {
        await moveToTarget(session, event.target, humanize, remainingInputTimeout(deadline), undefined, 'input')
        await session.mouseDown('left')
        await session.mouseUp('left')
        if (!('x' in event.target)) {
            await focusCdpTarget(session, event.target, remainingInputTimeout(deadline))
        }
    } else {
        const hasActiveFocus = await session.evaluate<boolean>(
            `(() => {
                (${installDomHelpers.toString()})();
                const active = globalThis.__mcpDomHelpers.activeElement();
                return !!active && active !== document.body && active !== document.documentElement;
            })()`,
            undefined,
            remainingInputTimeout(deadline)
        )
        if (!hasActiveFocus) {
            throw new Error('type 事件在无 target 时需要页面已有焦点元素，请提供 target 或先 click 目标元素')
        }
    }

    const delay = event.delay ?? 0
    if (humanize) {
        for (const char of event.text!.replace(/\r\n?/g, '\n')) {
            await session.type(char, 0, remainingInputTimeout(deadline))
            const remaining = remainingInputTimeout(deadline)
            await randomDelay(
                Math.min(getTypingDelay(delay), remaining),
                Math.min(getTypingDelay(delay) * 1.5, remaining)
            )
        }
        remainingInputTimeout(deadline)
    } else {
        await session.type(event.text!, delay, remainingInputTimeout(deadline))
    }
}

async function handleCdpWait({ timeout }: CdpInputContext, event: InputEvent): Promise<void> {
    ensureWaitFitsTimeout(event.ms!, timeout)
    await getUnifiedSession().wait(event.ms!)
}

async function handleCdpDrag(): Promise<void> {
    throw new Error('drag 事件仅在 Extension 模式下可用，当前为 CDP 模式')
}

/**
 * 移动到目标位置
 */
async function moveToTarget(
    session: ReturnType<typeof getSession>,
    target: Target,
    humanize: boolean,
    timeout?: number,
    steps?: number,
    waitType: 'click' | 'input' | 'none' = 'click'
): Promise<void> {
    const deadline = Date.now() + (timeout ?? DEFAULT_TIMEOUT)
    const point = await getTargetPoint(session, target, remainingInputTimeout(deadline), waitType)
    const simulator = session.getBehaviorSimulator()

    if (humanize) {
        // 人类化鼠标移动（贝塞尔曲线）
        const path = generateBezierPath(simulator.getCurrentPosition(), point, steps)
        for (const p of path) {
            await session.mouseMove(p.x, p.y, remainingInputTimeout(deadline))
            const remaining = remainingInputTimeout(deadline)
            await randomDelay(Math.min(getMouseMoveDelay(), remaining), Math.min(getMouseMoveDelay() * 2, remaining))
        }
    } else if (steps && steps > 1) {
        // 直线移动，分步
        const current = simulator.getCurrentPosition()
        for (let i = 1; i <= steps; i++) {
            const t = i / steps
            const x = current.x + (point.x - current.x) * t
            const y = current.y + (point.y - current.y) * t
            await session.mouseMove(x, y, remainingInputTimeout(deadline))
        }
    } else {
        // 直接移动
        await session.mouseMove(point.x, point.y, remainingInputTimeout(deadline))
    }
    remainingInputTimeout(deadline)
}

/**
 * 获取目标点坐标（带自动等待）
 */
async function getTargetPoint(
    session: ReturnType<typeof getSession>,
    target: Target,
    timeout?: number,
    waitType: 'click' | 'input' | 'none' = 'click'
): Promise<{ x: number; y: number }> {
    if ('x' in target && 'y' in target) {
        return session
            .createLocator(target, { timeout: targetLookupTimeout(timeout ?? DEFAULT_TIMEOUT) })
            .getClickablePoint()
    }

    const budget = timeout ?? DEFAULT_TIMEOUT
    const deadline = Date.now() + budget
    const remaining = (): number => {
        const value = deadline - Date.now()
        if (value <= 0) {
            throwInputTimeoutError(budget)
        }
        return value
    }

    // 使用 Locator 定位元素
    const locator = session.createLocator(target, { timeout: targetLookupTimeout(remaining()) })
    const nodeId = await locator.find()

    // 根据操作类型执行自动等待
    if (waitType !== 'none') {
        const autoWait = session.createAutoWait({ timeout: remaining() })
        if (waitType === 'click') {
            await autoWait.waitForClickable(nodeId)
        } else if (waitType === 'input') {
            await autoWait.waitForInputReady(nodeId)
        }
    }

    remaining()
    const point = await locator.getClickablePoint()
    remaining()
    return point
}

/**
 * 注册 input 工具
 */
export function registerInputTool(server: McpServer): void {
    server.registerTool(
        'input',
        {
            description:
                [
                    '键鼠输入及文件上传：键盘、鼠标及任意组合。网页上传优先使用本工具的 upload 事件，',
                    'files 支持绝对、相对及 ~/ 路径，沿用当前页面与 Extension/CDP 连接，总大小严格小于 50 MiB；',
                    '默认优先使用已连接的 Chrome Extension；',
                    '只有 Extension 不可用或 browse(action="connect", port=…) 已显式选择 CDP 时才使用 CDP。',
                    '访问 Cloudflare 时默认不传 diagnostics，Extension 先被动等待真实 tab 标题恢复，',
                    '持续存在可点击 Turnstile 时才点击。同页测试按钮走页面点击；',
                    'Extension inspect 走 isolated world，不先挂 debugger。',
                    'Cloudflare iframe 或宿主页验证按钮只在已聚焦窗口的活动受控 tab 上用系统鼠标，',
                    'Linux 用窗口原点加边距，沿路径移动、悬停后再按下抬起，混合窗口不会调用 focusWindow',
                ].join('') +
                `

推荐操作顺序：
1. 先用 extract type=state 或 type=html 了解页面结构
2. 用 CSS 选择器 + nth 精确定位元素（避免坐标点击）
3. 再 input click/type 操作目标元素

组合键拆分为独立事件示例（修饰键 + 字母键）：
  events: [
    {type: "keydown", key: "Control"},
    {type: "keydown", key: "a"},
    {type: "keyup", key: "a"},
    {type: "keyup", key: "Control"}
  ]

浏览器编辑命令（selectAll/copy/paste/cut/undo/redo 等）需用 commands 字段，跨平台可靠：
  events: [
    {type: "keydown", key: "a", commands: ["selectAll"]},
    {type: "keyup", key: "a"}
  ]

最短示例：
  click: {events:[{type:"click",target:{css:"button[type=submit]"}}]}
  type: {events:[{type:"type",target:{css:"input[name=q]"},text:"hello"}]}
  controlled type: {events:[{type:"type",mode:"controlled",target:{css:"input[name=q]"},text:"hello"}]}
  replace: {events:[{type:"replace",target:{css:"textarea"},find:"old",text:"new"}]}
  upload: {events:[{type:"upload",target:{css:"input[type=file]"},files:["./attachment.zip"]}]}
文件路径在 Server 机器上解析；files:[] 清空选择，总大小须小于 50 MiB；合成 input/change 事件不保证站点已收件，使用 postCondition 验证
注意：纯键盘事件（不带 commands）仅保证 JS keyboard event 可被监听，不保证触发浏览器原生编辑行为；
      全选/复制/粘贴等语义用 commands；"全选并替换文本"用 select/replace 事件更简洁；
      commands 成功表示浏览器已接受命令分发，页面结果需用 postCondition 或 extract 验证；
      commands 仅支持 inputMode=precise，stealth 模式下会报错`,
            inputSchema: inputSchema,
        },
        (args, extra) => handleInput(args, extra?.signal)
    )
}
