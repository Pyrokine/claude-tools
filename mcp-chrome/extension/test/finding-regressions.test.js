import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { ActionHandler } from '../src/background/actions.ts';
import { assertReadableTab, getDomFrameSnapshot, recordDomFrameProbe } from '../src/background/action-utils.ts';
import { ContentHandler } from '../src/background/content-handler.ts';
import { CookieHandler } from '../src/background/cookie-handler.ts';
import { DebuggerBlockedError, DebuggerManager } from '../src/background/debugger-manager.ts';
import { DebuggerHandler } from '../src/background/debugger-handler.ts';
import { FrameResolver } from '../src/background/frame-resolver.ts';
import { ExpectedOperationError } from '../src/types/expected-errors.ts';
import { HttpClient } from '../src/background/http-client.ts';
import { InputEventHandler } from '../src/background/input-event-handler.ts';
import { StealthHandler } from '../src/background/stealth-handler.ts';
import { LogEventHandler } from '../src/background/log-event-handler.ts';
import { LogManager } from '../src/background/log-manager.ts';
import { NavigationHandler } from '../src/background/navigation-handler.ts';
import { advancePageRevision, forgetPageRevision, pageSnapshot } from '../src/background/page-revision.ts';
import { hasReadGrant, revokeReadGrants, revokeTabReadGrants, setReadGrant } from '../src/background/read-grants.ts';
import {
    executeCode,
    extractAttribute,
    extractHtml,
    extractHtmlWithImages,
    extractMetadata,
    extractText,
    findElements,
    generateAccessibilityTree,
    getComputedStyleFromElement,
    inspectChallengePage,
    performActionableClick,
    simulateKeyboardType,
} from '../src/background/page-scripts.ts';
import { TabHandler } from '../src/background/tab-handler.ts';
import {
    isManagedTab,
    markManagedTab,
    restoreManagedTabs,
    setMcpTabGroupId,
    setMcpWindowId,
    unmarkManagedTab,
} from '../src/background/tab-state.ts';
import { EvaluateSchema } from '../src/types/schemas.ts';

test('CH-08 serialized inspection recognizes visible verification buttons without changing iframe routing', () => {
    const options = {
        challengeSelectors: ['#cf-please-wait'],
        deniedSelectors: [],
        widgetSelectors: ['.cf-turnstile'],
        frameSelectors: ['iframe[src*="challenges.cloudflare.com"]'],
        verifyButtonSelectors: ['input[type="button"][value="Verify you are human"]'],
        titleNeedles: ['just a moment'],
        textMarkers: ['正在进行安全验证'],
        originResponsePendingTextMarkers: [],
    };
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
        const inspect = vm.runInNewContext(`(${inspectChallengePage.toString()})`, {
            document,
            window,
            location: { href: 'https://example.com/challenge' },
        });
        const result = inspect(options);
        assert.equal(result.clickSource, scenario.source, JSON.stringify(scenario));
        assert.equal(result.clickTargetKind, scenario.source === 'page' || scenario.frame ? 'verify' : 'widget');
    }
});

test('C22 attach conflicts recover only a proven debugger session owned by this Extension', async (t) => {
    for (const specimen of [
        { name: 'owned', proof: { id: 'owned-isolate' }, owned: true },
        {
            name: 'already-attached',
            message: 'Debugger is already attached',
            proof: { id: 'owned-isolate' },
            owned: true,
        },
        { name: 'external', error: new Error('Debugger is not attached') },
        { name: 'missing', proof: undefined },
        { name: 'empty', proof: { id: '' } },
        { name: 'whitespace', proof: { id: '  ' } },
        { name: 'wrong-type', proof: { id: 1 } },
    ]) {
        await t.test(specimen.name, async () => {
            let attaches = 0;
            let probes = 0;
            const restore = installGlobals({
                chrome: {
                    debugger: {
                        async attach(target) {
                            assert.deepEqual(target, { tabId: 1 });
                            ++attaches;
                            throw new Error(specimen.message ?? 'Another debugger is already attached');
                        },
                        async sendCommand(target, method) {
                            assert.deepEqual(target, { tabId: 1 });
                            assert.equal(method, 'Runtime.getIsolateId');
                            ++probes;
                            if (specimen.error) throw specimen.error;
                            return specimen.proof;
                        },
                    },
                },
            });
            try {
                const manager = new DebuggerManager({});
                const results = await Promise.allSettled([manager.ensureAttached(1), manager.ensureAttached(1)]);
                assert.equal(attaches, 1);
                assert.equal(probes, 1);
                assert.equal(manager.isAttached(1), specimen.owned === true);
                assert.equal(manager.isBlocked(1), specimen.owned !== true);
                if (specimen.owned) {
                    assert.ok(results.every((result) => result.status === 'fulfilled'));
                    await manager.ensureAttached(1);
                } else {
                    assert.ok(
                        results.every(
                            (result) => result.status === 'rejected' && result.reason instanceof DebuggerBlockedError
                        )
                    );
                    await assert.rejects(() => manager.ensureAttached(1), DebuggerBlockedError);
                }
                assert.equal(attaches, 1);
                assert.equal(probes, 1);
            } finally {
                restore();
            }
        });
    }
});

test('C22 cleanup invalidates an ownership probe without removing a replacement pending attach', async () => {
    const proof = createDeferred();
    const replacement = createDeferred();
    let attaches = 0;
    let probes = 0;
    const restore = installGlobals({
        chrome: {
            debugger: {
                async attach() {
                    if (++attaches === 1) throw new Error('Another debugger is already attached');
                    await replacement.promise;
                },
                async sendCommand() {
                    ++probes;
                    return proof.promise;
                },
            },
        },
    });
    try {
        const manager = new DebuggerManager({});
        const first = manager.ensureAttached(1);
        await waitUntil(() => probes === 1);
        manager.cleanupTab(1);
        const second = manager.ensureAttached(1);
        proof.resolve({ id: 'previous-isolate' });
        await first;
        assert.equal(manager.isAttached(1), false);
        const third = manager.ensureAttached(1);
        assert.equal(attaches, 2);
        replacement.resolve();
        await Promise.all([second, third]);
        assert.equal(attaches, 2);
        assert.equal(manager.isAttached(1), true);
    } finally {
        proof.resolve({ id: 'previous-isolate' });
        replacement.resolve();
        restore();
    }
});

test('C22 non-conflict attach errors retain the original error without probing', async () => {
    const failure = new Error('No tab with given id');
    let probes = 0;
    const restore = installGlobals({
        chrome: {
            debugger: {
                async attach() {
                    throw failure;
                },
                async sendCommand() {
                    ++probes;
                },
            },
        },
    });
    try {
        const manager = new DebuggerManager({});
        await assert.rejects(
            () => manager.ensureAttached(1),
            (error) => error === failure
        );
        assert.equal(probes, 0);
        assert.equal(manager.isAttached(1), false);
        assert.equal(manager.isBlocked(1), false);
    } finally {
        restore();
    }
});

test('C24 serialized inspection does not infer a widget from an unrelated div beside a zero-size iframe', () => {
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
    const inspect = vm.runInNewContext(`(${inspectChallengePage.toString()})`, {
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
    const result = inspect({
        challengeSelectors: [],
        deniedSelectors: [],
        widgetSelectors: ['.cf-turnstile'],
        verifyButtonSelectors: ['input[type="button"]'],
        frameSelectors: ['iframe[src*="challenges.cloudflare.com"]'],
        titleNeedles: ['just a moment'],
        textMarkers: [],
        originResponsePendingTextMarkers: [],
    });
    assert.equal(result.turnstilePresent, true);
    assert.equal(result.clickPoint, null);
    assert.equal(result.clickTargetKind, null);
    assert.equal(scrolls, 0);
});

test('C-P6 expired queued navigation does not reach its handler', async (t) => {
    for (const action of [
        'navigate',
        'go_back',
        'go_forward',
        'reload',
        'stealth_click',
        'input_mouse',
        'stealth_mouse',
        'debugger_detach',
        'challenge_inspect',
    ]) {
        await t.test(action, async () => {
            const fixture = createTabManagementFixture();
            const NativeDate = Date;
            let now = 1000;
            class ClockDate extends NativeDate {
                static now() {
                    return now;
                }
            }
            const restore = installGlobals({ chrome: fixture.chrome, Date: ClockDate });
            const blocker = createDeferred();
            const entered = createDeferred();
            let handler;
            let dispatched = 0;
            try {
                await markManagedTab(5001);
                handler = new ActionHandler();
                handler.actions.set('evaluate', async () => {
                    entered.resolve();
                    await blocker.promise;
                });
                handler.actions.set(action, async () => {
                    ++dispatched;
                });
                const previous = handler.execute('evaluate', { tabId: 5001 }, {});
                await entered.promise;
                const queued = handler.execute(action, { tabId: 5001, deadline: now + 100 }, {});
                now += 200;
                blocker.resolve();
                await previous;
                await assert.rejects(
                    () => queued,
                    (error) => {
                        const body = JSON.parse(error.message).error;
                        assert.equal(body.code, 'TIMEOUT');
                        assert.equal(body.context.actionExecuted, false);
                        assert.equal(body.context.retryable, false);
                        return true;
                    }
                );
                assert.equal(dispatched, 0);
                assert.equal(handler.actionLocks.size, 0);
            } finally {
                blocker.resolve();
                if (handler?.logManager.sweepTimer) globalThis.clearInterval(handler.logManager.sweepTimer);
                await unmarkManagedTab(5001);
                forgetPageRevision(5001);
                restore();
            }
        });
    }
});

test('C10 mouse deadlines survive schemas and asynchronous preparation', async (t) => {
    for (const route of ['precise', 'stealth']) {
        for (const stage of ['page', 'dispatch', 'within-budget']) {
            await t.test(`${route}-${stage}`, async () => {
                const fixture = createTabManagementFixture();
                const NativeDate = Date;
                let now = 1000;
                let nativeEvents = 0;
                let scriptCalls = 0;
                class ClockDate extends NativeDate {
                    static now() {
                        return now;
                    }
                }
                const element = {
                    dispatchEvent() {
                        ++nativeEvents;
                    },
                };
                const getTab = fixture.chrome.tabs.get;
                fixture.chrome.tabs.get = async (...args) => {
                    const tab = await getTab(...args);
                    if (stage === 'page') now = 1200;
                    return tab;
                };
                fixture.chrome.debugger.sendCommand = async () => {
                    ++nativeEvents;
                };
                fixture.chrome.scripting = {
                    executeScript: async ({ func, args }) => {
                        ++scriptCalls;
                        if (stage === 'dispatch') now = 1200;
                        return [{ result: func(...args) }];
                    },
                };
                const restore = installGlobals({
                    chrome: fixture.chrome,
                    Date: ClockDate,
                    window: { screenX: 0, screenY: 0 },
                    document: { elementFromPoint: () => element, body: element },
                    MouseEvent: class {
                        constructor(type, options) {
                            Object.assign(this, { type }, options);
                        }
                    },
                });
                try {
                    await markManagedTab(5001);
                    now = 1000;
                    const handler =
                        route === 'precise'
                            ? new InputEventHandler({
                                  ensureAttached: async () => {
                                      if (stage === 'dispatch') now = 1200;
                                  },
                              })
                            : new StealthHandler();
                    const method = route === 'precise' ? 'inputMouse' : 'stealthMouse';
                    const params = {
                        tabId: 5001,
                        frameId: 0,
                        type: route === 'precise' ? 'mouseMoved' : 'mousemove',
                        x: 12,
                        y: 34,
                        deadline: 1100,
                    };
                    if (stage === 'within-budget') {
                        assert.deepEqual(await handler[method](params, {}), { success: true });
                        assert.equal(nativeEvents, 1);
                    } else {
                        await assert.rejects(() => handler[method](params, {}), /timeout/i);
                        assert.equal(nativeEvents, 0);
                    }
                    assert.equal(scriptCalls, route === 'stealth' && stage !== 'page' ? 1 : 0);
                    if (route === 'precise') assert.equal(handler.buttonsState.size, 0);
                } finally {
                    await unmarkManagedTab(5001);
                    restore();
                }
            });
        }
    }
});

test('C-P6 Challenge native dispatch checks the budget after page validation', async (t) => {
    for (const action of ['stealth_click', 'debugger_detach', 'challenge_inspect']) {
        await t.test(action, async () => {
            const fixture = createTabManagementFixture();
            const NativeDate = Date;
            let now = 1000;
            let dispatched = 0;
            class ClockDate extends NativeDate {
                static now() {
                    return now;
                }
            }
            const getTab = fixture.chrome.tabs.get;
            fixture.chrome.tabs.get = async (...args) => {
                const tab = await getTab(...args);
                now = 2000;
                return tab;
            };
            fixture.chrome.scripting = {
                executeScript: async () => {
                    ++dispatched;
                    return [{ result: { success: true } }];
                },
            };
            fixture.chrome.debugger.detach = async () => {
                ++dispatched;
            };
            const restore = installGlobals({ chrome: fixture.chrome, Date: ClockDate });
            try {
                await markManagedTab(5001);
                now = 1000;
                const params = {
                    tabId: 5001,
                    deadline: 1100,
                    x: 12,
                    y: 34,
                    challengeSelectors: [],
                    deniedSelectors: [],
                    widgetSelectors: [],
                    verifyButtonSelectors: [],
                    frameSelectors: [],
                    titleNeedles: [],
                    textMarkers: [],
                    originResponsePendingTextMarkers: [],
                };
                const manager = { isAttached: () => true, cleanupTab() {} };
                const handler =
                    action === 'stealth_click'
                        ? new StealthHandler()
                        : action === 'debugger_detach'
                          ? new DebuggerHandler(manager, { handleDebuggerDetach() {} })
                          : new ContentHandler(manager);
                const method =
                    action === 'stealth_click'
                        ? 'stealthClick'
                        : action === 'debugger_detach'
                          ? 'debuggerDetach'
                          : 'inspectChallenge';
                await assert.rejects(() => handler[method](params, {}), /timeout/i);
                assert.equal(dispatched, 0);
            } finally {
                await unmarkManagedTab(5001);
                restore();
            }
        });
    }
});

test('C-P6 history signal and load waits share one navigation budget', async () => {
    const fixture = createTabManagementFixture();
    const NativeDate = Date;
    let now = 1000;
    class ClockDate extends NativeDate {
        static now() {
            return now;
        }
    }
    const restore = installGlobals({ chrome: fixture.chrome, Date: ClockDate });
    const waits = [];
    const handler = new NavigationHandler({});
    handler.navigateHistory = async () => {
        now += 40;
        return true;
    };
    handler.waitForNavigation = async (_tabId, _wait, timeout) => {
        waits.push(timeout);
    };
    try {
        await markManagedTab(5001);
        await handler.goBack({ tabId: 5001, waitUntil: 'load', timeout: 100, deadline: now + 100 }, {});
        await handler.goForward({ tabId: 5001, waitUntil: 'load', timeout: 100, deadline: now + 100 }, {});
        assert.deepEqual(waits, [60, 60]);
    } finally {
        await unmarkManagedTab(5001);
        restore();
    }
});

test('C-P6 expired navigation is rejected before native URL update', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    const handler = new NavigationHandler({});
    try {
        await markManagedTab(5001);
        await assert.rejects(
            () => handler.navigate({ tabId: 5001, url: 'https://example.com/next', deadline: Date.now() - 1 }, {}),
            /timeout/i
        );
        assert.equal(
            fixture.calls.some((call) => call.method === 'tabs.update'),
            false
        );
    } finally {
        await unmarkManagedTab(5001);
        restore();
    }
});

test('C10 precise typing stops at the execution deadline', async (t) => {
    for (const specimen of [
        { text: 'abc', delay: 0, budget: 15, expected: 'ab' },
        { text: 'abc', delay: 100, budget: 50, expected: 'a' },
        { text: 'abc', delay: 0, budget: 0, expected: '' },
    ]) {
        await t.test(JSON.stringify(specimen), async () => {
            let now = 1000;
            const typed = [];
            const NativeDate = Date;
            class ClockDate extends NativeDate {
                static now() {
                    return now;
                }
            }
            const restore = installGlobals({
                Date: ClockDate,
                setTimeout(callback, ms) {
                    now += ms;
                    callback();
                    return 0;
                },
                chrome: {
                    storage: createStorage(),
                    tabs: { get: async () => ({ id: 101, url: 'https://example.com/owned' }) },
                    debugger: {
                        async sendCommand(_target, _method, params) {
                            if (params.type === 'char') typed.push(params.text);
                            now += 10;
                        },
                    },
                },
            });
            try {
                await markManagedTab(101);
                const handler = new InputEventHandler({ ensureAttached: async () => {} });
                await assert.rejects(
                    () =>
                        handler.inputType(
                            {
                                tabId: 101,
                                text: specimen.text,
                                delay: specimen.delay,
                                deadline: now + specimen.budget,
                            },
                            {}
                        ),
                    /timeout|超时/i
                );
                assert.equal(typed.join(''), specimen.expected);
            } finally {
                await unmarkManagedTab(101);
                restore();
            }
        });
    }
});

test('C10 precise typing keeps CRLF normalization within a sufficient budget', async () => {
    const calls = [];
    const restore = installGlobals({
        chrome: {
            storage: createStorage(),
            tabs: { get: async () => ({ id: 101, url: 'https://example.com/owned' }) },
            debugger: {
                sendCommand: async (_target, _method, params) => {
                    calls.push(params);
                },
            },
        },
    });
    try {
        await markManagedTab(101);
        const handler = new InputEventHandler({ ensureAttached: async () => {} });
        const result = await handler.inputType({ tabId: 101, text: 'a\r\nb\rc', deadline: Date.now() + 1000 }, {});
        assert.equal(result.success, true);
        assert.deepEqual(
            calls.filter((call) => call.type === 'char').map((call) => call.text),
            ['a', '\r', 'b', '\r', 'c']
        );
        assert.equal(calls.filter((call) => call.key === 'Enter').length, 6);
    } finally {
        await unmarkManagedTab(101);
        restore();
    }
});

test('C10 precise typing releases Enter after a keydown acknowledgement failure', async () => {
    const calls = [];
    const failure = new ExpectedOperationError('input timeout during typing');
    const restore = installGlobals({
        chrome: {
            storage: createStorage(),
            tabs: { get: async () => ({ id: 101, url: 'https://example.com/owned' }) },
            debugger: {
                sendCommand: async (_target, _method, params) => {
                    calls.push(params);
                    if (params.type === 'keyDown') throw failure;
                },
            },
        },
    });
    try {
        await markManagedTab(101);
        const handler = new InputEventHandler({ ensureAttached: async () => {} });
        await assert.rejects(
            () =>
                handler.inputType(
                    {
                        tabId: 101,
                        text: '\n',
                        deadline: Date.now() + 1000,
                    },
                    {}
                ),
            (error) => error === failure
        );
        assert.deepEqual(
            calls.map((params) => params.type),
            ['keyDown', 'keyUp']
        );
        calls.length = 0;
        await assert.rejects(
            () =>
                handler.inputType(
                    {
                        tabId: 101,
                        text: '\n',
                        deadline: 0,
                    },
                    {}
                ),
            /timeout|超时/i
        );
        assert.deepEqual(calls, []);
    } finally {
        await unmarkManagedTab(101);
        restore();
    }
});

test('C10 stealth typing stops in the injected function and propagates its failure', async (t) => {
    let now = 1000;
    let minimumTimerDelay = 0;
    const events = [];
    class Input {
        tagName = 'TEXTAREA';
        isContentEditable = false;
        stored = '';
        get value() {
            return this.stored;
        }

        set value(value) {
            this.stored = value.replace(/\r\n?/g, '\n');
        }

        dispatchEvent(event) {
            events.push(event.type);
        }
    }
    class Event {
        constructor(type) {
            this.type = type;
        }
    }
    const element = new Input();
    const run = vm.runInNewContext(`(${simulateKeyboardType.toString()})`, {
        document: { activeElement: element },
        window: {},
        HTMLInputElement: Input,
        HTMLTextAreaElement: Input,
        Event,
        KeyboardEvent: Event,
        InputEvent: Event,
        Date: { now: () => now },
        setTimeout(callback, ms) {
            now += Math.max(ms, minimumTimerDelay);
            callback();
            return 0;
        },
    });
    await t.test('background timers delay only subsequent characters', async () => {
        minimumTimerDelay = 1000;
        const partial = await run('abc', 100, 2000);
        assert.equal(partial.success, false);
        assert.match(partial.error, /timeout|超时/i);
        assert.equal(element.value, 'a');
        assert.equal(events.filter((type) => type === 'input').length, 1);
        assert.equal(events.includes('change'), false);
        element.value = '';
        events.length = 0;
        const expired = await run('blocked', 100, now);
        assert.equal(expired.success, false);
        assert.equal(element.value, '');
        assert.deepEqual(events, []);
    });
    now = 1000;
    minimumTimerDelay = 0;
    element.value = '';
    events.length = 0;
    const result = await run('abc', 100, 1150);
    assert.equal(result.success, false);
    assert.match(result.error, /timeout|超时/i);
    assert.equal(element.value, 'ab');
    assert.equal(events.filter((type) => type === 'input').length, 2);
    element.value = '';
    events.length = 0;
    const normalized = await run('a\r\nb\rc', 0, 2000);
    assert.equal(normalized.success, true);
    assert.equal(element.value, 'a\nb\nc');
    assert.equal(events.filter((type) => type === 'input').length, 5);
    const injections = [];
    const restore = installGlobals({
        chrome: {
            storage: createStorage(),
            tabs: { get: async () => ({ id: 101, url: 'https://example.com/owned' }) },
            scripting: {
                executeScript: async (params) => {
                    injections.push(params);
                    return [{ result }];
                },
            },
        },
    });
    try {
        await markManagedTab(101);
        await assert.rejects(
            () =>
                new StealthHandler().stealthType(
                    {
                        tabId: 101,
                        frameId: 3,
                        text: 'abc',
                        delay: 100,
                        deadline: 1150,
                    },
                    {}
                ),
            /timeout|超时/i
        );
        assert.equal(injections.length, 1);
        assert.deepEqual(injections[0].target.frameIds, [3]);
        assert.deepEqual(injections[0].args, ['abc', 100, 1150]);
    } finally {
        await unmarkManagedTab(101);
        restore();
    }
});

function installGlobals(values) {
    const descriptors = new Map();
    for (const [name, value] of Object.entries(values)) {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    return () => {
        for (const [name, descriptor] of descriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    };
}

function chromeEvent() {
    const listeners = new Set();
    return {
        addListener(listener) {
            listeners.add(listener);
        },
        removeListener(listener) {
            listeners.delete(listener);
        },
        emit(...args) {
            for (const listener of [...listeners]) {
                listener(...args);
            }
        },
        get size() {
            return listeners.size;
        },
    };
}

class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.sent = [];
        FakeWebSocket.instances.push(this);
    }

    open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
    }

    send(message) {
        this.sent.push(message);
    }

    close() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.();
    }
}

