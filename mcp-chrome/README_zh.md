# MCP-Chrome

[English](README.md) | 中文

Chrome 浏览器自动化 MCP Server，双模式架构： **Extension 模式**（推荐）操控现有浏览器， **CDP 模式**（回退）启动独立实例

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.19-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io/)

## 功能特性

- **双模式**：Extension 模式共享登录状态；CDP 模式用于无头/隔离场景
- **8 个统一工具**：基于 action 的设计，覆盖浏览、输入、提取、等待、执行、管理、Cookie、日志
- **多页面定位**：`targetId` 在两种 backend 中指定操作页面，无需切换浏览器焦点；`tabId` 保留为兼容别名
- **iframe 穿透**：`frame` 参数支持操作 iframe 内元素（CSS 选择器或索引，Extension 模式）
- **语义化定位**：11 种元素定位方式（role、text、label、css、css+文本组合、xpath、坐标等）
- **自动等待**：内置可点击性、可输入性检测，基于 deadline 的超时预算机制
- **双输入模式**：`precise`（debugger API，可绕过 CSP）或 `stealth`（JS 注入，无调试横幅）
- **智能输出**：裸 `return` 语句自动 IIFE 包裹；大结果（>100KB）自动写入文件；`output` 对字符串写入原始文本
- **多服务器**：Extension 自动发现并同时连接多个 MCP Server 实例
- **反检测**：可选的指纹伪装和行为模拟
- **结构化错误**：每个错误包含 code、message、suggestion、context

## 迁移到 3.0

- `manage(action="closePage")` 必须显式传入 `targetId`，不再关闭缺省页面
- Extension 模式显式 `adoptPage`
  后，已有页面获得与新建受控页相同的读取、输入、脚本、截图、debugger 和日志能力，受控页面无需 popup 普通只读授权
- 单页普通读取授权覆盖 text、HTML、attribute、computed
  style 与 state，不开放任意 JavaScript、CDP/debugger、input 或 screenshot
- `tmp:` 文件只属于当前 MCP server 会话；重启后需重新生成，需保留的文件应在服务器退出前保存到 `cwd:`

本地零配置自动连接保持不变，刷新 Extension 或重启 MCP client 后不需要手动点击“连接”

## 请求范围与失败处理

一组输入事件在执行和恢复目标期间保持同一后端、同一页面，并发的 `browse(action="connect")` 等待该请求结束；CDP 请求带
`frame` 时，在定位或操作 Extension 页面前返回能力错误

Extension 通过所选 document 与原生 iframe owner 核对身份，同 URL iframe 重排后不按旧 DOM 索引执行

显式 `wait="networkidle"` 在导航前启用 Network 观测，等待请求完成后持续静默 500 ms；观测缺失或中断时返回错误，默认
`load` 路径不会为了网络空闲检查附加 debugger

CDP 网络日志在响应体传输失败时保留 HTTP 状态，每个请求只记录一次终态；临时选择其他 CDP 页面会保留各目标独立的日志

输入的 `timeout` 包含页面选择、准备和按键 RPC，最后一次响应超过期限时仍返回超时；执行结果无法确认时返回
`actionStatus="unknown"` 与 `retryable=false`，读取当前页面状态后再决定下一步

分组操作与页面解除受控按涉及的页面串行执行，并在持锁期间重新检查成员和操作权限；创建页面使用 `active`，`activate`
仅适用于 `movePage`

Popup 设置保存失败会显示错误，延迟返回的旧设置不会覆盖新设置；本地默认自动连接继续无需手动配对或点击连接

## 兼容客户端

| 客户端              | 状态 |
| ------------------- | ---- |
| Claude Code         | ✅   |
| Claude Desktop      | ✅   |
| Cursor              | ✅   |
| Windsurf            | ✅   |
| 其他 MCP 兼容客户端 | ✅   |

## 安装

需要 Node.js 20.19 或更新版本

### npm

```bash
npm install -g @pyrokine/mcp-chrome
claude mcp add chrome -- mcp-chrome
npm root -g
```

Extension 模式需要打开 `chrome://extensions/`，启用开发者模式，点击“加载已解压的扩展程序”，选择
`<npm-root>/@pyrokine/mcp-chrome/extension/dist`

### 从源码安装

```bash
git clone https://github.com/Pyrokine/claude-tools.git
cd claude-tools/mcp-chrome
npm install
npm run build
npm --prefix extension install
npm --prefix extension run build
claude mcp add chrome -- node "$PWD/dist/index.js"
```

Extension 模式需要在 Chrome 中加载 `extension/dist`

### Windows CDP 启动

Chrome 自动查找 Windows App Paths、`PATH`、已安装的 Chrome channels、Chromium、Chrome for Testing，以及
`MCP_CHROME_PORTABLE_DIR` 或 `%USERPROFILE%\\.mcp-chrome\\portable`，也可以在 PowerShell 中启动独立的 CDP 浏览器：

```powershell
& '<npm-root>\@pyrokine\mcp-chrome\scripts\start-chrome.ps1' -Port 9222
# 也可显式指定便携版可执行文件和独立 profile：
& '<npm-root>\@pyrokine\mcp-chrome\scripts\start-chrome.ps1' -Port 9222 -ExecutablePath 'C:\Browsers\chrome.exe' -ProfileDir 'C:\Temp\mcp-chrome-profile'
```

随后调用
`browse(action="connect", port=9222)`，脚本让 Chrome 进程保持前台运行，并报告退出码；使用独立 profile，避免请求被已有 Chrome 实例接管

## 快速开始

### 模式一：Extension 模式（推荐）

Extension 模式操控你现有的 Chrome——共享登录状态、Cookie 和浏览上下文

**第一步：安装 Chrome Extension**

1. 在 Chrome 中打开 `chrome://extensions/`
2. 开启右上角"开发者模式"
3. 点击"加载已解压的扩展程序" → 选择 `mcp-chrome/extension/dist/` 目录
4. 工具栏出现 MCP Chrome 图标

**第二步：配置 MCP 客户端**

```bash
# npm 安装
claude mcp add chrome -- mcp-chrome

# 源码构建
claude mcp add chrome -- node /path/to/mcp-chrome/dist/index.js
```

Claude Desktop / 其他客户端：

```json
{
    "mcpServers": {
        "chrome": {
            "command": "node",
            "args": ["/path/to/mcp-chrome/dist/index.js"]
        }
    }
}
```

**第三步：连接**

Extension 通过 HTTP/WebSocket 自动连接 MCP Server（端口 19222-19299），点击工具栏图标可查看连接状态，
`browse(action="connect")` 和本地 `/api/info`
会返回当前活动 Extension 后台 bundle 的 hash，并与 server 附带的 bundle 比较， `bundleStatus="stale"`
表示 Chrome 仍在执行旧的已解压 Extension，需要在 `chrome://extensions/` 刷新该 Extension，旧版 Extension 缺少
`network_challenge_state` 时会回退为 tab 标题和 DOM 的 Challenge 检测，bundle identity 不会关闭零配置自动连接

```
browse(action="list")          // 列出所有 Tab
browse(action="open", url="https://example.com")
extract(type="screenshot")
```

**配对 token**

Extension 模式默认保留零配置本地自动连接，在多用户机器、CI runner、或不可信本地进程可访问 `127.0.0.1:19222-19299`
的容器环境中，启动 MCP server 时设置 `MCP_CHROME_PAIRING_TOKEN`，再在 Extension popup 中输入同一个 token：

```bash
MCP_CHROME_PAIRING_TOKEN="your-token" node /path/to/mcp-chrome/dist/index.js
```

需要强制配对 token 时，在 server 设置 `MCP_CHROME_ALLOW_INSECURE_NO_TOKEN=0`，并在 Extension
popup 关闭“允许无 token 本地连接”，关闭后会立即取消进行中的 health
check、WebSocket 握手和已安排的重连，旧的无 token 连接尝试不会在策略更新后重新连入

### 模式二：CDP 模式（回退）

CDP 模式启动或连接独立的 Chrome 实例，适用于未安装 Extension 或需要无头/隔离的场景

```bash
# 启动带远程调试的 Chrome
google-chrome --remote-debugging-port=9222
```

```
browse(action="connect", port=9222)
browse(action="open", url="https://example.com")
```

