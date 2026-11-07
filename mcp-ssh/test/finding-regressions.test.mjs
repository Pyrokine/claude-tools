import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import childProcess from 'node:child_process'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { registerFileTools } from '../dist/tools/file.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import test from 'node:test'
import { OperationManager } from '../dist/operation-manager.js'
import { PtyManager } from '../dist/pty-manager.js'
import { SessionManager, sessionManager } from '../dist/session-manager.js'
import { getFileInfo, syncFiles, uploadFile } from '../dist/file-ops.js'
import { registerExecTools } from '../dist/tools/exec.js'
import { registerConnectionTools } from '../dist/tools/connection.js'
import { parseProxyJump } from '../dist/ssh-config.js'

function temporary(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-findings-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    return directory
}

function handlers(register) {
    const result = new Map()
    register({
        registerTool(name, _schema, callback) {
            result.set(name, callback)
        },
    })
    return result
}

function content(response) {
    return JSON.parse(response.content[0].text)
}

function patch(t, object, name, value) {
    const original = object[name]
    object[name] = value
    t.after(() => {
        if (original === undefined) {
            delete object[name]
        } else {
            object[name] = original
        }
    })
}

function sftpFixture() {
    const readDirectories = new Set()
    return {
        stat(name, callback) {
            fs.stat(name, callback)
        },
        lstat(name, callback) {
            fs.lstat(name, callback)
        },
        realpath(name, callback) {
            fs.realpath(name, callback)
        },
        opendir(name, callback) {
            callback(null, Buffer.from(name))
        },
        close(_handle, callback) {
            callback(null)
        },
        readdir(name, callback) {
            const directory = name.toString()
            if (Buffer.isBuffer(name)) {
                if (readDirectories.has(directory)) {
                    callback(Object.assign(new Error('EOF'), { code: 1 }))
                    return
                }
                readDirectories.add(directory)
            }
            try {
                callback(
                    null,
                    fs.readdirSync(directory).map((filename) => ({
                        filename,
                        attrs: fs.statSync(path.join(directory, filename)),
                    }))
                )
            } catch (error) {
                callback(error)
            }
        },
        mkdir(name, callback) {
            fs.mkdir(name, callback)
        },
        /** @type {(name: import('node:fs').PathLike) => Readable} */
        createReadStream: (name) => fs.createReadStream(name),
        createWriteStream(name, options) {
            return fs.createWriteStream(name, options)
        },
        end() {},
    }
}

function sftpSession(t, sftp) {
    patch(t, sessionManager, 'getSftp', async () => (typeof sftp === 'function' ? sftp() : sftp))
    patch(t, sessionManager, 'getRemotePlatform', () => 'posix')
    patch(t, sessionManager, 'getRemotePathStyle', () => 'posix')
    patch(t, sessionManager, 'getExternalTransferCapability', () => ({
        rsyncEligible: false,
        decisionReason: 'fixture',
    }))
}

