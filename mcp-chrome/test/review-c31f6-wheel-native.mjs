/* global document, window, getComputedStyle, scrollX, scrollY, DOMMatrix, DOMPoint */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cases, configure, read } from './review-c31f6-wheel-fixtures.mjs'
import { configureWheelFixture, readWheelFixture } from './review-c31f2-wheel-fixtures.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const chromePath = process.argv[2]
if (!chromePath) {
    throw new Error('Usage: node test/review-c31f6-wheel-native.mjs CHROME_PATH [OUTPUT_JSON]')
}
const phaseControl = process.env.C31F7_WHEEL_PHASE_CONTROL === '1'
const wheelCases = cases({
    boundaryObservations: process.env.C31F7_BOUNDARY_OBSERVATIONS === '1',
    remaining: process.env.C31F6_REMAINING === '1',
}).filter((options) => !process.env.C31F6_CASE_FILTER || new RegExp(process.env.C31F6_CASE_FILTER).test(options.id))
if (
    phaseControl &&
    (process.env.C31F6_WHEEL_ONLY !== '1' ||
        process.env.C31F6_GEOMETRY_DIAGNOSTIC ||
        wheelCases.length === 0 ||
        wheelCases.some((options) => !options.eventBoundary))
) {
    throw new Error(
        'C31F7_WHEEL_PHASE_CONTROL=1 requires C31F6_WHEEL_ONLY=1, no C31F6_GEOMETRY_DIAGNOSTIC, ' +
            'and a nonempty C31F6_CASE_FILTER selection containing only eventBoundary cases; ' +
            'use C31F7_BOUNDARY_OBSERVATIONS=1 and C31F6_CASE_FILTER=^c31f7-boundary-listener- in a separate process'
    )
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
                          return fs.readFileSync(before, { encoding: 'utf8' })
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
const http = createServer(
    /**
     * @param {import('node:http').IncomingMessage} request
     * @param {import('node:http').ServerResponse} response
     */
    (request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(
            request.url.startsWith('/child')
                ? (request.url.includes('quirks') ? '' : '<!doctype html>') + '<title>Wheel child</title><body></body>'
                : '<!doctype html><title>Isolated wheel ' +
                      'check</title><iframe id="owned" src="/child" ' +
                      'style="position:absolute;top:350px;left:0;' +
                      'width:440px;height:230px"></iframe>'
        )
    }
)
await new Promise((resolve) => http.listen(0, '127.0.0.1', () => resolve(undefined)))
const base = `http://127.0.0.1:${http.address().port}`
let sequence = 0
let nativeProtocolDispatches = 0
let buffer = ''
let transportError
const pending = new Map()
const rejectPending = (error) => {
    transportError ??= error
    for (const call of pending.values()) {
        clearTimeout(call.timer)
        call.reject(transportError)
    }
    pending.clear()
}
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
let chromeClosed = false
const closed = new Promise((resolve) => {
    chrome.once('close', () => {
        chromeClosed = true
        resolve()
    })
})
chrome.once('error', rejectPending)
chrome.once('exit', (code, signal) => {
    rejectPending(new Error(`Native Chrome exited: code=${code}, signal=${signal}`))
})
const stderr = fs.createWriteStream(path.join(work, 'chrome.log'), { mode: 0o600 })
chrome.stderr.on('error', rejectPending)
stderr.on('error', rejectPending)
chrome.stderr.pipe(stderr)
chrome.stdio[3].on('error', rejectPending)
chrome.stdio[4].on('error', rejectPending)
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
    if (transportError) {
        return Promise.reject(transportError)
    }
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
        try {
            chrome.stdio[3].write(
                JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0',
                (error) => {
                    if (error) {
                        rejectPending(error)
                    }
                }
            )
        } catch (error) {
            rejectPending(error)
        }
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
let restorePublicWheel
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
        'installed isolated Extension, production ' +
        'schemas/handlers and real Chrome ' +
        'scripting/CDP APIs; direct handler entry, no ' +
        'SDK or Bridge',
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
        const controlRenderPhase = options.eventBoundary && phaseControl
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
    let publicWheel
    let refreshPublicWheel
    if (process.env.C31F6_REMAINING === '1') {
        const { getUnifiedSession } = await import(pathToFileURL(path.join(root, 'dist/core/index.js')))
        const { ExtensionBridge } = await import(pathToFileURL(path.join(root, 'dist/extension/bridge.js')))
        const { registerInputTool } = await import(pathToFileURL(path.join(root, 'dist/tools/input.js')))
        const unified = getUnifiedSession()
        const bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() })
        const top = (await evaluate(`c31f6.frames(${tab.id})`)).find((frame) => frame.frameId === 0)
        bridge.currentTabId = tab.id
        bridge.currentFrameDocumentId = top.documentId
        bridge.httpServer.helloReceived = true
        bridge.httpServer.clientSocket = {
            readyState: 1,
            close() {},
            send(text) {
                const message = JSON.parse(text)
                if (message.type === 'cancel') {
                    return
                }
                const call =
                    message.action === 'tabs_list'
                        ? evaluate('c31f6.tabs()')
                        : evaluate(`c31f6.command(${JSON.stringify(message.action)},${JSON.stringify(message.params)})`)
                void call.then(
                    (data) => bridge.httpServer.handleMessage(JSON.stringify({ id: message.id, success: true, data })),
                    (error) =>
                        bridge.httpServer.handleMessage(
                            JSON.stringify({ id: message.id, success: false, error: error.message })
                        )
                )
            },
        }
        const overrides = {
            extensionBridge: bridge,
            inputMode: 'precise',
            currentFrameOffset: null,
            activeMode: 'extension',
            cdpExplicitlySelected: false,
            getPageSnapshot: async () => ({ targetId: String(tab.id), url: tab.url, revision: 'native-wheel' }),
            listTargets: async () => [{ targetId: String(tab.id) }],
            listTopology: async () => ({ activeTargetId: String(tab.id) }),
            hasBrowserEventObservation: () => false,
            getChallengeState: async () => null,
            getState: () => ({ title: 'Native wheel test', url: tab.url }),
            getLiveState: async () => ({ title: 'Native wheel test', url: tab.url }),
            inspectChallenge: async () => ({
                inspected: true,
                title: 'Native wheel test',
                url: tab.url,
                selectorHits: [],
                deniedHits: [],
                textHits: [],
                originResponsePending: false,
                turnstilePresent: false,
                clickPoint: null,
                clickTargetKind: null,
            }),
        }
        const previous = new Map(
            Object.keys(overrides).map((key) => [key, Object.getOwnPropertyDescriptor(unified, key)])
        )
        Object.assign(unified, overrides)
        restorePublicWheel = async () => {
            for (const [key, descriptor] of previous) {
                if (descriptor) {
                    Object.defineProperty(unified, key, descriptor)
                } else {
                    Reflect.deleteProperty(unified, key)
                }
            }
            await bridge.stop()
        }
        let input
        let schema
        registerInputTool({
            registerTool(_name, config, handler) {
                schema = config.inputSchema
                input = handler
            },
        })
        refreshPublicWheel = async () => {
            const current = (await evaluate(`c31f6.frames(${tab.id})`)).find((frame) => frame.frameId === 0)
            top.documentId = current.documentId
            tab.url = current.url
            bridge.currentFrameDocumentId = current.documentId
            return current
        }
        publicWheel = async (options, point, delta = options.delta ?? 120) => {
            const axis = options.axis ?? 'y'
            unified.setInputMode(options.mode)
            const response = await input(
                schema.parse({
                    targetId: String(tab.id),
                    ...(wheelFrameId ? { frame: 'iframe#owned' } : {}),
                    timeout: 5000,
                    events: [
                        {
                            type: 'wheel',
                            target: point,
                            deltaX: axis === 'y' ? 0 : delta,
                            deltaY: axis === 'x' ? 0 : delta,
                        },
                        ...(options.waitMs ? [{ type: 'wait', ms: options.waitMs }] : []),
                    ],
                })
            )
            const payload = JSON.parse(response.content[0].text)
            assert.notEqual(response.isError, true, JSON.stringify(payload))
            assert.equal(payload.mode, 'extension')
            assert.equal(payload.actionStatus, 'completed')
            assert.equal(payload.eventsExecuted, options.waitMs ? 2 : 1)
            assert.equal(payload.retryable, false)
            assert.equal(bridge.getCurrentFrameId(), 0)
            assert.equal(bridge.getCurrentFrameDocumentId(), top.documentId)
            return payload
        }
        result.publicInputs = 0
        result.publicWheelBoundary =
            'registered public input/UnifiedSession/ExtensionBridge; transport and page metadata adapted to the owned native carrier; real installed Extension handlers; no SDK Client/McpServer'
    }
    const prepareWheelFrame = async (options) => {
        wheelFrameId = 0
        if (options.frame || options.quirks) {
            const source = base + '/child?' + (options.quirks ? 'quirks-' : '') + encodeURIComponent(options.id)
            await script(
                '(() => {document.documentElement.style.cssText="";document.body.style.cssText="margin:0";document.body.innerHTML=' +
                    JSON.stringify(
                        `<iframe ${options.layoutMatrix || options.remainingWheel ? 'id="owned" ' : ''}src="${source}" style="position:absolute;left:0;top:0;width:500px;height:400px;border:0;zoom:${options.frameZoom ?? 1}"></iframe>`
                    ) +
                    ';window.scrollTo(0,0);return true})()'
            )
            const frames = await poll(
                () => evaluate(`c31f6.frames(${tab.id})`),
                (frames) => frames.some((frame) => frame.url === source)
            )
            wheelFrameId = frames.find((frame) => frame.url === source).frameId
        }
    }
    const navigateWheelDocument = async (options) => {
        const before = (await evaluate(`c31f6.frames(${tab.id})`)).find((frame) => frame.frameId === 0)
        const url = `${base}/?mcp_test_wheel_document=${sequence}`
        await send('Page.navigate', { url }, pageSession)
        await poll(
            async () => (await evaluate('c31f6.tabs()')).find((entry) => entry.id === tab.id),
            (entry) => entry?.url === url && entry.status === 'complete'
        )
        const after = await poll(
            async () => (await evaluate(`c31f6.frames(${tab.id})`)).find((frame) => frame.frameId === 0),
            (frame) => frame?.url === url && frame.documentId !== before.documentId
        )
        await refreshPublicWheel()
        await prepareWheelFrame(options)
        return { before: before.documentId, after: after.documentId }
    }
    const resetFraction = async (options, step) => {
        if (!options.reset || step !== 2) {
            return
        }
        if (options.reset === 'document') {
            const beforeEvents = (await readState()).events
            const identity = await navigateWheelDocument(options)
            await setup(options)
            return { kind: 'document', ...identity, beforeEvents }
        }
        const expressions = {
            container:
                'const position=[s.container.scrollLeft,s.container.scrollTop];const next=s.container.cloneNode(true);s.container.replaceWith(next);s.container=next;s.inner=next.querySelector("#inner");next.scrollTo({left:position[0],top:position[1],behavior:"instant"})',
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
    for (const options of wheelCases) {
        const check = {
            kind: 'wheel',
            id: options.id,
            options,
            ...(phaseControl ? { renderPhaseControl: 'virtual-time-paused-during-input' } : {}),
        }
        try {
            await prepareWheelFrame(options)
            if (options.layoutMatrix) {
                if (wheelFrameId === 0) {
                    await script('(() => {document.querySelector("#owned")?.remove();return true})()')
                }
                const rebuild = async () => {
                    const configuration = {
                        ...options,
                        group: options.group === 'mixed-hidden' ? 'hidden' : options.group,
                    }
                    const layout = await wheelScript(
                        `(${configureWheelFixture.toString()})(${JSON.stringify(configuration)})`
                    )
                    assert.equal(layout.hit, 'inner', JSON.stringify(layout))
                    return layout
                }
                const readLayout = () => wheelScript(`(${readWheelFixture.toString()})()`)
                const settled = async (expectedEvents = 1) => {
                    const deadline = Date.now() + 2500
                    let previous
                    let stable = 0
                    while (Date.now() < deadline) {
                        const value = await readLayout()
                        const positions = JSON.stringify(
                            ['target', 'container', 'outer', 'viewport', 'root', 'body'].map((key) => value[key])
                        )
                        stable = positions === previous ? stable + 1 : 0
                        previous = positions
                        if (stable >= 5 && value.events.length === expectedEvents) {
                            return value
                        }
                        await delay(20)
                    }
                    throw new Error('Remaining wheel state did not settle')
                }
                check.mode = options.mode
                check.frameId = wheelFrameId
                check.layout = await rebuild()
                check.initial = await readLayout()
                if (options.group === 'propagation') {
                    check.documentBefore = (await evaluate(`c31f6.frames(${tab.id})`)).find(
                        (frame) => frame.frameId === wheelFrameId
                    ).documentId
                }
                ++result.publicInputs
                check.response = await publicWheel(
                    options,
                    options.target === 'css' ? { css: '#scroller' } : check.layout.point
                )
                check.tool = await settled(options.target === 'css' ? 0 : 1)
                if (options.target === 'css') {
                    assert.deepEqual(check.tool.events, [])
                } else {
                    assert.equal(check.tool.events[0].trusted, false)
                    assert.equal(check.tool.events[0].composed, true)
                }
                if (options.group === 'propagation') {
                    check.documentAfter = (await evaluate(`c31f6.frames(${tab.id})`)).find(
                        (frame) => frame.frameId === wheelFrameId
                    ).documentId
                    assert.equal(typeof check.documentBefore, 'string')
                    assert.equal(check.documentAfter, check.documentBefore)
                }
                check.references = {}
                for (const referenceAxis of options.axis === 'both' ? ['x', 'y'] : ['both']) {
                    if (options.axis === 'both') {
                        check.referenceDocuments ??= {}
                        check.referenceDocuments[referenceAxis] = await navigateWheelDocument(options)
                    }
                    const reference = await rebuild()
                    ++result.nativeReferences
                    ++result.nativeWheelReferences
                    await send(
                        'Input.dispatchMouseEvent',
                        {
                            type: 'mouseWheel',
                            ...reference.point,
                            deltaX: options.axis === 'y' || referenceAxis === 'y' ? 0 : options.delta,
                            deltaY: options.axis === 'x' || referenceAxis === 'x' ? 0 : options.delta,
                        },
                        pageSession
                    )
                    const native = await settled()
                    check.references[referenceAxis] = native
                    if (referenceAxis === 'both') {
                        check.native = native
                    }
                    assert.equal(native.events[0].trusted, true)
                    assert.equal(native.events[0].target, 'inner')
                    for (const key of ['target', 'container', 'outer', 'viewport', 'root', 'body']) {
                        for (const axis of referenceAxis === 'both' ? ['x', 'y'] : [referenceAxis]) {
                            assert.ok(
                                Math.abs(check.tool[key][axis] - native[key][axis]) < 0.02,
                                `${key}/${axis}: ${check.tool[key][axis]} != ${native[key][axis]}`
                            )
                        }
                    }
                }
                if (options.group === 'propagation') {
                    const listeners = options.shadow
                        ? ['inner', 'root', 'host', 'document']
                        : ['inner', 'ancestor', 'document']
                    const cancelIndex = {
                        none: listeners.length,
                        target: 0,
                        ancestor: options.shadow ? 2 : 1,
                        document: listeners.length - 1,
                    }[options.cancelAt]
                    for (const [state, trusted] of [
                        [check.tool, false],
                        [check.native, true],
                    ]) {
                        assert.deepEqual(
                            state.propagation.map((event) => event.listener),
                            listeners
                        )
                        for (const [index, event] of state.propagation.entries()) {
                            assert.equal(event.target, 'inner')
                            assert.equal(event.retargeted, options.shadow && index >= 2 ? 'scroller' : 'inner')
                            assert.equal(event.composed, true)
                            assert.equal(event.bubbles, true)
                            assert.equal(event.cancelable, true)
                            assert.equal(event.trusted, trusted)
                            assert.equal(event.defaultPrevented, index >= cancelIndex)
                        }
                        if (options.cancelAt !== 'none') {
                            for (const key of ['target', 'container', 'outer', 'viewport', 'root', 'body']) {
                                for (const axis of ['x', 'y']) {
                                    assert.ok(Math.abs(state[key][axis] - check.initial[key][axis]) < 0.02)
                                }
                            }
                        }
                    }
                }
                check.status = 'PASS'
                result.checks.push(check)
                continue
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
                if (options.remainingWheel) {
                    ++result.publicInputs
                    check.responses ??= []
                    check.responses.push(await publicWheel(options, check.layout.point, delta))
                } else {
                    await command({
                        type: 'mouseWheel',
                        ...check.layout.point,
                        deltaX: options.axis === 'x' ? delta : 0,
                        deltaY: options.axis === 'x' ? 0 : delta,
                    })
                }
                await delay(options.waitMs ? 0 : (options.interval ?? 30))
                check.toolSteps.push(await readState())
                const reset = await resetFraction(options, check.toolSteps.length - 1)
                if (reset) {
                    check.resets ??= []
                    check.resets.push({ source: 'tool', ...reset })
                }
            }
            check.tool = await settle(options, (check.toolStableSamples = []))
            for (const label of phaseControl ? ['native', 'nativeRepeat'] : ['native']) {
                const reference = await setup(options)
                const steps = (check[`${label}Steps`] = [])
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
                    steps.push(await readState())
                    const reset = await resetFraction(options, steps.length - 1)
                    if (reset) {
                        check.resets ??= []
                        check.resets.push({ source: label, ...reset })
                    }
                }
                check[label] = await settle(options, (check[`${label}StableSamples`] = []))
            }
            if (phaseControl) {
                const differences = []
                for (const key of ['container', 'outer', 'middle', 'replacement', 'viewport']) {
                    for (let axis = 0; axis < 2; axis++) {
                        const first = check.native[key][axis]
                        const repeat = check.nativeRepeat[key][axis]
                        if (Math.abs(first - repeat) >= 0.02) {
                            differences.push({ key, axis, first, repeat })
                        }
                    }
                }
                check.nativeControl = { status: differences.length ? 'FAIL' : 'PASS', differences }
            }
            for (const reset of check.resets ?? []) {
                if (reset.kind === 'document') {
                    const state = reset.source === 'tool' ? check.tool : check[reset.source]
                    state.documentEvents = [
                        { documentId: reset.before, events: reset.beforeEvents },
                        { documentId: reset.after, events: [...state.events] },
                    ]
                    state.events = [...reset.beforeEvents, ...state.events]
                }
            }
            let expected = check.native
            if (options.acceptedSnap) {
                await setup(options)
                for (const delta of deltas) {
                    await wheelScript(
                        '(() => {\n                        const ' +
                            's=window.__c31f6, delta=' +
                            `${delta}` +
                            ';\n                        s.programmaticStart ' +
                            '??= [s.outer.scrollLeft,s.outer.scrollTop];\n  ' +
                            '                      s.programmaticBoundary ' +
                            '??= [0,0];\n                        const axis=' +
                            `${options.axis === 'x' ? 0 : 1}` +
                            ', position=axis===0?s.container.scrollLeft:s.c' +
                            'ontainer.scrollTop;\n                        ' +
                            'const maximum=axis===0?s.container.scrollWidth' +
                            '-s.container.clientWidth:s.container.scrollHei' +
                            'ght-s.container.clientHeight;\n                ' +
                            '        if ((delta<0 && position===0)||(delta>' +
                            '0 && position===maximum)) ' +
                            's.programmaticBoundary[axis]+=delta;\n         ' +
                            '               s.container.scrollBy({left:axis' +
                            '===0?delta:0,top:axis===1?delta:0,' +
                            "behavior:'instant'});\n                        " +
                            's.outer.scrollTo({left:s.programmaticStart[0]+' +
                            's.programmaticBoundary[0],' +
                            'top:s.programmaticStart[1]+s.programmaticBound' +
                            "ary[1],behavior:'instant'});\n                 " +
                            '       return true;\n                    })()'
                    )
                    await delay(options.interval ?? 30)
                }
                check.programmatic = await settle(options, (check.programmaticStableSamples = []))
                check.programmaticBoundaryIntent = await wheelScript('window.__c31f6.programmaticBoundary')
                check.acceptedContract = options.requireNativeEquality
                    ? 'Programmatic scrollBy endpoint and native-equivalence control'
                    : 'Programmatic scrollBy snap endpoint; native ' +
                      'differences are recorded, not ' +
                      'native-equivalence passes'
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
            if (phaseControl) {
                assert.equal(check.nativeRepeat.events.length, deltas.length)
                assert.equal(
                    check.nativeControl.status,
                    'PASS',
                    'Native repeat: ' + JSON.stringify(check.nativeControl)
                )
            }
            if (process.env.WHEEL_BUSINESS_FAILURE === options.id) {
                check.controlledBusinessFailure = true
                // noinspection ExceptionCaughtLocallyJS — 将受控失败收集为测试结果
                throw new Error('Controlled business failure: ' + options.id)
            }
            check.status = 'PASS'
        } catch (error) {
            check.status = 'FAIL'
            check.error = error.message
        }
        result.checks.push(check)
        if (process.env.C31F6_REMAINING === '1' && check.status === 'FAIL') {
            break
        }
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
                '<input type="checkbox" id="pad" ' +
                'style="position:absolute;left:80px;top:60px;' +
                'width:120px;height:100px"><button ' +
                'id="disabled" disabled style="position:absolut' +
                'e;left:260px;top:60px">disabled</button>'
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
                            'c31f6.command(' +
                                `${JSON.stringify(action)}` +
                                ',' +
                                `${JSON.stringify({ tabId: tab.id, frameId: 0, ...params, modifiers: mask })}` +
                                ')'
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
                    '(() => {document.documentElement.style.cssText' +
                        "='';document.body.style.cssText='margin:0;" +
                        "min-height:2400px';document.body.innerHTML=" +
                        ('' +
                            JSON.stringify(
                                '<iframe id="geometry" src="' +
                                    `${source}` +
                                    '" style="position:absolute;left:100px;top:' +
                                    `${options.scroll ? 1200 : 100}` +
                                    'px;width:' +
                                    `${options.zero ? 0 : 400}` +
                                    'px;height:' +
                                    `${options.zero ? 0 : 300}` +
                                    'px;border:' +
                                    `${options.border ?? (options.nested ? 11 : 0)}` +
                                    'px solid;zoom:' +
                                    `${options.zoom ?? 1}` +
                                    ';transform-origin:' +
                                    `${options.origin ?? '0 0'}` +
                                    ';transform:' +
                                    `${options.transform ?? (options.nested ? 'matrix(1.2,.2,-.1,1.1,0,0)' : 'none')}` +
                                    '"></iframe>'
                            )) +
                        ';window.scrollTo(0,0);return true})()'
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
                        "(() => {document.body.style.cssText='margin:0'" +
                            ';document.body.innerHTML=' +
                            ('' +
                                JSON.stringify(
                                    '<iframe id="geometry" src="' +
                                        `${nestedSource}` +
                                        '" style="position:absolute;left:' +
                                        `${options.innerSimple ? 20 : 40}` +
                                        'px;top:' +
                                        `${options.innerSimple ? 20 : 50}` +
                                        'px;width:240px;height:200px;border:' +
                                        `${options.innerSimple ? 0 : 7}` +
                                        'px solid;zoom:' +
                                        `${options.innerZoom ?? 1}` +
                                        ';transform-origin:0 0;transform:' +
                                        `${options.innerSimple ? 'scale(.8)' : 'matrix(.8,.1,.2,.9,0,0)'}` +
                                        '"></iframe>'
                                )) +
                            ';return true})()'
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
                        '(() => { const pad=document.getElementById("pa' +
                            'd"),host=document.createElement("div");' +
                            'host.style.cssText="position:absolute;left:0;' +
                            'top:0;width:300px;height:200px";' +
                            'document.body.append(host);' +
                            'host.attachShadow({mode:"open"}).append(pad);' +
                            'window.__mcpElementMap.pad=new WeakRef(pad);' +
                            'return true })()'
                    )
                }
                if (options.scroll) {
                    await script(
                        'document.getElementById("geometry").scrollIntoView({block:"center",behavior:"instant"})'
                    )
                }
                const query = await evaluate(
                    "c31f6.command('evaluate_in_frame'," +
                        ('' +
                            JSON.stringify({
                                tabId: tab.id,
                                frameId: selected.frameId,
                                expression: '({url:location.href,marked:globalThis.__c31f6Events!==undefined})',
                                timeout: 5000,
                            })) +
                        ')'
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
                    'c31f6.inputTouch(' +
                        ('' +
                            JSON.stringify({
                                tabId: tab.id,
                                frameId: selected.frameId,
                                documentId: selected.documentId,
                                modifiers: 10,
                                type: 'touchStart',
                                touchPoints: [{ x: 140, y: 110 }],
                            })) +
                        ')'
                )
                await evaluate(
                    'c31f6.inputTouch(' +
                        ('' +
                            JSON.stringify({
                                tabId: tab.id,
                                frameId: selected.frameId,
                                documentId: selected.documentId,
                                modifiers: 10,
                                type: 'touchEnd',
                                touchPoints: [],
                            })) +
                        ')'
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
                                    'c31f6.command(' +
                                        `${JSON.stringify(action)}` +
                                        ',' +
                                        ('' +
                                            JSON.stringify({
                                                tabId: tab.id,
                                                frameId: selected.frameId,
                                                documentId: selected.documentId,
                                                ...event,
                                                modifiers: mask,
                                            })) +
                                        ')'
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
                'c31f6.debug(' +
                    `${tab.id}` +
                    ',' +
                    `${JSON.stringify(method)}` +
                    ',' +
                    `${JSON.stringify(params)}` +
                    ',' +
                    `${JSON.stringify(sessionId)}` +
                    ')'
            )
        const frameScript = (frameId, code) => evaluate(`c31f6.script(${tab.id},${frameId},${JSON.stringify(code)})`)
        for (const remote of [false, true]) {
            const observation = { remote }
            const source = remote ? base.replace('127.0.0.1', 'localhost') : base
            await script(
                "(() => { document.body.style.cssText='margin:0" +
                    "';document.body.innerHTML='<iframe " +
                    'id="geometry" src="' +
                    `${source}` +
                    '/child" style="position:absolute;left:100px;' +
                    'top:100px;width:300px;height:250px;' +
                    'border:11px solid;transform-origin:0 0;' +
                    'transform:matrix(1.2,.2,-.1,1.1,0,0)">' +
                    "</iframe>';return true })()"
            )
            const frames = await poll(
                () => evaluate(`c31f6.frames(${tab.id})`),
                (values) => values.length === 2 && values.some((f) => f.url === source + '/child')
            )
            const child = frames.find((f) => f.frameId !== 0)
            observation.child = child
            await frameScript(
                child.frameId,
                "(() => { document.body.style.cssText='margin:0" +
                    "';document.body.innerHTML='<iframe " +
                    'id="nested" src="' +
                    `${base}` +
                    '/child" style="position:absolute;left:40px;' +
                    'top:50px;width:140px;height:120px;border:7px ' +
                    'solid;transform-origin:0 0;' +
                    'transform:matrix(.8,.1,.2,.9,0,0)"></iframe>\';' +
                    'return true })()'
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
    result.error = { message: error.message, stack: error.stack, ...(error.code ? { code: error.code } : {}) }
} finally {
    const errors = []
    result.cleanupAttempts = []
    const cleanup = async (name, close) => {
        result.cleanupAttempts.push(name)
        try {
            await close()
            if (process.env.WHEEL_CLEANUP_FAILURE === name) {
                // noinspection ExceptionCaughtLocallyJS — 将受控清理失败收集为测试结果
                throw new Error('Controlled cleanup failure: ' + name)
            }
        } catch (error) {
            errors.push({ resource: name, error: String(error) })
        }
    }
    if (restorePublicWheel) {
        await cleanup('public-wheel', restorePublicWheel)
    }
    await cleanup('chrome', async () => {
        if (!chromeClosed) {
            chrome.kill('SIGTERM')
            await Promise.race([closed, delay(3000)])
            // noinspection PointlessBooleanExpressionJS — 等待期间进程可以退出
            if (!chromeClosed) {
                chrome.kill('SIGKILL')
                await closed
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
    await cleanup('pipe', () => rejectPending(new Error('Native test cleanup')))
    await cleanup('profile', () => fs.rmSync(path.join(work, 'profile'), { recursive: true, force: true }))
    if (errors.length) {
        result.cleanupErrors = errors
        result.businessStatus = result.status
        result.status = 'ERROR'
    }
    result.resources = {
        chromeExited: chrome.exitCode !== null || chrome.signalCode !== null,
        chromeClosed,
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
