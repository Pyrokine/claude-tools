import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { installDomHelpers } from '../../src/core/dom-helpers.ts';
import './browser-events.test.js';
import './review-input.test.js';
import './review-c31-wheel.test.js';
import './review-c31-cookies.test.js';
import './review-c31f2-cookies.test.js';
import './review-c31f3-management.test.js';
import tabStateSource from '../src/background/tab-state.ts?raw';
import backgroundSource from '../src/background/index.ts?raw';

import { ActionHandler } from '../src/background/actions.ts';
import {
    assertManagedTab,
    assertReadableTab,
    assertScriptable,
    getDomFrameSnapshot,
    getTargetTabId,
    probeCdpFrameOwner,
    recordDomFrameProbe,
} from '../src/background/action-utils.ts';
import { ContentHandler } from '../src/background/content-handler.ts';
import { CookieHandler } from '../src/background/cookie-handler.ts';
import { DebuggerBlockedError, DebuggerManager } from '../src/background/debugger-manager.ts';
import { DebuggerHandler } from '../src/background/debugger-handler.ts';
import { FrameResolver } from '../src/background/frame-resolver.ts';
import { ExpectedOperationError } from '../src/types/expected-errors.ts';
import { HttpClient } from '../src/background/http-client.ts';
import { InputEventHandler } from '../src/background/input-event-handler.ts';
import { StealthHandler } from '../src/background/stealth-handler.ts';
import { LogEventHandler } from '../src/background/log-event-handler.ts';
import { LogManager } from '../src/background/log-manager.ts';
import { NavigationHandler } from '../src/background/navigation-handler.ts';
import { advancePageRevision, forgetPageRevision, pageSnapshot } from '../src/background/page-revision.ts';
import {
    hasReadGrant,
    readGrantDocumentId,
    revokeReadGrants,
    revokeTabReadGrants,
    setReadGrant,
} from '../src/background/read-grants.ts';
import {
    dispatchInputToElement,
    executeCode,
    extractAttribute,
    extractHtml,
    extractHtmlWithImages,
    extractMetadata,
    extractText,
    findElements,
    generateAccessibilityTree,
    getComputedStyleFromElement,
    inspectChallengePage,
    installFrameProbeListener,
    performActionableClick,
    simulateKeyboardType,
    simulateMouseClick,
    simulateMouseEvent,
} from '../src/background/page-scripts.ts';
import { TabHandler } from '../src/background/tab-handler.ts';
import {
    isManagedTab,
    markManagedTab,
    restoreManagedTabs,
    setMcpTabGroupId,
    setMcpWindowId,
    unmarkManagedTab,
} from '../src/background/tab-state.ts';
import { EvaluateSchema, FindSchema, InputTypeSchema, NavigateSchema } from '../src/types/schemas.ts';

/**
 * @param {Partial<import('../src/background/action-utils.ts').ActionContext>} [overrides]
 * @returns {import('../src/background/action-utils.ts').ActionContext}
 */
function createActionContext(overrides = {}) {
    return {
        ...overrides,
        serverInstanceId: overrides.serverInstanceId ?? 'regression-server',
        mcpTabGroupId: overrides.mcpTabGroupId ?? null,
        mcpWindowId: overrides.mcpWindowId ?? null,
    };
}

test.before(async () => {
    const restore = installGlobals({ chrome: { storage: createStorage(), tabs: { query: async () => [] } } });
    try {
        await restoreManagedTabs();
    } finally {
        restore();
    }
});

async function isolatedBackgroundSource(source, values, exports = []) {
    const transformer = 'rolldown/utils';
    const { transformSync } = await import(/* @vite-ignore */ transformer);
    const result = transformSync('background-fixture.ts', source, { lang: 'ts' });
    assert.deepEqual(result.errors, []);
    const code = result.code.replace(/^import[\s\S]*?from [^\n]+\n/gm, '').replace(/^export /gm, '');
    return vm.runInNewContext(`${code}\n;({${exports.join(',')}})`, {
        crypto: globalThis.crypto,
        console: globalThis.console,
        ...values,
    });
}

/** @returns {Promise<typeof import('../src/background/tab-state.ts')>} */
async function isolatedManagedTabs(chrome, warnings = []) {
    return isolatedBackgroundSource(
        tabStateSource,
        {
            chrome,
            console: { ...globalThis.console, warn: (...args) => warnings.push(args) },
        },
        [...tabStateSource.matchAll(/export (?:async )?function (?<functionName>\w+)/g)].map((match) => match[1])
    );
}

test('Static-analysis schema updates retain finite deadlines and coordinates', () => {
    for (const { schema, base } of [
        { schema: NavigateSchema, base: { url: 'https://example.com/owned' } },
        { schema: InputTypeSchema, base: { text: 'owned' } },
    ]) {
        assert.equal(schema.safeParse({ ...base, deadline: 0 }).success, true);
        for (const value of [NaN, Infinity, -Infinity]) {
            assert.equal(schema.safeParse({ ...base, deadline: value }).success, false);
        }
    }
    assert.equal(FindSchema.safeParse({ point: { x: -1, y: 0 } }).success, true);
    for (const value of [NaN, Infinity, -Infinity]) {
        assert.equal(FindSchema.safeParse({ point: { x: value, y: 0 } }).success, false);
        assert.equal(FindSchema.safeParse({ point: { x: 0, y: value } }).success, false);
    }
});

test('F1 managed documents survive reload only with the exact native identity and release stays revoked', async () => {
    const fixture = createTabManagementFixture();
    let state = await isolatedManagedTabs(fixture.chrome);
    await state.restoreManagedTabs();
    await state.markManagedTab(5001);
    await state.markManagedTab(5002);
    fixture.documents.set(5002, 'replacement-document');
    for (const key of Object.keys(fixture.chrome.storage.sessionValues)) {
        delete fixture.chrome.storage.sessionValues[key];
    }
    state = await isolatedManagedTabs(fixture.chrome);
    await state.restoreManagedTabs();
    assert.equal(state.isManagedTab({ id: 5001 }), true);
    assert.equal(state.isManagedTab({ id: 5002 }), false);
    await state.unmarkManagedTab(5001);
    for (const key of Object.keys(fixture.chrome.storage.sessionValues)) {
        delete fixture.chrome.storage.sessionValues[key];
    }
    state = await isolatedManagedTabs(fixture.chrome);
    await state.restoreManagedTabs();
    assert.equal(state.isManagedTab({ id: 5001 }), false);
});

test('F5 close before restoration cannot erase managed pages and restoration shares one barrier', async () => {
    const fixture = createTabManagementFixture();
    let state = await isolatedManagedTabs(fixture.chrome);
    await state.restoreManagedTabs();
    await state.markManagedTab(5001);
    const get = fixture.chrome.storage.local.get;
    const gate = createDeferred();
    fixture.chrome.storage.local.get = async (...args) => {
        await gate.promise;
        return get(...args);
    };
    state = await isolatedManagedTabs(fixture.chrome);
    const closing = state.unmarkManagedTab(9999);
    const first = state.restoreManagedTabs();
    assert.equal(state.restoreManagedTabs(), first);
    assert.equal(state.isManagedTab({ id: 5001 }), false);
    gate.resolve();
    await Promise.all([first, closing]);
    assert.equal(state.isManagedTab({ id: 5001 }), true);
});

test('F1 document identity is optional for adoption and same-generation Worker recovery', async () => {
    const fixture = createTabManagementFixture();
    const warnings = [];
    fixture.chrome.webNavigation.getFrame = async () => undefined;
    let state = await isolatedManagedTabs(fixture.chrome, warnings);
    await state.restoreManagedTabs();
    await state.markManagedTab(5001);
    assert.equal(state.isManagedTab({ id: 5001 }), true);
    state = await isolatedManagedTabs(fixture.chrome, warnings);
    await state.restoreManagedTabs();
    assert.equal(state.isManagedTab({ id: 5001 }), true);
    for (const key of Object.keys(fixture.chrome.storage.sessionValues)) {
        delete fixture.chrome.storage.sessionValues[key];
    }
    state = await isolatedManagedTabs(fixture.chrome, warnings);
    await state.restoreManagedTabs();
    assert.equal(state.isManagedTab({ id: 5001 }), false);
    assert.ok(warnings.length > 0);
});

test('F1 unavailable native identity preserves actual create and adopt contracts', async () => {
    const fixture = createTabManagementFixture();
    const warnings = [];
    fixture.chrome.webNavigation.getFrame = async () => {
        throw new Error('native identity unavailable');
    };
    const restore = installGlobals({
        chrome: fixture.chrome,
        console: { ...globalThis.console, warn: (...args) => warnings.push(args) },
    });
    try {
        const handler = new TabHandler({});
        assert.equal((await handler.tabsAdopt({ tabId: 5001 })).managedAfter, true);
        const created = await handler.tabsCreate({ windowId: 20 }, createActionContext());
        assert.equal(created.managed, true);
        assert.equal(fixture.calls.filter((call) => call.method === 'tabs.create').length, 1);
        assert.equal(warnings.filter((args) => String(args.at(-1)).includes('native identity unavailable')).length, 2);
    } finally {
        await unmarkManagedTab(5001);
        await unmarkManagedTab(6000);
        restore();
    }
});

test('F1 navigation refreshes recovery identity without reviving released or closed pages', async () => {
    const fixture = createTabManagementFixture();
    let state = await isolatedManagedTabs(fixture.chrome);
    await state.restoreManagedTabs();
    await state.markManagedTab(5001);
    fixture.documents.set(5001, 'navigated-document');
    await state.updateManagedTabDocument(5001);
    for (const key of Object.keys(fixture.chrome.storage.sessionValues)) {
        delete fixture.chrome.storage.sessionValues[key];
    }
    state = await isolatedManagedTabs(fixture.chrome);
    await state.restoreManagedTabs();
    assert.equal(state.isManagedTab({ id: 5001 }), true);
    await Promise.all([state.unmarkManagedTab(5001), state.updateManagedTabDocument(5001)]);
    assert.equal(state.isManagedTab({ id: 5001 }), false);
    await state.updateManagedTabDocument(9999);
    assert.equal(state.isManagedTab({ id: 9999 }), false);
});

test('F1 each initialization storage failure rejects without authority and can be retried', async (t) => {
    for (const [area, method] of [
        ['session', 'get'],
        ['local', 'get'],
        ['session', 'set'],
        ['local', 'set'],
    ]) {
        await t.test(`${area}.${method}`, async () => {
            const fixture = createTabManagementFixture();
            fixture.chrome.storage.sessionValues.mcp_managed_tab_ids = [5001];
            const original = fixture.chrome.storage[area][method];
            fixture.chrome.storage[area][method] = async () => {
                throw new Error(`${area}.${method} refused`);
            };
            const state = await isolatedManagedTabs(fixture.chrome);
            await assert.rejects(() => state.restoreManagedTabs(), /refused/);
            assert.equal(state.isManagedTab({ id: 5001 }), false);
            fixture.chrome.storage[area][method] = original;
            await state.restoreManagedTabs();
            assert.equal(state.isManagedTab({ id: 5001 }), true);
        });
    }
});

test('F1 failed cross-generation commit does not promote unverified identity on retry', async () => {
    const fixture = createTabManagementFixture();
    let state = await isolatedManagedTabs(fixture.chrome);
    await state.restoreManagedTabs();
    await state.markManagedTab(5001);
    for (const key of Object.keys(fixture.chrome.storage.sessionValues)) {
        delete fixture.chrome.storage.sessionValues[key];
    }
    const set = fixture.chrome.storage.local.set;
    fixture.chrome.storage.local.set = async () => {
        throw new Error('commit refused');
    };
    state = await isolatedManagedTabs(fixture.chrome);
    await assert.rejects(() => state.restoreManagedTabs(), /commit refused/);
    assert.equal(state.isManagedTab({ id: 5001 }), false);
    fixture.documents.set(5001, 'changed-after-failed-commit');
    fixture.chrome.storage.local.set = set;
    await state.restoreManagedTabs();
    assert.equal(state.isManagedTab({ id: 5001 }), false);
});

test('F1 migration cleanup failure is visible and local revocation remains authoritative', async () => {
    const fixture = createTabManagementFixture();
    const warnings = [];
    fixture.chrome.storage.sessionValues.mcp_managed_tab_ids = [5001, 9999];
    fixture.chrome.storage.sessionValues.mcp_read_grants_v4_fixture = [{ tabId: 5002, documentId: 'read-only' }];
    fixture.chrome.storage.session.remove = async () => {
        throw new Error('legacy cleanup refused');
    };
    let state = await isolatedManagedTabs(fixture.chrome, warnings);
    await state.restoreManagedTabs();
    assert.equal(state.isManagedTab({ id: 5001 }), true);
    assert.equal(state.isManagedTab({ id: 9999 }), false);
    assert.ok(warnings.some((args) => String(args.at(-1)).includes('legacy cleanup refused')));
    await state.unmarkManagedTab(5001);
    state = await isolatedManagedTabs(fixture.chrome, warnings);
    await state.restoreManagedTabs();
    assert.equal(state.isManagedTab({ id: 5001 }), false);
    assert.equal(
        Object.keys(fixture.chrome.storage.values).some((key) => key.startsWith('mcp_read_grants')),
        false
    );
    assert.deepEqual(fixture.chrome.storage.sessionValues.mcp_read_grants_v4_fixture, [
        { tabId: 5002, documentId: 'read-only' },
    ]);
});

async function isolatedBackground(fixture) {
    const errors = [];
    const warnings = [];
    const clients = [];
    const executions = [];
    const runtime = { id: 'fixture', getURL: (path) => path, onMessage: chromeEvent(), sendMessage: async () => {} };
    Object.assign(fixture.chrome, {
        runtime,
        action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
        alarms: { create: async () => {}, onAlarm: chromeEvent() },
    });
    fixture.chrome.tabs.onRemoved = chromeEvent();
    fixture.chrome.tabs.onUpdated = chromeEvent();
    fixture.chrome.tabs.onMoved = chromeEvent();
    fixture.chrome.tabs.onAttached = chromeEvent();
    Object.assign(fixture.chrome.tabGroups, { onRemoved: chromeEvent() });
    fixture.chrome.windows.onRemoved = chromeEvent();
    fixture.chrome.windows.getLastFocused = async () => ({ id: 10 });
    fixture.tabs.get(5001).active = true;
    for (const event of ['onCommitted', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated']) {
        fixture.chrome.webNavigation[event] = chromeEvent();
    }
    const state = await isolatedManagedTabs(fixture.chrome, warnings);
    await isolatedBackgroundSource(backgroundSource, {
        chrome: fixture.chrome,
        console: {
            ...globalThis.console,
            error: (...args) => errors.push(args),
            warn: (...args) => warnings.push(args),
        },
        ...state,
        HttpClient: class {
            connections = 0;
            disconnects = 0;
            responses = [];
            constructor() {
                clients.push(this);
            }

            onConnectionClosed() {}
            onStatusChange() {}
            onMessage(listener) {
                this.message = (message, port) =>
                    listener(message, port, new globalThis.AbortController().signal, (success, data, error) =>
                        this.sendResponse(message.id, success, data, error, port)
                    );
            }

            async connect() {
                ++this.connections;
                return { connected: 1, ports: [19222] };
            }

            disconnect() {
                ++this.disconnects;
            }

            getConnectedServers() {
                return [{ port: 19222, instanceId: 'fixture-server' }];
            }

            getConnectedPorts() {
                return [19222];
            }

            getServerInstanceId() {
                return 'fixture-server';
            }

            isConnected() {
                return this.connections > 0;
            }

            hasPairingToken() {
                return false;
            }

            isAllowInsecureNoToken() {
                return false;
            }

            sendResponse(...args) {
                this.responses.push(args);
            }
        },
        ActionHandler: class {
            async execute(...args) {
                executions.push(args);
                return { managed: state.isManagedTab({ id: 5001 }) };
            }

            async refreshNativeRelations() {
                await state.refreshManagedTabRelations();
            }

            cleanupTab() {}
        },
        isExpectedOperationError: () => false,
        advancePageRevision() {},
        forgetPageRevision() {},
        getExistingTab: async (id) => fixture.tabs.get(id),
        revokeReadGrants: async () => {},
        revokeTabReadGrants: async () => {},
        hasReadGrant: async () => false,
        setReadGrant: async () => {
            throw new Error('managed page reached ordinary grant mutation');
        },
        setTimeout() {
            throw new Error('restoration was deferred to a timer');
        },
    });
    return {
        state,
        errors,
        warnings,
        client: clients[0],
        executions,
        message: (message) =>
            new Promise((resolve) =>
                runtime.onMessage.emit(
                    message,
                    { id: runtime.id, url: runtime.getURL('src/popup/popup.html') },
                    resolve
                )
            ),
    };
}

test('F5 startup gates network, popup and alarm authority while disconnect stays available', async () => {
    const fixture = createTabManagementFixture();
    fixture.chrome.storage.sessionValues.mcp_managed_tab_ids = [5001];
    const get = fixture.chrome.storage.local.get;
    const gate = createDeferred();
    fixture.chrome.storage.local.get = async (...args) => {
        await gate.promise;
        return get(...args);
    };
    const background = await isolatedBackground(fixture);
    const connect = background.message({ type: 'CONNECT' });
    const status = background.message({ type: 'GET_STATUS', tabId: 5001 });
    const readAccess = background.message({ type: 'SET_READ_ACCESS', tabId: 5001, port: 19222, allow: true });
    const network = background.client.message({ id: 'owned', action: 'tabs_list', params: {} }, 19222);
    fixture.chrome.alarms.onAlarm.emit({ name: 'mcp-keepalive' });
    fixture.chrome.tabs.onRemoved.emit(9999);
    await Promise.resolve();
    assert.equal(background.client.connections, 0);
    assert.equal(background.executions.length, 0);
    assert.equal((await background.message({ type: 'DISCONNECT' })).success, true);
    assert.equal(background.client.disconnects, 1);
    gate.resolve();
    await network;
    assert.equal((await status).managed, true);
    assert.match((await readAccess).error, /受控页面无需普通只读授权/);
    assert.equal((await connect).connected, 0);
    assert.equal(background.executions.length, 1);
    assert.equal(background.state.isManagedTab({ id: 5001 }), true);
    assert.equal(background.client.connections, 0);
    await background.message({ type: 'CONNECT' });
    assert.equal(background.client.connections, 1);
});

test('F5 failed initialization blocks actions and the next keepalive retries restoration', async () => {
    const fixture = createTabManagementFixture();
    fixture.chrome.storage.sessionValues.mcp_managed_tab_ids = [5001];
    const get = fixture.chrome.storage.local.get;
    fixture.chrome.storage.local.get = async () => {
        throw new Error('initialization refused');
    };
    const background = await isolatedBackground(fixture);
    await waitUntil(() => background.errors.length > 0);
    await background.client.message({ id: 'failed', action: 'tabs_list', params: {} }, 19222);
    assert.equal(background.client.connections, 0);
    assert.equal(background.executions.length, 0);
    assert.equal(background.client.responses.at(-1)[1], false);
    assert.match((await background.message({ type: 'GET_STATUS', tabId: 5001 })).error, /initialization refused/);
    fixture.chrome.storage.local.get = get;
    fixture.chrome.alarms.onAlarm.emit({ name: 'mcp-keepalive' });
    await waitUntil(() => background.client.connections === 1);
    assert.equal((await background.message({ type: 'GET_STATUS', tabId: 5001 })).managed, true);
    fixture.documents.set(5001, 'committed-navigation');
    fixture.chrome.webNavigation.onCommitted.emit({ tabId: 5001, frameId: 0 });
    await waitUntil(
        () => fixture.chrome.storage.values.mcp_managed_tabs_v1.tabs[0]?.documentId === 'committed-navigation'
    );
});

test('MH-CH-02 pending pause reads cannot prevent disconnect or overwrite its newer state', async () => {
    const fixture = createTabManagementFixture();
    const get = fixture.chrome.storage.session.get;
    const gate = createDeferred();
    let started = false;
    fixture.chrome.storage.session.get = async (key) => {
        if (key === 'mcp_connection_paused') {
            started = true;
            await gate.promise;
            return { mcp_connection_paused: false };
        }
        return get(key);
    };
    const background = await isolatedBackground(fixture);
    await waitUntil(() => started);
    assert.equal((await background.message({ type: 'DISCONNECT' })).success, true);
    assert.equal(background.client.disconnects, 1);
    assert.equal(background.client.connections, 0);
    gate.resolve();
    assert.equal((await background.message({ type: 'GET_STATUS' })).paused, true);
    fixture.chrome.alarms.onAlarm.emit({ name: 'mcp-keepalive' });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(background.client.connections, 0);
    assert.equal(fixture.chrome.storage.sessionValues.mcp_connection_paused, true);
    await background.message({ type: 'CONNECT' });
    assert.equal(background.client.connections, 1);
});

test('MH-CH-02 pause write failures stay visible after local disconnect', async () => {
    const fixture = createTabManagementFixture();
    const background = await isolatedBackground(fixture);
    await waitUntil(() => background.client.connections === 1);
    const set = fixture.chrome.storage.session.set;
    fixture.chrome.storage.session.set = async (update) => {
        if (update.mcp_connection_paused === true) {
            throw new Error('pause write refused');
        }
        return set(update);
    };
    const response = await background.message({ type: 'DISCONNECT' });
    assert.match(response.error, /pause write refused/);
    assert.equal(background.client.disconnects, 1);
    assert.equal((await background.message({ type: 'GET_STATUS' })).paused, true);
    fixture.chrome.alarms.onAlarm.emit({ name: 'mcp-keepalive' });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(background.client.connections, 1);
});

test('F1 native navigation write failures are visible and a later release cannot be revived', async () => {
    const fixture = createTabManagementFixture();
    fixture.chrome.storage.sessionValues.mcp_managed_tab_ids = [5001];
    const background = await isolatedBackground(fixture);
    await waitUntil(() => background.client.connections === 1);
    const set = fixture.chrome.storage.local.set;
    fixture.chrome.storage.local.set = async () => {
        throw new Error('navigation persistence refused');
    };
    fixture.documents.set(5001, 'next-document');
    fixture.chrome.webNavigation.onCommitted.emit({ tabId: 5001, frameId: 0 });
    await waitUntil(() =>
        background.warnings.some((args) => String(args.at(-1)).includes('navigation persistence refused'))
    );
    assert.equal(fixture.chrome.storage.values.mcp_managed_tabs_v1.tabs[0].documentId, 'document-5001');
    await assert.rejects(() => background.state.unmarkManagedTab(5001), /navigation persistence refused/);
    assert.equal(background.state.isManagedTab({ id: 5001 }), true);
    fixture.chrome.storage.local.set = set;
    await background.state.unmarkManagedTab(5001);
    fixture.chrome.webNavigation.onCommitted.emit({ tabId: 5001, frameId: 0 });
    const restarted = await isolatedManagedTabs(fixture.chrome);
    await restarted.restoreManagedTabs();
    assert.equal(restarted.isManagedTab({ id: 5001 }), false);
});

test('ER-01 frame probes handle invalid runtimes and isolate retained listeners', async (t) => {
    for (const scenario of [
        'missing-chrome',
        'missing-runtime',
        'sync-invalidated',
        'async-invalidated',
        'ordinary',
        'legacy',
    ]) {
        await t.test(scenario, async () => {
            const listeners = new Set();
            const messages = [];
            const acknowledgements = [];
            const warnings = [];
            let legacyCalls = 0;
            const parent = { postMessage: (message) => acknowledgements.push(message) };
            const window = {
                parent,
                addEventListener: (_type, listener) => listeners.add(listener),
                removeEventListener: (_type, listener) => listeners.delete(listener),
            };
            if (scenario === 'legacy') {
                window.__mcpFrameProbeListenerInstalled = true;
                listeners.add((event) => {
                    if (event.data?.type === 'mcp-frame-probe') {
                        ++legacyCalls;
                    }
                });
            }
            const runtime = {
                sendMessage(message) {
                    messages.push(message);
                    if (scenario === 'sync-invalidated') {
                        throw new Error('Extension context invalidated.');
                    }
                    if (scenario === 'async-invalidated') {
                        return Promise.reject(new Error('Extension context invalidated.'));
                    }
                    if (scenario === 'ordinary') {
                        return Promise.reject(new Error('message rejected fixture'));
                    }
                    return Promise.resolve({ accepted: true });
                },
            };
            const sandbox = vm.createContext({
                window,
                console: { warn: (...args) => warnings.push(args) },
                ...(scenario === 'missing-chrome' ? {} : { chrome: scenario === 'missing-runtime' ? {} : { runtime } }),
            });
            const install = () => vm.runInContext(`(${installFrameProbeListener.toString()})()`, sandbox);
            install();
            install();
            const installed = listeners.size;
            const data = {
                type: window.__mcpFrameProbeListenerV2 ? 'mcp-frame-probe-v2' : 'mcp-frame-probe',
                token: 'owned-probe-token',
                index: 0,
            };
            if (scenario === 'legacy') {
                assert.equal(installed, 2);
                data.type = 'mcp-frame-probe-v2';
            } else {
                assert.equal(installed, 1);
            }
            for (const listener of [...listeners]) {
                await assert.doesNotReject(async () => listener({ source: parent, data }));
            }
            await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
            assert.equal(legacyCalls, 0);
            if (scenario === 'legacy') {
                assert.equal(messages.length, 1);
                assert.equal(acknowledgements.length, 1);
                assert.equal(acknowledgements[0].type, 'mcp-frame-probe-ack-v2');
                assert.equal(warnings.length, 0);
            } else {
                assert.equal(acknowledgements.length, 0);
                assert.equal(warnings.length, 1);
                assert.equal(listeners.size, scenario === 'ordinary' ? 1 : 0);
                assert.equal(
                    typeof window.__mcpFrameProbeListenerV2,
                    scenario === 'ordinary' ? 'function' : 'undefined'
                );
            }
        });
    }
});

test('ER-02 native tab lookups distinguish the requested missing target from query failures', async (t) => {
    const operations = { pageSnapshot, assertScriptable, assertReadableTab, getTargetTabId, assertManagedTab };
    for (const [name, operation] of Object.entries(operations)) {
        await t.test(name, async () => {
            let failure;
            const restore = installGlobals({
                chrome: {
                    tabs: {
                        get: async () => {
                            throw failure;
                        },
                    },
                },
            });
            try {
                for (const message of ['No tab with id: 9912.', 'No tab with id: 9912']) {
                    failure = new Error(message);
                    await assert.rejects(
                        () => operation(9912, createActionContext(), 'owned-read'),
                        (error) => {
                            assert.ok(error instanceof ExpectedOperationError);
                            assert.equal(error.message, message);
                            return true;
                        }
                    );
                }
                for (const message of ['No tab with id: 9913.', 'native tab lookup refused']) {
                    failure = new Error(message);
                    await assert.rejects(
                        () => operation(9912, createActionContext(), 'owned-read'),
                        (error) => error === failure
                    );
                }
            } finally {
                restore();
            }
        });
    }
});

test('ER-03 debugger failures retain native context without replay or parameter disclosure', async (t) => {
    const cases = [
        ['Debugger.getScriptSource', 'Debugger agent is not enabled', 'domain_not_enabled'],
        ['Debugger.getScriptSource', 'No script for id: 12810', 'resource_not_found'],
        ['Target.getBrowserContexts', 'Cannot not access browser-level commands', 'browser_command_unavailable'],
        ['Target.getBrowserContexts', 'Not allowed', 'command_not_allowed'],
        ['Runtime.evaluate', "Object couldn't be returned by value", 'result_not_serializable'],
        ['Runtime.evaluate', 'Object reference chain is too long', 'result_not_serializable'],
        ['Runtime.missing', "'Runtime.missing' wasn't found", 'method_not_found'],
        ['Runtime.evaluate', 'Execution was terminated', 'command_failed', -32000],
        ['Runtime.callFunctionOn', 'Execution was terminated', 'command_failed', -32000],
        ['Runtime.runScript', 'Execution was terminated', 'command_failed', -32000],
        ['Runtime.evaluate', 'Internal error', 'command_failed', -32603],
        ['Runtime.callFunctionOn', 'Invalid parameters', 'command_failed', -32602],
    ];
    for (const [method, message, reason, code] of cases) {
        const nativeCode = code ?? (reason === 'method_not_found' ? -32601 : -32000);
        await t.test(code === undefined ? reason : `${reason}/${method}/${nativeCode}`, async () => {
            const tab = { id: 9914, url: 'https://example.com/owned' };
            const calls = [];
            const restore = installGlobals({
                chrome: {
                    storage: createStorage(),
                    tabs: { get: async () => tab },
                    debugger: {
                        sendCommand: async (_target, method) => {
                            calls.push(method);
                            throw new Error(JSON.stringify({ code: nativeCode, message }));
                        },
                    },
                },
            });
            try {
                await markManagedTab(tab.id);
                const handler = new DebuggerHandler({ ensureAttached: async () => {} }, {});
                await assert.rejects(
                    () =>
                        handler.debuggerSend(
                            { tabId: tab.id, method, params: { expression: 'private-parameter-sentinel' } },
                            createActionContext()
                        ),
                    (error) => {
                        assert.equal(error instanceof ExpectedOperationError, reason !== 'command_failed');
                        const body = JSON.parse(error.message).error;
                        assert.equal(body.code, 'CDP_ERROR');
                        assert.equal(body.context.method, method);
                        assert.equal(body.context.nativeSource, 'chrome.debugger');
                        assert.equal(body.context.nativeMessage, message);
                        assert.equal(body.context.reason, reason);
                        assert.equal(body.context.targetId, String(tab.id));
                        assert.equal(body.context.nativeCode, nativeCode);
                        assert.equal(error.message.includes('private-parameter-sentinel'), false);
                        return true;
                    }
                );
                assert.deepEqual(calls, [method]);
            } finally {
                await unmarkManagedTab(tab.id);
                restore();
            }
        });
    }
});

test('ER-04 iframe result serialization failures retain identity and never replay', async () => {
    const tab = { id: 9915, url: 'https://example.com/owned' };
    let executions = 0;
    const restore = installGlobals({
        chrome: {
            storage: createStorage(),
            tabs: { get: async () => tab },
            webNavigation: {
                getAllFrames: async () => [
                    { frameId: 3, parentFrameId: 0, documentId: 'owned-document', url: 'about:srcdoc' },
                ],
            },
            debugger: {
                sendCommand: async (_target, method) => {
                    assert.equal(method, 'Runtime.evaluate');
                    ++executions;
                    throw new Error(JSON.stringify({ code: -32000, message: "Object couldn't be returned by value" }));
                },
            },
        },
    });
    try {
        await markManagedTab(tab.id);
        const resolver = new FrameResolver({
            ensureAttached: async () => {},
            getExecutionContexts: () => [{ frameId: 'owned-cdp-frame', id: 3, isDefault: true }],
        });
        resolver.resolveCdpFrame = async () => ({ cdpFrameId: 'owned-cdp-frame' });
        installOwnerProbeFixture(globalThis.chrome, tab, 3, () => 'owned-document');
        await assert.rejects(
            () =>
                resolver.evaluateInFrame(
                    { tabId: tab.id, frameId: 3, expression: '++window.sideEffect', staleContextRetry: 'readOnly' },
                    createActionContext()
                ),
            (error) => {
                assert.ok(error instanceof ExpectedOperationError);
                const body = JSON.parse(error.message).error;
                assert.equal(body.code, 'CDP_ERROR');
                assert.equal(body.context.method, 'Runtime.evaluate');
                assert.equal(body.context.frameContext.documentId, 'owned-document');
                assert.equal(body.context.frameContext.executionContextId, 3);
                assert.equal(body.context.reason, 'result_not_serializable');
                return true;
            }
        );
        assert.equal(executions, 1);
    } finally {
        await unmarkManagedTab(tab.id);
        restore();
    }
});

test('ER-05 discovery summaries follow complete port sets, resets and active generations', async () => {
    const output = [];
    const restore = installGlobals({
        console: {
            ...globalThis.console,
            log: (text) => output.push(text),
            debug: (text) => output.push(text),
            warn: (text) => output.push(text),
        },
    });
    try {
        const client = new HttpClient();
        const signatures = [[19222], [19222], [19223], [], [], [19222]];
        for (const ports of signatures) {
            const checked = [];
            client.checkPort = async (port) => {
                checked.push(port);
                return { healthy: ports.includes(port) };
            };
            assert.deepEqual(await client.discoverServers(client.generation), ports);
            assert.deepEqual(
                checked,
                Array.from({ length: 78 }, (_, index) => index + 19222)
            );
        }
        assert.equal(output.length, 4);
        assert.match(output[0], /19222/);
        assert.match(output[1], /19223/);
        assert.match(output[2], /No MCP Server/);
        assert.match(output[3], /19222/);
        client.disconnect();
        client.shouldReconnect = true;
        await client.discoverServers(client.generation);
        assert.equal(output.length, 5);
        const oldGeneration = client.generation;
        const pending = createDeferred();
        client.checkPort = async (port) => (port === 19222 ? pending.promise : { healthy: false });
        const stale = client.discoverServers(oldGeneration);
        client.disconnect();
        client.shouldReconnect = true;
        client.checkPort = async (port) => ({ healthy: port === 19223 });
        await client.discoverServers(client.generation);
        const activeSummary = client.lastDiscoverySummary;
        pending.resolve({ healthy: false, failureKind: 'protocol', reason: 'stale failure' });
        assert.deepEqual(await stale, []);
        assert.equal(client.lastDiscoverySummary, activeSummary);
        assert.equal(client.lastServerFailureSummary, '');
        assert.equal(
            output.some((text) => text.includes('stale failure')),
            false
        );
        client.disconnect();
    } finally {
        restore();
    }
});

test('ER-08 both parent probe paths use the new protocol and clean pending identities', async (t) => {
    const parentListeners = new Set();
    const childListeners = new Set();
    const packets = [];
    let dropReplies = false;
    let awaitFailure = false;
    let scriptAwaitFailure = false;
    const pageTimer = () => assert.fail('frame probes must use the Extension timer');
    const tab = { id: 9916, url: 'https://example.com/owned' };
    const parent = {
        innerWidth: 800,
        innerHeight: 600,
        setTimeout: pageTimer,
        clearTimeout: globalThis.clearTimeout,
        addEventListener: (_type, callback) => parentListeners.add(callback),
        removeEventListener: (_type, callback) => parentListeners.delete(callback),
    };
    const child = {
        parent,
        __mcpFrameProbeListenerInstalled: true,
        addEventListener: (_type, callback) => childListeners.add(callback),
        removeEventListener: (_type, callback) => childListeners.delete(callback),
        postMessage: (data) => {
            packets.push(data);
            if (dropReplies) {
                return;
            }
            for (const listener of childListeners) {
                void listener({ source: parent, data });
            }
        },
    };
    let legacyCalls = 0;
    childListeners.add((event) => {
        if (event.data.type === 'mcp-frame-probe') {
            ++legacyCalls;
        }
    });
    parent.postMessage = (data) => {
        packets.push(data);
        for (const listener of parentListeners) {
            listener({ source: child, data });
        }
    };
    const frame = {
        id: 'owned',
        nodeType: 1,
        tagName: 'IFRAME',
        childNodes: [],
        matches: () => true,
        contentWindow: child,
        currentCSSZoom: 1,
        isConnected: true,
        src: 'about:srcdoc',
        clientLeft: 0,
        clientTop: 0,
        getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 80 }),
    };
    const childContext = vm.createContext({
        window: child,
        console: globalThis.console,
        chrome: {
            runtime: {
                sendMessage: async (message) =>
                    recordDomFrameProbe(message, { tab, frameId: 3, documentId: 'owned-child' }),
            },
        },
    });
    const parentContext = vm.createContext({
        window: parent,
        document: { title: 'owned', childNodes: [frame], querySelector: () => frame, querySelectorAll: () => [frame] },
        CSS: { escape: (value) => value },
        location: { href: tab.url },
        setTimeout: pageTimer,
        clearTimeout: globalThis.clearTimeout,
        owner: frame,
    });
    vm.runInContext(`(${installDomHelpers.toString()})()`, parentContext);
    let released = 0;
    const restore = installGlobals({
        chrome: {
            webNavigation: {
                getAllFrames: async () => [
                    { frameId: 0, parentFrameId: -1, documentId: 'owned-parent', url: tab.url },
                    {
                        frameId: 3,
                        parentFrameId: 0,
                        documentId: 'owned-child',
                        parentDocumentId: 'owned-parent',
                        url: 'about:srcdoc',
                    },
                ],
            },
            scripting: {
                executeScript: async ({ func, args, target, injectImmediately }) => {
                    assert.equal(injectImmediately, true);
                    if (func.name === 'installFrameProbeListener') {
                        assert.deepEqual(target.documentIds, ['owned-child']);
                        vm.runInContext(`(${func.toString()})()`, childContext);
                        return [];
                    }
                    if (func.name === 'awaitDomFrameProbe' && scriptAwaitFailure) {
                        throw new Error('owned script await fixture failure');
                    }
                    parentContext.probeArgs = args;
                    return [{ result: await vm.runInContext(`(${func.toString()})(...probeArgs)`, parentContext) }];
                },
            },
            debugger: {
                sendCommand: async (_target, method, params) => {
                    if (method === 'DOM.getFrameOwner') {
                        return { backendNodeId: 1 };
                    }
                    if (method === 'DOM.resolveNode') {
                        return { object: { objectId: 'owned-owner' } };
                    }
                    if (method === 'Runtime.releaseObject') {
                        ++released;
                        if (params.objectId === 'owned-probe') {
                            delete parentContext.probePromise;
                        }
                        return {};
                    }
                    if (method === 'Runtime.awaitPromise') {
                        assert.equal(params.promiseObjectId, 'owned-probe');
                        if (awaitFailure) {
                            throw new Error('owned CDP await fixture failure');
                        }
                        return { result: { value: await parentContext.probePromise } };
                    }
                    assert.equal(method, 'Runtime.callFunctionOn');
                    parentContext.probeArgs = (params.arguments ?? []).map(({ value }) => value);
                    const value = vm.runInContext(
                        `(${params.functionDeclaration}).apply(${params.objectId === 'owned-owner' ? 'owner' : 'probePromise'}, probeArgs)`,
                        parentContext
                    );
                    if (params.returnByValue === false) {
                        parentContext.probePromise = value;
                        return { result: { objectId: 'owned-probe' } };
                    }
                    return {
                        result: {
                            value: await value,
                        },
                    };
                },
            },
        },
    });
    try {
        const snapshot = await getDomFrameSnapshot(tab.id, 0);
        assert.equal(snapshot.frames[0].frameId, 3);
        assert.equal(await probeCdpFrameOwner(tab.id, 'owned-child', 'owned-cdp-child'), 3);
        assert.deepEqual(
            packets.map(({ type }) => type),
            ['mcp-frame-probe-v2', 'mcp-frame-probe-ack-v2', 'mcp-frame-probe-v2', 'mcp-frame-probe-ack-v2']
        );
        assert.equal(legacyCalls, 0);
        assert.equal(childListeners.size, 2);
        assert.equal(parentListeners.size, 0);
        assert.equal(released, 2);
        assert.equal(parentContext.probePromise, undefined);
        assert.equal(parentContext.__mcpDomFrameProbes, undefined);
        dropReplies = true;
        for (const path of ['dom', 'owner']) {
            for (const outcome of ['timeout', 'cancel', 'deadline', 'await-error']) {
                await t.test(`${path} ${outcome} releases listeners and pending identity`, async () => {
                    const controller = new AbortController();
                    const context = createActionContext({
                        signal: controller.signal,
                        ...(outcome === 'deadline' ? { deadline: Date.now() + 30 } : {}),
                    });
                    awaitFailure = outcome === 'await-error' && path === 'owner';
                    scriptAwaitFailure = outcome === 'await-error' && path === 'dom';
                    const operation =
                        path === 'dom'
                            ? getDomFrameSnapshot(tab.id, 0, undefined, undefined, undefined, context)
                            : probeCdpFrameOwner(tab.id, 'owned-child', 'owned-cdp-child', undefined, context);
                    const timer = outcome === 'cancel' ? setTimeout(() => controller.abort(), 10) : undefined;
                    try {
                        if (outcome === 'timeout') {
                            const result = await operation;
                            assert.equal(path === 'dom' ? result.frames[0].frameId : result, null);
                        } else if (outcome === 'await-error') {
                            await assert.rejects(operation, /owned .* await fixture failure/);
                        } else {
                            await assert.rejects(operation, (error) => {
                                const detail = JSON.parse(error.message).error;
                                assert.equal(detail.code, outcome === 'cancel' ? 'REQUEST_CANCELLED' : 'TIMEOUT');
                                assert.equal(detail.context.actionExecuted, false);
                                assert.equal(detail.context.actionStatus, 'not_started');
                                return true;
                            });
                        }
                    } finally {
                        clearTimeout(timer);
                    }
                    assert.equal(parentListeners.size, 0);
                    assert.equal(parentContext.__mcpDomFrameProbes, undefined);
                    assert.equal(parentContext.probePromise, undefined);
                });
            }
        }
        for (const packet of packets) {
            assert.equal(recordDomFrameProbe(packet, { tab, frameId: 3, documentId: 'owned-child' }).accepted, false);
        }
    } finally {
        restore();
    }
});

