# mcp-claude-history 回归测试用例

每次发版前，agent 在 CC 会话内按章节顺序执行所有用例，记录 PASS/FAIL，汇总到附录 A

**前置条件**：

- 本地 `~/.claude/projects/` 下至少有 1 个 project，且 project 根目录下至少 1 个主会话 jsonl 文件
- 如验证 sidechain，project 下需存在 `<session>/subagents/*.jsonl` 或 `<session>/remote-agents/*.jsonl`
- jsonl 中至少含 user 与 assistant 消息，部分消息含中文，部分含 markdown 代码块
- 测试用临时输出目录：`tmp:mcp-history-test/`

**记号约定**：

- `<project>`：测试 project 名
- `<session-prefix>`：8 位 session 前缀

---

## 1. projects（列出项目）

### projects-01

**步骤**：`history_projects()`

**预期**：返回数组，每项含 name 和 session_count；至少含 `<project>`

---

## 2. sessions（列出会话）

### sessions-01

**步骤**：`history_sessions(project="<project>")`

**预期**：数组，每项含 prefix(8 位)、message_count、modified_time、size 等

### sessions-02: 空 project

**步骤**：`history_sessions(project="<not-exist>")`

**预期**：错误信息明确（不挂死）

---

## 3. search（按关键词搜索）

### search-01: 简单 pattern

**步骤**：`history_search(pattern="error", project="<project>", limit=10)`

**预期**：返回数组，每项含 ref / type / preview；preview 中含 "error" 高亮（或位置指示）

### search-02: regex 模式

**步骤**：`history_search(pattern="^error|^warn", regex=true, project="<project>")`

**预期**：返回符合正则的消息

### search-03: case_sensitive

**步骤**：先 `case_sensitive=false` 搜 "Error"；再 `case_sensitive=true` 搜 "Error"

**预期**：前者结果 ≥ 后者；不同大小写的命中数差异可见

### search-04: types 过滤

**步骤**：`history_search(pattern="...", types="user")`

**预期**：仅返回 type=user 的消息

### search-05: subagents=true

**步骤**：`history_search(pattern="...", subagents=true, project="<project>")`

**预期**：含 sidechain session 中的命中（CLI 与 MCP 都应支持，E.3 验证）

### search-06: subagents flag CLI 与 MCP 一致

**步骤**：CLI `mcp-claude-history search "test" --subagents`；MCP 调用同参数

**预期**：返回结果一致（E.3 验证）

### search-07: since/until 时间过滤

**步骤**：`history_search(pattern="...", since="2026-01-01", until="2026-12-31")`

**预期**：仅返回该时间窗内的消息；无效日期返回参数错误，不能静默放宽范围

### search-08: 分页 limit + offset

**步骤**：先 `limit=5, offset=0` 拿一批；再 `limit=5, offset=5` 拿下一批

**预期**：两批结果不重叠；如还有更多则 has_more=true

### search-09: slice 最近消息

**步骤**：`history_search(pattern="", project="<project>", slice="[-10:]")`

**预期**：返回过滤后按时间排序的最近 10 条消息；stats.slice 含 raw/start/end/total_before_slice/total_after_slice

### search-10: slice 半开区间

**步骤**：`history_search(pattern="", project="<project>", slice="[-10:-1]")`

**预期**：不包含最新一条匹配消息；最多返回 9 条；`slice` 与 `offset/limit` 同用时返回参数错误

### search-11: max_content / max_total

**步骤**：`history_search(pattern="...", max_content=200, max_total=2000)`

**预期**：普通消息 preview 不超 200 字符；紧凑 JSON 的实际 UTF-8 字节数不超过 2000；`serialized_bytes` 与实际序列化长度一致；返回 `max_total_bytes`、`limits_applied` 和 `complete`

### search-11a: tool result 独立上限

**步骤**：`history_search(pattern="", subtypes="tool_result", max_content=2000, max_content_tool_result=100, limit=5)`

**预期**：tool result preview 不超 100 字符；普通消息仍使用 `max_content=2000`；`next_query` 保留 `max_content_tool_result=100`

### search-11b: escaping 与首条超限

**步骤**：使用含大量引号、反斜杠、中文、tool input/result 和 image metadata 的 fixture，调用 `max_total=50000`

