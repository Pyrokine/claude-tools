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

test(
    'C31-02A public refresh cancels getactivewindow, releases the lock, and never dispatches late native input',
    { skip: process.platform !== 'linux' ? 'X11 command fixture' : false },
    async () => {
        await extensionFixture(async ({ unified, requests }) => {
            const entered = deferred();
            const held = deferred();
            const native = [];
            execScenario = async (file, args, options) => {
                native.push([file, ...args]);
                assert.ok(options.signal);
                assert.deepEqual(args, ['getactivewindow']);
                entered.resolve();
                return held.promise;
            };
            const abort = new AbortController();
            const operation = browse()({ action: 'refresh', timeout: 4000 }, abort.signal);
            await entered.promise;
            abort.abort(new Error('cancelled during native read'));
            const { response, body } = await operation;
            assert.equal(response.isError, true);
            assert.equal(body.error.context.actionStatus, 'completed');
            assert.equal(body.error.context.actionExecuted, true);
            assert.equal(body.error.context.verificationStatus, 'cancelled');
            assert.equal(body.error.context.verificationActionExecuted, 'unknown');
            let lockReleased = false;
            await unified.withTabLock(async () => {
                lockReleased = true;
            });
            assert.equal(lockReleased, true);
            held.resolve({ stdout: '42', stderr: '' });
            await tick();
            await tick();
            assert.deepEqual(native, [['xdotool', 'getactivewindow']]);
            assert.equal(
                requests.filter(
                    ({ action, params }) => action === 'viewport_metrics' && params.pointerProbe?.operation === 'stop'
                ).length,
                1
            );
            assert.equal(requests.filter(({ action }) => action === 'reload').length, 1);
            assert.equal(
                requests.some(({ action }) => /focus|activate/.test(action ?? '')),
                false
            );
        });
    }
);

test('native pointer observer cleanup retains its own budget after the request expires', async () => {
    await extensionFixture(async ({ unified, requests }) => {
        const scope = { session: unified, deadline: Date.now() + 1000 };
        const failure = new Error('owned coordinate timeout');
        const restore = patch(unified, {
            readViewportMetrics: async () => {
                scope.deadline = Date.now() - 1;
                throw failure;
            },
        });
        try {
            await unified.tabLockContext.run(scope, () =>
                assert.rejects(unified.clickTurnstile(point, 1000), (error) => error === failure)
            );
            const cleanup = requests.filter(
                ({ action, params }) => action === 'viewport_metrics' && params.pointerProbe?.operation === 'stop'
            );
            assert.equal(cleanup.length, 1);
            assert.ok(cleanup[0].params.deadline > Date.now());
            assert.ok(scope.deadline < Date.now());
            assert.equal(failure.pointerCleanupError, undefined);
        } finally {
            restore();
        }
    });
});

test('C31-02A cancelled coordinate read and movement waits have no later native dispatch', async () => {
    for (const stage of ['coordinates', 'movement']) {
        const abort = new AbortController();
        const held = deferred();
        const entered = deferred();
        const calls = [];
        const execFile = async (_file, args) => {
            calls.push([...args]);
            entered.resolve();
            return held.promise;
        };
        const operation =
            stage === 'coordinates'
                ? resolveTurnstileOsClickPoint(point, { platform: 'linux', execFile, signal: abort.signal })
                : osLeftClick(12, 34, {
                      platform: 'linux',
                      path: [
                          { x: 1, y: 2 },
                          { x: 12, y: 34 },
                      ],
                      execFile,
                      signal: abort.signal,
                  });
        const result = assert.rejects(operation);
        await entered.promise;
        abort.abort(new Error(`cancelled ${stage}`));
        await result;
        held.resolve({ stdout: '42', stderr: '' });
        await tick();
        assert.equal(calls.length, 1);
    }
    const abort = new AbortController();
    const calls = [];
    await assert.rejects(
        osLeftClick(12, 34, {
            platform: 'linux',
            path: [
                { x: 1, y: 2 },
                { x: 12, y: 34 },
            ],
            signal: abort.signal,
            execFile: async (_file, args) => {
                calls.push([...args]);
                return { stdout: '', stderr: '' };
            },
            sleep: async () => {
                abort.abort(new Error('cancelled between moves'));
            },
        })
    );
    assert.deepEqual(calls, [['mousemove', '1', '2']]);
});

