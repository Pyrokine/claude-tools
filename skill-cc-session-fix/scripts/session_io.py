"""Shared JSONL validation, project resolution and recoverable private writes."""

from __future__ import annotations

import ctypes
import json
import os
import shutil
import stat
import sys
import uuid
from datetime import datetime
from pathlib import Path


class SessionError(ValueError):
    """An input or publication error that leaves recovery data intact."""


class SessionChain:
    """Index UUID links and physical lines without retaining message payloads."""

    def __init__(self):
        self.records = {}
        self.parents = set()
        self.child_parents = set()
        self.duplicates = []

    def add(self, obj, line):
        uid = obj.get("uuid")
        parent = obj.get("parentUuid")
        if parent:
            self.parents.add(parent)
            if uid:
                self.child_parents.add(parent)
        if uid:
            if uid in self.records:
                first_line = self.records[uid][1]
                self.duplicates.append({
                    "line": line, "kind": "duplicate_uuid",
                    "message": f"L{line}: duplicate uuid {uid}, first seen at L{first_line}",
                })
            else:
                self.records[uid] = (parent, line)

    def diagnostics(self):
        issues = list(self.duplicates)
        checked = set()
        for uid in self.records:
            path = []
            positions = {}
            current = uid
            while current in self.records and current not in checked:
                if current in positions:
                    cycle = path[positions[current]:]
                    line = self.records[current][1]
                    locations = " -> ".join(f"L{self.records[node][1]}" for node in cycle + [current])
                    issues.append({"line": line, "kind": "uuid_cycle",
                                   "message": f"L{line}: uuid parent cycle {locations}"})
                    break
                positions[current] = len(path)
                path.append(current)
                current = self.records[current][0]
            checked.update(path)
        return issues

    def contains_ancestor(self, leaf, ancestor):
        seen = set()
        while leaf in self.records and leaf not in seen:
            if leaf == ancestor:
                return True
            seen.add(leaf)
            leaf = self.records[leaf][0]
        return False


def configure_console():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="strict")


def resolve_jsonl(arg, project_hash=None):
    explicit = Path(arg)
    if explicit.is_file():
        return explicit.resolve()
    if any(char in arg for char in ("/", "\\")) or arg in ("", ".", ".."):
        raise SessionError(f"No jsonl found for '{arg}'")
    root = Path.home() / ".claude" / "projects"
    if project_hash:
        if project_hash in (".", "..") or any(char in project_hash for char in ("/", "\\")):
            raise SessionError("--project must name one project directory")
        directories = [root / project_hash]
        if directories[0].is_symlink():
            raise SessionError("--project must name a project directory, not a symlink; use an explicit file path")
        direct = directories[0] / f"{arg}.jsonl"
        if direct.is_file() and direct.resolve().parent == directories[0].resolve():
            return direct.resolve()
    else:
        directories = sorted(root.iterdir()) if root.is_dir() else []
    matches = sorted(path for directory in directories if directory.is_dir()
                     for path in directory.iterdir()
                     if path.is_file() and path.suffix == ".jsonl" and path.stem.startswith(arg)
                     and (not project_hash or path.resolve().parent == directory.resolve()))
    if len(matches) == 1:
        return matches[0].resolve()
    if matches:
        raise SessionError(f"Multiple matches for '{arg}':\n" + "\n".join(f"  {p}" for p in matches))
    raise SessionError(f"No jsonl found for '{arg}'" + (f" in project '{project_hash}'" if project_hash else ""))


