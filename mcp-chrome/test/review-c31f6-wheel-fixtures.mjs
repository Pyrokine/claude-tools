/* global document, window, getComputedStyle, scrollX, scrollY, performance */
export function cases({ boundaryObservations = false } = {}) {
    const result = [
        { id: 'math-block', kind: 'math', display: 'block math' },
        { id: 'math-inline', kind: 'math', display: 'inline math', axis: 'x', delta: -120 },
        { id: 'math-hidden-contain', kind: 'math', overflow: 'hidden', policy: 'contain' },
        { id: 'math-hidden-none', kind: 'math', overflow: 'hidden', policy: 'none' },
        { id: 'svg-hidden-contain', kind: 'svg', overflow: 'hidden', policy: 'contain' },
        { id: 'svg-hidden-none-x', kind: 'svg', overflow: 'hidden', policy: 'none', axis: 'x', delta: -120 },
        { id: 'input-text', kind: 'input', axis: 'x' },
        { id: 'fraction-quarter', deltas: Array(8).fill(0.25) },
        { id: 'fraction-negative', deltas: Array(8).fill(-0.25) },
        { id: 'fraction-half', deltas: Array(8).fill(0.5) },
        { id: 'integer', deltas: Array(8).fill(1) },
        { id: 'fraction-reverse', deltas: [0.25, 0.25, -0.25, -0.25, 0.25, 0.25, 0.25, 0.25] },
        { id: 'fraction-cross-handler', deltas: Array(8).fill(0.25), freshHandler: true },
        { id: 'fraction-long-gap', deltas: [0.25, 0.25, 0.25, 0.25], interval: 280 },
        { id: 'zoom-two', zoom: '2' },
        { id: 'scale-two', scale: true },
        { id: 'nested-zoom', zoom: '2', parentZoom: '2' },
        ...['remove-target', 'remove-container', 'reparent', 'cancel-remove', 'self-scroll', 'none'].map(
            (mutation) => ({ id: mutation, mutation })
        ),
        ...['block', 'contents'].flatMap((body) =>
            ['hidden', 'auto'].map((overflow) => ({ id: `body-${body}-${overflow}`, kind: 'body', body, overflow }))
        ),
    ]
    for (const display of ['ruby-text', 'table-row', 'inline', 'inline-block', 'block']) {
        for (const [property, value] of [
            ['transform', 'translate(0px)'],
            ['translate', '0px'],
            ['rotate', '0deg'],
            ['scale', '1'],
            ['perspective', '1000px'],
            ['filter', 'blur(0px)'],
            ['will-change', 'transform'],
        ]) {
            result.push({ id: `${display}-${property}`, kind: 'cb', display, property, value })
        }
    }
    for (const value of [
        'transform',
        'TRANSFORM',
        'TrAnSfOrM',
        'TRANSFORM, opacity',
        'TRANSLATE',
        'ROTATE',
        'SCALE',
        'PERSPECTIVE',
        'FILTER',
        'BACKDROP-FILTER',
        'CONTAIN',
        '-webkit-transform',
        '-webkit-filter',
        '-webkit-perspective',
        '-webkit-transform-style',
        'transform-style',
        'offset-path',
        'offset-position',
        'opacity',
        '--custom',
        'unknown',
    ]) {
        result.push({ id: `hint-${value}`, kind: 'cb', property: 'will-change', value })
    }
    for (const [property, value] of [
        ['transform-style', 'preserve-3d'],
        ['transform-style', 'flat'],
        ['offset-path', 'path("M 0 0 L 100 0")'],
        ['offset-path', 'none'],
        ['offset-position', '0% 0%'],
        ['offset-position', 'auto'],
        ['offset-position', 'normal'],
        ['offset-distance', '10px'],
        ['offset-rotate', '10deg'],
        ['backface-visibility', 'hidden'],
        ['container-type', 'inline-size'],
    ]) {
        result.push({ id: `property-${property}-${value}`, kind: 'cb', property, value })
    }
    result.push({
        id: 'preserve-used-flat-opacity',
        kind: 'cb',
        property: 'transform-style',
        value: 'preserve-3d',
        extra: 'opacity:.9',
    })
    result.push({
        id: 'preserve-used-flat-overflow',
        kind: 'cb',
        property: 'transform-style',
        value: 'preserve-3d',
        extra: 'overflow:hidden',
    })
    for (const positioning of ['fixed', 'absolute']) {
        for (const transformed of [true, false]) {
            result.push({ id: `slot-${positioning}-${transformed}`, kind: 'slot', positioning, transformed })
        }
    }
    for (const display of ['block math', 'inline math']) {
        for (const overflow of ['auto', 'hidden']) {
            for (const policy of ['auto', 'contain', 'none']) {
                for (const axis of ['x', 'y']) {
                    result.push({
                        id: `math-${display}-${overflow}-${policy}-${axis}`,
                        kind: 'math',
                        display,
                        overflow,
                        policy,
                        axis,
                        delta: axis === 'x' ? -120 : 120,
                    })
                }
            }
        }
    }
    for (const inputType of ['text', 'search', 'url', 'tel', 'password', 'email', 'number']) {
        for (const rtl of [false, true]) {
            result.push({
                id: `input-${inputType}-${inputType === 'number' ? 'unfocused-' : ''}${rtl ? 'rtl' : 'ltr'}`,
                kind: 'input',
                inputType,
                rtl,
                focused: inputType !== 'number',
                axis: 'x',
                delta: rtl ? -120 : 120,
            })
        }
    }
    result.push({ id: 'input-number-ltr', kind: 'input', inputType: 'number', focused: true, axis: 'x', delta: 120 })
    result.push({
        id: 'input-number-rtl',
        kind: 'input',
        inputType: 'number',
        focused: true,
        rtl: true,
        axis: 'x',
        delta: -120,
    })
    for (const value of ['', '10', '0', '-3.5']) {
        for (const axis of ['x', 'y']) {
            for (const delta of [120, -120]) {
                result.push({
                    id: `number-value-${value || 'empty'}-${axis}-${delta}`,
                    kind: 'input',
                    inputType: 'number',
                    value,
                    axis,
                    delta,
                })
            }
        }
    }
    for (const step of ['2', '.5', 'any', 'ANY', 'AnY', '0', '-2', 'invalid']) {
        for (const delta of [120, -120]) {
            result.push({
                id: `number-step-${step}-${delta}`,
                kind: 'input',
                inputType: 'number',
                value: '10',
                step,
                delta,
            })
        }
    }
    for (const value of ['-3.5', '0.3']) {
        for (const delta of [120, -120]) {
            result.push({
                id: `number-any-fraction-${value}-${delta}`,
                kind: 'input',
                inputType: 'number',
                value,
                step: 'any',
                delta,
            })
        }
    }
    for (const state of ['readonly', 'disabled', 'unfocused', 'prevent']) {
        for (const axis of ['x', 'y']) {
            result.push({
                id: `number-state-${state}-${axis}`,
                kind: 'input',
                inputType: 'number',
                value: '10',
                state,
                focused: state !== 'unfocused',
                axis,
            })
        }
    }
    for (const value of ['0', '10', '0.3']) {
        for (const delta of [120, -120]) {
            result.push({
                id: `number-bounds-${value}-${delta}`,
                kind: 'input',
                inputType: 'number',
                value,
                min: '0',
                max: '10',
                step: '1',
                delta,
            })
        }
    }
    for (const step of ['any', '1']) {
        for (const value of ['', '-2', '12']) {
            for (const delta of [120, -120]) {
                result.push({
                    id: `number-range-${step}-${value || 'empty'}-${delta}`,
                    kind: 'input',
                    inputType: 'number',
                    value,
                    step,
                    min: '0',
                    max: '10',
                    delta,
                })
            }
        }
    }
    for (const step of ['any', '1']) {
        for (const value of ['', '5']) {
            for (const delta of [120, -120]) {
                result.push({
                    id: `number-inverted-${step}-${value || 'empty'}-${delta}`,
                    kind: 'input',
                    inputType: 'number',
                    value,
                    step,
                    min: '10',
                    max: '0',
                    delta,
                })
            }
        }
    }
    for (const delta of [0.25, -0.25, 1, -1, 240, -240]) {
        result.push({ id: `number-delta-${delta}`, kind: 'input', inputType: 'number', value: '10', delta })
    }
    for (const kind of ['foreignObject', 'foreignObject-child', 'foreignObject-cb']) {
        for (const axis of ['x', 'y']) {
            result.push({ id: `${kind}-${axis}`, kind, axis })
        }
    }
    for (const rtl of [false, true]) {
        for (const delta of [0.25, -0.25, 0.5, 1]) {
            result.push({
                id: `fraction-${rtl ? 'rtl' : 'ltr'}-${delta}-x`,
                rtl,
                axis: 'x',
                deltas: Array(8).fill(delta),
            })
        }
    }
    for (const reverse of ['row-reverse', 'column-reverse']) {
        result.push({
            id: `fraction-${reverse}`,
            reverse,
            axis: reverse === 'row-reverse' ? 'x' : 'y',
            deltas: Array(8).fill(-0.25),
        })
    }
    for (const reset of ['position', 'target', 'zoom', 'boundary']) {
        result.push({ id: `fraction-reset-${reset}`, reset, deltas: [0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25] })
    }
    for (const kind of ['body', 'body-quirks']) {
        for (const body of ['block', 'contents']) {
            for (const overflow of ['auto', 'hidden']) {
                for (const rootOverflow of ['', 'auto', 'hidden']) {
                    result.push({
                        id: `${kind}-${body}-${overflow}-root-${rootOverflow || 'visible'}`,
                        kind: 'body',
                        quirks: kind === 'body-quirks',
                        body,
                        overflow,
                        rootOverflow,
                    })
                }
            }
        }
    }
    for (const interval of [5, 800]) {
        result.push({ id: `fraction-interval-${interval}`, interval, deltas: [0.25, 0.25, 0.25, 0.25] })
    }
    for (const axis of ['x', 'y']) {
        for (const zoom of ['2', '1.5']) {
            for (const delta of [120, -120, 0.25]) {
                result.push({
                    id: `zoom-${zoom}-${axis}-${delta}`,
                    axis,
                    zoom,
                    deltas: Array(delta === 0.25 ? 8 : 1).fill(delta),
                })
            }
        }
    }
    for (const snap of ['mandatory', 'proximity']) {
        for (const delta of [0.25, -0.25, 30, -30, 220]) {
            result.push({
                id: `snap-${snap}-${delta}`,
                snap,
                deltas: Array(Math.abs(delta) === 0.25 ? 8 : 1).fill(delta),
                acceptedSnap: true,
            })
        }
    }
    for (const positioning of ['fixed', 'absolute']) {
        for (const transformed of [true, false]) {
            for (const axis of ['x', 'y']) {
                result.push({
                    id: `slot-frame-${positioning}-${transformed}-${axis}`,
                    kind: 'slot',
                    positioning,
                    transformed,
                    frame: true,
                    axis,
                    delta: -120,
                })
            }
        }
    }
    result.push({ id: 'frame-css-zoom', frame: true, frameZoom: 2 })
    result.push({
        id: 'viewport-fraction',
        kind: 'body',
        body: 'contents',
        overflow: 'auto',
        deltas: Array(8).fill(0.25),
    })
    result.push({
        id: 'viewport-quirks-fraction',
        kind: 'body',
        quirks: true,
        body: 'contents',
        overflow: 'auto',
        deltas: Array(8).fill(0.25),
    })
    for (const snap of ['mandatory', 'proximity', 'none']) {
        for (const policy of ['auto', 'contain', 'none']) {
            for (const delta of [40, -40, 200]) {
                result.push({
                    id: `snap-original-${snap}-${policy}-${delta}`,
                    snap,
                    policy,
                    delta,
                    acceptedSnap: true,
                    stableSnap: true,
                    requireNativeEquality: snap !== 'mandatory' || delta === 200,
                })
            }
        }
    }
    for (const policy of ['auto', 'contain', 'none']) {
        for (const axis of ['x', 'y']) {
            for (const delta of [-120, 120]) {
                result.push({
                    id: `c31f7-foreign-self-${policy}-${axis}-${delta}`,
                    kind: 'foreignObject-self',
                    axis,
                    policy,
                    delta,
                })
            }
        }
    }
    for (const [replaceChild, selfScroll, state] of [
        [true, 0, undefined],
        [false, 50, undefined],
        [true, 50, undefined],
        [false, 50, 'prevent'],
    ]) {
        result.push({
            id: `c31f7-fraction-continuity-${replaceChild}-${selfScroll}-${state ?? 'default'}`,
            replaceChild,
            selfScroll,
            state,
            deltas: Array(8).fill(0.25),
            interval: 50,
        })
    }
    for (const axis of ['x', 'y']) {
        for (const reversed of [false, true]) {
            for (const policy of ['auto', 'contain', 'none']) {
                for (const start of ['inside', 'end']) {
                    for (const amount of [120, 0.25]) {
                        result.push({
                            id: `c31f7-boundary-${axis}-${reversed}-${policy}-${start}-${amount}`,
                            axis,
                            policy,
                            start,
                            ...(axis === 'x'
                                ? { width: 219.8, rtl: reversed }
                                : { height: 99.8, ...(reversed ? { reverse: 'column-reverse' } : {}) }),
                            contentHeight: 2000,
                            zoom: '2',
                            deltas: Array(amount === 0.25 ? 8 : 1).fill(reversed ? -amount : amount),
                            interval: 50,
                            boundaryProbe: true,
                        })
                    }
                }
            }
        }
    }
    if (boundaryObservations) {
        for (const axis of ['x', 'y']) {
            for (const policy of ['auto', 'contain', 'none']) {
                for (const destination of ['end', 'inside']) {
                    result.push({
                        id: `c31f7-boundary-listener-${axis}-${policy}${destination === 'inside' ? '-inside' : ''}`,
                        axis,
                        policy,
                        ...(axis === 'x' ? { width: 219.8 } : { height: 99.8 }),
                        contentHeight: 2000,
                        zoom: '2',
                        start: destination === 'inside' ? 'end' : 'inside',
                        eventBoundary: destination,
                        boundaryProbe: true,
                        delta: 120,
                    })
                }
            }
        }
    }
    for (const height of [99.8, 100]) {
        for (const start of ['inside', 'end']) {
            for (const delta of [120, 0.25]) {
                result.push({
                    id: `c31f7-boundary-probe-${height}-${start}-${delta}`,
                    height,
                    contentHeight: 2000,
                    zoom: '2',
                    start,
                    boundaryProbe: true,
                    deltas: Array(delta === 0.25 ? 8 : 1).fill(delta),
                    interval: 50,
                })
            }
        }
    }
    return result
}

