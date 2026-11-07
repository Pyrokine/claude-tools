import { installDomHelpers } from '../../../src/core/dom-helpers.js'
import { ExpectedOperationError } from '../types/expected-errors'
import { InputKeySchema, InputMouseSchema, InputTouchSchema, InputTypeSchema } from '../types/schemas'
import {
    type ActionContext,
    assertActionActive,
    assertManagedTab,
    getTargetTabId,
    getFrameWheelZoom,
    resolveCdpFramePath,
} from './action-utils'
import { DebuggerManager } from './debugger-manager'
import { remainingNavigationTimeout } from './navigation-handler'

export class InputEventHandler {
    /** 按 tabId 维护当前按下的鼠标按键 mask（W3C MouseEvent.buttons），
     *  用于在 mouseMoved 事件中正确报告"按住按键移动"的状态，
     *  让 sortablejs/react-dnd HTML5-fallback 等基于 event.buttons 检测拖拽的库正常工作 */
    private buttonsState = new Map<number, number>()
    private touchTargets = new Map<number, { frameId: number; documentId?: string }>()

    constructor(private debuggerManager: DebuggerManager) {}

    /** 清理 tab 关闭后的鼠标状态，防止内存泄漏 */
    cleanupTab(tabId: number): void {
        this.buttonsState.delete(tabId)
        this.touchTargets.delete(tabId)
    }

    async inputKey(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = InputKeySchema.parse(params)

        const tabId = await this.getManagedTabId(p.tabId, context, 'input_key')
        await this.debuggerManager.ensureAttached(tabId)

        if (p.deadline !== undefined) {
            remainingNavigationTimeout(p.deadline)
        }

        const cdpParams: Record<string, unknown> = {
            type: p.type,
        }

        if (p.key) {
            cdpParams.key = p.key
        }
        if (p.code) {
            cdpParams.code = p.code
        }
        if (p.text) {
            cdpParams.text = p.text
        }
        if (p.unmodifiedText) {
            cdpParams.unmodifiedText = p.unmodifiedText
        }
        if (p.location !== undefined) {
            cdpParams.location = p.location
        }
        if (p.isKeypad) {
            cdpParams.isKeypad = p.isKeypad
        }
        if (p.autoRepeat) {
            cdpParams.autoRepeat = p.autoRepeat
        }
        if (p.windowsVirtualKeyCode !== undefined) {
            cdpParams.windowsVirtualKeyCode = p.windowsVirtualKeyCode
        }
        if (p.nativeVirtualKeyCode !== undefined) {
            cdpParams.nativeVirtualKeyCode = p.nativeVirtualKeyCode
        }
        if (p.modifiers !== undefined) {
            cdpParams.modifiers = p.modifiers
        }
        if (p.commands && p.commands.length > 0) {
            cdpParams.commands = p.commands
        }

        if (p.keyboardFocusId) {
            await this.debuggerManager.assertKeyboardFocus(tabId, p.keyboardFocusId, context)
        }
        assertActionActive(context)
        if (p.keyboardFocusId) {
            this.debuggerManager.trackKeyboardInput(tabId, p.keyboardFocusId, cdpParams)
        }
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', cdpParams)
        if (p.keyboardFocusId) {
            this.debuggerManager.trackKeyboardInput(tabId, p.keyboardFocusId, cdpParams, true)
        }
        return { success: true }
    }

