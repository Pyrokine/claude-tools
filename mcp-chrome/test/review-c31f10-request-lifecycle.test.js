import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('C31F10 SDK metadata isolates pending conditions across requests', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-c31f10-sdk-'));
    const load = (relative) => import(pathToFileURL(path.join(root, relative)));
    const { Client } = await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
    const { McpServer } = await load('node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');
    const { InMemoryTransport } = await load('node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
    const { getUnifiedSession } = await load('dist/core/index.js');
    const { ExtensionBridge } = await load('dist/extension/bridge.js');
    const { registerEvaluateTool } = await load('dist/tools/evaluate.js');
    const { registerManageTool } = await load('dist/tools/manage.js');
    const output = path.join(work, 'results.json');
    const result = {
        status: 'RUNNING',
        root,
        boundary:
            'Actual SDK Client/McpServer and current registered evaluate/manage, UnifiedSession, Bridge and HttpServer transport parser. Controlled connected Extension protocol peer provides declared tabs/frame/snapshot metadata; it holds a successful preparation or action ACK, then delivers it after a concurrent metadata request. No replacement clock/timer/classifier and no Chrome or DOM. The peer enforces exactly the serialized expectedUrl/revision contract and records a simulated principal effect only when that guard permits execution; source-level dispatch and guard consumption are independent of this simulation.',
        checks: [],
        requests: [],
        peerErrors: [],
        sdkCalls: 0,
        handlerCalls: 0,
    };
    const save = () => fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    const body = (response) => JSON.parse(response.content[0].text);
    const defer = () => {
        let resolve;
        const promise = new Promise((r) => {
            resolve = r;
        });
        return { promise, resolve };
    };
    const unified = getUnifiedSession();
    const bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() });
    const rpc = bridge.httpServer;
    let active;
    const tabs = new Map(
        [101, 202].map((id) => [
            id,
            {
                id,
                targetId: String(id),
                type: 'page',
                url: `https://metadata.example.test/${id}`,
                title: 'Owned metadata page',
                managed: true,
                active: id === 101,
                windowId: 1,
            },
        ])
    );
    const metadata = new Map();
    const mainScript = 'globalThis.__metadataIsolation = (globalThis.__metadataIsolation || 0) + 1';
    const isMain = (message) => message.action === 'evaluate_in_frame' && message.params.expression === mainScript;
    function peerResponse(message) {
        const p = message.params;
        const tab = tabs.get(p.tabId);
        if (
            (p.expectedUrl !== undefined && p.expectedUrl !== tab?.url) ||
            (p.expectedRevision !== undefined && p.expectedRevision !== `r${p.tabId}`)
        ) {
            return {
                id: message.id,
                success: false,
                error: JSON.stringify({
                    error: {
                        code: 'ACTION_PRECONDITION_FAILED',
                        message: '页面 URL 或 revision 已变化，未执行动作',
                        context: {
                            targetId: String(p.tabId),
                            expectedUrl: p.expectedUrl ?? null,
                            expectedRevision: p.expectedRevision ?? null,
                            actualUrl: tab?.url,
                            actualRevision: `r${p.tabId}`,
                            actionExecuted: false,
                        },
                    },
                }),
            };
        }
        let data;
        switch (message.action) {
            case 'page_snapshot':
                data = { targetId: String(p.tabId), url: tab.url, revision: `r${p.tabId}` };
                break;
            case 'tabs_list':
                data = [...tabs.values()];
                break;
            case 'tabs_topology':
                data = { windows: [{ id: 1, tabs: [...tabs.values()] }], activeTargetId: '101' };
                break;
            case 'resolve_frame':
                data = {
                    frameId: 7,
                    offset: { x: 0, y: 0 },
                    frameContext: { documentId: 'owned-stable-frame', url: 'https://metadata.example.test/frame' },
                };
                break;
            case 'tabs_metadata': {
                const m = {
                    origin: 'created',
                    createdBy: 'owned-review',
                    createdAt: 1,
                    lastUsedAt: Date.now(),
                    ...(metadata.get(p.tabId) ?? {}),
                    ...(p.note !== undefined ? { note: p.note } : {}),
                };
                if (p.note === null) {
                    delete m.note;
                }
                metadata.set(p.tabId, m);
                data = m;
                break;
            }
            case 'evaluate_in_frame':
                assert.ok(isMain(message));
                ++active.peerPrincipalEffects;
                data = {
                    result: { type: 'number', value: 1 },
                    frameContext: { frameId: 7, documentId: 'owned-stable-frame' },
                };
                break;
            case 'network_challenge_state':
                data = { challengeRequired: false };
                break;
            case 'challenge_inspect':
                data = {
                    title: tab.title,
                    url: tab.url,
                    selectorHits: [],
                    deniedHits: [],
                    textHits: [],
                    inspected: true,
                };
                break;
            default:
                throw new Error('Unsupported peer action: ' + message.action);
        }
        return { id: message.id, success: true, data };
    }
    rpc.helloReceived = true;
    rpc.clientSocket = {
        readyState: 1,
        close() {},
        send(text) {
            const message = JSON.parse(text);
            result.requests.push({
                ...message,
                check: active?.id,
                at: performance.now(),
                pendingCondition: bridge.pendingPageCondition ? { ...bridge.pendingPageCondition } : null,
            });
            if (message.type === 'cancel') {
                return;
            }
            globalThis.queueMicrotask(() => {
                try {
                    const reply = peerResponse(message);
                    if (
                        !active.held &&
                        (active.hold === 'frame' ? message.action === 'resolve_frame' : isMain(message))
                    ) {
                        active.held = message;
                        active.heldReply = reply;
                        active.ready.resolve();
                        return;
                    }
                    rpc.handleMessage(JSON.stringify(reply));
                } catch (error) {
                    result.peerErrors.push(String(error));
                    rpc.handleMessage(JSON.stringify({ id: message.id, success: false, error: String(error) }));
                }
            });
        },
    };
    unified.extensionBridge = bridge;
    unified.activeMode = 'extension';
    unified.cdpExplicitlySelected = false;
    unified.inputMode = 'precise';
    const server = new McpServer({ name: 'metadata-isolation-review', version: '1' });
    const originalRegister = server.registerTool.bind(server);
    server.registerTool = (name, schema, handler) =>
        originalRegister(name, schema, async (args, extra) => {
            ++result.handlerCalls;
            if (name === 'manage') {
                active.manageEntered.resolve();
            }
            return handler(args, extra);
        });
    registerEvaluateTool(server);
    registerManageTool(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'metadata-isolation-review-client', version: '1' });
    const rows = [
        { id: 'different-target-pending-condition', hold: 'frame', metadataTarget: '101', changeUrl: false },
        { id: 'same-target-consumes-condition', hold: 'frame', metadataTarget: '202', changeUrl: true },
        { id: 'different-target-after-principal', hold: 'main', metadataTarget: '101', changeUrl: false },
        {
            id: 'conditional-metadata-remains-queued',
            hold: 'frame',
            metadataTarget: '101',
            conditionalMetadata: true,
            changeUrl: false,
        },
        { id: 'condition-preserved-without-metadata', hold: 'frame', changeUrl: true },
        { id: 'different-target-read', hold: 'frame', metadataTarget: '101', readMetadata: true },
        { id: 'same-target-read', hold: 'frame', metadataTarget: '202', readMetadata: true, changeUrl: true },
        { id: 'same-target-clear', hold: 'frame', metadataTarget: '202', clearMetadata: true, changeUrl: true },
        { id: 'same-target-own-condition', hold: 'frame', metadataTarget: '202', conditionalMetadata: true },
    ];
    try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        for (const config of rows) {
            const row = (active = {
                ...config,
                ready: defer(),
                manageEntered: defer(),
                peerPrincipalEffects: 0,
                firstRequest: result.requests.length,
                started: performance.now(),
            });
            bridge.setCurrentTargetId('101');
            bridge.setCurrentFrameId(0);
            bridge.pendingPageCondition = null;
            tabs.get(202).url = 'https://metadata.example.test/202';
            metadata.clear();
            let principal, meta;
            try {
                row.evaluateInput = {
                    name: 'evaluate',
                    arguments: {
                        targetId: '202',
                        frame: '#owned-child',
                        expectedUrl: tabs.get(202).url,
                        script: mainScript,
                        timeout: 3000,
                    },
                };
                ++result.sdkCalls;
                principal = client.callTool(row.evaluateInput);
                await row.ready.promise;
                row.beforeMetadata = {
                    target: bridge.getCurrentTargetId(),
                    frame: bridge.getCurrentFrameId(),
                    condition: bridge.pendingPageCondition ? { ...bridge.pendingPageCondition } : null,
                };
                if (row.metadataTarget) {
                    row.metadataInput = {
                        name: 'manage',
                        arguments: {
                            action: 'pageMetadata',
                            targetId: row.metadataTarget,
                            ...(row.readMetadata ? {} : { note: row.clearMetadata ? null : 'concurrent-owned-note' }),
                            ...(row.conditionalMetadata
                                ? { expectedUrl: tabs.get(Number(row.metadataTarget)).url }
                                : {}),
                        },
                    };
                    ++result.sdkCalls;
                    meta = client.callTool(row.metadataInput).then((value) => {
                        row.metadataResponse = body(value);
                        row.metadataCompletedBeforeRelease = !row.released;
                        return value;
                    });
                    await row.manageEntered.promise;
                    await Promise.race([meta, new Promise((resolve) => setTimeout(resolve, 30))]);
                }
                row.afterConcurrentMetadata = {
                    target: bridge.getCurrentTargetId(),
                    frame: bridge.getCurrentFrameId(),
                    condition: bridge.pendingPageCondition ? { ...bridge.pendingPageCondition } : null,
                };
                if (row.changeUrl) {
                    tabs.get(202).url += '/changed-by-page';
                }
                row.released = true;
                rpc.handleMessage(JSON.stringify(row.heldReply));
                row.evaluateResponse = body(await principal);
                if (meta) {
                    await meta;
                }
                row.requests = result.requests.slice(row.firstRequest);
                row.mainRequests = row.requests.filter(isMain);
                row.metadataRequests = row.requests.filter((message) => message.action === 'tabs_metadata');
                assert.equal(result.peerErrors.length, 0);
                assert.equal(row.beforeMetadata.target, '202');
                assert.equal(row.afterConcurrentMetadata.target, '202');
                assert.equal(row.beforeMetadata.frame, row.afterConcurrentMetadata.frame);
                if (row.metadataTarget) {
                    assert.equal(
                        row.metadataResponse.success,
                        true,
                        'Unconditional or correctly queued own metadata must not inherit another request condition'
                    );
                }
                if (row.changeUrl) {
                    assert.equal(
                        row.peerPrincipalEffects,
                        0,
                        'The original expectedUrl must reach the principal after concurrent metadata'
                    );
                    assert.equal(row.evaluateResponse.error?.code, 'ACTION_PRECONDITION_FAILED');
                } else {
                    assert.equal(row.evaluateResponse.actionStatus, 'completed');
                }
                if (row.conditionalMetadata) {
                    assert.equal(row.metadataCompletedBeforeRelease, false);
                }
                row.status = 'PASS';
            } catch (error) {
                row.status = 'FAIL';
                row.error = String(error);
                row.stack = error.stack;
            } finally {
                if (row.heldReply && !row.released) {
                    row.released = true;
                    rpc.handleMessage(JSON.stringify(row.heldReply));
                }
                if (principal) {
                    await principal.catch(() => {});
                }
                if (meta) {
                    await meta.catch(() => {});
                }
                row.after = {
                    pending: rpc.messageHandlers.size,
                    target: bridge.getCurrentTargetId(),
                    frame: bridge.getCurrentFrameId(),
                    condition: bridge.pendingPageCondition ?? null,
                    clientPending: client._responseHandlers.size,
                    serverPending: server.server._responseHandlers.size,
                };
                delete row.ready;
                delete row.manageEntered;
                row.elapsedMs = performance.now() - row.started;
                if (
                    row.after.pending ||
                    row.after.condition ||
                    row.after.frame !== 0 ||
                    row.after.clientPending ||
                    row.after.serverPending
                ) {
                    row.status = 'FAIL';
                    row.cleanupFailure = true;
                }
                result.checks.push(row);
                console.log(
                    row.id,
                    row.status,
                    'metadataBeforeRelease=' + row.metadataCompletedBeforeRelease,
                    'metadataError=' + row.metadataResponse?.error?.code,
                    'principalEffects=' + row.peerPrincipalEffects,
                    row.error ?? ''
                );
                active = undefined;
                save();
            }
        }
        result.status = result.checks.every((row) => row.status === 'PASS') ? 'PASS' : 'FAIL';
    } catch (error) {
        result.status = 'HARNESS_FAILURE';
        result.error = String(error);
        result.stack = error.stack;
    } finally {
        result.cleanup = [];
        for (const [name, close] of [
            ['client', () => client.close()],
            ['server', () => server.close()],
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
            pass: result.checks.filter((row) => row.status === 'PASS').length,
            fail: result.checks.filter((row) => row.status === 'FAIL').length,
            sdkCalls: result.sdkCalls,
            registeredHandlerCalls: result.handlerCalls,
            nativeReferenceCalls: 0,
            chromeOrDomExecution: 0,
        };
        save();
    }
    console.log(JSON.stringify({ status: result.status, counts: result.counts, output }));
    assert.equal(result.counts.checks, 9);
    assert.equal(result.status, 'PASS', 'SDK regression evidence: ' + output);
});

