import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { OperationManager } from '../dist/operation-manager.js'

function createChannel() {
    const stream = new PassThrough()
    stream.stderr = new PassThrough()
    return stream
}

function waitForEvents() {
    return new Promise((resolve) => setImmediate(resolve))
}

function createDeferred() {
    let resolve
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise
    })
    return { promise, resolve }
}

test('tracked operation verifies marker, bounds output, reads offsets, and cancels verified PID', async (t) => {
    const channel = createChannel()
    let cancelRequest
    const manager = new OperationManager({
        async openStream(_alias, _command, marker) {
            channel.marker = marker
            return channel
        },
        async cancelRemote(alias, pid, marker, processGroup) {
            cancelRequest = { alias, pid, marker, processGroup }
            return { success: true }
        },
    })
    t.after(() => manager.close())

    const started = await manager.start('server', 'sleep 60', { maxOutputBytes: 11 })
    assert.match(started.operationId, /^op_[0-9a-f-]{36}$/)
    assert.equal(started.status, 'starting')

    channel.stderr.write(`__MCP_SSH_OPERATION__:${channel.marker}:4321:1\nerr`)
    channel.write('abcdefghijk')
    await waitForEvents()

    const status = manager.status(started.operationId)
    assert.equal(status.status, 'running')
    assert.equal(status.pid, 4321)
    assert.equal(status.markerVerified, true)
    assert.equal(status.stdoutBytes, 11)
    assert.equal(status.stdoutStoredBytes, 8)
    assert.equal(status.stderrStoredBytes, 3)
    assert.equal(status.stderrBytes, 3)
    assert.equal(status.stdoutTruncated, true)

    const firstRead = manager.read(started.operationId, { maxBytes: 4 })
    assert.equal(firstRead.stdout, 'abcd')
    assert.equal(firstRead.nextStdoutOffset, 4)
    const secondRead = manager.read(started.operationId, { stdoutOffset: 4, maxBytes: 4 })
    assert.equal(secondRead.stdout, 'efgh')

    const cancelled = await manager.cancel(started.operationId)
    assert.equal(cancelled.success, true)
    assert.deepEqual(cancelRequest, {
        alias: 'server',
        pid: 4321,
        marker: channel.marker,
        processGroup: true,
    })

    channel.emit('close', null, 'TERM')
    assert.equal(manager.status(started.operationId).status, 'cancelled')
})

test('tracked operation defers stream close until cancellation succeeds', async (t) => {
    const channel = createChannel()
    const cancellation = createDeferred()
    const manager = new OperationManager({
        async openStream(_alias, _command, marker) {
            channel.marker = marker
            return channel
        },
        async cancelRemote() {
            return cancellation.promise
        },
    })
    t.after(() => manager.close())

    const started = await manager.start('server', 'sleep 60')
    channel.stderr.write(`__MCP_SSH_OPERATION__:${channel.marker}:4321:1\n`)
    await waitForEvents()

    const cancelPromise = manager.cancel(started.operationId)
    await waitForEvents()
    channel.emit('close', 0, 'TERM')
    assert.equal(manager.status(started.operationId).status, 'running')

    cancellation.resolve({ success: true })
    const cancelled = await cancelPromise
    assert.equal(cancelled.success, true)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.cancelRequested, true)
    assert.equal(cancelled.signal, 'TERM')
})

test('tracked operation preserves natural completion when cancellation verification fails', async (t) => {
    const channel = createChannel()
    const cancellation = createDeferred()
    const manager = new OperationManager({
        async openStream(_alias, _command, marker) {
            channel.marker = marker
            return channel
        },
        async cancelRemote() {
            return cancellation.promise
        },
    })
    t.after(() => manager.close())

    const started = await manager.start('server', 'sleep 60')
    channel.stderr.write(`__MCP_SSH_OPERATION__:${channel.marker}:4321:0\n`)
    await waitForEvents()

    const cancelPromise = manager.cancel(started.operationId)
    await waitForEvents()
    channel.emit('close', 0)
    assert.equal(manager.status(started.operationId).status, 'running')

    cancellation.resolve({ success: false, error: 'marker verification failed' })
    const notCancelled = await cancelPromise
    assert.equal(notCancelled.success, false)
    assert.equal(notCancelled.status, 'completed')
    assert.equal(notCancelled.cancelRequested, false)
    assert.equal(notCancelled.verificationError, 'marker verification failed')
})

test('tracked operation reads UTF-8 output without splitting characters', async (t) => {
    const channel = createChannel()
    const manager = new OperationManager({
        async openStream(_alias, _command, marker) {
            channel.marker = marker
            return channel
        },
        async cancelRemote() {
            return { success: true }
        },
    })
    t.after(() => manager.close())

    const started = await manager.start('server', 'printf "A😀B"')
    channel.stderr.write(`__MCP_SSH_OPERATION__:${channel.marker}:4321:0\n`)
    const output = Buffer.from('A😀B')
    channel.write(output.subarray(0, 3))
    await waitForEvents()

    const first = manager.read(started.operationId, { maxBytes: 4 })
    assert.equal(first.stdout, 'A')
    assert.equal(first.nextStdoutOffset, 1)

    channel.write(output.subarray(3))
    await waitForEvents()
    const second = manager.read(started.operationId, { stdoutOffset: first.nextStdoutOffset, maxBytes: 4 })
    assert.equal(second.stdout, '😀')
    assert.equal(second.nextStdoutOffset, 5)

    assert.throws(
        () => manager.read(started.operationId, { stdoutOffset: 2, maxBytes: 4 }),
        /UTF-8 character boundary/
    )
})

test('tracked operation refuses cancel before marker verification and becomes unknown on disconnect', async (t) => {
    const channel = createChannel()
    let cancelCalled = false
    const manager = new OperationManager({
        async openStream() {
            return channel
        },
        async cancelRemote() {
            cancelCalled = true
            return { success: true }
        },
    })
    t.after(() => manager.close())

    const started = await manager.start('server', 'sleep 60')
    const cancel = await manager.cancel(started.operationId)
    assert.equal(cancel.success, false)
    assert.equal(cancel.retryable, true)
    assert.equal(cancelCalled, false)

    manager.markAliasDisconnected('server')
    const status = manager.status(started.operationId)
    assert.equal(status.status, 'unknown')
    assert.match(status.error, /disconnected/)
})
