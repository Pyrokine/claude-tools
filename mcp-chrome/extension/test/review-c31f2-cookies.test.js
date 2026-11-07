import assert from 'node:assert/strict';
import test from 'node:test';
import { CookieHandler } from '../src/background/cookie-handler.ts';

for (const cancelAt of [1, 2]) {
    test(`C31F2-01 Extension clear stops after native remove ${cancelAt} when its context is cancelled`, async () => {
        const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
        const controller = new AbortController();
        const removed = [];
        globalThis.chrome = {
            cookies: {
                getAll: async () =>
                    ['first', 'second', 'third'].map((name) => ({
                        name,
                        domain: 'example.com',
                        path: '/',
                        storeId: '0',
                        secure: false,
                    })),
                remove: async ({ name }) => {
                    assert.equal(controller.signal.aborted, false);
                    removed.push(name);
                    if (removed.length === cancelAt) {
                        controller.abort('stop synthetic cookie batch');
                    }
                    return { name };
                },
            },
        };
        try {
            const handler = new CookieHandler();
            await assert.rejects(
                handler.cookiesClear({ domain: 'example.com', storeId: '0' }, { signal: controller.signal }),
                (error) => {
                    const { error: detail } = JSON.parse(error.message);
                    assert.equal(detail.code, 'COOKIE_CLEAR_PARTIAL');
                    assert.equal(detail.context.count, cancelAt);
                    assert.equal(detail.context.attempted, cancelAt);
                    assert.equal(detail.context.unprocessed, 3 - cancelAt);
                    assert.equal(detail.context.actionStatus, 'partial');
                    assert.equal(detail.context.retryable, false);
                    return true;
                }
            );
            assert.equal(removed.length, cancelAt);
        } finally {
            if (previous) {
                Object.defineProperty(globalThis, 'chrome', previous);
            } else {
                Reflect.deleteProperty(globalThis, 'chrome');
            }
        }
    });
}

test('C31F2-01 Extension Cookie actions reject cancellation before any Chrome Cookie API', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    globalThis.chrome = {
        cookies: new Proxy(
            {},
            {
                get() {
                    assert.fail('Cancelled request reached Cookie API');
                },
            }
        ),
    };
    try {
        const controller = new AbortController();
        controller.abort('cancel before dispatch');
        const context = { signal: controller.signal };
        const handler = new CookieHandler();
        for (const [method, args] of [
            ['cookiesGet', { name: 'synthetic' }],
            ['cookiesSet', { name: 'synthetic', url: 'https://example.com/', value: 'value' }],
            ['cookiesDelete', { name: 'synthetic', url: 'https://example.com/' }],
            ['cookiesClear', { domain: 'example.com' }],
        ]) {
            await assert.rejects(handler[method](args, context), (error) => {
                assert.equal(JSON.parse(error.message).error.context.actionStatus, 'not_started');
                return true;
            });
        }
    } finally {
        if (previous) {
            Object.defineProperty(globalThis, 'chrome', previous);
        } else {
            Reflect.deleteProperty(globalThis, 'chrome');
        }
    }
});
