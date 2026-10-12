import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { ActionHandler } from '../src/background/actions.ts';
import { assertReadableTab, getDomFrameSnapshot } from '../src/background/action-utils.ts';
import { ContentHandler } from '../src/background/content-handler.ts';
import { CookieHandler } from '../src/background/cookie-handler.ts';
import { DebuggerManager } from '../src/background/debugger-manager.ts';
import { DebuggerHandler } from '../src/background/debugger-handler.ts';
import { ExpectedOperationError } from '../src/types/expected-errors.ts';
import { HttpClient } from '../src/background/http-client.ts';
import { LogEventHandler } from '../src/background/log-event-handler.ts';
import { LogManager } from '../src/background/log-manager.ts';
import { NavigationHandler } from '../src/background/navigation-handler.ts';
import { advancePageRevision, forgetPageRevision, pageSnapshot } from '../src/background/page-revision.ts';
import { hasReadGrant, revokeReadGrants, revokeTabReadGrants, setReadGrant } from '../src/background/read-grants.ts';
import {
    executeCode,
    extractAttribute,
    extractHtml,
    extractHtmlWithImages,
    extractMetadata,
    extractText,
    findElements,
    generateAccessibilityTree,
    getComputedStyleFromElement,
    performActionableClick,
} from '../src/background/page-scripts.ts';
import { TabHandler } from '../src/background/tab-handler.ts';
import {
    isCreatedTab,
    isManagedTab,
    markManagedTab,
    restoreManagedTabs,
    setMcpTabGroupId,
    setMcpWindowId,
    unmarkManagedTab,
} from '../src/background/tab-state.ts';
import { EvaluateSchema } from '../src/types/schemas.ts';

function installGlobals(values) {
    const descriptors = new Map();
    for (const [name, value] of Object.entries(values)) {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    return () => {
        for (const [name, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    };
}

function chromeEvent() {
    const listeners = new Set();
    return {
        addListener(listener) {
            listeners.add(listener);
        },
        removeListener(listener) {
            listeners.delete(listener);
        },
        emit(...args) {
            for (const listener of [...listeners]) {
                listener(...args);
            }
        },
        get size() {
            return listeners.size;
        },
    };
}

class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.sent = [];
        FakeWebSocket.instances.push(this);
    }

    open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
    }

    send(message) {
        this.sent.push(message);
    }

    close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.();
    }
}

function createStorage(initial = {}) {
    const values = { ...initial };
    const sessionValues = {};
    return {
        values,
        local: {
            async get(key) {
                if (typeof key === 'string') {
                    return { [key]: values[key] };
                }
                return { ...values };
            },
            async set(update) {
                Object.assign(values, update);
            },
        },
        session: {
            async get(key) {
                if (typeof key === 'string') {
                    return { [key]: sessionValues[key] };
                }
                return { ...sessionValues };
            },
            async set(update) {
                Object.assign(sessionValues, update);
            },
            async remove(key) {
                delete sessionValues[key];
            },
        },
    };
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function waitUntil(predicate) {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    }
    throw new Error('condition not reached');
}

test('C3 Extension rejects stale page conditions before any handler side effect', async () => {
    const tab = { id: 901, url: 'https://example.com/a' };
    let handler;
    const restore = installGlobals({
        chrome: {
            tabs: {
                async get(id) {
                    assert.equal(id, tab.id);
                    return tab;
                },
            },
            debugger: { onDetach: chromeEvent(), onEvent: chromeEvent() },
        },
    });
    try {
        handler = new ActionHandler();
        let actions = 0;
        handler.actions.set('navigate', async () => {
            actions++;
            tab.url = 'https://example.com/b';
        });
        const original = await pageSnapshot(tab.id);
        await assert.rejects(
            () => handler.execute('navigate', { tabId: tab.id, expectedRevision: 'stale' }, {}),
            /ACTION_PRECONDITION_FAILED/
        );
        assert.equal(actions, 0);
        assert.deepEqual(await pageSnapshot(tab.id), original);
        await handler.execute(
            'navigate',
            {
                tabId: tab.id,
                expectedUrl: original.url,
                expectedRevision: original.revision,
            },
            {}
        );
        assert.equal(actions, 1);
        const updated = await pageSnapshot(tab.id);
        assert.notEqual(updated.revision, original.revision);
        await assert.rejects(
            () => handler.execute('navigate', { tabId: tab.id, expectedRevision: original.revision }, {}),
            /ACTION_PRECONDITION_FAILED/
        );
        assert.equal(actions, 1);
    } finally {
        if (handler?.logManager.sweepTimer) {
            globalThis.clearInterval(handler.logManager.sweepTimer);
        }
        forgetPageRevision(tab.id);
        restore();
    }
});

