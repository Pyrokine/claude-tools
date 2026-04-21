# skill-elenchus

面向 Claude Code 的辩证分析方法论。多视角质疑、交叉对质、第一性原理还原。一个工具，一套哲学——自然适配代码评审、深度思辨、设计分析。

命名来自 **Elenchus**（ἔλεγχος）——苏格拉底的质疑反驳法。

## 核心理念

无论输入是什么，分析都遵循相同的原则：

1. **多视角独立分析** — 多个专家从不同角度审视
2. **交叉质疑** — 每个视角被其他人挑战
3. **争议对质** — 有争议的点通过仲裁直到收敛
4. **第一性原理还原** — 剥离权威和惯例，从不可再分的事实重建

## 架构

```
/elenchus <输入> → 理解意图 → 自然适配

代码变更 / 设计方案：
  ┌─────────────────────────────────────────────────┐
  │ 5 个专家并行分析（2 opus + 3 sonnet）            │
  │ → 5 个交叉质疑者挑战发现                          │
  │ → 争议对质循环（opus 仲裁）                       │
  │ → 综合报告                                       │
  └─────────────────────────────────────────────────┘

抽象问题 / 决策：
  ┌─────────────────────────────────────────────────┐
  │ 辩证循环：                                       │
  │   正题 → 反题（苏格拉底诘问）                     │
  │       → 合题（第一性原理 + 奥卡姆剃刀）           │
  │ Mutation Guard 防止循环论证                       │
  │ 持续到用户中断或达到认知边界                       │
  └─────────────────────────────────────────────────┘
```

## 安装

### 符号链接（推荐，随仓库自动更新）

```bash
ln -s /path/to/skill-elenchus ~/.claude/skills/elenchus
```

### 复制

```bash
cp -r skill-elenchus/ ~/.claude/skills/elenchus/
```

### 切换英文版

默认入口 `SKILL.md` 为中文版。切换英文版：

```bash
cd ~/.claude/skills/elenchus
mv SKILL.md SKILL-zh.md
mv SKILL-en.md SKILL.md
```

## 使用

```bash
# 代码评审（自动检测当前改动）
/elenchus

# 评审指定文件
/elenchus src/core/session.ts

# 深度思辨
/elenchus 从第一性原理看，这个微服务拆分合理吗？

# 设计分析
/elenchus 多角度评估下这个缓存架构方案
```

不需要选择模式——工具理解你的意图并自动适配。

## 输出

每次运行创建带时间戳的目录：

```
/tmp/skill-elenchus/<项目名>/runs/<YYYYMMDD_HHMMSS>/
├── expert-logic.md        # 专家发现
├── expert-security.md
├── expert-design.md
├── expert-perf.md
├── expert-convention.md
├── cross-review.md        # 交叉质疑结果
├── disputes.md            # 争议对质记录
└── report.md              # 最终综合报告
```

## 自定义

编辑 `prompts/` 中的文件：

| 文件                               | 用途              |
|----------------------------------|-----------------|
| `elenchus.md` / `elenchus-en.md` | 辩证循环规则          |
| `shared-rules.md`                | 共享审查纪律          |
| `expert-logic.md`                | 逻辑与正确性（opus）    |
| `expert-security.md`             | 安全与健壮性（opus）    |
| `expert-design.md`               | 架构与代码质量（sonnet） |
| `expert-perf.md`                 | 性能与资源管理（sonnet） |
| `expert-convention.md`           | 项目规范合规（sonnet）  |

## 致谢

- [Socrates.SKILL](https://github.com/MoYeRanqianzhi/Socrates.SKILL) — 苏格拉底诘问法 AI agent 方法论
- [spec_driven_develop](https://github.com/zhu1090093659/spec_driven_develop) — S.U.P.E.R 架构设计原则
- [Superpowers](https://github.com/obra/superpowers) — Codex agent 设计模式

## 许可证

MIT
