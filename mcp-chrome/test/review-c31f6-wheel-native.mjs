/* global document, window, getComputedStyle, scrollX, scrollY, DOMMatrix, DOMPoint */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cases, configure, read } from './review-c31f6-wheel-fixtures.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const chromePath = process.argv[2]
if (!chromePath) {
    throw new Error('Usage: node test/review-c31f2-native.mjs CHROME_PATH [OUTPUT_JSON]')
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-c31f2-wheel-'))
const output = process.argv[3] ? path.resolve(process.argv[3]) : path.join(work, 'results.json')
const extension = path.join(work, 'extension')
fs.mkdirSync(extension)
fs.writeFileSync(
    path.join(extension, 'manifest.json'),
    JSON.stringify({
        manifest_version: 3,
        name: 'Isolated wheel regression',
        version: '1.0.0',
        permissions: ['tabs', 'scripting', 'storage', 'webNavigation', 'debugger'],
        host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'],
        background: { service_worker: 'review.js', type: 'module' },
    })
)
const { build } = await import(pathToFileURL(path.join(root, 'extension/node_modules/vite/dist/node/index.js')))
await build({
    configFile: false,
    plugins: process.env.C31F6_BEFORE
        ? [
              {
                  name: 'before-control',
                  load(id) {
                      const relative = path.relative(root, id)
                      const before = path.join(process.env.C31F6_BEFORE, relative)
                      if (!relative.startsWith('test/') && fs.existsSync(before) && fs.statSync(before).isFile()) {
                          return fs.readFileSync(before, 'utf8')
                      }
                  },
              },
          ]
        : [],
    logLevel: 'warn',
    build: {
        outDir: extension,
        emptyOutDir: false,
        minify: false,
        lib: {
            entry: path.join(root, 'test/review-c31f6-extension.ts'),
            formats: ['es'],
            fileName: () => 'review.js',
        },
    },
})
const http = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(
        request.url.startsWith('/child')
            ? (request.url.includes('quirks') ? '' : '<!doctype html>') + '<title>Wheel child</title><body></body>'
            : '<!doctype html><title>Isolated wheel check</title><iframe id="owned" src="/child" style="position:absolute;top:350px;left:0;width:440px;height:230px"></iframe>'
    )
})
await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${http.address().port}`
const chrome = spawn(
    chromePath,
    [
        '--headless=new',
        '--no-sandbox',
        '--window-size=1100,1000',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-proxy-server',
        '--remote-debugging-pipe',
        '--enable-unsafe-extension-debugging',
        `--user-data-dir=${path.join(work, 'profile')}`,
        base + '/',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] }
)
const stderr = fs.createWriteStream(path.join(work, 'chrome.log'), { mode: 0o600 })
chrome.stderr.pipe(stderr)
let sequence = 0
let nativeProtocolDispatches = 0
let buffer = ''
const pending = new Map()
chrome.stdio[4].on('data', (data) => {
    buffer += data.toString()
    let end
    while ((end = buffer.indexOf('\0')) >= 0) {
        const raw = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!raw) {
            continue
        }
        const message = JSON.parse(raw)
        const call = pending.get(message.id)
        if (call) {
            pending.delete(message.id)
            clearTimeout(call.timer)
            if (message.error) {
                call.reject(new Error(JSON.stringify(message.error)))
            } else {
                call.resolve(message.result)
            }
        }
    }
})
function send(method, params = {}, sessionId) {
    if (method.startsWith('Input.dispatch')) {
        ++nativeProtocolDispatches
    }
    return new Promise((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error(`Native CDP timeout: ${method}`))
        }, 15000)
        pending.set(id, { resolve, reject, timer })
        chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
    })
}
async function poll(read, predicate) {
    const deadline = Date.now() + 7000
    while (Date.now() < deadline) {
        const value = await read()
        if (predicate(value)) {
            return value
        }
        await delay(20)
    }
    throw new Error('Native fixture condition did not arrive')
}
const result = {
    status: 'running',
    checks: [],
    handlerCalls: 0,
    nativeReferences: 0,
    nativeWheelReferences: 0,
    nativeGeometryReferences: 0,
    sdkCalls: 0,
    work,
    boundary:
        'installed isolated Extension, production schemas/handlers and real Chrome scripting/CDP APIs; direct handler entry, no SDK or Bridge',
}
try {
    result.browser = await send('Browser.getVersion')
    const loaded = await send('Extensions.loadUnpacked', { path: extension })
    const worker = await poll(
        async () =>
            (await send('Target.getTargets')).targetInfos.find(
                (t) => t.type === 'service_worker' && t.url.includes(loaded.id)
            ),
        Boolean
    )
    const { sessionId: workerSession } = await send('Target.attachToTarget', {
        targetId: worker.targetId,
        flatten: true,
    })
    const evaluate = async (expression) => {
        const value = await send(
            'Runtime.evaluate',
            { expression, awaitPromise: true, returnByValue: true },
            workerSession
        )
        if (value.exceptionDetails) {
            throw new Error(JSON.stringify(value.exceptionDetails))
        }
        return value.result.value
    }
    await poll(() => evaluate('Boolean(globalThis.c31f6)'), Boolean)
    const tab = await poll(async () => (await evaluate('c31f6.tabs()')).find((t) => t.url === base + '/'), Boolean)
    await evaluate(`c31f6.adopt(${tab.id})`)
    const page = (await send('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && t.url === base + '/')
    const { sessionId: pageSession } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    const script = (expression) => evaluate(`c31f6.script(${tab.id},0,${JSON.stringify(expression)})`)
    let wheelFrameId = 0
    const wheelScript = (expression) =>
        evaluate(`c31f6.script(${tab.id},${wheelFrameId},${JSON.stringify(expression)})`)
    const setup = async (options) => {
        const controlRenderPhase = options.eventBoundary && process.env.C31F7_WHEEL_PHASE_CONTROL === '1'
        if (controlRenderPhase) {
            await send('Emulation.setVirtualTimePolicy', { policy: 'advance' }, pageSession)
        }
        const layout = await wheelScript(`(${configure.toString()})(${JSON.stringify(options)})`)
        if (controlRenderPhase) {
            await send('Emulation.setVirtualTimePolicy', { policy: 'pause' }, pageSession)
        }
        return layout
    }
    const readState = () => wheelScript(`(${read.toString()})()`)
    const command = (params) =>
        evaluate(`c31f6.command('input_mouse',${JSON.stringify({ tabId: tab.id, frameId: wheelFrameId, ...params })})`)
    const resetFraction = async (options, step) => {
        if (!options.reset || step !== 2) {
            return
        }
        const expressions = {
            position: 's.container.scrollTop=500',
            target: 's.inner.replaceWith(s.inner.cloneNode(true));s.inner=s.container.querySelector("#inner")',
            zoom: 's.container.style.zoom="2";s.container.style.left="210px";s.container.style.top="210px"',
            boundary: 's.container.scrollTop=s.container.scrollHeight-s.container.clientHeight',
        }
        await wheelScript(`(() => { const s=window.__c31f6;${expressions[options.reset]};return true })()`)
    }
    const settle = async (options, samples) => {
        if (!options.stableSnap) {
            await delay(160)
            return readState()
        }
        const start = Date.now()
        await delay(800)
        let previous,
            stable = 0
        while (Date.now() - start < 6000) {
            const state = await readState()
            const positions = Object.fromEntries(
                ['container', 'outer', 'middle', 'replacement', 'viewport'].map((key) => [key, state[key]])
            )
            const signature = JSON.stringify(positions)
            stable = signature === previous ? stable + 1 : 1
            previous = signature
            samples.push({ elapsedMs: Date.now() - start, positions, stable })
            if (stable >= 8) {
                return state
            }
            await delay(100)
        }
        throw new Error('Snap endpoint did not produce eight stable samples after 800ms')
    }
    for (const options of cases({
        boundaryObservations: process.env.C31F7_BOUNDARY_OBSERVATIONS === '1',
    }).filter(
        (options) => !process.env.C31F6_CASE_FILTER || new RegExp(process.env.C31F6_CASE_FILTER).test(options.id)
    )) {
        const check = {
            kind: 'wheel',
            id: options.id,
            options,
            ...(options.eventBoundary && process.env.C31F7_WHEEL_PHASE_CONTROL === '1'
                ? { renderPhaseControl: 'virtual-time-paused-during-input' }
                : {}),
        }
        try {
            wheelFrameId = 0
            if (options.frame || options.quirks) {
                const source = base + '/child?' + (options.quirks ? 'quirks-' : '') + encodeURIComponent(options.id)
                await script(
                    `(() => {document.documentElement.style.cssText='';document.body.style.cssText='margin:0';document.body.innerHTML=${JSON.stringify(`<iframe src="${source}" style="position:absolute;left:0;top:0;width:500px;height:400px;border:0;zoom:${options.frameZoom ?? 1}"></iframe>`)};window.scrollTo(0,0);return true})()`
                )
                const frames = await poll(
                    () => evaluate(`c31f6.frames(${tab.id})`),
                    (frames) => frames.some((frame) => frame.url === source)
                )
                wheelFrameId = frames.find((frame) => frame.url === source).frameId
            }
            check.layout = await setup(options)
            assert.ok(
                check.layout.point.x >= 0 &&
                    check.layout.point.y >= 0 &&
                    check.layout.point.x < 1100 &&
                    check.layout.point.y < 850,
                JSON.stringify(check.layout)
            )
            assert.equal(check.layout.hit, 'inner', `Fixture hit: ${JSON.stringify(check.layout)}`)
            const initial = await readState()
            check.initial = initial
            if (options.stableSnap) {
                assert.equal(initial.container[1], 400)
                assert.equal(check.layout.snapItemHeights.length, 16)
                assert.ok(check.layout.snapItemHeights.every((height) => height === 100))
            }
            const deltas = options.deltas ?? [options.delta ?? 120]
            check.toolSteps = []
            for (const delta of deltas) {
                if (options.freshHandler) {
                    await evaluate('c31f6.freshHandler()')
                }
                ++result.handlerCalls
                await command({
                    type: 'mouseWheel',
                    ...check.layout.point,
                    deltaX: options.axis === 'x' ? delta : 0,
                    deltaY: options.axis === 'x' ? 0 : delta,
                })
                await delay(options.interval ?? 30)
                check.toolSteps.push(await readState())
                await resetFraction(options, check.toolSteps.length - 1)
            }
            check.tool = await settle(options, (check.toolStableSamples = []))
            const reference = await setup(options)
            check.nativeSteps = []
            for (const delta of deltas) {
                ++result.nativeReferences
                ++result.nativeWheelReferences
                await send(
                    'Input.dispatchMouseEvent',
                    {
                        type: 'mouseWheel',
                        x: reference.point.x * (options.frameZoom ?? 1),
                        y: reference.point.y * (options.frameZoom ?? 1),
                        deltaX: options.axis === 'x' ? delta : 0,
                        deltaY: options.axis === 'x' ? 0 : delta,
                    },
                    pageSession
                )
                await delay(options.interval ?? 30)
                check.nativeSteps.push(await readState())
                await resetFraction(options, check.nativeSteps.length - 1)
            }
            check.native = await settle(options, (check.nativeStableSamples = []))
            let expected = check.native
            if (options.acceptedSnap) {
                await setup(options)
                for (const delta of deltas) {
                    await wheelScript(`(() => {
                        const s=window.__c31f6, delta=${delta};
                        s.programmaticStart ??= [s.outer.scrollLeft,s.outer.scrollTop];
                        s.programmaticBoundary ??= [0,0];
                        const axis=${options.axis === 'x' ? 0 : 1}, position=axis===0?s.container.scrollLeft:s.container.scrollTop;
                        const maximum=axis===0?s.container.scrollWidth-s.container.clientWidth:s.container.scrollHeight-s.container.clientHeight;
                        if ((delta<0 && position===0)||(delta>0 && position===maximum)) s.programmaticBoundary[axis]+=delta;
                        s.container.scrollBy({left:axis===0?delta:0,top:axis===1?delta:0,behavior:'instant'});
                        s.outer.scrollTo({left:s.programmaticStart[0]+s.programmaticBoundary[0],top:s.programmaticStart[1]+s.programmaticBoundary[1],behavior:'instant'});
                        return true;
                    })()`)
                    await delay(options.interval ?? 30)
                }
                check.programmatic = await settle(options, (check.programmaticStableSamples = []))
                check.programmaticBoundaryIntent = await wheelScript('window.__c31f6.programmaticBoundary')
                check.acceptedContract = options.requireNativeEquality
                    ? 'Programmatic scrollBy endpoint and native-equivalence control'
                    : 'Programmatic scrollBy snap endpoint; native differences are recorded, not native-equivalence passes'
                expected = check.programmatic
                check.nativeDifferences = ['container', 'outer', 'middle', 'replacement', 'viewport'].filter((key) =>
                    check.tool[key].some((value, axis) => Math.abs(value - check.native[key][axis]) >= 0.02)
                )
            }
            for (const key of ['container', 'outer', 'middle', 'replacement', 'viewport']) {
                for (let axis = 0; axis < 2; axis++) {
                    if (options.mutation === 'reparent' && key !== 'replacement' && key !== 'viewport') {
                        continue
                    }
                    assert.ok(
                        Math.abs(check.tool[key][axis] - expected[key][axis]) < 0.02,
                        `${key}/${axis}: ${check.tool[key][axis]} != ${expected[key][axis]}`
                    )
                }
            }
            if (options.requireNativeEquality) {
                for (const key of ['container', 'outer', 'middle', 'replacement', 'viewport']) {
                    for (let axis = 0; axis < 2; axis++) {
                        assert.ok(
                            Math.abs(check.tool[key][axis] - check.native[key][axis]) < 0.02,
                            `Native control ${key}/${axis}: ${check.tool[key][axis]} != ${check.native[key][axis]}`
                        )
                    }
                }
            }
            if (options.inputType === 'number') {
                assert.equal(
                    check.tool.value,
                    check.native.value,
                    `number value: ${check.tool.value} != ${check.native.value}`
                )
                const semanticEvents = (events) => events.map(({ trusted: _trusted, ...event }) => event)
                assert.deepEqual(semanticEvents(check.tool.controlEvents), semanticEvents(check.native.controlEvents))
            }
            assert.equal(check.tool.events.length, deltas.length)
            assert.equal(check.native.events.length, deltas.length)
            if (process.env.WHEEL_BUSINESS_FAILURE === options.id) {
                check.controlledBusinessFailure = true
                throw new Error('Controlled business failure: ' + options.id)
            }
            check.status = 'PASS'
        } catch (error) {
            check.status = 'FAIL'
            check.error = error.message
        }
        result.checks.push(check)
    }
    const frameScript = (frameId, code) => evaluate(`c31f6.script(${tab.id},${frameId},${JSON.stringify(code)})`)
    const record = async (kind, id, run) => {
        const check = { kind, id }
        try {
            Object.assign(check, await run())
            check.status = 'PASS'
        } catch (error) {
            check.status = 'FAIL'
            check.error = error.message
        }
        result.checks.push(check)
    }
    if (!process.env.C31F6_GEOMETRY_DIAGNOSTIC && !process.env.C31F6_WHEEL_ONLY) {
        const configureEvents = () => {
            window.__c31f6?.controller.abort()
            document.documentElement.style.cssText = ''
            document.body.style.cssText = 'margin:0;min-height:2400px'
            document.body.innerHTML =
                '<input type="checkbox" id="pad" style="position:absolute;left:80px;top:60px;width:120px;height:100px"><button id="disabled" disabled style="position:absolute;left:260px;top:60px">disabled</button>'
            window.scrollTo(0, 0)
            window.__mcpElementMap = {
                pad: new WeakRef(document.getElementById('pad')),
                disabled: new WeakRef(document.getElementById('disabled')),
            }
            window.__c31f6Events = []
            for (const type of [
                'wheel',
                'pointermove',
                'mousemove',
                'mousedown',
                'mouseup',
                'click',
                'contextmenu',
                'touchstart',
                'touchend',
            ]) {
                document.addEventListener(
                    type,
                    (event) => {
                        window.__c31f6Events.push({
                            type,
                            target: event.composedPath()[0].id,
                            x: event.clientX ?? event.changedTouches?.[0]?.clientX,
                            y: event.clientY ?? event.changedTouches?.[0]?.clientY,
                            altKey: event.altKey,
                            ctrlKey: event.ctrlKey,
                            metaKey: event.metaKey,
                            shiftKey: event.shiftKey,
                            trusted: event.isTrusted,
                        })
                        if (type === 'wheel') {
                            event.preventDefault()
                        }
                    },
                    { passive: false }
                )
            }
            return true
        }
        await script(`(${configureEvents.toString()})()`)
        for (const mask of [0, 1, 2, 4, 8, 10]) {
            for (const [action, params] of [
                ['input_mouse', { type: 'mouseWheel', x: 140, y: 110, deltaY: 120 }],
                ['stealth_mouse', { type: 'mousemove', x: 140, y: 110 }],
                ['stealth_mouse', { type: 'mousedown', x: 140, y: 110 }],
                ['stealth_mouse', { type: 'mouseup', x: 140, y: 110 }],
                ['stealth_click', { x: 140, y: 110 }],
                ['stealth_click', { x: 140, y: 110, button: 'right' }],
                ['click', { refId: 'pad' }],
                ['actionable_click', { refId: 'pad', force: true }],
                ['actionable_click', { refId: 'pad' }],
            ]) {
                await record(
                    'modifiers',
                    `${action}-${params.type ?? params.button ?? params.force ?? 'left'}-${mask}`,
                    async () => {
                        await script('window.__c31f6Events=[]')
                        ++result.handlerCalls
                        await evaluate(
                            `c31f6.command(${JSON.stringify(action)},${JSON.stringify({ tabId: tab.id, frameId: 0, ...params, modifiers: mask })})`
                        )
                        const events = await script('window.__c31f6Events')
                        assert.ok(events.length > 0)
                        for (const event of events) {
                            assert.equal(event.target, 'pad')
                            for (const [name, bit] of [
                                ['altKey', 1],
                                ['ctrlKey', 2],
                                ['metaKey', 4],
                                ['shiftKey', 8],
                            ]) {
                                assert.equal(event[name], Boolean(mask & bit), `${name}: ${JSON.stringify(event)}`)
                            }
                        }
                        assert.equal(
                            await evaluate(`c31f6.attached(${tab.id})`),
                            false,
                            'Synthetic paths must not attach debugger'
                        )
                        return { mask, events }
                    }
                )
            }
        }
        for (const mask of [0, 8]) {
            await record('default-activation', `click-default-${mask}`, async () => {
                await script('(document.getElementById("pad").checked=false,window.__c31f6Events=[])')
                await evaluate(
                    `c31f6.command('click',${JSON.stringify({ tabId: tab.id, refId: 'pad', modifiers: mask })})`
                )
                assert.equal(await script('document.getElementById("pad").checked'), true)
                await script('window.__c31f6Events=[]')
                await evaluate(
                    `c31f6.command('click',${JSON.stringify({ tabId: tab.id, refId: 'disabled', modifiers: mask })})`
                )
                assert.deepEqual(await script('window.__c31f6Events'), [])
            })
        }
        for (const code of [
            '(() => {throw new Error("Execution context was destroyed")})()',
            'Promise.reject(null)',
            'Promise.reject("page rejection")',
            '(() => {throw {toString(){throw new Error("conversion")}}})()',
        ]) {
            await record('page-errors', code, async () => {
                const value = await evaluate(`c31f6.evaluate(${JSON.stringify({ tabId: tab.id, code })})`)
                assert.equal(value.success, false)
                assert.equal(value.errorSource, 'page')
                assert.ok(typeof value.error === 'string' && value.error.length > 0)
                return { value }
            })
        }
        const pointInParent = (point) => {
            const frame = document.getElementById('geometry')
            const style = getComputedStyle(frame)
            const origin = style.transformOrigin.split(' ').map(Number.parseFloat)
            const matrix = new DOMMatrix(style.transform === 'none' ? undefined : style.transform)
            const result = matrix.transformPoint(
                new DOMPoint(point.x + frame.clientLeft - origin[0], point.y + frame.clientTop - origin[1])
            )
            const zoom = frame.currentCSSZoom ?? 1
            return {
                x: zoom * (frame.offsetLeft + origin[0] + result.x) - scrollX,
                y: zoom * (frame.offsetTop + origin[1] + result.y) - scrollY,
            }
        }
        for (const options of [
            { id: 'plain' },
            { id: 'shadow-frame', shadow: true },
            { id: 'translate', transform: 'translate(40px,30px)' },
            { id: 'scale', transform: 'scale(2)' },
            {
                id: 'origin-border-rotate-skew',
                border: 9,
                origin: '70% 30%',
                transform: 'rotate(12deg) skewX(8deg) scale(.9,1.1)',
            },
            { id: 'reflection', border: 4, origin: '50% 50%', transform: 'scale(-1,1)' },
            { id: 'nested-local', nested: true },
            { id: 'nested-oopif', nested: true, remote: true },
            { id: 'oopif', remote: true },
            { id: 'zoom-nested', nested: true, zoom: 2, innerSimple: true, transform: 'none', border: 0 },
            {
                id: 'zoom-nested-composed',
                nested: true,
                zoom: 1.5,
                innerZoom: 1.25,
                innerSimple: true,
                transform: 'rotate(8deg) skewX(5deg)',
                border: 7,
                origin: '40% 20%',
            },
            {
                id: 'zoom-oopif-nested',
                nested: true,
                remote: true,
                zoom: 2,
                innerSimple: true,
                transform: 'none',
                border: 0,
            },
            {
                id: 'zoom-local-then-oopif',
                nested: true,
                innerRemote: true,
                zoom: 2,
                innerSimple: true,
                transform: 'none',
                border: 0,
            },
            { id: 'after-scroll', scroll: true, transform: 'scale(1.3)' },
            { id: 'singular', transform: 'scale(0)', fails: true },
            { id: 'perspective', transform: 'perspective(500px) rotateY(35deg)', fails: true },
            { id: 'zero-size', zero: true, fails: true },
            { id: 'stale-document', stale: true, fails: true },
        ]) {
            await record('geometry', options.id, async () => {
                const source = (options.remote ? base.replace('127.0.0.1', 'localhost') : base) + '/child?' + options.id
                await script(
                    `(() => {document.documentElement.style.cssText='';document.body.style.cssText='margin:0;min-height:2400px';document.body.innerHTML=${JSON.stringify(`<iframe id="geometry" src="${source}" style="position:absolute;left:100px;top:${options.scroll ? 1200 : 100}px;width:${options.zero ? 0 : 400}px;height:${options.zero ? 0 : 300}px;border:${options.border ?? (options.nested ? 11 : 0)}px solid;zoom:${options.zoom ?? 1};transform-origin:${options.origin ?? '0 0'};transform:${options.transform ?? (options.nested ? 'matrix(1.2,.2,-.1,1.1,0,0)' : 'none')}"></iframe>`)};window.scrollTo(0,0);return true})()`
                )
                const frames = await poll(
                    () => evaluate(`c31f6.frames(${tab.id})`),
                    (values) => values.some((f) => f.parentFrameId === 0 && f.url === source)
                )
                const first = frames.find((f) => f.parentFrameId === 0 && f.url === source)
                let selected = first
                if (options.nested) {
                    const nestedSource =
                        (options.innerRemote ? base.replace('127.0.0.1', 'localhost') : base) +
                        '/child?nested-' +
                        options.id
                    await frameScript(
                        first.frameId,
                        `(() => {document.body.style.cssText='margin:0';document.body.innerHTML=${JSON.stringify(`<iframe id="geometry" src="${nestedSource}" style="position:absolute;left:${options.innerSimple ? 20 : 40}px;top:${options.innerSimple ? 20 : 50}px;width:240px;height:200px;border:${options.innerSimple ? 0 : 7}px solid;zoom:${options.innerZoom ?? 1};transform-origin:0 0;transform:${options.innerSimple ? 'scale(.8)' : 'matrix(.8,.1,.2,.9,0,0)'}"></iframe>`)};return true})()`
                    )
                    selected = (
                        await poll(
                            () => evaluate(`c31f6.frames(${tab.id})`),
                            (values) => values.some((f) => f.parentFrameId === first.frameId && f.url === nestedSource)
                        )
                    ).find((f) => f.parentFrameId === first.frameId && f.url === nestedSource)
                }
                await frameScript(selected.frameId, `(${configureEvents.toString()})()`)
                if (options.shadow) {
                    await frameScript(
                        selected.frameId,
                        '(() => { const pad=document.getElementById("pad"),host=document.createElement("div");host.style.cssText="position:absolute;left:0;top:0;width:300px;height:200px";document.body.append(host);host.attachShadow({mode:"open"}).append(pad);window.__mcpElementMap.pad=new WeakRef(pad);return true })()'
                    )
                }
                if (options.scroll) {
                    await script(
                        'document.getElementById("geometry").scrollIntoView({block:"center",behavior:"instant"})'
                    )
                }
                const query = await evaluate(
                    `c31f6.command('evaluate_in_frame',${JSON.stringify({ tabId: tab.id, frameId: selected.frameId, expression: '({url:location.href,marked:globalThis.__c31f6Events!==undefined})', timeout: 5000 })})`
                )
                assert.equal(query.result?.value?.url, selected.url)
                assert.equal(query.result?.value?.marked, true)
                assert.equal(query.retryAttempted, false)
                let expected = { x: 140, y: 110 }
                if (options.nested) {
                    expected = await frameScript(
                        first.frameId,
                        `(${pointInParent.toString()})(${JSON.stringify(expected)})`
                    )
                }
                expected = await script(`(${pointInParent.toString()})(${JSON.stringify(expected)})`)
                const params = {
                    tabId: tab.id,
                    frameId: selected.frameId,
                    documentId: options.stale ? 'stale' : selected.documentId,
                    coordinateSpace: 'frame',
                    type: 'mouseMoved',
                    x: 140,
                    y: 110,
                }
                if (options.fails) {
                    const beforeDispatches = await evaluate('c31f6.counts().nativeInputDispatches ?? 0')
                    let failure
                    try {
                        await command(params)
                    } catch (error) {
                        failure = error.message
                    }
                    assert.ok(failure?.includes('FRAME_GEOMETRY_UNAVAILABLE'), failure)
                    assert.deepEqual(await frameScript(selected.frameId, 'window.__c31f6Events'), [])
                    const afterDispatches = await evaluate('c31f6.counts().nativeInputDispatches ?? 0')
                    assert.equal(afterDispatches, beforeDispatches)
                    return {
                        options,
                        selected,
                        failure,
                        nativeDispatches: afterDispatches - beforeDispatches,
                        zeroDispatch: true,
                    }
                }
                await frameScript(
                    selected.frameId,
                    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))'
                )
                await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 800 }, pageSession)
                ++result.nativeGeometryReferences
                ++result.nativeReferences
                await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...expected }, pageSession)
                await delay(30)
                const native = await frameScript(selected.frameId, 'window.__c31f6Events')
                assert.equal(native.at(-1)?.target, 'pad', JSON.stringify({ expected, native }))
                await frameScript(selected.frameId, 'window.__c31f6Events=[]')
                ++result.handlerCalls
                await command(params)
                await delay(30)
                const tool = await frameScript(selected.frameId, 'window.__c31f6Events')
                assert.equal(tool.at(-1)?.target, 'pad', JSON.stringify({ expected, native, tool }))
                const nativePoint = native.find((event) => event.type === 'pointermove')
                const toolPoint = tool.find((event) => event.type === 'pointermove')
                assert.ok(nativePoint && toolPoint)
                assert.ok(
                    Math.abs(toolPoint.x - 140) < 0.05 && Math.abs(toolPoint.y - 110) < 0.05,
                    JSON.stringify({ expected, native, tool })
                )
                // offset/client metrics round fractional-zoom borders; retain the independent native point as observed
                assert.ok(
                    Math.abs(nativePoint.x - 140) < 1 && Math.abs(nativePoint.y - 110) < 1,
                    JSON.stringify({ expected, native, tool })
                )
                await frameScript(selected.frameId, 'window.__c31f6Events=[]')
                await command({ ...params, coordinateSpace: undefined, ...expected })
                await delay(20)
                const legacy = await frameScript(selected.frameId, 'window.__c31f6Events')
                assert.equal(legacy.at(-1)?.target, 'pad')
                await frameScript(selected.frameId, 'window.__c31f6Events=[]')
                await evaluate(
                    `c31f6.inputTouch(${JSON.stringify({ tabId: tab.id, frameId: selected.frameId, documentId: selected.documentId, modifiers: 10, type: 'touchStart', touchPoints: [{ x: 140, y: 110 }] })})`
                )
                await evaluate(
                    `c31f6.inputTouch(${JSON.stringify({ tabId: tab.id, frameId: selected.frameId, documentId: selected.documentId, modifiers: 10, type: 'touchEnd', touchPoints: [] })})`
                )
                const touch = await frameScript(selected.frameId, 'window.__c31f6Events')
                assert.equal(touch[0]?.target, 'pad')
                assert.equal(touch[0]?.x, 140)
                assert.equal(touch[0]?.ctrlKey, true)
                assert.equal(touch[0]?.shiftKey, true)
                if (options.shadow || options.id === 'nested-oopif') {
                    for (const mask of [0, 1, 2, 4, 8, 10]) {
                        for (const [action, event] of [
                            ['input_mouse', { type: 'mouseWheel', deltaY: 120, x: 140, y: 110 }],
                            ['stealth_mouse', { type: 'mouseup', button: 'right', x: 140, y: 110 }],
                            ['stealth_click', { button: 'right', x: 140, y: 110 }],
                            ['click', { refId: 'pad' }],
                            ['actionable_click', { refId: 'pad', force: true }],
                        ]) {
                            await record('frame-modifiers', `${options.id}-${action}-${mask}`, async () => {
                                await frameScript(selected.frameId, 'window.__c31f6Events=[]')
                                await evaluate(
                                    `c31f6.command(${JSON.stringify(action)},${JSON.stringify({ tabId: tab.id, frameId: selected.frameId, documentId: selected.documentId, ...event, modifiers: mask })})`
                                )
                                const events = await frameScript(selected.frameId, 'window.__c31f6Events')
                                assert.ok(events.length > 0)
                                for (const event of events) {
                                    assert.equal(event.target, 'pad')
                                    for (const [name, bit] of [
                                        ['altKey', 1],
                                        ['ctrlKey', 2],
                                        ['metaKey', 4],
                                        ['shiftKey', 8],
                                    ]) {
                                        assert.equal(event[name], Boolean(mask & bit))
                                    }
                                }
                                return { events }
                            })
                        }
                    }
                }
                let preciseModifiers
                if (options.id === 'plain') {
                    await frameScript(selected.frameId, 'window.__c31f6Events=[]')
                    await command({ ...params, type: 'mousePressed', button: 'left', modifiers: 10 })
                    await command({ ...params, type: 'mouseReleased', button: 'left', modifiers: 10 })
                    preciseModifiers = await frameScript(selected.frameId, 'window.__c31f6Events')
                    assert.ok(preciseModifiers.some((event) => event.type === 'mousedown'))
                    for (const event of preciseModifiers) {
                        assert.equal(event.target, 'pad')
                        assert.equal(event.ctrlKey, true)
                        assert.equal(event.shiftKey, true)
                        assert.equal(event.trusted, true)
                    }
                }
                return { options, expected, selected, native, tool, legacy, touch, preciseModifiers, query }
            })
        }
    }
    if (process.env.C31F6_GEOMETRY_DIAGNOSTIC) {
        result.geometryDiagnostics = []
        const debug = (method, params = {}, sessionId) =>
            evaluate(
                `c31f6.debug(${tab.id},${JSON.stringify(method)},${JSON.stringify(params)},${JSON.stringify(sessionId)})`
            )
        const frameScript = (frameId, code) => evaluate(`c31f6.script(${tab.id},${frameId},${JSON.stringify(code)})`)
        for (const remote of [false, true]) {
            const observation = { remote }
            const source = remote ? base.replace('127.0.0.1', 'localhost') : base
            await script(
                `(() => { document.body.style.cssText='margin:0';document.body.innerHTML='<iframe id="geometry" src="${source}/child" style="position:absolute;left:100px;top:100px;width:300px;height:250px;border:11px solid;transform-origin:0 0;transform:matrix(1.2,.2,-.1,1.1,0,0)"></iframe>';return true })()`
            )
            const frames = await poll(
                () => evaluate(`c31f6.frames(${tab.id})`),
                (values) => values.length === 2 && values.some((f) => f.url === source + '/child')
            )
            const child = frames.find((f) => f.frameId !== 0)
            observation.child = child
            await frameScript(
                child.frameId,
                `(() => { document.body.style.cssText='margin:0';document.body.innerHTML='<iframe id="nested" src="${base}/child" style="position:absolute;left:40px;top:50px;width:140px;height:120px;border:7px solid;transform-origin:0 0;transform:matrix(.8,.1,.2,.9,0,0)"></iframe>';return true })()`
            )
            await poll(
                () => evaluate(`c31f6.frames(${tab.id})`),
                (values) => values.length === 3
            )
            observation.sessions = await evaluate(`c31f6.sessions(${tab.id})`)
            observation.trees = []
            for (const target of observation.sessions) {
                observation.trees.push({ target, ...(await debug('Page.getFrameTree', {}, target.sessionId)) })
            }
            observation.rootTree = observation.trees[0]
            const first =
                observation.rootTree.frameTree.childFrames?.[0] ??
                observation.trees.find((t) => t.frameTree.frame.parentId === observation.rootTree.frameTree.frame.id)
                    ?.frameTree
            const owner = await debug('DOM.getFrameOwner', { frameId: first.frame.id })
            observation.firstQuad = await debug('DOM.getBoxModel', { backendNodeId: owner.backendNodeId })
            observation.childTree = observation.trees.find((t) => t.frameTree.frame.id === first.frame.id)
            observation.childSession = observation.childTree?.target.sessionId
            const nested =
                (observation.childTree?.frameTree ?? first).childFrames?.[0] ??
                observation.trees.find((t) => t.frameTree.frame.parentId === first.frame.id)?.frameTree
            if (nested) {
                const owner = await debug('DOM.getFrameOwner', { frameId: nested.frame.id }, observation.childSession)
                observation.nestedQuad = await debug(
                    'DOM.getBoxModel',
                    { backendNodeId: owner.backendNodeId },
                    observation.childSession
                )
            }
            result.geometryDiagnostics.push(observation)
        }
    }
    result.entryCounts = await evaluate('c31f6.counts()')
    result.handlerCalls = Object.entries(result.entryCounts)
        .filter(([kind]) => !['layoutScript', 'nativeInputDispatches'].includes(kind))
        .reduce((total, [, count]) => total + count, 0)
    result.nativeProtocolDispatches = nativeProtocolDispatches
    result.semanticPartitions = result.checks.reduce((groups, check) => {
        const kind = check.kind ?? 'wheel'
        groups[kind] ??= { total: 0, passed: 0 }
        ++groups[kind].total
        if (check.status === 'PASS') {
            ++groups[kind].passed
        }
        return groups
    }, {})
    result.status = result.checks.some((c) => c.status === 'FAIL') ? 'FAIL' : 'PASS'
} catch (error) {
    result.status = 'FAIL'
    result.error = { message: error.message, stack: error.stack }
} finally {
    const errors = []
    result.cleanupAttempts = []
    const cleanup = async (name, close) => {
        result.cleanupAttempts.push(name)
        try {
            await close()
            if (process.env.WHEEL_CLEANUP_FAILURE === name) {
                throw new Error('Controlled cleanup failure: ' + name)
            }
        } catch (error) {
            errors.push({ resource: name, error: String(error) })
        }
    }
    await cleanup('chrome', async () => {
        if (chrome.exitCode === null && chrome.signalCode === null) {
            const exited = once(chrome, 'exit')
            chrome.kill('SIGTERM')
            await Promise.race([exited, delay(3000)])
            if (chrome.exitCode === null && chrome.signalCode === null) {
                chrome.kill('SIGKILL')
                await exited
            }
        }
    })
    await cleanup('http', async () => {
        http.closeAllConnections()
        await new Promise((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())))
    })
    await cleanup('log', async () => {
        const closed = finished(stderr)
        stderr.end()
        await closed
    })
    await cleanup('pipe', () => {
        for (const call of pending.values()) {
            clearTimeout(call.timer)
            call.reject(new Error('Native test cleanup'))
        }
        pending.clear()
    })
    await cleanup('profile', () => fs.rmSync(path.join(work, 'profile'), { recursive: true }))
    if (errors.length) {
        result.cleanupErrors = errors
        result.businessStatus = result.status
        result.status = 'ERROR'
    }
    result.resources = {
        chromeExited: chrome.exitCode !== null || chrome.signalCode !== null,
        pipePending: pending.size,
        httpListening: http.listening,
        logClosed: stderr.closed,
        profileRemoved: !fs.existsSync(path.join(work, 'profile')),
    }
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
    console.log(
        JSON.stringify(
            {
                status: result.status,
                cases: result.checks.length,
                failed: result.checks.filter((c) => c.status === 'FAIL').map((c) => ({ id: c.id, error: c.error })),
                output,
                error: result.error,
            },
            null,
            2
        )
    )
    if (result.status !== 'PASS') {
        process.exitCode = 1
    }
}
