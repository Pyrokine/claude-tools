import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const testDirectory = fileURLToPath(new URL('.', import.meta.url))
const testFiles = readdirSync(testDirectory)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => fileURLToPath(new URL(name, import.meta.url)))
if (testFiles.length === 0) {
    throw new Error('No test files found')
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' })
if (result.error) {
    throw result.error
}
process.exitCode = result.status ?? 1
