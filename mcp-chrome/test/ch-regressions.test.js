import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    focusCdpTarget,
    redactSensitiveInputData,
    replaceNthOccurrence,
    supportsTextSelection,
} from '../dist/tools/input.js';
import { waitForPostCondition } from '../dist/tools/post-condition.js';
import { finishDiagnostics, startDiagnostics, withDiagnosticsResponse } from '../dist/tools/diagnostics.js';
import {
    classifyEvaluateActionError,
    classifyEvaluateFailure,
    resolveEvaluateMode,
    resolveStaleContextRetryPolicy,
} from '../dist/tools/evaluate.js';
import { boundInlineNetworkRequest, normalizeConsoleLog } from '../dist/tools/logs.js';
import { sanitizeUrl, sanitizeUrlRecord } from '../dist/tools/network-sanitizer.js';
import { EvaluateResultTooLargeError, NonSerializableEvaluateResultError } from '../dist/core/types.js';
import { resolveExtensionBundleStatus } from '../dist/extension/http-server.js';
import { summarizeTargetCandidates } from '../dist/tools/target-diagnostics.js';

test('CH-01 selection capability excludes non-text input types', () => {
    for (const type of ['text', 'search', 'tel', 'url', 'password']) {
        assert.equal(supportsTextSelection('input', type), true);
    }
    assert.equal(supportsTextSelection('textarea'), true);
    for (const type of ['number', 'date', 'time', 'range', 'color']) {
        assert.equal(supportsTextSelection('input', type), false);
    }
});

test('CH-01 computes complete value replacement by occurrence', () => {
    assert.equal(replaceNthOccurrence('10 10 10', '10', '25', 1), '10 25 10');
    assert.equal(replaceNthOccurrence('10', 'missing', '25'), null);
});

test('CH-01 redacts input find and replacement sentinels from nested failure data', () => {
    const findSentinel = 'password-find-sentinel';
    const replacementSentinel = 'password-replacement-sentinel';
    const redacted = redactSensitiveInputData(
        {
            error: `not found: ${findSentinel}`,
            context: {
                activeElement: { valuePreview: `prefix-${findSentinel}-suffix` },
                diagnostics: [{ text: replacementSentinel }],
            },
        },
        [findSentinel, replacementSentinel]
    );
    const serialized = JSON.stringify(redacted);
    assert.equal(serialized.includes(findSentinel), false);
    assert.equal(serialized.includes(replacementSentinel), false);
    assert.match(serialized, /\[REDACTED\]/);
});

test('CH-01 CDP locator focus does not depend on Extension refIds', async () => {
    const target = { role: 'textbox', name: 'Password', nth: 1 };
    let receivedTarget;
    let receivedOptions;
    let functionDeclaration;
    const session = {
        createLocator(actualTarget, options) {
            receivedTarget = actualTarget;
            receivedOptions = options;
            return {
                async evaluateOn(fn) {
                    functionDeclaration = fn;
                    return true;
                },
            };
        },
    };

    await focusCdpTarget(session, target, 750);
    assert.deepEqual(receivedTarget, target);
    assert.deepEqual(receivedOptions, { timeout: 750 });
    assert.match(functionDeclaration, /this\.focus/);
});

test('CH-01 contenteditable selection uses an exact DOM Range', async () => {
    const inputSource = await readFile(new URL('../src/tools/input.ts', import.meta.url), 'utf8');
    assert.match(inputSource, /root instanceof HTMLElement && root\.isContentEditable/);
    assert.match(inputSource, /selection\.addRange\(selectionRange\)/);
    assert.match(inputSource, /if \(result\.type === 'range'\)/);
});

test('CH-02 postCondition reports matched and not_matched', async () => {
    const matched = await waitForPostCondition(
        { evaluate: async () => 1 },
        { selector: '#ready', timeout: 50, interval: 50 },
        'test'
    );
    assert.equal(matched.verificationStatus, 'matched');

    const notMatched = await waitForPostCondition(
        { evaluate: async () => 0 },
        { selector: '#missing', timeout: 50, interval: 50 },
        'test'
    );
    assert.equal(notMatched.verificationStatus, 'not_matched');
});

