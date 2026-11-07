export function wheelCases() {
    const cases = []
    for (const [layout, axes] of [
        ['normal', ['x', 'y']],
        ['rtl', ['x']],
        ['column-reverse', ['y']],
        ['row-reverse', ['x']],
        ['vertical-rl', ['x']],
    ]) {
        for (const axis of axes) {
            for (const position of ['origin', 'middle', 'far']) {
                for (const delta of [-200, 200]) {
                    cases.push({ group: 'range', layout, axis, position, delta })
                }
            }
        }
        if (layout !== 'normal') {
            cases.push({ group: 'css-control', layout, axis: axes[0], position: 'origin', delta: -200, target: 'css' })
        }
    }
    for (const axis of ['x', 'y']) {
        for (const policy of ['auto', 'contain', 'none']) {
            for (const delta of [-200, 200]) {
                for (const boundary of [false, true]) {
                    cases.push({
                        group: 'overscroll',
                        layout: 'normal',
                        axis,
                        position: boundary ? (delta > 0 ? 'far' : 'origin') : 'middle',
                        delta,
                        [axis === 'x' ? 'policyX' : 'policyY']: policy,
                    })
                }
            }
        }
    }
    for (const blockedAxis of ['x', 'y']) {
        for (const policy of ['contain', 'none']) {
            cases.push({
                group: 'mixed',
                layout: 'normal',
                axis: 'both',
                position: 'far',
                delta: 200,
                [blockedAxis === 'x' ? 'policyX' : 'policyY']: policy,
            })
        }
    }
    for (const axis of ['x', 'y']) {
        for (const delta of [-200, 200]) {
            for (const viewport of [
                'body-auto',
                'body-contain',
                'body-none',
                'body-hidden',
                'root-hidden',
                'root-auto-contain',
                'independent-body',
            ]) {
                cases.push({ group: 'viewport', layout: 'normal', axis, position: 'origin', delta, viewport })
            }
            for (const overflow of ['hidden', 'clip', 'visible']) {
                for (const policy of ['auto', 'contain', 'none']) {
                    cases.push({
                        group: 'hidden',
                        layout: 'normal',
                        axis,
                        position: 'origin',
                        delta,
                        overflow,
                        [axis === 'x' ? 'policyX' : 'policyY']: policy,
                    })
                }
            }
        }
    }
    for (const axis of ['x', 'y']) {
        for (const delta of [-200, 200]) {
            for (const side of ['body', 'html']) {
                for (const containment of [
                    'layout',
                    'paint',
                    'style',
                    'size',
                    'inline-size',
                    'content',
                    'strict',
                    'content-visibility:auto',
                    'container-type:inline-size',
                    'container-type:size',
                    'container-type:scroll-state',
                ]) {
                    cases.push({
                        group: 'containment',
                        layout: 'normal',
                        axis,
                        position: 'middle',
                        delta,
                        side,
                        containment,
                    })
                }
            }
            for (const display of ['inline', 'contents', 'block']) {
                for (const overflow of ['hidden', 'auto']) {
                    for (const policy of ['auto', 'contain', 'none']) {
                        cases.push({
                            group: 'box',
                            layout: 'normal',
                            axis,
                            position: 'middle',
                            delta,
                            display,
                            overflow,
                            policy,
                        })
                    }
                }
            }
            for (const policy of ['contain', 'none']) {
                cases.push({
                    group: 'box',
                    layout: 'normal',
                    axis,
                    position: 'origin',
                    delta,
                    display: 'block',
                    overflow: 'hidden',
                    policy,
                    empty: true,
                })
            }
            for (const positioning of [
                'fixed-escape',
                'absolute-escape',
                'ordinary',
                'absolute-relative',
                'fixed-transform',
                'fixed-contain-layout',
                'fixed-contain-paint',
                'fixed-perspective',
                'fixed-filter',
                'fixed-will-change',
                'fixed-self',
            ]) {
                cases.push({ group: 'positioning', layout: 'normal', axis, position: 'middle', delta, positioning })
            }
        }
    }
    for (const [display, overflow, policy, reportAxis, reportDelta] of [
        ['flow-root list-item', 'auto', 'auto', 'y', 200],
        ['inline flow-root list-item', 'auto', 'auto', 'x', -200],
        ['-webkit-box', 'auto', 'auto', 'y', 200],
        ['-webkit-inline-box', 'auto', 'auto', 'y', 200],
        ['flow-root list-item', 'hidden', 'contain', 'y', 200],
        ['inline flow-root list-item', 'hidden', 'none', 'x', -200],
        ['flow-root', 'auto', 'auto', 'y', 200],
        ['inline', 'hidden', 'contain', 'y', 200],
        ['block', 'hidden', 'contain', 'y', 200],
        ['block ruby', 'auto', 'auto'],
        ['block ruby', 'hidden', 'contain'],
        ['ruby', 'auto', 'auto'],
        ['ruby', 'hidden', 'contain'],
    ]) {
        for (const axis of ['x', 'y']) {
            for (const delta of [-200, 200]) {
                cases.push({
                    group: 'display',
                    layout: 'normal',
                    axis,
                    position: 'middle',
                    delta,
                    display,
                    overflow,
                    policy,
                    review: 'C31F5-01',
                    source: axis === reportAxis && delta === reportDelta ? 'report' : 'extended',
                })
            }
        }
    }
    for (const [display, property, value, establishes, reported] of [
        ['inline list-item', 'transform', 'translate(0px)', false, true],
        ['inline list-item', 'contain', 'layout', false, true],
        ['block', 'will-change', 'contain', true, true],
        ['inline', 'transform', 'translate(0px)', false, true],
        ['inline-block', 'transform', 'translate(0px)', true, true],
        ['block', 'will-change', 'content-visibility', false, true],
        ['block', 'will-change', 'filter', true, true],
        ['inline flow-root list-item', 'will-change', 'contain', true, false],
    ]) {
        for (const positioning of ['absolute', 'fixed']) {
            for (const shadow of [false, true]) {
                for (const axis of ['x', 'y']) {
                    for (const delta of [-200, 200]) {
                        cases.push({
                            group: 'containing-block',
                            layout: 'normal',
                            axis,
                            position: 'middle',
                            delta,
                            display,
                            property,
                            value,
                            establishes,
                            positioning,
                            shadow,
                            review: 'C31F5-02',
                            source:
                                reported && positioning === 'fixed' && !shadow && axis === 'y' && delta === 200
                                    ? 'report'
                                    : 'extended',
                        })
                    }
                }
            }
        }
    }
    for (const side of ['html', 'body']) {
        for (const display of side === 'html'
            ? ['list-item', 'flow-root list-item']
            : ['inline', 'inline list-item', 'flow-root list-item', 'inline flow-root list-item']) {
            for (const axis of ['x', 'y']) {
                for (const delta of [-200, 200]) {
                    cases.push({
                        group: 'containment',
                        layout: 'normal',
                        axis,
                        position: 'middle',
                        delta,
                        side,
                        display,
                        containment: 'layout',
                        review: 'C31F5-02',
                        source: 'extended',
                    })
                }
            }
        }
    }
    return cases
}

