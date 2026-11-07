import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const root = process.env.MCP_EVENT_DIST ?? path.resolve(import.meta.dirname, '../dist');
const load = (name) => import(pathToFileURL(path.join(root, name)));
const { getSession } = await load('core/session.js');
const { getUnifiedSession } = await load('core/unified-session.js');
const { registerLogsTool } = await load('tools/logs.js');
const { registerManageTool } = await load('tools/manage.js');

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
function result(response) {
    assert.equal(response.isError, undefined, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
}

async function fixture(t) {
    const session = getSession();
    const unified = getUnifiedSession();
    assert.equal(session.isConnected(), false, 'Only an isolated synthetic CDP connection may be used');
    const page = {
        id: 'review-events',
        targetId: 'review-events',
        type: 'page',
        url: 'https://example.com/events',
        title: 'Events',
    };
    const calls = [];
    const files = [];
    const requestBody = 'cookieLine=explicit-body-cookie; authorization=explicit-body-auth\r\n';
    const responseBody = Buffer.concat([Buffer.from([0, 255, 128]), Buffer.from(requestBody)]);
    let socket;
    let onDialog;
    const http = createServer((request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(
            JSON.stringify(
                request.url === '/json/version'
                    ? { webSocketDebuggerUrl: `ws://127.0.0.1:${http.address().port}` }
                    : [page]
            )
        );
    });
    const server = new WebSocketServer({ server: http });
    const reply = (message, value = {}) => socket.send(JSON.stringify({ id: message.id, result: value }));
    server.on('connection', (connection) => {
        socket = connection;
        connection.on('message', (raw) => {
            const message = JSON.parse(raw.toString());
            calls.push(message);
            switch (message.method) {
                case 'Page.handleJavaScriptDialog':
                    if (onDialog) {
                        onDialog(message);
                    } else {
                        reply(message);
                    }
                    return;
                case 'Target.attachToTarget':
                    reply(message, { sessionId: 'review-session' });
                    return;
                case 'Page.getFrameTree':
                    reply(message, { frameTree: { frame: { id: 'review-frame', loaderId: 'review-loader' } } });
                    return;
                case 'Target.getTargetInfo':
                    reply(message, { targetInfo: page });
                    return;
                case 'Network.getRequestPostData':
                    reply(message, { postData: requestBody });
                    return;
                case 'Network.getResponseBody':
                    reply(message, { body: responseBody.toString('base64'), base64Encoded: true });
                    return;
                default:
                    reply(message);
            }
        });
    });
    await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await session.close();
        for (const client of server.clients) {
            client.terminate();
        }
        await new Promise((resolve) => server.close(resolve));
        http.closeAllConnections();
        await new Promise((resolve) => http.close(resolve));
        await Promise.all(files.map((file) => rm(file, { force: true })));
    });
    const connect = async () => {
        await session.connect({ host: '127.0.0.1', port: http.address().port, timeout: 2000, stealth: 'off' });
        await unified.setActiveMode('cdp', true);
    };
    await connect();
    const event = (method, params) => ({ method, params, sessionId: 'review-session' });
    const batch = (messages) => {
        // One TCP write keeps close/ACK/open frames in the same real ws receiver turn.
        socket._socket.cork();
        try {
            for (const message of messages) {
                socket.send(JSON.stringify(message));
            }
        } finally {
            socket._socket.uncork();
        }
    };
    const emit = async (method, params) => {
        const observed = session.cdp.waitForEvent(method, undefined, 2000, 'review-session');
        batch([event(method, params)]);
        await observed;
    };
    const logs = registeredTool(registerLogsTool);
    const manage = registeredTool(registerManageTool);
    const dialogs = async () => result(await logs({ type: 'dialog', targetId: page.id })).logs;
    const open = async (type, message) => {
        await emit('Page.javascriptDialogOpening', {
            type,
            message,
            defaultPrompt: type === 'prompt' ? 'original' : undefined,
        });
        return (await dialogs()).at(-1);
    };
    const handle = (dialog, extra) => manage({ action: 'dialog', targetId: page.id, dialog }, extra);
    return {
        session,
        calls,
        files,
        requestBody,
        responseBody,
        connect,
        event,
        batch,
        emit,
        logs,
        manage,
        dialogs,
        open,
        handle,
        reply,
        get socket() {
            return socket;
        },
        set onDialog(callback) {
            onDialog = callback;
        },
    };
}

