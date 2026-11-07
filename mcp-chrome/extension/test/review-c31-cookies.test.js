import assert from 'node:assert/strict';
import test from 'node:test';
import { CookieHandler } from '../src/background/cookie-handler.ts';

test('C31-05 Extension backend refuses missing or blank filters before Chrome Cookie API', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    const calls = [];
    globalThis.chrome = {
        cookies: {
            getAll: async (filter) => {
                calls.push(filter);
                return [];
            },
        },
    };
    try {
        const handler = new CookieHandler();
        for (const filter of [
            {},
            { targetId: '101' },
            { storeId: '0' },
            { secure: true },
            { session: true },
            { path: '/' },
            { name: '' },
            { domain: ' ' },
            { url: '\t' },
        ]) {
            await assert.rejects(handler.cookiesGet(filter), /name.*domain.*url/);
        }
        assert.equal(calls.length, 0);
        for (const filter of [{ name: 'sid' }, { domain: 'example.com' }, { url: 'https://example.com/' }]) {
            await handler.cookiesGet({ ...filter, storeId: '0' });
        }
        assert.deepEqual(calls, [
            { name: 'sid', storeId: '0' },
            { domain: 'example.com', storeId: '0' },
            { url: 'https://example.com/', storeId: '0' },
        ]);
    } finally {
        if (previous) {
            Object.defineProperty(globalThis, 'chrome', previous);
        } else {
            Reflect.deleteProperty(globalThis, 'chrome');
        }
    }
});
