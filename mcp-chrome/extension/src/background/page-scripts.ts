import type { SemanticTarget } from '../../../src/core/dom-helpers.js'

// ==================== 注入到页面的函数 ====================

export function observeNativePointer(operation: 'start' | 'read' | 'stop', id: string, deadline: number) {
    type Sample = {
        at: number
        previousAt?: number
        sameTarget: boolean
        clientX: number
        clientY: number
        screenX: number
        screenY: number
        scale: number
    }
    const scope = globalThis as typeof globalThis & {
        __mcpNativePointer?: { id: string; sample?: Sample; target?: EventTarget | null; stop: () => void }
    }
    if (operation === 'start') {
        scope.__mcpNativePointer?.stop()
        const listener = (event: PointerEvent) => {
            if (event.isTrusted && scope.__mcpNativePointer?.id === id) {
                scope.__mcpNativePointer.sample = {
                    at: Date.now(),
                    previousAt: scope.__mcpNativePointer.sample?.at,
                    sameTarget: scope.__mcpNativePointer.target === event.target,
                    clientX: event.clientX,
                    clientY: event.clientY,
                    screenX: event.screenX,
                    screenY: event.screenY,
                    scale: window.devicePixelRatio || 1,
                }
                scope.__mcpNativePointer.target = event.target
            }
        }
        const stop = () => {
            removeEventListener('pointermove', listener, true)
            clearTimeout(timer)
            if (scope.__mcpNativePointer?.id === id) {
                delete scope.__mcpNativePointer
            }
        }
        const timer = setTimeout(stop, Math.max(0, deadline - Date.now()))
        scope.__mcpNativePointer = { id, stop }
        addEventListener('pointermove', listener, true)
    }
    const current = scope.__mcpNativePointer
    if (current?.id !== id) {
        return { active: false }
    }
    if (operation === 'stop') {
        current.stop()
    }
    return { active: true, sample: current.sample }
}