    async inputMouse(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = InputMouseSchema.parse(params)

        const tabId = await getTargetTabId(p.tabId)
        const tab = await assertManagedTab(tabId, context, 'input_mouse')
        if (p.deadline !== undefined) {
            remainingNavigationTimeout(p.deadline)
        }
        if (!tab.active && (p.type === 'mouseMoved' || p.type === 'mousePressed')) {
            throw new ExpectedOperationError(
                JSON.stringify({
                    error: {
                        code: 'NATIVE_INPUT_UNAVAILABLE',
                        message: '后台标签页未提供原生鼠标输入，未派发动作',
                        suggestion: '后台元素单击使用带提示的合成输入；坐标或其他鼠标动作可显式使用 stealth',
                        context: { actionExecuted: false, actionStatus: 'not_started', retryable: false },
                    },
                }),
                false
            )
        }

        // mouseWheel: chrome.debugger sendCommand for Input.dispatchMouseEvent(mouseWheel) never resolves
        // in Extension mode — dispatch WheelEvent via scripting.executeScript instead
        if (p.type === 'mouseWheel') {
            const frameId = p.frameId ?? 0
            let documentId = p.documentId
            const wheelError = (error: unknown, dispatched = false) => {
                const message = error instanceof Error ? error.message : String(error)
                const notStarted =
                    !dispatched ||
                    (documentId !== undefined &&
                        message === `No document with id ${documentId} in tab with id ${tabId}`)
                return new ExpectedOperationError(
                    JSON.stringify({
                        error: {
                            code: 'WHEEL_INPUT_FAILED',
                            message,
                            context: {
                                tabId,
                                frameId,
                                documentId,
                                actionExecuted: notStarted ? false : 'unknown',
                                actionStatus: notStarted ? 'not_started' : 'unknown',
                                retryable: false,
                            },
                        },
                    }),
                    notStarted ? false : undefined
                )
            }
            const frame = await chrome.webNavigation.getFrame({ tabId, frameId }).catch((error: unknown) => {
                throw wheelError(error)
            })
            if (!frame || (documentId && frame.documentId !== documentId)) {
                throw wheelError('Wheel frame document changed before dispatch')
            }
            documentId ??= frame.documentId
            const frameZoom =
                frame.parentFrameId >= 0
                    ? await getFrameWheelZoom(tabId, frameId, documentId, context).catch((error: unknown) => {
                          throw wheelError(error)
                      })
                    : 1
            const target = documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [frameId] }
            assertActionActive(context)
            const setup = await chrome.scripting
                .executeScript({ target, world: 'MAIN', func: installDomHelpers })
                .catch((error: unknown) => {
                    throw wheelError(error)
                })
            if (!setup[0] || (setup[0] as { error?: unknown }).error) {
                throw wheelError('DOM helper installation failed before wheel input')
            }
            assertActionActive(context)
            if (p.deadline !== undefined) {
                remainingNavigationTimeout(p.deadline)
            }
            const results = await chrome.scripting
                .executeScript({
                    target,
                    world: 'MAIN',
                    func: (
                        x: number,
                        y: number,
                        deltaX: number,
                        deltaY: number,
                        modifiers: MouseEventInit,
                        frameZoom: number
                    ) => {
                        const el = globalThis.__mcpDomHelpers!.deepElementFromPoint(x, y)
                        const target = el ?? document.documentElement
                        const root = document.documentElement
                        const body = document.body
                        const rootStyle = window.getComputedStyle(root)
                        const bodyStyle = body ? window.getComputedStyle(body) : null
                        const parentOf = (node: Element): Element | null =>
                            node.assignedSlot ?? node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null
                        const hasBox = (node: Element, style: CSSStyleDeclaration): boolean =>
                            style.display !== 'none' && style.display !== 'contents' && node.getClientRects().length > 0
                        const displayTypes = (
                            style: CSSStyleDeclaration
                        ): { outside: string; inside: string; nonAtomicInline: boolean } => {
                            const value =
                                (
                                    {
                                        'inline-block': 'inline flow-root',
                                        'inline-flex': 'inline flex',
                                        'inline-grid': 'inline grid',
                                        'inline-table': 'inline table',
                                        '-webkit-box': 'block -webkit-box',
                                        '-webkit-inline-box': 'inline -webkit-box',
                                    } as Record<string, string>
                                )[style.display] ?? style.display
                            const keywords = value.split(/\s+/)
                            const outside =
                                keywords.includes('inline') ||
                                (keywords.includes('ruby') && !keywords.includes('block'))
                                    ? 'inline'
                                    : 'block'
                            const inside =
                                keywords.find(
                                    (keyword) => !['block', 'inline', 'run-in', 'list-item'].includes(keyword)
                                ) ?? 'flow'
                            return {
                                outside,
                                inside,
                                nonAtomicInline: outside === 'inline' && ['flow', 'ruby'].includes(inside),
                            }
                        }
                        const allowsLayoutContainment = (style: CSSStyleDeclaration): boolean => {
                            const { inside, nonAtomicInline } = displayTypes(style)
                            return (
                                !nonAtomicInline &&
                                (!inside.startsWith('table-') || ['table-cell', 'table-caption'].includes(inside)) &&
                                !inside.startsWith('ruby-')
                            )
                        }
                        const hasContainment = (node: Element, style: CSSStyleDeclaration): boolean => {
                            const contain = style.contain.split(' ')
                            return (
                                contain.some((value) => ['style', 'content', 'strict'].includes(value)) ||
                                (hasBox(node, style) &&
                                    allowsLayoutContainment(style) &&
                                    (contain.some((value) =>
                                        ['size', 'inline-size', 'layout', 'paint'].includes(value)
                                    ) ||
                                        ['auto', 'hidden'].includes(style.contentVisibility))) ||
                                style.containerType.split(' ').some((value) => ['size', 'inline-size'].includes(value))
                            )
                        }
                        const isContainingBlock = (node: Element, fixed: boolean): boolean => {
                            const style = window.getComputedStyle(node)
                            if (!hasBox(node, style)) {
                                return false
                            }
                            if (!fixed && style.position !== 'static') {
                                return true
                            }
                            const display = displayTypes(style)
                            const willChange = style.willChange.split(',').map((value) => {
                                const name = value.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase())
                                return [
                                    '-webkit-transform',
                                    '-webkit-filter',
                                    '-webkit-perspective',
                                    '-webkit-transform-style',
                                ].includes(name)
                                    ? name.slice(8)
                                    : name
                            })
                            const filtered = [style.filter, style.backdropFilter].some(
                                (value) => value && value !== 'none'
                            )
                            return (
                                (node.namespaceURI === 'http://www.w3.org/2000/svg' &&
                                    node.localName === 'foreignObject') ||
                                filtered ||
                                willChange.some((value) => ['filter', 'backdrop-filter'].includes(value)) ||
                                (!display.nonAtomicInline &&
                                    !['table-column', 'table-column-group'].includes(display.inside) &&
                                    !display.inside.startsWith('ruby-') &&
                                    ([
                                        style.transform,
                                        style.translate,
                                        style.rotate,
                                        style.scale,
                                        style.perspective,
                                        style.offsetPath,
                                    ].some((value) => value && value !== 'none') ||
                                        style.transformStyle === 'preserve-3d' ||
                                        (Boolean(style.offsetPosition) &&
                                            !['auto', 'normal'].includes(style.offsetPosition)) ||
                                        willChange.some((value) =>
                                            [
                                                'transform',
                                                'translate',
                                                'rotate',
                                                'scale',
                                                'perspective',
                                                'transform-style',
                                                'offset-path',
                                                'offset-position',
                                            ].includes(value)
                                        ))) ||
                                (allowsLayoutContainment(style) &&
                                    (style.contain
                                        .split(' ')
                                        .some((value) => ['layout', 'paint', 'content', 'strict'].includes(value)) ||
                                        ['auto', 'hidden'].includes(style.contentVisibility) ||
                                        willChange.includes('contain')))
                            )
                        }
                        const scrollParent = (node: Element, style: CSSStyleDeclaration): Element | null => {
                            if (style.position !== 'absolute' && style.position !== 'fixed') {
                                return parentOf(node)
                            }
                            const fixed = style.position === 'fixed'
                            for (let parent = parentOf(node); parent && parent !== root; parent = parentOf(parent)) {
                                if (isContainingBlock(parent, fixed)) {
                                    return parent
                                }
                            }
                            return root
                        }
                        // HTML 的 overflow 传播源自身不再作为独立滚动容器
                        const bodyPropagates =
                            root.localName === 'html' &&
                            root.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
                            rootStyle.overflowX === 'visible' &&
                            rootStyle.overflowY === 'visible' &&
                            body?.localName === 'body' &&
                            body.parentElement === root &&
                            bodyStyle !== null &&
                            hasBox(body, bodyStyle) &&
                            !hasContainment(root, rootStyle) &&
                            !hasContainment(body, bodyStyle!)
                        const viewportStyle = bodyPropagates ? bodyStyle! : rootStyle
                        const chain: Element[] = []
                        let candidate: Element | null = target
                        while (candidate && candidate !== root) {
                            chain.push(candidate)
                            candidate = scrollParent(candidate, window.getComputedStyle(candidate))
                        }
                        const includesViewport = candidate === root
                        const page = window as Window & {
                            ScrollTimeline?: new (options: { source: Element; axis: 'x' | 'y' }) => {
                                currentTime: { value: number } | null
                            }
                            __mcpWheelState?: {
                                frameZoom: number
                                remainders: WeakMap<
                                    Element,
                                    Partial<Record<'x' | 'y', { position: number; zoom: number; residual: number }>>
                                >
                            }
                        }
                        if (page.__mcpWheelState?.frameZoom !== frameZoom) {
                            page.__mcpWheelState = { frameZoom, remainders: new WeakMap() }
                        }
                        const state = page.__mcpWheelState!
                        const eventPositions = new Map(
                            chain.map((node) => [node, { x: node.scrollLeft, y: node.scrollTop }])
                        )
                        eventPositions.set(root, { x: window.scrollX, y: window.scrollY })
                        const scrollProgress = (source: Element, axis: 'x' | 'y'): number | null => {
                            const value = page.ScrollTimeline
                                ? new page.ScrollTimeline({ source, axis }).currentTime?.value
                                : undefined
                            return typeof value === 'number' && Number.isFinite(value) ? value : null
                        }
                        const scrollBeforeWheel = new Map(
                            [...chain, root].map((node) => {
                                const source = node === root ? (document.scrollingElement ?? root) : node
                                const client =
                                    node === root && document.compatMode === 'BackCompat' ? (body ?? root) : node
                                return [
                                    node,
                                    {
                                        x:
                                            deltaX !== 0
                                                ? {
                                                      progress: scrollProgress(source, 'x'),
                                                      range: source.scrollWidth - client.clientWidth,
                                                  }
                                                : undefined,
                                        y:
                                            deltaY !== 0
                                                ? {
                                                      progress: scrollProgress(source, 'y'),
                                                      range: source.scrollHeight - client.clientHeight,
                                                  }
                                                : undefined,
                                    },
                                ]
                            })
                        )
                        const uncancelled = target.dispatchEvent(
                            new WheelEvent('wheel', {
                                bubbles: true,
                                cancelable: true,
                                composed: true,
                                deltaX,
                                deltaY,
                                deltaMode: 0,
                                ...modifiers,
                                clientX: x,
                                clientY: y,
                            })
                        )
                        if (!uncancelled) {
                            return { success: true }
                        }
                        const input = target as HTMLInputElement
                        if (
                            target.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
                            target.localName === 'input' &&
                            input.type === 'number' &&
                            !input.disabled &&
                            !input.readOnly &&
                            globalThis.__mcpDomHelpers!.activeElement() === input
                        ) {
                            const before = input.value
                            if (deltaY !== 0) {
                                let reversedBounds = false
                                if (input.min && input.max) {
                                    const bounds = input.cloneNode() as HTMLInputElement
                                    bounds.value = input.min
                                    reversedBounds = bounds.validity.rangeOverflow
                                }
                                if (reversedBounds) {
                                    input.value = deltaY < 0 ? input.min : input.max
                                } else if (input.step.toLowerCase() === 'any') {
                                    // Chrome 的 wheel 对 any 使用步长 1，保持现有小数且遵守原生范围校验
                                    if (!(deltaY < 0 ? input.validity.rangeOverflow : input.validity.rangeUnderflow)) {
                                        input.valueAsNumber =
                                            (Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : 0) +
                                            (deltaY < 0 ? 1 : -1)
                                        if (input.validity.rangeUnderflow) {
                                            input.value = input.min
                                        }
                                        if (input.validity.rangeOverflow) {
                                            input.value = input.max
                                        }
                                    }
                                } else if (deltaY < 0) {
                                    input.stepUp()
                                } else {
                                    input.stepDown()
                                }
                                if (input.value !== before) {
                                    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
                                }
                            }
                            return { success: true }
                        }
                        const consume = (
                            node: Element,
                            x: number,
                            y: number,
                            style: CSSStyleDeclaration,
                            viewport = false
                        ): { x: boolean; y: boolean } => {
                            let zoom = 1
                            if (!viewport) {
                                const currentZoom = (node as Element & { currentCSSZoom?: number }).currentCSSZoom
                                if (currentZoom !== undefined) {
                                    zoom = currentZoom
                                } else {
                                    for (
                                        let ancestor: Element | null = node;
                                        ancestor;
                                        ancestor = ancestor === root ? null : parentOf(ancestor)
                                    ) {
                                        zoom *= Number.parseFloat(window.getComputedStyle(ancestor).zoom) || 1
                                    }
                                }
                            }
                            const axes = state.remainders.get(node) ?? {}
                            const pending = (['x', 'y'] as const)
                                .filter((axis) => (axis === 'x' ? x : y) !== 0)
                                .map((axis) => {
                                    const horizontal = axis === 'x'
                                    const delta = horizontal ? x : y
                                    const before = viewport
                                        ? horizontal
                                            ? window.scrollX
                                            : window.scrollY
                                        : horizontal
                                          ? node.scrollLeft
                                          : node.scrollTop
                                    const vertical = Boolean(
                                        style.writingMode && !style.writingMode.startsWith('horizontal')
                                    )
                                    let negative = horizontal
                                        ? vertical
                                            ? style.writingMode.endsWith('-rl')
                                            : style.direction === 'rtl'
                                        : vertical && style.direction === 'rtl'
                                    if (
                                        style.display.includes('flex') &&
                                        ((horizontal !== vertical && style.flexDirection === 'row-reverse') ||
                                            (horizontal === vertical && style.flexDirection === 'column-reverse'))
                                    ) {
                                        negative = !negative
                                    }
                                    const scrollingElement = viewport ? (document.scrollingElement ?? root) : node
                                    const client =
                                        viewport && document.compatMode === 'BackCompat' ? (body ?? root) : node
                                    const range = horizontal
                                        ? scrollingElement.scrollWidth - client.clientWidth
                                        : scrollingElement.scrollHeight - client.clientHeight
                                    const minimum = negative ? -range : 0
                                    const maximum = negative ? 0 : range
                                    const currentProgress = scrollProgress(scrollingElement, axis)
                                    const initial = scrollBeforeWheel.get(node)?.[axis]
                                    const progress = initial?.progress ?? null
                                    const initialPosition = eventPositions.get(node)?.[axis] ?? before
                                    const initialRange = initial?.range ?? range
                                    if (progress === null && range > 0) {
                                        console.warn('无法读取原生滚动进度，使用 CSSOM 尺寸范围判断滚动边界')
                                    }
                                    const towardStart = negative ? delta > 0 : delta < 0
                                    const canMove =
                                        (range > 0 || currentProgress !== null) &&
                                        (progress === null
                                            ? delta < 0
                                                ? initialPosition > (negative ? -initialRange : 0)
                                                : initialPosition < (negative ? 0 : initialRange)
                                            : towardStart
                                              ? progress > Number.EPSILON * 100
                                              : progress < 100 - Number.EPSILON * 100)
                                    const previous = axes[axis]
                                    const residual =
                                        previous !== undefined &&
                                        previous.position === eventPositions.get(node)?.[axis] &&
                                        previous.zoom === zoom &&
                                        canMove
                                            ? previous.residual
                                            : 0
                                    return {
                                        axis,
                                        before,
                                        minimum,
                                        maximum,
                                        scrollingElement,
                                        towardStart,
                                        canMove,
                                        delta,
                                        intended: delta / zoom + residual,
                                    }
                                })
                            const consumed = { x: false, y: false }
                            if (!pending.length) {
                                return consumed
                            }
                            const options = {
                                left: pending.find((value) => value.axis === 'x' && value.canMove)?.intended ?? 0,
                                top: pending.find((value) => value.axis === 'y' && value.canMove)?.intended ?? 0,
                                behavior: 'instant' as const,
                            }
                            if (viewport) {
                                window.scrollBy(options)
                            } else {
                                node.scrollBy(options)
                            }
                            for (const value of pending) {
                                const after = viewport
                                    ? value.axis === 'x'
                                        ? window.scrollX
                                        : window.scrollY
                                    : value.axis === 'x'
                                      ? node.scrollLeft
                                      : node.scrollTop
                                const progress = scrollProgress(value.scrollingElement, value.axis)
                                const atBoundary =
                                    progress === null
                                        ? value.delta < 0
                                            ? after <= value.minimum
                                            : after >= value.maximum
                                        : value.towardStart
                                          ? progress <= Number.EPSILON * 100
                                          : progress >= 100 - Number.EPSILON * 100
                                const quantization = value.intended - (after - value.before)
                                const snap = style.scrollSnapType && style.scrollSnapType !== 'none'
                                axes[value.axis] = {
                                    position: after,
                                    zoom,
                                    residual:
                                        !snap && !atBoundary && Math.abs(quantization) <= 1 / zoom + 1e-7
                                            ? quantization
                                            : 0,
                                }
                                consumed[value.axis] = after !== value.before || value.canMove
                            }
                            state.remainders.set(node, axes)
                            return consumed
                        }
                        let remainingX = deltaX
                        let remainingY = deltaY
                        for (const node of chain) {
                            if (remainingX === 0 && remainingY === 0) {
                                break
                            }
                            if (node.isConnected === false || (node.ownerDocument && node.ownerDocument !== document)) {
                                continue
                            }
                            const style = window.getComputedStyle(node)
                            const display = displayTypes(style)
                            const textInput =
                                node.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
                                node.localName === 'input' &&
                                ['text', 'search', 'url', 'tel', 'password', 'email'].includes(
                                    (node as HTMLInputElement).type
                                )
                            const scrollBox =
                                hasBox(node, style) &&
                                (textInput ||
                                    ((node.namespaceURI !== 'http://www.w3.org/2000/svg' ||
                                        node.localName === 'foreignObject') &&
                                        ((display.outside === 'block' && ['flow', 'ruby'].includes(display.inside)) ||
                                            [
                                                'math',
                                                'flow-root',
                                                'flex',
                                                'grid',
                                                '-webkit-box',
                                                'table-cell',
                                                'table-caption',
                                            ].includes(display.inside)) &&
                                        ![
                                            'img',
                                            'video',
                                            'audio',
                                            'canvas',
                                            'iframe',
                                            'embed',
                                            'object',
                                            'input',
                                        ].includes(node.localName)))
                            if (!scrollBox || (bodyPropagates && node === body)) {
                                continue
                            }
                            const containerX =
                                remainingX !== 0 &&
                                (textInput || ['auto', 'scroll', 'hidden'].includes(style.overflowX))
                            const containerY =
                                remainingY !== 0 && ['auto', 'scroll', 'hidden'].includes(style.overflowY)
                            const moved = consume(
                                node,
                                containerX && (textInput || style.overflowX !== 'hidden') ? remainingX : 0,
                                containerY && style.overflowY !== 'hidden' ? remainingY : 0,
                                style
                            )
                            if (containerX && (moved.x || ['contain', 'none'].includes(style.overscrollBehaviorX))) {
                                remainingX = 0
                            }
                            if (containerY && (moved.y || ['contain', 'none'].includes(style.overscrollBehaviorY))) {
                                remainingY = 0
                            }
                        }
                        if (includesViewport) {
                            consume(
                                root,
                                !['hidden', 'clip'].includes(viewportStyle.overflowX) ? remainingX : 0,
                                !['hidden', 'clip'].includes(viewportStyle.overflowY) ? remainingY : 0,
                                rootStyle,
                                true
                            )
                        }
                        return { success: true }
                    },
                    args: [
                        p.x,
                        p.y,
                        (p.deltaX ?? 0) / frameZoom,
                        (p.deltaY ?? 0) / frameZoom,
                        {
                            altKey: Boolean((p.modifiers ?? 0) & 1),
                            ctrlKey: Boolean((p.modifiers ?? 0) & 2),
                            metaKey: Boolean((p.modifiers ?? 0) & 4),
                            shiftKey: Boolean((p.modifiers ?? 0) & 8),
                        },
                        frameZoom,
                    ],
                })
                .catch((error: unknown) => {
                    throw wheelError(error, true)
                })
            const result = results[0]?.result as { success: boolean } | undefined
            if (!result?.success) {
                throw wheelError('Wheel input did not return a successful result', true)
            }
            return result
        }

        await this.debuggerManager.ensureAttached(tabId)
        let point = { x: p.x, y: p.y }
        if (p.coordinateSpace === 'frame') {
            try {
                point = await this.frameInputPoint(tabId, p.frameId ?? 0, point, p.documentId, context)
            } catch (error) {
                throw new ExpectedOperationError(
                    JSON.stringify({
                        error: {
                            code: 'FRAME_GEOMETRY_UNAVAILABLE',
                            message: error instanceof Error ? error.message : String(error),
                            context: {
                                tabId,
                                frameId: p.frameId ?? 0,
                                actionExecuted: false,
                                actionStatus: 'not_started',
                                retryable: false,
                            },
                        },
                    }),
                    false
                )
            }
        }

        const cdpParams: Record<string, unknown> = {
            type: p.type,
            ...point,
        }
        if (p.deadline !== undefined) {
            remainingNavigationTimeout(p.deadline)
        }

        if (p.button && p.button !== 'none') {
            cdpParams.button = p.button
        }
        if (p.clickCount !== undefined) {
            cdpParams.clickCount = p.clickCount
        }
        if (p.modifiers !== undefined) {
            cdpParams.modifiers = p.modifiers
        }

        // CDP 需要 buttons 位掩码（W3C MouseEvent.buttons）才能正确触发 DOM mousedown/mouseup listener
        // Input.dispatchMouseEvent 不带 buttons 时，Chrome 视作"无按键按下"，独立 mousedown 不派发 DOM 事件
        // Left=1 Right=2 Middle=4 Back=8 Forward=16
        const BUTTON_MASK: Record<string, number> = { left: 1, right: 2, middle: 4, back: 8, forward: 16 }
        const effectiveButton = p.button && p.button !== 'none' ? p.button : undefined

        let buttons = this.buttonsState.get(tabId) ?? 0
        if (p.type === 'mousePressed') {
            const bit = effectiveButton ? (BUTTON_MASK[effectiveButton] ?? 1) : 1
            buttons |= bit
            this.buttonsState.set(tabId, buttons)
            cdpParams.buttons = buttons
        } else if (p.type === 'mouseReleased') {
            const bit = effectiveButton ? (BUTTON_MASK[effectiveButton] ?? 0) : 0
            buttons &= ~bit
            if (buttons === 0) {
                this.buttonsState.delete(tabId)
            } else {
                this.buttonsState.set(tabId, buttons)
            }
            cdpParams.buttons = buttons
        } else if (p.type === 'mouseMoved') {
            // mouseMoved 时复用 buttonsState：拖拽期间 buttons 应反映当前持续按下的按键
            // 让基于 event.buttons 检测的 JS 拖拽库（sortablejs HTML5-fallback、react-dnd HTML5-fallback）正常工作
            cdpParams.buttons = buttons
        }

        assertActionActive(context)
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', cdpParams)

        return { success: true }
    }

    async inputTouch(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = InputTouchSchema.parse(params)

        const tabId = await this.getManagedTabId(p.tabId, context, 'input_touch')

        // CDP Input.dispatchTouchEvent 在 Extension chrome.debugger 模式下挂起（同 mouseWheel）
        // 改用 chrome.scripting.executeScript 注入 TouchEvent 合成派发
        const frameId = p.frameId ?? 0
        const frame = await chrome.webNavigation.getFrame({ tabId, frameId })
        const started = this.touchTargets.get(tabId)
        const documentId = p.type === 'touchStart' ? (p.documentId ?? frame?.documentId) : started?.documentId
        if (
            !frame ||
            (p.documentId && frame.documentId !== p.documentId) ||
            (p.type !== 'touchStart' && started && (started.frameId !== frameId || frame.documentId !== documentId))
        ) {
            throw new ExpectedOperationError('Touch frame document changed before dispatch', false)
        }
        const frameIds = [frameId]
        const target = documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds }
        assertActionActive(context)
        const setup = await chrome.scripting.executeScript({ target, world: 'MAIN', func: installDomHelpers })
        if (!setup[0] || (setup[0] as { error?: unknown }).error) {
            throw new ExpectedOperationError('DOM helper installation failed before touch input', false)
        }
        assertActionActive(context)
        const results = await chrome.scripting.executeScript({
            target,
            world: 'MAIN',
            func: (
                type: string,
                touchPoints: Array<{
                    x: number
                    y: number
                    id?: number
                    radiusX?: number
                    radiusY?: number
                    force?: number
                    rotationAngle?: number
                }>,
                modifiers: MouseEventInit
            ) => {
                const eventTypeMap: Record<string, string> = {
                    touchStart: 'touchstart',
                    touchEnd: 'touchend',
                    touchMove: 'touchmove',
                    touchCancel: 'touchcancel',
                }
                const eventType = eventTypeMap[type]
                if (!eventType) {
                    return { success: false, error: `Unknown touch event type: ${type}` }
                }

                const stateKey = '__mcpLastTouchState'
                const page = window as Window & {
                    __mcpLastTouchState?: {
                        target: EventTarget & { dispatchEvent: (evt: Event) => boolean }
                        touchPoints: Array<{
                            x: number
                            y: number
                            id?: number
                            radiusX?: number
                            radiusY?: number
                            force?: number
                            rotationAngle?: number
                        }>
                    }
                }
                const storedState = page.__mcpLastTouchState
                const isStarting = type === 'touchStart'
                const isEnding = type === 'touchEnd' || type === 'touchCancel'
                const effectivePoints = isStarting
                    ? touchPoints
                    : touchPoints.length > 0
                      ? touchPoints
                      : (storedState?.touchPoints ?? [])
                if (effectivePoints.length < 1) {
                    if (isEnding) {
                        delete page[stateKey]
                        return { success: true }
                    }
                    return {
                        success: false,
                        error: `${eventType} 需要先有 touchstart/touchmove，或显式提供 touchPoints`,
                    }
                }

                const firstPoint = effectivePoints[0]
                const target =
                    isStarting || !storedState?.target
                        ? ((globalThis.__mcpDomHelpers!.deepElementFromPoint(firstPoint.x, firstPoint.y) ??
                              document.documentElement) as EventTarget & { dispatchEvent: (evt: Event) => boolean })
                        : storedState.target

                const touches = effectivePoints.map(
                    (pt, i) =>
                        new Touch({
                            identifier: pt.id ?? i,
                            target,
                            clientX: pt.x,
                            clientY: pt.y,
                            screenX: pt.x,
                            screenY: pt.y,
                            radiusX: pt.radiusX ?? 0.5,
                            radiusY: pt.radiusY ?? 0.5,
                            rotationAngle: pt.rotationAngle ?? 0,
                            force: pt.force ?? 0.5,
                        })
                )

                const evt = new TouchEvent(eventType, {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    ...modifiers,
                    touches: isEnding ? [] : touches,
                    targetTouches: isEnding ? [] : touches,
                    changedTouches: touches,
                })
                target.dispatchEvent(evt)

                if (isEnding) {
                    delete page[stateKey]
                } else {
                    page[stateKey] = { target, touchPoints: effectivePoints }
                }
                return { success: true }
            },
            args: [
                p.type,
                p.touchPoints,
                {
                    altKey: Boolean((p.modifiers ?? 0) & 1),
                    ctrlKey: Boolean((p.modifiers ?? 0) & 2),
                    metaKey: Boolean((p.modifiers ?? 0) & 4),
                    shiftKey: Boolean((p.modifiers ?? 0) & 8),
                },
            ],
        })

        if (p.type === 'touchEnd' || p.type === 'touchCancel') {
            this.touchTargets.delete(tabId)
        } else {
            this.touchTargets.set(tabId, { frameId, documentId })
        }
        const result = results[0]?.result as { success: boolean; error?: string } | undefined
        if (result && !result.success && result.error) {
            throw new Error(result.error)
        }
        return { success: true }
    }

    async inputType(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = InputTypeSchema.parse(params)

        const tabId = await this.getManagedTabId(p.tabId, context, 'input_type')
        let dispatched = false
        let acknowledged = false
        const deadline = Math.min(p.deadline ?? Infinity, context.deadline ?? Infinity)
        const remainingTimeout = () => {
            const remaining = deadline - Date.now()
            if (context.signal?.aborted || remaining <= 0) {
                throw new ExpectedOperationError(
                    JSON.stringify({
                        error: {
                            code: context.signal?.aborted ? 'REQUEST_CANCELLED' : 'TIMEOUT',
                            message: context.signal?.aborted
                                ? 'Request cancelled during typing'
                                : 'Input timeout during typing',
                            context: {
                                actionExecuted: dispatched ? (acknowledged ? true : 'unknown') : false,
                                actionStatus: dispatched ? (acknowledged ? 'partial' : 'unknown') : 'not_started',
                                retryable: false,
                            },
                        },
                    }),
                    dispatched ? undefined : false
                )
            }
            return remaining
        }
        remainingTimeout()
        await this.debuggerManager.ensureAttached(tabId)

        const delay = p.delay ?? 0
        // 归一化换行：\r\n 和 \r 都视作单个 \n，避免 \r\n 触发两次 Enter
        const text = p.text.replace(/\r\n?/g, '\n')

        const assertFocus = async () => {
            if (!p.keyboardFocusId) {
                return
            }
            try {
                await this.debuggerManager.assertKeyboardFocus(tabId, p.keyboardFocusId, context)
            } catch (error) {
                if (dispatched && error instanceof ExpectedOperationError && error.actionExecuted === false) {
                    const payload = JSON.parse(error.message) as { error: { context: Record<string, unknown> } }
                    Object.assign(payload.error.context, {
                        actionExecuted: acknowledged ? true : 'unknown',
                        actionStatus: acknowledged ? 'partial' : 'unknown',
                    })
                    throw new ExpectedOperationError(JSON.stringify(payload))
                }
                throw error
            }
        }
        for (const char of text) {
            remainingTimeout()
            if (p.keyboardFocusId) {
                await assertFocus()
                remainingTimeout()
            }
            if (char === '\n') {
                // Enter: CDP 对 char='\n' 会丢弃，改为分发 Enter 键事件
                const enterParams = {
                    key: 'Enter',
                    code: 'Enter',
                    windowsVirtualKeyCode: 13,
                    nativeVirtualKeyCode: 13,
                }
                const down = { type: 'keyDown', ...enterParams }
                const up = { type: 'keyUp', ...enterParams }
                try {
                    if (p.keyboardFocusId) {
                        this.debuggerManager.trackKeyboardInput(tabId, p.keyboardFocusId, down)
                    }
                    dispatched = true
                    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', down)
                    acknowledged = true
                    remainingTimeout()
                    if (p.keyboardFocusId) {
                        await assertFocus()
                    }
                    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
                        type: 'char',
                        text: '\r',
                        ...enterParams,
                    })
                } finally {
                    if (!p.keyboardFocusId) {
                        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', up)
                    }
                }
                if (p.keyboardFocusId) {
                    await assertFocus()
                    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', up)
                    this.debuggerManager.trackKeyboardInput(tabId, p.keyboardFocusId, up, true)
                }
            } else {
                dispatched = true
                await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
                    type: 'char',
                    text: char,
                })
                acknowledged = true
            }

            if (delay > 0) {
                await new Promise((r) => setTimeout(r, Math.min(delay, remainingTimeout())))
            }
        }
        remainingTimeout()

        return { success: true }
    }

    private async frameInputPoint(
        tabId: number,
        frameId: number,
        point: { x: number; y: number },
        documentId: string | undefined,
        context: ActionContext
    ): Promise<{ x: number; y: number }> {
        const frames = await chrome.webNavigation.getAllFrames({ tabId })
        const selected = frames?.find((frame) => frame.frameId === frameId)
        if (!selected?.documentId || (documentId && selected.documentId !== documentId)) {
            throw new Error('Input frame document changed before geometry lookup')
        }
        if (frameId === 0) {
            return point
        }
        const path = await resolveCdpFramePath(
            tabId,
            selected,
            await this.debuggerManager.getFrameSessions(tabId),
            context
        )
        type Matrix = [number, number, number, number, number, number]
        const compose = (left: Matrix, right: Matrix): Matrix => [
            left[0] * right[0] + left[2] * right[1],
            left[1] * right[0] + left[3] * right[1],
            left[0] * right[2] + left[2] * right[3],
            left[1] * right[2] + left[3] * right[3],
            left[0] * right[4] + left[2] * right[5] + left[4],
            left[1] * right[4] + left[3] * right[5] + left[5],
        ]
        let sessionToRoot: Matrix = [1, 0, 0, 1, 0, 0]
        let frameToRoot = sessionToRoot
        for (const [index, { frame, cdpFrameId, ownerTarget: target, queryTarget }] of path.slice(1).entries()) {
            assertActionActive(context)
            const owner = (await chrome.debugger.sendCommand(target, 'DOM.getFrameOwner', { frameId: cdpFrameId })) as {
                backendNodeId: number
            }
            const { model } = (await chrome.debugger.sendCommand(target, 'DOM.getBoxModel', {
                backendNodeId: owner.backendNodeId,
            })) as { model: { content: number[] } }
            const viewport = await chrome.scripting.executeScript({
                target: { tabId, documentIds: [frame.documentId!] },
                func: () => ({ width: innerWidth, height: innerHeight }),
            })
            const dimensions = viewport[0]?.result
            const q = model.content
            if (
                !dimensions ||
                dimensions.width <= 0 ||
                dimensions.height <= 0 ||
                q.length !== 8 ||
                !q.every(Number.isFinite)
            ) {
                throw new Error('Input frame has no usable content geometry')
            }
            // CDP 布局坐标以 1/64 px 量化，超过量化误差的透视投影不按仿射点输入
            if (Math.abs(q[0]! + q[4]! - q[2]! - q[6]!) > 1 / 32 || Math.abs(q[1]! + q[5]! - q[3]! - q[7]!) > 1 / 32) {
                throw new Error('Input frame content quad is not affine')
            }
            const matrix: Matrix = [
                (q[2]! - q[0]!) / dimensions.width,
                (q[3]! - q[1]!) / dimensions.width,
                (q[6]! - q[0]!) / dimensions.height,
                (q[7]! - q[1]!) / dimensions.height,
                q[0]!,
                q[1]!,
            ]
            if (Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]) < 1e-8) {
                throw new Error('Input frame geometry is singular')
            }
            frameToRoot = compose(sessionToRoot, matrix)
            if (queryTarget.sessionId !== target.sessionId) {
                sessionToRoot = frameToRoot
            } else if (index < path.length - 2) {
                const basis = await this.frameViewportBasis(target, owner.backendNodeId)
                if (basis) {
                    const [a, b, c, d, e, f] = basis
                    const determinant = a * d - b * c
                    sessionToRoot = compose(frameToRoot, [
                        d / determinant,
                        -b / determinant,
                        -c / determinant,
                        a / determinant,
                        (c * f - d * e) / determinant,
                        (b * e - a * f) / determinant,
                    ])
                }
            }
        }
        for (const { frame: expected } of path) {
            const current = await chrome.webNavigation.getFrame({ tabId, frameId: expected.frameId })
            if (
                !current ||
                current.documentId !== expected.documentId ||
                current.parentFrameId !== expected.parentFrameId
            ) {
                throw new Error('Input frame identity changed during geometry lookup')
            }
        }
        return {
            x: frameToRoot[0] * point.x + frameToRoot[2] * point.y + frameToRoot[4],
            y: frameToRoot[1] * point.x + frameToRoot[3] * point.y + frameToRoot[5],
        }
    }

    private async frameViewportBasis(
        target: chrome.debugger.DebuggerSession,
        backendNodeId: number
    ): Promise<[number, number, number, number, number, number] | null> {
        const owner = (await chrome.debugger.sendCommand(target, 'DOM.resolveNode', { backendNodeId })) as {
            object: { objectId?: string }
        }
        const ownerId = owner.object.objectId
        if (!ownerId) {
            throw new Error('Frame zoom owner is unavailable')
        }
        try {
            const zoom = (await chrome.debugger.sendCommand(target, 'Runtime.callFunctionOn', {
                objectId: ownerId,
                returnByValue: true,
                functionDeclaration: `function() {
                    if(this.currentCSSZoom!==undefined)return this.currentCSSZoom;
                    let zoom=1;
                    for(let node=this;node;node=node.assignedSlot??node.parentElement??node.getRootNode().host??null)zoom*=parseFloat(getComputedStyle(node).zoom)||1;
                    return zoom;
                }`,
            })) as { result: { value?: number }; exceptionDetails?: unknown }
            if (zoom.exceptionDetails || !(zoom.result.value! > 0) || !Number.isFinite(zoom.result.value)) {
                throw new Error('Frame zoom is unavailable')
            }
            if (zoom.result.value === 1) {
                return null
            }
        } finally {
            await chrome.debugger
                .sendCommand(target, 'Runtime.releaseObject', { objectId: ownerId })
                .catch((error) => console.debug('[MCP] Frame zoom owner cleanup failed', error))
        }
        const described = (await chrome.debugger.sendCommand(target, 'DOM.describeNode', {
            backendNodeId,
            depth: 1,
            pierce: true,
        })) as { node: { contentDocument?: { backendNodeId: number } } }
        if (!described.node.contentDocument) {
            throw new Error('Frame query viewport document is unavailable')
        }
        const documentObject = (await chrome.debugger.sendCommand(target, 'DOM.resolveNode', {
            backendNodeId: described.node.contentDocument.backendNodeId,
        })) as { object: { objectId?: string } }
        const documentId = documentObject.object.objectId
        if (!documentId) {
            throw new Error('Frame query viewport document object is unavailable')
        }
        let anchorId: string | undefined
        try {
            const anchor = (await chrome.debugger.sendCommand(target, 'Runtime.callFunctionOn', {
                objectId: documentId,
                returnByValue: false,
                functionDeclaration: `function() {
                    const walk=this.createTreeWalker(this,NodeFilter.SHOW_ELEMENT);
                    for(let el=walk.nextNode();el;el=walk.nextNode()) {
                        const rect=el.getBoundingClientRect();
                        if(!(rect.width>0&&rect.height>0)||el.getClientRects().length!==1)continue;
                        let aligned=true;
                        for(let node=el;node;node=node.parentElement) {
                            const style=getComputedStyle(node), matrix=new DOMMatrix(style.transform==='none'?undefined:style.transform);
                            if(!matrix.is2D||Math.abs(matrix.b)>1e-12||Math.abs(matrix.c)>1e-12||matrix.a<=0||matrix.d<=0||
                                (style.rotate&&style.rotate!=='none'&&!/^(?:[xyz] )?0deg$/.test(style.rotate))||
                                (style.scale&&style.scale!=='none'&&style.scale.split(/\\s+/).some(value=>Number(value)<=0))) {aligned=false;break;}
                        }
                        if(aligned)return el;
                    }
                    return null;
                }`,
            })) as { result: { objectId?: string }; exceptionDetails?: unknown }
            anchorId = anchor.result.objectId
            if (anchor.exceptionDetails || !anchorId) {
                throw new Error('Frame query viewport anchor is unavailable')
            }
            const rect = (await chrome.debugger.sendCommand(target, 'Runtime.callFunctionOn', {
                objectId: anchorId,
                returnByValue: true,
                functionDeclaration:
                    'function(){const r=this.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}',
            })) as {
                result: { value?: { x: number; y: number; width: number; height: number } }
                exceptionDetails?: unknown
            }
            const { model } = (await chrome.debugger.sendCommand(target, 'DOM.getBoxModel', {
                objectId: anchorId,
            })) as { model: { border: number[] } }
            const r = rect.result.value,
                q = model.border
            if (
                rect.exceptionDetails ||
                !r ||
                !(r.width > 0 && r.height > 0) ||
                ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
                q.length !== 8 ||
                !q.every(Number.isFinite)
            ) {
                throw new Error('Frame query viewport anchor is invalid')
            }
            const [a, b, c, d] = [
                (q[2]! - q[0]!) / r.width,
                (q[3]! - q[1]!) / r.width,
                (q[6]! - q[0]!) / r.height,
                (q[7]! - q[1]!) / r.height,
            ]
            if (
                Math.abs(a! * d! - b! * c!) < 1e-8 ||
                Math.abs(q[0]! + q[4]! - q[2]! - q[6]!) > 1 / 32 ||
                Math.abs(q[1]! + q[5]! - q[3]! - q[7]!) > 1 / 32
            ) {
                throw new Error('Frame query viewport anchor is singular or non-affine')
            }
            return [a!, b!, c!, d!, q[0]! - a! * r.x - c! * r.y, q[1]! - b! * r.x - d! * r.y]
        } finally {
            for (const objectId of [anchorId, documentId]) {
                if (objectId) {
                    await chrome.debugger
                        .sendCommand(target, 'Runtime.releaseObject', { objectId })
                        .catch((error) => console.debug('[MCP] Frame query viewport anchor cleanup failed', error))
                }
            }
        }
    }

    private async getManagedTabId(
        tabId: number | undefined,
        context: ActionContext,
        operation: string
    ): Promise<number> {
        const resolvedTabId = await getTargetTabId(tabId)
        await assertManagedTab(resolvedTabId, context, operation)
        return resolvedTabId
    }
}
