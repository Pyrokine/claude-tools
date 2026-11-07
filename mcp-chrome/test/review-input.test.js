import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { EventEmitter, getEventListeners } from 'node:events';
import { performance } from 'node:perf_hooks';
import { ExtensionHttpServer } from '../dist/extension/http-server.js';
import { getSession, getUnifiedSession } from '../dist/core/index.js';
import {
    CDPError,
    formatErrorResponse,
    setErrorSource,
    StructuredToolError,
    TimeoutError,
} from '../dist/core/errors.js';
import { classifyEvaluateFailure } from '../dist/tools/evaluate.js';
import { installDomHelpers } from '../dist/core/dom-helpers.js';
import { ExtensionBridge } from '../dist/extension/bridge.js';
import { registerInputTool } from '../dist/tools/input.js';
import { waitForPostCondition } from '../dist/tools/post-condition.js';

function override(object, values) {
    const descriptors = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(object, key)]));
    Object.assign(object, values);
    return () => {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(object, key, descriptor);
            } else {
                delete object[key];
            }
        }
    };
}

async function withInput(overrides, action) {
    const session = getUnifiedSession();
    const restore = override(session, {
        getMode: () => 'extension',
        getCurrentTargetId: () => '801',
        getTargetRestoration: () => undefined,
        getPageSnapshot: async (targetId) => ({ targetId, url: 'https://example.com/input', revision: 'r1' }),
        listTargets: async () => [{ targetId: '801' }],
        listTopology: async () => ({ activeTargetId: '801' }),
        withTabId: async (_target, fn) => fn(),
        withInputCleanup: async (fn) => fn(),
        prepareKeyboardFocus: async () => undefined,
        withPageCondition: async (_condition, fn) => fn(),
        withFrame: async (_frame, fn) => fn(),
        hasBrowserEventObservation: () => false,
        getChallengeState: async () => null,
        getState: () => ({ title: 'Input fixture', url: 'https://example.com/input' }),
        getLiveState: async () => ({ title: 'Input fixture', url: 'https://example.com/input' }),
        inspectChallenge: async () => ({
            title: 'Input fixture',
            url: 'https://example.com/input',
            inspected: true,
            selectorHits: [],
            deniedHits: [],
            textHits: [],
            originResponsePending: false,
            turnstilePresent: false,
            clickPoint: null,
            clickTargetKind: null,
        }),
        getFrameOffset: () => null,
        getInputMode: () => 'precise',
        ...overrides,
    });
    let handler;
    registerInputTool({
        registerTool: (_name, _config, callback) => {
            handler = callback;
        },
    });
    try {
        await action(handler, session);
    } finally {
        restore();
    }
}

test('C31F6 late native release keeps the restored target and rejects a mismatched original frame', async () => {
    const session = getSession();
    const sent = [];
    const restore = override(session, {
        cdp: {
            isConnected: true,
            send: async (...args) => {
                sent.push(args);
            },
        },
        currentTargetId: 'default',
        sessionId: 'default-session',
        modifiers: 2,
        targetSessions: new Map([['input', 'input-session']]),
        frameScopes: new Map([
            [11, { targetId: 'input', sessionId: 'original-frame-session' }],
            [12, { targetId: 'other', sessionId: 'other-session' }],
        ]),
        revisions: new Map(),
    });
    try {
        await session.keyUp('Shift', 50, { targetId: 'input', frameId: 11, modifiers: 2 });
        assert.equal(sent.length, 1);
        assert.equal(sent[0][0], 'Input.dispatchKeyEvent');
        assert.equal(sent[0][1].type, 'keyUp');
        assert.equal(sent[0][1].modifiers, 2);
        assert.equal(sent[0][2], 'original-frame-session');
        assert.equal(sent[0][3], 50);
        assert.equal(session.currentTargetId, 'default');
        assert.equal(session.sessionId, 'default-session');
        assert.equal(session.modifiers, 2);
        await assert.rejects(
            () => session.keyUp('Shift', 50, { targetId: 'input', frameId: 12, modifiers: 2 }),
            /Original input session is no longer available/
        );
        assert.equal(sent.length, 1, 'A mismatched frame does not dispatch a release to another document');
    } finally {
        restore();
    }
});

