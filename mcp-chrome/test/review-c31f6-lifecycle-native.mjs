import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CDPClient } from '../dist/cdp/client.js'
import { getSession, getUnifiedSession } from '../dist/core/index.js'
import { registerEvaluateTool } from '../dist/tools/evaluate.js'
import { registerInputTool } from '../dist/tools/input.js'

const chromePath = process.argv[2]
if (!chromePath) {
    throw new Error('Usage: node test/review-c31f6-lifecycle-native.mjs CHROME_PATH OUTPUT_JSON')
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-c31f6-lifecycle-'))
const output = path.resolve(process.argv[3] ?? path.join(work, 'results.json'))
const result = {
    status: 'running',
    work,
    sdkCalls: 0,
    checks: [],
    commands: [],
    replies: [],
    records: [],
    boundary:
        'Actual SDK Client/McpServer tools/call, production queue, scope, Session and WebSocket CDPClient, isolated headless Chrome and localhost DOM. Named ACK/deadline and cleanup-failure probes are explicit; all other cases use real time.',
}
const http = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(
        '<!doctype html><title>Lifecycle regression</title><body><input id="ready" value="ready"><script>globalThis.events=[]; globalThis.held=new Set(); for(const type of ["keydown","keyup"])addEventListener(type,e=>{events.push({type:e.type,key:e.key,trusted:e.isTrusted});if(e.type==="keydown")held.add(e.key);else held.delete(e.key)})</script></body>'
    )
})
await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${http.address().port}/`
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
        '--no-proxy-server',
        '--remote-debugging-port=0',
        `--user-data-dir=${path.join(work, 'profile')}`,
        url,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
)
const log = fs.createWriteStream(path.join(work, 'chrome.log'), { mode: 0o600 })
chrome.stderr.pipe(log)
const unified = getUnifiedSession()
const session = getSession()
let client
let server
let observer
let observerSession
let active
let holdRead = false
let heldReply
let closeRead = false
let deadlineProbe = false
let restoreNow
let commandTransform
let replyIntercept
let restoreProbe
const interceptedReplies = []
const realNow = Date.now.bind(Date)
async function until(predicate, timeout = 5000) {
    const deadline = performance.now() + timeout
    while (!(await predicate())) {
        assert.ok(performance.now() < deadline, 'Native fixture condition did not arrive')
        await delay(2)
    }
}
const read = async (expression, targetSession = observerSession) => {
    result.observerReads = (result.observerReads ?? 0) + 1
    const value = await observer.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        targetSession
    )
    assert.equal(value.exceptionDetails, undefined)
    return value.result.value
}
async function check(name, run) {
    if (process.env.C31F6_LIFECYCLE_FILTER && !new RegExp(process.env.C31F6_LIFECYCLE_FILTER).test(name)) {
        return
    }
    const entry = {
        name,
        clock: name.includes('scope-deadline') ? 'controlled Date at main action ACK' : 'real',
        started: performance.now(),
    }
    const firstRecord = result.records.length
    const firstCommand = result.commands.length
    try {
        await run(entry)
        entry.status = 'PASS'
    } catch (error) {
        entry.status = 'FAIL'
        entry.error = String(error)
        entry.stack = error.stack
    } finally {
        restoreNow?.()
        restoreNow = undefined
        holdRead = false
        closeRead = false
        deadlineProbe = false
        commandTransform = undefined
        replyIntercept = undefined
        restoreProbe?.()
        restoreProbe = undefined
        if (heldReply) {
            active.handleMessage(heldReply)
            heldReply = undefined
        }
        for (const reply of interceptedReplies.splice(0)) {
            active.handleMessage(reply)
        }
        await until(
            () => result.records.slice(firstRecord).every((record) => record.finished) && active.callbacks.size === 0
        ).catch((error) => {
            entry.status = 'FAIL'
            entry.settlementError = String(error)
        })
        entry.elapsedMs = performance.now() - entry.started
        entry.records = result.records.slice(firstRecord)
        entry.commandCount = result.commands.length - firstCommand
        entry.resourceState = {
            keys: [...unified.pressedKeys],
            modifiers: unified.modifiers,
            cdpModifiers: session.modifiers,
            callbacks: active.callbacks.size,
        }
        result.checks.push(entry)
        fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
        for (const key of unified.pressedKeys) {
            await unified.keyUp(key, 1000)
        }
        await read('for(const key of [...held])held.delete(key);events.length=0')
        console.log(name, entry.status, entry.error ?? '')
    }
}
function call(name, args, options) {
    return client.callTool(
        { name, arguments: { targetId: session.currentTargetId, timeout: 5000, ...args } },
        undefined,
        options
    )
}
function payload(response) {
    return JSON.parse(response.content[0].text)
}
function completed(body, status) {
    assert.equal(body.actionExecuted, true, JSON.stringify(body))
    assert.equal(body.actionStatus, 'completed')
    assert.equal(body.retryable, false)
    assert.equal(body.verificationStatus, status, JSON.stringify(body))
    assert.equal(body.postCondition.verificationStatus, status)
    assert.equal(body.postCondition.retryable, status === 'unavailable' || status === 'not_matched')
}
function instrument() {
    active = session.cdp
    const send = active.ws.send.bind(active.ws)
    active.ws.send = (text, ...args) => {
        const command = JSON.parse(text)
        commandTransform?.(command)
        result.commands.push({
            ...command,
            at: performance.now(),
            wall: realNow(),
            requestDeadline: unified.tabLockContext.getStore()?.deadline,
        })
        return send(JSON.stringify(command), ...args)
    }
    const receive = active.handleMessage.bind(active)
    active.handleMessage = (data) => {
        const message = JSON.parse(data.toString())
        if (message.id) {
            result.replies.push(message)
            const command = result.commands.findLast((command) => command.id === message.id)
            if (replyIntercept?.(data, message, command)) {
                return
            }
            const validation =
                command?.method === 'Runtime.callFunctionOn' &&
                command.params?.functionDeclaration?.includes('matched: Boolean')
            if (validation && closeRead) {
                closeRead = false
                active.ws.close()
                return
            }
            if (validation && holdRead) {
                heldReply = data
                return
            }
            if (
                deadlineProbe &&
                (command?.params?.expression?.includes('scopeDeadlineMain') ||
                    (command?.method === 'Input.dispatchKeyEvent' &&
                        command.params.type === deadlineProbe &&
                        command.params.key === 'Shift'))
            ) {
                deadlineProbe = false
                const now = Date.now
                const deadline = unified.tabLockContext.getStore()?.deadline
                // 回执不在请求作用域时，使用派发命令记录的实际期限
                const scopeDeadline = deadline ?? command?.requestDeadline
                assert.equal(typeof scopeDeadline, 'number', 'ACK boundary requires the actual dispatch deadline')
                Date.now = () => scopeDeadline
                restoreNow = () => {
                    Date.now = now
                }
            }
        }
        return receive(data)
    }
}
try {
    let port
    await until(() => {
        try {
            port = Number(fs.readFileSync(path.join(work, 'profile/DevToolsActivePort'), 'utf8').split('\n')[0])
            return port > 0
        } catch {
            return false
        }
    })
    await session.connect({ port, stealth: 'off' })
    unified.activeMode = 'cdp'
    unified.cdpExplicitlySelected = true
    instrument()
    observer = new CDPClient()
    const version = await (await globalThis.fetch(`http://127.0.0.1:${port}/json/version`)).json()
    await observer.connect(version.webSocketDebuggerUrl)
    result.browser = await observer.send('Browser.getVersion')
    observerSession = (
        await observer.send('Target.attachToTarget', { targetId: session.currentTargetId, flatten: true })
    ).sessionId
    await until(async () => await read('document.readyState === "complete"'))
    server = new McpServer({ name: 'c31f6-lifecycle', version: '1.0.0' })
    const register = server.registerTool.bind(server)
    server.registerTool = (name, config, handler) =>
        register(name, config, async (args, extra) => {
            const record = {
                name,
                requestId: extra.requestId,
                started: performance.now(),
                deadline: realNow() + (args.timeout ?? 30000),
                signal: extra.signal,
            }
            extra.signal.addEventListener(
                'abort',
                () => {
                    record.aborted = performance.now()
                },
                { once: true }
            )
            result.records.push(record)
            try {
                const response = await handler(args, extra)
                record.internalReply = payload(response)
                return response
            } finally {
                record.finished = performance.now()
            }
        })
    registerEvaluateTool(server)
    registerInputTool(server)
    client = new Client({ name: 'c31f6-client', version: '1.0.0' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const send = ct.send.bind(ct)
    ct.send = (message, ...args) => {
        if (message.method === 'tools/call') {
            ++result.sdkCalls
        }
        return send(message, ...args)
    }
    result.businessResponses = []
    const serverSend = st.send.bind(st)
    st.send = (message, ...args) => {
        if (message.id !== undefined && !message.method) {
            result.businessResponses.push(message)
        }
        return serverSend(message, ...args)
    }
    await server.connect(st)
    await client.connect(ct)
    for (const operation of ['evaluate', 'input']) {
        const action =
            operation === 'evaluate'
                ? { script: 'globalThis.actionCount=(globalThis.actionCount||0)+1' }
                : {
                      events: [
                          { type: 'keydown', key: 'Shift' },
                          { type: 'keyup', key: 'Shift' },
                      ],
                  }
        for (const [name, condition, status] of [
            ['selector-iframe', { selector: 'iframe[' }, 'error'],
            ['selector-div', { selector: 'div[' }, 'error'],
            [
                'throw-conversion',
                { script: '() => { throw { toString() { throw new Error("frame disconnected") } } }' },
                'error',
            ],
            ...['null', '"frame disconnected"', 'new Error("frame disconnected")'].flatMap((value) => [
                [`throw-${value}`, { script: `() => { throw ${value} }` }, 'error'],
                [`reject-${value}`, { script: `Promise.reject(${value})` }, 'error'],
            ]),
            ['true', { script: 'true' }, 'matched'],
            ['false', { script: 'false' }, 'not_matched'],
            ['AND', { text: 'ready', selector: '#ready', urlIncludes: '/', script: 'true' }, 'matched'],
        ]) {
            await check(`${operation}/${name}`, async (entry) => {
                const body = payload(
                    await call(operation, { ...action, postCondition: { ...condition, timeout: 180, interval: 50 } })
                )
                entry.body = body
                completed(body, status)
            })
        }
    }
    for (const operation of ['evaluate', 'input']) {
        for (const variant of ['terminate', 'timeout', 'page']) {
            const pageError = variant === 'page'
            await check(
                `${operation}/${pageError ? 'page' : 'native'}-execution-${variant === 'timeout' ? 'timeout' : 'terminated'}`,
                async (entry) => {
                    entry.boundary = pageError
                        ? 'Actual page Error with the same text as native execution termination'
                        : variant === 'timeout'
                          ? 'Actual Chrome execution timeout: validation function/args use native Runtime.evaluate timeout=1; the original production local deadline and callback remain'
                          : 'Actual Chrome Runtime.terminateExecution is issued by the independent observer only after the validation console marker proves script execution began'
                    const first = result.commands.length
                    const countBefore = await read('globalThis.actionCount||0')
                    const marker = 'C31F6_NATIVE_TERMINATE_' + operation
                    let termination
                    if (variant === 'terminate') {
                        await observer.send('Runtime.enable', {}, observerSession)
                        const terminate = (params, sessionId) => {
                            if (sessionId === observerSession && params.args?.some((arg) => arg.value === marker)) {
                                entry.terminationRequested = true
                                termination = observer.send('Runtime.terminateExecution', {}, observerSession).then(
                                    () => {
                                        entry.terminationAcknowledged = true
                                    },
                                    (error) => {
                                        entry.terminationError = String(error)
                                    }
                                )
                            }
                        }
                        observer.onEvent('Runtime.consoleAPICalled', terminate)
                        restoreProbe = () => observer.offEvent('Runtime.consoleAPICalled', terminate)
                    }
                    if (variant === 'timeout') {
                        commandTransform = (command) => {
                            if (
                                command.method === 'Runtime.callFunctionOn' &&
                                command.params?.functionDeclaration?.includes('matched: Boolean')
                            ) {
                                const params = command.params
                                command.method = 'Runtime.evaluate'
                                command.params = {
                                    expression: `(${params.functionDeclaration})(${params.arguments.map((arg) => JSON.stringify(arg.value)).join(',')})`,
                                    returnByValue: true,
                                    awaitPromise: true,
                                    timeout: 1,
                                }
                            }
                        }
                    }
                    const action =
                        operation === 'evaluate'
                            ? { script: 'globalThis.actionCount=(globalThis.actionCount||0)+1' }
                            : {
                                  events: [
                                      { type: 'keydown', key: 'a' },
                                      { type: 'keyup', key: 'a' },
                                  ],
                              }
                    entry.body = payload(
                        await call(operation, {
                            ...action,
                            postCondition: {
                                script: pageError
                                    ? '() => {throw new Error("Execution was terminated")}'
                                    : variant === 'terminate'
                                      ? `() => {console.debug(${JSON.stringify(marker)});while(true){}}`
                                      : '() => {while(true){}}',
                                timeout: 2000,
                            },
                        })
                    )
                    if (variant === 'terminate') {
                        await termination
                        assert.equal(entry.terminationRequested, true)
                        assert.equal(entry.terminationAcknowledged, true, entry.terminationError)
                    }
                    const ids = new Set(result.commands.slice(first).map((command) => command.id))
                    entry.nativeErrors = result.replies
                        .filter((reply) => ids.has(reply.id) && reply.error)
                        .map((reply) => reply.error)
                    if (!pageError) {
                        assert.ok(
                            entry.nativeErrors.some((error) =>
                                variant === 'timeout'
                                    ? error.code === -32603 && error.message === 'Internal error'
                                    : error.code === -32000 && error.message === 'Execution was terminated'
                            ),
                            JSON.stringify(entry.nativeErrors)
                        )
                    }
                    completed(entry.body, pageError ? 'error' : 'unavailable')
                    if (operation === 'evaluate') {
                        assert.equal(await read('globalThis.actionCount||0'), countBefore + 1)
                    }
                }
            )
        }
    }
    for (const operation of ['evaluate', 'input']) {
        for (const nativeContext of [false, true]) {
            await check(`${operation}/${nativeContext ? 'context-lost' : 'protocol-parameters'}`, async (entry) => {
                entry.boundary =
                    'Actual Chrome protocol error after explicitly changing the validation command parameters'
                const first = result.commands.length
                commandTransform = (command) => {
                    if (
                        command.method !== 'Runtime.callFunctionOn' ||
                        !command.params?.functionDeclaration?.includes('matched: Boolean')
                    ) {
                        return
                    }
                    if (nativeContext) {
                        delete command.params.objectId
                        command.params.executionContextId = -1
                    } else {
                        command.params.objectId = 17
                    }
                }
                const action =
                    operation === 'evaluate'
                        ? { script: '1' }
                        : {
                              events: [
                                  { type: 'keydown', key: 'a' },
                                  { type: 'keyup', key: 'a' },
                              ],
                          }
                entry.body = payload(
                    await call(operation, { ...action, postCondition: { script: 'true', timeout: 500 } })
                )
                completed(entry.body, nativeContext ? 'unavailable' : 'error')
                const ids = new Set(result.commands.slice(first).map((command) => command.id))
                entry.nativeErrors = result.replies
                    .filter((reply) => ids.has(reply.id) && reply.error)
                    .map((reply) => reply.error)
                assert.equal(entry.nativeErrors.length, 1)
                assert.equal(entry.nativeErrors[0].code, nativeContext ? -32000 : -32602)
            })
        }
    }
    await check('evaluate/page-timeout-text-is-page-failure', async (entry) => {
        const start = result.commands.length
        entry.body = payload(
            await call('evaluate', {
                script: 'globalThis.pageFailureCount=(globalThis.pageFailureCount||0)+1;throw new Error("Request timeout in execution context")',
            })
        )
        assert.equal(entry.body.actionExecuted, true)
        assert.equal(entry.body.actionStatus, 'failed')
        assert.equal(entry.body.retryable, false)
        assert.equal(await read('pageFailureCount'), 1)
        assert.equal(
            result.commands
                .slice(start)
                .filter((command) => command.params?.expression?.includes('globalThis.pageFailureCount=')).length,
            1
        )
    })
    await check('input/normal-cross-request-held-key', async (entry) => {
        entry.first = payload(await call('input', { events: [{ type: 'keydown', key: 'Control' }] }))
        assert.deepEqual([...unified.pressedKeys], ['Control'])
        entry.second = payload(
            await call('input', {
                events: [
                    { type: 'keydown', key: 'Shift' },
                    { type: 'keyup', key: 'Shift' },
                ],
            })
        )
        assert.deepEqual([...unified.pressedKeys], ['Control'])
        entry.dom = await read('({held:[...held],events})')
        assert.deepEqual(entry.dom.held, ['Control'])
        assert.equal(unified.modifiers, 2)
        assert.equal(session.modifiers, 2)
        await call('input', { events: [{ type: 'keyup', key: 'Control' }] })
        assert.deepEqual([...unified.pressedKeys], [])
    })
    await check('input/normal-unmatched-verification-preserves-held-key', async (entry) => {
        entry.body = payload(
            await call('input', {
                events: [{ type: 'keydown', key: 'Shift' }],
                postCondition: { script: 'false', timeout: 180, interval: 50 },
            })
        )
        completed(entry.body, 'not_matched')
        assert.deepEqual([...unified.pressedKeys], ['Shift'])
        assert.deepEqual(await read('[...held]'), ['Shift'])
        await call('input', { events: [{ type: 'keyup', key: 'Shift' }] })
        assert.deepEqual([...unified.pressedKeys], [])
    })
    await check('input/request-deadline-releases-completed-key', async (entry) => {
        entry.body = payload(
            await call('input', {
                events: [{ type: 'keydown', key: 'Shift' }],
                timeout: 180,
                postCondition: { script: 'false', timeout: 4000, interval: 2000 },
            })
        )
        completed(entry.body, 'not_matched')
        assert.deepEqual([...unified.pressedKeys], [])
        assert.deepEqual(await read('[...held]'), [])
        assert.equal(unified.modifiers, 0)
        assert.equal(session.modifiers, 0)
    })
    for (const operation of ['evaluate', 'input']) {
        await check(`${operation}/queue-no-cancellation`, async (entry) => {
            const start = result.commands.length
            const first = call('evaluate', {
                script: 'globalThis.holder=(globalThis.holder||0)+1;new Promise(r=>setTimeout(()=>r(1),900))',
            })
            await until(() =>
                result.commands
                    .slice(start)
                    .some((command) => command.params?.expression?.includes('globalThis.holder='))
            )
            const args =
                operation === 'evaluate'
                    ? { script: 'globalThis.queued=(globalThis.queued||0)+1' }
                    : { events: [{ type: 'keydown', key: 'Shift' }] }
            const body = payload(await call(operation, { ...args, timeout: 250 }))
            entry.body = body
            entry.holder = payload(await first)
            assert.equal(entry.holder.success, true)
            assert.equal(body.actionExecuted, false)
            assert.equal(body.actionStatus, 'failed')
            assert.equal(body.failureStage, 'queue')
            assert.equal(body.retryable, false)
            if (operation === 'input') {
                assert.equal(body.eventsExecuted, 0)
            }
            assert.equal(
                result.commands.slice(start).filter((command) => command.method === 'Input.dispatchKeyEvent').length,
                0
            )
            for (const field of ['actionExecuted', 'actionStatus', 'failureStage', 'retryable']) {
                assert.equal(body[field], body.error.context[field], field)
            }
            assert.equal(await read('globalThis.queued||0'), 0)
            assert.equal(
                result.commands
                    .slice(start)
                    .filter((command) => command.params?.expression?.includes('globalThis.holder=')).length,
                1
            )
        })
    }
    for (const inFlight of [false, true]) {
        for (const existing of [false, true]) {
            await check(
                `input/cancel-${inFlight ? 'read' : 'sleep'}-${existing ? 'existing-key' : 'new-key'}`,
                async (entry) => {
                    if (existing) {
                        await call('input', { events: [{ type: 'keydown', key: 'Control' }] })
                    }
                    const start = result.commands.length
                    holdRead = inFlight
                    const controller = new AbortController()
                    const pending = call(
                        'input',
                        {
                            events: [{ type: 'keydown', key: 'Shift' }],
                            timeout: 5000,
                            postCondition: { script: 'false', timeout: 4000, interval: 2000 },
                        },
                        { signal: controller.signal }
                    ).then(
                        (response) => ({ response }),
                        (error) => ({ cancelled: String(error) })
                    )
                    await until(() =>
                        result.commands
                            .slice(start)
                            .some(
                                (command) =>
                                    command.method === 'Runtime.callFunctionOn' &&
                                    command.params?.functionDeclaration?.includes('matched: Boolean')
                            )
                    )
                    if (inFlight) {
                        await until(() => !!heldReply)
                    } else {
                        await until(() => active.callbacks.size === 0)
                    }
                    const record = result.records.findLast((record) => record.name === 'input')
                    controller.abort(new Error('SDK cancellation probe'))
                    await until(() => record.aborted !== undefined)
                    const followEvaluate = payload(
                        await call('evaluate', {
                            script: 'globalThis.afterCancel=(globalThis.afterCancel||0)+1',
                            timeout: 500,
                        })
                    )
                    const followInput = payload(
                        await call('input', {
                            events: [
                                { type: 'keydown', key: 'a' },
                                { type: 'keyup', key: 'a' },
                            ],
                            timeout: 400,
                        })
                    )
                    await until(() => !!record.finished)
                    entry.handlerCancelMs = record.finished - record.aborted
                    entry.followEvaluate = followEvaluate
                    entry.followInput = followInput
                    entry.clientOutcome = await pending
                    entry.dom = await read('({held:[...held],events})')
                    assert.equal(followEvaluate.success, true)
                    assert.equal(followInput.success, true)
                    assert.ok(entry.handlerCancelMs < 350, JSON.stringify(entry))
                    assert.ok(!unified.pressedKeys.has('Shift'))
                    assert.equal(unified.modifiers, existing ? 2 : 0)
                    assert.ok(
                        entry.dom.events.some(
                            (event) => event.type === 'keyup' && event.key === 'Shift' && event.trusted
                        )
                    )
                    assert.deepEqual(entry.dom.held, existing ? ['Control'] : [])
                    assert.deepEqual([...unified.pressedKeys], existing ? ['Control'] : [])
                    assert.ok(entry.clientOutcome.cancelled, 'SDK cancels the waiting client')
                    assert.ok(
                        !result.businessResponses.some((reply) => reply.id === record.requestId),
                        'SDK suppresses the cancelled business reply'
                    )
                    assert.equal(
                        result.commands
                            .slice(start)
                            .filter(
                                (command) =>
                                    command.method === 'Runtime.callFunctionOn' &&
                                    command.params?.functionDeclaration?.includes('matched: Boolean')
                            ).length,
                        1,
                        'No validation is dispatched after cancellation'
                    )
                }
            )
        }
    }
    for (const operation of ['evaluate', 'input']) {
        await check(`${operation}/dispatched-ACK-withheld-result-unknown`, async (entry) => {
            entry.boundary =
                'Real Chrome executes once; only its successful action ACK is withheld until the real request timeout'
            const start = result.commands.length
            replyIntercept = (data, message, command) => {
                const main =
                    operation === 'evaluate'
                        ? command?.params?.expression?.includes('unknownAckMain')
                        : command?.method === 'Input.dispatchKeyEvent' && command.params.type === 'keyDown'
                if (!main) {
                    return false
                }
                interceptedReplies.push(data)
                entry.nativeAck = message
                return true
            }
            const action =
                operation === 'evaluate'
                    ? { script: 'globalThis.unknownAckMain=(globalThis.unknownAckMain||0)+1' }
                    : { events: [{ type: 'keydown', key: 'Shift' }] }
            entry.body = payload(await call(operation, { ...action, timeout: 250 }))
            assert.equal(entry.body.actionExecuted, 'unknown')
            assert.equal(entry.body.actionStatus, 'unknown')
            assert.equal(entry.body.retryable, false)
            for (const field of ['actionExecuted', 'actionStatus', 'retryable']) {
                assert.equal(entry.body[field], entry.body.error.context[field])
            }
            assert.ok(entry.nativeAck.result)
            const mainCommands = result.commands
                .slice(start)
                .filter((command) =>
                    operation === 'evaluate'
                        ? command.params?.expression?.includes('unknownAckMain')
                        : command.method === 'Input.dispatchKeyEvent' && command.params.type === 'keyDown'
                )
            assert.equal(mainCommands.length, 1)
            if (operation === 'evaluate') {
                assert.equal(await read('unknownAckMain'), 1)
            } else {
                assert.deepEqual(await read('[...held]'), [])
                assert.deepEqual([...unified.pressedKeys], [])
            }
        })
    }
    for (const failure of ['protocol', 'batch-timeout']) {
        await check(`input/cleanup-${failure}`, async (entry) => {
            entry.boundary =
                failure === 'protocol'
                    ? 'Cleanup keyup is explicitly rewritten to an invalid command and Chrome returns a native protocol failure'
                    : 'Real Chrome keyup ACK is explicitly withheld; all keys share the production 1000 ms cleanup deadline'
            const start = result.commands.length
            const keys = failure === 'protocol' ? ['Shift'] : ['Shift', 'Alt', 'Meta']
            const controller = new AbortController()
            const warnings = []
            const warn = console.warn
            console.warn = (...args) => {
                warnings.push(args.map((value) => String(value)).join(' '))
                warn(...args)
            }
            restoreProbe = () => {
                console.warn = warn
            }
            if (failure === 'protocol') {
                commandTransform = (command) => {
                    if (command.method === 'Input.dispatchKeyEvent' && command.params.type === 'keyUp') {
                        command.params.type = 'invalid-cleanup'
                    }
                }
            } else {
                replyIntercept = (data, _message, command) => {
                    if (command?.method !== 'Input.dispatchKeyEvent' || command.params.type !== 'keyUp') {
                        return false
                    }
                    interceptedReplies.push(data)
                    return true
                }
            }
            const pending = call(
                'input',
                {
                    events: keys.map((key) => ({ type: 'keydown', key })),
                    timeout: 5000,
                    postCondition: { script: 'false', timeout: 4000, interval: 2000 },
                },
                { signal: controller.signal }
            ).then(
                (response) => ({ response }),
                (error) => ({ cancelled: String(error) })
            )
            await until(
                () =>
                    result.commands
                        .slice(start)
                        .some((command) => command.params?.functionDeclaration?.includes('matched: Boolean')) &&
                    active.callbacks.size === 0
            )
            const record = result.records.findLast((record) => record.name === 'input')
            controller.abort(new Error('SDK cleanup failure probe'))
            await until(() => record.aborted !== undefined)
            const following = call('evaluate', { script: '1', timeout: 1600 })
            await until(() => record.finished !== undefined, 1800)
            entry.handlerCancelMs = record.finished - record.aborted
            entry.following = payload(await following)
            entry.clientOutcome = await pending
            entry.warnings = warnings
            entry.internalReply = record.internalReply
            entry.dom = await read('({held:[...held],events})')
            assert.equal(entry.following.success, true)
            assert.ok(entry.clientOutcome.cancelled)
            assert.equal(entry.internalReply.actionExecuted, true)
            assert.equal(entry.internalReply.actionStatus, 'completed')
            assert.equal(entry.internalReply.retryable, false)
            assert.deepEqual(
                [...unified.pressedKeys],
                keys,
                'Unacknowledged cleanup retains the last confirmed pressed-key state'
            )
            assert.ok(warnings.length >= keys.length)
            assert.ok(!result.businessResponses.some((reply) => reply.id === record.requestId))
            if (failure === 'batch-timeout') {
                assert.ok(entry.handlerCancelMs >= 900 && entry.handlerCancelMs < 1400, String(entry.handlerCancelMs))
                entry.cleanupCommands = result.commands
                    .slice(start)
                    .filter((command) => command.method === 'Input.dispatchKeyEvent' && command.params.type === 'keyUp')
                assert.ok(entry.cleanupCommands.length >= 1 && entry.cleanupCommands.length <= keys.length)
                assert.equal(
                    new Set(entry.cleanupCommands.map((command) => command.requestDeadline)).size,
                    1,
                    'All keyups share one absolute cleanup deadline'
                )
                for (const command of entry.cleanupCommands) {
                    assert.ok(command.wall < command.requestDeadline, 'Expired cleanup does not start another keyup')
                    assert.ok(
                        command.requestDeadline - command.wall <= 1000,
                        'Cleanup never receives a fresh per-key budget'
                    )
                }
            } else {
                assert.ok(entry.handlerCancelMs < 350)
                assert.deepEqual(entry.dom.held, ['Shift'])
            }
        })
    }
    await check('evaluate/scope-deadline-at-main-ACK', async (entry) => {
        const start = result.commands.length
        deadlineProbe = true
        const body = payload(
            await call('evaluate', {
                script: 'globalThis.scopeDeadlineMain=(globalThis.scopeDeadlineMain||0)+1',
                timeout: 5000,
                postCondition: { script: 'true', timeout: 1000 },
            })
        )
        restoreNow?.()
        restoreNow = undefined
        entry.body = body
        completed(body, 'unavailable')
        assert.equal(
            result.commands
                .slice(start)
                .filter((command) => command.params?.functionDeclaration?.includes('matched: Boolean')).length,
            0
        )
        assert.equal(await read('scopeDeadlineMain'), 1)
    })
    for (const type of ['keyDown', 'keyUp']) {
        await check(`input/scope-deadline-at-${type}-ACK`, async (entry) => {
            const start = result.commands.length
            deadlineProbe = type
            const events = [
                { type: 'keydown', key: 'Shift' },
                ...(type === 'keyUp' ? [{ type: 'keyup', key: 'Shift' }] : []),
            ]
            entry.body = payload(
                await call('input', { events, timeout: 5000, postCondition: { script: 'true', timeout: 1000 } })
            )
            restoreNow?.()
            restoreNow = undefined
            completed(entry.body, 'unavailable')
            assert.equal(entry.body.eventsExecuted, events.length)
            assert.equal(
                result.commands
                    .slice(start)
                    .filter((command) => command.params?.functionDeclaration?.includes('matched: Boolean')).length,
                0
            )
            assert.deepEqual([...unified.pressedKeys], [])
            assert.deepEqual(await read('[...held]'), [])
        })
    }
    for (const framed of [false, true]) {
        for (const ending of ['deadline', 'cancel']) {
            await check(`input/matched-ACK-then-pageContext-${ending}-${framed ? 'frame' : 'main'}`, async (entry) => {
                entry.boundary =
                    'Actual SDK and two isolated owned Chrome pages; only the metadata response after matched verification and target restoration is withheld'
                const defaultTarget = session.currentTargetId
                const targetId = (await observer.send('Target.createTarget', { url, background: true })).targetId
                const targetSession = (await observer.send('Target.attachToTarget', { targetId, flatten: true }))
                    .sessionId
                await until(async () => await read('document.readyState === "complete"', targetSession))
                if (framed) {
                    await read(
                        `new Promise(resolve => { const frame = document.createElement('iframe'); frame.id='late-frame'; frame.src=${JSON.stringify(url)}; frame.onload=() => { frame.contentDocument.querySelector('input').focus(); resolve(true) }; document.body.append(frame) })`,
                        targetSession
                    )
                }
                const start = result.commands.length
                let matched = false
                let metadataHeld = false
                const controller = new AbortController()
                replyIntercept = (data, message, command) => {
                    if (
                        command?.method === 'Runtime.callFunctionOn' &&
                        command.params?.functionDeclaration?.includes('matched: Boolean') &&
                        message.result?.result?.value?.matched
                    ) {
                        matched = true
                        entry.matchedAckAt = performance.now()
                    }
                    if (
                        matched &&
                        command?.method === 'Target.getTargetInfo' &&
                        command.params?.targetId === targetId
                    ) {
                        metadataHeld = true
                        entry.metadataHeldAt = performance.now()
                        entry.metadataCommand = command
                        interceptedReplies.push(data)
                        replyIntercept = undefined
                        return true
                    }
                    return false
                }
                try {
                    const pending = call(
                        'input',
                        {
                            targetId,
                            events: [{ type: 'keydown', key: 'Shift' }],
                            timeout: ending === 'deadline' ? 250 : 5000,
                            frame: framed ? '#late-frame' : undefined,
                            postCondition: { script: 'true', timeout: 4000 },
                        },
                        { signal: controller.signal }
                    ).then(
                        (response) => ({ response }),
                        (error) => ({ cancelled: String(error) })
                    )
                    await until(() => metadataHeld)
                    assert.equal(
                        session.currentTargetId,
                        defaultTarget,
                        'Metadata is withheld only after the original target restoration'
                    )
                    const record = result.records.findLast((record) => record.name === 'input')
                    if (ending === 'cancel') {
                        controller.abort(new Error('SDK cancellation after matched ACK'))
                        await until(() => record.aborted !== undefined)
                    }
                    entry.clientOutcome = await pending
                    await until(() => record.finished !== undefined)
                    entry.afterMetadataMs = record.finished - entry.metadataHeldAt
                    if (ending === 'deadline') {
                        entry.body = payload(entry.clientOutcome.response)
                        completed(entry.body, 'matched')
                        assert.equal(typeof entry.body.pageContext.contextError, 'string')
                    } else {
                        assert.ok(entry.clientOutcome.cancelled)
                        assert.ok(!result.businessResponses.some((reply) => reply.id === record.requestId))
                    }
                    const keys = result.commands
                        .slice(start)
                        .filter(
                            (command) => command.method === 'Input.dispatchKeyEvent' && command.params.key === 'Shift'
                        )
                    assert.deepEqual(
                        keys.map((command) => command.params.type),
                        ['keyDown', 'keyUp']
                    )
                    assert.equal(
                        keys[0].sessionId,
                        keys[1].sessionId,
                        'Late cleanup uses the same original native input session'
                    )
                    assert.ok(keys[1].at > entry.metadataHeldAt)
                    assert.equal(session.currentTargetId, defaultTarget)
                    assert.deepEqual([...unified.pressedKeys], [])
                    assert.equal(unified.modifiers, 0)
                    assert.equal(session.getCurrentFrameId(), 0, 'Late release keeps the restored frame selection')
                    entry.inputPage = await read(
                        framed
                            ? '(() => { const frame = document.querySelector("#late-frame").contentWindow; return {held:[...frame.held],events:frame.events} })()'
                            : '({held:[...held],events})',
                        targetSession
                    )
                    if (framed) {
                        assert.deepEqual(
                            await read('events.filter(event => event.key === "Shift")', targetSession),
                            [],
                            'Frame key release does not dispatch to its parent document'
                        )
                        assert.ok(
                            result.commands
                                .slice(start)
                                .some((command) => command.method === 'Runtime.evaluate' && command.params?.contextId),
                            'The registered input uses the real frame execution context'
                        )
                    }
                    assert.deepEqual(entry.inputPage.held, [])
                    assert.ok(
                        entry.inputPage.events.some(
                            (event) => event.type === 'keyup' && event.key === 'Shift' && event.trusted
                        )
                    )
                    assert.deepEqual(
                        await read('events.filter(event => event.key === "Shift")'),
                        [],
                        'Cleanup does not dispatch to the restored default page'
                    )
                    entry.followEvaluate = payload(await call('evaluate', { script: '1', timeout: 500 }))
                    entry.followInput = payload(
                        await call('input', {
                            events: [
                                { type: 'keydown', key: 'a' },
                                { type: 'keyup', key: 'a' },
                            ],
                            timeout: 400,
                        })
                    )
                    assert.equal(entry.followEvaluate.success, true)
                    assert.equal(entry.followInput.success, true)
                } finally {
                    replyIntercept = undefined
                    for (const reply of interceptedReplies.splice(0)) {
                        active.handleMessage(reply)
                    }
                    await observer.send('Target.closeTarget', { targetId })
                }
            })
        }
    }
    await check('evaluate/transport-close-during-validation', async (entry) => {
        closeRead = true
        entry.body = payload(await call('evaluate', { script: '1', postCondition: { script: 'false', timeout: 500 } }))
        completed(entry.body, 'unavailable')
        assert.ok(!active.isConnected)
    })
    result.status = result.checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL'
} catch (error) {
    result.status = 'FAIL'
    result.error = String(error)
    result.stack = error.stack
} finally {
    restoreNow?.()
    await client?.close()
    await server?.close()
    observer?.close()
    await session.close()
    const exited = once(chrome, 'exit')
    chrome.kill('SIGTERM')
    await exited
    http.closeAllConnections()
    await new Promise((resolve) => http.close(resolve))
    result.resources = {
        chromeExited: chrome.exitCode !== null || chrome.signalCode !== null,
        observerCallbacks: observer?.callbacks.size,
        serverCallbacks: active?.callbacks.size,
    }
    fs.writeFileSync(
        output,
        JSON.stringify(result, (key, value) => (key === 'signal' ? { aborted: value.aborted } : value), 2) + '\n'
    )
}
console.log(
    JSON.stringify({
        status: result.status,
        sdkCalls: result.sdkCalls,
        passed: result.checks.filter((check) => check.status === 'PASS').length,
        failed: result.checks.filter((check) => check.status === 'FAIL').length,
        output,
        error: result.error,
    })
)
if (result.status !== 'PASS') {
    process.exitCode = 1
}
