# Known Issues / 官方 GitHub 追踪

Session jsonl 和 /resume 的相关 issue,按场景分组，修复前先查是否已有社区方案

## Resume 失败

### [Issue #22566 — Session JSONL 截断恢复标准做法](https://github.com/anthropics/claude-code/issues/22566)

在 `cd` 之后 assistant 响应停止持久化,但用户消息继续写入，`--resume` 从 cd 之后任何点都加载失败,只有截断到 cd 之前最后完整
turn 才能恢复
**Workaround**:`head -n <LAST_GOOD_LINE>`,即 `scripts/truncate.py` 核心逻辑

### [Issue #22526 — parentUuid 链包含 phantom 引用](https://github.com/anthropics/claude-code/issues/22526)

CC 有时写入的 `parentUuid` 指向从未存在过的 UUID，resume 反向遍历 chain 时命中 phantom,停在那里,只加载末尾几条消息
**症状**:`sessions-index.json` 里 `messageCount: 2` 但文件有 951 行 → CC 只认可 valid chain 长度

### [Issue #36583 — file-history-snapshot messageId 与 uuid 碰撞](https://github.com/anthropics/claude-code/issues/36583)

resume 写入的 `file-history-snapshot` 条目 messageId 复用原 message 的 uuid,造成遍历歧义,下游消息变孤儿

### [Issue #33651 — SubAgent progress chain 覆盖主对话](https://github.com/anthropics/claude-code/issues/33651)

SubAgent 的 progress 消息 flush 晚于主对话,时间戳反而更新，resume 只保留 progress chain,主对话消息"静默消失"(报告中 28 条
assistant 消息丢失)

## Resume 卡死 / 超时

### [Issue #21067 — 大 tool output 让 resume 卡死](https://github.com/anthropics/claude-code/issues/21067)

某行 tool_result 内嵌 675KB 内容,resume 在反序列化/渲染时无限挂起
**Workaround**:找行 `awk '{if(length>50000) print NR": "length" bytes"}' session.jsonl` 然后 Edit 截断那行内容

### [Issue #21022 — 访问 >50MB jsonl 文件时 CC 冻结](https://github.com/anthropics/claude-code/issues/21022)

102MB session 文件直接让系统冻结(90% RAM),需强杀

### [Issue #19036 — resume 含 1.4MB git diff 时冻结](https://github.com/anthropics/claude-code/issues/19036)

### [Issue #22204 — /resume 命令在大 session 下完全无响应](https://github.com/anthropics/claude-code/issues/22204)

在 autocomplete 阶段(未 enter)就冻结,说明 session scanner 是同步加载

### [Issue #30302 — 多天 session + 207 subagent 文件让 resume 崩溃](https://github.com/anthropics/claude-code/issues/30302)

主 transcript 仅 12MB,但 207 个 subagent 文件累计 107MB，Resume 可能 eagerly stat + parse 全部 subagent,含 base64 图片的
subagent 直接爆内存

## Session 列表里消失

### [Issue #25920 — 首条 user > 15KB 让 session "找不到"](https://github.com/anthropics/claude-code/issues/25920)

Session metadata 解析器硬编码只读文件前 16KB，首条非 system user message >15KB 时 firstPrompt 取不到,session 过滤器返回
null,session picker 和 `--resume <uuid>` 都找不到
**Workaround**:在 jsonl 尾部注入 custom-title:

```json
{"type":"custom-title","customTitle":"My Title","sessionId":"<uuid>"}
```

CC 从文件尾部回读,绕过 head-read bug，`scripts/truncate.py` 每次截断都会自动追加这条

### [Issue #39667 — session jsonl 被静默删除 + sessions-index.json 不更新](https://github.com/anthropics/claude-code/issues/39667)

## Context 相关

### [Issue #14472 — resume 时 context 超限无法加载](https://github.com/anthropics/claude-code/issues/14472)

Session 大到超模型上下文,resume 立即 "Prompt is too long" 失败,无法先 /compact 再加载

### [Issue #50732 — /context 显示矛盾:header 76% 但 Messages 138%](https://github.com/anthropics/claude-code/issues/50732)

### [Issue #22178 — saved_hook_context 条目 UUID 重复破坏 session graph](https://github.com/anthropics/claude-code/issues/22178)

### [Issue #50223 — Advisor tool result 无法处理](https://github.com/anthropics/claude-code/issues/50223)

## 其他

### [Issue #22566 衍生 — 持续 cd 后 assistant 响应不落盘](https://github.com/anthropics/claude-code/issues/22566)

## 社区修复工具

### [mason0510/fix-jsonl](https://github.com/mason0510/fix-jsonl)

命令行工具,清除 thinking 内容、修复被截断的 JSON，定位更偏"瘦身",和本 skill 的"修复 resume 错位"互补
