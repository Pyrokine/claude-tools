import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

let execScenario;
const nativeExecFile = childProcess.execFile;
const nativeExec = promisify(nativeExecFile);
function controlledExecFile(...args) {
    return nativeExecFile(...args);
}
controlledExecFile[promisify.custom] = (file, args, options) => {
    assert.ok(execScenario, `Unexpected system command: ${file}`);
    return execScenario(file, args, options);
};
childProcess.execFile = controlledExecFile;
syncBuiltinESMExports();
const { getUnifiedSession } = await import('../dist/core/unified-session.js');
const { ExtensionBridge } = await import('../dist/extension/bridge.js');
const { registerBrowseTool } = await import('../dist/tools/browse.js');
const { registerInputTool } = await import('../dist/tools/input.js');
childProcess.execFile = nativeExecFile;
syncBuiltinESMExports();

function patch(object, values) {
    const originals = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(object, key)]));
    Object.assign(object, values);
    return () => {
        for (const [key, value] of originals) {
            if (value) {
                Object.defineProperty(object, key, value);
            } else {
                Reflect.deleteProperty(object, key);
            }
        }
    };
}
function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
function publicTool(register) {
    let schema;
    let callback;
    register({
        registerTool(_name, options, handler) {
            schema = options.inputSchema;
            callback = handler;
        },
    });
    return async (args, signal) => {
        const response = await callback(schema.parse(args), { signal });
        return { response, body: JSON.parse(response.content[0].text) };
    };
}
async function markerExists(path) {
    for (let attempt = 0; attempt < 600; ++attempt) {
        try {
            return await readFile(path, 'utf8');
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
            await delay(5);
        }
    }
    assert.fail(`Marker not created: ${path}`);
}
const viewport = {
    screenX: 0,
    screenY: 0,
    outerWidth: 800,
    outerHeight: 680,
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
};
const tab = {
    id: 101,
    targetId: '101',
    type: 'page',
    url: 'https://example.com/owned',
    title: 'Owned page',
    managed: true,
    active: true,
    revision: 'r1',
};
const browse = publicTool(registerBrowseTool);
const input = publicTool(registerInputTool);
const linuxOnly = { skip: globalThis.process.platform !== 'linux' ? 'X11 command fixture' : false, timeout: 20_000 };

