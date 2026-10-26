# Changelog

## v1.18.2 - 2026-10-27

## Versions

- mcp-claude-history: 2.0.0 → 2.1.1
- mcp-chrome: 3.0.0 → 3.0.1
- mcp-chrome Extension: 3.0.0 → 3.0.1
- mcp-ssh: 3.0.0 → 3.1.0

## What's Changed

### mcp-claude-history

- feat: Add paged source catalogs, exact `sources` selection and grouped scans through MCP and CLI, with explicit catalog release
- fix: Search oversized records in normal and aggregate modes while preserving filters, redaction and match counts
- fix: Export full content independently of response previews and preserve mixed text, thinking and tool blocks
- fix: Correct Windows history-file paths and private export creation when started from PowerShell 7
- fix: Restore atomic Windows export publication and keep existing bundles when replacement fails
- fix: Accept Windows SYSTEM and Administrators owners for export paths while preserving owner identity and current-user-only DACLs

### mcp-chrome

- fix: Restore managed pages across Extension reloads using document identity, and serialize initialization with later state changes
- fix: Dispatch ordinary background Extension element clicks through the existing atomic click path, including iframe targets, without a preparatory mouse move or action replay
- fix: Preserve iframe identity, valid script arguments and request deadlines across page operations
- fix: Distinguish unavailable native contexts from verification-script errors and preserve the completed action state
- fix: Return actual locator match counts and bounded candidates without unrelated window-focus suggestions
- fix: Detect visible English and Chinese challenge content, preserve passive title waiting and native system-mouse handling, and retain existing debugger sessions on ordinary pages
- fix: Read genuine older Extension group summaries without extra topology requests, keeping missing and malformed data distinct
- fix: Preserve input-value redaction, native error details and document-scoped logs across successful and failed operations
- chore: Update the Extension's Vite build dependency to 8.1.6

### mcp-ssh

- feat: Add an opt-in OpenSSH backend that reuses an existing ControlMaster without opening a new authenticated connection
- feat: Add name/time filters, entry limits, offsets and UTF-8 response-byte budgets to SFTP directory listing
- feat: Add explicit bounded verification for individual files and directory synchronization
- fix: Preserve transport capabilities, remote-operation state and visible errors when a requested operation is unsupported or fails

### Publishing

- ci: Add GitHub Actions Trusted Publishing with exact-commit checks, isolated OIDC permissions and validation of the selected tarballs against npm registry metadata
- ci: Run Windows export-transaction tests before building the Rust release artifacts
- ci: Check Windows private ACLs and export transactions through native PowerShell as well as Bash

---

## 版本

- mcp-claude-history: 2.0.0 → 2.1.1
- mcp-chrome: 3.0.0 → 3.0.1
- mcp-chrome Extension: 3.0.0 → 3.0.1
- mcp-ssh: 3.0.0 → 3.1.0

## 更新内容

### mcp-claude-history

- feat: 通过 MCP 和 CLI 提供来源目录分页、精确 `sources` 选取与分组扫描，支持显式释放来源目录
- fix: normal 和 aggregate 模式可搜索超大记录，保留过滤条件、脱敏和命中计数
- fix: 全文导出独立于响应预览，保留混合的 text、thinking 和 tool 块
- fix: 修复 Windows 历史文件路径，以及从 PowerShell 7 启动时的私有导出创建
- fix: 修复 Windows 导出目录的原子发布，替换失败时保留已有 bundle
- fix: Windows 导出路径接受 SYSTEM 和 Administrators owner，保留 owner 身份与仅限当前用户的 DACL

### mcp-chrome

- fix: Extension 重载后按文档身份恢复受控页面，初始化与后续状态变更串行执行
- fix: Extension 后台普通元素点击复用现有原子点击路径，覆盖 iframe 目标，省去前置鼠标移动且不重放动作
- fix: 页面操作保留 iframe 身份、有效脚本参数和请求期限
- fix: 区分原生 context 不可用与验证脚本错误，保留已完成的主动作状态
- fix: 定位失败返回实际匹配数与有界候选，不再附加无关的窗口焦点建议
- fix: 识别可见的英中文验证内容，保留标题被动等待与原生系统鼠标路径，普通页面继续复用已有 debugger 连接
- fix: 读取真实旧 Extension 的分组摘要，无需额外拓扑请求，区分字段缺失与畸形数据
- fix: 操作成功或失败时均保留输入值脱敏、原生错误详情与文档范围内的日志语义
- chore: Extension 的 Vite 构建依赖更新至 8.1.6

### mcp-ssh

- feat: 新增显式选用的 OpenSSH 后端，复用已有 ControlMaster，不建立新的认证连接
- feat: SFTP 目录列表支持名称与时间筛选、条数限制、偏移和 UTF-8 响应字节预算
- feat: 普通文件与目录同步支持显式、有界的传输校验
- fix: 请求不支持的能力或操作失败时，保留传输能力边界、远端操作状态和可见错误

### 发布流程

- ci: 新增 GitHub Actions Trusted Publishing，校验精确提交、隔离 OIDC 权限，并将所选 tarball 与 npm registry 元数据核对
- ci: 构建 Rust 发布产物前执行 Windows 导出事务测试
- ci: 通过原生 PowerShell 和 Bash 分别检查 Windows 私有 DACL 与导出事务

**Full Changelog**: https://github.com/Pyrokine/claude-tools/compare/v1.17.0...v1.18.2

## v1.18.1 - Tag only / 仅创建 tag

## Versions

- mcp-claude-history: 2.0.0 → 2.1.1
- mcp-chrome: 3.0.0 → 3.0.1
- mcp-chrome Extension: 3.0.0 → 3.0.1
- mcp-ssh: 3.0.0 → 3.1.0

## What's Changed

### mcp-claude-history

- feat: Add paged source catalogs, exact `sources` selection and grouped scans through MCP and CLI, with explicit catalog release
- fix: Search oversized records in normal and aggregate modes while preserving filters, redaction and match counts
- fix: Export full content independently of response previews and preserve mixed text, thinking and tool blocks
- fix: Correct Windows history-file paths and private export creation when started from PowerShell 7
- fix: Restore atomic Windows export publication and keep existing bundles when replacement fails