> 已连接的 Extension 是所有工具的默认模式，Extension 不可用时才回退到 CDP，`browse(action="connect", port=9222)`
> 会为后续工具显式选择 CDP；调用不带 port 的 `browse(action="connect")`
> 会回到 Extension，仅因回退而建立的 CDP 连接会在 Extension 重连后让出默认模式

## 可用工具（8 个）

### browse - 浏览器管理与导航

| Action    | 描述                                         |
| --------- | -------------------------------------------- |
| `launch`  | Extension 可用时创建受控 Tab，否则启动 CDP   |
| `connect` | 默认确认 Extension，传 `port` 时显式选择 CDP |
| `list`    | 列出所有页面/Tab                             |
| `attach`  | 附加到指定页面/Tab                           |
| `open`    | 导航到 URL                                   |
| `back`    | 后退                                         |
| `forward` | 前进                                         |
| `refresh` | 刷新                                         |
| `close`   | 关闭 `targetId` 指定的页面                   |

Extension 特有：`list` 返回 flat `targets` 数组和树状 `windows`，每个 target 含 `managed`（Tab 是否由 MCP
Chrome 受控）、`isActive`（该窗口中 Chrome 的活动 Tab）、`windowId`、`index`、`pinned`、`incognito`、`status`（`loading`/`complete`），树状结构含
`windowCount`、`focusedWindowId`、`activeTargetId` 和每个窗口按顺序排列的 `tabs`，`defaultTargetId`
是默认操作目标，CDP 不用选中的操作目标推断浏览器前台页面，`open`
自动创建 Tab 分组（cyan 色），`open`、`back`、`forward`、`refresh` 支持 `diagnostics=true`，返回动作期间新增的 console
warning/error 和失败网络请求摘要，也覆盖首次 `open` 自动创建页面的场景，两个 driver 的 `open` 和 `refresh` 都支持
`wait="load"`、`wait="domcontentloaded"` 和
`wait="networkidle"`，等待器会在命令前建立，并绑定命令产生的新主文档，上一导航的迟到生命周期事件不会提前完成等待，CDP模式的
`networkidle` 等待当前主 frame loader 的 `networkIdle`
事件；Extension 模式会等待当前文档完成、所有已跟踪响应 body 结束和 500
ms 静默窗口，请求跟踪发生丢失时返回超时，不会误报空闲，`close` 必须传 `targetId`，且只关闭该页面，不会关闭整个 CDP 连接

Extension 模式的 `back/forward`
优先使用浏览器原生历史，只有原生 API 明确报告无历史时才允许尝试页面脚本；受限 URL 和浏览器错误页不注入没有可用历史时返回
`navigated=false`，其他原生错误保留；execution
context 失效或浏览器拒绝向错误页注入时，仍返回操作失败，Extension 将其记录为预期操作警告；任意 debugger 命令不自动重放

`open`、`back`、`forward`、`refresh` 的 `timeout`
从请求入口开始计时，页面准备、排队、协议请求、加载、Challenge 检查与点击、诊断和目标恢复共用剩余预算，导航 RPC 不额外增加传输时间队列中的动作到期后不再派发，后续请求仍等待原在途动作结束；显式
`timeout=0` 在导航派发前拒绝，页面创建保留独立的加载等待与传输余量合同

超时不会撤回已经派发的 Chrome 操作，结果未知时返回 `TIMEOUT`、`actionExecuted="unknown"`、`actionStatus="unknown"` 和
`retryable=false`，应读取实际页面状态，不重放导航 `pageContext.after` 使用实时快照，无法取得时为 null 并附
`contextError`；恢复预算耗尽时单独报告恢复失败，保留主动作结果 CDP 历史等待接受当前 session 主 frame 的 BFCache 恢复或同文档事件，普通 frame
commit、子 frame 和其他 session 的事件不作为完成信号

Challenge 点击、detach 和检查 RPC 携带剩余 deadline，排队或页面校验耗尽预算后不再派发；系统鼠标移动与 fallback 进程使用同一 deadline
CDP 已开始的按下始终尝试向原连接、原 session 释放，清理最多等待 1 秒，不向后来选择的目标发送只读 Challenge 检查到期返回
`CHALLENGE_TIMEOUT`，保留已知主动作状态；点击结果未知时返回 `TIMEOUT`、已知主动作状态、
`verificationStatus="unknown"`、`verificationActionExecuted` 和 `retryable=false`，不自动重放导航或点击

evaluate 在成功、动作失败、后置验证不匹配和输出失败时保留 Challenge 结果字段 `originResponsePending=true`
表示验证成功但源站尚未响应，不表示目标内容已加载

页面类工具在两种 backend 中都接受 `targetId`，旧版 `tabId`
仍可用；同时提供时两者必须一致，显式目标只作用于当前操作，结束后恢复原默认目标，`browse.close` 和 `manage.closePage`
必须显式指定 ID，页面动作成功或失败时，响应中的 `pageContext`
包含实际目标及来源（`explicit`、`default`、`created`、`reused`、`unconfirmed`）、前后 URL/revision、默认目标前后状态，以及 Extension 报告的浏览器活动目标；创建页面失败且未返回创建 ID 时标为
`unconfirmed`，CDP 的活动状态标为不可用，不把操作目标当作前台页面

旧 Extension 缺少 `page_snapshot` 时，无条件页面动作仍可使用实时页面列表中的 URL，`pageContext.before` 和 `after`
的快照返回 `revision=null`，并通过 `warning` 说明 revision 与原子条件不可用，传入 `expectedUrl` 或 `expectedRevision`
时在派发前返回 `DRIVER_CAPABILITY_ERROR`、`actionExecuted=false` 和
`actionStatus="not_started"`，更新 Extension 后才能使用这些条件 evaluate 和 input 保留
`failureStage="precondition"`，顶层状态与错误上下文一致，不派发脚本或输入事件其他快照错误仍阻止动作，兼容读取共用原 timeout 预算

Extension 页面快照确认目标 tab 已不存在时返回 `TARGET_NOT_FOUND`，保留 `context.targetId` 和原始
`context.nativeMessage`；输入派发前被拒绝时保留
`eventsExecuted=0`、`actionExecuted=false`，不改用其他页面或重放动作，用户脚本主动抛出同文案不归类为缺页

Chrome 已返回创建标识后，失败响应保留 `error.context.createdTargetId`、窗口 ID、实际 `managed`、`actionExecuted`、
`actionStatus="partial"` 和 `failureStage`；RPC 结果未知时，`actionStatus` 与 `actionExecuted` 均为 `"unknown"`
未取得创建标识的失败响应中 `pageContext.targetId=null`，不指向原默认页，不自动重复创建或删除

临时目标的恢复结果通过 `pageContext.targetRestoration` 单独报告，`restored` 表示恢复原默认目标，`cleared`
表示原先无默认目标并清除临时选择，`previous_target_closed` 表示原默认页已关闭并清除选择，`failed`
表示恢复或清理失败并清除临时选择；`error` 与 `cleanupError` 分别保存对应错误信息

主动作结果或原错误保留，已完成的输入不会重放，也不会报为未执行；`browse attach` 与 `manage adoptPage`
继续持久选择默认目标，并发响应记录各自实际操作的页面

`browse.list` 返回各页面的 revision 和元数据，revision 由 backend
epoch 与单页计数构成；Extension 跟踪主 frame 导航和 MCP 动作，CDP 跟踪已附加页面的导航，并保守计入发出的变更命令，包括 evaluate，网页自身的任意 DOM 更改不在跟踪范围内，条件动作前应重新获取 URL/revision，`browse`
导航/关闭、`input`、`evaluate` 及适用的 `manage` 页面动作接受 `expectedUrl` 和
`expectedRevision`；backend 检查不符时返回
`ACTION_PRECONDITION_FAILED`，不发送对应页面动作，复合动作在首个变更命令前检查，不在每个事件前重复检查；失败或超时后如已产生部分效果，revision 仍可能变化

`browse` 仅 `open`、`back`、`forward`、`refresh`、`close` 接受这两个条件，`attach` 等其他动作在改变目标前返回
`INVALID_ARGUMENT`

显式 `manage(action="adoptPage", targetId=...)` 将已有页面设为完整受控页，不聚焦或导航，`browse attach`
只选择目标；创建来源、分组归属和颜色不决定页面权限，`releasePage`
撤销完整权限，保留页面、窗口归属和分组，清理 MCP 日志状态、debugger 和 console 采集资源；Chrome 阻止资源清理时返回
`warnings`，完整权限仍被撤销

