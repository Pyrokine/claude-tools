import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { getSession, getUnifiedSession } from '../dist/core/index.js';

import {
    focusCdpTarget,
    redactSensitiveInputData,
    registerInputTool,
    replaceNthOccurrence,
    supportsTextSelection,
} from '../dist/tools/input.js';
import { waitForPostCondition } from '../dist/tools/post-condition.js';
import { finishDiagnostics, startDiagnostics, withDiagnosticsResponse } from '../dist/tools/diagnostics.js';
import {
    classifyEvaluateActionError,
    classifyEvaluateFailure,
    registerEvaluateTool,
    resolveEvaluateMode,
    resolveStaleContextRetryPolicy,
} from '../dist/tools/evaluate.js';
import { boundInlineNetworkRequest, normalizeConsoleLog } from '../dist/tools/logs.js';
import { sanitizeUrl, sanitizeUrlRecord } from '../dist/tools/network-sanitizer.js';
import { EvaluateResultTooLargeError, NonSerializableEvaluateResultError } from '../dist/core/types.js';
import { resolveExtensionBundleStatus } from '../dist/extension/http-server.js';
import { summarizeTargetCandidates } from '../dist/tools/target-diagnostics.js';
import {
    CHALLENGE_INSPECT_SCRIPT,
    ChallengeDeniedError,
    challengeResultFields,
    ChallengeTimeoutError,
    classifyChallengeSnapshot,
    readChallengeSnapshot,
    waitForChallenge,
} from '../dist/tools/challenge.js';
import { OsMouseError } from '../dist/core/errors.js';
import { CDPClient } from '../dist/cdp/client.js';
import {
    buildOsMovePath,
    chromeInsets,
    composeWindowClickPoint,
    cssClientToScreen,
    nearbyPathStart,
    osLeftClick,
    parseXdotoolShell,
    resolveScreenClickPoint,
    resolveTurnstileOsClickPoint,
    windowNameMatchesPageTitle,
} from '../dist/core/os-mouse.js';

test('CH-08 ordinary verification buttons use page input while Cloudflare frames retain native input', () => {
    for (const scenario of [
        { text: 'Verify you are human', source: 'page' },
        { text: '请验证您是真人', source: 'page' },
        { text: 'Continue', source: 'iframe' },
        { text: 'Verify you are human', hidden: true, source: 'iframe' },
        { text: 'Verify you are human', frame: true, source: 'iframe' },
    ]) {
        const root = {};
        const element = (tagName, textContent = '', hidden = false) => ({
            tagName,
            textContent,
            hidden,
            parentElement: root,
            getBoundingClientRect: () => ({ left: 100, top: 100, width: 300, height: 65 }),
            scrollIntoView() {},
            closest: () => null,
            getAttribute: () => null,
        });
        const wrapper = element('DIV');
        const button = element('BUTTON', scenario.text, scenario.hidden);
        const frame = {
            ...element('IFRAME'),
            getAttribute: () => 'https://challenges.cloudflare.com/test',
            getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
        };
        const document = {
            title: 'Just a moment...',
            body: { innerText: '正在进行安全验证' },
            documentElement: root,
            querySelector: (selector) =>
                selector === 'input[name="cf-turnstile-response"]' ? { parentElement: wrapper } : null,
            querySelectorAll: (selector) => {
                if (selector === 'button') return [element('BUTTON', 'Settings'), button];
                if (selector === 'iframe' || selector.includes('iframe[src')) return scenario.frame ? [frame] : [];
                if (selector === '#cf-please-wait') return [element('DIV')];
                if (selector === '.cf-turnstile' || selector === 'div') return [wrapper];
                return [];
            },
        };
        const window = {
            getComputedStyle: (node) => ({
                display: node.hidden ? 'none' : 'block',
                visibility: 'visible',
                opacity: '1',
            }),
        };
        const result = vm.runInNewContext(CHALLENGE_INSPECT_SCRIPT, {
            document,
            window,
            location: { href: 'https://example.com/challenge' },
        });
        assert.equal(result.clickSource, scenario.source, JSON.stringify(scenario));
        assert.equal(result.clickTargetKind, scenario.source === 'page' || scenario.frame ? 'verify' : 'widget');
    }
});

test('C24 CDP inspection does not infer a widget from an unrelated div beside a zero-size iframe', () => {
    let scrolls = 0;
    const unrelated = {
        tagName: 'DIV',
        getBoundingClientRect: () => ({ left: 107, top: 267, width: 318, height: 58 }),
        scrollIntoView() {
            ++scrolls;
        },
        closest: () => null,
    };
    const frame = {
        tagName: 'IFRAME',
        getAttribute: () => 'https://challenges.cloudflare.com/turnstile/test',
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    };
    const result = vm.runInNewContext(CHALLENGE_INSPECT_SCRIPT, {
        document: {
            title: 'Just a moment...',
            body: { innerText: 'Editable content here for select/replace' },
            querySelector: () => null,
            querySelectorAll: (selector) =>
                selector === 'div' ? [unrelated] : selector.includes('iframe') ? [frame] : [],
        },
        window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
        location: { href: 'https://example.com/challenge' },
    });
    assert.equal(result.turnstilePresent, true);
    assert.equal(result.clickPoint, null);
    assert.equal(result.clickTargetKind, null);
    assert.equal(scrolls, 0);
});

test('C24 Linux native coordinates use client-window geometry and asymmetric GTK shadows', async () => {
    const viewport = {
        screenX: -999,
        screenY: -999,
        innerWidth: 996,
        innerHeight: 592,
        outerWidth: 1040,
        outerHeight: 780,
        devicePixelRatio: 1,
    };
    const calls = [];
    const point = await resolveTurnstileOsClickPoint(
        { clickPoint: { x: 41, y: 109 }, viewport, clickSource: 'iframe', title: 'Just a moment...' },
        {
            platform: 'linux',
            execFile: async (file, args) => {
                calls.push({ file, args: [...args] });
                if (args[0] === 'getactivewindow') return { stdout: '8388612\n', stderr: '' };
                if (args[0] === 'getwindowname') return { stdout: 'Just a moment... - Google Chrome\n', stderr: '' };
                if (args[0] === 'getwindowgeometry')
                    return { stdout: 'X=90\nY=70\nWIDTH=1040\nHEIGHT=780\n', stderr: '' };
                assert.equal(file, 'xprop');
                assert.deepEqual([...args], ['-id', '8388612', '_GTK_FRAME_EXTENTS']);
                return { stdout: '_GTK_FRAME_EXTENTS(CARDINAL) = 22, 22, 19, 25\n', stderr: '' };
            },
        }
    );
    assert.deepEqual(point, { x: 153, y: 342 });
    assert.equal(calls.filter((call) => call.file === 'xprop').length, 1);
});

test('C24 X11 coordinates preserve scaling and reject unverified geometry or frame properties', async (t) => {
    for (const specimen of [
        {
            name: 'scaled-gtk',
            scale: 2,
            width: 2080,
            height: 1560,
            extents: '_GTK_FRAME_EXTENTS(CARDINAL) = 44, 44, 38, 50\n',
            point: { x: 216, y: 614 },
        },
        {
            name: 'no-client-shadow',
            width: 996,
            height: 700,
            extents: '_GTK_FRAME_EXTENTS:  not found.\n',
            point: { x: 131, y: 287 },
        },
        {
            name: 'no-client-shadow-new-atom',
            width: 996,
            height: 700,
            extents: '_GTK_FRAME_EXTENTS:  no such atom on any window.\n',
            point: { x: 131, y: 287 },
        },
        {
            name: 'missing-shadow-mismatched-width',
            width: 1040,
            height: 780,
            extents: '_GTK_FRAME_EXTENTS:  not found.\n',
        },
        { name: 'invalid-properties', width: 1040, height: 780, extents: '_GTK_FRAME_EXTENTS(CARDINAL) = unknown\n' },
        {
            name: 'negative-properties',
            width: 1040,
            height: 780,
            extents: '_GTK_FRAME_EXTENTS(CARDINAL) = -22, 22, 19, 25\n',
        },
        { name: 'short-window', width: 1040, height: 500, extents: '_GTK_FRAME_EXTENTS(CARDINAL) = 22, 22, 19, 25\n' },
        { name: 'missing-dimensions', width: undefined, height: undefined },
        { name: 'missing-xprop', width: 1040, height: 780, missingTool: true },
    ]) {
        await t.test(specimen.name, async () => {
            const viewport = {
                screenX: -999,
                screenY: -999,
                innerWidth: 996,
                innerHeight: 592,
                outerWidth: 1040,
                outerHeight: 780,
                devicePixelRatio: specimen.scale ?? 1,
            };
            const operation = () =>
                resolveTurnstileOsClickPoint(
                    { clickPoint: { x: 41, y: 109 }, viewport, clickSource: 'iframe', title: 'Just a moment...' },
                    {
                        platform: 'linux',
                        execFile: async (file, args) => {
                            if (file === 'xprop') {
                                if (specimen.missingTool) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
                                return { stdout: specimen.extents, stderr: '' };
                            }
                            assert.equal(file, 'xdotool');
                            if (args[0] === 'getactivewindow') return { stdout: '8388612\n', stderr: '' };
                            if (args[0] === 'getwindowname')
                                return { stdout: 'Just a moment... - Google Chrome\n', stderr: '' };
                            assert.deepEqual([...args], ['getwindowgeometry', '--shell', '8388612']);
                            return {
                                stdout: `X=90\nY=70\nWIDTH=${specimen.width}\nHEIGHT=${specimen.height}\n`,
                                stderr: '',
                            };
                        },
                    }
                );
            if (specimen.point) {
                assert.deepEqual(await operation(), specimen.point);
            } else {
                await assert.rejects(operation, (error) => {
                    assert.ok(error instanceof OsMouseError);
                    assert.equal(
                        error.code,
                        specimen.missingTool ? 'OS_MOUSE_UNAVAILABLE' : 'TURNSTILE_OS_CLICK_UNAVAILABLE'
                    );
                    if (specimen.missingTool) assert.match(error.message, /xprop/);
                    return true;
                });
            }
        });
    }
});

test('CDP event waits ignore events from other flat sessions', async () => {
    const client = new CDPClient();
    const wait = client.waitForEvent('Page.loadEventFired', undefined, 1000, 'session-current');
    client.handleMessage(
        Buffer.from(
            JSON.stringify({
                method: 'Page.loadEventFired',
                params: { timestamp: 1 },
                sessionId: 'session-stale',
            })
        )
    );
    client.handleMessage(
        Buffer.from(
            JSON.stringify({
                method: 'Page.loadEventFired',
                params: { timestamp: 2 },
                sessionId: 'session-current',
            })
        )
    );
    assert.deepEqual(await wait, { timestamp: 2 });
});

test('CH-01 selection capability excludes non-text input types', () => {
    for (const type of ['text', 'search', 'tel', 'url', 'password']) {
        assert.equal(supportsTextSelection('input', type), true);
    }
    assert.equal(supportsTextSelection('textarea'), true);
    for (const type of ['number', 'date', 'time', 'range', 'color']) {
        assert.equal(supportsTextSelection('input', type), false);
    }
});

