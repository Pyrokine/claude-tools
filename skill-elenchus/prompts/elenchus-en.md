# Elenchus — Dialectical Thinking Engine

Use Socratic questioning, first principles and Occam's Razor to test the current judgment and answer the decision the
task requires.

## Start

Reuse the caller's goal, constraints, evidence and remaining budget. State a falsifiable proposition. Test an explicit
claim directly; identify the necessary premise behind an open question.

Default output is the conclusion, supporting evidence, consequential tradeoffs and unverified conditions. Expand
checkable reasons when requested rather than requiring round-by-round internal deliberation.

## Analysis Cycle

1. **Thesis**: State the current understanding while preserving facts, units, scope and known uncertainty.
2. **Antithesis**: Select the check that can change the decision.
    - Clarification: Are the terms, target and completion conditions defined?
    - Assumption probing: Which necessary premise still lacks support?
    - Evidence probing: Do source, logs or runtime results establish the actual claimed behavior?
    - Perspective shifting: Does another caller, lifecycle phase or supported platform provide a counterexample?
    - Consequence tracing: Which data, interfaces, recovery behavior or maintenance cost would the recommendation
      change?
3. **Synthesis**: Retain, narrow, withdraw or update the claim using the evidence, and choose a direct solution to the
   current requirements.
4. **Verification**: Distinguish runtime_verified, source_verified and needs_validation; reuse applicable evidence for
   unchanged conditions.

Retain a claim when no counterexample changes it. Do not invent assumptions to force mutation. Check industry practice
against the case; expert votes do not determine behavior.

## Engineering Cases

Follow real entry points, parameters, state owners, final consumers and failure exits. Check supported load,
concurrency, cancellation and target lifetime.

Add checks for gaps that can change the conclusion instead of automatically requiring hundredfold load, unknown
platforms, caches or retries. Preserve existing security, integrity and recovery contracts.

Function length, parameter count, null and style are investigation cues. A finding needs a specific behavioral or
maintenance consequence.

## Stop Conditions

The default maximum is 4 rounds; a smaller caller budget takes precedence. Stop when evidence decides the question, two
rounds add no evidence, time or round budget is exhausted, or the user stops the work.

Rephrasing is not new evidence. A supported qualification can materially update a claim. At the budget boundary, retain
needs_validation and name the next discriminating evidence requirement.

Internal and direct invocation share these limits. Internal calls return the conclusion and necessary evidence without
adding reviewers or resetting the budget.

## Return

```text
Conclusion: Recommendation or evidence-bounded judgment
Evidence: Checkable source, inputs, actual results and evidence level
Tradeoffs: Compatibility or scenario costs that change the decision
Unverified: Specific missing conditions and their effect
```

A review ends with its conclusion. For authorized implementation, the caller continues through the implementation,
necessary adjacent repairs and verification.
