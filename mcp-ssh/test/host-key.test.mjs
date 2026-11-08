import assert from 'node:assert/strict'
import { createHash, createHmac, generateKeyPairSync } from 'node:crypto'
import childProcess, { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import ssh2 from 'ssh2'
import { HostKeyError, KnownHosts } from '../dist/known-hosts.js'
import { validateKnownHostsPath } from '../dist/security.js'
import { SessionManager, sessionManager } from '../dist/session-manager.js'
import { registerConnectionTools } from '../dist/tools/connection.js'
import { checkWindowsAcl } from '../dist/windows-acl.js'

// Fixed synthetic OpenSSH keys keep ssh2's random key generator out of protocol regressions.
const key = {
    private: `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACDcAP2jEuqSJKQLMyuDrP0jK2vj0rdhTpTYII9LvfL6WwAAAIhgcCdtYHAn
bQAAAAtzc2gtZWQyNTUxOQAAACDcAP2jEuqSJKQLMyuDrP0jK2vj0rdhTpTYII9LvfL6Ww
AAAEA9rvTTFtVmLl5KhCM4F4/RdfIwQcFXzOSJM0flUQaz8NwA/aMS6pIkpAszK4Os/SMr
a+PSt2FOlNggj0u98vpbAAAAAAECAwQF
-----END OPENSSH PRIVATE KEY-----`,
}
const changed = {
    private: `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACDJoH1XWC3GWm8z6dboK8Sh4EzLs/aKdkC3vB2mhuHJDgAAAIjxvB7W8bwe
1gAAAAtzc2gtZWQyNTUxOQAAACDJoH1XWC3GWm8z6dboK8Sh4EzLs/aKdkC3vB2mhuHJDg
AAAEBIssw3us2unlKSHys9Lg7jOJMJ1voCNlkMSliU9T8RfsmgfVdYLcZabzPp1ugrxKHg
TMuz9op2QLe8HaaG4ckOAAAAAAECAwQF
-----END OPENSSH PRIVATE KEY-----`,
}
const raw = ssh2.utils.parseKey(key.private).getPublicSSH()
const other = ssh2.utils.parseKey(changed.private).getPublicSSH()
const line = (hostname, blob = raw) =>
    `${hostname}` + ' ' + `${ssh2.utils.parseKey(blob).type}` + ' ' + `${blob.toString('base64')}` + '\n'
const ecdsa = {
    private: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' }),
}
const changedEcdsa = {
    private: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' }),
}
const rsa = {
    private: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }),
}
const ecdsaRaw = ssh2.utils.parseKey(ecdsa.private).getPublicSSH()
const rsaRaw = ssh2.utils.parseKey(rsa.private).getPublicSSH()

function fixture(t) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-host-key-')))
    if (process.platform === 'win32') {
        assert.equal(checkWindowsAcl(directory, true), 'key_path_usable')
    }
    const previous = process.env.SSH_MCP_ALLOWED_KEY_DIRS
    process.env.SSH_MCP_ALLOWED_KEY_DIRS = directory
    const file = path.join(directory, 'known_hosts')
    const trust = new KnownHosts(file, [])
    const manager = new SessionManager(path.join(directory, 'sessions.json'))
    manager.knownHosts = trust
    manager.persistSessions = () => {}
    t.after(async () => {
        await manager.disconnectAll()
        manager.operationManager.close()
        if (previous === undefined) {
            delete process.env.SSH_MCP_ALLOWED_KEY_DIRS
        } else {
            process.env.SSH_MCP_ALLOWED_KEY_DIRS = previous
        }
        fs.rmSync(directory, { recursive: true, force: true })
    })
    return { directory, file, trust, manager }
}

function systemAliasFixture(t) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-system-alias-')))
    const home = path.join(directory, 'home')
    const system = path.join(directory, 'private', 'etc', 'ssh')
    fs.mkdirSync(home, { mode: 0o700 })
    fs.mkdirSync(system, { recursive: true, mode: 0o700 })
    fs.symlinkSync(path.dirname(system), path.join(directory, 'etc'))
    const previous = process.env.SSH_MCP_ALLOWED_KEY_DIRS
    delete process.env.SSH_MCP_ALLOWED_KEY_DIRS
    const checked = new Set()
    t.after(() => {
        t.mock.restoreAll()
        syncBuiltinESMExports()
        if (previous === undefined) {
            delete process.env.SSH_MCP_ALLOWED_KEY_DIRS
        } else {
            process.env.SSH_MCP_ALLOWED_KEY_DIRS = previous
        }
        fs.rmSync(directory, { recursive: true, force: true })
    })
    t.mock.method(os, 'homedir', () => home)
    // Map the default system paths onto an owned tree with a real /etc -> /private/etc-style link.
    for (const method of ['existsSync', 'realpathSync']) {
        const original = fs[method].bind(fs)
        t.mock.method(fs, method, (input, ...args) => {
            if (typeof input === 'string' && (input === '/etc' || input.startsWith('/etc/'))) {
                checked.add(input)
                input = path.join(directory, input.slice(1))
            }
            return original(input, ...args)
        })
    }
    syncBuiltinESMExports()
    return { directory, home, system, file: path.join(home, '.ssh', 'known_hosts'), checked }
}

for (const missingDirectory of [false, true]) {
    test(
        'SSH-01: simulated macOS default system alias permits first and existing ' +
            'trust with ' +
            `${missingDirectory ? 'missing directory' : 'missing files'}`,
        { skip: process.platform === 'win32' },
        async (t) => {
            const { system, file, checked } = systemAliasFixture(t)
            if (missingDirectory) {
                fs.rmdirSync(system)
            }
            const trust = new KnownHosts()
            assert.equal((await trust.verify('alias.example.com', 22, raw)).status, 'added')
            assert.equal((await trust.verify('alias.example.com', 22, raw)).status, 'known')
            await assert.rejects(trust.verify('alias.example.com', 22, other), /changed/)
            assert.equal(fs.readFileSync(file, 'utf8'), line('alias.example.com'))
            assert.ok(checked.has('/etc/ssh/ssh_known_hosts'))
            assert.ok(checked.has('/etc/ssh/ssh_known_hosts2'))
        }
    )
}

test(
    'SSH-01: simulated macOS default system alias still consumes system trust and revocation',
    { skip: process.platform === 'win32' },
    async (t) => {
        const { system, file } = systemAliasFixture(t)
        const systemFile = path.join(system, 'ssh_known_hosts')
        fs.writeFileSync(systemFile, line('system.example.com'), { mode: 0o644 })
        const trust = new KnownHosts()
        assert.equal((await trust.verify('system.example.com', 22, raw)).status, 'known')
        assert.equal(fs.existsSync(file), false)
        fs.mkdirSync(path.dirname(file), { mode: 0o700 })
        fs.writeFileSync(file, line('user.example.com'), { mode: 0o600 })
        fs.writeFileSync(path.join(system, 'ssh_known_hosts2'), `@revoked ${line('user.example.com')}`, { mode: 0o644 })
        await assert.rejects(trust.verify('user.example.com', 22, raw), /revoked/)
        await assert.rejects(trust.verify('system.example.com', 22, other), /changed/)
    }
)

test(
    'SSH-01: known_hosts resolves an allowed root alias and missing descendants',
    { skip: process.platform === 'win32' },
    async (t) => {
        const { directory, home, file } = systemAliasFixture(t)
        const target = path.join(directory, 'trusted')
        fs.mkdirSync(target, { mode: 0o700 })
        fs.symlinkSync(target, path.join(home, '.ssh'))
        assert.equal(validateKnownHostsPath(file), path.join(target, 'known_hosts'))
        assert.equal(
            validateKnownHostsPath(path.join(target, 'nested', 'known_hosts')),
            path.join(target, 'nested', 'known_hosts')
        )
        const trust = new KnownHosts()
        assert.equal((await trust.verify('root-alias.example.com', 22, raw)).status, 'added')
        assert.equal((await trust.verify('root-alias.example.com', 22, raw)).status, 'known')
    }
)

