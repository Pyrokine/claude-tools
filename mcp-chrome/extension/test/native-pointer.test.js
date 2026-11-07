import './finding-regressions.test.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { observeNativePointer } from '../src/background/page-scripts';
import { ContentHandler } from '../src/background/content-handler';

function pointerWorld() {
    const listeners = new Set();
    const timers = new Map();
    let next = 0;
    const scope = {
        window: { devicePixelRatio: 1.25 },
        Date: { now: () => 1000 },
        addEventListener: (_name, fn) => listeners.add(fn),
        removeEventListener: (_name, fn) => listeners.delete(fn),
        setTimeout: (fn) => {
            timers.set(++next, fn);
            return next;
        },
        clearTimeout: (id) => timers.delete(id),
    };
    const observe = vm.runInNewContext('(' + observeNativePointer.toString() + ')', scope);
    return {
        observe,
        listeners,
        timers,
        send: (isTrusted) => {
            for (const fn of listeners) {
                fn({ isTrusted, clientX: 20, clientY: 30, screenX: 200, screenY: 300 });
            }
        },
    };
}

test('native pointer observer accepts only trusted events and releases listeners', () => {
    const w = pointerWorld();
    w.observe('start', 'owned', 2000);
    w.send(false);
    assert.equal(w.observe('read', 'owned', 2000).sample, undefined);
    w.send(true);
    const sample = w.observe('read', 'owned', 2000).sample;
    assert.equal(sample.screenY, 300);
    assert.equal(sample.scale, 1.25);
    assert.equal(w.observe('read', 'other', 2000).active, false);
    w.observe('stop', 'owned', 2000);
    assert.equal(w.listeners.size, 0);
    assert.equal(w.timers.size, 0);
});

test('native pointer observer expires and replaces an old document-local probe', () => {
    const w = pointerWorld();
    w.observe('start', 'first', 2000);
    w.observe('start', 'second', 2000);
    assert.equal(w.listeners.size, 1);
    assert.equal(w.timers.size, 1);
    for (const expire of w.timers.values()) {
        expire();
    }
    assert.equal(w.listeners.size, 0);
    assert.equal(w.observe('read', 'second', 2000).active, false);
});

test('native pointer action derives the current origin and rejects stale or foreign samples', async () => {
    const saved = globalThis.chrome;
    let sample = {
        previousAt: 1000,
        sameTarget: true,
        at: 1001,
        screenX: 280,
        screenY: 326,
        clientX: 280,
        clientY: 227,
        scale: 1,
    };
    let documentId = 'owned-document';
    globalThis.chrome = {
        scripting: { executeScript: async () => [{ frameId: 0, documentId, result: { active: true, sample } }] },
        webNavigation: { getFrame: async () => ({ documentId }) },
    };
    const handler = new ContentHandler({});
    handler.getManagedScriptableTabId = async () => 7;
    const params = {
        tabId: 7,
        pointerProbe: { operation: 'read', id: 'owned', documentId, since: 1000, position: { x: 280, y: 326 } },
    };
    try {
        const origin = await handler.getViewportMetrics(params, {});
        assert.equal(origin.x, 0);
        assert.equal(origin.y, 99);
        sample = { ...sample, at: 999 };
        params.deadline = Date.now() + 20;
        await assert.rejects(handler.getViewportMetrics(params, {}), /timeout|超时/i);
        sample = { ...sample, at: 1001, screenX: 281 };
        params.deadline = Date.now() + 20;
        await assert.rejects(handler.getViewportMetrics(params, {}), /timeout|超时/i);
        documentId = 'navigated';
        await assert.rejects(handler.getViewportMetrics(params, {}), /主文档已变化/);
    } finally {
        globalThis.chrome = saved;
    }
});
