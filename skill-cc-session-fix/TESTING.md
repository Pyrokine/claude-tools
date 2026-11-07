# Session JSONL regression tests

## Run

Use Python 3.8 or later and synthetic sessions only. The suite creates its own HOME/project directories and passes them
to every CLI subprocess. `SESSION_FIX_TEST_ROOT` optionally places fixtures under an existing private test directory. No
test opens real Claude Code session files.

```bash
python3 -I -B scripts/test_session_fix.py -v
ruff check --no-cache --target-version py38 scripts/
```

Both CLI entry points are exercised through isolated Python (`-I`) subprocesses. Publication interleavings call the real
CLI `main` and real filesystem implementation, intercepting only the OS operation at the specified boundary. No test
replaces the validator or publication algorithm with a substitute.

## Cases

- **SF-01**
    - Inputs and operation: Empty requested project, another project with a unique matching prefix; full-id, ambiguous
      and explicit-path controls
    - Acceptance: Both CLIs refuse cross-project id/prefix resolution; the other file remains unchanged; full id and
      explicit path still work; ambiguous matches fail

- **SF-01 links**
    - Inputs and operation: Project-scoped lookup encounters a symlink into another project
    - Acceptance: Id/prefix lookup refuses the cross-project file; an explicit existing file path retains its precedence

- **SF-02 backups**
    - Inputs and operation: Two successive in-place truncations, plus a deliberately occupied backup name
    - Acceptance: Each successful repair keeps a separate original version; a collision refuses publication and
      preserves the existing backup

- **SF-02 changes**
    - Inputs and operation: Append immediately before backup creation, or change the source between read and commit
    - Acceptance: Refuse overwrite, retain the modified source and report recovery/staging paths

- **SF-02 final window**
    - Inputs and operation: Append through an already open original file descriptor immediately after the actual POSIX
      replace
    - Acceptance: The backup retains the original inode and the appended bytes; the repaired path has a different inode

- **SF-02 unavailable primitive**
    - Inputs and operation: Disable POSIX hard-link creation, then request in-place repair and a new session
    - Acceptance: In-place repair fails with an actionable error; `--new-session` succeeds and the original remains
      unchanged

- **SF-03**
    - Inputs and operation: Retain a final JSON record without LF, in-place and fork; embed U+2028/U+2029 in message
      text
    - Acceptance: Every final physical line parses, ends with LF and retains embedded text separators

- **SF-04**
    - Inputs and operation: A two-record cycle without a leaf; a timestamped system record without a dialog anchor
    - Acceptance: Text never says Health OK; JSON retains the missing anchor/leaf state

- **SF-05**
    - Inputs and operation: Arrays, numbers, strings, null, bad JSON, and invalid uuid/timestamp/message fields before
      later valid records
    - Acceptance: Diagnosis reports the physical line and continues; invalid retained records refuse publication without
      traceback or source changes

- **SF-05 removed tail**
    - Inputs and operation: Explicitly truncate before an invalid tail record; retain unknown fields
    - Acceptance: Print the removed line and invalid count; preserve unknown fields and original invalid bytes in
      backup/source

- **SF-06 POSIX**
    - Inputs and operation: Fork, thinking cleanup and deliberately failed publication under ordinary umask
    - Acceptance: New, staged, failed and original-private backup files remain `0600`; failures retain the source

- **SF-06 Windows**
    - Inputs and operation: Native token/DACL creation, fork and `ReplaceFileW` using a private source
    - Acceptance: Protected DACL has no Everyone/Authenticated Users/Builtin Users/Guests/Administrators grant; backup
      retains original file identity and bytes

- **SF-07**
    - Inputs and operation: UTF-8 Chinese records with ASCII locale and `-X utf8=0`; invalid UTF-8 later in the file;
      escaped unpaired surrogate during fork
    - Acceptance: All valid CLI paths succeed independently of locale; diagnosis locates invalid bytes and continues;
      repair refuses invalid bytes anywhere, reports unencodable rewrites by line and retains the source

