import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CDPClient } from '../dist/cdp/client.js'
import { getSession, getUnifiedSession } from '../dist/core/index.js'
import { registerCookiesTool } from '../dist/tools/cookies.js'

const chromePath = process.argv[2]
if (!chromePath) {
    throw new Error('Usage: node test/review-c31f3-cookie-native.mjs CHROME_PATH [OUTPUT_JSON]')
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-c31f3-cookie-'))
const output = process.argv[3] ? path.resolve(process.argv[3]) : path.join(work, 'results.json')
const result = {
    status: 'running',
    work,
    checks: [],
    sdkCalls: 0,
    commands: [],
    commandReplies: [],
    events: [],
    boundary:
        'Actual SDK Client/McpServer and production requestContext/queue/driver/CDPClient, isolated native Chrome CookieStore and Target sessions; pipe adapter holds selected real ACKs; the named cleanup-failure case injects one detach protocol rejection without sending that detach',
}
const chrome = spawn(
    chromePath,
    [
        '--headless=new',
        '--no-sandbox',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-pipe',
        `--user-data-dir=${path.join(work, 'profile')}`,
        'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] }
)
const log = fs.createWriteStream(path.join(work, 'chrome.log'), { mode: 0o600 })
chrome.stderr.pipe(log)
const observers = new Map()
let nextObserver = 1000000
let buffer = ''
let nativeClient
let current
let contextId
let pageA
let pageB
const state = {
    serverRecord: null,
    holdAttachAt: 0,
    holdDeleteAt: 0,
    attaches: 0,
    deletes: 0,
    heldId: null,
    held: null,
    rejectAttach: false,
    closeAfterAttach: false,
    rejectDetach: false,
}
const write = (message) => chrome.stdio[3].write(JSON.stringify(message) + '\0')
function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
        const id = ++nextObserver
        const timer = setTimeout(() => {
            observers.delete(id)
            reject(new Error(`Native observer timed out: ${method}`))
        }, 10000)
        observers.set(id, { resolve, reject, timer })
        write({ id, method, params, ...(sessionId ? { sessionId } : {}) })
    })
}
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
        if (message.id !== undefined && message.id < 1000000) {
            result.commandReplies.push(message)
        }
        const observer = observers.get(message.id)
        if (observer) {
            clearTimeout(observer.timer)
            observers.delete(message.id)
            if (message.error) {
                observer.reject(new Error(JSON.stringify(message.error)))
            } else {
                observer.resolve(message.result)
            }
        } else if (message.id !== undefined && message.id === state.heldId) {
            state.held = message
        } else {
            if (message.method === 'Target.attachedToTarget' || message.method === 'Target.detachedFromTarget') {
                result.events.push(message)
            }
            nativeClient?.handleMessage(Buffer.from(raw))
        }
    }
})
async function until(predicate) {
    const deadline = Date.now() + 5000
    while (!predicate()) {
        assert.ok(Date.now() < deadline, 'Native protocol condition did not arrive')
        await delay(2)
    }
}
const alive = async (sid) =>
    (await send('Runtime.evaluate', { expression: '6 * 7', returnByValue: true }, sid)).result.value
const seed = () =>
    send('Storage.setCookies', {
        browserContextId: contextId,
        cookies: [0, 1, 2].map((index) => ({
            name: `mcp_c31f3_synthetic_${index}`,
            value: 'synthetic',
            domain: 'example.com',
            path: '/',
        })),
    })