### mcp-chrome

- fix: Restore managed pages across Extension reloads using document identity, and serialize initialization with later state changes
- fix: Dispatch ordinary background Extension element clicks through the existing atomic click path, including iframe targets, without a preparatory mouse move or action replay
- fix: Preserve iframe identity, valid script arguments and request deadlines across page operations
- fix: Distinguish unavailable native contexts from verification-script errors and preserve the completed action state
- fix: Return actual locator match counts and bounded candidates without unrelated window-focus suggestions
- fix: Detect visible English and Chinese challenge content, preserve passive title waiting and native system-mouse handling, and retain existing debugger sessions on ordinary pages
- fix: Read genuine older Extension group summaries without extra topology requests, keeping missing and malformed data distinct
- fix: Preserve input-value redaction, native error details and document-scoped logs across successful and failed operations
- chore: Update the Extension's Vite build dependency to 8.1.6

### mcp-ssh

- feat: Add an opt-in OpenSSH backend that reuses an existing ControlMaster without opening a new authenticated connection
- feat: Add name/time filters, entry limits, offsets and UTF-8 response-byte budgets to SFTP directory listing
- feat: Add explicit bounded verification for individual files and directory synchronization
- fix: Preserve transport capabilities, remote-operation state and visible errors when a requested operation is unsupported or fails

### Publishing

- ci: Add GitHub Actions Trusted Publishing with exact-commit checks, isolated OIDC permissions and validation of the selected tarballs against npm registry metadata
- ci: Run Windows export-transaction tests before building the Rust release artifacts

---

## 版本

- mcp-claude-history: 2.0.0 → 2.1.1
- mcp-chrome: 3.0.0 → 3.0.1
- mcp-chrome Extension: 3.0.0 → 3.0.1
- mcp-ssh: 3.0.0 → 3.1.0

## 更新内容

### mcp-claude-history

- feat: 通过 MCP 和 CLI 提供来源目录分页、精确 `sources` 选取与分组扫描，支持显式释放来源目录
- fix: normal 和 aggregate 模式可搜索超大记录，保留过滤条件、脱敏和命中计数
- fix: 全文导出独立于响应预览，保留混合的 text、thinking 和 tool 块
- fix: 修复 Windows 历史文件路径，以及从 PowerShell 7 启动时的私有导出创建
- fix: 修复 Windows 导出目录的原子发布，替换失败时保留已有 bundle

### mcp-chrome

- fix: Extension 重载后按文档身份恢复受控页面，初始化与后续状态变更串行执行
- fix: Extension 后台普通元素点击复用现有原子点击路径，覆盖 iframe 目标，省去前置鼠标移动且不重放动作
- fix: 页面操作保留 iframe 身份、有效脚本参数和请求期限
- fix: 区分原生 context 不可用与验证脚本错误，保留已完成的主动作状态
- fix: 定位失败返回实际匹配数与有界候选，不再附加无关的窗口焦点建议
- fix: 识别可见的英中文验证内容，保留标题被动等待与原生系统鼠标路径，普通页面继续复用已有 debugger 连接
- fix: 读取真实旧 Extension 的分组摘要，无需额外拓扑请求，区分字段缺失与畸形数据
- fix: 操作成功或失败时均保留输入值脱敏、原生错误详情与文档范围内的日志语义
- chore: Extension 的 Vite 构建依赖更新至 8.1.6

### mcp-ssh

- feat: 新增显式选用的 OpenSSH 后端，复用已有 ControlMaster，不建立新的认证连接
- feat: SFTP 目录列表支持名称与时间筛选、条数限制、偏移和 UTF-8 响应字节预算
- feat: 普通文件与目录同步支持显式、有界的传输校验
- fix: 请求不支持的能力或操作失败时，保留传输能力边界、远端操作状态和可见错误

### 发布流程

- ci: 新增 GitHub Actions Trusted Publishing，校验精确提交、隔离 OIDC 权限，并将所选 tarball 与 npm registry 元数据核对
- ci: 构建 Rust 发布产物前执行 Windows 导出事务测试

**Full Changelog**: https://github.com/Pyrokine/claude-tools/compare/v1.17.0...v1.18.1

## v1.18.0 - Tag only / 仅创建 tag

## Versions

- mcp-claude-history: 2.0.0 → 2.1.0
- mcp-chrome: 3.0.0 → 3.0.1
- mcp-chrome Extension: 3.0.0 → 3.0.1
- mcp-ssh: 3.0.0 → 3.1.0

## What's Changed

### mcp-claude-history

- feat: Add paged source catalogs, exact `sources` selection and grouped scans through MCP and CLI, with explicit catalog release
- fix: Search oversized records in normal and aggregate modes while preserving filters, redaction and match counts
- fix: Export full content independently of response previews and preserve mixed text, thinking and tool blocks

### mcp-chrome

- fix: Restore managed pages across Extension reloads using document identity, and serialize initialization with later state changes
- fix: Dispatch ordinary background Extension element clicks through the existing atomic click path, including iframe targets, without a preparatory mouse move or action replay
- fix: Preserve iframe identity, valid script arguments and request deadlines across page operations
- fix: Distinguish unavailable native contexts from verification-script errors and preserve the completed action state
- fix: Return actual locator match counts and bounded candidates without unrelated window-focus suggestions
- fix: Detect visible English and Chinese challenge content, preserve passive title waiting and native system-mouse handling, and retain existing debugger sessions on ordinary pages
- fix: Read genuine older Extension group summaries without extra topology requests, keeping missing and malformed data distinct
- fix: Preserve input-value redaction, native error details and document-scoped logs across successful and failed operations
- chore: Update the Extension's Vite build dependency to 8.1.6

### mcp-ssh

- feat: Add an opt-in OpenSSH backend that reuses an existing ControlMaster without opening a new authenticated connection
- feat: Add name/time filters, entry limits, offsets and UTF-8 response-byte budgets to SFTP directory listing
- feat: Add explicit bounded verification for individual files and directory synchronization
- fix: Preserve transport capabilities, remote-operation state and visible errors when a requested operation is unsupported or fails

