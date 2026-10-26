import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { clearTimeout } from 'node:timers'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-openssh-test-'))
process.env.HOME = root
process.env.SSH_MCP_ALLOWED_KEY_DIRS = root
const { SessionManager, sessionManager } = await import('../dist/session-manager.js')
const { resolveOpenSshConfig } = await import('../dist/openssh.js')
const { registerConnectionTools } = await import('../dist/tools/connection.js')
const { registerFileTools } = await import('../dist/tools/file.js')
const { registerExecTools } = await import('../dist/tools/exec.js')

function run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
}

async function waitFor(predicate, description) {
    const end = Date.now() + 10_000
    while (!predicate()) {
        if (Date.now() > end) throw new Error(`Timed out waiting for ${description}`)
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
}

async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000)
    await exited
    clearTimeout(timer)
}

async function fixture(t) {
    const directory = fs.mkdtempSync(path.join(root, 'fixture-'))
    const user = os.userInfo().username
    const serverKey = path.join(directory, 'server-key')
    const key = path.join(directory, 'key')
    run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', serverKey])
    run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
    fs.copyFileSync(`${key}.pub`, path.join(directory, 'authorized_keys'))
    const { createServer } = await import('node:net')
    const reservation = createServer()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const port = reservation.address().port
    await new Promise((resolve) => reservation.close(resolve))
    const serverConfig = path.join(directory, 'sshd_config')
    fs.writeFileSync(
        serverConfig,
        [
            `Port ${port}`,
            'ListenAddress 127.0.0.1',
            `HostKey ${serverKey}`,
            `AuthorizedKeysFile ${directory}/authorized_keys`,
            `PidFile ${directory}/sshd.pid`,
            'PasswordAuthentication no',
            'KbdInteractiveAuthentication no',
            'UsePAM no',
            'StrictModes no',
            `AllowUsers ${user}`,
            'LogLevel VERBOSE',
            'Subsystem sftp internal-sftp',
        ].join('\n') + '\n'
    )
    const server = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', serverConfig], { stdio: ['ignore', 'ignore', 'pipe'] })
    let serverLog = ''
    server.stderr.on('data', (chunk) => {
        serverLog += chunk
    })
    t.after(async () => {
        await stop(server)
    })
    await waitFor(() => serverLog.includes('Server listening') || server.exitCode !== null, 'loopback sshd')
    assert.equal(server.exitCode, null, serverLog)
    const configPath = path.join(directory, 'ssh_config')
    const controlPath = path.join(directory, 'master')
    fs.writeFileSync(
        configPath,
        [
            'Host fixture',
            '  HostName 127.0.0.1',
            `  Port ${port}`,
            `  User ${user}`,
            `  IdentityFile ${key}`,
            '  IdentitiesOnly yes',
            '  IdentityAgent none',
            '  StrictHostKeyChecking no',
            `  UserKnownHostsFile ${directory}/known_hosts`,
            `  ControlPath ${controlPath}`,
            '  ControlMaster auto',
            '  ControlPersist no',
        ].join('\n') + '\n'
    )
    const master = spawn('ssh', ['-F', configPath, '-M', '-N', 'fixture'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let masterLog = ''
    master.stderr.on('data', (chunk) => {
        masterLog += chunk
    })
    t.after(async () => {
        await stop(master)
    })
    await waitFor(() => fs.existsSync(controlPath) || master.exitCode !== null, 'test master socket')
    assert.equal(master.exitCode, null, masterLog + serverLog)
    const resolved = await resolveOpenSshConfig({ configHost: 'fixture', configPath })
    return { directory, user, port, configPath, controlPath, master, resolved, log: () => serverLog }
}

test(
    'OpenSSH master reuses commands, preserves bytes and remote exit 255, and owns only alias channels',
    { skip: process.platform !== 'linux' },
    async (t) => {
        const f = await fixture(t)
        const manager = new SessionManager(path.join(f.directory, 'sessions.json'))
        t.after(() => manager.disconnectAll())
        await manager.connect({ backend: 'openssh', ...f.resolved, alias: 'one', env: { MCP_FIXTURE: 'session' } })
        await manager.connect({ backend: 'openssh', ...f.resolved, alias: 'two' })
        assert.equal(manager.getSessionConnectionInfo('one').masterReused, true)
        assert.equal(manager.getSessionConnectionInfo('one').identityStatus, 'master_trusted')
        assert.equal(manager.getSessionConnectionInfo('one').observedLogin.username, f.user)
        const results = await Promise.all([
            manager.exec('one', `printf '%s\\n' "$MCP_FIXTURE"; pwd; printf 'no newline' >&2`, { cwd: f.directory }),
            manager.exec('one', 'printf remote; exit 255'),
        ])
        assert.equal(results[0].stdout, `session\n${f.directory}\n`)
        assert.equal(results[0].stderr, 'no newline')
        assert.equal(results[1].stdout, 'remote')
        assert.equal(results[1].exitCode, 255)
        assert.equal(results[1].failureKind, 'remote_command')
        assert.equal(manager.disconnect('one'), true)
        assert.equal((await manager.exec('two', 'printf remaining')).stdout, 'remaining')
        assert.equal(f.master.exitCode, null)
        assert.equal((f.log().match(/Accepted publickey/g) ?? []).length, 1)
        await assert.rejects(async () => manager.getSftp('two'), /does not support SFTP/)
    }
)

test(
    'OpenSSH MCP connection schema selects the backend and refuses new authentication',
    { skip: process.platform !== 'linux' },
    async (t) => {
        const f = await fixture(t)
        const handlers = new Map()
        registerConnectionTools({
            registerTool: (name, definition, handler) => handlers.set(name, { definition, handler }),
        })
        t.after(() => sessionManager.disconnectAll())
        const entry = handlers.get('ssh_connect')
        const args = entry.definition.inputSchema.parse({
            backend: 'openssh',
            configHost: 'fixture',
            configPath: f.configPath,
            alias: 'public',
        })
        const response = JSON.parse((await entry.handler(args)).content[0].text)
        assert.equal(response.success, true, JSON.stringify(response))
        assert.equal(response.backend, 'openssh')
        assert.equal(response.masterReused, true)
        assert.equal(response.identityStatus, 'master_trusted')
        const rejected = JSON.parse(
            (await entry.handler({ ...args, password: 'fixture-not-used', alias: 'invalid' })).content[0].text
        )
        assert.equal(rejected.success, false)
        assert.equal(rejected.details.code, 'unsupported_backend')
        registerExecTools({
            registerTool: (name, definition, handler) => handlers.set(name, { definition, handler }),
        })
        const script = handlers.get('ssh_exec_script')
        const originalExec = sessionManager.exec
        let execCalls = 0
        sessionManager.exec = function (...parameters) {
            ++execCalls
            return originalExec.apply(this, parameters)
        }
        t.after(() => {
            sessionManager.exec = originalExec
        })
        const unsupported = JSON.parse(
            (await script.handler(script.definition.inputSchema.parse({ alias: 'public', script: 'printf never' })))
                .content[0].text
        )
        assert.equal(unsupported.success, false)
        assert.equal(unsupported.details.code, 'unsupported_backend')
        assert.equal(unsupported.details.capability, 'script_upload')
        assert.equal(execCalls, 0)
    }
)

test(
    'OpenSSH runs two commands and verified directory sync concurrently, and cancels only one operation',
    { skip: process.platform !== 'linux' },
    async (t) => {
        const f = await fixture(t)
        t.after(() => sessionManager.disconnectAll())
        await sessionManager.connect({ backend: 'openssh', ...f.resolved, alias: 'parallel' })
        const source = path.join(f.directory, 'source')
        const target = path.join(f.directory, "remote quoted's")
        fs.mkdirSync(path.join(source, 'nested'), { recursive: true })
        fs.writeFileSync(path.join(source, 'nested', 'binary\nfile.bin'), Buffer.from([0, 255, 128, 1, 2, 3]))
        fs.writeFileSync(path.join(source, '中文 file.txt'), 'verified content')
        const handlers = new Map()
        registerFileTools({ registerTool: (name, definition, handler) => handlers.set(name, { definition, handler }) })
        const sync = handlers.get('ssh_sync')
        const [first, second, transfer] = await Promise.all([
            sessionManager.exec('parallel', 'sleep .1; printf first'),
            sessionManager.exec('parallel', 'sleep .1; printf second'),
            sync.handler(
                sync.definition.inputSchema.parse({
                    alias: 'parallel',
                    localPath: source,
                    remotePath: target,
                    direction: 'upload',
                    verify: { sha256: true, count: true, owner: true, mode: true },
                })
            ),
        ])
        assert.equal(first.stdout, 'first')
        assert.equal(second.stdout, 'second')
        const result = JSON.parse(transfer.content[0].text)
        assert.equal(result.success, true, JSON.stringify(result))
        assert.equal(result.method, 'rsync')
        assert.equal(result.verificationStatus, 'matched')
        assert.equal(result.verification.kind, 'directory')
        assert.deepEqual(
            fs.readFileSync(path.join(target, 'nested', 'binary\nfile.bin')),
            Buffer.from([0, 255, 128, 1, 2, 3])
        )
        const cancelled = await sessionManager.operationStart('parallel', 'sleep 30')
        const remaining = await sessionManager.operationStart('parallel', 'sleep .3; printf continued')
        await waitFor(
            () => sessionManager.operationStatus(cancelled.operationId).markerVerified,
            'operation identity marker'
        )
        assert.equal((await sessionManager.operationCancel(cancelled.operationId)).success, true)
        await waitFor(
            () => sessionManager.operationStatus(remaining.operationId).finishedAt !== null,
            'independent operation completion'
        )
        assert.equal(sessionManager.operationStatus(remaining.operationId).status, 'completed')
        assert.equal(sessionManager.operationRead(remaining.operationId).stdout, 'continued')
        assert.equal((f.log().match(/Accepted publickey/g) ?? []).length, 1)
    }
)

test(
    'OpenSSH explicit single-file verification handles file and directory destinations in both directions',
    { skip: process.platform !== 'linux' },
    async (t) => {
        const f = await fixture(t)
        t.after(() => sessionManager.disconnectAll())
        await sessionManager.connect({ backend: 'openssh', ...f.resolved, alias: 'files' })
        const handlers = new Map()
        registerFileTools({ registerTool: (name, definition, handler) => handlers.set(name, { definition, handler }) })
        const sync = handlers.get('ssh_sync')
        for (const content of ['', 'single-file content']) {
            for (const direction of ['upload', 'download']) {
                for (const directoryTarget of [false, true]) {
                    const source = path.join(f.directory, `source-${direction}-${directoryTarget}-${content.length}`)
                    const destination = `${source}-target`
                    fs.writeFileSync(source, content, { mode: 0o640 })
                    if (directoryTarget) fs.mkdirSync(destination)
                    const args = {
                        alias: 'files',
                        localPath: direction === 'upload' ? source : destination,
                        remotePath: direction === 'upload' ? destination : source,
                        direction,
                        verify: { sha256: true, owner: true, mode: true },
                    }
                    const result = JSON.parse(
                        (await sync.handler(sync.definition.inputSchema.parse(args))).content[0].text
                    )
                    assert.equal(result.success, true, JSON.stringify({ args, result }))
                    assert.equal(result.transferSuccess, true)
                    assert.equal(result.verificationStatus, 'matched')
                    assert.equal(result.verification.kind, 'single_file')
                    assert.equal(result.verification.local.sha256, result.verification.remote.sha256)
                    const target = directoryTarget ? path.join(destination, path.basename(source)) : destination
                    assert.equal(fs.readFileSync(target, 'utf8'), content)
                }
            }
        }
        const source = path.join(f.directory, 'budget-source')
        const destination = path.join(f.directory, 'must-not-create')
        fs.writeFileSync(source, 'too large')
        for (const verify of [{ sha256: true, maxFileBytes: 1 }, { count: true }]) {
            const result = JSON.parse(
                (
                    await sync.handler({
                        alias: 'files',
                        localPath: source,
                        remotePath: destination,
                        direction: 'upload',
                        verify,
                    })
                ).content[0].text
            )
            assert.equal(result.success, false)
            assert.equal(result.transferSuccess, false)
            assert.equal(fs.existsSync(destination), false)
        }
    }
)

test(
    'OpenSSH master loss after validation never attempts another network connection',
    { skip: process.platform !== 'linux' },
    async (t) => {
        const f = await fixture(t)
        const moduleUrl = new URL('../dist/session-manager.js', import.meta.url).href
        const script = `import fs from 'node:fs'; import assert from 'node:assert/strict'; import {SessionManager} from ${JSON.stringify(moduleUrl)};
        const manager = new SessionManager(${JSON.stringify(path.join(f.directory, 'race-sessions.json'))});
        await manager.connect(${JSON.stringify({ backend: 'openssh', ...f.resolved, alias: 'race' })});
        const connection = manager.getOpenSshConnection('race');
        const original = connection.arguments.bind(connection);
        connection.arguments = () => { const args = original(); fs.unlinkSync(${JSON.stringify(f.controlPath)}); return args; };
        await assert.rejects(connection.consume('printf must-not-execute', () => {}, 3000), /without a remote exit status/);
        await manager.disconnectAll();
        process.stdout.write('race-failed-without-new-connection');`
        const result = spawnSync(
            'strace',
            ['-f', '-e', 'trace=connect,execve', process.execPath, '--input-type=module', '-e', script],
            { encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOME: root } }
        )
        assert.ifError(result.error)
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /race-failed-without-new-connection/)
        assert.match(result.stderr, /AF_UNIX/)
        assert.match(result.stderr, /execve\("\/bin\/false"/)
        assert.doesNotMatch(result.stderr, /sa_family=AF_INET6?[,}]/)
        assert.equal((f.log().match(/Accepted publickey/g) ?? []).length, 1)
        assert.equal(f.master.exitCode, null)
    }
)