export function installFrameProbeListener(): void {
    const probeWindow = window as Window & { __mcpFrameProbeListenerV2?: (event: MessageEvent) => Promise<void> }
    if (probeWindow.__mcpFrameProbeListenerV2) {
        return
    }
    const onMessage = async (event: MessageEvent): Promise<void> => {
        const data = event.data as { type?: string; token?: string; index?: number } | null
        if (
            event.source !== window.parent ||
            data?.type !== 'mcp-frame-probe-v2' ||
            typeof data.token !== 'string' ||
            data.token.length > 100 ||
            !Number.isInteger(data.index) ||
            (data.index ?? -1) < 0
        ) {
            return
        }
        const source = event.source as Window
        try {
            const runtime = typeof chrome === 'undefined' ? undefined : chrome.runtime
            if (typeof runtime?.sendMessage !== 'function') {
                // noinspection ExceptionCaughtLocallyJS -- Report failure
                throw new Error('Extension context invalidated: runtime messaging is unavailable')
            }
            const response = (await runtime.sendMessage({
                type: 'MCP_FRAME_PROBE',
                token: data.token,
                index: data.index,
            })) as { accepted?: boolean } | undefined
            if (response?.accepted) {
                source.postMessage({ type: 'mcp-frame-probe-ack-v2', token: data.token, index: data.index }, '*')
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (/Extension context invalidated/i.test(message)) {
                if (probeWindow.__mcpFrameProbeListenerV2 !== onMessage) {
                    return
                }
                window.removeEventListener('message', onMessage)
                delete probeWindow.__mcpFrameProbeListenerV2
            }
            console.warn('[MCP] iframe identity probe failed:', message)
        }
    }
    window.addEventListener('message', onMessage)
    probeWindow.__mcpFrameProbeListenerV2 = onMessage
}

// Accessibility Tree 生成
export function generateAccessibilityTree(
    filter: string,
    maxDepth: number,
    maxLength: number | null,
    refId: string | null,
    expectedUrl?: string | null
): {
    pageContent: string
    viewport: { width: number; height: number }
    interactiveElements?: Array<{
        refId: string
        role: string
        name: string
        value?: string
        selector: string
        visible: boolean
        disabled: boolean
        bounds: { x: number; y: number; width: number; height: number }
        covered: boolean
        frameId?: number
    }>
    error?: string
} {
    if (expectedUrl != null && location.href !== expectedUrl) {
        throw new Error('页面 URL 已变化，未读取')
    }
    // 初始化元素映射
    const win = window as Window & {
        __mcpElementMap?: Record<string, WeakRef<Element>>
        __mcpElementToRefId?: WeakMap<Element, string>
        __mcpRefCounter?: number
    }
    win.__mcpElementMap = win.__mcpElementMap || {}
    win.__mcpElementToRefId = win.__mcpElementToRefId || new WeakMap()
    win.__mcpRefCounter = win.__mcpRefCounter || 0

    const lines: string[] = []

    function getRole(element: Element): string {
        return globalThis.__mcpDomHelpers!.role(element)
    }

    function getName(element: Element): string {
        return globalThis.__mcpDomHelpers!.accessibleName(element, filter === 'all')
    }

    function currentValue(element: Element, name: string): string | undefined {
        if (element.tagName.toLowerCase() !== 'input') {
            return undefined
        }
        const input = element as HTMLInputElement
        if (
            ['hidden', 'password', 'file'].includes(input.type) ||
            (name && ['button', 'submit', 'reset'].includes(input.type))
        ) {
            return undefined
        }
        return input.value
    }

    function isVisible(element: Element): boolean {
        const style = window.getComputedStyle(element)
        const el = element as HTMLElement
        return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            el.offsetWidth > 0 &&
            el.offsetHeight > 0
        )
    }

    function isInteractive(element: Element): boolean {
        const tag = element.tagName.toLowerCase()
        return (
            ['a', 'button', 'input', 'select', 'textarea', 'details', 'summary'].includes(tag) ||
            element.getAttribute('onclick') !== null ||
            element.getAttribute('tabindex') !== null ||
            element.getAttribute('role') === 'button' ||
            element.getAttribute('role') === 'link' ||
            element.getAttribute('contenteditable') === 'true'
        )
    }

    function isLandmark(element: Element): boolean {
        const tag = element.tagName.toLowerCase()
        return (
            [
                'h1',
                'h2',
                'h3',
                'h4',
                'h5',
                'h6',
                'nav',
                'main',
                'header',
                'footer',
                'section',
                'article',
                'aside',
            ].includes(tag) || element.getAttribute('role') !== null
        )
    }

    function shouldInclude(element: Element, checkRefId: boolean): boolean {
        const tag = element.tagName.toLowerCase()

        if (['script', 'style', 'meta', 'link', 'title', 'noscript'].includes(tag)) {
            return false
        }

        if (filter !== 'all' && element.getAttribute('aria-hidden') === 'true') {
            return false
        }

        if (filter !== 'all' && !isVisible(element)) {
            return false
        }

        if (filter !== 'all' && !checkRefId) {
            const rect = element.getBoundingClientRect()
            if (!(
                rect.top < window.innerHeight &&
                rect.bottom > 0 &&
                rect.left < window.innerWidth &&
                rect.right > 0
            )) {
                return false
            }
        }

        if (filter === 'interactive') {
            return isInteractive(element)
        }

        if (isInteractive(element)) {
            return true
        }
        if (isLandmark(element)) {
            return true
        }
        if (getName(element).length > 0) {
            return true
        }

        const role = getRole(element)
        return role !== 'generic' && role !== 'image'
    }

    function getOrCreateRef(element: Element): string {
        const existing = win.__mcpElementToRefId!.get(element)
        if (existing && win.__mcpElementMap![existing]?.deref() === element) {
            return existing
        }

        const newRefId = `ref_${++win.__mcpRefCounter!}`
        win.__mcpElementMap![newRefId] = new WeakRef(element)
        win.__mcpElementToRefId!.set(element, newRefId)
        return newRefId
    }

    function cssSelector(element: Element): string {
        if (element.id) {
            return `#${CSS.escape(element.id)}`
        }
        const parts: string[] = []
        let current: Element | null = element
        while (current && current !== document.body && parts.length < 4) {
            const tag = current.tagName.toLowerCase()
            const parent: Element | null = current.parentElement
            if (!parent) {
                parts.unshift(tag)
                break
            }
            const currentTag = current.tagName
            const siblings = Array.from(parent.children).filter((child: Element) => child.tagName === currentTag)
            const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''
            parts.unshift(`${tag}${nth}`)
            current = parent
        }
        return parts.join(' > ')
    }

    function isDisabled(element: Element): boolean {
        return Boolean((element as HTMLButtonElement).disabled) || element.getAttribute('aria-disabled') === 'true'
    }

    function isCovered(element: Element): boolean {
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) {
            return false
        }
        const hit = globalThis.__mcpDomHelpers!.deepElementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return Boolean(hit && !globalThis.__mcpDomHelpers!.containsComposed(element, hit))
    }

    const interactiveElements: Array<{
        refId: string
        role: string
        name: string
        value?: string
        selector: string
        visible: boolean
        disabled: boolean
        bounds: { x: number; y: number; width: number; height: number }
        covered: boolean
    }> = []

    function rememberInteractive(element: Element, elementRefId: string, role: string, name: string, value?: string) {
        if (!isInteractive(element) || interactiveElements.length >= 100) {
            return
        }
        const rect = element.getBoundingClientRect()
        interactiveElements.push({
            refId: elementRefId,
            role,
            name,
            ...(value !== undefined ? { value } : {}),
            selector: cssSelector(element),
            visible: isVisible(element),
            disabled: isDisabled(element),
            bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            covered: isCovered(element),
        })
    }

    function traverse(root: Element, rootLevel: number, checkRefId: boolean) {
        const pending = [{ element: root, level: rootLevel }]
        while (pending.length) {
            const { element, level } = pending.pop()!
            if (level > maxDepth || !element || !element.tagName) {
                continue
            }

            const include = shouldInclude(element, checkRefId) || (checkRefId && level === 0)

            if (include) {
                const role = getRole(element)
                const name = getName(element)
                const elementRefId = getOrCreateRef(element)

                let line = '  '.repeat(level) + role
                if (name) {
                    line += ` "${name.replace(/\s+/g, ' ').replace(/"/g, '\\"')}"`
                }
                line += ` [${elementRefId}]`

                const href = element.getAttribute('href')
                if (href) {
                    line += ` href="${href}"`
                }

                const type = element.getAttribute('type')
                if (type) {
                    line += ` type="${type}"`
                }

                const value = currentValue(element, name)
                if (value !== undefined) {
                    line += ` value=${JSON.stringify(value)}`
                }
                lines.push(line)
                rememberInteractive(element, elementRefId, role, name, value)

                // 处理 select 的 options
                if (element.tagName.toLowerCase() === 'select') {
                    const select = element as HTMLSelectElement
                    for (const option of select.options) {
                        let optLine = '  '.repeat(level + 1) + 'option'
                        const optText = option.textContent?.trim() || ''
                        if (optText) {
                            optLine += ` "${optText.replace(/\s+/g, ' ').substring(0, 100).replace(/"/g, '\\"')}"`
                        }
                        if (option.selected) {
                            optLine += ' (selected)'
                        }
                        if (option.value && option.value !== optText) {
                            optLine += ` value="${option.value.replace(/"/g, '\\"')}"`
                        }
                        lines.push(optLine)
                    }
                }
            }

            // 按 Shadow 子树在前的顺序遍历
            if (element.children && level < maxDepth) {
                const children = [
                    ...(element.shadowRoot ? Array.from(element.shadowRoot.children) : []),
                    ...Array.from(element.children),
                ]
                for (let index = children.length - 1; index >= 0; --index) {
                    pending.push({ element: children[index]!, level: include ? level + 1 : level })
                }
            }
        }
    }

    if (refId) {
        const ref = win.__mcpElementMap![refId]
        if (!ref) {
            return {
                error: `Element with ref_id '${refId}' not found`,
                pageContent: '',
                viewport: { width: window.innerWidth, height: window.innerHeight },
            }
        }
        const element = ref.deref()
        if (!element) {
            return {
                error: `Element with ref_id '${refId}' no longer exists`,
                pageContent: '',
                viewport: { width: window.innerWidth, height: window.innerHeight },
            }
        }
        traverse(element, 0, true)
    } else if (document.body) {
        traverse(document.body, 0, false)
    }

    // 清理失效引用（懒执行：每 10 次调用执行一次,避免大型 SPA 上每次都全 Map 扫描）
    {
        const w = window as Window & { __mcpSweepCounter?: number }
        const counter = (w.__mcpSweepCounter ?? 0) + 1
        w.__mcpSweepCounter = counter
        if (counter % 10 === 0 || Object.keys(win.__mcpElementMap!).length > 500) {
            for (const id of Object.keys(win.__mcpElementMap!)) {
                if (!win.__mcpElementMap![id].deref()) {
                    delete win.__mcpElementMap![id]
                }
            }
        }
    }

    const content = lines.join('\n')

    if (maxLength && content.length > maxLength) {
        return {
            error: `Output exceeds ${maxLength} character limit (${content.length} characters)`,
            pageContent: '',
            viewport: { width: window.innerWidth, height: window.innerHeight },
        }
    }

    return {
        pageContent: content,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        interactiveElements,
    }
}

// 点击操作（高效模式）
export function performClick(refId: string, modifiers?: MouseEventInit): { success: boolean; error?: string } {
    const win = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
    const ref = win.__mcpElementMap?.[refId]

    if (!ref) {
        return { success: false, error: `Element ${refId} not found` }
    }

    const element = ref.deref()
    if (!element) {
        return { success: false, error: `Element ${refId} no longer exists` }
    }

    // 滚动到元素位置
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })

    // 高效点击：直接调用 click()
    const el = element as HTMLElement
    el.focus()
    globalThis.__mcpDomHelpers!.click(el, modifiers)

    return { success: true }
}

