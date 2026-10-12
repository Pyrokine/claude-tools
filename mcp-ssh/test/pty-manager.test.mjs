import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { PtyManager } from '../dist/pty-manager.js'

// noinspection JSUnusedGlobalSymbols — structural test double
class FakePtyStream extends EventEmitter {
    constructor({ backpressured = false, closeError } = {}) {
        super()
        this.backpressured = backpressured
        this.closeError = closeError
        this.destroyed = false
    }

    write() {
        return !this.backpressured
    }

    close() {
        if (this.closeError) {
            throw this.closeError
        }
        this.emit('close')
    }

    destroy() {
        this.destroyed = true
    }

    setWindow() {}
}

test('naturally completed PTY retains its final screen until explicit close', async () => {
    const stream = new FakePtyStream()
    const manager = new PtyManager()
    const ptyId = await manager.start(
        {
            async execPty() {
                return stream
            },
        },
        'test',
        'top -b -n 1',
        { rows: 4, cols: 40 }
    )

    stream.emit('data', Buffer.from('PID USER CPU\r\n1 root 0.0\r\n'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    stream.emit('close')

    const result = manager.read(ptyId, { mode: 'screen' })
    assert.equal(result.active, false)
    assert.match(result.data, /PID USER CPU/)
    assert.deepEqual(manager.close(ptyId), {
        success: true,
        ptyId,
        status: 'closed',
        retryable: false,
    })
    assert.throws(() => manager.read(ptyId), /not found/)
})

test('PTY write reports backpressure without reporting a rejected input', async () => {
    const stream = new FakePtyStream({ backpressured: true })
    const manager = new PtyManager()
    const ptyId = await manager.start(
        {
            async execPty() {
                return stream
            },
        },
        'test',
        'cat'
    )

    assert.deepEqual(manager.write(ptyId, 'input'), {
        accepted: true,
        backpressured: true,
    })
})

test('PTY raw output uses UTF-8 byte limits and reports discarded history until clear', async () => {
    const stream = new FakePtyStream()
    const manager = new PtyManager()
    const ptyId = await manager.start(
        {
            async execPty() {
                return stream
            },
        },
        'test',
        'printf output',
        { rows: 4, cols: 40, bufferSize: 7 }
    )
    const output = Buffer.from('中中😀')
    stream.emit('data', output.subarray(0, 1))
    stream.emit('data', output.subarray(1, 4))
    stream.emit('data', output.subarray(4, 8))
    stream.emit('data', output.subarray(8))
    await new Promise((resolve) => setTimeout(resolve, 10))

    const retained = manager.read(ptyId, { mode: 'raw', clear: false })
    assert.equal(retained.data, '中😀')
    assert.deepEqual(Buffer.from(retained.dataBase64, 'base64'), output.subarray(-7))
    assert.equal(retained.unreadRawBytes, 7)
    assert.equal(retained.rawBufferLimit, 7)
    assert.equal(retained.rawBufferTruncated, true)
    assert.match(manager.read(ptyId, { mode: 'screen' }).data, /中中😀/)
    assert.deepEqual(
        manager.list().map(({ bufferSize, unreadRawBytes, rawBufferLimit, rawBufferTruncated }) => ({
            bufferSize,
            unreadRawBytes,
            rawBufferLimit,
            rawBufferTruncated,
        })),
        [{ bufferSize: 7, unreadRawBytes: 7, rawBufferLimit: 7, rawBufferTruncated: true }]
    )

    const cleared = manager.read(ptyId, { mode: 'raw' })
    assert.equal(cleared.data, '中😀')
    assert.equal(cleared.unreadRawBytes, 7)
    assert.equal(cleared.rawBufferTruncated, true)
    assert.equal(manager.list()[0].bufferSize, 0)
    assert.equal(manager.list()[0].unreadRawBytes, 0)
    assert.equal(manager.list()[0].rawBufferTruncated, false)
    assert.deepEqual(manager.read(ptyId, { mode: 'raw' }), {
        data: '',
        dataBase64: '',
        active: true,
        rows: 4,
        cols: 40,
        lastInputAt: null,
        lastOutputAt: retained.lastOutputAt,
        lastReadAt: manager.list()[0].lastReadAt,
        unreadRawBytes: 0,
        rawBufferLimit: 7,
        rawBufferTruncated: false,
        foregroundProcess: 'printf output',
    })
})

test('PTY close failure retains the session for retry', async () => {
    const stream = new FakePtyStream({ closeError: new Error('injected close failure') })
    const manager = new PtyManager()
    const ptyId = await manager.start(
        {
            async execPty() {
                return stream
            },
        },
        'test',
        'cat'
    )

    assert.deepEqual(manager.close(ptyId), {
        success: false,
        ptyId,
        status: 'failed',
        retryable: true,
        error: 'injected close failure',
    })
    assert.equal(manager.list().length, 1)
    assert.equal(manager.read(ptyId, { mode: 'raw' }).active, true)
})

test('PTY disconnect cleanup removes sessions even when graceful close fails', async () => {
    const stream = new FakePtyStream({ closeError: new Error('injected close failure') })
    const manager = new PtyManager()
    const ptyId = await manager.start(
        {
            async execPty() {
                return stream
            },
        },
        'test',
        'cat'
    )
    manager.closeByAlias('test')

    assert.equal(stream.destroyed, true)
    assert.equal(manager.list().length, 0)
    assert.throws(() => manager.read(ptyId), /not found/)
})