function createStorage(initial = {}) {
    const values = { ...initial };
    const sessionValues = {};
    return {
        values,
        local: {
            async get(key) {
                if (typeof key === 'string') {
                    return { [key]: values[key] };
                }
                return { ...values };
            },
            async set(update) {
                Object.assign(values, update);
            },
        },
        session: {
            async get(key) {
                if (typeof key === 'string') {
                    return { [key]: sessionValues[key] };
                }
                return { ...sessionValues };
            },
            async set(update) {
                Object.assign(sessionValues, update);
            },
            async remove(key) {
                delete sessionValues[key];
            },
        },
    };
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function waitUntil(predicate) {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    }
    throw new Error('condition not reached');
}

test('C3 Extension rejects stale page conditions before any handler side effect', async () => {
    const fixture = createTabManagementFixture();
    const tab = { id: 901, url: 'https://example.com/a' };
    fixture.tabs.set(tab.id, tab);
    let handler;
    const restore = installGlobals({ chrome: fixture.chrome });
    try {
        await markManagedTab(tab.id);
        handler = new ActionHandler();
        let actions = 0;
        handler.actions.set('navigate', async () => {
            actions++;
            tab.url = 'https://example.com/b';
        });
        const original = await pageSnapshot(tab.id);
        await assert.rejects(
            () => handler.execute('navigate', { tabId: tab.id, expectedRevision: 'stale' }, {}),
            /ACTION_PRECONDITION_FAILED/
        );
        assert.equal(actions, 0);
        assert.deepEqual(await pageSnapshot(tab.id), original);
        await handler.execute(
            'navigate',
            {
                tabId: tab.id,
                expectedUrl: original.url,
                expectedRevision: original.revision,
            },
            {}
        );
        assert.equal(actions, 1);
        const updated = await pageSnapshot(tab.id);
        assert.notEqual(updated.revision, original.revision);
        await assert.rejects(
            () => handler.execute('navigate', { tabId: tab.id, expectedRevision: original.revision }, {}),
            /ACTION_PRECONDITION_FAILED/
        );
        assert.equal(actions, 1);
    } finally {
        if (handler?.logManager.sweepTimer) {
            globalThis.clearInterval(handler.logManager.sweepTimer);
        }
        await unmarkManagedTab(tab.id);
        forgetPageRevision(tab.id);
        restore();
    }
});

test('C4 read grants scope ordinary reads by server instance, page and URL', async () => {
    const tab = { id: 902, url: 'https://example.com/a' };
    let documentId = 'document-a';
    let handler;
    const records = new Map();
    let injectedWorld;
    let injectionTarget;
    let revokeDuringRead = false;
    const restore = installGlobals({
        chrome: {
            tabs: {
                async get(id) {
                    assert.equal(id, tab.id);
                    return tab;
                },
            },
            storage: {
                session: {
                    async get(key) {
                        return Object.fromEntries([...records].filter(([name]) => key === null || name === key));
                    },
                    async set(entries) {
                        for (const [name, value] of Object.entries(entries)) {
                            records.set(name, value);
                        }
                    },
                    async remove(key) {
                        records.delete(key);
                    },
                },
            },
            webNavigation: {
                async getFrame({ tabId, frameId }) {
                    assert.equal(tabId, tab.id);
                    assert.equal(frameId, 0);
                    return { documentId, url: tab.url };
                },
            },
            scripting: {
                async executeScript(options) {
                    injectedWorld = options.world;
                    injectionTarget = options.target;
                    if (revokeDuringRead) {
                        revokeDuringRead = false;
                        await setReadGrant('server-a', tab.id, false);
                    }
                    if (options.func === getComputedStyleFromElement) {
                        return [{ result: 'rgb(1, 2, 3)' }];
                    }
                    return [{ result: { html: '<main>Allowed</main>' } }];
                },
            },
            debugger: { onDetach: chromeEvent(), onEvent: chromeEvent() },
        },
    });
    const context = { serverInstanceId: 'server-a', mcpWindowId: null, mcpTabGroupId: null };
    try {
        handler = new ActionHandler();
        const content = new ContentHandler(handler.debuggerManager);
        await assert.rejects(() => content.getHtml({ tabId: tab.id }, context), /只读权限/);
        await assert.rejects(
            () => handler.execute('get_computed_style', { tabId: tab.id, refId: 'ref_1', prop: 'color' }, context),
            /只读权限/
        );
        await setReadGrant('server-a', tab.id, true);
        assert.equal(await hasReadGrant('server-a', tab.id), true);
        assert.equal(await hasReadGrant('server-b', tab.id), false);
        assert.deepEqual(await content.getHtml({ tabId: tab.id }, context), { html: '<main>Allowed</main>' });
        assert.equal(injectedWorld, 'ISOLATED');
        assert.deepEqual(injectionTarget, { tabId: tab.id, documentIds: ['document-a'] });
        assert.equal(
            await handler.execute('get_computed_style', { tabId: tab.id, refId: 'ref_1', prop: 'color' }, context),
            'rgb(1, 2, 3)'
        );
        assert.deepEqual(injectionTarget, { tabId: tab.id, documentIds: ['document-a'] });
        revokeDuringRead = true;
        await assert.rejects(() => content.getHtml({ tabId: tab.id }, context), /只读权限/);
        await setReadGrant('server-a', tab.id, true);
        documentId = 'document-b';
        assert.equal(await hasReadGrant('server-a', tab.id), false);
        documentId = 'document-a';
        const [grantKey] = records.keys();
        records.get(grantKey)[0].revision = 'previous-worker:0';
        assert.equal(await hasReadGrant('server-a', tab.id), true);
        assert.equal(records.get(grantKey)[0].revision, (await pageSnapshot(tab.id)).revision);
        advancePageRevision(tab.id);
        assert.equal(await hasReadGrant('server-a', tab.id), false);
        await setReadGrant('server-a', tab.id, true);
        await assert.rejects(() => handler.execute('evaluate', { tabId: tab.id, code: '1+1' }, context), /非托管/);
        await assert.rejects(() => handler.execute('screenshot', { tabId: tab.id }, context), /非托管/);
        tab.url = 'https://example.com/b';
        assert.equal(await hasReadGrant('server-a', tab.id), false);
        await assert.rejects(() => assertReadableTab(tab.id, context, 'read_page'), /只读权限/);
        await revokeTabReadGrants(tab.id);
        tab.url = 'https://example.com/a';
        assert.equal(await hasReadGrant('server-a', tab.id), false);
        await setReadGrant('server-a', tab.id, true);
        await setReadGrant('server-b', tab.id, true);
        await revokeReadGrants('server-a');
        assert.equal(await hasReadGrant('server-a', tab.id), false);
        assert.equal(await hasReadGrant('server-b', tab.id), true);
    } finally {
        if (handler?.logManager.sweepTimer) {
            globalThis.clearInterval(handler.logManager.sweepTimer);
        }
        forgetPageRevision(tab.id);
        restore();
    }
});

test('C4 explicit adoption grants full managed access and release revokes it without changing groups', async () => {
    const tab = { id: 2901, url: 'https://example.com/adopted', groupId: 77, windowId: 5 };
    const context = { serverInstanceId: 'adopt-server', mcpWindowId: null, mcpTabGroupId: 77 };
    const worlds = [];
    let handler;
    let ungrouped = 0;
    const restore = installGlobals({
        chrome: {
            tabs: {
                get: async () => tab,
                async ungroup() {
                    ungrouped++;
                    tab.groupId = -1;
                },
            },
            storage: createStorage(),
            webNavigation: {
                getFrame: async () => ({ documentId: 'adopted-document', url: tab.url }),
            },
            scripting: {
                async executeScript(options) {
                    worlds.push(options.world);
                    return [{ result: { text: 'adopted content' } }];
                },
            },
            debugger: { onDetach: chromeEvent(), onEvent: chromeEvent() },
        },
    });
    try {
        handler = new ActionHandler();
        await unmarkManagedTab(tab.id);
        const adopted = await handler.execute('tabs_adopt', { tabId: tab.id }, context);
        assert.equal(adopted.managedAfter, true);
        assert.deepEqual(await handler.execute('get_text', { tabId: tab.id }, context), { text: 'adopted content' });
        assert.equal(worlds.at(-1), 'MAIN');
        for (const action of ['evaluate', 'screenshot', 'input_type', 'debugger_send', 'console_get']) {
            let executed = 0;
            handler.actions.set(action, async () => {
                executed++;
                return { success: true };
            });
            assert.deepEqual(await handler.execute(action, { tabId: tab.id }, context), { success: true });
            assert.equal(executed, 1, action);
        }
        const released = await handler.execute('tabs_release', { tabId: tab.id }, context);
        assert.equal(released.managedAfter, false);
        assert.equal(tab.groupId, 77);
        assert.equal(ungrouped, 0);
        for (const action of ['get_text', 'evaluate', 'screenshot', 'input_type', 'debugger_send', 'console_get']) {
            await assert.rejects(() => handler.execute(action, { tabId: tab.id }, context), ExpectedOperationError);
        }
    } finally {
        if (handler?.logManager.sweepTimer) globalThis.clearInterval(handler.logManager.sweepTimer);
        await unmarkManagedTab(tab.id);
        forgetPageRevision(tab.id);
        restore();
    }
});

test('C4 group membership alone never grants managed authority', async () => {
    const tab = { id: 2902, groupId: 77, windowId: 5 };
    const restore = installGlobals({ chrome: { storage: createStorage() } });
    try {
        await unmarkManagedTab(tab.id);
        assert.equal(isManagedTab(tab), false);
        await markManagedTab(tab.id);
        assert.equal(isManagedTab(tab), true);
        await unmarkManagedTab(tab.id);
        assert.equal(isManagedTab(tab), false);
    } finally {
        await unmarkManagedTab(tab.id);
        restore();
    }
});

test('C4 managed state changes persist atomically and serialize across tabs', async () => {
    const storage = createStorage();
    const write = storage.session.set;
    const gate = createDeferred();
    let fail = true;
    let blocked = false;
    const restore = installGlobals({ chrome: { storage } });
    storage.session.set = async (values) => {
        if (fail) throw new Error('storage unavailable');
        if (blocked) await gate.promise;
        await write(values);
    };
    try {
        await assert.rejects(() => markManagedTab(2903), /storage unavailable/);
        assert.equal(isManagedTab({ id: 2903 }), false);
        fail = false;
        blocked = true;
        const first = markManagedTab(2903);
        const second = markManagedTab(2904);
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
        assert.equal(isManagedTab({ id: 2903 }), false);
        gate.resolve();
        await Promise.all([first, second]);
        assert.equal(isManagedTab({ id: 2903 }), true);
        assert.equal(isManagedTab({ id: 2904 }), true);
        assert.deepEqual((await storage.session.get('mcp_managed_tab_ids')).mcp_managed_tab_ids.sort(), [2903, 2904]);
        fail = true;
        await assert.rejects(() => unmarkManagedTab(2903), /storage unavailable/);
        assert.equal(isManagedTab({ id: 2903 }), true);
    } finally {
        fail = false;
        gate.resolve();
        await unmarkManagedTab(2903);
        await unmarkManagedTab(2904);
        restore();
    }
});

test('C4 release waits for in-flight reads and detaches the debugger before revoking access', async () => {
    const tab = { id: 2905, url: 'https://example.com/managed', groupId: 77 };
    const read = createDeferred();
    let reading = false;
    let detachCalls = 0;
    let handler;
    const restore = installGlobals({
        chrome: {
            tabs: { get: async () => tab },
            storage: createStorage(),
            scripting: { executeScript: async () => [{ result: [] }] },
            debugger: {
                onDetach: chromeEvent(),
                onEvent: chromeEvent(),
                async attach() {},
                async detach() {
                    detachCalls++;
                },
            },
        },
    });
    try {
        await markManagedTab(tab.id);
        handler = new ActionHandler();
        await handler.debuggerManager.ensureAttached(tab.id);
        handler.logManager.setConsole(tab.id, [{ text: 'managed log' }]);
        handler.actions.set('get_text', async () => {
            reading = true;
            return read.promise;
        });
        const pendingRead = handler.execute('get_text', { tabId: tab.id }, {});
        await waitUntil(() => reading);
        const release = handler.execute('tabs_release', { tabId: tab.id }, {});
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
        assert.equal(detachCalls, 0);
        assert.equal(isManagedTab(tab), true);
        read.resolve({ text: 'read before release' });
        await pendingRead;
        await release;
        assert.equal(detachCalls, 1);
        assert.equal(isManagedTab(tab), false);
        assert.equal(handler.debuggerManager.isAttached(tab.id), false);
        assert.deepEqual(handler.logManager.getConsole(tab.id), []);
        await assert.rejects(() => handler.execute('evaluate', { tabId: tab.id, code: '1' }, {}), /非托管/);
    } finally {
        read.resolve({ text: '' });
        if (handler?.logManager.sweepTimer) globalThis.clearInterval(handler.logManager.sweepTimer);
        await unmarkManagedTab(tab.id);
        forgetPageRevision(tab.id);
        restore();
    }
});

