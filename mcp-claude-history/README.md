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

Download the latest release from [GitHub Releases](https://github.com/Pyrokine/claude-mcp-tools/releases):

```bash
# Download and install
curl -L https://github.com/Pyrokine/claude-mcp-tools/releases/latest/download/mcp-claude-history-linux-x86_64.tar.gz | tar xz
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

## Available Tools (5 tools)

| Tool | Description |
|------|-------------|
| `history_search` | Search conversation history |
| `history_get` | Get full message content |
| `history_context` | Get surrounding messages |
| `history_projects` | List all projects |
| `history_sessions` | List sessions in a project |

### history_search

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `pattern` | string | "" | Search pattern (empty returns all) |
| `project` | string | current | Project ID (comma-separated) |
| `all` | boolean | false | Search all projects |
| `sessions` | string | - | Session IDs (comma-separated) |
| `since` | string | - | Start time (ISO 8601 or today/week/month). Without timezone, treated as local time |
| `until` | string | - | End time. Without timezone, treated as local time |
| `types` | string | assistant,user,summary | Message types |
| `lines` | string | - | Line ranges (e.g., 100-200, !300-400) |
| `regex` | boolean | false | Use regex |
| `case_sensitive` | boolean | false | Case sensitive |
| `offset` | number | 0 | Skip first N results |
| `limit` | number | - | Max results to return |
| `max_content` | number | 4000 | Max chars per result |
| `max_total` | number | 40000 | Max total chars |

### history_get

| Parameter | Type | Description |
|-----------|------|-------------|
| `ref` | string | Required. Message ref (session_prefix:line) |
| `range` | string | Character range (e.g., 0-100000) |
| `output` | string | Output directory (auto-extract images) |
| `project` | string | Project ID |

### history_context

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `ref` | string | - | Required. Message ref |
| `before` | number | - | Messages before (counts only matching types if `types` specified) |
| `after` | number | - | Messages after (counts only matching types if `types` specified) |
| `until_type` | string | - | Continue until this type |
| `direction` | string | forward | forward/backward |
| `types` | string | - | Message types to include (comma-separated) |
| `project` | string | - | Project ID |
| `max_content` | number | 4000 | Max chars per message |
| `max_total` | number | 40000 | Max total chars |

**Note**: The anchor message (specified by `ref`) is always included in results, even if its type is not in the `types` filter.

## Usage Examples

### Search

```bash
# Basic search
mcp-claude-history search "error"

# Regex search
mcp-claude-history search "error|warning" --regex

# Recent messages
mcp-claude-history search "" --since today --limit 10

# Search specific project
mcp-claude-history search "bug" --project -home-user-myproject
```

### Get Full Content

```bash
# Get message by ref
mcp-claude-history get --ref c86bc677:1234

# Export to directory (with images)
mcp-claude-history get --ref c86bc677:1234 --output /tmp/export

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