test('C4 read grants scope ordinary reads by server instance, page and URL', async () => {
    const tab = { id: 902, url: 'https://example.com/a' };
    let documentId = 'document-a';
    let handler;
    const records = new Map();
    let injectedWorld;
    let injectionTarget;
    let revokeDuringRead = false;
    const restore = installGlobals({
        chrome: {
            tabs: {
                async get(id) {
                    assert.equal(id, tab.id);
                    return tab;
                },
            },
            storage: {
                session: {
                    async get(key) {
                        return Object.fromEntries([...records].filter(([name]) => key === null || name === key));
                    },
                    async set(entries) {
                        for (const [name, value] of Object.entries(entries)) {
                            records.set(name, value);
                        }
                    },
                    async remove(key) {
                        records.delete(key);
                    },
                },
            },
            webNavigation: {
                async getFrame({ tabId, frameId }) {
                    assert.equal(tabId, tab.id);
                    assert.equal(frameId, 0);
                    return { documentId, url: tab.url };
                },
            },
            scripting: {
                async executeScript(options) {
                    injectedWorld = options.world;
                    injectionTarget = options.target;
                    if (revokeDuringRead) {
                        revokeDuringRead = false;
                        await setReadGrant('server-a', tab.id, false);
                    }
                    if (options.func === getComputedStyleFromElement) {
                        return [{ result: 'rgb(1, 2, 3)' }];
                    }
                    return [{ result: { html: '<main>Allowed</main>' } }];
                },
            },
            debugger: { onDetach: chromeEvent(), onEvent: chromeEvent() },
        },
    });
    const context = { serverInstanceId: 'server-a', mcpWindowId: null, mcpTabGroupId: null };
    try {
        handler = new ActionHandler();
        const content = new ContentHandler(handler.debuggerManager);
        await assert.rejects(() => content.getHtml({ tabId: tab.id }, context), /只读权限/);
        await assert.rejects(
            () => handler.execute('get_computed_style', { tabId: tab.id, refId: 'ref_1', prop: 'color' }, context),
            /只读权限/
        );
        await setReadGrant('server-a', tab.id, true);
        assert.equal(await hasReadGrant('server-a', tab.id), true);
        assert.equal(await hasReadGrant('server-b', tab.id), false);
        assert.deepEqual(await content.getHtml({ tabId: tab.id }, context), { html: '<main>Allowed</main>' });
        assert.equal(injectedWorld, 'ISOLATED');
        assert.deepEqual(injectionTarget, { tabId: tab.id, documentIds: ['document-a'] });
        assert.equal(
            await handler.execute('get_computed_style', { tabId: tab.id, refId: 'ref_1', prop: 'color' }, context),
            'rgb(1, 2, 3)'
        );
        assert.deepEqual(injectionTarget, { tabId: tab.id, documentIds: ['document-a'] });
        revokeDuringRead = true;
        await assert.rejects(() => content.getHtml({ tabId: tab.id }, context), /只读权限/);
        await setReadGrant('server-a', tab.id, true);
        documentId = 'document-b';
        assert.equal(await hasReadGrant('server-a', tab.id), false);
        documentId = 'document-a';
        const [grantKey] = records.keys();
        records.get(grantKey)[0].revision = 'previous-worker:0';
        assert.equal(await hasReadGrant('server-a', tab.id), true);
        assert.equal(records.get(grantKey)[0].revision, (await pageSnapshot(tab.id)).revision);
        advancePageRevision(tab.id);
        assert.equal(await hasReadGrant('server-a', tab.id), false);
        await setReadGrant('server-a', tab.id, true);
        await assert.rejects(() => handler.execute('evaluate', { tabId: tab.id, code: '1+1' }, context), /非创建页面/);
        await assert.rejects(() => handler.execute('screenshot', { tabId: tab.id }, context), /非创建页面/);
        tab.url = 'https://example.com/b';
        assert.equal(await hasReadGrant('server-a', tab.id), false);
        await assert.rejects(() => assertReadableTab(tab.id, context, 'read_page'), /只读权限/);
        await revokeTabReadGrants(tab.id);
        tab.url = 'https://example.com/a';
        assert.equal(await hasReadGrant('server-a', tab.id), false);
        await setReadGrant('server-a', tab.id, true);
        await setReadGrant('server-b', tab.id, true);
        await revokeReadGrants('server-a');
        assert.equal(await hasReadGrant('server-a', tab.id), false);
        assert.equal(await hasReadGrant('server-b', tab.id), true);
    } finally {
        if (handler?.logManager.sweepTimer) {
            globalThis.clearInterval(handler.logManager.sweepTimer);
        }
        forgetPageRevision(tab.id);
        restore();
    }
});

test('C4 tab IDs from an earlier browser session do not restore created-page authority', async () => {
    const staleId = 1902;
    const currentId = 1903;
    const legacy = { mcp_managed_tab_ids: [staleId], mcp_created_tab_ids: [staleId] };
    const session = { mcp_managed_tab_ids: [currentId], mcp_created_tab_ids: [currentId] };
    const restore = installGlobals({
        chrome: {
            storage: {
                local: {
                    async get() {
                        return legacy;
                    },
                    async set() {
                        throw new Error('legacy storage changed');
                    },
                },
                session: {
                    async get(keys) {
                        return Object.fromEntries(keys.map((key) => [key, session[key]]));
                    },
                    async set(values) {
                        Object.assign(session, values);
                    },
                },
            },
            tabs: {
                async query() {
                    return [{ id: currentId }, { id: staleId }];
                },
            },
        },
    });
    try {
        await restoreManagedTabs();
        assert.equal(isCreatedTab(staleId), false);
        assert.equal(isManagedTab({ id: staleId, groupId: -1 }, { mcpTabGroupId: null, mcpWindowId: null }), false);
        assert.equal(isCreatedTab(currentId), true);
        await markManagedTab(staleId, true);
        assert.equal(isCreatedTab(staleId), true);
        assert.deepEqual(session.mcp_created_tab_ids.sort(), [staleId, currentId].sort());
        assert.deepEqual(legacy.mcp_created_tab_ids, [staleId]);
    } finally {
        await unmarkManagedTab(staleId);
        await unmarkManagedTab(currentId);
        restore();
    }
});

test('C4 created-page injection arguments survive Chrome JSON serialization', async (t) => {
    const tab = { id: 1904, url: 'https://example.com/created' };
    let result;
    let argumentsSeen;
    const restore = installGlobals({
        chrome: {
            tabs: { get: async () => tab },
            storage: createStorage(),
            scripting: {
                async executeScript({ args }) {
                    assert.deepEqual(JSON.parse(JSON.stringify(args)), args, 'Chrome rejects unserializable args');
                    argumentsSeen = args;
                    return [{ result }];
                },
            },
        },
    });
    try {
        await markManagedTab(tab.id, true);
        const content = new ContentHandler({});
        for (const [method, params, expectedArgs, expectedResult] of [
            ['readPage', {}, ['all', 15, null, null, null], { pageContent: 'fixture' }],
            ['find', {}, [null, null, null, null, null], []],
            ['find', { matchIndex: 0 }, [null, null, null, null, null, 0], []],
            ['getText', {}, [null, null, null], { text: 'fixture' }],
            ['getHtml', {}, [null, true, null, null], { html: '<main>fixture</main>' }],
            ['getHtmlWithImages', {}, [null, true, null, null], { html: '', images: [] }],
            ['getAttribute', { attribute: 'href' }, [null, null, 'href', null], { value: null }],
            ['getMetadata', {}, [null], { title: 'fixture' }],
            ['getComputedStyleAction', { refId: 'ref_1', prop: 'color' }, ['ref_1', 'color', null], 'red'],
            ['evaluate', { code: '1+1' }, ['1+1'], { success: true, result: '2' }],
            ['evaluate', { code: '1+1', timeout: 0 }, ['1+1', 0], { success: true, result: '2' }],
        ]) {
            await t.test(`${method} ${JSON.stringify(params)}`, async () => {
                result = expectedResult;
                assert.deepEqual(await content[method]({ tabId: tab.id, ...params }, {}), expectedResult);
                assert.deepEqual(argumentsSeen, expectedArgs);
            });
        }
        await t.test('frame snapshots omit absent trailing URL', async () => {
            result = {
                parent: { title: 'fixture' },
                frames: [],
                selectedIndex: null,
                selectionStatus: 'not-requested',
            };
            for (const selection of [undefined, 0, '#test-frame']) {
                assert.deepEqual(await getDomFrameSnapshot(tab.id, 0, selection), result);
                assert.deepEqual(argumentsSeen.slice(1), [selection ?? null, 500]);
            }
            assert.deepEqual(await getDomFrameSnapshot(tab.id, 0, 0, 'document-a', tab.url), result);
            assert.deepEqual(argumentsSeen.slice(1), [0, 500, tab.url]);
        });
    } finally {
        await unmarkManagedTab(tab.id);
        restore();
    }
});