// 输入操作（高效模式）
export function performType(refId: string, text: string, clear: boolean): { success: boolean; error?: string } {
    const win = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
    const ref = win.__mcpElementMap?.[refId]

    if (!ref) {
        return { success: false, error: `Element ${refId} not found` }
    }

    const element = ref.deref()
    if (!element) {
        return { success: false, error: `Element ${refId} no longer exists` }
    }

    const el = element as HTMLInputElement | HTMLTextAreaElement
    el.focus()

    // 高效输入：直接设置 value
    if ('value' in el) {
        el.value = clear ? text : el.value + text
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
    } else if ((element as HTMLElement).contentEditable === 'true') {
        if (clear) {
            element.textContent = text
        } else {
            element.textContent = (element.textContent || '') + text
        }
        element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    }

    return { success: true }
}

// 滚动操作
export function performScroll(
    x: number,
    y: number,
    refId: string | null
): {
    success: boolean
    scrollX: number
    scrollY: number
    error?: string
} {
    if (refId) {
        const win = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
        const ref = win.__mcpElementMap?.[refId]

        if (!ref) {
            return { success: false, error: `Element ${refId} not found`, scrollX: 0, scrollY: 0 }
        }

        const element = ref.deref()
        if (!element) {
            return { success: false, error: `Element ${refId} no longer exists`, scrollX: 0, scrollY: 0 }
        }

        element.scrollBy(x, y)
        // 返回元素自身的滚动位置（不是 window 的），便于上层 diff 当前位置判断「是否到底」
        return { success: true, scrollX: element.scrollLeft, scrollY: element.scrollTop }
    }

    window.scrollBy(x, y)
    return { success: true, scrollX: window.scrollX, scrollY: window.scrollY }
}

// 代码执行
export async function executeCode(
    code: string,
    timeout?: number
): Promise<{
    success: boolean
    result?: string
    error?: string
    errorMessage?: string
    errorSource?: 'page' | 'context' | 'output'
    errorCode?: 'CSP_BLOCKED' | 'NON_SERIALIZABLE_EVALUATE_RESULT'
    actionExecuted?: false
}> {
    const errorText = (error: unknown): string => {
        try {
            return error instanceof Error ? String(error.message) : String(error)
        } catch {
            return 'Unprintable page exception'
        }
    }
    function evaluateSerializationError(
        message: string,
        suggestion: string,
        context: Record<string, unknown>
    ): { error: string; errorMessage: string } {
        return {
            error: JSON.stringify({
                error: {
                    code: 'NON_SERIALIZABLE_EVALUATE_RESULT',
                    message,
                    suggestion,
                    context,
                },
            }),
            errorMessage: message,
        }
    }

    function serializeEvaluateResult(result: unknown): {
        success: boolean
        result?: string
        error?: string
        errorMessage?: string
        errorSource?: 'output'
        errorCode?: 'NON_SERIALIZABLE_EVALUATE_RESULT'
    } {
        try {
            if (result instanceof Node) {
                const element = result instanceof Element ? result : result.parentElement
                return {
                    success: false,
                    errorSource: 'output',
                    ...evaluateSerializationError(
                        `返回值是 DOM 节点 ${result.nodeName}，不能直接 JSON 序列化`,
                        '请返回 textContent、outerHTML、getAttribute(...) 等简单字段，或改用 extract type="text"/"html"',
                        {
                            nodeType: result.nodeType,
                            nodeName: result.nodeName,
                            selector: element?.id ? `#${CSS.escape(element.id)}` : element?.tagName.toLowerCase(),
                        }
                    ),
                }
            }
            if (result instanceof NodeList || result instanceof HTMLCollection) {
                return {
                    success: false,
                    errorSource: 'output',
                    ...evaluateSerializationError(
                        `返回值是 ${result.constructor.name}，不能直接 JSON 序列化`,
                        '请用 Array.from(value).map(...) 提取需要的字段，例如 textContent、href、outerHTML',
                        { className: result.constructor.name, length: result.length }
                    ),
                }
            }
            return { success: true, result: JSON.stringify(result) }
        } catch (error) {
            const errorMsg = errorText(error)
            try {
                return {
                    success: false,
                    errorSource: 'output',
                    ...evaluateSerializationError(
                        `evaluate 返回值检查或序列化失败: ${errorMsg}`,
                        '请返回可 JSON 序列化的简单数据，并检查自定义原型或 getter 是否抛错',
                        { error: errorMsg }
                    ),
                }
            } catch (detailError) {
                return {
                    success: false,
                    errorSource: 'output',
                    errorCode: 'NON_SERIALIZABLE_EVALUATE_RESULT',
                    error: `evaluate 返回值检查或序列化失败: ${errorMsg}；输出错误详情生成失败: ${errorText(detailError)}`,
                }
            }
        }
    }

    let fn: () => unknown
    try {
        fn = new Function(`return (${code})`) as () => unknown
    } catch (error) {
        return {
            success: false,
            error: errorText(error),
            errorSource: 'context',
            actionExecuted: false,
            ...(error instanceof EvalError ? { errorCode: 'CSP_BLOCKED' } : {}),
        }
    }

    try {
        const result = fn()
        if (timeout === undefined) {
            return serializeEvaluateResult(await result)
        }

        const timedOut = Symbol('evaluate-timeout')
        let timeoutId: ReturnType<typeof setTimeout> | undefined
        const timeoutResult = new Promise<typeof timedOut>((resolve) => {
            timeoutId = setTimeout(() => resolve(timedOut), timeout)
        })
        try {
            const settled = await Promise.race([Promise.resolve(result), timeoutResult])
            if (settled === timedOut) {
                return { success: false, error: `Evaluation timeout after ${timeout}ms` }
            }
            return serializeEvaluateResult(settled)
        } finally {
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId)
            }
        }
    } catch (error) {
        return { success: false, error: errorText(error), errorSource: 'page' }
    }
}

// 提取文本
export function extractText(
    selector: string | null,
    expectedUrl?: string | null,
    refId?: string | null
): { text: string; error?: string } {
    if (expectedUrl != null && location.href !== expectedUrl) {
        throw new Error('页面 URL 已变化，未读取')
    }
    if (refId) {
        const win = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
        const element = win.__mcpElementMap?.[refId]?.deref()
        return {
            text: element?.isConnected
                ? element instanceof HTMLElement
                    ? element.innerText
                    : (element.textContent ?? '')
                : '',
        }
    }
    if (selector) {
        let element: Element | null
        try {
            element = document.querySelector(selector)
        } catch (e) {
            // 跨 realm instanceof 失效，用 name 判断（DOMException/SyntaxError 都可能）
            const err = e as { name?: string; message?: string }
            if (err?.name === 'SyntaxError') {
                return { text: '', error: `Invalid CSS selector: "${selector}" (${err.message})` }
            }
            throw e
        }
        return { text: element instanceof HTMLElement ? element.innerText : (element?.textContent ?? '') }
    }
    return { text: document.body.innerText }
}