test('ER-08a listener installation respects request limits and preserves unavailable diagnostics', async (t) => {
    const variants = ['timeout', 'cancel', 'deadline', 'early-deadline', 'late-error'].flatMap((outcome) =>
        ['dom', 'owner'].map((path) => ({ path, outcome }))
    );
    for (const { path, outcome } of variants) {
        await t.test(`${path} ${outcome}`, { timeout: 2500 }, async () => {
            const pending = createDeferred();
            const entered = createDeferred();
            const controller = new AbortController();
            let parentProbes = 0;
            const nativeDate = Date;
            const nativeSetTimeout = setTimeout;
            const requestedTimers = [];
            let clock = 1000;
            const restore = installGlobals({
                ...(outcome === 'early-deadline'
                    ? {
                          Date: class extends nativeDate {
                              static now() {
                                  return clock;
                              }
                          },
                          setTimeout: (callback, timeout, ...args) => {
                              if (timeout <= 30) {
                                  requestedTimers.push(timeout);
                                  return nativeSetTimeout(() => {
                                      clock = requestedTimers.length === 1 ? 1029 : 1030;
                                      callback(...args);
                                  }, 0);
                              }
                              return nativeSetTimeout(callback, timeout, ...args);
                          },
                      }
                    : {}),
                chrome: {
                    webNavigation: {
                        getAllFrames: async () => [
                            {
                                frameId: 0,
                                parentFrameId: -1,
                                documentId: 'install-parent',
                                url: 'https://example.com/',
                            },
                            {
                                frameId: 3,
                                parentFrameId: 0,
                                documentId: 'install-child',
                                parentDocumentId: 'install-parent',
                                url: 'about:srcdoc',
                            },
                        ],
                    },
                    scripting: {
                        executeScript: frameSnapshotFixture(async ({ func }) => {
                            if (func.name === 'installFrameProbeListener') {
                                entered.resolve();
                                return pending.promise;
                            }
                            ++parentProbes;
                            return [
                                {
                                    result: {
                                        parent: { title: 'owned', rect: { x: 0, y: 0, width: 100, height: 80 } },
                                        frames: [],
                                        selectedIndex: null,
                                        selectionStatus: 'not-requested',
                                    },
                                },
                            ];
                        }),
                    },
                },
            });
            const context = createActionContext({
                signal: controller.signal,
                ...(outcome.endsWith('deadline') ? { deadline: Date.now() + 30 } : {}),
            });
            const operation = (
                path === 'dom'
                    ? getDomFrameSnapshot(9918, 0, undefined, undefined, undefined, context)
                    : probeCdpFrameOwner(9918, 'install-child', 'owned-cdp-child', undefined, context)
            ).then(
                (value) => ({ value }),
                (error) => ({ error })
            );
            let observation;
            try {
                await entered.promise;
                if (outcome === 'cancel' || outcome === 'late-error') {
                    controller.abort();
                }
                const result = await Promise.race([
                    operation,
                    new Promise((resolve) => {
                        observation = setTimeout(() => resolve('pending'), outcome === 'timeout' ? 1500 : 150);
                    }),
                ]);
                assert.notEqual(result, 'pending');
                if (outcome === 'timeout' && path === 'dom') {
                    assert.equal(parentProbes, 1);
                    assert.match(result.value.unavailableFrames[0].error, /listener installation timed out/);
                } else {
                    assert.equal(parentProbes, 0);
                    assert.match(
                        result.error.message,
                        outcome === 'timeout'
                            ? /listener installation timed out/
                            : outcome.endsWith('deadline')
                              ? /TIMEOUT/
                              : /REQUEST_CANCELLED/
                    );
                }
                if (outcome === 'early-deadline') {
                    assert.deepEqual(requestedTimers, [30, 1]);
                }
            } finally {
                clearTimeout(observation);
                if (outcome === 'late-error') {
                    pending.reject(new Error('owned late installation failure'));
                } else {
                    pending.resolve([]);
                }
                await operation;
                restore();
            }
        });
    }
});

test('ER-09 late navigation snapshots and read grants share the native missing-tab boundary', async () => {
    const tab = { id: 9917, url: 'https://example.com/owned' };
    const storage = createStorage();
    let closed = false;
    let reloads = 0;
    const restore = installGlobals({
        chrome: {
            storage,
            tabs: {
                get: async () => {
                    if (closed) {
                        throw new Error(`No tab with id: ${tab.id}.`);
                    }
                    return tab;
                },
                reload: async () => {
                    ++reloads;
                    closed = true;
                },
            },
        },
    });
    const missing = (error) => {
        assert.ok(error instanceof ExpectedOperationError);
        assert.equal(error.message, `No tab with id: ${tab.id}.`);
        assert.notEqual(error.actionExecuted, false);
        return true;
    };
    try {
        await markManagedTab(tab.id);
        await assert.rejects(() => new NavigationHandler({}).reload({ tabId: tab.id }, createActionContext()), missing);
        assert.equal(reloads, 1);
        await assert.rejects(() => readGrantDocumentId('owned-closed-grant', tab.id), missing);
        await assert.rejects(() => setReadGrant('owned-closed-grant', tab.id, true), missing);
        const grants = await storage.session.get('mcp_read_grants_v4_owned-closed-grant');
        assert.equal(grants['mcp_read_grants_v4_owned-closed-grant'], undefined);
    } finally {
        await unmarkManagedTab(tab.id);
        restore();
    }
});

test('CR-01 explicit window display changes do not inherit page permissions', async (t) => {
    for (const managedIds of [[], [5001], [5001, 5002]]) {
        await t.test(`managed-${managedIds.length}`, async () => {
            const fixture = createTabManagementFixture();
            const restore = installGlobals({ chrome: fixture.chrome });
            try {
                for (const id of managedIds) {
                    await markManagedTab(id);
                }
                const handler = new TabHandler({});
                const focused = await handler.windowFocus({ windowId: 10 }, createActionContext());
                assert.equal(focused.after.focused, true);
                const updated = await handler.windowUpdate(
                    {
                        windowId: 10,
                        width: 900,
                        height: 700,
                        drawAttention: true,
                    },
                    createActionContext()
                );
                assert.equal(updated.after.width, 900);
                assert.equal(updated.after.height, 700);
                assert.equal(isManagedTab({ id: 5002 }), managedIds.includes(5002));
                if (managedIds.length < 2) {
                    await assert.rejects(
                        () => handler.windowClose({ windowId: 10 }, createActionContext()),
                        /WINDOW_HAS_UNMANAGED_TABS/
                    );
                    assert.equal(
                        fixture.calls.some((call) => call.method === 'windows.remove'),
                        false
                    );
                }
                await assert.rejects(() => handler.windowFocus({ windowId: 999 }), /No window/);
            } finally {
                for (const id of fixture.tabs.keys()) {
                    await unmarkManagedTab(id);
                }
                restore();
            }
        });
    }
});

test('CR-02 default creation ignores stale caches and reports native enumeration errors', async (t) => {
    for (const scenario of ['mixed', 'missing', 'lookup-error']) {
        await t.test(scenario, async () => {
            const fixture = createTabManagementFixture();
            const restore = installGlobals({ chrome: fixture.chrome });
            try {
                await markManagedTab(5001);
                if (scenario === 'lookup-error') {
                    fixture.chrome.windows.getAll = async () => {
                        throw new Error('window query refused');
                    };
                }
                const operation = () => new TabHandler({}).tabsCreate({}, { mcpWindowId: 10, mcpTabGroupId: null });
                if (scenario === 'lookup-error') {
                    await assert.rejects(operation, /window query refused/);
                    assert.equal(fixture.calls.length, 0);
                } else {
                    const created = await operation();
                    assert.equal(created.windowId, 10);
                    assert.equal(created.active, false);
                    assert.equal(created.managed, true);
                    assert.equal(isManagedTab({ id: 5002 }), false);
                    assert.equal(fixture.calls.filter((call) => call.method === 'windows.create').length, 0);
                }
            } finally {
                for (const id of fixture.tabs.keys()) {
                    await unmarkManagedTab(id);
                }
                setMcpWindowId(null);
                setMcpTabGroupId(null);
                restore();
            }
        });
    }
});

test('CR-03 mixed group display updates preserve individual page authority', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    let handler;
    try {
        await markManagedTab(5001);
        await fixture.chrome.tabs.group({ tabIds: [5001], groupId: 77 });
        handler = new ActionHandler();
        for (const properties of [
            ...['blue', 'cyan', 'green', 'grey', 'orange', 'pink', 'purple', 'red', 'yellow'].map((color) => ({
                color,
            })),
            { title: '', collapsed: true },
            { title: 'Owned display', collapsed: false },
        ]) {
            const changed = await handler.execute(
                'tabgroup_update',
                { groupId: 77, ...properties },
                createActionContext()
            );
            assert.equal(changed.success, true);
            for (const [key, value] of Object.entries(properties)) {
                assert.equal(changed.after[0][key], value);
            }
            assert.equal(changed.tabsAfter.find((tab) => tab.id === 5003).managed, false);
        }
        await assert.rejects(
            () => handler.execute('tabgroup_move', { groupId: 77, windowId: 10, index: -1 }, {}),
            /非托管/
        );
        assert.equal(
            fixture.calls.some((call) => call.method === 'tabGroups.move'),
            false
        );
        assert.equal(isManagedTab({ id: 5003 }), false);
        await unmarkManagedTab(5001);
        const unmanaged = await handler.execute(
            'tabgroup_update',
            { groupId: 77, title: 'Unmanaged display' },
            createActionContext()
        );
        assert.equal(unmanaged.after[0].title, 'Unmanaged display');
        assert.ok(unmanaged.tabsAfter.every((tab) => !tab.managed));
    } finally {
        if (handler?.logManager.sweepTimer) {
            globalThis.clearInterval(handler.logManager.sweepTimer);
        }
        for (const id of fixture.tabs.keys()) {
            await unmarkManagedTab(id);
        }
        restore();
    }
});

test('CR-04 group display and selected-member operations tolerate unrelated sibling changes', async (t) => {
    for (const action of ['tabgroup_create', 'tabgroup_add', 'tabgroup_remove', 'tabgroup_update']) {
        await t.test(action, async () => {
            const fixture = createTabManagementFixture();
            const restore = installGlobals({ chrome: fixture.chrome });
            const gate = createDeferred();
            const entered = createDeferred();
            let handler;
            try {
                for (const id of [5001, 5002]) {
                    await markManagedTab(id);
                }
                Object.assign(fixture.tabs.get(5002), { groupId: 77, windowId: 20 });
                if (action !== 'tabgroup_add') {
                    Object.assign(fixture.tabs.get(5001), { groupId: 77, windowId: 20 });
                }
                handler = new ActionHandler();
                handler.actions.set('navigate', async () => {
                    entered.resolve();
                    await gate.promise;
                });
                const blocking = handler.execute('navigate', { tabId: 5001 }, createActionContext());
                await entered.promise;
                const params =
                    action === 'tabgroup_update'
                        ? { groupId: 77, title: 'Changed display' }
                        : { tabIds: [5001], ...(action === 'tabgroup_add' ? { groupId: 77 } : {}) };
                const changing = handler.execute(action, params, createActionContext());
                changing.catch(() => {});
                await waitUntil(() => handler.actionLocks.has(5003));
                fixture.tabs.get(5003).groupId = -1;
                gate.resolve();
                await blocking;
                assert.equal((await changing).success, true);
                assert.equal(isManagedTab({ id: 5003 }), false);
                assert.equal(handler.actionLocks.size, 0);
            } finally {
                gate.resolve();
                if (handler?.logManager.sweepTimer) {
                    globalThis.clearInterval(handler.logManager.sweepTimer);
                }
                for (const id of fixture.tabs.keys()) {
                    await unmarkManagedTab(id);
                }
                restore();
            }
        });
    }
});

test('CR-05 debugger accepts controlled blank pages without weakening restricted or unmanaged pages', async () => {
    const fixture = createTabManagementFixture();
    let attached = 0;
    const sent = [];
    fixture.chrome.debugger.sendCommand = async (...args) => {
        sent.push(args);
        return { result: { value: 3 } };
    };
    const restore = installGlobals({ chrome: fixture.chrome });
    try {
        await markManagedTab(5001);
        const handler = new DebuggerHandler(
            {
                ensureAttached: async () => {
                    ++attached;
                },
            },
            {}
        );
        for (const url of ['about:blank', 'about:blank#owned', 'about:blank?owned']) {
            fixture.tabs.get(5001).url = url;
            assert.equal(
                (await handler.debuggerSend({ tabId: 5001, method: 'Runtime.evaluate' }, createActionContext())).result
                    .value,
                3
            );
        }
        for (const url of ['chrome://settings', 'chrome-extension://other/frame.html', 'about:srcdoc']) {
            fixture.tabs.get(5001).url = url;
            await assert.rejects(
                () => handler.debuggerSend({ tabId: 5001, method: 'Runtime.evaluate' }, createActionContext()),
                /restricted URL/
            );
        }
        await unmarkManagedTab(5001);
        fixture.tabs.get(5001).url = 'about:blank';
        await assert.rejects(
            () => handler.debuggerSend({ tabId: 5001, method: 'Runtime.evaluate' }, createActionContext()),
            /非托管/
        );
        assert.equal(attached, 3);
        assert.equal(sent.length, 3);
    } finally {
        await unmarkManagedTab(5001);
        restore();
    }
});

test('CR-06 a failed sibling probe does not block a uniquely verified selected frame', async (t) => {
    for (const failure of ['missing-document', 'injection-error']) {
        await t.test(failure, async () => {
            const tab = { id: 1991, url: 'https://example.com/owned' };
            const frames = [
                { frameId: 0, parentFrameId: -1, documentId: 'parent', url: tab.url },
                {
                    frameId: 3,
                    parentFrameId: 0,
                    documentId: 'good',
                    parentDocumentId: 'parent',
                    url: 'https://example.com/good',
                },
                {
                    frameId: 4,
                    parentFrameId: 0,
                    documentId: failure === 'missing-document' ? undefined : 'bad',
                    parentDocumentId: 'parent',
                    url: 'https://example.com/bad',
                },
            ];
            const restore = installGlobals({
                chrome: {
                    storage: createStorage(),
                    tabs: { get: async () => tab },
                    webNavigation: { getAllFrames: async () => frames },
                    scripting: {
                        executeScript: frameSnapshotFixture(async ({ target, func, args }) => {
                            if (func.name === 'installFrameProbeListener') {
                                if (target.documentIds.includes('bad')) {
                                    throw new Error('sibling document disappeared');
                                }
                                return [{ frameId: 3, documentId: 'good' }];
                            }
                            recordDomFrameProbe({ token: args[0], index: 0 }, { tab, frameId: 3, documentId: 'good' });
                            return [
                                {
                                    result: {
                                        parent: { title: 'Owned' },
                                        selectedIndex: args[1] === '#bad' ? 1 : 0,
                                        selectionStatus: 'found',
                                        frames: [
                                            { index: 0, acknowledged: true, url: frames[1].url },
                                            { index: 1, acknowledged: false, url: frames[2].url },
                                        ],
                                    },
                                },
                            ];
                        }),
                    },
                },
            });
            try {
                await markManagedTab(tab.id);
                const snapshot = await getDomFrameSnapshot(tab.id, 0, '#good', 'parent', tab.url);
                assert.equal(snapshot.frames[0].frameId, 3);
                assert.equal(snapshot.frames[1].frameId, null);
                assert.equal(snapshot.unavailableFrames[0].frameId, 4);
                assert.match(
                    snapshot.unavailableFrames[0].error,
                    failure === 'missing-document' ? /documentId/ : /disappeared/
                );
                await assert.rejects(
                    () => new FrameResolver({}).resolveFrame({ tabId: tab.id, frame: '#bad' }, createActionContext()),
                    /FRAME_IDENTITY_UNAVAILABLE/
                );
            } finally {
                await unmarkManagedTab(tab.id);
                restore();
            }
        });
    }
});

test(
    'CE-R05 delayed storage values cannot replace a newer policy and default ' + 'auto-connect remains available',
    async () => {
        const storage = createStorage();
        const oldRead = createDeferred();
        storage.local.get = async (key) => (key === 'mcp_allow_insecure_no_token_v2' ? oldRead.promise : {});
        FakeWebSocket.instances = [];
        const restore = installGlobals({
            chrome: { storage, runtime: { getURL: (path) => path, getManifest: () => ({ version: 'test' }) } },
            WebSocket: class extends FakeWebSocket {
                constructor(url) {
                    super(url);
                    globalThis.queueMicrotask(() => this.open());
                }
            },
            fetch: async (url) => ({
                ok: String(url).includes(':19222/'),
                json: async () => ({ status: 'ok', authRequired: false }),
            }),
        });
        const client = new HttpClient();
        let defaults;
        try {
            const reading = client.isAllowInsecureNoToken();
            await client.setAllowInsecureNoToken(false);
            oldRead.resolve({ mcp_allow_insecure_no_token_v2: true });
            assert.equal(await reading, false);
            assert.equal((await client.connect()).connected, 0);
            assert.equal(FakeWebSocket.instances.length, 0);
            storage.local.get = async () => ({});
            defaults = new HttpClient();
            assert.equal((await defaults.connect()).connected, 1);
            assert.equal(FakeWebSocket.instances.length, 1);
        } finally {
            client.disconnect();
            defaults?.disconnect();
            restore();
        }
    }
);

test('CE-N02 group operations serialize release in both orders and recheck members after waiting', async (t) => {
    for (const scenario of ['group-first', 'release-first', 'membership-change']) {
        await t.test(scenario, async () => {
            const fixture = createTabManagementFixture();
            const restore = installGlobals({ chrome: fixture.chrome });
            const gate = createDeferred();
            const entered = createDeferred();
            let handler;
            try {
                for (const id of [5001, 5002]) {
                    await markManagedTab(id);
                }
                handler = new ActionHandler();
                const { groupId } = await handler.execute(
                    'tabgroup_create',
                    { tabIds: [5002, 5001] },
                    createActionContext()
                );
                const originalMove = fixture.chrome.tabGroups.move;
                let moved = 0;
                fixture.chrome.tabGroups.move = async (...args) => {
                    ++moved;
                    entered.resolve();
                    await gate.promise;
                    return originalMove(...args);
                };
                if (scenario === 'group-first') {
                    const moving = handler.execute(
                        'tabgroup_move',
                        { groupId, windowId: 20, index: -1 },
                        createActionContext()
                    );
                    await entered.promise;
                    let released = false;
                    const releasing = handler
                        .execute('tabs_release', { tabId: 5001 }, createActionContext())
                        .then(() => {
                            released = true;
                        });
                    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
                    assert.equal(released, false);
                    assert.equal(isManagedTab({ id: 5001 }), true);
                    gate.resolve();
                    await Promise.all([moving, releasing]);
                    assert.equal(moved, 1);
                } else {
                    const action = scenario === 'release-first' ? 'tabs_release' : 'navigate';
                    const release = handler.actions.get('tabs_release');
                    handler.actions.set(action, async (params, context) => {
                        entered.resolve();
                        await gate.promise;
                        if (scenario === 'release-first') {
                            return release(params, context);
                        }
                    });
                    const blocking = handler.execute(action, { tabId: 5001 }, createActionContext());
                    await entered.promise;
                    const moving = handler.execute(
                        'tabgroup_move',
                        { groupId, windowId: 20, index: -1 },
                        createActionContext()
                    );
                    const failure = assert.rejects(
                        moving,
                        scenario === 'release-first' ? /非托管/ : /成员或窗口已变化/
                    );
                    await waitUntil(() => handler.actionLocks.has(5002));
                    if (scenario === 'membership-change') {
                        fixture.tabs.get(5002).groupId = 77;
                    }
                    gate.resolve();
                    await Promise.all([blocking, failure]);
                    assert.equal(moved, 0);
                }
                assert.equal(handler.actionLocks.size, 0);
            } finally {
                gate.resolve();
                if (handler?.logManager.sweepTimer) {
                    globalThis.clearInterval(handler.logManager.sweepTimer);
                }
                for (const id of fixture.tabs.keys()) {
                    await unmarkManagedTab(id);
                    forgetPageRevision(id);
                }
                restore();
            }
        });
    }
});

