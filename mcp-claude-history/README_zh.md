# mcp-claude-history

[English](README.md) | 中文

Claude Code 对话历史搜索工具

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/rust-1.88+-orange.svg)](https://www.rust-lang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io/)

![Linux](https://img.shields.io/badge/Linux_x86__64-tested-success)
![macOS](https://img.shields.io/badge/macOS-build_available-blue)
![Windows](https://img.shields.io/badge/Windows-build_available-blue)

## 功能特性

- **搜索**：全文搜索，支持正则、时间过滤、类型过滤
- **获取**：获取完整消息内容，支持分块获取和图片导出
- **上下文**：获取消息前后的上下文
- **浏览**：列出项目和会话
- **静态二进制**：musl 静态链接，可在大多数 Linux x86_64 发行版上运行

## 安装

### 下载二进制（推荐）

从 [GitHub Releases](https://github.com/Pyrokine/claude-tools/releases) 下载最新版本，原有 target triple 资产名继续保留，已有自动化无需修改

| 平台 | 稳定资产名 |
|---|---|
| Linux x86_64 | `mcp-claude-history-linux-x86_64.tar.gz` |
| macOS Intel | `mcp-claude-history-macos-x86_64.tar.gz` |
| macOS Apple Silicon | `mcp-claude-history-macos-aarch64.tar.gz` |
| Windows x86_64 | `mcp-claude-history-windows-x86_64.zip` |

```bash
# 下载并安装
curl -L \
  https://github.com/Pyrokine/claude-tools/releases/latest/download/mcp-claude-history-linux-x86_64.tar.gz \
  | tar xz
chmod +x mcp-claude-history
mv mcp-claude-history ~/.local/bin/
```

### 从源码编译

```bash
# 编译（静态链接，可在大多数 Linux x86_64 发行版上运行）
cargo build --release --target x86_64-unknown-linux-musl

# 安装
cp target/x86_64-unknown-linux-musl/release/mcp-claude-history ~/.local/bin/
```

## 配置

### Claude Code

```bash
claude mcp add mcp-claude-history -- mcp-claude-history --mcp
```

### Claude Desktop / 其他客户端

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

## 可用工具（7 个）

| 工具                 | 描述                 |
|--------------------|--------------------|
| `history_search`   | 搜索对话历史             |
| `history_get`      | 获取完整消息内容           |
| `history_context`  | 获取消息上下文            |
| `history_trace`    | 追踪附近消息和 tool 调用结果对 |
| `history_build_info` | 查看当前运行二进制的构建身份  |
| `history_projects` | 列出所有项目             |
| `history_sessions` | 列出项目的会话            |

### history_search

| 参数                    | 类型      | 默认值                    | 说明                                                       |
|-----------------------|---------|------------------------|----------------------------------------------------------|
| `pattern`             | string  | ""                     | 搜索词（空字符串返回所有）                                            |
| `project`             | string  | 当前项目                   | 项目 ID（逗号分隔）                                              |
| `all`                 | boolean | false                  | 搜索所有项目                                                   |
| `sessions`            | string  | -                      | 会话 ID（逗号分隔）                                              |
| `since`               | string  | -                      | 起始时间，支持 RFC3339 或 YYYY-MM-DD                             |
| `until`               | string  | -                      | 结束时间，支持 RFC3339 或 YYYY-MM-DD                             |
| `types`               | string  | assistant,user,summary | 消息类型                                                     |
| `servers`             | string  | -                      | MCP server 过滤，逗号分隔                                       |
| `tools`               | string  | -                      | MCP tool 过滤，逗号分隔                                         |
| `lines`               | string  | -                      | 行号范围（如 100-200, !300-400）                                |
| `regex`               | boolean | false                  | 使用正则                                                     |
| `case_sensitive`      | boolean | false                  | 区分大小写                                                    |
| `subagents`           | boolean | false                  | 包含 `subagents` 和 `remote-agents` 下的 sidechain transcript |
| `summary`             | boolean | false                  | 返回聚合摘要，不返回完整结果正文                                         |
| `failed_tool_results` | boolean | false                  | 只返回 harness 标记 `is_error=true` 的 tool_result             |
| `tool_payload_errors` | boolean | false                  | 只返回 JSON payload 自身报告错误的 tool_result                     |
| `output`              | string  | -                      | 写结果文件，相对路径默认走受控临时目录                                      |
| `output_format`       | string  | jsonl                  | `jsonl`                                                  |
| `redaction`           | string  | auto                   | `auto`、`strict` 或 `off`                                  |
| `offset`              | number  | 0                      | 跳过前 N 条，不能和 `slice` 同用                                   |
| `limit`               | number  | -                      | 最多返回 N 条，不能和 `slice` 同用                                  |
| `slice`               | string  | -                      | 过滤和排序后的 Python 风格消息切片                                    |
| `max_content`         | number  | 4000                   | 普通结果预览的最大字符数（1 至 1,000,000）                              |
| `max_content_tool_result` | number | 500                  | tool result 独立预览上限（1 至 1,000,000）                          |
| `max_total`           | number  | 40000                  | 紧凑 `SearchResponse` JSON 最大字节数（512 至 10,000,000）             |

默认 `types` 包含 `summary`，会检索上下文压缩摘要，只看原始对话时使用 `types=assistant,user`，`failed_tool_results`
保持旧语义，只检查
`tool_result.is_error`；`tool_payload_errors` 用于查找工具结果成功返回但正文 JSON 中包含 `success=false` 或 `error` 的记录

搜索输出默认使用 `redaction=auto` 处理消息正文、`tool_use` 预览和结构化 tool 字段，`auto` 覆盖 Authorization header，以及常见
password、token、cookie、API key、secret、private key、key path 字段，`strict` 还会处理 private key block、private host name 和
URL，`off` 返回原始内容并在 manifest 中记录 `enabled=false`，被处理的结果会返回 `redacted=true` 和 `raw_available=true`
，JSONL manifest 会记录 redaction 元数据

`output` 支持文件路径或目录，`tmp:relative/path` 写入受控临时目录，`cwd:relative/path` 持久化到当前工作目录，未加前缀的相对路径也写入受控临时目录，以
`.jsonl`、`.json` 或 `.txt` 等扩展名结尾时按文件处理，manifest 写在该文件旁边

`slice` 使用 Python 半开区间语义，在全部过滤和按时间排序后执行，`[-10:]` 返回最近 10 条匹配消息，`[-10:-1]` 排除最新消息，最多返回
9 条，`max_total` 删除部分切片结果时，`next_query` 会携带剩余半开区间对应的归一化正数 slice，连续续查不会离开原切片；预算无法容纳任何结果且 continuation 无法前进时返回 `response_too_large`，不会重复返回同一个 slice

`max_total` 统计 `history_search` 返回的紧凑 UTF-8 JSON 文本，不包含 JSON-RPC 和 MCP transport framing，响应会返回
`serialized_bytes`、`max_total_bytes`、`limits_applied` 和 `complete`，导出的 JSONL 内容不受对话响应预算缩减，
`next_query` 和导出 manifest 会保留 `max_content_tool_result`

### history_get

| 参数          | 类型     | 说明                                           |
|-------------|--------|----------------------------------------------|
| `ref`       | string | 必填，消息定位（session前8位:行号）                       |
| `range`     | string | 字符范围（如 0-100000）                             |
| `output`    | string | 输出文件或目录（自动提取图片，相对路径默认走受控临时目录，持久化请显式写 `cwd:`） |
| `project`   | string | 项目 ID                                        |
| `redaction` | string | `auto`、`strict` 或 `off`，默认 `auto`            |

直接返回过大时会返回 `content_too_large`，包含 `content_size`、`valid_range`、`parsed_range`、`head`、`tail`、
`range_suggestion` 和 `output_suggestion`

### history_context

| 参数               | 类型      | 默认值     | 说明                                       |
|------------------|---------|---------|------------------------------------------|
| `ref`            | string  | -       | 必填，消息定位                                  |
| `before`         | number  | -       | 向前取 N 条（仅计数同时匹配 `types` 和 `pattern` 的消息） |
| `after`          | number  | -       | 向后取 N 条（仅计数同时匹配 `types` 和 `pattern` 的消息） |
| `until_type`     | string  | -       | 持续到指定类型                                  |
| `until_ref`      | string  | -       | 持续到同一 session 内的另一个 ref                  |
| `direction`      | string  | forward | forward/backward                         |
| `types`          | string  | -       | 要包含的消息类型（逗号分隔）                           |
| `subtypes`       | string  | -       | 要包含的消息子类型（逗号分隔）                          |
| `project`        | string  | -       | 项目 ID                                    |
| `output`         | string  | -       | 导出选中上下文到文本文件，并返回 `output_path`           |
| `redaction`      | string  | auto    | `auto`、`strict` 或 `off`                  |
| `max_content`    | number  | 4000    | 单条最大字符数                                  |
| `max_total`      | number  | 40000   | 总最大字符数                                   |
| `pattern`        | string  | -       | 内容过滤 pattern，仅计数/返回匹配该 pattern 的消息       |
| `regex`          | boolean | false   | 是否使用正则匹配                                 |
| `case_sensitive` | boolean | false   | 是否区分大小写                                  |

**说明**：锚点消息（由 `ref` 指定）始终包含在结果中，不受 `types` 和 `pattern` 过滤影响；设置 `pattern` 后，`before`/`after`
的计数仅统计匹配该 pattern 的消息，合法 JSONL session metadata record 会被忽略且不产生解析警告，损坏 JSON 和不完整消息 record
仍会产生警告，`history_trace` 使用相同的 record 处理规则

### history_trace

| 参数               | 类型      | 默认值     | 说明                                 |
|------------------|---------|---------|------------------------------------|
| `ref`            | string  | -       | 必填，消息定位                            |
| `before`         | number  | 20      | 锚点前消息数，按 type/pattern 过滤后计数        |
| `after`          | number  | 20      | 锚点后消息数，按 type/pattern 过滤后计数        |
| `project`        | string  | -       | 项目 ID                              |
| `types`          | string  | -       | 要包含的消息类型                           |
| `subtypes`       | string  | -       | 要包含的消息子类型                          |
| `pattern`        | string  | -       | 内容过滤 pattern                       |
| `regex`          | boolean | false   | 是否使用正则                             |
| `case_sensitive` | boolean | false   | 是否区分大小写                            |
| `servers`        | string  | -       | 按 MCP server 过滤 `tool_calls`       |
| `tools`          | string  | -       | 按 tool 名过滤 `tool_calls`            |
| `until_type`     | string  | -       | 持续到指定消息类型                          |
| `until_ref`      | string  | -       | 持续到同一 session 内的另一个 ref            |
| `direction`      | string  | forward | `until_type` 的 forward/backward    |
| `output`         | string  | -       | 导出选中 trace 到文本文件，并返回 `output_path` |
| `redaction`      | string  | auto    | `auto`、`strict` 或 `off`            |
| `max_content`    | number  | 4000    | 单条最大字符数                            |
| `max_total`      | number  | 40000   | messages 总最大字符数                    |

`history_trace` 返回附近消息，并在 `tool_calls` 中列出识别到的 tool 调用和对应 tool_result，有
`tool_use_id` 的 result 只匹配相同 ID；没有 ID 时先匹配 assistant parent UUID，再在仅有一个 pending call 时使用旧版顺序兼容，
每个 call 返回 `match_method`，未匹配和歧义 result 进入有数量上限的 `association_issues`，结构化 tool-result preview 在 JSON
序列化前按 key 递归脱敏，也会处理 text 中嵌入的 JSON object，trace 导出使用同一份脱敏 preview

### history_build_info

返回当前运行二进制的 package version、commit、target、profile、UTC 构建时间、dirty 状态和构建身份是否可复现，本地 dirty
构建不会标记为可复现，CLI 对应命令为 `mcp-claude-history build-info`

## 使用示例

### 搜索

```bash
# 基础搜索
mcp-claude-history search "error"

# 正则搜索
mcp-claude-history search "error|warning" --regex

# 按时间过滤最近的消息
mcp-claude-history search "" --since 2026-04-29 --limit 10

# 最近 10 条匹配消息
mcp-claude-history search "" --slice '[-10:]'

# Python 半开区间，排除最新一条匹配消息
mcp-claude-history search "" --slice '[-10:-1]'

# 搜索指定项目
mcp-claude-history search "bug" --project -home-user-myproject

# 过滤 MCP tool call 并返回摘要
mcp-claude-history search "" --servers mcp-chrome --tools browse,evaluate --summary

# 查找工具结果成功返回但正文 JSON 仍报告错误的记录
mcp-claude-history search "" --tool-payload-errors --servers mcp-chrome

# 写 JSONL 便于分块处理
mcp-claude-history search "error" --output tmp:history/error.jsonl --output-format jsonl

# 用 strict redaction 导出搜索结果
mcp-claude-history search "error" --redaction strict --output tmp:history/error.jsonl --output-format jsonl
```

### 获取完整内容

```bash
# 通过 ref 获取消息
mcp-claude-history get --ref c86bc677:1234

# 导出到受控临时目录（包含图片）
mcp-claude-history get --ref c86bc677:1234 --output tmp:export

# 明确持久化到当前工作目录
mcp-claude-history get --ref c86bc677:1234 --output cwd:export

# 导出到明确的文本文件并保留原始内容
mcp-claude-history get --ref c86bc677:1234 --output tmp:history/message.txt --redaction off

# 分块获取大内容
mcp-claude-history get --ref c86bc677:1234 --range 0-100000
```

### 获取上下文

```bash
# 获取前后各 5 条消息
mcp-claude-history context --ref c86bc677:1234 --before 5 --after 5

# 获取前 10 条 user 消息（按类型过滤）
mcp-claude-history context --ref c86bc677:1234 --before 10 --types user

# 获取直到下一条用户消息
mcp-claude-history context --ref c86bc677:1234 --until-type user --direction forward

# 只返回锚点周围匹配 pattern 的消息
mcp-claude-history context --ref c86bc677:1234 --before 5 --after 5 --pattern error --case-sensitive

# 导出同一 session 内两个 ref 之间的上下文
mcp-claude-history context --ref c86bc677:1234 --until-ref c86bc677:1300 --output tmp:history-context

# 用 strict redaction 导出上下文到明确的文本文件
mcp-claude-history context --ref c86bc677:1234 --before 5 --after 5 --output tmp:history/context.txt --redaction strict
```

### 追踪 tool 调用

```bash
# 追踪附近消息和 tool 调用结果对
mcp-claude-history trace --ref c86bc677:1234 --before 20 --after 20

# 追踪并导出 ref 附近的 chrome browse/evaluate 调用
mcp-claude-history trace --ref c86bc677:1234 --servers mcp-chrome --tools browse,evaluate --output tmp:history-trace

# 用 strict redaction 导出 trace 到明确的文本文件
mcp-claude-history trace --ref c86bc677:1234 --before 5 --after 5 --output tmp:history/trace.txt --redaction strict
```

### 浏览

```bash
# 列出所有项目
mcp-claude-history projects

# 列出项目的会话
mcp-claude-history sessions --project -home-user-myproject
```

## ref 格式

```
ref = session前8位:行号
例如：c86bc677:1234
```

session 前 8 位取自完整的 session ID（如 `c86bc677-9f5f-4e49-8e16-5e175a059610`）

## 许可证

MIT 许可证 - 详见 [LICENSE](LICENSE)