// 提取 HTML
export function extractHtml(
    selector: string | null,
    outer: boolean,
    expectedUrl?: string | null,
    refId?: string | null
): { html: string; error?: string } {
    if (expectedUrl != null && location.href !== expectedUrl) {
        throw new Error('页面 URL 已变化，未读取')
    }
    if (refId) {
        const win = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
        const element = win.__mcpElementMap?.[refId]?.deref()
        return { html: element?.isConnected ? (outer ? element.outerHTML : element.innerHTML) : '' }
    }
    if (selector) {
        let element: Element | null
        try {
            element = document.querySelector(selector)
        } catch (e) {
            const err = e as { name?: string; message?: string }
            if (err?.name === 'SyntaxError') {
                return { html: '', error: `Invalid CSS selector: "${selector}" (${err.message})` }
            }
            throw e
        }
        if (!element) {
            return { html: '' }
        }
        // 读取元素 innerHTML（提取 HTML 内容，非 XSS 写入）
        // noinspection InnerHTMLJS
        return { html: outer ? element.outerHTML : element.innerHTML }
    }
    return { html: document.documentElement.outerHTML }
}

// 提取 HTML + 图片元信息
export function extractHtmlWithImages(
    selector: string | null,
    outer: boolean,
    expectedUrl?: string | null,
    refId?: string | null
): {
    html: string
    images: Array<{
        index: number
        src: string
        dataSrc: string
        alt: string
        width: number
        height: number
        naturalWidth: number
        naturalHeight: number
    }>
} {
    if (expectedUrl != null && location.href !== expectedUrl) {
        throw new Error('页面 URL 已变化，未读取')
    }
    let root: Element | null
    if (refId) {
        const win = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
        const element = win.__mcpElementMap?.[refId]?.deref()
        root = element?.isConnected ? element : null
    } else if (selector) {
        try {
            root = document.querySelector(selector)
        } catch (e) {
            const err = e as { name?: string; message?: string }
            if (err?.name === 'SyntaxError') {
                throw new Error(`Invalid CSS selector: "${selector}" (${err.message})`, { cause: e })
            }
            throw e
        }
    } else {
        root = document.documentElement
    }
    if (!root) {
        return { html: '', images: [] }
    }

    // 读取元素 innerHTML（提取 HTML 内容，非 XSS 写入）
    // noinspection InnerHTMLJS
    const html = selector || refId ? (outer ? root.outerHTML : root.innerHTML) : document.documentElement.outerHTML

    // 收集范围内所有 <img> 元素（文档顺序），含 root 自身
    const imgList: HTMLImageElement[] = []
    if (root.tagName === 'IMG') {
        imgList.push(root as HTMLImageElement)
    }
    root.querySelectorAll('img').forEach((img) => imgList.push(img))
    const images = imgList.map((img, index) => ({
        index,
        src: img.src, // 绝对 URL（浏览器已解析）
        dataSrc: (() => {
            const raw = img.dataset.src || img.dataset.lazySrc || img.dataset.original || ''
            if (!raw) {
                return ''
            }
            try {
                return new URL(raw, location.href).href
            } catch {
                return raw
            }
        })(), // 懒加载 URL（解析为绝对路径）
        alt: img.alt,
        width: img.width, // 渲染宽度
        height: img.height, // 渲染高度
        naturalWidth: img.naturalWidth, // 原始宽度
        naturalHeight: img.naturalHeight, // 原始高度
    }))

    return { html, images }
}

// 提取页面元信息
export function extractMetadata(expectedUrl?: string | null): Record<string, unknown> {
    if (expectedUrl != null && location.href !== expectedUrl) {
        throw new Error('页面 URL 已变化，未读取')
    }
    const meta = (name: string): string | undefined =>
        (document.querySelector(`meta[name="${name}"],meta[property="${name}"]`) as HTMLMetaElement | null)?.content ||
        undefined

    return {
        url: location.href || document.baseURI || undefined,
        title: document.title,
        description: meta('description'),
        canonical: (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)?.href || undefined,
        charset: document.characterSet,
        viewport: meta('viewport'),
        og: Object.fromEntries(
            Array.from(document.querySelectorAll('meta[property^="og:"]')).map((m) => [
                m.getAttribute('property')!,
                (m as HTMLMetaElement).content ?? '',
            ])
        ),
        twitter: Object.fromEntries(
            Array.from(document.querySelectorAll('meta[name^="twitter:"]')).map((m) => [
                m.getAttribute('name')!,
                (m as HTMLMetaElement).content ?? '',
            ])
        ),
        jsonLd: Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
            .map((s) => {
                try {
                    return JSON.parse(s.textContent ?? '')
                } catch {
                    return null
                }
            })
            .filter(Boolean),
        alternates: Array.from(document.querySelectorAll('link[rel="alternate"]')).map((l) => ({
            href: (l as HTMLLinkElement).href,
            type: l.getAttribute('type') || undefined,
            hreflang: l.getAttribute('hreflang') || undefined,
        })),
        feeds: Array.from(
            document.querySelectorAll('link[type="application/rss+xml"],link[type="application/atom+xml"]')
        ).map((l) => ({
            href: (l as HTMLLinkElement).href,
            type: l.getAttribute('type')!,
            title: l.getAttribute('title') || undefined,
        })),
    }
}

// 提取属性
export function extractAttribute(
    selector: string | null,
    refId: string | null,
    attribute: string,
    expectedUrl?: string | null
): { value: string | null } {
    if (expectedUrl != null && location.href !== expectedUrl) {
        throw new Error('页面 URL 已变化，未读取')
    }
    let element: Element | null = null

    if (refId) {
        const win = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
        const ref = win.__mcpElementMap?.[refId]
        element = ref?.deref() ?? null
    } else if (selector) {
        try {
            element = document.querySelector(selector)
        } catch (e) {
            const err = e as { name?: string; message?: string }
            if (err?.name === 'SyntaxError') {
                throw new Error(`Invalid CSS selector: "${selector}" (${err.message})`, { cause: e })
            }
            throw e
        }
    }

    if (!element) {
        return { value: null }
    }

    // 特定属性使用 property 方式获取（运行时实际值，而非 HTML 初始值）
    const propertyAttributes = ['value', 'checked', 'selected', 'disabled', 'readOnly', 'indeterminate']
    if (propertyAttributes.includes(attribute)) {
        const el = element as HTMLInputElement
        const propValue = el[attribute as keyof HTMLInputElement]
        if (typeof propValue === 'boolean') {
            return { value: propValue ? 'true' : 'false' }
        }
        return { value: propValue != null ? String(propValue) : null }
    }

    return { value: element.getAttribute(attribute) }
}

