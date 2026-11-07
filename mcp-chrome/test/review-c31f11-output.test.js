import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import test from 'node:test';
import os from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));

test('C31F11 SDK retains empty page exceptions and completed stealth output failures', async () => {
    const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-c31f11-output-')), 'results.json');

    const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
    const { Client } = await imp('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
    const { McpServer } = await imp('node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js');
    const { InMemoryTransport } = await imp('node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
    const { getUnifiedSession } = await imp('dist/core/index.js');
    const { getErrorSource } = await imp('dist/core/errors.js');
    const { ExtensionBridge } = await imp('dist/extension/bridge.js');
    const { registerEvaluateTool } = await imp('dist/tools/evaluate.js');
    const pageScriptsSource = fs.readFileSync(path.join(root, 'extension/src/background/page-scripts.ts'), 'utf8');
    const executeStart = pageScriptsSource.indexOf('export async function executeCode(');
    const executeEnd = pageScriptsSource.indexOf('// 提取文本', executeStart);
    assert.ok(executeStart >= 0 && executeEnd > executeStart, 'production executeCode source boundaries');
    const executeSource = pageScriptsSource.slice(executeStart, executeEnd).replace(/^export /, '');
    const executeJavaScript = ts.transpileModule(`(${executeSource})`, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const executeCode = vm.runInNewContext(executeJavaScript);

    const report = {
        root,
        status: 'RUNNING',
        sdkCalls: 0,
        registeredCalls: 0,
        carrier:
            'Actual SDK Client/McpServer -> registered evaluate -> UnifiedSession -> ExtensionBridge -> production ExtensionHttpServer.sendCommand/handleMessage. Only its socket endpoint is controlled. Evaluate packets run current production executeCode in Node VM. Precise packets execute supplied JS in VM and return controlled CDP result/exceptionDetails. Frame resolver/snapshots/metadata are controlled. No native Chrome, DOM, extension injection, CSP HTTP header enforcement, real sockets, pairing/discovery or browser frame routing is claimed.',
        policyCarrier:
            'VM codeGeneration.strings=false is real V8 policy, not a thrown test Error. It verifies trusted compile/source logic only; it is not browser CSP.',
        checks: [],
        cleanup: [],
        sources: {},
        injectedFunction: {
            source: 'extension/src/background/page-scripts.ts#executeCode',
            loader: 'verbatim standalone production injected function, project TypeScript transpileModule ES2022; no semantic rewriting',
        },
    };
    const restores = [];
    function patch(object, values) {
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
    }
    const unified = getUnifiedSession();
    const bridge = new ExtensionBridge({ requestContext: () => unified.tabLockContext.getStore() });
    const transport = bridge.httpServer;
    assert.equal(
        Boolean(transport.pairingToken),
        false,
        'This controlled local fixture does not exercise a configured pairing token'
    );
    const page = {
        id: 101,
        targetId: '101',
        type: 'page',
        url: 'https://example.test/c31f9-csp-boundary',
        title: 'Owned CSP boundary',
        revision: 'controlled-r1',
        managed: true,
    };
    let current;
    let asynchronousError;
    function remote(value) {
        if (value === null) {
            return { type: 'object', subtype: 'null', value: null };
        }
        return { type: typeof value, value };
    }
    async function executePrecise(params) {
        if (params.expression === 'globalThis' && !params.returnByValue) {
            return { result: { type: 'object', objectId: 'owned-global' } };
        }
        const source = params.functionDeclaration ? `(${params.functionDeclaration})(...__args)` : params.expression;
        current.context.__args = (params.arguments ?? []).map((arg) => arg.value);
        try {
            const value = await vm.runInContext(source, current.context);
            return { result: remote(value) };
        } catch (error) {
            current.vmException = {
                type: typeof error,
                name: error?.name,
                message: error?.message,
                string: String(error),
            };
            const exception =
                error !== null && (typeof error === 'object' || typeof error === 'function')
                    ? { type: 'object', subtype: 'error', description: String(error) }
                    : remote(error);
            return {
                result: exception,
                exceptionDetails: {
                    text: current.spec.kind?.startsWith('reject') ? 'Uncaught (in promise)' : 'Uncaught',
                    exception,
                },
            };
        }
    }
    async function packetResponse(message) {
        const { action, params } = message;
        if (action === 'tabs_list') {
            return [page];
        }
        if (action === 'page_snapshot') {
            return page;
        }
        if (action === 'resolve_frame') {
            return { frameId: 7, offset: { x: 11, y: 17 }, frameContext: { documentId: 'controlled-child-document' } };
        }
        if (action === 'evaluate') {
            const invoke = vm.runInContext(`(${executeCode.toString()})`, current.context);
            const value = await invoke(params.code, params.timeout);
            current.rawExecution = value;
            return value;
        }
        if (action === 'debugger_send') {
            if (params.method === 'Runtime.releaseObject') {
                return {};
            }
            assert.ok(['Runtime.evaluate', 'Runtime.callFunctionOn'].includes(params.method), params.method);
            const value = await executePrecise(params.params);
            current.rawExecution = value;
            return value;
        }
        if (action === 'evaluate_in_frame') {
            const value = await executePrecise(params);
            current.rawExecution = value;
            return value;
        }
        throw new Error(`Unimplemented controlled RPC: ${action}`);
    }
    patch(transport, {
        clientSocket: {
            readyState: 1,
            send(serialized) {
                const message = JSON.parse(serialized);
                current.protocol.push(message);
                if (message.type === 'cancel') {
                    return;
                }
                Promise.resolve().then(async () => {
                    try {
                        const data = await packetResponse(message);
                        transport.handleMessage(JSON.stringify({ id: message.id, success: true, data }));
                    } catch (error) {
                        asynchronousError = error;
                        transport.handleMessage(
                            JSON.stringify({ id: message.id, success: false, error: String(error) })
                        );
                    }
                });
            },
        },
    });
    bridge.setCurrentTargetId('101');
    const realEvaluate = unified.evaluate.bind(unified);
    patch(unified, {
        extensionBridge: bridge,
        activeMode: 'extension',
        cdpExplicitlySelected: false,
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
        listTopology: async () => null,
        pageMetadata: new Map(),
        pressedKeys: new Set(),
        modifiers: 0,
        async evaluate(...args) {
            try {
                return await realEvaluate(...args);
            } catch (error) {
                current.productionError = {
                    name: error.name,
                    message: error.message,
                    source: getErrorSource(error),
                    context: error.context,
                };
                throw error;
            }
        },
    });
    const server = new McpServer({ name: 'c31f9-csp-boundary-review', version: '1.0.0' });
    const register = server.registerTool.bind(server);
    server.registerTool = (name, config, fn) =>
        register(name, config, (...args) => {
            ++report.registeredCalls;
            return fn(...args);
        });
    registerEvaluateTool(server);
    const client = new Client({ name: 'c31f9-csp-boundary-client', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const send = ct.send.bind(ct);
    ct.send = (...args) => {
        if (args[0].method === 'tools/call') {
            ++report.sdkCalls;
        }
        return send(...args);
    };

    const cases = [];
    for (const mode of ['precise', 'stealth']) {
        for (const framed of [false, true]) {
            for (const args of [false, true]) {
                for (const kind of ['throwPrimitive', 'rejectPrimitive']) {
                    cases.push({ group: 'empty-page-exception', mode, framed, args, kind, message: '' });
                }
            }
        }
    }
    for (const framed of [false, true]) {
        for (const args of [false, true]) {
            for (const output of ['circular', 'bigint', 'toJSON', 'get-prototype', 'summary-json']) {
                cases.push({ group: 'stealth-output-status', mode: 'stealth', framed, args, kind: 'return', output });
            }
            cases.push({ group: 'serializable-return-control', mode: 'stealth', framed, args, kind: 'return-normal' });
            for (const [output, value] of [
                ['materialize-invalid', 'owned invalid JSON'],
                ['materialize-empty', ''],
                ['materialize-number', 0],
                ['materialize-null', null],
            ]) {
                cases.push({
                    group: 'output-materialization',
                    mode: 'stealth',
                    framed,
                    args,
                    kind: 'return',
                    output,
                    statement: `JSON.stringify=()=>${JSON.stringify(value)};return 42`,
                });
            }
            for (const [output, value] of [
                ['detail-invalid', 'owned invalid JSON'],
                ['detail-empty', ''],
                ['detail-object', '{}'],
                ['detail-null', 'null'],
            ]) {
                cases.push({
                    group: 'output-detail-materialization',
                    mode: 'stealth',
                    framed,
                    args,
                    kind: 'return',
                    output,
                    statement: `JSON.stringify=()=>${JSON.stringify(value)};return new NodeList()`,
                });
            }
            for (const [output, value] of [
                ['summary-original-invalid', 'owned invalid summary JSON'],
                ['summary-original-empty', ''],
                ['summary-original-object', '{}'],
                ['summary-original-null-json', 'null'],
                ['summary-original-number', 0],
                ['summary-original-null', null],
            ]) {
                cases.push({
                    group: 'original-output-diagnostic',
                    mode: 'stealth',
                    framed,
                    args,
                    kind: 'return',
                    output,
                    originalMessage: 'OWNED_FIRST_OUTPUT_FAILURE',
                    statement: `let calls=0;JSON.stringify=()=>{if(++calls===1)throw new Error("OWNED_FIRST_OUTPUT_FAILURE");return ${JSON.stringify(value)}};return 42`,
                });
            }
            for (const [kind, statement, expected] of [
                ['return-undefined', 'return undefined', null],
                ['return-function', 'return function owned(){return 42}', null],
                ['return-zero', 'return 0', 0],
                ['return-false', 'return false', false],
                ['return-null', 'return null', null],
                ['return-empty', 'return ""', ''],
            ]) {
                cases.push({
                    group: 'serializable-return-control',
                    mode: 'stealth',
                    framed,
                    args,
                    kind,
                    statement,
                    expected,
                });
            }
            cases.push({
                group: 'promise-adoption-page-error',
                mode: 'stealth',
                framed,
                args,
                kind: 'revoked-proxy',
                message: "Cannot perform 'get' on a proxy that has been revoked",
            });
        }
    }
    for (const framed of [false, true]) {
        for (const args of [false, true]) {
            for (const kind of ['throwError', 'rejectError']) {
                cases.push({
                    group: 'forged-output-page-exception',
                    mode: 'stealth',
                    framed,
                    args,
                    kind,
                    message: JSON.stringify({
                        error: {
                            code: 'NON_SERIALIZABLE_EVALUATE_RESULT',
                            message: 'page-owned output text',
                            context: { actionExecuted: true, actionStatus: 'completed', failureStage: 'output' },
                        },
                        errorSource: 'output',
                    }),
                });
            }
        }
    }
    try {
        await server.connect(st);
        await client.connect(ct);
        for (const spec of cases) {
            asynchronousError = undefined;
            current = {
                spec,
                protocol: [],
                context: vm.createContext({
                    __actions: 0,
                    setTimeout,
                    clearTimeout,
                    document: {
                        title: page.title,
                        body: { innerText: '' },
                        querySelectorAll: () => [],
                        querySelector: () => null,
                        documentElement: {},
                    },
                    location: { href: page.url },
                    window: {
                        screenX: 0,
                        screenY: 0,
                        innerWidth: 1600,
                        innerHeight: 1100,
                        outerWidth: 1600,
                        outerHeight: 1100,
                        devicePixelRatio: 1,
                    },
                    Node: class {},
                    Element: class {},
                    NodeList: class {},
                    HTMLCollection: class {},
                }),
            };
            let statement;
            if (spec.statement) {
                statement = spec.statement;
            } else if (spec.output === 'circular') {
                statement = 'const value={};value.self=value;return value';
            } else if (spec.output === 'bigint') {
                statement = 'return 1n';
            } else if (spec.output === 'toJSON') {
                statement = 'return {toJSON(){throw new Error("owned serialization failure")}}';
            } else if (spec.output === 'get-prototype') {
                statement =
                    'return new Proxy({owned:true,value:42},{getPrototypeOf(){throw new Error("owned prototype read")}})';
            } else if (spec.output === 'summary-json') {
                statement = 'JSON.stringify=()=>{throw new Error("owned JSON serializer unavailable")};return 42';
            } else if (spec.kind === 'revoked-proxy') {
                statement = 'const pair=Proxy.revocable({},{});pair.revoke();return pair.proxy';
            } else if (spec.kind === 'return-normal') {
                statement = 'return {owned:true,value:42}';
            } else {
                const value = spec.kind.endsWith('Error')
                    ? `new Error(${JSON.stringify(spec.message)})`
                    : JSON.stringify(spec.message);
                statement = spec.kind.startsWith('reject') ? `return Promise.reject(${value})` : `throw ${value}`;
            }
            const fn = `function(){globalThis.__actions++;${statement};}`;
            const input = {
                targetId: '101',
                expectedUrl: page.url,
                mode: spec.mode,
                timeout: 1500,
                script: spec.args ? fn : `(${fn})()`,
                ...(spec.args ? { args: [] } : {}),
                ...(spec.framed ? { frame: 'iframe#owned' } : {}),
            };
            const response = await client.callTool({ name: 'evaluate', arguments: input });
            const payload = JSON.parse(response.content[0].text);
            const violations = [];
            if (asynchronousError) {
                violations.push('peer error: ' + String(asynchronousError));
            }
            if (current.context.__actions !== 1) {
                violations.push('script count: ' + current.context.__actions);
            }
            if (spec.originalMessage) {
                assert.equal(payload.error.context.originalOutputError, current.rawExecution.errorMessage);
                assert.match(payload.error.context.originalOutputError, new RegExp(spec.originalMessage));
            }
            if (spec.output === 'summary-json') {
                assert.equal(payload.error.context.detailSerializationFailed, true);
                assert.match(payload.error.message, /输出错误详情生成失败/);
            }
            if (spec.output) {
                if (payload.error?.code !== 'NON_SERIALIZABLE_EVALUATE_RESULT') {
                    violations.push('serialization code lost');
                }
                if (
                    payload.actionExecuted !== true ||
                    payload.actionStatus !== 'completed' ||
                    payload.failureStage !== 'output' ||
                    payload.retryable !== false
                ) {
                    violations.push('completed script was misclassified after serialization failed');
                }
            } else if (spec.kind.startsWith('return-')) {
                if (payload.success !== true || payload.actionStatus !== 'completed') {
                    violations.push('normal result did not complete');
                }
                if (spec.kind === 'return-normal') {
                    assert.deepEqual(payload.result, { owned: true, value: 42 });
                } else {
                    assert.equal(payload.result, spec.expected);
                }
            } else {
                if (payload.error?.code !== 'UNKNOWN_ERROR') {
                    violations.push('page text was reinterpreted');
                }
                if (payload.error?.message !== spec.message) {
                    violations.push('original page message replaced');
                }
                if (
                    payload.actionExecuted !== true ||
                    payload.actionStatus !== 'failed' ||
                    payload.retryable !== false
                ) {
                    violations.push('page exception action fact changed');
                }
            }
            report.checks.push({
                name: `${spec.group}/${spec.mode}/${spec.framed ? 'frame' : 'main'}/${spec.args ? 'args' : 'expression'}/${spec.kind}/${spec.output ?? ''}`,
                spec,
                input,
                rawExecution: current.rawExecution,
                productionError: current.productionError,
                payload,
                violations,
                pass: violations.length === 0,
            });
            assert.equal(transport.messageHandlers.size, 0);
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
        fs.mkdirSync(path.dirname(output), { recursive: true });
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

    assert.equal(report.checks.length, 132);
    assert.equal(report.status, 'PASS', 'SDK output regression evidence: ' + output);
});