test(
    'SSH-01: known_hosts rejects escapes and prefix lookalikes under a system alias',
    { skip: process.platform === 'win32' },
    (t) => {
        const { directory, system } = systemAliasFixture(t)
        const outside = path.join(directory, 'outside')
        fs.mkdirSync(outside)
        fs.writeFileSync(path.join(outside, 'known_hosts'), line('outside.example.com'))
        fs.symlinkSync(outside, path.join(system, 'escape'))
        assert.equal(validateKnownHostsPath('/etc/ssh/ssh_known_hosts', true), path.join(system, 'ssh_known_hosts'))
        for (const candidate of [
            '/etc/ssh/escape/known_hosts',
            '/etc/ssh/escape/missing/known_hosts',
            '/etc/ssh/../ssh-evil/known_hosts',
            '/etc/ssh-evil/known_hosts',
            path.join(path.dirname(system), 'ssh-evil', 'known_hosts'),
        ]) {
            assert.throws(() => validateKnownHostsPath(candidate, true), /outside the allowed/)
        }
    }
)

async function server(t, hostKey = key, algorithms) {
    let authentication = 0
    let connections = 0
    const clients = new Set()
    const sockets = new Set()
    const negotiated = []
    const instance = new ssh2.Server(
        {
            hostKeys: (Array.isArray(hostKey) ? hostKey : [hostKey]).map((pair) => pair.private),
            ...(algorithms ? { algorithms: { serverHostKey: algorithms } } : {}),
        },
        (client) => {
            ++connections
            clients.add(client)
            client.on('handshake', (info) => negotiated.push(info.serverHostKey))
            client.on('error', () => {})
            client.on('close', () => clients.delete(client))
            client.on('authentication', (context) => {
                ++authentication
                context.accept()
            })
            client.on('ready', () =>
                client.on('tcpip', (accept, reject, info) => {
                    if (info.destIP !== '127.0.0.1') {
                        reject()
                        return
                    }
                    const socket = net.connect(info.destPort, info.destIP)
                    sockets.add(socket)
                    socket.on('close', () => sockets.delete(socket))
                    socket.on('error', () => {
                        reject()
                        socket.destroy()
                    })
                    socket.on('connect', () => {
                        const channel = accept()
                        socket.pipe(channel).pipe(socket)
                    })
                })
            )
        }
    )
    await new Promise((resolve, reject) => {
        instance.once('error', reject)
        instance.listen(0, '127.0.0.1', () => resolve(undefined))
    })
    t.after(async () => {
        for (const client of clients) {
            client.end()
        }
        for (const socket of sockets) {
            socket.destroy()
        }
        await new Promise((resolve) => instance.close(resolve))
    })
    return {
        port: instance.address().port,
        authentication: () => authentication,
        connections: () => connections,
        clients,
        negotiated,
    }
}

function connection(port, alias = 'fixture') {
    return { host: '127.0.0.1', port, username: 'fixture', password: 'synthetic', alias }
}

test('SSH-01: existing pins select trusted algorithms without changing trust files', async (t) => {
    const cases = [
        {
            name: 'ECDSA pin with Ed25519 also offered',
            blob: ecdsaRaw,
            keys: [ecdsa, key],
            selected: 'ecdsa-sha2-nistp256',
            reconnect: true,
        },
        {
            name: 'both pins preserve default algorithm preference',
            blob: ecdsaRaw,
            keys: [ecdsa, key],
            extra: raw,
            selected: 'ssh-ed25519',
        },
        { name: 'saved algorithm unavailable', blob: ecdsaRaw, keys: [key], error: /changed/ },
        { name: 'same algorithm with changed key', blob: ecdsaRaw, keys: [changedEcdsa, key], error: /changed/ },
        { name: 'matching revoked key', blob: ecdsaRaw, keys: [ecdsa, key], revoked: ecdsaRaw, error: /revoked/ },
        {
            name: 'other revoked algorithm',
            blob: ecdsaRaw,
            keys: [ecdsa, key],
            revoked: raw,
            selected: 'ecdsa-sha2-nistp256',
        },
        {
            name: 'matching CA entry',
            blob: ecdsaRaw,
            keys: [ecdsa, key],
            marker: '@cert-authority ',
            error: /certificates\/CA/,
        },
        {
            name: 'damaged matching entry',
            blob: ecdsaRaw,
            keys: [ecdsa, key],
            damaged: true,
            error: /Damaged matching/,
        },
        {
            name: 'RSA pin with SHA2-512',
            blob: rsaRaw,
            keys: [rsa, key],
            algorithms: ['ssh-ed25519', 'rsa-sha2-512'],
            selected: 'rsa-sha2-512',
        },
        {
            name: 'RSA pin with SHA2-256',
            blob: rsaRaw,
            keys: [rsa, key],
            algorithms: ['ssh-ed25519', 'rsa-sha2-256'],
            selected: 'rsa-sha2-256',
        },
    ]
    for (const scenario of cases) {
        await t.test(scenario.name, async (t) => {
            const { file, manager } = fixture(t)
            const remote = await server(t, scenario.keys, scenario.algorithms)
            const host = `[127.0.0.1]:${remote.port}`
            let entries = `${scenario.marker ?? ''}${line(host, scenario.blob)}`
            if (scenario.extra) {
                entries += line(host, scenario.extra)
            }
            if (scenario.revoked) {
                entries += `@revoked ${line(host, scenario.revoked)}`
            }
            if (scenario.damaged) {
                entries += `${host} ecdsa-sha2-nistp256 damaged-key\n`
            }
            fs.writeFileSync(file, entries, { mode: 0o600 })
            const before = fs.statSync(file)
            if (scenario.error) {
                await assert.rejects(manager.connect(connection(remote.port)), (error) => {
                    assert.equal(error.details.failureStage, 'host_key')
                    assert.equal(error.details.retryable, false)
                    assert.match(error.message, scenario.error)
                    return true
                })
                assert.equal(remote.authentication(), 0)
            } else {
                await manager.connect(connection(remote.port))
                assert.equal(manager.getSessionConnectionInfo('fixture').hostKey.status, 'known')
                assert.equal(remote.negotiated[0], scenario.selected)
                if (scenario.reconnect) {
                    await manager.reconnect('fixture')
                    assert.deepEqual(remote.negotiated, [scenario.selected, scenario.selected])
                }
                assert.ok(remote.authentication() > 0)
            }
            assert.equal(fs.readFileSync(file, 'utf8'), entries)
            const after = fs.statSync(file)
            assert.equal(after.ino, before.ino)
            assert.equal(after.mode, before.mode)
            assert.equal(after.uid, before.uid)
        })
    }
})

test('SSH-01: bastion and target independently prefer their existing pin types', async (t) => {
    const { file, manager } = fixture(t)
    const jump = await server(t, [ecdsa, key])
    const target = await server(t, [ecdsa, key, rsa])
    const entries = line(`[127.0.0.1]:${jump.port}`, ecdsaRaw) + line(`[127.0.0.1]:${target.port}`, rsaRaw)
    fs.writeFileSync(file, entries, { mode: 0o600 })
    const config = { ...connection(target.port), jumpHost: connection(jump.port, 'bastion') }
    await manager.connect(config)
    assert.equal(jump.negotiated[0], 'ecdsa-sha2-nistp256')
    assert.equal(target.negotiated[0], 'rsa-sha2-512')
    assert.equal(manager.getSessionConnectionInfo('fixture').hostKeys.length, 2)
    await manager.reconnect('fixture')
    assert.deepEqual(target.negotiated, ['rsa-sha2-512', 'rsa-sha2-512'])
    assert.equal(fs.readFileSync(file, 'utf8'), entries)
})

