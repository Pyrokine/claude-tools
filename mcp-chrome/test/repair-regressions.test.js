import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { getSession, getUnifiedSession } from '../dist/core/index.js';
import { Locator } from '../dist/core/locator.js';
import { AutoWait } from '../dist/core/auto-wait.js';
import { ExtensionHttpServer } from '../dist/extension/http-server.js';
import { registerWaitTool } from '../dist/tools/wait.js';

function patch(object, values) {
    const old = Object.fromEntries(Object.keys(values).map((key) => [key, object[key]]));
    Object.assign(object, values);
    return () => Object.assign(object, old);
}

test('CH-08 full page capture preserves device metrics on success and failure', async () => {
    const session = getSession();
    for (const fail of [false, true]) {
        const calls = [];
        const restore = patch(session, {
            ensureSession() {},
            async send(method, params) {
                calls.push({ method, params });
                if (method === 'Runtime.evaluate') {
                    return { result: { value: '{"width":390,"height":2000,"devicePixelRatio":2}' } };
                }
                if (method === 'Page.captureScreenshot') {
                    if (fail) {
                        throw new Error('capture failed');
                    }
                    return { data: 'aGVsbG8=' };
                }
                return {};
            },
        });
        try {
            if (fail) {
                await assert.rejects(session.screenshot({ fullPage: true, scale: 0.5 }), /capture failed/);
            } else {
                await session.screenshot({ fullPage: true, scale: 0.5 });
            }
            assert.equal(
                calls.some((call) => call.method.startsWith('Emulation.')),
                false
            );
            assert.deepEqual(calls.find((call) => call.method === 'Page.captureScreenshot').params.clip, {
                x: 0,
                y: 0,
                width: 390,
                height: 2000,
                scale: 0.5,
            });
        } finally {
            restore();
        }
    }
});

test('CH-11 materialization preserves sparse length and own special keys within budget', async () => {
    const session = getUnifiedSession();
    const restore = patch(session, {
        extensionBridge: {
            async debuggerSend(method, params) {
                if (method !== 'Runtime.getProperties') {
                    return {};
                }
                return {
                    result:
                        params.objectId === 'array'
                            ? [
                                  { name: '0', value: { type: 'string', value: 'x' }, enumerable: true },
                                  { name: 'length', value: { type: 'number', value: 3 } },
                              ]
                            : [{ name: '__proto__', enumerable: true, value: { type: 'string', value: 'data' } }],
                };
            },
        },
    });
    try {
        const array = await session.materializeCdpResult({ type: 'object', subtype: 'array', objectId: 'array' });
        assert.equal(JSON.stringify(array), '["x",null,null]');
        const object = await session.materializeCdpResult({ type: 'object', objectId: 'object' });
        assert.equal(JSON.stringify(object), '{"__proto__":"data"}');
    } finally {
        restore();
    }
});

