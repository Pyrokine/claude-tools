#!/usr/bin/env python3
"""Truncate or remove thinking blocks from a session using recoverable private writes.

Usage:
    truncate.py <target> --line N [--title "..."]
    truncate.py <target> --line N --new-session
    truncate.py <target> --strip-thinking [--new-session] [--dry-run]

Stop writers before an in-place repair. Each repair keeps a unique original-inode
backup; --new-session leaves the original path untouched.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
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
    private_file,
    publish,
    resolve_jsonl,
)


def verify_chain(lines):
    """Check the final physical JSONL, including its record separators."""
    uuids = set()
    parents = set()
    for line, raw in enumerate(lines, start=1):
        if not raw.endswith(b"\n" if isinstance(raw, bytes) else "\n"):
            raise SessionError(f"L{line}: output record is missing LF")
        obj = parse_record(raw, line)
        if obj.get("uuid"):
            uuids.add(obj["uuid"])
        if obj.get("parentUuid"):
            parents.add(obj["parentUuid"])
    return len(uuids), len(parents - uuids)


def rewrite_session_id(obj, new_id):
    if "sessionId" in obj:
        obj["sessionId"] = new_id
    return obj


def strip_thinking_blocks(obj):
    content = obj.get("message", {}).get("content")
    if not isinstance(content, list):
        return 0
    remaining = [block for block in content
                 if not (isinstance(block, dict) and block.get("type") == "thinking")]
    removed = len(content) - len(remaining)
    if removed:
        obj["message"]["content"] = remaining
    return removed


def main():
    configure_console()
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("target", help="jsonl path or session id/prefix")
    ap.add_argument("--project", help="restrict id/prefix lookup to this project directory")
    ap.add_argument("--line", type=int, help="keep first N physical lines")
    ap.add_argument("--title", help="custom-title to append (truncation default: 'truncated session')")
    ap.add_argument("--new-session", action="store_true", help="write a new UUID file, retaining the original")
    ap.add_argument("--strip-thinking", action="store_true", help="remove all thinking blocks from retained records")
    ap.add_argument("--dry-run", action="store_true", help="preview only; create no files")
    args = ap.parse_args()
    if args.line is None and not args.strip_thinking:
        ap.error("--line is required unless --strip-thinking is selected")
    if args.line is not None and args.line < 1:
        ap.error("--line must be positive")
    title_text = args.title
    if title_text is None and args.line is not None:
        title_text = "truncated session"

    stage = None
    try:
        src = resolve_jsonl(args.target, args.project)
        with open_source(src) as source:
            expected = file_stamp(os.fstat(source.fileno()))
            total = 0
            invalid_retained = 0
            invalid_removed = 0
            invalid_encoding = False
            removed_thinking = 0
            chain = SessionChain()
            for total, raw in enumerate(source, start=1):
                retained = args.line is None or total <= args.line
                try:
                    obj = parse_record(raw, total)
                except SessionError as exc:
                    print(f"{'Retained' if retained else 'Removed'} input: {exc}", file=sys.stderr)
                    invalid_retained += int(retained)
                    invalid_removed += int(not retained)
                    invalid_encoding |= isinstance(exc.__cause__, UnicodeDecodeError)
                    continue
                if retained:
                    chain.add(obj, total)
                    if args.strip_thinking:
                        removed_thinking += strip_thinking_blocks(obj)
            check_source(src, source, expected)
            if args.line is not None and args.line > total:
                raise SessionError(f"--line must be in 1..{total}")
            keep = args.line if args.line is not None else total
            new_id = str(uuid.uuid4()) if args.new_session else src.stem
            target = src.parent / f"{new_id}.jsonl" if args.new_session else src
            dangling = len(chain.parents - chain.records.keys())
            print(f"Source        : {src}")
            print(f"Total lines   : {total:,}")
            print(f"Retained      : L1..L{keep} ({keep:,} lines), {invalid_retained} invalid")
            print(f"Removed       : {total - keep:,} tail lines, {invalid_removed} invalid")
            if title_text is not None:
                print(f"Keeping       : {keep:,} lines + 1 custom-title = {keep + 1:,} lines")
            else:
                print(f"Keeping       : {keep:,} lines (titles unchanged)")
            print(f"UUID integrity: {len(chain.records):,} uuids, {dangling} dangling parentUuid")
            if dangling:
                print("                WARNING: dangling parentUuid may leave history unavailable on resume")
            for issue in chain.diagnostics():
                print(f"                WARNING: retained chain: {issue['message']}")
            if args.strip_thinking:
                print(f"Thinking      : remove {removed_thinking:,} blocks")
            print(f"Target        : {target}" + (" (new session)" if args.new_session else " (in-place)"))
            if invalid_retained or invalid_encoding:
                raise SessionError("Invalid retained records or UTF-8 input; no session files changed")
            if args.dry_run:
                print("DRY RUN — no files written")
                return 0

            stage = src.with_name(f".{src.name}.{uuid.uuid4().hex}.tmp")
            source.seek(0)
            with private_file(stage) as output:
                for line, raw in enumerate(source, start=1):
                    if line > keep:
                        break
                    if args.new_session or args.strip_thinking:
                        obj = parse_record(raw, line)
                        changed = bool(strip_thinking_blocks(obj)) if args.strip_thinking else False
                        if args.new_session:
                            obj = rewrite_session_id(obj, new_id)
                            changed = True
                        if changed:
                            try:
                                raw = json.dumps(obj, ensure_ascii=False, allow_nan=False).encode("utf-8")
                            except ValueError as exc:
                                raise SessionError(f"L{line}: retained record cannot be encoded as UTF-8 JSON; "
                                                   "source retained") from exc
                    output.write(raw if raw.endswith(b"\n") else raw + b"\n")
                if title_text is not None:
                    title = {"type": "custom-title", "customTitle": title_text, "sessionId": new_id}
                    output.write(json.dumps(title, ensure_ascii=False).encode("utf-8") + b"\n")
                output.flush()
                output.seek(0)
                verify_chain(output)
                os.fsync(output.fileno())
                written_bytes = os.fstat(output.fileno()).st_size
            backup = publish(stage, target, src, source, expected, args.new_session)
            if backup is not None:
                print(f"Backup        : {backup}")
            print(f"Written       : {target} ({written_bytes:,} bytes)")
        return 0
    except (OSError, SessionError, AttributeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        if stage is not None and stage.exists():
            print(f"Private stage retained: {stage}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
