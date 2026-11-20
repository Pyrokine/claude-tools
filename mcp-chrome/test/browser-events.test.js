import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const root = process.env.MCP_EVENT_DIST ?? path.resolve(import.meta.dirname, '../dist');
// noinspection ES6TopLevelAwaitExpression -- Node ESM 等待所选候选模块加载后注册测试
const { BrowserEventController } = await import(pathToFileURL(path.join(root, 'core/browser-events.js')));
// noinspection ES6TopLevelAwaitExpression -- 与 MCP_EVENT_DIST 指定的同一候选保持一致
const { browserEventCommandSchema } = await import(pathToFileURL(path.join(root, 'core/browser-event-schema.js')));
// noinspection ES6TopLevelAwaitExpression -- 与 MCP_EVENT_DIST 指定的同一候选保持一致
const { CDPClient } = await import(pathToFileURL(path.join(root, 'cdp/client.js')));
// noinspection ES6TopLevelAwaitExpression -- 与 MCP_EVENT_DIST 指定的同一候选保持一致
const { CDPError, getErrorSource, setErrorSource } = await import(pathToFileURL(path.join(root, 'core/errors.js')));
const flush = () => new Promise((resolve) => setImmediate(resolve));
/**
 * @param {(method: string, params?: object, sessionId?: string) => Promise<object>} [send]
 * @param {object} [identity]
 */
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

test('HOST-NAV-01 observer disposal retains in-flight native success and failure', async (t) => {
    for (const reason of ['debugger detached or page released', 'page closed', 'server disconnected']) {
        for (const outcome of ['completed', 'failed']) {
            await t.test(`${reason}: ${outcome}`, async () => {
                const { controller } = fixture();
                let finish;
                let fail;
                const failure = new Error('original native operation failed');
                const native = new Promise((resolve, reject) => {
                    finish = resolve;
                    fail = reject;
                });
                const operation = controller.race(native);
                let settled = false;
                void operation.then(
                    () => {
                        settled = true;
                    },
                    () => {
                        settled = true;
                    }
                );
                try {
                    await controller.dispose(reason);
                    await flush();
                    assert.equal(settled, false, 'Observer teardown must wait for the native operation outcome');
                    if (outcome === 'completed') {
                        finish({ native: 'completed' });
                        assert.deepEqual(await operation, { native: 'completed' });
                    } else {
                        fail(failure);
                        await assert.rejects(operation, (error) => error === failure);
                    }
                    assert.equal(controller.dialogWaiters.size, 0);
                    await assert.rejects(read(controller, 'dialog'), /closed/);
                } finally {
                    finish({ native: 'cleanup' });
                    await operation.catch(() => {});
                }
            });
        }
    }
});

test('HOST-NAV-01 disposed observers retain native deadlines, cancellation and transport errors', async (t) => {
    for (const ending of ['budget', 'cancelled', 'transport']) {
        await t.test(ending, async () => {
            const abort = new AbortController();
            const scope = { deadline: Date.now() + 80, signal: abort.signal };
            const client = new CDPClient(() => scope);
            let dispatches = 0;
            client.ws = {
                readyState: 1,
                send() {
                    ++dispatches;
                },
                close() {},
            };
            const { controller } = fixture();
            const operation = controller.race(
                client.send('Page.navigate', { url: 'chrome://extensions/' }, 'session', 80)
            );
            const rejected = assert.rejects(operation, (error) => {
                assert.ok(error instanceof CDPError);
                assert.equal(getErrorSource(error), ending);
                assert.equal(error.context.actionExecuted, 'unknown');
                assert.equal(error.context.actionStatus, 'unknown');
                assert.equal(error.context.retryable, false);
                return true;
            });
            try {
                await controller.dispose('debugger detached or page released');
                if (ending === 'cancelled') {
                    abort.abort();
                }
                if (ending === 'transport') {
                    client.close();
                }
                await rejected;
                assert.equal(dispatches, 1);
                assert.equal(client.callbacks.size, 0);
            } finally {
                client.close();
            }
        });
    }
});

test('HOST-NAV-01 observer disposal preserves native refusal before dispatch', async () => {
    const abort = new AbortController();
    abort.abort();
    const client = new CDPClient(() => ({ signal: abort.signal }));
    let dispatches = 0;
    client.ws = {
        readyState: 1,
        send() {
            ++dispatches;
        },
        close() {},
    };
    const { controller } = fixture();
    const operation = controller.race(client.send('Page.navigate', { url: 'chrome://extensions/' }, 'session', 80));
    const rejected = assert.rejects(operation, (error) => {
        assert.equal(getErrorSource(error), 'cancelled');
        assert.equal(error.context.actionExecuted, false);
        assert.equal(error.context.actionStatus, 'not_started');
        return true;
    });
    await controller.dispose('debugger detached or page released');
    await rejected;
    assert.equal(dispatches, 0);
    client.close();
});

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
                    'GET ws://user:pass@example.com/ws?token=query-secret HTTP/1.1\r\n' +
                    'Cookie: cookie-secret\r\nAuthorization: auth-secret\r\n folded-secret\r\n' +
                    'Proxy-Authorization: proxy-secret\r\nX-Trace: kept\r\n',
                headers: {
                    Location:
                        // noinspection HttpUrlsUsage -- 合成 HTTP Location 验证凭证脱敏，保留原协议
                        'http://location-user:location-password@example.com/owned?token=location-token&plain=kept',
                    'Content-Location': '/relative?password=relative-password&plain=kept',
                    Referer: 'https://referer-user:referer-password@example.com/source',
                    'X-Trace': 'kept',
                },
                headerList: [{ name: 'Location', value: 'https://list-user:list-password@example.com/' }],
                // noinspection HttpUrlsUsage -- 合成原始 HTTP header 验证凭证脱敏，保留原协议
                headersText:
                    'HTTP/1.1 101 Switching Protocols\r\nSet-Cookie: response-secret\r\n' +
                    // noinspection HttpUrlsUsage -- 合成原始 HTTP header 验证凭证脱敏
                    'Location: http://location-user:location-password@example.com/owned?' +
                    'token=location-token&plain=kept\r\n' +
                    'Content-Location: /relative?password=relative-password&plain=kept\r\n' +
                    'Referer: https://referer-user:referer-password@example.com/source\r\nX-Trace: kept\r\n',
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

