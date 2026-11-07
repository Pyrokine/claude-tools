# JSONL 机制参考

## 文件位置

```
~/.claude/projects/<project-hash>/<session-uuid>.jsonl
```

`project-hash` = 当前目录绝对路径把 `/` 换成 `-`（开头也是 `-`）`session-uuid`
= 该次会话的 UUID，CLI 启动时创建；`/resume` 会复用同一个 UUID

## 行记录格式

每行一条 JSON，字段含义：

- `uuid`：本条消息 ID

- `parentUuid`：父消息 ID,构成消息树

- `type`：`user` / `assistant` / `summary` / `system` / `file-history-snapshot` / `attachment` / `custom-title` /
  `agent-name` / `permission-mode` / `last-prompt`

- `subtype`：`system` 的子类:`turn_duration` / `local_command` / `api_error` / `compact_boundary` / `stop_hook_summary` 等

- `timestamp`：ISO 8601 UTC

- `sessionId`：必须与文件名一致

- `message.content`：实际文本/tool_use/tool_result

## /compact 行为

用户触发 `/compact` 时 CC 会在文件里写一条
`{"type":"system","subtype":"compact_boundary"}`,边界之后新的 summary/user消息开始追加， **真实时间戳在 boundary
处会断裂**——因为 CC 会把旧消息的一个 summary 版本及部分上下文以新 uuid 追加进来,这些消息的 timestamp 可能回到更早的时间
结论:**jsonl 的行号顺序 ≠
时间戳顺序**

## /resume 选 leaf 的行为

`/resume` 恢复会话时 CC 的实际行为 (观察所得,非文档化):

1. 解析整个 jsonl 构建 `uuid → parentUuid` 消息树
2. 找 leaf 节点 (没有被任何其他消息 parent 的 uuid)
3. **按文件物理行号**反向扫描,选 **最后一个**带 timestamp 的 leaf 作为"当前对话末端"
4. 沿该 leaf 反向回溯 parent chain,形成 context

**关键**:不是按 timestamp 最晚的 leaf,是按文件行号最末尾的 leaf

## 常见异常场景

