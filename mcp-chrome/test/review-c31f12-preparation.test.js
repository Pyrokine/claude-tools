import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getUnifiedSession } from '../dist/core/index.js';
import { ExtensionBridge } from '../dist/extension/bridge.js';
import { registerInputTool } from '../dist/tools/input.js';

test('C31F13 SDK keeps auxiliary output facts separate from undispatched input', async () => {
    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-c31f13-preparation-')), 'results.json');
    const report = {
        status: 'RUNNING',
        sdkCalls: 0,
        registeredCalls: 0,
        checks: [],
        cleanup: [],
        boundary:
            'Actual SDK Client/McpServer -> registered input -> production UnifiedSession/Bridge/ExtensionHttpServer sendCommand and handleMessage. Controlled socket peer supplies snapshots, frame resolution and raw evaluate replies; find results and challenge observations are controlled. No native Chrome, DOM, sockets or discovery claimed.',
    };
    const unified = getUnifiedSession();
    const bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() });
    const transport = bridge.httpServer;
    const page = {
        id: 101,
        targetId: '101',
        type: 'page',
        url: 'https://example.test/owned-preparation',
        title: 'Owned preparation',
        revision: 'controlled-r1',
        managed: true,
    };
    const restores = [];
    const patch = (object, values) => {
        const descriptors = new Map(
            Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(object, key)])
        );
        Object.assign(object, values);
        restores.push(() => {
            for (const [key, descriptor] of descriptors) {
                if (descriptor) {
                    Object.defineProperty(object, key, descriptor);
                } else {
                    Reflect.deleteProperty(object, key);
                }
            }
        });
    };
    let current;
    const detail = JSON.stringify({
        error: { message: 'Owned coordinate output failure', suggestion: 'Owned test', context: {} },
    });
    const rawResults = {
        inspection: { success: false, errorSource: 'output', error: detail },
        summary: {
            success: false,
            errorSource: 'output',
            errorCode: 'NON_SERIALIZABLE_EVALUATE_RESULT',
            error: 'Owned summary generation failure',
        },
        result: { success: true, result: 'owned invalid result JSON' },
        detail: { success: false, errorSource: 'output', error: 'owned invalid summary JSON' },
    };
    const reply = (message) => {
        const { action, params } = message;
        if (action === 'tabs_list') {
            return [page];
        }
        if (action === 'page_snapshot') {
            return page;
        }
        if (action === 'resolve_frame') {
            return { frameId: 7, offset: { x: 11, y: 17 }, frameContext: { documentId: 'controlled-document' } };
        }
        if (action === 'evaluate') {
            ++current.helperCalls;
            return rawResults[current.output];
        }
        if (action === 'stealth_key' || (action === 'debugger_send' && params.method === 'Input.dispatchKeyEvent')) {
            current.principalCommands.push(message);
            return {};
        }
        throw new Error('Unimplemented controlled RPC: ' + action + '/' + (params.method ?? ''));
    };
    patch(transport, {
        clientSocket: {
            readyState: 1,
            send(serialized) {
                const message = JSON.parse(serialized);
                current.protocol.push(message);
                if (message.type === 'cancel') {
                    return;
                }
                Promise.resolve().then(() => {
                    try {
                        const data = reply(message);
                        transport.handleMessage(JSON.stringify({ id: message.id, success: true, data }));
                    } catch (error) {
                        current.peerErrors.push(String(error));
                        transport.handleMessage(
                            JSON.stringify({ id: message.id, success: false, error: String(error) })
                        );
                    }
                });
            },
        },
    });
    bridge.setCurrentTargetId('101');
    patch(unified, {
        extensionBridge: bridge,
        activeMode: 'extension',
        cdpExplicitlySelected: false,
        inputMode: 'stealth',
        getDriver: async () => bridge,
        hasBrowserEventObservation: () => false,
        getChallengeState: async () => null,
        getLiveState: async () => ({ title: page.title, url: page.url }),
        inspectChallenge: async () => ({
            inspected: true,
            title: page.title,
            url: page.url,
            selectorHits: [],
            deniedHits: [],
            textHits: [],
            originResponsePending: false,
            turnstilePresent: false,
            clickPoint: null,
            clickTargetKind: null,
        }),
        find: async () => [{ refId: 'owned-ref', tag: 'BUTTON', rect: { x: 5, y: 7, width: 80, height: 30 } }],
        listTopology: async () => null,
        pageMetadata: new Map(),
        pressedKeys: new Set(),
        modifiers: 0,
    });
    const server = new McpServer({ name: 'owned-preparation-server', version: '1.0.0' });
    const register = server.registerTool.bind(server);
    server.registerTool = (name, config, fn) =>
        register(name, config, (...args) => {
            ++report.registeredCalls;
            return fn(...args);
        });
    registerInputTool(server);
    const client = new Client({ name: 'owned-preparation-client', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const send = ct.send.bind(ct);
    ct.send = (...args) => {
        if (args[0].method === 'tools/call') {
            ++report.sdkCalls;
        }
        return send(...args);
    };
    const consumers = [
        { type: 'mousemove', target: { css: '#owned' } },
        { type: 'click', button: 'right', target: { css: '#owned' } },
        { type: 'touchstart', target: { css: '#owned' } },
        { type: 'mousedown', target: { css: '#owned' } },
    ];
    try {
        await server.connect(st);
        await client.connect(ct);
        for (const framed of [false, true]) {
            for (const consumer of consumers) {
                for (const kind of Object.keys(rawResults)) {
                    for (const prior of kind === 'result' ? [false, true] : [false]) {
                        current = {
                            framed,
                            output: kind,
                            prior,
                            consumer,
                            protocol: [],
                            principalCommands: [],
                            helperCalls: 0,
                            peerErrors: [],
                        };
                        unified.pressedKeys.clear();
                        const input = {
                            targetId: '101',
                            timeout: 1500,
                            events: [...(prior ? [{ type: 'keydown', key: 'a' }] : []), consumer],
                            ...(framed ? { frame: 'iframe#owned' } : {}),
                        };
                        const response = await client.callTool({ name: 'input', arguments: input });
                        const payload = JSON.parse(response.content[0].text);
                        const violations = [];
                        if (current.peerErrors.length) {
                            violations.push(...current.peerErrors);
                        }
                        if (current.helperCalls !== 1) {
                            violations.push('coordinate helper call count changed: ' + current.helperCalls);
                        }
                        if (current.principalCommands.length !== (prior ? 1 : 0)) {
                            violations.push('principal command count changed');
                        }
                        if (
                            payload.actionExecuted !== prior ||
                            payload.actionStatus !== (prior ? 'failed' : 'not_started') ||
                            payload.failureStage !== 'context' ||
                            payload.retryable !== false
                        ) {
                            violations.push('auxiliary output was attributed to the input principal');
                        }
                        if (payload.eventsExecuted !== (prior ? 1 : 0) || payload.remainingEventsNotExecuted !== 1) {
                            violations.push('event progress changed');
                        }
                        if (payload.error?.code !== 'NON_SERIALIZABLE_EVALUATE_RESULT') {
                            violations.push('original output error code changed');
                        }
                        report.checks.push({ ...current, input, payload, violations, pass: !violations.length });
                        assert.equal(transport.messageHandlers.size, 0);
                    }
                }
            }
        }
        report.passed = report.checks.filter((row) => row.pass).length;
        report.failed = report.checks.length - report.passed;
        report.status = report.failed ? 'FAIL' : 'PASS';
    } catch (error) {
        report.status = 'ERROR';
        report.error = error.stack;
    } finally {
        for (const [name, close] of [
            ['client', () => client.close()],
            ['server', () => server.close()],
            ['pending', () => assert.equal(transport.messageHandlers.size, 0)],
            [
                'patches',
                () => {
                    for (const restore of restores.reverse()) {
                        restore();
                    }
                },
            ],
        ]) {
            try {
                await close();
                report.cleanup.push({ name, success: true });
            } catch (error) {
                report.cleanup.push({ name, success: false, error: String(error) });
                report.status = 'ERROR';
            }
        }
        fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
        console.log(
            JSON.stringify({
                status: report.status,
                checks: report.checks.length,
                passed: report.passed,
                failed: report.failed,
                sdkCalls: report.sdkCalls,
                registeredCalls: report.registeredCalls,
                output,
            })
        );
    }
    assert.equal(report.checks.length, 40);
    assert.equal(report.status, 'PASS', 'Preparation regression evidence: ' + output);
});