test(
    'CE-N05 explicit networkidle establishes observation before navigation and ' +
        'rejects missing, failed or interrupted observation',
    async () => {
        const fixture = createTabManagementFixture();
        const events = {
            onCommitted: chromeEvent(),
            onDOMContentLoaded: chromeEvent(),
            onCompleted: chromeEvent(),
            onHistoryStateUpdated: chromeEvent(),
            onReferenceFragmentUpdated: chromeEvent(),
        };
        fixture.chrome.webNavigation = events;
        const restore = installGlobals({ chrome: fixture.chrome });
        let handler;
        let observations = 0;
        let updates = 0;
        let observationFailure = false;
        let detach = false;
        try {
            await markManagedTab(5001);
            handler = new ActionHandler();
            const commands = [];
            handler.debuggerManager.ensureAttached = async () => {
                commands.push('attach');
            };
            handler.debuggerManager.isAttached = () => true;
            fixture.chrome.debugger.sendCommand = async ({ tabId }, method) => {
                commands.push(method);
                if (method === 'Page.getFrameTree') {
                    return { frameTree: { frame: { id: 'main' } } };
                }
                if (method !== 'Network.enable') {
                    return {};
                }
                ++observations;
                if (observationFailure) {
                    throw new Error('Network.enable refused');
                }
                handler.logManager.handleEvent(tabId, 'Network.requestWillBeSent', {
                    requestId: 'stream',
                    request: { url: 'https://example.com/stream', method: 'GET' },
                    type: 'Fetch',
                    timestamp: 1,
                    wallTime: 1,
                });
            };
            fixture.chrome.tabs.update = async (tabId) => {
                ++updates;
                assert.equal(observations > 0, true);
                const details = { tabId, frameId: 0, documentId: `document-${updates}` };
                events.onCommitted.emit(details);
                events.onCompleted.emit(details);
                if (detach) {
                    handler.logManager.handleDebuggerDetach(tabId);
                }
            };
            await assert.rejects(
                () => new NavigationHandler(handler.logManager).waitForNavigation(5001, 'networkidle', 100),
                /观测未建立/
            );
            await assert.rejects(
                () =>
                    handler.execute(
                        'navigate',
                        { tabId: 5001, url: 'https://example.com/next', waitUntil: 'networkidle', timeout: 60 },
                        createActionContext()
                    ),
                /Navigation timeout/
            );
            assert.deepEqual(commands.slice(0, 4), ['attach', 'Page.enable', 'Page.getFrameTree', 'Network.enable']);
            assert.equal(observations, 1);
            assert.equal(updates, 1);
            await handler.execute(
                'navigate',
                { tabId: 5001, url: 'https://example.com/next', waitUntil: 'load', timeout: 100 },
                createActionContext()
            );
            assert.equal(observations, 1);
            observationFailure = true;
            await assert.rejects(
                () =>
                    handler.execute(
                        'navigate',
                        { tabId: 5001, url: 'https://example.com/next', waitUntil: 'networkidle', timeout: 100 },
                        createActionContext()
                    ),
                /Network.enable refused/
            );
            assert.equal(updates, 2);
            observationFailure = false;
            detach = true;
            await assert.rejects(
                () =>
                    handler.execute(
                        'navigate',
                        { tabId: 5001, url: 'https://example.com/next', waitUntil: 'networkidle', timeout: 1000 },
                        createActionContext()
                    ),
                /观测已中断/
            );
        } finally {
            if (handler?.logManager.sweepTimer) {
                globalThis.clearInterval(handler.logManager.sweepTimer);
            }
            await unmarkManagedTab(5001);
            restore();
        }
    }
);

test('CS-N04 Extension key deadlines survive schemas, preparation and final acknowledgement', async (t) => {
    for (const mode of ['precise', 'stealth']) {
        for (const scenario of ['expired-preparation', 'late-ack']) {
            await t.test(`${mode}-${scenario}`, async () => {
                let now = 1000;
                let dispatched = 0;
                const restore = installGlobals({
                    chrome: {
                        storage: createStorage(),
                        tabs: { get: async () => ({ id: 101, url: 'https://example.com/' }) },
                        debugger: {
                            sendCommand: async () => {
                                ++dispatched;
                                now = 1101;
                            },
                        },
                        scripting: {
                            executeScript: async ({ args }) => {
                                assert.equal(args[3], 1100);
                                ++dispatched;
                                now = 1101;
                                return [{ result: { success: true } }];
                            },
                        },
                    },
                });
                const originalNow = Date.now;
                Date.now = () => now;
                try {
                    await markManagedTab(101);
                    const manager = {
                        ensureAttached: async () => {
                            if (scenario === 'expired-preparation') {
                                now = 1101;
                            }
                        },
                    };
                    const handler = mode === 'precise' ? new InputEventHandler(manager) : new StealthHandler();
                    if (mode === 'stealth' && scenario === 'expired-preparation') {
                        now = 1101;
                    }
                    const execute = () =>
                        mode === 'precise'
                            ? handler.inputKey(
                                  { tabId: 101, type: 'keyDown', key: 'a', deadline: 1100 },
                                  createActionContext()
                              )
                            : handler.stealthKey(
                                  { tabId: 101, type: 'down', key: 'a', deadline: 1100 },
                                  createActionContext()
                              );
                    if (scenario === 'expired-preparation') {
                        await assert.rejects(execute, /Navigation timeout/);
                    } else {
                        assert.deepEqual(await execute(), { success: true });
                        await assert.rejects(execute, /Navigation timeout/);
                    }
                    assert.equal(dispatched, scenario === 'expired-preparation' ? 0 : 1);
                } finally {
                    Date.now = originalNow;
                    await unmarkManagedTab(101);
                    restore();
                }
            });
        }
    }
});

test('CE-N04 popup displays fulfilled background storage failures without clearing unsaved token input', async () => {
    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id)) {
            elements.set(id, {
                value: '',
                textContent: '',
                checked: false,
                handlers: {},
                addEventListener(type, fn) {
                    this.handlers[type] = fn;
                },
                replaceChildren() {},
            });
        }
        return elements.get(id);
    };
    const restore = installGlobals({
        document: { getElementById: element, createElement: () => ({}) },
        chrome: {
            tabs: { query: async () => [] },
            runtime: {
                onMessage: chromeEvent(),
                sendMessage: async ({ type }) =>
                    type === 'GET_STATUS'
                        ? { ports: [], allowInsecureNoToken: true }
                        : { error: 'storage quota exceeded' },
            },
        },
    });
    try {
        await import('../src/popup/popup.ts');
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
        element('pairingTokenInput').value = 'unsaved-fixture-token';
        await element('saveTokenBtn').handlers.click();
        assert.match(element('authHelp').textContent, /保存 token 失败.*storage quota exceeded/);
        assert.equal(element('pairingTokenInput').value, 'unsaved-fixture-token');
        element('allowInsecureNoTokenInput').checked = false;
        await element('allowInsecureNoTokenInput').handlers.change();
        assert.match(element('authHelp').textContent, /保存无 token 连接设置失败.*storage quota exceeded/);
        assert.equal(element('allowInsecureNoTokenInput').disabled, false);
    } finally {
        restore();
    }
});

test('CH-08 serialized inspection recognizes visible verification buttons without changing iframe routing', () => {
    const options = {
        challengeSelectors: ['#cf-please-wait'],
        deniedSelectors: [],
        widgetSelectors: ['.cf-turnstile'],
        frameSelectors: ['iframe[src*="challenges.cloudflare.com"]'],
        verifyButtonSelectors: ['input[type="button"][value="Verify you are human"]'],
        titleNeedles: ['just a moment'],
        textMarkers: ['正在进行安全验证'],
        originResponsePendingTextMarkers: [],
    };
    for (const scenario of [
        { text: 'Verify you are human', source: 'page' },
        { text: '请验证您是真人', source: 'page' },
        { text: 'Continue', source: 'iframe' },
        { text: 'Verify you are human', hidden: true, source: 'iframe' },
        { text: 'Verify you are human', frame: true, source: 'iframe' },
    ]) {
        const root = {};
        const element = (tagName, textContent = '', hidden = false) => ({
            tagName,
            textContent,
            hidden,
            parentElement: root,
            getBoundingClientRect: () => ({ left: 100, top: 100, width: 300, height: 65 }),
            scrollIntoView() {},
            closest: () => null,
            getAttribute: () => null,
        });
        const wrapper = element('DIV');
        const button = element('BUTTON', scenario.text, scenario.hidden);
        const frame = {
            ...element('IFRAME'),
            getAttribute: () => 'https://challenges.cloudflare.com/test',
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
        };
        const document = {
            title: 'Just a moment...',
            body: { innerText: '正在进行安全验证' },
            documentElement: root,
            querySelector: (selector) =>
                selector === 'input[name="cf-turnstile-response"]' ? { parentElement: wrapper } : null,
            querySelectorAll: (selector) => {
                if (selector === 'button') return [element('BUTTON', 'Settings'), button];
                if (selector === 'iframe' || selector.includes('iframe[src')) return scenario.frame ? [frame] : [];
                if (selector === '#cf-please-wait') return [element('DIV')];
                if (selector === '.cf-turnstile' || selector === 'div') return [wrapper];
                return [];
            },
        };
        const window = {
            getComputedStyle: (node) => ({
                display: node.hidden ? 'none' : 'block',
                visibility: 'visible',
                opacity: '1',
            }),
        };
        const inspect = vm.runInNewContext(`(${inspectChallengePage.toString()})`, {
            document,
            window,
            location: { href: 'https://example.com/challenge' },
        });
        const result = inspect(options);
        assert.equal(result.clickSource, scenario.source, JSON.stringify(scenario));
        assert.equal(result.clickTargetKind, scenario.source === 'page' || scenario.frame ? 'verify' : 'widget');
    }
});

test('C22 attach conflicts recover only a proven debugger session owned by this Extension', async (t) => {
    for (const specimen of [
        { name: 'owned', proof: { id: 'owned-isolate' }, owned: true },
        {
            name: 'already-attached',
            message: 'Debugger is already attached',
            proof: { id: 'owned-isolate' },
            owned: true,
        },
        { name: 'external', error: new Error('Debugger is not attached') },
        { name: 'missing', proof: undefined },
        { name: 'empty', proof: { id: '' } },
        { name: 'whitespace', proof: { id: '  ' } },
        { name: 'wrong-type', proof: { id: 1 } },
    ]) {
        await t.test(specimen.name, async () => {
            let attaches = 0;
            let probes = 0;
            const restore = installGlobals({
                chrome: {
                    debugger: {
                        async attach(target) {
                            assert.deepEqual(target, { tabId: 1 });
                            ++attaches;
                            throw new Error(specimen.message ?? 'Another debugger is already attached');
                        },
                        async sendCommand(target, method) {
                            assert.deepEqual(target, { tabId: 1 });
                            if (method === 'Page.enable') {
                                return {};
                            }
                            assert.equal(method, 'Runtime.getIsolateId');
                            ++probes;
                            if (specimen.error) {
                                throw specimen.error;
                            }
                            return specimen.proof;
                        },
                    },
                },
            });
            try {
                const manager = new DebuggerManager({});
                const results = await Promise.allSettled([manager.ensureAttached(1), manager.ensureAttached(1)]);
                assert.equal(attaches, 1);
                assert.equal(probes, 1);
                assert.equal(manager.isAttached(1), specimen.owned === true);
                assert.equal(manager.isBlocked(1), specimen.owned !== true);
                if (specimen.owned) {
                    assert.ok(results.every((result) => result.status === 'fulfilled'));
                    await manager.ensureAttached(1);
                } else {
                    assert.ok(
                        results.every(
                            (result) => result.status === 'rejected' && result.reason instanceof DebuggerBlockedError
                        )
                    );
                    await assert.rejects(() => manager.ensureAttached(1), DebuggerBlockedError);
                }
                assert.equal(attaches, 1);
                assert.equal(probes, 1);
            } finally {
                restore();
            }
        });
    }
});

async function withKeyboardFocusFixture(run) {
    const fixture = createTabManagementFixture();
    const commands = [];
    let recovered = false;
    fixture.chrome.debugger.attach = async () => {
        if (recovered) {
            throw new Error('Another debugger is already attached');
        }
    };
    fixture.chrome.debugger.sendCommand = async (target, method, params) => {
        commands.push({ target, method, params });
        return method === 'Runtime.getIsolateId' ? { id: 'owned-isolate' } : {};
    };
    const restore = installGlobals({ chrome: fixture.chrome });
    const handler = new ActionHandler();
    try {
        await markManagedTab(5001);
        await run({
            ...fixture,
            handler,
            manager: handler.debuggerManager,
            commands,
            recover: () => {
                recovered = true;
            },
        });
    } finally {
        handler.cleanupTab(5001);
        globalThis.clearInterval(handler.logManager.sweepTimer);
        await unmarkManagedTab(5001);
        restore();
    }
}

const keyboardFocusRequest = (id = 'owned-keyboard') => ({
    tabId: 5001,
    operation: 'acquire',
    id,
    frameId: 0,
    documentId: 'document-5001',
    deadline: Date.now() + 30000,
});

test('NK-01 registered keyboard scope delivers native commands and restores without activating a tab', async () => {
    await withKeyboardFocusFixture(async ({ handler, commands, calls }) => {
        const context = createActionContext();
        const before = await pageSnapshot(5001);
        assert.deepEqual(await handler.execute('keyboard_focus', keyboardFocusRequest(), context), { changed: true });
        assert.equal((await pageSnapshot(5001)).revision, before.revision);
        for (const params of [
            { type: 'keyDown', key: 'Control', modifiers: 2 },
            { type: 'keyDown', key: 'a', modifiers: 2, commands: ['selectAll'] },
            { type: 'rawKeyDown', key: 'a', modifiers: 2, autoRepeat: true },
            { type: 'keyUp', key: 'a', modifiers: 2 },
            { type: 'keyUp', key: 'Control', modifiers: 0 },
        ]) {
            await handler.execute('input_key', { tabId: 5001, keyboardFocusId: 'owned-keyboard', ...params }, context);
        }
        assert.deepEqual(
            await handler.execute(
                'keyboard_focus',
                {
                    tabId: 5001,
                    operation: 'release',
                    id: 'owned-keyboard',
                },
                context
            ),
            { restored: true, errors: [] }
        );
        const focus = commands.filter(({ method }) => method === 'Emulation.setFocusEmulationEnabled');
        assert.deepEqual(
            focus.map(({ params }) => params.enabled),
            [true, false]
        );
        const keys = commands.filter(({ method }) => method === 'Input.dispatchKeyEvent');
        assert.equal(keys.length, 5);
        assert.deepEqual(keys[1].params.commands, ['selectAll']);
        assert.equal(keys[2].params.autoRepeat, true);
        assert.equal(keys[4].params.modifiers, 0);
        assert.equal(
            calls.some(({ method }) => /tabs.update|window/.test(method)),
            false
        );
    });
});

test('NK-02 known and recovered focus states preserve the original setting', async (t) => {
    for (const state of ['enabled', 'recovered-hidden', 'recovered-active']) {
        await t.test(state, async () =>
            withKeyboardFocusFixture(async ({ handler, commands, recover, tabs }) => {
                const context = createActionContext();
                if (state === 'enabled') {
                    await handler.execute(
                        'debugger_send',
                        {
                            tabId: 5001,
                            method: 'Emulation.setFocusEmulationEnabled',
                            params: { enabled: true },
                        },
                        context
                    );
                } else {
                    recover();
                    tabs.get(5001).active = state === 'recovered-active';
                }
                commands.length = 0;
                if (state === 'recovered-hidden') {
                    await assert.rejects(
                        () => handler.execute('keyboard_focus', keyboardFocusRequest(), context),
                        (error) => JSON.parse(error.message).error.code === 'KEYBOARD_FOCUS_STATE_UNKNOWN'
                    );
                } else {
                    assert.deepEqual(await handler.execute('keyboard_focus', keyboardFocusRequest(), context), {
                        changed: false,
                    });
                    assert.deepEqual(
                        await handler.execute(
                            'keyboard_focus',
                            {
                                tabId: 5001,
                                operation: 'release',
                                id: 'owned-keyboard',
                            },
                            context
                        ),
                        { restored: true, errors: [] }
                    );
                }
                assert.equal(
                    commands.some(
                        ({ method }) =>
                            method === 'Emulation.setFocusEmulationEnabled' || method === 'Input.dispatchKeyEvent'
                    ),
                    false
                );
            })
        );
    }
});

test('NK-03 scope ownership, document identity and release permission are checked independently', async () => {
    await withKeyboardFocusFixture(async ({ handler, commands, documents }) => {
        const context = createActionContext();
        await handler.execute('keyboard_focus', keyboardFocusRequest(), context);
        const wrongOwner = createActionContext({ serverInstanceId: 'other-server' });
        const wrongRelease = await handler.execute(
            'keyboard_focus',
            {
                tabId: 5001,
                operation: 'release',
                id: 'owned-keyboard',
                releaseKeys: true,
            },
            wrongOwner
        );
        assert.equal(wrongRelease.restored, false);
        await assert.rejects(
            () =>
                handler.execute(
                    'input_key',
                    {
                        tabId: 5001,
                        keyboardFocusId: 'owned-keyboard',
                        type: 'keyDown',
                        key: 'a',
                    },
                    wrongOwner
                ),
            (error) => JSON.parse(error.message).error.code === 'KEYBOARD_FOCUS_EXPIRED'
        );
        documents.set(5001, 'replacement-document');
        await assert.rejects(
            () =>
                handler.execute(
                    'input_key',
                    {
                        tabId: 5001,
                        keyboardFocusId: 'owned-keyboard',
                        type: 'keyDown',
                        key: 'a',
                    },
                    context
                ),
            (error) => JSON.parse(error.message).error.code === 'FRAME_IDENTITY_CHANGED'
        );
        await unmarkManagedTab(5001);
        assert.deepEqual(
            await handler.execute(
                'keyboard_focus',
                {
                    tabId: 5001,
                    operation: 'release',
                    id: 'owned-keyboard',
                    releaseKeys: true,
                },
                context
            ),
            { restored: true, errors: [] }
        );
        assert.equal(
            commands.some(({ method }) => method === 'Input.dispatchKeyEvent'),
            false
        );
        assert.deepEqual(
            commands
                .filter(({ method }) => method === 'Emulation.setFocusEmulationEnabled')
                .map(({ params }) => params.enabled),
            [true, false]
        );
    });
});

test('NK-04 owner disconnect releases only newly pressed keys before restoring even after keyUp failure', async () => {
    await withKeyboardFocusFixture(async ({ handler, manager, commands, chrome }) => {
        const context = createActionContext();
        await handler.execute('keyboard_focus', keyboardFocusRequest(), context);
        await handler.execute(
            'input_key',
            {
                tabId: 5001,
                keyboardFocusId: 'owned-keyboard',
                type: 'rawKeyDown',
                key: 'Control',
                autoRepeat: true,
                modifiers: 2,
            },
            context
        );
        await handler.execute(
            'input_key',
            { tabId: 5001, keyboardFocusId: 'owned-keyboard', type: 'keyDown', key: 'Shift', modifiers: 10 },
            context
        );
        const send = chrome.debugger.sendCommand;
        chrome.debugger.sendCommand = async (target, method, params) => {
            const value = await send(target, method, params);
            if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp') {
                throw new Error('owned key release failed');
            }
            return value;
        };
        await assert.rejects(
            () => handler.releaseKeyboardFocusOwner(context.serverInstanceId),
            /owned key release failed/
        );
        const release = await manager.releaseKeyboardFocus(5001, 'owned-keyboard', context.serverInstanceId, true);
        assert.equal(release.restored, false);
        const keys = commands.filter(
            ({ method, params }) => method === 'Input.dispatchKeyEvent' && params.type === 'keyUp'
        );
        assert.deepEqual(
            keys.map(({ params }) => [params.key, params.modifiers]),
            [['Shift', 2]]
        );
        assert.equal(commands.at(-1).method, 'Emulation.setFocusEmulationEnabled');
        assert.equal(commands.at(-1).params.enabled, false);
    });
});

test('NK-05 cancellation and late acquisition replies keep newer restoration state', async () => {
    await withKeyboardFocusFixture(async ({ manager, commands, chrome }) => {
        const entered = createDeferred();
        const held = createDeferred();
        const send = chrome.debugger.sendCommand;
        chrome.debugger.sendCommand = async (target, method, params) => {
            const value = await send(target, method, params);
            if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled) {
                entered.resolve();
                await held.promise;
            }
            return value;
        };
        const abort = new AbortController();
        const context = createActionContext({ signal: abort.signal, deadline: Date.now() + 30000 });
        const operation = manager.acquireKeyboardFocus(5001, 'cancelled', 0, 'document-5001', context);
        await entered.promise;
        abort.abort(new Error('owned cancellation'));
        assert.deepEqual(await manager.releaseKeyboardFocus(5001, 'cancelled', context.serverInstanceId, true), {
            restored: true,
            errors: [],
        });
        held.resolve();
        await assert.rejects(operation, /owned cancellation|cancelled/i);
        assert.equal(manager.focusStates.get(5001), false);
        assert.deepEqual(
            commands
                .filter(({ method }) => method === 'Emulation.setFocusEmulationEnabled')
                .map(({ params }) => params.enabled),
            [true, false]
        );
    });
});

test('NK-06 expiry and navigation stop further keys while restoration remains independently attempted', async () => {
    await withKeyboardFocusFixture(async ({ handler, manager, documents, commands }) => {
        const context = createActionContext();
        await handler.execute('keyboard_focus', keyboardFocusRequest(), context);
        await handler.execute(
            'input_key',
            { tabId: 5001, keyboardFocusId: 'owned-keyboard', type: 'keyDown', key: 'a' },
            context
        );
        documents.set(5001, 'new-document');
        const result = await manager.releaseKeyboardFocus(5001, 'owned-keyboard', context.serverInstanceId, true);
        assert.equal(result.restored, false);
        assert.match(result.errors[0], /原文档/);
        assert.equal(commands.filter(({ method }) => method === 'Input.dispatchKeyEvent').length, 1);
        assert.equal(commands.at(-1).params.enabled, false);
        manager.cleanupTab(5001);
        documents.delete(5001);
        await manager.ensureAttached(5001);
        const count = commands.length;
        await assert.rejects(() =>
            handler.execute('keyboard_focus', { ...keyboardFocusRequest('expired'), deadline: 0 }, context)
        );
        assert.equal(commands.length, count);
    });
});

test('NK-07 an acquired scope expires and releases its keys without another server request', async () => {
    await withKeyboardFocusFixture(async ({ manager, handler, commands }) => {
        const context = createActionContext({ deadline: Date.now() + 50 });
        await manager.acquireKeyboardFocus(5001, 'expires', 0, 'document-5001', context);
        await handler.execute(
            'input_key',
            { tabId: 5001, keyboardFocusId: 'expires', type: 'keyDown', key: 'Shift', modifiers: 8 },
            createActionContext()
        );
        await waitUntil(() => manager.keyboardFocusLeases.get(5001)?.state === 'released');
        const result = await manager.releaseKeyboardFocus(5001, 'expires', context.serverInstanceId, true);
        assert.deepEqual(result, { restored: true, errors: [] });
        assert.deepEqual(
            commands
                .filter(({ method }) => method === 'Input.dispatchKeyEvent')
                .map(({ params }) => [params.type, params.key]),
            [
                ['keyDown', 'Shift'],
                ['keyUp', 'Shift'],
            ]
        );
        assert.equal(commands.at(-1).params.enabled, false);
        await assert.rejects(
            () =>
                handler.execute(
                    'input_key',
                    { tabId: 5001, keyboardFocusId: 'expires', type: 'keyDown', key: 'a' },
                    createActionContext()
                ),
            (error) => JSON.parse(error.message).error.code === 'KEYBOARD_FOCUS_EXPIRED'
        );
    });
});

test('NK-08 an old restoration failure cannot erase a replacement session setting', async () => {
    await withKeyboardFocusFixture(async ({ manager, chrome }) => {
        const context = createActionContext();
        await manager.acquireKeyboardFocus(5001, 'old', 0, 'document-5001', context);
        const entered = createDeferred();
        const held = createDeferred();
        const send = chrome.debugger.sendCommand;
        chrome.debugger.sendCommand = async (target, method, params) => {
            if (method === 'Emulation.setFocusEmulationEnabled' && !params.enabled) {
                entered.resolve();
                await held.promise;
                throw new Error('old restoration failure');
            }
            return send(target, method, params);
        };
        const release = manager.releaseKeyboardFocus(5001, 'old', context.serverInstanceId, true);
        await entered.promise;
        manager.cleanupTab(5001);
        await manager.ensureAttached(5001);
        await manager.setFocusEmulation(5001, true);
        held.resolve();
        assert.equal((await release).restored, false);
        assert.equal(manager.focusStates.get(5001), true);
    });
});

test('NK-09 mixed text input keeps completed progress and stops at a replacement document', async () => {
    await withKeyboardFocusFixture(async ({ handler, commands, documents, chrome, manager }) => {
        const context = createActionContext();
        await handler.execute('keyboard_focus', keyboardFocusRequest(), context);
        const send = chrome.debugger.sendCommand;
        chrome.debugger.sendCommand = async (target, method, params) => {
            const result = await send(target, method, params);
            if (method === 'Input.dispatchKeyEvent' && params.type === 'char') {
                documents.set(5001, 'replacement');
            }
            return result;
        };
        await assert.rejects(
            () =>
                handler.execute('input_type', { tabId: 5001, keyboardFocusId: 'owned-keyboard', text: 'ab' }, context),
            (error) => {
                const detail = JSON.parse(error.message).error;
                assert.equal(detail.code, 'FRAME_IDENTITY_CHANGED');
                assert.equal(detail.context.actionExecuted, true);
                assert.equal(detail.context.actionStatus, 'partial');
                return true;
            }
        );
        assert.deepEqual(
            commands.filter(({ method }) => method === 'Input.dispatchKeyEvent').map(({ params }) => params.text),
            ['a']
        );
        assert.deepEqual(await manager.releaseKeyboardFocus(5001, 'owned-keyboard', context.serverInstanceId, true), {
            restored: true,
            errors: [],
        });
    });
});

test('C22 cleanup invalidates an ownership probe without removing a replacement pending attach', async () => {
    const proof = createDeferred();
    const replacement = createDeferred();
    let attaches = 0;
    let probes = 0;
    const restore = installGlobals({
        chrome: {
            debugger: {
                async attach() {
                    if (++attaches === 1) {
                        throw new Error('Another debugger is already attached');
                    }
                    await replacement.promise;
                },
                async sendCommand() {
                    ++probes;
                    return proof.promise;
                },
            },
        },
    });
    try {
        const manager = new DebuggerManager({});
        const first = manager.ensureAttached(1);
        await waitUntil(() => probes === 1);
        manager.cleanupTab(1);
        const second = manager.ensureAttached(1);
        proof.resolve({ id: 'previous-isolate' });
        await first;
        assert.equal(manager.isAttached(1), false);
        const third = manager.ensureAttached(1);
        assert.equal(attaches, 2);
        replacement.resolve();
        await Promise.all([second, third]);
        assert.equal(attaches, 2);
        assert.equal(manager.isAttached(1), true);
    } finally {
        proof.resolve({ id: 'previous-isolate' });
        replacement.resolve();
        restore();
    }
});

test('C22 non-conflict attach errors retain the original error without probing', async () => {
    const failure = new Error('No tab with given id');
    let probes = 0;
    const restore = installGlobals({
        chrome: {
            debugger: {
                async attach() {
                    throw failure;
                },
                async sendCommand() {
                    ++probes;
                },
            },
        },
    });
    try {
        const manager = new DebuggerManager({});
        await assert.rejects(
            () => manager.ensureAttached(1),
            (error) => error === failure
        );
        assert.equal(probes, 0);
        assert.equal(manager.isAttached(1), false);
        assert.equal(manager.isBlocked(1), false);
    } finally {
        restore();
    }
});

test('C31F6 debugger context lifecycle isolates equal context IDs across child sessions', async () => {
    const onEvent = chromeEvent();
    const onDetach = chromeEvent();
    const restore = installGlobals({
        chrome: {
            debugger: {
                onEvent,
                onDetach,
                attach: async () => {},
                sendCommand: async () => ({}),
            },
        },
    });
    try {
        const manager = new DebuggerManager({ handleEvent() {}, handleDebuggerDetach() {} });
        manager.setupListeners();
        await manager.ensureAttached(1);
        const created = (sessionId, frameId) =>
            onEvent.emit({ tabId: 1, ...(sessionId ? { sessionId } : {}) }, 'Runtime.executionContextCreated', {
                context: { id: 1, auxData: { frameId, isDefault: true } },
            });
        created(undefined, 'root');
        created('child-a', 'frame-a');
        created('child-b', 'frame-b');
        assert.equal(manager.getExecutionContexts(1).length, 3);
        onEvent.emit({ tabId: 1 }, 'Runtime.executionContextsCleared', {});
        assert.deepEqual(
            manager.getExecutionContexts(1).map((item) => item.sessionId),
            ['child-a', 'child-b']
        );
        onEvent.emit({ tabId: 1, sessionId: 'child-a' }, 'Runtime.executionContextDestroyed', {
            executionContextId: 1,
        });
        assert.deepEqual(
            manager.getExecutionContexts(1).map((item) => item.sessionId),
            ['child-b']
        );
        created('child-a', 'frame-a');
        onEvent.emit({ tabId: 1 }, 'Target.detachedFromTarget', { sessionId: 'child-a' });
        assert.deepEqual(
            manager.getExecutionContexts(1).map((item) => item.sessionId),
            ['child-b']
        );
        created(undefined, 'root');
        manager.invalidateExecutionContext(1, 1);
        assert.deepEqual(
            manager.getExecutionContexts(1).map((item) => item.sessionId),
            ['child-b']
        );
        manager.cleanupTab(1);
        assert.deepEqual(manager.getExecutionContexts(1), []);
    } finally {
        restore();
    }
});

test('C24 serialized inspection preserves pending challenges and ignores residual iframe/input controls', () => {
    for (const scenario of [
        { title: 'Just a moment...', pending: true },
        { title: 'Owned recovered', pending: false },
        { title: 'Owned recovered', response: true, pending: false },
        { title: 'Just a moment...', response: true, originPending: true, pending: false },
    ]) {
        let scrolls = 0;
        const unrelated = {
            tagName: 'DIV',
            getBoundingClientRect: () => ({ left: 107, top: 267, width: 318, height: 58 }),
            scrollIntoView() {
                ++scrolls;
            },
            closest: () => null,
        };
        const frame = {
            tagName: 'IFRAME',
            getAttribute: () => 'https://challenges.cloudflare.com/turnstile/test',
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
        };
        const inspect = vm.runInNewContext(`(${inspectChallengePage.toString()})`, {
            document: {
                title: scenario.title,
                body: {
                    innerText: scenario.originPending
                        ? 'Verification successful. Waiting for origin response'
                        : 'Editable content here for select/replace',
                },
                querySelector: () => (scenario.response ? { parentElement: unrelated } : null),
                querySelectorAll: (selector) =>
                    selector === 'div' ? [unrelated] : selector.includes('iframe') ? [frame] : [],
            },
            window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
            location: { href: 'https://example.com/challenge' },
        });
        const result = inspect({
            challengeSelectors: [],
            deniedSelectors: [],
            widgetSelectors: ['.cf-turnstile'],
            verifyButtonSelectors: ['input[type="button"]'],
            frameSelectors: ['iframe[src*="challenges.cloudflare.com"]'],
            titleNeedles: ['just a moment'],
            textMarkers: [],
            originResponsePendingTextMarkers: ['Verification successful. Waiting for'],
        });
        assert.equal(result.turnstilePresent, scenario.pending, JSON.stringify(scenario));
        assert.equal(result.clickPoint, null);
        assert.equal(result.clickTargetKind, null);
        assert.equal(scrolls, 0);
    }
});

