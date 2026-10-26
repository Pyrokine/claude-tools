import assert from 'node:assert/strict'
import { exec as execCallback, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import { promisify } from 'node:util'
import { classifyCommandRisk } from '../dist/command-risk.js'
import {
    createRemoteDirectoryManifest,
    compareDirectoryManifests,
    createLocalDirectoryManifest,
    matchesDirectoryExclude,
} from '../dist/directory-verification.js'
import {
    checkRsync,
    clearRsyncCache,
    downloadFile,
    getFileInfo,
    listDir,
    mkdir,
    readFile,
    syncFiles,
    uploadFile,
} from '../dist/file-ops.js'
import { formatFileMode, formatFilePermissions, parseExpectedFileMode } from '../dist/file-mode.js'
import { sessionManager, SessionManager } from '../dist/session-manager.js'
import { registerExecTools } from '../dist/tools/exec.js'
import { createAtomicUploadPath, registerFileTools } from '../dist/tools/file.js'
import { dynamicSshPortSchema, sshPortSchema } from '../dist/tools/schema.js'
import { buildTransferOutcome } from '../dist/transfer-outcome.js'

const exec = promisify(execCallback)

// File-operation fixtures replace getSftp without opening a real SessionManager connection.
const originalPathStyle = sessionManager.getRemotePathStyle.bind(sessionManager)
const originalPlatform = sessionManager.getRemotePlatform.bind(sessionManager)
sessionManager.getRemotePathStyle = (alias) => (sessionManager.sessions.has(alias) ? originalPathStyle(alias) : 'posix')
sessionManager.getRemotePlatform = (alias) => (sessionManager.sessions.has(alias) ? originalPlatform(alias) : 'posix')

function makeTempDir(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ssh-test-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    return directory
}

function fixtureSftp() {
    const read = new Set()
    const callStat = (method) => (remotePath, callback) => {
        try {
            const stats = fs[method](remotePath)
            callback(null, { mode: stats.mode, size: stats.size, uid: stats.uid })
        } catch (error) {
            callback(error)
        }
    }
    return {
        stat: callStat('statSync'),
        lstat: callStat('lstatSync'),
        realpath(remotePath, callback) {
            callback(null, fs.realpathSync(remotePath))
        },
        opendir(remotePath, callback) {
            callback(null, Buffer.from(remotePath))
        },
        readdir(handle, callback) {
            const directory = handle.toString()
            if (read.has(directory)) {
                callback(Object.assign(new Error('EOF'), { code: 1 }))
                return
            }
            read.add(directory)
            callback(
                null,
                fs.readdirSync(directory).map((filename) => ({ filename, attrs: {} }))
            )
        },
        close(_handle, callback) {
            callback(null)
        },
        createReadStream(remotePath) {
            return fs.createReadStream(remotePath)
        },
    }
}

test('remote directory manifests continue after empty READDIR pages', async (t) => {
    const directory = makeTempDir(t)
    fs.writeFileSync(path.join(directory, 'after-empty.txt'), 'retained')
    const sftp = fixtureSftp()
    const readDirectory = sftp.readdir.bind(sftp)
    let reads = 0
    sftp.readdir = (handle, callback) => {
        if (++reads <= 2) {
            callback(null, [])
        } else {
            readDirectory(handle, callback)
        }
    }
    const result = await createRemoteDirectoryManifest(sftp, directory, { count: true, sha256: true })
    assert.equal(result.count, 2)
    assert.equal(result.entries[1].path, 'after-empty.txt')
    assert.equal(reads, 4)
})

test('SFTP reads preserve U+FEFF at nonzero offsets and later line starts', async (t) => {
    const directory = makeTempDir(t)
    const localPath = path.join(directory, 'bom.txt')
    fs.writeFileSync(localPath, '﻿first\n﻿second\n')
    const originalGetSftp = sessionManager.getSftp
    sessionManager.getSftp = async () => ({
        ...fixtureSftp(),
        createReadStream(remotePath, options) {
            return fs.createReadStream(remotePath, options)
        },
        end() {},
    })
    t.after(() => {
        sessionManager.getSftp = originalGetSftp
    })
    const full = await readFile('unused', localPath, { encoding: 'utf8' })
    assert.equal(full.content, 'first\n﻿second\n')
    const offset = Buffer.byteLength('﻿first\n')
    const page = await readFile('unused', localPath, { offset, encoding: 'utf8' })
    assert.equal(page.content, '﻿second\n')
    const line = await readFile('unused', localPath, { lineRange: '2', encoding: 'utf8' })
    assert.equal(line.content, '﻿second\n')
    for (const bigEndian of [false, true]) {
        const utf16 = Buffer.from('﻿A﻿B', 'utf16le')
        if (bigEndian) utf16.swap16()
        fs.writeFileSync(localPath, utf16)
        const page = await readFile('unused', localPath, { offset: 4 })
        assert.equal(page.encoding, bigEndian ? 'utf16be' : 'utf16le')
        assert.equal(page.content, '﻿B')
        for (const encoding of ['auto', bigEndian ? 'utf16be' : 'utf16le']) {
            await assert.rejects(() => readFile('unused', localPath, { offset: 3, maxBytes: 4, encoding }), /boundary/)
        }
    }
})

test('failed recursive upload retains successful parent-directory statistics', async (t) => {
    const directory = makeTempDir(t)
    const source = path.join(directory, 'source')
    const target = path.join(directory, 'target')
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(source, 'done.txt'), 'retained')
    fs.writeFileSync(path.join(source, 'nested', 'fail.txt'), 'failure')
    const originalGetSftp = sessionManager.getSftp
    const originalCapability = sessionManager.getExternalTransferCapability
    sessionManager.getExternalTransferCapability = () => ({ rsyncEligible: false, decisionReason: 'fixture_sftp' })
    sessionManager.getSftp = async () => ({
        stat(remotePath, callback) {
            fs.stat(remotePath, callback)
        },
        mkdir(remotePath, attributes, callback = attributes) {
            fs.mkdir(remotePath, { recursive: true }, callback)
        },
        createWriteStream(remotePath, options) {
            if (remotePath.endsWith('/fail.txt')) {
                return new Writable({
                    write(_chunk, _encoding, callback) {
                        callback(new Error('fixture upload failed'))
                    },
                })
            }
            return fs.createWriteStream(remotePath, options)
        },
        end() {},
    })
    t.after(() => {
        sessionManager.getSftp = originalGetSftp
        sessionManager.getExternalTransferCapability = originalCapability
    })
    const result = await syncFiles('fixture', source, target, 'upload')
    assert.equal(result.success, false)
    assert.equal(result.filesTransferred, 1, JSON.stringify(result))
    assert.equal(result.bytesTransferred, Buffer.byteLength('retained'))
    assert.deepEqual(result.stats, { added: 1, updated: 0, deleted: 0, skipped: 0, failed: 1 })
    assert.match(result.output, /fixture upload failed/)
    assert.equal(fs.readFileSync(path.join(target, 'done.txt'), 'utf8'), 'retained')
})

test('upload timeout bounds metadata, digest, and failed verification cleanup', async (t) => {
    const directory = makeTempDir(t)
    const localPath = path.join(directory, 'source.txt')
    fs.writeFileSync(localPath, 'payload')
    const handlers = new Map()
    registerFileTools({ registerTool: (name, _definition, handler) => handlers.set(name, handler) })
    const originalGetSftp = sessionManager.getSftp
    t.after(() => {
        sessionManager.getSftp = originalGetSftp
    })
    for (const phase of ['metadata', 'digest', 'cleanup']) {
        const streams = new Set()
        sessionManager.getSftp = async () => ({
            _extensions: { 'posix-rename@openssh.com': '1' },
            stat(remotePath, callback) {
                if (phase === 'metadata' && remotePath === '/remote/target.txt') {
                    return
                }
                callback(null, {
                    size: phase === 'cleanup' ? 0 : 7,
                    mode: 0o100600,
                    uid: 1,
                    gid: 1,
                    mtime: 0,
                    atime: 0,
                })
            },
            createWriteStream() {
                return new Writable({
                    write(_chunk, _encoding, callback) {
                        callback()
                    },
                })
            },
            createReadStream() {
                const stream = new Readable({ read() {} })
                streams.add(stream)
                return stream
            },
            unlink() {},
            end() {
                for (const stream of streams) stream.destroy()
            },
        })
        const started = Date.now()
        const response = await handlers.get('ssh_upload')({
            alias: 'fixture',
            localPath,
            remotePath: '/remote/target.txt',
            timeout: 20,
            atomic: phase === 'cleanup',
            verifyMd5: phase === 'digest',
            verifySize: phase === 'cleanup',
        })
        const result = JSON.parse(response.content[0].text)
        assert.equal(result.success, false, phase)
        assert.ok(Date.now() - started < 2000, phase)
        if (phase === 'cleanup') assert.match(result.cleanupWarning, /timed out/)
        if (phase === 'digest') assert.equal(result.verificationStatus, 'error')
    }
})

test('explicit single-file SHA-256 verification works on an exec-disabled SFTP server', async (t) => {
    const directory = makeTempDir(t)
    const source = path.join(directory, 'source.txt')
    fs.writeFileSync(source, 'verified through SFTP', { mode: 0o640 })
    const handlers = new Map()
    registerFileTools({ registerTool: (name, definition, handler) => handlers.set(name, { definition, handler }) })
    const originalGetSftp = sessionManager.getSftp
    const originalCapability = sessionManager.getExternalTransferCapability
    const originalExec = sessionManager.exec
    sessionManager.exec = async () => {
        throw new Error('exec is disabled')
    }
    sessionManager.getExternalTransferCapability = () => ({ rsyncEligible: false, decisionReason: 'fixture_sftp' })
    sessionManager.getSftp = async () => ({
        _extensions: { 'posix-rename@openssh.com': '1' },
        stat(remotePath, callback) {
            fs.stat(remotePath, (error, stats) =>
                callback(
                    error,
                    stats && {
                        mode: stats.mode,
                        size: stats.size,
                        uid: stats.uid,
                        gid: stats.gid,
                        mtime: Math.floor(stats.mtimeMs / 1000),
                        atime: Math.floor(stats.atimeMs / 1000),
                    }
                )
            )
        },
        createReadStream: (remotePath, options) => fs.createReadStream(remotePath, options),
        createWriteStream: (remotePath, options) => fs.createWriteStream(remotePath, options),
        ext_openssh_rename: (from, to, callback) => fs.rename(from, to, callback),
        end() {},
    })
    t.after(() => {
        sessionManager.getSftp = originalGetSftp
        sessionManager.getExternalTransferCapability = originalCapability
        sessionManager.exec = originalExec
    })
    for (const direction of ['upload', 'download']) {
        const target = path.join(directory, `target-${direction}`)
        const request = {
            alias: 'fixture',
            localPath: direction === 'upload' ? source : target,
            remotePath: direction === 'upload' ? target : source,
            direction,
            verify: { sha256: true, owner: true, mode: direction === 'upload' },
        }
        const entry = handlers.get('ssh_sync')
        const result = JSON.parse((await entry.handler(entry.definition.inputSchema.parse(request))).content[0].text)
        assert.equal(result.success, true, JSON.stringify(result))
        assert.equal(result.method, 'sftp')
        assert.equal(result.verification.kind, 'single_file')
        assert.equal(result.verification.checks.sha256, true)
        assert.equal(result.verificationStatus, 'matched')
        assert.equal(fs.readFileSync(target, 'utf8'), 'verified through SFTP')
    }
})