test('C4 cleanup failures do not prevent revocation and repeated release does not inject into unmanaged pages', async () => {
    const tab = { id: 2906, url: 'https://example.com/managed', groupId: 77 };
    let injections = 0;
    let handler;
    const restore = installGlobals({
        chrome: {
            tabs: { get: async () => tab },
            storage: createStorage(),
            scripting: {
                async executeScript() {
                    injections++;
                    throw new Error('cleanup injection refused');
                },
            },
            debugger: {
                onDetach: chromeEvent(),
                onEvent: chromeEvent(),
                async attach() {},
                async detach() {
                    throw new Error('detach refused');
                },
            },
        },
    });
    try {
        await markManagedTab(tab.id);
        handler = new ActionHandler();
        await handler.debuggerManager.ensureAttached(tab.id);
        const released = await handler.execute('tabs_release', { tabId: tab.id }, {});
        assert.equal(released.managedAfter, false);
        assert.equal(isManagedTab(tab), false);
        assert.equal(handler.debuggerManager.isAttached(tab.id), false);
        assert.equal(released.warnings.length, 2);
        assert.match(released.warnings[0], /detach refused/);
        assert.equal(injections, 1);
        const again = await handler.execute('tabs_release', { tabId: tab.id }, {});
        assert.equal(again.managedBefore, false);
        assert.equal(again.warnings, undefined);
        assert.equal(injections, 1);
        assert.equal(tab.groupId, 77);
    } finally {
        if (handler?.logManager.sweepTimer) globalThis.clearInterval(handler.logManager.sweepTimer);
        await unmarkManagedTab(tab.id);
        forgetPageRevision(tab.id);
        restore();
    }
});

test('C4 tab IDs from an earlier browser session do not restore managed authority', async () => {
    const staleId = 1902;
    const currentId = 1903;
    const legacy = { mcp_managed_tab_ids: [staleId], mcp_created_tab_ids: [staleId] };
    const session = { mcp_managed_tab_ids: [currentId], mcp_created_tab_ids: [currentId] };
    const restore = installGlobals({
        chrome: {
            storage: {
                local: {
                    async get() {
                        return legacy;
                    },
                    async set() {
                        throw new Error('legacy storage changed');
                    },
                },
                session: {
                    async get(keys) {
                        return typeof keys === 'string'
                            ? { [keys]: session[keys] }
                            : Object.fromEntries(keys.map((key) => [key, session[key]]));
                    },
                    async set(values) {
                        Object.assign(session, values);
                    },
                },
            },
            tabs: {
                async query() {
                    return [{ id: currentId }, { id: staleId }];
                },
            },
        },
    });
    try {
        await restoreManagedTabs();
        assert.equal(isManagedTab({ id: staleId }), false);
        assert.equal(isManagedTab({ id: currentId }), true);
        await markManagedTab(staleId);
        assert.equal(isManagedTab({ id: staleId }), true);
        assert.deepEqual(session.mcp_managed_tab_ids.sort(), [staleId, currentId].sort());
        assert.deepEqual(legacy.mcp_created_tab_ids, [staleId]);
    } finally {
        await unmarkManagedTab(staleId);
        await unmarkManagedTab(currentId);
        restore();
    }
});

test('C7 frame resolution classifies selectors and returns bounded filtered identity metadata', async () => {
    const tab = { id: 1987, url: 'https://example.com/owned' };
    let selectionStatus = 'not-found';
    let identityUrl = 'https://user:password@example.com/frame?authorization=fixture-secret#fragment';
    const restore = installGlobals({
        chrome: {
            tabs: { get: async () => tab },
            storage: createStorage(),
            scripting: {
                executeScript: async ({ args, func }) => {
                    if (func.name === 'installFrameProbeListener') return [];
                    recordDomFrameProbe({ token: args[0], index: 0 }, { tab, frameId: 3 });
                    return [
                        {
                            result: {
                                parent: { title: 'owned' },
                                selectedIndex: selectionStatus === 'found' ? 0 : null,
                                selectionStatus,
                                frames: [
                                    { index: 0, acknowledged: true, url: identityUrl, contentOffset: { x: 10, y: 20 } },
                                ],
                            },
                        },
                    ];
                },
            },
            webNavigation: {
                getAllFrames: async () => [
                    { frameId: 0, parentFrameId: -1, documentId: 'parent-document', url: tab.url },
                    {
                        frameId: 3,
                        parentFrameId: 0,
                        documentId: 'document-3',
                        parentDocumentId: 'parent-document',
                        url: identityUrl,
                    },
                ],
            },
        },
    });
    try {
        await markManagedTab(tab.id);
        const resolver = new FrameResolver({});
        for (const [status, code] of [
            ['not-found', 'FRAME_NOT_FOUND'],
            ['out-of-range', 'FRAME_NOT_FOUND'],
            ['invalid-selector', 'INVALID_FRAME_SELECTOR'],
            ['not-frame', 'FRAME_NOT_IFRAME'],
        ]) {
            selectionStatus = status;
            await assert.rejects(
                () => resolver.resolveFrame({ tabId: tab.id, frame: '#owned' }, {}),
                (error) => {
                    const body = JSON.parse(error.message).error;
                    assert.equal(body.code, code);
                    assert.equal(body.context.phase, 'frame_resolution');
                    assert.equal(body.context.selectionStatus, status);
                    return true;
                }
            );
        }
        selectionStatus = 'found';
        const resolved = await resolver.resolveFrame({ tabId: tab.id, frame: '#owned' }, {});
        assert.equal(resolved.frameId, 3);
        assert.deepEqual(resolved.offset, { x: 10, y: 20 });
        assert.deepEqual(resolved.frameContext, {
            tabId: tab.id,
            extensionFrameId: 3,
            parentFrameId: 0,
            documentId: 'document-3',
            domIndex: 0,
            url: 'https://example.com/frame',
            urlStatus: 'filtered',
        });
        globalThis.chrome.debugger = {
            sendCommand: async (_, method) => {
                if (method === 'Page.getFrameTree')
                    return {
                        frameTree: {
                            frame: { id: 'root', url: tab.url },
                            childFrames: [
                                { frame: { id: 'cdp-3', url: identityUrl.split('#')[0], urlFragment: '#fragment' } },
                            ],
                        },
                    };
                assert.equal(method, 'Runtime.evaluate');
                return { result: { value: 'owned-frame' } };
            },
        };
        const precise = new FrameResolver({
            ensureAttached: async () => {},
            getExecutionContexts: () => [{ frameId: 'cdp-3', id: 3, isDefault: true }],
        });
        const evaluated = await precise.evaluateInFrame({ tabId: tab.id, frameId: 3, expression: "'owned-frame'" }, {});
        assert.equal(evaluated.frameContext.url, 'https://example.com/frame');
        assert.equal(evaluated.frameContext.originalUrl, 'https://example.com/frame');
        assert.equal(evaluated.frameContext.urlStatus, 'filtered');
        assert.equal(JSON.stringify(evaluated).includes('fixture-secret'), false);
        for (const unmatchedUrl of [
            identityUrl + '&unmatched',
            identityUrl.replace('fixture-secret', 'other-fixture'),
        ]) {
            await assert.rejects(
                () => precise.resolveCdpFrame(tab.id, { frameId: 3, parentFrameId: 0, url: unmatchedUrl }),
                (error) => {
                    const body = JSON.parse(error.message).error;
                    assert.equal(body.code, 'FRAME_CDP_UNAVAILABLE');
                    assert.equal(body.context.url, 'https://example.com/frame');
                    assert.equal(body.context.urlStatus, 'filtered');
                    return true;
                }
            );
        }
        for (const [value, expectedUrl, expectedStatus] of [
            ['data:text/html,private-fixture', 'data:', 'filtered'],
            ['javascript:privateFixture()', 'javascript:', 'filtered'],
            ['not a valid URL', null, 'unavailable'],
            [
                'https://example.com/' + 'x'.repeat(600),
                ('https://example.com/' + 'x'.repeat(600)).slice(0, 500),
                'filtered',
            ],
        ]) {
            identityUrl = value;
            const { frameContext } = await resolver.resolveFrame({ tabId: tab.id, frame: 0 }, {});
            assert.equal(frameContext.url, expectedUrl);
            assert.equal(frameContext.urlStatus, expectedStatus);
        }
    } finally {
        await unmarkManagedTab(tab.id);
        restore();
    }
});

test('C7 precise iframe selection uses the DOM owner when URLs repeat', async () => {
    const tab = { id: 1989, url: 'https://example.com/owned' };
    let missingNativeIdentity = false;
    let ambiguousProbe = false;
    const evaluations = [];
    const restore = installGlobals({
        chrome: {
            tabs: { get: async () => tab },
            storage: createStorage(),
            scripting: {
                async executeScript({ args, func }) {
                    if (func.name === 'installFrameProbeListener') return [];
                    recordDomFrameProbe({ token: args[0], index: 0 }, { tab, frameId: 8 });
                    recordDomFrameProbe({ token: args[0], index: 1 }, { tab, frameId: 3 });
                    if (ambiguousProbe) recordDomFrameProbe({ token: args[0], index: 1 }, { tab, frameId: 7 });
                    return [
                        {
                            result: {
                                parent: { title: 'owned' },
                                selectedIndex: args[1] === '#owned' ? 1 : typeof args[1] === 'number' ? args[1] : null,
                                selectionStatus: args[1] == null ? 'not-requested' : 'found',
                                frames: [0, 1].map((index) => ({
                                    index,
                                    acknowledged: true,
                                    url: 'about:srcdoc',
                                    contentOffset: { x: 10, y: 20 },
                                })),
                            },
                        },
                    ];
                },
            },
            webNavigation: {
                getAllFrames: async () => [
                    { frameId: 0, parentFrameId: -1, documentId: 'parent-document', url: tab.url },
                    {
                        frameId: 3,
                        parentFrameId: 0,
                        documentId: 'selected-document',
                        parentDocumentId: 'parent-document',
                        url: 'about:srcdoc',
                    },
                    {
                        frameId: 8,
                        parentFrameId: 0,
                        documentId: 'other-document',
                        parentDocumentId: 'parent-document',
                        url: 'about:srcdoc',
                    },
                ],
            },
            debugger: {
                async sendCommand(_, method, params) {
                    if (method === 'Page.getFrameTree')
                        return {
                            frameTree: {
                                frame: { id: 'root', url: tab.url },
                                childFrames: ['cdp-8', 'cdp-3'].map((id) => ({ frame: { id, url: 'about:srcdoc' } })),
                            },
                        };
                    if (method === 'DOM.getDocument') return { root: { nodeId: 100 } };
                    if (method === 'DOM.querySelectorAll') {
                        assert.deepEqual(params, { nodeId: 100, selector: 'iframe, frame' });
                        return { nodeIds: [101, 102] };
                    }
                    if (method === 'DOM.describeNode')
                        return {
                            node: {
                                frameId: missingNativeIdentity ? undefined : params.nodeId === 102 ? 'cdp-3' : 'cdp-8',
                            },
                        };
                    assert.equal(method, 'Runtime.evaluate');
                    evaluations.push(params.contextId);
                    return { result: { value: params.contextId === 3 ? 'Frame Button' : 'Other Frame' } };
                },
            },
        },
    });
    try {
        await markManagedTab(tab.id);
        const resolver = new FrameResolver({
            ensureAttached: async () => {},
            getExecutionContexts: () => [
                { frameId: 'cdp-3', id: 3, isDefault: true },
                { frameId: 'cdp-8', id: 8, isDefault: true },
            ],
        });
        for (const selection of ['#owned', 1, 0]) {
            const selected = await resolver.resolveFrame({ tabId: tab.id, frame: selection }, {});
            const result = await resolver.evaluateInFrame(
                { tabId: tab.id, frameId: selected.frameId, expression: 'document.body.textContent' },
                {}
            );
            assert.equal(result.result.value, selection === 0 ? 'Other Frame' : 'Frame Button');
            assert.equal(result.frameContext.cdpFrameId, selection === 0 ? 'cdp-8' : 'cdp-3');
            assert.equal(result.retryAttempted, false);
        }
        assert.deepEqual(evaluations, [3, 3, 8]);
        missingNativeIdentity = true;
        await assert.rejects(
            () => resolver.evaluateInFrame({ tabId: tab.id, frameId: 3, expression: '++window.sideEffect' }, {}),
            (error) => JSON.parse(error.message).error.code === 'FRAME_AMBIGUOUS'
        );
        ambiguousProbe = true;
        await assert.rejects(
            () => resolver.resolveFrame({ tabId: tab.id, frame: '#owned' }, {}),
            (error) => JSON.parse(error.message).error.code === 'FRAME_IDENTITY_UNAVAILABLE'
        );
        assert.deepEqual(evaluations, [3, 3, 8]);
    } finally {
        await unmarkManagedTab(tab.id);
        restore();
    }
});

test('C7 retained iframe probes initialize document-bound listeners without duplication or cross-document injection', async () => {
    const tab = { id: 1990, url: 'https://example.com/owned' };
    const frames = [
        { frameId: 0, parentFrameId: -1, documentId: 'parent-document', url: tab.url },
        {
            frameId: 3,
            parentFrameId: 0,
            documentId: 'child-document',
            parentDocumentId: 'parent-document',
            url: 'about:srcdoc',
        },
        { frameId: 4, parentFrameId: 0, documentId: 'foreign-child', parentDocumentId: 'foreign-parent', url: tab.url },
        { frameId: 5, parentFrameId: 3, documentId: 'nested-child', parentDocumentId: 'child-document', url: tab.url },
        {
            frameId: 6,
            parentFrameId: 0,
            documentId: 'extension-child',
            parentDocumentId: 'parent-document',
            url: 'chrome-extension://other/frame.html',
        },
    ];
    let initialized = false;
    let installer;
    let initializationFailure = false;
    let initializationCalls = 0;
    let parentCalls = 0;
    let lastToken;
    const restore = installGlobals({
        chrome: {
            webNavigation: { getAllFrames: async () => frames },
            scripting: {
                async executeScript({ target, func, args }) {
                    if (func.name === 'installFrameProbeListener') {
                        ++initializationCalls;
                        assert.deepEqual(target, { tabId: tab.id, documentIds: ['child-document'] });
                        if (initializationFailure) throw new Error('initialization denied fixture');
                        installer = func;
                        initialized = true;
                        return [{ frameId: 3, documentId: 'child-document' }];
                    }
                    ++parentCalls;
                    lastToken = args[0];
                    if (initialized) recordDomFrameProbe({ token: lastToken, index: 0 }, { tab, frameId: 3 });
                    return [
                        {
                            result: {
                                parent: { title: 'owned' },
                                selectedIndex: 0,
                                selectionStatus: 'found',
                                frames: [
                                    {
                                        index: 0,
                                        acknowledged: initialized,
                                        url: 'about:srcdoc',
                                        contentOffset: { x: 10, y: 20 },
                                    },
                                ],
                            },
                        },
                    ];
                },
            },
        },
    });
    try {
        for (let attempt = 0; attempt < 2; ++attempt) {
            const result = await getDomFrameSnapshot(tab.id, 0, '#owned', 'parent-document', tab.url);
            assert.equal(result.frames[0].frameId, 3);
            assert.deepEqual(result.frames[0].candidateFrameIds, [3]);
        }
        assert.equal(initializationCalls, 2);
        assert.equal(recordDomFrameProbe({ token: lastToken, index: 0 }, { tab, frameId: 3 }).accepted, false);

        const acknowledgements = [];
        const messages = [];
        const warnings = [];
        let listener;
        let listenerCount = 0;
        let accepted = true;
        let messageFailure = false;
        const parent = { postMessage: (message) => acknowledgements.push(message) };
        const window = {
            parent,
            addEventListener: (type, callback) => {
                assert.equal(type, 'message');
                ++listenerCount;
                listener = callback;
            },
        };
        const sandbox = vm.createContext({
            window,
            console: { warn: (...args) => warnings.push(args) },
            chrome: {
                runtime: {
                    sendMessage: async (message) => {
                        messages.push(message);
                        if (messageFailure) throw new Error('message rejected fixture');
                        return { accepted };
                    },
                },
            },
        });
        for (let attempt = 0; attempt < 2; ++attempt) vm.runInContext(`(${installer.toString()})()`, sandbox);
        assert.equal(listenerCount, 1);
        const data = { type: 'mcp-frame-probe', token: 'fixture-nonce', index: 0 };
        for (const event of [
            { source: {}, data },
            { source: parent, data: null },
            ...[{ type: 'other' }, { token: 42 }, { token: 'x'.repeat(101) }, { index: -1 }, { index: 0.5 }].map(
                (changes) => ({ source: parent, data: { ...data, ...changes } })
            ),
        ])
            listener(event);
        assert.equal(messages.length, 0);
        listener({ source: parent, data });
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
        assert.equal(messages.length, 1);
        assert.equal(messages[0].type, 'MCP_FRAME_PROBE');
        assert.equal(acknowledgements.length, 1);
        assert.equal(acknowledgements[0].token, data.token);
        assert.equal(acknowledgements[0].index, data.index);
        accepted = false;
        listener({ source: parent, data });
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
        assert.equal(acknowledgements.length, 1);
        messageFailure = true;
        listener({ source: parent, data });
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0][1], /message rejected fixture/);
        assert.equal(acknowledgements.length, 1);

        frames[0].documentId = 'changed-parent';
        await assert.rejects(() => getDomFrameSnapshot(tab.id, 0, '#owned', 'parent-document', tab.url), /页面已变化/);
        assert.equal(initializationCalls, 2);
        assert.equal(parentCalls, 2);
        frames[0].documentId = 'parent-document';
        frames[1].documentId = undefined;
        await assert.rejects(() => getDomFrameSnapshot(tab.id, 0, '#owned'), /documentId/);
        assert.equal(initializationCalls, 2);
        assert.equal(parentCalls, 2);
        frames[1].documentId = 'child-document';
        initializationFailure = true;
        await assert.rejects(() => getDomFrameSnapshot(tab.id, 0, '#owned'), /initialization denied fixture/);
        assert.equal(initializationCalls, 3);
        assert.equal(parentCalls, 2);
    } finally {
        restore();
    }
});

