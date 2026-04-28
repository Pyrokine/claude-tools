# JSONL 机制参考

## 文件位置

```
~/.claude/projects/<project-hash>/<session-uuid>.jsonl
```

`project-hash` = 当前目录绝对路径把 `/` 换成 `-`（开头也是 `-`）`session-uuid` = 该次会话的 UUID，CLI 启动时创建；`/resume`
会复用同一个 UUID

## 行记录格式

每行一条 JSON，字段含义：

| 字段                | 含义                                                                                                                                                       |
|-------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------|
| `uuid`            | 本条消息 ID                                                                                                                                                  |
| `parentUuid`      | 父消息 ID,构成消息树                                                                                                                                             |
| `type`            | `user` / `assistant` / `summary` / `system` / `file-history-snapshot` / `attachment` / `custom-title` / `agent-name` / `permission-mode` / `last-prompt` |
| `subtype`         | `system` 的子类:`turn_duration` / `local_command` / `api_error` / `compact_boundary` / `stop_hook_summary` 等                                                |
| `timestamp`       | ISO 8601 UTC                                                                                                                                             |
| `sessionId`       | 必须与文件名一致                                                                                                                                                 |
| `message.content` | 实际文本/tool_use/tool_result                                                                                                                                |

## /compact 行为

用户触发 `/compact` 时 CC 会在文件里写一条 `{"type":"system","subtype":"compact_boundary"}`,边界之后新的 summary/user
消息开始追加，**真实时间戳在 boundary 处会断裂**——因为 CC 会把旧消息的一个 summary 版本及部分上下文以新 uuid 追加进来,这些消息的
timestamp 可能回到更早的时间
结论:**jsonl 的行号顺序 ≠ 时间戳顺序**

## /resume 选 leaf 的行为

`/resume` 恢复会话时 CC 的实际行为(观察所得,非文档化):

1. 解析整个 jsonl 构建 `uuid → parentUuid` 消息树
2. 找 leaf 节点(没有被任何其他消息 parent 的 uuid)
3. **按文件物理行号**反向扫描,选**最后一个**带 timestamp 的 leaf 作为"当前对话末端"
4. 沿该 leaf 反向回溯 parent chain,形成 context

**关键**:不是按 timestamp 最晚的 leaf,是按文件行号最末尾的 leaf

## 常见异常场景

| 现象                     | 根因                                                                                                                            |
|------------------------|-------------------------------------------------------------------------------------------------------------------------------|
| `/resume` 卡死           | [Issue #21067](https://github.com/anthropics/claude-code/issues/21067) 某行 tool_result 过大(>500KB)导致反序列化卡死                      |
| `/resume` 直接 Cancelled | jsonl 太大(>100MB),CC 加载超时                                                                                                      |
| resume 后恢复到错误的历史点      | 文件末尾是 /compact 回放段或之前失败的 /resume 尝试,CC 按行号选到这些 leaf                                                                           |
| session 在列表里消失         | [Issue #25920](https://github.com/anthropics/claude-code/issues/25920) 首条 user message >15KB,CC 只读文件前 16KB 取 firstPrompt,解析失败 |
| resume 只加载了末尾几条        | [Issue #22526](https://github.com/anthropics/claude-code/issues/22526) parentUuid 链断裂,CC 从断点处起新 root                          |

## 修复策略

### 策略 A:截断到对话真实末尾

最常见场景，diagnose.py 的 `Recommend` 判据:tail leaf 是 `system` 消息且比最后 user/assistant 晚超过 5 分钟 → 截断到最后的
dialog 行

```bash
head -n N session.jsonl > new.jsonl
echo '{"type":"custom-title","customTitle":"...","sessionId":"..."}' >> new.jsonl
mv new.jsonl session.jsonl
```

末尾追加 `custom-title` 同时防 Issue #25920 的 head-read bug

### 策略 B:保留原 sessionId vs 新 sessionId

- **原 sessionId**:直接覆盖,简单，缺点:MCP history 索引会指向新内容,原内容丢失- **新 sessionId**:两个文件并存,都能被 MCP
  搜索到，缺点:CC session picker 会多出一个 session
  `truncate.py --new-session` 走第二种

### 策略 C:处理 dangling parentUuid

diagnose.py 报 `dangling parentUuid > 0` 时,说明文件内有 parentUuid 指向文件外的 uuid，两种处理:

1. **接受**:CC resume 时会把这些 uuid 当新 root,通常能正常 resume,只是部分历史不可见2. **修复**:把首行(或指向文件外
   parent 的行)的 `parentUuid` 改成 `null`,强制变 root，需手改 jsonl

## 1 万行经验上限

经验值:截断后保留 1 万行(约 30-50MB)以内,CC 能顺畅 resume 且不会立即再触发 /compact，更大仍可能卡
