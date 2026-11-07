import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const root = process.env.MCP_EVENT_DIST ?? path.resolve(import.meta.dirname, '../dist');
const { BrowserEventController } = await import(pathToFileURL(path.join(root, 'core/browser-events.js')));
const { browserEventCommandSchema } = await import(pathToFileURL(path.join(root, 'core/browser-event-schema.js')));
const { CDPClient } = await import(pathToFileURL(path.join(root, 'cdp/client.js')));
const { CDPError, getErrorSource, setErrorSource } = await import(pathToFileURL(path.join(root, 'core/errors.js')));
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture(send = async () => ({}), identity = {}) {
    const calls = [];
    const controller = new BrowserEventController(
        {
            backend: 'cdp',
            targetId: 'page',
            owner: 'owner',
            generation: 'generation',
            nativeSessionId: 'session',
            ...identity,
        },
        async (...args) => {
            calls.push(args);
            return send(...args);
        }
    );
    return { controller, calls };
}
const read = (controller, type, view, ref, clear) => controller.command('read', { type, view, ref, clear });
const begin = (controller, id = 'r', extra = {}) =>
    controller.handle(
        'Network.requestWillBeSent',
        {
            requestId: id,
            request: { url: 'https://example.com/original', method: 'POST', headers: { Authorization: 'private' } },
            type: 'Fetch',
            ...extra,
        },
        'session'
    );
const paused = (controller, id = 'f', extra = {}) =>
    controller.handle(
        'Fetch.requestPaused',
        { requestId: id, request: { url: 'https://example.com/api', method: 'POST' }, frameId: 'frame', ...extra },
        'session'
    );

for (const backend of ['cdp', 'extension']) {
    for (const variant of ['paused', 'auth', 'raw-auth', 'summary', 'details', 'stream']) {
        test(`network URL filters preserve ${backend} ${variant} selection, limits and clearing`, async (t) => {
            const { controller, calls } = fixture(undefined, { backend });
            t.after(() => controller.dispose('test finished'));
            const view = variant === 'raw-auth' ? 'auth' : variant;
            if (variant === 'paused') {
                await controller.command('route', { op: 'add', urlPattern: '*' });
            } else if (variant === 'raw-auth') {
                await controller.rawFetch('Fetch.enable', { handleAuthRequests: true });
            } else if (variant === 'stream') {
                await controller.command('networkCapture', { op: 'start', include: ['stream'] });
            }
            for (const [index, part] of ['keep/first', 'other/item', 'keep/last'].entries()) {
                const url = `https://example.com/${part}?token=owned-filter-secret`;
                if (view === 'paused') {
                    paused(controller, `filter-${index}`, { request: { url, method: 'GET' } });
                } else if (view === 'auth') {
                    controller.handle(
                        'Fetch.authRequired',
                        {
                            requestId: `filter-${index}`,
                            request: { url, method: 'GET' },
                            authChallenge: { source: 'Server', origin: 'https://example.com', realm: 'owned' },
                        },
                        'session'
                    );
                } else if (view === 'stream') {
                    controller.handle('Network.webSocketCreated', { requestId: `filter-${index}`, url }, 'session');
                } else {
                    begin(controller, `filter-${index}`, { request: { url, method: 'GET' } });
                }
            }
            await flush();
            const readsStart = calls.length;
            const options = { type: 'network', view, urlPattern: '*example.com/keep/*' };
            const selected = await controller.command('read', { ...options, limit: 1 });
            assert.equal(selected.totalBuffered, 2);
            assert.equal(selected.count, 1);
            assert.ok(JSON.stringify(selected.logs).includes('/keep/last'));
            assert.ok(!JSON.stringify(selected.logs).includes('owned-filter-secret'));
            const ref = selected.logs[0].ref;
            assert.equal((await controller.command('read', { ...options, ref })).count, 1);
            assert.equal((await controller.command('read', { ...options, ref, urlPattern: '*other*' })).count, 0);
            const cleared = await controller.command('read', { ...options, clear: true });
            assert.equal(cleared.count, 2);
            const pending = variant === 'paused' || variant === 'raw-auth';
            assert.equal((await read(controller, 'network', view)).count, pending ? 3 : 1);
            assert.equal(calls.length, readsStart);
            if (pending) {
                await controller.abortPending('test finished');
                await controller.command('read', { ...options, clear: true });
                assert.equal((await read(controller, 'network', view)).count, 1);
            }
        });
    }
}