// 元素查找（支持 CSS 选择器、XPath、文本）
export function findElements(
    selector: string | null,
    text: string | null,
    xpath: string | null,
    expectedUrl?: string | null,
    point?: { x: number; y: number } | null,
    matchIndex?: number | null,
    semantic?: SemanticTarget | null
):
    | Array<{ refId: string; tag: string; text: string; rect: { x: number; y: number; width: number; height: number } }>
    | { error: string } {
    if (expectedUrl != null && location.href !== expectedUrl) {
        throw new Error('页面 URL 已变化，未读取')
    }
    const helpers = globalThis.__mcpDomHelpers
    if (!helpers) {
        throw new Error('DOM query helpers are not installed')
    }
    if (!point && !selector && !text && !xpath && !semantic) {
        return { error: 'find requires at least one of: selector, xpath, text, semantic' }
    }
    const win = window as Window & {
        __mcpElementMap?: Record<string, WeakRef<Element>>
        __mcpElementToRefId?: WeakMap<Element, string>
        __mcpRefCounter?: number
        __mcpSweepCounter?: number
    }
    win.__mcpElementMap ??= {}
    win.__mcpElementToRefId ??= new WeakMap()
    win.__mcpRefCounter ??= 0
    let elements: Element[]
    try {
        const hit = point ? helpers.deepElementFromPoint(point.x, point.y) : null
        elements = point ? (hit ? [hit] : []) : helpers.query({ selector, text, xpath, semantic })
    } catch (error) {
        if ((error as { name?: string }).name === 'SyntaxError') {
            return { error: 'Invalid CSS selector: ' + selector }
        }
        throw error
    }
    const selected = matchIndex == null ? elements.slice(0, 50) : elements.slice(matchIndex, matchIndex + 1)
    const results = selected.map((element) => {
        let refId = win.__mcpElementToRefId!.get(element)
        if (refId && win.__mcpElementMap![refId]?.deref() !== element) {
            refId = undefined
        }
        if (!refId) {
            refId = 'ref_' + ++win.__mcpRefCounter!
            win.__mcpElementMap![refId] = new WeakRef(element)
            win.__mcpElementToRefId!.set(element, refId)
        }
        const rect = element.getBoundingClientRect()
        return {
            refId,
            tag: element.tagName.toLowerCase(),
            text: (element.textContent ?? '').trim().substring(0, 100),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        }
    })
    const counter = (win.__mcpSweepCounter ?? 0) + 1
    win.__mcpSweepCounter = counter
    if (counter % 10 === 0 || Object.keys(win.__mcpElementMap).length > 500) {
        for (const [key, ref] of Object.entries(win.__mcpElementMap)) {
            if (!ref.deref()?.isConnected) {
                delete win.__mcpElementMap[key]
            }
        }
    }
    return results
}

// ==================== Stealth 模式注入函数 ====================

// 模拟鼠标点击
export function simulateMouseClick(
    x: number,
    y: number,
    button: string,
    clickCount = 1,
    refId?: string | null,
    modifiers?: MouseEventInit
): { success: boolean } {
    // refId 优先：用 __mcpElementMap 直接解析目标元素，避开 elementFromPoint 在嵌套 iframe overlay
    // 下命中外层 IFRAME 的问题；解析失败 fallback 到 elementFromPoint
    let element: Element | null = null
    if (refId) {
        const win = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
        const ref = win.__mcpElementMap?.[refId]
        const resolved = ref?.deref()
        if (resolved && resolved.isConnected) {
            element = resolved
            const r = resolved.getBoundingClientRect()
            x = r.x + r.width / 2
            y = r.y + r.height / 2
        }
    }
    if (!element) {
        element = globalThis.__mcpDomHelpers!.deepElementFromPoint(x, y)
    }
    if (!element) {
        return { success: false }
    }

    // W3C 标准：button 字段 left=0/middle=1/right=2；buttons 位掩码 left=1/middle=4/right=2
    const buttonCode = button === 'right' ? 2 : button === 'middle' ? 1 : 0
    const buttonsMask = button === 'right' ? 2 : button === 'middle' ? 4 : 1
    const baseOptions = {
        bubbles: true,
        composed: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x + window.screenX,
        screenY: y + window.screenY,
        button: buttonCode,
        ...modifiers,
    }
    const pressed = { ...baseOptions, buttons: buttonsMask }
    const released = { ...baseOptions, buttons: 0 }

    element.dispatchEvent(new MouseEvent('mouseover', released))
    element.dispatchEvent(
        new MouseEvent('mouseenter', { ...released, bubbles: false, composed: false, cancelable: false })
    )
    element.dispatchEvent(new MouseEvent('mousemove', released))
    const clickType = button === 'right' ? 'contextmenu' : button === 'middle' ? 'auxclick' : 'click'
    for (let detail = 1; detail <= clickCount; ++detail) {
        element.dispatchEvent(new MouseEvent('mousedown', { ...pressed, detail }))
        if (detail === 1 && 'focus' in element && typeof (element as HTMLElement).focus === 'function') {
            ;(element as HTMLElement).focus()
        }
        element.dispatchEvent(new MouseEvent('mouseup', { ...released, detail }))
        element.dispatchEvent(new MouseEvent(clickType, { ...released, detail }))
        if (button === 'left' && detail === 2) {
            element.dispatchEvent(new MouseEvent('dblclick', { ...released, detail }))
        }
    }

    return { success: true }
}

// 模拟键盘输入
export async function simulateKeyboardType(
    text: string,
    delay: number,
    deadline?: number
): Promise<{ success: boolean; error?: string }> {
    const expired = () => deadline !== undefined && Date.now() >= deadline
    const activeElement = globalThis.__mcpDomHelpers!.activeElement() as HTMLElement | null

    if (!activeElement) {
        return { success: false, error: 'No active element' }
    }

    // 检查元素是否可接收输入
    const acceptsInput =
        activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable

    if (!acceptsInput) {
        return { success: false, error: `Active element does not accept keyboard input: ${activeElement.tagName}` }
    }

    // 通过 nativeInputValueSetter 设置 value，兼容 React/Vue 等框架的受控组件
    // 避免 `el.value += char` 被 React 拒绝
    const proto = Object.getPrototypeOf(activeElement)
    const valueSetter =
        Object.getOwnPropertyDescriptor(proto, 'value') ??
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ??
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
    const setNativeValue = (val: string) => {
        if (valueSetter?.set) {
            valueSetter.set.call(activeElement, val)
        } else if ('value' in activeElement) {
            ;(activeElement as HTMLInputElement).value = val
        }
    }

    let firstCharacter = true
    for (const char of text.replace(/\r\n?/g, '\n')) {
        if (expired()) {
            return { success: false, error: 'input timeout during typing' }
        }
        // chrome.scripting.executeScript 支持异步函数，会 await 返回的 Promise
        // 首字符前不等待按键间隔
        if (delay > 0 && !firstCharacter) {
            const remaining = deadline === undefined ? delay : Math.max(0, deadline - Date.now())
            await new Promise((r) => setTimeout(r, Math.min(delay, remaining)))
        }
        if (expired()) {
            return { success: false, error: 'input timeout during typing' }
        }

        const keyEventOptions = {
            bubbles: true,
            composed: true,
            cancelable: true,
            key: char,
            code:
                char >= 'a' && char <= 'z'
                    ? `Key${char.toUpperCase()}`
                    : char >= 'A' && char <= 'Z'
                      ? `Key${char}`
                      : char >= '0' && char <= '9'
                        ? `Digit${char}`
                        : 'Key',
            charCode: char.charCodeAt(0),
            keyCode: char.charCodeAt(0),
            which: char.charCodeAt(0),
            view: window,
        }

        activeElement.dispatchEvent(new KeyboardEvent('keydown', keyEventOptions))
        activeElement.dispatchEvent(new KeyboardEvent('keypress', keyEventOptions))

        // 设置 value（input/textarea）或 textContent（contenteditable）
        if ('value' in activeElement) {
            const cur = (activeElement as HTMLInputElement).value ?? ''
            setNativeValue(cur + char)
        } else if (activeElement.isContentEditable) {
            activeElement.textContent = (activeElement.textContent || '') + char
        }

        activeElement.dispatchEvent(
            new InputEvent('input', {
                bubbles: true,
                composed: true,
                inputType: 'insertText',
                data: char,
            })
        )

        activeElement.dispatchEvent(new KeyboardEvent('keyup', keyEventOptions))
        firstCharacter = false
    }

    if (expired()) {
        return { success: false, error: 'input timeout during typing' }
    }
    activeElement.dispatchEvent(new Event('change', { bubbles: true }))

    return { success: true }
}