受控权限在 Service Worker 重启后保留，重载 Extension 后，仍存活且原文档身份一致的受控页也会恢复权限，无需刷新页面或重新 adopt
文档身份不可取得的页面在重载 Extension 后需要显式 `adoptPage`；正常导航保留受控权限，`releasePage`
撤销的权限在重启或重载后仍保持撤销，仅复用 tab ID 不会授权另一文档

受控页在 Service Worker 重启后可继续使用本 Extension 已有的调试连接，其他调试器占用仍返回 `DEBUGGER_BLOCKED`

通过 `manage(action="grantReadAccess", targetId=...)` 授予普通读取权限，用 `revokeReadAccess`
撤销，无需点击 popup；两个动作必须显式指定目标，可传
`expectedUrl`/`expectedRevision`；授权限定当前调用服务器实例、documentId、URL 和 revision，存储失败返回错误，不报告授权成功；popup 保留为可选入口，同一连接和文档未变化时，Service
Worker 重启后仍可读取；导航、关闭页面或断开连接后授权失效，仅指定 `targetId`
不授予读取权限；普通只读授权覆盖定向文本、HTML、属性、计算样式及页面状态读取，任意脚本、debugger、截图、输入和 Cookie 访问不继承授权，现有 Cookie 工具仍按独立的 URL/name 过滤规则执行

页面管理或导航因缺少受控权限而被拒绝时，不更新 revision，已有有效的普通只读授权保持不变

`manage(action="pageMetadata", targetId=...)` 可以读取或更新
`taskHint`、`note`，列表还会显示创建与最近使用时间；读取和更新都支持 `expectedUrl`/`expectedRevision`，不匹配时返回
`ACTION_PRECONDITION_FAILED`，不读取或更新备注；这些元数据只在服务器进程中保存，关闭页面时删除，不参与内容读取授权

### 访问验证

`open`、`back`、`forward`、`refresh`、`input` 和 `evaluate` 之后，MCP Chrome 会等待 Cloudflare JS Challenge 或 Turnstile
checkbox，Extension 模式下，导航先不启用 debugger 日志采集；Challenge 标题持续期间，前八秒只被动读取真实 tab 标题，interstitial 持续存在时，才检查可见 Turnstile 控件，找到后才点击，Extension
inspect 走 isolated world，Challenge 标题在检查前卸掉 debugger，普通页面检查保留已有调试连接，发现可见验证控件或仍需验证的正文后才卸除；同页测试按钮走页面点击，出现 Cloudflare Turnstile
iframe 时，把 inspect 的 CSS 坐标换成屏幕坐标，系统鼠标沿路径移动、悬停后再按下抬起：Linux 用 `xdotool` 读取活动 Chrome
client 窗口几何，用 `xprop` 读取 GTK frame
extents，窗口标题必须对应该测试页缺少工具、窗口数据无效或与页面视口不符时停止点击，不用 Chrome `screenX` 或
`outerHeight - innerHeight` 猜测内容原点；macOS 用 `cliclick` 或 System Events；Windows 用 PowerShell
`mouse_event`，widget 点 compact
Turnstile 卡片左侧 checkbox，宿主 wrapper 比卡片宽时也只点左侧卡片，不点文案，DOM 里已有 Cloudflare
iframe 时，即使 iframe 尺寸为 0，也走系统鼠标，不改用页面点击，后续宿主页 `Verify you are human` / `请验证您是真人`
按钮同样走系统鼠标，系统鼠标只在受控测试页已经是已聚焦窗口的活动 tab 时使用，混合窗口不会调用 `focusWindow`

系统点击前会卸掉 debugger，再读一次视口，缺少系统鼠标工具或窗口未聚焦时返回可见错误，不会静默改用 CDP 点击

widget 要连续两次 inspect 到同一坐标才点，不以普通元素的尺寸认定 widget；系统鼠标从远处过来时从控件附近起步，同一类 checkbox 或 compact
widget 在同一次等待里最多点一次；Cloudflare 随后换成可见的 `Verify you are human` 或 `请验证您是真人`
按钮时，inspect 判成 `verify` 后再点一次，访问受 Cloudflare 保护的页面默认保持
`diagnostics=false`，因为 diagnostics 会启用 debugger 的 console 和 network 采集

检测覆盖 `Just a moment...`、`请稍候…` 等标题、可见的 Challenge DOM、正文标记和 `Verify you are human` / `请验证您是真人`
控件，包括精确匹配这两种文案的可见 `button` 元素；普通标题也会进行有界的可见内容检查，可见的“正在进行安全验证”会阻止业务动作，隐藏标记不计入判定，无验证标记的页面不会固定等待八秒

没有 Cloudflare iframe 时，同页按钮使用页面点击，CDP 用 `Target.getTargetInfo` 读取实时标题
页面恢复后，仅残留 Cloudflare iframe 或旧 pending header 不算等待中，也不触发滚动或点击，缓存标题不参与判定
不会调用 CAPTCHA solver、自动重试导航或导出 `cf_clearance` 的值，CDP 超时不代表网站在用户真实 Chrome 中无法通过，排查网站前先检查返回的 `mode`

过盾成功时返回 `challengeResolved=true`、`challengeKind`、`waitedMs`、`clickedTurnstile` 和 `clearanceCookiePresent`
（只表示 cookie 名是否存在），页面可见文案显示验证成功、正在等待源站时，响应还会含
`originResponsePending=true`，表示已过盾但目标页面尚未加载，隐藏的成功文案（例如 `display:none`
的标题）不算过盾，可见 Turnstile 勾选框仍视为等待中，Challenge 成功和失败响应都含 `mode`，超时返回 `CHALLENGE_TIMEOUT`
且 `retryable=true`，并带 `clickedTurnstile` 和实际观察到的 `challengeKind`（点过 Turnstile 时不会报成 `js`），Access
denied 返回 `CHALLENGE_DENIED`，交互式验证码、Bot Fight
Mode 和 IP 声誉检查无法靠等待或点击 checkbox 完成，之后的正常主文档响应才会清掉 header 标记，普通 iframe 文档响应和清空网络日志都不会清掉它

### input - 键鼠输入

事件序列模型，支持任意组合：

| 事件类型                                | 描述                                                          |
| --------------------------------------- | ------------------------------------------------------------- |
| `keydown` / `keyup`                     | 按键按下/释放                                                 |
| `click`                                 | 点击（含可操作性检查：可见性、是否启用、遮挡检测、自动滚动）  |
| `mousedown` / `mouseup`                 | 鼠标按下/释放                                                 |
| `mousemove`                             | 鼠标移动                                                      |
| `wheel`                                 | 滚轮滚动                                                      |
| `touchstart` / `touchmove` / `touchend` | 触摸事件                                                      |
| `type`                                  | 输入文本                                                      |
| `wait`                                  | 事件间暂停                                                    |
| `select`                                | 按内容选中文本（鼠标模拟）                                    |
| `replace`                               | 查找并替换文本                                                |
| `drag`                                  | HTML5 拖放（MAIN 世界 DragEvent，需 `target` 源 + `to` 目标） |
| `editorContext`                         | 读取当前编辑器和选区上下文                                    |
| `editorInsert`                          | 在当前编辑器选区插入文本                                      |
| `editorCommand`                         | 执行 `bold`、`insertOrderedList` 等浏览器编辑命令             |

`events` 至少需要一个事件，参数：`humanize` 启用贝塞尔曲线移动和随机延迟，`diagnostics=true` 返回动作后新增 console
warning/error 和失败网络请求， `postCondition`
会在事件发送后等待页面状态，便于区分输入事件已发送和页面业务状态已完成，`postCondition.timeout` 默认 3000 ms、最大 60000
ms，`postCondition.interval` 默认 100 ms、范围 50-5000 ms，`postCondition.script` 可传表达式、函数、async
function 或 Promise 表达式；函数会被调用，最终 Promise 值会被等待后再判定，抛错或 reject 会让检查失败，`targetId`（或旧版
`tabId`）在两种 backend 中指定页面；`frame`
在 Extension 模式中指定 iframe（CSS 选择器或索引），传入任一作用域时，动作、诊断和 post-condition 使用该目标作用域选定的同一个 backend

验证期间 frame、执行 context 或 debugger 不可用时返回 `verificationStatus="unavailable"`，脚本抛错或 reject 返回
`error`，即使错误文案相同也按脚本异常处理；已完成的主动作保留 `actionStatus="completed"` 和
`failureStage="verification"`，验证不会重新执行主动作

