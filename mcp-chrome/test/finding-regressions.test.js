import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { AutoWait } from '../dist/core/auto-wait.js';
import { Locator } from '../dist/core/locator.js';
import { deflateSync } from 'node:zlib';

import { getBrowserWSEndpoint } from '../dist/cdp/client.js';
import { BrowserLauncher, windowsChromeCandidates } from '../dist/cdp/launcher.js';
import {
    CDPError,
    ElementNotFoundError,
    formatErrorResponse,
    PagePreconditionError,
    TargetNotFoundError,
    TimeoutError,
} from '../dist/core/errors.js';
import { getSession } from '../dist/core/session.js';
import { getUnifiedSession } from '../dist/core/unified-session.js';
import {
    getControlledTempRoot,
    resolveScopedInputPath,
    resolveScopedOutputPath,
    writePrivateFile,
} from '../dist/core/utils.js';
import { ExtensionBridge } from '../dist/extension/bridge.js';
import { withPageContext, withPageResponse } from '../dist/tools/page-context.js';
import { registerBrowseTool } from '../dist/tools/browse.js';
import { registerManageTool } from '../dist/tools/manage.js';
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
import { McpClient } from './helpers.js';

const execFileAsync = promisify(execFile);

function patchProperties(object, values) {
    const originals = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(object, key)]));
    Object.assign(object, values);
    return () => {
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(object, key, descriptor);
            else Reflect.deleteProperty(object, key);
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
    return (args) => handler(schema.parse(args));
}

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
    const driver = {
        isConnected: () => true,
        getCurrentTargetId: () => state.current,
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
            if (!state.targets.has(id)) throw new TargetNotFoundError(id);
            state.current = id;
        },
        async deselectPage() {
            state.current = null;
        },
        async getPageSnapshot(targetId) {
            if (!state.targets.has(targetId)) throw new TargetNotFoundError(targetId);
            return { targetId, url: `https://example.com/${targetId}`, revision: `r${targetId}` };
        },
        setPageCondition() {},
        async inputKey(type) {
            state.dispatched.push({ type, targetId: state.current });
            state.actionCompleted = true;
        },
        async adoptPage(id) {
            state.current = id;
            return { success: true, targetId: id };
        },
        async closePage(id) {
            state.targets.delete(id);
            if (state.current === id) state.current = null;
        },
    };
    const restoreCdp = mode === 'cdp' ? patchProperties(cdp, driver) : () => {};
    const restoreUnified = patchProperties(unified, {
        extensionBridge: mode === 'extension' ? driver : null,
        activeMode: mode,
        cdpExplicitlySelected: mode === 'cdp',
        getMode: () => mode,
        getDriver: async () => (mode === 'extension' ? driver : cdp),
        listTopology: async () => ({ activeTargetId: '101' }),
        pageMetadata: new Map(),
        pressedKeys: new Set(),
        modifiers: 0,
    });
    try {
        return await run({ unified, driver, state });
    } finally {
        restoreUnified();
        restoreCdp();
    }
}

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
        server.listen(0, '127.0.0.1', resolve);
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
                    if (failure) throw failure;
                    return 1;
                },
                evaluateOn: async () => {
                    if (failure) throw failure;
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
                    if (method === 'Accessibility.enable') return {};
                    if (method === 'DOM.getDocument') return { root: { nodeId: 7 } };
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
                    if (method === 'DOM.pushNodesByBackendIdsToFrontend') return { nodeIds: params.backendNodeIds };
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
    const restore = patchProperties(session, {
        evaluate: async (script) =>
            runInNewContext(script, {
                Element,
                CSS: { escape: (text) => text },
                document: { querySelectorAll: () => elements, elementFromPoint: () => null },
                getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
            }),
    });
    try {
        assert.deepEqual(
            Array.from(await session.collectInteractiveElements(), (item) => item.name),
            ['Class TestId accessible button', 'spaces']
        );
    } finally {
        restore();
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
                    if (type === 'editorInsert') assert.equal(element.value, 'replacement');
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
            if (method === 'DOM.resolveNode') return { object: { objectId: 'element' } };
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
                    if (clickCount === 2) assert.equal(seen.at(-1).detail, 2);
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
        await unified.clickTurnstile({ clickSource: 'page', clickPoint: { x: 12, y: 34 } });
        assert.deepEqual(calls, [[12, 34, 'left', 1]]);
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

test('Extension navigation RPC budgets include transport margin for default and explicit waits', async (t) => {
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
                    assert.equal(requestTimeout, (params.timeout ?? 30000) + 5000);
                    if (failNavigation) throw navigationError;
                    return { id: 202, url: 'https://example.com/test', title: 'test', managed: true };
                },
            });
            try {
                for (const timeout of [undefined, 0, 75]) {
                    await run(bridge, timeout);
                    assert.equal(calls.at(-1).params.timeout, timeout);
                    assert.equal(calls.at(-1).params.waitUntil, 'load');
                }
                failNavigation = true;
                await assert.rejects(
                    () => run(bridge),
                    (error) => error === navigationError
                );
                assert.equal(calls.length, 4, 'navigation failures must not replay the action');
            } finally {
                restore();
            }
        });
    }
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
    const bridge = {
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

    session.extensionBridge = bridge;
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
                        if (restoration === 'no-default') state.current = null;
                        const primaryError = new TimeoutError('primary action timeout');
                        let dispatched = 0;
                        const action = () =>
                            withPageContext(unified, '202', async () => {
                                ++dispatched;
                                state.actionCompleted = true;
                                if (restoration === 'closed') state.targets.delete('101');
                                if (actionFails) throw primaryError;
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
                        if (expectedStatus === 'failed')
                            assert.match(payload.pageContext.targetRestoration.error, /restoration/);
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
                driver.inputKey = async (type) => {
                    state.dispatched.push({ type, targetId: state.current });
                    if (outcome === 'unknown') throw new TimeoutError('event dispatch timeout');
                    if (outcome === 'partial' && state.dispatched.length === 2) throw new Error('second input failed');
                };
                try {
                    const events = [{ type: 'keydown', key: 'a' }];
                    if (outcome === 'partial') events.push({ type: 'keyup', key: 'a' });
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
                } finally {
                    restore();
                }
            })
        );
    }
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
                    if (failure === 'permission')
                        driver.getPageSnapshot = async () => {
                            throw new Error(
                                JSON.stringify({
                                    error: { code: 'READ_PERMISSION_REQUIRED', message: 'page permission denied' },
                                })
                            );
                        };
                    if (failure === 'missing') state.targets.delete('202');
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
        async find(selector, text, xpath, timeout, point, matchIndex) {
            if (!granted) throw new Error('只读权限未授予');
            calls.push({ action: 'find', selector, text, xpath, point, matchIndex });
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
            if (!granted) throw new Error('只读权限未授予');
            return refId ? `${refId}:text` : 'page text';
        },
        async getHtml(selector, outer, refId) {
            if (!granted) throw new Error('只读权限未授予');
            return refId ? `<div id="${refId}"></div>` : '<html></html>';
        },
        async getAttribute(selector, refId, attribute) {
            if (!granted) throw new Error('只读权限未授予');
            calls.push({ action: 'attribute', refId, attribute });
            return `${refId}:value`;
        },
        async getComputedStyle(refId, prop) {
            if (!granted) throw new Error('只读权限未授予');
            calls.push({ action: 'style', refId, prop });
            return 'rgb(1, 2, 3)';
        },
        async getHtmlWithImages(selector, outer, refId) {
            if (!granted) throw new Error('只读权限未授予');
            calls.push({ action: 'images', refId });
            return { html: `<div id="${refId}"><img></div>`, images: [] };
        },
        getPageText: () => bridge.getText(),
        getPageHtml: () => bridge.getHtml(),
        async readPage(options) {
            if (!granted) throw new Error('只读权限未授予');
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
        assert.match(calls.at(-1).xpath, /@aria-label/);
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
            '<div id="ref_55"><img></div>'
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
            if (descriptor) Object.defineProperty(session, key, descriptor);
            else Reflect.deleteProperty(session, key);
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
            if (descriptor) Object.defineProperty(unified, key, descriptor);
            else delete unified[key];
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

test('C5 page metadata is scoped to a target and removed after closing it', async () => {
    const session = getUnifiedSession();
    const previousBridge = session.extensionBridge;
    const previousMode = session.activeMode;
    const bridge = {
        isConnected: () => true,
        getCurrentTargetId: () => '501',
        async getPageSnapshot(targetId) {
            return { targetId, url: 'https://example.com', revision: 'e:0' };
        },
        async newPage() {
            return { targetId: '501', url: 'https://example.com', title: 'Test', type: 'page' };
        },
        async newWindow() {
            return { targetId: '601', windowId: 10 };
        },
        async closePage() {},
    };
    session.extensionBridge = bridge;
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
        assert.deepEqual(session.getPageMetadata('501'), { createdBy: 'unknown', createdAt: null, lastUsedAt: null });
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

test('C7 screenshot and PNG comparison reject excessive dimensions and encoded input', () => {
    assert.throws(() => assertScreenshotBudget(16385, 1), /超出预算/);
    assert.throws(() => assertScreenshotBudget(5000, 5000), /超出预算/);
    assert.throws(
        () => assertScreenshotBase64Budget('A'.repeat(Math.ceil(((MAX_COMPARE_PNG_BYTES + 1) * 4) / 3))),
        /超过/
    );
    assert.throws(() => assertPngFileBudget(MAX_COMPARE_PNG_BYTES + 1), /超过/);
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
            if (descriptor) Object.defineProperty(session, key, descriptor);
            else delete session[key];
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
if (-not $a.AreAccessRulesProtected -or $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner) { throw 'private ACL not applied' }
foreach ($rule in $a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $allowed -notcontains $rule.IdentityReference.Value) { throw 'unexpected access rule' }
}`;
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', verify], options);
        const inject = `$ErrorActionPreference = 'Stop'
$a = Get-Acl -LiteralPath $env:MCP_CHROME_PRIVATE_PATH
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'ReadData', 'Allow')
$a.AddAccessRule($rule)
Set-Acl -LiteralPath $env:MCP_CHROME_PRIVATE_PATH -AclObject $a
$a = Get-Acl -LiteralPath $env:MCP_CHROME_PRIVATE_PATH
if (@($a.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq $everyone.Value }).Count -ne 1) { throw 'Everyone rule not applied' }`;
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
        if (original) Object.defineProperty(session, 'getCookies', original);
        else delete session.getCookies;
        if (scoped) await rm(dirname(scoped.absolutePath), { recursive: true, force: true });
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

test('C02 postCondition script evaluates expressions, functions, async functions, and Promise values', async () => {
    const host = {
        async evaluate(script, _mode, _timeout, args = []) {
            const fn = (0, eval)(`(${script})`);
            return fn(...args);
        },
    };
    for (const script of ['true', '() => true', 'async () => true', 'Promise.resolve(true)']) {
        const result = await waitForPostCondition(host, { script, timeout: 40, interval: 10 }, 'test');
        assert.equal(result.verificationStatus, 'matched', script);
    }
    for (const script of ['false', '() => false', 'async () => false', 'Promise.resolve(false)']) {
        const result = await waitForPostCondition(host, { script, timeout: 20, interval: 10 }, 'test');
        assert.equal(result.verificationStatus, 'not_matched', script);
    }
    const failed = await waitForPostCondition(host, { script: '() => { throw new Error("boom") }' }, 'test');
    assert.equal(failed.verificationStatus, 'error');
    assert.match(failed.error, /boom/);
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
    const cdp = {
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
    session.cdp = cdp;
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
    const cdp = {
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
                        listener({ requestId: 'same-document-request' }, 'session-current');
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
    session.cdp = cdp;
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
            "#!/bin/bash\nprintf 'DevTools listening on ws://127.0.0.1:9333/devtools/bro' >&2\nsleep 0.05\nprintf 'wser/test-id\\n' >&2\nsleep 5\n"
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
                    [new URL(`../scripts/${script}`, import.meta.url).pathname, '9333', '--flag'],
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