for (const state of ['expired', 'cancelled', 'active']) {
    test(`CDP native events isolate ${state} connection requests from later commands`, async (t) => {
        const storage = new AsyncLocalStorage();
        const connectionAbort = new AbortController();
        const action = { kind: 'evaluate', phase: 'action', dispatched: false };
        const connection = {
            deadline: Date.now() + (state === 'expired' ? -1 : 10000),
            signal: connectionAbort.signal,
            userAction: action,
        };
        if (state === 'cancelled') {
            connectionAbort.abort();
        }
        const client = new CDPClient(() => storage.getStore());
        const sent = [];
        client.ws = {
            readyState: 1,
            send(text) {
                const message = JSON.parse(text);
                sent.push(message);
                globalThis.queueMicrotask(() =>
                    client.handleMessage(Buffer.from(JSON.stringify({ id: message.id, result: {} })))
                );
            },
            close() {},
        };
        const { controller } = fixture((method, params, sessionId) => client.send(method, params, sessionId));
        t.after(async () => {
            await controller.dispose('test finished');
            client.close();
        });
        await controller.command('httpAuth', {
            op: 'set',
            scope: { source: 'Server', origin: 'https://example.com', realm: 'owned' },
            username: 'synthetic-user',
            password: 'synthetic-password',
        });
        sent.length = 0;
        for (const method of ['Fetch.requestPaused', 'Fetch.authRequired']) {
            client.onEvent(method, (params, sessionId) => controller.handle(method, params, sessionId));
        }
        const asynchronous = [];
        client.onEvent('Target.attachedToTarget', () => {
            asynchronous.push(
                (async () => {
                    await flush();
                    await client.send('Runtime.enable', {}, 'child');
                    await client.send('Runtime.evaluate', { expression: '1' }, 'child', 1000, false, 'evaluate');
                })()
            );
        });
        client.on('Target.attachedToTarget', () => asynchronous.push(client.send('DOM.enable', {}, 'child')));
        storage.run(connection, () => {
            for (const [method, params] of [
                ['Fetch.requestPaused', { requestId: 'owned-request', request: { url: 'https://example.com/owned' } }],
                [
                    'Fetch.authRequired',
                    {
                        requestId: 'owned-auth',
                        request: { url: 'https://example.com/auth' },
                        authChallenge: { source: 'Server', origin: 'https://example.com', realm: 'owned' },
                    },
                ],
                ['Target.attachedToTarget', { sessionId: 'child' }],
            ]) {
                client.handleMessage(Buffer.from(JSON.stringify({ method, params, sessionId: 'session' })));
            }
        });
        const outcomes = await Promise.allSettled(asynchronous);
        await flush();
        assert.deepEqual(controller.status().cleanupFailures, []);
        assert.ok(
            outcomes.every((item) => item.status === 'fulfilled'),
            JSON.stringify(outcomes)
        );
        assert.deepEqual(
            sent.map((item) => item.method).sort(),
            [
                'DOM.enable',
                'Fetch.continueRequest',
                'Fetch.continueWithAuth',
                'Runtime.enable',
                'Runtime.evaluate',
            ].sort()
        );
        assert.equal(
            sent.find((item) => item.method === 'Fetch.continueWithAuth').params.authChallengeResponse.response,
            'ProvideCredentials'
        );
        assert.equal(action.dispatched, false);
        assert.equal(connection.budgetError, undefined);
        const expired = { deadline: Date.now() - 1 };
        const cancelled = new AbortController();
        cancelled.abort();
        const before = sent.length;
        for (const scope of [expired, { signal: cancelled.signal }]) {
            await storage.run(scope, () =>
                assert.rejects(
                    client.send('Runtime.evaluate', { expression: '2' }),
                    (error) => error.context.actionExecuted === false && error.context.actionStatus === 'not_started'
                )
            );
        }
        assert.equal(sent.length, before);
        await storage.run({ deadline: Date.now() + 1000, userAction: action }, () =>
            client.send('Runtime.evaluate', { expression: '3' }, 'session', 1000, false, 'evaluate')
        );
        assert.equal(sent.length, before + 1);
        assert.equal(action.dispatched, true);
    });
}

test('dialog observations interrupt blocked native operations and remain independently handleable', async () => {
    const { controller, calls } = fixture();
    const pending = controller.race(new Promise(() => {}));
    controller.handle(
        'Page.javascriptDialogOpening',
        { type: 'prompt', message: 'Synthetic prompt', defaultPrompt: 'value' },
        'session'
    );
    await assert.rejects(
        pending,
        (error) => error.code === 'DIALOG_OPEN' && error.context.actionExecuted === 'unknown'
    );
    const { logs } = await read(controller, 'dialog');
    assert.equal(logs.length, 1);
    await controller.command('dialog', { op: 'accept', ref: logs[0].ref, text: 'answer' });
    assert.deepEqual(calls.at(-1), ['Page.handleJavaScriptDialog', { accept: true, promptText: 'answer' }, 'session']);
    await assert.rejects(controller.command('dialog', { op: 'accept', ref: logs[0].ref }), /no longer pending/);
});

test('I034 cleanup failures retain bounded event time, ref and session ownership', async () => {
    const { controller } = fixture(async (method) => {
        if (method === 'Fetch.failRequest') {
            throw new Error('Synthetic cleanup failure');
        }
        return {};
    });
    await controller.command('route', { op: 'add', urlPattern: '*', stage: 'Request' });
    const start = Date.now();
    for (let index = 0; index < 23; ++index) {
        paused(controller, `owned-${index}`);
        await flush();
        await controller.abortPending('owned stop');
    }
    const result = await read(controller, 'network', 'paused');
    assert.equal(result.cleanupFailures.length, 20);
    assert.equal(result.cleanupFailureDetails.length, 20);
    for (const [index, detail] of result.cleanupFailureDetails.entries()) {
        assert.equal(result.cleanupFailures[index], detail.error);
        assert.equal(detail.error, 'Synthetic cleanup failure');
        assert.ok(detail.timestamp >= start && detail.timestamp <= Date.now());
        assert.equal(detail.phase, 'abortPending:owned stop');
        assert.equal(detail.requestId, `owned-${index + 3}`);
        assert.equal(detail.targetId, 'page');
        assert.equal(detail.owner, 'owner');
        assert.equal(detail.sessionGeneration, 'generation');
        assert.equal(detail.nativeSessionId, 'session');
        assert.ok(result.logs.some((entry) => entry.ref === detail.ref));
    }
    const fresh = fixture().controller;
    const watched = await fresh.command('download', { op: 'watch' });
    assert.deepEqual(watched.cleanupFailures, []);
    assert.deepEqual(watched.cleanupFailureDetails, []);
    await fresh.dispose('completed');
});

test('refs bind owner, target, connection generation and cache lifetime', async () => {
    const a = fixture().controller;
    const b = fixture(async () => ({}), { owner: 'other' }).controller;
    begin(a);
    const ref = (await read(a, 'network')).logs[0].ref;
    await assert.rejects(read(b, 'network', 'details', ref), /another owner/);
    await a.dispose('disconnect');
    await assert.rejects(read(a, 'network', 'details', ref), /closed/);
});