test('C31F6 Extension dialog execution facts survive the production transport parser', async () => {
    const server = Object.create(ExtensionHttpServer.prototype);
    const detail = {
        error: {
            code: 'DIALOG_OPEN',
            message: 'Synthetic native prompt',
            context: {
                actionExecuted: 'unknown',
                actionStatus: 'unknown',
                retryable: false,
                ref: 'owned-dialog',
            },
        },
    };
    let failure;
    server.messageHandlers = new Map([
        [
            'owned-dialog',
            {
                resolve: () => assert.fail('Dialog failure resolved as success'),
                reject: (error) => {
                    failure = error;
                },
                cleanup() {},
            },
        ],
    ]);
    server.handleMessage(JSON.stringify({ id: 'owned-dialog', success: false, error: JSON.stringify(detail) }));
    assert.ok(failure instanceof StructuredToolError);
    assert.deepEqual(JSON.parse(formatErrorResponse(failure).content[0].text), detail);
    assert.equal(server.messageHandlers.size, 0);
    await withInput(
        {
            keyDown: async () => {
                getUnifiedSession().tabLockContext.getStore().userAction.dispatched = true;
                throw failure;
            },
        },
        async (handler) => {
            const body = JSON.parse((await handler({ events: [{ type: 'keydown', key: 'a' }] })).content[0].text);
            assert.equal(body.actionExecuted, 'unknown');
            assert.equal(body.actionStatus, 'unknown');
            assert.equal(body.retryable, false);
        }
    );
});

test('C31F6 trusted execution facts and page provenance override message heuristics', () => {
    for (const [error, expected] of [
        [
            new TimeoutError('CDP timeout before dispatch', {
                actionExecuted: false,
                actionStatus: 'not_started',
                retryable: false,
            }),
            { actionExecuted: false, actionStatus: 'not_started', failureStage: 'action', retryable: false },
        ],
        [
            new StructuredToolError('TIMEOUT', 'navigation timeout while waiting for an operation', 'read state', {
                actionExecuted: false,
                actionStatus: 'failed',
                failureStage: 'queue',
                retryable: false,
            }),
            { actionExecuted: false, actionStatus: 'failed', failureStage: 'queue', retryable: false },
        ],
        [
            new StructuredToolError('TIMEOUT', 'metadata timeout', 'read state', {
                actionExecuted: true,
                actionStatus: 'completed',
                failureStage: 'metadata',
                retryable: false,
            }),
            { actionExecuted: true, actionStatus: 'completed', failureStage: 'metadata', retryable: false },
        ],
        [
            setErrorSource(new Error('Request timeout in execution context'), 'page'),
            { actionExecuted: true, actionStatus: 'failed', failureStage: 'action', retryable: false },
        ],
    ]) {
        assert.deepEqual(classifyEvaluateFailure(error), expected);
    }
});

test('C31F6 postCondition keeps native protocol and page failures distinct from unavailable context', async () => {
    for (const [error, expected] of [
        [
            new CDPError('Runtime.callFunctionOn: execution context invalid', {
                protocolError: true,
                nativeCode: -32602,
            }),
            'error',
        ],
        [
            new CDPError('Runtime.callFunctionOn: Cannot find context with specified id', {
                errorSource: 'context',
                protocolError: true,
                nativeCode: -32000,
            }),
            'unavailable',
        ],
        [new CDPError('connection closed', { errorSource: 'transport' }), 'unavailable'],
        [setErrorSource(new Error('iframe disconnected'), 'page'), 'error'],
    ]) {
        const result = await waitForPostCondition(
            {
                evaluate: async () => {
                    throw error;
                },
            },
            { script: 'true', timeout: 100 },
            'test'
        );
        assert.equal(result.verificationStatus, expected);
        assert.equal(result.retryable, expected === 'unavailable');
    }
});

