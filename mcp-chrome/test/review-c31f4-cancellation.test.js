import assert from 'node:assert/strict';
import nodeTest, { after } from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getUnifiedSession } from '../dist/core/index.js';
import { ExtensionBridge } from '../dist/extension/bridge.js';
import { registerCookiesTool } from '../dist/tools/cookies.js';
import { registerEvaluateTool } from '../dist/tools/evaluate.js';
import { registerExtractTool } from '../dist/tools/extract.js';
import { registerLogsTool } from '../dist/tools/logs.js';
import { registerManageTool } from '../dist/tools/manage.js';

const test = (name, action) => nodeTest(name, { timeout: 10000 }, action);
const bundle = await fs.mkdtemp(join(tmpdir(), 'mcp-c31f4-boundary-'));
const { build } = await import('../extension/node_modules/vite/dist/node/index.js');
await build({
    configFile: false,
    logLevel: 'silent',
    build: {
        outDir: bundle,
        minify: false,
        lib: {
            entry: fileURLToPath(new URL('./review-c31f4-extension.ts', import.meta.url)),
            formats: ['es'],
            fileName: () => 'boundary.mjs',
        },
    },
});
const extension = await import(pathToFileURL(join(bundle, 'boundary.mjs')));
const totals = {
    sdkCalls: 0,
    cancelledResponsesSuppressed: 0,
    extensionCancels: 0,
    nativeStorageCommits: 0,
    fileRenames: 0,
};
after(async () => {
    await fs.rm(bundle, { recursive: true, force: true });
    console.log('C31F4 actual SDK/production HttpClient/local filesystem totals:', JSON.stringify(totals));
});

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
async function until(read) {
    const deadline = Date.now() + 5000;
    while (!read()) {
        assert.ok(Date.now() < deadline, 'Production protocol condition did not arrive');
        await tick();
    }
}

async function enterGate(blocked, record) {
    await Promise.race([
        blocked.entered.promise,
        record.done.promise.then(() =>
            assert.fail(`Request finished before ${blocked.kind}: ${JSON.stringify(record.result)}`)
        ),
    ]);
}

