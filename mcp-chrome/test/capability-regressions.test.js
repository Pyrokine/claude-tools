import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { installDomHelpers } from '../dist/core/dom-helpers.js';
import { getUnifiedSession } from '../dist/core/unified-session.js';
import { registerManageTool } from '../dist/tools/manage.js';
import { registerLogsTool } from '../dist/tools/logs.js';
import {
    CHALLENGE_INSPECT_SCRIPT,
    ChallengeTimeoutError,
    challengeResultFields,
    classifyChallengeSnapshot,
    waitForChallenge,
} from '../dist/tools/challenge.js';
import { targetToFindParams } from '../dist/tools/schema.js';

function challengeFixture({
    values = [''],
    forms = [null],
    outside = false,
    expired,
    expiryError = false,
    hidden = false,
} = {}) {
    const root = {};
    const rect = { left: 10, top: 20, width: 300, height: 65 };
    const widgets = values.map((_, index) => ({
        tagName: 'DIV',
        parentElement: root,
        hidden,
        getBoundingClientRect: () => rect,
        getAttribute: () => null,
        closest: () => forms[index] ?? null,
        scrollIntoView() {},
    }));
    const inputs = values.map((value, index) => ({
        tagName: 'INPUT',
        value,
        parentElement: outside ? root : widgets[index],
        form: forms[index] ?? null,
    }));
    const snapshot = vm.runInNewContext(CHALLENGE_INSPECT_SCRIPT, {
        document: {
            title: 'Checkout',
            body: { innerText: 'Checkout' },
            documentElement: root,
            querySelectorAll: (selector) =>
                selector === '.cf-turnstile'
                    ? widgets
                    : selector === 'input[name="cf-turnstile-response"]'
                      ? inputs
                      : [],
        },
        window: {
            getComputedStyle: (element) => ({
                display: element.hidden ? 'none' : 'block',
                visibility: 'visible',
                opacity: '1',
            }),
            ...(expired !== undefined || expiryError
                ? {
                      turnstile: {
                          isExpired: () => {
                              if (expiryError) {
                                  throw new Error('state unavailable');
                              }
                              return expired;
                          },
                      },
                  }
                : {}),
        },
        location: { href: 'https://example.com/checkout' },
    });
    return snapshot;
}

test('CF completed response suppresses only its own visible widget and returns no response value', () => {
    const completed = challengeFixture({ values: ['synthetic-response'] });
    assert.equal(completed.turnstileState, 'completed');
    assert.equal(classifyChallengeSnapshot(completed), 'none');
    assert.equal(completed.clickPoint, null);
    assert.equal(JSON.stringify(completed).includes('synthetic-response'), false);
    assert.equal(challengeFixture({ values: [''] }).turnstileState, 'pending');
    assert.equal(challengeFixture({ values: ['synthetic-response', ''] }).turnstileState, 'pending');
    assert.equal(challengeFixture({ values: ['synthetic-response'], expired: true }).turnstileState, 'expired');
    assert.equal(challengeFixture({ values: ['synthetic-response'], expiryError: true }).turnstileState, 'pending');
    assert.equal(challengeFixture({ hidden: true }).turnstileState, 'none');
});

test('CF external response association requires the same form and a unique widget', () => {
    const form = {};
    assert.equal(challengeFixture({ values: ['synthetic-response'], outside: true }).turnstileState, 'pending');
    assert.equal(
        challengeFixture({ values: ['synthetic-response'], outside: true, forms: [form] }).turnstileState,
        'completed'
    );
    assert.equal(
        challengeFixture({ values: ['synthetic-response', ''], outside: true, forms: [form, form] }).turnstileState,
        'pending'
    );
});

function challengeHost(overrides = {}) {
    return {
        getMode: () => 'extension',
        getState: () => ({ title: 'Checkout', url: 'https://example.com/checkout' }),
        getChallengeState: async () => null,
        inspectChallenge: async () => ({ title: 'Checkout', inspected: true }),
        getCookies: async () => [],
        mouseMove: async () => {},
        mouseClick: async () => {},
        ...overrides,
    };
}