test('SSH-01: reconnect reads updated trusted algorithms', async (t) => {
    const { file, manager, trust } = fixture(t)
    const remote = await server(t, [ecdsa, key])
    const host = `[127.0.0.1]:${remote.port}`
    fs.writeFileSync(file, line(host, ecdsaRaw), { mode: 0o600 })
    assert.deepEqual(trust.getHostKeyAlgorithms('127.0.0.1', remote.port), ['ecdsa-sha2-nistp256'])
    await manager.connect(connection(remote.port))
    const updated = line(host)
    fs.writeFileSync(file, updated)
    await manager.reconnect('fixture')
    assert.deepEqual(remote.negotiated, ['ecdsa-sha2-nistp256', 'ssh-ed25519'])
    assert.equal(fs.readFileSync(file, 'utf8'), updated)
})

test('G073: rejected real handshakes report negotiated algorithm and conflicting synthetic pins', async (t) => {
    const changedRsa = {
        private: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
            type: 'pkcs1',
            format: 'pem',
        }),
    }
    for (const [stored, offered, algorithm] of [
        [key, changed, 'ssh-ed25519'],
        [rsa, changedRsa, 'rsa-sha2-256'],
    ]) {
        await t.test(algorithm, async (t) => {
            const { file, manager } = fixture(t)
            const remote = await server(t, offered, [algorithm])
            const storedRaw = ssh2.utils.parseKey(stored.private).getPublicSSH()
            const offeredRaw = ssh2.utils.parseKey(offered.private).getPublicSSH()
            const fingerprint = (blob) =>
                'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
            const contents = '# synthetic trust fixture\n' + line(`[127.0.0.1]:${remote.port}`, storedRaw)
            fs.writeFileSync(file, contents, { mode: 0o600 })
            fs.writeFileSync(`${file}2`, contents, { mode: 0o600 })
            const before = fs.statSync(file)
            await assert.rejects(manager.connect(connection(remote.port)), (error) => {
                assert.equal(error.details.failureStage, 'host_key')
                assert.equal(error.details.retryable, false)
                const diagnostics = error.details.hostKey
                assert.equal(diagnostics.algorithm, algorithm)
                assert.equal(diagnostics.keyType, ssh2.utils.parseKey(offeredRaw).type)
                assert.equal(diagnostics.fingerprint, fingerprint(offeredRaw))
                assert.deepEqual(
                    diagnostics.knownKeys.map((entry) => [entry.fingerprint, entry.file, entry.line]),
                    [
                        [fingerprint(storedRaw), file, 2],
                        [fingerprint(storedRaw), `${file}2`, 2],
                    ]
                )
                assert.ok(error.message.includes(`${file}:2`))
                return true
            })
            assert.equal(remote.authentication(), 0)
            assert.equal(fs.readFileSync(file, 'utf8'), contents)
            assert.equal(fs.readFileSync(`${file}2`, 'utf8'), contents)
            assert.equal(fs.statSync(file).mode, before.mode)
            assert.equal(fs.statSync(file).ino, before.ino)
        })
    }
})

test('SSH-01: real ssh2 first trust is saved before authentication and reconnect checks it', async (t) => {
    const { file, manager } = fixture(t)
    const remote = await server(t)
    await manager.connect(connection(remote.port))
    assert.equal(manager.getSessionConnectionInfo('fixture').hostKey.status, 'added')
    assert.match(fs.readFileSync(file, 'utf8'), /ssh-ed25519/)
    assert.ok(remote.authentication() > 0)
    await manager.reconnect('fixture')
    assert.equal(manager.getSessionConnectionInfo('fixture').hostKey.status, 'known')
    manager.disconnect('fixture')
    fs.writeFileSync(file, line(`[127.0.0.1]:${remote.port}`, other))
    const before = remote.authentication()
    await assert.rejects(manager.connect(connection(remote.port)), (error) => {
        assert.equal(error.details.failureStage, 'host_key')
        assert.equal(error.details.retryable, false)
        assert.match(error.message, /changed/)
        return true
    })
    assert.equal(remote.authentication(), before)
})

test('R-01: real rekey after the initial deadline accepts the same key and rejects a changed key', async (t) => {
    const { file, trust, manager } = fixture(t)
    const remote = await server(t)
    const verify = t.mock.method(trust, 'verify', trust.verify.bind(trust))
    await manager.connect(connection(remote.port))
    const client = manager.sessions.get('fixture').client
    const peer = [...remote.clients][0]
    const original = fs.readFileSync(file, 'utf8')
    const clock = Date.now
    t.mock.method(Date, 'now', () => clock() + 31000)
    const handshakes = Promise.all([
        once(client, 'handshake', { signal: globalThis.AbortSignal.timeout(5000) }),
        once(peer, 'handshake', { signal: globalThis.AbortSignal.timeout(5000) }),
    ])
    peer.rekey()
    await handshakes
    assert.equal(manager.sessions.get('fixture').client, client)
    assert.equal(manager.sessions.get('fixture').connected, true)
    assert.equal(verify.mock.calls.length, 2)
    assert.ok(verify.mock.calls[1].arguments[4] > verify.mock.calls[0].arguments[4])
    peer._protocol._hostKeys['ssh-ed25519'] = ssh2.utils.parseKey(changed.private)
    const closed = new Promise((resolve) => client.once('close', resolve))
    const failure = once(client, 'error', { signal: globalThis.AbortSignal.timeout(5000) })
    peer.rekey()
    const [error] = await failure
    assert.match(error.message, /Host denied/)
    await closed
    assert.equal(manager.sessions.get('fixture').connected, false)
    assert.equal(fs.readFileSync(file, 'utf8'), original)
    assert.equal(verify.mock.calls.length, 3)
})

test('R29-SSH-01: rekey trust failures stop direct, target and jump reconnects beyond five seconds', async (t) => {
    for (const role of ['direct', 'target', 'jump']) {
        for (const revoked of [false, true]) {
            await t.test(`${role} ${revoked ? 'revoked' : 'changed'}`, async (t) => {
                const { file, manager } = fixture(t)
                const remote = await server(t)
                const jump = role === 'direct' ? undefined : await server(t)
                const config = connection(remote.port)
                if (jump) {
                    config.jumpHost = connection(jump.port, 'jump')
                }
                await manager.connect(config)
                if (role === 'jump') {
                    await manager.connect({ ...config, alias: 'dependent' })
                }
                const unrelated = await server(t)
                await manager.connect(connection(unrelated.port, 'unrelated'))
                const failedAlias = role === 'jump' ? 'jump' : 'fixture'
                const failedRemote = role === 'jump' ? jump : remote
                const failedSession = manager.sessions.get(failedAlias)
                const peer = [...failedRemote.clients][0]
                const original = fs.readFileSync(file, 'utf8')
                if (revoked) {
                    fs.appendFileSync(file, `@revoked ${line(`[127.0.0.1]:${failedRemote.port}`)}`)
                } else {
                    peer._protocol._hostKeys['ssh-ed25519'] = ssh2.utils.parseKey(changed.private)
                }
                const closed = new Promise((resolve) => failedSession.client.once('close', resolve))
                peer.rekey()
                await closed
                const before = [
                    remote.connections(),
                    remote.authentication(),
                    jump?.connections(),
                    jump?.authentication(),
                ]
                await new Promise((resolve) => setTimeout(resolve, 5250))
                assert.deepEqual(
                    [remote.connections(), remote.authentication(), jump?.connections(), jump?.authentication()],
                    before
                )
                for (const alias of role === 'jump' ? ['fixture', 'dependent', 'jump'] : ['fixture']) {
                    assert.equal(manager.sessions.get(alias).reconnectTimer, undefined)
                    assert.throws(
                        () => manager.getSession(alias),
                        (error) => {
                            assert.equal(error.details.failureStage, 'host_key')
                            assert.equal(error.details.retryable, false)
                            return true
                        }
                    )
                    assert.equal(manager.listSessions().find((item) => item.alias === alias).connected, false)
                }
                assert.equal(manager.getSession('unrelated').connected, true)
                if (role === 'target') {
                    assert.equal(manager.getSession('jump').connected, true)
                }
                fs.writeFileSync(file, original)
                peer._protocol._hostKeys['ssh-ed25519'] = ssh2.utils.parseKey(key.private)
                await manager.reconnect('fixture')
                const replacement = manager.getSession('fixture')
                failedSession.client.emit('close')
                assert.equal(manager.getSession('fixture'), replacement)
            })
        }
    }
})