test('MH-SSH-01 public directory verification shares the transfer deadline and keeps progress', async (t) => {
    for (const direction of ['upload', 'download']) {
        for (const stage of ['success', 'hash', 'metadata']) {
            await t.test(`${direction}/${stage}`, async (t) => {
                const root = temporary(t)
                const local = path.join(root, 'local')
                const remote = path.join(root, 'remote')
                fs.mkdirSync(local)
                fs.mkdirSync(remote)
                fs.writeFileSync(path.join(direction === 'upload' ? local : remote, 'data.txt'), 'DATA')
                t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
                let transferred = false
                let blockedStream
                let releaseMetadata
                let blockedMetadata = false
                let lateMetadataCalls = 0
                const readStream = fs.createReadStream
                const readdir = fs.promises.readdir
                const lstat = fs.promises.lstat
                sftpSession(t, () => {
                    const sftp = sftpFixture()
                    return {
                        ...sftp,
                        createReadStream(name) {
                            return readStream(name)
                        },
                        createWriteStream(name, options) {
                            const stream = fs.createWriteStream(name, options)
                            stream.once('finish', () => {
                                transferred = true
                            })
                            return stream
                        },
                    }
                })
                t.mock.method(fs, 'createReadStream', (name, options) => {
                    if (
                        stage === 'hash' &&
                        String(name) === path.join(local, 'data.txt') &&
                        (direction === 'download' || transferred)
                    ) {
                        blockedStream = new Readable({ read() {} })
                        globalThis.queueMicrotask(() => t.mock.timers.tick(251))
                        return blockedStream
                    }
                    return readStream(name, options)
                })
                t.mock.method(fs.promises, 'readdir', (name, ...args) => {
                    if (stage === 'metadata' && String(name) === local && (direction === 'download' || transferred)) {
                        blockedMetadata = true
                        globalThis.queueMicrotask(() => t.mock.timers.tick(251))
                        return new Promise((resolve) => {
                            releaseMetadata = resolve
                        })
                    }
                    return readdir(name, ...args)
                })
                t.mock.method(fs.promises, 'lstat', (...args) => {
                    if (blockedMetadata) {
                        ++lateMetadataCalls
                    }
                    return lstat(...args)
                })
                syncBuiltinESMExports()
                t.after(() => {
                    t.mock.restoreAll()
                    syncBuiltinESMExports()
                })
                const result = content(
                    await handlers(registerFileTools).get('ssh_sync')({
                        alias: 'fixture',
                        localPath: local,
                        remotePath: remote,
                        direction,
                        recursive: true,
                        operationTimeout: 250,
                        verify: { sha256: true, count: true },
                    })
                )
                assert.equal(result.transferSuccess, true, JSON.stringify(result))
                assert.equal(result.filesTransferred, 1)
                assert.equal(result.bytesTransferred, 4)
                assert.equal(
                    fs.readFileSync(path.join(direction === 'upload' ? remote : local, 'data.txt'), 'utf8'),
                    'DATA'
                )
                if (stage === 'success') {
                    assert.equal(result.success, true, JSON.stringify(result))
                    assert.equal(result.verificationSuccess, true)
                } else {
                    assert.equal(result.success, false, JSON.stringify(result))
                    assert.equal(result.verificationSuccess, false)
                    assert.equal(result.verification.failureStage, 'verification_timeout')
                    assert.equal(result.verification.status, 'unknown')
                    assert.equal(result.verification.timedOut, true)
                    if (stage === 'hash') {
                        assert.equal(blockedStream.destroyed, true)
                    } else {
                        assert.equal(blockedMetadata, true)
                        releaseMetadata(['data.txt'])
                        await Promise.resolve()
                        await Promise.resolve()
                        assert.equal(lateMetadataCalls, 0)
                    }
                }
            })
        }
    }
})

test('MH-SSH-01 download deletion baselines stop before transfer when their budget expires', async (t) => {
    const root = temporary(t)
    const local = path.join(root, 'local')
    const remote = path.join(root, 'remote')
    fs.mkdirSync(local)
    fs.mkdirSync(remote)
    fs.writeFileSync(path.join(remote, 'data.txt'), 'DATA')
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
    let reads = 0
    let release
    const readdir = fs.promises.readdir
    sftpSession(t, () => ({
        ...sftpFixture(),
        createReadStream() {
            ++reads
            throw new Error('transfer started after baseline timeout')
        },
    }))
    t.mock.method(fs.promises, 'readdir', (name, ...args) => {
        if (String(name) === local) {
            globalThis.queueMicrotask(() => t.mock.timers.tick(251))
            return new Promise((resolve) => {
                release = resolve
            })
        }
        return readdir(name, ...args)
    })
    const result = content(
        await handlers(registerFileTools).get('ssh_sync')({
            alias: 'fixture',
            localPath: local,
            remotePath: remote,
            direction: 'download',
            recursive: true,
            delete: true,
            operationTimeout: 250,
            verify: { deletions: true },
        })
    )
    assert.equal(result.success, false, JSON.stringify(result))
    assert.equal(result.transferSuccess, false)
    assert.equal(result.verification.failureStage, 'verification_timeout')
    assert.equal(reads, 0)
    assert.deepEqual(fs.readdirSync(local), [])
    release([])
    await Promise.resolve()
})

