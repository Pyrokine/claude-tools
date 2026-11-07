import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { InputEventHandler } from '../src/background/input-event-handler.ts';
import { StealthHandler } from '../src/background/stealth-handler.ts';
import { markManagedTab, unmarkManagedTab } from '../src/background/tab-state.ts';
import { ExpectedOperationError } from '../src/types/expected-errors.ts';
import { InputMouseSchema } from '../src/types/schemas.ts';

function wheelDocument() {
    const events = [];
    const scrolls = [];
    const hits = [];
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
        document: {
            documentElement: root,
            elementFromPoint: (x, y) => {
                hits.push([x, y]);
                return element;
            },
        },
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
        scrollBy: ({ left: x, top: y }) => scrolls.push([x, y]),
    });
    realm.window = realm;
    return { realm, events, scrolls, hits };
}

async function withWheel(action, options = {}) {
    const tab = { id: 53103, active: false, url: 'https://example.com/c31-wheel' };
    const documents = { 'document-a': wheelDocument(), 'document-b': wheelDocument() };
    const injections = [];
    const frameQueries = [];
    const fixture = {
        tab,
        documents,
        injections,
        frameQueries,
        currentDocumentId: 'document-a',
        context: { mcpTabGroupId: null, mcpWindowId: null },
        ...options,
    };
    const values = {};
    const storage = {
        get: async () => ({ ...values }),
        set: async (update) => Object.assign(values, update),
        remove: async (key) => delete values[key],
    };
    const previous = globalThis.chrome;
    globalThis.chrome = {
        storage: { local: storage, session: storage },
        tabs: { get: async () => tab, query: async () => [tab] },
        webNavigation: {
            getFrame: async ({ frameId }) => {
                if (frameId === 0) {
                    return { frameId: 0, documentId: 'top-document' };
                }
                assert.equal(frameId, 17);
                frameQueries.push(frameId);
                if (fixture.frameError) {
                    throw fixture.frameError;
                }
                return fixture.currentDocumentId
                    ? { frameId, documentId: fixture.omitNativeDocumentId ? undefined : fixture.currentDocumentId }
                    : null;
            },
        },
        scripting: {
            executeScript: async (request) => {
                const phase = request.args ? 'action' : 'helper';
                injections.push({ phase, target: globalThis.structuredClone(request.target), args: request.args });
                await fixture.beforeInjection?.(phase);
                const documentId = request.target.documentIds?.[0] ?? fixture.currentDocumentId;
                if (!documentId || documentId !== fixture.currentDocumentId) {
                    throw Error(`No document with id ${documentId} in tab with id ${tab.id}`);
                }
                if (fixture.rejectPhase === phase && !fixture.rejectAfterExecution) {
                    throw Error('Script transport failed');
                }
                const document = documents[documentId];
                const result = vm.runInContext(`(${request.func.toString()})`, document.realm)(...(request.args ?? []));
                await fixture.afterInjection?.(phase);
                if (fixture.rejectPhase === phase) {
                    throw Error('Execution context was destroyed after dispatch');
                }
                if (fixture.emptyResultPhase === phase) {
                    return [];
                }
                return [{ frameId: 17, documentId, result }];
            },
        },
    };
    try {
        await markManagedTab(tab.id);
        const handler = new InputEventHandler({
            ensureAttached: () => assert.equal(fixture.allowNative, true, 'Wheel must use scripting'),
        });
        fixture.handler = handler;
        fixture.input = (overrides = {}) =>
            handler.inputMouse(
                {
                    tabId: tab.id,
                    frameId: 17,
                    documentId: 'document-a',
                    type: 'mouseWheel',
                    x: 40,
                    y: 30,
                    deltaX: 5,
                    deltaY: 25,
                    ...overrides,
                },
                fixture.context
            );
        await action(fixture);
    } finally {
        await unmarkManagedTab(tab.id);
        globalThis.chrome = previous;
    }
}

function failureState(error, status) {
    assert.ok(error instanceof ExpectedOperationError);
    const payload = JSON.parse(error.message).error;
    assert.equal(payload.context.actionStatus, status);
    assert.equal(payload.context.actionExecuted, status === 'not_started' ? false : 'unknown');
    assert.equal(error.actionExecuted, status === 'not_started' ? false : undefined);
    assert.equal(payload.context.retryable, false);
    return true;
}

function assertCounts(fixture, oldCount, newCount = 0) {
    for (const [id, count] of [
        ['document-a', oldCount],
        ['document-b', newCount],
    ]) {
        assert.equal(fixture.documents[id].events.length, count, `${id} wheel count`);
        assert.equal(fixture.documents[id].scrolls.length, count, `${id} scroll count`);
    }
}

test('C31-03 mouse schema retains optional document identity and validates it', () => {
    const params = { type: 'mouseWheel', x: 40, y: 30, frameId: 17 };
    assert.equal(InputMouseSchema.parse({ ...params, documentId: 'document-a' }).documentId, 'document-a');
    assert.equal(InputMouseSchema.parse(params).documentId, undefined);
    assert.equal(InputMouseSchema.safeParse({ ...params, documentId: '' }).success, false);
});

