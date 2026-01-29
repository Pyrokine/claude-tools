# claude-history

Claude Code 对话历史搜索工具

## 功能

- 搜索对话历史（支持正则）
- 获取完整消息内容
- 获取消息上下文
- 列出项目和会话
- 自动提取图片

## 安装

```bash
cargo build --release
cp target/release/claude-history ~/.local/bin/
```

## MCP 配置

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

## 命令

```bash
# 搜索
claude-history search "error"
claude-history search "error|warning" --regex
claude-history search "" --since "2026-01-28" --limit 10

# 获取完整内容
claude-history get --ref c86bc677:1234
claude-history get --ref c86bc677:1234 --output /tmp

# 获取上下文
claude-history context --ref c86bc677:1234 --before 5 --after 5

# 列出项目和会话
claude-history projects
claude-history sessions --project -home-user-xxx
```

## 设计文档

详见 [设计方案](/tmp/claude-history-rs-设计方案.md)