test('C31F6 an early final sleep wakeup does not dispatch an extra near-deadline read', async (context) => {
    let now = 0;
    let timers = 0;
    let reads = 0;
    const nativeTimer = globalThis.setTimeout;
    context.mock.method(Date, 'now', () => now);
    context.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
        if (++timers === 2) {
            return nativeTimer(() => {
                now = 69;
                callback(...args);
            }, 1);
        }
        if (timers === 3) {
            assert.equal(ms, 1);
            return nativeTimer(() => {
                now = 70;
                callback(...args);
            }, 1);
        }
        return nativeTimer(callback, ms, ...args);
    });
    const result = await waitForPostCondition(
        {
            evaluate: async () => {
                if (++reads > 1) {
                    throw new Error('Unexpected extra validation dispatch');
                }
                return { matched: false };
            },
        },
        { script: 'false', timeout: 70, interval: 100 },
        'test'
    );
    assert.equal(result.verificationStatus, 'not_matched');
    assert.equal(reads, 1);
    assert.equal(now, 70);
    assert.equal(timers, 3);
});

test('C31F6 cancelling a local verification wait removes its abort listener', async () => {
    const controller = new AbortController();
    let reads = 0;
    const started = performance.now();
    const waiting = waitForPostCondition(
        {
            evaluate: async () => {
                ++reads;
                return { matched: false };
            },
        },
        { script: 'false', timeout: 5000, interval: 2000 },
        'test',
        undefined,
        undefined,
        controller.signal
    );
    const timer = setTimeout(() => controller.abort(new Error('local wait cancelled')), 20);
    try {
        await assert.rejects(waiting, /local wait cancelled/);
        assert.ok(performance.now() - started < 300);
        assert.equal(reads, 1);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally {
        clearTimeout(timer);
    }
});

test('G038 completed input retains retryable=false when only verification may be retried', async () => {
    let actions = 0;
    await withInput(
        {
            keyDown: async () => {
                ++actions;
            },
            evaluate: async () => 0,
        },
        async (handler) => {
            const response = await handler({
                targetId: '801',
                expectedUrl: 'https://example.com/input',
                events: [{ type: 'keydown', key: 'a' }],
                postCondition: { selector: '#not-yet', timeout: 80, interval: 50 },
            });
            const payload = JSON.parse(response.content[0].text);
            assert.equal(payload.actionExecuted, true);
            assert.equal(payload.actionStatus, 'completed');
            assert.equal(payload.success, false);
            assert.equal(payload.failureStage, 'verification');
            assert.equal(payload.retryable, false);
            assert.equal(payload.postCondition.retryable, true);
            assert.equal(actions, 1);
        }
    );
});

test('G064 element actionability reasons do not suggest foreground activation', () => {
    for (const reason of [
        'not-connected',
        'not-visible',
        'not-enabled',
        'covered',
        'pointer-events-none',
        'not-in-viewport',
    ]) {
        const payload = JSON.parse(
            formatErrorResponse(
                new StructuredToolError(
                    'ACTIONABILITY_FAILED',
                    `Element is not actionable: ${reason}`,
                    '检查元素状态',
                    { reason, rect: {} }
                )
            ).content[0].text
        );
        assert.equal(payload.hint, undefined, reason);
        assert.equal(payload.error.context.reason, reason);
    }
    const pageHidden = JSON.parse(
        formatErrorResponse(
            new StructuredToolError('CAPTURE_FAILED', 'captureVisibleTab requires a visible page', '使用受控测试页', {
                reason: 'page-hidden',
            })
        ).content[0].text
    );
    assert.match(pageHidden.hint, /managed/);
});

test('G090 text, selector and URL reads recover native context/object loss without replaying actions', async () => {
    for (const [condition, value] of [
        [{ text: 'ready' }, { matched: true, actual: 'ready' }],
        [{ selector: '#ready' }, 1],
        [{ urlIncludes: '/ready' }, 'https://example.com/ready'],
    ]) {
        for (const message of [
            'Execution context was destroyed',
            'Cannot find context with specified id',
            'Could not find object with given id',
        ]) {
            let calls = 0;
            const budgets = [];
            const host = {
                evaluate: async (_code, _mode, timeout, _args, options) => {
                    ++calls;
                    budgets.push(timeout);
                    assert.equal(options.staleContextRetry, 'readOnly');
                    if (calls === 1) {
                        throw new Error(message);
                    }
                    return value;
                },
            };
            const result = await waitForPostCondition(host, { ...condition, timeout: 150, interval: 10 }, 'input');
            assert.equal(result.verificationStatus, 'matched', message);
            assert.equal(calls, 2);
            assert.ok(budgets[1] <= budgets[0] && budgets[0] <= 150);
        }
    }
});

test('G090 public input recovers a stale verification read after executing its action once', async () => {
    let actions = 0;
    let reads = 0;
    await withInput(
        {
            keyDown: async () => {
                ++actions;
            },
            evaluate: async () => {
                if (++reads === 1) {
                    throw new Error('Execution context was destroyed');
                }
                return 1;
            },
        },
        async (handler) => {
            const response = await handler({
                targetId: '801',
                expectedUrl: 'https://example.com/input',
                events: [{ type: 'keydown', key: 'a' }],
                timeout: 1000,
                postCondition: { selector: '#ready', timeout: 300, interval: 50 },
            });
            const payload = JSON.parse(response.content[0].text);
            assert.equal(payload.actionStatus, 'completed', response.content[0].text);
            assert.equal(payload.verificationStatus, 'matched');
            assert.equal(payload.retryable, false);
            assert.equal(actions, 1);
            assert.equal(reads, 2);
        }
    );
});

test('G090 persistent context loss reports unavailable within the original deadline', async () => {
    let calls = 0;
    const budgets = [];
    const result = await waitForPostCondition(
        {
            evaluate: async (_code, _mode, timeout) => {
                ++calls;
                budgets.push(timeout);
                throw new Error('Execution context was destroyed');
            },
        },
        { selector: '#ready', timeout: 1000, interval: 10 },
        'input',
        undefined,
        Date.now() + 45
    );
    assert.equal(result.verificationStatus, 'unavailable');
    assert.equal(result.retryable, true);
    assert.ok(calls >= 1);
    assert.ok(budgets.every((budget) => budget > 0 && budget <= 45));
    assert.match(result.error, /context was destroyed|timeout|budget exhausted/);
    const exhausted = await waitForPostCondition(
        {
            evaluate: async () => {
                throw new Error('unexpected dispatch');
            },
        },
        { selector: '#ready' },
        'input',
        undefined,
        Date.now() - 1
    );
    assert.equal(exhausted.verificationStatus, 'unavailable');
});

test('G090 a stalled read stops at the original verification budget without a second dispatch', async () => {
    let reads = 0;
    const result = await waitForPostCondition(
        {
            evaluate: () => {
                ++reads;
                return new Promise(() => {});
            },
        },
        { selector: '#ready', timeout: 30 },
        'input'
    );
    assert.equal(result.verificationStatus, 'unavailable');
    assert.equal(reads, 1);
});

test('G090 native failures during arbitrary script evaluation are not retried', async () => {
    for (const message of ['Execution context was destroyed', 'Could not find object with given id']) {
        let calls = 0;
        const result = await waitForPostCondition(
            {
                evaluate: async (_code, _mode, _timeout, _args, options) => {
                    ++calls;
                    assert.equal(options, undefined);
                    throw new Error(message);
                },
            },
            { script: '() => submitAgain()', timeout: 150, interval: 10 },
            'input'
        );
        assert.equal(result.verificationStatus, 'unavailable');
        assert.equal(calls, 1);
    }
    const scriptError = await waitForPostCondition(
        { evaluate: async () => ({ matched: false, error: 'Execution context was destroyed' }) },
        { script: '() => { throw new Error("Execution context was destroyed") }' },
        'input'
    );
    assert.equal(scriptError.verificationStatus, 'error');
    assert.equal(scriptError.retryable, false);
});

for (const elapsed of [69, 70]) {
    for (const [source, status] of [
        ['budget', 'unavailable'],
        ['rpc', 'unavailable'],
        ['script-throw', 'error'],
        ['script-reject', 'error'],
        ['untyped', 'error'],
    ]) {
        test(`C31F5-03 local ${source} at ${elapsed} ms uses error provenance`, async (context) => {
            const startedAt = Date.now();
            let now = startedAt;
            context.mock.method(Date, 'now', () => now);
            const message = 'navigation timeout: request budget exhausted';
            const host = {
                async evaluate(code, _mode, _timeout, args) {
                    now = startedAt + elapsed;
                    if (source === 'budget') {
                        throw new TimeoutError(message);
                    }
                    if (source === 'rpc') {
                        throw new StructuredToolError(
                            'EXECUTION_RESULT_UNKNOWN',
                            message,
                            'Read the page independently',
                            {
                                actionExecuted: 'unknown',
                                actionStatus: 'unknown',
                                failureStage: 'rpc',
                                retryable: false,
                            }
                        );
                    }
                    if (source === 'untyped') {
                        throw new Error(message);
                    }
                    return vm.runInNewContext(`(${code})`)(...args);
                },
            };
            const script =
                source === 'script-reject'
                    ? `Promise.reject(new Error(${JSON.stringify(message)}))`
                    : `() => { throw new Error(${JSON.stringify(message)}) }`;
            const result = await waitForPostCondition(host, { script, timeout: 70, interval: 50 }, 'input');
            assert.equal(result.verificationStatus, source === 'untyped' && elapsed === 70 ? 'unavailable' : status);
            assert.equal(result.retryable, result.verificationStatus === 'unavailable');
            assert.equal(result.elapsedMs, elapsed);
        });
    }
}

function textHost(renderedText, controls = [], bodyVisible = true) {
    class Input {
        constructor(value, { visible = true, type = 'text' } = {}) {
            Object.assign(this, { value, type, visible });
        }

        checkVisibility() {
            return this.visible;
        }
    }
    class Textarea extends Input {}
    class Select extends Input {
        constructor(values, options) {
            super('', options);
            this.selectedOptions = values.map((value) => ({ value, textContent: value }));
        }
    }
    const instances = controls.map(({ kind = 'input', value, ...options }) =>
        kind === 'select'
            ? new Select(value, options)
            : kind === 'textarea'
              ? new Textarea(value, options)
              : new Input(value, options)
    );
    const realm = vm.createContext({
        document: {
            body: {
                innerText: renderedText,
                textContent: 'hidden script style hidden-only',
                checkVisibility: () => bodyVisible,
                querySelectorAll: () => instances,
            },
        },
        HTMLInputElement: Input,
        HTMLTextAreaElement: Textarea,
        HTMLSelectElement: Select,
    });
    return { evaluate: async (code, _mode, _timeout, args) => vm.runInContext(`(${code})`, realm)(...args) };
}

test('G124 text checks use rendered text and visible non-password control values', async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const check = async (host, condition) => {
        const pending = waitForPostCondition(host, condition, 'input');
        await new Promise((resolve) => setImmediate(resolve));
        context.mock.timers.tick(condition.timeout);
        return pending;
    };
    const host = textHost('visible heading', [
        { value: 'hidden-control', visible: false },
        { value: 'password-only', type: 'password' },
        { value: 'visible-control' },
        { kind: 'textarea', value: 'textarea-value' },
        { kind: 'select', value: ['selected-value'] },
    ]);
    for (const text of ['visible heading', 'visible-control', 'textarea-value', 'selected-value']) {
        const result = await check(host, { text, exact: true, timeout: 50 });
        assert.equal(result.verificationStatus, 'matched', text);
        assert.ok(result.checks[0].actual.includes(text));
    }
    for (const text of ['hidden-only', 'hidden-control', 'password-only', 'heading']) {
        const result = await check(host, { text, exact: true, timeout: 10 });
        assert.equal(result.verificationStatus, 'not_matched', text);
    }
    const hiddenBody = await check(textHost('hidden-body', [], false), { text: 'hidden-body', timeout: 10 });
    assert.equal(hiddenBody.verificationStatus, 'not_matched');
});