async function fixture(run, { managed = true, grant = false } = {}) {
    const unified = getUnifiedSession();
    const directory = await fs.mkdtemp(join(process.cwd(), '.c31f4-'));
    const previousChrome = globalThis.chrome;
    const previousWebSocket = globalThis.WebSocket;
    const values = { local: {}, session: {} };
    const state = {
        requests: [],
        extensions: [],
        wire: [],
        writes: [],
        files: [],
        renames: [],
        holds: [],
        held: null,
        evaluation: { synthetic: 'evaluation' },
    };
    const own = () => unified.tabLockContext.getStore()?.signal;
    const wait = async (kind, value) => {
        const hold = state.held;
        if (hold?.kind === kind && --hold.after === 0) {
            state.held = null;
            hold.entered.resolve();
            await hold.release.promise;
        }
        return value;
    };
    const hold = (kind, after = 1) => {
        assert.equal(state.held, null);
        const next = { kind, after, entered: deferred(), release: deferred() };
        state.held = next;
        state.holds.push(next);
        return next;
    };
    const tabs = [101, 102].map((id, index) => ({
        id,
        index,
        windowId: 7,
        groupId: -1,
        url: 'https://example.test/synthetic',
        title: 'Synthetic',
        active: false,
        status: 'complete',
    }));
    const store = (area) => ({
        get: async (keys) => {
            const selected =
                keys === null
                    ? values[area]
                    : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[area][key]]));
            return wait(`${area}-get`, globalThis.structuredClone(selected));
        },
        set: async (update) => {
            const signal = own();
            state.writes.push({
                area,
                update: globalThis.structuredClone(update),
                signal,
                aborted: signal?.aborted === true,
            });
            ++totals.nativeStorageCommits;
            Object.assign(values[area], globalThis.structuredClone(update));
            await wait(`${area}-set`, undefined);
        },
        remove: async (key) => {
            delete values[area][key];
        },
    });
    const event = { addListener() {}, removeListener() {} };
    globalThis.chrome = {
        storage: { local: store('local'), session: store('session') },
        tabs: {
            get: async (id) => wait('tab-get', { ...tabs.find((tab) => tab.id === id) }),
            query: async () =>
                wait(
                    'tab-query',
                    tabs.map((tab) => ({ ...tab }))
                ),
            create: async (props) => {
                const tab = { ...tabs[0], ...props, id: 103 };
                tabs.push(tab);
                return wait('tab-create', { ...tab });
            },
            remove: async () => wait('tab-remove', undefined),
            onRemoved: event,
        },
        windows: {
            get: async (id) => ({ id, type: 'normal', tabs: tabs.filter((tab) => tab.windowId === id) }),
            create: async (props) => {
                const tab = { ...tabs[0], id: 103, windowId: 8 };
                tabs.push(tab);
                return wait('window-create', { id: 8, type: 'normal', ...props, tabs: [{ ...tab }] });
            },
            remove: async () => wait('window-remove', undefined),
        },
        webNavigation: {
            getFrame: async () => wait('frame', { frameId: 0, documentId: 'synthetic-document', url: tabs[0].url }),
        },
        debugger: { onDetach: event, onEvent: event },
        scripting: { executeScript: async () => [{ result: { messages: [], uninstalled: true } }] },
    };
    globalThis.WebSocket = { OPEN: 1 };
    await extension.restoreManagedTabs();
    for (const tab of tabs) {
        await extension.unmarkManagedTab(tab.id);
    }
    if (managed) {
        await extension.markManagedTab(101);
    }
    const instanceId = 'c31f4-synthetic-instance';
    if (grant) {
        await extension.setReadGrant(instanceId, 101, true);
    }
    state.writes.length = 0;
    const actions = new extension.ActionHandler();
    const http = new extension.HttpClient();
    const bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() });
    bridge.currentTabId = 101;
    bridge.httpServer.helloReceived = true;
    const connection = {
        ws: { readyState: 1, send: (text) => bridge.httpServer.handleMessage(text), close() {} },
        requests: new Map(),
        sendChain: Promise.resolve(),
        receiveChain: Promise.resolve(),
        sent: 0,
        received: 0,
        instanceId,
    };
    http.connections.set(19222, connection);
    http.onMessage(async (message, _port, signal, reply) => {
        const record = { message, signal, serverSignal: own(), done: deferred() };
        state.extensions.push(record);
        try {
            let data;
            if (
                [
                    'tabs_adopt',
                    'tabs_release',
                    'tabs_metadata',
                    'tabs_read_access',
                    'tabs_create',
                    'window_create',
                    'tabs_close',
                    'window_close',
                ].includes(message.action)
            ) {
                data = await actions.execute(message.action, message.params, {
                    serverInstanceId: instanceId,
                    signal,
                    mcpTabGroupId: null,
                    mcpWindowId: null,
                });
            } else if (message.action === 'tabs_list') {
                data = tabs.map((tab) => ({ ...tab, managed: extension.isManagedTab(tab) }));
            } else if (message.action === 'cookies_get') {
                data = [{ name: 'mcp_synthetic', value: 'synthetic', domain: 'example.test', path: '/' }];
            } else if (message.action === 'console_enable' || message.action === 'network_enable') {
                data = { success: true };
            } else if (message.action === 'console_get') {
                data = { messages: [{ level: 'info', text: 'synthetic log' }] };
            } else if (message.action === 'network_get') {
                data = {
                    requests: [{ url: 'https://example.test/synthetic', method: 'GET', type: 'fetch', timestamp: 1 }],
                };
            } else if (message.action === 'evaluate') {
                data = { success: true, result: JSON.stringify(state.evaluation) };
            } else if (message.action === 'get_html') {
                data = { html: '<main>synthetic</main>' };
            } else if (message.action === 'get_text') {
                if (state.nativeRead) {
                    data = await actions.execute(message.action, message.params, {
                        serverInstanceId: instanceId,
                        signal,
                        mcpTabGroupId: null,
                        mcpWindowId: null,
                    });
                } else {
                    await wait('get-text', undefined);
                    data = { text: 'synthetic' };
                }
            } else if (message.action === 'browser_events') {
                data = { logs: [], dropped: 0, payload: { encoding: 'utf8', data: 'synthetic event bytes' } };
            } else {
                assert.fail(`Unexpected production driver command: ${message.action}`);
            }
            reply(true, data);
        } catch (error) {
            record.error = error;
            reply(false, undefined, error.message);
        } finally {
            record.done.resolve();
        }
    });
    bridge.httpServer.clientSocket = {
        readyState: 1,
        close() {},
        send(text) {
            const message = JSON.parse(text);
            state.wire.push(message);
            http.handleMessage(text, 19222, connection);
            if (message.type === 'cancel') {
                ++totals.extensionCancels;
            }
        },
    };
    const page = () => ({
        ...tabs[0],
        targetId: '101',
        revision: 'synthetic-r1',
        managed: extension.isManagedTab(tabs[0]),
    });
    const overrides = {
        extensionBridge: bridge,
        activeMode: 'extension',
        cdpExplicitlySelected: false,
        getPageSnapshot: async () => page(),
        listTargets: async () => [page()],
        listTopology: async () => ({ activeTargetId: '101' }),
        hasBrowserEventObservation: () => false,
        getChallengeState: async () => null,
        getState: () => ({ title: 'Synthetic', url: tabs[0].url }),
        getLiveState: async () => ({ title: 'Synthetic', url: tabs[0].url }),
        inspectChallenge: async () => ({
            inspected: true,
            title: 'Synthetic',
            url: tabs[0].url,
            selectorHits: [],
            deniedHits: [],
            textHits: [],
            originResponsePending: false,
            turnstilePresent: false,
            clickPoint: null,
            clickTargetKind: null,
        }),
    };
    const saved = new Map(Object.keys(overrides).map((key) => [key, Object.getOwnPropertyDescriptor(unified, key)]));
    Object.assign(unified, overrides);
    const server = new McpServer({ name: 'c31f4-boundary', version: '1.0.0' });
    const register = server.registerTool.bind(server);
    server.registerTool = (name, config, handler) =>
        register(name, config, async (args, extra) => {
            const record = { name, args, signal: extra.signal, id: extra.requestId, done: deferred() };
            state.requests.push(record);
            try {
                record.result = await handler(args, extra);
                return record.result;
            } finally {
                record.done.resolve();
            }
        });
    for (const registration of [
        registerCookiesTool,
        registerEvaluateTool,
        registerExtractTool,
        registerLogsTool,
        registerManageTool,
    ]) {
        registration(server);
    }
    const client = new Client({ name: 'c31f4-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const clientSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, ...args) => {
        if (message.method === 'tools/call') {
            ++totals.sdkCalls;
        }
        return clientSend(message, ...args);
    };
    const replies = [];
    const serverSend = serverTransport.send.bind(serverTransport);
    serverTransport.send = (message, ...args) => {
        replies.push(message);
        return serverSend(message, ...args);
    };
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const originals = { open: fs.open, rename: fs.rename };
    fs.open = async (...args) => {
        const handle = await originals.open(...args);
        if (args[1] !== 'wx' || !String(args[0]).includes('.tmp-')) {
            return handle;
        }
        const filename = String(args[0]);
        state.files.push(filename);
        const write = handle.writeFile.bind(handle);
        const close = handle.close.bind(handle);
        handle.writeFile = async (...params) => {
            const result = await write(...params);
            await wait('file-written', undefined);
            return result;
        };
        handle.close = async () => {
            const result = await close();
            await wait('file-closed', undefined);
            return result;
        };
        await wait(filename.includes('_manifest.json.tmp-') ? 'manifest-open' : 'file-open', undefined);
        return handle;
    };
    fs.rename = async (...args) => {
        state.renames.push({ from: String(args[0]), to: String(args[1]), aborted: own()?.aborted === true });
        const result = await originals.rename(...args);
        ++totals.fileRenames;
        await wait('file-renamed', undefined);
        return result;
    };
    syncBuiltinESMExports();
    const start = async (name, args, signal) => {
        const index = state.requests.length;
        const response = client.callTool({ name, arguments: args }, undefined, signal ? { signal } : undefined);
        response.catch(() => {});
        await until(() => state.requests.length > index);
        return { response, record: state.requests[index] };
    };
    const output = (name) => `cwd:${relative(process.cwd(), join(directory, name))}`;
    try {
        await run({
            state,
            actions,
            context: { serverInstanceId: instanceId, mcpTabGroupId: null, mcpWindowId: null },
            start,
            hold,
            values,
            bridge,
            unified,
            directory,
            output,
            replies,
            tabs,
        });
    } finally {
        for (const blocked of state.holds) {
            blocked.release.resolve();
        }
        fs.open = originals.open;
        fs.rename = originals.rename;
        syncBuiltinESMExports();
        await client.close();
        await server.close();
        globalThis.clearInterval(actions.logManager.sweepTimer);
        for (const tab of tabs) {
            await extension.unmarkManagedTab(tab.id);
        }
        for (const [key, descriptor] of saved) {
            if (descriptor) {
                Object.defineProperty(unified, key, descriptor);
            } else {
                Reflect.deleteProperty(unified, key);
            }
        }
        for (const entry of state.renames) {
            await fs.rm(entry.to, { force: true });
        }
        await fs.rm(directory, { recursive: true, force: true });
        globalThis.chrome = previousChrome;
        globalThis.WebSocket = previousWebSocket;
    }
}

