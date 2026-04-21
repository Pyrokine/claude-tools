# skill-elenchus

Dialectical analysis methodology for Claude Code. Multi-perspective questioning, cross-examination, and first principles
reduction. One tool, one philosophy — adapts naturally to code review, deep thinking, or design analysis.

Named after **Elenchus** (ἔλεγχος) — the Socratic method of cross-examination and refutation.

## Core Philosophy

Every analysis follows the same principles regardless of input type:

1. **Multi-perspective independent analysis** — Multiple experts examine from different angles
2. **Cross-examination** — Each perspective is challenged by others
3. **Dispute resolution** — Contested points are arbitrated until convergence
4. **First principles reduction** — Strip authority and convention, rebuild from irreducible facts

## Architecture

```
/elenchus <input> → Understand intent → Adapt naturally

Code changes / Design proposals:
  ┌─────────────────────────────────────────────────┐
  │ 5 Expert agents analyze in parallel              │
  │ (2 opus + 3 sonnet)                              │
  │ → 5 Cross-Examiners challenge findings           │
  │ → Dispute resolution (opus arbitrator)            │
  │ → Aggregated report                              │
  └─────────────────────────────────────────────────┘

Abstract questions / Decisions:
  ┌─────────────────────────────────────────────────┐
  │ Dialectical Cycle:                               │
  │   Thesis → Antithesis (Socratic questioning)     │
  │         → Synthesis (First Principles + Occam)   │
  │ Mutation Guard prevents circular reasoning       │
  │ Continues until user stops or boundary reached   │
  └─────────────────────────────────────────────────┘
```

## Install

### Symlink (recommended, auto-update with repo)

```bash
ln -s /path/to/skill-elenchus ~/.claude/skills/elenchus
```

### Copy

```bash
cp -r skill-elenchus/ ~/.claude/skills/elenchus/
```

### English version

By default, `SKILL.md` (Chinese) is the entry point. To use English instead:

```bash
cd ~/.claude/skills/elenchus
mv SKILL.md SKILL-zh.md
mv SKILL-en.md SKILL.md
```

## Usage

```bash
# Code review (auto-detect changes)
/elenchus

# Review specific file
/elenchus src/core/session.ts

# Deep thinking
/elenchus Is this microservice split justified from first principles?

# Design analysis
/elenchus Evaluate this caching architecture proposal from multiple angles
```

No mode selection needed — the tool understands your intent and adapts.

## Output

Each run creates a timestamped directory:

```
/tmp/skill-elenchus/<project>/runs/<YYYYMMDD_HHMMSS>/
├── expert-logic.md        # Expert findings
├── expert-security.md
├── expert-design.md
├── expert-perf.md
├── expert-convention.md
├── cross-review.md        # Cross-examination results
├── disputes.md            # Dispute resolution records
└── report.md              # Final aggregated report
```

## Customization

Edit files in `prompts/`:

| File                             | Purpose                                    |
|----------------------------------|--------------------------------------------|
| `elenchus.md` / `elenchus-en.md` | Dialectical cycle rules                    |
| `shared-rules.md`                | Shared review discipline                   |
| `expert-logic.md`                | Logic & Correctness (opus)                 |
| `expert-security.md`             | Security & Robustness (opus)               |
| `expert-design.md`               | Architecture & Code Quality (sonnet)       |
| `expert-perf.md`                 | Performance & Resource Management (sonnet) |
| `expert-convention.md`           | Project Convention Compliance (sonnet)     |

## Inspired By

- [Socrates.SKILL](https://github.com/MoYeRanqianzhi/Socrates.SKILL) — Socratic questioning methodology for AI agents
- [spec_driven_develop](https://github.com/zhu1090093659/spec_driven_develop) — S.U.P.E.R architectural principles
- [Superpowers](https://github.com/obra/superpowers) — Codex agent design patterns

## License

MIT