def parse_record(raw, line):
    """Validate only fields consumed by the diagnostics and repair commands."""
    try:
        text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
    except UnicodeDecodeError as exc:
        raise SessionError(f"L{line}: invalid UTF-8 at byte {exc.start + 1}") from exc
    try:
        obj = json.loads(text, parse_constant=_invalid_constant)
    except (ValueError, RecursionError) as exc:
        detail = f"column {exc.colno}" if isinstance(exc, json.JSONDecodeError) else type(exc).__name__
        raise SessionError(f"L{line}: invalid JSON ({detail})") from exc
    if not isinstance(obj, dict):
        raise SessionError(f"L{line}: record must be a JSON object")
    for field in ("uuid", "parentUuid", "timestamp", "type", "subtype", "summary"):
        if field in obj and obj[field] is not None and not isinstance(obj[field], str):
            raise SessionError(f"L{line}: {field} must be a string or null")
    if obj.get("timestamp"):
        try:
            datetime.fromisoformat(obj["timestamp"].replace("Z", "+00:00"))
        except ValueError as exc:
            raise SessionError(f"L{line}: timestamp must be an ISO 8601 date") from exc
    if "message" in obj:
        message = obj["message"]
        if not isinstance(message, dict):
            raise SessionError(f"L{line}: message must be an object")
        if "content" in message and not isinstance(message["content"], (str, list)):
            raise SessionError(f"L{line}: message.content must be a string or array")
        if isinstance(message.get("content"), list):
            for block in message["content"]:
                if isinstance(block, dict) and block.get("type") == "text" and not isinstance(block.get("text"), str):
                    raise SessionError(f"L{line}: text block must contain a string text")
    return obj


def _invalid_constant(value):
    raise ValueError(f"Invalid JSON constant: {value}")


def file_stamp(value):
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_ctime_ns, stat.S_IMODE(value.st_mode))


def check_source(source, stream, expected):
    current = file_stamp(os.fstat(stream.fileno()))
    by_path = file_stamp(source.stat())
    if os.name == "nt":
        # Windows 的路径 ctime 与描述符 ctime 存在创建／变更时间差异
        same_path = by_path[:4] == expected[:4] and by_path[5:] == expected[5:]
    else:
        same_path = by_path == expected
    if current != expected or not same_path:
        raise SessionError("Source changed while reading or preparing the repair; "
                           "original retained, retry from a fresh diagnosis")


def _windows_libraries():
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                          wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.DWORD)]
    return kernel, advapi


