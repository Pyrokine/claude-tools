# skill-cc-session-fix

Diagnostic and repair toolkit for Claude Code session JSONL files. Fixes `/resume` failures, wrong-anchor recovery,
oversized transcripts.

## Why

Claude Code stores every session as `~/.claude/projects/<hash>/<uuid>.jsonl`. Long-running sessions accumulate:

- `/compact` boundaries that **break timestamp monotonicity** (CC replays summarized history with earlier timestamps
  after the boundary)
- Failed `/resume` attempts that **append `system` messages at the file tail** whose parentUuid latches onto old leaves
- Large tool results (>500KB per line) that **hang the resume deserializer**
- First `user` messages >15KB that make the session **invisible in the picker
  ** ([Issue #25920](https://github.com/anthropics/claude-code/issues/25920))

Observation: **CC picks the resume anchor by scanning the file from the physical tail backwards**, not by timestamp. So
file layout determines what `/resume` restores to — not "the latest conversation".

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

UUID chain  : 4,790 uuids, 0 dangling parentUuid, 144 leaf

Dialog tail : L6318 2026-04-23T13:55:43

Compact     : 21 boundary marker(s) at L[682, 1064, 1346, 1763, 2454]...
              CC replays history after boundary — post-boundary rows may have out-of-order timestamps

Resume leaf : L10003 2026-04-23T15:03:14 system uuid=d6e525ee
              preview: [system:local_command]
              ↑ this is the leaf CC will anchor /resume to

Recommend   : truncate to L6318
              reason: tail leaf is a system message 68min after last dialog turn
              command: truncate.py <jsonl> --line 6318 [--title 'your-title']
```

### Truncate

```bash
scripts/truncate.py <target> --line <N> --title "..." --dry-run    # preview
scripts/truncate.py <target> --line <N> --title "..."              # in-place, auto-backup
scripts/truncate.py <target> --line <N> --title "..." --new-session # fork to fresh UUID
```

- `.bak.<YYYYMMDDHHMMSS>` backup created before in-place write
- Appends `{"type":"custom-title", ...}` at tail (Issue #25920 workaround)
- Optionally rewrites `sessionId` in every line (`--new-session`)
- Reports uuid chain integrity before committing

## Typical Scenarios

| Symptom                                        | Fix                                                                                                        |
|------------------------------------------------|------------------------------------------------------------------------------------------------------------|
| `Resume cancelled`                             | Check file size; if >100MB, truncate to ~10k lines                                                         |
| Resume restores wrong history                  | Diagnose shows `Resume leaf` ≠ `Dialog tail` → truncate to dialog tail                                     |
| Session missing from picker                    | [Issue #25920](https://github.com/anthropics/claude-code/issues/25920); truncate auto-appends custom-title |
| Want original preserved for MCP history search | Use `--new-session` to fork into a new UUID                                                                |
| Dangling parentUuid                            | Diagnose reports count; may need manual edit of first-line parentUuid to `null`                            |

## Known Issues Covered

See [references/known-issues.md](references/known-issues.md) for the full catalog. Highlights:

- [#22566](https://github.com/anthropics/claude-code/issues/22566) — standard truncation recovery pattern
- [#22526](https://github.com/anthropics/claude-code/issues/22526) — phantom parentUuid
- [#25920](https://github.com/anthropics/claude-code/issues/25920) — head-read bug for >15KB first prompts
- [#21067](https://github.com/anthropics/claude-code/issues/21067) — oversized tool_result hangs resume
- [#36583](https://github.com/anthropics/claude-code/issues/36583) — file-history-snapshot uuid collision

## Mechanism

See [references/mechanism.md](references/mechanism.md) for the observed behavior model:

- jsonl line order ≠ timestamp order (/compact rewrites history)
- CC selects `/resume` anchor by **physical file tail**, not timestamp
- 1-2 line rule for custom-title placement

## Inspired By

- [mason0510/fix-jsonl](https://github.com/mason0510/fix-jsonl) — JSONL cleanup (complementary focus on bloat)
- Community workaround patterns from the issues above

## License

MIT — see [LICENSE](LICENSE)
