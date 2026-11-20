import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getSession, getUnifiedSession } from '../dist/core/index.js';
import { formatErrorResponse, setErrorSource, TimeoutError } from '../dist/core/errors.js';
import { sanitizeUrlRecord } from '../dist/tools/network-sanitizer.js';
import { assertScreenshotBudget } from '../dist/tools/png.js';
import { registerManageTool } from '../dist/tools/manage.js';
import { registerExtractTool } from '../dist/tools/extract.js';
import { waitForPostCondition } from '../dist/tools/post-condition.js';
import {
    CHALLENGE_INSPECT_SCRIPT,
    ChallengeTimeoutError,
    classifyChallengeSnapshot,
    waitForChallenge,
} from '../dist/tools/challenge.js';

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function until(check) {
    const deadline = Date.now() + 8000;
    do {
        const result = await check();
        if (result) {
            return result;
        }
        await delay(10);
    } while (Date.now() < deadline);
    throw Error('Synthetic condition was not observed');
}

test('CSR-20-01 default event configuration waits for temporary selection restoration', async () => {
    const unified = getUnifiedSession();
    const saved = {
        extensionBridge: unified.extensionBridge,
        activeMode: unified.activeMode,
        cdpExplicitlySelected: unified.cdpExplicitlySelected,
    };
    let selected = '101';
    const targets = [];
    unified.extensionBridge = {
        isConnected: () => true,
        getCurrentTargetId: () => selected,
        listTargets: async () => [{ targetId: '101' }, { targetId: '202' }],
        selectPage: async (id) => {
            selected = id;
        },
        browserEvents: async (_action, _command, id) => {
            targets.push(id);
            return {};
        },
    };
    unified.activeMode = 'extension';
    unified.cdpExplicitlySelected = false;
    const entered = deferred(),
        release = deferred();
    try {
        const temporary = unified.withTabId('202', async () => {
            entered.resolve();
            await release.promise;
        });
        await entered.promise;
        const defaultEvent = unified.browserEvents('dialog', { op: 'watch' });
        await delay(0);
        assert.equal(targets.length, 0);
        const abort = new AbortController();
        const cancelled = unified.browserEvents('dialog', { op: 'watch' }, undefined, 1000, abort.signal);
        const rejected = assert.rejects(cancelled, /queued configuration cancelled/);
        abort.abort(new Error('queued configuration cancelled'));
        await rejected;
        assert.equal(targets.length, 0);
        release.resolve();
        await Promise.all([temporary, defaultEvent]);
        assert.deepEqual(targets, ['101']);
    } finally {
        release.resolve();
        Object.assign(unified, saved);
    }
});

test('CSR-20-03 built-in verification selects the backend retry contract', async () => {
    for (const backend of ['cdp', 'extension']) {
        let calls = 0;
        const result = await waitForPostCondition(
            {
                getMode: () => backend,
                evaluate: async (_code, _mode, _timeout, _args, options) => {
                    assert.equal(options.staleContextRetry, backend === 'cdp' ? 'never' : 'readOnly');
                    if (++calls === 1) {
                        throw Error('Execution context was destroyed');
                    }
                    return 1;
                },
            },
            { selector: '#ready', timeout: 500, interval: 50 },
            'evaluate'
        );
        assert.equal(result.verificationStatus, 'matched');
        assert.equal(calls, 2);
    }
});

test('F392 ordinary spinner and heading do not identify a JS challenge', () => {
    const generic = { tagName: 'DIV', getBoundingClientRect: () => ({ width: 40, height: 40 }), closest: () => null };
    const snapshot = vm.runInNewContext(CHALLENGE_INSPECT_SCRIPT, {
        document: {
            title: 'File differences',
            body: { innerText: 'File differences: checking your browser before accessing. Cloudflare test notes' },
            querySelectorAll: (selector) =>
                ['.lds-ring', 'div.vc div.text-box h2'].includes(selector) ? [generic] : [],
        },
        window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
        location: { href: 'https://example.com/diff' },
    });
    assert.equal(classifyChallengeSnapshot({ ...snapshot, inspected: true }, true), 'none');
});

