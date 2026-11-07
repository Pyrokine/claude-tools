import assert from 'node:assert/strict';
import test from 'node:test';
import { CDPClient } from '../dist/cdp/client.js';
import { getSession } from '../dist/core/session.js';
import { getUnifiedSession } from '../dist/core/unified-session.js';
import { formatErrorResponse } from '../dist/core/errors.js';
import { ExtensionBridge } from '../dist/extension/bridge.js';
import { registerBrowseTool } from '../dist/tools/browse.js';
import { registerCookiesTool } from '../dist/tools/cookies.js';
import { resolveChallenge } from '../dist/tools/challenge.js';

function patch(object, values) {
    const originals = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(object, key)]));
    Object.assign(object, values);
    return () => {
        for (const [key, descriptor] of originals) {
            if (descriptor) {
                Object.defineProperty(object, key, descriptor);
            } else {
                Reflect.deleteProperty(object, key);
            }
        }
    };
}

function registered(register) {
    let schema;
    let callback;
    register({
        registerTool(_name, options, handler) {
            schema = options.inputSchema;
            callback = handler;
        },
    });
    return async (args, signal) => {
        const response = await callback(schema.parse(args), { signal });
        return { response, body: JSON.parse(response.content[0].text) };
    };
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function fixture(mode, run) {
    const unified = getUnifiedSession();
    const session = getSession();
    const requests = [];
    const state = { completed: false, complete: true, metadata: null, hold: null, held: deferred(), cookies: [] };
    const tab = {
        id: 101,
        targetId: '101',
        type: 'page',
        url: 'https://example.com/owned',
        title: 'Owned page',
        managed: true,
        revision: 'r1',
    };
    const client = new CDPClient(() => unified.tabLockContext.getStore());
    const emit = (method, params) =>
        client.handleMessage(JSON.stringify({ method, params, sessionId: 'owned-session' }));
    const complete = (method) => {
        if (!state.complete) {
            return;
        }
        state.completed = true;
        if (method === 'Page.navigateToHistoryEntry') {
            emit('Page.loadEventFired', {});
        } else {
            if (method === 'Page.reload') {
                emit('Page.frameNavigated', { frame: { id: 'owned-main', loaderId: 'next-loader' } });
            }
            emit('Page.lifecycleEvent', { frameId: 'owned-main', loaderId: 'next-loader', name: 'load' });
        }
        state.afterCompletion?.();
    };
    client.ws = {
        readyState: 1,
        send(raw) {
            const message = JSON.parse(raw);
            requests.push(message);
            globalThis.queueMicrotask(() => {
                const { id, method, params } = message;
                const reply = (result) => client.handleMessage(JSON.stringify({ id, result }));
                const reject = (message) =>
                    client.handleMessage(JSON.stringify({ id, error: { code: -32000, message } }));
                if (
                    state.hold === method ||
                    (state.completed && state.metadata === 'timeout' && method === 'Target.getTargetInfo')
                ) {
                    state.held.resolve();
                    return;
                }
                if (method === 'Target.getTargetInfo') {
                    if (state.completed && state.metadata === 'missing') {
                        return reject('No target with given id found');
                    }
                    return reply({ targetInfo: { ...tab, browserContextId: 'owned-context' } });
                }
                if (method === 'Target.getTargets') {
                    return reply({ targetInfos: [tab] });
                }
                if (method === 'Page.getNavigationHistory') {
                    return reply({ currentIndex: state.historyIndex ?? 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] });
                }
                if (['Page.navigate', 'Page.reload', 'Page.navigateToHistoryEntry'].includes(method)) {
                    if (state.rejectAction) {
                        return reject('Navigation rejected before completion');
                    }
                    reply(method === 'Page.navigate' ? { frameId: 'owned-main', loaderId: 'next-loader' } : {});
                    complete(method);
                    return;
                }
                if (method === 'Storage.getCookies' || method === 'Network.getCookies') {
                    return reply({ cookies: state.cookies });
                }
                if (method === 'Network.deleteCookies') {
                    state.cookies = state.cookies.filter((cookie) => cookie.name !== params.name);
                    return reply({});
                }
                if (method === 'Target.closeTarget') {
                    return reply({ success: true });
                }
                assert.fail(`Unexpected CDP command ${method}`);
            });
        },
    };
    const bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() });
    bridge.setCurrentTargetId('101');
    bridge.updateState(tab);
    bridge.httpServer.clientSocket = { readyState: 1 };
    bridge.httpServer.helloReceived = true;
    bridge.httpServer.sendMessage = (_socket, message) => {
        requests.push(message);
        if (message.type === 'cancel') {
            return;
        }
        globalThis.queueMicrotask(() => {
            if (state.hold === message.action) {
                state.held.resolve();
                return;
            }
            let data;
            switch (message.action) {
                case 'page_snapshot':
                    data = { targetId: '101', url: tab.url, revision: 'r1' };
                    break;
                case 'tabs_list':
                    data = [tab];
                    break;
                case 'tabs_topology':
                    data = { windows: [{ id: 1, tabs: [tab] }], groups: [], windowCount: 1 };
                    break;
                case 'tabs_get':
                    data = tab;
                    break;
                case 'navigate':
                case 'reload':
                    state.completed = true;
                    data = tab;
                    break;
                default:
                    assert.fail(`Unexpected Extension action ${message.action}`);
            }
            bridge.httpServer.handleMessage(JSON.stringify({ id: message.id, success: true, data }));
        });
    };
    const restoreSession = patch(session, {
        cdp: client,
        sessionId: 'owned-session',
        currentTargetId: '101',
        state: { ...tab },
        mainFrameId: 'owned-main',
        mainFrameLoaderId: 'old-loader',
        targetSessions: new Map([['101', 'owned-session']]),
        eventControllers: new Map(),
        pendingPageCondition: null,
        revisions: new Map(),
        frameScopes: new Map(),
        selectedFrame: 0,
    });
    const restoreUnified = patch(unified, {
        extensionBridge: mode === 'extension' ? bridge : null,
        activeMode: mode,
        cdpExplicitlySelected: mode === 'cdp',
        pageMetadata: new Map(),
        hasBrowserEventObservation: () => false,
        inspectChallenge: async () => ({ title: 'Owned page', url: tab.url, inspected: true }),
    });
    try {
        return await run({ unified, session, bridge, client, requests, state });
    } finally {
        for (const callback of client.callbacks.values()) {
            callback.reject(new Error('fixture cleanup'));
        }
        for (const handler of bridge.httpServer.messageHandlers.values()) {
            handler.cleanup();
            handler.reject(new Error('fixture cleanup'));
        }
        bridge.httpServer.messageHandlers.clear();
        restoreUnified();
        restoreSession();
    }
}

