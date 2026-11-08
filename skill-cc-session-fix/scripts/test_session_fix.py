"""Regression tests using synthetic sessions and an isolated HOME only."""

import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import tracemalloc
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent
if sys.flags.isolated:
    sys.path.insert(0, str(SCRIPTS))

import diagnose
import session_io
import truncate


def record(uid="a", parent=None, **extra):
    return dict(type="user", uuid=uid, parentUuid=parent,
                timestamp="2026-01-01T00:00:00Z", message={"content": "hello"}, **extra)


class SessionFixTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get("SESSION_FIX_TEST_ROOT"))
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.projects = self.home / ".claude" / "projects"
        self.project = self.projects / "requested"
        self.project.mkdir(parents=True)
        self.source = self.project / "abc123.jsonl"
        self.env = dict(os.environ, HOME=str(self.home), USERPROFILE=str(self.home),
                        PYTHONDONTWRITEBYTECODE="1")

    def write(self, rows, path=None, final_lf=True):
        path = path or self.source
        text = "\n".join(json.dumps(row, ensure_ascii=False) for row in rows)
        path.write_text(text + ("\n" if final_lf else ""), encoding="utf-8")
        if os.name != "nt":
            path.chmod(0o600)
        return path

    def cli(self, script, *args, ascii_locale=False):
        env = dict(self.env)
        flags = ["-I", "-B"]
        if ascii_locale:
            env.update(LC_ALL="C", LANG="C", PYTHONCOERCECLOCALE="0")
            flags += ["-X", "utf8=0"]
        return subprocess.run([sys.executable, *flags, str(SCRIPTS / script),
                               *map(str, args)], env=env, cwd=self.home,
                              capture_output=True, check=False, encoding="utf-8", timeout=30)

    def read(self, path=None):
        return [json.loads(raw) for raw in (path or self.source).read_bytes().splitlines()]

    def test_sf01_project_prefix_never_uses_other_project(self):
        other = self.projects / "other"
        other.mkdir()
        path = self.write([record(), record("b", "a")], other / "abc999.jsonl")
        before = path.read_bytes()
        for script, args in (("diagnose.py", []), ("truncate.py", ["--line", "1"])):
            result = self.cli(script, "abc", "--project", "requested", *args)
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual(path.read_bytes(), before)

    @unittest.skipIf(os.name == "nt", "requires POSIX symlink creation")
    def test_sf01_id_lookup_does_not_follow_cross_project_links(self):
        other = self.projects / "other"
        other.mkdir()
        outside = self.write([record()], other / "abc999.jsonl")
        self.source.symlink_to(outside)
        for target in ("abc", "abc123"):
            result = self.cli("diagnose.py", target, "--project", "requested")
            self.assertEqual(result.returncode, 2, result.stderr)
        result = self.cli("diagnose.py", self.source, "--project", "requested")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_sf01_explicit_path_exact_and_ambiguous_controls(self):
        self.write([record()])
        result = self.cli("diagnose.py", "abc123", "--project", "requested", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.write([record()], self.project / "abc456.jsonl")
        result = self.cli("diagnose.py", "abc", "--project", "requested")
        self.assertEqual(result.returncode, 2)
        result = self.cli("diagnose.py", self.source, "--project", "absent")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_sf02_each_repair_keeps_unique_original_backup(self):
        self.write([record(), record("b", "a"), record("c", "b")])
        original = self.source.read_bytes()
        for line in (2, 1):
            result = self.cli("truncate.py", self.source, "--line", line)
            self.assertEqual(result.returncode, 0, result.stderr)
        backups = [p for p in self.project.rglob("*") if p.is_file() and ".bak." in str(p)]
        self.assertEqual(len(backups), 2)
        self.assertIn(original, [path.read_bytes() for path in backups])

    def test_sf03_missing_final_lf_in_place_and_fork(self):
        for fork in (False, True):
            with self.subTest(fork=fork):
                self.write([record(), record("b", "a")], final_lf=False)
                result = self.cli("truncate.py", self.source, "--line", 2,
                                  *(["--new-session"] if fork else []))
                self.assertEqual(result.returncode, 0, result.stderr)
                path = next(p for p in self.project.glob("*.jsonl") if p != self.source) if fork else self.source
                self.assertEqual(len(self.read(path)), 3)
                self.assertTrue(path.read_bytes().endswith(b"\n"))

    def test_sf04_no_leaf_or_dialog_anchor_is_not_healthy(self):
        for rows in ([record("a", "b"), record("b", "a")],
                     [{"uuid": "a", "type": "system", "timestamp": "2026-01-01T00:00:00Z"}]):
            self.write(rows)
            result = self.cli("diagnose.py", self.source)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("Health      : OK", result.stdout)
            self.assertIn("Health", result.stdout)

    def test_sf05_bad_shapes_report_line_and_continue(self):
        for bad in ([], 12, "bad", None, dict(record(), timestamp=3),
                    dict(record(), timestamp="20bad"), dict(record(), uuid=["x"]),
                    dict(record(), parentUuid={"bad": True}), dict(record(), message=None),
                    dict(record(), message={"content": [{"type": "text", "text": None}]})):
            with self.subTest(bad=bad):
                self.write([bad, record("good")])
                result = self.cli("diagnose.py", self.source, "--json")
                self.assertEqual(result.returncode, 0, result.stderr)
                info = json.loads(result.stdout)
                self.assertEqual(info["total_lines"], 2)
                self.assertEqual(info["dialog_tail_line"], 2)
                self.assertTrue(any(issue["line"] == 1 for issue in info["issues"]))
                before = self.source.read_bytes()
                result = self.cli("truncate.py", self.source, "--line", 2)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                self.assertEqual(self.source.read_bytes(), before)

    def test_sf05_malformed_json_and_blank_lines_are_not_silently_dropped(self):
        for bad in (b'{"incomplete":\n', b'\n', b'{"uuid":NaN}\n'):
            self.source.write_bytes(bad + json.dumps(record("good")).encode("utf-8") + b"\n")
            original = self.source.read_bytes()
            result = self.cli("diagnose.py", self.source, "--json")
            self.assertEqual(result.returncode, 0, result.stderr)
            info = json.loads(result.stdout)
            self.assertEqual(info["issues"][0]["line"], 1)
            self.assertEqual(info["dialog_tail_line"], 2)
            for args in (("--line", 2), ("--strip-thinking",), ("--line", 2, "--new-session")):
                result = self.cli("truncate.py", self.source, *args)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("L1", result.stderr)
                self.assertEqual(self.source.read_bytes(), original)

    @unittest.skipIf(os.name == "nt", "POSIX modes; Windows uses native DACL tests")
    def test_sf06_fork_and_thinking_repair_remain_private(self):
        self.write([dict(record(), message={"content": [{"type": "thinking", "thinking": "private"},
                                                       {"type": "text", "text": "hello"}]})])
        result = self.cli("truncate.py", self.source, "--line", 1, "--new-session")
        self.assertEqual(result.returncode, 0, result.stderr)
        fork = next(p for p in self.project.glob("*.jsonl") if p != self.source)
        self.assertEqual(stat.S_IMODE(fork.stat().st_mode), 0o600)
        result = self.cli("truncate.py", self.source, "--strip-thinking")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(stat.S_IMODE(self.source.stat().st_mode), 0o600)
        self.assertEqual(self.read()[0]["message"]["content"], [{"type": "text", "text": "hello"}])

    def test_sf07_utf8_is_explicit_even_with_ascii_locale(self):
        self.write([dict(record(), message={"content": "中文会话"})])
        for script, args in (("diagnose.py", []), ("truncate.py", ["--line", 1]),
                             ("truncate.py", ["--strip-thinking"])):
            result = self.cli(script, self.source, *args, ascii_locale=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.read()[0]["message"]["content"], "中文会话")

    def test_sf07_invalid_utf8_preserves_source(self):
        self.source.write_bytes(b'{"type":"user"}\n\xff\n')
        original = self.source.read_bytes()
        result = self.cli("truncate.py", self.source, "--line", 1)
        self.assertEqual(result.returncode, 2)
        self.assertIn("L2", result.stderr)
        self.assertEqual(self.source.read_bytes(), original)
        result = self.cli("diagnose.py", self.source, "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["issues"][0]["line"], 2)

    def test_sf07_unencodable_rewrite_reports_line_and_retains_source(self):
        obj = dict(record(), message={"content": "escaped surrogate: \ud800"})
        self.source.write_bytes(json.dumps(obj, ensure_ascii=True).encode("ascii") + b"\n")
        original = self.source.read_bytes()
        result = self.cli("truncate.py", self.source, "--line", 1, "--new-session")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("L1", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(self.source.read_bytes(), original)

    def run_main(self, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(sys, "argv", ["truncate.py", str(self.source), *map(str, args)]), \
                mock.patch.object(sys, "stdout", stdout), mock.patch.object(sys, "stderr", stderr):
            code = truncate.main()
        return code, stdout.getvalue(), stderr.getvalue()

    @unittest.skipIf(os.name == "nt", "POSIX hard-link/replace interleaving")
    def test_sf02_last_window_append_survives_in_original_inode_backup(self):
        self.write([record(), record("b", "a")])
        original_inode = self.source.stat().st_ino
        replace = os.replace
        late = json.dumps(record("late", "b")).encode("utf-8") + b"\n"

        with self.source.open("ab") as writer:
            def replace_then_append(stage, target):
                replace(stage, target)
                writer.write(late)
                writer.flush()

            with mock.patch.object(session_io.os, "replace", side_effect=replace_then_append):
                code, output, error = self.run_main("--line", 1)
        self.assertEqual(code, 0, error)
        backup = Path(next(line.split(": ", 1)[1] for line in output.splitlines() if line.startswith("Backup")))
        self.assertEqual(backup.stat().st_ino, original_inode)
        self.assertNotEqual(self.source.stat().st_ino, original_inode)
        self.assertIn(b'"late"', backup.read_bytes())
        self.assertNotIn(b'"late"', self.source.read_bytes())

    @unittest.skipIf(os.name == "nt", "POSIX hard-link/replace interleaving")
    def test_sf02_change_before_backup_refuses_overwrite(self):
        self.write([record(), record("b", "a")])
        link = os.link
        late = json.dumps(record("late", "b")).encode("utf-8") + b"\n"

        def append_then_link(source, backup):
            with self.source.open("ab") as writer:
                writer.write(late)
            return link(source, backup)

        with mock.patch.object(session_io.os, "link", side_effect=append_then_link):
            code, _, error = self.run_main("--line", 1)
        self.assertEqual(code, 2, error)
        self.assertIn("changed", error)
        self.assertEqual(self.read()[-1]["uuid"], "late")
        for path in self.project.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_sf02_source_timestamp_meanings_are_platform_specific(self):
        self.write([record()])
        fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns", "st_mode")
        with self.source.open("rb") as stream:
            original = os.fstat(stream.fileno())
            expected = session_io.file_stamp(original)
            values = {field: getattr(original, field) for field in fields}
            values["st_ctime_ns"] += 1
            path = mock.Mock()
            path.stat.return_value = mock.Mock(**values)
            for platform in ("nt", "posix"):
                with self.subTest(platform=platform), mock.patch.object(session_io.os, "name", platform):
                    if platform == "nt":
                        session_io.check_source(path, stream, expected)
                    else:
                        with self.assertRaisesRegex(session_io.SessionError, "Source changed"):
                            session_io.check_source(path, stream, expected)

    def test_sf02_windows_source_changes_still_refuse_repair(self):
        self.write([record()])
        fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns", "st_mode")
        with self.source.open("rb") as stream:
            original = os.fstat(stream.fileno())
            expected = session_io.file_stamp(original)
            values = {field: getattr(original, field) for field in fields}
            path = mock.Mock()
            with mock.patch.object(session_io.os, "name", "nt"):
                for field in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_mode"):
                    changed = dict(values)
                    changed[field] += 0o100 if field == "st_mode" else 1
                    changed["st_ctime_ns"] += 1
                    path.stat.return_value = mock.Mock(**changed)
                    with self.subTest(field=field), \
                            self.assertRaisesRegex(session_io.SessionError, "Source changed"):
                        session_io.check_source(path, stream, expected)
                changed = dict(values)
                changed["st_ctime_ns"] += 1
                path.stat.return_value = mock.Mock(**values)
                with mock.patch.object(session_io.os, "fstat", return_value=mock.Mock(**changed)), \
                        self.assertRaisesRegex(session_io.SessionError, "Source changed"):
                    session_io.check_source(path, stream, expected)

    def test_sf02_source_identity_change_before_commit_refuses_overwrite(self):
        self.write([record(), record("b", "a")])
        replacement = self.write([record("replacement")], self.project / "replacement.jsonl")
        replacement_bytes = replacement.read_bytes()
        publish = session_io.publish

        def replace_source_then_publish(*args, **kwargs):
            source, stream, expected = args[2:5]
            # 使用实际发布原语替换，保留 Windows 打开句柄的共享语义
            publish(replacement, source, source, stream, expected)
            return publish(*args, **kwargs)

        with mock.patch.object(truncate, "publish", side_effect=replace_source_then_publish):
            code, _, error = self.run_main("--line", 1)
        self.assertEqual(code, 2, error)
        self.assertIn("Source changed", error)
        self.assertEqual(self.source.read_bytes(), replacement_bytes)

    @unittest.skipIf(os.name == "nt", "POSIX unavailable hard-link primitive")
    def test_sf02_unavailable_safe_in_place_primitive_allows_new_session(self):
        self.write([record(), record("b", "a")])
        before = self.source.read_bytes()
        with mock.patch.object(session_io.os, "link", side_effect=OSError("hard links unavailable")):
            code, _, error = self.run_main("--line", 1)
            self.assertEqual(code, 2, error)
            self.assertIn("--new-session", error)
            code, _, error = self.run_main("--line", 1, "--new-session")
            self.assertEqual(code, 0, error)
        self.assertEqual(self.source.read_bytes(), before)

    @unittest.skipIf(os.name == "nt", "POSIX exclusive hard-link backup")
    def test_sf02_backup_collision_never_overwrites_existing_backup(self):
        self.write([record(), record("b", "a")])
        backup = self.source.with_name(self.source.name + ".bak.fixed")
        backup.write_bytes(b"previous recovery bytes")
        backup.chmod(0o600)
        original = self.source.read_bytes()
        with mock.patch.object(session_io.uuid, "uuid4", return_value=mock.Mock(hex="fixed")):
            code, _, error = self.run_main("--line", 1)
        self.assertEqual(code, 2, error)
        self.assertEqual(backup.read_bytes(), b"previous recovery bytes")
        self.assertEqual(self.source.read_bytes(), original)

    @unittest.skipIf(os.name == "nt", "POSIX failed replace permissions")
    def test_sf06_failed_publication_keeps_all_files_private(self):
        self.write([record()])
        original = self.source.read_bytes()
        with mock.patch.object(session_io.os, "replace", side_effect=PermissionError("test denial")):
            code, _, error = self.run_main("--line", 1)
        self.assertEqual(code, 2, error)
        self.assertIn("Private stage retained", error)
        self.assertEqual(self.source.read_bytes(), original)
        for path in self.project.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_sf05_invalid_removed_tail_is_explicit_and_unknown_fields_survive(self):
        self.write([dict(record(), future={"retained": [1, 2]}), ["invalid"]])
        result = self.cli("truncate.py", self.source, "--line", 1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Removed input: L2", result.stderr)
        self.assertIn("1 tail lines, 1 invalid", result.stdout)
        self.assertEqual(self.read()[0]["future"], {"retained": [1, 2]})
        backup = next(p for p in self.project.rglob("*") if p.is_file() and ".bak." in str(p))
        self.assertEqual(json.loads(backup.read_bytes().splitlines()[1]), ["invalid"])

    def test_sf03_embedded_unicode_line_separators_are_not_physical_lines(self):
        self.write([dict(record(), message={"content": "a b c"})], final_lf=False)
        result = self.cli("truncate.py", self.source, "--line", 1, "--new-session")
        self.assertEqual(result.returncode, 0, result.stderr)
        target = next(p for p in self.project.glob("*.jsonl") if p != self.source)
        lines = target.read_bytes().split(b"\n")
        self.assertEqual(len(lines), 3)
        self.assertEqual(json.loads(lines[0])["message"]["content"], "a b c")

    def test_sf_streaming_payloads_are_not_retained_by_diagnosis_or_truncation(self):
        payload = "x" * (256 * 1024)
        with self.source.open("w", encoding="utf-8") as output:
            for index in range(80):
                obj = dict(record(str(index), str(index - 1) if index else None),
                           message={"content": payload})
                output.write(json.dumps(obj) + "\n")
        if os.name != "nt":
            self.source.chmod(0o600)
        tracemalloc.start()
        try:
            info = diagnose.analyze(diagnose.load_lines(self.source))
            _, diagnose_peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            tracemalloc.start()
            code, _, error = self.run_main("--line", 2, "--new-session")
            _, truncate_peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(info["total_lines"], 80)
        self.assertEqual(info["file_tail_leaf"][0], 80)
        self.assertEqual(code, 0, error)
        self.assertLess(diagnose_peak, 8 * 1024 * 1024)
        self.assertLess(truncate_peak, 8 * 1024 * 1024)

    def test_mh_sf01_chain_issues_reach_diagnosis_and_explicit_repairs(self):
        cases = (
            ([record("a", "b"), record("b", "a")], "uuid_cycle", 1),
            ([record("a", "b"), record("b", "a"), record("leaf", "b")], "uuid_cycle", 1),
            ([record("a", "a"), record("leaf", "a")], "uuid_cycle", 1),
            ([record(), record(), record("leaf", "a")], "duplicate_uuid", 2),
        )
        for rows, kind, issue_line in cases:
            with self.subTest(kind=kind, rows=rows):
                self.write(rows)
                original = self.source.read_bytes()
                result = self.cli("diagnose.py", self.source, "--json")
                self.assertEqual(result.returncode, 0, result.stderr)
                info = json.loads(result.stdout)
                self.assertEqual(info["health"], "needs_review")
                self.assertIsNone(info["recommended_truncation_line"])
                self.assertTrue(any(issue.get("kind") == kind and issue["line"] == issue_line
                                    for issue in info["issues"]), info)
                result = self.cli("truncate.py", self.source, "--line", len(rows), "--dry-run")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("WARNING: retained chain:", result.stdout)
                self.assertIn(f"L{issue_line}:", result.stdout)
                self.assertEqual(self.source.read_bytes(), original)
                result = self.cli("truncate.py", self.source, "--line", len(rows), "--new-session")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("WARNING: retained chain:", result.stdout)
                self.assertIn("Written", result.stdout)
                self.assertEqual(self.source.read_bytes(), original)
        self.write([record(), record()])
        result = self.cli("truncate.py", self.source, "--line", 1, "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("WARNING: retained chain:", result.stdout)

    def test_mh_sf01_chain_walk_is_iterative_and_dangling_stays_a_warning(self):
        chain = session_io.SessionChain()
        for index in range(5000):
            chain.add(record(str(index), str(index - 1) if index else "4999"), index + 1)
        self.assertEqual([issue["kind"] for issue in chain.diagnostics()], ["uuid_cycle"])
        self.assertTrue(chain.contains_ancestor("4999", "0"))
        self.assertFalse(chain.contains_ancestor("4999", "absent"))
        self.write([record("a", "missing")])
        result = self.cli("truncate.py", self.source, "--line", 1, "--new-session")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("WARNING: dangling parentUuid", result.stdout)
        self.assertNotIn("WARNING: retained chain:", result.stdout)

    def test_mh_sf02_compares_instants_and_keeps_last_equal_dialog(self):
        for first, second in (
            ("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
            ("2026-01-01T00:00:00Z", "2026-01-01T00:00:00.500Z"),
            ("2026-01-01T00:00:00.500Z", "2026-01-01T00:00:00.500000+00:00"),
            ("2026-01-01T01:00:00+01:00", "2026-01-01T00:00:00.500Z"),
            ("2026-01-01T00:00:00", "2026-01-01T00:00:00.500"),
        ):
            with self.subTest(first=first, second=second):
                suffix = "Z" if second.endswith(("Z", "+00:00")) else ""
                rows = [dict(record(), timestamp=first),
                        dict(record("b", "a"), type="assistant", timestamp=second)]
                self.write(rows)
                result = self.cli("diagnose.py", self.source, "--json")
                info = json.loads(result.stdout)
                self.assertEqual(info["health"], "ok", info)
                self.assertEqual(info["dialog_tail_line"], 2)
                self.assertEqual(info["dialog_tail_timestamp"], second)
                self.write(rows + [{"uuid": "c", "parentUuid": "b", "type": "system",
                                    "timestamp": "2026-01-01T00:10:00" + suffix}])
                result = self.cli("diagnose.py", self.source, "--json")
                self.assertEqual(result.returncode, 0, result.stderr)
                info = json.loads(result.stdout)
                self.assertEqual(info["dialog_tail_line"], 2)
                self.assertEqual(info["recommended_truncation_line"], 2, info)
                originals = set(self.project.glob("*.jsonl"))
                result = self.cli("truncate.py", self.source, "--line", 2, "--new-session")
                self.assertEqual(result.returncode, 0, result.stderr)
                fork = next(iter(set(self.project.glob("*.jsonl")) - originals))
                retained = self.read(fork)
                self.assertEqual(len(retained), 3)
                self.assertEqual(retained[1]["type"], "assistant")
                self.assertEqual(retained[1]["uuid"], "b")

    def test_mh_sf02_ambiguous_branches_and_mixed_timezones_stop_recommendation(self):
        system = {"uuid": "c", "parentUuid": "b", "type": "system", "timestamp": "2026-01-01T00:10:00Z"}
        cases = (
            ([record(), dict(record("b", "a"), type="assistant"),
              dict(system, parentUuid="a")], "ambiguous_branches"),
            ([record(), dict(record("b", "a"), type="assistant"),
              dict(system, timestamp="2026-01-01T00:10:00")], "incomparable_timestamps"),
            ([record(), dict(record("b", "missing"), type="assistant"), system], "ambiguous_branches"),
        )
        for rows, kind in cases:
            with self.subTest(kind=kind):
                self.write(rows)
                result = self.cli("diagnose.py", self.source, "--json")
                self.assertEqual(result.returncode, 0, result.stderr)
                info = json.loads(result.stdout)
                self.assertEqual(info["health"], "needs_review")
                self.assertIsNone(info["recommended_truncation_line"])
                self.assertTrue(any(issue.get("kind") == kind for issue in info["issues"]), info)
        self.write([record(), record("b", "a"), dict(record("c", "a"), type="assistant")])
        info = json.loads(self.cli("diagnose.py", self.source, "--json").stdout)
        self.assertEqual(info["leaf_count"], 2)
        self.assertEqual(info["file_tail_leaf"][1], "c")
        self.assertFalse(any(issue.get("kind") in ("uuid_cycle", "duplicate_uuid") for issue in info["issues"]))

    def test_mh_sf02_recommendation_keeps_later_dialog_and_required_parents(self):
        tail = {"type": "system", "uuid": "c", "parentUuid": "b", "timestamp": "2026-01-01T00:10:00Z"}
        cases = (
            ([record(), dict(record("b", "a"), type="assistant", timestamp="2025-12-31T23:59:00Z"), tail],
             "dialog_time_regression"),
            ([record("b", "a"), {"type": "system", "uuid": "a"}, tail],
             "truncation_parent_outside_prefix"),
        )
        for rows, kind in cases:
            with self.subTest(kind=kind):
                self.write(rows)
                result = self.cli("diagnose.py", self.source, "--json")
                self.assertEqual(result.returncode, 0, result.stderr)
                info = json.loads(result.stdout)
                self.assertEqual(info["dialog_tail_line"], 1)
                self.assertIsNone(info["recommended_truncation_line"])
                self.assertEqual(info["health"], "needs_review")
                self.assertTrue(any(issue.get("kind") == kind for issue in info["issues"]), info)

    def test_ql_sf01_untimed_dialog_stops_recommendation(self):
        for timestamp in ("missing", None, ""):
            with self.subTest(timestamp=timestamp):
                dialog = dict(record("b", "a"), type="assistant",
                              message={"content": "retain this answer"})
                if timestamp == "missing":
                    dialog.pop("timestamp")
                else:
                    dialog["timestamp"] = timestamp
                rows = [record(), dialog,
                        {"type": "system", "uuid": "c", "parentUuid": "b",
                         "timestamp": "2026-01-01T00:10:00Z"}]
                self.write(rows)
                original = self.source.read_bytes()
                result = self.cli("diagnose.py", self.source, "--json")
                self.assertEqual(result.returncode, 0, result.stderr)
                info = json.loads(result.stdout)
                self.assertEqual(info["dialog_tail_line"], 1)
                self.assertEqual(info["file_tail_leaf"][0], 3)
                self.assertIsNone(info["recommended_truncation_line"], info)
                self.assertEqual(info["health"], "needs_review")
                self.assertTrue(any(issue.get("kind") == "untimed_dialog_outside_prefix"
                                    and issue["line"] == 2 for issue in info["issues"]), info)
                existing = set(self.project.glob("*.jsonl"))
                result = self.cli("truncate.py", self.source, "--line", 2, "--new-session")
                self.assertEqual(result.returncode, 0, result.stderr)
                fork = next(iter(set(self.project.glob("*.jsonl")) - existing))
                retained = self.read(fork)
                self.assertEqual(retained[1]["message"], dialog["message"])
                self.assertEqual(retained[1].get("timestamp"), dialog.get("timestamp"))
                self.assertEqual(self.source.read_bytes(), original)

    def test_ql_sf01_dialog_without_uuid_still_protects_retained_content(self):
        for typ in ("user", "assistant"):
            with self.subTest(typ=typ):
                self.write([record(), {"type": typ, "parentUuid": "a",
                                      "message": {"content": "retain without UUID or time"}},
                            {"type": "system", "uuid": "c", "parentUuid": "a",
                             "timestamp": "2026-01-01T00:10:00Z"}])
                result = self.cli("diagnose.py", self.source, "--json")
                self.assertEqual(result.returncode, 0, result.stderr)
                info = json.loads(result.stdout)
                self.assertEqual(info["uuid_count"], 2)
                self.assertEqual(info["parsed_records"], 3)
                self.assertIsNone(info["recommended_truncation_line"], info)
                self.assertTrue(any(issue.get("kind") == "untimed_dialog_outside_prefix"
                                    and issue["line"] == 2 for issue in info["issues"]), info)

    def test_ql_sf01_parent_without_uuid_is_checked_against_prefix(self):
        for uid in ("missing", None, ""):
            with self.subTest(uid=uid):
                retained = {"type": "attachment", "parentUuid": "later"}
                if uid != "missing":
                    retained["uuid"] = uid
                self.write([retained, record(),
                            {"type": "system", "uuid": "later", "parentUuid": "a",
                             "timestamp": "2026-01-01T00:10:00Z"}])
                result = self.cli("diagnose.py", self.source, "--json")
                self.assertEqual(result.returncode, 0, result.stderr)
                info = json.loads(result.stdout)
                self.assertEqual(info["dialog_tail_line"], 2)
                self.assertEqual(info["dangling_parent_uuid_count"], 0)
                self.assertIsNone(info["recommended_truncation_line"], info)
                self.assertTrue(any(issue.get("kind") == "truncation_parent_outside_prefix"
                                    and issue["line"] == 1 and "L3" in issue["message"]
                                    for issue in info["issues"]), info)

    def test_ql_sf01_valid_unindexed_metadata_keeps_recommendation(self):
        for seconds, expected in (("05:00", None), ("05:01", 2)):
            with self.subTest(seconds=seconds):
                self.write([{"type": "attachment", "parentUuid": "a"}, record(),
                            {"type": "system", "parentUuid": "a", "timestamp": None},
                            {"type": "system", "uuid": "c", "parentUuid": "a",
                             "timestamp": "2026-01-01T00:" + seconds + "Z"}])
                result = self.cli("diagnose.py", self.source, "--json")
                self.assertEqual(result.returncode, 0, result.stderr)
                info = json.loads(result.stdout)
                self.assertEqual(info["parsed_records"], 4)
                self.assertEqual(info["file_tail_leaf"][0], 4)
                self.assertEqual(info["recommended_truncation_line"], expected, info)
                self.assertEqual(info["issues"], [])

    def test_diagnosis_keeps_physical_leaf_and_five_minute_heuristic(self):
        rows = [record(), dict(record("b", "a"), type="assistant", timestamp="2026-01-01T00:01:00Z"),
                {"type": "system", "subtype": "compact_boundary", "uuid": "c", "parentUuid": "b"},
                {"type": "system", "uuid": "d", "parentUuid": "c", "timestamp": "2026-01-01T01:00:00Z"}]
        self.write(rows)
        result = self.cli("diagnose.py", self.source, "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        info = json.loads(result.stdout)
        self.assertEqual(info["compact_boundary_lines"], [3])
        self.assertEqual(info["recommended_truncation_line"], 2)
        self.assertEqual(info["file_tail_leaf"][0], 4)
        self.write(rows + [dict(record("e", "a"), timestamp="2025-12-31T23:00:00Z")])
        result = self.cli("diagnose.py", self.source, "--json")
        info = json.loads(result.stdout)
        self.assertEqual(info["dialog_tail_line"], 2)
        self.assertEqual(info["file_tail_leaf"][0], 5)
        self.assertIsNone(info["recommended_truncation_line"])

    def test_new_session_cleanup_failure_keeps_confirmed_write_success(self):
        self.write([record()])
        unlink = Path.unlink

        def refuse_stage_cleanup(path, *args, **kwargs):
            if path.suffix == ".tmp":
                raise PermissionError("test stage cleanup denial")
            return unlink(path, *args, **kwargs)

        with mock.patch.object(Path, "unlink", refuse_stage_cleanup):
            code, output, error = self.run_main("--line", 1, "--new-session")
        self.assertEqual(code, 0, error)
        self.assertIn("Written", output)
        self.assertIn("new session written", error)
        target = next(p for p in self.project.glob("*.jsonl") if p != self.source)
        self.assertEqual(len(self.read(target)), 2)

    def test_thinking_cli_preserves_non_thinking_content_and_fork_ids(self):
        self.write([dict(record(), sessionId=self.source.stem,
                         message={"content": [{"type": "thinking", "signature": ""},
                                              {"type": "text", "text": "kept"},
                                              {"type": "thinking", "signature": "invalid"},
                                              {"type": "tool_use", "name": "test"}]})])
        original = self.source.read_bytes()
        result = self.cli("truncate.py", self.source, "--strip-thinking", "--new-session")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("remove 2 blocks", result.stdout)
        target = next(p for p in self.project.glob("*.jsonl") if p != self.source)
        rows = self.read(target)
        self.assertEqual(rows[0]["message"]["content"], [{"type": "text", "text": "kept"},
                                                         {"type": "tool_use", "name": "test"}])
        self.assertEqual(rows[0]["sessionId"], target.stem)
        self.assertEqual(rows[-1]["sessionId"], target.stem)
        self.assertEqual(self.source.read_bytes(), original)

    def test_thinking_only_preserves_existing_title_unless_explicitly_changed(self):
        self.write([dict(record(), message={"content": [{"type": "thinking", "thinking": "private"},
                                                       {"type": "text", "text": "kept"}]}),
                    {"type": "custom-title", "customTitle": "keep my title", "sessionId": self.source.stem}])
        result = self.cli("truncate.py", self.source, "--strip-thinking")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.read()), 2)
        self.assertEqual(self.read()[-1]["customTitle"], "keep my title")
        result = self.cli("truncate.py", self.source, "--strip-thinking", "--title", "explicit title")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.read()[-1]["customTitle"], "explicit title")

    @unittest.skipUnless(os.name == "nt", "requires native Windows token, DACL and ReplaceFileW")
    def test_sf06_windows_native_dacl_and_original_inode_backup(self):
        import ctypes
        from ctypes import wintypes

        def dacl(path):
            kernel, advapi = session_io._windows_libraries()
            descriptor = ctypes.c_void_p()
            text = wintypes.LPWSTR()
            advapi.GetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD,
                                                    ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                                                    ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
            advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = [
                ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                ctypes.POINTER(wintypes.LPWSTR), ctypes.c_void_p]
            try:
                result = advapi.GetNamedSecurityInfoW(str(path), 1, 4, None, None, None, None,
                                                     ctypes.byref(descriptor))
                self.assertEqual(result, 0)
                self.assertTrue(advapi.ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor, 1, 4, ctypes.byref(text), None))
                return text.value
            finally:
                if text:
                    kernel.LocalFree(text)
                if descriptor:
                    kernel.LocalFree(descriptor)

        self.write([record(), record("b", "a")])
        original = self.source.read_bytes()
        self.source.unlink()
        with session_io.private_file(self.source) as output:
            output.write(original)
        original_inode = self.source.stat().st_ino
        result = self.cli("truncate.py", self.source, "--line", 1)
        self.assertEqual(result.returncode, 0, result.stderr)
        backup = Path(next(line.split(": ", 1)[1] for line in result.stdout.splitlines() if line.startswith("Backup")))
        self.assertEqual(backup.stat().st_ino, original_inode)
        self.assertEqual(backup.read_bytes(), original)
        result = self.cli("truncate.py", self.source, "--line", 1, "--new-session")
        self.assertEqual(result.returncode, 0, result.stderr)
        with self.source.open("rb"):
            code, _, error = self.run_main("--line", 1)
        self.assertEqual(code, 2, error)
        self.assertIn("ReplaceFileW failed", error)
        for path in (p for p in self.project.rglob("*") if p.is_file()):
            acl = dacl(path)
            self.assertIn("D:P", acl)
            for principal in ("WD", "AU", "BU", "BG", "BA"):
                self.assertNotIn(f";;;{principal})", acl)

    def test_dry_run_writes_nothing(self):
        self.write([record(), record("b", "a")])
        before = self.source.read_bytes()
        result = self.cli("truncate.py", self.source, "--line", 1, "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(list(self.project.iterdir()), [self.source])


if __name__ == "__main__":
    unittest.main()
