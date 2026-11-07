---
name: elenchus
description:
    Evidence-led dialectical analysis for L1/L2 code, design and decision tasks, with diff/full/design scopes, bounded
    independent review and conclusion-first output
argument-hint: '[mode=diff|full|design] [analysis target] [depth=L0|L1|L2]'
version: 1.2.0
---

# Elenchus — Dialectical Analysis

Test the current understanding against counterexamples, update the conclusion using evidence, then verify its actual
consequences.

Establish the target, current authority and completion conditions first. Scope and depth are separate choices. A review
result does not authorize edits, commits or publication.

## 1 Analysis Scope

- **Current changes, a file or a directory path**
    - Mode: `mode=diff`
    - Collection: Read the requested Git diff and its relevant call chains

- **Entire repository, entire file or fixed-version snapshot**
    - Mode: `mode=full`
    - Collection: Read the snapshot and record file coverage regardless of an empty diff

- **Proposal, requirements, architecture decision or abstract question**
    - Mode: `mode=design`
    - Collection: Read the supplied material, constraints and relevant implementation

An explicit mode takes precedence. Otherwise, infer it from intent: “entire file X” and “whole repository” select
mode=full, a design assessment selects mode=design, and an ordinary path retains mode=diff.

### mode=diff

- **No arguments**
    - Command or action: Staged changes: `git diff --cached`; otherwise `git diff HEAD`
    - Scope: State that staged priority excludes unstaged changes

- **Staged**
    - Command or action: `git diff --cached`
    - Scope: Staged changes only

- **Working tree**
    - Command or action: `git diff`
    - Scope: Unstaged changes only

- **File or directory**
    - Command or action: `git diff HEAD -- <path>`
    - Scope: Pass paths as separate arguments

- **Last N commits**
    - Command or action: `git diff HEAD~N..HEAD`
    - Scope: Verify the requested range exists

- **Since a tag**
    - Command or action: `git diff <tag>..HEAD`
    - Scope: Use an existing tag

- **Commit hash**
    - Command or action: `git show <hash>`
    - Scope: Inspect that commit's changes

Compute statistics for the same diff range rather than substituting repository-wide statistics.

For an empty diff, inspect in-scope untracked files with `git ls-files --others --exclude-standard`, distinguishing new
source from unrelated artifacts. End with “no changes” only when no review target remains; do not silently switch to a
full snapshot review.

### mode=full

1. Pin the actual repository, commit and working-tree state. Read the requested historical version while preserving the
   current tree.
2. Build a bounded file inventory. Include tracked and relevant untracked source in Git repositories; use existing file
   tools for non-Git directories.
3. Record `reviewed`, `pending` and `excluded` in `coverage.json`, with exclusion reasons. Classify dependencies, build
   output and fixtures by their actual relevance.
4. Follow entry points, registrations, adapters and final effects. Snapshot review may cross files along a real call
   chain.
5. At the budget boundary, report actual coverage and pending work. Claim complete coverage only after the relevant
   files and call chains have been examined.

An empty diff does not stop full mode. A file inventory is not evidence of line-by-line review.

### mode=design

Turn the question into a checkable goal, constraints, consequential tradeoffs and failure effects. Reuse existing
implementations and valid evidence. Give a recommendation directly when serial analysis suffices; use L2 only for
independent work that merits delegation.

## 2 Depth and Default Budgets

| depth | max_rounds | max_agents | max_minutes | max_tokens |
| ----- | ---------- | ---------- | ----------- | ---------- |
| L0    | 1          | 0          | 5           | 5000       |
| L1    | 4          | 0          | 10          | 20000      |
| L2    | 4          | 6          | 30          | 80000      |

- L0: Follow a clear path within current authority and check the actual consequences.
- L1: Have the main thread test counterexamples that can change a meaningful decision.
- L2: Use independent scopes or isolate consequential disputes when this adds evidence.

These are totals for one analysis, including review, verification and dispute handling. They do not reset per finding.
An explicit parent budget takes precedence; expanding scope or budget requires current authority.

Default L2 uses at most four initial reviewers and two targeted verifiers, at most six agents in total and depth one.
The main thread handles remaining independent scope. Use fewer agents when sufficient and keep one call chain with one
owner.

Use cumulative actual token statistics when the Host exposes them. Otherwise, record tokens as unmeasured and stop by
the known time, round and agent limits rather than claiming exact token enforcement.