function assertCookieMetadata(entry, withCookie) {
    const extra = entry.responseExtraInfo;
    assert.equal(extra.blockedCookies[0].cookieLine, '[REDACTED]');
    assert.deepEqual(extra.blockedCookies[0].blockedReasons, ['SecureOnly']);
    assert.equal(extra.exemptedCookies[0].cookieLine, '[REDACTED]');
    assert.equal(extra.exemptedCookies[0].exemptionReason, 'UserSetting');
    assert.equal(extra.headers['Set-Cookie'], '[REDACTED]');
    if (withCookie) {
        assert.equal(extra.blockedCookies[0].cookie, '[REDACTED]');
        assert.equal(extra.exemptedCookies[0].cookie, '[REDACTED]');
    }
    assert.deepEqual(entry.requestExtraInfo.associatedCookies[0].blockedReasons, []);
    assert.equal(entry.requestExtraInfo.associatedCookies[0].cookie, '[REDACTED]');
}

test(
    'C30-04 public logs redact blocked/exempted cookieLine inline and in output while explicit bodies retain bytes',
    { timeout: 15000 },
    async (t) => {
        const f = await fixture(t);
        for (const withCookie of [false, true]) {
            const requestId = `cookie-${withCookie}`;
            const blocked = {
                cookieLine: 'blocked=synthetic-blocked-secret; HttpOnly',
                blockedReasons: ['SecureOnly'],
            };
            const exempted = {
                cookieLine: 'exempted=synthetic-exempted-secret; Secure',
                exemptionReason: 'UserSetting',
            };
            if (withCookie) {
                blocked.cookie = { name: 'blocked', value: 'synthetic-blocked-object-secret' };
                exempted.cookie = { name: 'exempted', value: 'synthetic-exempted-object-secret' };
            }
            await f.emit('Network.responseReceivedExtraInfo', {
                requestId,
                statusCode: 200,
                headers: { 'Set-Cookie': 'header=synthetic-header-secret' },
                blockedCookies: [blocked],
                exemptedCookies: [exempted],
            });
            await f.emit('Network.requestWillBeSent', {
                requestId,
                request: { url: `https://example.com/${requestId}`, method: 'POST', postData: f.requestBody },
                type: 'Fetch',
            });
            await f.emit('Network.requestWillBeSentExtraInfo', {
                requestId,
                headers: {},
                associatedCookies: [
                    { cookie: { name: 'associated', value: 'synthetic-associated-secret' }, blockedReasons: [] },
                ],
            });
            await f.emit('Network.responseReceived', { requestId, response: { status: 200 }, hasExtraInfo: true });
            await f.emit('Network.loadingFinished', { requestId, encodedDataLength: f.responseBody.length });
            const summary = result(await f.logs({ type: 'network', view: 'summary' }));
            const ref = summary.logs.find((entry) => entry.requestId === requestId).ref;
            const inline = result(await f.logs({ type: 'network', view: 'details', ref }));
            assertCookieMetadata(inline.logs[0], withCookie);
            const output = result(
                await f.logs({
                    type: 'network',
                    view: 'details',
                    ref,
                    output: `tmp:review-events-${randomUUID()}.json`,
                })
            );
            f.files.push(output.output);
            const written = await readFile(output.output, 'utf8');
            assertCookieMetadata(JSON.parse(written).logs[0], withCookie);
            for (const text of [JSON.stringify(inline), written, JSON.stringify(output)]) {
                assert.doesNotMatch(text, /synthetic-(?:blocked|exempted|header|associated)(?:-object)?-secret/);
            }
            const request = result(await f.logs({ type: 'network', view: 'requestBody', ref }));
            assert.deepEqual(request.payload, { encoding: 'utf8', data: f.requestBody });
            const response = result(await f.logs({ type: 'network', view: 'responseBody', ref }));
            assert.deepEqual(Buffer.from(response.payload.data, response.payload.encoding), f.responseBody);
            for (const view of ['requestBody', 'responseBody']) {
                const saved = result(
                    await f.logs({ type: 'network', view, ref, output: `tmp:review-events-${randomUUID()}.bin` })
                );
                f.files.push(saved.output);
                assert.deepEqual(
                    await readFile(saved.output),
                    view === 'requestBody' ? Buffer.from(f.requestBody) : f.responseBody
                );
            }
        }
        assert.equal(f.calls.filter((call) => call.method === 'Network.getRequestPostData').length, 2);
        assert.equal(f.calls.filter((call) => call.method === 'Network.getResponseBody').length, 2);
        assert.equal(
            f.calls.some((call) => /navigate|loadNetworkResource|Fetch\./.test(call.method)),
            false
        );
    }
);

