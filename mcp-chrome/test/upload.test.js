import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises, { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { File } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

// Node 20.19 ESM 支持顶层 await；被测模块导入前设置隔离 HOME
// noinspection ES6TopLevelAwaitExpression
const home = await mkdtemp(join(tmpdir(), 'mcp-upload-unit-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
// noinspection ES6TopLevelAwaitExpression
const { registerInputTool } = await import('../dist/tools/input.js');
// noinspection ES6TopLevelAwaitExpression
const { prepareUploadFiles, uploadInPage } = await import('../dist/core/file-upload.js');
// noinspection ES6TopLevelAwaitExpression
const { getSession, getUnifiedSession } = await import('../dist/core/index.js');
// noinspection ES6TopLevelAwaitExpression
const { StructuredToolError, TimeoutError } = await import('../dist/core/errors.js');
// noinspection ES6TopLevelAwaitExpression
const { CDPClient } = await import('../dist/cdp/client.js');
// noinspection ES6TopLevelAwaitExpression
const { WebSocketServer } = await import('ws');
after(() => rm(home, { recursive: true, force: true }));
const file = join(home, '附件.txt');
const binary = join(home, 'payload.unknown-extension');
const bytes = Buffer.from([0, 255, 1, 13, 10, 128]);
// 测试开始前准备合成文件
// noinspection ES6TopLevelAwaitExpression
await writeFile(file, '中文内容\n');
// noinspection ES6TopLevelAwaitExpression
await writeFile(binary, bytes);

function realm() {
    const document = {};
    class Element {
        isConnected = true;
        ownerDocument = document;
    }
    class HTMLInputElement extends Element {
        type = 'file';
        multiple = false;
        webkitdirectory = false;
        assignments = 0;
        events = [];
        selected = [];
        get files() {
            return this.selected;
        }

        set files(value) {
            this.assignments++;
            this.selected = value;
        }

        dispatchEvent(event) {
            this.events.push({ type: event.type, bubbles: event.bubbles, composed: event.composed });
            if (event.type === 'change' && this.clearOnChange) {
                this.selected = [];
            }
            return true;
        }
    }
    class HTMLLabelElement extends Element {}
    class DataTransfer {
        files = [];
        items = { add: (item) => this.files.push(item) };
    }
    const input = new HTMLInputElement();
    const context = createContext({
        document,
        HTMLInputElement,
        HTMLLabelElement,
        DataTransfer,
        Element,
        File,
        Event: globalThis.Event,
        atob: globalThis.atob,
        WeakRef,
        setTimeout: (callback, delay) => setTimeout(callback, delay).unref(),
        clearTimeout,
    });
    context.__mcpElementMap = { ref1: new WeakRef(input) };
    return { context, input, HTMLInputElement, HTMLLabelElement };
}

function patch(object, values) {
    const before = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(object, key)]));
    Object.assign(object, values);
    return () => {
        for (const [key, descriptor] of before) {
            if (descriptor) {
                Object.defineProperty(object, key, descriptor);
            } else {
                delete object[key];
            }
        }
    };
}

