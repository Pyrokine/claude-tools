# skill-cc-session-fix

Claude Code session JSONL 的诊断与修复工具箱，修 `/resume` 失败、恢复上下文错位、文件过大等问题

## 为什么需要

Claude Code 把每次会话存成 `~/.claude/projects/<hash>/<uuid>.jsonl`，长期使用的 session 会积累:

- `/compact` 边界 — **打破时间戳单调性**(CC 会在边界之后以更早的时间戳回放摘要消息)
- 失败的 `/resume` 尝试 — 在文件尾部追加 `system` 消息,其 parentUuid 附着在老的 leaf 上
- 大 tool_result(单行 >500KB) — **卡死 resume 反序列化**
- 首条 user 消息 >15KB — session **从列表里消失
  **([Issue #25920](https://github.com/anthropics/claude-code/issues/25920))

观察结论:**CC 选择 resume 锚点时是从文件物理末尾反向扫描,不是按时间戳**，所以文件布局决定了 `/resume` 恢复到哪里 —— 不是"
最新的对话"
本 skill 提供两个脚本安全诊断和修复这种布局问题

## 安装

### 软链(推荐,随 repo 自动更新)

```bash
ln -s /path/to/skill-cc-session-fix ~/.claude/skills/cc-session-fix
```

### 复制

```bash
cp -r skill-cc-session-fix/ ~/.claude/skills/cc-session-fix/
```

### 切换语言

默认 `SKILL.md` 是中文，切换英文:

```bash
cd ~/.claude/skills/cc-session-fix
mv SKILL.md SKILL-zh.md
mv SKILL-en.md SKILL.md
```

## 用法

### 诊断

```bash
scripts/diagnose.py <session-id-前缀>     # 自动在 ~/.claude/projects 下找
scripts/diagnose.py /path/to/file.jsonl
scripts/diagnose.py <id> --project <project-hash>
scripts/diagnose.py <target> --json       # 机器可读
```

输出示例:

```
File        : ~/.claude/projects/.../677538d9-....jsonl
Size        : 36,901,996 bytes (35.2 MB)
Lines       : 10,009 total, 10,009 parsed

UUID chain  : 4,790 uuids, 0 dangling parentUuid, 144 leaf

Dialog tail : L6318 2026-04-23T13:55:43

Compact     : 21 boundary marker(s) at L[682, 1064, 1346, 1763, 2454]...
              CC replays history after boundary — post-boundary rows may have out-of-order timestamps

Resume leaf : L10003 2026-04-23T15:03:14 system uuid=d6e525ee
              preview: [system:local_command]
              ↑ this is the leaf CC will anchor /resume to

Recommend   : truncate to L6318
              reason: tail leaf is a system message 68min after last dialog turn
              command: truncate.py <jsonl> --line 6318 [--title 'your-title']
```

### 截断

```bash
scripts/truncate.py <target> --line <N> --title "..." --dry-run    # 预览
scripts/truncate.py <target> --line <N> --title "..."              # 原地,自动备份
scripts/truncate.py <target> --line <N> --title "..." --new-session # 分叉到新 UUID
```

- 原地覆盖前自动写 `.bak.<YYYYMMDDHHMMSS>` 备份
- 末尾追加 `{"type":"custom-title", ...}`(Issue #25920 workaround)
- 可选改写所有行的 `sessionId`(`--new-session`)
- 提交前验证 uuid 链完整性

## 常见场景

| 症状                  | 修复                                                                                                |
|---------------------|---------------------------------------------------------------------------------------------------|
| `Resume cancelled`  | 看文件大小;>100MB 就截到 1 万行左右                                                                           |
| resume 恢复到错误历史点     | diagnose 显示 `Resume leaf` 偏离 `Dialog tail` → 截到 dialog tail                                       |
| session 不在列表里       | [Issue #25920](https://github.com/anthropics/claude-code/issues/25920);truncate 会自动补 custom-title |
| 想保留原文件给 MCP 历史检索    | 用 `--new-session` 分叉到新 UUID                                                                       |
| Dangling parentUuid | diagnose 报数量;可能需要手改首行 parentUuid 为 `null`                                                         |

## 涵盖的 Issue

完整清单见 [references/known-issues.md](references/known-issues.md)，重点:

- [#22566](https://github.com/anthropics/claude-code/issues/22566) — 标准截断恢复模式
- [#22526](https://github.com/anthropics/claude-code/issues/22526) — phantom parentUuid
- [#25920](https://github.com/anthropics/claude-code/issues/25920) — 首条 >15KB 的 head-read bug
- [#21067](https://github.com/anthropics/claude-code/issues/21067) — 大 tool_result 卡死 resume
- [#36583](https://github.com/anthropics/claude-code/issues/36583) — file-history-snapshot uuid 碰撞

## 机制

行为模型见 [references/mechanism.md](references/mechanism.md):

- jsonl 行号 ≠ 时间戳顺序(/compact 会重写历史)
- CC 选 `/resume` 锚点按**文件物理末尾**,不按时间戳
- custom-title 末尾注入的规则

## 致谢

- [mason0510/fix-jsonl](https://github.com/mason0510/fix-jsonl) — JSONL 瘦身(聚焦点不同,互补)
- 相关 issue 下的社区 workaround 模式

## License

MIT — 见 [LICENSE](LICENSE)