test(
    'download symlink verification gives a direction-correct recovery action',
    { skip: process.platform !== 'linux' },
    async (t) => {
        const f = await fixture(t)
        t.after(() => sessionManager.disconnectAll())
        await sessionManager.connect({ backend: 'openssh', ...f.resolved, alias: 'links' })
        const source = path.join(f.directory, 'remote-links')
        const target = path.join(f.directory, 'download-links')
        fs.mkdirSync(source)
        fs.writeFileSync(path.join(source, 'file'), 'content')
        fs.symlinkSync('file', path.join(source, 'link'))
        const handlers = new Map()
        registerFileTools({ registerTool: (name, _definition, handler) => handlers.set(name, handler) })
        const result = JSON.parse(
            (
                await handlers.get('ssh_sync')({
                    alias: 'links',
                    localPath: target,
                    remotePath: source,
                    direction: 'download',
                    verify: { sha256: true, count: true },
                })
            ).content[0].text
        )
        assert.equal(result.transferSuccess, true, JSON.stringify(result))
        assert.equal(result.success, false)
        assert.equal(result.verificationStatus, 'skipped')
        assert.match(result.verification.suggestion, /排除符号链接/)
        assert.doesNotMatch(result.verification.reason, /set followSymlinks=true/)
        assert.equal(fs.existsSync(path.join(target, 'link')), false)
    }
)

