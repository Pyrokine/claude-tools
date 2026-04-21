---
name: elenchus
description: Dialectical analysis methodology. Use when the user wants to review code, audit changes, think deeply about a problem, question whether a design is sound, analyze from first principles, get multi-perspective critique, self-iterate and improve a solution, reflect on whether the current approach is right, or check code for issues. Also for Socratic questioning of abstract problems and multi-expert cross-examination of design proposals.
argument-hint: "[analysis target: code changes / design proposal / abstract question]"
---

# Elenchus — Dialectical Analysis Methodology

All work is a dialectical loop: **Thesis (current understanding/plan) → Antithesis (questioning & opposition) →
Synthesis (first principles reduction) → Verification → Closure**

The only difference is depth, adaptively chosen by complexity:

- **L0 Lightweight closure**: Plan is unambiguous → execute → automated verification → close
- **L1 Serial dialectical**: Plan involves trade-offs, wrong choice is costly → main thread dialectical cycle → verify →
  close
- **L2 Parallel dialectical**: Large impact, needs multiple perspectives → multi-expert agents → cross-examination →
  arbitration → close

---

# Step 1: Assess Complexity

Ask one core question about the task: **"If I'm wrong, how costly is it? How quickly will it be discovered?"**

| Assessment                                                                     | Depth  | Proceed to                                 |
|--------------------------------------------------------------------------------|--------|--------------------------------------------|
| Plan is unambiguous, single implementation path                                | **L0** | → Step 2 Lightweight Closure               |
| Multiple options, wrong choice is costly or hard to catch automatically        | **L1** | → Step 3 Read Rules → Step 4 Serial Mode   |
| Large impact, security-sensitive, or needs systematic multi-perspective review | **L2** | → Step 3 Read Rules → Step 4 Parallel Mode |

**Design proposals**: L1 pre-analysis first (2 rounds, engine mode), then L2 parallel mode

Assessment is based on understanding the task's nature, not keywords. The same task may be different levels in different
contexts.

---

# Step 2: L0 Lightweight Closure

For tasks with unambiguous plans and single implementation paths. No rule files loaded, no output directory created.

1. **Execute**: Complete the task directly
2. **Self-check**:
    - Run automated verification tools (lint/compile/test etc., chosen by language and project)
    - Check upstream/downstream impact (call chains, state lifecycle)
    - Ask: "Did I encounter anything unexpected? Did I make any decisions where alternatives existed?"
3. **Closure**:
    - Verification passed + no unexpected decisions → closed
    - Verification failed → fix and re-verify
    - Discovered a decision requiring trade-offs → escalate to L1

---

# Step 3: Read Rules and Project Conventions (L1/L2)

## Read Elenchus Rules

Read the following rule files (relative to this file's directory; if not found, use abbreviated rules at the end of this
file):

| Rule                                         | File                                                         |
|----------------------------------------------|--------------------------------------------------------------|
| Dialectical thinking engine                  | [prompts/elenchus-en.md](prompts/elenchus-en.md)             |
| Shared review discipline                     | [prompts/shared-rules.md](prompts/shared-rules.md)           |
| Expert 1 — Logic & Correctness               | [prompts/expert-logic.md](prompts/expert-logic.md)           |
| Expert 2 — Security & Robustness             | [prompts/expert-security.md](prompts/expert-security.md)     |
| Expert 3 — Architecture & Code Quality       | [prompts/expert-design.md](prompts/expert-design.md)         |
| Expert 4 — Performance & Resource Management | [prompts/expert-perf.md](prompts/expert-perf.md)             |
| Expert 5 — Project Convention Compliance     | [prompts/expert-convention.md](prompts/expert-convention.md) |

L1 only needs the dialectical engine rules. L2 reads all.

## Read Project Conventions

Use Read to read these files (skip silently if not found):

1. `~/.claude/CLAUDE.md` — global conventions
2. `./CLAUDE.md` — project conventions (root)
3. `./.claude/CLAUDE.md` — project conventions (.claude dir)

Combine as `CONVENTIONS`, passed to every expert.

---

# Step 4: Dialectical Analysis (L1/L2)

L2 mode creates output directory:

```
/tmp/skill-elenchus/<project-name>/runs/<YYYYMMDD_HHMMSS>/
```

---

## L1 Serial Mode

Main thread executes the dialectical cycle directly. Runs in engine mode when used for design pre-analysis.

### Execution

Read [prompts/elenchus-en.md](prompts/elenchus-en.md) rules (or use abbreviated rules below), then execute:

1. **Proposition Anchor**: Convert current plan/question into a debatable thesis
2. **Each round**:
    - **Thesis**: One sentence stating current understanding
    - **Antithesis**: Choose most effective question type (Clarification / Assumption Probing / Evidence Probing /
      Perspective Shifting / Consequence Tracing)
    - **Synthesis**: First principles — strip authority and convention; Occam's Razor — rebuild with fewest assumptions
3. **Mutation Guard**: Synthesis must differ from thesis. 2 consecutive no-mutation rounds → declare epistemic boundary
4. Continue until convergence or user interrupts

Use Read/Grep/Glob to verify against actual code/system behavior when applicable.

### Closure

After dialectical convergence:

- If deciding during task execution → execute per conclusion, return to L0 verification
- If standalone analysis → output conclusion

### Output Format

```
## Round N

### Thesis
> [One sentence: current understanding]

### Antithesis
**Question type**: [Clarification / Assumption / Evidence / Perspective / Consequence]

[Questioning process — no length limit]

**Shaken assumption**: [What was undermined]

### Synthesis
**Irreducible facts**:
- [Fact 1]
- [Fact 2]

**Simplest reconstruction**:
> [New understanding — becomes next thesis]

**Mutation**: [Yes: what shifted / No: activating mutation guard]
```

### Engine Mode (internal invocation)

- Run silently, no intermediate output
- Return only final synthesis and key derivation path
- Respect caller's max_rounds and focus scope

---

## L2 Parallel Mode

The dialectical triad parallelized: 5 experts = 5 independent thesis lines, cross-examination = antithesis phase,
arbitration = synthesis phase.

### Parallel-0: Gather Analysis Target

**Code changes** — run the appropriate git command:

| Input            | Command                                                   |
|------------------|-----------------------------------------------------------|
| (no arguments)   | Staged → `git diff --cached`; otherwise → `git diff HEAD` |
| "staged"         | `git diff --cached`                                       |
| "working"        | `git diff`                                                |
| File path        | `git diff HEAD -- <path>`                                 |
| Directory        | `git diff HEAD -- <dir>/`                                 |
| "last N commits" | `git diff HEAD~N..HEAD`                                   |
| "since vX.Y.Z"   | `git diff vX.Y.Z..HEAD`                                   |
| "entire file X"  | Read the full file with Read tool                         |
| Commit hash      | `git show <hash>`                                         |

Also run `git diff --stat`. If the diff is empty, inform the user and stop.

**Design proposals** — run L1 serial pre-analysis first (2 rounds, engine mode), inject the pre-analysis conclusions to
every expert.

### Parallel-1: Thesis — 5 Expert Agents in Parallel

**Execution constraint: MUST use foreground mode (do NOT use `run_in_background`). Wait for all to complete before
proceeding to Parallel-2.**

Spawn 5 expert agents **in parallel** using the Agent tool. Each receives:

1. Shared review discipline (`shared-rules.md`)
2. Expert-specific rules (`expert-<name>.md`)
3. Project conventions (`CONVENTIONS`)
4. Analysis target (diff content or design proposal + pre-analysis conclusions)

| Expert                            | Model      | Rules File             |
|-----------------------------------|------------|------------------------|
| Logic & Correctness               | **opus**   | `expert-logic.md`      |
| Security & Robustness             | **opus**   | `expert-security.md`   |
| Architecture & Code Quality       | **sonnet** | `expert-design.md`     |
| Performance & Resource Management | **sonnet** | `expert-perf.md`       |
| Project Convention Compliance     | **sonnet** | `expert-convention.md` |

#### Expert Prompt Template

```
You are Expert N — <specialty name>.

## Review Discipline

<content of shared-rules.md>

## Your Specific Review Focus

<content of expert-<name>.md>

## Project Conventions

<CONVENTIONS content, or "No project conventions found." if empty>

## Content to Analyze

<diff content or design proposal + Elenchus pre-analysis>

## Instructions

1. Read the CLAUDE.md files yourself using the Read tool for domain-specific rules
2. Analyze every change according to your review focus areas
3. For each issue found, use the [FINDING]...[/FINDING] format exactly
4. Use Read/Grep/Glob tools to check surrounding code, callers, and call chains
5. After finishing, attempt to falsify each finding — remove any you can disprove
6. Search for similar patterns across the entire diff — report all instances
7. No limit on findings. Report everything you find.
8. Return ONLY findings in [FINDING]...[/FINDING] format, with a summary count at the end
```

**Checkpoint:** Save each expert's raw findings to the output directory (`expert-logic.md` etc.). **ALL files must be
written before proceeding to Parallel-2** — Parallel-2's input depends on these files.