**预期**：最终紧凑 JSON 不超过 50000 字节；首条结果单独超限时返回有界 preview 和 ref，或结构化 `response_too_large`；不返回完整大正文

### search-11c: slice 预算续查范围

**步骤**：使用至少 20 条有序匹配记录的 fixture，分别调用 `slice="[10:20]"` 和 `slice="[-10:]"`，将 `max_total` 设为只能保留切片前几条；随后执行返回的 `next_query`

**预期**：首次响应 `complete=false`、`has_more=true`；`next_query` 携带从下一条绝对位置到原结束位置的归一化正数 `slice`，不含 `offset` 和 `limit`；连续执行每一页返回的 `next_query` 无重复，最终结果严格停在原切片半开区间末尾；把预算继续降低到一条结果也无法容纳时返回 `response_too_large`，不返回原地不动的 `next_query`

### search-12: pattern 为空+all=true

**步骤**：`history_search(all=true, project="<project>", limit=10)`

**预期**：返回参数错误，all=true 不能和 project 同时使用

### search-13: server/tool 强过滤

**步骤**：`history_search(pattern="", project="<project>", servers="mcp-chrome", tools="browse", limit=10)`

**预期**：仅返回匹配 server/tool 的 tool_use 记录，每条含 matched_filters

### search-14: summary/jsonl/incomplete

**步骤**：
`history_search(pattern="", project="<project>", summary=true, output="tmp:mcp-history-test/search.jsonl", output_format="jsonl", max_total=1000)`

**预期**：返回 summary、coverage、incomplete/incomplete_reasons；输出文件为 JSONL，manifest 存在

### search-15: summary 噪声控制

**步骤**：同一关键词分别运行 `types="assistant,user,summary"` 和 `types="assistant,user"`

**预期**：前者可包含 `type=summary` 结果，后者不包含 summary；文档明确默认会搜索 summary

### search-16: 默认 redaction

**步骤**：搜索含 `Authorization`、`token`、`cookie` 或 `password` 字段的 tool_use/tool_result 记录，并导出
`output="tmp:mcp-history-test/redaction.jsonl"`

**预期**：对话返回和 JSONL 中敏感值显示为 `[redacted]`；命中的结果含 `redacted=true` 和 `raw_available=true`；manifest 含
`redaction.enabled=true` 与规则列表

### search-17: redaction 模式和显式 JSONL 文件路径

**步骤**：同一查询分别执行 `redaction="strict"` 与 `redaction="off"`，导出到
`output="tmp:mcp-history-test/redaction-strict.jsonl"` 和 `output="tmp:mcp-history-test/redaction-off.jsonl"`

**预期**：`.jsonl` 按文件路径处理，不额外创建同名目录；manifest 写在 JSONL 文件旁边；`strict` manifest 含 `mode="strict"`、
`enabled=true`、`raw_available=true`；`off` manifest 含 `mode="off"`、`enabled=false`、`rules=[]`、`raw_available=true`

---

## 4. get（获取完整消息）

### get-01: 普通获取

**步骤**：先 search 得到一个 ref（如 `c86bc677:1234`）；`history_get(ref="<ref>")`

**预期**：返回完整消息内容（不截断）

### get-02: range 分块

**步骤**：`history_get(ref="<ref>", range="0-1000")`，再 `range="1000-2000"`

**预期**：两块互补，组合等于完整内容（按字符计）

### get-03: range 越界

**步骤**：`history_get(ref="<ref>", range="999999-1000000")`

**预期**：错误明确，不 panic，返回 content_size、valid_range、parsed_range

### get-04: ref 格式错

**步骤**：`history_get(ref="invalid")`

**预期**：错误信息明确

### get-05: ref 不存在

**步骤**：`history_get(ref="00000000:0")`

**预期**：错误信息明确（session 不存在或行号超限）

### get-06: output 写文件 + canonicalize 校验（C.1 验证）

**步骤**：

1. `history_get(ref="<ref>", output="tmp:mcp-history-test/out.json")` → 应成功
2. `history_get(ref="<ref>", output="/etc/x.json")` → 应被拒绝（不在允许根目录内）
3. cwd 内建 symlink `mcp-history-test/escape -> /etc`，再 `output="cwd:mcp-history-test/escape/x.json"` →
   应被拒绝（canonicalize
   后越界）

