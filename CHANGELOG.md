# Changelog

## v1.15.2 - 2026-07-07

## Versions

- mcp-chrome: 2.3.1 → 2.3.2
- mcp-claude-history: 1.8.1
- mcp-ssh: 2.3.1 → 2.3.2

## What's Changed

### mcp-chrome

- fix: Bound input wait events by the remaining input timeout and allow empty text in `type` events
- fix: Update key state only after successful `keyDown` dispatch
- fix: Include post-condition diagnostics, form values, and shared timeout budgeting in `evaluate` checks
- fix: Clear fallback console logs from both `console_get clear=true` and `console_clear`
- fix: Include the built Chrome Extension in the npm package and document npm/source installation
- docs: Update the documented Node requirement to 20.19 or newer

### mcp-ssh

- chore: Align the Node engine requirement with the current toolchain and refresh npm lockfile metadata
- docs: Update the documented Node requirement and npm/source installation commands

---

## 版本

- mcp-chrome: 2.3.1 → 2.3.2
- mcp-claude-history: 1.8.1
- mcp-ssh: 2.3.1 → 2.3.2

## 更新内容

### mcp-chrome

- fix: `input` 的 wait 事件受剩余 timeout 限制，并允许 `type` 事件传入空字符串
- fix: `keyDown` 发送成功后才更新按键状态
- fix: `evaluate` 的 post-condition 检查覆盖 diagnostics、表单值和共享超时预算
- fix: `console_get clear=true` 和 `console_clear` 都会清理 fallback console 日志
- fix: npm 包包含构建后的 Chrome Extension，并补充 npm 和源码安装说明
- docs: 更新文档中的 Node 要求到 20.19 或更新版本

### mcp-ssh

- chore: Node engine 要求与当前工具链保持一致，并刷新 npm lockfile 元数据
- docs: 更新 Node 要求和 npm / 源码安装命令

**Full Changelog**: https://github.com/Pyrokine/claude-tools/compare/v1.15.1...v1.15.2

## v1.15.1 - 2026-07-05

## Versions

- mcp-chrome: 2.3.0 → 2.3.1
- mcp-claude-history: 1.8.0 → 1.8.1
- mcp-ssh: 2.3.0 → 2.3.1

## What's Changed

### mcp-chrome

- fix: Keep zero-config local auto-connect while preserving optional pairing-token hardening
- fix: Reject unfiltered cookie reads in the Extension layer
- fix: Return idle timeout when DOM mutations do not become quiet, and keep screenshot fallback dimensions best-effort
- fix: Wait for Extension navigation to observe URL or title changes instead of returning on an already-complete page

### mcp-claude-history

- fix: Return MCP tool-level errors for business errors instead of success text
- fix: Reject symlink output targets and report JSONL read/parse warnings in context, trace, and search
- fix: Apply server and tool filters to payload-error search results through `tool_use_id` metadata

### mcp-ssh

- fix: Fail SFTP fallback syncs that request delete, and close SFTP channels on stat or read failures
- fix: Enforce byte-capped `lineRange` output without remote temp files and report UTF-8 byte counts for `writeFile`
- fix: Cover SSH channel open with command timeout, validate PTY buffer sizes, and honor `verifyOwner=0`

---

## 版本

- mcp-chrome: 2.3.0 → 2.3.1
- mcp-claude-history: 1.8.0 → 1.8.1
- mcp-ssh: 2.3.0 → 2.3.1

## 更新内容

### mcp-chrome

- fix: 保留零配置本地自动连接，同时保留可选 pairing-token 加固
- fix: Extension 层拒绝无过滤条件的 cookie 读取
- fix: DOM mutation 未达到静默条件时返回 idle 超时，截图 fallback 的尺寸信息改为 best-effort
- fix: Extension 导航等待以 URL 或标题变化为准，避免已完成页面提前返回

### mcp-claude-history

- fix: 业务错误改为 MCP tool-level error，不再包装成成功文本
- fix: 拒绝 symlink 输出目标，并在 context、trace 和 search 中报告 JSONL 读取或解析 warning
- fix: payload-error 搜索结果通过 `tool_use_id` 元数据应用 server 和 tool 过滤

### mcp-ssh

- fix: SFTP fallback 收到 delete 请求时返回失败，并在 stat 或 read 失败时关闭 SFTP channel
- fix: `lineRange` 不再创建远端临时文件，按字节限制输出，并让 `writeFile` 返回 UTF-8 字节数
- fix: command timeout 覆盖 SSH channel open，校验 PTY bufferSize，并正确处理 `verifyOwner=0`

**Full Changelog**: https://github.com/Pyrokine/claude-tools/compare/v1.15.0...v1.15.1

## v1.15.0 - 2026-07-04

## Versions

- mcp-chrome: 2.2.0 → 2.3.0
- mcp-claude-history: 1.7.0 → 1.8.0
- mcp-ssh: 2.2.0 → 2.3.0

## What's Changed

### mcp-chrome

- feat: Add `postCondition` to `input` and `evaluate` so callers can verify page state after actions
- fix: Return structured diagnostics for debugger conflicts, screenshot fallback limits, evaluate result limits, and
  window focus observation
- fix: Match network log `urlPattern` with deterministic wildcard matching to avoid extension worker stalls on long URLs
- docs: Update README and README_zh for post-condition, screenshot fallback, network URL filters, and focusWindow
  behavior

### mcp-claude-history

- feat: Add `tool_payload_errors` search filtering and `tool_result_has_error_payload` result metadata
- refactor: Share filtered export writing between context and trace output
- chore: Upgrade `rmcp` to 2.1.0 and refresh Rust dependencies
- docs: Update README and README_zh for payload-level tool error filtering

### mcp-ssh

- feat: Add empty-output failure diagnostics for silent non-zero command exits
- feat: Preserve per-host execution metadata in `ssh_exec_parallel`, with alias count, concurrency, and output-size
  limits
- feat: Add `ssh_sync` owner and mode verification for upload single-file syncs
- fix: Resolve SFTP upload targets when syncing a local file into a remote directory
- docs: Update README and README_zh for execution metadata and sync verification behavior

---

## 版本

- mcp-chrome: 2.2.0 → 2.3.0
- mcp-claude-history: 1.7.0 → 1.8.0
- mcp-ssh: 2.2.0 → 2.3.0

## 更新内容

### mcp-chrome

- feat: 为 `input` 和 `evaluate` 新增 `postCondition`，让调用方在动作后验证页面状态
- fix: 为 debugger 占用、截图 fallback 限制、evaluate 结果限制和窗口聚焦观测返回结构化诊断
- fix: network log `urlPattern` 改为确定性通配符匹配，避免超长 URL 导致扩展 worker 卡住
- docs: 更新 README 和 README_zh，覆盖 post-condition、截图 fallback、network URL 过滤和 focusWindow 行为

