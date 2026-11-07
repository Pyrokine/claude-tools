import assert from 'node:assert/strict';
import test from 'node:test';
import { CDPClient } from '../dist/cdp/client.js';
import { CDPError, TimeoutError } from '../dist/core/errors.js';
import { getSession } from '../dist/core/session.js';
import { getUnifiedSession } from '../dist/core/unified-session.js';
import { ExtensionBridge } from '../dist/extension/bridge.js';
import { registerCookiesTool } from '../dist/tools/cookies.js';

function patch(object, values) {
    const previous = new Map(Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(object, name)]));
    Object.assign(object, values);
    return () => {
        for (const [name, descriptor] of previous) {
            if (descriptor) {
                Object.defineProperty(object, name, descriptor);
            } else {
                Reflect.deleteProperty(object, name);
            }
        }
    };
}

function cookie(name, path = '/', options = {}) {
    return { name, value: 'synthetic', domain: 'example.com', path, secure: false, httpOnly: false, ...options };
}

function identity(value) {
    return [
        value.name,
        value.domain,
        value.path,
        value.partitionKey?.topLevelSite,
        value.partitionKey?.hasCrossSiteAncestor,
    ];
}

async function fixture(run, mode = 'cdp') {
    const session = getSession();
    const unified = getUnifiedSession();
    const calls = [];
    const state = { cookies: [], reads: 0, deletes: 0 };
    const client = new CDPClient();
    client.ws = { readyState: 1 };
    client.send = async (method, params = {}, sid) => {
        calls.push({ method, params, sid });
        if (method === 'Target.getTargetInfo') {
            return { targetInfo: { targetId: 'page', browserContextId: 'owned' } };
        }
        if (method === 'Target.attachToTarget') {
            return { sessionId: 'temporary' };
        }
        if (method === 'Target.detachFromTarget') {
            if (state.detachFailure) {
                throw new CDPError('synthetic detach rejection', { method });
            }
            return {};
        }
        if (method === 'Storage.getCookies' || method === 'Network.getCookies') {
            ++state.reads;
            state.beforeRead?.(state.reads);
            if (state.failRead === state.reads) {
                throw new TimeoutError('synthetic read timeout');
            }
            return {
                cookies: state.cookies
                    .filter((entry) => (entry.context ?? 'owned') === (params.browserContextId ?? 'owned'))
                    .filter(
                        (entry) =>
                            method !== 'Network.getCookies' ||
                            (params.urls ?? ['https://example.com/']).some((address) => {
                                const url = new URL(address);
                                const domain = entry.domain.replace(/^\./, '');
                                return (
                                    (url.hostname === domain ||
                                        (entry.domain.startsWith('.') && url.hostname.endsWith('.' + domain))) &&
                                    (url.pathname === entry.path ||
                                        (url.pathname.startsWith(entry.path) &&
                                            (entry.path.endsWith('/') || url.pathname[entry.path.length] === '/'))) &&
                                    (!entry.secure || url.protocol === 'https:')
                                );
                            })
                    )
                    .map((entry) => ({ ...entry })),
            };
        }
        if (method === 'Network.deleteCookies') {
            ++state.deletes;
            if (state.rejectAt === state.deletes) {
                throw new CDPError('synthetic delete rejection', { method, protocolError: true, nativeCode: -32602 });
            }
            if (!state.noRemoval) {
                const domain = params.domain ?? new URL(params.url).hostname;
                state.cookies = state.cookies.filter((entry) => {
                    if (
                        (entry.context ?? 'owned') !== 'owned' ||
                        entry.name !== params.name ||
                        entry.domain !== domain
                    ) {
                        return true;
                    }
                    if (params.path && entry.path !== params.path) {
                        return true;
                    }
                    return (
                        Boolean(entry.partitionKey) !== Boolean(params.partitionKey) ||
                        entry.partitionKey?.topLevelSite !== params.partitionKey?.topLevelSite ||
                        entry.partitionKey?.hasCrossSiteAncestor !== params.partitionKey?.hasCrossSiteAncestor
                    );
                });
            }
            if (state.loseAckAt === state.deletes) {
                throw new TimeoutError('synthetic lost acknowledgement', { method, actionStatus: 'unknown' });
            }
            return {};
        }
        assert.fail(`Unexpected native boundary: ${method}`);
    };
    const bridge = new ExtensionBridge();
    bridge.httpServer.sendCommand = async (action, filter) => {
        calls.push({ action, filter });
        assert.equal(action, 'cookies_get');
        return state.cookies.filter((entry) => !filter.name || entry.name === filter.name);
    };
    const restoreSession = patch(session, {
        cdp: client,
        sessionId: 'owned-session',
        currentTargetId: 'page',
        targetSessions: new Map([['page', 'owned-session']]),
        state: { url: 'https://example.com/' },
    });
    const restoreUnified = patch(unified, { getDriver: async () => (mode === 'cdp' ? session : bridge) });
    let schema;
    let callback;
    registerCookiesTool({
        registerTool(_name, options, handler) {
            schema = options.inputSchema;
            callback = handler;
        },
    });
    const invoke = async (args) => {
        const response = await callback(schema.parse(args));
        return { response, body: JSON.parse(response.content[0].text) };
    };
    try {
        await run({ state, calls, session, invoke });
    } finally {
        restoreUnified();
        restoreSession();
    }
}