// 模拟单个按键事件
export function simulateKeyEvent(
    key: string,
    type: string,
    modifiers: string[],
    deadline?: number
): { success: boolean } {
    if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error('input timeout before event dispatch')
    }
    const activeElement = globalThis.__mcpDomHelpers!.activeElement() || document.body

    const keyEventOptions: KeyboardEventInit = {
        bubbles: true,
        composed: true,
        cancelable: true,
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        view: window,
        ctrlKey: modifiers.includes('ctrl'),
        shiftKey: modifiers.includes('shift'),
        altKey: modifiers.includes('alt'),
        metaKey: modifiers.includes('meta'),
    }

    if (type === 'down' || type === 'press') {
        activeElement.dispatchEvent(new KeyboardEvent('keydown', keyEventOptions))
    }
    if (type === 'press') {
        activeElement.dispatchEvent(new KeyboardEvent('keypress', keyEventOptions))
    }
    if (type === 'up' || type === 'press') {
        activeElement.dispatchEvent(new KeyboardEvent('keyup', keyEventOptions))
    }

    return { success: true }
}

// 模拟鼠标事件
export function simulateMouseEvent(
    type: string,
    x: number,
    y: number,
    button: string,
    deadline?: number | null,
    modifiers?: MouseEventInit
): { success: boolean } {
    if (deadline != null && Date.now() >= deadline) {
        throw new Error('input timeout before mouse event dispatch')
    }
    const element = globalThis.__mcpDomHelpers!.deepElementFromPoint(x, y) || document.body
    // W3C 标准：button 字段 left=0/middle=1/right=2；buttons 位掩码 left=1/middle=4/right=2
    const buttonCode = button === 'right' ? 2 : button === 'middle' ? 1 : 0
    const buttonsMask = button === 'right' ? 2 : button === 'middle' ? 4 : 1

    const eventOptions = {
        bubbles: true,
        composed: type !== 'mouseenter' && type !== 'mouseleave',
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x + window.screenX,
        screenY: y + window.screenY,
        button: buttonCode,
        ...modifiers,
        buttons: type === 'mousedown' ? buttonsMask : 0,
    }

    element.dispatchEvent(new MouseEvent(type, eventOptions))

    // mousedown 时聚焦可聚焦元素
    if (type === 'mousedown' && 'focus' in element && typeof element.focus === 'function') {
        ;(element as HTMLElement).focus()
    }

    // mouseup 后按鼠标键派发 click、auxclick 或 contextmenu
    if (type === 'mouseup') {
        const clickType = button === 'right' ? 'contextmenu' : button === 'middle' ? 'auxclick' : 'click'
        element.dispatchEvent(new MouseEvent(clickType, eventOptions))
    }

    return { success: true }
}

// 注入反检测脚本
export function injectStealthScripts(): void {
    // 覆盖 navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true,
    })

    // 覆盖 navigator.plugins（模拟真实浏览器）
    Object.defineProperty(navigator, 'plugins', {
        get: () => {
            //noinspection SpellCheckingInspection -- Chrome PDF Viewer 固定插件 ID
            const plugins = [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
                { name: 'Native Client', filename: 'internal-nacl-plugin' },
            ]
            // 反检测需要使用已废弃的 PluginArray/Plugin API，通过 globalThis 间接访问避免 TS6385
            const pluginArray = Object.create(
                (
                    globalThis as unknown as Record<
                        string,
                        {
                            prototype: object
                        }
                    >
                ).PluginArray.prototype
            )
            plugins.forEach((p, i) => {
                const plugin = Object.create(
                    (
                        globalThis as unknown as Record<
                            string,
                            {
                                prototype: object
                            }
                        >
                    ).Plugin.prototype
                )
                Object.defineProperties(plugin, {
                    name: { value: p.name },
                    filename: { value: p.filename },
                    description: { value: '' },
                    length: { value: 0 },
                })
                pluginArray[i] = plugin
            })
            Object.defineProperty(pluginArray, 'length', { value: plugins.length })
            return pluginArray
        },
        configurable: true,
    })

    // 覆盖 navigator.languages
    Object.defineProperty(navigator, 'languages', {
        get: () => ['zh-CN', 'zh', 'en-US', 'en'],
        configurable: true,
    })

    // 覆盖 chrome.runtime（隐藏扩展存在）
    const originalChrome = (window as unknown as { chrome?: unknown }).chrome
    const chromeDescriptor = Object.getOwnPropertyDescriptor(window, 'chrome')
    if (originalChrome && chromeDescriptor?.configurable) {
        Object.defineProperty(window, 'chrome', {
            get: () => {
                const chrome = { ...(originalChrome as object) }
                delete (chrome as { runtime?: unknown }).runtime
                return chrome
            },
            configurable: true,
        })
    }

    // 覆盖 Error.stack（移除扩展痕迹）
    ;(window as unknown as { Error: typeof Error }).Error = new Proxy(Error, {
        construct(target, args) {
            const error = new target(...args)
            const originalStack = error.stack
            if (originalStack) {
                error.stack = originalStack
                    .split('\n')
                    .filter((line) => !line.includes('chrome-extension://'))
                    .join('\n')
            }
            return error
        },
    })

    // 覆盖 Permissions API
    if (navigator.permissions) {
        const originalQuery = navigator.permissions.query.bind(navigator.permissions)
        navigator.permissions.query = async (descriptor: PermissionDescriptor) => {
            if (descriptor.name === 'notifications') {
                return { state: 'prompt', onchange: null } as PermissionStatus
            }
            return originalQuery(descriptor)
        }
    }

    // 覆盖 WebGL 渲染器信息
    const originalGetParameter = WebGLRenderingContext.prototype.getParameter
    WebGLRenderingContext.prototype.getParameter = function (parameter: number) {
        if (parameter === 37445) {
            // UNMASKED_VENDOR_WEBGL
            return 'Google Inc. (NVIDIA)'
        }
        if (parameter === 37446) {
            // UNMASKED_RENDERER_WEBGL
            return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)'
        }
        return originalGetParameter.call(this, parameter)
    }

    console.log('[MCP Stealth] Anti-detection scripts injected')
}