test('F127 explicit file output materializes an object beyond the inline node limit once', async () => {
    const unified = getUnifiedSession(),
        previous = unified.extensionBridge;
    let propertyReads = 0;
    unified.extensionBridge = {
        debuggerSend: async (method) => {
            if (method === 'Runtime.releaseObject') {
                return {};
            }
            ++propertyReads;
            return {
                result: Array.from({ length: 2500 }, (_, i) => ({
                    name: String(i),
                    enumerable: true,
                    value: { type: 'number', value: i },
                })),
            };
        },
    };
    try {
        await assert.rejects(
            unified.materializeCdpResult({ type: 'object', objectId: 'owned' }),
            (error) => error.constructor.name === 'EvaluateResultTooLargeError'
        );
        const object = await unified.materializeCdpResult({ type: 'object', objectId: 'owned' }, 1000, true);
        assert.equal(Object.keys(object).length, 2500);
        assert.equal(object['2499'], 2499);
        assert.equal(propertyReads, 2);
    } finally {
        unified.extensionBridge = previous;
    }
});

test(
    'CSR-20-02/03/04 and E06 native CDP paths retain semantic targets frame clips and in-flight terminals',
    { skip: !process.env.CHROME_PATH },
    async () => {
        const work = await mkdtemp(path.join(tmpdir(), 'chrome-feedback-'));
        let slowResponse;
        let probeResponse;
        const http = createServer(
            (
                /** @type {import('node:http').IncomingMessage} */ request,
                /** @type {import('node:http').ServerResponse} */ response
            ) => {
                if (request.url === '/probe-slow') {
                    probeResponse = response;
                    return;
                }
                if (request.url === '/slow') {
                    slowResponse = response;
                    return;
                }
                response.setHeader('Content-Type', 'text/html');
                if (request.url === '/frame') {
                    response.end(
                        '<body style="margin:0"><button ' +
                            'style="position:absolute;left:20px;top:30px;' +
                            'width:40px;height:30px;background:red" id="ready">' +
                            'Save<img alt="save"></button>'
                    );
                } else {
                    response.end(
                        '<body style="margin:0"><button>Delete<img ' +
                            'alt="delete"></button><button aria-label="Save">' +
                            'Save<img alt="save"></button><iframe id="owned" ' +
                            'src="/frame" style="position:absolute;left:500px;' +
                            'top:200px;width:300px;height:150px;border:0">' +
                            '</iframe>'
                    );
                }
            }
        );
        await new Promise((resolve) => http.listen(0, '127.0.0.1', () => resolve(undefined)));
        const browser = spawn(
            process.env.CHROME_PATH,
            [
                '--headless=new',
                '--no-sandbox',
                '--disable-gpu',
                '--disable-background-networking',
                '--remote-debugging-port=0',
                `--user-data-dir=${work}`,
                'about:blank',
            ],
            { stdio: 'ignore' }
        );
        const session = getSession(),
            unified = getUnifiedSession();
        const saved = {
            extensionBridge: unified.extensionBridge,
            activeMode: unified.activeMode,
            cdpExplicitlySelected: unified.cdpExplicitlySelected,
        };
        try {
            const port = await until(async () => {
                try {
                    return Number(
                        (await readFile(path.join(work, 'DevToolsActivePort'), { encoding: 'utf8' })).split('\n')[0]
                    );
                } catch (error) {
                    if (error.code !== 'ENOENT') {
                        throw error;
                    }
                }
            });
            await session.connect({ port, stealth: 'off' });
            unified.extensionBridge = null;
            unified.activeMode = 'cdp';
            unified.cdpExplicitlySelected = true;
            const base = `http://127.0.0.1:${http.address().port}`;
            await session.navigate(base);
            const initial = session.getCurrentTargetId();
            let manage;
            registerManageTool({
                registerTool: (_name, _schema, callback) => {
                    manage = callback;
                },
            });
            const originalUserAgent = await session.evaluate('navigator.userAgent');
            assert.equal((await manage({ action: 'userAgent', userAgent: 'Owned synthetic UA' })).isError, undefined);
            assert.equal(await session.evaluate('navigator.userAgent'), 'Owned synthetic UA');
            assert.equal((await manage({ action: 'userAgent', userAgent: '' })).isError, undefined);
            assert.equal(await session.evaluate('navigator.userAgent'), originalUserAgent);
            let extract;
            registerExtractTool({
                registerTool: (_name, _schema, handler) => {
                    extract = handler;
                },
            });
            const html = await extract({
                type: 'html',
                images: 'info',
                target: { role: 'button', name: 'Save', exact: true },
            });
            assert.equal(html.isError, undefined, JSON.stringify(html));
            const body = JSON.parse(html.content.find((entry) => entry.type === 'text').text);
            assert.match(body.content, /alt="save"/);
            assert.doesNotMatch(body.content, /Delete/);
            const fullText = JSON.parse((await extract({ type: 'text' })).content[0].text);
            assert.equal(fullText.offset, undefined);
            const pageText = JSON.parse((await extract({ type: 'text', offset: 5, maxChars: 17 })).content[0].text);
            assert.equal(pageText.content, fullText.content.slice(5, 22));
            assert.equal(pageText.nextOffset, fullText.content.length > 22 ? 22 : null);
            assert.equal(pageText.totalLength, fullText.content.length);
            await mkdir('test-output', { recursive: true });
            const filePage = JSON.parse(
                (await extract({ type: 'text', maxChars: 4, output: 'cwd:test-output/paged-text.txt' })).content[0].text
            );
            assert.equal(await readFile(filePage.output, { encoding: 'utf8' }), fullText.content.slice(0, 4));
            const endPage = JSON.parse(
                (await extract({ type: 'text', offset: fullText.content.length, maxChars: 4 })).content[0].text
            );
            assert.equal(endPage.content, '');
            assert.equal(endPage.nextOffset, null);
            await session.evaluate(
                '(() => {\n                ' +
                    "document.body.style.height='2000px';\n         " +
                    "       const box=document.createElement('div')" +
                    ";box.id='overflow-box';\n                " +
                    "box.style.cssText='position:absolute;" +
                    'left:40px;top:80px;width:180px;height:100px;' +
                    'overflow:auto;border:4px solid black;' +
                    "scrollbar-width:none';\n                " +
                    'box.innerHTML=\'<table id="overflow-table" ' +
                    'style="width:600px;height:500px;' +
                    'background:rgb(0,120,220);' +
                    'border-collapse:collapse"><tr><td>Rendered ' +
                    "table region</td></tr></table>';\n             " +
                    '   document.body.append(box);' +
                    'box.scrollLeft=70;box.scrollTop=90;' +
                    'window.scrollTo(0,20);return true;\n           ' +
                    ' })()'
            );
            const geometryBefore = await session.evaluate(
                '({width:innerWidth,height:innerHeight,scrollX,' +
                    'scrollY,left:document.querySelector("#overflow-box' +
                    '").scrollLeft,top:document.querySelector("#overflo' +
                    'w-box").scrollTop})'
            );
            const overflow = await extract({ type: 'screenshot', target: { css: '#overflow-table' } });
            assert.equal(overflow.isError, undefined, JSON.stringify(overflow));
            const overflowMetadata = JSON.parse(overflow.content[0].text).metadata;
            assert.deepEqual(overflowMetadata.clip, { x: 44, y: 84, width: 180, height: 100 });
            assert.equal(overflowMetadata.clippedToVisibleArea, true);
            assert.deepEqual(
                await session.evaluate(
                    '({width:innerWidth,height:innerHeight,scrollX,' +
                        'scrollY,left:document.querySelector("#overflow-box' +
                        '").scrollLeft,top:document.querySelector("#overflo' +
                        'w-box").scrollTop})'
                ),
                geometryBefore
            );
            const { writeFile: saveOverflow } = await import('node:fs/promises');
            await saveOverflow(
                'test-output/global-feedback-overflow.png',
                Buffer.from(overflow.content.find((entry) => entry.type === 'image').data, 'base64')
            );
            await unified.withTabId(undefined, () =>
                unified.withFrame('#owned', async () => {
                    const verified = await waitForPostCondition(
                        unified,
                        { selector: '#ready', timeout: 1000 },
                        'evaluate'
                    );
                    assert.equal(verified.verificationStatus, 'matched');
                })
            );
            const screenshot = await extract({
                type: 'screenshot',
                frame: '#owned',
                target: { css: '#ready' },
                timeout: 8000,
            });
            assert.equal(screenshot.isError, undefined, JSON.stringify(screenshot));
            const { metadata } = JSON.parse(screenshot.content.find((entry) => entry.type === 'text').text);
            assert.equal(metadata.clip.x, 520);
            assert.equal(metadata.clip.y, 230);
            assert.equal(metadata.clip.width, 40);
            assert.equal(metadata.clip.height, 30);
            await mkdir('test-output', { recursive: true });
            const image = screenshot.content.find((entry) => entry.type === 'image');
            if (image) {
                const { writeFile } = await import('node:fs/promises');
                await writeFile('test-output/global-feedback-frame.png', Buffer.from(image.data, 'base64'));
            }
            await session.evaluate('void fetch("/slow"); true');
            await until(
                () => slowResponse && [...session.requestMap.values()].some((entry) => entry.url.endsWith('/slow'))
            );
            const other = await session.newPage();
            await session.selectPage(initial);
            await unified.withTabId(other.targetId, async () => {
                slowResponse.end('complete');
                await until(() =>
                    session.targetLogs.get(initial)?.network.some((entry) => entry.url.endsWith('/slow'))
                );
            });
            const terminal = session.networkRequests.find((entry) => entry.url.endsWith('/slow'));
            assert.equal(terminal.status, 200);
            assert.equal(terminal.errorText, undefined);
            const native = session.cdp;
            const rawTarget = await native.send('Target.createTarget', { url: base + '/frame' });
            const { sessionId: rawSession } = await native.send('Target.attachToTarget', {
                targetId: rawTarget.targetId,
                flatten: true,
            });
            await until(
                async () =>
                    (
                        await native.send(
                            'Runtime.evaluate',
                            { expression: 'location.href', returnByValue: true },
                            rawSession
                        )
                    ).result.value ===
                    base + '/frame'
            );
            const lateStarts = [],
                lateEnds = [];
            native.onEvent('Network.requestWillBeSent', (event, sid) => {
                if (sid === rawSession) {
                    lateStarts.push(event);
                }
            });
            native.onEvent('Network.loadingFinished', (event, sid) => {
                if (sid === rawSession) {
                    lateEnds.push(event);
                }
            });
            await native.send('Runtime.evaluate', { expression: 'void fetch("/probe-slow")' }, rawSession);
            await until(() => probeResponse);
            await native.send('Network.enable', {}, rawSession);
            await delay(100);
            const replayed = lateStarts.some((event) => event.request.url.endsWith('/probe-slow'));
            probeResponse.end('native late observation');
            await until(() => lateEnds.length > 0);
            await session.evaluate(
                'window.__rootPointer=null;' +
                    'addEventListener("pointermove",e=>' +
                    'window.__rootPointer={clientX:e.clientX,' +
                    'screenX:e.screenX},{once:true});true'
            );
            await native.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100, y: 100 }, session.sessionId);
            const rootPointer = await until(() => session.evaluate('window.__rootPointer'));
            await session.evaluate(
                'Object.assign(document.querySelector("#owned").sty' +
                    'le,{transformOrigin:"0 0",transform:"scale(2)"});' +
                    'true'
            );
            await unified.withFrame('#owned', () =>
                session.evaluate(
                    'window.__childPointer=null;' +
                        'addEventListener("pointermove",e=>' +
                        'window.__childPointer={clientX:e.clientX,' +
                        'screenX:e.screenX,trusted:e.isTrusted},' +
                        '{once:true});true'
                )
            );
            await native.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 540, y: 260 }, session.sessionId);
            const childPointer = await until(() =>
                unified.withFrame('#owned', () => session.evaluate('window.__childPointer'))
            );
            assert.equal(childPointer.trusted, true);
            const translatedOrigin = childPointer.screenX - (childPointer.clientX + 500);
            const nativeOrigin = rootPointer.screenX - rootPointer.clientX;
            assert.notEqual(translatedOrigin, nativeOrigin);
            const { writeFile } = await import('node:fs/promises');
            await writeFile(
                'test-output/global-feedback-candidates.json',
                JSON.stringify(
                    {
                        CE_CAND01: { replayed, starts: lateStarts.length, terminals: lateEnds.length },
                        CE_CAND02: { rootPointer, childPointer, nativeOrigin, translatedOrigin },
                    },
                    null,
                    2
                )
            );
        } finally {
            slowResponse?.end();
            probeResponse?.end();
            const exited = once(browser, 'exit');
            await session.close();
            Object.assign(unified, saved);
            browser.kill();
            await exited;
            await new Promise((resolve) => http.close(resolve));
            await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
        }
    }
);