test('CH-18 locator and auto wait release handles only after their final consumers', async () => {
    let next = 0;
    const live = new Set();
    const calls = [];
    const cdp = {
        async send(method, params) {
            calls.push(method);
            if (method === 'DOM.resolveNode' || method === 'Runtime.evaluate') {
                const objectId = `object-${++next}`;
                live.add(objectId);
                return method === 'DOM.resolveNode' ? { object: { objectId } } : { result: { objectId } };
            }
            if (params?.objectId) {
                assert.equal(live.has(params.objectId), true, `released before ${method}`);
            }
            if (method === 'Runtime.getProperties') {
                const objectId = `object-${++next}`;
                live.add(objectId);
                return {
                    result: [
                        { name: 'node', value: { objectId, subtype: 'node' } },
                        { name: 'count', value: { value: 1 } },
                    ],
                };
            }
            if (method === 'Runtime.releaseObject') {
                live.delete(params.objectId);
            }
            if (method === 'DOM.getDocument') {
                return { root: { nodeId: 1 } };
            }
            if (method === 'DOM.querySelector' || method === 'DOM.requestNode') {
                return { nodeId: 2 };
            }
            if (method === 'Runtime.callFunctionOn') {
                if (/return\s+\{\s*x,\s*y,\s*width,\s*height/.test(params.functionDeclaration)) {
                    return { result: { value: { x: 0, y: 0, width: 10, height: 10 } } };
                }
                return { result: { value: !params.functionDeclaration.includes('rect.top') } };
            }
            return {};
        },
    };
    await new Locator(cdp, { text: 'target' }, 'session', { timeout: 100 }).find();
    await new Locator(cdp, { css: 'button' }, 'session', { timeout: 100 }).evaluateOn('function() { return true; }');
    await new AutoWait(cdp, 'session', { timeout: 1000 }).waitForEnabled(2);
    await new AutoWait(cdp, 'session', { timeout: 1000 }).waitForStableBoundingBox(2);
    await new AutoWait(cdp, 'session', { timeout: 1000 }).ensureInViewport(2);
    assert.equal(live.size, 0);
    assert.equal(calls.filter((method) => method === 'Runtime.releaseObject').length, next);
});

test('CH-20 clearing buffered network logs preserves pending final-event correlation', async () => {
    const session = getSession();
    const original = session.requestMap;
    session.requestMap = new Map([['inflight', { url: 'https://example.com/' }]]);
    try {
        await session.getNetworkRequests({ clear: true });
        assert.equal(session.requestMap.has('inflight'), true);
        session.clearLogs();
        assert.equal(session.requestMap.has('inflight'), true);
    } finally {
        session.requestMap = original;
    }
});

test('CH-04 public wait callback rejects a pre-cancelled request', async () => {
    let callback;
    registerWaitTool({
        registerTool(_name, _schema, handler) {
            callback = handler;
        },
    });
    const controller = new globalThis.AbortController();
    controller.abort();
    const response = await callback({ for: 'time', ms: 0 }, { signal: controller.signal });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /cancel|abort|取消/i);
});

test('CH-05 sent RPC disconnect preserves unknown status without replay', async () => {
    const server = new ExtensionHttpServer();
    let sends = 0;
    server.clientSocket = {
        readyState: 1,
        send() {
            ++sends;
            globalThis.queueMicrotask(() => server.rejectPendingHandlers('Extension disconnected'));
        },
    };
    await assert.rejects(server.sendCommand('evaluate', {}), (error) => {
        assert.equal(error.context?.actionStatus, 'unknown');
        assert.equal(error.context?.retryable, false);
        return true;
    });
    assert.equal(sends, 1);
});

test('CH-16 native strict websocket requires v2 hello and authenticates commands responses and sequence', async () => {
    const server = new ExtensionHttpServer({ port: 0, autoPort: false });
    server.pairingToken = 'owned-synthetic-token';
    await server.start();
    let ws;
    const hmac = (key, value) => createHmac('sha256', key).update(value).digest('hex');
    try {
        const port = server.getPort();
        const clientNonce = 'c'.repeat(32);
        const health = await (
            await globalThis.fetch(`http://127.0.0.1:${port}/api/health?clientNonce=${clientNonce}`)
        ).json();
        assert.equal(health.auth.protocol, 2);
        assert.equal(
            health.auth.serverProof,
            hmac(
                server.pairingToken,
                JSON.stringify([
                    'mcp-chrome',
                    2,
                    'server-proof',
                    clientNonce,
                    health.auth.serverNonce,
                    health.instanceId,
                    port,
                ])
            )
        );
        const clientProof = hmac(
            server.pairingToken,
            JSON.stringify([
                'mcp-chrome',
                2,
                'client-proof',
                clientNonce,
                health.auth.serverNonce,
                health.instanceId,
                port,
            ])
        );
        ws = new WebSocket(
            `ws://127.0.0.1:${port}/?protocol=2&clientNonce=${clientNonce}` +
                `&serverNonce=${health.auth.serverNonce}&clientProof=${clientProof}`,
            { origin: `chrome-extension://${'a'.repeat(32)}` }
        );
        const ready = await new Promise((resolve, reject) => {
            ws.once('message', (data) => resolve(JSON.parse(String(data))));
            ws.once('error', reject);
        });
        assert.equal(server.isConnected(), false);
        const session = JSON.stringify([clientNonce, health.auth.serverNonce, health.instanceId, port]);
        const receiveKey = hmac(server.pairingToken, JSON.stringify(['mcp-chrome', 2, 'key', 'server', session]));
        const sendKey = hmac(server.pairingToken, JSON.stringify(['mcp-chrome', 2, 'key', 'extension', session]));
        assert.equal(ready.mac, hmac(receiveKey, JSON.stringify([2, session, 'server', ready.seq, ready.payload])));
        const send = (seq, message) => {
            const payload = JSON.stringify(message);
            ws.send(
                JSON.stringify({
                    v: 2,
                    session,
                    seq,
                    payload,
                    mac: hmac(sendKey, JSON.stringify([2, session, 'extension', seq, payload])),
                })
            );
        };
        const connected = new Promise((resolve) => server.once('connected', resolve));
        send(1, { type: 'hello', version: '3.0.1' });
        await connected;
        assert.equal(server.isConnected(), true);
        const command = new Promise((resolve) => ws.once('message', (data) => resolve(JSON.parse(String(data)))));
        const response = server.sendCommand('evaluate', { code: '42' }, 1000);
        const envelope = await command;
        assert.equal(
            envelope.mac,
            hmac(receiveKey, JSON.stringify([2, session, 'server', envelope.seq, envelope.payload]))
        );
        const message = JSON.parse(envelope.payload);
        send(2, { id: message.id, success: true, data: 42 });
        assert.equal(await response, 42);
        const closed = new Promise((resolve) => ws.once('close', resolve));
        send(2, { type: 'pong' });
        await closed;
        assert.equal(server.isConnected(), false);
    } finally {
        ws?.close();
        await server.stop();
    }
});