### Publishing

- ci: Add GitHub Actions Trusted Publishing with exact-commit checks, isolated OIDC permissions and validation of the selected tarballs against npm registry metadata
- ci: Run Windows export-transaction tests before building the Rust release artifacts

---

## 版本

- mcp-claude-history: 2.0.0 → 2.1.0
- mcp-chrome: 3.0.0 → 3.0.1
- mcp-chrome Extension: 3.0.0 → 3.0.1
- mcp-ssh: 3.0.0 → 3.1.0

## 更新内容

### mcp-claude-history

- feat: 通过 MCP 和 CLI 提供来源目录分页、精确 `sources` 选取与分组扫描，支持显式释放来源目录
- fix: normal 和 aggregate 模式可搜索超大记录，保留过滤条件、脱敏和命中计数
- fix: 全文导出独立于响应预览，保留混合的 text、thinking 和 tool 块

### mcp-chrome

- fix: Extension 重载后按文档身份恢复受控页面，初始化与后续状态变更串行执行
- fix: Extension 后台普通元素点击复用现有原子点击路径，覆盖 iframe 目标，省去前置鼠标移动且不重放动作
- fix: 页面操作保留 iframe 身份、有效脚本参数和请求期限
- fix: 区分原生 context 不可用与验证脚本错误，保留已完成的主动作状态
- fix: 定位失败返回实际匹配数与有界候选，不再附加无关的窗口焦点建议
- fix: 识别可见的英中文验证内容，保留标题被动等待与原生系统鼠标路径，普通页面继续复用已有 debugger 连接
- fix: 读取真实旧 Extension 的分组摘要，无需额外拓扑请求，区分字段缺失与畸形数据
- fix: 操作成功或失败时均保留输入值脱敏、原生错误详情与文档范围内的日志语义
- chore: Extension 的 Vite 构建依赖更新至 8.1.6

### mcp-ssh

- feat: 新增显式选用的 OpenSSH 后端，复用已有 ControlMaster，不建立新的认证连接
- feat: SFTP 目录列表支持名称与时间筛选、条数限制、偏移和 UTF-8 响应字节预算
- feat: 普通文件与目录同步支持显式、有界的传输校验
- fix: 请求不支持的能力或操作失败时，保留传输能力边界、远端操作状态和可见错误

### 发布流程

- ci: 新增 GitHub Actions Trusted Publishing，校验精确提交、隔离 OIDC 权限，并将所选 tarball 与 npm registry 元数据核对
- ci: 构建 Rust 发布产物前执行 Windows 导出事务测试

**Full Changelog**: https://github.com/Pyrokine/claude-tools/compare/v1.17.0...v1.18.0

## v1.17.0 - 2026-10-18

## Versions

- mcp-claude-history: 1.9.2 → 2.0.0
- mcp-chrome: 2.4.4 → 3.0.0
- mcp-chrome Extension: 2.4.4 → 3.0.0
- mcp-ssh: 2.4.3 → 3.0.0

## What's Changed

### mcp-claude-history

- breaking: Create a unique bundle for each export and use manifest v2; consumers must use the returned output paths
- breaking: Apply `max_total` to the final compact JSON response in UTF-8 bytes and report `serialized_bytes`
- feat: Add process-bound incremental scan and paged `history_scan_metadata`; retain physical sources beyond normal
  collection limits, replay the latest page, and release cancelled or completed scan state
- feat: Read known nested Workflow agent sources and expose exact `source` across search, get, context, trace, and CLI
- feat: Index oversized records for scan, Unicode ranges, tool input/result views, and local context/trace windows;
  structured previews carry exact get pointers and explicit full requests retain their contract
- feat: Add a normalized, redacted `history_get(view=record)` view for original JSON objects and internal payloads;
  retain bounded reading, original-view Unicode ranges, and private exports
- fix: Avoid repeated whole-response serialization during normal budget reduction, report omitted metadata dimensions,
  preserve exact counts across display truncation, and stop reads and serialization on cancellation
- fix: Match local and full MCP tool names together without excluding local tools or mixing server/tool pairs; preserve
  full names in effective filters and continuation queries
- fix: Read local context and trace windows in sessions above 100,000 messages while retaining selected-span limits,
  redaction, tool association, and export semantics
- fix: Redact Unicode-escaped sensitive JSON keys while preserving original character ranges and literal backslash keys
- fix: Separate message completeness from tool attribution; capacity and read gaps make match counts inexact in every
  search mode
- fix: Report attempted files and unscanned files separately, and reduce coverage metadata before discarding search
  matches
- fix: Preserve bounded code expressions during text redaction while masking sensitive literal arguments and incomplete
  expressions
- fix: Keep unquoted double-colon namespace and log separators for strict-only location names in ordinary and oversized
  records, without relaxing credential, quoted-field, private IP, or URL protection
- fix: Echo `subagents` in effective filters and document matching by each main or agent file's own session ID
- fix: Recalculate the complete export quota after concurrent directory removal, with bounded retries and visible
  failure
- fix: Redact recognizable npm tokens in standalone text and separately quoted tool arguments across structured views,
  oversized records, Unicode ranges, and exports

### mcp-chrome

- breaking: Require an explicit `targetId` for `closePage`; selecting a target does not grant access to an existing user
  page
- fix: Restore full managed access after explicit tab adoption; release preserves grouping and revokes access, with
  visible warnings for browser-blocked capture/debugger cleanup
- fix: Recover this Extension's existing debugger sessions after Service Worker restarts without taking over another
  debugger; preserve concurrent attachment and cleanup state
- fix: Keep unconditional page actions available when older Extensions lack page snapshots, reporting a fresh URL and
  unavailable revision; reject unsupported atomic page conditions before dispatch and retain matching not-started
  precondition status in evaluate and input responses
- fix: Keep disconnected Server discovery and reconnect messages at debug level while retaining deduplicated warnings
  for identified authentication and protocol failures