test('R29-SSH-01: ordinary disconnect still automatically reconnects', async (t) => {
    const { manager } = fixture(t)
    const remote = await server(t)
    await manager.connect(connection(remote.port))
    const first = manager.getSession('fixture').client
    const reconnect = manager.reconnect.bind(manager)
    const reconnected = new Promise((resolve, reject) => {
        t.mock.method(manager, 'reconnect', (...args) => {
            const pending = reconnect(...args)
            pending.then(resolve, reject)
            return pending
        })
    })
    ;[...remote.clients][0].end()
    await new Promise((resolve) => setTimeout(resolve, 5500))
    await reconnected
    assert.notEqual(manager.getSession('fixture').client, first)
    assert.equal(remote.connections(), 2)
    assert.equal(remote.authentication(), 2)
})

test(
    'R-01: initial verification still consumes the original connection ' + 'deadline before authentication',
    async (t) => {
        const { trust, manager } = fixture(t)
        const remote = await server(t)
        const clock = Date.now
        const verify = trust.verify.bind(trust)
        t.mock.method(trust, 'verify', (...args) => {
            t.mock.method(Date, 'now', () => clock() + 4000)
            return verify(...args)
        })
        await assert.rejects(manager.connect({ ...connection(remote.port), readyTimeout: 3000 }), (error) => {
            assert.equal(error.details.failureStage, 'host_key')
            assert.match(error.message, /verification deadline exhausted/)
            return true
        })
        assert.equal(remote.authentication(), 0)
    }
)

test('SSH-01: public registered ssh_connect callback reports persisted trust from a real handshake', async (t) => {
    const { file, manager } = fixture(t)
    const remote = await server(t)
    const callbacks = new Map()
    registerConnectionTools({
        registerTool(name, _schema, callback) {
            callbacks.set(name, callback)
        },
    })
    t.mock.method(sessionManager, 'connect', manager.connect.bind(manager))
    t.mock.method(sessionManager, 'listSessionDetails', manager.listSessionDetails.bind(manager))
    t.mock.method(sessionManager, 'getSessionConnectionInfo', manager.getSessionConnectionInfo.bind(manager))
    const response = await callbacks.get('ssh_connect')({
        host: '127.0.0.1',
        port: remote.port,
        user: 'fixture',
        password: 'synthetic',
        alias: 'public-fixture',
    })
    const result = JSON.parse(response.content[0].text)
    assert.equal(result.success, true)
    assert.equal(result.hostKey.status, 'added')
    assert.match(result.hostKey.fingerprint, /^SHA256:/)
    assert.equal(result.hostKeys[0].port, remote.port)
    assert.ok(fs.readFileSync(file, 'utf8').includes(`[127.0.0.1]:${remote.port}`))
    assert.ok(remote.authentication() > 0)
})

test('SSH-01: revoked and damaged matching keys reject before server authentication', async (t) => {
    const { file, manager } = fixture(t)
    const remote = await server(t)
    for (const entry of [
        `@revoked ${line(`[127.0.0.1]:${remote.port}`)}`,
        `[127.0.0.1]:${remote.port} ssh-ed25519 broken-key\n`,
        `@cert-authority ${line(`[127.0.0.1]:${remote.port}`)}`,
    ]) {
        fs.writeFileSync(file, entry, { mode: 0o600 })
        await assert.rejects(
            manager.connect(connection(remote.port)),
            (error) => error.details.failureStage === 'host_key'
        )
        assert.equal(remote.authentication(), 0)
    }
})

test('SSH-01: every jump and forwarded target verifies its real host and port', async (t) => {
    const { file, manager } = fixture(t)
    const jump = await server(t)
    const target = await server(t)
    fs.writeFileSync(file, line(`[127.0.0.1]:${jump.port}`) + line(`[127.0.0.1]:${target.port}`, other), {
        mode: 0o600,
    })
    const config = { ...connection(target.port, 'target'), jumpHost: connection(jump.port, 'jump') }
    await assert.rejects(manager.connect(config), /changed/)
    assert.ok(jump.authentication() > 0)
    assert.equal(target.authentication(), 0)
    fs.writeFileSync(file, line(`[127.0.0.1]:${jump.port}`) + line(`[127.0.0.1]:${target.port}`))
    await manager.connect(config)
    assert.ok(target.authentication() > 0)
    assert.deepEqual(
        manager.getSessionConnectionInfo('target').hostKeys.map(({ host, port }) => ({ host, port })),
        [
            { host: '127.0.0.1', port: jump.port },
            { host: '127.0.0.1', port: target.port },
        ]
    )
    manager.disconnect('target')
    manager.disconnect('jump')
    fs.writeFileSync(file, line(`[127.0.0.1]:${jump.port}`, other))
    const before = jump.authentication()
    await assert.rejects(manager.connect(config), /changed/)
    assert.equal(jump.authentication(), before)
})

test('SSH-01: known_hosts supports hashes, patterns, negation, IPv6, multiple keys and public reads', async (t) => {
    const { file, trust } = fixture(t)
    const salt = Buffer.alloc(20, 7)
    const host = '[::1]:2222'
    const hash = `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(host).digest('base64')}`
    fs.writeFileSync(
        file,
        '# keep comment\n' +
            line(hash) +
            line('*.example.com,!blocked.example.com,other.example.net') +
            line('example.org', other) +
            line('example.org'),
        { mode: 0o644 }
    )
    assert.equal((await trust.verify('::1', 2222, raw)).status, 'known')
    assert.equal((await trust.verify('a.example.com', 22, raw)).status, 'known')
    assert.equal((await trust.verify('other.example.net', 22, raw)).status, 'known')
    assert.equal((await trust.verify('example.org', 22, raw)).status, 'known')
    assert.equal((await trust.verify('blocked.example.com', 22, other)).status, 'added')
    assert.match(fs.readFileSync(file, 'utf8'), /^# keep comment/)
    if (process.platform !== 'win32') {
        fs.chmodSync(file, 0o444)
        assert.equal((await trust.verify('a.example.com', 22, raw)).status, 'known')
        await assert.rejects(trust.verify('new.example.net', 22, raw), /could not be saved/)
        fs.chmodSync(file, 0o600)
    }
})

test('SSH-01: competing first keys serialize; cancelled waits leave no owned lock', async (t) => {
    const { file, trust } = fixture(t)
    const now = Date.now()
    t.mock.method(Date, 'now', () => now)
    const results = await Promise.allSettled([
        trust.verify('race.example.com', 22, raw),
        trust.verify('race.example.com', 22, other),
    ])
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1)
    assert.equal(results.filter(({ status }) => status === 'rejected').length, 1)
    assert.equal(fs.existsSync(`${file}.mcp-lock`), false)
    fs.writeFileSync(`${file}.mcp-lock`, '', { mode: 0o600 })
    const controller = new AbortController()
    const pending = trust.verify('cancel.example.com', 22, raw, controller.signal)
    controller.abort(new Error('fixture cancellation'))
    await assert.rejects(pending)
    assert.equal(fs.existsSync(`${file}.mcp-lock`), true)
    assert.equal(fs.readFileSync(file, 'utf8').includes('cancel.example.com'), false)
})

