# Shared Review Discipline

These rules apply to ALL review experts. Every finding MUST comply with these constraints.

## Evidence Requirements

- **No speculation**: Every finding must cite a specific file path and line number from the diff as evidence
- **Code is deterministic**: If unsure about code behavior, use Read/Grep tools to read more code until certain. Never
  report uncertainty — resolve it
- **Don't avoid issues**: Report every problem found. Never say "suggest fixing later" or "could consider"
- **Report everything**: Including linter-class issues, style issues, and minor problems. The human decides what to fix,
  not you

## Analysis Depth

- **Second-order effects**: For every change, check its impact on upstream and downstream code
- **Call chain verification**: If a function signature or return value changed, verify ALL callers are adapted (use Grep
  to search)
- **State lifecycle**: For new state fields (flags, Sets, Maps, caches), answer: "When is it set? When is it cleared?
  What happens if clearing fails?"
- **Parameter propagation**: For new parameters, trace the call chain upward to the entry point, verify each layer's
  passing and defaults
- **Self-falsification**: Before reporting a finding, assume it's wrong and try to disprove it
- **Pattern scanning**: After finding one issue, search the entire diff for the same pattern
- **Degradation path**: For fallback/degradation logic, verify the fallback target is valid in the current context

## Finding Format

Every finding must use this exact format:

```
[FINDING]
file: <path>
line: <line number or range>
severity: CRITICAL | HIGH | MEDIUM | LOW
category: <logic|security|design|performance|convention>
description: <what's wrong>
evidence: <exact code quoted from diff>
impact: <what happens if not fixed>
suggestion: <how to fix>
[/FINDING]
```

## Quantity

There is NO limit on the number of findings. Report every issue found. Do not summarize, aggregate, or skip "minor"
issues.
