import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionHandler } from '../src/background/actions.ts';
import { TabHandler } from '../src/background/tab-handler.ts';
import { getManagedTabRecord, isManagedTab, markManagedTab, unmarkManagedTab } from '../src/background/tab-state.ts';
import { assertActionActive } from '../src/background/action-utils.ts';
import { readGrantDocumentId, setReadGrant } from '../src/background/read-grants.ts';
import { pageRevision } from '../src/background/page-revision.ts';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => delay(0);

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function fixture(run) {
    const previous = globalThis.chrome;
    const controller = new AbortController();
    const tabs = [101, 102].map((id, index) => ({
        id,
        index,
        windowId: 7,
        groupId: 17,
        url: 'https://example.com/synthetic',
        active: false,
    }));
    const group = { id: 17, windowId: 7, title: 'Synthetic', color: 'cyan', collapsed: false };
    const window = { id: 7, type: 'normal', focused: false, state: 'normal', tabs };
    const storage = {};
    const store = {
        get: async () => read('storage-get', globalThis.structuredClone(storage)),
        set: async (values) => {
            state.storageWrites.push(globalThis.structuredClone(values));
            Object.assign(storage, globalThis.structuredClone(values));
            await read('storage-set');
        },
        remove: async (key) => {
            delete storage[key];
        },
    };
    const state = {
        mutations: [],
        storageWrites: [],
        readHeld: deferred(),
        release: deferred(),
        hold: null,
        afterMutation: null,
    };
    const read = async (kind, value) => {
        if (state.hold === kind) {
            state.hold = null;
            state.readHeld.resolve();
            await state.release.promise;
        }
        return value;
    };
    const mutate = async (name, result) => {
        state.mutations.push({ name, aborted: controller.signal.aborted });
        state.afterMutation?.(name);
        return result;
    };
    globalThis.chrome = {
        storage: { local: store, session: store },
        tabs: {
            get: async (id) =>
                read(
                    'tab-get',
                    tabs.find((tab) => tab.id === id)
                ),
            query: async (query) =>
                read(
                    'tab-query',
                    query.groupId === undefined ? tabs : tabs.filter((tab) => tab.groupId === query.groupId)
                ),
            group: async () => mutate('tabs.group', 17),
            ungroup: async () => mutate('tabs.ungroup'),
            update: async (id, properties) =>
                mutate(
                    'tabs.update',
                    Object.assign(
                        tabs.find((tab) => tab.id === id),
                        properties
                    )
                ),
            move: async (id) =>
                mutate(
                    'tabs.move',
                    tabs.find((tab) => tab.id === id)
                ),
            remove: async () => mutate('tabs.remove'),
        },
        tabGroups: {
            get: async () => read('group-get', group),
            query: async () => read('group-query', [group]),
            update: async (_id, properties) => mutate('tabGroups.update', Object.assign(group, properties)),
            move: async () => mutate('tabGroups.move', group),
        },
        windows: {
            get: async () => read('window-get', window),
            update: async (_id, properties) => mutate('windows.update', Object.assign(window, properties)),
            remove: async () => mutate('windows.remove'),
        },
        webNavigation: { getFrame: async () => read('frame', { documentId: 'synthetic-document' }) },
    };
    try {
        for (const tab of tabs) {
            await markManagedTab(tab.id);
        }
        const native = new TabHandler({});
        const actions = Object.assign(Object.create(ActionHandler.prototype), {
            actionLocks: new Map(),
            tabHandler: native,
            actions: new Map([
                ['window_close', native.windowClose.bind(native)],
                ['window_update', native.windowUpdate.bind(native)],
                ['tabgroup_create', native.tabGroupCreate.bind(native)],
                ['tabgroup_remove', native.tabGroupRemove.bind(native)],
                ['tabgroup_update', native.tabGroupUpdate.bind(native)],
                ['tabgroup_move', native.tabGroupMove.bind(native)],
            ]),
        });
        const context = { signal: controller.signal, mcpTabGroupId: null, mcpWindowId: 7 };
        state.storageWrites.length = 0;
        await run({ state, actions, native, context, controller, tabs, window, storage });
    } finally {
        state.release.resolve();
        for (const tab of tabs) {
            await unmarkManagedTab(tab.id);
        }
        globalThis.chrome = previous;
    }
}

