---
name: cc-session-fix
description: Fix Claude Code session jsonl issues — /resume failures, wrong context after resume, oversized jsonl, "Resume cancelled". Diagnoses uuid chain, compact_boundary, resume leaf selection; safely truncates and appends custom-title. Use when user says resume fails, resume restores wrong point, jsonl too large, resume hangs.
argument-hint: "[session-id or path]"
---

Diagnostic and repair toolkit for Claude Code session jsonl files. Handles /resume failures, wrong-anchor recovery,
oversized transcripts.

## Scripts

- **[scripts/diagnose.py](scripts/diagnose.py)** — Inspect a jsonl: size, line count, uuid chain integrity,
  compact_boundary positions, inferred resume leaf, truncation recommendation
- **[scripts/truncate.py](scripts/truncate.py)** — Safe truncation: auto-backup, keep first N lines, append
  custom-title, verify uuid chain; supports `--new-session` to fork into a new UUID while keeping the original file

## Typical Workflow

```bash
# 1. Diagnose. target can be full path or session-id prefix (auto-resolves under ~/.claude/projects/)
scripts/diagnose.py <session-id-or-path>

# 2. If output shows "Recommend: truncate to L<N>", preview with dry-run
scripts/truncate.py <target> --line <N> --title "..." --dry-run

# 3. Commit (creates .bak.<timestamp> backup automatically)
scripts/truncate.py <target> --line <N> --title "..."

# Optional: keep original intact (e.g. for MCP history search) and write to a fresh UUID
scripts/truncate.py <target> --line <N> --new-session --title "..."
```

## When to Use

1. **/resume fails or cancels** — check file size and uuid chain. >100MB is a size issue; dangling parentUuid >0 is a
   chain break
2. **Resume restores wrong history point** — look at `Resume leaf` vs `Dialog tail`. If leaf is a `system` message well
   after the last dialog, truncate to dialog tail
3. **Session missing from picker** — likely [Issue #25920](https://github.com/anthropics/claude-code/issues/25920)
   head-read bug (first user >15KB). truncate auto-appends custom-title to bypass
4. **File too large / slow to open** — truncate to ~10k lines (empirical ceiling before CC re-compacts)

## References

- [references/mechanism.md](references/mechanism.md) — jsonl structure, /compact behavior, CC's actual resume-leaf
  selection logic
- [references/known-issues.md](references/known-issues.md) — relevant GitHub issue catalog

## Safety

- truncate.py writes `.bak.<YYYYMMDDHHMMSS>` before overwriting in place
- `--dry-run` previews without writing
- Every operation verifies uuid chain and reports dangling count
