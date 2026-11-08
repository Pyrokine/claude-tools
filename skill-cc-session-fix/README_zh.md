# skill-cc-session-fix

Claude Code session JSONL 的诊断与修复工具箱，修 `/resume` 失败、恢复上下文错位、文件过大等问题

## 为什么需要

Claude Code 把每次会话存成 `~/.claude/projects/<hash>/<uuid>.jsonl`，长期使用的 session 会积累:

- `/compact` 边界 — **打破时间戳单调性**(CC 会在边界之后以更早的时间戳回放摘要消息)
- 失败的 `/resume` 尝试 — 在文件尾部追加 `system` 消息,其 parentUuid 附着在老的 leaf 上
- 大 tool_result (单行 >500KB) — **卡死 resume 反序列化**
- 首条 user 消息 >15KB — session **从列表里消失**
  ([Issue #25920](https://github.com/anthropics/claude-code/issues/25920))

观察结论:**CC 选择 resume 锚点时是从文件物理末尾反向扫描,不是按时间戳**，所以文件布局决定了 `/resume`
恢复到哪里 —— 不是" 最新的对话" 本 skill 提供两个脚本安全诊断和修复这种布局问题

## 安装

### 软链 (推荐,随 repo 自动更新)

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
Input issue : L10003: 144 UUID leaves; review branches before selecting a truncation line

UUID chain  : 4,790 uuids, 0 dangling parentUuid, 144 leaf

Dialog tail : L6318 2026-04-23T13:55:43

Compact     : 21 boundary marker(s) at L[682, 1064, 1346, 1763, 2454]...
              CC replays history after boundary — post-boundary rows may have out-of-order timestamps

Resume leaf : L10003 2026-04-23T15:03:14 system uuid=d6e525ee
              preview: [system:local_command]
              ↑ this is the leaf CC will anchor /resume to

Health      : needs review — no heuristic truncation recommendation; inspect leaf, chain and input issues
```

### 截断

```bash
scripts/truncate.py <target> --line <N> --title "..." --dry-run    # 预览
scripts/truncate.py <target> --line <N> --title "..."              # 原地,自动备份
scripts/truncate.py <target> --line <N> --title "..." --new-session # 分叉到新 UUID
```

原地修复前停止所有向该会话写入的进程，活跃会话使用
`--new-session`，保留原路径的内容，读取或准备期间检测到变化会拒绝发布，请重新诊断后重试
Windows 独立检查文件描述符的 ctime，路径与描述符采用不同时间语义时，稳定文件仍可处理；文件身份、大小、修改时间和模式继续检查

- 每次原地修复保留唯一的 `.bak.<随机标识>` 备份，输出中以 `Backup` 标明路径
- POSIX 在原子替换前独占建立指向原 inode 的硬链接；最后检查窗口内通过旧文件描述符追加的数据仍可从备份恢复
- Windows 使用 `ReplaceFileW`，原文件备份存放在独占建立的私有目录中
- 缺少安全原地发布原语时使用 `--new-session`，它独占创建新目标，无需硬链接
- 末尾追加 `{"type":"custom-title", ...}`，每条物理记录使用 LF 分隔，原末行缺少 LF 时也会正确处理
- `--new-session` 改写已有 `sessionId` 字段，写入前报告 uuid 链完整性

`--project`
将完整 id 和前缀查询都限定在该项目，显式存在的文件路径仍然优先，多候选 id 会报错，按项目查询 id 时会排除指向其他项目的文件软链

### 删除 thinking block

`/compact` 报 `Invalid signature in thinking block` 时，删除全部 thinking
block，包括签名非空但无效的记录，保留文本、工具调用、工具结果及未知字段

```bash
python3 scripts/truncate.py <target> --strip-thinking --dry-run
# 原地修复前停止所有写者
python3 scripts/truncate.py <target> --strip-thinking
# 或保留原文件，创建新 UUID 文件
python3 scripts/truncate.py <target> --strip-thinking --new-session
```

`--strip-thinking` 可与 `--line`、`--project`、`--title`、`--new-session` 配合，仅清理 thinking 时保留已有标题，显式指定
`--title` 才会追加新标题，校验、备份和发布与截断使用同一实现

### 输入、权限与恢复

JSONL 按 UTF-8 读写，不依赖 locale，诊断会报告坏 JSON、异常记录形状、错误字段类型和坏字节的物理行号，并继续检查后续记录，
`--json`
保留原诊断字段，增加 `issues` 和 `health`
重复 UUID 与 parent 环会报告物理行号并令 `health=needs_review`，带有 leaf 的环也会识别；缺少锚点且未发现其他异常时为
`unknown`

对话时间戳按解析后的实际时刻比较，同刻选择物理位置较后的对话，保留原始时间文本，resume leaf 继续按物理顺序推断
自动截断要求链有效且无歧义，非对话尾部晚于候选对话超过五分钟；多 leaf、混合时区类型、后写入对话的时间回退或候选范围之外的父节点均提示复核
候选检查覆盖所有有效物理行，后写入的对话即使 timestamp 缺失、为 null 或空字符串，也会停止建议；没有 UUID 的保留行同样检查
parentUuid，提示该行与候选范围外父节点的行号，普通无时间戳 system 元数据仍合法
显式 `--line` 仍可执行，写入前会提示保留范围内的环和重复 UUID

修复会列出 retained/removed 范围和异常记录数，保留范围包含无效
JSON、记录形状或字段类型时拒绝发布，明确选中删除的异常尾行会逐行提示，原始数据仍在备份或原文件中，任何位置出现无效 UTF-8
都会拒绝修复，未知字段会保留，`--dry-run`
不创建会话、备份或暂存文件

新文件、暂存文件和失败文件从创建时就使用私有权限，POSIX 为 `0600`，Windows 为受保护的当前账户/SYSTEM
DACL，原地备份保留原文件的访问控制，发布失败会报告私有暂存文件及已有恢复路径，重试前先检查这些文件，新会话已写入但暂存清理失败时，命令保留成功结果并报告清理警告，恢复时停止写者，检查输出中的
`Backup` 文件并确认内容后，再恢复会话路径

诊断仅保存链索引，按需读取最终 leaf 的预览，截断将选定行流式写入私有暂存文件，逐物理行验证最终 JSONL 后发布，避免所有消息正文同时驻留内存

## 回归测试

需要 Python 3.8 或更新版本，测试只使用隔离 HOME 下的合成 JSONL，在 Windows 上会执行原生 DACL 和文件替换用例

```bash
python3 -I -B scripts/test_session_fix.py -v
ruff check --no-cache --target-version py38 scripts/
```

可复用用例和平台前置条件见 [TESTING.md](TESTING.md)

## 常见场景

- `Resume cancelled`：看文件大小;>100MB 就截到 1 万行左右

- resume 恢复到错误历史点：有建议时使用建议行号；手工选择 `--line` 前检查链与分支提示

- session 不在列表里：[Issue #25920](https://github.com/anthropics/claude-code/issues/25920);truncate 会自动补 custom-title

- 想保留原文件给 MCP 历史检索：用 `--new-session` 分叉到新 UUID

- Dangling parentUuid：diagnose 报数量;可能需要手改首行 parentUuid 为 `null`

## 涵盖的 Issue

完整清单见 [references/known-issues.md](references/known-issues.md)，重点:

- [#22566](https://github.com/anthropics/claude-code/issues/22566) — 标准截断恢复模式
- [#22526](https://github.com/anthropics/claude-code/issues/22526) — phantom parentUuid
- [#25920](https://github.com/anthropics/claude-code/issues/25920) — 首条 >15KB 的 head-read bug
- [#21067](https://github.com/anthropics/claude-code/issues/21067) — 大 tool_result 卡死 resume
- [#36583](https://github.com/anthropics/claude-code/issues/36583) — file-history-snapshot uuid 碰撞

## 机制

行为模型见 [references/mechanism.md](references/mechanism.md):

- jsonl 行号 ≠ 时间戳顺序 (/compact 会重写历史)
- CC 选 `/resume` 锚点按 **文件物理末尾**,不按时间戳
- custom-title 末尾注入的规则

## 致谢

- [mason0510/fix-jsonl](https://github.com/mason0510/fix-jsonl) — JSONL 瘦身 (聚焦点不同,互补)
- 相关 issue 下的社区 workaround 模式

## License

MIT — 见 [LICENSE](LICENSE)
