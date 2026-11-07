import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getUnifiedSession } from '../dist/core/index.js';
import { ExtensionBridge } from '../dist/extension/bridge.js';
import { registerEvaluateTool } from '../dist/tools/evaluate.js';
import { registerInputTool } from '../dist/tools/input.js';

const totals = { sdkCalls: 0, completedChecks: 0 };
after(() => console.log('C31F5 actual SDK verification totals:', JSON.stringify(totals)));

async function fixture(context, spec, run) {
    const unified = getUnifiedSession();
    const bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() });
    bridge.currentTabId = 101;
    bridge.httpServer.helloReceived = true;
    const state = { actions: 0, reads: 0, messages: [], held: [], trace: [], deadline: undefined, frozen: undefined };
    const realNow = Date.now.bind(Date);
    let lastNow;
    context.mock.method(Date, 'now', () => {
        lastNow = state.frozen ?? realNow();
        return lastNow;
    });
    const nativeTimer = globalThis.setTimeout;
    context.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
        if (state.actions === 1 && state.reads === 0 && state.deadline === undefined && ms > 0 && ms <= 70) {
            state.deadline = lastNow + ms;
            state.trace.push({ phase: 'budget-scheduled', deadline: state.deadline, timeout: ms });
        }
        return nativeTimer(callback, ms, ...args);
    });
    const reply = (message, data) =>
        bridge.httpServer.handleMessage(JSON.stringify({ id: message.id, success: true, data }));
    const evaluate = async (message) => {
        const result = await vm.runInNewContext(message.params.code);
        reply(message, { success: true, result: JSON.stringify(result) });
    };
    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = { OPEN: 1 };
    bridge.httpServer.clientSocket = {
        readyState: 1,
        close() {},
        send(text) {
            const message = JSON.parse(text);
            state.messages.push(message);
            if (message.type === 'cancel') {
                return;
            }
            if (message.action === 'tabs_list') {
                reply(message, [{ id: 101, managed: true, active: false, url: 'https://example.test/c31f5' }]);
                return;
            }
            if (message.action === 'stealth_key') {
                if (message.params.type === 'down') {
                    ++state.actions;
                }
                reply(message, { success: true });
                return;
            }
            assert.equal(message.action, 'evaluate', JSON.stringify(message));
            if (message.params.code.includes('matched: Boolean')) {
                ++state.reads;
                assert.ok(Number.isFinite(state.deadline));
                state.trace.push({
                    phase: 'read',
                    now: realNow(),
                    deadline: state.deadline,
                    rpcDeadline: message.params.deadline,
                });
                if (spec.hold) {
                    state.held.push(message);
                    if (spec.clock !== undefined) {
                        state.frozen = state.deadline + spec.clock;
                    }
                    return;
                }
            } else {
                ++state.actions;
            }
            void evaluate(message).catch((error) =>
                bridge.httpServer.handleMessage(
                    JSON.stringify({ id: message.id, success: false, error: error.message })
                )
            );
        },
    };
    const page = {
        targetId: '101',
        id: 101,
        managed: true,
        active: false,
        revision: 'synthetic-c31f5',
        url: 'https://example.test/c31f5',
    };
    const overrides = {
        extensionBridge: bridge,
        activeMode: 'extension',
        cdpExplicitlySelected: false,
        inputMode: 'stealth',
        getPageSnapshot: async () => page,
        listTargets: async () => [page],
        listTopology: async () => ({ activeTargetId: '101' }),
        hasBrowserEventObservation: () => false,
        getChallengeState: async () => null,
        getState: () => ({ title: 'Synthetic', url: page.url }),
        getLiveState: async () => ({ title: 'Synthetic', url: page.url }),
        inspectChallenge: async () => ({
            inspected: true,
            title: 'Synthetic',
            url: page.url,
            selectorHits: [],
            deniedHits: [],
            textHits: [],
            originResponsePending: false,
            turnstilePresent: false,
            clickPoint: null,
            clickTargetKind: null,
        }),
    };
    const previous = new Map(Object.keys(overrides).map((key) => [key, Object.getOwnPropertyDescriptor(unified, key)]));
    Object.assign(unified, overrides);
    const server = new McpServer({ name: 'c31f5-verification', version: '1.0.0' });
    registerEvaluateTool(server);
    registerInputTool(server);
    const client = new Client({ name: 'c31f5-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, ...args) => {
        if (message.method === 'tools/call') {
            ++totals.sdkCalls;
        }
        return send(message, ...args);
    };
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
        await run({ client, bridge, state });
    } finally {
        state.frozen = undefined;
        context.mock.restoreAll();
        for (const message of state.held) {
            await evaluate(message);
        }
        await client.close();
        await server.close();
        for (const [key, descriptor] of previous) {
            if (descriptor) {
                Object.defineProperty(unified, key, descriptor);
            } else {
                Reflect.deleteProperty(unified, key);
            }
        }
        globalThis.WebSocket = previousWebSocket;
        context.diagnostic(
            JSON.stringify({
                spec,
                actions: state.actions,
                reads: state.reads,
                trace: state.trace,
                messages: state.messages,
            })
        );
    }
}

