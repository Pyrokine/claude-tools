# Sample Review Output

This is an example of what `/review` produces for a TypeScript project.

---

## Terminal Output (Summary)

```
Code Review Report — mcp-chrome
Scope: git diff HEAD (3 files changed)
Date: 2025-03-27 14:30:00

┌──────────┬───────┐
│ Severity │ Count │
├──────────┼───────┤
│ CRITICAL │     1 │
│ HIGH     │     3 │
│ MEDIUM   │     5 │
│ LOW      │     2 │
│ Total    │    11 │
└──────────┴───────┘

┌─────────────────────────┬───────┐
│ Verdict                 │ Count │
├─────────────────────────┼───────┤
│ CONFIRMED (unanimous)   │     6 │
│ CONFIRMED (majority)    │     2 │
│ SUSTAINED (after dispute│     1 │
│ DEEPENED                │     1 │
│ OVERTURNED              │     1 │
└─────────────────────────┴───────┘

--- CRITICAL ---

[FINDING]
file: src/core/session.ts
line: 142
severity: CRITICAL
category: logic
description: Runtime.Timestamp is already epoch milliseconds, but the code multiplies by 1000, producing timestamps 1000x too large
evidence: `timestamp: Math.round(p.timestamp * 1000),  // Runtime.Timestamp`
impact: All network log timestamps will be in year 50000+, making log correlation impossible
suggestion: Remove the `* 1000`: `timestamp: Math.round(p.timestamp),`
[/FINDING]
→ CONFIRMED by 4/4 cross-reviewers

--- HIGH ---

[FINDING]
file: extension/src/background/actions.ts
line: 287-295
severity: HIGH
category: security
description: RegExp constructed from user input without sanitizing catastrophic backtracking patterns
evidence: `const re = new RegExp(urlPattern);`
impact: Malicious URL pattern like `(a+)+$` can freeze the extension process via ReDoS
suggestion: Detect nested quantifier patterns before constructing RegExp; limit input length
[/FINDING]
→ CONFIRMED by 3/4 cross-reviewers, DEEPENED by Expert 4 (also affects performance)

[... more findings ...]

MEDIUM: 5 findings | LOW: 2 findings
Full report: /tmp/skill-review/mcp-chrome/runs/20250327_143000/review-report.md
```

## Output Directory Structure

```
/tmp/skill-review/mcp-chrome/runs/20250327_143000/
├── diff-stat.txt          # git diff --stat snapshot
├── diff-content.txt       # full diff
├── expert-logic.md        # Expert 1 raw findings
├── expert-security.md     # Expert 2 raw findings
├── expert-design.md       # Expert 3 raw findings
├── expert-perf.md         # Expert 4 raw findings
├── expert-convention.md   # Expert 5 raw findings
├── cross-review.md        # Cross-examination results
├── disputes.md            # Dispute resolution records
└── review-report.md       # Final aggregated report
```

## Dispute Example

```markdown
# Dispute: expert-logic finding at src/tools/input.ts:89

## Original Finding (Expert 1 — Logic)
setTimeout with delay > 2^31-1 ms silently fires immediately in Node.js.
The description says "无上限" but the actual limit is ~24.8 days.

## Challenge (Cross-Reviewer 3)
This is a tool description string, not runtime code. The description
is user-facing documentation. Even if a user sets timeout to 2^31,
the setTimeout behavior is a Node.js platform concern, not a bug
in this code.

## Arbitration — Round 1
SUSTAINED. While the description is documentation, it's misleading
documentation that could lead users to set values causing silent
misbehavior. The code should either document the limit or clamp
the value. The description "无上限" is factually incorrect.

## Arbitration — Round 2 (requested: original finding was about description, not code)
SUSTAINED. The review scope includes documentation correctness.
A description claiming "no limit" when a hard platform limit exists
at 2^31-1 ms is a documentation bug (category: convention, not logic).
Severity downgraded from HIGH to MEDIUM.

Final verdict: SUSTAINED (MEDIUM)
```