test('SSH-05/12: full operation buffers stop copying and mixed UTF-8 pages make progress', async (t) => {
    const stream = new PassThrough()
    stream.stderr = new PassThrough()
    const manager = new OperationManager({
        async openStream(_alias, _command, marker, _options, adopt) {
            adopt(stream)
            stream.stderr.write(`__MCP_SSH_OPERATION__:${marker}:4321:0\n`)
        },
        async cancelRemote() {
            return { success: true }
        },
    })
    t.after(() => manager.close())
    const { operationId } = await manager.start('fixture', 'output', { maxOutputBytes: 1024 })
    stream.write('abc')
    stream.stderr.write('中')
    const first = manager.read(operationId, { maxBytes: 4 })
    assert.equal(first.stdout, 'abc')
    assert.equal(first.stderr, '')
    assert.equal(first.nextStderrOffset, 0)
    assert.equal(manager.read(operationId, { stdoutOffset: 3, maxBytes: 3 }).stderr, '中')
    stream.write(Buffer.alloc(1024))
    const record = manager.operations.get(operationId)
    const retained = record.stdout
    stream.write(Buffer.alloc(1024))
    assert.equal(record.stdout, retained)
    assert.equal(manager.status(operationId).stdoutTruncated, true)
})

test('SSH-06: completed exec and batch results survive a later disconnect', async (t) => {
    const tools = handlers(registerExecTools)
    let executions = 0
    patch(t, sessionManager, 'getCommandShell', () => {
        throw new Error('disconnected')
    })
    patch(t, sessionManager, 'exec', async () => {
        ++executions
        if (executions > 1) {
            throw new Error('disconnected')
        }
        return { success: true, stdout: 'COMPLETED', stderr: '', exitCode: 0, duration: 1, shell: 'posix' }
    })
    const single = content(await tools.get('ssh_exec')({ alias: 'fixture', command: 'true' }))
    assert.equal(single.stdout, 'COMPLETED')
    executions = 0
    const batch = content(await tools.get('ssh_exec_batch')({ alias: 'fixture', commands: ['true', 'true'] }))
    assert.equal(batch.results[0].stdout, 'COMPLETED')
    assert.equal(batch.executed, 2)
    assert.equal(batch.results[1].success, false)
})

test('SSH-REQUEST-BUDGET: parallel and batch keep statuses under a cumulative output cap', async (t) => {
    const tools = handlers(registerExecTools)
    let executions = 0
    patch(t, sessionManager, 'getCommandShell', () => 'posix')
    patch(t, sessionManager, 'exec', async () => {
        ++executions
        return {
            success: true,
            stdout: '中'.repeat(1024 * 1024),
            stderr: '',
            exitCode: 0,
            duration: 1,
            shell: 'posix',
            stdoutBytes: 3 * 1024 * 1024,
        }
    })
    for (const [tool, args] of [
        ['ssh_exec_parallel', { aliases: Array.from({ length: 12 }, (_, i) => `fixture-${i}`), command: 'true' }],
        ['ssh_exec_batch', { alias: 'fixture', commands: Array(12).fill('true') }],
    ]) {
        const before = executions
        const result = content(await tools.get(tool)(args))
        const bytes = result.results.reduce(
            (sum, entry) => sum + Buffer.byteLength(entry.stdout) + Buffer.byteLength(entry.stderr),
            0
        )
        assert.ok(bytes <= 16 * 1024 * 1024, `${tool}: ${bytes} bytes`)
        assert.equal(result.results.length, 12)
        assert.equal(executions - before, 12)
        assert.ok(result.results.every((entry) => entry.success && entry.exitCode === 0))
        assert.ok(result.outputTruncated)
        assert.ok(result.results.some((entry) => entry.stdoutTruncated))
    }
})

