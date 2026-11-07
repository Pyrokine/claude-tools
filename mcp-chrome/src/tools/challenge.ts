import { setTimeout as delay } from 'node:timers/promises'
import { inspectChallengePage } from '../core/challenge-page.js'
import type { ViewportMetrics } from '../core/os-mouse.js'
import { DEFAULT_TIMEOUT } from '../core/types.js'
import { OsMouseError, StructuredToolError, TimeoutError } from '../core/errors.js'
import { remainingNavigationTimeout, withNavigationBudget } from '../core/utils.js'

export const CHALLENGE_POLL_MS = 500
export const TURNSTILE_CLICK_COOLDOWN_MS = 2_000
export const CHALLENGE_INSPECT_TIMEOUT_MS = 3_000
export const CHALLENGE_INSPECT_GRACE_MS = 3_000
export const CHALLENGE_EXTENSION_PASSIVE_GRACE_MS = 8_000

export const CHALLENGE_TITLE_NEEDLES = ['just a moment', 'ddos-guard', '请稍候']
const DENIED_TITLE_PREFIXES = ['access denied', 'attention required! | cloudflare']
export const CHALLENGE_TEXT_MARKERS = [
    '正在进行安全验证',
    '验证您不是自动程序',
    'checking your browser before accessing',
    'please wait while we check your browser',
    'enable javascript and cookies to continue',
]
export const ORIGIN_RESPONSE_PENDING_TEXT_MARKERS = ['验证成功。正在等待', 'verification successful. waiting for']

export const CHALLENGE_SELECTORS = [
    '#cf-challenge-running',
    '.ray_id',
    '.attack-box',
    '#cf-please-wait',
    '#challenge-spinner',
    '#trk_jschal_js',
    '.lds-ring',
    'td.info #js_info',
    'div.vc div.text-box h2',
]

export const TURNSTILE_WIDGET_SELECTORS = ['#turnstile-wrapper', '.cf-turnstile']

export const TURNSTILE_VERIFY_BUTTON_SELECTORS = [
    'input[type="button"][value="Verify you are human"]',
    'input[type="button"][value="请验证您是真人"]',
]

export const TURNSTILE_FRAME_SELECTORS = ['iframe[src*="challenges.cloudflare.com"]', 'iframe[src*="turnstile"]']

export const DENIED_SELECTORS = [
    'div.cf-error-title span.cf-code-label span',
    '#cf-error-details div.cf-error-overview h1',
]

export type ChallengeKind = 'none' | 'js' | 'turnstile' | 'denied'

export interface ChallengeClickPoint {
    x: number
    y: number
}

export type ChallengeClickTargetKind = 'verify' | 'widget'
export type ChallengeClickSource = 'page' | 'iframe'

export interface ChallengeInspectOptions {
    challengeSelectors: string[]
    deniedSelectors: string[]
    widgetSelectors: string[]
    verifyButtonSelectors: string[]
    frameSelectors: string[]
    titleNeedles: string[]
    textMarkers: string[]
    originResponsePendingTextMarkers: string[]
}

export interface ChallengePageSnapshot {
    title: string
    url: string
    selectorHits: string[]
    deniedHits: string[]
    textHits: string[]
    originResponsePending: boolean
    turnstilePresent: boolean
    turnstileState?: 'none' | 'pending' | 'completed' | 'expired'
    clickPoint: ChallengeClickPoint | null
    clickTargetKind: ChallengeClickTargetKind | null
    clickSource: ChallengeClickSource | null
    screenPoint: ChallengeClickPoint | null
    viewport: ViewportMetrics | null
    inspected: boolean
}

export interface ChallengeWaitResult {
    resolved: true
    waitedMs: number
    clickedTurnstile: boolean
    clearanceCookiePresent: boolean
    challengeKind: Exclude<ChallengeKind, 'denied'>
    originResponsePending: boolean
    browserEvents?: Record<string, unknown>
}

