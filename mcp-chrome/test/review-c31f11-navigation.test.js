import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import test from 'node:test';
import { performance } from 'node:perf_hooks';

const root = fileURLToPath(new URL('..', import.meta.url));
test('C31F11 navigation settlement distinguishes request expiry from shorter waits', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-c31f11-navigation-'));
    const load = (p) => import(pathToFileURL(path.join(root, p)));
    const { Client } = await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
    const { McpServer } = await load('node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');
    const { InMemoryTransport } = await load('node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
    const { getUnifiedSession, getSession } = await load('dist/core/index.js');
    const { CDPClient } = await load('dist/cdp/client.js');
    const { getErrorSource } = await load('dist/core/errors.js');
    const { registerBrowseTool } = await load('dist/tools/browse.js');
    const result = {
        root,
        status: 'RUNNING',
        boundary:
            'Actual SDK Client/McpServer, registered browse, UnifiedSession, SessionManager navigation waiters, CDPClient send and handleMessage. Controlled connected CDP protocol peer immediately acknowledges Page.navigate/Page.reload but emits no completion lifecycle event. Original production navigation timeout callback is scheduled by the native Node timer and executes unchanged. Date.now is pinned at the recorded enclosing request deadline minus one, or at the deadline control, only when that genuine callback runs through handler completion. No fabricated timeout Error, no replacement classifier, no Chrome/DOM or browser navigation. The tested contract is the previously accepted callback-immediate budget settlement rule, not a claim of naturally observed Chrome timing.',
        checks: [],
        requests: [],
        observations: [],
        sdkCalls: 0,
        registeredHandlerCalls: 0,
        peerErrors: [],
    };
    const output = path.join(work, 'results.json');
    const save = () => fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    const realNow = Date.now,
        realSetTimeout = globalThis.setTimeout,
        realClearTimeout = globalThis.clearTimeout;
    const timers = new Map();
    const restores = [];
    let active,
        waitConstruction = false;
    const unified = getUnifiedSession(),
        session = getSession();
    const clientCdp = new CDPClient(() => unified.tabLockContext.getStore());
    const page = {
        targetId: '101',
        type: 'page',
        url: 'https://navigation-budget.example.test/owned',
        title: 'Owned navigation page',
    };
    Date.now = () => active?.controlledNow ?? realNow();
    globalThis.setTimeout = (callback, delay, ...args) => {
        const scope = unified.tabLockContext.getStore();
        const selected = Boolean(waitConstruction && active);
        const record = {
            selected,
            delay,
            scopeDeadline: scope?.deadline,
            productionDeadline: Date.now() + Number(delay),
        };
        const handle = realSetTimeout(() => {
            timers.delete(handle);
            if (selected) {
                active.controlledNow =
                    (active.pinOperation ? record.productionDeadline : record.scopeDeadline) + active.delta;
                active.budgetReceipt = {
                    ...record,
                    now: Date.now(),
                    actualAt: performance.now(),
                    originalCallback: String(callback),
                };
            }
            callback(...args);
        }, delay);
        timers.set(handle, record);
        return handle;
    };
    globalThis.clearTimeout = (handle) => {
        timers.delete(handle);
        return realClearTimeout(handle);
    };
    function wrap(object, key, wrapper) {
        const original = object[key];
        object[key] = wrapper(original.bind(object));
        restores.push(() => {
            object[key] = original;
        });
    }
    for (const key of ['startNavigationWait', 'waitForAnyEvent', 'buildNetworkIdlePromise']) {
        wrap(session, key, (original) => (...args) => {
            waitConstruction = true;
            try {
                return original(...args);
            } finally {
                waitConstruction = false;
            }
        });
    }
    for (const key of ['navigate', 'reload']) {
        wrap(session, key, (original) => async (...args) => {
            try {
                return await original(...args);
            } catch (error) {
                active.navigationError = {
                    name: error.name,
                    code: error.code,
                    message: error.message,
                    source: getErrorSource(error) ?? null,
                    context: error.context,
                    scopeBudgetError: unified.tabLockContext.getStore()?.budgetError?.message ?? null,
                };
                throw error;
            }
        });
    }
    for (const key of ['getConsoleLogs', 'getNetworkRequests']) {
        wrap(unified, key, (original) => async (...args) => {
            result.observations.push({
                case: active?.id,
                method: key,
                afterBudgetReceipt: Boolean(active?.budgetReceipt),
                wall: Date.now(),
                scopeBudgetError: unified.tabLockContext.getStore()?.budgetError?.message ?? null,
            });
            return original(...args);
        });
    }
    clientCdp.ws = {
        readyState: 1,
        close() {},
        send(text) {
            const message = JSON.parse(text);
            result.requests.push({
                ...message,
                case: active?.id,
                at: performance.now(),
                wall: Date.now(),
                afterBudgetReceipt: Boolean(active?.budgetReceipt),
            });
            globalThis.queueMicrotask(() => {
                try {
                    let data;
                    switch (message.method) {
                        case 'Target.getTargetInfo':
                            data = { targetInfo: page };
                            break;
                        case 'Target.getTargets':
                            data = { targetInfos: [page] };
                            break;
                        case 'Page.getNavigationHistory':
                            data = { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] };
                            break;
                        case 'Page.navigate':
                            data = { frameId: 'owned-root', loaderId: 'owned-new-loader' };
                            break;
                        case 'Page.reload':
                        case 'Page.navigateToHistoryEntry':
                        case 'Runtime.enable':
                        case 'Log.enable':
                        case 'Console.enable':
                        case 'Network.enable':
                            data = {};
                            break;
                        default:
                            throw new Error('Unexpected controlled CDP method ' + message.method);
                    }
                    clientCdp.handleMessage(Buffer.from(JSON.stringify({ id: message.id, result: data })));
                } catch (error) {
                    result.peerErrors.push(String(error));
                    clientCdp.handleMessage(
                        Buffer.from(JSON.stringify({ id: message.id, error: { code: -32601, message: String(error) } }))
                    );
                }
            });
        },
    };
    session.cdp = clientCdp;
    session.sessionId = 'owned-native-session';
    session.currentTargetId = '101';
    session.state = { ...page };
    session.mainFrameId = 'owned-root';
    session.mainFrameLoaderId = 'owned-old-loader';
    session.targetSessions.set('101', 'owned-native-session');
    session.requestContext = () => unified.tabLockContext.getStore();
    unified.extensionBridge = null;
    unified.activeMode = 'cdp';
    unified.cdpExplicitlySelected = true;
    const server = new McpServer({ name: 'cdp-navigation-budget-review', version: '1' });
    const register = server.registerTool.bind(server);
    server.registerTool = (name, schema, handler) =>
        register(name, schema, async (...args) => {
            ++result.registeredHandlerCalls;
            return handler(...args);
        });
    registerBrowseTool(server);
    const client = new Client({ name: 'cdp-navigation-budget-client', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
        await server.connect(st);
        await client.connect(ct);
        for (const action of ['open', 'refresh', 'back', 'forward']) {
            for (const delta of [-1, 0]) {
                active = {
                    id: `cdp-${action}-${delta === -1 ? 'minus1' : 'at-deadline'}`,
                    action,
                    delta,
                    started: performance.now(),
                };
                const row = active;
                try {
                    row.input = {
                        name: 'browse',
                        arguments: {
                            action,
                            targetId: '101',
                            timeout: 120,
                            diagnostics: true,
                            wait: 'load',
                            ...(action === 'open' ? { url: 'https://navigation-budget.example.test/next' } : {}),
                        },
                    };
                    ++result.sdkCalls;
                    row.response = await client.callTool(row.input);
                    row.body = JSON.parse(row.response.content[0].text);
                    row.requests = result.requests.filter((q) => q.case === row.id);
                    row.observations = result.observations.filter((q) => q.case === row.id);
                    row.readsAfterReceipt = row.requests.filter(
                        (q) => q.afterBudgetReceipt && ['Target.getTargets', 'Target.getTargetInfo'].includes(q.method)
                    );
                    row.diagnosticsAfterReceipt = row.observations.filter((q) => q.afterBudgetReceipt);
                    row.principal = row.requests.filter((q) =>
                        ['Page.navigate', 'Page.reload', 'Page.navigateToHistoryEntry'].includes(q.method)
                    );
                    assert.ok(row.budgetReceipt, 'Must execute the genuine production navigation timeout callback');
                    assert.equal(result.peerErrors.length, 0);
                    assert.equal(row.principal.length, 1);
                    assert.equal(row.body.error.code, 'NAVIGATION_TIMEOUT');
                    assert.equal(row.body.error.context.actionExecuted, 'unknown');
                    assert.equal(row.body.error.context.actionStatus, 'unknown');
                    assert.equal(row.body.error.context.retryable, false);
                    assert.equal(
                        row.readsAfterReceipt.length,
                        0,
                        'No page-context reads after navigation budget settlement'
                    );
                    assert.equal(
                        row.diagnosticsAfterReceipt.length,
                        0,
                        'No diagnostic buffer reads after navigation budget settlement'
                    );
                    row.status = 'PASS';
                } catch (error) {
                    row.status = 'FAIL';
                    row.error = String(error);
                    row.stack = error.stack;
                } finally {
                    row.resources = {
                        callbacks: clientCdp.callbacks.size,
                        eventWaiters: clientCdp.activeEventWaiters.size,
                        eventListenerCount: [...clientCdp.eventListeners.values()].reduce((n, x) => n + x.size, 0),
                        timers: timers.size,
                        target: session.currentTargetId,
                        frame: session.selectedFrame,
                        pendingCondition: session.pendingPageCondition,
                        clientPending: client._responseHandlers.size,
                        serverPending: server.server._responseHandlers.size,
                    };
                    row.elapsedMs = performance.now() - row.started;
                    delete row.controlledNow;
                    result.checks.push(row);
                    active = undefined;
                    save();
                    console.log(
                        row.id,
                        row.status,
                        'post-context=' + row.readsAfterReceipt?.length,
                        'post-diagnostics=' + row.diagnosticsAfterReceipt?.length,
                        row.error ?? ''
                    );
                }
            }
        }

        for (const helper of ['startNavigationWait', 'waitForAnyEvent', 'buildNetworkIdlePromise']) {
            for (const shorter of [false, true]) {
                active = {
                    id: `direct-${helper}-${shorter ? 'shorter' : 'request'}`,
                    delta: -1,
                    pinOperation: shorter,
                    started: performance.now(),
                };
                const row = active;
                try {
                    await unified.withTabLock(
                        async () => {
                            const scope = unified.tabLockContext.getStore();
                            const timeout = shorter ? 20 : scope.deadline - Date.now();
                            let caught;
                            try {
                                if (helper === 'startNavigationWait') {
                                    await session.startNavigationWait('load', timeout, undefined, false).promise;
                                } else if (helper === 'waitForAnyEvent') {
                                    await session.waitForAnyEvent(['Page.loadEventFired'], timeout);
                                } else {
                                    await session.buildNetworkIdlePromise(clientCdp, timeout, 500);
                                }
                            } catch (error) {
                                caught = error;
                            }
                            assert.ok(caught);
                            row.source = getErrorSource(caught) ?? null;
                            row.sameBudgetError = scope.budgetError === caught;
                            assert.ok(row.budgetReceipt);
                            if (shorter) {
                                assert.equal(scope.budgetError, undefined);
                                assert.notEqual(row.source, 'budget');
                                assert.doesNotThrow(() => unified.assertRequestActive());
                            } else {
                                assert.equal(row.sameBudgetError, true);
                                assert.equal(row.source, 'budget');
                                assert.throws(
                                    () => unified.assertRequestActive(),
                                    (error) => error === caught
                                );
                            }
                        },
                        Date.now() + (shorter ? 500 : 80)
                    );
                    row.status = 'PASS';
                } catch (error) {
                    row.status = 'FAIL';
                    row.error = String(error);
                    row.stack = error.stack;
                } finally {
                    delete row.controlledNow;
                    row.elapsedMs = performance.now() - row.started;
                    result.checks.push(row);
                    active = undefined;
                    save();
                }
            }
        }
        result.status = result.checks.every((r) => r.status === 'PASS') ? 'PASS' : 'FAIL';
    } catch (error) {
        result.status = 'HARNESS_FAILURE';
        result.error = String(error);
        result.stack = error.stack;
    } finally {
        Date.now = realNow;
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
        for (const restore of restores.reverse()) {
            restore();
        }
        result.cleanup = [];
        for (const [name, close] of [
            ['sdk-client', () => client.close()],
            ['sdk-server', () => server.close()],
            [
                'cdp-fixture',
                () => {
                    clientCdp.close();
                    session.cdp = null;
                    session.sessionId = null;
                    session.currentTargetId = null;
                    session.targetSessions.clear();
                },
            ],
        ]) {
            try {
                await close();
                result.cleanup.push({ name, success: true });
            } catch (error) {
                result.cleanup.push({ name, success: false, error: String(error) });
                result.status = 'HARNESS_FAILURE';
            }
        }
        result.counts = {
            checks: result.checks.length,
            pass: result.checks.filter((r) => r.status === 'PASS').length,
            fail: result.checks.filter((r) => r.status === 'FAIL').length,
            sdkCalls: result.sdkCalls,
            registeredHandlerCalls: result.registeredHandlerCalls,
            nativeReferenceCalls: 0,
            chromeOrDomExecution: 0,
        };
        save();
        console.log(JSON.stringify({ status: result.status, counts: result.counts, output }));
    }

    assert.equal(result.checks.length, 14);
    assert.equal(result.sdkCalls, 8);
    assert.equal(result.registeredHandlerCalls, 8);
    assert.equal(result.status, 'PASS', 'Navigation SDK regression evidence: ' + output);
});

