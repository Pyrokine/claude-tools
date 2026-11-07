---
name: cc-session-fix
description: >-
  修复 Claude Code session jsonl 问题 — /resume 失败、resume 后上下文错位、jsonl 过大、resume cancelled、/compact 报 Invalid signature in
  thinking block，诊断 uuid 链、compact_boundary、resume leaf 选择，安全截断并补 custom-title，当用户说 resume 失败、resume 恢复错位、jsonl
  太大、resume 卡住、compact 失败、thinking block 签名错误时使用
argument-hint: "[session-id or path]"
---

Claude Code session JSONL 诊断与修复工具，处理 `/resume` 失败、上下文错位、文件过大和 thinking 签名错误

## 脚本

- **[scripts/diagnose.py](scripts/diagnose.py)**：文件大小、物理行数、uuid 链、compact_boundary、resume
  leaf 推断和截断建议
- **[scripts/truncate.py](scripts/truncate.py)**：截到 N 行、删除 thinking
  block、追加 custom-title、验证最终 JSONL 和 uuid 链；`--new-session` 生成新 UUID，保留原文件
- `scripts/session_io.py` 为两个入口共享的标准库实现，无需安装依赖

## 典型流程

```bash
# 1. target 可以是文件路径、完整 session id 或前缀
python3 scripts/diagnose.py <session-id-or-path>

# 指定 project 后，完整 id 和前缀查询都只在该项目中进行
python3 scripts/diagnose.py <session-id-prefix> --project <project-hash>

# 2. 如输出 Recommend: truncate to L<N>，预览保留与删除范围
python3 scripts/truncate.py <target> --line <N> --title "..." --dry-run

# 3. 停止所有向该会话写入的 Claude Code 进程后，原地修复
python3 scripts/truncate.py <target> --line <N> --title "..."

# 活跃会话或需要保留原文件用于 MCP 历史检索时，生成新 UUID 文件
python3 scripts/truncate.py <target> --line <N> --new-session --title "..."
```

显式文件路径优先于 id 查询；多个候选会报错，请改用完整 id 或路径

## 使用场景

1. **`/resume` 失败或 Cancelled**：查看文件大小和 uuid 链，>100MB 时检查大小问题，dangling
   parentUuid >0 表示链存在外部引用
2. **resume 恢复到错误历史点**：比较 `Resume leaf` 和 `Dialog tail`；链有效且无分支歧义、截断范围保留完整父链和后写入对话时，非对话
   leaf 晚超过 5 分钟才建议截到 dialog tail
   对话按实际时刻比较，同刻选择物理位置较后的记录，UUID 环、重复 UUID、混合时区或时间回退会提示复核
   候选检查覆盖所有有效物理行：后写入的对话缺少时间戳时停止建议，没有 UUID 的保留行也检查父引用，报告实际相关行号；普通无时间戳
   system 元数据仍合法
3. **session 从列表消失**：[Issue #25920](https://github.com/anthropics/claude-code/issues/25920) 的首条 user >15KB
   head-read 问题可通过末尾 custom-title 处理
4. **文件太大或打开慢**：约 1 万行是经验参考，保留范围仍由诊断和实际需要决定
5. **`/compact` 报
   `Invalid signature in thinking block`**：CPA 等代理将 GPT 接入 CC 时会出现空签名；oneapi/Bedrock 代理在生成与校验使用不同
   API
   key 时会出现无效签名

    删除所有 thinking block，保留 text、tool_use、tool_result 和其他记录字段，仅清理 thinking 时保留已有标题，显式
    `--title` 才会追加新标题，使用同一 CLI 预览和写入

    ```bash
    python3 scripts/truncate.py <target> --strip-thinking --dry-run
    # 停止所有写者后原地修复，或加 --new-session 保留原文件
    python3 scripts/truncate.py <target> --strip-thinking
    python3 scripts/truncate.py <target> --strip-thinking --new-session
    ```

## 安全与恢复

- 原地修复保留唯一的 `.bak.<随机标识>` 备份；POSIX 备份是原 inode 的独占硬链接，Windows 使用
  `ReplaceFileW`，备份位于同名私有目录内
- 读取及提交前检查源文件身份和变化，检测到变化就拒绝覆盖；停止写者仍是原地修复的前提，最后检查窗口内向旧 inode 的追加可在备份中恢复
- 缺少安全原地发布原语时会报错，改用
  `--new-session`；该入口独占创建新目标，写入失败时原文件保留，错误和私有失败文件位置会明确输出
- 原地操作后按输出的 `Backup` 路径检查原记录；恢复前停止所有写者，确认备份内容后恢复目标路径
- 新文件、暂存文件和失败文件按私有权限创建，POSIX 为 `0600`，Windows 使用受保护的当前账户/SYSTEM
  DACL；备份保留原文件的访问控制
- 显式读取和写入 UTF-8，坏字节带物理行号报错，原文件保留；诊断继续检查后续行
- 诊断报告坏 JSON、非对象记录和错误字段类型；修复会列出 retained/removed 范围，保留范围内包含这些无效记录时拒绝写入，选中删除的异常尾行会明确提示
- UUID 环和重复记录令 health=needs_review，显式 --line 写入前提示保留范围的链异常；最终输出逐物理行验证并保留 LF 分隔
- 缺少 leaf 或 dialog anchor 且未发现其他异常时显示 unknown，无截断建议不等于健康
- `--dry-run` 不创建会话、备份或暂存文件

## 参考与回归

- [references/mechanism.md](references/mechanism.md)：JSONL 结构、`/compact` 行为与 leaf 推断
- [references/known-issues.md](references/known-issues.md)：相关 GitHub issue
- [TESTING.md](TESTING.md)：仅使用隔离 HOME 和合成会话的回归用例
