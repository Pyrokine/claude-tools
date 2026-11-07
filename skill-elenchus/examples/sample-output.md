# Scope and Evidence Examples

These examples define review behavior and illustrative result shapes. They are not execution records for a particular
repository.

## 1 A Clean Snapshot Still Has a Review Target

Input:

```text
/elenchus mode=full .
```

The repository has no staged, unstaged or untracked changes. Full mode still inventories the selected snapshot and
follows its entry points. The report states the pinned commit, files actually reviewed and unresolved coverage.

Illustrative coverage:

```json
{
    "mode": "full",
    "reviewed": ["src/entry.ts", "src/worker.ts"],
    "pending": ["src/export.ts"],
    "excluded": [{ "path": "dist/", "reason": "generated output; source selected for review" }]
}
```

The remaining export file prevents a claim of complete repository coverage. Its presence does not establish a defect.

## 2 A Clean Diff Can Finish Without Reviewing the Snapshot

Input:

```text
/elenchus mode=diff src/
```

The requested diff is empty and no in-scope untracked source remains. Report no changes and stop. Do not reinterpret
this request as a full repository audit.

A new untracked source file is a separate case: identify it before declaring the requested scope empty.

## 3 A Design Heuristic Is Not a Finding

Input:

```text
/elenchus mode=design Assess this optional-value API
```

The proposal uses null for a documented absent value, and its callers handle that state. Null alone is not a defect. A
long function or several related parameters likewise requires a concrete correctness or maintenance consequence before
it becomes a finding.

If an omitted caller decides whether absence is safe, retain needs_validation for that question rather than inventing a
failure or approving the contract without evidence.

## 4 Evidence Levels Describe Different Work

- **`runtime_verified`**
    - Appropriate claim: The stated input caused the recorded failure
    - Record: Exact executed command, result, real components and mocks

- **`source_verified`**
    - Appropriate claim: The reachable implementation violates the stated contract
    - Record: Verified path/line, trigger, consumers and untested native effects

- **`needs_validation`**
    - Appropriate claim: The available material does not decide the critical behavior
    - Record: Missing caller, platform condition or discriminating test

A mocked frame switch can support a source-level identity defect while the real browser's scheduling remains untested. A
cumulative byte calculation describes work performed across iterations, not peak memory.

Reused evidence retains its original provenance. Running a helper does not establish that a public registration passes
the required arguments into it.

## 5 Report Shape

The [shared finding contract](../prompts/shared-rules.md) supplies IDs, verdicts, evidence levels, triggers,
verification and limits. A final report leads with supported conclusions, then groups the evidence and unfinished scope.

For a partly confirmed claim, preserve the demonstrated failure and correct the unsupported condition. For a refuted
claim, retain the counter-evidence. A source defect can be confirmed without claiming an unexecuted native test passed.

A time or agent boundary leaves explicit pending work. It does not authorize discarding lower-severity findings or
starting a new arbitration chain with a fresh budget.

## 6 Contract Checks

From the repository root:

```bash
node --test skill-elenchus/examples/contract.test.mjs
```

The checks validate scope declarations, equivalent bilingual budgets, shared evidence fields, references and these
examples. Actual review findings require source or runtime evidence from the reviewed target.