test('C31-03 unchanged document gets one wheel and scroll with iframe-local coordinates', async () => {
    await withWheel(async (fixture) => {
        assert.equal((await fixture.input()).success, true);
        assertCounts(fixture, 1);
        assert.deepEqual(fixture.documents['document-a'].hits, [[40, 30]]);
        assert.deepEqual(fixture.documents['document-a'].scrolls, [[5, 25]]);
        assert.deepEqual(fixture.frameQueries, [17]);
        assert.equal(fixture.injections.length, 2);
        for (const { target } of fixture.injections) {
            assert.deepEqual(target, { tabId: fixture.tab.id, documentIds: ['document-a'] });
        }
        const event = fixture.documents['document-a'].events[0];
        assert.equal(event.type, 'wheel');
        assert.equal(event.clientX, 40);
        assert.equal(event.clientY, 30);
    });
});

for (const navigation of ['before-handler', 'before-helper', 'after-helper', 'before-action']) {
    test(`C31-03 navigation ${navigation} never wheels the replacement document`, async () => {
        await withWheel(async (fixture) => {
            if (navigation === 'before-handler') {
                fixture.currentDocumentId = 'document-b';
            }
            fixture.beforeInjection = (phase) => {
                if (
                    (navigation === 'before-helper' && phase === 'helper') ||
                    (navigation === 'before-action' && phase === 'action')
                ) {
                    fixture.currentDocumentId = 'document-b';
                }
            };
            fixture.afterInjection = (phase) => {
                if (navigation === 'after-helper' && phase === 'helper') {
                    fixture.currentDocumentId = 'document-b';
                }
            };
            await assert.rejects(fixture.input(), (error) => failureState(error, 'not_started'));
            assertCounts(fixture, 0);
            assert.equal(
                fixture.injections.length,
                navigation === 'before-handler' ? 0 : navigation === 'before-helper' ? 1 : 2
            );
            for (const { target } of fixture.injections) {
                assert.deepEqual(target, { tabId: fixture.tab.id, documentIds: ['document-a'] });
            }
        });
    });
}

for (const removal of ['before-handler', 'after-helper', 'getFrame-rejected']) {
    test(`C31-03 removed frame ${removal} reports no dispatch`, async () => {
        await withWheel(async (fixture) => {
            if (removal === 'before-handler') {
                fixture.currentDocumentId = null;
            } else if (removal === 'getFrame-rejected') {
                fixture.frameError = Error('No frame with id 17');
            } else {
                fixture.afterInjection = () => {
                    fixture.currentDocumentId = null;
                };
            }
            await assert.rejects(fixture.input(), (error) => failureState(error, 'not_started'));
            assertCounts(fixture, 0);
        });
    });
}

test('C31-03 legacy calls capture the current document and retain frame-only API compatibility', async () => {
    for (const omitNativeDocumentId of [false, true]) {
        await withWheel(
            async (fixture) => {
                assert.equal((await fixture.input({ documentId: undefined })).success, true);
                assertCounts(fixture, 1);
                const expected = omitNativeDocumentId
                    ? { tabId: fixture.tab.id, frameIds: [17] }
                    : { tabId: fixture.tab.id, documentIds: ['document-a'] };
                for (const { target } of fixture.injections) {
                    assert.deepEqual(target, expected);
                }
            },
            { omitNativeDocumentId }
        );
    }
});

test('C31-03 helper rejection or missing helper result remains not_started with zero wheel', async () => {
    for (const options of [{ rejectPhase: 'helper' }, { emptyResultPhase: 'helper' }]) {
        await withWheel(async (fixture) => {
            await assert.rejects(fixture.input(), (error) => failureState(error, 'not_started'));
            assertCounts(fixture, 0);
            assert.equal(fixture.injections.length, 1);
        }, options);
    }
});

test('C31-03 ambiguous action rejection or missing result stays unknown before and after effects', async () => {
    for (const options of [
        { rejectPhase: 'action' },
        { rejectPhase: 'action', rejectAfterExecution: true },
        { emptyResultPhase: 'action' },
    ]) {
        await withWheel(async (fixture) => {
            await assert.rejects(fixture.input(), (error) => failureState(error, 'unknown'));
            assertCounts(fixture, options.rejectAfterExecution || options.emptyResultPhase ? 1 : 0);
            assert.equal(fixture.injections.length, 2);
        }, options);
    }
});

