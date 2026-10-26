# mcp-claude-history 回归测试用例

每次发版前，agent 在 CC 会话内按章节顺序执行所有必跑用例，只有全部 PASS 或已登记为 KNOWN-LIMIT 才能发版

本文件只维护可复用的测试指导、用例定义、验收标准和长期限制，不记录单次执行结果、日期化回归记录或发版日志

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

**预期**：返回数组，每项含 `id`、`path`、`path_approximate`、`session_count` 和 `last_activity`；至少含
`<project>`现存路径中的连字符、下划线、点号和空格保持原样，`path_approximate=false`；无法唯一解析的历史项目明确返回
`path_approximate=true`

---

## 2. sessions（列出会话）

### sessions-01

**步骤**：`history_sessions(project="<project>")`

**预期**：返回 `project`、`sessions` 和 `redaction`；每个会话包含 `id`、`ref_prefix`、`line_count`、`start_time`、
`end_time`、`size_bytes` 和可选 `topic`

### sessions-02: topic 脱敏

**步骤**：在受控 JSONL fixture 的首条 user 内容中写入 `token=<test-value>`，依次调用
`history_sessions(project="<project>", redaction="auto")`、`redaction="strict"` 和 `redaction="off"`

**预期**：`auto` 和 `strict` 的 `topic` 不包含测试值，且 `topic_redacted_count` 和响应 `redaction.redacted_count`
反映替换数量；`off` 保留原始 topic

### sessions-03: 空 project

**步骤**：`history_sessions(project="<not-exist>")`

**预期**：错误信息明确（不挂死）

---

## 3. search（按关键词搜索）

### search-01: 简单 pattern

**步骤**：`history_search(pattern="error", project="<project>", limit=10)`

**预期**：返回 `results` 数组，每项含 `ref`、`type` 和 `content`；短消息的 `content` 包含 "error"，长消息按
`max_content` 返回有界正文预览

### search-02: regex 模式

**步骤**：`history_search(pattern="^error|^warn", regex=true, project="<project>")`

**预期**：返回符合正则的消息

### search-03: case_sensitive

**步骤**：先 `case_sensitive=false` 搜 "Error"；再 `case_sensitive=true` 搜 "Error"

**预期**：前者结果 ≥ 后者；不同大小写的命中数差异可见

### search-04: types 过滤

**步骤**：`history_search(pattern="...", types="user")`

**预期**：仅返回 type=user 的消息

### search-04a: user-shaped 消息筛选

**步骤**：`history_search(pattern="...", types="user", subtypes="human")`

**预期**：只返回 `type=user, subtype=human` 的普通 user-shaped record结果和说明不得把该分类表示为可验证的真人作者来源

### search-05: subagents 扫描范围与有效配置

**步骤**：在隔离 HOME/TMPDIR 创建自有主 JSONL、`<session>/subagents/agent-local.jsonl`、
`<session>/remote-agents/agent-remote.jsonl`、`<session>/subagents/workflows/<run>/agent-nested.jsonl` 和同级
`journal.jsonl`，分别省略 subagents、传 false 和 true 对每组分别查询全部会话、父 ID、各子 ID，覆盖普通、summary、aggregate、dry_run、output，以及 limit 和 max_total 续查读取公开 MCP
schema，核对 subagents 的默认值和文件范围说明

**预期**：省略与 false 只含主文件，true 纳入直接 subagent、remote-agent 与已识别的嵌套 Workflow
agent，journal 不参与检索 sessions 匹配文件自身 ID，父 ID 不自动包含子会话，未选中的子 ID 返回 session_not_found
normal 成功响应始终回显布尔型
`stats.effective_filters.subagents`，false 不省略；scan 通过 metadata 的 filters 条目回显 coverage、导出与 CLI/MCP 使用相同来源，续查不重复或遗漏，schema 说明默认值和实际支持的布局

### search-06: subagents flag CLI 与 MCP 一致

**步骤**：CLI `mcp-claude-history search "test" --subagents`；MCP 调用同参数

**预期**：返回结果一致（E.3 验证）

### search-07: since/until 时间过滤

**步骤**：`history_search(pattern="...", since="2026-01-01", until="2026-12-31")`

**预期**：仅返回该时间窗内的消息；无效日期和 `since > until`
返回参数错误，不能静默放宽范围时间过滤启用后，时间戳无法解析的 fixture record 不返回，`stats.skipped_invalid_timestamps`
和 `incomplete_reasons` 说明跳过数量；未启用时间过滤时该 record 仍可返回

### search-08: 分页 limit + offset

**步骤**：先 `limit=5, offset=0` 拿一批；再 `limit=5, offset=5` 拿下一批

**预期**：两批结果不重叠；如还有更多则 has_more=true

### search-08a: lines 分页续查

**步骤**：在至少 10 行的 fixture 上调用 `history_search(lines="5-7,!6", limit=1)`，随后原样执行返回的 `next_query`，直到
`has_more=false`

**预期**：每个 `next_query` 都保留规范化的
`lines="5-7,!6"`；结果只含第 5、7 行，顺序不变且不重复单行、闭区间、开放区间和排除范围都应按相同规则保留

### search-09: slice 最近消息

**步骤**：`history_search(pattern="", project="<project>", slice="[-10:]")`

**预期**：返回过滤后按时间排序的最近 10 条消息；stats.slice 含 raw/start/end/total_before_slice/total_after_slice

### search-10: slice 半开范围

**步骤**：`history_search(pattern="", project="<project>", slice="[-10:-1]")`

**预期**：不包含最新一条匹配消息；最多返回 9 条；`slice` 与 `offset/limit` 同用时返回参数错误

### search-11: max_content / max_total

**步骤**：`history_search(pattern="...", max_content=200, max_total=2000)`

**预期**：普通消息 preview 不超 200 字符；紧凑 JSON 的实际 UTF-8 字节数不超过 2000；`serialized_bytes`
与实际序列化长度一致；返回 `max_total_bytes`、`limits_applied` 和 `complete`

### search-11a: tool result 独立上限

**步骤**：`history_search(pattern="", subtypes="tool_result", max_content=2000, max_content_tool_result=100, limit=5)`

**预期**：tool result preview 不超 100 字符；普通消息仍使用 `max_content=2000`；`next_query` 保留
`max_content_tool_result=100`

### search-11b: escaping 与首条超限

**步骤**：使用含大量引号、反斜杠、中文、tool input/result 和 image metadata 的 fixture，调用 `max_total=50000`

**预期**：最终紧凑 JSON 不超过 50000 字节；首条结果单独超限时返回有界 preview 和 ref，或结构化 `response_too_large`
；不返回完整大正文

### search-11c: slice 预算续查范围

**步骤**：使用至少 20 条有序匹配记录的 fixture，分别调用 `slice="[10:20]"` 和 `slice="[-10:]"`，将 `max_total`
设为只能保留切片前几条；随后执行返回的 `next_query`

**预期**：首次响应 `complete=false`、`has_more=true`；`next_query` 携带从下一条绝对位置到原结束位置的归一化正数
`slice`，不含 `offset` 和 `limit`；连续执行每一页返回的 `next_query`
无重复，最终结果严格停在原切片范围末尾；把预算继续降低到一条结果也无法容纳时返回 `response_too_large`，不返回原地不动的
`next_query`

### search-12: pattern 为空+all=true

**步骤**：`history_search(all=true, project="<project>", limit=10)`

**预期**：返回参数错误，all=true 不能和 project 同时使用

### search-13: server/tool 强过滤

**步骤**：`history_search(pattern="", project="<project>", servers="mcp-chrome", tools="browse", limit=10)`

**预期**：仅返回匹配 server/tool 的 tool_use 记录，每条含 matched_filters

### search-13a: 多 tool block 字段关联

**步骤**：在同一 assistant record 中放入三个 `tool_use`，各自使用不同 name、input marker 和 `tool_use_id`；下一条 user
record 放入对应的三个 `tool_result`，让首项 payload 报错、中间项
`is_error=true`、末项成功分别按每个 tool、`failed_tool_results` 和 `tool_payload_errors` 查询