- **SF-STREAMING**
    - Inputs and operation: 80 records with 256 KiB message bodies; diagnose and fork the first two lines
    - Acceptance: Keep physical line/leaf results; traced Python allocation peak stays below 8 MiB for each operation,
      without retaining all message bodies

- **Controls**
    - Inputs and operation: Compact boundary, physical-tail leaf with out-of-order timestamps, >5 minute non-dialog
      tail, all thinking signature forms, dry-run and fork-stage cleanup failure
    - Acceptance: Preserve the physical-leaf and recommendation semantics, retained content, existing thinking-only
      titles and fork sessionId propagation; dry-run creates no session/backup/stage; cleanup failure warns without
      discarding the confirmed new-file write

## UUID and timestamp regressions

- **MH-SF-01 graph**
    - Inputs and operation: Pure cycle, cycle with a leaf, self-cycle, duplicate UUID and a 5,000-record cycle
    - Acceptance: Report physical lines and issue kinds; health=needs_review; no automatic truncation; traversal is
      iterative

- **MH-SF-01 repair**
    - Inputs and operation: Diagnose, dry-run and explicit --line/--new-session on those inputs; exclude a duplicate
      from the retained prefix; dangling-parent control
    - Acceptance: Warn about retained cycles/duplicates before writing; honor the explicit range; excluded records do
      not produce retained-chain warnings; original/backup and dangling-warning contracts remain

- **MH-SF-02 instants**
    - Inputs and operation: Equal user/assistant timestamps, Z versus .500Z, three versus six fractional digits,
      equivalent offsets and consistent naive timestamps
    - Acceptance: Compare parsed instants; choose the later physical dialog on equality; keep its original timestamp
      text; suggested truncation retains the assistant

- **MH-SF-02 ambiguity**
    - Inputs and operation: Multiple branches, mixed timezone awareness, a dialog outside the selected leaf chain,
      physically later dialogs with earlier times and parents beyond a proposed prefix
    - Acceptance: Keep the physical leaf and maximum-time dialog diagnostics; report review issues and suppress unsafe
      recommendations; preserve compact-boundary and five-minute controls

## Prefix checks across all valid physical rows

- **QL-SF-01 untimed dialog**
    - Inputs and operation: A user at L1, assistant at L2 with timestamp missing/null/empty, and system leaf ten minutes
      later; diagnose, then explicitly fork through L2
    - Acceptance: No automatic truncation; `untimed_dialog_outside_prefix` identifies L2; the explicit fork retains the
      assistant and source bytes stay unchanged

- **QL-SF-01 missing UUID**
    - Inputs and operation: A later user/assistant without UUID or timestamp, followed by a timestamped system leaf
    - Acceptance: The valid row participates in the prefix check and stops the suggestion, with its physical line
      reported

- **QL-SF-01 retained parent**
    - Inputs and operation: An attachment at L1 with UUID missing/null/empty references a system parent beyond the
      candidate dialog
    - Acceptance: No automatic truncation; `truncation_parent_outside_prefix` identifies the retained row and excluded
      parent lines

- **QL-SF-01 controls**
    - Inputs and operation: Untimed attachment and system metadata, retained parents inside the prefix, and non-dialog
      gaps of 300/301 seconds
    - Acceptance: Metadata stays valid; only the gap strictly greater than 300 seconds produces the safe recommendation;
      physical leaf and parsed-row counts stay correct

## Platform prerequisites

POSIX inode/link/replace interleavings and mode assertions require a POSIX filesystem and are skipped on Windows. The
native Windows DACL and backup case requires Windows/NTFS and is skipped on other systems. These skips describe platform
coverage, not a permanent product limitation.

Run the suite on both POSIX and native Windows to accept file publication and permission changes. A POSIX mode assertion
or a simulated `os.name` does not verify Windows ACLs. Real Claude Code `/resume` behavior is a separate manual
integration check using a disposable session; these tests verify the local repair and diagnostic contracts.
