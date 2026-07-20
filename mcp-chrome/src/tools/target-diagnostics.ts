import { sanitizeErrorMessage } from '../core/error-sanitizer.js'
import { getUnifiedSession } from '../core/index.js'
import type { Target } from '../core/types.js'

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
    timeout: number | undefined
): Promise<{ candidates: unknown[]; diagnosticError?: string }> {
    try {
        const candidates = await unifiedSession.evaluate<unknown[]>(
            `(() => Array.from(document.querySelectorAll('input, textarea, select, button, a, [role], [contenteditable="true"]'))
                .slice(0, ${MAX_CANDIDATES})
                .map((el) => {
                    const rect = el.getBoundingClientRect();
                    return {
                        tag: el.tagName.toLowerCase(),
                        id: el.id || undefined,
                        role: el.getAttribute('role') || undefined,
                        label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').slice(0, 80),
                        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, ${MAX_CANDIDATE_TEXT}),
                        visible: rect.width > 0 && rect.height > 0,
                        disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
                        bounds: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}
                    };
                }))()`,
            undefined,
            Math.min(Math.max(timeout ?? MAX_DIAGNOSTIC_TIMEOUT_MS, 1), MAX_DIAGNOSTIC_TIMEOUT_MS)
        )
        return { candidates }
    } catch (error) {
        return {
            candidates: [],
            diagnosticError: sanitizeErrorMessage(error).slice(0, 500),
        }
    }
}

export async function buildTargetDiagnostics(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    target: Target,
    options: {
        nth: number
        timeout?: number
        frame?: string | number
        matchCount: number
        lastState: string
        lastError?: unknown
        candidates?: TargetCandidate[]
    }
): Promise<Record<string, unknown>> {
    let state: Awaited<ReturnType<typeof unifiedSession.getLiveState>>
    try {
        state = await unifiedSession.getLiveState()
    } catch {
        state = null
    }
    const knownCandidates = options.candidates ? summarizeTargetCandidates(options.candidates) : []
    const pageCandidates =
        knownCandidates.length > 0
            ? { candidates: knownCandidates }
            : await collectPageCandidates(unifiedSession, options.timeout)

    return {
        locator: boundedTarget(target),
        targetType: targetType(target),
        nth: options.nth,
        currentUrl: state?.url?.slice(0, 500),
        tabId: unifiedSession.getCurrentTargetId(),
        managed: state?.managed ?? false,
        frame: options.frame,
        matchCount: options.matchCount,
        candidates: pageCandidates.candidates,
        lastLocatorState: options.lastState,
        timeout: options.timeout,
        mode: unifiedSession.getMode(),
        connection: unifiedSession.isExtensionConnected() ? 'connected' : 'unavailable',
        ...(options.lastError ? { lastError: sanitizeErrorMessage(options.lastError).slice(0, 500) } : {}),
        ...(pageCandidates.diagnosticError ? { diagnosticError: pageCandidates.diagnosticError } : {}),
    }
}