for (const platform of ['linux', 'darwin', 'win32']) {
    test(`C31-02A ${platform} cancellation after a press dispatches only the necessary release`, async () => {
        const abort = new AbortController();
        const calls = [];
        await assert.rejects(
            osLeftClick(12, 34, {
                platform,
                signal: abort.signal,
                path: [{ x: 12, y: 34 }],
                sleep: async () => {},
                execFile: async (file, args, options) => {
                    calls.push({ file, args: [...args], cancelled: options.signal?.aborted });
                    if (args[0] === 'mousedown' || args[0] === 'dd:.' || /mouse_event\(2,/.test(args.at(-1))) {
                        abort.abort(new Error('cancelled after press'));
                    }
                    return { stdout: '', stderr: '' };
                },
            })
        );
        const release = calls.at(-1);
        assert.equal(release.cancelled, undefined);
        assert.ok(
            release.args[0] === 'mouseup' || release.args[0] === 'du:.' || /mouse_event\(4,/.test(release.args.at(-1))
        );
        assert.equal(calls.length, 3);
    });
}

test('C31-02A normal native path clicks once and focus/permission rejection remains visible', async () => {
    const calls = [];
    await osLeftClick(12, 34, {
        platform: 'linux',
        path: [{ x: 12, y: 34 }],
        sleep: async () => {},
        execFile: async (_file, args) => {
            calls.push([...args]);
            return { stdout: '', stderr: '' };
        },
    });
    assert.deepEqual(calls, [
        ['mousemove', '12', '34'],
        ['click', '--delay', '80', '1'],
    ]);
    await assert.rejects(
        resolveTurnstileOsClickPoint(point, {
            platform: 'linux',
            execFile: async (_file, args) => ({
                stdout: args[0] === 'getactivewindow' ? '42' : 'Other page - Google Chrome',
                stderr: '',
            }),
        }),
        /不是该受控测试页/
    );
    await assert.rejects(
        osLeftClick(12, 34, {
            platform: 'darwin',
            path: [{ x: 12, y: 34 }],
            execFile: async () => {
                throw new Error('Accessibility permission denied');
            },
        }),
        /permission denied/
    );
});

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

for (const stage of ['first HTTP', 'second HTTP', 'port reuse targets']) {
    test(`C31-02B public launch cancellation during ${stage} never starts a browser after a late response`, async () => {
        await launchFixture(async ({ effects, urls, setFetch }) => {
            const entered = deferred();
            const held = deferred();
            let index = 0;
            setFetch(async (url, options) => {
                assert.ok(options.signal);
                if (++index === (stage === 'first HTTP' ? 1 : 2)) {
                    entered.resolve();
                    return held.promise;
                }
                return json({ webSocketDebuggerUrl: endpoint });
            });
            const abort = new AbortController();
            const operation = browse()(
                {
                    action: 'launch',
                    port: 9333,
                    ...(stage === 'port reuse targets' ? {} : { headless: true }),
                    timeout: 1000,
                },
                abort.signal
            );
            await entered.promise;
            abort.abort(new Error(`cancelled ${stage}`));
            const { response } = await operation;
            assert.equal(response.isError, true);
            held.resolve(json(targets));
            await tick();
            await tick();
            assert.equal(effects.includes('spawn'), false);
            assert.equal(effects.includes('newPage'), false);
            assert.equal(effects.includes('attach'), false);
            assert.equal(urls.length, stage === 'first HTTP' ? 1 : 2);
            if (stage !== 'port reuse targets') {
                assert.deepEqual(effects, []);
            } else {
                assert.deepEqual(effects, ['reset', 'handshake', 'disconnect']);
            }
        });
    });
}

test('C31-02B cancelled pre-dispatch and queued launch requests perform zero HTTP/profile/spawn work', async () => {
    await launchFixture(async ({ unified, effects, urls }) => {
        const abort = new AbortController();
        abort.abort(new Error('pre-cancelled'));
        assert.equal((await browse()({ action: 'launch' }, abort.signal)).response.isError, true);
        const entered = deferred();
        const release = deferred();
        const blocking = unified.withTabLock(async () => {
            entered.resolve();
            await release.promise;
        });
        await entered.promise;
        const queuedAbort = new AbortController();
        const queued = browse()({ action: 'launch', port: 9333 }, queuedAbort.signal);
        queuedAbort.abort(new Error('queue cancelled'));
        assert.equal((await queued).response.isError, true);
        assert.deepEqual(urls, []);
        assert.deepEqual(effects, []);
        release.resolve();
        await blocking;
    });
});

test('C31-02B port reuse, conflict and normal startup each retain their single execution path', async () => {
    for (const scenario of ['reuse', 'conflict', 'new', 'unavailable']) {
        await launchFixture(async ({ effects, setFetch }) => {
            if (scenario === 'unavailable') {
                setFetch(async (url) => {
                    if (String(url).endsWith('/json/version')) {
                        throw new Error('no endpoint');
                    }
                    return json(targets);
                });
            }
            const { response, body } = await browse()({
                action: 'launch',
                ...(scenario === 'new' ? {} : { port: 9333 }),
                ...(scenario === 'conflict' ? { headless: true } : {}),
                timeout: 1000,
            });
            assert.equal(Boolean(response.isError), scenario === 'conflict');
            assert.equal(
                effects.filter((effect) => effect === 'spawn').length,
                ['new', 'unavailable'].includes(scenario) ? 1 : 0
            );
            if (scenario === 'reuse') {
                assert.equal(body.target.reused, true);
            }
            if (scenario === 'conflict') {
                assert.deepEqual(effects, []);
            } else {
                assert.equal(effects.filter((effect) => effect === 'attach').length, 1);
            }
        });
    }
});

test('C31-02B cancellation immediately before startup prevents launcher dispatch', async () => {
    await launchFixture(async ({ session, effects }) => {
        const abort = new AbortController();
        const restore = patch(session, {
            resetState() {
                abort.abort(new Error('cancelled before spawn'));
            },
        });
        try {
            assert.equal((await browse()({ action: 'launch' }, abort.signal)).response.isError, true);
        } finally {
            restore();
        }
        assert.deepEqual(effects, []);
    });
});

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

test('C31-02B launcher rejects pre-cancelled requests before creating a profile or process', posixOnly, async () => {
    await markerFixture(async ({ executable, profile, marker, writeMarker }) => {
        await writeMarker();
        const abort = new AbortController();
        abort.abort(new Error('cancelled before profile'));
        const launcher = new BrowserLauncher();
        await assert.rejects(
            launcher.launch({ executablePath: executable, userDataDir: profile }, abort.signal),
            /cancelled before profile/
        );
        await assert.rejects(readFile(marker), { code: 'ENOENT' });
        await assert.rejects(readFile(profile), { code: 'ENOENT' });
        assert.equal(launcher.process, null);
    });
});

test(
    'C31-02B cancellation after spawn terminates only the marker process and removes startup listeners',
    posixOnly,
    async () => {
        await markerFixture(async ({ executable, profile, marker, writeMarker }) => {
            await writeMarker();
            const abort = new AbortController();
            const launcher = new BrowserLauncher();
            const operation = launcher.launch(
                { executablePath: executable, userDataDir: profile, timeout: 2000 },
                abort.signal
            );
            const rejected = assert.rejects(operation, /cancelled endpoint wait/);
            const child = launcher.process;
            const exited = once(child, 'exit');
            try {
                for (let attempt = 0; ; ++attempt) {
                    try {
                        await readFile(marker);
                        break;
                    } catch (error) {
                        if (error.code !== 'ENOENT' || attempt > 100) {
                            throw error;
                        }
                        await delay(5);
                    }
                }
                abort.abort(new Error('cancelled endpoint wait'));
                await rejected;
                await exited;
                assert.equal(launcher.process, null);
                assert.equal(child.listenerCount('error'), 0);
                assert.equal(child.stderr.listenerCount('data'), 0);
                assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 1);
            } finally {
                launcher.close();
            }
        });
    }
);

test(
    'C31-02B public launch cancellation during real WebSocket handshake closes the owned marker process',
    posixOnly,
    async () => {
        await markerFixture(async ({ executable, profile, marker, writeMarker }) => {
            const connected = deferred();
            const sockets = new Set();
            const server = createServer((socket) => {
                sockets.add(socket);
                socket.on('close', () => sockets.delete(socket));
                connected.resolve();
            });
            server.listen(0, '127.0.0.1');
            await once(server, 'listening');
            await writeMarker(`ws://127.0.0.1:${server.address().port}/devtools/browser/c31`);
            try {
                await launchFixture(
                    async ({ session, effects }) => {
                        const abort = new AbortController();
                        const operation = browse()(
                            { action: 'launch', executablePath: executable, userDataDir: profile, timeout: 3000 },
                            abort.signal
                        );
                        await connected.promise;
                        const child = session.launcher.process;
                        const exited = once(child, 'exit');
                        abort.abort(new Error('cancelled WebSocket handshake'));
                        assert.equal((await operation).response.isError, true);
                        await exited;
                        assert.equal(session.launcher, null);
                        assert.equal(session.cdp, null);
                        assert.equal(effects.includes('attach'), false);
                        assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 1);
                    },
                    { realLauncher: true, realConnect: true }
                );
            } finally {
                for (const socket of sockets) {
                    socket.destroy();
                }
                await new Promise((resolve) => server.close(resolve));
            }
        });
    }
);