test('redirect ExtraInfo waits for hop flags and does not overwrite another hop', async () => {
    const { controller } = fixture();
    begin(controller);
    controller.handle(
        'Network.requestWillBeSent',
        {
            requestId: 'r',
            request: { url: 'https://example.com/final', method: 'GET' },
            redirectResponse: { status: 302 },
            redirectHasExtraInfo: false,
        },
        'session'
    );
    controller.handle('Network.requestWillBeSentExtraInfo', { requestId: 'r', headers: { Hop: 'final' } }, 'session');
    controller.handle(
        'Network.responseReceivedExtraInfo',
        { requestId: 'r', statusCode: 200, headers: { Hop: 'final' } },
        'session'
    );
    controller.handle(
        'Network.responseReceived',
        { requestId: 'r', response: { status: 200 }, hasExtraInfo: true },
        'session'
    );
    const logs = (await read(controller, 'network', 'details')).logs;
    assert.equal(logs.length, 2);
    assert.equal(logs[0].responseExtraInfo, undefined);
    assert.equal(logs[1].responseExtraInfo.headers.Hop, 'final');
    assert.equal(logs[1].requestExtraInfo.headers.Hop, 'final');
    assert.equal(logs[1].headersSource.complete, true);
});

test('raw handshake headers redact credentials, folded values and request URL fields', async () => {
    const { controller } = fixture();
    await controller.command('networkCapture', { op: 'start', include: ['stream'] });
    controller.handle(
        'Network.webSocketHandshakeResponseReceived',
        {
            requestId: 'headers',
            response: {
                requestHeadersText:
                    'GET ws://user:pass@example.com/ws?token=query-secret HTTP/1.1\r\nCookie: cookie-secret\r\nAuthorization: auth-secret\r\n folded-secret\r\nProxy-Authorization: proxy-secret\r\nX-Trace: kept\r\n',
                headers: {
                    Location:
                        'http://location-user:location-password@example.com/owned?token=location-token&plain=kept',
                    'Content-Location': '/relative?password=relative-password&plain=kept',
                    Referer: 'https://referer-user:referer-password@example.com/source',
                    'X-Trace': 'kept',
                },
                headerList: [{ name: 'Location', value: 'https://list-user:list-password@example.com/' }],
                headersText:
                    'HTTP/1.1 101 Switching Protocols\r\nSet-Cookie: response-secret\r\nLocation: http://location-user:location-password@example.com/owned?token=location-token&plain=kept\r\nContent-Location: /relative?password=relative-password&plain=kept\r\nReferer: https://referer-user:referer-password@example.com/source\r\nX-Trace: kept\r\n',
            },
        },
        'session'
    );
    const result = await read(controller, 'network', 'stream');
    const serialized = JSON.stringify(result);
    for (const value of [
        'user:pass',
        'query-secret',
        'cookie-secret',
        'auth-secret',
        'folded-secret',
        'proxy-secret',
        'response-secret',
        'location-user',
        'location-password',
        'location-token',
        'relative-password',
        'referer-user',
        'referer-password',
        'list-user',
        'list-password',
    ]) {
        assert.equal(serialized.includes(value), false, value);
    }
    assert.ok(result.logs[0].response.requestHeadersText.includes('X-Trace: kept'));
    assert.ok(result.logs[0].response.headersText.includes('Set-Cookie: [REDACTED]'));
    assert.ok(result.logs[0].response.headers.Location.includes('/owned?token=[REDACTED]&plain=kept'));
    assert.equal(result.logs[0].response.headers['Content-Location'], '/relative?password=[REDACTED]&plain=kept');
    assert.equal(result.logs[0].response.headers['X-Trace'], 'kept');
});

test('managed auth remains observed with route, download and raw Fetch configuration', async () => {
    const { controller, calls } = fixture();
    await controller.command('route', { op: 'add', urlPattern: 'https://example.com/mock' });
    await controller.command('download', { op: 'watch', urlPattern: 'https://example.com/attachment' });
    await controller.command('httpAuth', {
        op: 'set',
        scope: { source: 'Server', origin: 'https://example.com', realm: 'fixture' },
        username: 'synthetic',
        password: 'synthetic',
    });
    const config = () => calls.filter((call) => call[0] === 'Fetch.enable').at(-1)[1];
    assert.ok(config().patterns.some((p) => p.urlPattern === '*' && p.requestStage === 'Request'));
    assert.equal(config().handleAuthRequests, true);
    await controller.rawFetch('Fetch.enable', { patterns: [{ urlPattern: 'https://example.com/raw' }] });
    assert.ok(config().patterns.some((p) => p.urlPattern === '*' && p.requestStage === 'Request'));
    assert.ok(config().patterns.some((p) => p.urlPattern === 'https://example.com/attachment'));
    await controller.command('httpAuth', { op: 'clear' });
    assert.ok(!config().patterns.some((p) => p.urlPattern === '*'));
    assert.ok(config().patterns.some((p) => p.urlPattern === 'https://example.com/mock'));
    await controller.dispose('test completed');
});

test('native body reads preserve binary encoding and do not refetch URLs', async () => {
    const expected = Buffer.from([0, 255, 1, 2, 128]);
    const { controller, calls } = fixture(async (method) =>
        method === 'Network.getResponseBody'
            ? { body: expected.toString('base64'), base64Encoded: true }
            : { postData: 'original=1' }
    );
    begin(controller);
    controller.handle('Network.loadingFinished', { requestId: 'r' }, 'session');
    const ref = (await read(controller, 'network')).logs[0].ref;
    const body = await read(controller, 'network', 'responseBody', ref);
    assert.ok(Buffer.from(body.payload.data, body.payload.encoding).equals(expected));
    await read(controller, 'network', 'responseBody', ref);
    assert.equal(calls.filter((c) => c[0] === 'Network.getResponseBody').length, 1);
    assert.ok(calls.every((c) => !/fetch|navigate/i.test(c[0])));
});

