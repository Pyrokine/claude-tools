import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { env, execPath } from 'node:process'
import test from 'node:test'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import * as prettier from 'prettier'

const root = fileURLToPath(new URL('.', import.meta.url))
const layoutRules = [
    'no-multiple-empty-lines',
    'lines-between-class-members',
    'padding-line-between-statements',
    'keyword-spacing',
    'space-infix-ops',
    'space-before-blocks',
    'brace-style',
]
const projects = [
    { name: 'mcp-chrome', source: 'src/tools/input.ts', returnAwait: 'error-handling-correctness-only' },
    { name: 'mcp-ssh', source: 'src/session-manager.ts', returnAwait: 'in-try-catch' },
]

async function format(code, filepath) {
    const options = await prettier.resolveConfig(filepath, { editorconfig: true })
    assert.equal(await prettier.resolveConfigFile(filepath), join(root, '.prettierrc'))
    return prettier.format(code, { ...options, filepath })
}

async function assertRoundTrip(eslint, code, filepath) {
    const formatted = await format(code, filepath)
    const [first] = await eslint.lintText(formatted, { filePath: filepath })
    assert.equal(first.errorCount, 0, JSON.stringify(first.messages))
    assert.equal(first.output ?? formatted, formatted, 'ESLint changed Prettier layout')
    const repeated = await format(first.output ?? formatted, filepath)
    const [second] = await eslint.lintText(repeated, { filePath: filepath })
    assert.equal(second.errorCount, 0, JSON.stringify(second.messages))
    assert.equal(second.output ?? repeated, formatted)
    assert.equal(await format(second.output ?? repeated, filepath), formatted)
    return formatted
}

for (const project of projects) {
    const cwd = join(root, project.name)
    const require = createRequire(join(cwd, 'package.json'))
    const { ESLint } = require('eslint')
    const eslint = new ESLint({ cwd, fix: true })
    const lintOnly = new ESLint({ cwd, fix: false })
    const typedFile = join(cwd, project.source)

    test(`${project.name}: effective rules delegate layout and retain quality checks`, async () => {
        for (const filepath of [typedFile, join(cwd, 'test/formatting-sample.js')]) {
            const config = await eslint.calculateConfigForFile(filepath)
            assert.ok(config, `No ESLint configuration for ${filepath}`)
            for (const rule of layoutRules) {
                assert.equal(config.rules[rule]?.[0] ?? 0, 0, rule)
            }
            assert.deepEqual(config.rules.curly, [2, 'all'])
            assert.equal(config.rules['@typescript-eslint/no-unused-vars'][0], 1)
            assert.equal(config.rules['@typescript-eslint/member-ordering'][0], 1)
        }
        const typed = await eslint.calculateConfigForFile(typedFile)
        assert.equal(typed.rules['@typescript-eslint/no-floating-promises'][0], 2)
        assert.deepEqual(typed.rules['@typescript-eslint/return-await'], [2, project.returnAwait])
        const installed = require('prettier/package.json')
        assert.equal(installed.version, prettier.version)
        assert.equal(prettier.version, '3.9.5')
    })

    test(`${project.name}: JS, TS, MJS and CJS round trips preserve layout and member order`, async () => {
        const code = `import { join } from "node:path"
export class Example {
first = "value"
second = this.first
quote = "can't"
getValue() { return join(this.second, "ok") }
}`
        for (const filepath of [
            join(cwd, 'test/formatting-sample.js'),
            typedFile,
            join(cwd, 'test/formatting-sample.mjs'),
        ]) {
            const formatted = await assertRoundTrip(eslint, code, filepath)
            assert.ok(formatted.includes("first = 'value'"))
            assert.ok(formatted.includes(`quote = "can't"`))
            assert.ok(formatted.indexOf("first = 'value'") < formatted.indexOf('second = this.first'))
            const firstLine = formatted.split('\n')[0]
            assert.equal(firstLine.endsWith(';'), filepath.endsWith('.js'))
        }
        const commonjs = await assertRoundTrip(
            eslint,
            'function value() { return "example" } value()',
            join(cwd, 'test/formatting-sample.cjs')
        )
        assert.ok(commonjs.includes("return 'example'\n"))
        assert.equal(commonjs.includes(';'), false)
    })

    test(`${project.name}: semantic fixes settle once and diagnostics remain enabled`, async () => {
        const filepath = join(cwd, 'test/formatting-sample.js')
        const code = await format('export function enabled(value) { if (value) return true; return false; }', filepath)
        const [before] = await lintOnly.lintText(code, { filePath: filepath })
        assert.ok(before.messages.some((message) => message.ruleId === 'curly' && message.severity === 2))
        const [fixed] = await eslint.lintText(code, { filePath: filepath })
        assert.equal(fixed.errorCount, 0)
        assert.notEqual(fixed.output, undefined)
        await assertRoundTrip(eslint, fixed.output, filepath)

        const [unused] = await lintOnly.lintText('export function value() { const unused = 1; return 42; }', {
            filePath: filepath,
        })
        assert.ok(unused.messages.some((message) => message.ruleId === '@typescript-eslint/no-unused-vars'))
        const [promise] = await lintOnly.lintText('export function consume(value: Promise<void>) { value; }', {
            filePath: typedFile,
        })
        assert.ok(
            promise.messages.some(
                (message) => message.ruleId === '@typescript-eslint/no-floating-promises' && message.severity === 2
            )
        )
    })

    test(`${project.name}: real source and test files remain unchanged through both tools`, async () => {
        const testFile = project.name === 'mcp-chrome' ? 'test/review-input.test.js' : 'test/host-key.test.mjs'
        for (const filepath of [typedFile, join(cwd, testFile)]) {
            const code = await readFile(filepath, 'utf8')
            const formatted = await assertRoundTrip(eslint, code, filepath)
            assert.equal(formatted, code, filepath)
            assert.equal(await readFile(filepath, 'utf8'), code)
        }
    })
}

