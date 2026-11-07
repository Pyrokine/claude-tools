import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = process.env.MCP_EVENT_DIST ?? path.resolve(import.meta.dirname, '../dist');
const { getUnifiedSession } = await import(pathToFileURL(path.join(root, 'core/unified-session.js')));
const { getSession } = await import(pathToFileURL(path.join(root, 'core/session.js')));
const { ExtensionBridge } = await import(pathToFileURL(path.join(root, 'extension/bridge.js')));

function fakeExtension(overrides = {}) {
    return {
        isConnected: () => true,
        getCurrentTargetId: () => '101',
        getCurrentFrameId: () => 0,
        getCurrentFrameDocumentId: () => undefined,
        setCurrentFrameId(frameId, documentId) {
            assert.equal(frameId, 0);
            assert.equal(documentId, undefined);
        },
        ...overrides,
    };
}
async function usingExtension(bridge, action) {
    const session = getUnifiedSession();
    const before = {
        extensionBridge: session.extensionBridge,
        activeMode: session.activeMode,
        cdpExplicitlySelected: session.cdpExplicitlySelected,
        inputMode: session.inputMode,
        mouseFrameContext: session.mouseFrameContext,
        currentMousePosition: session.currentMousePosition,
    };
    Object.assign(session, {
        extensionBridge: bridge,
        activeMode: 'extension',
        cdpExplicitlySelected: false,
        inputMode: 'precise',
    });
    try {
        return await action(session);
    } finally {
        Object.assign(session, before);
    }
}

test('default precise single click checks actionability then sends native mouse input', async () => {
    const calls = [];
    await usingExtension(
        fakeExtension({
            checkActionability: async () => ({ success: true, clickPoint: { x: 21, y: 35 } }),
            actionableClick: async () => {
                throw Error('Synthetic click must not be used');
            },
            inputMouse: async (...args) => {
                calls.push(args);
            },
        }),
        (session) => session.actionableClick('owned-ref')
    );
    assert.deepEqual(
        calls.map((call) => call[0]),
        ['mousePressed', 'mouseReleased']
    );
    assert.deepEqual(calls[0].slice(1, 3), [21, 35]);
});

test('background default element click preserves synthetic operation with a visible warning', async () => {
    const native = [];
    const synthetic = [];
    await usingExtension(
        fakeExtension({
            checkActionability: async () => ({ success: true, clickPoint: { x: 1, y: 2 } }),
            inputMouse: async (type) => {
                native.push(type);
                if (type === 'mousePressed') {
                    throw Object.assign(new Error('inactive tab'), { code: 'NATIVE_INPUT_UNAVAILABLE' });
                }
            },
            actionableClick: async (...args) => {
                synthetic.push(args);
                return { success: true };
            },
        }),
        async (session) => {
            const result = await session.actionableClick('background-ref');
            assert.equal(result.success, true);
            assert.ok(result.warning.includes('合成'));
        }
    );
    assert.deepEqual(native, ['mousePressed', 'mouseReleased']);
    assert.deepEqual(synthetic, [['background-ref', false, undefined, 0]]);
});

test('precise click releases native mouse even when press acknowledgement fails', async () => {
    const calls = [];
    await usingExtension(
        fakeExtension({
            checkActionability: async () => ({ success: true, clickPoint: { x: 1, y: 2 } }),
            inputMouse: async (type) => {
                calls.push(type);
                if (type === 'mousePressed') {
                    throw Error('lost acknowledgement');
                }
            },
        }),
        (session) => assert.rejects(session.actionableClick('owned-ref'), /lost acknowledgement/)
    );
    assert.deepEqual(calls, ['mousePressed', 'mouseReleased']);
});

test('force and stealth retain their explicit synthetic click semantics', async () => {
    const calls = [];
    await usingExtension(
        fakeExtension({
            actionableClick: async (...args) => {
                calls.push(args);
                return { success: true };
            },
        }),
        async (session) => {
            await session.actionableClick('force-ref', true);
            session.inputMode = 'stealth';
            await session.actionableClick('stealth-ref');
        }
    );
    assert.deepEqual(calls, [
        ['force-ref', true, undefined, 0],
        ['stealth-ref', false, undefined, 0],
    ]);
});

test('explicit launch process options skip connected Extension; default launch reuses it', async () => {
    const cdp = getSession();
    const originals = { launch: cdp.launch, isConnected: cdp.isConnected };
    const cdpCalls = [];
    let connected = false;
    cdp.isConnected = () => connected;
    cdp.launch = async (options) => {
        cdpCalls.push(options);
        connected = true;
        return { targetId: 'owned-cdp', type: 'page', url: 'about:blank', title: '' };
    };
    let extensionCalls = 0;
    const extension = fakeExtension({
        newPage: async () => {
            extensionCalls++;
            return { targetId: '101', url: 'about:blank', title: '' };
        },
    });
    try {
        await usingExtension(extension, async (session) => {
            for (const options of [
                { headless: true },
                { headless: false },
                { incognito: true },
                { userDataDir: '/tmp/owned-profile' },
                { executablePath: '/tmp/owned-chrome' },
                { port: 12345 },
            ]) {
                connected = false;
                const target = await session.launch(options);
                assert.equal(target.mode, 'cdp');
            }
            assert.equal(extensionCalls, 0);
            assert.equal(cdpCalls.length, 6);
            connected = false;
            session.cdpExplicitlySelected = false;
            session.activeMode = 'extension';
            assert.equal((await session.launch()).mode, 'extension');
            assert.equal(extensionCalls, 1);
        });
    } finally {
        Object.assign(cdp, originals);
    }
});

test('CF cleanup with no event observation sends no new action to a legacy Extension', async () => {
    const bridge = new ExtensionBridge();
    bridge.setCurrentTargetId('101');
    bridge.httpServer.sendCommand = async () => {
        throw Error('Legacy Extension action must not be invoked');
    };
    const state = await bridge.suspendBrowserEventsForChallenge();
    assert.equal(state.suspended, true);
    assert.equal(state.fetchEnabled, false);
    assert.equal(bridge.hasBrowserEventObservation(), false);
});

test('deselect still clears unobserved attached state when native detach rejects', async () => {
    const session = getSession();
    const replacement = {
        cdp: {
            isConnected: true,
            send: async () => {
                throw Error('detach failed');
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
        selectedFrame: 0,
    };
    const before = Object.fromEntries(Object.keys(replacement).map((key) => [key, session[key]]));
    const logs = new Map(session.targetLogs);
    try {
        Object.assign(session, replacement);
        await assert.rejects(session.deselectPage(), /detach failed/);
        for (const key of ['sessionId', 'currentTargetId', 'state', 'mainFrameId', 'mainFrameLoaderId']) {
            assert.equal(session[key], null);
        }
        assert.equal(session.runtimeEnabled, false);
        assert.equal(session.challengeRequired, false);
        assert.equal(session.modifiers, 0);
    } finally {
        Object.assign(session, before);
        session.targetLogs = logs;
    }
});