test('SSH-10/11: invalid JSON is safe, ProxyJump none disables hops, explicit hops override config', async (t) => {
    patch(t, process.env, 'SSH_MCP_TEMPLATES', '{"fixture":{"password":S10X}}')
    const connect = handlers(registerConnectionTools).get('ssh_connect')
    const error = content(await connect({ template: 'fixture' }))
    assert.equal(JSON.stringify(error).includes('S10X'), false)
    assert.match(error.error, /JSON/)
    assert.equal(parseProxyJump('none'), null)
    assert.equal(parseProxyJump(' NONE '), null)
})

test('SSH-13/17: screen waits for final xterm parse and output applies backpressure', async (t) => {
    const stream = new PassThrough()
    stream.close = () => stream.emit('close')
    const manager = new PtyManager()
    const id = await manager.start(
        {
            async execPty() {
                return stream
            },
        },
        'fixture',
        'output',
        { bufferSize: 1024 }
    )
    t.after(() => manager.close(id))
    stream.emit('data', Buffer.from('FINAL OUTPUT'))
    stream.emit('close')
    const screen = await manager.read(id)
    assert.equal(screen.active, false)
    assert.match(screen.data, /FINAL OUTPUT/)
    const second = new PassThrough()
    second.close = () => second.emit('close')
    const secondId = await manager.start(
        {
            async execPty() {
                return second
            },
        },
        'fixture',
        'burst',
        { bufferSize: 1024 }
    )
    t.after(() => manager.close(secondId))
    second.emit('data', Buffer.alloc(1024 * 1024, 65))
    assert.equal(second.isPaused(), true)
    await manager.read(secondId)
    assert.equal(second.isPaused(), false)
    assert.equal((await manager.read(secondId, { mode: 'raw' })).rawBufferLimit, 1024)
})

test('SSH-14: close without exit status preserves unknown; exit signals remain remote failures', async (t) => {
    const manager = new SessionManager(path.join(temporary(t), 'sessions.json'))
    const client = new EventEmitter()
    let stream
    client.exec = (_command, _options, callback) => {
        stream = new PassThrough()
        stream.stderr = new PassThrough()
        stream.close = () => {}
        callback(null, stream)
    }
    manager.sessions.set('fixture', {
        client,
        config: { host: 'example.com', port: 22, username: 'fixture' },
        connected: true,
        connectedAt: 1,
        lastUsedAt: 1,
        manualClose: false,
    })
    for (const sudo of [false, true]) {
        const pending = sudo ? manager.execSudo('fixture', 'true', 'synthetic') : manager.exec('fixture', 'true')
        stream.emit('data', Buffer.from('CONFIRMED OUTPUT'))
        stream.emit('close')
        const result = await pending
        assert.equal(result.operationStatus, 'unknown')
        assert.equal(result.failureKind, 'ssh_transport')
        assert.equal(result.exitCode, null)
        assert.equal(result.stdout, 'CONFIRMED OUTPUT')
        assert.equal(result.retryable, false)
    }
    const pending = manager.exec('fixture', 'true')
    stream.emit('close', null, 'TERM')
    const signalled = await pending
    assert.equal(signalled.failureKind, 'remote_command')
    assert.equal(signalled.exitSignal, 'TERM')
    assert.equal(signalled.operationStatus, 'failed')
})

test('SSH-02: a late SFTP resource cannot OPEN or MKDIR after cancellation', async (t) => {
    const directory = temporary(t)
    const source = path.join(directory, 'source')
    fs.writeFileSync(source, 'source')
    let release
    let opens = 0
    let ended = 0
    const controller = new AbortController()
    patch(
        t,
        sessionManager,
        'getSftp',
        () =>
            new Promise((resolve) => {
                release = resolve
            })
    )
    const pending = uploadFile('fixture', source, '/target', undefined, undefined, undefined, controller.signal)
    controller.abort(new Error('fixture cancelled'))
    release({
        createWriteStream() {
            ++opens
            return new PassThrough()
        },
        end() {
            ++ended
        },
    })
    await assert.rejects(pending, /cancelled/)
    assert.equal(opens, 0)
    assert.equal(ended, 1)
})