for (const mode of ['cdp', 'extension']) {
    test(`C31-05 ${mode} public get rejects absent and blank scope filters before dispatch`, async () => {
        await fixture(async ({ invoke, calls }) => {
            for (const scope of [
                {},
                { targetId: 'page' },
                { browserContextId: 'owned' },
                { storeId: 'store' },
                { secure: true },
                { session: true },
                { path: '/' },
                { partitionKey: { topLevelSite: 'https://example.org' } },
                { name: '' },
                { domain: ' ' },
                { url: '\t' },
                { targetId: 'page', output: 'tmp:c31-rejected-cookies.json' },
            ]) {
                const result = await invoke({ action: 'get', ...scope });
                assert.equal(result.response.isError, true);
                assert.equal(result.body.error.code, 'INVALID_ARGUMENT');
                assert.equal(result.body.error.context.actionExecuted, false);
            }
            assert.equal(calls.length, 0);
        }, mode);
    });
    test(`C31-05 ${mode} name, domain and URL independently permit scoped get`, async () => {
        await fixture(async ({ invoke, state, calls }) => {
            state.cookies = [cookie('sid')];
            for (const filter of [{ name: 'sid' }, { domain: 'example.com' }, { url: 'https://example.com/' }]) {
                const result = await invoke({ action: 'get', ...filter });
                assert.equal(result.response.isError, undefined);
                assert.equal(result.body.count, 1);
            }
            assert.ok(calls.length >= 3);
        }, mode);
    });
}

test('C31-05 CDP backend refuses filterless reads before any Cookie API', async () => {
    await fixture(async ({ session, calls }) => {
        for (const filter of [undefined, {}, { targetId: 'page' }, { name: ' ' }]) {
            await assert.rejects(session.getCookies(filter), /name.*domain.*url/);
        }
        assert.equal(calls.length, 0);
    });
});