test('CH-02 postCondition text check emits a valid escaped newline', async () => {
    let evaluatedScript;
    const result = await waitForPostCondition(
        {
            evaluate: async (script) => {
                evaluatedScript = script;
                return { matched: true, actual: 'ready' };
            },
        },
        { text: 'ready', timeout: 50, interval: 50 },
        'test'
    );
    assert.equal(result.verificationStatus, 'matched');
    assert.equal(evaluatedScript.includes("join('\\n')"), true);
    assert.equal(evaluatedScript.includes("element.type === 'password'"), true);
});

test('CH-02 postCondition distinguishes unavailable from business mismatch', async () => {
    const result = await waitForPostCondition(
        {
            evaluate: async () => {
                throw new Error('Cannot resolve CDP frame for URL');
            },
        },
        { selector: '#ready', timeout: 50, interval: 50 },
        'test'
    );
    assert.equal(result.verificationStatus, 'unavailable');
    assert.equal(result.retryable, true);
});

test('CH-02 postCondition uses the evaluate action mode', async () => {
    const modes = [];
    const result = await waitForPostCondition(
        {
            evaluate: async (_script, mode) => {
                modes.push(mode);
                return 1;
            },
        },
        { selector: '#ready', timeout: 50, interval: 50 },
        'evaluate',
        'stealth'
    );
    assert.equal(result.verificationStatus, 'matched');
    assert.deepEqual(modes, ['stealth']);
});

test('CH-03 evaluate defaults to precise independently of input mode', () => {
    assert.equal(resolveEvaluateMode(undefined), 'precise');
    assert.equal(resolveEvaluateMode('stealth'), 'stealth');
});

test('CH-03 iframe stale-context replay requires an explicit read-only contract', () => {
    assert.equal(resolveStaleContextRetryPolicy(undefined), 'never');
    assert.equal(resolveStaleContextRetryPolicy('never'), 'never');
    assert.equal(resolveStaleContextRetryPolicy('readOnly'), 'readOnly');
});

test('CH-03 evaluate distinguishes pre-action and in-flight timeout', () => {
    assert.deepEqual(classifyEvaluateActionError(new Error('Frame evaluation timed out before Runtime.evaluate')), {
        actionExecuted: false,
        actionStatus: 'failed',
        retryable: true,
    });
    assert.deepEqual(classifyEvaluateActionError(new Error('Request timeout after 100ms')), {
        actionExecuted: true,
        actionStatus: 'unknown',
        retryable: true,
    });
    assert.deepEqual(classifyEvaluateActionError(new Error('ReferenceError: missing is not defined')), {
        actionExecuted: true,
        actionStatus: 'failed',
        retryable: false,
    });
    assert.deepEqual(
        classifyEvaluateActionError(
            new Error('FRAME_STALE_CONTEXT: Execution context became stale; script was not replayed')
        ),
        {
            actionExecuted: true,
            actionStatus: 'unknown',
            retryable: true,
        }
    );
    assert.deepEqual(classifyEvaluateActionError(new Error('Error: boom\n    at <anonymous>:1:7')), {
        actionExecuted: true,
        actionStatus: 'failed',
        retryable: false,
    });
});

test('CH-03 evaluate reports result materialization errors as output failures', () => {
    assert.deepEqual(classifyEvaluateFailure(new NonSerializableEvaluateResultError({ type: 'object', subtype: 'node' })), {
        actionExecuted: true,
        actionStatus: 'completed',
        failureStage: 'output',
        retryable: false,
    });
    assert.deepEqual(
        classifyEvaluateFailure(
            new EvaluateResultTooLargeError({
                exceeded: 'nodes',
                depth: 1,
                nodes: 2001,
                chars: 10,
                maxDepth: 8,
                maxNodes: 2000,
                maxChars: 1_000_000,
            })
        ),
        {
            actionExecuted: true,
            actionStatus: 'completed',
            failureStage: 'output',
            retryable: false,
        }
    );
});

test('console log levels use the public schema vocabulary', () => {
    assert.deepEqual(normalizeConsoleLog({ level: 'log', text: 'message' }), {
        level: 'info',
        text: 'message',
    });
    assert.equal(normalizeConsoleLog({ level: 'warn', text: 'warning' }).level, 'warning');
    assert.equal(normalizeConsoleLog({ level: 'trace', text: 'trace' }).level, 'debug');
});

