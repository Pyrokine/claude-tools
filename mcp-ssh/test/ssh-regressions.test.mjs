import assert from 'node:assert/strict'
import { exec as execCallback } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import test from 'node:test'
import { promisify } from 'node:util'
import { classifyCommandRisk } from '../dist/command-risk.js'
import {
    buildRemoteDirectoryManifestCommand,
    compareDirectoryManifests,
    createLocalDirectoryManifest,
    matchesDirectoryExclude,
    parseRemoteDirectoryManifest,
} from '../dist/directory-verification.js'
import {
    buildLineRangeAwkProgram,
    checkRsync,
    clearRsyncCache,
    syncFiles,
    uploadFile,
} from '../dist/file-ops.js'
import { sessionManager, SessionManager } from '../dist/session-manager.js'
import { buildTransferOutcome } from '../dist/transfer-outcome.js'

const exec = promisify(execCallback)

function makeTempDir(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ssh-test-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    return directory
}

test('lineRange awk program keeps statements separated', () => {
    const program = buildLineRangeAwkProgram(2, 4)
    assert.match(program, /^BEGIN \{.*\}$/m)
    assert.match(program, /^NR >= 2 && NR <= 4 \{$/m)
    assert.match(program, /^    actual_end = NR$/m)
    assert.match(program, /^END \{$/m)
})

test('command risk keeps bounded read-only pipelines below high and flags destructive commands', () => {
    const readOnly = classifyCommandRisk('grep -R "Build ID" /opt/app | sort | uniq | head -20', 30_000)
    assert.equal(readOnly?.level, 'medium')
    assert.equal(classifyCommandRisk('printf x | sed s/x/y/ | sort | uniq | head -1', 30_000)?.level, 'medium')
    assert.equal(classifyCommandRisk('printf x 2>&1'), undefined)
    assert.equal(classifyCommandRisk('printf x &>/tmp/example.log'), undefined)
    assert.equal(classifyCommandRisk('printf "x\\&y"'), undefined)
    assert.equal(classifyCommandRisk('curl "https://example.com/?a=1&b=2"'), undefined)
    assert.equal(classifyCommandRisk('sleep 1&echo done')?.level, 'high')
    assert.equal(classifyCommandRisk('kill -0 1234'), undefined)
    assert.equal(classifyCommandRisk('rm -rf /tmp/example')?.level, 'high')
    assert.equal(classifyCommandRisk('rm -fr /tmp/example')?.level, 'high')
    assert.equal(classifyCommandRisk('systemctl restart example')?.level, 'high')
})

test('transfer outcome makes mismatched and skipped verification fail top-level success', () => {
    const mismatch = buildTransferOutcome(true, true, { checks: { mode: false } })
    assert.equal(mismatch.transferSuccess, true)
    assert.equal(mismatch.success, false)
    assert.equal(mismatch.verificationStatus, 'mismatched')
    assert.deepEqual(mismatch.failedChecks, ['mode'])

    const skipped = buildTransferOutcome(true, true, { skipped: true, reason: 'limit reached' })
    assert.equal(skipped.success, false)
    assert.equal(skipped.verificationStatus, 'skipped')

    const errored = buildTransferOutcome(true, true, undefined, new Error('probe failed'))
    assert.equal(errored.transferSuccess, true)
    assert.equal(errored.success, false)
    assert.equal(errored.verificationStatus, 'error')

    const transferFailed = buildTransferOutcome(false, true)
    assert.equal(transferFailed.verificationStatus, 'skipped')
    assert.equal(transferFailed.verificationSuccess, false)
})

test('SFTP upload masks create mode to permission bits', async (t) => {
    const directory = makeTempDir(t)
    const localPath = path.join(directory, 'source.txt')
    fs.writeFileSync(localPath, 'payload')
    fs.chmodSync(localPath, 0o6754)
    let requestedMode
    const sftp = {
        createWriteStream(_remotePath, options) {
            requestedMode = options.mode
            return new Writable({
                write(_chunk, _encoding, callback) {
                    callback()
                },
            })
        },
        end() {},
    }

    const result = await uploadFile('unused', localPath, '/tmp/target.txt', undefined, sftp, 0o7777)
    assert.equal(requestedMode, 0o777)
    assert.equal(result.createMode, '0777')
})

test('directory manifests stream hashes, apply excludes, and compare local with remote output', async (t) => {
    if (process.platform === 'win32') {
        t.skip('remote manifest command targets POSIX SSH hosts')
        return
    }
    const directory = makeTempDir(t)
    fs.mkdirSync(path.join(directory, 'sub'))
    fs.writeFileSync(path.join(directory, 'sub', 'file name.txt'), 'content')
    fs.writeFileSync(path.join(directory, 'ignored.tmp'), 'ignored')
    const request = { count: true, sha256: true, owner: true, mode: true }
    const exclude = ['*.tmp']

    const local = await createLocalDirectoryManifest(directory, request, exclude)
    const command = buildRemoteDirectoryManifestCommand(directory, request, exclude)
    const { stdout } = await exec(command, { maxBuffer: 1024 * 1024 })
    const remote = parseRemoteDirectoryManifest(stdout)
    const comparison = compareDirectoryManifests(local, remote, request)

    assert.equal(local.entries.some((entry) => entry.path === 'ignored.tmp'), false)
    assert.equal(comparison.matched, true)
    assert.equal(comparison.summary.missing, 0)
})

test('directory verification uses relative excludes and deletion baselines independently from stale checks', async (t) => {
    const root = makeTempDir(t)
    const source = path.join(root, 'source')
    const baseline = path.join(root, 'baseline')
    const actual = path.join(root, 'actual')
    for (const directory of [source, baseline, actual]) {
        fs.mkdirSync(path.join(directory, 'sub', 'cache'), { recursive: true })
        fs.writeFileSync(path.join(directory, 'keep.txt'), 'keep')
        fs.writeFileSync(path.join(directory, 'sub', 'cache', 'ignored.txt'), 'ignored')
    }
    fs.writeFileSync(path.join(baseline, 'stale.txt'), 'stale')

    const request = { deletions: true }
    const exclude = ['sub/cache/**']
    const expectedManifest = await createLocalDirectoryManifest(source, request, exclude)
    const baselineManifest = await createLocalDirectoryManifest(baseline, request, exclude)
    const actualManifest = await createLocalDirectoryManifest(actual, request, exclude)
    const comparison = compareDirectoryManifests(expectedManifest, actualManifest, request, baselineManifest)

    assert.equal(matchesDirectoryExclude('sub/cache/ignored.txt', exclude), true)
    assert.equal(matchesDirectoryExclude('other/cache/ignored.txt', exclude), false)
    assert.equal(comparison.matched, true)
    assert.equal(comparison.checks.deletions, true)
    assert.equal(comparison.checks.staleFiles, true)
    assert.equal(comparison.summary.deletionCandidates, 1)
    assert.equal(comparison.summary.deletedEntries, 1)

    fs.writeFileSync(path.join(actual, 'stale.txt'), 'stale')
    const actualWithStale = await createLocalDirectoryManifest(actual, request, exclude)
    const failed = compareDirectoryManifests(expectedManifest, actualWithStale, request, baselineManifest)
    assert.equal(failed.matched, false)
    assert.equal(failed.checks.deletions, false)
    assert.equal(failed.checks.staleFiles, true)
    assert.equal(failed.summary.remainingDeletionCandidates, 1)
})

test('directory manifests report unsupported entries and follow a symlinked root', async (t) => {
    if (process.platform === 'win32') {
        t.skip('remote manifest command targets POSIX SSH hosts')
        return
    }
    const root = makeTempDir(t)
    const target = path.join(root, 'target')
    const linkedRoot = path.join(root, 'linked-root')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'file.txt'), 'content')
    await exec(`mkfifo ${JSON.stringify(path.join(target, 'pipe'))}`)
    fs.symlinkSync(target, linkedRoot)

    const request = { count: true }
    const local = await createLocalDirectoryManifest(linkedRoot, request)
    const command = buildRemoteDirectoryManifestCommand(linkedRoot, request)
    const { stdout } = await exec(command, { maxBuffer: 1024 * 1024 })
    const remote = parseRemoteDirectoryManifest(stdout)
    const comparison = compareDirectoryManifests(local, remote, request)

    assert.equal(local.entries.some((entry) => entry.path === '.'), true)
    assert.equal(remote.entries.some((entry) => entry.path === '.'), true)
    assert.equal(local.skippedSymlinks, 0)
    assert.equal(remote.skippedSymlinks, 0)
    assert.equal(local.skippedUnsupported, 1)
    assert.equal(remote.skippedUnsupported, 1)
    assert.deepEqual(local.unsupportedSamples, ['pipe'])
    assert.deepEqual(remote.unsupportedSamples, ['pipe'])
    assert.equal(comparison.skipped, true)
    assert.match(comparison.reason, /unsupported filesystem entries/)
})