export interface ChallengeHost {
    getMode(): 'extension' | 'cdp' | 'none'
    getState(): { url?: string; title?: string } | null
    getLiveState?(): Promise<{ url?: string; title?: string } | null>
    getChallengeState(): Promise<{ state: 'pending'; mode: 'extension' | 'cdp' } | null>
    evaluate<T>(code: string, mode?: 'stealth' | 'precise', timeout?: number): Promise<T>
    inspectChallenge?(options: ChallengeInspectOptions, timeout?: number): Promise<unknown>
    getCookies(filter?: { name?: string }): Promise<unknown>
    mouseMove(x: number, y: number): Promise<void>
    mouseClick(button?: 'left' | 'middle' | 'right' | 'back' | 'forward', clickCount?: number): Promise<void>
    clickTurnstile?(
        snapshot: ChallengePageSnapshot,
        timeout?: number,
        signal?: AbortSignal,
        refreshSnapshot?: (timeout?: number) => Promise<ChallengePageSnapshot>
    ): Promise<void>
    suspendBrowserEventsForChallenge?(): Promise<Record<string, unknown>>
    hasBrowserEventObservation?(): boolean
    browserEvents?(action: 'read', command: { type: 'dialog'; limit: number }): Promise<Record<string, unknown>>
}

export abstract class ChallengeError extends Error {
    abstract readonly code: string
    abstract readonly suggestion: string

    protected constructor(
        message: string,
        readonly action: string,
        readonly actionStatus: 'not_started' | 'completed',
        readonly waitedMs: number,
        readonly challengeKind: ChallengeKind,
        readonly mode: 'extension' | 'cdp' | 'none',
        readonly browserEvents?: Record<string, unknown>
    ) {
        super(message)
        this.name = this.constructor.name
    }
}

export class ChallengeTimeoutError extends ChallengeError {
    readonly code = 'CHALLENGE_TIMEOUT'
    readonly suggestion: string

    constructor(
        action: string,
        actionStatus: 'not_started' | 'completed',
        waitedMs: number,
        challengeKind: ChallengeKind,
        mode: 'extension' | 'cdp' | 'none',
        readonly clickedTurnstile = false,
        browserEvents?: Record<string, unknown>
    ) {
        super(
            `页面访问验证未在超时内完成（已等待 ${waitedMs}ms）`,
            action,
            actionStatus,
            waitedMs,
            challengeKind,
            mode,
            browserEvents
        )
        this.suggestion =
            actionStatus === 'completed'
                ? '原动作已执行，等待页面验证结束后核验业务结果，勿重放原动作'
                : mode === 'cdp'
                  ? '当前请求使用 CDP。先确认 Chrome Extension 已连接，再不传 port 重试；仅在需要独立浏览器时保留 CDP'
                  : '增加 timeout 后重试同一操作。交互式验证码、IP 声誉和 Bot Fight Mode 无法仅靠等待或点击 checkbox 完成'
    }

    toJSON() {
        return {
            success: false,
            action: this.action,
            actionExecuted: this.actionStatus === 'completed',
            actionStatus: this.actionStatus,
            verificationStatus: 'failed',
            challengeState: 'pending',
            challengeKind: this.challengeKind,
            clickedTurnstile: this.clickedTurnstile,
            mode: this.mode,
            waitedMs: this.waitedMs,
            ...(this.browserEvents ? { browserEvents: this.browserEvents } : {}),
            autoRetry: false,
            retryable: this.actionStatus === 'not_started',
            nextAction: this.actionStatus === 'completed' ? 'wait_and_verify' : 'retry_with_longer_timeout',
            error: {
                code: this.code,
                message: this.message,
                suggestion: this.suggestion,
            },
        }
    }
}

export class ChallengeDeniedError extends ChallengeError {
    readonly code = 'CHALLENGE_DENIED'
    readonly suggestion = '该页面返回了 Cloudflare Access denied，等待或点击 checkbox 无法继续访问'

    constructor(
        action: string,
        actionStatus: 'not_started' | 'completed',
        waitedMs: number,
        mode: 'extension' | 'cdp' | 'none',
        browserEvents?: Record<string, unknown>
    ) {
        super('页面拒绝访问（Cloudflare Access denied）', action, actionStatus, waitedMs, 'denied', mode, browserEvents)
    }

