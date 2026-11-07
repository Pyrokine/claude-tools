import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)
const read = (name) => readFileSync(new URL(name, root), 'utf8')
const entries = ['SKILL.md', 'SKILL-en.md']
const evidenceLevels = ['runtime_verified', 'source_verified', 'needs_validation']

function budgets(text) {
    const budgetRow =
        String.raw`^\|\s*(?<depth>L[012])\s*\|\s*(?<rounds>\d+)\s*\|` +
        String.raw`\s*(?<agents>\d+)\s*\|\s*(?<minutes>\d+)\s*\|\s*(?<tokens>\d+)\s*\|$`
    return [...text.matchAll(new RegExp(budgetRow, 'gm'))].map((match) => ({
        depth: match[1],
        maxRounds: Number(match[2]),
        maxAgents: Number(match[3]),
        maxMinutes: Number(match[4]),
        maxTokens: Number(match[5]),
    }))
}

test('both entry points define full, diff and design independently of review depth', () => {
    for (const file of entries) {
        const text = read(file)
        for (const mode of ['mode=diff', 'mode=full', 'mode=design']) {
            assert.ok(text.includes(mode), `${file} lacks ${mode}`)
        }
        assert.match(text, /git ls-files --others --exclude-standard/)
        assert.match(text, /coverage\.json/)
        assert.match(text, /pending/)
        assert.match(text, /excluded/)
        assert.equal(text.match(/^version: (?<version>.+)$/m)?.[1], '1.2.0')
    }
})

test('depth budgets agree and include all review and verification agents', () => {
    const expected = [
        { depth: 'L0', maxRounds: 1, maxAgents: 0, maxMinutes: 5, maxTokens: 5000 },
        { depth: 'L1', maxRounds: 4, maxAgents: 0, maxMinutes: 10, maxTokens: 20000 },
        { depth: 'L2', maxRounds: 4, maxAgents: 6, maxMinutes: 30, maxTokens: 80000 },
    ]
    for (const file of entries) {
        assert.deepEqual(budgets(read(file)), expected)
    }
})

test('all review roles consume the same evidence contract without certainty rules', () => {
    const shared = read('prompts/shared-rules.md')
    for (const value of evidenceLevels) {
        assert.ok(shared.includes(value), `missing evidence level ${value}`)
    }
    for (const field of ['id', 'verdict', 'evidence_level', 'trigger', 'evidence', 'verification', 'limits']) {
        assert.match(shared, new RegExp(`^${field}:`, 'm'))
    }
    for (const file of entries) {
        const text = read(file)
        for (const value of evidenceLevels) {
            assert.ok(text.includes(value), `${file} lacks ${value}`)
        }
        assert.match(text, /prompts\/shared-rules\.md/)
    }
    for (const role of ['logic', 'security', 'design', 'perf', 'convention']) {
        assert.ok(read(`prompts/expert-${role}.md`).includes('shared-rules.md'))
    }
    assert.doesNotMatch(shared, /never\s+report\s+uncertainty|read\s+until\s+certain/i)
})

test('serial engines use bounded conclusion-first output in both languages', () => {
    for (const file of ['prompts/elenchus.md', 'prompts/elenchus-en.md']) {
        const text = read(file)
        assert.match(text, /最多.*4.*轮|maximum.*4.*rounds/i)
        assert.match(text, /结论|conclusion/i)
        assert.match(text, /needs_validation/)
        assert.doesNotMatch(text, /15\s*(?:轮|rounds)|无长度限制|no length limit/i)
    }
})

test('design heuristics require an observable consequence and preserve valid null contracts', () => {
    const text = read('prompts/expert-design.md')
    assert.match(text, /heuristic/i)
    assert.match(text, /observable|maintenance cost/i)
    assert.match(text, /null/)
    assert.doesNotMatch(text, /Don't return null|>3 parameters should be wrapped|>20 lines/)
})

test('document references resolve and sample results use the evidence contract', () => {
    for (const file of [...entries, 'README.md', 'README_zh.md', 'examples/sample-output.md']) {
        const text = read(file)
        for (const match of text.matchAll(/]\((?<target>[^)]+)\)/g)) {
            const target = match[1]
            if (/^[a-z]+:|^#/i.test(target)) {
                continue
            }
            const fileUrl = new URL(target.split('#')[0], new URL(file, root))
            assert.doesNotThrow(() => readFileSync(fileURLToPath(fileUrl)), `${file}: ${target}`)
        }
    }
    const sample = read('examples/sample-output.md')
    for (const level of evidenceLevels) {
        assert.ok(sample.includes(level))
    }
    assert.match(sample, /mode=full/)
    assert.match(sample, /mode=diff/)
    assert.match(sample, /mode=design/)
    assert.doesNotMatch(sample, /CONFIRMED by \d\/\d|5 Cross-Examiners|cross-1\.md.*cross-5\.md/)
})