test('route consumer precedes enable, unmatched requests continue and pauses resolve once', async () => {
    const { controller, calls } = fixture();
    const route = await controller.command('route', { op: 'add', urlPattern: '*example.com/api', stage: 'Request' });
    assert.equal(calls[0][0], 'Fetch.enable');
    paused(controller, 'unmatched', { request: { url: 'https://other.test/' } });
    paused(controller);
    await flush();
    const { logs } = await read(controller, 'network', 'paused');
    assert.equal(logs.length, 1);
    assert.ok(calls.some((c) => c[0] === 'Fetch.continueRequest' && c[1].requestId === 'unmatched'));
    await controller.command('route', {
        op: 'fulfill',
        ref: logs[0].ref,
        response: { status: 200, body: { encoding: 'utf8', data: 'mock' } },
    });
    const again = await controller.command('route', { op: 'fail', ref: logs[0].ref });
    assert.equal(again.alreadyProcessed, true);
    assert.equal(calls.filter((c) => c[0] === 'Fetch.fulfillRequest').length, 1);
    await controller.command('route', { op: 'remove', ref: route.rule.ref });
});

test('invalid response-stage overrides leave the pause available for handling', async () => {
    const { controller } = fixture();
    await controller.command('route', { op: 'add', urlPattern: '*', stage: 'Response' });
    paused(controller, 'response', { responseStatusCode: 200 });
    await flush();
    const ref = (await read(controller, 'network', 'paused')).logs[0].ref;
    await assert.rejects(
        controller.command('route', { op: 'continue', ref, request: { method: 'POST' } }),
        /Response-stage/
    );
    assert.equal((await read(controller, 'network', 'paused', ref)).logs[0].state, 'pending');
    await controller.command('route', { op: 'fail', ref });
});

test('navigation and release abort paused requests before Fetch disable', async () => {
    const { controller, calls } = fixture();
    await controller.command('route', { op: 'add', urlPattern: '*' });
    paused(controller);
    await flush();
    const ref = (await read(controller, 'network', 'paused')).logs[0].ref;
    controller.handle('Page.frameNavigated', { frame: { id: 'frame' } }, 'session');
    await flush();
    assert.equal((await read(controller, 'network', 'paused', ref)).logs[0].state, 'aborted');
    await controller.suspend('challenge');
    assert.ok(calls.findIndex((c) => c[0] === 'Fetch.failRequest') < calls.findIndex((c) => c[0] === 'Fetch.disable'));
});

test('auth credentials stay in exact Server/Proxy origin and realm scope; repeated challenge cancels', async () => {
    const { controller, calls } = fixture();
    await controller.command('httpAuth', {
        op: 'set',
        scope: { source: 'Server', origin: 'https://example.com', realm: 'synthetic' },
        username: 'synthetic-user',
        password: 'synthetic-pass',
    });
    const challenge = {
        requestId: 'auth',
        authChallenge: { source: 'Server', origin: 'https://example.com', realm: 'synthetic' },
    };
    controller.handle('Fetch.authRequired', challenge, 'session');
    await flush();
    controller.handle('Fetch.authRequired', challenge, 'session');
    await flush();
    controller.handle(
        'Fetch.authRequired',
        { ...challenge, requestId: 'proxy', authChallenge: { ...challenge.authChallenge, source: 'Proxy' } },
        'session'
    );
    await flush();
    const responses = calls.filter((c) => c[0] === 'Fetch.continueWithAuth').map((c) => c[1].authChallengeResponse);
    assert.equal(responses[0].response, 'ProvideCredentials');
    assert.equal(responses[1].response, 'CancelAuth');
    assert.equal(responses[2].response, 'CancelAuth');
    assert.ok(!JSON.stringify(await read(controller, 'network', 'auth')).includes('synthetic-pass'));
    await controller.suspend('stop');
});

test('raw Fetch uses the same owner and retains native command responses', async () => {
    const { controller } = fixture(async () => ({ nativeResult: 1 }));
    assert.deepEqual(await controller.rawFetch('Fetch.enable', { patterns: [{ urlPattern: '*' }] }), {
        nativeResult: 1,
    });
    paused(controller);
    await flush();
    assert.deepEqual(await controller.rawFetch('Fetch.continueRequest', { requestId: 'f' }), { nativeResult: 1 });
    await assert.rejects(controller.rawFetch('Fetch.continueRequest', { requestId: 'f' }), /not pending/);
    await controller.suspend('stop');
});

test('stream messages preserve direction and order and expose truncation', async () => {
    const { controller } = fixture();
    await controller.command('networkCapture', { op: 'start', include: ['stream'] });
    controller.handle(
        'Network.webSocketFrameSent',
        { requestId: 'ws', response: { opcode: 1, payloadData: 'sent' } },
        'session'
    );
    controller.handle(
        'Network.webSocketFrameReceived',
        { requestId: 'ws', response: { opcode: 2, payloadData: 'x'.repeat(70000) } },
        'session'
    );
    controller.handle(
        'Network.eventSourceMessageReceived',
        { requestId: 'sse', data: 'event', eventName: 'message', eventId: '1' },
        'session'
    );
    const { logs } = await read(controller, 'network', 'stream');
    assert.deepEqual(
        logs.map((l) => l.direction),
        ['sent', 'received', 'received']
    );
    assert.ok(logs[0].sequence < logs[1].sequence);
    assert.equal(logs[1].truncated, true);
    assert.equal(logs[1].response.payloadData.length, 65536);
});