test('C31F12 history command refusal cancels only its local waiter and preserves following requests', async () => {
    const load = (p) => import(pathToFileURL(path.join(root, p)));
    const { getSession, getUnifiedSession } = await load('dist/core/index.js');
    const { CDPClient } = await load('dist/cdp/client.js');
    const session = getSession(),
        unified = getUnifiedSession();
    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-c31f12-history-')), 'results.json');
    const report = {
        status: 'RUNNING',
        checks: [],
        peerErrors: [],
        cleanup: [],
        boundary:
            'Direct production SessionManager -> CDPClient send/handleMessage, controlled protocol receipts, native Node timers and request AbortSignal; no SDK, browser, DOM or real socket',
    };
    const setTimer = globalThis.setTimeout,
        clearTimer = globalThis.clearTimeout;
    const timers = new Set(),
        clients = [];
    const originalSend = session.send,
        originalContext = session.requestContext;
    let active;
    globalThis.setTimeout = (fn, ms, ...args) => {
        const handle = setTimer(() => {
            timers.delete(handle);
            fn(...args);
        }, ms);
        timers.add(handle);
        return handle;
    };
    globalThis.clearTimeout = (handle) => {
        timers.delete(handle);
        return clearTimer(handle);
    };
    session.requestContext = () => unified.tabLockContext.getStore();
    session.send = async function (...args) {
        try {
            return await originalSend.apply(this, args);
        } catch (error) {
            if (args[0] === 'Page.navigateToHistoryEntry') {
                active.rpcError = error;
            }
            throw error;
        }
    };
    try {
        const cases = ['goBack', 'goForward'].flatMap((method) =>
            ['reject', 'success', 'no-history', 'abort', 'disconnect'].map((kind) => ({ method, kind }))
        );
        cases.push(
            ...Array.from({ length: 12 }, (_, index) => ({
                method: index % 2 ? 'goForward' : 'goBack',
                kind: 'reject',
                burst: index,
            }))
        );
        for (const spec of cases) {
            const row = { spec, requests: [] },
                controller = new AbortController();
            active = row;
            const cdp = new CDPClient(() => unified.tabLockContext.getStore());
            clients.push(cdp);
            cdp.ws = {
                readyState: 1,
                close() {},
                send(text) {
                    const q = JSON.parse(text);
                    row.requests.push(q);
                    globalThis.queueMicrotask(() => {
                        if (q.method === 'Page.getNavigationHistory') {
                            const currentIndex = spec.kind === 'no-history' ? (spec.method === 'goBack' ? 0 : 2) : 1;
                            cdp.handleMessage(
                                JSON.stringify({
                                    id: q.id,
                                    result: { currentIndex, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] },
                                })
                            );
                        } else if (q.method === 'Page.navigateToHistoryEntry') {
                            if (spec.kind === 'reject') {
                                cdp.handleMessage(
                                    JSON.stringify({
                                        id: q.id,
                                        error: { code: -32000, message: 'owned history command rejection' },
                                    })
                                );
                            } else {
                                cdp.handleMessage(JSON.stringify({ id: q.id, result: {} }));
                                if (spec.kind === 'abort') {
                                    controller.abort(new Error('owned request cancellation'));
                                } else if (spec.kind === 'disconnect') {
                                    cdp.emit('disconnected');
                                } else {
                                    cdp.handleMessage(
                                        JSON.stringify({
                                            method: 'Page.loadEventFired',
                                            params: { timestamp: 1 },
                                            sessionId: 'owned-history-session',
                                        })
                                    );
                                }
                            }
                        } else if (q.method === 'Target.getTargetInfo') {
                            cdp.handleMessage(
                                JSON.stringify({
                                    id: q.id,
                                    result: {
                                        targetInfo: {
                                            targetId: '101',
                                            url: 'https://history.example.test/owned',
                                            title: 'Owned history',
                                        },
                                    },
                                })
                            );
                        } else {
                            report.peerErrors.push(q.method);
                            cdp.handleMessage(
                                JSON.stringify({
                                    id: q.id,
                                    error: { code: -32601, message: 'Unmodeled fixture method: ' + q.method },
                                })
                            );
                        }
                    });
                },
            };
            Object.assign(session, {
                cdp,
                sessionId: 'owned-history-session',
                currentTargetId: '101',
                mainFrameId: 'owned-history-root',
            });
            try {
                await unified.withTabLock(async () => {
                    const scope = unified.tabLockContext.getStore();
                    scope.signal = controller.signal;
                    let caught;
                    try {
                        row.value = await session[spec.method](500);
                    } catch (error) {
                        caught = error;
                    }
                    row.error = caught && { name: caught.name, message: caught.message };
                    row.parentAborted = scope.signal.aborted;
                    row.budgetError = scope.budgetError?.message ?? null;
                    if (spec.kind === 'reject') {
                        assert.ok(caught.message.includes('owned history command rejection'));
                        assert.equal(caught, row.rpcError);
                        assert.doesNotThrow(() => unified.assertRequestActive());
                    } else if (spec.kind === 'abort') {
                        assert.equal(caught, controller.signal.reason);
                    } else if (spec.kind === 'disconnect') {
                        assert.match(caught.message, /CDP 连接已关闭/);
                    } else {
                        assert.equal(caught, undefined);
                        assert.equal(row.value.navigated, spec.kind !== 'no-history');
                    }
                    assert.equal(scope.budgetError, undefined);
                    assert.equal(scope.signal.aborted, spec.kind === 'abort');
                }, Date.now() + 2000);
                row.resources = {
                    callbacks: cdp.callbacks.size,
                    eventWaiters: cdp.activeEventWaiters.size,
                    listeners: [...cdp.eventListeners.values()].reduce((n, s) => n + s.size, 0),
                    disconnected: cdp.listenerCount('disconnected'),
                    timers: timers.size,
                };
                assert.ok(
                    Object.values(row.resources).every((value) => value === 0),
                    JSON.stringify(row.resources)
                );
                assert.equal(
                    row.requests.filter((q) => q.method === 'Page.navigateToHistoryEntry').length,
                    spec.kind === 'no-history' ? 0 : 1
                );
                assert.deepEqual(report.peerErrors, []);
                row.status = 'PASS';
            } catch (error) {
                row.status = 'FAIL';
                row.failure = error.stack;
            } finally {
                delete row.rpcError;
                report.checks.push(row);
                cdp.emit('disconnected');
                await Promise.resolve();
                cdp.ws = null;
            }
        }
        report.status = report.checks.every((row) => row.status === 'PASS') ? 'PASS' : 'FAIL';
    } finally {
        for (const [name, close] of [
            [
                'clients',
                () => {
                    for (const cdp of clients) {
                        cdp.emit('disconnected');
                        cdp.ws = null;
                    }
                },
            ],
            [
                'timers',
                () => {
                    for (const handle of timers) {
                        clearTimer(handle);
                    }
                    timers.clear();
                },
            ],
            [
                'restore',
                () => {
                    globalThis.setTimeout = setTimer;
                    globalThis.clearTimeout = clearTimer;
                    session.send = originalSend;
                    session.requestContext = originalContext;
                    session.cdp = null;
                    session.sessionId = null;
                    session.currentTargetId = null;
                },
            ],
        ]) {
            try {
                await close();
                report.cleanup.push({ name, success: true });
            } catch (error) {
                report.cleanup.push({ name, success: false, error: String(error) });
                report.status = 'ERROR';
            }
        }
        fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({ status: report.status, checks: report.checks.length, output }));
    }
    assert.equal(report.checks.length, 22);
    assert.equal(report.status, 'PASS', 'History local waiter cleanup evidence: ' + output);
});