**预期**：1 通过；2、3 被拒绝；canonicalize 防止 symlink escape

### get-07: TooLarge 直接给 head/tail

**步骤**：找一条 content_size > 100000 的消息，运行 `history_get(ref="<ref>")`

**预期**：返回 `content_too_large`，含 `content_size`、`valid_range`、`range_suggestion`、`output_suggestion`、`head`、`tail`
，不需要调用方再次猜 range

### get-08: redaction=off 和显式文本文件路径

**步骤**：`history_get(ref="<ref>", redaction="off", output="tmp:mcp-history-test/get-message.txt")`

**预期**：`.txt` 按文件路径处理；manifest 写在同目录；manifest 含 `schema="mcp-claude-history.get-output.v1"`、
`redaction.mode="off"`、`redaction.enabled=false`、`redaction.raw_available=true`、`original_content_size`

---

## 5. context（获取上下文）

### context-01: before/after

**步骤**：`history_context(ref="<ref>", before=2, after=2)`

**预期**：返回锚点前 2 条、锚点本身、锚点后 2 条，共 5 条

### context-02: direction=backward

**步骤**：`history_context(ref="<ref>", direction="backward", before=5)`

**预期**：仅返回锚点前 5 条

### context-03: types 过滤

**步骤**：`history_context(ref="<ref>", before=5, after=5, types="user,assistant")`

**预期**：锚点仍包含（即使被 types 过滤），其他消息仅限指定 types

### context-04: until_type

**步骤**：`history_context(ref="<ref>", after=10, until_type="user")`

**预期**：从锚点向后取，遇到第一条 user 则停止

### context-05: subtypes 过滤

**步骤**：`history_context(ref="<ref>", before=5, after=5, types="assistant", subtypes="tool_use")`

**预期**：锚点仍包含；其他消息仅包含 assistant/tool_use

### context-06: until_ref + output

**步骤**：`history_context(ref="<ref>", until_ref="<same-session-ref>", output="tmp:mcp-history-test/context")`

**预期**：只接受同一 session 的 until_ref；返回 `output_path`；跨 session until_ref 返回参数错误

### context-07: max_content / max_total

**步骤**：`history_context(ref="<ref>", before=10, after=10, max_content=100)`

**预期**：每条 preview 不超 100 字符

### context-08: redaction=strict 和显式文本文件路径

**步骤**：
`history_context(ref="<ref>", before=2, after=2, redaction="strict", output="tmp:mcp-history-test/context.txt")`

**预期**：`.txt` 按文件路径处理；manifest 写在同目录；manifest 含 `schema="mcp-claude-history.context-output.v1"`、
`redaction.mode="strict"`、`redaction.enabled=true`、`redaction.raw_available=true`

### context-09: 合法非消息 JSONL record

**步骤**：使用受控 session fixture，依次写入合法 session metadata、损坏 JSON、缺少 `message` 的不完整消息 record 和正常锚点消息，再调用 `history_context`

**预期**：合法 metadata 被忽略且不计入解析警告；损坏 JSON 和不完整消息各计入 1 行解析警告；锚点消息正常返回

---

## 6. trace（追踪 tool 调用）

### trace-01: 近邻消息和 tool 调用结果对

**步骤**：`history_trace(ref="<ref>", before=20, after=20)`

**预期**：返回 `anchor_ref`、`messages`、`tool_calls`；若附近有 tool_use 和 tool_result，`tool_calls` 含
`status="completed"`、`result_ref`、`result_preview`

### trace-02: filters + output

**步骤**：
`history_trace(ref="<ref>", before=20, after=20, types="assistant,user", servers="mcp-chrome", tools="browse", output="tmp:mcp-history-test/trace")`

**预期**：messages 遵守 types/subtypes/pattern 过滤；tool_calls 遵守 servers/tools 过滤；返回 `output_path`

### trace-03: until_ref 同 session 校验

**步骤**：`history_trace(ref="<ref>", until_ref="<same-session-ref>")`，再用跨 session ref 作为 until_ref

