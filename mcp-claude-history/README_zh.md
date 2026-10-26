# mcp-claude-history

[English](README.md) | 中文

Claude Code 对话历史搜索工具

模块版本：2.1.1

本版本修复 Windows 历史路径规范化后的文件读取、从 PowerShell 7 启动时的私有导出创建，以及导出目录的原子发布

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

## 迁移到 2.0

`history_get`、`history_search`、`history_context` 和 `history_trace`
导出时发布 bundle 目录，请求的文件名不再是最终文件路径默认创建唯一目录，例如
`results.export-<唯一后缀>/results.jsonl`；`overwrite=true` 使用带归属标记的固定目标读取返回的
`output.content`（search 为 `output.results`）、`output.manifest` 或提供的
`output_path`，不要按请求拼接路径，也不要假定 manifest 位于请求文件旁

导出 manifest 使用 schema v2：`mcp-claude-history.get-output.v2`、`mcp-claude-history.search-results.v2`、
`mcp-claude-history.context-output.v2` 和 `mcp-claude-history.trace-output.v2` 消费方应检查
`schema`，使用返回路径、完整性、字节数和脱敏元数据

context 和 trace 的 `max_total` 限制最终紧凑 JSON 响应的 UTF-8 字节数，包含元数据和 trace 的
`tool_calls`，不含 JSON-RPC 与 MCP framing 不能用字符数或消息文本长度代替这个预算，无法保留锚点和必要元数据时返回
`response_too_large`

仅传日期的 `until=YYYY-MM-DD` 使用次日 UTC 00:00 的排他边界，因此包含指定 UTC 日期全天；`today` 按 UTC 日历解释 RFC3339
`until` 仍包含指定瞬间

`history_get.range`
使用原始提取消息的 Unicode 字符半开坐标，脱敏会先检查完整消息，再选择 range，与敏感值任何部分相交就返回标记不要按脱敏预览计算 range 坐标，`redaction=off`
返回对应的完整原文范围

## 安装

### 下载二进制（推荐）