const navigation = {
    open: (session, timeout) => session.navigate('https://example.com/next', { timeout }),
    back: (session, timeout) => session.goBack(timeout),
    forward: (session, timeout) => session.goForward(timeout),
    refresh: (session, timeout) => session.reload(false, 'load', timeout),
};
const mutations = (requests) =>
    requests.filter(
        ({ method, action }) =>
            ['Page.navigate', 'Page.reload', 'Page.navigateToHistoryEntry'].includes(method) ||
            ['navigate', 'reload'].includes(action)
    );
const detail = (error) => JSON.parse(formatErrorResponse(error).content[0].text).error;

for (const [action, invoke] of Object.entries(navigation)) {
    for (const failure of ['missing', 'timeout', 'budget']) {
        test(`C30-02 ${action}: first driver metadata ${failure} preserves confirmed navigation`, async () => {
            await fixture('cdp', async ({ unified, session, state, requests }) => {
                let now = Date.now();
                const restoreClock = patch(Date, { now: () => now });
                state.metadata = failure;
                if (failure === 'budget') {
                    state.afterCompletion = () => {
                        now += 1000;
                    };
                }
                try {
                    await assert.rejects(
                        unified.withTabLock(() => invoke(session, 80), now + 80),
                        (error) => {
                            const { code, message, context } = detail(error);
                            assert.equal(code, failure === 'budget' ? 'TIMEOUT' : 'CDP_ERROR');
                            assert.match(message, failure === 'missing' ? /No target/ : /timeout|超时/);
                            assert.equal(context.actionExecuted, true);
                            assert.equal(context.actionStatus, 'completed');
                            assert.equal(context.failureStage, 'metadata');
                            assert.equal(context.retryable, false);
                            return true;
                        }
                    );
                    assert.equal(mutations(requests).length, 1);
                    assert.equal(
                        [...session.cdp.eventListeners.values()].reduce((total, handlers) => total + handlers.size, 0),
                        0
                    );
                } finally {
                    restoreClock();
                }
            });
        });
    }
    test(`C30-02 ${action}: public browse reports first metadata failure without Challenge success`, async () => {
        await fixture('cdp', async ({ state, requests }) => {
            state.metadata = 'missing';
            const { response, body } = await registered(registerBrowseTool)({
                action,
                url: 'https://example.com/next',
                timeout: 100,
            });
            assert.equal(response.isError, true);
            assert.equal(body.error.context.actionStatus, 'completed');
            assert.equal(body.error.context.failureStage, 'metadata');
            assert.equal(body.error.context.actionExecuted, true);
            assert.equal(body.error.context.retryable, false);
            assert.equal(body.challengeResolved, undefined);
            assert.equal(mutations(requests).length, 1);
        });
    });
    test(`C30-02 ${action}: normal navigation and genuine navigation failure stay distinct`, async () => {
        for (const outcome of ['normal', 'wait-timeout', 'rejected']) {
            await fixture('cdp', async ({ unified, session, state }) => {
                state.complete = outcome !== 'wait-timeout';
                state.rejectAction = outcome === 'rejected';
                const operation = unified.withTabLock(() => invoke(session, 40), Date.now() + 200);
                if (outcome === 'normal') {
                    await operation;
                } else {
                    await assert.rejects(operation, (error) => {
                        assert.notEqual(detail(error).context?.actionStatus, 'completed');
                        return true;
                    });
                }
            });
        }
    });
}