const cases = [
    { name: 'deadline-minus-one', hold: true, clock: -1, status: 'unavailable', retryable: true },
    { name: 'deadline', hold: true, clock: 0, status: 'unavailable', retryable: true },
    { name: 'real-clock', hold: true, status: 'unavailable', retryable: true },
    {
        name: 'script-throw',
        script: '() => { throw new Error("navigation timeout: request budget exhausted") }',
        status: 'error',
        retryable: false,
    },
    {
        name: 'script-reject',
        script: 'Promise.reject(new Error("navigation timeout: request budget exhausted"))',
        status: 'error',
        retryable: false,
    },
    { name: 'true', script: 'true', status: 'matched', retryable: false },
    { name: 'false', script: 'false', status: 'not_matched', retryable: true },
];
for (const operation of ['evaluate', 'input']) {
    for (const spec of cases) {
        test(
            `C31F5-03 actual SDK ${operation}/${spec.name} classifies verification without replaying the completed action`,
            { timeout: 5000 },
            async (context) => {
                await fixture(context, spec, async ({ client, bridge, state }) => {
                    const args = {
                        targetId: '101',
                        timeout: 5000,
                        ...(operation === 'evaluate'
                            ? { script: '1', mode: 'stealth' }
                            : { events: [{ type: 'keydown', key: 'a' }] }),
                        postCondition: { script: spec.script ?? 'false', timeout: 70, interval: 50 },
                    };
                    const started = performance.now();
                    const response = await client.callTool({ name: operation, arguments: args });
                    const payload = JSON.parse(response.content[0].text);
                    state.trace.push({ phase: 'result', monotonicMs: performance.now() - started, result: payload });
                    assert.equal(payload.actionStatus, 'completed', JSON.stringify(payload));
                    assert.equal(payload.actionExecuted, true);
                    assert.equal(payload.verificationStatus, spec.status, JSON.stringify(payload));
                    assert.equal(payload.postCondition.verificationStatus, spec.status);
                    assert.equal(payload.postCondition.retryable, spec.retryable);
                    assert.equal(payload.retryable, false);
                    assert.equal(state.actions, 1);
                    if (spec.clock !== undefined) {
                        assert.equal(payload.postCondition.elapsedMs, 70 + spec.clock);
                    }
                    if (spec.hold) {
                        assert.equal(state.reads, 1);
                        assert.equal(typeof payload.postCondition.error, 'string');
                        assert.ok(payload.postCondition.error.length > 0);
                    }
                    if (spec.name === 'false') {
                        assert.ok(state.reads >= 2);
                    }
                    state.frozen = undefined;
                    const cleanupDeadline = performance.now() + 1000;
                    while (bridge.httpServer.messageHandlers.size && performance.now() < cleanupDeadline) {
                        await delay(5);
                    }
                    assert.equal(bridge.httpServer.messageHandlers.size, 0);
                    for (const message of state.held) {
                        const result = await vm.runInNewContext(message.params.code);
                        bridge.httpServer.handleMessage(
                            JSON.stringify({
                                id: message.id,
                                success: true,
                                data: { success: true, result: JSON.stringify(result) },
                            })
                        );
                    }
                    await tick();
                    assert.equal(state.actions, 1);
                    assert.equal(bridge.httpServer.messageHandlers.size, 0);
                    ++totals.completedChecks;
                });
            }
        );
    }
}