async function fixture(run) {
    const root = await mkdtemp(join(tmpdir(), 'mcp-chrome-c31f-release-'));
    const unified = getUnifiedSession();
    const bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() });
    bridge.setCurrentTargetId('101');
    bridge.updateState(tab);
    bridge.httpServer.clientSocket = { readyState: 1 };
    bridge.httpServer.helloReceived = true;
    const requests = [];
    const native = [];
    let pending = true;
    bridge.httpServer.sendMessage = (_socket, message) => {
        requests.push(message);
        if (message.type === 'cancel') {
            return;
        }
        globalThis.queueMicrotask(() => {
            const data = {
                page_snapshot: { targetId: '101', url: tab.url, revision: 'r1' },
                tabs_list: [tab],
                tabs_topology: {
                    windows: [{ id: 1, focused: true, activeTabId: 101, tabs: [tab] }],
                    groups: [],
                    activeTargetId: '101',
                    windowCount: 1,
                },
                tabs_get: tab,
                navigate: { ...tab, url: message.params.url },
                debugger_detach: {},
                viewport_metrics:
                    message.params.pointerProbe?.operation === 'start'
                        ? { documentId: 'owned-pointer-document' }
                        : message.params.pointerProbe?.operation === 'stop'
                          ? { stopped: true }
                          : { x: 0, y: 80 },
                cookies_get: [],
                input_mouse: {},
            }[message.action];
            assert.notEqual(data, undefined, `Unexpected Extension action: ${message.action}`);
            if (message.action === 'navigate' && requests.filter(({ action }) => action === 'navigate').length > 1) {
                pending = false;
            }
            bridge.httpServer.handleMessage(JSON.stringify({ id: message.id, success: true, data }));
        });
    };
    const restore = patch(unified, {
        extensionBridge: bridge,
        activeMode: 'extension',
        cdpExplicitlySelected: false,
        pageMetadata: new Map(),
        hasBrowserEventObservation: () => false,
        getChallengeState: async () => null,
        inspectChallenge: async () => ({
            clickPoint: pending ? { x: 12, y: 34 } : null,
            clickSource: 'iframe',
            title: tab.title,
            viewport,
            turnstilePresent: pending,
            inspected: true,
            selectorHits: [],
            deniedHits: [],
        }),
        readViewportMetrics: async () => viewport,
    });
    const queryResults = {
        getactivewindow: '42',
        getwindowname: 'Owned page - Google Chrome',
        getwindowgeometry: 'X=0\nY=0\nWIDTH=800\nHEIGHT=680',
        '-id': '_GTK_FRAME_EXTENTS:  not found.',
        getmouselocation: 'X=12\nY=114',
    };
    const nativeResult = (file, args, options) => {
        native.push({ file, args: [...args], options });
        return { stdout: queryResults[args[0]] ?? '', stderr: '' };
    };
    try {
        await run({
            root,
            unified,
            requests,
            native,
            nativeResult,
            clearChallenge() {
                pending = false;
            },
        });
    } finally {
        for (const handler of bridge.httpServer.messageHandlers.values()) {
            handler.cleanup();
            handler.reject(new Error('fixture cleanup'));
        }
        bridge.httpServer.messageHandlers.clear();
        execScenario = undefined;
        restore();
        await rm(root, { recursive: true, force: true });
    }
}
function queuedEffects(requests) {
    return requests
        .filter(({ action }) => action === 'navigate' || action === 'input_mouse')
        .map(({ action }) => action);
}
function queueFollowers() {
    return [
        browse({ action: 'open', targetId: '101', url: tab.url, timeout: 12_000 }),
        input({
            targetId: '101',
            expectedUrl: tab.url,
            events: [{ type: 'mousemove', target: { x: 5, y: 6 } }],
            timeout: 12_000,
        }),
    ];
}

