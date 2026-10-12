import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import { Client } from 'ssh2'

import { classifyCommandRisk } from '../dist/command-risk.js'
import { createRemoteDirectoryManifest } from '../dist/directory-verification.js'
import {
    atomicReplaceCapability,
    checkRsync,
    clearRsyncCache,
    convertRsyncPath,
    listDir,
    mkdir,
    readFile,
    removeRemoteFile,
    syncFiles,
} from '../dist/file-ops.js'
import { PtyManager } from '../dist/pty-manager.js'
import {
    buildRemoteCommand,
    encodedPowershell,
    remoteDirname,
    remoteJoin,
    remotePathModule,
    remoteShellPath,
    sftpPath,
} from '../dist/remote-platform.js'
import { SessionManager, sessionManager } from '../dist/session-manager.js'
import { parseConfigValue, parseSSHConfig } from '../dist/ssh-config.js'
import { registerConnectionTools } from '../dist/tools/connection.js'
import { registerExecTools, windowsScriptContent } from '../dist/tools/exec.js'
import { registerFileTools } from '../dist/tools/file.js'
import { registerPtyTools } from '../dist/tools/pty.js'
import { expandTilde } from '../dist/tools/utils.js'
import { checkWindowsAcl, windowsAclScript, windowsTemporaryPathScript } from '../dist/windows-acl.js'

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-windows-'))
    t.after(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        fs.rmSync(directory, { recursive: true, force: true })
    })
    return directory
}

function tools(register) {
    const handlers = new Map()
    register({
        registerTool(name, schema, handler) {
            handlers.set(name, { schema, handler })
        },
    })
    return handlers
}

function content(response) {
    return JSON.parse(response.content[0].text)
}

function remoteFile(bytes, events = []) {
    return {
        stat(_name, callback) {
            callback(null, { size: bytes.length, mode: 0o100644 })
        },
        createReadStream(_name, options = {}) {
            events.push('sftp.read')
            const selected = bytes.subarray(options.start ?? 0, (options.end ?? bytes.length - 1) + 1)
            return Readable.from([selected.subarray(0, 1), selected.subarray(1)])
        },
        end() {
            events.push('sftp.end')
        },
    }
}

test('S1: public connection passes explicit agent to ssh2, and unsupported Pageant on POSIX fails before connecting', async (t) => {
    const dir = fixture(t)
    const sock = path.join(dir, 'agent.sock')
    fs.writeFileSync(sock, '')
    const original = Client.prototype.connect
    const connects = []
    Client.prototype.connect = function (config) {
        connects.push(config)
        Promise.resolve().then(() => this.emit('ready'))
        return this
    }
    t.after(() => {
        Client.prototype.connect = original
    })
    const manager = new SessionManager(path.join(dir, 'sessions.json'))
    await manager.connect({ host: 'example.com', port: 22, username: 'test', alias: 'agent-fixture', agent: sock })
    assert.equal(connects[0].agent, sock)
    assert.equal(manager.getExternalTransferCapability('agent-fixture').rsyncEligible, false) // regular file is not an OpenSSH socket
    manager.disconnect('agent-fixture')
    if (process.platform !== 'win32') {
        await assert.rejects(
            manager.connect({ host: 'example.com', port: 22, username: 'test', agent: 'pageant' }),
            /Pageant authentication is only available/
        )
        assert.equal(connects.length, 1)
    }
    const connect = tools(registerConnectionTools).get('ssh_connect')
    assert.ok(connect.schema.inputSchema.shape.agent)
    assert.ok(connect.schema.inputSchema.shape.remotePlatform)
    assert.ok(connect.schema.inputSchema.shape.commandShell)
})

test('S2/S3: POSIX, PowerShell, cmd grouping and privilege restrictions come from remote config', async (t) => {
    const ps = buildRemoteCommand('Write-Output $env:VAR', 'powershell', 'C:\\Program Files\\Case', { VAR: "a'b" })
    assert.match(ps, /^powershell.exe -NoProfile -NonInteractive -EncodedCommand /)
    const decoded = Buffer.from(ps.split(' ').at(-1), 'base64').toString('utf16le')
    assert.match(decoded, /Set-Location -LiteralPath 'C:\\Program Files\\Case'/)
    assert.match(decoded, /\$env:VAR = 'a''b'/)
    const cmd = buildRemoteCommand('echo %VAR% & echo done', 'cmd', 'C:\\My Work', { VAR: 'value with spaces' })
    const cmdScript = Buffer.from(cmd.split(' ').at(-1), 'base64').toString('utf16le')
    assert.match(cmdScript, /Set-Location -LiteralPath 'C:\\My Work'/)
    assert.match(cmdScript, /\$env:VAR = 'value with spaces'/)
    assert.match(cmdScript, /& cmd\.exe \/D \/V:OFF \/S \/C 'echo %VAR% & echo done'/)
    const percent = buildRemoteCommand('echo %VAR%', 'cmd', undefined, { VAR: '%PATH%' })
    assert.match(Buffer.from(percent.split(' ').at(-1), 'base64').toString('utf16le'), /\$env:VAR = '%PATH%'/)
    const exclamation = buildRemoteCommand('echo %VAR%', 'cmd', undefined, { VAR: 'a!b' })
    assert.match(Buffer.from(exclamation.split(' ').at(-1), 'base64').toString('utf16le'), /\$env:VAR = 'a!b'/)
    const posix = buildRemoteCommand('false; touch /tmp/unsafe', 'posix', '/absent', { VAR: 'x' })
    assert.match(posix, /cd '\/absent' && export VAR='x' && eval 'false; touch \/tmp\/unsafe'/)
    const dir = fixture(t)
    const manager = new SessionManager(path.join(dir, 'sessions.json'))
    let executed = 0
    manager.sessions.set('windows', {
        client: {
            exec() {
                ++executed
            },
        },
        config: { host: 'example.com', port: 22, username: 'test', remotePlatform: 'windows', commandShell: 'cmd' },
        connected: true,
        connectedAt: 1,
        lastUsedAt: 1,
        reconnectAttempts: 0,
        manualClose: false,
    })
    await assert.rejects(
        manager.exec('windows', 'whoami', { runAs: 'other' }),
        (error) => error.details.code === 'unsupported_remote_platform'
    )
    await assert.rejects(
        manager.execSudo('windows', 'whoami'),
        (error) => error.details.code === 'unsupported_remote_platform'
    )
    await assert.rejects(
        manager.execAsUser('windows', 'whoami', 'other'),
        (error) => error.details.code === 'unsupported_remote_platform'
    )
    assert.equal(executed, 0)
    manager.disconnect('windows')
})

