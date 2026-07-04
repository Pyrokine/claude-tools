# mcp-claude-history

English | [中文](README_zh.md)

A conversation history search tool for Claude Code

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/rust-1.70+-orange.svg)](https://www.rust-lang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io/)

![Linux](https://img.shields.io/badge/Linux_x86__64-tested-success)
![macOS](https://img.shields.io/badge/macOS-untested-yellow)
![Windows](https://img.shields.io/badge/Windows-unsupported-red)

## Features

- **Search**: Full-text search with regex support, time filtering, type filtering
- **Retrieve**: Get full message content with chunked retrieval and image extraction
- **Context**: Get surrounding messages for context
- **Browse**: List projects and sessions
- **Static Binary**: musl static linking, runs on most Linux x86_64 distributions

## Installation

### Download Binary (Recommended)

Download the latest release from [GitHub Releases](https://github.com/Pyrokine/claude-tools/releases):

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
      "args": [
        "--mcp"
      ]
    }
  }
}
```

## Available Tools (6 tools)

| Tool               | Description                               |
|--------------------|-------------------------------------------|
| `history_search`   | Search conversation history               |
| `history_get`      | Get full message content                  |
| `history_context`  | Get surrounding messages                  |
| `history_trace`    | Trace nearby messages and tool call pairs |
| `history_projects` | List all projects                         |
| `history_sessions` | List sessions in a project                |

### history_search

| Parameter             | Type    | Default                | Description                                                         |
|-----------------------|---------|------------------------|---------------------------------------------------------------------|
| `pattern`             | string  | ""                     | Search pattern (empty returns all)                                  |
| `project`             | string  | current                | Project ID (comma-separated)                                        |
| `all`                 | boolean | false                  | Search all projects                                                 |
| `sessions`            | string  | -                      | Session IDs (comma-separated)                                       |
| `since`               | string  | -                      | Start time, RFC3339 or YYYY-MM-DD                                   |
| `until`               | string  | -                      | End time, RFC3339 or YYYY-MM-DD                                     |
| `types`               | string  | assistant,user,summary | Message types                                                       |
| `servers`             | string  | -                      | MCP server filter, comma-separated                                  |
| `tools`               | string  | -                      | MCP tool filter, comma-separated                                    |
| `lines`               | string  | -                      | Line ranges (e.g., 100-200, !300-400)                               |
| `regex`               | boolean | false                  | Use regex                                                           |
| `case_sensitive`      | boolean | false                  | Case sensitive                                                      |
| `subagents`           | boolean | false                  | Include sidechain transcripts under `subagents` and `remote-agents` |
| `summary`             | boolean | false                  | Return grouped summary instead of full result content               |
| `failed_tool_results` | boolean | false                  | Only return tool results where the harness marked `is_error=true`   |
| `tool_payload_errors` | boolean | false                  | Only return tool results whose JSON payload reports an error        |
| `output`              | string  | -                      | Write result file, relative paths use controlled temp               |
| `output_format`       | string  | jsonl                  | `jsonl`                                                             |
| `redaction`           | string  | auto                   | `auto`, `strict`, or `off`                                          |
| `offset`              | number  | 0                      | Skip first N results, mutually exclusive with `slice`               |
| `limit`               | number  | -                      | Max results to return, mutually exclusive with `slice`              |
| `slice`               | string  | -                      | Python-style message slice after filtering and sorting              |
| `max_content`         | number  | 4000                   | Max chars per result                                                |
| `max_total`           | number  | 40000                  | Max total chars                                                     |

Default `types` includes `summary`, which means context-compression summaries are searchable. Use `types=assistant,user`
when you only want original conversation turns. `failed_tool_results` keeps the old harness-level meaning and only
checks
`tool_result.is_error`; `tool_payload_errors` is for tools that returned `success=false` or an `error` JSON payload
inside a successful tool result.

Search output uses `redaction=auto` by default for message content, `tool_use` previews, and structured tool fields.
`auto` covers Authorization headers plus common password, token, cookie, API key, secret, private key, and key path
fields. `strict` also redacts private key blocks, private host names, and URLs. `off` returns raw content and records
`enabled=false` in the manifest. Redacted results include `redacted=true` and `raw_available=true`; JSONL manifests
include redaction metadata.

`output` accepts a file path or a directory. Use `tmp:relative/path` for the controlled temp area and
`cwd:relative/path` to persist under the current working directory. Unprefixed relative paths also use the controlled
temp area. Paths ending in a file extension such as `.jsonl`, `.json`, or `.txt` are treated as files, and the manifest
is written next to that file.

`slice` uses Python half-open semantics after all filters and timestamp sorting. `[-10:]` returns the latest 10 matching
messages. `[-10:-1]` excludes the latest message and returns up to 9 messages.

### history_get

| Parameter   | Type   | Description                                                                                                          |
|-------------|--------|----------------------------------------------------------------------------------------------------------------------|
| `ref`       | string | Required. Message ref (session_prefix:line)                                                                          |
| `range`     | string | Character range (e.g., 0-100000)                                                                                     |
| `output`    | string | Output file or directory (auto-extract images, relative paths default to controlled temp dir, use `cwd:` to persist) |
| `project`   | string | Project ID                                                                                                           |
| `redaction` | string | `auto`, `strict`, or `off`; default is `auto`                                                                        |

Large direct responses return `content_too_large` with `content_size`, `valid_range`, `parsed_range`, `head`, `tail`,
`range_suggestion`, and `output_suggestion`.

### history_context

| Parameter        | Type    | Default | Description                                                           |
|------------------|---------|---------|-----------------------------------------------------------------------|
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
`pattern` is set, `before`/`after` counts only messages that match the pattern.

### history_trace

| Parameter        | Type    | Default | Description                                                   |
|------------------|---------|---------|---------------------------------------------------------------|
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

`history_trace` returns the raw nearby messages plus detected tool calls and matching tool results in `tool_calls`.

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
