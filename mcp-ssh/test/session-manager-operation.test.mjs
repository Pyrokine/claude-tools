import assert from 'node:assert/strict'
import { exec as execCallback, execFile as execFileCallback } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { promisify } from 'node:util'
import { SessionManager } from '../dist/session-manager.js'

const exec = promisify(execCallback)
const execFile = promisify(execFileCallback)

function createManager(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ssh-session-manager-'))
    const manager = new SessionManager(path.join(directory, 'sessions.json'))
    manager.persistSessions = () => {}
    t.after(() => {
        for (const alias of manager.sessions.keys()) {
            manager.disconnect(alias)
        }
        manager.operationManager.close()
        fs.rmSync(directory, { recursive: true, force: true })
    })
    return { directory, manager }
}

function createSession(client) {
    return {
        client,
        config: {},
        connectedAt: 1,
        lastUsedAt: 1,
        reconnectAttempts: 0,
        connected: true,
        manualClose: false,
    }
}

function createChannel() {
    const channel = new PassThrough()
    channel.stderr = new PassThrough()
    let closeCalled = false
    channel.close = () => {
        closeCalled = true
        channel.destroy()
    }
    return { channel, closeCalled: () => closeCalled }
}

async function createBlackholeServer(t) {
    const sockets = new Set()
    const server = net.createServer((socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
    })
    await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    t.after(() => {
        for (const socket of sockets) {
            socket.destroy()
        }
        server.close()
    })
    return server.address().port
}

function pendingConnect(manager, alias, port) {
    return manager.connect({
        alias,
        host: '127.0.0.1',
        port,
        username: 'tester',
        readyTimeout: 5000,
    })
}

test('buildCommand gates shell operators behind successful cwd and env setup', async (t) => {
    if (process.platform === 'win32') {
        t.skip('command grouping test uses a POSIX shell')
        return
    }

    const { directory, manager } = createManager(t)
    const missingCwd = path.join(directory, 'missing')
    const cases = [
        ['semicolon', (outputPath) => `:; printf executed > ${JSON.stringify(outputPath)}`],
        ['newline', (outputPath) => `:\nprintf executed > ${JSON.stringify(outputPath)}`],
        ['or', (outputPath) => `: || printf executed > ${JSON.stringify(outputPath)}`],
    ]

    for (const [name, command] of cases) {
        const outputPath = path.join(directory, `${name}.txt`)
        const fullCommand = manager.buildCommand(
            command(outputPath),
            { config: {} },
            {
                cwd: missingCwd,
                env: { MCP_TEST_VALUE: 'injected' },
            }
        )

        assert.match(fullCommand, /^cd .* && export MCP_TEST_VALUE=.* && eval /)
        await assert.rejects(exec(fullCommand))
        assert.equal(fs.existsSync(outputPath), false, `${name} command escaped the cwd guard`)
    }
})

test('buildCommand preserves the active shell syntax while keeping prerequisite guards', async (t) => {
    if (process.platform === 'win32') {
        t.skip('shell semantics test requires Bash')
        return
    }

    const { manager } = createManager(t)
    const directCommand = '[[ -n $BASH_VERSION ]] && printf direct-ok'
    assert.equal(manager.buildCommand(directCommand, { config: {} }, {}), directCommand)

    const fullCommand = manager.buildCommand(
        'set -o pipefail; values=(alpha beta); [[ ${values[1]} == beta ]] && printf bash-ok',
        { config: {} },
        { env: { MCP_TEST_VALUE: 'injected' } }
    )
    const { stdout } = await execFile('bash', ['-c', fullCommand])

    assert.equal(stdout, 'bash-ok')
    assert.match(fullCommand, / && eval /)
    assert.doesNotMatch(fullCommand, / && sh -c /)
})

test('reconnect invalidates old client resources before publishing the replacement session', async (t) => {
    const { manager } = createManager(t)
    const events = []
    const oldClient = {
        end() {
            events.push('end')
        },
    }
    manager.sessions.set('server', createSession(oldClient))
    manager.operationManager.markAliasDisconnected = (alias) => events.push(`operation:${alias}`)
    manager.ptyManager.closeByAlias = (alias) => events.push(`pty:${alias}`)
    manager.forwardManager.closeByAlias = (alias) => events.push(`forward:${alias}`)
    manager.connect = async () => {
        events.push('connect')
        manager.sessions.set('server', createSession({ end() {} }))
        return 'server'
    }

    await manager.reconnect('server')

    assert.deepEqual(events, ['operation:server', 'pty:server', 'forward:server', 'end', 'connect'])
    assert.notEqual(manager.sessions.get('server').client, oldClient)
})

