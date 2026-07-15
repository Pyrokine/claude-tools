import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { ForwardManager } from '../dist/forward-manager.js'

function listen(port) {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve(server))
    })
}

function connect(port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1')
        socket.once('connect', () => resolve(socket))
        socket.once('error', reject)
    })
}

class FakeClient extends EventEmitter {
    constructor() {
        super()
        this.unforwardCallback = null
    }

    forwardOut(_srcHost, _srcPort, _destHost, _destPort, callback) {
        callback(null, new PassThrough())
    }

    forwardIn(_host, _port, callback) {
        callback(null)
    }

    unforwardIn(_host, _port, callback) {
        this.unforwardCallback = callback
    }
}

test('graceful local close waits for listener release and permits immediate rebind', async () => {
    const manager = new ForwardManager()
    const client = new FakeClient()
    const created = await manager.forwardLocal({ getClient: () => client }, 'server', 0, '127.0.0.1', 80)

    const result = await manager.close(created.forwardId, { getClient: () => client })
    assert.equal(result.success, true)
    assert.equal(result.listenerReleased, true)
    assert.equal(result.remoteUnforwarded, false)
    assert.equal(manager.list().length, 0)

    const rebound = await listen(created.localPort)
    await new Promise((resolve) => rebound.close(resolve))
})

test('graceful local timeout reports released listener and retains state for force retry', async () => {
    const manager = new ForwardManager()
    const client = new FakeClient()
    const created = await manager.forwardLocal({ getClient: () => client }, 'server', 0, '127.0.0.1', 80)
    const socket = await connect(created.localPort)

    const timedOut = await manager.close(
        created.forwardId,
        { getClient: () => client },
        { mode: 'graceful', timeoutMs: 5 }
    )
    assert.equal(timedOut.success, false)
    assert.equal(timedOut.listenerReleased, true)
    assert.equal(timedOut.activeConnections, 1)
    assert.equal(manager.list().length, 1)

    const forced = await manager.close(
        created.forwardId,
        { getClient: () => client },
        { mode: 'force', timeoutMs: 1000 }
    )
    assert.equal(forced.success, true)
    assert.equal(forced.listenerReleased, true)
    assert.equal(manager.list().length, 0)
    socket.destroy()
})

test('force local close destroys active connections before releasing listener', async () => {
    const manager = new ForwardManager()
    const client = new FakeClient()
    const created = await manager.forwardLocal({ getClient: () => client }, 'server', 0, '127.0.0.1', 80)
    const socket = await connect(created.localPort)

    const result = await manager.close(
        created.forwardId,
        { getClient: () => client },
        { mode: 'force', timeoutMs: 1000 }
    )
    assert.equal(result.success, true)
    assert.equal(result.closeMode, 'force')
    assert.equal(result.listenerReleased, true)
    assert.equal(manager.list().length, 0)
    socket.destroy()
})

test('remote close timeout retains state and later retry observes completed unforward', async () => {
    const manager = new ForwardManager()
    const client = new FakeClient()
    const deps = { getClient: () => client }
    const forwardId = await manager.forwardRemote(deps, 'server', 9000, '127.0.0.1', 3000)

    const timedOut = await manager.close(forwardId, deps, { timeoutMs: 5 })
    assert.equal(timedOut.success, false)
    assert.equal(timedOut.retryable, true)
    assert.equal(manager.list().length, 1)

    client.unforwardCallback(null)
    const retried = await manager.close(forwardId, deps, { timeoutMs: 100 })
    assert.equal(retried.success, true)
    assert.equal(retried.remoteUnforwarded, true)
    assert.equal(manager.list().length, 0)
})

test('remote unforward failure retains state for retry', async () => {
    const manager = new ForwardManager()
    const client = new FakeClient()
    const deps = { getClient: () => client }
    const forwardId = await manager.forwardRemote(deps, 'server', 9001, '127.0.0.1', 3001)

    const closePromise = manager.close(forwardId, deps)
    client.unforwardCallback(new Error('unforward failed'))
    const failed = await closePromise
    assert.equal(failed.success, false)
    assert.equal(failed.retryable, true)
    assert.equal(manager.list().length, 1)
})