- fix: Ignore unrelated Turnstile-sized elements and calculate Linux native clicks from client-window geometry and GTK
  frame extents; reject missing tools or mismatched viewport data
- feat: Expose native tab updates, group membership/title/color/collapse/movement, and window updates; support native
  creation options and moving an existing tab while creating additional URL tabs, with distinct creation provenance
- fix: Finish normal-state restoration before applying window bounds, return stable observed geometry, and report
  incomplete window observation without replaying updates
- fix: Return group members and native tab properties in both flat and window-grouped list views; group membership and
  cached MCP window IDs no longer confer page authority
- fix: Reject unsupported inactive-tab updates and popup multi-page creation before changes, preserve known preflight
  rejection state and valid revisions, and keep new groups in their members' window unless explicitly moved
- feat: Add `expectedUrl` and `expectedRevision` checks to page actions and return `pageContext` with the affected
  target and before/after state
- fix: Preserve created-page IDs and actual managed state after partial creation failures; report unknown outcomes
  without attributing the old default page or automatically repeating creation
- feat: Grant and revoke ordinary reads through MCP, scoped to the server instance, document, URL, and revision;
  permission-denied page management and navigation preserve valid read grants
- feat: Return browser list summaries with optional full native properties and target/managed filters, omitting inline
  favicon payloads and repeated tab objects
- fix: Invoke zero-argument functions when `args=[]` is explicit across CDP, Extension precise/stealth, and iframe
  evaluation; omitted args retain ordinary script semantics
- fix: Preserve completed actions and original errors when restoring a temporary target fails; report restoration
  separately and clear stale CDP attachment state
- fix: Keep target selection, action execution and page snapshots in one request scope; format asynchronous
  browse/manage failures consistently
- fix: Resolve stale iframe contexts only under the explicit read-only retry contract, and report browser error pages
  and unavailable navigation history
- fix: Fix Extension content reads and iframe selection failing on unserializable injection arguments; preserve URL
  authorization checks and explicit zero-valued options
- fix: Preserve the selected DOM iframe identity during precise evaluation when multiple frames share a URL, including
  `about:srcdoc`; reject unresolved identities without executing a different frame
- fix: Match iframe URLs containing fragments during precise evaluation without dropping query or fragment identity
- fix: Restore existing iframe targets after Extension reloads without navigating the page; retain document-bound
  initialization and verified frame identity
- fix: Share one request budget across navigation preparation, queues, loading, challenges, diagnostics, and target
  restoration; reject expired queued actions without late navigation or automatic replay
- fix: Stop Challenge read fallbacks after inspection timeout and retain the unavailable inspection status
- fix: Carry Challenge deadlines through Extension dispatch and OS mouse paths, release CDP presses on the original
  session, and preserve known navigation status when verification times out
- fix: Accept current main-frame BFCache restores when waiting for CDP history navigation, without accepting unrelated
  frame commits or child-frame events
- fix: Preserve the separate page-creation load wait and RPC transport margin
- fix: Enforce screenshot/output budgets and private Windows output permissions; retain background automatic Extension
  connection
- fix: Restore CDP role lookup, state text, offscreen input focus, editor targets, and repeated key events
- fix: Apply force and coverage checks to click variants, reject force without an element target, and honor humanized
  click movement
- fix: Apply mobile density and touch emulation in CDP, and keep injected User-Agent reads current after browser
  overrides
- fix: Use page dispatch for same-page challenge buttons and immediate scrolling before reading challenge click
  coordinates
- fix: Recognize visible English and Chinese verification `button` elements without changing native input for Cloudflare
  iframes
- fix: Hide password selection/replacement diagnostic bodies in successful and failed input responses; preserve ordinary
  input diagnostics and action status
- fix: Retain Challenge results in evaluate responses, including origin-wait status and action, verification, or output
  failures
- fix: Omit password values from Extension accessibility names without reading them; retain labels and ordinary input
  values
- fix: Report native script termination and Runtime internal errors as unknown results in evaluate and advanced CDP
  commands; prevent direct retries after uncertain evaluation timeouts or stale contexts without replaying commands
- fix: Keep CDP partial-creation errors consistent with the unmanaged state returned by page lists
- fix: Wait for CSS-hidden CDP elements to become visible without failing on an unavailable box model
- fix: Use the same browser text semantics for targeted HTML and whole pages, while retaining SVG/XML node text; accept
  URL/revision conditions when reading or updating page notes
- fix: Correct hidden-tab screenshot capabilities in screenshot and diagnostic bundle responses
- fix: Suggest regenerating oversized baseline PNGs with `clip` or `scale` while preserving comparison budgets
- fix: Retain declared CDP frame fields as `null` when their values are unavailable
- fix: Return the selected document URL in CDP metadata extraction
- fix: Check CDP background-page element stability without waiting for paused animation frames or activating the page
- fix: Share the remaining CDP input budget across target lookup, actionability checks, and coordinate reads; stop
  before dispatch when it expires
- fix: Stop stepped and humanized mouse movement at the input deadline before subsequent clicks; carry the remaining
  budget through driver preparation and Extension dispatch, retaining unknown partial-action results without replay
- fix: Stop command focus, text selection, replacement, and stepped CDP touch movement at the remaining input deadline;
  release Shift after selection failures without hiding the original action error
- fix: Apply stealth typing delays between characters without delaying the first character; preserve deadline checks
- fix: Refresh performance network records when the Extension debugger is unavailable; preserve stable sequences,
  browser-provided status, and document-local clear boundaries without clearing the page timeline
- fix: Include bounded focus metadata in controlled-input failure diagnostics without reading input values
- docs: Specify caret-based keyboard insertion and explicit end-of-contenteditable append preparation
- fix: Distinguish invalid path syntax from scope rejection, report the actual working directory and allowed roots, and
  accept dot components without permitting parent traversal or symlink escapes

### mcp-ssh

- breaking: Measure `maxOutputSize` and PTY `bufferSize` in raw UTF-8 bytes; raw reads report counts before clearing the
  buffer