test('C4 injected read functions distinguish absent URL from a mismatched URL', () => {
    const pageAccess = new Error('page access reached');
    const page = new Proxy(
        {},
        {
            get() {
                throw pageAccess;
            },
        }
    );
    const restore = installGlobals({
        location: { href: 'https://example.com/current' },
        document: page,
        window: page,
    });
    try {
        for (const [func, args] of [
            [generateAccessibilityTree, ['all', 15, null, null]],
            [extractText, [null]],
            [extractHtml, [null, true]],
            [extractHtmlWithImages, [null, true]],
            [extractMetadata, []],
            [extractAttribute, ['#fixture', null, 'href']],
            [findElements, [null, null, null]],
            [getComputedStyleFromElement, ['ref_1', 'color']],
        ]) {
            assert.throws(() => func(...args, 'https://example.com/other'), /页面 URL 已变化/, func.name);
            for (const url of [undefined, null, 'https://example.com/current']) {
                assert.throws(
                    () => func(...args, url),
                    (error) => error === pageAccess,
                    func.name
                );
            }
        }
    } finally {
        restore();
    }
});

test('C4 granted reads check the URL inside the selected document', () => {
    const restore = installGlobals({ location: { href: 'https://example.com/after-navigation' } });
    try {
        assert.throws(() => extractText(null, 'https://example.com/approved'), /页面 URL 已变化/);
    } finally {
        restore();
    }
});

test('C4 indexed element reads can locate matches beyond the default find limit', () => {
    class ElementNode {
        constructor(index) {
            this.textContent = `item ${index}`;
            this.tagName = 'DIV';
        }

        getBoundingClientRect() {
            return { x: 0, y: 0, width: 1, height: 1 };
        }
    }
    const elements = Array.from({ length: 240 }, (_, index) => new ElementNode(index));
    const pageWindow = {};
    const pageUrl = 'https://example.com/a';
    const restore = installGlobals({
        window: pageWindow,
        document: {
            body: {},
            querySelectorAll: () => elements,
            createTreeWalker() {
                let index = 0;
                return {
                    nextNode: () =>
                        index < elements.length
                            ? { data: elements[index].textContent, parentElement: elements[index++] }
                            : null,
                };
            },
        },
        NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
        location: { href: pageUrl },
        Element: ElementNode,
    });
    try {
        assert.equal(findElements('.item', 'item', null, pageUrl).length, 50);
        const selected = findElements('.item', 'item', null, pageUrl, null, 68);
        assert.equal(selected.length, 1);
        assert.equal(pageWindow.__mcpElementMap[selected[0].refId].deref(), elements[68]);
        assert.deepEqual(findElements('.item', 'item', null, pageUrl, null, 300), []);
        const textMatch = findElements(null, 'item', null, pageUrl, null, 210);
        assert.equal(textMatch.length, 1);
        assert.equal(pageWindow.__mcpElementMap[textMatch[0].refId].deref(), elements[210]);
        assert.throws(() => findElements('.item', null, null, 'https://example.com/b', null, 68), /页面 URL 已变化/);
    } finally {
        restore();
    }
});

test('C02 Extension evaluate waits for Promise results before serialization', async () => {
    class DomNode {}
    const restore = installGlobals({
        Node: DomNode,
        Element: class extends DomNode {},
        NodeList: class {},
        HTMLCollection: class {},
    });
    try {
        assert.equal(EvaluateSchema.parse({ code: 'true', timeout: 10 }).timeout, 10);
        assert.deepEqual(await executeCode('Promise.resolve(false)'), { success: true, result: 'false' });
        assert.deepEqual(await executeCode('(async () => ({ ready: true }))()'), {
            success: true,
            result: '{"ready":true}',
        });
        assert.deepEqual(await executeCode('Promise.reject(new Error("predicate failed"))'), {
            success: false,
            error: 'predicate failed',
        });
        assert.deepEqual(await executeCode('new Promise(() => {})', 10), {
            success: false,
            error: 'Evaluation timeout after 10ms',
        });
    } finally {
        restore();
    }
});

test('C05 policy changes invalidate pending health checks', async () => {
    const storage = createStorage({ mcp_allow_insecure_no_token_v2: true });
    const restore = installGlobals({
        chrome: { storage, runtime: { getURL: (path) => path, getManifest: () => ({ version: 'test' }) } },
        WebSocket: FakeWebSocket,
        fetch: (_url, { signal }) =>
            new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new globalThis.DOMException('aborted', 'AbortError')), {
                    once: true,
                });
            }),
    });
    try {
        const client = new HttpClient();
        const connecting = client.connect();
        await waitUntil(() => client.pendingHealthChecks.size === 78);
        await client.setAllowInsecureNoToken(false);
        assert.equal(client.pendingHealthChecks.size, 0);
        assert.deepEqual(await connecting, { connected: 0, ports: [] });
        assert.equal(client.isConnected(), false);
    } finally {
        restore();
    }
});

test('C05 policy changes close and invalidate pending WebSocket handshakes', async () => {
    FakeWebSocket.instances = [];
    const storage = createStorage({ mcp_allow_insecure_no_token_v2: true });
    const restore = installGlobals({
        chrome: { storage, runtime: { getURL: (path) => path, getManifest: () => ({ version: 'test' }) } },
        WebSocket: FakeWebSocket,
        fetch: async (url) => ({
            ok: String(url).includes(':19222/'),
            async json() {
                return { status: 'ok', authRequired: false };
            },
        }),
    });
    try {
        const client = new HttpClient();
        const connecting = client.connect();
        await waitUntil(() => FakeWebSocket.instances.length === 1);
        const socket = FakeWebSocket.instances[0];
        await client.setAllowInsecureNoToken(false);
        assert.equal(socket.readyState, FakeWebSocket.CLOSED);
        socket.open();
        assert.deepEqual(await connecting, { connected: 0, ports: [] });
        assert.equal(client.isConnected(), false);
    } finally {
        restore();
    }
});