test('inline network logs bound long URLs and retain original length', () => {
    const url = `data:text/plain,${'x'.repeat(5000)}`;
    const request = boundInlineNetworkRequest({ url, method: 'GET', type: 'Other' });
    assert.equal(request.url.length, 2048);
    assert.equal(request.urlLength, url.length);
    assert.equal(request.urlTruncated, true);

    const short = { url: 'https://example.com', method: 'GET', type: 'Document' };
    assert.equal(boundInlineNetworkRequest(short), short);
});

test('network and console URL fields redact credential query parameters', () => {
    const rawUrl = 'https://example.com/file?authorization=test-sentinel&name=report&access_token=token-sentinel';
    const sanitized = sanitizeUrl(rawUrl);
    assert.equal(sanitized.url.includes('test-sentinel'), false);
    assert.equal(sanitized.url.includes('token-sentinel'), false);
    assert.match(sanitized.url, /authorization=\[REDACTED\]/);
    assert.match(sanitized.url, /access_token=\[REDACTED\]/);
    assert.equal(sanitized.urlRedacted, true);
    assert.equal(sanitized.urlOriginalLength, rawUrl.length);
    assert.deepEqual(sanitized.redactedQueryParameters, ['authorization', 'access_token']);

    const record = sanitizeUrlRecord({ url: rawUrl, level: 'error', text: 'failed' });
    assert.equal(record.text, 'failed');
    assert.equal(record.urlRedacted, true);
    assert.equal(JSON.stringify(record).includes('test-sentinel'), false);
    const sanitizedAgain = sanitizeUrlRecord(record);
    assert.equal(sanitizedAgain, record);
    assert.equal(sanitizedAgain.urlOriginalLength, rawUrl.length);
});

test('CH-04 target candidate summaries are bounded and omit page values', () => {
    const candidates = Array.from({ length: 12 }, (_, index) => ({
        tag: 'input',
        text: `${index}:${'x'.repeat(200)}`,
        rect: { x: index, y: 0, width: 10, height: 10 },
        value: `secret-${index}`,
        href: `https://example.com/${index}`,
    }));
    const summary = summarizeTargetCandidates(candidates);
    assert.equal(summary.length, 10);
    assert.equal(summary[0].text.length, 160);
    assert.equal('value' in summary[0], false);
    assert.equal('href' in summary[0], false);
});

test('CH-07 diagnostics remain attached when the main action fails', async () => {
    const session = {
        enableConsole: async () => {},
        enableNetwork: async () => {},
        getConsoleLogs: async () => [{ level: 'error', text: 'navigation failed' }],
        getNetworkRequests: async () => [{ url: 'https://example.com', status: 503 }],
    };
    const response = await withDiagnosticsResponse(session, true, async () => {
        throw new Error('navigation timeout');
    });
    assert.equal(response.isError, true);
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.error.message, 'navigation timeout');
    assert.equal(payload.diagnosticsStatus, 'collected');
    assert.deepEqual(payload.diagnostics.console, []);
    assert.deepEqual(payload.diagnostics.failedRequests, []);
});