- `/resume` 卡死：[Issue #21067](https://github.com/anthropics/claude-code/issues/21067) 某行 tool_result 过大(>500KB)导致反序列化卡死

- `/resume` 直接 Cancelled：jsonl 太大(>100MB),CC 加载超时

- resume 后恢复到错误的历史点：文件末尾是 /compact 回放段或之前失败的 /resume 尝试,CC 按行号选到这些 leaf

- session 在列表里消失：[Issue #25920](https://github.com/anthropics/claude-code/issues/25920) 首条 user message >15KB,CC 只读文件前
  16KB 取 firstPrompt,解析失败

- resume 只加载了末尾几条：[Issue #22526](https://github.com/anthropics/claude-code/issues/22526) parentUuid 链断裂,CC 从断点处起新 root

## 修复策略

### 策略 A:截断到对话真实末尾

diagnose.py 在链有效且无分支歧义时应用五分钟启发式：非对话 tail leaf 比候选 user/assistant 晚超过 5
分钟，且截断保留完整父链和后写入对话，才建议保留到该 dialog 行
重复 UUID、环、混合时区或时间回退会提示复核，由显式 `--line` 选择保留范围

```bash
python3 scripts/truncate.py <session.jsonl> --line <N> --title "..." --dry-run
# 停止所有写者后原地修复，或使用 --new-session 保留原文件
python3 scripts/truncate.py <session.jsonl> --line <N> --title "..."
```

末尾追加 `custom-title` 同时处理 Issue #25920 的 head-read
bug，最终输出逐物理行验证，原末行缺少 LF 时会增加分隔符，正文中的 U+2028/U+2029 不作为物理行分隔符

### 策略 B:保留原 sessionId vs 新 sessionId

- **原 sessionId**：停止写者后原地发布，MCP history 索引会指向修复内容，原内容保留在本次打印的唯一备份中
- **新 sessionId**：两个 JSONL 文件并存，都能被 MCP 搜索到，CC session
  picker 会多出一个 session，`truncate.py --new-session` 使用此方式

读取和提交前会核对源文件身份、大小、修改时间及其他变化信息，检测到变化会拒绝覆盖，这些检查用于发现变化，原地修复仍要求停止写者

POSIX 通过独占建立 `.bak.<随机标识>` 硬链接保留原 inode，再用 `os.replace`
发布已验证的暂存文件，旧描述符在最后检查窗口内的追加仍指向备份 inode，Windows 通过 `ReplaceFileW`
同时保留原文件为备份，备份位于独占创建的私有目录内，缺少安全原地发布原语时会报错，`--new-session` 仍可独占创建新文件

新文件、暂存文件和失败文件使用私有权限：POSIX `0600`；Windows 在创建时设置受保护的当前账户/SYSTEM
DACL，备份保留原文件访问控制，失败时会输出暂存或恢复路径，停止写者并确认备份内容后，再恢复会话路径

### 策略 C:处理 dangling parentUuid

diagnose.py 报 `dangling parentUuid > 0` 时,说明文件内有 parentUuid 指向文件外的 uuid，两种处理:

1. **接受**:CC resume 时会把这些 uuid 当新 root,通常能正常 resume,只是部分历史不可见2. **修复**:把首行 (或指向文件外parent
   的行)的 `parentUuid` 改成 `null`,强制变 root，需手改 jsonl

### 策略 D：删除 thinking block

```bash
python3 scripts/truncate.py <target> --strip-thinking --dry-run
python3 scripts/truncate.py <target> --strip-thinking --new-session
```

删除所有 `message.content` 数组中的 `type=thinking` 项，保留其他内容块及未知字段，仅清理 thinking 时保留已有标题，显式
`--title` 才会追加新标题，可结合 `--line` 只处理保留范围，写入与截断共用记录校验、私有暂存和安全发布路径

## 诊断与输入边界

两个 CLI 使用相同的文件解析规则：显式现存路径优先；指定 `--project`
后，完整 id 和前缀都只查询该项目；零候选或多候选明确报错

输入按 UTF-8 逐 LF 物理行读取，坏字节、坏 JSON、非对象记录和工具实际消费字段的错误类型都带行号报告，诊断会继续检查后续行，修复前显示
retained/removed 计划，保留范围含异常时拒绝写入，
选中删除的异常尾行明确提示，任何位置的无效 UTF-8 都会拒绝修复，原文件或备份保留全部原始输入

`recommended_truncation_line=null` 表示当前没有自动截断建议，缺少 timestamped leaf 或 dialog anchor 且未发现其他异常时为
`health=unknown`
重复 UUID 与 parent 环带物理行号报告并令 `health=needs_review`，多个 leaf、混合时区、后写入对话的时间回退及候选范围外的父节点会停止自动建议
时间比较使用解析后的实际时刻，同刻选择物理位置较后的对话，leaf 仍按物理顺序推断；显式 `--line` 保留手工选择，写入前提示保留范围的链异常
候选检查遍历所有有效物理记录，后写入的对话在 timestamp 缺失、为 null 或空字符串时也会停止建议；保留行即使没有 UUID，其
parentUuid 仍参与检查，父节点在候选范围外时报告双方行号，普通无时间戳 system 元数据仍合法

诊断索引只保留每个有效物理行的 UUID、parent、时间戳、类型和位置，文本输出按需读取所选 leaf 正文，JSON 输出保留原字段并增加
`issues`、`health`，截断按选定行流式生成暂存文件，不同时保存全文件正文及多个副本

## 1 万行经验上限

经验值:截断后保留 1 万行 (约 30-50MB)以内,CC 能顺畅 resume 且不会立即再触发 /compact，更大仍可能卡
