import assert from 'node:assert/strict';
import test from 'node:test';
import { CDPClient } from '../dist/cdp/client.js';
import { CDPError } from '../dist/core/errors.js';
import { getSession } from '../dist/core/session.js';
import { getUnifiedSession } from '../dist/core/unified-session.js';
import { registerCookiesTool } from '../dist/tools/cookies.js';

function patch(object, values) {
    const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(object, key)]));
    Object.assign(object, values);
    return () => {
        for (const [key, descriptor] of previous) {
            if (descriptor) {
                Object.defineProperty(object, key, descriptor);
            } else {
                Reflect.deleteProperty(object, key);
            }
        }
    };
}

async function withTransport(options, run) {
    const controller = new AbortController();
    const client = new CDPClient(() => ({ signal: controller.signal }));
    const calls = [];
    const state = {
        cookies: ['first', 'second', 'third'].map((name) => ({
            name,
            value: 'synthetic',
            domain: 'example.com',
            path: '/',
            secure: false,
            httpOnly: false,
        })),
        deletes: 0,
        reads: 0,
    };
    const socket = {
        readyState: 1,
        close: () => {
            socket.readyState = 3;
        },
        send: (text) => {
            const command = JSON.parse(text);
            calls.push(command);
            globalThis.queueMicrotask(() => {
                const reply = (result, error) =>
                    client.handleMessage(Buffer.from(JSON.stringify({ id: command.id, result, error })));
                switch (command.method) {
                    case 'Target.getTargetInfo':
                        reply({ targetInfo: { targetId: 'page', browserContextId: 'owned' } });
                        if (options.failure === 'before-dispatch' && state.reads >= 2) {
                            socket.readyState = 3;
                        }
                        return;
                    case 'Storage.getCookies':
                    case 'Network.getCookies':
                        ++state.reads;
                        reply({ cookies: state.cookies.map((cookie) => ({ ...cookie })) });
                        return;
                    case 'Network.deleteCookies': {
                        ++state.deletes;
                        const interrupted = state.deletes === (options.at ?? 1);
                        if (interrupted && options.failure === 'protocol-error') {
                            reply(undefined, { code: options.nativeCode, message: 'Synthetic native rejection' });
                            return;
                        }
                        state.cookies = state.cookies.filter((cookie) => cookie.name !== command.params.name);
                        if (interrupted) {
                            if (options.failure === 'close') {
                                client.handleClose();
                                return;
                            }
                            if (options.failure === 'active-close') {
                                client.close();
                                return;
                            }
                            if (options.failure === 'timeout') {
                                return;
                            }
                            if (options.failure === 'cancel') {
                                controller.abort('synthetic cancellation');
                                return;
                            }
                        }
                        reply({});
                        return;
                    }
                    default:
                        assert.fail(`Unexpected command: ${command.method}`);
                }
            });
        },
    };
    client.ws = socket;
    const session = getSession();
    const unified = getUnifiedSession();
    const restore = [
        patch(CDPClient, { DEFAULT_COMMAND_TIMEOUT: 50 }),
        patch(session, {
            cdp: client,
            sessionId: 'owned-session',
            currentTargetId: 'page',
            targetSessions: new Map([['page', 'owned-session']]),
            state: { url: 'https://example.com/' },
        }),
        patch(unified, { getDriver: async () => session }),
    ];
    let schema;
    let handler;
    registerCookiesTool({
        registerTool(_name, config, callback) {
            schema = config.inputSchema;
            handler = callback;
        },
    });
    const invoke = async () => {
        const response = await handler(schema.parse({ action: 'clear', targetId: 'page', domain: 'example.com' }));
        return { response, body: JSON.parse(response.content[0].text) };
    };
    try {
        await run({ invoke, state, calls, client });
    } finally {
        client.close();
        for (const undo of restore.reverse()) {
            undo();
        }
    }
}

for (const failure of ['close', 'active-close']) {
    for (const at of [1, 2, 3]) {
        test(`C31F-01 public clear ${failure} after delete ${at} preserves unknown and stops dispatch`, async () => {
            await withTransport({ failure, at }, async ({ invoke, state, calls, client }) => {
                const { response, body } = await invoke();
                assert.equal(response.isError, true);
                assert.equal(body.error.code, 'COOKIE_CLEAR_PARTIAL');
                const context = body.error.context;
                assert.equal(context.count, at - 1);
                assert.equal(context.acknowledged, at - 1);
                assert.equal(context.attempted, at);
                assert.equal(context.failed, 0);
                assert.equal(context.unknown, 1);
                assert.equal(context.unprocessed, 3 - at);
                assert.equal(context.actionExecuted, at === 1 ? 'unknown' : true);
                assert.equal(context.actionStatus, at === 1 ? 'unknown' : 'partial');
                assert.equal(context.retryable, false);
                assert.equal(context.cause.context.method, 'Network.deleteCookies');
                assert.equal(context.cause.context.actionStatus, 'unknown');
                assert.match(context.cause.message, failure === 'close' ? /连接已关闭/ : /连接主动关闭/);
                assert.equal(calls.filter(({ method }) => method === 'Network.deleteCookies').length, at);
                assert.equal(state.cookies.length, 3 - at);
                assert.equal(client.callbacks.size, 0);
            });
        });
    }
}