**预期**：每次选择第一个同时满足全部过滤条件的 block；返回的 server、tool、input、result、`is_error` 和 payload
error 状态都来自该 block 及其 `tool_use_id`，不得拼接其他 block 的字段首项和中间项失败都能被相应过滤条件命中

### search-14: summary/jsonl/incomplete

**步骤**：

```text
history_search(
    pattern="",
    project="<project>",
    summary=true,
    output="tmp:mcp-history-test/search.jsonl",
    output_format="jsonl",
    max_total=1000
)
```

**预期**：预算足够时返回 summary、coverage、incomplete/incomplete_reasons；输出文件为 JSONL，manifest 存在必要元数据无法放入
`max_total=1000` 时，返回 `response_too_large` 和 `available.next_query`；按建议预算恢复并保留原
`output`、`output_format`，核对实际输出、manifest 和 summary，不把初始拒绝记成请求成功

### search-14a: 内容完整性与工具归因

**步骤**：在独立 fixture 中分别构造
`unknown_id`、`missing_id`、`ambiguous_parent`，再添加正常用户文字；分别通过关键词、`subtypes=human`、时间和行范围排除工具记录；再查询匹配的工具记录，以及用
`servers/tools` 筛选无法确认归属的记录；对普通、`summary`、`aggregate` 和 JSONL 导出重复查询

**预期**：被排除的工具记录不影响内容完整性，也不进入归因诊断；匹配工具记录的关联缺失仅进入
`stats.attribution_incomplete_reasons` 和记录级
`metadata_incomplete_reason`，正文搜索仍完整；工具名称或服务筛选无法确认时，返回
`tool_filter_unverifiable`，`complete=false`、`total_matches_exact=false`；manifest 与响应的归因原因一致，真实 parse/read 错误及容量限制仍保持不完整语义

### search-14b: 扫描路径不挤占命中消息

**步骤**：构造一条短命中和大量无关会话路径，将最终紧凑响应限制为 1800 字节

**预期**：优先缩减 `coverage.searched_files` 并保留首条命中，缩减维度在 `stats.metadata_dimensions` 返回
`total/returned/omitted` 必要字段和首条记录能够容纳时不返回空结果；实际仍超预算时返回
`response_too_large`、真实所需字节和不跳过首条的恢复查询按返回预算重新查询可读取该条记录，不能删除遗漏诊断来满足旧预算，展示删减不改变原本精确的匹配数

### search-14c: 容量与读取缺口的四模式计数

**步骤**：分别构造单条 record 超过 2,048 个 tool block、跨 record 超过 2,048 个 pending ID、pending 字段累计超过 8
MiB 的 fixture，每组保留一条短命中对普通、summary、aggregate 和 output 重复查询，再使用读取失败与损坏 JSON
fixture；同时执行 search-14a 的归因矩阵

**预期**：四种模式都通过 `incomplete_reasons` 说明对应缺口，并返回 `incomplete=true`、`total_matches_exact=false`
合法超大记录和 regex 边界按 search-24 验收，工具容量原因分别为
`tool_blocks_cap`、`tool_pending_cap`、`tool_pending_bytes_cap`，读取和解析原因带实际计数纯归因缺口仍只影响归因诊断，名称筛选无法确认时保留
`tool_filter_unverifiable`；manifest 的完整性和原因与扫描结果一致

### search-14d: 已扫描前缀与未扫描后缀

**步骤**：准备排序相邻的两个 session，第一个含 5 条 UUID 各异的短于 8 MiB 的合法命中行，每条正文约 7
MiB；第二个只有一条短命中对普通、summary 和 output 使用 `max_content=100`
查询，再缩小响应字节预算并检查导出 manifest 对 aggregate 分别使用超过 50,000 个独立 UUID、超过 50,000 条空 UUID 命中，以及总 UUID 字节超过 32
MiB 的 fixture，并在后面保留第二个 session 重复全部文件可扫描、空文件、首文件读取失败和零文件场景；同一 fixture 再执行
`dry_run=true`

**预期**：32 MiB 结果缓存停止后，`files_scanned=1`，`searched_files` 只含第一个 session，`skipped_files`
只含第二个 aggregate 的去重、命中及字节容量停止使用相同的实际前缀语义；当前文件中途停止仍属于已尝试范围，打开失败也计入尝试数响应与 manifest 的两个路径集合无交集，预算缩减后的剩余路径不改变归属；全扫描时 skipped 为空，零文件时两个集合都为空
`dry_run` 不读取正文，`files_scanned=0`，单独返回完整计划范围

### search-14e: 混合工具名与筛选关联

**步骤**：在隔离 fixture 中写入
`Bash`、`mcp__mcp-ssh__ssh_exec`、两个 server 的 read/write 工具，以及各自的 tool_result；分别混合查询本地名与完整 MCP 名、两个指定 server/tool 组合、短名和显式 servers，再加入多工具 record 与 harness/payload 错误条件对普通、summary、aggregate、JSONL 导出比较命中集；用 limit 和 max_total 分别触发分页与预算续查，再测试 slice 的预算续查；通过 dry_run 检查有效过滤条件

**预期**：混合查询不排除本地工具，完整名称只匹配指定的 server/tool 组合，不匹配交叉组合；短名继续跨 server 匹配显式 servers 与 tools 按 AND 组合，错误条件与工具名必须在同一 block 满足
`stats.effective_filters.tools` 和 `next_query.tools`
保留完整名称，servers 不包含推导值；续查不遗漏、不重复命中，导出与内联结果一致；dry_run 不读取正文

### search-15: summary 噪声控制

**步骤**：同一关键词分别运行 `types="assistant,user,summary"` 和 `types="assistant,user"`

**预期**：前者可包含 `type=summary` 结果，后者不包含 summary；文档明确默认会搜索 summary

### search-16: 默认 redaction

**步骤**：搜索含 `Authorization`、`token`、`cookie` 或 `password` 字段的 tool_use/tool_result 记录，并导出
`output="tmp:mcp-history-test/redaction.jsonl"`

**预期**：导出的 JSONL 中敏感值显示为 `[redacted]`，记录含 `redacted=true` 和 `raw_available=true`；工具响应的 `results`
为空并通过 `output` 返回结果文件与 manifest，manifest 含 `redaction.enabled=true` 与规则列表

### search-17: redaction 模式和显式 JSONL 文件路径

**步骤**：同一查询分别执行 `redaction="strict"` 与 `redaction="off"`，导出到
`output="tmp:mcp-history-test/redaction-strict.jsonl"` 和 `output="tmp:mcp-history-test/redaction-off.jsonl"`

**预期**：默认显式文件名导出到 `<stem>.export-<唯一后缀>/` 目录，JSONL 和 manifest 同在该目录；`overwrite=true` 才以
`<stem>.export/` 为固定目标；`strict` manifest 含 `mode="strict"`、 `enabled=true`、`raw_available=true`；`off`
manifest 含 `mode="off"`、`enabled=false`、`rules=[]`、`raw_available=true`

### search-17a: 完整 tool input 与带前缀 JSON 脱敏

**步骤**：构造一个长度超过 300 字符的 tool input，把 `FAR_NEEDLE` 放在第 200 字符之后，并让正文包含
`Output: {"password":"fixture_secret"}` 和 fenced JSON分别用 `redaction="auto"`、`strict`、`off` 搜索并导出

**预期**：三种模式都能通过 `FAR_NEEDLE` 命中；auto 和 strict 的响应及导出不含 `fixture_secret`，off 保留完整原文；
`max_content` 只限制结果预览，不改变搜索集合

### search-17b: Unicode 转义字段名与字面反斜杠

**步骤**：在隔离 fixture 中用下面的构造保留字段名的字面反斜杠，不要先解析后重序列化 `body`

```javascript
const body = '{"pass' + String.fromCharCode(92) + 'u0077ord":"fixture_secret"}'
if (!body.includes(String.fromCharCode(92) + 'u0077') || JSON.parse(body).password !== 'fixture_secret') {
    throw new Error('fixture must retain its original Unicode escape')
}
const literal = JSON.stringify({ ['pass' + String.fromCharCode(92) + 'u0077ord']: 'public_value' })
```

