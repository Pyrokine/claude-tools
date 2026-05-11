# mcp-claude-history 回归测试用例

每次发版前，agent 在 CC 会话内按章节顺序执行所有用例，记录 PASS/FAIL，汇总到附录 A

**前置条件**：

- 本地 `~/.claude/projects/` 下至少有 1 个 project，且其 sessions/ 目录下至少 2 个 jsonl 文件
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

**预期**：含 subagent session 中的命中（CLI 与 MCP 都应支持，E.3 验证）

### search-06: subagents flag CLI 与 MCP 一致

**步骤**：CLI `mcp-claude-history search "test" --subagents`；MCP 调用同参数

**预期**：返回结果一致（E.3 验证）

### search-07: since/until 时间过滤

**步骤**：`history_search(pattern="...", since="2026-01-01", until="2026-12-31")`

**预期**：仅返回该时间窗内的消息

### search-08: 分页 limit + offset

**步骤**：先 `limit=5, offset=0` 拿一批；再 `limit=5, offset=5` 拿下一批

**预期**：两批结果不重叠；如还有更多则 has_more=true

### search-09: max_content / max_total

**步骤**：`history_search(pattern="...", max_content=200, max_total=2000)`

**预期**：每条 preview 不超 200 字节；总返回不超 2000 字节

### search-10: pattern 为空+all=true

**步骤**：`history_search(all=true, project="<project>", limit=10)`

**预期**：不按 pattern 过滤，返回任意类型消息

---

## 4. get（获取完整消息）

### get-01: 普通获取

**步骤**：先 search 得到一个 ref（如 `c86bc677:1234`）；`history_get(ref="<ref>")`

**预期**：返回完整消息内容（不截断）

### get-02: range 分块

**步骤**：`history_get(ref="<ref>", range="0-1000")`，再 `range="1000-2000"`

**预期**：两块互补，组合等于完整内容（按字节计）

### get-03: range 越界

**步骤**：`history_get(ref="<ref>", range="999999-1000000")`

**预期**：错误明确，不 panic

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

### context-05: max_content / max_total

**步骤**：`history_context(ref="<ref>", before=10, after=10, max_content=100)`

**预期**：每条 preview 不超 100 字节

---

## 6. 安全 / 输入校验

### project-id-01: 路径注入拦截（C.4 验证）

**步骤**：

1. `history_sessions(project="../../../etc")` → 应被拒绝
2. `history_sessions(project="/absolute/path")` → 应被拒绝
3. `history_sessions(project=".hidden")` → 应被拒绝
4. `history_sessions(project="my-project_123")` → 应通过

**预期**：1-3 返回 error（含 "invalid project_id" 或同类提示）；4 通过

---

## 7. 边界条件

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