test('C05 policy changes cancel scheduled reconnects', async () => {
    FakeWebSocket.instances = [];
    const storage = createStorage({ mcp_allow_insecure_no_token_v2: true });
    const restore = installGlobals({
        chrome: { storage, runtime: { getURL: (path) => path, getManifest: () => ({ version: 'test' }) } },
        WebSocket: FakeWebSocket,
        fetch: async () => ({ ok: false, async json() {} }),
    });
    try {
        const client = new HttpClient();
        await client.connect();
        assert.notEqual(client.reconnectTimer, null);
        await client.setAllowInsecureNoToken(false);
        assert.equal(client.reconnectTimer, null);
    } finally {
        restore();
    }
});

test('C05 policy changes invalidate sockets before storage persistence settles', async () => {
    FakeWebSocket.instances = [];
    const storageWrite = createDeferred();
    const storage = createStorage({ mcp_allow_insecure_no_token_v2: true });
    storage.local.set = () => storageWrite.promise;
    const restore = installGlobals({
        chrome: { storage, runtime: { getURL: (path) => path, getManifest: () => ({ version: 'test' }) } },
        WebSocket: FakeWebSocket,
        fetch: async (url) => ({
            ok: String(url).includes(':19222/'),
            async json() {
                return { status: 'ok', authRequired: false };
            },
        }),
    });
    try {
        const client = new HttpClient();
        const connecting = client.connect();
        await waitUntil(() => FakeWebSocket.instances.length === 1);
        const socket = FakeWebSocket.instances[0];
        const update = client.setAllowInsecureNoToken(false);
        const updateFailure = assert.rejects(update, /storage write failed/);
        assert.equal(socket.readyState, FakeWebSocket.CLOSED);
        socket.open();
        assert.equal(client.isConnected(), false);
        storageWrite.reject(new Error('storage write failed'));
        await updateFailure;
        assert.deepEqual(await connecting, { connected: 0, ports: [] });
    } finally {
        restore();
    }
});

test('C05 stale socket close cannot remove a replacement connection on the same port', () => {
    FakeWebSocket.instances = [];
    const client = new HttpClient();
    const oldSocket = new FakeWebSocket('ws://127.0.0.1:19222/old');
    const replacement = new FakeWebSocket('ws://127.0.0.1:19222/new');
    client.connections.set(19222, { ws: replacement, heartbeatTimer: null });
    oldSocket.onclose = () => client.removeConnection(19222, oldSocket);
    oldSocket.onclose();
    assert.equal(client.connections.get(19222).ws, replacement);
    client.disconnect();
});

test('C06 rebuilt managed windows do not reuse stale group snapshots', async () => {
    setMcpWindowId(null);
    setMcpTabGroupId(null);
    const tabs = new Map([
        [1, { id: 1, url: 'https://user.example', title: 'user', active: true, windowId: 100, index: 0, groupId: 99 }],
    ]);
    const groupCalls = [];
    const storage = createStorage();
    const restore = installGlobals({
        chrome: {
            storage,
            windows: {
                async get(windowId) {
                    return { id: windowId };
                },
                async create() {
                    const initial = {
                        id: 2000,
                        url: 'about:blank',
                        title: '',
                        active: true,
                        windowId: 200,
                        index: 0,
                        groupId: -1,
                    };
                    tabs.set(initial.id, initial);
                    return { id: 200, tabs: [initial] };
                },
            },
            tabs: {
                async query({ windowId }) {
                    return [...tabs.values()].filter((tab) => tab.windowId === windowId);
                },
                async create(props) {
                    const tab = {
                        id: 2001,
                        url: props.url,
                        title: '',
                        active: props.active,
                        windowId: props.windowId,
                        index: 1,
                        groupId: -1,
                        pinned: false,
                        incognito: false,
                        status: 'complete',
                    };
                    tabs.set(tab.id, tab);
                    return tab;
                },
                async remove(tabId) {
                    tabs.delete(tabId);
                },
                async group(options) {
                    groupCalls.push({ ...options });
                    const tab = tabs.get(options.tabIds[0]);
                    if (options.groupId !== undefined) {
                        tab.groupId = options.groupId;
                        tab.windowId = 100;
                        return options.groupId;
                    }
                    tab.groupId = 20;
                    return 20;
                },
                async get(tabId) {
                    return { ...tabs.get(tabId) };
                },
            },
            tabGroups: { async update() {} },
        },
    });
    try {
        const handler = new TabHandler({ waitForNavigation: async () => {} });
        const result = await handler.tabsCreate(
            { url: 'https://test.example', active: false },
            { mcpWindowId: 100, mcpTabGroupId: 10 }
        );
        assert.equal(groupCalls[0].groupId, undefined);
        assert.equal(result.windowId, 200);
        assert.equal(result.groupId, 20);
        assert.equal(result.index, 1);
    } finally {
        restore();
        setMcpWindowId(null);
        setMcpTabGroupId(null);
    }
});