test('.prettierrc remains strict JSON under its own formatting rules', async () => {
    const filepath = join(root, '.prettierrc')
    const code = await readFile(filepath, 'utf8')
    const configuration = JSON.parse(code)
    const options = await prettier.resolveConfig(filepath, { editorconfig: true })
    assert.equal(options.parser, 'json')
    const formatted = await format(code, filepath)
    assert.deepEqual(JSON.parse(formatted), configuration)
    assert.equal(formatted, code)
    assert.equal(await format(formatted, filepath), code)
})

test('HTML, CSS, JSON, YAML and Markdown use the same formatter configuration', async () => {
    const examples = [
        ['sample.html', "<button class='example'>Save</button>", 'class="example"'],
        ['sample.css', '.example { font-family: "Example Font"; color: red; }', "'Example Font'"],
        ['sample.json', '{"example":true}', '"example": true'],
        ['sample.yaml', 'example: [one,two]', 'example: [one, two]'],
        [
            'sample.md',
            'A paragraph\nwith an intentional break.\n\n```js\nconst value="sample"\n```\n',
            'const value="sample"',
        ],
    ]
    for (const [filename, code, expected] of examples) {
        const filepath = join(root, filename)
        const formatted = await format(code, filepath)
        assert.ok(formatted.includes(expected), filename)
        assert.equal(await format(formatted, filepath), formatted)
        if (filename.endsWith('.md')) {
            assert.ok(formatted.includes('A paragraph\nwith an intentional break.'))
        }
    }
})

const publicFixtures = new Map([
    ['package.json', '{"private":true}'],
    ['.github/workflows/formatting-sample.yml', 'name:   sample\n'],
    ['mcp-chrome/package.json', '{"private":true}'],
    ['mcp-chrome/eslint.config.js', 'export default []\n'],
    ['mcp-chrome/extension/manifest.json', '{"name":"sample"}'],
    ['mcp-chrome/extension/iframe-content.html', "<button class='sample'>Save</button>"],
    ['mcp-chrome/extension/test-csp-page.html', "<button class='sample'>Save</button>"],
    ['mcp-chrome/extension/test-page.html', "<button class='sample'>Save</button>"],
    ['mcp-ssh/package.json', '{"private":true}'],
    ['mcp-ssh/eslint.config.js', 'export default []\n'],
    ['skill-elenchus/README.md', '#   Example\n'],
])
const ignoredDirectories = [
    '.ccg',
    '.claude',
    '.antigravitycli',
    '.baidu-cc',
    '.idea',
    '.vscode',
    'node_modules',
    'dist',
    'target',
    'out',
    'coverage',
    'test-output',
    '.nyc_output',
    '.ruff_cache',
    '__pycache__',
    '.chrome-mcp-profile',
    '.ssh-mcp-pro',
].flatMap((directory) => [directory, `mcp-chrome/extension/${directory}`, `mcp-ssh/${directory}`])