for (const outcome of ['success', 'failure', 'timeout', 'normal']) {
    test(`C31F-02 public open holds navigation and input until native release ${outcome}`, linuxOnly, async () => {
        await fixture(async ({ root, requests, native, nativeResult, clearChallenge }) => {
            const started = join(root, 'up-started');
            const gate = join(root, 'release-gate');
            const ended = join(root, 'up-ended');
            const abort = new globalThis.AbortController();
            let releaseFinished = false;
            let releaseChild;
            execScenario = async (file, args, options) => {
                const result = nativeResult(file, args, options);
                if (args[0] === 'mousedown' && outcome !== 'normal') {
                    // SDK cancellation reasons may be strings rather than Error objects.
                    globalThis.setImmediate(() => abort.abort('cancelled after press completion'));
                }
                if (args[0] !== 'mouseup') {
                    return result;
                }
                assert.equal(options.signal, undefined);
                assert.equal(options.timeout, 5000);
                const script = `
                    const fs = require('node:fs');
                    fs.writeFileSync(process.argv[1], 'started');
                    const timer = setInterval(() => {
                        if (!fs.existsSync(process.argv[2])) return;
                        clearInterval(timer);
                        fs.writeFileSync(process.argv[3], 'ended');
                        process.exit(${outcome === 'failure' ? 7 : 0});
                    }, 5);
                `;
                const operation = nativeExec(
                    globalThis.process.execPath,
                    ['-e', script, started, gate, ended],
                    options
                );
                releaseChild = operation.child;
                try {
                    return await operation;
                } finally {
                    releaseFinished = true;
                    clearChallenge();
                }
            };
            let settled = false;
            const first = browse({ action: 'open', targetId: '101', url: tab.url, timeout: 10_000 }, abort.signal).then(
                (value) => {
                    settled = true;
                    return value;
                }
            );
            let followers = [];
            try {
                await markerExists(started);
                assert.equal(native.filter(({ args }) => args[0] === 'mousedown').length, 1);
                followers = queueFollowers();
                await delay(60);
                assert.equal(releaseFinished, false);
                assert.equal(settled, false, 'The public handler must wait for necessary release');
                assert.deepEqual(queuedEffects(requests), ['navigate']);
                if (outcome !== 'timeout') {
                    await writeFile(gate, 'release');
                }
                const result = await first;
                if (outcome === 'normal') {
                    assert.equal(result.response.isError, undefined);
                    assert.equal(result.body.success, true);
                } else {
                    assert.equal(result.response.isError, true);
                    assert.equal(result.body.error.context.actionExecuted, true);
                    assert.equal(result.body.error.context.actionStatus, 'completed');
                    assert.equal(result.body.error.context.verificationActionExecuted, 'unknown');
                    if (outcome === 'success') {
                        assert.equal(result.body.error.code, 'CANCELLED');
                    } else {
                        assert.equal(result.body.error.code, 'OS_MOUSE_UNAVAILABLE');
                        assert.equal(result.body.error.context.releaseStatus, 'unknown');
                        assert.equal(result.body.error.context.failureStage, 'release');
                        assert.equal(result.body.error.context.verificationStatus, 'unknown');
                        assert.match(result.body.error.message, /释放失败/);
                    }
                }
                for (const follower of await Promise.all(followers)) {
                    assert.equal(follower.response.isError, undefined, JSON.stringify(follower.body));
                }
                assert.deepEqual(queuedEffects(requests), ['navigate', 'navigate', 'input_mouse']);
                if (outcome !== 'timeout') {
                    assert.equal(releaseFinished, true);
                    assert.equal(await readFile(ended, 'utf8'), 'ended');
                }
                const reused = await browse({ action: 'open', targetId: '101', url: tab.url, timeout: 2000 });
                assert.equal(reused.body.success, true);
                assert.equal(
                    requests.some(({ action }) => /focus|activate/.test(action ?? '')),
                    false
                );
            } finally {
                await writeFile(gate, 'release');
                releaseChild?.kill();
                await Promise.allSettled([first, ...followers]);
            }
        });
    });
}

for (const stage of ['query', 'movement']) {
    test(
        `C31F-02 public cancellation before press at ${stage} releases the queue without late input`,
        linuxOnly,
        async () => {
            await fixture(async ({ requests, native, nativeResult, clearChallenge }) => {
                const entered = deferred();
                const held = deferred();
                const abort = new globalThis.AbortController();
                execScenario = async (file, args, options) => {
                    const result = nativeResult(file, args, options);
                    if (args[0] === (stage === 'query' ? 'getactivewindow' : 'mousemove')) {
                        entered.resolve();
                        await held.promise;
                    }
                    return result;
                };
                const first = browse({ action: 'open', targetId: '101', url: tab.url, timeout: 4000 }, abort.signal);
                try {
                    await entered.promise;
                    abort.abort(`cancelled ${stage}`);
                    const result = await Promise.race([first, delay(300).then(() => 'stalled')]);
                    assert.notEqual(result, 'stalled');
                    assert.equal(result.body.error.code, 'CANCELLED');
                    clearChallenge();
                    for (const follower of await Promise.all(queueFollowers())) {
                        assert.equal(follower.response.isError, undefined, JSON.stringify(follower.body));
                    }
                    const count = native.length;
                    held.resolve();
                    await delay(30);
                    assert.equal(native.length, count);
                    assert.equal(
                        native.some(({ args }) => /^(mousedown|mouseup|click)$/.test(args[0])),
                        false
                    );
                    assert.deepEqual(queuedEffects(requests), ['navigate', 'navigate', 'input_mouse']);
                } finally {
                    held.resolve();
                    await first;
                }
            });
        }
    );
}