test('C-P6 expired queued navigation does not reach its handler', async (t) => {
    for (const action of [
        'navigate',
        'go_back',
        'go_forward',
        'reload',
        'stealth_click',
        'input_mouse',
        'input_key',
        'stealth_key',
        'stealth_mouse',
        'debugger_detach',
        'challenge_inspect',
    ]) {
        await t.test(action, async () => {
            const fixture = createTabManagementFixture();
            const NativeDate = Date;
            let now = 1000;
            class ClockDate extends NativeDate {
                static now() {
                    return now;
                }
            }
            const restore = installGlobals({ chrome: fixture.chrome, Date: ClockDate });
            const blocker = createDeferred();
            const entered = createDeferred();
            let handler;
            let dispatched = 0;
            try {
                await markManagedTab(5001);
                handler = new ActionHandler();
                handler.actions.set('evaluate', async () => {
                    entered.resolve();
                    await blocker.promise;
                });
                handler.actions.set(action, async () => {
                    ++dispatched;
                });
                const previous = handler.execute('evaluate', { tabId: 5001 }, createActionContext());
                await entered.promise;
                const queued = handler.execute(action, { tabId: 5001, deadline: now + 100 }, createActionContext());
                now += 200;
                blocker.resolve();
                await previous;
                await assert.rejects(
                    () => queued,
                    (error) => {
                        const body = JSON.parse(error.message).error;
                        assert.equal(body.code, 'TIMEOUT');
                        assert.equal(body.context.actionExecuted, false);
                        assert.equal(body.context.retryable, false);
                        return true;
                    }
                );
                assert.equal(dispatched, 0);
                assert.equal(handler.actionLocks.size, 0);
            } finally {
                blocker.resolve();
                if (handler?.logManager.sweepTimer) {
                    globalThis.clearInterval(handler.logManager.sweepTimer);
                }
                await unmarkManagedTab(5001);
                forgetPageRevision(5001);
                restore();
            }
        });
    }
});

test('C10 mouse deadlines survive schemas and asynchronous preparation', async (t) => {
    for (const route of ['precise', 'stealth']) {
        for (const stage of ['page', 'dispatch', 'within-budget']) {
            await t.test(`${route}-${stage}`, async () => {
                const fixture = createTabManagementFixture();
                const NativeDate = Date;
                let now = 1000;
                let nativeEvents = 0;
                let scriptCalls = 0;
                class ClockDate extends NativeDate {
                    static now() {
                        return now;
                    }
                }
                const element = {
                    dispatchEvent() {
                        ++nativeEvents;
                    },
                };
                const getTab = fixture.chrome.tabs.get;
                fixture.chrome.tabs.get = async (...args) => {
                    const tab = await getTab(...args);
                    if (stage === 'page') {
                        now = 1200;
                    }
                    return { ...tab, active: true };
                };
                fixture.chrome.debugger.sendCommand = async () => {
                    ++nativeEvents;
                };
                fixture.chrome.scripting = {
                    executeScript: async ({ func, args }) => {
                        ++scriptCalls;
                        if (stage === 'dispatch') {
                            now = 1200;
                        }
                        return [{ result: func(...args) }];
                    },
                };
                const restore = installGlobals({
                    chrome: fixture.chrome,
                    Date: ClockDate,
                    window: { screenX: 0, screenY: 0 },
                    document: { elementFromPoint: () => element, body: element },
                    MouseEvent: class {
                        constructor(type, options) {
                            Object.assign(this, { type }, options);
                        }
                    },
                });
                try {
                    await markManagedTab(5001);
                    now = 1000;
                    const handler =
                        route === 'precise'
                            ? new InputEventHandler({
                                  ensureAttached: async () => {
                                      if (stage === 'dispatch') {
                                          now = 1200;
                                      }
                                  },
                              })
                            : new StealthHandler();
                    const method = route === 'precise' ? 'inputMouse' : 'stealthMouse';
                    const params = {
                        tabId: 5001,
                        frameId: 0,
                        type: route === 'precise' ? 'mouseMoved' : 'mousemove',
                        x: 12,
                        y: 34,
                        deadline: 1100,
                    };
                    if (stage === 'within-budget') {
                        assert.deepEqual(await handler[method](params, {}), { success: true });
                        assert.equal(nativeEvents, 1);
                    } else {
                        await assert.rejects(() => handler[method](params, {}), /timeout/i);
                        assert.equal(nativeEvents, 0);
                    }
                    assert.equal(scriptCalls, route === 'stealth' && stage !== 'page' ? 1 : 0);
                    if (route === 'precise') {
                        assert.equal(handler.buttonsState.size, 0);
                    }
                } finally {
                    await unmarkManagedTab(5001);
                    restore();
                }
            });
        }
    }
});

test('C-P6 Challenge native dispatch checks the budget after page validation', async (t) => {
    for (const action of ['stealth_click', 'debugger_detach', 'challenge_inspect']) {
        await t.test(action, async () => {
            const fixture = createTabManagementFixture();
            const NativeDate = Date;
            let now = 1000;
            let dispatched = 0;
            class ClockDate extends NativeDate {
                static now() {
                    return now;
                }
            }
            const getTab = fixture.chrome.tabs.get;
            fixture.chrome.tabs.get = async (...args) => {
                const tab = await getTab(...args);
                now = 2000;
                return tab;
            };
            fixture.chrome.scripting = {
                executeScript: async () => {
                    ++dispatched;
                    return [{ result: { success: true } }];
                },
            };
            fixture.chrome.debugger.detach = async () => {
                ++dispatched;
            };
            const restore = installGlobals({ chrome: fixture.chrome, Date: ClockDate });
            try {
                await markManagedTab(5001);
                now = 1000;
                const params = {
                    tabId: 5001,
                    deadline: 1100,
                    x: 12,
                    y: 34,
                    challengeSelectors: [],
                    deniedSelectors: [],
                    widgetSelectors: [],
                    verifyButtonSelectors: [],
                    frameSelectors: [],
                    titleNeedles: [],
                    textMarkers: [],
                    originResponsePendingTextMarkers: [],
                };
                const manager = { isAttached: () => true, cleanupTab() {} };
                const handler =
                    action === 'stealth_click'
                        ? new StealthHandler()
                        : action === 'debugger_detach'
                          ? new DebuggerHandler(manager, { handleDebuggerDetach() {} })
                          : new ContentHandler(manager);
                const method =
                    action === 'stealth_click'
                        ? 'stealthClick'
                        : action === 'debugger_detach'
                          ? 'debuggerDetach'
                          : 'inspectChallenge';
                await assert.rejects(() => handler[method](params, {}), /timeout/i);
                assert.equal(dispatched, 0);
            } finally {
                await unmarkManagedTab(5001);
                restore();
            }
        });
    }
});

test('C-P6 history signal and load waits share one navigation budget', async () => {
    const fixture = createTabManagementFixture();
    const NativeDate = Date;
    let now = 1000;
    class ClockDate extends NativeDate {
        static now() {
            return now;
        }
    }
    const restore = installGlobals({ chrome: fixture.chrome, Date: ClockDate });
    const waits = [];
    const handler = new NavigationHandler({});
    handler.navigateHistory = async () => {
        now += 40;
        return true;
    };
    handler.waitForNavigation = async (_tabId, _wait, timeout) => {
        waits.push(timeout);
    };
    try {
        await markManagedTab(5001);
        await handler.goBack(
            { tabId: 5001, waitUntil: 'load', timeout: 100, deadline: now + 100 },
            createActionContext()
        );
        await handler.goForward(
            { tabId: 5001, waitUntil: 'load', timeout: 100, deadline: now + 100 },
            createActionContext()
        );
        assert.deepEqual(waits, [60, 60]);
    } finally {
        await unmarkManagedTab(5001);
        restore();
    }
});

test('C-P6 expired navigation is rejected before native URL update', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    const handler = new NavigationHandler({});
    try {
        await markManagedTab(5001);
        await assert.rejects(
            () =>
                handler.navigate(
                    { tabId: 5001, url: 'https://example.com/next', deadline: Date.now() - 1 },
                    createActionContext()
                ),
            /timeout/i
        );
        assert.equal(
            fixture.calls.some((call) => call.method === 'tabs.update'),
            false
        );
    } finally {
        await unmarkManagedTab(5001);
        restore();
    }
});

test('MH-CH-01 partial precise input invalidates revisions and rejects stale subsequent actions', async (t) => {
    for (const stage of ['before', 'char', 'deadline-char', 'keyDown', 'deadline-keyDown']) {
        await t.test(stage, async () => {
            const fixture = createTabManagementFixture();
            const controller = new globalThis.AbortController();
            let now = 1000;
            const NativeDate = Date;
            class ClockDate extends NativeDate {
                static now() {
                    return now;
                }
            }
            const calls = [];
            fixture.chrome.debugger.sendCommand = async (_target, _method, params) => {
                calls.push({ type: params.type, text: params.text });
                if (stage === params.type) {
                    controller.abort(new Error('fixture cancelled'));
                }
                if (stage === `deadline-${params.type}`) {
                    now = 1100;
                }
            };
            const restore = installGlobals({ chrome: fixture.chrome, Date: ClockDate });
            let handler;
            try {
                await markManagedTab(5001);
                handler = new ActionHandler();
                handler.debuggerManager.ensureAttached = async () => {};
                const before = await pageSnapshot(5001);
                if (stage === 'before') {
                    controller.abort(new Error('fixture cancelled'));
                }
                await assert.rejects(
                    () =>
                        handler.execute(
                            'input_type',
                            {
                                tabId: 5001,
                                text: stage.endsWith('keyDown') ? '\nBC' : 'ABC',
                                deadline: 1100,
                                expectedRevision: before.revision,
                            },
                            createActionContext({ signal: controller.signal, deadline: 1100 })
                        ),
                    (error) => {
                        const body = JSON.parse(error.message).error;
                        assert.equal(body.context.actionExecuted, stage !== 'before');
                        assert.equal(body.context.actionStatus, stage === 'before' ? 'not_started' : 'partial');
                        assert.equal(body.context.retryable, false);
                        return true;
                    }
                );
                const after = await pageSnapshot(5001);
                if (stage === 'before') {
                    assert.equal(after.revision, before.revision);
                    assert.deepEqual(calls, []);
                } else {
                    assert.notEqual(after.revision, before.revision);
                    assert.deepEqual(
                        calls.map((call) => call.type),
                        stage.endsWith('keyDown') ? ['keyDown', 'keyUp'] : ['char']
                    );
                    if (!stage.endsWith('keyDown')) {
                        assert.equal(calls[0].text, 'A');
                    }
                    const count = calls.length;
                    await assert.rejects(
                        () =>
                            handler.execute(
                                'input_type',
                                { tabId: 5001, text: 'D', expectedRevision: before.revision },
                                createActionContext()
                            ),
                        /ACTION_PRECONDITION_FAILED/
                    );
                    assert.equal(calls.length, count);
                }
            } finally {
                if (handler?.logManager.sweepTimer) {
                    globalThis.clearInterval(handler.logManager.sweepTimer);
                }
                await unmarkManagedTab(5001);
                forgetPageRevision(5001);
                restore();
            }
        });
    }
});

test('C10 precise typing stops at the execution deadline', async (t) => {
    for (const specimen of [
        { text: 'abc', delay: 0, budget: 15, expected: 'ab' },
        { text: 'abc', delay: 100, budget: 50, expected: 'a' },
        { text: 'abc', delay: 0, budget: 0, expected: '' },
    ]) {
        await t.test(JSON.stringify(specimen), async () => {
            let now = 1000;
            const typed = [];
            const NativeDate = Date;
            class ClockDate extends NativeDate {
                static now() {
                    return now;
                }
            }
            const restore = installGlobals({
                Date: ClockDate,
                setTimeout(callback, ms) {
                    now += ms;
                    callback();
                    return 0;
                },
                chrome: {
                    storage: createStorage(),
                    tabs: { get: async () => ({ id: 101, url: 'https://example.com/owned' }) },
                    debugger: {
                        async sendCommand(_target, _method, params) {
                            if (params.type === 'char') {
                                typed.push(params.text);
                            }
                            now += 10;
                        },
                    },
                },
            });
            try {
                await markManagedTab(101);
                const handler = new InputEventHandler({ ensureAttached: async () => {} });
                await assert.rejects(
                    () =>
                        handler.inputType(
                            {
                                tabId: 101,
                                text: specimen.text,
                                delay: specimen.delay,
                                deadline: now + specimen.budget,
                            },
                            createActionContext()
                        ),
                    /timeout|超时/i
                );
                assert.equal(typed.join(''), specimen.expected);
            } finally {
                await unmarkManagedTab(101);
                restore();
            }
        });
    }
});

test('C10 precise typing keeps CRLF normalization within a sufficient budget', async () => {
    const calls = [];
    const restore = installGlobals({
        chrome: {
            storage: createStorage(),
            tabs: { get: async () => ({ id: 101, url: 'https://example.com/owned' }) },
            debugger: {
                sendCommand: async (_target, _method, params) => {
                    calls.push(params);
                },
            },
        },
    });
    try {
        await markManagedTab(101);
        const handler = new InputEventHandler({ ensureAttached: async () => {} });
        const result = await handler.inputType(
            { tabId: 101, text: 'a\r\nb\rc', deadline: Date.now() + 1000 },
            createActionContext()
        );
        assert.equal(result.success, true);
        assert.deepEqual(
            calls.filter((call) => call.type === 'char').map((call) => call.text),
            ['a', '\r', 'b', '\r', 'c']
        );
        assert.equal(calls.filter((call) => call.key === 'Enter').length, 6);
    } finally {
        await unmarkManagedTab(101);
        restore();
    }
});

test('C10 precise typing releases Enter after a keydown acknowledgement failure', async () => {
    const calls = [];
    const failure = new ExpectedOperationError('input timeout during typing');
    const restore = installGlobals({
        chrome: {
            storage: createStorage(),
            tabs: { get: async () => ({ id: 101, url: 'https://example.com/owned' }) },
            debugger: {
                sendCommand: async (_target, _method, params) => {
                    calls.push(params);
                    if (params.type === 'keyDown') {
                        throw failure;
                    }
                },
            },
        },
    });
    try {
        await markManagedTab(101);
        const handler = new InputEventHandler({ ensureAttached: async () => {} });
        await assert.rejects(
            () =>
                handler.inputType(
                    {
                        tabId: 101,
                        text: '\n',
                        deadline: Date.now() + 1000,
                    },
                    createActionContext()
                ),
            (error) => error === failure
        );
        assert.deepEqual(
            calls.map((params) => params.type),
            ['keyDown', 'keyUp']
        );
        calls.length = 0;
        await assert.rejects(
            () =>
                handler.inputType(
                    {
                        tabId: 101,
                        text: '\n',
                        deadline: 0,
                    },
                    createActionContext()
                ),
            /timeout|超时/i
        );
        assert.deepEqual(calls, []);
    } finally {
        await unmarkManagedTab(101);
        restore();
    }
});

test('R-02 precise typing releases Enter after cancellation or deadline without typing later characters', async (t) => {
    for (const stage of ['before', 'keyDown', 'char', 'deadline-keyDown', 'deadline-char']) {
        await t.test(stage, async () => {
            let now = 1000;
            const NativeDate = Date;
            class ClockDate extends NativeDate {
                static now() {
                    return now;
                }
            }
            const controller = new globalThis.AbortController();
            const calls = [];
            const context = createActionContext({ signal: controller.signal, deadline: 1100 });
            const restore = installGlobals({
                Date: ClockDate,
                chrome: {
                    storage: createStorage(),
                    tabs: { get: async () => ({ id: 101, url: 'https://example.com/owned' }) },
                    debugger: {
                        async sendCommand(_target, _method, params) {
                            calls.push(params.type);
                            if (stage === params.type) {
                                controller.abort(new Error('fixture cancellation'));
                            }
                            if (stage === `deadline-${params.type}`) {
                                now = context.deadline;
                            }
                        },
                    },
                },
            });
            try {
                await markManagedTab(101);
                if (stage === 'before') {
                    controller.abort(new Error('fixture cancellation'));
                }
                const handler = new InputEventHandler({ ensureAttached: async () => {} });
                await assert.rejects(
                    () => handler.inputType({ tabId: 101, text: '\nafter', deadline: 1100 }, context),
                    /REQUEST_CANCELLED|TIMEOUT/i
                );
                assert.deepEqual(
                    calls,
                    stage === 'before'
                        ? []
                        : stage.endsWith('char')
                          ? ['keyDown', 'char', 'keyUp']
                          : ['keyDown', 'keyUp']
                );
            } finally {
                await unmarkManagedTab(101);
                restore();
            }
        });
    }
});

test('C10 stealth typing stops in the injected function and propagates its failure', async (t) => {
    let now = 1000;
    let minimumTimerDelay = 0;
    const events = [];
    class Input {
        tagName = 'TEXTAREA';
        isContentEditable = false;
        stored = '';
        get value() {
            return this.stored;
        }

        set value(value) {
            this.stored = value.replace(/\r\n?/g, '\n');
        }

        dispatchEvent(event) {
            events.push(event.type);
        }
    }
    class Event {
        constructor(type) {
            this.type = type;
        }
    }
    const element = new Input();
    const run = vm.runInNewContext(`(${installDomHelpers.toString()})();(${simulateKeyboardType.toString()})`, {
        document: { activeElement: element },
        window: {},
        HTMLInputElement: Input,
        HTMLTextAreaElement: Input,
        Event,
        KeyboardEvent: Event,
        InputEvent: Event,
        Date: { now: () => now },
        setTimeout(callback, ms) {
            now += Math.max(ms, minimumTimerDelay);
            callback();
            return 0;
        },
    });
    await t.test('background timers delay only subsequent characters', async () => {
        minimumTimerDelay = 1000;
        const partial = await run('abc', 100, 2000);
        assert.equal(partial.success, false);
        assert.match(partial.error, /timeout|超时/i);
        assert.equal(element.value, 'a');
        assert.equal(events.filter((type) => type === 'input').length, 1);
        assert.equal(events.includes('change'), false);
        element.value = '';
        events.length = 0;
        const expired = await run('blocked', 100, now);
        assert.equal(expired.success, false);
        assert.equal(element.value, '');
        assert.deepEqual(events, []);
    });
    now = 1000;
    minimumTimerDelay = 0;
    element.value = '';
    events.length = 0;
    const result = await run('abc', 100, 1150);
    assert.equal(result.success, false);
    assert.match(result.error, /timeout|超时/i);
    assert.equal(element.value, 'ab');
    assert.equal(events.filter((type) => type === 'input').length, 2);
    element.value = '';
    events.length = 0;
    const normalized = await run('a\r\nb\rc', 0, 2000);
    assert.equal(normalized.success, true);
    assert.equal(element.value, 'a\nb\nc');
    assert.equal(events.filter((type) => type === 'input').length, 5);
    const injections = [];
    const restore = installGlobals({
        chrome: {
            storage: createStorage(),
            tabs: { get: async () => ({ id: 101, url: 'https://example.com/owned' }) },
            scripting: {
                executeScript: async (params) => {
                    injections.push(params);
                    return [{ result }];
                },
            },
        },
    });
    try {
        await markManagedTab(101);
        await assert.rejects(
            () =>
                new StealthHandler().stealthType(
                    {
                        tabId: 101,
                        frameId: 3,
                        text: 'abc',
                        delay: 100,
                        deadline: 1150,
                    },
                    createActionContext()
                ),
            /timeout|超时/i
        );
        assert.equal(injections.length, 1);
        assert.deepEqual(injections[0].target.frameIds, [3]);
        assert.deepEqual(injections[0].args, ['abc', 100, 1150]);
    } finally {
        await unmarkManagedTab(101);
        restore();
    }
});

function frameSnapshotFixture(executeScript) {
    const results = new Map();
    return async (request) => {
        const token = request.args?.[0];
        if (request.func.name === 'startDomFrameProbe') {
            results.set(token, await executeScript(request));
            return [{ result: true }];
        }
        if (request.func.name === 'awaitDomFrameProbe') {
            return results.get(token);
        }
        if (request.func.name === 'stopDomFrameProbe') {
            if (request.args[1]) {
                results.delete(token);
            }
            return [];
        }
        return executeScript(request);
    };
}