async function createFormattingSandbox(t) {
    const sandbox = await mkdtemp(join(tmpdir(), 'claude-tools-format-'))
    t.after(() => rm(sandbox, { recursive: true, force: true }))
    for (const filename of ['.prettierrc', '.editorconfig', '.gitignore', '.prettierignore']) {
        await copyFile(join(root, filename), join(sandbox, filename))
    }
    for (const directory of ignoredDirectories) {
        await mkdir(join(sandbox, directory), { recursive: true })
        await writeFile(join(sandbox, directory, 'invalid.json'), '{ intentionally invalid')
    }
    for (const [filename, code] of publicFixtures) {
        await mkdir(dirname(join(sandbox, filename)), { recursive: true })
        await writeFile(join(sandbox, filename), code)
    }
    for (const directory of ['.', 'mcp-chrome', 'mcp-ssh']) {
        await writeFile(join(sandbox, directory, 'package-lock.json'), '{ intentionally invalid')
    }
    return sandbox
}

for (const directory of ['.', 'mcp-chrome', 'mcp-ssh']) {
    test(`${directory}: CLI coverage, exclusions and repeated formatting agree`, async (t) => {
        const sandbox = await createFormattingSandbox(t)
        const { scripts } = JSON.parse(await readFile(join(root, directory, 'package.json'), 'utf8'))
        const scope = directory === '.' ? '.' : '. --ignore-path ../.gitignore --ignore-path ../.prettierignore'
        assert.equal(scripts.format, `prettier --write ${scope}`)
        assert.equal(scripts['format:check'], `prettier --check ${scope}`)
        const run = (script) => {
            const result = spawnSync(
                execPath,
                [join(root, 'node_modules/prettier/bin/prettier.cjs'), ...script.split(' ').slice(1)],
                {
                    cwd: join(sandbox, directory),
                    encoding: 'utf8',
                }
            )
            assert.ifError(result.error)
            return result
        }
        const selected = [...publicFixtures.keys()].filter(
            (filename) => directory === '.' || filename.startsWith(`${directory}/`)
        )
        const before = run(scripts['format:check'])
        assert.equal(before.status, 1, before.stdout + before.stderr)
        const output = (before.stdout + before.stderr).replaceAll('\\', '/')
        for (const filename of selected) {
            assert.ok(output.includes(directory === '.' ? filename : filename.slice(directory.length + 1)), filename)
        }
        const written = run(scripts.format)
        assert.equal(written.status, 0, written.stdout + written.stderr)
        const formatted = await Promise.all(selected.map((filename) => readFile(join(sandbox, filename), 'utf8')))
        const configuration = await readFile(join(sandbox, '.prettierrc'), 'utf8')
        assert.deepEqual(JSON.parse(configuration), JSON.parse(await readFile(join(root, '.prettierrc'), 'utf8')))
        const checked = run(scripts['format:check'])
        assert.equal(checked.status, 0, checked.stdout + checked.stderr)
        const repeated = run(scripts.format)
        assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr)
        assert.deepEqual(
            await Promise.all(selected.map((filename) => readFile(join(sandbox, filename), 'utf8'))),
            formatted
        )
        assert.equal(await readFile(join(sandbox, '.prettierrc'), 'utf8'), configuration)
        for (const ignored of ignoredDirectories) {
            assert.equal(await readFile(join(sandbox, ignored, 'invalid.json'), 'utf8'), '{ intentionally invalid')
        }
        for (const [filename, code] of publicFixtures) {
            if (!selected.includes(filename)) {
                assert.equal(await readFile(join(sandbox, filename), 'utf8'), code, filename)
            }
        }
    })
}

