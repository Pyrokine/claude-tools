# skill-elenchus

Evidence-led code, snapshot and design review for Claude Code. Select the scope, test consequential counterexamples and
receive a conclusion with checkable evidence.

Named after **Elenchus** (ἔλεγχος), the Socratic method of examination and refutation.

## Usage

```text
/elenchus
/elenchus src/core/session.ts
/elenchus mode=full .
/elenchus mode=full src/core/session.ts
/elenchus mode=design Evaluate this caching proposal
```

- **Changes**
    - Selection: `mode=diff` or an ordinary file/directory path
    - Behavior: Review the requested diff and relevant call chains

- **Snapshot**
    - Selection: `mode=full`, “entire file” or “whole repository”
    - Behavior: Inventory and read the snapshot even when the diff is empty

- **Design**
    - Selection: `mode=design` or a design question
    - Behavior: Check goals, constraints, evidence and material tradeoffs

With no arguments, review uses the staged diff when present, otherwise `git diff HEAD`. Untracked source is checked
before an empty diff is declared complete. Full review records reviewed, pending and excluded files rather than equating
an inventory with a complete audit.

## Depth and Cost

L0 follows a clear path. L1 handles meaningful tradeoffs on the main thread. L2 delegates independent scopes or
high-impact disputes when they require separate evidence.

Default L1 uses at most four rounds and no agents. Default L2 uses at most four initial reviewers plus two targeted
verifiers, six agents total at depth one, and a thirty-minute total time budget. Lower caller limits take precedence;
unresolved work remains explicit at the boundary.

The [entry point](SKILL-en.md) defines the complete time, round and token budgets. Verification shares the same budget
as initial review; findings do not automatically spawn arbitration agents. Host completion notifications are used
instead of repeated polling.

## Evidence and Results

- **`runtime_verified`**
    - Establishes: Recorded inputs and commands were executed
    - Remaining scope: Identify mocks, native components and reused runs

- **`source_verified`**
    - Establishes: Source and entry-to-effect call chains support the finding
    - Remaining scope: Preserve untested platform effects

- **`needs_validation`**
    - Establishes: Decisive evidence is absent
    - Remaining scope: Name the missing condition and its decision impact

Verdict and severity are separate fields. A partly confirmed claim keeps its demonstrated failure and limits. Votes,
function-length thresholds and parameter counts do not replace behavioral evidence.

Default output is the conclusion, evidence, consequential tradeoffs and remaining items. Review does not authorize edits
or publication. The [shared contract](prompts/shared-rules.md) defines stable finding IDs, trigger conditions,
verification and limits.

Authorized longer runs use one private, unique run directory:

```text
<host-temp>/skill-elenchus/<project>/runs/<unique-run-id>/
├── coverage.json
├── findings.json
├── review-<scope>.md
├── verify-<id>.md
└── report.md
```

Only records used by the run are created. Small serial analyses can return their result directly.

## Install

Link the module into the user skill directory:

```bash
ln -s /path/to/skill-elenchus ~/.claude/skills/elenchus
```

An independent copy is also supported:

```bash
cp -r skill-elenchus/ ~/.claude/skills/elenchus/
```

Use an unused destination for a new installation. The default entry is Chinese. For an English installation, make an
independent copy and use its `SKILL-en.md` as `SKILL.md`; preserve the repository originals rather than renaming files
through a source symlink.

## Maintain

- **`SKILL.md` / `SKILL-en.md`**
    - Responsibility: Scope, depth, budgets and delivery
    - Validation: Keep behavior and budgets equivalent

- **`prompts/elenchus.md` / `elenchus-en.md`**
    - Responsibility: Serial analysis
    - Validation: Conclusion-first output and shared stopping rules

- **`prompts/shared-rules.md`**
    - Responsibility: Finding and evidence contract
    - Validation: Every expert references this contract

- **`prompts/expert-*.md`**
    - Responsibility: Targeted review focus
    - Validation: Heuristics require actual consequences

- **[examples/sample-output.md](examples/sample-output.md)**
    - Responsibility: Results and scope counterexamples
    - Validation: Distinguish actual execution from source support

Run the documentation contract checks from the repository root:

```bash
node --test skill-elenchus/examples/contract.test.mjs
```

These checks validate references, bilingual budgets and evidence fields. Actual review coverage and findings are
established by each run's source and runtime evidence.

## Inspired By

- [Socrates.SKILL](https://github.com/MoYeRanqianzhi/Socrates.SKILL) — Socratic questioning methodology for AI agents
- [spec_driven_develop](https://github.com/zhu1090093659/spec_driven_develop) — S.U.P.E.R architectural principles
- [Superpowers](https://github.com/obra/superpowers) — Codex agent design patterns

## License

MIT