test('C7 readable injections distinguish absent results, selectors, context loss and denied injection without replay', async () => {
    const tab = { id: 1988, url: 'https://example.com/owned' };
    let result = [];
    let thrown;
    let executions = 0;
    const restore = installGlobals({
        chrome: {
            tabs: { get: async () => tab },
            storage: createStorage(),
            scripting: {
                executeScript: async () => {
                    executions++;
                    if (thrown) throw thrown;
                    return result;
                },
            },
        },
    });
    try {
        await markManagedTab(tab.id);
        const handler = new ContentHandler({
            ensureAttached: () => assert.fail('ordinary reads must not attach debugger'),
        });
        for (const method of [
            'readPage',
            'find',
            'getText',
            'getHtml',
            'getHtmlWithImages',
            'getAttribute',
            'getMetadata',
        ]) {
            for (const empty of [[], [{ result: null }], [{ result: undefined }]]) {
                result = empty;
                const before = executions;
                await assert.rejects(
                    () => handler[method]({ tabId: tab.id, frameId: 3, attribute: 'href' }, {}),
                    (error) => {
                        const body = JSON.parse(error.message).error;
                        assert.equal(body.code, 'FRAME_SCRIPT_NO_RESULT');
                        assert.deepEqual(body.context, {
                            tabId: tab.id,
                            frameId: 3,
                            phase: 'script_result',
                            resultCount: empty.length,
                        });
                        return true;
                    }
                );
                assert.equal(executions, before + 1);
            }
        }
        for (const [message, code] of [
            ['Invalid CSS selector: fixture', 'INVALID_SELECTOR'],
            ['Cannot find context with specified id', 'FRAME_STALE_CONTEXT'],
            ['Frame 3 not found', 'FRAME_NOT_FOUND'],
            ['Cannot access a chrome:// URL', 'FRAME_INJECTION_DENIED'],
            ['unexpected fixture error', 'FRAME_INJECTION_FAILED'],
        ]) {
            thrown = new Error(message);
            const before = executions;
            await assert.rejects(
                () => handler.getText({ tabId: tab.id, frameId: 3 }, {}),
                (error) => {
                    const body = JSON.parse(error.message).error;
                    assert.equal(body.code, code);
                    assert.equal(body.message, message);
                    assert.equal(body.context.phase, 'injection');
                    assert.equal(body.context.frameId, 3);
                    if (code === 'FRAME_INJECTION_FAILED') assert.equal(error.cause, thrown);
                    return true;
                }
            );
            assert.equal(executions, before + 1);
        }
        thrown = undefined;
        result = [{ result: { error: 'Invalid XPath: fixture' } }];
        await assert.rejects(
            () => handler.find({ tabId: tab.id, frameId: 3 }, {}),
            (error) => JSON.parse(error.message).error.code === 'INVALID_SELECTOR'
        );
        result = [{ result: [] }];
        assert.deepEqual(await handler.find({ tabId: tab.id, frameId: 3 }, {}), []);
        result = [{ result: { text: '' } }];
        assert.deepEqual(await handler.getText({ tabId: tab.id, frameId: 3 }, {}), { text: '' });
        result = [{ result: null }];
        assert.equal(await handler.getComputedStyleAction({ tabId: tab.id, refId: 'ref_1', prop: 'color' }, {}), null);
        result = [{ result: undefined }];
        assert.equal(await handler.injectScript(tab.id, 3, () => undefined, []), undefined);
    } finally {
        await unmarkManagedTab(tab.id);
        restore();
    }
});

test('C4 created-page injection arguments survive Chrome JSON serialization', async (t) => {
    const tab = { id: 1904, url: 'https://example.com/created' };
    let result;
    let argumentsSeen;
    const restore = installGlobals({
        chrome: {
            tabs: { get: async () => tab },
            storage: createStorage(),
            scripting: {
                async executeScript({ args }) {
                    assert.deepEqual(JSON.parse(JSON.stringify(args)), args, 'Chrome rejects unserializable args');
                    argumentsSeen = args;
                    return [{ result }];
                },
            },
        },
    });
    try {
        await markManagedTab(tab.id);
        const content = new ContentHandler({});
        for (const [method, params, expectedArgs, expectedResult] of [
            ['readPage', {}, ['all', 15, null, null, null], { pageContent: 'fixture' }],
            ['find', {}, [null, null, null, null, null], []],
            ['find', { matchIndex: 0 }, [null, null, null, null, null, 0], []],
            ['getText', {}, [null, null, null], { text: 'fixture' }],
            ['getHtml', {}, [null, true, null, null], { html: '<main>fixture</main>' }],
            ['getHtmlWithImages', {}, [null, true, null, null], { html: '', images: [] }],
            ['getAttribute', { attribute: 'href' }, [null, null, 'href', null], { value: null }],
            ['getMetadata', {}, [null], { title: 'fixture' }],
            ['getComputedStyleAction', { refId: 'ref_1', prop: 'color' }, ['ref_1', 'color', null], 'red'],
            ['evaluate', { code: '1+1' }, ['1+1'], { success: true, result: '2' }],
            ['evaluate', { code: '1+1', timeout: 0 }, ['1+1', 0], { success: true, result: '2' }],
        ]) {
            await t.test(`${method} ${JSON.stringify(params)}`, async () => {
                result = expectedResult;
                assert.deepEqual(await content[method]({ tabId: tab.id, ...params }, {}), expectedResult);
                assert.deepEqual(argumentsSeen, expectedArgs);
            });
        }
        await t.test('frame snapshots omit absent trailing URL', async () => {
            globalThis.chrome.webNavigation = {
                getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'document-a', url: tab.url }],
            };
            result = {
                parent: { title: 'fixture' },
                frames: [],
                selectedIndex: null,
                selectionStatus: 'not-requested',
            };
            for (const selection of [undefined, 0, '#test-frame']) {
                assert.deepEqual(await getDomFrameSnapshot(tab.id, 0, selection), result);
                assert.deepEqual(argumentsSeen.slice(1), [selection ?? null, 500]);
            }
            assert.deepEqual(await getDomFrameSnapshot(tab.id, 0, 0, 'document-a', tab.url), result);
            assert.deepEqual(argumentsSeen.slice(1), [0, 500, tab.url]);
        });
    } finally {
        await unmarkManagedTab(tab.id);
        restore();
    }
});

test('C20 accessibility state omits password values without reading them and retains names', () => {
    for (const scenario of ['password', 'aria-label', 'placeholder', 'title', 'label', 'normal-input']) {
        const value = 'mcp-owned-password-sentinel';
        let valueReads = 0;
        const input = {
            tagName: 'INPUT',
            id: 'owned-password',
            type: scenario === 'normal-input' ? 'text' : 'password',
            offsetWidth: 120,
            offsetHeight: 20,
            childNodes: [],
            children: [],
            getAttribute(name) {
                if (name === 'type') return this.type;
                return name === scenario ? 'Owned input name' : null;
            },
            get value() {
                ++valueReads;
                if (scenario !== 'normal-input') throw new Error('password value must not be read');
                return value;
            },
            getBoundingClientRect: () => ({
                x: 10,
                y: 10,
                top: 10,
                left: 10,
                right: 130,
                bottom: 30,
                width: 120,
                height: 20,
            }),
            contains: () => false,
        };
        const restore = installGlobals({
            document: {
                body: input,
                querySelector: () => (scenario === 'label' ? { textContent: 'Owned input name' } : null),
                elementFromPoint: () => null,
            },
            window: {
                innerWidth: 800,
                innerHeight: 600,
                getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
            },
            CSS: { escape: (text) => text },
            Node: { TEXT_NODE: 3 },
        });
        try {
            for (const filter of ['all', 'interactive']) {
                const state = generateAccessibilityTree(filter, 15, null, null);
                assert.equal(state.interactiveElements.length, 1, scenario);
                const expectedName =
                    scenario === 'normal-input' ? value : scenario === 'password' ? '' : 'Owned input name';
                assert.equal(state.interactiveElements[0].name, expectedName, scenario);
                assert.equal(state.pageContent.includes(value), scenario === 'normal-input', scenario);
                const targeted = generateAccessibilityTree(filter, 15, null, state.interactiveElements[0].refId);
                assert.equal(targeted.interactiveElements[0].name, expectedName, scenario);
                assert.equal(JSON.stringify(targeted).includes(value), scenario === 'normal-input', scenario);
            }
            assert.equal(valueReads > 0, scenario === 'normal-input', scenario);
        } finally {
            restore();
        }
    }
});

test('C4 injected read functions distinguish absent URL from a mismatched URL', () => {
    const pageAccess = new Error('page access reached');
    const page = new Proxy(
        {},
        {
            get() {
                throw pageAccess;
            },
        }
    );
    const restore = installGlobals({
        location: { href: 'https://example.com/current' },
        document: page,
        window: page,
    });
    try {
        for (const [func, args] of [
            [generateAccessibilityTree, ['all', 15, null, null]],
            [extractText, [null]],
            [extractHtml, [null, true]],
            [extractHtmlWithImages, [null, true]],
            [extractMetadata, []],
            [extractAttribute, ['#fixture', null, 'href']],
            [findElements, [null, null, null]],
            [getComputedStyleFromElement, ['ref_1', 'color']],
        ]) {
            assert.throws(() => func(...args, 'https://example.com/other'), /页面 URL 已变化/, func.name);
            for (const url of [undefined, null, 'https://example.com/current']) {
                assert.throws(
                    () => func(...args, url),
                    (error) => error === pageAccess,
                    func.name
                );
            }
        }
    } finally {
        restore();
    }
});

test('C-P2 selector and ref reads use HTML rendered text and preserve explicit hidden and SVG text', () => {
    class HtmlElement {
        constructor(innerText, textContent) {
            this.innerText = innerText;
            this.textContent = textContent;
            this.isConnected = true;
        }
    }
    const elements = {
        body: new HtmlElement('Rendered 中文😀\nSVG', 'CSS source; script source; hidden text'),
        '#empty': new HtmlElement('', 'must-not-return-source'),
        '#hidden': new HtmlElement('Selected hidden text', 'Selected hidden text'),
        '#svg': { textContent: 'SVG', isConnected: true },
        '#detached': { textContent: 'must-not-return-detached', isConnected: false },
    };
    const refs = Object.fromEntries(
        Object.entries(elements).map(([selector, element]) => [selector, new WeakRef(element)])
    );
    const restore = installGlobals({
        HTMLElement: HtmlElement,
        window: { __mcpElementMap: refs },
        location: { href: 'https://example.com/owned' },
        document: {
            body: elements.body,
            querySelector: (selector) => {
                if (selector === '[') throw Object.assign(new Error('Invalid selector'), { name: 'SyntaxError' });
                return elements[selector];
            },
        },
    });
    try {
        assert.equal(extractText(null).text, elements.body.innerText);
        for (const [selector, element] of Object.entries(elements)) {
            const expected = element instanceof HtmlElement ? element.innerText : element.textContent;
            assert.equal(extractText(selector).text, expected);
            assert.equal(extractText(null, undefined, selector).text, element.isConnected ? expected : '');
        }
        assert.equal(extractText('#missing').text, '');
        assert.equal(extractText(null, undefined, 'missing').text, '');
        assert.match(extractText('[').error, /Invalid CSS selector/);
        assert.throws(() => extractText('body', 'https://example.com/other'), /页面 URL 已变化/);
    } finally {
        restore();
    }
});

test('C4 granted reads check the URL inside the selected document', () => {
    const restore = installGlobals({ location: { href: 'https://example.com/after-navigation' } });
    try {
        assert.throws(() => extractText(null, 'https://example.com/approved'), /页面 URL 已变化/);
    } finally {
        restore();
    }
});

test('C4 indexed element reads can locate matches beyond the default find limit', () => {
    class ElementNode {
        constructor(index) {
            this.textContent = `item ${index}`;
            this.tagName = 'DIV';
        }

        getBoundingClientRect() {
            return { x: 0, y: 0, width: 1, height: 1 };
        }
    }
    const elements = Array.from({ length: 240 }, (_, index) => new ElementNode(index));
    const pageWindow = {};
    const pageUrl = 'https://example.com/a';
    const restore = installGlobals({
        window: pageWindow,
        document: {
            body: {},
            querySelectorAll: () => elements,
            createTreeWalker() {
                let index = 0;
                return {
                    nextNode: () =>
                        index < elements.length
                            ? { data: elements[index].textContent, parentElement: elements[index++] }
                            : null,
                };
            },
        },
        NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
        location: { href: pageUrl },
        Element: ElementNode,
    });
    try {
        assert.equal(findElements('.item', 'item', null, pageUrl).length, 50);
        const selected = findElements('.item', 'item', null, pageUrl, null, 68);
        assert.equal(selected.length, 1);
        assert.equal(pageWindow.__mcpElementMap[selected[0].refId].deref(), elements[68]);
        assert.deepEqual(findElements('.item', 'item', null, pageUrl, null, 300), []);
        const textMatch = findElements(null, 'item', null, pageUrl, null, 210);
        assert.equal(textMatch.length, 1);
        assert.equal(pageWindow.__mcpElementMap[textMatch[0].refId].deref(), elements[210]);
        assert.throws(() => findElements('.item', null, null, 'https://example.com/b', null, 68), /页面 URL 已变化/);
    } finally {
        restore();
    }
});

test('C-R8 read grants revoke closed documents without querying or activating pages', async () => {
    const tabId = 8901;
    const storage = createStorage();
    const calls = [];
    let closed = false;
    const restore = installGlobals({
        chrome: {
            storage,
            tabs: {
                async get(id) {
                    calls.push({ action: 'get', id });
                    if (closed) throw new Error('document closed');
                    return { id, url: 'https://example.com/read-only', active: false, groupId: -1 };
                },
            },
            webNavigation: {
                async getFrame(params) {
                    calls.push({ action: 'getFrame', params });
                    return { documentId: 'read-document' };
                },
            },
        },
    });
    try {
        await setReadGrant('read-revoke-server', tabId, true);
        assert.equal(await hasReadGrant('read-revoke-server', tabId), true);
        assert.equal(isManagedTab({ id: tabId, groupId: -1 }), false);
        const reads = calls.length;
        closed = true;
        await setReadGrant('read-revoke-server', tabId, false);
        await setReadGrant('read-revoke-server', tabId, false);
        assert.equal(calls.length, reads);
        const persisted = await storage.session.get(null);
        assert.deepEqual(Object.values(persisted), [[]]);
        closed = false;
        assert.equal(await hasReadGrant('read-revoke-server', tabId), false);
    } finally {
        forgetPageRevision(tabId);
        restore();
    }
});

test('C-R8 read grants never persist an unconfirmed document identity', async () => {
    const tabId = 8902;
    const storage = createStorage();
    const restore = installGlobals({
        chrome: {
            storage,
            tabs: { get: async () => ({ id: tabId, url: 'https://example.com/unconfirmed' }) },
            webNavigation: { getFrame: async () => null },
        },
    });
    try {
        await assert.rejects(() => setReadGrant('unconfirmed-read-server', tabId, true), /未授予只读权限/);
        assert.deepEqual(await storage.session.get(null), {});
        assert.equal(isManagedTab({ id: tabId }), false);
    } finally {
        forgetPageRevision(tabId);
        restore();
    }
});

test('C-R8 native creation rejections are not retried and do not delete unrelated assets', async (t) => {
    for (const operation of ['tabsCreate', 'windowCreate']) {
        await t.test(operation, async () => {
            const fixture = createTabManagementFixture();
            const failure = new Error('native creation refused');
            const native = operation === 'tabsCreate' ? fixture.chrome.tabs : fixture.chrome.windows;
            native.create = async (properties) => {
                fixture.calls.push({ method: 'native.create', properties });
                throw failure;
            };
            const restore = installGlobals({ chrome: fixture.chrome });
            try {
                const handler = new TabHandler({});
                await assert.rejects(
                    () => handler[operation](operation === 'tabsCreate' ? { windowId: 10 } : { focused: false }, {}),
                    (error) => {
                        const body = JSON.parse(error.message).error;
                        assert.match(body.message, /native creation refused/);
                        assert.equal(body.context.actionStatus, 'unknown');
                        assert.equal(body.context.failureStage, 'create');
                        return true;
                    }
                );
                assert.equal(fixture.calls.length, 1);
                assert.equal(fixture.calls[0].method, 'native.create');
                assert.equal(fixture.tabs.size, 3);
            } finally {
                restore();
            }
        });
    }
});

test('C02 Extension evaluate waits for Promise results before serialization', async () => {
    class DomNode {}
    const restore = installGlobals({
        Node: DomNode,
        Element: class extends DomNode {},
        NodeList: class {},
        HTMLCollection: class {},
    });
    try {
        assert.equal(EvaluateSchema.parse({ code: 'true', timeout: 10 }).timeout, 10);
        assert.deepEqual(await executeCode('Promise.resolve(false)'), { success: true, result: 'false' });
        assert.deepEqual(await executeCode('(async () => ({ ready: true }))()'), {
            success: true,
            result: '{"ready":true}',
        });
        assert.deepEqual(await executeCode('Promise.reject(new Error("predicate failed"))'), {
            success: false,
            error: 'predicate failed',
        });
        assert.deepEqual(await executeCode('new Promise(() => {})', 10), {
            success: false,
            error: 'Evaluation timeout after 10ms',
        });
    } finally {
        restore();
    }
});