键盘 `type` 的 `timeout` 包含 Challenge 等待、焦点准备、字符输入和 `delay`/`humanize` 延迟，Extension
precise/stealth 与 CDP 使用本次剩余预算，显式预算如 `timeout=45000`
允许合法输入持续超过默认的 30000ms，到期后停止后续字符与事件；已派发的输入不能撤回，超时可能留下部分输入，响应为
`actionExecuted=true`、`actionStatus="unknown"` 和 `retryable=false` 时，应独立读取页面确认实际值，不重放整个事件序列

鼠标目标查找、分步移动和 `humanize`
延迟也共用 input 剩余预算，每次移动和后续点击前检查截止时间，到期后停止后续移动和点击；已派发的原生事件不能撤回，结果为 unknown 时独立读取页面，不重放操作

命令聚焦、文本选择和替换共用事件剩余预算，到期后停止后续动作；Shift 按下后仍尝试释放，释放失败不隐藏原动作错误，CDP 分步触摸移动到期后也停止后续触摸点与事件

Stealth 左键派发 `click`，中键派发 `auxclick`，右键派发 `contextmenu`，每次按下和释放携带对应的点击
`detail`；只有左键多击在 `detail=2` 时派发 `dblclick`，独立 stealth `mouseup` 使用相同的按键映射

Stealth 的 `delay` 只作用于字符之间，首字符不额外等待；后台页面受定时器节流时，后续间隔会延长，本次预算仍限制后续输入

Extension precise 与 CDP 的键盘输入使用当前光标和选区，提供 `target`
会先点击目标并改变插入位置，向 contenteditable 末尾追加时，先聚焦并将光标放到末尾，再发送不带 `target` 的
`type`，避免再次点击改变位置

后台 CDP 点击和键盘输入无需激活页面，仍检查元素是否可见、可用且位置和尺寸稳定，必要时滚动到视口；点击还会检查遮挡目标查找、可操作性检查和最终坐标读取共用事件剩余预算，任一阶段耗尽预算后不派发鼠标或键盘事件

**`click` 专属参数**：`force: true` 必须提供 `forceReason` 和非坐标型元素
`target`，它会跳过可操作性检查（适用于测试隐藏元素等场景），但仍只分发标准 DOM 鼠标事件序列，不会直接调用框架私有 handler 中键、右键和多击采用同一检查规则，坐标型或省略 target 的点击不能使用 force，可操作性失败返回
`ACTIONABILITY_FAILED`，包含 `rect`、`clickPoint`、遮挡元素、候选遮挡物和修复建议， **`type`
专属参数**：`mode="controlled"` 或 `dispatch: true` 直接设置 `.value` 并触发 `input`/`change`
事件，兼容 React/Vue 等框架的受控组件（键盘事件无法触发状态更新时使用），需要非坐标型
`target`，仅限 Extension 模式，受控输入和目标查找失败时返回结构化 context，包含
`locator`、`matchCount`、`nth`、有数量上限的 `candidates` 和不含输入值的 `activeElement`
摘要，焦点不可取得时返回 null，DOM 查询失败时还返回 `diagnosticError` 选区相关错误另含编辑器与选区状态，password
input 的 value 不进入失败诊断，失败响应也会脱敏 input 事件传入的 `find` 和替换 `text`，`select` 和 `replace` 的事件级
`nth` 表示文本第 N 次出现，嵌套的 `target.nth` 表示第 N 个目标元素，两者都从 0 开始并可同时使用，CDP 模式的 locator
target 不依赖 Extension refId

两种 backend 的 `input`、`extract`、`wait` 定位失败都在请求预算内返回失败 locator、从 0 开始的 `nth`、URL、tab/frame 作用域、managed 状态、最后定位状态及最多 10 个候选摘要
`matchCount` 表示实际观察到的匹配总量，不受候选摘要上限限制，nth 越界不会把 15 个匹配写成 0；匹配数或 managed 状态无法确认时返回 null，诊断不可用时返回 `diagnosticError`
CDP 查找失败保留 `ELEMENT_NOT_FOUND`，元素等待保留 `TIMEOUT`，原 URL 和日志字段继续保留，诊断在退出失败目标作用域前读取，不重放输入

**`keydown` 专属参数**：

- `commands`：触发浏览器原生编辑命令（如 `["selectAll"]`、`["copy"]`、`["paste"]`、`["cut"]`、`["undo"]`、`["redo"]`
  ），成功表示浏览器已接受命令分发，页面结果需用 `postCondition` 或 `extract`
  验证，仅 precise 模式可用，stealth 模式下抛错（CDP commands API 没有 JS 事件等价物）命令分发前只聚焦元素或坐标
  `target`，不派发鼠标事件，坐标聚焦不会改变 checkbox、跟随链接或调用 click 监听器；目标缺失或无法聚焦时，在分发命令前返回错误，Extension 的
  `frame` 坐标相对于所选 iframe
- 连续 `keydown` 同一 key 自动切换为 `rawKeyDown` + `autoRepeat`，模拟长按重复（与 Puppeteer 一致）

### extract - 内容提取

| Type         | 描述                                   |
| ------------ | -------------------------------------- |
| `text`       | 提取文本内容                           |
| `html`       | 提取 HTML 源码                         |
| `frameHtml`  | 提取指定 iframe 的 HTML                |
| `attribute`  | 提取元素属性                           |
| `screenshot` | 截图（支持 `target` 元素裁剪）         |
| `state`      | 获取页面状态（URL、标题、可交互元素）  |
| `metadata`   | 提取页面元信息（标题、OG、JSON-LD 等） |

文本提取对整页和所选 HTML 元素使用浏览器的 `innerText`，已渲染区域不包含后代 `style`/`script`
源码或隐藏后代文本；显式选择不可渲染的 HTML 元素时遵循浏览器 `innerText` 规则，SVG/XML 节点使用
`textContent`，源码请使用 `html`

参数：`output` 将结果保存到文件（`images=data` 时为输出目录），`images`（`info`/`data`）提取 HTML 中的图片元信息或数据，
`frameHtml` 在 `frame` 路由后提取当前 iframe 文档，截图支持 `clip` 坐标区域、`compareWith` PNG 基准对比和 `diffOutput`
差异图输出，`diffOutput` 必须同时传 `compareWith`，指定 `target` 的截图未匹配、`nth`
越界或尺寸为零时返回目标错误，不会静默返回视口截图，截图响应包含
`metadata.format`、`width`、`height`、`dimensionSource`、`byteSize`、`fullPage`、`scale`、`clip` 和
`capabilities`，截图在执行前限制单边 16,384 像素、总计 12,000,000 像素、预计 RGBA 内存 48 MiB 和编码数据 25
MiB；基准 PNG 在读取前检查文件大小，对比在解码前限制单个 PNG 25
MiB 和 12,000,000 像素，解压时按已校验尺寸限制输出，并要求 scanline 长度精确匹配；损坏或异常膨胀的 PNG 会被拒绝，较大截图应使用
`clip` 或 `scale` 缩小，截图与 diagnosticBundle 在 Extension 和 CDP 模式中都返回
`hiddenTabScreenshot=false`，Extension 隐藏页截图返回 `HIDDEN_TAB_SCREENSHOT`，不自动激活，`state` 返回
`interactiveElements`，Extension 和 CDP 模式下 `metadata` 都返回 `frames` 和实际文档 `url`，Extension 指定 `frame`
时返回该 iframe 文档地址；CDP 无法取得的已声明帧字段保留为 `null`，包括 DOM
selector 和所属元素 rect，帧树顺序与 ID 保持不变；元信息还返回页面当前的 `managed` 状态与 `metadata` 对象，其
`createdBy`、`createdAt`、`lastUsedAt`、`taskHint` 和 `note` 与 `browse list`、`manage pageMetadata`
一致，inline 与文件输出包含相同字段；`frame` 指定 iframe 文档时，备注仍属于该页面，`managed`
表示 Extension 页面托管状态，CDP 返回 false，不限制已连接 CDP 的正常操作，备注只保存在当前 Server 进程，未知创建来源返回
`unknown`，其他 Server 不继承这些备注，不能据此判断跨会话归属或取得权限；如果其他 debugger 占用 precise 截图路径，可视区域 fallback 会返回
`degraded`、`fallback` 和 `limitations`；fallback 不支持的参数返回结构化
`SCREENSHOT_FALLBACK_UNSUPPORTED`，`targetId`（或旧版 `tabId`）在两种 backend 中指定页面，`frame`
仅在 Extension 模式中指定 iframe