// ==================== Actionability 检查 ====================
// 参考 Playwright 的 actionability 模型，在交互前验证元素可操作性

export interface ActionabilityResult {
    actionable: boolean
    reason?: 'not-connected' | 'not-visible' | 'not-enabled' | 'covered' | 'pointer-events-none' | 'not-in-viewport'
    coveringElement?: string
    coveringRect?: { x: number; y: number; width: number; height: number }
    rect?: { x: number; y: number; width: number; height: number }
    clickPoint?: { x: number; y: number }
    candidates?: Array<{
        tag: string
        selector: string
        text: string
        rect: { x: number; y: number; width: number; height: number }
    }>
    suggestions?: string[]
}

type ActionabilityHelpers = {
    check(refId: string): ActionabilityResult
    scrollIntoViewWithRetry(refId: string): ActionabilityResult
}

type ActionabilityWindow = Window & {
    __mcpActionability?: ActionabilityHelpers
    __mcpElementMap?: Record<string, WeakRef<Element>>
}

export function installActionabilityHelpers(): void {
    const win = window as ActionabilityWindow

    function plainRect(r: DOMRect): { x: number; y: number; width: number; height: number } {
        return { x: r.x, y: r.y, width: r.width, height: r.height }
    }

    function selectorFor(el: Element): string {
        if (el.id) {
            return `#${CSS.escape(el.id)}`
        }
        const tag = el.tagName.toLowerCase()
        const parent = el.parentElement
        if (!parent) {
            return tag
        }
        const siblings = Array.from(parent.children).filter((child) => child.tagName === el.tagName)
        const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(el) + 1})` : ''
        return `${tag}${nth}`
    }

    function textFor(el: Element): string {
        return (el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
            .trim()
            .slice(0, 80)
    }

    function describeElement(el: Element): string {
        const tag = el.tagName.toLowerCase()
        const cls = el.className ? `.${String(el.className).split(/\s+/).filter(Boolean).slice(0, 2).join('.')}` : ''
        const id = el.id ? `#${el.id}` : ''
        return `<${tag}${id}${cls}>`
    }

    function candidatesAt(point: { x: number; y: number }): ActionabilityResult['candidates'] {
        if (point.x < 0 || point.y < 0 || point.x > window.innerWidth || point.y > window.innerHeight) {
            return []
        }
        return Array.from(document.elementsFromPoint(point.x, point.y))
            .slice(0, 8)
            .map((el) => ({
                tag: el.tagName.toLowerCase(),
                selector: selectorFor(el),
                text: textFor(el),
                rect: plainRect(el.getBoundingClientRect()),
            }))
    }

    function suggestionsFor(reason: NonNullable<ActionabilityResult['reason']>): string[] {
        if (reason === 'covered') {
            return ['点击点被其他元素覆盖，请关闭遮罩层、换用更精确 target，或确认后使用 force=true']
        }
        if (reason === 'not-in-viewport') {
            return ['元素不在视口内，请先滚动到目标元素或改用可见元素定位']
        }
        if (reason === 'not-visible') {
            return ['元素不可见，请等待页面渲染完成，或改用当前可见的元素定位']
        }
        if (reason === 'not-enabled') {
            return ['元素被禁用，请等待 enabled 状态或检查表单前置条件']
        }
        if (reason === 'pointer-events-none') {
            return ['元素设置了 pointer-events:none，请定位实际接收事件的子元素或父元素']
        }
        return ['元素引用失效，请重新执行 extract type="state" 获取新的 refId']
    }

    function resolveElement(refId: string): Element | undefined {
        return win.__mcpElementMap?.[refId]?.deref()
    }

    function check(refId: string): ActionabilityResult {
        const element = resolveElement(refId)
        if (!element || !element.isConnected) {
            return {
                actionable: false,
                reason: 'not-connected',
                suggestions: suggestionsFor('not-connected'),
            }
        }

        const style = window.getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        const clickPoint = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
        const failure = (
            reason: NonNullable<ActionabilityResult['reason']>,
            extra: Partial<ActionabilityResult> = {}
        ): ActionabilityResult => ({
            actionable: false,
            reason,
            rect: plainRect(rect),
            clickPoint,
            candidates: candidatesAt(clickPoint),
            suggestions: suggestionsFor(reason),
            ...extra,
        })

        if (typeof element.checkVisibility === 'function' && !element.checkVisibility()) {
            return failure('not-visible')
        }
        if (style.visibility !== 'visible') {
            return failure('not-visible')
        }
        if (style.display !== 'contents' && rect.width === 0 && rect.height === 0) {
            const hasVisualChild = element.querySelector('svg, canvas, img, video') !== null
            if (!hasVisualChild) {
                return failure('not-visible')
            }
        }
        const htmlEl = element as HTMLElement
        if ('disabled' in htmlEl && (htmlEl as HTMLButtonElement).disabled) {
            return failure('not-enabled')
        }
        let ancestor: Element | null = element
        while (ancestor) {
            if (ancestor.getAttribute('aria-disabled') === 'true') {
                return failure('not-enabled')
            }
            ancestor = ancestor.parentElement
        }
        if (style.pointerEvents === 'none') {
            return failure('pointer-events-none')
        }
        const vw = window.innerWidth
        const vh = window.innerHeight
        if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) {
            return failure('not-in-viewport')
        }
        const hitEl = globalThis.__mcpDomHelpers!.deepElementFromPoint(clickPoint.x, clickPoint.y)
        if (hitEl && !globalThis.__mcpDomHelpers!.containsComposed(element, hitEl)) {
            return failure('covered', {
                coveringElement: describeElement(hitEl),
                coveringRect: plainRect(hitEl.getBoundingClientRect()),
            })
        }
        return {
            actionable: true,
            rect: plainRect(rect),
            clickPoint,
            candidates: candidatesAt(clickPoint),
        }
    }

    function scrollIntoViewWithRetry(refId: string): ActionabilityResult {
        const element = resolveElement(refId)
        if (!element || !element.isConnected) {
            return { actionable: false, reason: 'not-connected', suggestions: suggestionsFor('not-connected') }
        }
        const alignments: ScrollIntoViewOptions[] = [
            { block: 'center', inline: 'center', behavior: 'instant' },
            { block: 'end', inline: 'end', behavior: 'instant' },
            { block: 'start', inline: 'start', behavior: 'instant' },
            { block: 'nearest', inline: 'nearest', behavior: 'instant' },
        ]
        for (const alignment of alignments) {
            element.scrollIntoView(alignment)
            const result = check(refId)
            if (result.actionable) {
                return result
            }
        }
        return check(refId)
    }

    win.__mcpActionability = { check, scrollIntoViewWithRetry }
}