async function withInput(options, run) {
    const page = realm();
    if (options.setup) {
        options.setup(page);
    }
    const calls = [];
    const releases = [];
    const execute = async (code, _mode, _timeout, args, execution = {}) => {
        calls.push({ operation: args?.[0], mode: _mode, args });
        if (!args) {
            return { title: 'Upload', inspected: true };
        }
        if (options.denied && args[0] === 'prepare') {
            throw new StructuredToolError('PAGE_NOT_MANAGED', 'Read grant does not allow evaluate', 'Adopt this page', {
                actionExecuted: false,
            });
        }
        if (options.csp && args[0] === 'prepare') {
            throw new Error('Content Security Policy blocks eval');
        }
        if (options.beforeDispatchError && args[0] === 'commit') {
            throw new TimeoutError('CDP timeout before dispatch', { actionExecuted: false });
        }
        if (execution.userAction === 'input') {
            getUnifiedSession().tabLockContext.getStore().userAction.dispatched = true;
        }
        page.context.__args = args;
        page.context.__target = options.backend === 'cdp' ? page.input : undefined;
        const result = runInContext(`(${code}).apply(__target, __args)`, page.context);
        if (args[0] === 'prepare' && options.onPrepare) {
            await options.onPrepare(page);
        }
        if (args[0] === 'commit' && options.lostReceipt) {
            throw new Error('disconnected');
        }
        return result;
    };
    const session = getSession();
    const unified = getUnifiedSession();
    const restoreUnified = patch(unified, {
        withTabId: (_id, fn) => fn(),
        withInputCleanup: (fn) => fn(),
        withPageCondition: (_args, fn) => fn(),
        withFrame: (_frame, fn) => fn(),
        getMode: () => options.backend ?? 'extension',
        getCurrentTargetId: () => 'test-upload',
        getPageSnapshot: async () => ({ url: 'http://localhost/upload', title: 'Upload', revision: '1' }),
        listTargets: async () => [{ targetId: 'test-upload' }],
        listTopology: async () => null,
        getTargetRestoration: () => undefined,
        assertRequestActive: () => {},
        hasBrowserEventObservation: () => false,
        getChallengeState: async () => null,
        getState: () => ({ title: 'Upload', url: 'http://localhost/upload' }),
        getLiveState: async () => ({ title: 'Upload', url: 'http://localhost/upload' }),
        inspectChallenge: async () => ({ title: 'Upload', inspected: true }),
        find: async (...args) => {
            calls.push({ find: args });
            return [{ refId: 'ref1' }];
        },
        evaluate: execute,
        wait: async () => {},
    });
    const restoreSession = patch(session, {
        createLocator: (target) => ({
            find: async () => {
                calls.push({ locator: target });
                return 42;
            },
        }),
        send: async (method, params, _timeout, dispatchedAction) => {
            if (method === 'DOM.resolveNode') {
                return { object: { objectId: 'fixed-object' } };
            }
            if (method === 'Runtime.releaseObject') {
                releases.push(params.objectId);
                return {};
            }
            assert.equal(method, 'Runtime.callFunctionOn');
            assert.equal(params.objectId, 'fixed-object');
            return {
                result: {
                    value: await execute(
                        params.functionDeclaration,
                        undefined,
                        500,
                        params.arguments.map((arg) => arg.value),
                        { userAction: dispatchedAction }
                    ),
                },
            };
        },
    });
    let handler;
    let schema;
    registerInputTool({
        registerTool: (_name, config, callback) => {
            handler = callback;
            schema = config.inputSchema;
        },
    });
    try {
        await run({
            page,
            calls,
            releases,
            schema,
            call: async (args, signal) => {
                const response = await handler(
                    {
                        expectedUrl: 'http://localhost/upload',
                        events: [{ type: 'upload', target: { css: 'input[type=file]' }, files: [file] }],
                        ...args,
                    },
                    { signal }
                );
                return { response, body: JSON.parse(response.content[0].text) };
            },
        });
    } finally {
        restoreSession();
        restoreUnified();
    }
}

async function trackReads(run) {
    let reads = 0;
    let stats = 0;
    const originalStat = fsPromises.stat;
    const originalStream = fs.createReadStream;
    const restoreStream = patch(fs, {
        createReadStream: (...args) => {
            reads++;
            return originalStream(...args);
        },
    });
    const restoreStat = patch(fsPromises, {
        stat: (...args) => {
            stats++;
            return originalStat(...args);
        },
    });
    syncBuiltinESMExports();
    try {
        await run(() => ({ reads, stats }));
    } finally {
        restoreStream();
        restoreStat();
        syncBuiltinESMExports();
    }
}