test('CF releases observers once on current pending evidence and returns the actual suspension state', async () => {
    let time = 0;
    let inspections = 0;
    let suspensions = 0;
    const result = await waitForChallenge(
        challengeHost({
            inspectChallenge: async () => ({ title: 'Checkout', turnstilePresent: ++inspections < 3, inspected: true }),
            suspendBrowserEventsForChallenge: async () => {
                ++suspensions;
                return { suspended: true, fetchEnabled: false, cleanupFailures: [] };
            },
        }),
        {
            action: 'input',
            actionStatus: 'completed',
            timeout: 1500,
            now: () => time,
            sleep: async (ms) => {
                time += ms;
            },
        }
    );
    assert.equal(suspensions, 1);
    assert.equal(result.challengeKind, 'turnstile');
    assert.equal(challengeResultFields(result).browserEvents.fetchEnabled, false);
});

test('post-action CF timeout advises verification without replay in both backends', () => {
    for (const mode of ['extension', 'cdp']) {
        const completed = new ChallengeTimeoutError('evaluate', 'completed', 100, 'js', mode).toJSON();
        assert.equal(completed.actionExecuted, true);
        assert.equal(completed.retryable, false);
        assert.equal(completed.nextAction, 'wait_and_verify');
        assert.ok(completed.error.suggestion.includes('原动作已执行'));
        const notStarted = new ChallengeTimeoutError('evaluate', 'not_started', 100, 'js', mode).toJSON();
        assert.equal(notStarted.actionExecuted, false);
        assert.equal(notStarted.retryable, true);
        assert.equal(notStarted.nextAction, 'retry_with_longer_timeout');
    }
});

test('CF old challenge headers on an inspected ordinary page preserve active observers', async () => {
    let suspensions = 0;
    const result = await waitForChallenge(
        challengeHost({
            getChallengeState: async () => ({ state: 'pending', mode: 'extension' }),
            suspendBrowserEventsForChallenge: async () => {
                ++suspensions;
                return { suspended: true };
            },
        }),
        { action: 'evaluate', timeout: 100 }
    );
    assert.equal(result.challengeKind, 'none');
    assert.equal(suspensions, 0);
});

test('CF cleanup failure keeps the completed action and blocks further verification', async () => {
    let clicks = 0;
    const host = challengeHost({
        inspectChallenge: async () => ({
            title: 'Checkout',
            turnstilePresent: true,
            inspected: true,
            clickPoint: { x: 1, y: 2 },
        }),
        suspendBrowserEventsForChallenge: async () => ({
            suspended: false,
            fetchEnabled: true,
            cleanupFailures: ['original failure'],
        }),
        mouseClick: async () => {
            ++clicks;
        },
    });
    await assert.rejects(
        waitForChallenge(host, { action: 'input', actionStatus: 'completed', timeout: 100 }),
        (error) => {
            assert.equal(error.code, 'CHALLENGE_OBSERVATION_CLEANUP_FAILED');
            assert.equal(error.context.actionExecuted, true);
            assert.equal(error.context.actionStatus, 'completed');
            assert.equal(error.context.browserEvents.fetchEnabled, true);
            return true;
        }
    );
    assert.equal(clicks, 0);
});

test('CF pending dialog is read without a Runtime probe or automatic acceptance', async () => {
    let inspections = 0;
    const host = challengeHost({
        hasBrowserEventObservation: () => true,
        browserEvents: async () => ({ logs: [{ ref: 'observed-dialog', state: 'pending' }] }),
        inspectChallenge: async () => {
            ++inspections;
            throw new Error('Runtime must not be called');
        },
    });
    await assert.rejects(
        waitForChallenge(host, { action: 'input', actionStatus: 'completed', timeout: 100 }),
        (error) => {
            assert.equal(error.code, 'DIALOG_OPEN');
            assert.equal(error.context.ref, 'observed-dialog');
            assert.equal(error.context.actionExecuted, true);
            return true;
        }
    );
    assert.equal(inspections, 0);
});

