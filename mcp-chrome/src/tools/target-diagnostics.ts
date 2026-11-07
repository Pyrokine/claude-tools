import { sanitizeErrorMessage } from '../core/error-sanitizer.js'
import { ElementNotFoundError, TimeoutError } from '../core/errors.js'
import { getSession, getUnifiedSession } from '../core/index.js'
import type { Target } from '../core/types.js'
import { withNavigationBudget } from '../core/utils.js'
import { sanitizePageUrls } from './network-sanitizer.js'
import { targetToFindParams } from './schema.js'

const MAX_CANDIDATES = 10
const MAX_LOCATOR_TEXT = 500
const MAX_CANDIDATE_TEXT = 160
const MAX_DIAGNOSTIC_TIMEOUT_MS = 1000

export interface TargetCandidate {
    tag?: string
    text?: string
    rect?: { x: number; y: number; width: number; height: number }
    [key: string]: unknown
}

export class TargetTimeoutError extends Error {
    readonly code = 'TARGET_TIMEOUT'
    readonly suggestion = '请检查 locator、frame 和 nth，或根据候选摘要调整目标；连接不可用时先恢复 Extension'

    constructor(readonly context: Record<string, unknown>) {
        super(`等待目标元素超时 (${context.timeout}ms)`)
        this.name = 'TargetTimeoutError'
    }

    // noinspection JSUnusedGlobalSymbols — formatErrorResponse 通过结构化 toJSON 调用
    toJSON(): object {
        return { error: { code: this.code, message: this.message, suggestion: this.suggestion, context: this.context } }
    }
}

export class TargetNotFoundError extends Error {
    readonly code = 'TARGET_NOT_FOUND'
    readonly suggestion = '请检查 locator、frame 和 nth，或根据候选摘要调整目标'

    constructor(readonly context: Record<string, unknown>) {
        super('未找到可用于当前操作的目标元素')
        this.name = 'TargetNotFoundError'
    }

    // noinspection JSUnusedGlobalSymbols — formatErrorResponse 通过结构化 toJSON 调用
    toJSON(): object {
        return { error: { code: this.code, message: this.message, suggestion: this.suggestion, context: this.context } }
    }
}

function targetType(target: Target): string {
    return Object.keys(target).find((key) => key !== 'nth') ?? 'unknown'
}

function boundedTarget(target: Target): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(target).map(([key, value]) => [
            key,
            typeof value === 'string' ? value.slice(0, MAX_LOCATOR_TEXT) : value,
        ])
    )
}

export function summarizeTargetCandidates(candidates: TargetCandidate[]): Array<Record<string, unknown>> {
    return candidates.slice(0, MAX_CANDIDATES).map((candidate) => ({
        ...(typeof candidate.tag === 'string' ? { tag: candidate.tag.slice(0, 40) } : {}),
        ...(typeof candidate.text === 'string' ? { text: candidate.text.slice(0, MAX_CANDIDATE_TEXT) } : {}),
        ...(candidate.rect ? { rect: candidate.rect } : {}),
    }))
}

async function collectPageCandidates(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    timeout: number | undefined,
    target: Target
): Promise<{
    candidates: unknown[]
    activeElement: Record<string, unknown> | null
    matchCount?: number | null
    diagnosticError?: string
}> {
    try {
        const { selector, text, xpath, semantic } = targetToFindParams(target)
        const query = JSON.stringify({ selector, text, xpath, semantic })
        const script = `(() => {
                const matchCount = ${'x' in target ? 'null' : `globalThis.__mcpDomHelpers?.query(${query}).length ?? null`};
                const active = document.activeElement;
                return {
                    matchCount,
                    activeElement: active ? {
                        tag: active.tagName.toLowerCase().slice(0, 40),
                        id: active.id ? active.id.slice(0, ${MAX_CANDIDATE_TEXT}) : undefined,
                        role: active.getAttribute('role')?.slice(0, 80) || undefined,
                        inputType: active instanceof HTMLInputElement ? active.type.slice(0, 40) : undefined,
                        contentEditable: Boolean(active.isContentEditable)
                    } : null,
                    candidates: Array.from(document.querySelectorAll(
                        'input, textarea, select, button, a, [role], [contenteditable="true"]'
                    ))
                        .slice(0, ${MAX_CANDIDATES})
                        .map((el) => {
                            const rect = el.getBoundingClientRect();
                            return {
                                tag: el.tagName.toLowerCase(),
                                id: el.id || undefined,
                                role: el.getAttribute('role') || undefined,
                                label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
                                    .slice(0, 80),
                                text: (el.textContent || '').replace(/\\s+/g, ' ').trim()
                                    .slice(0, ${MAX_CANDIDATE_TEXT}),
                                visible: rect.width > 0 && rect.height > 0,
                                disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
                                bounds: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}
                            };
                        })
                };
            })()`
        const budget = Math.min(Math.max(timeout ?? MAX_DIAGNOSTIC_TIMEOUT_MS, 1), MAX_DIAGNOSTIC_TIMEOUT_MS)
        // 原生 CDP 路径不经过会自动重连的 evaluate 分发，避免作用域恢复后的迟到探测
        return unifiedSession.getMode() === 'cdp'
            ? await getSession().evaluate(script, undefined, budget)
            : await unifiedSession.evaluate(script, undefined, budget)
    } catch (error) {
        return {
            candidates: [],
            activeElement: null,
            diagnosticError: sanitizeErrorMessage(error).slice(0, 500),
        }
    }
}