### mcp-claude-history

- feat: 新增 `tool_payload_errors` 搜索过滤和 `tool_result_has_error_payload` 结果元数据
- refactor: context 和 trace 输出复用过滤导出写入逻辑
- chore: 升级 `rmcp` 到 2.1.0，并刷新 Rust 依赖
- docs: 更新 README 和 README_zh，说明 payload 层工具错误过滤

### mcp-ssh

- feat: 为非零退出且无输出的远端命令新增 empty-output 失败诊断
- feat: `ssh_exec_parallel` 保留每台主机的执行元数据，并增加 alias 数量、并发数和输出大小限制
- feat: 为 `ssh_sync` upload 单文件同步新增 owner 和 mode 校验
- fix: local file 同步到远端目录时，正确解析 SFTP upload 目标文件路径
- docs: 更新 README 和 README_zh，说明执行元数据和同步校验行为

**Full Changelog**: https://github.com/Pyrokine/claude-tools/compare/v1.14.1...v1.15.0

## v1.14.1 - 2026-06-16

## Versions

- mcp-chrome: 2.2.0
- mcp-claude-history: 1.7.0
- mcp-ssh: 2.2.0

## What's Changed

### release workflow

- fix: Use the matching `CHANGELOG.md` section as the GitHub Release body for tag releases
- docs: Add repository-level changelog history from v1.0.0 through v1.14.1

---

## 版本

- mcp-chrome: 2.2.0
- mcp-claude-history: 1.7.0
- mcp-ssh: 2.2.0

## 更新内容

### release workflow

- fix: tag 发版时使用 `CHANGELOG.md` 中匹配版本的段落作为 GitHub Release 正文
- docs: 新增仓库级 changelog 历史，覆盖 v1.0.0 到 v1.14.1

**Full Changelog**: https://github.com/Pyrokine/claude-tools/compare/v1.14.0...v1.14.1

## v1.14.0 - 2026-06-15

## Versions

- mcp-chrome: 2.1.0 → 2.2.0
- mcp-claude-history: 1.6.0 → 1.7.0
- mcp-ssh: 2.1.0 → 2.2.0

## What's Changed

### mcp-chrome

- feat: Add optional pairing-token authentication while keeping zero-config local use as the default
- feat: Harden managed tab and window boundaries, including safer close, activate, focus, resize, and navigation
  behavior
- feat: Add controlled input, richer select/replace diagnostics, structured page state, frame metadata, clip
  screenshots, PNG comparison, and action diagnostics
- fix: Bound CDP evaluate materialization, auth challenge storage, Chrome launch cleanup, and MCP frame parsing
- docs: Update README, README_zh, and TESTING for the expanded browser automation behavior

### mcp-claude-history

- feat: Add stricter parameter validation, server/tool filters, summary and JSONL output modes, and richer
  pagination/export diagnostics
- fix: Create exported content and manifests with private permissions and cap streaming UUID dedupe state
- chore: Update Rust dependencies and bump package version
- docs: Update README, README_zh, and TESTING for search, export, and range behavior

### mcp-ssh

- feat: Add template/runAs/defaultEnv workflow, exec_script, maxOutputSize diagnostics, and command risk hints
- fix: Redact batch commands, bound output and SFTP traversal resources, make rsync async, and correct background-task
  detection
- docs: Update README, README_zh, and TESTING for execution, transfer, and diagnostic behavior

### workflow and skills

- chore: Update local workflow guidance and skill lint/compatibility fixes

---

## 版本

- mcp-chrome: 2.1.0 → 2.2.0
- mcp-claude-history: 1.6.0 → 1.7.0
- mcp-ssh: 2.1.0 → 2.2.0

## 更新内容

### mcp-chrome

- feat: 新增可选 pairing token 认证，同时默认保留零配置本地使用方式
- feat: 加固 managed tab 和 window 边界，包括 close、activate、focus、resize 和 navigation 行为
- feat: 新增 controlled input、更丰富的 select/replace 诊断、结构化页面状态、frame metadata、clip screenshot、PNG 对比和
  action diagnostics
- fix: 限制 CDP evaluate 结果展开、auth challenge 存储、Chrome 启动清理和 MCP frame 解析边界
- docs: 更新 README、README_zh 和 TESTING，覆盖扩展后的浏览器自动化行为

### mcp-claude-history

- feat: 新增更严格的参数校验、server/tool 过滤、summary 和 JSONL 输出，以及更完整的分页和导出诊断
- fix: 导出内容和 manifest 创建时使用私有权限，并限制 streaming UUID 去重状态规模
- chore: 更新 Rust 依赖并提升包版本
- docs: 更新 README、README_zh 和 TESTING，覆盖 search、export 和 range 行为

### mcp-ssh

- feat: 新增 template/runAs/defaultEnv 工作流、exec_script、maxOutputSize 诊断和命令风险提示
- fix: 脱敏 batch command，限制输出和 SFTP 遍历资源，rsync 改为异步执行，并修正 background-task 误判
- docs: 更新 README、README_zh 和 TESTING，覆盖执行、传输和诊断行为

### workflow and skills

- chore: 更新本地工作流说明和 skill lint/兼容性修复

**Full Changelog**: https://github.com/Pyrokine/claude-tools/compare/v1.13.0...v1.14.0

## v1.13.0 - 2026-06-15

## Versions

- mcp-chrome: 2.0.2 → 2.1.0
- mcp-claude-history: 1.5.0 → 1.6.0
- mcp-ssh: 2.0.2 → 2.1.0

## What's Changed

### mcp-chrome

- feat: Improve managed tab safety, page activation safeguards, and browser action diagnostics
- feat: Add richer input/select/replace/editor workflows with structured failure context
- feat: Add screenshot clip metadata and PNG comparison output for visual verification
- docs: Update README, README_zh, and TESTING for the expanded MCP tool behavior

### mcp-claude-history

- feat: Improve search filter validation, pagination semantics, summaries, and JSONL export diagnostics
- feat: Add trace support and clearer range/large-output diagnostics for history retrieval
- docs: Update README, README_zh, and TESTING for the expanded search workflows

### mcp-ssh

- feat: Add templates, runAs/defaultEnv support, exec script workflow, and clearer execution diagnostics
- feat: Improve upload/download/sync diagnostics and PTY/session handling
- docs: Update README, README_zh, and TESTING for the expanded SSH workflows