test('download saves the intercepted original body and distinguishes native completion', async () => {
    const expected = Buffer.from([1, 2, 0, 255]);
    const { controller } = fixture(async (method) =>
        method === 'Fetch.getResponseBody' ? { body: expected.toString('base64'), base64Encoded: true } : {}
    );
    await controller.command('download', { op: 'watch', urlPattern: '*' });
    paused(controller, 'download', {
        responseStatusCode: 200,
        responseHeaders: [{ name: 'Content-Disposition', value: 'attachment; filename="original.bin"' }],
    });
    await flush();
    controller.handle(
        'Page.downloadWillBegin',
        { guid: 'original-guid', frameId: 'frame', url: 'https://example.com/api', suggestedFilename: 'original.bin' },
        'session'
    );
    const ref = (await read(controller, 'download')).logs[0].ref;
    await assert.rejects(controller.command('download', { op: 'save', ref }), /not complete/);
    controller.handle(
        'Page.downloadProgress',
        { guid: 'original-guid', state: 'completed', receivedBytes: 4, totalBytes: 4 },
        'session'
    );
    const result = await controller.command('download', { op: 'save', ref });
    assert.ok(Buffer.from(result.payload.data, result.payload.encoding).equals(expected));
    assert.equal(result.download.guid, 'original-guid');
    await controller.suspend('stop');
});

test('cancel during original body read waits for the read then aborts, without continuing', async () => {
    let finish;
    const { controller, calls } = fixture(async (method) =>
        method === 'Fetch.getResponseBody'
            ? new Promise((resolve) => {
                  finish = resolve;
              })
            : {}
    );
    await controller.command('download', { op: 'watch' });
    paused(controller, 'download', {
        responseStatusCode: 200,
        responseHeaders: [{ name: 'Content-Disposition', value: 'attachment' }],
    });
    await flush();
    const stop = controller.suspend('request cancelled');
    finish({ body: 'AAE=', base64Encoded: true });
    await stop;
    assert.ok(calls.some((c) => c[0] === 'Fetch.failRequest'));
    assert.ok(!calls.some((c) => c[0] === 'Fetch.continueResponse'));
});

test('event caches expose eviction and clear never resumes active controls', async () => {
    const { controller, calls } = fixture();
    for (let i = 0; i < 510; i++) {
        begin(controller, String(i));
    }
    const result = await read(controller, 'network');
    assert.equal(result.totalBuffered, 500);
    assert.ok(result.evicted >= 10);
    await controller.command('route', { op: 'add', urlPattern: '*' });
    paused(controller);
    await flush();
    await read(controller, 'network', 'paused', undefined, true);
    assert.equal((await read(controller, 'network', 'paused')).logs[0].state, 'pending');
    assert.ok(!calls.some((c) => c[0] === 'Fetch.continueRequest'));
    await controller.suspend('stop');
});

test('nested schemas reject misplaced fields and retain explicit byte payloads', () => {
    assert.equal(
        browserEventCommandSchema.safeParse({ action: 'route', command: { op: 'add', urlPattern: '*', password: 'x' } })
            .success,
        false
    );
    assert.equal(
        browserEventCommandSchema.safeParse({ action: 'download', command: { op: 'save', ref: 'r' } }).success,
        false
    );
    assert.equal(
        browserEventCommandSchema.safeParse({
            action: 'route',
            command: { op: 'fulfill', ref: 'r', response: { status: 200, body: { encoding: 'base64', data: 'AAE=' } } },
        }).success,
        true
    );
});

test('lost native continuation acknowledgement remains unknown and prevents unsafe disable', async () => {
    const { controller, calls } = fixture(async (method) => {
        if (method === 'Fetch.fulfillRequest') {
            throw Error('lost native acknowledgement');
        }
        return {};
    });
    await controller.command('route', { op: 'add', urlPattern: '*' });
    paused(controller);
    await flush();
    const ref = (await read(controller, 'network', 'paused')).logs[0].ref;
    await assert.rejects(controller.command('route', { op: 'fulfill', ref, response: { status: 200 } }), /lost native/);
    const state = await controller.suspend('disconnect');
    assert.equal(state.suspended, false);
    assert.equal(state.unresolved[0].state, 'unknown');
    assert.ok(!calls.some((call) => call[0] === 'Fetch.disable'));
    assert.equal((await controller.command('route', { op: 'fail', ref })).alreadyProcessed, true);
});

test('raw authentication waits for explicit owned challenge handling and keeps native response', async () => {
    const { controller } = fixture(async () => ({ nativeResponse: true }));
    await controller.rawFetch('Fetch.enable', { handleAuthRequests: true });
    controller.handle(
        'Fetch.authRequired',
        { requestId: 'raw-auth', authChallenge: { source: 'Server', origin: 'https://example.com', realm: 'owned' } },
        'session'
    );
    await flush();
    const auth = (await read(controller, 'network', 'auth')).logs[0];
    assert.equal(auth.state, 'pending');
    assert.deepEqual(
        await controller.rawFetch('Fetch.continueWithAuth', {
            requestId: 'raw-auth',
            authChallengeResponse: { response: 'CancelAuth' },
        }),
        { nativeResponse: true }
    );
    await controller.suspend('stop');
});