test('auto-reconnect timer ignores a replacement session with the same alias', async (t) => {
    const { manager } = createManager(t)
    const oldSession = createSession({ end() {} })
    manager.sessions.set('server', oldSession)
    manager.reconnectDelay = 5
    let reconnectCalls = 0
    manager.reconnect = async () => {
        ++reconnectCalls
    }

    manager.scheduleReconnect('server')
    let replacementEnded = false
    manager.sessions.set(
        'server',
        createSession({
            end() {
                replacementEnded = true
            },
        })
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.equal(reconnectCalls, 0)
    assert.equal(replacementEnded, false)
})

test('connect rejects conflicting configurations that reuse the same alias', async (t) => {
    const { manager } = createManager(t)
    let resolveConnection
    let connectCalls = 0
    const originalConnectInternal = manager.connectInternal
    manager.connectInternal = async (_config, alias) => {
        ++connectCalls
        return new Promise((resolve) => {
            resolveConnection = () => resolve(alias)
        })
    }

    const firstConfig = {
        host: 'host-a.example.com',
        port: 22,
        username: 'tester',
        alias: 'shared',
        runAs: 'app',
        env: { REGION: 'one' },
    }
    const first = manager.connect(firstConfig)
    const same = manager.connect({ ...firstConfig, env: { REGION: 'one' } })
    await assert.rejects(
        manager.connect({ ...firstConfig, host: 'host-b.example.com' }),
        /different connection attempt/
    )
    await assert.rejects(manager.connect({ ...firstConfig, runAs: 'other' }), /different connection attempt/)
    assert.equal(connectCalls, 1)

    resolveConnection()
    assert.equal(await first, 'shared')
    assert.equal(await same, 'shared')
    manager.connectInternal = originalConnectInternal

    manager.sessions.set('active', {
        ...createSession({ end() {} }),
        config: { ...firstConfig, alias: 'active' },
    })
    await assert.rejects(
        manager.connect({ ...firstConfig, alias: 'active', env: { REGION: 'two' } }),
        /different session configuration/
    )
    const info = manager.getSessionConnectionInfo('active')
    assert.equal(info.identity, 'tester@host-a.example.com:22')
    assert.equal(info.runAs, 'app')
    assert.deepEqual(info.envKeys, ['REGION'])
})

test('cancelled jump-host connection closes a delayed forward channel', async (t) => {
    const { manager } = createManager(t)
    const jumpConfig = {
        host: 'jump.example.com',
        port: 22,
        username: 'jump-user',
        alias: 'jump',
    }
    manager.sessions.set('jump', {
        ...createSession({ end() {} }),
        config: { ...jumpConfig, readyTimeout: 30000 },
    })

    let resolveForward
    manager.forwardConnection = async () =>
        new Promise((resolve) => {
            resolveForward = resolve
        })
    const targetConfig = {
        host: 'target.example.com',
        port: 22,
        username: 'target-user',
        alias: 'target',
        jumpHost: jumpConfig,
    }
    const pending = {
        generation: manager.getConnectionGeneration('target'),
        fingerprint: manager.connectionFingerprint(targetConfig),
        cancel() {},
    }
    manager.pendingConnections.set('target', pending)
    const connection = manager.connectInternal(targetConfig, 'target', pending)
    await new Promise((resolve) => setImmediate(resolve))
    manager.cancelPendingConnection('target')

    const { channel, closeCalled } = createChannel()
    resolveForward(channel)

    await assert.rejects(connection, /cancelled before SSH setup started/)
    assert.equal(channel.destroyed, true)
    assert.equal(closeCalled(), true)
})

test('disconnect cancels a pending connection and delayed ready cannot publish it', async (t) => {
    const { manager } = createManager(t)
    const port = await createBlackholeServer(t)
    const connection = pendingConnect(manager, 'server', port)
    const pending = manager.pendingConnections.get('server')

    assert.ok(pending?.client)
    assert.equal(manager.disconnect('server'), true)
    await assert.rejects(connection, /cancelled/)

    pending.client.emit('ready')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(manager.sessions.has('server'), false)
    assert.equal(manager.pendingConnections.has('server'), false)
})

test('a cancelled connection finalizer cannot remove a newer connection attempt', async (t) => {
    const { manager } = createManager(t)
    const port = await createBlackholeServer(t)
    const firstConnection = pendingConnect(manager, 'server', port)
    const firstPending = manager.pendingConnections.get('server')

    assert.ok(firstPending?.client)
    assert.equal(manager.disconnect('server'), true)
    const secondConnection = pendingConnect(manager, 'server', port)
    const secondPending = manager.pendingConnections.get('server')
    assert.ok(secondPending?.client)
    assert.notEqual(secondPending, firstPending)

    await assert.rejects(firstConnection, /cancelled/)
    assert.equal(manager.pendingConnections.get('server'), secondPending)
    assert.equal(manager.connectInFlight.has('server'), true)

    firstPending.client.emit('ready')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(manager.pendingConnections.get('server'), secondPending)
    assert.equal(manager.sessions.has('server'), false)

    assert.equal(manager.disconnect('server'), true)
    await assert.rejects(secondConnection, /cancelled/)
})

test('disconnectAll cancels aliases that only have pending connections', async (t) => {
    const { manager } = createManager(t)
    const port = await createBlackholeServer(t)
    const firstConnection = pendingConnect(manager, 'first', port)
    const secondConnection = pendingConnect(manager, 'second', port)

    assert.equal(manager.pendingConnections.size, 2)
    await manager.disconnectAll()

    await assert.rejects(firstConnection, /cancelled/)
    await assert.rejects(secondConnection, /cancelled/)
    assert.equal(manager.pendingConnections.size, 0)
    assert.equal(manager.connectInFlight.size, 0)
    assert.equal(manager.sessions.size, 0)
})

test('openOperationStream rejects a delayed exec callback after disconnect and reconnect', async (t) => {
    const { manager } = createManager(t)
    let execCallbackRef
    let oldClientEnded = false
    const oldClient = {
        exec(_command, _options, callback) {
            execCallbackRef = callback
        },
        end() {
            oldClientEnded = true
        },
    }
    manager.sessions.set('server', createSession(oldClient))

    let adopted = false
    const pending = manager.openOperationStream('server', 'sleep 1', 'marker-token', {}, () => {
        adopted = true
    })
    assert.equal(typeof execCallbackRef, 'function')
    assert.equal(manager.disconnect('server'), true)
    assert.equal(oldClientEnded, true)

    const newClient = { end() {} }
    manager.sessions.set('server', createSession(newClient))

    const channel = new PassThrough()
    channel.stderr = new PassThrough()
    let closeCalled = false
    channel.close = () => {
        closeCalled = true
        channel.destroy()
    }
    execCallbackRef(null, channel)

    await assert.rejects(pending, /SSH session changed/)
    assert.equal(adopted, false)
    assert.equal(channel.destroyed, true)
    assert.equal(closeCalled, true)
})

test('getSftp rejects a delayed callback after disconnect and reconnect', async (t) => {
    const { manager } = createManager(t)
    let sftpCallbackRef
    const oldClient = {
        sftp(callback) {
            sftpCallbackRef = callback
        },
        end() {},
    }
    manager.sessions.set('server', createSession(oldClient))

    const pending = manager.getSftp('server')
    assert.equal(typeof sftpCallbackRef, 'function')
    assert.equal(manager.disconnect('server'), true)
    manager.sessions.set('server', createSession({ end() {} }))

    let destroyed = false
    sftpCallbackRef(undefined, {
        destroy() {
            destroyed = true
        },
    })

    await assert.rejects(pending, /SSH session changed/)
    assert.equal(destroyed, true)
})

test('exec rejects a delayed callback after disconnect and reconnect', async (t) => {
    const { manager } = createManager(t)
    let execCallbackRef
    const oldClient = {
        exec(_command, _options, callback) {
            execCallbackRef = callback
        },
        end() {},
    }
    manager.sessions.set('server', createSession(oldClient))

    const pending = manager.exec('server', 'printf old-session')
    assert.equal(typeof execCallbackRef, 'function')
    assert.equal(manager.disconnect('server'), true)
    manager.sessions.set('server', createSession({ end() {} }))

    const { channel, closeCalled } = createChannel()
    execCallbackRef(null, channel)

    await assert.rejects(pending, /SSH session changed/)
    assert.equal(channel.destroyed, true)
    assert.equal(closeCalled(), true)
})

test('execSudo closes a delayed callback without writing the password after timeout', async (t) => {
    const { manager } = createManager(t)
    let execCallbackRef
    const client = {
        exec(_command, _options, callback) {
            execCallbackRef = callback
        },
        end() {},
    }
    manager.sessions.set('server', createSession(client))

    const pending = manager.execSudo('server', 'id', 'test-password', { timeout: 10 })
    assert.equal(typeof execCallbackRef, 'function')
    await assert.rejects(pending, /timed out/)

    const { channel, closeCalled } = createChannel()
    let wrotePassword = false
    channel.write = () => {
        wrotePassword = true
        return true
    }
    execCallbackRef(null, channel)

    assert.equal(wrotePassword, false)
    assert.equal(channel.destroyed, true)
    assert.equal(closeCalled(), true)
})

test('ptyStart rejects a delayed callback after disconnect and reconnect', async (t) => {
    const { manager } = createManager(t)
    let execCallbackRef
    const oldClient = {
        exec(_command, _options, callback) {
            execCallbackRef = callback
        },
        end() {},
    }
    manager.sessions.set('server', createSession(oldClient))

    const pending = manager.ptyStart('server', 'top')
    assert.equal(typeof execCallbackRef, 'function')
    assert.equal(manager.disconnect('server'), true)
    manager.sessions.set('server', createSession({ end() {} }))

    const { channel, closeCalled } = createChannel()
    execCallbackRef(null, channel)

    await assert.rejects(pending, /SSH session changed/)
    assert.equal(channel.destroyed, true)
    assert.equal(closeCalled(), true)
    assert.deepEqual(manager.ptyList(), [])
})