---

## 版本

- mcp-chrome: 2.0.2 → 2.1.0
- mcp-claude-history: 1.5.0 → 1.6.0
- mcp-ssh: 2.0.2 → 2.1.0

## 更新内容

### mcp-chrome

- feat: 改进 managed tab 安全、页面激活保护和浏览器动作诊断
- feat: 增强 input/select/replace/editor 工作流，并返回结构化失败上下文
- feat: 增加截图裁剪元数据和 PNG 对比输出，便于视觉验证
- docs: 更新 README、README_zh 和 TESTING，覆盖扩展后的 MCP 工具行为

### mcp-claude-history

- feat: 改进搜索过滤校验、分页语义、摘要和 JSONL 导出诊断
- feat: 增加 trace 支持，并改进 history 获取的 range 和大输出诊断
- docs: 更新 README、README_zh 和 TESTING，覆盖扩展后的搜索工作流

### mcp-ssh

- feat: 增加 template、runAs/defaultEnv、exec script 工作流和更清晰的执行诊断
- feat: 改进 upload/download/sync 诊断和 PTY/session 处理
- docs: 更新 README、README_zh 和 TESTING，覆盖扩展后的 SSH 工作流

**Full Changelog**: https://github.com/Pyrokine/claude-tools/compare/v1.12.3...v1.13.0

## v1.12.3 - 2026-05-11

## Versions

- mcp-claude-history: 1.4.0 → 1.5.0
- mcp-chrome: 2.0.2 (no version bump, path routing already published)
- mcp-ssh: 2.0.2 (no change)

## What's Changed

### mcp-claude-history

- feat: output path routing — relative paths default to system temp (`<tmp>/claude-tools/mcp-claude-history/`), `cwd:`
  prefix writes to cwd, `tmp:` prefix explicit temp
- chore: Rust edition 2021 → 2024
- chore: rmcp 0.7 → 1.6 (builder API, MCP protocol version → 2025-11-25)
- chore: schemars 0.9 → 1.2, regex 1.10 → 1.12, rayon 1.10 → 1.12, clap 4.5 → 4.6
- chore: add rustfmt.toml (edition=2024, max_width=120)

### mcp-chrome

- feat: output path routing — same `tmp:`/`cwd:` prefix semantics for `output`/`scriptFile` params

---

## 版本

- mcp-claude-history: 1.4.0 → 1.5.0
- mcp-chrome: 2.0.2（无版本变更，路径路由已随上版发布）
- mcp-ssh: 2.0.2（无变更）

## 更新内容

### mcp-claude-history

- feat: 输出路径路由 — 相对路径默认写入系统临时目录，`cwd:` 前缀写当前目录，`tmp:` 前缀显式临时目录
- chore: Rust edition 2021 → 2024
- chore: rmcp 0.7 → 1.6（builder API，MCP 协议版本升至 2025-11-25）
- chore: schemars / regex / rayon / clap 依赖升级
- chore: 新增 rustfmt.toml（edition=2024, max_width=120）

### mcp-chrome

- feat: 相同的 tmp:/cwd: 路径路由语义，适用于 output/scriptFile 参数

**Full Changelog**: https://github.com/Pyrokine/claude-tools/compare/v1.12.2...v1.12.3

## v1.12.2 - 2026-05-10

## Versions

- mcp-claude-history: 1.4.0
- mcp-chrome: 2.0.1 → 2.0.2
- mcp-ssh: 2.0.1 → 2.0.2

## What's Changed

### mcp-chrome

- fix: keep browser operations bound to the intended session instead of drifting to the active tab
- fix: move relative `output` and `scriptFile` paths into a controlled system temp directory, with explicit `cwd:` paths
  for repo persistence
- docs: update README and TESTING guidance for the new path semantics

### mcp-claude-history

- fix: align `history_get --output` with the same controlled temp directory policy and explicit `cwd:` prefix behavior
- docs: update README and TESTING guidance for temp-first export paths

### mcp-ssh

- chore: publish 2.0.2 so the current release train stays version-aligned with mcp-chrome

---

## 版本

- mcp-claude-history: 1.4.0
- mcp-chrome: 2.0.1 → 2.0.2
- mcp-ssh: 2.0.1 → 2.0.2

## 更新内容

### mcp-chrome

- fix: 浏览器操作继续绑定到当前会话，不再漂移到用户活动 tab
- fix: 相对 `output` 和 `scriptFile` 路径默认写入受控系统临时目录，仓库内持久化改用显式 `cwd:`
- docs: 同步更新 README 和 TESTING 中的新路径语义

### mcp-claude-history

- fix: `history_get --output` 对齐同样的受控临时目录策略和显式 `cwd:` 前缀行为
- docs: 同步更新 README 和 TESTING 中的 temp-first 导出说明

### mcp-ssh

- chore: 发布 2.0.2，和这次 mcp-chrome 发版保持版本节奏一致

**Full Changelog**: https://github.com/Pyrokine/claude-tools/compare/v1.12.1...v1.12.2

## v1.12.1 - 2026-05-08

## Versions

- mcp-claude-history: 1.4.0
- mcp-chrome: 2.0.1
- mcp-ssh: 2.0.1

## What's Changed

### mcp-claude-history

- fix: Guard Unix-only permission calls in cross-platform builds

---

## 版本

- mcp-claude-history: 1.4.0
- mcp-chrome: 2.0.1
- mcp-ssh: 2.0.1

## 更新内容

### mcp-claude-history

- fix: 保护 Unix-only 权限调用，修复跨平台构建问题

**Full Changelog**: https://github.com/Pyrokine/claude-tools/compare/v1.12.0...v1.12.1

## v1.12.0 - 2026-05-08

## Versions

- mcp-claude-history: 1.4.0
- mcp-chrome: 2.0.0 → 2.0.1
- mcp-ssh: 2.0.0 → 2.0.1

## What's Changed

### mcp-chrome

- fix: restore extension bridge tab tracking after open/navigate so follow-up actions no longer send null tab ids
- fix: harden input, touch, keyboard modifier, commands focus, and stealth injection paths in extension mode
- chore: remove dead helpers and clear all remaining overlong lines in touched files

### mcp-ssh

- fix: stop exposing env in session metadata and fully clean idle forward / PTY state
- chore: remove unused idle sweeper stop helpers

### mcp-claude-history

- fix: expose context pattern filters through both CLI and MCP, and align bilingual docs with actual parsing rules

---

## 版本

- mcp-claude-history: 1.4.0
- mcp-chrome: 2.0.0 → 2.0.1
- mcp-ssh: 2.0.0 → 2.0.1