function installGlobals(values) {
    const executeScript = values.chrome?.scripting?.executeScript;
    if (executeScript) {
        values.chrome.scripting.executeScript = async (request) => {
            if (request.func === installDomHelpers || request.func?.name === 'installDomHelpers') {
                if (globalThis.document) {
                    installDomHelpers();
                }
                return [
                    {
                        frameId: request.target.frameIds?.[0] ?? 0,
                        documentId: request.target.documentIds?.[0],
                        result: undefined,
                    },
                ];
            }
            return executeScript(request);
        };
    }
    const descriptors = new Map([['__mcpDomHelpers', Object.getOwnPropertyDescriptor(globalThis, '__mcpDomHelpers')]]);
    for (const [name, value] of Object.entries(values)) {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    if (Object.hasOwn(values, 'document') || Object.hasOwn(values, 'window')) {
        installDomHelpers();
    }
    if (values.chrome?.debugger && !values.chrome.debugger.sendCommand) {
        values.chrome.debugger.sendCommand = async (_target, method) => {
            assert.equal(method, 'Page.enable');
            return {};
        };
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
    onopen = null;
    onclose = null;
    onerror = null;
    onmessage = null;

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
        sessionValues,
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
    const fixture = createTabManagementFixture();
    const tab = { id: 901, url: 'https://example.com/a' };
    fixture.tabs.set(tab.id, tab);
    let handler;
    const restore = installGlobals({ chrome: fixture.chrome });
    try {
        await markManagedTab(tab.id);
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
            createActionContext()
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
        await unmarkManagedTab(tab.id);
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
        await assert.rejects(() => handler.execute('evaluate', { tabId: tab.id, code: '1+1' }, context), /非托管/);
        await assert.rejects(() => handler.execute('screenshot', { tabId: tab.id }, context), /非托管/);
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

test('C4 explicit adoption grants full managed access and release revokes it without changing groups', async () => {
    const tab = { id: 2901, url: 'https://example.com/adopted', groupId: 77, windowId: 5 };
    const context = { serverInstanceId: 'adopt-server', mcpWindowId: null, mcpTabGroupId: 77 };
    const worlds = [];
    let handler;
    let ungrouped = 0;
    const restore = installGlobals({
        chrome: {
            tabs: {
                get: async () => tab,
                async ungroup() {
                    ungrouped++;
                    tab.groupId = -1;
                },
            },
            storage: createStorage(),
            webNavigation: {
                getFrame: async () => ({ documentId: 'adopted-document', url: tab.url }),
            },
            scripting: {
                async executeScript(options) {
                    worlds.push(options.world);
                    return [{ result: { text: 'adopted content' } }];
                },
            },
            debugger: { onDetach: chromeEvent(), onEvent: chromeEvent() },
        },
    });
    try {
        handler = new ActionHandler();
        await unmarkManagedTab(tab.id);
        const adopted = await handler.execute('tabs_adopt', { tabId: tab.id }, context);
        assert.equal(adopted.managedAfter, true);
        assert.deepEqual(await handler.execute('get_text', { tabId: tab.id }, context), { text: 'adopted content' });
        assert.equal(worlds.at(-1), 'MAIN');
        for (const action of ['evaluate', 'screenshot', 'input_type', 'debugger_send', 'console_get']) {
            let executed = 0;
            handler.actions.set(action, async () => {
                executed++;
                return { success: true };
            });
            assert.deepEqual(await handler.execute(action, { tabId: tab.id }, context), { success: true });
            assert.equal(executed, 1, action);
        }
        const released = await handler.execute('tabs_release', { tabId: tab.id }, context);
        assert.equal(released.managedAfter, false);
        assert.equal(tab.groupId, 77);
        assert.equal(ungrouped, 0);
        for (const action of ['get_text', 'evaluate', 'screenshot', 'input_type', 'debugger_send', 'console_get']) {
            await assert.rejects(() => handler.execute(action, { tabId: tab.id }, context), ExpectedOperationError);
        }
    } finally {
        if (handler?.logManager.sweepTimer) {
            globalThis.clearInterval(handler.logManager.sweepTimer);
        }
        await unmarkManagedTab(tab.id);
        forgetPageRevision(tab.id);
        restore();
    }
});

test('C4 group membership alone never grants managed authority', async () => {
    const tab = { id: 2902, groupId: 77, windowId: 5 };
    const restore = installGlobals({ chrome: { storage: createStorage() } });
    try {
        await unmarkManagedTab(tab.id);
        assert.equal(isManagedTab(tab), false);
        await markManagedTab(tab.id);
        assert.equal(isManagedTab(tab), true);
        await unmarkManagedTab(tab.id);
        assert.equal(isManagedTab(tab), false);
    } finally {
        await unmarkManagedTab(tab.id);
        restore();
    }
});

test('C4 managed state changes persist atomically and serialize across tabs', async () => {
    const storage = createStorage();
    const write = storage.local.set;
    const gate = createDeferred();
    let fail = true;
    let blocked = false;
    const restore = installGlobals({
        chrome: { storage, webNavigation: { getFrame: async ({ tabId }) => ({ documentId: `document-${tabId}` }) } },
    });
    storage.local.set = async (values) => {
        if (fail) {
            throw new Error('storage unavailable');
        }
        if (blocked) {
            await gate.promise;
        }
        await write(values);
    };
    try {
        await assert.rejects(() => markManagedTab(2903), /storage unavailable/);
        assert.equal(isManagedTab({ id: 2903 }), false);
        fail = false;
        blocked = true;
        const first = markManagedTab(2903);
        const second = markManagedTab(2904);
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
        assert.equal(isManagedTab({ id: 2903 }), false);
        gate.resolve();
        await Promise.all([first, second]);
        assert.equal(isManagedTab({ id: 2903 }), true);
        assert.equal(isManagedTab({ id: 2904 }), true);
        assert.deepEqual(storage.values.mcp_managed_tabs_v1.tabs.map((tab) => tab.tabId).sort(), [2903, 2904]);
        fail = true;
        await assert.rejects(() => unmarkManagedTab(2903), /storage unavailable/);
        assert.equal(isManagedTab({ id: 2903 }), true);
    } finally {
        fail = false;
        gate.resolve();
        await unmarkManagedTab(2903);
        await unmarkManagedTab(2904);
        restore();
    }
});

test('C4 release waits for in-flight reads and detaches the debugger before revoking access', async () => {
    const tab = { id: 2905, url: 'https://example.com/managed', groupId: 77 };
    const read = createDeferred();
    let reading = false;
    let detachCalls = 0;
    let handler;
    const restore = installGlobals({
        chrome: {
            tabs: { get: async () => tab },
            storage: createStorage(),
            scripting: { executeScript: async () => [{ result: [] }] },
            debugger: {
                onDetach: chromeEvent(),
                onEvent: chromeEvent(),
                async attach() {},
                async detach() {
                    detachCalls++;
                },
            },
        },
    });
    try {
        await markManagedTab(tab.id);
        handler = new ActionHandler();
        await handler.debuggerManager.ensureAttached(tab.id);
        handler.logManager.setConsole(tab.id, [{ text: 'managed log' }]);
        handler.actions.set('get_text', async () => {
            reading = true;
            return read.promise;
        });
        const pendingRead = handler.execute('get_text', { tabId: tab.id }, createActionContext());
        await waitUntil(() => reading);
        const release = handler.execute('tabs_release', { tabId: tab.id }, createActionContext());
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
        assert.equal(detachCalls, 0);
        assert.equal(isManagedTab(tab), true);
        read.resolve({ text: 'read before release' });
        await pendingRead;
        await release;
        assert.equal(detachCalls, 1);
        assert.equal(isManagedTab(tab), false);
        assert.equal(handler.debuggerManager.isAttached(tab.id), false);
        assert.deepEqual(handler.logManager.getConsole(tab.id), []);
        await assert.rejects(() => handler.execute('evaluate', { tabId: tab.id, code: '1' }, {}), /非托管/);
    } finally {
        read.resolve({ text: '' });
        if (handler?.logManager.sweepTimer) {
            globalThis.clearInterval(handler.logManager.sweepTimer);
        }
        await unmarkManagedTab(tab.id);
        forgetPageRevision(tab.id);
        restore();
    }
});

test(
    'C4 cleanup failures do not prevent revocation and repeated release does ' + 'not inject into unmanaged pages',
    async () => {
        const tab = { id: 2906, url: 'https://example.com/managed', groupId: 77 };
        let injections = 0;
        let handler;
        const restore = installGlobals({
            chrome: {
                tabs: { get: async () => tab },
                storage: createStorage(),
                scripting: {
                    async executeScript() {
                        injections++;
                        throw new Error('cleanup injection refused');
                    },
                },
                debugger: {
                    onDetach: chromeEvent(),
                    onEvent: chromeEvent(),
                    async attach() {},
                    async detach() {
                        throw new Error('detach refused');
                    },
                },
            },
        });
        try {
            await markManagedTab(tab.id);
            handler = new ActionHandler();
            await handler.debuggerManager.ensureAttached(tab.id);
            const released = await handler.execute('tabs_release', { tabId: tab.id }, createActionContext());
            assert.equal(released.managedAfter, false);
            assert.equal(isManagedTab(tab), false);
            assert.equal(handler.debuggerManager.isAttached(tab.id), false);
            assert.equal(released.warnings.length, 2);
            assert.match(released.warnings[0], /detach refused/);
            assert.equal(injections, 1);
            const again = await handler.execute('tabs_release', { tabId: tab.id }, createActionContext());
            assert.equal(again.managedBefore, false);
            assert.equal(again.warnings, undefined);
            assert.equal(injections, 1);
            assert.equal(tab.groupId, 77);
        } finally {
            if (handler?.logManager.sweepTimer) {
                globalThis.clearInterval(handler.logManager.sweepTimer);
            }
            await unmarkManagedTab(tab.id);
            forgetPageRevision(tab.id);
            restore();
        }
    }
);

test('C4 tab IDs from an earlier browser session do not restore managed authority', async () => {
    const staleId = 1902;
    const currentId = 1903;
    const legacy = { mcp_managed_tab_ids: [staleId], mcp_created_tab_ids: [staleId] };
    const storage = createStorage(legacy);
    storage.sessionValues.mcp_managed_tab_ids = [currentId];
    storage.sessionValues.mcp_created_tab_ids = [currentId];
    const state = await isolatedManagedTabs({
        storage,
        tabs: { query: async () => [{ id: currentId }, { id: staleId }] },
        webNavigation: { getFrame: async ({ tabId }) => ({ documentId: `document-${tabId}` }) },
    });
    await state.restoreManagedTabs();
    assert.equal(state.isManagedTab({ id: staleId }), false);
    assert.equal(state.isManagedTab({ id: currentId }), true);
    assert.equal(storage.sessionValues.mcp_managed_tab_ids, undefined);
    await state.markManagedTab(staleId);
    assert.equal(state.isManagedTab({ id: staleId }), true);
    assert.deepEqual(
        Array.from(storage.values.mcp_managed_tabs_v1.tabs, (tab) => tab.tabId).sort(),
        [staleId, currentId].sort()
    );
    assert.deepEqual(storage.values.mcp_created_tab_ids, [staleId]);
    assert.deepEqual(storage.sessionValues.mcp_created_tab_ids, [currentId]);
});

test('C7 frame resolution classifies selectors and returns bounded filtered identity metadata', async () => {
    const tab = { id: 1987, url: 'https://example.com/owned' };
    let selectionStatus = 'not-found';
    let identityUrl = 'https://user:password@example.com/frame?authorization=fixture-secret#fragment';
    const restore = installGlobals({
        chrome: {
            tabs: { get: async () => tab },
            storage: createStorage(),
            scripting: {
                executeScript: frameSnapshotFixture(async ({ args, func }) => {
                    if (func.name === 'installFrameProbeListener') {
                        return [];
                    }
                    recordDomFrameProbe({ token: args[0], index: 0 }, { tab, frameId: 3 });
                    return [
                        {
                            result: {
                                parent: { title: 'owned' },
                                selectedIndex: selectionStatus === 'found' ? 0 : null,
                                selectionStatus,
                                frames: [
                                    { index: 0, acknowledged: true, url: identityUrl, contentOffset: { x: 10, y: 20 } },
                                ],
                            },
                        },
                    ];
                }),
            },
            webNavigation: {
                getAllFrames: async () => [
                    { frameId: 0, parentFrameId: -1, documentId: 'parent-document', url: tab.url },
                    {
                        frameId: 3,
                        parentFrameId: 0,
                        documentId: 'document-3',
                        parentDocumentId: 'parent-document',
                        url: identityUrl,
                    },
                ],
            },
        },
    });
    try {
        await markManagedTab(tab.id);
        const resolver = new FrameResolver({});
        for (const [status, code] of [
            ['not-found', 'FRAME_NOT_FOUND'],
            ['out-of-range', 'FRAME_NOT_FOUND'],
            ['invalid-selector', 'INVALID_FRAME_SELECTOR'],
            ['not-frame', 'FRAME_NOT_IFRAME'],
        ]) {
            selectionStatus = status;
            await assert.rejects(
                () => resolver.resolveFrame({ tabId: tab.id, frame: '#owned' }, createActionContext()),
                (error) => {
                    const body = JSON.parse(error.message).error;
                    assert.equal(body.code, code);
                    assert.equal(body.context.phase, 'frame_resolution');
                    assert.equal(body.context.selectionStatus, status);
                    return true;
                }
            );
        }
        selectionStatus = 'found';
        const resolved = await resolver.resolveFrame({ tabId: tab.id, frame: '#owned' }, createActionContext());
        assert.equal(resolved.frameId, 3);
        assert.deepEqual(resolved.offset, { x: 10, y: 20 });
        assert.deepEqual(resolved.frameContext, {
            tabId: tab.id,
            extensionFrameId: 3,
            parentFrameId: 0,
            documentId: 'document-3',
            domIndex: 0,
            url: 'https://example.com/frame',
            urlStatus: 'filtered',
            path: [
                {
                    selection: '#owned',
                    domIndex: 0,
                    extensionFrameId: 3,
                    parentFrameId: 0,
                    documentId: 'document-3',
                    url: 'https://example.com/frame',
                    urlStatus: 'filtered',
                },
            ],
        });
        globalThis.chrome.debugger = {
            sendCommand: async (_, method) => {
                if (method === 'Page.getFrameTree') {
                    return {
                        frameTree: {
                            frame: { id: 'root', url: tab.url },
                            childFrames: [
                                { frame: { id: 'cdp-3', url: identityUrl.split('#')[0], urlFragment: '#fragment' } },
                            ],
                        },
                    };
                }
                assert.equal(method, 'Runtime.evaluate');
                return { result: { value: 'owned-frame' } };
            },
        };
        installOwnerProbeFixture(globalThis.chrome, tab, 3, () => 'document-3');
        const precise = new FrameResolver({
            ensureAttached: async () => {},
            getFrameSessions: async () => [{ tabId: tab.id }],
            getExecutionContexts: () => [{ frameId: 'cdp-3', id: 3, isDefault: true }],
        });
        const evaluated = await precise.evaluateInFrame(
            { tabId: tab.id, frameId: 3, expression: "'owned-frame'" },
            createActionContext()
        );
        assert.equal(evaluated.frameContext.url, 'https://example.com/frame');
        assert.equal(evaluated.frameContext.originalUrl, 'https://example.com/frame');
        assert.equal(evaluated.frameContext.urlStatus, 'filtered');
        assert.equal(JSON.stringify(evaluated).includes('fixture-secret'), false);
        for (const unmatchedUrl of [
            identityUrl + '&unmatched',
            identityUrl.replace('fixture-secret', 'other-fixture'),
        ]) {
            await assert.rejects(
                () => precise.resolveCdpFrame(tab.id, { frameId: 3, parentFrameId: 0, url: unmatchedUrl }),
                (error) => {
                    const body = JSON.parse(error.message).error;
                    assert.equal(body.code, 'FRAME_CDP_UNAVAILABLE');
                    assert.equal(body.context.url, 'https://example.com/frame');
                    assert.equal(body.context.urlStatus, 'filtered');
                    return true;
                }
            );
        }
        for (const [value, expectedUrl, expectedStatus] of [
            ['data:text/html,private-fixture', 'data:', 'filtered'],
            ['javascript:privateFixture()', 'javascript:', 'filtered'],
            ['not a valid URL', null, 'unavailable'],
            [
                'https://example.com/' + 'x'.repeat(600),
                ('https://example.com/' + 'x'.repeat(600)).slice(0, 500),
                'filtered',
            ],
        ]) {
            identityUrl = value;
            const { frameContext } = await resolver.resolveFrame({ tabId: tab.id, frame: 0 }, createActionContext());
            assert.equal(frameContext.url, expectedUrl);
            assert.equal(frameContext.urlStatus, expectedStatus);
        }
    } finally {
        await unmarkManagedTab(tab.id);
        restore();
    }
});

test('CE-N01 precise iframe selection proves the live owner after same-count DOM reordering', async () => {
    const tab = { id: 1989, url: 'https://example.com/owned' };
    let missingNativeIdentity = false;
    let ambiguousProbe = false;
    let documentReplaced = false;
    const evaluations = [];
    const evaluationTimeouts = [];
    const probeResults = new Map();
    const restore = installGlobals({
        chrome: {
            tabs: { get: async () => tab },
            storage: createStorage(),
            scripting: {
                executeScript: frameSnapshotFixture(async ({ args, func }) => {
                    if (func.name === 'installFrameProbeListener') {
                        return [];
                    }
                    recordDomFrameProbe({ token: args[0], index: 0 }, { tab, frameId: 8 });
                    recordDomFrameProbe({ token: args[0], index: 1 }, { tab, frameId: 3 });
                    if (ambiguousProbe) {
                        recordDomFrameProbe({ token: args[0], index: 1 }, { tab, frameId: 7 });
                    }
                    return [
                        {
                            result: {
                                parent: { title: 'owned' },
                                selectedIndex: args[1] === '#owned' ? 1 : typeof args[1] === 'number' ? args[1] : null,
                                selectionStatus: args[1] == null ? 'not-requested' : 'found',
                                frames: [0, 1].map((index) => ({
                                    index,
                                    acknowledged: true,
                                    url: 'about:srcdoc',
                                    contentOffset: { x: 10, y: 20 },
                                })),
                            },
                        },
                    ];
                }),
            },
            webNavigation: {
                getAllFrames: async () => [
                    { frameId: 0, parentFrameId: -1, documentId: 'parent-document', url: tab.url },
                    {
                        frameId: 3,
                        parentFrameId: 0,
                        documentId: documentReplaced ? 'replacement-document' : 'selected-document',
                        parentDocumentId: 'parent-document',
                        url: 'about:srcdoc',
                    },
                    {
                        frameId: 8,
                        parentFrameId: 0,
                        documentId: 'other-document',
                        parentDocumentId: 'parent-document',
                        url: 'about:srcdoc',
                    },
                ],
            },
            debugger: {
                async sendCommand(_, method, params) {
                    if (method === 'Page.getFrameTree') {
                        return {
                            frameTree: {
                                frame: { id: 'root', url: tab.url },
                                childFrames: ['cdp-8', 'cdp-3'].map((id) => ({ frame: { id, url: 'about:srcdoc' } })),
                            },
                        };
                    }
                    if (method === 'DOM.getFrameOwner') {
                        return { backendNodeId: params.frameId === 'cdp-3' ? 102 : 101 };
                    }
                    if (method === 'DOM.getDocument') {
                        return { root: { nodeId: 100 } };
                    }
                    if (method === 'DOM.querySelectorAll') {
                        return { nodeIds: [102, 101] };
                    }
                    if (method === 'DOM.describeNode') {
                        return { node: { frameId: params.nodeId === 102 ? 'cdp-3' : 'cdp-8' } };
                    }
                    if (method === 'DOM.resolveNode') {
                        return {
                            object: { objectId: missingNativeIdentity ? undefined : String(params.backendNodeId) },
                        };
                    }
                    if (method === 'Runtime.callFunctionOn') {
                        if (params.objectId.startsWith('probe-')) {
                            return {};
                        }
                        const selected = params.objectId === '102';
                        const { accepted } = recordDomFrameProbe(
                            { token: params.arguments[0].value, index: 0 },
                            {
                                tab,
                                frameId: selected ? 3 : 8,
                                documentId: selected ? 'selected-document' : 'other-document',
                            }
                        );
                        const objectId = 'probe-' + params.objectId;
                        probeResults.set(objectId, accepted);
                        return { result: { objectId } };
                    }
                    if (method === 'Runtime.awaitPromise') {
                        return { result: { value: probeResults.get(params.promiseObjectId) } };
                    }
                    if (method === 'Runtime.releaseObject') {
                        probeResults.delete(params.objectId);
                        return {};
                    }
                    assert.equal(method, 'Runtime.evaluate');
                    evaluations.push(params.contextId);
                    evaluationTimeouts.push(params.timeout);
                    return { result: { value: params.contextId === 3 ? 'Frame Button' : 'Other Frame' } };
                },
            },
        },
    });
    try {
        await markManagedTab(tab.id);
        const resolver = new FrameResolver({
            ensureAttached: async () => {},
            getFrameSessions: async () => [{ tabId: tab.id }],
            getExecutionContexts: () => [
                { frameId: 'cdp-3', id: 3, isDefault: true },
                { frameId: 'cdp-8', id: 8, isDefault: true },
            ],
        });
        for (const selection of ['#owned', 1, 0]) {
            const selected = await resolver.resolveFrame({ tabId: tab.id, frame: selection }, createActionContext());
            const result = await resolver.evaluateInFrame(
                { tabId: tab.id, frameId: selected.frameId, expression: 'document.body.textContent' },
                createActionContext()
            );
            assert.equal(result.result.value, selection === 0 ? 'Other Frame' : 'Frame Button');
            assert.equal(result.frameContext.cdpFrameId, selection === 0 ? 'cdp-8' : 'cdp-3');
            assert.equal(result.retryAttempted, false);
        }
        assert.deepEqual(evaluations, [3, 3, 8]);
        documentReplaced = true;
        await assert.rejects(
            () =>
                resolver.evaluateInFrame(
                    { tabId: tab.id, frameId: 3, expression: '++window.sideEffect' },
                    createActionContext()
                ),
            (error) => JSON.parse(error.message).error.code === 'FRAME_AMBIGUOUS'
        );
        documentReplaced = false;
        missingNativeIdentity = true;
        await assert.rejects(
            () =>
                resolver.evaluateInFrame(
                    { tabId: tab.id, frameId: 3, expression: '++window.sideEffect' },
                    createActionContext()
                ),
            (error) => JSON.parse(error.message).error.code === 'FRAME_AMBIGUOUS'
        );
        ambiguousProbe = true;
        await assert.rejects(
            () => resolver.resolveFrame({ tabId: tab.id, frame: '#owned' }, createActionContext()),
            (error) => JSON.parse(error.message).error.code === 'FRAME_IDENTITY_UNAVAILABLE'
        );
        assert.deepEqual(evaluations, [3, 3, 8]);
        ambiguousProbe = false;
        missingNativeIdentity = false;
        for (const [requestBudget, scriptBudget] of [
            [false, false],
            [false, true],
            [true, false],
            [true, true],
        ]) {
            await resolver.evaluateInFrame(
                {
                    tabId: tab.id,
                    frameId: 3,
                    expression: 'document.body.textContent',
                    timeout: scriptBudget ? 1000 : undefined,
                },
                createActionContext({ deadline: requestBudget ? Date.now() + 2000 : undefined })
            );
            const timeout = evaluationTimeouts.at(-1);
            if (!requestBudget && !scriptBudget) {
                assert.equal(timeout, undefined);
            } else {
                assert.ok(Number.isFinite(timeout));
                assert.ok(timeout > 0 && timeout <= (scriptBudget ? 1000 : 2000));
            }
        }
    } finally {
        await unmarkManagedTab(tab.id);
        restore();
    }
});

test('C7 readOnly stale recovery waits for document resolution without adding script replays', async (t) => {
    for (const scenario of ['readOnly', 'never', 'permission', 'timeout', 'page-exception']) {
        await t.test(scenario, async () => {
            const tab = { id: 1991, url: 'https://example.com/owned' };
            let resolutions = 0;
            let executions = 0;
            let documentId = 'old-document';
            const restore = installGlobals({
                chrome: {
                    storage: createStorage(),
                    tabs: { get: async () => tab },
                    webNavigation: {
                        getAllFrames: async () => [{ frameId: 3, parentFrameId: 0, documentId, url: 'about:srcdoc' }],
                    },
                    debugger: {
                        async sendCommand(_, method) {
                            if (method === 'Runtime.enable') {
                                return {};
                            }
                            assert.equal(method, 'Runtime.evaluate');
                            ++executions;
                            if (scenario === 'page-exception') {
                                return { exceptionDetails: { text: 'Execution context was destroyed.' } };
                            }
                            if (executions === 1) {
                                throw new Error('Execution context was destroyed.');
                            }
                            return { result: { value: 'Frame Button' } };
                        },
                    },
                },
            });
            try {
                await markManagedTab(tab.id);
                const resolver = new FrameResolver({
                    ensureAttached: async () => {},
                    getExecutionContexts: () => [
                        { frameId: 'cdp-3', id: documentId === 'old-document' ? 3 : 4, isDefault: true },
                    ],
                    invalidateExecutionContext: () => {},
                });
                installOwnerProbeFixture(globalThis.chrome, tab, 3, () => documentId);
                resolver.resolveCdpFrame = async () => {
                    ++resolutions;
                    if (resolutions > 1 && scenario === 'permission') {
                        throw new Error('Cannot access a chrome:// URL');
                    }
                    if (resolutions === 2 || (resolutions > 2 && scenario === 'timeout')) {
                        const staleId = documentId;
                        documentId = 'new-document';
                        throw new Error(`No document with id ${staleId} in tab with id ${tab.id}`);
                    }
                    return { cdpFrameId: 'cdp-3' };
                };
                const operation = () =>
                    resolver.evaluateInFrame(
                        {
                            tabId: tab.id,
                            frameId: 3,
                            expression: 'document.body.textContent',
                            staleContextRetry: scenario === 'never' ? 'never' : 'readOnly',
                            timeout: scenario === 'timeout' ? 60 : 1000,
                        },
                        createActionContext()
                    );
                if (scenario === 'never') {
                    await assert.rejects(
                        operation,
                        (error) => JSON.parse(error.message).error.code === 'FRAME_STALE_CONTEXT'
                    );
                    assert.equal(resolutions, 1);
                    assert.equal(executions, 1);
                } else if (scenario === 'permission' || scenario === 'timeout') {
                    await assert.rejects(operation, (error) => {
                        const detail = JSON.parse(error.message).error;
                        assert.equal(detail.code, 'FRAME_EVALUATION_FAILED');
                        assert.equal(detail.context.retryAttempted, true);
                        if (scenario === 'permission') {
                            assert.match(detail.message, /Cannot access/);
                        }
                        return true;
                    });
                    assert.equal(executions, 1);
                    if (scenario === 'permission') {
                        assert.equal(resolutions, 2);
                    }
                } else {
                    const result = await operation();
                    if (scenario === 'page-exception') {
                        assert.equal(result.retryAttempted, false);
                        assert.equal(executions, 1);
                        assert.equal(resolutions, 1);
                    } else {
                        assert.equal(result.result.value, 'Frame Button');
                        assert.equal(result.retryAttempted, true);
                        assert.equal(result.frameContext.documentId, 'new-document');
                        assert.equal(result.frameContext.executionContextId, 4);
                        assert.equal(executions, 2);
                        assert.equal(resolutions, 3);
                    }
                }
            } finally {
                await unmarkManagedTab(tab.id);
                restore();
            }
        });
    }
});

test(
    'C7 retained iframe probes initialize document-bound listeners without ' +
        'duplication or cross-document injection',
    async () => {
        const tab = { id: 1990, url: 'https://example.com/owned' };
        const frames = [
            { frameId: 0, parentFrameId: -1, documentId: 'parent-document', url: tab.url },
            {
                frameId: 3,
                parentFrameId: 0,
                documentId: 'child-document',
                parentDocumentId: 'parent-document',
                url: 'about:srcdoc',
            },
            {
                frameId: 4,
                parentFrameId: 0,
                documentId: 'foreign-child',
                parentDocumentId: 'foreign-parent',
                url: tab.url,
            },
            {
                frameId: 5,
                parentFrameId: 3,
                documentId: 'nested-child',
                parentDocumentId: 'child-document',
                url: tab.url,
            },
            {
                frameId: 6,
                parentFrameId: 0,
                documentId: 'extension-child',
                parentDocumentId: 'parent-document',
                url: 'chrome-extension://other/frame.html',
            },
        ];
        let initialized = false;
        let installer;
        let initializationFailure = false;
        let initializationCalls = 0;
        let parentCalls = 0;
        let lastToken;
        const restore = installGlobals({
            chrome: {
                webNavigation: { getAllFrames: async () => frames },
                scripting: {
                    executeScript: frameSnapshotFixture(async ({ target, func, args }) => {
                        if (func.name === 'installFrameProbeListener') {
                            ++initializationCalls;
                            assert.deepEqual(target, { tabId: tab.id, documentIds: ['child-document'] });
                            if (initializationFailure) {
                                throw new Error('initialization denied fixture');
                            }
                            installer = func;
                            initialized = true;
                            return [{ frameId: 3, documentId: 'child-document' }];
                        }
                        ++parentCalls;
                        lastToken = args[0];
                        if (initialized) {
                            recordDomFrameProbe({ token: lastToken, index: 0 }, { tab, frameId: 3 });
                        }
                        return [
                            {
                                result: {
                                    parent: { title: 'owned' },
                                    selectedIndex: 0,
                                    selectionStatus: 'found',
                                    frames: [
                                        {
                                            index: 0,
                                            acknowledged: initialized,
                                            url: 'about:srcdoc',
                                            contentOffset: { x: 10, y: 20 },
                                        },
                                    ],
                                },
                            },
                        ];
                    }),
                },
            },
        });
        try {
            for (let attempt = 0; attempt < 2; ++attempt) {
                const result = await getDomFrameSnapshot(tab.id, 0, '#owned', 'parent-document', tab.url);
                assert.equal(result.frames[0].frameId, 3);
                assert.deepEqual(result.frames[0].candidateFrameIds, [3]);
            }
            assert.equal(initializationCalls, 2);
            assert.equal(recordDomFrameProbe({ token: lastToken, index: 0 }, { tab, frameId: 3 }).accepted, false);

            const acknowledgements = [];
            const messages = [];
            const warnings = [];
            let listener;
            let listenerCount = 0;
            let accepted = true;
            let messageFailure = false;
            const parent = { postMessage: (message) => acknowledgements.push(message) };
            const window = {
                parent,
                addEventListener: (type, callback) => {
                    assert.equal(type, 'message');
                    ++listenerCount;
                    listener = callback;
                },
            };
            const sandbox = vm.createContext({
                window,
                console: { warn: (...args) => warnings.push(args) },
                chrome: {
                    runtime: {
                        sendMessage: async (message) => {
                            messages.push(message);
                            if (messageFailure) {
                                throw new Error('message rejected fixture');
                            }
                            return { accepted };
                        },
                    },
                },
            });
            for (let attempt = 0; attempt < 2; ++attempt) {
                vm.runInContext(`(${installer.toString()})()`, sandbox);
            }
            assert.equal(listenerCount, 1);
            const data = { type: 'mcp-frame-probe-v2', token: 'fixture-nonce', index: 0 };
            for (const event of [
                { source: {}, data },
                { source: parent, data: null },
                ...[{ type: 'other' }, { token: 42 }, { token: 'x'.repeat(101) }, { index: -1 }, { index: 0.5 }].map(
                    (changes) => ({ source: parent, data: { ...data, ...changes } })
                ),
            ]) {
                listener(event);
            }
            assert.equal(messages.length, 0);
            listener({ source: parent, data });
            await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
            assert.equal(messages.length, 1);
            assert.equal(messages[0].type, 'MCP_FRAME_PROBE');
            assert.equal(acknowledgements.length, 1);
            assert.equal(acknowledgements[0].token, data.token);
            assert.equal(acknowledgements[0].index, data.index);
            accepted = false;
            listener({ source: parent, data });
            await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
            assert.equal(acknowledgements.length, 1);
            messageFailure = true;
            listener({ source: parent, data });
            await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
            assert.equal(warnings.length, 1);
            assert.match(warnings[0][1], /message rejected fixture/);
            assert.equal(acknowledgements.length, 1);

            frames[0].documentId = 'changed-parent';
            await assert.rejects(
                () => getDomFrameSnapshot(tab.id, 0, '#owned', 'parent-document', tab.url),
                /页面已变化/
            );
            assert.equal(initializationCalls, 2);
            assert.equal(parentCalls, 2);
            frames[0].documentId = 'parent-document';
            frames[1].documentId = undefined;
            const missingDocument = await getDomFrameSnapshot(tab.id, 0, '#owned');
            assert.equal(missingDocument.frames[0].frameId, null);
            assert.match(missingDocument.unavailableFrames[0].error, /documentId/);
            assert.equal(initializationCalls, 2);
            assert.equal(parentCalls, 3);
            frames[1].documentId = 'child-document';
            initializationFailure = true;
            const unavailableDocument = await getDomFrameSnapshot(tab.id, 0, '#owned');
            assert.equal(unavailableDocument.frames[0].frameId, null);
            assert.match(unavailableDocument.unavailableFrames[0].error, /initialization denied fixture/);
            assert.equal(initializationCalls, 3);
            assert.equal(parentCalls, 4);
        } finally {
            restore();
        }
    }
);

test(
    'C7 readable injections distinguish absent results, selectors, context loss ' +
        'and denied injection without replay',
    async () => {
        const tab = { id: 1988, url: 'https://example.com/owned' };
        let result = [];
        let thrown;
        let executions = 0;
        const restore = installGlobals({
            chrome: {
                tabs: { get: async () => tab },
                storage: createStorage(),
                scripting: {
                    executeScript: async () => {
                        executions++;
                        if (thrown) {
                            throw thrown;
                        }
                        return result;
                    },
                },
            },
        });
        try {
            await markManagedTab(tab.id);
            const handler = new ContentHandler({
                ensureAttached: () => assert.fail('ordinary reads must not attach debugger'),
            });
            for (const method of [
                'readPage',
                'find',
                'getText',
                'getHtml',
                'getHtmlWithImages',
                'getAttribute',
                'getMetadata',
            ]) {
                for (const empty of [[], [{ result: null }], [{ result: undefined }]]) {
                    result = empty;
                    const before = executions;
                    await assert.rejects(
                        () => handler[method]({ tabId: tab.id, frameId: 3, attribute: 'href' }, {}),
                        (error) => {
                            const body = JSON.parse(error.message).error;
                            assert.equal(body.code, 'FRAME_SCRIPT_NO_RESULT');
                            assert.deepEqual(body.context, {
                                tabId: tab.id,
                                frameId: 3,
                                phase: 'script_result',
                                resultCount: empty.length,
                            });
                            return true;
                        }
                    );
                    assert.equal(executions, before + 1);
                }
            }
            for (const [message, code] of [
                ['Invalid CSS selector: fixture', 'INVALID_SELECTOR'],
                ['Cannot find context with specified id', 'FRAME_STALE_CONTEXT'],
                ['Frame 3 not found', 'FRAME_NOT_FOUND'],
                ['Cannot access a chrome:// URL', 'FRAME_INJECTION_DENIED'],
                ['unexpected fixture error', 'FRAME_INJECTION_FAILED'],
            ]) {
                thrown = new Error(message);
                const before = executions;
                await assert.rejects(
                    () => handler.getText({ tabId: tab.id, frameId: 3 }, createActionContext()),
                    (error) => {
                        const body = JSON.parse(error.message).error;
                        assert.equal(body.code, code);
                        assert.equal(body.message, message);
                        assert.equal(body.context.phase, 'injection');
                        assert.equal(body.context.frameId, 3);
                        if (code === 'FRAME_INJECTION_FAILED') {
                            assert.equal(error.cause, thrown);
                        }
                        return true;
                    }
                );
                assert.equal(executions, before + 1);
            }
            thrown = undefined;
            result = [{ result: { error: 'Invalid XPath: fixture' } }];
            await assert.rejects(
                () => handler.find({ tabId: tab.id, frameId: 3 }, createActionContext()),
                (error) => JSON.parse(error.message).error.code === 'INVALID_SELECTOR'
            );
            result = [{ result: [] }];
            assert.deepEqual(await handler.find({ tabId: tab.id, frameId: 3 }, createActionContext()), []);
            result = [{ result: { text: '' } }];
            assert.deepEqual(await handler.getText({ tabId: tab.id, frameId: 3 }, createActionContext()), { text: '' });
            result = [{ result: null }];
            assert.equal(
                await handler.getComputedStyleAction(
                    { tabId: tab.id, refId: 'ref_1', prop: 'color' },
                    createActionContext()
                ),
                null
            );
            result = [{ result: undefined }];
            assert.equal(await handler.injectScript(tab.id, 3, () => undefined, []), undefined);
        } finally {
            await unmarkManagedTab(tab.id);
            restore();
        }
    }
);

test('C4 created-page injection arguments survive Chrome JSON serialization', async (t) => {
    const tab = { id: 1904, url: 'https://example.com/created' };
    let result;
    let argumentsSeen;
    const restore = installGlobals({
        chrome: {
            tabs: { get: async () => tab },
            storage: createStorage(),
            scripting: {
                executeScript: frameSnapshotFixture(async ({ args }) => {
                    assert.deepEqual(JSON.parse(JSON.stringify(args)), args, 'Chrome rejects unserializable args');
                    argumentsSeen = args;
                    return [{ result }];
                }),
            },
        },
    });
    try {
        await markManagedTab(tab.id);
        const content = new ContentHandler({});
        for (const [method, params, expectedArgs, expectedResult] of [
            ['readPage', {}, ['all', 15, null, null, null], { pageContent: 'fixture' }],
            ['find', {}, [null, null, null, null, null, null, null], []],
            ['find', { matchIndex: 0 }, [null, null, null, null, null, 0, null], []],
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
            globalThis.chrome.webNavigation = {
                getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'document-a', url: tab.url }],
            };
            result = {
                parent: { title: 'fixture' },
                frames: [],
                selectedIndex: null,
                selectionStatus: 'not-requested',
            };
            for (const selection of [undefined, 0, '#test-frame']) {
                assert.deepEqual(await getDomFrameSnapshot(tab.id, 0, selection), result);
                assert.deepEqual(argumentsSeen.slice(1), [selection ?? null]);
            }
            assert.deepEqual(await getDomFrameSnapshot(tab.id, 0, 0, 'document-a', tab.url), result);
            assert.deepEqual(argumentsSeen.slice(1), [0, tab.url]);
        });
    } finally {
        await unmarkManagedTab(tab.id);
        restore();
    }
});

test('C20 accessibility state never reads hidden/password/file values and retains metadata and ordinary values', () => {
    for (const type of ['hidden', 'password', 'file', 'text', 'submit']) {
        for (const nameSource of ['', 'aria-label', 'placeholder', 'title', 'label']) {
            const scenario = `${type}-${nameSource || 'value'}`;
            const value = type === 'submit' ? 'owned-submit-label-'.repeat(4) : 'owned-value-sentinel';
            const sensitive = ['hidden', 'password', 'file'].includes(type);
            let valueReads = 0;
            const input = {
                tagName: 'INPUT',
                nodeType: 1,
                getRootNode: () => globalThis.document,
                hasAttribute(name) {
                    return this.getAttribute(name) !== null;
                },
                labels:
                    nameSource === 'label'
                        ? [
                              {
                                  nodeType: 1,
                                  tagName: 'LABEL',
                                  childNodes: [{ nodeType: 3, textContent: 'Owned input name' }],
                                  getRootNode: () => globalThis.document,
                                  hasAttribute: () => false,
                                  getAttribute: () => null,
                              },
                          ]
                        : [],
                id: 'owned-input',
                type,
                offsetWidth: type === 'hidden' ? 0 : 120,
                offsetHeight: type === 'hidden' ? 0 : 20,
                childNodes: [],
                children: [],
                getAttribute(name) {
                    if (name === 'type') {
                        return this.type;
                    }
                    return name === nameSource ? 'Owned input name' : null;
                },
                get value() {
                    ++valueReads;
                    if (sensitive) {
                        throw new Error(`${type} value must not be read`);
                    }
                    return value;
                },
                getBoundingClientRect: () => ({
                    x: 10,
                    y: 10,
                    top: 10,
                    left: 10,
                    right: 130,
                    bottom: 30,
                    width: type === 'hidden' ? 0 : 120,
                    height: type === 'hidden' ? 0 : 20,
                }),
                contains: () => false,
            };
            const restore = installGlobals({
                document: {
                    body: input,
                    querySelector: () => null,
                    elementFromPoint: () => null,
                },
                window: {
                    innerWidth: 800,
                    innerHeight: 600,
                    getComputedStyle: () => ({
                        display: type === 'hidden' ? 'none' : 'block',
                        visibility: 'visible',
                        opacity: '1',
                    }),
                },
                CSS: { escape: (text) => text },
                Node: { TEXT_NODE: 3 },
            });
            try {
                const all = generateAccessibilityTree('all', 15, null, null);
                const valueIsName = type === 'submit' && !['aria-label', 'label'].includes(nameSource);
                const expectedName = valueIsName ? value : nameSource ? 'Owned input name' : '';
                const expectedValue = !sensitive && type !== 'submit' ? value : undefined;
                const includesValue = valueIsName || expectedValue !== undefined;
                assert.equal(all.interactiveElements[0].visible, type !== 'hidden', scenario);
                for (const filter of ['all', 'interactive']) {
                    const state = generateAccessibilityTree(filter, 15, null, null);
                    assert.equal(
                        state.interactiveElements.length,
                        type === 'hidden' && filter !== 'all' ? 0 : 1,
                        scenario
                    );
                    if (state.interactiveElements.length) {
                        assert.equal(state.interactiveElements[0].name, expectedName, scenario);
                        assert.equal(state.interactiveElements[0].value, expectedValue, scenario);
                        assert.equal(state.pageContent.includes(value), includesValue, scenario);
                        assert.equal(
                            state.pageContent.includes(`value=${JSON.stringify(value)}`),
                            expectedValue !== undefined,
                            scenario
                        );
                    }
                    const targeted = generateAccessibilityTree(filter, 15, null, all.interactiveElements[0].refId);
                    const targetedName = type === 'hidden' && filter !== 'all' ? '' : expectedName;
                    assert.equal(targeted.interactiveElements[0].name, targetedName, scenario);
                    assert.equal(targeted.interactiveElements[0].value, expectedValue, scenario);
                    assert.equal(JSON.stringify(targeted).includes(value), includesValue, scenario);
                }
                assert.equal(valueReads > 0, includesValue, scenario);
            } finally {
                restore();
            }
        }
    }
});

test('C-V11 stealth click and mouseup preserve primary, auxiliary and context-menu event semantics', () => {
    const events = [];
    const element = {
        isConnected: true,
        dispatchEvent(event) {
            events.push(event);
            return true;
        },
        focus() {},
        getBoundingClientRect: () => ({ x: 10, y: 20, width: 20, height: 20 }),
    };
    const restore = installGlobals({
        MouseEvent: class {
            constructor(type, options) {
                this.type = type;
                Object.assign(this, options);
            }
        },
        document: { elementFromPoint: () => element },
        window: { screenX: 0, screenY: 0, __mcpElementMap: { ref_owned: new WeakRef(element) } },
    });
    try {
        for (const [button, buttonCode, mask, finalType] of [
            ['left', 0, 1, 'click'],
            ['middle', 1, 4, 'auxclick'],
            ['right', 2, 2, 'contextmenu'],
        ]) {
            for (const count of [1, 2, 3]) {
                for (const refId of [undefined, 'ref_owned']) {
                    events.length = 0;
                    assert.equal(simulateMouseClick(20, 30, button, count, refId).success, true);
                    const expected = [];
                    for (let detail = 1; detail <= count; ++detail) {
                        expected.push(['mousedown', detail, mask], ['mouseup', detail, 0], [finalType, detail, 0]);
                        if (button === 'left' && detail === 2) {
                            expected.push(['dblclick', 2, 0]);
                        }
                    }
                    assert.deepEqual(
                        events.slice(3).map(({ type, detail, buttons }) => [type, detail, buttons]),
                        expected
                    );
                    assert.ok(events.every((event) => event.button === buttonCode));
                }
            }
            events.length = 0;
            simulateMouseEvent('mousedown', 20, 30, button);
            simulateMouseEvent('mouseup', 20, 30, button);
            assert.deepEqual(
                events.map(({ type, buttons }) => [type, buttons]),
                [
                    ['mousedown', mask],
                    ['mouseup', 0],
                    [finalType, 0],
                ]
            );
            assert.ok(events.every((event) => event.button === buttonCode));
        }
    } finally {
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
            [findElements, ['#fixture', null, null]],
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

test('C-P2 selector and ref reads use HTML rendered text and preserve explicit hidden and SVG text', () => {
    class HtmlElement {
        constructor(innerText, textContent) {
            this.innerText = innerText;
            this.textContent = textContent;
            this.isConnected = true;
        }
    }
    const elements = {
        body: new HtmlElement('Rendered 中文😀\nSVG', 'CSS source; script source; hidden text'),
        '#empty': new HtmlElement('', 'must-not-return-source'),
        '#hidden': new HtmlElement('Selected hidden text', 'Selected hidden text'),
        '#svg': { textContent: 'SVG', isConnected: true },
        '#detached': { textContent: 'must-not-return-detached', isConnected: false },
    };
    const refs = Object.fromEntries(
        Object.entries(elements).map(([selector, element]) => [selector, new WeakRef(element)])
    );
    const restore = installGlobals({
        HTMLElement: HtmlElement,
        window: { __mcpElementMap: refs },
        location: { href: 'https://example.com/owned' },
        document: {
            body: elements.body,
            querySelector: (selector) => {
                if (selector === '[') {
                    throw Object.assign(new Error('Invalid selector'), { name: 'SyntaxError' });
                }
                return elements[selector];
            },
        },
    });
    try {
        assert.equal(extractText(null).text, elements.body.innerText);
        for (const [selector, element] of Object.entries(elements)) {
            const expected = element instanceof HtmlElement ? element.innerText : element.textContent;
            assert.equal(extractText(selector).text, expected);
            assert.equal(extractText(null, undefined, selector).text, element.isConnected ? expected : '');
        }
        assert.equal(extractText('#missing').text, '');
        assert.equal(extractText(null, undefined, 'missing').text, '');
        assert.match(extractText('[').error, /Invalid CSS selector/);
        assert.throws(() => extractText('body', 'https://example.com/other'), /页面 URL 已变化/);
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
            this.nodeType = 1;
            this.childNodes = [];
            this.parentElement = null;
        }

        matches(selector) {
            return selector === '.item' || selector === '*';
        }

        getRootNode() {
            return globalThis.document;
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
            nodeType: 9,
            childNodes: elements,
            querySelector: () => elements[0],
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

test('C-R8 read grants revoke closed documents without querying or activating pages', async () => {
    const tabId = 8901;
    const storage = createStorage();
    const calls = [];
    let closed = false;
    const restore = installGlobals({
        chrome: {
            storage,
            tabs: {
                async get(id) {
                    calls.push({ action: 'get', id });
                    if (closed) {
                        throw new Error('document closed');
                    }
                    return { id, url: 'https://example.com/read-only', active: false, groupId: -1 };
                },
            },
            webNavigation: {
                async getFrame(params) {
                    calls.push({ action: 'getFrame', params });
                    return { documentId: 'read-document' };
                },
            },
        },
    });
    try {
        await setReadGrant('read-revoke-server', tabId, true);
        assert.equal(await hasReadGrant('read-revoke-server', tabId), true);
        assert.equal(isManagedTab({ id: tabId, groupId: -1 }), false);
        const reads = calls.length;
        closed = true;
        await setReadGrant('read-revoke-server', tabId, false);
        await setReadGrant('read-revoke-server', tabId, false);
        assert.equal(calls.length, reads);
        const persisted = await storage.session.get(null);
        assert.deepEqual(Object.values(persisted), [[]]);
        closed = false;
        assert.equal(await hasReadGrant('read-revoke-server', tabId), false);
    } finally {
        forgetPageRevision(tabId);
        restore();
    }
});

test('C-R8 read grants never persist an unconfirmed document identity', async () => {
    const tabId = 8902;
    const storage = createStorage();
    const restore = installGlobals({
        chrome: {
            storage,
            tabs: { get: async () => ({ id: tabId, url: 'https://example.com/unconfirmed' }) },
            webNavigation: { getFrame: async () => null },
        },
    });
    try {
        await assert.rejects(() => setReadGrant('unconfirmed-read-server', tabId, true), /未授予只读权限/);
        assert.deepEqual(await storage.session.get(null), {});
        assert.equal(isManagedTab({ id: tabId }), false);
    } finally {
        forgetPageRevision(tabId);
        restore();
    }
});

test('C-R8 native creation rejections are not retried and do not delete unrelated assets', async (t) => {
    for (const operation of ['tabsCreate', 'windowCreate']) {
        await t.test(operation, async () => {
            const fixture = createTabManagementFixture();
            const failure = new Error('native creation refused');
            const native = operation === 'tabsCreate' ? fixture.chrome.tabs : fixture.chrome.windows;
            native.create = async (properties) => {
                fixture.calls.push({ method: 'native.create', properties });
                throw failure;
            };
            const restore = installGlobals({ chrome: fixture.chrome });
            try {
                const handler = new TabHandler({});
                await assert.rejects(
                    () => handler[operation](operation === 'tabsCreate' ? { windowId: 10 } : { focused: false }, {}),
                    (error) => {
                        const body = JSON.parse(error.message).error;
                        assert.match(body.message, /native creation refused/);
                        assert.equal(body.context.actionStatus, 'unknown');
                        assert.equal(body.context.failureStage, 'create');
                        return true;
                    }
                );
                assert.equal(fixture.calls.length, 1);
                assert.equal(fixture.calls[0].method, 'native.create');
                assert.equal(fixture.tabs.size, 3);
            } finally {
                restore();
            }
        });
    }
});

test('C31F9 executeCode separates VM compile policy from page CSP text', async () => {
    const deniedContext = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
    const deniedExecute = vm.runInContext(`(${executeCode.toString()})`, deniedContext);
    const denied = await deniedExecute('globalThis.__businessRan = true');
    assert.equal(denied.success, false);
    assert.equal(denied.errorCode, 'CSP_BLOCKED');
    assert.equal(denied.errorSource, 'context');
    assert.equal(denied.actionExecuted, false);
    assert.match(denied.error, /Code generation from strings disallowed/);
    assert.equal(deniedContext.__businessRan, undefined);
    for (const message of [
        'CSP business failure',
        'Content Security Policy business failure',
        "'unsafe-eval' business failure",
    ]) {
        for (const reject of [false, true]) {
            const expression = reject
                ? `Promise.reject(new Error(${JSON.stringify(message)}))`
                : `(() => { throw new Error(${JSON.stringify(message)}) })()`;
            const result = await executeCode(expression);
            assert.equal(result.success, false);
            assert.equal(result.errorSource, 'page');
            assert.equal(result.error, message);
            assert.equal(result.errorCode, undefined);
        }
    }
});

test('C31F11 executeCode retains empty exceptions and tags trusted output failures', async () => {
    class DomNode {
        nodeName = 'OWNED';
        nodeType = 1;
        parentElement = null;
    }
    const restore = installGlobals({
        Node: DomNode,
        Element: class extends DomNode {},
        NodeList: class {
            length = 0;
        },
        HTMLCollection: class {
            length = 0;
        },
    });
    try {
        for (const expression of [
            '(() => { throw "" })()',
            'Promise.reject("")',
            '(() => { throw new Error("") })()',
            'Promise.reject(new Error(""))',
        ]) {
            assert.deepEqual(await executeCode(expression), { success: false, error: '', errorSource: 'page' });
        }
        for (const expression of [
            '(() => { const value = {}; value.self = value; return value })()',
            '1n',
            '({ toJSON() { throw new Error("owned serialization failure") } })',
            'new Node()',
            'new NodeList()',
            'new HTMLCollection()',
        ]) {
            const result = await executeCode(expression);
            assert.equal(result.success, false);
            assert.equal(result.errorSource, 'output');
            assert.equal(JSON.parse(result.error).error.code, 'NON_SERIALIZABLE_EVALUATE_RESULT');
        }
    } finally {
        restore();
    }
});

test('C31F12 executeCode keeps result inspection errors in output and Promise adoption errors in page', async () => {
    class DomNode {
        parentElement = null;
        nodeName = 'OWNED';
        nodeType = 1;
    }
    const restore = installGlobals({
        Node: DomNode,
        Element: class extends DomNode {},
        NodeList: class {
            length = 1;
        },
        HTMLCollection: class {
            length = 1;
        },
        __c31f12OutputActions: 0,
    });
    try {
        for (const statement of [
            'return new Proxy({}, {getPrototypeOf(){throw new Error("owned prototype read")}})',
            'const value=new Node();Object.defineProperty(value,"nodeName",{get(){throw new Error("owned nodeName read")}});return value',
            'const value=new Node();Object.defineProperty(value,"parentElement",{get(){throw new Error("owned parentElement read")}});return value',
            'const value=new NodeList();Object.defineProperty(value,"constructor",{get(){throw new Error("owned NodeList constructor read")}});return value',
            'const value=new HTMLCollection();Object.defineProperty(value,"constructor",{get(){throw new Error("owned HTMLCollection constructor read")}});return value',
        ]) {
            globalThis.__c31f12OutputActions = 0;
            const result = await executeCode(`(function(){globalThis.__c31f12OutputActions++;${statement}})()`);
            assert.equal(globalThis.__c31f12OutputActions, 1);
            assert.equal(result.success, false);
            assert.equal(result.errorSource, 'output');
            assert.equal(JSON.parse(result.error).error.code, 'NON_SERIALIZABLE_EVALUATE_RESULT');
            assert.match(JSON.parse(result.error).error.message, /owned/);
        }
        const isolated = vm.runInNewContext(`(${executeCode.toString()})`, {
            Node: DomNode,
            Element: class extends DomNode {},
            NodeList: class {},
            HTMLCollection: class {},
        });
        const summary = await isolated(
            '(function(){JSON.stringify=()=>{throw new Error("owned JSON serializer unavailable")};return 42})()'
        );
        assert.equal(summary.success, false);
        assert.equal(summary.errorSource, 'output');
        assert.equal(summary.errorCode, 'NON_SERIALIZABLE_EVALUATE_RESULT');
        assert.match(summary.error, /输出错误详情生成失败/);
        const adoption = await executeCode(
            '(function(){const pair=Proxy.revocable({},{});pair.revoke();return pair.proxy})()'
        );
        assert.equal(adoption.success, false);
        assert.equal(adoption.errorSource, 'page');
        assert.match(adoption.error, /revoked/);
    } finally {
        restore();
    }
});

test('C31F13 executeCode retains original output diagnostics when summary JSON is invalid', async () => {
    for (const value of ['owned invalid summary JSON', '', '{}', 'null', 0, null]) {
        const isolated = vm.runInNewContext(`(${executeCode.toString()})`, {
            Node: class {},
            Element: class {},
            NodeList: class {},
            HTMLCollection: class {},
        });
        const result = await isolated(
            `(function(){let calls=0;JSON.stringify=()=>{if(++calls===1)throw new Error("OWNED_FIRST_OUTPUT_FAILURE");return ${JSON.stringify(value)}};return 42})()`
        );
        assert.equal(result.success, false);
        assert.equal(result.errorSource, 'output');
        assert.equal(result.error, value);
        assert.equal(result.errorMessage, 'evaluate 返回值检查或序列化失败: OWNED_FIRST_OUTPUT_FAILURE');
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
            errorSource: 'page',
        });
        assert.deepEqual(await executeCode('new Promise(() => {})', 10), {
            success: false,
            error: 'Evaluation timeout after 10ms',
        });
    } finally {
        restore();
    }
});

test('C23 closed-port scans and reconnects stay debug while identified failures warn once', async () => {
    const output = [];
    const restore = installGlobals({
        console: {
            ...globalThis.console,
            debug: (text) => output.push({ level: 'debug', text }),
            log: (text) => output.push({ level: 'log', text }),
            warn: (text) => output.push({ level: 'warn', text }),
        },
        setTimeout: () => 123,
    });
    try {
        const client = new HttpClient();
        client.shouldReconnect = true;
        client.checkPort = async () => ({ healthy: false });
        await client.discoverServers(client.generation);
        await client.discoverServers(client.generation);
        client.scheduleReconnect();
        assert.equal(output.length, 2);
        assert.ok(output.every((row) => row.level === 'debug'));
        client.checkPort = async (port) =>
            port === 19222
                ? { healthy: false, failureKind: 'authentication', reason: 'server proof mismatch' }
                : { healthy: false };
        await client.discoverServers(client.generation);
        await client.discoverServers(client.generation);
        assert.equal(output.filter((row) => row.level === 'warn').length, 1);
        assert.match(
            output.find((row) => row.level === 'warn').text,
            /19222 \(authentication: server proof mismatch\)/
        );
        client.checkPort = async (port) =>
            port === 19222
                ? { healthy: false, failureKind: 'protocol', reason: 'authentication challenge incomplete' }
                : { healthy: false };
        await client.discoverServers(client.generation);
        await client.discoverServers(client.generation);
        assert.equal(output.filter((row) => row.level === 'warn').length, 2);
        assert.match(
            output.filter((row) => row.level === 'warn')[1].text,
            /19222 \(protocol: authentication challenge incomplete\)/
        );
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
    client.connections.set(19222, { ws: replacement, heartbeatTimer: null, ready: true, requests: new Map() });
    oldSocket.onclose = () => client.removeConnection(19222, oldSocket);
    oldSocket.onclose();
    assert.equal(client.connections.get(19222).ws, replacement);
    client.disconnect();
});

test('C06 missing cached windows reuse a normal window without stale group membership', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    try {
        const handler = new TabHandler({ waitForNavigation: async () => {} });
        const result = await handler.tabsCreate(
            { url: 'https://example.com/test' },
            createActionContext({ mcpWindowId: 100, mcpTabGroupId: 77 })
        );
        assert.equal(result.windowId, 10);
        assert.notEqual(result.groupId, 77);
        assert.equal(
            fixture.calls.some((call) => call.method === 'windows.create'),
            false
        );
    } finally {
        await unmarkManagedTab(6000);
        restore();
        setMcpWindowId(null);
        setMcpTabGroupId(null);
    }
});

function createTabManagementFixture() {
    const defaults = {
        title: 'Fixture',
        active: false,
        pinned: false,
        highlighted: false,
        autoDiscardable: true,
        mutedInfo: { muted: false },
        incognito: false,
        status: 'complete',
        groupId: -1,
    };
    const tabs = new Map([
        [5001, { ...defaults, id: 5001, windowId: 10, index: 0, url: 'https://example.com/one' }],
        [5002, { ...defaults, id: 5002, windowId: 10, index: 1, url: 'https://example.com/two' }],
        [5003, { ...defaults, id: 5003, windowId: 20, index: 0, groupId: 77, url: 'https://example.com/three' }],
    ]);
    const windows = new Map(
        [10, 20].map((id) => [id, { id, type: 'normal', focused: false, state: 'normal', incognito: false }])
    );
    const groups = new Map([
        [77, { id: 77, windowId: 20, title: 'Original', color: 'blue', collapsed: false, shared: false }],
    ]);
    const calls = [];
    const documents = new Map();
    let nextTab = 6000;
    let nextWindow = 30;
    let nextGroup = 80;
    let failClose = false;
    const getTab = (id) => {
        if (!tabs.has(id)) {
            throw new Error(`No tab ${id}`);
        }
        return globalThis.structuredClone(tabs.get(id));
    };
    const getWindow = (id) => {
        if (!windows.has(id)) {
            throw new Error(`No window ${id}`);
        }
        return {
            ...windows.get(id),
            tabs: [...tabs.values()].filter((tab) => tab.windowId === id).map((tab) => getTab(tab.id)),
        };
    };
    const removeEmptyGroups = () => {
        for (const id of groups.keys()) {
            if (![...tabs.values()].some((tab) => tab.groupId === id)) {
                groups.delete(id);
            }
        }
    };
    const chrome = {
        storage: createStorage(),
        webNavigation: {
            getFrame: async ({ tabId }) =>
                tabs.has(tabId)
                    ? { documentId: documents.get(tabId) ?? `document-${tabId}`, url: tabs.get(tabId).url }
                    : undefined,
        },
        debugger: { onDetach: chromeEvent(), onEvent: chromeEvent() },
        scripting: { executeScript: async () => [{ result: [] }] },
        tabs: {
            get: async (id) => getTab(id),
            query: async (query) =>
                [...tabs.values()]
                    .filter((tab) => Object.entries(query).every(([key, value]) => tab[key] === value))
                    .map((tab) => getTab(tab.id)),
            async create(properties) {
                calls.push({ method: 'tabs.create', properties });
                const id = nextTab++;
                tabs.set(id, {
                    ...defaults,
                    id,
                    index: properties.index ?? tabs.size,
                    windowId: properties.windowId ?? 10,
                    ...properties,
                });
                return getTab(id);
            },
            async update(id, properties) {
                calls.push({ method: 'tabs.update', id, properties });
                const tab = tabs.get(id);
                for (const [key, value] of Object.entries(properties)) {
                    if (value !== undefined) {
                        if (key === 'muted') {
                            tab.mutedInfo = { muted: value };
                        } else if (key !== 'active' || value !== false) {
                            tab[key] = value;
                        }
                    }
                }
                return getTab(id);
            },
            async move(id, properties) {
                calls.push({ method: 'tabs.move', id, properties });
                Object.assign(tabs.get(id), properties);
                return getTab(id);
            },
            async remove(id) {
                calls.push({ method: 'tabs.remove', id });
                tabs.delete(id);
                removeEmptyGroups();
            },
            async group(properties) {
                calls.push({ method: 'tabs.group', properties });
                const ids = Array.isArray(properties.tabIds) ? properties.tabIds : [properties.tabIds];
                const id = properties.groupId ?? nextGroup++;
                if (!groups.has(id)) {
                    groups.set(id, {
                        id,
                        windowId: properties.createProperties?.windowId ?? 10,
                        title: '',
                        color: 'grey',
                        collapsed: false,
                        shared: false,
                    });
                }
                for (const tabId of ids) {
                    Object.assign(tabs.get(tabId), { groupId: id, windowId: groups.get(id).windowId, pinned: false });
                }
                removeEmptyGroups();
                return id;
            },
            async ungroup(ids) {
                calls.push({ method: 'tabs.ungroup', ids });
                for (const id of Array.isArray(ids) ? ids : [ids]) {
                    tabs.get(id).groupId = -1;
                }
                removeEmptyGroups();
            },
        },
        tabGroups: {
            get: async (id) => {
                if (!groups.has(id)) {
                    throw new Error(`No group ${id}`);
                }
                return { ...groups.get(id) };
            },
            query: async (query) =>
                [...groups.values()]
                    .filter((group) => Object.entries(query).every(([key, value]) => group[key] === value))
                    .map((group) => ({ ...group })),
            async update(id, properties) {
                calls.push({ method: 'tabGroups.update', id, properties });
                Object.assign(
                    groups.get(id),
                    Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined))
                );
            },
            async move(id, properties) {
                calls.push({ method: 'tabGroups.move', id, properties });
                const group = groups.get(id);
                if (properties.windowId !== undefined) {
                    group.windowId = properties.windowId;
                }
                const members = [...tabs.values()].filter((tab) => tab.groupId === id);
                const index =
                    properties.index === -1
                        ? [...tabs.values()].filter((tab) => tab.windowId === group.windowId && tab.groupId !== id)
                              .length
                        : properties.index;
                for (const [offset, tab] of members.entries()) {
                    Object.assign(tab, { windowId: group.windowId, index: index + offset });
                }
            },
        },
        windows: {
            get: async (id) => getWindow(id),
            getAll: async () => [...windows.keys()].map((id) => getWindow(id)),
            async create(properties) {
                calls.push({ method: 'windows.create', properties });
                const id = nextWindow++;
                windows.set(id, {
                    id,
                    type: 'normal',
                    focused: false,
                    state: 'normal',
                    incognito: false,
                    ...properties,
                });
                if (properties.tabId !== undefined) {
                    Object.assign(tabs.get(properties.tabId), { windowId: id, groupId: -1 });
                }
                if (properties.url !== undefined || properties.tabId === undefined) {
                    const urls = Array.isArray(properties.url) ? properties.url : [properties.url ?? 'about:blank'];
                    for (const [index, url] of urls.entries()) {
                        const tabId = nextTab++;
                        tabs.set(tabId, {
                            ...defaults,
                            id: tabId,
                            windowId: id,
                            index,
                            url,
                            incognito: properties.incognito ?? false,
                        });
                    }
                }
                return getWindow(id);
            },
            async update(id, properties) {
                calls.push({ method: 'windows.update', id, properties });
                Object.assign(windows.get(id), properties);
                return getWindow(id);
            },
            async remove(id) {
                calls.push({ method: 'windows.remove', id });
                if (failClose) {
                    throw new Error('window close refused');
                }
                for (const tab of tabs.values()) {
                    if (tab.windowId === id) {
                        tabs.delete(tab.id);
                    }
                }
                windows.delete(id);
                removeEmptyGroups();
            },
        },
    };
    return {
        chrome,
        tabs,
        documents,
        groups,
        calls,
        setFailClose: (value) => {
            failClose = value;
        },
    };
}

test(
    'TASK pages share trusted task groups across servers without creating ' + 'windows or claiming user groups',
    async () => {
        const fixture = createTabManagementFixture();
        fixture.groups.get(77).title = 'MCP · Printer comparison';
        const restore = installGlobals({ chrome: fixture.chrome });
        const handler = new ActionHandler();
        const nativeUpdates = [];
        const nativeGroup = fixture.chrome.tabs.group;
        fixture.chrome.tabs.group = async (options) => {
            const result = await nativeGroup(options);
            nativeUpdates.push(handler.refreshNativeRelations());
            return result;
        };
        try {
            const [first, second] = await Promise.all(
                ['server-one', 'server-two'].map((serverInstanceId) =>
                    handler.execute(
                        'tabs_create',
                        { url: 'https://example.com/task', taskHint: 'Printer comparison', note: 'temporary' },
                        createActionContext({ serverInstanceId })
                    )
                )
            );
            await Promise.all(nativeUpdates);
            const repeated = await handler.execute(
                'tabs_create',
                { taskHint: 'Printer comparison' },
                createActionContext()
            );
            assert.equal(repeated.groupId, first.groupId);
            await handler.execute('tabs_close', { tabId: repeated.id }, createActionContext());
            assert.equal(first.windowId, 10);
            assert.equal(first.groupId, second.groupId);
            assert.notEqual(first.groupId, 77);
            assert.equal(first.active, false);
            assert.equal(first.metadata.origin, 'created');
            assert.equal(first.metadata.note, 'temporary');
            assert.equal(
                fixture.calls.some((call) => call.method === 'windows.create'),
                false
            );
            assert.equal(fixture.groups.get(first.groupId).title, 'MCP · Printer comparison');
            await handler.execute(
                'tabs_metadata',
                { tabId: first.id, taskHint: 'Renamed', note: null },
                createActionContext()
            );
            await handler.execute('tabs_metadata', { tabId: second.id, taskHint: 'Renamed' }, createActionContext());
            assert.equal(fixture.groups.get(first.groupId).title, 'MCP · Renamed');
            fixture.tabs.get(first.id).groupId = -1;
            await handler.refreshNativeRelations();
            const afterMove = await handler.execute('tabs_create', { taskHint: 'Renamed' }, createActionContext());
            assert.equal(afterMove.groupId, second.groupId, 'remaining trusted members retain the reusable group');
            await handler.execute('tabs_close', { tabId: afterMove.id }, createActionContext());

            const listed = await handler.execute('tabs_list', {}, createActionContext());
            assert.equal(listed.find((tab) => tab.id === first.id).metadata.taskHint, 'Renamed');
            const reloaded = await isolatedManagedTabs(fixture.chrome);
            await reloaded.restoreManagedTabs();
            assert.equal(reloaded.getManagedTabMetadata(first.id).taskHint, 'Renamed');
            assert.equal(reloaded.getManagedTabMetadata(first.id).note, undefined);
            fixture.tabs.get(5001).groupId = first.groupId;
            const third = await handler.execute('tabs_create', { taskHint: 'Renamed' }, createActionContext());
            assert.notEqual(third.groupId, first.groupId, 'mixed user groups stay untouched');
            const updated = await handler.execute(
                'tabs_metadata',
                { tabId: 5001, note: 'user note', origin: 'created', documentId: 'forged', groupId: third.groupId },
                createActionContext()
            );
            assert.equal(updated.origin, 'unknown');
            assert.equal(isManagedTab({ id: 5001 }), false);
            const set = fixture.chrome.storage.local.set;
            fixture.chrome.storage.local.set = async () => {
                throw new Error('metadata storage refused');
            };
            await assert.rejects(
                () => handler.execute('tabs_metadata', { tabId: first.id, note: 'not saved' }, createActionContext()),
                /metadata storage refused/
            );
            fixture.chrome.storage.local.set = set;
            assert.equal(
                (await handler.execute('tabs_metadata', { tabId: first.id }, createActionContext())).note,
                undefined
            );
            await handler.execute('tabs_adopt', { tabId: 5002 }, createActionContext());
            assert.equal(
                (await handler.execute('tabs_list', {}, createActionContext())).find((tab) => tab.id === 5002).metadata
                    .origin,
                'adopted'
            );
            await handler.execute('tabs_close', { tabId: 5002 }, createActionContext());
        } finally {
            globalThis.clearInterval(handler.logManager.sweepTimer);
            for (const id of [5001, 5002, 6000, 6001, 6002, 6003, 6004]) {
                await unmarkManagedTab(id);
            }
            restore();
        }
    }
);

test('TASK v1 migration retains unknown managed access and never establishes group ownership', async () => {
    const fixture = createTabManagementFixture();
    fixture.chrome.storage.sessionValues.mcp_managed_tabs_generation_v1 = 'legacy-generation';
    fixture.chrome.storage.values.mcp_managed_tabs_v1 = {
        version: 1,
        generation: 'legacy-generation',
        tabs: [{ tabId: 5003, documentId: 'document-5003' }],
    };
    const state = await isolatedManagedTabs(fixture.chrome);
    await state.restoreManagedTabs();
    assert.equal(state.isManagedTab({ id: 5003 }), true);
    assert.equal(state.getManagedTabMetadata(5003).origin, 'unknown');
    assert.equal(state.getManagedTabRecord(5003).trustedGroupId, undefined);
    await state.markManagedTab(5003);
    assert.equal(state.getManagedTabMetadata(5003).origin, 'adopted');
});

test('C1 post-create failures preserve target identity, actual management and failure stage', async (t) => {
    for (const stage of ['storage', 'group', 'navigation', 'window-storage']) {
        await t.test(stage, async () => {
            const fixture = createTabManagementFixture();
            const restore = installGlobals({ chrome: fixture.chrome });
            const set = fixture.chrome.storage.local.set;
            if (stage.endsWith('storage')) {
                fixture.chrome.storage.local.set = async () => {
                    throw new Error('storage refused');
                };
            }
            if (stage === 'group') {
                fixture.chrome.tabs.group = async () => {
                    throw new Error('group refused');
                };
            }
            try {
                const handler = new TabHandler({
                    waitForNavigation: async () => {
                        throw new Error('navigation refused');
                    },
                });
                const operation =
                    stage === 'window-storage'
                        ? () =>
                              handler.windowCreate(
                                  { url: 'https://example.com/new', focused: false },
                                  createActionContext()
                              )
                        : () =>
                              handler.tabsCreate(
                                  {
                                      windowId: 20,
                                      ...(stage === 'group' ? { groupId: 77 } : {}),
                                      ...(stage === 'navigation' ? { waitUntil: 'load', timeout: 1 } : {}),
                                  },
                                  createActionContext()
                              );
                await assert.rejects(operation, (error) => {
                    const body = JSON.parse(error.message).error;
                    assert.equal(body.code, 'CREATE_INCOMPLETE');
                    assert.equal(body.context.createdTargetId, '6000');
                    assert.equal(body.context.actionExecuted, true);
                    assert.equal(body.context.actionStatus, 'partial');
                    assert.equal(body.context.failureStage, stage === 'window-storage' ? 'storage' : stage);
                    assert.equal(body.context.managed, !stage.endsWith('storage'));
                    if (stage === 'window-storage') {
                        assert.equal(body.context.windowId, 30);
                    }
                    return true;
                });
                assert.equal(fixture.tabs.has(6000), true);
                assert.equal(fixture.calls.filter((call) => call.method.endsWith('.create')).length, 1);
                assert.equal(
                    fixture.calls.some((call) => call.method.endsWith('.remove')),
                    false
                );
            } finally {
                fixture.chrome.storage.local.set = set;
                await unmarkManagedTab(6000);
                forgetPageRevision(6000);
                restore();
            }
        });
    }
});

test('C2 action grants and revokes ordinary reads without GUI and without full operation rights', async () => {
    const fixture = createTabManagementFixture();
    let documentId = 'grant-document';
    fixture.chrome.webNavigation = { getFrame: async () => ({ documentId }) };
    const restore = installGlobals({ chrome: fixture.chrome });
    let handler;
    const context = { serverInstanceId: 'public-grant-server', mcpWindowId: null, mcpTabGroupId: null };
    try {
        handler = new ActionHandler();
        const before = await pageSnapshot(5001);
        await assert.rejects(() => assertReadableTab(5001, context, 'read'), /只读权限/);
        const grant = await handler.execute(
            'tabs_read_access',
            { tabId: 5001, allow: true, expectedRevision: before.revision },
            context
        );
        assert.equal(grant.allowed, true);
        assert.equal(grant.managed, false);
        assert.equal(grant.revision, before.revision);
        assert.equal((await pageSnapshot(5001)).revision, before.revision);
        await assertReadableTab(5001, context, 'read');
        assert.equal(await hasReadGrant('other-server', 5001), false);
        for (const [action, params] of [
            ['evaluate', {}],
            ['debugger_attach', {}],
            ['input_key', {}],
            ['screenshot', {}],
            ['tabs_close', {}],
            ['tabs_activate', {}],
            ['tabs_activate_managed', {}],
            ['tabs_move', { index: 0 }],
            ['tabs_reorder', { index: 0 }],
            ['tabs_pin', { pinned: true }],
            ['tabs_update', { pinned: true }],
            ['navigate', { url: 'https://example.com/not-authorized' }],
            ['go_back', {}],
            ['go_forward', {}],
            ['reload', {}],
        ]) {
            await assert.rejects(() => handler.execute(action, { tabId: 5001, ...params }, context), /非托管/);
            assert.equal((await pageSnapshot(5001)).revision, before.revision, action);
            assert.equal(await hasReadGrant(context.serverInstanceId, 5001), true, action);
            await assertReadableTab(5001, context, 'read');
        }
        assert.equal(
            fixture.calls.some((call) => /^(?:tabs|windows)\.(?:update|move|remove)$/.test(call.method)),
            false
        );
        await handler.execute('tabs_read_access', { tabId: 5001, allow: false }, context);
        await assert.rejects(() => assertReadableTab(5001, context, 'read'), /只读权限/);
        await assert.rejects(
            () => handler.execute('tabs_read_access', { tabId: 5001, allow: true, expectedRevision: 'stale' }, context),
            /ACTION_PRECONDITION_FAILED/
        );
        await handler.execute('tabs_read_access', { tabId: 5001, allow: true }, context);
        documentId = 'replacement-document';
        assert.equal(await hasReadGrant(context.serverInstanceId, 5001), false);
        await handler.execute('tabs_read_access', { tabId: 5001, allow: true }, context);
        advancePageRevision(5001);
        assert.equal(await hasReadGrant(context.serverInstanceId, 5001), false);
        await handler.execute('tabs_read_access', { tabId: 5001, allow: false }, context);
        const set = fixture.chrome.storage.session.set;
        fixture.chrome.storage.session.set = async () => {
            throw new Error('grant storage refused');
        };
        await assert.rejects(
            () => handler.execute('tabs_read_access', { tabId: 5001, allow: true }, context),
            /storage refused/
        );
        fixture.chrome.storage.session.set = set;
        assert.equal(await hasReadGrant(context.serverInstanceId, 5001), false);
        assert.equal(
            fixture.calls.some((call) => call.method === 'tabs.update'),
            false
        );
    } finally {
        if (handler?.logManager.sweepTimer) {
            globalThis.clearInterval(handler.logManager.sweepTimer);
        }
        await revokeReadGrants(context.serverInstanceId);
        forgetPageRevision(5001);
        restore();
    }
});

test('C13 tab updates consume native flags, preserve false values and reject stale conditions', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    let handler;
    try {
        await markManagedTab(5001);
        handler = new ActionHandler();
        const before = await pageSnapshot(5001);
        await assert.rejects(
            () => handler.execute('tabs_update', { tabId: 5001, muted: true, expectedRevision: 'stale' }, {}),
            /ACTION_PRECONDITION_FAILED/
        );
        assert.equal(fixture.calls.length, 0);
        const properties = {
            url: 'https://example.com/updated',
            active: true,
            pinned: true,
            highlighted: true,
            muted: true,
            autoDiscardable: false,
            openerTabId: 5002,
        };
        const changed = await handler.execute(
            'tabs_update',
            { tabId: 5001, ...properties, expectedRevision: before.revision },
            createActionContext()
        );
        assert.deepEqual(fixture.calls[0], { method: 'tabs.update', id: 5001, properties });
        assert.equal(changed.before.muted, false);
        assert.equal(changed.after.muted, true);
        assert.equal(changed.after.openerTabId, 5002);
        assert.equal(changed.before.revision, before.revision);
        assert.equal(changed.after.revision, (await pageSnapshot(5001)).revision);
        const userResult = { after: { id: 5001, revision: 'user-data' } };
        handler.actions.set('evaluate', async () => userResult);
        assert.deepEqual(await handler.execute('evaluate', { tabId: 5001 }, createActionContext()), userResult);
        assert.equal(userResult.after.revision, 'user-data');
        const reset = await handler.execute(
            'tabs_update',
            { tabId: 5001, pinned: false, highlighted: false, muted: false, autoDiscardable: true },
            createActionContext()
        );
        for (const key of ['pinned', 'highlighted', 'muted']) {
            assert.equal(reset.after[key], false);
        }
        assert.equal(reset.after.active, true);
        assert.equal(reset.after.autoDiscardable, true);
        await assert.rejects(() => handler.execute('tabs_update', { tabId: 5001 }, {}), /至少一个/);
        await assert.rejects(() => handler.execute('tabs_update', { tabId: 5001, openerTabId: 5003 }, {}), /同一窗口/);
    } finally {
        if (handler?.logManager.sweepTimer) {
            globalThis.clearInterval(handler.logManager.sweepTimer);
        }
        await unmarkManagedTab(5001);
        forgetPageRevision(5001);
        restore();
    }
});

test('C15 rejected updates preserve revisions while dispatched failures invalidate them', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    let handler;
    try {
        await markManagedTab(5001);
        fixture.tabs.get(5001).active = true;
        handler = new ActionHandler();
        const before = await pageSnapshot(5001);
        for (const properties of [
            { active: false, muted: true },
            { active: false, highlighted: true },
            {},
            { openerTabId: 5003, muted: true },
            { openerTabId: 5001 },
            { url: '', muted: true },
        ]) {
            await assert.rejects(
                () => handler.execute('tabs_update', { tabId: 5001, ...properties }, {}),
                (error) => {
                    const body = JSON.parse(error.message).error;
                    assert.equal(error.actionExecuted, false);
                    assert.equal(body.context.actionExecuted, false);
                    assert.equal(body.context.failureStage, 'preflight');
                    return true;
                }
            );
            assert.equal((await pageSnapshot(5001)).revision, before.revision);
            assert.equal(fixture.tabs.get(5001).active, true);
            assert.equal(fixture.tabs.get(5001).mutedInfo.muted, false);
            assert.equal(fixture.calls.length, 0);
        }
        const update = fixture.chrome.tabs.update;
        fixture.chrome.tabs.update = async (...args) => {
            await update(...args);
            throw new ExpectedOperationError('native update result unknown');
        };
        await assert.rejects(() => handler.execute('tabs_update', { tabId: 5001, muted: true }, {}), /unknown/);
        assert.equal(fixture.tabs.get(5001).mutedInfo.muted, true);
        assert.notEqual((await pageSnapshot(5001)).revision, before.revision);
    } finally {
        if (handler?.logManager.sweepTimer) {
            globalThis.clearInterval(handler.logManager.sweepTimer);
        }
        await unmarkManagedTab(5001);
        forgetPageRevision(5001);
        restore();
    }
});

test('C15 creation preflight failures preserve known non-execution without native creation', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    try {
        await markManagedTab(5001);
        const handler = new TabHandler({});
        for (const [method, params] of [
            ['tabsCreate', { windowId: 10, groupId: 77 }],
            ['tabsCreate', { windowId: 10, openerTabId: 5003 }],
            ['tabsCreate', { groupId: -2 }],
            ['tabsCreate', { groupId: 77, pinned: true }],
            ['tabsCreate', { openerTabId: 9999 }],
            ['windowCreate', { tabId: 5001, incognito: true }],
            ['windowCreate', { tabId: 5002 }],
            ['windowCreate', { state: 'maximized', width: 800 }],
        ]) {
            await assert.rejects(
                () => handler[method](params, {}),
                (error) => {
                    const body = JSON.parse(error.message).error;
                    assert.equal(body.context.actionExecuted, false);
                    assert.equal(body.context.actionStatus, 'not_started');
                    assert.equal(body.context.failureStage, 'preflight');
                    return true;
                }
            );
            assert.equal(fixture.calls.length, 0);
        }
    } finally {
        await unmarkManagedTab(5001);
        restore();
    }
});

test('C15 new groups retain their member window and require a destination for mixed windows', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    try {
        for (const id of [5001, 5002]) {
            await markManagedTab(id);
            fixture.tabs.get(id).windowId = 20;
        }
        const handler = new TabHandler({});
        const grouped = await handler.tabGroupCreate({ tabIds: [5001, 5002] }, createActionContext());
        assert.equal(grouped.after[0].windowId, 20);
        assert.ok(grouped.tabsAfter.every((tab) => tab.windowId === 20));
        assert.deepEqual(fixture.calls[0].properties.createProperties, { windowId: 20 });
        fixture.tabs.get(5002).windowId = 10;
        const count = fixture.calls.length;
        await assert.rejects(() => handler.tabGroupCreate({ tabIds: [5001, 5002] }, createActionContext()), /windowId/);
        assert.equal(fixture.calls.length, count);
        const moved = await handler.tabGroupCreate({ tabIds: [5001, 5002], windowId: 20 }, createActionContext());
        assert.ok(moved.tabsAfter.every((tab) => tab.windowId === 20));
        const created = await handler.tabsCreate({}, { mcpWindowId: null, mcpTabGroupId: null });
        const window = fixture.calls.find((call) => call.method === 'windows.create');
        const create = fixture.calls.find((call) => call.method === 'tabs.create');
        const group = fixture.calls.findLast((call) => call.method === 'tabs.group');
        assert.equal(window, undefined);
        assert.equal(created.windowId, create.properties.windowId);
        assert.deepEqual(group.properties.createProperties, { windowId: created.windowId });
    } finally {
        for (const id of fixture.tabs.keys()) {
            await unmarkManagedTab(id);
        }
        restore();
    }
});