export function checkActionability(refId: string): ActionabilityResult {
    const helpers = (window as ActionabilityWindow).__mcpActionability
    if (!helpers) {
        return {
            actionable: false,
            reason: 'not-connected',
            suggestions: ['actionability helper 未安装，请重试当前操作'],
        }
    }
    return helpers.check(refId)
}

/**
 * 带 actionability 检查的点击（注入到页面执行）
 *
 * 流程：
 * 1. 检查可操作性
 * 2. 不在视口 → 滚动（4 种对齐轮换）
 * 3. 重新检查可操作性（滚动后坐标变化）
 * 4. 验证 hit target
 * 5. 执行点击
 */
export function performActionableClick(
    refId: string,
    force: boolean,
    modifiers?: MouseEventInit
): Partial<ActionabilityResult> & {
    success: boolean
    error?: string
} {
    const helpers = (window as ActionabilityWindow).__mcpActionability
    if (!helpers) {
        return {
            success: false,
            error: 'actionability helper 未安装，请重试当前操作',
            reason: 'not-connected',
            suggestions: ['actionability helper 未安装，请重试当前操作'],
        }
    }

    function dispatchClickSequence(el: HTMLElement): void {
        const rect = el.getBoundingClientRect()
        const cx = Math.round(rect.x + rect.width / 2)
        const cy = Math.round(rect.y + rect.height / 2)
        const opts = {
            bubbles: true,
            composed: true,
            cancelable: true,
            button: 0,
            buttons: 1,
            ...modifiers,
            clientX: cx,
            clientY: cy,
            view: window,
        }
        el.dispatchEvent(new MouseEvent('mousedown', opts))
        el.focus()
        el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }))
        globalThis.__mcpDomHelpers!.click(el, modifiers, { ...opts, buttons: 0 })
    }

    // force 模式：跳过所有检查，直接点击
    if (force) {
        const win = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
        const ref = win.__mcpElementMap?.[refId]
        if (!ref) {
            return { success: false, error: `Element ${refId} not found` }
        }
        const element = ref.deref()
        if (!element) {
            return { success: false, error: `Element ${refId} no longer exists` }
        }
        const el = element as HTMLElement
        el.focus()
        dispatchClickSequence(el)
        return { success: true }
    }

    // 正常模式：actionability 检查
    let result = helpers.check(refId)

    // 不在视口 → 自动滚动
    if (!result.actionable && result.reason === 'not-in-viewport') {
        result = helpers.scrollIntoViewWithRetry(refId)
    }

    if (!result.actionable) {
        const msg =
            result.reason === 'covered'
                ? `Element is covered by ${result.coveringElement}`
                : `Element is not actionable: ${result.reason}`
        return {
            success: false,
            error: msg,
            reason: result.reason,
            coveringElement: result.coveringElement,
            coveringRect: result.coveringRect,
            rect: result.rect,
            clickPoint: result.clickPoint,
            candidates: result.candidates,
            suggestions: result.suggestions,
        }
    }

    // 通过检查，执行点击
    const win = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
    const ref = win.__mcpElementMap?.[refId]
    const element = ref?.deref()
    if (!element) {
        return { success: false, error: `Element ${refId} no longer exists` }
    }

    const el = element as HTMLElement
    el.focus()
    dispatchClickSequence(el)

    return { success: true }
}

// ==================== dispatch 输入（MAIN 世界，与 refId 创建侧一致以共享 __mcpElementMap）====================

/**
 * HTML5 drag 必须通过 DragEvent dispatchEvent 模拟（原生鼠标事件无法触发）
 * 在 MAIN 世界执行，refId 创建与消费侧均在 MAIN，共享 __mcpElementMap
 */
export function performDragAndDrop(
    srcRefId: string,
    dstRefId: string
): { success: boolean; error?: string; code?: 'REF_STALE' } {
    const win = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
    const srcRef = win.__mcpElementMap?.[srcRefId]
    const dstRef = win.__mcpElementMap?.[dstRefId]
    const src = srcRef?.deref()
    const dst = dstRef?.deref()
    if (!src) {
        return { success: false, code: 'REF_STALE', error: `drag 源元素 ${srcRefId} 不存在或已从 DOM 移除` }
    }
    if (!dst) {
        return { success: false, code: 'REF_STALE', error: `drag 目标元素 ${dstRefId} 不存在或已从 DOM 移除` }
    }
    const dt = new DataTransfer()
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    dst.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
    return { success: true }
}

/**
 * 通过 nativeInputValueSetter 直接设置 value 并触发 input/change 事件
 * 兼容 React/Vue 等框架的受控组件（参考 Playwright fill()）
 */
export function dispatchInputToElement(refId: string, val: string): { success: boolean; error?: string } {
    const win = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
    const ref = win.__mcpElementMap?.[refId]
    const el = ref?.deref() as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined
    if (!el) {
        return { success: false, error: `Element ${refId} not found` }
    }
    const tag = el.namespaceURI === 'http://www.w3.org/1999/xhtml' ? el.localName : undefined
    const prototype =
        tag === 'input'
            ? HTMLInputElement.prototype
            : tag === 'textarea'
              ? HTMLTextAreaElement.prototype
              : tag === 'select'
                ? HTMLSelectElement.prototype
                : undefined
    if (!prototype && !el.isContentEditable) {
        return { success: false, error: 'controlled 输入需要 input、textarea、select 或 contenteditable 目标' }
    }
    if (el.matches(':disabled') || ('readOnly' in el && el.readOnly)) {
        return { success: false, error: 'controlled 输入目标处于 disabled 或 readonly 状态' }
    }
    if (tag === 'input' && el.type === 'file') {
        return { success: false, error: '文件控件请使用 upload 事件' }
    }
    const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value')?.set : undefined
    if (prototype && !setter) {
        return { success: false, error: 'controlled 输入目标的原生 value setter 不可用' }
    }
    el.focus()
    if (setter) {
        setter.call(el, val)
    } else {
        el.textContent = val
    }
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { success: true }
}

// ==================== computed style 提取（MAIN 世界，与 refId 创建侧一致以共享 __mcpElementMap）====================

/**
 * 获取元素的 computed style
 * prop = '*' 返回全部属性 JSON；否则返回指定属性值
 */
export function getComputedStyleFromElement(refId: string, prop: string, expectedUrl?: string | null): string | null {
    if (expectedUrl != null && location.href !== expectedUrl) {
        throw new Error('页面 URL 已变化，未读取')
    }
    const win = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
    const ref = win.__mcpElementMap?.[refId]
    const el = ref?.deref()
    if (!el) {
        return null
    }
    const cs = window.getComputedStyle(el)
    if (prop === '*') {
        const obj: Record<string, string> = {}
        for (let i = 0; i < cs.length; i++) {
            obj[cs[i]] = cs.getPropertyValue(cs[i])
        }
        return JSON.stringify(obj)
    }
    return cs.getPropertyValue(prop)
}

export { inspectChallengePage } from '../../../src/core/challenge-page.js'