## 更新内容

### mcp-chrome

- fix: 修复 extension bridge 在 open/navigate 之后丢失 tab 跟踪，避免后续操作继续发送 null tabId
- fix: 加固 extension 模式下的输入、touch、修饰键、commands 聚焦和 stealth 注入链路
- chore: 删除死代码，并清理本次改动文件里的所有超长行

### mcp-ssh

- fix: 不再在 session 元数据里暴露 env，并完整回收 idle forward / PTY 状态
- chore: 删除未使用的 idle sweeper stop helper

### mcp-claude-history

- fix: 让 context pattern 过滤同时在 CLI 和 MCP 暴露，并让中英文文档与真实解析规则一致

## v1.11.0 - 2026-04-29

## Versions

- mcp-claude-history: 1.2.0 → 1.4.0
- mcp-chrome: 1.7.0 → 2.0.0
- mcp-ssh: 1.3.0 → 2.0.0
- skill-cc-session-fix: new
- skill-elenchus: refreshed

## What's Changed

### mcp-chrome 2.0.0

- feat: first public 2.0.0 release with IBrowserDriver abstraction unifying Extension and CDP paths
- feat: split Extension background logic into focused handlers and add Zod validation at action boundaries
- feat: strengthen dual-mode browser control, error typing, and core session flow
- docs: refresh bilingual README and add full TESTING guide

### mcp-ssh 2.0.0

- feat: first public 2.0.0 release with security hardening, path whitelist, idle-timeout cleanup, and session/forward
  robustness improvements
- docs: refresh bilingual README and add TESTING guide

### mcp-claude-history 1.4.0

- feat: migrate to rmcp SDK and improve CLI/MCP result serialization safety
- feat: harden history output path validation and canonicalization behavior
- docs: polish README_zh and add TESTING guide

### skill-cc-session-fix (new)

- feat: add a dedicated skill for repairing Claude Code session references and recovery flows

### skill-elenchus

- chore: refresh prompts, README, and example output

---

## 版本

- mcp-claude-history: 1.2.0 → 1.4.0
- mcp-chrome: 1.7.0 → 2.0.0
- mcp-ssh: 1.3.0 → 2.0.0
- skill-cc-session-fix: 新增
- skill-elenchus: 更新

## 更新内容

### mcp-chrome 2.0.0

- feat: 首次公开发布 2.0.0，引入 IBrowserDriver 抽象，统一 Extension 与 CDP 两条控制路径
- feat: 将 Extension background 逻辑拆分为聚焦 handler，并在 action 边界加入 Zod 校验
- feat: 强化双模式浏览器控制、错误类型体系与核心 session 流程
- docs: 刷新中英文 README，并补充完整 TESTING 指南

### mcp-ssh 2.0.0

- feat: 首次公开发布 2.0.0，加入安全加固、路径白名单、idle-timeout 清理，以及 session/forward 稳定性改进
- docs: 刷新中英文 README，并补充 TESTING 指南

### mcp-claude-history 1.4.0

- feat: 迁移到 rmcp SDK，并提升 CLI / MCP 结果序列化安全性
- feat: 加固历史输出路径校验与 canonicalization 行为
- docs: 润色 README_zh，并补充 TESTING 指南

### skill-cc-session-fix（新增）

- feat: 新增用于修复 Claude Code 会话引用与恢复流程的专用 skill

### skill-elenchus

- chore: 刷新 prompts、README 和示例输出

**Full Changelog**: https://github.com/Pyrokine/claude-tools/compare/v1.10.0...v1.11.0

## v1.10.0 - 2026-04-21

## Versions

- mcp-chrome: 1.6.0 → 1.7.0
- mcp-claude-history: 1.1.4 → 1.2.0
- mcp-ssh: 1.2.2 → 1.3.0
- skill-elenchus: new

## What's Changed

### mcp-chrome 1.7.0

- feat: actionability checks before click — 5-item check (visible, enabled, pointer-events, in-viewport, covered) +
  progressive backoff retry [0,20,100,100,500ms] + auto scroll-into-view
- feat: `input dispatch` mode — set value via nativeInputValueSetter + trigger input/change events, compatible with
  React/Vue controlled components
- feat: `input force` — bypass actionability checks
- feat: `extract depth` — DOM traversal depth limit for state extraction
- feat: `extract computed:prop` — get computed style value via ISOLATED world Extension action
- feat: `evaluate scriptFile` — read script from file (cwd-bounded path traversal prevention)
- feat: `wait idle` DOM mutation detection — Phase 2 MutationObserver quiet-period, returns `domStable: true/false`
- fix: scriptFile path traversal bypass (cwd+sep boundary check)
- fix: dispatch/computed now execute in ISOLATED world to access `__mcpElementMap`
- fix: `{x,y}` click routes through `getTargetPointExtension` for iframe coordinate offset
- fix: retry loop uses `<= delays.length` so the 500ms final delay executes
- fix: `find()` passes timeout param in actionableClick and dispatch branches

### mcp-claude-history 1.2.0

- feat: `history_context` — `pattern`/`regex`/`case_sensitive` params; before/after count only matching messages
- feat: `history_search` — UUID deduplication across sessions (continuation session mirrors)
- feat: `history_search` — `tool_result` defaults to 500-char truncation (other types remain 4000)
- feat: `find_session_file` — cross-project fallback when session not found in current project
- fix: `RegexBuilder::case_insensitive()` API for proper case_sensitive handling in both search and context

### mcp-ssh 1.3.0

- feat: `exec_as_user` — `loadProfile` parameter to skip shell profile loading when it causes timeouts

### skill-elenchus (new)

- feat: multi-expert parallel dialectical analysis skill
- Supports Flow A (code changes / design proposals) and Flow B (abstract questions / decisions)
- 5 independent expert agents (logic, security, design, performance, convention) + cross-examination + dispute
  arbitration

---

## 版本

- mcp-chrome: 1.6.0 → 1.7.0
- mcp-claude-history: 1.1.4 → 1.2.0
- mcp-ssh: 1.2.2 → 1.3.0
- skill-elenchus: 新增

## 更新内容

### mcp-chrome 1.7.0

- feat: 点击前可操作性检查 — 5 项检查（可见、可用、pointer-events、视口内、未被遮挡）+ 渐进退避重试 [0,20,100,100,500ms] + 自动
  scroll-into-view
