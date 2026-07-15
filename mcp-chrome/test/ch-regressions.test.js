import assert from 'node:assert/strict';
import test from 'node:test';

import { supportsTextSelection, replaceNthOccurrence } from '../dist/tools/input.js';
import { waitForPostCondition } from '../dist/tools/post-condition.js';
import { finishDiagnostics, startDiagnostics, withDiagnosticsResponse } from '../dist/tools/diagnostics.js';
import { classifyEvaluateActionError, resolveEvaluateMode } from '../dist/tools/evaluate.js';
import { boundInlineNetworkRequest, normalizeConsoleLog } from '../dist/tools/logs.js';
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
