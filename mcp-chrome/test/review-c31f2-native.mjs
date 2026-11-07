import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { wheelCases } from './review-c31f2-wheel-fixtures.mjs'
import { getUnifiedSession } from '../dist/core/index.js'
import { ExtensionBridge } from '../dist/extension/bridge.js'
import { registerInputTool } from '../dist/tools/input.js'

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
        permissions: ['tabs', 'scripting', 'storage', 'webNavigation'],
        host_permissions: ['http://127.0.0.1/*'],
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
            entry: path.join(root, 'test/review-c31f2-native-extension.ts'),
            formats: ['es'],
            fileName: () => 'review.js',
        },
    },
})
const http = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(
        request.url === '/child'
            ? '<!doctype html><title>Wheel child</title><body></body>'
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
    publicInputs: 0,
    nativeReferences: 0,
    work,
    boundary:
        'registered public input/UnifiedSession/ExtensionBridge, production Extension handlers and real installed isolated Extension/Chrome APIs; command transport forwarded through pipe evaluator; native wheel dispatched to the same real browser on a rebuilt fixture',
}
try {
    result.browser = await send('Browser.getVersion')
    const loaded = await send('Extensions.loadUnpacked', { path: extension })
    const worker = await poll(
        async () =>
            (await send('Target.getTargets')).targetInfos.find(
                (target) => target.type === 'service_worker' && target.url.includes(loaded.id)
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
    await poll(() => evaluate('Boolean(globalThis.c31f2)'), Boolean)
    const tab = await poll(
        async () => (await evaluate('c31f2.tabs()')).find((entry) => entry.url === base + '/'),
        Boolean
    )
    const page = (await send('Target.getTargets')).targetInfos.find(
        (entry) => entry.type === 'page' && entry.url === base + '/'
    )
    const { sessionId: pageSession } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
    await evaluate(`c31f2.adopt(${tab.id})`)
    const frames = await poll(
        () => evaluate(`c31f2.frames(${tab.id})`),
        (items) => items?.length === 2 && items.every((entry) => entry.documentId)
    )
    const top = frames.find((entry) => entry.frameId === 0)
    const child = frames.find((entry) => entry.frameId !== 0)
    const command = async (action, params) => {
        if (action === 'tabs_list') {
            return evaluate('c31f2.tabs()')
        }
        const value = await evaluate(
            `c31f2.command(${JSON.stringify(action)},${JSON.stringify(params)}).then(result=>({result}),error=>({error:error.message}))`
        )
        if (value.error) {
            throw new Error(value.error)
        }
        return value.result
    }
    const unified = getUnifiedSession()
    const bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() })
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
            void command(message.action, message.params).then(
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
        getPageSnapshot: async () => ({ targetId: String(tab.id), url: tab.url, revision: 'native' }),
        listTargets: async () => [{ targetId: String(tab.id) }],
        listTopology: async () => ({ activeTargetId: String(tab.id) }),
        hasBrowserEventObservation: () => false,
        getChallengeState: async () => null,
        getState: () => ({ title: 'Native test', url: tab.url }),
        getLiveState: async () => ({ title: 'Native test', url: tab.url }),
        inspectChallenge: async () => ({
            inspected: true,
            title: 'Native test',
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
    const previous = new Map(Object.keys(overrides).map((key) => [key, Object.getOwnPropertyDescriptor(unified, key)]))
    Object.assign(unified, overrides)
    let input
    let schema
    registerInputTool({
        registerTool(_name, config, handler) {
            schema = config.inputSchema
            input = handler
        },
    })
    const read = (frameId) => evaluate(`c31f2.read(${tab.id},${frameId})`)
    const configure = async (frameId, options) => {
        const value = await evaluate(`c31f2.configure(${tab.id},${frameId},${JSON.stringify(options)})`)
        assert.equal(value.hit, 'inner', JSON.stringify(value))
        return value
    }
    const settle = async (frameId, eventRequired) => {
        let prior
        let stable = 0
        const deadline = Date.now() + 2500
        while (Date.now() < deadline) {
            const value = await read(frameId)
            const positions = JSON.stringify([
                value.target,
                value.container,
                value.outer,
                value.viewport,
                value.root,
                value.body,
            ])
            stable = positions === prior ? stable + 1 : 0
            prior = positions
            if (stable >= 5 && (!eventRequired || value.events.length === 1)) {
                return value
            }
            await delay(20)
        }
        throw new Error('Wheel state did not settle')
    }
    const compare = (actual, expected, label, axes = ['x', 'y']) => {
        for (const target of ['target', 'container', 'outer', 'viewport', 'root', 'body']) {
            for (const axis of axes) {
                assert.ok(
                    Math.abs(actual[target][axis] - expected[target][axis]) <= 1,
                    `${label} ${target}/${axis}: ${actual[target][axis]} != ${expected[target][axis]}`
                )
            }
        }
    }
    try {
        const cases = wheelCases().sort((a, b) => Number(Boolean(b.review)) - Number(Boolean(a.review)))
        for (const mode of ['precise', 'stealth']) {
            unified.inputMode = mode
            for (const selected of [top, child]) {
                const frame = selected.frameId === 0 ? undefined : 'iframe#owned'
                if (frame) {
                    await configure(top.frameId, { layout: 'normal', axis: 'y', position: 'origin' })
                    await send(
                        'Runtime.evaluate',
                        {
                            expression:
                                "document.documentElement.style.overflow='hidden'; window.scrollTo({left:0,top:0,behavior:'instant'})",
                        },
                        pageSession
                    )
                }
                for (const options of cases) {
                    result.current = { mode, frame: frame ?? 'main', options }
                    const before = await configure(selected.frameId, options)
                    const deltaX = options.axis === 'y' ? 0 : options.delta
                    const deltaY = options.axis === 'x' ? 0 : options.delta
                    const args = schema.parse({
                        targetId: String(tab.id),
                        frame,
                        timeout: 5000,
                        events: [
                            {
                                type: 'wheel',
                                target: options.target === 'css' ? { css: '#scroller' } : before.point,
                                deltaX,
                                deltaY,
                            },
                        ],
                    })
                    ++result.publicInputs
                    const response = await input(args)
                    const payload = JSON.parse(response.content[0].text)
                    assert.notEqual(response.isError, true, JSON.stringify(payload))
                    assert.equal(payload.actionStatus, 'completed')
                    assert.equal(payload.eventsExecuted, 1)
                    assert.equal(payload.retryable, false)
                    const tool = await settle(selected.frameId, options.target !== 'css')
                    if (options.target !== 'css') {
                        assert.equal(tool.events[0].trusted, false)
                        assert.equal(tool.events[0].composed, true)
                    }
                    const references = {}
                    // 混合输入按独立轴约定验收，每个原生参照只发送对应轴
                    for (const axis of options.group === 'mixed' ? ['x', 'y'] : ['both']) {
                        const referenceBefore = await configure(selected.frameId, options)
                        compare(referenceBefore.initial, before.initial, 'rebuilt fixture')
                        const offset = frame
                            ? (await command('resolve_frame', { tabId: tab.id, frame })).offset
                            : { x: 0, y: 0 }
                        ++result.nativeReferences
                        await send(
                            'Input.dispatchMouseEvent',
                            {
                                type: 'mouseWheel',
                                x: referenceBefore.point.x + offset.x,
                                y: referenceBefore.point.y + offset.y,
                                deltaX: axis === 'y' ? 0 : deltaX,
                                deltaY: axis === 'x' ? 0 : deltaY,
                            },
                            pageSession
                        )
                        const native = await settle(selected.frameId, true)
                        assert.equal(native.events[0].trusted, true)
                        assert.equal(native.events[0].target, 'inner')
                        result.current = { mode, frame: frame ?? 'main', options, tool, native, referenceAxis: axis }
                        compare(tool, native, JSON.stringify(result.current), axis === 'both' ? ['x', 'y'] : [axis])
                        references[axis] = native
                    }
                    assert.equal(bridge.getCurrentFrameId(), 0)
                    assert.equal(bridge.getCurrentFrameDocumentId(), top.documentId)
                    result.checks.push({
                        mode,
                        frame: frame ?? 'main',
                        options,
                        frameId: selected.frameId,
                        documentId: selected.documentId,
                        range: before.range,
                        initial: before.initial,
                        style: before.style,
                        tool,
                        references,
                    })
                }
            }
        }
    } finally {
        for (const [key, descriptor] of previous) {
            if (descriptor) {
                Object.defineProperty(unified, key, descriptor)
            } else {
                Reflect.deleteProperty(unified, key)
            }
        }
    }
    delete result.current
    result.status = 'PASS'
} catch (error) {
    result.status = 'FAIL'
    result.error = { message: error.message, stack: error.stack }
    process.exitCode = 1
} finally {
    for (const call of pending.values()) {
        clearTimeout(call.timer)
        call.reject(new Error('Native test cleanup'))
    }
    pending.clear()
    chrome.kill('SIGTERM')
    await Promise.race([once(chrome, 'exit').catch(() => {}), delay(3000)])
    http.closeAllConnections()
    await new Promise((resolve) => http.close(resolve))
    stderr.end()
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
    console.log(
        JSON.stringify(
            {
                status: result.status,
                cases: result.checks.length,
                output,
                current: result.current,
                error: result.error,
            },
            null,
            2
        )
    )
}