test('CH-09 independent network idle starts with the current inflight set', async () => {
    const session = getSession();
    const cdp = new EventEmitter();
    cdp.onEvent = cdp.on.bind(cdp);
    cdp.offEvent = cdp.off.bind(cdp);
    const restore = patch(session, { sessionId: 'owned-session', requestMap: new Map([['already-started', {}]]) });
    let completed = false;
    try {
        const wait = session.buildNetworkIdlePromise(cdp, 1000, 5).then(() => {
            completed = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 15));
        assert.equal(completed, false);
        cdp.emit('Network.loadingFinished', { requestId: 'already-started' }, 'other-session');
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(completed, false);
        cdp.emit('Network.loadingFinished', { requestId: 'already-started' }, 'owned-session');
        await wait;
        assert.equal(completed, true);
        assert.equal(cdp.listenerCount('Network.loadingFinished'), 0);
    } finally {
        restore();
    }
});

test('CH-04 cancelled public wait leaves the server queue before its predecessor completes', async () => {
    const session = getUnifiedSession();
    let release;
    let entered = false;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const holding = session.withTabLock(async () => {
        entered = true;
        await gate;
    });
    while (!entered) {
        await Promise.resolve();
    }
    let callback;
    registerWaitTool({
        registerTool(_name, _schema, handler) {
            callback = handler;
        },
    });
    const controller = new globalThis.AbortController();
    const response = callback({ for: 'time', ms: 0 }, { signal: controller.signal });
    controller.abort();
    try {
        assert.equal((await response).isError, true);
        let nextEntered = false;
        const next = session.withTabLock(async () => {
            nextEntered = true;
        });
        await Promise.resolve();
        assert.equal(nextEntered, false);
        release();
        await holding;
        await next;
        assert.equal(nextEntered, true);
    } finally {
        release();
        await holding;
    }
});

test(
    'CH-L01 headless launcher accepts chromium-browser alone and preserves arguments',
    { skip: process.platform !== 'linux' },
    async () => {
        const directory = await mkdtemp(join(tmpdir(), 'chrome-launcher-'));
        const capture = join(directory, 'arguments');
        try {
            await writeFile(join(directory, 'chromium-browser'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\n', {
                mode: 0o700,
            });
            const script = new URL('../scripts/start-chrome-headless.sh', import.meta.url);
            await promisify(execFile)('/bin/bash', [script.pathname, '9444', '--owned-flag'], {
                env: { PATH: directory, CAPTURE: capture, OSTYPE: 'linux-gnu' },
            });
            const args = (await readFile(capture, 'utf8')).split('\n');
            assert.ok(args.includes('--remote-debugging-port=9444'));
            assert.ok(args.includes('--owned-flag'));
            assert.equal(args.includes('9444'), false);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
);