test('directory verification reports resource and symlink limits instead of partial success', async (t) => {
    const directory = makeTempDir(t)
    fs.writeFileSync(path.join(directory, 'large.txt'), '12')
    const limited = await createLocalDirectoryManifest(directory, { sha256: true, maxFileBytes: 1 })
    assert.equal(limited.limited, true)
    assert.equal(limited.limitReason, 'file_bytes')

    if (process.platform !== 'win32') {
        fs.symlinkSync('large.txt', path.join(directory, 'link.txt'))
        const withSymlink = await createLocalDirectoryManifest(directory, { count: true })
        const comparison = compareDirectoryManifests(withSymlink, withSymlink, { count: true })
        assert.equal(withSymlink.skippedSymlinks, 1)
        assert.equal(comparison.skipped, true)
    }
})

test('rsync directory sync uses source contents and skips links and special entries by default', async (t) => {
    if (process.platform === 'win32') {
        t.skip('rsync transport test uses POSIX executable scripts')
        return
    }
    const root = makeTempDir(t)
    const bin = path.join(root, 'bin')
    const source = path.join(root, 'source')
    const argsFile = path.join(root, 'rsync-args.txt')
    fs.mkdirSync(bin)
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'file.txt'), 'content')
    fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nexit 0\n')
    fs.writeFileSync(
        path.join(bin, 'rsync'),
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$MCP_TEST_RSYNC_ARGS"\nprintf "Number of regular files transferred: 1\\n"\n'
    )
    fs.chmodSync(path.join(bin, 'ssh'), 0o755)
    fs.chmodSync(path.join(bin, 'rsync'), 0o755)

    const previousPath = process.env.PATH
    const previousArgsFile = process.env.MCP_TEST_RSYNC_ARGS
    const originalCapability = sessionManager.getExternalTransferCapability
    const originalExec = sessionManager.exec
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`
    process.env.MCP_TEST_RSYNC_ARGS = argsFile
    sessionManager.getExternalTransferCapability = () => ({
        alias: 'rsync-test',
        identity: 'tester@example.com:22',
        host: 'example.com',
        port: 22,
        username: 'tester',
        authMethod: 'agent',
        hasJumpHost: false,
        routeSafeForOpenSsh: true,
        rsyncEligible: true,
        decisionReason: 'direct_ssh_agent_socket',
    })
    sessionManager.exec = async () => ({
        success: true,
        stdout: path.join(bin, 'rsync'),
        stderr: '',
        exitCode: 0,
    })
    t.after(() => {
        sessionManager.getExternalTransferCapability = originalCapability
        sessionManager.exec = originalExec
        clearRsyncCache('rsync-test')
        if (previousPath === undefined) {
            delete process.env.PATH
        } else {
            process.env.PATH = previousPath
        }
        if (previousArgsFile === undefined) {
            delete process.env.MCP_TEST_RSYNC_ARGS
        } else {
            process.env.MCP_TEST_RSYNC_ARGS = previousArgsFile
        }
    })

    await assert.rejects(
        syncFiles('rsync-test', source, '/remote/target', 'upload', { recursive: false }),
        /recursive=false is not supported for directory sources/
    )
    const result = await syncFiles('rsync-test', source, '/remote/target', 'upload')
    const rsyncArgs = fs.readFileSync(argsFile, 'utf8').split('\n').filter(Boolean)

    assert.equal(result.success, true)
    assert.equal(result.selectedTransport, 'rsync')
    assert.equal(rsyncArgs.includes('--no-links'), true)
    assert.equal(rsyncArgs.includes('--no-devices'), true)
    assert.equal(rsyncArgs.includes('--no-specials'), true)
    assert.equal(rsyncArgs.includes(`${source}${path.sep}`), true)
    assert.equal(rsyncArgs.includes(source), false)
})

test('rsync probe does not cache timeout or transport errors as unavailable', async (t) => {
    const alias = `rsync-probe-${process.pid}`
    const originalExec = sessionManager.exec
    let calls = 0
    sessionManager.exec = async () => {
        ++calls
        if (calls === 1) {
            return {
                success: false,
                stdout: '',
                stderr: '',
                exitCode: null,
                failureKind: 'timeout',
                timedOut: true,
            }
        }
        if (calls === 2) {
            return {
                success: false,
                stdout: '',
                stderr: 'connection lost',
                exitCode: null,
                failureKind: 'ssh_transport',
            }
        }
        return {
            success: true,
            stdout: '/usr/bin/rsync\n',
            stderr: '',
            exitCode: 0,
        }
    }
    t.after(() => {
        sessionManager.exec = originalExec
        clearRsyncCache(alias)
    })

    const timeout = await checkRsync(alias, 10)
    const transportError = await checkRsync(alias, 10)
    const available = await checkRsync(alias, 10)
    const cached = await checkRsync(alias, 10)

    assert.equal(timeout.status, 'timeout')
    assert.equal(timeout.retryable, true)
    assert.equal(transportError.status, 'error')
    assert.equal(transportError.failureKind, 'ssh_transport')
    assert.equal(available.status, 'available')
    assert.equal(cached.status, 'available')
    assert.equal(calls, 3)
})

test('session summaries stay brief while internal transfer capability retains route decisions', (t) => {
    const directory = makeTempDir(t)
    const manager = new SessionManager(path.join(directory, 'sessions.json'))
    manager.sessions.set('password-session', {
        client: { end() {} },
        config: {
            host: '192.0.2.10',
            port: 22,
            username: 'tester',
            password: 'not-returned',
            runAs: 'app',
        },
        connected: true,
        connectedAt: 100,
        lastUsedAt: 200,
        reconnectAttempts: 0,
        manualClose: false,
    })

    const brief = manager.listSessions()[0]
    assert.deepEqual(Object.keys(brief).sort(), ['alias', 'connected', 'identity', 'lastUsedAt', 'runAs'])
    assert.equal('host' in brief, false)
    assert.equal('keyPath' in brief, false)

    const detail = manager.listSessionDetails()[0]
    assert.equal(detail.authMethod, 'password')
    assert.equal('keyPath' in detail, false)

    const capability = manager.getExternalTransferCapability('password-session')
    assert.equal(capability.rsyncEligible, false)
    assert.equal(capability.decisionReason, 'password_not_forwarded_to_openssh')
    assert.equal(capability.keyPath, undefined)

    const keyPath = path.join(directory, 'id_test')
    fs.writeFileSync(keyPath, 'not-read-by-capability-check')
    fs.chmodSync(keyPath, 0o644)
    manager.sessions.set('key-session', {
        client: { end() {} },
        config: {
            host: '192.0.2.11',
            port: 22,
            username: 'tester',
            privateKeyPath: keyPath,
        },
        connected: true,
        connectedAt: 100,
        lastUsedAt: 200,
        reconnectAttempts: 0,
        manualClose: false,
    })
    const unsafeKey = manager.getExternalTransferCapability('key-session')
    assert.equal(unsafeKey.rsyncEligible, false)
    assert.equal(unsafeKey.decisionReason, 'key_path_not_openssh_compatible')
    assert.equal(unsafeKey.keyPath, undefined)

    fs.chmodSync(keyPath, 0o600)
    const safeKey = manager.getExternalTransferCapability('key-session')
    assert.equal(safeKey.rsyncEligible, true)
    assert.equal(safeKey.decisionReason, 'direct_openssh_compatible_key_path')
    assert.equal(safeKey.keyPath, keyPath)

    const previousAgentSocket = process.env.SSH_AUTH_SOCK
    delete process.env.SSH_AUTH_SOCK
    t.after(() => {
        if (previousAgentSocket === undefined) {
            delete process.env.SSH_AUTH_SOCK
        } else {
            process.env.SSH_AUTH_SOCK = previousAgentSocket
        }
    })
    manager.sessions.set('agent-session', {
        client: { end() {} },
        config: {
            host: '192.0.2.12',
            port: 22,
            username: 'tester',
        },
        connected: true,
        connectedAt: 100,
        lastUsedAt: 200,
        reconnectAttempts: 0,
        manualClose: false,
    })
    const unavailableAgent = manager.getExternalTransferCapability('agent-session')
    assert.equal(unavailableAgent.rsyncEligible, false)
    assert.equal(unavailableAgent.decisionReason, 'ssh_agent_socket_unavailable')
})