const cases = [
    ['window_close', { windowId: 7 }, 'window-get'],
    ['window_update', { windowId: 7, drawAttention: true }, 'window-get'],
    ['tabgroup_create', { tabIds: [101, 102], title: 'Changed' }, 'group-query'],
    ['tabgroup_remove', { tabIds: [101, 102] }, 'group-query'],
    ['tabgroup_update', { groupId: 17, title: 'Changed' }, 'group-get'],
    ['tabgroup_move', { groupId: 17, index: 0 }, 'group-query'],
];

for (const [action, params, hold] of cases) {
    for (const stop of ['cancel', 'deadline']) {
        test(
            `C31F3-02 production ${action} rechecks ${stop} after asynchronous native preflight`,
            { timeout: 10000 },
            async () => {
                await fixture(async ({ state, actions, context, controller }) => {
                    state.hold = hold;
                    const args = { ...params, ...(stop === 'deadline' ? { deadline: Date.now() + 100 } : {}) };
                    const operation = actions.execute(action, args, context);
                    const rejected = assert.rejects(operation, (error) => {
                        const detail = JSON.parse(error.message).error;
                        assert.equal(detail.code, stop === 'cancel' ? 'REQUEST_CANCELLED' : 'TIMEOUT');
                        assert.equal(detail.context.actionStatus, 'not_started');
                        assert.equal(detail.context.actionExecuted, false);
                        return true;
                    });
                    await state.readHeld.promise;
                    if (stop === 'cancel') {
                        controller.abort('stop while native read is held');
                    } else {
                        await delay(Math.max(0, args.deadline - Date.now()) + 1);
                    }
                    state.release.resolve();
                    await rejected;
                    assert.deepEqual(state.mutations, []);
                });
            }
        );
    }
    test(`C31F3-02 normal production ${action} completes its native change`, async () => {
        await fixture(async ({ state, actions, context }) => {
            const result = await actions.execute(action, params, context);
            assert.equal(result.success, true);
            assert.ok(state.mutations.length > 0);
            assert.ok(state.mutations.every((entry) => !entry.aborted));
        });
    });
}

test('C31F3-02 window_close rejects an already cancelled entry before any native read or change', async () => {
    await fixture(async ({ state, actions, context, controller }) => {
        controller.abort('cancel before entry');
        await assert.rejects(
            actions.execute('window_close', { windowId: 7 }, context),
            (error) => JSON.parse(error.message).error.context.actionStatus === 'not_started'
        );
        assert.deepEqual(state.mutations, []);
    });
});

test('C31F3-02 native window close still clears managed state when cancellation arrives with its ACK', async () => {
    await fixture(async ({ state, actions, context, controller, tabs }) => {
        state.afterMutation = (name) => {
            if (name === 'windows.remove') {
                controller.abort('cancel after native close');
            }
        };
        const result = await actions.execute('window_close', { windowId: 7 }, context);
        assert.equal(result.after, null);
        assert.equal(state.mutations.length, 1);
        assert.ok(tabs.every((tab) => !isManagedTab(tab)));
    });
});

test('C31F3-02 group creation records partial progress and stops title change after cancellation', async () => {
    await fixture(async ({ state, actions, context, controller }) => {
        state.afterMutation = (name) => {
            if (name === 'tabs.group') {
                controller.abort('stop after group exists');
            }
        };
        await assert.rejects(
            actions.execute('tabgroup_create', { tabIds: [101, 102], title: 'Changed' }, context),
            (error) => {
                const detail = JSON.parse(error.message).error;
                assert.equal(detail.context.actionStatus, 'partial');
                assert.equal(detail.context.actionExecuted, true);
                assert.equal(detail.context.groupId, 17);
                assert.equal(error.actionExecuted, undefined);
                return true;
            }
        );
        assert.deepEqual(
            state.mutations.map((entry) => entry.name),
            ['tabs.group']
        );
    });
});

