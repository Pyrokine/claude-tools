# claude-tools

MCP tools for Claude Code / Claude Code MCP 工具集

## Tools / 工具列表

| Tool                                       | Type       | Description                                                                 |
|--------------------------------------------|------------|-----------------------------------------------------------------------------|
| [mcp-ssh](./mcp-ssh)                       | MCP Server | SSH connection, command execution, file operations                          |
| [mcp-chrome](./mcp-chrome)                 | MCP Server | Chrome browser automation (Extension + CDP)                                 |
| [mcp-claude-history](./mcp-claude-history) | MCP Server | Conversation history search                                                 |
| [skill-elenchus](./skill-elenchus)         | Skill      | Multi-perspective dialectical analysis (code review + deep thinking)        |
| [skill-cc-session-fix](./skill-cc-session-fix) | Skill  | Diagnose & repair Claude Code session jsonl (resume failures, wrong anchor) |

| 工具                                         | 类型         | 功能                                              |
|--------------------------------------------|------------|-------------------------------------------------|
| [mcp-ssh](./mcp-ssh)                       | MCP Server | SSH 远程连接、命令执行、文件操作                              |
| [mcp-chrome](./mcp-chrome)                 | MCP Server | Chrome 浏览器自动化（Extension + CDP）                  |
| [mcp-claude-history](./mcp-claude-history) | MCP Server | 对话历史搜索                                          |
| [skill-elenchus](./skill-elenchus)         | Skill      | 辩证分析方法论（评审 + 深度思辨）                              |
| [skill-cc-session-fix](./skill-cc-session-fix) | Skill  | Claude Code session jsonl 诊断与修复（resume 失败、恢复错位） |

## Installation / 安装

TypeScript MCP servers require Node.js 20.19 or newer. Rust history server requires Rust 1.88 or the prebuilt release binary.

TypeScript MCP Server 需要 Node.js 20.19 或更新版本。Rust history server 需要 Rust 1.88，或直接使用 Release 里的预编译二进制。

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

For Extension mode, open `chrome://extensions/`, enable Developer mode, click "Load unpacked", and select `<npm-root>/@pyrokine/mcp-chrome/extension/dist`.

Extension 模式需要打开 `chrome://extensions/`，启用开发者模式，点击“加载已解压的扩展程序”，选择 `<npm-root>/@pyrokine/mcp-chrome/extension/dist`。

### mcp-claude-history

Download the latest binary from [GitHub Releases](https://github.com/Pyrokine/claude-tools/releases), then configure Claude Code:

```bash
claude mcp add mcp-claude-history -- mcp-claude-history --mcp
```

下载 [GitHub Releases](https://github.com/Pyrokine/claude-tools/releases) 里的最新二进制后，按上面的命令配置 Claude Code。

See each subdirectory README for source builds and client-specific JSON configuration.

源码构建和其他 MCP 客户端 JSON 配置见各子目录 README。