export async function configureWheelFixture(options) {
    const { document, window, AbortController } = globalThis
    window.__mcpWheelFixture?.controller.abort()
    document.querySelector('#wheel-fixture')?.remove()
    document.documentElement.style.cssText = ''
    document.body.style.cssText = 'margin:0;min-width:2200px;min-height:2200px'
    window.scrollTo({ left: 0, top: 0, behavior: 'instant' })
    const outer = document.createElement('div')
    outer.id = 'wheel-fixture'
    outer.style.cssText =
        'position:absolute;left:12px;top:12px;width:320px;height:160px;overflow:auto;scroll-behavior:auto'
    const spacer = document.createElement('div')
    spacer.style.cssText = 'width:1800px;height:1800px;pointer-events:none'
    const box = options.group === 'box' || options.group === 'display'
    const containingBlock = options.group === 'containing-block'
    const container = document.createElement(box || containingBlock ? 'span' : 'div')
    container.id = 'scroller'
    container.style.cssText = 'position:absolute;left:420px;top:420px;width:220px;height:100px;scroll-behavior:smooth'
    container.style.overflowX = options.axis === 'y' ? 'hidden' : 'auto'
    container.style.overflowY = options.axis === 'x' ? 'hidden' : 'auto'
    container.style.overscrollBehaviorX = options.policyX ?? 'auto'
    container.style.overscrollBehaviorY = options.policyY ?? 'auto'
    const inner = document.createElement('div')
    inner.id = 'inner'
    inner.style.cssText = `width:${options.axis === 'y' ? 200 : 1000}px;height:${options.axis === 'x' ? 80 : 1000}px`
    if (options.layout === 'rtl') {
        container.style.direction = 'rtl'
    } else if (options.layout === 'row-reverse' || options.layout === 'column-reverse') {
        container.style.display = 'flex'
        container.style.flexDirection = options.layout
        inner.style.flex = '0 0 1000px'
    } else if (options.layout === 'vertical-rl') {
        container.style.writingMode = 'vertical-rl'
    }
    if (options.group === 'hidden') {
        container.style.overflow = options.overflow
    }
    if (options.group === 'viewport') {
        outer.style.cssText = 'position:relative;width:2200px;height:2200px;overflow:visible'
        container.style.cssText = 'position:absolute;left:480px;top:430px;width:220px;height:100px;overflow:visible'
        inner.style.cssText = 'width:200px;height:80px'
        const root = document.documentElement
        const body = document.body
        const kind = options.viewport
        if (kind.startsWith('root-') || kind === 'independent-body') {
            root.style.overflow = kind === 'root-hidden' ? 'hidden' : 'auto'
        }
        if (kind.startsWith('body-') || kind === 'independent-body') {
            body.style.overflow = kind === 'body-hidden' ? 'hidden' : 'auto'
        }
        const property = options.axis === 'x' ? 'overscrollBehaviorX' : 'overscrollBehaviorY'
        if (kind === 'body-contain' || kind === 'body-none') {
            body.style[property] = kind === 'body-contain' ? 'contain' : 'none'
        }
        if (kind === 'root-auto-contain') {
            root.style[property] = 'contain'
        }
        if (kind === 'independent-body') {
            body.style.cssText = 'position:relative;margin:0;width:420px;height:210px;overflow:auto'
        }
    }
    if (options.group === 'containment') {
        document.documentElement.style.width = '100vw'
        document.documentElement.style.height = '100vh'
        outer.style.cssText = 'position:relative;width:2200px;height:2200px;overflow:visible'
        container.style.cssText = 'position:absolute;left:480px;top:480px;width:220px;height:100px;overflow:visible'
        inner.style.cssText = 'width:200px;height:80px'
        document.body.style.cssText = 'position:relative;margin:0;width:420px;height:210px;overflow:auto'
        const owner = options.side === 'html' ? document.documentElement : document.body
        const [property, value] = options.containment.includes(':')
            ? options.containment.split(':')
            : ['contain', options.containment]
        owner.style.setProperty(property, value)
        if (options.display) {
            owner.style.display = options.display
        }
    } else if (box) {
        container.style.cssText = `display:${options.display};width:${options.empty ? 2200 : 1800}px;height:${options.empty ? 2200 : 1800}px;overflow:${options.overflow};overscroll-behavior:${options.policy};scroll-behavior:auto`
        inner.style.cssText = 'display:inline-block;width:2200px;height:2200px'
        spacer.style.display = 'none'
    } else if (options.group === 'positioning') {
        const kind = options.positioning
        const escape = kind.endsWith('escape') || kind === 'fixed-self'
        outer.style.cssText = `position:${escape ? 'static' : 'relative'};left:400px;top:400px;margin:12px;width:320px;height:160px;overflow:auto;scroll-behavior:auto`
        container.style.cssText = 'width:1800px;height:1800px;overflow:visible'
        spacer.style.display = 'none'
        if (kind === 'fixed-transform') {
            outer.style.transform = 'translate(0px)'
        }
        if (kind === 'fixed-contain-layout') {
            outer.style.contain = 'layout'
        }
        if (kind === 'fixed-contain-paint') {
            outer.style.contain = 'paint'
        }
        if (kind === 'fixed-perspective') {
            outer.style.perspective = '1000px'
        }
        if (kind === 'fixed-filter') {
            outer.style.filter = 'blur(0px)'
        }
        if (kind === 'fixed-will-change') {
            outer.style.willChange = 'transform'
        }
        const position = kind === 'ordinary' ? 'relative' : kind.startsWith('absolute') ? 'absolute' : 'fixed'
        const left = kind === 'absolute-escape' ? 750 : escape ? 350 : 460
        const top = kind === 'absolute-escape' ? 450 : escape ? 50 : 450
        inner.style.cssText = `position:${position};left:${left}px;top:${top}px;width:60px;height:80px`
        if (kind === 'fixed-self') {
            inner.style.overflow = 'auto'
            const content = document.createElement('div')
            content.style.cssText = 'width:2200px;height:2200px;pointer-events:none'
            inner.append(content)
        }
    }
    if (containingBlock) {
        outer.style.cssText = 'position:static;margin:12px;width:320px;height:160px;overflow:auto;scroll-behavior:auto'
        container.style.cssText = `display:${options.display};position:static;width:1800px;height:1800px;overflow:visible`
        container.style.setProperty(options.property, options.value)
        spacer.style.cssText = 'display:inline-block;width:1800px;height:1800px;pointer-events:none'
        inner.style.cssText = `position:${options.positioning};left:${options.establishes ? 480 : 350}px;top:${options.establishes ? 480 : 50}px;width:60px;height:80px`
        const contents = options.shadow ? container.attachShadow({ mode: 'open' }) : container
        contents.append(spacer, inner)
        outer.append(container)
    } else {
        container.append(inner)
        outer.append(spacer, container)
    }
    document.body.append(outer)
    await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))
    const measure = (axis) => {
        container.scrollTo({ [axis === 'x' ? 'left' : 'top']: -1000000, behavior: 'instant' })
        const minimum = axis === 'x' ? container.scrollLeft : container.scrollTop
        container.scrollTo({ [axis === 'x' ? 'left' : 'top']: 1000000, behavior: 'instant' })
        const maximum = axis === 'x' ? container.scrollLeft : container.scrollTop
        return { minimum, maximum }
    }
    const range = { x: measure('x'), y: measure('y') }
    const offset = (axis) =>
        options.position === 'middle'
            ? Math.trunc((range[axis].minimum + range[axis].maximum) / 2)
            : options.position === 'far'
              ? range[axis].minimum < 0
                  ? range[axis].minimum
                  : range[axis].maximum
              : 0
    container.scrollTo({ left: offset('x'), top: offset('y'), behavior: 'instant' })
    if (options.group === 'viewport' || options.group === 'containment') {
        if (options.display) {
            document.body.scrollTo({ left: 400, top: 400, behavior: 'instant' })
            if (document.body.scrollLeft === 0 && document.body.scrollTop === 0) {
                window.scrollTo({ left: 400, top: 400, behavior: 'instant' })
            }
        } else if (
            options.viewport === 'independent-body' ||
            (options.group === 'containment' && options.containment !== 'container-type:scroll-state')
        ) {
            document.body.scrollTo({ left: 400, top: 400, behavior: 'instant' })
        } else {
            window.scrollTo({ left: 400, top: 400, behavior: 'instant' })
        }
    } else {
        outer.scrollTo({ left: 400, top: 400, behavior: 'instant' })
        if (options.group === 'positioning') {
            window.scrollTo({ left: 400, top: 400, behavior: 'instant' })
            if (options.positioning === 'fixed-self') {
                inner.scrollTo({ left: 400, top: 400, behavior: 'instant' })
            }
        }
    }
    const controller = new AbortController()
    const events = []
    document.addEventListener(
        'wheel',
        (event) =>
            events.push({
                trusted: event.isTrusted,
                x: event.deltaX,
                y: event.deltaY,
                target: event.composedPath()[0]?.id ?? event.target.id,
                composed: event.composed,
            }),
        { passive: false, signal: controller.signal }
    )
    window.__mcpWheelFixture = { outer, container, inner, controller, events, range }
    const positioned = options.group === 'positioning' || containingBlock
    const rect = (box ? outer : positioned ? inner : container).getBoundingClientRect()
    const point = {
        x: rect.x + (positioned ? 10 : 60),
        y: rect.y + (positioned ? 10 : 30),
    }
    const hit = (container.shadowRoot ?? document).elementFromPoint(point.x, point.y)
    return {
        point,
        hit: hit?.id,
        range,
        initial: {
            container: { x: container.scrollLeft, y: container.scrollTop },
            target: { x: inner.scrollLeft, y: inner.scrollTop },
            outer: { x: outer.scrollLeft, y: outer.scrollTop },
            viewport: { x: window.scrollX, y: window.scrollY },
            root: { x: document.documentElement.scrollLeft, y: document.documentElement.scrollTop },
            body: { x: document.body.scrollLeft, y: document.body.scrollTop },
        },
        style: {
            direction: window.getComputedStyle(container).direction,
            writingMode: window.getComputedStyle(container).writingMode,
            flexDirection: window.getComputedStyle(container).flexDirection,
            box: Object.fromEntries(
                ['display', 'position', 'contain', 'contentVisibility', 'containerType', 'transform', 'willChange'].map(
                    (key) => [key, window.getComputedStyle(container)[key]]
                )
            ),
            containment: [document.documentElement, document.body].map((node) =>
                Object.fromEntries(
                    ['display', 'contain', 'contentVisibility', 'containerType'].map((key) => [
                        key,
                        window.getComputedStyle(node)[key],
                    ])
                )
            ),
            positioning: {
                target: window.getComputedStyle(inner).position,
                nativeOffsetParent: inner.offsetParent?.id,
                ancestorTransform: window.getComputedStyle(outer).transform,
                ancestorContain: window.getComputedStyle(outer).contain,
            },
            container: {
                overflowX: window.getComputedStyle(container).overflowX,
                overflowY: window.getComputedStyle(container).overflowY,
            },
            root: {
                overflowX: window.getComputedStyle(document.documentElement).overflowX,
                overflowY: window.getComputedStyle(document.documentElement).overflowY,
            },
            body: {
                overflowX: window.getComputedStyle(document.body).overflowX,
                overflowY: window.getComputedStyle(document.body).overflowY,
            },
        },
    }
}

export function readWheelFixture() {
    const { window, document } = globalThis
    const state = window.__mcpWheelFixture
    return {
        container: { x: state.container.scrollLeft, y: state.container.scrollTop },
        target: { x: state.inner.scrollLeft, y: state.inner.scrollTop },
        outer: { x: state.outer.scrollLeft, y: state.outer.scrollTop },
        viewport: { x: window.scrollX, y: window.scrollY },
        root: { x: document.documentElement.scrollLeft, y: document.documentElement.scrollTop },
        body: { x: document.body.scrollLeft, y: document.body.scrollTop },
        events: [...state.events],
    }
}
