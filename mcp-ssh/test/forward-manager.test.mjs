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
    constructor({ deferForwardIn = false, deferForwardOut = false, dynamicPort = 45678 } = {}) {
        super()
        this.deferForwardIn = deferForwardIn
        this.deferForwardOut = deferForwardOut
        this.dynamicPort = dynamicPort
        this.forwardInCallback = null
        this.forwardOutCallback = null
        this.forwardOutCallbacks = []
        this.forwardOutCalls = 0
        this.lastForwardOutStream = null
        this.unforwardCallback = null
        this.unforwardRequests = []
    }

    forwardOut(_srcHost, _srcPort, _destHost, _destPort, callback) {
        ++this.forwardOutCalls
        if (this.deferForwardOut) {
            this.forwardOutCallback = callback
            this.forwardOutCallbacks.push(callback)
        } else {
            this.lastForwardOutStream = new PassThrough()
            callback(null, this.lastForwardOutStream)
        }
    }

    forwardIn(_host, port, callback) {
        if (this.deferForwardIn) {
            this.forwardInCallback = callback
        } else {
            callback(null, port === 0 ? this.dynamicPort : port)
        }
    }

    unforwardIn(host, port, callback) {
        this.unforwardRequests.push({ host, port })
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
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(client.lastForwardOutStream)

    const result = await manager.close(
        created.forwardId,
        { getClient: () => client },
        { mode: 'force', timeoutMs: 1000 }
    )
    assert.equal(result.success, true)
    assert.equal(result.closeMode, 'force')
    assert.equal(result.listenerReleased, true)
    assert.equal(result.activeConnections, 0)
    assert.equal(client.lastForwardOutStream.destroyed, true)
    assert.equal(manager.list().length, 0)
    socket.destroy()
})

test('remote close timeout retains state and later retry observes completed unforward', async () => {
    const manager = new ForwardManager()
    const client = new FakeClient()
    const deps = { getClient: () => client }
    const { forwardId } = await manager.forwardRemote(deps, 'server', 9000, '127.0.0.1', 3000)

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
    const { forwardId } = await manager.forwardRemote(deps, 'server', 9001, '127.0.0.1', 3001)

    const closePromise = manager.close(forwardId, deps)
    client.unforwardCallback(new Error('unforward failed'))
    const failed = await closePromise
    assert.equal(failed.success, false)
    assert.equal(failed.retryable, true)
    assert.equal(manager.list().length, 1)
})

test('remote dynamic port returns and closes the allocated listener port', async () => {
    const manager = new ForwardManager()
    const client = new FakeClient({ dynamicPort: 49321 })
    const deps = { getClient: () => client }

    const created = await manager.forwardRemote(deps, 'server', 0, '127.0.0.1', 3000)
    assert.equal(created.remotePort, 49321)
    assert.equal(manager.list()[0].remotePort, 49321)

    const closePromise = manager.close(created.forwardId, deps)
    assert.deepEqual(client.unforwardRequests, [{ host: '127.0.0.1', port: 49321 }])
    client.unforwardCallback(null)
    const closed = await closePromise
    assert.equal(closed.success, true)
    assert.equal(closed.remoteUnforwarded, true)
})

test('disconnect cancels pending remote creation and cleans a delayed allocated listener', async () => {
    const manager = new ForwardManager()
    const client = new FakeClient({ deferForwardIn: true })
    const deps = { getClient: () => client }

    const creation = manager.forwardRemote(deps, 'server', 0, '127.0.0.1', 3000)
    manager.closeByAlias('server')
    await assert.rejects(creation, /disconnected during forward creation/)

    client.forwardInCallback(null, 49322)
    assert.deepEqual(client.unforwardRequests, [{ host: '127.0.0.1', port: 49322 }])
    assert.equal(manager.list().length, 0)
})

test('closing a pending remote forward reports cleanup failure and preserves retry state', async () => {
    const manager = new ForwardManager()
    const client = new FakeClient({ deferForwardIn: true })
    const deps = { getClient: () => client }

    const creation = manager.forwardRemote(deps, 'server', 0, '127.0.0.1', 3000)
    const forwardId = Array.from(manager.sessions.keys())[0]
    const creationFailure = assert.rejects(creation, /closed before listener creation completed/)
    const closePromise = manager.close(forwardId, deps, { timeoutMs: 1000 })
    await creationFailure

    client.forwardInCallback(null, 49323)
    assert.deepEqual(client.unforwardRequests, [{ host: '127.0.0.1', port: 49323 }])
    client.unforwardCallback(new Error('injected pending cleanup failure'))
    const failed = await closePromise
    assert.equal(failed.success, false)
    assert.equal(failed.retryable, true)
    assert.match(failed.error, /pending cleanup failure/)
    assert.equal(manager.sessions.has(forwardId), true)

    const retryPromise = manager.close(forwardId, deps, { timeoutMs: 1000 })
    assert.deepEqual(client.unforwardRequests, [
        { host: '127.0.0.1', port: 49323 },
        { host: '127.0.0.1', port: 49323 },
    ])
    client.unforwardCallback(null)
    const closed = await retryPromise
    assert.equal(closed.success, true)
    assert.equal(closed.remoteUnforwarded, true)
    assert.equal(manager.sessions.has(forwardId), false)
})