test(
    'C30-05 public dialog handling preserves the new entry for every close/ACK/open frame order',
    { timeout: 15000 },
    async (t) => {
        const f = await fixture(t);
        for (const type of ['alert', 'confirm', 'prompt']) {
            for (const order of [
                ['closed', 'ack', 'open'],
                ['closed', 'open', 'ack'],
                ['ack', 'closed', 'open'],
                ['ack', 'open'],
            ]) {
                await t.test(`${type}: ${order.join('/')}`, async () => {
                    const first = await f.open(type, `first-${type}-${order.join('-')}`);
                    let settled = false;
                    const observed = [];
                    const observer = (params) => {
                        if (params.message === 'second') {
                            observed.push(settled);
                        }
                    };
                    f.session.cdp.onEvent('Page.javascriptDialogOpening', observer);
                    f.onDialog = (message) => {
                        const frames = {
                            closed: f.event('Page.javascriptDialogClosed', {
                                result: type !== 'confirm',
                                userInput: type === 'prompt' ? 'answer' : '',
                            }),
                            ack: { id: message.id, result: {} },
                            open: f.event('Page.javascriptDialogOpening', { type: 'prompt', message: 'second' }),
                        };
                        f.batch(order.map((key) => frames[key]));
                    };
                    const op = type === 'confirm' ? 'dismiss' : 'accept';
                    const response = await f.handle({
                        op,
                        ref: first.ref,
                        ...(type === 'prompt' ? { text: 'answer' } : {}),
                    });
                    settled = true;
                    f.session.cdp.offEvent('Page.javascriptDialogOpening', observer);
                    const handled = result(response);
                    assert.equal(handled.dialog.ref, first.ref);
                    assert.equal(handled.dialog.state, order.includes('closed') ? 'closed' : 'handled');
                    assert.deepEqual(
                        observed,
                        [false],
                        'Opening must be received before the old handler continuation completes'
                    );
                    const second = (await f.dialogs()).at(-1);
                    assert.equal(second.message, 'second');
                    assert.equal(second.state, 'pending');
                    const before = f.calls.length;
                    const duplicate = await f.handle({ op: 'accept', ref: first.ref });
                    assert.equal(duplicate.isError, true);
                    assert.match(duplicate.content[0].text, /no longer pending/);
                    assert.equal(f.calls.length, before);
                    await assert.rejects(
                        f.session.send('Runtime.evaluate', { expression: 'must-not-run' }),
                        (error) => error.code === 'DIALOG_OPEN'
                    );
                    f.onDialog = undefined;
                    result(await f.handle({ op: 'accept', ref: second.ref, text: 'second answer' }));
                    assert.deepEqual(f.calls.at(-1).params, { accept: true, promptText: 'second answer' });
                    assert.equal(f.calls.at(-1).sessionId, 'review-session');
                    const firstCommand = f.calls.filter((call) => call.method === 'Page.handleJavaScriptDialog').at(-2);
                    assert.deepEqual(firstCommand.params, {
                        accept: op === 'accept',
                        ...(type === 'prompt' ? { promptText: 'answer' } : {}),
                    });
                });
            }
        }
        const first = await f.open('alert', 'ACK completes before next opening');
        f.onDialog = undefined;
        result(await f.handle({ op: 'accept', ref: first.ref }));
        await f.emit('Page.javascriptDialogClosed', { result: true, userInput: '' });
        const second = await f.open('confirm', 'after continuation');
        result(await f.handle({ op: 'dismiss', ref: second.ref }));
    }
);