const authority = [
    ['adoptPage', {}, 'frame', false, false],
    ['pageMetadata', { note: 'new synthetic note' }, 'frame', false, false],
    ['grantReadAccess', {}, 'frame', false, false],
    ['revokeReadAccess', {}, 'session-get', false, true],
    ['releasePage', {}, 'local-set', true, false],
];
for (const [action, fields, read, managed, grant] of authority) {
    if (action !== 'releasePage') {
        test(`C31F4-01 actual SDK ${action} stops its first storage commit after both ends process cancellation`, async () => {
            await fixture(
                async ({ state, start, hold, values, replies }) => {
                    const before = globalThis.structuredClone(values);
                    const blocked = hold(read);
                    const controller = new AbortController();
                    const request = await start('manage', { action, targetId: '101', ...fields }, controller.signal);
                    const rejected = assert.rejects(request.response);
                    await blocked.entered.promise;
                    assert.equal(state.writes.length, 0);
                    controller.abort('stop before first storage commit');
                    await until(
                        () => request.record.signal.aborted && state.extensions.some((entry) => entry.signal.aborted)
                    );
                    blocked.release.resolve();
                    await Promise.all(state.extensions.map((entry) => entry.done.promise));
                    await request.record.done.promise;
                    await rejected;
                    assert.deepEqual(state.writes, []);
                    assert.deepEqual(values, before);
                    assert.equal(replies.filter((entry) => entry.id === request.record.id).length, 0);
                    ++totals.cancelledResponsesSuppressed;
                },
                { managed, grant }
            );
        });
    }
    test(`C31F4-01 normal actual SDK ${action} completes one storage update`, async () => {
        await fixture(
            async ({ state, start }) => {
                const request = await start('manage', { action, targetId: '101', ...fields });
                const response = await request.response;
                assert.notEqual(response.isError, true, response.content[0].text);
                assert.equal(state.writes.length, 1);
                assert.equal(state.writes[0].aborted, false);
            },
            { managed, grant }
        );
    });
}