test('directory exclude glob matching preserves literals and avoids repeated-wildcard backtracking', () => {
    for (const [relativePath, pattern, expected] of [
        ['sub/cache/file.txt', '*.txt', true],
        ['sub/cache/file.txt', 'sub/*/*.txt', true],
        ['sub/cache/file.txt', 'sub/**', true],
        ['sub/cache/file.txt', 'sub/*', false],
        ['sub/cache/file.txt', '*/file.txt', false],
        ['./sub/a.txt', '/sub/?.txt', true],
        ['a.txt', '?.txt', true],
        ['ab.txt', '?.txt', false],
        ['a+b[1].txt', 'a+b[1].txt', true],
        ['ab1.txt', 'a+b[1].txt', false],
        ['{a,b}.txt', '{a,b}.txt', true],
        ['a.txt', '{a,b}.txt', false],
        ['a\nb', 'a*b', true],
        ['a\nb', 'a**b', false],
        ['😀.txt', '??.txt', true],
    ]) {
        assert.equal(matchesDirectoryExclude(relativePath, [pattern]), expected, `${relativePath}: ${pattern}`)
    }
    assert.equal(matchesDirectoryExclude('file.txt', undefined), false)
    const moduleUrl = new URL('../dist/directory-verification.js', import.meta.url).href
    const script = `import { matchesDirectoryExclude } from ${JSON.stringify(moduleUrl)};
        console.log(matchesDirectoryExclude('a'.repeat(80) + 'c', ['*a'.repeat(8) + 'b']));`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: 5000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'false')
})

test('SSH key and config validators reject nonregular inputs before synchronous reads', (t) => {
    const directory = makeTempDir(t)
    fs.writeFileSync(path.join(directory, 'regular'), 'Host fixture\n  HostName example.com\n')
    fs.mkdirSync(path.join(directory, 'directory'))
    const rejected = [path.join(directory, 'directory')]
    if (process.platform !== 'win32') {
        const fifo = path.join(directory, 'fifo')
        const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 3000 })
        assert.ifError(created.error)
        assert.equal(created.status, 0, created.stderr)
        rejected.push(fifo)
        fs.symlinkSync(path.join(directory, 'regular'), path.join(directory, 'regular-link'))
    }
    const securityUrl = new URL('../dist/security.js', import.meta.url).href
    const configUrl = new URL('../dist/ssh-config.js', import.meta.url).href
    const script = `import assert from 'node:assert/strict';
        import { validateKeyFile, validateConfigFile } from ${JSON.stringify(securityUrl)};
        import { parseSSHConfig } from ${JSON.stringify(configUrl)};
        for (const validate of [validateKeyFile, validateConfigFile]) {
            validate(${JSON.stringify(path.join(directory, 'regular'))});
            ${process.platform !== 'win32' ? `validate(${JSON.stringify(path.join(directory, 'regular-link'))});` : ''}
            for (const input of ${JSON.stringify(rejected)}) {
                assert.throws(() => validate(input), /regular file/);
            }
        }
        assert.equal(parseSSHConfig(${JSON.stringify(path.join(directory, 'regular'))}).length, 1);
        for (const input of ${JSON.stringify(rejected)}) {
            assert.throws(() => parseSSHConfig(input), /regular file/);
        }
        console.log('nonregular-inputs-rejected');`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, SSH_MCP_ALLOWED_KEY_DIRS: directory },
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'nonregular-inputs-rejected')
})

test('SSH port schemas reject out-of-range and fractional values', () => {
    for (const invalid of [-1, 0, 65536, 22.5]) {
        assert.equal(sshPortSchema.safeParse(invalid).success, false)
    }
    assert.equal(sshPortSchema.safeParse(22).success, true)
    assert.equal(dynamicSshPortSchema.safeParse(0).success, true)
    assert.equal(dynamicSshPortSchema.safeParse(65535).success, true)
})