**`attribute` 特殊前缀**：`computed:<属性名>` 返回 computed CSS 样式值（如 `computed:color`、`computed:font-size`），
`computed:*` 返回全部计算样式（300+ 属性，建议配合 `output` 写文件）

**`state` 专属参数**：`depth` 控制无障碍树的 DOM 遍历深度（默认 15），减小可降低大页面的返回数据量 `mode` 选择
`accessibility`（默认，从无障碍树派生）或 `domsnapshot`（原始
`DOMSnapshot.captureSnapshot`，支持 CDP 或受控 Extension 页面）DOMSnapshot 返回整页快照，传入 `target`、`frame` 或
`depth` 限定时明确拒绝，普通只读授权不包含 debugger 权限无关 iframe 探测失败时，metadata 通过 `unavailableFrames`
和对应帧的 `unavailableReason` 标明原因，能够唯一验证的所选 iframe 继续可用

### wait - 等待条件

| For          | 描述                                         |
| ------------ | -------------------------------------------- |
| `element`    | 等待元素（visible/hidden/attached/detached） |
| `navigation` | 等待导航完成                                 |
| `time`       | 固定延迟                                     |
| `idle`       | 等待 DOM 或网络静默期                        |

参数：`targetId`（或旧版 `tabId`）在两种 backend 中指定页面，`frame` 在 Extension 模式中指定 iframe

CDP 模式的 `visible` 要求 DOM 矩形宽高非零，且 CSS 不隐藏元素（`display:none` 或 `visibility:hidden/collapse`） `hidden`
接受这些隐藏状态或元素不存在，`attached` 和 `detached` 只检查元素是否存在

**`idle` 说明**：Extension 模式会在 `readyState === 'complete'` 后注入 `MutationObserver`，等待 `ms`
毫秒内无 DOM 变更；CDP 模式等待网络静默，两种模式的默认 `ms` 都是 500ms，响应返回 `idleKind` 和
`idlePeriodMs`，Extension 响应还返回 `domStable`

### evaluate - JavaScript 执行

在页面上下文执行 JavaScript

| 参数                 | 描述                                                    |
| -------------------- | ------------------------------------------------------- |
| `script`             | JavaScript 代码，裸 `return` 语句自动包裹 IIFE          |
| `scriptFile`         | 从本地文件读取脚本，与 `script` 二选一                  |
| `args`               | 函数参数，`[]` 调用零参函数；省略时按原脚本语义执行     |
| `mode`               | `precise`（默认，debugger API）或 `stealth`（JS 注入）  |
| `staleContextRetry`  | iframe stale context 策略，`never`（默认）或 `readOnly` |
| `output`             | 将结果保存到文件                                        |
| `targetId` / `tabId` | 在两种 backend 中指定页面（`tabId` 为兼容别名）         |
| `frame`              | 指定目标 iframe（CSS 选择器或索引，Extension 模式）     |
| `timeout`            | 端到端超时预算（毫秒）                                  |
| `diagnostics`        | 执行后返回新增 console warning/error 和失败网络请求摘要 |
| `postCondition`      | 执行后等待文本、selector、URL 片段或脚本结果匹配        |

`script` 和 `scriptFile` 至少提供一个，互斥使用，相对 `scriptFile` 和 `output` 路径默认写到 `mcp-chrome`
管理的系统临时目录，需要把文件留在当前工作目录时，用 `cwd:relative/path` 显式指定，相对路径会拒绝
`..`，Windows 下也会拒绝 `:`，避免落到 NTFS alternate data stream，`output` 对字符串写原始文本，对其他类型写 JSON

结果超过 100KB 时自动写入文件到受控的系统临时目录，返回文件路径和大小，返回 DOM 节点、`NodeList` 或 `HTMLCollection`
时返回 `NON_SERIALIZABLE_EVALUATE_RESULT`，并提示改为返回 `textContent`、`outerHTML`
等简单字段，结果展开或序列化失败时返回 `actionExecuted=true`、`actionStatus="completed"` 和
`failureStage="output"`，因为页面脚本已经完成，evaluate 即使在全局 `inputMode=stealth` 时也默认使用 `precise`，其
`postCondition` 检查与主动作使用相同 evaluate mode，`postCondition` 不传时， `success=true`
只表示脚本完成执行并返回；传入后如果超时仍不匹配，返回 `POST_CONDITION_FAILED` 和最后一次检查结果，iframe
precise 执行默认不在 execution context 失效后重放脚本，只有脚本无副作用时才应传
`staleContextRetry="readOnly"`，Extension 会在剩余 timeout 内重新解析 context，并最多重放一次，重试解析期间 Chrome 仍返回已移除的 document 时，会在同一预算内等待当前 document，不增加脚本执行次数；权限拒绝立即结束，`Runtime.evaluate`
发出后发生 stale context 时返回
`actionExecuted=true`、`actionStatus="unknown"`，因为脚本可能已经产生部分副作用，但无法取得最终结果

Extension precise 主 frame 的对象结果，显式指定 `output` 时字符预算为 16
Mi（16777216），未指定时保留 1000000，自动保存仍受该上限约束，两条路径均保留深度 8、节点 2000 和不可序列化结果拒绝，字符预算按 UTF-16
code units 计，不等于输出文件的 UTF-8 字节数；`tmp:`
文件还受临时输出配额约束，超限返回当前上限，并保留脚本已完成、输出失败的状态，不重放脚本

### manage - 页面与环境管理

| Action             | 描述                                             |
| ------------------ | ------------------------------------------------ |
| `newPage`          | 新建受控页面/Tab                                 |
| `pageMetadata`     | 读取或设置页面的 `taskHint`、`note`              |
| `closePage`        | 关闭受控页面并返回 `affected.before/after`       |
| `adoptPage`        | 授予已有 Tab 完整受控能力，不改变前台            |
| `releasePage`      | 将受控页移出管理，不关闭页面                     |
| `grantReadAccess`  | 为当前调用实例授予显式页面的普通只读权限         |
| `revokeReadAccess` | 撤销当前调用实例的普通只读授权                   |
| `updatePage`       | 更新原生 tab 属性并返回实际状态                  |
| `movePage`         | 将受控 Tab 移到指定窗口或 index                  |
| `reorderPage`      | 调整受控 Tab 在当前窗口内的顺序                  |
| `pinPage`          | 固定受控 Tab                                     |
| `unpinPage`        | 取消固定受控 Tab                                 |
| `activatePage`     | 激活显式页面，Extension 要求目标 Tab 受控        |
| `focusWindow`      | 聚焦显式指定的窗口                               |
| `resizeWindow`     | 调整显式指定窗口的尺寸或状态                     |
| `newWindow`        | 新建受控窗口                                     |
| `closeWindow`      | 仅当窗口内全是 managed tab 时关闭窗口            |
| `updateWindow`     | 更新原生窗口位置、状态、焦点或提醒               |
| `groupPages`       | 创建分组或将受控页加入已有分组                   |
| `ungroupPages`     | 解除分组归属，保留受控权限                       |
| `updateGroup`      | 更新分组名称、颜色和折叠状态                     |
| `moveGroup`        | 将分组及其成员移动到指定窗口或位置               |
| `clearCache`       | 清除缓存/存储（清除 Cookie 请用 `cookies` 工具） |
| `viewport`         | 设置视口大小                                     |
| `userAgent`        | 设置 User-Agent                                  |
| `emulate`          | 设备模拟（iPhone、iPad 等）                      |
| `inputMode`        | 查询或设置输入模式（`precise` / `stealth`）      |
| `stealth`          | 注入反检测脚本                                   |
| `cdp`              | 发送原始 CDP 命令（高级，如 `Runtime.evaluate`） |