test(
    'SSH-03: directory download checks each real destination and permits in-range symlinks',
    { skip: process.platform === 'win32' },
    async (t) => {
        const directory = temporary(t)
        const allowed = path.join(directory, 'allowed')
        const outside = path.join(directory, 'outside')
        const remote = path.join(directory, 'remote')
        fs.mkdirSync(allowed)
        fs.mkdirSync(outside)
        fs.mkdirSync(path.join(remote, 'link', 'empty'), { recursive: true })
        fs.symlinkSync(outside, path.join(allowed, 'link'))
        patch(t, process.env, 'SSH_MCP_FILE_OPS_ALLOW_DIRS', allowed)
        sftpSession(t, sftpFixture())
        const result = await syncFiles('fixture', allowed, remote, 'download')
        assert.equal(result.success, false)
        assert.equal(fs.existsSync(path.join(outside, 'empty')), false)
        fs.unlinkSync(path.join(allowed, 'link'))
        const inside = path.join(allowed, 'inside')
        fs.mkdirSync(inside)
        fs.symlinkSync(inside, path.join(allowed, 'link'))
        const success = await syncFiles('fixture', allowed, remote, 'download')
        assert.equal(success.success, true)
        assert.equal(fs.existsSync(path.join(inside, 'empty')), true)
    }
)

for (const direction of ['upload', 'download']) {
    for (const verify of [undefined, { sha256: false }]) {
        test(`F051: ${direction} skips unrequested hashes with verify=${JSON.stringify(verify)}`, async (t) => {
            const directory = temporary(t)
            const source = path.join(directory, 'source')
            const target = path.join(directory, 'target')
            fs.writeFileSync(source, 'DATA')
            sftpSession(t, sftpFixture())
            patch(t, sessionManager, 'exec', async () => {
                throw new Error('exec is disabled')
            })
            const hashes = []
            const createHash = crypto.createHash
            patch(t, crypto, 'createHash', (...args) => {
                hashes.push(args[0])
                return createHash(...args)
            })
            syncBuiltinESMExports()
            t.after(() => syncBuiltinESMExports())
            const result = content(
                await handlers(registerFileTools).get('ssh_sync')({
                    alias: 'fixture',
                    direction,
                    localPath: direction === 'upload' ? source : target,
                    remotePath: direction === 'upload' ? target : source,
                    verify,
                })
            )
            assert.equal(result.success, true, JSON.stringify(result))
            assert.equal(result.filesTransferred, 1)
            assert.equal(result.bytesTransferred, 4)
            assert.equal(fs.readFileSync(target, 'utf8'), 'DATA')
            assert.deepEqual(hashes, [])
            assert.equal(result.transportVerification.status, 'completed')
            assert.equal(result.transportVerification.hashAlgorithm, undefined)
            assert.equal(result.transportVerification.local.sha256, undefined)
            assert.equal(result.transportVerification.remote.sha256, undefined)
        })
    }
}

test('SSH-15: completed single-file bytes remain visible when hash verification times out', async (t) => {
    const directory = temporary(t)
    const source = path.join(directory, 'source')
    const target = path.join(directory, 'target')
    fs.writeFileSync(source, 'DATA')
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
    const sftp = sftpFixture()
    let verificationReads = 0
    sftp.createReadStream = () => {
        ++verificationReads
        globalThis.queueMicrotask(() => t.mock.timers.tick(51))
        return new Readable({ read() {} })
    }
    sftpSession(t, sftp)
    const result = await syncFiles('fixture', source, target, 'upload', { operationTimeout: 50 })
    assert.equal(verificationReads, 1)
    assert.equal(fs.readFileSync(target, 'utf8'), 'DATA')
    assert.equal(result.filesTransferred, 1)
    assert.equal(result.bytesTransferred, 4)
    assert.equal(result.verification.status, 'unknown')
    assert.equal(result.operationStatus, 'unknown')
})

