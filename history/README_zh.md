# claude-history

[English](README.md) | 中文

Claude Code 对话历史搜索工具

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/rust-1.70+-orange.svg)](https://www.rust-lang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io/)

## 功能特性

- **搜索**：全文搜索，支持正则、时间过滤、类型过滤
- **获取**：获取完整消息内容，支持分块获取和图片导出
- **上下文**：获取消息前后的上下文
- **浏览**：列出项目和会话
- **静态二进制**：musl 静态链接，可在大多数 Linux x86_64 发行版上运行

## 安装

```bash
# 编译（静态链接，可在大多数 Linux x86_64 发行版上运行）
cargo build --release --target x86_64-unknown-linux-musl

# 安装
cp target/x86_64-unknown-linux-musl/release/claude-history ~/.local/bin/
```

## 配置

### Claude Code

```bash
claude mcp add claude-history -- claude-history --mcp
```

### Claude Desktop / 其他客户端

```json
{
  "mcpServers": {
    "claude-history": {
      "command": "claude-history",
      "args": ["--mcp"]
    }
  }
}
```

## 可用工具（5 个）

| 工具 | 描述 |
|------|------|
| `history_search` | 搜索对话历史 |
| `history_get` | 获取完整消息内容 |
| `history_context` | 获取消息上下文 |
| `history_projects` | 列出所有项目 |
| `history_sessions` | 列出项目的会话 |

### history_search

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `pattern` | string | "" | 搜索词（空字符串返回所有） |
| `project` | string | 当前项目 | 项目 ID（逗号分隔） |
| `all` | boolean | false | 搜索所有项目 |
| `sessions` | string | - | 会话 ID（逗号分隔） |
| `since` | string | - | 起始时间（ISO 8601 或 today/week/month） |
| `until` | string | - | 结束时间 |
| `types` | string | assistant,user,summary | 消息类型 |
| `lines` | string | - | 行号范围（如 100-200, !300-400） |
| `regex` | boolean | false | 使用正则 |
| `case_sensitive` | boolean | false | 区分大小写 |
| `offset` | number | 0 | 跳过前 N 条 |
| `limit` | number | - | 最多返回 N 条 |
| `max_content` | number | 4000 | 单条最大字符数 |
| `max_total` | number | 40000 | 总最大字符数 |

### history_get

| 参数 | 类型 | 说明 |
|------|------|------|
| `ref` | string | 必填，消息定位（session前8位:行号） |
| `range` | string | 字符范围（如 0-100000） |
| `output` | string | 输出目录（自动提取图片） |
| `project` | string | 项目 ID |

### history_context

| 参数 | 类型 | 说明 |
|------|------|------|
| `ref` | string | 必填，消息定位 |
| `before` | number | 向前取 N 条 |
| `after` | number | 向后取 N 条 |
| `until_type` | string | 持续到指定类型 |
| `direction` | string | forward/backward |
| `project` | string | 项目 ID |

## 使用示例

### 搜索

```bash
# 基础搜索
claude-history search "error"

# 正则搜索
claude-history search "error|warning" --regex

# 最近的消息
claude-history search "" --since today --limit 10

# 搜索指定项目
claude-history search "bug" --project -home-user-myproject
```

### 获取完整内容

```bash
# 通过 ref 获取消息
claude-history get --ref c86bc677:1234

# 导出到目录（包含图片）
claude-history get --ref c86bc677:1234 --output /tmp/export

# 分块获取大内容
claude-history get --ref c86bc677:1234 --range 0-100000
```

### 获取上下文

```bash
# 获取前后各 5 条消息
claude-history context --ref c86bc677:1234 --before 5 --after 5

# 获取直到下一条用户消息
claude-history context --ref c86bc677:1234 --until-type user --direction forward
```

### 浏览

```bash
# 列出所有项目
claude-history projects

# 列出项目的会话
claude-history sessions --project -home-user-myproject
```

## ref 格式

```
ref = session前8位:行号
例如：c86bc677:1234
```

session 前 8 位取自完整的 session ID（如 `c86bc677-9f5f-4e49-8e16-5e175a059610`）。

## 许可证

MIT 许可证 - 详见 [LICENSE](LICENSE)。
