export interface SemanticTarget {
    role?: string
    name?: string
    label?: string
    exact?: boolean
}

export interface DomQuery {
    selector?: string | null
    text?: string | null
    xpath?: string | null
    semantic?: SemanticTarget | null
    exact?: boolean
}

export interface DomHelpers {
    accessibleName(element: Element, includeHidden?: boolean): string
    role(element: Element): string
    query(query: DomQuery, root?: Document | ShadowRoot | Element): Element[]
    elements(root?: Document | ShadowRoot | Element): Element[]
    deepElementFromPoint(x: number, y: number): Element | null
    containsComposed(ancestor: Element, node: Element | null): boolean
    activeElement(): Element | null
    click(element: HTMLElement, modifiers?: MouseEventInit, event?: MouseEventInit): void
}

declare global {
    // globalThis 的类型扩展使用环境 var 声明
    // noinspection ES6ConvertVarToLetConst
    var __mcpDomHelpers: DomHelpers | undefined
}

// 由 Extension scripting 和 CDP 序列化执行，所有浏览器依赖保留在函数内
export function installDomHelpers(): void {
    const normalize = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim()
    const hidden = (element: Element): boolean => {
        const style = window.getComputedStyle(element)
        return (
            element.hasAttribute('hidden') ||
            element.getAttribute('aria-hidden') === 'true' ||
            style.display === 'none' ||
            style.visibility === 'hidden'
        )
    }
    const elementChildren = (node: Node): Node[] => {
        const element = node.nodeType === 1 ? (node as Element) : null
        const shadow = element?.shadowRoot
        return [...(shadow ? Array.from(shadow.childNodes) : []), ...Array.from(node.childNodes)]
    }
    const elements = (root: Document | ShadowRoot | Element = document): Element[] => {
        const pending = elementChildren(root).reverse()
        const result: Element[] = []
        const seen = new Set<Node>()
        while (pending.length) {
            const node = pending.pop()!
            if (seen.has(node)) {
                continue
            }
            seen.add(node)
            if (node.nodeType === 1) {
                result.push(node as Element)
            }
            const children = elementChildren(node)
            for (let index = children.length - 1; index >= 0; --index) {
                pending.push(children[index])
            }
        }
        return result
    }
    const role = (element: Element): string => {
        const explicit = normalize(element.getAttribute('role')).split(' ')[0]
        if (explicit) {
            return explicit.toLowerCase()
        }
        const tag = element.tagName.toLowerCase()
        if (tag === 'input') {
            const type = (element as HTMLInputElement).type
            if (['button', 'submit', 'reset', 'file', 'image'].includes(type)) {
                return 'button'
            }
            if (type === 'checkbox' || type === 'radio') {
                return type
            }
            return element.hasAttribute('list') ? 'combobox' : type === 'search' ? 'searchbox' : 'textbox'
        }
        if (tag === 'select') {
            const select = element as HTMLSelectElement
            return select.multiple || select.size > 1 ? 'listbox' : 'combobox'
        }
        if (/^h[1-6]$/.test(tag)) {
            return 'heading'
        }
        const roles: Record<string, string> = {
            button: 'button',
            summary: 'button',
            a: 'link',
            area: 'link',
            textarea: 'textbox',
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
            menu: 'list',
            li: 'listitem',
            option: 'option',
            progress: 'progressbar',
        }
        return roles[tag] ?? 'generic'
    }
    const textAlternative = (
        element: Element,
        referenced: boolean,
        seen: Set<Element>,
        contentContext = false,
        includeHiddenRoot = false
    ): string => {
        if (seen.has(element) || (!referenced && !includeHiddenRoot && hidden(element))) {
            return ''
        }
        seen.add(element)
        const root = element.getRootNode() as Document | ShadowRoot
        const labelledBy = normalize(element.getAttribute('aria-labelledby'))
        if (labelledBy) {
            const references = labelledBy
                .split(' ')
                .map((id) => root.getElementById(id))
                .filter((node) => node !== null)
            if (references.length) {
                return normalize(references.map((node) => textAlternative(node, true, new Set(seen))).join(' '))
            }
        }
        const ariaLabel = normalize(element.getAttribute('aria-label'))
        if (ariaLabel) {
            return ariaLabel
        }
        const labels = (element as HTMLInputElement).labels
        if (labels?.length) {
            return normalize(Array.from(labels, (label) => textAlternative(label, true, new Set(seen))).join(' '))
        }
        const tag = element.tagName.toLowerCase()
        if (tag === 'img' || (tag === 'input' && (element as HTMLInputElement).type === 'image')) {
            const alt = normalize(element.getAttribute('alt'))
            if (alt) {
                return alt
            }
        }
        if (tag === 'input') {
            const input = element as HTMLInputElement
            if (['button', 'submit', 'reset'].includes(input.type)) {
                return (
                    normalize(input.value) ||
                    (input.type === 'submit' ? 'Submit' : input.type === 'reset' ? 'Reset' : '')
                )
            }
        }
        const contentAllowed =
            referenced ||
            contentContext ||
            [
                'button',
                'cell',
                'checkbox',
                'columnheader',
                'gridcell',
                'heading',
                'link',
                'menuitem',
                'menuitemcheckbox',
                'menuitemradio',
                'option',
                'radio',
                'row',
                'rowheader',
                'switch',
                'tab',
                'tooltip',
                'treeitem',
            ].includes(role(element)) ||
            ['label', 'legend', 'caption', 'summary'].includes(tag)
        let children = contentAllowed
            ? elementChildren(element)
            : Array.from(element.childNodes).filter((node) => node.nodeType === 3)
        if (tag === 'slot') {
            const assigned = (element as HTMLSlotElement).assignedNodes({ flatten: true })
            if (assigned.length) {
                children = assigned
            }
        }
        const parts: string[] = []
        const pending = [...children].reverse()
        const visited = new Set<Node>()
        while (pending.length) {
            const child = pending.pop()!
            if (visited.has(child)) {
                continue
            }
            visited.add(child)
            if (child.nodeType === 3) {
                parts.push(child.textContent ?? '')
                continue
            }
            if (child.nodeType !== 1) {
                continue
            }
            const childElement = child as Element
            const childTag = childElement.tagName.toLowerCase()
            if (
                ['script', 'style', 'template', 'noscript', 'input', 'textarea', 'select'].includes(childTag) ||
                (!referenced && hidden(childElement))
            ) {
                continue
            }
            if (
                ['aria-labelledby', 'aria-label', 'title', 'placeholder', 'alt'].some((attribute) =>
                    childElement.hasAttribute(attribute)
                ) ||
                (childElement as HTMLInputElement).labels?.length
            ) {
                parts.push(textAlternative(childElement, referenced, new Set(seen), contentAllowed))
                continue
            }
            const assigned =
                childTag === 'slot' ? (childElement as HTMLSlotElement).assignedNodes({ flatten: true }) : []
            const descendants = assigned.length ? assigned : elementChildren(childElement)
            for (let index = descendants.length - 1; index >= 0; --index) {
                pending.push(descendants[index]!)
            }
        }
        const content = normalize(parts.join(''))
        return content || normalize(element.getAttribute('title')) || normalize(element.getAttribute('placeholder'))
    }
    const accessibleName = (element: Element, includeHidden = false): string =>
        textAlternative(element, false, new Set(), false, includeHidden)
    const query = (options: DomQuery, root: Document | ShadowRoot | Element = document): Element[] => {
        if (options.xpath) {
            const owner = root.nodeType === 9 ? (root as Document) : root.ownerDocument!
            const result = owner.evaluate(options.xpath, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
            const matches: Element[] = []
            for (let index = 0; index < result.snapshotLength; ++index) {
                const node = result.snapshotItem(index)
                if (node?.nodeType === 1) {
                    matches.push(node as Element)
                }
            }
            return matches
        }
        if (options.selector) {
            root.querySelector(options.selector)
        }
        const matchesText = (actual: string, expected: string, exact: boolean): boolean =>
            exact ? normalize(actual) === normalize(expected) : normalize(actual).includes(normalize(expected))
        const semantic = options.semantic
        const candidates = elements(root).filter((element) => {
            if (options.selector && !element.matches(options.selector)) {
                return false
            }
            if (semantic?.role) {
                const expected = semantic.role.toLowerCase() === 'img' ? 'image' : semantic.role.toLowerCase()
                const actual = role(element)
                if ((actual === 'img' ? 'image' : actual) !== expected) {
                    return false
                }
            }
            const expectedName = semantic?.name ?? semantic?.label
            if (expectedName !== undefined) {
                const name = semantic?.label ? textAlternative(element, true, new Set()) : accessibleName(element)
                if (!matchesText(name, expectedName, semantic?.exact ?? false)) {
                    return false
                }
            }
            if (
                semantic?.label &&
                !element.hasAttribute('aria-label') &&
                !element.hasAttribute('aria-labelledby') &&
                !['input', 'select', 'textarea', 'button', 'meter', 'output', 'progress'].includes(
                    element.tagName.toLowerCase()
                )
            ) {
                return false
            }
            return (
                options.text == null ||
                matchesText(element.textContent ?? '', options.text, options.exact ?? semantic?.exact ?? false)
            )
        })
        if (
            options.text != null &&
            !options.selector &&
            !semantic?.role &&
            semantic?.name === undefined &&
            semantic?.label === undefined
        ) {
            const parents = new Set<Element>()
            for (const element of candidates) {
                let parent = element.parentElement ?? (element.getRootNode() as ShadowRoot).host
                while (parent && parent !== root && !parents.has(parent)) {
                    parents.add(parent)
                    parent = parent.parentElement ?? (parent.getRootNode() as ShadowRoot).host
                }
            }
            return candidates.filter((element) => !parents.has(element))
        }
        return candidates
    }
    const deepElementFromPoint = (x: number, y: number): Element | null => {
        let element = document.elementFromPoint(x, y)
        const seen = new Set<Element>()
        while (element?.shadowRoot && !seen.has(element)) {
            seen.add(element)
            const child = element.shadowRoot.elementFromPoint(x, y)
            if (!child || child === element) {
                break
            }
            element = child
        }
        return element
    }
    const containsComposed = (ancestor: Element, node: Element | null): boolean => {
        let current: Node | null = node
        while (current) {
            if (current === ancestor) {
                return true
            }
            current = (current as Element).assignedSlot ?? current.parentNode ?? (current as ShadowRoot).host ?? null
        }
        return false
    }
    const activeElement = (): Element | null => {
        let active = document.activeElement
        while (active?.shadowRoot?.activeElement) {
            active = active.shadowRoot.activeElement
        }
        return active
    }
    globalThis.__mcpDomHelpers = {
        accessibleName,
        role,
        query,
        elements,
        deepElementFromPoint,
        containsComposed,
        activeElement,
        click(element, modifiers, event) {
            const modified =
                modifiers && [modifiers.altKey, modifiers.ctrlKey, modifiers.metaKey, modifiers.shiftKey].some(Boolean)
            if (!event && !modified) {
                element.click()
                return
            }
            if (!event && element.matches(':disabled')) {
                return
            }
            element.dispatchEvent(
                new MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    view: window,
                    ...event,
                    ...modifiers,
                })
            )
        },
    }
}