test('CH-01 computes complete value replacement by occurrence', () => {
    assert.equal(replaceNthOccurrence('10 10 10', '10', '25', 1), '10 25 10');
    assert.equal(replaceNthOccurrence('10', 'missing', '25'), null);
});

test('CH-01 redacts input find and replacement sentinels from nested failure data', () => {
    const findSentinel = 'password-find-sentinel';
    const replacementSentinel = 'password-replacement-sentinel';
    const redacted = redactSensitiveInputData(
        {
            error: `not found: ${findSentinel}`,
            context: {
                activeElement: { valuePreview: `prefix-${findSentinel}-suffix` },
                diagnostics: [{ text: replacementSentinel }],
            },
        },
        [findSentinel, replacementSentinel]
    );
    const serialized = JSON.stringify(redacted);
    assert.equal(serialized.includes(findSentinel), false);
    assert.equal(serialized.includes(replacementSentinel), false);
    assert.match(serialized, /\[REDACTED\]/);
});

test('CH-01 registered input protects password diagnostics in both backends without hiding ordinary input', async (t) => {
    for (const mode of ['extension', 'cdp']) {
        for (const inputType of ['password', 'text']) {
            for (const type of ['select', 'replace']) {
                for (const fails of [false, true]) {
                    await t.test(`${mode} ${inputType} ${type} ${fails ? 'failure' : 'success'}`, async () => {
                        const find = fails ? 'missing-find-sentinel' : 'find-sentinel';
                        const replacement = 'replacement-sentinel';
                        const originalValue = 'password-value-sentinel find-sentinel find-sentinel';
                        const logs = [];
                        const requests = [];
                        const diagnosticsText = `password-value-sentinel|${find}|${replacement}`;
                        class Input {
                            constructor(value, id) {
                                Object.assign(this, {
                                    value,
                                    id,
                                    type: inputType,
                                    tagName: 'INPUT',
                                    selectionStart: 0,
                                    selectionEnd: 0,
                                });
                            }

                            focus() {
                                document.activeElement = this;
                                logs.push({ level: 'error', text: diagnosticsText, timestamp: logs.length });
                                requests.push({
                                    url: 'https://example.com/input',
                                    status: 500,
                                    errorText: diagnosticsText,
                                    sequence: requests.length,
                                });
                            }

                            setSelectionRange(start, end) {
                                this.selectionStart = start;
                                this.selectionEnd = end;
                            }

                            setRangeText(text, start, end) {
                                this.value = this.value.slice(0, start) + text + this.value.slice(end);
                                this.selectionStart = this.selectionEnd = start + text.length;
                            }

                            dispatchEvent() {
                                return true;
                            }

                            getBoundingClientRect() {
                                return { x: 10, y: 20, width: 100, height: 25 };
                            }

                            querySelectorAll() {
                                return [];
                            }
                        }
                        const control = new Input('control-unchanged', 'control');
                        const subject = new Input(originalValue, 'subject');
                        const document = {
                            activeElement: control,
                            body: subject,
                            querySelectorAll: () => [control, subject],
                        };
                        const globals = {
                            document,
                            HTMLInputElement: Input,
                            Element: Input,
                            Event: globalThis.Event,
                            CSS: { escape: (value) => value },
                            window: { getSelection: () => null },
                        };
                        const unified = getUnifiedSession();
                        const session = getSession();
                        const overrides = {
                            getMode: () => mode,
                            getCurrentTargetId: () => '101',
                            getTargetRestoration: () => undefined,
                            getPageSnapshot: async (targetId) => ({
                                targetId,
                                url: 'https://example.com/input',
                                revision: 'r1',
                            }),
                            listTargets: async () => [{ targetId: '101' }],
                            listTopology: async () => ({ activeTargetId: '101' }),
                            withTabLock: async (action) => action(),
                            withTabId: async (_id, action) => action(),
                            withPageCondition: async (_args, action) => action(),
                            withFrame: async (_frame, action) => action(),
                            enableConsole: async () => {},
                            enableNetwork: async () => {},
                            getConsoleLogs: async () => [...logs],
                            getNetworkRequests: async () => [...requests],
                            find: async () => [{ refId: 'control' }, { refId: 'subject' }],
                            actionableClick: async (refId) => {
                                (refId === 'subject' ? subject : control).focus();
                                return { success: true };
                            },
                            evaluate: async (script, _mode, _timeout, args) => {
                                const result = vm.runInNewContext(`(${script})`, globals);
                                const value =
                                    typeof result === 'function' ? await result(...(args ?? [])) : await result;
                                if (
                                    inputType === 'password' &&
                                    value &&
                                    value.inputType === 'password' &&
                                    value.tag === 'input'
                                ) {
                                    assert.equal(
                                        value.value,
                                        undefined,
                                        'password capability probe must not return its value'
                                    );
                                }
                                return value;
                            },
                        };
                        const original = new Map(
                            Object.keys(overrides).map((key) => [key, Object.getOwnPropertyDescriptor(unified, key)])
                        );
                        const originalLocator = Object.getOwnPropertyDescriptor(session, 'createLocator');
                        Object.assign(unified, overrides);
                        session.createLocator = () => ({
                            evaluateOn: async () => {
                                subject.focus();
                                return true;
                            },
                        });
                        try {
                            let handler;
                            registerInputTool({
                                registerTool(_name, _options, callback) {
                                    handler = callback;
                                },
                            });
                            const response = await handler({
                                targetId: '101',
                                expectedUrl: 'https://example.com/input',
                                diagnostics: true,
                                events: [
                                    {
                                        type,
                                        target: { css: '.fixture-input', nth: 1 },
                                        find,
                                        text: replacement,
                                        nth: 1,
                                    },
                                ],
                                postCondition: { script: 'true' },
                                timeout: 2000,
                            });
                            const payload = JSON.parse(response.content[0].text);
                            assert.equal(Boolean(response.isError), fails);
                            assert.equal(payload.actionStatus, fails ? 'failed' : 'completed');
                            assert.equal(payload.diagnosticsStatus, 'collected');
                            assert.equal(payload.pageContext.targetId, '101');
                            if (inputType === 'password') {
                                assert.equal(payload.diagnostics.redacted, true);
                                for (const secret of ['password-value-sentinel', find, replacement]) {
                                    assert.equal(response.content[0].text.includes(secret), false);
                                }
                            } else {
                                assert.equal(
                                    payload.diagnostics.console[0].text.includes('password-value-sentinel'),
                                    true
                                );
                                assert.equal(
                                    payload.diagnostics.failedRequests[0].errorText.includes('password-value-sentinel'),
                                    true
                                );
                            }
                            if (fails) {
                                assert.equal(payload.error.code, 'TEXT_NOT_FOUND');
                                assert.equal(subject.value, originalValue);
                            } else {
                                assert.equal(payload.verificationStatus, 'matched');
                                assert.equal(payload.postCondition.checks[0].actual, true);
                                assert.equal(
                                    subject.value,
                                    type === 'replace'
                                        ? 'password-value-sentinel find-sentinel replacement-sentinel'
                                        : originalValue
                                );
                            }
                            assert.equal(control.value, 'control-unchanged');
                            if (inputType === 'password') {
                                subject.type = 'text';
                                const ordinary = await handler({
                                    targetId: '101',
                                    expectedUrl: 'https://example.com/input',
                                    diagnostics: true,
                                    events: [
                                        {
                                            type: 'select',
                                            target: { css: '.fixture-input', nth: 1 },
                                            find: 'find-sentinel',
                                        },
                                    ],
                                    timeout: 2000,
                                });
                                const ordinaryPayload = JSON.parse(ordinary.content[0].text);
                                assert.equal(ordinaryPayload.success, true);
                                assert.equal(ordinaryPayload.diagnostics.redacted, undefined);
                                assert.equal(ordinaryPayload.diagnostics.console[0].text, diagnosticsText);
                            }
                        } finally {
                            for (const [key, descriptor] of original) {
                                if (descriptor) Object.defineProperty(unified, key, descriptor);
                                else delete unified[key];
                            }
                            if (originalLocator) Object.defineProperty(session, 'createLocator', originalLocator);
                            else delete session.createLocator;
                        }
                    });
                }
            }
        }
    }
});

test('input empty event arrays reach structured handler validation', async () => {
    let handler;
    const server = {
        registerTool(name, _config, registeredHandler) {
            assert.equal(name, 'input');
            handler = registeredHandler;
        },
    };

    registerInputTool(server);
    assert.equal(typeof handler, 'function');
    const response = await handler({ events: [] });
    const payload = JSON.parse(response.content[0].text);
    assert.equal(response.isError, true);
    assert.equal(payload.error.code, 'INVALID_ARGUMENT');
    assert.equal(payload.actionExecuted, false);
    assert.equal(payload.actionStatus, 'failed');
});

test('evaluate script selection errors reach structured handler validation', async () => {
    let handler;
    const server = {
        registerTool(name, _config, registeredHandler) {
            assert.equal(name, 'evaluate');
            handler = registeredHandler;
        },
    };

    registerEvaluateTool(server);
    assert.equal(typeof handler, 'function');
    for (const args of [{}, { script: '1+1', scriptFile: 'tmp:script.js' }]) {
        const response = await handler(args);
        const payload = JSON.parse(response.content[0].text);
        assert.equal(response.isError, true);
        assert.equal(payload.error.code, 'INVALID_ARGUMENT');
        assert.match(payload.error.message, /script 与 scriptFile 必须且只能提供一个/);
        assert.equal(payload.actionExecuted, false);
        assert.equal(payload.actionStatus, 'not_started');
    }
});

test('CH-01 CDP locator focus does not depend on Extension refIds', async () => {
    const target = { role: 'textbox', name: 'Password', nth: 1 };
    let receivedTarget;
    let receivedOptions;
    let functionDeclaration;
    // noinspection JSUnusedGlobalSymbols — structural test double
    const session = {
        createLocator(actualTarget, options) {
            receivedTarget = actualTarget;
            receivedOptions = options;
            return {
                async evaluateOn(fn) {
                    functionDeclaration = fn;
                    return true;
                },
            };
        },
    };

    await focusCdpTarget(session, target, 750);
    assert.deepEqual(receivedTarget, target);
    assert.deepEqual(receivedOptions, { timeout: 750 });
    assert.match(functionDeclaration, /this\.focus/);
});

test('CH-01 contenteditable selection uses an exact DOM Range', async () => {
    const inputSource = await readFile(new URL('../src/tools/input.ts', import.meta.url), 'utf8');
    assert.match(inputSource, /root instanceof HTMLElement && root\.isContentEditable/);
    assert.match(inputSource, /selection\.addRange\(selectionRange\)/);
    assert.match(inputSource, /if \(result\.type === 'range'\)/);
});

test('CH-02 postCondition reports matched and not_matched', async () => {
    const matched = await waitForPostCondition(
        { evaluate: async () => 1 },
        { selector: '#ready', timeout: 50, interval: 50 },
        'test'
    );
    assert.equal(matched.verificationStatus, 'matched');

    const notMatched = await waitForPostCondition(
        { evaluate: async () => 0 },
        { selector: '#missing', timeout: 50, interval: 50 },
        'test'
    );
    assert.equal(notMatched.verificationStatus, 'not_matched');
});