test('command risk keeps bounded read-only pipelines below high and flags destructive commands', () => {
    const readOnly = classifyCommandRisk('grep -R "Build ID" /opt/app | sort | uniq | head -20', 30_000)
    assert.equal(readOnly, undefined)
    assert.equal(classifyCommandRisk('printf x | sed s/x/y/ | sort | uniq | head -1', 30_000), undefined)
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

test('command risk ignores quoted scripts, escaped expansions, and literal ampersands', () => {
    const commands = [
        "printf '%s\\n' 'rm -rf /tmp/example'",
        'printf "%s\\n" "rm -rf /tmp/example"',
        "python -c 'print(oct(0o100600 & 0o777))'",
        'python -c "print(oct(0o100600 & 0o777))"',
        "printf '%s\\n' '$(rm -rf /tmp/example)'",
        'printf "%s\\n" "\\$(rm -rf /tmp/example)"',
        'printf "%s\\n" "\\`rm -rf /tmp/example\\`"',
        'printf x\\&y',
        'printf "%s\\n" "<<EOF"',
        'grep -F "rm -rf & background_task" /tmp/example.log | head -20',
    ]
    for (const command of commands) {
        assert.equal(classifyCommandRisk(command, 30_000), undefined, command)
    }
})

test('command risk ignores here-doc input and resumes Shell scanning after the exact delimiter', () => {
    const commands = [
        "python3 -I - <<'PY'\nprint(oct(0o100600 & 0o777))\nPY",
        "cat <<'EOF'\nrm -rf /tmp/example &\nit's only input\n$(rm -rf /tmp/example)\nEOF",
        'cat <<"EOF"\nrm -rf /tmp/example &\n`rm -rf /tmp/example`\nEOF',
        "cat <<E'OF'\nrm -rf /tmp/example &\n$(rm -rf /tmp/example)\nEOF",
        'cat <<E"OF"\nrm -rf /tmp/example &\n$(rm -rf /tmp/example)\nEOF',
        'cat <<\\EOF\nrm -rf /tmp/example &\n$(rm -rf /tmp/example)\nEOF',
        "cat <<''\nrm -rf /tmp/example &\n\n",
        "cat <<-'EOF'\n\trm -rf /tmp/example &\n\tEOF",
        'cat <<EOF\nrm -rf /tmp/example &\nit\'s input with "quotes"\nEOF',
        'cat <<EOF\n\\$(rm -rf /tmp/example)\n\\`rm -rf /tmp/example\\`\nEOF',
        'cat <<EOF\n$((0100600 & 0777))\nEOF',
        "cat <<'FIRST' <<SECOND\nrm -rf /tmp/example &\nFIRST\nrm -rf /tmp/example &\nSECOND",
        "cat <<'EOF'\neof\nsleep 1 &\nEOF",
        "cat <<'EOF'\nEOF trailing\nsleep 1 &\nEOF",
        "cat <<'EOF'\n EOF\nsleep 1 &\nEOF",
        "cat <<-'EOF'\n EOF\nsleep 1 &\n\tEOF",
        "cat <<'EOF' \\\n; printf done\nrm -rf /tmp/example &\nEOF",
        "cat <<'EOF'\nunclosed input rm -rf /tmp/example &",
        "cat <<'EOF'\nE\\\nOF\nsleep 1 &\nEOF",
        'cat <<$EOF\nrm -rf /tmp/example &\n$EOF',
        "cat <<'$(rm -rf /tmp/example)'\nrm -rf &\n$(rm -rf /tmp/example)",
        "cat <<'EOF' # <<IGNORED \"\nrm -rf &\nEOF",
        'printf "%s" "$(cat <<EOF\nrm -rf &\nEOF\n)"',
        'cat <<<"rm -rf /tmp/example &"',
    ]
    for (const command of commands) {
        assert.equal(classifyCommandRisk(command, 30_000), undefined, command)
    }
    for (const command of [
        "cat <<'EOF'\nit's input\nEOF\nsleep 1 &",
        'cat <<EOF\nit\'s input with "quotes"\nEOF\nsleep 1 &',
        "cat <<-'EOF'\t; printf done\n\tit's input\n\tEOF\nsleep 1 &",
        "cat <<'FIRST' <<SECOND\nit's input\nFIRST\nrm -rf &\nSECOND\nsleep 1 &",
        'cat <<EOF &\nrm -rf /tmp/example &\nEOF',
        'cat <<EOF\nE\\\nOF\nsleep 1 &',
        'cat <<\\\n  EOF\nrm -rf &\nEOF\nsleep 1 &',
    ]) {
        const risk = classifyCommandRisk(command, 30_000)
        assert.equal(risk?.level, 'high', command)
        assert.deepEqual(risk.categories, ['process-control'], command)
        assert.deepEqual(risk.signals, ['background_task'], command)
    }
    assert.deepEqual(classifyCommandRisk("cat <<'EOF'\nit's input\nEOF\nrm -rf /tmp/example", 30_000)?.signals, [
        'destructive_command',
    ])
})

test('command risk detects real substitutions in double quotes and expandable here-docs', () => {
    const commands = [
        'printf "%s\\n" "$(rm -rf /tmp/example)"',
        'printf "%s\\n" "`rm -rf /tmp/example`"',
        'printf "%s\\n" "$(printf x; rm -rf /tmp/example)"',
        'printf "%s\\n" "$(printf "%s" "$(rm -rf /tmp/example)")"',
        'cat <<EOF\n$(rm -rf /tmp/example)\nEOF',
        'cat <<EOF\n`rm -rf /tmp/example`\nEOF',
        "cat <<EOF\n'$(rm -rf /tmp/example)'\nEOF",
        'cat <<EOF\n"$(rm -rf /tmp/example)"\nEOF',
        'cat <<EOF\n$((1 + $(rm -rf /tmp/example)))\nEOF',
        "cat <<'FIRST' <<SECOND\n$(rm -rf /tmp/example)\nFIRST\n$(rm -rf /tmp/example)\nSECOND",
        'cat <<EOF\n\\\\$(rm -rf /tmp/example)\nEOF',
        'cat <<E\\\nOF\n$(rm -rf /tmp/example)\nEOF',
        "printf '%s' \"$(cat <<'EOF'\nit's input\nEOF\nrm -rf /tmp/example)\"",
    ]
    for (const command of commands) {
        const risk = classifyCommandRisk(command, 30_000)
        assert.equal(risk?.level, 'high', command)
        assert.deepEqual(risk.categories, ['destructive'], command)
        assert.deepEqual(risk.signals, ['destructive_command'], command)
    }
    for (const command of [
        'printf "%s\\n" "$(sleep 1 &)"',
        'cat <<EOF\n$(sleep 1 &)\nEOF',
        'cat <<EOF\n`sleep 1 &`\nEOF',
    ]) {
        assert.deepEqual(classifyCommandRisk(command, 30_000)?.signals, ['background_task'], command)
    }
})

test('command risk recognizes real background operators after quoted and escaped arguments', () => {
    const commands = [
        'sleep 1 &',
        'sleep 1 & ',
        'sleep 1 &\n',
        'sleep 1 &\t',
        'sleep 1 2>&1 &\n',
        "printf '%s\\n' 'rm &'; sleep 1 &\n",
        'printf "%s\\n" "\\&"; sleep 1 &\n',
        'printf "%s\\n" "<<EOF"; sleep 1 &\n',
        'printf \\<\\<EOF; sleep 1 &\n',
    ]
    for (const command of commands) {
        const risk = classifyCommandRisk(command, 30_000)
        assert.equal(risk?.level, 'high', command)
        assert.deepEqual(risk.categories, ['process-control'], command)
        assert.deepEqual(risk.signals, ['background_task'], command)
    }
})

test('command risk distinguishes background operators from conjunctions, redirection, and quoted arithmetic', () => {
    const commands = [
        'true && printf done',
        'printf x 2>&1',
        'printf x &>/tmp/example.log',
        'printf x 3<&0',
        'printf x >&2',
        'printf x >>/tmp/example.log',
        'printf "%s\\n" "$((0100600 & 0777))"',
        'printf "%s\\n" "https://example.com/?a=1&b=2"',
    ]
    for (const command of commands) {
        assert.equal(classifyCommandRisk(command, 30_000), undefined, command)
    }
})

test('command risk preserves the inclusive bounded-search timeout boundary', () => {
    for (const command of ['find /tmp/example -name file', 'grep -R pattern /tmp/example']) {
        for (const timeout of [1, 30_000, 300_000]) {
            assert.equal(classifyCommandRisk(command, timeout), undefined, `${command}: ${timeout}`)
        }
        for (const timeout of [undefined, 0, 300_001]) {
            const risk = classifyCommandRisk(command, timeout)
            assert.equal(risk?.level, 'medium', `${command}: ${timeout}`)
            assert.deepEqual(risk.categories, ['long-running'])
            assert.deepEqual(risk.signals, ['unbounded_search'])
        }
    }
})

test('ssh_exec command risk is diagnostic-only and preserves mocked execution results for each shell', async (t) => {
    const handlers = new Map()
    registerExecTools({
        registerTool(name, _definition, handler) {
            handlers.set(name, handler)
        },
    })
    const originalExec = sessionManager.exec
    const originalShell = sessionManager.getCommandShell
    t.after(() => {
        sessionManager.exec = originalExec
        sessionManager.getCommandShell = originalShell
    })

    for (const [shell, command, category, signal] of [
        ['posix', 'rm -rf /tmp/example', 'destructive', 'destructive_command'],
        ['cmd', 'del C:\\Data\\file.txt', 'destructive', 'destructive_command'],
        ['powershell', 'Remove-Item -Recurse C:\\Data', 'destructive', 'destructive_command'],
        ['posix', "python3 -I - <<'PY'\nprint(oct(0o100600 & 0o777))\nPY"],
        ['posix', "cat <<'EOF'\nit's input\nEOF\nsleep 1 &", 'process-control', 'background_task'],
        ['posix', 'cat <<EOF\n$(rm -rf /tmp/example)\nEOF', 'destructive', 'destructive_command'],
        ['posix', 'printf "%s" "$(rm -rf /tmp/example)"', 'destructive', 'destructive_command'],
    ]) {
        sessionManager.getCommandShell = () => shell
        for (const success of [true, false]) {
            const calls = []
            const execution = {
                success,
                stdout: 'mock output',
                stderr: success ? '' : 'mock execution failure',
                exitCode: success ? 0 : 1,
            }
            sessionManager.exec = async (alias, receivedCommand, options) => {
                calls.push({ alias, command: receivedCommand, timeout: options.timeout })
                return execution
            }
            const response = await handlers.get('ssh_exec')({ alias: 'risk-fixture', command, timeout: 30_000 })
            const result = JSON.parse(response.content[0].text)
            const { commandRisk, ...returnedExecution } = result
            assert.deepEqual(returnedExecution, execution)
            if (category) {
                assert.equal(commandRisk.level, 'high', command)
                assert.deepEqual(commandRisk.categories, [category], command)
                assert.deepEqual(commandRisk.signals, [signal], command)
            } else {
                assert.equal(commandRisk, undefined, command)
            }
            assert.deepEqual(calls, [{ alias: 'risk-fixture', command, timeout: 30_000 }])
        }
    }
})

test('ssh_exec_batch command risk does not stop a successful mocked batch or replace execution failures', async (t) => {
    const handlers = new Map()
    registerExecTools({
        registerTool(name, _definition, handler) {
            handlers.set(name, handler)
        },
    })
    const originalExec = sessionManager.exec
    const originalShell = sessionManager.getCommandShell
    const commands = [
        'rm -rf /tmp/example',
        'printf done',
        "python3 -I - <<'PY'\nprint(oct(0o100600 & 0o777))\nPY",
        "cat <<'EOF'\nit's input\nEOF\nsleep 1 &",
    ]
    const calls = []
    sessionManager.getCommandShell = () => 'posix'
    sessionManager.exec = async (_alias, command) => {
        calls.push(command)
        return { success: true, stdout: 'mock output', stderr: '', exitCode: 0 }
    }
    t.after(() => {
        sessionManager.exec = originalExec
        sessionManager.getCommandShell = originalShell
    })

    const handler = handlers.get('ssh_exec_batch')
    const success = JSON.parse((await handler({ alias: 'risk-fixture', commands })).content[0].text)
    assert.equal(success.success, true)
    assert.equal(success.executed, commands.length)
    assert.deepEqual(calls, commands)
    assert.deepEqual(success.results[0].commandRisk.signals, ['destructive_command'])
    assert.equal(success.results[1].commandRisk, undefined)
    assert.equal(success.results[2].commandRisk, undefined)
    assert.deepEqual(success.results[3].commandRisk.signals, ['background_task'])

    sessionManager.exec = async () => {
        throw new Error('injected execution failure')
    }
    const failure = JSON.parse((await handler({ alias: 'risk-fixture', commands })).content[0].text)
    assert.equal(failure.success, false)
    assert.equal(failure.executed, 1)
    assert.equal(failure.results[0].error, 'injected execution failure')
    assert.deepEqual(failure.results[0].commandRisk.signals, ['destructive_command'])
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
    let requestedFlags
    const sftp = {
        createWriteStream(_remotePath, options) {
            requestedMode = options.mode
            requestedFlags = options.flags
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
    assert.equal(requestedFlags, 'w')
    assert.equal(result.createMode, '0777')
})

test('file mode metadata and permission text preserve special bits', async () => {
    const cases = [
        [0o104755, '4755', '-rwsr-xr-x'],
        [0o104644, '4644', '-rwSr--r--'],
        [0o102755, '2755', '-rwxr-sr-x'],
        [0o102644, '2644', '-rw-r-Sr--'],
        [0o101755, '1755', '-rwxr-xr-t'],
        [0o101644, '1644', '-rw-r--r-T'],
    ]
    for (const [mode, octal, permissions] of cases) {
        assert.equal(formatFileMode(mode), octal)
        assert.equal(formatFilePermissions(mode), permissions)
        assert.equal(parseExpectedFileMode(permissions), Number.parseInt(octal, 8))
        assert.equal(parseExpectedFileMode(octal), Number.parseInt(octal, 8))
    }
    assert.equal(parseExpectedFileMode('755'), 0o755)
    assert.equal(parseExpectedFileMode('-rwxr-xr-x'), 0o755)
    assert.equal(parseExpectedFileMode('-rwxr-xr-z'), undefined)

    const attrs = { size: 0, mode: 0o104755, uid: 1, gid: 2, mtime: 0, atime: 0 }
    const files = await listDir('unused', '/remote', true, {
        readdir(_remotePath, callback) {
            callback(null, [{ filename: 'setuid-file', attrs }])
        },
        end() {},
    })
    assert.equal(files[0].mode, 0o4755)
    assert.equal(files[0].permissions, '-rwsr-xr-x')
})

test('public directory listing filters intersections and bounds pages without truncating internal enumeration', async (t) => {
    const handlers = new Map()
    registerFileTools({ registerTool: (name, definition, handler) => handlers.set(name, { definition, handler }) })
    const entry = handlers.get('ssh_list_dir')
    const epoch = Date.parse('2026-01-01T00:00:00Z') / 1000
    const attrs = { size: 7, mode: 0o100644, uid: 1, gid: 2, mtime: epoch, atime: epoch }
    let entries = Array.from({ length: 120 }, (_, index) => ({
        filename: `file-${String(index).padStart(3, '0')}.log`,
        attrs: { ...attrs, mtime: epoch + index },
    }))
    entries.push(
        { filename: 'z-directory', attrs: { ...attrs, mode: 0o40755 } },
        { filename: '.hidden.log', attrs: { ...attrs, mtime: epoch + 5 } },
        { filename: 'a+b[1].txt', attrs },
        { filename: '中文😀.txt', attrs },
        { filename: 'a\nb.txt', attrs }
    )
    const originalGetSftp = sessionManager.getSftp
    let reads = 0
    sessionManager.getSftp = async () => ({
        readdir(_remotePath, callback) {
            ++reads
            callback(null, entries)
        },
        end() {},
    })
    t.after(() => {
        sessionManager.getSftp = originalGetSftp
    })
    const call = async (options = {}) => {
        const response = await entry.handler(
            entry.definition.inputSchema.parse({ alias: 'fixture', remotePath: '/remote/中文', ...options })
        )
        return { response, data: JSON.parse(response.content[0].text) }
    }
    const legacy = (await call()).data
    assert.deepEqual(Object.keys(legacy), ['success', 'path', 'count', 'files'])
    assert.equal(legacy.count, 124)
    assert.equal(legacy.files[0].name, 'z-directory')
    assert.equal((await call({ showHidden: true })).data.count, 125)
    assert.equal((await call({ timeout: 1000 })).data.has_more, undefined)
    const first = await call({ namePattern: '*' })
    assert.equal(first.data.count, 100)
    assert.equal(first.data.total_count, 124)
    assert.equal(first.data.has_more, true)
    assert.equal(first.data.next_offset, 100)
    assert.ok(Buffer.byteLength(first.response.content[0].text, 'utf8') <= 65536)
    assert.deepEqual(first.data.files, legacy.files.slice(0, 100))
    const names = []
    let offset = 0
    for (;;) {
        const page = await call({ offset, limit: 17, maxBytes: 7000 })
        assert.ok(Buffer.byteLength(page.response.content[0].text, 'utf8') <= 7000)
        assert.equal(page.data.count, page.data.files.length)
        assert.equal(page.data.next_offset, offset + page.data.count)
        names.push(...page.data.files.map((file) => file.name))
        if (!page.data.has_more) break
        assert.ok(page.data.next_offset > offset)
        offset = page.data.next_offset
    }
    assert.deepEqual(
        names,
        legacy.files.map((file) => file.name)
    )
    const interval = {
        namePattern: '*.log',
        modifiedAfter: '2026-01-01T08:00:05+08:00',
        modifiedBefore: '2026-01-01T00:00:08Z',
    }
    const filtered = (await call(interval)).data
    assert.deepEqual(
        filtered.files.map((file) => file.name),
        ['file-005.log', 'file-006.log', 'file-007.log']
    )
    assert.equal(filtered.has_more, false)
    assert.equal(filtered.next_offset, 3)
    assert.equal((await call({ ...interval, showHidden: true })).data.count, 4)
    assert.equal((await call({ modifiedAfter: '2026-01-01T00:01:59Z' })).data.count, 1)
    assert.equal((await call({ modifiedBefore: '2026-01-01T00:00:01Z' })).data.count, 5)
    assert.equal(
        (await call({ namePattern: '*.log', modifiedAfter: '2026-01-01T00:00:00.0001Z' })).data.total_count,
        119
    )
    assert.equal((await call({ namePattern: '*.log', modifiedBefore: '2026-01-01T00:00:00.0001Z' })).data.count, 1)
    assert.equal((await call({ ...interval, modifiedBefore: '2026-01-01T00:00:05.000000Z' })).data.count, 0)
    for (const [namePattern, expected] of [
        ['a+b[1].txt', ['a+b[1].txt']],
        ['中文??.txt', ['中文😀.txt']],
        ['a*b.txt', ['a\nb.txt']],
        ['FILE-*.log', []],
        ['no-match', []],
    ]) {
        assert.deepEqual(
            (await call({ namePattern })).data.files.map((file) => file.name),
            expected
        )
    }
    const empty = (await call({ ...interval, modifiedBefore: interval.modifiedAfter })).data
    assert.equal(empty.total_count, 0)
    assert.equal(empty.has_more, false)
    assert.equal(empty.next_offset, 0)
    const beyond = (await call({ offset: 1000 })).data
    assert.deepEqual(beyond.files, [])
    assert.equal(beyond.has_more, false)
    assert.equal(beyond.next_offset, 1000)
    const beforeInvalid = reads
    for (const invalid of [
        { offset: -1 },
        { offset: 0.5 },
        { offset: Number.MAX_SAFE_INTEGER + 1 },
        { limit: 0 },
        { limit: 1.5 },
        { maxBytes: 0 },
        { maxBytes: -1 },
        { modifiedAfter: 'not-a-date' },
        { modifiedBefore: '2026-02-30T00:00:00Z' },
        { modifiedAfter: '2026-01-01T00:00:00' },
        { ...interval, modifiedBefore: '2026-01-01T00:00:04Z' },
        { modifiedAfter: '2026-01-01T00:00:00.0002Z', modifiedBefore: '2026-01-01T00:00:00.0001Z' },
    ]) {
        await assert.rejects(call(invalid))
    }
    assert.equal(reads, beforeInvalid)
    assert.equal((await listDir('fixture', '/remote/中文', true)).length, 125)
    entries.push({ filename: '../unsafe', attrs })
    const unsafe = await call({ namePattern: 'no-match', offset: 1000, limit: 1 })
    assert.equal(unsafe.response.isError, true)
    assert.match(unsafe.data.error, /unsafe entry name/)
})

test('public directory byte budget measures emitted UTF-8 JSON and never advances past an oversized entry', async (t) => {
    const handlers = new Map()
    registerFileTools({ registerTool: (name, definition, handler) => handlers.set(name, { definition, handler }) })
    const entry = handlers.get('ssh_list_dir')
    const attrs = { size: 7, mode: 0o100644, uid: 1, gid: 2, mtime: 0, atime: 0 }
    let entries = [{ filename: '中文😀"line\nfile.txt', attrs }]
    const originalGetSftp = sessionManager.getSftp
    sessionManager.getSftp = async () => ({
        readdir(_remotePath, callback) {
            callback(null, entries)
        },
        end() {},
    })
    t.after(() => {
        sessionManager.getSftp = originalGetSftp
    })
    const call = async (options = {}) => {
        const response = await entry.handler(
            entry.definition.inputSchema.parse({ alias: 'fixture', remotePath: '/remote/中文', limit: 1, ...options })
        )
        return { response, data: JSON.parse(response.content[0].text) }
    }
    const full = await call()
    const bytes = Buffer.byteLength(full.response.content[0].text, 'utf8')
    assert.ok(bytes > full.response.content[0].text.length)
    const exact = await call({ maxBytes: bytes })
    assert.equal(exact.response.content[0].text, full.response.content[0].text)
    for (const maxBytes of [1, bytes - 1]) {
        const failed = await call({ maxBytes })
        assert.equal(failed.response.isError, true)
        assert.equal(failed.data.success, false)
        assert.equal(failed.data.code, 'LIST_DIR_MAX_BYTES_TOO_SMALL')
        assert.equal(failed.data.offset, 0)
        assert.equal(failed.data.next_offset, 0)
        assert.ok(failed.data.requiredBytes > maxBytes)
    }
    entries = [
        { filename: 'a.txt', attrs },
        { filename: `z-${'中文'.repeat(100)}.txt`, attrs },
    ]
    const small = await call()
    const maxBytes = Buffer.byteLength(small.response.content[0].text, 'utf8')
    const page = await call({ limit: 100, maxBytes })
    assert.equal(page.data.count, 1)
    assert.equal(page.data.has_more, true)
    assert.equal(page.data.next_offset, 1)
    const failed = await call({ offset: page.data.next_offset, maxBytes })
    assert.equal(failed.response.isError, true)
    assert.equal(failed.data.next_offset, 1)
    assert.equal(failed.data.offset, 1)
    entries = Array.from({ length: 120 }, (_, index) => ({ filename: `${index}-${'中文'.repeat(100)}.txt`, attrs }))
    const defaultBudget = await call({ limit: 100 })
    assert.ok(defaultBudget.data.count > 0 && defaultBudget.data.count < 100)
    assert.equal(defaultBudget.data.has_more, true)
    assert.ok(Buffer.byteLength(defaultBudget.response.content[0].text, 'utf8') <= 65536)
    entries = []
    const empty = await call()
    const emptyBytes = Buffer.byteLength(empty.response.content[0].text, 'utf8')
    assert.equal((await call({ maxBytes: emptyBytes })).data.success, true)
    assert.equal((await call({ maxBytes: emptyBytes - 1 })).response.isError, true)
})

test('atomic upload paths are unpredictable and exclusive SFTP writes refuse reuse', async (t) => {
    const directory = makeTempDir(t)
    const localPath = path.join(directory, 'source.txt')
    fs.writeFileSync(localPath, 'payload')
    const paths = new Set(Array.from({ length: 64 }, () => createAtomicUploadPath('/remote/target.txt')))
    assert.equal(paths.size, 64)
    for (const remotePath of paths) {
        assert.match(remotePath, /^\/remote\/target\.txt\.mcp-tmp-\d+-[0-9a-f]{24}$/)
    }

    let requestedFlags
    const sftp = {
        createWriteStream(_remotePath, options) {
            requestedFlags = options.flags
            return new Writable({
                write(_chunk, _encoding, callback) {
                    callback()
                },
            })
        },
        end() {},
    }
    await uploadFile('unused', localPath, '/remote/temp.txt', undefined, sftp, 0o600, undefined, false, true)
    assert.equal(requestedFlags, 'wx')
})

test('SFTP directory listing rejects hostile entry names before path construction', async () => {
    const attrs = { size: 0, mode: 0o100644, uid: 1, gid: 1, mtime: 0, atime: 0 }
    for (const filename of ['', '../escape', '/absolute', 'nested/name', 'nested\\name', '.', '..', 'nul\0name']) {
        // noinspection JSUnusedGlobalSymbols — listDir 通过 SFTPWrapper 结构类型调用
        const sftp = {
            readdir(_remotePath, callback) {
                callback(null, [{ filename, attrs }])
            },
            end() {},
        }
        await assert.rejects(listDir('unused', '/safe', true, sftp), /unsafe entry name/)
    }
})

test('atomic SFTP download replaces the target only after a complete transfer', async (t) => {
    const directory = makeTempDir(t)
    const localPath = path.join(directory, 'target.txt')
    fs.writeFileSync(localPath, 'original')
    const payload = 'replacement'
    const sftp = {
        stat(_remotePath, callback) {
            callback(null, { size: Buffer.byteLength(payload) })
        },
        createReadStream() {
            return Readable.from([payload])
        },
        end() {},
    }

    const result = await downloadFile('unused', '/remote/target.txt', localPath, undefined, sftp)
    assert.equal(result.atomic, true)
    assert.equal(fs.readFileSync(localPath, 'utf8'), payload)
    assert.deepEqual(fs.readdirSync(directory), ['target.txt'])
})

test('failed atomic SFTP download preserves the existing target and removes temporary data', async (t) => {
    const directory = makeTempDir(t)
    const localPath = path.join(directory, 'target.txt')
    fs.writeFileSync(localPath, 'original')
    const sftp = {
        stat(_remotePath, callback) {
            callback(null, { size: 12 })
        },
        createReadStream() {
            let emitted = false
            return new Readable({
                read() {
                    if (!emitted) {
                        emitted = true
                        this.push('partial')
                        this.destroy(new Error('injected download failure'))
                    }
                },
            })
        },
        end() {},
    }

    await assert.rejects(
        downloadFile('unused', '/remote/target.txt', localPath, undefined, sftp),
        /injected download failure/
    )
    assert.equal(fs.readFileSync(localPath, 'utf8'), 'original')
    assert.deepEqual(fs.readdirSync(directory), ['target.txt'])
})

test('synchronous SFTP read stream failure closes an owned session without temporary data', async (t) => {
    const directory = makeTempDir(t)
    const localPath = path.join(directory, 'target.txt')
    fs.writeFileSync(localPath, 'original')
    const originalGetSftp = sessionManager.getSftp
    let endCalls = 0
    sessionManager.getSftp = async () => ({
        _extensions: { 'posix-rename@openssh.com': '1' },
        stat(_remotePath, callback) {
            callback(null, { size: 12 })
        },
        createReadStream() {
            throw new Error('injected stream construction failure')
        },
        end() {
            ++endCalls
        },
    })
    t.after(() => {
        sessionManager.getSftp = originalGetSftp
    })

    await assert.rejects(downloadFile('owned', '/remote/target.txt', localPath), /injected stream construction failure/)
    assert.equal(endCalls, 1)
    assert.equal(fs.readFileSync(localPath, 'utf8'), 'original')
    assert.deepEqual(fs.readdirSync(directory), ['target.txt'])
})

test('clean premature SFTP EOF preserves the existing target and removes temporary data', async (t) => {
    const directory = makeTempDir(t)
    const localPath = path.join(directory, 'target.txt')
    fs.writeFileSync(localPath, 'original')
    const sftp = {
        stat(_remotePath, callback) {
            callback(null, { size: 12 })
        },
        createReadStream() {
            return Readable.from(['partial'])
        },
        end() {},
    }

    await assert.rejects(
        downloadFile('unused', '/remote/target.txt', localPath, undefined, sftp),
        /Transfer size mismatch/
    )
    assert.equal(fs.readFileSync(localPath, 'utf8'), 'original')
    assert.deepEqual(fs.readdirSync(directory), ['target.txt'])
})

test('atomic SFTP download keeps temporary files private and preserves ordinary target permissions', async (t) => {
    if (process.platform === 'win32') {
        t.skip('POSIX file modes are not available on Windows')
        return
    }
    const directory = makeTempDir(t)
    const payload = Buffer.from('replacement')
    const cases = [
        { name: 'new.txt', mode: undefined, expected: 0o600 },
        { name: 'private.txt', mode: 0o600, expected: 0o600 },
        { name: 'group.txt', mode: 0o750, expected: 0o750 },
        { name: 'setuid.txt', mode: 0o4755, expected: 0o755 },
    ]

    for (const entry of cases) {
        const localPath = path.join(directory, entry.name)
        if (entry.mode !== undefined) {
            fs.writeFileSync(localPath, 'original')
            fs.chmodSync(localPath, entry.mode)
        }
        const remoteStream = new Readable({ read() {} })
        const sftp = {
            stat(_remotePath, callback) {
                callback(null, { size: payload.length })
            },
            createReadStream() {
                return remoteStream
            },
            end() {},
        }

        const pending = downloadFile('unused', '/remote/target.txt', localPath, undefined, sftp)
        let temporaryPath
        for (let attempt = 0; attempt < 100; ++attempt) {
            temporaryPath = fs.readdirSync(directory).find((name) => name.startsWith(`.${entry.name}.mcp-tmp-`))
            if (temporaryPath) {
                break
            }
            await new Promise((resolve) => setImmediate(resolve))
        }
        assert.ok(temporaryPath, `temporary file was not created for ${entry.name}`)
        assert.equal(fs.statSync(path.join(directory, temporaryPath)).mode & 0o7777, 0o600)

        remoteStream.push(payload)
        remoteStream.push(null)
        const result = await pending
        assert.equal(result.success, true)
        assert.equal(fs.readFileSync(localPath, 'utf8'), payload.toString())
        assert.equal(fs.statSync(localPath).mode & 0o7777, entry.expected)
        assert.equal(
            fs.readdirSync(directory).some((name) => name.startsWith(`.${entry.name}.mcp-tmp-`)),
            false
        )
    }
})

test('atomic SFTP download rejects non-regular local targets before remote reads', async (t) => {
    if (process.platform === 'win32') {
        t.skip('symlink and FIFO target checks require POSIX filesystem behavior')
        return
    }
    const directory = makeTempDir(t)
    const source = path.join(directory, 'source.txt')
    const symlink = path.join(directory, 'target-link')
    const targetDirectory = path.join(directory, 'target-directory')
    const fifo = path.join(directory, 'target-fifo')
    fs.writeFileSync(source, 'original')
    fs.symlinkSync(source, symlink)
    fs.mkdirSync(targetDirectory)
    await exec(`mkfifo ${JSON.stringify(fifo)}`)

    let statCalls = 0
    let readCalls = 0
    const sftp = {
        stat(_remotePath, callback) {
            ++statCalls
            callback(null, { size: 1 })
        },
        createReadStream() {
            ++readCalls
            return Readable.from(['x'])
        },
        end() {},
    }

    for (const localPath of [symlink, targetDirectory, fifo]) {
        await assert.rejects(
            downloadFile('unused', '/remote/target.txt', localPath, undefined, sftp),
            /non-regular local target/
        )
    }
    assert.equal(statCalls, 0)
    assert.equal(readCalls, 0)
    assert.equal(fs.readFileSync(source, 'utf8'), 'original')
})

test('recursive SFTP mkdir creates missing parents without remote exec', async () => {
    const directories = new Set(['/'])
    const created = []
    const missing = () => Object.assign(new Error('No such file'), { code: 2 })
    // noinspection JSUnusedGlobalSymbols — mkdir 通过 SFTPWrapper 结构类型调用
    const sftp = {
        stat(remotePath, callback) {
            if (directories.has(remotePath)) {
                callback(null, { mode: 0o040755 })
            } else {
                callback(missing())
            }
        },
        mkdir(remotePath, callback) {
            directories.add(remotePath)
            created.push(remotePath)
            callback(null)
        },
        end() {},
    }

    await mkdir('unused', '/one/two/three', true, sftp)
    assert.deepEqual(created, ['/one', '/one/two', '/one/two/three'])
})

test('SFTP read pagination returns whole UTF-8 characters and next byte offsets', async (t) => {
    const content = Buffer.from('A😀B')
    const originalGetSftp = sessionManager.getSftp
    sessionManager.getSftp = async () => ({
        _extensions: { 'posix-rename@openssh.com': '1' },
        stat(_remotePath, callback) {
            callback(null, { size: content.length })
        },
        createReadStream(_remotePath, { start, end }) {
            return Readable.from([content.subarray(start, end + 1)])
        },
        end() {},
    })
    t.after(() => {
        sessionManager.getSftp = originalGetSftp
    })

    const first = await readFile('unused', '/remote/utf8.txt', { maxBytes: 4 })
    assert.equal(first.content, 'A')
    assert.equal(first.read_offset, 0)
    assert.equal(first.read_bytes, 1)
    assert.equal(first.next_offset, 1)

    const second = await readFile('unused', '/remote/utf8.txt', { offset: first.next_offset, maxBytes: 4 })
    assert.equal(second.content, '😀')
    assert.equal(second.read_offset, 1)
    assert.equal(second.next_offset, 5)

    await assert.rejects(readFile('unused', '/remote/utf8.txt', { offset: 2, maxBytes: 4 }), /UTF-8 character boundary/)
})

test('SFTP timeout reports an unknown remote operation state and ignores late callbacks', async (t) => {
    const originalGetSftp = sessionManager.getSftp
    let ended = false
    let statCallback
    sessionManager.getSftp = async () => ({
        _extensions: { 'posix-rename@openssh.com': '1' },
        stat(_remotePath, callback) {
            statCallback = callback
        },
        end() {
            ended = true
        },
    })
    t.after(() => {
        sessionManager.getSftp = originalGetSftp
    })

    await assert.rejects(getFileInfo('unused', '/remote/stalled.txt', 10), (error) => {
        assert.equal(error.name, 'SftpOperationTimeoutError')
        assert.deepEqual(error.details, {
            operationStatus: 'unknown',
            retryable: true,
            timeout: 10,
        })
        return true
    })
    assert.equal(ended, true)
    statCallback(null, { size: 0, mode: 0o100644, uid: 1, gid: 1, mtime: 0, atime: 0 })
    await new Promise((resolve) => setImmediate(resolve))
})

test('exec_script applies its timeout while uploading the temporary script', async (t) => {
    const handlers = new Map()
    registerExecTools({
        registerTool(name, _definition, handler) {
            handlers.set(name, handler)
        },
    })
    const originalExec = sessionManager.exec
    const originalGetSftp = sessionManager.getSftp
    const commands = []
    let endCalls = 0
    sessionManager.exec = async (_alias, command) => {
        commands.push(command)
        if (command === 'mktemp /tmp/mcp-ssh-script.XXXXXX') {
            return { success: true, stdout: '/tmp/mcp-ssh-script.fixture\n', stderr: '', exitCode: 0 }
        }
        assert.fail(`exec_script reached the execution stage: ${command}`)
    }
    sessionManager.getSftp = async () => ({
        _extensions: { 'posix-rename@openssh.com': '1' },
        createWriteStream() {
            return new Writable({
                write() {},
            })
        },
        unlink(_remotePath, callback) {
            callback(null)
        },
        end() {
            ++endCalls
        },
    })
    t.after(() => {
        sessionManager.exec = originalExec
        sessionManager.getSftp = originalGetSftp
    })

    const startedAt = Date.now()
    const response = await handlers.get('ssh_exec_script')({
        alias: 'stalled-upload',
        script: 'printf never-executed',
        timeout: 20,
    })
    const result = JSON.parse(response.content[0].text)
    const duration = Date.now() - startedAt

    assert.equal(result.success, false)
    assert.match(result.error, /timed out after 20ms/)
    assert.ok(duration >= 15 && duration < 500, `unexpected upload timeout duration: ${duration}ms`)
    assert.equal(endCalls, 2) // timed-out upload and SFTP cleanup
    assert.equal(commands.length, 1)
})

test('followSymlinks is rejected before transport selection when the local allowlist is configured', async (t) => {
    const root = makeTempDir(t)
    const allowed = path.join(root, 'allowed')
    const source = path.join(allowed, 'source')
    const outsideTarget = path.join(root, 'outside.txt')
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, 'file.txt'), 'allowed payload')
    fs.writeFileSync(outsideTarget, 'outside payload')

    const previousAllowList = process.env.SSH_MCP_FILE_OPS_ALLOW_DIRS
    const originalCapability = sessionManager.getExternalTransferCapability
    const originalGetSftp = sessionManager.getSftp
    let sftpCalls = 0
    let capabilityCalls = 0
    process.env.SSH_MCP_FILE_OPS_ALLOW_DIRS = allowed
    sessionManager.getExternalTransferCapability = () => {
        ++capabilityCalls
        throw new Error('transport selection must not start')
    }
    sessionManager.getSftp = async () => {
        ++sftpCalls
        throw new Error('SFTP must not start')
    }
    t.after(() => {
        sessionManager.getExternalTransferCapability = originalCapability
        sessionManager.getSftp = originalGetSftp
        if (previousAllowList === undefined) {
            delete process.env.SSH_MCP_FILE_OPS_ALLOW_DIRS
        } else {
            process.env.SSH_MCP_FILE_OPS_ALLOW_DIRS = previousAllowList
        }
    })

    await assert.rejects(
        syncFiles('allowlist-test', source, '/remote/rejected', 'upload', { followSymlinks: true }),
        /followSymlinks=true cannot be combined with SSH_MCP_FILE_OPS_ALLOW_DIRS/
    )
    assert.deepEqual({ sftp: sftpCalls, capability: capabilityCalls }, { sftp: 0, capability: 0 })

    const handlers = new Map()
    registerFileTools({
        registerTool(name, _definition, handler) {
            handlers.set(name, handler)
        },
    })
    const syncResponse = await handlers.get('ssh_sync')({
        alias: 'allowlist-test',
        localPath: source,
        remotePath: '/remote/tool-rejected',
        direction: 'upload',
        followSymlinks: true,
    })
    const syncResult = JSON.parse(syncResponse.content[0].text)
    assert.equal(syncResult.success, false)
    assert.match(syncResult.error, /followSymlinks=true cannot be combined with SSH_MCP_FILE_OPS_ALLOW_DIRS/)

    const uploadResponse = await handlers.get('ssh_upload')({
        alias: 'allowlist-test',
        localPath: outsideTarget,
        remotePath: '/remote/upload-rejected.txt',
    })
    const uploadResult = JSON.parse(uploadResponse.content[0].text)
    assert.equal(uploadResult.success, false)
    assert.match(uploadResult.error, /SSH_MCP_FILE_OPS_ALLOW_DIRS/)
    assert.deepEqual({ sftp: sftpCalls, capability: capabilityCalls }, { sftp: 0, capability: 0 })
})

test('ordinary upload uses SFTP probes and transfer on an exec-disabled server', async (t) => {
    const directory = makeTempDir(t)
    const localPath = path.join(directory, 'source.txt')
    fs.writeFileSync(localPath, 'payload')
    const handlers = new Map()
    registerFileTools({
        registerTool(name, _definition, handler) {
            handlers.set(name, handler)
        },
    })

    const originalGetSftp = sessionManager.getSftp
    const originalExec = sessionManager.exec
    let execCalls = 0
    sessionManager.exec = async () => {
        ++execCalls
        throw new Error('exec is disabled')
    }
    sessionManager.getSftp = async () => ({
        _extensions: { 'posix-rename@openssh.com': '1' },
        stat(remotePath, callback) {
            if (remotePath === '/remote') {
                callback(null, {
                    size: 0,
                    mode: 0o040755,
                    uid: 1000,
                    gid: 1000,
                    mtime: 1,
                    atime: 1,
                })
            } else {
                callback(Object.assign(new Error('No such file'), { code: 2 }))
            }
        },
        createWriteStream() {
            return new Writable({
                write(_chunk, _encoding, callback) {
                    callback()
                },
            })
        },
        end() {},
    })
    t.after(() => {
        sessionManager.getSftp = originalGetSftp
        sessionManager.exec = originalExec
    })

    const response = await handlers.get('ssh_upload')({
        alias: 'sftp-only',
        localPath,
        remotePath: '/remote/target.txt',
    })
    const result = JSON.parse(response.content[0].text)
    assert.equal(result.success, true)
    assert.equal(result.diagnostics.remoteParent.probeMethod, 'sftp')
    assert.equal(execCalls, 0)
})

test('upload mode verification compares all four permission digits', async (t) => {
    const directory = makeTempDir(t)
    const localPath = path.join(directory, 'source.txt')
    fs.writeFileSync(localPath, 'payload')
    const handlers = new Map()
    registerFileTools({
        registerTool(name, _definition, handler) {
            handlers.set(name, handler)
        },
    })

    const originalGetSftp = sessionManager.getSftp
    const createModes = []
    sessionManager.getSftp = async () => ({
        _extensions: { 'posix-rename@openssh.com': '1' },
        stat(remotePath, callback) {
            callback(null, {
                size: remotePath === '/remote' ? 0 : 7,
                mode: remotePath === '/remote' ? 0o040755 : 0o104755,
                uid: 1000,
                gid: 1000,
                mtime: 1,
                atime: 1,
            })
        },
        createWriteStream(_remotePath, options) {
            createModes.push(options.mode)
            return new Writable({
                write(_chunk, _encoding, callback) {
                    callback()
                },
            })
        },
        end() {},
    })
    t.after(() => {
        sessionManager.getSftp = originalGetSftp
    })

    const mismatchResponse = await handlers.get('ssh_upload')({
        alias: 'mode-test',
        localPath,
        remotePath: '/remote/target.txt',
        verifyMode: '0755',
    })
    const mismatch = JSON.parse(mismatchResponse.content[0].text)
    assert.equal(mismatch.transferSuccess, true)
    assert.equal(mismatch.success, false)
    assert.equal(mismatch.verification.checks.mode, false)
    assert.equal(mismatch.verification.actual.mode, '4755')
    assert.equal(mismatch.verification.actual.modeValue, 0o4755)
    assert.equal(mismatch.verification.actual.permissions, '-rwsr-xr-x')

    const matchResponse = await handlers.get('ssh_upload')({
        alias: 'mode-test',
        localPath,
        remotePath: '/remote/target.txt',
        verifyMode: '-rwsr-xr-x',
    })
    const match = JSON.parse(matchResponse.content[0].text)
    assert.equal(match.success, true)
    assert.equal(match.verification.checks.mode, true)
    assert.equal(match.verification.expected.mode, '4755')
    const sourceMode = fs.statSync(localPath).mode & 0o777
    assert.deepEqual(createModes, [sourceMode, sourceMode])
})

test('atomic upload verifies the temporary file before replacing an existing target', async (t) => {
    const directory = makeTempDir(t)
    const localPath = path.join(directory, 'source.txt')
    fs.writeFileSync(localPath, 'replacement')
    const remoteFiles = new Map([['/remote/target.txt', Buffer.from('original')]])
    const handlers = new Map()
    registerFileTools({
        registerTool(name, _definition, handler) {
            handlers.set(name, handler)
        },
    })

    const originalGetSftp = sessionManager.getSftp
    let renameCalls = 0
    let exclusiveWrites = 0
    sessionManager.getSftp = async () => ({
        _extensions: { 'posix-rename@openssh.com': '1' },
        stat(remotePath, callback) {
            if (remotePath === '/remote') {
                callback(null, { size: 0, mode: 0o040755, uid: 1000, gid: 1000, mtime: 1, atime: 1 })
                return
            }
            const content = remoteFiles.get(remotePath)
            if (!content) {
                callback(Object.assign(new Error('No such file'), { code: 2 }))
                return
            }
            callback(null, {
                size: remotePath.includes('.mcp-tmp-') ? content.length + 1 : content.length,
                mode: 0o100644,
                uid: 1000,
                gid: 1000,
                mtime: 1,
                atime: 1,
            })
        },
        createWriteStream(remotePath, options) {
            assert.equal(options.flags, 'wx')
            ++exclusiveWrites
            const chunks = []
            return new Writable({
                write(chunk, _encoding, callback) {
                    chunks.push(Buffer.from(chunk))
                    callback()
                },
                final(callback) {
                    remoteFiles.set(remotePath, Buffer.concat(chunks))
                    callback()
                },
            })
        },
        rename(sourcePath, targetPath, callback) {
            ++renameCalls
            remoteFiles.set(targetPath, remoteFiles.get(sourcePath))
            remoteFiles.delete(sourcePath)
            callback(null)
        },
        unlink(remotePath, callback) {
            remoteFiles.delete(remotePath)
            callback(null)
        },
        end() {},
    })
    t.after(() => {
        sessionManager.getSftp = originalGetSftp
    })

    const response = await handlers.get('ssh_upload')({
        alias: 'atomic-test',
        localPath,
        remotePath: '/remote/target.txt',
        atomic: true,
        verifySize: true,
    })
    const result = JSON.parse(response.content[0].text)

    assert.equal(result.success, false)
    assert.equal(result.transferSuccess, true)
    assert.equal(result.verificationStatus, 'mismatched')
    assert.equal(result.targetReplaced, false)
    assert.equal(result.finalRemotePath, '/remote/target.txt')
    assert.match(result.verifiedTempRemotePath, /\.mcp-tmp-/)
    assert.equal(result.verification.verifiedRemotePath, result.verifiedTempRemotePath)
    assert.equal(result.verification.actual.remotePath, result.verifiedTempRemotePath)
    assert.equal(exclusiveWrites, 1)
    assert.equal(renameCalls, 0)
    assert.equal(remoteFiles.get('/remote/target.txt').toString(), 'original')
    assert.equal(
        Array.from(remoteFiles.keys()).some((remotePath) => remotePath.includes('.mcp-tmp-')),
        false
    )
})

test('atomic upload uses OpenSSH replace only when the target already exists', async (t) => {
    const directory = makeTempDir(t)
    const localPath = path.join(directory, 'source.txt')
    fs.writeFileSync(localPath, 'replacement')
    const remoteFiles = new Map([['/remote/existing.txt', Buffer.from('original')]])
    const handlers = new Map()
    registerFileTools({
        registerTool(name, _definition, handler) {
            handlers.set(name, handler)
        },
    })

    const originalGetSftp = sessionManager.getSftp
    let renameCalls = 0
    let replaceCalls = 0
    sessionManager.getSftp = async () => ({
        _extensions: { 'posix-rename@openssh.com': '1' },
        stat(remotePath, callback) {
            if (remotePath === '/remote') {
                callback(null, { size: 0, mode: 0o040755, uid: 1000, gid: 1000, mtime: 1, atime: 1 })
                return
            }
            const content = remoteFiles.get(remotePath)
            if (content === undefined) {
                callback(Object.assign(new Error('No such file'), { code: 2 }))
                return
            }
            callback(null, {
                size: content.length,
                mode: 0o100644,
                uid: 1000,
                gid: 1000,
                mtime: 1,
                atime: 1,
            })
        },
        createWriteStream(remotePath, options) {
            assert.equal(options.flags, 'wx')
            const chunks = []
            return new Writable({
                write(chunk, _encoding, callback) {
                    chunks.push(Buffer.from(chunk))
                    callback()
                },
                final(callback) {
                    remoteFiles.set(remotePath, Buffer.concat(chunks))
                    callback()
                },
            })
        },
        rename(sourcePath, targetPath, callback) {
            ++renameCalls
            remoteFiles.set(targetPath, remoteFiles.get(sourcePath))
            remoteFiles.delete(sourcePath)
            callback(null)
        },
        ext_openssh_rename(sourcePath, targetPath, callback) {
            ++replaceCalls
            remoteFiles.set(targetPath, remoteFiles.get(sourcePath))
            remoteFiles.delete(sourcePath)
            callback(null)
        },
        end() {},
    })
    t.after(() => {
        sessionManager.getSftp = originalGetSftp
    })

    const existingResponse = await handlers.get('ssh_upload')({
        alias: 'atomic-existing-target',
        localPath,
        remotePath: '/remote/existing.txt',
        atomic: true,
        verifySize: true,
    })
    const existingResult = JSON.parse(existingResponse.content[0].text)
    assert.equal(existingResult.success, true)
    assert.equal(existingResult.targetReplaced, true)
    assert.equal(existingResult.finalRemotePath, '/remote/existing.txt')
    assert.match(existingResult.verifiedTempRemotePath, /\.mcp-tmp-/)
    assert.equal(existingResult.verifiedRemotePath, existingResult.verifiedTempRemotePath)
    assert.equal(existingResult.verification.finalRemotePath, '/remote/existing.txt')
    assert.equal(existingResult.verification.verifiedRemotePath, existingResult.verifiedTempRemotePath)
    assert.equal(existingResult.verification.actual.remotePath, existingResult.verifiedTempRemotePath)
    assert.equal(existingResult.actual.remotePath, existingResult.verifiedTempRemotePath)
    assert.equal(remoteFiles.has(existingResult.verifiedTempRemotePath), false)
    assert.equal(replaceCalls, 1)
    assert.equal(renameCalls, 0)
    assert.equal(remoteFiles.get('/remote/existing.txt').toString(), 'replacement')

    const newResponse = await handlers.get('ssh_upload')({
        alias: 'atomic-new-target',
        localPath,
        remotePath: '/remote/new.txt',
        atomic: true,
    })
    const newResult = JSON.parse(newResponse.content[0].text)
    assert.equal(newResult.success, true)
    assert.equal(newResult.targetReplaced, true)
    assert.equal(replaceCalls, 1)
    assert.equal(renameCalls, 1)
    assert.equal(remoteFiles.get('/remote/new.txt').toString(), 'replacement')
})

test('atomic upload reports an unknown target state when rename commits but its response fails', async (t) => {
    const directory = makeTempDir(t)
    const localPath = path.join(directory, 'source.txt')
    fs.writeFileSync(localPath, 'replacement')
    const remoteFiles = new Map([['/remote/target.txt', Buffer.from('original')]])
    const handlers = new Map()
    registerFileTools({
        registerTool(name, _definition, handler) {
            handlers.set(name, handler)
        },
    })

    const originalGetSftp = sessionManager.getSftp
    sessionManager.getSftp = async () => ({
        _extensions: { 'posix-rename@openssh.com': '1' },
        stat(remotePath, callback) {
            if (remotePath === '/remote') {
                callback(null, { size: 0, mode: 0o040755, uid: 1000, gid: 1000, mtime: 1, atime: 1 })
                return
            }
            const content = remoteFiles.get(remotePath)
            if (content === undefined) {
                callback(Object.assign(new Error('No such file'), { code: 2 }))
                return
            }
            callback(null, {
                size: content.length,
                mode: 0o100644,
                uid: 1000,
                gid: 1000,
                mtime: 1,
                atime: 1,
            })
        },
        createWriteStream(remotePath, options) {
            assert.equal(options.flags, 'wx')
            const chunks = []
            return new Writable({
                write(chunk, _encoding, callback) {
                    chunks.push(Buffer.from(chunk))
                    callback()
                },
                final(callback) {
                    remoteFiles.set(remotePath, Buffer.concat(chunks))
                    callback()
                },
            })
        },
        rename() {
            assert.fail('existing atomic target must use the OpenSSH atomic replace extension')
        },
        ext_openssh_rename(sourcePath, targetPath, callback) {
            remoteFiles.set(targetPath, remoteFiles.get(sourcePath))
            remoteFiles.delete(sourcePath)
            callback(new Error('injected lost rename response'))
        },
        unlink(remotePath, callback) {
            if (!remoteFiles.has(remotePath)) {
                callback(Object.assign(new Error('No such file'), { code: 2 }))
                return
            }
            remoteFiles.delete(remotePath)
            callback(null)
        },
        end() {},
    })
    t.after(() => {
        sessionManager.getSftp = originalGetSftp
    })

    const response = await handlers.get('ssh_upload')({
        alias: 'atomic-rename-response-test',
        localPath,
        remotePath: '/remote/target.txt',
        atomic: true,
    })
    const result = JSON.parse(response.content[0].text)

    assert.equal(result.success, false)
    assert.equal(result.transferSuccess, true)
    assert.equal(result.operationStatus, 'unknown')
    assert.equal(result.targetReplaced, null)
    assert.equal(result.targetReplacementStatus, 'unknown')
    assert.equal(result.retryable, true)
    assert.equal(remoteFiles.get('/remote/target.txt').toString(), 'replacement')
})

test('atomic upload reports a definite non-replacement when rename cannot be started', async (t) => {
    const directory = makeTempDir(t)
    const localPath = path.join(directory, 'source.txt')
    fs.writeFileSync(localPath, 'replacement')
    const remoteFiles = new Map([['/remote/target.txt', Buffer.from('original')]])
    const handlers = new Map()
    registerFileTools({
        registerTool(name, _definition, handler) {
            handlers.set(name, handler)
        },
    })

    const originalGetSftp = sessionManager.getSftp
    sessionManager.getSftp = async () => ({
        _extensions: { 'posix-rename@openssh.com': '1' },
        stat(remotePath, callback) {
            if (remotePath === '/remote') {
                callback(null, { size: 0, mode: 0o040755, uid: 1000, gid: 1000, mtime: 1, atime: 1 })
                return
            }
            const content = remoteFiles.get(remotePath)
            if (content === undefined) {
                callback(Object.assign(new Error('No such file'), { code: 2 }))
                return
            }
            callback(null, {
                size: content.length,
                mode: 0o100644,
                uid: 1000,
                gid: 1000,
                mtime: 1,
                atime: 1,
            })
        },
        createWriteStream(remotePath, options) {
            assert.equal(options.flags, 'wx')
            const chunks = []
            return new Writable({
                write(chunk, _encoding, callback) {
                    chunks.push(Buffer.from(chunk))
                    callback()
                },
                final(callback) {
                    remoteFiles.set(remotePath, Buffer.concat(chunks))
                    callback()
                },
            })
        },
        ext_openssh_rename() {
            throw new Error('extension unavailable')
        },
        unlink(remotePath, callback) {
            remoteFiles.delete(remotePath)
            callback(null)
        },
        end() {},
    })
    t.after(() => {
        sessionManager.getSftp = originalGetSftp
    })

    const response = await handlers.get('ssh_upload')({
        alias: 'atomic-rename-not-started',
        localPath,
        remotePath: '/remote/target.txt',
        atomic: true,
    })
    const result = JSON.parse(response.content[0].text)

    assert.equal(result.success, false)
    assert.equal(result.transferSuccess, true)
    assert.equal(result.operationStatus, 'failed')
    assert.equal(result.targetReplaced, false)
    assert.equal(result.targetReplacementStatus, 'not_replaced')
    assert.equal(result.retryable, true)
    assert.equal(remoteFiles.get('/remote/target.txt').toString(), 'original')
    assert.equal(
        Array.from(remoteFiles.keys()).some((remotePath) => remotePath.includes('.mcp-tmp-')),
        false
    )
})

test('atomic upload collision does not delete another operation temporary file', async (t) => {
    const directory = makeTempDir(t)
    const localPath = path.join(directory, 'source.txt')
    fs.writeFileSync(localPath, 'replacement')
    const handlers = new Map()
    registerFileTools({
        registerTool(name, _definition, handler) {
            handlers.set(name, handler)
        },
    })

    const originalGetSftp = sessionManager.getSftp
    let collisionPath
    let unlinkCalls = 0
    sessionManager.getSftp = async () => ({
        _extensions: { 'posix-rename@openssh.com': '1' },
        stat(remotePath, callback) {
            if (remotePath === '/remote') {
                callback(null, { size: 0, mode: 0o040755, uid: 1000, gid: 1000, mtime: 1, atime: 1 })
            } else {
                callback(Object.assign(new Error('No such file'), { code: 2 }))
            }
        },
        createWriteStream(remotePath, options) {
            assert.equal(options.flags, 'wx')
            collisionPath = remotePath
            const stream = new Writable({
                write(_chunk, _encoding, callback) {
                    stream.destroy(Object.assign(new Error('remote path already exists'), { code: 'EEXIST' }))
                    callback()
                },
            })
            return stream
        },
        unlink(_remotePath, callback) {
            ++unlinkCalls
            callback(null)
        },
        end() {},
    })
    t.after(() => {
        sessionManager.getSftp = originalGetSftp
    })

    const response = await handlers.get('ssh_upload')({
        alias: 'atomic-collision-test',
        localPath,
        remotePath: '/remote/target.txt',
        atomic: true,
    })
    const result = JSON.parse(response.content[0].text)

    assert.equal(result.success, false)
    assert.match(result.error, /already exists/)
    assert.match(collisionPath, /\.mcp-tmp-/)
    assert.equal(unlinkCalls, 0)
})

test('directory manifests stream hashes, apply excludes, and compare local with remote output', async (t) => {
    const directory = makeTempDir(t)
    fs.mkdirSync(path.join(directory, 'sub'))
    fs.writeFileSync(path.join(directory, 'sub', 'file name.txt'), 'content')
    fs.writeFileSync(path.join(directory, 'ignored.tmp'), 'ignored')
    const request = { count: true, sha256: true, owner: true, mode: true }
    const exclude = ['*.tmp']

    const local = await createLocalDirectoryManifest(directory, request, exclude)
    const remote = await createRemoteDirectoryManifest(fixtureSftp(), directory, request, exclude)
    const comparison = compareDirectoryManifests(local, remote, request)

    assert.equal(
        local.entries.some((entry) => entry.path === 'ignored.tmp'),
        false
    )
    assert.equal(comparison.matched, true)
    assert.equal(comparison.summary.missing, 0)
})

test('directory mode verification includes setuid, setgid, and sticky bits', async (t) => {
    if (process.platform === 'win32') {
        t.skip('POSIX file modes are not available on Windows')
        return
    }
    const directory = makeTempDir(t)
    const filePath = path.join(directory, 'setuid-file')
    fs.writeFileSync(filePath, 'content')
    fs.chmodSync(filePath, 0o4755)
    const request = { mode: true }
    const local = await createLocalDirectoryManifest(directory, request)
    assert.equal(local.entries.find((entry) => entry.path === 'setuid-file').mode, '4755')
    const remote = await createRemoteDirectoryManifest(fixtureSftp(), directory, request)
    assert.equal(remote.entries.find((entry) => entry.path === 'setuid-file').mode, '4755')

    const withoutSetuid = { ...local, entries: local.entries.map((entry) => ({ ...entry })) }
    withoutSetuid.entries.find((entry) => entry.path === 'setuid-file').mode = '0755'
    const comparison = compareDirectoryManifests(local, withoutSetuid, request)
    assert.equal(comparison.matched, false)
    assert.equal(comparison.checks.mode, false)
    assert.equal(comparison.summary.modeMismatch, 1)
})

// noinspection LongLine — 回归测试标题完整描述两个独立校验维度
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
        t.skip('FIFO and symlink fixtures require POSIX filesystem behavior')
        return
    }
    const root = makeTempDir(t)
    const target = path.join(root, 'target')
    const linkedRoot = path.join(root, 'linked-root')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'file.txt'), 'content')
    // noinspection JSCheckFunctionSignatures — util.promisify 保留 exec 的参数签名
    await exec(`mkfifo ${JSON.stringify(path.join(target, 'pipe'))}`)
    fs.symlinkSync(target, linkedRoot)

    const request = { count: true }
    const local = await createLocalDirectoryManifest(linkedRoot, request)
    const remote = await createRemoteDirectoryManifest(fixtureSftp(), linkedRoot, request)
    const comparison = compareDirectoryManifests(local, remote, request)

    assert.equal(
        local.entries.some((entry) => entry.path === '.'),
        true
    )
    assert.equal(
        remote.entries.some((entry) => entry.path === '.'),
        true
    )
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
    fs.symlinkSync('file.txt', path.join(source, 'file-link.txt'))
    fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nexit 0\n')
    fs.writeFileSync(
        path.join(bin, 'rsync'),
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$MCP_TEST_RSYNC_ARGS"\nprintf "Number of regular files transferred: 1\\n"\n'
    )
    fs.chmodSync(path.join(bin, 'ssh'), 0o755)
    fs.chmodSync(path.join(bin, 'rsync'), 0o755)

    const previousPath = process.env.PATH
    const previousArgsFile = process.env.MCP_TEST_RSYNC_ARGS
    const previousAllowList = process.env.SSH_MCP_FILE_OPS_ALLOW_DIRS
    const originalCapability = sessionManager.getExternalTransferCapability
    const originalExec = sessionManager.exec
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ''}`
    process.env.MCP_TEST_RSYNC_ARGS = argsFile
    delete process.env.SSH_MCP_FILE_OPS_ALLOW_DIRS
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
        if (previousAllowList === undefined) {
            delete process.env.SSH_MCP_FILE_OPS_ALLOW_DIRS
        } else {
            process.env.SSH_MCP_FILE_OPS_ALLOW_DIRS = previousAllowList
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

    const followedResult = await syncFiles('rsync-test', source, '/remote/followed', 'upload', {
        followSymlinks: true,
    })
    const followedArgs = fs.readFileSync(argsFile, 'utf8').split('\n').filter(Boolean)
    assert.equal(followedResult.success, true)
    assert.equal(followedResult.selectedTransport, 'rsync')
    assert.equal(followedArgs.includes('-L'), true)
    assert.equal(followedArgs.includes('--no-links'), false)
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

test('rsync probe and transport reject results from an invalidated SSH session generation', async (t) => {
    const alias = `rsync-generation-${process.pid}`
    const directory = makeTempDir(t)
    const localPath = path.join(directory, 'source.txt')
    fs.writeFileSync(localPath, 'payload')
    const originalCapability = sessionManager.getExternalTransferCapability
    const originalExec = sessionManager.exec
    let resolveFirstProbe
    let execCalls = 0
    sessionManager.getExternalTransferCapability = () => ({
        alias,
        identity: 'old@example.com:22',
        host: 'old.example.com',
        port: 22,
        username: 'tester',
        authMethod: 'agent',
        hasJumpHost: false,
        routeSafeForOpenSsh: true,
        rsyncEligible: true,
        decisionReason: 'direct_ssh_agent_socket',
    })
    sessionManager.exec = async () => {
        ++execCalls
        if (execCalls === 1) {
            return new Promise((resolve) => {
                resolveFirstProbe = resolve
            })
        }
        return {
            success: true,
            stdout: '/usr/bin/rsync\n',
            stderr: '',
            exitCode: 0,
        }
    }
    t.after(() => {
        sessionManager.getExternalTransferCapability = originalCapability
        sessionManager.exec = originalExec
        clearRsyncCache(alias)
    })

    const syncPromise = syncFiles(alias, localPath, '/remote/target.txt', 'upload')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(execCalls, 1)
    clearRsyncCache(alias)
    resolveFirstProbe({
        success: true,
        stdout: '/old/usr/bin/rsync\n',
        stderr: '',
        exitCode: 0,
    })

    await assert.rejects(syncPromise, /changed during rsync setup/)
    const freshProbe = await checkRsync(alias, 10)
    assert.equal(freshProbe.status, 'available')
    assert.equal(execCalls, 2)
})

test(
    'POSIX operation cancellation preserves identity checks and native Shell signals',
    { skip: process.platform !== 'linux', timeout: 15_000 },
    async (t) => {
        const directory = makeTempDir(t)
        const manager = new SessionManager(path.join(directory, 'cancellation.json'))
        t.after(() => manager.operationManager.close())
        manager.getRemotePlatform = () => 'posix'

        for (const shell of ['/bin/sh', '/bin/bash']) {
            for (const processGroup of [false, true]) {
                await t.test(`${shell} processGroup=${processGroup}`, async (t) => {
                    const marker = 'b'.repeat(64)
                    const child = spawn(shell, ['-c', 'exec sleep 30'], {
                        cwd: directory,
                        detached: true,
                        env: { PATH: process.env.PATH, HOME: directory, MCP_SSH_OPERATION_MARKER: marker },
                        stdio: 'ignore',
                    })
                    const closed = new Promise((resolve) => child.once('close', resolve))
                    t.after(async () => {
                        if (child.exitCode === null && child.signalCode === null) {
                            process.kill(-child.pid, 'SIGTERM')
                        }
                        await closed
                    })
                    await new Promise((resolve, reject) => {
                        child.once('spawn', resolve)
                        child.once('error', reject)
                    })
                    manager.exec = async (_alias, command) => {
                        try {
                            const output = await exec(command, { shell, cwd: directory, timeout: 5_000 })
                            return { ...output, success: true, exitCode: 0 }
                        } catch (error) {
                            return { success: false, stdout: error.stdout, stderr: error.stderr, exitCode: error.code }
                        }
                    }

                    const rejected = await manager.cancelRemoteOperation(
                        'owned-operation',
                        child.pid,
                        'c'.repeat(64),
                        processGroup,
                        {}
                    )
                    assert.equal(rejected.success, false)
                    assert.match(rejected.error, /operation marker mismatch/)
                    assert.equal(child.exitCode, null)
                    assert.equal(child.signalCode, null)
                    const cancelled = await manager.cancelRemoteOperation(
                        'owned-operation',
                        child.pid,
                        marker,
                        processGroup,
                        {}
                    )
                    assert.equal(cancelled.success, true, cancelled.error)
                    await closed
                    assert.equal(child.signalCode, 'SIGTERM')
                })
            }
        }
    }
)

test(
    'tracked POSIX operations preserve command exit codes across process groups',
    { skip: process.platform !== 'linux', timeout: 15_000 },
    async (t) => {
        const directory = makeTempDir(t)
        const withoutSetsid = path.join(directory, 'without-setsid')
        fs.mkdirSync(withoutSetsid)
        fs.symlinkSync(fs.realpathSync('/usr/bin/env'), path.join(withoutSetsid, 'env'))
        fs.symlinkSync(fs.realpathSync('/bin/sh'), path.join(withoutSetsid, 'sh'))
        await exec('command -v setsid')

        for (const scenario of ['ordinary', 'session-leader', 'without-setsid']) {
            await t.test(scenario, async (t) => {
                const manager = new SessionManager(path.join(directory, `${scenario}.json`))
                const children = new Set()
                t.after(async () => {
                    for (const child of children) {
                        const closed = new Promise((resolve) => child.once('close', resolve))
                        child.kill('SIGTERM')
                        await closed
                    }
                    await manager.disconnectAll()
                    manager.operationManager.close()
                })
                manager.sessions.set('owned-operation', {
                    client: {
                        end() {},
                        exec(command, _options, callback) {
                            const stream = new Readable({ read() {} })
                            stream.stderr = new Readable({ read() {} })
                            const child = spawn('/bin/sh', ['-c', command], {
                                cwd: directory,
                                detached: scenario === 'session-leader',
                                env: {
                                    PATH: scenario === 'without-setsid' ? withoutSetsid : process.env.PATH,
                                    HOME: directory,
                                    TMPDIR: directory,
                                },
                                stdio: ['ignore', 'pipe', 'pipe'],
                            })
                            children.add(child)
                            child.stdout.on('data', (data) => stream.push(data))
                            child.stderr.on('data', (data) => stream.stderr.push(data))
                            child.on('error', (error) => stream.emit('error', error))
                            child.once('close', (code, signal) => {
                                children.delete(child)
                                stream.emit('close', code, signal)
                                stream.push(null)
                                stream.stderr.push(null)
                            })
                            callback(null, stream)
                        },
                    },
                    config: { host: '127.0.0.1', port: 22, username: 'tester', remotePlatform: 'posix' },
                    connected: true,
                    connectedAt: Date.now(),
                    lastUsedAt: Date.now(),
                    reconnectAttempts: 0,
                    manualClose: false,
                })

                for (const code of [0, 7]) {
                    const operation = await manager.operationStart(
                        'owned-operation',
                        `printf owned-stdout; printf owned-stderr >&2; exit ${code}`
                    )
                    const deadline = Date.now() + 5_000
                    let status = manager.operationStatus(operation.operationId)
                    while (status.finishedAt === null && Date.now() < deadline) {
                        await new Promise((resolve) => setTimeout(resolve, 10))
                        status = manager.operationStatus(operation.operationId)
                    }
                    assert.notEqual(status.finishedAt, null)
                    assert.equal(status.markerVerified, true)
                    assert.equal(status.processGroup, scenario !== 'without-setsid')
                    assert.equal(status.status, code === 0 ? 'completed' : 'failed')
                    assert.equal(status.exitCode, code)
                    const output = manager.operationRead(operation.operationId)
                    assert.equal(output.status, status.status)
                    assert.equal(output.exitCode, code)
                    assert.equal(output.stdout, 'owned-stdout')
                    assert.equal(output.stderr, 'owned-stderr')
                }
            })
        }
    }
)

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
    assert.deepEqual(Object.keys(brief).sort(), ['alias', 'backend', 'connected', 'identity', 'lastUsedAt', 'runAs'])
    assert.equal(brief.backend, 'ssh2')
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
