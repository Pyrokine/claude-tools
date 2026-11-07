import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDirectory = fileURLToPath(new URL('.', import.meta.url))
const testFiles = readdirSync(testDirectory)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => fileURLToPath(new URL(name, import.meta.url)))
if (testFiles.length === 0) {
    throw new Error('No test files found')
}

const home = mkdtempSync(path.join(os.tmpdir(), 'mcp-ssh-test-home-'))
const env = { ...process.env, HOME: home, USERPROFILE: home, SSH_MCP_TEST_HOME: home }
for (const name of ['SSH_AUTH_SOCK', 'SSH_MCP_TEMPLATES', 'SSH_MCP_ALLOWED_KEY_DIRS', 'SSH_MCP_FILE_OPS_ALLOW_DIRS']) {
    delete env[name]
}
try {
    const result = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit', env })
    if (result.error) {
        throw result.error
    }
    process.exitCode = result.status ?? 1
} finally {
    rmSync(home, { recursive: true, force: true })
}
