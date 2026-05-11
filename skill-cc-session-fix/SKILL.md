---
name: cc-session-fix
description: 修复 Claude Code session jsonl 问题 — /resume 失败、resume 后上下文错位、jsonl 过大、resume cancelled、/compact 报 Invalid signature in thinking block，诊断 uuid 链、compact_boundary、resume leaf 选择，安全截断并补 custom-title，当用户说 resume 失败、resume 恢复错位、jsonl 太大、resume 卡住、compact 失败、thinking block 签名错误时使用
argument-hint: "[session-id or path]"
---

Claude Code session jsonl 诊断与修复工具，处理 /resume 失败、上下文错位、文件过大等问题

## 脚本

- **[scripts/diagnose.py](scripts/diagnose.py)** — 诊断 jsonl:文件大小、行数、uuid 链完整性、compact_boundary 位置、resume
  leaf 推断、截断建议
- **[scripts/truncate.py](scripts/truncate.py)** — 安全截断:自动备份、截到 N 行、补 custom-title、验证 uuid 链;支持
  `--new-session` 生成新 UUID 保留原文件

## 典型流程

```bash
# 1. 诊断，target 可以是完整路径或 session-id 前缀(自动在 ~/.claude/projects/ 下找)
scripts/diagnose.py <session-id-or-path>

# 2. 如输出 "Recommend: truncate to L<N>",先 dry-run 预览
scripts/truncate.py <target> --line <N> --title "..." --dry-run

# 3. 确认无误后正式执行(会自动备份 .bak.<时间戳>)
scripts/truncate.py <target> --line <N> --title "..."

# 可选:保留原文件(例如用于 MCP 历史检索),生成新 UUID 到新文件
scripts/truncate.py <target> --line <N> --new-session --title "..."
```

## 使用场景

1. **/resume 失败 / Cancelled** — diagnose 看文件大小和 uuid 链，>100MB 可能就是大小问题;dangling parentUuid >0 是链断裂问题
2. **resume 恢复到错的历史点** — diagnose 看 `Resume leaf` 是否比 `Dialog tail` 晚但是 system 类型，是 → 截断到 dialog
   tail
3. **session 列表里消失** — 可能是 [Issue #25920](https://github.com/anthropics/claude-code/issues/25920) 首条 user >
   15KB 触发 head-read bug，truncate 会自动补 custom-title 绕过
4. **文件太大打开慢** — 截断到最近 1 万行以内(经验上限,更多会再触发 /compact)
5. **/compact 报 `Invalid signature in thinking block`** — 用 CPA 等代理将 GPT 接入 CC 后切回 Claude，GPT 返回的
   thinking block 里 `signature` 字段为空字符串，Claude API 校验失败。修复：扫描 jsonl 删除所有 `signature == ""` 的
   thinking block，其余内容保留。

   ```python
   # 快速修复脚本（先备份）
   import json
   path = 'your-session.jsonl'
   out = path + '.fixed'
   removed = 0
   with open(path) as fin, open(out, 'w') as fout:
       for line in fin:
           s = line.strip()
           if not s:
               fout.write(line); continue
           try:
               obj = json.loads(s)
               content = obj.get('message', {}).get('content', [])
               if isinstance(content, list):
                   new_c = [b for b in content
                            if not (isinstance(b, dict)
                                    and b.get('type') == 'thinking'
                                    and not b.get('signature', ''))]
                   if len(new_c) != len(content):
                       removed += len(content) - len(new_c)
                       obj['message']['content'] = new_c
                       fout.write(json.dumps(obj, ensure_ascii=False) + '\n')
                       continue
           except Exception as e:
               print(f'warn: line parse error: {e}', flush=True)
           fout.write(line)
   print(f'removed {removed} empty-signature thinking blocks')
   # 验证后 mv out → path
   ```

## 细节参考

- [references/mechanism.md](references/mechanism.md) — jsonl 结构、/compact 行为、CC resume 选 leaf 的实际逻辑
- [references/known-issues.md](references/known-issues.md) — 相关 GitHub issue 清单

## 安全

- truncate.py 默认原地覆盖前会写 `.bak.<YYYYMMDDHHMMSS>` 备份
- `--dry-run` 先预览,不写任何文件
- 所有操作前都会验证 uuid 链,报告 dangling 数量