test('SSH-01: independent processes cannot register conflicting first keys', async (t) => {
    const { file } = fixture(t)
    const moduleUrl = new URL('../dist/known-hosts.js', import.meta.url).href
    const program = `
const { KnownHosts } = await import(process.argv[1]);
try {
    const trust = new KnownHosts(process.argv[2], []);
    await trust.verify('process-race.example.com', 22, Buffer.from(process.argv[3], 'base64'));
} catch { process.exitCode = 1; }
`
    const run = (blob) =>
        new Promise((resolve, reject) => {
            const child = spawn(
                process.execPath,
                ['--input-type=module', '-e', program, moduleUrl, file, blob.toString('base64')],
                { stdio: 'ignore' }
            )
            t.after(() => {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill()
                }
            })
            child.once('error', reject)
            child.once('exit', (code) => resolve(code))
        })
    const results = await Promise.all([run(raw), run(other)])
    assert.deepEqual(results.sort(), [0, 1])
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1)
    assert.equal(fs.existsSync(`${file}.mcp-lock`), false)
})

const lockProgram =
    '\n' +
    "import fs from 'node:fs';\n" +
    'const [moduleUrl, file, blob, stages, host] = process.argv.slice(1);\n' +
    "const wanted = new Set(stages.split(','));\n" +
    'const barrier = async (phase) => {\n' +
    '    if (wanted.delete(phase)) {\n' +
    '        process.send({ phase });\n' +
    "        await new Promise(resolve => process.once('message', resolve));\n" +
    '    }\n' +
    '};\n' +
    'const open = fs.promises.open.bind(fs.promises);\n' +
    'fs.promises.open = async (...args) => {\n' +
    '    const handle = await open(...args);\n' +
    "    if (args[0] === file + '.mcp-lock') await barrier('published');\n" +
    '    if (args[0] === file) {\n' +
    '        const write = handle.writeFile.bind(handle);\n' +
    '        handle.writeFile = async (...values) => { await ' +
    "write(...values); await barrier('appended'); };\n" +
    '    }\n' +
    '    return handle;\n' +
    '};\n' +
    'const mkdir = fs.promises.mkdir.bind(fs.promises);\n' +
    'fs.promises.mkdir = async (...args) => {\n' +
    '    const result = await mkdir(...args);\n' +
    "    if (String(args[0]).includes('.mcp-lock.prepare-')) await " +
    "barrier('preparing');\n" +
    '    return result;\n' +
    '};\n' +
    'const writeFile = fs.promises.writeFile.bind(fs.promises);\n' +
    'fs.promises.writeFile = async (...args) => {\n' +
    '    const result = await writeFile(...args);\n' +
    "    if (String(args[0]).includes('.mcp-lock.prepare-')) await " +
    "barrier('prepared');\n" +
    '    return result;\n' +
    '};\n' +
    'const rename = fs.promises.rename.bind(fs.promises);\n' +
    'fs.promises.rename = async (...args) => {\n' +
    '    const result = await rename(...args);\n' +
    "    if (args[1] === file + '.mcp-lock') await barrier('published');\n" +
    '    return result;\n' +
    '};\n' +
    'const unlink = fs.promises.unlink.bind(fs.promises);\n' +
    'fs.promises.unlink = async (...args) => {\n' +
    "    if (String(args[0]).startsWith(file + '.mcp-lock' + '/')) await " +
    "barrier('recover');\n" +
    '    const result = await unlink(...args);\n' +
    "    if (String(args[0]).startsWith(file + '.mcp-lock' + '/')) await " +
    "barrier('released');\n" +
    '    return result;\n' +
    '};\n' +
    'try {\n' +
    '    const { KnownHosts } = await import(moduleUrl);\n' +
    '    const result = await new KnownHosts(file, []).verify(host, 22, ' +
    "Buffer.from(blob, 'base64'));\n" +
    "    process.send({ phase: 'done', status: result.status });\n" +
    '} catch (error) {\n' +
    "    process.send({ phase: 'failed', message: error.message });\n" +
    '    process.exitCode = 1;\n' +
    '}\n' +
    'process.disconnect();\n'

function lockWriter(t, file, stages, host = 'crashed.example.com', blob = raw) {
    const child = spawn(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            lockProgram,
            new URL('../dist/known-hosts.js', import.meta.url).href,
            file,
            blob.toString('base64'),
            stages,
            host,
        ],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
    )
    const messages = []
    const waiting = []
    let stderr = ''
    child.stderr.on('data', (data) => {
        stderr += data
    })
    child.on('message', (message) => {
        const resolve = waiting.shift()
        if (resolve) {
            resolve(message)
        } else {
            messages.push(message)
        }
    })
    const exit = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => resolve({ code, signal, stderr }))
    })
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL')
        }
        await exit
    })
    return {
        child,
        exit,
        next: () =>
            Promise.race([
                messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => waiting.push(resolve)),
                exit.then((result) => {
                    throw new Error(`writer exited before barrier: ${JSON.stringify(result)}`)
                }),
            ]),
        resume: () => child.send('continue'),
        stop: async () => {
            child.kill('SIGKILL')
            await exit
        },
    }
}

for (const phase of ['preparing', 'prepared', 'published', 'appended', 'released']) {
    test(
        `QL-SSH-01: a real process crash at ${phase} does not strand first-use trust`,
        { skip: process.platform !== 'linux', timeout: 10000 },
        async (t) => {
            const { directory, file, trust } = fixture(t)
            const child = lockWriter(t, file, phase)
            assert.deepEqual(await child.next(), { phase })
            await child.stop()
            const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
            assert.equal(
                (await trust.verify('recovered.example.com', 22, raw, undefined, Date.now() + 300)).status,
                'added'
            )
            assert.equal(fs.readFileSync(file, 'utf8'), previous + line('recovered.example.com'))
            assert.equal(fs.existsSync(`${file}.mcp-lock`), false)
            const leftovers = fs.readdirSync(directory).filter((name) => name.includes('.prepare-'))
            assert.equal(leftovers.length, phase === 'preparing' ? 1 : 0)
        }
    )
}

test(
    'QL-SSH-01: two real recoverers cannot unlink the newly published owner',
    { skip: process.platform !== 'linux', timeout: 10000 },
    async (t) => {
        const { file } = fixture(t)
        const dead = lockWriter(t, file, 'published')
        assert.deepEqual(await dead.next(), { phase: 'published' })
        await dead.stop()
        const first = lockWriter(t, file, 'recover,published', 'first.example.com')
        const second = lockWriter(t, file, 'recover', 'second.example.com')
        assert.deepEqual(await first.next(), { phase: 'recover' })
        assert.deepEqual(await second.next(), { phase: 'recover' })
        first.resume()
        assert.deepEqual(await first.next(), { phase: 'published' })
        const owner = fs.readdirSync(`${file}.mcp-lock`)
        second.resume()
        // An independent verifier must still see the live first owner, even after the stale observer resumed.
        const trust = new KnownHosts(file, [])
        await assert.rejects(
            trust.verify('blocked.example.com', 22, raw, undefined, Date.now() + 100),
            /locked|deadline/
        )
        assert.deepEqual(fs.readdirSync(`${file}.mcp-lock`), owner)
        first.resume()
        assert.deepEqual(await first.next(), { phase: 'done', status: 'added' })
        assert.deepEqual(await second.next(), { phase: 'done', status: 'added' })
        assert.equal((await first.exit).code, 0)
        assert.equal((await second.exit).code, 0)
        assert.equal(fs.readFileSync(file, 'utf8'), line('first.example.com') + line('second.example.com'))
    }
)