test('C31F10 SDK settled budgets stop later reads and retain bounded key cleanup', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-c31f10-sdk-'));
    const load = (relative) => import(pathToFileURL(path.join(root, relative)));
    const { Client } = await load('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
    const { McpServer } = await load('node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');
    const { InMemoryTransport } = await load('node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
    const { getUnifiedSession } = await load('dist/core/index.js');
    const { ExtensionBridge } = await load('dist/extension/bridge.js');
    const { getErrorSource, getErrorPageContext } = await load('dist/core/errors.js');
    const { registerEvaluateTool } = await load('dist/tools/evaluate.js');
    const { registerInputTool } = await load('dist/tools/input.js');
    const result = {
        status: 'RUNNING',
        root,
        boundary:
            'Real SDK Client/McpServer tools/call, current registered handlers, UnifiedSession, ExtensionBridge and HttpServer timers/parser. Controlled in-memory Extension protocol peer; no browser or DOM. Selected valid ACK is held until its genuine production timeout callback runs. The native setTimeout still schedules the original production callback; only Date.now is controlled to recorded command deadline minus one (or deadline control) from that callback until the handler finishes, matching the declared C31F9-13 edge. No timeout Error is manufactured and no error classifier is replaced. Transparent wrappers observe sendCommand and handlers.',
        checks: [],
        requests: [],
        errors: [],
        peerErrors: [],
        sdkCalls: 0,
        handlerCalls: 0,
    };
    const output = path.join(work, 'results.json');
    const save = () => fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    const parse = (response) => JSON.parse(response.content[0].text);
    const originalNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = new Map();
    let active;
    Date.now = () => active?.controlledNow ?? originalNow();
    globalThis.setTimeout = (callback, delay, ...args) => {
        const record = { delay, callback, args };
        const handle = originalSetTimeout(() => {
            timers.delete(handle);
            if (record.row) {
                assert.equal(active, record.row);
                record.row.controlledNow = record.deadline + record.row.delta;
                record.row.budgetReceipt = {
                    deadline: record.deadline,
                    now: Date.now(),
                    delta: record.row.delta,
                    actualAt: performance.now(),
                    selectedMessageId: record.row.held.id,
                };
            }
            callback(...args);
        }, delay);
        timers.set(handle, record);
        return handle;
    };
    globalThis.clearTimeout = (handle) => {
        timers.delete(handle);
        return originalClearTimeout(handle);
    };

    const unified = getUnifiedSession();
    const bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() });
    const rpc = bridge.httpServer;
    const tab = {
        id: 101,
        targetId: '101',
        type: 'page',
        url: 'https://budget.example.test/101',
        title: 'Owned budget fixture',
        managed: true,
        active: true,
        windowId: 1,
    };
    const snapshot = { targetId: '101', url: tab.url, revision: 'r101' };
    const mainScript = 'globalThis.__budgetPrincipal = (globalThis.__budgetPrincipal || 0) + 1';
    const functionScript =
        'function(n) { globalThis.__budgetPrincipal = (globalThis.__budgetPrincipal || 0) + 1; return n }';
    const isMainEvaluate = (q) =>
        q.action === 'debugger_send' &&
        (q.params.params?.expression?.includes('__budgetPrincipal') ||
            q.params.params?.functionDeclaration?.includes('__budgetPrincipal'));
    const isMainInput = (q) => q.action === 'input_key';
    function peerData(message) {
        switch (message.action) {
            case 'page_snapshot':
                return snapshot;
            case 'tabs_list':
                return [tab];
            case 'tabs_topology':
                return { windows: [{ id: 1, tabs: [tab] }], activeTargetId: '101' };
            case 'keyboard_focus':
                return message.params.operation === 'acquire' ? { changed: false } : { restored: true, errors: [] };
            case 'console_enable':
            case 'network_enable':
            case 'input_key':
                return {};
            case 'console_get':
                return { messages: [] };
            case 'network_get':
                return { requests: [] };
            case 'network_challenge_state':
                return { challengeRequired: false };
            case 'challenge_inspect':
                return {
                    title: tab.title,
                    url: tab.url,
                    selectorHits: [],
                    deniedHits: [],
                    textHits: [],
                    inspected: true,
                };
            case 'find':
                return [
                    {
                        refId: 'owned-button',
                        tag: 'button',
                        text: 'Owned',
                        rect: { x: 0, y: 0, width: 80, height: 24 },
                    },
                ];
            case 'debugger_send': {
                if (message.params.method === 'Runtime.evaluate') {
                    return message.params.params?.expression === 'globalThis'
                        ? { result: { type: 'object', objectId: 'owned-global' } }
                        : { result: { type: 'number', value: 1 } };
                }
                if (message.params.method === 'Runtime.callFunctionOn') {
                    return { result: { type: 'number', value: 1 } };
                }
                if (message.params.method === 'Runtime.releaseObject') {
                    return {};
                }
                throw new Error('Unsupported debugger method: ' + message.params.method);
            }
            default:
                throw new Error('Unsupported protocol action: ' + message.action);
        }
    }
    function selected(message) {
        if (!active || active.held) {
            return false;
        }
        if (message.action === 'page_snapshot') {
            ++active.snapshots;
        }
        if (message.action === 'tabs_list') {
            ++active.lists;
        }
        if (message.action === 'console_get') {
            ++active.consoleGets;
        }
        if (isMainEvaluate(message) || isMainInput(message)) {
            active.principalSeen = true;
        }
        switch (active.phase) {
            case 'before':
                return message.action === 'page_snapshot' && active.snapshots === 1;
            case 'main':
                return isMainEvaluate(message) || (isMainInput(message) && message.params.type === 'keyDown');
            case 'global':
                return message.action === 'debugger_send' && message.params.params?.expression === 'globalThis';
            case 'event-find':
            case 'event-find-after-key':
                return message.action === 'find';
            case 'diagnostic-start':
                return message.action === 'console_enable';
            case 'diagnostic-end':
                return message.action === 'console_get' && active.consoleGets === 2;
            case 'after-list':
                return (
                    message.action === 'tabs_list' &&
                    active.principalSeen &&
                    !unified.tabLockContext.getStore()?.userAction
                );
            case 'after-snapshot':
                return message.action === 'page_snapshot' && active.snapshots === 3;
            default:
                return false;
        }
    }
    rpc.helloReceived = true;
    rpc.clientSocket = {
        readyState: 1,
        close() {},
        send(text) {
            const message = JSON.parse(text);
            const record = {
                ...message,
                case: active?.id,
                wall: Date.now(),
                at: performance.now(),
                afterBudgetReceipt: Boolean(active?.budgetReceipt),
            };
            result.requests.push(record);
            if (message.type === 'cancel') {
                return;
            }
            globalThis.queueMicrotask(() => {
                try {
                    const reply = { id: message.id, success: true, data: peerData(message) };
                    if (selected(message)) {
                        active.held = message;
                        active.heldReply = reply;
                        const pending = rpc.messageHandlers.get(message.id);
                        const timer = timers.get(pending.timeout);
                        assert.ok(timer, 'The production HttpServer timer must be observed');
                        timer.row = active;
                        timer.deadline = message.params.deadline;
                        return;
                    }
                    rpc.handleMessage(JSON.stringify(reply));
                } catch (error) {
                    result.peerErrors.push({ message, error: String(error) });
                    rpc.handleMessage(JSON.stringify({ id: message.id, success: false, error: String(error) }));
                }
            });
        },
    };
    bridge.setCurrentTargetId('101');
    unified.extensionBridge = bridge;
    unified.activeMode = 'extension';
    unified.cdpExplicitlySelected = false;
    unified.inputMode = 'precise';
    const originalSend = rpc.sendCommand.bind(rpc);
    rpc.sendCommand = async (...args) => {
        try {
            return await originalSend(...args);
        } catch (error) {
            result.errors.push({
                case: active?.id,
                action: args[0],
                name: error.name,
                code: error.code,
                message: error.message,
                source: getErrorSource(error),
                context: error.context,
                pageContextAtThrow: getErrorPageContext(error),
            });
            throw error;
        }
    };
    const server = new McpServer({ name: 'budget-adjacent-review', version: '1' });
    const originalRegister = server.registerTool.bind(server);
    server.registerTool = (name, schema, handler) =>
        originalRegister(name, schema, async (args, extra) => {
            ++result.handlerCalls;
            return handler(args, extra);
        });
    registerEvaluateTool(server);
    registerInputTool(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'budget-adjacent-review-client', version: '1' });
    const rows = [
        ['evaluate-before-minus1', 'evaluate', 'before', -1, false],
        ['evaluate-diagnostic-start-minus1', 'evaluate', 'diagnostic-start', -1, true],
        ['evaluate-main-minus1', 'evaluate', 'main', -1, false],
        ['evaluate-main-at-deadline', 'evaluate', 'main', 0, false],
        ['input-main-minus1', 'input', 'main', -1, false],
        ['input-main-at-deadline', 'input', 'main', 0, false],
        ['evaluate-global-minus1', 'evaluate', 'global', -1, false],
        ['input-event-find-minus1', 'input', 'event-find', -1, false],
        ['input-event-find-after-key-minus1', 'input', 'event-find-after-key', -1, false],
        ['input-event-find-after-key-at-deadline', 'input', 'event-find-after-key', 0, false],
        ['evaluate-main-diagnostics-minus1', 'evaluate', 'main', -1, true],
        ['evaluate-diagnostic-end-minus1', 'evaluate', 'diagnostic-end', -1, true],
        ['evaluate-after-list-minus1', 'evaluate', 'after-list', -1, false],
        ['evaluate-after-snapshot-minus1', 'evaluate', 'after-snapshot', -1, false],
    ];
    try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        for (const [id, operation, phase, delta, diagnostics] of rows) {
            active = {
                id,
                operation,
                phase,
                delta,
                diagnostics,
                snapshots: 0,
                lists: 0,
                consoleGets: 0,
                firstRequest: result.requests.length,
                started: performance.now(),
            };
            const row = active;
            try {
                const args = {
                    targetId: '101',
                    timeout: 300,
                    diagnostics,
                    expectedRevision: 'r101',
                    ...(operation === 'evaluate'
                        ? {
                              script: phase === 'global' ? functionScript : mainScript,
                              mode: 'precise',
                              ...(phase === 'global' ? { args: [1] } : {}),
                          }
                        : {
                              events:
                                  phase === 'event-find'
                                      ? [{ type: 'click', target: { css: '#owned-button' } }]
                                      : phase === 'event-find-after-key'
                                        ? [
                                              { type: 'keydown', key: 'Shift' },
                                              { type: 'click', target: { css: '#owned-button' } },
                                          ]
                                        : [
                                              { type: 'keydown', key: 'x' },
                                              { type: 'keyup', key: 'x' },
                                          ],
                          }),
                };
                row.input = { name: operation, arguments: args };
                ++result.sdkCalls;
                row.body = parse(await client.callTool(row.input));
                row.requests = result.requests.slice(row.firstRequest);
                row.readsAfterReceipt = row.requests.filter(
                    (q) =>
                        q.afterBudgetReceipt &&
                        ['tabs_list', 'page_snapshot', 'tabs_topology', 'console_get', 'network_get'].includes(q.action)
                );
                row.principalRequests = row.requests
                    .filter((q) => isMainEvaluate(q) || isMainInput(q))
                    .map((q) => ({ action: q.action, type: q.params?.type }));
                row.expected = { readsAfterBudgetReceipt: 0 };
                assert.ok(row.budgetReceipt, 'The genuine timer callback must have run');
                assert.equal(result.peerErrors.length, 0);
                if (['before', 'diagnostic-start', 'global', 'event-find'].includes(phase)) {
                    assert.equal(row.principalRequests.length, 0);
                    assert.equal(row.body.actionExecuted, false);
                    assert.equal(row.body.actionStatus, 'not_started');
                }
                if (phase === 'main') {
                    assert.equal(row.body.actionStatus, 'unknown');
                }
                if (phase === 'event-find-after-key') {
                    assert.equal(row.body.actionExecuted, true);
                    assert.equal(row.body.eventsExecuted, 1);
                }
                if (['diagnostic-end', 'after-list', 'after-snapshot'].includes(phase)) {
                    assert.equal(row.body.actionStatus, 'completed');
                }
                assert.equal(
                    row.readsAfterReceipt.length,
                    0,
                    'No diagnostics or page-context reads after the request budget receipt'
                );
                const cleanup = row.requests.filter((q) => q.afterBudgetReceipt && q.action === 'input_key');
                const heldKey = operation === 'input' && ['main', 'event-find-after-key'].includes(phase);
                assert.deepEqual(
                    cleanup.map((q) => ({ type: q.params.type, key: q.params.key })),
                    heldKey ? [{ type: 'keyUp', key: phase === 'main' ? 'x' : 'Shift' }] : []
                );
                for (const q of cleanup) {
                    assert.equal(q.params.deadline, row.budgetReceipt.now + 1000);
                }
                row.status = 'PASS';
            } catch (error) {
                row.status = 'FAIL';
                row.error = String(error);
                row.stack = error.stack;
            } finally {
                if (row.heldReply) {
                    rpc.handleMessage(JSON.stringify(row.heldReply));
                }
                await new Promise((resolve) => setImmediate(resolve));
                row.afterLateAck = {
                    pending: rpc.messageHandlers.size,
                    frame: bridge.getCurrentFrameId(),
                    target: bridge.getCurrentTargetId(),
                    keys: [...unified.pressedKeys],
                    modifiers: unified.modifiers,
                    condition: bridge.pendingPageCondition ?? null,
                };
                if (row.afterLateAck.pending || row.afterLateAck.keys.length) {
                    row.status = 'FAIL';
                    row.cleanupFailure = true;
                }
                if (row.afterLateAck.keys.length) {
                    row.reviewerFixtureReset = {
                        reason: 'Controlled peer has no real DOM/keyboard; clear retained production bookkeeping only after recording the failing state so later rows start independently.',
                        keys: [...unified.pressedKeys],
                        modifiers: unified.modifiers,
                    };
                    unified.pressedKeys.clear();
                    unified.modifiers = 0;
                }
                row.elapsedMs = performance.now() - row.started;
                delete row.controlledNow;
                result.checks.push(row);
                console.log(
                    row.id,
                    row.status,
                    row.body?.actionExecuted,
                    row.body?.actionStatus,
                    'readsAfterReceipt=' + row.readsAfterReceipt?.length,
                    row.error ?? ''
                );
                active = undefined;
                save();
            }
        }
        result.status = result.checks.every((row) => row.status === 'PASS') ? 'PASS' : 'FAIL';
    } catch (error) {
        result.status = 'HARNESS_FAILURE';
        result.error = String(error);
        result.stack = error.stack;
    } finally {
        Date.now = originalNow;
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
        result.cleanup = [];
        for (const [name, close] of [
            ['client', () => client.close()],
            ['server', () => server.close()],
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
            pass: result.checks.filter((row) => row.status === 'PASS').length,
            fail: result.checks.filter((row) => row.status === 'FAIL').length,
            sdkCalls: result.sdkCalls,
            registeredHandlerCalls: result.handlerCalls,
            nativeReferenceCalls: 0,
            chromeOrDomExecution: 0,
        };
        result.resources = {
            rpcPending: rpc.messageHandlers.size,
            keys: [...unified.pressedKeys],
            frame: bridge.getCurrentFrameId(),
            condition: bridge.pendingPageCondition ?? null,
            clientPending: client._responseHandlers?.size,
            serverPending: server.server?._responseHandlers?.size,
            observedTimers: timers.size,
        };
        save();
    }
    console.log(JSON.stringify({ status: result.status, counts: result.counts, resources: result.resources, output }));
    assert.equal(result.counts.checks, 14);
    assert.equal(result.status, 'PASS', 'SDK regression evidence: ' + output);
});
