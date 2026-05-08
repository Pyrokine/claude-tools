// ==================== 注入到页面的函数 ====================

// Accessibility Tree 生成
export function generateAccessibilityTree(
    filter: string,
    maxDepth: number,
    maxLength: number | null,
    refId: string | null
): { pageContent: string; viewport: { width: number; height: number }; error?: string } {
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
    try {
        // 使用 Function 构造函数替代 eval，更容易处理返回值
        const fn = new Function(`return (${code})`)
        const result = fn()
        return { success: true, result: JSON.stringify(result) }
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error'
        // 检测 CSP 相关错误
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
                throw new Error(`Invalid CSS selector: "${selector}" (${err.message})`)
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
                throw new Error(`Invalid CSS selector: "${selector}" (${err.message})`)
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
    rect?: { x: number; y: number; width: number; height: number }
}

/**
 * 检查元素可操作性（注入到页面执行）
 *
 * 检查顺序（参考 Playwright injectedScript.ts:640-657）：
 * 1. Connected — 元素仍在 DOM 中
 * 2. Visible — 非零尺寸 + visibility !== hidden + opacity > 0（含父链）
 * 3. Enabled — 无 disabled + 无 aria-disabled
 * 4. Pointer-events — 非 pointer-events:none
 * 5. In viewport — getBoundingClientRect 在视口范围内（自动滚动后重检）
 * 6. Not covered — elementFromPoint(center) === 目标元素或其后代
 */
export function checkActionability(refId: string): ActionabilityResult {
    const win = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
    const ref = win.__mcpElementMap?.[refId]
    if (!ref) {
        return { actionable: false, reason: 'not-connected' }
    }
    const element = ref.deref()
    if (!element || !element.isConnected) {
        return { actionable: false, reason: 'not-connected' }
    }

    // 1. Visible check（参考 Playwright domUtils.ts:87-134）
    const style = window.getComputedStyle(element)

    // display:none（自身或父链）
    // checkVisibility() 检查 content-visibility 和 display:none 整条链
    if (typeof element.checkVisibility === 'function') {
        if (!element.checkVisibility()) {
            return { actionable: false, reason: 'not-visible' }
        }
    }

    // visibility:hidden
    if (style.visibility !== 'visible') {
        return { actionable: false, reason: 'not-visible' }
    }

    // 注：opacity:0 不视为 not-visible（与 Playwright actionability 一致）
    // 元素仍接收事件，hit-test 能定位；如确实需要点击 opacity:0 元素，由 hit-test 决定

    // 非零尺寸（display:contents 例外，递归检查子元素）
    // 仅在 width 与 height 同时为 0 时判定不可见——单维度 0（如 inline 元素的高度）仍可能可点击；
    // 含 svg/canvas/img/video 等视觉子元素的零尺寸壳也保留为可见，由后续 hit-test 决定
    const rect = element.getBoundingClientRect()
    if (style.display !== 'contents' && rect.width === 0 && rect.height === 0) {
        const hasVisualChild = element.querySelector('svg, canvas, img, video') !== null
        if (!hasVisualChild) {
            return { actionable: false, reason: 'not-visible' }
        }
    }

    // 2. Enabled check（参考 Playwright roleUtils.ts + Selenium dom.js:84）
    const htmlEl = element as HTMLElement
    if ('disabled' in htmlEl && (htmlEl as HTMLButtonElement).disabled) {
        return { actionable: false, reason: 'not-enabled' }
    }
    // aria-disabled（包括祖先链）
    let ancestor: Element | null = element
    while (ancestor) {
        if (ancestor.getAttribute('aria-disabled') === 'true') {
            return { actionable: false, reason: 'not-enabled' }
        }
        ancestor = ancestor.parentElement
    }

    // 3. Pointer-events check（参考 Selenium atoms/dom.js）
    if (style.pointerEvents === 'none') {
        return { actionable: false, reason: 'pointer-events-none' }
    }

    // 4. In viewport check
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) {
        return {
            actionable: false,
            reason: 'not-in-viewport',
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        }
    }

    // 5. Covered check（参考 Playwright injectedScript.ts:955-1034）
    const cx = rect.x + rect.width / 2
    const cy = rect.y + rect.height / 2
    const hitEl = document.elementFromPoint(cx, cy)
    if (hitEl) {
        // 检查 hitEl 是否是目标元素或其后代
        if (hitEl !== element && !element.contains(hitEl)) {
            // hitEl 不在目标元素子树中——被遮挡
            // 再检查 hitEl 是否是目标元素的祖先（某些透明容器场景）
            if (!hitEl.contains(element)) {
                const tag = hitEl.tagName.toLowerCase()
                const cls = hitEl.className ? `.${String(hitEl.className).split(/\s+/).slice(0, 2).join('.')}` : ''
                const id = hitEl.id ? `#${hitEl.id}` : ''
                const desc = `<${tag}${id}${cls}>`
                return {
                    actionable: false,
                    reason: 'covered',
                    coveringElement: desc,
                    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                }
            }
        }
    }

    return {
        actionable: true,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    }
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
): {
    success: boolean
    error?: string
    reason?: string
    coveringElement?: string
} {
    type ActionabilityResult = {
        actionable: boolean
        reason?: string
        coveringElement?: string
        rect?: { x: number; y: number; width: number; height: number }
    }

    // 内联 checkActionability（chrome.scripting.executeScript 只序列化函数体，外部引用在页面上下文不可用）
    function checkActionabilityInline(id: string): ActionabilityResult {
        const w = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
        const r = w.__mcpElementMap?.[id]
        if (!r) {
            return { actionable: false, reason: 'not-connected' }
        }
        const el = r.deref()
        if (!el || !el.isConnected) {
            return { actionable: false, reason: 'not-connected' }
        }
        const style = window.getComputedStyle(el)
        if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) {
            return { actionable: false, reason: 'not-visible' }
        }
        if (style.visibility !== 'visible') {
            return { actionable: false, reason: 'not-visible' }
        }
        // 注：opacity:0 不视为 not-visible（与 Playwright actionability 一致）
        const rect = el.getBoundingClientRect()
        if (style.display !== 'contents' && rect.width === 0 && rect.height === 0) {
            const hasVisualChild = el.querySelector('svg, canvas, img, video') !== null
            if (!hasVisualChild) {
                return { actionable: false, reason: 'not-visible' }
            }
        }
        const htmlEl = el as HTMLElement
        if ('disabled' in htmlEl && (htmlEl as HTMLButtonElement).disabled) {
            return { actionable: false, reason: 'not-enabled' }
        }
        let ancestor: Element | null = el
        while (ancestor) {
            if (ancestor.getAttribute('aria-disabled') === 'true') {
                return { actionable: false, reason: 'not-enabled' }
            }
            ancestor = ancestor.parentElement
        }
        if (style.pointerEvents === 'none') {
            return { actionable: false, reason: 'pointer-events-none' }
        }
        const vw = window.innerWidth
        const vh = window.innerHeight
        if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) {
            return {
                actionable: false,
                reason: 'not-in-viewport',
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            }
        }
        const cx = rect.x + rect.width / 2
        const cy = rect.y + rect.height / 2
        const hitEl = document.elementFromPoint(cx, cy)
        if (hitEl && hitEl !== el && !el.contains(hitEl) && !hitEl.contains(el)) {
            const tag = hitEl.tagName.toLowerCase()
            const cls = hitEl.className ? `.${String(hitEl.className).split(/\s+/).slice(0, 2).join('.')}` : ''
            const elId = hitEl.id ? `#${hitEl.id}` : ''
            return {
                actionable: false,
                reason: 'covered',
                coveringElement: `<${tag}${elId}${cls}>`,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            }
        }
        return { actionable: true, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
    }

    // 内联 scrollIntoViewWithRetry
    function scrollIntoViewWithRetryInline(id: string): ActionabilityResult {
        const w = window as Window & { __mcpElementMap?: Record<string, WeakRef<Element>> }
        const r = w.__mcpElementMap?.[id]
        if (!r) {
            return { actionable: false, reason: 'not-connected' }
        }
        const el = r.deref()
        if (!el || !el.isConnected) {
            return { actionable: false, reason: 'not-connected' }
        }
        const alignments: ScrollIntoViewOptions[] = [
            { block: 'center', inline: 'center', behavior: 'instant' },
            { block: 'end', inline: 'end', behavior: 'instant' },
            { block: 'start', inline: 'start', behavior: 'instant' },
            { block: 'nearest', inline: 'nearest', behavior: 'instant' },
        ]
        for (const alignment of alignments) {
            el.scrollIntoView(alignment)
            const rect = el.getBoundingClientRect()
            const vw = window.innerWidth
            const vh = window.innerHeight
            if (rect.top >= 0 && rect.bottom <= vh && rect.left >= 0 && rect.right <= vw) {
                const cx = rect.x + rect.width / 2
                const cy = rect.y + rect.height / 2
                const hitEl = document.elementFromPoint(cx, cy)
                if (hitEl && (hitEl === el || el.contains(hitEl))) {
                    return { actionable: true, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
                }
            }
        }
        return checkActionabilityInline(id)
    }

    // 派发完整鼠标事件序列（HTMLElement.click() 不触发 React onClick 等受控组件）
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
        el.dispatchEvent(new MouseEvent('mousedown', opts))
        el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }))
        el.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }))
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
    let result = checkActionabilityInline(refId)

    // 不在视口 → 自动滚动
    if (!result.actionable && result.reason === 'not-in-viewport') {
        result = scrollIntoViewWithRetryInline(refId)
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
