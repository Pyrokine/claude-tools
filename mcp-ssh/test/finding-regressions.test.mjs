import { Buffer } from 'node:buffer'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import childProcess from 'node:child_process'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { registerFileTools } from '../dist/tools/file.js'
import fs from 'node:fs'
import filePromises from 'node:fs/promises'

import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { PassThrough, Readable, Writable } from 'node:stream'
import test from 'node:test'
import { clearTimeout } from 'node:timers'
import { OperationManager } from '../dist/operation-manager.js'
import { PtyManager } from '../dist/pty-manager.js'
import { SessionManager, sessionManager } from '../dist/session-manager.js'
import {
    createEmptyRemoteFile,
    getFileInfo,
    prepareWindowsRemotePrivateFile,
    syncFiles,
    uploadFile,
    writeFile,
} from '../dist/file-ops.js'
import { registerExecTools } from '../dist/tools/exec.js'
import { registerConnectionTools } from '../dist/tools/connection.js'
import { parseProxyJump } from '../dist/ssh-config.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { SftpWriteState } from '../dist/sftp-timeout.js'
import { formatFilePermissions } from '../dist/file-mode.js'
import sftpProtocol from 'ssh2/lib/protocol/SFTP.js'

function temporary(t) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-findings-')))
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
                const readdir = filePromises.readdir
                const lstat = filePromises.lstat
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
                t.mock.method(
                    filePromises,
                    'readdir',
                    /** @type {typeof filePromises.readdir} */ (
                        (name, options) => {
                            if (
                                stage === 'metadata' &&
                                String(name) === local &&
                                (direction === 'download' || transferred)
                            ) {
                                blockedMetadata = true
                                globalThis.queueMicrotask(() => t.mock.timers.tick(251))
                                return new Promise((resolve) => {
                                    releaseMetadata = resolve
                                })
                            }
                            return Reflect.apply(readdir, filePromises, [name, options])
                        }
                    )
                )
                t.mock.method(
                    filePromises,
                    'lstat',
                    (
                        /** @type {import('node:fs').PathLike} */ name,
                        /** @type {import('node:fs').StatOptions | undefined} */ options
                    ) => {
                        if (blockedMetadata) {
                            ++lateMetadataCalls
                        }
                        return lstat(name, options)
                    }
                )
                syncBuiltinESMExports()
                t.after(() => {
                    t.mock.restoreAll()
                    syncBuiltinESMExports()
                })
                if (stage === 'success') {
                    const names = await filePromises.readdir(root, 'buffer')
                    assert.ok(names.every(Buffer.isBuffer))
                    assert.deepEqual(names.map((name) => name.toString('utf8')).sort(), ['local', 'remote'])
                    const entries = await filePromises.readdir(root, { withFileTypes: true, recursive: true })
                    assert.ok(entries.some((entry) => entry.name === 'data.txt' && entry.isFile()))
                    const stats = await filePromises.lstat(
                        path.join(direction === 'upload' ? local : remote, 'data.txt'),
                        { bigint: true }
                    )
                    assert.equal(stats.size, 4n)
                }
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
                    fs.readFileSync(path.join(direction === 'upload' ? remote : local, 'data.txt')).toString('utf8'),
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
    const readdir = filePromises.readdir
    sftpSession(t, () => ({
        ...sftpFixture(),
        createReadStream() {
            ++reads
            throw new Error('transfer started after baseline timeout')
        },
    }))
    t.mock.method(
        filePromises,
        'readdir',
        /** @type {typeof filePromises.readdir} */ (
            (name, options) => {
                if (String(name) === local) {
                    globalThis.queueMicrotask(() => t.mock.timers.tick(251))
                    return new Promise((resolve) => {
                        release = resolve
                    })
                }
                return Reflect.apply(readdir, filePromises, [name, options])
            }
        )
    )
    const names = await filePromises.readdir(root, 'buffer')
    assert.ok(names.every(Buffer.isBuffer))
    assert.deepEqual(names.map((name) => name.toString('utf8')).sort(), ['local', 'remote'])
    const entries = await filePromises.readdir(root, { withFileTypes: true, recursive: true })
    assert.ok(entries.some((entry) => entry.name === 'data.txt' && entry.isFile()))
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
            patch(t, crypto, 'createHash', (algorithm, options) => {
                hashes.push(algorithm)
                return createHash(algorithm, options)
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
            assert.equal(fs.readFileSync(target).toString('utf8'), 'DATA')
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
    assert.equal(fs.readFileSync(target).toString('utf8'), 'DATA')
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
    assert.equal(fs.readFileSync(target).toString('utf8'), 'DATA')
    assert.equal(result.filesTransferred, 1)
    assert.equal(result.bytesTransferred, 4)
    assert.equal(result.verification.status, 'unknown')
})