const cookies = () => send('Storage.getCookies', { browserContextId: contextId })
const newB = async () => {
    pageB = (await send('Target.createTarget', { browserContextId: contextId, url: 'about:blank' })).targetId
}
async function closeB() {
    const ack = await send('Target.closeTarget', { targetId: pageB })
    assert.equal(ack.success, true)
    const deadline = Date.now() + 5000
    while ((await send('Target.getTargets')).targetInfos.some((target) => target.targetId === pageB)) {
        assert.ok(Date.now() < deadline, 'Closed native target still exists')
        await delay(2)
    }
}
function afterClose(command) {
    void closeB()
        .then(() => write(command))
        .catch((error) => {
            result.fixtureError = String(error)
            nativeClient.handleMessage(
                Buffer.from(JSON.stringify({ id: command.id, error: { code: -32000, message: String(error) } }))
            )
        })
}
let client
let server
let restore
let sessionA
try {
    result.browser = await send('Browser.getVersion')
    contextId = (await send('Target.createBrowserContext')).browserContextId
    pageA = (await send('Target.createTarget', { browserContextId: contextId, url: 'about:blank' })).targetId
    await newB()
    sessionA = (await send('Target.attachToTarget', { targetId: pageA, flatten: true })).sessionId
    const unified = getUnifiedSession()
    const session = getSession()
    nativeClient = new CDPClient(() => session.requestContext?.())
    nativeClient.ws = {
        readyState: 1,
        close() {},
        send(text) {
            const command = JSON.parse(text)
            result.commands.push({ ...command, aborted: state.serverRecord?.signal.aborted === true })
            if (command.method === 'Target.attachToTarget') {
                ++state.attaches
                if (state.attaches === state.holdAttachAt) {
                    state.heldId = command.id
                }
                if (state.rejectAttach) {
                    afterClose(command)
                    return
                }
            } else if (command.method === 'Network.deleteCookies') {
                ++state.deletes
                if (state.closeAfterAttach) {
                    state.closeAfterAttach = false
                    afterClose(command)
                    return
                }
                if (state.deletes === state.holdDeleteAt) {
                    state.heldId = command.id
                }
            } else if (command.method === 'Target.detachFromTarget' && state.rejectDetach) {
                globalThis.queueMicrotask(() =>
                    nativeClient.handleMessage(
                        Buffer.from(
                            JSON.stringify({
                                id: command.id,
                                error: { code: -32000, message: 'Controlled detach failure' },
                            })
                        )
                    )
                )
                return
            }
            write(command)
        },
    }
    const snapshots = [
        [
            session,
            {
                cdp: nativeClient,
                sessionId: sessionA,
                currentTargetId: pageA,
                targetSessions: new Map([[pageA, sessionA]]),
                state: { url: 'about:blank' },
                listenersInstalled: false,
            },
        ],
        [unified, { extensionBridge: null, activeMode: 'cdp', cdpExplicitlySelected: true }],
    ].map(([object, values]) => {
        const saved = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(object, key)]))
        Object.assign(object, values)
        return () => {
            for (const [key, descriptor] of saved) {
                if (descriptor) {
                    Object.defineProperty(object, key, descriptor)
                } else {
                    Reflect.deleteProperty(object, key)
                }
            }
        }
    })
    restore = () => snapshots.reverse().forEach((undo) => undo())
    session.setupEventListeners()
    server = new McpServer({ name: 'native-owned-cookie-regression', version: '1.0.0' })
    const register = server.registerTool.bind(server)
    server.registerTool = (name, config, handler) =>
        register(name, config, async (args, extra) => {
            let done
            const record = {
                signal: extra.signal,
                id: extra.requestId,
                done: new Promise((resolve) => {
                    done = resolve
                }),
            }
            state.serverRecord = record
            try {
                record.result = await handler(args, extra)
                return record.result
            } finally {
                done()
            }
        })
    registerCookiesTool(server)
    client = new Client({ name: 'native-cookie-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const replies = []
    const transportSend = serverTransport.send.bind(serverTransport)
    serverTransport.send = (message, ...args) => {
        replies.push(message)
        return transportSend(message, ...args)
    }
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    for (const spec of [
        { name: 'normal-existing', target: 'a' },
        { name: 'normal-temporary' },
        { name: 'first-attach-cancel-1', attach: 1 },
        { name: 'first-attach-cancel-2', attach: 1 },
        { name: 'first-attach-cancel-3', attach: 1 },
        { name: 'middle-attach-cancel', attach: 2 },
        { name: 'delete-ack-cancel', delete: 1 },
        { name: 'native-attach-rejection', rejectAttach: true },
        { name: 'native-close-after-successful-attach', closeAfterAttach: true },
        { name: 'late-cleanup-failure', attach: 1, rejectDetach: true },
    ]) {
        result.current = spec
        await seed()
        Object.assign(state, {
            serverRecord: null,
            holdAttachAt: spec.attach ?? 0,
            holdDeleteAt: spec.delete ?? 0,
            attaches: 0,
            deletes: 0,
            heldId: null,
            held: null,
            rejectAttach: spec.rejectAttach === true,
            closeAfterAttach: spec.closeAfterAttach === true,
            rejectDetach: spec.rejectDetach === true,
        })
        const firstCommand = result.commands.length
        const controller = new AbortController()
        ++result.sdkCalls
        const request = client.callTool(
            {
                name: 'cookies',
                arguments: {
                    action: 'clear',
                    domain: 'example.com',
                    targetId: spec.target === 'a' ? pageA : pageB,
                    browserContextId: contextId,
                },
            },
            undefined,
            { signal: controller.signal }
        )
        request.catch(() => {})
        if (spec.attach || spec.delete) {
            const rejected = assert.rejects(request)
            await until(() => state.held)
            controller.abort('stop owned native Cookie clear')
            await until(() => state.serverRecord?.signal.aborted)
            await state.serverRecord.done
            const held = state.held
            state.heldId = null
            state.held = null
            const sid =
                held.result.sessionId ??
                result.commands.slice(firstCommand).findLast((entry) => entry.method === 'Network.deleteCookies')
                    ?.sessionId
            if (spec.attach) {
                assert.equal(await alive(sid), 42)
            }
            nativeClient.handleMessage(Buffer.from(JSON.stringify(held)))
            await rejected
            if (spec.rejectDetach) {
                await until(() => [...nativeClient.callbacks.values()].some((entry) => entry.cleanup?.error))
                const owner = [...nativeClient.callbacks.values()].find((entry) => entry.cleanup?.error)
                assert.equal(owner.cleanup.result.sessionId, sid)
                assert.equal(await alive(sid), 42)
                current = { spec, cleanupUnknown: true, retainedSessionId: sid, nativeValue: 42 }
                state.rejectDetach = false
                await send('Target.detachFromTarget', { sessionId: sid })
            } else {
                await until(() => nativeClient.callbacks.size === 0)
                await assert.rejects(alive(sid), /[Ss]ession/)
                current = { spec, reclaimedSessionId: sid, cleanupUnknown: false }
            }
            const progress = JSON.parse(state.serverRecord.result.content[0].text).error.context
            assert.equal(progress.count, spec.attach ? spec.attach - 1 : 0)
            assert.equal(progress.acknowledged, spec.attach ? spec.attach - 1 : 0)
            assert.equal(replies.filter((entry) => entry.id === state.serverRecord.id).length, 0)
            current.progress = progress
        } else {
            const response = await request
            assert.equal(response.isError === true, Boolean(spec.rejectAttach || spec.closeAfterAttach))
            assert.equal(state.deletes, spec.rejectAttach ? 0 : spec.closeAfterAttach ? 1 : 3)
            assert.equal(nativeClient.callbacks.size, 0)
            const attach = result.commands
                .slice(firstCommand)
                .find((command) => command.method === 'Target.attachToTarget')
            const attachReply = attach ? result.commandReplies.find((reply) => reply.id === attach.id) : undefined
            if (spec.rejectAttach) {
                assert.ok(attachReply?.error, 'The native rejection must come from attach')
                assert.match(attachReply.error.message, /target|closed/i)
            }
            if (spec.closeAfterAttach) {
                assert.ok(attachReply?.result?.sessionId, 'Attach succeeded before closing the target')
            }
            current = { spec, result: JSON.parse(response.content[0].text), attachReply }
        }
        assert.equal(await alive(sessionA), 42)
        assert.equal(session.targetSessions.get(pageA), sessionA)
        assert.equal(session.targetSessions.has(pageB), false)
        const commands = result.commands.slice(firstCommand)
        assert.equal(commands.filter((entry) => entry.method === 'Network.deleteCookies' && entry.aborted).length, 0)
        const remaining = (await cookies()).cookies.length
        assert.equal(
            remaining,
            spec.rejectAttach || spec.closeAfterAttach ? 3 : spec.attach ? 4 - spec.attach : spec.delete ? 2 : 0
        )
        assert.equal(result.fixtureError, undefined)
        if (!spec.rejectAttach && !spec.closeAfterAttach) {
            assert.equal((await send('Target.getTargetInfo', { targetId: pageB })).targetInfo.attached, false)
        }
        result.checks.push({
            ...current,
            deleteDispatches: state.deletes,
            remainingCookies: remaining,
            pageA,
            pageB,
            existingSessionId: sessionA,
            existingValue: 42,
            commands,
        })
        if (spec.rejectAttach || spec.closeAfterAttach) {
            await newB()
        }
    }
    assert.equal(result.checks.length, 10)
    assert.equal(result.sdkCalls, 10)
    delete result.current
    result.status = 'PASS'
} catch (error) {
    result.status = 'FAIL'
    result.error = { message: error.message, stack: error.stack }
    process.exitCode = 1
} finally {
    await client?.close()
    await server?.close()
    nativeClient?.close()
    restore?.()
    if (contextId) {
        try {
            await send('Target.disposeBrowserContext', { browserContextId: contextId })
        } catch (error) {
            result.cleanupError = String(error)
        }
    }
    for (const pending of observers.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('Native fixture stopped'))
    }
    observers.clear()
    chrome.kill('SIGTERM')
    await Promise.race([once(chrome, 'exit').catch(() => {}), delay(3000)])
    log.end()
    result.completedChecks = result.checks.length
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
    console.log(
        JSON.stringify(
            {
                status: result.status,
                sdkCalls: result.sdkCalls,
                completedChecks: result.checks.length,
                output,
                current: result.current,
                error: result.error,
            },
            null,
            2
        )
    )
}