for (const [action, previous, area] of [
    ['adoptPage', () => extension.markManagedTab(102), 'local'],
    ['releasePage', () => extension.markManagedTab(102), 'local'],
    ['grantReadAccess', () => extension.setReadGrant('c31f4-synthetic-instance', 102, true), 'session'],
    ['revokeReadAccess', () => extension.setReadGrant('c31f4-synthetic-instance', 102, true), 'session'],
]) {
    test(`C31F4-01 actual SDK ${action} cancelled inside the ${area} update queue never commits later`, async () => {
        await fixture(
            async ({ state, start, hold, replies }) => {
                const blocked = hold(`${area}-set`);
                const prior = previous();
                await blocked.entered.promise;
                const controller = new AbortController();
                const request = await start('manage', { action, targetId: '101' }, controller.signal);
                const rejected = assert.rejects(request.response);
                await until(() => state.extensions.length > 0);
                await tick();
                controller.abort('stop queued storage update');
                await until(() => request.record.signal.aborted && state.extensions[0].signal.aborted);
                blocked.release.resolve();
                await prior;
                await state.extensions[0].done.promise;
                await request.record.done.promise;
                await rejected;
                assert.equal(state.writes.filter((entry) => entry.signal === request.record.signal).length, 0);
                assert.equal(replies.filter((entry) => entry.id === request.record.id).length, 0);
                ++totals.cancelledResponsesSuppressed;
            },
            { managed: action === 'releasePage', grant: action === 'revokeReadAccess' }
        );
    });
}