test('C15 popup creation rejects extra pages before creating or moving a tab', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    try {
        await markManagedTab(5001);
        const handler = new TabHandler({});
        for (const params of [
            { type: 'popup', url: ['https://example.com/a', 'https://example.com/b'] },
            { type: 'popup', tabId: 5001, url: 'https://example.com/extra' },
            { type: 'popup', tabId: 5001, url: ['https://example.com/extra'] },
        ]) {
            await assert.rejects(() => handler.windowCreate(params, createActionContext()), /popup/);
            assert.equal(fixture.calls.length, 0);
            assert.equal(fixture.tabs.get(5001).windowId, 10);
        }
        const single = await handler.windowCreate(
            { type: 'popup', url: ['https://example.com/a'] },
            createActionContext()
        );
        assert.equal(single.after.tabs.length, 1);
        assert.equal(single.after.tabs[0].managed, true);
        const moved = await handler.windowCreate({ type: 'popup', tabId: 5001 }, createActionContext());
        assert.equal(moved.targetId, '5001');
        assert.equal(moved.after.tabs.length, 1);
    } finally {
        for (const id of fixture.tabs.keys()) {
            await unmarkManagedTab(id);
        }
        restore();
    }
});

test('C13 page creation preserves explicit placement and rejects conflicting window or group options', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    try {
        const handler = new TabHandler({});
        const created = await handler.tabsCreate(
            { url: 'https://example.com/new', windowId: 10, index: 1, pinned: true, openerTabId: 5002, active: false },
            createActionContext()
        );
        assert.deepEqual(
            fixture.calls.map((call) => call.method),
            ['tabs.create']
        );
        assert.equal(created.windowId, 10);
        assert.equal(created.index, 1);
        assert.equal(created.pinned, true);
        assert.equal(created.openerTabId, 5002);
        assert.equal(created.managed, true);
        assert.equal(created.groupId, -1);
        const count = fixture.calls.length;
        await assert.rejects(
            () => handler.tabsCreate({ windowId: 10, groupId: 77 }, createActionContext()),
            /同一窗口/
        );
        await assert.rejects(() => handler.tabsCreate({ groupId: 77, pinned: true }, createActionContext()), /不兼容/);
        assert.equal(fixture.calls.length, count);
    } finally {
        for (const id of fixture.tabs.keys()) {
            await unmarkManagedTab(id);
        }
        restore();
    }
});

