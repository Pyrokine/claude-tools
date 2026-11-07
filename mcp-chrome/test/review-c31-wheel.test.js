import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { z } from 'zod';
import { getUnifiedSession } from '../dist/core/index.js';
import { installDomHelpers } from '../dist/core/dom-helpers.js';
import { ExtensionBridge } from '../dist/extension/bridge.js';
import { ExtensionHttpServer } from '../dist/extension/http-server.js';
import { registerInputTool } from '../dist/tools/input.js';

function extensionModule(path, imports, globals = {}) {
    const source = readFileSync(new URL(`../extension/src/${path}.ts`, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports = {};
    vm.runInNewContext(`(function(require, exports) { ${code}\n})`, { Error, console, ...globals })((name) => {
        assert.ok(Object.hasOwn(imports, name), `Unexpected production import: ${name}`);
        return imports[name];
    }, exports);
    return exports;
}

function wheelRealm() {
    const events = [];
    const scrolls = [];
    const element = {
        scrollWidth: 1000,
        clientWidth: 100,
        scrollLeft: 0,
        scrollHeight: 1000,
        clientHeight: 100,
        scrollTop: 0,
        parentElement: null,
        getRootNode: () => ({}),
        getClientRects: () => [{}],
        dispatchEvent: (event) => {
            events.push(event);
            return true;
        },
        scrollBy({ left: x, top: y, behavior }) {
            assert.equal(behavior, 'instant');
            scrolls.push([x, y]);
            this.scrollLeft += x;
            this.scrollTop += y;
        },
    };
    const root = { style: { overflowX: 'visible', overflowY: 'visible' } };
    element.parentElement = root;
    const realm = vm.createContext({
        document: { documentElement: root, elementFromPoint: () => element },
        WheelEvent: class {
            constructor(type, options) {
                Object.assign(this, { type }, options);
            }
        },
        getComputedStyle: (node) => ({
            display: 'block',
            position: 'static',
            contain: 'none',
            containerType: 'normal',
            contentVisibility: 'visible',
            willChange: 'auto',
            ...(node === root ? root.style : { overflowX: 'auto', overflowY: 'auto', direction: 'ltr' }),
        }),
    });
    realm.window = realm;
    return { realm, events, scrolls };
}

async function publicWheel(mode, scenario, options = {}) {
    const tab = { id: 53103, active: false, url: 'https://example.com/c31-wheel' };
    const documents = { 'document-a': options.document ?? wheelRealm(), 'document-b': wheelRealm() };
    let currentDocumentId = 'document-a';
    const injections = [];
    const commands = [];
    const chrome = {
        webNavigation: {
            getFrame: async () => (currentDocumentId ? { frameId: 17, documentId: currentDocumentId } : null),
        },
        scripting: {
            executeScript: async (request) => {
                const phase = request.args ? 'action' : 'helper';
                injections.push({ phase, target: globalThis.structuredClone(request.target) });
                const documentId = request.target.documentIds?.[0] ?? currentDocumentId;
                if (!documentId || documentId !== currentDocumentId) {
                    throw Error(`No document with id ${documentId} in tab with id ${tab.id}`);
                }
                const result = vm.runInContext(
                    `(${request.func.toString()})`,
                    documents[documentId].realm
                )(...(request.args ?? []));
                if (phase === 'helper' && scenario === 'after-helper') {
                    currentDocumentId = 'document-b';
                }
                if (phase === 'action' && scenario === 'after-effect-rejection') {
                    throw Error('Execution context was destroyed after wheel dispatch');
                }
                return [{ frameId: 17, documentId, result }];
            },
        },
    };
    const errors = extensionModule('types/expected-errors', {});
    const schemas = extensionModule('types/schemas', { zod: { z } });
    const { InputEventHandler } = extensionModule(
        'background/input-event-handler',
        {
            '../../../src/core/dom-helpers.js': { installDomHelpers },
            '../types/expected-errors': errors,
            '../types/schemas': schemas,
            './action-utils': {
                getTargetTabId: async (id) => id,
                assertManagedTab: async () => tab,
                assertActionActive: (context) => {
                    assert.equal(context.signal?.aborted ?? false, false);
                    assert.ok(Date.now() < context.deadline);
                },
            },
            './debugger-manager': {},
            './navigation-handler': {
                remainingNavigationTimeout: (deadline) => {
                    assert.ok(Date.now() < deadline);
                    return deadline - Date.now();
                },
            },
        },
        { chrome }
    );
    const handler = new InputEventHandler({ ensureAttached: () => assert.fail('Wheel must not attach debugger') });
    const httpServer = new ExtensionHttpServer({
        requestContext: () => getUnifiedSession().tabLockContext.getStore(),
    });
    const execute = async (action, params) => {
        if (action === 'resolve_frame') {
            if (scenario === 'after-resolve') {
                currentDocumentId = 'document-b';
            } else if (scenario === 'removed') {
                currentDocumentId = null;
            }
            return { frameId: 17, offset: { x: 120, y: 60 }, frameContext: { documentId: 'document-a' } };
        }
        assert.equal(action, 'input_mouse');
        return handler.inputMouse(params, {
            mcpTabGroupId: null,
            mcpWindowId: null,
            deadline: params.deadline,
        });
    };
    const sendCommand = httpServer.sendCommand.bind(httpServer);
    httpServer.sendCommand = (action, params, timeout) => {
        commands.push({ action, params, timeout });
        return sendCommand(action, params, timeout);
    };
    httpServer.helloReceived = true;
    httpServer.clientSocket = {
        readyState: 1,
        close() {},
        send(text) {
            const message = JSON.parse(text);
            if (message.type === 'cancel') {
                return;
            }
            void execute(message.action, message.params).then(
                (data) => httpServer.handleMessage(JSON.stringify({ id: message.id, success: true, data })),
                (error) =>
                    httpServer.handleMessage(JSON.stringify({ id: message.id, success: false, error: error.message }))
            );
        },
    };
    const bridge = Object.assign(Object.create(ExtensionBridge.prototype), {
        currentTabId: tab.id,
        currentFrameId: 3,
        currentFrameDocumentId: 'previous-document',
        httpServer,
    });
    const session = getUnifiedSession();
    const previousOffset = { x: 9, y: 11 };
    const overrides = {
        extensionBridge: bridge,
        inputMode: mode,
        currentFrameOffset: previousOffset,
        getDriver: async () => bridge,
        getMode: () => 'extension',
        getCurrentTargetId: () => String(tab.id),
        getTargetRestoration: () => undefined,
        getPageSnapshot: async () => ({ targetId: String(tab.id), url: tab.url, revision: 'r1' }),
        listTargets: async () => [{ targetId: String(tab.id) }],
        listTopology: async () => ({ activeTargetId: String(tab.id) }),
        withTabId: async (_target, fn) => fn(),
        withInputCleanup: async (fn) => fn(),
        hasBrowserEventObservation: () => false,
        getChallengeState: async () => null,
        getState: () => ({ title: 'Wheel fixture', url: tab.url }),
        getLiveState: async () => ({ title: 'Wheel fixture', url: tab.url }),
        inspectChallenge: async () => ({
            inspected: true,
            title: 'Wheel fixture',
            url: tab.url,
            selectorHits: [],
            deniedHits: [],
            textHits: [],
            originResponsePending: false,
            turnstilePresent: false,
            clickPoint: null,
            clickTargetKind: null,
        }),
    };
    const descriptors = new Map(
        Object.keys(overrides).map((key) => [key, Object.getOwnPropertyDescriptor(session, key)])
    );
    Object.assign(session, overrides);
    let input;
    registerInputTool({
        registerTool: (_name, _config, callback) => {
            input = callback;
        },
    });
    try {
        const response = await input({
            targetId: String(tab.id),
            frame: 'iframe#owned',
            timeout: 1000,
            events: [options.event ?? { type: 'wheel', target: { x: 40, y: 30 }, deltaX: 5, deltaY: 25 }],
        });
        const payload = JSON.parse(response.content[0].text);
        const expectedStatus =
            scenario === 'unchanged' ? 'completed' : scenario === 'after-effect-rejection' ? 'unknown' : 'not_started';
        assert.equal(payload.actionStatus, expectedStatus, response.content[0].text);
        assert.equal(
            payload.actionExecuted,
            expectedStatus === 'completed' ? true : expectedStatus === 'unknown' ? 'unknown' : false
        );
        assert.equal(payload.eventsExecuted, scenario === 'unchanged' ? 1 : 0);
        if (options.verify) {
            await options.verify({ payload, commands, injections, document: documents['document-a'] });
            return;
        }
        for (const [documentId, expected] of [
            ['document-a', ['unchanged', 'after-effect-rejection'].includes(scenario) ? 1 : 0],
            ['document-b', 0],
        ]) {
            assert.equal(documents[documentId].events.length, expected, `${mode}/${scenario}/${documentId} wheel`);
            assert.equal(documents[documentId].scrolls.length, expected, `${mode}/${scenario}/${documentId} scroll`);
        }
        for (const { target } of injections) {
            assert.deepEqual(target, { tabId: tab.id, documentIds: ['document-a'] });
        }
        const wheel = commands.find(({ action }) => action === 'input_mouse');
        assert.deepEqual([wheel.params.x, wheel.params.y], [40, 30]);
        assert.equal(wheel.params.documentId, 'document-a');
        assert.ok(wheel.timeout > 0 && wheel.timeout <= 1000);
        assert.ok(Number.isFinite(wheel.params.deadline));
        assert.equal(bridge.getCurrentFrameId(), 3);
        assert.equal(bridge.getCurrentFrameDocumentId(), 'previous-document');
        assert.equal(session.getFrameOffset(), previousOffset);
    } finally {
        await httpServer.stop();
        for (const [key, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(session, key, descriptor);
            } else {
                delete session[key];
            }
        }
    }
}

for (const mode of ['precise', 'stealth']) {
    for (const scenario of ['unchanged', 'after-resolve', 'after-helper', 'removed', 'after-effect-rejection']) {
        test(`C31-03 public input ${mode}/${scenario} reaches the production wheel handler and restores frame identity`, async () => {
            await publicWheel(mode, scenario);
        });
    }
}

function scrollingRealm({ axis = 'x', delta = 200, shadow = false, cancelAt, atBoundary = false } = {}) {
    const events = [];
    const scrolls = [];
    const received = [];
    const document = {};
    const node = (name, parentElement, overflowX = 'hidden', overflowY = 'hidden') => ({
        name,
        parentElement,
        currentCSSZoom: 1,
        scrollWidth: 1000,
        clientWidth: 100,
        scrollHeight: 1000,
        clientHeight: 100,
        scrollLeft: delta < 0 ? 400 : 0,
        scrollTop: delta < 0 ? 400 : 0,
        style: {
            overflowX,
            overflowY,
            direction: 'ltr',
            display: 'block',
            position: 'static',
            contain: 'none',
            containerType: 'normal',
            contentVisibility: 'visible',
            willChange: 'auto',
        },
        getRootNode: () => document,
        getClientRects() {
            return ['none', 'contents'].includes(this.style.display) ? [] : [{}];
        },
        scrollBy({ left: x, top: y, behavior }) {
            assert.equal(behavior, 'instant');
            const beforeX = this.scrollLeft;
            const beforeY = this.scrollTop;
            this.scrollLeft = Math.max(
                this.minX ?? 0,
                Math.min(this.maxX ?? this.scrollWidth - this.clientWidth, beforeX + x)
            );
            this.scrollTop = Math.max(
                this.minY ?? 0,
                Math.min(this.maxY ?? this.scrollHeight - this.clientHeight, beforeY + y)
            );
            if (this.scrollLeft !== beforeX || this.scrollTop !== beforeY) {
                scrolls.push({ name, x, y });
            }
        },
    });
    const html = node('html', null, 'visible', 'visible');
    Object.assign(html, { localName: 'html', namespaceURI: 'http://www.w3.org/1999/xhtml' });
    const body = node('body', html, 'visible', 'visible');
    body.localName = 'body';
    const viewport = { x: 0, y: 0 };
    const outer = node('outer', body, 'auto', 'auto');
    const host = node('host', outer);
    const root = { host };
    const container = node(
        'container',
        shadow ? null : host,
        axis === 'x' ? 'auto' : 'hidden',
        axis === 'y' ? 'auto' : 'hidden'
    );
    if (axis === 'x') {
        container.scrollHeight = container.clientHeight;
        container.scrollTop = 0;
    } else {
        container.scrollWidth = container.clientWidth;
        container.scrollLeft = 0;
    }
    if (shadow) {
        container.getRootNode = () => root;
    }
    const inner = node('inner', container);
    if (atBoundary) {
        container[axis === 'x' ? 'scrollLeft' : 'scrollTop'] = delta < 0 ? 0 : 900;
    }
    inner.dispatchEvent = (event) => {
        events.push(event);
        for (const name of shadow
            ? ['inner', 'container', 'root', 'host', 'outer', 'document']
            : ['inner', 'container', 'host', 'outer', 'document']) {
            if (name === 'host' && shadow && !event.composed) {
                break;
            }
            received.push(name);
            if (name === cancelAt) {
                event.preventDefault();
            }
        }
        return !event.defaultPrevented;
    };
    Object.assign(document, { documentElement: html, body, elementFromPoint: () => inner });
    const realm = vm.createContext({
        document,
        WheelEvent: class extends globalThis.Event {
            constructor(type, options) {
                super(type, options);
                const { deltaX, deltaY, deltaMode, clientX, clientY } = options;
                Object.assign(this, { deltaX, deltaY, deltaMode, clientX, clientY });
            }
        },
        getComputedStyle: (element) => element.style,
        scrollBy: ({ left: x, top: y }) => {
            viewport.x += x;
            viewport.y += y;
            scrolls.push({ name: 'viewport', x, y });
        },
    });
    Object.defineProperties(realm, {
        scrollX: { get: () => viewport.x },
        scrollY: { get: () => viewport.y },
    });
    realm.window = realm;
    return { realm, events, scrolls, received, inner, container, outer, html, body, viewport };
}

for (const mode of ['precise', 'stealth']) {
    for (const axis of ['x', 'y']) {
        for (const delta of [200, -200]) {
            for (const atBoundary of [false, true]) {
                test(`C31F-03A public ${mode} ${axis}/${delta} chooses the ancestor with remaining range; boundary=${atBoundary}`, async () => {
                    const document = scrollingRealm({ axis, delta, atBoundary });
                    await publicWheel(mode, 'unchanged', {
                        document,
                        event: { type: 'wheel', target: { x: 40, y: 30 }, [axis === 'x' ? 'deltaX' : 'deltaY']: delta },
                        verify({ payload, injections }) {
                            assert.equal(payload.retryable, false);
                            assert.deepEqual(document.scrolls, [
                                {
                                    name: atBoundary ? 'outer' : 'container',
                                    x: axis === 'x' ? delta : 0,
                                    y: axis === 'y' ? delta : 0,
                                },
                            ]);
                            assert.equal(document.events.length, 1);
                            assert.deepEqual([document.events[0].clientX, document.events[0].clientY], [40, 30]);
                            assert.ok(injections.every(({ target }) => target.documentIds[0] === 'document-a'));
                        },
                    });
                });
            }
        }
    }
    for (const shadow of [false, true]) {
        for (const cancelAt of [undefined, 'inner', 'container', 'host', 'document']) {
            test(`C31F-03B/C public ${mode} shadow=${shadow} cancel=${cancelAt ?? 'none'} preserves propagation and default action`, async () => {
                const document = scrollingRealm({ axis: 'y', shadow, cancelAt });
                await publicWheel(mode, 'unchanged', {
                    document,
                    event: { type: 'wheel', target: { x: 40, y: 30 }, deltaY: 200 },
                    verify({ payload }) {
                        assert.equal(payload.actionStatus, 'completed');
                        assert.equal(payload.actionExecuted, true);
                        assert.equal(payload.eventsExecuted, 1);
                        assert.equal(document.events.length, 1);
                        const event = document.events[0];
                        assert.equal(event.composed, true);
                        assert.equal(event.bubbles, true);
                        assert.equal(event.cancelable, true);
                        assert.equal(event.defaultPrevented, Boolean(cancelAt));
                        assert.ok(document.received.includes('host'));
                        assert.ok(document.received.includes('document'));
                        assert.equal(document.scrolls.length, cancelAt ? 0 : 1);
                        assert.equal(document.container.scrollTop, cancelAt ? 0 : 200);
                    },
                });
            });
        }
    }
}

for (const mode of ['precise', 'stealth']) {
    for (const axis of ['x', 'y']) {
        for (const start of [0, -300, -900]) {
            for (const delta of [-200, 200]) {
                test(`C31F2-02 public ${mode} ${axis} negative range ${start}/${delta} uses actual movement`, async () => {
                    const document = scrollingRealm({ axis, delta });
                    const property = axis === 'x' ? 'scrollLeft' : 'scrollTop';
                    if (axis === 'x') {
                        document.container.style.direction = 'rtl';
                    } else {
                        Object.assign(document.container.style, { display: 'flex', flexDirection: 'column-reverse' });
                    }
                    document.container[axis === 'x' ? 'minX' : 'minY'] = -900;
                    document.container[axis === 'x' ? 'maxX' : 'maxY'] = 0;
                    document.container[property] = start;
                    document.outer[property] = 400;
                    const end = Math.max(-900, Math.min(0, start + delta));
                    await publicWheel(mode, 'unchanged', {
                        document,
                        event: { type: 'wheel', target: { x: 40, y: 30 }, [axis === 'x' ? 'deltaX' : 'deltaY']: delta },
                        verify() {
                            assert.equal(document.container[property], end);
                            assert.equal(document.outer[property], end === start ? 400 + delta : 400);
                            assert.equal(document.events.length, 1);
                        },
                    });
                });
            }
        }
        for (const policy of ['auto', 'contain', 'none']) {
            for (const delta of [-200, 200]) {
                for (const boundary of [false, true]) {
                    test(`C31F2-03 public ${mode} ${axis}/${policy}/${delta} boundary=${boundary} preserves chaining`, async () => {
                        const document = scrollingRealm({ axis, delta });
                        const property = axis === 'x' ? 'scrollLeft' : 'scrollTop';
                        document.container[property] = boundary ? (delta > 0 ? 900 : 0) : 400;
                        document.outer[property] = 400;
                        document.container.style[axis === 'x' ? 'overscrollBehaviorX' : 'overscrollBehaviorY'] = policy;
                        await publicWheel(mode, 'unchanged', {
                            document,
                            event: {
                                type: 'wheel',
                                target: { x: 40, y: 30 },
                                [axis === 'x' ? 'deltaX' : 'deltaY']: delta,
                            },
                            verify({ payload }) {
                                assert.equal(
                                    document.outer[property],
                                    boundary && policy === 'auto' ? 400 + delta : 400
                                );
                                assert.equal(
                                    document.container[property],
                                    boundary ? (delta > 0 ? 900 : 0) : 400 + delta
                                );
                                assert.equal(payload.actionStatus, 'completed');
                                assert.equal(document.events.length, 1);
                            },
                        });
                    });
                }
            }
        }
    }
    for (const blockedAxis of ['x', 'y']) {
        for (const policy of ['contain', 'none']) {
            test(`C31F2-03 public ${mode} mixed axes block only ${blockedAxis}/${policy}`, async () => {
                const document = scrollingRealm({ axis: 'x' });
                Object.assign(document.container, { scrollLeft: 900, scrollTop: 900, scrollHeight: 1000 });
                Object.assign(document.outer, { scrollLeft: 400, scrollTop: 400 });
                document.container.style.overflowY = 'auto';
                document.container.style[blockedAxis === 'x' ? 'overscrollBehaviorX' : 'overscrollBehaviorY'] = policy;
                await publicWheel(mode, 'unchanged', {
                    document,
                    event: { type: 'wheel', target: { x: 40, y: 30 }, deltaX: 200, deltaY: 200 },
                    verify() {
                        assert.equal(document.outer.scrollLeft, blockedAxis === 'x' ? 400 : 600);
                        assert.equal(document.outer.scrollTop, blockedAxis === 'y' ? 400 : 600);
                        assert.equal(document.container.scrollLeft, 900);
                        assert.equal(document.container.scrollTop, 900);
                    },
                });
            });
        }
    }
}

for (const mode of ['precise', 'stealth']) {
    for (const [display, overflow, policy, scrollBox] of [
        ['flow-root list-item', 'auto', 'auto', true],
        ['inline flow-root list-item', 'auto', 'auto', true],
        ['-webkit-box', 'auto', 'auto', true],
        ['-webkit-inline-box', 'auto', 'auto', true],
        ['flow-root list-item', 'hidden', 'contain', true],
        ['inline flow-root list-item', 'hidden', 'none', true],
        ['flow-root', 'auto', 'auto', true],
        ['inline list-item', 'hidden', 'contain', false],
        ['inline', 'hidden', 'contain', false],
        ['block', 'hidden', 'contain', true],
        ['block ruby', 'auto', 'auto', true],
        ['block ruby', 'hidden', 'contain', true],
        ['ruby', 'auto', 'auto', false],
        ['ruby', 'hidden', 'contain', false],
    ]) {
        for (const axis of ['x', 'y']) {
            for (const delta of [-200, 200]) {
                test(`C31F5-01 public ${mode} ${display}/${overflow}/${policy} ${axis}/${delta} follows its principal box`, async () => {
                    const document = scrollingRealm({ axis, delta });
                    const property = axis === 'x' ? 'scrollLeft' : 'scrollTop';
                    document.container[property] = document.outer[property] = 400;
                    Object.assign(document.container.style, {
                        display,
                        [axis === 'x' ? 'overflowX' : 'overflowY']: overflow,
                        [axis === 'x' ? 'overscrollBehaviorX' : 'overscrollBehaviorY']: policy,
                    });
                    await publicWheel(mode, 'unchanged', {
                        document,
                        event: { type: 'wheel', target: { x: 40, y: 30 }, [axis === 'x' ? 'deltaX' : 'deltaY']: delta },
                        verify() {
                            assert.equal(
                                document.container[property],
                                scrollBox && overflow === 'auto' ? 400 + delta : 400
                            );
                            assert.equal(document.outer[property], scrollBox ? 400 : 400 + delta);
                        },
                    });
                });
            }
        }
    }
    for (const [display, property, value, establishes] of [
        ['inline list-item', 'transform', 'matrix(1,0,0,1,0,0)', false],
        ['inline list-item', 'contain', 'layout', false],
        ['block', 'willChange', 'contain', true],
        ['inline', 'transform', 'matrix(1,0,0,1,0,0)', false],
        ['inline-block', 'transform', 'matrix(1,0,0,1,0,0)', true],
        ['block', 'willChange', 'content-visibility', false],
        ['block', 'willChange', 'filter', true],
        ['inline flow-root list-item', 'willChange', 'contain', true],
    ]) {
        for (const position of ['absolute', 'fixed']) {
            for (const shadow of [false, true]) {
                test(`C31F5-02 public ${mode} ${position}/${display}/${property}/${value}/shadow=${shadow} keeps the actual containing block`, async () => {
                    const document = scrollingRealm({ axis: 'y', shadow });
                    document.inner.style.position = position;
                    document.container.style.overflowY = 'visible';
                    document.outer.scrollTop = 400;
                    Object.assign(document.container.style, { display, [property]: value });
                    if (establishes && !shadow) {
                        document.inner.offsetParent = document.container;
                    }
                    await publicWheel(mode, 'unchanged', {
                        document,
                        event: { type: 'wheel', target: { x: 40, y: 30 }, deltaY: 200 },
                        verify() {
                            assert.equal(document.outer.scrollTop, establishes ? 600 : 400);
                            assert.equal(document.viewport.y, establishes ? 0 : 200);
                        },
                    });
                });
            }
        }
    }
    for (const side of ['html', 'body']) {
        for (const [display, independent] of side === 'html'
            ? [
                  ['list-item', true],
                  ['flow-root list-item', true],
              ]
            : [
                  ['inline list-item', false],
                  ['inline', false],
                  ['flow-root list-item', true],
                  ['inline flow-root list-item', true],
              ]) {
            test(`C31F5-02 public ${mode} ${side}/${display} shares containment eligibility with body propagation`, async () => {
                const document = scrollingRealm({ axis: 'y' });
                for (const node of [document.inner, document.container, document.outer]) {
                    Object.assign(node.style, { overflowX: 'visible', overflowY: 'visible' });
                }
                Object.assign(document[side].style, { display, contain: 'layout' });
                document.body.style.overflowX = document.body.style.overflowY = 'hidden';
                document.body.scrollTop = document.viewport.y = 400;
                await publicWheel(mode, 'unchanged', {
                    document,
                    event: { type: 'wheel', target: { x: 40, y: 30 }, deltaY: 200 },
                    verify() {
                        assert.equal(document.body.scrollTop, 400);
                        assert.equal(document.viewport.y, independent ? 600 : 400);
                    },
                });
            });
        }
    }
}

for (const mode of ['precise', 'stealth']) {
    for (const [side, property, value, independent] of [
        ['body', 'contain', 'layout', true],
        ['body', 'contain', 'paint', true],
        ['body', 'contain', 'style', true],
        ['body', 'contain', 'inline-size', true],
        ['html', 'contain', 'layout', true],
        ['html', 'contain', 'strict', true],
        ['body', 'contentVisibility', 'auto', true],
        ['body', 'containerType', 'inline-size', true],
        ['body', 'containerType', 'scroll-state', false],
        ['body', 'contain', 'none', false],
    ]) {
        test(`C31F4-03 public ${mode} ${side}/${property}/${value} uses effective containment for overflow propagation`, async () => {
            const document = scrollingRealm({ axis: 'y' });
            for (const node of [document.inner, document.container, document.outer]) {
                Object.assign(node.style, { overflowX: 'visible', overflowY: 'visible' });
            }
            document[side].style[property] = value;
            document.body.style.overflowX = document.body.style.overflowY = 'auto';
            document.body.scrollTop = 400;
            document.viewport.y = 400;
            await publicWheel(mode, 'unchanged', {
                document,
                event: { type: 'wheel', target: { x: 40, y: 30 }, deltaY: 200 },
                verify() {
                    assert.equal(document.body.scrollTop, independent ? 600 : 400);
                    assert.equal(document.viewport.y, independent ? 400 : 600);
                },
            });
        });
    }
    for (const display of ['inline', 'contents', 'block']) {
        for (const overflow of ['hidden', 'auto']) {
            for (const policy of ['contain', 'none']) {
                test(`C31F4-04 public ${mode} ${display}/${overflow}/${policy} only consumes a real scrolling box boundary`, async () => {
                    const document = scrollingRealm({ axis: 'y' });
                    document.outer.scrollTop = 400;
                    Object.assign(document.container.style, {
                        display,
                        overflowY: overflow,
                        overscrollBehaviorY: policy,
                    });
                    document.container.scrollTop = 0;
                    document.container.scrollHeight = document.container.clientHeight;
                    await publicWheel(mode, 'unchanged', {
                        document,
                        event: { type: 'wheel', target: { x: 40, y: 30 }, deltaY: 200 },
                        verify() {
                            assert.equal(document.container.scrollTop, 0);
                            assert.equal(document.outer.scrollTop, display === 'block' ? 400 : 600);
                        },
                    });
                });
            }
        }
    }
    for (const [position, containing, self, shadow] of [
        ['fixed', 'none', false, false],
        ['absolute', 'none', false, false],
        ['static', 'none', false, false],
        ['fixed', 'transform', false, false],
        ['fixed', 'contain', false, false],
        ['fixed', 'none', true, false],
        ['fixed', 'none', false, true],
        ['fixed', 'transform', false, true],
    ]) {
        test(`C31F4-05 public ${mode} ${position}/${containing}/self=${self}/shadow=${shadow} follows its containing block`, async () => {
            const document = scrollingRealm({ axis: 'y', shadow });
            document.inner.style.position = position;
            document.outer.scrollTop = 400;
            if (containing === 'transform') {
                document.outer.style.transform = 'matrix(1,0,0,1,0,0)';
            }
            if (containing === 'contain') {
                document.outer.style.contain = 'layout';
            }
            if (containing !== 'none' && !shadow) {
                document.inner.offsetParent = document.outer;
            }
            if (self) {
                document.inner.style.overflowY = 'auto';
            }
            await publicWheel(mode, 'unchanged', {
                document,
                event: { type: 'wheel', target: { x: 40, y: 30 }, deltaY: 200 },
                verify() {
                    assert.equal(document.inner.scrollTop, self ? 200 : 0);
                    assert.equal(document.outer.scrollTop, !self && containing !== 'none' ? 600 : 400);
                    assert.equal(document.container.scrollTop, position === 'static' ? 200 : 0);
                    assert.equal(
                        document.viewport.y,
                        !self && position !== 'static' && containing === 'none' ? 200 : 0
                    );
                },
            });
        });
    }
    for (const axis of ['x', 'y']) {
        for (const delta of [-200, 200]) {
            for (const [kind, allowed] of [
                ['body-auto', true],
                ['body-contain', true],
                ['body-none', true],
                ['body-hidden', false],
                ['root-hidden', false],
                ['root-auto-contain', true],
                ['independent-body', false],
            ]) {
                test(`C31F3-04 public ${mode} ${kind} ${axis}/${delta} distinguishes body and viewport`, async () => {
                    const document = scrollingRealm({ axis, delta });
                    for (const node of [document.inner, document.container, document.outer]) {
                        Object.assign(node.style, { overflowX: 'visible', overflowY: 'visible' });
                    }
                    const property = axis === 'x' ? 'scrollLeft' : 'scrollTop';
                    document.viewport[axis] = 400;
                    document.body[property] = 400;
                    document.html.style.overflowX = document.html.style.overflowY =
                        kind.startsWith('root-') || kind === 'independent-body'
                            ? kind === 'root-hidden'
                                ? 'hidden'
                                : 'auto'
                            : 'visible';
                    document.body.style.overflowX = document.body.style.overflowY =
                        kind.startsWith('body-') || kind === 'independent-body'
                            ? kind === 'body-hidden'
                                ? 'hidden'
                                : 'auto'
                            : 'visible';
                    document.body.style[axis === 'x' ? 'overscrollBehaviorX' : 'overscrollBehaviorY'] =
                        kind === 'body-none' ? 'none' : kind === 'body-contain' ? 'contain' : 'auto';
                    await publicWheel(mode, 'unchanged', {
                        document,
                        event: { type: 'wheel', target: { x: 40, y: 30 }, [axis === 'x' ? 'deltaX' : 'deltaY']: delta },
                        verify() {
                            assert.equal(document.viewport[axis], allowed ? 400 + delta : 400);
                            assert.equal(document.body[property], kind === 'independent-body' ? 400 + delta : 400);
                            assert.equal(document.events.length, 1);
                        },
                    });
                });
            }
            for (const overflow of ['hidden', 'clip', 'visible']) {
                for (const policy of ['auto', 'contain', 'none']) {
                    test(`C31F3-05 public ${mode} ${overflow}/${policy} ${axis}/${delta} separates user scrolling from chain boundary`, async () => {
                        const document = scrollingRealm({ axis, delta });
                        const property = axis === 'x' ? 'scrollLeft' : 'scrollTop';
                        document.outer[property] = 400;
                        document.container[property] = 0;
                        document.container.style[axis === 'x' ? 'overflowX' : 'overflowY'] = overflow;
                        document.container.style[axis === 'x' ? 'overscrollBehaviorX' : 'overscrollBehaviorY'] = policy;
                        await publicWheel(mode, 'unchanged', {
                            document,
                            event: {
                                type: 'wheel',
                                target: { x: 40, y: 30 },
                                [axis === 'x' ? 'deltaX' : 'deltaY']: delta,
                            },
                            verify() {
                                assert.equal(document.container[property], 0);
                                assert.equal(
                                    document.outer[property],
                                    overflow === 'hidden' && policy !== 'auto' ? 400 : 400 + delta
                                );
                            },
                        });
                    });
                }
            }
        }
    }
}
