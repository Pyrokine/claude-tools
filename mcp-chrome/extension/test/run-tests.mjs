import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const testFile = fileURLToPath(
    new URL('../node_modules/.cache/mcp-chrome-tests/finding-regressions.test.js', import.meta.url)
)
const result = spawnSync(process.execPath, ['--test', testFile], { stdio: 'inherit' })
if (result.error) {
    throw result.error
}
process.exitCode = result.status ?? 1