test('C07 fallback console survives a Service Worker restart without duplicate logs or wrapper loss', async () => {
    const originalCalls = [];
    const pageConsole = {};
    for (const level of ['log', 'warn', 'error', 'info', 'debug']) {
        pageConsole[level] = (...args) => originalCalls.push({ level, args });
    }
    const page = vm.createContext({
        console: pageConsole,
        window: {},
        Reflect,
        Array,
        Date,
        String,
    });
    const createLogManager = () => {
        const consoleMessages = new Map();
        return {
            hasConsole: (tabId) => consoleMessages.has(tabId),
            getConsole: (tabId) => consoleMessages.get(tabId) ?? [],
            setConsole: (tabId, messages) => consoleMessages.set(tabId, messages),
        };
    };
    let attachBlocked = true;
    const storage = createStorage();
    const restore = installGlobals({
        chrome: {
            storage,
            tabs: {
                async get() {
                    return { id: 1, url: 'https://test.example', groupId: 10 };
                },
            },
            debugger: {
                async attach() {
                    if (attachBlocked) {
                        throw new Error('Another debugger is already attached');
                    }
                },
                async sendCommand() {},
            },
            scripting: {
                async executeScript({ func }) {
                    const result = vm.runInContext(`(${func.toString()})()`, page);
                    return [{ result: await result }];
                },
            },
        },
    });
    try {
        const firstLogManager = createLogManager();
        const firstHandler = new LogEventHandler(firstLogManager, new DebuggerManager(firstLogManager));
        const context = { mcpWindowId: null, mcpTabGroupId: 10 };
        await firstHandler.consoleEnable({ tabId: 1 }, context);
        vm.runInContext("console.log('before-clear')", page);
        await firstHandler.consoleClear({ tabId: 1 }, context);
        vm.runInContext("console.log('after-clear')", page);
        const beforeRestart = await firstHandler.consoleGet({ tabId: 1 }, context);
        assert.deepEqual(
            beforeRestart.messages.map((message) => message.text),
            ['after-clear']
        );

        vm.runInContext(
            `window.laterErrorCalls = 0;
             window.mcpWrappedError = console.error;
             window.laterError = (...args) => {
                 window.laterErrorCalls++;
                 window.mcpWrappedError(...args);
             };
             console.error = window.laterError;
             console.error('before-restart');`,
            page
        );

        attachBlocked = false;
        const restartedLogManager = createLogManager();
        const restartedHandler = new LogEventHandler(restartedLogManager, new DebuggerManager(restartedLogManager));
        await restartedHandler.consoleEnable({ tabId: 1 }, context);
        assert.equal(vm.runInContext('window.__mcpConsoleHook', page), undefined);
        assert.equal(vm.runInContext('console.error === window.laterError', page), true);
        assert.equal(vm.runInContext('window.laterErrorCalls', page), 1);

        vm.runInContext("console.error('after-uninstall')", page);
        assert.equal(vm.runInContext('window.laterErrorCalls', page), 2);
        assert.equal(originalCalls.at(-1).args[0], 'after-uninstall');

        const afterRestart = await restartedHandler.consoleGet({ tabId: 1 }, context);
        const repeatedRead = await restartedHandler.consoleGet({ tabId: 1 }, context);
        assert.deepEqual(
            afterRestart.messages.map((message) => message.text),
            ['before-restart']
        );
        assert.deepEqual(
            repeatedRead.messages.map((message) => message.text),
            ['before-restart']
        );
    } finally {
        restore();
    }
});

test('C07 concurrent console reads cannot overwrite a later fallback drain', async () => {
    const page = vm.createContext({
        window: {
            __mcpConsoleHook: {
                logs: [{ source: 'console-api', level: 'log', text: 'old-log', timestamp: 1 }],
            },
        },
        Array,
    });
    const consoleMessages = new Map();
    const logManager = {
        hasConsole: (tabId) => consoleMessages.has(tabId),
        getConsole: (tabId) => consoleMessages.get(tabId) ?? [],
        setConsole: (tabId, messages) => consoleMessages.set(tabId, messages),
    };
    const firstResult = createDeferred();
    let executeCalls = 0;
    const restore = installGlobals({
        chrome: {
            tabs: {
                async get() {
                    return { id: 1, url: 'https://test.example', groupId: 10 };
                },
            },
            scripting: {
                async executeScript({ func }) {
                    executeCalls++;
                    const result = vm.runInContext(`(${func.toString()})()`, page);
                    if (executeCalls === 1) {
                        await firstResult.promise;
                    }
                    return [{ result }];
                },
            },
        },
    });
    try {
        const handler = new LogEventHandler(logManager, {});
        const context = { mcpWindowId: null, mcpTabGroupId: 10 };
        const firstRead = handler.consoleGet({ tabId: 1 }, context);
        await waitUntil(() => executeCalls === 1);
        page.window.__mcpConsoleHook.logs.push({
            source: 'console-api',
            level: 'log',
            text: 'new-log',
            timestamp: 2,
        });
        const secondRead = handler.consoleGet({ tabId: 1 }, context);
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
        assert.equal(executeCalls, 1);

        firstResult.resolve();
        const [first, second] = await Promise.all([firstRead, secondRead]);
        assert.deepEqual(
            first.messages.map((message) => message.text),
            ['old-log']
        );
        assert.deepEqual(
            second.messages.map((message) => message.text),
            ['old-log', 'new-log']
        );
        assert.deepEqual(
            logManager.getConsole(1).map((message) => message.text),
            ['old-log', 'new-log']
        );
    } finally {
        restore();
    }
});

test('C08 networkidle rejects while requests remain pending and honors the quiet window', async () => {
    const pending = new Map([['request-1', {}]]);
    const onCommitted = chromeEvent();
    const onDOMContentLoaded = chromeEvent();
    const onCompleted = chromeEvent();
    const restore = installGlobals({
        chrome: {
            tabs: {
                async get() {
                    return { status: 'complete' };
                },
            },
            webNavigation: { onCommitted, onDOMContentLoaded, onCompleted },
        },
    });
    try {
        const logManager = { getPending: () => pending, isPendingUncertain: () => false };
        const handler = new NavigationHandler(logManager);
        await assert.rejects(() => handler.waitForNavigation(1, 'networkidle', 40), /Navigation timeout/);

        globalThis.setTimeout(() => pending.clear(), 30);
        const startedAt = Date.now();
        await handler.waitForNavigation(1, 'networkidle', 1000);
        assert.ok(Date.now() - startedAt >= 500);
    } finally {
        restore();
    }
});

test('C08 long-running requests remain pending after the diagnostic sweep', () => {
    const originalSetInterval = globalThis.setInterval;
    const originalWarn = globalThis.console.warn;
    const warnings = [];
    globalThis.setInterval = () => 0;
    globalThis.console.warn = (message) => warnings.push(message);
    const manager = new LogManager();
    globalThis.setInterval = originalSetInterval;
    try {
        manager.handleEvent(1, 'Network.requestWillBeSent', {
            requestId: 'long-request',
            request: { url: 'https://example.com/stream', method: 'GET' },
            type: 'Fetch',
            timestamp: 1,
            wallTime: 10,
        });
        manager.getPending(1).get('long-request')._addedAt = Date.now() - 61_000;
        manager.sweepPending();
        manager.sweepPending();
        assert.equal(manager.getPending(1).size, 1);
        assert.equal(warnings.length, 1);

        manager.handleEvent(1, 'Network.loadingFinished', { requestId: 'long-request', timestamp: 62 });
        assert.equal(manager.getPending(1), undefined);
    } finally {
        globalThis.console.warn = originalWarn;
    }
});