for (const action of ['adoptPage', 'releasePage', 'grantReadAccess', 'pageMetadata']) {
    test(`C31F4-01 actual SDK ${action} keeps persisted and in-memory state consistent after a dispatched set`, async () => {
        await fixture(
            async ({ start, hold, state, values }) => {
                if (action === 'grantReadAccess') {
                    await extension.revokeReadGrants('c31f4-synthetic-instance');
                }
                const blocked = hold(action === 'grantReadAccess' ? 'session-set' : 'local-set');
                const controller = new AbortController();
                const request = await start(
                    'manage',
                    { action, targetId: '101', ...(action === 'pageMetadata' ? { note: 'committed note' } : {}) },
                    controller.signal
                );
                const rejected = assert.rejects(request.response);
                await blocked.entered.promise;
                assert.equal(state.writes.length, 1);
                controller.abort('stop after storage commit dispatch');
                await until(() => request.record.signal.aborted && state.extensions[0].signal.aborted);
                blocked.release.resolve();
                await state.extensions[0].done.promise;
                await request.record.done.promise;
                await rejected;
                if (action === 'grantReadAccess') {
                    assert.equal(await extension.hasReadGrant('c31f4-synthetic-instance', 101), true);
                } else {
                    const persisted = values.local.mcp_managed_tabs_v1.tabs.find((entry) => entry.tabId === 101);
                    assert.deepEqual(extension.getManagedTabRecord(101), persisted);
                    if (action === 'pageMetadata') {
                        assert.equal(persisted.metadata.note, 'committed note');
                    }
                }
            },
            { managed: action === 'releasePage' }
        );
    });
}

for (const action of ['tabs_adopt', 'tabs_metadata', 'tabs_read_access']) {
    test(`C31F4-01 production ${action} deadline expires during identity read before set`, async () => {
        await fixture(
            async ({ state, actions, context, hold, values }) => {
                const before = globalThis.structuredClone(values);
                const blocked = hold('frame');
                const deadline = Date.now() + 30;
                const operation = actions.execute(action, { tabId: 101, allow: true, note: 'late', deadline }, context);
                const rejected = assert.rejects(
                    operation,
                    (error) => JSON.parse(error.message).error.code === 'TIMEOUT'
                );
                await blocked.entered.promise;
                await delay(Math.max(0, deadline - Date.now()) + 1);
                blocked.release.resolve();
                await rejected;
                assert.equal(state.writes.length, 0);
                assert.deepEqual(values, before);
            },
            { managed: false }
        );
    });
}

test('C31F4-01 actual SDK ordinary read stops a cross-generation grant refresh before its session set', async () => {
    await fixture(
        async ({ state, start, hold, values, replies }) => {
            const key = 'mcp_read_grants_v4_c31f4-synthetic-instance';
            values.session[key][0].revision = 'previous-browser-generation:0';
            const before = globalThis.structuredClone(values);
            state.nativeRead = true;
            const blocked = hold('frame', 2);
            const controller = new AbortController();
            const request = await start('extract', { type: 'text', targetId: '101', timeout: 5000 }, controller.signal);
            const rejected = assert.rejects(request.response);
            await enterGate(blocked, request.record);
            controller.abort('stop grant refresh before commit');
            await until(() => request.record.signal.aborted && state.extensions.some((entry) => entry.signal.aborted));
            blocked.release.resolve();
            await Promise.all(state.extensions.map((entry) => entry.done.promise));
            await request.record.done.promise;
            await rejected;
            assert.deepEqual(state.writes, []);
            assert.deepEqual(values, before);
            assert.equal(replies.filter((entry) => entry.id === request.record.id).length, 0);
            ++totals.cancelledResponsesSuppressed;
        },
        { managed: false, grant: true }
    );
});