原生 tab/window/group 配置使用 Extension 模式，`activatePage` 同时支持 CDP，操作已有对象时用
`targetId`、`targetIds`、`windowId` 或 `groupId` 明确指定目标，返回 `affected.before/after`，分组结果还返回
`tabsBefore/tabsAfter`，`ungroupPages`
由 Chrome 删除空组，不撤销成员的受控权限窗口显示操作和分组名称、颜色、折叠更新按显式 `windowId` 或 `groupId`
执行，允许包含非托管成员，成员页面权限保持不变整组移动和关闭整窗继续要求全部受影响成员受控，加入或解除指定页面分组只检查指定页面，无关成员变化不阻止有效选择默认创建页面继续复用有效的缓存 MCP 窗口，混入非托管 tab 不触发新建窗口 Extension 模式不支持
`clearCache`，会返回 `UNSUPPORTED_MODE` 且不清除任何内容；清 Cookie 请用带 `url` 或 `domain` 过滤的
`cookies(action="clear")`，清 storage 或 cache 请改用 CDP 模式，`focusWindow`
只有在观测到目标窗口已聚焦后才返回成功，否则返回 `WINDOW_FOCUS_NOT_OBSERVED`，`closeWindow`
遇到混有非托管 tab 的窗口会返回 `WINDOW_HAS_UNMANAGED_TABS`，持久的 `adoptPage`、`releasePage`
目标变更与指定 tab 的操作串行执行，并发多事件 input 会始终留在指定 tab，持久目标变更会在该操作结束后生效

CDP 的 `activatePage` 保留默认操作目标，只返回该 backend 能实际读取的字段，不构造 `active`
值或系统窗口焦点状态 Extension 的 `viewport`、`userAgent`、`emulate`、原始 `cdp` 和 precise `evaluate` 支持受控
`about:blank` 页面，Chrome 内部页和 Extension 页继续受原生访问限制不带 `device` 的 `manage(action="emulate")`
直接查询本地设备目录，无需有效页面，携带页面条件时明确拒绝；实际设置设备继续校验目标页面和条件

| 动作                            | 原生参数                                                                                                                              | 行为                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `newPage`                       | `url`、`windowId`、`index`、`active`、`pinned`、`openerTabId`、`groupId`、`timeout`                                                   | `active` 默认 false，`groupId=-1` 不分组，显式位置不受默认显示分组改变                                 |
| `updatePage`                    | `url`、`active`、`pinned`、`highlighted`、`muted`、`autoDiscardable`、`openerTabId`                                                   | 必须传 `targetId`，只支持 `active=true` 且不聚焦窗口，`active=false` 在任何更新前拒绝                  |
| `groupPages`                    | `targetIds`、`groupId`、`windowId`、`title`、`color`、`collapsed`                                                                     | 省略 `groupId` 时在成员原窗口创建分组，跨窗口成员须指定 `windowId`，加入已有组仅传 `targetIds/groupId` |
| `ungroupPages`                  | `targetIds`                                                                                                                           | 解除分组，保留受控能力                                                                                 |
| `updateGroup`                   | `groupId`、`title`、`color`、`collapsed`                                                                                              | 空名称及 false 折叠值按原值设置                                                                        |
| `moveGroup`                     | `groupId`、`windowId`、`index`                                                                                                        | 移动全部成员，`index=-1` 表示窗口末尾                                                                  |
| `newWindow`                     | `url` 或 `urls`、`targetId`、`windowType`、`focused`、`incognito`、`left`、`top`、`width`、`height`、`windowState`、`setSelfAsOpener` | normal 支持多 URL 及同时移入已有受控页，popup 只接受一个页面，所有新建页受控且分别记录创建来源         |
| `updateWindow` / `resizeWindow` | `windowId`、`left`、`top`、`width`、`height`、`windowState`、`focused`、`drawAttention`                                               | 应用 Chrome 支持的窗口配置并返回观测状态                                                               |

`updateWindow` 与 `resizeWindow` 修改状态或几何后等待浏览器观测稳定，非 normal 窗口同时请求 `windowState="normal"`
和 bounds 时，状态转换完成后才应用一次几何参数，OS 调整后的几何按实际值返回有界等待内仍未观测到稳定状态时，`WINDOW_UPDATE_NOT_OBSERVED`
返回部分执行状态及最后观测的窗口信息，再次更新前用 `browse list` 检查实际状态

`browse list` 默认 `details="summary"`，返回页面标识、URL/标题、位置、managed/revision 和元数据；传 `details="full"`
获取选中、静音、自动丢弃、来源 tab ID 和可用原生只读属性，false 值保留，`targetIds` 与 `managedOnly=true`
筛选页面及所属窗口、分组；`totalTargetCount`、`totalWindowCount` 和 `totalTabCount` 区分总量与选中数量
窗口通过 `targetIds` 引用页面，不重复完整对象；favicon data URL 不内联，完整结果用 `favIconInline=true` 标明存在
分组保留名称、颜色、折叠/共享、窗口、首个成员位置和成员 ID，颜色只属于分组，只读属性只回显，不作为写入参数，列表操作不读取页面正文，不导航或改变焦点

旧 Extension 只返回分组摘要、未提供成员数组时，按同次响应的窗口和 tab 归属恢复组成员及首个成员位置，summary/full 和筛选继续可用，无需额外 RPC
完全没有分组信息时，响应省略 `groups`，并用 warning 说明分组信息不可用；明确提供的 `groups: []` 表示没有分组，只提供一个成员数组等畸形分组数据返回错误

页面和分组移动接受
`index=-1`，新建页的 index 非负，来源 tab 与显式分组、窗口必须位于同一窗口，固定页不能在分组中创建窗口状态与位置/尺寸的冲突、动作不支持的字段在修改前拒绝，CDP 明确拒绝不支持的 Chrome
UI 配置，不静默忽略 `newWindow` 的 `url` 与 `urls` 是两种互斥输入方式，在 normal 窗口中可与 `targetId`
同时使用 popup 只接受单个 URL 或一个已有页面，不能同时创建额外 URL 页面，明确的创建前拒绝保留
`actionExecuted=false`、`actionStatus="not_started"`、`failureStage="preflight"`，更新在执行前拒绝时保留原 revision，原生更新已派发后的失败仍使 revision 失效

`emulate` 在两个 backend 中设置设备视口、像素密度、触摸能力和 User-Agent，`viewport`
恢复桌面视口与页面缩放并关闭触摸模拟，User-Agent 通过 `userAgent` 单独恢复

**Stealth 模式档位**（CDP launch 参数，通过 `browse action=launch stealth=...` 设置）：

- `off` — 关闭反检测（纯净模式，适合测试/CI）
- `safe`（默认）— 最小改动（移除 `navigator.webdriver`、清理 CDP 痕迹）
- `aggressive` — 增加少量 WebGL/插件/语言等指纹修补（不等于完整伪装）

### logs - 浏览器日志

| Type      | 描述                          |
| --------- | ----------------------------- |
| `console` | 控制台日志（支持级别过滤）    |
| `network` | 网络请求日志（支持 URL 过滤） |

参数：`output` 将结果保存到文件，console 日志统一返回公开级别 `error`、`warning`、`info`、`debug`，浏览器原始的 `warn`、
`log` 等级会在过滤和返回前转换，清空 fallback
console 日志会保留 hook，debugger 采集恢复后，fallback 采集会停用；仍指向 MCP
wrapper 的 console 方法会恢复，页面之后安装的 wrapper 保持不变，network 日志在 `loadingFinished` 或 `loadingFailed`
时才完成记录，不会在收到 headers 时提前结束，因此 body 失败会同时保留 HTTP status 和
`errorText`，传输中的 body 也会继续计入 `networkidle`，日志尽量返回 `method`、
`url`、`status`、`timestamp`、`duration`，URL
query 中常见的认证、签名、密码和 token 参数会在内联响应、diagnostics 和 显式 `output` 文件中替换为 `[REDACTED]`，并返回
`urlRedacted`、`urlOriginalLength` 和
`redactedQueryParameters`，内联 network 结果会把脱敏后的单条 URL 限制为 2048 字符，截断时返回 `urlLength` 和
`urlTruncated: true`，`urlPattern` 支持 `*` 匹配任意长度字符、`?` 匹配单个字符，`tabId`
指定目标 Tab（Extension 模式），`frame` 不适用于日志

Extension debugger 不可用时，network 每次读取都会刷新 performance 记录并标记
`source="performance"`；状态使用浏览器提供的 `responseStatus`，无法取得时为
`0`，未知请求方法保留空值，重复读取保留记录序列号；`clear`
清除 MCP 记录并推进当前文档的读取边界，不清除网页共享的 performance 数据，新文档重新建立边界，读取失败返回错误，不冒充空日志

### cookies - Cookie 管理

