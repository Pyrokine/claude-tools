import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { clearTimeout } from 'node:timers'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CDPClient } from '../dist/cdp/client.js'
import { ExtensionBridge } from '../dist/extension/bridge.js'
import { getSession, getUnifiedSession } from '../dist/core/index.js'
import { registerExtractTool } from '../dist/tools/extract.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-m16-geometry-'))
const output = process.argv[3] ?? path.join(work, 'results.json')
const result = { work, checks: [], failures: [], browser: null }
const extension = path.join(work, 'extension')
fs.mkdirSync(extension)
fs.writeFileSync(
    path.join(extension, 'manifest.json'),
    JSON.stringify({
        manifest_version: 3,
        name: 'Owned geometry regression',
        version: '1.0.0',
        permissions: ['tabs', 'tabGroups', 'scripting', 'storage', 'webNavigation', 'debugger'],
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
            entry: path.join(root, 'test/review-c31f6-coordinates-extension.ts'),
            formats: ['es'],
            fileName: () => 'review.js',
        },
    },
})
const http = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html')
    const child =
        '<!doctype html><body style="margin:0"><div id="target" data-value="readable" ' +
        'style="position:absolute;left:20px;top:30px;width:40px;height:30px;background:red">readable</div></body>'
    response.end(
        request.url === '/child'
            ? child
            : request.url === '/outer'
              ? '<!doctype html><body style="margin:0"><iframe id="nested" src="/child" ' +
                'style="border:0;width:200px;height:200px;transform:rotate(8deg);transform-origin:0 0"></iframe></body>'
              : '<!doctype html><body style="margin:0;position:relative;height:3000px"></body>'
    )
})
await new Promise((resolve) => http.listen(0, '127.0.0.1', () => resolve()))
const base = `http://127.0.0.1:${http.address().port}`
const chrome = spawn(
    process.argv[2] ?? process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
    [
        '--headless=new',
        '--no-sandbox',
        '--window-size=1200,900',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-sync',
        '--no-first-run',
        '--no-proxy-server',
        '--remote-debugging-port=0',
        '--remote-debugging-pipe',
        '--enable-unsafe-extension-debugging',
        `--user-data-dir=${path.join(work, 'profile')}`,
        base,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] }
)
chrome.stderr.pipe(fs.createWriteStream(path.join(work, 'chrome.log')))
let sequence = 0,
    buffer = ''
const pending = new Map()
chrome.stdio[4].on('data', (chunk) => {
    buffer += chunk.toString()
    let end
    while ((end = buffer.indexOf('\0')) >= 0) {
        const raw = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!raw) {
            continue
        }
        const reply = JSON.parse(raw),
            callback = pending.get(reply.id)
        if (!callback) {
            continue
        }
        pending.delete(reply.id)
        clearTimeout(callback.timer)
        if (reply.error) {
            callback.reject(new Error(JSON.stringify(reply.error)))
        } else {
            callback.resolve(reply.result)
        }
    }
})
function pipe(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error(`CDP timeout: ${method}`))
        }, 10000)
        pending.set(id, { resolve, reject, timer })
        chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
    })
}
async function until(read) {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
        const value = await read()
        if (value) {
            return value
        }
        await delay(15)
    }
    throw new Error('Owned browser fixture did not become ready')
}
let observer, pageSession, workerSession, client, server, bridge
const session = getSession(),
    unified = getUnifiedSession()
