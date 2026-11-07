import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CDPClient } from '../dist/cdp/client.js';
import { getSession } from '../dist/core/session.js';
import { getUnifiedSession } from '../dist/core/unified-session.js';
import { ExtensionBridge } from '../dist/extension/bridge.js';
import { registerCookiesTool } from '../dist/tools/cookies.js';

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function patch(object, values) {
    const saved = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(object, key)]));
    Object.assign(object, values);
    return () => {
        for (const [key, descriptor] of saved) {
            if (descriptor) {
                Object.defineProperty(object, key, descriptor);
            } else {
                Reflect.deleteProperty(object, key);
            }
        }
    };
}

function compile(source, imports, globals = {}) {
    const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports = {};
    vm.runInNewContext(`(function(require,exports){${output}\n})`, { Error, console, ...globals })((name) => {
        assert.ok(Object.hasOwn(imports, name), name);
        return imports[name];
    }, exports);
    return exports;
}

function extensionCookies(chrome) {
    const source = (file) => readFileSync(new URL(`../extension/src/${file}.ts`, import.meta.url), 'utf8');
    const errors = compile(source('types/expected-errors'), {});
    const schemas = compile(source('types/schemas'), { zod: { z } });
    const text = source('background/action-utils');
    const ast = ts.createSourceFile('action-utils.ts', text, ts.ScriptTarget.Latest, true);
    const guard = ast.statements.find(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'assertActionActive'
    );
    assert.ok(guard);
    const active = compile(guard.getText(ast), {}, errors).assertActionActive;
    const utils = {
        assertActionActive: active,
        assertManagedTab: async () => ({}),
        assertReadableTab: async () => ({}),
    };
    const { CookieHandler } = compile(
        source('background/cookie-handler'),
        {
            '../types/expected-errors': errors,
            '../types/schemas': schemas,
            './action-utils': utils,
        },
        { chrome }
    );
    return new CookieHandler();
}