test('C08 pending capacity loss makes networkidle uncertain until tab cleanup', async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalWarn = globalThis.console.warn;
    globalThis.setInterval = () => 0;
    globalThis.console.warn = () => {};
    const manager = new LogManager();
    globalThis.setInterval = originalSetInterval;
    try {
        for (let index = 0; index <= 500; index++) {
            manager.handleEvent(1, 'Network.requestWillBeSent', {
                requestId: `request-${index}`,
                request: { url: `https://example.com/${index}`, method: 'GET' },
                type: 'Fetch',
                timestamp: index,
                wallTime: index,
            });
        }
        assert.equal(manager.getPending(1).size, 500);
        assert.equal(manager.isPendingUncertain(1), true);
        for (let index = 1; index <= 500; index++) {
            manager.handleEvent(1, 'Network.loadingFinished', {
                requestId: `request-${index}`,
                timestamp: index + 1,
            });
        }
        assert.equal(manager.getPending(1), undefined);

        const restoreChrome = installGlobals({
            chrome: {
                tabs: {
                    async get() {
                        return { status: 'complete' };
                    },
                },
                webNavigation: {
                    onCommitted: chromeEvent(),
                    onDOMContentLoaded: chromeEvent(),
                    onCompleted: chromeEvent(),
                },
            },
        });
        try {
            const handler = new NavigationHandler(manager);
            await assert.rejects(() => handler.waitForNavigation(1, 'networkidle', 40), /Navigation timeout/);
        } finally {
            restoreChrome();
        }

        manager.cleanupTab(1);
        assert.equal(manager.isPendingUncertain(1), false);
    } finally {
        globalThis.console.warn = originalWarn;
    }
});

test('C08 debugger detach keeps network tracking uncertain until a new root document', async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalLog = globalThis.console.log;
    globalThis.setInterval = () => 0;
    globalThis.console.log = () => {};
    const manager = new LogManager();
    globalThis.setInterval = originalSetInterval;
    const onDetach = chromeEvent();
    const onEvent = chromeEvent();
    const restore = installGlobals({
        chrome: {
            debugger: {
                onDetach,
                onEvent,
                async attach() {},
            },
            tabs: {
                async get() {
                    return { status: 'complete' };
                },
            },
            webNavigation: {
                onCommitted: chromeEvent(),
                onDOMContentLoaded: chromeEvent(),
                onCompleted: chromeEvent(),
            },
        },
    });
    try {
        const debuggerManager = new DebuggerManager(manager);
        debuggerManager.setupListeners();
        await debuggerManager.ensureAttached(1);
        manager.setMainFrameId(1, 'main-frame');
        manager.handleEvent(1, 'Network.requestWillBeSent', {
            requestId: 'lost-request',
            request: { url: 'https://example.com/stream', method: 'GET' },
            type: 'Fetch',
            frameId: 'main-frame',
            timestamp: 1,
            wallTime: 10,
        });

        onDetach.emit({ tabId: 1 }, 'target_closed');
        assert.equal(manager.getPending(1), undefined);
        assert.equal(manager.isPendingUncertain(1), true);
        await assert.rejects(
            () => new NavigationHandler(manager).waitForNavigation(1, 'networkidle', 40),
            /Navigation timeout/
        );

        manager.handleEvent(1, 'Page.frameNavigated', { frame: { id: 'new-main-frame' } });
        manager.handleEvent(1, 'Network.requestWillBeSent', {
            requestId: 'new-document',
            request: { url: 'https://example.com/next', method: 'GET' },
            type: 'Document',
            frameId: 'new-main-frame',
            timestamp: 2,
            wallTime: 11,
        });
        assert.equal(manager.isPendingUncertain(1), false);
        assert.equal(manager.getPending(1).size, 1);

        manager.handleDebuggerDetach(1);
        assert.equal(manager.isPendingUncertain(1), true);
        manager.cleanupTab(1);
        assert.equal(manager.isPendingUncertain(1), false);
    } finally {
        globalThis.console.log = originalLog;
        restore();
    }
});

test('Extension context loss and error-page injection remain explicit failures without replay', async () => {
    const tab = { id: 9801, url: 'https://example.com/' };
    let debuggerCalls = 0;
    let injections = 0;
    let debuggerError = new Error('{"code":-32000,"message":"Cannot find context with specified id"}');
    let injectionError = new Error('Frame with ID 0 is showing error page');
    const restore = installGlobals({
        chrome: {
            storage: createStorage(),
            tabs: {
                async get() {
                    return tab;
                },
            },
            debugger: {
                async sendCommand() {
                    debuggerCalls++;
                    throw debuggerError;
                },
            },
            scripting: {
                async executeScript() {
                    injections++;
                    throw injectionError;
                },
            },
        },
    });
    try {
        await markManagedTab(tab.id, true);
        const debuggerHandler = new DebuggerHandler({ async ensureAttached() {} }, {});
        await assert.rejects(
            () =>
                debuggerHandler.debuggerSend(
                    { tabId: tab.id, method: 'Runtime.evaluate', params: { expression: '1' } },
                    {}
                ),
            (error) => error instanceof ExpectedOperationError && error.message.includes('Cannot find context')
        );
        assert.equal(debuggerCalls, 1);
        debuggerError = new Error('unexpected debugger defect');
        await assert.rejects(
            () => debuggerHandler.debuggerSend({ tabId: tab.id, method: 'Runtime.evaluate' }, {}),
            (error) => error === debuggerError
        );
        const contentHandler = new ContentHandler({
            async ensureAttached() {
                assert.fail('failed dimension reads must not attach the debugger');
            },
        });
        const actions = [
            () => contentHandler.getText({ tabId: tab.id }, {}),
            () => contentHandler.getViewportMetrics({ tabId: tab.id }, {}),
            () =>
                contentHandler.inspectChallenge(
                    {
                        tabId: tab.id,
                        challengeSelectors: [],
                        deniedSelectors: [],
                        widgetSelectors: [],
                        verifyButtonSelectors: [],
                        frameSelectors: [],
                        titleNeedles: [],
                        textMarkers: [],
                        originResponsePendingTextMarkers: [],
                    },
                    {}
                ),
            () => contentHandler.screenshot({ tabId: tab.id }, {}),
        ];
        for (const action of actions) {
            const before = injections;
            for (const message of ['Frame with ID 0 is showing error page', 'Cannot access a chrome:// URL']) {
                injectionError = new Error(message);
                await assert.rejects(
                    action,
                    (error) => error instanceof ExpectedOperationError && error.message === message
                );
            }
            injectionError = new Error('unexpected injection defect');
            await assert.rejects(action, (error) => error === injectionError);
            assert.equal(injections, before + 3);
        }
        assert.equal(debuggerCalls, 2);
    } finally {
        await unmarkManagedTab(tab.id);
        restore();
    }
});