for (const state of ['live', 'EPERM', 'foreign-domain', 'reused-pid']) {
    test(
        `QL-SSH-01: ${state} owners retain exclusion until deadline and cancellation`,
        { skip: process.platform !== 'linux', timeout: 10000 },
        async (t) => {
            const { directory, file, trust } = fixture(t)
            const child = lockWriter(t, file, 'published')
            assert.deepEqual(await child.next(), { phase: 'published' })
            const lock = `${file}.mcp-lock`
            let [owner] = fs.readdirSync(lock)
            const record = JSON.parse(fs.readFileSync(path.join(lock, owner), 'utf8'))
            if (state === 'foreign-domain' || state === 'reused-pid') {
                await child.stop()
                if (state === 'foreign-domain') {
                    record.domain = 'another-machine-or-pid-namespace'
                } else {
                    record.pid = process.pid
                    const renamed = owner.replace(/owner-\d+-/, `owner-${process.pid}-`)
                    fs.renameSync(path.join(lock, owner), path.join(lock, renamed))
                    owner = renamed
                }
                fs.writeFileSync(path.join(lock, owner), JSON.stringify(record))
            }
            if (state === 'EPERM') {
                const kill = process.kill.bind(process)
                t.mock.method(process, 'kill', (pid, signal) => {
                    if (pid === child.child.pid && signal === 0) {
                        throw Object.assign(new Error('fixture liveness denied'), { code: 'EPERM' })
                    }
                    return kill(pid, signal)
                })
            }
            const contents = fs.readFileSync(path.join(lock, owner), 'utf8')
            await assert.rejects(
                trust.verify('blocked.example.com', 22, raw, undefined, Date.now() + 100),
                new RegExp('locked', '')
            )
            const controller = new AbortController()
            const pending = trust.verify('cancelled.example.com', 22, raw, controller.signal)
            const failure = assert.rejects(pending, /fixture cancellation/)
            controller.abort(new Error('fixture cancellation'))
            await failure
            assert.equal(fs.readFileSync(path.join(lock, owner), 'utf8'), contents)
            assert.equal(fs.existsSync(file), false)
            assert.equal(
                fs.readdirSync(directory).some((name) => name.includes('.prepare-')),
                false
            )
        }
    )
}

for (const platform of ['darwin', 'win32']) {
    for (const state of ['dead', 'live', 'foreign-domain', 'EPERM', 'query-failed', 'malformed', 'empty-guid']) {
        test(
            `QL-SSH-01: ${platform} boot-domain substitute preserves ${state} ownership`,
            { skip: process.platform !== 'linux' },
            async (t) => {
                const { file, trust } = fixture(t)
                const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
                const boot = '12345678-1234-4321-abcd-123456789abc'
                const pid = 123456789
                const lock = `${file}.mcp-lock`
                const owner = `owner-${pid}-${'a'.repeat(32)}.json`
                fs.mkdirSync(lock, { mode: 0o700 })
                const record = JSON.stringify({
                    version: 1,
                    pid,
                    domain: state === 'foreign-domain' ? 'another-boot' : `${platform}:${boot}`,
                })
                fs.writeFileSync(path.join(lock, owner), record, { mode: 0o600 })
                let queried = 0
                let probes = 0
                t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
                    const script = platform === 'win32' ? Buffer.from(args.at(-1), 'base64').toString('utf16le') : ''
                    if (platform === 'win32' && !script.includes('NtQuerySystemInformation')) {
                        return { status: 0, stdout: script.includes("Write('verified')") ? 'verified' : 'usable' }
                    }
                    ++queried
                    assert.equal(command, platform === 'win32' ? 'powershell.exe' : '/usr/sbin/sysctl')
                    assert.ok(options.timeout > 0 && options.timeout <= 120)
                    if (platform === 'win32') {
                        assert.deepEqual(args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-EncodedCommand'])
                        assert.match(script, /NtQuerySystemInformation\(90, out information, size, out length\)/)
                        assert.match(script, /public Guid BootIdentifier;/)
                        assert.match(script, /status != 0 \|\| length != size/)
                    } else {
                        assert.deepEqual(args, ['-n', 'kern.bootsessionuuid'])
                    }
                    return {
                        status: state === 'query-failed' ? 1 : 0,
                        stdout:
                            state === 'malformed'
                                ? 'not-a-boot-uuid'
                                : state === 'empty-guid'
                                  ? '00000000-0000-0000-0000-000000000000'
                                  : `  ${boot.toUpperCase()}\n`,
                    }
                })
                t.mock.method(process, 'kill', (value, signal) => {
                    ++probes
                    assert.equal(value, pid)
                    assert.equal(signal, 0)
                    if (state === 'dead' || state === 'EPERM') {
                        throw Object.assign(new Error('fixture liveness'), {
                            code: state === 'dead' ? 'ESRCH' : 'EPERM',
                        })
                    }
                    return true
                })
                const rename = fs.promises.rename.bind(fs.promises)
                t.mock.method(fs.promises, 'rename', async (...args) => {
                    const [entry] = fs.readdirSync(args[0])
                    assert.equal(
                        JSON.parse(fs.readFileSync(path.join(args[0], entry), 'utf8')).domain,
                        `${platform}:${boot}`
                    )
                    return rename(...args)
                })
                syncBuiltinESMExports()
                Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform })
                try {
                    if (state === 'dead') {
                        assert.equal(
                            (await trust.verify('recovered.example.com', 22, raw, undefined, Date.now() + 120)).status,
                            'added'
                        )
                        assert.equal(probes, 1)
                        assert.equal(fs.existsSync(lock), false)
                        assert.equal(fs.readFileSync(file, 'utf8'), line('recovered.example.com'))
                    } else {
                        await assert.rejects(
                            trust.verify('blocked.example.com', 22, raw, undefined, Date.now() + 120),
                            /locked/
                        )
                        assert.equal(fs.readFileSync(path.join(lock, owner), 'utf8'), record)
                        assert.equal(fs.existsSync(file), false)
                        assert.equal(probes > 0, state === 'live' || state === 'EPERM')
                    }
                    assert.equal(queried, 1)
                } finally {
                    Object.defineProperty(process, 'platform', originalPlatform)
                    t.mock.restoreAll()
                    syncBuiltinESMExports()
                }
            }
        )
    }
}

test(
    'QL-SSH-01: native macOS and Windows recover a crashed published owner',
    { skip: !['darwin', 'win32'].includes(process.platform), timeout: 60000 },
    async (t) => {
        const { file, trust } = fixture(t)
        const child = lockWriter(t, file, 'published')
        assert.deepEqual(await child.next(), { phase: 'published' })
        const [owner] = fs.readdirSync(`${file}.mcp-lock`)
        const record = JSON.parse(fs.readFileSync(path.join(`${file}.mcp-lock`, owner), 'utf8'))
        assert.match(record.domain, new RegExp(`^${process.platform}:[\\da-f-]{36}$`))
        await child.stop()
        assert.equal(
            (await trust.verify('recovered.example.com', 22, raw, undefined, Date.now() + 30000)).status,
            'added'
        )
        assert.equal(fs.existsSync(`${file}.mcp-lock`), false)
    }
)