将 `body` 原样写入 user 字符串、嵌套 JSON、带前缀或 fenced JSON、序列化 tool input 和 tool-result `text` 使用
`JSON.stringify(body)` 及再次 `JSON.stringify` 构造多层嵌入文本，并加入 `literal`
作为不应反复解码的对照分别用 auto、strict 和 off 调用 get、search、context、trace、sessions；前四个工具分别导出并按返回路径读取正文及 manifest 对含中文前缀的原文，使用只覆盖敏感值内部或部分字符的 get
range，再读取导出结果

**预期**：auto 和 strict 的内联、会话主题、tool-result 文本及导出均不出现 `fixture_secret`，相交 range 返回 `[redacted]`
原文字段名、非敏感文本、格式和 Unicode 坐标保持，`literal`
的字面反斜杠不会被解读成敏感字段名 off 保留完整原文与对应原文 range；manifest 为 v2，脱敏模式和替换计数与实际正文一致

### search-17c: 代码 RHS 与敏感值字面量

**步骤**：在隔离 HOME/TMPDIR 的自有 JSONL 中，将 `token = text(node, 1)`、
`sorted(values, key=lambda x: x['durationNs'])`、`process_key = path.name.rsplit('.', 1)[0]`
分别写入普通文本、fenced 文本、JSON
String 和工具输入使用无效测试值覆盖直接赋值、普通及转义敏感 JSON、无字段名的调用参数、内层敏感赋值或 JSON、lambda 返回字符串、字符串拼接、未闭合表达式和超过 32 层的括号，增加中文前缀及只覆盖测试值内部的 range 分别调用 auto、strict、off 的 get、search、context、trace，比较内联与导出；用内层裸敏感赋值验证保留表达式仍继续扫描

**预期**：三个代码原例在三种模式下保持完整，auto/strict 的测试值及其内部 range 不泄漏，off 返回对应原文字符串参数、返回字符串的 lambda、拼接和不满足有限语法的候选 RHS 整体遮蔽下标字段名和方法
`(标点分隔符, 整数)[下标]`
按语法位置判断，不以任意短字符串、熵值或函数名称豁免括号深度最多 32，未闭合或超限时不得留下未检查尾部；带引号的 JSON 敏感键与结构化敏感字段仍整值脱敏内层敏感字段、Authorization/Cookie 检测保持，全文替换后按原 Unicode
range 选取，直接返回和导出一致

将 `token=fixture-secret`、带字符串参数及未闭合的 RHS 放入 JSON 的 `command`
字符串，后面保留普通字段和另一条消息块，再用 `JSON.stringify` 嵌套两次，分别测试普通记录与超过 8 MiB 的索引记录

**预期**：RHS 的敏感区间止于外层字符串内容边界，后续字段、引号、消息块和 Unicode 文本保持原样，普通与流式脱敏的正文和计数一致，索引路径使用有界读取

### search-17d: SSHPASS 密码环境变量脱敏

**步骤**：在隔离 HOME/TMPDIR 的自有 JSONL 中，将合成测试密码写入
`SSHPASS=<test-value>`、`export SSHPASS='<test-value>'`、工具输入 `env.SSHPASS`、Unicode 转义键和嵌套 JSON 字符串，加入
`LANG`、`SSHPASS_FD`、`SSHPASS_FILE` 对照字段构造超过 8
MiB 的工具输入，将密码字段放在长文本之后，使用中文和 emoji 前缀计算原始 Unicode
range 分别用 auto、strict、off 调用 get 的正文与 tool_input、normal/scan
search、context、trace、sessions，并读取各入口的导出正文与 manifest
range 只选择测试密码内部的部分字符，继续消费 scan 的 next_query，直到完成

**预期**：auto 和 strict 的预览、结构化值、会话主题及导出均不包含测试密码，range 与密码值相交时只返回脱敏标记 LANG、SSHPASS_FD、SSHPASS_FILE 保持原值，超大输入的非敏感长文本完整保留，off 返回原文及对应原始 range 导出 manifest 的脱敏模式、完整性和字节数与实际文件一致，文件权限符合现有私有输出合同；不读取或复用真实认证材料

### search-17e: 命令行密码参数脱敏

**步骤**：在隔离 HOME/TMPDIR 的自有 JSONL 中，使用合成测试密码构造
`wget --user fixture-user --password <test-value> --preserve-permissions`，并覆盖
`--http-password`、`--ftp-password`、`--proxy-password`
的空白、等号、单双引号值及转义 JSON 增加引号前后相邻的普通字符、转义空格、单引号中的反斜杠、转义引号，以及 tab、换行、回车分隔分别测试参数位于命令末尾和后面还有非敏感参数的情况；在 JSON 字符串中增加空值与缺少值的命令，保留后续 note 字段测试密码包含点、逗号、方括号和大括号，增加
`--ask-password`、`--password-file fixture-path` 及普通说明文字对照将命令分别写入普通正文、tool input、tool
result 和嵌套 JSON 字符串，其中一条输入超过 8
MiB，密码位于长文本之后分别用 auto、strict、off 调用 sessions、get 正文与 tool_input、normal/scan
search、context、trace 和文件导出使用中文与 emoji 前缀计算原始 Unicode
range，分别选择密码内部、相邻后缀和转义空格中的部分字符；继续消费 scan 的 next_query，直到完成

**预期**：auto/strict 将整个密码参数替换为一个脱敏标记，不能留下相邻片段或转义空格后的密码内容，range 与任一参数片段相交时只返回该标记所有入口、预览、结构化值及导出不含测试密码或其范围片段，带点的密码不能被当作代码属性链保留空值和缺少值的命令不越过外层字符串边界，note、用户名、后续非敏感参数、非密码 env 和长文本保持原值负例不被当作密码值参数，off 保留完整原文及对应 range 导出 manifest 的脱敏模式、完整性、UTF-8 字节数和私有文件权限与实际文件一致，不读取或复用真实凭证

### search-17f: token 返回文字中的 UUID 脱敏

**步骤**：在隔离 HOME/TMPDIR 的自有 JSONL 中，用合成 UUID 构造
`token created, returned a new UUID <value>`、`令牌创建成功，返回新 UUID <value>`
和 Markdown 返回文字加入普通 session/operation
UUID、不同 JSON 字段、实际换行、字面反斜杠加 n、返回会话 UUID 的负例覆盖中文长上下文、嵌套 JSON 字符串、tool
input/result、64 KiB 缓冲边界和超过 8
MiB 的输入与结果，UUID 位于长文本之后分别用 auto、strict、off 调用 sessions、get 正文与结构化 view、normal/scan
search、context、trace 和文件导出使用中文与 emoji 前缀计算原始 Unicode
range，只选择 UUID 内部的部分字符，并完整消费 scan 的 next_query

**预期**：auto/strict 只替换明确 token 返回语句中的 UUID 值，负例、标识及非敏感长文本保持原值普通文本、嵌套结果与分块投影使用相同规则，range 与 UUID 相交时返回完整脱敏标记，off 返回原文及对应 range 导出 manifest 的模式、完整性、UTF-8 字节数与实际文件一致，文件权限为 0600，不读取真实认证配置或复用真实值

### search-17g: 私有位置名称后的双冒号

**步骤**：在隔离 HOME/TMPDIR 的自有 JSONL 中，写入 `ghost_appearance :: description`、`host::method()`、
`url::parse()`、`endpoint::status` 和 `domain::lookup`，覆盖普通消息和超过 8 MiB 的消息加入
`host: fixture-machine`、`password::fixture-secret`、`host:::1`、带引号的 host 字段、双冒号后独立私有 IP/URL 及命名空间调用内的敏感赋值分别用 auto、strict、off 调用 get、normal/scan
search、context、trace 和导出，选择双冒号与敏感值内部的原始 Unicode range，完整消费 scan 的 next_query