test('multiple same-frame original response candidates are reported unavailable instead of misassigned', async () => {
    const { controller } = fixture(async (method) =>
        method === 'Fetch.getResponseBody' ? { body: 'AAE=', base64Encoded: true } : {}
    );
    await controller.command('download', { op: 'watch' });
    for (const requestId of ['download-a', 'download-b']) {
        paused(controller, requestId, {
            responseStatusCode: 200,
            responseHeaders: [{ name: 'Content-Disposition', value: 'attachment' }],
        });
    }
    await flush();
    controller.handle(
        'Page.downloadWillBegin',
        { guid: 'native-ambiguous', frameId: 'frame', url: 'https://example.com/api' },
        'session'
    );
    const entry = (await read(controller, 'download')).logs[0];
    assert.equal(entry.artifact, 'unavailable');
    assert.match(entry.artifactReason, /Multiple original response candidates/);
    await controller.suspend('stop');
});

test('known modal refuses a new native operation before dispatch and ref kinds are checked', async () => {
    const { controller } = fixture();
    controller.handle('Page.javascriptDialogOpening', { type: 'alert', message: 'owned' }, 'session');
    assert.throws(
        () => controller.assertNativeReady(),
        (error) => error.context.actionExecuted === false && error.context.actionStatus === 'not_started'
    );
    const ref = (await read(controller, 'dialog')).logs[0].ref;
    await assert.rejects(read(controller, 'network', 'details', ref), /kind/);
    await controller.command('dialog', { op: 'dismiss', ref });
});

test('removing one route preserves pending requests owned by another rule', async () => {
    const { controller, calls } = fixture();
    const first = await controller.command('route', { op: 'add', urlPattern: '*first' });
    const second = await controller.command('route', { op: 'add', urlPattern: '*second' });
    paused(controller, 'first', { request: { url: 'https://example.com/first' } });
    paused(controller, 'second', { request: { url: 'https://example.com/second' } });
    await flush();
    await controller.command('route', { op: 'remove', ref: first.rule.ref });
    const remaining = (await read(controller, 'network', 'paused')).logs.find((entry) => entry.requestId === 'second');
    assert.equal(remaining.state, 'pending');
    assert.ok(!calls.some((call) => call[0] === 'Fetch.failRequest' && call[1].requestId === 'second'));
    await controller.command('route', { op: 'remove', ref: second.rule.ref });
});

test('large metadata and active pause admission remain bounded with explicit loss', async () => {
    const { controller, calls } = fixture();
    begin(controller, 'large', {
        request: {
            url: 'https://example.com/large',
            method: 'GET',
            headers: { a: 'a'.repeat(70000), b: 'b'.repeat(70000), c: 'c'.repeat(70000) },
        },
    });
    const details = await read(controller, 'network', 'details');
    assert.equal(details.logs[0].metadataTruncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(details.logs[0])) < 128 * 1024);
    await controller.command('route', { op: 'add', urlPattern: '*' });
    for (let index = 0; index < 65; ++index) {
        paused(controller, `bounded-${index}`);
    }
    await flush();
    const pauses = await read(controller, 'network', 'paused');
    assert.equal(pauses.logs.length, 64);
    assert.equal(pauses.limits.pending, 64);
    assert.ok(pauses.dropped >= 1);
    assert.ok(calls.some((call) => call[0] === 'Fetch.failRequest' && call[1].requestId === 'bounded-64'));
    await controller.suspend('stop');
});

test('expired native interception identities release every pause path without blocking later Fetch configuration', async (t) => {
    const operations = {
        navigation: 'Fetch.failRequest',
        'frame-navigation': 'Fetch.failRequest',
        continue: 'Fetch.continueRequest',
        fulfill: 'Fetch.fulfillRequest',
        fail: 'Fetch.failRequest',
        raw: 'Fetch.continueRequest',
        auth: 'Fetch.continueWithAuth',
        'raw-auth': 'Fetch.continueWithAuth',
        'download-read': 'Fetch.getResponseBody',
        'download-cleanup': 'Fetch.failRequest',
    };
    for (const backend of ['extension', 'cdp']) {
        for (const [operation, method] of Object.entries(operations)) {
            await t.test(`${backend}/${operation}`, async (st) => {
                const failure =
                    backend === 'extension'
                        ? Error(JSON.stringify({ code: -32602, message: 'Invalid InterceptionId.' }))
                        : new CDPError(`${method}: Invalid InterceptionId.`, {
                              method,
                              protocolError: true,
                              nativeCode: -32602,
                          });
                const { controller, calls } = fixture(
                    async (name) => {
                        if (operation === 'download-cleanup' && name === 'Fetch.getResponseBody') {
                            throw Error('Owned body unavailable');
                        }
                        if (name === method) {
                            throw failure;
                        }
                        return {};
                    },
                    { backend }
                );
                st.after(() => {
                    for (const pause of controller.pauses.values()) {
                        clearTimeout(pause.timer);
                    }
                });
                await controller.command('route', { op: 'add', urlPattern: '*' });
                const credentials = {
                    op: 'set',
                    scope: { source: 'Server', origin: 'https://example.com' },
                    username: 'test',
                    password: 'test',
                };
                if (operation === 'auth' || operation === 'raw-auth') {
                    if (operation === 'auth') {
                        await controller.command('httpAuth', credentials);
                    } else {
                        await controller.rawFetch('Fetch.enable', { handleAuthRequests: true });
                    }
                    controller.handle(
                        'Fetch.authRequired',
                        {
                            requestId: 'stale-fetch',
                            authChallenge: { source: 'Server', origin: 'https://example.com', realm: 'owned' },
                        },
                        'session'
                    );
                } else {
                    if (operation.startsWith('download-')) {
                        await controller.command('download', { op: 'watch' });
                    }
                    paused(
                        controller,
                        'stale-fetch',
                        operation.startsWith('download-')
                            ? {
                                  responseStatusCode: 200,
                                  responseHeaders: [{ name: 'Content-Disposition', value: 'attachment' }],
                              }
                            : {}
                    );
                }
                await flush();
                const entry = [...controller.entries.values()].find((e) => e.requestId === 'stale-fetch');
                if (operation.endsWith('navigation')) {
                    controller.handle(
                        'Page.frameNavigated',
                        { frame: { id: 'frame', ...(operation === 'frame-navigation' ? { parentId: 'main' } : {}) } },
                        'session'
                    );
                    await flush();
                } else if (operation === 'raw' || operation === 'raw-auth') {
                    await assert.rejects(
                        controller.rawFetch(method, { requestId: 'stale-fetch' }),
                        (e) => e === failure
                    );
                } else if (['continue', 'fulfill', 'fail'].includes(operation)) {
                    await assert.rejects(
                        controller.command('route', {
                            op: operation,
                            ref: entry.ref,
                            ...(operation === 'fulfill' ? { response: { status: 200 } } : {}),
                        }),
                        (e) => e === failure
                    );
                }
                assert.equal(entry.state, 'expired');
                if (operation.startsWith('download-')) {
                    const failureInfo = (await read(controller, 'download')).downloadCaptureFailures.find(
                        (e) => e.ref === entry.ref
                    );
                    assert.equal(failureInfo.state, 'expired');
                    assert.equal(
                        failureInfo.error,
                        operation === 'download-cleanup' ? 'Owned body unavailable' : failure.message
                    );
                    if (operation === 'download-cleanup') {
                        assert.equal(failureInfo.cleanupError, failure.message);
                    }
                }
                assert.equal(controller.pauses.size, 0);
                assert.equal((await read(controller, 'network', 'paused')).cleanupFailures.length, 0);
                assert.equal(calls.filter((c) => c[0] === method).length, 1);
                assert.equal((await controller.command('httpAuth', credentials)).authConfigured, true);
                assert.equal((await controller.suspend('test cleanup')).suspended, true);
            });
        }
    }
});

