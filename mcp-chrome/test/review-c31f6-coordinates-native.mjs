/* global window, document, innerWidth, innerHeight */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CDPClient } from '../dist/cdp/client.js'
import { getSession, getUnifiedSession } from '../dist/core/index.js'
import { ExtensionBridge } from '../dist/extension/bridge.js'
import { registerEvaluateTool } from '../dist/tools/evaluate.js'
import { registerManageTool } from '../dist/tools/manage.js'
import { registerLogsTool } from '../dist/tools/logs.js'
import { withNavigationBudget } from '../dist/core/utils.js'

const { registerInputTool } = await import(process.env.COORD_INPUT_MODULE ?? '../dist/tools/input.js')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const chromePath = process.argv[2] ?? process.env.CHROME_PATH
const headful = process.env.COORD_HEADFUL === '1'
assert.ok(chromePath, 'Pass CHROME_PATH and optional OUTPUT_JSON')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-c31f6-coordinates-'))
const output = path.resolve(process.argv[3] ?? path.join(work, 'results.json'))
const result = {
    status: 'running',
    work,
    checks: [],
    sdkCalls: 0,
    registeredCalls: 0,
    bridgeCalls: 0,
    bridgeCommands: [],
    observerReads: 0,
    nativeReferences: 0,
    nativeDispatches: 0,
    nativeCommands: [],
    productionCommands: [],
    boundary:
        'Actual SDK Client/McpServer tools/call and ' +
        'production CDPClient/Session in an isolated ' +
        'Chrome. Extension uses production Bridge ' +
        'parameters and installed production ' +
        'ActionHandler via an explicit test worker ' +
        'carrier; HTTP/WebSocket extension discovery ' +
        'is outside this runner.',
}
const extension = path.join(work, 'extension')
fs.mkdirSync(extension)
fs.writeFileSync(
    path.join(extension, 'manifest.json'),
    JSON.stringify({
        manifest_version: 3,
        name: 'Isolated coordinates regression',
        version: '1.0.0',
        permissions: ['tabs', 'tabGroups', 'scripting', 'storage', 'webNavigation', 'debugger'],
        host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'],
        background: { service_worker: 'review.js', type: 'module' },
    })
)
const { build } = await import(pathToFileURL(path.join(root, 'extension/node_modules/vite/dist/node/index.js')))
await build({
    configFile: false,
    logLevel: 'warn',
    build: {
        outDir: extension,
        emptyOutDir: false,
        minify: false,
        lib: {
            entry: path.join(root, 'test/review-c31f6-coordinates-extension.ts'),
            formats: ['es'],
            fileName: () => 'review.js',
        },
    },
})
const pageBody =
    '<input id="pad" type="checkbox" ' +
    'style="position:absolute;left:80px;top:60px;' +
    'width:120px;height:100px;margin:0"><button ' +
    'id="disabled" disabled style="position:absolut' +
    'e;left:270px;top:60px">Disabled</button>' +
    '<input id="edit" style="position:absolute;' +
    'left:80px;top:190px;width:140px"><p ' +
    'tabindex="-1" id="text" ' +
    'style="position:absolute;left:80px;top:230px;' +
    'font:20px monospace">alpha bravo charlie</p>' +
    '<div id="drop" style="position:absolute;' +
    'left:240px;top:190px;width:100px;' +
    'height:100px">drop</div>'
const http = createServer(
    /**
     * @param {import('node:http').IncomingMessage} request
     * @param {import('node:http').ServerResponse} response
     */
    (request, response) => {
        if (request.url === '/owned-download') {
            response.setHeader('Content-Type', 'application/octet-stream')
            response.setHeader('Content-Disposition', 'attachment; filename="owned-download.txt"')
            response.end('owned download regression\n')
            return
        }
        if (request.url?.startsWith('/csp-')) {
            response.setHeader(
                'Content-Security-Policy',
                `script-src 'self'${request.url.startsWith('/csp-allowed') ? " 'unsafe-eval'" : ''}`
            )
        }
        response.setHeader('Content-Type', 'text/html')
        response.end('<!doctype html><title>Owned coordinates</title><body style="margin:0">' + pageBody + '</body>')
    }
)
await new Promise((resolve) => http.listen(0, '127.0.0.1', () => resolve(undefined)))
const base = `http://127.0.0.1:${http.address().port}`
const chrome = spawn(
    chromePath,
    [
        ...(headful ? ['--no-startup-window'] : ['--headless=new']),
        '--no-sandbox',
        '--window-size=1600,1300',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-proxy-server',
        '--remote-debugging-port=0',
        '--remote-debugging-pipe',
        '--enable-unsafe-extension-debugging',
        `--user-data-dir=${path.join(work, 'profile')}`,
        ...(headful ? [] : [base + '/']),
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] }
)
result.browserArguments = chrome.spawnargs
chrome.stderr.pipe(fs.createWriteStream(path.join(work, 'chrome.log'), { mode: 0o600 }))
let seq = 0,
    buffer = ''
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
        const m = JSON.parse(raw),
            p = pending.get(m.id)
        if (p) {
            pending.delete(m.id)
            clearTimeout(p.timer)
            if (m.error) {
                p.reject(new Error(JSON.stringify(m.error)))
            } else {
                p.resolve(m.result)
            }
        }
    }
})
function pipe(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
        const id = ++seq
        const timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error('Pipe timeout: ' + method))
        }, 15000)
        pending.set(id, { resolve, reject, timer })
        chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
    })
}
async function until(fn) {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
        const value = await fn()
        if (value) {
            return value
        }
        await delay(10)
    }
    throw new Error('Real Chrome condition did not arrive')
}
const unified = getUnifiedSession(),
    session = getSession()
let observer,
    observerSession,
    workerSession,
    tabId,
    bridge,
    server,
    client,
    rootId,
    mode,
    selectedFrame = 0
let frameSelection,
    frameIds = []