**预期**：未加引号、恰好两个冒号且仅在 strict 中敏感的位置名称保持原文，普通与超大读取结果一致凭证字段、引用字段、三冒号值、内层敏感赋值和独立私有 IP/URL 保持原有保护，敏感范围不泄漏局部值，off 保留原文直接返回、预览与完整导出使用同一规则，不读取或复用真实认证材料

### search-17h: 独立 npm token 脱敏

**步骤**：在隔离 HOME/TMPDIR 的自有 JSONL 中，使用小写 `npm_`
加 36 个合成 ASCII 字母或数字构造测试值，不读取或使用真实凭证将测试值放入独立正文、普通字段和数组，以及 `printf`
格式串之后的独立引号参数；覆盖 tool input、tool
result、嵌套 JSON 字符串和 record 视图加入 35/37 位正文、大写前缀、非法正文字符、相连的 ASCII/Unicode 标识符、普通 npm 名称、占位符、非敏感参数和合法代码表达式作为对照将测试值放在当前 reader 的实际缓冲边界两侧，并构造超过 8
MiB 的输入和结果，保留长的非敏感前缀分别以 auto、strict、off 调用 sessions、get 的 content/tool_input/tool_result/record、normal/scan
search 的 full/preview、context、trace 及导出，完整消费 scan 的 next_query 和预览中的 get 恢复指针使用中文、emoji 和原始 Unicode 坐标选择测试值内部、完整值及相邻边界范围；检查与赋值、Authorization、strict
URL 重叠时的替换计数，并读取完整导出正文与 manifest

**预期**：auto/strict 在所有入口和视图中遮蔽完整测试值，范围与测试值任意部分相交时返回完整脱敏标记，重叠区间只计一次两种读取路径保持相同规则，普通字段、相邻非敏感参数和长文本保持原有内容，结构化 JSON 有效，负例不被独立 token 规则误判 normal、aggregate 和 output 通过索引读取合法大记录，字面 pattern 检查完整逻辑正文，regex 超限明确报告未检查范围；超预算时返回现有明确错误和恢复信息，不通过增加预算或完整加载超大记录替代有界读取 off 返回完整原值及对应原始范围，计数为零；导出 manifest 的模式、字节数、完整性和私有权限与实际文件一致，凭证形状、单词边界和模式行为与双语 README 一致

### search-18: 过滤参数校验

**步骤**：分别调用 `history_search(types="visitor")`、`history_search(subtypes="author")`、
`history_search(types="human")`

**预期**：前两项返回 `invalid_arguments` 并列出合法值；最后一项保留兼容行为，自动作为 `subtypes="human"`
执行并返回 warning

### search-19: summary、aggregate 和 dry_run

**步骤**：对同一受控 fixture 分别调用 `summary=true`、`aggregate=true` 和 `dry_run=true`

**预期**：`summary` 在 `stats.summary` 返回分组计数并保留结果行；`aggregate` 不返回结果行；`dry_run`
不读取消息正文，返回选中的项目、会话和文件

### search-20: 高基数 metadata 与零条 summary 续查

**步骤**：创建至少 80 个 session 和不同 tool 桶，用 normal、`summary=true, limit=0, max_total=4096` 查询逐项核对
`stats.metadata_dimensions`，原样执行 `next_query`；对 limit 分页和正文预算删减分别查询

**预期**：被删维度可辨识，`total=returned+omitted`，空数组不被解释为真实零分布扫描无缺口时
`total_matches_exact=true`，展示删减和 `has_more` 不改变精确计数首次保留 `limit=0` 的零结果合同，下一页 `limit>=1`
且 offset 前进，最终 UTF-8 JSON 不超过预算

### search-21: structured full、preview 与 get 指针

**步骤**：创建超过响应预算的 tool input/result，分别显式传 `structured=full` 和 `preview` 在原始业务 JSON 中加入同名
`get`、`original_bytes`、`budget_preview` 字段，再原样调用响应给出的 get 指针与预算恢复查询

**预期**：full 不会静默转 preview，无法容纳时明确拒绝并报告占用；提高到建议预算后保留完整脱敏结构 preview 的恢复指针包含真实完整 ref、project、source、view、block，不能由业务字段替换，完整获取和预览指向同一记录

### search-22: 普通预算性能与取消

**步骤**：显式执行 ignored 的 `normal_summary_phase_measurement`，使用 200、1000、5000 对合成 tool_use/tool_result，保留
`all=true, max_total=38000, redaction="strict", servers="mcp-ssh", since="2026-07-14T00:00:00Z", subagents=true, subtypes="tool_use", summary=true, types="assistant", until="2026-10-12T12:33:55.391Z"`，不传 limit，再通过公开 stdio
SDK 给正在读取与计算的 normal 请求发送取消，分别检查读取、预算处理和最终 JSON 序列化路径

**预期**：记录读取、解析、脱敏、汇总、完整序列化、预算与完整请求的实际耗时，不把独立 pass 相加为严格阶段分解预算删除维度或尾部结果时不反复序列化全部结果，返回连续前缀与可前进的 next_query，精确计数保持取消后实际来源读取和 CPU 工作停止，不能只验证客户端 AbortError，也不能把取消改为普通 read_error 后返回成功

### search-23: 公开 schema 与参数说明

**步骤**：通过新构建的 `tools/list`
读取 pattern、regex、output/output_format、subagents、mode/cursor/scan 预算和 structured 参数验证普通 AND/OR/排除词项、Rust
regex 不支持的 look-around/backreference、合法 JSONL 导出、错误的 `.json` search 导出和 `cwd:` 绝对路径

**预期**：schema、CLI 与双语 README 说明相同合同，合法请求按约定执行，不支持的格式和路径明确拒绝新增参数由正式字段解析，不进入被忽略的 extra，完整 next_query 保留有效范围

---

### search-24: normal 大记录与 regex 精确边界

**步骤**：在自有临时历史目录中创建超过 8
MiB 的合法消息、超大 tool_use 和对应 tool_result，匹配词位于尾部，覆盖 Unicode、AND/OR/排除词、行范围、工具筛选、重复 UUID 与非单调时间；再加入物理行超过 8
MiB 但逻辑正文很短的记录、合法 api-request-blob、坏 JSON、非法 UTF-8 和缺字段消息通过公开 CLI 与 stdio
MCP 对 normal、summary、aggregate、preview/full
output 重复查询；aggregate 的超大工具输入同时覆盖省略 structured 的默认请求和显式 preview 请求

**预期**：字面检索覆盖完整逻辑正文，时间排序和 UUID 去重保持，工具关联在行过滤前更新；合法内部记录不计为损坏无文件输出的 aggregate 只返回统计，默认 structured 不触发工具结构的响应预算错误，工具筛选与 UUID 去重后的精确计数保持一致 regex 对不超过 8
MiB 的逻辑正文精确匹配，超限返回 regex_content_limit、受影响 source/line 和 total_matches_exact=false，保留其余结果坏输入继续报告实际位置，合法大记录不出现 oversized_jsonl_lines 缺口

### search-25: 全文导出与事务边界

**步骤**：生成带尾标记的 4515 字符消息及嵌套工具字段，分别使用 output_content=preview/full、structured=preview/full 和 auto/strict/off 导出加入 thinking/text 与 tool_use/tool_result 混合消息，工具块位于原始 content 数组的非零下标；再加入超过 8
MiB 的合法正文和能触发 20,000 条或 16 MiB 上限的消息，在排序与写入间模拟来源追加、替换、截短、取消和写入失败

**预期**：preview 保持原有截断，full 正文完整且脱敏，structured 独立选择结构输出；混合消息按选中工具块的实际类型导出，保留原始 block 下标，工具结果结构保留 content 字段；manifest 的 record_set_complete、content_complete、unexported_range 与实际文件一致容量停止保留上一条完整 JSONL，来源变化、取消或写入失败时不发布半成品，旧 bundle 保留，权限保持私有

## 4. get（获取完整消息）

### get-01: 普通获取

**步骤**：先 search 得到一个 ref（如 `c86bc677:1234`）；`history_get(ref="<ref>")`