for (const [action, fields, phase] of [
    ['newPage', { windowId: 7, groupId: -1, url: 'https://example.test/synthetic' }, 'tab-create'],
    ['newWindow', { url: 'https://example.test/synthetic' }, 'window-create'],
    ['closePage', { targetId: '101' }, 'tab-remove'],
    ['closeWindow', { windowId: 7 }, 'window-remove'],
]) {
    test(`C31F4-01 actual SDK ${action} completes required resource bookkeeping after native dispatch cancellation`, async () => {
        await fixture(async ({ state, start, hold, replies }) => {
            if (action === 'closeWindow') {
                await extension.markManagedTab(102);
            }
            state.writes.length = 0;
            const blocked = hold(phase);
            const controller = new AbortController();
            const request = await start('manage', { action, ...fields }, controller.signal);
            const rejected = assert.rejects(request.response);
            await enterGate(blocked, request.record);
            controller.abort('stop after native resource change');
            await until(() => request.record.signal.aborted && state.extensions.some((entry) => entry.signal.aborted));
            blocked.release.resolve();
            await Promise.all(state.extensions.map((entry) => entry.done.promise));
            await request.record.done.promise;
            await rejected;
            if (action === 'newPage' || action === 'newWindow') {
                assert.equal(extension.getManagedTabRecord(103).managed, true);
                assert.equal(extension.getManagedTabRecord(103).origin, 'created');
            } else {
                assert.equal(extension.getManagedTabRecord(101), undefined);
                if (action === 'closeWindow') {
                    assert.equal(extension.getManagedTabRecord(102), undefined);
                }
            }
            assert.ok(state.writes.length > 0);
            assert.equal(replies.filter((entry) => entry.id === request.record.id).length, 0);
            ++totals.cancelledResponsesSuppressed;
        });
    });
}

const exports = [
    ['cookies', (output) => ({ action: 'get', domain: 'example.test', output })],
    ['logs', (output) => ({ type: 'console', targetId: '101', output })],
    ['logs', (output) => ({ type: 'network', targetId: '101', output })],
    ['logs', (output) => ({ type: 'dialog', targetId: '101', output })],
    [
        'manage',
        (output) => ({
            action: 'download',
            targetId: '101',
            download: { op: 'save', ref: 'be:extension:101:synthetic:download:1:1', output },
        }),
    ],
    [
        'evaluate',
        (output) => ({ script: '({synthetic:"evaluation"})', mode: 'stealth', timeout: 5000, targetId: '101', output }),
    ],
    ['evaluate', () => ({ script: '"synthetic large value"', mode: 'stealth', timeout: 5000, targetId: '101' })],
    ['extract', (output) => ({ type: 'html', timeout: 5000, targetId: '101', output })],
];
for (const [index, [name, args]] of exports.entries()) {
    for (const phase of ['file-open', 'file-written', 'file-closed']) {
        test(`C31F4-02 actual SDK output ${index}/${name} cancelled at ${phase} publishes no file`, async () => {
            await fixture(async ({ state, start, hold, output, directory, replies }) => {
                if (index === 6) {
                    state.evaluation = 'synthetic'.repeat(15000);
                }
                const destination = join(directory, 'output.json');
                if (index !== 6) {
                    await fs.writeFile(destination, 'original synthetic file');
                }
                const blocked = hold(phase);
                const controller = new AbortController();
                const request = await start(name, args(output('output.json')), controller.signal);
                const rejected = assert.rejects(request.response);
                await enterGate(blocked, request.record);
                assert.equal(state.renames.length, 0);
                controller.abort('stop unpublished file');
                await until(() => request.record.signal.aborted);
                blocked.release.resolve();
                await request.record.done.promise;
                await rejected;
                assert.equal(state.renames.length, 0);
                if (index !== 6) {
                    assert.equal(await fs.readFile(destination, 'utf8'), 'original synthetic file');
                }
                for (const temporary of state.files) {
                    await assert.rejects(fs.access(temporary), { code: 'ENOENT' });
                }
                assert.equal(replies.filter((entry) => entry.id === request.record.id).length, 0);
                if (name === 'evaluate') {
                    const payload = JSON.parse(request.record.result.content[0].text);
                    assert.equal(payload.actionExecuted, true);
                    assert.equal(payload.actionStatus, 'completed');
                    assert.equal(payload.failureStage, 'output');
                }
                ++totals.cancelledResponsesSuppressed;
            });
        });
    }
    test(`C31F4-02 normal actual SDK output ${index}/${name} publishes expected bytes`, async () => {
        await fixture(async ({ state, start, output, directory }) => {
            if (index === 6) {
                state.evaluation = 'synthetic'.repeat(15000);
            }
            const request = await start(name, args(output('output.json')));
            const response = await request.response;
            assert.notEqual(response.isError, true, response.content[0].text);
            const payload = JSON.parse(response.content[0].text);
            const contents = await fs.readFile(payload.path ?? join(directory, 'output.json'), 'utf8');
            assert.ok(contents.includes('synthetic'));
            assert.ok(state.renames.length > 0);
            assert.ok(state.renames.every((entry) => !entry.aborted));
        });
    });
}