test('real extension root HTML files already match the fixed configuration', async () => {
    for (const filename of ['iframe-content.html', 'test-csp-page.html', 'test-page.html']) {
        const filepath = join(root, 'mcp-chrome/extension', filename)
        const code = await readFile(filepath, 'utf8')
        assert.equal(await format(code, filepath), code, filename)
        assert.equal(await format(await format(code, filepath), filepath), code, filename)
    }
})

test('Git checkout retains LF for formatter text and preserves binary content', () => {
    const git = (args) => {
        const result = spawnSync('git', args, { cwd: root, timeout: 10000 })
        assert.ifError(result.error)
        assert.equal(result.status, 0, result.stderr.toString())
        return result.stdout
    }
    const checkout = (filename) =>
        git([
            '-c',
            'core.autocrlf=true',
            '-c',
            'core.eol=crlf',
            'cat-file',
            '--filters',
            `--path=${filename}`,
            `HEAD:${filename}`,
        ])
    for (const filename of [
        '.prettierrc',
        'README.md',
        'mcp-chrome/package.json',
        'mcp-chrome/extension/iframe-content.html',
        'mcp-chrome/extension/src/popup/popup.css',
        '.github/workflows/windows-tests.yml',
    ]) {
        const content = checkout(filename)
        assert.ok(content.includes(10), filename)
        assert.equal(content.includes(13), false, filename)
    }
    const image = 'mcp-chrome/extension/public/icons/icon16.png'
    assert.deepEqual(checkout(image), git(['cat-file', 'blob', `HEAD:${image}`]))
})

test('Stylelint fixes agree with Prettier and retain CSS error checks', async () => {
    const cwd = join(root, 'mcp-chrome/extension')
    const require = createRequire(join(cwd, 'package.json'))
    const { default: stylelint } = await import(pathToFileURL(require.resolve('stylelint')).href)
    const codeFilename = join(cwd, 'formatting-sample.css')
    const code = await format(
        `.example { color: red; font-family: "Example Font", sans-serif; content: "can't"; }`,
        codeFilename
    )
    const options = { cwd, codeFilename, configFile: join(cwd, '.stylelintrc.json'), fix: true }
    const first = await stylelint.lint({ ...options, code })
    assert.equal(first.errored, false, first.report)
    assert.equal(first.code, code)
    const repeated = await format(first.code, codeFilename)
    const second = await stylelint.lint({ ...options, code: repeated })
    assert.equal(second.errored, false, second.report)
    assert.equal(second.code, code)
    // noinspection SpellCheckingInspection -- 故意使用无效 CSS 属性，验证 Stylelint 仍会报错
    const invalid = await stylelint.lint({ ...options, code: '.example { colro: red; }', fix: false })
    assert.equal(invalid.errored, true)
    assert.ok(invalid.results[0].warnings.some((warning) => warning.rule === 'property-no-unknown'))
})

test('formatter dependencies load through paths containing URL characters', async (t) => {
    const sandbox = await mkdtemp(join(tmpdir(), 'claude-tools-format-import-'))
    t.after(() => rm(sandbox, { recursive: true, force: true }))
    const linked = join(sandbox, '格式 tools # %')
    await symlink(root, linked, 'junction')
    const environment = { ...env }
    // 子进程独立执行测试，清除父级测试运行器的内部上下文
    delete environment.NODE_TEST_CONTEXT
    const result = spawnSync(
        execPath,
        [
            '--preserve-symlinks',
            '--preserve-symlinks-main',
            '--test',
            '--test-reporter=tap',
            '--test-name-pattern=^Stylelint fixes agree with Prettier and retain CSS error checks$',
            join(linked, 'formatting.test.mjs'),
        ],
        { cwd: linked, env: environment, encoding: 'utf8', timeout: 60000 }
    )
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /^# pass 1$/m)
})

test('printWidth preserves complete long URL values', async () => {
    const url = `https://example.com/${'a'.repeat(140)}`
    const code = await format(`export const endpoint = '${url}'`, join(root, 'sample.ts'))
    assert.ok(code.includes(`'${url}'`))
    assert.ok(code.split('\n').some((line) => line.length > 120))
    assert.equal(await format(code, join(root, 'sample.ts')), code)
})