test('disconnect cancels a pending local listener before it can be published', async () => {
    const manager = new ForwardManager()
    const client = new FakeClient()

    const creation = manager.forwardLocal({ getClient: () => client }, 'server', 0, '127.0.0.1', 80)
    manager.closeByAlias('server')

    await assert.rejects(creation, /disconnected during forward creation/)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(manager.list().length, 0)
})

test('pending forwardOut keeps close retryable until its callback is drained', async () => {
    const manager = new ForwardManager()
    const client = new FakeClient({ deferForwardOut: true })
    const deps = { getClient: () => client }
    const created = await manager.forwardLocal(deps, 'server', 0, '127.0.0.1', 80)
    const socket = await connect(created.localPort)

    const timedOut = await manager.close(created.forwardId, deps, { mode: 'force', timeoutMs: 5 })
    assert.equal(timedOut.success, false)
    assert.equal(timedOut.activeConnections, 0)
    assert.equal(timedOut.retryable, true)
    assert.equal(manager.list().length, 1)
    await assert.rejects(
        manager.forwardLocal(deps, 'server', 0, '127.0.0.1', 80),
        /unresolved SSH channel open/
    )

    const delayedStream = new PassThrough()
    client.forwardOutCallback(null, delayedStream)
    assert.equal(delayedStream.destroyed, true)
    const closed = await manager.close(created.forwardId, deps, { mode: 'force', timeoutMs: 1000 })
    assert.equal(closed.success, true)
    assert.equal(closed.activeConnections, 0)
    assert.equal(manager.list().length, 0)
    socket.destroy()
})

test('local forwards bound pending SSH channel opens per alias', async () => {
    const manager = new ForwardManager()
    const client = new FakeClient({ deferForwardOut: true })
    const deps = { getClient: () => client }
    const created = await manager.forwardLocal(deps, 'server', 0, '127.0.0.1', 80)
    const sockets = await Promise.all(Array.from({ length: 33 }, () => connect(created.localPort)))
    for (let attempt = 0; attempt < 100 && client.forwardOutCalls < 32; ++attempt) {
        await new Promise((resolve) => setImmediate(resolve))
    }

    assert.equal(client.forwardOutCalls, 32)
    for (const callback of client.forwardOutCallbacks) {
        callback(new Error('injected channel-open failure'))
    }
    await new Promise((resolve) => setImmediate(resolve))
    manager.closeByAlias('server')
    assert.equal(manager.list().length, 0)
    for (const socket of sockets) {
        socket.destroy()
    }
})

test('force remote close rejects incoming connections while unforward is pending', async () => {
    const manager = new ForwardManager()
    const client = new FakeClient()
    const deps = { getClient: () => client }
    const created = await manager.forwardRemote(deps, 'server', 9002, '127.0.0.1', 3002)

    const closePromise = manager.close(created.forwardId, deps, { mode: 'force', timeoutMs: 1000 })
    let accepted = 0
    let rejected = 0
    client.emit(
        'tcp connection',
        { destIP: '127.0.0.1', destPort: 9002, srcIP: '127.0.0.1', srcPort: 41000 },
        () => {
            ++accepted
            return new PassThrough()
        },
        () => {
            ++rejected
        }
    )

    assert.equal(accepted, 0)
    assert.equal(rejected, 1)
    client.unforwardCallback(null)

    const closed = await closePromise
    assert.equal(closed.success, true)
    assert.equal(closed.activeConnections, 0)
    assert.equal(manager.list().length, 0)
})

test('disconnect during remote close prevents delayed callback from republishing state', async () => {
    const manager = new ForwardManager()
    const client = new FakeClient()
    const deps = { getClient: () => client }
    const created = await manager.forwardRemote(deps, 'server', 9003, '127.0.0.1', 3003)

    const closePromise = manager.close(created.forwardId, deps, { timeoutMs: 1000 })
    manager.closeByAlias('server')
    client.unforwardCallback(null)

    const closed = await closePromise
    assert.equal(closed.success, true)
    assert.equal(closed.remoteUnforwarded, false)
    assert.equal(manager.list().length, 0)
})