| Action   | 描述                                                   |
| -------- | ------------------------------------------------------ |
| `get`    | 获取 Cookie                                            |
| `set`    | 设置 Cookie                                            |
| `delete` | 删除 Cookie                                            |
| `clear`  | 在 URL 或域名范围内删除 Cookie，可用 `name` 进一步过滤 |

**说明**：`clear` 必须指定 `url` 或 `domain`，`name` 只能在该范围内进一步过滤，避免误删其他站点的同名 Cookie，返回的
`count` 只统计 Chrome 确认已删除的 Cookie；列出后、删除前已消失的 Cookie 不计数

## Target：统一元素定位器

所有工具使用统一的 `Target` 类型定位元素：

```typescript
// 按可访问性（推荐 - 最稳定）
const byRole = { role: 'button', name: '提交' }

// 按可访问性精确匹配名称
const byExactRole = { role: 'button', name: '提交', exact: true }

// 按文本内容
const byText = { text: '点击这里', exact: true }

// 按表单 label
const byLabel = { label: '邮箱' }

// 按 placeholder
const byPlaceholder = { placeholder: '请输入姓名' }

// 按 title 属性
const byTitle = { title: '关闭对话框' }

// 按 alt 文本（图片）
const byAlt = { alt: '头像' }

// 按 test ID
const byTestId = { testId: 'submit-button' }

// 按 CSS 选择器
const byCss = { css: '#login-form .submit-btn' }

// 多匹配消歧（从 0 开始）
const secondMatch = { css: '.ant-select-input', nth: 1 }

// 按 CSS + 文本（按文本内容过滤）
const byCssText = { css: 'button', text: '提交', exact: true }

// 按 XPath
const byXPath = { xpath: "//button[@type='submit']" }

// 按坐标
const byCoordinates = { x: 100, y: 200 }
```

## 使用示例

### 基础：列出 Tab 并导航

```
browse(action="list")
browse(action="open", url="https://example.com")
extract(type="state")
```

### 点击按钮

```
input(events=[
  { type: "mousedown", target: { role: "button", name: "提交" } },
  { type: "mouseup" }
])
```

### 在输入框输入

```
input(events=[
  { type: "mousedown", target: { label: "邮箱" } },
  { type: "mouseup" },
  { type: "type", text: "user@example.com" }
])
```

### 多 Tab 操作（Extension 模式）

```
// 对指定 Tab 操作，不切换焦点
extract(type="screenshot", tabId="12345")
evaluate(script="document.title", tabId="12345")
```

### 截图

```
// 全页面
extract(type="screenshot", fullPage=true)

// 元素截图（支持所有 target 类型）
extract(type="screenshot", target={ role: "button", name: "提交" })

// JPEG + quality（更小体积）
extract(type="screenshot", format="jpeg", quality=80, output="tmp:screenshot.jpg")

// 保存到文件
extract(type="screenshot", output="tmp:screenshot.png")
```

### 提取 HTML 及图片

```
// 获取 HTML + 图片元信息（src、alt、尺寸）
extract(type="html", target={ css: ".article" }, images="info")

// 获取 HTML + 图片数据，保存到目录
extract(type="html", images="data", output="tmp:page")
// 生成：<系统临时目录>/claude-tools/mcp-chrome/session-<id>/page/content.html, images/*, index.json

// 获取 HTML + 图片数据（内联返回，最多 20 张）
extract(type="html", target={ css: ".card" }, images="data")
```

`tmp:` 路径属于当前 server 会话，临时输出整个会话最多 256 项、128
MiB；启动时只清理超过 24 小时且所属进程已退出的带归属标记目录，成功写入 `tmp:` 文件或目录的响应会返回 `retention`
清理条件，`cwd:` 响应不带此字段，重启后仍需通过 MCP 访问的文件使用
`cwd:`，输出路径拒绝 Windows 保留设备名、ADS、非法字符以及末尾空格或点号；Windows 上写入敏感内容前须验证私有 DACL

路径语法错误返回 `INVALID_ARGUMENT`，允许 `.` 组件，继续拒绝 `..` 组件根目录外的路径及链接越界返回
`PATH_NOT_ALLOWED`，两类错误均在 `error.context.cwd` 返回 server 的实际工作目录，范围拒绝另返回 `allowedRoots` 使用
`cwd:` 指定相对于该目录的路径，或使用 `tmp:` 保存会话输出，`scriptFile` 与 `compareWith` 遵循相同校验

配额拒绝返回 `TEMP_OUTPUT_QUOTA_EXCEEDED`，`error.context` 包含 `limits`、`usage`、`remaining`、`requested` 和
`projected`， `usage.complete=false` 时，占用只为已观察下界，`remaining`/`projected`
为 null；已有输出保留，evaluate 的输出失败保留
`actionExecuted=true`、`actionStatus=completed`、`failureStage=output`、`retryable=false`，不重放脚本，后续输出可使用
`cwd:` 指定仓库内路径

### 页面元信息

```
// 提取标题、OG 标签、JSON-LD、RSS 等
extract(type="metadata")
```

### iframe 操作（Extension 模式）

```
// 通过 CSS 选择器指定 iframe
evaluate(script="document.title", frame="iframe#main")

// 通过索引指定 iframe
extract(type="text", frame=0)

// 在 iframe 内输入
input(events=[
  { type: "mousedown", target: { label: "用户名" } },
  { type: "mouseup" },
  { type: "type", text: "admin" }
], frame="iframe.login-frame")
```

CSS 选择器和数字索引按父文档的 DOM
iframe 顺序定位，DOM 中不存在的子 frame（包括其他 Extension 加入的 frame）不会改变索引，也不会成为候选目标，所选元素无法对应到唯一 Chrome
frame 时返回 `FRAME_IDENTITY_UNAVAILABLE`，不会选择其他 frame；precise
evaluate 按含 query 和 fragment 的完整 URL 定位，并按所选 DOM iframe 区分 URL 相同的 frame，包括
`about:srcdoc`，无法确认身份时拒绝执行

frame 定位失败分别返回 `INVALID_FRAME_SELECTOR`、`FRAME_NOT_IFRAME` 或 `FRAME_NOT_FOUND`，读取注入区分
`INVALID_SELECTOR`、`FRAME_STALE_CONTEXT`、`FRAME_INJECTION_DENIED`、`FRAME_SCRIPT_FAILED`、 `FRAME_INJECTION_FAILED` 和
`FRAME_SCRIPT_NO_RESULT`，并报告注入或脚本结果阶段，无结果不等于 selector 非法，空文本、空元素数组、null 属性值和 void 脚本调用保持原语义，错误不会重放脚本；成功定位后的读取失败在
`pageContext.frameContext` 保留 DOM 索引、Chrome frame ID 和可取得的文档身份；frame
URL 诊断去掉认证、query 和 fragment，长度限制为 500 字符，`data:` 与 `javascript:` 只返回协议；无法解析的 URL 返回
`url=null` 和 `urlStatus="unavailable"`

### 等待元素

```
wait(for="element", target={ text: "加载完成" }, state="visible")
```

## 架构

```
┌───────────────────┐
│    MCP 客户端     │
│   (Claude 等)     │
└─────────┬─────────┘
          │ stdio (JSON-RPC)
          ▼
┌───────────────────┐
│    MCP-Chrome     │
│   (8 个工具)      │
│  ├─ core/         │  UnifiedSession, Locator, AutoWait
│  ├─ cdp/          │  原生 CDP 客户端
│  ├─ extension/    │  Extension 桥接（HTTP + WebSocket）
│  └─ tools/        │  工具实现
└────┬─────────┬────┘
     │         │
     │ HTTP/WS │ WebSocket (CDP)
     │         │
     ▼         ▼
┌──────────┐  ┌──────────────────┐
│ Extension│  │ Chrome (CDP)     │
│ (19222+) │  │ (端口 9222)      │
│          │  │ 独立浏览器实例    │
│ 操控用户 │  └──────────────────┘
│ 现有浏览 │
│ 器       │
└──────────┘
```

## 项目结构

