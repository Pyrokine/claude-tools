import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getUnifiedSession } from '../dist/core/index.js';
import { writePrivateFile } from '../dist/core/utils.js';
import { ExtensionBridge } from '../dist/extension/bridge.js';
import { registerExtractTool } from '../dist/tools/extract.js';
import { registerManageTool } from '../dist/tools/manage.js';

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function until(read) {
    const deadline = Date.now() + 3000;
    while (!read()) {
        assert.ok(Date.now() < deadline, 'Protocol condition did not arrive');
        await tick();
    }
}

const management = [
    [{ action: 'groupPages', targetIds: ['101', '102'], title: 'Synthetic' }, 'tabgroup_create'],
    [{ action: 'ungroupPages', targetIds: ['101', '102'] }, 'tabgroup_remove'],
    [{ action: 'updateGroup', groupId: 17, title: 'Synthetic' }, 'tabgroup_update'],
    [{ action: 'moveGroup', groupId: 17, index: 0 }, 'tabgroup_move'],
    [{ action: 'updateWindow', windowId: 7, drawAttention: true }, 'window_update'],
    [{ action: 'closeWindow', windowId: 7 }, 'window_close'],
    [{ action: 'updatePage', targetId: '101', muted: true }, 'tabs_update'],
];

async function fixture(run) {
    const unified = getUnifiedSession();
    const directory = await mkdtemp(join(process.cwd(), '.c31f3-output-'));
    const bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() });
    bridge.currentTabId = 101;
    bridge.httpServer.helloReceived = true;
    const state = { requests: [], wire: [], metadata: [], hold: null, held: null };
    const page = {
        id: 101,
        targetId: '101',
        windowId: 7,
        url: 'https://example.com/synthetic',
        title: 'Synthetic',
        managed: true,
        revision: 'r1',
    };
    const reply = (message) => {
        let data;
        if (message.action === 'get_text') {
            data = { text: 'synthetic text' };
        } else if (message.action === 'get_html') {
            data = { html: '<main>synthetic html</main>' };
        } else if (message.action === 'get_html_with_images') {
            data = {
                html: '<main>synthetic images</main>',
                images: [0, 1, 2].map((index) => ({
                    index,
                    src: `data:image/png;base64,${Buffer.from(`synthetic-${index}`).toString('base64')}`,
                    width: 1,
                    height: 1,
                    alt: '',
                })),
            };
        } else if (message.action.startsWith('tabgroup_')) {
            data = { success: true, groupId: 17, before: [], after: [], tabsBefore: [], tabsAfter: [] };
        } else if (message.action.startsWith('window_')) {
            data = {
                success: true,
                windowId: 7,
                before: { id: 7, tabs: [page] },
                after: message.action === 'window_close' ? null : { id: 7, tabs: [page] },
            };
        } else if (message.action === 'tabs_update') {
            data = { success: true, targetId: '101', before: page, after: page };
        } else if (message.action === 'browser_events' || message.action === 'browser_events_raw') {
            data = { success: true, controlled: true };
        } else {
            assert.fail(`Unexpected command: ${message.action}`);
        }
        bridge.httpServer.handleMessage(JSON.stringify({ id: message.id, success: true, data }));
    };
    bridge.httpServer.clientSocket = {
        readyState: 1,
        close() {},
        send(text) {
            const message = JSON.parse(text);
            const scope = unified.tabLockContext.getStore();
            state.wire.push({ ...message, signal: scope?.signal, aborted: scope?.signal?.aborted === true });
            if (message.type === 'cancel') {
                return;
            }
            if (message.action === state.hold) {
                state.held = message;
            } else {
                globalThis.queueMicrotask(() => reply(message));
            }
        },
    };
    const overrides = {
        extensionBridge: bridge,
        activeMode: 'extension',
        cdpExplicitlySelected: false,
        getPageSnapshot: async () => {
            state.metadata.push(unified.tabLockContext.getStore()?.signal);
            return page;
        },
        listTargets: async () => {
            state.metadata.push(unified.tabLockContext.getStore()?.signal);
            return [page];
        },
        listTopology: async () => {
            state.metadata.push(unified.tabLockContext.getStore()?.signal);
            return { activeTargetId: '101' };
        },
    };
    const saved = new Map(Object.keys(overrides).map((key) => [key, Object.getOwnPropertyDescriptor(unified, key)]));
    Object.assign(unified, overrides);
    const server = new McpServer({ name: 'c31f3-protocol', version: '1.0.0' });
    const register = server.registerTool.bind(server);
    const direct = new Map();
    server.registerTool = (name, config, handler) => {
        direct.set(name, (args, signal) => handler(config.inputSchema.parse(args), { signal }));
        return register(name, config, async (args, extra) => {
            const record = {
                name,
                args,
                signal: extra.signal,
                id: extra.requestId,
                aborted: deferred(),
                done: deferred(),
            };
            state.requests.push(record);
            extra.signal.addEventListener('abort', record.aborted.resolve, { once: true });
            try {
                record.result = await handler(args, extra);
                return record.result;
            } finally {
                record.done.resolve();
            }
        });
    };
    registerExtractTool(server);
    registerManageTool(server);
    const client = new Client({ name: 'c31f3-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const responses = [];
    const send = serverTransport.send.bind(serverTransport);
    serverTransport.send = (message, ...args) => {
        responses.push(message);
        return send(message, ...args);
    };
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const start = async (name, args, signal) => {
        const index = state.requests.length;
        const response = client.callTool({ name, arguments: args }, undefined, signal ? { signal } : undefined);
        await until(() => state.requests.length > index);
        return { response, record: state.requests[index] };
    };
    const release = () => {
        const held = state.held;
        state.held = null;
        state.hold = null;
        if (held) {
            reply(held);
        }
    };
    const output = (name) => `cwd:${relative(process.cwd(), join(directory, name))}`;
    try {
        await run({ state, bridge, unified, client, direct, responses, start, release, directory, output });
    } finally {
        release();
        await client.close();
        await server.close();
        for (const [key, descriptor] of saved) {
            if (descriptor) {
                Object.defineProperty(unified, key, descriptor);
            } else {
                Reflect.deleteProperty(unified, key);
            }
        }
        await rm(directory, { recursive: true, force: true });
    }
}

for (const [args, action] of management) {
    test(
        `C31F3-02 actual SDK queued ${args.action} cancellation dispatches no late mutation`,
        { timeout: 10000 },
        async () => {
            await fixture(async ({ state, start, release, responses }) => {
                state.hold = 'get_text';
                const first = await start('extract', { type: 'text', timeout: 5000 });
                await until(() => state.held);
                const controller = new AbortController();
                const second = await start('manage', args, controller.signal);
                const rejected = assert.rejects(second.response);
                await tick();
                assert.equal(state.wire.filter((entry) => entry.action === action).length, 0);
                controller.abort('stop queued management');
                await second.record.aborted.promise;
                await second.record.done.promise;
                assert.equal(second.record.signal.aborted, true);
                release();
                await first.response;
                await rejected;
                assert.equal(state.wire.filter((entry) => entry.action === action).length, 0);
                assert.equal(responses.filter((entry) => entry.id === second.record.id).length, 0);
                const next = await start('extract', { type: 'text' });
                assert.equal((await next.response).isError, undefined);
            });
        }
    );
    test(`C31F3-02 normal SDK ${args.action} reaches its single mutation with the same signal`, async () => {
        await fixture(async ({ state, start }) => {
            const request = await start('manage', args);
            const result = await request.response;
            assert.equal(result.isError, undefined, JSON.stringify(result));
            const commands = state.wire.filter((entry) => entry.action === action);
            assert.equal(commands.length, 1);
            assert.equal(commands[0].signal, request.record.signal);
        });
    });
}

for (const stage of ['queued', 'inflight', 'pre-cancelled']) {
    test(`C31F3-03 ${stage} extract cancellation stops reading and real output`, { timeout: 10000 }, async () => {
        await fixture(async ({ state, start, direct, release, output, directory, responses }) => {
            const args = { type: 'html', timeout: 5000, output: output(`${stage}.html`) };
            const controller = new AbortController();
            if (stage === 'pre-cancelled') {
                controller.abort('cancel before extract');
                assert.equal((await direct.get('extract')(args, controller.signal)).isError, true);
            } else {
                let first;
                if (stage === 'queued') {
                    state.hold = 'get_text';
                    first = await start('extract', { type: 'text', timeout: 5000 });
                    await until(() => state.held);
                } else {
                    state.hold = 'get_html';
                }
                const request = await start('extract', args, controller.signal);
                const rejected = assert.rejects(request.response);
                if (stage === 'inflight') {
                    await until(() => state.held);
                }
                controller.abort('stop extract');
                await request.record.aborted.promise;
                await request.record.done.promise;
                const metadata = state.metadata.length;
                release();
                if (first) {
                    await first.response;
                }
                await rejected;
                await tick();
                if (stage === 'inflight') {
                    assert.equal(state.metadata.length, metadata);
                    assert.equal(state.wire.filter((entry) => entry.type === 'cancel').length, 1);
                }
                assert.equal(responses.filter((entry) => entry.id === request.record.id).length, 0);
            }
            assert.equal(
                state.wire.filter((entry) => entry.action === 'get_html').length,
                stage === 'inflight' ? 1 : 0
            );
            await assert.rejects(access(join(directory, `${stage}.html`)), { code: 'ENOENT' });
        });
    });
}

for (const stage of ['queued', 'inflight']) {
    test(`C31F3-03 ${stage} original deadline still cancels extract before output`, { timeout: 10000 }, async () => {
        await fixture(async ({ state, start, release, output, directory }) => {
            let first;
            state.hold = stage === 'queued' ? 'get_text' : 'get_html';
            if (stage === 'queued') {
                first = await start('extract', { type: 'text', timeout: 5000 });
                await until(() => state.held);
            }
            const request = await start('extract', { type: 'html', timeout: 40, output: output('timeout.html') });
            assert.equal((await request.response).isError, true);
            assert.equal(
                state.wire.filter((entry) => entry.action === 'get_html').length,
                stage === 'inflight' ? 1 : 0
            );
            release();
            if (first) {
                await first.response;
            }
            await tick();
            await assert.rejects(access(join(directory, 'timeout.html')), { code: 'ENOENT' });
        });
    });
}

test('C31F3-03 normal SDK HTML and image-directory exports preserve actual output', async () => {
    await fixture(async ({ start, output, directory }) => {
        const html = await start('extract', { type: 'html', output: output('normal.html') });
        assert.equal((await html.response).isError, undefined);
        assert.equal(await readFile(join(directory, 'normal.html'), 'utf8'), '<main>synthetic html</main>');
        const images = await start('extract', { type: 'html', images: 'data', output: output('images') });
        assert.equal((await images.response).isError, undefined);
        const index = JSON.parse(await readFile(join(directory, 'images/index.json'), 'utf8'));
        assert.equal(index.images.length, 3);
        assert.equal((await readdir(join(directory, 'images/images'))).length, 3);
    });
});

test(
    'C31F3-02 event and paused Fetch controls remain usable while an extract owns the page lock',
    { timeout: 10000 },
    async () => {
        await fixture(async ({ state, start, release }) => {
            state.hold = 'get_text';
            const first = await start('extract', { type: 'text', timeout: 5000 });
            await until(() => state.held);
            for (const args of [
                { action: 'dialog', targetId: '101', dialog: { op: 'watch' } },
                { action: 'route', targetId: '101', route: { op: 'add', urlPattern: 'https://example.com/*' } },
                {
                    action: 'cdp',
                    targetId: '101',
                    cdpMethod: 'Fetch.continueRequest',
                    cdpParams: { requestId: 'synthetic-owned' },
                },
            ]) {
                const request = await start('manage', args);
                assert.equal((await request.response).isError, undefined);
                assert.ok(state.held);
            }
            release();
            await first.response;
        });
    }
);

for (const stopAt of [1, 2, 3, 4, 5]) {
    test(`C31F3-03 private output guard ${stopAt} stops before final publication and cleans temporary files`, async () => {
        const directory = await mkdtemp(join(process.cwd(), '.c31f3-file-'));
        let checks = 0;
        try {
            await assert.rejects(
                writePrivateFile(join(directory, 'output.html'), 'synthetic', 'utf8', () => {
                    if (++checks === stopAt) {
                        throw new Error('synthetic cancellation');
                    }
                }),
                /synthetic cancellation/
            );
            assert.deepEqual(await readdir(directory), []);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
}