function domFixture() {
    const text = (value) => ({ nodeType: 3, textContent: value, childNodes: [] });
    function element(tag, attrs = {}, children = []) {
        const node = {
            nodeType: 1,
            tagName: tag.toUpperCase(),
            childNodes: children,
            parentNode: null,
            parentElement: null,
            getAttribute: (name) => attrs[name] ?? null,
            hasAttribute: (name) => name in attrs,
            getRootNode() {
                let root = node;
                while (root.parentNode) {
                    root = root.parentNode;
                }
                return root;
            },
            matches(selector) {
                return selector
                    .split(',')
                    .some((part) => part.trim() === '*' || part.trim() === tag || part.trim() === `#${attrs.id}`);
            },
            querySelector(selector) {
                return walk(this).find((candidate) => candidate.matches(selector)) ?? null;
            },
        };
        Object.defineProperty(node, 'textContent', { get: () => children.map((child) => child.textContent).join('') });
        for (const child of children) {
            child.parentNode = node;
            child.parentElement = node;
        }
        return node;
    }
    function walk(root) {
        return root.childNodes.flatMap((child) => (child.nodeType === 1 ? [child, ...walk(child)] : []));
    }
    function root(children, host) {
        const node = {
            nodeType: host ? 11 : 9,
            childNodes: children,
            host,
            querySelector: (selector) => walk(node).find((candidate) => candidate.matches(selector)) ?? null,
            getElementById: (id) => walk(node).find((candidate) => candidate.getAttribute('id') === id) ?? null,
        };
        for (const child of children) {
            child.parentNode = node;
            child.parentElement = null;
        }
        return node;
    }
    const first = element('span', { id: 'first', hidden: '' }, [text('保存')]);
    const second = element('span', { id: 'second' }, [text('文件')]);
    const button = element('button', { 'aria-labelledby': 'first second', 'aria-label': 'wrong' }, [text('unused')]);
    const label = element('label', {}, [text('上传资料')]);
    const file = element('input', { hidden: '' });
    file.type = 'file';
    file.labels = [label];
    const shadowButton = element('button', { 'aria-labelledby': 'first' }, [text('unused')]);
    const host = element('div');
    host.shadowRoot = root([element('span', { id: 'first', hidden: '' }, [text('Shadow')]), shadowButton], host);
    const nestedText = element('button', {}, [element('span', {}, [text('保'), element('b', {}, [text('存')])])]);
    const document = root([first, second, button, label, file, host, nestedText]);
    document.activeElement = host;
    document.elementFromPoint = () => host;
    host.shadowRoot.activeElement = shadowButton;
    host.shadowRoot.elementFromPoint = () => shadowButton;
    const realm = vm.createContext({
        document,
        window: {
            getComputedStyle: (node) => ({
                display: node.hasAttribute('hidden') ? 'none' : 'block',
                visibility: 'visible',
            }),
        },
    });
    vm.runInContext(`(${installDomHelpers.toString()})()`, realm);
    return { helpers: realm.__mcpDomHelpers, button, shadowButton, nestedText, file, element, text };
}

test('shared DOM query uses referenced hidden labels, tree-local IDs, nested text and Shadow hit/focus', () => {
    const { helpers, button, shadowButton, nestedText, file } = domFixture();
    assert.equal(helpers.accessibleName(button), '保存 文件');
    assert.equal(helpers.accessibleName(shadowButton), 'Shadow');
    assert.equal(helpers.accessibleName(nestedText), '保存');
    const role = targetToFindParams({ role: 'button', name: 'Shadow', exact: true });
    const matches = helpers.query({ selector: 'button', semantic: role.semantic });
    assert.equal(matches.length, 1);
    assert.equal(matches[0], shadowButton);
    assert.equal(helpers.query({ selector: 'input', semantic: { label: '上传资料', exact: true } })[0], file);
    assert.equal(helpers.activeElement(), shadowButton);
    assert.equal(helpers.deepElementFromPoint(10, 10), shadowButton);
});

test('I048 role targets use nested contents for tabs and other content-named roles', () => {
    const { helpers, element, text } = domFixture();
    for (const role of [
        'tab',
        'checkbox',
        'radio',
        'switch',
        'menuitem',
        'menuitemcheckbox',
        'menuitemradio',
        'treeitem',
        'cell',
        'columnheader',
        'gridcell',
        'row',
        'rowheader',
        'tooltip',
    ]) {
        const target = element('div', { role, id: 'react-tabs-2' }, [
            element('span', {}, [text('编译'), element('b', { hidden: '' }, [text('隐藏')])]),
        ]);
        const root = element('div', {}, [target]);
        const query = targetToFindParams({ role, name: '编', exact: false });
        assert.equal(helpers.accessibleName(target), '编译', role);
        assert.equal(helpers.query({ selector: '*', semantic: query.semantic }, root)[0], target, role);
        assert.equal(helpers.query({ selector: '*', semantic: { ...query.semantic, exact: true } }, root).length, 0);
        const named = element('div', { role, 'aria-label': '明确名称' }, [text('编译')]);
        assert.equal(helpers.accessibleName(named), '明确名称', role);
    }
});