- feat: `input dispatch` 模式 — 通过 nativeInputValueSetter 设置 value + 触发 input/change 事件，兼容 React/Vue 受控组件
- feat: `input force` — 跳过可操作性检查
- feat: `extract depth` — state 提取的 DOM 遍历深度限制
- feat: `extract computed:prop` — 通过 ISOLATED 世界 Extension action 获取 computed style
- feat: `evaluate scriptFile` — 从文件读取脚本（cwd 边界路径穿越防护）
- feat: `wait idle` DOM mutation 检测 — Phase 2 MutationObserver 静默期，返回 `domStable: true/false`
- fix: scriptFile 路径穿越绕过（cwd+sep 边界校验）
- fix: dispatch/computed 通过 ISOLATED 世界执行以访问 `__mcpElementMap`
- fix: `{x,y}` 点击通过 `getTargetPointExtension` 修正 iframe 坐标偏移
- fix: 重试循环使用 `<= delays.length`，确保 500ms 最终延迟被执行
- fix: `find()` 在 actionableClick 和 dispatch 分支中传递 timeout 参数

### mcp-claude-history 1.2.0

- feat: `history_context` 新增 `pattern`/`regex`/`case_sensitive`，before/after 只计数匹配的消息
- feat: `history_search` 跨会话 UUID 去重（续接会话镜像场景）
- feat: `history_search` tool_result 默认 500 字符截断（其他类型保持 4000）
- feat: `find_session_file` 跨项目 fallback（当前项目找不到时搜索其他项目）
- fix: 使用 `RegexBuilder::case_insensitive()` API 正确处理 case_sensitive（search 和 context 均修复）

### mcp-ssh 1.3.0

- feat: `exec_as_user` 新增 `loadProfile` 参数，支持跳过 shell profile 加载

### skill-elenchus（新增）

- feat: 多专家并行辩证分析 skill
- 支持 Flow A（代码改动/设计方案）和 Flow B（抽象问题/决策）
- 5 个独立专家 agent（逻辑、安全、设计、性能、规范）+ 交叉质疑 + 争议仲裁

**Full Changelog**: https://github.com/Pyrokine/claude-tools/compare/v1.9.0...v1.10.0

## v1.9.0 - 2026-04-21

## Versions

- mcp-chrome: 1.5.2 → 1.6.0
- mcp-claude-history: 1.1.3 → 1.1.4
- mcp-ssh: 1.2.1 → 1.2.2

## What's Changed

### mcp-chrome

- feat: Add select/replace text events for input tool
- feat: Support nested iframe traversal (recursive getFrameOffset + resolveFrame)
- fix: Runtime.Timestamp is epoch ms, remove incorrect `* 1000`
- fix: Use wallTime for Network request timestamps (epoch-based)
- fix: evaluate_in_frame race condition — poll for target frame context
- fix: RegExp safety — detect catastrophic backtracking patterns + limit input length
- fix: Replace selection polling with state confirmation before setRangeText
- fix: Text traversal limits for select/replace (10K nodes / 500KB)
- fix(CVE-2026-25536): Upgrade @anthropic-ai/sdk to 1.27.1
- docs: Fix README_zh.md table formatting and code block syntax
- test: Add select/replace test coverage

### mcp-claude-history

- fix: Byte vs character length calculation in content truncation
- fix: Include available projects in no_current_project error
- fix: Assistant content empty string handling

### mcp-ssh

- fix(CVE-2026-25536): Upgrade @anthropic-ai/sdk to 1.27.1

### Other

- chore: Add MIT LICENSE files (root + mcp-chrome)

---

## 版本

- mcp-chrome: 1.5.2 → 1.6.0
- mcp-claude-history: 1.1.3 → 1.1.4
- mcp-ssh: 1.2.1 → 1.2.2

## 更新内容

### mcp-chrome

- feat: 新增 select/replace 文本事件
- feat: 支持嵌套 iframe 穿透（递归偏移计算 + resolveFrame）
- fix: Runtime.Timestamp 已是 epoch 毫秒，移除错误的 `* 1000`
- fix: Network 请求时间戳使用 wallTime（epoch 基准）
- fix: evaluate_in_frame 竞态——轮询等待目标 frame context
- fix: RegExp 安全——检测灾难性回溯模式 + 限制输入长度
- fix: replace 选区轮询确认后再执行替换
- fix: select/replace 文本遍历加上限（10K 节点 / 500KB）
- fix(CVE-2026-25536): 升级 @anthropic-ai/sdk 到 1.27.1
- docs: 修复中文 README 表格格式和代码块语法
- test: 补充 select/replace 测试覆盖

### mcp-claude-history

- fix: 内容截断中字节/字符长度计算修复
- fix: no_current_project 错误信息包含可用项目列表
- fix: assistant content 空字符串处理

### mcp-ssh

- fix(CVE-2026-25536): 升级 @anthropic-ai/sdk 到 1.27.1

### 其他

- chore: 添加 MIT LICENSE 文件（根目录 + mcp-chrome）

**Full Changelog**: https://github.com/Pyrokine/claude-mcp-tools/compare/v1.8.0...v1.9.0

## v1.8.0 - 2026-04-21

## Versions

- mcp-claude-history: 1.1.2 → 1.1.3
- mcp-chrome: 1.5.1 → 1.5.2 (extension: 1.3.0 → 1.3.1)
- mcp-ssh: 1.2.0 → 1.2.1

## What's Changed

### mcp-claude-history

- fix: Include available projects in no_current_project error message

### mcp-chrome

- feat: Add select/replace input events for text selection and replacement via mouse simulation
- feat: Add find() CDP fallback when Extension is not connected
- feat: Add keyboard combo example (Ctrl+A) in input tool description
- fix: Filter quality param for png format in Page.captureScreenshot (GPT review P0)
- fix: Remove unsafe SSRF-prone URL fetch in extract tool (GPT review P0)
- fix: Use canonical URL (.href) for absolute URL in extension actions
- fix: Add frameOffset null check in input replace handler
- fix: Remove beforeinput dispatch in replace handler (unreliable across editors)
- fix: Add error-retry for IIFE evaluation in unified-session
- docs: Add tabId description for evaluate/logs/wait tools

### mcp-ssh

- fix: Clean up port forwards and PTY sessions on connection close (GPT review P1)

### CI

- fix: Pin GitHub Actions to commit SHA for supply chain security (GPT review P1)

---

## 版本

- mcp-claude-history: 1.1.2 → 1.1.3
- mcp-chrome: 1.5.1 → 1.5.2 (extension: 1.3.0 → 1.3.1)
- mcp-ssh: 1.2.0 → 1.2.1

## 更新内容

### mcp-claude-history

- fix: 在 no_current_project 错误信息中展示可用项目列表

### mcp-chrome

