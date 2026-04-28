#!/usr/bin/env python3
"""
Truncate a Claude Code session JSONL file safely.

- Backs up the original as <name>.jsonl.bak.<YYYYMMDDHHMMSS>
- Keeps only the first N lines
- Appends a custom-title record (Issue #25920 workaround for head-read bug)
- Optionally rewrites sessionId (for fork-style recovery)
- Verifies uuid chain integrity after truncation

Usage:
    truncate.py <jsonl_path_or_session_id> --line N [--title "..."]
    truncate.py <session_id> --line N --new-session   # generate fresh UUID + new file
    truncate.py <path> --line N --dry-run             # report only, no write
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
import uuid as _uuid
from pathlib import Path

CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"


def resolve_jsonl(
        arg: str,
        project_hash: str | None
) -> Path:
    p = Path(arg)
    if p.is_file():
        return p

    if project_hash:
        direct = CLAUDE_PROJECTS / project_hash / f"{arg}.jsonl"
        if direct.is_file():
            return direct

    matches = []
    for proj_dir in CLAUDE_PROJECTS.iterdir() if CLAUDE_PROJECTS.is_dir() else []:
        if not proj_dir.is_dir():
            continue
        for f in proj_dir.glob(f"{arg}*.jsonl"):
            matches.append(f)

    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        print(f"Multiple matches for '{arg}':", file=sys.stderr)
        for m in matches:
            print(f"  {m}", file=sys.stderr)
        sys.exit(2)
    print(f"No jsonl found for '{arg}'", file=sys.stderr)
    sys.exit(2)


def verify_chain(
        lines: list[str]
) -> tuple[int, int]:
    uuids = set()
    parents = set()
    for raw in lines:
        try:
            o = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if o.get("uuid"):
            uuids.add(o["uuid"])
        if o.get("parentUuid"):
            parents.add(o["parentUuid"])
    return len(uuids), len(parents - uuids)


def session_id_from_path(
        path: Path
) -> str:
    return path.stem


def rewrite_session_id(
        lines: list[str],
        new_id: str
) -> list[str]:
    out = []
    for raw in lines:
        try:
            o = json.loads(raw)
        except json.JSONDecodeError:
            out.append(raw)
            continue
        if "sessionId" in o:
            o["sessionId"] = new_id
        out.append(json.dumps(o, ensure_ascii=False) + "\n")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("target", help="jsonl path or session id")
    ap.add_argument("--project", help="project hash dir (when resolving by session id)")
    ap.add_argument("--line", type=int, required=True, help="keep first N lines")
    ap.add_argument("--title", default="truncated session",
                    help="custom-title to append (default: 'truncated session')")
    ap.add_argument("--new-session", action="store_true",
                    help="write to a new file with a new sessionId (keeps original intact for MCP history search)")
    ap.add_argument("--dry-run", action="store_true", help="preview only, do not write")
    args = ap.parse_args()

    src = resolve_jsonl(args.target, args.project)
    with src.open() as f:
        all_lines = f.readlines()

    total = len(all_lines)
    if args.line < 1 or args.line > total:
        print(f"--line must be in 1..{total}", file=sys.stderr)
        return 2

    kept = all_lines[: args.line]

    if args.new_session:
        new_id = str(_uuid.uuid4())
        kept = rewrite_session_id(kept, new_id)
        target_path = src.parent / f"{new_id}.jsonl"
        session_id_for_title = new_id
    else:
        target_path = src
        session_id_for_title = session_id_from_path(src)

    custom_title = json.dumps(
        {"type": "custom-title", "customTitle": args.title, "sessionId": session_id_for_title},
        ensure_ascii=False,
    ) + "\n"
    kept.append(custom_title)

    uuid_count, dangling = verify_chain(kept)

    print(f"Source        : {src}")
    print(f"Total lines   : {total:,}")
    print(f"Keeping       : {args.line:,} lines + 1 custom-title = {len(kept):,} lines")
    print(f"UUID integrity: {uuid_count:,} uuids, {dangling} dangling parentUuid")
    if dangling:
        print("                WARNING: truncation leaves dangling parentUuid — resume may load partial history")

    if args.new_session:
        print(f"New session   : {new_id}")
        print(f"Target        : {target_path}")
    else:
        print(f"Target        : {target_path} (in-place)")

    if args.dry_run:
        print("DRY RUN — no files written")
        return 0

    if not args.new_session:
        backup = src.with_suffix(src.suffix + f".bak.{time.strftime('%Y%m%d%H%M%S')}")
        shutil.copy2(src, backup)
        print(f"Backup        : {backup}")

    target_path.write_text("".join(kept))
    print(f"Written       : {target_path} ({target_path.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