test('I004 combined CSS and exact text keep positive and negative scores separate', () => {
    const { helpers, element, text } = domFixture();
    const negative = element('button', {}, [element('span', {}, [text('-2')])]);
    const positive = element('button', {}, [element('span', {}, [text(' 2 ')])]);
    const root = element('div', {}, [negative, positive]);
    const query = targetToFindParams({ css: 'button', text: '2', exact: true });
    assert.deepEqual(Array.from(helpers.query(query, root)), [positive]);
    assert.deepEqual(Array.from(helpers.query({ ...query, semantic: { exact: false } }, root)), [negative, positive]);
});

test('shared accessible name handles 6000 nested spans without reading field values', () => {
    const { helpers, element, text } = domFixture();
    let nested = text('保存');
    for (let depth = 0; depth < 6000; ++depth) {
        nested = element('span', {}, [nested]);
    }
    assert.equal(helpers.accessibleName(element('button', {}, [nested])), '保存');
    const hidden = element('input', { hidden: '', 'aria-label': 'Hidden metadata' });
    hidden.type = 'password';
    Object.defineProperty(hidden, 'value', { get: () => assert.fail('password value must not be read') });
    assert.equal(helpers.accessibleName(hidden), '');
    assert.equal(helpers.accessibleName(hidden, true), 'Hidden metadata');
});

test('public event, body and raw Fetch handlers carry MCP cancellation to the backend request scope', async () => {
    const unified = getUnifiedSession();
    const properties = new Map(
        ['extensionBridge', 'getMode'].map((key) => [key, Object.getOwnPropertyDescriptor(unified, key)])
    );
    let calls = 0;
    let effectiveSignal;
    const pending = () => {
        ++calls;
        const scope = unified.tabLockContext.getStore();
        effectiveSignal = scope.signal;
        assert.ok(scope.deadline > Date.now());
        return new Promise((_resolve, reject) => {
            effectiveSignal.addEventListener('abort', () => reject(effectiveSignal.reason), { once: true });
        });
    };
    unified.extensionBridge = { browserEvents: pending, browserFetchCommand: pending };
    unified.getMode = () => 'extension';
    const tools = new Map();
    const server = { registerTool: (name, options, handler) => tools.set(name, { options, handler }) };
    registerManageTool(server);
    registerLogsTool(server);
    try {
        for (const [name, args] of [
            ['manage', { action: 'download', download: { op: 'wait', ref: 'be:extension:101:owner:g:download:1' } }],
            ['logs', { type: 'network', view: 'responseBody', ref: 'be:extension:101:owner:g:request:1' }],
            [
                'manage',
                {
                    action: 'cdp',
                    targetId: '101',
                    cdpMethod: 'Fetch.continueRequest',
                    cdpParams: { requestId: 'original' },
                },
            ],
        ]) {
            const controller = new AbortController();
            const { options, handler } = tools.get(name);
            const response = handler(options.inputSchema.parse(args), { signal: controller.signal });
            assert.equal(effectiveSignal, controller.signal);
            controller.abort(new Error('synthetic MCP cancellation'));
            assert.equal((await response).isError, true);
        }
        const before = calls;
        const controller = new AbortController();
        controller.abort(new Error('cancelled before dispatch'));
        const { handler } = tools.get('manage');
        assert.equal(
            (
                await handler(
                    { action: 'dialog', targetId: '101', dialog: { op: 'watch' } },
                    { signal: controller.signal }
                )
            ).isError,
            true
        );
        assert.equal(calls, before);
    } finally {
        for (const [key, descriptor] of properties) {
            if (descriptor) {
                Object.defineProperty(unified, key, descriptor);
            } else {
                delete unified[key];
            }
        }
    }
});