- feat: 新增 select/replace 输入事件，通过鼠标模拟实现文本选中和替换
- feat: Extension 未连接时 find() 自动回退到 CDP 模式
- feat: input 工具描述新增组合键示例（Ctrl+A）
- fix: 修复 png 格式截图错误传递 quality 参数的问题（GPT 评审 P0）
- fix: 移除 extract 工具中存在 SSRF 风险的 URL 抓取逻辑（GPT 评审 P0）
- fix: Extension actions 中使用 .href 获取规范化绝对 URL
- fix: input replace 处理器增加 frameOffset 空值检查
- fix: 移除 replace 处理器中不可靠的 beforeinput 派发
- fix: unified-session 中 IIFE evaluate 增加错误重试
- docs: 为 evaluate/logs/wait 工具添加 tabId 参数说明

### mcp-ssh

- fix: 连接关闭时清理端口转发和 PTY 会话（GPT 评审 P1）

### CI

- fix: GitHub Actions 固定 commit SHA 防止供应链攻击（GPT 评审 P1）

**Full Changelog**: https://github.com/Pyrokine/claude-mcp-tools/compare/v1.7.0...v1.8.0

## v1.7.0 - 2026-03-08

## Versions

- mcp-chrome: 1.5.0 → 1.5.1
- mcp-claude-history: 1.1.2
- mcp-ssh: 1.2.0

## What's Changed

### mcp-chrome

- feat: Add `windowId`, `index`, `pinned`, `incognito`, `status` fields to tab list response

### CI

- ci: Add GitHub Actions workflow for cross-platform mcp-claude-history builds (Linux, macOS x86_64/ARM, Windows)

---

## 版本

- mcp-chrome: 1.5.0 → 1.5.1
- mcp-claude-history: 1.1.2
- mcp-ssh: 1.2.0

## 更新内容

### mcp-chrome

- feat: tab list 返回新增 `windowId`、`index`、`pinned`、`incognito`、`status` 字段

### CI

- ci: 新增 GitHub Actions 工作流，自动编译 mcp-claude-history 多平台版本（Linux、macOS x86_64/ARM、Windows）

**Full Changelog**: https://github.com/Pyrokine/claude-mcp-tools/compare/v1.6.0...v1.7.0

## v1.6.0 - 2026-03-07

## Versions

- mcp-chrome: 1.4.0 → 1.5.0
- mcp-claude-history: 1.1.1 → 1.1.2
- mcp-ssh: 1.1.3 → 1.2.0

## What's Changed

### mcp-chrome

- feat: Add select/replace event types for text selection and replacement via mouse simulation
- feat: Add find() CDP fallback when Extension is not connected
- feat: Add combo key example (Ctrl+A) to input tool description

### mcp-claude-history

- fix: Search agent sessions in subagents/ directory
- fix: Add sessions filter to subagents branch
- refactor: Extract Config::list_project_dirs() to deduplicate directory traversal

### mcp-ssh

- refactor: Split SessionManager into PtyManager + ForwardManager (975 → 645+211+257 lines)
- fix: Reconnect storm caused by close event triggering recursive auto-reconnect
- fix: disconnect() now cleans up PTY sessions and port forwards
- fix: Add connection diagnostics with actionable suggestions
- fix: Add client identity check in error/close events

---

## 版本

- mcp-chrome: 1.4.0 → 1.5.0
- mcp-claude-history: 1.1.1 → 1.1.2
- mcp-ssh: 1.1.3 → 1.2.0

## 更新内容

### mcp-chrome

- feat: 新增 select/replace 事件类型，通过鼠标模拟实现文本选中和替换
- feat: 新增 find() CDP fallback（Extension 未连接时可用）
- feat: input 工具描述新增组合键示例（Ctrl+A）

### mcp-claude-history

- fix: 搜索 subagents/ 目录下的 agent session 文件
- fix: subagents 分支补齐 sessions 过滤
- refactor: 提取 Config::list_project_dirs() 消除重复代码

### mcp-ssh

- refactor: SessionManager 拆分为 PtyManager + ForwardManager（975 → 645+211+257 行）
- fix: 修复 reconnect 导致 close 事件递归重连风暴
- fix: disconnect() 现在清理关联的 PTY 会话和端口转发
- fix: 连接失败增加诊断信息和排查建议
- fix: error/close 事件增加 client 身份校验

**Full Changelog**: https://github.com/Pyrokine/claude-mcp-tools/compare/v1.5.0...v1.6.0

## v1.5.0 - 2026-03-06

## Versions

- mcp-chrome: 1.3.0 → 1.4.0

## What's Changed

### mcp-chrome

- feat: Structured image extraction — `images` parameter (`info`/`data`) for HTML extraction with image metadata and
  data
- feat: Page metadata extraction — `type: "metadata"` for title, OG, JSON-LD, feeds, etc.
- feat: Element screenshot — `target` parameter crops screenshot to specific element (all locator types)
- feat: Element state subtree — `target` parameter for accessibility subtree extraction
- feat: `click` event type for input tool (mousedown + mouseup shorthand)
- fix: `nth` parameter for text/html/attribute extraction
- fix: Root `<img>` self-inclusion in image lists
- fix: iframe screenshot clip coordinate offset
- fix: `fullPage` + `target` mutual exclusion (clip takes priority)
- fix: webp format support in Extension ScreenshotParams
- fix: Relative/protocol-relative `dataSrc` URL resolution
- fix: `guessMimeType()` crash on malformed URLs
- fix: Global uncaughtException/unhandledRejection handlers
- fix: CDP exception formatting utilities
- fix: Image download deduplication

---

## 版本

- mcp-chrome: 1.3.0 → 1.4.0

## 更新内容

### mcp-chrome

- feat: 结构化图片提取 — `images` 参数（`info`/`data`）支持 HTML 提取时附带图片元信息和数据
- feat: 页面元信息提取 — `type: "metadata"` 提取标题、OG、JSON-LD、RSS 等
- feat: 元素截图 — `target` 参数裁剪截图到指定元素（支持所有定位方式）
- feat: 元素状态子树 — `target` 参数提取无障碍子树
- feat: `click` 事件类型（mousedown + mouseup 简写）
- fix: text/html/attribute 提取的 `nth` 参数支持
- fix: 根 `<img>` 元素自身纳入图片列表
- fix: iframe 截图裁剪坐标偏移修正
- fix: `fullPage` + `target` 互斥（clip 优先）
- fix: Extension ScreenshotParams 支持 webp 格式
- fix: 相对/协议相对 `dataSrc` URL 解析为绝对路径
- fix: `guessMimeType()` 对畸形 URL 的异常保护
- fix: 全局 uncaughtException/unhandledRejection 处理
- fix: CDP 异常格式化工具函数
- fix: 图片下载去重优化

