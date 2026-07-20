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

async function assertTerminalMarkerFailure(manager, channel, operationId) {
    const status = manager.status(operationId)
    assert.equal(status.status, 'failed')
    assert.notEqual(status.finishedAt, null)
    assert.equal(status.expiresAt, status.finishedAt + status.retentionMs)
    assert.equal(channel.destroyed, true)

    const cancel = await manager.cancel(operationId)
    assert.equal(cancel.success, false)
    assert.equal(cancel.retryable, false)
    assert.match(cancel.verificationError, /Operation is failed/)
    return status
}

test('operation start timeout leaves a queryable record and blocks duplicate pending channel opens', async (t) => {
    let adoptStream
    let resolveOpening
    const manager = new OperationManager({
        async openStream(_alias, _command, _marker, _options, adopt) {
            adoptStream = adopt
            return new Promise((resolve) => {
                resolveOpening = resolve
            })
        },
        async cancelRemote() {
            return { success: true }
        },
    })
    t.after(() => manager.close())

    const pending = manager.start('server', 'sleep 1', { startTimeoutMs: 10, retentionMs: 60_000 })
    await waitForEvents()
    const [starting] = manager.list('server')
    assert.equal(starting.status, 'starting')
    await assert.rejects(manager.start('server', 'sleep 2'), /already has an operation start/)

    await assert.rejects(pending, (error) => {
        assert.match(error.message, /timed out/)
        assert.equal(error.details.operationId, starting.operationId)
        return true
    })
    const timedOut = manager.status(starting.operationId)
    assert.equal(timedOut.status, 'unknown')
    assert.notEqual(timedOut.finishedAt, null)
    assert.equal(timedOut.expiresAt, timedOut.finishedAt + timedOut.retentionMs)

    const lateChannel = createChannel()
    assert.throws(() => adoptStream(lateChannel), /arrived after operation start finished/)
    assert.equal(lateChannel.destroyed, true)
    resolveOpening()
    await waitForEvents()
    assert.equal(manager.pendingStarts.size, 0)
})

test('tracked operation observes marker and close emitted before openStream returns', async (t) => {
    const channel = createChannel()
    const manager = new OperationManager({
        async openStream(_alias, _command, marker, _options, adopt) {
            adopt(channel)
            channel.stderr.write(`__MCP_SSH_OPERATION__:${marker}:4321:0\n`)
            channel.emit('close', 0)
        },
        async cancelRemote() {
            return { success: true }
        },
    })
    t.after(() => manager.close())

    const started = await manager.start('server', 'true', { retentionMs: 60_000 })
    assert.equal(started.status, 'completed')
    assert.equal(started.markerVerified, true)
    assert.notEqual(started.finishedAt, null)
    assert.equal(started.expiresAt, started.finishedAt + 60_000)
})