test('SSH-02: directory cancellation before a delayed stat cannot issue MKDIR', async (t) => {
    const source = temporary(t)
    let release
    let mkdirs = 0
    const controller = new AbortController()
    const sftp = {
        stat(_name, callback) {
            release = callback
        },
        mkdir(_name, callback) {
            ++mkdirs
            callback(null)
        },
        end() {},
    }
    sftpSession(t, sftp)
    const pending = syncFiles('fixture', source, '/missing', 'upload', { signal: controller.signal })
    for (let i = 0; i < 30 && !release; ++i) {
        await new Promise((resolve) => setImmediate(resolve))
    }
    controller.abort(new Error('fixture cancelled'))
    release(Object.assign(new Error('not found'), { code: 2 }))
    const result = await pending
    assert.equal(result.success, false)
    assert.equal(mkdirs, 0)
})

test('SSH-15: completed download publication is counted before verification', async (t) => {
    const directory = temporary(t)
    const source = path.join(directory, 'source')
    const target = path.join(directory, 'target')
    fs.writeFileSync(source, 'DATA')
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
    const sftp = sftpFixture()
    let reads = 0
    sftp.createReadStream = () => {
        if (++reads === 1) {
            return Readable.from(['DATA'])
        }
        globalThis.queueMicrotask(() => t.mock.timers.tick(51))
        return new Readable({ read() {} })
    }
    sftpSession(t, sftp)
    const result = await syncFiles('fixture', target, source, 'download', { operationTimeout: 50 })
    assert.equal(reads, 2)
    assert.equal(fs.readFileSync(target, 'utf8'), 'DATA')
    assert.equal(result.filesTransferred, 1)
    assert.equal(result.bytesTransferred, 4)
    assert.equal(result.verification.status, 'unknown')
})

test('SSH-16: public sync probe consumes the request deadline before acquiring SFTP', async (t) => {
    const source = path.join(temporary(t), 'source')
    fs.writeFileSync(source, 'DATA')
    let stats = 0
    let ended = 0
    sftpSession(
        t,
        () =>
            new Promise((resolve) =>
                setTimeout(
                    () =>
                        resolve({
                            stat(_name, callback) {
                                ++stats
                                callback(null, { size: 0, mode: 0o040755 })
                            },
                            end() {
                                ++ended
                            },
                        }),
                    30
                )
            )
    )
    const result = content(
        await handlers(registerFileTools).get('ssh_sync')({
            alias: 'fixture',
            direction: 'upload',
            localPath: source,
            remotePath: '/target',
            operationTimeout: 5,
        })
    )
    assert.equal(result.success, false)
    assert.match(result.error, /timeout/)
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(stats, 0)
    assert.equal(ended, 1)
})

