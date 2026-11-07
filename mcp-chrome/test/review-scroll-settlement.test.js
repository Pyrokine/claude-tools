import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const inputSource = fs.readFileSync(new URL('../src/tools/input.ts', import.meta.url), 'utf8');
const start = inputSource.indexOf('async function getTargetPointExtension(');
const end = inputSource.indexOf('\ninterface CdpInputContext', start);
assert.ok(start >= 0 && end > start);
const code = ts.transpileModule(inputSource.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;

function fixture(scene) {
    const targets = [],
        ports = [],
        frames = new Map(),
        pending = new Set();
    let nextFrame = 0,
        sourceEvents = 0,
        cancelled = false;
    class Target {
        constructor() {
            this.listeners = new Map();
            this.scrollLeft = 0;
            this.scrollTop = 0;
            targets.push(this);
        }

        addEventListener(type, listener) {
            if (!this.listeners.has(type)) {
                this.listeners.set(type, new Set());
            }
            this.listeners.get(type).add(listener);
        }

        removeEventListener(type, listener) {
            this.listeners.get(type)?.delete(listener);
        }

        emit(type, target) {
            const event = { target, currentTarget: this };
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }

        getRootNode() {
            return document;
        }
    }
    const window = new Target(),
        document = new Target(),
        inner = new Target(),
        second = new Target(),
        el = new Target();
    const rect = { x: 60, y: 2100, top: 2100, bottom: 2150, left: 60, right: 120, width: 60, height: 50 };
    el.parentElement = inner;
    el.isConnected = true;
    el.ownerDocument = document;
    el.getBoundingClientRect = () => ({ ...rect });
    el.scrollIntoView = () => {
        inner.scrollTop = 100;
        rect.y = rect.top = 90;
        rect.bottom = 140;
        pending.add(inner);
    };
    window.scrollX = window.scrollY = 0;
    window.innerWidth = window.innerHeight = 400;
    window.__mcpElementMap = { pad: new WeakRef(el) };
    document.visibilityState = 'visible';
    const mutate = (node) => {
        if (node === inner) {
            if (scene === 'unrelated') {
                rect.x = 230;
            }
            second.scrollTop = 60;
            pending.add(second);
        } else {
            ++sourceEvents;
            if (scene === 'finite' && sourceEvents === 4) {
                rect.x = 230;
            } else {
                second.scrollTop = scene === 'finite' ? second.scrollTop + 10 : second.scrollTop === 60 ? 70 : 60;
                if (scene === 'moving') {
                    rect.x = rect.x === 100 ? 120 : 100;
                }
                pending.add(second);
            }
        }
    };
    const realm = vm.createContext({
        window,
        document,
        console,
        setTimeout,
        clearTimeout,
        globalThis: { __mcpDomHelpers: { elements: () => [el, inner, second] } },
        requestAnimationFrame: (callback) => {
            const id = ++nextFrame;
            frames.set(
                id,
                setImmediate(() => {
                    frames.delete(id);
                    const current = [...pending];
                    pending.clear();
                    for (const node of current) {
                        document.emit('scroll', node);
                        mutate(node);
                        document.emit('scrollend', node);
                    }
                    callback();
                })
            );
            return id;
        },
        cancelAnimationFrame: (id) => {
            clearImmediate(frames.get(id));
            frames.delete(id);
        },
        MessageChannel: class {
            constructor() {
                this.port1 = {
                    close() {
                        this.closed = true;
                    },
                };
                this.port2 = {
                    close() {
                        this.closed = true;
                    },
                    postMessage: (data) =>
                        setImmediate(() => {
                            if (!this.port1.closed) {
                                this.port1.onmessage({ data });
                            }
                        }),
                };
                ports.push(this.port1, this.port2);
            }
        },
    });
    const host = vm.createContext({
        DEFAULT_TIMEOUT: 100,
        targetToFindParams: () => ({ selector: '#pad' }),
        throwInputTimeoutError: () => {
            throw new Error('TIMEOUT');
        },
    });
    const locate = vm.runInContext(code + '\ngetTargetPointExtension', host);
    const session = {
        find: async () => [{ refId: 'pad' }],
        evaluate: (expression) => {
            session.pageExecution = vm.runInContext(expression, realm);
            if (!cancelled) {
                return session.pageExecution;
            }
            return Promise.reject(new Error('REQUEST_CANCELLED'));
        },
    };
    return {
        locate: () => locate(session, { css: '#pad' }, 100),
        cancelTransport: () => {
            cancelled = true;
        },
        session,
        get sourceEvents() {
            return sourceEvents;
        },
        assertReleased() {
            assert.equal(
                targets.reduce(
                    (count, target) => count + [...target.listeners.values()].reduce((n, values) => n + values.size, 0),
                    0
                ),
                0
            );
            assert.equal(frames.size, 0);
            assert.equal(ports.length, 2);
            assert.ok(ports.every((port) => port.closed));
        },
    };
}

for (const scene of ['unrelated', 'finite']) {
    test(`scroll settlement ${scene} source preserves target and releases observers`, async () => {
        const page = fixture(scene);
        const point = await page.locate();
        assert.equal(point.x, 260);
        if (scene === 'finite') {
            assert.equal(page.sourceEvents, 4);
        }
        page.assertReleased();
    });
}

test('related continuous movement reaches its original deadline and releases observers', async () => {
    const page = fixture('moving');
    await assert.rejects(page.locate(), /SCROLL_SETTLEMENT_TIMEOUT|TIMEOUT/);
    page.assertReleased();
});

test('cancelled evaluation transport preserves the in-page deadline cleanup', async () => {
    const page = fixture('moving');
    page.cancelTransport();
    await assert.rejects(page.locate(), /REQUEST_CANCELLED/);
    await assert.rejects(page.session.pageExecution, /SCROLL_SETTLEMENT_TIMEOUT/);
    page.assertReleased();
});
