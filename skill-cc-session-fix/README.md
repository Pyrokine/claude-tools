# skill-cc-session-fix

Diagnostic and repair toolkit for Claude Code session JSONL files. Fixes `/resume` failures, wrong-anchor recovery,
oversized transcripts.

## Why

Claude Code stores every session as `~/.claude/projects/<hash>/<uuid>.jsonl`. Long-running sessions accumulate:

- `/compact` boundaries that **break timestamp monotonicity** (CC replays summarized history with earlier timestamps
  after the boundary)
- Failed `/resume` attempts that **append `system` messages at the file tail** whose parentUuid latches onto old leaves
- Large tool results (>500KB per line) that **hang session deserialization**
- First `user` messages >15KB that make the session **invisible in the picker**
  ([Issue #25920](https://github.com/anthropics/claude-code/issues/25920))

Observation: **CC picks the anchor for `/resume` by scanning the file from the physical tail backwards**, not by
timestamp. So file layout determines what `/resume` restores to — not "the latest conversation".

This skill gives two scripts to diagnose and fix that layout safely.

## Install

### Symlink (recommended, auto-updates with repo)

```bash
ln -s /path/to/skill-cc-session-fix ~/.claude/skills/cc-session-fix
```

### Copy

```bash
cp -r skill-cc-session-fix/ ~/.claude/skills/cc-session-fix/
```

### English version

Default `SKILL.md` is Chinese. Switch to English:

```bash
cd ~/.claude/skills/cc-session-fix
mv SKILL.md SKILL-zh.md
mv SKILL-en.md SKILL.md
```

## Usage

### Diagnose

```bash
scripts/diagnose.py <session-id-prefix>   # auto-resolve under ~/.claude/projects
scripts/diagnose.py /path/to/file.jsonl
scripts/diagnose.py <id> --project <project-hash>
scripts/diagnose.py <target> --json       # machine-readable
```

Example output:

```
File        : ~/.claude/projects/.../677538d9-....jsonl
Size        : 36,901,996 bytes (35.2 MB)
Lines       : 10,009 total, 10,009 parsed
Input issue : L10003: 144 UUID leaves; review branches before selecting a truncation line

UUID chain  : 4,790 uuids, 0 dangling parentUuid, 144 leaf

Dialog tail : L6318 2026-04-23T13:55:43

Compact     : 21 boundary marker(s) at L[682, 1064, 1346, 1763, 2454]...
              CC replays history after boundary — post-boundary rows may have out-of-order timestamps

Resume leaf : L10003 2026-04-23T15:03:14 system uuid=d6e525ee
              preview: [system:local_command]
              ↑ this is the leaf CC will anchor /resume to

Health      : needs review — no heuristic truncation recommendation; inspect leaf, chain and input issues
```

### Truncate

```bash
scripts/truncate.py <target> --line <N> --title "..." --dry-run    # preview
scripts/truncate.py <target> --line <N> --title "..."              # in-place, auto-backup
scripts/truncate.py <target> --line <N> --title "..." --new-session # fork to fresh UUID
```

Stop every process writing the session before repairing in place. For an active session, use `--new-session`; it leaves
the source path untouched. A change detected during reading or preparation refuses publication, so retry from a fresh
diagnosis.

- Each in-place repair preserves a unique `.bak.<random-id>` backup, printed as `Backup`
- POSIX creates an exclusive hard link to the original inode before atomic replacement; appends to an old open file
  descriptor in the final checking window remain recoverable in that backup
- Windows uses `ReplaceFileW` with the original file as backup inside a uniquely created private directory
- If safe in-place publication primitives are unavailable, use `--new-session`; the new target is created exclusively,
  without requiring hard links
- Appends `{"type":"custom-title", ...}` at the tail and ensures every physical record has an LF separator, including an
  input missing its final LF
- Optionally rewrites existing `sessionId` fields (`--new-session`) and reports UUID chain integrity before writing

`--project` confines both full-id and prefix lookup to that project. An explicit existing file path still takes
precedence; ambiguous id matches produce an error. Cross-project file symlinks are excluded from project-scoped id
lookup.

### Remove thinking blocks

For `/compact` errors reporting `Invalid signature in thinking block`, remove all thinking blocks, including non-empty
invalid signatures. Text, tool calls, tool results and unknown record fields are retained.

```bash
python3 scripts/truncate.py <target> --strip-thinking --dry-run
# Stop all writers before an in-place repair
python3 scripts/truncate.py <target> --strip-thinking
# Or retain the source and create a new UUID file
python3 scripts/truncate.py <target> --strip-thinking --new-session
```

`--strip-thinking` also accepts `--line`, `--project`, `--title` and `--new-session`. Thinking-only repair preserves
existing titles; pass `--title` to append a new one. It uses the same validation, backup and publication path as
truncation.

### Input, permissions and recovery

JSONL is read and written as UTF-8 regardless of the locale. Diagnosis reports malformed JSON, invalid record shapes,
field-type errors and invalid bytes with physical line numbers, then continues. `--json` retains the original diagnostic
fields and adds `issues` and `health`. Duplicate UUIDs and parent cycles report their physical lines and set
`health=needs_review`, including cycles that still have a leaf. Missing anchors with no diagnosed issue report
`unknown`.

Dialog timestamps are compared as parsed instants; equal times select the later physical dialog while retaining its
original timestamp text. The inferred resume leaf still follows physical order. Automatic truncation requires an
unambiguous valid chain and a non-dialog tail more than five minutes later. Multiple leaves, mixed timezone awareness,
later dialogs with earlier times, or parents outside the proposed prefix require review instead of a recommendation.
The prefix check includes every valid physical row. Later dialogs without timestamps block the suggestion, including
missing, null and empty timestamp fields. Retained parent references are checked even on rows without UUIDs, with the
record and excluded parent lines reported. Untimed system metadata remains valid.
Explicit `--line` remains available; retained cycles and duplicate UUIDs produce warnings before writing.

Repair prints the retained/removed ranges and invalid-record counts. Invalid retained records refuse publication.
Invalid tail records explicitly selected for removal are reported, and the original remains available in the backup or
source file. Invalid UTF-8 anywhere refuses a repair. Unknown fields are preserved. `--dry-run` creates no session,
backup or staging files.

New, staged and failed files are private from creation: POSIX `0600`, or a protected current-account/SYSTEM DACL on
Windows. In-place backups retain the original file's access controls. A failed publication reports the private stage and
any recovery path; inspect them before retrying. If a new session has been written but stage cleanup fails, the command
keeps the successful result and reports a cleanup warning. Stop writers, inspect the printed `Backup` file and confirm
its contents before restoring the session path.

Diagnosis retains chain metadata and loads only the selected leaf preview on demand. Truncation streams the selected
lines to a private stage, validates the final physical JSONL and publishes it without holding all message payloads in
memory.

## Regression tests

Python 3.8 or later is required. Tests use synthetic JSONL under isolated HOME directories, including native Windows
DACL and replacement cases when run on Windows.

```bash
python3 -I -B scripts/test_session_fix.py -v
ruff check --no-cache --target-version py38 scripts/
```

See [TESTING.md](TESTING.md) for reusable cases and platform prerequisites.

## Typical Scenarios

- `Resume cancelled`: Check file size; if >100MB, truncate to ~10k lines

- Resume restores wrong history: Use the recommended line when present; review chain and branch issues before choosing a
  manual `--line`

- Session missing from picker: [Issue #25920](https://github.com/anthropics/claude-code/issues/25920); truncate
  auto-appends custom-title

- Want original preserved for MCP history search: Use `--new-session` to fork into a new UUID

- Dangling parentUuid: Diagnose reports count; may need manual edit of first-line parentUuid to `null`

## Known Issues Covered

See [references/known-issues.md](references/known-issues.md) for the full catalog. Highlights:

- [#22566](https://github.com/anthropics/claude-code/issues/22566) — standard truncation recovery pattern
- [#22526](https://github.com/anthropics/claude-code/issues/22526) — phantom parentUuid
- [#25920](https://github.com/anthropics/claude-code/issues/25920) — head-read bug for >15KB first prompts
- [#21067](https://github.com/anthropics/claude-code/issues/21067) — oversized tool_result hangs resume
- [#36583](https://github.com/anthropics/claude-code/issues/36583) — file-history-snapshot uuid collision

## Mechanism

See [references/mechanism.md](references/mechanism.md) for the observed behavior model:

- JSONL line order ≠ timestamp order (/compact rewrites history)
- CC selects `/resume` anchor by **physical file tail**, not timestamp
- 1-2 line rule for custom-title placement

## Inspired By

- [mason0510/fix-jsonl](https://github.com/mason0510/fix-jsonl) — JSONL cleanup (complementary focus on bloat)
- Community workaround patterns from the issues above

## License

MIT — see [LICENSE](LICENSE)