test('S2: cmd applies injected env and cwd before expanding the user command on Windows', (t) => {
    if (process.platform !== 'win32') {
        t.skip('cmd.exe needs a native Windows runner')
        return
    }
    const root = fixture(t)
    const cwd = path.join(root, 'work with spaces')
    fs.mkdirSync(cwd)
    const command = buildRemoteCommand('echo %MCP_VALUE% & cd', 'cmd', cwd, { MCP_VALUE: 'new' })
    const result = spawnSync('cmd.exe', ['/D', '/C', command], {
        env: { ...process.env, MCP_VALUE: 'old' },
        encoding: 'utf8',
        timeout: 5000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /new/)
    assert.ok(result.stdout.toLowerCase().includes(cwd.toLowerCase()))
    assert.doesNotMatch(result.stdout, /old/)
})

test('S5/S10: SFTP-only line range handles CRLF UTF-16LE/GBK and binary data without shell calls', async (t) => {
    const originalSftp = sessionManager.getSftp
    const originalExec = sessionManager.exec
    const events = []
    sessionManager.exec = async () => {
        throw new Error('lineRange must not use shell')
    }
    t.after(() => {
        sessionManager.getSftp = originalSftp
        sessionManager.exec = originalExec
    })
    const utf16 = Buffer.from('\uFEFFone\r\ntwo\r\n中文', 'utf16le')
    sessionManager.getSftp = async () => remoteFile(utf16, events)
    const line = await readFile('fixture', 'C:\\a file.txt', { lineRange: '2-2', encoding: 'auto' })
    assert.equal(line.content, 'two\r\n')
    assert.equal(line.encoding, 'utf16le')
    assert.equal(line.sample_kind, 'line_range')
    const utf16be = Buffer.from('\uFEFFfirst\r\nsecond', 'utf16le').swap16()
    sessionManager.getSftp = async () => remoteFile(utf16be, events)
    const be = await readFile('fixture', 'C:\\utf16be.txt', { lineRange: '2', encoding: 'auto' })
    assert.equal(be.content, 'second')
    assert.equal(be.encoding, 'utf16be')
    assert.equal(be.final_line_terminated, false)
    const tail = await readFile('fixture', 'C:\\utf16be.txt', { tail: true, maxBytes: 13, encoding: 'utf16be' })
    assert.equal(tail.content, 'second')
    assert.equal(tail.read_offset, 16)
    const gbk = Buffer.from([0x61, 0x0d, 0x0a, 0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a])
    sessionManager.getSftp = async () => remoteFile(gbk, events)
    const chinese = await readFile('fixture', 'C:\\gbk.txt', { lineRange: '2', encoding: 'gbk' })
    assert.equal(chinese.content, '中文\r\n')
    await assert.rejects(
        readFile('fixture', 'C:\\gbk.txt', { encoding: 'gbk', offset: 1 }),
        /cannot prove character boundaries/
    )
    await assert.rejects(
        readFile('fixture', 'C:\\gbk.txt', { encoding: 'gbk', tail: true }),
        /cannot prove character boundaries/
    )
    const binary = await readFile('fixture', 'C:\\gbk.txt', { binary: true })
    assert.deepEqual(Buffer.from(binary.content_base64, 'base64'), gbk)
    for (const encoding of ['utf16le', 'utf16be']) {
        const bytes = Buffer.from('😀A', 'utf16le')
        sessionManager.getSftp = async () => remoteFile(encoding === 'utf16be' ? bytes.swap16() : bytes, events)
        const sliced = await readFile('fixture', 'C:\\tail.txt', { tail: true, maxBytes: 4, encoding })
        assert.equal(sliced.content, 'A')
        assert.equal(sliced.read_offset, 4)
        assert.equal(sliced.read_bytes, 2)
    }
    sessionManager.getSftp = async () => remoteFile(Buffer.alloc(0), events)
    const empty = await readFile('fixture', 'C:\\empty.txt', { binary: true })
    assert.equal(empty.content_base64, '')
    assert.equal(empty.encoding, 'base64')
    assert.equal(empty.read_bytes, 0)
    assert.ok(events.includes('sftp.read'))
})

test('S7: remote manifest traverses SFTP pages and streams hashes with entry and byte budgets', async () => {
    const data = Buffer.from('payload')
    let pages = 0
    const sftp = {
        stat(_path, cb) {
            cb(null, { mode: 0o040755, size: 0, uid: 1 })
        },
        lstat(_path, cb) {
            cb(null, { mode: 0o100644, size: data.length, uid: 1 })
        },
        realpath(_path, cb) {
            cb(null, '/root')
        },
        opendir(_path, cb) {
            cb(null, Buffer.from('handle'))
        },
        readdir(_handle, cb) {
            ++pages
            cb(
                pages === 1 ? null : Object.assign(new Error('EOF'), { code: 1 }),
                pages === 1 ? [{ filename: 'file.txt', attrs: {} }] : undefined
            )
        },
        close(_handle, cb) {
            cb(null)
        },
        createReadStream() {
            return Readable.from([data])
        },
    }
    const manifest = await createRemoteDirectoryManifest(sftp, '/root', { sha256: true, maxEntries: 2 })
    assert.equal(manifest.count, 2)
    assert.equal(manifest.entries[1].sha256.length, 64)
    pages = 0
    const limited = await createRemoteDirectoryManifest(sftp, '/root', { sha256: true, maxFileBytes: 1 })
    assert.equal(limited.limited, true)
    assert.equal(limited.limitReason, 'file_bytes')
})

test('S8/S9: rsync profile paths and remote Win32/SFTP path grammars remain separate', async (t) => {
    assert.equal(convertRsyncPath('C:\\Program Files\\test', 'msys2'), '/c/Program Files/test')
    assert.equal(convertRsyncPath('C:\\Program Files\\test', 'cygwin'), '/cygdrive/c/Program Files/test')
    assert.equal(convertRsyncPath('\\\\server\\share\\name x', 'cygwin'), '//server/share/name x')
    assert.equal(sftpPath('C:\\Space Here\\file.txt', 'sftp-posix'), '/C:/Space Here/file.txt')
    assert.equal(remoteJoin('sftp-posix', '//server/share', 'file x.txt'), '//server/share/file x.txt')
    assert.equal(remoteDirname('sftp-posix', '//server/share/file x.txt'), '//server/share')
    assert.equal(remoteShellPath('/C:/Space Here/file.txt', 'sftp-posix'), 'C:\\Space Here\\file.txt')
    assert.equal(remoteShellPath('//server/share/file.txt', 'sftp-posix'), '\\\\server\\share\\file.txt')
    assert.throws(() => remoteShellPath('/relative/unmapped', 'sftp-posix'), /cannot be derived/)
    assert.equal(remotePathModule('win32').join('C:\\Space Here', 'file.txt'), 'C:\\Space Here\\file.txt')
    const attrs = { size: 0, mode: 0o100644, uid: 0, gid: 0, mtime: 0, atime: 0 }
    const files = await listDir(
        'fixture',
        'C:\\Space Here',
        true,
        {
            readdir(_path, cb) {
                cb(null, [{ filename: 'file.txt', attrs }])
            },
            end() {},
        },
        undefined,
        'win32'
    )
    assert.equal(files[0].path, 'C:\\Space Here\\file.txt')
    const created = []
    const missing = Object.assign(new Error('No such file'), { code: 2 })
    await mkdir(
        'fixture',
        'C:\\Space Here\\sub',
        true,
        {
            stat(remotePath, callback) {
                callback(remotePath === 'C:\\' ? null : missing, remotePath === 'C:\\' ? { mode: 0o040755 } : undefined)
            },
            mkdir(remotePath, callback) {
                created.push(remotePath)
                callback(null)
            },
            end() {},
        },
        undefined,
        'win32'
    )
    assert.deepEqual(created, ['C:\\Space Here', 'C:\\Space Here\\sub'])
    const originalExec = sessionManager.exec
    const commands = []
    sessionManager.exec = async (_alias, cmd) => {
        commands.push(cmd)
        return { success: true, stdout: 'C:\\Program Files\\rsync.exe\n', stderr: '', exitCode: 0 }
    }
    t.after(() => {
        sessionManager.exec = originalExec
    })
    const probe = await checkRsync('win-probe', 1000, 'C:\\Program Files\\rsync.exe', 'powershell')
    assert.equal(probe.available, true)
    assert.match(commands[0], /Get-Command/)
})

test('S11/S12: Windows private ACL script and SSH config quoted paths preserve slashes and spaces', (t) => {
    assert.deepEqual(parseConfigValue('"C:\\Users\\Li Ming\\.ssh\\id key" # note'), [
        'C:\\Users\\Li Ming\\.ssh\\id key',
    ])
    assert.deepEqual(parseConfigValue('C:\\Users\\Li\\.ssh\\key'), ['C:\\Users\\Li\\.ssh\\key'])
    assert.deepEqual(parseConfigValue('"\\\\server\\share\\key with spaces"'), ['\\\\server\\share\\key with spaces'])
    assert.deepEqual(parseConfigValue('\\\\server\\share\\key'), ['\\\\server\\share\\key'])
    assert.deepEqual(parseConfigValue('C:\\#private\\key # comment'), ['C:\\#private\\key'])
    assert.deepEqual(parseConfigValue("C:\\Users\\O'Neil\\id"), ["C:\\Users\\O'Neil\\id"])
    assert.deepEqual(parseConfigValue('"C:\\Users\\李 明\\.ssh\\私钥"'), ['C:\\Users\\李 明\\.ssh\\私钥'])
    assert.deepEqual(parseConfigValue('C:\\Users\\Li\\.ssh\\key\\ with\\ space'), [
        'C:\\Users\\Li\\.ssh\\key with space',
    ])
    assert.equal(expandTilde('~\\.ssh\\key'), path.join(os.homedir(), '.ssh', 'key'))
    assert.match(windowsAclScript('C:\\User\\private key', true), /SetAccessRuleProtection\(\$true, \$false\)/)
    assert.doesNotMatch(windowsAclScript('C:\\User\\private key', false), /Set-Acl/)
    assert.match(windowsAclScript('C:\\User\\private key', false), /\$allowed -notcontains \$acl\.GetOwner\(/)
    const dir = fixture(t)
    const configPath = path.join(dir, 'config')
    const previous = process.env.SSH_MCP_ALLOWED_KEY_DIRS
    process.env.SSH_MCP_ALLOWED_KEY_DIRS = dir
    t.after(() => {
        if (previous === undefined) delete process.env.SSH_MCP_ALLOWED_KEY_DIRS
        else process.env.SSH_MCP_ALLOWED_KEY_DIRS = previous
    })
    fs.writeFileSync(
        configPath,
        'Host test\n  HostName example.com\n  IdentityFile "~/.ssh/key with spaces"\n  IdentityAgent "C:\\Users\\Li Ming\\agent.sock"\n'
    )
    const parsed = parseSSHConfig(configPath)[0]
    assert.equal(parsed.identityFile, path.join(os.homedir(), '.ssh', 'key with spaces'))
    assert.equal(parsed.identityAgent, 'C:\\Users\\Li Ming\\agent.sock')
})

test('S11: Windows key ACL status requires effective read access', (t) => {
    if (process.platform !== 'win32') {
        t.skip('NTFS DACL requires a native Windows runner')
        return
    }
    const key = path.join(fixture(t), 'key')
    fs.writeFileSync(key, 'test key')
    assert.equal(checkWindowsAcl(key, true), 'key_path_usable')
    const denyRead = `$ErrorActionPreference = 'Stop'
$p = $env:MCP_SSH_TEST_PRIVATE_KEY
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $p
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'ReadData', 'Deny')
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $p -AclObject $acl`
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', denyRead], {
        env: { ...process.env, MCP_SSH_TEST_PRIVATE_KEY: key },
        encoding: 'utf8',
        timeout: 5000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(checkWindowsAcl(key), 'key_acl_unverified')
})

test('S13/S14: atomic overwrite rejects missing negotiated extension and shell-specific risk avoids search terms', async (t) => {
    const originalSftp = sessionManager.getSftp
    sessionManager.getSftp = async () => ({ _extensions: {}, end() {} })
    t.after(() => {
        sessionManager.getSftp = originalSftp
    })
    assert.deepEqual(await atomicReplaceCapability('test'), {
        atomicReplaceSupported: false,
        reason: 'posix-rename@openssh.com was not negotiated',
    })
    assert.equal(classifyCommandRisk('grep -R secret /logs', 30_000), undefined)
    assert.equal(classifyCommandRisk('rm -r /data', 30_000)?.level, 'high')
    assert.equal(classifyCommandRisk('rm --recursive /data', 30_000)?.level, 'high')
    assert.equal(classifyCommandRisk('grep -R "rm -r" /logs', 30_000), undefined)
    assert.equal(classifyCommandRisk("grep -- '--token' /logs", 30_000), undefined)
    assert.equal(classifyCommandRisk("grep -- 'systemctl restart service' /logs", 30_000), undefined)
    assert.equal(classifyCommandRisk('grep -R "Authorization: Bearer" /logs', 30_000), undefined)
    assert.equal(
        classifyCommandRisk("Select-String -Pattern 'Remove-Item -Recurse' -Path logfile", 30_000, 'powershell'),
        undefined
    )
    assert.equal(classifyCommandRisk('findstr /C:"del C:\\Data" logfile', 30_000, 'cmd'), undefined)
    assert.equal(
        classifyCommandRisk('curl -H "Authorization: Bearer value" https://example.com', 30_000)?.categories.includes(
            'credential-bearing'
        ),
        true
    )
    assert.equal(classifyCommandRisk('python app.py', 30_000), undefined)
    assert.equal(classifyCommandRisk('Remove-Item -Recurse C:\\Data', 30_000, 'powershell')?.level, 'high')
    assert.equal(classifyCommandRisk('echo secret-marker', 30_000, 'cmd'), undefined)
    assert.equal(classifyCommandRisk('taskkill /F /PID 123', 30_000, 'cmd')?.level, 'high')
    assert.equal(classifyCommandRisk('del C:\\Data\\file.txt', 30_000, 'cmd')?.level, 'high')
    assert.equal(
        classifyCommandRisk('Get-ChildItem -Recurse C:\\', undefined, 'powershell')?.categories.includes(
            'long-running'
        ),
        true
    )
    assert.equal(classifyCommandRisk('dir /s C:\\', undefined, 'cmd')?.categories.includes('long-running'), true)
    assert.equal(classifyCommandRisk('curl --token=xyz', 30_000)?.categories.includes('credential-bearing'), true)
    const file = tools(registerFileTools).get('ssh_upload')
    assert.ok(file.schema.inputSchema.shape.atomic)
    assert.ok(file.schema.inputSchema.shape.remotePath)
    const execution = tools(registerExecTools)
    assert.ok(execution.get('ssh_exec').schema.inputSchema.shape.maxOutputSize)
    assert.ok(execution.get('ssh_quick_exec').schema.inputSchema.shape.remotePlatform)
})

test('S4: Windows script refuses to send content before ACL verification and cleans its empty SFTP file', async (t) => {
    const alias = 'windows-script-fixture'
    const manager = sessionManager
    const originalExec = manager.exec
    const originalSftp = manager.getSftp
    const writes = []
    const removed = []
    manager.sessions.set(alias, {
        client: {},
        config: { host: 'example.com', username: 'fixture', remotePlatform: 'windows', commandShell: 'powershell' },
        connected: true,
        connectedAt: 1,
        lastUsedAt: 1,
        reconnectAttempts: 0,
        manualClose: false,
    })
    t.after(() => {
        manager.exec = originalExec
        manager.getSftp = originalSftp
        manager.sessions.delete(alias)
    })
    manager.exec = async (_alias, command) => {
        const decoded = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le')
        if (decoded.includes('GetTempPath')) {
            assert.match(decoded, /GetAccessRules/)
            assert.match(decoded, /DeleteSubdirectoriesAndFiles/)
            const filename = decoded.match(/mcp-ssh-script-[a-f0-9-]+\.ps1/)?.[0]
            assert.ok(filename)
            return { success: true, stdout: `C:\\Temp\\${filename}\r\n`, stderr: '', exitCode: 0 }
        }
        assert.match(decoded, /SetAccessRuleProtection/)
        return { success: false, stdout: 'insecure', stderr: 'ACL denied', exitCode: 1 }
    }
    manager.getSftp = async () => ({
        createWriteStream(name, options) {
            writes.push({ name, options })
            return new Writable({
                write(chunk, _encoding, cb) {
                    writes.push(Buffer.from(chunk))
                    cb()
                },
            })
        },
        unlink(name, callback) {
            removed.push(name)
            callback(null)
        },
        end() {},
    })
    const handler = tools(registerExecTools).get('ssh_exec_script').handler
    const response = content(await handler({ alias, script: 'credential=private', keepScript: true }))
    assert.equal(response.success, false)
    assert.match(response.error, /privacy_not_enforced_on_windows/)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].options.flags, 'wx')
    assert.deepEqual(removed, [writes[0].name])
})