    toJSON() {
        return {
            success: false,
            action: this.action,
            actionExecuted: this.actionStatus === 'completed',
            actionStatus: this.actionStatus,
            verificationStatus: 'blocked',
            challengeState: 'denied',
            challengeKind: 'denied',
            mode: this.mode,
            waitedMs: this.waitedMs,
            ...(this.browserEvents ? { browserEvents: this.browserEvents } : {}),
            autoRetry: false,
            retryable: false,
            nextAction: 'stop',
            error: {
                code: this.code,
                message: this.message,
                suggestion: this.suggestion,
            },
        }
    }
}

//noinspection SpellCheckingInspection -- 模板中的浏览器 API 字段名
export const CHALLENGE_INSPECT_SCRIPT = `(${inspectChallengePage.toString()})(${JSON.stringify({
    challengeSelectors: CHALLENGE_SELECTORS,
    deniedSelectors: DENIED_SELECTORS,
    widgetSelectors: TURNSTILE_WIDGET_SELECTORS,
    verifyButtonSelectors: TURNSTILE_VERIFY_BUTTON_SELECTORS,
    frameSelectors: TURNSTILE_FRAME_SELECTORS,
    titleNeedles: CHALLENGE_TITLE_NEEDLES,
    textMarkers: CHALLENGE_TEXT_MARKERS,
    originResponsePendingTextMarkers: ORIGIN_RESPONSE_PENDING_TEXT_MARKERS,
})})`

function normalizeChallengeTitle(title: string): string {
    return title.trim().toLowerCase().replace(/…/g, '...')
}

export function titleLooksLikeChallenge(title: string): boolean {
    const normalized = normalizeChallengeTitle(title)
    return CHALLENGE_TITLE_NEEDLES.some((needle) => normalized.includes(needle.toLowerCase()))
}

export function classifyChallengeSnapshot(
    snapshot: Pick<
        ChallengePageSnapshot,
        'title' | 'selectorHits' | 'deniedHits' | 'originResponsePending' | 'turnstilePresent' | 'inspected'
    > & { textHits?: string[] },
    headerPending = false
): ChallengeKind {
    const title = normalizeChallengeTitle(snapshot.title)
    if (DENIED_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix)) || snapshot.deniedHits.length > 0) {
        return 'denied'
    }
    if (snapshot.turnstilePresent) {
        return 'turnstile'
    }
    if (snapshot.originResponsePending) {
        return 'none'
    }
    if (
        titleLooksLikeChallenge(snapshot.title) ||
        snapshot.selectorHits.length > 0 ||
        (snapshot.textHits?.length ?? 0) > 0
    ) {
        return 'js'
    }
    if (!snapshotInspected(snapshot) && headerPending) {
        return 'js'
    }
    return 'none'
}

function snapshotInspected(snapshot: { inspected?: boolean }): boolean {
    return snapshot.inspected !== false
}

function isPending(kind: ChallengeKind, snapshot: ChallengePageSnapshot, headerPending: boolean): boolean {
    if (kind === 'js' || kind === 'turnstile') {
        return true
    }
    // 主文档 cf-mitigated 只表示曾经进入 Challenge；页面标题和 DOM 恢复后即视为已过
    return !snapshot.inspected && headerPending
}

async function hasClearanceCookie(host: ChallengeHost): Promise<boolean> {
    try {
        const cookies = await host.getCookies({ name: 'cf_clearance' })
        if (!Array.isArray(cookies)) {
            return false
        }
        return cookies.some((cookie) => (cookie as { name?: string } | null)?.name === 'cf_clearance')
    } catch {
        return false
    }
}

async function readPageTitle(host: ChallengeHost): Promise<string> {
    if (host.getLiveState) {
        try {
            const live = await host.getLiveState()
            if (typeof live?.title === 'string') {
                return live.title
            }
        } catch {
            // 回退到缓存状态
        }
    }
    return host.getState()?.title ?? ''
}

function finitePoint(point: { x?: unknown; y?: unknown } | null | undefined): ChallengeClickPoint | null {
    return point &&
        typeof point.x === 'number' &&
        typeof point.y === 'number' &&
        Number.isFinite(point.x) &&
        Number.isFinite(point.y)
        ? { x: point.x, y: point.y }
        : null
}