for (const state of ['gone', 'new-owner', 'empty-denied', 'read-denied']) {
    test(`QL-SSH-01: EPERM lock release handles ${state} without deleting another owner`, async (t) => {
        const { file, trust } = fixture(t)
        const lock = `${file}.mcp-lock`
        const rmdir = fs.promises.rmdir.bind(fs.promises)
        const readdir = fs.promises.readdir.bind(fs.promises)
        let releasing = false
        let observed = false
        const denied = Object.assign(new Error('fixture directory removal denied'), { code: 'EPERM' })
        t.mock.method(fs.promises, 'rmdir', async (directory) => {
            if (directory === lock && fs.existsSync(file)) {
                releasing = true
                if (state === 'gone') {
                    await rmdir(directory)
                } else if (state === 'new-owner') {
                    fs.writeFileSync(path.join(lock, 'new-owner'), 'preserve', { mode: 0o600 })
                }
                throw denied
            }
            return rmdir(directory)
        })
        t.mock.method(fs.promises, 'readdir', async (directory) => {
            if (releasing && directory === lock) {
                observed = true
                if (state === 'read-denied') {
                    throw Object.assign(new Error('fixture directory read denied'), { code: 'EACCES' })
                }
            }
            return readdir(directory)
        })
        if (state === 'empty-denied' || state === 'read-denied') {
            await assert.rejects(
                trust.verify('released.example.com', 22, raw),
                state === 'empty-denied'
                    ? /EPERM.*fixture directory removal denied/
                    : /EACCES.*fixture directory read denied/
            )
        } else {
            assert.equal((await trust.verify('released.example.com', 22, raw)).status, 'added')
        }
        assert.equal(observed, true)
        assert.equal(fs.readFileSync(file, 'utf8'), line('released.example.com'))
        if (state === 'new-owner') {
            assert.equal(fs.readFileSync(path.join(lock, 'new-owner'), 'utf8'), 'preserve')
        }
        assert.equal(fs.existsSync(lock), state !== 'gone')
    })
}

test('QL-SSH-01: legacy empty lock files are retained with a bounded explanatory error', async (t) => {
    const { directory, file, trust } = fixture(t)
    const lock = `${file}.mcp-lock`
    fs.writeFileSync(lock, '', { mode: 0o600 })
    let now = Date.now()
    t.mock.method(Date, 'now', () => now)
    const lstat = fs.promises.lstat.bind(fs.promises)
    t.mock.method(fs.promises, 'lstat', async (...args) => {
        const stat = await lstat(...args)
        if (args[0] === lock) {
            now += 100
        }
        return stat
    })
    await assert.rejects(
        trust.verify('legacy.example.com', 22, raw, undefined, Date.now() + 100),
        /locked.*legacy.*retained/
    )
    assert.equal(fs.readFileSync(lock, 'utf8'), '')
    assert.equal(fs.existsSync(file), false)
    assert.deepEqual(fs.readdirSync(directory), [path.basename(lock)])
})

test('QL-SSH-01: publication settles before cancellation releases only its own owner', async (t) => {
    const { directory, file, trust } = fixture(t)
    const controller = new AbortController()
    const rename = fs.promises.rename.bind(fs.promises)
    let published
    const reached = new Promise((resolve) => {
        published = resolve
    })
    let resume
    const released = new Promise((resolve) => {
        resume = resolve
    })
    t.mock.method(fs.promises, 'rename', async (...args) => {
        await rename(...args)
        published()
        await released
    })
    const pending = trust.verify('cancelled.example.com', 22, raw, controller.signal)
    const failure = assert.rejects(pending, /fixture cancellation/)
    await reached
    controller.abort(new Error('fixture cancellation'))
    assert.equal(fs.readdirSync(`${file}.mcp-lock`).length, 1)
    resume()
    await failure
    assert.equal(fs.existsSync(file), false)
    assert.deepEqual(fs.readdirSync(directory), [])
})

for (const racing of [false, true]) {
    const scenario = racing ? 'racing' : 'existing'
    test(`QL-SSH-01: ${scenario} empty lock directories are removed before publication`, async (t) => {
        const { file, trust } = fixture(t)
        const lock = `${file}.mcp-lock`
        if (!racing) {
            fs.mkdirSync(lock, { mode: 0o700 })
        }
        const rename = fs.promises.rename.bind(fs.promises)
        let calls = 0
        t.mock.method(fs.promises, 'rename', async (...args) => {
            ++calls
            if (racing && calls === 1) {
                fs.mkdirSync(lock, { mode: 0o700 })
                throw Object.assign(new Error('fixture Windows empty-directory collision'), { code: 'EPERM' })
            }
            assert.equal(fs.existsSync(args[1]), false, 'publication must not depend on replacing an empty directory')
            return rename(...args)
        })
        assert.equal((await trust.verify('empty.example.com', 22, raw)).status, 'added')
        assert.equal(calls, racing ? 2 : 1)
        assert.equal(fs.existsSync(lock), false)
    })
}

test('QL-SSH-01: an actual publication permission failure is reported without waiting', async (t) => {
    const { directory, trust } = fixture(t)
    t.mock.method(fs.promises, 'rename', async () => {
        throw Object.assign(new Error('fixture rename denied'), { code: 'EPERM' })
    })
    await assert.rejects(trust.verify('denied.example.com', 22, raw), /EPERM.*fixture rename denied/)
    assert.deepEqual(fs.readdirSync(directory), [])
})

test('SSH-01: failed trust append preserves earlier records and their access mode', async (t) => {
    const { file, trust } = fixture(t)
    const original = '# preserve comment\n' + line('existing.example.com')
    fs.writeFileSync(file, original, { mode: 0o644 })
    const mode = fs.statSync(file).mode
    const open = fs.promises.open.bind(fs.promises)
    t.mock.method(fs.promises, 'open', async (...args) => {
        const handle = await open(...args)
        if (args[0] === file) {
            const write = handle.writeFile.bind(handle)
            handle.writeFile = async (entry) => {
                await write(entry.slice(0, 10))
                await externalAppend(file, line('external.example.com', other))
                throw Object.assign(new Error('fixture write failure'), { code: 'EIO' })
            }
        }
        return handle
    })
    await assert.rejects(
        trust.verify('new.example.com', 22, raw),
        /append.*unknown.*not rolled back.*EIO.*fixture write failure/
    )
    assert.equal(
        fs.readFileSync(file, 'utf8'),
        original + line('new.example.com').slice(0, 10) + line('external.example.com', other)
    )
    assert.equal(fs.statSync(file).mode, mode)
    assert.equal(fs.existsSync(`${file}.mcp-lock`), false)
})

function accessState(file) {
    if (process.platform !== 'win32') {
        return fs.statSync(file).mode
    }
    const script = `$ErrorActionPreference='Stop'; (Get-Acl -LiteralPath '${file.replace(/'/g, "''")}').Sddl`
    const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', timeout: 10000 }
    )
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
}

async function externalAppend(file, entry, replacement = '') {
    const program = `
const fs = require('node:fs');
const [file, entry, replacement] = process.argv.slice(1);
const fd = fs.openSync(file, 'a');
fs.writeFileSync(fd, entry);
fs.fsyncSync(fd);
fs.closeSync(fd);
if (replacement) {
    fs.renameSync(file, file + '.previous');
    const next = fs.openSync(file, 'wx', 0o644);
    fs.writeFileSync(next, replacement);
    fs.fsyncSync(next);
    fs.closeSync(next);
}
`
    await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', program, file, entry, replacement], { stdio: 'ignore' })
        child.once('error', reject)
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`external writer exited ${code}`))))
    })
}