test('C23 closed-port scans and reconnects stay debug while identified failures warn once', async () => {
    const output = [];
    const restore = installGlobals({
        console: {
            ...globalThis.console,
            debug: (text) => output.push({ level: 'debug', text }),
            log: (text) => output.push({ level: 'log', text }),
            warn: (text) => output.push({ level: 'warn', text }),
        },
        setTimeout: () => 123,
    });
    try {
        const client = new HttpClient();
        client.shouldReconnect = true;
        client.checkPort = async () => ({ healthy: false });
        await client.discoverServers(client.generation);
        await client.discoverServers(client.generation);
        client.scheduleReconnect();
        assert.equal(output.length, 3);
        assert.ok(output.every((row) => row.level === 'debug'));
        client.checkPort = async (port) =>
            port === 19222
                ? { healthy: false, failureKind: 'authentication', reason: 'server proof mismatch' }
                : { healthy: false };
        await client.discoverServers(client.generation);
        await client.discoverServers(client.generation);
        assert.equal(output.filter((row) => row.level === 'warn').length, 1);
        assert.match(
            output.find((row) => row.level === 'warn').text,
            /19222 \(authentication: server proof mismatch\)/
        );
        client.checkPort = async (port) =>
            port === 19222
                ? { healthy: false, failureKind: 'protocol', reason: 'authentication challenge incomplete' }
                : { healthy: false };
        await client.discoverServers(client.generation);
        await client.discoverServers(client.generation);
        assert.equal(output.filter((row) => row.level === 'warn').length, 2);
        assert.match(
            output.filter((row) => row.level === 'warn')[1].text,
            /19222 \(protocol: authentication challenge incomplete\)/
        );
    } finally {
        restore();
    }
});

test('C05 policy changes invalidate pending health checks', async () => {
    const storage = createStorage({ mcp_allow_insecure_no_token_v2: true });
    const restore = installGlobals({
        chrome: { storage, runtime: { getURL: (path) => path, getManifest: () => ({ version: 'test' }) } },
        WebSocket: FakeWebSocket,
        fetch: (_url, { signal }) =>
            new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new globalThis.DOMException('aborted', 'AbortError')), {
                    once: true,
                });
            }),
    });
    try {
        const client = new HttpClient();
        const connecting = client.connect();
        await waitUntil(() => client.pendingHealthChecks.size === 78);
        await client.setAllowInsecureNoToken(false);
        assert.equal(client.pendingHealthChecks.size, 0);
        assert.deepEqual(await connecting, { connected: 0, ports: [] });
        assert.equal(client.isConnected(), false);
    } finally {
        restore();
    }
});

test('C05 policy changes close and invalidate pending WebSocket handshakes', async () => {
    FakeWebSocket.instances = [];
    const storage = createStorage({ mcp_allow_insecure_no_token_v2: true });
    const restore = installGlobals({
        chrome: { storage, runtime: { getURL: (path) => path, getManifest: () => ({ version: 'test' }) } },
        WebSocket: FakeWebSocket,
        fetch: async (url) => ({
            ok: String(url).includes(':19222/'),
            async json() {
                return { status: 'ok', authRequired: false };
            },
        }),
    });
    try {
        const client = new HttpClient();
        const connecting = client.connect();
        await waitUntil(() => FakeWebSocket.instances.length === 1);
        const socket = FakeWebSocket.instances[0];
        await client.setAllowInsecureNoToken(false);
        assert.equal(socket.readyState, FakeWebSocket.CLOSED);
        socket.open();
        assert.deepEqual(await connecting, { connected: 0, ports: [] });
        assert.equal(client.isConnected(), false);
    } finally {
        restore();
    }
});

test('C05 policy changes cancel scheduled reconnects', async () => {
    FakeWebSocket.instances = [];
    const storage = createStorage({ mcp_allow_insecure_no_token_v2: true });
    const restore = installGlobals({
        chrome: { storage, runtime: { getURL: (path) => path, getManifest: () => ({ version: 'test' }) } },
        WebSocket: FakeWebSocket,
        fetch: async () => ({ ok: false, async json() {} }),
    });
    try {
        const client = new HttpClient();
        await client.connect();
        assert.notEqual(client.reconnectTimer, null);
        await client.setAllowInsecureNoToken(false);
        assert.equal(client.reconnectTimer, null);
    } finally {
        restore();
    }
});

test('C05 policy changes invalidate sockets before storage persistence settles', async () => {
    FakeWebSocket.instances = [];
    const storageWrite = createDeferred();
    const storage = createStorage({ mcp_allow_insecure_no_token_v2: true });
    storage.local.set = () => storageWrite.promise;
    const restore = installGlobals({
        chrome: { storage, runtime: { getURL: (path) => path, getManifest: () => ({ version: 'test' }) } },
        WebSocket: FakeWebSocket,
        fetch: async (url) => ({
            ok: String(url).includes(':19222/'),
            async json() {
                return { status: 'ok', authRequired: false };
            },
        }),
    });
    try {
        const client = new HttpClient();
        const connecting = client.connect();
        await waitUntil(() => FakeWebSocket.instances.length === 1);
        const socket = FakeWebSocket.instances[0];
        const update = client.setAllowInsecureNoToken(false);
        const updateFailure = assert.rejects(update, /storage write failed/);
        assert.equal(socket.readyState, FakeWebSocket.CLOSED);
        socket.open();
        assert.equal(client.isConnected(), false);
        storageWrite.reject(new Error('storage write failed'));
        await updateFailure;
        assert.deepEqual(await connecting, { connected: 0, ports: [] });
    } finally {
        restore();
    }
});

test('C05 stale socket close cannot remove a replacement connection on the same port', () => {
    FakeWebSocket.instances = [];
    const client = new HttpClient();
    const oldSocket = new FakeWebSocket('ws://127.0.0.1:19222/old');
    const replacement = new FakeWebSocket('ws://127.0.0.1:19222/new');
    client.connections.set(19222, { ws: replacement, heartbeatTimer: null });
    oldSocket.onclose = () => client.removeConnection(19222, oldSocket);
    oldSocket.onclose();
    assert.equal(client.connections.get(19222).ws, replacement);
    client.disconnect();
});

test('C06 rebuilt managed windows do not reuse stale group snapshots', async () => {
    setMcpWindowId(null);
    setMcpTabGroupId(null);
    const tabs = new Map([
        [1, { id: 1, url: 'https://user.example', title: 'user', active: true, windowId: 100, index: 0, groupId: 99 }],
    ]);
    const groupCalls = [];
    const storage = createStorage();
    const restore = installGlobals({
        chrome: {
            storage,
            windows: {
                async get(windowId) {
                    return { id: windowId };
                },
                async create() {
                    const initial = {
                        id: 2000,
                        url: 'about:blank',
                        title: '',
                        active: true,
                        windowId: 200,
                        index: 0,
                        groupId: -1,
                    };
                    tabs.set(initial.id, initial);
                    return { id: 200, tabs: [initial] };
                },
            },
            tabs: {
                async query({ windowId }) {
                    return [...tabs.values()].filter((tab) => tab.windowId === windowId);
                },
                async create(props) {
                    const tab = {
                        id: 2001,
                        url: props.url,
                        title: '',
                        active: props.active,
                        windowId: props.windowId,
                        index: 1,
                        groupId: -1,
                        pinned: false,
                        incognito: false,
                        status: 'complete',
                    };
                    tabs.set(tab.id, tab);
                    return tab;
                },
                async remove(tabId) {
                    tabs.delete(tabId);
                },
                async group(options) {
                    groupCalls.push({ ...options });
                    const tab = tabs.get(options.tabIds[0]);
                    if (options.groupId !== undefined) {
                        tab.groupId = options.groupId;
                        tab.windowId = 100;
                        return options.groupId;
                    }
                    tab.groupId = 20;
                    return 20;
                },
                async get(tabId) {
                    return { ...tabs.get(tabId) };
                },
            },
            tabGroups: { async update() {} },
        },
    });
    try {
        const handler = new TabHandler({ waitForNavigation: async () => {} });
        const result = await handler.tabsCreate(
            { url: 'https://test.example', active: false },
            { mcpWindowId: 100, mcpTabGroupId: 10 }
        );
        assert.equal(groupCalls[0].groupId, undefined);
        assert.equal(result.windowId, 200);
        assert.equal(result.groupId, 20);
        assert.equal(result.index, 1);
    } finally {
        restore();
        setMcpWindowId(null);
        setMcpTabGroupId(null);
    }
});

function createTabManagementFixture() {
    const defaults = {
        title: 'Fixture',
        active: false,
        pinned: false,
        highlighted: false,
        autoDiscardable: true,
        mutedInfo: { muted: false },
        incognito: false,
        status: 'complete',
        groupId: -1,
    };
    const tabs = new Map([
        [5001, { ...defaults, id: 5001, windowId: 10, index: 0, url: 'https://example.com/one' }],
        [5002, { ...defaults, id: 5002, windowId: 10, index: 1, url: 'https://example.com/two' }],
        [5003, { ...defaults, id: 5003, windowId: 20, index: 0, groupId: 77, url: 'https://example.com/three' }],
    ]);
    const windows = new Map(
        [10, 20].map((id) => [id, { id, type: 'normal', focused: false, state: 'normal', incognito: false }])
    );
    const groups = new Map([
        [77, { id: 77, windowId: 20, title: 'Original', color: 'blue', collapsed: false, shared: false }],
    ]);
    const calls = [];
    let nextTab = 6000;
    let nextWindow = 30;
    let nextGroup = 80;
    let failClose = false;
    const getTab = (id) => {
        if (!tabs.has(id)) throw new Error(`No tab ${id}`);
        return globalThis.structuredClone(tabs.get(id));
    };
    const getWindow = (id) => {
        if (!windows.has(id)) throw new Error(`No window ${id}`);
        return {
            ...windows.get(id),
            tabs: [...tabs.values()].filter((tab) => tab.windowId === id).map((tab) => getTab(tab.id)),
        };
    };
    const removeEmptyGroups = () => {
        for (const id of groups.keys()) {
            if (![...tabs.values()].some((tab) => tab.groupId === id)) groups.delete(id);
        }
    };
    const chrome = {
        storage: createStorage(),
        debugger: { onDetach: chromeEvent(), onEvent: chromeEvent() },
        scripting: { executeScript: async () => [{ result: [] }] },
        tabs: {
            get: async (id) => getTab(id),
            query: async (query) =>
                [...tabs.values()]
                    .filter((tab) => Object.entries(query).every(([key, value]) => tab[key] === value))
                    .map((tab) => getTab(tab.id)),
            async create(properties) {
                calls.push({ method: 'tabs.create', properties });
                const id = nextTab++;
                tabs.set(id, {
                    ...defaults,
                    id,
                    index: properties.index ?? tabs.size,
                    windowId: properties.windowId ?? 10,
                    ...properties,
                });
                return getTab(id);
            },
            async update(id, properties) {
                calls.push({ method: 'tabs.update', id, properties });
                const tab = tabs.get(id);
                for (const [key, value] of Object.entries(properties)) {
                    if (value !== undefined) {
                        if (key === 'muted') tab.mutedInfo = { muted: value };
                        else if (key !== 'active' || value !== false) tab[key] = value;
                    }
                }
                return getTab(id);
            },
            async move(id, properties) {
                calls.push({ method: 'tabs.move', id, properties });
                Object.assign(tabs.get(id), properties);
                return getTab(id);
            },
            async remove(id) {
                calls.push({ method: 'tabs.remove', id });
                tabs.delete(id);
                removeEmptyGroups();
            },
            async group(properties) {
                calls.push({ method: 'tabs.group', properties });
                const ids = Array.isArray(properties.tabIds) ? properties.tabIds : [properties.tabIds];
                const id = properties.groupId ?? nextGroup++;
                if (!groups.has(id))
                    groups.set(id, {
                        id,
                        windowId: properties.createProperties?.windowId ?? 10,
                        title: '',
                        color: 'grey',
                        collapsed: false,
                        shared: false,
                    });
                for (const tabId of ids)
                    Object.assign(tabs.get(tabId), { groupId: id, windowId: groups.get(id).windowId, pinned: false });
                removeEmptyGroups();
                return id;
            },
            async ungroup(ids) {
                calls.push({ method: 'tabs.ungroup', ids });
                for (const id of Array.isArray(ids) ? ids : [ids]) tabs.get(id).groupId = -1;
                removeEmptyGroups();
            },
        },
        tabGroups: {
            get: async (id) => {
                if (!groups.has(id)) throw new Error(`No group ${id}`);
                return { ...groups.get(id) };
            },
            query: async (query) =>
                [...groups.values()]
                    .filter((group) => Object.entries(query).every(([key, value]) => group[key] === value))
                    .map((group) => ({ ...group })),
            async update(id, properties) {
                calls.push({ method: 'tabGroups.update', id, properties });
                Object.assign(
                    groups.get(id),
                    Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined))
                );
            },
            async move(id, properties) {
                calls.push({ method: 'tabGroups.move', id, properties });
                const group = groups.get(id);
                if (properties.windowId !== undefined) group.windowId = properties.windowId;
                const members = [...tabs.values()].filter((tab) => tab.groupId === id);
                const index =
                    properties.index === -1
                        ? [...tabs.values()].filter((tab) => tab.windowId === group.windowId && tab.groupId !== id)
                              .length
                        : properties.index;
                for (const [offset, tab] of members.entries())
                    Object.assign(tab, { windowId: group.windowId, index: index + offset });
            },
        },
        windows: {
            get: async (id) => getWindow(id),
            getAll: async () => [...windows.keys()].map((id) => getWindow(id)),
            async create(properties) {
                calls.push({ method: 'windows.create', properties });
                const id = nextWindow++;
                windows.set(id, {
                    id,
                    type: 'normal',
                    focused: false,
                    state: 'normal',
                    incognito: false,
                    ...properties,
                });
                if (properties.tabId !== undefined) {
                    Object.assign(tabs.get(properties.tabId), { windowId: id, groupId: -1 });
                }
                if (properties.url !== undefined || properties.tabId === undefined) {
                    const urls = Array.isArray(properties.url) ? properties.url : [properties.url ?? 'about:blank'];
                    for (const [index, url] of urls.entries()) {
                        const tabId = nextTab++;
                        tabs.set(tabId, {
                            ...defaults,
                            id: tabId,
                            windowId: id,
                            index,
                            url,
                            incognito: properties.incognito ?? false,
                        });
                    }
                }
                return getWindow(id);
            },
            async update(id, properties) {
                calls.push({ method: 'windows.update', id, properties });
                Object.assign(windows.get(id), properties);
                return getWindow(id);
            },
            async remove(id) {
                calls.push({ method: 'windows.remove', id });
                if (failClose) throw new Error('window close refused');
                for (const tab of tabs.values()) if (tab.windowId === id) tabs.delete(tab.id);
                windows.delete(id);
                removeEmptyGroups();
            },
        },
    };
    return {
        chrome,
        tabs,
        groups,
        calls,
        setFailClose: (value) => {
            failClose = value;
        },
    };
}

test('C1 post-create failures preserve target identity, actual management and failure stage', async (t) => {
    for (const stage of ['storage', 'group', 'navigation', 'window-storage']) {
        await t.test(stage, async () => {
            const fixture = createTabManagementFixture();
            const restore = installGlobals({ chrome: fixture.chrome });
            const set = fixture.chrome.storage.session.set;
            if (stage.endsWith('storage'))
                fixture.chrome.storage.session.set = async () => {
                    throw new Error('storage refused');
                };
            if (stage === 'group')
                fixture.chrome.tabs.group = async () => {
                    throw new Error('group refused');
                };
            try {
                const handler = new TabHandler({
                    waitForNavigation: async () => {
                        throw new Error('navigation refused');
                    },
                });
                const operation =
                    stage === 'window-storage'
                        ? () => handler.windowCreate({ url: 'https://example.com/new', focused: false }, {})
                        : () =>
                              handler.tabsCreate(
                                  {
                                      windowId: 20,
                                      ...(stage === 'group' ? { groupId: 77 } : {}),
                                      ...(stage === 'navigation' ? { waitUntil: 'load', timeout: 1 } : {}),
                                  },
                                  {}
                              );
                await assert.rejects(operation, (error) => {
                    const body = JSON.parse(error.message).error;
                    assert.equal(body.code, 'CREATE_INCOMPLETE');
                    assert.equal(body.context.createdTargetId, '6000');
                    assert.equal(body.context.actionExecuted, true);
                    assert.equal(body.context.actionStatus, 'partial');
                    assert.equal(body.context.failureStage, stage === 'window-storage' ? 'storage' : stage);
                    assert.equal(body.context.managed, !stage.endsWith('storage'));
                    if (stage === 'window-storage') assert.equal(body.context.windowId, 30);
                    return true;
                });
                assert.equal(fixture.tabs.has(6000), true);
                assert.equal(fixture.calls.filter((call) => call.method.endsWith('.create')).length, 1);
                assert.equal(
                    fixture.calls.some((call) => call.method.endsWith('.remove')),
                    false
                );
            } finally {
                fixture.chrome.storage.session.set = set;
                await unmarkManagedTab(6000);
                forgetPageRevision(6000);
                restore();
            }
        });
    }
});