let snapshotsUntilHold = 0
let heldSnapshot
async function worker(expression) {
    const value = await pipe('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, workerSession)
    if (value.exceptionDetails) {
        throw new Error(JSON.stringify(value.exceptionDetails))
    }
    return value.result.value
}
async function script(frameId, code) {
    ++result.observerReads
    return worker(`coordinates.script(${tabId},${frameId},${JSON.stringify(code)})`)
}
function payload(response) {
    const text = response.content[0].text
    assert.ok(text.startsWith('{'), text)
    return JSON.parse(text)
}
async function invoke(name, args, options) {
    ++result.sdkCalls
    return payload(
        await client.callTool(
            {
                name,
                arguments: {
                    targetId: mode === 'cdp' ? rootId : String(tabId),
                    ...(['input', 'evaluate'].includes(name)
                        ? { timeout: 7000, ...(frameSelection ? { frame: frameSelection } : {}) }
                        : {}),
                    ...args,
                },
            },
            undefined,
            options
        )
    )
}
async function call(events, extra = {}, options) {
    return invoke('input', { events, ...extra }, options)
}
function completed(body, count) {
    assert.equal(body.actionStatus, 'completed', JSON.stringify(body))
    assert.equal(body.eventsExecuted, count, JSON.stringify(body))
    assert.equal(body.retryable, false)
}
async function record(id, run) {
    if (process.env.COORD_FILTER && !new RegExp(process.env.COORD_FILTER).test(id)) {
        return
    }
    const check = { id, mode, frame: frameSelection ?? null }
    const initial = {
        sdkCalls: result.sdkCalls,
        registeredCalls: result.registeredCalls,
        bridgeCalls: result.bridgeCalls,
        observerReads: result.observerReads,
        nativeReferences: result.nativeReferences,
        nativeDispatches: result.nativeDispatches,
    }
    try {
        Object.assign(check, await run(check))
        if (process.env.COORD_BUSINESS_FAILURE === id) {
            // noinspection ExceptionCaughtLocallyJS — 将受控失败收集为测试结果
            throw new Error('Controlled business failure: ' + id)
        }
        check.status = 'PASS'
    } catch (error) {
        check.status = 'FAIL'
        check.error = error.message
        check.stack = error.stack
    }
    check.counts = Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, result[k] - v]))
    result.checks.push(check)
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
    console.log(id, mode, check.status, check.error ?? '')
}
function configure() {
    window.__coordAbort?.abort()
    window.__coordAbort = new AbortController()
    window.__coordCaptureTimes = false
    window.__coordEvents = []
    window.__coordActions = 0
    for (const type of [
        'wheel',
        'mousemove',
        'mousedown',
        'mouseup',
        'click',
        'contextmenu',
        'touchstart',
        'touchmove',
        'touchend',
        'drop',
    ]) {
        document.addEventListener(
            type,
            (event) => {
                const touch = event.changedTouches?.[0]
                const targetRect = window.__coordCaptureRects ? event.composedPath()[0].getBoundingClientRect?.() : null
                window.__coordEvents.push({
                    ...(window.__coordCaptureTimes
                        ? { time: performance.now(), visibility: document.visibilityState }
                        : {}),
                    ...(targetRect
                        ? {
                              targetRect: {
                                  x: targetRect.x,
                                  y: targetRect.y,
                                  width: targetRect.width,
                                  height: targetRect.height,
                              },
                          }
                        : {}),
                    type,
                    target: event.composedPath()[0].id || event.composedPath()[0].tagName,
                    x: event.clientX ?? touch?.clientX,
                    y: event.clientY ?? touch?.clientY,
                    altKey: event.altKey,
                    ctrlKey: event.ctrlKey,
                    metaKey: event.metaKey,
                    shiftKey: event.shiftKey,
                    trusted: event.isTrusted,
                    deltaX: event.deltaX,
                    deltaY: event.deltaY,
                })
                if (type === 'wheel') {
                    event.preventDefault()
                    if (window.__coordCaptureTimes) {
                        window.__coordEvents.at(-1).defaultPrevented = event.defaultPrevented
                    }
                    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
                        ++window.__coordActions
                    }
                }
            },
            { passive: false, signal: window.__coordAbort.signal }
        )
    }
    return { width: innerWidth, height: innerHeight }
}
function observeSettlementResources() {
    const { EventTarget } = window
    const add = EventTarget.prototype.addEventListener
    const remove = EventTarget.prototype.removeEventListener
    const NativeChannel = window.MessageChannel
    const requestFrame = window.requestAnimationFrame.bind(window)
    const cancelFrame = window.cancelAnimationFrame.bind(window)
    const setTimer = window.setTimeout.bind(window)
    const clearTimer = window.clearTimeout.bind(window)
    const listeners = []
    const ports = []
    const frames = new Set()
    const timers = new Set()
    let framesCreated = 0
    let timersCreated = 0
    EventTarget.prototype.addEventListener = function (type, listener, ...rest) {
        if (['scroll', 'scrollend', 'visibilitychange'].includes(type)) {
            listeners.push({ target: this, type, listener })
        }
        return add.call(this, type, listener, ...rest)
    }
    EventTarget.prototype.removeEventListener = function (type, listener, ...rest) {
        const index = listeners.findIndex(
            (value) => value.target === this && value.type === type && value.listener === listener
        )
        if (index >= 0) {
            listeners.splice(index, 1)
        }
        return remove.call(this, type, listener, ...rest)
    }
    window.MessageChannel = function () {
        const channel = new NativeChannel()
        for (const port of [channel.port1, channel.port2]) {
            const close = port.close.bind(port)
            const record = { closed: false }
            ports.push(record)
            port.close = () => {
                record.closed = true
                close()
            }
        }
        return channel
    }
    window.requestAnimationFrame = (callback) => {
        const id = requestFrame((time) => {
            frames.delete(id)
            callback.call(window, time)
        })
        ++framesCreated
        frames.add(id)
        return id
    }
    window.cancelAnimationFrame = (id) => {
        frames.delete(id)
        cancelFrame(id)
    }
    window.setTimeout = (callback, ms, ...args) => {
        const id = setTimer(
            (...values) => {
                timers.delete(id)
                callback.apply(window, values)
            },
            ms,
            ...args
        )
        ++timersCreated
        timers.add(id)
        return id
    }
    window.clearTimeout = (id) => {
        timers.delete(id)
        clearTimer(id)
    }
    window.__coordResources = () => ({
        listeners: listeners.map((value) => value.type),
        ports: ports.map((value) => value.closed),
        framesCreated,
        framesRemaining: frames.size,
        timersCreated,
        timersRemaining: timers.size,
    })
    window.__coordRestoreResources = () => {
        EventTarget.prototype.addEventListener = add
        EventTarget.prototype.removeEventListener = remove
        window.MessageChannel = NativeChannel
        window.requestAnimationFrame = requestFrame
        window.cancelAnimationFrame = cancelFrame
        window.setTimeout = setTimer
        window.clearTimeout = clearTimer
    }
    return true
}
const fixtureScript = (expression) => script(selectedFrame, expression)
async function clear() {
    await fixtureScript('(window.__coordEvents=[],window.__coordActions=0,true)')
}
async function events() {
    return fixtureScript('window.__coordEvents')
}
async function setup(styles = []) {
    frameSelection = styles.length ? styles.map((_, i) => '#frame' + i) : undefined
    if (frameSelection?.length === 1) {
        frameSelection = frameSelection[0]
    }
    selectedFrame = 0
    frameIds = []
    await script(
        0,
        '(()=>{document.body.innerHTML=' +
            `${JSON.stringify(styles.length ? '' : pageBody)}` +
            ";document.body.style.cssText='margin:0;" +
            "min-width:1600px;min-height:1250px';" +
            'window.scrollTo(0,0);return true})()'
    )
    let parent = 0
    for (let i = 0; i < styles.length; i++) {
        const src =
            (styles[i].oopif ? 'http://localhost:' + http.address().port : base) + '/child?' + i + '-' + Date.now()
        const style = styles[i].css
        await script(
            parent,
            "(()=>{document.body.style.cssText='margin:0';" +
                'document.body.innerHTML=' +
                ('' +
                    JSON.stringify(
                        '<iframe id="frame' +
                            `${i}` +
                            '" src="' +
                            `${src}` +
                            '" style="position:absolute;width:400px;' +
                            'height:320px;border:0;left:100px;top:100px;' +
                            'transform-origin:0 0;' +
                            `${style}` +
                            '"></iframe>'
                    )) +
                ';return true})()'
        )
        const frames = await until(async () => {
            const frames = await worker(`coordinates.frames(${tabId})`)
            return frames.some((f) => f.url === src) && frames
        })
        parent = frames.find((f) => f.url === src).frameId
        frameIds.push(parent)
        await until(async () => await script(parent, 'document.readyState==="complete"'))
    }
    selectedFrame = parent
    await fixtureScript(`(${configure.toString()})()`)
    await script(0, `(${configure.toString()})()`)
    await fixtureScript(
        'document.visibilityState === "visible" ? ' +
            'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))) : true'
    )
    if (mode === 'cdp') {
        await session.selectPage(rootId)
        unified.activeMode = 'cdp'
        unified.cdpExplicitlySelected = true
    } else {
        unified.activeMode = 'extension'
        unified.cdpExplicitlySelected = false
        bridge.currentTabId = tabId
        bridge.currentFrameId = 0
    }
}
async function oracle(point = { x: 140, y: 110 }) {
    // Independent DOMMatrix composition uses each owner's actual computed CSS origin and layout in its parent document.
    let p = point
    for (let i = frameIds.length - 1; i >= 0; --i) {
        const parent = i === 0 ? 0 : frameIds[i - 1]
        p = await script(
            parent,
            "(()=>{const e=document.querySelector('#frame" +
                `${i}` +
                "'),s=getComputedStyle(e)," +
                "o=s.transformOrigin.split(' " +
                "').map(Number.parseFloat);const m=s.transform==='none'?new DOMMatrix():" +
                "e.computedStyleMap().get('transform').toMatrix();const z=Number(s.zoom)||1;const p=new " +
                'DOMPoint(' +
                `${p.x}` +
                '+e.clientLeft,' +
                `${p.y}` +
                '+e.clientTop);const v=m.transformPoint(new ' +
                'DOMPoint(p.x-o[0],p.y-o[1]));return ' +
                '{x:(e.offsetLeft+o[0]+v.x)*z-scrollX,' +
                'y:(e.offsetTop+o[1]+v.y)*z-scrollY}})()'
        )
    }
    return mode === 'cdp' ? { x: Math.round(p.x), y: Math.round(p.y) } : p
}
async function native(type, point, mask = 0, button = 'left') {
    ++result.nativeReferences
    const dispatch = async (params) => {
        ++result.nativeDispatches
        await observer.send('Input.dispatchMouseEvent', params, observerSession)
        result.nativeCommands.push({ method: 'Input.dispatchMouseEvent', params })
    }
    if (type === 'wheel') {
        await dispatch({ type: 'mouseWheel', ...point, deltaX: 0, deltaY: 120, modifiers: mask })
    } else if (type === 'mousemove') {
        await dispatch({ type: 'mouseMoved', ...point, modifiers: mask })
    } else {
        await dispatch({ type: 'mouseMoved', ...point, modifiers: mask })
        await dispatch({
            type: 'mousePressed',
            ...point,
            button,
            buttons: button === 'left' ? 1 : 2,
            clickCount: 1,
            modifiers: mask,
        })
        await dispatch({ type: 'mouseReleased', ...point, button, buttons: 0, clickCount: 1, modifiers: mask })
    }
    await delay(35)
}
function comparable(list) {
    return list.map(({ trusted: _trusted, ...event }) => event)
}
async function pageValue(expression) {
    ++result.observerReads
    const reply = await observer.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        observerSession
    )
    assert.equal(reply.exceptionDetails, undefined, JSON.stringify(reply.exceptionDetails))
    return reply.result.value
}
async function cspPage(strict) {
    frameSelection = undefined
    frameIds = []
    selectedFrame = 0
    const url = base + (strict ? '/csp-strict' : '/csp-allowed') + '?case=' + result.checks.length
    await observer.send('Page.navigate', { url }, observerSession)
    await until(() => pageValue(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`))
    await pageValue('(window.__cspActions=0,true)')
    if (mode === 'cdp') {
        await session.selectPage(rootId)
    } else {
        bridge.currentTabId = tabId
        bridge.currentFrameId = 0
    }
    unified.activeMode = mode
    unified.cdpExplicitlySelected = mode === 'cdp'
}
try {
    const port = await until(() => {
        try {
            return Number(
                fs.readFileSync(path.join(work, 'profile/DevToolsActivePort'), { encoding: 'utf8' }).split('\n')[0]
            )
        } catch {
            return false
        }
    })
    observer = new CDPClient()
    const version = await (await globalThis.fetch(`http://127.0.0.1:${port}/json/version`)).json()
    await observer.connect(version.webSocketDebuggerUrl)
    result.browser = await observer.send('Browser.getVersion')
    if (headful) {
        const protocol = await (await globalThis.fetch(`http://127.0.0.1:${port}/json/protocol`)).json()
        const createTarget = protocol.domains
            .find((domain) => domain.domain === 'Target')
            .commands.find((command) => command.name === 'createTarget')
        assert.ok(createTarget.parameters.some((parameter) => parameter.name === 'windowState'))
        const target = await observer.send('Target.createTarget', {
            url: base + '/',
            background: true,
            newWindow: true,
            windowState: 'minimized',
        })
        const { windowId } = await observer.send('Browser.getWindowForTarget', target)
        await observer.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
        result.headfulWindow = await until(async () => {
            const bounds = await observer.send('Browser.getWindowBounds', { windowId })
            return bounds.bounds.windowState === 'minimized' && { windowId, ...bounds }
        })
    }
    const page = (await observer.send('Target.getTargets')).targetInfos.find(
        (t) => t.type === 'page' && t.url === base + '/'
    )
    rootId = page.targetId
    observerSession = (await observer.send('Target.attachToTarget', { targetId: rootId, flatten: true })).sessionId
    const loaded = await pipe('Extensions.loadUnpacked', { path: extension })
    const target = await until(async () =>
        (await pipe('Target.getTargets')).targetInfos.find(
            (t) => t.type === 'service_worker' && t.url.includes(loaded.id)
        )
    )
    workerSession = (await pipe('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
    await until(() => worker('Boolean(globalThis.coordinates)'))
    const tab = await until(async () => (await worker('coordinates.tabs()')).find((t) => t.url === base + '/'))
    tabId = tab.id
    await worker(`coordinates.adopt(${tabId})`)
    await session.connect({ port, stealth: 'off' })
    await session.selectPage(rootId)
    const nativeSend = session.cdp.send.bind(session.cdp)
    session.cdp.send = async (...args) => {
        const value = await nativeSend(...args)
        if (args[0] === 'DOM.getBoxModel') {
            result.boxModels ??= []
            result.boxModels.push({ args, value })
        }
        return value
    }
    const send = session.cdp.ws.send.bind(session.cdp.ws)
    session.cdp.ws.send = (text, ...args) => {
        const command = JSON.parse(text)
        result.productionCommands.push(command)
        return send(text, ...args)
    }
    bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() })
    bridge.httpServer.helloReceived = true
    bridge.httpServer.clientSocket = { readyState: 1 }
    result.rpcReplies = []
    bridge.httpServer.sendMessage = (_socket, message) => {
        if (message.type === 'cancel') {
            return
        }
        const { action, params } = message
        ++result.bridgeCalls
        result.bridgeCommands.push({ action, params })
        void worker(
            '(async()=>{try{return {success:true,' +
                'data:await coordinates.command(' +
                `${JSON.stringify(action)}` +
                ',' +
                `${JSON.stringify(params)}` +
                ')}}catch(error){return {success:false,' +
                'error:error instanceof Error?error.message:Str' +
                'ing(error)}}})()'
        )
            .then((reply) => {
                const response = { id: message.id, ...reply }
                result.rpcReplies.push({ action, ...response })
                if (snapshotsUntilHold > 0 && action === 'page_snapshot' && reply.success) {
                    --snapshotsUntilHold
                    if (snapshotsUntilHold === 0) {
                        heldSnapshot = response
                        return
                    }
                }
                bridge.httpServer.handleMessage(JSON.stringify(response))
            })
            .catch((error) => {
                bridge.httpServer.handleMessage(
                    JSON.stringify({ id: message.id, success: false, error: String(error) })
                )
            })
    }
    unified.extensionBridge = bridge
    server = new McpServer({ name: 'coordinates-regression', version: '1.0.0' })
    const register = server.registerTool.bind(server)
    result.handlerRecords = []
    server.registerTool = (name, config, handler) =>
        register(name, config, async (args, extra) => {
            ++result.registeredCalls
            const entry = { name, requestId: extra.requestId, started: performance.now() }
            result.handlerRecords.push(entry)
            const aborted = () => {
                entry.aborted = performance.now()
            }
            extra.signal.addEventListener('abort', aborted, { once: true })
            try {
                const response = await handler(args, extra)
                entry.internalReply = payload(response)
                return response
            } finally {
                entry.finished = performance.now()
                extra.signal.removeEventListener('abort', aborted)
            }
        })
    registerInputTool(server)
    registerEvaluateTool(server)
    registerManageTool(server)
    registerLogsTool(server)
    const [a, b] = InMemoryTransport.createLinkedPair()
    const serverSend = a.send.bind(a)
    result.businessResponseIds = []
    a.send = (message, ...args) => {
        if (message.id !== undefined && !message.method) {
            result.businessResponseIds.push(message.id)
        }
        return serverSend(message, ...args)
    }
    client = new Client({ name: 'coordinates-regression-client', version: '1.0.0' })
    await server.connect(a)
    await client.connect(b)
    for (mode of process.env.COORD_MODE ? [process.env.COORD_MODE] : ['cdp', 'extension']) {
        await record('c31f9-download-local-attachment', async (entry) => {
            await setup()
            const directory = path.join(work, 'downloads-' + mode)
            fs.mkdirSync(directory)
            await pipe('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory })
            entry.watch = await invoke('manage', { action: 'download', download: { op: 'watch' } })
            assert.equal(entry.watch.success, true, JSON.stringify(entry.watch))
            try {
                await fixtureScript(
                    "(()=>{const a=document.createElement('a');" +
                        "a.id='owned-download';a.href=" +
                        `${JSON.stringify(base + '/owned-download')}` +
                        ";a.textContent='Download';" +
                        "a.style.cssText='position:absolute;left:80px;" +
                        "top:300px';document.body.append(a);return " +
                        'true})()'
                )
                entry.body = await call([{ type: 'click', target: { css: '#owned-download' } }])
                completed(entry.body, 1)
                await until(() => fs.existsSync(path.join(directory, 'owned-download.txt')))
                assert.equal(
                    fs.readFileSync(path.join(directory, 'owned-download.txt'), { encoding: 'utf8' }),
                    'owned download regression\n'
                )
                entry.logs = await until(async () => {
                    const observed = await invoke('logs', { type: 'download' })
                    return observed.logs.some((value) => value.kind === 'download' && value.state === 'completed')
                        ? observed
                        : false
                })
                assert.ok(entry.logs.count > 0, JSON.stringify(entry))
                assert.ok(
                    entry.logs.logs.some((value) => value.kind === 'download' && value.state === 'completed'),
                    JSON.stringify(entry)
                )
            } finally {
                entry.stop = await invoke('manage', { action: 'download', download: { op: 'stop' } })
            }
        })
        for (const inputMode of mode === 'extension' ? ['precise', 'stealth'] : ['precise']) {
            for (const framed of [false, true]) {
                if (mode === 'extension') {
                    if (inputMode === 'stealth') {
                        for (const consumer of [
                            { type: 'mousemove', target: { css: '#pad' } },
                            { type: 'click', button: 'right', target: { css: '#pad' } },
                            { type: 'touchstart', target: { css: '#pad' } },
                            { type: 'mousedown', target: { css: '#pad' } },
                        ]) {
                            await record(`c31f13-preparation-${framed}-${consumer.type}`, async (entry) => {
                                unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
                                await setup(framed ? [{ css: 'height:320px' }] : [])
                                entry.frame = frameSelection ?? null
                                await fixtureScript(
                                    '(() => {\n                                    ' +
                                        'window.__c31f13InputEvents=[];' +
                                        'window.__c31f13HelperOutputs=0;\n              ' +
                                        '                      for(const type of ' +
                                        "['mousemove','mousedown','mouseup'," +
                                        "'touchstart','click'])document.addEventListene" +
                                        'r(type,event=>window.__c31f13InputEvents.push(' +
                                        'event.type),{capture:true,' +
                                        'signal:window.__coordAbort.signal});\n         ' +
                                        '                           ' +
                                        'window.__c31f13Stringify=JSON.stringify;\n     ' +
                                        '                               ' +
                                        'JSON.stringify=(value,...args)=>{\n            ' +
                                        '                            if(value&&typeof ' +
                                        "value==='object'&&['x','y','width'," +
                                        "'height'].every(key=>Object.hasOwn(value," +
                                        'key))){\n                                      ' +
                                        '      ++window.__c31f13HelperOutputs;throw ' +
                                        "new Error('OWNED_COORDINATE_OUTPUT_FAILURE');\n" +
                                        '                                        }\n    ' +
                                        '                                    return ' +
                                        'window.__c31f13Stringify(value,...args);\n     ' +
                                        '                               };\n            ' +
                                        '                        return true;\n         ' +
                                        '                       })()'
                                )
                                try {
                                    entry.body = await call([consumer])
                                    entry.effects = await fixtureScript(
                                        '({events:window.__c31f13InputEvents,' +
                                            'helperOutputs:window.__c31f13HelperOutputs})'
                                    )
                                    assert.equal(entry.effects.helperOutputs, 1, JSON.stringify(entry))
                                    assert.deepEqual(entry.effects.events, [], JSON.stringify(entry))
                                    assert.equal(entry.body.actionExecuted, false, JSON.stringify(entry))
                                    assert.equal(entry.body.actionStatus, 'not_started', JSON.stringify(entry))
                                    assert.equal(entry.body.failureStage, 'context', JSON.stringify(entry))
                                    assert.equal(entry.body.eventsExecuted, 0, JSON.stringify(entry))
                                    assert.equal(entry.body.remainingEventsNotExecuted, 1, JSON.stringify(entry))
                                    assert.equal(entry.body.retryable, false, JSON.stringify(entry))
                                    assert.equal(
                                        entry.body.error.code,
                                        'NON_SERIALIZABLE_EVALUATE_RESULT',
                                        JSON.stringify(entry)
                                    )
                                    assert.match(
                                        entry.body.error.context.originalOutputError,
                                        /OWNED_COORDINATE_OUTPUT_FAILURE/
                                    )
                                } finally {
                                    await fixtureScript('(JSON.stringify=window.__c31f13Stringify,true)')
                                }
                            })
                        }
                    }
                    const controls = [
                        ...['input', 'textarea', 'select'].flatMap((tag) =>
                            ['ordinary', 'customized', 'fieldset', 'legend', 'adopted'].map((kind) => ({
                                tag,
                                kind,
                                accept: kind !== 'fieldset',
                            }))
                        ),
                        { tag: 'input', kind: 'file', accept: false },
                        { tag: 'input', kind: 'adopted-file', accept: false },
                        { tag: 'input', kind: 'readonly', accept: false },
                        { tag: 'textarea', kind: 'readonly', accept: false },
                        { tag: 'div', kind: 'container', accept: false },
                        { tag: 'div', kind: 'editable', accept: true },
                    ]
                    for (const control of controls) {
                        await record(
                            `c31f10-controlled-${inputMode}-${framed}-${control.kind}-${control.tag}`,
                            async (entry) => {
                                unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
                                await setup(framed ? [{ css: 'height:320px' }] : [])
                                entry.control = control
                                entry.frame = frameSelection ?? null
                                entry.before = await fixtureScript(
                                    '(async () => {\n                               ' +
                                        ' const {tag,kind}=' +
                                        `${JSON.stringify(control)}` +
                                        ';\n                                const ' +
                                        "adopted=kind.startsWith('adopted');\n          " +
                                        '                      let source=document,' +
                                        'foreign;\n                                ' +
                                        'if(adopted){\n                                 ' +
                                        "   const frame=document.createElement('iframe'" +
                                        ');frame.hidden=true;\n                         ' +
                                        '           const ready=new Promise(resolve=>' +
                                        'frame.onload=resolve);\n                       ' +
                                        "             frame.srcdoc='<!doctype html>" +
                                        "<body>owned source realm</body>';\n            " +
                                        '                        ' +
                                        'document.body.append(frame);await ready;\n     ' +
                                        '                               ' +
                                        'source=frame.contentDocument;' +
                                        'foreign=frame.contentWindow;\n                 ' +
                                        '               }\n                             ' +
                                        "   const Native=tag==='input'?window.HTMLInput" +
                                        "Element:tag==='textarea'?window.HTMLTextAreaEl" +
                                        'ement:window.HTMLSelectElement;\n              ' +
                                        '                  const ' +
                                        "name='owned-controlled-'+tag;\n                " +
                                        "                if(kind==='customized'&&!custo" +
                                        'mElements.get(name))customElements.define(name' +
                                        ',class extends Native{},{extends:tag});\n      ' +
                                        '                          const ' +
                                        'el=source.createElement(tag,' +
                                        "kind==='customized'?{is:name}:undefined);\n    " +
                                        '                            ' +
                                        "if(tag==='select')for(const value of ['old'," +
                                        "'updated']){\n                                 " +
                                        "   const option=source.createElement('option')" +
                                        ';option.value=value;option.textContent=value;' +
                                        'el.append(option);\n                           ' +
                                        '     }\n                                ' +
                                        "el.id='controlled-field';" +
                                        "el.style.cssText='display:block;" +
                                        "position:relative;margin:20px;width:140px';\n  " +
                                        '                              ' +
                                        "if(kind==='file'||kind==='adopted-file')el.typ" +
                                        "e='file';\n                                " +
                                        "else if(tag==='div')el.textContent='old';\n    " +
                                        '                            else ' +
                                        "el.value='old';\n                              " +
                                        "  if(kind==='readonly')el.readOnly=true;\n     " +
                                        '                           ' +
                                        "if(kind==='editable')el.contentEditable='true'" +
                                        ';\n                                ' +
                                        'if(adopted)document.adoptNode(el);\n           ' +
                                        "                     if(kind==='fieldset'||kin" +
                                        "d==='legend'){\n                               " +
                                        "     const fieldset=document.createElement('fi" +
                                        "eldset');fieldset.disabled=true;\n             " +
                                        "                       if(kind==='legend'){con" +
                                        "st legend=document.createElement('legend');" +
                                        'legend.append(el);fieldset.append(legend);}\n  ' +
                                        '                                  else ' +
                                        'fieldset.append(el);\n                         ' +
                                        '           document.body.append(fieldset);\n   ' +
                                        '                             }else ' +
                                        'document.body.append(el);\n                    ' +
                                        '            window.__controlledEvents=[];\n    ' +
                                        '                            for(const type of ' +
                                        "['focus','input','change'])el.addEventListener" +
                                        '(type,event=>window.__controlledEvents.push({t' +
                                        'ype:event.type,trusted:event.isTrusted}),' +
                                        '{capture:true,signal:window.__coordAbort.signa' +
                                        'l});\n                                const ' +
                                        "Foreign=foreign&&(tag==='input'?foreign.HTMLIn" +
                                        "putElement:tag==='textarea'?foreign.HTMLTextAr" +
                                        'eaElement:foreign.HTMLSelectElement);\n        ' +
                                        '                        return ' +
                                        '{tag:el.localName,namespace:el.namespaceURI,' +
                                        "value:tag==='div'?el.textContent:el.value,\n   " +
                                        '                                 ' +
                                        'ownDisabled:el.disabled,' +
                                        "effectiveDisabled:el.matches(':disabled'),\n   " +
                                        '                                 ' +
                                        'ownerDocumentMatches:el.ownerDocument===docume' +
                                        "nt,queryMatches:document.querySelector('#contr" +
                                        "olled-field')===el,\n                          " +
                                        '          localInstance:el instanceof Native,' +
                                        'foreignInstance:Foreign?el instanceof ' +
                                        'Foreign:null};\n                            ' +
                                        '})()'
                                )
                                if (control.kind.startsWith('adopted')) {
                                    assert.equal(entry.before.localInstance, false)
                                    assert.equal(entry.before.foreignInstance, true)
                                }
                                entry.body = await call([
                                    {
                                        type: 'type',
                                        mode: 'controlled',
                                        target: { css: '#controlled-field' },
                                        text: 'updated',
                                    },
                                ])
                                entry.after = await fixtureScript(
                                    '(() => {\n                                ' +
                                        "const el=document.querySelector('#controlled-f" +
                                        "ield');\n                                " +
                                        "return {value:el.localName==='div'?el.textCont" +
                                        'ent:el.value,events:window.__controlledEvents}' +
                                        ';\n                            })()'
                                )
                                assert.equal(entry.before.ownerDocumentMatches, true)
                                assert.equal(entry.before.queryMatches, true)
                                if (control.accept) {
                                    completed(entry.body, 1)
                                    assert.equal(entry.after.value, 'updated', JSON.stringify(entry))
                                    assert.deepEqual(
                                        entry.after.events
                                            .filter((event) => event.type !== 'focus')
                                            .map((event) => event.type),
                                        ['input', 'change']
                                    )
                                } else {
                                    assert.ok(entry.body.error, JSON.stringify(entry))
                                    assert.equal(entry.body.eventsExecuted, 0, JSON.stringify(entry))
                                    assert.equal(entry.after.value, entry.before.value, JSON.stringify(entry))
                                    assert.deepEqual(entry.after.events, [], JSON.stringify(entry))
                                }
                            }
                        )
                    }
                }
                await record(`c31f9-taginput-${inputMode}-${framed}`, async (entry) => {
                    unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
                    await setup(framed ? [{ css: 'height:320px' }] : [])
                    await fixtureScript(`(() => {
                        const field=document.createElement('input');field.id='tag-entry';
                        field.style.cssText='position:absolute;left:80px;top:60px';
                        const tags=document.createElement('div');tags.id='tags';
                        field.addEventListener('keydown',event=>{
                            if(event.key==='Enter'&&field.value){
                                event.preventDefault();
                                const tag=document.createElement('span');tag.dataset.value=field.value;
                                tag.textContent=field.value;tags.append(tag);field.value='';
                            }
                        },{signal:window.__coordAbort.signal});
                        document.body.replaceChildren(field,tags);return true;
                    })()`)
                    entry.body = await call(
                        [
                            { type: 'type', target: { css: '#tag-entry' }, text: '12345' },
                            { type: 'keydown', key: 'Enter' },
                            { type: 'keyup', key: 'Enter' },
                        ],
                        { timeout: 3000, postCondition: { selector: '#tags [data-value="12345"]' } }
                    )
                    completed(entry.body, 3)
                    assert.equal(entry.body.postCondition.matched, true, JSON.stringify(entry))
                    assert.equal(await fixtureScript('document.querySelector("#tags").textContent'), '12345')
                })
                for (const kind of ['tab', 'score']) {
                    await record(`c31f9-semantic-${inputMode}-${framed}-${kind}`, async (entry) => {
                        unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
                        await setup(framed ? [{ css: 'height:320px' }] : [])
                        entry.frame = frameSelection ?? null
                        await fixtureScript(
                            '(() => {\n                            const ' +
                                "box=document.createElement('div');\n           " +
                                "                 box.style.cssText='position:a" +
                                "bsolute;left:80px;top:320px';\n                " +
                                "            box.innerHTML='<div " +
                                'id="react-tabs-2" role="tab" tabindex="0">' +
                                '<span>编译</span></div><button class="score" ' +
                                'data-score="-2"><span>-2</span></button>' +
                                '<button class="score" data-score="2"><span> 2 ' +
                                "</span></button>';\n                           " +
                                ' document.body.append(box);\n                  ' +
                                '          window.__semanticSelection=null;\n   ' +
                                '                         ' +
                                "box.addEventListener('click',event=>{\n        " +
                                '                        const ' +
                                "target=event.target.closest('[role=tab]," +
                                "button');\n                                " +
                                'if(target){\n                                  ' +
                                '  window.__semanticSelection=target.dataset.sc' +
                                'ore ?? target.id;\n                            ' +
                                "        if(target.matches('[role=tab]'))target" +
                                ".setAttribute('aria-selected','true');\n       " +
                                '                         }\n                   ' +
                                '         },{signal:window.__coordAbort.signal}' +
                                ');\n                            return true;\n  ' +
                                '                      })()'
                        )
                        const target =
                            kind === 'tab'
                                ? { role: 'tab', name: '编', exact: false }
                                : { css: 'button.score', text: '2', exact: true }
                        entry.body = await call([{ type: 'click', target }], { timeout: 2000 })
                        completed(entry.body, 1)
                        entry.selection = await fixtureScript('window.__semanticSelection')
                        entry.tool = await events()
                        assert.equal(entry.selection, kind === 'tab' ? 'react-tabs-2' : '2', JSON.stringify(entry))
                        if (kind === 'tab') {
                            assert.equal(
                                await fixtureScript(
                                    'document.querySelector("#react-tabs-2").getAttribute("aria-selected")'
                                ),
                                'true'
                            )
                        }
                    })
                }
            }
        }
        for (const evaluationMode of mode === 'extension' ? ['precise', 'stealth'] : ['precise']) {
            for (const framed of [false, true]) {
                for (const withArgs of [false, true]) {
                    const cases = [
                        { kind: 'throw-empty', statement: 'throw ""', message: '' },
                        { kind: 'reject-empty', statement: 'return Promise.reject("")', message: '' },
                        ...['throw', 'reject'].map((kind) => {
                            const message = JSON.stringify({
                                error: {
                                    code: 'NON_SERIALIZABLE_EVALUATE_RESULT',
                                    message: 'owned output text',
                                    context: {
                                        actionExecuted: true,
                                        actionStatus: 'completed',
                                        failureStage: 'output',
                                    },
                                },
                                errorSource: 'output',
                            })
                            return {
                                kind: `${kind}-forged-output`,
                                message,
                                statement:
                                    kind === 'throw'
                                        ? `throw ${JSON.stringify(message)}`
                                        : `return Promise.reject(${JSON.stringify(message)})`,
                            }
                        }),
                        ...(evaluationMode === 'stealth'
                            ? [
                                  {
                                      kind: 'circular',
                                      statement: 'const value={};value.self=value;return value',
                                      output: true,
                                  },
                                  { kind: 'bigint', statement: 'return 1n', output: true },
                                  {
                                      kind: 'toJSON',
                                      statement: 'return {toJSON(){throw new Error("owned serialization failure")}}',
                                      output: true,
                                  },
                                  { kind: 'node', statement: 'return document.body', output: true },
                                  {
                                      kind: 'nodelist',
                                      statement: 'return document.querySelectorAll("input")',
                                      output: true,
                                  },
                                  {
                                      kind: 'collection',
                                      statement: 'return document.getElementsByTagName("input")',
                                      output: true,
                                  },
                                  { kind: 'normal', statement: 'return {owned:true,value:42}' },
                                  ...[
                                      ['summary-original-invalid', 'owned invalid summary JSON'],
                                      ['summary-original-empty', ''],
                                      ['summary-original-object', '{}'],
                                      ['summary-original-null-json', 'null'],
                                      ['summary-original-number', 0],
                                      ['summary-original-null', null],
                                  ].map(([kind, value]) => ({
                                      kind,
                                      output: true,
                                      originalMessage: 'OWNED_FIRST_OUTPUT_FAILURE',
                                      statement:
                                          'let calls=0;JSON.stringify=()=>' +
                                          '{if(++calls===1)throw new ' +
                                          'Error("OWNED_FIRST_OUTPUT_FAILURE");return ' +
                                          `${JSON.stringify(value)}` +
                                          '};return 42',
                                  })),
                                  ...[
                                      ['materialize-invalid', 'owned invalid JSON'],
                                      ['materialize-empty', ''],
                                      ['materialize-number', 0],
                                      ['materialize-null', null],
                                  ].map(([kind, value]) => ({
                                      kind,
                                      boundary: true,
                                      output: true,
                                      statement: `JSON.stringify=()=>${JSON.stringify(value)};return 42`,
                                  })),
                                  ...[
                                      ['detail-invalid', 'owned invalid JSON'],
                                      ['detail-empty', ''],
                                      ['detail-object', '{}'],
                                      ['detail-null', 'null'],
                                  ].map(([kind, value]) => ({
                                      kind,
                                      boundary: true,
                                      output: true,
                                      statement:
                                          'JSON.stringify=()=>' +
                                          `${JSON.stringify(value)}` +
                                          ';return document.querySelectorAll("input")',
                                  })),
                                  ...[
                                      ['return-undefined', 'return undefined', null],
                                      ['return-function', 'return function owned(){return 42}', null],
                                      ['return-zero', 'return 0', 0],
                                      ['return-false', 'return false', false],
                                      ['return-null', 'return null', null],
                                      ['return-empty', 'return ""', ''],
                                  ].map(([kind, statement, expected]) => ({
                                      kind,
                                      statement,
                                      expected,
                                      boundary: true,
                                      valueControl: true,
                                  })),
                                  {
                                      kind: 'summary-json',
                                      boundary: true,
                                      output: true,
                                      statement:
                                          'JSON.stringify=()=>{throw new Error(' +
                                          '"owned JSON serializer unavailable")};return 42',
                                  },
                                  {
                                      kind: 'get-prototype',
                                      boundary: true,
                                      output: true,
                                      statement:
                                          'return new Proxy({owned:true,value:42},' +
                                          '{getPrototypeOf(){throw new Error("owned ' +
                                          'prototype read")}})',
                                  },
                                  {
                                      kind: 'node-name',
                                      boundary: true,
                                      output: true,
                                      statement:
                                          'const value=document.createTextNode("owned");' +
                                          'Object.defineProperty(value,"nodeName",' +
                                          '{get(){throw new Error("owned nodeName ' +
                                          'read")}});return value',
                                  },
                                  {
                                      kind: 'parent-element',
                                      boundary: true,
                                      output: true,
                                      statement:
                                          'const value=document.createTextNode("owned");' +
                                          'Object.defineProperty(value,"parentElement",' +
                                          '{get(){throw new Error("owned parentElement ' +
                                          'read")}});return value',
                                  },
                                  {
                                      kind: 'node-list-constructor',
                                      boundary: true,
                                      output: true,
                                      statement:
                                          'const value=document.querySelectorAll("input")' +
                                          ';Object.defineProperty(value,"constructor",' +
                                          '{get(){throw new Error("owned NodeList ' +
                                          'constructor read")}});return value',
                                  },
                                  {
                                      kind: 'collection-constructor',
                                      boundary: true,
                                      output: true,
                                      statement:
                                          'const value=document.getElementsByTagName("inp' +
                                          'ut");Object.defineProperty(value,' +
                                          '"constructor",{get(){throw new Error("owned ' +
                                          'HTMLCollection constructor read")}});return ' +
                                          'value',
                                  },
                                  {
                                      kind: 'revoked-proxy',
                                      boundary: true,
                                      messagePattern: 'revoked',
                                      statement: 'const pair=Proxy.revocable({},{});pair.revoke();return pair.proxy',
                                  },
                              ]
                            : []),
                    ]
                    for (const spec of cases) {
                        await record(
                            '' +
                                `${spec.originalMessage ? 'c31f13' : spec.boundary ? 'c31f12' : 'c31f11'}` +
                                '-output-' +
                                `${evaluationMode}` +
                                '-' +
                                `${framed}` +
                                '-' +
                                `${withArgs}` +
                                '-' +
                                `${spec.kind}` +
                                '',
                            async (entry) => {
                                await cspPage(false)
                                await setup(framed ? [{ css: 'height:320px' }] : [])
                                entry.frame = frameSelection ?? null
                                await fixtureScript('(window.__outputActions=0,true)')
                                const fn = `function(){window.__outputActions++;${spec.statement};}`
                                entry.body = await invoke('evaluate', {
                                    mode: evaluationMode,
                                    script: withArgs ? fn : `(${fn})()`,
                                    ...(withArgs ? { args: [] } : {}),
                                })
                                entry.actions = await fixtureScript('window.__outputActions')
                                assert.equal(entry.actions, 1, JSON.stringify(entry))
                                assert.equal(entry.body.actionExecuted, true, JSON.stringify(entry))
                                assert.equal(entry.body.retryable, false, JSON.stringify(entry))
                                if (spec.originalMessage) {
                                    assert.match(
                                        entry.body.error.context.originalOutputError,
                                        new RegExp(spec.originalMessage)
                                    )
                                }
                                if (spec.output) {
                                    assert.equal(
                                        entry.body.error.code,
                                        'NON_SERIALIZABLE_EVALUATE_RESULT',
                                        JSON.stringify(entry)
                                    )
                                    assert.equal(entry.body.actionStatus, 'completed', JSON.stringify(entry))
                                    assert.equal(entry.body.failureStage, 'output', JSON.stringify(entry))
                                } else if (spec.valueControl) {
                                    assert.equal(entry.body.success, true, JSON.stringify(entry))
                                    assert.equal(entry.body.actionStatus, 'completed', JSON.stringify(entry))
                                    assert.equal(entry.body.result, spec.expected, JSON.stringify(entry))
                                } else if (spec.kind === 'normal') {
                                    assert.equal(entry.body.success, true, JSON.stringify(entry))
                                    assert.equal(entry.body.actionStatus, 'completed', JSON.stringify(entry))
                                    assert.deepEqual(entry.body.result, { owned: true, value: 42 })
                                } else {
                                    assert.equal(entry.body.error.code, 'UNKNOWN_ERROR', JSON.stringify(entry))
                                    if (spec.messagePattern) {
                                        assert.match(
                                            entry.body.error.message,
                                            new RegExp(spec.messagePattern),
                                            JSON.stringify(entry)
                                        )
                                    } else {
                                        assert.equal(entry.body.error.message, spec.message, JSON.stringify(entry))
                                    }
                                    assert.equal(entry.body.actionStatus, 'failed', JSON.stringify(entry))
                                }
                            }
                        )
                    }
                    for (const reject of [false, true]) {
                        await record(
                            `c31f10-primitive-${evaluationMode}-${framed}-${withArgs}-${reject}`,
                            async (entry) => {
                                await cspPage(false)
                                await setup(framed ? [{ css: 'height:320px' }] : [])
                                entry.frame = frameSelection ?? null
                                await fixtureScript('(window.__primitiveActions=0,true)')
                                const message = 'CSP primitive business text'
                                const body = reject
                                    ? `return Promise.reject(${JSON.stringify(message)})`
                                    : `throw ${JSON.stringify(message)}`
                                const fn = `function(){window.__primitiveActions++;${body};}`
                                entry.body = await invoke('evaluate', {
                                    mode: evaluationMode,
                                    script: withArgs ? fn : `(${fn})()`,
                                    ...(withArgs ? { args: [] } : {}),
                                })
                                entry.actions = await fixtureScript('window.__primitiveActions')
                                assert.equal(entry.actions, 1, JSON.stringify(entry))
                                assert.equal(entry.body.error.code, 'UNKNOWN_ERROR', JSON.stringify(entry))
                                assert.equal(entry.body.error.message, message, JSON.stringify(entry))
                                assert.equal(entry.body.actionExecuted, true, JSON.stringify(entry))
                                assert.equal(entry.body.actionStatus, 'failed', JSON.stringify(entry))
                                assert.equal(entry.body.retryable, false, JSON.stringify(entry))
                            }
                        )
                    }
                }
            }
            for (const message of [
                'CSP business failure',
                'Content Security Policy business failure',
                "'unsafe-eval' business failure",
                'ordinary business failure',
                'Execution was terminated',
            ]) {
                for (const reject of [false, true]) {
                    for (const withArgs of [false, true]) {
                        await record(
                            `c31f9-csp-page-${evaluationMode}-${message}-${reject}-${withArgs}`,
                            async (entry) => {
                                await cspPage(false)
                                const body = reject
                                    ? `return Promise.reject(new Error(${JSON.stringify(message)}))`
                                    : `throw new Error(${JSON.stringify(message)})`
                                const fn = `function(){window.__cspActions++;${body}}`
                                entry.body = await invoke('evaluate', {
                                    mode: evaluationMode,
                                    script: withArgs ? fn : `(${fn})()`,
                                    ...(withArgs ? { args: [] } : {}),
                                })
                                entry.actions = await pageValue('window.__cspActions')
                                assert.equal(entry.actions, 1, JSON.stringify(entry))
                                assert.equal(entry.body.actionExecuted, true, JSON.stringify(entry))
                                assert.equal(entry.body.actionStatus, 'failed', JSON.stringify(entry))
                                assert.notEqual(entry.body.error.code, 'CSP_BLOCKED', JSON.stringify(entry))
                                assert.ok(entry.body.error.message.includes(message), JSON.stringify(entry))
                                assert.equal(entry.body.retryable, false)
                            }
                        )
                    }
                }
            }
            for (const value of ['CSP result', 'Content Security Policy result']) {
                await record(`c31f9-csp-result-${evaluationMode}-${value}`, async (entry) => {
                    await cspPage(false)
                    entry.body = await invoke('evaluate', { mode: evaluationMode, script: JSON.stringify(value) })
                    assert.equal(entry.body.actionStatus, 'completed', JSON.stringify(entry))
                    assert.equal(entry.body.result, value, JSON.stringify(entry))
                })
            }
            for (const withArgs of [false, true]) {
                await record(`c31f9-csp-policy-${evaluationMode}-${withArgs}`, async (entry) => {
                    await cspPage(true)
                    const fn =
                        evaluationMode === 'stealth'
                            ? 'function(){window.__cspActions++;return 42}'
                            : 'function(){window.__cspActions++;return new ' +
                              'Promise((resolve,reject)=>setTimeout(()=>' +
                              '{try{resolve(eval("42"))}catch(error){reject(e' +
                              'rror)}},0))}'
                    entry.body = await invoke('evaluate', {
                        mode: evaluationMode,
                        script: withArgs ? fn : `(${fn})()`,
                        ...(withArgs ? { args: [] } : {}),
                    })
                    entry.actions = await pageValue('window.__cspActions')
                    assert.equal(entry.body.retryable, false, JSON.stringify(entry))
                    if (evaluationMode === 'stealth') {
                        assert.equal(entry.actions, 0, JSON.stringify(entry))
                        assert.equal(entry.body.error.code, 'CSP_BLOCKED', JSON.stringify(entry))
                        assert.equal(entry.body.actionExecuted, false)
                        assert.equal(entry.body.actionStatus, 'not_started')
                    } else {
                        assert.equal(entry.actions, 1, JSON.stringify(entry))
                        assert.equal(entry.body.actionExecuted, true)
                        assert.equal(entry.body.actionStatus, 'failed', JSON.stringify(entry))
                        assert.notEqual(entry.body.error.code, 'CSP_BLOCKED', JSON.stringify(entry))
                        assert.match(entry.body.error.message, /unsafe-eval|Content Security Policy/i)
                    }
                })
            }
        }
        await observer.send('Page.navigate', { url: base + '/' }, observerSession)
        await until(() =>
            pageValue(`location.href === ${JSON.stringify(base + '/')} && document.readyState === "complete"`)
        )
        if (mode === 'extension') {
            let visibilityBackground
            for (const inputMode of ['precise', 'stealth']) {
                for (const framed of [false, true]) {
                    for (const states of [
                        ['visible', 'hidden'],
                        ['hidden', 'visible'],
                        ['visible', 'hidden', 'visible'],
                        ['hidden', 'visible', 'hidden'],
                    ]) {
                        for (const action of ['mousemove', 'down-up']) {
                            await record(
                                `c31f9-visibility-${inputMode}-${framed}-${states.join('-')}-${action}`,
                                async (entry) => {
                                    visibilityBackground ??= await worker(
                                        'chrome.tabs.create({url:' +
                                            `${JSON.stringify(base + '/visibility-background')}` +
                                            ',active:false})'
                                    )
                                    const setVisibility = async (state) => {
                                        await worker(
                                            'chrome.tabs.update(' +
                                                `${state === 'visible' ? tabId : visibilityBackground.id}` +
                                                ',{active:true})'
                                        )
                                        await until(() =>
                                            fixtureScript(`document.visibilityState === ${JSON.stringify(state)}`)
                                        )
                                    }
                                    await worker(`chrome.tabs.update(${tabId},{active:true})`)
                                    await setup(framed ? [{ css: 'height:320px' }] : [])
                                    entry.frame = frameSelection ?? null
                                    await setVisibility(states[0])
                                    unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
                                    await fixtureScript(
                                        '(() => {\n                                    ' +
                                            "document.body.style.minHeight='3000px';" +
                                            'window.__coordCaptureRects=true;\n             ' +
                                            '                       const ' +
                                            "pad=document.querySelector('#pad');" +
                                            "pad.style.cssText='position:absolute;" +
                                            'left:80px;top:2100px;width:80px;height:70px;' +
                                            "margin:0';\n                                   " +
                                            ' window.__visStates=[{state:document.visibilit' +
                                            'yState,time:performance.now()}];\n             ' +
                                            '                       window.__visStarted=fal' +
                                            'se;window.__visReady=false;' +
                                            'window.__visHeldFrames=0;' +
                                            'window.__visHeldMessages=0;\n                  ' +
                                            '                  window.__visReleaseFrame=und' +
                                            'efined;window.__visMessages=[];\n              ' +
                                            '                      const ' +
                                            'nativeRAF=window.requestAnimationFrame.bind(wi' +
                                            'ndow), NativeChannel=window.MessageChannel;\n  ' +
                                            '                                  ' +
                                            'window.__visRestore=()=>' +
                                            '{window.requestAnimationFrame=nativeRAF;' +
                                            'window.MessageChannel=NativeChannel};\n        ' +
                                            '                            ' +
                                            "document.addEventListener('visibilitychange'," +
                                            '()=>{\n                                        ' +
                                            'window.__visStates.push({state:document.visibi' +
                                            'lityState,time:performance.now()});\n          ' +
                                            '                              ' +
                                            "pad.style.left='240px';\n                      " +
                                            '                  if(document.visibilityState=' +
                                            "=='visible') nativeRAF(()=>" +
                                            "{pad.style.left='280px'});\n                   " +
                                            '                 },{signal:window.__coordAbort' +
                                            '.signal});\n                                   ' +
                                            ' window.requestAnimationFrame=callback=>{\n    ' +
                                            '                                    const ' +
                                            'id=nativeRAF(time=>{\n                         ' +
                                            '                   if(window.__visReady) ' +
                                            'callback(time);\n                              ' +
                                            '              else {window.__visHeldFrames++;' +
                                            'window.__visReleaseFrame=()=>' +
                                            'nativeRAF(callback)}\n                         ' +
                                            '               });\n                           ' +
                                            '             window.__visStarted=true;return ' +
                                            'id;\n                                    };\n   ' +
                                            '                                 ' +
                                            'window.MessageChannel=function(){\n            ' +
                                            '                            const channel=new ' +
                                            'NativeChannel(), post=channel.port2.postMessag' +
                                            'e.bind(channel.port2);\n                       ' +
                                            '                 channel.port2.postMessage=val' +
                                            'ue=>{\n                                        ' +
                                            '    if(!window.__visReady){window.__visStarted' +
                                            '=true;window.__visHeldMessages++;' +
                                            'window.__visMessages.push(()=>post(value))}\n  ' +
                                            '                                          ' +
                                            'else post(value);\n                            ' +
                                            '            };return channel;\n                ' +
                                            '                    };\n                       ' +
                                            '             return true;\n                    ' +
                                            '            })()'
                                    )
                                    const sequence =
                                        action === 'down-up'
                                            ? [{ type: 'mousedown', target: { css: '#pad' } }, { type: 'mouseup' }]
                                            : [{ type: 'mousemove', target: { css: '#pad' } }]
                                    const first = (await worker('coordinates.nativeInputs()')).length
                                    let pending
                                    let settled = false
                                    await fixtureScript(
                                        `(window.__coordCaptureTimes=true,(${observeSettlementResources.toString()})())`
                                    )
                                    try {
                                        pending = call(sequence, { timeout: 2000 })
                                        void pending.then(
                                            () => {
                                                settled = true
                                            },
                                            () => {
                                                settled = true
                                            }
                                        )
                                        await until(() => fixtureScript('window.__visStarted'))
                                        entry.preparation = await fixtureScript(
                                            '({time:performance.now(),visibility:document.visibilityState})'
                                        )
                                        assert.equal(settled, false, JSON.stringify(entry))
                                        for (const state of states.slice(1)) {
                                            await setVisibility(state)
                                        }
                                        if (!settled) {
                                            await fixtureScript(
                                                '(()=>{window.__visReady=true;for(const post ' +
                                                    'of window.__visMessages)post();' +
                                                    'window.__visMessages=[];' +
                                                    "if(document.visibilityState==='visible')window" +
                                                    '.__visReleaseFrame?.();return true})()'
                                            )
                                        }
                                        entry.body = await pending
                                        entry.tool = await events()
                                        entry.inputs = (await worker('coordinates.nativeInputs()')).slice(first)
                                        entry.visibility = await fixtureScript(
                                            '({states:__visStates,heldFrames:__visHeldFrame' +
                                                's,heldMessages:__visHeldMessages,' +
                                                'final:document.visibilityState,time:performance.now(),' +
                                                'rect:document.querySelector("#pad").getBoundingClientRect().toJSON()})'
                                        )
                                        entry.settlementResources = await fixtureScript('window.__coordResources()')
                                        assert.deepEqual(entry.settlementResources.listeners, [], JSON.stringify(entry))
                                        assert.ok(entry.settlementResources.ports.length > 0, JSON.stringify(entry))
                                        assert.ok(entry.settlementResources.ports.every(Boolean), JSON.stringify(entry))
                                        assert.equal(
                                            entry.settlementResources.framesRemaining,
                                            0,
                                            JSON.stringify(entry)
                                        )
                                        assert.equal(
                                            entry.settlementResources.timersRemaining,
                                            0,
                                            JSON.stringify(entry)
                                        )
                                        assert.equal(entry.visibility.final, states.at(-1))
                                        assert.deepEqual(
                                            entry.visibility.states.map((value) => value.state),
                                            states,
                                            JSON.stringify(entry)
                                        )
                                        assert.ok(entry.preparation.time <= entry.visibility.states[1].time)
                                        assert.ok(
                                            entry.visibility.states.every(
                                                (value, index, values) =>
                                                    index === 0 || value.time >= values[index - 1].time
                                            )
                                        )
                                        for (const event of entry.tool) {
                                            assert.ok(event.time >= entry.visibility.states.at(-1).time)
                                            assert.equal(event.visibility, states.at(-1))
                                        }
                                        assert.notEqual(entry.body.error?.code, 'TIMEOUT', JSON.stringify(entry))
                                        assert.doesNotMatch(
                                            entry.body.error?.message ?? '',
                                            /SCROLL_SETTLEMENT_TIMEOUT/
                                        )
                                        if (entry.body.actionStatus === 'completed') {
                                            completed(entry.body, sequence.length)
                                            const type = action === 'down-up' ? 'mousedown' : 'mousemove'
                                            const event = entry.tool.find((value) => value.type === type)
                                            assert.ok(event, JSON.stringify(entry))
                                            assert.equal(event.target, 'pad', JSON.stringify(entry))
                                            assert.ok(
                                                Math.abs(event.x - (event.targetRect.x + event.targetRect.width / 2)) <=
                                                    1,
                                                JSON.stringify(entry)
                                            )
                                            assert.ok(
                                                Math.abs(
                                                    event.y - (event.targetRect.y + event.targetRect.height / 2)
                                                ) <= 1,
                                                JSON.stringify(entry)
                                            )
                                        } else {
                                            assert.equal(inputMode, 'precise', JSON.stringify(entry))
                                            assert.equal(
                                                entry.body.error.code,
                                                'NATIVE_INPUT_UNAVAILABLE',
                                                JSON.stringify(entry)
                                            )
                                            assert.equal(entry.body.actionExecuted, false)
                                            assert.equal(entry.body.eventsExecuted, 0)
                                            assert.deepEqual(entry.inputs, [])
                                            assert.deepEqual(entry.tool, [])
                                        }
                                        await clear()
                                        entry.oracle = await oracle({
                                            x: entry.visibility.rect.x + entry.visibility.rect.width / 2,
                                            y: entry.visibility.rect.y + entry.visibility.rect.height / 2,
                                        })
                                        await native(action, entry.oracle)
                                        entry.reference = await events()
                                        const reference = entry.reference.find(
                                            (event) => event.type === (action === 'down-up' ? 'mousedown' : 'mousemove')
                                        )
                                        assert.equal(reference?.target, 'pad', JSON.stringify(entry))
                                        assert.equal(reference.trusted, true)
                                        assert.equal(reference.visibility, states.at(-1))
                                    } finally {
                                        await fixtureScript(
                                            '(window.__coordRestoreResources(),window.__visRestore(),true)'
                                        )
                                        await pending?.catch(() => {})
                                        await worker(`chrome.tabs.update(${tabId},{active:true})`)
                                    }
                                }
                            )
                        }
                    }
                }
            }
            if (visibilityBackground) {
                await worker(`chrome.tabs.remove(${visibilityBackground.id})`)
            }
            for (const inputMode of ['precise', 'stealth']) {
                for (const framed of [false, true]) {
                    for (const observation of [
                        'foreign-shadow',
                        'early-capture',
                        'unrelated-scroll',
                        'dynamic-shadow',
                        'repeated-source',
                        'sync-unrelated',
                        'unrelated-reused',
                        'sync-unrelated-cancel',
                    ]) {
                        const cancel = observation === 'sync-unrelated-cancel'
                        const scene = cancel ? 'sync-unrelated' : observation
                        for (const action of ['mousemove', 'down-up']) {
                            await record(
                                [
                                    scene === 'sync-unrelated'
                                        ? 'c31f13'
                                        : ['dynamic-shadow', 'repeated-source', 'unrelated-reused'].includes(scene)
                                          ? 'c31f12'
                                          : 'c31f11',
                                    cancel ? 'cancel' : 'observation',
                                    inputMode,
                                    framed,
                                    observation,
                                    action,
                                ].join('-'),
                                async (entry) => {
                                    unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
                                    await setup(framed ? [{ css: 'height:320px' }] : [])
                                    entry.frame = frameSelection ?? null
                                    entry.before = await fixtureScript(
                                        '(() => {\n                                    ' +
                                            'document.body.innerHTML=\'<div id="outer" ' +
                                            'style="position:absolute;left:10px;top:20px;' +
                                            'width:380px;height:250px;overflow:auto"><div ' +
                                            'style="position:relative;width:360px;' +
                                            'height:1200px"><div id="inner" ' +
                                            'style="position:absolute;left:0;top:20px;' +
                                            'width:350px;height:150px;overflow:auto"><div ' +
                                            'style="position:relative;width:330px;' +
                                            'height:3500px"><input id="pad" ' +
                                            'type="checkbox" style="position:absolute;' +
                                            'left:50px;top:2100px;width:60px;height:50px;' +
                                            'margin:0"></div></div></div></div><div ' +
                                            'id="other-root" style="position:fixed;' +
                                            'left:1000px;top:10px"></div>\';\n               ' +
                                            '                     document.body.style.cssTe' +
                                            "xt='margin:0;min-height:900px';\n              " +
                                            '                      const scene=' +
                                            `${JSON.stringify(scene === 'unrelated-reused' ? 'unrelated-scroll' : scene)}` +
                                            ",pad=document.querySelector('#pad')," +
                                            "inner=document.querySelector('#inner');\n      " +
                                            '                              const ' +
                                            "host=document.querySelector('#other-root');\n  " +
                                            '                                  const ' +
                                            "root=scene==='foreign-shadow'?host.attachShado" +
                                            "w({mode:'open'}):host;\n                       " +
                                            '             root.innerHTML=\'<div id="second" ' +
                                            'style="width:100px;height:100px;' +
                                            'overflow:auto"><div style="height:1000px;' +
                                            'width:50px"></div></div><div id="third" ' +
                                            'style="width:100px;height:100px;' +
                                            'overflow:auto"><div style="height:1000px;' +
                                            'width:50px"></div></div>\';\n                   ' +
                                            '                 const second=root.querySelect' +
                                            "or('#second'),third=root.querySelector('#third" +
                                            "'),signal=window.__coordAbort.signal;\n        " +
                                            '                            ' +
                                            'window.__cascadeTrace=[];' +
                                            'window.__coordCaptureRects=true;' +
                                            'window.__unrelatedFrame=undefined;' +
                                            'window.__cascadeDone=false;\n                  ' +
                                            '                  const log=name=>{const ' +
                                            'r=pad.getBoundingClientRect();' +
                                            'window.__cascadeTrace.push({name,' +
                                            'time:performance.now(),x:r.x,y:r.y,' +
                                            'inner:inner.scrollTop,second:second.scrollTop,' +
                                            'third:third.scrollTop,sourceRoot:second.getRoo' +
                                            'tNode().constructor.name})};\n                 ' +
                                            '                   const final=()=>' +
                                            "{pad.style.left='220px';" +
                                            "window.__cascadeDone=true;log('final-after')};" +
                                            '\n                                    ' +
                                            "second.addEventListener('scroll',()=>" +
                                            "log('second-capture'),{capture:true,signal});\n" +
                                            '                                    ' +
                                            "second.addEventListener('scrollend',()=>" +
                                            "log('second-end'),{capture:true,signal});\n    " +
                                            '                                ' +
                                            "if(scene==='early-capture')document.addEventLi" +
                                            "stener('scroll',event=>{\n                     " +
                                            '                   if(event.target===second){l' +
                                            "og('second');third.scrollTop=70;" +
                                            'event.stopImmediatePropagation()}\n            ' +
                                            '                            ' +
                                            'if(event.target===third){final();' +
                                            'event.stopImmediatePropagation()}\n            ' +
                                            '                        },{capture:true,' +
                                            'signal});\n                                    ' +
                                            'else {\n                                       ' +
                                            ' let repeats=0;\n                              ' +
                                            "          second.addEventListener('scroll'," +
                                            '()=>{\n                                        ' +
                                            "    log('second');\n                           " +
                                            "                 if(scene==='foreign-shadow'||" +
                                            "scene==='dynamic-shadow')third.scrollTop=70;\n " +
                                            '                                           ' +
                                            "if(scene==='repeated-source'){if(++repeats<4)s" +
                                            'econd.scrollTop+=10;else final()}\n            ' +
                                            '                                ' +
                                            "if(scene==='sync-unrelated'&&window.__syncUnre" +
                                            'lated)second.scrollTop=second.scrollTop===60?7' +
                                            '0:60;\n                                        ' +
                                            "},{once:!['repeated-source'," +
                                            "'sync-unrelated'].includes(scene),signal});\n  " +
                                            '                                      ' +
                                            "third.addEventListener('scroll',final," +
                                            '{once:true,signal});\n                         ' +
                                            '           }\n                                 ' +
                                            "   inner.addEventListener('scroll',()=>{\n     " +
                                            '                                   ' +
                                            "log('inner');\n                                " +
                                            "        if(scene==='dynamic-shadow'){host.atta" +
                                            "chShadow({mode:'open'}).append(second,third);" +
                                            "log('root-created')}\n                         " +
                                            "               if(scene==='unrelated-scroll'){" +
                                            '\n                                            ' +
                                            'final();let next=60;\n                         ' +
                                            '                   const tick=()=>' +
                                            '{second.scrollTop=next;next=next===60?70:60;' +
                                            "log('unrelated');window.__unrelatedFrame=reque" +
                                            'stAnimationFrame(tick)};\n                     ' +
                                            '                       window.__unrelatedFrame' +
                                            '=requestAnimationFrame(tick);\n                ' +
                                            '                        }else ' +
                                            "if(scene==='sync-unrelated'){\n                " +
                                            '                            final();' +
                                            'window.__syncUnrelated=true;' +
                                            'second.scrollTop=60;\n                         ' +
                                            '               }else second.scrollTop=60;\n    ' +
                                            '                                },{once:true,' +
                                            'signal});\n                                    ' +
                                            "signal.addEventListener('abort',()=>" +
                                            '{window.__syncUnrelated=false;' +
                                            'cancelAnimationFrame(window.__unrelatedFrame)}' +
                                            ',{once:true});\n                               ' +
                                            "     for(const type of ['mousemove'," +
                                            "'mousedown','mouseup'])document.addEventListen" +
                                            'er(type,()=>log(type),{capture:true,signal});\n' +
                                            '                                    ' +
                                            "log('configured');return " +
                                            '{visibility:document.visibilityState,' +
                                            'foreignRoot:second.getRootNode()!==document,' +
                                            'rect:pad.getBoundingClientRect().toJSON()};\n  ' +
                                            '                              })()'
                                    )
                                    if (observation === 'unrelated-reused') {
                                        await fixtureScript(`(() => {
                                            const second=document.querySelector('#second');
                                            const reused=new Event('scroll');
                                            window.__reusedScrollEvents=[];
                                            second.addEventListener('scroll',event=>{
                                                if(event===reused)window.__reusedScrollEvents.push({
                                                    trusted:event.isTrusted,stamp:event.timeStamp,
                                                    offset:second.scrollTop,time:performance.now()});
                                                else if(event.isTrusted){
                                                    second.dispatchEvent(reused);second.dispatchEvent(reused);
                                                }
                                            },{signal:window.__coordAbort.signal});
                                            return true;
                                        })()`)
                                    }
                                    const sequence =
                                        action === 'down-up'
                                            ? [{ type: 'mousedown', target: { css: '#pad' } }, { type: 'mouseup' }]
                                            : [{ type: 'mousemove', target: { css: '#pad' } }]
                                    await fixtureScript(
                                        '(() => {\n                                     ' +
                                            '   const add=EventTarget.prototype.addEventLis' +
                                            'tener,remove=EventTarget.prototype.removeEvent' +
                                            'Listener,NativeChannel=window.MessageChannel;\n' +
                                            '                                        const ' +
                                            'listeners=[],ports=[];\n                       ' +
                                            '                 EventTarget.prototype.addEven' +
                                            'tListener=function(type,listener,...rest){\n   ' +
                                            '                                         ' +
                                            "if(['scroll','scrollend'," +
                                            "'visibilitychange'].includes(type))listeners.p" +
                                            'ush({target:this,type,listener});\n            ' +
                                            '                                return ' +
                                            'add.call(this,type,listener,...rest);\n        ' +
                                            '                                };\n           ' +
                                            '                             ' +
                                            'EventTarget.prototype.removeEventListener=func' +
                                            'tion(type,listener,...rest){\n                 ' +
                                            '                           const ' +
                                            'index=listeners.findIndex(value=>' +
                                            'value.target===this&&value.type===type&&value.' +
                                            'listener===listener);\n                        ' +
                                            '                    if(index>' +
                                            '=0)listeners.splice(index,1);\n                ' +
                                            '                            return ' +
                                            'remove.call(this,type,listener,...rest);\n     ' +
                                            '                                   };\n        ' +
                                            '                                ' +
                                            'window.MessageChannel=function(){\n            ' +
                                            '                                const ' +
                                            'channel=new NativeChannel();\n                 ' +
                                            '                           for(const port of ' +
                                            '[channel.port1,channel.port2]){\n              ' +
                                            '                                  const ' +
                                            'close=port.close.bind(port),' +
                                            'record={closed:false};ports.push(record);\n    ' +
                                            '                                            ' +
                                            'port.close=()=>{record.closed=true;close()};\n ' +
                                            '                                           }\n ' +
                                            '                                           ' +
                                            'return channel;\n                              ' +
                                            '          };\n                                 ' +
                                            '       window.__settlementResources=()=>{\n    ' +
                                            '                                        ' +
                                            'EventTarget.prototype.addEventListener=add;' +
                                            'EventTarget.prototype.removeEventListener=remo' +
                                            've;window.MessageChannel=NativeChannel;\n      ' +
                                            '                                      return ' +
                                            '{listeners:listeners.map(value=>value.type),' +
                                            'ports:ports.map(value=>value.closed)};\n       ' +
                                            '                                 };\n          ' +
                                            '                              return true;\n   ' +
                                            '                                 })()'
                                    )
                                    const firstNative = (await worker('coordinates.nativeInputs()')).length
                                    try {
                                        if (cancel) {
                                            const controller = new AbortController()
                                            const originalCommand = bridge.httpServer.sendCommand
                                            const recordStart = result.handlerRecords.length
                                            let releasePreparation
                                            let pendingCall
                                            bridge.httpServer.sendCommand = async (name, params, timeout, ...args) => {
                                                const answer = await originalCommand.call(
                                                    bridge.httpServer,
                                                    name,
                                                    params,
                                                    timeout,
                                                    ...args
                                                )
                                                if (
                                                    !releasePreparation &&
                                                    (['evaluate', 'evaluate_in_frame'].includes(name) ||
                                                        (name === 'debugger_send' &&
                                                            params.method === 'Runtime.evaluate'))
                                                ) {
                                                    entry.preparationHeldAt = performance.now()
                                                    const scope = unified.tabLockContext.getStore()
                                                    return withNavigationBudget(
                                                        () =>
                                                            new Promise((resolve) => {
                                                                releasePreparation = () => resolve(answer)
                                                            }),
                                                        Math.min(Date.now() + timeout, scope.deadline),
                                                        scope.signal
                                                    )
                                                }
                                                return answer
                                            }
                                            try {
                                                pendingCall = call(
                                                    sequence,
                                                    { timeout: 1200 },
                                                    {
                                                        signal: controller.signal,
                                                    }
                                                ).then(
                                                    (response) => ({ response }),
                                                    (error) => ({ cancelled: String(error) })
                                                )
                                                await until(() => entry.preparationHeldAt)
                                                entry.loadAtCancel = await fixtureScript(
                                                    '({active:window.__syncUnrelated,' +
                                                        'scrolls:window.__cascadeTrace.filter(event=>event.name==="second").length})'
                                                )
                                                assert.equal(entry.loadAtCancel.active, true)
                                                assert.ok(entry.loadAtCancel.scrolls > 0)
                                                controller.abort(new Error('SDK cancellation after scroll preparation'))
                                                entry.clientOutcome = await pendingCall
                                                entry.handler = await until(() =>
                                                    result.handlerRecords
                                                        .slice(recordStart)
                                                        .find(
                                                            (item) =>
                                                                item.name === 'input' && item.finished !== undefined
                                                        )
                                                )
                                                entry.body = entry.handler.internalReply
                                                assert.ok(entry.clientOutcome.cancelled)
                                                assert.ok(entry.handler.aborted !== undefined)
                                            } finally {
                                                controller.abort(new Error('Observation cancellation settled'))
                                                bridge.httpServer.sendCommand = originalCommand
                                                releasePreparation?.()
                                                await pendingCall
                                            }
                                        } else {
                                            entry.body = await call(sequence, { timeout: 1200 })
                                        }
                                    } finally {
                                        entry.settlementResources = await fixtureScript(
                                            'window.__settlementResources()'
                                        )
                                    }
                                    entry.inputs = (await worker('coordinates.nativeInputs()')).slice(firstNative)
                                    entry.tool = await events()
                                    if (observation === 'unrelated-reused') {
                                        entry.reusedEvents = await fixtureScript('window.__reusedScrollEvents')
                                        assert.ok(entry.reusedEvents.length >= 2)
                                        assert.ok(
                                            entry.reusedEvents.every(
                                                (event) => !event.trusted && event.stamp === entry.reusedEvents[0].stamp
                                            )
                                        )
                                    }
                                    if (cancel) {
                                        assert.equal(entry.body.eventsExecuted, 0)
                                        assert.deepEqual(entry.inputs, [])
                                        assert.deepEqual(entry.tool, [])
                                        assert.deepEqual(entry.settlementResources.listeners, [])
                                        assert.ok(entry.settlementResources.ports.length > 0)
                                        assert.ok(entry.settlementResources.ports.every(Boolean))
                                        entry.cancelLoadFinal = await fixtureScript(
                                            '({active:window.__syncUnrelated,' +
                                                'scrolls:window.__cascadeTrace.filter(event=>event.name==="second").length})'
                                        )
                                        assert.equal(entry.cancelLoadFinal.active, true)
                                        await fixtureScript('(window.__syncUnrelated=false,true)')
                                        return
                                    }
                                    entry.layout = await fixtureScript(
                                        '(() => {\n                                    ' +
                                            'cancelAnimationFrame(window.__unrelatedFrame);' +
                                            '\n                                    const ' +
                                            "r=document.querySelector('#pad').getBoundingCl" +
                                            'ientRect();\n                                  ' +
                                            '  return {trace:window.__cascadeTrace,' +
                                            'sourceActive:window.__syncUnrelated===true,' +
                                            'rect:{x:r.x,y:r.y,width:r.width,' +
                                            'height:r.height}};\n                           ' +
                                            '     })()'
                                    )
                                    if (['dynamic-shadow', 'repeated-source'].includes(observation)) {
                                        entry.layoutAtReturn = entry.layout
                                        await until(() => fixtureScript('window.__cascadeDone===true'))
                                        entry.layout = await fixtureScript(
                                            "(() => {const r=document.querySelector('#pad')" +
                                                '.getBoundingClientRect();return ' +
                                                '{trace:window.__cascadeTrace,rect:{x:r.x,' +
                                                'y:r.y,width:r.width,height:r.height}}})()'
                                        )
                                        entry.observation = {
                                            finalAtReturn: entry.layoutAtReturn.trace.some(
                                                (event) => event.name === 'final-after'
                                            ),
                                        }
                                    }
                                    if (observation === 'sync-unrelated') {
                                        await clear()
                                        entry.probeOracle = await oracle({
                                            x: entry.layout.rect.x + entry.layout.rect.width / 2,
                                            y: entry.layout.rect.y + entry.layout.rect.height / 2,
                                        })
                                        try {
                                            assert.equal(entry.layout.sourceActive, true)
                                            await native(action, entry.probeOracle)
                                            entry.probeReference = await events()
                                            entry.probeLoad = await fixtureScript(
                                                '({active:window.__syncUnrelated,' +
                                                    'sourceEvents:window.__cascadeTrace.filter(even' +
                                                    't=>event.name==="second").length})'
                                            )
                                            assert.equal(entry.probeLoad.active, true)
                                            assert.ok(
                                                entry.probeLoad.sourceEvents >
                                                    entry.layout.trace.filter((event) => event.name === 'second').length
                                            )
                                            assert.equal(
                                                entry.probeReference.find(
                                                    (event) =>
                                                        event.type ===
                                                        (action === 'down-up' ? 'mousedown' : 'mousemove')
                                                )?.target,
                                                'pad',
                                                JSON.stringify(entry)
                                            )
                                        } finally {
                                            await fixtureScript('(window.__syncUnrelated=false,true)')
                                        }
                                    }
                                    completed(entry.body, sequence.length)
                                    assert.deepEqual(entry.settlementResources.listeners, [], JSON.stringify(entry))
                                    assert.ok(entry.settlementResources.ports.length > 0)
                                    assert.ok(entry.settlementResources.ports.every(Boolean), JSON.stringify(entry))
                                    assert.ok(
                                        entry.layout.trace.some((event) => event.name === 'final-after'),
                                        JSON.stringify(entry)
                                    )
                                    for (const type of action === 'down-up'
                                        ? ['mousedown', 'mouseup']
                                        : ['mousemove']) {
                                        const event = entry.tool.find((value) => value.type === type)
                                        assert.ok(event, JSON.stringify(entry))
                                        assert.equal(event.target, 'pad', JSON.stringify(entry))
                                        assert.ok(
                                            Math.abs(event.x - event.targetRect.x - event.targetRect.width / 2) <= 1,
                                            JSON.stringify(entry)
                                        )
                                        assert.ok(
                                            Math.abs(event.y - event.targetRect.y - event.targetRect.height / 2) <= 1,
                                            JSON.stringify(entry)
                                        )
                                    }
                                    await clear()
                                    entry.oracle = await oracle({
                                        x: entry.layout.rect.x + entry.layout.rect.width / 2,
                                        y: entry.layout.rect.y + entry.layout.rect.height / 2,
                                    })
                                    await native(action, entry.oracle)
                                    entry.reference = await events()
                                    assert.equal(
                                        entry.reference.find(
                                            (value) => value.type === (action === 'down-up' ? 'mousedown' : 'mousemove')
                                        )?.target,
                                        'pad',
                                        JSON.stringify(entry)
                                    )
                                }
                            )
                        }
                    }
                    for (const cascade of ['ancestor', 'sibling', 'two-siblings']) {
                        for (const action of ['mousemove', 'down-up']) {
                            await record(
                                `c31f10-cascade-${inputMode}-${framed}-${cascade}-${action}`,
                                async (entry) => {
                                    unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
                                    await setup(framed ? [{ css: 'height:320px' }] : [])
                                    entry.frame = frameSelection ?? null
                                    entry.before = await fixtureScript(
                                        '(() => {\n                                    ' +
                                            'document.body.innerHTML=\'<div id="outer" ' +
                                            'style="position:absolute;left:10px;top:20px;' +
                                            'width:380px;height:250px;overflow:auto"><div ' +
                                            'style="position:relative;width:360px;' +
                                            'height:1200px"><div id="inner" ' +
                                            'style="position:absolute;left:0;top:20px;' +
                                            'width:350px;height:150px;overflow:auto"><div ' +
                                            'style="position:relative;width:330px;' +
                                            'height:3500px"><input id="pad" ' +
                                            'type="checkbox" style="position:absolute;' +
                                            'left:50px;top:2100px;width:60px;height:50px;' +
                                            'margin:0"></div></div></div></div><div ' +
                                            'id="second" style="position:absolute;' +
                                            'left:450px;top:10px;width:100px;height:100px;' +
                                            'overflow:auto"><div style="height:1000px;' +
                                            'width:50px"></div></div><div id="third" ' +
                                            'style="position:absolute;left:600px;top:10px;' +
                                            'width:100px;height:100px;overflow:auto"><div ' +
                                            'style="height:1000px;width:50px"></div></div>' +
                                            "';\n                                    " +
                                            "document.body.style.cssText='margin:0;" +
                                            "min-height:900px';\n                           " +
                                            "         const pad=document.querySelector('#pa" +
                                            "d'),inner=document.querySelector('#inner'),\n  " +
                                            '                                      ' +
                                            "outer=document.querySelector('#outer')," +
                                            "second=document.querySelector('#second')," +
                                            "third=document.querySelector('#third');\n      " +
                                            '                              ' +
                                            'window.__cascadeTrace=[];' +
                                            'window.__coordCaptureRects=true;\n             ' +
                                            '                       const log=name=>{const ' +
                                            'r=pad.getBoundingClientRect();' +
                                            'window.__cascadeTrace.push({name,' +
                                            'time:performance.now(),x:r.x,y:r.y,\n          ' +
                                            '                              ' +
                                            'inner:inner.scrollTop,outer:outer.scrollTop,' +
                                            'second:second.scrollTop,' +
                                            'third:third.scrollTop})};\n                    ' +
                                            '                const signal=window.__coordAbo' +
                                            'rt.signal;\n                                   ' +
                                            " inner.addEventListener('scroll',()=>{\n       " +
                                            '                                 ' +
                                            "log('inner-before');\n                         " +
                                            '               if(' +
                                            `${JSON.stringify(cascade)}` +
                                            "==='ancestor')outer.scrollTop=40;else " +
                                            'second.scrollTop=60;\n                         ' +
                                            "               log('inner-after');\n           " +
                                            '                         },{once:true,' +
                                            'signal});\n                                    ' +
                                            "const final=()=>{log('final-before');" +
                                            "pad.style.left='220px';log('final-after')};\n  " +
                                            '                                  if(' +
                                            `${JSON.stringify(cascade)}` +
                                            "==='ancestor')outer.addEventListener('scroll'," +
                                            'final,{once:true,signal});\n                   ' +
                                            '                 else second.addEventListener(' +
                                            "'scroll',()=>{\n                               " +
                                            "         log('second');\n                      " +
                                            '                  if(' +
                                            `${JSON.stringify(cascade)}` +
                                            "==='two-siblings')third.scrollTop=70;else " +
                                            'final();\n                                    ' +
                                            '},{once:true,signal});\n                       ' +
                                            '             if(' +
                                            `${JSON.stringify(cascade)}` +
                                            "==='two-siblings')third.addEventListener('scro" +
                                            "ll',final,{once:true,signal});\n               " +
                                            '                     for(const type of ' +
                                            "['mousemove','mousedown'," +
                                            "'mouseup'])document.addEventListener(type,()=>" +
                                            'log(type),{capture:true,signal});\n            ' +
                                            "                        log('configured');" +
                                            'return {visibility:document.visibilityState,' +
                                            'rect:pad.getBoundingClientRect().toJSON()};\n  ' +
                                            '                              })()'
                                    )
                                    const sequence =
                                        action === 'down-up'
                                            ? [{ type: 'mousedown', target: { css: '#pad' } }, { type: 'mouseup' }]
                                            : [{ type: 'mousemove', target: { css: '#pad' } }]
                                    const first = (await worker('coordinates.nativeInputs()')).length
                                    entry.body = await call(sequence, { timeout: 1200 })
                                    entry.inputs = (await worker('coordinates.nativeInputs()')).slice(first)
                                    entry.tool = await events()
                                    entry.layout = await fixtureScript(
                                        '(() => {\n                                    ' +
                                            "const r=document.querySelector('#pad').getBoun" +
                                            'dingClientRect();\n                            ' +
                                            '        return {trace:window.__cascadeTrace,' +
                                            'rect:{x:r.x,y:r.y,width:r.width,' +
                                            'height:r.height}};\n                           ' +
                                            '     })()'
                                    )
                                    completed(entry.body, sequence.length)
                                    assert.ok(
                                        entry.layout.trace.some((event) => event.name === 'final-after'),
                                        JSON.stringify(entry)
                                    )
                                    for (const type of action === 'down-up'
                                        ? ['mousedown', 'mouseup']
                                        : ['mousemove']) {
                                        const event = entry.tool.find((value) => value.type === type)
                                        assert.ok(event, JSON.stringify(entry))
                                        assert.equal(event.target, 'pad', JSON.stringify(entry))
                                        assert.ok(
                                            Math.abs(event.x - event.targetRect.x - event.targetRect.width / 2) <= 1,
                                            JSON.stringify(entry)
                                        )
                                        assert.ok(
                                            Math.abs(event.y - event.targetRect.y - event.targetRect.height / 2) <= 1,
                                            JSON.stringify(entry)
                                        )
                                    }
                                    await clear()
                                    entry.oracle = await oracle({
                                        x: entry.layout.rect.x + entry.layout.rect.width / 2,
                                        y: entry.layout.rect.y + entry.layout.rect.height / 2,
                                    })
                                    await native(action, entry.oracle)
                                    entry.reference = await events()
                                    const type = action === 'down-up' ? 'mousedown' : 'mousemove'
                                    assert.equal(
                                        entry.reference.find((value) => value.type === type)?.target,
                                        'pad',
                                        JSON.stringify(entry)
                                    )
                                }
                            )
                        }
                    }
                    for (const scene of ['document', 'raf', 'nested', 'continuous']) {
                        for (const action of ['mousemove', 'down-up']) {
                            await record(`c31f9-cascade-${inputMode}-${framed}-${scene}-${action}`, async (entry) => {
                                unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
                                await setup(framed ? [{ css: 'height:320px' }] : [])
                                entry.frame = frameSelection ?? null
                                await fixtureScript(`(() => {
                                    document.body.style.minHeight='3000px';
                                    window.__coordCaptureRects=true;
                                    window.__coordCaptureTimes=true;
                                    const pad=document.querySelector('#pad'), continuous=${scene === 'continuous'};
                                    pad.style.cssText='position:absolute;left:80px;top:2100px;width:80px;height:70px;margin:0';
                                    let scroller=window, listener=window;
                                    if(${scene === 'nested'}) {
                                        const box=document.createElement('div'), content=document.createElement('div');
                                        box.style.cssText='position:absolute;left:0;top:30px;width:400px;height:200px;overflow:auto';
                                        content.style.cssText='position:relative;width:380px;height:3000px';
                                        content.append(pad);box.append(content);document.body.append(box);
                                        scroller=box;listener=box;
                                    }
                                    const requestFrame=window.requestAnimationFrame.bind(window),
                                        cancelFrame=window.cancelAnimationFrame.bind(window);
                                    window.__cascade=[];window.__cascadeInput=null;window.__cascadeFrame=null;
                                    window.__cascadeStop=()=>{
                                        if(window.__cascadeFrame!==null)cancelFrame(window.__cascadeFrame);
                                        window.__cascadeFrame=null;
                                    };
                                    window.__coordAbort.signal.addEventListener('abort',window.__cascadeStop,{once:true});
                                    listener.addEventListener('scroll',()=>{
                                        const step=window.__cascade.length;
                                        if(!continuous&&step>1)return;
                                        const observation={step,time:performance.now(),y:scroller===window?scrollY:scroller.scrollTop,
                                            visibility:document.visibilityState};
                                        window.__cascade.push(observation);
                                        pad.style.left=step===0?'140px':'240px';
                                        if(step===0||continuous){
                                            const again=()=>{
                                                window.__cascadeFrame=null;
                                                if(!window.__coordAbort.signal.aborted)scroller.scrollBy(0,30);
                                            };
                                            if(${scene === 'raf' || scene === 'continuous'})window.__cascadeFrame=requestFrame(again);
                                            else again();
                                        }
                                        observation.completedAt=performance.now();
                                    },{signal:window.__coordAbort.signal});
                                    document.addEventListener(${JSON.stringify(action === 'down-up' ? 'mousedown' : 'mousemove')},()=>{
                                        window.__cascadeInput={phase:window.__cascade.length,time:performance.now()};
                                    },{once:true,signal:window.__coordAbort.signal});
                                    return true;
                                })()`)
                                const sequence =
                                    action === 'down-up'
                                        ? [{ type: 'mousedown', target: { css: '#pad' } }, { type: 'mouseup' }]
                                        : [{ type: 'mousemove', target: { css: '#pad' } }]
                                if (scene === 'continuous') {
                                    entry.warmup = await invoke('evaluate', { script: 'true', timeout: 2000 })
                                    assert.equal(entry.warmup.success, true, JSON.stringify(entry))
                                }
                                const first = (await worker('coordinates.nativeInputs()')).length
                                await fixtureScript(`(${observeSettlementResources.toString()})()`)
                                try {
                                    entry.timeout = scene === 'continuous' ? 100 : 2000
                                    const started = performance.now()
                                    entry.body = await call(sequence, { timeout: entry.timeout })
                                    entry.callElapsedMs = performance.now() - started
                                    entry.settlementResources = await fixtureScript('window.__coordResources()')
                                    entry.tool = await events()
                                    entry.inputs = (await worker('coordinates.nativeInputs()')).slice(first)
                                    entry.layout = await fixtureScript(
                                        '({steps:__cascade,input:__cascadeInput,time:performance.now(),' +
                                            'visibility:document.visibilityState,fixtureFrame:window.__cascadeFrame,' +
                                            'rect:document.querySelector("#pad").getBoundingClientRect().toJSON()})'
                                    )
                                    assert.deepEqual(entry.settlementResources.listeners, [], JSON.stringify(entry))
                                    assert.ok(entry.settlementResources.ports.length > 0, JSON.stringify(entry))
                                    assert.ok(entry.settlementResources.ports.every(Boolean), JSON.stringify(entry))
                                    assert.equal(entry.settlementResources.framesRemaining, 0, JSON.stringify(entry))
                                    assert.equal(entry.settlementResources.timersRemaining, 0, JSON.stringify(entry))
                                    if (scene === 'continuous') {
                                        assert.ok(entry.layout.steps.length > 1, JSON.stringify(entry))
                                        assert.equal(entry.body.actionExecuted, false, JSON.stringify(entry))
                                        assert.equal(entry.body.eventsExecuted, 0)
                                        assert.equal(entry.layout.input, null)
                                        assert.match(
                                            JSON.stringify(entry.body),
                                            /TIMEOUT|SCROLL_SETTLEMENT_TIMEOUT|超时/i
                                        )
                                        assert.deepEqual(entry.inputs, [])
                                        assert.deepEqual(entry.tool, [])
                                        return
                                    }
                                    completed(entry.body, sequence.length)
                                    assert.equal(entry.layout.steps.length, 2, JSON.stringify(entry))
                                    assert.equal(entry.layout.input?.phase, 2, JSON.stringify(entry))
                                    assert.ok(entry.layout.input.time >= entry.layout.steps.at(-1).completedAt)
                                    const type = action === 'down-up' ? 'mousedown' : 'mousemove'
                                    const event = entry.tool.find((value) => value.type === type)
                                    assert.ok(event, JSON.stringify(entry))
                                    assert.equal(event.target, 'pad', JSON.stringify(entry))
                                    assert.ok(event.time >= entry.layout.steps.at(-1).completedAt)
                                    assert.ok(
                                        Math.abs(event.x - (event.targetRect.x + event.targetRect.width / 2)) <= 1,
                                        JSON.stringify(entry)
                                    )
                                    assert.ok(
                                        Math.abs(event.y - (event.targetRect.y + event.targetRect.height / 2)) <= 1,
                                        JSON.stringify(entry)
                                    )
                                    await clear()
                                    entry.oracle = await oracle({
                                        x: entry.layout.rect.x + entry.layout.rect.width / 2,
                                        y: entry.layout.rect.y + entry.layout.rect.height / 2,
                                    })
                                    await native(action, entry.oracle)
                                    entry.reference = await events()
                                    assert.equal(
                                        entry.reference.find((value) => value.type === type)?.target,
                                        'pad',
                                        JSON.stringify(entry)
                                    )
                                } finally {
                                    entry.fixtureResources = await fixtureScript(
                                        '(() => {window.__coordAbort.abort();window.__coordRestoreResources();' +
                                            'return {frame:window.__cascadeFrame,aborted:window.__coordAbort.signal.aborted}})()'
                                    )
                                    assert.equal(entry.fixtureResources.frame, null)
                                    assert.equal(entry.fixtureResources.aborted, true)
                                }
                            })
                        }
                    }
                }
            }
        }
        for (const inputMode of mode === 'extension' ? ['precise', 'stealth'] : ['precise']) {
            for (const framed of [false, true]) {
                for (const action of ['click', 'touch']) {
                    await record(`c31f9-adjacent-${inputMode}-${framed}-${action}`, async (entry) => {
                        unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
                        await setup(framed ? [{ css: 'height:320px' }] : [])
                        entry.frame = frameSelection ?? null
                        await fixtureScript(
                            "(()=>{document.body.style.minHeight='3000px';" +
                                'window.__coordCaptureRects=true;const ' +
                                "pad=document.querySelector('#pad');" +
                                "pad.style.cssText='position:absolute;" +
                                'left:80px;top:2100px;width:80px;height:70px;' +
                                "margin:0';window.__adjacentScroll=[];addEventListener('scroll',()=>" +
                                "{pad.style.left='240px';window.__adjacentScroll.push({time:performance.now(),left:pad.getBoundingClientRect().left,visibility:document.visibilityState})},{once:true," +
                                'signal:window.__coordAbort.signal});return ' +
                                'true})()'
                        )
                        const sequence =
                            action === 'touch'
                                ? [{ type: 'touchstart', target: { css: '#pad' } }, { type: 'touchend' }]
                                : [{ type: 'click', target: { css: '#pad' } }]
                        await fixtureScript(
                            `(window.__coordCaptureTimes=true,(${observeSettlementResources.toString()})())`
                        )
                        try {
                            entry.body = await call(sequence, { timeout: 2000 })
                        } finally {
                            entry.settlementResources = await fixtureScript(
                                '(() => {const resources=window.__coordResources();window.__coordRestoreResources();return resources})()'
                            )
                        }
                        entry.tool = await events()
                        entry.scroll = await fixtureScript('window.__adjacentScroll')
                        assert.deepEqual(entry.settlementResources.listeners, [], JSON.stringify(entry))
                        assert.ok(entry.settlementResources.ports.every(Boolean), JSON.stringify(entry))
                        assert.equal(entry.settlementResources.framesRemaining, 0, JSON.stringify(entry))
                        assert.equal(entry.settlementResources.timersRemaining, 0, JSON.stringify(entry))
                        assert.equal(entry.scroll.length, 1, JSON.stringify(entry))
                        assert.equal(entry.scroll[0].left, 240, JSON.stringify(entry))
                        completed(entry.body, sequence.length)
                        const type = action === 'touch' ? 'touchstart' : 'click'
                        const event = entry.tool.find((value) => value.type === type)
                        assert.ok(event, JSON.stringify(entry))
                        assert.equal(event.target, 'pad', JSON.stringify(entry))
                        assert.ok(event.time >= entry.scroll[0].time, JSON.stringify(entry))
                        assert.equal(event.visibility, 'visible')
                        assert.ok(
                            Math.abs(event.x - (event.targetRect.x + event.targetRect.width / 2)) <= 1,
                            JSON.stringify(entry)
                        )
                        assert.ok(
                            Math.abs(event.y - (event.targetRect.y + event.targetRect.height / 2)) <= 1,
                            JSON.stringify(entry)
                        )
                        await clear()
                        entry.oracle = await oracle({
                            x: event.targetRect.x + event.targetRect.width / 2,
                            y: event.targetRect.y + event.targetRect.height / 2,
                        })
                        if (action === 'touch') {
                            ++result.nativeReferences
                            result.nativeDispatches += 2
                            await observer.send(
                                'Input.dispatchTouchEvent',
                                { type: 'touchStart', touchPoints: [{ ...entry.oracle, id: 1 }] },
                                observerSession
                            )
                            await observer.send(
                                'Input.dispatchTouchEvent',
                                { type: 'touchEnd', touchPoints: [] },
                                observerSession
                            )
                        } else {
                            await native(action, entry.oracle)
                        }
                        entry.reference = await events()
                        assert.equal(
                            entry.reference.find((value) => value.type === type)?.target,
                            'pad',
                            JSON.stringify(entry)
                        )
                    })
                }
            }
        }
        if (mode === 'extension') {
            unified.activeMode = 'extension'
            unified.cdpExplicitlySelected = false
            unified.setInputMode('precise')
            for (const [operation, framed, variant] of ['evaluate', 'input'].flatMap((operation) =>
                [false, true].flatMap((framed) =>
                    ['native', 'page', 'method', 'parameters'].map((variant) => [operation, framed, variant])
                )
            )) {
                const pageError = variant === 'page'
                const protocolError = variant === 'method' || variant === 'parameters'
                await record(`c31f7-origin-${operation}-${framed ? 'frame' : 'main'}-${variant}`, async (entry) => {
                    await setup(framed ? [{ css: '' }] : [])
                    await fixtureScript('(globalThis.__c31f7Actions=0,true)')
                    const marker = 'C31F7_TERMINATE_' + operation + '_' + framed
                    let termination
                    await observer.send('Runtime.enable', {}, observerSession)
                    const terminate = (params, sessionId) => {
                        if (sessionId === observerSession && params.args?.some((arg) => arg.value === marker)) {
                            entry.terminationRequested = true
                            termination = observer.send('Runtime.terminateExecution', {}, observerSession).then(() => {
                                entry.terminationAcknowledged = true
                            })
                        }
                    }
                    if (variant === 'native') {
                        observer.onEvent('Runtime.consoleAPICalled', terminate)
                    }
                    const firstReply = result.rpcReplies.length
                    const firstInput = (await worker('coordinates.nativeInputs()')).length
                    const firstProtocolError = (await worker('coordinates.protocolErrors()')).length
                    if (protocolError) {
                        await worker(`coordinates.setProtocolFault(${JSON.stringify(variant)})`)
                    }
                    try {
                        entry.body = await invoke(operation, {
                            ...(operation === 'evaluate'
                                ? { script: 'globalThis.__c31f7Actions++' }
                                : {
                                      events: [
                                          { type: 'keydown', key: 'a' },
                                          { type: 'keyup', key: 'a' },
                                      ],
                                  }),
                            timeout: 5000,
                            postCondition: {
                                script: pageError
                                    ? '() => {throw new Error("Execution was terminated")}'
                                    : protocolError
                                      ? 'true'
                                      : `() => {console.debug(${JSON.stringify(marker)});while(true){}}`,
                                timeout: 1500,
                                interval: 50,
                            },
                        })
                        await termination
                        entry.nativeReplies = result.rpcReplies.slice(firstReply).filter((reply) => !reply.success)
                        entry.inputs = (await worker('coordinates.nativeInputs()')).slice(firstInput)
                        entry.actions = await fixtureScript('globalThis.__c31f7Actions')
                        assert.equal(entry.body.actionStatus, 'completed')
                        assert.equal(entry.body.retryable, false)
                        if (variant === 'native') {
                            assert.equal(entry.terminationAcknowledged, true)
                        }
                        entry.nativeContexts = entry.nativeReplies.map((reply) => JSON.parse(reply.error).error.context)
                        for (const context of entry.nativeContexts) {
                            assert.equal(context.nativeSource, 'chrome.debugger')
                            assert.equal(typeof context.method, 'string')
                            assert.equal(typeof context.nativeCode, 'number')
                            assert.equal(typeof context.nativeMessage, 'string')
                        }
                        if (protocolError) {
                            entry.protocolErrors = (await worker('coordinates.protocolErrors()')).slice(
                                firstProtocolError
                            )
                            assert.equal(entry.protocolErrors.length, 1)
                            assert.equal(entry.nativeContexts.length, 1)
                            assert.equal(entry.nativeContexts[0].nativeCode, variant === 'method' ? -32601 : -32602)
                        }
                        if (pageError) {
                            assert.deepEqual(entry.nativeContexts, [])
                        }
                        if (operation === 'evaluate') {
                            assert.equal(entry.actions, 1)
                        } else {
                            assert.equal(entry.body.eventsExecuted, 2)
                            assert.equal(
                                entry.inputs.filter((input) => input.method === 'Input.dispatchKeyEvent').length,
                                2
                            )
                        }
                        assert.equal(entry.body.verificationStatus, variant === 'native' ? 'unavailable' : 'error')
                        assert.equal(entry.body.postCondition.retryable, variant === 'native')
                    } finally {
                        await worker('coordinates.setProtocolFault(null)')
                        observer.offEvent('Runtime.consoleAPICalled', terminate)
                    }
                })
            }
        }
        for (const operation of ['evaluate', 'input']) {
            for (const snapshotIndex of [1, 2]) {
                const precondition = snapshotIndex === 2
                await record(
                    precondition ? `c31f8-condition-snapshot-${operation}` : `c31f7-before-snapshot-${operation}`,
                    async (entry) => {
                        await setup([])
                        await fixtureScript(
                            '(()=>{globalThis.__c31f7Actions=0;' +
                                'globalThis.__c31f7Keys=[];for(const type of ' +
                                "['keydown','keyup'])document.addEventListener(" +
                                'type,event=>__c31f7Keys.push([type,' +
                                'event.key]),{signal:window.__coordAbort.signal' +
                                '});return true})()'
                        )
                        const targetId = mode === 'extension' ? String(tabId) : rootId
                        const expected = precondition ? await unified.getPageSnapshot(targetId, 7000) : null
                        const condition = unified.withPageCondition
                        const snapshot = unified.getPageSnapshot
                        const driver = mode === 'extension' ? bridge : session
                        const driverSnapshot = driver.getPageSnapshot
                        const cdp = session.cdp
                        const receive = cdp.handleMessage
                        const send = cdp.ws.send
                        const snapshotCommands = new Set()
                        let readingSnapshot = false
                        let originalError
                        driver.getPageSnapshot = async (...args) => {
                            readingSnapshot = true
                            try {
                                return await driverSnapshot.apply(driver, args)
                            } catch (error) {
                                originalError = error
                                entry.originalError = { name: error.name, code: error.code, message: error.message }
                                throw error
                            } finally {
                                readingSnapshot = false
                            }
                        }
                        const recordError = (error) => {
                            entry.sameErrorInstance = error === originalError
                            entry.sameErrorType = error.constructor === originalError?.constructor
                            throw error
                        }
                        unified.getPageSnapshot = async (...args) => {
                            try {
                                return await snapshot.apply(unified, args)
                            } catch (error) {
                                return recordError(error)
                            }
                        }
                        entry.actionScopes = 0
                        unified.withPageCondition = async (...args) => {
                            ++entry.actionScopes
                            try {
                                return await condition.apply(unified, args)
                            } catch (error) {
                                return recordError(error)
                            }
                        }
                        if (mode === 'cdp') {
                            cdp.ws.send = (text, ...args) => {
                                const command = JSON.parse(text)
                                if (readingSnapshot && command.method === 'Target.getTargetInfo') {
                                    snapshotCommands.add(command.id)
                                }
                                return send.apply(cdp.ws, [text, ...args])
                            }
                            cdp.handleMessage = (data) => {
                                const reply = JSON.parse(data.toString())
                                if (
                                    snapshotCommands.has(reply.id) &&
                                    reply.result?.targetInfo &&
                                    --snapshotsUntilHold === 0
                                ) {
                                    heldSnapshot = reply
                                    return
                                }
                                return receive.call(cdp, data)
                            }
                        }
                        const firstInput = (await worker('coordinates.nativeInputs()')).length
                        const firstCommand = result.productionCommands.length
                        snapshotsUntilHold = snapshotIndex
                        heldSnapshot = undefined
                        try {
                            entry.body = await invoke(operation, {
                                ...(operation === 'evaluate'
                                    ? { script: 'globalThis.__c31f7Actions++' }
                                    : {
                                          events: [
                                              { type: 'keydown', key: 'x' },
                                              { type: 'keyup', key: 'x' },
                                          ],
                                      }),
                                ...(expected
                                    ? operation === 'evaluate'
                                        ? { expectedUrl: expected.url }
                                        : { expectedRevision: expected.revision }
                                    : {}),
                                timeout: precondition ? 300 : 200,
                            })
                            entry.heldSnapshot = heldSnapshot
                            entry.inputs =
                                mode === 'extension'
                                    ? (await worker('coordinates.nativeInputs()')).slice(firstInput)
                                    : result.productionCommands
                                          .slice(firstCommand)
                                          .filter((command) => command.method.startsWith('Input.'))
                            entry.dom = await fixtureScript('({actions:__c31f7Actions,keys:__c31f7Keys})')
                            assert.ok(mode === 'extension' ? heldSnapshot?.success : heldSnapshot?.result?.targetInfo)
                            assert.equal(entry.sameErrorInstance, true)
                            assert.equal(entry.sameErrorType, true)
                            assert.equal(entry.actionScopes, precondition ? 1 : 0)
                            assert.deepEqual(entry.inputs, [])
                            assert.deepEqual(entry.dom, { actions: 0, keys: [] })
                            assert.equal(entry.body.actionExecuted, false)
                            assert.equal(entry.body.actionStatus, 'not_started')
                            assert.equal(entry.body.failureStage, precondition ? 'precondition' : 'context')
                            assert.equal(entry.body.retryable, false)
                            if (operation === 'input') {
                                assert.equal(entry.body.eventsExecuted, 0)
                                assert.equal(entry.body.remainingEventsNotExecuted, 2)
                            }
                            assert.equal(entry.body.error.context.actionExecuted, 'unknown')
                            assert.equal(entry.body.pageContext.contextPhase, precondition ? 'precondition' : 'before')
                            if (expected) {
                                assert.equal(entry.body.pageContext.before.url, expected.url)
                            }
                        } finally {
                            unified.withPageCondition = condition
                            unified.getPageSnapshot = snapshot
                            driver.getPageSnapshot = driverSnapshot
                            cdp.ws.send = send
                            cdp.handleMessage = receive
                            snapshotsUntilHold = 0
                            if (heldSnapshot) {
                                if (mode === 'extension') {
                                    bridge.httpServer.handleMessage(JSON.stringify(heldSnapshot))
                                } else {
                                    receive.call(cdp, JSON.stringify(heldSnapshot))
                                }
                            }
                            heldSnapshot = undefined
                            entry.afterLateReply = await fixtureScript('({actions:__c31f7Actions,keys:__c31f7Keys})')
                            assert.deepEqual(entry.afterLateReply, { actions: 0, keys: [] })
                        }
                        entry.followEvaluate = await invoke('evaluate', {
                            script: 'globalThis.__afterSnapshot=(globalThis.__afterSnapshot||0)+1',
                            timeout: 500,
                        })
                        entry.followInput = await call(
                            [
                                { type: 'keydown', key: 'z' },
                                { type: 'keyup', key: 'z' },
                            ],
                            { timeout: 400 }
                        )
                        assert.equal(entry.followEvaluate.success, true)
                        assert.equal(entry.followInput.success, true)
                    }
                )
            }
        }
        if (mode === 'extension') {
            for (const inputMode of ['precise', 'stealth']) {
                for (const framed of [false, true]) {
                    for (const slotted of [false, true]) {
                        for (const propagation of ['none', 'stop', 'stop-immediate', 'capture-stop']) {
                            for (const action of ['mousemove', 'down-up']) {
                                await record(
                                    `c31f8-scroll-${inputMode}-${framed}-${slotted}-${propagation}-${action}`,
                                    async (entry) => {
                                        unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
                                        await setup(framed ? [{ css: 'height:320px' }] : [])
                                        await fixtureScript(
                                            '(() => {\n                                     ' +
                                                "       document.body.style.cssText='margin:0;" +
                                                "min-height:3000px';\n                          " +
                                                '                  window.__coordCaptureRects=t' +
                                                'rue;\n                                         ' +
                                                "   let pad=document.querySelector('#pad'), " +
                                                'scroller=document, root=window;\n              ' +
                                                '                              if (' +
                                                `${slotted}` +
                                                ') {\n                                          ' +
                                                '      document.body.innerHTML=\'<div id="host" ' +
                                                'style="display:block;position:absolute;left:0;' +
                                                'top:30px;width:380px;height:200px"></div>\';\n  ' +
                                                '                                              ' +
                                                "const host=document.querySelector('#host');\n  " +
                                                '                                              ' +
                                                "root=host.attachShadow({mode:'open'});\n       " +
                                                '                                         ' +
                                                'root.innerHTML=\'<div id="scroller" ' +
                                                'style="width:380px;height:200px;overflow:auto;' +
                                                'position:relative"><div id="content" ' +
                                                'style="position:relative;width:380px;' +
                                                'height:3500px"><slot name="target"></slot>' +
                                                "</div></div>';\n                               " +
                                                "                 scroller=root.querySelector('" +
                                                "#scroller');\n                                 " +
                                                "               pad=document.createElement('inp" +
                                                "ut');pad.id='pad';pad.type='checkbox';" +
                                                "pad.slot='target';host.append(pad);\n          " +
                                                '                                  }\n          ' +
                                                '                                  ' +
                                                "pad.style.cssText='position:absolute;" +
                                                'left:80px;top:2100px;width:80px;height:70px;' +
                                                "margin:0';\n                                   " +
                                                '         window.__c31f8Scroll=[];\n            ' +
                                                '                                const capture=' +
                                                `${propagation === 'capture-stop'}` +
                                                ';\n                                            ' +
                                                "(capture ? root : scroller).addEventListener('" +
                                                "scroll', event => {\n                          " +
                                                '                      window.__c31f8Scroll.pus' +
                                                'h({target:event.target.id||event.target.nodeNa' +
                                                'me,position:scroller===document?window.scrollY' +
                                                ':scroller.scrollTop});\n                       ' +
                                                "                         pad.style.left='240px';\n                    " +
                                                '                            if (' +
                                                `${propagation === 'stop-immediate'}` +
                                                ') event.stopImmediatePropagation();\n          ' +
                                                '                                      if (' +
                                                `${propagation === 'stop' || propagation === 'capture-stop'}` +
                                                ') event.stopPropagation();\n                   ' +
                                                '                         }, {capture,' +
                                                'once:true,signal:window.__coordAbort.signal});' +
                                                '\n                                            ' +
                                                'return true;\n                                 ' +
                                                '       })()'
                                        )
                                        const sequence =
                                            action === 'down-up'
                                                ? [{ type: 'mousedown', target: { css: '#pad' } }, { type: 'mouseup' }]
                                                : [{ type: 'mousemove', target: { css: '#pad' } }]
                                        entry.body = await call(sequence, { timeout: 1200 })
                                        entry.tool = await events()
                                        entry.layout = await fixtureScript(
                                            "(() => {const r=document.querySelector('#pad')" +
                                                '.getBoundingClientRect();return {rect:{x:r.x,' +
                                                'y:r.y,width:r.width,height:r.height},' +
                                                'scroll:window.__c31f8Scroll,' +
                                                'visibility:document.visibilityState}})()'
                                        )
                                        await clear()
                                        entry.oracle = await oracle({
                                            x: entry.layout.rect.x + entry.layout.rect.width / 2,
                                            y: entry.layout.rect.y + entry.layout.rect.height / 2,
                                        })
                                        await native(action, entry.oracle)
                                        entry.reference = await events()
                                        const type = action === 'down-up' ? 'mousedown' : 'mousemove'
                                        assert.equal(
                                            entry.reference.find((event) => event.type === type)?.target,
                                            'pad',
                                            JSON.stringify(entry)
                                        )
                                        completed(entry.body, sequence.length)
                                        assert.ok(entry.layout.scroll.length > 0, JSON.stringify(entry))
                                        for (const event of entry.tool.filter((event) => event.type === type)) {
                                            assert.equal(event.target, 'pad', JSON.stringify(entry))
                                            assert.ok(
                                                Math.abs(event.x - (event.targetRect.x + event.targetRect.width / 2)) <=
                                                    1,
                                                JSON.stringify(entry)
                                            )
                                            assert.ok(
                                                Math.abs(
                                                    event.y - (event.targetRect.y + event.targetRect.height / 2)
                                                ) <= 1,
                                                JSON.stringify(entry)
                                            )
                                        }
                                        assert.ok(
                                            entry.tool.some((event) => event.type === type),
                                            JSON.stringify(entry)
                                        )
                                    }
                                )
                            }
                        }
                    }
                }
            }
        }
        if (mode === 'extension') {
            for (const inputMode of ['precise', 'stealth']) {
                for (const mutation of ['remove', 'replace']) {
                    for (const prefix of [false, true]) {
                        await record(`c31f7-ref-${inputMode}-${mutation}-${prefix}`, async (entry) => {
                            unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
                            await setup([{ css: 'height:320px' }])
                            await fixtureScript(
                                "(()=>{document.body.style.minHeight='1800px';" +
                                    "const pad=document.querySelector('#pad');" +
                                    "pad.style.top='900px';addEventListener('scroll" +
                                    "',()=>{" +
                                    (mutation === 'remove' ? 'pad.remove()' : 'pad.replaceWith(pad.cloneNode(true))') +
                                    '},{once:true,signal:window.__coordAbort.signal' +
                                    '});return true})()'
                            )
                            const first = (await worker('coordinates.nativeInputs()')).length
                            entry.body = await call([
                                ...(prefix ? [{ type: 'wait', ms: 1 }] : []),
                                { type: 'mousemove', target: { css: '#pad' } },
                            ])
                            entry.inputs = (await worker('coordinates.nativeInputs()')).slice(first)
                            assert.equal(entry.body.error.code, 'TARGET_NOT_FOUND')
                            assert.equal(entry.body.eventsExecuted, prefix ? 1 : 0)
                            assert.equal(entry.body.actionExecuted, prefix)
                            assert.deepEqual(entry.inputs, [])
                        })
                    }
                }
            }
        }
        for (const inputMode of mode === 'extension' ? ['precise', 'stealth'] : ['precise']) {
            for (const transformed of [false, true]) {
                for (const relocate of [false, true]) {
                    for (const action of ['mousemove', 'down-up', 'touch', 'touchmove', 'click']) {
                        await record(
                            `c31f7-scroll-${inputMode}-${transformed}-${relocate}-${action}`,
                            async (entry) => {
                                unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
                                await setup([
                                    {
                                        css:
                                            'width:400px;height:320px;border:6px solid black;' +
                                            (transformed
                                                ? 'transform:rotate(12deg) scale(1.1);transform-origin:30px 40px'
                                                : ''),
                                    },
                                ])
                                await fixtureScript(
                                    "(()=>{document.body.style.minHeight='1800px';" +
                                        'window.__coordCaptureRects=true;const ' +
                                        "pad=document.querySelector('#pad');" +
                                        "pad.style.cssText='position:absolute;" +
                                        'left:80px;top:900px;width:80px;height:70px;' +
                                        "margin:0';if(" +
                                        `${relocate}` +
                                        ")addEventListener('scroll',()=>" +
                                        "{pad.style.left='240px'},{once:true," +
                                        'signal:window.__coordAbort.signal});if(' +
                                        `${action === 'touchmove'}` +
                                        ")document.addEventListener('touchstart',()=>" +
                                        '{pad.style.left=(parseFloat(pad.style.left)+25' +
                                        ")+'px'},{once:true,signal:window.__coordAbort." +
                                        'signal});return true})()'
                                )
                                const target = { css: '#pad' }
                                const sequence =
                                    action === 'down-up'
                                        ? [{ type: 'mousedown', target }, { type: 'mouseup' }]
                                        : action === 'touch'
                                          ? [{ type: 'touchstart', target }, { type: 'touchend' }]
                                          : action === 'touchmove'
                                            ? [
                                                  { type: 'touchstart', target },
                                                  { type: 'touchmove', target },
                                                  { type: 'touchend' },
                                              ]
                                            : [{ type: action, target }]
                                entry.body = await call(sequence)
                                await delay(30)
                                entry.tool = await events()
                                entry.rect = await fixtureScript(
                                    "(()=>{const r=document.querySelector('#pad').g" +
                                        'etBoundingClientRect();return{x:r.x,y:r.y,' +
                                        'width:r.width,height:r.height}})()'
                                )
                                const type =
                                    action === 'down-up' ? 'mousedown' : action === 'touch' ? 'touchstart' : action
                                const dispatched = entry.tool.filter((event) => event.type === type)
                                completed(entry.body, sequence.length)
                                assert.ok(dispatched.length > 0, JSON.stringify(entry))
                                for (const event of dispatched) {
                                    assert.equal(event.target, 'pad', JSON.stringify(entry))
                                    assert.ok(
                                        Math.abs(event.x - (event.targetRect.x + event.targetRect.width / 2)) <= 1,
                                        JSON.stringify(entry)
                                    )
                                    assert.ok(
                                        Math.abs(event.y - (event.targetRect.y + event.targetRect.height / 2)) <= 1,
                                        JSON.stringify(entry)
                                    )
                                }
                                await clear()
                                entry.oracle = await oracle({
                                    x: entry.rect.x + entry.rect.width / 2,
                                    y: entry.rect.y + entry.rect.height / 2,
                                })
                                if (action === 'touch' || action === 'touchmove') {
                                    ++result.nativeReferences
                                    const dispatchTouch = async (type, point) => {
                                        ++result.nativeDispatches
                                        await observer.send(
                                            'Input.dispatchTouchEvent',
                                            { type, touchPoints: point ? [{ ...point, id: 17 }] : [] },
                                            observerSession
                                        )
                                    }
                                    await dispatchTouch('touchStart', entry.oracle)
                                    if (action === 'touchmove') {
                                        await dispatchTouch('touchMove', { x: entry.oracle.x + 25, y: entry.oracle.y })
                                    }
                                    await dispatchTouch('touchEnd')
                                } else {
                                    await native(action, entry.oracle)
                                }
                                entry.reference = await events()
                                const reference = entry.reference.filter((event) => event.type === type)
                                assert.ok(reference.length > 0, JSON.stringify(entry.reference))
                                assert.ok(
                                    reference.every((event) => event.target === 'pad'),
                                    JSON.stringify(entry.reference)
                                )
                            }
                        )
                    }
                }
            }
        }
        unified.setInputMode('precise')
        const geometries = [
            ['ordinary', [{ css: '' }]],
            ['translate', [{ css: 'transform:translate(40px,30px)' }]],
            ['scale2', [{ css: 'transform:scale(2)' }]],
            [
                'border-origin',
                [{ css: 'border:9px solid black;transform-origin:63px 47px;transform:scale(1.3) rotate(12deg)' }],
            ],
            ['rotate', [{ css: 'left:300px;transform:rotate(24deg)' }]],
            ['skew', [{ css: 'transform:skew(18deg,7deg)' }]],
            ['reflection', [{ css: 'left:600px;transform:scale(-1,1)' }]],
            [
                'nested',
                [
                    { css: 'transform:scale(1.4) rotate(8deg)' },
                    { css: 'left:30px;top:25px;transform:skew(11deg) scale(.7)' },
                ],
            ],
            ['oopif', [{ css: 'transform:scale(1.7)', oopif: true }]],
            [
                'oopif-nested',
                [
                    { css: 'left:50px;top:40px;transform:rotate(8deg) scale(1.2)', oopif: true },
                    { css: 'left:20px;top:20px;transform:skew(9deg) scale(.8)' },
                ],
            ],
            ['zoom', [{ css: 'zoom:2' }]],
            ['oopif-zoom', [{ css: 'zoom:2', oopif: true }]],
            ['zoom-nested', [{ css: 'zoom:2' }, { css: 'left:20px;top:20px;transform:scale(.8)' }]],
        ]
        for (const [name, styles] of geometries) {
            await setup(styles)
            for (const selector of [false, true]) {
                for (const action of ['wheel', 'mousemove', 'click']) {
                    for (const inputMode of mode === 'extension' && action !== 'wheel'
                        ? ['precise', 'stealth']
                        : ['precise']) {
                        await record(
                            `${inputMode === 'stealth' ? 'stealth-' : ''}${name}-${selector ? 'selector' : 'point'}-${action}`,
                            async (entry) => {
                                unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
                                if (inputMode === 'stealth') {
                                    await fixtureScript('(window.__coordCaptureRects=true,true)')
                                }
                                await clear()
                                const localPoint =
                                    mode === 'extension' && !['ordinary', 'translate', 'scale2'].includes(name)
                                        ? { x: 140.25, y: 110.25 }
                                        : { x: 140, y: 110 }
                                const nativeStart =
                                    mode === 'extension' ? (await worker('coordinates.nativeInputs()')).length : 0
                                const target = selector ? { css: '#pad' } : localPoint
                                const body = await call([
                                    { type: action, target, ...(action === 'wheel' ? { deltaY: 120 } : {}) },
                                ])
                                completed(body, 1)
                                await delay(30)
                                const tool = await events()
                                if (mode === 'extension' && selector && action === 'wheel') {
                                    assert.equal(
                                        result.bridgeCommands.findLast((c) => c.action === 'scroll')?.params.y,
                                        120
                                    )
                                    assert.equal(
                                        tool.some((e) => e.type === 'wheel'),
                                        false
                                    )
                                    return {
                                        body,
                                        tool,
                                        contract: 'Existing explicit ref programmatic scroll, no synthesized wheel',
                                    }
                                }
                                assert.ok(
                                    tool.some((e) => e.type === action),
                                    'Expected event: ' + JSON.stringify(tool)
                                )
                                assert.ok(
                                    tool.every((e) => e.target === 'pad'),
                                    JSON.stringify(tool)
                                )
                                await clear()
                                let point = await oracle(selector ? { x: 140, y: 110 } : localPoint)
                                if (mode === 'extension' && inputMode === 'precise' && action !== 'wheel') {
                                    const inputs = (await worker('coordinates.nativeInputs()')).slice(nativeStart)
                                    const dispatched = inputs.find((c) => c.method === 'Input.dispatchMouseEvent')
                                    assert.ok(dispatched, 'Native Extension input was not dispatched')
                                    assert.ok(
                                        Math.abs(point.x - dispatched.params.x) < 0.02 &&
                                            Math.abs(point.y - dispatched.params.y) < 0.02,
                                        JSON.stringify({ point, dispatched })
                                    )
                                    point = { x: dispatched.params.x, y: dispatched.params.y }
                                }
                                await native(action, point)
                                const reference = await events()
                                const filter = (list) =>
                                    list.filter((e) =>
                                        action === 'click'
                                            ? ['mousedown', 'mouseup', 'click'].includes(e.type)
                                            : e.type === action
                                    )
                                Object.assign(entry, { body, point, tool, reference, inputMode })
                                if (inputMode === 'stealth') {
                                    const toolEvents = comparable(filter(tool))
                                    const nativeEvents = comparable(filter(reference))
                                    const semantic = (list) => list.map(({ x: _x, y: _y, ...event }) => event)
                                    assert.deepEqual(semantic(toolEvents), semantic(nativeEvents))
                                    entry.nativeClientQuantization = []
                                    entry.nativeDispatchPoint = result.nativeCommands.at(-1).params
                                    assert.equal(entry.nativeDispatchPoint.x, point.x)
                                    assert.equal(entry.nativeDispatchPoint.y, point.y)
                                    for (let index = 0; index < toolEvents.length; ++index) {
                                        const actual = toolEvents[index]
                                        const native = nativeEvents[index]
                                        const intended = selector
                                            ? {
                                                  x: actual.targetRect.x + actual.targetRect.width / 2,
                                                  y: actual.targetRect.y + actual.targetRect.height / 2,
                                              }
                                            : localPoint
                                        const difference = {
                                            x: Math.trunc(intended.x) - native.x,
                                            y: Math.trunc(intended.y) - native.y,
                                        }
                                        assert.equal(actual.x, Math.trunc(intended.x))
                                        assert.equal(actual.y, Math.trunc(intended.y))
                                        for (const axis of ['x', 'y']) {
                                            assert.ok(Number.isInteger(native[axis]))
                                            assert.ok(
                                                difference[axis] === 0 || difference[axis] === 1,
                                                JSON.stringify({ intended, native, difference })
                                            )
                                        }
                                        assert.ok(
                                            native.x >= native.targetRect.x &&
                                                native.x < native.targetRect.x + native.targetRect.width
                                        )
                                        assert.ok(
                                            native.y >= native.targetRect.y &&
                                                native.y < native.targetRect.y + native.targetRect.height
                                        )
                                        entry.nativeClientQuantization.push({
                                            type: actual.type,
                                            intended,
                                            actual: { x: actual.x, y: actual.y },
                                            native: { x: native.x, y: native.y },
                                            difference,
                                        })
                                    }
                                } else {
                                    assert.deepEqual(comparable(filter(tool)), comparable(filter(reference)))
                                }
                            }
                        )
                    }
                }
            }
        }
        await setup([])
        await fixtureScript(`(() => {
            window.__coordCaptureTimes=true;
            window.__modifierKeys=[];
            for(const type of ['keydown','keyup'])document.addEventListener(type,event=>{
                window.__modifierKeys.push({type,key:event.key,time:performance.now(),trusted:event.isTrusted,
                    altKey:event.altKey,ctrlKey:event.ctrlKey,metaKey:event.metaKey,shiftKey:event.shiftKey});
            },{capture:true,signal:window.__coordAbort.signal});
            return true;
        })()`)
        for (const inputMode of mode === 'extension' ? ['stealth', 'precise'] : ['precise']) {
            unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
            for (const keys of [[], ['Alt'], ['Control'], ['Meta'], ['Shift'], ['Control', 'Shift']]) {
                for (const action of ['wheel', 'mousemove', 'down-up', 'click', 'right', 'force', 'ref-actionable']) {
                    await record(`modifiers-${inputMode}-${keys.join('+') || 'none'}-${action}`, async () => {
                        const mask = keys.reduce((v, k) => v | { Alt: 1, Control: 2, Meta: 4, Shift: 8 }[k], 0)
                        await clear()
                        await fixtureScript('(window.__modifierKeys=[],true)')
                        const firstCommand = result.bridgeCommands.length
                        const firstNative = (await worker('coordinates.nativeInputs()')).length
                        const target =
                            action === 'force' || action === 'ref-actionable' ? { css: '#pad' } : { x: 140, y: 110 }
                        const actions =
                            action === 'down-up'
                                ? [{ type: 'mousemove', target }, { type: 'mousedown' }, { type: 'mouseup' }]
                                : [
                                      {
                                          type: ['right', 'force', 'ref-actionable'].includes(action)
                                              ? 'click'
                                              : action,
                                          target,
                                          ...(action === 'wheel' ? { deltaY: 120 } : {}),
                                          ...(action === 'right' ? { button: 'right' } : {}),
                                          ...(action === 'force'
                                              ? { force: true, forceReason: 'isolated regression' }
                                              : {}),
                                      },
                                  ]
                        const viewportBefore =
                            action === 'wheel' ? await fixtureScript('({x:scrollX,y:scrollY})') : undefined
                        const sequence = [
                            ...keys.map((key) => ({ type: 'keydown', key })),
                            ...actions,
                            ...[...keys].reverse().map((key) => ({ type: 'keyup', key })),
                        ]
                        const body = await call(sequence)
                        completed(body, sequence.length)
                        const tool = await events()
                        assert.ok(tool.length > 0)
                        for (const event of tool) {
                            assert.equal(event.target, 'pad')
                            for (const [field, bit] of [
                                ['altKey', 1],
                                ['ctrlKey', 2],
                                ['metaKey', 4],
                                ['shiftKey', 8],
                            ]) {
                                assert.equal(event[field], Boolean(mask & bit), JSON.stringify(event))
                            }
                        }
                        assert.equal(unified.modifiers, 0)
                        assert.equal(unified.pressedKeys.size, 0)
                        if (mode === 'cdp') {
                            assert.equal(session.modifiers, 0)
                        }
                        const applicationActions = await fixtureScript('window.__coordActions')
                        if (action === 'wheel') {
                            assert.equal(applicationActions, mask ? 1 : 0)
                            assert.equal(tool.find((event) => event.type === 'wheel')?.defaultPrevented, true)
                            assert.deepEqual(await fixtureScript('({x:scrollX,y:scrollY})'), viewportBefore)
                        }
                        const keyEvents = await fixtureScript('window.__modifierKeys')
                        assert.deepEqual(
                            keyEvents.map(({ type, key }) => ({ type, key })),
                            [
                                ...keys.map((key) => ({ type: 'keydown', key })),
                                ...[...keys].reverse().map((key) => ({ type: 'keyup', key })),
                            ]
                        )
                        let released
                        if (keys.length) {
                            const type =
                                action === 'down-up'
                                    ? 'mousedown'
                                    : action === 'right'
                                      ? 'contextmenu'
                                      : ['force', 'ref-actionable'].includes(action)
                                        ? 'click'
                                        : action
                            const pointer = tool.find((event) => event.type === type)
                            assert.ok(pointer.time >= keyEvents[keys.length - 1].time)
                            assert.ok(pointer.time <= keyEvents[keys.length].time)
                            const releasedBody = await call(actions)
                            completed(releasedBody, actions.length)
                            const releasedTool = (await events()).slice(tool.length)
                            assert.ok(releasedTool.length > 0)
                            for (const event of releasedTool) {
                                assert.equal(event.target, 'pad')
                                for (const field of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
                                    assert.equal(event[field], false, JSON.stringify(event))
                                }
                            }
                            assert.equal(unified.modifiers, 0)
                            assert.equal(unified.pressedKeys.size, 0)
                            if (action === 'wheel') {
                                assert.equal(await fixtureScript('window.__coordActions'), applicationActions)
                                assert.equal(
                                    releasedTool.find((event) => event.type === 'wheel')?.defaultPrevented,
                                    true
                                )
                                assert.deepEqual(await fixtureScript('({x:scrollX,y:scrollY})'), viewportBefore)
                            }
                            released = { body: releasedBody, tool: releasedTool }
                        }
                        return {
                            mask,
                            body,
                            tool,
                            applicationActions,
                            keyEvents,
                            released,
                            commands: result.bridgeCommands.slice(firstCommand),
                            nativeInputs: (await worker('coordinates.nativeInputs()')).slice(firstNative),
                            viewportBefore,
                        }
                    })
                }
            }
        }
        for (const inputMode of mode === 'extension' ? ['stealth', 'precise'] : ['precise']) {
            unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
            await setup([{ css: 'transform:scale(1.6);border:6px solid black' }])
            for (const keys of [[], ['Alt'], ['Control'], ['Meta'], ['Shift'], ['Control', 'Shift']]) {
                for (const action of ['wheel', 'right', 'ref', 'force']) {
                    await record(`iframe-modifiers-${inputMode}-${keys.join('+') || 'none'}-${action}`, async () => {
                        const mask = keys.reduce((v, k) => v | { Alt: 1, Control: 2, Meta: 4, Shift: 8 }[k], 0)
                        await clear()
                        const sequence = [
                            ...keys.map((key) => ({ type: 'keydown', key })),
                            {
                                type: action === 'wheel' ? 'wheel' : 'click',
                                target: ['ref', 'force'].includes(action) ? { css: '#pad' } : { x: 140, y: 110 },
                                ...(action === 'wheel' ? { deltaY: 120 } : {}),
                                ...(action === 'right' ? { button: 'right' } : {}),
                                ...(action === 'force'
                                    ? { force: true, forceReason: 'isolated frame regression' }
                                    : {}),
                            },
                            ...[...keys].reverse().map((key) => ({ type: 'keyup', key })),
                        ]
                        const body = await call(sequence)
                        completed(body, sequence.length)
                        const tool = await events()
                        assert.ok(tool.length > 0)
                        for (const event of tool) {
                            assert.equal(event.target, 'pad')
                            for (const [field, bit] of [
                                ['altKey', 1],
                                ['ctrlKey', 2],
                                ['metaKey', 4],
                                ['shiftKey', 8],
                            ]) {
                                assert.equal(event[field], Boolean(mask & bit), JSON.stringify(event))
                            }
                        }
                        assert.equal(unified.modifiers, 0)
                        assert.equal(unified.pressedKeys.size, 0)
                        if (action === 'wheel') {
                            assert.equal(await fixtureScript('window.__coordActions'), mask ? 1 : 0)
                        }
                        return { body, tool }
                    })
                }
            }
        }
        unified.setInputMode('precise')
        await setup([{ css: 'transform:scale(1.6);border:6px solid black' }])
        for (const inputMode of mode === 'extension' ? ['precise', 'stealth'] : ['precise']) {
            unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
            await record(
                inputMode === 'precise' ? 'touch-point-selector' : 'stealth-touch-point-selector',
                async () => {
                    await clear()
                    const body = await call([
                        { type: 'touchstart', target: { x: 140, y: 110 } },
                        { type: 'touchmove', target: { css: '#pad' } },
                        { type: 'touchend' },
                    ])
                    completed(body, 3)
                    const tool = await events()
                    assert.ok(tool.some((e) => e.type === 'touchstart' && e.target === 'pad'))
                    assert.ok(tool.some((e) => e.type === 'touchend' && e.target === 'pad'))
                    return { body, tool, inputMode }
                }
            )
        }
        unified.setInputMode('precise')
        await record('selection-local-focus', async () => {
            const body = await call([{ type: 'select', target: { css: '#text' }, find: 'bravo' }])
            completed(body, 1)
            assert.equal(await fixtureScript('getSelection().toString()'), 'bravo')
            return { body, tool: await events() }
        })
        await record('command-local-focus', async () => {
            const body = await call([
                { type: 'keydown', key: 'a', commands: ['selectAll'], target: { x: 120, y: 200 } },
                { type: 'keyup', key: 'a' },
            ])
            completed(body, 2)
            assert.equal(await fixtureScript('document.activeElement.id'), 'edit')
            return { body }
        })
        await record('no-target-wheel-after-frame-restoration', async () => {
            await call([{ type: 'mousemove', target: { x: 140, y: 110 } }])
            await clear()
            const body = await call([{ type: 'wheel', deltaY: 120 }], { frame: undefined })
            completed(body, 1)
            const tool = await events()
            assert.equal(tool.find((e) => e.type === 'wheel')?.target, 'pad')
            return { body, tool }
        })
        await record('no-target-mouse-after-frame-restoration', async () => {
            await call([{ type: 'mousemove', target: { x: 140, y: 110 } }])
            await clear()
            const body = await call([{ type: 'mousedown' }, { type: 'mouseup' }, { type: 'click' }], {
                frame: undefined,
            })
            completed(body, 3)
            const tool = await events()
            assert.ok(tool.some((e) => e.type === 'click'))
            assert.ok(tool.every((e) => e.target === 'pad'))
            return { body, tool }
        })
        if (mode === 'extension') {
            for (const inputMode of ['precise', 'stealth']) {
                unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
                await record(inputMode === 'precise' ? 'drag-ref' : 'stealth-drag-ref', async () => {
                    await clear()
                    const body = await call([{ type: 'drag', target: { css: '#pad' }, to: { css: '#drop' } }])
                    completed(body, 1)
                    const tool = await events()
                    assert.equal(tool.filter((event) => event.type === 'drop').length, 1)
                    assert.equal(tool.find((event) => event.type === 'drop')?.target, 'drop')
                    return { body, tool, inputMode }
                })
            }
            unified.setInputMode('precise')
        }
        await setup([])
        for (const inputMode of mode === 'extension' ? ['stealth', 'precise'] : ['precise']) {
            unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
            for (const control of ['default', 'preventDefault', 'disabled']) {
                await record(`activation-${inputMode}-${control}`, async () => {
                    await clear()
                    await fixtureScript('(document.getElementById("pad").checked=false,true)')
                    if (control === 'preventDefault') {
                        await fixtureScript(
                            '(document.getElementById("pad").addEventListen' +
                                'er("click",e=>e.preventDefault(),{once:true}),' +
                                'true)'
                        )
                    }
                    const body = await call(
                        [{ type: 'click', target: { css: control === 'disabled' ? '#disabled' : '#pad' } }],
                        { timeout: control === 'disabled' ? 200 : 7000 }
                    )
                    if (control === 'disabled') {
                        assert.notEqual(body.actionStatus, 'completed')
                        assert.equal(body.eventsExecuted, 0)
                        assert.equal(
                            (await events()).some((e) => e.type === 'click'),
                            false
                        )
                    } else {
                        completed(body, 1)
                    }
                    const checked = await fixtureScript('document.getElementById("pad").checked')
                    assert.equal(checked, control === 'default')
                    return { body, checked, tool: await events() }
                })
            }
        }
        unified.setInputMode('precise')
        await record('target-and-frame-restoration', async () => {
            const { targetId } = await observer.send('Target.createTarget', { url: base + '/other?' + mode })
            try {
                const other = await until(async () =>
                    (await worker('coordinates.tabs()')).find((t) => t.url === base + '/other?' + mode)
                )
                await worker(`coordinates.adopt(${other.id})`)
                await until(() => worker(`coordinates.script(${other.id},0,'document.readyState==="complete"')`))
                await worker(`coordinates.script(${other.id},0,${JSON.stringify('(' + configure.toString() + ')()')})`)
                const body = await call([{ type: 'click', target: { x: 140, y: 110 } }], {
                    targetId: mode === 'cdp' ? targetId : String(other.id),
                    frame: undefined,
                })
                completed(body, 1)
                assert.equal(body.pageContext.defaultTargetChanged, false)
                assert.equal(
                    mode === 'cdp' ? session.getCurrentTargetId() : bridge.getCurrentTargetId(),
                    mode === 'cdp' ? rootId : String(tabId)
                )
                assert.equal(mode === 'cdp' ? session.getCurrentFrameId() : bridge.getCurrentFrameId(), 0)
                const tool = await worker(`coordinates.script(${other.id},0,'window.__coordEvents')`)
                assert.equal(tool.find((e) => e.type === 'click')?.target, 'pad')
                return { body, tool }
            } finally {
                await observer.send('Target.closeTarget', { targetId })
            }
        })
        await setup([{ css: 'top:1450px;left:100px;transform:scale(1.3) rotate(4deg)' }])
        await record('scroll-reacquires-frame-and-selector-geometry', async () => {
            await fixtureScript(
                '(document.getElementById("pad").style.top="900px",document.body.style.height="1600px",true)'
            )
            const body = await call([{ type: 'click', target: { css: '#pad' } }])
            completed(body, 1)
            const tool = await events()
            assert.equal(tool.find((e) => e.type === 'click')?.target, 'pad')
            assert.ok(await script(0, 'scrollY>0'))
            assert.ok(await fixtureScript('scrollY>0'))
            return { body, tool, parentScroll: await script(0, 'scrollY'), childScroll: await fixtureScript('scrollY') }
        })
        if (mode === 'cdp') {
            for (const nested of [false, true]) {
                for (const [from, to] of [
                    [1, 2],
                    [2, 1],
                    [1, 1],
                ]) {
                    for (const selector of [false, true]) {
                        const id =
                            'dynamic-zoom-' +
                            `${from}` +
                            '-' +
                            `${to}` +
                            '-' +
                            `${nested ? 'nested' : 'single'}` +
                            '-' +
                            `${selector ? 'selector' : 'point'}` +
                            ''
                        await record(id, async () => {
                            await setup([
                                { css: `zoom:${from}` },
                                ...(nested ? [{ css: 'left:20px;top:20px;transform:scale(.8)' }] : []),
                            ])
                            await fixtureScript(
                                '(() => {window.__zoomChanged=false;' +
                                    "document.addEventListener('wheel',()=>{" +
                                    `${nested ? 'parent.frameElement' : 'frameElement'}` +
                                    '.style.zoom=' +
                                    `${JSON.stringify(String(to))}` +
                                    ';window.__zoomChanged=true},{once:true});' +
                                    'return true})()'
                            )
                            const body = await call([
                                { type: 'wheel', target: { x: 140, y: 110 }, deltaY: 1 },
                                { type: 'wait', ms: 50 },
                                { type: 'click', target: selector ? { css: '#pad' } : { x: 140, y: 110 } },
                            ])
                            const entry = {
                                id,
                                body,
                                events: await events(),
                                changed: await fixtureScript('window.__zoomChanged'),
                                zoom: await script(
                                    0,
                                    'Number(getComputedStyle(document.querySelector("iframe")).zoom)'
                                ),
                            }
                            ;(result.reviewGeometry ??= []).push(entry)
                            completed(body, 3)
                            assert.equal(entry.changed, true)
                            assert.equal(entry.zoom, to)
                            assert.deepEqual(
                                entry.events.filter((event) => event.type === 'click').map((event) => event.target),
                                ['pad']
                            )
                            return entry
                        })
                    }
                }
            }
            for (const property of ['rotate', 'scale']) {
                for (const prior of [false, true]) {
                    const id = `zoom-anchor-${property}-${prior ? 'prior-completed' : 'not-started'}-zero-dispatch`
                    await record(id, async () => {
                        await setup([{ css: 'zoom:2' }, { css: 'left:20px;top:20px;transform:scale(.8)' }])
                        await script(
                            frameIds[0],
                            '(() => {document.documentElement.style.' +
                                `${property}` +
                                '=' +
                                `${JSON.stringify(property === 'rotate' ? '30deg' : '-1 1')}` +
                                ';return true})()'
                        )
                        const first = result.productionCommands.length
                        const body = await call([
                            ...(prior ? [{ type: 'wait', ms: 50 }] : []),
                            { type: 'mousemove', target: { x: 140, y: 110 } },
                        ])
                        const entry = {
                            id,
                            body,
                            events: await events(),
                            nativeInput: result.productionCommands
                                .slice(first)
                                .filter((command) => command.method.startsWith('Input.')),
                        }
                        ;(result.reviewGeometry ??= []).push(entry)
                        assert.equal(body.error?.code, 'FRAME_GEOMETRY_UNAVAILABLE', JSON.stringify(body))
                        assert.equal(body.eventsExecuted, prior ? 1 : 0)
                        assert.equal(body.actionExecuted, prior)
                        assert.deepEqual(entry.nativeInput, [])
                        assert.deepEqual(entry.events, [])
                        return entry
                    })
                }
            }
            await setup([{ css: 'transform:perspective(300px) rotateY(30deg)' }])
            await record('reliable-selector-does-not-require-raw-affine-map', async () => {
                const before = result.boxModels.length
                const body = await call([{ type: 'click', target: { css: '#pad' } }])
                completed(body, 1)
                assert.equal((await events()).find((e) => e.type === 'click')?.target, 'pad')
                assert.ok(result.boxModels.slice(before).every((c) => c.args[1].nodeId !== undefined))
                return { body, tool: await events() }
            })
            for (const prior of [false, true]) {
                await setup([{ css: 'transform:scale(1.4)' }])
                await record(
                    `removed-document-${prior ? 'prior-completed' : 'not-started'}-zero-dispatch`,
                    async () => {
                        const original = session.mapFramePoint
                        let removed = false
                        session.mapFramePoint = async function (...args) {
                            if (!removed) {
                                removed = true
                                await script(0, '(document.querySelector("iframe").remove(),true)')
                            }
                            return original.apply(this, args)
                        }
                        try {
                            const before = result.productionCommands.filter((c) => c.method.startsWith('Input.')).length
                            const body = await call([
                                ...(prior ? [{ type: 'wait', ms: 1 }] : []),
                                { type: 'mousemove', target: { x: 140, y: 110 } },
                            ])
                            assert.notEqual(body.actionStatus, 'completed')
                            assert.equal(body.eventsExecuted, prior ? 1 : 0)
                            assert.equal(body.actionExecuted, prior)
                            assert.equal(
                                result.productionCommands.filter((c) => c.method.startsWith('Input.')).length,
                                before
                            )
                            return {
                                body,
                                controlledBoundary:
                                    'Actual iframe removed immediately before production raw-point mapping',
                            }
                        } finally {
                            session.mapFramePoint = original
                        }
                    }
                )
            }
        }
        for (const [name, css] of [
            ['singular', 'transform:scale(0)'],
            ['non-affine', 'transform:perspective(300px) rotateY(30deg)'],
            ['zero-viewport', 'width:0;height:0'],
        ]) {
            await setup([{ css }])
            await record(name + '-zero-dispatch', async () => {
                const before = result.productionCommands.filter((c) => c.method.startsWith('Input.')).length
                const extensionBefore = (await worker('coordinates.nativeInputs()')).length
                const body = await call([{ type: 'mousemove', target: { x: 140, y: 110 } }])
                assert.notEqual(body.actionStatus, 'completed', JSON.stringify(body))
                assert.equal(body.eventsExecuted, 0)
                assert.equal((await events()).length, 0)
                assert.equal(result.productionCommands.filter((c) => c.method.startsWith('Input.')).length, before)
                assert.equal((await worker('coordinates.nativeInputs()')).length, extensionBefore)
                return { body }
            })
        }
    }
    if (mode === 'extension') {
        for (const framed of [false, true]) {
            for (const ending of ['deadline', 'cancel']) {
                await record(`extension-late-metadata-${ending}-${framed ? 'frame' : 'main'}`, async () => {
                    await setup()
                    const entry = {
                        framed,
                        ending,
                        boundary:
                            'Actual SDK, installed ActionHandler and ' +
                            'native DOM key events; only successful ' +
                            'post-action page_snapshot delivery is ' +
                            'withheld with the production ' +
                            'budget/cancellation helper',
                    }
                    ;(result.extensionLifecycle ??= []).push(entry)
                    const originalCommand = bridge.httpServer.sendCommand
                    const originalEvaluate = unified.evaluate
                    const controller = new AbortController()
                    let other,
                        inputFrame = 0,
                        matched = false,
                        releaseMetadata,
                        pendingCall
                    const read = async (id, frame, code) => {
                        ++result.observerReads
                        return worker(`coordinates.script(${id},${frame},${JSON.stringify(code)})`)
                    }
                    const invoke = (name, args, options) => {
                        ++result.sdkCalls
                        return client.callTool(
                            { name, arguments: { targetId: String(tabId), ...args } },
                            undefined,
                            options
                        )
                    }
                    const install =
                        '(() => {\n                        ' +
                        'window.__lateAbort?.abort(); ' +
                        'window.__lateAbort=new AbortController();\n    ' +
                        '                    window.__lateKeys=new ' +
                        'Set(); window.__lateEvents=[];\n               ' +
                        "         document.body.innerHTML='<input " +
                        'id="late-edit" type="text">\';\n                ' +
                        "        for(const type of ['keydown'," +
                        "'keyup']) document.addEventListener(type," +
                        'event=>{\n                            ' +
                        "if(type==='keydown')window.__lateKeys.add(even" +
                        't.key);else window.__lateKeys.delete(event.key' +
                        ');\n                            ' +
                        'window.__lateEvents.push({type,key:event.key,' +
                        'trusted:event.isTrusted});\n                   ' +
                        '     },{signal:window.__lateAbort.signal});\n  ' +
                        "                      document.querySelector('" +
                        "input').focus(); return true;\n                " +
                        '    })()'
                    const state = '({held:[...window.__lateKeys],events:window.__lateEvents})'
                    let handler
                    try {
                        await read(tabId, 0, install)
                        other = await worker(
                            'chrome.tabs.create({url:' +
                                `${JSON.stringify(base + '/?late-metadata=' + framed + '-' + ending)}` +
                                ',active:false})'
                        )
                        await worker(`coordinates.adopt(${other.id})`)
                        await until(() => read(other.id, 0, 'document.readyState==="complete"'))
                        await read(other.id, 0, install)
                        if (framed) {
                            const src = base + '/?late-input-frame=' + ending
                            await read(
                                other.id,
                                0,
                                "(() => {const f=document.createElement('iframe" +
                                    "');f.id='late-frame';f.src=" +
                                    `${JSON.stringify(src)}` +
                                    ';document.body.append(f);return true})()'
                            )
                            const frames = await until(async () => {
                                const frames = await worker(`coordinates.frames(${other.id})`)
                                return frames.some((frame) => frame.url === src) && frames
                            })
                            inputFrame = frames.find((frame) => frame.url === src).frameId
                            await until(() => read(other.id, inputFrame, 'document.readyState==="complete"'))
                            await read(other.id, inputFrame, install)
                        }
                        const nativeStart = (await worker('coordinates.nativeInputs()')).length
                        const bridgeStart = result.bridgeCommands.length
                        const recordStart = result.handlerRecords.length
                        unified.evaluate = async (...args) => {
                            const answer = await originalEvaluate.apply(unified, args)
                            if (args[0].includes('matched: Boolean') && answer.matched === true) {
                                matched = true
                                entry.matchedAckAt = performance.now()
                            }
                            return answer
                        }
                        bridge.httpServer.sendCommand = async (action, params, timeout, ...args) => {
                            const answer = await originalCommand.call(
                                bridge.httpServer,
                                action,
                                params,
                                timeout,
                                ...args
                            )
                            if (
                                matched &&
                                !entry.metadataHeldAt &&
                                action === 'page_snapshot' &&
                                params.tabId === other.id
                            ) {
                                entry.metadataHeldAt = performance.now()
                                entry.restoredAtMetadata = { target: bridge.currentTabId, frame: bridge.currentFrameId }
                                const scope = unified.tabLockContext.getStore()
                                return withNavigationBudget(
                                    () =>
                                        new Promise((resolve) => {
                                            releaseMetadata = () => resolve(answer)
                                        }),
                                    Math.min(Date.now() + timeout, scope.deadline),
                                    scope.signal
                                )
                            }
                            return answer
                        }
                        pendingCall = invoke(
                            'input',
                            {
                                targetId: String(other.id),
                                events: [{ type: 'keydown', key: 'Shift' }],
                                timeout: ending === 'deadline' ? 1500 : 5000,
                                ...(framed ? { frame: '#late-frame' } : {}),
                                postCondition: { script: 'true', timeout: 4000 },
                            },
                            { signal: controller.signal }
                        ).then(
                            (response) => ({ response }),
                            (error) => ({ cancelled: String(error) })
                        )
                        await until(() => entry.metadataHeldAt)
                        assert.equal(matched, true)
                        assert.deepEqual(entry.restoredAtMetadata, { target: tabId, frame: 0 })
                        handler = result.handlerRecords.slice(recordStart).find((item) => item.name === 'input')
                        if (ending === 'cancel') {
                            controller.abort(new Error('SDK cancellation after Extension matched ACK'))
                            await until(() => handler.aborted !== undefined)
                        }
                        entry.clientOutcome = await pendingCall
                        await until(() => handler.finished !== undefined)
                        entry.handler = handler
                        entry.afterMetadataMs = handler.finished - entry.metadataHeldAt
                        entry.inputDocument = await read(other.id, inputFrame, state)
                        entry.parentDocument = framed ? await read(other.id, 0, state) : null
                        entry.defaultDocument = await read(tabId, 0, state)
                        entry.keys = [...unified.pressedKeys]
                        entry.modifiers = unified.modifiers
                        entry.restored = { target: bridge.currentTabId, frame: bridge.currentFrameId }
                        entry.nativeKeys = (await worker('coordinates.nativeInputs()'))
                            .slice(nativeStart)
                            .filter(
                                (command) =>
                                    command.method === 'Input.dispatchKeyEvent' && command.params.key === 'Shift'
                            )
                        entry.bridgeKeys = result.bridgeCommands
                            .slice(bridgeStart)
                            .filter((command) => command.action === 'input_key' && command.params.key === 'Shift')
                        if (ending === 'deadline') {
                            entry.body = payload(entry.clientOutcome.response)
                            completed(entry.body, 1)
                            assert.equal(entry.body.verificationStatus, 'matched')
                            assert.equal(typeof entry.body.pageContext.contextError, 'string')
                        } else {
                            assert.ok(entry.clientOutcome.cancelled)
                            assert.ok(!result.businessResponseIds.includes(handler.requestId))
                        }
                        assert.deepEqual(
                            entry.nativeKeys.map((command) => command.params.type),
                            ['keyDown', 'keyUp']
                        )
                        assert.deepEqual(entry.nativeKeys[0].target, entry.nativeKeys[1].target)
                        assert.equal(entry.nativeKeys[0].target.tabId, other.id)
                        assert.equal(entry.bridgeKeys.length, 2)
                        assert.ok(entry.bridgeKeys.every((command) => command.params.tabId === other.id))
                        assert.deepEqual(entry.inputDocument.held, [])
                        assert.ok(
                            entry.inputDocument.events.some(
                                (event) => event.type === 'keyup' && event.key === 'Shift' && event.trusted
                            )
                        )
                        assert.deepEqual(entry.parentDocument?.events ?? [], [])
                        assert.deepEqual(entry.defaultDocument.events, [])
                        assert.deepEqual(entry.keys, [])
                        assert.equal(entry.modifiers, 0)
                        assert.deepEqual(entry.restored, { target: tabId, frame: 0 })
                        bridge.httpServer.sendCommand = originalCommand
                        unified.evaluate = originalEvaluate
                        releaseMetadata()
                        entry.followEvaluate = payload(await invoke('evaluate', { script: '1', timeout: 500 }))
                        entry.followInput = payload(
                            await invoke('input', {
                                events: [
                                    { type: 'keydown', key: 'a' },
                                    { type: 'keyup', key: 'a' },
                                ],
                                timeout: 400,
                            })
                        )
                        assert.equal(entry.followEvaluate.success, true)
                        assert.equal(entry.followInput.success, true)
                        return entry
                    } finally {
                        bridge.httpServer.sendCommand = originalCommand
                        unified.evaluate = originalEvaluate
                        releaseMetadata?.()
                        if (pendingCall) {
                            controller.abort(new Error('Fixture finalization'))
                            await pendingCall
                            if (handler) {
                                await until(() => handler.finished !== undefined)
                            }
                        }
                        entry.terminalBeforeFixtureCleanup = {
                            keys: [...unified.pressedKeys],
                            modifiers: unified.modifiers,
                            target: bridge.currentTabId,
                            frame: bridge.currentFrameId,
                        }
                        if (unified.pressedKeys.has('Shift')) {
                            entry.fixtureCleanup =
                                'Release remaining Shift only after recording the product terminal state'
                            await unified.keyUp('Shift', 1000, { targetId: String(other.id), frameId: inputFrame })
                        }
                        if (other) {
                            await worker(`chrome.tabs.remove(${other.id})`)
                        }
                    }
                })
            }
        }
    }
    if (mode === 'extension') {
        let backgroundPage
        for (const inputMode of ['precise', 'stealth']) {
            for (const framed of [false, true]) {
                for (const action of ['mousemove', 'down-up']) {
                    await record(`c31f8-hidden-${inputMode}-${framed}-${action}`, async (entry) => {
                        unified.setInputMode(/** @type {'precise' | 'stealth'} */ (inputMode))
                        await setup(framed ? [{ css: 'height:320px' }] : [])
                        await fixtureScript(
                            '(() => {\n                            ' +
                                "document.body.style.minHeight='3000px';" +
                                'window.__coordCaptureRects=true;\n             ' +
                                '               const pad=document.querySelecto' +
                                "r('#pad');\n                            " +
                                "pad.style.cssText='position:absolute;" +
                                'left:80px;top:2100px;width:80px;height:70px;' +
                                "margin:0';\n                            " +
                                "window.__c31f8Scroll=[];window.addEventListener('scroll',event=>" +
                                "{pad.style.left='240px';window.__c31f8Scroll.push({at:performance.now(),visibility:document.visibilityState});" +
                                'event.stopImmediatePropagation()},' +
                                '{capture:true,once:true,' +
                                'signal:window.__coordAbort.signal});\n         ' +
                                '                   return true;\n              ' +
                                '          })()'
                        )
                        backgroundPage ??= await pipe('Target.createTarget', { url: 'about:blank' })
                        entry.beforeVisibility = await fixtureScript('document.visibilityState')
                        assert.equal(entry.beforeVisibility, 'hidden')
                        await fixtureScript(
                            '(() => {window.__c31f8RAF=0;const id=requestAnimationFrame(()=>++window.__c31f8RAF);' +
                                'window.__coordAbort.signal.addEventListener("abort",()=>cancelAnimationFrame(id),{once:true});return true})()'
                        )
                        const sequence =
                            action === 'down-up'
                                ? [{ type: 'mousedown', target: { css: '#pad' } }, { type: 'mouseup' }]
                                : [{ type: 'mousemove', target: { css: '#pad' } }]
                        const first = (await worker('coordinates.nativeInputs()')).length
                        entry.body = await call(sequence, { timeout: 1200 })
                        entry.inputs = (await worker('coordinates.nativeInputs()')).slice(first)
                        entry.tool = await events()
                        entry.layout = await fixtureScript(
                            "(() => {const r=document.querySelector('#pad')" +
                                '.getBoundingClientRect();return {rect:{x:r.x,' +
                                'y:r.y,width:r.width,height:r.height},' +
                                'visibility:document.visibilityState}})()'
                        )
                        await clear()
                        entry.oracle = await oracle({
                            x: entry.layout.rect.x + entry.layout.rect.width / 2,
                            y: entry.layout.rect.y + entry.layout.rect.height / 2,
                        })
                        await native(action, entry.oracle)
                        entry.reference = await events()
                        const type = action === 'down-up' ? 'mousedown' : 'mousemove'
                        assert.equal(
                            entry.reference.find((event) => event.type === type)?.target,
                            'pad',
                            JSON.stringify(entry)
                        )
                        assert.equal(entry.layout.visibility, 'hidden')
                        entry.scrollAtReturn = await fixtureScript('window.__c31f8Scroll')
                        await until(async () => {
                            const observation = await fixtureScript(
                                '({scroll:window.__c31f8Scroll,raf:window.__c31f8RAF,visibility:document.visibilityState})'
                            )
                            entry.scrollObserved = observation.scroll
                            entry.rafObserved = observation.raf
                            entry.observedVisibility = observation.visibility
                            return entry.scrollObserved.length > 0
                        })
                        assert.ok(entry.scrollObserved.every((event) => event.visibility === 'hidden'))
                        assert.equal(entry.observedVisibility, 'hidden')
                        assert.equal(entry.rafObserved, 0)
                        if (inputMode === 'precise') {
                            assert.equal(entry.body.error.code, 'NATIVE_INPUT_UNAVAILABLE')
                            assert.equal(entry.body.actionExecuted, false)
                            assert.equal(entry.body.actionStatus, 'not_started')
                            assert.equal(entry.body.retryable, false)
                            assert.equal(entry.body.eventsExecuted, 0)
                            assert.deepEqual(entry.inputs, [])
                            assert.deepEqual(entry.tool, [])
                        } else {
                            completed(entry.body, sequence.length)
                            assert.ok(
                                entry.tool.some((event) => event.type === type),
                                JSON.stringify(entry)
                            )
                            for (const event of entry.tool.filter((event) => event.type === type)) {
                                assert.equal(event.target, 'pad', JSON.stringify(entry))
                                assert.ok(
                                    Math.abs(event.x - (event.targetRect.x + event.targetRect.width / 2)) <= 1,
                                    JSON.stringify(entry)
                                )
                                assert.ok(
                                    Math.abs(event.y - (event.targetRect.y + event.targetRect.height / 2)) <= 1,
                                    JSON.stringify(entry)
                                )
                            }
                        }
                    })
                }
            }
        }
    }
    result.status = result.checks.every((c) => c.status === 'PASS') ? 'PASS' : 'FAIL'
} catch (error) {
    result.status = 'ERROR'
    result.error = String(error)
    result.stack = error.stack
} finally {
    const cdp = session.cdp
    const errors = []
    result.cleanupAttempts = []
    const cleanup = async (name, close) => {
        result.cleanupAttempts.push(name)
        try {
            await close()
            if (process.env.COORD_CLEANUP_FAILURE === name) {
                // noinspection ExceptionCaughtLocallyJS — 将受控清理失败收集为测试结果
                throw new Error('Controlled cleanup failure: ' + name)
            }
        } catch (error) {
            errors.push({ resource: name, error: String(error) })
        }
    }
    await cleanup('client', () => client?.close())
    await cleanup('server', () => server?.close())
    unified.extensionBridge = null
    await cleanup('session', () => session.close())
    await cleanup('observer', () => observer?.close())
    await cleanup('chrome', async () => {
        if (chrome.exitCode === null && chrome.signalCode === null) {
            const exited = once(chrome, 'exit')
            chrome.kill('SIGTERM')
            await Promise.race([exited, delay(3000)])
            // noinspection PointlessBooleanExpressionJS — 等待期间进程可以退出
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
    await cleanup('pipe', () => {
        for (const p of pending.values()) {
            clearTimeout(p.timer)
            p.reject(new Error('Fixture closed'))
        }
        pending.clear()
    })
    if (errors.length) {
        result.cleanupErrors = errors
        result.cleanupError = errors.map((entry) => entry.error).join('; ')
        if (result.status === 'PASS') {
            result.status = 'ERROR'
        }
    }
    result.resources = {
        chromeExited: chrome.exitCode !== null || chrome.signalCode !== null,
        pipePending: pending.size,
        observerCallbacks: observer?.callbacks.size ?? 0,
        serverCallbacks: cdp?.callbacks.size ?? 0,
    }
    result.passed = result.checks.filter((c) => c.status === 'PASS').length
    result.failed = result.checks.length - result.passed
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
    console.log(
        JSON.stringify({
            status: result.status,
            checks: result.checks.length,
            passed: result.passed,
            failed: result.failed,
            sdkCalls: result.sdkCalls,
            registeredCalls: result.registeredCalls,
            error: result.error,
            output,
        })
    )
    process.exitCode = result.status === 'PASS' ? 0 : 1
}