test('C31F3-02 window restore records partial progress before cancelled bounds change', async () => {
    await fixture(async ({ state, actions, context, controller, window }) => {
        window.state = 'maximized';
        state.afterMutation = (name) => {
            if (name === 'windows.update') {
                controller.abort('stop after normal state');
            }
        };
        await assert.rejects(
            actions.execute('window_update', { windowId: 7, state: 'normal', width: 800 }, context),
            (error) => {
                assert.equal(JSON.parse(error.message).error.context.actionStatus, 'partial');
                return true;
            }
        );
        assert.deepEqual(
            state.mutations.map((entry) => entry.name),
            ['windows.update']
        );
        await tick();
    });
});

for (const operation of ['adopt', 'metadata', 'grant', 'revoke', 'refresh']) {
    for (const cancel of [false, true]) {
        test(`C31F4-01 ${operation} checks its internal read before storage commit; cancel=${cancel}`, async () => {
            await fixture(async ({ state, native, context, controller, tabs, storage }) => {
                tabs.push({ ...tabs[0], id: 103 });
                const instance = `c31f4-${operation}`;
                if (operation === 'revoke' || operation === 'refresh') {
                    await setReadGrant(instance, 103, true);
                }
                if (operation === 'refresh') {
                    storage[`mcp_read_grants_v4_${instance}`][0].revision = 'previous-generation:0';
                }
                const before = globalThis.structuredClone(storage);
                state.storageWrites.length = 0;
                const check = () => assertActionActive(context);
                const run = () => {
                    if (operation === 'adopt') {
                        return native.tabsAdopt({ tabId: 103 }, context);
                    }
                    if (operation === 'metadata') {
                        return native.tabsMetadata({ tabId: 103, note: 'synthetic note' }, context);
                    }
                    if (operation === 'refresh') {
                        return readGrantDocumentId(instance, 103, check);
                    }
                    return setReadGrant(instance, 103, operation === 'grant', undefined, check);
                };
                if (cancel) {
                    state.hold = operation === 'revoke' ? 'storage-get' : 'frame';
                    const pending = run();
                    const rejected = assert.rejects(
                        pending,
                        (error) => JSON.parse(error.message).error.code === 'REQUEST_CANCELLED'
                    );
                    await state.readHeld.promise;
                    controller.abort('stop internal identity read');
                    state.release.resolve();
                    await rejected;
                    assert.equal(state.storageWrites.length, 0);
                    assert.deepEqual(storage, before);
                    assert.equal(getManagedTabRecord(103), undefined);
                } else {
                    await run();
                    assert.equal(state.storageWrites.length, 1);
                    if (operation === 'refresh') {
                        assert.equal(storage[`mcp_read_grants_v4_${instance}`][0].revision, pageRevision(103));
                    }
                }
            });
        });
    }
}

test('C31F4-01 managed state still publishes in memory after cancellation during a dispatched storage set', async () => {
    await fixture(async ({ state, native, context, controller, tabs, storage }) => {
        tabs.push({ ...tabs[0], id: 103 });
        state.hold = 'storage-set';
        const pending = native.tabsAdopt({ tabId: 103 }, context);
        await state.readHeld.promise;
        controller.abort('storage has already committed');
        state.release.resolve();
        await pending;
        assert.equal(isManagedTab({ id: 103 }), true);
        assert.deepEqual(
            getManagedTabRecord(103),
            storage.mcp_managed_tabs_v1.tabs.find((tab) => tab.tabId === 103)
        );
    });
});