test(
    'public stdio MCP uses the selected master and leaves user terminal channels alive after exit',
    { skip: process.platform !== 'linux' },
    async (t) => {
        const f = await fixture(t)
        const client = new Client({ name: 'openssh-regression', version: '1.0.0' })
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
            env: { ...process.env, HOME: path.join(f.directory, 'mcp-home') },
            stderr: 'pipe',
        })
        let stderr = ''
        transport.stderr?.on('data', (chunk) => {
            stderr += chunk
        })
        t.after(() => client.close())
        await client.connect(transport)
        const tools = await client.listTools()
        assert.ok(tools.tools.find((entry) => entry.name === 'ssh_connect').inputSchema.properties.backend)
        const call = async (name, args) => {
            const response = await client.callTool({ name, arguments: args })
            const data = JSON.parse(response.content[0].text)
            assert.equal(response.isError, undefined, JSON.stringify(data) + stderr)
            return data
        }
        const connected = await call('ssh_connect', {
            backend: 'openssh',
            configHost: 'fixture',
            configPath: f.configPath,
            alias: 'stdio',
        })
        assert.equal(connected.masterReused, true)
        assert.equal(connected.identityStatus, 'master_trusted')
        const source = path.join(f.directory, 'stdio-source')
        const target = path.join(f.directory, 'stdio-target')
        fs.writeFileSync(source, 'stdio content')
        const [one, two, synced] = await Promise.all([
            call('ssh_exec', { alias: 'stdio', command: 'sleep .1; printf first' }),
            call('ssh_exec', { alias: 'stdio', command: 'sleep .1; printf second' }),
            call('ssh_sync', {
                alias: 'stdio',
                localPath: source,
                remotePath: target,
                direction: 'upload',
                verify: { sha256: true },
            }),
        ])
        assert.equal(one.stdout, 'first')
        assert.equal(two.stdout, 'second')
        assert.equal(synced.verificationStatus, 'matched')
        const operation = await call('ssh_operation_start', { alias: 'stdio', command: 'sleep 30' })
        assert.ok(operation.operationId)
        const terminal = spawn('ssh', ['-F', f.configPath, 'fixture', 'sleep .2; printf user-terminal-alive'], {
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        let terminalOutput = ''
        terminal.stdout.on('data', (chunk) => {
            terminalOutput += chunk
        })
        const terminalExit = once(terminal, 'exit')
        await client.close()
        assert.equal(f.master.exitCode, null)
        assert.equal((await terminalExit)[0], 0)
        assert.equal(terminalOutput, 'user-terminal-alive')
        assert.equal((f.log().match(/Accepted publickey/g) ?? []).length, 1)
    }
)