test('SSH-16: public sync probe consumes the request deadline before acquiring SFTP', async (t) => {
    const source = path.join(temporary(t), 'source')
    fs.writeFileSync(source, 'DATA')
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
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
    const pending = handlers(registerFileTools).get('ssh_sync')({
        alias: 'fixture',
        direction: 'upload',
        localPath: source,
        remotePath: '/target',
        operationTimeout: 5,
    })
    await new Promise((resolve) => setImmediate(resolve))
    t.mock.timers.tick(5)
    const result = content(await pending)
    assert.equal(result.success, false)
    assert.match(result.error, /timeout/)
    t.mock.timers.tick(40)
    await new Promise((resolve) => setImmediate(resolve))
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
                    '\r1,024 50% 1.00kB/s 0:00:01\r2,048 100% 1.00kB/s 0:00:00\r' +
                    '>f+++++++++ owned\nNumber of regular files transferred: 1\n'
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
    assert.equal(fs.readFileSync(path.join(root, 'blocked')).toString('utf8'), 'preserved')
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

test('SSH-R8-03: public SFTP single-file verification hashes each endpoint once', async (t) => {
    for (const direction of ['upload', 'download']) {
        const root = temporary(t)
        const source = path.join(root, 'source')
        const target = path.join(root, 'target')
        fs.writeFileSync(source, 'bounded content')
        sftpSession(t, sftpFixture())
        const hashes = []
        const createHash = crypto.createHash
        const original = crypto.createHash
        crypto.createHash = (algorithm, options) => {
            hashes.push(algorithm)
            return createHash(algorithm, options)
        }
        syncBuiltinESMExports()
        try {
            const result = content(
                await handlers(registerFileTools).get('ssh_sync')({
                    alias: 'fixture',
                    direction,
                    localPath: direction === 'upload' ? source : target,
                    remotePath: direction === 'upload' ? target : source,
                    verify: { sha256: true, maxFileBytes: 1024, maxTotalBytes: 1024 },
                })
            )
            assert.equal(result.success, true, JSON.stringify(result))
            assert.deepEqual(hashes, ['sha256', 'sha256'])
            assert.equal(result.verification.checks.sha256, true)
            assert.equal(result.transportVerification.hashMatch, true)
            assert.equal(result.transportVerification.local.sha256, result.verification.local.sha256)
            assert.equal(result.transportVerification.remote.sha256, result.verification.remote.sha256)
        } finally {
            crypto.createHash = original
            syncBuiltinESMExports()
        }
    }
})

test('F425: count-only directory verification leaves unrequested checks null', async (t) => {
    const root = temporary(t)
    const source = path.join(root, 'source')
    const target = path.join(root, 'target')
    fs.mkdirSync(source)
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(source, 'data'), 'content')
    sftpSession(t, () => sftpFixture())
    const result = content(
        await handlers(registerFileTools).get('ssh_sync')({
            alias: 'fixture',
            localPath: source,
            remotePath: target,
            direction: 'upload',
            verify: { count: true },
        })
    )
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(result.verification.checks.count, true)
    for (const name of ['sha256', 'owner', 'mode', 'deletions', 'staleFiles']) {
        assert.equal(result.verification.checks[name], null, name)
    }
    assert.deepEqual(result.failedChecks, [])
})

test('F336/F405/F398: public schemas and mkdir report actual SFTP identity and metadata', async (t) => {
    const root = temporary(t)
    sftpSession(t, sftpFixture())
    patch(t, sessionManager, 'listSessionDetails', () => [{ alias: 'fixture', username: 'login', runAs: 'app' }])
    const entries = new Map()
    for (const register of [registerFileTools, registerExecTools]) {
        register({
            registerTool(name, definition, handler) {
                entries.set(name, { definition, handler })
            },
        })
    }
    const result = content(
        await entries.get('ssh_mkdir').handler({ alias: 'fixture', remotePath: path.join(root, 'new') })
    )
    const actual = fs.statSync(path.join(root, 'new'))
    assert.equal(result.success, true)
    assert.equal(result.loginUser, 'login')
    assert.equal(result.runAs, 'app')
    assert.equal(result.creationIdentity, 'sftp_login')
    assert.equal(result.owner, actual.uid)
    assert.equal(result.group, actual.gid)
    assert.equal(result.mode, actual.mode & 0o7777)
    const scriptSchema = entries.get('ssh_exec_script').definition.inputSchema
    assert.equal(scriptSchema.safeParse({ alias: 'fixture', script: '', timeout: 3600000 }).success, true)
    assert.equal(scriptSchema.safeParse({ alias: 'fixture', script: '', timeout: 3600001 }).success, false)
    const syncSchema = entries.get('ssh_sync').definition.inputSchema
    const args = { alias: 'fixture', localPath: root, remotePath: root, direction: 'upload' }
    for (const value of [0, -1, 0.5]) {
        assert.equal(syncSchema.safeParse({ ...args, bandwidthLimitKiBps: value }).success, false)
    }
    assert.equal(syncSchema.safeParse({ ...args, bandwidthLimitKiBps: 8 }).success, true)
})

test('MKDIR-METADATA: SDK results preserve acknowledged creation across later SFTP failures', async (t) => {
    const { SFTP, STATUS_CODE } = sftpProtocol
    for (const condition of [
        'normal',
        'acquire-timeout',
        'acquire-denied',
        'stat-timeout',
        'stat-denied',
        'mkdir-denied',
        'mkdir-timeout',
    ]) {
        await t.test(condition, async (t) => {
            const remotePath = path.join(temporary(t), 'created')
            const trace = []
            const wrappers = []
            let acquisitions = 0
            let mkdirRequests = 0
            let statRequests = 0
            let releaseLate
            t.after(() => {
                releaseLate?.()
                for (const wrapper of wrappers) {
                    wrapper.end()
                }
            })
            async function acquireSftp() {
                const pair = {}
                const id = wrappers.length
                for (const side of ['client', 'server']) {
                    const peer = side === 'client' ? 'server' : 'client'
                    pair[side] = new SFTP(
                        {
                            _protocol: {
                                channelData(_channel, bytes) {
                                    const packet = Buffer.from(bytes)
                                    trace.push({
                                        event: 'packet',
                                        wrapper: id,
                                        side,
                                        type: packet[4],
                                        ...(packet[4] === 101 ? { status: packet.readUInt32BE(9) } : {}),
                                        hex: packet.toString('hex'),
                                    })
                                    process.nextTick(() => pair[peer].push(packet))
                                },
                                channelClose() {
                                    trace.push({ event: 'close', wrapper: id, side })
                                    process.nextTick(() => {
                                        for (const endpoint of Object.values(pair)) {
                                            endpoint.outgoing.state = 'closed'
                                            endpoint.push(null)
                                        }
                                    })
                                },
                            },
                        },
                        {
                            type: 'session',
                            incoming: { id: 0, state: 'open' },
                            outgoing: { id: 0, state: 'open', window: 1 << 20, packetSize: 32768 },
                        },
                        { server: side === 'server' }
                    )
                }
                wrappers.push(pair.client)
                pair.server.on('MKDIR', (request, name) => {
                    ++mkdirRequests
                    assert.equal(name, remotePath)
                    if (condition === 'mkdir-denied') {
                        pair.server.status(request, STATUS_CODE.PERMISSION_DENIED, 'Directory creation denied')
                        return
                    }
                    fs.mkdirSync(name, { mode: 0o751 })
                    if (condition !== 'mkdir-timeout') {
                        pair.server.status(request, STATUS_CODE.OK)
                    }
                })
                pair.server.on('STAT', (request, name) => {
                    ++statRequests
                    assert.equal(name, remotePath)
                    if (condition === 'stat-denied') {
                        pair.server.status(request, STATUS_CODE.PERMISSION_DENIED, 'Directory metadata denied')
                    } else if (condition !== 'stat-timeout') {
                        pair.server.attrs(request, fs.statSync(name))
                    }
                })
                await new Promise((resolve, reject) => {
                    pair.client.once('ready', resolve)
                    pair.client.once('error', reject)
                    pair.server.once('error', reject)
                    pair.client._init()
                })
                return pair.client
            }
            sftpSession(t, async () => {
                ++acquisitions
                trace.push({ event: 'acquire', number: acquisitions })
                if (acquisitions === 2 && condition === 'acquire-denied') {
                    throw Object.assign(new Error('Metadata SFTP acquisition denied'), {
                        details: { stage: 'sftp_acquisition' },
                    })
                }
                const sftp = await acquireSftp()
                if (acquisitions === 2 && condition === 'acquire-timeout') {
                    return new Promise((resolve) => {
                        releaseLate = () => resolve(sftp)
                    })
                }
                return sftp
            })
            patch(t, sessionManager, 'listSessionDetails', () => [
                { alias: 'fixture', username: 'login', runAs: 'app' },
            ])
            const server = new McpServer({ name: 'ssh-mkdir-metadata-fixture', version: '1.0.0' })
            registerFileTools(server)
            const client = new Client({ name: 'ssh-mkdir-metadata-client', version: '1.0.0' })
            t.after(async () => {
                await client.close()
                await server.close()
            })
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
            await server.connect(serverTransport)
            await client.connect(clientTransport)
            assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'ssh_mkdir'))
            const input = {
                name: 'ssh_mkdir',
                arguments: { alias: 'fixture', remotePath, recursive: false, timeout: 100 },
            }
            const response = await client.callTool(input)
            releaseLate?.()
            await new Promise((resolve) => setImmediate(resolve))
            const result = content(response)
            t.diagnostic(
                JSON.stringify({ condition, input, response, trace, acquisitions, mkdirRequests, statRequests })
            )
            assert.equal(mkdirRequests, 1)
            assert.ok(wrappers.every((wrapper) => wrapper instanceof SFTP && wrapper.outgoing.state === 'closed'))
            assert.ok(wrappers.every((wrapper) => Object.keys(wrapper._requests).length === 0))
            assert.equal(fs.existsSync(remotePath), condition !== 'mkdir-denied')
            if (condition.startsWith('mkdir-')) {
                assert.equal(response.isError, true)
                assert.equal(result.success, false)
                assert.equal(acquisitions, 1)
                assert.equal(statRequests, 0)
                assert.equal(result.metadataStatus, undefined)
                assert.equal(result.metadataError, undefined)
                if (condition === 'mkdir-timeout') {
                    assert.equal(result.operationStatus, 'unknown')
                    assert.equal(result.retryable, true)
                    assert.ok(result.timeout > 0 && result.timeout <= input.arguments.timeout)
                    assert.match(result.error, /SFTP operation timed out/)
                } else {
                    assert.deepEqual(result, { success: false, error: 'Directory creation denied' })
                }
                return
            }
            assert.equal(acquisitions, 2)
            assert.equal(statRequests, condition.startsWith('acquire-') ? 0 : 1)
            assert.ok(trace.some((event) => event.wrapper === 0 && event.side === 'server' && event.status === 0))
            assert.equal(result.success, true)
            assert.notEqual(response.isError, true)
            const creation = {
                success: true,
                path: remotePath,
                loginUser: 'login',
                runAs: 'app',
                creationIdentity: 'sftp_login',
            }
            if (condition === 'normal') {
                const actual = fs.statSync(remotePath)
                assert.deepEqual(result, {
                    ...creation,
                    owner: actual.uid,
                    group: actual.gid,
                    mode: actual.mode & 0o7777,
                    permissions: formatFilePermissions(actual.mode),
                })
                return
            }
            assert.deepEqual(result, {
                ...creation,
                operationStatus: 'completed',
                retryable: false,
                metadataStatus: 'unavailable',
                metadataError: result.metadataError,
            })
            assert.equal(result.metadataError.success, false)
            if (condition.endsWith('timeout')) {
                assert.equal(result.metadataError.operationStatus, 'unknown')
                assert.equal(result.metadataError.retryable, true)
                assert.ok(result.metadataError.timeout > 0 && result.metadataError.timeout <= input.arguments.timeout)
                assert.match(result.metadataError.error, /SFTP operation timed out/)
            } else if (condition === 'stat-denied') {
                assert.ok(trace.some((event) => event.wrapper === 1 && event.side === 'server' && event.status === 3))
                assert.deepEqual(result.metadataError, { success: false, error: 'Directory metadata denied' })
            } else {
                assert.deepEqual(result.metadataError, {
                    success: false,
                    error: 'Metadata SFTP acquisition denied',
                    details: { stage: 'sftp_acquisition' },
                })
            }
        })
    }
})