test('S6: Windows tracked operation captures PID and creation ticks and verifies identity before tree termination', async (t) => {
    const dir = fixture(t)
    const manager = new SessionManager(path.join(dir, 'sessions.json'))
    let stream
    let commandSent
    manager.sessions.set('win', {
        client: {
            exec(command, _options, cb) {
                commandSent = command
                stream = new EventEmitter()
                stream.stderr = new EventEmitter()
                stream.destroy = () => {}
                stream.close = () => {}
                cb(null, stream)
            },
            end() {},
        },
        config: {
            host: 'example.com',
            port: 22,
            username: 'fixture',
            remotePlatform: 'windows',
            commandShell: 'powershell',
        },
        connected: true,
        connectedAt: 1,
        lastUsedAt: 1,
        reconnectAttempts: 0,
        manualClose: false,
    })
    t.after(() => manager.operationManager.close())
    const operation = await manager.operationStart('win', 'Start-Sleep 30')
    const outer = Buffer.from(commandSent.split(' ').at(-1), 'base64').toString('utf16le')
    const innerEncoded = outer.match(
        /powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)/
    )?.[1]
    const inner = Buffer.from(innerEncoded, 'base64').toString('utf16le')
    const marker = inner.match(/\$operationMarker = '([a-f0-9]+)'/)?.[1]
    assert.ok(marker)
    stream.stderr.emit('data', Buffer.from(`__MCP_SSH_OPERATION__:${marker}:4321:0:123456789\n`))
    assert.equal(manager.operationStatus(operation.operationId).processCreatedAt, '123456789')
    const originalExec = manager.exec
    manager.exec = async (_alias, command) => {
        const encodedScript = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le')
        assert.match(encodedScript, /Get-CimInstance Win32_Process/)
        assert.match(encodedScript, /Get-Process -Id \$remotePid/)
        assert.match(encodedScript, /taskkill\.exe \/PID \$remotePid \/T \/F/)
        assert.ok(encodedScript.includes(marker))
        return { success: true, stdout: '', stderr: '', exitCode: 0 }
    }
    t.after(() => {
        manager.exec = originalExec
    })
    const cancelled = await manager.operationCancel(operation.operationId)
    assert.equal(cancelled.success, true)
    assert.equal(cancelled.cancelRequested, true)
    assert.equal(cancelled.cancellationStatus, 'requested')
    manager.exec = async () => ({ success: false, stdout: '', stderr: 'process identity unavailable', exitCode: 3 })
    const unverified = await manager.operationCancel(operation.operationId)
    assert.equal(unverified.success, false)
    assert.equal(unverified.cancellationStatus, 'unknown')
    assert.equal(unverified.status, 'running')
    assert.deepEqual(await manager.cancelRemoteOperation('win', 4321, marker, false, {}, undefined), {
        success: false,
        cancellationStatus: 'unsupported',
        error: 'unsupported_remote_platform: process creation time is unavailable',
    })
    manager.disconnect('win')
})

test('S10: SSH exec output budget is UTF-8 bytes, and PTY raw base64 preserves arbitrary bytes', async (t) => {
    const dir = fixture(t)
    const manager = new SessionManager(path.join(dir, 'sessions.json'))
    manager.sessions.set('bytes', {
        client: {
            exec(_cmd, _options, callback) {
                const stream = new EventEmitter()
                stream.stderr = new EventEmitter()
                stream.close = () => {}
                callback(null, stream)
                Promise.resolve().then(() => {
                    stream.emit('data', Buffer.from('😀😀'))
                    stream.emit('close', 0)
                })
            },
            end() {},
        },
        config: { host: 'example.com', username: 'fixture' },
        connected: true,
        connectedAt: 1,
        lastUsedAt: 1,
        reconnectAttempts: 0,
        manualClose: false,
    })
    t.after(() => manager.operationManager.close())
    const result = await manager.exec('bytes', 'printf test', { maxOutputSize: 5 })
    assert.equal(result.stdout, '😀')
    assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 5)
    assert.equal(result.stdoutTruncated, true)
    assert.equal(result.stdoutBytes, 8)
    assert.equal(result.maxOutputSize, 5)
    manager.disconnect('bytes')
})

test('S13: public atomic upload checks negotiated SFTP capability before a write', async (t) => {
    const dir = fixture(t)
    const source = path.join(dir, 'source.txt')
    fs.writeFileSync(source, 'replacement')
    const alias = 'atomic-no-extension'
    const originalSftp = sessionManager.getSftp
    sessionManager.sessions.set(alias, {
        client: {},
        config: { host: 'example.com', username: 'fixture' },
        connected: true,
        connectedAt: 1,
        lastUsedAt: 1,
        reconnectAttempts: 0,
        manualClose: false,
    })
    let writes = 0
    sessionManager.getSftp = async () => ({
        _extensions: {},
        stat(remotePath, cb) {
            cb(null, {
                size: 8,
                mode: remotePath === '/remote' ? 0o040755 : 0o100644,
                uid: 1,
                gid: 1,
                mtime: 1,
                atime: 1,
            })
        },
        createWriteStream() {
            ++writes
            throw new Error('write should not start')
        },
        end() {},
    })
    t.after(() => {
        sessionManager.getSftp = originalSftp
        sessionManager.sessions.delete(alias)
    })
    const response = content(
        await tools(registerFileTools)
            .get('ssh_upload')
            .handler({ alias, localPath: source, remotePath: '/remote/old.txt', atomic: true })
    )
    assert.equal(response.code, 'atomic_replace_unsupported')
    assert.equal(response.atomicReplaceSupported, false)
    assert.equal(response.targetReplaced, false)
    assert.equal(writes, 0)
})

test('S1/S2/S8: ssh_connect public arguments reach the session manager without changing local platform defaults', async (t) => {
    const originalConnect = sessionManager.connect
    const originalInfo = sessionManager.getSessionConnectionInfo
    let connectedConfig
    sessionManager.connect = async (config) => {
        connectedConfig = config
        return 'fixture'
    }
    sessionManager.getSessionConnectionInfo = () => ({
        alias: 'fixture',
        identity: 'tester@example.com:22',
        loginUser: 'tester',
        runAs: undefined,
        host: 'example.com',
        port: 22,
        defaultEnvKeys: [],
        envKeys: [],
        hasJumpHost: false,
        remotePlatform: 'windows',
        commandShell: 'cmd',
        remotePathStyle: 'win32',
    })
    t.after(() => {
        sessionManager.connect = originalConnect
        sessionManager.getSessionConnectionInfo = originalInfo
    })
    const result = content(
        await tools(registerConnectionTools).get('ssh_connect').handler({
            host: 'example.com',
            user: 'tester',
            agent: '\\\\.\\pipe\\openssh-ssh-agent',
            remotePlatform: 'windows',
            commandShell: 'cmd',
            remotePathStyle: 'win32',
            rsyncExecutable: 'C:\\Program Files\\rsync.exe',
            rsyncProfile: 'native-win32',
        })
    )
    assert.equal(result.success, true)
    assert.equal(connectedConfig.agent, '\\\\.\\pipe\\openssh-ssh-agent')
    assert.equal(connectedConfig.remotePlatform, 'windows')
    assert.equal(connectedConfig.commandShell, 'cmd')
    assert.equal(connectedConfig.rsyncProfile, 'native-win32')
    assert.equal(connectedConfig.rsyncExecutable, 'C:\\Program Files\\rsync.exe')
})

test('S3/S5/S7: public Windows tools reject privileges and POSIX verification before remote side effects', async (t) => {
    const alias = 'win-public-negative'
    let sshCalls = 0
    let sftpCalls = 0
    sessionManager.sessions.set(alias, {
        client: {
            exec() {
                ++sshCalls
            },
        },
        config: { host: 'example.com', username: 'tester', remotePlatform: 'windows', commandShell: 'powershell' },
        connected: true,
        connectedAt: 1,
        lastUsedAt: 1,
        reconnectAttempts: 0,
        manualClose: false,
    })
    const originalSftp = sessionManager.getSftp
    sessionManager.getSftp = async () => {
        ++sftpCalls
        throw new Error('SFTP should not start')
    }
    t.after(() => {
        sessionManager.getSftp = originalSftp
        sessionManager.sessions.delete(alias)
    })
    const commands = tools(registerExecTools)
    for (const [name, args] of [
        ['ssh_exec_as_user', { command: 'whoami' }],
        ['ssh_exec_sudo', { command: 'whoami' }],
        ['ssh_exec', { command: 'whoami', runAs: 'other' }],
    ]) {
        const result = content(await commands.get(name).handler({ alias, ...args }))
        assert.equal(result.details.code, 'unsupported_remote_platform')
    }
    const files = tools(registerFileTools)
    const upload = content(
        await files
            .get('ssh_upload')
            .handler({ alias, localPath: '/not-read', remotePath: 'C:\\test.txt', verifyMode: '0600' })
    )
    assert.equal(upload.code, 'unsupported_remote_platform')
    const sync = content(
        await files.get('ssh_sync').handler({
            alias,
            localPath: '/not-read',
            remotePath: 'C:\\target',
            direction: 'upload',
            verify: { owner: true },
        })
    )
    assert.equal(sync.code, 'unsupported_remote_platform')
    assert.deepEqual({ sshCalls, sftpCalls }, { sshCalls: 0, sftpCalls: 0 })
})