- feat: Support explicit Windows remote platform, shell and path conventions with bounded transfer verification
- fix: Check Windows upload name collisions before SFTP or rsync writes using the target directory's case rules
- fix: Reject zero-progress text pages and invalid EOF encodings; compute line-range metadata from returned bytes
- fix: Honor `IdentityAgent none` across config inheritance, jump hosts, reconnect and external rsync without
  environment-agent fallback
- fix: Preserve transfer targets and report cleanup/timeout uncertainty; retain the operation-start timeout test
  stability change
- fix: Distinguish quoted here-doc content and command expansions from real background execution, retaining risk signals
  for active command substitutions
- fix: Preserve POSIX operation exit codes with or without `setsid`; verify process identity before cancellation in sh
  and Bash
- docs: Distinguish PTY read byte counters from the list-only `bufferSize` field
- fix: Enable TCP_NODELAY on new SSH clients to reduce small-request latency in direct, jump-host and replacement
  connections
- fix: Preserve literal aliases and error messages in automatic reconnect warnings
- fix: Bound directory exclude glob matching without regular-expression backtracking, preserving wildcard and literal
  matching semantics
- fix: Reject nonregular key and SSH config paths before synchronous reads to prevent FIFOs from blocking requests

### Dependencies and documentation

- chore: Update the existing MCP SDK to 1.32.1 and compatible security revisions; `braces` 3.0.3 remains an affected
  development dependency without a patched release
- docs: Add a separate root Chinese README and synchronize module migration notes and reusable regression guidance
- fix: Pin the Rust toolchain Action to a commit, limit contents write access to the release job, and disable checkout
  credential persistence

---

## 版本

- mcp-claude-history: 1.9.2 → 2.0.0
- mcp-chrome: 2.4.4 → 3.0.0
- mcp-chrome Extension: 2.4.4 → 3.0.0
- mcp-ssh: 2.4.3 → 3.0.0

## 更新内容

### mcp-claude-history

- breaking: 每次导出创建独立 bundle 并使用 manifest v2，调用方使用响应返回的 output 路径
- breaking: `max_total` 按最终紧凑 JSON 的 UTF-8 字节数限制，返回 `serialized_bytes`
- feat: 新增绑定进程的逐批 scan 和分页
  `history_scan_metadata`，保留超出 normal 收集限制的物理来源，重放最近页，释放已取消或消费结束的扫描状态
- feat: 读取已识别的嵌套 Workflow agent，search、get、context、trace 和 CLI 使用精确 `source` 选择来源
- feat: 为超大记录提供 scan、Unicode range、tool
  input/result 视图及局部 context/trace，结构化 preview 附精确 get 指针，显式 full 保持完整返回合同
- feat: 新增规范化且脱敏的 `history_get(view=record)`
  视图，恢复原 JSON 对象与内部 payload，保留有界读取、原视图 Unicode 范围与私有导出
- fix: normal 预算删减不再反复序列化完整响应，报告遗漏的 metadata 维度，展示截断保留精确计数，取消后停止读取与序列化
- fix: 混合查询本地与完整 MCP 工具名时保留本地结果和 server/tool 配对，有效过滤条件与续查保留完整名称
- fix: 支持在超过 100000 条消息的会话中读取局部 context 和 trace，保留选定跨度限制、脱敏、工具关联与导出语义
- fix: 脱敏 Unicode 转义的敏感 JSON key，保留原文字符范围和字面反斜杠字段的语义
- fix: 分别报告正文完整性与工具归因，容量和读取缺口使各搜索模式的命中计数标为非精确
- fix: 分别列出已尝试扫描和未扫描文件，响应预算先缩减 coverage，保留命中消息
- fix: 文本脱敏保留有限语法内的代码表达式，敏感字面量参数和不完整表达式仍整体遮蔽
- fix: 普通与超大记录保留 strict 专有位置名称后的未加引号双冒号分隔符，凭证、引用字段、私有 IP 和 URL 保护保持
- fix: 有效过滤条件回显 `subagents`，明确主文件与 agent 文件按各自 session ID 匹配
- fix: 并发删除导出目录时重新计算完整配额，重试有上限，仍无法读取时返回错误
- fix: 遮蔽独立正文和独立引号参数中的可识别 npm token，覆盖结构化视图、超大记录、Unicode 范围及导出

### mcp-chrome

- breaking: `closePage` 必须显式传 `targetId`，选择目标不授予已有用户页面的访问权限
- fix: 显式 adopt 后恢复完整受控能力，release 保留分组并撤销权限，浏览器阻止采集/debugger 清理时明确返回提示
- fix: Service Worker 重启后恢复本 Extension 已有的 debugger 连接，不接管其他调试器，保留并发附加与清理状态
- fix: 旧 Extension 缺少页面快照时保留无条件页面操作，返回实时 URL 和 revision 不可用提示，不支持的原子页面条件在派发前拒绝，evaluate 和 input 的顶层状态与错误上下文保持未开始状态
- fix: 无 Server 扫描和重连消息使用 debug，已识别的认证、协议错误仍输出去重 warning
- fix: 忽略只有尺寸相似的无关元素，Linux 原生点击使用 client 窗口几何与 GTK frame extents，工具缺失或视口不符时拒绝点击
- feat: 公开原生页面更新、分组成员/名称/颜色/折叠/移动和窗口更新，支持原生创建参数、同时移入已有页并新建 URL 页面，分别记录创建来源
- fix: normal 状态恢复完成后再应用窗口几何，返回稳定的浏览器观测值，观察未完成时明确报告，不重放更新动作
- fix: 平铺目标与窗口列表回显分组成员和原生 tab 属性，分组归属及缓存的 MCP window ID 不赋予页面权限
- fix: 不支持的活动页停用与 popup 多页面创建在变更前拒绝，保留明确未执行状态及有效 revision，新组默认保留成员原窗口，显式指定时才跨窗移动
- feat: 页面动作支持 `expectedUrl` 和 `expectedRevision`，`pageContext` 返回实际目标及动作前后状态
- fix: 创建部分失败后保留新页面 ID 和实际受控状态，未知结果不指向旧默认页，不自动重复创建
- feat: 通过 MCP 授予和撤销普通读取权限，限定服务器实例、文档、URL 和 revision；页面管理或导航被权限拒绝时保留有效只读授权
- feat: 页面列表默认返回摘要，按需提供完整原生属性和目标/受控过滤，不返回内联 favicon 正文或重复页面对象
- fix: CDP、Extension precise/stealth 和 iframe 中显式 `args=[]` 调用零参函数，未传 args 保留普通脚本语义
- fix: 临时目标恢复失败时保留已完成动作和原错误，单独报告恢复状态，清除失效的 CDP 附着状态
- fix: 目标选择、动作和页面快照使用同一请求作用域，browse/manage 的异步失败使用统一错误格式
- fix: 只有显式只读重试允许重新解析 stale iframe context，明确报告浏览器错误页及不可用的导航历史
- fix: 修复 Extension 内容读取和 iframe 定位因注入参数不可序列化而失败，保留 URL 授权校验和显式零值参数
- fix: 多个 iframe URL 相同（包括 `about:srcdoc`）时，precise evaluate 保留所选 DOM
  iframe 身份，无法确认时拒绝执行，不选择其他 frame