test('F398: SFTP rate is shared across recursive concurrent files in both directions', async (t) => {
    for (const direction of ['upload', 'download']) {
        const root = temporary(t)
        const source = path.join(root, 'source')
        const target = path.join(root, 'target')
        fs.mkdirSync(source)
        fs.mkdirSync(path.join(source, 'nested'))
        for (const file of ['one', 'two', 'nested/three']) {
            fs.writeFileSync(path.join(source, file), Buffer.alloc(1024, 1))
        }
        sftpSession(t, () => sftpFixture())
        const start = performance.now()
        const result = content(
            await handlers(registerFileTools).get('ssh_sync')({
                alias: 'fixture',
                direction,
                bandwidthLimitKiBps: 8,
                localPath: direction === 'upload' ? source : target,
                remotePath: direction === 'upload' ? target : source,
            })
        )
        const elapsed = performance.now() - start
        assert.equal(result.success, true, JSON.stringify(result))
        assert.equal(result.filesTransferred, 3)
        assert.ok(elapsed >= 350, `aggregate limit completed too early: ${elapsed} ms`)
        assert.equal(fs.readFileSync(path.join(target, 'nested/three')).length, 1024)
    }
})

test('SSH-R8-01/F398: cancellation waits for owned rsync and preserves partial deletion/progress', async (t) => {
    const root = temporary(t)
    const source = path.join(root, 'source')
    fs.writeFileSync(source, 'owned')
    sftpSession(t, sftpFixture())
    patch(t, sessionManager, 'getExternalTransferCapability', () => ({
        host: 'example.com',
        username: 'fixture',
        port: 22,
        rsyncEligible: true,
        decisionReason: 'fixture',
        commandShell: 'posix',
    }))
    patch(t, sessionManager, 'exec', async () => ({ success: true, exitCode: 0, stdout: '/usr/bin/rsync', stderr: '' }))
    const controller = new AbortController()
    const spawn = childProcess.spawn
    let owned
    patch(t, childProcess, 'spawn', (command, args, options) => {
        if (command === 'rsync') {
            assert.ok(args.includes('--bwlimit=8K'))
            owned = spawn(
                process.execPath,
                [
                    '-e',
                    `process.stdout.write('*deleting stale\\n>f+++++++++ partial\\n1,024 50% 1.00kB/s 0:00:01\\n'); ` +
                        'setInterval(() => {}, 1000)',
                ],
                options
            )
            owned.stdout.once('data', () => setImmediate(() => controller.abort(new Error('owned cancellation'))))
            return owned
        }
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.kill = () => true
        setImmediate(() => child.emit('close', 0))
        return child
    })
    syncBuiltinESMExports()
    t.after(() => {
        syncBuiltinESMExports()
        if (owned?.exitCode === null && owned.signalCode === null) {
            owned.kill('SIGKILL')
        }
    })
    const result = await syncFiles('owned-cancel', source, source, 'upload', {
        delete: true,
        bandwidthLimitKiBps: 8,
        signal: controller.signal,
        operationTimeout: 5000,
    })
    assert.equal(result.success, false, JSON.stringify(result))
    assert.equal(result.cancelled, true)
    assert.equal(result.operationStatus, 'unknown')
    assert.equal(result.stats.deleted, 1)
    assert.equal(result.lastProgress.transferred, 1024)
    assert.ok(owned.exitCode !== null || owned.signalCode !== null)
    assert.throws(() => process.kill(owned.pid, 0), { code: 'ESRCH' })
    assert.equal(process.kill(process.pid, 0), true)
})