test('S5/S9: public file reads map Windows SFTP paths and expose encoding and base64 bytes', async (t) => {
    const alias = 'win-public-read'
    const bytes = Buffer.from('a\r\nb\r\n', 'utf16le')
    const requested = []
    const originalSftp = sessionManager.getSftp
    sessionManager.sessions.set(alias, {
        client: {},
        config: { host: 'example.com', username: 'tester', remotePlatform: 'windows', remotePathStyle: 'sftp-posix' },
        connected: true,
        connectedAt: 1,
        lastUsedAt: 1,
        reconnectAttempts: 0,
        manualClose: false,
    })
    sessionManager.getSftp = async () => ({
        stat(remotePath, callback) {
            requested.push(remotePath)
            callback(null, { size: bytes.length })
        },
        createReadStream(remotePath) {
            requested.push(remotePath)
            return Readable.from([bytes])
        },
        end() {},
    })
    t.after(() => {
        sessionManager.getSftp = originalSftp
        sessionManager.sessions.delete(alias)
    })
    const read = tools(registerFileTools).get('ssh_read_file')
    assert.ok(read.schema.inputSchema.shape.encoding)
    assert.ok(read.schema.inputSchema.shape.binary)
    const line = content(
        await read.handler({ alias, remotePath: 'C:\\Space Here\\file.txt', lineRange: '2', encoding: 'utf16le' })
    )
    assert.equal(line.content, 'b\r\n')
    const binary = content(await read.handler({ alias, remotePath: 'C:\\Space Here\\file.txt', binary: true }))
    assert.deepEqual(Buffer.from(binary.content_base64, 'base64'), bytes)
    assert.deepEqual(requested, Array(4).fill('/C:/Space Here/file.txt'))
})

test('S4: Windows script writes content only after verified ACL, executes selected shell, and uses SFTP cleanup', async (t) => {
    const alias = 'windows-script-success'
    const originalExec = sessionManager.exec
    const originalSftp = sessionManager.getSftp
    const order = []
    const bodies = []
    const sftpPaths = []
    sessionManager.sessions.set(alias, {
        client: {},
        config: {
            host: 'example.com',
            username: 'tester',
            remotePlatform: 'windows',
            commandShell: 'cmd',
            remotePathStyle: 'sftp-posix',
        },
        connected: true,
        connectedAt: 1,
        lastUsedAt: 1,
        reconnectAttempts: 0,
        manualClose: false,
    })
    sessionManager.exec = async (_alias, command) => {
        const decoded = command.startsWith('powershell.exe')
            ? Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le')
            : command
        if (decoded.includes('GetTempPath')) {
            order.push('path')
            return {
                success: true,
                stdout: `C:\\Temp\\${decoded.match(/mcp-ssh-script-[a-f0-9-]+\.cmd/)[0]}\r\n`,
                stderr: '',
                exitCode: 0,
            }
        }
        if (decoded.includes('SetAccessRuleProtection')) {
            order.push('acl')
            assert.match(decoded, /C:\\Temp\\mcp-ssh-script-/)
            assert.doesNotMatch(decoded, /\/C:\/Temp/)
            return { success: true, stdout: 'usable\r\n', stderr: '', exitCode: 0 }
        }
        order.push('exec')
        assert.match(command, /^cmd\.exe \/D \/C "C:\\Temp\\mcp-ssh-script-/)
        return { success: true, stdout: 'executed', stderr: '', exitCode: 0 }
    }
    sessionManager.getSftp = async () => ({
        createWriteStream(name, options) {
            sftpPaths.push(name)
            order.push(options.flags)
            return new Writable({
                write(chunk, _encoding, callback) {
                    bodies.push(Buffer.from(chunk))
                    callback()
                },
            })
        },
        unlink(name, callback) {
            sftpPaths.push(name)
            order.push('cleanup')
            callback(null)
        },
        end() {},
    })
    t.after(() => {
        sessionManager.exec = originalExec
        sessionManager.getSftp = originalSftp
        sessionManager.sessions.delete(alias)
    })
    const result = content(
        await tools(registerExecTools)
            .get('ssh_exec_script')
            .handler({ alias, script: 'echo test', interpreter: 'cmd' })
    )
    assert.equal(result.success, true)
    assert.deepEqual(order, ['path', 'wx', 'acl', 'w', 'exec', 'cleanup'])
    assert.equal(sftpPaths.length, 3)
    assert.ok(sftpPaths.every((item) => item.startsWith('/C:/Temp/mcp-ssh-script-')))
    assert.equal(Buffer.concat(bodies).toString(), '@chcp 65001>nul || exit /b 1\r\necho test')
})

test('S4: Windows script bodies preserve Unicode for PowerShell and switch cmd to UTF-8', (t) => {
    const psBody = windowsScriptContent(
        "if ([int][char]'中' -eq 20013) { 'ok' } else { throw 'encoding mismatch' }",
        'powershell'
    )
    const cmdBody = windowsScriptContent('@echo 中文', 'cmd')
    assert.deepEqual([...Buffer.from(psBody).subarray(0, 3)], [0xef, 0xbb, 0xbf])
    assert.match(cmdBody, /^@chcp 65001>nul \|\| exit \/b 1\r\n@echo 中文/)
    assert.equal(windowsScriptContent(psBody, 'powershell'), psBody)
    assert.equal(windowsScriptContent(String.fromCharCode(0xfeff) + '@echo 中文', 'cmd'), cmdBody)
    if (process.platform !== 'win32') {
        t.skip('Native Windows PowerShell and cmd execution requires a Windows runner')
        return
    }
    const root = fixture(t)
    const psPath = path.join(root, 'unicode.ps1')
    const cmdPath = path.join(root, 'unicode.cmd')
    fs.writeFileSync(psPath, psBody, 'utf8')
    fs.writeFileSync(cmdPath, cmdBody, 'utf8')
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', psPath], {
        encoding: 'utf8',
        timeout: 5000,
    })
    assert.equal(ps.status, 0, ps.stderr)
    assert.match(ps.stdout, /ok/)
    const cmd = spawnSync('cmd.exe', ['/D', '/C', `"${cmdPath}"`], { encoding: 'utf8', timeout: 5000 })
    assert.equal(cmd.status, 0, cmd.stderr)
    assert.match(cmd.stdout, /中文/)
})

test('S4: Windows rejects a shared temporary directory before writing script content', (t) => {
    if (process.platform !== 'win32') {
        t.skip('NTFS DACL requires a native Windows runner')
        return
    }
    const shared = path.join(fixture(t), 'shared')
    fs.mkdirSync(shared)
    const grant = spawnSync('icacls.exe', [shared, '/grant', '*S-1-1-0:(OI)(CI)F'], { encoding: 'utf8' })
    assert.equal(grant.status, 0, grant.stderr)
    const encoded = encodedPowershell(windowsTemporaryPathScript('script.ps1')).split(' ').at(-1)
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        env: { ...process.env, TEMP: shared, TMP: shared },
        encoding: 'utf8',
        timeout: 5000,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /privacy_not_enforced_on_windows/)
})

test('S4: remote script cleanup respects the caller timeout when SFTP stops responding', async (t) => {
    const original = sessionManager.getSftp
    let closed = 0
    sessionManager.getSftp = async () => ({
        unlink() {},
        end() {
            ++closed
        },
    })
    t.after(() => {
        sessionManager.getSftp = original
    })
    await assert.rejects(removeRemoteFile('fixture', 'C:\\Temp\\script.ps1', 20), /timed out after 20ms/)
    assert.equal(closed, 1)
})

