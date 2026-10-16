# claude-tools

[English](./README.md)

Claude Code 的 MCP Server 和 Skill 工具集

## 工具列表

| 工具                                           | 类型       | 功能                                              |
| ---------------------------------------------- | ---------- | ------------------------------------------------- |
| [mcp-claude-history](./mcp-claude-history)     | MCP Server | 搜索、查看和导出对话历史                          |
| [mcp-chrome](./mcp-chrome)                     | MCP Server | 通过 Extension 或 CDP 操作 Chrome 浏览器          |
| [mcp-ssh](./mcp-ssh)                           | MCP Server | SSH 连接、命令执行和文件传输                      |
| [skill-cc-session-fix](./skill-cc-session-fix) | Skill      | 诊断并修复 session JSONL 的 resume 失败与恢复错位 |
| [skill-elenchus](./skill-elenchus)             | Skill      | 用于代码评审和推理的多视角辩证分析                |

## 安装

TypeScript MCP Server 需要 Node.js 20.19 或更新版本，History server 源码构建需要 Rust
1.88 或更新版本，也可以直接使用 Release 里的预编译二进制

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

Extension 模式需要打开 `chrome://extensions/`，启用开发者模式，点击“加载已解压的扩展程序”，选择
`<npm-root>/@pyrokine/mcp-chrome/extension/dist`

### mcp-claude-history

从 [GitHub Releases](https://github.com/Pyrokine/claude-tools/releases) 下载二进制，将其放入 `PATH`，然后配置 Claude
Code：

```bash
claude mcp add mcp-claude-history -- mcp-claude-history --mcp
```

各子目录 README 提供源码构建说明和不同 MCP 客户端的 JSON 配置

## 主版本迁移

子模块版本独立于仓库的 Release tag

- **mcp-chrome 3.0**：`manage(action="closePage")` 必须指定 `targetId`，操作已有浏览器页面前需 adopt；仅指定 `targetId`
  不授予权限，显式 adopt 后获得完整受控能力，`manage` 和 `browse list`
  支持原生页面、窗口、分组配置与成员状态，相对输出路径使用本会话所有的 `tmp:` 目录，持久输出使用 `cwd:`
- **mcp-ssh 3.0**：`maxOutputSize` 和 PTY `bufferSize`
  按原始 UTF-8 字节计量，消费输出时按字节设置预算并检查截断信息；PTY raw 读取返回清理前的计数
- **mcp-claude-history 2.0**：导出使用独立 bundle 目录和 manifest v2，请使用工具返回的实际路径，不再假定 `output`
  对应单个文件；`max_total` 限制最终紧凑 JSON 响应的 UTF-8 字节数
  全集遍历使用 `history_search(mode="scan")` 及绑定当前进程的 `next_query`，随后读取并释放 `history_scan_metadata`
  normal 保留排序、UUID 去重、regex 和 slice；精确 `source` 与 `history_get` 工具视图用于读取同名来源和超大记录

参数合同和迁移示例见各模块 README