test('native interception expiry keeps validation refusals, lost acknowledgements and page errors distinct', async (t) => {
    const cases = [
        ['parameters', Error(JSON.stringify({ code: -32602, message: 'Invalid parameters' })), 'pending'],
        ['wrong-code', Error(JSON.stringify({ code: -32000, message: 'Invalid InterceptionId.' })), 'unknown'],
        ['lost-ack', Error('lost native acknowledgement'), 'unknown'],
        ['plain-text', Error('Invalid InterceptionId.'), 'unknown'],
        [
            'page-script',
            setErrorSource(Error(JSON.stringify({ code: -32602, message: 'Invalid InterceptionId.' })), 'page'),
            'unknown',
        ],
    ];
    for (const [name, failure, expected] of cases) {
        for (const cleanup of [false, true]) {
            await t.test(`${name}/${cleanup ? 'cleanup' : 'command'}`, async (st) => {
                const { controller, calls } = fixture(async (method) => {
                    if (method === (cleanup ? 'Fetch.failRequest' : 'Fetch.fulfillRequest')) {
                        throw failure;
                    }
                    return {};
                });
                st.after(() => {
                    for (const pause of controller.pauses.values()) {
                        clearTimeout(pause.timer);
                    }
                });
                await controller.command('route', { op: 'add', urlPattern: '*' });
                paused(controller);
                await flush();
                const ref = (await read(controller, 'network', 'paused')).logs[0].ref;
                if (cleanup) {
                    await controller.abortPending('navigation');
                } else {
                    await assert.rejects(
                        controller.command('route', { op: 'fulfill', ref, response: { status: 200 } }),
                        (e) => e === failure
                    );
                }
                assert.equal((await read(controller, 'network', 'paused', ref)).logs[0].state, expected);
                if (name === 'page-script') {
                    assert.equal(getErrorSource(failure), 'page');
                }
                if (expected === 'pending') {
                    if (cleanup) {
                        assert.equal((await controller.suspend('test stop')).suspended, false);
                        assert.ok(!calls.some((c) => c[0] === 'Fetch.disable'));
                    }
                    await controller.command('route', { op: 'continue', ref });
                    assert.equal((await controller.suspend('test stop')).suspended, true);
                } else {
                    assert.equal((await controller.suspend('test stop')).suspended, false);
                    assert.ok(!calls.some((c) => c[0] === 'Fetch.disable'));
                }
            });
        }
    }
});

test('native interception expiry preserves sibling-session pauses with the same requestId', async (t) => {
    const { controller, calls } = fixture(async (method, _params, sessionId) => {
        if (method === 'Fetch.failRequest' && sessionId === 'session') {
            throw Error(JSON.stringify({ code: -32602, message: 'Invalid InterceptionId.' }));
        }
        return {};
    });
    t.after(() => {
        for (const entry of controller.pauses.values()) {
            clearTimeout(entry.timer);
        }
    });
    await controller.command('route', { op: 'add', urlPattern: '*' });
    for (const sessionId of ['session', 'child']) {
        controller.handle(
            'Fetch.requestPaused',
            { requestId: 'shared', request: { url: 'https://example.com/owned' }, frameId: sessionId },
            sessionId
        );
    }
    await flush();
    controller.handle('Page.frameNavigated', { frame: { id: 'session', parentId: 'main' } }, 'session');
    await flush();
    const entries = (await read(controller, 'network', 'paused')).logs;
    assert.equal(entries.find((e) => e.sessionId === 'session').state, 'expired');
    assert.equal(entries.find((e) => e.sessionId === 'child').state, 'pending');
    assert.equal(controller.pauses.size, 1);
    await controller.rawFetch('Fetch.continueRequest', { requestId: 'shared' });
    assert.deepEqual(calls.at(-1), ['Fetch.continueRequest', { requestId: 'shared' }, 'child']);
    assert.equal((await controller.suspend('test cleanup')).suspended, true);
});