for (const failure of ['sync', 'cancel', 'deadline', 'close']) {
    for (const replace of [false, true]) {
        test(
            'QL-SSH-02: ' +
                `${failure}` +
                ' after an external durable append preserves ' +
                `${replace ? 'replacement and old inode' : 'all shared bytes'}` +
                ' before authentication',
            async (t) => {
                const { file, manager } = fixture(t)
                const remote = await server(t)
                const original = '# preserve comment\n' + line('existing.example.com')
                const external = line('external.example.com', other)
                const replacement = '# replacement\n' + line('replacement.example.com', other)
                fs.writeFileSync(file, original, { mode: 0o644 })
                const access = accessState(file)
                const open = fs.promises.open.bind(fs.promises)
                let verificationDeadline
                const controller = new AbortController()
                t.mock.method(fs.promises, 'open', async (...args) => {
                    const handle = await open(...args)
                    if (args[0] === file) {
                        const sync = handle.sync.bind(handle)
                        handle.sync = async () => {
                            await sync()
                            await externalAppend(file, external, replace ? replacement : '')
                            if (failure === 'sync') {
                                throw Object.assign(new Error('fixture sync failure'), { code: 'EIO' })
                            }
                            if (failure === 'cancel') {
                                controller.abort(new Error('fixture verification cancellation'))
                            }
                            if (failure === 'deadline') {
                                t.mock.method(Date, 'now', () => verificationDeadline)
                            }
                        }
                        if (failure === 'close') {
                            const close = handle.close.bind(handle)
                            handle.close = async () => {
                                await close()
                                throw Object.assign(new Error('fixture close failure'), { code: 'EIO' })
                            }
                        }
                    }
                    return handle
                })
                let observed
                t.mock.method(manager.knownHosts, 'verify', async (...args) => {
                    try {
                        verificationDeadline = args[4]
                        args[3] = globalThis.AbortSignal.any([args[3], controller.signal])
                        return await KnownHosts.prototype.verify.call(manager.knownHosts, ...args)
                    } catch (error) {
                        observed = error
                        throw error
                    }
                })
                const callbacks = new Map()
                registerConnectionTools({
                    registerTool(name, _schema, callback) {
                        callbacks.set(name, callback)
                    },
                })
                t.mock.method(sessionManager, 'connect', manager.connect.bind(manager))
                const response = await callbacks.get('ssh_connect')({
                    host: '127.0.0.1',
                    port: remote.port,
                    user: 'fixture',
                    password: 'synthetic',
                    alias: 'fixture',
                })
                const result = JSON.parse(response.content[0].text)
                assert.equal(response.isError, true)
                assert.equal(result.success, false)
                assert.equal(result.details.failureStage, 'host_key')
                assert.equal(result.details.retryable, false)
                assert.match(result.error, /append.*unknown.*not rolled back/)
                assert.equal(remote.authentication(), 0)
                const appended = original + line(`[127.0.0.1]:${remote.port}`) + external
                assert.equal(fs.readFileSync(replace ? `${file}.previous` : file, 'utf8'), appended)
                assert.match(observed?.message ?? '', /append.*unknown.*not rolled back/)
                assert.equal(accessState(replace ? `${file}.previous` : file), access)
                if (replace) {
                    assert.equal(fs.readFileSync(file, 'utf8'), replacement)
                }
                assert.equal(fs.existsSync(`${file}.mcp-lock`), false)
            }
        )
    }
}

test('QL-SSH-02: original write, close, and release failures remain visible together', async (t) => {
    const { file, trust } = fixture(t)
    const original = '# comment\n' + line('existing.example.com')
    fs.writeFileSync(file, original, { mode: 0o644 })
    const access = accessState(file)
    const open = fs.promises.open.bind(fs.promises)
    t.mock.method(fs.promises, 'open', async (...args) => {
        const handle = await open(...args)
        if (args[0] === file) {
            const write = handle.writeFile.bind(handle)
            const close = handle.close.bind(handle)
            handle.writeFile = async (entry) => {
                await write(entry.slice(0, 10))
                throw Object.assign(new Error('original write failure'), { code: 'EIO' })
            }
            handle.close = async () => {
                await close()
                throw Object.assign(new Error('close cleanup failure'), { code: 'EBADF' })
            }
        }
        return handle
    })
    const unlink = fs.promises.unlink.bind(fs.promises)
    t.mock.method(fs.promises, 'unlink', async (...args) => {
        if (path.dirname(args[0]) === `${file}.mcp-lock`) {
            throw Object.assign(new Error('release cleanup failure'), { code: 'EACCES' })
        }
        return unlink(...args)
    })
    await assert.rejects(trust.verify('new.example.com', 22, raw), (error) => {
        assert.match(
            error.message,
            new RegExp(
                'unknown.*not rolled back.*EIO.*original write failure.*EBADF.*close ' +
                    'cleanup failure.*lock release failed.*EACCES.*release cleanup failure',
                ''
            )
        )
        assert.ok(error.cause instanceof globalThis.AggregateError)
        assert.equal(error.cause.errors.length, 3)
        return true
    })
    assert.equal(fs.readFileSync(file, 'utf8'), original + line('new.example.com').slice(0, 10))
    assert.equal(accessState(file), access)
})

test(
    'SSH-01: native Windows permits public readers, preserves DACL, and rejects untrusted writers',
    { skip: process.platform !== 'win32' },
    async (t) => {
        const { file, trust } = fixture(t)
        fs.writeFileSync(file, line('public.example.com'), { mode: 0o600 })
        const ps = (body) => {
            const script = `$ErrorActionPreference='Stop'; $path='${file.replace(/'/g, "''")}'; ${body}`
            const result = spawnSync(
                'powershell.exe',
                ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
                { encoding: 'utf8', timeout: 10000 }
            )
            assert.ifError(result.error)
            assert.equal(result.status, 0, result.stderr)
            return result.stdout.trim()
        }
        ps(
            '$acl=Get-Acl -LiteralPath $path; ' +
                "$sid=[Security.Principal.SecurityIdentifier]::new('S-1-1-0'); " +
                '$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid, ' +
                '[Security.AccessControl.FileSystemRights]::Read, ' +
                '[Security.AccessControl.AccessControlType]::Allow); ' +
                '$acl.AddAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $acl'
        )
        const before = ps('(Get-Acl -LiteralPath $path).Sddl')
        assert.equal((await trust.verify('public.example.com', 22, raw)).status, 'known')
        assert.equal(ps('(Get-Acl -LiteralPath $path).Sddl'), before)
        ps(
            '$acl=Get-Acl -LiteralPath $path; ' +
                "$sid=[Security.Principal.SecurityIdentifier]::new('S-1-1-0'); " +
                '$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid, ' +
                '[Security.AccessControl.FileSystemRights]::Write, ' +
                '[Security.AccessControl.AccessControlType]::Allow); ' +
                '$acl.AddAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $acl'
        )
        await assert.rejects(trust.verify('public.example.com', 22, raw), /integrity/)
    }
)

test('R29-SSH-01: a late verifier from the old client cannot stop an explicit replacement', async (t) => {
    const { manager, trust } = fixture(t)
    const remote = await server(t)
    const verify = trust.verify.bind(trust)
    let rejectOld
    let started
    const requested = new Promise((resolve) => {
        started = resolve
    })
    let verifications = 0
    t.mock.method(trust, 'verify', (...args) => {
        if (++verifications === 2) {
            started()
            return new Promise((_resolve, reject) => {
                rejectOld = reject
            })
        }
        return verify(...args)
    })
    await manager.connect(connection(remote.port))
    ;[...remote.clients][0].rekey()
    await requested
    await manager.reconnect('fixture')
    const current = manager.getSession('fixture')
    rejectOld(new HostKeyError('synthetic late host key rejection'))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(manager.getSession('fixture'), current)
    assert.equal(current.connectionError, undefined)
    assert.equal(current.reconnectTimer, undefined)
})
