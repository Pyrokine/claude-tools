// ==================== 注入到页面的函数 ====================

// Accessibility Tree 生成
export function generateAccessibilityTree(
    filter: string,
    maxDepth: number,
    maxLength: number | null,
    refId: string | null
): {
    pageContent: string
    viewport: { width: number; height: number }
    interactiveElements?: Array<{
        refId: string
        role: string
        name: string
        selector: string
        visible: boolean
        disabled: boolean
        bounds: { x: number; y: number; width: number; height: number }
        covered: boolean
        frameId?: number
    }>
    error?: string
} {
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
        const role = element.getAttribute('role')
        if (role) {
            return role
        }

        const tag = element.tagName.toLowerCase()
        const type = element.getAttribute('type')

        const roleMap: Record<string, string> = {
            a: 'link',
            button: 'button',
            input:
                type === 'submit' || type === 'button'
                    ? 'button'
                    : type === 'checkbox'
                      ? 'checkbox'
                      : type === 'radio'
                        ? 'radio'
                        : type === 'file'
                          ? 'button'
                          : 'textbox',
            select: 'combobox',
            textarea: 'textbox',
            h1: 'heading',
            h2: 'heading',
            h3: 'heading',
            h4: 'heading',
            h5: 'heading',
            h6: 'heading',
            img: 'image',
            nav: 'navigation',
            main: 'main',
            header: 'banner',
            footer: 'contentinfo',
            section: 'region',
            article: 'article',
            aside: 'complementary',
            form: 'form',
            table: 'table',
            ul: 'list',
            ol: 'list',
            li: 'listitem',
            label: 'label',
        }

        return roleMap[tag] || 'generic'
    }

    function getName(element: Element): string {
        const tag = element.tagName.toLowerCase()

        // Select 元素
        if (tag === 'select') {
            const select = element as HTMLSelectElement
            const selected = select.querySelector('option[selected]') || select.options[select.selectedIndex]
            if (selected?.textContent) {
                return selected.textContent.trim()
            }
        }

        // ARIA label
        const ariaLabel = element.getAttribute('aria-label')
        if (ariaLabel?.trim()) {
            return ariaLabel.trim()
        }

        // Placeholder
        const placeholder = element.getAttribute('placeholder')
        if (placeholder?.trim()) {
            return placeholder.trim()
        }

        // Title
        const title = element.getAttribute('title')
        if (title?.trim()) {
            return title.trim()
        }

        // Alt
        const alt = element.getAttribute('alt')
        if (alt?.trim()) {
            return alt.trim()
        }

        // Label for
        if (element.id) {
            const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`)
            if (label?.textContent?.trim()) {
                return label.textContent.trim()
            }
        }

        // Input value
        if (tag === 'input') {
            const input = element as HTMLInputElement
            const inputType = input.type || ''
            if (inputType === 'submit' && input.value?.trim()) {
                return input.value.trim()
            }
            if (input.value && input.value.length < 50) {
                return input.value.trim()
            }
        }

        // Button/Link text
        if (['button', 'a', 'summary'].includes(tag)) {
            let text = ''
            for (const child of element.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                    text += child.textContent
                }
            }
            if (text.trim()) {
                return text.trim()
            }
        }

        // Heading text
        if (tag.match(/^h[1-6]$/)) {
            const text = element.textContent
            if (text?.trim()) {
                return text.trim().substring(0, 100)
            }
        }

        // Generic text content
        let textContent = ''
        for (const child of element.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                textContent += child.textContent
            }
        }
        if (textContent.trim().length >= 3) {
            const trimmed = textContent.trim()
            return trimmed.length > 100 ? trimmed.substring(0, 100) + '...' : trimmed
        }

        return ''
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
            if (
                !(rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0)
            ) {
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
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return Boolean(hit && hit !== element && !element.contains(hit) && !hit.contains(element))
    }

    const interactiveElements: Array<{
        refId: string
        role: string
        name: string
        selector: string
        visible: boolean
        disabled: boolean
        bounds: { x: number; y: number; width: number; height: number }
        covered: boolean
    }> = []

    function rememberInteractive(element: Element, elementRefId: string, role: string, name: string) {
        if (!isInteractive(element) || interactiveElements.length >= 100) {
            return
        }
        const rect = element.getBoundingClientRect()
        interactiveElements.push({
            refId: elementRefId,
            role,
            name,
            selector: cssSelector(element),
            visible: isVisible(element),
            disabled: isDisabled(element),
            bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            covered: isCovered(element),
        })
    }

    function traverse(element: Element, level: number, checkRefId: boolean) {
        if (level > maxDepth || !element || !element.tagName) {
            return
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

            lines.push(line)
            rememberInteractive(element, elementRefId, role, name)

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

        // 递归子元素
        if (element.children && level < maxDepth) {
            for (const child of element.children) {
                traverse(child, include ? level + 1 : level, checkRefId)
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
export function performClick(refId: string): { success: boolean; error?: string } {
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
    el.click()

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
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
    } else if ((element as HTMLElement).contentEditable === 'true') {
        if (clear) {
            element.textContent = text
        } else {
            element.textContent = (element.textContent || '') + text
        }
        element.dispatchEvent(new Event('input', { bubbles: true }))
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
export function executeCode(code: string): { success: boolean; result?: string; error?: string } {
    function evaluateSerializationError(message: string, suggestion: string, context: Record<string, unknown>): string {
        return JSON.stringify({
            error: {
                code: 'NON_SERIALIZABLE_EVALUATE_RESULT',
                message,
                suggestion,
                context,
            },
        })
    }

    function serializeEvaluateResult(result: unknown): { success: boolean; result?: string; error?: string } {
        if (result instanceof Node) {
            const element = result instanceof Element ? result : result.parentElement
            return {
                success: false,
                error: evaluateSerializationError(
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
                error: evaluateSerializationError(
                    `返回值是 ${result.constructor.name}，不能直接 JSON 序列化`,
                    '请用 Array.from(value).map(...) 提取需要的字段，例如 textContent、href、outerHTML',
                    { className: result.constructor.name, length: result.length }
                ),
            }
        }
        try {
            return { success: true, result: JSON.stringify(result) }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            return {
                success: false,
                error: evaluateSerializationError(
                    `evaluate 返回值无法 JSON 序列化: ${errorMsg}`,
                    '请返回字符串、数字、布尔值、数组或普通对象，避免返回循环引用、BigInt、DOM 对象',
                    { error: errorMsg }
                ),
            }
        }
    }

    try {
        const fn = new Function(`return (${code})`)
        return serializeEvaluateResult(fn())
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error'
        if (errorMsg.includes('Content Security Policy') || errorMsg.includes("'unsafe-eval'")) {
            return {
                success: false,
                error: `CSP 限制：此页面禁止动态代码执行，建议使用 extract 工具获取页面内容或使用 CDP 模式，原始错误: ${errorMsg}`,
            }
        }
        return { success: false, error: errorMsg }
    }
}

// 提取文本
export function extractText(selector: string | null): { text: string; error?: string } {
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
        return { text: element?.textContent || '' }
    }
    return { text: document.body.innerText }
}

// 提取 HTML
export function extractHtml(selector: string | null, outer: boolean): { html: string; error?: string } {
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
    outer: boolean
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
    let root: Element | null
    if (selector) {
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
    const html = selector ? (outer ? root.outerHTML : root.innerHTML) : document.documentElement.outerHTML

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
export function extractMetadata(): Record<string, unknown> {
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
    attribute: string
): { value: string | null } {
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
    xpath: string | null
):
    | Array<{
          refId: string
          tag: string
          text: string
          rect: { x: number; y: number; width: number; height: number }
      }>
    | { error: string } {
    const win = window as Window & {
        __mcpElementMap?: Record<string, WeakRef<Element>>
        __mcpElementToRefId?: WeakMap<Element, string>
        __mcpRefCounter?: number
    }
    win.__mcpElementMap = win.__mcpElementMap || {}
    win.__mcpElementToRefId = win.__mcpElementToRefId || new WeakMap()
    win.__mcpRefCounter = win.__mcpRefCounter || 0

    const results: Array<{
        refId: string
        tag: string
        text: string
        rect: { x: number; y: number; width: number; height: number }
    }> = []

    let elements: Element[]

    if (xpath) {
        // XPath 查询
        elements = []
        const xpathResult = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
        for (let i = 0; i < xpathResult.snapshotLength; i++) {
            const node = xpathResult.snapshotItem(i)
            if (node instanceof Element) {
                elements.push(node)
            }
        }
    } else if (selector) {
        // CSS 选择器查询；非法 selector 转为 {error} 返回（Chrome 会吞掉同步 throw，故用结构化返回）
        try {
            elements = Array.from(document.querySelectorAll(selector))
        } catch (e) {
            // 跨 realm instanceof 失效，用 name 判断
            const err = e as { name?: string; message?: string }
            if (err?.name === 'SyntaxError') {
                return { error: `Invalid CSS selector: "${selector}" (${err.message})` }
            }
            throw e
        }
    } else if (text) {
        // 无 selector / xpath 但有 text：用 TreeWalker 走文本节点，避开 querySelectorAll('*')
        // 大型 SPA 中后者会触发 O(N) 全树扫描 + N 次 getBoundingClientRect
        elements = []
        const seen = new Set<Element>()
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) =>
                (node as Text).data?.includes(text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
        })
        let n: Node | null = walker.nextNode()
        while (n && elements.length < 200) {
            const parent = (n as Text).parentElement
            if (parent && !seen.has(parent)) {
                seen.add(parent)
                elements.push(parent)
            }
            n = walker.nextNode()
        }
    } else {
        // selector / xpath / text 全空：拒绝全树扫描，要求调用方至少传一个
        return { error: 'find requires at least one of: selector, xpath, text' }
    }

    for (const element of elements) {
        if (text) {
            const elementText = element.textContent || ''
            if (!elementText.includes(text)) {
                continue
            }
        }

        // 查找或创建 refId（用 WeakMap 反向索引避免 O(N×M)）
        let refId = win.__mcpElementToRefId!.get(element) ?? null
        if (refId && win.__mcpElementMap![refId]?.deref() !== element) {
            refId = null
        }

        if (!refId) {
            refId = `ref_${++win.__mcpRefCounter!}`
            win.__mcpElementMap![refId] = new WeakRef(element)
            win.__mcpElementToRefId!.set(element, refId)
        }

        const rect = element.getBoundingClientRect()
        results.push({
            refId,
            tag: element.tagName.toLowerCase(),
            text: (element.textContent || '').trim().substring(0, 100),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        })

        if (results.length >= 50) {
            break
        }
    }

    // 清理失效引用，防止 key 泄漏（懒执行：每 10 次调用一次,或 Map 大于 500 时强制执行）
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

    return results
}

// ==================== Stealth 模式注入函数 ====================

// 模拟鼠标点击
export function simulateMouseClick(
    x: number,
    y: number,
    button: string,
    clickCount = 1,
    refId?: string
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
        element = document.elementFromPoint(x, y)
    }
    if (!element) {
        return { success: false }
    }

    // W3C 标准：button 字段 left=0/middle=1/right=2；buttons 位掩码 left=1/middle=4/right=2
    const buttonCode = button === 'right' ? 2 : button === 'middle' ? 1 : 0
    const buttonsMask = button === 'right' ? 2 : button === 'middle' ? 4 : 1
    const baseOptions = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x + window.screenX,
        screenY: y + window.screenY,
        button: buttonCode,
    }
    const pressed = { ...baseOptions, buttons: buttonsMask }
    const released = { ...baseOptions, buttons: 0 }

    element.dispatchEvent(new MouseEvent('mouseover', released))
    element.dispatchEvent(new MouseEvent('mouseenter', { ...released, bubbles: false }))
    element.dispatchEvent(new MouseEvent('mousemove', released))
    element.dispatchEvent(new MouseEvent('mousedown', { ...pressed, detail: 1 }))

    // mousedown 时聚焦可聚焦元素
    if ('focus' in element && typeof (element as HTMLElement).focus === 'function') {
        ;(element as HTMLElement).focus()
    }

    element.dispatchEvent(new MouseEvent('mouseup', { ...released, detail: 1 }))

    // 右键不触发 click，而是触发 contextmenu（浏览器原生行为）
    if (button === 'right') {
        element.dispatchEvent(new MouseEvent('contextmenu', released))
    } else {
        element.dispatchEvent(new MouseEvent('click', { ...released, detail: 1 }))
    }

    // 补发双击/三击事件（clickCount > 1 时）
    for (let i = 2; i <= clickCount; i++) {
        element.dispatchEvent(new MouseEvent('mousedown', { ...pressed, detail: i }))
        element.dispatchEvent(new MouseEvent('mouseup', { ...released, detail: i }))
        if (button !== 'right') {
            element.dispatchEvent(new MouseEvent('click', { ...released, detail: i }))
            if (i === 2) {
                element.dispatchEvent(new MouseEvent('dblclick', { ...released, detail: i }))
            }
        }
    }

    return { success: true }
}

// 模拟键盘输入
export async function simulateKeyboardType(text: string, delay: number): Promise<{ success: boolean; error?: string }> {
    const activeElement = document.activeElement as HTMLElement | null

    if (!activeElement) {
        return { success: false, error: 'No active element' }
    }

    // 检查是否是可输入元素
    const isInputable =
        activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable

    if (!isInputable) {
        return { success: false, error: `Active element is not inputable: ${activeElement.tagName}` }
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

    for (const char of text) {
        // chrome.scripting.executeScript 支持异步函数，会 await 返回的 Promise
        if (delay > 0) {
            await new Promise((r) => setTimeout(r, delay))
        }

        const keyEventOptions = {
            bubbles: true,
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
                cancelable: true,
                inputType: 'insertText',
                data: char,
            })
        )

        activeElement.dispatchEvent(new KeyboardEvent('keyup', keyEventOptions))
    }

    activeElement.dispatchEvent(new Event('change', { bubbles: true }))

    return { success: true }
}

// 模拟单个按键事件
export function simulateKeyEvent(key: string, type: string, modifiers: string[]): { success: boolean } {
    const activeElement = document.activeElement || document.body

    const keyEventOptions: KeyboardEventInit = {
        bubbles: true,
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
export function simulateMouseEvent(type: string, x: number, y: number, button: string): { success: boolean } {
    const element = document.elementFromPoint(x, y) || document.body
    // W3C 标准：button 字段 left=0/middle=1/right=2；buttons 位掩码 left=1/middle=4/right=2
    const buttonCode = button === 'right' ? 2 : button === 'middle' ? 1 : 0
    const buttonsMask = button === 'right' ? 2 : button === 'middle' ? 4 : 1

    const eventOptions = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x + window.screenX,
        screenY: y + window.screenY,
        button: buttonCode,
        buttons: type === 'mousedown' ? buttonsMask : 0,
    }

    element.dispatchEvent(new MouseEvent(type, eventOptions))

    // mousedown 时聚焦可聚焦元素
    if (type === 'mousedown' && 'focus' in element && typeof element.focus === 'function') {
        ;(element as HTMLElement).focus()
    }

    // mouseup 后自动触发 click 事件（模拟原生浏览器行为）
    // 右键 mouseup 触发 contextmenu 而非 click（浏览器原生行为）
    if (type === 'mouseup') {
        if (button === 'right') {
            element.dispatchEvent(new MouseEvent('contextmenu', eventOptions))
        } else {
            element.dispatchEvent(new MouseEvent('click', eventOptions))
        }
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
        const hitEl = document.elementFromPoint(clickPoint.x, clickPoint.y)
        if (hitEl && hitEl !== element && !element.contains(hitEl) && !hitEl.contains(element)) {
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
    force: boolean
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
            cancelable: true,
            button: 0,
            buttons: 1,
            clientX: cx,
            clientY: cy,
            view: window,
        }
        const reactHandlers = Object.keys(el)
            .filter((key) => key.startsWith('__reactProps'))
            .map((key) => {
                const props = (el as unknown as Record<string, Record<string, unknown>>)[key]
                const handler = props?.onClick
                if (typeof handler !== 'function') {
                    return null
                }
                let called = false
                props.onClick = function (...args: unknown[]) {
                    called = true
                    return handler.apply(this, args)
                }
                return { props, handler, wasCalled: () => called }
            })
            .filter(
                (
                    item
                ): item is {
                    props: Record<string, unknown>
                    handler: (...args: unknown[]) => unknown
                    wasCalled: () => boolean
                } => item !== null
            )

        try {
            el.dispatchEvent(new MouseEvent('mousedown', opts))
            el.focus()
            el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }))
            const clickEvent = new MouseEvent('click', { ...opts, buttons: 0 })
            el.dispatchEvent(clickEvent)
            for (const item of reactHandlers) {
                if (!item.wasCalled()) {
                    item.handler.call(el, {
                        type: 'click',
                        target: el,
                        currentTarget: el,
                        nativeEvent: clickEvent,
                        clientX: cx,
                        clientY: cy,
                        button: 0,
                        buttons: 0,
                        preventDefault: () => clickEvent.preventDefault(),
                        stopPropagation: () => clickEvent.stopPropagation(),
                        isDefaultPrevented: () => clickEvent.defaultPrevented,
                        isPropagationStopped: () => false,
                    })
                }
            }
        } finally {
            for (const item of reactHandlers) {
                item.props.onClick = item.handler
            }
        }
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
    const el = ref?.deref() as HTMLInputElement | HTMLTextAreaElement | undefined
    if (!el) {
        return { success: false, error: `Element ${refId} not found` }
    }
    el.focus()
    const proto = Object.getPrototypeOf(el)
    const setter =
        Object.getOwnPropertyDescriptor(proto, 'value') ??
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ??
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
    if (setter?.set) {
        setter.set.call(el, val)
    } else {
        el.value = val
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { success: true }
}

// ==================== computed style 提取（MAIN 世界，与 refId 创建侧一致以共享 __mcpElementMap）====================

/**
 * 获取元素的 computed style
 * prop = '*' 返回全部属性 JSON；否则返回指定属性值
 */
export function getComputedStyleFromElement(refId: string, prop: string): string | null {
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