test('tracked operation verifies marker, bounds output, reads offsets, and cancels verified PID', async (t) => {
    const channel = createChannel()
    let cancelRequest
    const manager = new OperationManager({
        async openStream(_alias, _command, marker, _options, adopt) {
            channel.marker = marker
            adopt(channel)
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
        async openStream(_alias, _command, marker, _options, adopt) {
            channel.marker = marker
            adopt(channel)
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
        async openStream(_alias, _command, marker, _options, adopt) {
            channel.marker = marker
            adopt(channel)
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
        async openStream(_alias, _command, marker, _options, adopt) {
            channel.marker = marker
            adopt(channel)
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

    assert.throws(() => manager.read(started.operationId, { stdoutOffset: 2, maxBytes: 4 }), /UTF-8 character boundary/)
})

test('tracked operation refuses cancel before marker verification and becomes unknown on disconnect', async (t) => {
    const channel = createChannel()
    let cancelCalled = false
    const manager = new OperationManager({
        async openStream(_alias, _command, _marker, _options, adopt) {
            adopt(channel)
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

test('tracked operation preserves stderr preamble before a valid marker', async (t) => {
    const channel = createChannel()
    const manager = new OperationManager({
        async openStream(_alias, _command, marker, _options, adopt) {
            channel.marker = marker
            adopt(channel)
        },
        async cancelRemote() {
            return { success: true }
        },
    })
    t.after(() => manager.close())

    const started = await manager.start('server', 'sleep 1')
    channel.stderr.write('profile warning')
    channel.stderr.write(`\nsecond warning\n__MCP_SSH_OPERATION__:${channel.marker}:7654:0\nafter marker`)
    await waitForEvents()

    const status = manager.status(started.operationId)
    assert.equal(status.status, 'running')
    assert.equal(status.pid, 7654)
    assert.equal(status.stderrBytes, Buffer.byteLength('profile warning\nsecond warning\nafter marker'))
    assert.equal(manager.read(started.operationId).stderr, 'profile warning\nsecond warning\nafter marker')
})

test('tracked operation finds a marker after an unterminated stderr preamble', async (t) => {
    const channel = createChannel()
    const manager = new OperationManager({
        async openStream(_alias, _command, marker, _options, adopt) {
            channel.marker = marker
            adopt(channel)
        },
        async cancelRemote() {
            return { success: true }
        },
    })
    t.after(() => manager.close())

    const started = await manager.start('server', 'sleep 1')
    const marker = `__MCP_SSH_OPERATION__:${channel.marker}:7654:0\n`
    channel.stderr.write(`profile warning without newline${marker.slice(0, 11)}`)
    channel.stderr.write(marker.slice(11))
    await waitForEvents()

    const status = manager.status(started.operationId)
    assert.equal(status.status, 'running')
    assert.equal(status.markerVerified, true)
    assert.equal(status.pid, 7654)
    assert.equal(manager.read(started.operationId).stderr, 'profile warning without newline')
})

test('tracked operation rejects a mismatched marker after ordinary stderr preamble', async (t) => {
    const channel = createChannel()
    const manager = new OperationManager({
        async openStream(_alias, _command, _marker, _options, adopt) {
            adopt(channel)
        },
        async cancelRemote() {
            return { success: true }
        },
    })
    t.after(() => manager.close())

    const started = await manager.start('server', 'sleep 1')
    channel.stderr.write('profile warning\n__MCP_SSH_OPERATION__:wrong-token:7654:0\n')
    await waitForEvents()

    const status = await assertTerminalMarkerFailure(manager, channel, started.operationId)
    assert.match(status.error, /did not match/)
    assert.match(manager.read(started.operationId).stderr, /^profile warning\n__MCP_SSH_OPERATION__/)
})

test('tracked operation rejects invalid process metadata after ordinary stderr preamble', async (t) => {
    const channel = createChannel()
    const manager = new OperationManager({
        async openStream(_alias, _command, marker, _options, adopt) {
            channel.marker = marker
            adopt(channel)
        },
        async cancelRemote() {
            return { success: true }
        },
    })
    t.after(() => manager.close())

    const started = await manager.start('server', 'sleep 1')
    channel.stderr.write(`profile warning\n__MCP_SSH_OPERATION__:${channel.marker}:0:0\n`)
    await waitForEvents()

    const status = await assertTerminalMarkerFailure(manager, channel, started.operationId)
    assert.match(status.error, /invalid process metadata/)
    assert.match(manager.read(started.operationId).stderr, /^profile warning\n__MCP_SSH_OPERATION__/)
})

test('tracked operation retains the marker line length limit after stderr preamble', async (t) => {
    const channel = createChannel()
    const manager = new OperationManager({
        async openStream(_alias, _command, _marker, _options, adopt) {
            adopt(channel)
        },
        async cancelRemote() {
            return { success: true }
        },
    })
    t.after(() => manager.close())

    const started = await manager.start('server', 'sleep 1')
    channel.stderr.write(`warning\n__MCP_SSH_OPERATION__:${'x'.repeat(600)}`)
    await waitForEvents()

    const status = await assertTerminalMarkerFailure(manager, channel, started.operationId)
    assert.match(status.error, /exceeded the allowed length/)
})

test('tracked operation rejects an oversized marker delivered with its newline', async (t) => {
    const channel = createChannel()
    const manager = new OperationManager({
        async openStream(_alias, _command, _marker, _options, adopt) {
            adopt(channel)
        },
        async cancelRemote() {
            return { success: true }
        },
    })
    t.after(() => manager.close())

    const started = await manager.start('server', 'sleep 1')
    channel.stderr.write(`   __MCP_SSH_OPERATION__:${'x'.repeat(600)}\n`)
    await waitForEvents()

    const status = await assertTerminalMarkerFailure(manager, channel, started.operationId)
    assert.match(status.error, /exceeded the allowed length/)
})

test('tracked operation retains a partial stderr preamble when the stream closes before marker', async (t) => {
    const channel = createChannel()
    const manager = new OperationManager({
        async openStream(_alias, _command, _marker, _options, adopt) {
            adopt(channel)
        },
        async cancelRemote() {
            return { success: true }
        },
    })
    t.after(() => manager.close())

    const started = await manager.start('server', 'exit 1')
    channel.stderr.write('profile warning without newline')
    await waitForEvents()
    channel.emit('close', 1)

    const status = manager.status(started.operationId)
    assert.equal(status.status, 'failed')
    assert.equal(status.stderrBytes, Buffer.byteLength('profile warning without newline'))
    assert.equal(manager.read(started.operationId).stderr, 'profile warning without newline')
})
