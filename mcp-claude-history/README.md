# mcp-claude-history

English | [中文](README_zh.md)

A conversation history search tool for Claude Code

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/rust-1.88+-orange.svg)](https://www.rust-lang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io/)

![Linux](https://img.shields.io/badge/Linux_x86__64-tested-success)
![macOS](https://img.shields.io/badge/macOS-build_available-blue)
![Windows](https://img.shields.io/badge/Windows-build_available-blue)

## Features

- **Search**: Full-text search with regex support, time filtering, type filtering
- **Retrieve**: Get full message content with chunked retrieval and image extraction
- **Context**: Get surrounding messages for context
- **Browse**: List projects and sessions
- **Static Binary**: musl static linking, runs on most Linux x86_64 distributions

## Migrating to 2.0

Exports from `history_get`, `history_search`, `history_context`, and `history_trace` now publish a bundle directory. A
requested file name is no longer the final file path. The default creates a unique directory, such as
`results.export-<unique>/results.jsonl`; `overwrite=true` uses a stable owned destination. Read the returned
`output.content` (`output.results` for search), `output.manifest`, or `output_path` where provided. Do not reconstruct
paths from the request or assume the manifest is beside the requested file.

Export manifests use schema v2: `mcp-claude-history.get-output.v2`, `mcp-claude-history.search-results.v2`,
`mcp-claude-history.context-output.v2`, and `mcp-claude-history.trace-output.v2`. Consumers should check `schema` and
use the returned paths, completeness, byte counts, and redaction metadata.

For context and trace, `max_total` limits the final compact JSON response in UTF-8 bytes, including metadata and trace
`tool_calls`; JSON-RPC and MCP framing are excluded. Character counts or message-text lengths cannot substitute for this
budget. A response that cannot retain the anchor and required metadata returns `response_too_large`.

A date-only `until=YYYY-MM-DD` is an exclusive boundary at 00:00 UTC on the next day, so it includes the requested date
in full. `today` uses the UTC calendar. RFC3339 `until` remains inclusive at the specified instant.

`history_get.range` uses half-open Unicode character offsets in the original extracted message. Redaction checks the
whole message before selecting the range; any overlap with a sensitive value returns a marker. Do not compute range
offsets from redacted previews. `redaction=off` returns the exact original range.

## Installation

### Download Binary (Recommended)

Download the latest release from [GitHub Releases](https://github.com/Pyrokine/claude-tools/releases). Target-triple
asset names remain available for existing automation.

| Platform            | Stable asset                              |
| ------------------- | ----------------------------------------- |
| Linux x86_64        | `mcp-claude-history-linux-x86_64.tar.gz`  |
| macOS Intel         | `mcp-claude-history-macos-x86_64.tar.gz`  |
| macOS Apple Silicon | `mcp-claude-history-macos-aarch64.tar.gz` |
| Windows x86_64      | `mcp-claude-history-windows-x86_64.zip`   |

```bash
# Download and install
curl -L \
  https://github.com/Pyrokine/claude-tools/releases/latest/download/mcp-claude-history-linux-x86_64.tar.gz \
  | tar xz
chmod +x mcp-claude-history
mv mcp-claude-history ~/.local/bin/
```

### Build from Source

```bash
# Build (static linking, runs on most Linux x86_64 distributions)
cargo build --release --target x86_64-unknown-linux-musl

# Install
cp target/x86_64-unknown-linux-musl/release/mcp-claude-history ~/.local/bin/
```

## Configuration

### Claude Code

```bash
claude mcp add mcp-claude-history -- mcp-claude-history --mcp
```

### Claude Desktop / Other Clients

```json
{
    "mcpServers": {
        "mcp-claude-history": {
            "command": "mcp-claude-history",
            "args": ["--mcp"]
        }
    }
}
```

## Available Tools (8 tools)

| Tool                    | Description                                                |
| ----------------------- | ---------------------------------------------------------- |
| `history_search`        | Search or scan conversation history                        |
| `history_scan_metadata` | Page scan coverage, counts, and issues; release scan state |
| `history_get`           | Get full message content                                   |
| `history_context`       | Get surrounding messages                                   |
| `history_trace`         | Trace nearby messages and tool call pairs                  |
| `history_build_info`    | Show the running binary build identity                     |
| `history_projects`      | List all projects                                          |
| `history_sessions`      | List sessions in a project                                 |

### history_projects

Each project includes its authoritative `id`, display `path`, `path_approximate`, session count, and last activity time.
Existing local paths are reconstructed against the filesystem so hyphens, underscores, dots, and spaces remain intact.
If no unique existing path can be resolved, `path` is a readable fallback and `path_approximate=true`; use `id` for tool
calls. An existing Windows drive or UNC path may also select the matching project; aliases are canonicalized and
case-insensitive. If several projects resolve to that path, the call returns `project_ambiguous`.

### history_sessions

| Parameter   | Type   | Default | Description                                   |
| ----------- | ------ | ------- | --------------------------------------------- |
| `project`   | string | current | Project ID                                    |
| `redaction` | string | auto    | `auto`, `strict`, or `off` for session topics |

Session topics are redacted before their 100-character preview is created. The response includes aggregate `redaction`
metadata and `topic_redacted_count` when a session topic had replacements.

### history_search

| Parameter                 | Type    | Default                | Description                                                      |
| ------------------------- | ------- | ---------------------- | ---------------------------------------------------------------- |
| `mode`                    | string  | normal                 | `normal` or process-bound incremental `scan`                     |
| `cursor`                  | string  | -                      | Use the returned scan `next_query`                               |
| `scan_bytes`              | number  | 16777216               | Per-batch processing budget, 16384 to 268435456 bytes            |
| `scan_ms`                 | number  | 1000                   | Per-batch active-time budget, 10 to 10000 ms                     |
| `structured`              | string  | mode-dependent         | `full` in normal, `preview` in scan; explicit choice is retained |
| `pattern`                 | string  | ""                     | Search pattern; empty returns all                                |
| `project`                 | string  | current                | Project IDs, comma-separated                                     |
| `all`                     | boolean | false                  | Search all projects                                              |
| `sessions`                | string  | -                      | Session IDs, comma-separated                                     |
| `source`                  | string  | -                      | Exact physical source returned by search or scan metadata        |
| `since`                   | string  | -                      | RFC3339 instant, UTC date, or `today` (inclusive)                |
| `until`                   | string  | -                      | RFC3339 instant (inclusive), UTC date, or `today`                |
| `types`                   | string  | assistant,user,summary | Message types, comma-separated                                   |
| `subtypes`                | string  | -                      | Message subtypes, comma-separated                                |
| `servers`                 | string  | -                      | MCP server filter, comma-separated                               |
| `tools`                   | string  | -                      | MCP tool filter, comma-separated                                 |
| `lines`                   | string  | -                      | Line ranges, e.g. 100-200, !300-400                              |
| `regex`                   | boolean | false                  | Use regex                                                        |
| `case_sensitive`          | boolean | false                  | Use case-sensitive matching                                      |
| `subagents`               | boolean | false                  | Include sidechain and remote-agent transcripts                   |
| `summary`                 | boolean | false                  | Include grouped counts in `stats.summary`                        |
| `aggregate`               | boolean | false                  | Return grouped counts without result rows                        |
| `dry_run`                 | boolean | false                  | Preview selected files without reading content                   |
| `failed_tool_results`     | boolean | false                  | Require harness-level `is_error=true`                            |
| `tool_payload_errors`     | boolean | false                  | Require an error in the tool JSON payload                        |
| `output`                  | string  | -                      | Export result bundle; relative paths use temp storage            |
| `overwrite`               | boolean | false                  | Replace an existing owned export bundle                          |
| `output_format`           | string  | jsonl                  | `jsonl`                                                          |
| `redaction`               | string  | auto                   | `auto`, `strict`, or `off`                                       |
| `offset`                  | number  | 0                      | Skip N results; incompatible with `slice`                        |
| `limit`                   | number  | -                      | Max results; incompatible with `slice`                           |
| `slice`                   | string  | -                      | Slice messages after filtering and sorting                       |
| `max_content`             | number  | 4000                   | Regular preview limit (1 to 1,000,000)                           |
| `max_content_tool_result` | number  | 500                    | Tool-result preview limit (1 to 1,000,000)                       |
| `max_total`               | number  | 40000                  | Compact response limit (512 to 10,000,000 bytes)                 |

`subagents=false` (the default) searches only main JSONL files. `true` includes direct agent files under
`<session>/subagents/`, `<session>/remote-agents/`, and the known nested layout
`<session>/subagents/workflows/<run>/agent-<id>.jsonl`. Workflow journals are not conversation sources. `sessions`
matches each file's own ID; selecting a parent ID does not automatically include its children.
`stats.effective_filters.subagents` is always present, including when false, in normal, summary, aggregate, dry-run, and
export responses. This reports configuration; use coverage or `dry_run` to inspect selected files. Continuations retain
the same scope.

`source` selects one physical file in normal or scan mode; the CLI uses `--source`. Copy the absolute path from search
results or scan metadata. When `project` is omitted, the source selects its project. Explicit `project` and `sessions`
filters must match that file. A child source still requires `subagents=true`. Without `source`, ambiguous session IDs
remain rejected. Continuations retain `source`; scan rejects changes to the frozen source. Only recognized files inside
the current history root are accepted. Relative paths, paths outside that root, unknown layouts, and links are rejected.

Default `types` includes `summary`, which means context-compression summaries are searchable. Use `types=assistant,user`
when you only want original conversation turns. Valid types are `assistant`, `user`, `summary`, `system`, and `other`.
Valid subtypes are `human`, `tool_result`, `meta`, `text`, `tool_use`, `thinking`, `empty`, `summary`, `system`, and
`other`. `types=user,subtypes=human` selects ordinary user-shaped records. It is a classification heuristic, not proof
that a person authored the message. A known subtype supplied through `types` is accepted for compatibility and moved to
`subtypes`; unknown types and subtypes return `invalid_arguments`.

`failed_tool_results` keeps the old harness-level meaning and only checks `tool_result.is_error`; `tool_payload_errors`
is for tools that returned `success=false` or an `error` JSON payload inside a successful tool result. Non-regex
`pattern` terms are AND conditions, `a|b` is an OR group, and `!term` excludes matches. `regex=true` treats `pattern` as
one regular expression. When `since` or `until` is set, an unparseable record timestamp is excluded and reported by
`stats.skipped_invalid_timestamps` and `incomplete_reasons`. Dates are interpreted in UTC: `since=YYYY-MM-DD` starts at
00:00 UTC, `until=YYYY-MM-DD` includes the whole UTC date, and `today` uses the current UTC date. RFC3339 values include
their explicit timezone offset and compare as UTC instants. `since` cannot be later than `until`.

Search matches `pattern` against the complete extracted message, including tool input beyond the response preview limit.
Each result returns the bounded message preview in `content`; use its `ref` with `history_get` for ranges or export.
When one record contains several tool blocks, the server, tool, harness error, and payload error filters must all match
the same block. The returned tool name, input, result, and error fields come from that block and its associated
`tool_use_id`.

Names in `tools` are matched using OR. A full `mcp__server__tool` name binds the server and tool on the same block; a
short name matches the tool across servers. Local names such as `Bash` can be mixed with full MCP names. Explicit
`servers` filters are combined with `tools` using AND; full tool names do not add global server filters.
`stats.effective_filters` and `next_query` retain full tool names, and the former automatic-splitting warning is no
longer returned.

Search completeness and tool attribution are reported separately. Only records matching the content, type, time, and
line filters contribute to `stats.attribution_incomplete_reasons`; matched rows also retain
`metadata_incomplete_reason`. Missing tool associations do not make a plain content search incomplete. If a `servers` or
`tools` filter cannot be checked because of a missing association, `incomplete_reasons` includes
`tool_filter_unverifiable`. Export manifests include the same attribution reasons. Normal, summary, aggregate, and
output searches report `total_matches_exact=false` for scan gaps, including oversized JSONL lines in normal mode,
read/parse gaps, and capacity stops. Pagination and response-budget reduction do not change an otherwise exact count.
`complete=false` can therefore coexist with `total_matches_exact=true`. Pure attribution gaps stay separate unless a
tool-name filter is unverifiable.

`coverage.searched_files` lists the stable prefix of session files whose scanning was attempted, including a file that
could not be opened or was stopped partway through; `incomplete_reasons` explains those gaps. `skipped_files` lists the
unattempted suffix, and the two lists do not overlap. Keyword hits are in `results`. When the response exceeds
`max_total`, coverage paths and other auxiliary metadata are reduced before matching messages. `dry_run` reads no
content and lists the planned files instead of actual scan coverage.

Search output uses `redaction=auto` by default for message content, `tool_use` previews, and structured tool fields.
`auto` covers Authorization headers plus common password, token, cookie, API key, secret, private key, and key path
fields, including the `SSHPASS` password environment variable. `strict` also redacts private key blocks, private host
names, and URLs. `off` returns raw content and records `enabled=false` in the manifest. Redacted results include
`redacted=true` and `raw_available=true`; export manifests include redaction metadata. JSON field names are interpreted
using their decoded string value, including Unicode escapes and embedded escaped JSON. Literal backslashes in a field
name are not repeatedly decoded. Replacements keep original value positions and leave nonsensitive text and formatting
unchanged.

Auto and strict also redact complete npm access tokens: lowercase `npm_` followed by exactly 36 ASCII alphanumeric
characters, with Unicode word boundaries on both sides. This includes standalone values and separately quoted command
arguments in text, structured tool fields, record views, and exports. Shorter or longer values and surrounding
identifiers retain their existing behavior; `off` preserves the original value.

Command lines redact the values of `--password`, `--http-password`, `--ftp-password`, and `--proxy-password` with
whitespace or `=` separators, including quoted values and escaped JSON. The complete argument is redacted, including
adjacent quoted and unquoted parts and escaped spaces. Enclosing JSON string boundaries and empty values leave later
fields unchanged. User names and nonsensitive arguments remain visible; `off` preserves the original command.

Auto and strict redact UUID values in compact token-return statements such as
`token created, returned a new UUID <value>` and `令牌创建成功，返回新 UUID <value>`. The token label and return clause
must be on the same line, with no more than 256 intervening characters; separate JSON fields and line breaks do not form
one statement. Only the UUID value is replaced. Ordinary session, ref, and operation identifiers remain visible; `off`
preserves the original text.

For unquoted assignment names and named arguments, a bounded RHS scan preserves complete calls, attribute chains,
subscripts, and lambdas without value string literals, such as `token = text(node, 1)`,
`sorted(values, key=lambda x: x['durationNs'])`, and `process_key = path.name.rsplit('.', 1)[0]`. String exceptions are
syntactic: an identifier-shaped subscript field name, or a punctuation-only delimiter in a method's
`(delimiter, integer)[index]` form. There is no function-name allowlist or blanket code-fence exemption. Ordinary string
arguments, string-returning lambdas, concatenation, malformed expressions, and nesting beyond 32 levels redact the whole
candidate RHS; unmatched or excessive nesting consumes the remaining candidate text. Preserved expressions still undergo
nested sensitive-field and Authorization/Cookie checks. Quoted JSON keys and structured sensitive fields retain
whole-value redaction. This is a limited syntax heuristic: plain text such as `token=foo(bar)` cannot establish whether
the value is code or a credential. `off` preserves the raw text, and all message tools and exports share these rules,
with range selection applied to original Unicode positions afterward.

Names sensitive only in strict mode keep unquoted double-colon namespace and log separators, including `host::method()`
and `ghost_appearance :: description`. Credential fields such as `password::value`, quoted fields, triple-colon values
such as `host:::1`, and independent private IP/URL checks retain their existing protection.

`output` accepts a file path or a directory. Use `tmp:relative/path` for controlled temporary storage and
`cwd:relative/path` to persist under the current working directory. Unprefixed relative paths also use temporary
storage. Each export publishes one directory containing the content, manifest, and any images. By default, directory
outputs receive a unique suffix; explicit file names such as `results.jsonl` become
`results.export-<unique>/results.jsonl` by default. With `overwrite=true`, the stable destination is
`results.export/results.jsonl`. To replace a unique file export, pass its returned content path as `output` with
`overwrite=true`. `output.results` for search, `output.content` for the other tools, `output.manifest`, and
`output_path` where provided give the actual paths. To replace an existing owned export directory, set `overwrite=true`
(CLI: `--overwrite`); unrelated directories cannot be replaced. Files are staged beside the destination before
publication. An interrupted replacement is recovered on the next `overwrite=true` request. Recovery from another process
requires a record older than 30 seconds and confirmation that the publishing process has exited; otherwise it returns
`output_busy`. If publication did not finish, the previous bundle is restored. A verified new bundle is kept and its
backup is removed. An unrecognized state returns `output_restore_failed` without deleting either bundle. Windows output
paths reject ADS, reserved device names, invalid characters, and trailing spaces or dots. Windows private ACL creation
or verification failures return `privacy_not_enforced_on_windows`. On MCP startup or the first temporary export,
sessions older than 24 hours are removed only when their ownership marker matches and their process has exited. Legacy
directories, unmarked directories, and `cwd:` output are preserved. Successful `tmp:` exports include the cleanup
condition in `output.retention`; `cwd:` exports omit that field. Each temporary session is limited to 256 entries and
128 MiB.

Exported search rows use the same filtering, timestamp ordering, and de-duplication as inline results, subject to a
20,000-row / 16 MiB export ceiling. The v2 manifest records actual rows and bytes, `complete`, and `incomplete_reasons`,
including any scan or export limits. Normal search skips and reports individual JSONL lines over 8 MiB; scan and the
reference readers index oversized records for bounded previews, range retrieval, and output. Context and trace reject
selected windows over 2,000 messages (`session_window_limit`) or 32 MiB (`session_window_memory_limit`) rather than
loading the whole session.

`slice` uses Python half-open semantics after all filters and timestamp sorting. `[-10:]` returns the latest 10 matching
messages. `[-10:-1]` excludes the latest message and returns up to 9 messages. If `max_total` removes part of a slice,
`next_query` carries a normalized positive slice for the remaining half-open range. Following it repeatedly cannot leave
the original slice. Pagination also preserves `lines`, including exclusions and open-ended ranges. If the budget cannot
fit any result while preserving a continuation cursor, the search returns `response_too_large` instead of repeating the
same slice indefinitely.

`max_total` counts the compact UTF-8 JSON text returned by `history_search`. JSON-RPC and MCP transport framing are not
included. The response reports `serialized_bytes`, `max_total_bytes`, `limits_applied`, and `complete`. Exported
`.jsonl` content is not reduced by this conversation-response budget. `next_query` and export manifests retain
`max_content_tool_result`.

#### Normal response budgets

Normal search retains timestamp ordering, UUID de-duplication, regex, and slice. Collection stops at 50,000 matches or
32 MiB of cached results and reports the gap; use scan to traverse the full source set. Rust regex does not support
look-around or backreferences.

Metadata reduced by `max_total` is listed in `stats.metadata_dimensions`, keyed by fields such as
`coverage.searched_files` and `summary.by_tool`. Each affected dimension reports `total`, `returned`, and `omitted`; a
reduced empty array is not a zero distribution. A `response_too_large` error reports the required bytes and a
`next_query` or exact `history_get` pointer when recovery is available. Follow the returned query without changing its
filters.

`structured=preview` bounds structured tool fields. `original_bytes` is the UTF-8 byte count of the full redacted JSON
before preview truncation. The `get` pointer preserves the full ref, project, source, view, original block index, and
redaction mode. Normal defaults to `full`; scan defaults to `preview`. Explicit `full` is never silently converted to
preview. If it cannot fit, use the error's get pointer or budget guidance.

#### Incremental scan

Start with `history_search(mode="scan", ...)`, then pass each returned `next_query` unchanged. Scan emits deterministic
file/physical-line order, preserves duplicate UUID sources, and freezes filters, time boundaries, and source byte
boundaries. Appended suffixes are excluded. Replacement, truncation, and detected source changes fail explicitly. An
empty result page can still make progress; continue until `scan_complete=true` and `has_more=false`.

`scan_bytes` counts processing reads, including indexing and projection, so it can exceed the unique source-file bytes.
`scan_ms` limits active batch processing. Scan rejects regex, slice, nonzero offset, output, and dry-run. Its response
reports `scan_id`, cumulative `stats`, `scan_complete`, `counts_exact`, and `attribution_complete` separately. Read full
coverage, effective filters, summary buckets, warnings, and attribution records through `history_scan_metadata`. Invalid
UTF-8 and malformed JSON records, including oversized records, are counted in `invalid_records` and listed with their
source/ref/line in metadata. Scan continues through valid suffixes and reports `counts_exact=false`. Capacity,
source-change, and other processing errors still fail explicitly. Long field names in message text are not rejected for
exceeding 4 KiB. Quoted, unquoted, Unicode-escaped, and nested JSON-escaped fields retain the same redaction rules;
invalid string escapes use the raw field text. JSON object keys in the oversized-record index remain limited to 4 KiB of
decoded UTF-8 per key.

Cursors belong to the running MCP instance. Repeating the most recently successful request with the same budgets replays
its response. Changed replay budgets, frozen filters, stale cursors, and another instance return explicit errors. A
record that cannot fit is retained, and `response_too_large.available.next_query` points to the unconsumed page. The
instance retains at most four scans; idle scans expire after 20 minutes and metadata is limited to 32 MiB per scan.
Release state when finished. Cancellation stops reads and CPU work; a cancelled scan releases its cursor state. A
`scan_metadata_quota` error reports `metadata_bytes_used`, `requested_bytes`, `max_metadata_bytes`, `remaining_bytes`,
`files_enumerated`, and `scan_phase`. The byte values describe quota accounting, not process RSS. Reduce the query by
project or session, read the failed scan's metadata, and release its state; the 32 MiB limit remains in force.

The CLI command `search --mode scan` drives all batches in one process and writes NDJSON result pages followed by
metadata pages. Identify result pages by `results` and metadata pages by `items`. It releases the scan afterward;
`--cursor` cannot resume a different CLI process.

### history_scan_metadata

| Parameter   | Type    | Default  | Description                                             |
| ----------- | ------- | -------- | ------------------------------------------------------- |
| `scan_id`   | string  | required | Use the returned `metadata_query`                       |
| `cursor`    | string  | -        | Metadata cursor from `next_query`                       |
| `limit`     | number  | 100      | Items per page, 1 to 10000                              |
| `max_total` | number  | 40000    | Compact UTF-8 JSON budget, 512 to 10000000 bytes        |
| `release`   | boolean | false    | Stop and release scan state; incompatible with `cursor` |

Metadata pagination is stable after the scan completes or fails. Before then it returns `scan_in_progress`. Each item
has `kind` and `value`; `dimensions` reports the total, returned, and omitted item counts for every dimension. Follow
metadata `next_query` until `has_more=false`, then call with `scan_id` and `release=true`. Release does not remove user
exports.

### history_get

| Parameter   | Type   | Description                                                            |
| ----------- | ------ | ---------------------------------------------------------------------- |
| `ref`       | string | Required message ref (`session_prefix:line`)                           |
| `source`    | string | Exact absolute source returned by search or scan metadata              |
| `view`      | string | `content` (default), `tool_input`, `tool_result`, or `record`          |
| `block`     | number | Original `message.content` array index for a tool view                 |
| `range`     | string | Half-open Unicode range in the selected original view, e.g. `0-100000` |
| `output`    | string | File or directory; extracts images automatically                       |
| `overwrite` | bool   | Replace an existing owned export bundle                                |
| `project`   | string | Project ID                                                             |
| `redaction` | string | `auto`, `strict`, or `off`; default is `auto`                          |

Large direct responses return `content_too_large` with `content_size`, `valid_range`, `parsed_range`, `head`, `tail`,
`range_suggestion`, and `output_suggestion`. Range offsets use the original message's Unicode character positions. Auto
and strict redaction inspect the complete message before rendering a range, so a range that overlaps any part of a
sensitive value returns a redaction marker. `redaction=off` returns the exact raw range, including complete tool input.

`view=tool_input` returns normalized input JSON; `view=tool_result` returns the normalized complete tool-result block.
Use the original content-array `block` index when more than one block has the requested type. Range offsets refer to
that selected view. Oversized JSONL records are indexed before rendering the range or publishing output.

`view=record` returns the whole original JSON object as normalized text with the selected redaction mode. It includes
original record types and internal payloads that the default content view does not display, even when message metadata
is absent. It does not preserve source whitespace or key order, accept `block`, or extract image files. Range offsets
refer to the normalized object before redaction; source boundaries, output quotas, and private export permissions remain
unchanged. Default content and tool views keep their existing behavior.

Search results and preview get pointers include `source`. If a ref selects several physical files, the reference readers
return `session_ambiguous` with candidate sources. Pass a returned source unchanged to get, context, or trace, or use
CLI `--source`. Paths must belong to the matching ref/project in the recognized history layouts; arbitrary files and
links are rejected.

### history_context

| Parameter        | Type    | Default | Description                                                           |
| ---------------- | ------- | ------- | --------------------------------------------------------------------- |
| `source`         | string  | -       | Exact source returned by search or scan metadata                      |
| `ref`            | string  | -       | Required. Message ref                                                 |
| `before`         | number  | -       | Messages before (counts only messages matching `types` AND `pattern`) |
| `after`          | number  | -       | Messages after (counts only messages matching `types` AND `pattern`)  |
| `until_type`     | string  | -       | Continue until this type                                              |
| `until_ref`      | string  | -       | Continue until another ref in the same session                        |
| `direction`      | string  | forward | forward/backward                                                      |
| `types`          | string  | -       | Message types to include (comma-separated)                            |
| `subtypes`       | string  | -       | Message subtypes to include (comma-separated)                         |
| `project`        | string  | -       | Project ID                                                            |
| `output`         | string  | -       | Export selected context and return `output_path`                      |
| `overwrite`      | boolean | false   | Replace an existing owned export bundle                               |
| `redaction`      | string  | auto    | `auto`, `strict`, or `off`                                            |
| `max_content`    | number  | 4000    | Max chars per message                                                 |
| `max_total`      | number  | 40000   | Max UTF-8 bytes of the complete compact JSON response                 |
| `pattern`        | string  | -       | Filter pattern: only count/include messages matching this pattern     |
| `regex`          | boolean | false   | Use regex for pattern matching                                        |
| `case_sensitive` | boolean | false   | Case-sensitive pattern matching                                       |

The anchor message (specified by `ref`) is always included. `before`/`after` count only messages matching `types`,
`subtypes`, and the pattern applied to redacted content. When both counts are omitted, context extends to EOF; when only
`before` is set, `after` is zero.

Local context and trace queries support sessions with more than 100,000 messages. Limits apply to the selected span: all
valid messages in that span, including those hidden by display filters, count toward the 2,000-message and 32 MiB
limits. Exceeding either returns `session_window_limit` or `session_window_memory_limit`, respectively. Diagnostics
cover the scanned prefix only; an unread suffix is not checked. Valid `.jsonl` session metadata records are ignored
without warnings; malformed JSON and incomplete message records produce warnings. Valid oversized records use the shared
index and retain message positions and tool pairing.

`truncated=true` is returned when either a message exceeds `max_content` or the complete UTF-8 JSON response exceeds
`max_total`. If even the anchor and metadata cannot fit, the call returns `response_too_large`.

A ref requires a nonempty session prefix and a positive line number, such as `c86bc677:1234`. `direction` accepts only
`forward` or `backward` and applies to `until_type`. `until_type` accepts an effective message type only. Choose exactly
one range mode: `before`/`after`, `until_type`, or `until_ref`. `until_type` and `until_ref` cannot be combined with
each other or with `before`/`after`. `until_type` includes the nearest boundary in the chosen direction, regardless of
display filters, and never uses the anchor itself as the boundary. If no boundary exists, only the anchor is selected.
`until_ref` includes both endpoints in either direction; a missing endpoint returns `ref_not_found`.

### history_trace

| Parameter        | Type    | Default | Description                                                |
| ---------------- | ------- | ------- | ---------------------------------------------------------- |
| `source`         | string  | -       | Exact source returned by search or scan metadata           |
| `ref`            | string  | -       | Required. Message ref                                      |
| `before`         | number  | 20      | Messages before anchor, counted after type/pattern filters |
| `after`          | number  | 20      | Messages after anchor, counted after type/pattern filters  |
| `project`        | string  | -       | Project ID                                                 |
| `types`          | string  | -       | Message types to include                                   |
| `subtypes`       | string  | -       | Message subtypes to include                                |
| `pattern`        | string  | -       | Filter pattern                                             |
| `regex`          | boolean | false   | Use regex                                                  |
| `case_sensitive` | boolean | false   | Case-sensitive matching                                    |
| `servers`        | string  | -       | Filter `tool_calls` by MCP server                          |
| `tools`          | string  | -       | Filter `tool_calls` by tool name                           |
| `until_type`     | string  | -       | Continue until this message type                           |
| `until_ref`      | string  | -       | Continue until another ref in the same session             |
| `direction`      | string  | forward | forward/backward for `until_type`                          |
| `output`         | string  | -       | Export selected trace and return `output_path`             |
| `overwrite`      | boolean | false   | Replace an existing owned export bundle                    |
| `redaction`      | string  | auto    | `auto`, `strict`, or `off`                                 |
| `max_content`    | number  | 4000    | Max chars per message                                      |
| `max_total`      | number  | 40000   | Max UTF-8 bytes of the complete compact JSON response      |

`history_trace` returns the nearby messages plus detected tool calls and matching tool results in `tool_calls`. A result
with `tool_use_id` only matches that exact call. Results without an ID use a matching assistant parent UUID, or the
single pending call as a legacy fallback. Each call reports `match_method`; unmatched and ambiguous results appear in
the bounded `association_issues` list. Structured tool-result previews use recursive key-based redaction before JSON
serialization, including JSON objects embedded in text content, and the same redacted preview is written to trace
exports. `before` and `after` default to 20 only when neither `until_type` nor `until_ref` is set. The same ref,
direction, type, subtype, and mutually exclusive range-mode rules as `history_context` apply.

### history_build_info

Returns the running binary's package version, commit, target, profile, UTC build timestamp, dirty state, and whether the
identity is reproducible. A dirty local build is never marked reproducible. The CLI equivalent is
`mcp-claude-history build-info`. The CLI also supports `mcp-claude-history --version`. MCP redaction schemas advertise
`auto`, `strict` and `off`; the legacy `none` and `raw` values still parse as `off`.

## Usage Examples

### Search

```bash
# Basic search
mcp-claude-history search "error"

# Regex search
mcp-claude-history search "error|warning" --regex

# Recent messages by time filter
mcp-claude-history search "" --since 2026-04-29 --limit 10

# Traverse sources in one process; NDJSON contains result pages, then metadata pages
mcp-claude-history search "error" --mode scan --all --subagents --redaction strict

# Latest 10 matching messages
mcp-claude-history search "" --slice '[-10:]'

# Python-style half-open slice: excludes the newest matching message
mcp-claude-history search "" --slice '[-10:-1]'

# Search specific project
mcp-claude-history search "bug" --project -home-user-myproject

# Filter MCP tool calls and return a summary
mcp-claude-history search "" --servers mcp-chrome --tools browse,evaluate --summary

# Find successful tool results whose JSON payload still reports an error
mcp-claude-history search "" --tool-payload-errors --servers mcp-chrome

# Write JSONL for chunked processing
mcp-claude-history search "error" --output tmp:history/error.jsonl --output-format jsonl

# Use strict redaction for exported search results
mcp-claude-history search "error" --redaction strict --output tmp:history/error.jsonl --output-format jsonl
```

### Get Full Content

```bash
# Get message by ref
mcp-claude-history get --ref c86bc677:1234

# Export to controlled temp dir (with images)
mcp-claude-history get --ref c86bc677:1234 --output tmp:export

# Persist under the current working directory
mcp-claude-history get --ref c86bc677:1234 --output cwd:export

# Export to an explicit text file and keep raw content
mcp-claude-history get --ref c86bc677:1234 --output tmp:history/message.txt --redaction off

# Chunked retrieval for large content
mcp-claude-history get --ref c86bc677:1234 --range 0-100000
```

### Get Context

```bash
# Get 5 messages before and after
mcp-claude-history context --ref c86bc677:1234 --before 5 --after 5

# Get 10 user messages before (filter by type)
mcp-claude-history context --ref c86bc677:1234 --before 10 --types user

# Get messages until next user message
mcp-claude-history context --ref c86bc677:1234 --until-type user --direction forward

# Get only messages matching a pattern around the anchor
mcp-claude-history context --ref c86bc677:1234 --before 5 --after 5 --pattern error --case-sensitive

# Export context from one ref to another ref in the same session
mcp-claude-history context --ref c86bc677:1234 --until-ref c86bc677:1300 --output tmp:history-context

# Export context to an explicit text file with strict redaction
mcp-claude-history context --ref c86bc677:1234 --before 5 --after 5 --output tmp:history/context.txt --redaction strict
```

### Trace Tool Calls

```bash
# Trace nearby messages and tool call/result pairs
mcp-claude-history trace --ref c86bc677:1234 --before 20 --after 20

# Trace and export only chrome browse/evaluate tool calls around a ref
mcp-claude-history trace --ref c86bc677:1234 --servers mcp-chrome --tools browse,evaluate --output tmp:history-trace

# Export trace to an explicit text file with strict redaction
mcp-claude-history trace --ref c86bc677:1234 --before 5 --after 5 --output tmp:history/trace.txt --redaction strict
```

### Browse

```bash
# List all projects
mcp-claude-history projects

# List sessions in a project
mcp-claude-history sessions --project -home-user-myproject
```

## Ref Format

```
ref = session_prefix:line
e.g., c86bc677:1234
```

For a main session, the prefix is the first 8 characters of the full session ID (for example,
`c86bc677-9f5f-4e49-8e16-5e175a059610`). For an `agent-<id>` session, the canonical prefix is the first 8 characters
after `agent-`. `ref`, session filters, and `until_ref` accept either the canonical prefix or the full session ID.

## License

MIT License - see [LICENSE](LICENSE) for details.