test('C2 action grants and revokes ordinary reads without GUI and without full operation rights', async () => {
    const fixture = createTabManagementFixture();
    let documentId = 'grant-document';
    fixture.chrome.webNavigation = { getFrame: async () => ({ documentId }) };
    const restore = installGlobals({ chrome: fixture.chrome });
    let handler;
    const context = { serverInstanceId: 'public-grant-server', mcpWindowId: null, mcpTabGroupId: null };
    try {
        handler = new ActionHandler();
        const before = await pageSnapshot(5001);
        await assert.rejects(() => assertReadableTab(5001, context, 'read'), /只读权限/);
        const grant = await handler.execute(
            'tabs_read_access',
            { tabId: 5001, allow: true, expectedRevision: before.revision },
            context
        );
        assert.equal(grant.allowed, true);
        assert.equal(grant.managed, false);
        assert.equal(grant.revision, before.revision);
        assert.equal((await pageSnapshot(5001)).revision, before.revision);
        await assertReadableTab(5001, context, 'read');
        assert.equal(await hasReadGrant('other-server', 5001), false);
        for (const [action, params] of [
            ['evaluate', {}],
            ['debugger_attach', {}],
            ['input_key', {}],
            ['screenshot', {}],
            ['tabs_close', {}],
            ['tabs_activate', {}],
            ['tabs_activate_managed', {}],
            ['tabs_move', { index: 0 }],
            ['tabs_reorder', { index: 0 }],
            ['tabs_pin', { pinned: true }],
            ['tabs_update', { pinned: true }],
            ['navigate', { url: 'https://example.com/not-authorized' }],
            ['go_back', {}],
            ['go_forward', {}],
            ['reload', {}],
        ]) {
            await assert.rejects(() => handler.execute(action, { tabId: 5001, ...params }, context), /非托管/);
            assert.equal((await pageSnapshot(5001)).revision, before.revision, action);
            assert.equal(await hasReadGrant(context.serverInstanceId, 5001), true, action);
            await assertReadableTab(5001, context, 'read');
        }
        assert.equal(
            fixture.calls.some((call) => /^(tabs|windows)\.(update|move|remove)$/.test(call.method)),
            false
        );
        await handler.execute('tabs_read_access', { tabId: 5001, allow: false }, context);
        await assert.rejects(() => assertReadableTab(5001, context, 'read'), /只读权限/);
        await assert.rejects(
            () => handler.execute('tabs_read_access', { tabId: 5001, allow: true, expectedRevision: 'stale' }, context),
            /ACTION_PRECONDITION_FAILED/
        );
        await handler.execute('tabs_read_access', { tabId: 5001, allow: true }, context);
        documentId = 'replacement-document';
        assert.equal(await hasReadGrant(context.serverInstanceId, 5001), false);
        await handler.execute('tabs_read_access', { tabId: 5001, allow: true }, context);
        advancePageRevision(5001);
        assert.equal(await hasReadGrant(context.serverInstanceId, 5001), false);
        await handler.execute('tabs_read_access', { tabId: 5001, allow: false }, context);
        const set = fixture.chrome.storage.session.set;
        fixture.chrome.storage.session.set = async () => {
            throw new Error('grant storage refused');
        };
        await assert.rejects(
            () => handler.execute('tabs_read_access', { tabId: 5001, allow: true }, context),
            /storage refused/
        );
        fixture.chrome.storage.session.set = set;
        assert.equal(await hasReadGrant(context.serverInstanceId, 5001), false);
        assert.equal(
            fixture.calls.some((call) => call.method === 'tabs.update'),
            false
        );
    } finally {
        if (handler?.logManager.sweepTimer) globalThis.clearInterval(handler.logManager.sweepTimer);
        await revokeReadGrants(context.serverInstanceId);
        forgetPageRevision(5001);
        restore();
    }
});

test('C13 tab updates consume native flags, preserve false values and reject stale conditions', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    let handler;
    try {
        await markManagedTab(5001);
        handler = new ActionHandler();
        const before = await pageSnapshot(5001);
        await assert.rejects(
            () => handler.execute('tabs_update', { tabId: 5001, muted: true, expectedRevision: 'stale' }, {}),
            /ACTION_PRECONDITION_FAILED/
        );
        assert.equal(fixture.calls.length, 0);
        const properties = {
            url: 'https://example.com/updated',
            active: true,
            pinned: true,
            highlighted: true,
            muted: true,
            autoDiscardable: false,
            openerTabId: 5002,
        };
        const changed = await handler.execute(
            'tabs_update',
            { tabId: 5001, ...properties, expectedRevision: before.revision },
            {}
        );
        assert.deepEqual(fixture.calls[0], { method: 'tabs.update', id: 5001, properties });
        assert.equal(changed.before.muted, false);
        assert.equal(changed.after.muted, true);
        assert.equal(changed.after.openerTabId, 5002);
        assert.equal(changed.before.revision, before.revision);
        assert.equal(changed.after.revision, (await pageSnapshot(5001)).revision);
        const userResult = { after: { id: 5001, revision: 'user-data' } };
        handler.actions.set('evaluate', async () => userResult);
        assert.deepEqual(await handler.execute('evaluate', { tabId: 5001 }, {}), userResult);
        assert.equal(userResult.after.revision, 'user-data');
        const reset = await handler.execute(
            'tabs_update',
            { tabId: 5001, pinned: false, highlighted: false, muted: false, autoDiscardable: true },
            {}
        );
        for (const key of ['pinned', 'highlighted', 'muted']) assert.equal(reset.after[key], false);
        assert.equal(reset.after.active, true);
        assert.equal(reset.after.autoDiscardable, true);
        await assert.rejects(() => handler.execute('tabs_update', { tabId: 5001 }, {}), /至少一个/);
        await assert.rejects(() => handler.execute('tabs_update', { tabId: 5001, openerTabId: 5003 }, {}), /同一窗口/);
    } finally {
        if (handler?.logManager.sweepTimer) globalThis.clearInterval(handler.logManager.sweepTimer);
        await unmarkManagedTab(5001);
        forgetPageRevision(5001);
        restore();
    }
});

test('C15 rejected updates preserve revisions while dispatched failures invalidate them', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    let handler;
    try {
        await markManagedTab(5001);
        fixture.tabs.get(5001).active = true;
        handler = new ActionHandler();
        const before = await pageSnapshot(5001);
        for (const properties of [
            { active: false, muted: true },
            { active: false, highlighted: true },
            {},
            { openerTabId: 5003, muted: true },
            { openerTabId: 5001 },
            { url: '', muted: true },
        ]) {
            await assert.rejects(
                () => handler.execute('tabs_update', { tabId: 5001, ...properties }, {}),
                (error) => {
                    const body = JSON.parse(error.message).error;
                    assert.equal(error.actionExecuted, false);
                    assert.equal(body.context.actionExecuted, false);
                    assert.equal(body.context.failureStage, 'preflight');
                    return true;
                }
            );
            assert.equal((await pageSnapshot(5001)).revision, before.revision);
            assert.equal(fixture.tabs.get(5001).active, true);
            assert.equal(fixture.tabs.get(5001).mutedInfo.muted, false);
            assert.equal(fixture.calls.length, 0);
        }
        const update = fixture.chrome.tabs.update;
        fixture.chrome.tabs.update = async (...args) => {
            await update(...args);
            throw new ExpectedOperationError('native update result unknown');
        };
        await assert.rejects(() => handler.execute('tabs_update', { tabId: 5001, muted: true }, {}), /unknown/);
        assert.equal(fixture.tabs.get(5001).mutedInfo.muted, true);
        assert.notEqual((await pageSnapshot(5001)).revision, before.revision);
    } finally {
        if (handler?.logManager.sweepTimer) globalThis.clearInterval(handler.logManager.sweepTimer);
        await unmarkManagedTab(5001);
        forgetPageRevision(5001);
        restore();
    }
});

test('C15 creation preflight failures preserve known non-execution without native creation', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    try {
        await markManagedTab(5001);
        const handler = new TabHandler({});
        for (const [method, params] of [
            ['tabsCreate', { windowId: 10, groupId: 77 }],
            ['tabsCreate', { windowId: 10, openerTabId: 5003 }],
            ['tabsCreate', { groupId: -2 }],
            ['tabsCreate', { groupId: 77, pinned: true }],
            ['tabsCreate', { openerTabId: 9999 }],
            ['windowCreate', { tabId: 5001, incognito: true }],
            ['windowCreate', { tabId: 5002 }],
            ['windowCreate', { state: 'maximized', width: 800 }],
        ]) {
            await assert.rejects(
                () => handler[method](params, {}),
                (error) => {
                    const body = JSON.parse(error.message).error;
                    assert.equal(body.context.actionExecuted, false);
                    assert.equal(body.context.actionStatus, 'not_started');
                    assert.equal(body.context.failureStage, 'preflight');
                    return true;
                }
            );
            assert.equal(fixture.calls.length, 0);
        }
    } finally {
        await unmarkManagedTab(5001);
        restore();
    }
});

test('C15 new groups retain their member window and require a destination for mixed windows', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    try {
        for (const id of [5001, 5002]) {
            await markManagedTab(id);
            fixture.tabs.get(id).windowId = 20;
        }
        const handler = new TabHandler({});
        const grouped = await handler.tabGroupCreate({ tabIds: [5001, 5002] }, {});
        assert.equal(grouped.after[0].windowId, 20);
        assert.ok(grouped.tabsAfter.every((tab) => tab.windowId === 20));
        assert.deepEqual(fixture.calls[0].properties.createProperties, { windowId: 20 });
        fixture.tabs.get(5002).windowId = 10;
        const count = fixture.calls.length;
        await assert.rejects(() => handler.tabGroupCreate({ tabIds: [5001, 5002] }, {}), /windowId/);
        assert.equal(fixture.calls.length, count);
        const moved = await handler.tabGroupCreate({ tabIds: [5001, 5002], windowId: 20 }, {});
        assert.ok(moved.tabsAfter.every((tab) => tab.windowId === 20));
        const created = await handler.tabsCreate({}, { mcpWindowId: null, mcpTabGroupId: null });
        const window = fixture.calls.find((call) => call.method === 'windows.create');
        const create = fixture.calls.find((call) => call.method === 'tabs.create');
        const group = fixture.calls.findLast((call) => call.method === 'tabs.group');
        assert.ok(window);
        assert.equal(created.windowId, create.properties.windowId);
        assert.deepEqual(group.properties.createProperties, { windowId: created.windowId });
    } finally {
        for (const id of fixture.tabs.keys()) await unmarkManagedTab(id);
        restore();
    }
});

test('C15 popup creation rejects extra pages before creating or moving a tab', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    try {
        await markManagedTab(5001);
        const handler = new TabHandler({});
        for (const params of [
            { type: 'popup', url: ['https://example.com/a', 'https://example.com/b'] },
            { type: 'popup', tabId: 5001, url: 'https://example.com/extra' },
            { type: 'popup', tabId: 5001, url: ['https://example.com/extra'] },
        ]) {
            await assert.rejects(() => handler.windowCreate(params, {}), /popup/);
            assert.equal(fixture.calls.length, 0);
            assert.equal(fixture.tabs.get(5001).windowId, 10);
        }
        const single = await handler.windowCreate({ type: 'popup', url: ['https://example.com/a'] }, {});
        assert.equal(single.after.tabs.length, 1);
        assert.equal(single.after.tabs[0].managed, true);
        const moved = await handler.windowCreate({ type: 'popup', tabId: 5001 }, {});
        assert.equal(moved.targetId, '5001');
        assert.equal(moved.after.tabs.length, 1);
    } finally {
        for (const id of fixture.tabs.keys()) await unmarkManagedTab(id);
        restore();
    }
});

test('C13 page creation preserves explicit placement and rejects conflicting window or group options', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    try {
        const handler = new TabHandler({});
        const created = await handler.tabsCreate(
            { url: 'https://example.com/new', windowId: 10, index: 1, pinned: true, openerTabId: 5002, active: false },
            {}
        );
        assert.deepEqual(
            fixture.calls.map((call) => call.method),
            ['tabs.create']
        );
        assert.equal(created.windowId, 10);
        assert.equal(created.index, 1);
        assert.equal(created.pinned, true);
        assert.equal(created.openerTabId, 5002);
        assert.equal(created.managed, true);
        assert.equal(created.groupId, -1);
        const count = fixture.calls.length;
        await assert.rejects(() => handler.tabsCreate({ windowId: 10, groupId: 77 }, {}), /同一窗口/);
        await assert.rejects(() => handler.tabsCreate({ groupId: 77, pinned: true }, {}), /不兼容/);
        assert.equal(fixture.calls.length, count);
    } finally {
        for (const id of fixture.tabs.keys()) await unmarkManagedTab(id);
        restore();
    }
});

test('C13 group CRUD returns real members and properties without changing managed authority', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    let handler;
    try {
        handler = new ActionHandler();
        await markManagedTab(5001);
        await markManagedTab(5002);
        const created = await handler.execute(
            'tabgroup_create',
            { tabIds: [5001, 5002], title: '', color: 'purple', collapsed: true },
            {}
        );
        const groupId = created.groupId;
        const original = created.after.find((group) => group.id === groupId);
        assert.deepEqual(original.tabIds, [5001, 5002]);
        assert.deepEqual(original.targetIds, ['5001', '5002']);
        assert.equal(original.color, 'purple');
        assert.equal(original.title, '');
        assert.equal(original.collapsed, true);
        assert.equal(original.shared, false);
        const updated = await handler.execute(
            'tabgroup_update',
            { groupId, title: 'Updated', color: 'yellow', collapsed: false },
            {}
        );
        assert.equal(updated.after[0].color, 'yellow');
        assert.equal(updated.after[0].collapsed, false);
        const moved = await handler.execute('tabgroup_move', { groupId, windowId: 20, index: -1 }, {});
        assert.equal(moved.after[0].windowId, 20);
        assert.equal(
            moved.tabsAfter.every((tab) => tab.windowId === 20 && tab.managed),
            true
        );
        await handler.execute('tabs_release', { tabId: 5001 }, {});
        assert.equal(fixture.tabs.get(5001).groupId, groupId);
        assert.equal(isManagedTab({ id: 5001 }), false);
        const count = fixture.calls.length;
        await assert.rejects(() => handler.execute('tabgroup_update', { groupId, color: 'red' }, {}), /非托管/);
        assert.equal(fixture.calls.length, count);
        await handler.execute('tabs_adopt', { tabId: 5001 }, {});
        const removed = await handler.execute('tabgroup_remove', { tabIds: [5001, 5002] }, {});
        assert.deepEqual(removed.after, []);
        assert.equal(
            removed.tabsAfter.every((tab) => tab.groupId === -1 && tab.managed),
            true
        );
        const added = await handler.execute('tabgroup_add', { tabIds: [5001, 5002], groupId: 77 }, {});
        assert.equal(added.groupId, 77);
        assert.equal(isManagedTab({ id: 5003 }), false);
        const topology = await handler.execute('tabs_topology', {}, {});
        assert.deepEqual(topology.groups.find((group) => group.id === 77).tabIds, [5003, 5001, 5002]);
    } finally {
        if (handler?.logManager.sweepTimer) globalThis.clearInterval(handler.logManager.sweepTimer);
        for (const id of fixture.tabs.keys()) {
            await unmarkManagedTab(id);
            forgetPageRevision(id);
        }
        restore();
    }
});

test('C13 mixed groups and windows reject mutation before effects even when cached as MCP assets', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    try {
        await markManagedTab(5001);
        const handler = new TabHandler({});
        await assert.rejects(() => handler.tabGroupCreate({ tabIds: [5001, 5002], color: 'red' }, {}), /非托管/);
        await assert.rejects(() => handler.windowFocus({ windowId: 10 }, { mcpWindowId: 10 }), /UNMANAGED_WINDOW/);
        await assert.rejects(
            () => handler.windowCreate({ url: 'https://example.com/', state: 'maximized', width: 800 }, {}),
            /不能/
        );
        await assert.rejects(
            () => handler.windowUpdate({ windowId: 10, state: 'minimized', focused: true }, {}),
            /冲突/
        );
        assert.equal(fixture.calls.length, 0);
    } finally {
        await unmarkManagedTab(5001);
        restore();
    }
});

test('C13 window CRUD marks all created tabs and keeps permissions if native close fails', async () => {
    const fixture = createTabManagementFixture();
    const restore = installGlobals({ chrome: fixture.chrome });
    try {
        const handler = new TabHandler({});
        const created = await handler.windowCreate(
            {
                url: ['https://example.com/a', 'https://example.com/b'],
                type: 'normal',
                focused: false,
                width: 800,
                height: 600,
                setSelfAsOpener: true,
            },
            {}
        );
        assert.equal(created.after.tabs.length, 2);
        assert.equal(
            created.after.tabs.every((tab) => tab.managed),
            true
        );
        assert.equal(created.after.type, 'normal');
        const updated = await handler.windowUpdate(
            {
                windowId: created.windowId,
                left: 10,
                top: 20,
                width: 900,
                height: 700,
                state: 'normal',
                focused: false,
                drawAttention: false,
            },
            {}
        );
        assert.equal(updated.after.width, 900);
        assert.equal(updated.after.top, 20);
        assert.equal(fixture.calls.at(-1).properties.drawAttention, false);
        fixture.setFailClose(true);
        await assert.rejects(() => handler.windowClose({ windowId: created.windowId }, {}), /close refused/);
        assert.equal(
            created.after.tabs.every((tab) => isManagedTab(tab)),
            true
        );
        fixture.setFailClose(false);
        const closed = await handler.windowClose({ windowId: created.windowId }, {});
        assert.equal(closed.after, null);
        assert.equal(
            created.after.tabs.every((tab) => !isManagedTab(tab)),
            true
        );
        await markManagedTab(5001);
        const moved = await handler.windowCreate({ tabId: 5001, focused: false }, {});
        assert.equal(moved.targetId, '5001');
        assert.equal(moved.after.tabs[0].managed, true);
        assert.equal(fixture.calls.at(-1).properties.tabId, 5001);
        assert.equal(fixture.calls.at(-1).properties.url, undefined);
        const combined = await handler.windowCreate(
            { tabId: 5001, url: ['https://example.com/extra'], focused: false },
            {}
        );
        assert.equal(combined.targetId, '5001');
        assert.equal(combined.after.tabs.length, 2);
        assert.equal(
            combined.after.tabs.every((tab) => tab.managed),
            true
        );
        assert.deepEqual(fixture.calls.at(-1).properties.url, ['https://example.com/extra']);
    } finally {
        for (const id of [...fixture.tabs.keys(), 6000, 6001]) await unmarkManagedTab(id);
        setMcpWindowId(null);
        restore();
    }
});