test('S8: an explicit Windows rsync profile maps remote drive paths and quotes the remote executable', async (t) => {
    if (process.platform === 'win32') {
        t.skip('POSIX fake executable fixture; Windows-native rsync needs Windows runner')
        return
    }
    const dir = fixture(t)
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    const source = path.join(dir, 'source.txt')
    const argsFile = path.join(dir, 'rsync-arguments.txt')
    fs.writeFileSync(source, 'data')
    fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nexit 0\n')
    fs.writeFileSync(path.join(bin, 'rsync'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$MCP_TEST_RSYNC_ARGS"\n')
    fs.chmodSync(path.join(bin, 'ssh'), 0o755)
    fs.chmodSync(path.join(bin, 'rsync'), 0o755)
    const oldPath = process.env.PATH
    const oldArgs = process.env.MCP_TEST_RSYNC_ARGS
    const originalExec = sessionManager.exec
    const originalCapability = sessionManager.getExternalTransferCapability
    process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`
    process.env.MCP_TEST_RSYNC_ARGS = argsFile
    sessionManager.exec = async () => ({ success: true, stdout: 'C:\\Rsync Tools\\rsync.exe', stderr: '', exitCode: 0 })
    sessionManager.getExternalTransferCapability = () => ({
        alias: 'windows-rsync',
        host: 'example.com',
        port: 22,
        username: 'tester',
        identity: 'tester@example.com:22',
        authMethod: 'agent',
        hasJumpHost: false,
        routeSafeForOpenSsh: true,
        rsyncEligible: true,
        decisionReason: 'direct_ssh_agent_socket',
        rsyncExecutable: 'C:\\Rsync Tools\\rsync.exe',
        rsyncProfile: 'msys2',
        commandShell: 'powershell',
        remotePathStyle: 'win32',
    })
    t.after(() => {
        sessionManager.exec = originalExec
        sessionManager.getExternalTransferCapability = originalCapability
        clearRsyncCache('windows-rsync')
        if (oldPath === undefined) delete process.env.PATH
        else process.env.PATH = oldPath
        if (oldArgs === undefined) delete process.env.MCP_TEST_RSYNC_ARGS
        else process.env.MCP_TEST_RSYNC_ARGS = oldArgs
    })
    const result = await syncFiles('windows-rsync', source, 'C:\\Remote Files\\target.txt', 'upload')
    assert.equal(result.success, true)
    assert.equal(result.selectedTransport, 'rsync')
    const args = fs.readFileSync(argsFile, 'utf8').split('\n').filter(Boolean)
    assert.ok(args.includes('--protect-args'))
    assert.ok(args.some((arg) => arg.includes("--rsync-path=& 'C:\\Rsync Tools\\rsync.exe'")))
    assert.ok(args.includes('tester@example.com:/c/Remote Files/target.txt'))
})

test('S8: remote shell mismatch falls back before rsync transfers data', async (t) => {
    if (process.platform === 'win32') {
        t.skip('POSIX fake executable fixture; Windows-native rsync needs Windows runner')
        return
    }
    const dir = fixture(t)
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    const source = path.join(dir, 'source.txt')
    const rsyncCalled = path.join(dir, 'rsync-called')
    fs.writeFileSync(source, 'data')
    fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\ncase "$*" in *" --version"*) exit 1 ;; esac\nexit 0\n')
    fs.writeFileSync(path.join(bin, 'rsync'), `#!/bin/sh\ntouch "${rsyncCalled}"\nexit 0\n`)
    fs.chmodSync(path.join(bin, 'ssh'), 0o755)
    fs.chmodSync(path.join(bin, 'rsync'), 0o755)
    const oldPath = process.env.PATH
    const originalExec = sessionManager.exec
    const originalCapability = sessionManager.getExternalTransferCapability
    const originalSftp = sessionManager.getSftp
    process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`
    sessionManager.exec = async () => ({ success: true, stdout: 'C:\\Rsync Tools\\rsync.exe', stderr: '', exitCode: 0 })
    sessionManager.getExternalTransferCapability = () => ({
        alias: 'rsync-shell-mismatch',
        host: 'example.com',
        port: 22,
        username: 'tester',
        identity: 'tester@example.com:22',
        authMethod: 'agent',
        hasJumpHost: false,
        routeSafeForOpenSsh: true,
        rsyncEligible: true,
        decisionReason: 'direct_ssh_agent_socket',
        commandShell: 'powershell',
        rsyncProfile: 'msys2',
        rsyncExecutable: 'C:\\Rsync Tools\\rsync.exe',
        remotePathStyle: 'win32',
    })
    let remoteData
    sessionManager.getSftp = async () => ({
        stat(_name, cb) {
            cb(
                remoteData ? null : Object.assign(new Error('not found'), { code: 2 }),
                remoteData ? { size: remoteData.length, mode: 0o100644, uid: 0, gid: 0, mtime: 1, atime: 1 } : undefined
            )
        },
        createWriteStream() {
            return new Writable({
                write(chunk, _encoding, cb) {
                    remoteData = Buffer.from(chunk)
                    cb()
                },
            })
        },
        createReadStream() {
            return Readable.from([remoteData])
        },
        end() {},
    })
    t.after(() => {
        sessionManager.exec = originalExec
        sessionManager.getExternalTransferCapability = originalCapability
        sessionManager.getSftp = originalSftp
        clearRsyncCache('rsync-shell-mismatch')
        if (oldPath === undefined) delete process.env.PATH
        else process.env.PATH = oldPath
    })
    const result = await syncFiles('rsync-shell-mismatch', source, 'C:\\Remote\\item.txt', 'upload')
    assert.equal(result.success, true)
    assert.equal(result.transport, 'sftp')
    assert.equal(result.fallbackReason, 'remote_rsync_command_unavailable')
    assert.equal(remoteData.toString(), 'data')
    assert.equal(fs.existsSync(rsyncCalled), false)
})

test('S8: Windows rsync requires explicit profile even with an otherwise usable key path', (t) => {
    if (process.platform === 'win32') {
        t.skip('POSIX key mode fixture; Windows key DACL requires native runner')
        return
    }
    const dir = fixture(t)
    const manager = new SessionManager(path.join(dir, 'sessions.json'))
    const keyPath = path.join(dir, 'key')
    fs.writeFileSync(keyPath, 'test')
    fs.chmodSync(keyPath, 0o600)
    const config = { host: 'example.com', username: 'tester', privateKeyPath: keyPath, remotePlatform: 'windows' }
    manager.sessions.set('win', {
        client: {},
        config,
        connected: true,
        connectedAt: 1,
        lastUsedAt: 1,
        reconnectAttempts: 0,
        manualClose: false,
    })
    assert.equal(manager.getExternalTransferCapability('win').decisionReason, 'rsync_profile_required_for_windows')
    assert.equal(manager.getExternalTransferCapability('win').rsyncEligible, false)
    config.rsyncProfile = 'native-win32'
    assert.equal(manager.getExternalTransferCapability('win').rsyncEligible, true)
    manager.operationManager.close()
})

test('S10: public PTY raw output returns lossless base64 for invalid UTF-8 bytes', async (t) => {
    const manager = new PtyManager()
    const stream = new EventEmitter()
    stream.close = () => stream.emit('close')
    const ptyId = await manager.start({ execPty: async () => stream }, 'fixture', 'cat', { bufferSize: 4 })
    const bytes = Buffer.from([0xff, 0xfe, 0x41, 0x42, 0xf0])
    stream.emit('data', bytes)
    const originalRead = sessionManager.ptyRead
    sessionManager.ptyRead = (id, options) => manager.read(id, options)
    t.after(() => {
        sessionManager.ptyRead = originalRead
        manager.close(ptyId)
    })
    const raw = content(await tools(registerPtyTools).get('ssh_pty_read').handler({ ptyId, mode: 'raw' }))
    assert.equal(raw.mode, 'raw')
    assert.deepEqual(Buffer.from(raw.dataBase64, 'base64'), bytes.subarray(-4))
    assert.equal(raw.rawBufferTruncated, true)
})

test('S7: public directory sync verifies Windows ACL separately from POSIX metadata using SFTP manifest', async (t) => {
    const dir = fixture(t)
    const localPath = path.join(dir, 'empty')
    fs.mkdirSync(localPath)
    const alias = 'win-directory-acl'
    const originalSftp = sessionManager.getSftp
    const originalExec = sessionManager.exec
    sessionManager.sessions.set(alias, {
        client: {},
        config: {
            host: 'example.com',
            username: 'tester',
            password: 'test',
            remotePlatform: 'windows',
            commandShell: 'powershell',
            remotePathStyle: 'win32',
        },
        connected: true,
        connectedAt: 1,
        lastUsedAt: 1,
        reconnectAttempts: 0,
        manualClose: false,
    })
    let manifestReads = 0
    const sftp = {
        stat(_remotePath, callback) {
            callback(null, { size: 0, mode: 0o040755, uid: 0, gid: 0, mtime: 1, atime: 1 })
        },
        realpath(remotePath, callback) {
            callback(null, remotePath)
        },
        opendir(_remotePath, callback) {
            callback(null, Buffer.from('handle'))
        },
        readdir(_handle, callback) {
            ++manifestReads
            callback(Object.assign(new Error('EOF'), { code: 1 }))
        },
        close(_handle, callback) {
            callback(null)
        },
        end() {},
    }
    sessionManager.getSftp = async () => sftp
    sessionManager.exec = async (_alias, command) => {
        const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le')
        assert.match(script, /Get-Acl -LiteralPath 'C:\\Remote Data'/)
        return { success: true, stdout: 'D:PAI(A;;FA;;;SY)\r\n', stderr: '', exitCode: 0 }
    }
    t.after(() => {
        sessionManager.exec = originalExec
        sessionManager.getSftp = originalSftp
        sessionManager.sessions.delete(alias)
    })
    const result = content(
        await tools(registerFileTools)
            .get('ssh_sync')
            .handler({
                alias,
                localPath,
                remotePath: 'C:\\Remote Data',
                direction: 'upload',
                verify: { aclSddl: 'D:PAI(A;;FA;;;SY)' },
            })
    )
    assert.equal(result.success, true)
    assert.equal(result.verification.checks.acl, true)
    assert.ok(manifestReads > 0)
})

test('S9: public Win32 list, mkdir, and file-info use remote separators and names', async (t) => {
    const alias = 'win-path-tools'
    const originalSftp = sessionManager.getSftp
    sessionManager.sessions.set(alias, {
        client: {},
        config: { host: 'example.com', username: 'tester', remotePlatform: 'windows', remotePathStyle: 'win32' },
        connected: true,
        connectedAt: 1,
        lastUsedAt: 1,
        reconnectAttempts: 0,
        manualClose: false,
    })
    const existing = new Set(['C:\\', 'C:\\Data Root'])
    const created = []
    sessionManager.getSftp = async () => ({
        stat(remotePath, callback) {
            if (existing.has(remotePath) || remotePath.endsWith('file.txt')) {
                callback(null, {
                    size: 0,
                    mode: remotePath.endsWith('file.txt') ? 0o100644 : 0o040755,
                    uid: 0,
                    gid: 0,
                    mtime: 1,
                    atime: 1,
                })
            } else {
                callback(Object.assign(new Error('No such file'), { code: 2 }))
            }
        },
        readdir(_remotePath, callback) {
            callback(null, [
                { filename: 'file.txt', attrs: { size: 0, mode: 0o100644, uid: 0, gid: 0, mtime: 1, atime: 1 } },
            ])
        },
        mkdir(remotePath, callback) {
            created.push(remotePath)
            existing.add(remotePath)
            callback(null)
        },
        end() {},
    })
    t.after(() => {
        sessionManager.getSftp = originalSftp
        sessionManager.sessions.delete(alias)
    })
    const handlers = tools(registerFileTools)
    const list = content(
        await handlers.get('ssh_list_dir').handler({ alias, remotePath: 'C:\\Data Root', showHidden: true })
    )
    assert.equal(list.files[0].path, 'C:\\Data Root\\file.txt')
    const info = content(await handlers.get('ssh_file_info').handler({ alias, remotePath: 'C:\\Data Root\\file.txt' }))
    assert.equal(info.name, 'file.txt')
    const made = content(
        await handlers.get('ssh_mkdir').handler({ alias, remotePath: 'C:\\Data Root\\sub\\nested', recursive: true })
    )
    assert.equal(made.success, true)
    assert.deepEqual(created, ['C:\\Data Root\\sub', 'C:\\Data Root\\sub\\nested'])
})

test('S9: Windows directory download refuses case-folded name collisions before writing', async (t) => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    const originalSftp = sessionManager.getSftp
    const alias = 'case-collision-download'
    const localPath = path.join(fixture(t), 'target')
    let reads = 0
    sessionManager.sessions.set(alias, {
        client: {},
        config: { host: 'example.com', username: 'fixture', password: 'test' },
        connected: true,
        connectedAt: 1,
        lastUsedAt: 1,
        reconnectAttempts: 0,
        manualClose: false,
    })
    sessionManager.getSftp = async () => ({
        stat(_name, callback) {
            callback(null, { size: 0, mode: 0o040755, uid: 0, gid: 0, mtime: 1, atime: 1 })
        },
        readdir(_name, callback) {
            callback(
                null,
                ['a.txt', 'A.txt'].map((filename) => ({
                    filename,
                    attrs: { size: 1, mode: 0o100644, uid: 0, gid: 0, mtime: 1, atime: 1 },
                }))
            )
        },
        createReadStream() {
            ++reads
            throw new Error('collision must prevent downloads')
        },
        end() {},
    })
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' })
    t.after(() => {
        Object.defineProperty(process, 'platform', originalPlatform)
        sessionManager.getSftp = originalSftp
        sessionManager.sessions.delete(alias)
    })
    const result = await syncFiles(alias, localPath, '/remote', 'download')
    assert.equal(result.success, false)
    assert.match(result.output, /Windows local filename collision/)
    assert.equal(reads, 0)
    assert.equal(fs.existsSync(localPath), false)
})

test('S11/S13: Windows atomic upload refuses to write contents until the temporary file has a private DACL', async (t) => {
    const dir = fixture(t)
    const source = path.join(dir, 'source.txt')
    fs.writeFileSync(source, 'secret payload')
    const alias = 'win-atomic-private'
    const originalSftp = sessionManager.getSftp
    const originalExec = sessionManager.exec
    sessionManager.sessions.set(alias, {
        client: {},
        config: {
            host: 'example.com',
            username: 'tester',
            remotePlatform: 'windows',
            commandShell: 'powershell',
            remotePathStyle: 'win32',
        },
        connected: true,
        connectedAt: 1,
        lastUsedAt: 1,
        reconnectAttempts: 0,
        manualClose: false,
    })
    const writes = []
    const removed = []
    sessionManager.getSftp = async () => ({
        _extensions: { 'posix-rename@openssh.com': '1' },
        stat(_path, callback) {
            callback(null, { size: 4, mode: 0o100644, uid: 0, gid: 0, mtime: 1, atime: 1 })
        },
        createWriteStream(remotePath, options) {
            writes.push({ remotePath, flags: options.flags })
            return new Writable({
                write(_chunk, _encoding, callback) {
                    assert.fail('private ACL check must precede content')
                    callback()
                },
            })
        },
        unlink(remotePath, callback) {
            removed.push(remotePath)
            callback(null)
        },
        end() {},
    })
    sessionManager.exec = async () => ({ success: false, stdout: 'insecure', stderr: 'ACL denied', exitCode: 1 })
    t.after(() => {
        sessionManager.getSftp = originalSftp
        sessionManager.exec = originalExec
        sessionManager.sessions.delete(alias)
    })
    const response = content(
        await tools(registerFileTools).get('ssh_upload').handler({
            alias,
            localPath: source,
            remotePath: 'C:\\Data\\old.txt',
            atomic: true,
        })
    )
    assert.equal(response.success, false)
    assert.match(response.error, /privacy_not_enforced_on_windows/)
    assert.deepEqual(
        writes.map((item) => item.flags),
        ['wx']
    )
    assert.deepEqual(removed, [writes[0].remotePath])
})

test('S7: streamed manifest enforces byte budget when a remote file grows after stat', async () => {
    let pages = 0
    const sftp = {
        stat(_path, callback) {
            callback(null, { mode: 0o040755, size: 0, uid: 1 })
        },
        lstat(_path, callback) {
            callback(null, { mode: 0o100644, size: 1, uid: 1 })
        },
        realpath(_path, callback) {
            callback(null, '/root')
        },
        opendir(_path, callback) {
            callback(null, Buffer.from('dir'))
        },
        readdir(_handle, callback) {
            if (pages++ === 0) callback(null, [{ filename: 'growing.txt', attrs: {} }])
            else callback(Object.assign(new Error('EOF'), { code: 1 }))
        },
        createReadStream() {
            return Readable.from([Buffer.from('expanded')])
        },
        close(_handle, callback) {
            callback(null)
        },
    }
    const result = await createRemoteDirectoryManifest(sftp, '/root', { sha256: true, maxFileBytes: 1 })
    assert.equal(result.limited, true)
    assert.equal(result.limitReason, 'file_bytes')
})

test('R1: public Windows upload refuses case collisions before any transfer or mkdir', async (t) => {
    const root = fixture(t)
    const source = path.join(root, 'source')
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'a.txt'), 'lower')
    fs.writeFileSync(path.join(source, 'A.txt'), 'upper')
    const alias = 'upload-case-regression'
    const originalSftp = sessionManager.getSftp
    const originalExec = sessionManager.exec
    const events = []
    sessionManager.sessions.set(alias, {
        client: {},
        config: { host: 'example.com', username: 'test', password: 'test', remotePlatform: 'windows' },
        connected: true,
        connectedAt: 1,
        lastUsedAt: 1,
        reconnectAttempts: 0,
        manualClose: false,
    })
    sessionManager.exec = async (_alias, command) => {
        events.push('query')
        const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le')
        assert.match(script, /GetFileInformationByHandleEx/)
        assert.match(script, /CompareStringOrdinal/)
        return {
            success: true,
            stdout: JSON.stringify({ caseSensitive: false, collision: ['A.txt', 'a.txt'] }),
            stderr: '',
            exitCode: 0,
        }
    }
    sessionManager.getSftp = async () => ({
        stat(_name, cb) {
            cb(null, { size: 0, mode: 0o040755 })
        },
        mkdir(_name, cb) {
            events.push('mkdir')
            cb(null)
        },
        createWriteStream() {
            events.push('write')
            return new Writable({
                write(_chunk, _encoding, cb) {
                    cb()
                },
            })
        },
        end() {},
    })
    t.after(() => {
        sessionManager.exec = originalExec
        sessionManager.getSftp = originalSftp
        sessionManager.sessions.delete(alias)
    })
    const result = content(
        await tools(registerFileTools)
            .get('ssh_sync')
            .handler({ alias, localPath: source, remotePath: 'C:\\Target', direction: 'upload' })
    )
    assert.equal(result.success, false)
    assert.match(result.error ?? result.output, /windows_filename_collision/)
    assert.deepEqual(events, ['query'])
})

test('R1: upload preflight shares traversal rules and rejects unverified candidates for both transports', async (t) => {
    const root = fixture(t)
    const originalSftp = sessionManager.getSftp
    const originalExec = sessionManager.exec
    const originalCapability = sessionManager.getExternalTransferCapability
    const alias = 'case-preflight-matrix'
    t.after(() => {
        sessionManager.getSftp = originalSftp
        sessionManager.exec = originalExec
        sessionManager.getExternalTransferCapability = originalCapability
        sessionManager.sessions.delete(alias)
    })
    const cases = [
        { names: ['a.txt', 'A.txt'], collision: ['A.txt', 'a.txt'] },
        { names: ['a.txt', 'A.txt'], caseSensitive: true, writes: 2 },
        { names: ['a.txt', 'A.txt'], platform: 'posix', writes: 2, queries: 0 },
        { names: ['a.txt', 'different.txt'], writes: 2, queries: 0 },
        { names: ['a.txt', 'A.txt'], exclude: ['A.txt'], writes: 1, queries: 0 },
        { names: ['a.txt', 'A.txt'], symlink: true, writes: 1, queries: 0 },
        { names: ['a.txt', 'A.txt'], symlink: true, followSymlinks: true, collision: ['A.txt', 'a.txt'] },
        { names: ['a.txt', 'A.txt'], loop: true, followSymlinks: true, writes: 1, queries: 0 },
        { names: ['a', 'A'], directory: true, collision: ['A', 'a'] },
        { names: ['a.txt', 'A.txt'], nested: true, collision: ['A.txt', 'a.txt'] },
        { names: ['σ.txt', 'ς.txt'], collision: ['σ.txt', 'ς.txt'] },
        { names: ['中.txt', 'other.txt'], writes: 2 },
        {
            names: ['a.txt', 'A.txt'],
            reply: { success: false, exitCode: 1, stderr: 'parent missing' },
            unverified: true,
        },
        { names: ['a.txt', 'A.txt'], reply: { timedOut: true }, unverified: true },
        { names: ['a.txt', 'A.txt'], reply: { stdoutTruncated: true }, unverified: true },
        { names: ['a.txt', 'A.txt'], reply: { stderrTruncated: true }, unverified: true },
        { names: ['a.txt', 'A.txt'], stdout: '{"caseSensitive":true}', unverified: true },
        { names: ['a.txt', 'A.txt'], stdout: '{"caseSensitive":false,"collision":[]}', unverified: true },
        { names: ['a.txt', 'A.txt'], stdout: '{', unverified: true },
        { names: ['a.txt', 'A.txt'], noShell: true, unverified: true },
    ]
    for (const [index, spec] of cases.entries()) {
        for (const transport of ['sftp', 'rsync']) {
            if (transport === 'rsync' && spec.writes !== undefined) continue
            for (const dryRun of spec.writes === undefined ? [false, true] : [false]) {
                const source = path.join(root, `source-${index}-${transport}-${dryRun}`)
                fs.mkdirSync(source)
                const entries = spec.nested ? path.join(source, 'nested') : source
                if (spec.nested) {
                    fs.mkdirSync(entries)
                    fs.writeFileSync(path.join(source, 'earlier.txt'), 'must not transfer before nested checks')
                }
                fs.writeFileSync(path.join(entries, spec.names[0]), 'one')
                const second = path.join(entries, spec.names[1])
                if (spec.loop) fs.symlinkSync(entries, second, 'dir')
                else if (spec.symlink) fs.symlinkSync(path.join(entries, spec.names[0]), second, 'file')
                else if (spec.directory) fs.mkdirSync(second)
                else fs.writeFileSync(second, 'two')
                let queries = 0
                let capabilityCalls = 0
                const writes = []
                const created = []
                sessionManager.sessions.set(alias, {
                    client: {},
                    config: {
                        host: 'example.com',
                        username: 'test',
                        password: 'test',
                        remotePlatform: spec.platform ?? 'windows',
                    },
                    connected: true,
                    connectedAt: 1,
                    lastUsedAt: 1,
                    reconnectAttempts: 0,
                    manualClose: false,
                })
                sessionManager.getExternalTransferCapability = (...args) => {
                    ++capabilityCalls
                    if (transport === 'rsync')
                        throw new Error('rsync selection must not start before rejected preflight')
                    return originalCapability.apply(sessionManager, args)
                }
                sessionManager.exec = async (_alias, command, options) => {
                    ++queries
                    if (spec.queries === 0) assert.fail('no candidate must not require a shell')
                    assert.ok(options.timeout > 0)
                    const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le')
                    assert.match(script, /CreateFileW\(parent, 128, 7, IntPtr.Zero, 3, 128 \| 33554432/)
                    assert.match(script, /GetFileInformationByHandleEx\(handle, 23, out info, 4\)/)
                    assert.match(script, /CompareStringOrdinal\(left, left.Length, right, right.Length, true\)/)
                    if (spec.nested) assert.match(script, /C:\\Target\\nested/)
                    if (spec.noShell) throw new Error('shell unavailable')
                    return {
                        success: true,
                        exitCode: 0,
                        stderr: '',
                        stdout:
                            spec.stdout ??
                            JSON.stringify({
                                caseSensitive: spec.caseSensitive ?? false,
                                collision: spec.collision ?? null,
                            }),
                        ...spec.reply,
                    }
                }
                sessionManager.getSftp = async () => ({
                    stat(_name, cb) {
                        cb(null, { mode: 0o040755, size: 0 })
                    },
                    mkdir(name, cb) {
                        created.push(name)
                        cb(null)
                    },
                    createWriteStream(name) {
                        writes.push(name)
                        return new Writable({
                            write(_bytes, _encoding, cb) {
                                cb()
                            },
                        })
                    },
                    end() {},
                })
                const result = content(
                    await tools(registerFileTools).get('ssh_sync').handler({
                        alias,
                        localPath: source,
                        remotePath: 'C:\\Target',
                        direction: 'upload',
                        dryRun,
                        exclude: spec.exclude,
                        followSymlinks: spec.followSymlinks,
                    })
                )
                assert.equal(
                    result.success,
                    spec.writes !== undefined,
                    JSON.stringify({ index, transport, dryRun, result })
                )
                assert.equal(queries, spec.queries ?? 1)
                if (spec.writes === undefined) {
                    assert.match(
                        result.error ?? result.output,
                        spec.unverified ? /case_semantics_unverified/ : /windows_filename_collision/
                    )
                    assert.equal(capabilityCalls, 0)
                    assert.equal(writes.length, 0)
                    assert.equal(created.length, 0)
                } else {
                    assert.equal(writes.length, spec.writes)
                }
            }
        }
    }
})

test('R2: public UTF-16 reads reject insufficient budgets and malformed EOF without zero-progress pages', async (t) => {
    const originalSftp = sessionManager.getSftp
    const originalStyle = sessionManager.getRemotePathStyle
    sessionManager.getRemotePathStyle = () => 'posix'
    t.after(() => {
        sessionManager.getSftp = originalSftp
        sessionManager.getRemotePathStyle = originalStyle
    })
    const handler = tools(registerFileTools).get('ssh_read_file').handler
    for (const encoding of ['utf16le', 'utf16be']) {
        for (const [text, maxBytes] of [
            ['A', 1],
            ['😀A', 2],
            ['😀A', 3],
        ]) {
            const bytes = Buffer.from(text, 'utf16le')
            if (encoding === 'utf16be') bytes.swap16()
            sessionManager.getSftp = async () => remoteFile(bytes)
            const result = content(await handler({ alias: 'fixture', remotePath: '/file', encoding, maxBytes }))
            assert.equal(result.success, false, `${encoding}: ${maxBytes}`)
            assert.match(result.error, /maxBytes is too small/)
        }
        for (const bytes of [Buffer.from([0x41]), Buffer.from(encoding === 'utf16le' ? [0x00, 0xd8] : [0xd8, 0x00])]) {
            sessionManager.getSftp = async () => remoteFile(bytes)
            for (const lineRange of [undefined, '1']) {
                const result = content(
                    await handler({ alias: 'fixture', remotePath: '/file', encoding, lineRange, maxBytes: 8 })
                )
                assert.equal(result.success, false, `${encoding}: invalid EOF ${lineRange}`)
                assert.match(result.error, /Invalid/)
            }
        }
    }
})

test('R3: public line-range metadata describes only returned bytes across chunks and encodings', async (t) => {
    const originalSftp = sessionManager.getSftp
    const originalStyle = sessionManager.getRemotePathStyle
    sessionManager.getRemotePathStyle = () => 'posix'
    t.after(() => {
        sessionManager.getSftp = originalSftp
        sessionManager.getRemotePathStyle = originalStyle
    })
    const handler = tools(registerFileTools).get('ssh_read_file').handler
    for (const encoding of ['utf8', 'utf16le', 'utf16be']) {
        const width = encoding === 'utf8' ? 1 : 2
        const bytes = Buffer.from('hello\r\nworld\r\n', encoding === 'utf8' ? 'utf8' : 'utf16le')
        if (encoding === 'utf16be') bytes.swap16()
        for (const binary of [false, true]) {
            for (const split of [1, 5, bytes.length]) {
                for (const [budget, expectedEnd, terminated] of [
                    [2, 1, false],
                    [7, 1, true],
                    [9, 2, false],
                    [14, 2, true],
                ]) {
                    sessionManager.getSftp = async () => ({
                        ...remoteFile(bytes),
                        createReadStream() {
                            return Readable.from([bytes.subarray(0, split), bytes.subarray(split)])
                        },
                    })
                    const result = content(
                        await handler({
                            alias: 'fixture',
                            remotePath: '/file',
                            encoding,
                            binary,
                            lineRange: '1-2',
                            maxBytes: budget * width,
                        })
                    )
                    assert.equal(result.success, true)
                    assert.equal(result.read_bytes, budget * width)
                    assert.equal(result.line_start, 1)
                    assert.equal(result.line_end, expectedEnd, `${encoding}/${binary}/${split}/${budget}`)
                    assert.equal(result.final_line_terminated, terminated)
                }
            }
        }
    }
})

test('R2/R3: decoded prefixes, BOM progress, binary bytes, and EOF boundaries remain exact', async (t) => {
    const originalSftp = sessionManager.getSftp
    const originalStyle = sessionManager.getRemotePathStyle
    sessionManager.getRemotePathStyle = () => 'posix'
    t.after(() => {
        sessionManager.getSftp = originalSftp
        sessionManager.getRemotePathStyle = originalStyle
    })
    const handler = tools(registerFileTools).get('ssh_read_file').handler
    for (const encoding of ['utf8', 'utf16le', 'utf16be']) {
        const width = encoding === 'utf8' ? 1 : 2
        const bytes = Buffer.from('a\n😀\n', encoding === 'utf8' ? 'utf8' : 'utf16le')
        if (encoding === 'utf16be') bytes.swap16()
        sessionManager.getSftp = async () => ({
            ...remoteFile(bytes),
            createReadStream() {
                return Readable.from([...bytes].map((byte) => Buffer.from([byte])))
            },
        })
        const prefix = content(
            await handler({ alias: 'fixture', remotePath: '/file', encoding, lineRange: '1-2', maxBytes: 3 * width })
        )
        assert.equal(prefix.success, true)
        assert.equal(prefix.content, 'a\n')
        assert.equal(prefix.read_bytes, 2 * width)
        assert.equal(prefix.line_start, 1)
        assert.equal(prefix.line_end, 1)
        assert.equal(prefix.final_line_terminated, true)
        const binary = content(
            await handler({
                alias: 'fixture',
                remotePath: '/file',
                encoding,
                binary: true,
                lineRange: '1-2',
                maxBytes: 3 * width,
            })
        )
        assert.equal(binary.read_bytes, 3 * width)
        assert.equal(binary.line_end, 2)
        assert.equal(binary.final_line_terminated, false)
        assert.deepEqual(Buffer.from(binary.content_base64, 'base64'), bytes.subarray(0, 3 * width))
    }
    for (const encoding of ['utf16le', 'utf16be']) {
        const bytes = Buffer.from(String.fromCharCode(0xfeff) + 'A😀B', 'utf16le')
        if (encoding === 'utf16be') bytes.swap16()
        const requested = []
        sessionManager.getSftp = async () => ({
            ...remoteFile(bytes),
            createReadStream(_name, options) {
                requested.push(options)
                assert.ok(options.end - options.start + 1 <= 4)
                return Readable.from([bytes.subarray(options.start, options.end + 1)])
            },
        })
        const bom = content(await handler({ alias: 'fixture', remotePath: '/file', encoding, maxBytes: 2 }))
        assert.equal(bom.success, true)
        assert.equal(bom.content, '')
        assert.equal(bom.read_bytes, 2)
        assert.equal(bom.next_offset, 2)
        const first = content(
            await handler({ alias: 'fixture', remotePath: '/file', encoding, offset: bom.next_offset, maxBytes: 4 })
        )
        assert.equal(first.content, 'A')
        assert.equal(first.next_offset, 4)
        const second = content(
            await handler({ alias: 'fixture', remotePath: '/file', encoding, offset: first.next_offset, maxBytes: 4 })
        )
        assert.equal(second.content, '😀')
        assert.equal(second.next_offset, 8)
        const third = content(
            await handler({ alias: 'fixture', remotePath: '/file', encoding, offset: second.next_offset, maxBytes: 4 })
        )
        assert.equal(third.content, 'B')
        assert.equal(third.next_offset, bytes.length)
        assert.equal(third.remaining_bytes, 0)
        assert.equal(requested.length, 4)
        const invalid = Buffer.concat([Buffer.from('a\n', 'utf16le'), Buffer.from([0x41])])
        if (encoding === 'utf16be') invalid.subarray(0, 4).swap16()
        sessionManager.getSftp = async () => remoteFile(invalid)
        const malformed = content(await handler({ alias: 'fixture', remotePath: '/file', encoding, lineRange: '1-2' }))
        assert.equal(malformed.success, false)
        assert.match(malformed.error, /Invalid/)
        const lossless = content(
            await handler({ alias: 'fixture', remotePath: '/file', encoding, binary: true, lineRange: '1-2' })
        )
        assert.deepEqual(Buffer.from(lossless.content_base64, 'base64'), invalid)
        assert.equal(lossless.line_end, 2)
        assert.equal(lossless.final_line_terminated, false)
    }
    const arbitrary = Buffer.from([0x00, 0xff, 0x41, 0xd8, 0x00])
    sessionManager.getSftp = async () => remoteFile(arbitrary)
    const parts = []
    for (let offset = 0; offset < arbitrary.length; ++offset) {
        const page = content(
            await handler({
                alias: 'fixture',
                remotePath: '/file',
                binary: true,
                encoding: 'utf16le',
                maxBytes: 1,
                offset,
            })
        )
        assert.equal(page.success, true)
        assert.equal(page.read_bytes, 1)
        assert.equal(page.next_offset, offset + 1)
        parts.push(Buffer.from(page.content_base64, 'base64'))
    }
    assert.deepEqual(Buffer.concat(parts), arbitrary)
    for (const lineRange of [undefined, '1']) {
        sessionManager.getSftp = async () => remoteFile(Buffer.from([0x61, 0xff, 0x62]))
        const invalid = content(
            await handler({ alias: 'fixture', remotePath: '/file', encoding: 'utf8', maxBytes: 2, lineRange })
        )
        assert.equal(invalid.success, false)
        assert.match(invalid.error, /Invalid/)
    }
})

test('R2: a tail budget that contains only a character fragment fails instead of returning an empty success', async (t) => {
    const originalSftp = sessionManager.getSftp
    const originalStyle = sessionManager.getRemotePathStyle
    sessionManager.getRemotePathStyle = () => 'posix'
    t.after(() => {
        sessionManager.getSftp = originalSftp
        sessionManager.getRemotePathStyle = originalStyle
    })
    const handler = tools(registerFileTools).get('ssh_read_file').handler
    for (const encoding of ['utf8', 'utf16le', 'utf16be']) {
        const bytes = Buffer.from('😀', encoding === 'utf8' ? 'utf8' : 'utf16le')
        if (encoding === 'utf16be') bytes.swap16()
        sessionManager.getSftp = async () => remoteFile(bytes)
        for (const maxBytes of [1, 2, 3]) {
            const result = content(
                await handler({ alias: 'fixture', remotePath: '/file', encoding, tail: true, maxBytes })
            )
            assert.equal(result.success, false, `${encoding}/${maxBytes}`)
            assert.match(result.error, /maxBytes is too small/)
        }
    }
    sessionManager.getSftp = async () => remoteFile(Buffer.from([0x80]))
    const malformed = content(
        await handler({ alias: 'fixture', remotePath: '/file', encoding: 'utf8', tail: true, maxBytes: 8 })
    )
    assert.equal(malformed.success, false)
})

test('R4: IdentityAgent none allows password and disables environment agent across reconnect', async (t) => {
    const root = fixture(t)
    const originalConnect = Client.prototype.connect
    const oldSocket = process.env.SSH_AUTH_SOCK
    const connects = []
    process.env.SSH_AUTH_SOCK = '/nonexistent/environment-agent.sock'
    Client.prototype.connect = function (config) {
        connects.push(config)
        Promise.resolve().then(() => this.emit('ready'))
        return this
    }
    const manager = new SessionManager(path.join(root, 'sessions.json'))
    t.after(() => {
        Client.prototype.connect = originalConnect
        if (oldSocket === undefined) delete process.env.SSH_AUTH_SOCK
        else process.env.SSH_AUTH_SOCK = oldSocket
        manager.operationManager.close()
    })
    await manager.connect({
        host: 'example.com',
        port: 22,
        username: 'test',
        password: 'test',
        agent: 'none',
        alias: 'disabled',
    })
    assert.equal(connects[0].password, 'test')
    assert.equal(connects[0].agent, undefined)
    assert.equal(manager.getExternalTransferCapability('disabled').agent, 'none')
    await assert.rejects(
        manager.connect({ host: 'example.com', port: 22, username: 'test', password: 'test', alias: 'disabled' }),
        /different session configuration/
    )
    await manager.reconnect('disabled')
    assert.equal(connects[1].agent, undefined)
    await manager.connect({
        host: 'example.com',
        port: 22,
        username: 'test',
        privateKey: 'fixture-key',
        agent: 'none',
        alias: 'inline',
    })
    assert.equal(connects[2].agent, undefined)
    await assert.rejects(
        manager.connect({
            host: 'example.com',
            port: 22,
            username: 'test',
            password: 'test',
            agent: '/nonexistent/explicit.sock',
        }),
        /socket or pipe is unavailable/
    )
    manager.disconnectAll()
    await new Promise((resolve) => setTimeout(resolve, 10))
})

test('R4: public SSH config preserves none with keys, Host defaults, ProxyJump, and explicit overrides', async (t) => {
    const root = fixture(t)
    const configPath = path.join(root, 'config')
    const oldAllowed = process.env.SSH_MCP_ALLOWED_KEY_DIRS
    const oldTemplates = process.env.SSH_MCP_TEMPLATES
    const originalConnect = sessionManager.connect
    const originalInfo = sessionManager.getSessionConnectionInfo
    process.env.SSH_MCP_ALLOWED_KEY_DIRS = root
    process.env.SSH_MCP_TEMPLATES = JSON.stringify({ explicit: { agent: '/fixture/template.sock' } })
    fs.writeFileSync(
        configPath,
        `Host *\n  User tester\n  IdentityAgent none\nHost password\n  HostName example.com\nHost target\n  HostName example.com\n  IdentityFile "${path.join(root, 'key')}"\n  ProxyJump hop\nHost hop\n  HostName bastion.example.com\n  IdentityFile "${path.join(root, 'jump-key')}"\n`
    )
    const configs = []
    sessionManager.connect = async (config) => {
        configs.push(config)
        return config.alias
    }
    sessionManager.getSessionConnectionInfo = (alias) => ({
        alias,
        identity: 'tester@example.com:22',
        loginUser: 'tester',
        host: 'example.com',
        port: 22,
        defaultEnvKeys: [],
        envKeys: [],
    })
    t.after(() => {
        sessionManager.connect = originalConnect
        sessionManager.getSessionConnectionInfo = originalInfo
        if (oldAllowed === undefined) delete process.env.SSH_MCP_ALLOWED_KEY_DIRS
        else process.env.SSH_MCP_ALLOWED_KEY_DIRS = oldAllowed
        if (oldTemplates === undefined) delete process.env.SSH_MCP_TEMPLATES
        else process.env.SSH_MCP_TEMPLATES = oldTemplates
    })
    const handler = tools(registerConnectionTools).get('ssh_connect').handler
    for (const args of [
        { configHost: 'password', password: 'fixture' },
        { configHost: 'target' },
        { configHost: 'target', agent: '/fixture/explicit.sock' },
        { configHost: 'target', template: 'explicit' },
        {
            configHost: 'target',
            template: 'explicit',
            agent: '/fixture/argument.sock',
            jumpHost: { host: 'jump.example.com', user: 'other', agent: '/fixture/jump.sock' },
        },
    ]) {
        const result = content(await handler({ configPath, ...args }))
        assert.equal(result.success, true, JSON.stringify(result))
    }
    assert.equal(configs[0].agent, 'none')
    assert.equal(configs[0].password, 'fixture')
    assert.equal(configs[1].agent, 'none')
    assert.equal(configs[1].privateKeyPath, path.join(root, 'key'))
    assert.equal(configs[1].jumpHost.agent, 'none')
    assert.equal(configs[1].jumpHost.privateKeyPath, path.join(root, 'jump-key'))
    assert.equal(configs[2].agent, '/fixture/explicit.sock')
    assert.equal(configs[3].agent, '/fixture/template.sock')
    assert.equal(configs[4].agent, '/fixture/argument.sock')
    assert.equal(configs[4].jumpHost.agent, '/fixture/jump.sock')
})

test('R1/R4: sensitive Windows upload reaches rsync while IdentityAgent none removes the environment socket', async (t) => {
    if (process.platform === 'win32') {
        t.skip('POSIX fake process fixture; native Windows rsync requires a Windows runner')
        return
    }
    const root = fixture(t)
    const bin = path.join(root, 'bin')
    const source = path.join(root, 'source')
    fs.mkdirSync(bin)
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'a.txt'), 'one')
    fs.writeFileSync(path.join(source, 'A.txt'), 'two')
    const keyPath = path.join(root, 'key')
    fs.writeFileSync(keyPath, 'fixture-key', { mode: 0o600 })
    const record = path.join(root, 'calls')
    const script =
        '#!/bin/sh\n[ "${SSH_AUTH_SOCK+x}" != x ] || exit 91\nprintf "%s\\n" "$0 $*" >> "$MCP_TEST_PROCESS_RECORD"\nexit 0\n'
    for (const name of ['ssh', 'rsync']) fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 })
    const previous = {
        PATH: process.env.PATH,
        SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
        MCP_TEST_PROCESS_RECORD: process.env.MCP_TEST_PROCESS_RECORD,
    }
    process.env.PATH = `${bin}${path.delimiter}${previous.PATH ?? ''}`
    process.env.SSH_AUTH_SOCK = '/fixture/environment.sock'
    process.env.MCP_TEST_PROCESS_RECORD = record
    const alias = 'sensitive-case-rsync'
    const originalExec = sessionManager.exec
    const originalSftp = sessionManager.getSftp
    const commands = []
    sessionManager.sessions.set(alias, {
        client: {},
        config: {
            host: 'example.com',
            username: 'tester',
            privateKeyPath: keyPath,
            agent: 'none',
            remotePlatform: 'windows',
            commandShell: 'powershell',
            remotePathStyle: 'sftp-posix',
            rsyncProfile: 'msys2',
        },
        connected: true,
        connectedAt: 1,
        lastUsedAt: 1,
        reconnectAttempts: 0,
        manualClose: false,
    })
    sessionManager.exec = async (_alias, command) => {
        commands.push(command)
        if (command.includes('-EncodedCommand')) {
            const decoded = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le')
            assert.match(decoded, /\$parent = 'C:\\Target'/)
            return { success: true, stdout: '{"caseSensitive":true,"collision":null}', stderr: '', exitCode: 0 }
        }
        return { success: true, stdout: 'rsync', stderr: '', exitCode: 0 }
    }
    sessionManager.getSftp = async () => {
        assert.fail('accepted rsync path must not fall back to SFTP')
    }
    t.after(() => {
        sessionManager.exec = originalExec
        sessionManager.getSftp = originalSftp
        sessionManager.sessions.delete(alias)
        clearRsyncCache(alias)
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
    })
    const capability = sessionManager.getExternalTransferCapability(alias)
    assert.equal(capability.rsyncEligible, true)
    assert.equal(capability.agent, 'none')
    const result = content(
        await tools(registerFileTools)
            .get('ssh_sync')
            .handler({ alias, localPath: source, remotePath: '/C:/Target', direction: 'upload' })
    )
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(result.selectedTransport, 'rsync')
    assert.equal(commands.length, 2)
    const calls = fs.readFileSync(record, 'utf8')
    assert.match(calls, /IdentityAgent=none/)
    assert.match(calls, /-i /)
    assert.match(calls, /rsync -avz/)
    assert.equal(process.env.SSH_AUTH_SOCK, '/fixture/environment.sock')
})

test('S8: rsync transfer failure never replays a possibly partial transfer via SFTP', async (t) => {
    if (process.platform === 'win32') {
        t.skip('POSIX fake executable fixture; Windows-native rsync needs Windows runner')
        return
    }
    const dir = fixture(t)
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    const source = path.join(dir, 'source.txt')
    fs.writeFileSync(source, 'data')
    fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nexit 0\n')
    fs.writeFileSync(path.join(bin, 'rsync'), '#!/bin/sh\nexit 12\n')
    fs.chmodSync(path.join(bin, 'ssh'), 0o755)
    fs.chmodSync(path.join(bin, 'rsync'), 0o755)
    const oldPath = process.env.PATH
    const originalExec = sessionManager.exec
    const originalCapability = sessionManager.getExternalTransferCapability
    const originalSftp = sessionManager.getSftp
    let sftpCalls = 0
    process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`
    sessionManager.exec = async () => ({ success: true, stdout: '/usr/bin/rsync', stderr: '', exitCode: 0 })
    sessionManager.getExternalTransferCapability = () => ({
        alias: 'no-replay',
        host: 'example.com',
        port: 22,
        username: 'tester',
        identity: 'tester@example.com:22',
        authMethod: 'agent',
        hasJumpHost: false,
        routeSafeForOpenSsh: true,
        rsyncEligible: true,
        decisionReason: 'direct_ssh_agent_socket',
        commandShell: 'posix',
        remotePathStyle: 'posix',
    })
    sessionManager.getSftp = async () => {
        ++sftpCalls
        throw new Error('second transfer must not start')
    }
    t.after(() => {
        sessionManager.exec = originalExec
        sessionManager.getExternalTransferCapability = originalCapability
        sessionManager.getSftp = originalSftp
        clearRsyncCache('no-replay')
        if (oldPath === undefined) delete process.env.PATH
        else process.env.PATH = oldPath
    })
    const result = await syncFiles('no-replay', source, '/remote/target.txt', 'upload')
    assert.equal(result.success, false)
    assert.equal(result.operationStatus, 'unknown')
    assert.equal(result.fallbackReason, 'rsync_operation_failed')
    assert.equal(sftpCalls, 0)
})
