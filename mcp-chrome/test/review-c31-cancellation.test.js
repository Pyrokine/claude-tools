import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

// Install before module initialization so the real OS path uses a controlled execFile.
let execScenario;
const nativeExecFile = childProcess.execFile;
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
const { getSession } = await import('../dist/core/session.js');
const { osLeftClick, resolveTurnstileOsClickPoint } = await import('../dist/core/os-mouse.js');
const { CDPClient } = await import('../dist/cdp/client.js');
const { TimeoutError } = await import('../dist/core/errors.js');
const { BrowserLauncher } = await import('../dist/cdp/launcher.js');
const { registerBrowseTool } = await import('../dist/tools/browse.js');
const { ExtensionBridge } = await import('../dist/extension/bridge.js');
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
function browse() {
    let schema;
    let callback;
    registerBrowseTool({
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
const tick = () => new Promise((resolve) => setImmediate(resolve));
const viewport = {
    screenX: 0,
    screenY: 0,
    outerWidth: 800,
    outerHeight: 680,
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
};
const point = { clickPoint: { x: 12, y: 34 }, clickSource: 'iframe', title: 'Owned page', viewport };
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
const targets = [{ id: '101', type: 'page', url: tab.url, title: tab.title }];
const endpoint = 'ws://127.0.0.1:9333/devtools/browser/c31';
const json = (value) =>
    new globalThis.Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

async function extensionFixture(run) {
    const unified = getUnifiedSession();
    const bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() });
    bridge.setCurrentTargetId('101');
    bridge.updateState(tab);
    bridge.httpServer.clientSocket = { readyState: 1 };
    bridge.httpServer.helloReceived = true;
    const requests = [];
    const topology = {
        windows: [{ id: 1, focused: true, activeTabId: 101, tabs: [tab] }],
        groups: [],
        activeTargetId: '101',
        windowCount: 1,
    };
    bridge.httpServer.sendMessage = (_socket, message) => {
        requests.push(message);
        if (message.type === 'cancel') {
            return;
        }
        globalThis.queueMicrotask(() => {
            const data = {
                page_snapshot: { targetId: '101', url: tab.url, revision: 'r1' },
                tabs_list: [tab],
                tabs_topology: topology,
                tabs_get: tab,
                reload: tab,
                debugger_detach: {},
                viewport_metrics:
                    message.params.pointerProbe?.operation === 'start'
                        ? { documentId: 'owned-pointer-document' }
                        : message.params.pointerProbe?.operation === 'stop'
                          ? { stopped: true }
                          : { x: 0, y: 80 },
            }[message.action];
            assert.notEqual(data, undefined, `Unexpected Extension action: ${message.action}`);
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
            ...point,
            turnstilePresent: true,
            inspected: true,
            selectorHits: [],
            deniedHits: [],
        }),
        readViewportMetrics: async () => viewport,
    });
    try {
        return await run({ unified, bridge, requests });
    } finally {
        for (const handler of bridge.httpServer.messageHandlers.values()) {
            handler.cleanup();
            handler.reject(new Error('fixture cleanup'));
        }
        bridge.httpServer.messageHandlers.clear();
        execScenario = undefined;
        restore();
    }
}

async function launchFixture(run, { realLauncher = false, realConnect = false } = {}) {
    const unified = getUnifiedSession();
    const session = getSession();
    const effects = [];
    const restoreSession = patch(session, {
        launcher: null,
        cdp: null,
        operationLock: Promise.resolve(),
        connectedPort: 0,
        requestContext: () => unified.tabLockContext.getStore(),
        isConnected: () => false,
        resetState() {
            effects.push('reset');
            this.cdp = null;
            this.launcher = null;
        },
        attachToTargetInternal: async () => {
            effects.push('attach');
        },
        newPageInternal: async () => {
            effects.push('newPage');
            return { targetId: '101', ...targets[0] };
        },
    });
    const restoreUnified = patch(unified, {
        extensionBridge: null,
        activeMode: 'none',
        cdpExplicitlySelected: false,
        pageMetadata: new Map(),
        isExtensionModeEnabled: () => true,
        getCurrentTargetId: () => null,
        getPageSnapshot: async () => ({ targetId: '101', url: tab.url, revision: 'r1' }),
        listTargets: async () => [tab],
        listTopology: async () => null,
    });
    const restores = [restoreSession, restoreUnified];
    if (!realLauncher) {
        restores.push(
            patch(BrowserLauncher.prototype, {
                async launch() {
                    effects.push('spawn');
                    this._port = 9333;
                    return endpoint;
                },
                close() {
                    effects.push('kill-owned');
                },
            })
        );
    }
    if (!realConnect) {
        restores.push(
            patch(CDPClient.prototype, {
                async connect() {
                    effects.push('handshake');
                    this.ws = {
                        readyState: 1,
                        close() {
                            effects.push('disconnect');
                        },
                    };
                },
            })
        );
    }
    const urls = [];
    let fetchScenario = async (url) =>
        json(String(url).endsWith('/json/version') ? { webSocketDebuggerUrl: endpoint } : targets);
    restores.push(
        patch(globalThis, {
            fetch: (url, options) => {
                urls.push(String(url));
                return fetchScenario(url, options);
            },
        })
    );
    try {
        return await run({
            unified,
            session,
            effects,
            urls,
            setFetch: (scenario) => {
                fetchScenario = scenario;
            },
        });
    } finally {
        session.cdp?.close();
        session.launcher?.close();
        for (const restore of restores.reverse()) {
            restore();
        }
    }
}

async function markerFixture(run) {
    const root = await mkdtemp(join(tmpdir(), 'mcp-chrome-c31-'));
    const executable = join(root, 'marker-browser');
    const marker = join(root, 'started');
    const profile = join(root, 'profile');
    const writeMarker = async (endpointLine = '') => {
        await writeFile(
            executable,
            `#!${process.execPath}\nimport('node:fs').then(({appendFileSync}) => { appendFileSync(${JSON.stringify(marker)}, String(process.pid)+'\\n'); ${endpointLine ? `process.stderr.write(${JSON.stringify(`DevTools listening on ${endpointLine}\n`)});` : ''} setInterval(() => {}, 1000); });\n`
        );
        await chmod(executable, 0o700);
    };
    try {
        return await run({ root, executable, marker, profile, writeMarker });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}
const posixOnly = { skip: process.platform === 'win32' ? 'POSIX executable marker fixture' : false };

for (const phase of ['reuse-endpoint', 'explicit-endpoint', 'explicit-targets']) {
    test(`C31F6 typed HTTP timeout ends ${phase} before another wall clock sample`, async () => {
        await launchFixture(async ({ effects, urls, setFetch }) => {
            setFetch(async (url) => {
                if (phase === 'explicit-targets' && String(url).endsWith('/json/version')) {
                    return json({ webSocketDebuggerUrl: endpoint });
                }
                throw new TimeoutError('HTTP timeout before the next deadline sample');
            });
            const { response } = await browse()({
                action: 'launch',
                port: 9333,
                timeout: 20,
                ...(phase === 'reuse-endpoint' ? {} : { headless: false }),
            });
            assert.equal(response.isError, true);
            assert.equal(urls.length, phase === 'explicit-targets' ? 2 : 1);
            assert.deepEqual(effects, []);
        });
    });
}
