# skill-elenchus

面向 Claude Code 的代码、快照与方案评审，确定范围，用有辨别力的反例检验判断，交付结论与可核对证据

名称来自 **Elenchus**（ἔλεγχος），苏格拉底的质疑与反驳方法

## 使用

```text
/elenchus
/elenchus src/core/session.ts
/elenchus mode=full .
/elenchus mode=full src/core/session.ts
/elenchus mode=design 评估这个缓存方案
```

- **改动**
    - 选择：`mode=diff` 或普通文件/目录路径
    - 行为：评审指定差异及相关调用链

- **快照**
    - 选择：`mode=full`、整个文件或完整仓库
    - 行为：枚举并读取快照，空 diff 仍执行

- **方案**
    - 选择：`mode=design` 或设计问题
    - 行为：核对目标、约束、证据及有意义的取舍

无参数保留暂存差异优先，否则使用
`git diff HEAD`，空 diff 结束前检查范围内未跟踪源码，full 分别记录 reviewed、pending 与 excluded，文件清单不代替完整审计

## 深度与成本

L0 处理明确路径，L1 由主线程处理有意义的取舍，L2 用于需要独立证据的范围或高影响争议

默认 L1 最多四轮、不派 agent，默认 L2 最多四个初审者与两个定向验证者，总计六个、深度一，整次时间预算三十分钟，上层更小限额优先，达到边界时保留未完成项

[入口规则](SKILL.md)
定义完整时间、轮次与 token 预算，初审与验证共用总预算，finding 不自动产生仲裁者，等待采用 Host 完成通知，不重复轮询

## 证据与结果

- **`runtime_verified`**
    - 已支持的结论：实际执行了记录中的输入与命令
    - 保留范围：写明替身、原生组件和复用运行

- **`source_verified`**
    - 已支持的结论：源码与入口到效果的调用链支持问题
    - 保留范围：保留未执行的平台效果

- **`needs_validation`**
    - 已支持的结论：缺少决定性证据
    - 保留范围：写明缺少条件及其对决定的影响

裁定与严重度单独记录，部分确认保留已证实错误及限定前提，票数、函数长度和参数数量不替代行为证据

默认输出结论、证据、必要取舍和剩余项，评审不自动授权修改或发布，[共享合同](prompts/shared-rules.md)
定义稳定编号、触发条件、验证与限制

授权允许的较长分析使用一个私有、唯一的 run 目录：

```text
<host-temp>/skill-elenchus/<project>/runs/<unique-run-id>/
├── coverage.json
├── findings.json
├── review-<scope>.md
├── verify-<id>.md
└── report.md
```

仅创建实际使用的记录，简短串行分析可以直接返回结果

## 安装

将模块链接到用户 Skill 目录：

```bash
ln -s /path/to/skill-elenchus ~/.claude/skills/elenchus
```

也支持独立副本：

```bash
cp -r skill-elenchus/ ~/.claude/skills/elenchus/
```

新安装选择尚未使用的目标目录，默认入口为中文；英文安装使用独立副本，将副本内的 `SKILL-en.md` 作为
`SKILL.md`，保留仓库原文件，避免通过源码链接重命名维护文件

## 维护

- **`SKILL.md` / `SKILL-en.md`**
    - 职责：范围、深度、预算与交付
    - 验证：两种语言行为和预算一致

- **`prompts/elenchus.md` / `elenchus-en.md`**
    - 职责：串行分析
    - 验证：结论优先与共同停止条件

- **`prompts/shared-rules.md`**
    - 职责：发现与证据合同
    - 验证：所有专家引用共同合同

- **`prompts/expert-*.md`**
    - 职责：定向审查范围
    - 验证：启发式判断对应实际后果

- **[examples/sample-output.md](examples/sample-output.md)**
    - 职责：结果及范围反例
    - 验证：区分实际运行与源码支持

在仓库根目录执行文档合同检查：

```bash
node --test skill-elenchus/examples/contract.test.mjs
```

检查覆盖引用、双语预算和证据字段，实际评审覆盖及问题结论仍由每次分析的源码与运行证据确定

## 致谢

- [Socrates.SKILL](https://github.com/MoYeRanqianzhi/Socrates.SKILL) — 苏格拉底诘问法 AI agent 方法论
- [spec_driven_develop](https://github.com/zhu1090093659/spec_driven_develop) — S.U.P.E.R 架构设计原则
- [Superpowers](https://github.com/obra/superpowers) — Codex agent 设计模式

## 许可证

MIT