```
mcp-chrome/
├── src/
│   ├── index.ts              # MCP Server 入口
│   ├── tools/                # 8 个 MCP 工具
│   │   ├── browse.ts
│   │   ├── input.ts
│   │   ├── extract.ts
│   │   ├── wait.ts
│   │   ├── manage.ts
│   │   ├── logs.ts
│   │   ├── cookies.ts
│   │   ├── evaluate.ts
│   │   └── schema.ts         # 公共 JSON Schema（Target oneOf）
│   ├── core/                 # 核心抽象
│   │   ├── unified-session.ts # 双模式会话（Extension + CDP）
│   │   ├── browser-driver.ts # IBrowserDriver 抽象
│   │   ├── session.ts        # CDP 会话管理
│   │   ├── locator.ts        # 元素定位器（deadline 超时预算）
│   │   ├── auto-wait.ts      # 自动等待机制
│   │   ├── retry.ts          # 重试逻辑
│   │   ├── types.ts          # 类型定义
│   │   ├── utils.ts          # 公共工具
│   │   ├── errors.ts         # 错误类型
│   │   └── index.ts          # 模块入口
│   ├── extension/            # Extension 桥接
│   │   ├── bridge.ts         # 高层 Extension API
│   │   └── http-server.ts    # HTTP + WebSocket 服务器
│   ├── cdp/                  # CDP 层
│   │   ├── client.ts         # WebSocket CDP 客户端
│   │   └── launcher.ts       # Chrome 启动器
│   └── anti-detection/       # 反检测（可选）
│       ├── injection.ts
│       └── behavior.ts
├── extension/                # Chrome Extension（Manifest V3）
│   ├── manifest.json
│   ├── src/
│   │   ├── background/       # Service Worker
│   │   ├── content/          # Content Scripts
│   │   └── popup/            # Popup UI
│   └── dist/                 # 构建产物（在 Chrome 中加载此目录）
├── scripts/
│   ├── start-chrome.sh
│   └── start-chrome-headless.sh
└── package.json
```

## 安全说明

- **信任边界**：Extension 模式默认自动连接本地 MCP server，在多用户系统、CI runner、`--net=host` 容器等不可信代码可访问
  `127.0.0.1:19222-19299` 的环境中，应使用 `MCP_CHROME_PAIRING_TOKEN`，或设置 `MCP_CHROME_ALLOW_INSECURE_NO_TOKEN=0`
  ，WebSocket 握手要求 `chrome-extension://` Origin 头，可挡掉浏览器页面和 curl，但拦不住同 UID 的本地恶意进程
- Extension 模式：共享浏览器会话，请仅在受信任的机器上使用
- CDP 模式：通过 DevTools Protocol 提供完整浏览器控制能力
- 默认端口仅绑定到 127.0.0.1（本地访问）
- `evaluate` 工具可执行任意 JavaScript
- `manage cdp` 操作可发送任意 CDP 命令
- 网络 URL 中的常见认证参数默认会脱敏，但 console 文本和非标准参数名仍可能包含敏感信息

### 反检测（stealth）—— 实际能力

`stealth` 模式（`safe` / `aggressive`）仅覆盖少量指纹面：

- **覆盖**：`navigator.webdriver`、`cdc_*` 属性、User-Agent 字符串、若干 WebGL vendor/renderer 值、Chrome runtime 属性
- **不覆盖**：Canvas 指纹、AudioContext 指纹、Font 枚举、TLS 层指纹（JA3/JA4）、CDP
  attach 横幅（"Chrome 正受自动化软件控制"）、扩展自身存在的探测
- **警告**：这些修补不能过 Cloudflare，JS Challenge 和 Turnstile
  checkbox 由导航、input、evaluate 之后在真实浏览器里等待处理，不覆盖 Akamai、DataDome、PerimeterX、交互式验证码或 IP 声誉

## 已知限制

- **仅 Chrome**：仅支持 Chrome/Chromium 浏览器（不支持 Firefox/Safari）
- **CDP 单会话**：CDP 模式仅支持一个浏览器会话
- **Extension 需要 Chrome**：Extension 为 Manifest V3，仅限 Chrome
- **iframe**：仅支持单层 iframe 定位（不支持嵌套 `>>` 语法）；仅限 Extension 模式

## 许可证

MIT 许可证 - 详见 [LICENSE](LICENSE)

## 相关项目

- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP 规范
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) - CDP 文档

## 操作状态与诊断

input 和 evaluate 返回值追加 `actionExecuted`、`actionStatus`、`verificationStatus`、`failureStage` 和
`retryable`，验证状态分为
`matched`、`not_matched`、`unavailable`、`error`；debugger 超时且无法证明脚本已停止时，动作状态为
`unknown`，页面脚本抛异常时返回 `actionExecuted=true` 和 `actionStatus="failed"`；原生执行已返回结果后，本地结果展开或序列化失败时返回
`actionStatus="completed"` 和 `failureStage="output"`，页面前置条件不符时，input 和 evaluate 返回
`actionExecuted=false`、`actionStatus="not_started"`，diagnostics 是附加能力，失败时返回
`diagnosticsStatus`，不会覆盖主动作结果，browse 和 wait 的主动作失败时，也会保留失败前已收集的 diagnostics，目标诊断会读取当前 tab 的实时状态，不依赖 attach 时缓存的 URL 和标题

原生脚本终止，以及 CDP `Runtime` 脚本命令返回 `Internal error`、`Object couldn't be returned by value` 或
`Object reference chain is too long` 时，evaluate 和 `manage cdp` 保留原错误码，返回 `actionExecuted=true`、`actionStatus="unknown"`、`retryable=false`，不重放命令；evaluate 的执行中
RPC 超时或过期 execution context 导致结果未知时也不可直接重试；执行开始前的超时仍可重试；页面主动抛出的同名异常按动作失败处理，重试标记为 false

Extension 中已识别的原生 CDP 拒绝返回 `CDP_ERROR`，保留 method、目标、原生消息和可用的协议 code，context 区分 Debugger
域未启用、scriptId 失效、浏览器级命令限制、方法不存在、命令权限拒绝（`Not allowed`）及原生结果序列化失败，资源或方法查找失败不会推断为整个域不支持
这些调用保持失败并输出 warning，未知异常继续按 error 报告，原生快照或权限检查发现的已关闭 tab 按目标失败处理，与页面主动抛出的同文案异常分开

Extension 的 accessibility state 在生成元素名称和状态正文时，均不访问 `input[type=hidden]` 与 `input[type=password]`
的 value getter，默认 `all`、目标子树和文件输出使用相同规则隐藏控件仍可返回
`visible=false`，标签、placeholder、title 和普通输入值保留；显式脚本、HTML 和属性读取保持原有行为

`replace` 仅对 `textarea` 以及 `text`、`search`、`tel`、`url`、`password`
类型的 input 使用文本选区，其他 input 类型通过原生完整 value 更新，并返回请求值与浏览器规范化后的实际值，对不支持选区的类型单独执行
`select` 会返回 `UNSUPPORTED_SELECTION`，CDP模式下，`select` 和 `replace` 的 locator target 通过 CDP
locator 聚焦，不调用 Extension refId，password value 不进入 input 失败 context 和 text
post-condition 观测值，失败响应还会脱敏传入的 `find` 和替换 `text`，password 的 `select`/`replace`
成功和失败响应均隐藏 console 与 network 诊断正文，返回 `diagnostics.redacted=true` 和
`reason="sensitive_input_or_unresolved_target"`；无法安全确认选择目标时也隐藏这些正文普通输入保留诊断，密码保护仅持续到当前 input 请求结束目标超时返回限量的locator、tab、frame、匹配数和候选上下文，显式
`tabId` 或 `frame`
作用域会在 input、wait、logs、extract 开始前确定活动 backend，动作和验证使用同一个目标 backend，precise iframe
evaluate 默认使用 `staleContextRetry="never"`，context 失效时不重放脚本； `readOnly` 允许 Extension 校验 frame
identity 并解析新 execution context 后重放一次，响应包含策略、`retryAttempted`、限量的 `retryReason`，以及最终 Extension
frame、parent frame、URL、CDP frame 和 execution context ID 组成的 `frameContext`，URL 相同的 frame 仅在所选 DOM
iframe 无法唯一确认目标时拒绝执行；Extension 重载后可继续访问原页面中的 iframe，无需刷新或重新导航，探测上下文失效时输出 warning 并停止监听，避免未捕获的消息调用异常
发现摘要在首次扫描和端口集合变化时输出，包含从有 Server 到空集合的变化，相同集合的扫描及自动重连不重复输出；每次仍检查完整端口范围，显式 disconnect 后重新开始报告
普通 WebSocket open 前失败仍聚合为 debug；已识别 MCP server 的认证或协议拒绝只在摘要变化时输出一条限量 warning
