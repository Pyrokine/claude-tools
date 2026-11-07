#!/usr/bin/env python3
"""Diagnose a Claude Code session JSONL file.

Reports physical lines, UUID chain integrity, compact boundaries, inferred resume
leaf and the existing five-minute truncation heuristic. Message payloads are read
one at a time; the selected leaf preview is loaded only for the text report.

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
from datetime import datetime
from pathlib import Path

# Isolated Python omits the script directory; use this installation's helper.
if sys.flags.isolated:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from session_io import (
    SessionChain,
    SessionError,
    check_source,
    configure_console,
    file_stamp,
    open_source,
    parse_record,
    resolve_jsonl,
)


def load_lines(path):
    with open_source(path) as stream:
        expected = file_stamp(os.fstat(stream.fileno()))
        line = 0
        while True:
            offset = stream.tell()
            raw = stream.readline()
            if not raw:
                break
            line += 1
            try:
                obj = parse_record(raw, line)
            except SessionError as exc:
                yield line, offset, None, str(exc)
            else:
                yield line, offset, obj, None
        check_source(path, stream, expected)


def extract_summary(obj):
    typ = obj.get("type", "")
    if typ in ("user", "assistant"):
        content = obj.get("message", {}).get("content", "")
        if isinstance(content, str):
            return content[:100]
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    return block["text"][:100]
                if block.get("type") == "tool_result":
                    return "[tool_result]"
                if block.get("type") == "tool_use":
                    return f"[tool_use:{block.get('name', '?')}]"
                if block.get("type") == "thinking":
                    return "[thinking]"
    if typ == "summary":
        return f"[summary] {(obj.get('summary') or '')[:80]}"
    if typ in ("system", "custom-title", "permission-mode", "agent-name", "last-prompt",
               "file-history-snapshot", "attachment"):
        return f"[{typ}:{obj.get('subtype', '')}]"
    return ""


def analyze(records):
    chain = SessionChain()
    compact_boundaries = []
    entries = []
    issues = []
    total = 0
    parsed = 0
    dialog_tail_line = 0
    dialog_tail_ts = ""
    dialog_tail_time = None
    dialog_tail_uid = None
    timezone_aware = None
    for total, offset, obj, issue in records:
        if issue:
            issues.append({"line": total, "message": issue})
            continue
        parsed += 1
        chain.add(obj, total)
        uid = obj.get("uuid")
        timestamp = obj.get("timestamp") or ""
        typ = obj.get("type") or ""
        if obj.get("subtype") == "compact_boundary":
            compact_boundaries.append(total)
        instant = None
        if timestamp:
            instant = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            aware = instant.utcoffset() is not None
            if timezone_aware is None:
                timezone_aware = aware
            elif aware != timezone_aware:
                issues.append({"line": total, "kind": "incomparable_timestamps",
                               "message": f"L{total}: timestamps mix timezone-aware and timezone-naive dates"})
            if (typ in ("user", "assistant") and aware == timezone_aware
                    and (dialog_tail_time is None or instant >= dialog_tail_time)):
                dialog_tail_line, dialog_tail_ts = total, timestamp
                dialog_tail_time, dialog_tail_uid = instant, uid
        entries.append((total, uid, timestamp, typ, offset, instant, obj.get("parentUuid")))
    issues.extend(chain.diagnostics())
    leaf_uuids = set(chain.records) - chain.child_parents
    file_tail_leaf = None
    leaf_offset = None
    leaf_time = None
    for line, uid, timestamp, typ, offset, instant, _ in reversed(entries):
        if instant is not None and uid and uid in leaf_uuids:
            file_tail_leaf = (line, uid, timestamp, typ)
            leaf_offset, leaf_time = offset, instant
            break
    dangling = chain.parents - chain.records.keys()
    if len(leaf_uuids) > 1:
        line = file_tail_leaf[0] if file_tail_leaf else total
        issues.append({"line": line, "kind": "ambiguous_branches",
                       "message": (f"L{line}: {len(leaf_uuids)} UUID leaves; "
                                   "review branches before selecting a truncation line")})
    recommendation = None
    reason = None
    if file_tail_leaf and dialog_tail_time is not None:
        tail_line, tail_uid, _, tail_type = file_tail_leaf
        if not chain.contains_ancestor(tail_uid, dialog_tail_uid):
            issues.append({"line": dialog_tail_line, "kind": "dialog_outside_chain",
                           "message": (f"L{dialog_tail_line}: latest dialog is outside the parent chain "
                                       f"of leaf L{tail_line}")})
        if not issues and not dangling and tail_type not in ("user", "assistant"):
            gap = (leaf_time - dialog_tail_time).total_seconds()
            if gap > 300:
                excluded_dialog = next(((line, instant) for line, _, _, typ, _, instant, _ in entries
                                        if line > dialog_tail_line and typ in ("user", "assistant")), None)
                excluded_parent = next(((line, chain.records[parent][1])
                                        for line, _, _, _, _, _, parent in entries
                                        if line <= dialog_tail_line and parent in chain.records
                                        and chain.records[parent][1] > dialog_tail_line), None)
                if excluded_dialog:
                    line, instant = excluded_dialog
                    untimed = instant is None
                    kind = "untimed_dialog_outside_prefix" if untimed else "dialog_time_regression"
                    detail = "no timestamp" if untimed else "an earlier timestamp"
                    issues.append({"line": line, "kind": kind,
                                   "message": (f"L{line}: dialog with {detail} is beyond proposed truncation "
                                               f"L{dialog_tail_line}; review the retained range")})
                elif excluded_parent:
                    line, parent_line = excluded_parent
                    issues.append({"line": line, "kind": "truncation_parent_outside_prefix",
                                   "message": (f"L{line}: parent at L{parent_line} is beyond proposed truncation "
                                               f"L{dialog_tail_line}")})
                else:
                    recommendation = dialog_tail_line
                    reason = (f"tail leaf is a {tail_type} message {gap / 60:.0f}min after "
                              f"last dialog turn — likely /resume attempt or error; "
                              f"truncating to L{dialog_tail_line} keeps resume anchored on dialog")
    health = "needs_review" if issues or dangling else "unknown"
    if file_tail_leaf and dialog_tail_time is not None:
        health = "needs_review"
        if (not issues and not dangling and file_tail_leaf[3] in ("user", "assistant")
                and leaf_time == dialog_tail_time):
            health = "ok"
    return {
        "total_lines": total,
        "parsed_records": parsed,
        "uuid_count": len(chain.records),
        "parent_uuid_count": len(chain.parents),
        "dangling_parent_uuid_count": len(dangling),
        "leaf_count": len(leaf_uuids),
        "compact_boundary_lines": compact_boundaries,
        "dialog_tail_line": dialog_tail_line,
        "dialog_tail_timestamp": dialog_tail_ts,
        "file_tail_leaf": file_tail_leaf,
        "recommended_truncation_line": recommendation,
        "recommend_reason": reason,
        "health": health,
        "issues": issues,
        "_leaf_offset": leaf_offset,
    }


def print_report(path: Path, info: dict):
    size = path.stat().st_size
    print(f"File        : {path}")
    print(f"Size        : {size:,} bytes ({size / 1024 / 1024:.1f} MB)")
    print(f"Lines       : {info['total_lines']:,} total, {info['parsed_records']:,} parsed")
    for issue in info["issues"]:
        print(f"Input issue : {issue['message']}")
    print()
    print(f"UUID chain  : {info['uuid_count']:,} uuids, "
          f"{info['dangling_parent_uuid_count']} dangling parentUuid, {info['leaf_count']} leaf")
    if info["dangling_parent_uuid_count"]:
        print("              WARNING: dangling parentUuid — resume may lose history")
    print()
    if info["dialog_tail_line"]:
        print(f"Dialog tail : L{info['dialog_tail_line']} {info['dialog_tail_timestamp'][:19]}")
    print()
    boundaries = info["compact_boundary_lines"]
    if boundaries:
        suffix = "..." if len(boundaries) > 5 else ""
        print(f"Compact     : {len(boundaries)} boundary marker(s) at L{boundaries[:5]}{suffix}")
        print("              CC replays history after boundary — post-boundary rows may have out-of-order timestamps")
    else:
        print("Compact     : no compact_boundary found")
    print()
    leaf = info["file_tail_leaf"]
    if leaf:
        line, uid, timestamp, typ = leaf
        with open_source(path) as stream:
            stream.seek(info["_leaf_offset"])
            summary = extract_summary(parse_record(stream.readline(), line))
        print(f"Resume leaf : L{line} {timestamp[:19]} {typ} uuid={uid[:8]}")
        print(f"              preview: {summary}")
        print("              ↑ this is the inferred leaf CC will anchor /resume to")
    else:
        print("Resume leaf : unavailable — no timestamped leaf found")
    print()
    recommendation = info["recommended_truncation_line"]
    if recommendation:
        print(f"Recommend   : truncate to L{recommendation}")
        print(f"              reason: {info['recommend_reason']}")
        print(f"              command: truncate.py <jsonl> --line {recommendation} [--title 'your-title']")
    elif info["health"] == "ok":
        print("Health      : OK — tail leaf anchors on current dialog, no truncation needed")
    elif info["health"] == "unknown":
        print("Health      : unknown — no usable resume leaf or dialog anchor; inspect the reported records")
    else:
        print("Health      : needs review — no heuristic truncation recommendation; "
              "inspect leaf, chain and input issues")


def main():
    configure_console()
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("target", help="jsonl path, session id or prefix")
    ap.add_argument("--project", help="restrict id/prefix lookup to this project directory")
    ap.add_argument("--json", action="store_true", help="emit JSON only")
    args = ap.parse_args()
    try:
        path = resolve_jsonl(args.target, args.project)
        info = analyze(load_lines(path))
        info["path"] = str(path)
        if args.json:
            print(json.dumps({key: value for key, value in info.items() if not key.startswith("_")},
                             ensure_ascii=False, indent=2))
        else:
            print_report(path, info)
        return 0
    except (OSError, SessionError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
