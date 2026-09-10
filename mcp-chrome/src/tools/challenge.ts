import type { ViewportMetrics } from '../core/os-mouse.js'
import { DEFAULT_TIMEOUT } from '../core/types.js'

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
    clickTurnstile?(snapshot: ChallengePageSnapshot): Promise<void>
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
        readonly mode: 'extension' | 'cdp' | 'none'
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
        readonly clickedTurnstile = false
    ) {
        super(`页面访问验证未在超时内完成（已等待 ${waitedMs}ms）`, action, actionStatus, waitedMs, challengeKind, mode)
        this.suggestion =
            mode === 'cdp'
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
            autoRetry: false,
            retryable: true,
            nextAction: 'retry_with_longer_timeout',
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
        mode: 'extension' | 'cdp' | 'none'
    ) {
        super('页面拒绝访问（Cloudflare Access denied）', action, actionStatus, waitedMs, 'denied', mode)
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
export const CHALLENGE_INSPECT_SCRIPT = `(() => {
  const challengeSelectors = ${JSON.stringify(CHALLENGE_SELECTORS)};
  const deniedSelectors = ${JSON.stringify(DENIED_SELECTORS)};
  const widgetSelectors = ${JSON.stringify(TURNSTILE_WIDGET_SELECTORS)};
  const verifyButtonSelectors = ${JSON.stringify(TURNSTILE_VERIFY_BUTTON_SELECTORS)};
  const frameSelectors = ${JSON.stringify(TURNSTILE_FRAME_SELECTORS)};
  const titleNeedles = ${JSON.stringify(CHALLENGE_TITLE_NEEDLES)};
  const textMarkers = ${JSON.stringify(CHALLENGE_TEXT_MARKERS)};
  const originResponsePendingTextMarkers = ${JSON.stringify(ORIGIN_RESPONSE_PENDING_TEXT_MARKERS)};
  const title = document.title || '';
  const url = location.href || '';
  const visibleBodyText = (
    document.body && document.body.innerText ? document.body.innerText : ''
  ).replace(/\\s+/g, ' ');
  const isVisible = (el) => {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const bringIntoView = (el) => {
    if (!el || typeof el.scrollIntoView !== 'function') return;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
  };
  const hits = (selectors) => selectors.filter((selector) => {
    try { return Array.from(document.querySelectorAll(selector)).some(isVisible); } catch { return false; }
  });
  const isCloudflareFrame = (el) => {
    if (!el) return false;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'IFRAME') {
      const src = String(el.getAttribute('src') || el.src || '');
      return src.includes('challenges.cloudflare.com') || src.includes('turnstile');
    }
    return Boolean(el.closest && el.closest(frameSelectors.join(',')));
  };
  const selectorHits = hits(challengeSelectors);
  const deniedHits = hits(deniedSelectors);
  const widgetHits = hits(widgetSelectors);
  const frameHits = hits(frameSelectors);
  const cloudflareFramePresent = Array.from(document.querySelectorAll('iframe')).some((el) => isCloudflareFrame(el));
  const normalizedTitle = title.trim().toLowerCase().replace(/…/g, '...');
  const titlePending = titleNeedles.some((needle) => normalizedTitle.includes(String(needle).toLowerCase()));
  const textHits = textMarkers.filter((marker) => visibleBodyText.toLowerCase().includes(String(marker).toLowerCase()));
  const originResponsePending = originResponsePendingTextMarkers.some((marker) =>
    visibleBodyText.toLowerCase().includes(String(marker).toLowerCase())
  );
  const interstitialPending = selectorHits.length > 0 || titlePending || textHits.length > 0;
  const findVisibleTurnstileBox = () => {
    const input = document.querySelector('input[name="cf-turnstile-response"]');
    if (!input) return null;
    const candidates = [];
    let node = input.parentElement;
    while (node && node !== document.documentElement) {
      if (isVisible(node)) {
        const rect = node.getBoundingClientRect();
        if (rect.width >= 120 && rect.height >= 40) candidates.push(node);
      }
      node = node.parentElement;
    }
    if (candidates.length === 0) return null;
    return candidates.find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width >= 250 && rect.width <= 340 && rect.height >= 50 && rect.height <= 85;
    }) || candidates[0];
  };
  const turnstileBox = findVisibleTurnstileBox();
  const hostVerify = Array.from(document.querySelectorAll(verifyButtonSelectors.join(','))).find(isVisible);
  const useIframeClick = cloudflareFramePresent || (
    !hostVerify &&
    interstitialPending &&
    Boolean(document.querySelector('input[name="cf-turnstile-response"]'))
  );
  const turnstilePresent =
    widgetHits.length > 0 ||
    useIframeClick ||
    (interstitialPending && frameHits.length > 0) ||
    Boolean(turnstileBox);
  const pointFromRect = (rect, kind) => {
    if (!rect || rect.width < 8 || rect.height < 8) return null;
    const y = Math.round(rect.top + Math.min(rect.height, 65) / 2);
    if (kind === 'verify') {
      return { x: Math.round(rect.left + rect.width / 2), y };
    }
    const widgetWidth = Math.min(rect.width, 300);
    return { x: Math.round(rect.left + Math.min(20, Math.max(14, widgetWidth / 15))), y };
  };
  let clickPoint = null;
  let clickTargetKind = null;
  let clickSource = null;
  const setClickTarget = (el, kind) => {
    if (!el) return;
    bringIntoView(el);
    const point = pointFromRect(el.getBoundingClientRect(), kind);
    if (!point) return;
    clickPoint = point;
    clickTargetKind = kind;
    clickSource = isCloudflareFrame(el) || useIframeClick ? 'iframe' : 'page';
  };
  if (hostVerify) {
    setClickTarget(hostVerify, 'verify');
  }
  if (!clickPoint && turnstileBox) {
    const boxRect = turnstileBox.getBoundingClientRect();
    if (boxRect.width <= 340 && boxRect.height <= 85) {
      setClickTarget(turnstileBox, 'widget');
    }
  }
  if (!clickPoint && turnstilePresent) {
    const frame = Array.from(document.querySelectorAll(frameSelectors.join(','))).find(isVisible);
    if (frame) {
      setClickTarget(frame, 'widget');
    }
  }
  if (!clickPoint && turnstilePresent) {
    const widget = Array.from(document.querySelectorAll(widgetSelectors.join(','))).find(isVisible);
    if (widget) {
      setClickTarget(widget, 'widget');
    }
  }
  if (!clickPoint && turnstilePresent) {
    const nodes = Array.from(document.querySelectorAll('div'));
    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width >= 280 && rect.width <= 320 && rect.height >= 50 && rect.height <= 80) {
        setClickTarget(node, 'widget');
        break;
      }
    }
  }
  if (!clickPoint && turnstileBox) {
    setClickTarget(turnstileBox, 'widget');
  }
  const viewport = {
    screenX: Number(window.screenX),
    screenY: Number(window.screenY),
    innerWidth: Number(window.innerWidth),
    innerHeight: Number(window.innerHeight),
    outerWidth: Number(window.outerWidth),
    outerHeight: Number(window.outerHeight),
    devicePixelRatio: Number(window.devicePixelRatio || 1),
  };
  const horizontal = Math.max(0, viewport.outerWidth - viewport.innerWidth);
  const vertical = Math.max(0, viewport.outerHeight - viewport.innerHeight);
  const chromeLeft = Math.round(horizontal / 2);
  const chromeTop = Math.max(0, vertical - horizontal);
  const screenPoint = clickPoint
    ? {
        x: Math.round(viewport.screenX + chromeLeft + clickPoint.x),
        y: Math.round(viewport.screenY + chromeTop + clickPoint.y),
      }
    : null;
  return {
    title,
    url,
    selectorHits,
    deniedHits,
    textHits,
    originResponsePending,
    turnstilePresent,
    clickPoint,
    clickTargetKind,
    clickSource,
    screenPoint,
    viewport,
  };
})()`

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

async function readPageTitle(host: ChallengeHost): Promise<{ title: string; live: boolean }> {
    if (host.getLiveState) {
        try {
            const live = await host.getLiveState()
            if (typeof live?.title === 'string') {
                return { title: live.title, live: true }
            }
        } catch {
            // 回退到缓存状态
        }
    }
    return { title: host.getState()?.title ?? '', live: false }
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
    const startedAt = Date.now()
    if (host.inspectChallenge && host.getMode() === 'extension') {
        try {
            return normalizeChallengeSnapshot(
                (await host.inspectChallenge(
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
                    Math.max(1, inspectTimeout)
                )) as Partial<ChallengePageSnapshot>,
                fallback
            )
        } catch {
            // isolated inspect 失败时改用 stealth/precise
        }
    }
    try {
        return normalizeChallengeSnapshot(
            await host.evaluate<ChallengePageSnapshot>(
                CHALLENGE_INSPECT_SCRIPT,
                'stealth',
                Math.max(1, inspectTimeout)
            ),
            fallback
        )
    } catch {
        const remaining = Math.max(1, inspectTimeout - (Date.now() - startedAt))
        try {
            return normalizeChallengeSnapshot(
                await host.evaluate<ChallengePageSnapshot>(CHALLENGE_INSPECT_SCRIPT, 'precise', remaining),
                fallback
            )
        } catch {
            return blankChallengeSnapshot(fallback.title ?? '', fallback.url ?? '', false)
        }
    }
}

export async function waitForChallenge(
    host: ChallengeHost,
    options: {
        timeout?: number
        action: string
        actionStatus?: 'not_started' | 'completed'
        now?: () => number
        sleep?: (ms: number) => Promise<void>
    }
): Promise<ChallengeWaitResult> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT
    const actionStatus = options.actionStatus ?? 'completed'
    const now = options.now ?? Date.now
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const startedAt = now()
    let lastInspectAt = startedAt
    let clickedTurnstile = false
    const clickedTargetKinds = new Set<ChallengeClickTargetKind>()
    let pendingClick: { kind: ChallengeClickTargetKind; x: number; y: number } | null = null
    let observedKind: Exclude<ChallengeKind, 'denied'> = 'none'
    let jsOnlyInterstitial = false
    let emptyInspectCount = 0
    let finalOriginResponseCheckStarted = false

    while (true) {
        const remainingBeforeInspect = timeout - (now() - startedAt)
        const header = await host.getChallengeState()
        const headerPending = header?.state === 'pending'
        const pageTitle = await readPageTitle(host)
        const title = pageTitle.title
        if (DENIED_TITLE_PREFIXES.some((prefix) => title.trim().toLowerCase().startsWith(prefix))) {
            throw new ChallengeDeniedError(options.action, actionStatus, Math.max(0, now() - startedAt), host.getMode())
        }
        let snapshot: ChallengePageSnapshot | undefined
        if (titleLooksLikeChallenge(title)) {
            observedKind = observedKind === 'none' ? 'js' : observedKind
            const passiveGraceMs =
                host.getMode() === 'extension' ? CHALLENGE_EXTENSION_PASSIVE_GRACE_MS : CHALLENGE_INSPECT_GRACE_MS
            const elapsed = now() - startedAt
            const inspectChallengePage =
                elapsed >= passiveGraceMs &&
                (jsOnlyInterstitial
                    ? remainingBeforeInspect <= CHALLENGE_INSPECT_TIMEOUT_MS && !finalOriginResponseCheckStarted
                    : now() - lastInspectAt >= TURNSTILE_CLICK_COOLDOWN_MS)
            if (inspectChallengePage) {
                snapshot = await readChallengeSnapshot(
                    host,
                    Math.min(CHALLENGE_INSPECT_TIMEOUT_MS, Math.max(1, remainingBeforeInspect))
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
        } else if (pageTitle.live && title.trim() !== '' && (!headerPending || host.getMode() === 'extension')) {
            snapshot = blankChallengeSnapshot(title, host.getState()?.url ?? '', true)
        }
        if (!snapshot) {
            snapshot = await readChallengeSnapshot(
                host,
                Math.min(CHALLENGE_INSPECT_TIMEOUT_MS, Math.max(1, remainingBeforeInspect))
            )
            lastInspectAt = now()
        }
        const kind = classifyChallengeSnapshot(snapshot, headerPending)
        if (kind === 'denied') {
            throw new ChallengeDeniedError(options.action, actionStatus, Math.max(0, now() - startedAt), host.getMode())
        }
        if (kind !== 'none' && (kind === 'turnstile' || snapshotInspected(snapshot) || observedKind === 'none')) {
            observedKind = kind
        }
        if (!isPending(kind, snapshot, headerPending)) {
            return {
                resolved: true,
                waitedMs: Math.max(0, now() - startedAt),
                clickedTurnstile,
                clearanceCookiePresent: observedKind === 'none' ? false : await hasClearanceCookie(host),
                challengeKind: observedKind,
                originResponsePending: snapshot.originResponsePending,
            }
        }

        const clickTargetKind = snapshot.clickTargetKind ?? (snapshot.clickPoint ? 'widget' : null)
        if (snapshot.clickPoint && clickTargetKind && !clickedTargetKinds.has(clickTargetKind)) {
            const samePoint =
                pendingClick &&
                pendingClick.kind === clickTargetKind &&
                pendingClick.x === snapshot.clickPoint.x &&
                pendingClick.y === snapshot.clickPoint.y
            if (!samePoint) {
                pendingClick = { kind: clickTargetKind, x: snapshot.clickPoint.x, y: snapshot.clickPoint.y }
            } else {
                if (host.clickTurnstile) {
                    await host.clickTurnstile(snapshot)
                } else {
                    await host.mouseMove(snapshot.clickPoint.x, snapshot.clickPoint.y)
                    await host.mouseClick('left')
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
                clickedTurnstile
            )
        }
        await sleep(Math.min(CHALLENGE_POLL_MS, timeout - elapsed))
    }
}

export async function resolveChallenge(
    host: ChallengeHost,
    action: string,
    actionStatus: 'not_started' | 'completed' = 'completed',
    timeout?: number
): Promise<ChallengeWaitResult> {
    return waitForChallenge(host, { action, actionStatus, timeout })
}

export function challengeResultFields(result: ChallengeWaitResult): Record<string, unknown> {
    if (result.challengeKind === 'none' && !result.originResponsePending) {
        return {}
    }
    return {
        challengeResolved: true,
        challengeKind: result.challengeKind,
        waitedMs: result.waitedMs,
        clickedTurnstile: result.clickedTurnstile,
        clearanceCookiePresent: result.clearanceCookiePresent,
        ...(result.originResponsePending ? { originResponsePending: true } : {}),
    }
}