async function evaluate(expression, id = pageSession) {
    const value = await pipe('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, id)
    if (value.exceptionDetails) {
        throw new Error(JSON.stringify(value.exceptionDetails))
    }
    return value.result.value
}
async function check(name, run) {
    const entry = { name }
    try {
        await run(entry)
        entry.status = 'pass'
    } catch (error) {
        entry.status = 'fail'
        entry.error = String(error)
        result.failures.push(name)
    }
    result.checks.push(entry)
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
}
function payload(response) {
    return JSON.parse(response.content.find((item) => item.type === 'text').text)
}
function onePixel(base64) {
    const bytes = Buffer.from(base64, 'base64'),
        chunks = []
    assert.equal(bytes.readUInt32BE(16), 1)
    assert.equal(bytes.readUInt32BE(20), 1)
    assert.equal(bytes[24], 8)
    assert.ok([2, 6].includes(bytes[25]))
    for (let offset = 8; offset < bytes.length;) {
        const size = bytes.readUInt32BE(offset)
        if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
            chunks.push(bytes.subarray(offset + 8, offset + 8 + size))
        }
        offset += size + 12
    }
    return [...inflateSync(Buffer.concat(chunks)).subarray(1, 4)]
}
try {
    const port = await until(() => {
        try {
            return Number(fs.readFileSync(path.join(work, 'profile/DevToolsActivePort'), 'utf8').split('\n')[0])
        } catch {
            return false
        }
    })
    observer = new CDPClient()
    const version = await (await globalThis.fetch(`http://127.0.0.1:${port}/json/version`)).json()
    await observer.connect(version.webSocketDebuggerUrl)
    result.browser = await observer.send('Browser.getVersion')
    const page = (await pipe('Target.getTargets')).targetInfos.find(
        (target) => target.type === 'page' && target.url.startsWith(base)
    )
    pageSession = (await pipe('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId
    const loaded = await pipe('Extensions.loadUnpacked', { path: extension })
    const worker = await until(async () =>
        (await pipe('Target.getTargets')).targetInfos.find(
            (target) => target.type === 'service_worker' && target.url.includes(loaded.id)
        )
    )
    workerSession = (await pipe('Target.attachToTarget', { targetId: worker.targetId, flatten: true })).sessionId
    await until(() => evaluate('Boolean(globalThis.coordinates)', workerSession))
    const tab = await until(async () =>
        (await evaluate('coordinates.tabs()', workerSession)).find((value) => value.url.startsWith(base))
    )
    await evaluate(`coordinates.adopt(${tab.id})`, workerSession)
    await session.connect({ port, stealth: 'off' })
    await session.selectPage(page.targetId)
    bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() })
    bridge.httpServer.helloReceived = true
    bridge.httpServer.clientSocket = { readyState: 1, close() {} }
    bridge.httpServer.sendMessage = (_socket, message) => {
        if (message.type === 'cancel') {
            return
        }
        void evaluate(
            '(async()=>{try{return {success:true,data:await coordinates.command(' +
                `${JSON.stringify(message.action)},${JSON.stringify(message.params)})}}` +
                'catch(error){return {success:false,error:String(error.message)}}})()',
            workerSession
        ).then((reply) => bridge.httpServer.handleMessage(JSON.stringify({ id: message.id, ...reply })))
    }
    unified.extensionBridge = bridge
    server = new McpServer({ name: 'owned-geometry', version: '1.0.0' })
    registerExtractTool(server)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    client = new Client({ name: 'owned-geometry-client', version: '1.0.0' })
    await client.connect(b)
    for (const mode of ['extension', 'cdp']) {
        if (mode === 'extension') {
            unified.activeMode = 'extension'
            bridge.currentTabId = tab.id
            unified.cdpExplicitlySelected = false
        } else {
            unified.activeMode = 'cdp'
            unified.cdpExplicitlySelected = true
        }
        const targetId = mode === 'extension' ? String(tab.id) : page.targetId
        await check(`M16-C05-${mode}`, async (entry) => {
            await evaluate(
                'document.body.innerHTML=\'<iframe id="frame" src="/child" ' +
                    'style="position:absolute;left:500px;top:1000px;border:0;width:200px;height:200px">' +
                    "</iframe>';window.scrollTo(0,800);true"
            )
            await until(() =>
                evaluate('document.querySelector("iframe").contentDocument?.querySelector("#target")!==null')
            )
            const response = await client.callTool({
                name: 'extract',
                arguments: { type: 'screenshot', target: { css: '#target' }, frame: '#frame', targetId, timeout: 7000 },
            })
            entry.reply = payload(response)
            assert.equal(entry.reply.success, true, JSON.stringify(entry.reply))
            assert.deepEqual(entry.reply.metadata.clip, { x: 520, y: 1030, width: 40, height: 30 })
            fs.writeFileSync(
                path.join(work, `c05-${mode}.png`),
                Buffer.from(response.content.find((item) => item.type === 'image').data, 'base64')
            )
        })
        if (mode === 'extension') {
            await evaluate(
                `(async()=>{
                await coordinates.command('debugger_detach',{tabId:${tab.id}});
                globalThis.geometryAttaches=0;
                const attach=chrome.debugger.attach.bind(chrome.debugger);
                chrome.debugger.attach=(...args)=>{++globalThis.geometryAttaches;return attach(...args)};
                return true;
            })()`,
                workerSession
            )
            for (const [name, css, frame, src] of [
                ['scale', 'transform:scale(1.4)', '#frame', '/child'],
                ['rotate', 'transform:rotate(12deg)', '#frame', '/child'],
                ['nested', 'transform:scale(1.2)', ['#frame', '#nested'], '/outer'],
            ]) {
                await check(`M16-C02-${name}`, async (entry) => {
                    await evaluate(
                        `window.scrollTo(0,0);document.body.innerHTML='<iframe id="frame" src="${src}" ` +
                            'style="position:absolute;left:250px;top:100px;border:0;width:300px;height:300px;' +
                            `transform-origin:0 0;${css}"></iframe>';true`
                    )
                    await until(() =>
                        evaluate(
                            "Boolean(document.querySelector('iframe').contentDocument?.querySelector('" +
                                `${src === '/outer' ? '#nested' : '#target'}'))`
                        )
                    )
                    entry.attachCountBefore = await evaluate('globalThis.geometryAttaches', workerSession)
                    entry.reads = []
                    for (const type of ['text', 'attribute', 'state']) {
                        const response = await client.callTool({
                            name: 'extract',
                            arguments: {
                                type,
                                target: { css: '#target' },
                                ...(type === 'attribute' ? { attribute: 'data-value' } : {}),
                                frame,
                                targetId,
                                timeout: 7000,
                            },
                        })
                        const body = payload(response)
                        entry.reads.push(body)
                        assert.equal(body.success, true, JSON.stringify(body))
                        if (type === 'text') {
                            assert.equal(body.content, 'readable')
                        }
                        if (type === 'attribute') {
                            assert.equal(body.value, 'readable')
                        }
                    }
                })
            }
        }
        if (mode === 'extension') {
            assert.equal(await evaluate('globalThis.geometryAttaches', workerSession), 0)
        }
        for (const [name, position, targetPosition, clipped] of [
            ['direct', 'static', 'absolute', false],
            ['static-descendant', 'static', 'static', false],
            ['positioned-container', 'relative', 'static', true],
            ['transform-container', 'transform', 'static', true],
        ]) {
            await check(`O-C01-${mode}-${name}`, async (entry) => {
                const ancestor =
                    position === 'transform' ? 'position:static;transform:translate(0,0)' : `position:${position}`
                const markup =
                    `<div style="${ancestor};overflow:hidden;width:50px;height:50px;margin-left:10px">` +
                    (targetPosition === 'absolute'
                        ? '<div id="target" style="position:absolute;left:140px;top:20px;' +
                          'width:40px;height:30px;background:red"></div>'
                        : '<div style="position:absolute;left:140px;top:20px">' +
                          '<div id="target" style="width:40px;height:30px;background:red"></div></div>') +
                    '</div>'
                await evaluate(`window.scrollTo(0,0);document.body.innerHTML=${JSON.stringify(markup)};true`)
                entry.rect = await evaluate(
                    '(()=>{const r=document.querySelector("#target").getBoundingClientRect();' +
                        'return {x:r.x,y:r.y,width:r.width,height:r.height}})()'
                )
                const native = await pipe(
                    'Page.captureScreenshot',
                    {
                        format: 'png',
                        clip: { x: entry.rect.x + 5, y: entry.rect.y + 5, width: 1, height: 1, scale: 1 },
                        captureBeyondViewport: true,
                    },
                    pageSession
                )
                entry.nativePixel = onePixel(native.data)
                const proof = await pipe(
                    'Page.captureScreenshot',
                    {
                        format: 'png',
                        clip: { ...entry.rect, scale: 1 },
                        captureBeyondViewport: true,
                    },
                    pageSession
                )
                fs.writeFileSync(path.join(work, `${name}-${mode}-native.png`), Buffer.from(proof.data, 'base64'))
                assert.deepEqual(entry.nativePixel, clipped ? [255, 255, 255] : [255, 0, 0])
                const response = await client.callTool({
                    name: 'extract',
                    arguments: { type: 'screenshot', target: { css: '#target' }, targetId, timeout: 7000 },
                })
                entry.reply = payload(response)
                if (clipped) {
                    assert.equal(
                        entry.reply.error?.code ?? entry.reply.code,
                        'ELEMENT_NOT_VISIBLE',
                        JSON.stringify(entry.reply)
                    )
                } else {
                    assert.equal(entry.reply.success, true, JSON.stringify(entry.reply))
                    assert.deepEqual(entry.reply.metadata.clip, entry.rect)
                }
            })
        }
    }
} finally {
    await client?.close()
    await server?.close()
    await session.close()
    observer?.close()
    bridge?.httpServer.stop?.()
    for (const callback of pending.values()) {
        clearTimeout(callback.timer)
        callback.reject(new Error('Owned browser closing'))
    }
    pending.clear()
    if (chrome.exitCode === null) {
        const exited = once(chrome, 'exit')
        chrome.kill('SIGTERM')
        const timer = setTimeout(() => chrome.kill('SIGKILL'), 1000)
        await exited
        clearTimeout(timer)
    }
    await new Promise((resolve) => http.close(resolve))
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
}
if (result.failures.length) {
    process.exitCode = 1
}