test('CH-02 postCondition text check emits a valid escaped newline', async () => {
    let evaluatedScript;
    const result = await waitForPostCondition(
        {
            evaluate: async (script) => {
                evaluatedScript = script;
                return { matched: true, actual: 'ready' };
            },
        },
        { text: 'ready', timeout: 50, interval: 50 },
        'test'
    );
    assert.equal(result.verificationStatus, 'matched');
    assert.equal(evaluatedScript.includes("join('\\n')"), true);
    assert.equal(evaluatedScript.includes("element.type === 'password'"), true);
});

test('CH-02 postCondition distinguishes unavailable from business mismatch', async () => {
    const result = await waitForPostCondition(
        {
            evaluate: async () => {
                throw new Error('Cannot resolve CDP frame for URL');
            },
        },
        { selector: '#ready', timeout: 50, interval: 50 },
        'test'
    );
    assert.equal(result.verificationStatus, 'unavailable');
    assert.equal(result.retryable, true);
});

test('CH-02 postCondition uses the evaluate action mode', async () => {
    const modes = [];
    const result = await waitForPostCondition(
        {
            evaluate: async (_script, mode) => {
                modes.push(mode);
                return 1;
            },
        },
        { selector: '#ready', timeout: 50, interval: 50 },
        'evaluate',
        'stealth'
    );
    assert.equal(result.verificationStatus, 'matched');
    assert.deepEqual(modes, ['stealth']);
});

test('CH-03 evaluate defaults to precise independently of input mode', () => {
    assert.equal(resolveEvaluateMode(undefined), 'precise');
    assert.equal(resolveEvaluateMode('stealth'), 'stealth');
});

test('CH-03 iframe stale-context replay requires an explicit read-only contract', () => {
    assert.equal(resolveStaleContextRetryPolicy(undefined), 'never');
    assert.equal(resolveStaleContextRetryPolicy('never'), 'never');
    assert.equal(resolveStaleContextRetryPolicy('readOnly'), 'readOnly');
});

test('CH-03 evaluate distinguishes pre-action and in-flight timeout', () => {
    assert.deepEqual(classifyEvaluateActionError(new Error('Frame evaluation timed out before Runtime.evaluate')), {
        actionExecuted: false,
        actionStatus: 'failed',
        retryable: true,
    });
    for (const message of ['Request timeout after 100ms', 'Request timeout for action: debugger_send (998ms)']) {
        assert.deepEqual(classifyEvaluateActionError(new Error(message)), {
            actionExecuted: true,
            actionStatus: 'unknown',
            retryable: false,
        });
    }
    assert.deepEqual(classifyEvaluateActionError(new Error('ReferenceError: missing is not defined')), {
        actionExecuted: true,
        actionStatus: 'failed',
        retryable: false,
    });
    assert.deepEqual(
        classifyEvaluateActionError(
            new Error('FRAME_STALE_CONTEXT: Execution context became stale; script was not replayed')
        ),
        {
            actionExecuted: true,
            actionStatus: 'unknown',
            retryable: false,
        }
    );
    assert.deepEqual(classifyEvaluateActionError(new Error('Error: boom\n    at <anonymous>:1:7')), {
        actionExecuted: true,
        actionStatus: 'failed',
        retryable: false,
    });
});

test('C21 evaluate distinguishes native execution termination from page exceptions', () => {
    for (const message of ['Execution was terminated', '{"code":-32000,"message":"Execution was terminated"}']) {
        assert.deepEqual(classifyEvaluateActionError(new Error(message)), {
            actionExecuted: true,
            actionStatus: 'unknown',
            retryable: false,
        });
    }
    for (const message of [
        'Error: Execution was terminated\n    at <anonymous>:1:1',
        'Evaluation failed: Execution was terminated',
    ]) {
        assert.deepEqual(classifyEvaluateActionError(new Error(message)), {
            actionExecuted: true,
            actionStatus: 'failed',
            retryable: false,
        });
    }
    assert.deepEqual(classifyEvaluateActionError(new Error('{"code":-32602,"message":"Execution was terminated"}')), {
        actionExecuted: false,
        actionStatus: 'failed',
        retryable: false,
    });
});

test('C21 CDPClient script errors retain unknown execution state', () => {
    for (const method of ['Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.runScript', 'Page.enable']) {
        for (const message of ['Execution was terminated', 'Internal error', 'Invalid parameters']) {
            const client = new CDPClient();
            let error;
            client.callbacks.set(1, {
                method,
                resolve: () => assert.fail('protocol error resolved'),
                reject: (value) => {
                    error = value;
                },
            });
            const code = message === 'Internal error' ? -32603 : message === 'Invalid parameters' ? -32602 : -32000;
            client.handleMessage(Buffer.from(JSON.stringify({ id: 1, error: { code, message } })));
            const unknown = method !== 'Page.enable' && message !== 'Invalid parameters';
            assert.deepEqual(
                classifyEvaluateActionError(error),
                {
                    actionExecuted: unknown,
                    actionStatus: unknown ? 'unknown' : 'failed',
                    retryable: false,
                },
                `${method}: ${message}`
            );
            assert.equal(client.callbacks.size, 0);
        }
    }
});

test('CH-03 evaluate reports result materialization errors as output failures', () => {
    assert.deepEqual(
        classifyEvaluateFailure(new NonSerializableEvaluateResultError({ type: 'object', subtype: 'node' })),
        {
            actionExecuted: true,
            actionStatus: 'completed',
            failureStage: 'output',
            retryable: false,
        }
    );
    assert.deepEqual(
        classifyEvaluateFailure(
            new EvaluateResultTooLargeError({
                exceeded: 'nodes',
                depth: 1,
                nodes: 2001,
                chars: 10,
                maxDepth: 8,
                maxNodes: 2000,
                maxChars: 1_000_000,
            })
        ),
        {
            actionExecuted: true,
            actionStatus: 'completed',
            failureStage: 'output',
            retryable: false,
        }
    );
});

test('console log levels use the public schema vocabulary', () => {
    assert.deepEqual(normalizeConsoleLog({ level: 'log', text: 'message' }), {
        level: 'info',
        text: 'message',
    });
    assert.equal(normalizeConsoleLog({ level: 'warn', text: 'warning' }).level, 'warning');
    assert.equal(normalizeConsoleLog({ level: 'trace', text: 'trace' }).level, 'debug');
});