- fix: precise evaluate 支持带 fragment 的 iframe URL，保留 query 和 fragment 身份
- fix: Extension 重载后恢复原页面中的 iframe 操作，无需导航页面，保留绑定文档的初始化与 frame 身份验证
- fix: 导航准备、排队、加载、Challenge、诊断和目标恢复共用请求预算，过期队列不迟到导航，不自动重放动作
- fix: Challenge 检查超时后停止其他读取方式，保留检查未完成状态
- fix: Challenge deadline 传到 Extension 派发与系统鼠标路径，CDP 按下后向原 session 释放，验证超时保留已知导航状态
- fix: CDP 历史导航识别当前主 frame 的 BFCache 恢复，排除无关 frame commit 和子 frame 事件
- fix: 页面创建保留独立的加载等待与 RPC 传输余量
- fix: 限制截图与输出预算，校验 Windows 输出权限，保留 Extension 后台自动连接
- fix: 恢复 CDP 角色定位、状态文本、视口外输入聚焦、编辑器目标和长按重复事件
- fix: 点击各分支执行 force 与遮挡检查，无元素 target 时拒绝 force，humanize 点击执行鼠标移动
- fix: CDP 设备模拟设置像素密度与触摸能力，注入的 User-Agent 读取随浏览器覆盖值更新
- fix: 同页模拟挑战按钮使用页面点击，读取挑战点击坐标前立即完成滚动
- fix: 识别精确匹配英文、中文验证文案的可见 button，保留 Cloudflare iframe 的系统鼠标路径
- fix: 密码选择与替换的成功、失败响应均隐藏诊断正文，保留普通输入诊断及动作状态
- fix: evaluate 响应保留 Challenge 结果，包含源站等待状态以及动作、验证或输出失败路径
- fix: Extension 可访问名称不读取或返回密码值，保留标签与普通输入值
- fix:
  evaluate 与高级 CDP 命令将原生脚本终止及 Runtime 内部错误标为结果未知；执行中超时或过期 context 的结果未知时不可直接重试，不重放命令
- fix: CDP 部分创建失败的受控状态与页面列表返回值保持一致
- fix: CDP 等待 CSS 隐藏元素变为可见时，不再因缺少 box model 提前失败
- fix: 目标 HTML 与整页遵循相同的浏览器文本语义，保留 SVG/XML 节点文本；页面备注读取与更新支持 URL/revision 条件
- fix: 修正截图与诊断包中的隐藏页截图能力声明
- fix: 超大 PNG 基准图拒绝时提示用 `clip` 或 `scale` 重新生成，保留截图对比预算
- fix: CDP 帧字段无法取得值时保留字段并返回 `null`
- fix: CDP 文档元信息返回实际文档 URL
- fix: CDP 后台页面的位置检查不再等待已暂停的动画帧，保留稳定性检查，不激活页面
- fix: CDP 输入的目标查找、可操作性检查与坐标读取共用剩余预算，到期后不派发动作
- fix: 分步与 humanize 鼠标移动到期后不再点击，剩余预算传递至 driver 准备和 Extension 派发，部分执行保留 unknown 且不自动重放
- fix: 命令聚焦、文本选择、替换和 CDP 分步触摸移动到期后停止后续动作，选区失败后仍释放 Shift，保留原动作错误
- fix: Stealth 输入仅在字符之间延迟，首字符不额外等待，保留 deadline 检查
- fix: Extension
  debugger 不可用时刷新 performance 网络记录，保留序列号、浏览器响应状态与文档内清除边界，不清除网页共享数据
- fix: 受控输入失败诊断包含有界焦点摘要，不读取输入值
- docs: 明确键盘按光标位置插入，contenteditable 末尾追加需先建立末尾光标
- fix: 区分路径语法与范围拒绝，返回实际工作目录和允许根，支持点组件，继续拒绝父目录访问和链接越界

### mcp-ssh

- breaking: `maxOutputSize` 和 PTY `bufferSize` 按原始 UTF-8 字节计算，raw 读取返回清理前计数
- feat: 支持显式 Windows 远端平台、shell 和路径格式，对传输校验设置边界
- fix: SFTP 和 rsync 写入前按目标目录的大小写规则检查 Windows 上传名称碰撞
- fix: 拒绝零进度文本分页和 EOF 无效编码，行范围 metadata 按实际返回字节计算
- fix: `IdentityAgent none` 在配置继承、跳板机、重连和外部 rsync 中保持禁用，不使用环境 agent
- fix: 保留传输目标，明确报告清理与超时的未知状态，保留 operation start timeout 测试稳定性改动
- fix: 区分引用的 here-doc 正文、命令展开与实际后台执行，保留有效命令替换的风险信号
- fix: POSIX operation 在有无 `setsid` 时保留真实退出码，sh 和 Bash 取消前校验进程身份
- docs: 区分 PTY read 字节计数与仅由 list 返回的 `bufferSize` 字段
- fix: 新 SSH client 启用 TCP_NODELAY，减少直连、跳板和替代连接的小请求等待
- fix: 自动重连告警原样保留 alias 和错误文本中的格式占位符
- fix: 目录 exclude glob 改为有界匹配，保留通配符和字面量语义，避免正则组合回溯
- fix: 在同步读取前拒绝指向非普通文件的密钥与 SSH config 路径，避免 FIFO 阻塞请求