test('G124 actual text is bounded around a successful match after the first 500 characters', async () => {
    for (const exact of [false, true]) {
        const rendered = `${'prefix '.repeat(200)}late-match${' suffix'.repeat(200)}`;
        const text = exact ? 'late-control-value' : 'late-match';
        const result = await waitForPostCondition(
            textHost(rendered, [{ value: 'late-control-value' }]),
            { text, exact, timeout: 50 },
            'input'
        );
        assert.equal(result.verificationStatus, 'matched');
        assert.ok(result.checks[0].actual.includes(text));
        assert.ok(result.checks[0].actual.length <= 500);
    }
});

test('C30-06 shared hit membership follows DOM parents, slots and nested Shadow hosts', () => {
    const realm = vm.createContext({});
    vm.runInContext(`(${installDomHelpers.toString()})()`, realm);
    const contains = realm.__mcpDomHelpers.containsComposed;
    const host = {};
    const shadow = { host };
    const nestedHost = { parentNode: shadow };
    const nestedShadow = { host: nestedHost };
    const leaf = { parentNode: nestedShadow };
    const slot = { parentNode: shadow };
    const slotted = { assignedSlot: slot, parentNode: {} };
    for (const node of [host, { parentNode: host }, leaf, slotted]) {
        assert.equal(contains(host, node), true);
    }
    for (const node of [null, {}, { parentNode: {} }]) {
        assert.equal(contains(host, node), false);
    }
    assert.equal(contains(leaf, host), false);
});