test('C28 window updates observe state and stable geometry without replaying native updates', async (t) => {
    const scenarios = [
        ...['windowUpdate', 'windowResize'].flatMap((method) =>
            ['maximized', 'minimized', 'fullscreen'].map((state) => ({ method, state, kind: 'restore' }))
        ),
        { method: 'windowUpdate', state: 'normal', kind: 'state-only' },
        { method: 'windowUpdate', state: 'normal', kind: 'clamped' },
        { method: 'windowUpdate', state: 'maximized', kind: 'state-timeout' },
        { method: 'windowResize', state: 'normal', kind: 'bounds-timeout' },
        { method: 'windowUpdate', state: 'maximized', kind: 'released' },
    ];
    for (const specimen of scenarios) {
        await t.test(`${specimen.method}-${specimen.state}-${specimen.kind}`, async () => {
            const fixture = createTabManagementFixture();
            const getWindow = fixture.chrome.windows.get;
            const nativeCalls = [];
            let now = 0;
            let transition;
            let decorated = false;
            let released = false;
            let changed = false;
            const actual = { state: specimen.state, left: 90, top: 70, width: 1040, height: 780, focused: false };
            fixture.chrome.windows.get = async (id) => {
                if (transition && now >= transition.started + 100 && specimen.kind !== 'state-timeout') {
                    actual.state = transition.state;
                    if (now >= transition.started + 200 && !decorated) {
                        decorated = true;
                        actual.left -= 22;
                        actual.top -= 19;
                        actual.width += 44;
                        actual.height += 44;
                    }
                }
                if (specimen.kind === 'released' && transition && now >= transition.started + 200 && !released) {
                    released = true;
                    await unmarkManagedTab(5002);
                }
                if (specimen.kind === 'bounds-timeout' && changed) ++actual.left;
                return { ...(await getWindow(id)), ...actual };
            };
            fixture.chrome.windows.update = async (id, properties) => {
                nativeCalls.push({ id, properties: { ...properties }, at: now });
                changed = true;
                const bounds = Object.fromEntries(
                    ['left', 'top', 'width', 'height']
                        .filter((key) => properties[key] !== undefined)
                        .map((key) => [key, properties[key]])
                );
                if (properties.state && properties.state !== actual.state) {
                    transition = { state: properties.state, started: now };
                }
                Object.assign(actual, bounds);
                if (specimen.kind === 'clamped') actual.width = Math.max(actual.width, 320);
                if (properties.focused !== undefined) actual.focused = properties.focused;
                return { ...(await getWindow(id)), ...actual };
            };
            const RealDate = Date;
            const restore = installGlobals({
                chrome: fixture.chrome,
                Date: class extends RealDate {
                    static now() {
                        return now;
                    }
                },
                setTimeout(callback, ms) {
                    now += ms;
                    globalThis.queueMicrotask(callback);
                    return 0;
                },
            });
            try {
                await markManagedTab(5001);
                await markManagedTab(5002);
                const handler = new TabHandler({});
                const bounds = { left: 90, top: 70, width: 1040, height: 780 };
                const params =
                    specimen.kind === 'state-only'
                        ? { windowId: 10, state: 'maximized' }
                        : { windowId: 10, state: 'normal', ...bounds, focused: false, drawAttention: true };
                if (specimen.kind === 'clamped') params.width = 10;
                const invoke = () => handler[specimen.method](params);
                if (specimen.kind.endsWith('timeout')) {
                    await assert.rejects(invoke, (error) => {
                        const body = JSON.parse(error.message).error;
                        assert.equal(body.code, 'WINDOW_UPDATE_NOT_OBSERVED');
                        assert.equal(body.context.actionExecuted, true);
                        assert.equal(body.context.actionStatus, 'partial');
                        assert.equal(body.context.failureStage, 'observation');
                        assert.equal(body.context.windowId, 10);
                        return true;
                    });
                    assert.equal(nativeCalls.length, 1);
                    assert.ok(now >= 1000 && now <= 1100);
                    if (specimen.kind === 'state-timeout')
                        assert.deepEqual(nativeCalls[0].properties, { state: 'normal' });
                } else if (specimen.kind === 'released') {
                    await assert.rejects(invoke, /UNMANAGED_WINDOW/);
                    assert.equal(nativeCalls.length, 1);
                    assert.deepEqual(nativeCalls[0].properties, { state: 'normal' });
                } else {
                    const result = await invoke();
                    assert.equal(result.success, true);
                    assert.equal(result.after.state, params.state);
                    assert.equal(result.before.state, specimen.state);
                    if (specimen.kind === 'state-only') {
                        assert.equal(nativeCalls.length, 1);
                    } else {
                        for (const [key, value] of Object.entries(bounds)) {
                            assert.equal(
                                result.after[key],
                                specimen.kind === 'clamped' && key === 'width' ? 320 : value
                            );
                            assert.equal(result.after[key], actual[key]);
                        }
                        const geometry = nativeCalls.filter((call) => call.properties.width !== undefined);
                        assert.equal(geometry.length, 1);
                        assert.equal(geometry[0].properties.focused, false);
                        assert.equal(geometry[0].properties.drawAttention, true);
                        if (specimen.kind === 'restore') {
                            assert.equal(nativeCalls.length, 2);
                            assert.deepEqual(nativeCalls[0].properties, { state: 'normal' });
                            assert.equal(geometry[0].properties.state, undefined);
                            assert.ok(geometry[0].at >= 200);
                        }
                    }
                }
            } finally {
                await unmarkManagedTab(5001);
                await unmarkManagedTab(5002);
                restore();
            }
        });
    }
});

test('C10 network fallback reads requests completed after the first performance snapshot', async () => {
    const fixture = createTabManagementFixture();
    const first = {
        source: 'performance',
        url: 'https://example.com/first',
        method: 'GET',
        status: 200,
        type: 'Document',
        timestamp: 1000,
    };
    const second = {
        source: 'performance',
        url: 'https://example.com/later-fetch',
        method: '',
        status: 404,
        type: 'fetch',
        timestamp: 1100,
    };
    let reads = 0;
    fixture.chrome.scripting = { executeScript: async () => [{ result: ++reads === 1 ? [first] : [first, second] }] };
    const restore = installGlobals({ chrome: fixture.chrome });
    const manager = new LogManager();
    try {
        await markManagedTab(5001);
        const handler = new LogEventHandler(manager, { isAttached: () => false });
        assert.deepEqual((await handler.networkGet({ tabId: 5001 }, {})).requests, [first]);
        assert.deepEqual((await handler.networkGet({ tabId: 5001 }, {})).requests, [first, second]);
        assert.equal(reads, 2);
    } finally {
        if (manager.sweepTimer) globalThis.clearInterval(manager.sweepTimer);
        await unmarkManagedTab(5001);
        restore();
    }
});

test('C10 performance network refresh preserves markers and document-local clear boundaries', async () => {
    const fixture = createTabManagementFixture();
    let now = 100;
    let timeOrigin = 1000;
    let attached = false;
    let reads = 0;
    const navigation = [{ name: 'https://example.com/page', startTime: 0, duration: 1, responseStatus: 200 }];
    const resources = [
        { name: 'https://example.com/fetch', initiatorType: 'fetch', startTime: 10, duration: 3, responseStatus: 404 },
    ];
    fixture.chrome.scripting = {
        executeScript: async ({ world, func, args }) => {
            assert.equal(world, 'ISOLATED');
            ++reads;
            return [{ result: func(...args) }];
        },
    };
    const performance = {
        get timeOrigin() {
            return timeOrigin;
        },
        now: () => now,
        getEntriesByType: (type) => (type === 'navigation' ? navigation : resources),
    };
    const restore = installGlobals({ chrome: fixture.chrome, window: {}, performance });
    const manager = new LogManager();
    try {
        await markManagedTab(5001);
        const handler = new LogEventHandler(manager, { isAttached: () => attached });
        const read = async (clear = false) => (await handler.networkGet({ tabId: 5001, clear }, {})).requests;
        const first = await read();
        assert.equal(first.length, 2);
        assert.equal(first[1].source, 'performance');
        assert.equal(first[1].status, 404);
        const marker = JSON.stringify(first.at(-1));
        resources.push({ ...resources[0] });
        const second = await read();
        assert.equal(second.length, 3);
        assert.equal(JSON.stringify(second[1]), marker);
        assert.ok(second[2].sequence > second[1].sequence);
        assert.deepEqual(await read(), second);
        assert.deepEqual(await read(true), second);
        assert.equal(resources.length, 2);
        assert.equal(navigation.length, 1);
        assert.deepEqual(await read(), []);
        now = 120;
        resources.push({ ...resources[0], startTime: 110, responseStatus: 401 });
        const afterClear = await read();
        assert.equal(afterClear.length, 1);
        assert.equal(afterClear[0].status, 401);
        assert.ok(afterClear[0].sequence > second[2].sequence);
        attached = true;
        manager.setNetwork(5001, [
            { url: 'https://example.com/native', method: 'POST', type: 'Fetch', status: 200, timestamp: 1150 },
        ]);
        const beforeNative = reads;
        assert.equal((await read())[0].method, 'POST');
        assert.equal(reads, beforeNative);
        await handler.networkClear({ tabId: 5001 }, {});
        attached = false;
        assert.deepEqual(await read(), []);
        globalThis.window = {};
        timeOrigin = 2000;
        resources.length = 0;
        navigation[0] = { ...navigation[0], name: 'https://example.com/next-document' };
        const nextDocument = await read();
        assert.equal(nextDocument.length, 1);
        assert.equal(nextDocument[0].url, 'https://example.com/next-document');
        assert.ok(nextDocument[0].sequence > afterClear[0].sequence);
        fixture.chrome.scripting.executeScript = async () => [];
        await assert.rejects(() => read(), /did not return request records/);
    } finally {
        if (manager.sweepTimer) globalThis.clearInterval(manager.sweepTimer);
        await unmarkManagedTab(5001);
        restore();
    }
});

test('C07 fallback console survives a Service Worker restart without duplicate logs or wrapper loss', async () => {
    const originalCalls = [];
    const pageConsole = {};
    for (const level of ['log', 'warn', 'error', 'info', 'debug']) {
        pageConsole[level] = (...args) => originalCalls.push({ level, args });
    }
    const page = vm.createContext({
        console: pageConsole,
        window: {},
        Reflect,
        Array,
        Date,
        String,
    });
    const createLogManager = () => {
        const consoleMessages = new Map();
        return {
            hasConsole: (tabId) => consoleMessages.has(tabId),
            getConsole: (tabId) => consoleMessages.get(tabId) ?? [],
            setConsole: (tabId, messages) => consoleMessages.set(tabId, messages),
        };
    };
    let attachBlocked = true;
    const storage = createStorage();
    const restore = installGlobals({
        chrome: {
            storage,
            tabs: {
                async get() {
                    return { id: 1, url: 'https://test.example', groupId: 10 };
                },
            },
            debugger: {
                async attach() {
                    if (attachBlocked) {
                        throw new Error('Another debugger is already attached');
                    }
                },
                async sendCommand() {},
            },
            scripting: {
                async executeScript({ func }) {
                    const result = vm.runInContext(`(${func.toString()})()`, page);
                    return [{ result: await result }];
                },
            },
        },
    });
    try {
        await markManagedTab(1);
        const firstLogManager = createLogManager();
        const firstHandler = new LogEventHandler(firstLogManager, new DebuggerManager(firstLogManager));
        const context = { mcpWindowId: null, mcpTabGroupId: 10 };
        await firstHandler.consoleEnable({ tabId: 1 }, context);
        vm.runInContext("console.log('before-clear')", page);
        await firstHandler.consoleClear({ tabId: 1 }, context);
        vm.runInContext("console.log('after-clear')", page);
        const beforeRestart = await firstHandler.consoleGet({ tabId: 1 }, context);
        assert.deepEqual(
            beforeRestart.messages.map((message) => message.text),
            ['after-clear']
        );

        vm.runInContext(
            `window.laterErrorCalls = 0;
             window.mcpWrappedError = console.error;
             window.laterError = (...args) => {
                 window.laterErrorCalls++;
                 window.mcpWrappedError(...args);
             };
             console.error = window.laterError;
             console.error('before-restart');`,
            page
        );

        attachBlocked = false;
        const restartedLogManager = createLogManager();
        const restartedHandler = new LogEventHandler(restartedLogManager, new DebuggerManager(restartedLogManager));
        await restartedHandler.consoleEnable({ tabId: 1 }, context);
        assert.equal(vm.runInContext('window.__mcpConsoleHook', page), undefined);
        assert.equal(vm.runInContext('console.error === window.laterError', page), true);
        assert.equal(vm.runInContext('window.laterErrorCalls', page), 1);

        vm.runInContext("console.error('after-uninstall')", page);
        assert.equal(vm.runInContext('window.laterErrorCalls', page), 2);
        assert.equal(originalCalls.at(-1).args[0], 'after-uninstall');

        const afterRestart = await restartedHandler.consoleGet({ tabId: 1 }, context);
        const repeatedRead = await restartedHandler.consoleGet({ tabId: 1 }, context);
        assert.deepEqual(
            afterRestart.messages.map((message) => message.text),
            ['before-restart']
        );
        assert.deepEqual(
            repeatedRead.messages.map((message) => message.text),
            ['before-restart']
        );
    } finally {
        await unmarkManagedTab(1);
        restore();
    }
});

test('C07 concurrent console reads cannot overwrite a later fallback drain', async () => {
    const page = vm.createContext({
        window: {
            __mcpConsoleHook: {
                logs: [{ source: 'console-api', level: 'log', text: 'old-log', timestamp: 1 }],
            },
        },
        Array,
    });
    const consoleMessages = new Map();
    const logManager = {
        hasConsole: (tabId) => consoleMessages.has(tabId),
        getConsole: (tabId) => consoleMessages.get(tabId) ?? [],
        setConsole: (tabId, messages) => consoleMessages.set(tabId, messages),
    };
    const firstResult = createDeferred();
    let executeCalls = 0;
    const restore = installGlobals({
        chrome: {
            storage: createStorage(),
            tabs: {
                async get() {
                    return { id: 1, url: 'https://test.example', groupId: 10 };
                },
            },
            scripting: {
                async executeScript({ func }) {
                    executeCalls++;
                    const result = vm.runInContext(`(${func.toString()})()`, page);
                    if (executeCalls === 1) {
                        await firstResult.promise;
                    }
                    return [{ result }];
                },
            },
        },
    });
    try {
        await markManagedTab(1);
        const handler = new LogEventHandler(logManager, {});
        const context = { mcpWindowId: null, mcpTabGroupId: 10 };
        const firstRead = handler.consoleGet({ tabId: 1 }, context);
        await waitUntil(() => executeCalls === 1);
        page.window.__mcpConsoleHook.logs.push({
            source: 'console-api',
            level: 'log',
            text: 'new-log',
            timestamp: 2,
        });
        const secondRead = handler.consoleGet({ tabId: 1 }, context);
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
        assert.equal(executeCalls, 1);

        firstResult.resolve();
        const [first, second] = await Promise.all([firstRead, secondRead]);
        assert.deepEqual(
            first.messages.map((message) => message.text),
            ['old-log']
        );
        assert.deepEqual(
            second.messages.map((message) => message.text),
            ['old-log', 'new-log']
        );
        assert.deepEqual(
            logManager.getConsole(1).map((message) => message.text),
            ['old-log', 'new-log']
        );
    } finally {
        firstResult.resolve();
        await unmarkManagedTab(1);
        restore();
    }
});

test('C08 networkidle rejects while requests remain pending and honors the quiet window', async () => {
    const pending = new Map([['request-1', {}]]);
    const onCommitted = chromeEvent();
    const onDOMContentLoaded = chromeEvent();
    const onCompleted = chromeEvent();
    const restore = installGlobals({
        chrome: {
            tabs: {
                async get() {
                    return { status: 'complete' };
                },
            },
            webNavigation: { onCommitted, onDOMContentLoaded, onCompleted },
        },
    });
    try {
        const logManager = { getPending: () => pending, isPendingUncertain: () => false };
        const handler = new NavigationHandler(logManager);
        await assert.rejects(() => handler.waitForNavigation(1, 'networkidle', 40), /Navigation timeout/);

        globalThis.setTimeout(() => pending.clear(), 30);
        const startedAt = Date.now();
        await handler.waitForNavigation(1, 'networkidle', 1000);
        assert.ok(Date.now() - startedAt >= 500);
    } finally {
        restore();
    }
});

test('C08 long-running requests remain pending after the diagnostic sweep', () => {
    const originalSetInterval = globalThis.setInterval;
    const originalWarn = globalThis.console.warn;
    const warnings = [];
    globalThis.setInterval = () => 0;
    globalThis.console.warn = (message) => warnings.push(message);
    const manager = new LogManager();
    globalThis.setInterval = originalSetInterval;
    try {
        manager.handleEvent(1, 'Network.requestWillBeSent', {
            requestId: 'long-request',
            request: { url: 'https://example.com/stream', method: 'GET' },
            type: 'Fetch',
            timestamp: 1,
            wallTime: 10,
        });
        manager.getPending(1).get('long-request')._addedAt = Date.now() - 61_000;
        manager.sweepPending();
        manager.sweepPending();
        assert.equal(manager.getPending(1).size, 1);
        assert.equal(warnings.length, 1);

        manager.handleEvent(1, 'Network.loadingFinished', { requestId: 'long-request', timestamp: 62 });
        assert.equal(manager.getPending(1), undefined);
    } finally {
        globalThis.console.warn = originalWarn;
    }
});

test('C08 pending capacity loss makes networkidle uncertain until tab cleanup', async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalWarn = globalThis.console.warn;
    globalThis.setInterval = () => 0;
    globalThis.console.warn = () => {};
    const manager = new LogManager();
    globalThis.setInterval = originalSetInterval;
    try {
        for (let index = 0; index <= 500; index++) {
            manager.handleEvent(1, 'Network.requestWillBeSent', {
                requestId: `request-${index}`,
                request: { url: `https://example.com/${index}`, method: 'GET' },
                type: 'Fetch',
                timestamp: index,
                wallTime: index,
            });
        }
        assert.equal(manager.getPending(1).size, 500);
        assert.equal(manager.isPendingUncertain(1), true);
        for (let index = 1; index <= 500; index++) {
            manager.handleEvent(1, 'Network.loadingFinished', {
                requestId: `request-${index}`,
                timestamp: index + 1,
            });
        }
        assert.equal(manager.getPending(1), undefined);

        const restoreChrome = installGlobals({
            chrome: {
                tabs: {
                    async get() {
                        return { status: 'complete' };
                    },
                },
                webNavigation: {
                    onCommitted: chromeEvent(),
                    onDOMContentLoaded: chromeEvent(),
                    onCompleted: chromeEvent(),
                },
            },
        });
        try {
            const handler = new NavigationHandler(manager);
            await assert.rejects(() => handler.waitForNavigation(1, 'networkidle', 40), /Navigation timeout/);
        } finally {
            restoreChrome();
        }

        manager.cleanupTab(1);
        assert.equal(manager.isPendingUncertain(1), false);
    } finally {
        globalThis.console.warn = originalWarn;
    }
});