test('SSH-08: real sync consumer counts complete rsync streams beyond preview limits in both directions', async (t) => {
    const directory = temporary(t)
    const source = path.join(directory, 'source')
    fs.writeFileSync(source, 'DATA')
    patch(t, sessionManager, 'getRemotePlatform', () => 'posix')
    patch(t, sessionManager, 'getRemotePathStyle', () => 'posix')
    patch(t, sessionManager, 'getExternalTransferCapability', () => ({
        host: 'example.com',
        username: 'fixture',
        port: 22,
        rsyncEligible: true,
        decisionReason: 'fixture',
        commandShell: 'posix',
    }))
    patch(t, sessionManager, 'exec', async () => ({ success: true, exitCode: 0, stdout: '/usr/bin/rsync', stderr: '' }))
    patch(t, sessionManager, 'getSftp', async () => sftpFixture())
    let direction
    patch(t, childProcess, 'spawn', (command) => {
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = () => true
        setImmediate(() => {
            if (command === 'rsync') {
                const output = Buffer.from(
                    Array.from(
                        { length: 12000 },
                        (_, i) => `${direction}f+++++++++ file-${i.toString().padStart(8, '0')}\n`
                    ).join('') + '*deleting old-file\nNumber of regular files transferred: 12,000\n'
                )
                for (let offset = 0; offset < output.length; offset += 37) {
                    child.stdout.write(output.subarray(offset, offset + 37))
                }
            }
            child.emit('close', 0)
        })
        return child
    })
    syncBuiltinESMExports()
    t.after(() => syncBuiltinESMExports())
    for (direction of ['<', '>']) {
        const result = await syncFiles('rsync-fixture', source, source, direction === '<' ? 'upload' : 'download', {
            dryRun: true,
        })
        assert.equal(result.method, 'rsync')
        assert.equal(result.stats.added, 12000)
        assert.equal(result.stats.updated, 0)
        assert.equal(result.stats.deleted, 1)
        assert.equal(result.filesTransferred, 12000)
        assert.equal(result.outputTruncated, true)
        assert.equal(result.output.length, 200000)
    }
})

test('I009 and I051 rsync prepares download parents and parses split progress without losing statistics', async (t) => {
    const root = temporary(t)
    const source = path.join(root, 'source')
    fs.writeFileSync(source, 'owned')
    patch(t, sessionManager, 'getRemotePlatform', () => 'posix')
    patch(t, sessionManager, 'getRemotePathStyle', () => 'posix')
    patch(t, sessionManager, 'getExternalTransferCapability', () => ({
        host: 'example.com',
        username: 'fixture',
        port: 22,
        rsyncEligible: true,
        decisionReason: 'owned',
        commandShell: 'posix',
    }))
    patch(t, sessionManager, 'exec', async () => ({ success: true, exitCode: 0, stdout: '/usr/bin/rsync', stderr: '' }))
    patch(t, sessionManager, 'getSftp', async () => sftpFixture())
    let rsyncCalls = 0
    patch(t, childProcess, 'spawn', (command, args) => {
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = () => true
        setImmediate(() => {
            if (command === 'rsync') {
                ++rsyncCalls
                assert.ok(args.includes('--progress'))
                if (!fs.existsSync(path.dirname(args.at(-1)))) {
                    child.stderr.write('Local parent does not exist')
                    child.emit('close', 11)
                    return
                }
                const output =
                    '\r1,024 50% 1.00kB/s 0:00:01\r2,048 100% 1.00kB/s 0:00:00\r>f+++++++++ owned\nNumber of regular files transferred: 1\n'
                for (let offset = 0; offset < output.length; offset += 7) {
                    child.stdout.write(output.slice(offset, offset + 7))
                }
            }
            child.emit('close', 0)
        })
        return child
    })
    syncBuiltinESMExports()
    t.after(() => syncBuiltinESMExports())
    const progress = []
    const target = path.join(root, 'new', 'nested', 'target')
    const result = await syncFiles('owned-rsync', target, source, 'download', {
        onProgress: (item) => progress.push(item),
    })
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(fs.existsSync(path.dirname(target)), true)
    assert.equal(result.filesTransferred, 1)
    assert.equal(result.stats.added, 1)
    assert.deepEqual(
        progress.map((item) => [item.transferred, item.percent]),
        [
            [1024, 50],
            [2048, 100],
        ]
    )
    fs.writeFileSync(path.join(root, 'blocked'), 'preserved')
    const failed = await syncFiles('owned-rsync', path.join(root, 'blocked', 'target'), source, 'download', {
        onProgress() {},
    })
    assert.equal(failed.success, false)
    assert.equal(failed.operationStatus, 'failed')
    assert.equal(failed.failureStage, 'local_prepare')
    assert.equal(rsyncCalls, 1)
    assert.equal(fs.readFileSync(path.join(root, 'blocked'), 'utf8'), 'preserved')
})