**预期**：返回完整消息内容（不截断）

### get-02: range 分块

**步骤**：`history_get(ref="<ref>", range="0-1000")`，再 `range="1000-2000"`

**预期**：两块互补，组合等于完整内容（按字符计）

### get-02a: range 与敏感值交集

**步骤**：fixture 正文使用
`前缀 password=fixture_secret 后缀`按原始 Unicode 字符位置分别读取完整 secret、左侧部分、右侧部分和字段名不在 range 内的 secret，再用 strict 模式重复；其中一组结果写入
`output`

**预期**：auto 和 strict 的每个相交 range 只返回脱敏标记，不出现 secret 的任何局部字符；range 前后的普通字符按原始坐标保留；导出正文和 manifest 使用同一结果，manifest 的
`sample_kind="range"` 且 redaction count 非零

### get-02b: 合法空 range

**步骤**：在敏感值内部、敏感值左右边缘、普通正文和 Unicode 字符处设置
`start=end`，分别读取 content、tool_input、record 视图及超过 8
MiB 的记录，再导出一组结果，对起点等于原文长度、超出长度和反向范围分别请求

**预期**：合法空范围返回零正文、零字符和零次替换，导出正文为空，manifest 的替换计数为零，非法范围仍返回 `invalid_range`

### get-03: range 越界

**步骤**：`history_get(ref="<ref>", range="999999-1000000")`

**预期**：错误明确，不 panic，返回 content_size、valid_range、parsed_range

### get-04: ref 格式错

**步骤**：`history_get(ref="invalid")`

**预期**：错误信息明确

### get-05: ref 不存在

**步骤**：分别调用 `history_get(ref="00000000:1")` 和 `history_get(ref="00000000:0")`

**预期**：前者返回 session 不存在或行号超限；后者返回 `ref_invalid`，因为行号必须为正整数

### get-06: output 写文件 + canonicalize 校验（C.1 验证）

**步骤**：

1. `history_get(ref="<ref>", output="tmp:mcp-history-test/out.json")` → 应成功
2. `history_get(ref="<ref>", output="/etc/x.json")` → 应被拒绝（不在允许根目录内）
3. cwd 内建 symlink `mcp-history-test/escape -> /etc`，再 `output="cwd:mcp-history-test/escape/x.json"`
   → 应被拒绝（canonicalize 后越界）

**预期**：1 通过；2、3 被拒绝；canonicalize 防止 symlink escape

### get-07: TooLarge 直接给 head/tail

**步骤**：找一条 content_size > 100000 的消息，运行 `history_get(ref="<ref>")`

**预期**：返回 `content_too_large`，含
`content_size`、`valid_range`、`range_suggestion`、`output_suggestion`、`head`、`tail` ，不需要调用方再次猜 range

### get-08: redaction=off 和显式文本文件路径

**步骤**：`history_get(ref="<ref>", redaction="off", output="tmp:mcp-history-test/get-message.txt")`

**预期**：默认 `.txt` 文件及 manifest 一同导出到 `<stem>.export-<唯一后缀>/` 目录；manifest 含
`schema="mcp-claude-history.get-output.v2"`、
`redaction.mode="off"`、`redaction.enabled=false`、`redaction.raw_available=true`、`original_content_size`

### get-08a: 完整 tool input 与三种 redaction 模式

**步骤**：tool input 使用超过 300 字符的参数，在尾部放入
`FAR_NEEDLE password=fixture_secret`，分别调用 auto、strict 和 off，并分别验证直接响应与导出文件

**预期**：三种模式均保留 `FAR_NEEDLE` 和完整输入长度；auto 与 strict 不含
`fixture_secret`；off 原样保留 secret；响应和导出使用相同模式，不存在固定 200 字符截断

### get-08b: 原 JSON 记录与内部 payload

**步骤**：在隔离 HOME/TMPDIR 创建普通和超过 8
MiB 的 progress/system、file-history-snapshot 根对象，包含没有消息元数据的对象、嵌套
`password`、无凭证标记和中文 emoji 通过公开 MCP `history_get(view="record")` 和 CLI `get --view record`
分别执行 auto、strict、off、Unicode range 与完整 output，再验证 `block`、非法 view、非对象根值和默认 content/tool 视图

**预期**：record 返回规范化、按所选模式脱敏的整条原对象，原 type、内部结构与无凭证标记保留；auto/strict 遮蔽嵌套秘密，off 只用于自有无效凭证并保留原对象 range 使用脱敏前规范化文本的 Unicode 字符位置，与敏感值任何部分相交都返回完整脱敏标记，不泄露后缀；输出 manifest 为 v2、view=record、complete=true，字节数与文件一致，目录与文件保持私有权限 record 不接受 block，非法 view 与非对象根值明确拒绝，不单独生成图片文件；默认正文与工具块视图行为保持，不把原内部对象计为普通消息或业务完成证据

---

## 5. context（获取上下文）

### context-01: before/after

**步骤**：`history_context(ref="<ref>", before=2, after=2)`

**预期**：返回锚点前 2 条、锚点本身、锚点后 2 条，共 5 条

### context-02: direction=backward

**步骤**：`history_context(ref="<ref>", until_type="user", direction="backward")`

**预期**：从锚点向前扩展，到第一条 user 消息停止

### context-03: types 过滤

**步骤**：`history_context(ref="<ref>", before=5, after=5, types="user,assistant")`

**预期**：锚点仍包含（即使被 types 过滤），其他消息仅限指定 types

### context-04: until_type

**步骤**：`history_context(ref="<ref>", until_type="user")`

**预期**：从锚点向后取，遇到第一条 user 则停止

### context-05: subtypes 过滤

**步骤**：`history_context(ref="<ref>", before=5, after=5, types="assistant", subtypes="tool_use")`

**预期**：锚点仍包含；其他消息仅包含 assistant/tool_use

### context-06: until_ref + output

**步骤**：`history_context(ref="<ref>", until_ref="<same-session-ref>", output="tmp:mcp-history-test/context")`

**预期**：只接受同一 session 的 until_ref；返回 `output_path`；跨 session until_ref 返回参数错误

### context-06a: 互斥范围和参数校验

**步骤**：分别调用 `history_context(ref="<ref>", before=1, until_type="user")`、
`history_context(ref="<ref>", until_type="user", until_ref="<same-session-ref>")`、
`history_context(ref="<ref>", direction="sideways")` 和 `history_context(ref="<prefix>:0")`

**预期**：全部返回 `invalid_arguments` 或 `ref_invalid`，不忽略任一冲突参数

### context-06b: agent session 的规范 ref

**步骤**：在 `subagents/agent-12345678abcdef.jsonl` 中创建至少两条消息，分别使用 `12345678:1` 和完整
`agent-12345678abcdef:1` 作为 ref，再用对应短 ref 或完整 ID 的第 2 行作为 `until_ref`

**预期**：短 ref 和完整 session ID 都定位到同一 agent session；`until_ref` 成功返回两行，输出 ref 使用规范前缀
`12345678`

### context-07: max_content / max_total

**步骤**：`history_context(ref="<ref>", before=10, after=10, max_content=100)`，并使用单条内容为 `FIVE` 的 fixture 调用
`max_content=1`

**预期**：每条 preview 不超 100 字符；`FIVE` 返回 `F` 且响应含 `truncated=true`单条 `max_content` 截断和整体 `max_total`
截断任一发生都必须报告 truncated

### context-08: redaction=strict 和显式文本文件路径

**步骤**：
`history_context(ref="<ref>", before=2, after=2, redaction="strict", output="tmp:mcp-history-test/context.txt")`

**预期**：默认 `.txt` 文件及 manifest 一同导出到 `<stem>.export-<唯一后缀>/` 目录；manifest 含
`schema="mcp-claude-history.context-output.v2"`、
`redaction.mode="strict"`、`redaction.enabled=true`、`redaction.raw_available=true`

### context-09: 合法非消息 JSONL record

**步骤**：使用受控 session fixture，依次写入合法 session metadata、损坏 JSON、缺少 `message`
的不完整消息 record 和正常锚点消息，再调用 `history_context`

