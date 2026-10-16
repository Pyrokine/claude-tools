# claude-tools

[中文](./README_zh.md)

MCP servers and skills for Claude Code.

## Tools

| Tool                                           | Type       | Description                                                                   |
| ---------------------------------------------- | ---------- | ----------------------------------------------------------------------------- |
| [mcp-claude-history](./mcp-claude-history)     | MCP Server | Search, inspect, and export conversation history                              |
| [mcp-chrome](./mcp-chrome)                     | MCP Server | Chrome browser automation through Extension or CDP                            |
| [mcp-ssh](./mcp-ssh)                           | MCP Server | SSH connections, command execution, and file transfers                        |
| [skill-cc-session-fix](./skill-cc-session-fix) | Skill      | Diagnose and repair session JSONL files for resume failures and wrong anchors |
| [skill-elenchus](./skill-elenchus)             | Skill      | Multi-perspective dialectical analysis for code review and reasoning          |

## Installation

The TypeScript MCP servers require Node.js 20.19 or newer. Build the history server with Rust 1.88 or newer, or use a
prebuilt release binary.

### mcp-ssh

```bash
npm install -g @pyrokine/mcp-ssh
claude mcp add ssh -- mcp-ssh
```

### mcp-chrome

```bash
npm install -g @pyrokine/mcp-chrome
claude mcp add chrome -- mcp-chrome
npm root -g
```

For Extension mode, open `chrome://extensions/`, enable Developer mode, click "Load unpacked", and select
`<npm-root>/@pyrokine/mcp-chrome/extension/dist`.

### mcp-claude-history

Download a binary from [GitHub Releases](https://github.com/Pyrokine/claude-tools/releases), place it on `PATH`, and
configure Claude Code:

```bash
claude mcp add mcp-claude-history -- mcp-claude-history --mcp
```

Each subdirectory README includes source build instructions and client-specific JSON configuration.

## Major-version migration

Module versions are independent of the repository release tag.

- **mcp-chrome 3.0**: `manage(action="closePage")` requires `targetId`. Adopt existing browser tabs before operating on
  them; explicit adopt grants full managed access, while `targetId` alone does not. Native page/window/group
  configuration and group membership/state are available through `manage` and `browse list`. Relative output paths use
  session-owned `tmp:` storage; use `cwd:` for persistent output.
- **mcp-ssh 3.0**: `maxOutputSize` and PTY `bufferSize` measure raw UTF-8 bytes. Apply byte budgets when consuming
  output and inspect truncation metadata. PTY raw reads report counters before clearing the buffer.
- **mcp-claude-history 2.0**: Exports use unique bundle directories and manifest v2. Read the actual paths returned by
  the tool instead of assuming that `output` is a single file. `max_total` limits the UTF-8 bytes of the final compact
  JSON response. Use `history_search(mode="scan")` and its process-bound `next_query` to traverse full source sets,
  then read and release `history_scan_metadata`. Normal search retains sorting, UUID de-duplication, regex, and slice;
  exact `source` and `history_get` tool views recover duplicate-source or oversized records.

See the module READMEs for parameter contracts and migration examples.