test('SSH-11: public config selection skips overridden ProxyJump validation', async (t) => {
    const directory = temporary(t)
    const configPath = path.join(directory, 'config')
    patch(t, process.env, 'SSH_MCP_ALLOWED_KEY_DIRS', directory)
    patch(t, process.env, 'SSH_MCP_TEMPLATES', '')
    fs.writeFileSync(
        configPath,
        'Host fixture\n  HostName example.com\n  User fixture\n  ProxyJump missing-user.example.com\n'
    )
    let selected
    patch(t, sessionManager, 'listSessionDetails', () => [])
    patch(t, sessionManager, 'connect', async (config) => {
        selected = config
        return 'fixture'
    })
    patch(t, sessionManager, 'getSessionConnectionInfo', () => ({
        alias: 'fixture',
        identity: 'fixture@example.com:22',
        backend: 'ssh2',
        host: 'example.com',
        port: 22,
    }))
    const connect = handlers(registerConnectionTools).get('ssh_connect')
    const explicit = content(
        await connect({ configHost: 'fixture', configPath, jumpHost: { host: 'jump.example.com', user: 'fixture' } })
    )
    assert.equal(explicit.success, true)
    assert.equal(selected.jumpHost.host, 'jump.example.com')
    fs.writeFileSync(configPath, 'Host fixture\n  HostName example.com\n  User fixture\n  ProxyJump none\n')
    assert.equal(content(await connect({ configHost: 'fixture', configPath })).success, true)
    assert.equal(selected.jumpHost, undefined)
})

test('SSH-02: directory timeout prevents a late acquired resource from making directories', async (t) => {
    const directory = temporary(t)
    const source = path.join(directory, 'source')
    fs.mkdirSync(source)
    let release
    let mkdirs = 0
    let ended = 0
    sftpSession(
        t,
        () =>
            new Promise((resolve) => {
                release = resolve
            })
    )
    const result = await syncFiles('fixture', source, '/target', 'upload', { operationTimeout: 20 })
    assert.equal(result.operationStatus, 'unknown')
    release({
        stat(_name, callback) {
            callback(Object.assign(new Error('missing'), { code: 2 }))
        },
        mkdir(_name, callback) {
            ++mkdirs
            callback(null)
        },
        end() {
            ++ended
        },
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(mkdirs, 0)
    assert.equal(ended, 1)
})

test('SSH-16: SFTP acquisition and stat share one metadata deadline', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
    let release
    let stats = 0
    let ended = 0
    patch(
        t,
        sessionManager,
        'getSftp',
        () =>
            new Promise((resolve) => {
                release = resolve
            })
    )
    const pending = getFileInfo('fixture', '/file', 100)
    const rejected = assert.rejects(pending, /timed out/)
    t.mock.timers.tick(60)
    release({
        stat() {
            ++stats
        },
        end() {
            ++ended
        },
    })
    for (let i = 0; i < 8; ++i) {
        await Promise.resolve()
    }
    assert.equal(stats, 1)
    t.mock.timers.tick(41)
    await rejected
    assert.ok(ended >= 1)
})

test('SSH-17: parser rejection closes the channel while keeping raw bytes readable', async (t) => {
    const stream = new PassThrough()
    stream.close = () => stream.emit('close')
    const manager = new PtyManager()
    const id = await manager.start(
        {
            async execPty() {
                return stream
            },
        },
        'fixture',
        'output'
    )
    t.after(() => manager.close(id))
    manager.sessions.get(id).terminal.write = () => {
        throw new Error('fixture parser rejection')
    }
    stream.emit('data', Buffer.from('READABLE RAW'))
    const result = await manager.read(id, { mode: 'raw' })
    assert.equal(result.active, false)
    assert.equal(result.data, 'READABLE RAW')
    assert.equal(result.parserError, 'fixture parser rejection')
    assert.equal(stream.destroyed, true)
    assert.equal(manager.sessions.get(id).parseWaiters.size, 0)
})