test('C13 group CRUD returns real members and properties without changing managed authority', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    let handler;
    try {
        handler = new ActionHandler();
        await markManagedTab(5001);
        await markManagedTab(5002);
        const created = await handler.execute(
            'tabgroup_create',
            { tabIds: [5001, 5002], title: '', color: 'purple', collapsed: true },
            createActionContext()
        );
        const groupId = created.groupId;
        const original = created.after.find((group) => group.id === groupId);
        assert.deepEqual(original.tabIds, [5001, 5002]);
        assert.deepEqual(original.targetIds, ['5001', '5002']);
        assert.equal(original.color, 'purple');
        assert.equal(original.title, '');
        assert.equal(original.collapsed, true);
        assert.equal(original.shared, false);
        const updated = await handler.execute(
            'tabgroup_update',
            { groupId, title: 'Updated', color: 'yellow', collapsed: false },
            createActionContext()
        );
        assert.equal(updated.after[0].color, 'yellow');
        assert.equal(updated.after[0].collapsed, false);
        const moved = await handler.execute(
            'tabgroup_move',
            { groupId, windowId: 20, index: -1 },
            createActionContext()
        );
        assert.equal(moved.after[0].windowId, 20);
        assert.equal(
            moved.tabsAfter.every((tab) => tab.windowId === 20 && tab.managed),
            true
        );
        await handler.execute('tabs_release', { tabId: 5001 }, createActionContext());
        assert.equal(fixture.tabs.get(5001).groupId, groupId);
        assert.equal(isManagedTab({ id: 5001 }), false);
        const count = fixture.calls.length;
        const mixed = await handler.execute('tabgroup_update', { groupId, color: 'red' }, createActionContext());
        assert.equal(mixed.after[0].color, 'red');
        assert.equal(mixed.tabsAfter.find((tab) => tab.id === 5001).managed, false);
        await assert.rejects(
            () => handler.execute('tabgroup_move', { groupId, windowId: 10, index: -1 }, {}),
            /非托管/
        );
        assert.equal(fixture.calls.length, count + 1);
        await handler.execute('tabs_adopt', { tabId: 5001 }, createActionContext());
        const removed = await handler.execute('tabgroup_remove', { tabIds: [5001, 5002] }, createActionContext());
        assert.deepEqual(removed.after, []);
        assert.equal(
            removed.tabsAfter.every((tab) => tab.groupId === -1 && tab.managed),
            true
        );
        const added = await handler.execute(
            'tabgroup_add',
            { tabIds: [5001, 5002], groupId: 77 },
            createActionContext()
        );
        assert.equal(added.groupId, 77);
        assert.equal(isManagedTab({ id: 5003 }), false);
        const topology = await handler.execute('tabs_topology', {}, createActionContext());
        assert.deepEqual(topology.groups.find((group) => group.id === 77).tabIds, [5003, 5001, 5002]);
    } finally {
        if (handler?.logManager.sweepTimer) {
            globalThis.clearInterval(handler.logManager.sweepTimer);
        }
        for (const id of fixture.tabs.keys()) {
            await unmarkManagedTab(id);
            forgetPageRevision(id);
        }
        restore();
    }
});

test('C13 unmanaged member mutations and invalid native options reject before effects', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    try {
        await markManagedTab(5001);
        const handler = new TabHandler({});
        await assert.rejects(
            () => handler.tabGroupCreate({ tabIds: [5001, 5002], color: 'red' }, createActionContext()),
            /非托管/
        );
        await assert.rejects(
            () =>
                handler.windowCreate(
                    { url: 'https://example.com/', state: 'maximized', width: 800 },
                    createActionContext()
                ),
            /不能/
        );
        await assert.rejects(() => handler.windowUpdate({ windowId: 10, state: 'minimized', focused: true }), /冲突/);
        assert.equal(fixture.calls.length, 0);
    } finally {
        await unmarkManagedTab(5001);
        restore();
    }
});

test('C13 window CRUD marks all created tabs and keeps permissions if native close fails', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    try {
        const handler = new TabHandler({});
        const created = await handler.windowCreate(
            {
                url: ['https://example.com/a', 'https://example.com/b'],
                type: 'normal',
                focused: false,
                width: 800,
                height: 600,
                setSelfAsOpener: true,
            },
            createActionContext()
        );
        assert.equal(created.after.tabs.length, 2);
        assert.equal(
            created.after.tabs.every((tab) => tab.managed),
            true
        );
        assert.equal(created.after.type, 'normal');
        const updated = await handler.windowUpdate(
            {
                windowId: created.windowId,
                left: 10,
                top: 20,
                width: 900,
                height: 700,
                state: 'normal',
                focused: false,
                drawAttention: false,
            },
            createActionContext()
        );
        assert.equal(updated.after.width, 900);
        assert.equal(updated.after.top, 20);
        assert.equal(fixture.calls.at(-1).properties.drawAttention, false);
        fixture.setFailClose(true);
        await assert.rejects(
            () => handler.windowClose({ windowId: created.windowId }, createActionContext()),
            /close refused/
        );
        assert.equal(
            created.after.tabs.every((tab) => isManagedTab(tab)),
            true
        );
        fixture.setFailClose(false);
        const closed = await handler.windowClose({ windowId: created.windowId }, createActionContext());
        assert.equal(closed.after, null);
        assert.equal(
            created.after.tabs.every((tab) => !isManagedTab(tab)),
            true
        );
        await markManagedTab(5001);
        const moved = await handler.windowCreate({ tabId: 5001, focused: false }, createActionContext());
        assert.equal(moved.targetId, '5001');
        assert.equal(moved.after.tabs[0].managed, true);
        assert.equal(fixture.calls.at(-1).properties.tabId, 5001);
        assert.equal(fixture.calls.at(-1).properties.url, undefined);
        const combined = await handler.windowCreate(
            { tabId: 5001, url: ['https://example.com/extra'], focused: false },
            createActionContext()
        );
        assert.equal(combined.targetId, '5001');
        assert.equal(combined.after.tabs.length, 2);
        assert.equal(
            combined.after.tabs.every((tab) => tab.managed),
            true
        );
        assert.deepEqual(fixture.calls.at(-1).properties.url, ['https://example.com/extra']);
    } finally {
        for (const id of [...fixture.tabs.keys(), 6000, 6001]) {
            await unmarkManagedTab(id);
        }
        setMcpWindowId(null);
        restore();
    }
});

test('C28 window updates observe state and stable geometry without replaying native updates', async (t) => {
    const scenarios = [
        ...['windowUpdate', 'windowResize'].flatMap((method) =>
            ['maximized', 'minimized', 'fullscreen'].map((state) => ({ method, state, kind: 'restore' }))
        ),
        { method: 'windowUpdate', state: 'normal', kind: 'state-only' },
        { method: 'windowUpdate', state: 'normal', kind: 'clamped' },
        { method: 'windowUpdate', state: 'maximized', kind: 'state-timeout' },
        { method: 'windowResize', state: 'normal', kind: 'bounds-timeout' },
        { method: 'windowUpdate', state: 'maximized', kind: 'released' },
    ];
    for (const specimen of scenarios) {
        await t.test(`${specimen.method}-${specimen.state}-${specimen.kind}`, async () => {
            const fixture = createTabManagementFixture();
            const getWindow = fixture.chrome.windows.get;
            const nativeCalls = [];
            let now = 0;
            let transition;
            let decorated = false;
            let released = false;
            let changed = false;
            const actual = { state: specimen.state, left: 90, top: 70, width: 1040, height: 780, focused: false };
            fixture.chrome.windows.get = async (id) => {
                if (transition && now >= transition.started + 100 && specimen.kind !== 'state-timeout') {
                    actual.state = transition.state;
                    if (now >= transition.started + 200 && !decorated) {
                        decorated = true;
                        actual.left -= 22;
                        actual.top -= 19;
                        actual.width += 44;
                        actual.height += 44;
                    }
                }
                if (specimen.kind === 'released' && transition && now >= transition.started + 200 && !released) {
                    released = true;
                    await unmarkManagedTab(5002);
                }
                if (specimen.kind === 'bounds-timeout' && changed) {
                    ++actual.left;
                }
                return { ...(await getWindow(id)), ...actual };
            };
            fixture.chrome.windows.update = async (id, properties) => {
                nativeCalls.push({ id, properties: { ...properties }, at: now });
                changed = true;
                const bounds = Object.fromEntries(
                    ['left', 'top', 'width', 'height']
                        .filter((key) => properties[key] !== undefined)
                        .map((key) => [key, properties[key]])
                );
                if (properties.state && properties.state !== actual.state) {
                    transition = { state: properties.state, started: now };
                }
                Object.assign(actual, bounds);
                if (specimen.kind === 'clamped') {
                    actual.width = Math.max(actual.width, 320);
                }
                if (properties.focused !== undefined) {
                    actual.focused = properties.focused;
                }
                return { ...(await getWindow(id)), ...actual };
            };
            const restore = installGlobals({
                chrome: fixture.chrome,
                Date: class extends Date {
                    static now() {
                        return now;
                    }
                },
                setTimeout(callback, ms) {
                    now += ms;
                    globalThis.queueMicrotask(callback);
                    return 0;
                },
            });
            try {
                await markManagedTab(5001);
                await markManagedTab(5002);
                const handler = new TabHandler({});
                const bounds = { left: 90, top: 70, width: 1040, height: 780 };
                const params =
                    specimen.kind === 'state-only'
                        ? { windowId: 10, state: 'maximized' }
                        : { windowId: 10, state: 'normal', ...bounds, focused: false, drawAttention: true };
                if (specimen.kind === 'clamped') {
                    params.width = 10;
                }
                const invoke = () => handler[specimen.method](params);
                if (specimen.kind.endsWith('timeout')) {
                    await assert.rejects(invoke, (error) => {
                        const body = JSON.parse(error.message).error;
                        assert.equal(body.code, 'WINDOW_UPDATE_NOT_OBSERVED');
                        assert.equal(body.context.actionExecuted, true);
                        assert.equal(body.context.actionStatus, 'partial');
                        assert.equal(body.context.failureStage, 'observation');
                        assert.equal(body.context.windowId, 10);
                        return true;
                    });
                    assert.equal(nativeCalls.length, 1);
                    assert.ok(now >= 1000 && now <= 1100);
                    if (specimen.kind === 'state-timeout') {
                        assert.deepEqual(nativeCalls[0].properties, { state: 'normal' });
                    }
                } else if (specimen.kind === 'released') {
                    const result = await invoke();
                    assert.equal(result.after.state, 'normal');
                    assert.equal(result.after.tabs.find((tab) => tab.id === 5002).managed, false);
                    assert.equal(nativeCalls.length, 2);
                    assert.deepEqual(nativeCalls[0].properties, { state: 'normal' });
                } else {
                    const result = await invoke();
                    assert.equal(result.success, true);
                    assert.equal(result.after.state, params.state);
                    assert.equal(result.before.state, specimen.state);
                    if (specimen.kind === 'state-only') {
                        assert.equal(nativeCalls.length, 1);
                    } else {
                        for (const [key, value] of Object.entries(bounds)) {
                            assert.equal(
                                result.after[key],
                                specimen.kind === 'clamped' && key === 'width' ? 320 : value
                            );
                            assert.equal(result.after[key], actual[key]);
                        }
                        const geometry = nativeCalls.filter((call) => call.properties.width !== undefined);
                        assert.equal(geometry.length, 1);
                        assert.equal(geometry[0].properties.focused, false);
                        assert.equal(geometry[0].properties.drawAttention, true);
                        if (specimen.kind === 'restore') {
                            assert.equal(nativeCalls.length, 2);
                            assert.deepEqual(nativeCalls[0].properties, { state: 'normal' });
                            assert.equal(geometry[0].properties.state, undefined);
                            assert.ok(geometry[0].at >= 200);
                        }
                    }
                }
            } finally {
                await unmarkManagedTab(5001);
                await unmarkManagedTab(5002);
                restore();
            }
        });
    }
});

test('C10 network fallback reads requests completed after the first performance snapshot', async () => {
    const fixture = createTabManagementFixture();
    const first = {
        source: 'performance',
        url: 'https://example.com/first',
        method: 'GET',
        status: 200,
        type: 'Document',
        timestamp: 1000,
    };
    const second = {
        source: 'performance',
        url: 'https://example.com/later-fetch',
        method: '',
        status: 404,
        type: 'fetch',
        timestamp: 1100,
    };
    let reads = 0;
    fixture.chrome.scripting = { executeScript: async () => [{ result: ++reads === 1 ? [first] : [first, second] }] };
    const restore = installGlobals({ chrome: fixture.chrome });
    const manager = new LogManager();
    try {
        await markManagedTab(5001);
        const handler = new LogEventHandler(manager, { isAttached: () => false });
        assert.deepEqual((await handler.networkGet({ tabId: 5001 }, createActionContext())).requests, [first]);
        assert.deepEqual((await handler.networkGet({ tabId: 5001 }, createActionContext())).requests, [first, second]);
        assert.equal(reads, 2);
    } finally {
        if (manager.sweepTimer) {
            globalThis.clearInterval(manager.sweepTimer);
        }
        await unmarkManagedTab(5001);
        restore();
    }
});

test('C10 performance network refresh preserves markers and document-local clear boundaries', async () => {
    const fixture = createTabManagementFixture();
    let now = 100;
    let timeOrigin = 1000;
    let attached = false;
    let reads = 0;
    const navigation = [{ name: 'https://example.com/page', startTime: 0, duration: 1, responseStatus: 200 }];
    const resources = [
        { name: 'https://example.com/fetch', initiatorType: 'fetch', startTime: 10, duration: 3, responseStatus: 404 },
    ];
    fixture.chrome.scripting = {
        executeScript: async ({ world, func, args }) => {
            assert.equal(world, 'ISOLATED');
            ++reads;
            return [{ result: func(...args) }];
        },
    };
    const performance = {
        get timeOrigin() {
            return timeOrigin;
        },
        now: () => now,
        getEntriesByType: (type) => (type === 'navigation' ? navigation : resources),
    };
    const restore = installGlobals({ chrome: fixture.chrome, window: {}, performance });
    const manager = new LogManager();
    try {
        await markManagedTab(5001);
        const handler = new LogEventHandler(manager, { isAttached: () => attached });
        const read = async (clear = false) =>
            (await handler.networkGet({ tabId: 5001, clear }, createActionContext())).requests;
        const first = await read();
        assert.equal(first.length, 2);
        assert.equal(first[1].source, 'performance');
        assert.equal(first[1].status, 404);
        const marker = JSON.stringify(first.at(-1));
        resources.push({ ...resources[0] });
        const second = await read();
        assert.equal(second.length, 3);
        assert.equal(JSON.stringify(second[1]), marker);
        assert.ok(second[2].sequence > second[1].sequence);
        assert.deepEqual(await read(), second);
        assert.deepEqual(await read(true), second);
        assert.equal(resources.length, 2);
        assert.equal(navigation.length, 1);
        assert.deepEqual(await read(), []);
        now = 120;
        resources.push({ ...resources[0], startTime: 110, responseStatus: 401 });
        const afterClear = await read();
        assert.equal(afterClear.length, 1);
        assert.equal(afterClear[0].status, 401);
        assert.ok(afterClear[0].sequence > second[2].sequence);
        attached = true;
        manager.setNetwork(5001, [
            { url: 'https://example.com/native', method: 'POST', type: 'Fetch', status: 200, timestamp: 1150 },
        ]);
        const beforeNative = reads;
        assert.equal((await read())[0].method, 'POST');
        assert.equal(reads, beforeNative);
        await handler.networkClear({ tabId: 5001 }, createActionContext());
        attached = false;
        assert.deepEqual(await read(), []);
        globalThis.window = {};
        timeOrigin = 2000;
        resources.length = 0;
        navigation[0] = { ...navigation[0], name: 'https://example.com/next-document' };
        const nextDocument = await read();
        assert.equal(nextDocument.length, 1);
        assert.equal(nextDocument[0].url, 'https://example.com/next-document');
        assert.ok(nextDocument[0].sequence > afterClear[0].sequence);
        fixture.chrome.scripting.executeScript = async () => [];
        await assert.rejects(() => read(), /did not return request records/);
    } finally {
        if (manager.sweepTimer) {
            globalThis.clearInterval(manager.sweepTimer);
        }
        await unmarkManagedTab(5001);
        restore();
    }
});

function consoleHandoffCommands(page, getManager, onEnable = () => {}) {
    vm.runInContext('Object.assign(globalThis, window); window = globalThis', page);
    return async (_target, method, params = {}) => {
        const manager = getManager();
        if (method === 'Runtime.addBinding') {
            page[params.name] = (payload) =>
                manager.handleEvent(1, 'Runtime.bindingCalled', {
                    name: params.name,
                    payload,
                    executionContextId: 1,
                });
        } else if (method === 'Runtime.enable') {
            manager.handleEvent(1, 'Runtime.executionContextCreated', {
                context: { id: 1, auxData: { frameId: 'owned-main', isDefault: true } },
            });
            onEnable();
        } else if (method === 'Page.getFrameTree') {
            return { frameTree: { frame: { id: 'owned-main' } } };
        } else if (method === 'Runtime.evaluate') {
            return { result: { value: vm.runInContext(params.expression, page) } };
        } else if (!['Runtime.removeBinding', 'Runtime.getIsolateId', 'Page.enable'].includes(method)) {
            assert.fail(`Unexpected console command ${method}`);
        }
        return {};
    };
}

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
    const managers = [];
    let currentLogManager;
    const createLogManager = () => {
        currentLogManager = new LogManager();
        managers.push(currentLogManager);
        return currentLogManager;
    };
    const sendConsoleCommand = consoleHandoffCommands(page, () => currentLogManager);
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
                sendCommand: sendConsoleCommand,
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
        await markManagedTab(1);
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
        for (const manager of managers) {
            globalThis.clearInterval(manager.sweepTimer);
        }
        await unmarkManagedTab(1);
        restore();
    }
});