test('Extension history uses fallback only for scriptable no-history pages and cleans failed waits', async () => {
    for (const direction of ['back', 'forward']) {
        for (const scenario of [
            'native',
            'native-restricted',
            'restricted',
            'error-page',
            'missing-frame',
            'fallback',
            'unexpected',
            'injection-error',
        ]) {
            const native = scenario === 'native' || scenario === 'native-restricted';
            const tab = {
                id: 9802,
                url:
                    scenario === 'restricted' || scenario === 'native-restricted'
                        ? 'chrome://settings/'
                        : 'https://example.com/current',
            };
            const onUpdated = chromeEvent();
            const onCommitted = chromeEvent();
            let injections = 0;
            const nativeError = new Error(
                scenario === 'unexpected' ? 'native navigation defect' : 'Cannot find a next page in history'
            );
            const navigate = () => {
                tab.url = 'https://example.com/previous';
                onUpdated.emit(tab.id, { url: tab.url });
            };
            const restore = installGlobals({
                chrome: {
                    storage: createStorage(),
                    tabs: {
                        async get() {
                            return tab;
                        },
                        onUpdated,
                        async goBack() {
                            if (native) {
                                navigate();
                            } else {
                                throw nativeError;
                            }
                        },
                        async goForward() {
                            if (native) {
                                navigate();
                            } else {
                                throw nativeError;
                            }
                        },
                    },
                    webNavigation: {
                        onCommitted,
                        async getFrame() {
                            return scenario === 'missing-frame' ? null : { errorOccurred: scenario === 'error-page' };
                        },
                    },
                    scripting: {
                        async executeScript() {
                            injections++;
                            if (scenario === 'injection-error') {
                                throw new Error('Frame with ID 0 is showing error page');
                            }
                            navigate();
                        },
                    },
                },
            });
            try {
                await markManagedTab(tab.id, true);
                const handler = new NavigationHandler({});
                const action = () =>
                    handler[direction === 'back' ? 'goBack' : 'goForward']({ tabId: tab.id, timeout: 1 }, {});
                if (scenario === 'unexpected') {
                    await assert.rejects(action, (error) => error === nativeError);
                } else if (scenario === 'injection-error') {
                    await assert.rejects(
                        action,
                        (error) =>
                            error instanceof ExpectedOperationError && error.message.includes('showing error page')
                    );
                } else {
                    const result = await action();
                    assert.equal(result.navigated, native || scenario === 'fallback', `${direction}/${scenario}`);
                }
                assert.equal(
                    injections,
                    scenario === 'fallback' || scenario === 'injection-error' ? 1 : 0,
                    `${direction}/${scenario}`
                );
                assert.equal(onUpdated.size, 0, `${direction}/${scenario}`);
                assert.equal(onCommitted.size, 0, `${direction}/${scenario}`);
            } finally {
                await unmarkManagedTab(tab.id);
                restore();
            }
        }
    }
});

test('C04 Extension navigation waits for the lifecycle of the newly committed document', async () => {
    const onCommitted = chromeEvent();
    const onDOMContentLoaded = chromeEvent();
    const onCompleted = chromeEvent();
    const onHistoryStateUpdated = chromeEvent();
    const onReferenceFragmentUpdated = chromeEvent();
    const restore = installGlobals({
        chrome: {
            webNavigation: {
                onCommitted,
                onDOMContentLoaded,
                onCompleted,
                onHistoryStateUpdated,
                onReferenceFragmentUpdated,
            },
        },
    });
    try {
        const handler = new NavigationHandler({
            getPending: () => undefined,
            isPendingUncertain: () => false,
        });
        await handler.runNavigationAction(7, 'domcontentloaded', 1000, async () => {
            assert.equal(onCommitted.size, 1);
            assert.equal(onDOMContentLoaded.size, 1);
            onDOMContentLoaded.emit({ tabId: 7, frameId: 0, documentId: 'previous-document' });
            onCommitted.emit({ tabId: 7, frameId: 0, documentId: 'current-document' });
            onCompleted.emit({ tabId: 7, frameId: 0, documentId: 'previous-document' });
            onDOMContentLoaded.emit({ tabId: 7, frameId: 0, documentId: 'current-document' });
        });
        assert.equal(onCommitted.size, 0);
        assert.equal(onDOMContentLoaded.size, 0);
        assert.equal(onCompleted.size, 0);
    } finally {
        restore();
    }
});

test('C04 Extension same-document navigation rejects stale document and URL events', async () => {
    const onCommitted = chromeEvent();
    const onDOMContentLoaded = chromeEvent();
    const onCompleted = chromeEvent();
    const onHistoryStateUpdated = chromeEvent();
    const onReferenceFragmentUpdated = chromeEvent();
    const restore = installGlobals({
        chrome: {
            webNavigation: {
                onCommitted,
                onDOMContentLoaded,
                onCompleted,
                onHistoryStateUpdated,
                onReferenceFragmentUpdated,
                async getFrame() {
                    return { documentId: 'baseline-document' };
                },
            },
        },
    });
    try {
        const handler = new NavigationHandler({
            getPending: () => undefined,
            isPendingUncertain: () => false,
        });
        let actionRan = false;
        let operationSettled = false;
        const operation = handler.runNavigationAction(
            7,
            'load',
            1000,
            async () => {
                actionRan = true;
                onHistoryStateUpdated.emit({
                    tabId: 7,
                    frameId: 0,
                    documentId: 'stale-document',
                    url: 'https://example.com/path#target',
                });
                onReferenceFragmentUpdated.emit({
                    tabId: 7,
                    frameId: 0,
                    documentId: 'baseline-document',
                    url: 'https://example.com/path#other',
                });
            },
            'HTTPS://EXAMPLE.COM:443/path#target'
        );
        operation.then(
            () => {
                operationSettled = true;
            },
            () => {
                operationSettled = true;
            }
        );
        await waitUntil(() => actionRan);
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
        assert.equal(operationSettled, false);

        onHistoryStateUpdated.emit({
            tabId: 7,
            frameId: 0,
            documentId: 'baseline-document',
            url: 'https://example.com/path#target',
        });
        await operation;
        assert.equal(onHistoryStateUpdated.size, 0);
        assert.equal(onReferenceFragmentUpdated.size, 0);
    } finally {
        restore();
    }
});

