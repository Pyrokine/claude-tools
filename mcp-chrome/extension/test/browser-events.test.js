import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionHandler } from '../src/background/actions.ts';
import { BrowserEventHandler } from '../src/background/browser-event-handler.ts';
import { markManagedTab, restoreManagedTabs, unmarkManagedTab } from '../src/background/tab-state.ts';

test.describe('owned browser event protocols', () => {
    function storage() {
        const values = {};
        return {
            get: async (key) => (typeof key === 'string' ? { [key]: values[key] } : { ...values }),
            set: async (update) => {
                Object.assign(values, update);
            },
            remove: async (key) => {
                delete values[key];
            },
        };
    }
    const callbacks = [];
    const calls = [];
    const page = { id: 51201, url: 'https://example.com/owned', title: 'Owned', windowId: 51, groupId: -1, index: 0 };
    let runtimeResolve;
    const body = Buffer.from([0, 255, 128, 1]);
    const chromeFixture = {
        storage: { local: storage(), session: storage() },
        tabs: {
            get: async (id) => {
                if (id !== page.id) {
                    throw Error('No tab with id');
                }
                return page;
            },
            query: async () => [page],
        },
        webNavigation: { getFrame: async () => ({ documentId: 'owned-document', frameId: 0, url: page.url }) },
        debugger: {
            onEvent: { addListener: (listener) => callbacks.push(listener) },
            onDetach: { addListener: () => {} },
            attach: async () => {},
            detach: async () => {},
            sendCommand: async (source, method, params) => {
                calls.push({ source, method, params });
                if (method === 'Runtime.evaluate' && params.expression === 'block-with-dialog') {
                    return new Promise((resolve) => {
                        runtimeResolve = resolve;
                    });
                }
                if (method === 'Page.handleJavaScriptDialog') {
                    runtimeResolve?.({ result: { value: 'original-completed' } });
                }
                if (method === 'Fetch.getResponseBody') {
                    return { body: body.toString('base64'), base64Encoded: true };
                }
                if (method === 'Fetch.continueResponse' && params.requestId === 'download') {
                    emit('Page.downloadWillBegin', {
                        guid: 'native-guid',
                        frameId: 'native-frame',
                        url: 'https://example.com/file',
                        suggestedFilename: 'original.bin',
                    });
                    emit('Page.downloadProgress', {
                        guid: 'native-guid',
                        state: 'completed',
                        receivedBytes: body.length,
                        totalBytes: body.length,
                    });
                }
                return { nativeResult: 'ack' };
            },
        },
    };
    const emit = (method, params, sessionId) =>
        callbacks.forEach((listener) => listener({ tabId: page.id, sessionId }, method, params));
    const context = (owner) => ({ serverInstanceId: owner, mcpTabGroupId: null, mcpWindowId: null });
    let handler;
    let previousChrome;
    const action = (owner, eventAction, command) =>
        handler.execute('browser_events', { tabId: page.id, action: eventAction, command }, context(owner));
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    test.before(async () => {
        previousChrome = globalThis.chrome;
        globalThis.chrome = chromeFixture;
        await restoreManagedTabs();
        await markManagedTab(page.id);
        const original = globalThis.setInterval;
        globalThis.setInterval = () => 0;
        try {
            handler = new ActionHandler();
        } finally {
            globalThis.setInterval = original;
        }
    });
    test.after(async () => {
        try {
            await handler.releaseBrowserEventOwner('owner-a');
            await handler.releaseBrowserEventOwner('owner-b');
            await unmarkManagedTab(page.id);
        } finally {
            globalThis.chrome = previousChrome;
        }
    });

    test('inactive tabs reject native mouse movement and press before dispatch while release remains available', async () => {
        const before = calls.length;
        page.active = false;
        try {
            for (const type of ['mouseMoved', 'mousePressed']) {
                await assert.rejects(
                    handler.execute(
                        'input_mouse',
                        { tabId: page.id, type, x: 10, y: 20, button: 'left' },
                        context('owner-a')
                    ),
                    (error) => {
                        const body = JSON.parse(error.message);
                        assert.equal(body.error.code, 'NATIVE_INPUT_UNAVAILABLE');
                        assert.equal(body.error.context.actionExecuted, false);
                        return true;
                    }
                );
            }
            assert.equal(calls.slice(before).filter((call) => call.method === 'Input.dispatchMouseEvent').length, 0);
            await handler.execute(
                'input_mouse',
                {
                    tabId: page.id,
                    type: 'mouseReleased',
                    x: 10,
                    y: 20,
                    button: 'left',
                },
                context('owner-a')
            );
            assert.equal(calls.at(-1).params.type, 'mouseReleased');
            page.active = true;
            await handler.execute(
                'input_mouse',
                {
                    tabId: page.id,
                    type: 'mousePressed',
                    x: 10,
                    y: 20,
                    button: 'left',
                },
                context('owner-a')
            );
            await handler.execute(
                'input_mouse',
                {
                    tabId: page.id,
                    type: 'mouseReleased',
                    x: 10,
                    y: 20,
                    button: 'left',
                },
                context('owner-a')
            );
        } finally {
            delete page.active;
        }
    });

    test('Extension dialog read/control bypasses its own blocked per-tab native operation', async () => {
        const original = handler.execute(
            'debugger_send',
            { tabId: page.id, method: 'Runtime.evaluate', params: { expression: 'block-with-dialog' } },
            context('owner-a')
        );
        const rejected = assert.rejects(original, (error) => JSON.parse(error.message).error.code === 'DIALOG_OPEN');
        await flush();
        emit('Page.javascriptDialogOpening', { type: 'prompt', message: 'original prompt' });
        const logs = await action('owner-a', 'read', { type: 'dialog' });
        assert.equal(logs.logs.length, 1);
        await action('owner-a', 'dialog', { op: 'accept', ref: logs.logs[0].ref, text: 'answer' });
        await rejected;
        assert.ok(calls.some((call) => call.method === 'Page.enable'));
        assert.ok(
            calls.some((call) => call.method === 'Page.handleJavaScriptDialog' && call.params.promptText === 'answer')
        );
    });

    test('Extension Fetch ownership excludes other servers and preserves exact source session', async () => {
        const rule = await action('owner-a', 'route', { op: 'add', urlPattern: '*example.com/api' });
        await assert.rejects(action('owner-b', 'route', { op: 'add', urlPattern: '*' }), /another server instance/);
        await action('owner-b', 'read', { type: 'network' });
        await assert.rejects(action('owner-b', 'route', { op: 'add', urlPattern: '*' }), /another server instance/);
        const suspension = await handler.execute('browser_events_suspend', { tabId: page.id }, context('owner-b'));
        assert.equal(suspension.suspended, false);
        emit(
            'Fetch.requestPaused',
            { requestId: 'original-pause', request: { url: 'https://example.com/api', method: 'POST' } },
            'oopif-session'
        );
        await flush();
        const paused = await action('owner-a', 'read', { type: 'network', view: 'paused' });
        const ref = paused.logs[0].ref;
        await assert.rejects(action('owner-b', 'route', { op: 'continue', ref }), /another server instance/);
        await action('owner-a', 'route', {
            op: 'fulfill',
            ref,
            response: { status: 200, body: { encoding: 'utf8', data: 'mock' } },
        });
        const native = calls.find((call) => call.method === 'Fetch.fulfillRequest');
        assert.equal(native.source.sessionId, 'oopif-session');
        assert.equal(native.params.body, Buffer.from('mock').toString('base64'));
        await action('owner-a', 'route', { op: 'remove', ref: rule.rule.ref });
    });

    test('Extension Page GUID records distinguish native completion and original binary delivery', async () => {
        await action('owner-a', 'download', { op: 'watch', urlPattern: 'https://example.com/file' });
        emit('Fetch.requestPaused', {
            requestId: 'download',
            frameId: 'native-frame',
            request: { url: 'https://example.com/file' },
            responseStatusCode: 200,
            responseHeaders: [{ name: 'Content-Disposition', value: 'attachment; filename="original.bin"' }],
        });
        await flush();
        const downloads = await action('owner-a', 'read', { type: 'download' });
        assert.equal(downloads.logs[0].guid, 'native-guid');
        assert.equal(downloads.logs[0].state, 'completed');
        assert.equal(downloads.logs[0].artifact, 'available');
        const result = await action('owner-a', 'download', {
            op: 'save',
            ref: downloads.logs[0].ref,
            output: 'tmp:ignored-by-extension.bin',
        });
        assert.ok(Buffer.from(result.payload.data, result.payload.encoding).equals(body));
        assert.equal(
            calls.filter((call) => call.method === 'Fetch.getResponseBody' && call.params.requestId === 'download')
                .length,
            1
        );
        await action('owner-a', 'download', { op: 'stop' });
    });

    test('Extension suspension with an unknown native outcome retains the original Fetch owner', async () => {
        let consume;
        const events = new BrowserEventHandler({
            addEventConsumer: (listener) => {
                consume = listener;
            },
            ensureAttached: async () => {},
        });
        const execute = (owner, action, command) => events.execute({ tabId: page.id, action, command }, context(owner));
        const originalSend = chromeFixture.debugger.sendCommand;
        chromeFixture.debugger.sendCommand = async (...args) => {
            if (args[1] === 'Fetch.fulfillRequest') {
                throw new Error('lost native acknowledgement');
            }
            return originalSend(...args);
        };
        try {
            await execute('owner-a', 'route', { op: 'add', urlPattern: '*' });
            consume(page.id, 'Fetch.requestPaused', {
                requestId: 'unknown-owner',
                request: { url: 'https://example.com/api' },
            });
            await flush();
            const ref = (await execute('owner-a', 'read', { type: 'network', view: 'paused' })).logs[0].ref;
            await assert.rejects(
                execute('owner-a', 'route', { op: 'fulfill', ref, response: { status: 200 } }),
                /lost native/
            );
            const suspended = await events.suspendTab(page.id, 'Cloudflare challenge', 'owner-a');
            assert.equal(suspended.suspended, false);
            assert.equal(suspended.observations[0].fetchEnabled, true);
            await assert.rejects(
                execute('owner-b', 'route', { op: 'add', urlPattern: '*' }),
                /another server instance/
            );
        } finally {
            chromeFixture.debugger.sendCommand = originalSend;
        }
    });

    test('Extension owner disconnect aborts its pauses before disabling Fetch and invalidates old refs', async () => {
        await action('owner-a', 'route', { op: 'add', urlPattern: '*' });
        emit('Fetch.requestPaused', { requestId: 'disconnect', request: { url: 'https://example.com/api' } });
        await flush();
        const ref = (await action('owner-a', 'read', { type: 'network', view: 'paused' })).logs.find(
            (log) => log.requestId === 'disconnect'
        ).ref;
        const start = calls.length;
        await handler.releaseBrowserEventOwner('owner-a');
        const cleanup = calls.slice(start);
        assert.ok(
            cleanup.findIndex((call) => call.method === 'Fetch.failRequest') <
                cleanup.findIndex((call) => call.method === 'Fetch.disable')
        );
        await assert.rejects(action('owner-a', 'route', { op: 'continue', ref }), /another owner/);
    });
});