test('F310: live and pending conflicts return field names without configuration values', async (t) => {
    const root = temporary(t)
    const manager = new SessionManager(path.join(root, 'sessions.json'))
    const config = {
        alias: 'fields',
        host: 'example.com',
        port: 22,
        username: 'fixture',
        password: 'private-original',
        env: { VALUE: 'private-env' },
    }
    manager.sessions.set('fields', { backend: 'ssh2', config, connected: true, client: { end() {} } })
    manager.isAlive = () => true
    await assert.rejects(
        manager.connect({
            ...config,
            password: 'private-new',
            env: { VALUE: 'private-changed' },
            runAs: 'private-user',
        }),
        (error) => {
            assert.deepEqual(error.details.differingFields.sort(), ['env', 'password', 'runAs'])
            assert.equal(JSON.stringify(error).includes('private-'), false)
            return true
        }
    )
    manager.sessions.clear()
    manager.connectInternal = () => new Promise(() => {})
    const pending = manager.connect(config)
    await assert.rejects(manager.connect({ ...config, runAs: 'private-user' }), (error) => {
        assert.deepEqual(error.details.differingFields, ['runAs'])
        assert.equal(JSON.stringify(error).includes('private-'), false)
        return true
    })
    manager.disconnect('fields')
    await assert.rejects(pending, /cancelled/)
})