export function targetLookupTimeout(timeout: number): number {
    return Math.max(1, timeout - Math.min(MAX_DIAGNOSTIC_TIMEOUT_MS, Math.floor(timeout / 5)))
}

export async function enrichTargetError(
    error: ElementNotFoundError | TimeoutError,
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    target: Target,
    options: { timeout: number; deadline: number; frame?: import('../core/browser-driver.js').FrameSelection }
): Promise<void> {
    try {
        Object.assign(
            error.context,
            await buildTargetDiagnostics(unifiedSession, target, {
                ...options,
                nth: (target as Target & { nth?: number }).nth ?? 0,
                matchCount: typeof error.context.matchCount === 'number' ? error.context.matchCount : null,
                lastState:
                    typeof error.context.lastLocatorState === 'string' ? error.context.lastLocatorState : 'unobserved',
            })
        )
    } catch (diagnosticError) {
        error.context.diagnosticError = sanitizeErrorMessage(diagnosticError).slice(0, 500)
    }
}

export async function buildTargetDiagnostics(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    target: Target,
    options: {
        nth: number
        timeout?: number
        deadline?: number
        frame?: import('../core/browser-driver.js').FrameSelection
        matchCount: number | null
        lastState: string
        lastError?: unknown
        candidates?: TargetCandidate[]
    }
): Promise<Record<string, unknown>> {
    const deadline = Math.min(
        options.deadline ?? Infinity,
        Date.now() + Math.min(options.timeout ?? MAX_DIAGNOSTIC_TIMEOUT_MS, MAX_DIAGNOSTIC_TIMEOUT_MS)
    )
    const remaining = () => Math.max(0, deadline - Date.now())
    const tabId = unifiedSession.getCurrentTargetId()
    const mode = unifiedSession.getMode()
    let state = unifiedSession.getState()
    let diagnosticError: string | undefined
    if (remaining() > 0) {
        try {
            state = await withNavigationBudget(() => unifiedSession.getLiveState(), deadline)
        } catch (error) {
            diagnosticError = sanitizeErrorMessage(error).slice(0, 500)
        }
    }
    const knownCandidates = options.candidates ? summarizeTargetCandidates(options.candidates) : []
    let pageCandidates: Awaited<ReturnType<typeof collectPageCandidates>> = {
        candidates: knownCandidates,
        activeElement: null,
    }
    if ((knownCandidates.length === 0 || options.matchCount === null) && remaining() > 0) {
        try {
            pageCandidates = await withNavigationBudget(
                () => collectPageCandidates(unifiedSession, remaining(), target),
                deadline
            )
        } catch (error) {
            diagnosticError = sanitizeErrorMessage(error).slice(0, 500)
        }
    }

    const pageUrl = sanitizePageUrls({ currentUrl: state?.url ?? null })
    return {
        ...pageUrl,
        locator: boundedTarget(target),
        targetType: targetType(target),
        nth: options.nth,
        currentUrl: pageUrl.currentUrl?.slice(0, 500) ?? null,
        tabId,
        managed: state?.managed ?? null,
        frame: options.frame,
        matchCount: options.matchCount ?? pageCandidates.matchCount ?? null,
        candidates: pageCandidates.candidates.slice(0, MAX_CANDIDATES),
        activeElement: pageCandidates.activeElement,
        lastLocatorState: options.lastState,
        timeout: options.timeout,
        mode,
        connection: (mode === 'cdp' ? getSession().isConnected() : unifiedSession.isExtensionConnected())
            ? 'connected'
            : 'unavailable',
        ...(options.lastError ? { lastError: sanitizeErrorMessage(options.lastError).slice(0, 500) } : {}),
        ...(diagnosticError || pageCandidates.diagnosticError
            ? { diagnosticError: diagnosticError ?? pageCandidates.diagnosticError }
            : {}),
    }
}