test('C30-08 coordinate wheel bypasses find and native mouse movement in either input mode and selected frame', async () => {
    for (const mode of ['precise', 'stealth']) {
        for (const frame of [undefined, 'iframe#owned']) {
            let selected;
            const wheels = [];
            await withInput(
                {
                    getInputMode: () => mode,
                    getFrameOffset: () => (frame ? { x: 120, y: 60 } : null),
                    withFrame: async (value, fn) => {
                        selected = value;
                        return fn();
                    },
                    find: async () => {
                        throw new Error('coordinate wheel must not find');
                    },
                    mouseMove: async () => {
                        throw new Error('wheel must not dispatch native mouse movement');
                    },
                    mouseWheel: async (...args) => {
                        wheels.push(args);
                    },
                },
                async (handler) => {
                    const response = await handler({
                        targetId: '801',
                        expectedUrl: 'https://example.com/input',
                        frame,
                        timeout: 1000,
                        events: [{ type: 'wheel', target: { x: 80, y: 40 }, deltaX: 15, deltaY: -35 }],
                    });
                    const payload = JSON.parse(response.content[0].text);
                    assert.equal(payload.actionStatus, 'completed', response.content[0].text);
                    assert.equal(selected, frame);
                    assert.equal(wheels.length, 1);
                    assert.deepEqual(wheels[0].slice(0, 2), [15, -35]);
                    assert.ok(wheels[0][2] > 0 && wheels[0][2] <= 1000);
                    assert.deepEqual(wheels[0][3], { x: 80, y: 40 });
                }
            );
        }
    }
});

