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

## Available Tools (7 tools)

| Tool                 | Description                               |
| -------------------- | ----------------------------------------- |
| `history_search`     | Search conversation history               |
| `history_get`        | Get full message content                  |
| `history_context`    | Get surrounding messages                  |
| `history_trace`      | Trace nearby messages and tool call pairs |
| `history_build_info` | Show the running binary build identity    |
| `history_projects`   | List all projects                         |
| `history_sessions`   | List sessions in a project                |

### history_projects

Each project includes its authoritative `id`, display `path`, `path_approximate`, session count, and last activity time.
Existing local paths are reconstructed against the filesystem so hyphens, underscores, dots, and spaces remain intact.
If no unique existing path can be resolved, `path` is a readable fallback and `path_approximate=true`; use `id` for tool
calls.

### history_sessions

| Parameter   | Type   | Default | Description                                   |
| ----------- | ------ | ------- | --------------------------------------------- |
| `project`   | string | current | Project ID                                    |
| `redaction` | string | auto    | `auto`, `strict`, or `off` for session topics |

Session topics are redacted before their 100-character preview is created. The response includes aggregate `redaction`
metadata and `topic_redacted_count` when a session topic had replacements.

### history_search

| Parameter                 | Type    | Default                | Description                                          |
| ------------------------- | ------- | ---------------------- | ---------------------------------------------------- |
| `pattern`                 | string  | ""                     | Search pattern; empty returns all                    |
| `project`                 | string  | current                | Project IDs, comma-separated                         |
| `all`                     | boolean | false                  | Search all projects                                  |
| `sessions`                | string  | -                      | Session IDs, comma-separated                         |
| `since`                   | string  | -                      | Start time, RFC3339 or YYYY-MM-DD                    |
| `until`                   | string  | -                      | End time, RFC3339 or YYYY-MM-DD                      |
| `types`                   | string  | assistant,user,summary | Message types, comma-separated                       |
| `subtypes`                | string  | -                      | Message subtypes, comma-separated                    |
| `servers`                 | string  | -                      | MCP server filter, comma-separated                   |
| `tools`                   | string  | -                      | MCP tool filter, comma-separated                     |
| `lines`                   | string  | -                      | Line ranges, e.g. 100-200, !300-400                  |
| `regex`                   | boolean | false                  | Use regex                                            |
| `case_sensitive`          | boolean | false                  | Use case-sensitive matching                          |
| `subagents`               | boolean | false                  | Include sidechain and remote-agent transcripts       |
| `summary`                 | boolean | false                  | Include grouped counts in `stats.summary`            |
| `aggregate`               | boolean | false                  | Return grouped counts without result rows            |
| `dry_run`                 | boolean | false                  | Preview selected files without reading content       |
| `failed_tool_results`     | boolean | false                  | Require harness-level `is_error=true`                |
| `tool_payload_errors`     | boolean | false                  | Require an error in the tool JSON payload            |
| `output`                  | string  | -                      | Write a result file; relative paths use temp storage |
| `output_format`           | string  | jsonl                  | `jsonl`                                              |
| `redaction`               | string  | auto                   | `auto`, `strict`, or `off`                           |
| `offset`                  | number  | 0                      | Skip N results; incompatible with `slice`            |
| `limit`                   | number  | -                      | Max results; incompatible with `slice`               |
| `slice`                   | string  | -                      | Slice messages after filtering and sorting           |
| `max_content`             | number  | 4000                   | Regular preview limit (1 to 1,000,000)               |
| `max_content_tool_result` | number  | 500                    | Tool-result preview limit (1 to 1,000,000)           |
| `max_total`               | number  | 40000                  | Compact response limit (512 to 10,000,000 bytes)     |

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
`stats.skipped_invalid_timestamps` and `incomplete_reasons`. `since` cannot be later than `until`.

Search output uses `redaction=auto` by default for message content, `tool_use` previews, and structured tool fields.
`auto` covers Authorization headers plus common password, token, cookie, API key, secret, private key, and key path
fields. `strict` also redacts private key blocks, private host names, and URLs. `off` returns raw content and records
`enabled=false` in the manifest. Redacted results include `redacted=true` and `raw_available=true`; export manifests
include redaction metadata.

`output` accepts a file path or a directory. Use `tmp:relative/path` for the controlled temp area and
`cwd:relative/path` to persist under the current working directory. Unprefixed relative paths also use the controlled
temp area. Paths ending in a file extension such as `.jsonl`, `.json`, or `.txt` are treated as files, and the manifest
is written next to that file.

`slice` uses Python half-open semantics after all filters and timestamp sorting. `[-10:]` returns the latest 10 matching
messages. `[-10:-1]` excludes the latest message and returns up to 9 messages. If `max_total` removes part of a slice,
`next_query` carries a normalized positive slice for the remaining half-open range. Following it repeatedly cannot leave
the original slice. If the budget cannot fit any result while preserving a continuation cursor, the search returns
`response_too_large` instead of repeating the same slice indefinitely.