**预期**：合法 metadata 被忽略且不计入解析警告；损坏 JSON 和不完整消息各计入 1 行解析警告；锚点消息正常返回

---

## 6. trace（追踪 tool 调用）

### trace-01: 近邻消息和 tool 调用结果对

**步骤**：`history_trace(ref="<ref>", before=20, after=20)`

**预期**：返回 `anchor_ref`、`messages`、`tool_calls`；若附近有 tool_use 和 tool_result，`tool_calls` 含
`status="completed"`、`result_ref`、`result_preview`

### trace-02: filters + output

**步骤**：

```text
history_trace(
    ref="<ref>",
    before=20,
    after=20,
    types="assistant,user",
    servers="mcp-chrome",
    tools="browse",
    output="tmp:mcp-history-test/trace"
)
```

**预期**：messages 遵守 types/subtypes/pattern 过滤；tool_calls 遵守 servers/tools 过滤；返回 `output_path`

### trace-03: until_ref 同 session 校验

**步骤**：`history_trace(ref="<ref>", until_ref="<same-session-ref>")`，再用跨 session ref 作为 until_ref

**预期**：同 session 成功；跨 session 返回参数错误

### trace-03a: agent session 的规范 until_ref

**步骤**：对 `agent-12345678abcdef.jsonl` 使用 `ref="12345678:1", until_ref="12345678:2"`，再用完整 session ID 重复

**预期**：两种形式都成功，返回消息 ref 使用 `12345678`；其他 agent 或主 session 的 `until_ref` 仍被拒绝

### trace-03b: 互斥范围

**步骤**：`history_trace(ref="<ref>", before=1, until_type="user")`

**预期**：返回 `invalid_arguments`，不能静默忽略 `before`

### trace-04: max_total 截断

**步骤**：`history_trace(ref="<ref>", before=200, after=200, max_total=1000)`

**预期**：最终紧凑 JSON（含 `tool_calls`、`association_issues`、其他字段）不超过 1000
UTF-8 字节，`truncated=true`；超预算时可减少 `tool_calls`，不可返回不完整的单条 tool call；锚点无法容纳时返回
`response_too_large`

### trace-05: 严格关联

**步骤**：使用截断窗口 fixture，其中窗口内有两个 pending call、一个显式错误 `tool_use_id` result、一个正确 ID
result，以及一个无 ID result

**预期**：错误 ID result 不消费 pending call；正确 ID result 使用
`match_method="tool_use_id"`；多个 pending 且无 ID 时进入 `association_issues` 并标记
`ambiguous`；只有一个 pending 时才使用 `legacy_single_pending`

### trace-06: parent UUID 关联

**步骤**：result 不含 `tool_use_id`，但 `sourceToolAssistantUUID` 或 `parentUuid` 指向包含 tool use 的 assistant 消息

**预期**：对应 call 返回 `match_method="parent"`

### trace-07: redaction=strict 和显式文本文件路径

**步骤**：`history_trace(ref="<ref>", before=2, after=2, redaction="strict", output="tmp:mcp-history-test/trace.txt")`

**预期**：默认 `.txt` 文件及 manifest 一同导出到 `<stem>.export-<唯一后缀>/` 目录；manifest 含
`schema="mcp-claude-history.trace-output.v2"`、
`redaction.mode="strict"`、`redaction.enabled=true`、`redaction.raw_available=true`

fixture 的 tool_result 同时包含结构化 object、array 和 text 内嵌 JSON

`tool_calls.result_preview` 与导出文件均不包含原始敏感值，manifest 的 `redacted_count` 计入 preview 脱敏

### trace-08: 合法非消息 JSONL record

**步骤**：使用受控 session fixture，依次写入合法 session metadata、损坏 JSON、缺少 `message`
的不完整消息 record 和正常锚点消息，再调用 `history_trace`

**预期**：合法 metadata 被忽略且不计入解析警告；损坏 JSON 和不完整消息各计入 1 行解析警告；锚点消息和 tool
trace 正常返回

---

## 7. build identity

### build-01

**步骤**：调用 `history_build_info()`，并运行 `mcp-claude-history build-info`

**预期**：两者返回相同的 package version、commit、target、profile、UTC build timestamp 和 dirty 状态；release
binary 的 commit 与发布 commit 一致且 `dirty=false`、`reproducible=true`；本地 dirty 构建不得返回 `reproducible=true`

### build-02

**步骤**：检查 GitHub Release 资产

**预期**：每个平台同时存在稳定平台名和原 target triple 名，两个压缩包内容一致

---

## 8. 安全 / 输入校验

### project-id-01: 项目路径映射与非法值

**步骤**：准备一个现存项目的绝对路径 `<existing-project-path>` 和对应的项目 ID；依次传入
`project="<existing-project-path>"`、该项目 ID、`project="../../../etc"`、`project="/not-an-existing-project"` 和
`project=".hidden"`

**预期**：现存绝对路径和项目 ID 查询同一个项目；其余输入不能映射到现存项目，返回 `invalid_project_id` 或
`project_not_found`，不访问项目目录之外的文件

---

## 9. 边界条件

### empty-jsonl-01

**步骤**：用空 jsonl 调 `history_search`

**预期**：返回空数组，不 panic

### binary-content-01

**步骤**：隔离 fixture 中写入非法 UTF-8 消息，前后各有合法消息，分别调用 `history_get`、normal search 和 scan

**预期**：get 对目标坏行明确返回解析错误；normal
search 跳过并报告坏行；scan 的详细位置与合法后缀按 scan-07 验收，不挂起或返回完整成功

---

## 10. Windows 和资源边界

### history-boundary-01：UTC 日期和排序

**步骤**：受控 fixture 分别写入 `2026-10-08T23:30:00-01:00`、`2026-10-09T00:15:00Z`、`2026-10-10T00:00:00Z`，按
`since="2026-10-09", until="2026-10-09"` 查询，并用 UTC 当天调用 `since="today"`；另用有时区偏移的 RFC3339 查询

**预期**：日期边界按 UTC 定义，前两条按真实 UTC 时间排序，次日零点不在 `until` 当日范围；`today`
与当天 UTC 日期等价内联和导出排序一致

### history-boundary-02：搜索导出容量

**步骤**：用超过 20,000 条结果的受控 fixture 导出，比较文件行数、文件字节数与 manifest 的
`count`、`bytes`、`complete`、`incomplete_reasons`，再使用单行超过 8 MiB 的 JSONL fixture 查询

**预期**：最多导出 20,000 条、16 MiB；manifest 标明对应 `export_record_cap` 或
`export_byte_cap`；合法大行经索引匹配，坏 JSON 和非法 UTF-8 保留具体 source/line 诊断，不发生无界内存增长

### history-boundary-03：context/trace 完整 JSON 预算与窗口

**步骤**：让 fixture 含大量中文、转义字符及多个 tool call，分别调用 `history_context` 和 `history_trace`，设
`max_total=700`，再使选中窗口超过 2,000 条或 32 MiB

**预期**：成功响应完整紧凑 JSON 不超过 700 UTF-8 字节，保留锚点并以 `truncated=true` 告知删减；装不下锚点时报
`response_too_large`；超过 2,000 条报 `session_window_limit`，超过 32 MiB 报 `session_window_memory_limit`

### history-boundary-04：超长会话的局部读取

**步骤**：在隔离项目中生成 100005 条有效消息，交替写入 assistant tool_use 和 user
tool_result，使用第 31714 行及第 100002 行作 ref，分别调用 context/trace，传入
`before=0, after=1, types="user", subtypes="tool_result", max_content=1500, max_total=3500`

**预期**：两种工具均返回锚点及下一条匹配的 tool_result，不因会话总消息数报错；trace 使用跨度内未显示的 tool_use 关联结果，敏感字段保持脱敏，完整紧凑 JSON 不超过 3500
UTF-8 字节

### history-boundary-05：稀疏匹配和范围边界