从 [GitHub Releases](https://github.com/Pyrokine/claude-tools/releases) 下载最新版本，原有 target
triple 资产名继续保留，已有自动化无需修改

| 平台                | 稳定资产名                                |
| ------------------- | ----------------------------------------- |
| Linux x86_64        | `mcp-claude-history-linux-x86_64.tar.gz`  |
| macOS Intel         | `mcp-claude-history-macos-x86_64.tar.gz`  |
| macOS Apple Silicon | `mcp-claude-history-macos-aarch64.tar.gz` |
| Windows x86_64      | `mcp-claude-history-windows-x86_64.zip`   |

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
            "args": ["--mcp"]
        }
    }
}
```

## 可用工具（8 个）

| 工具                    | 描述                                       |
| ----------------------- | ------------------------------------------ |
| `history_search`        | 搜索或逐批扫描对话历史                     |
| `history_scan_metadata` | 分页读取扫描范围、计数与诊断，释放扫描状态 |
| `history_get`           | 获取完整消息内容                           |
| `history_context`       | 获取消息上下文                             |
| `history_trace`         | 追踪附近消息和 tool 调用结果对             |
| `history_build_info`    | 查看当前运行二进制的构建身份               |
| `history_projects`      | 列出所有项目                               |
| `history_sessions`      | 列出项目的会话                             |

### history_projects

每个项目返回权威 `id`、展示用
`path`、`path_approximate`、会话数和最后活动时间现存本地路径会根据文件系统还原，保留连字符、下划线、点号和空格无法唯一解析到现存路径时，`path`
使用可读的近似值并返回 `path_approximate=true`；调用其他工具时应使用
`id`Windows 下现存的盘符路径和 UNC 路径也可作为项目参数，先 canonicalize，再按大小写不敏感规则匹配；多个项目对应同一路径时返回
`project_ambiguous`

### history_sessions

| 参数        | 类型   | 默认值   | 说明                                   |
| ----------- | ------ | -------- | -------------------------------------- |
| `project`   | string | 当前项目 | 项目 ID                                |
| `redaction` | string | auto     | 会话主题使用 `auto`、`strict` 或 `off` |

会话主题会先脱敏，再截取前 100 个字符响应包含汇总 `redaction` 元数据，主题发生替换的会话会返回 `topic_redacted_count`

### history_search

| 参数                      | 类型     | 默认值                 | 说明                                                  |
| ------------------------- | -------- | ---------------------- | ----------------------------------------------------- |
| `mode`                    | string   | normal                 | `normal`、逐批 `scan` 或来源分页 `sources`            |
| `cursor`                  | string   | -                      | 使用扫描返回的 `next_query`                           |
| `scan_bytes`              | number   | 16777216               | 单批处理预算，16384 至 268435456 字节                 |
| `scan_ms`                 | number   | 1000                   | 单批主动处理时间预算，10 至 10000 ms                  |
| `structured`              | string   | 随模式选择             | normal 默认 `full`，scan 默认 `preview`，保留显式选择 |
| `pattern`                 | string   | ""                     | 搜索词（空字符串返回所有）                            |
| `project`                 | string   | 当前项目               | 项目 ID（逗号分隔）                                   |
| `all`                     | boolean  | false                  | 搜索所有项目                                          |
| `sessions`                | string   | -                      | 会话 ID（逗号分隔）                                   |
| `sources`                 | string[] | -                      | 最多 128 个精确来源，与 source 互斥                   |
| `output_content`          | string   | preview                | 文件正文 preview 或 full，与 structured 独立          |
| `release`                 | boolean  | false                  | 使用 cursor 释放 sources 目录                         |
| `source`                  | string   | -                      | search 或 scan metadata 返回的精确物理来源            |
| `since`                   | string   | -                      | 起始时间：RFC3339、UTC 日期或 `today`（含边界）       |
| `until`                   | string   | -                      | 结束时间：RFC3339、UTC 日期或 `today`（含边界）       |
| `types`                   | string   | assistant,user,summary | 消息类型，逗号分隔                                    |
| `subtypes`                | string   | -                      | 消息子类型，逗号分隔                                  |
| `servers`                 | string   | -                      | MCP server 过滤，逗号分隔                             |
| `tools`                   | string   | -                      | MCP tool 过滤，逗号分隔                               |
| `lines`                   | string   | -                      | 行号范围（如 100-200, !300-400）                      |
| `regex`                   | boolean  | false                  | 使用正则                                              |
| `case_sensitive`          | boolean  | false                  | 区分大小写                                            |
| `subagents`               | boolean  | false                  | 包含 sidechain 和 remote-agent transcript             |
| `summary`                 | boolean  | false                  | 在 `stats.summary` 中包含聚合计数                     |
| `aggregate`               | boolean  | false                  | 仅返回聚合计数，不返回结果行                          |
| `dry_run`                 | boolean  | false                  | 只预览项目、会话和文件，不读取消息正文                |
| `failed_tool_results`     | boolean  | false                  | 只返回 harness 标记 `is_error=true` 的 tool_result    |
| `tool_payload_errors`     | boolean  | false                  | 只返回 JSON payload 自身报告错误的 tool_result        |
| `output`                  | string   | -                      | 导出结果目录，相对路径默认走受控临时目录              |
| `overwrite`               | boolean  | false                  | 覆盖已存在且带归属标记的导出目录                      |
| `output_format`           | string   | jsonl                  | `jsonl`                                               |
| `redaction`               | string   | auto                   | `auto`、`strict` 或 `off`                             |
| `offset`                  | number   | 0                      | 跳过前 N 条，不能和 `slice` 同用                      |
| `limit`                   | number   | -                      | 最多返回 N 条，不能和 `slice` 同用                    |
| `slice`                   | string   | -                      | 过滤和排序后的 Python 风格消息切片                    |
| `max_content`             | number   | 4000                   | 普通结果预览的最大字符数（1 至 1,000,000）            |
| `max_content_tool_result` | number   | 500                    | tool result 独立预览上限（1 至 1,000,000）            |
| `max_total`               | number   | 40000                  | 紧凑响应上限（512 至 10,000,000 字节）                |

`subagents=false`（默认值）只搜索主 JSONL 文件，`true` 包括 `<session>/subagents/`、`<session>/remote-agents/`
下的直接 agent 文件，以及已识别的嵌套布局 `<session>/subagents/workflows/<run>/agent-<id>.jsonl` Workflow
journal 不属于对话来源，`sessions`
匹配各文件自身 ID，选择父会话 ID 不会自动包含子会话普通、summary、aggregate、dry_run 和导出响应始终返回
`stats.effective_filters.subagents`，包括 false 该字段表示有效配置，实际文件范围查看 coverage 或
`dry_run`，续查保持相同范围

normal 和 scan 都支持 `source`，CLI 使用 `--source`，原样使用 search 或 scan metadata 返回的绝对物理来源省略 `project`
时采用来源所在项目，显式 `project`、`sessions` 必须与该文件匹配，子会话仍需 `subagents=true` 未指定 `source`
的同名会话仍返回歧义错误，续查保留来源，scan 拒绝更改冻结来源只接受当前历史根内已识别布局的文件，拒绝相对路径、越界路径、未知布局和链接

默认 `types` 包含 `summary`，会检索上下文压缩摘要，只看原始对话时使用 `types=assistant,user`合法 type 为
`assistant`、`user`、`summary`、`system`、`other`合法 subtype 为 `human`、`tool_result`、`meta`、`text`、
`tool_use`、`thinking`、`empty`、`summary`、`system`、`other``types=user,subtypes=human` 用于筛选普通user-shaped
record这是分类启发式，不能证明消息由真人输入为兼容旧调用，传入 `types` 的已知 subtype 会自动移入
`subtypes`，未知 type 或 subtype 返回 `invalid_arguments`

`failed_tool_results` 保持旧语义，只检查 `tool_result.is_error``tool_payload_errors`
用于查找工具结果成功返回但正文 JSON 中包含 `success=false` 或 `error` 的记录非 regex 的 `pattern` 以空格表示 AND，`a|b`
表示一组 OR，`!term` 排除命中； `regex=true` 时 `pattern` 作为一个正则表达式设置 `since` 或 `until`
后，时间戳无法解析的 record 不匹配，并通过 `stats.skipped_invalid_timestamps` 和 `incomplete_reasons`
说明日期按 UTC 解释：`since=YYYY-MM-DD` 从当日 UTC 00:00 开始，`until=YYYY-MM-DD` 包含该 UTC 日期全天；`today`
为当前 UTC 日期RFC3339 显式时区偏移按 UTC 瞬间比较；`since` 不能晚于 `until`

搜索会在完整提取的消息上匹配 `pattern`，包括超出响应预览上限的 tool input

每项结果在 `content` 中返回有界正文预览，使用其 `ref` 调用 `history_get` 读取范围或导出

单条 record 含多个 tool block 时，server、tool、harness error 和 payload
error 条件必须由同一个 block 同时满足，返回的 tool name、input、result 和 error 字段也来自该 block 及其关联的
`tool_use_id`

`tools` 中的名称按 OR 匹配，完整名称 `mcp__server__tool`
绑定同一个工具块的 server 和 tool，短名跨 server 匹配 tool 可以混合本地工具名（如 `Bash`）和完整 MCP 工具名显式
`servers` 与 `tools` 按 AND 组合，完整工具名不会增加全局 server 过滤条件 `stats.effective_filters` 和 `next_query`
保留完整工具名，不再返回原有的自动拆分 warning

搜索完整性与工具归因分别报告，只有匹配内容、类型、时间和行范围的记录才会计入
`stats.attribution_incomplete_reasons`，命中记录继续保留 `metadata_incomplete_reason`
缺少工具关联不会把普通正文搜索标为不完整；按 `servers` 或 `tools` 筛选时，无法确认归属的记录会使 `incomplete_reasons`
包含
`tool_filter_unverifiable`，导出 manifest 包含相同的归因原因普通、summary、aggregate 和 output 搜索存在扫描缺口时返回
`total_matches_exact=false`，包括 normal 的超大 JSONL 行、读取或解析缺口及容量停止分页和响应预算删减不会改变原本精确的计数，因此
`complete=false` 可以与 `total_matches_exact=true`
同时出现纯归因缺口继续独立，工具名称筛选无法验证时才影响正文计数精确性

`coverage.searched_files` 是尝试扫描的会话文件的稳定前缀，包含打开失败或扫描中途停止的当前文件，缺口由
`incomplete_reasons` 说明 `skipped_files` 是尚未尝试的后缀，两者不重叠；关键词命中在 `results` 中响应超出 `max_total`
时，优先缩减扫描路径等附属信息，再缩减命中消息；`dry_run` 不读取正文，只列计划文件范围

搜索输出默认使用 `redaction=auto` 处理消息正文、`tool_use` 预览和结构化 tool 字段，`auto` 覆盖 Authorization
header，以及常见 password、token、cookie、API key、secret、private key、key path 字段和 `SSHPASS` 密码环境变量，`strict`
还会处理 private key block、private host name 和 URL，`off` 返回原始内容并在 manifest 中记录
`enabled=false`，被处理的结果会返回 `redacted=true` 和 `raw_available=true` ，JSONL
manifest 会记录 redaction 元数据 JSON 字段名按解码后的字符串语义识别，覆盖 Unicode 转义和内嵌转义 JSON；字段名中的字面反斜杠不会被反复解码替换沿用原文值的位置，非敏感文本和格式保持原样

auto 和 strict 也会遮蔽完整的 npm access token：小写 `npm_`
后接恰好 36 个 ASCII 字母或数字，前后使用完整 Unicode 单词边界正文、结构化 tool 字段、record 视图及导出中的独立值和独立引号参数使用同一规则，短值、长值及相连标识符保持原有行为，`off`
保留原值

命令行中的 `--password`、`--http-password`、`--ftp-password`、`--proxy-password` 使用空白或 `=`
分隔时，密码值会被遮蔽，带引号的值和转义 JSON 使用相同规则相邻的引号片段、普通片段和转义空格按完整参数遮蔽，外层 JSON 字符串边界和空值不会遮蔽后面的字段用户名和非敏感参数保持可见，`off`
保留原始命令

auto 和 strict 会遮蔽紧凑的 token 返回语句中的 UUID 值，例如 `token created, returned a new UUID <value>` 和
`令牌创建成功，返回新 UUID <value>`
token 或令牌与返回子句位于同一行，中间最多 256 个字符，不跨换行或 JSON 字段关联只替换 UUID 值，普通 session、ref、operation 标识保持可见，`off`
保留原文

未加引号的赋值名称或命名参数使用有界 RHS 扫描，保留不含值字符串字面量的完整调用、属性链、下标和 lambda，例如
`token = text(node, 1)`、`sorted(values, key=lambda x: x['durationNs'])` 和 `process_key = path.name.rsplit('.', 1)[0]`
字符串例外按语法位置判断：下标中形如标识符的字段名，以及方法 `(分隔符, 整数)[下标]`
中只含标点的分隔符不使用函数名称白名单，不对代码块整体豁免普通字符串参数、返回字符串的 lambda、拼接、无法分类的表达式和超过 32 层的嵌套会遮蔽整个候选 RHS；未闭合或超深嵌套会覆盖剩余候选文本保留表达式后仍扫描内层敏感字段与 Authorization/Cookie，带引号的 JSON 键和结构化敏感字段保持整值脱敏这只是有限语法识别，纯文本
`token=foo(bar)` 无法证明值是代码还是凭证 `off`
保留原文，各消息工具与导出共享这些规则，range 在全文脱敏判定后按原始 Unicode 坐标选取

仅在 strict 中判为位置字段的未加引号名称保留双冒号命名空间与日志分隔符，例如 `host::method()` 和
`ghost_appearance :: description`，`password::value` 等凭证字段、引用字段、`host:::1`
等三冒号值及独立私有 IP/URL 检查保持原有保护

`output` 接受文件路径或目录，`tmp:relative/path` 写入受控临时目录，`cwd:relative/path`
持久化到当前工作目录；未加前缀的相对路径也写入受控临时目录每次导出发布一个目录，包含正文、manifest 和图片默认给目录名增加唯一后缀；显式文件名
`results.jsonl` 对应 `results.export-<唯一后缀>/results.jsonl`，设置 `overwrite=true` 后目标固定为
`results.export/results.jsonl`要覆盖某次唯一文件导出，可将返回的正文路径作为 `output`，并设置
`overwrite=true`search 的正文路径为 `output.results`，其他工具为 `output.content`；它们与 `output.manifest`、提供的
`output_path` 都是实际路径只有 `overwrite=true`（CLI 为
`--overwrite`）才允许替换带归属标记的旧导出目录，不能覆盖无关目录文件在目标目录同级暂存并同步后发布覆盖过程被中断时，下次使用
`overwrite=true` 会恢复目录；其他进程留下的恢复记录须超过 30 秒，且能确认原进程已退出，否则返回
`output_busy`；新目录尚未发布则恢复旧目录，已确认发布则保留新目录并清理旧备份；状态无法确认时返回
`output_restore_failed`，不删除两个目录Windows 输出路径拒绝 ADS、保留设备名、非法字符和末尾空格或点号；私有 ACL 创建或校验失败返回
`privacy_not_enforced_on_windows`MCP 服务启动或首次使用临时输出时，只清理归属标记匹配、超过 24 小时且原进程已退出的临时会话，旧版目录、无标记目录及
`cwd:` 输出保留成功导出到 `tmp:` 后，响应的 `output.retention` 给出清理条件；`cwd:`
响应不带该字段每次临时会话最多 256 项、128 MiB

发布前同步已存在的正文与 manifest，保留文件内容并要求文件已经存在，Windows 文件同步使用可写句柄，同步失败时返回错误，清理未发布的暂存目录并保留原 bundle

Windows 导出路径接受当前用户、SYSTEM 或 Administrators 作为 owner，owner 保持原值；DACL 禁止继承，仅保留当前用户的 FullControl Allow，其他 owner 在修改 DACL 前被拒绝，错误中包含 owner SID

normal 搜索导出与内联结果使用相同过滤、时间排序和去重，导出最多 20,000 条、16 MiB；v2
manifest 记录实际条数、字节数、`complete` 和 `incomplete_reasons`
normal、aggregate、scan 与 ref 读取工具使用索引处理合法大记录，字面 pattern 覆盖完整逻辑正文 regex 在逻辑正文不超过 8
MiB 时完整匹配，超过时保留其他结果，通过
`regex_content_limit`、实际 source/line 与不精确统计说明未检查范围，物理行大小本身不会排除合法消息 context 和 trace 的选定窗口超过 2,000 条或 32
MiB 时分别返回 `session_window_limit`、`session_window_memory_limit`，不缓存整个会话

`slice` 按 Python 半开范围规则工作，在全部过滤和按时间排序后执行，`[-10:]` 返回最近 10 条匹配消息，`[-10:-1]`
排除最新消息，最多返回 9 条，`max_total` 删除部分切片结果时，`next_query`
会携带剩余范围对应的归一化正数 slice，连续续查不会离开原切片分页也会保留
`lines`，包括排除范围和开放范围预算无法容纳任何结果且 continuation 无法前进时返回
`response_too_large`，不会重复返回同一个 slice

`max_total` 统计 `history_search` 返回的紧凑 UTF-8 JSON 文本，不包含 JSON-RPC 和 MCP transport framing，响应会返回
`serialized_bytes`、`max_total_bytes`、`limits_applied` 和 `complete`，导出的 JSONL 内容不受对话响应预算缩减，
`next_query` 和导出 manifest 会保留 `max_content_tool_result`

#### normal 响应预算

normal 保留时间排序、UUID 去重、regex 和 slice，收集到 50,000 个命中或 32
MiB 结果缓存时停止并报告缺口遍历全部来源使用 scan，Rust regex 不支持 look-around 和 backreference

被 `max_total` 缩减的 metadata 在 `stats.metadata_dimensions` 中按字段列出，例如 `coverage.searched_files` 和
`summary.by_tool` 每个受影响维度返回 `total`、`returned`、`omitted`，被删为空数组不表示真实零分布 `response_too_large`
报告所需字节数，能够恢复时提供 `next_query` 或精确 `history_get` 指针，续查保留返回的过滤条件

`structured=preview` 限制结构化 tool 字段，`original_bytes` 是完整脱敏 JSON 在 preview 截断前的 UTF-8 字节数 `get`
指针保留完整 ref、project、source、view、原始 block 下标和 redaction 模式 normal 默认 `full`，scan 默认 `preview`；显式
`full` 不会因预算自动变为 preview，无法容纳时使用错误中的 get 指针或预算建议

#### 全文文件导出

`output_content=preview` 保持原有单条正文预览上限，传入 `output_content=full` 和 `output` 导出完整脱敏正文
`max_content`、`max_content_tool_result` 仍控制对话预览及结构化 preview，`structured`
独立选择完整工具 JSON 或带精确 get 指针的预览排序阶段保存有界来源与记录位置，写入阶段重新验证来源，流式脱敏并转义 JSON 每次最多 20,000 条、16
MiB，容量停止在上一条完整 JSONL 边界；来源变化、取消或写入失败时终止发布 manifest 分别报告
`record_set_complete`、`content_complete` 与 `output_content`，`unexported_range` 是排序命中集合中的绝对半开范围

#### 来源目录与分组扫描

`history_search(mode="sources", ...)` 冻结受支持来源路径清单，分页阶段不读取消息正文 `limit`
默认 128，范围为 1..128，每页返回 `enumeration_complete`、`source_progress`、`files_total`、`items` 与可执行的
`scan_query` 通过 `next_query` 继续目录分页，结束后执行 `release_query` 私有磁盘清单合计最多 128
MiB，目录状态内存最多 32
MiB，每实例最多四个目录，空闲 20 分钟过期，每次访问续期释放、过期、枚举失败和正常进程退出都会清理清单；强制退出后，后续目录请求只清理已过期且能确认所属进程已退出的自有清单

normal 与 scan 的 `sources` 最多接受 128 个精确来源，与 `source`
互斥，project、session 与 subagents 条件继续取交集显式来源分组允许保留同 ID 的不同物理文件，每组开始 scan 时冻结文件字节，多个分组不构成全局原子快照

CLI `search --mode sources` 输出目录页，`search --mode scan --grouped`
在同一进程消费目录分组、全部正文页和 metadata 页分组 NDJSON 增加 `kind=sources|body|metadata` 与 `group`
首次来源枚举 metadata 配额失败且未返回正文时，CLI 可缩小分组；其他失败返回已输出页数和条数、失败分组、未消费分组和剩余目录查询失败退出码非零，已部分消费的分组不自动重放，CLI
cursor 仍只属于当前进程

#### 逐批 scan

从 `history_search(mode="scan", ...)` 开始，随后原样执行每页返回的 `next_query`
scan 按确定的文件和物理行顺序返回，保留重复 UUID 的来源，冻结筛选、时间边界和来源字节边界追加后缀不计入快照，文件替换、截短和检测到的来源变化明确失败；空结果页仍可推进，继续读取至
`scan_complete=true` 且 `has_more=false`

`scan_bytes` 包括索引和投影等处理读取，因此能够大于文件的唯一来源字节数，`scan_ms`
限制单批主动处理时间 scan 拒绝 regex、slice、非零 offset、output 和 dry_run 响应分别返回 `scan_id`、累计
`stats`、`scan_complete`、`counts_exact` 和 `attribution_complete`
完整 coverage、有效筛选、summary 桶、warning 和归因记录通过 `history_scan_metadata`
读取非法 UTF-8 和损坏 JSON，包括损坏超大记录，计入
`invalid_records`，metadata 保留实际 source/ref/line 扫描继续读取合法后缀，返回
`counts_exact=false`；容量、来源变化和其他处理错误仍明确失败消息正文中的长字段名不因超过 4
KiB 被拒绝，普通、引用、Unicode 和嵌套 JSON 转义字段沿用现有脱敏规则，无效字符串转义按原始字段文本判定超大记录中的 JSON 对象键仍受每键 4
KiB 解码后 UTF-8 索引限制

普通搜索与索引扫描跳过内部元数据，包括没有消息 UUID 的 `api-request-blob` 缓存记录，这些记录仍可通过
`history_get(view="record")` 读取，损坏 JSON、非法 UTF-8 和缺少必填字段的对话消息继续报告诊断

cursor 绑定当前 MCP 实例，按相同预算重试最近成功请求时原样重放改变重放预算、冻结筛选，使用旧 cursor 或其他实例都会返回明确错误单条记录无法容纳时保留该记录，`response_too_large.available.next_query`
指向尚未消费的当前页每个实例最多保留四个扫描，空闲 20 分钟过期，每次扫描的 metadata 上限为 32
MiB，消费结束后释放状态取消会停止读取和 CPU 工作，取消扫描会释放对应 cursor 状态 `scan_metadata_quota` 返回
`metadata_bytes_used`、`requested_bytes`、`max_metadata_bytes`、`remaining_bytes`、`files_enumerated` 和 `scan_phase`
字节数为配额记账值，不是进程 RSS；按项目或会话缩小查询范围，读取失败扫描的 metadata 后释放状态，32 MiB 上限保持有效

CLI `search --mode scan` 在一个进程中驱动全部批次，先输出 NDJSON 结果页，再输出 metadata 页通过 `results`
识别结果页，通过 `items` 识别 metadata 页，随后释放状态；`--cursor` 不支持跨 CLI 进程续查

### history_scan_metadata

| 参数        | 类型    | 默认值 | 说明                                       |
| ----------- | ------- | ------ | ------------------------------------------ |
| `scan_id`   | string  | 必填   | 使用返回的 `metadata_query`                |
| `cursor`    | string  | -      | metadata `next_query` 中的 cursor          |
| `limit`     | number  | 100    | 每页条目数，1 至 10000                     |
| `max_total` | number  | 40000  | 紧凑 UTF-8 JSON 预算，512 至 10000000 字节 |
| `release`   | boolean | false  | 停止并释放扫描状态，不能与 `cursor` 同传   |

扫描结束或失败后，metadata 提供稳定分页，此前返回 `scan_in_progress` 每项包含 `kind` 和 `value`，`dimensions`
分别报告各维度的总条目数、返回数和遗漏数原样消费 metadata `next_query` 至 `has_more=false`，再传 `scan_id` 和
`release=true`，释放不删除用户导出

### history_get

| 参数        | 类型   | 说明                                                                              |
| ----------- | ------ | --------------------------------------------------------------------------------- |
| `ref`       | string | 必填，消息定位（session前8位:行号）                                               |
| `source`    | string | search 或 scan metadata 返回的精确绝对来源路径                                    |
| `view`      | string | `content`（默认）、`tool_input`、`tool_result` 或 `record`                        |
| `block`     | number | 工具视图使用原始 `message.content` 数组下标                                       |
| `range`     | string | 所选原始视图的 Unicode 字符半开范围（如 `0-100000`）                              |
| `output`    | string | 输出文件或目录（自动提取图片，相对路径默认走受控临时目录，持久化请显式写 `cwd:`） |
| `overwrite` | bool   | 覆盖已存在且带归属标记的导出目录                                                  |
| `project`   | string | 项目 ID                                                                           |
| `redaction` | string | `auto`、`strict` 或 `off`，默认 `auto`                                            |

直接返回过大时会返回 `content_too_large`，包含 `content_size`、`valid_range`、`parsed_range`、`head`、`tail`、
`range_suggestion` 和
`output_suggestion`range 使用原始消息的 Unicode 字符位置auto 和 strict 会先检查完整消息，再渲染 range，只要 range 与敏感值有交集就返回脱敏标记，`redaction=off`
返回对应的原始 range，包括完整 tool input

引用文本中的赋值只扫描到当前字符串边界，保留后续字段与消息块，合法空 range 返回空正文和零次替换，起点超出原始视图的 range 仍被拒绝

`view=tool_input` 返回规范化 input JSON，`view=tool_result` 返回规范化的完整 tool_result
block 同类型工具块超过一个时，使用原始 content 数组的 `block`
下标选择，range 坐标对应所选视图超大 JSONL 记录先建立索引，再渲染 range 或发布 output

`view=record`
返回整条原 JSON 对象的规范化文本，按所选模式脱敏，包含默认 content 视图不显示的原记录类型与内部 payload，也支持缺少消息元数据的对象该视图不保留来源中的空白或字段顺序，不接受
`block`，不单独提取图片文件，range 使用脱敏前规范化对象的 Unicode 字符位置来源边界、输出配额和私有导出权限保持，默认 content 与工具视图的行为不变

搜索结果和 preview 的 get 指针包含 `source`，ref 匹配多个物理文件时，读取工具返回 `session_ambiguous`
和候选来源将返回的 source 原样传给 get、context 或 trace，CLI 使用 `--source`
路径必须属于已识别历史布局中与 ref/project 一致的来源，不接受任意文件或链接

### history_context

| 参数             | 类型    | 默认值  | 说明                                                      |
| ---------------- | ------- | ------- | --------------------------------------------------------- |
| `source`         | string  | -       | search 或 scan metadata 返回的精确来源路径                |
| `ref`            | string  | -       | 必填，消息定位                                            |
| `before`         | number  | -       | 向前取 N 条（仅计数同时匹配 `types` 和 `pattern` 的消息） |
| `after`          | number  | -       | 向后取 N 条（仅计数同时匹配 `types` 和 `pattern` 的消息） |
| `until_type`     | string  | -       | 持续到指定类型                                            |
| `until_ref`      | string  | -       | 持续到同一 session 内的另一个 ref                         |
| `direction`      | string  | forward | forward/backward                                          |
| `types`          | string  | -       | 要包含的消息类型（逗号分隔）                              |
| `subtypes`       | string  | -       | 要包含的消息子类型（逗号分隔）                            |
| `project`        | string  | -       | 项目 ID                                                   |
| `output`         | string  | -       | 导出选中上下文并返回 `output_path`                        |
| `overwrite`      | boolean | false   | 覆盖已存在且带归属标记的导出目录                          |
| `redaction`      | string  | auto    | `auto`、`strict` 或 `off`                                 |
| `max_content`    | number  | 4000    | 单条最大字符数                                            |
| `max_total`      | number  | 40000   | 完整紧凑 JSON 响应的 UTF-8 字节上限                       |
| `pattern`        | string  | -       | 内容过滤 pattern，仅计数/返回匹配该 pattern 的消息        |
| `regex`          | boolean | false   | 是否使用正则匹配                                          |
| `case_sensitive` | boolean | false   | 是否区分大小写                                            |

锚点消息（由 `ref` 指定）始终包含，`before`/`after` 只计数同时匹配 `types`、`subtypes`
和脱敏后 pattern 的消息两项计数均未指定时，context 扩展到 EOF；仅指定 `before` 时，`after` 为零

局部 context 和 trace 查询支持超过 100000 条消息的会话，限制按选定跨度计算跨度内的全部有效消息，包括展示过滤排除的消息，都计入 2,000 条和 32
MiB 上限，超限分别返回 `session_window_limit`、`session_window_memory_limit`
诊断只涵盖已扫描前缀，不检查未扫描后缀；合法 JSONL session metadata
record 不产生警告，损坏 JSON 和不完整消息产生警告合法超大记录使用共享索引，保留消息位置与工具配对

单条消息超过 `max_content` 或完整 UTF-8 JSON 响应超过 `max_total` 时返回 `truncated=true` 连锚点与元数据也装不下时返回
`response_too_large`

ref 必须是非空 session prefix 加正整数行号，例如 `c86bc677:1234` `direction` 仅支持 `forward` 或 `backward`，且只用于
`until_type`，`until_type` 只接受有效消息 type 范围模式三选一：`before`/`after`、`until_type`、`until_ref`，不能混用
`until_type` 包含指定方向最近的边界，不受展示过滤影响，不将锚点自身作为边界；没有边界时只选择锚点 `until_ref`
双向包含两个端点，端点不存在时返回 `ref_not_found`

### history_trace

| 参数             | 类型    | 默认值  | 说明                                       |
| ---------------- | ------- | ------- | ------------------------------------------ |
| `source`         | string  | -       | search 或 scan metadata 返回的精确来源路径 |
| `ref`            | string  | -       | 必填，消息定位                             |
| `before`         | number  | 20      | 锚点前消息数，按 type/pattern 过滤后计数   |
| `after`          | number  | 20      | 锚点后消息数，按 type/pattern 过滤后计数   |
| `project`        | string  | -       | 项目 ID                                    |
| `types`          | string  | -       | 要包含的消息类型                           |
| `subtypes`       | string  | -       | 要包含的消息子类型                         |
| `pattern`        | string  | -       | 内容过滤 pattern                           |
| `regex`          | boolean | false   | 是否使用正则                               |
| `case_sensitive` | boolean | false   | 是否区分大小写                             |
| `servers`        | string  | -       | 按 MCP server 过滤 `tool_calls`            |
| `tools`          | string  | -       | 按 tool 名过滤 `tool_calls`                |
| `until_type`     | string  | -       | 持续到指定消息类型                         |
| `until_ref`      | string  | -       | 持续到同一 session 内的另一个 ref          |
| `direction`      | string  | forward | `until_type` 的 forward/backward           |
| `output`         | string  | -       | 导出选中 trace 并返回 `output_path`        |
| `overwrite`      | boolean | false   | 覆盖已存在且带归属标记的导出目录           |
| `redaction`      | string  | auto    | `auto`、`strict` 或 `off`                  |
| `max_content`    | number  | 4000    | 单条最大字符数                             |
| `max_total`      | number  | 40000   | 完整紧凑 JSON 响应的 UTF-8 字节上限        |

`history_trace` 返回附近消息，并在 `tool_calls` 中列出识别到的 tool 调用和对应 tool_result，有 `tool_use_id`
的 result 只匹配相同 ID；没有 ID 时先匹配 assistant parent UUID，再在仅有一个 pending
call 时使用旧版顺序兼容，每个 call 返回 `match_method`，未匹配和歧义 result 进入有数量上限的
`association_issues`，结构化 tool-result preview 在 JSON 序列化前按 key 递归脱敏，也会处理 text 中嵌入的 JSON
object，trace 导出使用同一份脱敏 preview未设置 `until_type` 或 `until_ref` 时，`before` 和 `after`
默认各为 20ref、direction、type、subtype 和互斥范围模式规则与 `history_context` 相同

### history_build_info

返回当前运行二进制的 package
version、commit、target、profile、UTC 构建时间、dirty 状态和构建身份是否可复现，本地 dirty 构建不会标记为可复现，CLI 对应命令为
`mcp-claude-history build-info`，CLI 还支持 `mcp-claude-history --version` MCP redaction schema 列出
`auto`、`strict`、`off`，旧参数 `none` 和 `raw` 仍按 `off` 解析

## 使用示例

### 搜索

```bash
# 基础搜索
mcp-claude-history search "error"

# 正则搜索
mcp-claude-history search "error|warning" --regex

# 按时间过滤最近的消息
mcp-claude-history search "" --since 2026-04-29 --limit 10

# 在一个进程内遍历来源，NDJSON 依次包含结果页和 metadata 页
mcp-claude-history search "error" --mode scan --all --subagents --redaction strict

# 最近 10 条匹配消息
mcp-claude-history search "" --slice '[-10:]'

# Python 半开区间，排除最新一条匹配消息
mcp-claude-history search "" --slice '[-10:-1]'

# 搜索指定项目
mcp-claude-history search "bug" --project=-home-user-myproject

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
mcp-claude-history sessions --project=-home-user-myproject
```

## ref 格式

```
ref = session前8位:行号
例如：c86bc677:1234
```

主 session 的 prefix 是完整 session ID 的前 8 位（如 `c86bc677-9f5f-4e49-8e16-5e175a059610`） `agent-<id>`
session 的规范 prefix 是去掉 `agent-` 后的前 8 位`ref`、session 过滤和 `until_ref` 均接受规范 prefix 或完整 session ID

## 许可证

MIT 许可证 - 详见 [LICENSE](LICENSE)