test('C08 debugger detach keeps network tracking uncertain until a new root document', async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalLog = globalThis.console.log;
    globalThis.setInterval = () => 0;
    globalThis.console.log = () => {};
    const manager = new LogManager();
    globalThis.setInterval = originalSetInterval;
    const onDetach = chromeEvent();
    const onEvent = chromeEvent();
    const restore = installGlobals({
        chrome: {
            debugger: {
                onDetach,
                onEvent,
                async attach() {},
            },
            tabs: {
                async get() {
                    return { status: 'complete' };
                },
            },
            webNavigation: {
                onCommitted: chromeEvent(),
                onDOMContentLoaded: chromeEvent(),
                onCompleted: chromeEvent(),
            },
        },
    });
    try {
        const debuggerManager = new DebuggerManager(manager);
        debuggerManager.setupListeners();
        await debuggerManager.ensureAttached(1);
        manager.setMainFrameId(1, 'main-frame');
        manager.handleEvent(1, 'Network.requestWillBeSent', {
            requestId: 'lost-request',
            request: { url: 'https://example.com/stream', method: 'GET' },
            type: 'Fetch',
            frameId: 'main-frame',
            timestamp: 1,
            wallTime: 10,
        });

        onDetach.emit({ tabId: 1 }, 'target_closed');
        assert.equal(manager.getPending(1), undefined);
        assert.equal(manager.isPendingUncertain(1), true);
        await assert.rejects(
            () => new NavigationHandler(manager).waitForNavigation(1, 'networkidle', 40),
            /Navigation timeout/
        );

        manager.handleEvent(1, 'Page.frameNavigated', { frame: { id: 'new-main-frame' } });
        manager.handleEvent(1, 'Network.requestWillBeSent', {
            requestId: 'new-document',
            request: { url: 'https://example.com/next', method: 'GET' },
            type: 'Document',
            frameId: 'new-main-frame',
            timestamp: 2,
            wallTime: 11,
        });
        assert.equal(manager.isPendingUncertain(1), false);
        assert.equal(manager.getPending(1).size, 1);

        manager.handleDebuggerDetach(1);
        assert.equal(manager.isPendingUncertain(1), true);
        manager.cleanupTab(1);
        assert.equal(manager.isPendingUncertain(1), false);
    } finally {
        globalThis.console.log = originalLog;
        restore();
    }
});

test('Extension context loss and error-page injection remain explicit failures without replay', async () => {
    const tab = { id: 9801, url: 'https://example.com/' };
    let debuggerCalls = 0;
    let injections = 0;
    let debuggerError = new Error('{"code":-32000,"message":"Cannot find context with specified id"}');
    let injectionError = new Error('Frame with ID 0 is showing error page');
    const restore = installGlobals({
        chrome: {
            storage: createStorage(),
            tabs: {
                async get() {
                    return tab;
                },
            },
            debugger: {
                async sendCommand() {
                    debuggerCalls++;
                    throw debuggerError;
                },
            },
            scripting: {
                async executeScript() {
                    injections++;
                    throw injectionError;
                },
            },
        },
    });
    try {
        await markManagedTab(tab.id);
        const debuggerHandler = new DebuggerHandler({ async ensureAttached() {} }, {});
        await assert.rejects(
            () =>
                debuggerHandler.debuggerSend(
                    { tabId: tab.id, method: 'Runtime.evaluate', params: { expression: '1' } },
                    {}
                ),
            (error) => error instanceof ExpectedOperationError && error.message.includes('Cannot find context')
        );
        assert.equal(debuggerCalls, 1);
        debuggerError = new Error('unexpected debugger defect');
        await assert.rejects(
            () => debuggerHandler.debuggerSend({ tabId: tab.id, method: 'Runtime.evaluate' }, {}),
            (error) => error === debuggerError
        );
        const contentHandler = new ContentHandler({
            async ensureAttached() {
                assert.fail('failed dimension reads must not attach the debugger');
            },
        });
        const actions = [
            () => contentHandler.getText({ tabId: tab.id }, {}),
            () => contentHandler.getViewportMetrics({ tabId: tab.id }, {}),
            () =>
                contentHandler.inspectChallenge(
                    {
                        tabId: tab.id,
                        challengeSelectors: [],
                        deniedSelectors: [],
                        widgetSelectors: [],
                        verifyButtonSelectors: [],
                        frameSelectors: [],
                        titleNeedles: [],
                        textMarkers: [],
                        originResponsePendingTextMarkers: [],
                    },
                    {}
                ),
            () => contentHandler.screenshot({ tabId: tab.id }, {}),
        ];
        for (const [index, action] of actions.entries()) {
            const before = injections;
            for (const message of ['Frame with ID 0 is showing error page', 'Cannot access a chrome:// URL']) {
                injectionError = new Error(message);
                await assert.rejects(
                    action,
                    (error) =>
                        error instanceof ExpectedOperationError &&
                        (index === 0 ? JSON.parse(error.message).error.message === message : error.message === message)
                );
            }
            injectionError = new Error('unexpected injection defect');
            await assert.rejects(action, (error) =>
                index === 0 ? error.cause === injectionError : error === injectionError
            );
            assert.equal(injections, before + 3);
        }
        assert.equal(debuggerCalls, 2);
    } finally {
        await unmarkManagedTab(tab.id);
        restore();
    }
});

test('Extension history uses fallback only for scriptable no-history pages and cleans failed waits', async () => {
    for (const direction of ['back', 'forward']) {
        for (const scenario of [
            'native',
            'native-restricted',
            'restricted',
            'error-page',
            'missing-frame',
            'fallback',
            'unexpected',
            'injection-error',
        ]) {
            const native = scenario === 'native' || scenario === 'native-restricted';
            const tab = {
                id: 9802,
                url:
                    scenario === 'restricted' || scenario === 'native-restricted'
                        ? 'chrome://settings/'
                        : 'https://example.com/current',
            };
            const onUpdated = chromeEvent();
            const onCommitted = chromeEvent();
            let injections = 0;
            const nativeError = new Error(
                scenario === 'unexpected' ? 'native navigation defect' : 'Cannot find a next page in history'
            );
            const navigate = () => {
                tab.url = 'https://example.com/previous';
                onUpdated.emit(tab.id, { url: tab.url });
            };
            const restore = installGlobals({
                chrome: {
                    storage: createStorage(),
                    tabs: {
                        async get() {
                            return tab;
                        },
                        onUpdated,
                        async goBack() {
                            if (native) {
                                navigate();
                            } else {
                                throw nativeError;
                            }
                        },
                        async goForward() {
                            if (native) {
                                navigate();
                            } else {
                                throw nativeError;
                            }
                        },
                    },
                    webNavigation: {
                        onCommitted,
                        async getFrame() {
                            return scenario === 'missing-frame' ? null : { errorOccurred: scenario === 'error-page' };
                        },
                    },
                    scripting: {
                        async executeScript() {
                            injections++;
                            if (scenario === 'injection-error') {
                                throw new Error('Frame with ID 0 is showing error page');
                            }
                            navigate();
                        },
                    },
                },
            });
            try {
                await markManagedTab(tab.id);
                const handler = new NavigationHandler({});
                const signal = handler.waitForNavigationSignal.bind(handler);
                handler.waitForNavigationSignal = (tabId, beforeUrl) => signal(tabId, beforeUrl, 1);
                const action = () =>
                    handler[direction === 'back' ? 'goBack' : 'goForward']({ tabId: tab.id, timeout: 1000 }, {});
                if (scenario === 'unexpected') {
                    await assert.rejects(action, (error) => error === nativeError);
                } else if (scenario === 'injection-error') {
                    await assert.rejects(
                        action,
                        (error) =>
                            error instanceof ExpectedOperationError && error.message.includes('showing error page')
                    );
                } else {
                    const result = await action();
                    assert.equal(result.navigated, native || scenario === 'fallback', `${direction}/${scenario}`);
                }
                assert.equal(
                    injections,
                    scenario === 'fallback' || scenario === 'injection-error' ? 1 : 0,
                    `${direction}/${scenario}`
                );
                assert.equal(onUpdated.size, 0, `${direction}/${scenario}`);
                assert.equal(onCommitted.size, 0, `${direction}/${scenario}`);
            } finally {
                await unmarkManagedTab(tab.id);
                restore();
            }
        }
    }
});

test('C04 Extension navigation waits for the lifecycle of the newly committed document', async () => {
    const onCommitted = chromeEvent();
    const onDOMContentLoaded = chromeEvent();
    const onCompleted = chromeEvent();
    const onHistoryStateUpdated = chromeEvent();
    const onReferenceFragmentUpdated = chromeEvent();
    const restore = installGlobals({
        chrome: {
            webNavigation: {
                onCommitted,
                onDOMContentLoaded,
                onCompleted,
                onHistoryStateUpdated,
                onReferenceFragmentUpdated,
            },
        },
    });
    try {
        const handler = new NavigationHandler({
            getPending: () => undefined,
            isPendingUncertain: () => false,
        });
        await handler.runNavigationAction(7, 'domcontentloaded', Date.now() + 1000, async () => {
            assert.equal(onCommitted.size, 1);
            assert.equal(onDOMContentLoaded.size, 1);
            onDOMContentLoaded.emit({ tabId: 7, frameId: 0, documentId: 'previous-document' });
            onCommitted.emit({ tabId: 7, frameId: 0, documentId: 'current-document' });
            onCompleted.emit({ tabId: 7, frameId: 0, documentId: 'previous-document' });
            onDOMContentLoaded.emit({ tabId: 7, frameId: 0, documentId: 'current-document' });
        });
        assert.equal(onCommitted.size, 0);
        assert.equal(onDOMContentLoaded.size, 0);
        assert.equal(onCompleted.size, 0);
    } finally {
        restore();
    }
});

test('C04 Extension same-document navigation rejects stale document and URL events', async () => {
    const onCommitted = chromeEvent();
    const onDOMContentLoaded = chromeEvent();
    const onCompleted = chromeEvent();
    const onHistoryStateUpdated = chromeEvent();
    const onReferenceFragmentUpdated = chromeEvent();
    const restore = installGlobals({
        chrome: {
            webNavigation: {
                onCommitted,
                onDOMContentLoaded,
                onCompleted,
                onHistoryStateUpdated,
                onReferenceFragmentUpdated,
                async getFrame() {
                    return { documentId: 'baseline-document' };
                },
            },
        },
    });
    try {
        const handler = new NavigationHandler({
            getPending: () => undefined,
            isPendingUncertain: () => false,
        });
        let actionRan = false;
        let operationSettled = false;
        const operation = handler.runNavigationAction(
            7,
            'load',
            Date.now() + 1000,
            async () => {
                actionRan = true;
                onHistoryStateUpdated.emit({
                    tabId: 7,
                    frameId: 0,
                    documentId: 'stale-document',
                    url: 'https://example.com/path#target',
                });
                onReferenceFragmentUpdated.emit({
                    tabId: 7,
                    frameId: 0,
                    documentId: 'baseline-document',
                    url: 'https://example.com/path#other',
                });
            },
            'HTTPS://EXAMPLE.COM:443/path#target'
        );
        operation.then(
            () => {
                operationSettled = true;
            },
            () => {
                operationSettled = true;
            }
        );
        await waitUntil(() => actionRan);
        await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
        assert.equal(operationSettled, false);

        onHistoryStateUpdated.emit({
            tabId: 7,
            frameId: 0,
            documentId: 'baseline-document',
            url: 'https://example.com/path#target',
        });
        await operation;
        assert.equal(onHistoryStateUpdated.size, 0);
        assert.equal(onReferenceFragmentUpdated.size, 0);
    } finally {
        restore();
    }
});

test('C04 Extension navigation still reports an action failure after the lifecycle event', async () => {
    const onCommitted = chromeEvent();
    const onDOMContentLoaded = chromeEvent();
    const onCompleted = chromeEvent();
    const onHistoryStateUpdated = chromeEvent();
    const onReferenceFragmentUpdated = chromeEvent();
    const restore = installGlobals({
        chrome: {
            webNavigation: {
                onCommitted,
                onDOMContentLoaded,
                onCompleted,
                onHistoryStateUpdated,
                onReferenceFragmentUpdated,
            },
        },
    });
    try {
        const handler = new NavigationHandler({
            getPending: () => undefined,
            isPendingUncertain: () => false,
        });
        await assert.rejects(
            () =>
                handler.runNavigationAction(7, 'load', Date.now() + 1000, async () => {
                    onCommitted.emit({ tabId: 7, frameId: 0, documentId: 'current-document' });
                    onCompleted.emit({ tabId: 7, frameId: 0, documentId: 'current-document' });
                    throw new Error('reload failed');
                }),
            /reload failed/
        );
    } finally {
        restore();
    }
});

test('C09 and C10 keep Challenge state on the main frame and finalize requests at body completion', () => {
    const originalSetInterval = globalThis.setInterval;
    globalThis.setInterval = () => 0;
    const manager = new LogManager();
    globalThis.setInterval = originalSetInterval;

    manager.setMainFrameId(1, 'main-frame');
    manager.handleEvent(1, 'Network.requestWillBeSent', {
        requestId: 'main-challenge',
        request: { url: 'https://example.com', method: 'GET' },
        type: 'Document',
        frameId: 'main-frame',
        timestamp: 1,
        wallTime: 10,
    });
    manager.handleEvent(1, 'Network.responseReceived', {
        requestId: 'main-challenge',
        response: { status: 200, headers: { 'cf-mitigated': 'challenge' } },
        timestamp: 1.1,
    });
    assert.equal(manager.isChallengeRequired(1), true);
    assert.equal(manager.getPending(1).size, 1);
    assert.equal(manager.getNetwork(1).length, 0);

    manager.handleEvent(1, 'Network.requestWillBeSent', {
        requestId: 'child-normal',
        request: { url: 'https://example.com/frame', method: 'GET' },
        type: 'Document',
        frameId: 'child-frame',
        timestamp: 2,
        wallTime: 11,
    });
    manager.handleEvent(1, 'Network.responseReceived', {
        requestId: 'child-normal',
        response: { status: 204, headers: {} },
        timestamp: 2.1,
    });
    assert.equal(manager.isChallengeRequired(1), true);

    manager.handleEvent(1, 'Network.loadingFailed', {
        requestId: 'main-challenge',
        timestamp: 1.4,
        errorText: 'net::ERR_CONTENT_LENGTH_MISMATCH',
    });
    assert.deepEqual(manager.getNetwork(1)[0], {
        sequence: 1,
        url: 'https://example.com',
        method: 'GET',
        type: 'Document',
        timestamp: 10000,
        status: 200,
        challenge: true,
        errorText: 'net::ERR_CONTENT_LENGTH_MISMATCH',
        duration: 400,
    });
    assert.equal(manager.getPending(1).size, 1);

    manager.handleEvent(1, 'Network.loadingFinished', { requestId: 'child-normal', timestamp: 2.5 });
    assert.equal(manager.getPending(1), undefined);

    manager.handleEvent(1, 'Network.requestWillBeSent', {
        requestId: 'main-normal',
        request: { url: 'https://example.com/home', method: 'GET' },
        type: 'Document',
        frameId: 'main-frame',
        timestamp: 3,
        wallTime: 12,
    });
    manager.handleEvent(1, 'Network.responseReceived', {
        requestId: 'main-normal',
        response: { status: 200, headers: {} },
        timestamp: 3.1,
    });
    assert.equal(manager.isChallengeRequired(1), false);
});

test('C11 actionable clicks use DOM dispatch without invoking React private handlers', () => {
    let reactCalls = 0;
    const events = [];
    const element = {
        __reactProps$test: { onClick: () => reactCalls++ },
        getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 40 }),
        focus() {},
        dispatchEvent(event) {
            events.push(event.type);
            return true;
        },
    };
    class FakeMouseEvent {
        constructor(type) {
            this.type = type;
        }
    }
    const pageWindow = {
        __mcpElementMap: { target: new WeakRef(element) },
        __mcpActionability: {
            check: () => ({ actionable: true }),
            scrollIntoViewWithRetry: () => ({ actionable: true }),
        },
    };
    const restore = installGlobals({ window: pageWindow, MouseEvent: FakeMouseEvent });
    try {
        assert.deepEqual(performActionableClick('target', false), { success: true });
        assert.deepEqual(events, ['mousedown', 'mouseup', 'click']);
        assert.equal(reactCalls, 0);
        assert.equal(element.__reactProps$test.onClick instanceof Function, true);
    } finally {
        restore();
    }
});

test('C12 cookie clear counts only confirmed removals', async () => {
    const outcomes = [{ name: 'removed' }, undefined, null];
    const restore = installGlobals({
        chrome: {
            cookies: {
                async getAll() {
                    return [
                        { name: 'a', secure: true, domain: '.example.com', path: '/' },
                        { name: 'b', secure: false, domain: 'example.com', path: '/' },
                        { name: 'c', secure: false, domain: 'example.com', path: '/' },
                        { name: 'd', secure: false, domain: 'example.com', path: '/' },
                    ];
                },
                async remove() {
                    if (outcomes.length > 0) {
                        return outcomes.shift();
                    }
                    throw new Error('already gone');
                },
            },
        },
    });
    try {
        assert.deepEqual(await new CookieHandler().cookiesClear({ domain: 'example.com' }), {
            success: true,
            count: 1,
        });
    } finally {
        restore();
    }
});