test('C31-01 public clear preserves same-name path, raw domain, partition and context identity', async () => {
    await fixture(async ({ invoke, state, calls }) => {
        const key = { topLevelSite: 'https://example.org', hasCrossSiteAncestor: false };
        const other = { ...key, topLevelSite: 'https://other.example' };
        state.cookies = [
            cookie('sid', '/app'),
            cookie('sid', '/apple'),
            cookie('sid', '/app', { domain: '.example.com' }),
            cookie('sid', '/apple', { domain: '.example.com' }),
            cookie('sid', '/apple', { partitionKey: key }),
            cookie('sid', '/apple', { partitionKey: other }),
            cookie('sid', '/apple', { context: 'other-context' }),
        ];
        const partition = await invoke({
            action: 'clear',
            targetId: 'page',
            browserContextId: 'owned',
            url: 'https://example.com/apple/info',
            partitionKey: key,
        });
        assert.equal(partition.body.count, 1);
        assert.equal(partition.body.acknowledged, 1);
        assert.equal(
            state.cookies.some((entry) => entry.partitionKey?.topLevelSite === other.topLevelSite),
            true
        );
        const plain = await invoke({
            action: 'clear',
            targetId: 'page',
            browserContextId: 'owned',
            url: 'https://example.com/apple/info',
        });
        assert.equal(plain.body.count, 3);
        assert.deepEqual(state.cookies.map(identity), [
            identity(cookie('sid', '/app')),
            identity(cookie('sid', '/app', { domain: '.example.com' })),
            identity(cookie('sid', '/apple', { context: 'other-context' })),
        ]);
        const deleted = calls.filter(({ method }) => method === 'Network.deleteCookies');
        assert.equal(deleted.length, 4);
        assert.ok(
            deleted.every(
                ({ params, sid }) => params.path === '/apple' && params.url === undefined && sid === 'owned-session'
            )
        );
        assert.ok(deleted.some(({ params }) => params.domain === '.example.com'));
    });
});

test('C31-01 URL-only clear pins its selected context and Cookie path', async () => {
    await fixture(async ({ invoke, state, calls }) => {
        state.cookies = [cookie('sid', '/app'), cookie('sid', '/apple')];
        const { body } = await invoke({ action: 'clear', url: 'https://example.com/apple/info' });
        assert.equal(body.count, 1);
        assert.equal(body.alreadyAbsent, 0);
        assert.deepEqual(
            state.cookies.map(({ path }) => path),
            ['/app']
        );
        assert.ok(
            calls
                .filter(({ method }) => method === 'Storage.getCookies')
                .every(({ params }) => params.browserContextId === 'owned')
        );
        assert.equal(
            calls.some(({ method }) => method === 'Network.getCookies'),
            false
        );
    });
});

test('C31-01 changing the default page after enumeration does not redirect clear', async () => {
    await fixture(async ({ invoke, state, calls, session }) => {
        state.cookies = [cookie('sid')];
        state.beforeRead = (read) => {
            if (read === 1) {
                session.currentTargetId = 'other-page';
            }
        };
        const { body } = await invoke({ action: 'clear', url: 'https://example.com/' });
        assert.equal(body.count, 1);
        assert.ok(
            calls
                .filter(({ method }) => method === 'Target.getTargetInfo')
                .every(({ params }) => params.targetId === 'page')
        );
        assert.ok(
            calls.filter(({ method }) => method === 'Network.deleteCookies').every(({ sid }) => sid === 'owned-session')
        );
    });
});

test('C31-01 an already-absent candidate does not become an acknowledged deletion', async () => {
    await fixture(async ({ invoke, state, calls }) => {
        state.cookies = [cookie('sid')];
        state.beforeRead = (read) => {
            if (read === 2) {
                state.cookies = [];
            }
        };
        const result = await invoke({ action: 'clear', domain: 'example.com' });
        assert.equal(result.body.count, 0);
        assert.equal(result.body.alreadyAbsent, 1);
        assert.equal(result.body.acknowledged, 0);
        assert.equal(calls.filter(({ method }) => method === 'Network.deleteCookies').length, 0);
    });
});

test('C31-01 an empty ACK with the identity still present is not reported as a deletion', async () => {
    await fixture(async ({ invoke, state }) => {
        state.cookies = [cookie('sid')];
        state.noRemoval = true;
        const result = await invoke({ action: 'clear', domain: 'example.com' });
        assert.equal(result.body.error.code, 'COOKIE_CLEAR_PARTIAL');
        assert.equal(result.body.error.context.count, 0);
        assert.equal(result.body.error.context.acknowledged, 1);
        assert.equal(result.body.error.context.failed, 1);
    });
});