**预期**：同 session 成功；跨 session 返回参数错误

### trace-04: max_total 截断

**步骤**：`history_trace(ref="<ref>", before=200, after=200, max_total=1000)`

**预期**：返回 `truncated=true`，且不影响 `tool_calls` 识别

### trace-05: 严格关联

**步骤**：使用截断窗口 fixture，其中窗口内有两个 pending call、一个显式错误 `tool_use_id` result、一个正确 ID result，以及一个无 ID result

**预期**：错误 ID result 不消费 pending call；正确 ID result 使用 `match_method="tool_use_id"`；多个 pending 且无 ID 时进入 `association_issues` 并标记 `ambiguous`；只有一个 pending 时才使用 `legacy_single_pending`

### trace-06: parent UUID 关联

**步骤**：result 不含 `tool_use_id`，但 `sourceToolAssistantUUID` 或 `parentUuid` 指向包含 tool use 的 assistant 消息

**预期**：对应 call 返回 `match_method="parent"`

### trace-07: redaction=strict 和显式文本文件路径

**步骤**：`history_trace(ref="<ref>", before=2, after=2, redaction="strict", output="tmp:mcp-history-test/trace.txt")`

**预期**：`.txt` 按文件路径处理；manifest 写在同目录；manifest 含 `schema="mcp-claude-history.trace-output.v1"`、
`redaction.mode="strict"`、`redaction.enabled=true`、`redaction.raw_available=true`；fixture 的 tool_result 同时包含结构化 object、array 和 text 内嵌 JSON，`tool_calls.result_preview` 与导出文件均不包含原始敏感值，manifest 的 `redacted_count` 计入 preview 脱敏

### trace-08: 合法非消息 JSONL record

**步骤**：使用受控 session fixture，依次写入合法 session metadata、损坏 JSON、缺少 `message` 的不完整消息 record 和正常锚点消息，再调用 `history_trace`

**预期**：合法 metadata 被忽略且不计入解析警告；损坏 JSON 和不完整消息各计入 1 行解析警告；锚点消息和 tool trace 正常返回

---

## 7. build identity

### build-01

**步骤**：调用 `history_build_info()`，并运行 `mcp-claude-history build-info`

**预期**：两者返回相同的 package version、commit、target、profile、UTC build timestamp 和 dirty 状态；release binary 的 commit 与发布 commit 一致且 `dirty=false`、`reproducible=true`；本地 dirty 构建不得返回 `reproducible=true`

### build-02

**步骤**：检查 GitHub Release 资产

**预期**：每个平台同时存在稳定平台名和原 target triple 名，两个压缩包内容一致

---

## 8. 安全 / 输入校验

### project-id-01: 路径注入拦截（C.4 验证）

**步骤**：

1. `history_sessions(project="../../../etc")` → 应被拒绝
2. `history_sessions(project="/absolute/path")` → 应被拒绝
3. `history_sessions(project=".hidden")` → 应被拒绝
4. `history_sessions(project="my-project_123")` → 应通过

**预期**：1-3 返回 error（含 "invalid project_id" 或同类提示）；4 通过

---

## 9. 边界条件

### empty-jsonl-01

**步骤**：用空 jsonl 调 `history_search`

**预期**：返回空数组，不 panic

### binary-content-01

**步骤**：jsonl 中含二进制（如非法 UTF-8）的消息时 `history_get` / `search`

**预期**：跳过该消息，error 写入返回，整体不挂

---

## 附录 A：执行记录

| 日期         | CC session                           | 执行人             | 范围                        | 结果摘要                                                                                       |
|------------|--------------------------------------|-----------------|---------------------------|--------------------------------------------------------------------------------------------|
| 2026-04-28 | 2d1d0b19-1537-4722-93a2-23ac3e91b97c | claude-opus-4-7 | TESTING.md 全量（v1.4.0 首发前） | projects/sessions/search/get/context/安全/边界 全 PASS；output canonicalize + project_id 白名单验证通过 |

## 附录 B：已知限制 / KNOWN-LIMIT

- get-03 range 越界：当前实现可能返回空或部分；接受 "错误明确不 panic" 即可
- binary-content-01：依赖测试 jsonl 是否真的有非法 UTF-8 数据，可跳过