test('C30-08 element and no-target wheel preserve ref scrolling and current-position semantics', async () => {
    const calls = [];
    await withInput(
        {
            find: async () => [{ refId: 'scroller' }],
            scroll: async (...args) => {
                calls.push(['scroll', ...args]);
            },
            mouseWheel: async (...args) => {
                calls.push(['wheel', ...args]);
            },
        },
        async (handler) => {
            const response = await handler({
                targetId: '801',
                expectedUrl: 'https://example.com/input',
                timeout: 1000,
                events: [
                    { type: 'wheel', target: { css: '#scroller' }, deltaY: 30 },
                    { type: 'wheel', deltaX: -10 },
                ],
            });
            assert.equal(JSON.parse(response.content[0].text).actionStatus, 'completed', response.content[0].text);
            assert.deepEqual(calls[0], ['scroll', 0, 30, 'scroller']);
            assert.deepEqual(calls[1].slice(0, 3), ['wheel', -10, 0]);
            assert.equal(calls[1][4], undefined);
        }
    );
});

test('C30-08 bridge sends local frame identity for mouse and wheel while preserving budget', async () => {
    const commands = [];
    const bridge = Object.assign(Object.create(ExtensionBridge.prototype), {
        currentTabId: 801,
        currentFrameId: 17,
        currentFrameDocumentId: 'owned-frame-document',
        httpServer: {
            sendCommand: async (...args) => {
                commands.push(args);
                return { success: true };
            },
        },
    });
    await bridge.inputMouse('mouseWheel', 80, 40, { deltaX: 15, deltaY: -35 }, 1000);
    await bridge.inputMouse('mouseMoved', 200, 100, {}, 1000);
    const [action, params, timeout] = commands[0];
    assert.equal(action, 'input_mouse');
    assert.equal(params.frameId, 17);
    assert.equal(params.documentId, 'owned-frame-document');
    assert.deepEqual([params.x, params.y, params.deltaX, params.deltaY], [80, 40, 15, -35]);
    assert.ok(timeout > 0 && timeout <= 1000);
    assert.equal(params.coordinateSpace, undefined);
    assert.equal(commands[1][1].frameId, 17);
    assert.equal(commands[1][1].documentId, 'owned-frame-document');
    assert.equal(commands[1][1].coordinateSpace, 'frame');
    assert.deepEqual([commands[1][1].x, commands[1][1].y], [200, 100]);
});