function finiteViewport(viewport: Partial<ViewportMetrics> | null | undefined): ViewportMetrics | null {
    if (
        !viewport ||
        !Number.isFinite(viewport.screenX) ||
        !Number.isFinite(viewport.screenY) ||
        !Number.isFinite(viewport.innerWidth) ||
        !Number.isFinite(viewport.innerHeight) ||
        !Number.isFinite(viewport.outerWidth) ||
        !Number.isFinite(viewport.outerHeight)
    ) {
        return null
    }
    return {
        screenX: Number(viewport.screenX),
        screenY: Number(viewport.screenY),
        innerWidth: Number(viewport.innerWidth),
        innerHeight: Number(viewport.innerHeight),
        outerWidth: Number(viewport.outerWidth),
        outerHeight: Number(viewport.outerHeight),
        devicePixelRatio: Number.isFinite(viewport.devicePixelRatio) ? Number(viewport.devicePixelRatio) : 1,
    }
}

function blankChallengeSnapshot(title: string, url: string, inspected: boolean): ChallengePageSnapshot {
    return {
        title,
        url,
        selectorHits: [],
        deniedHits: [],
        textHits: [],
        originResponsePending: false,
        turnstilePresent: false,
        clickPoint: null,
        clickTargetKind: null,
        clickSource: null,
        screenPoint: null,
        viewport: null,
        inspected,
    }
}

function normalizeChallengeSnapshot(
    snapshot: Partial<ChallengePageSnapshot> | null | undefined,
    fallback: { title?: string; url?: string }
): ChallengePageSnapshot {
    const clickPoint = finitePoint(snapshot?.clickPoint)
    return {
        title: snapshot?.title ?? fallback.title ?? '',
        url: snapshot?.url ?? fallback.url ?? '',
        selectorHits: Array.isArray(snapshot?.selectorHits) ? snapshot.selectorHits : [],
        deniedHits: Array.isArray(snapshot?.deniedHits) ? snapshot.deniedHits : [],
        textHits: Array.isArray(snapshot?.textHits) ? snapshot.textHits : [],
        originResponsePending: Boolean(snapshot?.originResponsePending),
        turnstilePresent: Boolean(snapshot?.turnstilePresent),
        ...(snapshot?.turnstileState ? { turnstileState: snapshot.turnstileState } : {}),
        clickPoint,
        clickTargetKind:
            snapshot?.clickTargetKind === 'verify' || snapshot?.clickTargetKind === 'widget'
                ? snapshot.clickTargetKind
                : null,
        clickSource:
            snapshot?.clickSource === 'iframe' || snapshot?.clickSource === 'page' ? snapshot.clickSource : null,
        screenPoint: finitePoint(snapshot?.screenPoint),
        viewport: finiteViewport(snapshot?.viewport),
        inspected: true,
    }
}

export async function readChallengeSnapshot(
    host: ChallengeHost,
    inspectTimeout = CHALLENGE_INSPECT_TIMEOUT_MS
): Promise<ChallengePageSnapshot> {
    const fallback = host.getState() ?? {}
    const deadline = Date.now() + inspectTimeout
    if (host.inspectChallenge && host.getMode() === 'extension') {
        try {
            return normalizeChallengeSnapshot(
                (await withNavigationBudget(
                    () =>
                        host.inspectChallenge!(
                            {
                                challengeSelectors: CHALLENGE_SELECTORS,
                                deniedSelectors: DENIED_SELECTORS,
                                widgetSelectors: TURNSTILE_WIDGET_SELECTORS,
                                verifyButtonSelectors: TURNSTILE_VERIFY_BUTTON_SELECTORS,
                                frameSelectors: TURNSTILE_FRAME_SELECTORS,
                                titleNeedles: CHALLENGE_TITLE_NEEDLES,
                                textMarkers: CHALLENGE_TEXT_MARKERS,
                                originResponsePendingTextMarkers: ORIGIN_RESPONSE_PENDING_TEXT_MARKERS,
                            },
                            remainingNavigationTimeout(deadline)
                        ),
                    deadline
                )) as Partial<ChallengePageSnapshot>,
                fallback
            )
        } catch (error) {
            if (error instanceof TimeoutError) {
                return blankChallengeSnapshot(fallback.title ?? '', fallback.url ?? '', false)
            }
            // isolated inspect 失败时，在剩余预算内改用 stealth/precise
        }
    }
    for (const mode of ['stealth', 'precise'] as const) {
        try {
            return normalizeChallengeSnapshot(
                await withNavigationBudget(
                    () =>
                        host.evaluate<ChallengePageSnapshot>(
                            CHALLENGE_INSPECT_SCRIPT,
                            mode,
                            remainingNavigationTimeout(deadline)
                        ),
                    deadline
                ),
                fallback
            )
        } catch (error) {
            if (error instanceof TimeoutError) {
                return blankChallengeSnapshot(fallback.title ?? '', fallback.url ?? '', false)
            }
            // 保留未完成检查的状态，由等待器继续判定
        }
    }
    return blankChallengeSnapshot(fallback.title ?? '', fallback.url ?? '', false)
}