**步骤**：构造超过 5000 条消息的 fixture，使匹配项之间包含超过 2000 条非匹配消息；分别测试 before/after 的零值、缺省值、稀疏匹配、无后续匹配，以及 until_type 双向最近边界和无边界；对 until_ref 测试相同端点、双向端点、跨 session、非法 ref、缺失端点和有效但跨度超限的端点

**预期**：before/after 联合匹配 type、subtype 与脱敏后的 pattern，锚点始终包含；已经超出保留窗口的必要匹配项仍报
`session_window_limit`，不能被当作不存在后续没有匹配时不把非匹配尾部计入最终窗口，后来出现匹配且选定跨度超限时才报错 until_type 不将锚点自身作为边界，无边界只选锚点；until_ref 包含两端，缺失报
`ref_not_found`，非法或跨 session 报 `ref_invalid`
context 两项计数均缺省时扩展到 EOF，仅指定 before 时 after 为零；trace 计数模式缺省前后各 20 条

### history-boundary-06：窗口容量、读取诊断和导出

**步骤**：分别选择跨度为 2000/2001 条的窗口，以及原始 JSONL 字节数（含换行）恰为 32
MiB/多一字节的窗口；在锚点之前和已满足范围之后放置坏行与超大行，再模拟索引和正文读取之间文件截短、所选行损坏或类型变化；按反向 ref 范围导出，并用过滤条件仅保留锚点

**预期**：恰好达到容量上限时成功，超限明确报错；诊断保留已扫描前缀的错误计数，不统计未扫描后缀；文件变化明确失败，不返回部分成功导出正文中的锚点标记、消息数、脱敏内容与响应一致，manifest 的行数和完整性与实际选定范围一致

### history-output-01：唯一目录、覆盖和失败恢复

**步骤**：同一 `output="tmp:mcp-history-test/export"` 连续导出两次，再对第一次的目录使用 `overwrite=true`；尝试覆盖没有
`.mcp-history-bundle` 归属标记的目录执行 `get.rs`
中的中断恢复测试，分别模拟旧目录已移到备份、新目录已发布、目录被更改，以及其他进程的恢复记录未满 30 秒、已满 30 秒但进程仍在运行、已满 30 秒且进程已退出Windows 上使用无共享权限的目录句柄占用旧目录后再尝试覆盖

**预期**：默认两次导出返回不同目录，正文与 manifest 位于同一目录；只有已标记目录允许显式覆盖被占用或权限不足时返回错误，旧目录可用，不混用新旧文件；中断后再次覆盖会恢复旧目录或确认新目录并清理旧备份，其他进程的恢复记录未满 30 秒或原进程仍在运行时返回
`output_busy`；状态无法确认时返回 `output_restore_failed`，原目录和备份均保留

Windows runner 同时执行
`export_bundle_publishes_together_and_requires_explicit_overwrite`、`export_sync_failure_preserves_existing_bundle_and_removes_staging`
与中断恢复测试，覆盖正常发布、覆盖、缺失暂存 manifest 和同步错误

**预期**：同步现有文件时句柄具备写权限，同步过程保留原内容并要求文件已经存在，失败继续向调用方返回错误，未发布的暂存目录被清理，原 bundle 保持完整；目录同步只按对应平台合同执行

### history-output-02：Windows 原生路径和 DACL

**条件**：在 Windows runner 执行

**步骤**：以现存盘符、UNC 与 extended
UNC 路径查询同一项目，对大小写别名和多个项目匹配同一路径的 fixture 分别测试逐个尝试
`tmp:sample:stream.txt`、`tmp:CON.txt`、尾随空格或点号、控制字符、非法符号路径为受控空文件添加显式 Everyone 读取 ACE，再设置私有 DACL 并检查该 ACE 已删除；对不存在的路径设置 DACL 并检查报错创建目录、含空格正文文件和 manifest 后检查 DACL

**预期**：路径别名指向同一项目；歧义明确返回
`project_ambiguous`非法输出路径被拒绝且不产生文件；私有 DACL 限定当前用户和系统必需主体，无法创建或验证时返回
`privacy_not_enforced_on_windows`，不把 POSIX mode 当作验证证据

### history-output-03：CLI 与 MCP 参数

**步骤**：运行 `mcp-claude-history --version` 和 `build-info`；检查四个输出工具的 MCP `overwrite` 和 redaction
schema，并传入旧值 `none`、`raw`

**预期**：CLI 返回版本号，`build-info` 保留构建身份；redaction schema 列出
`auto/strict/off`，旧别名仍能解析；`overwrite=true` 未指定 `output` 时返回 `invalid_arguments`

### history-output-04：临时会话自动清理范围

**步骤**：在独立测试根目录中创建带新归属标记的已退出进程会话和运行中进程会话，再创建旧版标记目录与无标记目录；先按当前时间执行清理，再用超过 24 小时的测试时钟执行清理Linux 和 Windows
runner 都执行 `get.rs` 的对应单元测试

**预期**：只有超过 24 小时且原进程已退出的新标记会话被清理；运行中的会话、未到期会话、旧版标记目录和无标记目录均保留`tmp:`
导出响应带 `output.retention`，`cwd:` 导出不带，`cwd:` 路径不在清理范围

---

## 11. 逐批 scan 与 metadata

### scan-01: 超过 normal 上限与物理来源

**步骤**：隔离 HOME/TMPDIR 下创建 50,005 条合法命中，含重复 UUID；通过新 release 的 stdio SDK 初始化、`tools/list` 和
`history_build_info` 核对身份调用 `history_search(mode="scan", ...)`，原样消费每页 `next_query` 到结束，并用 CLI
`search --mode scan` 重复

**预期**：全部 50,005 条物理记录返回，重复 UUID 来源保留，每页严格满足 max_total，顺序按文件和物理行确定最终
`scan_complete=true`、`counts_exact=true`，累计命中和返回数一致 CLI 在同一进程输出结果页再输出 metadata 页，消费方按
`results` 与 `items` 区分，结束后释放状态，不支持跨进程 cursor

### scan-02: 空批次、低预算与最近页重放

**步骤**：使用跨多个 16
KiB 缓冲的记录，在低 scan_bytes 下查询无命中和远处命中把响应预算降低到单条记录无法容纳，再按错误中的 next_query 恢复；重复最近成功请求，再改变其预算和冻结筛选

**预期**：空批次有可推进的 cursor，不能按空结果宣告结束；预算拒绝保留记录和当前页，不跳过、不重复最近成功页按原预算原样重放，累计数不重复增加；不同重放预算、冻结筛选和旧 cursor 明确拒绝 scan_bytes 统计索引与投影等处理读取，不要求等于文件唯一字节数

### scan-03: 快照、取消、释放与实例

**步骤**：扫描期间分别追加后缀、截短、替换来源；用另一个 MCP 实例消费原 cursor 在持续处理的大记录上发送 SDK
RequestOptions.signal 取消，再读取同一 scan_id 的 metadata 显式 release 未完成扫描，检查停止后线程、读取和 CPU 状态；执行过期状态测试

**预期**：追加后缀不计入冻结快照，截短、替换和检测到的来源变化明确失败，跨实例拒绝取消和 release 实际终止工作，取消后扫描状态不可续用，不删除旧数据或用户导出；过期状态明确拒绝，不返回假成功

### scan-04: metadata 全维度分页

**步骤**：完成含多个 project/session/tool 桶、warning 和未知 tool_use_id 的扫描，用较小 limit/max_total 逐页消费 metadata
next_query 核对所有 files、filters、summary、issues 与 warnings，分别在完成前、失败后与 release 后调用

**预期**：完成前返回 scan_in_progress，完成或失败后稳定分页，每项包含 kind/value，各维度 total=returned+omitted 累加各页 returned 得到维度 total，完整 files 清单与实际扫描一致，缺口和归因有真实 source/ref/reason
scan_complete、counts_exact、attribution_complete 分开报告，未知关联不得按顺序猜配；释放后 cursor 不可用

### scan-05: 超大记录与大窗口