test('F257/258 credential URLs are redacted in log text and formatted errors', () => {
    const text = 'Failed at https://example.com/api?token=owned-secret&safe=1';
    const log = sanitizeUrlRecord({ text, level: 'error' });
    assert.match(log.text, /token=\[REDACTED]/);
    assert.ok(log.text.includes('safe=1'));
    const response = formatErrorResponse(new Error(text));
    assert.ok(!response.content[0].text.includes('owned-secret'));
});

test('F371 screenshot budget reports its typed limits', () => {
    assert.throws(
        () => assertScreenshotBudget(20000, 1),
        (error) => {
            assert.equal(error.code, 'SCREENSHOT_BUDGET_EXCEEDED');
            assert.equal(error.context.maxDimension, 16384);
            return true;
        }
    );
});

test('F090/F187/F397 unobserved inspection timeouts preserve main and unknown read states', async () => {
    for (const actionStatus of ['not_started', 'completed']) {
        for (const nativeState of ['not_started', 'unknown']) {
            const host = {
                getMode: () => 'cdp',
                getState: () => ({ title: 'Ordinary page' }),
                getChallengeState: async () => {
                    throw setErrorSource(
                        new TimeoutError('Native inspection acknowledgement unavailable', {
                            actionExecuted: nativeState === 'unknown' ? 'unknown' : false,
                            actionStatus: nativeState,
                        }),
                        'protocol'
                    );
                },
            };
            await assert.rejects(waitForChallenge(host, { action: 'evaluate', actionStatus, timeout: 50 }), (error) => {
                assert.equal(error.code, 'TIMEOUT');
                assert.ok(!(error instanceof ChallengeTimeoutError));
                assert.equal(error.context.actionStatus, actionStatus);
                assert.equal(error.context.actionExecuted, actionStatus === 'completed');
                assert.equal(error.context.verificationActionStatus, nativeState);
                assert.equal(error.context.verificationActionExecuted, nativeState === 'unknown' ? 'unknown' : false);
                assert.equal(error.context.verificationStatus, 'unavailable');
                const publicResult = error.toJSON();
                assert.equal(publicResult.actionStatus, actionStatus);
                assert.equal(publicResult.actionExecuted, actionStatus === 'completed');
                assert.equal(publicResult.verificationActionStatus, nativeState);
                assert.equal(publicResult.autoRetry, false);
                assert.equal(error.context.challengeState, 'unverified');
                return true;
            });
        }
    }
    const headerHost = {
        getMode: () => 'cdp',
        getState: () => ({ title: 'Ordinary page' }),
        getChallengeState: async () => ({ state: 'pending' }),
        getLiveState: () => new Promise(() => {}),
    };
    await assert.rejects(
        waitForChallenge(headerHost, { action: 'input', actionStatus: 'completed', timeout: 20 }),
        (error) => {
            assert.ok(error instanceof ChallengeTimeoutError);
            assert.equal(error.challengeKind, 'js');
            assert.equal(error.actionStatus, 'completed');
            return true;
        }
    );
});