export async function waitForChallenge(
    host: ChallengeHost,
    options: {
        timeout?: number
        action: string
        actionStatus?: 'not_started' | 'completed'
        now?: () => number
        sleep?: (ms: number) => Promise<void>
        signal?: AbortSignal
    }
): Promise<ChallengeWaitResult> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT
    const actionStatus = options.actionStatus ?? 'completed'
    const now = options.now ?? Date.now
    const sleep = options.sleep ?? ((ms: number) => delay(ms, undefined, { signal: options.signal }))
    const startedAt = now()
    const deadline = () => Date.now() + Math.max(1, timeout - (now() - startedAt))
    let lastInspectAt = startedAt
    let clickedTurnstile = false
    const clickedTargetKinds = new Set<ChallengeClickTargetKind>()
    let pendingClick: { kind: ChallengeClickTargetKind; x: number; y: number } | null = null
    let observedKind: Exclude<ChallengeKind, 'denied'> = 'none'
    let jsOnlyInterstitial = false
    let emptyInspectCount = 0
    let finalOriginResponseCheckStarted = false
    let browserEvents: Record<string, unknown> | undefined
    let observersSuspended = false
    const readWithinBudget = async <T>(operation: () => Promise<T>): Promise<T> => {
        try {
            return await withNavigationBudget(operation, deadline(), options.signal)
        } catch (error) {
            if (error instanceof TimeoutError || (error instanceof StructuredToolError && error.code === 'TIMEOUT')) {
                throw new ChallengeTimeoutError(
                    options.action,
                    actionStatus,
                    Math.max(0, now() - startedAt),
                    clickedTurnstile ? 'turnstile' : observedKind,
                    host.getMode(),
                    clickedTurnstile,
                    browserEvents
                )
            }
            throw error
        }
    }
    const suspendObservers = async (): Promise<void> => {
        if (observersSuspended || !host.suspendBrowserEventsForChallenge) {
            return
        }
        browserEvents = await readWithinBudget(() => host.suspendBrowserEventsForChallenge!())
        if (browserEvents.suspended !== true || browserEvents.fetchEnabled === true) {
            throw new StructuredToolError(
                'CHALLENGE_OBSERVATION_CLEANUP_FAILED',
                '页面验证前未能释放当前请求控制，已保留实际状态',
                '读取 browserEvents 中的暂停请求及清理错误，处理后再等待页面验证',
                {
                    action: options.action,
                    actionExecuted: actionStatus === 'completed',
                    actionStatus,
                    verificationStatus: 'blocked',
                    browserEvents,
                    retryable: false,
                }
            )
        }
        observersSuspended = true
    }

    while (true) {
        const remainingBeforeInspect = timeout - (now() - startedAt)
        if (remainingBeforeInspect <= 0) {
            throw new ChallengeTimeoutError(
                options.action,
                actionStatus,
                Math.max(0, now() - startedAt),
                clickedTurnstile ? 'turnstile' : observedKind,
                host.getMode(),
                clickedTurnstile,
                browserEvents
            )
        }
        if (host.hasBrowserEventObservation?.() && host.browserEvents) {
            const events = await readWithinBudget(() => host.browserEvents!('read', { type: 'dialog', limit: 1000 }))
            const dialog = Array.isArray(events.logs)
                ? events.logs.find((entry: { state?: string }) => entry.state === 'pending')
                : undefined
            if (dialog) {
                throw new StructuredToolError(
                    'DIALOG_OPEN',
                    '页面对话框等待处理，页面验证尚未执行',
                    '使用 manage(action="dialog") 处理返回的 ref，再检查原操作结果',
                    {
                        ref: dialog.ref,
                        actionExecuted: actionStatus === 'completed',
                        actionStatus,
                        verificationStatus: 'blocked',
                        retryable: false,
                    }
                )
            }
        }
        const header = await readWithinBudget(() => host.getChallengeState())
        const headerPending = header?.state === 'pending'
        const title = await readWithinBudget(() => readPageTitle(host))
        if (DENIED_TITLE_PREFIXES.some((prefix) => title.trim().toLowerCase().startsWith(prefix))) {
            await suspendObservers()
            throw new ChallengeDeniedError(
                options.action,
                actionStatus,
                Math.max(0, now() - startedAt),
                host.getMode(),
                browserEvents
            )
        }
        let snapshot: ChallengePageSnapshot | undefined
        if (titleLooksLikeChallenge(title)) {
            observedKind = observedKind === 'none' ? 'js' : observedKind
            await suspendObservers()
            const passiveGraceMs =
                host.getMode() === 'extension' ? CHALLENGE_EXTENSION_PASSIVE_GRACE_MS : CHALLENGE_INSPECT_GRACE_MS
            const elapsed = now() - startedAt
            const inspectChallengePage =
                elapsed >= passiveGraceMs &&
                (jsOnlyInterstitial
                    ? remainingBeforeInspect <= CHALLENGE_INSPECT_TIMEOUT_MS && !finalOriginResponseCheckStarted
                    : now() - lastInspectAt >= TURNSTILE_CLICK_COOLDOWN_MS)
            if (inspectChallengePage) {
                snapshot = await readWithinBudget(() =>
                    readChallengeSnapshot(
                        host,
                        Math.min(CHALLENGE_INSPECT_TIMEOUT_MS, Math.max(1, timeout - (now() - startedAt)))
                    )
                )
                lastInspectAt = now()
                if (jsOnlyInterstitial) {
                    finalOriginResponseCheckStarted = true
                }
                if (snapshot.turnstilePresent || snapshot.clickPoint) {
                    jsOnlyInterstitial = false
                    emptyInspectCount = 0
                } else if (snapshot.inspected) {
                    emptyInspectCount += 1
                    if (emptyInspectCount >= 2) {
                        jsOnlyInterstitial = true
                    }
                }
            } else {
                snapshot = blankChallengeSnapshot(title, host.getState()?.url ?? '', false)
            }
        }
        if (!snapshot) {
            snapshot = await readWithinBudget(() =>
                readChallengeSnapshot(
                    host,
                    Math.min(CHALLENGE_INSPECT_TIMEOUT_MS, Math.max(1, timeout - (now() - startedAt)))
                )
            )
            lastInspectAt = now()
        }
        const kind = classifyChallengeSnapshot(snapshot, headerPending)
        if (kind === 'denied') {
            await suspendObservers()
            throw new ChallengeDeniedError(
                options.action,
                actionStatus,
                Math.max(0, now() - startedAt),
                host.getMode(),
                browserEvents
            )
        }
        if (kind === 'turnstile' || (kind === 'js' && snapshot.inspected)) {
            await suspendObservers()
        }
        if (kind !== 'none' && (kind === 'turnstile' || snapshotInspected(snapshot) || observedKind === 'none')) {
            observedKind = kind
        }
        if (!isPending(kind, snapshot, headerPending)) {
            return {
                resolved: true,
                waitedMs: Math.max(0, now() - startedAt),
                clickedTurnstile,
                clearanceCookiePresent:
                    observedKind === 'none' ? false : await readWithinBudget(() => hasClearanceCookie(host)),
                challengeKind: observedKind,
                originResponsePending: snapshot.originResponsePending,
                ...(browserEvents ? { browserEvents } : {}),
            }
        }

        const clickTargetKind = snapshot.clickTargetKind ?? (snapshot.clickPoint ? 'widget' : null)
        if (
            now() - startedAt < timeout &&
            snapshot.clickPoint &&
            clickTargetKind &&
            !clickedTargetKinds.has(clickTargetKind)
        ) {
            const samePoint =
                pendingClick &&
                pendingClick.kind === clickTargetKind &&
                pendingClick.x === snapshot.clickPoint.x &&
                pendingClick.y === snapshot.clickPoint.y
            if (!samePoint) {
                pendingClick = { kind: clickTargetKind, x: snapshot.clickPoint.x, y: snapshot.clickPoint.y }
            } else {
                const clickDeadline = deadline()
                const clickSnapshot = snapshot
                const clickPoint = snapshot.clickPoint
                try {
                    if (host.clickTurnstile) {
                        const click = () =>
                            host.clickTurnstile!(
                                clickSnapshot,
                                Math.max(0, timeout - (now() - startedAt)),
                                options.signal,
                                (remaining = CHALLENGE_INSPECT_TIMEOUT_MS) =>
                                    readChallengeSnapshot(host, Math.min(CHALLENGE_INSPECT_TIMEOUT_MS, remaining))
                            )
                        // iframe 路径自行处理取消与有界释放，完成后才结束 tab 锁
                        if (clickSnapshot.clickSource === 'iframe') {
                            await click()
                        } else {
                            await withNavigationBudget(click, clickDeadline, options.signal)
                        }
                    } else {
                        await withNavigationBudget(
                            () => host.mouseMove(clickPoint.x, clickPoint.y),
                            clickDeadline,
                            options.signal
                        )
                        await withNavigationBudget(() => host.mouseClick('left'), clickDeadline, options.signal)
                    }
                } catch (error) {
                    if (
                        error instanceof TimeoutError ||
                        (error instanceof StructuredToolError && error.code === 'TIMEOUT') ||
                        (error instanceof OsMouseError && error.context.failureStage === 'release')
                    ) {
                        Object.assign(error.context, {
                            action: options.action,
                            actionExecuted: actionStatus === 'completed',
                            actionStatus,
                            verificationActionExecuted: error.context.actionExecuted ?? 'unknown',
                            verificationStatus: 'unknown',
                            challengeKind: 'turnstile',
                            mode: host.getMode(),
                            waitedMs: Math.max(0, now() - startedAt),
                            retryable: false,
                        })
                    }
                    throw error
                }
                clickedTargetKinds.add(clickTargetKind)
                clickedTurnstile = true
                pendingClick = null
                lastInspectAt = startedAt
            }
        }

        const elapsed = now() - startedAt
        if (elapsed >= timeout) {
            throw new ChallengeTimeoutError(
                options.action,
                actionStatus,
                Math.max(elapsed, timeout),
                clickedTurnstile ? 'turnstile' : observedKind === 'none' ? kind : observedKind,
                host.getMode(),
                clickedTurnstile,
                browserEvents
            )
        }
        await readWithinBudget(() => sleep(Math.min(CHALLENGE_POLL_MS, timeout - elapsed)))
    }
}