test('ordinary CDP commands retain their results without negotiating permessage-deflate', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: true });
    await new Promise((resolve) => server.once('listening', resolve));
    let extensions;
    server.on('connection', (socket) => {
        extensions = socket.extensions;
        socket.on('message', (raw) => {
            const message = JSON.parse(raw.toString());
            socket.send(JSON.stringify({ id: message.id, result: { value: 42 } }));
        });
    });
    const client = new CDPClient();
    try {
        await client.connect(`ws://127.0.0.1:${server.address().port}`, 1000);
        assert.deepEqual(await client.send('Runtime.evaluate', { expression: '6 * 7' }), { value: 42 });
        assert.equal(extensions, '');
    } finally {
        client.close();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('upload schema exposes files and accepts clearing, rejects empty path strings', async () => {
    await withInput({}, async ({ schema }) => {
        assert.equal(
            schema.safeParse({ events: [{ type: 'upload', target: { css: 'input' }, files: [] }] }).success,
            true
        );
        assert.equal(
            schema.safeParse({ events: [{ type: 'upload', target: { css: 'input' }, files: [''] }] }).success,
            false
        );
    });
});

test('local paths preserve Unicode names, MIME, order, modification time and binary bytes', async () => {
    const payloads = await prepareUploadFiles([relative(process.cwd(), file), binary], Date.now() + 2000.5);
    assert.deepEqual(
        payloads.map((item) => item.name),
        ['附件.txt', 'payload.unknown-extension']
    );
    assert.deepEqual(
        payloads.map((item) => item.mimeType),
        ['text/plain', 'application/octet-stream']
    );
    assert.deepEqual(Buffer.from(payloads[1].buffer, 'base64'), bytes);
    assert.ok(payloads[0].lastModified > 0);
    assert.equal((await prepareUploadFiles(['~/附件.txt'], Date.now() + 2000))[0].name, '附件.txt');
});

for (const backend of ['extension', 'cdp']) {
    test(`${backend} public input sets hidden file controls and consumes the fixed target once`, async () => {
        await withInput({ backend }, async ({ page, calls, releases, call }) => {
            const { response, body } = await call({
                events: [{ type: 'upload', target: { css: 'input', nth: 1 }, files: [binary] }],
            });
            assert.equal(response.isError, undefined);
            assert.equal(body.actionStatus, 'completed');
            assert.equal(body.eventsExecuted, 1);
            assert.equal(page.input.assignments, 1);
            assert.deepEqual(Buffer.from(await page.input.files[0].arrayBuffer()), bytes);
            assert.deepEqual(page.input.events, [
                { type: 'input', bubbles: true, composed: true },
                { type: 'change', bubbles: true, composed: false },
            ]);
            assert.equal(Object.keys(page.context).filter((key) => key.startsWith('__mcpUpload_')).length, 0);
            assert.equal(calls.filter((item) => item.operation === 'commit').length, 1);
            assert.equal(JSON.stringify(body).includes(binary), false);
            assert.equal(JSON.stringify(body).includes(bytes.toString('base64')), false);
            if (backend === 'cdp') {
                assert.equal(calls.find((item) => item.locator).locator.nth, 1);
                assert.deepEqual(releases, ['fixed-object']);
            } else {
                assert.equal(calls.find((item) => item.find).find[5], 1);
            }
        });
    });
}

test('basename-relative paths retain their filename in successful upload metadata', async () => {
    const cwd = process.cwd();
    process.chdir(home);
    try {
        await withInput({}, async ({ call }) => {
            const { body } = await call({
                events: [{ type: 'upload', target: { css: 'input' }, files: ['附件.txt'] }],
            });
            assert.equal(body.success, true);
            assert.equal(body.eventResults[0].files[0].name, '附件.txt');
        });
    } finally {
        process.chdir(cwd);
    }
});

test('multiple, label and clear uploads preserve assignment-time file metadata', async () => {
    await withInput(
        {
            setup: (page) => {
                page.input.multiple = true;
                const label = new page.HTMLLabelElement();
                label.control = page.input;
                page.context.__mcpElementMap.ref1 = new WeakRef(label);
            },
        },
        async ({ call, page }) => {
            const { body } = await call({
                events: [{ type: 'upload', target: { label: 'Attachment' }, files: [file, binary] }],
            });
            assert.equal(body.success, true);
            assert.equal(body.eventResults[0].files.length, 2);
            await call({ events: [{ type: 'upload', target: { css: 'input' }, files: [] }] });
            assert.equal(page.input.files.length, 0);
            page.input.clearOnChange = true;
            const result = await call({});
            assert.equal(result.body.success, true);
            assert.equal(result.body.eventResults[0].files[0].name, '附件.txt');
            assert.equal(page.input.files.length, 0);
        }
    );
});

for (const scenario of [
    'denied',
    'csp',
    'not-file',
    'multiple',
    'directory',
    'missing-target',
    'missing-files',
    'coordinate',
]) {
    test(`${scenario} rejects before any server file access`, async () => {
        const options = {
            denied: scenario === 'denied',
            csp: scenario === 'csp',
            setup: (page) => {
                if (scenario === 'not-file') {
                    page.input.type = 'text';
                }
                if (scenario === 'directory') {
                    page.input.webkitdirectory = true;
                }
            },
        };
        await trackReads(async (counts) =>
            withInput(options, async ({ call, page }) => {
                const event = {
                    type: 'upload',
                    target: { css: 'input' },
                    files: scenario === 'multiple' ? [file, binary] : [file],
                };
                if (scenario === 'missing-target') {
                    delete event.target;
                }
                if (scenario === 'missing-files') {
                    delete event.files;
                }
                if (scenario === 'coordinate') {
                    event.target = { x: 1, y: 1 };
                }
                const { body } = await call({ events: [event] });
                assert.equal(body.actionExecuted, false);
                assert.equal(body.actionStatus, 'not_started');
                assert.deepEqual(counts(), { reads: 0, stats: 0 });
                assert.equal(page.input.assignments, 0);
            })
        );
    });
}

test('missing files and directories preserve the existing file selection without path disclosure', async () => {
    for (const badFile of [join(home, 'missing-secret.txt'), home]) {
        await withInput({}, async ({ page, call }) => {
            page.input.multiple = true;
            page.input.selected = [new File(['old'], 'old.txt')];
            const { response, body } = await call({
                events: [{ type: 'upload', target: { css: 'input' }, files: [file, badFile] }],
            });
            assert.equal(response.isError, true);
            assert.equal(body.error.code, 'UPLOAD_FILE_READ_FAILED');
            assert.equal(body.actionStatus, 'not_started');
            assert.equal(page.input.files[0].name, 'old.txt');
            assert.equal(JSON.stringify(body).includes(home), false);
        });
    }
});

test('stat and actual sequential read both enforce the strict 50 MiB total limit', async () => {
    const big = join(home, 'large.bin');
    const handle = await open(big, 'w');
    await handle.truncate(50 * 1024 * 1024);
    await handle.close();
    await trackReads(async (counts) => {
        await assert.rejects(prepareUploadFiles([big], Date.now() + 3000), { code: 'UPLOAD_TOO_LARGE' });
        assert.equal(counts().reads, 0);
    });
    const original = fsPromises.stat;
    const restore = patch(fsPromises, {
        stat: async (...args) => {
            const actual = await original(...args);
            return { size: 1, mtimeMs: actual.mtimeMs, isFile: () => true };
        },
    });
    syncBuiltinESMExports();
    try {
        await assert.rejects(prepareUploadFiles([big], Date.now() + 4000), { code: 'UPLOAD_TOO_LARGE' });
    } finally {
        restore();
        syncBuiltinESMExports();
    }
});

test('cancellation during sequential reading stops before page assignment', async () => {
    const controller = new AbortController();
    const original = fs.createReadStream;
    const restore = patch(fs, {
        createReadStream: (...args) => {
            const stream = original(...args);
            stream.once('data', () => controller.abort(new Error('test cancellation')));
            return stream;
        },
    });
    syncBuiltinESMExports();
    try {
        await withInput({}, async ({ call, page }) => {
            const { body } = await call({}, controller.signal);
            assert.equal(body.actionExecuted, false);
            assert.equal(body.actionStatus, 'not_started');
            assert.equal(page.input.assignments, 0);
        });
    } finally {
        restore();
        syncBuiltinESMExports();
    }
});

test('pre-commit deadline exhaustion has zero assignments', async () => {
    await withInput(
        { onPrepare: async () => new Promise((resolve) => setTimeout(resolve, 30)) },
        async ({ call, page }) => {
            const { body } = await call({ timeout: 10 });
            assert.equal(body.actionExecuted, false);
            assert.equal(body.actionStatus, 'not_started');
            assert.equal(page.input.assignments, 0);
        }
    );
});

for (const stop of ['timeout', 'cancel']) {
    test(`pending stat ${stop} returns promptly and ignores late completion`, async (t) => {
        const info = await fsPromises.stat(file);
        let finishStat;
        const pendingStat = new Promise((resolve, reject) => {
            finishStat = () => (stop === 'timeout' ? resolve(info) : reject(new Error('late stat failure')));
        });
        let statStarted = false;
        let reads = 0;
        const originalStream = fs.createReadStream;
        const restoreStat = patch(fsPromises, {
            stat: () => {
                statStarted = true;
                return pendingStat;
            },
        });
        const restoreStream = patch(fs, {
            createReadStream: (...args) => {
                reads++;
                return originalStream(...args);
            },
        });
        syncBuiltinESMExports();
        try {
            await withInput({}, async ({ call, page }) => {
                const controller = new AbortController();
                const started = Date.now();
                const pending = call({ timeout: stop === 'timeout' ? 10 : 1000 }, controller.signal);
                let abortTimer;
                let responseTimer;
                if (stop === 'cancel') {
                    abortTimer = setTimeout(() => controller.abort(new Error('stat cancelled')), 10);
                }
                try {
                    const { body } = await Promise.race([
                        pending,
                        new Promise((_resolve, reject) => {
                            responseTimer = setTimeout(() => reject(new Error('input waited for pending stat')), 80);
                        }),
                    ]);
                    t.diagnostic(`${stop} response: ${Date.now() - started} ms while stat remained pending`);
                    assert.equal(statStarted, true);
                    assert.equal(body.actionExecuted, false);
                    assert.equal(body.actionStatus, 'not_started');
                    assert.equal(reads, 0);
                    assert.equal(page.input.assignments, 0);
                } finally {
                    clearTimeout(abortTimer);
                    clearTimeout(responseTimer);
                    finishStat();
                    await pending;
                }
                await new Promise((resolve) => setImmediate(resolve));
                assert.equal(reads, 0);
                assert.equal(page.input.assignments, 0);
            });
        } finally {
            finishStat();
            restoreStat();
            restoreStream();
            syncBuiltinESMExports();
        }
    });
}

test('navigation and reused element refs cannot redirect an in-flight upload', async () => {
    let replacement;
    await withInput(
        {
            onPrepare: (page) => {
                page.input.isConnected = false;
                replacement = new page.HTMLInputElement();
                page.context.__mcpElementMap.ref1 = new WeakRef(replacement);
            },
        },
        async ({ call, page }) => {
            const { body } = await call({});
            assert.equal(body.actionExecuted, false);
            assert.equal(body.actionStatus, 'not_started');
            assert.equal(page.input.assignments, 0);
            assert.equal(replacement.assignments, 0);
        }
    );
});

test('native CDP rejection before dispatch preserves not_started and zero assignments', async () => {
    await withInput({ backend: 'cdp', beforeDispatchError: true }, async ({ call, page }) => {
        const { body } = await call({});
        assert.equal(body.actionExecuted, false);
        assert.equal(body.actionStatus, 'not_started');
        assert.equal(page.input.assignments, 0);
    });
});

test('lost commit receipt is unknown, nonretryable, and never replayed', async () => {
    await withInput({ lostReceipt: true }, async ({ call, page, calls }) => {
        const { body } = await call({});
        assert.equal(body.actionExecuted, true);
        assert.equal(body.actionStatus, 'unknown');
        assert.equal(body.retryable, false);
        assert.equal(page.input.assignments, 1);
        assert.equal(calls.filter((item) => item.operation === 'commit').length, 1);
    });
});

test('earlier events remain counted when upload preparation fails', async () => {
    await withInput({}, async ({ call }) => {
        const { body } = await call({
            events: [
                { type: 'wait', ms: 0 },
                { type: 'upload', target: { css: 'input' }, files: [home] },
            ],
        });
        assert.equal(body.eventsExecuted, 1);
        assert.equal(body.actionExecuted, true);
        assert.equal(body.actionStatus, 'failed');
    });
});

test('page-side orphaned weak references expire at the request deadline', async () => {
    const page = realm();
    page.context.fn = uploadInPage.toString();
    const result = runInContext(
        `eval('(' + fn + ')')('prepare', '__mcpUpload_expiring', 'ref1', Date.now() + 20, 0)`,
        page.context
    );
    assert.equal(result.success, true);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(page.context.__mcpUpload_expiring, undefined);
});