test('C31-02A cancellation terminates an actual harmless execFile child without another move', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-chrome-c31-exec-'));
    const marker = join(root, 'started');
    const abort = new AbortController();
    let child;
    let dispatches = 0;
    const operation = osLeftClick(12, 34, {
        platform: 'linux',
        path: [
            { x: 1, y: 2 },
            { x: 12, y: 34 },
        ],
        signal: abort.signal,
        execFile: (_file, _args, options) => {
            ++dispatches;
            const pending = nativeExecFile[promisify.custom](
                process.execPath,
                [
                    '-e',
                    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000)`,
                ],
                options
            );
            child = pending.child;
            return pending;
        },
    });
    const rejected = assert.rejects(operation);
    try {
        for (let attempt = 0; ; ++attempt) {
            try {
                await readFile(marker);
                break;
            } catch (error) {
                if (error.code !== 'ENOENT' || attempt > 100) {
                    throw error;
                }
                await delay(5);
            }
        }
        const exited = new Promise((resolve) => child.once('exit', resolve));
        abort.abort(new Error('cancelled marker execFile'));
        await rejected;
        await exited;
        await tick();
        assert.equal(child.killed, true);
        assert.equal(dispatches, 1);
    } finally {
        child?.kill();
        await rm(root, { recursive: true, force: true });
    }
});

test('C31-02B the original public deadline expires during HTTP without a late spawn', async () => {
    await launchFixture(async ({ effects, urls, setFetch }) => {
        const held = deferred();
        setFetch(async () => held.promise);
        const { response } = await browse()({ action: 'launch', port: 9333, timeout: 20 });
        assert.equal(response.isError, true);
        held.resolve(json({ webSocketDebuggerUrl: endpoint }));
        await tick();
        await tick();
        assert.equal(urls.length, 1);
        assert.deepEqual(effects, []);
    });
});

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

test(
    'C31-02B a delivered endpoint keeps its single owned process when the old request is later cancelled',
    posixOnly,
    async () => {
        await markerFixture(async ({ executable, profile, marker, writeMarker }) => {
            await writeMarker(endpoint);
            const abort = new AbortController();
            const launcher = new BrowserLauncher();
            try {
                assert.equal(
                    await launcher.launch(
                        { executablePath: executable, userDataDir: profile, timeout: 2000 },
                        abort.signal
                    ),
                    endpoint
                );
                const child = launcher.process;
                abort.abort(new Error('old completed request cancelled'));
                await tick();
                assert.equal(child.killed, false);
                assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 1);
            } finally {
                const child = launcher.process;
                const exited = child ? once(child, 'exit') : Promise.resolve();
                launcher.close();
                await exited;
            }
        });
    }
);