export async function resolveChallenge(
    host: ChallengeHost,
    action: string,
    actionStatus: 'not_started' | 'completed' = 'completed',
    timeout?: number,
    signal?: AbortSignal
): Promise<ChallengeWaitResult> {
    try {
        return await waitForChallenge(host, { action, actionStatus, timeout, signal })
    } catch (error) {
        if (!signal?.aborted || (error instanceof OsMouseError && error.context.failureStage === 'release')) {
            throw error
        }
        throw new StructuredToolError(
            'CANCELLED',
            error instanceof Error ? error.message : String(error),
            '请求已取消，请读取当前页面核验已执行动作的结果',
            {
                action,
                actionExecuted: actionStatus === 'completed',
                actionStatus,
                verificationStatus: 'cancelled',
                verificationActionExecuted: 'unknown',
                retryable: false,
            }
        )
    }
}

export function challengeResultFields(result: ChallengeWaitResult): Record<string, unknown> {
    if (result.challengeKind === 'none' && !result.originResponsePending && !result.browserEvents) {
        return {}
    }
    return {
        challengeResolved: true,
        challengeKind: result.challengeKind,
        waitedMs: result.waitedMs,
        clickedTurnstile: result.clickedTurnstile,
        clearanceCookiePresent: result.clearanceCookiePresent,
        ...(result.originResponsePending ? { originResponsePending: true } : {}),
        ...(result.browserEvents ? { browserEvents: result.browserEvents } : {}),
    }
}