for (const failure of ['timeout', 'cancel']) {
    test(`C31F-01 public clear production ${failure} after dispatch keeps an unknown step`, async () => {
        await withTransport({ failure }, async ({ invoke, state, calls, client }) => {
            const { body } = await invoke();
            const context = body.error.context;
            assert.equal(context.count, 0);
            assert.equal(context.acknowledged, 0);
            assert.equal(context.unknown, 1);
            assert.equal(context.failed, 0);
            assert.equal(context.unprocessed, 2);
            assert.equal(context.actionExecuted, 'unknown');
            assert.equal(context.actionStatus, 'unknown');
            assert.equal(context.retryable, false);
            assert.equal(context.cause.context.method, 'Network.deleteCookies');
            assert.match(context.cause.message, failure === 'timeout' ? /命令超时/ : /cancelled after dispatch/);
            assert.equal(calls.filter(({ method }) => method === 'Network.deleteCookies').length, 1);
            assert.equal(state.cookies.length, 2);
            assert.equal(client.callbacks.size, 0);
        });
    });
}

for (const nativeCode of [-32601, -32602, -32000]) {
    test(`C31F-01 public clear native rejection ${nativeCode} is a known failure`, async () => {
        await withTransport({ failure: 'protocol-error', nativeCode }, async ({ invoke, state }) => {
            const { body } = await invoke();
            const context = body.error.context;
            assert.equal(context.failed, 1);
            assert.equal(context.unknown, 0);
            assert.equal(context.acknowledged, 0);
            assert.equal(context.unprocessed, 2);
            assert.equal(context.actionStatus, 'not_started');
            assert.equal(context.cause.context.protocolError, true);
            assert.equal(context.cause.context.nativeCode, nativeCode);
            assert.equal(state.cookies.length, 3);
        });
    });
}

test('C31F-01 public clear distinguishes an unavailable connection before deletion', async () => {
    await withTransport({ failure: 'before-dispatch' }, async ({ invoke, calls, state }) => {
        const { body } = await invoke();
        const context = body.error.context;
        assert.equal(context.failed, 1);
        assert.equal(context.unknown, 0);
        assert.equal(context.actionStatus, 'not_started');
        assert.equal(context.cause.code, 'SESSION_NOT_FOUND');
        assert.equal(calls.filter(({ method }) => method === 'Network.deleteCookies').length, 0);
        assert.equal(state.cookies.length, 3);
    });
});

test('C31F-01 public clear normal ACK verifies all deletions without unknown steps', async () => {
    await withTransport({}, async ({ invoke, state }) => {
        const { response, body } = await invoke();
        assert.equal(response.isError, undefined);
        assert.equal(body.count, 3);
        assert.equal(body.acknowledged, 3);
        assert.equal(body.failed, 0);
        assert.equal(body.unknown, 0);
        assert.equal(body.unprocessed, 0);
        assert.equal(state.cookies.length, 0);
    });
});

test('C31F-01 an unclassified CDP error never becomes a confirmed deletion failure', async () => {
    await withTransport({}, async ({ invoke, client }) => {
        const original = client.send.bind(client);
        client.send = (method, ...args) =>
            method === 'Network.deleteCookies'
                ? Promise.reject(new CDPError('Unclassified transport failure'))
                : original(method, ...args);
        const { body } = await invoke();
        assert.equal(body.error.context.failed, 0);
        assert.equal(body.error.context.unknown, 1);
        assert.equal(body.error.context.actionStatus, 'unknown');
    });
});

test('C31F-01 CDP send before connection and before deadline does not register callbacks', async () => {
    const disconnected = new CDPClient();
    await assert.rejects(disconnected.send('Network.deleteCookies', {}), (error) => {
        assert.equal(error.context.method, 'Network.deleteCookies');
        assert.equal(error.context.actionStatus, 'not_started');
        return true;
    });
    const expired = new CDPClient(() => ({ deadline: Date.now() - 1 }));
    expired.ws = { readyState: 1, send: () => assert.fail('Expired send must not dispatch') };
    await assert.rejects(expired.send('Network.deleteCookies', {}), (error) => {
        assert.equal(error.context.method, 'Network.deleteCookies');
        assert.equal(error.context.actionExecuted, false);
        return true;
    });
    const controller = new AbortController();
    controller.abort('cancel before send');
    const cancelled = new CDPClient(() => ({ signal: controller.signal }));
    cancelled.ws = { readyState: 1, send: () => assert.fail('Cancelled send must not dispatch') };
    await assert.rejects(cancelled.send('Network.deleteCookies', {}), (error) => {
        assert.equal(error.context.actionStatus, 'not_started');
        assert.equal(error.context.actionExecuted, false);
        return true;
    });
    assert.equal(disconnected.callbacks.size, 0);
    assert.equal(expired.callbacks.size, 0);
    assert.equal(cancelled.callbacks.size, 0);
});