**Full Changelog**: https://github.com/Pyrokine/claude-mcp-tools/compare/v1.4.0...v1.5.0

## v1.4.0 - 2026-03-02

## Versions

- mcp-chrome: 1.1.0 → 1.3.0
- mcp-ssh: 1.1.2 → 1.1.3
- mcp-claude-history: 1.1.0 → 1.1.1

## What's Changed

### mcp-chrome

- feat: Screenshot `format` (png/jpeg/webp) and `quality` (0-100) params to reduce size and avoid timeouts on complex
  pages
- feat: Target `nth` index to disambiguate multiple matching elements across all locator strategies
- feat: Keyboard modifier tracking — Ctrl/Alt/Shift/Meta state passed to all key and mouse events
- fix: `resetState()` clears modifiers and mouse position
- fix: `connect()` records port for subsequent operations
- fix: CDP WebSocket passive disconnect prevents duplicate events and clears listeners
- fix: `manage` tool adds `withTabLock` in Extension mode to prevent concurrent tab switch race
- refactor: Extract `formatResponse()` helper, eliminating 51 duplicate response patterns
- refactor: Replace 25+ magic number `30000` with `DEFAULT_TIMEOUT` constant
- refactor: Extract `POLL_INTERVAL` constant in wait tool
- refactor: Remove legacy/ directory (1213 lines of dead code)

### mcp-ssh

- refactor: Split monolithic `index.ts` (1100+ lines) into 6 focused tool modules (connection, exec, file, forward, pty,
  utils)
- refactor: Migrate from manual `Server` + `setRequestHandler` to `McpServer` + `registerTool`

### mcp-claude-history

- refactor: Extract `SearchArgs`/`GetArgs`/`ContextArgs` parameter structs
- refactor: Extract `process_line()` and `parse_range()` utility functions
- refactor: Add `DEFAULT_MAX_CONTENT`/`DEFAULT_MAX_TOTAL` constants
- fix: Clean up unused warnings

---

## 版本

- mcp-chrome: 1.1.0 → 1.3.0
- mcp-ssh: 1.1.2 → 1.1.3
- mcp-claude-history: 1.1.0 → 1.1.1

## 更新内容

### mcp-chrome

- feat: 截图支持 `format`（png/jpeg/webp）和 `quality`（0-100）参数，降低体积避免大页面超时
- feat: Target 支持 `nth` 索引，消歧多个匹配元素（所有定位策略均支持）
- feat: 键盘修饰键状态追踪，Ctrl/Alt/Shift/Meta 位掩码传递给所有键鼠事件
- fix: `resetState()` 重置修饰键和鼠标位置
- fix: `connect()` 记录端口
- fix: CDP WebSocket 被动断开防重复事件并清空监听器
- fix: `manage` 工具 Extension 模式加 `withTabLock` 防并发串台
- refactor: 提取 `formatResponse()` 消除 51 处重复响应模板
- refactor: 25+ 处魔法数字 `30000` 替换为 `DEFAULT_TIMEOUT` 常量
- refactor: 提取 `POLL_INTERVAL` 常量
- refactor: 删除 legacy/ 目录（1213 行死代码）

### mcp-ssh

- refactor: 单文件 `index.ts`（1100+ 行）拆分为 6 个工具模块（connection、exec、file、forward、pty、utils）
- refactor: 从手动 `Server` + `setRequestHandler` 迁移到 `McpServer` + `registerTool`

### mcp-claude-history

- refactor: 提取 `SearchArgs`/`GetArgs`/`ContextArgs` 参数结构体
- refactor: 提取 `process_line()` 和 `parse_range()` 工具函数
- refactor: 新增 `DEFAULT_MAX_CONTENT`/`DEFAULT_MAX_TOTAL` 常量
- fix: 清理 unused warnings

**Full Changelog**: https://github.com/Pyrokine/claude-mcp-tools/compare/v1.3.0...v1.4.0

## v1.3.0 - 2026-02-28

## Versions

- mcp-chrome: 1.0.0 → 1.1.0

## What's Changed

### mcp-chrome

- feat: Add Extension mode with dual-mode browser automation (Extension + CDP)
- feat: iframe penetration — `frame` parameter for all tools (CSS selector or index, Extension mode)
- feat: CSS+text combo locator — `{css, text}` target for filtering by text content
- feat: Smart evaluate output — bare return IIFE wrapping, raw text file output, >100KB auto-save
- feat: Multi-connection Extension — auto-discover and connect to multiple MCP Server instances
- feat: Extension network logs via debugger API
- feat: `isActive` flag in browse list for current tab/target
- fix: CDP connection lifecycle — EventWaiter tracking, rejectAllPending, disconnected signal
- fix: DOM.getDocument initialization before DOM.requestNode
- fix: Label locator enhanced with id-inference and sibling search
- docs: Full documentation rewrite for all new features

---

## 版本

- mcp-chrome: 1.0.0 → 1.1.0

## 更新内容

### mcp-chrome

- feat: 新增 Extension 模式，双模式浏览器自动化架构（Extension + CDP）
- feat: iframe 穿透 — 所有工具支持 `frame` 参数（CSS 选择器或索引，Extension 模式）
- feat: CSS+文本组合定位 — `{css, text}` 目标类型，先 CSS 筛选再按文本过滤
- feat: 智能 evaluate 输出 — 裸 return 自动 IIFE、字符串原始文本写入、>100KB 自动落盘
- feat: Extension 多连接 — 自动发现并同时连接多个 MCP Server 实例
- feat: Extension 模式网络日志（通过 debugger API）
- feat: browse list 返回 `isActive` 标记当前操作目标
- fix: CDP 连接生命周期 — EventWaiter 追踪、rejectAllPending、disconnected 信号
- fix: DOM.getDocument 初始化（修复 DOM.requestNode 失败）
- fix: 标签定位增强（id 推断、兄弟元素搜索）
- docs: 全面重写文档，覆盖所有新功能

**Full Changelog**: https://github.com/Pyrokine/claude-mcp-tools/compare/v1.2.0...v1.3.0

## v1.2.0 - 2026-02-03

## Versions

- mcp-chrome: 1.0.0 (new)
- mcp-claude-history: 1.1.0
- mcp-ssh: 1.1.0 → 1.1.2

## What's Changed

### mcp-chrome (new)

Chrome browser automation MCP Server using Chrome DevTools Protocol.

- Page navigation and management (navigate, refresh, screenshot)
- Element interaction (click, type, scroll)
- Content extraction (getText, getHTML, getLinks)
- JavaScript evaluation
- Cookie management
- Network request interception
- Console log capture