### 依赖和文档

- chore: 更新现有 MCP SDK 至 1.32.1 及兼容的安全修订，`braces` 3.0.3 开发依赖仍受公告影响且没有修订版本
- docs: 新增独立的根中文 README，同步模块迁移说明和可复用回归指导
- fix: 固定 Rust toolchain Action 的 commit，仅 Release job 保留 contents 写权限，checkout 不持久化凭证

**Full Changelog**: https://github.com/Pyrokine/claude-tools/compare/v1.16.2...v1.17.0

## v1.16.2 - 2026-09-10

## Versions

- mcp-claude-history: 1.9.1 → 1.9.2
- mcp-chrome: 2.4.1 → 2.4.4
- mcp-chrome Extension: 2.4.1 → 2.4.4
- mcp-ssh: 2.4.1 → 2.4.3

## What's Changed

### mcp-claude-history

- fix: Preserve punctuation in existing project paths and mark unresolved display paths with `path_approximate`
- fix: Keep centered search previews within `max_content`, including ellipsis markers
- fix: Validate message filters, refs, ranges, and time windows without silently widening the query
- fix: Redact session topics before truncation and report redaction and invalid-timestamp metadata

### mcp-chrome

- feat: Add controlled page adoption, release, movement, ordering, pinning, and topology metadata
- feat: Wait for browser challenges, handle visible Turnstile controls only on the active managed tab, and report denied
  or timed-out states explicitly
- fix: Scope CDP events, logs, challenge state, and diagnostics to the current flat session and main document
- fix: Return structured input errors, bound and redact diagnostic data, and preserve action and verification state
- fix: Clean server build output before packaging; replace the stale 2.4.2 and metadata-incomplete 2.4.3 packages with
  2.4.4
- chore: Refresh npm development and Extension build dependencies to remove audit findings

### mcp-ssh

- fix: Add bounded SFTP operation timeouts and explicit unknown-state reporting after remote timeouts
- fix: Preserve atomic upload and download targets until transfer and requested verification complete
- fix: Harden tracked operation, PTY, forward, reconnect, and effective-user lifecycle handling
- fix: Strengthen directory verification, UTF-8 pagination, transport selection, and cleanup reporting
- fix: Clean server build output before packaging so removed files cannot enter npm packages
- test: Attach timeout rejection assertions before async waiting to avoid load-sensitive unhandled rejections

### Skills and documentation

- docs: Expand `skill-cc-session-fix` diagnostics for large JSONL records, resume anchors, and session metadata
- fix: Synchronize the `skill-elenchus` entry points, review formats, and technical notation
- chore: Upgrade the shared MCP SDK dependency and refresh bilingual documentation and release regression guides

---

## 版本

- mcp-claude-history: 1.9.1 → 1.9.2
- mcp-chrome: 2.4.1 → 2.4.4
- mcp-chrome Extension: 2.4.1 → 2.4.4
- mcp-ssh: 2.4.1 → 2.4.3

## 更新内容

### mcp-claude-history

- fix: 现存项目路径保留标点，无法解析的展示路径返回 `path_approximate`
- fix: 居中搜索预览包含省略号时仍不超过 `max_content`
- fix: 校验消息过滤、ref、范围和时间窗口，不再静默扩大查询范围
- fix: 会话主题先脱敏再截断，并返回脱敏和无效时间戳统计

### mcp-chrome

- feat: 新增受控页面的 adopt、release、移动、排序、固定和拓扑信息
- feat: 等待浏览器 Challenge，只在活动受控 tab 上处理可见 Turnstile，并明确报告拒绝或超时状态
- fix: CDP 事件、日志、Challenge 状态和 diagnostics 只归属当前 flat session 与主文档
- fix: 返回结构化输入错误，限制并脱敏诊断数据，保留动作和验证状态
- fix: 发包前清理 server 构建目录；以 2.4.4 替换误含旧产物的 2.4.2 和缺少 gitHead 的 2.4.3
- chore: 更新 npm 开发依赖和 Extension 构建依赖，清除 npm audit 告警

### mcp-ssh

- fix: 新增有界 SFTP 操作超时，远端超时后明确报告未知状态
- fix: atomic upload 和 download 仅在传输及请求的校验完成后替换目标
- fix: 加强 tracked operation、PTY、forward、reconnect 和有效用户的生命周期管理
- fix: 加强目录校验、UTF-8 分页、transport 选择和清理结果报告
- fix: 发包前清理 server 构建目录，防止已删除文件进入 npm 包
- test: 在异步等待前注册超时拒绝断言，避免高负载下出现未处理 rejection

### Skills 和文档

- docs: 扩展 `skill-cc-session-fix` 对大 JSONL record、resume 锚点和 session metadata 的诊断说明
- fix: 同步 `skill-elenchus` 入口版本、评审格式和技术标记
- chore: 升级共用 MCP SDK 依赖，更新双语文档和发版回归指南

**Full Changelog**: https://github.com/Pyrokine/claude-tools/compare/v1.16.1...v1.16.2

## v1.16.1 - 2026-07-21

## Versions

- mcp-claude-history: 1.9.0 → 1.9.1
- mcp-chrome: 2.4.0 → 2.4.1
- mcp-chrome Extension: 2.4.0 → 2.4.1
- mcp-ssh: 2.4.0 → 2.4.1

## What's Changed

### mcp-claude-history

- fix: Keep paginated search continuations within the original slice
- fix: Return `response_too_large` when a byte-limited response cannot advance
- fix: Tighten trace association and range handling

### mcp-chrome