test('raw Fetch configuration refusals preserve the last effective configuration', async (t) => {
    for (const method of ['Fetch.enable', 'Fetch.disable']) {
        for (const previous of ['disabled', 'raw', 'managed']) {
            for (const backend of ['cdp', 'extension']) {
                await t.test(`${method}/${previous}/${backend}`, async (st) => {
                    let reject = false;
                    const failure =
                        backend === 'cdp'
                            ? new CDPError(`${method}: Invalid parameters`, {
                                  method,
                                  nativeCode: -32602,
                                  actionExecuted: false,
                                  actionStatus: 'not_started',
                              })
                            : Error(JSON.stringify({ code: -32602, message: 'Invalid parameters' }));
                    const { controller, calls } = fixture(
                        async (name) => {
                            if (reject && name === method) {
                                throw failure;
                            }
                            return { nativeResult: name };
                        },
                        { backend }
                    );
                    st.after(() => controller.dispose('test finished'));
                    let rawRule;
                    if (previous !== 'disabled') {
                        await controller.rawFetch('Fetch.enable', {
                            patterns: [{ urlPattern: 'https://example.com/raw-before' }],
                            handleAuthRequests: true,
                        });
                        paused(controller, 'before', { request: { url: 'https://example.com/raw-before' } });
                        rawRule = (await read(controller, 'network', 'paused')).logs[0].ruleRef;
                        await controller.rawFetch('Fetch.continueRequest', { requestId: 'before' });
                    }
                    if (previous === 'managed') {
                        await controller.command('route', { op: 'add', urlPattern: 'https://example.com/managed' });
                        await controller.command('download', { op: 'watch', urlPattern: 'https://example.com/file' });
                        await controller.command('httpAuth', {
                            op: 'set',
                            scope: { source: 'Server', origin: 'https://example.com' },
                            username: 'synthetic',
                            password: 'synthetic',
                        });
                    }
                    const before = await read(controller, 'network');
                    reject = true;
                    await assert.rejects(
                        controller.rawFetch(method, { patterns: [], handleAuthRequests: true }),
                        (error) => error === failure
                    );
                    reject = false;
                    const after = await read(controller, 'network');
                    for (const field of ['fetchEnabled', 'routes', 'authConfigured', 'downloadWatching']) {
                        assert.equal(after[field], before[field], field);
                    }
                    if (previous !== 'disabled') {
                        paused(controller, 'after', { request: { url: 'https://example.com/raw-before' } });
                        const entry = (await read(controller, 'network', 'paused')).logs.find(
                            (p) => p.requestId === 'after'
                        );
                        assert.equal(entry?.ruleRef, rawRule);
                        await controller.rawFetch('Fetch.continueRequest', { requestId: 'after' });
                    }
                    const recovery = await controller.command('httpAuth', { op: 'clear' });
                    assert.equal(recovery.fetchEnabled, previous !== 'disabled');
                    assert.equal(recovery.authConfigured, false);
                    if (previous === 'disabled') {
                        assert.equal(
                            calls.filter((call) => call[0] === 'Fetch.enable').length,
                            method === 'Fetch.enable' ? 1 : 0
                        );
                    } else {
                        const config = calls.filter((call) => call[0] === 'Fetch.enable').at(-1)[1];
                        assert.equal(config.handleAuthRequests, true);
                        assert.ok(config.patterns.some((p) => p.urlPattern === 'https://example.com/raw-before'));
                        if (previous === 'managed') {
                            assert.ok(config.patterns.some((p) => p.urlPattern === 'https://example.com/managed'));
                            assert.ok(config.patterns.some((p) => p.urlPattern === 'https://example.com/file'));
                        }
                    }
                });
            }
        }
    }
});

test('raw Fetch local route-limit rejection preserves existing raw routes', async (t) => {
    const { controller, calls } = fixture();
    t.after(() => controller.dispose('test finished'));
    const patterns = Array.from({ length: 100 }, (_, index) => ({ urlPattern: `https://example.com/raw-${index}` }));
    await controller.rawFetch('Fetch.enable', { patterns, handleAuthRequests: true });
    await assert.rejects(controller.rawFetch('Fetch.enable', { patterns: [...patterns, {}] }), /Route limit/);
    assert.equal(calls.length, 1);
    assert.equal((await read(controller, 'network')).routes, 100);
    await controller.command('httpAuth', { op: 'clear' });
    assert.deepEqual(
        calls.at(-1)[1].patterns.map((p) => p.urlPattern),
        patterns.map((p) => p.urlPattern)
    );
    assert.equal(calls.at(-1)[1].handleAuthRequests, true);
});

