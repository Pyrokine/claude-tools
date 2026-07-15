import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { PtyManager } from '../dist/pty-manager.js'

class FakePtyStream extends EventEmitter {
    write() {
        return true
    }

    close() {
        this.emit('close')
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
    assert.equal(manager.close(ptyId), true)
    assert.throws(() => manager.read(ptyId), /not found/)
})