```bash
npm install -g @pyrokine/mcp-chrome
```

### mcp-ssh

- fix: Load user shell profile in execAsUser for environment variables
- style: Unify code indentation to 4 spaces

---

## 版本

- mcp-chrome: 1.0.0 (新增)
- mcp-claude-history: 1.1.0
- mcp-ssh: 1.1.0 → 1.1.2

## 更新内容

### mcp-chrome (新增)

基于 Chrome DevTools Protocol 的浏览器自动化 MCP 服务器。

- 页面导航与管理（导航、刷新、截图）
- 元素交互（点击、输入、滚动）
- 内容提取（getText、getHTML、getLinks）
- JavaScript 执行
- Cookie 管理
- 网络请求拦截
- 控制台日志捕获

```bash
npm install -g @pyrokine/mcp-chrome
```

### mcp-ssh

- fix: 在 execAsUser 中加载用户 shell profile 以获取环境变量
- style: 统一代码缩进为 4 空格

**Full Changelog**: https://github.com/Pyrokine/claude-mcp-tools/compare/v1.1.0...v1.2.0

## v1.1.0 - 2026-02-03

## Versions

- mcp-claude-history: 1.0.3 → 1.1.0 (renamed from claude-history)
- mcp-ssh: 1.0.0 → 1.1.0

## What's Changed

### mcp-claude-history

- refactor: Rename from `history/claude-history` to `mcp-claude-history/mcp-claude-history`

### mcp-ssh

- feat: Add SSH config file parser with Host aliases, `Host *` inheritance, and ProxyJump support

### Chore

- Rename directories to follow `mcp-*` naming convention
- Add `.gitignore` and release specification

---

## 版本

- mcp-claude-history: 1.0.3 → 1.1.0 (从 claude-history 重命名)
- mcp-ssh: 1.0.0 → 1.1.0

## 更新内容

### mcp-claude-history

- refactor: 从 `history/claude-history` 重命名为 `mcp-claude-history/mcp-claude-history`

### mcp-ssh

- feat: 新增 SSH config 文件解析器，支持 Host 多别名、`Host *` 继承、ProxyJump

### 其他

- 目录重命名为 `mcp-*` 命名规范
- 添加 `.gitignore` 和发版规范

**Full Changelog**: https://github.com/Pyrokine/claude-mcp-tools/compare/v1.0.3...v1.1.0

## v1.0.3 - 2026-01-30

## Versions

- claude-history: 1.0.2 → 1.0.3
- mcp-ssh: 1.0.0

## What's Changed

### claude-history

- fix: Tighten roots/list response check to exact request ID
- fix: Ensure project ID always starts with dash
- fix: Sync serverInfo.version with Cargo.toml
- fix: Treat datetime without timezone as local time
- docs: Document datetime timezone behavior

---

## 版本

- claude-history: 1.0.2 → 1.0.3
- mcp-ssh: 1.0.0

## 更新内容

### claude-history

- fix: 严格校验 roots/list 响应的请求 ID
- fix: 确保项目 ID 始终以 dash 开头
- fix: 同步 serverInfo.version 与 Cargo.toml
- fix: 无时区的日期时间按本地时间解释
- docs: 文档说明日期时间时区行为

**Full Changelog**: https://github.com/Pyrokine/claude-mcp-tools/compare/v1.0.2...v1.0.3

## v1.0.2 - 2026-02-03

## Versions

- claude-history: 1.0.1 → 1.0.2
- mcp-ssh: 1.0.0

## What's Changed

### claude-history

- fix: Support ISO8601 datetime format without timezone

---

## 版本

- claude-history: 1.0.1 → 1.0.2
- mcp-ssh: 1.0.0

## 更新内容

### claude-history

- fix: 支持不带时区的 ISO8601 日期时间格式

**Full Changelog**: https://github.com/Pyrokine/claude-mcp-tools/compare/v1.0.1...v1.0.2

## v1.0.1 - 2026-01-30

## Versions

- claude-history: 1.0.0 → 1.0.1
- mcp-ssh: 1.0.0

## What's Changed

### claude-history

- feat: Add roots/list support for auto project detection
- feat: Auto-detect current project from client roots
- feat: Fall back to all projects if roots not available
- docs: Add release download instructions to README

---

## 版本

- claude-history: 1.0.0 → 1.0.1
- mcp-ssh: 1.0.0

## 更新内容

### claude-history

- feat: 新增 roots/list 支持，自动检测项目
- feat: 自动从客户端 roots 检测当前项目
- feat: roots 不可用时回退到所有项目
- docs: README 添加 release 下载说明

**Full Changelog**: https://github.com/Pyrokine/claude-mcp-tools/compare/v1.0.0...v1.0.1

## v1.0.0 - 2026-01-29

## Versions

- claude-history: 1.0.0 (new)
- mcp-ssh: 1.0.0 (new)

## What's Changed

### claude-history v1.0.0 (new)

Claude Code conversation history search tool.

- Search conversation history with pattern matching
- Get full message content by reference
- Get surrounding context messages
- List all projects and sessions

### mcp-ssh v1.0.0 (new)

SSH MCP Server for AI assistants.

- Multiple authentication methods (password, key, SSH Agent)
- Connection pooling, keepalive, auto-reconnect
- Command execution (basic, sudo, su user switch)
- PTY sessions (top, htop, tmux, etc.)
- File operations (SFTP upload/download/read/write)
- Directory sync (rsync preferred, auto-fallback to SFTP)
- Port forwarding (local/remote)

```bash
npx @pyrokine/mcp-ssh
```

---

## 版本

- claude-history: 1.0.0 (新增)
- mcp-ssh: 1.0.0 (新增)

## 更新内容

### claude-history v1.0.0 (新增)

Claude Code 对话历史搜索工具。

- 支持模式匹配搜索对话历史
- 通过引用获取完整消息内容
- 获取消息上下文
- 列出所有项目和会话

### mcp-ssh v1.0.0 (新增)

SSH MCP 服务器。

- 多种认证方式（密码、密钥、SSH Agent）
- 连接池管理、心跳保持、自动重连
- 命令执行（普通、sudo、su 切换用户）
- PTY 会话（top、htop、tmux 等交互式命令）
- 文件操作（SFTP 上传/下载/读写）
- 目录同步（rsync 优先，自动降级 SFTP）
- 端口转发（本地/远程）

```bash
npx @pyrokine/mcp-ssh
```

**Full Changelog**: https://github.com/Pyrokine/claude-mcp-tools/commits/v1.0.0