### Parallel-2: Antithesis — 5 Cross-Examiners in Parallel

**Execution constraint: MUST use foreground mode (do NOT use `run_in_background`). Wait for all to complete before
proceeding to Parallel-3.**

Spawn 5 cross-examiner agents **in parallel**. Each examines the OTHER 4 experts' findings.

| Cross-Examiner | Reviews From      | Model      |
|----------------|-------------------|------------|
| Cross-1        | Expert 2, 3, 4, 5 | **sonnet** |
| Cross-2        | Expert 1, 3, 4, 5 | **sonnet** |
| Cross-3        | Expert 1, 2, 4, 5 | **sonnet** |
| Cross-4        | Expert 1, 2, 3, 5 | **sonnet** |
| Cross-5        | Expert 1, 2, 3, 4 | **sonnet** |

For each finding, assign a verdict:

- **CONFIRMED** — Agree, optionally add supporting evidence
- **CHALLENGED** — Disagree, must provide counter-evidence from code
- **DEEPENED** — Issue is more severe than originally described

Save to `cross-review.md` in the output directory.

### Parallel-3: Synthesis — Dispute Arbitration

Collect all CHALLENGED findings. For each, enter an arbitration loop:

1. Spawn an **opus** arbitrator agent → SUSTAINED / OVERTURNED
2. If verdict contradicts majority opinion, enter next round (new opus agent evaluates from scratch)
3. Verdict stable for 2 consecutive rounds → convergence; 3 rounds max → mark UNRESOLVED

Save to `disputes.md`.

### Parallel-4: Final Report

Aggregate all results into `report.md`:

```markdown
# Elenchus Analysis Report

**Project**: <project name>
**Scope**: <what was analyzed>
**Date**: <YYYY-MM-DD HH:MM:SS>

## Summary

| Severity | Count |
|---|---|
| CRITICAL | N |
| HIGH | N |
| MEDIUM | N |
| LOW | N |

| Verdict | Count |
|---|---|
| CONFIRMED (unanimous) | N |
| CONFIRMED (majority) | N |
| SUSTAINED (after arbitration) | N |
| DEEPENED | N |
| OVERTURNED | N |
| UNRESOLVED | N |

## CRITICAL Findings
## HIGH Findings
## MEDIUM Findings
## LOW Findings
## Overturned Findings (Reference)
## Unresolved Disputes

## Fix Plan
Ordered by priority, each item includes:
- **Issue**: Corresponding FINDING number and summary
- **Fix instruction**: file:line level specific action
- **Acceptance criteria**: How to verify the fix
- **Next review scope**: Suggested narrowed scope for re-review
```

Terminal output: summary tables + all CRITICAL/HIGH in full + count for rest + report path.

---

# Abbreviated Rules

When rule files are not found, use these:

## Shared Discipline

- Every finding must cite specific file and line
- Code is deterministic — read until certain, never report uncertainty
- Check second-order effects, call chains, state lifecycle
- Self-falsify before reporting; scan for same patterns after finding one
- No limit on finding count. Format:
  `[FINDING] file/line/severity/category/description/evidence/impact/suggestion [/FINDING]`

## Expert 1 — Logic (opus)

Logic errors, boundary conditions, call chain breakage, async correctness, comparison semantics, type safety,
initialization order, idempotency

## Expert 2 — Security (opus)

Injection (command/XSS/SQL), path traversal, SSRF, auth bypass, sensitive data leakage, resource leaks, regex DoS,
concurrency safety, missing timeouts

## Expert 3 — Design (sonnet)

Code smells, over/under-engineering, abstraction mixing, naming, dead code, responsibility boundaries,
coupling/cohesion, conditional complexity, interface design

## Expert 4 — Performance (sonnet)

Algorithm complexity, memory allocation, I/O efficiency, N+1 queries, missing caching, concurrency bottlenecks, memory
leak signals, timeout/retry strategy

## Expert 5 — Convention (sonnet)

CLAUDE.md compliance, naming conventions, error handling patterns, file placement, documentation sync, dead code
cleanup, file formatting

## Elenchus Dialectical Rules

Dialectical cycle: Thesis → Antithesis (5 question types: Clarification, Assumption Probing, Evidence Probing,
Perspective Shifting, Consequence Tracing) → Synthesis (First Principles reduction + Occam's Razor rebuild). Mutation
Guard: 2 consecutive no-mutation rounds → epistemic boundary. Never skip antithesis, never appeal to authority, never
converge prematurely.
