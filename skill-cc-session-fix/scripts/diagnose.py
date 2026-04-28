#!/usr/bin/env python3
"""
Diagnose a Claude Code session JSONL file.

Reports:
- Total lines, file size
- Real timeline tail (last monotonic-timestamp message)
- compact_boundary positions
- uuid chain integrity (dangling parentUuid count)
- File-tail leaf (what CC will pick on resume)
- Recommended truncation line to strip compact replay

Usage:
    diagnose.py <jsonl_path_or_session_id>
    diagnose.py <session_id> --project <project_hash>
    diagnose.py <path> --json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
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


def load_lines(
        path: Path
) -> list[dict | None]:
    records = []
    with path.open() as f:
        for line in f:
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                records.append(None)
    return records


def extract_summary(
        obj: dict
) -> str:
    typ = obj.get("type", "")
    if typ == "user":
        msg = obj.get("message", {})
        c = msg.get("content", "")
        if isinstance(c, str):
            return c[:100]
        if isinstance(c, list):
            for it in c:
                if isinstance(it, dict):
                    if it.get("type") == "text":
                        return it.get("text", "")[:100]
                    if it.get("type") == "tool_result":
                        return "[tool_result]"
    if typ == "assistant":
        msg = obj.get("message", {})
        c = msg.get("content", [])
        if isinstance(c, list):
            for it in c:
                if isinstance(it, dict):
                    if it.get("type") == "text":
                        return it.get("text", "")[:100]
                    if it.get("type") == "tool_use":
                        return f"[tool_use:{it.get('name', '?')}]"
                    if it.get("type") == "thinking":
                        return "[thinking]"
    if typ == "summary":
        return f"[summary] {obj.get('summary', '')[:80]}"
    if typ in ("system", "custom-title", "permission-mode", "agent-name", "last-prompt", "file-history-snapshot",
               "attachment"):
        return f"[{typ}:{obj.get('subtype', '')}]".rstrip(":")
    return ""


def analyze(
        records: list[dict | None]
) -> dict:
    uuids = set()
    parents = set()
    compact_boundaries = []
    real_time_entries = []
    dialog_entries = []

    for idx, obj in enumerate(records, start=1):
        if obj is None:
            continue
        u = obj.get("uuid")
        p = obj.get("parentUuid")
        ts = obj.get("timestamp", "")
        typ = obj.get("type", "")
        if u:
            uuids.add(u)
        if p:
            parents.add(p)
        if obj.get("subtype") == "compact_boundary":
            compact_boundaries.append(idx)
        if ts and ts.startswith("20"):
            real_time_entries.append((idx, ts, u, typ))
            if typ in ("user", "assistant"):
                dialog_entries.append((idx, ts, u))

    children_of: dict[str, list[int]] = {}
    for idx, obj in enumerate(records, start=1):
        if obj is None:
            continue
        u = obj.get("uuid")
        p = obj.get("parentUuid")
        if u and p:
            children_of.setdefault(p, []).append(idx)

    leaf_uuids = uuids - set(children_of.keys())

    file_tail_leaf = None
    for idx in range(len(records), 0, -1):
        obj = records[idx - 1]
        if obj is None:
            continue
        u = obj.get("uuid")
        if u and u in leaf_uuids and obj.get("timestamp", "").startswith("20"):
            file_tail_leaf = (idx, u, obj.get("timestamp", ""), obj.get("type", ""))
            break

    dangling = parents - uuids

    dialog_tail_line = 0
    dialog_tail_ts = ""
    if dialog_entries:
        dialog_tail_line, dialog_tail_ts, _ = max(dialog_entries, key=lambda
                x: x[1])

    recommended_truncation = None
    recommend_reason = None
    if file_tail_leaf and dialog_tail_ts:
        tail_line, _, tail_ts, tail_type = file_tail_leaf
        if tail_type not in ("user", "assistant") and tail_ts > dialog_tail_ts:
            try:
                from datetime import datetime

                def _parse(
                        ts: str
                ):
                    return datetime.fromisoformat(ts.replace("Z", "+00:00"))

                gap_sec = (_parse(tail_ts) - _parse(dialog_tail_ts)).total_seconds()
            except ValueError:
                gap_sec = 0
            if gap_sec > 300:
                recommended_truncation = dialog_tail_line
                recommend_reason = (
                    f"tail leaf is a {tail_type} message {gap_sec / 60:.0f}min after "
                    f"last dialog turn — likely /resume attempt or error; "
                    f"truncating to L{dialog_tail_line} keeps resume anchored on dialog"
                )

    return {
        "total_lines": len(records),
        "parsed_records": sum(1 for r in records if r is not None),
        "uuid_count": len(uuids),
        "parent_uuid_count": len(parents),
        "dangling_parent_uuid_count": len(dangling),
        "leaf_count": len(leaf_uuids),
        "compact_boundary_lines": compact_boundaries,
        "dialog_tail_line": dialog_tail_line,
        "dialog_tail_timestamp": dialog_tail_ts,
        "file_tail_leaf": file_tail_leaf,
        "recommended_truncation_line": recommended_truncation,
        "recommend_reason": recommend_reason,
    }


def print_report(
        path: Path,
        info: dict,
        records: list[dict | None]
) -> None:
    size = path.stat().st_size
    print(f"File        : {path}")
    print(f"Size        : {size:,} bytes ({size / 1024 / 1024:.1f} MB)")
    print(f"Lines       : {info['total_lines']:,} total, {info['parsed_records']:,} parsed")
    print()
    print(f"UUID chain  : {info['uuid_count']:,} uuids, "
          f"{info['dangling_parent_uuid_count']} dangling parentUuid, "
          f"{info['leaf_count']} leaf")
    if info["dangling_parent_uuid_count"]:
        print("              WARNING: dangling parentUuid — resume may lose history")
    print()
    if info["dialog_tail_line"]:
        print(f"Dialog tail : L{info['dialog_tail_line']} {info['dialog_tail_timestamp'][:19]}")
    print()

    cbs = info["compact_boundary_lines"]
    if cbs:
        preview = cbs[:5]
        suffix = "..." if len(cbs) > 5 else ""
        print(f"Compact     : {len(cbs)} boundary marker(s) at L{preview}{suffix}")
        print("              CC replays history after boundary — post-boundary rows may have out-of-order timestamps")
    else:
        print("Compact     : no compact_boundary found")
    print()

    ftl = info["file_tail_leaf"]
    if ftl:
        line, u, ts, typ = ftl
        summary = extract_summary(records[line - 1])
        print(f"Resume leaf : L{line} {ts[:19]} {typ} uuid={u[:8]}")
        print(f"              preview: {summary}")
        print("              ↑ this is the leaf CC will anchor /resume to")
    print()

    rec = info["recommended_truncation_line"]
    if rec:
        print(f"Recommend   : truncate to L{rec}")
        print(f"              reason: {info['recommend_reason']}")
        print(f"              command: truncate.py <jsonl> --line {rec} [--title 'your-title']")
    else:
        print("Health      : OK — tail leaf anchors on current dialog, no truncation needed")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("target", help="jsonl path, or session id (auto-resolves ~/.claude/projects/*/<id>.jsonl)")
    ap.add_argument("--project", help="project hash dir (when resolving by session id)")
    ap.add_argument("--json", action="store_true", help="emit JSON only")
    args = ap.parse_args()

    path = resolve_jsonl(args.target, args.project)
    records = load_lines(path)
    info = analyze(records)
    info["path"] = str(path)

    if args.json:
        print(json.dumps(info, ensure_ascii=False, indent=2, default=str))
    else:
        print_report(path, info, records)
    return 0


if __name__ == "__main__":
    sys.exit(main())