- fix: Verify the active Extension bundle and resolve iframe identity without relying on frame ordering
- fix: Prevent implicit replay of side-effecting scripts after stale execution contexts
- fix: Report action, output, verification, and target diagnostic states accurately
- fix: Redact credential query parameters from logs, diagnostics, and output files
- fix: Dispatch native editing commands once and verify page results separately

### mcp-ssh

- fix: Harden tracked operation and session lifecycle handling
- fix: Improve forward close and reconnect state reporting
- fix: Distinguish atomic upload final paths from temporary verification paths
- fix: Strengthen SFTP, rsync, transfer, and directory verification semantics

---

## 版本

- mcp-claude-history: 1.9.0 → 1.9.1
- mcp-chrome: 2.4.0 → 2.4.1
- mcp-chrome Extension: 2.4.0 → 2.4.1
- mcp-ssh: 2.4.0 → 2.4.1

## 更新内容

### mcp-claude-history

- fix: 保证分页续查不离开原始 slice 范围
- fix: 字节预算无法容纳结果且游标不能推进时返回 `response_too_large`
- fix: 加强 trace 关联和范围处理

### mcp-chrome

- fix: 校验活动 Extension bundle，并按真实 frame identity 定位 iframe
- fix: stale execution context 后不再隐式重放有副作用的脚本
- fix: 准确报告动作、输出、验证和目标诊断状态
- fix: 脱敏日志、diagnostics 和输出文件中的认证 query 参数
- fix: 原生编辑命令只分发一次，页面结果单独验证

### mcp-ssh

- fix: 加强 tracked operation 和会话生命周期管理
- fix: 改进端口转发关闭及重连状态
- fix: 区分 atomic upload 最终路径与临时校验路径
- fix: 加强 SFTP、rsync、文件传输和目录校验语义

**Full Changelog**: https://github.com/Pyrokine/claude-tools/compare/v1.16.0...v1.16.1

## v1.16.0 - 2026-07-16

## Versions

- mcp-claude-history: 1.8.1 → 1.9.0
- mcp-chrome: 2.3.2 → 2.4.0
- mcp-ssh: 2.3.2 → 2.4.0

## What's Changed

### mcp-claude-history

- feat: Add `history_build_info` with package, commit, target, profile, timestamp, dirty-state, and reproducibility
  metadata
- feat: Add strict tool call/result association, independent tool-result preview limits, and compact UTF-8 response
  budgeting
- fix: Ignore valid session metadata records without warnings while retaining warnings for malformed and incomplete
  message records
- fix: Apply redaction and canonical output manifests consistently across search, get, context, and trace
- chore: Upgrade Rust dependencies, raise the MSRV to 1.88, and publish stable platform asset names alongside
  target-triple names

### mcp-chrome

- feat: Add bounded target diagnostics and explicit action, verification, failure-stage, and retry state fields
- fix: Separate text occurrence indexes from target-element indexes, support replace on non-selection inputs, and
  recover stale iframe contexts once
- fix: Keep `evaluate` in precise mode by default and use the same mode for its post-condition
- fix: Normalize public console levels, bound inline network URLs, and aggregate candidate-port failures without
  changing zero-configuration reconnect
- chore: Upgrade the TypeScript compiler path, Vite, ESLint, Prettier, and related dependencies

### mcp-ssh

- feat: Add tracked operation start, status, read, cancel, and list tools with bounded output and retention
- feat: Select rsync or SFTP from route and credential capabilities, and return the selected transport with its decision
  reason
- feat: Add bounded file and directory verification with explicit top-level failure when a requested check does not
  match
- fix: Retain completed PTY output, wait for forward closure, report atomic upload temporary paths, and tighten
  line-range and command-risk handling
- chore: Upgrade the TypeScript compiler path, ESLint, Prettier, and related dependencies

---

## 版本

- mcp-claude-history: 1.8.1 → 1.9.0
- mcp-chrome: 2.3.2 → 2.4.0
- mcp-ssh: 2.3.2 → 2.4.0

## 更新内容

### mcp-claude-history

- feat: 新增 `history_build_info`，返回包版本、commit、target、profile、构建时间、dirty 状态和可复现标记
- feat: 严格关联 tool call 与 result，新增独立 tool-result 预览限制和紧凑 UTF-8 响应预算
- fix: 合法 session metadata record 不再产生警告，损坏 JSON 和不完整消息 record 仍会报告警告
- fix: search、get、context 和 trace 统一应用脱敏与 canonical output manifest
- chore: 升级 Rust 依赖，将 MSRV 提升到 1.88，并同时发布稳定平台名和 target triple 资产名

### mcp-chrome

- feat: 新增有界 target diagnostics，以及明确的动作、验证、失败阶段和重试状态字段
- fix: 分离文本 occurrence index 与目标元素 index，支持非 selection input replace，并对 stale iframe context 重试一次
- fix: `evaluate` 默认使用 precise mode，post-condition 使用同一 mode
- fix: 统一公开 console level，限制内联 network URL，并聚合候选端口失败且不改变零配置自动重连
- chore: 升级 TypeScript compiler path、Vite、ESLint、Prettier 及相关依赖

### mcp-ssh

- feat: 新增 tracked operation 的 start、status、read、cancel 和 list 工具，输出与保留时间均有上限
- feat: 根据连接路径和凭证能力选择 rsync 或 SFTP，并返回 transport 与选择原因
- feat: 新增有界文件和目录校验，请求的校验不匹配时顶层明确返回失败
- fix: 保留自然结束的 PTY 输出，等待端口转发关闭，返回 atomic upload 临时路径，并收紧 line range 和命令风险处理
- chore: 升级 TypeScript compiler path、ESLint、Prettier 及相关依赖

**Full Changelog**: https://github.com/Pyrokine/claude-tools/compare/v1.15.2...v1.16.0

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
- feat: 新增 controlled input、更丰富的 select/replace 诊断、结构化页面状态、frame metadata、clip
  screenshot、PNG 对比和 action diagnostics
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

- feat: 点击前可操作性检查 —
  5 项检查（可见、可用、pointer-events、视口内、未被遮挡）+ 渐进退避重试 [0,20,100,100,500ms] + 自动 scroll-into-view
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