test(
    'QL-CH-02 fallback console retains independent identical events, levels, ' + 'sequence and drained batches',
    async () => {
        const page = vm.createContext({
            window: {},
            console: Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map((level) => [level, () => {}])),
            Reflect,
            Array,
            String,
            Date: { now: () => 1234 },
        });
        const manager = new LogManager();
        let blocked = true;
        const restore = installGlobals({
            chrome: {
                storage: createStorage(),
                tabs: { get: async () => ({ id: 1, url: 'https://test.example', groupId: 10 }) },
                debugger: { sendCommand: consoleHandoffCommands(page, () => manager) },
                scripting: {
                    executeScript: async ({ func }) => [{ result: vm.runInContext(`(${func.toString()})()`, page) }],
                },
            },
        });
        const handler = new LogEventHandler(manager, {
            ensureAttached: async () => {
                if (blocked) {
                    throw new DebuggerBlockedError(1);
                }
            },
        });
        const context = { mcpWindowId: null, mcpTabGroupId: 10 };
        try {
            await markManagedTab(1);
            await handler.consoleEnable({ tabId: 1 }, context);
            vm.runInContext("console.warn('same'); console.error('same'); console.error('same')", page);
            const first = await handler.consoleGet({ tabId: 1 }, context);
            assert.deepEqual(
                first.messages.map((message) => message.level),
                ['warn', 'error', 'error']
            );
            assert.deepEqual(
                first.messages.map((message) => message.sequence),
                [1, 2, 3]
            );
            assert.equal((await handler.consoleGet({ tabId: 1, level: 'error' }, context)).messages.length, 2);
            assert.equal((await handler.consoleGet({ tabId: 1 }, context)).messages.length, 3);
            vm.runInContext("console.error('same')", page);
            const reads = await Promise.all([
                handler.consoleGet({ tabId: 1 }, context),
                handler.consoleGet({ tabId: 1 }, context),
            ]);
            assert.deepEqual(
                reads.map((read) => read.messages.length),
                [4, 4]
            );
            await handler.consoleClear({ tabId: 1 }, context);
            assert.equal((await handler.consoleGet({ tabId: 1 }, context)).messages.length, 0);
            vm.runInContext("for (let i = 0; i < 1005; ++i) console.error('same')", page);
            assert.equal((await handler.consoleGet({ tabId: 1 }, context)).messages.length, 1000);
            const lastSequence = manager.getConsole(1).at(-1).sequence;
            vm.runInContext("console.error('same'); console.error('same')", page);
            blocked = false;
            await handler.consoleEnable({ tabId: 1 }, context);
            assert.equal(vm.runInContext('window.__mcpConsoleHook', page), undefined);
            assert.equal(manager.getConsole(1).length, 1000);
            assert.equal(manager.getConsole(1).at(-1).sequence, lastSequence + 2);
            assert.equal((await handler.consoleGet({ tabId: 1, clear: true }, context)).messages.length, 1000);
            assert.equal((await handler.consoleGet({ tabId: 1 }, context)).messages.length, 0);
        } finally {
            manager.cleanupTab(1);
            globalThis.clearInterval(manager.sweepTimer);
            await unmarkManagedTab(1);
            restore();
        }
    }
);

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
            storage: createStorage(),
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
        await markManagedTab(1);
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
        firstResult.resolve();
        await unmarkManagedTab(1);
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
        const logManager = {
            getPending: () => pending,
            isPendingUncertain: () => false,
            isNetworkObserved: () => true,
        };
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
            /Network 观测未建立/
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
        await markManagedTab(tab.id);
        const debuggerHandler = new DebuggerHandler({ async ensureAttached() {} }, {});
        await assert.rejects(
            () =>
                debuggerHandler.debuggerSend(
                    { tabId: tab.id, method: 'Runtime.evaluate', params: { expression: '1' } },
                    createActionContext()
                ),
            (error) => error instanceof ExpectedOperationError && error.message.includes('Cannot find context')
        );
        assert.equal(debuggerCalls, 1);
        debuggerError = new Error('unexpected debugger defect');
        await assert.rejects(
            () => debuggerHandler.debuggerSend({ tabId: tab.id, method: 'Runtime.evaluate' }, createActionContext()),
            (error) => error === debuggerError
        );
        const contentHandler = new ContentHandler({
            async ensureAttached() {
                assert.fail('failed dimension reads must not attach the debugger');
            },
        });
        const actions = [
            () => contentHandler.getText({ tabId: tab.id }, createActionContext()),
            () => contentHandler.getViewportMetrics({ tabId: tab.id }, createActionContext()),
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
                    createActionContext()
                ),
            () => contentHandler.screenshot({ tabId: tab.id }, createActionContext()),
        ];
        for (const [index, action] of actions.entries()) {
            const before = injections;
            for (const message of ['Frame with ID 0 is showing error page', 'Cannot access a chrome:// URL']) {
                injectionError = new Error(message);
                await assert.rejects(
                    action,
                    (error) =>
                        error instanceof ExpectedOperationError &&
                        (index === 0 ? JSON.parse(error.message).error.message === message : error.message === message)
                );
            }
            injectionError = new Error('unexpected injection defect');
            await assert.rejects(action, (error) =>
                index === 0 ? error.cause === injectionError : error === injectionError
            );
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
                await markManagedTab(tab.id);
                const handler = new NavigationHandler({});
                const signal = handler.waitForNavigationSignal.bind(handler);
                handler.waitForNavigationSignal = (tabId, beforeUrl) => signal(tabId, beforeUrl, 1);
                const action = () =>
                    handler[direction === 'back' ? 'goBack' : 'goForward'](
                        { tabId: tab.id, timeout: 1000 },
                        createActionContext()
                    );
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
        await handler.runNavigationAction(7, 'domcontentloaded', Date.now() + 1000, async () => {
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
            Date.now() + 1000,
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
                handler.runNavigationAction(7, 'load', Date.now() + 1000, async () => {
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
        await assert.rejects(new CookieHandler().cookiesClear({ domain: 'example.com' }), (error) => {
            const detail = JSON.parse(error.message).error;
            assert.equal(detail.code, 'COOKIE_CLEAR_PARTIAL');
            assert.equal(detail.context.count, 1);
            assert.equal(detail.context.failed, 3);
            return true;
        });
    } finally {
        restore();
    }
});

function installOwnerProbeFixture(chrome, tab, frameId, documentId) {
    let acknowledged;
    const executeScript = chrome.scripting?.executeScript;
    chrome.scripting = {
        ...chrome.scripting,
        executeScript: async (request) => {
            if (request.func.name === 'installFrameProbeListener') {
                return [];
            }
            return executeScript(request);
        },
    };
    const sendCommand = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = async (target, method, params) => {
        if (method === 'DOM.getFrameOwner') {
            return { backendNodeId: frameId };
        }
        if (method === 'DOM.resolveNode') {
            return { object: { objectId: 'fixture-owner' } };
        }
        if (method === 'Runtime.callFunctionOn' && params.objectId === 'fixture-owner') {
            acknowledged = recordDomFrameProbe(
                { token: params.arguments[0].value, index: 0 },
                { tab, frameId, documentId: documentId() }
            ).accepted;
            return { result: { objectId: 'fixture-probe' } };
        }
        if (method === 'Runtime.awaitPromise' && params.promiseObjectId === 'fixture-probe') {
            return { result: { value: acknowledged } };
        }
        if (method === 'Runtime.callFunctionOn' && params.objectId === 'fixture-probe') {
            return {};
        }
        if (method === 'Runtime.releaseObject' && ['fixture-owner', 'fixture-probe'].includes(params.objectId)) {
            return {};
        }
        return sendCommand(target, method, params);
    };
}

test('CH-12 fallback console retention remains bounded with monotonic sequences', () => {
    const manager = new LogManager();
    try {
        for (let batch = 0; batch < 4; ++batch) {
            manager.setConsole(41, [
                ...manager.getConsole(41),
                ...Array.from({ length: 1000 }, (_, i) => ({
                    level: 'log',
                    text: String(batch * 1000 + i),
                    timestamp: batch * 1000 + i,
                })),
            ]);
            assert.equal(manager.getConsole(41).length, 1000);
        }
        assert.equal(manager.getConsole(41).at(-1).sequence, 4000);
        manager.setConsole(41, []);
        assert.equal(manager.getConsole(41).length, 0);
    } finally {
        manager.cleanupTab(41);
        globalThis.clearInterval(manager.sweepTimer);
    }
});

test('F038 nested control names survive depth boundaries without hidden text or password reads', () => {
    function element(tag, children = [], attributes = {}, style = {}) {
        return {
            nodeType: 1,
            tagName: tag.toUpperCase(),
            ...(tag === 'input' ? { type: attributes.type ?? 'text' } : {}),
            id: '',
            childNodes: children,
            children: children.filter((child) => child.nodeType === 1),
            offsetWidth: 100,
            offsetHeight: 20,
            getRootNode: () => globalThis.document,
            getAttribute: (name) => attributes[name] ?? null,
            hasAttribute: (name) => Object.hasOwn(attributes, name),
            getBoundingClientRect: () => ({
                x: 0,
                y: 0,
                top: 0,
                left: 0,
                right: 100,
                bottom: 20,
                width: 100,
                height: 20,
            }),
            contains: () => false,
            style,
        };
    }
    const text = (value) => ({ nodeType: 3, textContent: value });
    for (const label of ['确认', '取消']) {
        const password = element('input', [], { type: 'password' });
        Object.defineProperty(password, 'value', { get: () => assert.fail('password value must not be read') });
        const button = element('button', [
            element('span', [text(label[0]), element('span', [text(label[1])])]),
            element('span', [text('aria-secret')], { 'aria-hidden': 'true' }),
            element('span', [text('css-secret')], {}, { display: 'none' }),
            element('script', [text('script-secret')]),
            password,
        ]);
        const restore = installGlobals({
            document: { body: button, querySelector: () => null, elementFromPoint: () => null },
            window: {
                innerWidth: 800,
                innerHeight: 600,
                getComputedStyle: (node) => ({ display: 'block', visibility: 'visible', opacity: '1', ...node.style }),
            },
            Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
            CSS: { escape: (value) => value },
        });
        try {
            for (const filter of ['all', 'interactive']) {
                const result = generateAccessibilityTree(filter, 0, null, null);
                assert.equal(result.interactiveElements[0].name, label);
                assert.match(result.pageContent, new RegExp(label));
                assert.doesNotMatch(result.pageContent, /secret/);
            }
            let nestedLabel = text(label);
            for (let depth = 0; depth < 6000; ++depth) {
                nestedLabel = element('span', [nestedLabel]);
            }
            button.childNodes[0] = nestedLabel;
            button.children[0] = nestedLabel;
            for (const filter of ['all', 'interactive']) {
                const result = generateAccessibilityTree(filter, 0, null, null);
                assert.equal(result.interactiveElements[0].name, label, '6000 nested spans');
                assert.doesNotMatch(result.pageContent, /secret/);
            }
            let branch = button;
            for (let depth = 0; depth < 6000; ++depth) {
                branch = element('span', [branch]);
            }
            globalThis.document.body = element('div', [branch]);
            const deepState = generateAccessibilityTree('interactive', 1, null, null);
            assert.equal(
                deepState.interactiveElements.length,
                2,
                'control and password metadata below 6000 excluded wrappers'
            );
            assert.equal(deepState.interactiveElements[0].name, label);
            assert.equal(deepState.interactiveElements[1].value, undefined);
            assert.doesNotMatch(deepState.pageContent, /secret/);
            globalThis.document.body = button;
            button.getAttribute = (name) => (name === 'aria-label' ? 'ARIA name' : null);
            assert.equal(generateAccessibilityTree('all', 0, null, null).interactiveElements[0].name, 'ARIA name');
            button.getAttribute = () => null;
            button.id = 'named';
            button.labels = [element('label', [text('Label name')])];
            globalThis.document.querySelector = () => button.labels[0];
            assert.equal(generateAccessibilityTree('all', 0, null, null).interactiveElements[0].name, 'Label name');
        } finally {
            restore();
        }
    }
});

test('F074 dispatch_input requires an action result while null and void helpers remain valid', async () => {
    const tab = { id: 9874, url: 'https://example.com/owned' };
    let results;
    let executions = 0;
    const restore = installGlobals({
        chrome: {
            tabs: { get: async () => tab },
            webNavigation: { getFrame: async () => ({ documentId: 'owned-document-9874' }) },
            storage: createStorage(),
            scripting: {
                executeScript: async () => {
                    ++executions;
                    return results;
                },
            },
        },
    });
    try {
        await markManagedTab(tab.id);
        const handler = new ContentHandler({});
        for (results of [
            [],
            [{ result: null }],
            [{ result: undefined }],
            [{ result: {} }],
            [{ result: { success: 'true' } }],
        ]) {
            const before = executions;
            await assert.rejects(
                () =>
                    handler.dispatchInputAction(
                        { tabId: tab.id, refId: 'ref_1', text: 'owned' },
                        createActionContext()
                    ),
                (error) => {
                    const body = JSON.parse(error.message).error;
                    assert.ok(['FRAME_SCRIPT_NO_RESULT', 'ACTION_RESULT_INVALID'].includes(body.code));
                    assert.equal(body.context.actionStatus, 'unknown');
                    assert.equal(body.context.actionExecuted, 'unknown');
                    assert.equal(body.context.retryable, false);
                    return true;
                }
            );
            assert.equal(executions, before + 1);
        }
        for (const result of [{ success: true }, { success: false, error: 'Element not found' }]) {
            results = [{ result }];
            assert.deepEqual(
                await handler.dispatchInputAction(
                    { tabId: tab.id, refId: 'ref_1', text: 'owned' },
                    createActionContext()
                ),
                result
            );
        }
        for (const result of [null, undefined]) {
            results = [{ result }];
            assert.equal(await handler.injectScript(tab.id, 0, () => undefined, []), result);
        }
    } finally {
        await unmarkManagedTab(tab.id);
        restore();
    }
});

test('CH-13 controlled contenteditable replaces text without invoking a form value setter', () => {
    const events = [];
    let setterCalls = 0;
    class Input {
        namespaceURI = 'http://www.w3.org/1999/xhtml';
        localName = 'input';
        matches() {
            return false;
        }

        set value(value) {
            ++setterCalls;
            if (!(this instanceof Input)) {
                throw new TypeError('Illegal invocation');
            }
            this.stored = value;
        }
    }
    const editable = {
        isContentEditable: true,
        textContent: 'old',
        matches() {
            return false;
        },
        focus() {},
        dispatchEvent(event) {
            events.push(event.type);
        },
    };
    const restore = installGlobals({
        HTMLInputElement: Input,
        HTMLTextAreaElement: Input,
        window: { __mcpElementMap: { edit: { deref: () => editable } } },
    });
    try {
        assert.equal(dispatchInputToElement('edit', 'combined text').success, true);
        assert.equal(editable.textContent, 'combined text');
        assert.equal(setterCalls, 0);
        assert.deepEqual(events, ['input', 'change']);
        const input = new Input();
        input.focus = () => {};
        input.dispatchEvent = (event) => events.push(event.type);
        globalThis.window.__mcpElementMap.field = { deref: () => input };
        assert.equal(dispatchInputToElement('field', 'native value').success, true);
        assert.equal(input.stored, 'native value');
        assert.equal(setterCalls, 1);
        assert.deepEqual(events, ['input', 'change', 'input', 'change']);
    } finally {
        restore();
    }
});

test('I025 controlled input validates editable targets before focus or input events', () => {
    let writes = 0;
    let focuses = 0;
    const events = [];
    class Control {
        namespaceURI = 'http://www.w3.org/1999/xhtml';
        localName = 'div';
        disabled = false;
        fieldsetDisabled = false;
        firstLegend = false;
        readOnly = false;
        type = 'text';
        isContentEditable = false;
        matches(selector) {
            return selector === ':disabled' && (this.disabled || (this.fieldsetDisabled && !this.firstLegend));
        }

        focus() {
            ++focuses;
        }

        dispatchEvent(event) {
            events.push(event.type);
        }
    }
    class Input extends Control {
        localName = 'input';
    }
    class Textarea extends Control {
        localName = 'textarea';
    }
    class Select extends Control {
        localName = 'select';
    }
    for (const [Type, tag] of [
        [Input, 'input'],
        [Textarea, 'textarea'],
        [Select, 'select'],
    ]) {
        Object.defineProperty(Type.prototype, 'value', {
            set(value) {
                assert.equal(this.localName, tag, 'Native setter must receive its own interface');
                ++writes;
                this.stored = value;
            },
        });
    }
    const restore = installGlobals({
        HTMLInputElement: Input,
        HTMLTextAreaElement: Textarea,
        HTMLSelectElement: Select,
        window: { __mcpElementMap: {} },
    });
    try {
        for (const [element, pattern] of [
            [new Control(), /input、textarea、select/],
            [Object.assign(new Input(), { disabled: true }), /disabled/],
            [Object.assign(new Textarea(), { readOnly: true }), /readonly/],
            [Object.assign(new Input(), { type: 'file' }), /upload/],
            ...[Input, Textarea, Select].map((Type) => [
                Object.assign(new Type(), { fieldsetDisabled: true }),
                /disabled/,
            ]),
            [Object.assign(new Input(), { namespaceURI: 'http://www.w3.org/2000/svg' }), /input、textarea、select/],
            [Object.assign(new Control(), { localName: 'input', type: 'file' }), /upload/],
        ]) {
            globalThis.window.__mcpElementMap.owned = { deref: () => element };
            const result = dispatchInputToElement('owned', 'private value');
            assert.equal(result.success, false);
            assert.match(result.error, pattern);
            assert.doesNotMatch(result.error, /private value/);
            assert.equal(writes, 0);
            assert.equal(focuses, 0);
            assert.deepEqual(events, []);
        }
        for (const element of [new Input(), new Textarea(), new Select()]) {
            globalThis.window.__mcpElementMap.owned = { deref: () => element };
            assert.equal(dispatchInputToElement('owned', 'accepted value').success, true);
            assert.equal(element.stored, 'accepted value');
        }
        assert.equal(writes, 3);
        assert.equal(focuses, 3);
        assert.deepEqual(events, ['input', 'change', 'input', 'change', 'input', 'change']);
        for (const Type of [Input, Textarea, Select]) {
            class Customized extends Type {}
            for (const element of [
                new Customized(),
                Object.assign(new Type(), { fieldsetDisabled: true, firstLegend: true }),
                Object.assign(new Control(), { localName: new Type().localName }),
            ]) {
                const before = { writes, focuses, events: events.length };
                globalThis.window.__mcpElementMap.owned = { deref: () => element };
                assert.equal(dispatchInputToElement('owned', 'updated').success, true);
                assert.equal(element.stored, 'updated');
                assert.equal(writes, before.writes + 1);
                assert.equal(focuses, before.focuses + 1);
                assert.deepEqual(events.slice(before.events), ['input', 'change']);
            }
        }
        const beforeMissingSetter = { writes, focuses, events: events.length };
        const field = new Input();
        globalThis.HTMLInputElement = class {};
        globalThis.window.__mcpElementMap.owned = { deref: () => field };
        const missingSetter = dispatchInputToElement('owned', 'updated');
        assert.equal(missingSetter.success, false);
        assert.match(missingSetter.error, /原生 value setter/);
        assert.equal(writes, beforeMissingSetter.writes);
        assert.equal(focuses, beforeMissingSetter.focuses);
        assert.equal(events.length, beforeMissingSetter.events);
    } finally {
        restore();
    }
});

test('CH-14 pause survives Worker restoration and reload resumes automatic connection', async () => {
    const fixture = createTabManagementFixture();
    let background = await isolatedBackground(fixture);
    await waitUntil(() => background.client.connections === 1);
    await background.message({ type: 'DISCONNECT' });
    fixture.chrome.alarms.onAlarm.emit({ name: 'mcp-keepalive' });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(background.client.connections, 1);
    background = await isolatedBackground(fixture);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(background.client.connections, 0);
    await background.message({ type: 'CONNECT' });
    assert.ok(background.client.connections >= 1);
    await background.message({ type: 'DISCONNECT' });
    delete fixture.chrome.storage.sessionValues.mcp_connection_paused;
    background = await isolatedBackground(fixture);
    await waitUntil(() => background.client.connections === 1);
});

test('CH-22 window screenshot rejects A to B to A and always releases activation listeners', async () => {
    const onActivated = chromeEvent();
    const tab = { id: 9810, windowId: 20, active: true, url: 'https://example.com/a' };
    let race = false;
    const restore = installGlobals({
        chrome: {
            tabs: {
                get: async () => tab,
                query: async () => [tab],
                onActivated,
                captureVisibleTab: async () => {
                    if (race) {
                        onActivated.emit({ windowId: 20, tabId: 9811 });
                        onActivated.emit({ windowId: 20, tabId: tab.id });
                    }
                    return 'data:image/png;base64,aGVsbG8=';
                },
            },
        },
    });
    try {
        const handler = new ContentHandler({});
        assert.equal((await handler.screenshotFallback(tab.id, {})).degraded, true);
        assert.equal(onActivated.size, 0);
        race = true;
        await assert.rejects(handler.screenshotFallback(tab.id, {}), /SCREENSHOT_TARGET_CHANGED/);
        assert.equal(onActivated.size, 0);
    } finally {
        restore();
    }
});

test('CH-03 and CH-04 cancelled queued action and expired async attach never dispatch scripts', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    const handler = new ActionHandler();
    try {
        await markManagedTab(5001);
        const gate = createDeferred();
        const first = handler.withActionLocks([5001], () => gate.promise);
        let executions = 0;
        handler.actions.set('evaluate', async () => {
            ++executions;
            return {};
        });
        const controller = new globalThis.AbortController();
        const queued = handler.execute('evaluate', { tabId: 5001 }, createActionContext({ signal: controller.signal }));
        controller.abort();
        await assert.rejects(queued, /REQUEST_CANCELLED/);
        gate.resolve();
        await first;
        assert.equal(executions, 0);
        const attaching = createDeferred();
        const debuggerHandler = new DebuggerHandler({ ensureAttached: () => attaching.promise }, {});
        const signal = new globalThis.AbortController();
        const operation = debuggerHandler.debuggerSend(
            { tabId: 5001, method: 'Runtime.evaluate', params: { expression: 'effect()' } },
            createActionContext({ signal: signal.signal })
        );
        signal.abort();
        attaching.resolve();
        await assert.rejects(operation, /REQUEST_CANCELLED/);
    } finally {
        globalThis.clearInterval(handler.logManager.sweepTimer);
        await unmarkManagedTab(5001);
        restore();
    }
});

test('CH-23 precise touch uses one document and local coordinates through start move end cancel', async () => {
    const tab = { id: 9812, url: 'https://example.com/owned' };
    const injected = [];
    let documentId = 'document-seven';
    const target = { dispatchEvent: (event) => injected.push(event) };
    const restore = installGlobals({
        Touch: class {
            constructor(values) {
                Object.assign(this, values);
            }
        },
        TouchEvent: class {
            constructor(type, values) {
                Object.assign(this, values);
                this.type = type;
            }
        },
        window: {},
        document: {
            elementFromPoint: (x, y) => {
                assert.ok(x < 100 && y < 100);
                return target;
            },
        },
        chrome: {
            storage: createStorage(),
            tabs: { get: async () => tab },
            webNavigation: { getFrame: async () => ({ frameId: 7, documentId }) },
            scripting: {
                executeScript: async (request) => {
                    assert.deepEqual(request.target.documentIds, ['document-seven']);
                    return [{ frameId: 7, documentId, result: request.func(...request.args) }];
                },
            },
        },
    });
    try {
        await markManagedTab(tab.id);
        const handler = new InputEventHandler({});
        const event = (type, points = []) =>
            handler.inputTouch(
                { tabId: tab.id, frameId: 7, documentId: 'document-seven', type, touchPoints: points },
                createActionContext()
            );
        await event('touchStart', [{ x: 20, y: 30 }]);
        await event('touchMove', [{ x: 25, y: 35 }]);
        await event('touchEnd');
        await event('touchStart', [{ x: 20, y: 30 }]);
        await event('touchCancel');
        assert.deepEqual(
            injected.map((event) => event.type),
            ['touchstart', 'touchmove', 'touchend', 'touchstart', 'touchcancel']
        );
        assert.equal(globalThis.window.__mcpLastTouchState, undefined);
        documentId = 'replacement';
        await assert.rejects(event('touchStart', [{ x: 20, y: 30 }]), /document changed/);
    } finally {
        await unmarkManagedTab(tab.id);
        restore();
    }
});

test('CH-16 strict client authenticates every payload and rejects raw injection, reflection and replay', async () => {
    FakeWebSocket.instances = [];
    const token = 'owned-synthetic-token';
    const instanceId = 'a'.repeat(32);
    const port = 19222;
    const hmac = async (key, payload) => {
        const encoder = new globalThis.TextEncoder();
        const imported = await globalThis.crypto.subtle.importKey(
            'raw',
            encoder.encode(key),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        return Array.from(
            new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', imported, encoder.encode(payload))),
            (byte) => byte.toString(16).padStart(2, '0')
        ).join('');
    };
    const restore = installGlobals({
        WebSocket: FakeWebSocket,
        chrome: {
            storage: createStorage({ mcp_pairing_token: token, mcp_allow_insecure_no_token_v2: false }),
            runtime: {
                getURL: (path) => `chrome-extension://fixture/${path}`,
                getManifest: () => ({ version: '3.0.1' }),
            },
        },
        fetch: async (url) => {
            const parsed = new globalThis.URL(url);
            if (parsed.port !== String(port)) {
                return { ok: false, status: 404 };
            }
            const clientNonce = parsed.searchParams.get('clientNonce');
            const serverNonce = 'b'.repeat(32);
            return {
                ok: true,
                json: async () => ({
                    status: 'ok',
                    port,
                    instanceId,
                    authRequired: true,
                    auth: {
                        protocol: 2,
                        clientNonce,
                        serverNonce,
                        serverProof: await hmac(
                            token,
                            JSON.stringify([
                                'mcp-chrome',
                                2,
                                'server-proof',
                                clientNonce,
                                serverNonce,
                                instanceId,
                                port,
                            ])
                        ),
                    },
                }),
            };
        },
    });
    try {
        for (const invalid of ['raw', 'reflection', 'replay']) {
            const client = new HttpClient();
            let calls = 0;
            client.onMessage((_message, _port, signal, reply) => {
                assert.equal(signal.aborted, false);
                ++calls;
                reply(true, 'confirmed');
            });
            const connecting = client.connect();
            await waitUntil(() => FakeWebSocket.instances.length > 0);
            const ws = FakeWebSocket.instances.at(-1);
            ws.open();
            assert.equal(client.isConnected(), false);
            const auth = client.verifiedAuth.get(port);
            const frame = async (seq, message, reflect = false) => {
                const payload = JSON.stringify(message);
                const mac = await hmac(
                    reflect ? auth.sendKey : auth.receiveKey,
                    JSON.stringify([2, auth.session, reflect ? 'extension' : 'server', seq, payload])
                );
                return JSON.stringify({ v: 2, session: auth.session, seq, payload, mac });
            };
            if (invalid === 'raw') {
                ws.onmessage({ data: JSON.stringify({ id: 'injected', action: 'evaluate', params: {} }) });
                await connecting;
                assert.equal(calls, 0);
                assert.equal(client.isConnected(), false);
            } else {
                ws.onmessage({ data: await frame(1, { type: 'ready' }) });
                assert.equal((await connecting).connected, 1);
                const command = await frame(2, { id: 'owned-request', action: 'evaluate', params: {} });
                ws.onmessage({ data: command });
                await waitUntil(() => calls === 1 && ws.sent.length >= 2);
                const response = JSON.parse(ws.sent.at(-1));
                assert.equal(JSON.parse(response.payload).data, 'confirmed');
                assert.equal(
                    response.mac,
                    await hmac(
                        auth.sendKey,
                        JSON.stringify([2, auth.session, 'extension', response.seq, response.payload])
                    )
                );
                ws.onmessage({
                    data:
                        invalid === 'replay'
                            ? command
                            : await frame(3, { id: 'injected', action: 'evaluate', params: {} }, true),
                });
                await waitUntil(() => ws.readyState === FakeWebSocket.CLOSED);
                assert.equal(calls, 1);
            }
            client.disconnect();
            FakeWebSocket.instances = [];
        }
    } finally {
        restore();
    }
});

test('CH-16 cancellation and late replies remain owned by the original socket', async () => {
    const restore = installGlobals({ WebSocket: FakeWebSocket });
    const client = new HttpClient();
    const old = new FakeWebSocket('ws://fixture/old');
    old.readyState = FakeWebSocket.OPEN;
    const replacement = new FakeWebSocket('ws://fixture/new');
    replacement.readyState = FakeWebSocket.OPEN;
    const connection = (ws) => ({
        ws,
        ready: true,
        heartbeatTimer: null,
        requests: new Map(),
        sendChain: Promise.resolve(),
    });
    const source = connection(old);
    client.connections.set(19222, source);
    let reply;
    let signal;
    const done = createDeferred();
    client.onMessage(async (_message, _port, requestSignal, respond) => {
        signal = requestSignal;
        reply = respond;
        await done.promise;
    });
    try {
        client.handleMessage(JSON.stringify({ id: 'owned', action: 'evaluate', params: {} }), 19222, source);
        await waitUntil(() => reply !== undefined);
        client.handleMessage(JSON.stringify({ type: 'cancel', id: 'owned' }), 19222, source);
        assert.equal(signal.aborted, true);
        client.connections.set(19222, connection(replacement));
        reply(true, 'old result');
        done.resolve();
        assert.equal(replacement.sent.length, 0);
    } finally {
        done.resolve();
        client.disconnect();
        restore();
    }
});

test('CH-21 unique URL remapping still verifies the native owner before script dispatch', async () => {
    const tab = { id: 9813, url: 'https://example.com/owned' };
    let evaluations = 0;
    let ownerProbes = 0;
    const restore = installGlobals({
        chrome: {
            storage: createStorage(),
            tabs: { get: async () => tab },
            scripting: { executeScript: async () => [] },
            webNavigation: {
                getAllFrames: async () => [
                    { frameId: 0, parentFrameId: -1, documentId: 'root-document', url: tab.url },
                    { frameId: 7, parentFrameId: 0, documentId: 'document-a', url: 'https://example.com/old' },
                ],
            },
            debugger: {
                sendCommand: async (_target, method) => {
                    if (method === 'Page.getFrameTree') {
                        return {
                            frameTree: {
                                frame: { id: 'root', url: tab.url },
                                childFrames: [{ frame: { id: 'other-b', url: 'https://example.com/old' } }],
                            },
                        };
                    }
                    if (method === 'DOM.getFrameOwner') {
                        ++ownerProbes;
                        return { backendNodeId: 8 };
                    }
                    if (method === 'DOM.resolveNode') {
                        return { object: { objectId: 'other-owner' } };
                    }
                    if (method === 'Runtime.callFunctionOn') {
                        return { result: { value: false } };
                    }
                    if (method === 'Runtime.releaseObject') {
                        return {};
                    }
                    if (method === 'Runtime.evaluate') {
                        ++evaluations;
                    }
                    return {};
                },
            },
        },
    });
    try {
        await markManagedTab(tab.id);
        const resolver = new FrameResolver({
            ensureAttached: async () => {},
            getFrameSessions: async () => [{ tabId: tab.id }],
            getExecutionContexts: () => [{ frameId: 'other-b', id: 202, isDefault: true }],
        });
        await assert.rejects(
            resolver.evaluateInFrame({ tabId: tab.id, frameId: 7, expression: 'effect()' }, createActionContext()),
            /FRAME_IDENTITY_CHANGED/
        );
        assert.equal(ownerProbes, 1);
        assert.equal(evaluations, 0);
    } finally {
        await unmarkManagedTab(tab.id);
        restore();
    }
});

test('TASK native task groups outrank other owned windows and no normal window never creates one', async () => {
    const fixture = createTabManagementFixture();
    const getAll = fixture.chrome.windows.getAll;
    const restore = installGlobals({ chrome: fixture.chrome });
    try {
        fixture.chrome.windows.getAll = async () => (await getAll()).reverse();
        const handler = new TabHandler({});
        const first = await handler.tabsCreate({ taskHint: 'Existing task' }, createActionContext());
        assert.equal(first.windowId, 20);
        await handler.tabsCreate({ windowId: 10, taskHint: 'Other task' }, createActionContext());
        fixture.chrome.windows.getAll = getAll;
        const second = await handler.tabsCreate({ taskHint: 'Existing task' }, createActionContext());
        assert.equal(second.windowId, first.windowId);
        assert.equal(second.groupId, first.groupId);
        fixture.chrome.windows.getAll = async () => [];
        const count = fixture.calls.length;
        await assert.rejects(() => handler.tabsCreate({}, createActionContext()), /没有可用的普通/);
        assert.equal(fixture.calls.length, count);
    } finally {
        for (const id of [6000, 6001, 6002]) {
            await unmarkManagedTab(id);
        }
        restore();
    }
});