Stop when evidence answers the decision, two rounds add no new evidence, the budget is exhausted or the user stops the
work. Retain unresolved states and the next discriminating evidence requirement instead of inventing assumptions to fill
rounds.

## 3 Rules and Conventions

Reuse complete, applicable rules already in context. Read missing parts as needed rather than reloading all material per
round or agent.

- **Serial engine**
    - File: [prompts/elenchus-en.md](prompts/elenchus-en.md)
    - Application: L1 and design assessment

- **Evidence, identity and output contract**
    - File: [prompts/shared-rules.md](prompts/shared-rules.md)
    - Application: Every reviewer and verifier

- **Correctness**
    - File: [prompts/expert-logic.md](prompts/expert-logic.md)
    - Application: Call chains, async behavior, boundaries and state

- **Security**
    - File: [prompts/expert-security.md](prompts/expert-security.md)
    - Application: Actual trust boundaries and data effects

- **Design**
    - File: [prompts/expert-design.md](prompts/expert-design.md)
    - Application: Observable complexity and maintenance costs

- **Performance**
    - File: [prompts/expert-perf.md](prompts/expert-perf.md)
    - Application: Supported work and resource growth

- **Project conventions**
    - File: [prompts/expert-convention.md](prompts/expert-convention.md)
    - Application: Applicable explicit project requirements

Use loaded global, project and target-directory instructions. Read existing instruction files when needed. Give
independent reviewers only the constraints, paths and evidence they need; keep credentials in their authorized channel.

If a rule file is unavailable, state the missing input while retaining this entry's scope, budget, evidence and
authority requirements. Do not substitute contradictory abbreviated rules.

## 4 Analysis and Falsification

### L0 / L1

Identify the proposition and select clarification, assumption probing, evidence probing, perspective shifting or
consequence tracing that can change it. Check source, logs or a controlled counterexample and update the affected claim.

Use actual supported constraints. Constants, null, function length, parameter count and file length are investigation
cues that require a concrete error, interface consequence or maintenance cost.

Default output is the recommendation, evidence, consequential tradeoffs and unfinished work. Expand checkable decision
reasons when requested. Internal and direct invocation use the same evidence standard.

### L2

1. Before delegation, fix independent scope, file ownership, total budget, stopping conditions, deduplication key and
   return format. Reuse verified evidence rather than reviewing it again.
2. Assign non-overlapping modules or responsibilities, selecting expert rules as needed. Inherit the Host model
   configuration; leaf agents do not delegate.
3. Retain original finding IDs and real call chains. Deduplicate by file/symbol, trigger and failure effect while
   preserving provenance.
4. Reserve independent falsification for high-impact disputes that can change the decision. Findings do not
   automatically spawn reviewers.
5. Evidence determines the verdict. Vote counts do not replace counterexamples, source or runtime records. Retain
   needs_validation when decisive evidence is absent.
6. Use supported completion notifications and waits. Consume valid returned results without repeatedly waking completed
   owners or polling.

When authorized to save analysis material, use a private temporary directory and one unique run ID shared by all
records. Otherwise, return actual coverage and results directly.

```text
<host-temp>/skill-elenchus/<project>/runs/<unique-run-id>/
├── coverage.json
├── findings.json
├── review-<scope>.md
├── verify-<id>.md
└── report.md
```

Create only the records the run needs. Do not fabricate verification files when no verifier ran; retain pending scopes
in coverage.

## 5 Evidence and Delivery

Keep verdict and evidence strength separate. [shared-rules.md](prompts/shared-rules.md) defines their common format.

- `runtime_verified`: The recorded inputs and commands were executed; identify real components and substituted
  boundaries.
- `source_verified`: Source and call chains support the finding; retain untested native effects as limitations.
- `needs_validation`: Evidence does not decide the essential behavior; name the missing condition.

`confirmed`, `partially_confirmed`, `refuted` and `needs_validation` are verdicts; severity describes impact separately.
Distinguish mocked boundaries, complexity derivations, cumulative copying, peak memory and production latency.

Deliver the conclusion and evidence that changes the next action. Longer reviews include actual coverage, all IDs,
unverified items and the report location. Preserve refuted or narrowed claims without printing round-by-round internal
deliberation.

A review request ends at review. When implementation is authorized, complete necessary callers, tests and documentation
and verify the changed behavior. Reuse applicable evidence for unchanged conditions.

[Output samples and mode counterexamples](examples/sample-output.md)
