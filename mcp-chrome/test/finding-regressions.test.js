import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import { AutoWait } from '../dist/core/auto-wait.js';
import { Locator } from '../dist/core/locator.js';
import { deflateSync } from 'node:zlib';

import { CDPClient, getBrowserWSEndpoint } from '../dist/cdp/client.js';
import { BrowserLauncher, windowsChromeCandidates } from '../dist/cdp/launcher.js';
import {
    CDPError,
    ElementNotFoundError,
    formatErrorResponse,
    getErrorPageContext,
    getErrorSource,
    PagePreconditionError,
    setErrorSource,
    StructuredToolError,
    TargetNotFoundError,
    TimeoutError,
} from '../dist/core/errors.js';
import { getSession } from '../dist/core/session.js';
import { EvaluateResultTooLargeError, formatCdpException } from '../dist/core/types.js';
import { getUnifiedSession } from '../dist/core/unified-session.js';
import {
    getControlledTempRoot,
    resolveScopedInputPath,
    resolveScopedOutputPath,
    waitForNavigationQueue,
    withNavigationBudget,
    writePrivateFile,
} from '../dist/core/utils.js';
import { ExtensionBridge } from '../dist/extension/bridge.js';
import { ExtensionHttpServer } from '../dist/extension/http-server.js';
import { withPageContext, withPageResponse } from '../dist/tools/page-context.js';
import { registerBrowseTool } from '../dist/tools/browse.js';
import { CHALLENGE_INSPECT_SCRIPT, readChallengeSnapshot, waitForChallenge } from '../dist/tools/challenge.js';
import { registerManageTool } from '../dist/tools/manage.js';
import { classifyEvaluateFailure, registerEvaluateTool } from '../dist/tools/evaluate.js';
import { registerCookiesTool } from '../dist/tools/cookies.js';
import { registerExtractTool } from '../dist/tools/extract.js';
import { registerInputTool } from '../dist/tools/input.js';
import { registerWaitTool } from '../dist/tools/wait.js';
import {
    assertPngFileBudget,
    assertScreenshotBase64Budget,
    assertScreenshotBudget,
    comparePngImages,
    MAX_COMPARE_PNG_BYTES,
} from '../dist/tools/png.js';
import { resolvePageTargetId } from '../dist/tools/schema.js';
import { waitForPostCondition } from '../dist/tools/post-condition.js';
import { startDiagnostics } from '../dist/tools/diagnostics.js';
import { McpClient } from './helpers.js';

const execFileAsync = promisify(execFile);
let ordinaryPageFixture = false;

function patchProperties(object, values) {
    if (
        ordinaryPageFixture &&
        typeof values.evaluate === 'function' &&
        !values.inspectChallenge &&
        (object === getUnifiedSession() || object === getSession())
    ) {
        const evaluate = values.evaluate;
        values = {
            ...values,
            evaluate: function (script, ...args) {
                if (script === CHALLENGE_INSPECT_SCRIPT) {
                    return Promise.resolve({ title: 'Owned page', inspected: true });
                }
                const action =
                    object === getUnifiedSession() && args[3]?.userAction
                        ? object.tabLockContext.getStore()?.userAction
                        : undefined;
                if (action) {
                    action.dispatched = true;
                }
                return evaluate.call(this, script, ...args);
            },
        };
    }
    if (ordinaryPageFixture) {
        for (const name of ['keyDown', 'keyUp', 'inputKey']) {
            if (typeof values[name] !== 'function') {
                continue;
            }
            const input = values[name];
            values = {
                ...values,
                [name]: function (...args) {
                    const action = getUnifiedSession().tabLockContext.getStore()?.userAction;
                    if (action?.kind === 'input') {
                        action.dispatched = true;
                    }
                    return input.apply(this, args);
                },
            };
        }
    }
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

function registeredTool(register) {
    let handler;
    let schema;
    register({
        registerTool(_name, options, callback) {
            handler = callback;
            schema = options.inputSchema;
        },
    });
    return (args, extra) => handler(schema.parse(args), extra);
}

test('F032 authoritative tab and topology lists clear only missing defaults before browse filters', async () => {
    await withPageFixture('extension', async ({ unified }) => {
        const bridge = new ExtensionBridge();
        let tabs = [
            { id: 101, url: 'https://example.com/default', title: 'Default', managed: false },
            { id: 202, url: 'https://example.com/owned', title: 'Owned', managed: true },
        ];
        bridge.httpServer.sendCommand = async (action) => {
            if (action === 'tabs_list') {
                return tabs;
            }
            assert.equal(action, 'tabs_topology');
            return { windows: [{ id: 1, tabs }], groups: [], windowCount: 1 };
        };
        const restore = patchProperties(unified, {
            extensionBridge: bridge,
            getDriver: async () => bridge,
            listTopology: () => bridge.listWindows(),
        });
        try {
            const browse = registeredTool(registerBrowseTool);
            for (const filter of [{ targetIds: ['202'] }, { managedOnly: true }]) {
                bridge.setCurrentTargetId('101');
                const body = JSON.parse((await browse({ action: 'list', ...filter })).content[0].text);
                assert.equal(body.defaultTargetId, '101');
                assert.equal(body.targets.length, 1);
            }
            tabs = tabs.filter((tab) => tab.id === 202);
            for (const list of [() => bridge.listTabs(), () => bridge.listWindows()]) {
                bridge.setCurrentTargetId('101');
                await list();
                assert.equal(bridge.getCurrentTargetId(), null);
                assert.equal(bridge.getState(), null);
            }
            bridge.setCurrentTargetId('101');
            const body = JSON.parse((await browse({ action: 'list' })).content[0].text);
            assert.equal(body.defaultTargetId, null);
            assert.equal(body.targets[0].targetId, '202');
        } finally {
            restore();
        }
    });
});

test('F032 pending lists preserve a newly selected default absent from the older snapshot', async () => {
    for (const method of ['listTabs', 'listWindows']) {
        const bridge = new ExtensionBridge();
        bridge.setCurrentTargetId('101');
        bridge.httpServer.sendCommand = async () => {
            bridge.setCurrentTargetId('303');
            const tabs = [{ id: 101, url: 'https://example.com/old' }];
            return method === 'listTabs' ? tabs : { windows: [{ id: 1, tabs }] };
        };
        await bridge[method]();
        assert.equal(bridge.getCurrentTargetId(), '303');
    }
});

test('F041 public extract state shares one deadline through frame read_page and metadata RPCs', async () => {
    await withPageFixture('extension', async ({ unified }) => {
        const bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() });
        bridge.setCurrentTargetId('101');
        const calls = [];
        const tab = { id: 101, url: 'https://example.com/owned', title: 'Owned' };
        const server = bridge.httpServer;
        server.clientSocket = { readyState: 1 };
        const restoreServer = patchProperties(server, {
            isConnected: () => true,
            sendMessage(_socket, message) {
                if (message.type === 'cancel') {
                    return;
                }
                calls.push(message);
                const results = {
                    page_snapshot: { targetId: '101', url: tab.url, revision: 'r1' },
                    tabs_list: [tab],
                    tabs_topology: { windows: [{ id: 1, tabs: [tab] }], groups: [], activeTargetId: '101' },
                    resolve_frame: { frameId: 3, offset: null },
                    find: [
                        { refId: 'ref_1', tag: 'button', text: '确认', rect: { x: 0, y: 0, width: 100, height: 20 } },
                    ],
                    read_page: { pageContent: 'button "确认"', viewport: { width: 800, height: 600 } },
                    get_metadata: { url: tab.url, title: tab.title },
                    get_all_frames: { frames: [] },
                };
                assert.ok(Object.hasOwn(results, message.action), message.action);
                const handler = server.messageHandlers.get(message.id);
                server.messageHandlers.delete(message.id);
                handler.cleanup();
                handler.resolve(results[message.action]);
            },
        });
        const restore = patchProperties(unified, {
            extensionBridge: bridge,
            getDriver: async () => bridge,
            listTopology: () => bridge.listWindows(),
        });
        try {
            const started = Date.now();
            const response = await registeredTool(registerExtractTool)({
                type: 'state',
                target: { css: 'button' },
                frame: 0,
                depth: 0,
                timeout: 15000,
            });
            assert.equal(response.isError, undefined, response.content[0].text);
            assert.ok(calls.some((call) => call.action === 'resolve_frame'));
            assert.ok(calls.some((call) => call.action === 'read_page' && call.params.frameId === 3));
            assert.ok(calls.some((call) => call.action === 'tabs_topology'));
            const deadlines = calls.map((call) => call.params.deadline);
            assert.equal(new Set(deadlines).size, 1);
            assert.ok(deadlines[0] >= started + 15000 && deadlines[0] <= Date.now() + 15000);
            assert.equal(bridge.getCurrentFrameId(), 0);
            calls.length = 0;
            const metadata = await registeredTool(registerExtractTool)({ type: 'metadata', timeout: 15000 });
            assert.equal(metadata.isError, undefined, metadata.content[0].text);
            assert.ok(calls.some((call) => call.action === 'get_metadata'));
            assert.ok(calls.some((call) => call.action === 'get_all_frames'));
            assert.equal(new Set(calls.map((call) => call.params.deadline)).size, 1);
            calls.length = 0;
            const expired = await registeredTool(registerExtractTool)({ type: 'state', timeout: 0 });
            assert.equal(expired.isError, true);
            assert.equal(calls.length, 0);
        } finally {
            restore();
            restoreServer();
        }
    });
});

test('F041 extract read_page timeout and unknown target waits never replay dispatched reads', async () => {
    await withPageFixture('extension', async ({ unified, driver }) => {
        const bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() });
        bridge.setCurrentTargetId('101');
        const server = bridge.httpServer;
        server.clientSocket = { readyState: 1 };
        let dispatched = 0;
        const restoreServer = patchProperties(server, {
            isConnected: () => true,
            sendMessage(_socket, message) {
                if (message.action === 'read_page') {
                    ++dispatched;
                }
            },
        });
        const restore = patchProperties(driver, { readPage: (options) => bridge.readPage(options) });
        try {
            const started = performance.now();
            const response = await registeredTool(registerExtractTool)({ type: 'state', timeout: 50 });
            const body = JSON.parse(response.content[0].text);
            assert.equal(response.isError, true);
            assert.equal(body.error.context.actionStatus, 'unknown');
            assert.equal(body.error.context.retryable, false);
            assert.equal(dispatched, 1);
            assert.ok(performance.now() - started < 1000);
            assert.equal(server.messageHandlers.size, 0);
        } finally {
            restore();
            restoreServer();
        }
        let finds = 0;
        const restoreFind = patchProperties(unified, {
            find: async () => {
                ++finds;
                throw new StructuredToolError(
                    'EXECUTION_RESULT_UNKNOWN',
                    'Request timeout for action: find',
                    'Read independently',
                    {
                        actionStatus: 'unknown',
                        actionExecuted: 'unknown',
                        retryable: false,
                    }
                );
            },
        });
        try {
            const response = await registeredTool(registerExtractTool)({
                type: 'state',
                target: { css: 'button' },
                timeout: 100,
            });
            assert.equal(JSON.parse(response.content[0].text).error.context.actionStatus, 'unknown');
            assert.equal(finds, 1);
        } finally {
            restoreFind();
        }
    });
});

test('F074 controlled input validates old Extension action results and reports unknown without replay', async () => {
    await withPageFixture('extension', async ({ unified, driver }) => {
        const bridge = new ExtensionBridge();
        bridge.setCurrentTargetId('101');
        let result;
        let dispatched = 0;
        bridge.httpServer.sendCommand = async (action) => {
            assert.equal(action, 'dispatch_input');
            unified.tabLockContext.getStore().userAction.dispatched = true;
            ++dispatched;
            return result;
        };
        const restore = patchProperties(driver, {
            getConnectionInfo: () => ({}),
            getChallengeState: async () => null,
            find: async () => [{ refId: 'ref_1' }],
            dispatchInput: (refId, text) => bridge.dispatchInput(refId, text),
        });
        const restoreChallenge = patchProperties(unified, {
            inspectChallenge: async () => ({ title: 'Owned', inspected: true }),
        });
        try {
            const input = registeredTool(registerInputTool);
            for (result of [null, undefined, {}, { success: null }, { success: 'true' }]) {
                const before = dispatched;
                const response = await input({
                    events: [{ type: 'type', mode: 'controlled', target: { css: '#editor' }, text: 'two\nlines' }],
                });
                const body = JSON.parse(response.content[0].text);
                assert.equal(body.error.code, 'ACTION_RESULT_INVALID', response.content[0].text);
                assert.equal(body.actionStatus, 'unknown');
                assert.equal(body.retryable, false);
                assert.equal(dispatched, before + 1);
                assert.doesNotMatch(response.content[0].text, /TypeError|two\\nlines/);
            }
            result = { success: true };
            const response = await input({
                events: [{ type: 'type', mode: 'controlled', target: { css: '#editor' }, text: 'ok' }],
            });
            assert.equal(response.isError, undefined, response.content[0].text);
        } finally {
            restoreChallenge();
            restore();
        }
    });
});

async function withPageFixture(mode, run) {
    const unified = getUnifiedSession();
    const cdp = getSession();
    const state = {
        current: '101',
        targets: new Set(['101', '202', '303']),
        actionCompleted: false,
        restoreFailure: null,
        listFailed: false,
        dispatched: [],
    };
    const fixtureMetadata = new Map();
    const driver = {
        async setPageMetadata(targetId, updates) {
            const metadata = { ...unified.getPageMetadata(targetId), ...fixtureMetadata.get(targetId) };
            for (const field of ['taskHint', 'note']) {
                if (updates[field] === null) {
                    delete metadata[field];
                } else if (updates[field] !== undefined) {
                    metadata[field] = updates[field];
                }
            }
            fixtureMetadata.set(targetId, metadata);
            return metadata;
        },
        isConnected: () => true,
        getState: () => ({
            url: `https://example.com/${state.current}`,
            title: 'Owned page',
            managed: mode === 'extension',
        }),
        getCurrentTargetId: () => state.current,
        getCurrentFrameId: () => 0,
        setCurrentFrameId() {},
        getCurrentFrameDocumentId: () => undefined,
        setCurrentTargetId: (id) => {
            state.current = id;
        },
        async listTargets() {
            if (state.actionCompleted && state.restoreFailure === 'list' && !state.listFailed) {
                state.listFailed = true;
                throw new TimeoutError('restoration list timeout');
            }
            return [...state.targets].map((targetId) => ({ targetId }));
        },
        async selectPage(id) {
            if (id === '101' && state.actionCompleted && state.restoreFailure === 'select') {
                throw new TimeoutError('restoration select timeout');
            }
            if (!state.targets.has(id)) {
                throw new TargetNotFoundError(id);
            }
            state.current = id;
        },
        async deselectPage() {
            state.current = null;
        },
        async getPageSnapshot(targetId) {
            if (!state.targets.has(targetId)) {
                throw new TargetNotFoundError(targetId);
            }
            return { targetId, url: `https://example.com/${targetId}`, revision: `r${targetId}` };
        },
        setPageCondition() {},
        checkActionability: async () => ({ success: true }),
        createLocator(target, options) {
            return new Locator(
                { send: async () => assert.fail('fixture has no element DOM') },
                target,
                'fixture-session',
                options
            );
        },
        acquireKeyboardFocus: async () => ({ changed: false }),
        releaseKeyboardFocus: async () => ({ restored: true, errors: [] }),
        async inputKey(type) {
            const action = unified.tabLockContext.getStore()?.userAction;
            if (action?.kind === 'input') {
                action.dispatched = true;
            }
            state.dispatched.push({ type, targetId: state.current });
            state.actionCompleted = true;
        },
        async adoptPage(id) {
            state.current = id;
            return { success: true, targetId: id };
        },
        async closePage(id) {
            state.targets.delete(id);
            if (state.current === id) {
                state.current = null;
            }
        },
    };
    const restoreCdp = mode === 'cdp' ? patchProperties(cdp, driver) : () => {};
    const restoreUnified = patchProperties(unified, {
        extensionBridge: mode === 'extension' ? driver : null,
        activeMode: mode,
        cdpExplicitlySelected: mode === 'cdp',
        getMode: () => mode,
        getDriver: async () => (mode === 'extension' ? driver : cdp),
        hasBrowserEventObservation: () => false,
        getChallengeState: async () => null,
        getLiveState: async () => driver.getState(),
        inspectChallenge: async () => ({ title: 'Owned page', inspected: true }),
        suspendBrowserEventsForChallenge: async () => ({ suspended: true, fetchEnabled: false, cleanupFailures: [] }),
        listTopology: async () => ({ activeTargetId: '101' }),
        pageMetadata: new Map(),
        pressedKeys: new Set(),
        modifiers: 0,
    });
    try {
        ordinaryPageFixture = true;
        return await run({ unified, driver, state });
    } finally {
        ordinaryPageFixture = false;
        restoreUnified();
        restoreCdp();
    }
}

test('CF navigation returns live metadata after verification without replaying the action', async (t) => {
    for (const mode of ['extension', 'cdp']) {
        for (const action of ['open', 'back', 'forward', 'refresh']) {
            await t.test(`${mode} ${action}`, async () => {
                await withPageFixture(mode, async ({ unified, driver, state }) => {
                    let navigations = 0;
                    const final = {
                        url: 'https://example.com/login?token=fixture-secret',
                        title: 'Business page',
                        managed: mode === 'extension',
                    };
                    const navigate = async () => {
                        ++navigations;
                        state.actionCompleted = true;
                        return { navigated: true };
                    };
                    const restoreDriver = patchProperties(mode === 'extension' ? driver : getSession(), {
                        getPageSnapshot: async (targetId) => ({
                            targetId,
                            url:
                                state.actionCompleted && targetId === '202'
                                    ? final.url
                                    : `https://example.com/${targetId}`,
                            revision: `r${targetId}`,
                        }),
                    });
                    const restore = patchProperties(unified, {
                        getState: () => ({
                            url: 'https://example.com/?__cf_chl_rt_tk=old',
                            title: 'Just a moment...',
                            managed: true,
                        }),
                        getLiveState: async () => final,
                        evaluate: async () => ({ title: final.title, inspected: true }),
                        inspectChallenge: async () => ({ title: final.title, inspected: true }),
                        navigate,
                        goBack: navigate,
                        goForward: navigate,
                        reload: navigate,
                    });
                    try {
                        const response = await registeredTool(registerBrowseTool)({
                            action,
                            targetId: '202',
                            url: 'https://example.com/start',
                            timeout: 1000,
                        });
                        const body = JSON.parse(response.content[0].text);
                        assert.equal(response.isError, undefined, response.content[0].text);
                        assert.equal(body.title, final.title);
                        assert.equal(new URL(body.url).pathname, '/login');
                        assert.equal(body.url.includes('fixture-secret'), false);
                        assert.equal(body.url, body.pageContext.after.url);
                        assert.equal(body.managed, mode === 'extension');
                        assert.equal(body.pageContext.targetId, '202');
                        assert.equal(state.current, '101');
                        assert.equal(navigations, 1);
                    } finally {
                        restore();
                        restoreDriver();
                    }
                });
            });
        }
    }
});

test('CF navigation keeps origin-response pending while returning the current page metadata', async () => {
    for (const mode of ['extension', 'cdp']) {
        await withPageFixture(mode, async ({ unified }) => {
            const live = {
                url: 'https://example.com/waiting',
                title: 'Verification completed',
                managed: mode === 'extension',
            };
            const snapshot = { ...live, originResponsePending: true, inspected: true };
            let navigations = 0;
            const restore = patchProperties(unified, {
                navigate: async () => {
                    ++navigations;
                },
                getLiveState: async () => live,
                inspectChallenge: async () => snapshot,
                evaluate: async () => snapshot,
            });
            try {
                const response = await registeredTool(registerBrowseTool)({
                    action: 'open',
                    targetId: '202',
                    url: live.url,
                    timeout: 1000,
                });
                const body = JSON.parse(response.content[0].text);
                assert.equal(response.isError, undefined, response.content[0].text);
                assert.equal(body.originResponsePending, true);
                assert.equal(body.challengeResolved, true);
                assert.equal(body.title, live.title);
                assert.equal(body.url, live.url);
                assert.equal(navigations, 1);
            } finally {
                restore();
            }
        });
    }
});

test('CF navigation preserves completed state when final metadata fails or exhausts the budget', async (t) => {
    for (const mode of ['extension', 'cdp']) {
        for (const failure of ['timeout', 'missing', 'pending']) {
            await t.test(`${mode} ${failure}`, async () => {
                await withPageFixture(mode, async ({ unified, state }) => {
                    let navigations = 0;
                    let metadataTimeout;
                    const restore = patchProperties(unified, {
                        navigate: async () => {
                            ++navigations;
                            state.actionCompleted = true;
                        },
                        getLiveState: async (timeout) => {
                            if (timeout === undefined) {
                                return { url: 'https://example.com/202', title: 'Owned page' };
                            }
                            metadataTimeout = timeout;
                            if (failure === 'timeout') {
                                throw new TimeoutError('final metadata timeout');
                            }
                            if (failure === 'missing') {
                                state.targets.delete('202');
                                return null;
                            }
                            return new Promise(() => {});
                        },
                        evaluate: async () => ({ title: 'Owned page', inspected: true }),
                    });
                    try {
                        const started = performance.now();
                        const response = await registeredTool(registerBrowseTool)({
                            action: 'open',
                            targetId: '202',
                            url: 'https://example.com/start',
                            timeout: 80,
                        });
                        const body = JSON.parse(response.content[0].text);
                        assert.equal(response.isError, true, response.content[0].text);
                        assert.equal(body.error.code, failure === 'missing' ? 'TARGET_NOT_FOUND' : 'TIMEOUT');
                        assert.equal(body.error.context.actionExecuted, true);
                        assert.equal(body.error.context.actionStatus, 'completed');
                        assert.equal(body.error.context.failureStage, 'metadata');
                        assert.equal(body.error.context.retryable, false);
                        assert.equal(body.pageContext.targetId, '202');
                        assert.ok(metadataTimeout > 0 && metadataTimeout <= 80);
                        assert.ok(performance.now() - started < 1000);
                        assert.equal(navigations, 1);
                    } finally {
                        restore();
                    }
                });
            });
        }
    }
});

test('CF navigation leaves attach and empty history on the existing cached metadata path', async () => {
    for (const mode of ['extension', 'cdp']) {
        for (const action of ['attach', 'back', 'forward']) {
            await withPageFixture(mode, async ({ unified }) => {
                const restore = patchProperties(unified, {
                    getLiveState: async () => assert.fail('no additional live state request'),
                    goBack: async () => ({ navigated: false }),
                    goForward: async () => ({ navigated: false }),
                });
                try {
                    const response = await registeredTool(registerBrowseTool)({
                        action,
                        targetId: '202',
                        timeout: 1000,
                    });
                    const body = JSON.parse(response.content[0].text);
                    assert.equal(response.isError, undefined, response.content[0].text);
                    assert.equal(body.title, 'Owned page');
                    assert.equal(body.challengeResolved, undefined);
                    if (action === 'attach') {
                        assert.equal(body.activated, false);
                    } else {
                        assert.equal(body.navigated, false);
                    }
                } finally {
                    restore();
                }
            });
        }
    }
});

test('live state forwards the remaining timeout to both backend queries', async () => {
    for (const mode of ['extension', 'cdp']) {
        await withPageFixture(mode, async ({ unified, driver, state }) => {
            const timeouts = [];
            const live = { targetId: state.current, url: 'https://example.com/live', title: 'Live', managed: true };
            const restore = patchProperties(
                mode === 'extension' ? driver : getSession(),
                mode === 'extension'
                    ? {
                          listTargets: async (timeout) => {
                              timeouts.push(timeout);
                              return [live];
                          },
                      }
                    : {
                          getLiveState: async (timeout) => {
                              timeouts.push(timeout);
                              return live;
                          },
                      }
            );
            try {
                const value = await Object.getPrototypeOf(unified).getLiveState.call(unified, 37);
                assert.equal(value.url, live.url);
                assert.deepEqual(timeouts, [37]);
            } finally {
                restore();
            }
        });
    }
});

test('QL-CH-01 indexed CDP find preserves its text semantics beyond both candidate limits', async () => {
    const session = getSession();
    const elements = Array.from({ length: 250 }, (_, index) => ({
        nodeType: 1,
        childNodes: [],
        parentElement: null,
        tagName: 'BUTTON',
        textContent: `item ${index}`,
        getAttribute: () => null,
        hasAttribute: () => false,
        matches: () => true,
        getRootNode: () => document,
        getBoundingClientRect: () => ({ x: index, y: 0, width: 10, height: 10 }),
    }));
    const document = {
        nodeType: 9,
        childNodes: elements,
        querySelector: () => elements[0],
        evaluate: () => ({ snapshotLength: elements.length, snapshotItem: (index) => elements[index] }),
    };
    const realm = createContext({
        document,
        window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
        XPathResult: { ORDERED_NODE_SNAPSHOT_TYPE: 7 },
    });
    const restore = patchProperties(session, {
        evaluate: async (source, args) => {
            realm.args = args;
            return runInContext(args === undefined ? source : `(${source})(...args)`, realm);
        },
    });
    try {
        for (const query of [['button'], [undefined, 'item'], [undefined, undefined, '//button'], ['button', 'item']]) {
            assert.equal((await session.find(...query)).length, 50);
            for (const nth of [0, 49, 50, 60, 79, 80, 210, 249, 250]) {
                const found = await session.find(query[0], query[1], query[2], 1000, nth);
                assert.equal(found.length, nth < 250 ? 1 : 0, JSON.stringify({ query, nth }));
                if (nth < 250) {
                    assert.equal(found[0].rect.x, nth);
                }
            }
        }
    } finally {
        restore();
    }
});

test('QL-CH-01 unified indexed find routes each backend without changing the Bridge point slot', async () => {
    for (const mode of ['extension', 'cdp']) {
        await withPageFixture(mode, async ({ unified, driver }) => {
            const calls = [];
            const selected = [
                { refId: 'selected', tag: 'button', text: 'item', rect: { x: 1, y: 2, width: 3, height: 4 } },
            ];
            const restore = patchProperties(mode === 'cdp' ? getSession() : driver, {
                find: async (...args) => {
                    calls.push(args);
                    return selected;
                },
            });
            try {
                for (const timeout of [undefined, 1000]) {
                    assert.equal(await unified.find('.item', 'item', undefined, timeout, 60), selected);
                    assert.deepEqual(calls.at(-1), ['.item', 'item', undefined, timeout, undefined, 60]);
                }
            } finally {
                restore();
            }
        });
    }
});

test(
    'QL-CH-01 public Extension wait resolves the selected item and never ' + 'confuses a truncated list with absence',
    async () => {
        await withPageFixture('extension', async ({ unified, driver }) => {
            let hidden = false;
            let failure;
            const requested = [];
            const restore = patchProperties(driver, {
                find: async (_selector, _text, _xpath, _timeout, _point, matchIndex) => {
                    requested.push(matchIndex);
                    if (failure) {
                        throw failure;
                    }
                    const count = matchIndex === undefined ? 50 : matchIndex < 80 ? 1 : 0;
                    return Array.from({ length: count }, (_, index) => ({
                        refId: `item-${matchIndex ?? index}`,
                        tag: 'button',
                        text: 'item',
                        rect: { x: 0, y: 0, width: hidden ? 0 : 10, height: 10 },
                    }));
                },
                getComputedStyle: async (_ref, prop) => (prop === 'display' && hidden ? 'none' : 'visible'),
            });
            const restoreUnified = patchProperties(unified, {
                getLiveState: async () => ({ url: 'https://example.com/owned', managed: true }),
                evaluate: async () => ({ candidates: [], activeElement: null }),
            });
            try {
                const wait = registeredTool(registerWaitTool);
                for (const nth of [0, 49, 50, 60, 79, 80]) {
                    for (const state of ['attached', 'visible', 'hidden', 'detached']) {
                        const response = await wait({
                            for: 'element',
                            target: { css: '.item', nth },
                            state,
                            timeout: 20,
                        });
                        const expectSuccess =
                            nth < 80 ? ['attached', 'visible'].includes(state) : ['hidden', 'detached'].includes(state);
                        assert.equal(
                            response.isError === true,
                            !expectSuccess,
                            JSON.stringify({ nth, state, response })
                        );
                        if (!expectSuccess) {
                            assert.match(response.content[0].text, /TIMEOUT|timeout/i);
                        }
                    }
                }
                assert.ok(requested.includes(79));
                hidden = true;
                assert.notEqual(
                    (await wait({ for: 'element', target: { css: '.item', nth: 60 }, state: 'hidden', timeout: 20 }))
                        .isError,
                    true
                );
                for (const message of ['Invalid CSS selector', 'Extension disconnected']) {
                    failure = new Error(message);
                    for (const state of ['hidden', 'detached']) {
                        assert.equal(
                            (await wait({ for: 'element', target: { css: '.item', nth: 60 }, state, timeout: 20 }))
                                .isError,
                            true
                        );
                    }
                }
            } finally {
                restoreUnified();
                restore();
            }
        });
    }
);

test('QL-CH-01 indexed find retains automatic Extension connection and scoped backend restrictions', async () => {
    const unified = getUnifiedSession();
    const cdp = getSession();
    let connected = false;
    let waits = 0;
    const bridge = {
        isConnected: () => connected,
        waitForConnection: async () => {
            ++waits;
            connected = true;
            return true;
        },
        find: async (...args) => {
            assert.equal(args[4], undefined);
            assert.equal(args[5], 60);
            return [];
        },
    };
    const restore = patchProperties(unified, {
        extensionBridge: bridge,
        activeMode: null,
        cdpExplicitlySelected: false,
        lastConnectionFailure: 0,
        requireExtension: false,
    });
    const restoreCdp = patchProperties(cdp, { isConnected: () => false });
    try {
        await unified.find('.item', undefined, undefined, undefined, 60);
        assert.equal(waits, 1);
        connected = false;
        unified.requireExtension = true;
        await assert.rejects(() => unified.find('.item', undefined, undefined, 10, 60), /Extension/);
        assert.equal(waits, 1, 'polling lookup must not wait for reconnection');
    } finally {
        restoreCdp();
        restore();
    }
});

test(
    'QL-CH-01 public input consumers request their selected ref and refresh the ' + 'same index after iframe scrolling',
    async () => {
        await withPageFixture('extension', async ({ unified, driver }) => {
            const lookups = [];
            const actions = [];
            const restoreDriver = patchProperties(driver, {
                find: async (_selector, _text, _xpath, _timeout, _point, nth) => {
                    lookups.push(nth);
                    assert.ok(nth === 60 || nth === 79);
                    return [
                        {
                            refId: `item-${nth}`,
                            tag: 'textarea',
                            text: 'one one',
                            rect: { x: nth, y: 20, width: 10, height: 10 },
                        },
                    ];
                },
                dispatchInput: async (refId) => {
                    actions.push(['controlled', refId]);
                    return { success: true };
                },
                dragAndDrop: async (source, destination) => {
                    actions.push(['drag', source, destination]);
                    return { success: true };
                },
                scrollAt: async (_x, _y, refId) => {
                    actions.push(['wheel', refId]);
                },
            });
            const restoreUnified = patchProperties(unified, {
                getLiveState: async () => ({ url: 'https://example.com/owned', managed: true }),
                getChallengeState: async () => null,
                inspectChallenge: async () => ({ title: 'Owned ordinary page', inspected: true }),
                withFrame: async (_frame, action) => action(),
                getFrameOffset: () => ({ x: 5, y: 10 }),
                mouseMove: async (x, y) => {
                    actions.push(['move', x, y]);
                },
                getInputMode: () => 'precise',
                actionableClick: async (refId) => {
                    actions.push(['focus', refId]);
                    return { success: true };
                },
                evaluate: async (source, _mode, _timeout, args) => {
                    if (source.includes('getBoundingClientRect')) {
                        return { x: 1, y: 2, width: 10, height: 10 };
                    }
                    if (args?.[0] === 'context') {
                        return { activeElement: { id: 'item-60' } };
                    }
                    return true;
                },
            });
            try {
                const input = registeredTool(registerInputTool);
                for (const event of [
                    { type: 'editorContext', target: { css: '.item', nth: 60 } },
                    { type: 'keydown', target: { css: '.item', nth: 60 }, key: 'a', commands: ['selectAll'] },
                    { type: 'keyup', key: 'a' },
                    { type: 'type', target: { css: '.item', nth: 60 }, mode: 'controlled', text: 'one one' },
                    { type: 'wheel', target: { css: '.item', nth: 60 }, deltaY: 10 },
                    { type: 'drag', target: { css: '.item', nth: 60 }, to: { css: '.item', nth: 79 } },
                    { type: 'click', target: { css: '.item', nth: 60 }, button: 'right' },
                ]) {
                    const response = await input({ frame: 1, events: [event], timeout: 1000 });
                    assert.notEqual(response.isError, true, response.content[0].text);
                }
                assert.ok(actions.some((action) => JSON.stringify(action) === '["controlled","item-60"]'));
                assert.ok(actions.some((action) => JSON.stringify(action) === '["wheel","item-60"]'));
                assert.ok(actions.some((action) => JSON.stringify(action) === '["drag","item-60","item-79"]'));
                assert.deepEqual(lookups.slice(-2), [60, 60], 'scroll refresh must retain nth');
            } finally {
                restoreUnified();
                restoreDriver();
            }
        });
    }
);

test('F2 verification preserves native context failures and page-script error provenance without replay', async () => {
    for (const mode of ['cdp', 'extension']) {
        await withPageFixture(mode, async ({ unified, state }) => {
            let nativeFailure = true;
            let evaluations = 0;
            const restore = patchProperties(unified, {
                evaluate: async (source, _mode, _timeout, args = []) => {
                    if (source === 'owned-effect') {
                        state.dispatched.push('effect');
                        return 7;
                    }
                    ++evaluations;
                    if (nativeFailure) {
                        throw new CDPError('Runtime.callFunctionOn: Cannot find context with specified id');
                    }
                    return globalThis.eval(`(${source})`)(...args);
                },
                consumeLastEvaluationMetadata: () => undefined,
            });
            try {
                const evaluate = registeredTool(registerEvaluateTool);
                for (const script of [
                    '() => true',
                    '() => { throw new Error("Runtime.callFunctionOn: Cannot find context with specified id") }',
                    'async () => { throw new Error("Debugger agent is not enabled") }',
                ]) {
                    nativeFailure = script === '() => true';
                    const before = state.dispatched.length;
                    const body = JSON.parse(
                        (
                            await evaluate({
                                targetId: '202',
                                expectedRevision: 'r202',
                                script: 'owned-effect',
                                postCondition: { script },
                            })
                        ).content[0].text
                    );
                    assert.equal(body.actionStatus, 'completed');
                    assert.equal(body.result, 7);
                    assert.equal(body.failureStage, 'verification');
                    assert.equal(body.verificationStatus, nativeFailure ? 'unavailable' : 'error');
                    assert.equal(state.dispatched.length - before, 1);
                }
                assert.equal(evaluations, 3);
            } finally {
                restore();
            }
        });
    }
});

test('F4 ordinary inspection preserves the debugger and Challenge titles detach before isolated reads', async () => {
    const options = {
        challengeSelectors: [],
        deniedSelectors: [],
        widgetSelectors: [],
        verifyButtonSelectors: [],
        frameSelectors: [],
        titleNeedles: ['just a moment', '请稍候'],
        textMarkers: [],
        originResponsePendingTextMarkers: [],
    };
    for (const scenario of [
        { title: 'Owned ordinary page', expected: ['inspect'] },
        { title: 'Just a moment...', expected: ['detach', 'inspect'] },
        { title: '请稍候…', expected: ['detach', 'inspect'] },
        { title: 'Owned verification', textHits: ['正在进行安全验证'], expected: ['inspect', 'detach'] },
        {
            title: 'Owned recovered',
            originResponsePending: true,
            textHits: ['正在进行安全验证'],
            expected: ['inspect'],
        },
    ]) {
        await withPageFixture('extension', async ({ unified, driver }) => {
            const calls = [];
            const { title } = scenario;
            const snapshot = {
                title,
                inspected: true,
                textHits: scenario.textHits,
                originResponsePending: scenario.originResponsePending,
            };
            const restoreDriver = patchProperties(driver, {
                debuggerDetach: async () => {
                    calls.push('detach');
                },
                inspectChallenge: async () => {
                    calls.push('inspect');
                    return snapshot;
                },
            });
            const restore = patchProperties(unified, {
                inspectChallenge: Object.getPrototypeOf(unified).inspectChallenge,
                getLiveState: async () => ({ url: 'https://example.com/owned', title, managed: true }),
            });
            try {
                assert.equal(await unified.inspectChallenge(options, 1000), snapshot);
                assert.deepEqual(calls, scenario.expected);
            } finally {
                restore();
                restoreDriver();
            }
        });
    }
});

test('F3 CDP tools retain full match counts and collect diagnostics before leaving the target frame', async () => {
    await withPageFixture('cdp', async ({ unified, state }) => {
        const session = getSession();
        let frame;
        let diagnosticReads = 0;
        const cdp = {
            async send(method) {
                if (method === 'Runtime.evaluate') {
                    return { result: { objectId: 'query-result' } };
                }
                if (method === 'Runtime.getProperties') {
                    return {
                        result: [
                            { name: 'count', value: { value: 15 } },
                            { name: 'node', value: { subtype: 'null' } },
                        ],
                    };
                }
                if (method === 'Runtime.releaseObject') {
                    return {};
                }
                throw new CDPError(`unexpected ${method}`);
            },
        };
        const restoreSession = patchProperties(session, {
            createLocator: (target, options) => new Locator(cdp, target, 'owned', { ...options, nth: target.nth }),
            evaluate: async (source) => {
                ++diagnosticReads;
                assert.doesNotMatch(source, /\.value\b/);
                assert.equal(state.current, '202');
                assert.equal(frame, 2);
                return { candidates: [{ tag: 'button', text: 'candidate' }], activeElement: null };
            },
        });
        const restore = patchProperties(unified, {
            withFrame: async (requested, run) => {
                frame = requested;
                try {
                    return await run();
                } finally {
                    frame = undefined;
                }
            },
            getLiveState: async () => ({ url: `https://example.com/${state.current}` }),
            getChallengeState: async () => null,
            inspectChallenge: async () => ({ title: 'Ordinary', inspected: true }),
            evaluate: async (source) => {
                if (source.includes('activeElement')) {
                    ++diagnosticReads;
                    assert.equal(state.current, '202');
                    assert.equal(frame, 2);
                    return { candidates: [{ tag: 'button', text: 'candidate' }], activeElement: null };
                }
                return { title: 'Ordinary', selectorHits: [], deniedHits: [], turnstilePresent: false };
            },
        });
        try {
            for (const [register, args, code] of [
                [
                    registerInputTool,
                    { events: [{ type: 'click', target: { css: 'button', nth: 30 } }], expectedRevision: 'r202' },
                    'ELEMENT_NOT_FOUND',
                ],
                [registerExtractTool, { type: 'text', target: { css: 'button', nth: 30 } }, 'ELEMENT_NOT_FOUND'],
                [registerWaitTool, { for: 'element', target: { css: 'button', nth: 30 } }, 'TIMEOUT'],
            ]) {
                const started = Date.now();
                const response = await registeredTool(register)({ ...args, targetId: '202', frame: 2, timeout: 500 });
                const body = JSON.parse(response.content[0].text);
                assert.equal(body.error.code, code, response.content[0].text);
                assert.equal(body.hint, undefined, 'locator failures must not suggest changing window focus');
                assert.equal(body.error.context.matchCount, 15);
                assert.equal(body.error.context.nth, 30);
                assert.equal(body.error.context.tabId, '202');
                assert.equal(body.error.context.frame, 2);
                assert.equal(body.error.context.managed, null);
                assert.equal(body.error.context.connection, 'connected');
                assert.equal(body.error.context.candidates.length, 1);
                assert.equal(body.error.context.lastLocatorState, 'index_out_of_range');
                assert.ok(Date.now() - started < 750, 'diagnostics must share the original deadline');
                assert.equal(state.current, '101');
            }
            assert.equal(diagnosticReads, 3);
        } finally {
            restore();
            restoreSession();
        }
    });
});

test('F3 diagnostic failures preserve primary errors, privacy, and the original deadline', async () => {
    for (const outcome of ['ok', 'rejected', 'stalled', 'expired']) {
        await withPageFixture('cdp', async ({ unified, state }) => {
            let reads = 0;
            const target = { css: 'button', nth: 30 };
            const secret = 'sentinel-sensitive-input';
            const now = Date.now;
            let deadlineOffset = 0;
            const restoreClock = patchProperties(Date, { now: () => now() + deadlineOffset });
            const restoreSession = patchProperties(getSession(), {
                createLocator: (_target, options) => ({
                    find: async () => {
                        if (outcome === 'expired') {
                            deadlineOffset = 85;
                        }
                        throw new ElementNotFoundError(
                            target,
                            options.timeout,
                            ['lookup-log'],
                            'https://example.com/202',
                            {
                                matchCount: 15,
                                lastLocatorState: 'index_out_of_range',
                            }
                        );
                    },
                }),
                evaluate: async (source, _args, timeout) => {
                    ++reads;
                    assert.equal(state.current, '202');
                    assert.ok(timeout > 0 && timeout <= 80);
                    assert.doesNotMatch(source, /\.value\b/);
                    if (outcome === 'stalled') {
                        deadlineOffset = 85;
                        return new Promise(() => {});
                    }
                    if (outcome === 'rejected') {
                        throw new Error(`/home/private-user/test.js ${secret}`);
                    }
                    return {
                        candidates: Array.from({ length: 12 }, () => ({ tag: 'button', text: secret })),
                        activeElement: null,
                    };
                },
            });
            const restore = patchProperties(unified, {
                getLiveState: async () => ({ url: 'https://example.com/202' }),
                evaluate: async () => assert.fail('diagnostics must not use reconnecting dispatch'),
            });
            try {
                const started = performance.now();
                const response = await registeredTool(registerInputTool)({
                    targetId: '202',
                    expectedRevision: 'r202',
                    timeout: 80,
                    events: [{ type: 'type', target, text: secret }],
                });
                const body = JSON.parse(response.content[0].text);
                assert.equal(body.error.code, 'ELEMENT_NOT_FOUND', outcome);
                assert.equal(body.error.context.matchCount, 15, outcome);
                assert.deepEqual(body.error.logs, ['lookup-log']);
                assert.equal(response.content[0].text.includes(secret), false);
                assert.equal(body.error.context.candidates.length, outcome === 'ok' ? 10 : 0);
                if (['rejected', 'stalled'].includes(outcome)) {
                    assert.equal(typeof body.error.context.diagnosticError, 'string');
                }
                assert.ok(performance.now() - started < 250, outcome);
                assert.equal(reads, outcome === 'expired' ? 0 : 1, outcome);
                assert.equal(state.current, ['stalled', 'expired'].includes(outcome) ? null : '101', outcome);
                assert.deepEqual(state.dispatched, []);
            } finally {
                restore();
                restoreSession();
                restoreClock();
            }
        });
    }
});

test('F3 AX totals and unknown XPath counts remain distinct from unresolved DOM nodes', async () => {
    for (const scenario of ['ax-range', 'ax-node', 'xpath']) {
        const target = scenario === 'xpath' ? { xpath: '//button' } : { role: 'button' };
        const locator = new Locator(
            {
                async send(method) {
                    if (method === 'Accessibility.enable') {
                        return {};
                    }
                    if (method === 'DOM.getDocument') {
                        return { root: { nodeId: 1 } };
                    }
                    if (method === 'Accessibility.queryAXTree') {
                        return {
                            nodes: Array.from({ length: 15 }, () => ({ role: { value: 'button' } })),
                        };
                    }
                    if (method === 'Runtime.evaluate') {
                        return { result: { subtype: 'null' } };
                    }
                    throw new CDPError('unexpected native command');
                },
            },
            target,
            'owned',
            { nth: scenario === 'ax-range' ? 30 : 0, timeout: 5 }
        );
        await assert.rejects(
            () => locator.find(),
            (error) => {
                assert.equal(error.context.matchCount, scenario === 'xpath' ? null : 15);
                assert.equal(
                    error.context.lastLocatorState,
                    scenario === 'ax-range'
                        ? 'index_out_of_range'
                        : scenario === 'ax-node'
                          ? 'node_resolution_failed'
                          : 'not_found'
                );
                return true;
            }
        );
        const observation = locator.lastObservation;
        assert.equal(Reflect.defineProperty(observation, 'matchCount', { value: 999 }), true);
        assert.equal(observation.matchCount, 999);
        assert.notEqual(locator.lastObservation.matchCount, 999);
    }
});

test('F4 ordinary live titles still inspect visible verification text without passive delay', async () => {
    for (const mode of ['extension', 'cdp']) {
        let clock = 0;
        let inspections = 0;
        const host = {
            getMode: () => mode,
            getState: () => ({ title: 'Ordinary', url: 'https://example.com/' }),
            getLiveState: async () => ({ title: 'Ordinary', url: 'https://example.com/' }),
            getChallengeState: async () => ({ state: 'pending', mode }),
            evaluate: async () => {
                ++inspections;
                return {
                    title: 'Ordinary',
                    selectorHits: [],
                    deniedHits: [],
                    textHits: ['正在进行安全验证'],
                    turnstilePresent: false,
                };
            },
            getCookies: async () => [],
            mouseMove: async () => assert.fail('verification text must not click'),
            mouseClick: async () => assert.fail('verification text must not click'),
        };
        await assert.rejects(
            () =>
                waitForChallenge(host, {
                    action: 'input',
                    actionStatus: 'not_started',
                    timeout: 500,
                    now: () => clock,
                    sleep: async (ms) => {
                        clock += ms;
                    },
                }),
            (error) => error.code === 'CHALLENGE_TIMEOUT'
        );
        assert.equal(inspections, 1);
    }
});

test('F6 legacy topology omits unknown groups while empty and malformed groups remain distinct', async () => {
    await withPageFixture('extension', async ({ unified }) => {
        const bridge = new ExtensionBridge();
        const topology = {
            windowCount: 1,
            windows: [
                {
                    id: 9,
                    focused: false,
                    alwaysOnTop: false,
                    tabCount: 1,
                    tabs: [{ id: 202, managed: true, active: false, muted: false, autoDiscardable: false }],
                },
            ],
        };
        let groups;
        let provided = false;
        let calls = 0;
        bridge.httpServer.sendCommand = async (action) => {
            assert.equal(action, 'tabs_topology');
            ++calls;
            return { ...topology, ...(provided ? { groups } : {}) };
        };
        const restore = patchProperties(unified, { listTopology: () => bridge.listWindows() });
        try {
            const browse = registeredTool(registerBrowseTool);
            for (const details of ['summary', 'full']) {
                const body = JSON.parse(
                    (await browse({ action: 'list', details, targetIds: ['202'], managedOnly: true })).content[0].text
                );
                assert.equal(body.success, true);
                assert.equal('groups' in body, false);
                assert.match(body.warnings.join(' '), /groups|分组/);
                assert.equal(body.targets[0].isActive, false);
                if (details === 'full') {
                    assert.equal(body.targets[0].autoDiscardable, false);
                }
            }
            provided = true;
            groups = [];
            assert.deepEqual(JSON.parse((await browse({ action: 'list' })).content[0].text).groups, []);
            for (groups of [null, {}, [{ id: 7, targetIds: [] }], [{ id: 7, tabIds: [] }]]) {
                const response = await browse({ action: 'list' });
                assert.equal(response.isError, true);
                assert.match(JSON.parse(response.content[0].text).error.message, /groups|分组/);
            }
            assert.equal(calls, 7);
        } finally {
            restore();
        }
    });
});

test('F6 legacy group summaries retain real membership and filtering from the same topology response', async () => {
    await withPageFixture('extension', async ({ unified }) => {
        const bridge = new ExtensionBridge();
        let calls = 0;
        bridge.httpServer.sendCommand = async (action) => {
            assert.equal(action, 'tabs_topology');
            ++calls;
            return {
                windowCount: 2,
                windows: [
                    {
                        id: 9,
                        focused: false,
                        tabCount: 3,
                        tabs: [
                            { id: 204, index: 0, groupId: -1, managed: true, active: false },
                            { id: 202, index: 1, groupId: 7, managed: true, active: false, pinned: false },
                            { id: 203, index: 2, groupId: 7, managed: false, active: false },
                        ],
                    },
                    {
                        id: 10,
                        focused: false,
                        tabCount: 1,
                        tabs: [{ id: 205, index: 0, groupId: 8, managed: false, active: false }],
                    },
                ],
                groups: [
                    { id: 7, title: 'Legacy owned group', color: 'cyan', windowId: 9, collapsed: false },
                    { id: 8, title: '', color: 'blue', windowId: 10, collapsed: false },
                ],
            };
        };
        const restore = patchProperties(unified, { listTopology: () => bridge.listWindows() });
        try {
            const browse = registeredTool(registerBrowseTool);
            for (const details of ['summary', 'full']) {
                const body = JSON.parse((await browse({ action: 'list', details })).content[0].text);
                assert.equal(body.success, true);
                const group = body.groups.find((item) => item.id === 7);
                assert.deepEqual(group.tabIds, [202, 203]);
                assert.deepEqual(group.targetIds, ['202', '203']);
                assert.equal(group.totalTabCount, 2);
                assert.equal(group.index, 1);
                assert.equal(group.collapsed, false);
                assert.equal(body.targets.find((item) => item.targetId === '202').pinned, false);
                assert.equal(body.warnings, undefined);
            }
            for (const filter of [{ targetIds: ['202'] }, { managedOnly: true }]) {
                const body = JSON.parse((await browse({ action: 'list', ...filter })).content[0].text);
                assert.deepEqual(
                    body.groups.map((item) => item.id),
                    [7]
                );
                assert.deepEqual(body.groups[0].tabIds, [202]);
                assert.deepEqual(body.groups[0].targetIds, ['202']);
                assert.equal(body.groups[0].totalTabCount, 2);
            }
            const empty = JSON.parse(
                (await browse({ action: 'list', targetIds: ['203'], managedOnly: true })).content[0].text
            );
            assert.deepEqual(empty.targets, []);
            assert.deepEqual(empty.groups, []);
            assert.equal(calls, 5);
        } finally {
            restore();
        }
    });
});

test('CR-07 device catalogue is independent of page state and never ignores page conditions', async (t) => {
    for (const mode of ['extension', 'cdp']) {
        await t.test(mode, async () =>
            withPageFixture(mode, async ({ unified, state }) => {
                let pageReads = 0;
                const restore = patchProperties(unified, {
                    getPageSnapshot: async () => {
                        ++pageReads;
                        throw new TargetNotFoundError('closed');
                    },
                    withTabId: async () => {
                        throw new Error('catalogue must not select a page');
                    },
                });
                try {
                    const manage = registeredTool(registerManageTool);
                    for (const targetId of [undefined, 'missing']) {
                        const response = await manage({ action: 'emulate', targetId });
                        assert.equal(response.isError, undefined);
                        const data = JSON.parse(response.content[0].text);
                        assert.ok(data.availableDevices.includes('iPhone 13'));
                        assert.equal(data.pageContext, undefined);
                    }
                    for (const condition of [{ expectedUrl: 'https://example.com/' }, { expectedRevision: 'stale' }]) {
                        const response = await manage({ action: 'emulate', ...condition });
                        assert.equal(response.isError, true);
                        assert.equal(JSON.parse(response.content[0].text).error.code, 'INVALID_ARGUMENT');
                    }
                    assert.equal(pageReads, 0);
                    assert.equal(state.current, '101');
                } finally {
                    restore();
                }
            })
        );
    }
});

test('CR-08 DOMSnapshot uses the existing native path in each backend and rejects ignored scopes', async (t) => {
    for (const mode of ['extension', 'cdp']) {
        await t.test(mode, async () =>
            withPageFixture(mode, async ({ unified, state }) => {
                const calls = [];
                const snapshot = { documents: [{ nodes: { nodeName: ['owned'] } }], strings: ['owned'] };
                const restore = patchProperties(unified, {
                    withFrame: async (_frame, run) => run(),
                    sendCdpCommand: async (...args) => {
                        calls.push({ args, targetId: state.current });
                        return snapshot;
                    },
                });
                try {
                    const extract = registeredTool(registerExtractTool);
                    const response = await extract({ type: 'state', mode: 'domsnapshot', targetId: '202' });
                    assert.equal(response.isError, undefined);
                    assert.deepEqual(JSON.parse(response.content[0].text).snapshot, snapshot);
                    assert.equal(calls[0].args[0], 'DOMSnapshot.captureSnapshot');
                    assert.equal(calls[0].targetId, '202');
                    assert.equal(state.current, '101');
                    for (const scope of [{ frame: 0 }, { target: { css: '#owned' } }, { depth: 1 }]) {
                        const rejected = await extract({
                            type: 'state',
                            mode: 'domsnapshot',
                            targetId: '202',
                            ...scope,
                        });
                        assert.equal(rejected.isError, true);
                        assert.equal(JSON.parse(rejected.content[0].text).error.code, 'INVALID_ARGUMENT');
                    }
                    assert.equal(calls.length, 1);
                } finally {
                    restore();
                }
            })
        );
    }
});

test('CR-09 CDP activation observes available fields without changing the default target', async () => {
    await withPageFixture('cdp', async ({ state }) => {
        const calls = [];
        const cdp = getSession();
        const restore = patchProperties(cdp, {
            listTargets: async () =>
                [...state.targets].map((targetId) => ({
                    id: targetId,
                    targetId,
                    url: `https://example.com/${targetId}`,
                    title: `Page ${targetId}`,
                    revision: `r${targetId}`,
                })),
            activateTarget: async (targetId) => {
                calls.push(targetId);
            },
        });
        try {
            const manage = registeredTool(registerManageTool);
            const response = await manage({ action: 'activatePage', targetId: '202' });
            assert.equal(response.isError, undefined);
            const affected = JSON.parse(response.content[0].text).affected;
            assert.equal(affected.before.targetId, '202');
            assert.equal(affected.after.title, 'Page 202');
            assert.equal(affected.after.active, undefined);
            assert.deepEqual(calls, ['202']);
            assert.equal(state.current, '101');
            const missing = await manage({ action: 'activatePage', targetId: 'missing' });
            assert.equal(missing.isError, true);
            const stale = await manage({ action: 'activatePage', targetId: '202', expectedRevision: 'stale' });
            assert.equal(stale.isError, true);
            assert.equal(JSON.parse(stale.content[0].text).error.code, 'ACTION_PRECONDITION_FAILED');
            assert.deepEqual(calls, ['202']);
        } finally {
            restore();
        }
    });
});

test('CS-N03 public connect waits for the input scope and cannot replace its backend or restoration', async () => {
    await withPageFixture('cdp', async ({ unified, driver }) => {
        const gate = deferred();
        const entered = deferred();
        const calls = [];
        driver.getConnectionInfo = () => ({ version: 'fixture' });
        const proto = Object.getPrototypeOf(unified);
        const restoreUnified = patchProperties(unified, {
            extensionBridge: driver,
            getMode: proto.getMode,
            getDriver: proto.getDriver,
        });
        const restoreCdp = patchProperties(getSession(), {
            async keyDown() {
                calls.push('cdp-down');
                entered.resolve();
                await gate.promise;
            },
            async keyUp() {
                calls.push('cdp-up');
            },
        });
        try {
            const input = registeredTool(registerInputTool)({
                targetId: '202',
                expectedRevision: 'r202',
                events: [
                    { type: 'keydown', key: 'a' },
                    { type: 'keyup', key: 'a' },
                ],
            });
            await entered.promise;
            let connected = false;
            const connect = registeredTool(registerBrowseTool)({ action: 'connect' }).then((result) => {
                connected = true;
                return result;
            });
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(connected, false);
            assert.equal(unified.activeMode, 'cdp');
            gate.resolve();
            assert.equal(JSON.parse((await input).content[0].text).success, true);
            assert.equal(JSON.parse((await connect).content[0].text).mode, 'extension');
            assert.deepEqual(calls, ['cdp-down', 'cdp-up']);
            assert.equal(unified.getMode(), 'extension');
            assert.equal(getSession().getCurrentTargetId(), '101');
        } finally {
            gate.resolve();
            restoreCdp();
            restoreUnified();
        }
    });
});

test('CS-N05 public CDP frame failures preserve CDP scope without probing an available Extension page', async () => {
    await withPageFixture('cdp', async ({ unified, driver }) => {
        let probes = 0;
        let scripts = 0;
        driver.resolveFrame = async () => {
            ++probes;
            return { frameId: 4 };
        };
        const restoreCdp = patchProperties(getSession(), {
            resolveFrame: async () => {
                throw new StructuredToolError(
                    'FRAME_NOT_FOUND',
                    'CDP frame was not found',
                    'Read the current frame tree',
                    { actionExecuted: false }
                );
            },
        });
        const restore = patchProperties(unified, {
            extensionBridge: driver,
            evaluate: async () => {
                ++scripts;
            },
        });
        try {
            const result = await registeredTool(registerEvaluateTool)({
                targetId: '202',
                frame: 0,
                script: '++window.sideEffect',
            });
            const body = JSON.parse(result.content[0].text);
            assert.equal(result.isError, true);
            assert.equal(body.error.code, 'FRAME_NOT_FOUND');
            assert.equal(body.pageContext.targetId, '202');
            assert.equal(probes, 0);
            assert.equal(scripts, 0);
        } finally {
            restore();
            restoreCdp();
        }
    });
});

test('C7 public frame failures preserve the retry contract at the response top level', async () => {
    await withPageFixture('extension', async ({ unified }) => {
        const restore = patchProperties(unified, {
            evaluate: async () => {
                throw new StructuredToolError('FRAME_STALE_CONTEXT', 'Execution context became stale', undefined, {
                    retryAttempted: false,
                });
            },
        });
        try {
            const response = await registeredTool(registerEvaluateTool)({
                targetId: '202',
                expectedRevision: 'r202',
                script: 'owned-action',
            });
            const payload = JSON.parse(response.content[0].text);
            assert.equal(payload.retryAttempted, false);
            assert.equal(payload.actionExecuted, true);
            assert.equal(payload.actionStatus, 'unknown');
        } finally {
            restore();
        }
    });
});

test('C-R10 OOPIF sessions use their target identity before asynchronous setup', async () => {
    const session = getSession();
    const listeners = new Map();
    const commands = [];
    const restore = patchProperties(session, {
        listenersInstalled: false,
        childSessions: new Map(),
        frameSessions: new Map(),
        contexts: new Map(),
        cdp: {
            onEvent: (name, listener) => listeners.set(name, listener),
            send: async (method, _params, sessionId) => {
                commands.push({ method, sessionId });
                if (method === 'Page.getFrameTree') {
                    return { frameTree: { frame: { id: 'parent-frame' } } };
                }
                return {};
            },
        },
    });
    try {
        session.setupEventListeners();
        listeners.get('Target.attachedToTarget')(
            { sessionId: 'child-session', targetInfo: { type: 'iframe', targetId: 'child-frame' } },
            'parent-session'
        );
        assert.equal(session.frameSessions.get('child-frame'), 'child-session');
        assert.equal(session.childSessions.get('child-session'), 'parent-session');
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(session.frameSessions.has('parent-frame'), false);
        assert(
            commands.some((command) => command.method === 'Runtime.enable' && command.sessionId === 'child-session')
        );
        assert(
            commands.some(
                (command) => command.method === 'Target.setAutoAttach' && command.sessionId === 'child-session'
            )
        );
        listeners.get('Target.detachedFromTarget')({ sessionId: 'child-session' });
        assert.equal(session.frameSessions.has('child-frame'), false);
        assert.equal(session.childSessions.has('child-session'), false);
    } finally {
        await new Promise((resolve) => setImmediate(resolve));
        restore();
    }
});

test('C-R10 CDP resolves Shadow iframe selectors and indices through shared DOM queries', async (t) => {
    for (const selection of ['iframe#owned', 0]) {
        await t.test(String(selection), async () => {
            const child = {
                nodeType: 1,
                childNodes: [],
                matches: (selector) => ['iframe#owned', 'iframe,frame'].includes(selector),
            };
            const host = { nodeType: 1, childNodes: [], shadowRoot: { childNodes: [child] }, matches: () => false };
            const document = { childNodes: [host], querySelector: () => null, querySelectorAll: () => [] };
            const realm = createContext({ document, window: {} });
            const session = getSession();
            const restore = patchProperties(session, {
                ensureSession: () => {},
                sessionId: 'owned-session',
                currentTargetId: '202',
                frameSessions: new Map(),
                frameScopes: new Map(),
                contexts: new Map([
                    [
                        'owned-session',
                        [
                            { frameId: 'parent', id: 1, isDefault: true },
                            { frameId: 'child', id: 2, isDefault: true },
                        ],
                    ],
                ]),
                cdp: {
                    send: async (method, params) => {
                        if (method === 'Page.getFrameTree') {
                            return { frameTree: { frame: { id: 'parent' } } };
                        }
                        if (method === 'Runtime.evaluate') {
                            const value = runInContext(params.expression, realm);
                            return { result: value === child ? { objectId: 'owned-frame' } : { type: 'undefined' } };
                        }
                        if (method === 'DOM.describeNode') {
                            return { node: { nodeName: 'IFRAME', frameId: 'child', backendNodeId: 7 } };
                        }
                        return {};
                    },
                },
            });
            try {
                const resolved = await session.resolveFrame(selection, 1000);
                assert.equal(resolved.frameContext.frameId, 'child');
                assert.equal(resolved.frameContext.contextId, 2);
                assert.equal(resolved.frameContext.sessionId, 'owned-session');
            } finally {
                restore();
            }
        });
    }
});

test('C-R10 public frame preparation inherits the original request deadline', async (t) => {
    for (const mode of ['extension', 'cdp']) {
        await t.test(mode, async () => {
            await withPageFixture(mode, async ({ unified, driver }) => {
                let budget;
                let frame = 0;
                const restore = patchProperties(mode === 'extension' ? driver : getSession(), {
                    resolveFrame: async (_selection, timeout) => {
                        budget = timeout;
                        return { frameId: 3, offset: null };
                    },
                    getCurrentFrameId: () => frame,
                    setCurrentFrameId: (value) => {
                        frame = value;
                    },
                });
                const restoreEvaluate = patchProperties(unified, { evaluate: async () => 42 });
                try {
                    const response = await registeredTool(registerEvaluateTool)({
                        targetId: '202',
                        frame: '#owned',
                        script: 'owned-action',
                        timeout: 500,
                    });
                    assert.equal(JSON.parse(response.content[0].text).success, true);
                    assert(Number.isFinite(budget) && budget > 0 && budget <= 500, String(budget));
                    assert.equal(frame, 0);
                    assert.equal(unified.getCurrentTargetId(), '101');
                } finally {
                    restoreEvaluate();
                    restore();
                }
            });
        });
    }
});

test('C-R10 frame preparation timeout stays unexecuted and restores the previous target', async (t) => {
    for (const mode of ['extension', 'cdp']) {
        await t.test(mode, async () => {
            await withPageFixture(mode, async ({ unified, driver }) => {
                let scripts = 0;
                const restore = patchProperties(mode === 'extension' ? driver : getSession(), {
                    resolveFrame: async () => {
                        throw new TimeoutError('Owned frame context wait timed out');
                    },
                });
                const restoreEvaluate = patchProperties(unified, {
                    evaluate: async () => {
                        ++scripts;
                        return 42;
                    },
                });
                try {
                    const response = await registeredTool(registerEvaluateTool)({
                        targetId: '202',
                        frame: '#owned',
                        script: 'owned-action',
                        timeout: 500,
                    });
                    const body = JSON.parse(response.content[0].text);
                    assert.equal(body.error.code, 'TIMEOUT');
                    assert.equal(body.actionExecuted, false);
                    assert.equal(body.actionStatus, 'not_started');
                    assert.equal(body.failureStage, 'context');
                    assert.equal(body.retryable, false);
                    assert.equal(scripts, 0);
                    assert.equal(unified.getCurrentTargetId(), '101');
                    assert.equal(body.pageContext.targetRestoration.status, 'restored');
                } finally {
                    restoreEvaluate();
                    restore();
                }
            });
        });
    }
});

test('C-R9 CDP native context loss preserves dispatched, preparation and page-error states', async () => {
    await withPageFixture('cdp', async ({ unified }) => {
        const native = () =>
            new CDPError('Runtime.evaluate: Execution context was destroyed.', {
                method: 'Runtime.evaluate',
                errorSource: 'context',
                protocolError: true,
                nativeCode: -32000,
            });
        const restore = patchProperties(unified, {
            evaluate: async () => {
                throw native();
            },
        });
        try {
            const response = await registeredTool(registerEvaluateTool)({ targetId: '202', script: 'owned-action' });
            const body = JSON.parse(response.content[0].text);
            assert.equal(body.error.code, 'CDP_ERROR');
            assert.equal(body.actionExecuted, true);
            assert.equal(body.actionStatus, 'unknown');
            assert.equal(body.retryable, false);
            await unified.withUserAction('evaluate', async () => {
                const beforeDispatch = native();
                unified.annotateUserActionError(beforeDispatch);
                assert.equal(classifyEvaluateFailure(beforeDispatch).actionStatus, 'not_started');
                assert.equal(classifyEvaluateFailure(beforeDispatch).actionExecuted, false);
            });
            const pageError = setErrorSource(new Error('Execution context was destroyed.'), 'page');
            assert.equal(classifyEvaluateFailure(pageError).actionStatus, 'failed');
            assert.equal(classifyEvaluateFailure(pageError).actionExecuted, true);
            assert.equal(classifyEvaluateFailure(pageError).retryable, false);
        } finally {
            restore();
        }
    });
});

test('C-R9 CDP iframe readOnly policy refuses before script dispatch', async () => {
    await withPageFixture('cdp', async ({ unified }) => {
        let frame = 0;
        let scripts = 0;
        const restore = patchProperties(getSession(), {
            resolveFrame: async () => ({ frameId: 4 }),
            getCurrentFrameId: () => frame,
            setCurrentFrameId: (value) => {
                frame = value;
            },
            evaluate: async () => {
                ++scripts;
                return 42;
            },
        });
        try {
            const response = await registeredTool(registerEvaluateTool)({
                targetId: '202',
                frame: '#owned',
                staleContextRetry: 'readOnly',
                script: 'owned-action',
            });
            const body = JSON.parse(response.content[0].text);
            assert.equal(body.error.code, 'DRIVER_CAPABILITY_ERROR');
            assert.equal(body.actionExecuted, false);
            assert.equal(body.actionStatus, 'not_started');
            assert.equal(body.retryable, false);
            assert.equal(scripts, 0);
            assert.equal(frame, 0);
            assert.equal(unified.getCurrentTargetId(), '101');
        } finally {
            restore();
        }
    });
});

test('C-R9 CDP frame resolution reports specific failures before execution', async () => {
    const session = getSession();
    for (const [selection, native, node, expected] of [
        ['#missing', { result: { type: 'object', subtype: 'null', value: null } }, null, 'FRAME_NOT_FOUND'],
        [17, { result: { type: 'undefined' } }, null, 'FRAME_NOT_FOUND'],
        [
            'iframe[',
            {
                result: {},
                exceptionDetails: {
                    text: 'Uncaught',
                    exception: { className: 'SyntaxError', description: 'Invalid selector' },
                },
            },
            null,
            'INVALID_FRAME_SELECTOR',
        ],
        [
            'iframe[',
            {
                result: {},
                exceptionDetails: {
                    text: 'Uncaught',
                    exception: {
                        className: 'DOMException',
                        description:
                            "SyntaxError: Failed to execute 'querySelector' on 'Document': 'iframe[' is not a valid selector.",
                    },
                },
            },
            null,
            'INVALID_FRAME_SELECTOR',
        ],
        ['#plain', { result: { objectId: 'plain' } }, { nodeName: 'DIV', backendNodeId: 1 }, 'FRAME_NOT_IFRAME'],
        [
            '#unavailable',
            { result: { objectId: 'frame' } },
            { nodeName: 'IFRAME', backendNodeId: 2 },
            'FRAME_IDENTITY_UNAVAILABLE',
        ],
    ]) {
        const released = [];
        const restore = patchProperties(session, {
            ensureSession: () => {},
            sessionId: 'owned-session',
            contexts: new Map([['owned-session', [{ frameId: 'root', id: 1, isDefault: true }]]]),
            cdp: {
                send: async (method, params) => {
                    if (method === 'Page.getFrameTree') {
                        return { frameTree: { frame: { id: 'root' } } };
                    }
                    if (method === 'Runtime.evaluate') {
                        return native;
                    }
                    if (method === 'DOM.describeNode') {
                        return { node };
                    }
                    if (method === 'Runtime.releaseObject') {
                        released.push(params.objectId);
                    }
                    return {};
                },
            },
        });
        try {
            await assert.rejects(session.resolveFrame(selection, 1000), (error) => {
                assert.equal(error.code, expected);
                assert.equal(error.context.actionExecuted, false);
                assert.equal(error.context.actionStatus, 'not_started');
                assert.equal(error.context.phase, 'frame_resolution');
                return true;
            });
            assert.deepEqual(released, node ? [native.result.objectId] : []);
        } finally {
            restore();
        }
    }
});

test('C-R9 CDP invalid selector preserves its type and stops locator retries', async () => {
    let queries = 0;
    const locator = new Locator(
        {
            send: async () => {
                ++queries;
                return {
                    result: {},
                    exceptionDetails: {
                        exception: {
                            className: 'DOMException',
                            description: "SyntaxError: Failed to execute 'querySelector': '[' is not a valid selector.",
                        },
                    },
                };
            },
        },
        { css: '[' },
        'owned-session',
        { contextId: 4, timeout: 1000 }
    );
    await assert.rejects(locator.evaluateOn('function(){return this.textContent}'), (error) => {
        assert.equal(error.code, 'INVALID_SELECTOR');
        assert.equal(error.context.phase, 'script_result');
        assert.equal(error.context.actionExecuted, false);
        assert.equal(error.context.retryable, false);
        return true;
    });
    assert.equal(queries, 1);
});

test('CS-N01 public temporary CDP evaluate preserves each target log buffer and explicit clearing', async () => {
    await withPageFixture('cdp', async ({ unified }) => {
        const cdp = getSession();
        const proto = Object.getPrototypeOf(cdp);
        const original = { level: 'error', text: 'original-target', sequence: 1 };
        const restoreCdp = patchProperties(cdp, {
            cdp: { isConnected: true },
            currentTargetId: '101',
            sessionId: 'session-101',
            targetLogs: new Map(),
            consoleLogs: [original],
            networkRequests: [{ url: 'original-request' }],
            requestMap: new Map(),
            selectPage: proto.selectPage,
            getCurrentTargetId: proto.getCurrentTargetId,
            async sendBrowserCommand(method, params) {
                return method === 'Target.attachToTarget' ? { sessionId: `session-${params.targetId}` } : {};
            },
            async initSession() {},
        });
        const restoreUnified = patchProperties(unified, {
            getState: () => null,
            getLiveState: async () => null,
            evaluate: async () => {
                cdp.consoleLogs.push({ level: 'warning', text: 'temporary-target', sequence: 2 });
                return true;
            },
        });
        try {
            const response = await registeredTool(registerEvaluateTool)({
                targetId: '202',
                expectedRevision: 'r202',
                script: 'true',
            });
            assert.equal(response.isError, undefined);
            assert.equal(cdp.currentTargetId, '101');
            assert.deepEqual(
                (await cdp.getConsoleLogs()).map((item) => item.text),
                ['original-target']
            );
            assert.equal((await cdp.getNetworkRequests())[0].url, 'original-request');
            await cdp.selectPage('202');
            assert.deepEqual(
                (await cdp.getConsoleLogs()).map((item) => item.text),
                ['temporary-target']
            );
            await cdp.getConsoleLogs({ clear: true });
            await cdp.selectPage('101');
            await cdp.selectPage('202');
            assert.deepEqual(await cdp.getConsoleLogs(), []);
        } finally {
            restoreUnified();
            restoreCdp();
        }
    });
});

test('CH-09/20 CDP idle counts page requests and excludes Worker requests with no terminal event', async (t) => {
    for (const phase of ['before', 'during']) {
        for (const type of ['Fetch', 'Script']) {
            await t.test(`${phase}: ${type}`, async () => {
                const session = getSession();
                const listeners = new Map();
                const onEvent = (name, listener) => {
                    const callbacks = listeners.get(name) ?? new Set();
                    callbacks.add(listener);
                    listeners.set(name, callbacks);
                };
                const offEvent = (name, listener) => listeners.get(name)?.delete(listener);
                const emit = (name, params, sessionId = 'owned') => {
                    for (const listener of listeners.get(name) ?? []) {
                        listener(params, sessionId);
                    }
                };
                const restore = patchProperties(session, {
                    cdp: { isConnected: true, onEvent, offEvent, once: onEvent, removeListener: offEvent },
                    sessionId: 'owned',
                    listenersInstalled: false,
                    requestMap: new Map(),
                    networkRequests: [],
                    consoleLogs: [],
                });
                const start = (requestId, loaderId, requestType = 'Script', sessionId) =>
                    emit(
                        'Network.requestWillBeSent',
                        {
                            requestId,
                            loaderId,
                            type: requestType,
                            frameId: 'main',
                            request: { url: `https://example.com/${requestId}`, method: 'GET' },
                            timestamp: 1,
                            wallTime: 10,
                        },
                        sessionId
                    );
                try {
                    session.setupEventListeners();
                    const baselineListeners = new Map(
                        [...listeners].map(([name, callbacks]) => [name, callbacks.size])
                    );
                    start('worker-before', '');
                    if (phase === 'before') {
                        start('page', 'document-loader', type);
                    }
                    const waiting = session.waitForNetworkIdle(500, 20);
                    let settled = false;
                    waiting.then(() => {
                        settled = true;
                    });
                    if (phase === 'during') {
                        start('worker-during', '');
                        start('page', 'document-loader', type);
                    }
                    start('stale-request', 'stale-loader', 'Script', 'old-session');
                    emit('Network.loadingFinished', { requestId: 'page', timestamp: 2 }, 'old-session');
                    await session.getNetworkRequests({ clear: true });
                    await new Promise((resolve) => setTimeout(resolve, 35));
                    assert.equal(settled, false);
                    emit(type === 'Fetch' ? 'Network.loadingFinished' : 'Network.loadingFailed', {
                        requestId: 'page',
                        timestamp: 3,
                        ...(type === 'Script' ? { errorText: 'net::ERR_FAILED' } : {}),
                    });
                    const finishedAt = Date.now();
                    await waiting;
                    assert.ok(Date.now() - finishedAt >= 15);
                    assert.equal(session.requestMap.has('page'), false);
                    assert.equal(session.requestMap.has('worker-before'), true);
                    const logs = await session.getNetworkRequests();
                    assert.equal(logs.length, 1);
                    assert.equal(logs[0].type, type);
                    assert.equal(Object.hasOwn(logs[0], 'loaderId'), false);
                    emit('Network.loadingFinished', { requestId: 'worker-before', timestamp: 4 });
                    assert.equal((await session.getNetworkRequests()).length, 2);
                    for (const name of [
                        'Network.requestWillBeSent',
                        'Network.loadingFinished',
                        'Network.loadingFailed',
                    ]) {
                        assert.equal(listeners.get(name).size, baselineListeners.get(name));
                    }
                    assert.equal(listeners.get('disconnected').size, baselineListeners.get('disconnected') ?? 0);
                } finally {
                    restore();
                }
            });
        }
    }
    for (const reason of ['timeout', 'abort', 'disconnect']) {
        await t.test(`cleanup: ${reason}`, async () => {
            const session = getSession();
            const listeners = new Map();
            const controller = new globalThis.AbortController();
            const onEvent = (name, listener) => listeners.set(name, listener);
            const offEvent = (name) => listeners.delete(name);
            const restore = patchProperties(session, {
                cdp: { isConnected: true, onEvent, offEvent, once: onEvent, removeListener: offEvent },
                sessionId: 'owned',
                requestMap: new Map([
                    ['page', { loaderId: 'document-loader' }],
                    ['worker', { loaderId: '' }],
                ]),
                requestContext: () => ({ signal: controller.signal }),
            });
            try {
                const waiting = session.waitForNetworkIdle(30, 10);
                const rejected = assert.rejects(
                    waiting,
                    reason === 'timeout'
                        ? /超时|Timeout|timeout/
                        : reason === 'disconnect'
                          ? /CDP 连接已关闭/
                          : /owned-stop/
                );
                if (reason === 'abort') {
                    controller.abort(new Error('owned-stop'));
                } else if (reason === 'disconnect') {
                    listeners.get('disconnected')();
                }
                await rejected;
                assert.equal(listeners.size, 0);
            } finally {
                restore();
            }
        });
    }
});

test('CS-N02 CDP retains response metadata until body completion and logs a body failure exactly once', async () => {
    const cdp = getSession();
    const listeners = new Map();
    const restore = patchProperties(cdp, {
        cdp: { onEvent: (name, listener) => listeners.set(name, listener) },
        sessionId: 'owned',
        currentTargetId: '101',
        mainFrameId: 'main',
        listenersInstalled: false,
        requestMap: new Map(),
        networkRequests: [],
        consoleLogs: [],
        targetLogs: new Map(),
    });
    const emit = (name, data, sessionId = 'owned') => listeners.get(name)(data, sessionId);
    try {
        cdp.setupEventListeners();
        for (const failure of [false, true]) {
            const requestId = String(failure);
            emit('Network.requestWillBeSent', {
                requestId,
                request: { url: `https://example.com/${requestId}`, method: 'GET' },
                type: 'Document',
                frameId: 'main',
                timestamp: 1,
                wallTime: 10,
            });
            emit('Network.responseReceived', { requestId, response: { status: 200 }, timestamp: 2 });
            assert.equal(cdp.requestMap.has(requestId), true);
            const terminal = {
                requestId,
                timestamp: 3,
                ...(failure ? { errorText: 'net::ERR_CONNECTION_RESET' } : {}),
            };
            emit(failure ? 'Network.loadingFailed' : 'Network.loadingFinished', terminal);
            emit('Network.loadingFailed', terminal);
            assert.equal(cdp.requestMap.has(requestId), false);
        }
        const entries = await cdp.getNetworkRequests();
        assert.equal(entries.length, 2);
        assert.deepEqual(
            entries.map((item) => item.status),
            [200, 200]
        );
        assert.equal(entries[1].errorText, 'net::ERR_CONNECTION_RESET');
        assert.equal(entries[1].duration, 2000);
    } finally {
        restore();
    }
});

test('CH-17 public confirmed final events retain completion after local scheduling crosses the deadline', async (t) => {
    for (const key of ['keydown', 'keyup']) {
        for (const route of ['precise', 'stealth', 'cdp']) {
            await t.test(`${route}-${key}`, async () =>
                withPageFixture(route === 'cdp' ? 'cdp' : 'extension', async ({ unified, driver }) => {
                    let now = 1000;
                    const dispatches = [];
                    const dispatch = async (...args) => {
                        dispatches.push(args);
                        now += 101;
                    };
                    const restoreClock = patchProperties(Date, { now: () => now });
                    const restoreUnified = patchProperties(unified, { inputMode: route });
                    driver.inputKey = dispatch;
                    driver.stealthKey = dispatch;
                    const restoreCdp =
                        route === 'cdp'
                            ? patchProperties(getSession(), { keyDown: dispatch, keyUp: dispatch })
                            : () => {};
                    try {
                        const response = await registeredTool(registerInputTool)({
                            targetId: '101',
                            expectedRevision: 'r101',
                            timeout: 100,
                            events: [{ type: key, key: 'a' }],
                        });
                        const body = JSON.parse(response.content[0].text);
                        assert.equal(response.isError, undefined);
                        assert.equal(body.actionStatus, 'completed');
                        assert.equal(body.retryable, false);
                        assert.equal(dispatches.length, key === 'keydown' ? 2 : 1);
                        assert.ok(dispatches[0].at(-1) > 0 && dispatches[0].at(-1) <= 100);
                        if (key === 'keydown') {
                            const cleanup = dispatches[1];
                            assert.equal(cleanup[0], route === 'precise' ? 'keyUp' : 'a');
                            if (route === 'stealth') {
                                assert.equal(cleanup[1], 'up');
                            }
                            assert.ok(cleanup.at(-1) > 0 && cleanup.at(-1) <= 1000);
                        }
                        assert.deepEqual([...unified.pressedKeys], []);
                    } finally {
                        restoreCdp();
                        restoreUnified();
                        restoreClock();
                    }
                })
            );
        }
    }
});

test('CS-N04 key RPCs carry remaining budgets and late acknowledgements retain unknown execution', async () => {
    for (const method of ['inputKey', 'stealthKey']) {
        const bridge = new ExtensionBridge();
        let now = 1000;
        const restoreClock = patchProperties(Date, { now: () => now });
        const restore = patchProperties(bridge, {
            currentTabId: 101,
            httpServer: {
                async sendCommand(action, params, timeout) {
                    assert.equal(action, method === 'inputKey' ? 'input_key' : 'stealth_key');
                    assert.equal(params.deadline, 1050);
                    assert.equal(timeout, 50);
                    now = 1051;
                    return { success: true };
                },
            },
        });
        try {
            await assert.rejects(
                () =>
                    method === 'inputKey'
                        ? bridge.inputKey('keyDown', { key: 'a' }, 50)
                        : bridge.stealthKey('a', 'up', [], 50),
                (error) => error.code === 'TIMEOUT' && error.context.actionStatus === 'unknown'
            );
        } finally {
            restore();
            restoreClock();
        }
    }
});

test('DOC-C01 manage rejects activate outside movePage before page creation or mutation', async () => {
    const manage = registeredTool(registerManageTool);
    for (const action of ['newPage', 'updatePage', 'newWindow', 'groupPages']) {
        assert.throws(() => manage({ action, activate: false }), /不支持 activate/);
    }
});

test(
    'Chrome public repeated screenshot timeouts preserve errors and allow a ' + 'later current-context evaluation',
    async () => {
        await withPageFixture('extension', async ({ unified }) => {
            let screenshots = 0;
            let evaluations = 0;
            const restore = patchProperties(unified, {
                getState: () => null,
                getLiveState: async () => null,
                screenshot: async () => {
                    ++screenshots;
                    throw new StructuredToolError('TIMEOUT', 'screenshot RPC timeout', 'read current state', {
                        actionStatus: 'unknown',
                        retryable: false,
                    });
                },
                evaluate: async (script) => {
                    if (script === 'owned') {
                        ++evaluations;
                        return 'current-context';
                    }
                    return false;
                },
            });
            try {
                const extract = registeredTool(registerExtractTool);
                for (let attempt = 0; attempt < 3; ++attempt) {
                    const response = await extract({ targetId: '202', type: 'screenshot' });
                    const body = JSON.parse(response.content[0].text);
                    assert.equal(response.isError, true);
                    assert.equal(body.error.code, 'TIMEOUT');
                    assert.equal(body.pageContext.targetId, '202');
                }
                const response = await registeredTool(registerEvaluateTool)({
                    targetId: '202',
                    expectedRevision: 'r202',
                    script: 'owned',
                });
                assert.equal(JSON.parse(response.content[0].text).result, 'current-context');
                assert.equal(screenshots, 3);
                assert.equal(evaluations, 1);
            } finally {
                restore();
            }
        });
    }
);

test('C19 evaluate retains origin-wait fields across action, verification and output results', async (t) => {
    const evaluate = registeredTool(registerEvaluateTool);
    for (const mode of ['extension', 'cdp']) {
        for (const scenario of ['success', 'action-failure', 'verification-failure', 'output-failure']) {
            await t.test(`${mode} ${scenario}`, async (context) => {
                if (scenario === 'verification-failure') {
                    context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
                }
                await withPageFixture(mode, async ({ unified }) => {
                    let executions = 0;
                    let inspections = 0;
                    const snapshot = {
                        title: 'Just a moment...',
                        originResponsePending: true,
                        selectorHits: [],
                        deniedHits: [],
                        textHits: [],
                        turnstilePresent: false,
                        clickPoint: null,
                        inspected: true,
                    };
                    const restore = patchProperties(unified, {
                        getState: () => ({ title: '', url: 'https://example.com/202' }),
                        getLiveState: async () => null,
                        getChallengeState: async () => null,
                        inspectChallenge: async () => {
                            ++inspections;
                            return snapshot;
                        },
                        getCookies: async () => [],
                        consumeLastEvaluationMetadata: () => undefined,
                        evaluate: async (script) => {
                            if (script.includes('originResponsePendingTextMarkers')) {
                                ++inspections;
                                return snapshot;
                            }
                            if (script !== 'owned-action') {
                                return { matched: false };
                            }
                            ++executions;
                            if (scenario === 'action-failure') {
                                throw new Error('Evaluation failed: owned-action');
                            }
                            return scenario === 'output-failure' ? 1n : 'owned-result';
                        },
                    });
                    try {
                        const pending = evaluate({
                            targetId: '202',
                            script: 'owned-action',
                            ...(scenario === 'verification-failure'
                                ? { postCondition: { script: 'false', timeout: 1 } }
                                : {}),
                        });
                        if (scenario === 'verification-failure') {
                            await new Promise((resolve) => setImmediate(resolve));
                            context.mock.timers.tick(1);
                        }
                        const response = await pending;
                        const body = JSON.parse(response.content[0].text);
                        assert.equal(body.originResponsePending, true);
                        assert.equal(body.challengeResolved, true);
                        assert.equal(body.challengeKind, 'none');
                        assert.equal(body.clickedTurnstile, false);
                        assert.equal(body.clearanceCookiePresent, false);
                        assert.equal(typeof body.waitedMs, 'number');
                        assert.equal(body.actionExecuted, true);
                        assert.equal(body.actionStatus, scenario === 'action-failure' ? 'failed' : 'completed');
                        assert.equal(body.pageContext.targetId, '202');
                        if (scenario === 'success') {
                            assert.equal(body.success, true);
                            assert.equal(body.result, 'owned-result');
                        } else if (scenario === 'verification-failure') {
                            context.diagnostic(JSON.stringify({ mode, timeout: 1, postCondition: body.postCondition }));
                            assert.equal(body.success, false);
                            assert.equal(body.verificationStatus, 'not_matched');
                            assert.equal(body.failureStage, 'verification');
                        } else {
                            assert.equal(response.isError, true);
                            assert.equal(body.failureStage, scenario === 'output-failure' ? 'output' : 'action');
                        }
                        assert.equal(executions, 1);
                        assert.equal(inspections, scenario === 'action-failure' ? 1 : 2);
                    } finally {
                        restore();
                    }
                });
            });
        }
    }
});

test('ER-06 native result serialization survives Extension transport and action classification', async () => {
    const server = Object.create(ExtensionHttpServer.prototype);
    const nativeMessage = "Object couldn't be returned by value";
    const detail = {
        error: {
            code: 'CDP_ERROR',
            message: `Runtime.evaluate: ${nativeMessage}`,
            suggestion: 'Return a serializable value',
            context: {
                nativeSource: 'chrome.debugger',
                method: 'Runtime.evaluate',
                phase: 'command',
                targetId: '202',
                nativeMessage,
                nativeCode: -32000,
                reason: 'result_not_serializable',
            },
        },
    };
    let nativeFailure;
    server.messageHandlers = new Map([
        [
            'owned-error',
            {
                reject: (error) => {
                    nativeFailure = error;
                },
                resolve: () => assert.fail('native failure was accepted'),
                cleanup() {},
            },
        ],
    ]);
    // 白盒验证响应错误转换及待处理请求清理，生产入口保持 private
    // noinspection JSAccessibilityCheck
    server.handleMessage(JSON.stringify({ id: 'owned-error', success: false, error: JSON.stringify(detail) }));
    assert.ok(nativeFailure instanceof CDPError);
    assert.equal(server.messageHandlers.size, 0);
    assert.deepEqual(JSON.parse(formatErrorResponse(nativeFailure).content[0].text), detail);
    assert.deepEqual(classifyEvaluateFailure(nativeFailure), {
        actionExecuted: true,
        actionStatus: 'unknown',
        retryable: false,
        failureStage: 'action',
    });
    const evaluate = registeredTool(registerEvaluateTool);
    const manage = registeredTool(registerManageTool);
    await withPageFixture('extension', async ({ unified }) => {
        let executions = 0;
        const restore = patchProperties(unified, {
            consumeLastEvaluationMetadata: () => undefined,
            evaluate: async () => {
                ++executions;
                throw nativeFailure;
            },
            sendCdpCommand: async () => {
                ++executions;
                throw nativeFailure;
            },
        });
        try {
            for (const response of [
                await evaluate({ targetId: '202', expectedRevision: 'r202', script: '++window.sideEffect' }),
                await manage({ action: 'cdp', targetId: '202', cdpMethod: 'Runtime.evaluate' }),
            ]) {
                const body = JSON.parse(response.content[0].text);
                assert.equal(response.isError, true);
                assert.equal(body.actionExecuted, true);
                assert.equal(body.actionStatus, 'unknown');
                assert.equal(body.retryable, false);
                assert.deepEqual(body.error, detail.error);
            }
            assert.equal(executions, 2);
        } finally {
            restore();
        }
    });
    for (const message of [nativeMessage, 'Object reference chain is too long']) {
        for (const method of ['Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.runScript', 'Page.enable']) {
            const client = new CDPClient();
            let failure;
            client.callbacks.set(1, {
                method,
                resolve: () => assert.fail('protocol error resolved'),
                reject: (error) => {
                    failure = error;
                },
            });
            client.handleMessage(Buffer.from(JSON.stringify({ id: 1, error: { code: -32000, message } })));
            assert.equal(classifyEvaluateFailure(failure).actionStatus === 'unknown', method.startsWith('Runtime.'));
        }
        for (const text of [message, `Error: ${message}\n    at <anonymous>:1:1`, `Runtime.evaluate: ${message}`]) {
            assert.notEqual(classifyEvaluateFailure(new Error(text)).actionStatus, 'unknown');
        }
    }
});

test('ER-07 manage cdp preserves resource and method failures without claiming an unsupported domain', async () => {
    const manage = registeredTool(registerManageTool);
    await withPageFixture('extension', async ({ unified }) => {
        let failure;
        let executions = 0;
        const restore = patchProperties(unified, {
            sendCdpCommand: async () => {
                ++executions;
                throw failure;
            },
        });
        try {
            for (const message of ['Resource not found', 'request body is not supported', 'method not found']) {
                failure = new Error(message);
                const response = await manage({ action: 'cdp', targetId: '202', cdpMethod: 'Network.getResponseBody' });
                const body = JSON.parse(response.content[0].text);
                assert.equal(response.isError, true);
                assert.equal(body.error.code, 'UNKNOWN_ERROR');
                assert.equal(body.error.message, message);
                assert.equal(body.pageContext.targetId, '202');
            }
            assert.equal(executions, 3);
        } finally {
            restore();
        }
    });
});

test('ER-10 page exceptions containing debugger or context text are not retryable', async () => {
    const evaluate = registeredTool(registerEvaluateTool);
    const messages = ['Error: Debugger agent is not enabled', 'Error: Cannot find context with specified id'];
    for (const mode of ['extension', 'cdp']) {
        await withPageFixture(mode, async ({ unified }) => {
            let failure;
            let executions = 0;
            const restore = patchProperties(unified, {
                consumeLastEvaluationMetadata: () => undefined,
                evaluate: async () => {
                    ++executions;
                    throw failure;
                },
            });
            try {
                for (const message of messages) {
                    failure = new Error(message);
                    assert.deepEqual(classifyEvaluateFailure(failure), {
                        actionExecuted: true,
                        actionStatus: 'failed',
                        failureStage: 'action',
                        retryable: false,
                    });
                    const response = await evaluate({
                        targetId: '202',
                        expectedRevision: 'r202',
                        script: 'owned-script',
                    });
                    const body = JSON.parse(response.content[0].text);
                    assert.equal(response.isError, true);
                    assert.equal(body.actionExecuted, true);
                    assert.equal(body.actionStatus, 'failed');
                    assert.equal(body.retryable, false);
                    assert.equal(body.error.message, message);
                }
                assert.equal(executions, messages.length);
            } finally {
                restore();
            }
        });
    }
});

test('C21 native script termination preserves error codes and unknown execution without replay', async (t) => {
    const evaluate = registeredTool(registerEvaluateTool);
    const manage = registeredTool(registerManageTool);
    const cases = [
        { error: new Error('Execution was terminated'), native: true },
        { error: new CDPError('{"code":-32000,"message":"Execution was terminated"}'), native: true },
        { error: new Error('Error: Execution was terminated\n    at <anonymous>:1:1'), native: false },
        { error: new Error('{"code":-32602,"message":"Execution was terminated"}'), native: false },
        { error: new Error('Runtime.evaluate: Internal error'), native: false },
    ];
    for (const method of ['Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.runScript', 'Page.enable']) {
        for (const message of ['Execution was terminated', 'Internal error', 'Invalid parameters']) {
            const client = new CDPClient();
            let error;
            client.callbacks.set(1, {
                method,
                resolve: () => assert.fail('protocol error resolved'),
                reject: (value) => {
                    error = value;
                },
            });
            const code = message === 'Internal error' ? -32603 : message === 'Invalid parameters' ? -32602 : -32000;
            client.handleMessage(Buffer.from(JSON.stringify({ id: 1, error: { code, message } })));
            assert.ok(error instanceof CDPError);
            assert.equal(client.callbacks.size, 0);
            cases.push({ error, native: method !== 'Page.enable' && message !== 'Invalid parameters' });
        }
    }
    for (const mode of ['extension', 'cdp']) {
        await t.test(mode, async () => {
            await withPageFixture(mode, async ({ unified }) => {
                let executions = 0;
                let failure;
                const restore = patchProperties(unified, {
                    consumeLastEvaluationMetadata: () => undefined,
                    evaluate: async () => {
                        ++executions;
                        throw failure;
                    },
                    sendCdpCommand: async () => {
                        ++executions;
                        throw failure;
                    },
                });
                try {
                    for (const { error, native } of cases) {
                        failure = error;
                        const expectedError = JSON.parse(formatErrorResponse(error).content[0].text).error;
                        for (const response of [
                            await evaluate({ targetId: '202', expectedRevision: 'r202', script: 'owned-action' }),
                            await manage({ action: 'cdp', targetId: '202', cdpMethod: 'Runtime.evaluate' }),
                        ]) {
                            const body = JSON.parse(response.content[0].text);
                            assert.equal(response.isError, true);
                            assert.deepEqual(body.error, expectedError);
                            assert.equal(body.pageContext.targetId, '202');
                            if (native) {
                                assert.equal(body.actionExecuted, true);
                                assert.equal(body.actionStatus, 'unknown');
                                assert.equal(body.retryable, false);
                            } else {
                                assert.notEqual(body.actionStatus, 'unknown');
                            }
                        }
                    }
                    assert.equal(executions, cases.length * 2);
                } finally {
                    restore();
                }
            });
        });
    }
});

test('C-P6 Challenge RPCs keep the remaining budget through Extension dispatch', async () => {
    const bridge = new ExtensionBridge();
    bridge.currentTabId = 101;
    bridge.currentFrameId = 0;
    const calls = [];
    bridge.httpServer = {
        async sendCommand(action, params, timeout) {
            calls.push({ action, params, timeout, now: Date.now() });
            return {};
        },
    };
    await bridge.stealthClick(12, 34, 'left', 1, undefined, 100);
    await bridge.debuggerDetach(undefined, 100);
    await bridge.inspectChallenge({}, 100);
    assert.equal(calls.length, 3);
    for (const call of calls) {
        assert.ok(call.timeout <= 100, call.action);
        assert.ok(call.params.deadline > call.now, call.action);
        assert.ok(call.params.deadline <= call.now + 100, call.action);
    }
});

test('C-P6 CDP Challenge press releases the original session after its acknowledgement stalls', async () => {
    const session = getSession();
    const blocker = deferred();
    const calls = [];
    const restore = patchProperties(session, {
        sessionId: 'owned-session',
        currentTargetId: 'owned-target',
        ensureSession() {},
        pendingPageCondition: null,
        cdp: {
            isConnected: true,
            async send(method, params, sessionId) {
                assert.equal(method, 'Input.dispatchMouseEvent');
                calls.push({ type: params.type, sessionId });
                if (params.type === 'mousePressed') {
                    session.sessionId = 'other-session';
                    session.currentTargetId = 'other-target';
                    return blocker.promise;
                }
                return {};
            },
        },
    });
    try {
        await assert.rejects(
            () =>
                Promise.race([
                    session.inputMouse('mousePressed', 12, 34, { button: 'left', releaseAfterPress: true }, 20),
                    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('still waiting')), 80)),
                ]),
            (error) => error.code === 'TIMEOUT'
        );
        assert.deepEqual(calls, [
            { type: 'mousePressed', sessionId: 'owned-session' },
            { type: 'mouseReleased', sessionId: 'owned-session' },
        ]);
    } finally {
        blocker.resolve({});
        restore();
    }
});

test('C-P6 CDP Challenge release failures retain a failed press and report cleanup errors', async (t) => {
    for (const pressFails of [false, true]) {
        await t.test(pressFails ? 'press-and-release-fail' : 'release-fails', async () => {
            const session = getSession();
            const pressError = new Error('press failed');
            const releaseError = new Error('release failed');
            const calls = [];
            const warnings = [];
            const restore = patchProperties(session, {
                sessionId: 'owned-session',
                currentTargetId: 'owned-target',
                ensureSession() {},
                pendingPageCondition: null,
                cdp: {
                    isConnected: true,
                    async send(_method, params, sessionId, timeout) {
                        calls.push({ type: params.type, sessionId, timeout });
                        if (params.type === 'mouseReleased') {
                            throw releaseError;
                        }
                        if (pressFails) {
                            throw pressError;
                        }
                        return {};
                    },
                },
            });
            const restoreConsole = patchProperties(console, {
                warn(message) {
                    warnings.push(message);
                },
            });
            try {
                await assert.rejects(
                    () => session.inputMouse('mousePressed', 12, 34, { button: 'left', releaseAfterPress: true }, 100),
                    (error) => error === (pressFails ? pressError : releaseError)
                );
                assert.equal(calls.length, 2);
                assert.deepEqual(calls[1], { type: 'mouseReleased', sessionId: 'owned-session', timeout: 1000 });
                assert.equal(warnings.length, pressFails ? 1 : 0);
            } finally {
                restoreConsole();
                restore();
            }
        });
    }
});

test('C-P6 Challenge read timeout keeps the known navigation result', async () => {
    const blocker = deferred();
    const host = {
        getMode: () => 'cdp',
        getState: () => ({ url: 'https://example.com/owned', title: 'Owned' }),
        getChallengeState: () => blocker.promise,
    };
    try {
        await assert.rejects(
            () => waitForChallenge(host, { timeout: 20, action: 'open', actionStatus: 'completed' }),
            (error) => {
                const result = error.toJSON();
                assert.equal(result.error.code, 'CHALLENGE_TIMEOUT');
                assert.equal(result.actionExecuted, true);
                assert.equal(result.actionStatus, 'completed');
                assert.equal(result.mode, 'cdp');
                assert.equal(result.autoRetry, false);
                return true;
            }
        );
    } finally {
        blocker.resolve(null);
    }
});

test('C-P6 navigation RPCs keep the caller budget and carry an execution deadline', async () => {
    const bridge = Object.create(ExtensionBridge.prototype);
    bridge.currentTabId = 101;
    const calls = [];
    bridge.httpServer = {
        async sendCommand(action, params, timeout) {
            calls.push({ action, params, timeout, now: Date.now() });
            return { id: 101, url: 'https://example.com/owned', title: 'Owned', navigated: true };
        },
    };
    await bridge.navigate('https://example.com/next', { timeout: 100 });
    await bridge.goBack(100);
    await bridge.goForward(100);
    await bridge.reload(false, 'load', 100);
    assert.equal(calls.length, 4);
    for (const call of calls) {
        assert.ok(call.timeout <= 100);
        assert.ok(call.params.deadline > call.now);
        assert.ok(call.params.deadline <= call.now + 100);
    }
});

test('C-P6 navigation budgets include backend selection and queued CDP work', async () => {
    const cdp = getSession();
    const unified = getUnifiedSession();
    const NativeDate = Date;
    let now = 1000;
    class ClockDate extends NativeDate {
        static now() {
            return now;
        }
    }
    const calls = [];
    const restoreDate = patchProperties(globalThis, { Date: ClockDate });
    const restoreCdp = patchProperties(cdp, {
        navigate: async (_url, options) => calls.push(options.timeout),
        goBack: async (timeout) => {
            calls.push(timeout);
            return { navigated: true };
        },
        goForward: async (timeout) => {
            calls.push(timeout);
            return { navigated: true };
        },
        reload: async (_ignoreCache, _wait, timeout) => calls.push(timeout),
    });
    const restoreUnified = patchProperties(unified, {
        getDriver: async () => {
            now += 40;
            return cdp;
        },
        getMode: () => 'cdp',
    });
    try {
        await unified.navigate('https://example.com/next', { timeout: 100 });
        await unified.goBack(100);
        await unified.goForward(100);
        await unified.reload({ timeout: 100 });
        assert.deepEqual(calls, [60, 60, 60, 60]);
    } finally {
        restoreUnified();
        restoreCdp();
        restoreDate();
    }
    let dispatched = 0;
    const restoreSession = patchProperties(cdp, {
        ensureSession: () => {},
        startNavigationWait: () => ({
            promise: Promise.resolve(),
            markActionStarted() {},
            setExpectedLoader() {},
            setExpectedSameDocument() {},
        }),
        send: async () => {
            ++dispatched;
            return { frameId: 'root', currentIndex: 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] };
        },
        waitForAnyEvent: async () => {},
        updateState: async () => {},
    });
    try {
        for (const action of [
            () => cdp.navigate('https://example.com/next', { timeout: 20 }),
            () => cdp.goBack(20),
            () => cdp.goForward(20),
            () => cdp.reload(false, 'load', 20),
        ]) {
            const blocker = deferred();
            const previous = cdp.withLock(() => blocker.promise);
            const operation = action();
            const observed = operation.then(
                () => 'completed',
                (error) => error.code
            );
            const outcome = await Promise.race([
                observed,
                new Promise((resolve) => setTimeout(() => resolve('still waiting'), 80)),
            ]);
            blocker.resolve();
            await previous;
            await operation.catch(() => {});
            assert.equal(outcome, 'TIMEOUT');
        }
        assert.equal(dispatched, 0);
    } finally {
        restoreSession();
    }
});

test('C-P6 navigation transport timeouts stay unknown and are not safe to replay', async () => {
    const bridge = Object.create(ExtensionBridge.prototype);
    bridge.currentTabId = 101;
    bridge.httpServer = {
        sendCommand: async () => {
            throw new Error('Request timeout for action: navigate (20ms)');
        },
    };
    await assert.rejects(
        () => bridge.navigate('https://example.com/next', { timeout: 20 }),
        (error) => {
            const body = JSON.parse(formatErrorResponse(error).content[0].text);
            assert.equal(body.error.code, 'TIMEOUT');
            assert.equal(body.error.context.actionExecuted, 'unknown');
            assert.equal(body.error.context.retryable, false);
            return true;
        }
    );
});

test('C-P6 expired queue entries preserve serialization until the prior operation settles', async () => {
    for (const lock of [
        getUnifiedSession().withTabLock.bind(getUnifiedSession()),
        getSession().withLock.bind(getSession()),
    ]) {
        const blocker = deferred();
        const entered = deferred();
        let expiredDispatched = false;
        let nextDispatched = false;
        const previous = lock(async () => {
            entered.resolve();
            await blocker.promise;
        });
        await entered.promise;
        const expired = lock(async () => {
            expiredDispatched = true;
        }, Date.now() + 20);
        const next = lock(async () => {
            nextDispatched = true;
        });
        try {
            await assert.rejects(
                () => expired,
                (error) => error.code === 'TIMEOUT' && error.context.actionExecuted === false
            );
            assert.equal(expiredDispatched, false);
            assert.equal(nextDispatched, false);
        } finally {
            blocker.resolve();
            await previous;
            await next;
        }
        assert.equal(nextDispatched, true);
    }
});

test('C-P6 CDP history commands and state reads share the original deadline', async () => {
    const session = getSession();
    const NativeDate = Date;
    let now = 1000;
    class ClockDate extends NativeDate {
        static now() {
            return now;
        }
    }
    const restoreDate = patchProperties(globalThis, { Date: ClockDate });
    const calls = [];
    const waits = [];
    const updates = [];
    const restoreSession = patchProperties(session, {
        ensureSession() {},
        async send(method, _params, timeout) {
            calls.push([method, timeout]);
            now += 40;
            return { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] };
        },
        async waitForAnyEvent(_events, timeout) {
            waits.push(timeout);
        },
        async updateState(timeout) {
            updates.push(timeout);
        },
    });
    try {
        await session.goBack(100);
        await session.goForward(100);
        assert.deepEqual(calls, [
            ['Page.getNavigationHistory', 100],
            ['Page.navigateToHistoryEntry', 60],
            ['Page.getNavigationHistory', 100],
            ['Page.navigateToHistoryEntry', 60],
        ]);
        assert.deepEqual(waits, [60, 60]);
        assert.deepEqual(updates, [20, 20]);
    } finally {
        restoreSession();
        restoreDate();
    }
});

test('C-P6 CDP history accepts main-frame BFCache restores without accepting unrelated commits', async () => {
    const session = getSession();
    for (const action of ['goBack', 'goForward']) {
        for (const completion of ['bfcache', 'same-document', 'load']) {
            const listeners = new Map();
            const emit = (event, params, sessionId = 'owned-session') => {
                for (const listener of listeners.get(event) ?? []) {
                    listener(params, sessionId);
                }
            };
            const cdp = {
                isConnected: true,
                onEvent(event, listener) {
                    const handlers = listeners.get(event) ?? new Set();
                    handlers.add(listener);
                    listeners.set(event, handlers);
                },
                offEvent(event, listener) {
                    listeners.get(event)?.delete(listener);
                },
                once() {},
                removeListener() {},
            };
            const restore = patchProperties(session, {
                cdp,
                sessionId: 'owned-session',
                mainFrameId: 'owned-main',
                ensureSession() {},
                async send(method) {
                    if (method === 'Page.getNavigationHistory') {
                        return { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] };
                    }
                    assert.equal(method, 'Page.navigateToHistoryEntry');
                    emit(
                        'Page.frameNavigated',
                        { type: 'BackForwardCacheRestore', frame: { id: 'owned-main' } },
                        'other-session'
                    );
                    emit('Page.frameNavigated', { type: 'Navigation', frame: { id: 'owned-main' } });
                    emit('Page.frameNavigated', {
                        type: 'BackForwardCacheRestore',
                        frame: { id: 'owned-child', parentId: 'owned-main' },
                    });
                    emit('Page.navigatedWithinDocument', { frameId: 'owned-child' });
                    assert.equal(listeners.get('Page.loadEventFired')?.size, 1);
                    if (completion === 'bfcache') {
                        emit('Page.frameNavigated', { type: 'BackForwardCacheRestore', frame: { id: 'owned-main' } });
                    } else if (completion === 'same-document') {
                        emit('Page.navigatedWithinDocument', { frameId: 'owned-main' });
                    } else {
                        emit('Page.loadEventFired', { timestamp: 1 });
                    }
                    return {};
                },
                async updateState() {},
            });
            try {
                assert.deepEqual(await session[action](100), { navigated: true });
                for (const handlers of listeners.values()) {
                    assert.equal(handlers.size, 0);
                }
            } finally {
                restore();
            }
        }
    }
});

test('C-P6 expired navigation clears its temporary target instead of restarting restoration waits', async () => {
    const NativeDate = Date;
    let now = 1000;
    class ClockDate extends NativeDate {
        static now() {
            return now;
        }
    }
    const restoreDate = patchProperties(globalThis, { Date: ClockDate });
    try {
        for (const mode of ['extension', 'cdp']) {
            now = 1000;
            await withPageFixture(mode, async ({ unified, state }) => {
                const deadline = now + 20;
                const response = await withPageContext(
                    unified,
                    '202',
                    async () => {
                        state.actionCompleted = true;
                        now = deadline;
                        return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
                    },
                    deadline
                );
                const body = JSON.parse(response.content[0].text);
                assert.equal(body.success, true);
                assert.equal(body.pageContext.targetRestoration.status, 'failed');
                assert.equal(body.pageContext.defaultTargetIdAfter, null);
                assert.equal(state.current, null);
            });
        }
    } finally {
        restoreDate();
    }
});

test('C-P6 Challenge click preparation cannot dispatch after its caller budget expires', async () => {
    const unified = getUnifiedSession();
    for (const mode of ['extension', 'cdp']) {
        const blocker = deferred();
        let dispatched = 0;
        const restore = patchProperties(unified, {
            isExtensionConnected: () => mode === 'extension',
            getDriver: async () => blocker.promise,
        });
        const operation = unified.clickTurnstile({ clickSource: 'page', clickPoint: { x: 12, y: 34 } }, 20);
        try {
            const result = await Promise.race([
                operation.then(
                    () => 'completed',
                    (error) => error.code
                ),
                new Promise((resolve) => setTimeout(() => resolve('still waiting'), 80)),
            ]);
            assert.equal(result, 'TIMEOUT', mode);
        } finally {
            blocker.resolve({
                async stealthClick() {
                    ++dispatched;
                },
                async inputMouse() {
                    ++dispatched;
                },
            });
            await operation.catch(() => {});
            restore();
        }
        assert.equal(dispatched, 0, mode);
    }
});

test('C-P6 Challenge inspection does not start a fallback after its budget expires', async () => {
    const blocker = deferred();
    let fallbackCalls = 0;
    const host = {
        getMode: () => 'extension',
        getState: () => ({ url: 'https://example.com/owned', title: 'Owned' }),
        inspectChallenge: async () => blocker.promise,
        async evaluate() {
            ++fallbackCalls;
            return {};
        },
    };
    const operation = readChallengeSnapshot(host, 20);
    try {
        const result = await Promise.race([
            operation,
            new Promise((resolve) => setTimeout(() => resolve('still waiting'), 80)),
        ]);
        assert.equal(result.inspected, false);
    } finally {
        blocker.resolve(Promise.reject(new Error('late inspect failure')));
        await operation;
    }
    assert.equal(fallbackCalls, 0);
});

test('C-P6 inspection budget rejection stops fallback at the clock boundary', async () => {
    for (const stage of ['native', 'stealth']) {
        const blocker = deferred();
        const timers = [];
        const reads = [];
        let now = 0;
        const restoreClock = patchProperties(Date, { now: () => now });
        const restoreTimers = patchProperties(globalThis, {
            setTimeout(callback) {
                timers.push(callback);
                return timers.length;
            },
            clearTimeout() {},
        });
        const host = {
            getMode: () => 'extension',
            getState: () => ({ url: 'https://example.com/owned', title: 'Owned' }),
            async inspectChallenge() {
                if (stage === 'native') {
                    return blocker.promise;
                }
                throw new Error('native inspection unavailable');
            },
            async evaluate(_code, mode) {
                reads.push(mode);
                return stage === 'stealth' && mode === 'stealth' ? blocker.promise : {};
            },
        };
        const operation = readChallengeSnapshot(host, 20);
        try {
            const timerCount = stage === 'native' ? 1 : 2;
            for (let tick = 0; tick < 20 && timers.length < timerCount; ++tick) {
                await Promise.resolve();
            }
            assert.equal(timers.length, timerCount);
            now = 19;
            timers.at(-1)();
            const result = await operation;
            assert.equal(result.inspected, false);
            assert.deepEqual(reads, stage === 'native' ? [] : ['stealth']);
        } finally {
            blocker.resolve({});
            await operation;
            restoreTimers();
            restoreClock();
        }
    }
});

test('C-P6 Challenge clicks receive the remaining wait budget and do not continue after a stalled move', async () => {
    for (const direct of [true, false]) {
        let now = 0;
        let clicks = 0;
        const blocker = deferred();
        const host = {
            getMode: () => 'cdp',
            getState: () => ({ url: 'https://example.com/owned', title: 'Owned' }),
            getChallengeState: async () => null,
            evaluate: async () => ({
                title: 'Owned',
                turnstilePresent: true,
                clickPoint: { x: 12, y: 34 },
                clickTargetKind: 'widget',
                clickSource: 'page',
            }),
            getCookies: async () => [],
            mouseMove: async () => blocker.promise,
            mouseClick: async () => {
                ++clicks;
            },
            ...(direct
                ? {
                      async clickTurnstile(snapshot, timeout) {
                          assert.deepEqual(snapshot.clickPoint, { x: 12, y: 34 });
                          assert.equal(timeout, 50);
                          ++clicks;
                          return blocker.promise;
                      },
                  }
                : {}),
        };
        try {
            await assert.rejects(
                () =>
                    waitForChallenge(host, {
                        action: 'open',
                        timeout: 100,
                        now: () => now,
                        sleep: async () => {
                            now += 50;
                        },
                    }),
                (error) => error.code === 'TIMEOUT'
            );
        } finally {
            blocker.resolve();
        }
        assert.equal(clicks, direct ? 1 : 0);
    }
});

test('C-P6 initial snapshot failures explain missing state without dispatching or reading again', async () => {
    for (const mode of ['extension', 'cdp']) {
        await withPageFixture(mode, async ({ unified }) => {
            const failure = new TimeoutError('initial snapshot timeout');
            let snapshots = 0;
            let targetLists = 0;
            let dispatched = 0;
            const restore = patchProperties(unified, {
                async getPageSnapshot() {
                    ++snapshots;
                    throw failure;
                },
                async listTargets() {
                    ++targetLists;
                    return [];
                },
                async listTopology() {
                    return null;
                },
            });
            try {
                await assert.rejects(
                    () =>
                        withPageResponse(unified, undefined, async () => {
                            ++dispatched;
                            return { content: [{ type: 'text', text: '{}' }] };
                        }),
                    (error) => {
                        assert.equal(error, failure, mode);
                        const body = JSON.parse(formatErrorResponse(error).content[0].text);
                        assert.equal(body.error.code, 'TIMEOUT', mode);
                        assert.equal(body.pageContext.targetId, '101', mode);
                        assert.equal(body.pageContext.before, null, mode);
                        assert.equal(body.pageContext.after, null, mode);
                        assert.ok(body.pageContext.contextError, mode);
                        return true;
                    }
                );
                assert.equal(snapshots, 1, mode);
                assert.equal(targetLists, 0, mode);
                assert.equal(dispatched, 0, mode);
            } finally {
                restore();
            }
        });
    }
});

test('C31F9 budget receipts stop diagnostics and context reads at deadline minus one', async () => {
    await withPageFixture('extension', async ({ unified }) => {
        const bridge = new ExtensionBridge();
        const server = bridge.httpServer;
        server.clientSocket = { readyState: 1 };
        const scheduled = new Map();
        const messages = [];
        let now = 1000;
        let timerId = 0;
        let contextReads = 0;
        const restoreClock = patchProperties(Date, { now: () => now });
        const restoreTimers = patchProperties(globalThis, {
            setTimeout: (callback) => {
                const id = ++timerId;
                scheduled.set(id, callback);
                return id;
            },
            clearTimeout: (id) => scheduled.delete(id),
        });
        const restoreServer = patchProperties(server, {
            isConnected: () => true,
            sendMessage: (_socket, message) => messages.push(message),
        });
        try {
            const pending = new Promise(() => {});
            const operations = [
                withNavigationBudget(() => pending, 1030),
                waitForNavigationQueue(pending, 1030),
                server.sendCommand('page_snapshot', { tabId: 101 }, 30),
            ].map((operation) => operation.catch((error) => error));
            assert.equal(scheduled.size, 3);
            now = 1029;
            const callbacks = [...scheduled.values()];
            scheduled.clear();
            for (const callback of callbacks) {
                callback();
            }
            const errors = await Promise.all(operations);
            assert.deepEqual(
                errors.map((error) => error.code),
                ['TIMEOUT', 'TIMEOUT', 'EXECUTION_RESULT_UNKNOWN']
            );
            assert.equal(getErrorSource(errors[0]), 'budget');
            assert.equal(getErrorSource(errors[2]), 'budget');
            assert.equal(errors[2].context.actionExecuted, 'unknown');
            assert.equal(messages.at(-1).type, 'cancel');
            assert.equal(server.messageHandlers.size, 0);
            assert.equal(scheduled.size, 0);
            const restoreUnified = patchProperties(unified, {
                enableConsole: async () => {
                    throw errors[0];
                },
                enableNetwork: async () => assert.fail('network setup after budget receipt'),
                listTargets: async () => {
                    ++contextReads;
                    return [];
                },
                listTopology: async () => {
                    ++contextReads;
                    return null;
                },
            });
            try {
                await assert.rejects(startDiagnostics(unified, true, 1030), (error) => error === errors[0]);
                await assert.rejects(
                    withPageResponse(
                        unified,
                        '101',
                        async () => {
                            throw errors[2];
                        },
                        false,
                        1030
                    ),
                    (error) => error === errors[2]
                );
                assert.equal(contextReads, 0);
                assert.equal(getErrorPageContext(errors[2]).after, null);
                assert.equal(scheduled.size, 0);
            } finally {
                restoreUnified();
            }
        } finally {
            restoreServer();
            restoreTimers();
            restoreClock();
        }
    });
});

test('C-P6 preparation, diagnostics and Challenge metadata cannot reset the browse budget', async () => {
    const browse = registeredTool(registerBrowseTool);
    for (const phase of ['before', 'diagnostics', 'challenge']) {
        await withPageFixture('extension', async ({ unified, driver }) => {
            const blocker = deferred();
            let dispatched = 0;
            let enabledNetwork = false;
            const restoreDriver = patchProperties(driver, {
                async getPageSnapshot(targetId, timeout) {
                    if (phase === 'before') {
                        return new Promise((_resolve, reject) =>
                            setTimeout(() => reject(new TimeoutError('snapshot timeout')), timeout)
                        );
                    }
                    return { targetId, url: 'https://example.com/owned', revision: 'owned' };
                },
                getState: () => ({ managed: true, url: 'https://example.com/owned', title: 'Owned' }),
                async navigate() {
                    ++dispatched;
                },
            });
            const restore = patchProperties(unified, {
                isExtensionModeEnabled: () => true,
                async enableConsole() {
                    if (phase === 'diagnostics') {
                        await blocker.promise;
                    }
                },
                async enableNetwork() {
                    enabledNetwork = true;
                },
                async getConsoleLogs() {
                    return [];
                },
                async getNetworkRequests() {
                    return [];
                },
                async getChallengeState() {
                    if (phase === 'challenge') {
                        await blocker.promise;
                    }
                    return null;
                },
                async getLiveState() {
                    return { url: 'https://example.com/owned', title: 'Owned' };
                },
            });
            try {
                const started = Date.now();
                const response = await browse({
                    action: 'open',
                    url: 'https://example.com/next',
                    timeout: 30,
                    diagnostics: phase === 'diagnostics',
                });
                const elapsed = Date.now() - started;
                const body = JSON.parse(response.content[0].text);
                assert.equal(response.isError, true, phase);
                assert.equal(body.error.code, phase === 'challenge' ? 'CHALLENGE_TIMEOUT' : 'TIMEOUT', phase);
                if (phase === 'challenge') {
                    assert.equal(body.actionExecuted, true);
                    assert.equal(body.actionStatus, 'completed');
                    assert.equal(body.autoRetry, false);
                }
                assert.ok(elapsed < 250, `${phase}: ${elapsed}ms`);
                assert.equal(dispatched, phase === 'challenge' ? 1 : 0, phase);
                if (body.pageContext.after) {
                    assert.deepEqual(body.pageContext.after, {
                        targetId: '101',
                        url: 'https://example.com/owned',
                        revision: 'owned',
                    });
                } else {
                    assert.equal(body.pageContext.after, null, phase);
                    assert.ok(body.pageContext.contextError, phase);
                }
                if (phase === 'diagnostics') {
                    assert.equal(enabledNetwork, false);
                }
            } finally {
                blocker.resolve();
                restore();
                restoreDriver();
            }
        });
    }
});

test('C11 screenshot and diagnostic capabilities do not promise hidden-tab capture', async (t) => {
    for (const mode of ['extension', 'cdp']) {
        await t.test(mode, async () => {
            await withPageFixture(mode, async ({ unified, state }) => {
                const png = makeRgbaPng(Buffer.from([0, 10, 20, 30, 255])).toString('base64');
                const consoleLogs = [
                    { level: 'warning', text: 'Owned warning' },
                    { level: 'warn', text: 'Owned warning alias' },
                ];
                const restore = patchProperties(unified, {
                    screenshot: async () => ({ data: png, format: 'png' }),
                    getLiveState: async () => ({
                        url: 'https://example.com/202',
                        title: 'Owned fixture',
                        managed: true,
                    }),
                    getMetadata: async () => ({ title: 'Owned fixture' }),
                    getFrames: async () => ({ frames: [] }),
                    enableConsole: async () => {},
                    enableNetwork: async () => {},
                    getConsoleLogs: async () => consoleLogs,
                    getNetworkRequests: async () => [],
                });
                const paths = [];
                try {
                    const extract = registeredTool(registerExtractTool);
                    for (const output of [false, true]) {
                        const args = { targetId: '202', type: 'screenshot' };
                        if (output) {
                            args.output = `tmp:c11-${randomUUID()}.png`;
                        }
                        const response = await extract(args);
                        const body = JSON.parse(response.content[0].text);
                        if (body.output) {
                            paths.push(body.output);
                        }
                        assert.equal(body.success, true);
                        assert.equal(body.metadata.capabilities.hiddenTabScreenshot, false);
                        assert.equal(body.metadata.width, 1);
                        if (body.output) {
                            assert.deepEqual(await readFile(body.output), Buffer.from(png, 'base64'));
                        } else {
                            assert.ok(response.content.some((block) => block.type === 'image'));
                        }
                        const diagnosticArgs = { targetId: '202', type: 'diagnosticBundle' };
                        if (output) {
                            diagnosticArgs.output = `tmp:c11-${randomUUID()}.json`;
                            consoleLogs.push({ level: 'error', text: 'Owned error' });
                        }
                        const diagnostic = JSON.parse((await extract(diagnosticArgs)).content[0].text);
                        if (diagnostic.output) {
                            paths.push(diagnostic.output);
                        }
                        assert.equal(diagnostic.success, true);
                        const bundle = diagnostic.output
                            ? JSON.parse(await readFile(diagnostic.output, 'utf8'))
                            : diagnostic.summary;
                        assert.equal(bundle.capabilities.hiddenTabScreenshot, false);
                        assert.equal(diagnostic.summary.consoleErrors, output ? 1 : 0);
                        const recent = diagnostic.output ? bundle.consoleSummary.recentErrors : diagnostic.console;
                        assert.deepEqual(
                            recent.map((entry) => entry.level),
                            output ? ['warning', 'warn', 'error'] : ['warning', 'warn']
                        );
                        assert.equal(state.current, '101');
                        assert.equal(state.dispatched.length, 0);
                    }
                } finally {
                    restore();
                    for (const path of paths) {
                        await rm(path);
                    }
                }
            });
        });
    }
});

test('C-P2 CDP targeted text matches rendered HTML without replacing empty text with source', async () => {
    await withPageFixture('cdp', async ({ unified, state }) => {
        class HtmlElement {
            constructor(innerText, textContent) {
                this.innerText = innerText;
                this.textContent = textContent;
            }
        }
        const elements = {
            body: new HtmlElement('Rendered 中文😀\nSVG', 'CSS source; script source; hidden text'),
            '#empty': new HtmlElement('', 'must-not-return-source'),
            '#hidden': new HtmlElement('Selected hidden text', 'Selected hidden text'),
            '#svg': { textContent: 'SVG' },
        };
        const document = {
            nodeType: 9,
            childNodes: Object.values(elements),
            body: elements.body,
            querySelector: (selector) => elements[selector] ?? null,
        };
        for (const [selector, element] of Object.entries(elements)) {
            Object.assign(element, {
                nodeType: 1,
                childNodes: [],
                parentElement: null,
                matches: (value) => value === selector,
                getRootNode: () => document,
            });
        }
        const context = { HTMLElement: HtmlElement, document };
        const realm = createContext(context);
        const cdp = getSession();
        const restore = patchProperties(cdp, {
            ensureSession: () => {},
            evaluate: async (script, args) => {
                realm.args = args;
                return runInContext(args === undefined ? script : `(${script})(...args)`, realm);
            },
            createLocator: ({ css }) => ({
                evaluateOn: async (script) =>
                    runInNewContext(`(${script}).call(element)`, { ...context, element: elements[css] }),
            }),
        });
        try {
            for (const [selector, element] of Object.entries(elements)) {
                const expected = element instanceof HtmlElement ? element.innerText : element.textContent;
                const response = await registeredTool(registerExtractTool)({
                    type: 'text',
                    targetId: '202',
                    target: { css: selector },
                });
                assert.notEqual(response.isError, true, response.content[0].text);
                assert.equal(JSON.parse(response.content[0].text).content, expected);
                assert.equal(await cdp.getPageText(selector), expected);
            }
            assert.equal(await cdp.getPageText('#missing'), '');
            assert.equal(await cdp.getPageText(), elements.body.innerText);
            assert.equal(await unified.getText('body'), elements.body.innerText);
            assert.equal(state.current, '101');
            assert.deepEqual(state.dispatched, []);
        } finally {
            restore();
        }
    });
});

test('I026 metadata completes during another target wait without changing its selection', async (t) => {
    for (const mode of ['extension', 'cdp']) {
        await t.test(mode, async () => {
            await withPageFixture(mode, async ({ unified, state }) => {
                const entered = deferred();
                const release = deferred();
                const waiting = unified.withTabId('202', async () => {
                    entered.resolve();
                    await release.promise;
                    assert.equal(state.current, '202');
                });
                await entered.promise;
                const manage = registeredTool(registerManageTool);
                let timer;
                let metadata;
                try {
                    metadata = manage({ action: 'pageMetadata', targetId: '101', note: 'owned concurrent note' });
                    const response = await Promise.race([
                        metadata,
                        new Promise((resolve) => {
                            timer = setTimeout(() => resolve(null), 200);
                        }),
                    ]);
                    assert.ok(response, 'Metadata waited for an unrelated page action');
                    assert.equal(response.isError, undefined, response.content[0].text);
                    const body = JSON.parse(response.content[0].text);
                    assert.equal(body.metadata.note, 'owned concurrent note');
                    assert.equal(body.pageContext.targetId, '101');
                    assert.equal(state.current, '202');
                    assert.equal(unified.getPageMetadata('101').note, 'owned concurrent note');
                } finally {
                    clearTimeout(timer);
                    release.resolve();
                    await waiting;
                    await metadata;
                }
                assert.equal(state.current, '101');
            });
        });
    }
});

test('I029 queued management observes its existing newPage deadline before creating a page', async () => {
    await withPageFixture('extension', async ({ unified, driver }) => {
        const entered = deferred();
        const release = deferred();
        const waiting = unified.withTabLock(async () => {
            entered.resolve();
            await release.promise;
        });
        await entered.promise;
        let creations = 0;
        const restore = patchProperties(driver, {
            newPage: async () => {
                ++creations;
                return { targetId: '303' };
            },
        });
        let timer;
        let operation;
        try {
            operation = registeredTool(registerManageTool)({ action: 'newPage', timeout: 15 });
            const response = await Promise.race([
                operation,
                new Promise((resolve) => {
                    timer = setTimeout(() => resolve(null), 200);
                }),
            ]);
            assert.ok(response, 'Queued management ignored the request deadline');
            assert.equal(response.isError, true);
            assert.match(JSON.parse(response.content[0].text).error.message, /timeout|超时/i);
            assert.equal(creations, 0);
        } finally {
            clearTimeout(timer);
            release.resolve();
            await waiting;
            await operation;
            restore();
        }
    });
});

test('C-P4 pageMetadata validates URL and revision before reading or updating notes', async (t) => {
    for (const mode of ['extension', 'cdp']) {
        await t.test(mode, async () => {
            await withPageFixture(mode, async ({ unified, driver, state }) => {
                const conditions = [];
                const backend = mode === 'cdp' ? getSession() : driver;
                const restore = patchProperties(backend, {
                    setPageCondition: (condition) => conditions.push(condition),
                });
                try {
                    const manage = registeredTool(registerManageTool);
                    const targetId = '202';
                    const match = { targetId, expectedUrl: 'https://example.com/202', expectedRevision: 'r202' };
                    const set = await manage({
                        action: 'pageMetadata',
                        ...match,
                        taskHint: 'owned-task',
                        note: 'matched',
                    });
                    assert.notEqual(set.isError, true, set.content[0].text);
                    const setBody = JSON.parse(set.content[0].text);
                    assert.equal(setBody.metadata.note, 'matched');
                    assert.equal(setBody.pageContext.targetId, targetId);
                    assert.deepEqual(conditions[0], match);
                    assert.equal(conditions.at(-1), null);
                    const read = await manage({ action: 'pageMetadata', ...match });
                    assert.notEqual(read.isError, true, read.content[0].text);
                    assert.equal(JSON.parse(read.content[0].text).metadata.note, 'matched');
                    for (const mismatch of [
                        { expectedUrl: 'https://example.com/other' },
                        { expectedRevision: 'stale-revision' },
                    ]) {
                        for (const updates of [{}, { note: 'must-not-save', taskHint: 'must-not-save' }]) {
                            const rejected = await manage({
                                action: 'pageMetadata',
                                targetId,
                                ...mismatch,
                                ...updates,
                            });
                            assert.equal(rejected.isError, true);
                            const body = JSON.parse(rejected.content[0].text);
                            assert.equal(body.error.code, 'ACTION_PRECONDITION_FAILED');
                            assert.equal(body.pageContext.targetId, targetId);
                            assert.equal(unified.getPageMetadata(targetId).note, 'matched');
                            assert.equal(unified.getPageMetadata(targetId).taskHint, 'owned-task');
                            assert.equal(conditions.at(-1), null);
                        }
                    }
                    const cleared = await manage({ action: 'pageMetadata', ...match, note: null });
                    assert.notEqual(cleared.isError, true, cleared.content[0].text);
                    assert.equal(JSON.parse(cleared.content[0].text).metadata.note, undefined);
                    const missing = await manage({
                        action: 'pageMetadata',
                        targetId: 'missing',
                        expectedRevision: 'r202',
                    });
                    assert.equal(missing.isError, true);
                    assert.equal(JSON.parse(missing.content[0].text).error.code, 'TARGET_NOT_FOUND');
                    assert.equal(state.current, '101');
                    assert.deepEqual(state.dispatched, []);
                } finally {
                    restore();
                }
            });
        });
    }
});

test('C10 mouse movement stops at the shared input deadline before subsequent actions', async (t) => {
    for (const route of ['precise', 'stealth', 'cdp']) {
        const scenarios = [
            { name: 'humanized-click', humanize: true, type: 'click' },
            { name: 'humanized-move', humanize: true, type: 'mousemove', steps: 3 },
            { name: 'direct-click', humanize: false, type: 'click' },
            { name: 'mousedown', humanize: false, type: 'mousedown' },
            { name: 'typing-focus', humanize: true, type: 'type', text: 'not-typed' },
            { name: 'within-budget', humanize: true, type: 'click', steps: 2 },
        ];
        if (route === 'cdp') {
            scenarios.push({ name: 'linear-steps', humanize: false, type: 'mousemove', steps: 3 });
        }
        for (const scenario of scenarios) {
            await t.test(`${route}-${scenario.name}`, async () => {
                await withPageFixture(route === 'cdp' ? 'cdp' : 'extension', async ({ unified, state }) => {
                    let now = 1000;
                    const moves = [];
                    let clicks = 0;
                    const move = async (x, y, timeout) => {
                        moves.push({ x, y, timeout });
                        now += 100;
                    };
                    const restoreClock = patchProperties(Date, { now: () => now });
                    const restoreUnified = patchProperties(unified, {
                        inputMode: route,
                        getMousePosition: () => ({ x: 0, y: 0 }),
                        mouseMove: move,
                        mouseClick: async () => {
                            ++clicks;
                        },
                        mouseDown: async () => {
                            ++clicks;
                        },
                    });
                    const restoreCdp =
                        route === 'cdp'
                            ? patchProperties(getSession(), {
                                  getBehaviorSimulator: () => ({ getCurrentPosition: () => ({ x: 0, y: 0 }) }),
                                  mouseMove: move,
                                  mouseDown: async () => {
                                      ++clicks;
                                  },
                                  mouseUp: async () => {},
                              })
                            : () => {};
                    try {
                        const { name, humanize, ...event } = scenario;
                        const withinBudget = name === 'within-budget';
                        const response = await registeredTool(registerInputTool)({
                            expectedRevision: 'r101',
                            timeout: withinBudget ? 5000 : 100,
                            humanize,
                            events: withinBudget
                                ? [{ ...event, target: { x: 50, y: 60 } }]
                                : [
                                      { ...event, target: { x: 50, y: 60 } },
                                      { type: 'keydown', key: 'Enter' },
                                  ],
                        });
                        const body = JSON.parse(response.content[0].text);
                        if (withinBudget) {
                            assert.equal(response.isError, undefined, response.content[0].text);
                            assert.equal(moves.length, route === 'cdp' ? 21 : 3);
                            assert.equal(clicks, 1);
                            assert.equal(body.eventsExecuted, 1);
                            assert.equal(body.actionStatus, 'completed');
                            return;
                        }
                        assert.equal(response.isError, true);
                        assert.match(body.error.message, /timeout/i);
                        assert.equal(moves.length, 1);
                        assert.equal(moves[0].timeout, 100);
                        assert.equal(clicks, 0);
                        assert.equal(body.eventsExecuted, 0);
                        assert.equal(body.actionExecuted, true);
                        assert.equal(body.actionStatus, 'unknown');
                        assert.equal(body.retryable, false);
                        assert.deepEqual(state.dispatched, []);
                    } finally {
                        restoreCdp();
                        restoreUnified();
                        restoreClock();
                    }
                });
            });
        }
    }
});

test('C10 mouse movement forwards remaining preparation and RPC budgets', async (t) => {
    for (const route of ['precise', 'stealth', 'cdp']) {
        await t.test(route, async () => {
            await withPageFixture(route === 'cdp' ? 'cdp' : 'extension', async ({ unified, driver }) => {
                let now = 1000;
                const calls = [];
                const backend = route === 'cdp' ? getSession() : driver;
                const restoreClock = patchProperties(Date, { now: () => now });
                const restoreUnified = patchProperties(unified, {
                    inputMode: route,
                    getDriver: async () => {
                        now += 40;
                        return backend;
                    },
                });
                const restoreBackend = patchProperties(backend, {
                    inputMouse: async (...args) => calls.push(args),
                    stealthMouse: async (...args) => calls.push(args),
                });
                try {
                    await unified.mouseMove(12, 34, 100);
                    assert.equal(calls.length, 1);
                    assert.equal(calls[0][0], route === 'stealth' ? 'mousemove' : 'mouseMoved');
                    assert.equal(calls[0][4], 60);
                    await assert.rejects(() => unified.mouseMove(56, 78, 30), /timeout/i);
                    assert.equal(calls.length, 1);
                } finally {
                    restoreBackend();
                    restoreUnified();
                    restoreClock();
                }
            });
        });
    }
    for (const method of ['inputMouse', 'stealthMouse']) {
        await t.test(`rpc-${method}`, async () => {
            const bridge = Object.create(ExtensionBridge.prototype);
            bridge.currentTabId = 101;
            bridge.currentFrameId = 3;
            const calls = [];
            bridge.httpServer = {
                async sendCommand(action, params, timeout) {
                    calls.push({ action, params, timeout });
                    return { success: true };
                },
            };
            const started = Date.now();
            if (method === 'inputMouse') {
                await bridge.inputMouse('mouseMoved', 12, 34, {}, 100);
            } else {
                await bridge.stealthMouse('mousemove', 12, 34, 'left', 100);
            }
            assert.equal(calls.length, 1);
            assert.equal(calls[0].action, method === 'inputMouse' ? 'input_mouse' : 'stealth_mouse');
            assert.ok(calls[0].timeout > 0 && calls[0].timeout <= 100);
            assert.ok(calls[0].params.deadline >= started + 100);
            assert.ok(calls[0].params.deadline <= Date.now() + 100);
            if (method === 'stealthMouse') {
                assert.equal(calls[0].params.frameId, 3);
            }
            await assert.rejects(() => bridge[method]('mousemove', 12, 34, undefined, 0), /timeout/i);
            assert.equal(calls.length, 1);
            if (method === 'inputMouse') {
                await bridge.inputMouse('mouseReleased', 12, 34, { button: 'left' });
            } else {
                await bridge.stealthMouse('mouseup', 12, 34, 'left');
            }
            assert.equal(calls.length, 2);
            assert.equal(calls[1].params.deadline, undefined);
            assert.equal(calls[1].timeout, undefined);
        });
    }
    await t.test('cdp-native', async () => {
        const session = getSession();
        const calls = [];
        const restore = patchProperties(session, {
            ensureSession() {},
            send: async (method, params, timeout) => calls.push({ method, params, timeout }),
        });
        try {
            await session.mouseMove(12.4, 34.6, 75);
            assert.equal(calls.length, 1);
            assert.equal(calls[0].timeout, 75);
            assert.equal(calls[0].params.x, 12);
            assert.equal(calls[0].params.y, 35);
        } finally {
            restore();
        }
    });
});

test('C10 Extension target lookup and coordinate reads reduce the movement budget', async (t) => {
    for (const route of ['precise', 'stealth']) {
        await t.test(route, async () => {
            await withPageFixture('extension', async ({ unified }) => {
                let now = 1000;
                const budgets = [];
                let clicks = 0;
                const restoreClock = patchProperties(Date, { now: () => now });
                const restore = patchProperties(unified, {
                    inputMode: route,
                    getFrameOffset: () => null,
                    find: async (_selector, _text, _xpath, timeout) => {
                        budgets.push(['find', timeout]);
                        now += 40;
                        return [{ refId: 'ref_1', rect: { x: 10, y: 20, width: 10, height: 20 } }];
                    },
                    evaluate: async (_code, _options, timeout) => {
                        budgets.push(['point', timeout]);
                        now += 30;
                        return { x: 10, y: 20, width: 10, height: 20 };
                    },
                    mouseMove: async (_x, _y, timeout) => budgets.push(['move', timeout]),
                    actionableClick: async () => {
                        ++clicks;
                        return { success: true };
                    },
                });
                try {
                    const response = await registeredTool(registerInputTool)({
                        expectedRevision: 'r101',
                        timeout: 100,
                        events: [{ type: 'mousemove', target: { css: '#owned' } }],
                    });
                    assert.equal(response.isError, undefined, response.content[0].text);
                    assert.deepEqual(budgets, [
                        ['find', 100],
                        ['point', 60],
                        ['move', 30],
                    ]);
                    assert.equal(clicks, 0);
                } finally {
                    restore();
                    restoreClock();
                }
            });
        });
    }
});

test(
    'C-V16 commands focus coordinate targets without mouse effects in either ' + 'backend or Extension frame',
    async (t) => {
        for (const route of ['extension', 'frame', 'cdp']) {
            for (const kind of [
                'checkbox',
                'link',
                'input',
                'contenteditable',
                'disabled',
                'nonfocusable',
                'missing',
                'throws',
                'expired',
            ]) {
                await t.test(`${route}-${kind}`, async () => {
                    await withPageFixture(route === 'cdp' ? 'cdp' : 'extension', async ({ unified, driver, state }) => {
                        const doc = { activeElement: null, querySelectorAll: () => [] };
                        let focusCalls = 0;
                        let frameId = 0;
                        const calls = [];
                        class HtmlElement {
                            tagName = kind === 'link' ? 'A' : 'INPUT';
                            id = 'owned-target';
                            checked = false;
                            isContentEditable = kind === 'contenteditable';
                            getAttribute() {
                                return null;
                            }

                            focus() {
                                ++focusCalls;
                                if (kind === 'throws') {
                                    throw new Error('owned focus failure');
                                }
                                if (kind !== 'disabled' && kind !== 'nonfocusable') {
                                    doc.activeElement = this;
                                }
                            }
                        }
                        const element = kind === 'missing' ? null : new HtmlElement();
                        doc.elementFromPoint = (x, y) => {
                            assert.deepEqual([x, y], [50, 60]);
                            return element;
                        };
                        const win = { __mcpElementMap: element ? { ref_owned: new WeakRef(element) } : {} };
                        const evaluate = (code, args) =>
                            runInNewContext(args === undefined ? code : `(${code})(...args)`, {
                                document: doc,
                                window: win,
                                HTMLElement: HtmlElement,
                                HTMLInputElement: HtmlElement,
                                Date: kind === 'expired' ? { now: () => Infinity } : Date,
                                args,
                            });
                        const restoreDriver = patchProperties(driver, {
                            resolveFrame: async (frame) => {
                                assert.equal(frame, '#owned-frame');
                                return { frameId: 7, offset: { x: 500, y: 800 } };
                            },
                            getCurrentFrameId: () => frameId,
                            setCurrentFrameId: (value) => {
                                frameId = value;
                            },
                            find: async (_selector, _text, _xpath, timeout, point) => {
                                calls.push(['find', frameId, point, timeout]);
                                assert.deepEqual(point, { x: 50, y: 60 });
                                return element ? [{ refId: 'ref_owned' }] : [];
                            },
                        });
                        const restoreCdp =
                            route === 'cdp'
                                ? patchProperties(getSession(), {
                                      createLocator: () => assert.fail('coordinate command focus must not use Locator'),
                                      evaluate: async (code, args, timeout) => {
                                          calls.push(['evaluate', frameId, timeout]);
                                          return evaluate(code, args);
                                      },
                                  })
                                : () => {};
                        const restore = patchProperties(unified, {
                            inputMode: 'precise',
                            evaluate: async (code, _mode, timeout, args) => {
                                calls.push(['evaluate', frameId, timeout]);
                                return evaluate(code, args);
                            },
                            mouseMove: () => assert.fail('command focus must not move the mouse'),
                            mouseClick: () => assert.fail('command focus must not click'),
                            actionableClick: () => assert.fail('command focus must not click a reference'),
                            keyDown: async (key, commands, timeout) => {
                                assert.equal(doc.activeElement, element);
                                assert.deepEqual(commands, ['selectAll']);
                                calls.push(['key', frameId, timeout]);
                                state.dispatched.push(key);
                            },
                        });
                        try {
                            const response = await registeredTool(registerInputTool)({
                                expectedRevision: 'r101',
                                timeout: 1000,
                                ...(route === 'frame' ? { frame: '#owned-frame' } : {}),
                                events: [
                                    { type: 'keydown', key: 'a', commands: ['selectAll'], target: { x: 50, y: 60 } },
                                ],
                            });
                            const body = JSON.parse(response.content[0].text);
                            const success = ['checkbox', 'link', 'input', 'contenteditable'].includes(kind);
                            assert.equal(response.isError, success ? undefined : true, response.content[0].text);
                            assert.equal(focusCalls, kind === 'missing' || kind === 'expired' ? 0 : 1);
                            assert.deepEqual(state.dispatched, success ? ['a'] : []);
                            assert.equal(element?.checked ?? false, false);
                            assert.equal(frameId, 0, 'frame scope must be restored after success or failure');
                            assert.equal(state.current, '101');
                            if (success) {
                                assert.ok(calls.every((call) => call[1] === (route === 'frame' ? 7 : 0)));
                                assert.equal(body.eventsExecuted, 1);
                            } else {
                                assert.equal(body.eventsExecuted, 0);
                                if (kind === 'missing') {
                                    assert.equal(body.error.code, 'TARGET_NOT_FOUND');
                                } else if (kind === 'throws') {
                                    assert.match(body.error.message, /owned focus failure/);
                                } else if (kind === 'expired') {
                                    assert.match(body.error.message, /timeout before command focus/);
                                } else {
                                    assert.equal(body.error.code, 'TARGET_FOCUS_FAILED');
                                }
                            }
                        } finally {
                            restore();
                            restoreCdp();
                            restoreDriver();
                        }
                    });
                });
            }
        }
    }
);

test('C-V16 commands keep the original focus deadline and reject stealth before preparing a target', async (t) => {
    for (const route of ['extension', 'cdp', 'stealth']) {
        for (const expiresAt of ['lookup', 'focus', 'none']) {
            await t.test(`${route}-${expiresAt}`, async () => {
                await withPageFixture(route === 'cdp' ? 'cdp' : 'extension', async ({ unified, driver }) => {
                    let now = 1000;
                    const budgets = [];
                    const restoreClock = patchProperties(Date, { now: () => now });
                    const focus = async (_code, _args, timeout) => {
                        budgets.push(['focus', timeout]);
                        now += expiresAt === 'focus' ? timeout : 20;
                        return true;
                    };
                    const restoreDriver = patchProperties(driver, {
                        find: async (_selector, _text, _xpath, timeout) => {
                            budgets.push(['find', timeout]);
                            now += expiresAt === 'lookup' ? timeout : 40;
                            return [{ refId: 'ref_owned' }];
                        },
                    });
                    const restoreCdp =
                        route === 'cdp'
                            ? patchProperties(getSession(), {
                                  createLocator: () => assert.fail('coordinate command focus must not use Locator'),
                                  evaluate: focus,
                              })
                            : () => {};
                    const restore = patchProperties(unified, {
                        inputMode: route === 'stealth' ? 'stealth' : 'precise',
                        evaluate: focus,
                        mouseMove: () => assert.fail('command focus must not move'),
                        mouseClick: () => assert.fail('command focus must not click'),
                        keyDown: async (_key, _commands, timeout) => {
                            budgets.push(['key', timeout]);
                        },
                    });
                    try {
                        const response = await registeredTool(registerInputTool)({
                            expectedRevision: 'r101',
                            timeout: 100,
                            events: [{ type: 'keydown', key: 'a', commands: ['selectAll'], target: { x: 50, y: 60 } }],
                        });
                        const body = JSON.parse(response.content[0].text);
                        if (route === 'stealth') {
                            assert.equal(response.isError, true);
                            assert.match(body.error.message, /commands 参数不支持 stealth/);
                            assert.deepEqual(budgets, []);
                        } else if (expiresAt !== 'none' && (route !== 'cdp' || expiresAt === 'focus')) {
                            assert.equal(response.isError, true, response.content[0].text);
                            assert.match(body.error.message, /timeout/i);
                            assert.equal(body.eventsExecuted, 0);
                            assert.equal(
                                budgets.some(([stage]) => stage === 'key'),
                                false
                            );
                        } else {
                            assert.equal(response.isError, undefined, response.content[0].text);
                            assert.deepEqual(
                                budgets,
                                route === 'cdp'
                                    ? [
                                          ['focus', 100],
                                          ['key', 80],
                                      ]
                                    : [
                                          ['find', 100],
                                          ['focus', 60],
                                          ['key', 40],
                                      ]
                            );
                        }
                    } finally {
                        restore();
                        restoreCdp();
                        restoreDriver();
                        restoreClock();
                    }
                });
            });
        }
    }
});

test('C-V16 editor actions consume only the budget left after coordinate focus', async (t) => {
    for (const mode of ['extension', 'cdp']) {
        for (const expires of [false, true]) {
            await t.test(`${mode}-${expires}`, () =>
                withPageFixture(mode, async ({ unified, driver }) => {
                    let now = 1000;
                    const budgets = [];
                    const focus = async (_code, _args, timeout) => {
                        budgets.push(['focus', timeout]);
                        now += expires ? timeout : 20;
                        return true;
                    };
                    const restoreClock = patchProperties(Date, { now: () => now });
                    const restoreDriver = patchProperties(driver, {
                        find: async () => {
                            now += 40;
                            return [{ refId: 'ref_owned' }];
                        },
                    });
                    const restoreCdp = mode === 'cdp' ? patchProperties(getSession(), { evaluate: focus }) : () => {};
                    const restore = patchProperties(unified, {
                        inputMode: 'precise',
                        evaluate: async (code, options, timeout, args) => {
                            if (!args) {
                                return focus(code, options, timeout);
                            }
                            budgets.push(['editor', timeout]);
                            return { success: true };
                        },
                        mouseMove: () => assert.fail('editor focus must not move'),
                        mouseClick: () => assert.fail('editor focus must not click'),
                    });
                    try {
                        const response = await registeredTool(registerInputTool)({
                            expectedRevision: 'r101',
                            timeout: 100,
                            events: [{ type: 'editorContext', target: { x: 50, y: 60 } }],
                        });
                        assert.equal(response.isError, expires ? true : undefined, response.content[0].text);
                        assert.deepEqual(
                            budgets,
                            expires
                                ? [['focus', mode === 'cdp' ? 100 : 60]]
                                : [
                                      ['focus', mode === 'cdp' ? 100 : 60],
                                      ['editor', mode === 'cdp' ? 80 : 40],
                                  ]
                        );
                    } finally {
                        restore();
                        restoreCdp();
                        restoreDriver();
                        restoreClock();
                    }
                })
            );
        }
    }
});

test('C10 coordinate selection stops when movement expires', async (t) => {
    for (const route of ['precise', 'stealth', 'cdp']) {
        for (const event of [
            { type: 'select', find: 'owned' },
            { type: 'replace', find: 'owned', text: 'replacement' },
        ]) {
            await t.test(`${route}-${event.type}`, async () => {
                await withPageFixture(route === 'cdp' ? 'cdp' : 'extension', async ({ unified, state }) => {
                    let now = 1000;
                    const moves = [];
                    const actions = [];
                    const restoreClock = patchProperties(Date, { now: () => now });
                    const restore = patchProperties(unified, {
                        inputMode: route,
                        mouseMove: async (_x, _y, timeout) => {
                            moves.push(timeout);
                            now += 100;
                        },
                        mouseClick: async () => actions.push('click'),
                        keyDown: async () => actions.push('key'),
                        evaluate: async () => {
                            actions.push('evaluate');
                            return null;
                        },
                    });
                    try {
                        const response = await registeredTool(registerInputTool)({
                            expectedRevision: 'r101',
                            timeout: 100,
                            events: [
                                { ...event, target: { x: 50, y: 60 } },
                                { type: 'keydown', key: 'Enter' },
                            ],
                        });
                        const body = JSON.parse(response.content[0].text);
                        assert.equal(response.isError, true);
                        assert.match(body.error.message, /timeout/i);
                        assert.deepEqual(moves, [100]);
                        assert.deepEqual(actions, []);
                        assert.deepEqual(state.dispatched, []);
                        assert.equal(body.eventsExecuted, 0);
                        assert.equal(body.actionStatus, 'unknown');
                        assert.equal(body.retryable, false);
                    } finally {
                        restore();
                        restoreClock();
                    }
                });
            });
        }
    }
});

test('C10 selection shares movement budgets and always releases Shift without hiding action errors', async (t) => {
    for (const route of ['precise', 'stealth', 'cdp']) {
        for (const scenario of [
            'first-move',
            'second-move',
            'action-and-release-fail',
            'release-fails',
            'shift-down-fails',
            'success',
            'input',
            'range',
        ]) {
            await t.test(`${route}-${scenario}`, async () => {
                await withPageFixture(route === 'cdp' ? 'cdp' : 'extension', async ({ unified, state }) => {
                    let now = 1000;
                    const moves = [];
                    const keys = [];
                    const errors = [];
                    let clicks = 0;
                    const restoreClock = patchProperties(Date, { now: () => now });
                    const restoreConsole = patchProperties(console, { error: (...args) => errors.push(args) });
                    const restore = patchProperties(unified, {
                        inputMode: route,
                        getFrameOffset: () => null,
                        evaluate: async (code, _options, timeout) => {
                            if (!code.includes('function(findText, nth')) {
                                return null;
                            }
                            assert.equal(
                                timeout,
                                scenario === 'success' ||
                                    scenario === 'release-fails' ||
                                    scenario === 'shift-down-fails'
                                    ? 200
                                    : 100
                            );
                            now += 20;
                            return scenario === 'input' || scenario === 'range'
                                ? { type: scenario }
                                : {
                                      type: 'coords',
                                      startX: 10,
                                      startY: 20,
                                      endX: 30,
                                      endY: 40,
                                  };
                        },
                        mouseMove: async (_x, _y, timeout) => {
                            moves.push(timeout);
                            now += scenario === 'first-move' ? 80 : 40;
                        },
                        mouseClick: async () => {
                            ++clicks;
                        },
                        keyDown: async (key) => {
                            keys.push(['down', key]);
                            if (scenario === 'shift-down-fails') {
                                throw new Error('owned Shift press failure');
                            }
                        },
                        keyUp: async (key) => {
                            keys.push(['up', key]);
                            if (scenario === 'action-and-release-fail' || scenario === 'release-fails') {
                                throw new Error('owned Shift release failure');
                            }
                        },
                    });
                    try {
                        const completed = ['success', 'input', 'range'].includes(scenario);
                        const response = await registeredTool(registerInputTool)({
                            expectedRevision: 'r101',
                            timeout: ['success', 'release-fails', 'shift-down-fails'].includes(scenario) ? 200 : 100,
                            events: [{ type: 'select', find: 'owned' }],
                        });
                        const body = JSON.parse(response.content[0].text);
                        assert.equal(response.isError, completed ? undefined : true, response.content[0].text);
                        assert.equal(body.eventsExecuted, completed ? 1 : 0);
                        if (!completed) {
                            assert.match(
                                body.error.message,
                                scenario === 'release-fails'
                                    ? /Shift release failure/
                                    : scenario === 'shift-down-fails'
                                      ? /Shift press failure/
                                      : /timeout/i
                            );
                            assert.equal(
                                body.actionStatus,
                                ['release-fails', 'shift-down-fails'].includes(scenario) ? 'failed' : 'unknown'
                            );
                            assert.equal(body.retryable, false);
                        }
                        assert.deepEqual(
                            moves,
                            ['input', 'range'].includes(scenario)
                                ? []
                                : scenario === 'first-move'
                                  ? [80]
                                  : scenario === 'shift-down-fails'
                                    ? [180]
                                    : scenario === 'success' || scenario === 'release-fails'
                                      ? [180, 140]
                                      : [80, 40]
                        );
                        assert.equal(
                            clicks,
                            ['input', 'range'].includes(scenario) || scenario === 'first-move'
                                ? 0
                                : scenario === 'success' || scenario === 'release-fails'
                                  ? 2
                                  : 1
                        );
                        assert.deepEqual(
                            keys,
                            ['input', 'range', 'first-move'].includes(scenario)
                                ? []
                                : [
                                      ['down', 'Shift'],
                                      ['up', 'Shift'],
                                  ]
                        );
                        assert.equal(errors.length, scenario === 'action-and-release-fail' ? 1 : 0);
                        if (errors.length) {
                            assert.match(String(errors[0][1]), /owned Shift release failure/);
                        }
                        assert.deepEqual(state.dispatched, []);
                    } finally {
                        restore();
                        restoreConsole();
                        restoreClock();
                    }
                });
            });
        }
    }
});

test('C10 replace stops before mutation when selection polling exhausts the event budget', async (t) => {
    for (const timeout of [100, 200]) {
        await t.test(`${timeout}ms`, async () =>
            withPageFixture('extension', async ({ unified }) => {
                let now = 1000;
                let mutations = 0;
                const budgets = [];
                const restoreClock = patchProperties(Date, { now: () => now });
                const restore = patchProperties(unified, {
                    evaluate: async (code, _options, timeout) => {
                        budgets.push(timeout);
                        if (code.includes('function(findText, replacementText')) {
                            now += 20;
                            return { handled: false };
                        }
                        if (code.includes('function(findText, nth')) {
                            now += 20;
                            return { type: 'input' };
                        }
                        if (
                            code.includes('var hasSelection') ||
                            code.includes('return el.selectionStart !== el.selectionEnd')
                        ) {
                            now += 60;
                            return true;
                        }
                        if (code.includes('function(replacementText)')) {
                            ++mutations;
                            return 'ok';
                        }
                        throw new Error('unexpected selection script');
                    },
                });
                try {
                    const response = await registeredTool(registerInputTool)({
                        expectedRevision: 'r101',
                        timeout,
                        events: [{ type: 'replace', find: 'owned', text: 'replacement' }],
                    });
                    const body = JSON.parse(response.content[0].text);
                    assert.equal(response.isError, timeout === 100 ? true : undefined, response.content[0].text);
                    if (timeout === 100) {
                        assert.match(body.error.message, /timeout/i);
                    }
                    assert.deepEqual(budgets, timeout === 100 ? [100, 80, 60] : [200, 180, 160, 100]);
                    assert.equal(mutations, timeout === 100 ? 0 : 1);
                    assert.equal(body.eventsExecuted, timeout === 100 ? 0 : 1);
                    assert.equal(body.actionStatus, timeout === 100 ? 'unknown' : 'completed');
                } finally {
                    restore();
                    restoreClock();
                }
            })
        );
    }
});

test('C10 touch movement stops before subsequent touch points and events', async (t) => {
    for (const humanize of [false, true]) {
        await t.test(humanize ? 'humanized' : 'direct', async () => {
            await withPageFixture('cdp', async ({ state }) => {
                let now = 1000;
                let moves = 0;
                const restoreClock = patchProperties(Date, { now: () => now });
                const restore = patchProperties(getSession(), {
                    getBehaviorSimulator: () => ({ getCurrentPosition: () => ({ x: 0, y: 0 }) }),
                    touchMove: async () => {
                        ++moves;
                        now += 100;
                    },
                });
                try {
                    const response = await registeredTool(registerInputTool)({
                        expectedRevision: 'r101',
                        timeout: 100,
                        humanize,
                        events: [
                            { type: 'touchmove', target: { x: 50, y: 60 }, steps: 3 },
                            { type: 'keydown', key: 'Enter' },
                        ],
                    });
                    const body = JSON.parse(response.content[0].text);
                    assert.equal(response.isError, true);
                    assert.match(body.error.message, /timeout/i);
                    assert.equal(moves, 1);
                    assert.deepEqual(state.dispatched, []);
                    assert.equal(body.eventsExecuted, 0);
                    assert.equal(body.actionStatus, 'unknown');
                } finally {
                    restore();
                    restoreClock();
                }
            });
        });
    }
});

test('C10 typing budget reaches each backend after focus preparation', async (t) => {
    for (const route of ['precise', 'stealth', 'cdp']) {
        await t.test(route, async () => {
            await withPageFixture(route === 'cdp' ? 'cdp' : 'extension', async ({ unified, driver }) => {
                let now = 1000;
                const calls = [];
                const type = async (text, delay, timeout) => calls.push({ text, delay, timeout });
                const evaluate = async () => {
                    now += 100;
                    return true;
                };
                const restoreClock = patchProperties(Date, { now: () => now });
                const restoreUnified = patchProperties(unified, { inputMode: route, evaluate });
                const restoreCdp = route === 'cdp' ? patchProperties(getSession(), { evaluate, type }) : () => {};
                Object.assign(driver, { inputType: type, stealthType: type });
                try {
                    const response = await registeredTool(registerInputTool)({
                        targetId: '101',
                        expectedUrl: 'https://example.com/101',
                        timeout: 500,
                        events: [{ type: 'type', text: 'owned', delay: 10 }],
                    });
                    assert.equal(response.isError, undefined, response.content[0].text);
                    assert.deepEqual(calls, [{ text: 'owned', delay: 10, timeout: 400 }]);
                } finally {
                    restoreCdp();
                    restoreUnified();
                    restoreClock();
                }
            });
        });
    }
});

test('C10 humanized typing stops at the shared deadline without replaying the event', async (t) => {
    for (const route of ['precise', 'stealth', 'cdp']) {
        await t.test(route, async () => {
            await withPageFixture(route === 'cdp' ? 'cdp' : 'extension', async ({ unified, driver, state }) => {
                let now = 1000;
                const calls = [];
                const type = async (text, delay, timeout) => {
                    calls.push({ text, delay, timeout });
                    now += 200;
                };
                const evaluate = async () => true;
                const restoreClock = patchProperties(Date, { now: () => now });
                const restoreUnified = patchProperties(unified, { inputMode: route, evaluate });
                const restoreCdp = route === 'cdp' ? patchProperties(getSession(), { evaluate, type }) : () => {};
                Object.assign(driver, { inputType: type, stealthType: type });
                try {
                    const response = await registeredTool(registerInputTool)({
                        targetId: '101',
                        expectedUrl: 'https://example.com/101',
                        timeout: 100,
                        humanize: true,
                        events: [
                            { type: 'type', text: 'abc' },
                            { type: 'keydown', key: 'Enter' },
                        ],
                    });
                    const body = JSON.parse(response.content[0].text);
                    assert.equal(response.isError, true);
                    assert.equal(calls.length, 1);
                    assert.deepEqual(calls[0], { text: 'a', delay: 0, timeout: 100 });
                    assert.equal(body.eventsExecuted, 0);
                    assert.equal(body.actionExecuted, true);
                    assert.equal(body.actionStatus, 'unknown');
                    assert.equal(body.retryable, false);
                    assert.deepEqual(state.dispatched, []);
                } finally {
                    restoreCdp();
                    restoreUnified();
                    restoreClock();
                }
            });
        });
    }
});

test('C10 partial input remains non-retryable after event or restoration timeouts', async (t) => {
    for (const scenario of ['next-event', 'frame-restoration']) {
        await t.test(scenario, async () => {
            await withPageFixture('extension', async ({ unified, driver }) => {
                let now = 1000;
                const restoreClock = patchProperties(Date, { now: () => now });
                const restoreUnified = patchProperties(unified, {
                    inputMode: 'precise',
                    evaluate: async () => true,
                    withFrame: async (_frame, run) => {
                        const result = await run();
                        if (scenario === 'frame-restoration') {
                            throw new TimeoutError('frame restoration timeout');
                        }
                        return result;
                    },
                });
                driver.inputType = async () => {
                    if (scenario === 'frame-restoration') {
                        throw new TimeoutError('input timeout during typing');
                    }
                    now += 200;
                };
                try {
                    const response = await registeredTool(registerInputTool)({
                        targetId: '101',
                        expectedUrl: 'https://example.com/101',
                        timeout: 100,
                        events: [
                            { type: 'type', text: 'owned' },
                            { type: 'type', text: 'not-dispatched' },
                        ],
                    });
                    const body = JSON.parse(response.content[0].text);
                    assert.equal(response.isError, true);
                    assert.equal(body.eventsExecuted, scenario === 'next-event' ? 1 : 0);
                    assert.equal(body.actionExecuted, true);
                    assert.equal(body.actionStatus, scenario === 'next-event' ? 'failed' : 'unknown');
                    assert.equal(body.retryable, false);
                } finally {
                    restoreUnified();
                    restoreClock();
                }
            });
        });
    }
});

test('C10 humanized typing normalizes CRLF before dispatching individual characters', async (t) => {
    for (const route of ['precise', 'stealth', 'cdp']) {
        await t.test(route, async () => {
            await withPageFixture(route === 'cdp' ? 'cdp' : 'extension', async ({ unified, driver }) => {
                const calls = [];
                const type = async (text) => calls.push(text);
                const evaluate = async () => true;
                const restoreUnified = patchProperties(unified, { inputMode: route, evaluate });
                const restoreCdp = route === 'cdp' ? patchProperties(getSession(), { evaluate, type }) : () => {};
                Object.assign(driver, { inputType: type, stealthType: type });
                try {
                    const response = await registeredTool(registerInputTool)({
                        targetId: '101',
                        expectedUrl: 'https://example.com/101',
                        timeout: 5000,
                        humanize: true,
                        events: [{ type: 'type', text: 'a\r\nb\rc', delay: 1 }],
                    });
                    assert.equal(response.isError, undefined, response.content[0].text);
                    assert.deepEqual(calls, ['a', '\n', 'b', '\n', 'c']);
                } finally {
                    restoreCdp();
                    restoreUnified();
                }
            });
        });
    }
});

test('C10 CDP typing releases keys after a keydown acknowledgement timeout', async (t) => {
    for (const text of ['a', '\n']) {
        await t.test(JSON.stringify(text), async () => {
            const session = getSession();
            const calls = [];
            const failure = new TimeoutError('original keydown timeout');
            const restore = patchProperties(session, {
                ensureSession() {},
                send: async (_method, params) => {
                    calls.push(params);
                    if (params.type === 'keyDown') {
                        throw failure;
                    }
                },
            });
            try {
                await assert.rejects(
                    () => session.type(text, 0, 100),
                    (error) => error === failure
                );
                assert.deepEqual(
                    calls.map((params) => params.type),
                    ['keyDown', 'keyUp']
                );
                calls.length = 0;
                await assert.rejects(() => session.type(text, 0, 0), /timeout|超时/i);
                assert.deepEqual(calls, []);
            } finally {
                restore();
            }
        });
    }
});

test('C10 typing RPC uses the caller budget and an execution deadline', async (t) => {
    for (const method of ['inputType', 'stealthType']) {
        await t.test(method, async () => {
            const bridge = new ExtensionBridge();
            bridge.currentTabId = 101;
            bridge.currentFrameId = 3;
            const calls = [];
            const restore = patchProperties(bridge.httpServer, {
                sendCommand: async (action, params, timeout) => {
                    calls.push({ action, params, timeout });
                    return { success: true };
                },
            });
            try {
                const started = Date.now();
                await bridge[method]('owned', 100, 45000);
                assert.equal(calls.length, 1);
                assert.equal(calls[0].timeout, 45000);
                assert.ok(calls[0].params.deadline >= started + 45000);
                assert.ok(calls[0].params.deadline <= Date.now() + 45000);
                assert.equal(calls[0].params.tabId, 101);
                assert.equal(calls[0].params.text, 'owned');
                if (method === 'stealthType') {
                    assert.equal(calls[0].params.frameId, 3);
                }
            } finally {
                restore();
            }
        });
    }
});

test('C10 CDP typing stops subsequent characters and preserves normalized Enter events', async () => {
    const session = getSession();
    let now = 1000;
    const calls = [];
    const restoreClock = patchProperties(Date, { now: () => now });
    const restore = patchProperties(session, {
        ensureSession() {},
        send: async (method, params, timeout) => {
            calls.push({ method, params, timeout });
            now += 10;
        },
    });
    try {
        await session.inputType('a\r\nb\rc', 0, 500);
        assert.equal(calls.filter((call) => call.params.type === 'char').length, 2);
        assert.equal(calls.filter((call) => call.params.key === 'Enter').length, 6);
        assert.ok(calls.every((call) => call.timeout > 0 && call.timeout <= 500));
        calls.length = 0;
        await assert.rejects(() => session.inputType('abc', 0, 15), /timeout|超时/i);
        assert.equal(calls.filter((call) => call.params.type === 'keyDown').length, 1);
        assert.equal(calls.at(-1).params.type, 'keyUp');
    } finally {
        restore();
        restoreClock();
    }
});

test(
    'C5 explicit file output has a bounded object budget without relaxing ' + 'inline, node, depth or cycle limits',
    async (t) => {
        for (const route of ['expression', 'arguments', 'arguments-fallback']) {
            for (const fileOutput of [false, true]) {
                await t.test(`${route}/${fileOutput ? 'file' : 'inline'}`, async (t) => {
                    await withPageFixture('extension', async ({ driver }) => {
                        const fixture = '字😀'.repeat(400000);
                        let executions = 0;
                        const released = [];
                        Object.assign(driver, {
                            getCurrentFrameId: () => 0,
                            debuggerSend: async (method, params) => {
                                if (method === 'Runtime.releaseObject') {
                                    released.push(params.objectId);
                                    return {};
                                }
                                if (method === 'Runtime.getProperties') {
                                    return {
                                        result: [
                                            {
                                                name: 'fixture',
                                                enumerable: true,
                                                value: { type: 'string', value: fixture },
                                            },
                                            {
                                                name: 'count',
                                                enumerable: true,
                                                value: { type: 'number', value: executions },
                                            },
                                        ],
                                    };
                                }
                                if (method === 'Runtime.evaluate' && params.expression === 'globalThis') {
                                    return {
                                        result: route.endsWith('fallback')
                                            ? { type: 'object' }
                                            : { type: 'object', objectId: 'global' },
                                    };
                                }
                                assert(['Runtime.evaluate', 'Runtime.callFunctionOn'].includes(method));
                                executions++;
                                return { result: { type: 'object', objectId: 'result' } };
                            },
                        });
                        const scoped = await resolveScopedOutputPath(
                            `tmp:c5-${randomUUID()}/result.json`,
                            'mcp-chrome'
                        );
                        t.after(() => rm(dirname(scoped.absolutePath), { recursive: true, force: true }));
                        const run = registeredTool(registerEvaluateTool);
                        const response = await run({
                            script: route === 'expression' ? '({fixture: "owned"})' : '(value) => ({fixture: value})',
                            ...(route === 'expression' ? {} : { args: ['owned'] }),
                            ...(fileOutput ? { output: scoped.absolutePath } : {}),
                            targetId: '202',
                            expectedRevision: 'r202',
                        });
                        const body = JSON.parse(response.content[0].text);
                        assert.equal(executions, 1);
                        assert(released.includes('result'));
                        if (fileOutput) {
                            assert.equal(response.isError, undefined);
                            assert.equal(body.output, scoped.absolutePath);
                            assert.deepEqual(JSON.parse(await readFile(body.output, 'utf8')), { fixture, count: 1 });
                            if (process.platform !== 'win32') {
                                assert.equal((await stat(body.output)).mode & 0o077, 0);
                            }
                            assert(Buffer.byteLength(response.content[0].text) < 4000);
                        } else {
                            assert.equal(response.isError, true);
                            assert.equal(body.error.code, 'EVALUATE_RESULT_TOO_LARGE');
                            assert.equal(body.error.context.maxChars, 1_000_000);
                            assert.equal(body.actionStatus, 'completed');
                            assert.equal(body.failureStage, 'output');
                            assert.equal(body.retryable, false);
                            await assert.rejects(() => stat(scoped.absolutePath), { code: 'ENOENT' });
                        }
                    });
                });
            }
        }
        for (const scenario of ['chars', 'nodes', 'depth', 'cycle']) {
            await t.test(`file/${scenario}`, async () => {
                const unified = getUnifiedSession();
                const released = [];
                const restore = patchProperties(unified, {
                    extensionBridge: {
                        debuggerSend: async (method, params) => {
                            if (method === 'Runtime.releaseObject') {
                                released.push(params.objectId);
                                return {};
                            }
                            assert.equal(method, 'Runtime.getProperties');
                            const value =
                                scenario === 'cycle'
                                    ? { type: 'object', objectId: '0' }
                                    : scenario === 'depth'
                                      ? { type: 'object', objectId: String(Number(params.objectId) + 1) }
                                      : {
                                            type: 'string',
                                            value: scenario === 'chars' ? 'x'.repeat(16 * 1024 * 1024) : 'x',
                                        };
                            return {
                                result: Array.from({ length: scenario === 'nodes' ? 2000 : 1 }, (_, i) => ({
                                    name: `value-${i}`,
                                    enumerable: true,
                                    value,
                                })),
                            };
                        },
                    },
                });
                try {
                    await assert.rejects(
                        () => unified.materializeCdpResult({ type: 'object', objectId: '0' }, undefined, true),
                        (error) => {
                            const response = JSON.parse(formatErrorResponse(error).content[0].text);
                            if (scenario === 'cycle') {
                                assert.equal(response.error.code, 'NON_SERIALIZABLE_EVALUATE_RESULT');
                            } else {
                                assert.equal(response.error.code, 'EVALUATE_RESULT_TOO_LARGE');
                                assert.equal(response.error.context.exceeded, scenario);
                                assert.equal(response.error.context.maxChars, 16 * 1024 * 1024);
                                assert.equal(response.error.context.maxNodes, 2000);
                                assert.equal(response.error.context.maxDepth, 8);
                            }
                            return true;
                        }
                    );
                    assert(released.includes('0'));
                } finally {
                    restore();
                }
            });
        }
    }
);

test(
    'C7 frame diagnostics survive page context wrapping without replacing typed ' + 'errors or retaining frame state',
    async () => {
        await withPageFixture('extension', async ({ unified, driver }) => {
            let frameId = 0;
            Object.assign(driver, {
                resolveFrame: async () => ({
                    frameId: 3,
                    offset: { x: 1, y: 2 },
                    frameContext: {
                        extensionFrameId: 3,
                        domIndex: 0,
                        url: 'about:srcdoc',
                        documentId: 'owned-document',
                    },
                }),
                getCurrentFrameId: () => frameId,
                setCurrentFrameId: (value) => {
                    frameId = value;
                },
            });
            const error = new EvaluateResultTooLargeError({
                exceeded: 'chars',
                depth: 1,
                nodes: 4,
                chars: 2_000_000,
                maxDepth: 8,
                maxNodes: 2000,
                maxChars: 1_000_000,
            });
            await assert.rejects(
                () =>
                    withPageContext(unified, '202', () =>
                        unified.withFrame('#owned', async () => {
                            throw error;
                        })
                    ),
                (actual) => {
                    assert.equal(actual, error);
                    const payload = JSON.parse(formatErrorResponse(actual).content[0].text);
                    assert.equal(payload.error.code, 'EVALUATE_RESULT_TOO_LARGE');
                    assert.equal(payload.pageContext.targetId, '202');
                    assert.deepEqual(payload.pageContext.frameContext, {
                        selection: '#owned',
                        frameId: 3,
                        extensionFrameId: 3,
                        domIndex: 0,
                        url: 'about:srcdoc',
                        documentId: 'owned-document',
                    });
                    assert.equal(classifyEvaluateFailure(actual).failureStage, 'output');
                    return true;
                }
            );
            assert.equal(frameId, 0);
            assert.equal(unified.currentFrameOffset, null);
            assert.equal(unified.requireExtension, false);
            assert.equal(unified.getCurrentTargetId(), '101');
        });
    }
);

test('C-R8 function arguments and expression scripts preserve their protocol semantics', async (t) => {
    for (const route of ['cdp', 'precise', 'iframe', 'stealth', 'stealth-iframe']) {
        for (const scriptKind of ['expression', 'arguments', 'empty-arguments', 'bare-function']) {
            const withArgs = ['arguments', 'empty-arguments'].includes(scriptKind);
            await t.test(`${route}/${scriptKind}`, async () => {
                const unified = getUnifiedSession();
                const cdp = getSession();
                const calls = [];
                const scope = { invocationCount: 0 };
                const objects = new Map();
                let nextObjectId = 0;
                const remote = (value, returnByValue) => {
                    if (value === null) {
                        return { type: 'object', subtype: 'null', value: null };
                    }
                    const type = typeof value;
                    if (type !== 'object' && type !== 'function') {
                        return { type, value };
                    }
                    if (returnByValue) {
                        return type === 'function' ? { type } : { type, value: JSON.parse(JSON.stringify(value)) };
                    }
                    const objectId = `object-${nextObjectId++}`;
                    objects.set(objectId, value);
                    return { type, objectId, ...(Array.isArray(value) ? { subtype: 'array' } : {}) };
                };
                const send = async (method, params, timeout) => {
                    calls.push({ method, params, timeout });
                    if (method === 'Runtime.releaseObject') {
                        return {};
                    }
                    if (method === 'Runtime.getProperties') {
                        return {
                            result: Object.getOwnPropertyNames(objects.get(params.objectId)).map((name) => ({
                                name,
                                enumerable: true,
                                value: remote(objects.get(params.objectId)[name], false),
                            })),
                        };
                    }
                    if (method === 'Runtime.evaluate' && params.expression === 'globalThis') {
                        return { result: { type: 'object', objectId: 'global' } };
                    }
                    let value;
                    if (method === 'Runtime.callFunctionOn') {
                        scope.argumentsToPass = params.arguments.map((argument) => argument.value);
                        value = await runInNewContext(`(${params.functionDeclaration})(...argumentsToPass)`, scope);
                    } else {
                        assert.equal(method, 'Runtime.evaluate');
                        value = await runInNewContext(params.expression, scope);
                    }
                    return { result: remote(value, params.returnByValue) };
                };
                const bridge = {
                    getCurrentFrameId: () => (route.endsWith('iframe') ? 3 : 0),
                    debuggerSend: (method, params, _tabId, timeout) => send(method, params, timeout),
                    evaluateInFrame: async (frameId, expression, timeout, retry) => {
                        assert.equal(frameId, 3);
                        assert.equal(retry, 'never');
                        return send(
                            'Runtime.evaluate',
                            { expression, returnByValue: true, awaitPromise: true },
                            timeout
                        );
                    },
                    evaluate: async (expression, _tabId, timeout) => {
                        calls.push({ method: 'scripting', params: { expression }, timeout });
                        const value = await runInNewContext(expression, scope);
                        const serialized = JSON.stringify(value);
                        return serialized === undefined ? undefined : JSON.parse(serialized);
                    },
                };
                const restoreCdp = patchProperties(cdp, { ensureSession: () => {}, send });
                const restoreUnified = patchProperties(unified, {
                    extensionBridge: bridge,
                    ensureExtensionConnected: async () => route !== 'cdp',
                });
                try {
                    const args = scriptKind === 'empty-arguments' ? [] : [false, null, 'quote" and newline\n'];
                    const script = withArgs
                        ? 'async (...values) => { invocationCount++; return { values }; }'
                        : scriptKind === 'bare-function'
                          ? 'async () => { invocationCount++; return { value: 1 }; }'
                          : '(async () => { invocationCount++; return { value: 1 }; })()';
                    const evaluate = () =>
                        unified.evaluate(
                            script,
                            route.startsWith('stealth') ? 'stealth' : 'precise',
                            undefined,
                            withArgs ? args : undefined
                        );
                    if (scriptKind === 'bare-function' && ['cdp', 'iframe'].includes(route)) {
                        await assert.rejects(evaluate, /无法序列化/);
                    } else {
                        const result = await evaluate();
                        if (scriptKind !== 'bare-function') {
                            assert.deepEqual(result, withArgs ? { values: args } : { value: 1 });
                        }
                    }
                    assert.equal(scope.invocationCount, scriptKind === 'bare-function' ? 0 : 1);
                    const functionCalls = calls.filter((call) => call.method === 'Runtime.callFunctionOn');
                    assert.equal(functionCalls.length, withArgs && ['cdp', 'precise'].includes(route) ? 1 : 0);
                    if (functionCalls.length) {
                        assert.equal(functionCalls[0].params.functionDeclaration, script);
                        assert.deepEqual(
                            functionCalls[0].params.arguments,
                            args.map((value) => ({ value }))
                        );
                        assert.equal(functionCalls[0].params.awaitPromise, true);
                    }
                } finally {
                    restoreUnified();
                    restoreCdp();
                }
            });
        }
    }
});

test('C1 public creation failures never attribute the old default as a created page', async (t) => {
    for (const action of ['newPage', 'newWindow', 'launch']) {
        for (const known of [true, false]) {
            await t.test(`${action}/${known ? 'partial' : 'unknown'}`, async () => {
                await withPageFixture('extension', async ({ driver, state }) => {
                    driver.newPage = driver.newWindow = async () => {
                        if (known) {
                            state.targets.add('404');
                        }
                        throw new Error(
                            JSON.stringify({
                                error: {
                                    code: known ? 'CREATE_INCOMPLETE' : 'CREATE_RESULT_UNKNOWN',
                                    message: 'creation failure',
                                    context: {
                                        createdTargetId: known ? '404' : null,
                                        managed: known ? false : null,
                                        actionExecuted: known ? true : 'unknown',
                                        actionStatus: known ? 'partial' : 'unknown',
                                        failureStage: known ? 'storage' : 'rpc',
                                    },
                                },
                            })
                        );
                    };
                    const tool = registeredTool(action === 'launch' ? registerBrowseTool : registerManageTool);
                    const response = await tool({ action });
                    const body = JSON.parse(response.content[0].text);
                    assert.equal(response.isError, true);
                    assert.equal(body.pageContext.targetId, known ? '404' : null);
                    assert.equal(body.pageContext.targetSource, known ? 'created' : 'unconfirmed');
                    assert.equal(body.pageContext.defaultTargetIdBefore, '101');
                    assert.equal(body.pageContext.defaultTargetIdAfter, '101');
                    assert.equal(body.error.context.actionStatus, known ? 'partial' : 'unknown');
                    assert.equal(body.pageContext.after?.targetId ?? null, known ? '404' : null);
                });
            });
        }
    }
});

test('C1 CDP creation retains known identities after attach or navigation failure', async (t) => {
    for (const stage of ['create', 'attach', 'navigation']) {
        await t.test(stage, async () => {
            const session = getSession();
            const calls = [];
            const restore = patchProperties(session, {
                ensureConnected() {},
                cdp: {
                    send: async (method) => {
                        calls.push(method);
                        if (stage === 'create') {
                            throw new Error('response timeout');
                        }
                        return { targetId: 'created-cdp' };
                    },
                },
                attachToTargetInternal: async () => {
                    if (stage === 'attach') {
                        throw new Error('attach refused');
                    }
                },
                navigate: async () => {
                    throw new Error('navigation refused');
                },
            });
            try {
                await assert.rejects(
                    () => session.newPage('https://example.com/'),
                    (error) => {
                        const body = JSON.parse(formatErrorResponse(error).content[0].text).error;
                        assert.equal(body.context.createdTargetId, stage === 'create' ? null : 'created-cdp');
                        assert.equal(body.context.failureStage, stage);
                        assert.equal(body.context.actionStatus, stage === 'create' ? 'unknown' : 'partial');
                        assert.equal(body.context.actionExecuted, stage === 'create' ? 'unknown' : true);
                        assert.equal(body.context.managed, stage === 'create' ? null : false);
                        return true;
                    }
                );
                assert.deepEqual(calls, ['Target.createTarget']);
            } finally {
                restore();
            }
        });
    }
});

test('C2 public read grants retain explicit target, page conditions and bridge action names', async () => {
    const bridge = new ExtensionBridge();
    const calls = [];
    bridge.httpServer.sendCommand = async (action, params) => {
        calls.push({ action, params });
        return { success: true, targetId: String(params.tabId), allowed: params.allow };
    };
    await withPageFixture('extension', async ({ driver }) => {
        driver.setReadAccess = (id, allow) => bridge.setReadAccess(id, allow);
        const manage = registeredTool(registerManageTool);
        for (const action of ['grantReadAccess', 'revokeReadAccess']) {
            const response = await manage({ action, targetId: '202', expectedRevision: 'r202' });
            assert.notEqual(response.isError, true, response.content[0].text);
            const body = JSON.parse(response.content[0].text);
            assert.equal(body.allowed, action === 'grantReadAccess');
            assert.equal(body.pageContext.targetId, '202');
        }
        assert.deepEqual(calls, [
            { action: 'tabs_read_access', params: { tabId: 202, allow: true } },
            { action: 'tabs_read_access', params: { tabId: 202, allow: false } },
        ]);
        assert.equal((await manage({ action: 'grantReadAccess' })).isError, true);
    });
});

test('C3 list summaries, full details and filters share one topology without inline favicons', async () => {
    await withPageFixture('extension', async ({ unified, driver }) => {
        const targets = ['101', '202'].map((id, index) => ({
            id: Number(id),
            targetId: id,
            url: `https://example.com/${id}`,
            title: id,
            windowId: 9,
            groupId: 7,
            index,
            managed: index === 0,
            revision: `r${id}`,
            active: false,
            pinned: false,
            incognito: false,
            highlighted: false,
            muted: false,
            autoDiscardable: false,
            favIconUrl: 'data:image/png;base64,should-not-be-inlined',
        }));
        let topologyCalls = 0;
        const restore = patchProperties(unified, {
            listTopology: async () => {
                topologyCalls++;
                return {
                    windowCount: 1,
                    windows: [
                        {
                            id: 9,
                            focused: false,
                            incognito: false,
                            alwaysOnTop: false,
                            width: 800,
                            tabCount: 2,
                            tabs: targets,
                        },
                    ],
                    groups: [
                        {
                            id: 7,
                            windowId: 9,
                            title: '',
                            color: 'cyan',
                            collapsed: false,
                            targetIds: ['101', '202'],
                            tabIds: [101, 202],
                        },
                    ],
                };
            },
        });
        driver.listTargets = async () => {
            throw new Error('duplicate tab query');
        };
        try {
            const browse = registeredTool(registerBrowseTool);
            const run = async (args) => JSON.parse((await browse({ action: 'list', ...args })).content[0].text);
            const summary = await run({});
            assert.equal(summary.details, 'summary');
            assert.equal(summary.targets.length, 2);
            assert.equal(summary.targets[0].highlighted, undefined);
            assert.equal(summary.targets[0].managed, true);
            assert.equal(summary.targets[1].managed, false);
            assert.equal(summary.targets[0].revision, 'r101');
            assert.equal(summary.windows[0].tabs, undefined);
            assert.deepEqual(summary.windows[0].targetIds, ['101', '202']);
            const full = await run({ details: 'full' });
            for (const key of ['highlighted', 'muted', 'autoDiscardable', 'pinned']) {
                assert.equal(full.targets[0][key], false);
            }
            assert.equal(full.targets[0].favIconUrl, undefined);
            assert.equal(full.targets[0].favIconInline, true);
            assert.equal(full.windows[0].width, 800);
            assert.equal(full.windows[0].alwaysOnTop, false);
            assert.equal(JSON.stringify(full).includes('should-not-be-inlined'), false);
            const managed = await run({ managedOnly: true });
            assert.deepEqual(
                managed.targets.map((tab) => tab.targetId),
                ['101']
            );
            assert.deepEqual(managed.groups[0].targetIds, ['101']);
            assert.equal(managed.windows[0].totalTabCount, 2);
            assert.deepEqual(
                (await run({ targetIds: ['202'] })).targets.map((tab) => tab.targetId),
                ['202']
            );
            assert.equal((await run({ targetIds: ['202'], managedOnly: true })).targets.length, 0);
            assert.equal(topologyCalls, 5);
        } finally {
            restore();
        }
    });
});

test('C-R8 Extension creation errors preserve structured facts without retrying or deleting pages', async (t) => {
    for (const operation of ['newPage', 'newWindow']) {
        await t.test(operation, async () => {
            const bridge = new ExtensionBridge();
            const context = { createdTargetId: '202', createdWindowId: 9, managed: false, failureStage: 'storage' };
            const failure = new Error(
                JSON.stringify({
                    error: { code: 'PAGE_CREATION_FAILED', message: 'storage rejected', context },
                })
            );
            const calls = [];
            bridge.currentTabId = 101;
            bridge.httpServer.sendCommand = async (action, params) => {
                calls.push({ action, params });
                throw failure;
            };
            await assert.rejects(
                () => (operation === 'newPage' ? bridge.newPage() : bridge.newWindow({ focused: false })),
                (error) => {
                    const body = JSON.parse(formatErrorResponse(error).content[0].text).error;
                    assert.equal(body.code, 'PAGE_CREATION_FAILED');
                    assert.equal(body.message, 'storage rejected');
                    assert.deepEqual(body.context, {
                        action: operation === 'newPage' ? 'tabs_create' : 'window_create',
                        actionExecuted: true,
                        actionStatus: 'partial',
                        ...context,
                    });
                    return true;
                }
            );
            assert.equal(calls.length, 1);
            assert.equal(calls[0].action, operation === 'newPage' ? 'tabs_create' : 'window_create');
            assert.equal(bridge.getCurrentTargetId(), '101');
        });
    }
});

const successfulAction = () => ({ content: [{ type: 'text', text: '{"success":true}' }] });

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const typeBuffer = Buffer.from(type, 'ascii');
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    typeBuffer.copy(chunk, 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
    return chunk;
}

function makeRgbaPng(raw, width = 1, height = 1) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

async function withHttpServer(handler, run) {
    const server = createServer(handler);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(undefined));
    });
    const address = server.address();
    try {
        return await run(address.port);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test('C-R7 CDP visibility waits use CSS and DOM rectangles without masking protocol failures', async (t) => {
    for (const hidden of [
        { display: 'none', visibility: 'visible', width: 0, height: 0 },
        { display: 'block', visibility: 'hidden', width: 40, height: 20 },
        { display: 'block', visibility: 'collapse', width: 40, height: 20 },
        { display: 'block', visibility: 'visible', width: 0, height: 20 },
    ]) {
        for (const state of ['visible', 'hidden']) {
            await t.test(`${state}: ${JSON.stringify(hidden)}`, async () => {
                await withPageFixture('cdp', async () => {
                    let reads = 0;
                    const restore = patchProperties(getSession(), {
                        createLocator: () => ({
                            find: async () => 1,
                            getBoundingBox: async () => {
                                throw new CDPError('DOM.getBoxModel: Could not compute box model.');
                            },
                            evaluateOn: async (script) => {
                                ++reads;
                                const value =
                                    state === 'visible' && reads > 1
                                        ? { display: 'block', visibility: 'visible', width: 40, height: 20 }
                                        : hidden;
                                return runInNewContext(`(${script})`, {
                                    getComputedStyle: () => value,
                                }).call({ getBoundingClientRect: () => value });
                            },
                        }),
                    });
                    try {
                        const response = await registeredTool(registerWaitTool)({
                            for: 'element',
                            target: { css: '#delayed' },
                            state,
                            timeout: 1000,
                        });
                        assert.equal(response.isError, undefined, response.content[0].text);
                        assert.equal(JSON.parse(response.content[0].text).success, true);
                        assert.equal(reads, state === 'visible' ? 2 : 1);
                    } finally {
                        restore();
                    }
                });
            });
        }
    }
    await withPageFixture('cdp', async () => {
        const wait = registeredTool(registerWaitTool);
        let failure;
        const restore = patchProperties(getSession(), {
            createLocator: () => ({
                find: async () => {
                    if (failure) {
                        throw failure;
                    }
                    return 1;
                },
                evaluateOn: async () => {
                    if (failure) {
                        throw failure;
                    }
                    return false;
                },
            }),
        });
        try {
            const request = { for: 'element', target: { css: '#delayed' }, timeout: 20 };
            assert.equal((await wait({ ...request, state: 'attached' })).isError, undefined);
            let result = await wait({ ...request, state: 'visible' });
            assert.equal(JSON.parse(result.content[0].text).error.code, 'TIMEOUT');
            failure = new ElementNotFoundError(request.target, request.timeout);
            for (const state of ['hidden', 'detached']) {
                assert.equal((await wait({ ...request, state })).isError, undefined);
            }
            failure = new CDPError('connection lost');
            for (const state of ['visible', 'hidden']) {
                result = await wait({ ...request, state });
                assert.equal(JSON.parse(result.content[0].text).error.code, 'CDP_ERROR');
            }
        } finally {
            restore();
        }
    });
});

test('C-R4 AX queries use the document root and preserve substring, exact and nth matching', async (t) => {
    for (const [target, nth, expectedId] of [
        [{ role: 'button', name: 'Save' }, 0, 21],
        [{ role: 'button', name: 'Save' }, 1, 22],
        [{ role: 'button', name: 'Save', exact: true }, 0, 22],
        [{ role: 'button' }, 0, 20],
    ]) {
        await t.test(JSON.stringify({ target, nth }), async () => {
            const cdp = {
                async send(method, params) {
                    if (method === 'Accessibility.enable') {
                        return {};
                    }
                    if (method === 'DOM.getDocument') {
                        return { root: { nodeId: 7 } };
                    }
                    if (method === 'Accessibility.queryAXTree') {
                        assert.equal(params.nodeId, 7);
                        assert.equal(params.role, 'button');
                        assert.equal(params.accessibleName, target.exact ? 'Save' : undefined);
                        const nodes = ['Cancel', 'Save draft', 'Save'].map((name, i) => ({
                            name: { value: name },
                            role: { value: 'button' },
                            backendDOMNodeId: 20 + i,
                        }));
                        return { nodes: target.exact ? nodes.filter((node) => node.name.value === 'Save') : nodes };
                    }
                    if (method === 'DOM.pushNodesByBackendIdsToFrontend') {
                        return { nodeIds: params.backendNodeIds };
                    }
                    throw new Error(`unexpected ${method}`);
                },
            };
            assert.equal(await new Locator(cdp, target, 'session', { nth, timeout: 20 }).find(), expectedId);
        });
    }
});

test('C-R4 state injection preserves s characters and normalizes actual whitespace', async () => {
    const session = getSession();
    class Element {
        constructor(text) {
            this.textContent = text;
            this.id = text;
            this.tagName = 'BUTTON';
        }

        getAttribute() {
            return null;
        }

        getBoundingClientRect() {
            return { x: 1, y: 1, left: 1, top: 1, width: 10, height: 10 };
        }
    }
    const elements = ['Class  TestId\taccessible\nbutton', 'spaces'].map((text) => new Element(text));
    const document = {
        nodeType: 9,
        childNodes: elements,
        querySelector: () => elements[0],
        elementFromPoint: () => null,
    };
    for (const element of elements) {
        Object.assign(element, {
            nodeType: 1,
            childNodes: [{ nodeType: 3, textContent: element.textContent, childNodes: [] }],
            hasAttribute: () => false,
            matches: () => true,
            getRootNode: () => document,
        });
    }
    const getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
    const realm = createContext({
        Element,
        document,
        window: { getComputedStyle },
        getComputedStyle,
        CSS: { escape: (text) => text },
    });
    const restore = patchProperties(session, { evaluate: async (script) => runInContext(script, realm) });
    try {
        assert.deepEqual(
            Array.from(await session.collectInteractiveElements(), (item) => item.name),
            ['Class TestId accessible button', 'spaces']
        );
    } finally {
        restore();
    }
});

test('C-R4 CDP state preserves safe input values, hidden names and the requested root', async () => {
    const session = getSession();
    const reads = { hidden: 0, password: 0, file: 0 };
    class Element {
        constructor(type, attrs = {}) {
            this.type = type;
            this.attrs = attrs;
            this.id = `owned-${type}`;
            this.tagName = 'INPUT';
            this.nodeType = 1;
            this.childNodes = [];
            this.value = type === 'submit' ? 'Owned complete submit label '.repeat(12) : 'ordinary current value';
            if (type in reads) {
                Object.defineProperty(this, 'value', {
                    get() {
                        ++reads[type];
                        throw new Error('sensitive getter read');
                    },
                });
            }
        }

        getAttribute(name) {
            return this.attrs[name] ?? null;
        }

        hasAttribute(name) {
            return name in this.attrs;
        }

        getRootNode() {
            return document;
        }

        matches() {
            return true;
        }

        querySelector() {
            return null;
        }

        getBoundingClientRect() {
            const size = this.type === 'hidden' ? 0 : 10;
            return { x: 1, y: 1, left: 1, top: 1, width: size, height: size };
        }
    }
    const elements = [
        new Element('hidden', { 'aria-label': 'owned hidden' }),
        new Element('password', { placeholder: 'owned password' }),
        new Element('text'),
        new Element('file'),
        new Element('submit'),
        Object.assign(new Element('text', { 'aria-label': 'Owned named input' }), { id: 'owned-named-input' }),
    ];
    const document = {
        nodeType: 9,
        childNodes: elements,
        querySelector: () => elements[0],
        elementFromPoint: () => null,
    };
    const getComputedStyle = (el) => ({ display: el.type === 'hidden' ? 'none' : 'block', visibility: 'visible' });
    const realm = createContext({
        Element,
        document,
        window: { getComputedStyle },
        getComputedStyle,
        CSS: { escape: (value) => value },
    });
    const restore = patchProperties(session, {
        getPageState: async () => ({ viewport: { width: 800, height: 600 } }),
        evaluate: async (script) => runInContext(script, realm),
        createLocator: (target, options) => {
            assert.deepEqual(target, { css: '#owned-text' });
            assert.equal(options.timeout, 123);
            return { evaluateOn: async (script) => runInContext(`(${script})`, realm).call(elements[2]) };
        },
    });
    try {
        const state = await session.readPage();
        assert.equal(state.interactiveElements[0].name, 'owned hidden');
        assert.equal(state.interactiveElements[0].visible, false);
        assert.equal(state.interactiveElements[1].name, 'owned password');
        assert.equal(state.interactiveElements[2].name, '');
        assert.equal(state.interactiveElements[2].value, 'ordinary current value');
        assert.equal(state.interactiveElements[4].name, elements[4].value.trim());
        assert.equal(state.interactiveElements[5].name, 'Owned named input');
        assert.equal(state.interactiveElements[5].value, 'ordinary current value');
        assert.match(state.pageContent, /textbox "Owned named input" type="text" value="ordinary current value"/);
        assert.match(state.pageContent, /type="hidden"/);
        assert.match(state.pageContent, /value="ordinary current value"/);
        for (const index of [0, 1, 3]) {
            assert.equal(Object.hasOwn(state.interactiveElements[index], 'value'), false);
        }
        const scoped = await session.readPage({ target: { css: '#owned-text' }, depth: 0, timeout: 123 });
        assert.deepEqual(
            Array.from(scoped.interactiveElements, (item) => item.selector),
            ['#owned-text']
        );
        assert.equal(scoped.interactiveElements[0].value, 'ordinary current value');
        assert.doesNotMatch(scoped.pageContent, /owned hidden|owned password|Owned complete submit/);
        document.elementFromPoint = () => elements[2];
        const point = await session.readPage({ target: { x: 3, y: 5 }, depth: 0, timeout: 123 });
        assert.deepEqual(
            Array.from(point.interactiveElements, (item) => item.selector),
            ['#owned-text']
        );
        document.elementFromPoint = () => null;
        await assert.rejects(() => session.readPage({ target: { x: 3, y: 5 } }), ElementNotFoundError);
        assert.deepEqual(reads, { hidden: 0, password: 0, file: 0 });
    } finally {
        restore();
    }
});

test('C-R4 public CDP state forwards target, depth and timeout to the scoped reader', async () => {
    await withPageFixture('cdp', async () => {
        const cdp = getSession();
        const calls = [];
        const state = {
            pageContent: 'textbox value="owned"',
            viewport: { width: 800, height: 600 },
            interactiveElements: [],
        };
        const restore = patchProperties(cdp, {
            readPage: async (options) => {
                calls.push(options);
                return state;
            },
        });
        try {
            for (const target of [
                { css: '#owned-text' },
                { role: 'textbox', name: 'owned', nth: 1 },
                { xpath: '//input' },
                { x: 3, y: 5 },
            ]) {
                const response = await registeredTool(registerExtractTool)({
                    type: 'state',
                    target,
                    targetId: '202',
                    depth: 2,
                    timeout: 123,
                });
                const value = JSON.parse(response.content[0].text);
                assert.equal(response.isError, undefined, response.content[0].text);
                const { timeout, ...options } = calls.at(-1);
                assert.deepEqual(options, { target, depth: 2 });
                assert(timeout > 0 && timeout <= 123);
                assert.deepEqual(value.state, state);
                assert.equal(value.pageContext.defaultTargetIdBefore, '101');
                assert.equal(value.pageContext.defaultTargetIdAfter, '101');
            }
        } finally {
            restore();
        }
    });
});

test('controlled input failures include bounded focus diagnostics without reading values', async (t) => {
    for (const failure of ['missing', 'dispatch', 'probe']) {
        await t.test(failure, async () =>
            withPageFixture('extension', async ({ unified }) => {
                class HTMLInputElement {}
                const activeElement = Object.assign(new HTMLInputElement(), {
                    tagName: 'INPUT',
                    id: 'owned-active',
                    type: 'password',
                    isContentEditable: false,
                    getAttribute: () => null,
                });
                Object.defineProperty(activeElement, 'value', {
                    get() {
                        throw new Error('diagnostics must not read input values');
                    },
                });
                let probes = 0;
                const restore = patchProperties(unified, {
                    getLiveState: async () => ({ url: 'https://example.com/', managed: true }),
                    isExtensionConnected: () => true,
                    find: async () => (failure === 'dispatch' ? [{ refId: 'owned-input' }] : []),
                    dispatchInput: async () => ({ success: false, error: 'input is read-only' }),
                    evaluate: async (script, _unused, timeout) => {
                        ++probes;
                        assert.ok(timeout > 0 && timeout <= 1000);
                        if (failure === 'probe') {
                            throw new Error('owned diagnostic probe unavailable');
                        }
                        return runInNewContext(script, {
                            HTMLInputElement,
                            document: { activeElement, querySelectorAll: () => [] },
                        });
                    },
                });
                try {
                    const response = await registeredTool(registerInputTool)({
                        expectedRevision: 'r101',
                        events: [{ type: 'type', target: { css: '#owned-input' }, mode: 'controlled', text: 'abc' }],
                        timeout: 2000,
                    });
                    assert.equal(response.isError, true);
                    const { error } = JSON.parse(response.content[0].text);
                    assert.equal(error.code, failure === 'dispatch' ? 'CONTROLLED_INPUT_FAILED' : 'TARGET_NOT_FOUND');
                    assert.equal(error.context.matchCount, null);
                    assert.deepEqual(error.context.candidates, []);
                    assert.equal(probes, 1);
                    if (failure === 'probe') {
                        assert.equal(error.context.activeElement, null);
                        assert.match(error.context.diagnosticError, /owned diagnostic probe unavailable/);
                    } else {
                        assert.deepEqual(error.context.activeElement, {
                            tag: 'input',
                            id: 'owned-active',
                            inputType: 'password',
                            contentEditable: false,
                        });
                        assert.equal(error.context.diagnosticError, undefined);
                    }
                } finally {
                    restore();
                }
            })
        );
    }
});

test('CDP background stability sampling retains motion checks and deadlines', async (t) => {
    for (const [mode, axis] of [
        ['stable', 'x'],
        ['settles', 'x'],
        ['settles', 'y'],
        ['settles', 'width'],
        ['settles', 'height'],
        ['moving', 'x'],
    ]) {
        await t.test(`${mode}-${axis}`, async () => {
            let samples = 0;
            let animationFrames = 0;
            const timeouts = [];
            const timeout = mode === 'moving' ? 200 : 1000;
            const target = {
                getBoundingClientRect: () => {
                    const rect = { x: 10, y: 20, width: 100, height: 40 };
                    ++samples;
                    if (mode === 'moving' || (mode === 'settles' && samples === 1)) {
                        rect[axis] += samples;
                    }
                    return rect;
                },
            };
            const cdp = {
                send: async (method, params, sessionId, remaining) => {
                    assert.equal(sessionId, 'background');
                    assert.ok(remaining > 0 && remaining <= timeout);
                    timeouts.push(remaining);
                    if (method === 'DOM.resolveNode') {
                        return { object: { objectId: 'element' } };
                    }
                    assert.equal(method, 'Runtime.callFunctionOn');
                    assert.equal(params.objectId, 'element');
                    const value = runInNewContext(`(${params.functionDeclaration}).call(target)`, {
                        target,
                        requestAnimationFrame: () => {
                            ++animationFrames;
                        },
                    });
                    if (!params.awaitPromise) {
                        return { result: { value } };
                    }
                    let timer;
                    try {
                        return {
                            result: {
                                value: await Promise.race([
                                    value,
                                    new Promise((_, reject) => {
                                        timer = setTimeout(
                                            () => reject(new Error('CDP animation frame timeout')),
                                            remaining
                                        );
                                    }),
                                ]),
                            },
                        };
                    } finally {
                        globalThis.clearTimeout(timer);
                    }
                },
            };
            const wait = new AutoWait(cdp, 'background', { timeout });
            if (mode === 'moving') {
                await assert.rejects(wait.waitForStableBoundingBox(9), /元素位置不稳定/);
            } else {
                await wait.waitForStableBoundingBox(9);
                assert.equal(samples, mode === 'settles' ? 4 : 2);
            }
            assert.equal(animationFrames, 0);
            assert.ok(timeouts.every((value, index) => index === 0 || value <= timeouts[index - 1]));
        });
    }
});

test('CDP locator and actionability keep one input event budget', async (t) => {
    for (const [name, type, locatorTime, readinessTime, pointTime] of [
        ['click-remainder', 'click', 400, null, 0],
        ['type-remainder', 'type', 400, null, 0],
        ['locator-expired', 'click', 1000, 0, 0],
        ['readiness-expired', 'click', 400, 600, 0],
        ['point-expired', 'click', 400, 100, 500],
        ['within-budget', 'click', 400, 100, 100],
    ]) {
        await t.test(name, async () =>
            withPageFixture('cdp', async ({ state }) => {
                let now = 100000;
                let readinessTimeout;
                let pointRead = false;
                let response;
                const restoreClock = patchProperties(Date, { now: () => now });
                const restoreSession = patchProperties(getSession(), {
                    createLocator: (_target, options) => {
                        assert.equal(options.timeout, 800);
                        return {
                            find: async () => {
                                now += locatorTime;
                                return 9;
                            },
                            getClickablePoint: async () => {
                                pointRead = true;
                                now += pointTime;
                                return { x: 50, y: 60 };
                            },
                        };
                    },
                    createAutoWait: (options) => {
                        readinessTimeout = options.timeout;
                        const ready = async () => {
                            if (readinessTime === null) {
                                throw new Error('fixture readiness stopped');
                            }
                            now += readinessTime;
                        };
                        return { waitForClickable: ready, waitForInputReady: ready };
                    },
                    mouseMove: async () => state.dispatched.push('move'),
                    mouseDown: async () => state.dispatched.push('down'),
                    mouseUp: async () => state.dispatched.push('up'),
                });
                try {
                    response = await registeredTool(registerInputTool)({
                        expectedRevision: 'r101',
                        timeout: 1000,
                        events: [{ type, target: { css: '#owned-budget' }, ...(type === 'type' ? { text: 'x' } : {}) }],
                    });
                } finally {
                    restoreSession();
                    restoreClock();
                }
                assert.equal(readinessTimeout, locatorTime >= 1000 ? undefined : 1000 - locatorTime);
                const payload = JSON.parse(response.content[0].text);
                if (name === 'within-budget') {
                    assert.notEqual(response.isError, true, response.content[0].text);
                    assert.equal(payload.eventsExecuted, 1);
                    assert.deepEqual(state.dispatched, ['move', 'down', 'up']);
                } else {
                    assert.equal(response.isError, true);
                    assert.equal(payload.eventsExecuted, 0);
                    assert.equal(payload.actionExecuted, false);
                    assert.deepEqual(state.dispatched, []);
                    if (readinessTime !== null) {
                        assert.match(payload.error.message, /timeout before event dispatch/);
                    }
                }
                assert.equal(pointRead, ['point-expired', 'within-budget'].includes(name));
            })
        );
    }
});

test('C31F9 scroll settlement handles cascades, visibility changes and cleanup within one deadline', async (t) => {
    for (const scenario of [
        'cascade',
        'sibling',
        'two-siblings',
        'shadow-siblings',
        'foreign-shadow',
        'dynamic-shadow',
        'synchronous-repeat',
        'unrelated',
        'unrelated-reused',
        'geometry',
        'continuous-geometry',
        'hidden',
        'hide',
        'show',
        'continuous',
    ]) {
        await t.test(scenario, async () =>
            withPageFixture('extension', async ({ unified }) => {
                const listeners = new Map();
                const capturedScroll = new Set();
                const capturedScrollEnd = new Set();
                const timers = new Set();
                const frames = new Set();
                const moves = [];
                let rendered = 0;
                let closed = 0;
                let left = 80;
                const document = Object.assign(new globalThis.EventTarget(), {
                    visibilityState: ['hidden', 'show'].includes(scenario) ? 'hidden' : 'visible',
                });
                const shadow = new globalThis.EventTarget();
                const element = Object.assign(new globalThis.EventTarget(), {
                    isConnected: true,
                    ownerDocument: document,
                    scrollLeft: 0,
                    scrollTop: 0,
                    getRootNode: () => (scenario === 'shadow-siblings' ? shadow : document),
                    getBoundingClientRect: () => ({
                        x: left,
                        y: 2100 - window.scrollY,
                        width: 80,
                        height: 70,
                        top: 2100 - window.scrollY,
                        bottom: 2170 - window.scrollY,
                        left,
                        right: left + 80,
                    }),
                    scrollIntoView() {
                        window.scrollY = 1900;
                    },
                });
                const window = Object.assign(new globalThis.EventTarget(), {
                    __mcpElementMap: { owned: new WeakRef(element) },
                    innerWidth: 800,
                    innerHeight: 600,
                    scrollX: 0,
                    scrollY: 0,
                });
                const unrelated = Object.assign(new globalThis.EventTarget(), { scrollLeft: 0, scrollTop: 0 });
                const reusedScroll = { target: unrelated, currentTarget: document };
                const __mcpDomHelpers = {
                    elements: () =>
                        scenario === 'dynamic-shadow' && rendered === 0 ? [element] : [element, { shadowRoot: shadow }],
                };
                for (const target of [window, document, element, shadow]) {
                    const add = target.addEventListener.bind(target);
                    const remove = target.removeEventListener.bind(target);
                    const captureRoot = ['shadow-siblings', 'foreign-shadow', 'dynamic-shadow'].includes(scenario)
                        ? shadow
                        : document;
                    target.addEventListener = (type, callback, capture) => {
                        listeners.set(callback, (listeners.get(callback) ?? 0) + 1);
                        if (target === captureRoot && type === 'scroll' && capture === true) {
                            capturedScroll.add(callback);
                        }
                        if (target === captureRoot && type === 'scrollend' && capture === true) {
                            capturedScrollEnd.add(callback);
                        }
                        add(type, callback, capture);
                    };
                    target.removeEventListener = (type, callback, capture) => {
                        if (target === captureRoot && type === 'scroll' && capture === true) {
                            capturedScroll.delete(callback);
                        }
                        if (target === captureRoot && type === 'scrollend' && capture === true) {
                            capturedScrollEnd.delete(callback);
                        }
                        const remaining = listeners.get(callback) - 1;
                        if (remaining) {
                            listeners.set(callback, remaining);
                        } else {
                            listeners.delete(callback);
                        }
                        remove(type, callback, capture);
                    };
                }
                const setTimer = (callback, ms) => {
                    const timer = setTimeout(() => {
                        timers.delete(timer);
                        callback();
                    }, ms);
                    timers.add(timer);
                    return timer;
                };
                const clearTimer = (timer) => {
                    timers.delete(timer);
                    globalThis.clearTimeout(timer);
                };
                class Channel extends globalThis.MessageChannel {
                    constructor() {
                        super();
                        for (const port of [this.port1, this.port2]) {
                            const close = port.close.bind(port);
                            port.close = () => {
                                ++closed;
                                close();
                            };
                        }
                        const post = this.port2.postMessage.bind(this.port2);
                        this.port2.postMessage = (data) => {
                            if (scenario === 'show' && document.visibilityState === 'hidden') {
                                document.visibilityState = 'visible';
                                document.dispatchEvent(new globalThis.Event('visibilitychange'));
                            }
                            post(data);
                        };
                    }
                }
                const requestAnimationFrame = (callback) => {
                    const frame = setTimer(() => {
                        frames.delete(frame);
                        ++rendered;
                        if (scenario === 'continuous' || (scenario === 'cascade' && rendered <= 2)) {
                            window.scrollY += 30;
                            left = rendered === 1 ? 140 : 240;
                            document.dispatchEvent(new globalThis.Event('scroll'));
                        }
                        if (
                            ['sibling', 'two-siblings', 'shadow-siblings', 'foreign-shadow', 'dynamic-shadow'].includes(
                                scenario
                            )
                        ) {
                            const lastScroll = scenario === 'sibling' ? 2 : 3;
                            if (rendered === lastScroll) {
                                left = 240;
                            }
                            if (rendered <= lastScroll) {
                                const target = new globalThis.EventTarget();
                                for (const listener of capturedScroll) {
                                    listener({ target });
                                }
                            }
                        }
                        if (scenario === 'synchronous-repeat' && rendered <= 3) {
                            const event = { target: unrelated, currentTarget: window };
                            for (const listener of capturedScroll) {
                                listener(event);
                            }
                            unrelated.scrollTop += 10;
                            event.currentTarget = document;
                            for (const listener of capturedScroll) {
                                listener(event);
                            }
                            for (const listener of capturedScrollEnd) {
                                listener({ target: unrelated });
                            }
                            if (rendered === 3) {
                                left = 240;
                            }
                        }
                        if (['unrelated', 'unrelated-reused', 'geometry', 'continuous-geometry'].includes(scenario)) {
                            unrelated.scrollTop += 10;
                            if (scenario === 'geometry' && rendered <= 2) {
                                left = rendered === 1 ? 140 : 240;
                            }
                            if (scenario === 'continuous-geometry') {
                                left += 30;
                            }
                            for (const listener of capturedScroll) {
                                listener(scenario === 'unrelated-reused' ? reusedScroll : { target: unrelated });
                            }
                            for (const listener of capturedScrollEnd) {
                                listener({ target: unrelated });
                            }
                        }
                        callback();
                    }, 0);
                    frames.add(frame);
                    if (scenario === 'hide') {
                        globalThis.queueMicrotask(() => {
                            document.visibilityState = 'hidden';
                            document.dispatchEvent(new globalThis.Event('visibilitychange'));
                        });
                    }
                    return frame;
                };
                const cancelAnimationFrame = (frame) => {
                    frames.delete(frame);
                    clearTimer(frame);
                };
                const realm = createContext({
                    window,
                    document,
                    __mcpDomHelpers,
                    MessageChannel: Channel,
                    requestAnimationFrame,
                    cancelAnimationFrame,
                    setTimeout: setTimer,
                    clearTimeout: clearTimer,
                });
                const restore = patchProperties(unified, {
                    find: async () => [{ refId: 'owned' }],
                    evaluate: async (script) => runInContext(script, realm),
                    mouseMove: async (x, y) => moves.push({ x, y }),
                });
                try {
                    const response = await registeredTool(registerInputTool)({
                        expectedRevision: 'r101',
                        timeout: ['continuous', 'continuous-geometry'].includes(scenario) ? 100 : 1000,
                        events: [{ type: 'mousemove', target: { css: '#pad' } }],
                    });
                    const body = JSON.parse(response.content[0].text);
                    if (['continuous', 'continuous-geometry'].includes(scenario)) {
                        assert.equal(response.isError, true);
                        assert.equal(body.actionExecuted, false);
                        assert.equal(body.eventsExecuted, 0);
                        assert.deepEqual(moves, []);
                    } else {
                        assert.notEqual(response.isError, true, response.content[0].text);
                        assert.deepEqual(moves, [{ x: left + 40, y: 2135 - window.scrollY }]);
                        if (['sibling', 'two-siblings', 'shadow-siblings'].includes(scenario)) {
                            assert.equal(left, 240);
                        }
                        assert.equal(
                            rendered,
                            [
                                'two-siblings',
                                'shadow-siblings',
                                'foreign-shadow',
                                'dynamic-shadow',
                                'synchronous-repeat',
                            ].includes(scenario)
                                ? 4
                                : ['cascade', 'sibling', 'geometry'].includes(scenario)
                                  ? 3
                                  : ['hidden', 'hide'].includes(scenario)
                                    ? 0
                                    : 2
                        );
                    }
                    assert.equal(capturedScroll.size, 0);
                    assert.equal(capturedScrollEnd.size, 0);
                    assert.equal(listeners.size, 0);
                    assert.equal(timers.size, 0);
                    assert.equal(frames.size, 0);
                    assert.equal(closed, 2);
                } finally {
                    restore();
                    for (const timer of timers) {
                        globalThis.clearTimeout(timer);
                    }
                }
            })
        );
    }
});

test('C-R4 input readiness scrolls the target into view before typing', async () => {
    const calls = [];
    const wait = new AutoWait({}, 'session');
    for (const name of ['waitForVisible', 'waitForEnabled', 'waitForStableBoundingBox', 'ensureInViewport']) {
        wait[name] = async (nodeId) => {
            assert.equal(nodeId, 9);
            calls.push(name);
        };
    }
    await wait.waitForInputReady(9);
    assert.deepEqual(calls, ['waitForVisible', 'waitForEnabled', 'waitForStableBoundingBox', 'ensureInViewport']);
});

test('C-R4 CDP editor events focus their locator without Extension references', async (t) => {
    for (const type of ['editorContext', 'editorInsert', 'editorCommand']) {
        await t.test(type, async () =>
            withPageFixture('cdp', async ({ unified }) => {
                const document = {
                    activeElement: null,
                    body: {},
                    documentElement: {},
                    execCommand: (command) => command === 'bold',
                };
                class HTMLElement {}
                const element = Object.assign(new HTMLElement(), {
                    tagName: 'TEXTAREA',
                    id: 'editor',
                    value: 'alpha beta',
                    selectionStart: 6,
                    selectionEnd: 10,
                    focus() {
                        document.activeElement = this;
                    },
                    setRangeText(value) {
                        this.value = value;
                    },
                    dispatchEvent() {},
                });
                const context = {
                    document,
                    HTMLElement,
                    window: { getSelection: () => null },
                    Event: globalThis.Event,
                };
                let focusCount = 0;
                const restoreSession = patchProperties(getSession(), {
                    createLocator: (target) => {
                        assert.deepEqual(target, { css: '#editor' });
                        return {
                            evaluateOn: async (fn) => {
                                focusCount++;
                                return runInNewContext(`(${fn}).call(element)`, { ...context, element });
                            },
                        };
                    },
                });
                const restoreUnified = patchProperties(unified, {
                    find: async () => [{ refId: 'cdp-0' }],
                    evaluate: async (script, _unused, _timeout, args) => {
                        assert.ok(!script.includes('__mcpElementMap'));
                        return runInNewContext(`(${script})(...args)`, { ...context, args });
                    },
                });
                try {
                    const response = await registeredTool(registerInputTool)({
                        expectedRevision: 'r101',
                        events: [{ type, target: { css: '#editor' }, text: 'replacement', command: 'bold' }],
                    });
                    assert.notEqual(response.isError, true, response.content[0].text);
                    assert.equal(focusCount, 1);
                    assert.equal(document.activeElement, element);
                    if (type === 'editorInsert') {
                        assert.equal(element.value, 'replacement');
                    }
                    if (type === 'editorContext') {
                        assert.equal(JSON.parse(response.content[0].text).eventResults[0].selectedText, 'beta');
                    }
                } finally {
                    restoreUnified();
                    restoreSession();
                }
            })
        );
    }
});

test('C-R4 public CDP key repetition and failure preserve modifier state', async () => {
    await withPageFixture('cdp', async () => {
        const session = getSession();
        const events = [];
        const restore = patchProperties(session, {
            modifiers: 0,
            ensureSession() {},
            send: async (method, params) => {
                assert.equal(method, 'Input.dispatchKeyEvent');
                events.push(params);
            },
        });
        try {
            const input = registeredTool(registerInputTool);
            const response = await input({
                expectedRevision: 'r101',
                events: [
                    { type: 'keydown', key: 'Control' },
                    { type: 'keydown', key: 'a' },
                    { type: 'keydown', key: 'a' },
                    { type: 'keyup', key: 'a' },
                    { type: 'keyup', key: 'Control' },
                ],
            });
            assert.notEqual(response.isError, true, response.content[0].text);
            assert.deepEqual(
                events.map((event) => event.type),
                ['keyDown', 'keyDown', 'rawKeyDown', 'keyUp', 'keyUp']
            );
            assert.equal(events[2].autoRepeat, true);
            assert.equal(events[2].modifiers, 2);
            assert.equal(session.modifiers, 0);
            const restoreSend = patchProperties(session, {
                send: async () => {
                    throw new Error('dispatch rejected');
                },
            });
            try {
                const failed = await input({ expectedRevision: 'r101', events: [{ type: 'keydown', key: 'Control' }] });
                assert.equal(failed.isError, true);
                assert.equal(session.modifiers, 0);
                assert.equal(getUnifiedSession().modifiers, 0);
                assert.equal(getUnifiedSession().pressedKeys.size, 0);
            } finally {
                restoreSend();
            }
        } finally {
            restore();
        }
    });
});

test('C-R4 device emulation applies mobile density and touch in both backends and viewport resets them', async (t) => {
    for (const mode of ['cdp', 'extension']) {
        await t.test(mode, async () =>
            withPageFixture(mode, async ({ unified }) => {
                const calls = [];
                const restore = patchProperties(unified, {
                    sendCdpCommand: async (method, params) => {
                        calls.push({ method, params });
                    },
                    evaluate: async () => true,
                });
                try {
                    const manage = registeredTool(registerManageTool);
                    const response = await manage({ action: 'emulate', device: 'iPhone 13' });
                    assert.notEqual(response.isError, true, response.content[0].text);
                    assert.deepEqual(
                        calls.find((call) => call.method === 'Emulation.setDeviceMetricsOverride')?.params,
                        { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }
                    );
                    assert.deepEqual(
                        calls.find((call) => call.method === 'Emulation.setTouchEmulationEnabled')?.params,
                        { enabled: true, maxTouchPoints: 1 }
                    );
                    calls.length = 0;
                    const restored = await manage({ action: 'viewport', width: 800, height: 600 });
                    assert.notEqual(restored.isError, true, restored.content[0].text);
                    assert.deepEqual(
                        calls.find((call) => call.method === 'Emulation.setDeviceMetricsOverride')?.params,
                        { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }
                    );
                    assert.deepEqual(
                        calls.find((call) => call.method === 'Emulation.setTouchEmulationEnabled')?.params,
                        { enabled: false }
                    );
                    assert.deepEqual(calls.find((call) => call.method === 'Emulation.setPageScaleFactor')?.params, {
                        pageScaleFactor: 1,
                    });
                } finally {
                    restore();
                }
            })
        );
    }
});

test('C-R4 browse rejects unsupported page conditions before changing targets', async () => {
    await withPageFixture('cdp', async ({ state }) => {
        const response = await registeredTool(registerBrowseTool)({
            action: 'attach',
            targetId: '202',
            expectedUrl: 'https://example.com/202',
        });
        const payload = JSON.parse(response.content[0].text);
        assert.equal(response.isError, true);
        assert.equal(payload.error.code, 'INVALID_ARGUMENT');
        assert.equal(payload.error.context.actionExecuted, false);
        assert.equal(state.current, '101');
    });
});

test('C-R5 covered CDP targets return bounded hit diagnostics and recover after an overlay disappears', async () => {
    const target = {
        isConnected: true,
        getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 40 }),
        contains: () => false,
    };
    const overlay = {
        tagName: 'DIV',
        id: 'overlay',
        textContent: 'x'.repeat(400),
        getBoundingClientRect: target.getBoundingClientRect,
    };
    let covered = true;
    const cdp = {
        send: async (method, params) => {
            if (method === 'DOM.resolveNode') {
                return { object: { objectId: 'element' } };
            }
            assert.equal(method, 'Runtime.callFunctionOn');
            return {
                result: {
                    value: runInNewContext(`(${params.functionDeclaration}).call(target)`, {
                        target,
                        document: {
                            elementFromPoint: () => (covered ? overlay : target),
                            elementsFromPoint: () => Array(20).fill(overlay),
                        },
                        CSS: { escape: (text) => text },
                    }),
                },
            };
        },
    };
    const wait = new AutoWait(cdp, 'session', { timeout: 20 });
    for (const name of ['waitForVisible', 'waitForEnabled', 'waitForStableBoundingBox', 'ensureInViewport']) {
        wait[name] = async () => {};
    }
    await assert.rejects(wait.waitForClickable(5), (error) => {
        assert.equal(error.code, 'ACTIONABILITY_FAILED');
        assert.equal(error.context.reason, 'covered');
        assert.equal(error.context.coveringElement, 'div#overlay');
        assert.deepEqual(JSON.parse(JSON.stringify(error.context.clickPoint)), { x: 60, y: 40 });
        assert.ok(error.context.candidates.length <= 10);
        assert.ok(error.context.candidates.every((item) => item.text.length <= 160));
        return true;
    });
    covered = false;
    await wait.waitForClickable(5);
});

test('C-R5 public CDP force clicks dispatch only on the resolved element', async (t) => {
    for (const [button, clickCount, expected] of [
        ['left', 2, ['mousedown', 'mouseup', 'click', 'mousedown', 'mouseup', 'click', 'dblclick']],
        ['middle', 1, ['mousedown', 'mouseup', 'auxclick']],
        ['right', 1, ['mousedown', 'mouseup', 'contextmenu']],
    ]) {
        await t.test(button, async () =>
            withPageFixture('cdp', async () => {
                const seen = [];
                const element = {
                    isConnected: true,
                    focus() {},
                    getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 40 }),
                    dispatchEvent: (event) => {
                        seen.push(event);
                        return true;
                    },
                };
                class MouseEvent {
                    constructor(type, options) {
                        Object.assign(this, { type }, options);
                    }
                }
                const restore = patchProperties(getSession(), {
                    createLocator: () => ({
                        evaluateOn: async (fn) =>
                            runInNewContext(`(${fn}).call(element)`, { element, MouseEvent, window: {} }),
                    }),
                    createAutoWait: () => {
                        throw new Error('force must not wait for actionability');
                    },
                    mouseDown: () => {
                        throw new Error('force must not send native input');
                    },
                    mouseUp: () => {
                        throw new Error('force must not send native input');
                    },
                });
                try {
                    const response = await registeredTool(registerInputTool)({
                        expectedRevision: 'r101',
                        events: [
                            {
                                type: 'click',
                                target: { css: '#covered' },
                                button,
                                clickCount,
                                force: true,
                                forceReason: 'test overlay',
                            },
                        ],
                    });
                    assert.notEqual(response.isError, true, response.content[0].text);
                    assert.deepEqual(
                        seen.map((event) => event.type),
                        expected
                    );
                    assert.equal(seen[0].buttons, button === 'left' ? 1 : button === 'middle' ? 4 : 2);
                    assert.equal(seen[1].buttons, 0);
                    if (clickCount === 2) {
                        assert.equal(seen.at(-1).detail, 2);
                    }
                } finally {
                    restore();
                }
            })
        );
    }
});

test('C-R5 humanize clicks emit a path before the single click', async () => {
    await withPageFixture('extension', async ({ unified }) => {
        const calls = [];
        const restore = patchProperties(unified, {
            find: async () => [{ refId: 'element', rect: { x: 10, y: 20, width: 100, height: 40 } }],
            evaluate: async () => ({ x: 10, y: 20, width: 100, height: 40 }),
            mouseMove: async (x, y) => {
                calls.push({ type: 'move', x, y });
            },
            actionableClick: async () => {
                calls.push({ type: 'click' });
                return { success: true };
            },
        });
        try {
            const response = await registeredTool(registerInputTool)({
                expectedRevision: 'r101',
                humanize: true,
                events: [{ type: 'click', target: { css: '#button' }, steps: 3 }],
            });
            assert.notEqual(response.isError, true, response.content[0].text);
            assert.ok(calls.filter((call) => call.type === 'move').length > 1);
            assert.equal(calls.at(-1).type, 'click');
            assert.equal(calls.filter((call) => call.type === 'click').length, 1);
        } finally {
            restore();
        }
    });
});

test('C-R5 force rejects missing and coordinate targets before dispatch', async () => {
    for (const mode of ['cdp', 'extension']) {
        await withPageFixture(mode, async ({ state }) => {
            for (const target of [undefined, { x: 3, y: 4 }]) {
                const response = await registeredTool(registerInputTool)({
                    expectedRevision: 'r101',
                    events: [{ type: 'click', target, force: true, forceReason: 'test' }],
                });
                assert.equal(response.isError, true);
                assert.equal(JSON.parse(response.content[0].text).error.code, 'INVALID_ARGUMENT');
                assert.deepEqual(state.dispatched, []);
            }
        });
    }
});

test('F7 precise Extension clicks use native press/release while stealth and force retain their dispatcher', async (t) => {
    for (const inputMode of ['precise', 'stealth']) {
        for (const frame of [undefined, 'iframe#owned']) {
            for (const force of [false, true]) {
                await t.test(`${inputMode}-${frame ?? 'main'}-force-${force}`, async () => {
                    await withPageFixture('extension', async ({ unified, driver, state }) => {
                        const rect = { x: 12, y: 20, width: 20, height: 10 };
                        const offset = { x: 0, y: 0 };
                        const restore = patchProperties(unified, {
                            inputMode,
                            currentFrameOffset: frame ? { x: 100, y: 200 } : null,
                            currentMousePosition: { x: 1, y: 2 },
                            getFrameOffset: () => (frame ? { x: 100, y: 200 } : null),
                            withFrame: async (_frame, run) => run(),
                            find: async () => [
                                {
                                    refId: 'owned-click',
                                    rect: { ...rect, x: rect.x + offset.x, y: rect.y + offset.y },
                                },
                            ],
                            evaluate: async () => rect,
                        });
                        driver.checkActionability = async () => ({ success: true, clickPoint: { x: 22, y: 25 } });
                        driver.inputMouse = async (type, x, y) => {
                            assert.ok(type === 'mousePressed' || type === 'mouseReleased');
                            state.dispatched.push({ type, x, y, targetId: state.current });
                            state.actionCompleted = true;
                        };
                        driver.stealthMouse = async () =>
                            assert.fail('atomic element clicks must not require scripted movement');
                        driver.actionableClick = async (refId, requestedForce) => {
                            state.dispatched.push({ refId, force: requestedForce, targetId: state.current });
                            state.actionCompleted = true;
                            return { success: true };
                        };
                        try {
                            const response = await registeredTool(registerInputTool)({
                                targetId: '202',
                                expectedRevision: 'r202',
                                frame,
                                timeout: 1000,
                                events: [
                                    {
                                        type: 'click',
                                        target: { css: 'button.owned' },
                                        force,
                                        ...(force ? { forceReason: 'verify owned covered element' } : {}),
                                    },
                                ],
                            });
                            const body = JSON.parse(response.content[0].text);
                            assert.notEqual(response.isError, true, response.content[0].text);
                            assert.equal(body.eventsExecuted, 1);
                            assert.deepEqual(
                                state.dispatched,
                                inputMode === 'precise' && !force
                                    ? ['mousePressed', 'mouseReleased'].map((type) => ({
                                          type,
                                          x: 22 + offset.x,
                                          y: 25 + offset.y,
                                          targetId: '202',
                                      }))
                                    : [{ refId: 'owned-click', force, targetId: '202' }]
                            );
                            assert.deepEqual(unified.getMousePosition(), { x: 22 + offset.x, y: 25 + offset.y });
                            assert.equal(state.current, '101');
                        } finally {
                            restore();
                        }
                    });
                });
            }
        }
    }
});

test('C-R5 Extension middle and double clicks check actionability and force uses its existing dispatcher', async () => {
    await withPageFixture('extension', async ({ unified, driver }) => {
        const calls = [];
        driver.checkActionability = async (refId) => {
            assert.equal(refId, 'element');
            return { success: false, reason: 'covered', coveringElement: 'div#overlay' };
        };
        driver.stealthClick = async (...args) => {
            calls.push(args);
        };
        for (const [button, count] of [
            ['middle', 1],
            ['left', 2],
        ]) {
            assert.equal((await unified.actionableClick('element', false, button, count)).success, false);
            assert.equal(calls.length, 0);
            assert.equal((await unified.actionableClick('element', true, button, count)).success, true);
            assert.equal(calls.at(-1)[2], button);
            assert.equal(calls.at(-1)[3], count);
            assert.equal(calls.at(-1)[4], 'element');
            calls.length = 0;
        }
    });
});

test('C-R6 same-page challenge clicks use the Extension page dispatcher without activating a tab', async () => {
    await withPageFixture('extension', async ({ unified, driver }) => {
        const calls = [];
        driver.stealthClick = async (...args) => {
            calls.push(args);
        };
        driver.inputMouse = async () => {
            throw new Error('same-page challenge must not depend on native background input');
        };
        const snapshot = { clickSource: 'page', clickPoint: { x: 12, y: 34 } };
        await unified.clickTurnstile(snapshot);
        assert.deepEqual(calls, [[12, 34, 'left', 1, undefined, undefined]]);
        await unified.clickTurnstile(snapshot, 50);
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[1].slice(0, 5), [12, 34, 'left', 1, undefined]);
        assert.ok(calls[1][5] > 0 && calls[1][5] <= 50);
    });
});

test('C-R6 safe UA injection observes later browser emulation overrides', async () => {
    const { getAntiDetectionScript } = await import('../dist/anti-detection/index.js');
    let userAgent = 'HeadlessChrome/153.0.0.0';
    const navigator = Object.create({
        get userAgent() {
            return userAgent;
        },
    });
    const context = { navigator, window: {}, document: {} };
    runInNewContext(getAntiDetectionScript('safe'), context);
    assert.equal(navigator.userAgent, 'Chrome/153.0.0.0');
    userAgent = 'iPhone test UA';
    assert.equal(navigator.userAgent, 'iPhone test UA');
    userAgent = 'HeadlessChrome/153.0.0.0';
    runInNewContext(getAntiDetectionScript('safe'), context);
    userAgent = 'MCP-Test/1.0';
    assert.equal(navigator.userAgent, 'MCP-Test/1.0');
});

test('Extension creation retains transport margin while navigation uses the remaining budget', async (t) => {
    for (const [action, run] of [
        ['tabs_create', (bridge, timeout) => bridge.newPage('https://example.com/test', timeout)],
        ['navigate', (bridge, timeout) => bridge.navigate('https://example.com/test', { timeout })],
        ['reload', (bridge, timeout) => bridge.reload(false, 'load', timeout)],
    ]) {
        await t.test(action, async () => {
            const bridge = new ExtensionBridge();
            bridge.currentTabId = 101;
            const calls = [];
            const navigationError = new Error('Navigation timeout');
            let failNavigation = false;
            const restore = patchProperties(bridge.httpServer, {
                async sendCommand(actualAction, params, requestTimeout) {
                    calls.push({ action: actualAction, params, requestTimeout });
                    assert.equal(actualAction, action);
                    assert.equal(
                        requestTimeout,
                        action === 'tabs_create' ? (params.timeout ?? 30000) + 5000 : params.timeout
                    );
                    if (failNavigation) {
                        throw navigationError;
                    }
                    return { id: 202, url: 'https://example.com/test', title: 'test', managed: true };
                },
            });
            try {
                for (const timeout of action === 'tabs_create' ? [undefined, 0, 75] : [undefined, 75]) {
                    await run(bridge, timeout);
                    if (action === 'tabs_create') {
                        assert.equal(calls.at(-1).params.timeout, timeout);
                    } else {
                        assert.ok(calls.at(-1).params.timeout > 0 && calls.at(-1).params.timeout <= (timeout ?? 30000));
                    }
                    assert.equal(calls.at(-1).params.waitUntil, 'load');
                }
                if (action !== 'tabs_create') {
                    const before = calls.length;
                    await assert.rejects(
                        () => run(bridge, 0),
                        (error) => error.code === 'TIMEOUT'
                    );
                    assert.equal(calls.length, before);
                }
                failNavigation = true;
                await assert.rejects(
                    () => run(bridge),
                    (error) => {
                        if (action !== 'tabs_create') {
                            return error === navigationError;
                        }
                        const body = JSON.parse(formatErrorResponse(error).content[0].text).error;
                        assert.equal(body.message, navigationError.message);
                        assert.equal(body.context.actionStatus, 'unknown');
                        return true;
                    }
                );
                assert.equal(
                    calls.length,
                    action === 'tabs_create' ? 4 : 3,
                    'navigation failures must not replay the action'
                );
            } finally {
                restore();
            }
        });
    }
});

test('NK-S01 public native keyboard restores focus before postCondition and retains held-key semantics', async () => {
    await withPageFixture('extension', async ({ unified, driver, state }) => {
        const order = [];
        let visible = false;
        let acquiredId;
        driver.acquireKeyboardFocus = async (id, timeout) => {
            assert.ok(timeout > 0 && timeout <= 1000);
            acquiredId = id;
            visible = true;
            order.push('acquire');
            return { changed: true };
        };
        driver.releaseKeyboardFocus = async (focus, releaseKeys) => {
            assert.equal(focus.id, acquiredId);
            assert.equal(focus.targetId, '101');
            assert.equal(releaseKeys, false);
            assert.equal(unified.tabLockContext.getStore().signal, undefined);
            visible = false;
            order.push('release');
            return { restored: true, errors: [] };
        };
        const inputKey = driver.inputKey;
        driver.inputKey = async (...args) => {
            assert.equal(visible, true);
            assert.equal(unified.tabLockContext.getStore().keyboardFocus.id, acquiredId);
            order.push(args[0]);
            return inputKey(...args);
        };
        const restore = patchProperties(unified, {
            inputMode: 'precise',
            evaluate: async () => {
                assert.equal(visible, false);
                order.push('verify');
                return { matched: true };
            },
        });
        try {
            const response = await registeredTool(registerInputTool)({
                timeout: 1000,
                events: [
                    { type: 'keydown', key: 'Control' },
                    { type: 'keydown', key: 'a', commands: ['selectAll'] },
                    { type: 'keyup', key: 'a' },
                ],
                postCondition: { script: 'true' },
            });
            const body = JSON.parse(response.content[0].text);
            assert.notEqual(response.isError, true, JSON.stringify(body));
            assert.equal(body.actionStatus, 'completed');
            assert.equal(body.eventsExecuted, 3);
            assert.equal(body.verificationStatus, 'matched');
            assert.ok(body.warnings.some((value) => value.includes('visible')));
            assert.deepEqual(order.slice(0, 5), ['acquire', 'keyDown', 'keyDown', 'keyUp', 'release']);
            assert.equal(order.at(-1), 'verify');
            assert.equal(unified.pressedKeys.has('Control'), true);
            assert.equal(unified.modifiers, 2);
            assert.equal(state.current, '101');
        } finally {
            restore();
        }
    });
});

test('NK-S02 preparation, unknown input and cleanup errors preserve the primary execution result', async (t) => {
    for (const scenario of ['prepare-error', 'prepare-timeout', 'unknown', 'cleanup-error', 'unknown-cleanup-error']) {
        await t.test(scenario, async () =>
            withPageFixture('extension', async ({ unified, driver }) => {
                const calls = [];
                const beforeDispatch = scenario.startsWith('prepare-');
                const cleanupFails = scenario.includes('cleanup-error');
                driver.acquireKeyboardFocus = async () => {
                    calls.push('acquire');
                    if (beforeDispatch) {
                        throw new StructuredToolError(
                            scenario === 'prepare-error' ? 'KEYBOARD_FOCUS_STATE_UNKNOWN' : 'TIMEOUT',
                            'owned preparation failure',
                            undefined,
                            {
                                actionExecuted: scenario === 'prepare-timeout' ? 'unknown' : false,
                                actionStatus: scenario === 'prepare-timeout' ? 'unknown' : 'not_started',
                                retryable: false,
                            }
                        );
                    }
                    return { changed: true };
                };
                driver.releaseKeyboardFocus = async (_focus, releaseKeys) => {
                    calls.push(['release', releaseKeys]);
                    return { restored: !cleanupFails, errors: cleanupFails ? ['owned restore failure'] : [] };
                };
                const dispatch = driver.inputKey;
                driver.inputKey = async (...args) => {
                    await dispatch(...args);
                    calls.push(args[0]);
                    if (scenario.startsWith('unknown')) {
                        throw new StructuredToolError('TIMEOUT', 'owned native reply unknown', undefined, {
                            actionExecuted: 'unknown',
                            actionStatus: 'unknown',
                            retryable: false,
                        });
                    }
                };
                const restore = patchProperties(unified, { inputMode: 'precise' });
                try {
                    const response = await registeredTool(registerInputTool)({
                        timeout: 1000,
                        events: [
                            { type: 'keydown', key: 'a' },
                            { type: 'keyup', key: 'a' },
                        ],
                    });
                    const body = JSON.parse(response.content[0].text);
                    assert.equal(response.isError, true);
                    assert.equal(
                        body.actionStatus,
                        beforeDispatch ? 'not_started' : scenario === 'cleanup-error' ? 'completed' : 'unknown'
                    );
                    assert.equal(
                        body.actionExecuted,
                        beforeDispatch ? false : scenario === 'cleanup-error' ? true : 'unknown'
                    );
                    assert.equal(body.eventsExecuted, scenario === 'cleanup-error' ? 2 : 0);
                    assert.equal(
                        body.error.code,
                        scenario === 'prepare-error'
                            ? 'KEYBOARD_FOCUS_STATE_UNKNOWN'
                            : scenario === 'cleanup-error'
                              ? 'KEYBOARD_FOCUS_CLEANUP_FAILED'
                              : 'TIMEOUT'
                    );
                    assert.equal(body.retryable, false);
                    if (cleanupFails) {
                        assert.deepEqual(body.keyboardFocusCleanup.errors, ['owned restore failure']);
                    }
                    assert.deepEqual(calls.at(-1), ['release', scenario !== 'cleanup-error']);
                    assert.equal(calls.filter((value) => value === 'keyDown').length, beforeDispatch ? 0 : 1);
                } finally {
                    restore();
                }
            })
        );
    }
});

test('NK-S03 pure typing and non-native input keep their existing preparation path', async () => {
    for (const mode of ['precise', 'stealth']) {
        await withPageFixture('extension', async ({ unified, driver }) => {
            driver.acquireKeyboardFocus = async () => assert.fail('pure typing must not acquire focus');
            const restore = patchProperties(unified, { inputMode: mode });
            try {
                await unified.withTabLock(() =>
                    unified.withInputCleanup(async () => {
                        if (mode === 'stealth') {
                            assert.equal(await unified.prepareKeyboardFocus(1000), undefined);
                        }
                    })
                );
            } finally {
                restore();
            }
        });
    }
});

test('NK-S04 Bridge propagates the keyboard credential, original document and shared deadline', async () => {
    const context = { keyboardFocus: { id: 'owned-keyboard', targetId: '101' } };
    const bridge = new ExtensionBridge({ requestContext: () => context });
    bridge.setCurrentTargetId('101');
    bridge.setCurrentFrameId(7, 'owned-document');
    const calls = [];
    bridge.httpServer.sendCommand = async (action, params, timeout) => {
        calls.push({ action, params, timeout });
        return params.operation === 'acquire' ? { changed: true } : { restored: true, errors: [] };
    };
    await bridge.acquireKeyboardFocus('owned-keyboard', 1000);
    await bridge.inputKey('keyDown', { key: 'a', commands: ['selectAll'] }, 800);
    await bridge.inputType('owned', 0, 600);
    await bridge.releaseKeyboardFocus(context.keyboardFocus, true);
    assert.deepEqual(
        calls.map(({ action }) => action),
        ['keyboard_focus', 'input_key', 'input_type', 'keyboard_focus']
    );
    assert.equal(calls[0].params.frameId, 7);
    assert.equal(calls[0].params.documentId, 'owned-document');
    assert.equal(calls[1].params.keyboardFocusId, 'owned-keyboard');
    assert.equal(calls[2].params.keyboardFocusId, 'owned-keyboard');
    assert.equal(calls[3].params.tabId, 101);
    assert.equal(calls[3].params.releaseKeys, true);
    assert.equal(calls[3].timeout, 4000);
    assert.ok(calls.slice(0, 3).every(({ params }) => params.deadline > Date.now()));
});

test('C01 persistent target changes share the temporary tab scope lock', async () => {
    const session = getUnifiedSession();
    const previousBridge = session.extensionBridge;
    const previousMode = session.activeMode;
    const previousPressedKeys = session.pressedKeys;
    const previousModifiers = session.modifiers;
    let currentTargetId = '101';
    const inputTargets = [];
    let releaseFirstInput;
    const firstInput = new Promise((resolve) => {
        releaseFirstInput = resolve;
    });
    let continueInput;
    const inputGate = new Promise((resolve) => {
        continueInput = resolve;
    });

    session.extensionBridge = {
        isConnected: () => true,
        getCurrentTargetId: () => currentTargetId,
        setCurrentTargetId: (targetId) => {
            currentTargetId = targetId;
        },
        async listTargets() {
            return ['101', '202', '303'].map((targetId) => ({ targetId }));
        },
        async selectPage(targetId) {
            currentTargetId = targetId;
        },
        async inputKey(type) {
            inputTargets.push({ type, targetId: currentTargetId });
            if (type === 'keyDown') {
                releaseFirstInput();
                await inputGate;
            }
        },
        async adoptPage(targetId) {
            currentTargetId = targetId;
            return { success: true, targetId };
        },
    };
    session.activeMode = 'extension';
    session.pressedKeys = new Set();
    session.modifiers = 0;
    try {
        const input = session.withTabId('202', async () => {
            await session.keyDown('a');
            await session.keyUp('a');
        });
        await firstInput;
        let adopted = false;
        const adopt = session.adoptPage('303').then(() => {
            adopted = true;
        });
        await Promise.resolve();
        assert.equal(adopted, false);
        continueInput();
        await Promise.all([input, adopt]);
        assert.deepEqual(inputTargets, [
            { type: 'keyDown', targetId: '202' },
            { type: 'keyUp', targetId: '202' },
        ]);
        assert.equal(currentTargetId, '303');
    } finally {
        session.extensionBridge = previousBridge;
        session.activeMode = previousMode;
        session.pressedKeys = previousPressedKeys;
        session.modifiers = previousModifiers;
    }
});

test('C-R1 target restoration preserves the primary result and clears unsafe defaults', async (t) => {
    for (const mode of ['extension', 'cdp']) {
        for (const restoration of ['restored', 'list', 'select', 'closed', 'no-default']) {
            for (const actionFails of [false, true]) {
                await t.test(`${mode}/${restoration}/${actionFails ? 'action-error' : 'success'}`, async () => {
                    await withPageFixture(mode, async ({ unified, state }) => {
                        state.restoreFailure = restoration;
                        if (restoration === 'no-default') {
                            state.current = null;
                        }
                        const primaryError = new TimeoutError('primary action timeout');
                        let dispatched = 0;
                        const action = () =>
                            withPageContext(unified, '202', async () => {
                                ++dispatched;
                                state.actionCompleted = true;
                                if (restoration === 'closed') {
                                    state.targets.delete('101');
                                }
                                if (actionFails) {
                                    throw primaryError;
                                }
                                return successfulAction();
                            });
                        let payload;
                        if (actionFails) {
                            await assert.rejects(action, (error) => {
                                assert.equal(error, primaryError);
                                payload = JSON.parse(formatErrorResponse(error).content[0].text);
                                assert.equal(payload.error.code, 'TIMEOUT');
                                assert.equal(payload.error.message, 'primary action timeout');
                                return true;
                            });
                        } else {
                            payload = JSON.parse((await action()).content[0].text);
                            assert.equal(payload.success, true);
                        }
                        assert.equal(dispatched, 1);
                        const expectedStatus = ['list', 'select'].includes(restoration)
                            ? 'failed'
                            : restoration === 'closed'
                              ? 'previous_target_closed'
                              : restoration === 'no-default'
                                ? 'cleared'
                                : 'restored';
                        assert.equal(payload.pageContext.targetRestoration.status, expectedStatus);
                        assert.equal(payload.pageContext.targetId, '202');
                        assert.equal(
                            payload.pageContext.defaultTargetIdBefore,
                            restoration === 'no-default' ? null : '101'
                        );
                        assert.equal(state.current, restoration === 'restored' ? '101' : null);
                        if (expectedStatus === 'failed') {
                            assert.match(payload.pageContext.targetRestoration.error, /restoration/);
                        }
                        const next = await withPageContext(unified, undefined, async () => {
                            assert.notEqual(unified.getCurrentTargetId(), '202');
                            return successfulAction();
                        });
                        assert.equal(JSON.parse(next.content[0].text).pageContext.targetRestoration, undefined);
                    });
                });
            }
        }
    }
});

test('C-R1 coordinate command preparation uses independent restoration only before dispatch', async (t) => {
    for (const mode of ['extension', 'cdp']) {
        for (const reason of ['deadline', 'budget-error', 'cancelled']) {
            for (const restoration of [
                'restored',
                'closed',
                'list',
                'select',
                'cleanup-budget',
                'dispatched',
                'other-input',
            ]) {
                await t.test(`${mode}/${reason}/${restoration}`, async () => {
                    await withPageFixture(mode, async ({ unified, driver, state }) => {
                        let clock = Date.now();
                        const deadline = clock + 350;
                        const restoreClock = patchProperties(Date, { now: () => clock });
                        const controller = new AbortController();
                        const primaryError = new TimeoutError(`owned ${reason} action stopped`);
                        const calls = [];
                        let actionScope;
                        const nativeDriver = mode === 'cdp' ? getSession() : driver;
                        const restoreDriver = patchProperties(
                            nativeDriver,
                            Object.fromEntries(
                                ['listTargets', 'selectPage', 'deselectPage'].map((method) => {
                                    const original = nativeDriver[method].bind(nativeDriver);
                                    return [
                                        method,
                                        async (...args) => {
                                            const scope = unified.tabLockContext.getStore();
                                            if (
                                                state.actionCompleted &&
                                                scope === actionScope &&
                                                method !== 'deselectPage'
                                            ) {
                                                unified.assertRequestActive(scope);
                                            }
                                            if (state.actionCompleted && scope !== actionScope) {
                                                const timeout = args[method === 'selectPage' ? 1 : 0];
                                                calls.push({ method, timeout, deadline: scope.deadline });
                                                assert.equal(scope.signal, undefined);
                                                assert.equal(scope.budgetError, undefined);
                                                assert.equal(scope.userAction, undefined);
                                                assert.equal(scope.pendingPageCondition, null);
                                                assert.ok(scope.deadline <= deadline + 1000);
                                                assert.ok(timeout >= 0 && timeout <= 1000);
                                            }
                                            const value = await original(...args);
                                            if (
                                                state.actionCompleted &&
                                                scope !== actionScope &&
                                                method === 'listTargets'
                                            ) {
                                                clock += restoration === 'cleanup-budget' ? 1001 : 100;
                                            }
                                            return value;
                                        },
                                    ];
                                })
                            )
                        );
                        try {
                            state.restoreFailure = restoration;
                            let payload;
                            await assert.rejects(
                                () =>
                                    withPageContext(
                                        unified,
                                        '202',
                                        () =>
                                            unified.withUserAction(
                                                'input',
                                                async () => {
                                                    actionScope = unified.tabLockContext.getStore();
                                                    actionScope.userAction.dispatched = restoration === 'dispatched';
                                                    actionScope.pendingPageCondition = {
                                                        targetId: '202',
                                                        expectedRevision: 'owned',
                                                    };
                                                    state.actionCompleted = true;
                                                    if (restoration === 'closed') {
                                                        state.targets.delete('101');
                                                    }
                                                    if (reason === 'cancelled') {
                                                        controller.abort(primaryError);
                                                    } else if (reason === 'budget-error') {
                                                        actionScope.budgetError = primaryError;
                                                    }
                                                    if (reason === 'deadline') {
                                                        clock = deadline;
                                                    }
                                                    throw primaryError;
                                                },
                                                restoration !== 'other-input'
                                            ),
                                        deadline,
                                        controller.signal
                                    ),
                                (error) => {
                                    assert.equal(error, primaryError);
                                    payload = JSON.parse(formatErrorResponse(error).content[0].text);
                                    return true;
                                }
                            );
                            const expectedStatus =
                                restoration === 'restored'
                                    ? 'restored'
                                    : restoration === 'closed'
                                      ? 'previous_target_closed'
                                      : 'failed';
                            assert.equal(payload.pageContext.targetRestoration.status, expectedStatus);
                            assert.equal(state.current, restoration === 'restored' ? '101' : null);
                            assert.equal(actionScope.deadline, deadline);
                            assert.equal(actionScope.signal, controller.signal);
                            assert.deepEqual(state.dispatched, []);
                            assert.equal(actionScope.restoreTargetAfterPreparationFailure, undefined);
                            if (['dispatched', 'other-input'].includes(restoration)) {
                                assert.deepEqual(calls, []);
                            } else {
                                assert.ok(calls.length > 0);
                            }
                            if (restoration === 'restored') {
                                assert.deepEqual(
                                    calls.map(({ method }) => method),
                                    ['listTargets', 'selectPage']
                                );
                                assert.ok(calls[1].timeout < calls[0].timeout);
                            } else if (['list', 'select'].includes(restoration)) {
                                assert.match(payload.pageContext.targetRestoration.error, /restoration/);
                            } else if (restoration === 'cleanup-budget') {
                                assert.match(payload.pageContext.targetRestoration.error, /budget exhausted/);
                                assert.equal(
                                    calls.some(({ method }) => method === 'selectPage'),
                                    false
                                );
                            }
                        } finally {
                            restoreDriver();
                            restoreClock();
                        }
                    });
                });
            }
        }
    }
});

test('C-R1 CDP deselect clears attached state even when detach rejects', async () => {
    const cdp = getSession();
    const restore = patchProperties(cdp, {
        cdp: {
            isConnected: true,
            send: async () => {
                throw new Error('detach failed');
            },
        },
        sessionId: 'temporary-session',
        currentTargetId: '202',
        state: { targetId: '202' },
        challengeRequired: true,
        runtimeEnabled: true,
        mainFrameId: 'frame',
        mainFrameLoaderId: 'loader',
        modifiers: 1,
        consoleLogs: [],
        networkRequests: [],
        requestMap: new Map(),
    });
    try {
        await assert.rejects(() => cdp.deselectPage(), /detach failed/);
        for (const key of ['sessionId', 'currentTargetId', 'state', 'mainFrameId', 'mainFrameLoaderId']) {
            assert.equal(cdp[key], null, key);
        }
        assert.equal(cdp.challengeRequired, false);
        assert.equal(cdp.runtimeEnabled, false);
        assert.equal(cdp.modifiers, 0);
    } finally {
        restore();
    }
});

test('C-R1 public input is dispatched once when restoring its target fails', async () => {
    await withPageFixture('extension', async ({ state }) => {
        state.restoreFailure = 'list';
        const input = registeredTool(registerInputTool);
        const response = await input({
            targetId: '202',
            expectedRevision: 'r202',
            events: [{ type: 'keydown', key: 'a' }],
        });
        const payload = JSON.parse(response.content[0].text);
        assert.equal(response.isError, undefined);
        assert.equal(payload.actionExecuted, true);
        assert.equal(payload.actionStatus, 'completed');
        assert.equal(payload.eventsExecuted, 1);
        assert.equal(payload.pageContext.targetRestoration.status, 'failed');
        assert.deepEqual(state.dispatched, [{ type: 'keyDown', targetId: '202' }]);
        assert.equal(state.current, null);
    });
});

test('C-R1 outer input failures retain completed, partial and unknown progress', async (t) => {
    for (const outcome of ['completed', 'partial', 'unknown']) {
        await t.test(outcome, async () =>
            withPageFixture('extension', async ({ unified, driver, state }) => {
                const originalWithFrame = unified.withFrame;
                const restore = patchProperties(unified, {
                    withFrame: async (frame, action) => {
                        await originalWithFrame.call(unified, frame, action);
                        throw new Error('frame cleanup failed');
                    },
                });
                const cleanup = [];
                driver.inputKey = async (type, options) => {
                    if (!unified.tabLockContext.getStore()?.userAction) {
                        cleanup.push({ type, key: options.key, targetId: state.current });
                        return;
                    }
                    state.dispatched.push({ type, targetId: state.current });
                    if (outcome === 'unknown') {
                        throw new TimeoutError('event dispatch timeout');
                    }
                    if (outcome === 'partial' && state.dispatched.length === 2) {
                        throw new Error('second input failed');
                    }
                };
                try {
                    const events = [{ type: 'keydown', key: 'a' }];
                    if (outcome === 'partial') {
                        events.push({ type: 'keyup', key: 'a' });
                    }
                    const response = await registeredTool(registerInputTool)({
                        targetId: '202',
                        expectedRevision: 'r202',
                        events,
                    });
                    const payload = JSON.parse(response.content[0].text);
                    assert.equal(response.isError, true);
                    assert.equal(payload.actionExecuted, true);
                    assert.equal(payload.eventsExecuted, outcome === 'unknown' ? 0 : 1);
                    assert.equal(
                        payload.actionStatus,
                        outcome === 'completed' ? 'completed' : outcome === 'unknown' ? 'unknown' : 'failed'
                    );
                    assert.equal(state.dispatched.length, outcome === 'partial' ? 2 : 1);
                    assert.deepEqual(
                        cleanup,
                        outcome === 'unknown' ? [{ type: 'keyUp', key: 'a', targetId: '202' }] : []
                    );
                    if (outcome === 'unknown') {
                        assert.deepEqual([...unified.pressedKeys], []);
                    }
                } finally {
                    restore();
                }
            })
        );
    }
});

test('public input exposes the background synthetic click warning', async () => {
    await withPageFixture('extension', async ({ unified, driver }) => {
        const restore = patchProperties(unified, { inputMode: 'precise', currentMousePosition: { x: 0, y: 0 } });
        let syntheticClicks = 0;
        driver.find = async () => [
            { refId: 'background-ref', tag: 'button', text: 'Click', rect: { x: 10, y: 10, width: 20, height: 20 } },
        ];
        driver.debuggerSend = async () => ({ result: { value: { x: 10, y: 10, width: 20, height: 20 } } });
        driver.getCurrentFrameId = () => 0;
        driver.inputMouse = async (type) => {
            if (type === 'mousePressed') {
                throw Object.assign(new Error('inactive tab'), { code: 'NATIVE_INPUT_UNAVAILABLE' });
            }
        };
        driver.actionableClick = async () => {
            ++syntheticClicks;
            return { success: true };
        };
        try {
            const response = await registeredTool(registerInputTool)({
                targetId: '202',
                events: [{ type: 'click', target: { css: 'button' } }],
                timeout: 1000,
            });
            const body = JSON.parse(response.content[0].text);
            assert.equal(response.isError, undefined, JSON.stringify(body));
            assert.equal(body.actionStatus, 'completed');
            assert.ok(body.warnings[0].includes('合成'));
            assert.equal(syntheticClicks, 1);
        } finally {
            restore();
        }
    });
});

test('input keeps a native dialog unknown result distinct from a failed action', async () => {
    await withPageFixture('extension', async ({ driver }) => {
        const dispatched = [];
        driver.inputKey = async (type) => {
            getUnifiedSession().tabLockContext.getStore().userAction.dispatched = true;
            dispatched.push(type);
            if (dispatched.length === 1) {
                throw new StructuredToolError('DIALOG_OPEN', 'Synthetic prompt', 'Handle the open dialog', {
                    actionExecuted: 'unknown',
                    actionStatus: 'unknown',
                    retryable: false,
                    ref: 'synthetic-dialog',
                });
            }
        };
        const response = await registeredTool(registerInputTool)({
            targetId: '202',
            events: [{ type: 'keydown', key: 'a' }],
        });
        const payload = JSON.parse(response.content[0].text);
        assert.equal(response.isError, true);
        assert.equal(payload.actionExecuted, 'unknown');
        assert.equal(payload.actionStatus, 'unknown');
        assert.equal(payload.retryable, false);
        assert.equal(dispatched.filter((type) => type === dispatched[0]).length, 1);
    });
});

test('C-R2 concurrent default responses resolve their target only after the explicit action restores', async () => {
    for (const mode of ['extension', 'cdp']) {
        await withPageFixture(mode, async ({ unified, state }) => {
            const entered = deferred();
            const gate = deferred();
            const explicit = withPageContext(unified, '202', async () => {
                entered.resolve();
                await gate.promise;
                return successfulAction();
            });
            await entered.promise;
            let defaultActionStarted = false;
            const implicit = withPageContext(unified, undefined, async () => {
                defaultActionStarted = true;
                assert.equal(state.current, '101');
                return successfulAction();
            });
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(defaultActionStarted, false);
            gate.resolve();
            const [a, b] = await Promise.all([explicit, implicit]);
            const aContext = JSON.parse(a.content[0].text).pageContext;
            const bContext = JSON.parse(b.content[0].text).pageContext;
            assert.equal(aContext.defaultTargetIdBefore, '101');
            assert.equal(aContext.defaultTargetIdAfter, '101');
            assert.equal(bContext.targetId, '101');
            assert.equal(bContext.before.targetId, '101');
            assert.equal(bContext.after.targetId, '101');
            assert.equal(bContext.defaultTargetIdBefore, '101');
        });
    }
});

test('C-R2 persistent attach and adopt share page response collection with queued default actions', async () => {
    for (const register of [registerBrowseTool, registerManageTool]) {
        await withPageFixture('extension', async ({ driver, state }) => {
            const entered = deferred();
            const gate = deferred();
            const select = register === registerBrowseTool ? 'selectPage' : 'adoptPage';
            const original = driver[select];
            driver[select] = async (id) => {
                entered.resolve();
                await gate.promise;
                return original.call(driver, id);
            };
            const persistent = registeredTool(register)({
                action: select === 'selectPage' ? 'attach' : 'adoptPage',
                targetId: '303',
            });
            await entered.promise;
            const implicit = withPageContext(getUnifiedSession(), undefined, async () => {
                assert.equal(state.current, '303');
                return successfulAction();
            });
            await new Promise((resolve) => setImmediate(resolve));
            gate.resolve();
            const [a, b] = await Promise.all([persistent, implicit]);
            const context = JSON.parse(a.content[0].text).pageContext;
            assert.equal(context.defaultTargetIdBefore, '101');
            assert.equal(context.defaultTargetIdAfter, '303');
            assert.equal(context.targetRestoration, undefined);
            assert.equal(JSON.parse(b.content[0].text).pageContext.targetId, '303');
        });
    }
});

test('C-R3 public browse and manage format stale revision, permission and missing target failures', async (t) => {
    for (const [register, action] of [
        [registerBrowseTool, 'refresh'],
        [registerManageTool, 'closePage'],
    ]) {
        for (const failure of ['stale', 'permission', 'missing']) {
            await t.test(`${action}/${failure}`, async () =>
                withPageFixture('extension', async ({ driver, state }) => {
                    const originalSnapshot = driver.getPageSnapshot;
                    if (failure === 'permission') {
                        driver.getPageSnapshot = async () => {
                            throw new Error(
                                JSON.stringify({
                                    error: { code: 'READ_PERMISSION_REQUIRED', message: 'page permission denied' },
                                })
                            );
                        };
                    }
                    if (failure === 'missing') {
                        state.targets.delete('202');
                    }
                    const response = await registeredTool(register)({
                        action,
                        targetId: '202',
                        expectedRevision: 'stale',
                    });
                    assert.equal(response.isError, true);
                    const payload = JSON.parse(response.content[0].text);
                    assert.equal(
                        payload.error.code,
                        failure === 'stale'
                            ? 'ACTION_PRECONDITION_FAILED'
                            : failure === 'missing'
                              ? 'TARGET_NOT_FOUND'
                              : 'READ_PERMISSION_REQUIRED'
                    );
                    assert.equal(payload.pageContext.targetId, '202');
                    if (failure === 'stale') {
                        assert.equal(payload.error.context.actualUrl, 'https://example.com/202');
                        assert.equal(payload.error.context.actualRevision, 'r202');
                        assert.equal(payload.pageContext.before.revision, 'r202');
                    }
                    driver.getPageSnapshot = originalSnapshot;
                    assert.deepEqual(state.dispatched, []);
                    assert.equal(state.current, '101');
                })
            );
        }
    }
});

test('C-R3 public manage also formats non-page handler rejections', async () => {
    await withPageFixture('extension', async ({ unified }) => {
        const restore = patchProperties(unified, {
            focusWindow: async () => {
                throw new TimeoutError('focus denied');
            },
        });
        try {
            const response = await registeredTool(registerManageTool)({ action: 'focusWindow', windowId: 7 });
            assert.equal(response.isError, true);
            assert.equal(JSON.parse(response.content[0].text).error.code, 'TIMEOUT');
        } finally {
            restore();
        }
    });
});

test('C1 explicit page IDs select the correct backend target and reject conflicts', async () => {
    assert.equal(resolvePageTargetId({ targetId: '202' }), '202');
    assert.equal(resolvePageTargetId({ tabId: '202' }), '202');
    assert.equal(resolvePageTargetId({ targetId: '202', tabId: '202' }), '202');
    assert.throws(() => resolvePageTargetId({ targetId: '202', tabId: '203' }), /不一致/);
    await assert.rejects(() => getUnifiedSession().closePage(''), /需要显式 targetId/);
});

test('C1 CDP explicit target is temporary, including when no default exists', async () => {
    const unified = getUnifiedSession();
    const cdp = getSession();
    const previous = {
        extensionBridge: unified.extensionBridge,
        activeMode: unified.activeMode,
        cdpExplicitlySelected: unified.cdpExplicitlySelected,
        cdp: cdp.cdp,
        getCurrentTargetId: cdp.getCurrentTargetId,
        listTargets: cdp.listTargets,
        selectPage: cdp.selectPage,
        deselectPage: cdp.deselectPage,
    };
    let current = 'p1';
    cdp.cdp = { isConnected: true };
    cdp.getCurrentTargetId = () => current;
    cdp.listTargets = async () => ['p1', 'p2'].map((targetId) => ({ targetId }));
    cdp.selectPage = async (targetId) => {
        current = targetId;
    };
    cdp.deselectPage = async () => {
        current = null;
    };
    unified.extensionBridge = null;
    unified.activeMode = 'cdp';
    unified.cdpExplicitlySelected = true;
    try {
        const target = await unified.withTabId('p2', async () => unified.getCurrentTargetId());
        assert.equal(target, 'p2');
        assert.equal(current, 'p1');
        current = null;
        const withoutDefault = await unified.withTabId('p2', async () => unified.getCurrentTargetId());
        assert.equal(withoutDefault, 'p2');
        assert.equal(current, null);
        await assert.rejects(() => unified.withTabId('missing', async () => {}), /不存在/);
    } finally {
        unified.extensionBridge = previous.extensionBridge;
        unified.activeMode = previous.activeMode;
        unified.cdpExplicitlySelected = previous.cdpExplicitlySelected;
        unified.pageMetadata.delete('cdp:p2');
        cdp.cdp = previous.cdp;
        cdp.getCurrentTargetId = previous.getCurrentTargetId;
        cdp.listTargets = previous.listTargets;
        cdp.selectPage = previous.selectPage;
        cdp.deselectPage = previous.deselectPage;
    }
});

test('C4 public extract keeps targeted reads on Extension read actions', async () => {
    const session = getUnifiedSession();
    const calls = [];
    let granted = true;
    const bridge = {
        isConnected: () => true,
        async find(selector, text, xpath, timeout, semanticOrPoint, matchIndex) {
            if (!granted) {
                throw new Error('只读权限未授予');
            }
            const point = semanticOrPoint && 'x' in semanticOrPoint ? semanticOrPoint : undefined;
            const semantic = semanticOrPoint && !('x' in semanticOrPoint) ? semanticOrPoint : undefined;
            calls.push({ action: 'find', selector, text, xpath, point, semantic, matchIndex });
            return matchIndex === 100
                ? []
                : [
                      {
                          refId: `ref_${matchIndex}`,
                          tag: 'div',
                          text: 'matched',
                          rect: { x: 0, y: 0, width: 1, height: 1 },
                      },
                  ];
        },
        async getText(selector, refId) {
            if (!granted) {
                throw new Error('只读权限未授予');
            }
            return refId ? `${refId}:text` : 'page text';
        },
        async getHtml(selector, outer, refId) {
            if (!granted) {
                throw new Error('只读权限未授予');
            }
            return refId ? `<div id="${refId}"></div>` : '<html lang="en"></html>';
        },
        async getAttribute(selector, refId, attribute) {
            if (!granted) {
                throw new Error('只读权限未授予');
            }
            calls.push({ action: 'attribute', refId, attribute });
            return `${refId}:value`;
        },
        async getComputedStyle(refId, prop) {
            if (!granted) {
                throw new Error('只读权限未授予');
            }
            calls.push({ action: 'style', refId, prop });
            return 'rgb(1, 2, 3)';
        },
        async getHtmlWithImages(selector, outer, refId) {
            if (!granted) {
                throw new Error('只读权限未授予');
            }
            calls.push({ action: 'images', refId });
            return { html: `<div id="${refId}"><img alt=""></div>`, images: [] };
        },
        getPageText: () => bridge.getText(),
        getPageHtml: () => bridge.getHtml(),
        async readPage(options) {
            if (!granted) {
                throw new Error('只读权限未授予');
            }
            calls.push({ action: 'readPage', refId: options?.refId });
            return { pageContent: 'selected subtree', viewport: { width: 1, height: 1 } };
        },
    };
    const overrides = {
        extensionBridge: bridge,
        activeMode: 'extension',
        getMode: () => 'extension',
        getCurrentTargetId: () => '902',
        getPageSnapshot: async (targetId) => ({ targetId, url: 'https://example.com/a', revision: 'r1' }),
        listTargets: async () => [{ targetId: '902' }],
        listTopology: async () => ({ activeTargetId: '902' }),
        withTabId: async (_targetId, action) => action(),
        withFrame: async (_frame, action) => action(),
        getDriver: async () => bridge,
        evaluate: async () => {
            throw new Error('arbitrary evaluate is not authorized');
        },
    };
    const original = new Map(Object.keys(overrides).map((key) => [key, Object.getOwnPropertyDescriptor(session, key)]));
    Object.assign(session, overrides);
    try {
        let handler;
        let schema;
        registerExtractTool({
            registerTool(name, options, callback) {
                assert.equal(name, 'extract');
                schema = options.inputSchema;
                handler = callback;
            },
        });
        const extract = async (args) => {
            const response = await handler(schema.parse({ targetId: '902', ...args }));
            return { response, payload: JSON.parse(response.content[0].text) };
        };

        assert.equal(
            (await extract({ type: 'text', target: { css: '.item', text: 'matched', nth: 60 }, timeout: 250 })).payload
                .content,
            'ref_60:text'
        );
        assert.equal(calls.at(-1).matchIndex, 60);
        assert.equal(
            (await extract({ type: 'text', target: { role: 'button', name: 'Submit' } })).payload.content,
            'ref_0:text'
        );
        assert.equal(calls.at(-1).semantic.role, 'button');
        assert.equal(calls.at(-1).semantic.name, 'Submit');
        assert.equal(
            (await extract({ type: 'html', target: { x: 3, y: 5 } })).payload.content,
            '<div id="ref_0"></div>'
        );
        assert.deepEqual(calls.at(-1).point, { x: 3, y: 5 });
        assert.equal(
            (await extract({ type: 'attribute', target: { css: '.item', nth: 1 }, attribute: 'value' })).payload.value,
            'ref_1:value'
        );
        assert.equal(
            (await extract({ type: 'attribute', target: { text: 'matched' }, attribute: 'computed:color' })).payload
                .value,
            'rgb(1, 2, 3)'
        );
        assert.deepEqual(calls.at(-1), { action: 'style', refId: 'ref_0', prop: 'color' });
        assert.equal(
            (await extract({ type: 'html', images: 'info', target: { css: '.item', nth: 55 } })).payload.content,
            '<div id="ref_55"><img alt=""></div>'
        );
        assert.deepEqual(calls.at(-1), { action: 'images', refId: 'ref_55' });
        assert.equal(
            (await extract({ type: 'state', target: { x: 3, y: 5 } })).payload.state.pageContent,
            'selected subtree'
        );
        assert.deepEqual(calls.at(-1), { action: 'readPage', refId: 'ref_0' });
        assert.equal((await extract({ type: 'text', target: { css: '.item', nth: 100 } })).payload.content, '');
        const previousReads = calls.filter((call) => call.action === 'readPage').length;
        const missing = await extract({ type: 'state', target: { css: '.item', nth: 100 } });
        assert.equal(missing.response.isError, true);
        assert.equal(calls.filter((call) => call.action === 'readPage').length, previousReads);

        granted = false;
        assert.equal((await extract({ type: 'html', target: { css: '.item' } })).response.isError, true);
    } finally {
        for (const [key, descriptor] of original) {
            if (descriptor) {
                Object.defineProperty(session, key, descriptor);
            } else {
                Reflect.deleteProperty(session, key);
            }
        }
    }
});

test('C2 page responses distinguish operation targets from defaults and browser activity', async () => {
    let defaultTargetId = '101';
    const session = {
        withTabLock: async (action) => action(),
        getTargetRestoration: () => undefined,
        getCurrentTargetId: () => defaultTargetId,
        async getPageSnapshot(targetId) {
            return { targetId, url: `https://example.com/${targetId}`, revision: `epoch:${targetId}` };
        },
        async listTargets() {
            return ['101', '202', '303'].map((targetId) => ({ targetId }));
        },
        getMode: () => 'cdp',
    };
    const response = await withPageResponse(session, '202', async () => {
        defaultTargetId = '303';
        return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
    });
    const { pageContext } = JSON.parse(response.content[0].text);
    assert.equal(pageContext.targetId, '202');
    assert.equal(pageContext.targetSource, 'explicit');
    assert.equal(pageContext.before.url, 'https://example.com/202');
    assert.equal(pageContext.after.revision, 'epoch:202');
    assert.equal(pageContext.defaultTargetIdBefore, '101');
    assert.equal(pageContext.defaultTargetIdAfter, '303');
    assert.equal(pageContext.browserActiveTargetStatus, 'unavailable');
    assert.equal(pageContext.browserActiveTargetId, null);

    const createdResponse = await withPageResponse(
        session,
        undefined,
        async () => ({
            content: [{ type: 'text', text: JSON.stringify({ success: true, createdTargetId: '202' }) }],
        }),
        true
    );
    assert.equal(JSON.parse(createdResponse.content[0].text).pageContext.targetSource, 'created');
    assert.equal(JSON.parse(createdResponse.content[0].text).pageContext.targetId, '202');
    const reusedResponse = await withPageResponse(
        session,
        undefined,
        async () => ({
            content: [{ type: 'text', text: JSON.stringify({ success: true, createdTargetId: null }) }],
        }),
        true
    );
    assert.equal(JSON.parse(reusedResponse.content[0].text).pageContext.targetSource, 'reused');

    const extensionSession = {
        ...session,
        getMode: () => 'extension',
        async listTopology() {
            return { activeTargetId: '303' };
        },
    };
    const extensionResponse = await withPageResponse(extensionSession, '202', async () => ({
        content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
    }));
    const extensionContext = JSON.parse(extensionResponse.content[0].text).pageContext;
    assert.equal(extensionContext.targetId, '202');
    assert.equal(extensionContext.browserActiveTargetId, '303');
    assert.equal(extensionContext.browserActiveTargetStatus, 'reported');
});

test('R29-CH-01 navigation waits and close redact only display URLs in both backends', async () => {
    const url = 'https://example.com/page?token=r29-secret&name=report';
    for (const mode of ['extension', 'cdp']) {
        await withPageFixture(mode, async ({ unified, driver }) => {
            let snapshots = 0;
            const restore = patchProperties(unified, {
                isExtensionConnected: () => mode === 'extension',
                evaluate: async () => ({
                    readyState: ++snapshots === 1 ? 'loading' : 'complete',
                    url,
                    title: 'New title',
                }),
            });
            const restoreDriver = patchProperties(mode === 'cdp' ? getSession() : driver, {
                waitForNavigation: async () => {},
                getState: () => ({ url, title: 'New title' }),
                getLiveState: async () => ({ url, title: 'New title' }),
                closePage: async () => ({ before: { url, title: 'New title' }, after: null }),
            });
            try {
                const wait = registeredTool(registerWaitTool);
                const body = JSON.parse((await wait({ for: 'navigation', timeout: 1000 })).content[0].text);
                assert.equal(body.url, 'https://example.com/page?token=[REDACTED]&name=report');
                assert.equal(body.title, 'New title');
                const closed = JSON.parse(
                    (await registeredTool(registerBrowseTool)({ action: 'close', targetId: '202' })).content[0].text
                );
                assert.equal(closed.affected.before.url, body.url);
                assert.equal(url.includes('r29-secret'), true);
            } finally {
                restoreDriver();
                restore();
            }
        });
    }
    const { NavigationError, NavigationTimeoutError } = await import('../dist/core/errors.js');
    for (const error of [new NavigationError(url, 'net::ERR_FAILED'), new NavigationTimeoutError(url, 1000)]) {
        assert.equal(error.context.url, url);
        const body = JSON.parse(formatErrorResponse(error).content[0].text);
        assert.equal(body.error.message.includes('r29-secret'), false);
        assert.match(body.error.message, /name=report/);
    }
});

test('R29-CH-01 real CDP close returns affected state through both registered tools', async (t) => {
    const url = 'https://example.com/owned?token=close-owned-secret&name=report';
    for (const [register, action] of [
        [registerBrowseTool, 'close'],
        [registerManageTool, 'closePage'],
    ]) {
        for (const outcome of ['success', 'refused', 'missing']) {
            await t.test(`${action}/${outcome}`, async () =>
                withPageFixture('cdp', async ({ state }) => {
                    const session = getSession();
                    const before = { id: '202', targetId: '202', type: 'page', url, title: 'Owned close target' };
                    const commands = [];
                    const restore = patchProperties(session, {
                        cdp: {
                            isConnected: true,
                            async send(method, params) {
                                commands.push({ method, params });
                                if (outcome === 'success') {
                                    state.targets.delete(params.targetId);
                                }
                                return { success: outcome === 'success' };
                            },
                        },
                        currentTargetId: '101',
                        pendingPageCondition: null,
                        listTargets: async () => (outcome === 'missing' ? [] : [before]),
                        closePage: Object.getPrototypeOf(session).closePage,
                    });
                    try {
                        const response = await registeredTool(register)({ action, targetId: '202' });
                        const body = JSON.parse(response.content[0].text);
                        assert.equal(response.content[0].text.includes('close-owned-secret'), false);
                        assert.equal(state.current, '101');
                        if (outcome === 'success') {
                            assert.equal(body.success, true, response.content[0].text);
                            assert.equal(body.affected.targetId, '202');
                            assert.equal(body.affected.before.title, before.title);
                            assert.equal(
                                body.affected.before.url,
                                'https://example.com/owned?token=[REDACTED]&name=report'
                            );
                            assert.equal(body.affected.after, null);
                            assert.equal(state.targets.has('202'), false);
                            assert.equal(before.url, url);
                        } else {
                            assert.equal(response.isError, true);
                            assert.equal(body.affected, undefined);
                            assert.equal(state.targets.has('202'), true);
                        }
                        assert.deepEqual(
                            commands,
                            outcome === 'missing' ? [] : [{ method: 'Target.closeTarget', params: { targetId: '202' } }]
                        );
                    } finally {
                        restore();
                    }
                })
            );
        }
    }
});

test('R29-CH-02 completed CDP waits read live title and URL with the remaining deadline', async () => {
    for (const scenario of ['live', 'failed', 'expired']) {
        await withPageFixture('cdp', async () => {
            let liveCalls = 0;
            let waits = 0;
            const restore = patchProperties(getSession(), {
                waitForNavigation: async () => {
                    ++waits;
                    await new Promise((resolve) => setTimeout(resolve, scenario === 'expired' ? 40 : 10));
                },
                getState: () => ({ url: 'https://example.com/old', title: 'Old title' }),
                getLiveState: async (timeout) => {
                    ++liveCalls;
                    assert.ok(timeout > 0 && timeout < 1000);
                    if (scenario === 'failed') {
                        throw new Error('live snapshot refused');
                    }
                    return { url: 'https://example.com/new?name=report', title: 'Fresh title' };
                },
            });
            try {
                const response = await registeredTool(registerWaitTool)({
                    for: 'navigation',
                    timeout: scenario === 'expired' ? 20 : 1000,
                });
                const body = JSON.parse(response.content[0].text);
                assert.equal(waits, 1);
                if (scenario === 'live') {
                    assert.equal(response.isError, undefined, response.content[0].text);
                    assert.equal(body.title, 'Fresh title');
                    assert.equal(body.url, 'https://example.com/new?name=report');
                } else {
                    assert.equal(response.isError, true);
                    assert.equal(body.error.context.waitCompleted, true);
                    assert.equal(body.error.context.failureStage, 'snapshot');
                    assert.equal(body.title, undefined);
                    assert.equal(body.url, undefined);
                }
                assert.equal(liveCalls, scenario === 'expired' ? 0 : 1);
            } finally {
                restore();
            }
        });
    }
});

test('registered browse, manage and extract outputs redact page URLs while retaining internal URLs', async () => {
    await withPageFixture('extension', async ({ unified }) => {
        const url = 'https://example.com/page?ticket=ticket-sentinel&%74oken=token-sentinel&name=report';
        const page = { targetId: '101', id: 101, url, pendingUrl: url, title: 'Page', managed: true };
        const window = { id: 1, tabs: [page] };
        const change = { targetId: '101', before: window, after: window };
        const restore = patchProperties(unified, {
            getState: () => page,
            getLiveState: async () => page,
            getPageSnapshot: async (targetId) => ({ targetId, url, revision: 'epoch:1' }),
            listTargets: async () => [page],
            listTopology: async () => ({ windows: [window], groups: [], activeTargetId: '101', windowCount: 1 }),
            newPage: async (requestedUrl) => {
                assert.equal(requestedUrl, url);
                return page;
            },
            adoptPage: async () => ({ target: page, managedBefore: false, managedAfter: true }),
            updatePage: async (_id, options) => {
                assert.equal(options.url, url);
                return change;
            },
            groupPages: async () => ({ before: [], after: [], tabsBefore: [page], tabsAfter: [page] }),
            newWindow: async () => change,
            readPage: async () => ({ url, pageContent: 'Sample page' }),
            getMetadata: async () => ({ url, title: 'Page' }),
            getFrames: async () => ({ frames: [{ url, frameId: 1 }] }),
            enableConsole: async () => {},
            enableNetwork: async () => {},
            getConsoleLogs: async () => [],
            getNetworkRequests: async () => [],
        });
        const outputs = [];
        const inspect = (response) => {
            assert.notEqual(response.isError, true, response.content[0].text);
            const payload = JSON.parse(response.content[0].text);
            assert.equal(JSON.stringify(payload).includes('-sentinel'), false);
            assert.match(JSON.stringify(payload), /\[REDACTED]/);
            assert.equal(page.url, url);
            return payload;
        };
        try {
            const browse = registeredTool(registerBrowseTool);
            const manage = registeredTool(registerManageTool);
            const extract = registeredTool(registerExtractTool);
            for (const details of ['summary', 'full']) {
                assert.equal(
                    inspect(await browse({ action: 'list', details })).targets[0].urlOriginalLength,
                    url.length
                );
            }
            inspect(await browse({ action: 'attach', targetId: '101' }));
            for (const args of [
                { action: 'newPage', url },
                { action: 'adoptPage', targetId: '101' },
                { action: 'updatePage', targetId: '101', url },
                { action: 'groupPages', targetIds: ['101'] },
                { action: 'newWindow', url },
            ]) {
                inspect(await manage(args));
            }
            for (const type of ['state', 'metadata', 'diagnosticBundle']) {
                inspect(await extract({ type }));
                const response = await extract({ type, output: `tmp:page-url-${randomUUID()}.json` });
                assert.notEqual(response.isError, true, response.content[0].text);
                const payload = JSON.parse(response.content[0].text);
                outputs.push(payload.output);
                const content = await readFile(payload.output, 'utf8');
                assert.equal(content.includes('-sentinel'), false);
                assert.match(content, /\[REDACTED]/);
            }
        } finally {
            restore();
            await Promise.all(outputs.map((output) => rm(output)));
        }
    });
});

test('pageContext redacts success and failure snapshots without changing internal URLs or script results', async () => {
    const url = 'https://example.com/page?ticket=ticket-sentinel&%74oken=token-sentinel&name=report';
    const snapshot = { targetId: '202', url, revision: 'epoch:1' };
    const session = {
        withTabLock: async (action) => action(),
        getTargetRestoration: () => undefined,
        getCurrentTargetId: () => '202',
        getPageSnapshot: async () => snapshot,
        listTargets: async () => [{ targetId: '202' }],
        getMode: () => 'cdp',
    };
    for (const fail of [false, true]) {
        let response;
        try {
            response = await withPageResponse(session, '202', async () => {
                assert.equal(snapshot.url, url);
                if (fail) {
                    throw new Error('target was not found');
                }
                return { content: [{ type: 'text', text: JSON.stringify({ success: true, result: { url } }) }] };
            });
        } catch (error) {
            response = formatErrorResponse(error);
        }
        const payload = JSON.parse(response.content[0].text);
        assert.equal(response.isError === true, fail);
        for (const record of [payload.pageContext.before, payload.pageContext.after]) {
            assert.equal(record.url, 'https://example.com/page?ticket=[REDACTED]&%74oken=[REDACTED]&name=report');
            assert.equal(record.urlRedacted, true);
            assert.equal(record.urlOriginalLength, url.length);
            assert.deepEqual(record.redactedQueryParameters, ['ticket', 'token']);
        }
        if (!fail) {
            assert.equal(payload.result.url, url);
        }
        assert.equal(snapshot.url, url);
    }
});

test('window bounds errors preserve the native cause without suggesting page activation', () => {
    const message = 'Invalid value for bounds. Bounds must be at least 50% within visible screen space.';
    const payload = JSON.parse(formatErrorResponse(new Error(message)).content[0].text);
    assert.equal(payload.error.message, message);
    assert.equal(payload.hint, undefined);
});

test('screenshot visibility errors keep page activation guidance', () => {
    for (const message of ['screenshot needs a visible tab', 'Cannot capture a hidden tab', 'No active tab']) {
        const payload = JSON.parse(formatErrorResponse(new Error(message)).content[0].text);
        assert.match(payload.hint, /activatePage/);
        assert.match(payload.hint, /focusWindow/);
    }
});

test('structured page errors redact URL conditions and preserve the original error context', () => {
    const url = 'https://example.com/page?ticket=ticket-sentinel&name=report';
    const error = new PagePreconditionError({
        url,
        currentUrl: url,
        expectedUrl: url,
        actualUrl: url,
        frameContext: { url },
        result: { url },
    });
    const payload = JSON.parse(formatErrorResponse(error).content[0].text);
    for (const field of ['url', 'currentUrl', 'expectedUrl', 'actualUrl']) {
        assert.equal(payload.error.context[field], 'https://example.com/page?ticket=[REDACTED]&name=report');
        assert.equal(error.context[field], url);
    }
    assert.equal(payload.error.context.frameContext.url, 'https://example.com/page?ticket=[REDACTED]&name=report');
    assert.equal(payload.error.context.result.url, url);
    assert.equal(payload.error.context.actionExecuted, false);
});

test('C25 legacy snapshots return fresh URLs with an explicit unavailable revision', async () => {
    const bridge = Object.create(ExtensionBridge.prototype);
    let url = 'https://example.com/before';
    const actions = [];
    bridge.httpServer = {
        async sendCommand(action, params) {
            actions.push(action);
            if (action === 'page_snapshot') {
                assert.deepEqual(params, { tabId: 901 });
                throw new Error('Unknown action: page_snapshot');
            }
            assert.equal(action, 'tabs_list');
            return [{ id: 901, url, title: 'Owned legacy page' }];
        },
    };
    const before = await bridge.getPageSnapshot('901');
    assert.equal(before.url, url);
    assert.equal(before.revision, null);
    assert.match(before.warning, /revision/);
    url = 'https://example.com/after';
    const after = await bridge.getPageSnapshot('901');
    assert.equal(after.targetId, '901');
    assert.equal(after.url, url);
    assert.equal(after.revision, null);
    assert.deepEqual(actions, ['page_snapshot', 'tabs_list', 'page_snapshot', 'tabs_list']);
});

test('C25 legacy capability warnings do not block unconditional page actions', async () => {
    const bridge = Object.create(ExtensionBridge.prototype);
    bridge.currentTabId = 901;
    let url = 'https://example.com/before';
    let navigations = 0;
    bridge.httpServer = {
        async sendCommand(action, params) {
            if (action === 'page_snapshot') {
                throw new Error('Unknown action: page_snapshot');
            }
            if (action === 'tabs_list') {
                return [{ id: 901, url, title: 'Owned legacy page' }];
            }
            assert.equal(action, 'navigate');
            assert.equal(params.tabId, 901);
            url = params.url;
            ++navigations;
            return { id: 901, url, title: 'Owned legacy page' };
        },
    };
    const session = {
        withTabLock: async (action) => action(),
        getTargetRestoration: () => undefined,
        getCurrentTargetId: () => bridge.getCurrentTargetId(),
        getPageSnapshot: (id, timeout) => bridge.getPageSnapshot(id, timeout),
        listTargets: (timeout) => bridge.listTargets(timeout),
        getMode: () => 'extension',
        listTopology: async () => ({ activeTargetId: '901' }),
    };
    const response = await withPageResponse(session, '901', async () => {
        await bridge.navigate('https://example.com/after');
        return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
    });
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.success, true);
    assert.equal(navigations, 1);
    assert.equal(payload.pageContext.before.url, 'https://example.com/before');
    assert.equal(payload.pageContext.after.url, 'https://example.com/after');
    assert.equal(payload.pageContext.before.revision, null);
    assert.equal(payload.pageContext.after.revision, null);
    assert.match(payload.pageContext.before.warning, /revision/);
    assert.match(payload.pageContext.after.warning, /revision/);
});

test('C25 snapshot compatibility preserves missing targets and unrelated failures', async () => {
    const bridge = Object.create(ExtensionBridge.prototype);
    let failure;
    let listCalls = 0;
    let listFailure;
    bridge.httpServer = {
        async sendCommand(action) {
            if (action === 'page_snapshot') {
                throw failure;
            }
            assert.equal(action, 'tabs_list');
            ++listCalls;
            if (listFailure) {
                throw listFailure;
            }
            return [{ id: 902, url: 'https://example.com/other' }];
        },
    };
    for (const message of ['Unknown action: page_snapshots', 'Extension disconnected', 'snapshot read denied']) {
        failure = new Error(message);
        await assert.rejects(
            () => bridge.getPageSnapshot('901'),
            (error) => error === failure
        );
    }
    assert.equal(listCalls, 0);
    failure = new Error('Unknown action: page_snapshot');
    await assert.rejects(() => bridge.getPageSnapshot('901'), TargetNotFoundError);
    assert.equal(listCalls, 1);
    listFailure = new Error('legacy page list denied');
    await assert.rejects(
        () => bridge.getPageSnapshot('901'),
        (error) => error === listFailure
    );
    assert.equal(listCalls, 2);
});

test('C25 legacy snapshot RPCs share the original deadline', async () => {
    const bridge = Object.create(ExtensionBridge.prototype);
    const originalNow = Date.now;
    let now = 1000;
    let snapshotDelay = 60;
    let listDelay = 20;
    const calls = [];
    Date.now = () => now;
    bridge.httpServer = {
        async sendCommand(action, _params, timeout) {
            calls.push({ action, timeout });
            if (action === 'page_snapshot') {
                now += snapshotDelay;
                throw new Error('Unknown action: page_snapshot');
            }
            assert.equal(action, 'tabs_list');
            now += listDelay;
            return [{ id: 901, url: 'https://example.com/owned' }];
        },
    };
    try {
        assert.equal((await bridge.getPageSnapshot('901', 200)).revision, null);
        assert.deepEqual(calls, [
            { action: 'page_snapshot', timeout: 200 },
            { action: 'tabs_list', timeout: 140 },
        ]);
        calls.length = 0;
        snapshotDelay = 25;
        await assert.rejects(() => bridge.getPageSnapshot('901', 20), TimeoutError);
        assert.deepEqual(calls, [{ action: 'page_snapshot', timeout: 20 }]);
        calls.length = 0;
        snapshotDelay = 5;
        listDelay = 20;
        await assert.rejects(() => bridge.getPageSnapshot('901', 20), TimeoutError);
        assert.deepEqual(calls, [
            { action: 'page_snapshot', timeout: 20 },
            { action: 'tabs_list', timeout: 15 },
        ]);
    } finally {
        Date.now = originalNow;
    }
});

test('C25 unavailable atomic conditions reject before dispatch and preserve modern checks', async () => {
    await withPageFixture('extension', async ({ unified, driver }) => {
        const originalSnapshot = driver.getPageSnapshot;
        driver.getPageSnapshot = async (targetId) => ({
            targetId,
            url: 'https://example.com/101',
            revision: null,
            warning: 'revision unavailable',
        });
        let dispatched = 0;
        for (const condition of [
            { expectedUrl: 'https://example.com/101' },
            { expectedUrl: 'https://example.com/other' },
            { expectedRevision: 'old' },
        ]) {
            await assert.rejects(
                () => unified.withPageCondition(condition, async () => ++dispatched),
                (error) => {
                    const payload = JSON.parse(formatErrorResponse(error).content[0].text);
                    assert.equal(payload.error.code, 'DRIVER_CAPABILITY_ERROR');
                    assert.equal(payload.error.context.actionExecuted, false);
                    assert.equal(payload.error.context.actionStatus, 'not_started');
                    return true;
                }
            );
        }
        assert.equal(dispatched, 0);
        driver.getPageSnapshot = originalSnapshot;
        await unified.withPageCondition(
            { expectedUrl: 'https://example.com/101', expectedRevision: 'r101' },
            async () => ++dispatched
        );
        await assert.rejects(
            () => unified.withPageCondition({ expectedRevision: 'stale' }, async () => ++dispatched),
            PagePreconditionError
        );
        assert.equal(dispatched, 1);
    });
});

test('C27 public legacy conditions preserve not_started and zero dispatch', async (t) => {
    for (const [name, register, action] of [
        ['evaluate', registerEvaluateTool, { script: 'owned-action' }],
        ['input', registerInputTool, { events: [{ type: 'keydown', key: 'a' }] }],
    ]) {
        for (const condition of [{ expectedUrl: 'https://example.com/202' }, { expectedRevision: 'legacy-revision' }]) {
            await t.test(`${name}/${Object.keys(condition)[0]}`, async () => {
                await withPageFixture('extension', async ({ unified, driver, state }) => {
                    const originalSnapshot = driver.getPageSnapshot;
                    driver.getPageSnapshot = async (targetId) => ({
                        ...(await originalSnapshot(targetId)),
                        revision: null,
                        warning: 'revision unavailable',
                    });
                    let evaluations = 0;
                    const restore = patchProperties(unified, {
                        evaluate: async () => ++evaluations,
                    });
                    try {
                        const response = await registeredTool(register)({ targetId: '202', ...condition, ...action });
                        const body = JSON.parse(response.content[0].text);
                        assert.equal(response.isError, true);
                        assert.equal(body.error.code, 'DRIVER_CAPABILITY_ERROR');
                        assert.equal(body.actionExecuted, false);
                        assert.equal(body.actionStatus, 'not_started');
                        assert.equal(body.failureStage, 'precondition');
                        assert.equal(body.retryable, false);
                        assert.equal(body.error.context.actionExecuted, body.actionExecuted);
                        assert.equal(body.error.context.actionStatus, body.actionStatus);
                        assert.equal(body.error.context.failureStage, body.failureStage);
                        assert.equal(body.pageContext.targetId, '202');
                        assert.equal(body.pageContext.before.revision, null);
                        assert.equal(body.pageContext.after.revision, null);
                        assert.equal(body.diagnosticsStatus, 'disabled');
                        if (name === 'input') {
                            assert.equal(body.eventsExecuted, 0);
                        }
                        assert.equal(evaluations, 0);
                        assert.deepEqual(state.dispatched, []);
                        assert.equal(state.current, '101');
                    } finally {
                        restore();
                    }
                });
            });
        }
    }
});

test('C27 capability errors without a precondition contract remain action failures', async () => {
    for (const [register, action] of [
        [registerEvaluateTool, { script: 'owned-action' }],
        [registerInputTool, { events: [{ type: 'keydown', key: 'a' }] }],
    ]) {
        await withPageFixture('extension', async ({ unified }) => {
            const restore = patchProperties(unified, {
                withPageCondition: async () => {
                    throw new StructuredToolError(
                        'DRIVER_CAPABILITY_ERROR',
                        'unsupported action',
                        'check capability',
                        {}
                    );
                },
            });
            try {
                const response = await registeredTool(register)({ targetId: '202', ...action });
                const body = JSON.parse(response.content[0].text);
                assert.equal(response.isError, true);
                assert.equal(body.error.code, 'DRIVER_CAPABILITY_ERROR');
                assert.equal(body.actionStatus, 'failed');
                assert.equal(body.failureStage, 'action');
            } finally {
                restore();
            }
        });
    }
});

test('C31F7 before snapshot unknown preserves zero main action and auxiliary RPC facts', async () => {
    for (const [register, action] of [
        [registerEvaluateTool, { script: 'owned-action' }],
        [
            registerInputTool,
            {
                events: [
                    { type: 'keydown', key: 'x' },
                    { type: 'keyup', key: 'x' },
                ],
            },
        ],
    ]) {
        await withPageFixture('extension', async ({ unified }) => {
            let actions = 0;
            const original = new StructuredToolError(
                'EXECUTION_RESULT_UNKNOWN',
                'Request timeout for action: page_snapshot',
                'Read current state',
                {
                    actionExecuted: 'unknown',
                    actionStatus: 'unknown',
                    failureStage: 'rpc',
                    retryable: false,
                    nativeCode: -32000,
                }
            );
            const restore = patchProperties(unified, {
                getPageSnapshot: async () => {
                    throw original;
                },
                withPageCondition: async () => {
                    ++actions;
                    throw new Error('Unexpected action');
                },
            });
            try {
                const response = await registeredTool(register)({ targetId: '202', ...action });
                const body = JSON.parse(response.content[0].text);
                assert.equal(response.isError, true);
                assert.equal(actions, 0);
                assert.equal(body.actionExecuted, false);
                assert.equal(body.actionStatus, 'not_started');
                assert.equal(body.failureStage, 'context');
                assert.equal(body.retryable, false);
                assert.equal(body.error.code, original.code);
                assert.equal(body.error.message, original.message);
                assert.equal(body.pageContext.contextPhase, 'before');
                assert.deepEqual(body.error, original.toJSON().error);
                assert.equal(original.context.actionExecuted, 'unknown');
                assert.equal(body.pageContext.before, null);
                assert.equal(body.pageContext.after, null);
                if (register === registerInputTool) {
                    assert.equal(body.eventsExecuted, 0);
                    assert.equal(body.remainingEventsNotExecuted, 2);
                }
            } finally {
                restore();
            }
            await assert.rejects(
                () =>
                    withPageResponse(unified, '202', async () => {
                        throw original;
                    }),
                (error) => {
                    assert.equal(error, original);
                    assert.equal(classifyEvaluateFailure(error).actionExecuted, 'unknown');
                    assert.equal(
                        JSON.parse(formatErrorResponse(error).content[0].text).pageContext.contextPhase,
                        'action'
                    );
                    return true;
                }
            );
        });
    }
});

test('C31F9 SDK preparation matrix preserves principal dispatch, cancellation and late ACKs', async (t) => {
    const checks = [];
    let sdkCalls = 0;
    let registeredCalls = 0;
    const stages = [
        'before',
        'precondition',
        'targetlist',
        'targetselect',
        'frame',
        'challenge-state',
        'title',
        'inspect',
        'main',
        'after',
        'cancel',
    ];
    for (const name of ['evaluate', 'input']) {
        const adjacent =
            name === 'evaluate'
                ? ['args-global']
                : ['event-find', 'event-find-after-key', 'event-script-global', 'event-script-main'];
        for (const stage of [...stages, ...adjacent]) {
            const row = {
                name: `${name}/${stage}`,
                group: stages.includes(stage) ? 'fixed24' : 'adjacent',
                status: 'RUNNING',
                rpc: [],
            };
            await t.test(row.name, async (st) => {
                try {
                    await withPageFixture('extension', async ({ unified }) => {
                        const bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() });
                        bridge.setCurrentTargetId('101');
                        const rpc = bridge.httpServer;
                        rpc.clientSocket = { readyState: 1 };
                        const tabs = [101, 202].map((id) => ({
                            id,
                            url: `https://example.com/${id}`,
                            title: 'Owned page',
                            managed: true,
                        }));
                        let snapshots = 0;
                        let lists = 0;
                        let held;
                        let holdEnabled = true;
                        let heldResolve;
                        const heldReady = new Promise((resolve) => {
                            heldResolve = resolve;
                        });
                        const responseData = (message) => {
                            switch (message.action) {
                                case 'page_snapshot':
                                    return {
                                        targetId: String(message.params.tabId),
                                        url: `https://example.com/${message.params.tabId}`,
                                        revision: `r${message.params.tabId}`,
                                    };
                                case 'tabs_list':
                                    return tabs;
                                case 'resolve_frame':
                                    return {
                                        frameId: 7,
                                        offset: { x: 0, y: 0 },
                                        frameContext: { documentId: 'owned-child' },
                                    };
                                case 'network_challenge_state':
                                    return { challengeRequired: false };
                                case 'challenge_inspect':
                                    return { title: 'Owned page', inspected: true, selectorHits: [], textHits: [] };
                                case 'debugger_send':
                                    assert.ok(
                                        [
                                            'Runtime.evaluate',
                                            'Runtime.callFunctionOn',
                                            'Runtime.releaseObject',
                                        ].includes(message.params.method),
                                        message.params.method
                                    );
                                    return message.params.params?.expression === 'globalThis'
                                        ? { result: { type: 'object', objectId: 'owned-global' } }
                                        : { result: { type: 'number', value: 1 } };
                                case 'keyboard_focus':
                                    return message.params.operation === 'acquire'
                                        ? { changed: false }
                                        : { restored: true, errors: [] };
                                case 'input_key':
                                    return { success: true };
                                case 'find':
                                    return [
                                        {
                                            refId: 'owned-input',
                                            tag: 'input',
                                            text: '',
                                            rect: { x: 0, y: 0, width: 80, height: 24 },
                                        },
                                    ];
                                default:
                                    assert.fail(`Unexpected protocol action ${message.action}`);
                            }
                        };
                        const deliver = (message) =>
                            rpc.handleMessage(
                                JSON.stringify({ id: message.id, success: true, data: responseData(message) })
                            );
                        const restoreRpc = patchProperties(rpc, {
                            isConnected: () => true,
                            sendMessage(_socket, message) {
                                row.rpc.push(message);
                                if (message.type === 'cancel') {
                                    return;
                                }
                                if (message.action === 'page_snapshot') {
                                    ++snapshots;
                                }
                                if (message.action === 'tabs_list') {
                                    ++lists;
                                }
                                const principal =
                                    name === 'evaluate'
                                        ? message.action === 'debugger_send' &&
                                          message.params.params?.expression?.includes('__phaseActions')
                                        : (message.action === 'input_key' && message.params.type === 'keyDown') ||
                                          (message.action === 'debugger_send' &&
                                              message.params.method === 'Runtime.callFunctionOn' &&
                                              message.params.params?.functionDeclaration?.includes(
                                                  'function(action, text, command)'
                                              ));
                                const selected =
                                    (stage === 'before' && message.action === 'page_snapshot' && snapshots === 1) ||
                                    (['precondition', 'cancel'].includes(stage) &&
                                        message.action === 'page_snapshot' &&
                                        snapshots === 2) ||
                                    (stage === 'targetlist' && message.action === 'tabs_list' && lists === 1) ||
                                    (stage === 'targetselect' && message.action === 'tabs_list' && lists === 2) ||
                                    (stage === 'frame' && message.action === 'resolve_frame') ||
                                    (stage === 'challenge-state' && message.action === 'network_challenge_state') ||
                                    (stage === 'title' && message.action === 'tabs_list' && lists === 2) ||
                                    (stage === 'inspect' && message.action === 'challenge_inspect') ||
                                    (stage === 'main' && principal) ||
                                    (stage === 'args-global' &&
                                        message.action === 'debugger_send' &&
                                        message.params.params?.expression === 'globalThis') ||
                                    (stage.startsWith('event-find') && message.action === 'find') ||
                                    (stage === 'event-script-global' &&
                                        message.action === 'debugger_send' &&
                                        message.params.params?.expression === 'globalThis') ||
                                    (stage === 'event-script-main' && principal) ||
                                    (stage === 'after' && message.action === 'page_snapshot' && snapshots === 3);
                                if (holdEnabled && selected) {
                                    held = message;
                                    heldResolve();
                                    return;
                                }
                                deliver(message);
                            },
                        });
                        const prototype = Object.getPrototypeOf(unified);
                        const restoreUnified = patchProperties(unified, {
                            extensionBridge: bridge,
                            getDriver: async () => bridge,
                            isExtensionConnected: () => true,
                            inputMode: 'precise',
                            getChallengeState: prototype.getChallengeState.bind(unified),
                            getLiveState: prototype.getLiveState.bind(unified),
                            inspectChallenge: prototype.inspectChallenge.bind(unified),
                            extensionChallengeStateUnsupported: false,
                            unsupportedChallengeStateBundleHash: null,
                        });
                        const server = new McpServer({ name: 'owned-phase-server', version: '3.0.1' });
                        const client = new Client({ name: 'owned-phase-client', version: '1.0.0' });
                        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
                        let completedResolve;
                        let completed = new Promise((resolve) => {
                            completedResolve = resolve;
                        });
                        let handlerBody;
                        const registerTool = server.registerTool.bind(server);
                        server.registerTool = (toolName, options, handler) =>
                            registerTool(toolName, options, async (args, extra) => {
                                ++registeredCalls;
                                try {
                                    const result = await handler(args, extra);
                                    handlerBody = JSON.parse(result.content[0].text);
                                    return result;
                                } finally {
                                    completedResolve();
                                }
                            });
                        (name === 'evaluate' ? registerEvaluateTool : registerInputTool)(server);
                        st.after(async () => {
                            const cleanup = await Promise.allSettled([client.close(), server.close()]);
                            row.cleanupErrors = cleanup
                                .filter((result) => result.status === 'rejected')
                                .map((result) => String(result.reason));
                            assert.deepEqual(row.cleanupErrors, []);
                        });
                        try {
                            await server.connect(serverTransport);
                            await client.connect(clientTransport);
                            const targetId = stage === 'targetselect' ? '202' : '101';
                            const challenge = ['challenge-state', 'title', 'inspect'].includes(stage);
                            const args = {
                                targetId,
                                timeout: 300,
                                ...(challenge ? {} : { expectedRevision: `r${targetId}` }),
                                ...(stage === 'frame' ? { frame: '#child' } : {}),
                                ...(name === 'evaluate'
                                    ? stage === 'args-global'
                                        ? {
                                              script: '() => { globalThis.__phaseActions=(globalThis.__phaseActions||0)+1; return 1; }',
                                              args: [],
                                              mode: 'precise',
                                          }
                                        : {
                                              script: 'globalThis.__phaseActions=(globalThis.__phaseActions||0)+1',
                                              mode: 'precise',
                                          }
                                    : stage.startsWith('event-script')
                                      ? { events: [{ type: 'editorInsert', text: 'owned' }] }
                                      : stage.startsWith('event-find')
                                        ? {
                                              events: [
                                                  ...(stage === 'event-find-after-key'
                                                      ? [{ type: 'keydown', key: 'x' }]
                                                      : []),
                                                  {
                                                      type: 'type',
                                                      mode: 'controlled',
                                                      target: { css: '#owned-input' },
                                                      text: 'owned',
                                                  },
                                              ],
                                          }
                                        : {
                                              events: [
                                                  { type: 'keydown', key: 'x' },
                                                  { type: 'keyup', key: 'x' },
                                              ],
                                          }),
                            };
                            row.arguments = args;
                            const abort = new AbortController();
                            const started = performance.now();
                            ++sdkCalls;
                            const call = client.callTool({ name, arguments: args }, undefined, {
                                signal: abort.signal,
                            });
                            if (stage === 'cancel') {
                                await Promise.race([
                                    heldReady,
                                    call.then(() => {
                                        throw new Error('Selected preparation RPC was not reached');
                                    }),
                                ]);
                                abort.abort(new Error('phase cancelled'));
                                await assert.rejects(call, /abort|cancel/i);
                                await completed;
                                row.handlerResponse = handlerBody;
                                assert.equal(handlerBody.actionExecuted, false);
                                assert.equal(handlerBody.actionStatus, 'not_started');
                                assert.equal(handlerBody.failureStage, 'precondition');
                            } else {
                                const response = await call;
                                row.response = JSON.parse(response.content[0].text);
                                const body = row.response;
                                if (stage === 'main' || stage === 'event-script-main') {
                                    assert.equal(body.actionExecuted, 'unknown');
                                    assert.equal(body.actionStatus, 'unknown');
                                } else if (stage === 'after') {
                                    assert.equal(body.actionExecuted, true);
                                    assert.equal(body.actionStatus, 'completed');
                                    assert.equal(body.pageContext.after, null);
                                } else if (stage === 'event-find-after-key') {
                                    assert.equal(body.actionExecuted, true);
                                    assert.equal(body.actionStatus, 'failed');
                                    assert.equal(body.eventsExecuted, 1);
                                    assert.equal(body.remainingEventsNotExecuted, 1);
                                    assert.equal(body.failureStage, 'context');
                                } else {
                                    assert.equal(body.actionExecuted, false);
                                    assert.equal(body.actionStatus, 'not_started');
                                    if (!challenge) {
                                        assert.equal(
                                            body.failureStage,
                                            stage === 'precondition' ? 'precondition' : 'context'
                                        );
                                    }
                                }
                            }
                            row.elapsedMs = performance.now() - started;
                            assert.ok(held, `Selected RPC missing: ${JSON.stringify(row.rpc)}`);
                            const principalCount = () =>
                                row.rpc.filter((message) =>
                                    name === 'evaluate'
                                        ? message.action === 'debugger_send' &&
                                          message.params.params?.expression?.includes('__phaseActions')
                                        : (message.action === 'input_key' && message.params.type === 'keyDown') ||
                                          (message.action === 'debugger_send' &&
                                              message.params.method === 'Runtime.callFunctionOn' &&
                                              message.params.params?.functionDeclaration?.includes(
                                                  'function(action, text, command)'
                                              ))
                                ).length;
                            row.principalRequests = principalCount();
                            assert.equal(
                                row.principalRequests,
                                ['main', 'after', 'event-find-after-key', 'event-script-main'].includes(stage) ? 1 : 0
                            );
                            deliver(held);
                            held = undefined;
                            assert.equal(principalCount(), row.principalRequests);
                            assert.equal(rpc.messageHandlers.size, 0);
                            assert.deepEqual([...unified.pressedKeys], []);
                            assert.equal(bridge.getCurrentFrameId(), 0);
                            assert.equal(bridge.pendingPageCondition, null);
                            assert.equal(client._responseHandlers.size, 0);
                            assert.equal(server.server._responseHandlers.size, 0);
                            row.afterLateReply = {
                                pending: rpc.messageHandlers.size,
                                frameId: bridge.getCurrentFrameId(),
                                targetId: bridge.getCurrentTargetId(),
                                keys: [...unified.pressedKeys],
                            };
                            if (stage === 'targetselect') {
                                const restoration = row.response.pageContext.targetRestoration;
                                assert.ok(['restored', 'failed'].includes(restoration.status));
                                assert.equal(restoration.previousTargetId, '101');
                                assert.equal(restoration.temporaryTargetId, '202');
                                assert.equal(
                                    row.afterLateReply.targetId,
                                    restoration.status === 'restored' ? '101' : null
                                );
                                assert.equal(restoration.currentTargetId, row.afterLateReply.targetId);
                                if (restoration.status === 'failed') {
                                    assert.match(restoration.error, /timeout|timed out|超时/i);
                                }
                            }
                            row.status = 'PASS';
                            if (stage === 'cancel') {
                                holdEnabled = false;
                                completed = new Promise((resolve) => {
                                    completedResolve = resolve;
                                });
                                ++sdkCalls;
                                const response = await client.callTool({ name, arguments: args });
                                const body = JSON.parse(response.content[0].text);
                                const followup = {
                                    name: `${name}/followup`,
                                    group: 'fixed24',
                                    status: 'RUNNING',
                                    response: body,
                                };
                                checks.push(followup);
                                assert.equal(body.actionExecuted, true);
                                assert.equal(body.actionStatus, 'completed');
                                assert.equal(rpc.messageHandlers.size, 0);
                                assert.deepEqual([...unified.pressedKeys], []);
                                followup.status = 'PASS';
                            }
                        } finally {
                            if (held) {
                                deliver(held);
                                row.afterLateReply = {
                                    pending: rpc.messageHandlers.size,
                                    frameId: bridge.getCurrentFrameId(),
                                    targetId: bridge.getCurrentTargetId(),
                                    keys: [...unified.pressedKeys],
                                };
                            }
                            restoreUnified();
                            restoreRpc();
                        }
                    });
                } catch (error) {
                    row.status = 'FAIL';
                    row.error = String(error);
                    throw error;
                } finally {
                    checks.push(row);
                }
            });
        }
    }
    if (process.env.C31F9_PHASE_OUTPUT) {
        await writeFile(
            process.env.C31F9_PHASE_OUTPUT,
            JSON.stringify(
                {
                    boundary:
                        'Actual SDK Client/McpServer and production tool/session/Bridge/HttpServer, with a controlled Extension protocol peer; no Chrome, DOM or native input',
                    sdkCalls,
                    registeredCalls,
                    checks,
                },
                null,
                2
            ) + '\n'
        );
    }
    assert.equal(sdkCalls, 29);
    assert.equal(registeredCalls, 29);
    assert.equal(checks.length, 29);
    assert.equal(checks.filter((row) => row.group === 'fixed24').length, 24);
    assert.equal(checks.filter((row) => row.group === 'adjacent').length, 5);
});

test('C31F9 CSP text keeps page exception origin through production evaluation and formatting', async (t) => {
    const cases = [];
    for (const message of [
        'CSP business validation failed',
        'Content Security Policy business validation failed',
        "'unsafe-eval' business validation failed",
        'ordinary business validation failed',
        'Execution was terminated',
    ]) {
        for (const reject of [false, true]) {
            for (const args of [undefined, []]) {
                cases.push({ message, reject, args });
            }
        }
    }
    for (const result of ['CSP result', 'Content Security Policy result']) {
        cases.push({ result });
    }
    assert.equal(cases.length, 22);
    for (const [index, item] of cases.entries()) {
        await t.test(`${index}/${item.message ?? item.result}/${item.reject}/${item.args !== undefined}`, async () => {
            await withPageFixture('cdp', async ({ unified }) => {
                const cdp = getSession();
                const context = createContext({ __actions: 0 });
                const calls = [];
                const restore = patchProperties(cdp, {
                    ensureSession() {},
                    async send(method, params, _timeout, dispatchedAction) {
                        calls.push({ method, params });
                        const action = unified.tabLockContext.getStore()?.userAction;
                        if (action && dispatchedAction === action.kind) {
                            action.dispatched = true;
                        }
                        if (method === 'Runtime.releaseObject') {
                            return {};
                        }
                        if (method === 'Runtime.evaluate' && params.expression === 'globalThis') {
                            return { result: { type: 'object', objectId: 'owned-global' } };
                        }
                        assert.ok(['Runtime.evaluate', 'Runtime.callFunctionOn'].includes(method), method);
                        const source =
                            method === 'Runtime.callFunctionOn'
                                ? `(${params.functionDeclaration})(...${JSON.stringify(params.arguments.map((arg) => arg.value))})`
                                : params.expression;
                        try {
                            const value = await runInContext(source, context);
                            return { result: { type: typeof value, value } };
                        } catch (error) {
                            return {
                                exceptionDetails: { text: 'Uncaught', exception: { description: String(error) } },
                            };
                        }
                    },
                });
                const restoreUnified = patchProperties(unified, { isExtensionConnected: () => false });
                try {
                    const bodySource =
                        item.message === undefined
                            ? `return ${JSON.stringify(item.result)}`
                            : item.reject
                              ? `return Promise.reject(new Error(${JSON.stringify(item.message)}))`
                              : `throw new Error(${JSON.stringify(item.message)})`;
                    const script = `function () { globalThis.__actions++; ${bodySource}; }`;
                    const response = await registeredTool(registerEvaluateTool)({
                        targetId: '101',
                        expectedRevision: 'r101',
                        mode: 'precise',
                        timeout: 1200,
                        script: item.args === undefined ? `(${script})()` : `(${script})`,
                        ...(item.args === undefined ? {} : { args: item.args }),
                    });
                    const body = JSON.parse(response.content[0].text);
                    assert.equal(context.__actions, 1);
                    assert.equal(
                        calls.filter(
                            (call) =>
                                call.method ===
                                    (item.args === undefined ? 'Runtime.evaluate' : 'Runtime.callFunctionOn') &&
                                (call.params.expression ?? call.params.functionDeclaration).includes('__actions')
                        ).length,
                        1
                    );
                    assert.equal(body.actionExecuted, true);
                    assert.equal(body.retryable, false);
                    if (item.message === undefined) {
                        assert.equal(response.isError, undefined, response.content[0].text);
                        assert.equal(body.actionStatus, 'completed');
                        assert.equal(body.result, item.result);
                    } else {
                        assert.equal(response.isError, true);
                        assert.equal(body.error.code, 'UNKNOWN_ERROR');
                        assert.equal(body.error.message, `Error: ${item.message}`);
                        assert.equal(body.actionStatus, 'failed');
                        assert.equal(body.failureStage, 'action');
                        assert.doesNotMatch(body.error.suggestion ?? '', /mode="precise"/);
                    }
                } finally {
                    restoreUnified();
                    restore();
                }
            });
        });
    }
});

test('C31F10 page JSON exceptions remain text while trusted structured errors retain their fields', () => {
    const messages = [
        JSON.stringify({ error: { code: 'APP_VALIDATION', message: 'owned business detail' } }),
        JSON.stringify({
            error: {
                code: 'CSP_BLOCKED',
                message: 'owned business reason',
                suggestion: 'page suggestion',
                context: { actionExecuted: false },
            },
            success: true,
        }),
        'hidden field validation failed',
        'visible business state is invalid',
    ];
    for (const message of messages) {
        const error = setErrorSource(new Error(message), 'page');
        const body = JSON.parse(formatErrorResponse(error).content[0].text);
        assert.deepEqual(body, { error: { code: 'UNKNOWN_ERROR', message } });
        assert.deepEqual(classifyEvaluateFailure(error), {
            failureStage: 'action',
            actionExecuted: true,
            actionStatus: 'failed',
            retryable: false,
        });
    }
    const trusted = new StructuredToolError('OWNED_PROTOCOL_ERROR', 'owned internal failure', 'read current state', {
        actionExecuted: 'unknown',
    });
    for (const error of [trusted, setErrorSource(new Error(JSON.stringify(trusted.toJSON())), 'protocol')]) {
        assert.deepEqual(JSON.parse(formatErrorResponse(error).content[0].text), trusted.toJSON());
    }
});

test('C31F10 CDP budget settlement preserves its original Error before the wall-clock deadline', async () => {
    const realNow = Date.now;
    const realSetTimeout = globalThis.setTimeout;
    let now = realNow();
    const scope = { deadline: now + 30 };
    const client = new CDPClient(() => scope);
    client.ws = { readyState: 1, send() {} };
    Date.now = () => now;
    globalThis.setTimeout = (callback, delay, ...args) =>
        realSetTimeout(() => {
            now = scope.deadline - 1;
            callback(...args);
        }, delay);
    try {
        let failure;
        try {
            await client.send('Runtime.evaluate', { expression: '1' });
        } catch (error) {
            failure = error;
        }
        assert.equal(getErrorSource(failure), 'budget');
        assert.equal(scope.budgetError, failure);
        assert.equal(now, scope.deadline - 1);
        assert.throws(
            () => getUnifiedSession().assertRequestActive(scope),
            (error) => error === failure
        );
        assert.equal(client.callbacks.size, 0);
        client.handleMessage(Buffer.from(JSON.stringify({ id: 1, result: { value: 1 } })));
        assert.equal(scope.budgetError, failure);
        assert.doesNotThrow(() => getUnifiedSession().assertRequestActive({ deadline: now + 1000 }));
    } finally {
        client.ws = null;
        Date.now = realNow;
        globalThis.setTimeout = realSetTimeout;
    }
});

test('C31F10 CDP exception text preserves primitive values and existing descriptions', () => {
    for (const value of ['owned primitive', '', 0, false, null, undefined]) {
        assert.equal(formatCdpException({ text: 'Uncaught', exception: { value } }), String(value));
    }
    assert.equal(formatCdpException({ text: 'Uncaught', exception: { type: 'undefined' } }), 'undefined');
    assert.equal(formatCdpException({ text: 'Uncaught', exception: { unserializableValue: '1n' } }), '1n');
    assert.equal(
        formatCdpException({ text: 'Uncaught', exception: { description: 'owned stack', value: 'owned primitive' } }),
        'owned stack'
    );
    assert.equal(formatCdpException({ text: 'Uncaught', exception: { description: '' } }), '');
    assert.equal(formatCdpException({ text: 'Uncaught', exception: { value: {} } }), 'Uncaught');
    assert.equal(formatCdpException({ text: 'Uncaught' }), 'Uncaught');
});

test('C31F8 condition snapshot failures preserve main action facts and reused RPC errors', async (t) => {
    for (const mode of ['extension', 'cdp']) {
        for (const [name, register, action] of [
            ['evaluate', registerEvaluateTool, { script: 'owned-action' }],
            [
                'input',
                registerInputTool,
                {
                    events: [
                        { type: 'keydown', key: 'x' },
                        { type: 'keyup', key: 'x' },
                    ],
                },
            ],
        ]) {
            for (const condition of [{ expectedUrl: 'https://example.com/202' }, { expectedRevision: 'r202' }]) {
                await t.test(`${mode}/${name}/${Object.keys(condition)[0]}`, async () => {
                    await withPageFixture(mode, async ({ unified, driver, state }) => {
                        const conditionDriver = mode === 'extension' ? driver : getSession();
                        const originalSnapshot = conditionDriver.getPageSnapshot.bind(conditionDriver);
                        const failure = new StructuredToolError(
                            'EXECUTION_RESULT_UNKNOWN',
                            'Request timeout for action: page_snapshot',
                            'Read current state',
                            {
                                actionExecuted: 'unknown',
                                actionStatus: 'unknown',
                                failureStage: 'rpc',
                                retryable: false,
                            }
                        );
                        let scenario = 'precondition';
                        let snapshots = 0;
                        let actions = 0;
                        const mainAction = async () => {
                            ++actions;
                            if (scenario === 'action-unknown') {
                                throw failure;
                            }
                            return 'owned-result';
                        };
                        const restoreDriver = patchProperties(conditionDriver, {
                            async getPageSnapshot(targetId) {
                                ++snapshots;
                                if (
                                    (scenario === 'precondition' && snapshots === 2) ||
                                    (scenario === 'after' && snapshots === 3)
                                ) {
                                    throw failure;
                                }
                                return originalSnapshot(targetId);
                            },
                        });
                        const restore = patchProperties(unified, {
                            evaluate: mainAction,
                            keyDown: mainAction,
                            keyUp: mainAction,
                        });
                        try {
                            const tool = registeredTool(register);
                            for (scenario of ['precondition', 'success', 'action-unknown', 'after']) {
                                snapshots = 0;
                                actions = 0;
                                const response = await tool({ targetId: '202', ...condition, ...action });
                                const body = JSON.parse(response.content[0].text);
                                assert.equal(body.pageContext.before.revision, 'r202');
                                assert.equal(body.pageContext.targetId, '202');
                                if (scenario === 'precondition' || scenario === 'action-unknown') {
                                    assert.equal(response.isError, true);
                                    assert.deepEqual(body.error, failure.toJSON().error);
                                    assert.equal(body.actionExecuted, scenario === 'precondition' ? false : 'unknown');
                                    assert.equal(
                                        body.actionStatus,
                                        scenario === 'precondition' ? 'not_started' : 'unknown'
                                    );
                                    assert.equal(
                                        body.failureStage,
                                        scenario === 'precondition' ? 'precondition' : 'rpc'
                                    );
                                    assert.equal(body.retryable, false);
                                    assert.equal(body.pageContext.after.revision, 'r202');
                                    if (scenario === 'precondition') {
                                        assert.equal(body.pageContext.contextPhase, 'precondition');
                                        assert.equal(actions, 0);
                                    } else {
                                        assert.equal(actions, 1);
                                    }
                                    if (name === 'input') {
                                        assert.equal(body.eventsExecuted, 0);
                                        assert.equal(
                                            body.remainingEventsNotExecuted,
                                            scenario === 'precondition' ? 2 : undefined
                                        );
                                    }
                                } else {
                                    assert.equal(response.isError, undefined);
                                    assert.equal(body.success, true);
                                    assert.equal(body.actionExecuted, true);
                                    assert.equal(body.actionStatus, 'completed');
                                    assert.equal(actions, name === 'evaluate' ? 1 : 2);
                                    if (scenario === 'after') {
                                        assert.equal(body.pageContext.after, null);
                                        assert.equal(body.pageContext.contextError, failure.message);
                                    } else {
                                        assert.equal(body.pageContext.after.revision, 'r202');
                                    }
                                }
                                assert.equal(state.current, '101');
                                assert.deepEqual(state.dispatched, []);
                                assert.equal(failure.context.actionExecuted, 'unknown');
                                assert.equal(failure.context.failureStage, 'rpc');
                            }
                        } finally {
                            restore();
                            restoreDriver();
                        }
                    });
                });
            }
        }
    }
});

test('C31F8 condition stages preserve Error identity and update when the same fn error is reused', async () => {
    await withPageFixture('extension', async ({ unified, driver }) => {
        for (const failure of [
            new StructuredToolError('EXECUTION_RESULT_UNKNOWN', 'snapshot timeout', 'Read current state', {
                actionExecuted: 'unknown',
                actionStatus: 'unknown',
                failureStage: 'rpc',
                retryable: false,
            }),
            new TypeError('snapshot unavailable'),
            new TimeoutError('snapshot timeout'),
            new EvaluateResultTooLargeError({
                exceeded: 'chars',
                depth: 1,
                nodes: 4,
                chars: 2_000_000,
                maxDepth: 8,
                maxNodes: 2000,
                maxChars: 1_000_000,
            }),
        ]) {
            const originalSnapshot = driver.getPageSnapshot.bind(driver);
            const originalBody = JSON.parse(formatErrorResponse(failure).content[0].text).error;
            const originalContext = failure.context;
            let snapshots = 0;
            let failAt = 2;
            let actions = 0;
            const restore = patchProperties(driver, {
                async getPageSnapshot(targetId) {
                    if (++snapshots === failAt) {
                        throw failure;
                    }
                    return originalSnapshot(targetId);
                },
            });
            try {
                await assert.rejects(
                    () =>
                        withPageContext(unified, '202', () =>
                            unified.withPageCondition({ expectedRevision: 'r202' }, async () => ++actions)
                        ),
                    (error) => {
                        assert.equal(error, failure);
                        assert.equal(error.constructor, failure.constructor);
                        assert.equal(error.context, originalContext);
                        assert.deepEqual(JSON.parse(formatErrorResponse(error).content[0].text).error, originalBody);
                        assert.equal(getErrorPageContext(error).contextPhase, 'precondition');
                        assert.deepEqual(classifyEvaluateFailure(error), {
                            actionExecuted: false,
                            actionStatus: 'not_started',
                            failureStage: 'precondition',
                            retryable: false,
                        });
                        return true;
                    }
                );
                assert.equal(actions, 0);
                failAt = 0;
                for (const condition of [{ expectedRevision: 'r202' }, {}]) {
                    await assert.rejects(
                        () =>
                            withPageContext(unified, '202', () =>
                                unified.withPageCondition(condition, async () => {
                                    ++actions;
                                    throw failure;
                                })
                            ),
                        (error) => {
                            assert.equal(error, failure);
                            assert.equal(getErrorPageContext(error).contextPhase, 'action');
                            assert.notEqual(classifyEvaluateFailure(error).failureStage, 'precondition');
                            assert.deepEqual(
                                JSON.parse(formatErrorResponse(error).content[0].text).error,
                                originalBody
                            );
                            return true;
                        }
                    );
                }
                assert.equal(actions, 2);
                snapshots = 0;
                failAt = 1;
                await assert.rejects(
                    () => withPageContext(unified, '202', async () => ++actions),
                    (error) => {
                        assert.equal(error, failure);
                        assert.equal(getErrorPageContext(error).contextPhase, 'before');
                        assert.deepEqual(classifyEvaluateFailure(error), {
                            actionExecuted: false,
                            actionStatus: 'not_started',
                            failureStage: 'context',
                            retryable: false,
                        });
                        return true;
                    }
                );
                assert.equal(actions, 2);
            } finally {
                restore();
            }
        }
    });
});

test('C31F8 late condition snapshot ACKs never dispatch the main action or retain queue work', async () => {
    for (const [register, action, condition] of [
        [registerEvaluateTool, { script: 'owned-action' }, { expectedUrl: 'https://example.com/101' }],
        [
            registerInputTool,
            {
                events: [
                    { type: 'keydown', key: 'x' },
                    { type: 'keyup', key: 'x' },
                ],
            },
            { expectedRevision: 'r101' },
        ],
    ]) {
        await withPageFixture('extension', async ({ unified }) => {
            const bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() });
            bridge.setCurrentTargetId('101');
            const server = bridge.httpServer;
            server.clientSocket = { readyState: 1 };
            const tab = { id: 101, url: 'https://example.com/101', title: 'Owned page' };
            const snapshot = { targetId: '101', url: tab.url, revision: 'r101' };
            const calls = [];
            let snapshots = 0;
            let held;
            let actions = 0;
            const mainAction = async () => ++actions;
            const restoreServer = patchProperties(server, {
                isConnected: () => true,
                sendMessage(_socket, message) {
                    calls.push(message);
                    if (message.type === 'cancel') {
                        return;
                    }
                    assert.ok(['page_snapshot', 'tabs_list'].includes(message.action), message.action);
                    if (message.action === 'page_snapshot' && ++snapshots === 2) {
                        held = message;
                        return;
                    }
                    server.handleMessage(
                        JSON.stringify({
                            id: message.id,
                            success: true,
                            data: message.action === 'tabs_list' ? [tab] : snapshot,
                        })
                    );
                },
            });
            const restore = patchProperties(unified, {
                extensionBridge: bridge,
                getDriver: async () => bridge,
                evaluate: mainAction,
                keyDown: mainAction,
                keyUp: mainAction,
                prepareKeyboardFocus: async () => undefined,
            });
            try {
                const tool = registeredTool(register);
                const response = await tool({ targetId: '101', timeout: 200, ...condition, ...action });
                const body = JSON.parse(response.content[0].text);
                assert.equal(response.isError, true);
                assert.equal(body.actionExecuted, false);
                assert.equal(body.actionStatus, 'not_started');
                assert.equal(body.failureStage, 'precondition');
                assert.equal(body.pageContext.contextPhase, 'precondition');
                assert.deepEqual(body.pageContext.before, snapshot);
                assert.equal(body.error.code, 'EXECUTION_RESULT_UNKNOWN');
                assert.equal(body.error.context.actionExecuted, 'unknown');
                assert.equal(body.error.context.actionStatus, 'unknown');
                assert.equal(body.error.context.failureStage, 'rpc');
                assert.deepEqual(
                    calls.filter((message) => message.action).map((message) => message.action),
                    ['page_snapshot', 'tabs_list', 'page_snapshot']
                );
                assert.ok(held);
                assert.ok(calls.some((message) => message.type === 'cancel' && message.id === held.id));
                assert.equal(server.messageHandlers.size, 0);
                server.handleMessage(JSON.stringify({ id: held.id, success: true, data: snapshot }));
                await new Promise((resolve) => setImmediate(resolve));
                assert.equal(actions, 0);
                assert.equal(server.messageHandlers.size, 0);
                assert.deepEqual([...unified.pressedKeys], []);
                if (register === registerInputTool) {
                    assert.equal(body.eventsExecuted, 0);
                    assert.equal(body.remainingEventsNotExecuted, 2);
                }
                const next = JSON.parse((await tool({ targetId: '101', ...condition, ...action })).content[0].text);
                assert.equal(next.success, true);
                assert.equal(next.actionStatus, 'completed');
                assert.equal(actions, register === registerEvaluateTool ? 1 : 2);
                assert.equal(server.messageHandlers.size, 0);
            } finally {
                restore();
                restoreServer();
            }
        });
    }
});

test('C9 real bridge preserves externally closed default across public input and topology reads', async () => {
    await withPageFixture('extension', async ({ unified }) => {
        const bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() });
        let tabs = [
            { id: 901, url: 'https://example.com/default', title: 'Default', managed: true },
            { id: 902, url: 'https://example.com/control', title: 'Control', managed: true },
        ];
        const calls = [];
        let controlKeydowns = 0;
        bridge.httpServer.isConnected = () => true;
        bridge.httpServer.sendCommand = async (action, params) => {
            calls.push({ action, params });
            if (action === 'tabs_list') {
                return tabs;
            }
            if (action === 'tabs_topology') {
                return { windows: [{ id: 1, tabs }], groups: [], activeTargetId: '902' };
            }
            if (action === 'page_snapshot') {
                const tab = tabs.find((item) => item.id === params.tabId);
                if (!tab) {
                    throw new Error(`No tab with id: ${params.tabId}.`);
                }
                return { targetId: String(tab.id), url: tab.url, revision: 'r1' };
            }
            if (action === 'keyboard_focus') {
                return params.operation === 'acquire' ? { changed: false } : { restored: true, errors: [] };
            }
            assert.equal(action, 'input_key');
            assert.equal(params.tabId, 902);
            assert.equal(params.type, 'keyDown');
            ++controlKeydowns;
            return {};
        };
        const restore = patchProperties(unified, {
            extensionBridge: bridge,
            inputMode: 'precise',
            getDriver: async () => bridge,
            getLiveState: async () => bridge.getState(),
            listTopology: Object.getPrototypeOf(unified).listTopology.bind(unified),
        });
        try {
            await bridge.selectPage('901');
            tabs = tabs.filter((tab) => tab.id === 902);
            const input = registeredTool(registerInputTool);
            const responses = [];
            for (const targetId of ['901', undefined]) {
                responses.push(
                    await input({
                        ...(targetId ? { targetId } : {}),
                        events: [{ type: 'keydown', key: 'a' }],
                    })
                );
            }
            for (const [index, response] of responses.entries()) {
                const body = JSON.parse(response.content[0].text);
                assert.equal(response.isError, true);
                assert.equal(body.error.code, 'TARGET_NOT_FOUND');
                assert.equal(body.error.context.targetId, '901');
                assert.equal(body.error.context.nativeMessage, 'No tab with id: 901.');
                assert.equal(body.eventsExecuted, 0);
                assert.equal(body.actionExecuted, false);
                assert.equal(body.retryable, false);
                assert.equal(body.pageContext.targetSource, index === 0 ? 'explicit' : 'default');
                assert.equal(body.pageContext.before, null);
                assert.equal(body.pageContext.after, null);
                assert.equal(body.pageContext.defaultTargetIdBefore, '901');
                assert.equal(body.pageContext.defaultTargetIdAfter, '901');
            }
            assert.equal(bridge.getCurrentTargetId(), '901');
            assert.equal(controlKeydowns, 0);
            assert.deepEqual(
                calls.filter(({ action }) => action === 'page_snapshot').map(({ params }) => params.tabId),
                [901, 901]
            );
            const browse = registeredTool(registerBrowseTool);
            const listed = JSON.parse((await browse({ action: 'list' })).content[0].text);
            assert.equal(listed.defaultTargetId, null);
            assert.equal(bridge.getCurrentTargetId(), null);
            assert.deepEqual(
                listed.targets.map(({ targetId }) => targetId),
                ['902']
            );
            const selected = await browse({ action: 'attach', targetId: '902' });
            assert.equal(selected.isError, undefined, selected.content[0].text);
            const entered = await input({ events: [{ type: 'keydown', key: 'a' }] });
            assert.equal(entered.isError, undefined, entered.content[0].text);
            assert.equal(controlKeydowns, 1);
            assert.equal(bridge.getCurrentTargetId(), '902');
        } finally {
            restore();
        }
    });
});

test('C9 response metadata target lists and topology preserve missing defaults', async (t) => {
    for (const actionFails of [false, true]) {
        await t.test(actionFails ? 'primary-error' : 'success', async () => {
            await withPageFixture('extension', async ({ unified }) => {
                const bridge = new ExtensionBridge();
                bridge.setCurrentTargetId('901');
                const calls = [];
                const tab = { id: 902, url: 'https://example.com/control', title: 'Control', managed: true };
                bridge.httpServer.sendCommand = async (action, params) => {
                    calls.push(action);
                    if (action === 'tabs_list') {
                        return [tab];
                    }
                    if (action === 'tabs_topology') {
                        return { windows: [{ id: 1, tabs: [tab] }], groups: [], activeTargetId: '902' };
                    }
                    assert.equal(action, 'page_snapshot');
                    assert.equal(params.tabId, 902);
                    return { targetId: '902', url: tab.url, revision: 'r1' };
                };
                const restore = patchProperties(unified, {
                    extensionBridge: bridge,
                    getDriver: async () => bridge,
                    listTopology: Object.getPrototypeOf(unified).listTopology.bind(unified),
                });
                try {
                    const primary = new Error('No tab with id: 902.');
                    const run = () =>
                        withPageResponse(unified, '902', async () => {
                            if (actionFails) {
                                throw primary;
                            }
                            return successfulAction();
                        });
                    if (actionFails) {
                        await assert.rejects(run, (error) => error === primary);
                        assert.equal(
                            JSON.parse(formatErrorResponse(primary).content[0].text).error.code,
                            'UNKNOWN_ERROR'
                        );
                    } else {
                        const body = JSON.parse((await run()).content[0].text);
                        assert.equal(body.success, true);
                        assert.equal(body.pageContext.defaultTargetIdBefore, '901');
                        assert.equal(body.pageContext.defaultTargetIdAfter, '901');
                    }
                    assert.deepEqual(calls, ['page_snapshot', 'tabs_list', 'page_snapshot', 'tabs_topology']);
                    assert.equal(bridge.getCurrentTargetId(), '901');
                    await bridge.listWindows();
                    assert.equal(bridge.getCurrentTargetId(), null);
                } finally {
                    restore();
                }
            });
        });
    }
});

test('C9 explicit close and release clear only the successfully removed default', async (t) => {
    for (const method of ['closeTab', 'releasePage', 'closeWindow']) {
        for (const matching of [false, true]) {
            for (const rejected of [false, true]) {
                await t.test(
                    `${method}/${matching ? 'default' : 'other'}/${rejected ? 'rejected' : 'success'}`,
                    async () => {
                        const bridge = new ExtensionBridge();
                        const cached = { url: 'https://example.com/default', title: 'Default' };
                        const tab = { id: matching ? 901 : 902, url: 'https://example.com/removed', title: 'Removed' };
                        bridge.currentTabId = 901;
                        bridge.state = cached;
                        const failure = new Error('owned removal rejected');
                        bridge.httpServer.sendCommand = async (action, params) => {
                            assert.equal(
                                action,
                                { closeTab: 'tabs_close', releasePage: 'tabs_release', closeWindow: 'window_close' }[
                                    method
                                ]
                            );
                            assert.deepEqual(params, method === 'closeWindow' ? { windowId: 9 } : { tabId: tab.id });
                            if (rejected) {
                                throw failure;
                            }
                            return method === 'releasePage'
                                ? { tab: { ...tab, managed: false }, managedBefore: true, managedAfter: false }
                                : {
                                      targetId: String(tab.id),
                                      windowId: 9,
                                      before: method === 'closeWindow' ? { id: 9, tabs: [tab] } : tab,
                                      after: null,
                                  };
                        };
                        const remove = () =>
                            bridge[method](
                                method === 'closeWindow' ? 9 : method === 'releasePage' ? String(tab.id) : tab.id
                            );
                        if (rejected) {
                            await assert.rejects(remove, (error) => error === failure);
                        } else {
                            await remove();
                        }
                        const cleared = matching && !rejected;
                        assert.equal(bridge.getCurrentTargetId(), cleared ? null : '901');
                        assert.equal(bridge.getState(), cleared ? null : cached);
                    }
                );
            }
        }
    }
});

test('C9 snapshot fallback observes tabs without reconciling the default selection', async () => {
    const bridge = new ExtensionBridge();
    bridge.setCurrentTargetId('901');
    bridge.httpServer.sendCommand = async (action) => {
        if (action === 'page_snapshot') {
            throw new Error('Unknown action: page_snapshot');
        }
        assert.equal(action, 'tabs_list');
        return [{ id: 902, url: 'https://example.com/control', title: 'Control' }];
    };
    await assert.rejects(() => bridge.getPageSnapshot('901'), TargetNotFoundError);
    assert.equal(bridge.getCurrentTargetId(), '901');
    const control = await bridge.getPageSnapshot('902');
    assert.equal(control.targetId, '902');
    assert.equal(control.revision, null);
    assert.equal(bridge.getCurrentTargetId(), '901');
    await bridge.listTabs();
    assert.equal(bridge.getCurrentTargetId(), null);
});

test('C9 native page snapshots classify only the requested missing tab', async () => {
    const bridge = Object.create(ExtensionBridge.prototype);
    let failure;
    bridge.httpServer = {
        async sendCommand(action, params) {
            assert.equal(action, 'page_snapshot');
            assert.deepEqual(params, { tabId: 901 });
            throw failure;
        },
    };
    for (const message of ['No tab with id: 901', 'No tab with id: 901.']) {
        failure = new Error(message);
        await assert.rejects(
            () => bridge.getPageSnapshot('901'),
            (error) => {
                assert.ok(error instanceof TargetNotFoundError);
                const payload = JSON.parse(formatErrorResponse(error).content[0].text);
                assert.equal(payload.error.code, 'TARGET_NOT_FOUND');
                assert.equal(payload.error.context.targetId, '901');
                assert.equal(payload.error.context.nativeMessage, message);
                return true;
            }
        );
    }
    for (const message of ['No tab with id: 902.', 'Extension disconnected', 'snapshot read denied']) {
        failure = new Error(message);
        await assert.rejects(
            () => bridge.getPageSnapshot('901'),
            (error) => error === failure
        );
    }
});

test('C9 closed-page input preserves zero dispatch and script exception identity', async () => {
    const bridge = Object.create(ExtensionBridge.prototype);
    let dispatched = 0;
    bridge.httpServer = {
        async sendCommand(action, { tabId }) {
            assert.equal(action, 'page_snapshot');
            if (tabId === 901) {
                throw new Error('No tab with id: 901.');
            }
            assert.equal(tabId, 902);
            return { targetId: '902', url: 'https://example.com/control', revision: 'r1' };
        },
    };
    const unified = getUnifiedSession();
    const restore = patchProperties(unified, {
        activeMode: 'extension',
        extensionBridge: bridge,
        getMode: () => 'extension',
        getCurrentTargetId: () => '901',
        getDriver: async () => bridge,
        listTargets: async () => [{ targetId: '902' }],
        listTopology: async () => ({ activeTargetId: '902' }),
        inputKey: async () => {
            dispatched += 1;
        },
    });
    try {
        const input = registeredTool(registerInputTool);
        for (const targetId of ['901', undefined]) {
            const response = await input({
                ...(targetId ? { targetId } : {}),
                events: [{ type: 'keydown', key: 'a' }],
            });
            const payload = JSON.parse(response.content[0].text);
            assert.equal(response.isError, true);
            assert.equal(payload.error.code, 'TARGET_NOT_FOUND');
            assert.equal(payload.error.context.targetId, '901');
            assert.equal(payload.error.context.nativeMessage, 'No tab with id: 901.');
            assert.equal(payload.eventsExecuted, 0);
            assert.equal(payload.actionExecuted, false);
            assert.equal(payload.retryable, false);
            assert.equal(payload.pageContext.targetId, '901');
            assert.equal(payload.pageContext.targetSource, targetId ? 'explicit' : 'default');
            assert.equal(payload.pageContext.before, null);
            assert.equal(payload.pageContext.after, null);
        }
        assert.equal(dispatched, 0);
        const scriptError = new Error('No tab with id: 902.');
        await assert.rejects(
            () =>
                withPageResponse(unified, '902', async () => {
                    throw scriptError;
                }),
            (error) => {
                assert.equal(error, scriptError);
                assert.equal(JSON.parse(formatErrorResponse(error).content[0].text).error.code, 'UNKNOWN_ERROR');
                return true;
            }
        );
    } finally {
        restore();
    }
});

test('C2 action failures retain page context without changing their error or skipping input redaction', async () => {
    const session = {
        withTabLock: async (action) => action(),
        getTargetRestoration: () => undefined,
        getCurrentTargetId: () => '101',
        getPageSnapshot: async (targetId) => ({ targetId, url: 'https://example.com/password', revision: 'r1' }),
        listTargets: async () => [{ targetId: '101' }, { targetId: '202' }],
        getMode: () => 'cdp',
    };
    const conditionError = new PagePreconditionError({
        targetId: '202',
        expectedUrl: 'https://example.com/expected',
        actualUrl: 'https://example.com/password',
    });
    await assert.rejects(
        () =>
            withPageResponse(session, '202', async () => {
                throw conditionError;
            }),
        (error) => {
            assert.equal(error, conditionError);
            const payload = JSON.parse(formatErrorResponse(error).content[0].text);
            assert.equal(payload.error.code, 'ACTION_PRECONDITION_FAILED');
            assert.equal(payload.pageContext.targetId, '202');
            assert.equal(payload.pageContext.targetSource, 'explicit');
            assert.equal(payload.pageContext.before.url, 'https://example.com/password');
            assert.equal(payload.pageContext.after.revision, 'r1');
            return true;
        }
    );
    let started = false;
    await assert.rejects(
        () =>
            withPageResponse(
                {
                    ...session,
                    getPageSnapshot: async () => {
                        throw new Error('read denied');
                    },
                },
                '202',
                async () => {
                    started = true;
                    return { content: [{ type: 'text', text: '{"success":true}' }] };
                }
            ),
        (error) => {
            const payload = JSON.parse(formatErrorResponse(error).content[0].text);
            assert.equal(payload.pageContext.targetId, '202');
            assert.equal(payload.pageContext.before, null);
            assert.equal(payload.pageContext.after, null);
            return true;
        }
    );
    assert.equal(started, false);

    const unified = getUnifiedSession();
    const overrides = {
        getCurrentTargetId: () => '101',
        getPageSnapshot: session.getPageSnapshot,
        listTargets: session.listTargets,
        getMode: session.getMode,
        withTabId: async (_id, action) => action(),
        withPageCondition: async () => {
            throw conditionError;
        },
    };
    const original = new Map(Object.keys(overrides).map((key) => [key, Object.getOwnPropertyDescriptor(unified, key)]));
    Object.assign(unified, overrides);
    try {
        let handler;
        let schema;
        registerInputTool({
            registerTool(_name, options, callback) {
                handler = callback;
                schema = options.inputSchema;
            },
        });
        const response = await handler(
            schema.parse({
                targetId: '202',
                expectedUrl: 'https://example.com/expected',
                events: [{ type: 'type', text: 'password' }],
            })
        );
        const payload = JSON.parse(response.content[0].text);
        assert.equal(response.isError, true);
        assert.equal(payload.actionExecuted, false);
        assert.equal(payload.actionStatus, 'not_started');
        assert.equal(payload.retryable, false);
        assert.equal(payload.pageContext.targetId, '202');
        assert.equal(response.content[0].text.includes('password'), false);
    } finally {
        for (const [key, descriptor] of original) {
            if (descriptor) {
                Object.defineProperty(unified, key, descriptor);
            } else {
                delete unified[key];
            }
        }
    }
});

test('C3 CDP preconditions reject before history navigation or raw CDP commands', async () => {
    const session = getSession();
    const previous = {
        cdp: session.cdp,
        sessionId: session.sessionId,
        currentTargetId: session.currentTargetId,
        pendingPageCondition: session.pendingPageCondition,
    };
    const sent = [];
    session.cdp = {
        isConnected: true,
        async send(method) {
            if (method === 'Target.getTargetInfo') {
                return { targetInfo: { type: 'page', targetId: 't1', url: 'https://example.com/a' } };
            }
            sent.push(method);
            return {};
        },
    };
    session.sessionId = 'session1';
    session.currentTargetId = 't1';
    try {
        const before = await session.getPageSnapshot('t1');
        session.setPageCondition({ targetId: 't1', expectedRevision: 'stale' });
        await assert.rejects(() => session.send('Page.navigateToHistoryEntry', { entryId: 1 }), PagePreconditionError);
        assert.deepEqual(sent, []);
        session.setPageCondition({
            targetId: 't1',
            expectedUrl: 'https://example.com/a',
            expectedRevision: before.revision,
        });
        await session.send('Page.navigateToHistoryEntry', { entryId: 1 });
        assert.deepEqual(sent, ['Page.navigateToHistoryEntry']);
        const after = await session.getPageSnapshot('t1');
        assert.notEqual(after.revision, before.revision);
        session.setPageCondition({ targetId: 't1', expectedRevision: 'stale' });
        await assert.rejects(() => session.debuggerSend('DOM.setAttributeValue', {}), PagePreconditionError);
        assert.deepEqual(sent, ['Page.navigateToHistoryEntry']);
    } finally {
        session.cdp = previous.cdp;
        session.sessionId = previous.sessionId;
        session.currentTargetId = previous.currentTargetId;
        session.pendingPageCondition = previous.pendingPageCondition;
    }
});

test('C13 public manage forwards native configuration through the unified driver', async () => {
    await withPageFixture('extension', async ({ unified, driver, state }) => {
        const calls = [];
        driver.newPage = async (url, timeout, options) => {
            calls.push({ action: 'newPage', url, timeout, options });
            state.targets.add('404');
            state.current = '404';
            return { targetId: '404', url, title: 'Created', ...options, managed: true };
        };
        for (const action of [
            'updatePage',
            'groupPages',
            'ungroupPages',
            'updateGroup',
            'moveGroup',
            'updateWindow',
            'resizeWindow',
        ]) {
            driver[action] = async (...args) => {
                calls.push({ action, args });
                return { before: [], after: [], tabsBefore: [], tabsAfter: [] };
            };
        }
        driver.newWindow = async (options) => {
            calls.push({ action: 'newWindow', options });
            const ids = options.targetId ? [options.targetId, ...(options.url ? ['608'] : [])] : ['606', '607'];
            for (const id of ids) {
                state.targets.add(id);
            }
            state.current = ids[0];
            return {
                targetId: ids[0],
                windowId: 9,
                after: {
                    id: 9,
                    tabs: ids.map((id) => ({ id, targetId: id, url: 'https://example.com/window', title: 'Window' })),
                },
            };
        };
        const manage = registeredTool(registerManageTool);
        const run = async (args) => {
            const response = await manage(args);
            assert.notEqual(response.isError, true, response.content[0].text);
            return JSON.parse(response.content[0].text);
        };
        const created = await run({
            action: 'newPage',
            url: 'https://example.com/new',
            windowId: 9,
            index: 2,
            groupId: -1,
            active: false,
            pinned: true,
            openerTabId: 101,
            timeout: 1500,
        });
        assert.equal(created.target.pinned, true);
        assert.deepEqual(calls.at(-1), {
            action: 'newPage',
            url: 'https://example.com/new',
            timeout: 1500,
            options: { windowId: 9, index: 2, groupId: -1, active: false, pinned: true, openerTabId: 101 },
        });
        await run({
            action: 'updatePage',
            targetId: '202',
            active: true,
            pinned: false,
            muted: true,
            highlighted: false,
            autoDiscardable: false,
            openerTabId: 303,
        });
        assert.equal(calls.at(-1).args[0], '202');
        assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).args[1])), {
            active: true,
            pinned: false,
            highlighted: false,
            muted: true,
            autoDiscardable: false,
            openerTabId: 303,
        });
        await run({
            action: 'groupPages',
            targetIds: ['202', '303'],
            windowId: 9,
            title: '',
            color: 'purple',
            collapsed: false,
        });
        assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).args)), [
            ['202', '303'],
            { windowId: 9, title: '', color: 'purple', collapsed: false },
        ]);
        await run({ action: 'groupPages', targetIds: ['202'], groupId: 7 });
        assert.equal(calls.at(-1).args[1].groupId, 7);
        await run({ action: 'updateGroup', groupId: 7, title: '', color: 'yellow', collapsed: false });
        assert.deepEqual(calls.at(-1).args, [7, { title: '', color: 'yellow', collapsed: false }]);
        await run({ action: 'moveGroup', groupId: 7, windowId: 9, index: -1 });
        assert.deepEqual(calls.at(-1).args, [7, { windowId: 9, index: -1 }]);
        await run({ action: 'ungroupPages', targetIds: ['202', '303'] });
        assert.deepEqual(calls.at(-1).args, [['202', '303']]);
        await run({
            action: 'updateWindow',
            windowId: 9,
            left: 10,
            top: 20,
            width: 900,
            height: 700,
            windowState: 'normal',
            focused: false,
            drawAttention: false,
        });
        assert.deepEqual(calls.at(-1).args, [
            9,
            { left: 10, top: 20, width: 900, height: 700, state: 'normal', focused: false, drawAttention: false },
        ]);
        await run({ action: 'resizeWindow', windowId: 9, width: 800, height: 600, drawAttention: true });
        assert.equal(calls.at(-1).args[1].drawAttention, true);
        await run({
            action: 'newWindow',
            urls: ['https://example.com/a', 'https://example.com/b'],
            windowType: 'normal',
            setSelfAsOpener: true,
            focused: false,
        });
        assert.deepEqual(calls.at(-1).options.url, ['https://example.com/a', 'https://example.com/b']);
        assert.equal(calls.at(-1).options.type, 'normal');
        assert.equal(calls.at(-1).options.setSelfAsOpener, true);
        assert.equal(unified.getPageMetadata('606').createdBy, 'mcp-chrome');
        assert.equal(unified.getPageMetadata('607').createdBy, 'mcp-chrome');
        const moved = await run({ action: 'newWindow', targetId: '202', focused: false });
        assert.equal(moved.createdTargetId, undefined);
        assert.equal(moved.pageContext.targetSource, 'explicit');
        assert.equal(unified.getPageMetadata('202').createdBy, 'unknown');
        await run({ action: 'newWindow', targetId: '202', urls: ['https://example.com/extra'], focused: false });
        assert.equal(unified.getPageMetadata('202').createdBy, 'unknown');
        assert.equal(unified.getPageMetadata('608').createdBy, 'mcp-chrome');
    });
});

test('C13 public browse full details retain native configuration without duplicating targets', async () => {
    await withPageFixture('extension', async ({ driver }) => {
        const tab = {
            id: 101,
            targetId: '101',
            url: 'https://example.com/101',
            title: 'Fixture',
            active: false,
            windowId: 9,
            index: 1,
            groupId: 7,
            highlighted: true,
            muted: false,
            autoDiscardable: false,
            openerTabId: 202,
            managed: true,
        };
        const group = {
            id: 7,
            title: '',
            color: 'purple',
            windowId: 9,
            collapsed: false,
            shared: false,
            tabIds: [101],
            targetIds: ['101'],
            index: 1,
        };
        driver.listTargets = async () => [tab];
        const restore = patchProperties(getUnifiedSession(), {
            listTopology: async () => ({
                windowCount: 1,
                focusedWindowId: 9,
                windows: [{ id: 9, tabs: [tab] }],
                groups: [group],
            }),
        });
        try {
            const response = await registeredTool(registerBrowseTool)({ action: 'list', details: 'full' });
            const listing = JSON.parse(response.content[0].text);
            assert.deepEqual(listing.groups, [{ ...group, totalTabCount: 1 }]);
            assert.equal(listing.windows[0].tabs, undefined);
            assert.deepEqual(listing.windows[0].targetIds, ['101']);
            for (const page of [listing.targets[0]]) {
                assert.equal(page.groupId, 7);
                assert.equal(page.openerTabId, 202);
                assert.equal(page.muted, false);
                assert.equal(page.highlighted, true);
                assert.equal(page.autoDiscardable, false);
                assert.equal(page.targetId, '101');
            }
        } finally {
            restore();
        }
    });
});

test('C13 public management schema rejects unsupported fields and conflicting configurations before dispatch', () => {
    const manage = registeredTool(registerManageTool);
    for (const args of [
        { action: 'newPage', index: -1 },
        { action: 'newPage', pinned: true, groupId: 7 },
        { action: 'newWindow', url: 'https://example.com/', urls: ['https://example.com/'] },
        { action: 'newWindow', windowState: 'maximized', width: 800 },
        { action: 'updateWindow', windowId: 9, focused: true, windowState: 'minimized' },
        { action: 'updateWindow', windowId: 9, focused: false, windowState: 'fullscreen' },
        { action: 'resizeWindow', windowId: 9, width: 1.5 },
        { action: 'groupPages', targetIds: ['202'], groupId: 7, title: 'Ignored' },
        { action: 'groupPages', targetIds: ['202'], groupId: 7, windowId: 9 },
        { action: 'updateGroup', groupId: -1, color: 'red' },
        { action: 'groupPages', targetIds: [] },
        { action: 'groupPages', targetIds: ['202'], color: 'invalid' },
        { action: 'closePage', targetId: '202', pinned: true },
        { action: 'updatePage', targetId: '202', frozen: true },
        { action: 'updatePage', targetId: '202', active: false, muted: true },
        { action: 'newWindow', windowType: 'popup', urls: ['https://example.com/a', 'https://example.com/b'] },
        { action: 'newWindow', windowType: 'popup', targetId: '202', url: 'https://example.com/extra' },
    ]) {
        assert.throws(() => manage(args), { name: 'ZodError' }, JSON.stringify(args));
    }
});

test('C13 Extension bridge exposes matching RPC names and preserves native state and cleanup warnings', async () => {
    const bridge = new ExtensionBridge();
    const calls = [];
    const tab = {
        id: 701,
        url: 'https://example.com/',
        title: 'Fixture',
        windowId: 9,
        index: 2,
        groupId: 7,
        pinned: false,
        highlighted: true,
        muted: true,
        autoDiscardable: false,
        openerTabId: 702,
        managed: true,
    };
    bridge.httpServer.sendCommand = async (action, params) => {
        calls.push({ action, params: JSON.parse(JSON.stringify(params)) });
        if (action === 'tabs_create') {
            return { ...tab, ...params };
        }
        if (action === 'tabs_release') {
            return {
                tab: { ...tab, managed: false },
                managedBefore: true,
                managedAfter: false,
                warnings: ['cleanup warning'],
            };
        }
        if (action === 'tabs_list') {
            return [tab];
        }
        if (action === 'tabs_topology') {
            return {
                windowCount: 1,
                windows: [{ id: 9, tabs: [tab] }],
                groups: [
                    {
                        id: 7,
                        title: 'Group',
                        color: 'purple',
                        windowId: 9,
                        collapsed: false,
                        tabIds: [701],
                        targetIds: ['701'],
                    },
                ],
            };
        }
        if (action.startsWith('tabgroup_')) {
            return { groupId: 7, before: [], after: [], tabsBefore: [tab], tabsAfter: [tab] };
        }
        if (action.startsWith('window_')) {
            return { windowId: 9, targetId: '701', after: { id: 9, tabs: [tab] } };
        }
        return { targetId: '701', windowId: 9, before: tab, after: tab };
    };
    const created = await bridge.newPage('https://example.com/new', 1000, {
        windowId: 9,
        index: 2,
        pinned: true,
        active: false,
        openerTabId: 702,
        groupId: 7,
    });
    assert.equal(created.openerTabId, 702);
    assert.equal(calls.at(-1).params.pinned, true);
    await bridge.updatePage('701', { highlighted: false, muted: false, autoDiscardable: false });
    assert.deepEqual(calls.at(-1), {
        action: 'tabs_update',
        params: { tabId: 701, highlighted: false, muted: false, autoDiscardable: false },
    });
    await bridge.groupPages(['701', '702'], { title: '', color: 'purple', collapsed: false, windowId: 9 });
    assert.deepEqual(calls.at(-1), {
        action: 'tabgroup_create',
        params: { tabIds: [701, 702], title: '', color: 'purple', collapsed: false, windowId: 9 },
    });
    await bridge.groupPages(['701'], { groupId: 7 });
    assert.equal(calls.at(-1).action, 'tabgroup_add');
    const count = calls.length;
    await assert.rejects(() => bridge.groupPages(['701'], { groupId: 7, color: 'red' }), /仅接受/);
    assert.equal(calls.length, count);
    await bridge.updateGroup(7, { title: '', color: 'cyan', collapsed: false });
    assert.deepEqual(calls.at(-1), {
        action: 'tabgroup_update',
        params: { groupId: 7, title: '', color: 'cyan', collapsed: false },
    });
    await bridge.moveGroup(7, { windowId: 9, index: -1 });
    assert.equal(calls.at(-1).action, 'tabgroup_move');
    const removed = await bridge.ungroupPages(['701', '702']);
    assert.equal(calls.at(-1).action, 'tabgroup_remove');
    assert.equal(removed.tabsAfter[0].targetId, '701');
    await bridge.updateWindow(9, { focused: false, drawAttention: true, width: 900 });
    assert.deepEqual(calls.at(-1), {
        action: 'window_update',
        params: { windowId: 9, focused: false, drawAttention: true, width: 900 },
    });
    await bridge.newWindow({ targetId: '701', type: 'popup', setSelfAsOpener: true });
    assert.deepEqual(calls.at(-1), {
        action: 'window_create',
        params: { tabId: 701, type: 'popup', setSelfAsOpener: true },
    });
    const targets = await bridge.listTargets();
    assert.equal(targets[0].groupId, 7);
    assert.equal(targets[0].muted, true);
    assert.equal(targets[0].autoDiscardable, false);
    const topology = await bridge.listWindows();
    assert.equal(topology.groups[0].color, 'purple');
    assert.equal(topology.windows[0].tabs[0].targetId, '701');
    const released = await bridge.releasePage('701');
    assert.deepEqual(released.warnings, ['cleanup warning']);
    assert.equal(bridge.getCurrentTargetId(), null);
});

test('C15 creation rejection retains preflight facts across the Extension bridge', async () => {
    const bridge = new ExtensionBridge();
    bridge.currentTabId = 701;
    bridge.httpServer.sendCommand = async (action) => {
        throw Object.assign(new Error('conflicting window'), {
            toJSON: () => ({
                error: {
                    code: 'INVALID_ARGUMENT',
                    message: 'conflicting window',
                    context: { action, actionExecuted: false, actionStatus: 'not_started', failureStage: 'preflight' },
                },
            }),
        });
    };
    for (const create of [() => bridge.createTab('https://example.com/new'), () => bridge.newWindow({})]) {
        await assert.rejects(create, (error) => {
            const body = JSON.parse(formatErrorResponse(error).content[0].text).error;
            assert.equal(body.code, 'INVALID_ARGUMENT');
            assert.equal(body.context.actionExecuted, false);
            assert.equal(body.context.actionStatus, 'not_started');
            assert.equal(body.context.failureStage, 'preflight');
            assert.equal(body.context.createdTargetId, null);
            return true;
        });
        assert.equal(bridge.currentTabId, 701);
    }
});

test('C13 CDP rejects unsupported Chrome UI configuration before creating a page', async () => {
    const session = getSession();
    await assert.rejects(() => session.newPage('https://example.com/', 1000, { pinned: false }), /未创建页面/);
    await withPageFixture('cdp', async ({ state }) => {
        const response = await registeredTool(registerManageTool)({
            action: 'newPage',
            url: 'https://example.com/',
            pinned: false,
        });
        assert.equal(response.isError, true);
        assert.equal(JSON.parse(response.content[0].text).error.code, 'DRIVER_CAPABILITY_ERROR');
        assert.deepEqual([...state.targets], ['101', '202', '303']);
        for (const args of [
            { action: 'updatePage', targetId: '202', muted: true },
            { action: 'groupPages', targetIds: ['202'] },
            { action: 'updateWindow', windowId: 9, width: 800 },
        ]) {
            const rejected = await registeredTool(registerManageTool)(args);
            assert.equal(rejected.isError, true);
            assert.equal(JSON.parse(rejected.content[0].text).error.code, 'DRIVER_CAPABILITY_ERROR');
        }
    });
});

test('C8 public metadata returns current managed state and page-scoped notes inline and in files', async (t) => {
    for (const mode of ['extension', 'cdp']) {
        for (const frame of mode === 'extension' ? [undefined, 'iframe#owned'] : [undefined]) {
            for (const fileOutput of [false, true]) {
                await t.test(`${mode}/${frame ?? 'main'}/${fileOutput ? 'file' : 'inline'}`, async () => {
                    await withPageFixture(mode, async ({ unified, driver, state }) => {
                        const backend = mode === 'cdp' ? getSession() : driver;
                        const restoreBackend = patchProperties(backend, {
                            listTargets: async () =>
                                [...state.targets].map((targetId) => ({ targetId, managed: targetId === '101' })),
                            getMetadata: async () => ({ title: frame ? 'Frame document' : 'Main document', og: {} }),
                            getFrames: async () => ({ frames: [{ frameId: frame ? 7 : 0 }] }),
                        });
                        const restoreFrame = patchProperties(unified, {
                            withFrame: async (_frame, action) => action(),
                        });
                        let output;
                        try {
                            unified.recordPageUse('202', true);
                            await unified.setPageMetadata('202', { taskHint: 'owned-task', note: 'owned-note' });
                            const expectedMetadata = { ...unified.getPageMetadata('202') };
                            const response = await registeredTool(registerExtractTool)({
                                type: 'metadata',
                                targetId: '202',
                                frame,
                                ...(fileOutput ? { output: `tmp:c8-${randomUUID()}.json` } : {}),
                            });
                            assert.notEqual(response.isError, true);
                            const body = JSON.parse(response.content[0].text);
                            output = body.output;
                            const extracted = output ? JSON.parse(await readFile(output, 'utf8')) : body;
                            assert.equal(extracted.managed, false);
                            assert.equal(extracted.title, frame ? 'Frame document' : 'Main document');
                            assert.deepEqual(
                                { ...extracted.metadata, lastUsedAt: expectedMetadata.lastUsedAt },
                                expectedMetadata
                            );
                            assert.ok(
                                Date.parse(extracted.metadata.lastUsedAt) >= Date.parse(expectedMetadata.lastUsedAt)
                            );
                            assert.deepEqual(extracted.frames, [{ frameId: frame ? 7 : 0 }]);
                            assert.equal(body.pageContext.targetId, '202');
                            assert.equal(state.current, '101');
                            assert.deepEqual(state.dispatched, []);
                            // Windows 权限由 W4 的原生 DACL 断言验证
                            if (output && process.platform !== 'win32') {
                                assert.equal((await stat(output)).mode & 0o777, 0o600);
                            }

                            const unknown = await registeredTool(registerExtractTool)({
                                type: 'metadata',
                                targetId: '303',
                            });
                            const unknownBody = JSON.parse(unknown.content[0].text);
                            assert.equal(unknownBody.metadata.createdBy, 'unknown');
                            assert.equal(unknownBody.metadata.createdAt, null);
                            assert.equal(unknownBody.metadata.taskHint, undefined);
                            assert.equal(unknownBody.metadata.note, undefined);
                            assert.equal(unknownBody.managed, false);
                            const managed = await unified.getMetadata();
                            assert.equal(managed.managed, true);
                        } finally {
                            if (output) {
                                await rm(output);
                            }
                            restoreFrame();
                            restoreBackend();
                        }
                    });
                });
            }
        }
    }
});

test('C8 metadata preserves missing-target and target-state failures', async () => {
    await withPageFixture('extension', async ({ unified, driver, state }) => {
        const restore = patchProperties(driver, {
            getMetadata: async () => ({ title: 'Owned document' }),
            listTargets: async () => [],
        });
        try {
            await assert.rejects(unified.getMetadata(), /101/);
            driver.listTargets = async () => {
                throw new Error('target state unavailable');
            };
            await assert.rejects(unified.getMetadata(), /target state unavailable/);
            assert.deepEqual(state.dispatched, []);
        } finally {
            restore();
        }
    });
});

test('C5 page metadata is scoped to a target and removed after closing it', async () => {
    const session = getUnifiedSession();
    const previousBridge = session.extensionBridge;
    const previousMode = session.activeMode;

    session.extensionBridge = {
        isConnected: () => true,
        getCurrentTargetId: () => '501',
        async getPageSnapshot(targetId) {
            return { targetId, url: 'https://example.com', revision: 'e:0' };
        },
        async setPageMetadata(targetId, updates) {
            return { ...session.getPageMetadata(targetId), ...updates };
        },
        async newPage() {
            return { targetId: '501', url: 'https://example.com', title: 'Test', type: 'page' };
        },
        async newWindow() {
            return { targetId: '601', windowId: 10 };
        },
        async closePage() {},
    };
    session.activeMode = 'extension';
    try {
        await session.newPage('https://example.com');
        const before = session.getPageMetadata('501');
        assert.equal(before.createdBy, 'mcp-chrome');
        assert.ok(before.createdAt);
        assert.ok(before.lastUsedAt);
        await session.setPageMetadata('501', { taskHint: 'demo', note: 'review' });
        assert.equal(session.getPageMetadata('501').taskHint, 'demo');
        await session.newWindow({ focused: false });
        assert.equal(session.getPageMetadata('601').createdBy, 'mcp-chrome');
        await session.closePage('501');
        assert.deepEqual(session.getPageMetadata('501'), {
            origin: 'unknown',
            createdBy: 'unknown',
            createdAt: null,
            lastUsedAt: null,
        });
    } finally {
        session.extensionBridge = previousBridge;
        session.activeMode = previousMode;
    }
});

test('C2 launch reports a new page even when it reuses an existing CDP browser', async () => {
    const session = getUnifiedSession();
    const cdp = getSession();
    const originalLaunch = cdp.launch;
    const previousExplicit = session.cdpExplicitlySelected;
    const previousMode = session.activeMode;
    cdp.launch = async () => ({
        targetId: 'reused-browser-new-page',
        type: 'page',
        url: 'about:blank',
        title: '',
        reused: true,
        targetCreated: true,
    });
    session.cdpExplicitlySelected = true;
    try {
        const target = await session.launch({ port: 65500 });
        assert.equal(target.reused, true);
        assert.equal(target.targetCreated, true);
        assert.equal(session.getPageMetadata(target.targetId).createdBy, 'mcp-chrome');
    } finally {
        cdp.launch = originalLaunch;
        session.cdpExplicitlySelected = previousExplicit;
        session.activeMode = previousMode;
        session.pageMetadata.delete(session.metadataKey('reused-browser-new-page'));
    }
});

test('C6 Windows Chrome discovery covers registry, PATH, channels and portable locations', () => {
    const paths = windowsChromeCandidates(
        {
            PROGRAMFILES: 'C:\\Program Files',
            'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
            LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
            USERPROFILE: 'C:\\Users\\Test',
            Path: 'C:\\Tools;D:\\Browser',
            MCP_CHROME_PORTABLE_DIR: 'E:\\Portable',
        },
        ['C:\\Registry\\chrome.exe']
    );
    for (const expected of [
        'C:\\Registry\\chrome.exe',
        'C:\\Tools\\chrome.exe',
        'D:\\Browser\\chromium.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'E:\\Portable\\chrome-win64\\chrome.exe',
    ]) {
        assert.ok(paths.includes(expected), expected);
    }
});

test('CDP document metadata returns the selected document URL', async () => {
    const session = getSession();
    for (const [url, title] of [
        ['https://example.com/owned-page', 'Owned page'],
        ['https://example.com/owned-frame', 'Owned frame'],
    ]) {
        const restore = patchProperties(session, {
            state: { url: 'https://example.com/stale' },
            evaluate: async (script) =>
                runInNewContext(script, {
                    location: { href: url },
                    document: {
                        title,
                        characterSet: 'UTF-8',
                        querySelector: () => null,
                        querySelectorAll: () => [],
                    },
                }),
        });
        try {
            const metadata = await session.getMetadata();
            assert.equal(metadata.url, url);
            assert.equal(metadata.title, title);
            assert.equal(metadata.description, undefined);
        } finally {
            restore();
        }
    }
});

test('CDP frame metadata preserves declared fields in JSON', async () => {
    const session = getSession();
    const restore = patchProperties(session, {
        cdp: { isConnected: true },
        sessionId: 'metadata-session',
        state: { title: 'Owned root' },
        async send(method) {
            assert.equal(method, 'Page.getFrameTree');
            return {
                frameTree: {
                    frame: { id: 'root', url: 'https://example.com/' },
                    childFrames: [{ frame: { id: 'child', url: 'https://example.com/frame', name: '' } }],
                },
            };
        },
    });
    try {
        const { frames } = JSON.parse(JSON.stringify(await session.getFrames()));
        assert.equal(frames.length, 2);
        for (const frame of frames) {
            for (const field of ['index', 'frameId', 'parentFrameId', 'url', 'title', 'name', 'selector', 'rect']) {
                assert.ok(Object.hasOwn(frame, field), `${frame.frameId}.${field}`);
            }
            assert.equal(frame.selector, null);
            assert.equal(frame.rect, null);
        }
        assert.equal(frames[0].parentFrameId, null);
        assert.equal(frames[0].title, 'Owned root');
        assert.equal(frames[1].parentFrameId, 'root');
        assert.equal(frames[1].title, null);
        assert.equal(frames[1].name, '');
    } finally {
        restore();
    }
});

test('C7 screenshot and PNG comparison reject excessive dimensions and encoded input', () => {
    assert.throws(() => assertScreenshotBudget(16385, 1), /超出预算/);
    assert.throws(() => assertScreenshotBudget(5000, 5000), /超出预算/);
    assert.throws(
        () => assertScreenshotBase64Budget('A'.repeat(Math.ceil(((MAX_COMPARE_PNG_BYTES + 1) * 4) / 3))),
        /超过/
    );
    assert.doesNotThrow(() => assertPngFileBudget(MAX_COMPARE_PNG_BYTES));
    assert.throws(
        () => assertPngFileBudget(MAX_COMPARE_PNG_BYTES + 1),
        /baseline PNG 超过 26214400 字节.*clip.*scale.*基准图/
    );
    assert.throws(
        () =>
            comparePngImages(
                makeRgbaPng(Buffer.from([0, 0, 0, 0, 255]), 16385, 1),
                makeRgbaPng(Buffer.from([0, 0, 0, 0, 255]))
            ),
        /超出预算/
    );
});

test('C7 screenshot resolves point targets and does not add iframe offset twice', async () => {
    const session = getUnifiedSession();
    const png = makeRgbaPng(Buffer.from([0, 0, 0, 0, 255])).toString('base64');
    let mode = 'extension';
    let captured;
    let point;
    const overrides = {
        getMode: () => mode,
        getCurrentTargetId: () => '902',
        getPageSnapshot: async (targetId) => ({ targetId, url: 'https://example.com/a', revision: 'r1' }),
        listTargets: async () => [{ targetId: '902' }],
        listTopology: async () => ({ activeTargetId: '902' }),
        withTabId: async (_id, action) => action(),
        withFrame: async (_frame, action) => action(),
        find: async () => [{ refId: 'element', tag: 'div', text: '', rect: { x: 120, y: 90, width: 10, height: 10 } }],
        findAtPoint: async (x, y) => {
            point = { x, y };
            return [{ refId: 'point', tag: 'div', text: '', rect: { x: 30, y: 40, width: 10, height: 10 } }];
        },
        getFrameOffset: () => ({ x: 100, y: 80 }),
        screenshot: async (options) => {
            captured = options.clip;
            return { data: png, format: 'png' };
        },
        evaluate: async (script) =>
            script.includes('elementFromPoint')
                ? { refId: '', tag: 'div', text: '', rect: { x: 30, y: 40, width: 10, height: 10 } }
                : { x: 0, y: 0 },
    };
    const original = new Map(Object.keys(overrides).map((key) => [key, Object.getOwnPropertyDescriptor(session, key)]));
    Object.assign(session, overrides);
    try {
        let handler;
        let schema;
        registerExtractTool({
            registerTool(_name, options, callback) {
                handler = callback;
                schema = options.inputSchema;
            },
        });
        const run = async (args) => {
            const response = await handler(schema.parse({ type: 'screenshot', targetId: '902', ...args }));
            assert.equal(JSON.parse(response.content[0].text).success, true);
        };
        await run({ frame: 'iframe#child', target: { css: '#item' } });
        assert.deepEqual(captured, { x: 120, y: 90, width: 10, height: 10 });
        await run({ target: { x: 30, y: 40 } });
        assert.deepEqual(point, { x: 30, y: 40 });
        assert.deepEqual(captured, { x: 30, y: 40, width: 10, height: 10 });
        mode = 'cdp';
        await run({ target: { x: 30, y: 40 } });
        assert.deepEqual(captured, { x: 30, y: 40, width: 10, height: 10 });
    } finally {
        for (const [key, descriptor] of original) {
            if (descriptor) {
                Object.defineProperty(session, key, descriptor);
            } else {
                delete session[key];
            }
        }
    }
});

test('W4 scoped output rejects Windows devices and manages only marked temporary sessions', async (t) => {
    const serverName = `mcp-chrome-output-test-${randomUUID()}`;
    const root = join(tmpdir(), 'claude-tools', serverName);
    await mkdir(root, { recursive: true });
    t.after(() => rm(root, { recursive: true, force: true }));
    const legacy = join(root, 'session-legacy');
    const stale = join(root, `session-${randomUUID()}`);
    await mkdir(legacy);
    await mkdir(stale);
    await writeFile(join(legacy, 'existing.txt'), 'leave me');
    await writeFile(
        join(stale, '.mcp-chrome-session'),
        JSON.stringify({ version: 1, session: basename(stale), pid: 99999999 })
    );
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(stale, old, old);

    const session = await getControlledTempRoot(serverName);
    assert.match(basename(session), /^session-/);
    assert.equal(await readFile(join(legacy, 'existing.txt'), 'utf8'), 'leave me');
    await assert.rejects(() => stat(stale), { code: 'ENOENT' });
    const output = await resolveScopedOutputPath('tmp:exports/report.txt', serverName);
    assert.equal(output.scope, 'tmp');
    assert.equal(output.root, session);
    await writePrivateFile(output.absolutePath, 'private content', 'utf8');
    assert.equal(await readFile(output.absolutePath, 'utf8'), 'private content');
    const contextSession = {
        withTabLock: async (action) => action(),
        getTargetRestoration: () => undefined,
        getCurrentTargetId: () => null,
        getMode: () => 'none',
    };
    const temporaryResponse = await withPageResponse(contextSession, undefined, async () => ({
        content: [{ type: 'text', text: JSON.stringify({ success: true, output: output.absolutePath }) }],
    }));
    assert.match(JSON.parse(temporaryResponse.content[0].text).retention, /24 小时.*进程退出/);
    const persistentResponse = await withPageResponse(contextSession, undefined, async () => ({
        content: [{ type: 'text', text: JSON.stringify({ success: true, output: join(process.cwd(), 'kept.txt') }) }],
    }));
    assert.equal(JSON.parse(persistentResponse.content[0].text).retention, undefined);
    assert.equal((await resolveScopedInputPath(output.absolutePath, serverName)).absolutePath, output.absolutePath);
    await assert.rejects(() => resolveScopedInputPath(join(legacy, 'existing.txt'), serverName), /允许范围/);
    for (const invalid of [
        'tmp:CON.txt',
        'tmp:folder/LPT¹.log',
        'tmp:folder/name:stream',
        'tmp:folder/end. ',
        'tmp:folder/trailing.',
        'cwd:foo<bar.txt',
        'cwd:folder\\AUX.txt',
        'tmp:folder/line\nfeed',
        '\\\\?\\C:\\test\\file.txt',
    ]) {
        await assert.rejects(() => resolveScopedOutputPath(invalid, serverName), /Windows/);
    }
    if (process.platform === 'win32') {
        const env = { ...process.env, MCP_CHROME_PRIVATE_PATH: output.absolutePath };
        const options = { env, timeout: 10_000 };
        const verify = `$ErrorActionPreference = 'Stop'
$a = Get-Acl -LiteralPath $env:MCP_CHROME_PRIVATE_PATH
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($owner, 'S-1-5-18', 'S-1-5-32-544')
if (-not $a.AreAccessRulesProtected -or
    $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner) {
    throw 'private ACL not applied'
}
foreach ($rule in $a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or
        $allowed -notcontains $rule.IdentityReference.Value) { throw 'unexpected access rule' }
}`;
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', verify], options);
        const inject = `$ErrorActionPreference = 'Stop'
$a = Get-Acl -LiteralPath $env:MCP_CHROME_PRIVATE_PATH
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'ReadData', 'Allow')
$a.AddAccessRule($rule)
Set-Acl -LiteralPath $env:MCP_CHROME_PRIVATE_PATH -AclObject $a
$a = Get-Acl -LiteralPath $env:MCP_CHROME_PRIVATE_PATH
if (@($a.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) |
    Where-Object { $_.IdentityReference.Value -eq $everyone.Value }).Count -ne 1) {
    throw 'Everyone rule not applied'
}`;
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', inject], options);
        await writePrivateFile(output.absolutePath, 'private content', 'utf8');
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', verify], options);
    } else {
        assert.equal((await stat(output.absolutePath)).mode & 0o077, 0);
    }
    await Promise.all(Array.from({ length: 256 }, (_, index) => writeFile(join(session, `fixture-${index}`), 'x')));
    await assert.rejects(() => writePrivateFile(output.absolutePath, 'x'), /受控临时会话超过/);
    const newParent = join(session, 'must-not-create', 'nested');
    await assert.rejects(() => writePrivateFile(join(newParent, 'result.txt'), 'x'), /受控临时会话超过/);
    await assert.rejects(() => stat(join(session, 'must-not-create')), { code: 'ENOENT' });
    assert.equal(await readFile(output.absolutePath, 'utf8'), 'private content');
});

test('C13 scoped path errors distinguish invalid arguments and allowed roots', async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), 'mcp-chrome-path-test-'));
    const serverName = `mcp-chrome-path-test-${randomUUID()}`;
    const tempRoot = join(tmpdir(), 'claude-tools', serverName);
    await mkdir(join(fixture, 'cwd'));
    await mkdir(join(fixture, 'outside'));
    await mkdir(tempRoot, { recursive: true });
    for (const root of [fixture, tempRoot]) {
        await writeFile(join(root, '.owner'), serverName, { flag: 'wx' });
    }
    t.after(async () => {
        for (const root of [fixture, tempRoot]) {
            assert.equal(await readFile(join(root, '.owner'), 'utf8'), serverName);
            await rm(root, { recursive: true, force: true });
        }
    });
    const utilsUrl = new URL('../dist/core/utils.js', import.meta.url).href;
    const errorsUrl = new URL('../dist/core/errors.js', import.meta.url).href;
    const script = `
import assert from 'node:assert/strict';
import { readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveScopedInputPath, resolveScopedOutputPath } from ${JSON.stringify(utilsUrl)};
import { formatErrorResponse } from ${JSON.stringify(errorsUrl)};
const serverName = ${JSON.stringify(serverName)};
const fixture = ${JSON.stringify(fixture)};
const cwd = await realpath(process.cwd());
const resolvers = [resolveScopedInputPath, resolveScopedOutputPath];
async function rejected(resolver, path, code) {
    await assert.rejects(() => resolver(path, serverName), error => {
        const response = formatErrorResponse(error);
        assert.equal(response.isError, true);
        const body = JSON.parse(response.content[0].text).error;
        assert.equal(body.code, code);
        assert.ok([process.cwd(), cwd].includes(body.context.cwd));
        if (code === 'INVALID_ARGUMENT') {
            assert.equal(body.context.path, path);
            if (path.includes('..')) assert.ok(!body.message.includes('Windows'));
        } else {
            assert.ok(body.context.allowedRoots.includes(cwd));
            assert.ok(body.suggestion.includes('cwd:') && body.suggestion.includes('tmp:'));
        }
        return true;
    });
}
const invalid = ['', 'cwd:', 'tmp:', 'cwd:../result.txt', 'tmp:folder/../result.txt',
    String.raw\`cwd:folder\\..\\result.txt\`, 'cwd:/absolute.txt',
    cwd + '/folder/../result.txt', 'tmp:CON.txt', 'cwd:folder/name:stream'];
for (const resolver of resolvers) {
    for (const path of invalid) await rejected(resolver, path, 'INVALID_ARGUMENT');
    const local = await resolver('cwd:./folder/result.txt', serverName);
    assert.equal(local.scope, 'cwd');
    assert.equal(local.root, cwd);
    assert.equal(local.absolutePath, join(cwd, 'folder', 'result.txt'));
    const temporary = await resolver('tmp:./folder/result.txt', serverName);
    assert.equal(temporary.scope, 'tmp');
    assert.ok(temporary.absolutePath.endsWith(join('folder', 'result.txt')));
    const outside = join(fixture, 'outside', 'kept.txt');
    await writeFile(outside, 'unchanged fixture');
    await rejected(resolver, outside, 'PATH_NOT_ALLOWED');
    assert.equal(await readFile(outside, 'utf8'), 'unchanged fixture');
}
if (process.platform !== 'win32') {
    await symlink(join(fixture, 'outside'), join(cwd, 'link'));
    for (const resolver of resolvers) await rejected(resolver, 'cwd:link/new.txt', 'PATH_NOT_ALLOWED');
}
console.log(JSON.stringify({
    resolvers: 2, invalidPerResolver: invalid.length, dotPaths: 4, outsideUnchanged: true,
    symlinkChecked: process.platform !== 'win32'
}));
`;
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: join(fixture, 'cwd'),
        timeout: 30_000,
    });
    const result = JSON.parse(stdout);
    assert.equal(result.resolvers, 2);
    assert.equal(result.invalidPerResolver, 10);
    assert.equal(result.dotPaths, 4);
    assert.equal(result.outsideUnchanged, true);
    assert.equal(result.symlinkChecked, process.platform !== 'win32');
});

test(
    'C6 temporary quota errors report exact usage or explicit lower bounds ' + 'without changing existing output',
    async (t) => {
        const maxBytes = 128 * 1024 * 1024;
        for (const scenario of ['entries', 'bytes', 'overwrite', 'existing-over-quota', 'single-file']) {
            await t.test(scenario, async (t) => {
                const root = await getControlledTempRoot(`mcp-chrome-quota-test-${randomUUID()}`);
                t.after(() => rm(dirname(root), { recursive: true, force: true }));
                const kept = join(root, 'kept.txt');
                await writePrivateFile(kept, 'keep');
                const markerSize = (await stat(join(root, '.mcp-chrome-session'))).size;
                if (scenario === 'entries' || scenario === 'existing-over-quota') {
                    const count = scenario === 'entries' ? 254 : 256;
                    await Promise.all(
                        Array.from({ length: count }, (_, i) => writeFile(join(root, `fixture-${i}`), 'x'))
                    );
                } else if (scenario !== 'single-file') {
                    const handle = await open(join(root, 'full.bin'), 'wx', 0o600);
                    try {
                        await handle.truncate(maxBytes - markerSize - 4);
                    } finally {
                        await handle.close();
                    }
                }
                const output = scenario === 'overwrite' ? kept : join(root, 'must-not-create', 'nested', 'new.txt');
                const data = scenario === 'single-file' ? Buffer.alloc(maxBytes + 1) : 'larger';
                await assert.rejects(
                    () => writePrivateFile(output, data),
                    (error) => {
                        const response = formatErrorResponse(error);
                        assert.equal(response.isError, true);
                        const { error: body } = JSON.parse(response.content[0].text);
                        assert.equal(body.code, 'TEMP_OUTPUT_QUOTA_EXCEEDED');
                        assert.match(body.suggestion, /cwd:.*已有输出保留.*勿自动重放/);
                        const context = body.context;
                        assert.deepEqual(context.limits, { entries: 256, bytes: maxBytes });
                        assert.equal(context.requested.bytes, Buffer.byteLength(data));
                        if (scenario === 'existing-over-quota' || scenario === 'single-file') {
                            assert.equal(context.usage.complete, false);
                            assert.equal(context.remaining, null);
                            assert.equal(context.projected, null);
                        } else {
                            assert.equal(context.usage.complete, true);
                            assert.equal(context.requested.replacedBytes, scenario === 'overwrite' ? 4 : 0);
                            if (scenario === 'entries') {
                                assert.equal(context.dimension, 'entries');
                                assert.equal(context.usage.entries, 256);
                                assert.equal(context.remaining.entries, 0);
                                assert.equal(context.projected.entries, 259);
                            } else {
                                assert.equal(context.dimension, 'bytes');
                                assert.equal(context.usage.bytes, maxBytes);
                                assert.equal(context.remaining.bytes, 0);
                                assert(context.projected.bytes > maxBytes);
                            }
                        }
                        return true;
                    }
                );
                await assert.rejects(() => stat(join(root, 'must-not-create')), { code: 'ENOENT' });
                assert.equal(await readFile(kept, 'utf8'), 'keep');
                if (scenario === 'overwrite') {
                    await writePrivateFile(kept, 'tiny');
                    assert.equal(await readFile(kept, 'utf8'), 'tiny');
                }
            });
        }
    }
);

test('C6 evaluate retains the completed script status on output quota rejection without replay', async (t) => {
    const root = await getControlledTempRoot('mcp-chrome');
    const full = join(root, `quota-fixture-${randomUUID()}`);
    const handle = await open(full, 'wx', 0o600);
    try {
        await handle.truncate(128 * 1024 * 1024);
    } finally {
        await handle.close();
    }
    t.after(() => rm(full, { force: true }));
    await withPageFixture('extension', async ({ unified }) => {
        let executions = 0;
        const restore = patchProperties(unified, {
            evaluate: async () => {
                executions++;
                return 'fixture result';
            },
            consumeLastEvaluationMetadata: () => undefined,
        });
        try {
            const run = registeredTool(registerEvaluateTool);
            const response = await run({
                script: "'fixture result'",
                expectedRevision: 'r202',
                targetId: '202',
                output: `tmp:quota-${randomUUID()}.txt`,
            });
            const payload = JSON.parse(response.content[0].text);
            assert.equal(response.isError, true);
            assert.equal(payload.error.code, 'TEMP_OUTPUT_QUOTA_EXCEEDED');
            assert.equal(payload.actionExecuted, true);
            assert.equal(payload.actionStatus, 'completed');
            assert.equal(payload.failureStage, 'output');
            assert.equal(payload.retryable, false);
            assert.equal(executions, 1);
        } finally {
            restore();
        }
    });
});

test('W4 cookies export reports temporary retention without reading browser cookies', async () => {
    const session = getUnifiedSession();
    const original = Object.getOwnPropertyDescriptor(session, 'getCookies');
    session.getCookies = async () => [{ name: 'fixture', value: 'test-value' }];
    let scoped;
    try {
        scoped = await resolveScopedOutputPath(`tmp:tests-${randomUUID()}/cookies.json`, 'mcp-chrome');
        let handler;
        let schema;
        registerCookiesTool({
            registerTool(_name, options, callback) {
                handler = callback;
                schema = options.inputSchema;
            },
        });
        const response = await handler(
            schema.parse({
                action: 'get',
                name: 'fixture',
                output: scoped.absolutePath,
            })
        );
        assert.equal(response.isError, undefined);
        const payload = JSON.parse(response.content[0].text);
        assert.equal(payload.output, scoped.absolutePath);
        assert.match(payload.retention, /24 小时.*进程退出/);
        assert.deepEqual(JSON.parse(await readFile(scoped.absolutePath, 'utf8')), [
            { name: 'fixture', value: 'test-value' },
        ]);
    } finally {
        if (original) {
            Object.defineProperty(session, 'getCookies', original);
        } else {
            delete session.getCookies;
        }
        if (scoped) {
            await rm(dirname(scoped.absolutePath), { recursive: true, force: true });
        }
    }
});

test('W4 cleanup reaches expired marked sessions after 128 retained directories', async (t) => {
    const serverName = `mcp-chrome-cleanup-test-${randomUUID()}`;
    const root = join(tmpdir(), 'claude-tools', serverName);
    await mkdir(root, { recursive: true });
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    for (let index = 0; index < 130; ++index) {
        await mkdir(join(root, `session-legacy-${index}`));
    }
    const stale = join(root, `session-${randomUUID()}`);
    await mkdir(stale);
    await writeFile(
        join(stale, '.mcp-chrome-session'),
        JSON.stringify({ version: 1, session: basename(stale), pid: 99999999 })
    );
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    await getControlledTempRoot(serverName);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        try {
            await stat(stale);
        } catch (error) {
            if (error.code === 'ENOENT') {
                assert.equal((await stat(join(root, 'session-legacy-0'))).isDirectory(), true);
                return;
            }
            throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail('expired marked session was not cleaned');
});

test('C02 postCondition script evaluates expressions, functions, async functions, and Promise values', async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const host = {
        async evaluate(script, _mode, _timeout, args = []) {
            const fn = globalThis.eval(`(${script})`);
            return fn(...args);
        },
    };
    for (const script of ['true', '() => true', 'async () => true', 'Promise.resolve(true)']) {
        const result = await waitForPostCondition(host, { script, timeout: 40, interval: 10 }, 'test');
        assert.equal(result.verificationStatus, 'matched', script);
    }
    for (const script of ['false', '() => false', 'async () => false', 'Promise.resolve(false)']) {
        const pending = waitForPostCondition(host, { script, timeout: 20, interval: 10 }, 'test');
        for (let elapsed = 0; elapsed < 20; elapsed += 10) {
            await new Promise((resolve) => setImmediate(resolve));
            context.mock.timers.tick(10);
        }
        const result = await pending;
        assert.equal(result.verificationStatus, 'not_matched', script);
    }
    const failed = await waitForPostCondition(host, { script: '() => { throw new Error("boom") }' }, 'test');
    assert.equal(failed.verificationStatus, 'error');
    assert.match(failed.error, /boom/);
});

test('C02 postCondition keeps a separate real deadline trace for an in-flight read', async (context) => {
    const startedAt = Date.now();
    const timeout = 70;
    const trace = [];
    let release;
    const held = new Promise((resolve) => {
        release = resolve;
    });
    const host = {
        async evaluate(script, _mode, remaining, args = []) {
            trace.push({ phase: 'read', elapsedMs: Date.now() - startedAt, remaining });
            await held;
            trace.push({ phase: 'read-completed', elapsedMs: Date.now() - startedAt });
            return globalThis.eval(`(${script})`)(...args);
        },
    };
    let result;
    try {
        result = await waitForPostCondition(host, { script: 'false', timeout, interval: 50 }, 'test');
        trace.push({ phase: 'result', elapsedMs: Date.now() - startedAt, status: result.verificationStatus });
        assert.equal(trace.filter((entry) => entry.phase === 'read').length, 1);
        assert.ok(trace[0].remaining > 0 && trace[0].remaining <= timeout);
        assert.equal(result.verificationStatus, 'unavailable');
        assert.equal(result.retryable, true);
    } finally {
        release();
        await new Promise((resolve) => setImmediate(resolve));
        context.diagnostic(JSON.stringify({ timeout, trace, result }));
    }
});

test('C03 CDP HTTP timeout covers delayed headers and delayed response bodies', async () => {
    await withHttpServer(
        (_request, response) => {
            setTimeout(() => {
                response.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/test' }));
            }, 100);
        },
        async (port) => {
            await assert.rejects(() => getBrowserWSEndpoint('127.0.0.1', port, 30), TimeoutError);
        }
    );

    await withHttpServer(
        (_request, response) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.flushHeaders();
            setTimeout(() => {
                response.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/test' }));
            }, 100);
        },
        async (port) => {
            await assert.rejects(() => getBrowserWSEndpoint('127.0.0.1', port, 30), TimeoutError);
        }
    );

    await withHttpServer(
        (_request, response) => response.end('{invalid json'),
        async (port) => {
            await assert.rejects(() => getBrowserWSEndpoint('127.0.0.1', port, 500), SyntaxError);
        }
    );
});

test('C04 CDP reload accepts lifecycle events only from its new main-frame loader', async () => {
    const session = getSession();
    const previous = {
        cdp: session.cdp,
        sessionId: session.sessionId,
        currentTargetId: session.currentTargetId,
        state: session.state,
        mainFrameId: session.mainFrameId,
        mainFrameLoaderId: session.mainFrameLoaderId,
    };
    const listeners = new Map();
    const onEvent = (event, listener) => {
        const eventListeners = listeners.get(event) ?? new Set();
        eventListeners.add(listener);
        listeners.set(event, eventListeners);
    };
    const emit = (event, params) => {
        for (const listener of listeners.get(event) ?? []) {
            listener(params, 'session-current');
        }
    };

    session.cdp = {
        isConnected: true,
        onEvent,
        offEvent(event, listener) {
            listeners.get(event)?.delete(listener);
        },
        once() {},
        removeListener() {},
        async send(method) {
            if (method === 'Page.reload') {
                assert.equal(listeners.get('Page.frameNavigated')?.size, 1);
                assert.equal(listeners.get('Page.lifecycleEvent')?.size, 1);
                emit('Page.lifecycleEvent', {
                    frameId: 'main-frame',
                    loaderId: 'previous-loader',
                    name: 'DOMContentLoaded',
                });
                emit('Page.frameNavigated', {
                    frame: { id: 'main-frame', loaderId: 'current-loader' },
                });
                emit('Page.lifecycleEvent', {
                    frameId: 'main-frame',
                    loaderId: 'previous-loader',
                    name: 'DOMContentLoaded',
                });
                emit('Page.lifecycleEvent', {
                    frameId: 'main-frame',
                    loaderId: 'current-loader',
                    name: 'DOMContentLoaded',
                });
            }
            return {};
        },
    };
    session.sessionId = 'session-current';
    session.currentTargetId = null;
    session.state = null;
    session.mainFrameId = 'main-frame';
    session.mainFrameLoaderId = 'previous-loader';
    try {
        await session.reload(false, 'domcontentloaded', 500);
        assert.equal(listeners.get('Page.frameNavigated')?.size, 0);
        assert.equal(listeners.get('Page.lifecycleEvent')?.size, 0);
    } finally {
        session.cdp = previous.cdp;
        session.sessionId = previous.sessionId;
        session.currentTargetId = previous.currentTargetId;
        session.state = previous.state;
        session.mainFrameId = previous.mainFrameId;
        session.mainFrameLoaderId = previous.mainFrameLoaderId;
    }
});

test('C04 CDP networkidle does not complete before the target loader reports networkIdle', async () => {
    const session = getSession();
    const previous = {
        cdp: session.cdp,
        sessionId: session.sessionId,
        currentTargetId: session.currentTargetId,
        state: session.state,
        mainFrameId: session.mainFrameId,
        mainFrameLoaderId: session.mainFrameLoaderId,
    };
    const listeners = new Map();
    let emitCurrentNetworkIdle = false;
    let sameDocument = false;

    session.cdp = {
        isConnected: true,
        onEvent(event, listener) {
            const eventListeners = listeners.get(event) ?? new Set();
            eventListeners.add(listener);
            listeners.set(event, eventListeners);
        },
        offEvent(event, listener) {
            listeners.get(event)?.delete(listener);
        },
        once() {},
        removeListener() {},
        async send(method) {
            if (method === 'Page.navigate') {
                if (sameDocument) {
                    for (const listener of listeners.get('Page.navigatedWithinDocument') ?? []) {
                        listener({ frameId: 'main-frame', url: 'https://example.com/ready#state' }, 'session-current');
                    }
                    for (const listener of listeners.get('Network.requestWillBeSent') ?? []) {
                        listener(
                            { requestId: 'same-document-worker', loaderId: '', type: 'Script' },
                            'session-current'
                        );
                        listener(
                            { requestId: 'same-document-request', loaderId: 'current-loader', type: 'Fetch' },
                            'session-current'
                        );
                    }
                    globalThis.setTimeout(() => {
                        for (const listener of listeners.get('Network.loadingFinished') ?? []) {
                            listener({ requestId: 'same-document-request' }, 'session-current');
                        }
                    }, 30);
                    return { frameId: 'main-frame' };
                }
                for (const listener of listeners.get('Page.lifecycleEvent') ?? []) {
                    listener(
                        { frameId: 'main-frame', loaderId: 'previous-loader', name: 'networkIdle' },
                        'session-current'
                    );
                }
                if (emitCurrentNetworkIdle) {
                    globalThis.setTimeout(() => {
                        for (const listener of listeners.get('Page.lifecycleEvent') ?? []) {
                            listener(
                                { frameId: 'main-frame', loaderId: 'current-loader', name: 'networkIdle' },
                                'session-current'
                            );
                        }
                    }, 0);
                }
                return { frameId: 'main-frame', loaderId: 'current-loader' };
            }
            return {};
        },
    };
    session.sessionId = 'session-current';
    session.currentTargetId = null;
    session.state = null;
    session.mainFrameId = 'main-frame';
    session.mainFrameLoaderId = 'previous-loader';
    try {
        await assert.rejects(() => session.navigate('https://example.com', { wait: 'networkidle', timeout: 30 }));
        emitCurrentNetworkIdle = true;
        await session.navigate('https://example.com/ready', { wait: 'networkidle', timeout: 500 });

        sameDocument = true;
        const startedAt = Date.now();
        await session.navigate('https://example.com/ready#state', { wait: 'networkidle', timeout: 1000 });
        assert.ok(Date.now() - startedAt >= 500);
    } finally {
        session.cdp = previous.cdp;
        session.sessionId = previous.sessionId;
        session.currentTargetId = previous.currentTargetId;
        session.state = previous.state;
        session.mainFrameId = previous.mainFrameId;
        session.mainFrameLoaderId = previous.mainFrameLoaderId;
    }
});

test('C13 and C14 PNG decoding rejects excess and missing scanline data', () => {
    const valid = makeRgbaPng(Buffer.from([0, 10, 20, 30, 255]));
    assert.equal(comparePngImages(valid, valid).pixelDiffRatio, 0);

    const excess = makeRgbaPng(Buffer.alloc(8 * 1024 * 1024));
    assert.throws(() => comparePngImages(excess, valid));

    const missing = makeRgbaPng(Buffer.alloc(0));
    assert.throws(() => comparePngImages(missing, valid), /scanline 数据长度无效/);

    const firstIhdr = Buffer.alloc(13);
    firstIhdr.writeUInt32BE(1, 0);
    firstIhdr.writeUInt32BE(1, 4);
    firstIhdr[8] = 8;
    firstIhdr[9] = 6;
    const oversizedIhdr = Buffer.from(firstIhdr);
    oversizedIhdr.writeUInt32BE(100_000, 0);
    oversizedIhdr.writeUInt32BE(100_000, 4);
    const duplicateIhdr = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', firstIhdr),
        pngChunk('IHDR', oversizedIhdr),
        pngChunk('IDAT', deflateSync(Buffer.from([0, 10, 20, 30, 255]))),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
    assert.throws(() => comparePngImages(duplicateIhdr, valid), /只能包含一个首块 IHDR/);

    const ihdrAfterIend = Buffer.concat([valid, pngChunk('IHDR', oversizedIhdr)]);
    assert.throws(() => comparePngImages(ihdrAfterIend, valid), /IEND 必须是最后一个 chunk/);
});

test(
    'C15 launcher waits for a complete browser endpoint line across stderr chunks',
    { skip: process.platform === 'win32' ? 'POSIX shell fixture' : false },
    async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mcp-chrome-launcher-'));
        const executable = join(directory, 'fake-chrome');
        await writeFile(
            executable,
            "#!/bin/bash\nprintf 'DevTools listening on ws://127.0.0.1:9333/devtools/bro' >&2\n" +
                "sleep 0.05\nprintf 'wser/test-id\\n' >&2\nsleep 5\n"
        );
        await chmod(executable, 0o700);
        const launcher = new BrowserLauncher();
        try {
            const endpoint = await launcher.launch({
                executablePath: executable,
                userDataDir: directory,
                timeout: 1000,
            });
            assert.equal(endpoint, 'ws://127.0.0.1:9333/devtools/browser/test-id');
            assert.equal(launcher.port, 9333);
        } finally {
            launcher.close();
            await rm(directory, { recursive: true, force: true });
        }
    }
);

test(
    'C6 launcher reports a child signal without waiting for the startup deadline',
    { skip: process.platform === 'win32' ? 'POSIX signal fixture' : false },
    async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mcp-chrome-signal-'));
        const executable = join(directory, 'fake-chrome');
        await writeFile(executable, '#!/bin/sh\nkill -TERM $$\n');
        await chmod(executable, 0o700);
        const launcher = new BrowserLauncher();
        const started = Date.now();
        try {
            await assert.rejects(
                () => launcher.launch({ executablePath: executable, userDataDir: directory, timeout: 5000 }),
                /收到信号 SIGTERM/
            );
            assert.ok(Date.now() - started < 2000);
        } finally {
            launcher.close();
            await rm(directory, { recursive: true, force: true });
        }
    }
);

test('T01 smoke helper uses the SDK transport for initialize and tools/list', async () => {
    const client = new McpClient();
    try {
        await client.start();
        const initialized = await client.initialize();
        assert.equal(initialized.serverInfo.name, 'mcp-chrome');
        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
            'browse',
            'cookies',
            'evaluate',
            'extract',
            'input',
            'logs',
            'manage',
            'wait',
        ]);
    } finally {
        await client.close();
    }
});

test(
    'T04 launcher scripts consume the port argument before forwarding Chrome arguments',
    { skip: process.platform === 'win32' ? 'POSIX shell fixture' : false },
    async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mcp-chrome-script-'));
        const fakeChrome = join(directory, 'google-chrome');
        const argsFile = join(directory, 'args.txt');
        await writeFile(fakeChrome, '#!/bin/bash\nprintf \'%s\\n\' "$@" > "$ARGS_FILE"\n');
        await chmod(fakeChrome, 0o700);
        const environment = {
            ...process.env,
            PATH: directory,
            OSTYPE: 'linux-gnu',
            HOME: directory,
            ARGS_FILE: argsFile,
        };
        try {
            for (const script of ['start-chrome.sh', 'start-chrome-headless.sh']) {
                await execFileAsync(
                    '/bin/bash',
                    [fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), '9333', '--flag'],
                    {
                        env: environment,
                    }
                );
                const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
                assert.ok(args.includes('--remote-debugging-port=9333'));
                assert.ok(args.includes('--flag'));
                assert.equal(args.includes('9333'), false);
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
);

test('CH-04 public input cancellation stops the remaining events and releases the confirmed modifier', async () => {
    await withPageFixture('extension', async ({ unified, state }) => {
        const controller = new globalThis.AbortController();
        const responsePromise = registeredTool(registerInputTool)(
            {
                targetId: '101',
                expectedRevision: 'r101',
                events: [
                    { type: 'keydown', key: 'Shift' },
                    { type: 'wait', ms: 100 },
                    { type: 'keydown', key: 'a' },
                ],
            },
            { signal: controller.signal }
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        controller.abort();
        const response = await responsePromise;
        const body = JSON.parse(response.content[0].text);
        assert.equal(response.isError, true);
        assert.equal(body.eventsExecuted, 1);
        assert.equal(body.retryable, false);
        assert.deepEqual(
            state.dispatched.map((event) => event.type),
            ['keyDown', 'keyUp']
        );
        assert.equal(unified.modifiers, 0);
        assert.equal(unified.pressedKeys.size, 0);
    });
});

test('CH-IMAGE-BUDGET public export requests one resource at a time and limits aggregate appendix bytes', async () => {
    await withPageFixture('extension', async ({ unified }) => {
        let fetched = 0;
        const image = Buffer.alloc(2 * 1024 * 1024, 1).toString('base64');
        const images = Array.from({ length: 25 }, (_, index) => ({
            index,
            src: `https://example.com/${index}.png`,
            dataSrc: '',
            alt: '',
            width: 1,
            height: 1,
        }));
        const restore = patchProperties(unified, {
            getHtmlWithImages: async () => ({ html: '<html lang="en"></html>', images }),
            getResourceContentBatch: async (urls) => {
                ++fetched;
                assert.equal(urls.length, 1);
                return new Map([[urls[0], { content: image, base64Encoded: true }]]);
            },
        });
        try {
            const response = await registeredTool(registerExtractTool)({ type: 'html', images: 'data' });
            assert.equal(response.isError, undefined);
            assert.equal(fetched, 4);
            assert.equal(response.content.filter((item) => item.type === 'image').length, 4);
            assert.equal(JSON.parse(response.content[0].text).omittedImages, 21);
            assert.ok(response.content.some((item) => item.text?.includes('request-byte-limit')));
            assert.ok(response.content.some((item) => item.text?.includes('appendix-limit')));
        } finally {
            restore();
        }
    });
});

test(
    'CH-07 and CH-19 public waits share visibility rules and query initially ' + 'missing negative states once',
    async () => {
        await withPageFixture('extension', async ({ unified }) => {
            const restore = patchProperties(unified, {
                find: async () => [{ refId: 'hidden', rect: { x: 0, y: 0, width: 100, height: 20 } }],
                getComputedStyleByRef: async (_ref, property) => (property === 'visibility' ? 'collapse' : 'block'),
            });
            try {
                const response = await registeredTool(registerWaitTool)({
                    for: 'element',
                    target: { css: '#hidden' },
                    state: 'hidden',
                    timeout: 300,
                });
                assert.equal(response.isError, undefined);
            } finally {
                restore();
            }
        });
        await withPageFixture('cdp', async () => {
            let queries = 0;
            const cdp = {
                async send(method) {
                    if (method === 'Runtime.evaluate') {
                        ++queries;
                        return { result: { objectId: 'empty-query' } };
                    }
                    if (method === 'Runtime.getProperties') {
                        return {
                            result: [
                                { name: 'count', value: { value: 0 } },
                                { name: 'node', value: { subtype: 'null' } },
                            ],
                        };
                    }
                    assert.equal(method, 'Runtime.releaseObject');
                    return {};
                },
            };
            const restore = patchProperties(getSession(), {
                createLocator: (target, options) => new Locator(cdp, target, 'owned-session', options),
            });
            try {
                for (const state of ['hidden', 'detached']) {
                    queries = 0;
                    const response = await registeredTool(registerWaitTool)({
                        for: 'element',
                        target: { css: '#missing' },
                        state,
                        timeout: 1000,
                    });
                    assert.equal(response.isError, undefined);
                    assert.equal(queries, 1);
                }
            } finally {
                restore();
            }
        });
    }
);

test('CH-10 bare return wraps before dispatch while a runtime same-name exception is never replayed', async () => {
    await withPageFixture('extension', async ({ unified, driver }) => {
        const expressions = [];
        driver.getCurrentFrameId = () => 0;
        driver.debuggerSend = async (method, params) => {
            if (method === 'Runtime.releaseObject') {
                return {};
            }
            expressions.push(params.expression);
            if (params.expression.includes('sideEffect')) {
                return { exceptionDetails: { text: 'SyntaxError: Illegal return statement' } };
            }
            return { result: { type: 'number', value: runInNewContext(params.expression) } };
        };
        assert.equal(await unified.evaluate('const value = 42; return value', 'precise', 100), 42);
        assert.equal(expressions.length, 1);
        await assert.rejects(
            unified.evaluate('sideEffect(); throw new SyntaxError("Illegal return statement")', 'precise', 100),
            /Illegal return/
        );
        assert.equal(expressions.length, 2);
    });
});

test('CH-15 public screenshot preserves fallback fields in inline and file metadata', async () => {
    await withPageFixture('extension', async ({ unified }) => {
        const restore = patchProperties(unified, {
            screenshot: async () => ({
                data: makeRgbaPng(Buffer.from([0, 0, 0, 255])).toString('base64'),
                format: 'png',
                degraded: true,
                fallback: 'captureVisibleTab',
                limitations: ['viewport-only'],
            }),
        });
        try {
            for (const output of [undefined, `tmp:fallback-${randomUUID()}.png`]) {
                const response = await registeredTool(registerExtractTool)({ type: 'screenshot', output });
                assert.equal(response.isError, undefined);
                const body = JSON.parse(response.content[0].text);
                assert.equal(body.metadata.degraded, true);
                assert.equal(body.metadata.fallback, 'captureVisibleTab');
                assert.deepEqual(body.metadata.limitations, ['viewport-only']);
            }
        } finally {
            restore();
        }
    });
});

test('CH-23 public precise touch keeps manual and element coordinates local and carries the document', async () => {
    await withPageFixture('extension', async ({ unified, driver }) => {
        const bridge = new ExtensionBridge();
        const messages = [];
        bridge.currentTabId = 101;
        bridge.httpServer = {
            sendCommand: async (action, params) => {
                assert.equal(action, 'input_touch');
                messages.push(params);
                return {};
            },
        };
        Object.assign(driver, {
            resolveFrame: async () => ({
                frameId: 7,
                offset: { x: 500, y: 300 },
                frameContext: { documentId: 'owned-seven' },
            }),
            getCurrentFrameId: bridge.getCurrentFrameId.bind(bridge),
            getCurrentFrameDocumentId: bridge.getCurrentFrameDocumentId.bind(bridge),
            setCurrentFrameId: bridge.setCurrentFrameId.bind(bridge),
            inputTouch: bridge.inputTouch.bind(bridge),
        });
        const restore = patchProperties(unified, {
            inputMode: 'precise',
            find: async () => [{ refId: 'owned', rect: { x: 510, y: 320, width: 10, height: 10 } }],
            evaluate: async () => ({ x: 10, y: 20, width: 10, height: 10 }),
        });
        try {
            const response = await registeredTool(registerInputTool)({
                frame: '#owned',
                expectedRevision: 'r101',
                events: [
                    { type: 'touchstart', target: { x: 20, y: 30 } },
                    { type: 'touchmove', target: { css: '#point' } },
                    { type: 'touchend' },
                ],
            });
            assert.equal(response.isError, undefined);
            assert.deepEqual(
                messages.map((message) => message.frameId),
                [7, 7, 7]
            );
            assert.deepEqual(
                messages.map((message) => message.documentId),
                ['owned-seven', 'owned-seven', 'owned-seven']
            );
            assert.deepEqual(messages[0].touchPoints, [{ x: 20, y: 30, id: 0 }]);
            assert.deepEqual(messages[1].touchPoints, [{ x: 15, y: 25, id: 0 }]);
            assert.equal(bridge.getCurrentFrameId(), 0);
        } finally {
            restore();
        }
    });
});

test('CH-IMAGE-BUDGET directory export writes before fetching the next image and reuses duplicate files', async () => {
    await withPageFixture('extension', async ({ unified }) => {
        const output = `tmp:images-${randomUUID()}`;
        const directory = (await resolveScopedOutputPath(output, 'mcp-chrome')).absolutePath;
        const images = [0, 1, 0].map((value, index) => ({
            index,
            src: `https://example.com/${value}.png`,
            dataSrc: '',
            alt: '',
            width: 1,
            height: 1,
        }));
        let fetched = 0;
        const restore = patchProperties(unified, {
            getHtmlWithImages: async () => ({ html: '<html lang="en"></html>', images }),
            getResourceContentBatch: async (urls) => {
                if (fetched > 0) {
                    assert.equal((await readdir(join(directory, 'images'))).length, fetched);
                }
                ++fetched;
                return new Map([[urls[0], { content: 'aGVsbG8=', base64Encoded: true }]]);
            },
        });
        try {
            const response = await registeredTool(registerExtractTool)({ type: 'html', images: 'data', output });
            assert.equal(response.isError, undefined);
            assert.equal(fetched, 2);
            const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'));
            assert.equal(index.images[0].file, index.images[2].file);
        } finally {
            restore();
            await rm(directory, { recursive: true, force: true });
        }
    });
});

test('TASK native metadata replaces stale notes while preserving newer observed page use', async () => {
    await withPageFixture('extension', async ({ unified, driver }) => {
        unified.recordPageUse('101');
        const lastUsedAt = unified.getPageMetadata('101').lastUsedAt;
        const metadata = {
            origin: 'adopted',
            createdBy: 'unknown',
            createdAt: null,
            lastUsedAt: '2000-01-01T00:00:00.000Z',
            taskHint: 'Native latest task',
        };
        driver.listTargets = async () => [
            { id: 101, targetId: '101', url: 'https://example.com/', title: 'Owned', metadata },
        ];
        const pages = await unified.listTargets();
        assert.equal(pages[0].metadata.origin, 'adopted');
        assert.equal(pages[0].metadata.taskHint, 'Native latest task');
        assert.equal(pages[0].metadata.lastUsedAt, lastUsedAt);
    });
});

test('wait full deadline observes a visible condition after the diagnostic reserve boundary', async () => {
    await withPageFixture('cdp', async ({ unified }) => {
        const session = getSession();
        const started = Date.now();
        const restoreSession = patchProperties(session, {
            createLocator: () => ({
                lastObservation: { matchCount: 1, lastLocatorState: 'found' },
                evaluateOn: async () => Date.now() - started >= 270,
            }),
            evaluate: async () => ({ candidates: [], activeElement: null }),
        });
        const restore = patchProperties(unified, { getLiveState: async () => ({ url: 'https://example.com/101' }) });
        try {
            const response = await registeredTool(registerWaitTool)({
                for: 'element',
                target: { css: '#delayed' },
                state: 'visible',
                timeout: 350,
            });
            const body = JSON.parse(response.content[0].text);
            assert.equal(body.success, true, response.content[0].text);
            assert.ok(Date.now() - started >= 270);
        } finally {
            restore();
            restoreSession();
        }
    });
});

test('Extension target diagnostics preserve fifteen matches beyond the requested nth and candidate limit', async () => {
    await withPageFixture('extension', async ({ unified, state }) => {
        const matches = Array.from({ length: 15 }, (_, index) => ({
            refId: 'owned-' + index,
            tag: 'button',
            text: 'Candidate ' + index,
            rect: { x: index, y: 0, width: 20, height: 20 },
        }));
        const restore = patchProperties(unified, {
            isExtensionConnected: () => true,
            find: async (_selector, _text, _xpath, _timeout, _semantic, nth) =>
                nth === undefined ? matches : matches.slice(nth, nth + 1),
            getLiveState: async () => ({ url: 'https://example.com/' + state.current, managed: true }),
            getChallengeState: async () => null,
            inspectChallenge: async () => ({ title: 'Ordinary', inspected: true }),
            evaluate: async (source) =>
                source.includes('activeElement')
                    ? { candidates: matches.slice(0, 10), activeElement: null, matchCount: 15 }
                    : { title: 'Ordinary', selectorHits: [], deniedHits: [], turnstilePresent: false },
        });
        try {
            for (const [register, args] of [
                [registerInputTool, { events: [{ type: 'click', target: { css: '.mcp-ch-many', nth: 30 } }] }],
                [registerExtractTool, { type: 'text', target: { css: '.mcp-ch-many', nth: 30 } }],
                [registerWaitTool, { for: 'element', target: { css: '.mcp-ch-many', nth: 30 } }],
            ]) {
                const response = await registeredTool(register)({ ...args, targetId: '202', timeout: 500 });
                const body = JSON.parse(response.content[0].text);
                assert.equal(body.error.context.matchCount, 15, response.content[0].text);
                assert.equal(body.error.context.nth, 30);
                assert.ok(body.error.context.candidates.length <= 10);
                assert.equal(state.current, '101');
                assert.deepEqual(state.dispatched, []);
            }
        } finally {
            restore();
        }
    });
});
