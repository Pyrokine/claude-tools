export function inspectChallengePage(options: {
    challengeSelectors: string[]
    deniedSelectors: string[]
    widgetSelectors: string[]
    verifyButtonSelectors: string[]
    frameSelectors: string[]
    titleNeedles: string[]
    textMarkers: string[]
    originResponsePendingTextMarkers: string[]
}): {
    title: string
    url: string
    selectorHits: string[]
    deniedHits: string[]
    textHits: string[]
    originResponsePending: boolean
    turnstilePresent: boolean
    turnstileState: 'none' | 'pending' | 'completed' | 'expired'
    clickPoint: { x: number; y: number } | null
    clickTargetKind: 'verify' | 'widget' | null
    clickSource: 'page' | 'iframe' | null
    screenPoint: { x: number; y: number } | null
    viewport: {
        screenX: number
        screenY: number
        innerWidth: number
        innerHeight: number
        outerWidth: number
        outerHeight: number
        devicePixelRatio: number
    }
} {
    const title = document.title || ''
    const url = location.href || ''
    const visibleBodyText = (document.body && document.body.innerText ? document.body.innerText : '').replace(
        /\s+/g,
        ' '
    )
    const isVisible = (el: Element | null): el is Element => {
        if (!el) {
            return false
        }
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
            return false
        }
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
    }
    const bringIntoView = (el: Element | null) => {
        if (!el || typeof el.scrollIntoView !== 'function') {
            return
        }
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
    }
    const hits = (selectors: string[]) =>
        selectors.filter((selector) => {
            try {
                return Array.from(document.querySelectorAll(selector)).some(isVisible)
            } catch {
                return false
            }
        })
    const isCloudflareFrame = (el: Element | null) => {
        if (!el) {
            return false
        }
        if (el.tagName.toUpperCase() === 'IFRAME') {
            const src = String(el.getAttribute('src') || (el as HTMLIFrameElement).src || '')
            return src.includes('challenges.cloudflare.com') || src.includes('turnstile')
        }
        return Boolean(el.closest(options.frameSelectors.join(',')))
    }
    const selectorHits = hits(options.challengeSelectors)
    const deniedHits = hits(options.deniedSelectors)
    const widgetElements = Array.from(
        new Set(options.widgetSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))))
    ).filter(isVisible)
    const responseSelector = 'input[name="cf-turnstile-response"]'
    const responseInputs = Array.from(document.querySelectorAll<HTMLInputElement>(responseSelector))
    const contains = (parent: Element, child: Element): boolean => {
        let node: Element | null = child
        while (node) {
            if (node === parent) {
                return true
            }
            node = node.parentElement
        }
        return false
    }
    let expired = false
    let expiryUnavailable = false
    if (widgetElements.length === 1) {
        const api = (window as Window & { turnstile?: { isExpired?: () => boolean } }).turnstile
        if (typeof api?.isExpired === 'function') {
            try {
                expired = api.isExpired()
            } catch {
                expiryUnavailable = true
            }
        }
    }
    const completedWidgets =
        expired || expiryUnavailable
            ? []
            : widgetElements.filter((widget) => {
                  const form = widget.closest('form')
                  const associated = responseInputs.filter((input) => contains(widget, input))
                  const unique =
                      widgetElements.length === 1 &&
                      responseInputs.length === 1 &&
                      form &&
                      responseInputs[0]!.form === form
                          ? responseInputs
                          : []
                  return [...associated, ...unique].some(
                      (input) => typeof input.value === 'string' && input.value.trim()
                  )
              })
    const belongsToCompletedWidget = (el: Element) => completedWidgets.some((widget) => contains(widget, el))
    const pendingWidgets = widgetElements.filter((widget) => !completedWidgets.includes(widget))
    const frameHits = hits(options.frameSelectors)
    const cloudflareFramePresent = Array.from(document.querySelectorAll('iframe')).some((el) => isCloudflareFrame(el))
    const normalizedTitle = title.trim().toLowerCase().replace(/…/g, '...')
    const titlePending = options.titleNeedles.some((needle) => normalizedTitle.includes(String(needle).toLowerCase()))
    const textHits = options.textMarkers.filter((marker) =>
        visibleBodyText.toLowerCase().includes(String(marker).toLowerCase())
    )
    const originResponsePending = options.originResponsePendingTextMarkers.some((marker) =>
        visibleBodyText.toLowerCase().includes(String(marker).toLowerCase())
    )
    const interstitialPending = selectorHits.length > 0 || titlePending || textHits.length > 0
    const findVisibleTurnstileBox = () => {
        const input = responseInputs.find((candidate) => !belongsToCompletedWidget(candidate))
        if (!input) {
            return null
        }
        const candidates: Element[] = []
        let node = input.parentElement
        while (node && node !== document.documentElement) {
            if (isVisible(node)) {
                const rect = node.getBoundingClientRect()
                if (rect.width >= 120 && rect.height >= 40) {
                    candidates.push(node)
                }
            }
            node = node.parentElement
        }
        if (candidates.length === 0) {
            return null
        }
        return (
            candidates.find((el) => {
                const rect = el.getBoundingClientRect()
                return rect.width >= 250 && rect.width <= 340 && rect.height >= 50 && rect.height <= 85
            }) || candidates[0]
        )
    }
    const hostVerify =
        Array.from(document.querySelectorAll(options.verifyButtonSelectors.join(','))).find(
            (el) => isVisible(el) && !belongsToCompletedWidget(el)
        ) ||
        Array.from(document.querySelectorAll('button')).find((el) => {
            const text = (el.textContent || '').trim()
            return (
                isVisible(el) &&
                !belongsToCompletedWidget(el) &&
                (text === 'Verify you are human' || text === '请验证您是真人')
            )
        })
    const turnstileBox =
        !originResponsePending && (interstitialPending || pendingWidgets.length > 0) ? findVisibleTurnstileBox() : null
    const turnstilePresent =
        pendingWidgets.length > 0 ||
        Boolean(hostVerify) ||
        (!originResponsePending &&
            interstitialPending &&
            (cloudflareFramePresent || frameHits.length > 0 || Boolean(turnstileBox)))
    const turnstileState = expired
        ? 'expired'
        : turnstilePresent
          ? 'pending'
          : completedWidgets.length > 0
            ? 'completed'
            : 'none'
    const useIframeClick =
        turnstilePresent &&
        (cloudflareFramePresent ||
            (!hostVerify &&
                interstitialPending &&
                Boolean(document.querySelector('input[name="cf-turnstile-response"]'))))
    const pointFromRect = (rect: DOMRect, kind: 'verify' | 'widget') => {
        if (!rect || rect.width < 8 || rect.height < 8) {
            return null
        }
        const y = Math.round(rect.top + Math.min(rect.height, 65) / 2)
        if (kind === 'verify') {
            return { x: Math.round(rect.left + rect.width / 2), y }
        }
        const widgetWidth = Math.min(rect.width, 300)
        return { x: Math.round(rect.left + Math.min(20, Math.max(14, widgetWidth / 15))), y }
    }
    let clickPoint: { x: number; y: number } | null = null
    let clickTargetKind: 'verify' | 'widget' | null = null
    let clickSource: 'page' | 'iframe' | null = null
    const setClickTarget = (el: Element | null | undefined, kind: 'verify' | 'widget') => {
        if (!el) {
            return
        }
        bringIntoView(el)
        const point = pointFromRect(el.getBoundingClientRect(), kind)
        if (!point) {
            return
        }
        clickPoint = point
        clickTargetKind = kind
        clickSource = isCloudflareFrame(el) || useIframeClick ? 'iframe' : 'page'
    }
    if (hostVerify) {
        setClickTarget(hostVerify, 'verify')
    }
    if (!clickPoint && turnstileBox) {
        const boxRect = turnstileBox.getBoundingClientRect()
        if (boxRect.width <= 340 && boxRect.height <= 85) {
            setClickTarget(turnstileBox, 'widget')
        }
    }
    if (!clickPoint && turnstilePresent) {
        const frame = Array.from(document.querySelectorAll(options.frameSelectors.join(','))).find(
            (el) => isVisible(el) && !belongsToCompletedWidget(el)
        )
        if (frame) {
            setClickTarget(frame, 'widget')
        }
    }
    if (!clickPoint && turnstilePresent) {
        const widget = pendingWidgets.find(isVisible)
        if (widget) {
            setClickTarget(widget, 'widget')
        }
    }
    if (!clickPoint && turnstileBox) {
        setClickTarget(turnstileBox, 'widget')
    }
    const viewport = {
        screenX: Number(window.screenX),
        screenY: Number(window.screenY),
        innerWidth: Number(window.innerWidth),
        innerHeight: Number(window.innerHeight),
        outerWidth: Number(window.outerWidth),
        outerHeight: Number(window.outerHeight),
        devicePixelRatio: Number(window.devicePixelRatio || 1),
    }
    const horizontal = Math.max(0, viewport.outerWidth - viewport.innerWidth)
    const vertical = Math.max(0, viewport.outerHeight - viewport.innerHeight)
    const chromeLeft = Math.round(horizontal / 2)
    const chromeTop = Math.max(0, vertical - horizontal)
    const resolvedClickPoint = clickPoint as { x: number; y: number } | null
    const screenPoint =
        resolvedClickPoint === null
            ? null
            : {
                  x: Math.round(viewport.screenX + chromeLeft + resolvedClickPoint.x),
                  y: Math.round(viewport.screenY + chromeTop + resolvedClickPoint.y),
              }
    return {
        title,
        url,
        selectorHits,
        deniedHits,
        textHits,
        originResponsePending,
        turnstilePresent,
        turnstileState,
        clickPoint: resolvedClickPoint,
        clickTargetKind,
        clickSource,
        screenPoint,
        viewport,
    }
}