def _windows_private_create(path, directory=False):
    """Use a protected owner/SYSTEM DACL from the instant of creation."""
    import msvcrt
    from ctypes import wintypes

    class SecurityAttributes(ctypes.Structure):
        _fields_ = [("nLength", wintypes.DWORD), ("lpSecurityDescriptor", ctypes.c_void_p),
                    ("bInheritHandle", wintypes.BOOL)]

    kernel, advapi = _windows_libraries()
    volume = ctypes.create_unicode_buffer(32768)
    flags = wintypes.DWORD()
    kernel.GetVolumePathNameW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    kernel.GetVolumeInformationW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD,
                                           ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD),
                                           wintypes.LPWSTR, wintypes.DWORD]
    if not kernel.GetVolumePathNameW(str(path.parent), volume, len(volume)):
        raise ctypes.WinError(ctypes.get_last_error())
    if not kernel.GetVolumeInformationW(volume, None, 0, None, None, ctypes.byref(flags), None, 0):
        raise ctypes.WinError(ctypes.get_last_error())
    if not flags.value & 0x00000008:
        raise SessionError("Private Windows output requires a filesystem with persistent ACLs")
    token = wintypes.HANDLE()
    sid_text = wintypes.LPWSTR()
    descriptor = ctypes.c_void_p()
    try:
        if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
            raise ctypes.WinError(ctypes.get_last_error())
        needed = wintypes.DWORD()
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))
        if not needed.value:
            raise ctypes.WinError(ctypes.get_last_error())
        buffer = ctypes.create_string_buffer(needed.value)
        if not advapi.GetTokenInformation(token, 1, buffer, needed, ctypes.byref(needed)):
            raise ctypes.WinError(ctypes.get_last_error())
        sid = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0]
        if not advapi.ConvertSidToStringSidW(sid, ctypes.byref(sid_text)):
            raise ctypes.WinError(ctypes.get_last_error())
        sddl = f"D:P(A;;FA;;;{sid_text.value})(A;;FA;;;SY)"
        if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
            raise ctypes.WinError(ctypes.get_last_error())
        attributes = SecurityAttributes(ctypes.sizeof(SecurityAttributes), descriptor, False)
        if directory:
            kernel.CreateDirectoryW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(SecurityAttributes)]
            if not kernel.CreateDirectoryW(str(path), ctypes.byref(attributes)):
                raise ctypes.WinError(ctypes.get_last_error())
            return None
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                      ctypes.POINTER(SecurityAttributes), wintypes.DWORD,
                                      wintypes.DWORD, wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        handle = kernel.CreateFileW(str(path), 0xC0000000, 0x7, ctypes.byref(attributes), 1, 0x80, None)
        if handle == wintypes.HANDLE(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return msvcrt.open_osfhandle(handle, os.O_RDWR | os.O_BINARY)
        except Exception:
            kernel.CloseHandle(handle)
            raise
    finally:
        if token:
            kernel.CloseHandle(token)
        if sid_text:
            kernel.LocalFree(sid_text)
        if descriptor:
            kernel.LocalFree(descriptor)


def private_file(path):
    if os.name == "nt":
        return os.fdopen(_windows_private_create(path), "w+b")
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.fchmod(fd, 0o600)
        return os.fdopen(fd, "w+b")
    except Exception:
        os.close(fd)
        raise


def open_source(path):
    if os.name != "nt":
        return path.open("rb")
    import msvcrt
    from ctypes import wintypes

    kernel, _ = _windows_libraries()
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    handle = kernel.CreateFileW(str(path), 0x80000000, 0x7, None, 3, 0x80, None)
    if handle == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    except Exception:
        kernel.CloseHandle(handle)
        raise
    return os.fdopen(fd, "rb")


def publish(stage, target, source, stream, expected, new_session=False):
    """Publish a validated stage without sacrificing the original inode."""
    check_source(source, stream, expected)
    if new_session:
        with private_file(target) as output, stage.open("rb") as prepared:
            shutil.copyfileobj(prepared, output, 256 * 1024)
            output.flush()
            os.fsync(output.fileno())
        try:
            stage.unlink()
        except OSError as exc:
            print(f"WARNING: new session written; private stage cleanup failed at {stage}: {exc}", file=sys.stderr)
        return None
    if os.name == "nt":
        return _publish_windows(stage, target, source, stream, expected)
    backup = source.with_name(source.name + f".bak.{uuid.uuid4().hex}")
    try:
        os.link(source, backup)
    except OSError as exc:
        raise SessionError(f"Cannot preserve original inode in a unique backup; use --new-session: {exc}") from exc
    # Creating the hard link changes ctime; all other identity/content facts must match.
    linked = file_stamp(os.fstat(stream.fileno()))
    if linked[:4] != expected[:4] or linked[5:] != expected[5:] or file_stamp(backup.stat()) != linked:
        raise SessionError(f"Source changed before backup; source retained, recovery copy: {backup}")
    try:
        check_source(source, stream, linked)
        os.replace(stage, target)
    except (OSError, SessionError) as exc:
        raise SessionError(f"Publication failed; original inode retained at {backup}: {exc}") from exc
    return backup


def _publish_windows(stage, target, source, stream, expected):
    from ctypes import wintypes

    kernel, _ = _windows_libraries()
    backup_dir = source.with_name(source.name + f".bak.{uuid.uuid4().hex}")
    _windows_private_create(backup_dir, directory=True)
    backup = backup_dir / source.name
    kernel.ReplaceFileW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR,
                                    wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p]
    check_source(source, stream, expected)
    if not kernel.ReplaceFileW(str(target), str(stage), str(backup), 0, None, None):
        code = ctypes.get_last_error()
        raise SessionError(f"ReplaceFileW failed ({code}); inspect source, private stage {stage} "
                           f"and recovery path {backup}")
    return backup