test('C30-02 empty CDP history performs no navigation or metadata read', async () => {
    for (const [method, index] of [
        ['goBack', 0],
        ['goForward', 2],
    ]) {
        await fixture('cdp', async ({ session, state, requests }) => {
            state.historyIndex = index;
            assert.deepEqual(await session[method](100), { navigated: false });
            assert.deepEqual(
                requests.map(({ method }) => method),
                ['Page.getNavigationHistory']
            );
        });
    }
});

for (const mode of ['cdp', 'extension']) {
    for (const action of ['open', 'close', 'refresh', 'attach', 'launch']) {
        test(`C30-03 ${mode} ${action}: public browse rejects pre-cancelled requests with zero dispatch`, async () => {
            await fixture(mode, async ({ requests }) => {
                const abort = new AbortController();
                abort.abort(new Error('cancelled before entry'));
                const { response, body } = await registered(registerBrowseTool)(
                    { action, targetId: '101', url: 'https://example.com/next' },
                    abort.signal
                );
                assert.equal(response.isError, true);
                assert.notEqual(body.error.context?.actionStatus, 'completed');
                assert.equal(requests.length, 0);
            });
        });
        test(`C30-03 ${mode} ${action}: queue cancellation preserves serialization and zero dispatch`, async () => {
            await fixture(mode, async ({ unified, requests }) => {
                const entered = deferred();
                const release = deferred();
                const blocking = unified.withTabLock(async () => {
                    entered.resolve();
                    await release.promise;
                });
                await entered.promise;
                const abort = new AbortController();
                const operation = registered(registerBrowseTool)(
                    { action, targetId: '101', url: 'https://example.com/next' },
                    abort.signal
                );
                let nextEntered = false;
                const next = unified.withTabLock(async () => {
                    nextEntered = true;
                });
                abort.abort(new Error('cancelled in queue'));
                try {
                    const { response } = await operation;
                    assert.equal(response.isError, true);
                    assert.equal(requests.length, 0);
                    assert.equal(nextEntered, false);
                } finally {
                    release.resolve();
                    await blocking;
                    await next;
                }
                assert.equal(nextEntered, true);
            });
        });
    }
    for (const action of ['open', 'refresh']) {
        test(`C30-03 ${mode} ${action}: cancellation after dispatch stops pending RPC without replay`, async () => {
            await fixture(mode, async ({ state, requests, client, bridge }) => {
                state.hold =
                    mode === 'cdp'
                        ? action === 'open'
                            ? 'Page.navigate'
                            : 'Page.reload'
                        : action === 'open'
                          ? 'navigate'
                          : 'reload';
                const abort = new AbortController();
                const operation = registered(registerBrowseTool)(
                    { action, url: 'https://example.com/next', timeout: 1000 },
                    abort.signal
                );
                await state.held.promise;
                abort.abort(new Error('cancelled after dispatch'));
                const { response, body } = await operation;
                assert.equal(response.isError, true);
                assert.notEqual(body.error.context?.actionStatus, 'completed');
                assert.equal(mutations(requests).length, 1);
                assert.equal(client.callbacks.size, 0);
                assert.equal(bridge.httpServer.messageHandlers.size, 0);
            });
        });
    }
}