for (const rejectAt of [1, 2, 3]) {
    test(`C31-04 rejection at deletion ${rejectAt} retains progress and stops later work`, async () => {
        await fixture(async ({ invoke, state, calls }) => {
            state.cookies = [cookie('first'), cookie('second'), cookie('third')];
            state.rejectAt = rejectAt;
            const result = await invoke({ action: 'clear', targetId: 'page', domain: 'example.com' });
            assert.equal(result.response.isError, true);
            assert.equal(result.body.error.code, 'COOKIE_CLEAR_PARTIAL');
            const progress = result.body.error.context;
            assert.equal(progress.count, rejectAt - 1);
            assert.equal(progress.acknowledged, rejectAt - 1);
            assert.equal(progress.failed, 1);
            assert.equal(progress.unknown, 0);
            assert.equal(progress.unprocessed, 3 - rejectAt);
            assert.equal(progress.retryable, false);
            assert.equal(progress.actionExecuted, rejectAt > 1);
            assert.equal(progress.cause.code, 'CDP_ERROR');
            assert.equal(calls.filter(({ method }) => method === 'Network.deleteCookies').length, rejectAt);
            assert.equal(state.cookies.length, 4 - rejectAt);
        });
    });
}

test('C31-04 lost acknowledgement reports an unknown step without replay or further deletion', async () => {
    await fixture(async ({ invoke, state, calls }) => {
        state.cookies = [cookie('first'), cookie('second'), cookie('third')];
        state.loseAckAt = 2;
        const { body } = await invoke({ action: 'clear', domain: 'example.com' });
        assert.equal(body.error.context.count, 1);
        assert.equal(body.error.context.acknowledged, 1);
        assert.equal(body.error.context.unknown, 1);
        assert.equal(body.error.context.failed, 0);
        assert.equal(body.error.context.unprocessed, 1);
        assert.equal(body.error.context.actionStatus, 'partial');
        assert.equal(body.error.context.retryable, false);
        assert.deepEqual(
            state.cookies.map(({ name }) => name),
            ['third']
        );
        assert.equal(calls.filter(({ method }) => method === 'Network.deleteCookies').length, 2);
    });
});

test('C31-04 a detach error after deletion preserves ACK and observed absent identity', async () => {
    await fixture(async ({ invoke, state, session }) => {
        session.targetSessions.clear();
        state.cookies = [cookie('first'), cookie('second')];
        state.detachFailure = true;
        const { body } = await invoke({ action: 'clear', domain: 'example.com' });
        assert.equal(body.error.context.count, 1);
        assert.equal(body.error.context.acknowledged, 1);
        assert.equal(body.error.context.unknown, 0);
        assert.equal(body.error.context.unprocessed, 1);
        assert.equal(body.error.context.phase, 'cleanup');
        assert.equal(body.error.context.retryable, false);
        assert.deepEqual(
            state.cookies.map(({ name }) => name),
            ['second']
        );
    });
});

test('C31-01 a conflicting context is rejected before reading or deleting Cookies', async () => {
    await fixture(async ({ invoke, calls }) => {
        const { response } = await invoke({
            action: 'clear',
            targetId: 'page',
            browserContextId: 'wrong',
            domain: 'example.com',
        });
        assert.equal(response.isError, true);
        assert.equal(
            calls.some(({ method }) => method === 'Network.deleteCookies' || method === 'Storage.getCookies'),
            false
        );
    });
});

test('C31-01 opaque partition identities fail before any deletion', async () => {
    await fixture(async ({ invoke, state, calls }) => {
        state.cookies = [cookie('plain'), cookie('opaque', '/', { partitionKeyOpaque: true })];
        const { response } = await invoke({ action: 'clear', domain: 'example.com' });
        assert.equal(response.isError, true);
        assert.equal(
            calls.some(({ method }) => method === 'Network.deleteCookies'),
            false
        );
        assert.equal(state.cookies.length, 2);
    });
});