export async function configure(options) {
    window.__c31f6?.controller.abort()
    document.body.replaceChildren()
    document.documentElement.style.cssText = ''
    document.body.style.cssText = 'margin:0;min-width:2400px;min-height:2400px'
    window.scrollTo({ left: 0, top: 0, behavior: 'instant' })
    const make = (tag, css, parent, ns) => {
        const node = ns ? document.createElementNS(ns, tag) : document.createElement(tag)
        node.style.cssText = css
        if (parent) {
            parent.append(node)
        }
        return node
    }
    const outer = make('div', 'position:relative;margin:12px;width:320px;height:180px;overflow:auto', document.body)
    outer.id = 'outer'
    const spacer = make('div', 'width:1800px;height:1800px;pointer-events:none', outer)
    let container = make(
        'div',
        'position:absolute;left:420px;top:420px;width:220px;height:100px;overflow:auto;scroll-behavior:auto',
        outer
    )
    container.id = 'scroller'
    let inner = make('span', 'display:block;width:1600px;height:1600px', container)
    inner.id = 'inner'
    let middle
    if (options.kind === 'math' || options.kind === 'svg') {
        container.remove()
        spacer.remove()
        const math = options.kind === 'math'
        const ns = math ? 'http://www.w3.org/1998/Math/MathML' : 'http://www.w3.org/2000/svg'
        container = make(
            math ? 'math' : 'svg',
            `display:${options.display ?? 'block'};width:1800px;height:1800px;overflow:${options.overflow ?? 'auto'};overscroll-behavior:${options.policy ?? 'auto'}`,
            outer,
            ns
        )
        container.id = 'scroller'
        const parent = math ? make('mtext', '', container, ns) : make('foreignObject', '', container, ns)
        if (!math) {
            parent.setAttribute('width', '2200')
            parent.setAttribute('height', '2200')
        }
        inner = make('span', 'display:inline-block;width:2200px;height:2200px', parent)
        inner.id = 'inner'
        container.scrollTo({ left: 207, top: 207, behavior: 'instant' })
    } else if (options.kind?.startsWith('foreignObject')) {
        container.remove()
        spacer.remove()
        const svg = make('svg', 'display:block;width:1800px;height:1800px', outer, 'http://www.w3.org/2000/svg')
        const foreign = make('foreignObject', '', svg, 'http://www.w3.org/2000/svg')
        foreign.setAttribute('width', '1800')
        foreign.setAttribute('height', '1800')
        if (options.kind === 'foreignObject-child') {
            container = make(
                'div',
                'position:absolute;left:420px;top:420px;width:220px;height:100px;overflow:auto',
                foreign
            )
            container.scrollTo(400, 400)
            inner = make('span', 'display:block;width:1800px;height:1800px', container)
            container.scrollTo(400, 400)
        } else {
            container = foreign
            inner = make(
                'span',
                options.kind === 'foreignObject-cb'
                    ? 'position:fixed;left:480px;top:480px;width:60px;height:70px'
                    : 'display:inline-block;width:2200px;height:2200px',
                foreign
            )
        }
        if (options.kind === 'foreignObject-self') {
            foreign.style.overflow = options.policy === 'auto' ? 'auto' : 'hidden'
            foreign.style.overscrollBehavior = options.policy
            inner.style.cssText = 'display:inline-block;width:3200px;height:3200px'
            foreign.scrollTo({ left: 400, top: 400, behavior: 'instant' })
        }
        container.id = 'scroller'
        inner.id = 'inner'
    } else if (options.kind === 'input') {
        container.remove()
        container = make(
            'input',
            'position:absolute;left:420px;top:420px;width:220px;height:80px;font:20px monospace',
            outer
        )
        container.type = options.inputType ?? 'text'
        container.value = container.type === 'number' ? (options.value ?? '') : 'abcdefghijklmnopqrstuvwxyz'.repeat(100)
        if (options.step) {
            container.step = options.step
        }
        if (options.min !== undefined) {
            container.min = options.min
        }
        if (options.max !== undefined) {
            container.max = options.max
        }
        container.readOnly = options.state === 'readonly'
        container.disabled = options.state === 'disabled'
        if (options.rtl) {
            container.style.direction = 'rtl'
        }
        if (options.focused !== false) {
            container.focus({ preventScroll: true })
        }
        if (['text', 'search', 'url', 'tel', 'password'].includes(container.type)) {
            container.setSelectionRange(10, 10)
        }
        container.scrollLeft = options.rtl ? -400 : 400
        container.id = 'inner'
        inner = container
    } else if (options.kind === 'cb') {
        spacer.remove()
        outer.style.position = 'static'
        container.style.cssText = `display:${options.display ?? 'block'};width:1800px;height:1800px;overflow:visible;${options.extra ?? ''}`
        container.style.setProperty(options.property, options.value)
        make('span', 'display:inline-block;width:1800px;height:1800px;pointer-events:none', container)
        inner.style.cssText = 'position:fixed;left:480px;top:480px;width:60px;height:70px'
        if (!inner.offsetParent) {
            inner.style.cssText = 'position:fixed;left:350px;top:50px;width:60px;height:70px'
        }
    } else if (options.kind === 'slot') {
        spacer.remove()
        container.style.cssText = 'width:1800px;height:1800px;transform:translate(0px)'
        inner.remove()
        const shadow = container.attachShadow({ mode: 'open' })
        middle = make('div', 'width:320px;height:160px;overflow:auto;position:static', shadow)
        middle.id = 'middle'
        make(
            'slot',
            `display:block;width:1800px;height:1800px;${options.transformed ? 'transform:translate(0px)' : ''}`,
            middle
        )
        const position = options.transformed ? 480 : 80
        inner = make(
            'span',
            `position:${options.positioning};left:${position}px;top:${position}px;width:60px;height:70px`,
            container
        )
        inner.id = 'inner'
        middle.scrollTo(400, 400)
    } else if (options.kind === 'body') {
        outer.style.cssText = 'width:2400px;height:2400px'
        container.style.cssText = 'position:absolute;left:460px;top:460px;width:220px;height:100px'
        document.body.style.display = options.body
        document.body.style.overflow = options.overflow
        document.documentElement.style.overflow = options.rootOverflow ?? ''
        window.scrollTo({ left: 400, top: 400, behavior: 'instant' })
    } else {
        container.style.overscrollBehavior = options.policy ?? 'auto'
        if (options.height !== undefined) {
            container.style.height = `${options.height}px`
        }
        if (options.width !== undefined) {
            container.style.width = `${options.width}px`
        }
        if (options.contentHeight !== undefined) {
            inner.style.height = `${options.contentHeight}px`
        }
        if (options.zoom) {
            container.style.zoom = options.zoom
            container.style.left = `${420 / Number(options.zoom)}px`
            container.style.top = `${420 / Number(options.zoom)}px`
        }
        if (options.parentZoom) {
            outer.style.zoom = options.parentZoom
        }
        if (options.scale) {
            container.style.transformOrigin = '0 0'
            container.style.transform = 'scale(2)'
        }
        if (options.rtl) {
            container.style.direction = 'rtl'
        }
        if (options.reverse) {
            container.style.display = 'flex'
            container.style.flexDirection = options.reverse
            inner.style.flex = '0 0 1600px'
        }
        if (options.snap) {
            container.style.scrollSnapType = options.snap === 'none' ? 'none' : 'y ' + options.snap
            inner.style.cssText = 'width:200px;height:1600px'
            for (let i = 0; i < 16; i++) {
                make('span', 'display:block;height:100px;scroll-snap-align:start;pointer-events:none', inner)
            }
        }
        container.scrollTo({
            left: options.rtl || options.reverse === 'row-reverse' ? -400 : 400,
            top: options.reverse === 'column-reverse' ? -400 : 400,
            behavior: 'instant',
        })
        if (options.start === 'end') {
            container.scrollTo({
                left: options.axis === 'x' ? (options.rtl || options.reverse === 'row-reverse' ? -1e7 : 1e7) : 0,
                top: options.axis === 'x' ? 0 : options.reverse === 'column-reverse' ? -1e7 : 1e7,
                behavior: 'instant',
            })
        }
    }
    if (options.kind !== 'body') {
        outer.scrollTo({
            left: options.kind === 'slot' ? 0 : 400,
            top: options.kind === 'slot' ? 0 : 400,
            behavior: 'instant',
        })
    }
    if (options.kind === 'cb' && inner.offsetParent) {
        const rect = inner.getBoundingClientRect()
        inner.style.left = `${parseFloat(inner.style.left) + 90 - rect.x}px`
        inner.style.top = `${parseFloat(inner.style.top) + 90 - rect.y}px`
    }
    const replacement = make(
        'div',
        'position:absolute;left:700px;top:0;width:200px;height:100px;overflow:auto',
        document.body
    )
    make('span', 'display:block;width:1600px;height:1600px', replacement)
    const events = []
    const controlEvents = []
    const probes = []
    const measure = () => {
        const Timeline = window.ScrollTimeline
        const timeline = Timeline ? new Timeline({ source: container, axis: options.axis === 'x' ? 'x' : 'y' }) : null
        const time = () => timeline?.currentTime?.value ?? null
        const immediate = time()
        const rect = container.getBoundingClientRect()
        const style = getComputedStyle(container)
        return {
            time: performance.now(),
            position: [container.scrollLeft, container.scrollTop],
            dimensions: [container.scrollWidth, container.clientWidth, container.scrollHeight, container.clientHeight],
            rect: [rect.x, rect.y, rect.width, rect.height],
            cssSize: [style.width, style.height],
            zoom: container.currentCSSZoom,
            timelineImmediate: immediate,
            timelineAfterLayout: time(),
        }
    }
    const controller = new AbortController()
    document.addEventListener(
        'wheel',
        (event) => {
            if (options.boundaryProbe) {
                probes.push({ phase: 'wheel', ...measure() })
                window.queueMicrotask(() => probes.push({ phase: 'microtask', ...measure() }))
                window.requestAnimationFrame(() => probes.push({ phase: 'frame', ...measure() }))
            }
            events.push({
                trusted: event.isTrusted,
                target: event.composedPath()[0]?.id,
                deltaX: event.deltaX,
                deltaY: event.deltaY,
                ctrlKey: event.ctrlKey,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
                metaKey: event.metaKey,
            })
            if (options.mutation === 'cancel-remove' || options.state === 'prevent') {
                event.preventDefault()
            }
            if (options.mutation === 'remove-target' || options.mutation === 'cancel-remove') {
                inner.remove()
            }
            if (options.mutation === 'remove-container') {
                container.remove()
            }
            if (options.mutation === 'reparent') {
                replacement.append(inner)
            }
            if (options.mutation === 'self-scroll') {
                container.scrollTop += 17
            }
            if (options.replaceChild) {
                const next = inner.cloneNode(true)
                inner.replaceWith(next)
                inner = next
                window.__c31f6.inner = inner
            }
            if (options.selfScroll) {
                container.scrollBy({ top: options.selfScroll, behavior: 'instant' })
            }
            if (options.eventBoundary) {
                container.style[options.axis === 'x' ? 'width' : 'height'] =
                    options.axis === 'x' ? '269.8px' : '149.8px'
                const position = options.eventBoundary === 'inside' ? 400 : 1e7
                container.scrollTo({
                    left: options.axis === 'x' ? position : 0,
                    top: options.axis === 'x' ? 0 : position,
                    behavior: 'instant',
                })
            }
            if (options.preventModifier && (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey)) {
                event.preventDefault()
            }
        },
        { passive: false, signal: controller.signal }
    )
    for (const type of ['input', 'change']) {
        document.addEventListener(
            type,
            (event) => {
                controlEvents.push({
                    type,
                    trusted: event.isTrusted,
                    value: container.value,
                    inputType: event.inputType,
                    eventClass: event.constructor.name,
                    bubbles: event.bubbles,
                    cancelable: event.cancelable,
                    composed: event.composed,
                })
            },
            { signal: controller.signal }
        )
    }
    if (options.eventBoundary) {
        await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))
    }
    const rect = (
        ['cb', 'slot', 'foreignObject-cb'].includes(options.kind)
            ? inner
            : ['math', 'svg', 'foreignObject', 'foreignObject-self'].includes(options.kind)
              ? outer
              : container
    ).getBoundingClientRect()
    const point = { x: rect.x + 30, y: rect.y + 30 }
    window.__c31f6 = { outer, container, inner, middle, replacement, events, controlEvents, controller, point, probes }
    if (options.boundaryProbe) {
        probes.push({ phase: 'setup', ...measure() })
    }
    const hit = document.elementFromPoint(point.x, point.y)
    const deepHit = hit?.shadowRoot?.elementFromPoint(point.x, point.y) ?? hit
    return {
        point,
        hit: deepHit?.id,
        offsetParent: inner.offsetParent?.id,
        display: getComputedStyle(container).display,
        overflow: getComputedStyle(container).overflowX,
        zoom: container.currentCSSZoom,
        snapType: getComputedStyle(container).scrollSnapType,
        snapItemHeights: options.snap ? Array.from(inner.children, (node) => node.getBoundingClientRect().height) : [],
        compatMode: document.compatMode,
        selection: [container.selectionStart, container.selectionEnd],
        bodyRects: document.body.getClientRects().length,
        bodyClient: [document.body.clientWidth, document.body.clientHeight],
    }
}

export function read() {
    const s = window.__c31f6
    const pos = (node) => (node ? [node.scrollLeft, node.scrollTop] : [0, 0])
    return {
        container: pos(s.container),
        outer: pos(s.outer),
        middle: pos(s.middle),
        replacement: pos(s.replacement),
        viewport: [scrollX, scrollY],
        events: [...s.events],
        value: s.container.value,
        focused: document.activeElement === s.container,
        controlEvents: [...s.controlEvents],
        probes: [...s.probes],
        remainder: window.__mcpWheelState?.remainders.get(s.container),
    }
}