test('C30-03 CDP cancellation after acknowledgement stops the real navigation waiter', async () => {
    await fixture('cdp', async ({ unified, session, state, client, requests }) => {
        state.complete = false;
        const abort = new AbortController();
        const operation = unified.withTabLock(
            () => session.navigate('https://example.com/next', { timeout: 1000 }),
            Date.now() + 1000,
            abort.signal
        );
        while (mutations(requests).length === 0 || client.callbacks.size > 0) {
            await new Promise((resolve) => setImmediate(resolve));
        }
        abort.abort(new Error('cancelled during navigation wait'));
        await assert.rejects(operation, /cancelled during navigation wait/);
        assert.equal(
            [...client.eventListeners.values()].reduce((total, handlers) => total + handlers.size, 0),
            0
        );
        assert.equal(mutations(requests).length, 1);
    });
});

test('C30-03 cancelled metadata read retains completed navigation', async () => {
    await fixture('cdp', async ({ unified, session, state, requests }) => {
        state.metadata = 'timeout';
        const abort = new AbortController();
        const operation = unified.withTabLock(
            () => session.navigate('https://example.com/next', { timeout: 1000 }),
            Date.now() + 1000,
            abort.signal
        );
        await state.held.promise;
        abort.abort(new Error('cancelled while reading metadata'));
        await assert.rejects(operation, (error) => {
            const { context } = detail(error);
            assert.equal(context.actionStatus, 'completed');
            assert.equal(context.actionExecuted, true);
            assert.equal(context.failureStage, 'metadata');
            assert.equal(context.retryable, false);
            return true;
        });
        assert.equal(mutations(requests).length, 1);
    });
});

test('C30-03 Challenge cancellation stops polling while retaining completed navigation', async () => {
    const abort = new AbortController();
    const entered = deferred();
    let reads = 0;
    const operation = resolveChallenge(
        {
            getMode: () => 'cdp',
            getState: () => ({ title: 'Just a moment...' }),
            getChallengeState: async () => {
                ++reads;
                entered.resolve();
                return new Promise(() => {});
            },
        },
        'open',
        'completed',
        1000,
        abort.signal
    );
    await entered.promise;
    abort.abort(new Error('cancelled challenge verification'));
    await assert.rejects(operation, (error) => {
        const { context } = detail(error);
        assert.equal(context.actionStatus, 'completed');
        assert.equal(context.actionExecuted, true);
        assert.equal(context.verificationStatus, 'cancelled');
        assert.equal(context.retryable, false);
        return true;
    });
    assert.equal(reads, 1);
});

test('C30-03 cancellation during the before snapshot prevents action dispatch', async () => {
    for (const mode of ['cdp', 'extension']) {
        await fixture(mode, async ({ unified, requests }) => {
            const abort = new AbortController();
            const snapshot = unified.getPageSnapshot.bind(unified);
            const restore = patch(unified, {
                getPageSnapshot: async (...args) => {
                    const result = await snapshot(...args);
                    abort.abort(new Error('cancelled after snapshot'));
                    return result;
                },
            });
            try {
                const { response } = await registered(registerBrowseTool)({ action: 'refresh' }, abort.signal);
                assert.equal(response.isError, true);
                assert.equal(mutations(requests).length, 0);
            } finally {
                restore();
            }
        });
    }
});

test('C30-03 cancelling Extension connection wait never dispatches after a late connection', async () => {
    await fixture('extension', async ({ unified, session, bridge, requests }) => {
        bridge.httpServer.clientSocket = null;
        const restore = patch(session, { isConnected: () => false });
        const abort = new AbortController();
        try {
            const operation = unified.withTabLock(
                () => unified.launch({ timeout: 1000 }),
                Date.now() + 1000,
                abort.signal
            );
            while (bridge.httpServer.listenerCount('connected') === 0) {
                await new Promise((resolve) => setImmediate(resolve));
            }
            abort.abort(new Error('cancelled waiting for Extension'));
            await assert.rejects(operation, /cancelled waiting for Extension/);
            bridge.httpServer.clientSocket = { readyState: 1 };
            bridge.httpServer.emit('connected');
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(requests.length, 0);
        } finally {
            bridge.httpServer.emit('connected');
            restore();
        }
    });
});