for (const input of ['native-key', 'native-mouse', 'stealth-key']) {
    for (const scenario of ['ack-after-deadline', 'expired-before-dispatch', 'ack-rejected']) {
        test(`C31F6 ${input} ${scenario} preserves native acknowledgement facts`, async () => {
            await withWheel(async (fixture) => {
                fixture.allowNative = true;
                fixture.tab.active = true;
                const originalNow = Date.now;
                let now = 1000;
                let calls = 0;
                const acknowledge = async () => {
                    ++calls;
                    now = 1020;
                    if (scenario === 'ack-rejected') {
                        throw new Error('Native acknowledgement lost');
                    }
                    return { success: true };
                };
                globalThis.chrome.debugger = { sendCommand: acknowledge };
                if (input === 'stealth-key') {
                    globalThis.chrome.scripting.executeScript = async (request) =>
                        request.args ? [{ result: await acknowledge() }] : [{ result: undefined }];
                }
                const params = { tabId: fixture.tab.id, deadline: scenario === 'expired-before-dispatch' ? 999 : 1010 };
                const dispatch = () =>
                    input === 'native-key'
                        ? fixture.handler.inputKey({ ...params, type: 'keyDown', key: 'Shift' }, fixture.context)
                        : input === 'native-mouse'
                          ? fixture.handler.inputMouse({ ...params, type: 'mouseMoved', x: 40, y: 30 }, fixture.context)
                          : new StealthHandler().stealthKey({ ...params, key: 'Shift', type: 'down' }, fixture.context);
                Date.now = () => now;
                try {
                    if (scenario === 'expired-before-dispatch') {
                        await assert.rejects(dispatch(), /TIMEOUT/);
                        assert.equal(calls, 0);
                    } else if (scenario === 'ack-rejected') {
                        await assert.rejects(dispatch(), /Native acknowledgement lost/);
                        assert.equal(calls, 1);
                    } else {
                        assert.equal((await dispatch()).success, true);
                        await assert.rejects(dispatch(), /TIMEOUT/);
                        assert.equal(calls, 1, 'Next expired action must not dispatch');
                    }
                } finally {
                    Date.now = originalNow;
                }
            });
        });
    }
}

for (const axis of ['x', 'y']) {
    for (const policy of ['auto', 'contain', 'none']) {
        for (const change of ['inside-to-end', 'end-to-inside', 'removed-content', 'cancelled-resize']) {
            test(`C31 wheel ${axis}/${policy} retains its starting route after ${change}`, async () => {
                await withWheel(async (fixture) => {
                    const document = fixture.documents['document-a'];
                    const { realm } = document;
                    const node = realm.document.elementFromPoint(40, 30);
                    const root = realm.document.documentElement;
                    Object.assign(root, {
                        scrollWidth: 2000,
                        scrollHeight: 2000,
                        clientWidth: 1000,
                        clientHeight: 1000,
                    });
                    realm.scrollX = 0;
                    realm.scrollY = 0;
                    realm.scrollBy = ({ left, top }) => {
                        realm.scrollX += left;
                        realm.scrollY += top;
                    };
                    const style = realm.getComputedStyle;
                    realm.getComputedStyle = (element) => ({
                        ...style(element),
                        ...(element === node ? { overscrollBehaviorX: policy, overscrollBehaviorY: policy } : {}),
                    });
                    const position = axis === 'x' ? 'scrollLeft' : 'scrollTop';
                    const size = axis === 'x' ? 'scrollWidth' : 'scrollHeight';
                    const client = axis === 'x' ? 'clientWidth' : 'clientHeight';
                    node[position] = change === 'end-to-inside' ? 900 : 400;
                    node.scrollBy = ({ left, top, behavior }) => {
                        assert.equal(behavior, 'instant');
                        node.scrollLeft = Math.max(
                            0,
                            Math.min(node.scrollLeft + left, node.scrollWidth - node.clientWidth)
                        );
                        node.scrollTop = Math.max(
                            0,
                            Math.min(node.scrollTop + top, node.scrollHeight - node.clientHeight)
                        );
                    };
                    node.dispatchEvent = (event) => {
                        document.events.push(event);
                        node[size] = change === 'removed-content' ? node[client] : 900;
                        node[position] = change === 'removed-content' ? 0 : change === 'end-to-inside' ? 400 : 800;
                        return change !== 'cancelled-resize';
                    };
                    await fixture.input({ deltaX: axis === 'x' ? 120 : 0, deltaY: axis === 'y' ? 120 : 0 });
                    assert.equal(document.events.length, 1);
                    assert.equal(
                        node[position],
                        change === 'removed-content' ? 0 : change === 'end-to-inside' ? 400 : 800
                    );
                    const propagated =
                        policy === 'auto' && ['end-to-inside', 'removed-content'].includes(change) ? 120 : 0;
                    assert.deepEqual([realm.scrollX, realm.scrollY], axis === 'x' ? [propagated, 0] : [0, propagated]);
                });
            });
        }
    }
}

test('C31-03 abort and original deadline after helper prevent the wheel injection', async () => {
    for (const cancellation of ['signal', 'deadline']) {
        await withWheel(async (fixture) => {
            const controller = new AbortController();
            fixture.context.signal = controller.signal;
            fixture.afterInjection = () => {
                if (cancellation === 'signal') {
                    controller.abort();
                } else {
                    fixture.context.deadline = Date.now() - 1;
                }
            };
            await assert.rejects(fixture.input(), (error) => failureState(error, 'not_started'));
            assertCounts(fixture, 0);
            assert.equal(fixture.injections.length, 1);
        });
    }
});