**步骤**：使用超过 8
MiB 的合法 tool_result，前一条为对应 tool_use，后一条为普通消息把匹配词放在远处，秘密跨多个缓冲边界；验证 scan、get 的原 Unicode
range、tool_input/tool_result
view，以及 source 指定的 context/trace 锚点对多个工具块分别使用原始 content 数组 block 下标，并读取导出正文与 manifest

**预期**：大记录在完整逻辑正文上匹配，有界预览不泄漏秘密或改变匹配集合相交 range 返回脱敏标记，结构视图与原块一致，context/trace 保留前后位置和真实工具关联，完整结果可通过 get/output 恢复合法大行不再被 get/context/trace 当作缺失，窗口消息数与原始字节容量仍有效，格式损坏与资源配额明确报告

### scan-06: 来源歧义、布局与安全边界

**步骤**：在直接 subagent 和 Workflow 目录各建同名 agent 文件，先按短 ref 查询，再使用 search/metadata 返回的 source 调用 get/context/trace 与 CLI
--source 增加未知布局、root 外路径、ref/project 不匹配和受支持布局内的链接，Windows 条件下增加 reparse/junction 与同长度替换文件

**预期**：未指定 source 时明确返回 session_ambiguous，指定真实 source 时三种读取入口选中同一物理文件父 ID 不自动展开，journal 不进入来源；越界、不匹配、链接和不支持布局不能被 source 参数用作任意文件读取通道 Windows 条件结果独立记录，Linux 验证不能替代 Windows 原生证据

### scan-07: 损坏记录的实际位置与合法后缀

**步骤**：隔离来源依次写入合法消息、非法 UTF-8、损坏普通 JSON、带非法后缀的超过 8 MiB
JSON、非法 UTF-8 的超大记录和合法消息原样消费 scan
next_query 至结束，再读取全部 metadata；另用资源超限记录检查非解析错误

**预期**：前后合法消息均按真实物理行返回，四条坏记录计入 invalid_records，metadata 的 issue 含真实 source/ref/line 和解析原因 scan_complete=true、counts_exact=false，不把坏行计为已经完整检查；非解析错误仍明确失败，保留已有恢复参数与来源坐标

### scan-07a: 内部 API 缓存记录

**步骤**：隔离来源依次写入两条 UUID 不同的合法消息，中间放置精确类型为 `api-request-blob`、含 `message` 但没有 `uuid` 与
`timestamp` 的缓存记录，分别使用普通大小和超过 8 MiB 的缓存记录，通过 normal、scan、context、trace 查询两条消息，再以
`view=record` 读取缓存记录；另加入坏 JSON、非法 UTF-8、缺 uuid 的 user 消息和缺 timestamp 的 assistant 消息

**预期**：合法缓存记录作为内部记录跳过，scan 的
`counts_exact=true`、`invalid_records=0`，正常消息保持真实行号，`view=record`
保留缓存 payload；normal 同样忽略合法内部缓存，不因物理行超过 8
MiB 产生缺口，其他坏记录仍产生可定位诊断，缺字段的对话消息保持解析错误

### scan-08: 大小记录的结构预览与严格脱敏恢复

**步骤**：普通和超大 tool_input/tool_result 含相同工具、时间筛选、长秘密、Unicode 与私有 URL，分别查询 structured=preview 和 full 原样执行 preview 或拒绝响应中的 get 指针，普通 full 预算拒绝按 next_query 恢复；允许处理中先返回可推进空页

**预期**：大小记录的 matched_filters 一致，get 指针保留 redaction=strict 和精确 source/view/block
original_bytes 等于恢复的完整脱敏 JSON 的 UTF-8 字节数，preview 使用字符上限且不泄漏秘密，full 不自动转换为 preview 超大 full 无法容纳时错误保留位置与 get 指针，正常预算续查保留未消费记录，不重复或跳过

### scan-09: 长字段候选与原始范围

**步骤**：在超过 8 MiB 的合法消息正文中加入超过 4
KiB 的普通和敏感字段名，覆盖无引号、单引号、双引号、Unicode、嵌套 JSON 转义及无效字符串转义将敏感词放在缓冲边界两侧，分别使用末尾 key、中间 key 和末尾 pwd，保留远处匹配词与合法后缀通过 scan、get 原始 Unicode
range、source 指定的 context/trace 验证，并与普通记录的完整脱敏结果比较；另用真正超长 JSON 对象键及来源读取错误检查边界

**预期**：长正文中的字段候选不触发字段长度拒绝，敏感值仍脱敏，普通字段及中间 key 不被误替换，pwd 只匹配完整字段名无效字符串转义按原始字段文本判定，读取或取消错误不被当作转义失败忽略；有脱敏替换时沿用正文头部预览，远处匹配记录仍返回原 Unicode
range 与前后消息位置保持，真正 JSON 对象键仍受每键 4 KiB 解码后 UTF-8 索引限制

### scan-10: metadata 配额诊断

**步骤**：使用自有来源清单分别触发枚举阶段和记录阶段的 metadata 配额，检查错误后完整消费 metadata_query，再 release

**预期**：scan_metadata_quota 保留 32
MiB 上限，返回 metadata_bytes_used、requested_bytes、max_metadata_bytes、remaining_bytes、files_enumerated 和 scan_phase 占用与剩余配额满足上限，申请量大于剩余额度，拒绝不改变已记账占用；字节数为配额记账值，不是进程 RSS 失败 metadata 保留已枚举来源与实际处理状态，未完成来源不标成 complete，release 后 cursor 不可用，已有导出和其他临时资料保留

### scan-11: 精确来源选择与续查

**步骤**：在隔离 fixture 中建立两个同名 agent 来源，先验证不带 source 时拒绝，再逐一带 source 调用 normal、scan 和 CLI
`--source`
使用 limit=1 与低响应预算连续消费 next_query，读取全部 metadata 并 release；尝试改变冻结 source 分别使用相对路径、历史根外路径、未知布局、链接、项目或会话不匹配，以及未启用 subagents 的子会话来源核对公开 schema 与正常有效筛选、matched_filters、next_query 和扫描 filters 中的 source

**预期**：每次只返回指定物理文件，metadata 的 files_total=1，续查保留 source，冻结来源变更返回 cursor_filter_mismatch 省略项目时采用来源所在项目，显式项目与会话范围取交集，所有不合法来源明确拒绝未指定 source 的同名会话仍拒绝，32
MiB 配额和来源根归属检查保持，失败扫描状态可 release

---

### sources-01: 冻结目录、分组与生命周期

**步骤**：在自有临时目录生成 30,000 个长路径来源，使旧 scan metadata 记账超过 32
MiB，执行 sources_catalog_exceeds_old_metadata_scope_without_buffering_paths 的 ignored 资源回归用 MCP
sources 模式逐页消费 items 与 scan_query，测试 limit、字节预算、最近页重放、冻结条件变更、跨实例、sources/source 互斥、项目和 session 交集及同 ID 物理来源核对 128
MiB 总存储、32
MiB 内存记账、20 分钟空闲 TTL 与访问续期，覆盖 release、取消、失败和正常退出清理；强制终止残留仅在所属进程退出且过期后清理

**预期**：来源页并集无重复或遗漏，枚举与正文进度独立，每组不超过 128 个来源，正文在分组开始时冻结预算拒绝不消费目录项，配额拒绝不发布半成品，改变冻结条件或使用其他实例 cursor 明确报错，自有清单按生命周期清理

### sources-02: 公开 grouped CLI 失败边界

**步骤**：执行 search --mode scan --grouped
--project=<fixture>，完整消费 kind=sources/body/metadata 与 group；分别模拟初始来源配额失败、已经返回正文后的来源变动及写 stdout 失败

**预期**：同一进程完成目录、正文、metadata 和 release，成功来源无遗漏或重复仅初始枚举且尚未返回正文的配额失败能够缩小分组，其他失败退出非零，报告已输出页数、条数、失败来源与未消费分组，保留正文消费边界

## 附录 A：已知限制 / KNOWN-LIMIT

当前未登记长期豁免，非法 UTF-8 与 range 越界使用隔离 fixture 验证，不能按缺少现成历史数据跳过