test('raw Fetch configuration retains dispatched unknown outcomes and original errors', async (t) => {
    for (const source of ['protocol', 'budget', 'cancelled', 'transport', 'page']) {
        for (const method of ['Fetch.enable', 'Fetch.disable']) {
            await t.test(`${source}/${method}`, async (st) => {
                const failure =
                    source === 'page'
                        ? setErrorSource(Error(JSON.stringify({ code: -32602, message: 'Invalid parameters' })), 'page')
                        : new CDPError('original native outcome unknown', {
                              method,
                              errorSource: source,
                              actionExecuted: 'unknown',
                              actionStatus: 'unknown',
                          });
                let reject = false;
                const { controller } = fixture(async (name) => {
                    if (reject && name === method) {
                        throw failure;
                    }
                    return {};
                });
                st.after(() => controller.dispose('test finished'));
                if (method === 'Fetch.disable') {
                    await controller.rawFetch('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
                }
                reject = true;
                await assert.rejects(
                    controller.rawFetch(method, {
                        patterns: [{ urlPattern: 'https://example.com/unknown' }],
                        handleAuthRequests: true,
                    }),
                    (error) => error === failure
                );
                reject = false;
                const state = await read(controller, 'network');
                assert.equal(state.fetchEnabled, method === 'Fetch.enable');
                assert.equal(state.routes, method === 'Fetch.enable' ? 1 : 0);
                assert.equal(getErrorSource(failure), source);
            });
        }
    }
});

test('raw Fetch consumers observe native pauses and auth before enable acknowledgement', async (t) => {
    for (const outcome of ['success', 'unknown']) {
        await t.test(outcome, async (st) => {
            let finish;
            let fail;
            const native = new Promise((resolve, reject) => {
                finish = resolve;
                fail = reject;
            });
            const { controller, calls } = fixture((method) =>
                method === 'Fetch.enable' ? native : Promise.resolve({})
            );
            st.after(() => controller.dispose('test finished'));
            const operation = controller.rawFetch('Fetch.enable', { handleAuthRequests: true });
            const failure = new CDPError('enable acknowledgement lost', {
                actionExecuted: 'unknown',
                actionStatus: 'unknown',
            });
            const result = outcome === 'unknown' ? assert.rejects(operation, (error) => error === failure) : operation;
            await flush();
            paused(controller, 'early-pause');
            controller.handle(
                'Fetch.authRequired',
                {
                    requestId: 'early-auth',
                    request: { url: 'https://example.com/auth' },
                    authChallenge: { source: 'Server', origin: 'https://example.com', realm: 'owned' },
                },
                'session'
            );
            assert.equal((await read(controller, 'network', 'paused')).logs[0].state, 'pending');
            assert.equal((await read(controller, 'network', 'auth')).logs[0].state, 'pending');
            assert.equal(calls.length, 1);
            if (outcome === 'success') {
                finish({ nativeResult: 'enabled' });
                assert.deepEqual(await result, { nativeResult: 'enabled' });
            } else {
                fail(failure);
                await result;
            }
            assert.equal((await read(controller, 'network')).routes, 1);
            assert.equal((await controller.suspend('test finished')).suspended, true);
            assert.equal(calls.filter((call) => call[0] === 'Fetch.failRequest').length, 1);
            assert.equal(calls.filter((call) => call[0] === 'Fetch.continueWithAuth').length, 1);
        });
    }
});

test('raw Fetch replacement keeps prior consumers until the native acknowledgement', async (t) => {
    for (const outcome of ['success', 'refused', 'unknown']) {
        await t.test(outcome, async (st) => {
            let finish;
            let fail;
            let replacement = false;
            const native = new Promise((resolve, reject) => {
                finish = resolve;
                fail = reject;
            });
            const { controller, calls } = fixture((method) =>
                method === 'Fetch.enable' && replacement ? native : Promise.resolve({})
            );
            st.after(() => controller.dispose('test finished'));
            await controller.rawFetch('Fetch.enable', {
                patterns: [{ urlPattern: 'https://example.com/old' }],
                handleAuthRequests: true,
            });
            replacement = true;
            const pending = controller.rawFetch('Fetch.enable', {
                patterns: [{ urlPattern: 'https://example.com/new' }],
            });
            const failure = new CDPError('Fetch.enable: original native failure', {
                nativeCode: outcome === 'refused' ? -32602 : -32000,
                actionExecuted: outcome === 'refused' ? false : 'unknown',
                actionStatus: outcome === 'refused' ? 'not_started' : 'unknown',
            });
            const result = outcome === 'success' ? pending : assert.rejects(pending, (error) => error === failure);
            await flush();
            for (const name of ['old', 'new']) {
                paused(controller, name, { request: { url: `https://example.com/${name}` } });
            }
            controller.handle(
                'Fetch.authRequired',
                {
                    requestId: 'old-auth',
                    request: { url: 'https://example.com/auth' },
                    authChallenge: { source: 'Server', origin: 'https://example.com', realm: 'owned' },
                },
                'session'
            );
            await flush();
            assert.equal(
                (await read(controller, 'network', 'paused')).logs.filter((p) => p.state === 'pending').length,
                2
            );
            assert.equal((await read(controller, 'network', 'auth')).logs[0].state, 'pending');
            assert.deepEqual(calls[1][1], {
                patterns: [{ urlPattern: 'https://example.com/new', requestStage: 'Request' }],
                handleAuthRequests: false,
            });
            if (outcome === 'success') {
                finish({});
            } else {
                fail(failure);
            }
            await result;
            assert.equal((await read(controller, 'network')).routes, 1);
            for (const name of ['old', 'new']) {
                await controller.rawFetch('Fetch.continueRequest', { requestId: name });
            }
            await controller.rawFetch('Fetch.continueWithAuth', {
                requestId: 'old-auth',
                authChallengeResponse: { response: 'CancelAuth' },
            });
            replacement = false;
            await controller.command('httpAuth', { op: 'clear' });
            const restored = calls.filter((call) => call[0] === 'Fetch.enable').at(-1)[1];
            assert.equal(
                restored.patterns[0].urlPattern,
                `https://example.com/${outcome === 'refused' ? 'old' : 'new'}`
            );
            assert.equal(restored.handleAuthRequests, outcome === 'refused');
        });
    }
});

test('raw and managed Fetch configurations serialize in their own request scopes', async (t) => {
    const storage = new AsyncLocalStorage();
    const scopes = [];
    let rejectFirst;
    const failure = new CDPError('Fetch.enable: Invalid parameters', {
        method: 'Fetch.enable',
        nativeCode: -32602,
        actionExecuted: false,
    });
    const { controller, calls } = fixture(async (method) => {
        if (method === 'Fetch.enable') {
            scopes.push(storage.getStore());
            if (scopes.length === 1) {
                return new Promise((_resolve, reject) => {
                    rejectFirst = reject;
                });
            }
        }
        return { nativeResult: storage.getStore() };
    });
    t.after(() => controller.dispose('test finished'));
    const first = storage.run('first', () =>
        controller.rawFetch('Fetch.enable', {
            patterns: [{ urlPattern: 'https://example.com/rejected' }],
            handleAuthRequests: true,
        })
    );
    const rejected = assert.rejects(first, (error) => error === failure);
    await flush();
    const managed = storage.run('managed', () =>
        controller.command('route', { op: 'add', urlPattern: 'https://example.com/managed' })
    );
    const auth = storage.run('auth', () =>
        controller.command('httpAuth', {
            op: 'set',
            scope: { source: 'Server', origin: 'https://example.com' },
            username: 'synthetic',
            password: 'synthetic',
        })
    );
    const download = storage.run('download', () =>
        controller.command('download', { op: 'watch', urlPattern: 'https://example.com/file' })
    );
    const second = storage.run('second', () =>
        controller.rawFetch('Fetch.enable', { patterns: [{ urlPattern: 'https://example.com/accepted' }] })
    );
    await flush();
    assert.equal(calls.filter((call) => call[0] === 'Fetch.enable').length, 1);
    rejectFirst(failure);
    await rejected;
    assert.equal((await managed).routes, 1);
    assert.deepEqual(await second, { nativeResult: 'second' });
    assert.equal((await auth).authConfigured, true);
    assert.equal((await download).downloadWatching, true);
    assert.deepEqual(scopes, ['first', 'managed', 'auth', 'download', 'second']);
    const config = calls.filter((call) => call[0] === 'Fetch.enable').at(-1)[1];
    assert.deepEqual(config.patterns, [
        { urlPattern: 'https://example.com/managed', requestStage: 'Request' },
        { urlPattern: 'https://example.com/accepted', requestStage: 'Request' },
        { urlPattern: 'https://example.com/file', requestStage: 'Response' },
        { urlPattern: '*', requestStage: 'Request' },
    ]);
    assert.equal(config.handleAuthRequests, true);
    assert.equal((await read(controller, 'network')).routes, 2);
});

test('Fetch suspension and disposal finish after in-flight configuration without restoring stopped state', async (t) => {
    for (const operation of ['suspend', 'dispose']) {
        for (const outcome of ['success', 'refused', 'unknown']) {
            await t.test(`${operation}/${outcome}`, async () => {
                let finish;
                let fail;
                const native = new Promise((resolve, reject) => {
                    finish = resolve;
                    fail = reject;
                });
                const failure = new CDPError('Fetch.enable: original native failure', {
                    method: 'Fetch.enable',
                    nativeCode: outcome === 'refused' ? -32602 : -32000,
                    actionExecuted: outcome === 'refused' ? false : 'unknown',
                    actionStatus: outcome === 'refused' ? 'not_started' : 'unknown',
                });
                const { controller, calls } = fixture((method) =>
                    method === 'Fetch.enable' ? native : Promise.resolve({})
                );
                const pending = controller.rawFetch('Fetch.enable', { handleAuthRequests: true });
                const result = outcome === 'success' ? pending : assert.rejects(pending, (error) => error === failure);
                await flush();
                const stop = controller[operation]('test lifecycle');
                let stopped = false;
                void stop.then(() => {
                    stopped = true;
                });
                await flush();
                assert.equal(stopped, false);
                assert.equal(
                    calls.some((call) => call[0] === 'Fetch.disable'),
                    false
                );
                if (outcome === 'success') {
                    finish({});
                } else {
                    fail(failure);
                }
                await result;
                const state = await stop;
                assert.equal(state.suspended, true);
                assert.equal(state.fetchEnabled, false);
                assert.equal(state.routes, 0);
                assert.equal(calls.filter((call) => call[0] === 'Fetch.disable').length, outcome === 'refused' ? 0 : 1);
                if (operation === 'dispose') {
                    await assert.rejects(controller.rawFetch('Fetch.enable'), /closed/);
                } else {
                    const restart = await controller.command('httpAuth', { op: 'clear' });
                    assert.equal(restart.fetchEnabled, false);
                    await controller.dispose('test finished');
                }
            });
        }
    }
});

test('raw Fetch distinguishes cancellation and transport failure before and after native dispatch', async (t) => {
    for (const source of ['budget', 'cancelled', 'transport']) {
        for (const dispatched of [false, true]) {
            await t.test(`${source}/${dispatched ? 'after' : 'before'}`, async (st) => {
                const abort = new AbortController();
                const scope = {
                    signal: abort.signal,
                    ...(source === 'budget' ? { deadline: Date.now() + (dispatched ? 50 : -1) } : {}),
                };
                if (source === 'cancelled' && !dispatched) {
                    abort.abort();
                }
                const client = new CDPClient(() => scope);
                let dispatches = 0;
                client.ws = {
                    readyState: source === 'transport' && !dispatched ? 3 : 1,
                    send() {
                        ++dispatches;
                    },
                    close() {},
                };
                const { controller } = fixture((method, params, sessionId) =>
                    method === 'Fetch.disable' ? Promise.resolve({}) : client.send(method, params, sessionId)
                );
                st.after(async () => {
                    await controller.dispose('test finished');
                    client.close();
                });
                const pending = controller.rawFetch('Fetch.enable', { handleAuthRequests: true });
                const rejected = assert.rejects(pending, (error) => {
                    assert.ok(error instanceof CDPError || getErrorSource(error) === 'budget');
                    assert.equal(getErrorSource(error), source);
                    assert.equal(error.context.actionExecuted, dispatched ? 'unknown' : false);
                    assert.equal(error.context.actionStatus, dispatched ? 'unknown' : 'not_started');
                    return true;
                });
                await flush();
                if (dispatched && source === 'cancelled') {
                    abort.abort();
                }
                if (dispatched && source === 'transport') {
                    client.close();
                }
                await rejected;
                assert.equal(dispatches, dispatched ? 1 : 0);
                const state = await read(controller, 'network');
                assert.equal(state.fetchEnabled, dispatched);
                assert.equal(state.routes, dispatched ? 1 : 0);
            });
        }
    }
});

test('queued managed Fetch configuration observes cancellation before changing state', async (t) => {
    let finish;
    const native = new Promise((resolve) => {
        finish = resolve;
    });
    const { controller, calls } = fixture((method) => (method === 'Fetch.enable' ? native : Promise.resolve({})));
    t.after(async () => {
        finish({});
        await controller.dispose('test finished');
    });
    const pending = controller.rawFetch('Fetch.enable');
    await flush();
    const abort = new AbortController();
    const reason = Error('owned queued request cancelled');
    const rejected = [
        ['route', { op: 'add', urlPattern: '*' }],
        [
            'httpAuth',
            {
                op: 'set',
                scope: { source: 'Server', origin: 'https://example.com' },
                username: 'synthetic',
                password: 'synthetic',
            },
        ],
        ['download', { op: 'watch' }],
    ].map(([action, command]) =>
        assert.rejects(controller.command(action, command, abort.signal), (error) => error === reason)
    );
    abort.abort(reason);
    finish({});
    await pending;
    await Promise.all(rejected);
    const state = await read(controller, 'network');
    assert.equal(state.routes, 1);
    assert.equal(state.authConfigured, false);
    assert.equal(state.downloadWatching, false);
    assert.equal(calls.length, 1);
});

test('Fetch disposal rejects queued configuration and retains idempotent cleanup', async () => {
    let finish;
    const native = new Promise((resolve) => {
        finish = resolve;
    });
    const { controller, calls } = fixture((method) => (method === 'Fetch.enable' ? native : Promise.resolve({})));
    const pending = controller.rawFetch('Fetch.enable');
    await flush();
    const disposal = controller.dispose('test lifecycle');
    const rejected = [
        () => controller.command('route', { op: 'add', urlPattern: '*' }),
        () =>
            controller.command('httpAuth', {
                op: 'set',
                scope: { source: 'Server', origin: 'https://example.com' },
                username: 'synthetic',
                password: 'synthetic',
            }),
        () => controller.command('download', { op: 'watch' }),
        () => controller.rawFetch('Fetch.enable'),
    ].map((operation) => assert.rejects(operation(), /closed/));
    finish({});
    await pending;
    assert.equal((await disposal).suspended, true);
    await Promise.all(rejected);
    assert.deepEqual(
        calls.map((call) => call[0]),
        ['Fetch.enable', 'Fetch.disable']
    );
    assert.equal((await controller.suspend('already disposed')).suspended, true);
    assert.equal((await controller.dispose('already disposed')).suspended, true);
});

test('raw Fetch restores configuration when its request scope refuses the final dispatch', async (t) => {
    for (const method of ['Fetch.enable', 'Fetch.disable']) {
        await t.test(method, async (st) => {
            const { controller, calls } = fixture();
            st.after(() => controller.dispose('test finished'));
            await controller.rawFetch('Fetch.enable', {
                patterns: [{ urlPattern: 'https://example.com/prior' }],
                handleAuthRequests: true,
            });
            let checks = 0;
            const failure = Object.assign(Error('owned request expired before native dispatch'), {
                actionExecuted: false,
            });
            await assert.rejects(
                controller.rawFetch(method, { patterns: [] }, () => {
                    if (++checks === 3) {
                        throw failure;
                    }
                }),
                (error) => error === failure
            );
            assert.equal(calls.length, 1);
            const state = await read(controller, 'network');
            assert.equal(state.routes, 1);
            assert.equal(state.fetchEnabled, true);
            await controller.command('httpAuth', { op: 'clear' });
            assert.equal(calls.at(-1)[1].patterns[0].urlPattern, 'https://example.com/prior');
            assert.equal(calls.at(-1)[1].handleAuthRequests, true);
        });
    }
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

test('stream URL filters follow the recorded parent request without changing stream entries', async (t) => {
    for (const backend of ['cdp', 'extension']) {
        for (const method of [
            'Network.eventSourceMessageReceived',
            'Network.webSocketWillSendHandshakeRequest',
            'Network.webSocketFrameSent',
            'Network.webSocketFrameReceived',
        ]) {
            await t.test(`${backend} ${method}`, async (context) => {
                const { controller, calls } = fixture(undefined, { backend });
                context.after(() => controller.dispose('test finished'));
                await controller.command('networkCapture', { op: 'start', include: ['stream'] });
                const sse = method === 'Network.eventSourceMessageReceived';
                const endpoint = sse ? 'sse' : 'ws';
                begin(controller, 'owned-stream', {
                    request: {
                        url: `${sse ? 'https' : 'wss'}://stream-user:stream-password@example.com/${endpoint}`,
                        method: 'GET',
                        headers: { Authorization: 'stream-auth-secret' },
                    },
                });
                const parent = (await read(controller, 'network', 'details')).logs[0];
                controller.handle(
                    method,
                    {
                        requestId: 'owned-stream',
                        ...(sse
                            ? { data: 'mcp_test_event', eventName: 'message', eventId: '' }
                            : { response: { opcode: 1, payloadData: 'mcp_test_event' } }),
                    },
                    'session'
                );
                const all = await read(controller, 'network', 'stream');
                assert.equal(all.count, 1);
                assert.equal(all.logs[0].requestRef, parent.ref);
                const beforeReads = calls.length;
                const options = { type: 'network', view: 'stream', urlPattern: `*/${endpoint}` };
                const filtered = await controller.command('read', options);
                assert.equal(filtered.count, 1);
                assert.equal(filtered.totalBuffered, 1);
                assert.deepEqual(filtered.logs, all.logs);
                begin(controller, 'owned-stream', {
                    request: { url: 'https://example.com/redirected', method: 'GET' },
                    redirectResponse: { status: 302 },
                });
                assert.deepEqual((await controller.command('read', options)).logs, all.logs);
                assert.equal((await controller.command('read', { ...options, urlPattern: '*/redirected' })).count, 0);
                assert.deepEqual((await read(controller, 'network', 'stream')).logs, all.logs);
                assert.equal((await controller.command('read', { ...options, ref: all.logs[0].ref })).count, 1);
                assert.equal((await controller.command('read', { ...options, urlPattern: '*/other' })).count, 0);
                const serialized = JSON.stringify(filtered);
                for (const secret of ['stream-user', 'stream-password', 'stream-auth-secret']) {
                    assert.equal(serialized.includes(secret), false);
                }
                assert.equal((await controller.command('read', { ...options, clear: true })).count, 1);
                assert.equal((await read(controller, 'network', 'stream')).count, 0);
                assert.equal((await read(controller, 'network', 'details', parent.ref)).count, 1);
                await assert.rejects(read(controller, 'network', 'stream', all.logs[0].ref), /expired, evicted/);
                assert.equal(calls.length, beforeReads);
            });
        }
    }
});

test('stream URL filters preserve request session and hop ownership after parent invalidation', async (t) => {
    for (const backend of ['cdp', 'extension']) {
        for (const invalidation of ['clear', 'expiry']) {
            await t.test(`${backend} ${invalidation}`, async (context) => {
                const { controller } = fixture(undefined, { backend });
                context.after(() => controller.dispose('test finished'));
                await controller.command('networkCapture', { op: 'start', include: ['stream'] });
                for (const sessionId of ['frame-a', 'frame-b']) {
                    controller.handle(
                        'Network.requestWillBeSent',
                        {
                            requestId: 'same-request-id',
                            request: { url: `https://example.com/${sessionId}/sse`, method: 'GET' },
                        },
                        sessionId
                    );
                    controller.handle(
                        'Network.eventSourceMessageReceived',
                        {
                            requestId: 'same-request-id',
                            data: sessionId,
                        },
                        sessionId
                    );
                }
                const parents = (await read(controller, 'network', 'details')).logs;
                const parentA = parents.find((entry) => entry.sessionId === 'frame-a');
                const streams = (await read(controller, 'network', 'stream')).logs;
                const oldStreamA = streams.find((entry) => entry.sessionId === 'frame-a');
                if (invalidation === 'clear') {
                    await read(controller, 'network', 'details', parentA.ref, true);
                } else {
                    controller.entries.get(parentA.ref).timestamp = Date.now() - 300001;
                }
                assert.deepEqual((await read(controller, 'network', 'stream')).logs, streams);
                await assert.rejects(read(controller, 'network', 'details', parentA.ref), /expired, evicted/);
                controller.handle(
                    'Network.requestWillBeSent',
                    {
                        requestId: 'same-request-id',
                        request: { url: 'https://example.com/reused/sse', method: 'GET' },
                    },
                    'frame-a'
                );
                controller.handle(
                    'Network.eventSourceMessageReceived',
                    {
                        requestId: 'same-request-id',
                        data: 'reused',
                    },
                    'frame-a'
                );
                const all = await read(controller, 'network', 'stream');
                assert.equal(all.count, 3);
                const options = { type: 'network', view: 'stream' };
                assert.equal((await controller.command('read', { ...options, urlPattern: '*frame-a/sse' })).count, 0);
                const sibling = await controller.command('read', { ...options, urlPattern: '*frame-b/sse' });
                assert.equal(sibling.count, 1);
                assert.equal(sibling.logs[0].sessionId, 'frame-b');
                const reused = await controller.command('read', { ...options, urlPattern: '*reused/sse' });
                assert.equal(reused.count, 1);
                assert.equal(reused.logs[0].data, 'reused');
                assert.notEqual(reused.logs[0].requestRef, oldStreamA.requestRef);
                assert.equal((await controller.command('read', { ...options, urlPattern: '*' })).count, 2);
                assert.equal((await read(controller, 'network', 'stream', oldStreamA.ref)).count, 1);
                assert.equal(
                    (
                        await controller.command('read', {
                            ...options,
                            ref: oldStreamA.ref,
                            urlPattern: '*reused/sse',
                        })
                    ).count,
                    0
                );
            });
        }
    }
});

test('stream URL filters leave unobserved parent URLs unmatched and retain direct WebSocket URLs', async (t) => {
    for (const backend of ['cdp', 'extension']) {
        await t.test(backend, async (context) => {
            const { controller } = fixture(undefined, { backend });
            context.after(() => controller.dispose('test finished'));
            await controller.command('networkCapture', { op: 'start', include: ['stream'] });
            controller.handle(
                'Network.eventSourceMessageReceived',
                { requestId: 'missing-sse', data: 'unknown' },
                'session'
            );
            controller.handle(
                'Network.webSocketFrameReceived',
                {
                    requestId: 'missing-ws',
                    response: { opcode: 1, payloadData: 'unknown' },
                },
                'session'
            );
            controller.handle(
                'Network.webSocketCreated',
                { requestId: 'direct-ws', url: 'wss://example.com/ws' },
                'session'
            );
            const all = await read(controller, 'network', 'stream');
            assert.equal(all.count, 3);
            const selected = await controller.command('read', { type: 'network', view: 'stream', urlPattern: '*' });
            assert.equal(selected.count, 1);
            assert.equal(selected.logs[0].nativeMethod, 'Network.webSocketCreated');
            assert.equal(
                (await controller.command('read', { type: 'network', view: 'stream', urlPattern: '*/ws' })).count,
                1
            );
            assert.deepEqual((await read(controller, 'network', 'stream')).logs, all.logs);
        });
    }
});

test('WebSocket stream URL filters pin observed socket URLs across sessions and ID reuse', async (t) => {
    for (const backend of ['cdp', 'extension']) {
        for (const withParent of [false, true]) {
            await t.test(`${backend} HTTP parent=${withParent}`, async (context) => {
                const { controller, calls } = fixture(undefined, { backend });
                context.after(() => controller.dispose('test finished'));
                await controller.command('networkCapture', { op: 'start', include: ['stream'] });
                if (withParent) {
                    begin(controller, 'socket', { request: { url: 'wss://example.com/first', method: 'GET' } });
                }
                const parent = (await read(controller, 'network', 'details')).logs[0];
                controller.handle(
                    'Network.webSocketCreated',
                    { requestId: 'socket', url: 'wss://example.com/first' },
                    'session'
                );
                controller.handle(
                    'Network.webSocketFrameSent',
                    { requestId: 'socket', response: { opcode: 1, payloadData: 'first' } },
                    'session'
                );
                controller.handle(
                    'Network.webSocketCreated',
                    { requestId: 'socket', url: 'wss://example.com/sibling' },
                    'sibling'
                );
                controller.handle(
                    'Network.webSocketFrameReceived',
                    { requestId: 'socket', response: { opcode: 1, payloadData: 'sibling' } },
                    'sibling'
                );
                begin(controller, 'socket', { request: { url: 'https://example.com/later-request', method: 'GET' } });
                controller.handle(
                    'Network.webSocketFrameReceived',
                    { requestId: 'socket', response: { opcode: 1, payloadData: 'still-first' } },
                    'session'
                );
                controller.handle('Network.webSocketClosed', { requestId: 'socket' }, 'session');
                controller.handle(
                    'Network.webSocketCreated',
                    { requestId: 'socket', url: 'wss://example.com/reused' },
                    'session'
                );
                controller.handle(
                    'Network.webSocketFrameReceived',
                    { requestId: 'socket', response: { opcode: 1, payloadData: 'reused' } },
                    'session'
                );
                const all = await read(controller, 'network', 'stream');
                const beforeReads = calls.length;
                const options = { type: 'network', view: 'stream' };
                const first = await controller.command('read', { ...options, urlPattern: '*/first' });
                assert.equal(first.count, 4);
                assert.ok(first.logs.every((entry) => entry.sessionId === 'session'));
                assert.ok(first.logs.every((entry) => entry.requestRef === parent?.ref));
                assert.equal((await controller.command('read', { ...options, urlPattern: '*/sibling' })).count, 2);
                const reused = await controller.command('read', { ...options, urlPattern: '*/reused' });
                assert.equal(reused.count, 2);
                assert.ok(reused.logs.every((entry) => entry.requestRef === undefined));
                assert.equal(
                    (await controller.command('read', { ...options, urlPattern: '*/later-request' })).count,
                    0
                );
                const oldFrame = first.logs.find((entry) => entry.nativeMethod === 'Network.webSocketFrameSent');
                assert.equal(
                    (await controller.command('read', { ...options, ref: oldFrame.ref, urlPattern: '*/reused' })).count,
                    0
                );
                assert.deepEqual((await read(controller, 'network', 'stream')).logs, all.logs);
                assert.equal(calls.length, beforeReads);
            });
        }
    }
});

test('same-session child frame navigation preserves unrelated WebSocket stream URLs', async (t) => {
    for (const backend of ['cdp', 'extension']) {
        await t.test(backend, async (context) => {
            const { controller } = fixture(undefined, { backend });
            context.after(() => controller.dispose('test finished'));
            await controller.command('networkCapture', { op: 'start', include: ['stream'] });
            const owners = [
                ['main-a', 'session'],
                ['main-b', 'session'],
                ['child', 'child'],
                ['sibling', 'sibling'],
            ];
            for (const [requestId, sessionId] of owners) {
                controller.handle(
                    'Network.webSocketCreated',
                    { requestId, url: `wss://example.com/${requestId}` },
                    sessionId
                );
            }
            for (const [index, navigation] of [
                {
                    sessionId: 'session',
                    frame: { id: 'same-process-child', parentId: 'main' },
                    retained: ['main-a', 'main-b', 'child', 'sibling'],
                },
                {
                    sessionId: 'child',
                    frame: { id: 'oopif-root', parentId: 'main' },
                    retained: ['main-a', 'main-b', 'sibling'],
                },
                { sessionId: 'session', frame: { id: 'main' }, retained: [] },
            ].entries()) {
                controller.handle('Page.frameNavigated', { frame: navigation.frame }, navigation.sessionId);
                for (const [requestId, sessionId] of owners) {
                    controller.handle(
                        'Network.webSocketFrameReceived',
                        {
                            requestId,
                            response: { opcode: 1, payloadData: `${index}:${requestId}` },
                        },
                        sessionId
                    );
                }
                const all = await read(controller, 'network', 'stream');
                for (const [requestId] of owners) {
                    const entry = all.logs.find((item) => item.response?.payloadData === `${index}:${requestId}`);
                    assert.ok(entry);
                    const filtered = await controller.command('read', {
                        type: 'network',
                        view: 'stream',
                        ref: entry.ref,
                        urlPattern: `*/${requestId}`,
                    });
                    assert.equal(
                        filtered.count,
                        navigation.retained.includes(requestId) ? 1 : 0,
                        `${backend} navigation=${index} socket=${requestId}`
                    );
                }
            }
        });
    }
});

test('WebSocket stream URL associations end on close, navigation and capture boundaries', async (t) => {
    for (const backend of ['cdp', 'extension']) {
        for (const boundary of ['close', 'navigation', 'child-navigation', 'stop', 'replace-capture', 'suspend']) {
            await t.test(`${backend} ${boundary}`, async (context) => {
                const { controller } = fixture(undefined, { backend });
                context.after(() => controller.dispose('test finished'));
                await controller.command('networkCapture', { op: 'start', include: ['stream'] });
                const sessionId = boundary === 'child-navigation' ? 'child' : 'session';
                controller.handle(
                    'Network.webSocketCreated',
                    { requestId: 'socket', url: 'wss://example.com/old' },
                    sessionId
                );
                controller.handle(
                    'Network.webSocketFrameSent',
                    { requestId: 'socket', response: { opcode: 1, payloadData: 'old' } },
                    sessionId
                );
                controller.handle(
                    'Network.webSocketCreated',
                    { requestId: 'socket', url: 'wss://example.com/sibling' },
                    'sibling'
                );
                const oldFrame = (await read(controller, 'network', 'stream')).logs.find(
                    (entry) => entry.nativeMethod === 'Network.webSocketFrameSent'
                );
                if (boundary === 'close') {
                    controller.handle('Network.webSocketClosed', { requestId: 'socket' }, sessionId);
                } else if (boundary === 'navigation' || boundary === 'child-navigation') {
                    const frame =
                        boundary === 'child-navigation' ? { id: 'navigated', parentId: 'main' } : { id: 'navigated' };
                    controller.handle('Page.frameNavigated', { frame }, sessionId);
                } else if (boundary === 'suspend') {
                    await controller.suspend('test stream boundary');
                } else if (boundary === 'replace-capture') {
                    await controller.command('networkCapture', { op: 'start', include: ['body'] });
                } else {
                    await controller.command('networkCapture', { op: 'stop' });
                }
                if (['stop', 'replace-capture', 'suspend'].includes(boundary)) {
                    controller.handle(
                        'Network.webSocketCreated',
                        { requestId: 'socket', url: 'wss://example.com/not-captured' },
                        sessionId
                    );
                    await controller.command('networkCapture', { op: 'start', include: ['stream'] });
                }
                controller.handle(
                    'Network.webSocketFrameReceived',
                    { requestId: 'socket', response: { opcode: 1, payloadData: 'after-boundary' } },
                    sessionId
                );
                controller.handle(
                    'Network.webSocketFrameReceived',
                    { requestId: 'socket', response: { opcode: 1, payloadData: 'sibling-after' } },
                    'sibling'
                );
                const after = (await read(controller, 'network', 'stream')).logs;
                const unbound = after.find((entry) => entry.response?.payloadData === 'after-boundary');
                const sibling = after.find((entry) => entry.response?.payloadData === 'sibling-after');
                const options = { type: 'network', view: 'stream' };
                assert.equal(
                    (await controller.command('read', { ...options, ref: unbound.ref, urlPattern: '*' })).count,
                    0
                );
                assert.equal(
                    (await controller.command('read', { ...options, ref: sibling.ref, urlPattern: '*/sibling' })).count,
                    boundary === 'close' || boundary === 'child-navigation' ? 1 : 0
                );
                assert.equal(
                    (await controller.command('read', { ...options, ref: oldFrame.ref, urlPattern: '*/old' })).count,
                    1
                );
                controller.handle(
                    'Network.webSocketCreated',
                    { requestId: 'socket', url: 'wss://example.com/new' },
                    sessionId
                );
                controller.handle(
                    'Network.webSocketFrameReceived',
                    { requestId: 'socket', response: { opcode: 1, payloadData: 'new' } },
                    sessionId
                );
                const fresh = await controller.command('read', { ...options, urlPattern: '*/new' });
                assert.equal(fresh.count, 2);
                assert.equal(
                    (await controller.command('read', { ...options, ref: unbound.ref, urlPattern: '*/new' })).count,
                    0
                );
            });
        }
    }
});

test('WebSocket stream URL filters keep invalid socket refs separate from later HTTP requests', async (t) => {
    for (const backend of ['cdp', 'extension']) {
        for (const invalidation of ['clear', 'expiry']) {
            await t.test(`${backend} ${invalidation}`, async (context) => {
                const { controller } = fixture(undefined, { backend });
                context.after(() => controller.dispose('test finished'));
                await controller.command('networkCapture', { op: 'start', include: ['stream'] });
                controller.handle(
                    'Network.webSocketCreated',
                    { requestId: 'socket', url: 'wss://example.com/old' },
                    'session'
                );
                controller.handle(
                    'Network.webSocketFrameSent',
                    { requestId: 'socket', response: { opcode: 1, payloadData: 'old' } },
                    'session'
                );
                const original = (await read(controller, 'network', 'stream')).logs;
                const created = original.find((entry) => entry.nativeMethod === 'Network.webSocketCreated');
                const oldFrame = original.find((entry) => entry.nativeMethod === 'Network.webSocketFrameSent');
                if (invalidation === 'clear') {
                    await read(controller, 'network', 'stream', created.ref, true);
                } else {
                    controller.entries.get(created.ref).timestamp = Date.now() - 300001;
                }
                await read(controller, 'network', 'stream');
                await assert.rejects(read(controller, 'network', 'stream', created.ref), /expired, evicted/);
                begin(controller, 'socket', { request: { url: 'https://example.com/later-request', method: 'GET' } });
                controller.handle(
                    'Network.webSocketFrameReceived',
                    { requestId: 'socket', response: { opcode: 1, payloadData: 'without-source' } },
                    'session'
                );
                const options = { type: 'network', view: 'stream' };
                const unknown = await controller.command('read', options);
                assert.equal(unknown.count, 2);
                assert.ok(unknown.logs.every((entry) => entry.requestRef === undefined));
                assert.equal((await controller.command('read', { ...options, urlPattern: '*' })).count, 0);
                controller.handle(
                    'Network.webSocketCreated',
                    { requestId: 'socket', url: 'wss://example.com/reused' },
                    'session'
                );
                controller.handle(
                    'Network.webSocketFrameReceived',
                    { requestId: 'socket', response: { opcode: 1, payloadData: 'reused' } },
                    'session'
                );
                assert.equal((await controller.command('read', { ...options, urlPattern: '*/reused' })).count, 2);
                assert.equal(
                    (await controller.command('read', { ...options, ref: oldFrame.ref, urlPattern: '*/reused' })).count,
                    0
                );
            });
        }
    }
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

test('M16-C04 cancelled attachment bytes cannot become a later same-URL download', async (t) => {
    let finishBody;
    const url = 'https://example.com/api';
    const { controller, calls } = fixture(async (method) =>
        method === 'Fetch.getResponseBody'
            ? new Promise((resolve) => {
                  finishBody = resolve;
              })
            : {}
    );
    t.after(() => controller.dispose('owned test finished'));
    await controller.command('download', { op: 'watch', urlPattern: url });
    paused(controller, 'old-download', {
        responseStatusCode: 200,
        responseHeaders: [{ name: 'Content-Disposition', value: 'attachment' }],
    });
    await flush();
    const stop = controller.command('download', { op: 'stop' });
    finishBody({ body: 'OLD cancelled file', base64Encoded: false });
    await stop;
    assert.ok(calls.some(([method, params]) => method === 'Fetch.failRequest' && params.requestId === 'old-download'));
    await controller.command('download', { op: 'watch', urlPattern: url });
    await controller.command('route', { op: 'add', stage: 'Response', urlPattern: url });
    paused(controller, 'new-download', {
        responseStatusCode: 200,
        responseHeaders: [{ name: 'Content-Disposition', value: 'attachment' }],
    });
    await flush();
    const pause = (await read(controller, 'network', 'paused')).logs[0];
    await controller.command('route', { op: 'continue', ref: pause.ref });
    controller.handle('Page.downloadWillBegin', { guid: 'new-file-guid', frameId: 'frame', url }, 'session');
    controller.handle('Page.downloadProgress', { guid: 'new-file-guid', state: 'completed' }, 'session');
    const download = (await read(controller, 'download')).logs[0];
    assert.equal(download.artifact, 'unavailable');
    await assert.rejects(
        controller.command('download', { op: 'save', ref: download.ref }),
        /unavailable|expired|evicted/i
    );
});

for (const invalidation of ['watch', 'navigation', 'frame-navigation']) {
    test(`M16-C04 unbound response identity expires on ${invalidation}`, async (t) => {
        const { controller } = fixture(async (method) =>
            method === 'Fetch.getResponseBody' ? { body: 'owned old bytes', base64Encoded: false } : {}
        );
        t.after(() => controller.dispose('owned test finished'));
        await controller.command('download', { op: 'watch' });
        paused(controller, 'old-download', {
            responseStatusCode: 200,
            responseHeaders: [{ name: 'Content-Disposition', value: 'attachment' }],
        });
        await flush();
        if (invalidation === 'watch') {
            await controller.command('download', { op: 'watch' });
        } else {
            controller.handle(
                'Page.frameNavigated',
                { frame: { id: 'frame', ...(invalidation === 'frame-navigation' ? { parentId: 'root' } : {}) } },
                'session'
            );
            await flush();
        }
        controller.handle(
            'Page.downloadWillBegin',
            { guid: 'later-guid', frameId: 'frame', url: 'https://example.com/api' },
            'session'
        );
        const download = (await read(controller, 'download')).logs[0];
        assert.equal(download.artifact, 'unavailable');
    });
}

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

test('expired native interception identities release every pause path and allow later Fetch setup', async (t) => {
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

test('native expiry distinguishes validation refusals, lost acknowledgements and page errors', async (t) => {
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