test('C04 Extension navigation still reports an action failure after the lifecycle event', async () => {
    const onCommitted = chromeEvent();
    const onDOMContentLoaded = chromeEvent();
    const onCompleted = chromeEvent();
    const onHistoryStateUpdated = chromeEvent();
    const onReferenceFragmentUpdated = chromeEvent();
    const restore = installGlobals({
        chrome: {
            webNavigation: {
                onCommitted,
                onDOMContentLoaded,
                onCompleted,
                onHistoryStateUpdated,
                onReferenceFragmentUpdated,
            },
        },
    });
    try {
        const handler = new NavigationHandler({
            getPending: () => undefined,
            isPendingUncertain: () => false,
        });
        await assert.rejects(
            () =>
                handler.runNavigationAction(7, 'load', 1000, async () => {
                    onCommitted.emit({ tabId: 7, frameId: 0, documentId: 'current-document' });
                    onCompleted.emit({ tabId: 7, frameId: 0, documentId: 'current-document' });
                    throw new Error('reload failed');
                }),
            /reload failed/
        );
    } finally {
        restore();
    }
});

test('C09 and C10 keep Challenge state on the main frame and finalize requests at body completion', () => {
    const originalSetInterval = globalThis.setInterval;
    globalThis.setInterval = () => 0;
    const manager = new LogManager();
    globalThis.setInterval = originalSetInterval;

    manager.setMainFrameId(1, 'main-frame');
    manager.handleEvent(1, 'Network.requestWillBeSent', {
        requestId: 'main-challenge',
        request: { url: 'https://example.com', method: 'GET' },
        type: 'Document',
        frameId: 'main-frame',
        timestamp: 1,
        wallTime: 10,
    });
    manager.handleEvent(1, 'Network.responseReceived', {
        requestId: 'main-challenge',
        response: { status: 200, headers: { 'cf-mitigated': 'challenge' } },
        timestamp: 1.1,
    });
    assert.equal(manager.isChallengeRequired(1), true);
    assert.equal(manager.getPending(1).size, 1);
    assert.equal(manager.getNetwork(1).length, 0);

    manager.handleEvent(1, 'Network.requestWillBeSent', {
        requestId: 'child-normal',
        request: { url: 'https://example.com/frame', method: 'GET' },
        type: 'Document',
        frameId: 'child-frame',
        timestamp: 2,
        wallTime: 11,
    });
    manager.handleEvent(1, 'Network.responseReceived', {
        requestId: 'child-normal',
        response: { status: 204, headers: {} },
        timestamp: 2.1,
    });
    assert.equal(manager.isChallengeRequired(1), true);

    manager.handleEvent(1, 'Network.loadingFailed', {
        requestId: 'main-challenge',
        timestamp: 1.4,
        errorText: 'net::ERR_CONTENT_LENGTH_MISMATCH',
    });
    assert.deepEqual(manager.getNetwork(1)[0], {
        sequence: 1,
        url: 'https://example.com',
        method: 'GET',
        type: 'Document',
        timestamp: 10000,
        status: 200,
        challenge: true,
        errorText: 'net::ERR_CONTENT_LENGTH_MISMATCH',
        duration: 400,
    });
    assert.equal(manager.getPending(1).size, 1);

    manager.handleEvent(1, 'Network.loadingFinished', { requestId: 'child-normal', timestamp: 2.5 });
    assert.equal(manager.getPending(1), undefined);

    manager.handleEvent(1, 'Network.requestWillBeSent', {
        requestId: 'main-normal',
        request: { url: 'https://example.com/home', method: 'GET' },
        type: 'Document',
        frameId: 'main-frame',
        timestamp: 3,
        wallTime: 12,
    });
    manager.handleEvent(1, 'Network.responseReceived', {
        requestId: 'main-normal',
        response: { status: 200, headers: {} },
        timestamp: 3.1,
    });
    assert.equal(manager.isChallengeRequired(1), false);
});

test('C11 actionable clicks use DOM dispatch without invoking React private handlers', () => {
    let reactCalls = 0;
    const events = [];
    const element = {
        __reactProps$test: { onClick: () => reactCalls++ },
        getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 40 }),
        focus() {},
        dispatchEvent(event) {
            events.push(event.type);
            return true;
        },
    };
    class FakeMouseEvent {
        constructor(type) {
            this.type = type;
        }
    }
    const pageWindow = {
        __mcpElementMap: { target: new WeakRef(element) },
        __mcpActionability: {
            check: () => ({ actionable: true }),
            scrollIntoViewWithRetry: () => ({ actionable: true }),
        },
    };
    const restore = installGlobals({ window: pageWindow, MouseEvent: FakeMouseEvent });
    try {
        assert.deepEqual(performActionableClick('target', false), { success: true });
        assert.deepEqual(events, ['mousedown', 'mouseup', 'click']);
        assert.equal(reactCalls, 0);
        assert.equal(element.__reactProps$test.onClick instanceof Function, true);
    } finally {
        restore();
    }
});

test('C12 cookie clear counts only confirmed removals', async () => {
    const outcomes = [{ name: 'removed' }, undefined, null];
    const restore = installGlobals({
        chrome: {
            cookies: {
                async getAll() {
                    return [
                        { name: 'a', secure: true, domain: '.example.com', path: '/' },
                        { name: 'b', secure: false, domain: 'example.com', path: '/' },
                        { name: 'c', secure: false, domain: 'example.com', path: '/' },
                        { name: 'd', secure: false, domain: 'example.com', path: '/' },
                    ];
                },
                async remove() {
                    if (outcomes.length > 0) {
                        return outcomes.shift();
                    }
                    throw new Error('already gone');
                },
            },
        },
    });
    try {
        assert.deepEqual(await new CookieHandler().cookiesClear({ domain: 'example.com' }), {
            success: true,
            count: 1,
        });
    } finally {
        restore();
    }
});