test('SSH-R8-C01: OpenSSH preparation cancels on POSIX and rejects unsupported local platforms', async (t) => {
    const handlers = new Map()
    registerConnectionTools({
        registerTool(name, _definition, handler) {
            handlers.set(name, handler)
        },
    })
    let connections = 0
    patch(t, sessionManager, 'connect', async () => {
        ++connections
        throw new Error('late connect')
    })
    const spawn = childProcess.spawn
    let child
    patch(t, childProcess, 'spawn', (command, args, options) => {
        assert.equal(command, 'ssh')
        assert.ok(args.includes('-G'))
        child = spawn(
            process.execPath,
            [
                '-e',
                'setTimeout(() => process.stdout.write(' +
                    '"hostname example.com\\nuser fixture\\nport 22\\n" + ' +
                    '"controlpath /owned/socket\\n"), 150)',
            ],
            options
        )
        return child
    })
    syncBuiltinESMExports()
    t.after(() => syncBuiltinESMExports())
    const pending = handlers.get('ssh_connect')({
        alias: 'preparation',
        backend: 'openssh',
        host: 'example.com',
        user: 'fixture',
        controlPath: '/owned/socket',
    })
    if (process.platform === 'win32') {
        const result = content(await pending)
        assert.equal(result.success, false)
        assert.equal(result.details.code, 'unsupported_backend')
        assert.equal(result.details.backend, 'openssh')
        assert.equal(result.details.capability, 'local_platform')
        assert.equal(result.details.retryable, false)
        assert.equal(child, undefined)
        assert.equal(connections, 0)
        assert.equal(sessionManager.preparingConnections.has('preparation'), false)
        const disconnected = content(await handlers.get('ssh_disconnect')({ alias: 'preparation' }))
        assert.equal(disconnected.success, false)
        return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    const disconnected = content(await handlers.get('ssh_disconnect')({ alias: 'preparation' }))
    const result = content(await pending)
    assert.equal(disconnected.success, true)
    assert.equal(result.success, false)
    assert.equal(connections, 0)
    assert.ok(child.exitCode !== null || child.signalCode !== null)
    assert.equal(sessionManager.preparingConnections.has('preparation'), false)
})

test('F384: input errors suppress raw input; cancellation prevents late input', async (t) => {
    const root = temporary(t)
    const manager = new SessionManager(path.join(root, 'sessions.json'))
    const secret = 'private-stdin-do-not-copy'
    const session = { backend: 'ssh2', config: { host: 'example.com', username: 'fixture', port: 22 }, client: {} }
    patch(t, manager, 'getSession', () => session)
    patch(t, manager, 'isCurrentSession', () => true)
    let writes = 0
    let deliver
    patch(t, manager, 'openCommandChannel', (_session, command, _options, callback) => {
        assert.equal(command.includes(secret), false)
        deliver = () => {
            const stream = new PassThrough()
            stream.stderr = new PassThrough()
            stream.close = () => stream.destroy()
            stream.stdin = {
                on() {},
                end() {
                    ++writes
                    throw new Error(secret)
                },
            }
            callback(undefined, stream)
        }
    })
    const first = manager.exec('fixture', 'wc -c', { stdin: secret })
    deliver()
    await assert.rejects(first, (error) => {
        assert.equal(error.message.includes(secret), false)
        assert.equal(JSON.stringify(error).includes(secret), false)
        assert.equal(error.details.operationStatus, 'unknown')
        return true
    })
    const controller = new AbortController()
    const second = manager.exec('fixture', 'wc -c', { stdin: secret, signal: controller.signal })
    controller.abort()
    deliver()
    await assert.rejects(second, (error) => error.details.operationStatus === 'unknown')
    assert.equal(writes, 1)
})

test('SSH-R8-C01: generation protects the preparation-to-connect handoff', async (t) => {
    const root = temporary(t)
    const manager = new SessionManager(path.join(root, 'sessions.json'))
    const config = { alias: 'handoff', host: 'example.com', username: 'fixture', port: 22 }
    const { result, generation } = await manager.prepareConnection('handoff', async () => config)
    manager.disconnect('handoff')
    await assert.rejects(manager.connect(result, generation), /cancelled after configuration preparation/)
    assert.equal(manager.pendingConnections.size, 0)
})

test('M16-S01: preparation uses cancellation order across resolved aliases', async (t) => {
    const manager = new SessionManager(path.join(temporary(t), 'sessions.json'))
    let connects = 0
    patch(t, manager, 'connectInternal', async (_config, alias) => {
        ++connects
        return alias
    })
    const config = { alias: 'resolved:2222', host: 'example.com', port: 2222, username: 'fixture' }
    for (let i = 0; i < 2; ++i) {
        const prepared = await manager.prepareConnection('requested:22', async () => config)
        assert.equal(await manager.connect(prepared.result, prepared.generation), config.alias)
        manager.disconnect(config.alias)
    }
    const prepared = await manager.prepareConnection(undefined, async () => config)
    manager.disconnect(config.alias)
    await assert.rejects(manager.connect(config, prepared.generation), /cancelled after configuration preparation/)
    const unrelated = await manager.prepareConnection('requested:22', async () => config)
    manager.disconnect('unrelated')
    assert.equal(await manager.connect(config, unrelated.generation), config.alias)
    assert.equal(connects, 3)
})

test('M16-S02: public SDK cancellation stops batch and parallel dispatch', async (t) => {
    for (const tool of ['ssh_exec_batch', 'ssh_exec_parallel']) {
        await t.test(tool, async (t) => {
            const server = new McpServer({ name: 'ssh-cancel-fixture', version: '1.0.0' })
            registerExecTools(server)
            const client = new Client({ name: 'ssh-cancel-client', version: '1.0.0' })
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
            await server.connect(serverTransport)
            await client.connect(clientTransport)
            t.after(async () => {
                await client.close()
                await server.close()
            })
            let dispatched = 0
            let started
            let stopped
            const begin = new Promise((resolve) => {
                started = resolve
            })
            const end = new Promise((resolve) => {
                stopped = resolve
            })
            patch(t, sessionManager, 'exec', async (_alias, _command, options) => {
                ++dispatched
                assert.ok(options.signal instanceof globalThis.AbortSignal)
                started()
                await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
                stopped()
                throw new Error('cancelled by SDK')
            })
            const controller = new AbortController()
            const pending = client.callTool(
                {
                    name: tool,
                    arguments:
                        tool === 'ssh_exec_batch'
                            ? { alias: 'fixture', commands: ['one', 'two'], stopOnError: false }
                            : { aliases: ['one', 'two', 'three'], command: 'work', maxConcurrency: 1 },
                },
                undefined,
                { signal: controller.signal }
            )
            const rejected = assert.rejects(pending, /cancel/i)
            await begin
            controller.abort(new Error('fixture cancellation'))
            await rejected
            await end
            await new Promise((resolve) => setImmediate(resolve))
            assert.equal(dispatched, 1)
        })
    }
})

test('M16-S02: script upload cancellation stops chmod and execution; owned cleanup survives', async (t) => {
    const root = temporary(t)
    const controller = new AbortController()
    let releaseSftp
    let sftpRequests = 0
    let writes = 0
    let cleanup = 0
    const commands = []
    patch(t, sessionManager, 'getOpenSshConnection', () => undefined)
    patch(t, sessionManager, 'getRemotePlatform', () => 'posix')
    patch(t, sessionManager, 'listSessionDetails', () => [])
    patch(t, sessionManager, 'exec', async (_alias, command) => {
        commands.push(command)
        return { success: true, stdout: path.join(root, 'script') + '\n', stderr: '', exitCode: 0 }
    })
    patch(t, sessionManager, 'getSftp', async () => {
        if (++sftpRequests === 1) {
            return new Promise((resolve) => {
                releaseSftp = resolve
            })
        }
        return {
            unlink(_path, callback) {
                ++cleanup
                callback(null)
            },
            end() {},
        }
    })
    const pending = handlers(registerExecTools).get('ssh_exec_script')(
        { alias: 'fixture', script: 'printf never', timeout: 250, keepScript: true },
        { signal: controller.signal }
    )
    while (!releaseSftp) {
        await new Promise((resolve) => setImmediate(resolve))
    }
    controller.abort(new Error('upload cancelled'))
    const result = content(await pending)
    releaseSftp({
        createWriteStream() {
            ++writes
            throw new Error('late write')
        },
        end() {},
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(result.success, false)
    assert.equal(commands.length, 1)
    assert.equal(writes, 0)
    assert.equal(cleanup, 1)
})

test('M16-S02: write and Windows private creation reject late SFTP before OPEN', async (t) => {
    for (const create of [writeFile, createEmptyRemoteFile]) {
        const controller = new AbortController()
        let release
        let opened = 0
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
        const pending =
            create === writeFile
                ? create('fixture', '/owned', 'data', false, 250, controller.signal)
                : create('fixture', '/owned', 250, controller.signal)
        const rejected = assert.rejects(pending, /cancelled/)
        controller.abort(new Error('write cancelled'))
        await rejected
        release({
            createWriteStream() {
                ++opened
            },
            end() {
                ++ended
            },
        })
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(opened, 0)
        assert.equal(ended, 1)
    }
})

test('M16-S02: password sudo cancellation closes late channel without stdin', async (t) => {
    const manager = new SessionManager(path.join(temporary(t), 'sessions.json'))
    let deliver
    let writes = 0
    let closed = 0
    const session = {
        backend: 'ssh2',
        config: { host: 'example.com', username: 'fixture', port: 22 },
        client: {
            exec(_command, _options, callback) {
                deliver = callback
            },
        },
    }
    patch(t, manager, 'getSession', () => session)
    patch(t, manager, 'isCurrentSession', () => true)
    const controller = new AbortController()
    const pending = manager.execSudo('fixture', 'true', 'private-sudo', { signal: controller.signal })
    const rejected = assert.rejects(pending, /cancelled/)
    controller.abort()
    await rejected
    const channel = new PassThrough()
    channel.stderr = new PassThrough()
    channel.close = () => {
        ++closed
    }
    channel.write = () => {
        ++writes
        return true
    }
    deliver(undefined, channel)
    assert.equal(writes, 0)
    assert.equal(closed, 1)
})

test('M16-S04: download error diagnostics share the original deadline and cancellation', async (t) => {
    for (const stage of ['timeout', 'early', 'cancel']) {
        await t.test(stage, async (t) => {
            const root = temporary(t)
            const target = path.join(root, 'target')
            fs.writeFileSync(target, 'original')
            const controller = new AbortController()
            let sftpRequests = 0
            let probes = 0
            patch(t, sessionManager, 'getRemotePathStyle', () => 'posix')
            patch(t, sessionManager, 'getOpenSshConnection', () => undefined)
            patch(t, sessionManager, 'getSftp', async () => {
                ++sftpRequests
                if (sftpRequests === 1) {
                    if (stage === 'timeout') {
                        return new Promise(() => {})
                    }
                    throw new Error('original download failure')
                }
                return {
                    stat(_name, _callback) {
                        ++probes
                    },
                    end() {},
                }
            })
            const started = Date.now()
            const pending = handlers(registerFileTools).get('ssh_download')(
                { alias: 'fixture', remotePath: '/file', localPath: target, timeout: 250 },
                { signal: controller.signal }
            )
            let timer
            if (stage === 'cancel') {
                timer = setTimeout(() => controller.abort(), 30)
            }
            const result = content(await pending)
            clearTimeout(timer)
            assert.equal(result.success, false)
            assert.equal(result.targetReplaced, false)
            assert.equal(fs.readFileSync(target).toString('utf8'), 'original')
            assert.ok(Date.now() - started < 650)
            assert.equal(probes, stage === 'timeout' ? 0 : 1)
            assert.equal(sftpRequests, stage === 'timeout' ? 1 : 2)
            if (stage !== 'timeout') {
                assert.match(result.error, /original download failure/)
            }
        })
    }
})

test('M16-S02: privilege handlers and quick connection keep the SDK signal', async (t) => {
    const signal = new AbortController().signal
    const seen = []
    patch(t, sessionManager, 'requirePosixPrivilege', () => undefined)
    patch(t, sessionManager, 'exec', async (_alias, _command, options) => {
        seen.push(options.signal)
        return { success: true, stdout: '', stderr: '', exitCode: 0 }
    })
    patch(t, sessionManager, 'execAsUser', async (_alias, _command, _user, options) => {
        seen.push(options.signal)
        return { success: true, stdout: '', stderr: '', exitCode: 0 }
    })
    patch(t, sessionManager, 'execSudo', async (_alias, _command, _password, options) => {
        seen.push(options.signal)
        return { success: true, stdout: '', stderr: '', exitCode: 0 }
    })
    const entries = handlers(registerExecTools)
    for (const [name, arguments_] of [
        ['ssh_exec_as_user', { alias: 'fixture', command: 'true' }],
        ['ssh_exec_as_user', { alias: 'fixture', command: 'true', targetUser: 'fixture' }],
        ['ssh_exec_sudo', { alias: 'fixture', command: 'true', sudoPassword: 'synthetic' }],
    ]) {
        assert.equal(content(await entries.get(name)(arguments_, { signal })).success, true)
    }
    assert.deepEqual(seen, [signal, signal, signal])
    let connected
    let disconnected
    let started
    const begin = new Promise((resolve) => {
        started = resolve
    })
    patch(t, sessionManager, 'connect', (config, _generation, requestSignal) => {
        connected = config.alias
        started()
        return new Promise((_resolve, reject) =>
            requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true })
        )
    })
    patch(t, sessionManager, 'disconnect', (alias) => {
        disconnected = alias
        return true
    })
    const controller = new AbortController()
    const pending = entries.get('ssh_quick_exec')(
        { host: 'example.com', user: 'fixture', command: 'never' },
        { signal: controller.signal }
    )
    await begin
    controller.abort(new Error('quick cancelled'))
    assert.equal(content(await pending).success, false)
    assert.equal(disconnected, connected)
    assert.equal(seen.length, 3)
})

test('M16-S02: a late OPEN reply never dispatches WRITE after cancellation', () => {
    const controller = new AbortController()
    let reply
    let writes = 0
    let ended = 0
    const sftp = {
        open(_name, _flags, callback) {
            reply = callback
        },
        write(_handle, _bytes, callback) {
            ++writes
            callback(null)
        },
        end() {
            ++ended
        },
    }
    const state = new SftpWriteState('/owned-script')
    const tracked = state.track(sftp, controller.signal)
    let openError
    let writeError
    tracked.open('/owned-script', 'w', (error) => {
        openError = error
    })
    controller.abort(new Error('late OPEN cancelled'))
    reply(null, Buffer.from('owned-handle'))
    tracked.write(Buffer.from('owned-handle'), Buffer.from('never'), (error) => {
        writeError = error
    })
    assert.equal(state.remoteCreated, true)
    assert.equal(ended, 1)
    assert.match(openError.message, /cancelled/)
    assert.match(writeError.message, /cancelled/)
    assert.equal(writes, 0)
})

test('M16-S02: Windows ACL cancellation removes only the created private file', async (t) => {
    const controller = new AbortController()
    const removed = []
    let started
    const begin = new Promise((resolve) => {
        started = resolve
    })
    patch(t, sessionManager, 'getSftp', async () => ({
        createWriteStream() {
            return new Writable({
                write(_chunk, _encoding, callback) {
                    callback()
                },
            })
        },
        unlink(name, callback) {
            removed.push(name)
            callback(null)
        },
        end() {},
    }))
    patch(t, sessionManager, 'exec', (_alias, _command, options) => {
        assert.equal(options.signal, controller.signal)
        started()
        return new Promise((_resolve, reject) =>
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
        )
    })
    const pending = prepareWindowsRemotePrivateFile(
        'fixture',
        '/owned-private',
        500,
        'C:\\owned-private',
        controller.signal
    )
    const rejected = assert.rejects(pending, /ACL cancelled/)
    await begin
    controller.abort(new Error('ACL cancelled'))
    await rejected
    assert.deepEqual(removed, ['/owned-private'])
})
