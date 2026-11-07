---
name: cc-session-fix
description: >-
  Fix Claude Code session jsonl issues — /resume failures, wrong context after resume, oversized jsonl, "Resume
  cancelled", /compact "Invalid signature in thinking block". Diagnoses uuid chain, compact_boundary and resume leaf
  selection; safely truncates, removes thinking blocks and appends custom-title.
argument-hint: "[session-id or path]"
---

Diagnostic and repair toolkit for Claude Code session JSONL files. Handles `/resume` failures, wrong-anchor recovery,
oversized transcripts and thinking signature errors.

## Scripts

- **[scripts/diagnose.py](scripts/diagnose.py)**: File size, physical line count, UUID chain, compact boundaries,
  inferred resume leaf and truncation recommendation
- **[scripts/truncate.py](scripts/truncate.py)**: Keep first N lines, remove thinking blocks, append custom-title,
  validate the final JSONL and UUID chain; `--new-session` writes a new UUID file and retains the original
- `scripts/session_io.py` shares the standard-library implementation between both entry points; no dependencies to
  install

## Typical workflow

```bash
# 1. target accepts a file path, full session id or prefix
python3 scripts/diagnose.py <session-id-or-path>

# Both full id and prefix lookup stay within the specified project
python3 scripts/diagnose.py <session-id-prefix> --project <project-hash>

# 2. If output shows Recommend: truncate to L<N>, preview retained/removed ranges
python3 scripts/truncate.py <target> --line <N> --title "..." --dry-run

# 3. Stop every Claude Code process writing this session before repairing in place
python3 scripts/truncate.py <target> --line <N> --title "..."

# For an active session, or to retain the original for MCP history search, fork
python3 scripts/truncate.py <target> --line <N> --new-session --title "..."
```

An explicit file path takes precedence over id lookup. Multiple candidates produce an error; use the full id or path.

## When to use

1. **`/resume` fails or cancels**: Check file size and the UUID chain. Above 100MB, inspect size-related failures;
   dangling parentUuid >0 means the chain references records outside this file
2. **Resume restores the wrong history point**: Compare `Resume leaf` with `Dialog tail`. A recommendation requires a
   valid unambiguous chain, retained parents and later physical dialogs, and a non-dialog leaf more than five minutes
   later.
   Dialogs use parsed instants and the later physical row on equality; UUID cycles, duplicates, mixed timezone awareness
   or time regressions require review
   The prefix check covers every valid physical row: later untimed dialogs block the suggestion, and retained rows
   without
   UUIDs still have their parent references checked. Issues identify the affected lines; untimed system metadata stays
   valid
3. **Session missing from the picker**: A trailing custom-title addresses the first-user >15KB head-read issue in
   [Issue #25920](https://github.com/anthropics/claude-code/issues/25920)
4. **File too large or slow to open**: About 10k lines is an empirical reference; choose the retained range from the
   diagnosis and the history needed
5. **`/compact` reports `Invalid signature in thinking block`**: Routing GPT into CC through proxies such as CPA can
   produce empty signatures; oneapi/Bedrock proxies can produce invalid signatures when generation and verification use
   different API keys

    Remove all thinking blocks while retaining text, tool_use, tool_result and other record fields. Thinking-only repair
    preserves existing titles; an explicit `--title` appends a new one. Use the same CLI for preview and publication.

    ```bash
    python3 scripts/truncate.py <target> --strip-thinking --dry-run
    # Stop every writer before in-place repair, or use --new-session to retain the source
    python3 scripts/truncate.py <target> --strip-thinking
    python3 scripts/truncate.py <target> --strip-thinking --new-session
    ```

## Safety and recovery

- Each in-place repair keeps a unique `.bak.<random-id>` backup. POSIX uses an exclusively created hard link to the
  original inode; Windows uses `ReplaceFileW`, with the backup inside a private directory of that name
- Source identity and changes are checked while reading and before publication. Detected source changes stop
  publication. Stop writers before in-place repair; appends to the old inode in the final checking window remain
  recoverable in the backup
- When safe in-place publication primitives are unavailable, use `--new-session`. It creates the new target exclusively.
  A failed write retains the source and reports the error and private failed-file locations
- Inspect the original records at the printed `Backup` path. Stop writers and confirm backup contents before restoring
  the target path
- New, staged and failed files start private: POSIX `0600`, or a protected current-account/SYSTEM DACL on Windows.
  Backups retain the original file's access controls
- Reads and writes use explicit UTF-8. Invalid bytes report their physical line number and retain the source; diagnosis
  continues with subsequent lines
- Diagnosis reports malformed JSON, non-object records and unsupported field types. Repair prints retained/removed
  ranges, refuses invalid retained records, and explicitly reports invalid tail lines selected for removal
- UUID cycles and duplicates set health=needs_review; explicit --line warns about retained chain issues before writing.
  Final output is validated by physical line with LF separators
- A missing leaf or dialog anchor with no diagnosed issue reports unknown; no recommendation alone does not imply health
- `--dry-run` creates no session, backup or staging files

## References and regression tests

- [references/mechanism.md](references/mechanism.md): JSONL structure, `/compact` behavior and leaf inference
- [references/known-issues.md](references/known-issues.md): Relevant GitHub issues
- [TESTING.md](TESTING.md): Regression cases using only isolated HOME directories and synthetic sessions