test('CH-04 target diagnostics read live tab state instead of cached attach metadata', async () => {
    const [sessionSource, diagnosticsSource, extractSource] = await Promise.all([
        readFile(new URL('../src/core/unified-session.ts', import.meta.url), 'utf8'),
        readFile(new URL('../src/tools/target-diagnostics.ts', import.meta.url), 'utf8'),
        readFile(new URL('../src/tools/extract.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(sessionSource, /async getLiveState\(\)/);
    assert.match(sessionSource, /await this\.extensionBridge!\.listTargets\(\)/);
    assert.match(diagnosticsSource, /await unifiedSession\.getLiveState\(\)/);
    assert.match(extractSource, /await unifiedSession\.getLiveState\(\)/);
});

test('CH-05 backend selection happens inside the active tab and frame scopes', async () => {
    const [inputSource, waitSource, logsSource, extractSource] = await Promise.all(
        ['input.ts', 'wait.ts', 'logs.ts', 'extract.ts'].map((file) =>
            readFile(new URL(`../src/tools/${file}`, import.meta.url), 'utf8')
        )
    );

    const assertScoped = (source, handler, backendMarker, hasFrame) => {
        const handlerIndex = source.indexOf(handler);
        const tabIndex = source.indexOf('withTabId(args.tabId', handlerIndex);
        const frameIndex = hasFrame ? source.indexOf('withFrame(args.frame', tabIndex) : tabIndex;
        const backendIndex = source.indexOf(backendMarker, frameIndex);
        assert.ok(handlerIndex >= 0 && tabIndex > handlerIndex && backendIndex > frameIndex);
    };

    assertScoped(inputSource, 'async function handleInput', 'const mode = unifiedSession.getMode()', true);
    assertScoped(waitSource, 'async function handleWait', 'const mode = unifiedSession.getMode()', true);
    assertScoped(logsSource, 'async function handleLogs', 'const mode = unifiedSession.getMode()', false);
    assertScoped(
        extractSource,
        'async function handleExtract',
        "const useExtension = unifiedSession.getMode() === 'extension'",
        true
    );
});

test('CH-06 Extension only replays stale iframe contexts for read-only scripts', async () => {
    const [resolverSource, schemaSource] = await Promise.all([
        readFile(new URL('../extension/src/background/frame-resolver.ts', import.meta.url), 'utf8'),
        readFile(new URL('../extension/src/types/schemas.ts', import.meta.url), 'utf8'),
    ]);
    assert.match(resolverSource, /p\.staleContextRetry === 'readOnly' \? 2 : 1/);
    assert.match(resolverSource, /script was not replayed because staleContextRetry is never/);
    assert.match(schemaSource, /staleContextRetry: z\.enum\(\['never', 'readOnly'\]\)\.default\('never'\)/);
});

test('CH-06 DOM iframe identity does not depend on webNavigation frame ordering', async () => {
    const [resolverSource, actionUtilsSource, contentSource] = await Promise.all([
        readFile(new URL('../extension/src/background/frame-resolver.ts', import.meta.url), 'utf8'),
        readFile(new URL('../extension/src/background/action-utils.ts', import.meta.url), 'utf8'),
        readFile(new URL('../extension/src/content/content.ts', import.meta.url), 'utf8'),
    ]);

    assert.match(resolverSource, /getDomFrameSnapshot\(tabId, 0, p\.frame\)/);
    assert.doesNotMatch(resolverSource, /directChildFrames\[info\.index\]/);
    assert.match(actionUtilsSource, /mcp-frame-probe/);
    assert.match(actionUtilsSource, /recordDomFrameProbe/);
    assert.match(actionUtilsSource, /candidateFrameIds\.length === 1/);
    assert.match(contentSource, /MCP_FRAME_PROBE/);
    assert.match(resolverSource, /不会按 webNavigation 列表顺序选择其他 frame/);
});

test('CH-06 Extension bundle identity distinguishes active and stale builds without blocking legacy clients', async () => {
    const expected = `sha256:${'a'.repeat(64)}`;
    const active = `sha256:${'b'.repeat(64)}`;
    assert.equal(resolveExtensionBundleStatus(expected, expected, true), 'match');
    assert.equal(resolveExtensionBundleStatus(expected, active, true), 'stale');
    assert.equal(resolveExtensionBundleStatus(expected, null, true), 'legacy');
    assert.equal(resolveExtensionBundleStatus(null, active, true), 'unknown');
    assert.equal(resolveExtensionBundleStatus(expected, null, false), 'pending');

    const clientSource = await readFile(
        new URL('../extension/src/background/http-client.ts', import.meta.url),
        'utf8'
    );
    assert.match(clientSource, /chrome\.runtime\.getURL\('service-worker-loader\.js'\)/);
    assert.match(clientSource, /backgroundBundleHash/);
});

test('CH-07 diagnostics initialization and collection are best effort', async () => {
    const unavailable = await startDiagnostics(
        {
            enableConsole: async () => {
                throw new Error('debugger blocked');
            },
        },
        true
    );
    assert.equal(unavailable.result.diagnosticsStatus, 'unavailable');

    const session = {
        enableConsole: async () => {},
        enableNetwork: async () => {},
        getConsoleLogs: async () => [],
        getNetworkRequests: async () => [],
    };
    const started = await startDiagnostics(session, true);
    const finished = await finishDiagnostics(session, started);
    assert.equal(finished.diagnosticsStatus, 'collected');

    const collectionFailed = await finishDiagnostics(
        {
            getConsoleLogs: async () => {
                throw new Error('restricted page');
            },
            getNetworkRequests: async () => [],
        },
        started
    );
    assert.equal(collectionFailed.diagnosticsStatus, 'error');
    assert.match(collectionFailed.diagnosticsError, /restricted page/);
});