`max_total` counts the compact UTF-8 JSON text returned by `history_search`. JSON-RPC and MCP transport framing are not
included. The response reports `serialized_bytes`, `max_total_bytes`, `limits_applied`, and `complete`. Exported
`.jsonl` content is not reduced by this conversation-response budget. `next_query` and export manifests retain
`max_content_tool_result`.

### history_get

| Parameter   | Type   | Description                                      |
| ----------- | ------ | ------------------------------------------------ |
| `ref`       | string | Required message ref (`session_prefix:line`)     |
| `range`     | string | Half-open Unicode range, e.g. `0-100000`         |
| `output`    | string | File or directory; extracts images automatically |
| `project`   | string | Project ID                                       |
| `redaction` | string | `auto`, `strict`, or `off`; default is `auto`    |

Large direct responses return `content_too_large` with `content_size`, `valid_range`, `parsed_range`, `head`, `tail`,
`range_suggestion`, and `output_suggestion`.

### history_context

| Parameter        | Type    | Default | Description                                                           |
| ---------------- | ------- | ------- | --------------------------------------------------------------------- |
| `ref`            | string  | -       | Required. Message ref                                                 |
| `before`         | number  | -       | Messages before (counts only messages matching `types` AND `pattern`) |
| `after`          | number  | -       | Messages after (counts only messages matching `types` AND `pattern`)  |
| `until_type`     | string  | -       | Continue until this type                                              |
| `until_ref`      | string  | -       | Continue until another ref in the same session                        |
| `direction`      | string  | forward | forward/backward                                                      |
| `types`          | string  | -       | Message types to include (comma-separated)                            |
| `subtypes`       | string  | -       | Message subtypes to include (comma-separated)                         |
| `project`        | string  | -       | Project ID                                                            |
| `output`         | string  | -       | Export selected context to a text file and return `output_path`       |
| `redaction`      | string  | auto    | `auto`, `strict`, or `off`                                            |
| `max_content`    | number  | 4000    | Max chars per message                                                 |
| `max_total`      | number  | 40000   | Max total chars                                                       |
| `pattern`        | string  | -       | Filter pattern: only count/include messages matching this pattern     |
| `regex`          | boolean | false   | Use regex for pattern matching                                        |
| `case_sensitive` | boolean | false   | Case-sensitive pattern matching                                       |

**Note**: The anchor message (specified by `ref`) is always included regardless of `types` or `pattern` filters. When
`pattern` is set, `before`/`after` counts only messages that match the pattern. Valid `.jsonl` session metadata records
are ignored without parse warnings; malformed JSON and incomplete message records still produce warnings.
`history_trace` uses the same record handling.

A ref requires a nonempty session prefix and a positive line number, such as `c86bc677:1234`. `direction` accepts only
`forward` or `backward` and applies to `until_type`. `until_type` accepts an effective message type only. Choose exactly
one range mode: `before`/`after`, `until_type`, or `until_ref`. `until_type` and `until_ref` cannot be combined with
each other or with `before`/`after`.

### history_trace

| Parameter        | Type    | Default | Description                                                   |
| ---------------- | ------- | ------- | ------------------------------------------------------------- |
| `ref`            | string  | -       | Required. Message ref                                         |
| `before`         | number  | 20      | Messages before anchor, counted after type/pattern filters    |
| `after`          | number  | 20      | Messages after anchor, counted after type/pattern filters     |
| `project`        | string  | -       | Project ID                                                    |
| `types`          | string  | -       | Message types to include                                      |
| `subtypes`       | string  | -       | Message subtypes to include                                   |
| `pattern`        | string  | -       | Filter pattern                                                |
| `regex`          | boolean | false   | Use regex                                                     |
| `case_sensitive` | boolean | false   | Case-sensitive matching                                       |
| `servers`        | string  | -       | Filter `tool_calls` by MCP server                             |
| `tools`          | string  | -       | Filter `tool_calls` by tool name                              |
| `until_type`     | string  | -       | Continue until this message type                              |
| `until_ref`      | string  | -       | Continue until another ref in the same session                |
| `direction`      | string  | forward | forward/backward for `until_type`                             |
| `output`         | string  | -       | Export selected trace to a text file and return `output_path` |
| `redaction`      | string  | auto    | `auto`, `strict`, or `off`                                    |
| `max_content`    | number  | 4000    | Max chars per message                                         |
| `max_total`      | number  | 40000   | Max total chars across messages                               |

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
`mcp-claude-history build-info`.

## Usage Examples

### Search

```bash
# Basic search
mcp-claude-history search "error"

# Regex search
mcp-claude-history search "error|warning" --regex

# Recent messages by time filter
mcp-claude-history search "" --since 2026-04-29 --limit 10

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

The session prefix is the first 8 characters of the full session ID (e.g., `c86bc677-9f5f-4e49-8e16-5e175a059610`).

## License

MIT License - see [LICENSE](LICENSE) for details.