function cookie(name, path, extra = {}) {
    return {
        name,
        value: 'synthetic',
        domain: 'example.com',
        path,
        secure: false,
        httpOnly: false,
        expires: -1,
        ...extra,
    };
}

test('C30-09 public cookies get/clear uses RFC6265 path boundaries in the selected context', async () => {
    await fixture('cdp', async ({ state, requests }) => {
        const cookies = registered(registerCookiesTool);
        state.cookies = [
            cookie('root', '/'),
            cookie('app_only', '/app'),
            cookie('app_slash', '/app/'),
            cookie('apple', '/apple'),
        ];
        for (const [path, names] of [
            ['/apple/info', ['root', 'apple']],
            ['/app', ['root', 'app_only']],
            ['/app/', ['root', 'app_only', 'app_slash']],
            ['/app/info', ['root', 'app_only', 'app_slash']],
            ['/application', ['root']],
        ]) {
            const { response, body } = await cookies({
                action: 'get',
                targetId: '101',
                browserContextId: 'owned-context',
                url: `https://example.com${path}`,
            });
            assert.equal(response.isError, undefined);
            assert.deepEqual(
                body.cookies.map(({ name }) => name),
                names
            );
        }
        const { response, body } = await cookies({
            action: 'clear',
            targetId: '101',
            browserContextId: 'owned-context',
            url: 'https://example.com/apple/info',
        });
        assert.equal(response.isError, undefined);
        assert.equal(body.count, 2);
        assert.deepEqual(
            state.cookies.map(({ name }) => name),
            ['app_only', 'app_slash']
        );
        assert.deepEqual(
            requests.filter(({ method }) => method === 'Network.deleteCookies').map(({ params }) => params.name),
            ['root', 'apple']
        );
        assert.ok(
            requests
                .filter(({ method }) => method === 'Storage.getCookies')
                .every(({ params }) => params.browserContextId === 'owned-context')
        );
    });
});

test('C30-09 public cookies retains domain, secure, partition and context filters', async () => {
    await fixture('cdp', async ({ state, requests }) => {
        const cookies = registered(registerCookiesTool);
        const partitionKey = { topLevelSite: 'https://example.org', hasCrossSiteAncestor: false };
        state.cookies = [
            cookie('host', '/app'),
            cookie('domain', '/app', { domain: '.example.com' }),
            cookie('other', '/app', { domain: 'other.example' }),
            cookie('secure', '/app', { secure: true }),
            cookie('partitioned', '/app', { partitionKey }),
            cookie('other_partition', '/app', {
                partitionKey: { ...partitionKey, topLevelSite: 'https://other.example' },
            }),
        ];
        const plain = await cookies({ action: 'get', targetId: '101', url: 'http://sub.example.com/app/info' });
        assert.deepEqual(
            plain.body.cookies.map(({ name }) => name),
            ['domain']
        );
        const partition = await cookies({
            action: 'get',
            browserContextId: 'owned-context',
            url: 'https://example.com/app/info',
            partitionKey,
        });
        assert.deepEqual(
            partition.body.cookies.map(({ name }) => name),
            ['partitioned']
        );
        const cleared = await cookies({
            action: 'clear',
            targetId: '101',
            browserContextId: 'owned-context',
            url: 'https://example.com/app/info',
            partitionKey,
        });
        assert.equal(cleared.body.count, 1);
        const deletion = requests.find(({ method }) => method === 'Network.deleteCookies');
        assert.deepEqual(deletion.params.partitionKey, partitionKey);
        assert.equal(deletion.sessionId, 'owned-session');
        const before = requests.filter(({ method }) => method === 'Storage.getCookies').length;
        const mismatch = await cookies({
            action: 'get',
            targetId: '101',
            browserContextId: 'other-context',
            url: 'https://example.com/app/info',
        });
        assert.equal(mismatch.response.isError, true);
        assert.equal(requests.filter(({ method }) => method === 'Storage.getCookies').length, before);
    });
});