test(
    'public stdio SFTP directory filters and pages preserve full verified downloads and OpenSSH limits',
    { skip: process.platform !== 'linux' },
    async (t) => {
        const f = await fixture(t)
        const source = path.join(f.directory, 'listed')
        const target = path.join(f.directory, 'downloaded')
        fs.mkdirSync(path.join(source, 'z-directory'), { recursive: true })
        fs.writeFileSync(path.join(source, 'z-directory', 'nested.txt'), 'nested content')
        const epoch = Date.parse('2026-01-01T00:00:00Z') / 1000
        for (let index = 0; index < 120; ++index) {
            const file = path.join(source, `file-${String(index).padStart(3, '0')}.log`)
            fs.writeFileSync(file, `fixture ${index}`)
            fs.utimesSync(file, epoch + index, epoch + index)
        }
        fs.writeFileSync(path.join(source, '.hidden.log'), 'hidden content')
        fs.writeFileSync(path.join(source, '中文😀"line\n.txt'), 'unicode content')
        const client = new Client({ name: 'directory-regression', version: '1.0.0' })
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
            env: {
                PATH: process.env.PATH,
                HOME: path.join(f.directory, 'mcp-home'),
                SSH_MCP_ALLOWED_KEY_DIRS: root,
            },
            stderr: 'pipe',
        })
        let stderr = ''
        transport.stderr?.on('data', (chunk) => {
            stderr += chunk
        })
        t.after(() => client.close())
        await client.connect(transport)
        const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
        assert.deepEqual(client.getServerVersion(), { name: 'mcp-ssh', version })
        const tool = (await client.listTools()).tools.find((tool) => tool.name === 'ssh_list_dir')
        for (const field of ['namePattern', 'modifiedAfter', 'modifiedBefore', 'offset', 'limit', 'maxBytes']) {
            assert.ok(tool.inputSchema.properties[field], field)
        }
        const call = async (name, args) => {
            const response = await client.callTool({ name, arguments: args })
            const data = JSON.parse(response.content[0].text)
            assert.equal(response.isError, undefined, JSON.stringify(data) + stderr)
            assert.equal(data.success, true, JSON.stringify(data) + stderr)
            return { response, data }
        }
        const connected = await call('ssh_connect', {
            configHost: 'fixture',
            configPath: f.configPath,
            alias: 'sftp',
            agent: 'none',
            rsyncExecutable: path.join(f.directory, 'missing-rsync'),
        })
        assert.notEqual(connected.data.backend, 'openssh')
        const legacy = (await call('ssh_list_dir', { alias: 'sftp', remotePath: source })).data
        assert.equal(legacy.count, 122)
        assert.equal(legacy.has_more, undefined)
        const defaults = await call('ssh_list_dir', { alias: 'sftp', remotePath: source, namePattern: '*' })
        assert.equal(defaults.data.count, 100)
        assert.equal(defaults.data.next_offset, 100)
        assert.ok(Buffer.byteLength(defaults.response.content[0].text, 'utf8') <= 65536)
        const query = {
            alias: 'sftp',
            remotePath: source,
            namePattern: '*.log',
            modifiedAfter: '2026-01-01T00:00:05Z',
            modifiedBefore: '2026-01-01T08:00:08+08:00',
            limit: 2,
            maxBytes: 4096,
        }
        const first = (await call('ssh_list_dir', query)).data
        const second = (await call('ssh_list_dir', { ...query, offset: first.next_offset })).data
        assert.deepEqual(
            [...first.files, ...second.files].map((file) => file.name),
            ['file-005.log', 'file-006.log', 'file-007.log']
        )
        assert.equal(first.has_more, true)
        assert.equal(second.has_more, false)
        assert.equal(second.next_offset, 3)
        const oversized = await client.callTool({
            name: 'ssh_list_dir',
            arguments: { ...query, offset: 1, maxBytes: 1 },
        })
        assert.equal(oversized.isError, true)
        assert.equal(JSON.parse(oversized.content[0].text).next_offset, 1)
        const downloaded = (
            await call('ssh_sync', {
                alias: 'sftp',
                remotePath: source,
                localPath: target,
                direction: 'download',
                verify: { count: true, sha256: true, staleFiles: true },
            })
        ).data
        assert.equal(downloaded.method, 'sftp')
        assert.equal(downloaded.filesTransferred, 123)
        assert.equal(downloaded.verificationStatus, 'matched')
        assert.equal(fs.readdirSync(target).length, 123)
        assert.equal(fs.readFileSync(path.join(target, 'file-119.log'), 'utf8'), 'fixture 119')
        assert.equal(fs.readFileSync(path.join(target, '.hidden.log'), 'utf8'), 'hidden content')
        assert.equal(fs.readFileSync(path.join(target, 'z-directory', 'nested.txt'), 'utf8'), 'nested content')
        await call('ssh_connect', {
            backend: 'openssh',
            configHost: 'fixture',
            configPath: f.configPath,
            alias: 'master',
        })
        const unsupported = await client.callTool({
            name: 'ssh_list_dir',
            arguments: { alias: 'master', remotePath: source, limit: 1 },
        })
        assert.equal(unsupported.isError, true)
        assert.equal(JSON.parse(unsupported.content[0].text).details.code, 'unsupported_backend')
        await client.close()
        assert.equal(f.master.exitCode, null)
        assert.equal((f.log().match(/Accepted publickey/g) ?? []).length, 2)
        t.diagnostic(
            JSON.stringify({
                server: client.getServerVersion(),
                backend: connected.data.backend ?? 'ssh2',
                filteredNames: [...first.files, ...second.files].map((file) => file.name),
                downloadedFiles: downloaded.filesTransferred,
                verificationStatus: downloaded.verificationStatus,
                testMasterAlive: f.master.exitCode === null,
            })
        )
    }
)

test.after(async () => {
    await sessionManager.disconnectAll()
    await new Promise((resolve) => setTimeout(resolve, 50))
    fs.rmSync(root, { recursive: true, force: true })
})