test('native cleanup parameter refusals preserve pending requests before both Fetch disable paths', async (t) => {
    for (const operation of ['raw-disable', 'route-remove']) {
        await t.test(operation, async (st) => {
            const { controller, calls } = fixture(async (method) => {
                if (method === 'Fetch.failRequest') {
                    throw Error(JSON.stringify({ code: -32602, message: 'Invalid parameters' }));
                }
                return {};
            });
            st.after(() => {
                for (const entry of controller.pauses.values()) {
                    clearTimeout(entry.timer);
                }
            });
            const { rule } = await controller.command('route', { op: 'add', urlPattern: '*' });
            paused(controller);
            await flush();
            const { ref } = (await read(controller, 'network', 'paused')).logs[0];
            await assert.rejects(
                operation === 'raw-disable'
                    ? controller.rawFetch('Fetch.disable')
                    : controller.command('route', { op: 'remove', ref: rule.ref }),
                /incomplete/
            );
            assert.equal(controller.pauses.get(ref).state, 'pending');
            assert.ok(!calls.some((c) => c[0] === 'Fetch.disable'));
            await controller.command('route', { op: 'continue', ref });
            assert.equal((await controller.suspend('test cleanup')).suspended, true);
        });
    }
});

test('native auth and download cleanup distinguish parameter refusals from lost acknowledgements', async (t) => {
    for (const operation of ['auth', 'download']) {
        for (const refused of [true, false]) {
            await t.test(`${operation}/${refused ? 'parameters' : 'lost-ack'}`, async (st) => {
                let reject = true;
                const failure = refused
                    ? Error(JSON.stringify({ code: -32602, message: 'Invalid parameters' }))
                    : Error('lost native acknowledgement');
                const { controller, calls } = fixture(async (method) => {
                    if (operation === 'download' && method === 'Fetch.getResponseBody') {
                        throw Error('Owned body unavailable');
                    }
                    if (reject && method === (operation === 'auth' ? 'Fetch.continueWithAuth' : 'Fetch.failRequest')) {
                        throw failure;
                    }
                    return {};
                });
                st.after(() => {
                    for (const entry of controller.pauses.values()) {
                        clearTimeout(entry.timer);
                    }
                });
                if (operation === 'auth') {
                    await controller.command('httpAuth', {
                        op: 'set',
                        scope: { source: 'Server', origin: 'https://example.com' },
                        username: 'test',
                        password: 'test',
                    });
                    controller.handle(
                        'Fetch.authRequired',
                        {
                            requestId: 'owned',
                            authChallenge: { source: 'Server', origin: 'https://example.com', realm: 'owned' },
                        },
                        'session'
                    );
                } else {
                    await controller.command('download', { op: 'watch' });
                    paused(controller, 'owned', {
                        responseStatusCode: 200,
                        responseHeaders: [{ name: 'Content-Disposition', value: 'attachment' }],
                    });
                }
                await flush();
                const entry = [...controller.pauses.values()][0];
                assert.equal(entry.state, refused ? 'pending' : 'unknown');
                if (operation === 'download') {
                    const [info] = (await read(controller, 'download')).downloadCaptureFailures;
                    assert.equal(info.error, 'Owned body unavailable');
                    assert.equal(info.cleanupError, failure.message);
                }
                assert.equal((await controller.suspend('test cleanup')).suspended, false);
                assert.ok(!calls.some((c) => c[0] === 'Fetch.disable'));
                if (refused) {
                    reject = false;
                    await controller.rawFetch(
                        operation === 'auth' ? 'Fetch.continueWithAuth' : 'Fetch.continueResponse',
                        { requestId: entry.requestId }
                    );
                    assert.equal((await controller.suspend('test cleanup')).suspended, true);
                }
            });
        }
    }
});

test('native cleanup refusal at pause expiry retains its ref without automatic retry', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { controller, calls } = fixture(async (method) => {
        if (method === 'Fetch.failRequest') {
            throw Error(JSON.stringify({ code: -32602, message: 'Invalid parameters' }));
        }
        return {};
    });
    await controller.command('route', { op: 'add', urlPattern: '*' });
    paused(controller);
    await flush();
    const { ref } = (await read(controller, 'network', 'paused')).logs[0];
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(controller.pauses.get(ref).state, 'pending');
    assert.equal(calls.filter((c) => c[0] === 'Fetch.failRequest').length, 1);
    t.mock.timers.tick(100);
    await flush();
    assert.equal(calls.filter((c) => c[0] === 'Fetch.failRequest').length, 1);
    await controller.command('route', { op: 'continue', ref });
    assert.equal((await controller.suspend('test cleanup')).suspended, true);
});

test('explicit native Fetch validation refusal preserves its pending ref for correction', async (t) => {
    for (const error of [
        Object.assign(Error('Invalid parameters'), { context: { nativeCode: -32602, actionExecuted: false } }),
        Error(JSON.stringify({ code: -32602, message: 'Invalid parameters' })),
    ]) {
        await t.test(error.message, async () => {
            const { controller, calls } = fixture(async (method) => {
                if (method === 'Fetch.fulfillRequest') {
                    throw error;
                }
                return {};
            });
            await controller.command('route', { op: 'add', urlPattern: '*' });
            paused(controller);
            await flush();
            const ref = (await read(controller, 'network', 'paused')).logs[0].ref;
            await assert.rejects(controller.command('route', { op: 'fulfill', ref, response: { status: 200 } }));
            assert.equal((await read(controller, 'network', 'paused', ref)).logs[0].state, 'pending');
            await controller.command('route', { op: 'fail', ref });
            assert.equal(calls.filter((call) => call[0] === 'Fetch.fulfillRequest').length, 1);
            assert.equal((await controller.suspend('stop')).suspended, true);
        });
    }
});