async function withProtocol(backend, options, run) {
    const unified = getUnifiedSession();
    const session = getSession();
    const calls = [];
    const wire = [];
    const state = {
        cookies: ['first', 'second', 'third'].map((name) => ({
            name,
            value: 'synthetic',
            domain: 'example.com',
            path: '/',
            storeId: '0',
            secure: false,
            httpOnly: false,
        })),
        deletes: 0,
        attaches: 0,
        sessions: new Set(['owned-session']),
        held: deferred(),
        serverAborted: deferred(),
        extensionAborted: deferred(),
        handlerDone: deferred(),
        consumerDone: deferred(),
        scopes: [],
    };
    let acknowledge;
    const nativeReply = (client, command, result) =>
        client.handleMessage(Buffer.from(JSON.stringify({ id: command.id, result })));
    const cdp = new CDPClient(() => session.requestContext?.());
    cdp.ws = {
        readyState: 1,
        close() {},
        send(text) {
            const command = JSON.parse(text);
            calls.push({ ...command, aborted: state.serverSignal?.aborted === true });
            state.scopes.push(session.requestContext?.()?.signal);
            globalThis.queueMicrotask(() => {
                if (command.method === 'Target.getTargetInfo') {
                    nativeReply(cdp, command, { targetInfo: { targetId: 'page', browserContextId: 'owned' } });
                } else if (command.method === 'Target.attachToTarget') {
                    ++state.attaches;
                    if (options.rejectAttach) {
                        cdp.handleMessage(
                            Buffer.from(
                                JSON.stringify({
                                    id: command.id,
                                    error: { code: -32000, message: 'Synthetic attach rejected' },
                                })
                            )
                        );
                        return;
                    }
                    state.sessions.add('owned-temporary');
                    if (options.cancelAttachAt === state.attaches) {
                        acknowledge = () => nativeReply(cdp, command, { sessionId: 'owned-temporary' });
                        state.held.resolve();
                    } else {
                        nativeReply(cdp, command, { sessionId: 'owned-temporary' });
                    }
                } else if (command.method === 'Target.detachFromTarget') {
                    if (options.holdDetach) {
                        return;
                    }
                    if (options.rejectDetach) {
                        cdp.handleMessage(
                            Buffer.from(
                                JSON.stringify({
                                    id: command.id,
                                    error: { code: -32000, message: 'Synthetic detach rejected' },
                                })
                            )
                        );
                    } else {
                        state.sessions.delete(command.params.sessionId);
                        nativeReply(cdp, command, {});
                    }
                } else if (command.method === 'Storage.getCookies') {
                    nativeReply(cdp, command, { cookies: state.cookies.map((cookie) => ({ ...cookie })) });
                } else if (command.method === 'Network.deleteCookies') {
                    ++state.deletes;
                    state.cookies = state.cookies.filter((cookie) => cookie.name !== command.params.name);
                    if (state.deletes === options.cancelAt) {
                        acknowledge = () => nativeReply(cdp, command, {});
                        state.held.resolve();
                    } else {
                        nativeReply(cdp, command, {});
                    }
                } else {
                    assert.fail(command.method);
                }
            });
        },
    };
    const controllers = new Map();
    const chrome = {
        cookies: {
            getAllCookieStores: async () => [{ id: '0', tabIds: [101] }],
            getAll: async () => state.cookies.map((cookie) => ({ ...cookie })),
            remove: async ({ name }) => {
                calls.push({ method: 'chrome.cookies.remove', name, aborted: state.serverSignal?.aborted === true });
                ++state.deletes;
                state.cookies = state.cookies.filter((cookie) => cookie.name !== name);
                if (state.deletes === options.cancelAt) {
                    const ack = deferred();
                    acknowledge = ack.resolve;
                    state.held.resolve();
                    await ack.promise;
                }
                return { name };
            },
        },
    };
    const consumer = extensionCookies(chrome);
    const bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() });
    bridge.httpServer.helloReceived = true;
    bridge.httpServer.clientSocket = {
        readyState: 1,
        send(text) {
            const message = JSON.parse(text);
            wire.push(message);
            if (message.type === 'cancel') {
                controllers.get(message.id)?.abort('transport cancellation');
                state.extensionAborted.resolve();
                return;
            }
            const controller = new AbortController();
            controllers.set(message.id, controller);
            state.scopes.push(unified.tabLockContext.getStore()?.signal);
            assert.equal(message.action, 'cookies_clear');
            void consumer
                .cookiesClear(message.params, {
                    signal: controller.signal,
                    deadline: message.params.deadline,
                    mcpTabGroupId: null,
                    mcpWindowId: null,
                })
                .then(
                    (data) => {
                        bridge.httpServer.handleMessage(JSON.stringify({ id: message.id, success: true, data }));
                        state.consumerResult = data;
                    },
                    (error) => {
                        bridge.httpServer.handleMessage(
                            JSON.stringify({ id: message.id, success: false, error: error.message })
                        );
                        state.consumerError = error;
                    }
                )
                .finally(() => {
                    controllers.delete(message.id);
                    state.consumerDone.resolve();
                });
        },
    };
    const restores = [
        patch(session, {
            cdp,
            sessionId: 'owned-session',
            currentTargetId: 'page',
            targetSessions: options.temporary ? new Map() : new Map([['page', 'owned-session']]),
            state: { url: 'https://example.com/' },
        }),
        patch(unified, {
            extensionBridge: backend === 'extension' ? bridge : null,
            activeMode: backend,
            cdpExplicitlySelected: backend === 'cdp',
        }),
    ];
    const server = new McpServer({ name: 'cookie-protocol-regression', version: '1.0.0' });
    const register = server.registerTool.bind(server);
    let direct;
    let schema;
    server.registerTool = (name, config, handler) => {
        direct = handler;
        schema = config.inputSchema;
        return register(name, config, async (args, extra) => {
            state.serverSignal = extra.signal;
            state.requestId = extra.requestId;
            extra.signal.addEventListener('abort', state.serverAborted.resolve, { once: true });
            const result = await handler(args, extra);
            state.handlerResult = JSON.parse(result.content[0].text);
            state.handlerDone.resolve();
            return result;
        });
    };
    registerCookiesTool(server);
    const client = new Client({ name: 'cookie-protocol-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const responses = [];
    const send = serverTransport.send.bind(serverTransport);
    serverTransport.send = (message, ...args) => {
        responses.push(message);
        return send(message, ...args);
    };
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const args = { action: 'clear', domain: 'example.com', targetId: backend === 'cdp' ? 'page' : '101' };
    state.releaseAck = () => acknowledge?.();
    try {
        await run({
            state,
            calls,
            wire,
            client,
            args,
            responses,
            direct: (signal) => direct(schema.parse(args), { signal }),
            cdp,
        });
    } finally {
        acknowledge?.();
        await client.close();
        await server.close();
        cdp.close();
        for (const restore of restores.reverse()) {
            restore();
        }
    }
}

for (const backend of ['cdp', 'extension']) {
    test(
        `C31F2-01 ${backend} SDK normal clear preserves production driver and request context`,
        { timeout: 10000 },
        async () => {
            await withProtocol(backend, {}, async ({ client, args, state }) => {
                const response = await client.callTool({ name: 'cookies', arguments: args });
                const body = JSON.parse(response.content[0].text);
                assert.equal(body.count, 3);
                assert.equal(state.cookies.length, 0);
                assert.ok(state.scopes.length > 0);
                assert.ok(state.scopes.every((signal) => signal === state.serverSignal));
            });
        }
    );
    for (const cancelAt of [1, 2]) {
        test(
            `C31F2-01 ${backend} actual SDK cancellation before ACK ${cancelAt} prevents later deletion`,
            { timeout: 10000 },
            async () => {
                await withProtocol(backend, { cancelAt }, async ({ state, client, args, calls, wire, responses }) => {
                    const controller = new AbortController();
                    const request = client.callTool({ name: 'cookies', arguments: args }, undefined, {
                        signal: controller.signal,
                    });
                    const rejected = assert.rejects(request);
                    await state.held.promise;
                    controller.abort('stop synthetic clear');
                    await state.serverAborted.promise;
                    assert.equal(state.serverSignal.aborted, true);
                    if (backend === 'extension') {
                        await state.extensionAborted.promise;
                        assert.equal(wire.filter((message) => message.type === 'cancel').length, 1);
                    }
                    state.releaseAck();
                    await state.handlerDone.promise;
                    await rejected;
                    if (backend === 'extension') {
                        await state.consumerDone.promise;
                        assert.equal(JSON.parse(state.consumerError.message).error.code, 'COOKIE_CLEAR_PARTIAL');
                        assert.equal(JSON.parse(state.consumerError.message).error.context.count, cancelAt);
                    } else {
                        const progress = state.handlerResult.error.context;
                        assert.equal(progress.count, cancelAt - 1);
                        assert.equal(progress.acknowledged, cancelAt - 1);
                        assert.equal(progress.unknown, 1);
                        assert.equal(progress.unprocessed, 3 - cancelAt);
                        assert.equal(progress.actionStatus, cancelAt === 1 ? 'unknown' : 'partial');
                        assert.equal(progress.retryable, false);
                    }
                    assert.equal(state.deletes, cancelAt);
                    assert.equal(state.cookies.length, 3 - cancelAt);
                    assert.equal(
                        calls.filter((call) => /deleteCookies|cookies.remove/.test(call.method) && call.aborted).length,
                        0
                    );
                    assert.equal(responses.filter((message) => message.id === state.requestId).length, 0);
                    assert.ok(state.scopes.every((signal) => signal === state.serverSignal));
                });
            }
        );
    }
    test(`C31F2-01 ${backend} already cancelled public extra.signal rejects before driver or API dispatch`, async () => {
        await withProtocol(backend, {}, async ({ direct, calls, wire }) => {
            const controller = new AbortController();
            controller.abort('cancel before dispatch');
            const response = await direct(controller.signal);
            const body = JSON.parse(response.content[0].text);
            assert.equal(body.error.code, 'CANCELLED');
            assert.equal(body.error.context.actionStatus, 'not_started');
            assert.equal(calls.length, 0);
            assert.equal(wire.length, 0);
        });
    });
}

test(
    'C31F2-01 cancellation still detaches only the temporary CDP session owned by this clear',
    { timeout: 10000 },
    async () => {
        await withProtocol('cdp', { cancelAt: 1, temporary: true }, async ({ client, args, state, calls }) => {
            const controller = new AbortController();
            const request = client.callTool({ name: 'cookies', arguments: args }, undefined, {
                signal: controller.signal,
            });
            const rejected = assert.rejects(request);
            await state.held.promise;
            controller.abort('stop with temporary target session');
            await state.serverAborted.promise;
            state.releaseAck();
            await state.handlerDone.promise;
            await rejected;
            assert.equal(state.deletes, 1);
            const detaches = calls.filter((call) => call.method === 'Target.detachFromTarget');
            assert.equal(detaches.length, 1);
            assert.equal(detaches[0].params.sessionId, 'owned-temporary');
            assert.equal(detaches[0].aborted, true);
            assert.equal(state.handlerResult.error.context.unknown, 1);
        });
    }
);

for (const cancelAttachAt of [1, 2, 3]) {
    test(
        `C31F3-01 SDK cancel before temporary attach ACK ${cancelAttachAt} reclaims its late session`,
        { timeout: 10000 },
        async () => {
            await withProtocol(
                'cdp',
                { temporary: true, cancelAttachAt },
                async ({ state, client, args, calls, cdp, responses }) => {
                    const controller = new AbortController();
                    const request = client.callTool({ name: 'cookies', arguments: args }, undefined, {
                        signal: controller.signal,
                    });
                    const rejected = assert.rejects(request);
                    await state.held.promise;
                    controller.abort('stop before attach ACK');
                    await state.serverAborted.promise;
                    await state.handlerDone.promise;
                    assert.equal(state.deletes, cancelAttachAt - 1);
                    assert.equal(state.handlerResult.error.context.count, cancelAttachAt - 1);
                    assert.equal(state.handlerResult.error.context.acknowledged, cancelAttachAt - 1);
                    assert.equal(state.sessions.has('owned-temporary'), true);
                    assert.equal([...cdp.callbacks.values()].filter((entry) => entry.abandoned).length, 1);
                    state.releaseAck();
                    await new Promise((resolve) => setImmediate(resolve));
                    await rejected;
                    assert.deepEqual([...state.sessions], ['owned-session']);
                    assert.equal(cdp.callbacks.size, 0);
                    assert.equal(
                        calls.filter((entry) => entry.method === 'Target.detachFromTarget').length,
                        cancelAttachAt
                    );
                    assert.ok(
                        calls
                            .filter((entry) => entry.method === 'Target.detachFromTarget')
                            .every((entry) => entry.params.sessionId === 'owned-temporary')
                    );
                    assert.equal(
                        calls.filter((entry) => entry.method === 'Network.deleteCookies' && entry.aborted).length,
                        0
                    );
                    assert.equal(responses.filter((entry) => entry.id === state.requestId).length, 0);
                }
            );
        }
    );
}

test(
    'C31F3-01 repeated SDK attach cancellation on the same connection retains no orphan sessions',
    { timeout: 10000 },
    async () => {
        const options = { temporary: true, cancelAttachAt: 1 };
        await withProtocol('cdp', options, async ({ state, client, args, cdp }) => {
            for (let index = 0; index < 4; ++index) {
                state.held = deferred();
                state.serverAborted = deferred();
                state.handlerDone = deferred();
                options.cancelAttachAt = state.attaches + 1;
                const controller = new AbortController();
                const rejected = assert.rejects(
                    client.callTool({ name: 'cookies', arguments: args }, undefined, { signal: controller.signal })
                );
                await state.held.promise;
                controller.abort('repeat synthetic cancellation');
                await state.serverAborted.promise;
                await state.handlerDone.promise;
                state.releaseAck();
                await new Promise((resolve) => setImmediate(resolve));
                await rejected;
                assert.equal(state.deletes, 0);
                assert.deepEqual([...state.sessions], ['owned-session']);
                assert.equal(cdp.callbacks.size, 0);
            }
        });
    }
);

for (const options of [{ temporary: true }, { temporary: true, rejectAttach: true }]) {
    test(`C31F3-01 temporary attach ${options.rejectAttach ? 'native rejection' : 'normal clear'} ends ownership`, async () => {
        await withProtocol('cdp', options, async ({ state, client, args, cdp, calls }) => {
            const result = await client.callTool({ name: 'cookies', arguments: args });
            assert.equal(result.isError === true, options.rejectAttach === true);
            assert.equal(state.deletes, options.rejectAttach ? 0 : 3);
            assert.equal(
                calls.filter((entry) => entry.method === 'Target.detachFromTarget').length,
                options.rejectAttach ? 0 : 3
            );
            assert.deepEqual([...state.sessions], ['owned-session']);
            assert.equal(cdp.callbacks.size, 0);
        });
    });
}

for (const options of [{ rejectDetach: true }, { holdDetach: true }]) {
    test(
        `C31F3-01 late detach ${options.holdDetach ? 'timeout' : 'failure'} remains visible and owned until connection close`,
        { timeout: 10000 },
        async () => {
            const warnings = [];
            const restore = patch(console, { warn: (...values) => warnings.push(values) });
            try {
                await withProtocol(
                    'cdp',
                    { temporary: true, cancelAttachAt: 1, ...options },
                    async ({ state, client, args, cdp, calls }) => {
                        const controller = new AbortController();
                        const rejected = assert.rejects(
                            client.callTool({ name: 'cookies', arguments: args }, undefined, {
                                signal: controller.signal,
                            })
                        );
                        await state.held.promise;
                        controller.abort('cancel before rejected cleanup');
                        await state.serverAborted.promise;
                        await state.handlerDone.promise;
                        state.releaseAck();
                        await new Promise((resolve) => setImmediate(resolve));
                        await rejected;
                        if (options.holdDetach) {
                            await new Promise((resolve) => setTimeout(resolve, 1050));
                        }
                        const retained = [...cdp.callbacks.values()];
                        assert.equal(retained.length, 1);
                        assert.equal(retained[0].abandoned, true);
                        assert.equal(retained[0].cleanup.result.sessionId, 'owned-temporary');
                        assert.match(
                            retained[0].cleanup.error.message,
                            options.holdDetach ? /1000ms/ : /Synthetic detach rejected/
                        );
                        assert.equal(warnings.length, 1);
                        assert.equal(state.deletes, 0);
                        assert.equal(calls.filter((entry) => entry.method === 'Target.detachFromTarget').length, 1);
                        cdp.close();
                        assert.equal(cdp.callbacks.size, 0);
                    }
                );
            } finally {
                restore();
            }
        }
    );
}

test('C31F3-01 timed-out owned acquisition still consumes and cleans its late result', async () => {
    const cdp = new CDPClient();
    let command;
    const reclaimed = [];
    cdp.ws = {
        readyState: 1,
        close() {},
        send(text) {
            const packet = JSON.parse(text);
            if (packet.method === 'Target.attachToTarget') {
                command = packet;
            } else {
                assert.equal(packet.method, 'Target.detachFromTarget');
                reclaimed.push(packet.params.sessionId);
                globalThis.queueMicrotask(() =>
                    cdp.handleMessage(Buffer.from(JSON.stringify({ id: packet.id, result: {} })))
                );
            }
        },
    };
    try {
        await assert.rejects(cdp.send('Target.attachToTarget', { targetId: 'owned' }, undefined, 5), /超时/);
        assert.equal(cdp.callbacks.size, 1);
        cdp.handleMessage(Buffer.from(JSON.stringify({ id: command.id, result: { sessionId: 'late-owned' } })));
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(reclaimed, ['late-owned']);
        assert.equal(cdp.callbacks.size, 0);
    } finally {
        cdp.close();
    }
});