test('CDP console reads enable the Runtime domain before collecting events', async () => {
    const [logsSource, sessionSource] = await Promise.all([
        readFile(new URL('../src/tools/logs.ts', import.meta.url), 'utf8'),
        readFile(new URL('../src/core/session.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(logsSource, /await unifiedSession\.enableConsole\(\)\s*if \(mode === 'extension'\)/);
    assert.match(sessionSource, /async consoleEnable\(\): Promise<void> \{\s*await this\.ensureRuntimeEnabled\(\)/);
    assert.match(sessionSource, /if \(!this\.isCurrentSessionEvent\(eventSessionId\)\) \{\s*return\s*\}/);
});

test('inline network logs bound long URLs and retain original length', () => {
    const url = `data:text/plain,${'x'.repeat(5000)}`;
    const request = boundInlineNetworkRequest({ url, method: 'GET', type: 'Other' });
    assert.equal(request.url.length, 2048);
    assert.equal(request.urlLength, url.length);
    assert.equal(request.urlTruncated, true);

    const short = { url: 'https://example.com', method: 'GET', type: 'Document' };
    assert.equal(boundInlineNetworkRequest(short), short);
});

test('network and console URL fields redact credential query parameters', () => {
    const rawUrl = 'https://example.com/file?authorization=test-sentinel&name=report&access_token=token-sentinel';
    const sanitized = sanitizeUrl(rawUrl);
    assert.equal(sanitized.url.includes('test-sentinel'), false);
    assert.equal(sanitized.url.includes('token-sentinel'), false);
    assert.match(sanitized.url, /authorization=\[REDACTED\]/);
    assert.match(sanitized.url, /access_token=\[REDACTED\]/);
    assert.equal(sanitized.urlRedacted, true);
    assert.equal(sanitized.urlOriginalLength, rawUrl.length);
    assert.deepEqual(sanitized.redactedQueryParameters, ['authorization', 'access_token']);

    const record = sanitizeUrlRecord({ url: rawUrl, level: 'error', text: 'failed' });
    assert.equal(record.text, 'failed');
    assert.equal(record.urlRedacted, true);
    assert.equal(JSON.stringify(record).includes('test-sentinel'), false);
    const sanitizedAgain = sanitizeUrlRecord(record);
    assert.equal(sanitizedAgain, record);
    assert.equal(sanitizedAgain.urlOriginalLength, rawUrl.length);
});

test('CH-04 target candidate summaries are bounded and omit page values', () => {
    const candidates = Array.from({ length: 12 }, (_, index) => ({
        tag: 'input',
        text: `${index}:${'x'.repeat(200)}`,
        rect: { x: index, y: 0, width: 10, height: 10 },
        value: `secret-${index}`,
        href: `https://example.com/${index}`,
    }));
    const summary = summarizeTargetCandidates(candidates);
    assert.equal(summary.length, 10);
    assert.equal(summary[0].text.length, 160);
    assert.equal('value' in summary[0], false);
    assert.equal('href' in summary[0], false);
});

test('CH-07 diagnostics remain attached when the main action fails', async () => {
    // noinspection JSUnusedGlobalSymbols — structural test double
    const session = {
        enableConsole: async () => {},
        enableNetwork: async () => {},
        getConsoleLogs: async () => [{ level: 'error', text: 'navigation failed' }],
        getNetworkRequests: async () => [{ url: 'https://example.com', status: 503 }],
    };
    const response = await withDiagnosticsResponse(session, true, async () => {
        throw new Error('navigation timeout');
    });
    assert.equal(response.isError, true);
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.error.message, 'navigation timeout');
    assert.equal(payload.diagnosticsStatus, 'collected');
    assert.deepEqual(payload.diagnostics.console, []);
    assert.deepEqual(payload.diagnostics.failedRequests, []);
});

test('CH-04 target diagnostics read live tab state instead of cached attach metadata', async () => {
    const [sessionSource, diagnosticsSource, extractSource] = await Promise.all([
        readFile(new URL('../src/core/unified-session.ts', import.meta.url), 'utf8'),
        readFile(new URL('../src/tools/target-diagnostics.ts', import.meta.url), 'utf8'),
        readFile(new URL('../src/tools/extract.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(sessionSource, /async getLiveState\(\)/);
    assert.match(sessionSource, /await this\.extensionBridge!\.listTargets\(\)/);
    assert.match(diagnosticsSource, /await unifiedSession\.getLiveState\(\)/);
    assert.match(extractSource, /await unifiedSession\.getLiveState\(\)/);
});

test('CH-05 backend selection happens inside the active tab and frame scopes', async () => {
    const [inputSource, waitSource, logsSource, extractSource] = await Promise.all(
        ['input.ts', 'wait.ts', 'logs.ts', 'extract.ts'].map((file) =>
            readFile(new URL(`../src/tools/${file}`, import.meta.url), 'utf8')
        )
    );

    const assertScoped = (source, handler, backendMarker, hasFrame) => {
        const handlerIndex = source.indexOf(handler);
        const tabIndex = source.indexOf('withPageContext(unifiedSession, resolvePageTargetId(args)', handlerIndex);
        const frameIndex = hasFrame ? source.indexOf('withFrame(args.frame', tabIndex) : tabIndex;
        const backendIndex = source.indexOf(backendMarker, frameIndex);
        assert.ok(handlerIndex >= 0);
        assert.ok(tabIndex > handlerIndex);
        if (hasFrame) {
            assert.ok(frameIndex > tabIndex);
        }
        assert.ok(backendIndex > frameIndex);
    };

    assertScoped(inputSource, 'async function handleInput', 'const mode = unifiedSession.getMode()', true);
    assertScoped(waitSource, 'async function handleWait', 'const mode = unifiedSession.getMode()', true);
    assertScoped(logsSource, 'async function handleLogs', 'const mode = unifiedSession.getMode()', false);
    assertScoped(
        extractSource,
        'async function handleExtract',
        "const useExtension = unifiedSession.getMode() === 'extension'",
        true
    );
});

test('CH-06 Extension only replays stale iframe contexts for read-only scripts', async () => {
    const [resolverSource, schemaSource] = await Promise.all([
        readFile(new URL('../extension/src/background/frame-resolver.ts', import.meta.url), 'utf8'),
        readFile(new URL('../extension/src/types/schemas.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(resolverSource, /p\.staleContextRetry === 'readOnly' \? 2 : 1/);
    assert.match(resolverSource, /script was not replayed because staleContextRetry is never/);
    assert.match(schemaSource, /staleContextRetry: z\.enum\(\['never', 'readOnly'\]\)\.default\('never'\)/);
});

test('CH-06 DOM iframe identity does not depend on webNavigation frame ordering', async () => {
    const [resolverSource, actionUtilsSource, contentSource, pageScriptsSource] = await Promise.all([
        readFile(new URL('../extension/src/background/frame-resolver.ts', import.meta.url), 'utf8'),
        readFile(new URL('../extension/src/background/action-utils.ts', import.meta.url), 'utf8'),
        readFile(new URL('../extension/src/content/content.ts', import.meta.url), 'utf8'),
        readFile(new URL('../extension/src/background/page-scripts.ts', import.meta.url), 'utf8'),
    ]);

    assert.match(resolverSource, /getDomFrameSnapshot\(tabId, 0, p\.frame, readable\.documentId, readable\.tab\.url\)/);
    assert.doesNotMatch(resolverSource, /directChildFrames\[info\.index\]/);
    assert.match(actionUtilsSource, /mcp-frame-probe/);
    assert.match(actionUtilsSource, /recordDomFrameProbe/);
    assert.match(actionUtilsSource, /candidateFrameIds\.length === 1/);
    assert.match(contentSource, /import \{ installFrameProbeListener \} from '\.\.\/background\/page-scripts'/);
    assert.match(contentSource, /installFrameProbeListener\(\)/);
    assert.match(actionUtilsSource, /documentIds: childDocumentIds/);
    assert.match(actionUtilsSource, /func: installFrameProbeListener/);
    assert.match(pageScriptsSource, /MCP_FRAME_PROBE/);
    assert.match(resolverSource, /不会按 webNavigation 列表顺序选择其他 frame/);
});

// noinspection LongLine — 回归测试标题完整描述兼容场景
test('CH-06 Extension bundle identity distinguishes active and stale builds without blocking legacy clients', async () => {
    const expected = `sha256:${'a'.repeat(64)}`;
    const active = `sha256:${'b'.repeat(64)}`;
    assert.equal(resolveExtensionBundleStatus(expected, expected, true), 'match');
    assert.equal(resolveExtensionBundleStatus(expected, active, true), 'stale');
    assert.equal(resolveExtensionBundleStatus(expected, null, true), 'legacy');
    assert.equal(resolveExtensionBundleStatus(null, active, true), 'unknown');
    assert.equal(resolveExtensionBundleStatus(expected, null, false), 'pending');

    const clientSource = await readFile(new URL('../extension/src/background/http-client.ts', import.meta.url), 'utf8');
    assert.match(clientSource, /chrome\.runtime\.getURL\('service-worker-loader\.js'\)/);
    assert.match(clientSource, /backgroundBundleHash/);
});

test('CH-07 diagnostics initialization and collection are best effort', async () => {
    const unavailable = await startDiagnostics(
        {
            enableConsole: async () => {
                throw new Error('debugger blocked');
            },
        },
        true
    );
    assert.equal(unavailable.result.diagnosticsStatus, 'unavailable');

    // noinspection JSUnusedGlobalSymbols — structural test double
    const session = {
        enableConsole: async () => {},
        enableNetwork: async () => {},
        getConsoleLogs: async () => [],
        getNetworkRequests: async () => [],
    };
    const started = await startDiagnostics(session, true);
    const finished = await finishDiagnostics(session, started);
    assert.equal(finished.diagnosticsStatus, 'collected');

    const collectionFailed = await finishDiagnostics(
        {
            getConsoleLogs: async () => {
                throw new Error('restricted page');
            },
            getNetworkRequests: async () => [],
        },
        started
    );
    assert.equal(collectionFailed.diagnosticsStatus, 'error');
    assert.match(collectionFailed.diagnosticsError, /restricted page/);
});

test('CH-08 diagnostics use sequence markers and report lost baselines', async () => {
    let consoleLogs = [{ sequence: 1, level: 'info', text: 'first', timestamp: 1 }];
    let networkRequests = [
        { sequence: 1, url: 'https://example.com/first', method: 'GET', type: 'Document', timestamp: 1 },
    ];
    // noinspection JSUnusedGlobalSymbols — structural test double
    const session = {
        enableConsole: async () => {},
        enableNetwork: async () => {},
        getConsoleLogs: async () => consoleLogs,
        getNetworkRequests: async () => networkRequests,
    };

    const started = await startDiagnostics(session, true);
    consoleLogs = [{ sequence: 2, level: 'error', text: 'new error', timestamp: 2 }];
    networkRequests = [
        { sequence: 2, url: 'https://example.com/failed', method: 'GET', type: 'Document', status: 503, timestamp: 2 },
    ];
    const finished = await finishDiagnostics(session, started);

    assert.equal(finished.diagnosticsStatus, 'collected');
    assert.equal(finished.diagnostics.console.length, 1);
    assert.equal(finished.diagnostics.failedRequests.length, 1);
    assert.equal(finished.diagnostics.truncated, true);
});

test('CH-08 Challenge waits for page recovery and clicks Turnstile checkbox', async () => {
    assert.equal(
        classifyChallengeSnapshot({
            title: 'Example',
            selectorHits: [],
            deniedHits: [],
            turnstilePresent: false,
            inspected: true,
        }),
        'none'
    );
    assert.equal(
        classifyChallengeSnapshot({
            title: 'Just a moment...',
            selectorHits: ['#cf-please-wait'],
            deniedHits: [],
            turnstilePresent: false,
            inspected: true,
        }),
        'js'
    );
    assert.equal(
        classifyChallengeSnapshot({
            title: 'Just a moment...',
            selectorHits: [],
            deniedHits: [],
            turnstilePresent: true,
            inspected: true,
        }),
        'turnstile'
    );
    assert.equal(
        classifyChallengeSnapshot({
            title: 'Access denied',
            selectorHits: [],
            deniedHits: ['div.cf-error-title span.cf-code-label span'],
            turnstilePresent: false,
            inspected: true,
        }),
        'denied'
    );
    assert.equal(
        classifyChallengeSnapshot({
            title: 'nowsecure.nl',
            selectorHits: [],
            deniedHits: [],
            turnstilePresent: false,
            inspected: true,
        }),
        'none'
    );
    assert.equal(
        classifyChallengeSnapshot({
            title: '请稍候…',
            selectorHits: [],
            deniedHits: [],
            textHits: ['正在进行安全验证'],
            originResponsePending: false,
            turnstilePresent: false,
            inspected: true,
        }),
        'js'
    );
    assert.equal(
        classifyChallengeSnapshot({
            title: '请稍候…',
            selectorHits: [],
            deniedHits: [],
            textHits: ['正在进行安全验证'],
            originResponsePending: true,
            turnstilePresent: false,
            inspected: true,
        }),
        'none'
    );
    assert.equal(
        classifyChallengeSnapshot({
            title: '请稍候…',
            selectorHits: [],
            deniedHits: [],
            textHits: ['正在进行安全验证'],
            originResponsePending: true,
            turnstilePresent: true,
            inspected: true,
        }),
        'turnstile'
    );
    assert.match(CHALLENGE_INSPECT_SCRIPT, /document\.body && document\.body\.innerText \? document\.body\.innerText/);
    assert.match(CHALLENGE_INSPECT_SCRIPT, /findVisibleTurnstileBox/);
    assert.doesNotMatch(CHALLENGE_INSPECT_SCRIPT, /document\.body\.textContent \|\| document\.body\.innerText/);

    let clock = 0;
    const sleeps = [];
    let pending = true;
    let clicked = false;
    // noinspection JSUnusedGlobalSymbols — structural test double
    const host = {
        getMode: () => 'cdp',
        getState: () => ({ url: 'https://example.com/', title: pending ? 'Just a moment...' : 'Example' }),
        getLiveState: async () => ({ url: 'https://example.com/', title: pending ? 'Just a moment...' : 'Example' }),
        getChallengeState: async () => (pending ? { state: 'pending', mode: 'cdp' } : null),
        evaluate: async () => ({
            title: pending ? 'Just a moment...' : 'Example',
            url: 'https://example.com/',
            selectorHits: pending ? ['#cf-please-wait'] : [],
            deniedHits: [],
            turnstilePresent: pending,
            clickPoint: pending ? { x: 40, y: 80 } : null,
            clickTargetKind: pending ? 'widget' : null,
            inspected: true,
        }),
        getCookies: async () => (pending ? [] : [{ name: 'cf_clearance', value: 'secret' }]),
        mouseMove: async () => {},
        mouseClick: async () => {
            clicked = true;
            pending = false;
        },
    };

    const result = await waitForChallenge(host, {
        action: 'open',
        timeout: 8_000,
        now: () => clock,
        sleep: async (ms) => {
            sleeps.push(ms);
            clock += ms;
        },
    });
    assert.equal(result.resolved, true);
    assert.equal(result.clickedTurnstile, true);
    assert.equal(clicked, true);
    assert.equal(result.clearanceCookiePresent, true);
    assert.equal(result.challengeKind, 'turnstile');
    assert.ok(sleeps.length >= 1);
    assert.ok(sleeps.length >= 6, 'JS Challenge 前 3s 只轮询标题，不立刻 inspect');

    let extensionClock = 0;
    let extensionPending = true;
    let extensionEvaluated = false;
    // noinspection JSUnusedGlobalSymbols — structural test double
    const extensionChallengeHost = {
        getMode: () => 'extension',
        getState: () => ({ url: 'https://example.com/', title: extensionPending ? 'Just a moment...' : 'Example' }),
        getLiveState: async () => ({
            url: 'https://example.com/',
            title: extensionPending ? 'Just a moment...' : 'Example',
        }),
        getChallengeState: async () => null,
        evaluate: async () => {
            extensionEvaluated = true;
            throw new Error('自动 JS Challenge 不应附加 debugger');
        },
        getCookies: async () => [],
        mouseMove: async () => {},
        mouseClick: async () => {},
    };
    const extensionRecovered = await waitForChallenge(extensionChallengeHost, {
        action: 'open',
        timeout: 10_000,
        now: () => extensionClock,
        sleep: async (ms) => {
            extensionClock += ms;
            if (extensionClock >= 2_000) {
                extensionPending = false;
            }
        },
    });
    assert.equal(extensionRecovered.challengeKind, 'js');
    assert.ok(extensionClock < 8_000, '自动 JS Challenge 在被动等待期间恢复');
    assert.equal(extensionEvaluated, false);

    let extensionInteractiveClock = 0;
    let extensionInspectionAt;
    let extensionTurnstilePending = true;
    // noinspection JSUnusedGlobalSymbols — structural test double
    const extensionTurnstileHost = {
        getMode: () => 'extension',
        getState: () => ({
            url: 'https://example.com/',
            title: extensionTurnstilePending ? 'Just a moment...' : 'Example',
        }),
        getLiveState: async () => ({
            url: 'https://example.com/',
            title: extensionTurnstilePending ? 'Just a moment...' : 'Example',
        }),
        getChallengeState: async () => null,
        evaluate: async () => {
            extensionInspectionAt ??= extensionInteractiveClock;
            return {
                title: 'Just a moment...',
                url: 'https://example.com/',
                selectorHits: [],
                deniedHits: [],
                textHits: [],
                turnstilePresent: true,
                clickPoint: { x: 20, y: 20 },
                clickTargetKind: 'widget',
                inspected: true,
            };
        },
        getCookies: async () => [],
        mouseMove: async () => {},
        mouseClick: async () => {
            extensionTurnstilePending = false;
        },
    };
    const extensionTurnstileRecovered = await waitForChallenge(extensionTurnstileHost, {
        action: 'open',
        timeout: 12_000,
        now: () => extensionInteractiveClock,
        sleep: async (ms) => {
            extensionInteractiveClock += ms;
        },
    });
    assert.equal(extensionTurnstileRecovered.challengeKind, 'turnstile');
    assert.equal(extensionTurnstileRecovered.clickedTurnstile, true);
    assert.equal(extensionInspectionAt, 8_000);

    let originPendingClock = 0;
    // noinspection JSUnusedGlobalSymbols — structural test double
    const originPendingHost = {
        getMode: () => 'extension',
        getState: () => ({ url: 'https://example.com/', title: '请稍候…' }),
        getLiveState: async () => ({ url: 'https://example.com/', title: '请稍候…' }),
        getChallengeState: async () => null,
        evaluate: async () => ({
            title: '请稍候…',
            url: 'https://example.com/',
            selectorHits: [],
            deniedHits: [],
            textHits: ['正在进行安全验证'],
            originResponsePending: true,
            turnstilePresent: false,
            clickPoint: null,
            inspected: true,
        }),
        getCookies: async () => [{ name: 'cf_clearance' }],
        mouseMove: async () => {},
        mouseClick: async () => {
            throw new Error('验证成功后不得点击页面');
        },
    };
    const originPending = await waitForChallenge(originPendingHost, {
        action: 'open',
        timeout: 10_000,
        now: () => originPendingClock,
        sleep: async (ms) => {
            originPendingClock += ms;
        },
    });
    assert.equal(originPending.challengeKind, 'js');
    assert.equal(originPending.originResponsePending, true);
    assert.equal(originPending.waitedMs, 8_000);
    assert.deepEqual(challengeResultFields(originPending), {
        challengeResolved: true,
        challengeKind: 'js',
        waitedMs: 8_000,
        clickedTurnstile: false,
        clearanceCookiePresent: true,
        originResponsePending: true,
    });

    let delayedOriginPendingClock = 0;
    let delayedOriginPendingInspections = 0;
    // noinspection JSUnusedGlobalSymbols — structural test double
    const delayedOriginPendingHost = {
        getMode: () => 'extension',
        getState: () => ({ url: 'https://example.com/', title: '请稍候…' }),
        getLiveState: async () => ({ url: 'https://example.com/', title: '请稍候…' }),
        getChallengeState: async () => null,
        evaluate: async () => {
            delayedOriginPendingInspections += 1;
            return {
                title: '请稍候…',
                url: 'https://example.com/',
                selectorHits: [],
                deniedHits: [],
                textHits: ['正在进行安全验证'],
                originResponsePending: delayedOriginPendingInspections >= 2,
                turnstilePresent: false,
                clickPoint: null,
                inspected: true,
            };
        },
        getCookies: async () => [{ name: 'cf_clearance' }],
        mouseMove: async () => {},
        mouseClick: async () => {
            throw new Error('验证成功后不得点击页面');
        },
    };
    const delayedOriginPending = await waitForChallenge(delayedOriginPendingHost, {
        action: 'open',
        timeout: 15_000,
        now: () => delayedOriginPendingClock,
        sleep: async (ms) => {
            delayedOriginPendingClock += ms;
        },
    });
    assert.equal(delayedOriginPending.challengeKind, 'js');
    assert.equal(delayedOriginPending.originResponsePending, true);
    assert.equal(delayedOriginPendingInspections, 2);
    assert.equal(delayedOriginPending.waitedMs, 10_000);

    let hiddenSuccessTurnstileClock = 0;
    let hiddenSuccessTurnstilePending = true;
    // noinspection JSUnusedGlobalSymbols — structural test double
    const hiddenSuccessTurnstileHost = {
        getMode: () => 'extension',
        getState: () => ({
            url: 'https://example.com/',
            title: hiddenSuccessTurnstilePending ? '请稍候…' : 'Example',
        }),
        getLiveState: async () => ({
            url: 'https://example.com/',
            title: hiddenSuccessTurnstilePending ? '请稍候…' : 'Example',
        }),
        getChallengeState: async () => null,
        evaluate: async () => ({
            title: hiddenSuccessTurnstilePending ? '请稍候…' : 'Example',
            url: 'https://example.com/',
            selectorHits: [],
            deniedHits: [],
            textHits: hiddenSuccessTurnstilePending ? ['正在进行安全验证'] : [],
            originResponsePending: true,
            turnstilePresent: hiddenSuccessTurnstilePending,
            clickPoint: hiddenSuccessTurnstilePending ? { x: 40, y: 80 } : null,
            clickTargetKind: hiddenSuccessTurnstilePending ? 'widget' : null,
            inspected: true,
        }),
        getCookies: async () => [],
        mouseMove: async () => {},
        mouseClick: async () => {
            hiddenSuccessTurnstilePending = false;
        },
    };
    const hiddenSuccessTurnstile = await waitForChallenge(hiddenSuccessTurnstileHost, {
        action: 'open',
        timeout: 12_000,
        now: () => hiddenSuccessTurnstileClock,
        sleep: async (ms) => {
            hiddenSuccessTurnstileClock += ms;
        },
    });
    assert.equal(hiddenSuccessTurnstile.challengeKind, 'turnstile');
    assert.equal(hiddenSuccessTurnstile.clickedTurnstile, true);
    assert.equal(hiddenSuccessTurnstilePending, false);

    let lateTurnstileClock = 0;
    let lateTurnstileInspections = 0;
    let lateTurnstilePending = true;
    // noinspection JSUnusedGlobalSymbols — structural test double
    const lateTurnstileHost = {
        getMode: () => 'extension',
        getState: () => ({
            url: 'https://example.com/',
            title: lateTurnstilePending ? '请稍候…' : 'Example',
        }),
        getLiveState: async () => ({
            url: 'https://example.com/',
            title: lateTurnstilePending ? '请稍候…' : 'Example',
        }),
        getChallengeState: async () => null,
        evaluate: async () => {
            lateTurnstileInspections += 1;
            const ready = lateTurnstileInspections >= 2 && lateTurnstilePending;
            return {
                title: lateTurnstilePending ? '请稍候…' : 'Example',
                url: 'https://example.com/',
                selectorHits: [],
                deniedHits: [],
                textHits: lateTurnstilePending ? ['正在进行安全验证'] : [],
                originResponsePending: false,
                turnstilePresent: ready,
                clickPoint: ready ? { x: 40, y: 80 } : null,
                clickTargetKind: ready ? 'widget' : null,
                inspected: true,
            };
        },
        getCookies: async () => [],
        mouseMove: async () => {},
        mouseClick: async () => {
            lateTurnstilePending = false;
        },
    };
    const lateTurnstile = await waitForChallenge(lateTurnstileHost, {
        action: 'open',
        timeout: 14_000,
        now: () => lateTurnstileClock,
        sleep: async (ms) => {
            lateTurnstileClock += ms;
        },
    });
    assert.equal(lateTurnstile.challengeKind, 'turnstile');
    assert.equal(lateTurnstile.clickedTurnstile, true);
    assert.equal(lateTurnstileInspections, 3);
    assert.equal(lateTurnstilePending, false);

    const inspectModes = [];
    // noinspection JSUnusedGlobalSymbols — structural test double
    const isolatedInspectHost = {
        getMode: () => 'extension',
        getState: () => ({ url: 'https://example.com/', title: '请稍候…' }),
        getLiveState: async () => ({ url: 'https://example.com/', title: '请稍候…' }),
        getChallengeState: async () => null,
        inspectChallenge: async () => ({
            title: '请稍候…',
            url: 'https://example.com/',
            selectorHits: [],
            deniedHits: [],
            textHits: ['正在进行安全验证'],
            originResponsePending: false,
            turnstilePresent: true,
            clickPoint: { x: 242, y: 329 },
            clickTargetKind: 'verify',
            clickSource: 'iframe',
            inspected: true,
        }),
        evaluate: async (_code, mode) => {
            inspectModes.push(mode);
            throw new Error(`isolated inspect 成功后不得走 ${mode}`);
        },
        getCookies: async () => [],
        mouseMove: async () => {},
        mouseClick: async () => {},
    };
    const isolatedSnapshot = await readChallengeSnapshot(isolatedInspectHost, 3_000);
    assert.deepEqual(inspectModes, []);
    assert.equal(isolatedSnapshot.clickTargetKind, 'verify');
    assert.equal(isolatedSnapshot.clickSource, 'iframe');
    assert.deepEqual(isolatedSnapshot.clickPoint, { x: 242, y: 329 });

    // noinspection JSUnusedGlobalSymbols — structural test double
    const preciseRetryHost = {
        getMode: () => 'extension',
        getState: () => ({ url: 'https://example.com/', title: '请稍候…' }),
        getLiveState: async () => ({ url: 'https://example.com/', title: '请稍候…' }),
        getChallengeState: async () => null,
        inspectChallenge: async () => {
            throw new Error('old extension missing challenge_inspect');
        },
        evaluate: async (_code, mode) => {
            inspectModes.push(mode);
            if (mode === 'stealth') {
                throw new Error('CSP blocked stealth inspect');
            }
            return {
                title: '请稍候…',
                url: 'https://example.com/',
                selectorHits: [],
                deniedHits: [],
                textHits: ['正在进行安全验证'],
                originResponsePending: false,
                turnstilePresent: true,
                clickPoint: { x: 40, y: 80 },
                clickTargetKind: 'widget',
                inspected: true,
            };
        },
        getCookies: async () => [],
        mouseMove: async () => {},
        mouseClick: async () => {},
    };
    const preciseRetrySnapshot = await readChallengeSnapshot(preciseRetryHost, 3_000);
    assert.deepEqual(inspectModes, ['stealth', 'precise']);
    assert.equal(preciseRetrySnapshot.turnstilePresent, true);
    assert.deepEqual(preciseRetrySnapshot.clickPoint, { x: 40, y: 80 });

    let inspected = false;
    // noinspection JSUnusedGlobalSymbols — structural test double
    const quietHost = {
        getMode: () => 'cdp',
        getState: () => ({ url: 'https://example.com/', title: 'Example' }),
        getLiveState: async () => ({ url: 'https://example.com/', title: 'Example' }),
        getChallengeState: async () => null,
        evaluate: async () => {
            inspected = true;
            return {
                title: 'Example',
                url: 'https://example.com/',
                selectorHits: [],
                deniedHits: [],
                turnstilePresent: false,
                clickPoint: null,
                inspected: true,
            };
        },
        getCookies: async () => [],
        mouseMove: async () => {},
        mouseClick: async () => {},
    };
    const skipped = await waitForChallenge(quietHost, { action: 'evaluate', timeout: 1_000 });
    assert.equal(skipped.challengeKind, 'none');
    assert.equal(inspected, false);
    const navigated = await waitForChallenge(quietHost, { action: 'open', timeout: 1_000 });
    assert.equal(navigated.challengeKind, 'none');
    assert.equal(inspected, false);

    let stalePending = true;
    let staleInspected = false;
    let staleClock = 0;
    // noinspection JSUnusedGlobalSymbols — structural test double
    const staleTitleHost = {
        getMode: () => 'cdp',
        getState: () => ({ url: 'file:///tmp/test-page.html', title: 'MCP Chrome 测试页面' }),
        getLiveState: async () => ({
            url: 'file:///tmp/test-page.html',
            title: stalePending ? 'Just a moment...' : 'MCP Chrome 测试页面',
        }),
        getChallengeState: async () => null,
        evaluate: async () => {
            staleInspected = true;
            return {
                title: stalePending ? 'Just a moment...' : 'MCP Chrome 测试页面',
                url: 'file:///tmp/test-page.html',
                selectorHits: stalePending ? ['#cf-please-wait'] : [],
                deniedHits: [],
                turnstilePresent: false,
                clickPoint: null,
                inspected: true,
            };
        },
        getCookies: async () => [],
        mouseMove: async () => {},
        mouseClick: async () => {},
    };
    const recovered = await waitForChallenge(staleTitleHost, {
        action: 'evaluate',
        timeout: 5_000,
        now: () => staleClock,
        sleep: async (ms) => {
            staleClock += ms;
            stalePending = false;
        },
    });
    assert.equal(recovered.resolved, true);
    assert.equal(recovered.challengeKind, 'js');
    assert.equal(staleInspected, false);

    // noinspection JSUnusedGlobalSymbols — structural test double
    const leftoverHost = {
        getMode: () => 'cdp',
        getState: () => ({ url: 'https://nowsecure.nl/', title: 'nowsecure.nl' }),
        getLiveState: async () => ({ url: 'https://nowsecure.nl/', title: 'nowsecure.nl' }),
        getChallengeState: async () => ({ state: 'pending', mode: 'cdp' }),
        evaluate: async () => {
            return {
                title: 'nowsecure.nl',
                url: 'https://nowsecure.nl/',
                selectorHits: [],
                deniedHits: [],
                turnstilePresent: false,
                clickPoint: null,
                inspected: true,
            };
        },
        getCookies: async () => [{ name: 'cf_clearance', value: 'secret' }],
        mouseMove: async () => {},
        mouseClick: async () => {
            throw new Error('leftover Turnstile iframe should not be clicked');
        },
    };
    const leftover = await waitForChallenge(leftoverHost, { action: 'open', timeout: 25_000 });
    assert.equal(leftover.resolved, true);
    assert.equal(leftover.challengeKind, 'none');
    assert.equal(leftover.clickedTurnstile, false);
    assert.equal(leftover.clearanceCookiePresent, false);
});

test('CH-08 Challenge timeout and access denied fail without exporting cookie values', async () => {
    // noinspection JSUnusedGlobalSymbols — structural test double
    const timeoutHost = {
        getMode: () => 'cdp',
        getState: () => ({ url: 'https://example.com/', title: 'Just a moment...' }),
        getLiveState: async () => ({ url: 'https://example.com/', title: 'Just a moment...' }),
        getChallengeState: async () => ({ state: 'pending', mode: 'cdp' }),
        evaluate: async () => ({
            title: 'Just a moment...',
            url: 'https://example.com/',
            selectorHits: ['#cf-please-wait'],
            deniedHits: [],
            turnstilePresent: false,
            clickPoint: null,
            inspected: true,
        }),
        getCookies: async () => [{ name: 'cf_clearance', value: 'should-not-appear' }],
        mouseMove: async () => {},
        mouseClick: async () => {},
    };
    let timeoutClock = 0;
    await assert.rejects(
        () =>
            waitForChallenge(timeoutHost, {
                action: 'evaluate',
                actionStatus: 'not_started',
                timeout: 1_000,
                now: () => timeoutClock,
                sleep: async (ms) => {
                    timeoutClock += ms;
                },
            }),
        (error) => {
            if (!(error instanceof ChallengeTimeoutError)) {
                return false;
            }
            const payload = error.toJSON();
            assert.equal(payload.error.code, 'CHALLENGE_TIMEOUT');
            assert.equal(payload.challengeKind, 'js');
            assert.equal(payload.clickedTurnstile, false);
            assert.equal(payload.mode, 'cdp');
            assert.equal(payload.retryable, true);
            assert.equal(payload.autoRetry, false);
            assert.equal(JSON.stringify(payload).includes('should-not-appear'), false);
            return true;
        }
    );

    let clickedTimeoutClock = 0;
    // noinspection JSUnusedGlobalSymbols — structural test double
    const clickedTimeoutHost = {
        getMode: () => 'extension',
        getState: () => ({ url: 'https://example.com/', title: '请稍候…' }),
        getLiveState: async () => ({ url: 'https://example.com/', title: '请稍候…' }),
        getChallengeState: async () => null,
        evaluate: async () => ({
            title: '请稍候…',
            url: 'https://example.com/',
            selectorHits: [],
            deniedHits: [],
            textHits: ['正在进行安全验证'],
            originResponsePending: false,
            turnstilePresent: true,
            clickPoint: { x: 40, y: 80 },
            clickTargetKind: 'widget',
            inspected: true,
        }),
        getCookies: async () => [],
        mouseMove: async () => {},
        mouseClick: async () => {},
    };
    await assert.rejects(
        () =>
            waitForChallenge(clickedTimeoutHost, {
                action: 'open',
                timeout: 12_000,
                now: () => clickedTimeoutClock,
                sleep: async (ms) => {
                    clickedTimeoutClock += ms;
                },
            }),
        (error) => {
            if (!(error instanceof ChallengeTimeoutError)) {
                return false;
            }
            const payload = error.toJSON();
            assert.equal(payload.challengeKind, 'turnstile');
            assert.equal(payload.clickedTurnstile, true);
            return true;
        }
    );

    let repeatClickClock = 0;
    let repeatClickCount = 0;
    // noinspection JSUnusedGlobalSymbols — structural test double
    const repeatClickHost = {
        getMode: () => 'extension',
        getState: () => ({ url: 'https://example.com/', title: '请稍候…' }),
        getLiveState: async () => ({ url: 'https://example.com/', title: '请稍候…' }),
        getChallengeState: async () => null,
        evaluate: async () => ({
            title: '请稍候…',
            url: 'https://example.com/',
            selectorHits: [],
            deniedHits: [],
            textHits: ['正在进行安全验证'],
            originResponsePending: false,
            turnstilePresent: true,
            clickPoint: { x: 40, y: 80 },
            clickTargetKind: 'widget',
            inspected: true,
        }),
        getCookies: async () => [],
        mouseMove: async () => {},
        mouseClick: async () => {
            repeatClickCount += 1;
        },
    };
    await assert.rejects(
        () =>
            waitForChallenge(repeatClickHost, {
                action: 'open',
                timeout: 12_000,
                now: () => repeatClickClock,
                sleep: async (ms) => {
                    repeatClickClock += ms;
                },
            }),
        (error) => {
            if (!(error instanceof ChallengeTimeoutError)) {
                return false;
            }
            assert.equal(error.toJSON().challengeKind, 'turnstile');
            assert.equal(error.toJSON().clickedTurnstile, true);
            assert.equal(repeatClickCount, 1);
            return true;
        }
    );

    let sequentialClock = 0;
    let sequentialClickCount = 0;
    const sequentialKinds = [];
    // noinspection JSUnusedGlobalSymbols — structural test double
    const sequentialHost = {
        getMode: () => 'extension',
        getState: () => ({ url: 'https://example.com/', title: '请稍候…' }),
        getLiveState: async () => ({ url: 'https://example.com/', title: '请稍候…' }),
        getChallengeState: async () => null,
        evaluate: async () => {
            const kind = sequentialClickCount === 0 ? 'widget' : 'verify';
            return {
                title: '请稍候…',
                url: 'https://example.com/',
                selectorHits: [],
                deniedHits: [],
                textHits: ['正在进行安全验证'],
                originResponsePending: false,
                turnstilePresent: true,
                clickPoint: kind === 'widget' ? { x: 40, y: 80 } : { x: 551, y: 330 },
                clickTargetKind: kind,
                inspected: true,
            };
        },
        getCookies: async () => [],
        mouseMove: async () => {},
        mouseClick: async () => {
            sequentialClickCount += 1;
            sequentialKinds.push(sequentialClickCount === 1 ? 'widget' : 'verify');
        },
    };
    await assert.rejects(
        () =>
            waitForChallenge(sequentialHost, {
                action: 'open',
                timeout: 16_000,
                now: () => sequentialClock,
                sleep: async (ms) => {
                    sequentialClock += ms;
                },
            }),
        (error) => {
            if (!(error instanceof ChallengeTimeoutError)) {
                return false;
            }
            assert.equal(error.toJSON().challengeKind, 'turnstile');
            assert.equal(error.toJSON().clickedTurnstile, true);
            assert.equal(sequentialClickCount, 2);
            assert.deepEqual(sequentialKinds, ['widget', 'verify']);
            return true;
        }
    );

    let sequentialOsClock = 0;
    let sequentialOsCount = 0;
    // noinspection JSUnusedGlobalSymbols — structural test double
    const sequentialOsHost = {
        getMode: () => 'extension',
        getState: () => ({ url: 'https://example.com/', title: '请稍候…' }),
        getLiveState: async () => ({ url: 'https://example.com/', title: '请稍候…' }),
        getChallengeState: async () => null,
        inspectChallenge: async () => {
            const kind = sequentialOsCount === 0 ? 'widget' : 'verify';
            return {
                title: '请稍候…',
                url: 'https://example.com/',
                selectorHits: [],
                deniedHits: [],
                textHits: ['正在进行安全验证'],
                originResponsePending: false,
                turnstilePresent: true,
                clickPoint: kind === 'widget' ? { x: 40, y: 80 } : { x: 551, y: 330 },
                clickTargetKind: kind,
                clickSource: 'iframe',
                inspected: true,
            };
        },
        evaluate: async () => {
            throw new Error('isolated inspect 成功后不得走 evaluate');
        },
        getCookies: async () => [],
        mouseMove: async () => {
            throw new Error('Cloudflare iframe 不得走页面鼠标');
        },
        mouseClick: async () => {
            throw new Error('Cloudflare iframe 不得走页面鼠标');
        },
        clickTurnstile: async () => {
            sequentialOsCount += 1;
        },
    };
    await assert.rejects(
        () =>
            waitForChallenge(sequentialOsHost, {
                action: 'open',
                timeout: 16_000,
                now: () => sequentialOsClock,
                sleep: async (ms) => {
                    sequentialOsClock += ms;
                },
            }),
        (error) => {
            assert.ok(error instanceof ChallengeTimeoutError);
            assert.equal(sequentialOsCount, 2);
            return true;
        }
    );

    // noinspection JSUnusedGlobalSymbols — structural test double
    const deniedHost = {
        getMode: () => 'cdp',
        getState: () => ({ url: 'https://example.com/', title: 'Access denied' }),
        getLiveState: async () => ({ url: 'https://example.com/', title: 'Access denied' }),
        getChallengeState: async () => ({ state: 'pending', mode: 'cdp' }),
        evaluate: async () => ({
            title: 'Access denied',
            url: 'https://example.com/',
            selectorHits: [],
            deniedHits: ['div.cf-error-title span.cf-code-label span'],
            turnstilePresent: false,
            clickPoint: null,
            inspected: true,
        }),
        getCookies: async () => [],
        mouseMove: async () => {},
        mouseClick: async () => {},
    };
    await assert.rejects(
        () => waitForChallenge(deniedHost, { action: 'open', timeout: 1_000 }),
        (error) => {
            if (!(error instanceof ChallengeDeniedError)) {
                return false;
            }
            assert.equal(error.toJSON().error.code, 'CHALLENGE_DENIED');
            assert.equal(error.toJSON().mode, 'cdp');
            assert.equal(error.toJSON().retryable, false);
            return true;
        }
    );
});

test('CH-08 Challenge state survives network log clearing until a normal document response', async () => {
    const [
        sessionSource,
        logManagerSource,
        handlerSource,
        bridgeSource,
        contentHandlerSource,
        actionsSource,
        pageScriptsSource,
    ] = await Promise.all([
        readFile(new URL('../src/core/session.ts', import.meta.url), 'utf8'),
        readFile(new URL('../extension/src/background/log-manager.ts', import.meta.url), 'utf8'),
        readFile(new URL('../extension/src/background/log-event-handler.ts', import.meta.url), 'utf8'),
        readFile(new URL('../src/extension/bridge.ts', import.meta.url), 'utf8'),
        readFile(new URL('../extension/src/background/content-handler.ts', import.meta.url), 'utf8'),
        readFile(new URL('../extension/src/background/actions.ts', import.meta.url), 'utf8'),
        readFile(new URL('../extension/src/background/page-scripts.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(sessionSource, /private challengeRequired = false/);
    assert.match(sessionSource, /this\.challengeRequired = challenge/);
    assert.match(sessionSource, /Target.getTargetInfo/);
    assert.match(sessionSource, /private runtimeEnabled = false/);
    // noinspection LongLine — 正则需要验证四个相邻 enable 调用的完整顺序
    assert.match(
        sessionSource,
        /this\.send\('Page.enable', undefined, remaining\(\)\),\s*this\.send\('DOM.enable', undefined, remaining\(\)\),\s*this\.send\('Network.enable', undefined, remaining\(\)\),\s*this\.send\('Log.enable', undefined, remaining\(\)\)/
    );
    assert.doesNotMatch(
        sessionSource,
        /this\.send\('Page.enable'\),\s*this\.send\('DOM.enable'\),\s*this\.send\('Runtime.enable'\)/
    );
    assert.match(logManagerSource, /private challengeRequired = new Map<number, boolean>\(\)/);
    assert.match(logManagerSource, /private mainFrameIds = new Map<number, string>\(\)/);
    assert.match(logManagerSource, /pending\.frameId === this\.mainFrameIds\.get\(tabId\)/);
    assert.match(logManagerSource, /this\.challengeRequired\.set\(tabId, pending\.challenge\)/);
    assert.match(handlerSource, /networkChallengeState/);
    assert.match(bridgeSource, /network_challenge_state/);
    assert.match(bridgeSource, /viewport_metrics/);
    assert.match(bridgeSource, /challenge_inspect/);
    assert.match(actionsSource, /viewport_metrics/);
    assert.match(actionsSource, /challenge_inspect/);
    assert.match(contentHandlerSource, /world: 'ISOLATED'/);
    assert.match(contentHandlerSource, /getViewportMetrics/);
    assert.match(contentHandlerSource, /inspectChallengePage/);
    assert.match(pageScriptsSource, /export function inspectChallengePage/);
    const [unifiedSessionSource, browseSource, inputSource, evaluateSource, challengeSource] = await Promise.all([
        readFile(new URL('../src/core/unified-session.ts', import.meta.url), 'utf8'),
        readFile(new URL('../src/tools/browse.ts', import.meta.url), 'utf8'),
        readFile(new URL('../src/tools/input.ts', import.meta.url), 'utf8'),
        readFile(new URL('../src/tools/evaluate.ts', import.meta.url), 'utf8'),
        readFile(new URL('../src/tools/challenge.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(browseSource, /resolveChallenge/);
    assert.match(unifiedSessionSource, /private cdpExplicitlySelected = false/);
    assert.match(unifiedSessionSource, /this\.activeMode === 'cdp' && this\.cdpExplicitlySelected/);
    assert.match(unifiedSessionSource, /extensionChallengeStateUnsupported/);
    assert.match(unifiedSessionSource, /Unknown action: network_challenge_state/);
    assert.match(browseSource, /unifiedSession\.setActiveMode\('cdp', true\)/);
    assert.match(evaluateSource, /mode: unifiedSession\.getMode\(\)/);
    assert.doesNotMatch(browseSource, /unifiedSession\.enableNetwork\(\)/);
    assert.doesNotMatch(inputSource, /unifiedSession\.enableNetwork\(\)/);
    assert.doesNotMatch(evaluateSource, /unifiedSession\.enableNetwork\(\)/);
    assert.match(challengeSource, /CHALLENGE_TIMEOUT/);
    assert.match(challengeSource, /interstitialPending && frameHits.length > 0/);
    assert.match(challengeSource, /CHALLENGE_INSPECT_GRACE_MS/);
    assert.match(challengeSource, /CHALLENGE_EXTENSION_PASSIVE_GRACE_MS/);
    assert.match(challengeSource, /emptyInspectCount/);
    assert.match(challengeSource, /inspectChallenge/);
    assert.match(challengeSource, /lastInspectAt = startedAt/);
    assert.match(challengeSource, /TURNSTILE_WIDGET_SELECTORS = \['#turnstile-wrapper', '\.cf-turnstile'\]/);
    assert.match(challengeSource, /'precise'/);
    assert.match(challengeSource, /clickedTargetKinds/);
    assert.match(challengeSource, /clickTargetKind/);
    assert.match(challengeSource, /TURNSTILE_VERIFY_BUTTON_SELECTORS/);
    assert.match(challengeSource, /请验证您是真人/);
    assert.match(challengeSource, /clickedTurnstile \? 'turnstile'/);
    assert.match(challengeSource, /host\.clickTurnstile/);
    assert.match(challengeSource, /clickSource/);
    assert.match(challengeSource, /cloudflareFramePresent/);
    assert.match(challengeSource, /useIframeClick/);
    assert.match(challengeSource, /Math\.min\(rect\.width, 300\)/);
    assert.match(challengeSource, /rect\.left \+ Math\.min\(20, Math\.max\(14, widgetWidth \/ 15\)\)/);
    assert.match(challengeSource, /rect\.top \+ Math\.min\(rect\.height, 65\) \/ 2/);
    assert.match(challengeSource, /vertical - horizontal/);
    assert.match(challengeSource, /pendingClick/);
    assert.match(challengeSource, /screenPoint/);
    assert.match(unifiedSessionSource, /osLeftClick/);
    assert.match(unifiedSessionSource, /resolveTurnstileOsClickPoint/);
    assert.match(unifiedSessionSource, /TURNSTILE_OS_CLICK_UNAVAILABLE/);
    assert.match(unifiedSessionSource, /debuggerDetach/);
    assert.match(unifiedSessionSource, /inspectChallenge/);
    assert.match(unifiedSessionSource, /readViewportMetrics/);
    assert.match(unifiedSessionSource, /getViewportMetrics/);
    assert.match(unifiedSessionSource, /asViewportMetrics/);
    assert.doesNotMatch(unifiedSessionSource, /VIEWPORT_METRICS_SCRIPT/);
    assert.match(unifiedSessionSource, /!windowInfo\.focused/);
    assert.doesNotMatch(unifiedSessionSource, /await this\.focusWindow\(/);
    assert.match(challengeSource, /host\.getMode\(\) === 'extension'/);
    assert.match(challengeSource, /pageTitle\.live/);
    for (const source of [challengeSource, pageScriptsSource]) {
        assert.match(source, /el\.scrollIntoView\(\{ block: 'center', inline: 'nearest', behavior: 'instant' \}\)/);
    }
    assert.match(challengeSource, /请稍候/);
    assert.match(challengeSource, /正在进行安全验证/);
    assert.doesNotMatch(challengeSource, /snapshot\.clickPoint && !clickedTurnstile/);
    assert.doesNotMatch(challengeSource, /CHALLENGE_HUMAN_REQUIRED/);
    assert.doesNotMatch(browseSource, /throwIfChallenge/);
});

test('CH-08 OS mouse converts CSS points and clicks linux/darwin/win32 via execFile', async () => {
    const viewport = {
        screenX: 100,
        screenY: 200,
        innerWidth: 1280,
        innerHeight: 720,
        outerWidth: 1280,
        outerHeight: 800,
        devicePixelRatio: 2,
    };
    assert.deepEqual(cssClientToScreen({ x: 40, y: 80 }, viewport, 'linux'), { x: 140, y: 360 });
    assert.deepEqual(cssClientToScreen({ x: 40, y: 80 }, viewport, 'win32'), { x: 280, y: 720 });
    assert.deepEqual(
        composeWindowClickPoint({ x: 40, y: 80 }, viewport, {
            x: 160,
            y: 120,
            width: 2560,
            height: 1600,
            insets: null,
        }),
        { x: 240, y: 440 }
    );
    const framed = {
        screenX: 80,
        screenY: 60,
        innerWidth: 1248,
        innerHeight: 681,
        outerWidth: 1280,
        outerHeight: 900,
        devicePixelRatio: 1,
    };
    assert.deepEqual(chromeInsets(framed), { left: 16, top: 187 });
    assert.deepEqual(
        composeWindowClickPoint({ x: 200, y: 313 }, framed, {
            x: 80,
            y: 60,
            width: 1280,
            height: 900,
            insets: { left: 16, right: 16, bottom: 16 },
        }),
        { x: 296, y: 576 }
    );
    assert.equal(windowNameMatchesPageTitle('请稍候… - Google Chrome', '请稍候…'), true);
    assert.equal(windowNameMatchesPageTitle('Gmail - Google Chrome', '请稍候…'), false);
    assert.equal(windowNameMatchesPageTitle('claude-tools – mcp-chrome/package.json', '请稍候…'), false);
    assert.deepEqual(parseXdotoolShell('X=160\nY=120\nWIDTH=1280\nHEIGHT=900\n'), {
        X: '160',
        Y: '120',
        WIDTH: '1280',
        HEIGHT: '900',
    });
    assert.deepEqual(
        resolveScreenClickPoint({ clickPoint: { x: 40, y: 80 }, viewport, screenPoint: { x: 140, y: 360 } }, 'linux'),
        { x: 140, y: 360 }
    );
    const path = buildOsMovePath({ x: 10, y: 10 }, { x: 140, y: 360 });
    assert.deepEqual(path[0], { x: 10, y: 10 });
    assert.deepEqual(path[path.length - 1], { x: 140, y: 360 });
    assert.ok(path.length >= 2);

    await assert.rejects(
        () =>
            resolveTurnstileOsClickPoint(
                { clickPoint: { x: viewport.innerWidth, y: 80 }, viewport, clickSource: 'iframe' },
                { platform: 'win32' }
            ),
        (error) => {
            assert.ok(error instanceof OsMouseError);
            assert.equal(error.code, 'TURNSTILE_OS_CLICK_UNAVAILABLE');
            assert.match(error.message, /不在当前页面视口内/);
            return true;
        }
    );

    const linuxPoint = await resolveTurnstileOsClickPoint(
        { clickPoint: { x: 40, y: 80 }, viewport, clickSource: 'iframe', title: '请稍候…' },
        {
            platform: 'linux',
            execFile: async (file, args) => {
                if (file === 'xprop') {
                    assert.deepEqual([...args], ['-id', '123', '_GTK_FRAME_EXTENTS']);
                    return { stdout: '_GTK_FRAME_EXTENTS:  not found.\n', stderr: '' };
                }
                assert.equal(file, 'xdotool');
                if (args[0] === 'getactivewindow') {
                    return { stdout: '123\n', stderr: '' };
                }
                if (args[0] === 'getwindowname') {
                    assert.deepEqual([...args], ['getwindowname', '123']);
                    return { stdout: '请稍候… - Google Chrome\n', stderr: '' };
                }
                assert.deepEqual([...args], ['getwindowgeometry', '--shell', '123']);
                return { stdout: 'X=160\nY=120\nWIDTH=2560\nHEIGHT=1600\n', stderr: '' };
            },
        }
    );
    assert.deepEqual(linuxPoint, { x: 240, y: 440 });

    await assert.rejects(
        () =>
            resolveTurnstileOsClickPoint(
                { clickPoint: { x: 40, y: 80 }, viewport, clickSource: 'iframe', title: '请稍候…' },
                {
                    platform: 'linux',
                    execFile: async (_file, args) => {
                        if (args[0] === 'getactivewindow') {
                            return { stdout: '123\n', stderr: '' };
                        }
                        if (args[0] === 'getwindowname') {
                            return { stdout: 'claude-tools – mcp-chrome/package.json\n', stderr: '' };
                        }
                        return { stdout: 'X=160\nY=120\n', stderr: '' };
                    },
                }
            ),
        (error) => {
            assert.ok(error instanceof OsMouseError);
            assert.equal(error.code, 'TURNSTILE_OS_CLICK_UNAVAILABLE');
            return true;
        }
    );

    await assert.rejects(
        () =>
            resolveTurnstileOsClickPoint(
                { clickPoint: { x: 40, y: 80 }, viewport, clickSource: 'iframe', title: '请稍候…' },
                {
                    platform: 'linux',
                    execFile: async (_file, args) => {
                        if (args[0] === 'getactivewindow') {
                            return { stdout: '123\n', stderr: '' };
                        }
                        if (args[0] === 'getwindowname') {
                            return { stdout: 'Gmail - Google Chrome\n', stderr: '' };
                        }
                        return { stdout: 'X=160\nY=120\n', stderr: '' };
                    },
                }
            ),
        (error) => {
            assert.ok(error instanceof OsMouseError);
            assert.equal(error.code, 'TURNSTILE_OS_CLICK_UNAVAILABLE');
            assert.match(error.message, /不是该受控测试页/);
            assert.doesNotMatch(error.message, /Gmail/);
            return true;
        }
    );

    await assert.rejects(
        () =>
            resolveTurnstileOsClickPoint(
                { clickPoint: { x: 40, y: 80 }, viewport, clickSource: 'iframe' },
                {
                    platform: 'linux',
                    execFile: async () => ({ stdout: '请稍候… - Google Chrome\n', stderr: '' }),
                }
            ),
        (error) => {
            assert.ok(error instanceof OsMouseError);
            assert.equal(error.code, 'TURNSTILE_OS_CLICK_UNAVAILABLE');
            return true;
        }
    );

    const linuxCalls = [];
    await osLeftClick(140, 360, {
        platform: 'linux',
        path: [
            { x: 100, y: 300 },
            { x: 140, y: 360 },
        ],
        sleep: async () => {},
        execFile: async (file, args) => {
            linuxCalls.push({ file, args: [...args] });
            return { stdout: '', stderr: '' };
        },
    });
    assert.deepEqual(nearbyPathStart({ x: 140, y: 360 }, { x: 2761, y: 995 }), { x: 68, y: 324 });
    assert.deepEqual(nearbyPathStart({ x: 140, y: 360 }, { x: 100, y: 300 }), { x: 100, y: 300 });
    assert.deepEqual(linuxCalls, [
        { file: 'xdotool', args: ['mousemove', '100', '300'] },
        { file: 'xdotool', args: ['mousemove', '140', '360'] },
        { file: 'xdotool', args: ['click', '--delay', '80', '1'] },
    ]);

    const darwinCalls = [];
    const darwinWarnings = [];
    await osLeftClick(10, 20, {
        platform: 'darwin',
        path: [{ x: 10, y: 20 }],
        warn: (message) => darwinWarnings.push(message),
        execFile: async (file, args) => {
            darwinCalls.push({ file, args: [...args] });
            if (file === 'cliclick') {
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            }
            return { stdout: '', stderr: '' };
        },
    });
    assert.equal(darwinCalls[0].file, 'cliclick');
    assert.deepEqual(darwinCalls[0].args, ['-e', '12', 'm:10,20', 'w:120', 'c:.']);
    assert.equal(darwinCalls[1].file, 'osascript');
    assert.match(darwinWarnings[0], /osascript/);

    const winCalls = [];
    await osLeftClick(5, 6, {
        platform: 'win32',
        path: [
            { x: 1, y: 2 },
            { x: 5, y: 6 },
        ],
        execFile: async (file, args) => {
            winCalls.push({ file, args: [...args] });
            return { stdout: '', stderr: '' };
        },
    });
    assert.equal(winCalls[0].file, 'powershell.exe');
    assert.match(winCalls[0].args.join(' '), /SetCursorPos\(1, 2\)/);
    assert.match(winCalls[0].args.join(' '), /SetCursorPos\(5, 6\)/);
    assert.match(winCalls[0].args.join(' '), /mouse_event\(2/);

    await assert.rejects(
        () =>
            osLeftClick(1, 2, {
                platform: 'linux',
                path: [{ x: 1, y: 2 }],
                sleep: async () => {},
                execFile: async () => {
                    throw Object.defineProperty(new Error('missing'), 'code', { value: 'ENOENT' });
                },
            }),
        (error) => {
            assert.ok(error instanceof OsMouseError);
            assert.equal(error.code, 'OS_MOUSE_UNAVAILABLE');
            return true;
        }
    );
});

test('C-P6 OS mouse stops before a later process or fallback after deadline exhaustion', async () => {
    const NativeDate = Date;
    let now = 1000;
    class ClockDate extends NativeDate {
        static now() {
            return now;
        }
    }
    const originalDate = globalThis.Date;
    globalThis.Date = ClockDate;
    try {
        const calls = [];
        await assert.rejects(
            () =>
                osLeftClick(12, 34, {
                    platform: 'linux',
                    deadline: 1100,
                    path: [
                        { x: 10, y: 30 },
                        { x: 12, y: 34 },
                    ],
                    execFile: async (_file, args, options) => {
                        calls.push([...args]);
                        assert.ok(options.timeout > 0);
                        return { stdout: '', stderr: '' };
                    },
                    sleep: async () => {
                        now = 1200;
                    },
                }),
            (error) => error.code === 'TIMEOUT'
        );
        assert.deepEqual(calls, [['mousemove', '10', '30']]);
        now = 1000;
        const fallbackCalls = [];
        await assert.rejects(
            () =>
                osLeftClick(12, 34, {
                    platform: 'darwin',
                    deadline: 1100,
                    path: [{ x: 12, y: 34 }],
                    warn() {},
                    execFile: async (file) => {
                        fallbackCalls.push(file);
                        now = 1200;
                        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
                    },
                }),
            (error) => error.code === 'TIMEOUT'
        );
        assert.deepEqual(fallbackCalls, ['cliclick']);
    } finally {
        globalThis.Date = originalDate;
    }
});

test('CH-08 cookie clearing requires a URL or domain at every boundary', async () => {
    const [toolSource, sessionSource, cookieHandlerSource, schemaSource] = await Promise.all([
        readFile(new URL('../src/tools/cookies.ts', import.meta.url), 'utf8'),
        readFile(new URL('../src/core/session.ts', import.meta.url), 'utf8'),
        readFile(new URL('../extension/src/background/cookie-handler.ts', import.meta.url), 'utf8'),
        readFile(new URL('../extension/src/types/schemas.ts', import.meta.url), 'utf8'),
    ]);
    for (const source of [toolSource, sessionSource, cookieHandlerSource, schemaSource]) {
        assert.match(source, /url 或 domain/);
    }
});