test('C30-03 bridge connection waiting forwards request cancellation and cleans listeners', async () => {
    const controller = new AbortController();
    const http = Object.assign(new EventEmitter(), {
        isConnected: () => false,
        waitForConnection: ExtensionHttpServer.prototype.waitForConnection,
    });
    const bridge = Object.assign(Object.create(ExtensionBridge.prototype), {
        options: { requestContext: () => ({ signal: controller.signal }) },
        httpServer: http,
    });
    const pending = bridge.waitForConnection(60_000);
    assert.equal(http.listenerCount('connected'), 1);
    const reason = new Error('owned request cancelled');
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(http.listenerCount('connected'), 0);
    await assert.rejects(bridge.waitForConnection(60_000), (error) => error === reason);
    assert.equal(http.listenerCount('connected'), 0);
    bridge.options = {};
    const connected = bridge.waitForConnection(60_000);
    http.emit('connected');
    assert.equal(await connected, true);
    assert.equal(http.listenerCount('connected'), 0);
    assert.equal(await bridge.waitForConnection(10), false);
    assert.equal(http.listenerCount('connected'), 0);
});

test('C30-08 cancelled input and exhausted input budget do not dispatch wheel', async () => {
    let wheels = 0;
    await withInput(
        {
            mouseWheel: async () => {
                ++wheels;
            },
        },
        async (handler) => {
            const controller = new AbortController();
            controller.abort(new Error('request cancelled'));
            const cancelled = await handler(
                { events: [{ type: 'wheel', target: { x: 1, y: 2 } }] },
                { signal: controller.signal }
            );
            assert.equal(cancelled.isError, true);
            const expired = await handler({ timeout: 0, events: [{ type: 'wheel', target: { x: 1, y: 2 } }] });
            assert.equal(expired.isError, true);
            assert.equal(wheels, 0);
        }
    );
});