test(
    'C30-05 native errors preserve observed closure and never change the replacement dialog',
    { timeout: 10000 },
    async (t) => {
        const f = await fixture(t);
        for (const order of [
            ['closed', 'error', 'open'],
            ['closed', 'open', 'error'],
            ['error', 'closed', 'open'],
        ]) {
            const first = await f.open('prompt', 'first error dialog');
            f.onDialog = (message) => {
                const frames = {
                    closed: f.event('Page.javascriptDialogClosed', { result: true, userInput: 'observed answer' }),
                    error: { id: message.id, error: { code: -32000, message: 'synthetic lost acknowledgement' } },
                    open: f.event('Page.javascriptDialogOpening', {
                        type: 'alert',
                        message: 'replacement after error',
                    }),
                };
                f.batch(order.map((key) => frames[key]));
            };
            const failed = await f.handle({ op: 'accept', ref: first.ref, text: 'answer' });
            assert.equal(failed.isError, true);
            assert.match(failed.content[0].text, /synthetic lost acknowledgement/);
            const logs = await f.dialogs();
            assert.equal(logs.find((entry) => entry.ref === first.ref).state, 'closed');
            assert.equal(logs.find((entry) => entry.ref === first.ref).userInput, 'observed answer');
            const second = logs.at(-1);
            assert.equal(second.state, 'pending');
            f.onDialog = undefined;
            result(await f.handle({ op: 'dismiss', ref: second.ref }));
        }
        const uncertain = await f.open('alert', 'no native closure');
        f.onDialog = (message) =>
            f.batch([{ id: message.id, error: { code: -32000, message: 'synthetic unknown outcome' } }]);
        assert.equal((await f.handle({ op: 'accept', ref: uncertain.ref })).isError, true);
        assert.equal((await f.dialogs()).at(-1).state, 'unknown');
        const before = f.calls.length;
        assert.equal((await f.handle({ op: 'accept', ref: uncertain.ref })).isError, true);
        assert.equal(f.calls.length, before);
    }
);

test(
    'C30-05 cancellation and disconnect do not replay old refs or consume a later dialog',
    { timeout: 15000 },
    async (t) => {
        const f = await fixture(t);
        const first = await f.open('prompt', 'cancelled before dispatch');
        const preCancelled = AbortSignal.abort(new Error('synthetic pre-cancel'));
        let before = f.calls.length;
        assert.equal((await f.handle({ op: 'accept', ref: first.ref }, { signal: preCancelled })).isError, true);
        assert.equal(f.calls.length, before);
        assert.equal((await f.dialogs()).at(-1).state, 'pending');
        const cancel = new AbortController();
        let pendingCommand;
        let dispatched;
        const dispatch = new Promise((resolve) => {
            dispatched = resolve;
        });
        f.onDialog = (message) => {
            pendingCommand = message;
            dispatched();
        };
        const pending = f.handle({ op: 'accept', ref: first.ref, text: 'original answer' }, { signal: cancel.signal });
        await dispatch;
        before = f.calls.length;
        const duplicatePending = await f.handle({ op: 'dismiss', ref: first.ref });
        assert.equal(duplicatePending.isError, true);
        assert.match(duplicatePending.content[0].text, /already dispatched/);
        assert.equal(f.calls.length, before);
        cancel.abort(new Error('synthetic in-flight cancel'));
        assert.equal((await pending).isError, true);
        assert.equal((await f.dialogs()).at(-1).state, 'unknown');
        assert.equal((await f.handle({ op: 'accept', ref: first.ref })).isError, true);
        assert.equal(f.calls.length, before);
        const opened = f.session.cdp.waitForEvent('Page.javascriptDialogOpening', undefined, 2000, 'review-session');
        f.batch([
            f.event('Page.javascriptDialogClosed', { result: true, userInput: 'original answer' }),
            { id: pendingCommand.id, result: {} },
            f.event('Page.javascriptDialogOpening', { type: 'alert', message: 'after cancelled old ACK' }),
        ]);
        await opened;
        const second = (await f.dialogs()).at(-1);
        f.onDialog = undefined;
        result(await f.handle({ op: 'dismiss', ref: second.ref }));

        const old = await f.open('alert', 'disconnect during ACK');
        let disconnectDispatched;
        const disconnectDispatch = new Promise((resolve) => {
            disconnectDispatched = resolve;
        });
        f.onDialog = () => disconnectDispatched();
        const disconnected = f.handle({ op: 'accept', ref: old.ref });
        await disconnectDispatch;
        const closed = once(f.session.cdp, 'disconnected');
        f.socket.terminate();
        await closed;
        assert.equal((await disconnected).isError, true);
        before = f.calls.length;
        assert.equal((await f.handle({ op: 'accept', ref: old.ref })).isError, true);
        assert.equal(f.calls.length, before);
        await f.connect();
        const fresh = await f.open('confirm', 'new connection generation');
        before = f.calls.length;
        assert.equal((await f.handle({ op: 'dismiss', ref: old.ref })).isError, true);
        assert.equal(f.calls.length, before);
        f.onDialog = undefined;
        result(await f.handle({ op: 'dismiss', ref: fresh.ref }));
    }
);