for (const phase of ['file-renamed', 'manifest-open']) {
    test(`C31F4-02 log cancellation at ${phase} preserves the published subject and stops its manifest`, async () => {
        await fixture(async ({ state, start, hold, output, directory }) => {
            const blocked = hold(phase);
            const controller = new AbortController();
            const request = await start(
                'logs',
                { type: 'console', targetId: '101', output: output('output.json') },
                controller.signal
            );
            const rejected = assert.rejects(request.response);
            await enterGate(blocked, request.record);
            assert.match(await fs.readFile(join(directory, 'output.json'), 'utf8'), /synthetic log/);
            controller.abort('stop later manifest');
            await until(() => request.record.signal.aborted);
            blocked.release.resolve();
            await request.record.done.promise;
            await rejected;
            assert.equal(state.renames.length, 1);
            await assert.rejects(fs.access(join(directory, 'output_manifest.json')), { code: 'ENOENT' });
            for (const temporary of state.files) {
                await assert.rejects(fs.access(temporary), { code: 'ENOENT' });
            }
        });
    });
}

test('C31F4-02 actual SDK evaluate timeout after script completion stops unpublished output', async () => {
    await fixture(async ({ state, start, hold, output, directory }) => {
        const blocked = hold('file-open');
        const request = await start('evaluate', {
            script: '1',
            mode: 'stealth',
            targetId: '101',
            timeout: 80,
            output: output('timeout.json'),
        });
        await enterGate(blocked, request.record);
        await delay(90);
        blocked.release.resolve();
        const response = await request.response;
        const payload = JSON.parse(response.content[0].text);
        assert.equal(response.isError, true);
        assert.equal(payload.actionStatus, 'completed');
        assert.equal(payload.actionExecuted, true);
        assert.equal(payload.failureStage, 'output');
        assert.equal(state.renames.length, 0);
        await assert.rejects(fs.access(join(directory, 'timeout.json')), { code: 'ENOENT' });
    });
});

test('C31F4-02 event output stays independent of a held ordinary page request and retains cancellation', async () => {
    await fixture(async ({ state, start, hold, output }) => {
        const pageHeld = hold('get-text');
        const first = await start('extract', { type: 'text', targetId: '101', timeout: 5000 });
        await pageHeld.entered.promise;
        const fileHeld = hold('file-open');
        const controller = new AbortController();
        const event = await start(
            'logs',
            { type: 'dialog', targetId: '101', output: output('event.json') },
            controller.signal
        );
        const rejected = assert.rejects(event.response);
        await enterGate(fileHeld, event.record);
        assert.equal(first.record.result, undefined);
        controller.abort('stop independent event output');
        await until(() => event.record.signal.aborted);
        fileHeld.release.resolve();
        await event.record.done.promise;
        await rejected;
        assert.equal(state.renames.length, 0);
        pageHeld.release.resolve();
        assert.notEqual((await first.response).isError, true);
    });
});
