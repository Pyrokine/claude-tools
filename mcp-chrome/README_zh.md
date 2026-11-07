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
- **frame 与 Shadow DOM**：两种后端的 `frame` 均支持子 frame 及逐层选择器／索引路径，CSS、文本和语义查询可进入 open shadowRoot
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
& '<npm-root>\@pyrokine\mcp-chrome\scripts\start-chrome.ps1' -Port 9222 `
    -ExecutablePath 'C:\Browsers\chrome.exe' -ProfileDir 'C:\Temp\mcp-chrome-profile'
```

随后调用
`browse(action="connect", port=9222)`，脚本让 Chrome 进程保持前台运行，并报告退出码；使用独立 profile，避免请求被已有 Chrome
实例接管

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

带 token 的两端必须支持认证协议 v2，每条命令、响应、取消消息和心跳均使用方向分离的会话密钥与递增序号认证
health 证明绑定双方 nonce、服务器实例和端口，Extension 收到认证 ready 后报告连接可用，Server 收到认证 hello 后开始接受请求
旧版严格 token 对端返回协议诊断，默认无 token 发现与自动重连保持原有行为

Popup 的断开操作暂停当前 Extension 会话的连接，Service Worker 恢复时继续保持暂停
显式连接恢复发现，完整重载 Extension 或重启 Chrome 后清除暂停并恢复自动连接
单个 MCP Server 重启后，Extension 沿既有退避持续重连，其他 Server 的连接保持；显式断开取消这些重试

发现摘要在首次扫描与端口集合变化时输出，包括变为空集合；相同集合的扫描与自动重连不重复输出，每次仍检查完整端口范围，显式 disconnect 后重新开始报告
普通 WebSocket open 前失败聚合为 debug，已识别 MCP server 的认证或协议拒绝在摘要变化时输出一条限量 warning

Popup 设置保存失败会显示错误，迟到的旧值保持新的选择；暂停状态读取暂时失败后，同一 Worker 的后续连接可重新恢复
显式断开立即停止本地连接，暂停状态保存失败保留错误提示，默认本地自动连接无需手动配对或点击连接

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

## Target：统一元素定位器

所有工具使用统一的 `Target` 类型定位元素，CSS、文本、role 和 label 查询按稳定顺序进入 open shadowRoot，XPath 保持原生文档树语义
`aria-labelledby` 按元素所在 DOM tree 查找 ID，保留多引用顺序并优先于 `aria-label`，`tab`、`checkbox`、`menuitem` 等允许内容命名的角色包含可见后代文字及嵌套 span，state 名称使用相同规则
普通 input 在 `value` 和 `pageContent` 中保留当前值，与名称分开；state 提取不读取 password、hidden 或 file input 的值
Extension 的 DOM 查询不进入 closed shadowRoot

示例：

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

纯文本 target 选择完整文本匹配的最内层元素，支持多个嵌套文本节点；显式 XPath 保持文档顺序
两种后端均结合 display、visibility 与非零尺寸判断可见性，hidden/detached 的目标初始不存在时第一次查询即成功

两种 backend 的 `input`、`extract`、`wait` 定位失败都在请求预算内返回失败 locator、从 0 开始的
`nth`、URL、tab/frame 作用域、managed 状态、最后定位状态及最多 10 个候选摘要 `matchCount`
表示实际观察到的匹配总量，不受候选摘要上限限制，nth 越界不会把 15 个匹配写成 0；匹配数或 managed 状态无法确认时返回
null，诊断不可用时返回 `diagnosticError`
CDP 查找失败保留 `ELEMENT_NOT_FOUND`，元素等待保留
`TIMEOUT`，原 URL 和日志字段继续保留，诊断在退出失败目标作用域前读取，不重放输入

两种 backend 的定向操作均直接查询 `target.nth`，支持超过默认 50 条候选展示上限及纯文本第 200 项之后的索引
单目标结果只表示该目标是否存在，未经独立统计时，诊断中的 `matchCount` 为 `null`
元素等待检查选定目标，存在的高索引元素不会因候选展示有数量上限而满足 `hidden` 或 `detached`

页面类工具在两种 backend 中都接受 `targetId`，旧版 `tabId`
仍可用；同时提供时两者必须一致，显式目标只作用于当前操作，结束后恢复原默认目标，`browse.close` 和 `manage.closePage`
必须显式指定 ID，页面动作成功或失败时，响应中的 `pageContext`
包含实际目标及来源（`explicit`、`default`、`created`、`reused`、`unconfirmed`）、前后 URL/revision、默认目标前后状态，以及
Extension 报告的浏览器活动目标；
创建页面失败且未返回创建 ID 时标为
`unconfirmed`，CDP 的活动状态标为不可用，不把操作目标当作前台页面

这些快照、browse 结果、页面／窗口管理、state、metadata 和诊断包中的页面 URL 会脱敏 `ticket` 等认证查询参数，返回
`urlRedacted`、`urlOriginalLength` 和 `redactedQueryParameters`；原生 `pendingUrl`、`favIconUrl` 使用对应字段名前缀的标记
导航等待和导航错误文案使用相同展示脱敏，导航与 `expectedUrl` 比较使用原始 URL，页面正文和用户脚本结果保留请求的内容
条件操作使用 `expectedRevision` 或自行持有的原始 URL，脱敏后的展示 URL 不用于 `expectedUrl`

旧 Extension 缺少 `page_snapshot` 时，无条件页面动作使用实时页面列表中的 URL，`pageContext.before` 和 `after` 返回 `revision=null`，并通过 `warning` 说明 revision 与原子条件不可用
传入 `expectedUrl` 或 `expectedRevision` 时，在派发前返回 `DRIVER_CAPABILITY_ERROR`、`actionExecuted=false` 和 `actionStatus="not_started"`，更新 Extension 后才能使用这些条件

evaluate 和 input 保留 `failureStage="precondition"`，顶层状态与错误上下文一致，脚本和输入事件保持未派发
其他快照错误仍阻止动作，兼容读取共用原 timeout 预算

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
epoch 与单页计数构成；Extension 跟踪主 frame 导航和 MCP 动作，CDP 跟踪已附加页面的导航，并保守计入发出的变更命令，包括
evaluate，网页自身的任意 DOM 更改不在跟踪范围内，条件动作前应重新获取
URL/revision，`browse`
导航/关闭、`input`、`evaluate` 及适用的 `manage` 页面动作接受 `expectedUrl` 和
`expectedRevision`；backend 检查不符时返回
`ACTION_PRECONDITION_FAILED`，不发送对应页面动作，复合动作在首个变更命令前检查，不在每个事件前重复检查；失败或超时后如已产生部分效果，revision
仍可能变化

## 请求范围与失败处理

一组输入事件在执行与恢复目标期间保持同一后端、同一页面，并发的 `browse(action="connect")` 等待该请求结束
CDP 绑定所选 frame 的执行上下文与 OOPIF session；Extension 核对 document 与原生 iframe owner，同 URL iframe 重排后仍保持所选身份

input 与 evaluate 的排队、页面选择、准备、派发和验证共用请求预算
MCP 取消或预算结算后，停止排队脚本、剩余事件及后续页面状态和诊断读取，使用独立有界的清理预算释放本次请求新按下的键
最终事件已确认时，后续响应处理超期仍保留 `actionStatus="completed"`；已派发但未收到确认的动作保留 `unknown` 与 `retryable=false`，再次操作前独立读取当前页面

坐标输入等待同步滚动级联，包括准备期间出现的 open Shadow roots，结束后读取当前 frame-local 矩形，目标稳定时不受无关 requestAnimationFrame 滚动阻挡
持续同步自滚动由请求期限终止，目标保持静止时也适用

MCP 取消也会停止排队的窗口和分组变更，Extension 在异步前置读取后、原生变更与尚未提交的受控状态、读取授权或备注更新前检查请求
存储提交成功后继续同步内存，创建后的登记与关闭后的清理继续完成；事件 ref 控制独立于页面队列，其他操作等待期间仍可处理弹窗或暂停请求

extract 的排队、页面读取与导出使用同一取消信号，Cookie、日志、事件、evaluate 与 extract 输出在文件准备和最终发布前检查 signal 与 deadline
取消后停止后续读取、未发布文件和后续日志 manifest，已发布文件保留，临时文件清理继续完成；脚本已完成时，输出取消仍保留其执行状态

## 操作状态与诊断

input 与 evaluate 分别报告执行事实和后置验证：

| 字段                 | 取值                                                         | 含义                               |
| -------------------- | ------------------------------------------------------------ | ---------------------------------- |
| `actionExecuted`     | `false`、`true`、`"unknown"`                                 | 已知的用户主动作执行事实           |
| `actionStatus`       | `not_started`、`completed`、`failed`、`unknown`              | 用户主动作结果                     |
| `verificationStatus` | `matched`、`not_matched`、`unavailable`、`error`             | 后置条件观测结果                   |
| `failureStage`       | context、precondition、queue、action、verification 或 output | 失败阶段                           |
| `retryable`          | Boolean                                                      | 主动作是否适合重新执行             |
| `diagnosticsStatus`  | 附加诊断状态                                                 | 保留主动作结果及失败前已收集的诊断 |

页面主动抛错时保留消息原文，包括空字符串、JSON 形式文本和 primitive 值，返回 `actionExecuted=true`、`actionStatus="failed"`，已有异常 description 与堆栈保持
脚本正常执行且返回值完成 Promise 等待后，类型检查、诊断字段读取、结果与错误详情的 JSON 编码或解析失败返回 `actionExecuted=true`、`actionStatus="completed"`、`failureStage="output"` 和 `retryable=false`，stealth 模式使用相同规则
等待返回值时的 Promise 拒绝按页面动作失败处理，错误摘要无法解析时，通过 `error.context.originalOutputError` 保留首次输出诊断

初始快照读取失败返回 `false/not_started`、`failureStage="context"` 和 `pageContext.contextPhase="before"`；检查 `expectedUrl` 或 `expectedRevision` 的快照使用 `precondition` 阶段
目标、frame、Challenge、参数或逐事件准备 RPC 的回执未知或内部求值输出失败，且用户主动作尚未派发时，顶层仍为 `false/not_started/context`，原错误 context 保留辅助操作自身的执行事实，已确认的前序输入继续计数，迟到回执不派发或重放用户动作

页面条件不匹配返回 `false/not_started/precondition`，目标诊断读取当前 tab 实时状态

### 原生失败与诊断

原生脚本终止，以及 CDP `Runtime` 脚本命令返回 `Internal error`、`Object couldn't be returned by value` 或
`Object reference chain is too long` 时，evaluate 和 `manage cdp` 保留原错误码，返回
`actionExecuted=true`、`actionStatus="unknown"`、`retryable=false`，不重放命令；evaluate 的执行中 RPC 超时或过期 execution
context 导致结果未知时也不可直接重试；派发前失败按返回的 retryable 字段处理；页面主动抛出的同名异常按动作失败处理，重试标记为 false

Extension 中已识别的原生 CDP 拒绝返回
`CDP_ERROR`，保留 method、目标、原生消息和可用的协议 code，context 区分 Debugger 域未启用、scriptId 失效、浏览器级命令限制、方法不存在、
命令权限拒绝（`Not allowed`）及原生结果序列化失败
资源或方法查找失败保留对应类别，调用保持失败并输出 warning；未知异常继续按 error 报告
原生快照或权限检查发现的已关闭 tab 按目标失败处理，页面主动抛出的同文案保留页面异常来源

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

默认 `launch` 使用已连接的 Extension；显式指定 `headless`、`incognito`、`userDataDir`、`executablePath` 或 `port` 时启动独立 CDP 浏览器并返回 `mode="cdp"`
已有 CDP 连接时，在创建或关闭浏览器前报告冲突，传入的启动设置会实际应用或明确拒绝

Extension 特有：`list` 返回 flat `targets` 数组和树状 `windows`，每个 target 含 `managed`（Tab 是否由 MCP
Chrome 受控）、`isActive`（该窗口中 Chrome 的活动 Tab）、`windowId`、`index`、`pinned`、`incognito`、`status`（`loading`/
`complete`），摘要模式返回 `windowCount` 和每个窗口按顺序排列的 `targetIds`，`details="full"` 返回完整的页面与窗口原生属性
Chrome 有聚焦窗口时，`focusedWindowId` 指向该窗口，`activeTargetId` 指向该窗口的活动页面；没有聚焦窗口时省略这两个字段，各窗口仍返回自己的 `activeTabId`
`defaultTargetId` 是默认操作目标，CDP 不用选中的操作目标推断浏览器前台页面，`open`
自动创建 Tab 分组（cyan 色），`open`、`back`、`forward`、`refresh` 支持 `diagnostics=true`，返回动作期间新增的 console
warning/error 和失败网络请求摘要，也覆盖首次 `open` 自动创建页面的场景，两个 driver 的 `open` 和 `refresh` 都支持
`wait="load"`、`wait="domcontentloaded"` 和
`wait="networkidle"`，等待器会在命令前建立，并绑定命令产生的新主文档，上一导航的迟到生命周期事件不会提前完成等待，CDP模式的
`networkidle` 等待当前主 frame loader 的 `networkIdle`
事件；Extension 模式会等待当前文档完成、所有已跟踪响应 body 结束和 500
ms 静默窗口，请求跟踪发生丢失时返回超时，不会误报空闲，`close` 必须传 `targetId`，且只关闭该页面，不会关闭整个 CDP 连接

Extension 模式的 `back/forward` 优先使用浏览器原生历史，仅在原生 API 明确报告无历史且文档允许注入时尝试页面脚本
页面脚本派发前检查 `history.length` 和可用的 Navigation API 方向标记，没有可用历史时立即返回 `navigated=false`，保留请求剩余预算，其他原生错误保留
execution context 失效或浏览器拒绝向错误页注入时，操作返回失败，Extension 将其记录为预期操作警告；任意 debugger 命令保持不自动重放

CDP 历史导航命令明确拒绝时，返回原错误并立即结束本次等待，后续请求继续可用

`open`、`back`、`forward`、`refresh` 的 `timeout`
从请求入口开始计时，页面准备、排队、协议请求、加载、Challenge 检查与点击、诊断和目标恢复共用剩余预算，导航 RPC
使用原期限作为传输期限
队列中的动作到期后停止派发，后续请求仍等待原在途动作结束；显式
`timeout=0` 在导航派发前拒绝，页面创建保留独立的加载等待与传输余量合同
导航等待耗尽请求期限后，停止后续页面信息和诊断读取；较短子操作的等待超时保留请求剩余预算

MCP 取消会停止尚未派发的排队 browse 动作，并结束当前导航或 Challenge 等待，同一 signal 也会停止等待结束后的系统鼠标命令和 CDP 启动步骤，启动清理只终止本请求创建且尚未交付的进程

鼠标已经按下时，请求持有 tab 锁直到必要释放完成或独立的 5000 ms 清理预算结束，期间后续导航和输入继续排队，释放失败或超时返回 `releaseStatus="unknown"` 和明确错误，应检查并释放鼠标按键后再继续操作

导航已确认完成、随后状态读取失败时，保留 `actionExecuted=true`、`actionStatus="completed"`、`failureStage="metadata"` 和 `retryable=false`，页面验证保留自身结果

超时不会撤回已经派发的 Chrome 操作，结果未知时返回 `TIMEOUT`、`actionExecuted="unknown"`、`actionStatus="unknown"` 和
`retryable=false`，应读取实际页面状态后决定下一步
`pageContext.after` 使用实时快照，无法取得时为 null 并附 `contextError`；恢复预算耗尽时单独报告恢复失败，保留主动作结果
CDP 历史等待接受当前 session 主 frame 的 BFCache 恢复或同文档事件，普通 frame commit、子 frame 和其他 session 的事件不作为完成信号

Challenge 点击、detach 和检查 RPC 携带剩余 deadline，排队或页面校验耗尽预算后不再派发；系统鼠标移动与 fallback 进程使用同一
deadline
CDP 已开始的按下始终尝试向原连接、原 session 释放，清理最多等待 1 秒，释放只发往原目标
只读 Challenge 检查到期返回
`CHALLENGE_TIMEOUT`，保留已知主动作状态；点击结果未知时返回 `TIMEOUT`、已知主动作状态、
`verificationStatus="unknown"`、`verificationActionExecuted` 和 `retryable=false`，不自动重放导航或点击

evaluate 在成功、动作失败、后置验证不匹配和输出失败时保留 Challenge 结果字段 `originResponsePending=true`
表示验证成功但源站尚未响应，不表示目标内容已加载

`browse` 仅 `open`、`back`、`forward`、`refresh`、`close` 接受这两个条件，`attach` 等其他动作在改变目标前返回
`INVALID_ARGUMENT`

显式 `manage(action="adoptPage", targetId=...)` 将已有页面设为完整受控页，不聚焦或导航，`browse attach`
只选择目标；创建来源、分组归属和颜色不决定页面权限，`releasePage`
撤销完整权限，保留页面、窗口归属和分组，清理 MCP 日志状态、debugger 和 console 采集资源；Chrome 阻止资源清理时返回
`warnings`，完整权限仍被撤销

受控权限在 Service
Worker 重启后保留，重载 Extension 后，仍存活且原文档身份一致的受控页也会恢复权限，无需刷新页面或重新 adopt
文档身份不可取得的页面在重载
Extension 后需要显式
`adoptPage`；正常导航保留受控权限，`releasePage` 撤销的权限在重启或重载后仍保持撤销，仅复用 tab ID 不会授权另一份文档

受控页在 Service Worker 重启后可继续使用本 Extension 已有的调试连接，其他调试器占用仍返回 `DEBUGGER_BLOCKED`

通过 `manage(action="grantReadAccess", targetId=...)` 授予普通读取权限，用 `revokeReadAccess`
撤销，无需点击 popup；两个动作必须显式指定目标，可传
`expectedUrl`/`expectedRevision`；授权限定当前调用服务器实例、documentId、URL 和 revision，存储失败返回错误，不报告授权成功；popup
保留为可选入口，同一连接和文档未变化时，
Service
Worker 重启后仍可读取；导航、关闭页面或断开连接后授权失效，仅指定 `targetId`
不授予读取权限；普通只读授权覆盖定向文本、HTML、属性、计算样式及页面状态读取，任意脚本、debugger、截图、输入和 Cookie 访问不继承授权，现有
Cookie 工具仍按独立的 URL/name 过滤规则执行

页面管理或导航因缺少受控权限而被拒绝时，不更新 revision，已有有效的普通只读授权保持不变

`manage(action="pageMetadata", targetId=...)` 读取或更新 `taskHint`、`note`，支持
`expectedUrl`/`expectedRevision`，条件不符时返回 `ACTION_PRECONDITION_FAILED`，不读取或更新备注
Extension 持久保存来源 `origin=created/adopted/unknown`、创建时间和任务备注；旧 v1 记录迁移为 unknown，受控访问保持可用
Server 重启后以 Extension 返回的最新元数据为准，存储失败明确报错；CDP 元数据保存在当前 Server 进程中
来源、文档身份及可信原生关系由 Extension 维护，备注不授予内容访问权限

执行任务先 `browse list`，按任务名称和备注选择已有页面，后台 `attach` 复用；确无合适页才 `newPage`，同时设置
`taskHint` 和说明临时、产物或可复用用途的 `note`，`newPage` 始终创建新页
默认在含可信自有页的普通窗口后台创建，其次使用其他现有普通窗口；无普通窗口时返回错误，缓存丢失不创建窗口
同任务原生分组只按可信创建记录和当前成员关系复用，名称用于显示；混合用户组及同名用户组保持原状
更新任务名会在全部可信成员任务一致时更新组名，移动、关闭或原生成员变化会清理失效关系

任务完成后通过已有 close/release 处理明确页面集合，默认只关闭本任务创建且备注明确临时的页面
保留 adopted/unknown、产物页、可复用测试页和混合用户组，按已有入口释放已不用的临时权限
显式授权关闭继续使用原受控页合同，断线及闲置不关闭页面；原生分组仅支持 Extension，CDP 接受纯 `taskHint/note`

显式 `networkidle` 在导航前启用 Network 观测，等待已跟踪请求完成后持续静默 500 ms；观测缺失或中断时返回错误，默认 `load` 路径不为网络空闲检查附加 debugger

### 访问验证

`open`、`back`、`forward`、`refresh`、`input` 和 `evaluate` 之后，MCP Chrome 会等待 Cloudflare JS Challenge 或 Turnstile
checkbox，Extension 模式下，导航先不启用 debugger 日志采集；Challenge 标题持续期间，前八秒只被动读取真实 tab 标题，interstitial
持续存在时，才检查可见 Turnstile 控件，
找到后才点击，Extension
inspect 走 isolated
world，Challenge 标题在检查前卸掉 debugger，普通页面检查保留已有调试连接，发现可见验证控件或仍需验证的正文后才卸除；同页测试按钮走页面点击，出现
Cloudflare
Turnstile iframe 时，把 inspect 的 CSS 坐标换成屏幕坐标，系统鼠标沿路径移动、悬停后再按下抬起：Linux 用 `xdotool`
读取活动 Chrome client 窗口几何，用 `xprop` 读取 GTK frame
extents，窗口标题必须对应该测试页
缺少工具、窗口数据无效或与页面视口不符时停止点击，不用 Chrome `screenX` 或
`outerHeight - innerHeight` 猜测内容原点；macOS 用 `cliclick` 或 System Events；Windows 用 PowerShell
`mouse_event`，widget 点 compact
Turnstile 卡片左侧 checkbox，宿主 wrapper 比卡片宽时也只点左侧卡片，不点文案，DOM 里已有 Cloudflare
iframe 时，即使 iframe 尺寸为 0，也走系统鼠标，不改用页面点击，后续宿主页 `Verify you are human` / `请验证您是真人`
按钮同样走系统鼠标，系统鼠标只在受控测试页已经是已聚焦窗口的活动 tab 时使用，混合窗口不会调用 `focusWindow`

系统点击前会卸掉 debugger，路径移动和悬停结束后、按下前重新检查控件位置、视口与活动窗口
Linux 在悬停后以 1 px 原生往返校准提示条动画期间的内容原点；控件位置变化时，在原 timeout 内重新移动、悬停并校准后点击
页面、验证阶段或焦点变化时停止点击，缺少系统鼠标工具或窗口未聚焦时返回可见错误

widget 要连续两次 inspect 到同一坐标才点，不以普通元素的尺寸认定 widget；系统鼠标从远处过来时从控件附近起步，同一类
checkbox 或 compact
widget 在同一次等待里最多点一次；Cloudflare 随后换成可见的 `Verify you are human` 或 `请验证您是真人`
按钮时，inspect 判成 `verify` 后再点一次，访问受 Cloudflare 保护的页面默认保持
`diagnostics=false`，因为 diagnostics 会启用 debugger 的 console 和 network 采集

检测覆盖 `Just a moment...`、`请稍候…` 等标题、可见的 Challenge DOM、正文标记和 `Verify you are human` /
`请验证您是真人` 控件，包括精确匹配这两种文案的可见 `button`
元素；普通标题也会进行有界的可见内容检查，可见的“正在进行安全验证”会阻止业务动作，隐藏标记不计入判定，无验证标记的页面不会固定等待八秒

没有 Cloudflare iframe 时，同页按钮使用页面点击，CDP 用 `Target.getTargetInfo` 读取实时标题
页面恢复后，仅残留 Cloudflare iframe 或旧 pending header 不算等待中，也不触发滚动或点击，缓存标题不参与判定
MCP Chrome 不调用 CAPTCHA solver、自动重试导航或导出 `cf_clearance` 的值
CDP 超时后，先检查返回的 `mode`，再核实网站在用户真实 Chrome 中的状态

内嵌控件完成后可保留容器，与该控件关联的非空 response 标记完成状态，reset 或过期后恢复待验证状态
多个控件分别判断，其他表单中的 response 不会使当前控件完成，检测只返回完成状态，不返回 response 值

input 与 evaluate 在动作返回后使用剩余预算检查新验证，验证失败仍保留动作已完成状态，不重放动作
最终事件已确认完成且预算已用尽时，返回 `challengeVerificationStatus="unavailable"`，说明动作后的验证检查未执行
动作完成后的超时返回 `retryable=false` 和 `nextAction="wait_and_verify"`，等待验证结束后核验业务结果

验证完成时返回 `challengeResolved=true`、`challengeKind`、`waitedMs`、`clickedTurnstile` 和 `clearanceCookiePresent`
（只表示 cookie 名是否存在），页面可见文案显示验证成功、正在等待源站时，响应还会含
`originResponsePending=true`，表示已过盾但目标页面尚未加载，隐藏的成功文案（例如 `display:none`
的标题）不算过盾，可见 Turnstile 勾选框仍视为等待中，Challenge 成功和失败响应都含 `mode`，动作执行前超时返回 `CHALLENGE_TIMEOUT`
且 `retryable=true`，并带 `clickedTurnstile` 和实际观察到的 `challengeKind`（点过 Turnstile 时不会报成 `js`），Access
denied 返回 `CHALLENGE_DENIED`，交互式验证码、Bot Fight
Mode 和 IP 声誉检查无法靠等待或点击 checkbox 完成，之后的正常主文档响应才会清掉 header 标记，普通 iframe 文档响应和清空网络日志都不会清掉它

### input - 键鼠与文件输入

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
| `upload`                                | 在文件控件中选择本地文件，`files:[]` 清空选择                 |
| `wait`                                  | 事件间暂停                                                    |
| `select`                                | 按内容选中文本（鼠标模拟）                                    |
| `replace`                               | 查找并替换文本                                                |
| `drag`                                  | HTML5 拖放（MAIN 世界 DragEvent，需 `target` 源 + `to` 目标） |
| `editorContext`                         | 读取当前编辑器和选区上下文                                    |
| `editorInsert`                          | 在当前编辑器选区插入文本                                      |
| `editorCommand`                         | 执行 `bold`、`insertOrderedList` 等浏览器编辑命令             |

Extension 后台页的默认无修饰键元素左键单击使用经过可操作性检查的合成事件，返回 `warnings` 并说明 `isTrusted=false`，保持标签页在后台
活动且可渲染的页使用原生 precise 输入，后台坐标点击、移动或带修饰键／多击的鼠标动作可显式使用 `manage(action="inputMode",inputMode="stealth")`，鼠标按键清理保持可用

`events` 至少需要一个事件，参数：`humanize` 启用贝塞尔曲线移动和随机延迟，`diagnostics=true` 返回动作后新增 console
warning/error 和失败网络请求， `postCondition`
会在事件发送后等待页面状态，便于区分输入事件已发送和页面业务状态已完成，`postCondition.timeout` 默认 3000 ms、最大 60000
ms，`postCondition.interval` 默认 100 ms、范围 50-5000 ms，`postCondition.script` 可传表达式、函数、async
function 或 Promise 表达式；函数会被调用，最终 Promise 值会被等待后再判定，抛错或 reject 会让检查失败，`targetId`（或旧版
`tabId`）在两种 backend 中指定页面；`frame`
在两种后端中指定子 iframe 或逐层选择器／索引路径，传入任一作用域时，动作、诊断和 post-condition 使用该目标作用域选定的同一个
backend

text、selector 和 URL 检查遇到临时 context 失效时，在 input 与验证的剩余期限内重新读取，持续不可用、原生连接关闭或读取预算耗尽时返回 `verificationStatus="unavailable"`，script 遇到原生 context 失效时立即返回 unavailable，Extension 与 CDP 的原生执行终止及引擎执行超时在后置验证中同样归为 unavailable
selector 语法错误、页面抛错或 reject 返回 `error`，异常值转成字符串时再次抛错仍保留页面错误来源，文案中的 frame 或 timeout 不改变分类
已完成输入保留 `actionStatus="completed"`、`failureStage="verification"` 和顶层 `retryable=false`，`postCondition.retryable` 表示能否单独重试校验，验证同时受主动作总期限限制，总预算耗尽时不再发起检查

取消会中断验证读取和轮询等待，input 在后继排队动作开始前，有界尝试释放本请求新按下的键，保留请求开始前已按住的键，释放失败保留诊断

文本校验匹配页面渲染文字和可见的非密码表单值，`actual` 返回包含命中文字的有界片段，Shadow host 的自身 shadow 子节点属于可点击范围，合成 click、key 和 input 事件会传到 host 与 document 监听器，mouseenter 和 change 保留各自的局部事件语义

坐标目标使用当前 frame 的 viewport 坐标，原生 precise 输入处理 frame 内容边界、缩放、旋转、倾斜及嵌套位置，无法可靠映射时在该事件派发前失败，保留前序已完成事件的进度，stealth 事件保持 frame-local 坐标

按目标取点沿 assignedSlot 和 Shadow host 找到实际滚动盒，可见页面在连续渲染间检查目标矩形与祖先滚动位置，包含页面监听器触发的级联及阻断 scroll 传播的情况，旁边无关容器的循环滚动保留稳定目标的可操作性
等待期间变为隐藏时按当前布局取点，不等待暂停的动画帧；恢复可见时重新检查渲染，目标持续移动或祖先持续滚动耗尽本次请求期限时，该事件保持零次输入派发

wheel 省略 target 时沿用当前鼠标位置，Extension 的 helper 安装与输入固定到同一解析所得 documentId，派发前文档被替换或移除时返回 not_started，保持零次输入

wheel 和鼠标事件携带当前按住的 Ctrl、Shift、Alt、Meta 字段，包含组合修饰键及使用合成派发的 precise 右键，合成事件保留 `isTrusted=false`，应用监听器可以读取修饰字段并取消默认滚动

Extension 的坐标 wheel 按各轴实际滚动范围处理反向 Flex 和竖排布局，小数增量在同一滚动容器的连续输入间累计，命中后代更新或 wheel 监听器自身滚动仍保留余量，事件之间的独立位置变化重置该容器余量，其他容器或文档建立各自序列；原生滚动进度识别 CSS zoom 下的分数末端，无法取得进度时输出 console warning 并沿 CSSOM 尺寸范围兼容路径处理，元素滚动距离按有效 CSS zoom 换算，普通 transform scale 保持原有滚轮距离语义，viewport 使用自身单位

滚动盒资格结合 namespace、实际主盒和文本编辑控件判断，MathML math 布局、flow-root list-item、inline flow-root list-item、block ruby，以及 Chrome 支持的 `-webkit-box`／`-webkit-inline-box` 保留自身滚动与边界行为
文本 input 在 Chrome 将 computed overflow 显示为 clip 时仍可滚动内部文本，block SVG viewport 的 hidden/contain 声明不形成 CSS 滚动边界，foreignObject 具备滚动盒时保留自身 auto 滚动及 hidden+contain/none 边界，嵌入的 HTML 保持自身滚动行为
真实容器的 `overscroll-behavior-x/y: contain` 或 `none` 阻止该轴继续传播，包含零范围容器，auto 允许未消费的轴沿原链传播；嵌套 `overflow:hidden` 保留边界策略且自身不滚动，普通 clip/visible、非原子 inline 和 display:contents 节点不新增该边界

viewport 遵循 root/body 的 overflow 传播规则，无主盒的 body（包含 display:contents）不提供 viewport overflow；html/body 的显式 containment，以及 content-visibility 或 container-type 施加的 containment，使 body 保留独立滚动行为，真正传播 overflow 的 body 不作为独立边界，viewport 的 hidden/clip 轴不滚动
目标自身可滚动时优先处理自身，absolute/fixed 目标之后沿 composed tree 中最近的有效定位包含块寻找后续对象，包含 slot 及 foreignObject 嵌入内容；transform、filter、containment、3D／motion 条件及适用的 will-change 名称分别遵循各自的盒资格

事件可取消并能跨 ShadowRoot 到达 host 和 document 监听器，有效的 `preventDefault()` 停止模拟默认滚动，事件仍返回 `actionStatus="completed"` 并计为一次已执行输入
各轴按输入开始时的边界选择滚动路径，监听器改变容器尺寸或位置时保留其效果，默认动作在已选路径上使用改变后的位置；容器失去滚动范围后，未消费的输入按其 overscroll 策略沿原链继续传播
命中元素被移除或迁移时，本次 wheel 不转向新插入的祖先或无关 viewport

Extension wheel 的默认动作使用程序化滚动，吸附遵循程序化终点，原生 wheel 的滚动意图会产生不同终点；mandatory 和 proximity 保留各自吸附行为，原生终点差异属于已接受的兼容性行为

键盘 `type` 的 `timeout` 包含 Challenge 等待、焦点准备、字符输入和 `delay`/`humanize` 延迟，Extension
precise/stealth 与 CDP 使用本次剩余预算，显式预算如 `timeout=45000`
允许合法输入持续超过默认的 30000ms，到期后停止后续字符与事件；已派发的输入不能撤回，超时可能留下部分输入，响应为
`actionExecuted=true`、`actionStatus="unknown"` 和 `retryable=false` 时，应独立读取页面确认实际值，不重放整个事件序列

鼠标目标查找、分步移动和 `humanize`
延迟也共用 input 剩余预算，每次移动和后续点击前检查截止时间，到期后停止后续移动和点击；已派发的原生事件不能撤回，结果为
unknown 时独立读取页面，不重放操作

命令聚焦、文本选择和替换共用事件剩余预算，到期后停止后续动作；Shift 按下后仍尝试释放，释放失败不隐藏原动作错误，CDP
分步触摸移动到期后也停止后续触摸点与事件

Stealth 左键派发 `click`，中键派发 `auxclick`，右键派发 `contextmenu`，每次按下和释放携带对应的点击
`detail`；只有左键多击在 `detail=2` 时派发 `dblclick`，独立 stealth `mouseup` 使用相同的按键映射

Stealth 的 `delay` 只作用于字符之间，首字符不额外等待；后台页面受定时器节流时，后续间隔会延长，本次预算仍限制后续输入

默认 precise 键盘 `type` 在 Extension 与 CDP 模式中会为每个换行派发 Enter，CRLF 会规范化
编辑器将 Enter 绑定为提交时，多行输入中的部分文本会触发提交
在 Extension 模式替换多行文本时，使用 `mode="controlled"`（或 `dispatch=true`）并指定 `target`，它替换完整 value 或
contenteditable 文本，派发 input/change，不派发 Enter，表单控件继续使用原生 value setter

键盘输入和 `editorInsert` 使用当前光标与选区，键盘 `type` 指定 `target` 时会先点击并改变插入位置；`editorInsert`
聚焦目标但不点击，通过浏览器编辑 API 插入文本，不派发 Enter
追加多行文本时，将光标放到末尾，再发送不带 `target` 的 `editorInsert`，存在非空选区时会替换选区文本，完成后读取实际文本确认编辑器已接受输入

后台 CDP 点击和键盘输入保持页面在后台，检查元素是否可见、可用且位置和尺寸稳定，必要时滚动到视口；点击还会检查遮挡
目标查找、可操作性检查和最终坐标读取共用事件剩余预算，任一阶段耗尽预算后停止派发鼠标或键盘事件

Extension precise 的显式 `keydown`／`keyup` 使用原生按键，按键准备与事件共用请求剩余预算；需要焦点模拟时，响应的 `warnings` 提示文档在输入期间临时报告 `visible`，实际标签页和窗口焦点保持原状，操作结束后恢复原设置，再执行 `postCondition`

复用调试会话的原模拟状态未知且页面在后台时，返回 `KEYBOARD_FOCUS_STATE_UNKNOWN` 和 `not_started`，保持原设置，可显式使用 stealth 或独立 CDP；恢复失败返回 `keyboardFocusCleanup`，已完成的事件仍保留 `completed`，派发回执未知时保留 `unknown`，请求失败、取消或到期会尝试释放本请求新增的按键，正常完成时保留有意按住的键

**`keydown` 专属参数**：

- `commands`：触发浏览器原生编辑命令（如 `["selectAll"]`、`["copy"]`、`["paste"]`、`["cut"]`、`["undo"]`、`["redo"]`
  ），成功表示浏览器已接受命令分发，页面结果需用 `postCondition` 或 `extract`
  验证，仅 precise 模式可用，stealth 模式下抛错（CDP commands API 没有 JS 事件等价物）
  命令分发前只聚焦元素或坐标
  `target`，不派发鼠标事件，坐标聚焦不会改变 checkbox、跟随链接或调用 click 监听器；目标缺失或无法聚焦时，在分发命令前返回错误，Extension
  的
  `frame` 坐标相对于所选 iframe
- 连续 `keydown` 同一 key 自动切换为 `rawKeyDown` + `autoRepeat`，模拟长按重复（与 Puppeteer 一致）

**`click` 专属参数**：`force:true` 必须提供 `forceReason` 与非坐标型元素 `target`，跳过可操作性检查后派发标准 DOM 鼠标事件
中键、右键和多击采用同一规则，坐标型或省略 target 时拒绝 force；失败返回 `ACTIONABILITY_FAILED`，包含 `rect`、`clickPoint`、遮挡元素、候选遮挡物与处理建议

**`type` 专属参数**：`mode="controlled"` 或 `dispatch:true` 替换完整 value 或 contenteditable 文本，派发 `input`/`change`，不派发 Enter；需要非坐标型 `target`，仅限 Extension
目标须为 HTML `input`、`textarea`、`select` 或 contenteditable，有效禁用、readonly、普通容器与 file input 在聚焦和输入事件前明确拒绝；disabled fieldset 按 HTML 规则处理，保留首个 legend 的例外，文件控件使用 `upload`
普通控件、customized built-in 及从同源文档 adopt 的控件按实际表单接口使用原生 value setter，setter 不可用时在聚焦前返回明确错误

受控输入与目标查找失败时返回 `locator`、`matchCount`、`nth`、有数量上限的 `candidates` 和不含输入值的 `activeElement` 摘要；焦点不可取得时为 `null`，DOM 查询失败时另含 `diagnosticError`

Extension precise 输入在字符或 Enter 按键收到回执后取消或到期，保留已执行进度并使旧页面 revision 失效；首次派发前取消仍保留未执行状态，再次操作前读取当前值与 revision

标签输入框通过 Enter 创建标签时，输入文字后显式发送 Enter，再检查标签是否生成，以下 `input` 示例中，输入框为 `#tag-entry`，标签列表为 `#tags`，使用时替换为页面的实际选择器：

```json
{
  "events": [
    { "type": "type", "target": { "css": "#tag-entry" }, "text": "12345" },
    { "type": "keydown", "key": "Enter" },
    { "type": "keyup", "key": "Enter" }
  ],
  "postCondition": { "selector": "#tags [data-value=\"12345\"]" }
}
```

#### 文本选区与敏感输入

`replace` 对 `textarea` 与 `text`、`search`、`tel`、`url`、`password` 类型的 input 使用文本选区，其他 input 类型通过原生完整 value 更新，并返回请求值与浏览器规范化后的实际值
不支持选区的类型单独执行 `select` 时返回 `UNSUPPORTED_SELECTION`，CDP locator target 通过 CDP 聚焦

事件级 `nth` 选择文本第 N 次出现，嵌套 `target.nth` 选择第 N 个目标元素，两者从 0 开始，可同时使用，选区错误另含编辑器与选区状态

password value 不进入失败 context 或 text post-condition 观测，失败响应及 `error.logs` 定位日志中的 `find` 与替换 `text` 采用同一脱敏规则
password `select`/`replace` 的成功与失败响应均隐藏 console 和 network 诊断正文，返回 `diagnostics.redacted=true`、`reason="sensitive_input_or_unresolved_target"`；无法安全确认选择目标时采用同一保护
普通输入保留诊断，密码保护在当前 input 请求结束时清除

#### 上传本地文件

网页浏览、页面交互和文件上传优先使用 mcp-chrome，上传沿用当前页面与 Extension/CDP 连接
Chrome DevTools 用于浏览器或扩展诊断，以及 mcp-chrome 未覆盖的明确任务

通过 `input` 的 `upload` 事件，从原路径选择文件，包括 Downloads 中的文件：

```json
{
  "events": [
    {
      "type": "upload",
      "target": { "css": "input[type=file]" },
      "files": ["./review.zip"]
    }
  ]
}
```

`files` 必填，路径指向 MCP Server 所在机器上可读的普通文件
相对路径按 Server 工作目录解析，支持绝对路径和 `~/` 路径；Server 传输文件字节，浏览器可位于另一台机器
本次选择的文件总大小须低于 50 MiB，达到或超过预算时，在修改文件控件前返回错误

带 `multiple` 属性的控件可传多个路径，`files:[]` 清空选择：

```json
{"events":[{"type":"upload","target":{"css":"#attachments"},"files":[]}]}
```

目标须为 `input[type=file]`，隐藏的文件控件也可使用，无需点击或打开系统文件选择框
现有元素定位器和 `target.nth` 选择控件，两种后端的 `frame` 均可选择子 iframe 或嵌套路径
上传复用当前 Extension 或 CDP 连接和所选 inputMode，默认 precise 模式支持严格 CSP 页面，stealth 遵守页面 CSP 限制
Extension 上传需要受控页权限，在读取本地文件前完成检查

结果返回赋值时的文件名、大小、MIME 和事件摘要，控件依次收到合成的 `input`、`change` 事件
要求 trusted event 的站点需按实际行为验证；页面在 `change` handler 中自动清空控件时，结果仍描述 handler 执行前的文件赋值

使用 `postCondition` 等待站点的附件就绪或上传完成状态，站点要求提交时另行执行提交
postCondition 失败时保留输入动作已完成的状态
文件读取、传输和赋值共用 input 超时与取消，赋值前失败时保留原选择
赋值结果未收到确认时返回 `actionStatus="unknown"`、`retryable=false`，独立读取页面后再决定下一步

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

#### HTML 与图片

`output` 将结果保存到文件，`images=data` 时使用目录；`images=info|data` 随 HTML 返回图片元信息或字节
图片数据单图限制 2 MiB，单次请求累计限制 8 MiB，目录导出逐张读取与写入，索引的 `omitted` 记录不可用或超额原因
内联输出保留前 20 张图片，采用相同的省略原因与字节预算，`frameHtml` 在 `frame` 路由后读取当前文档

#### 截图

`clip` 指定坐标区域，`compareWith` 指定 PNG 基准，`diffOutput` 指定 PNG 差异图；`diffOutput` 必须同时提供 `compareWith`
目标未匹配、`nth` 越界或尺寸为零时返回目标错误，响应包含 `metadata.format`、`width`、`height`、`dimensionSource`、`byteSize`、`fullPage`、`scale`、`clip` 与 `capabilities`

截图限制为单边 16,384 像素、总计 12,000,000 像素、预计 RGBA 内存 48 MiB 与编码数据 25 MiB
基准 PNG 在读取前检查文件大小，对比限制单个 PNG 为 25 MiB 与 12,000,000 像素；解压输出与 scanline 长度须匹配已校验尺寸，损坏或异常膨胀的 PNG 返回错误，较大截图使用 `clip` 或 `scale` 缩小

两种后端的截图和 diagnosticBundle 均报告 `hiddenTabScreenshot=false`，Extension 隐藏页返回 `HIDDEN_TAB_SCREENSHOT`，整页截图保留当前视口与设备模拟
其他 debugger 占用 precise 路径时，可视区域 fallback 在内联与文件输出中报告 `metadata.degraded`、`metadata.fallback` 和 `metadata.limitations`
窗口级捕获期间活动 tab 变化时丢弃图像，包括 A→B→A；不支持的 fallback 参数返回 `SCREENSHOT_FALLBACK_UNSUPPORTED`

#### 状态与元信息

`state` 返回 `interactiveElements`，两种后端的 metadata 均返回 `frames` 与实际文档 `url`，Extension `frame` 路由返回所选文档地址
CDP 无法取得的已声明帧字段保留为 `null`，包括 DOM selector 与所属元素 rect，帧树顺序和 ID 保持不变

元信息包含当前 `managed` 状态与 `createdBy`、`createdAt`、`lastUsedAt`、`taskHint`、`note`，与 `browse list`、`manage pageMetadata` 一致，内联与文件输出使用相同字段
`frame` 选择 iframe 文档时，备注仍属于页面；Extension 的创建来源、备注与可信分组关系跨 Server 和 Extension 重载保存，恢复时核对实际身份，CDP 备注属于当前 Server 进程
未知来源保留 `unknown`，备注不授予访问权限或跨会话所有权；CDP 返回 `managed=false`，保留连接内的正常操作

两种后端均通过 `targetId` 或旧版 `tabId` 选择页面，通过 `frame` 选择子文档或嵌套路径

**`attribute` 特殊前缀**：`computed:<属性名>` 返回 computed CSS 样式值（如 `computed:color`、`computed:font-size`），
`computed:*` 返回全部计算样式（300+ 属性，建议配合 `output` 写文件）

`extract.timeout` 是浏览器操作总预算，单位毫秒，默认 30000，包含排队、页面/frame 准备、目标等待、内容读取和页面上下文元信息读取
每个 RPC 使用剩余预算，`state` 不另外开始 30 秒等待；已派发但未确认的请求保留 unknown，不自动重放

**`state` 专属参数**：`depth` 控制无障碍树遍历深度，默认 15，减小后可限制大页面的返回量
`mode` 选择 `accessibility`（默认，无障碍树）或 `domsnapshot`（原始 `DOMSnapshot.captureSnapshot`，支持 CDP 或受控 Extension 页面）
DOMSnapshot 返回整页快照，传入 `target`、`frame` 或 `depth` 限定时明确拒绝
普通只读授权允许 accessibility 状态读取，Extension 的 DOMSnapshot 需要完整受控权限以使用 debugger
无关 iframe 探测失败时，metadata 通过 `unavailableFrames` 与对应帧的 `unavailableReason` 标明原因，能够唯一验证的所选 iframe 继续可用

两种后端的 accessibility state 均通过 `target` 限定所选元素及其后代，`depth` 从该子树根部计算

accessibility state 生成元素名称与正文时不读取 hidden/password/file input 的 value getter，默认 `all`、指定子树和文件输出采用同一规则
隐藏控件保留名称与 `visible=false`；标签、placeholder 和 title 提供名称，普通 input 在 `value` 与 `pageContent` 中单独保留当前值，有名称时也保留，submit 标签保留完整文本，显式脚本、HTML 与属性读取保持原有行为

### wait - 等待条件

| For          | 描述                                         |
| ------------ | -------------------------------------------- |
| `element`    | 等待元素（visible/hidden/attached/detached） |
| `navigation` | 等待导航完成                                 |
| `time`       | 固定延迟                                     |
| `idle`       | 等待 DOM 或网络静默期                        |

参数：`targetId`（或旧版 `tabId`）在两种 backend 中指定页面，`frame` 在两种后端中指定子 iframe 或嵌套路径

CDP 模式的 `visible` 要求 DOM 矩形宽高非零，且 CSS 不隐藏元素（`display:none` 或 `visibility:hidden/collapse`） `hidden`
接受这些隐藏状态或元素不存在，`attached` 和 `detached` 只检查元素是否存在

**`idle` 说明**：Extension 模式会在 `readyState === 'complete'` 后注入 `MutationObserver`，等待 `ms`
毫秒内无 DOM 变更；CDP 模式等待网络静默，两种模式的默认 `ms` 都是 500ms，响应返回 `idleKind` 和
`idlePeriodMs`，Extension 响应还返回 `domStable`

CDP idle 包含调用前已在途的页面请求，独立 idle 与同文档 `networkidle` 排除空 `loaderId` 的 Worker 请求，这类请求的终态事件可在页面 session 中缺失；页面 Fetch 与 Script 请求仍等待完成

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
| `frame`              | 指定子 iframe 或逐层选择器／索引路径，两种后端均支持    |
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
只表示脚本完成执行并返回；传入后，`verificationStatus` 区分 matched、not_matched、unavailable 和 error，并返回最后一次检查结果，已完成脚本保留 `actionStatus="completed"` 和顶层 `retryable=false`，`postCondition.retryable` 仅适用于独立验证读取
iframe precise 执行默认不在 execution context 失效后重放脚本，只有脚本无副作用时才应传
`staleContextRetry="readOnly"`，Extension 会在剩余 timeout 内重新解析 context，并最多重放一次，重试解析期间 Chrome 仍返回已移除的
document 时，
会在同一预算内等待当前 document，不增加脚本执行次数；权限拒绝立即结束
CDP iframe 支持 `never`，请求 `readOnly` 时在脚本派发前返回 `DRIVER_CAPABILITY_ERROR`、`actionExecuted=false`
和 `actionStatus="not_started"`
两种 backend 的 `Runtime.evaluate` 发出后发生 stale context 时均返回 `actionExecuted=true`、`actionStatus="unknown"`
和 `retryable=false`，因为脚本可能已经产生部分副作用，但无法取得最终结果，CDP 保留原生 `CDP_ERROR`

evaluate 的总 timeout 同时限制后置验证，总期限已到时保持主动作 completed，并返回验证 unavailable
排队中超时且脚本未派发时，公开结果保留 `actionExecuted=false` 与 queue 阶段；已经派发且回执不明的脚本保持 unknown，按结果单独读取页面

Extension precise 主 frame 的对象结果，显式指定 `output` 时字符预算为 16 Mi（16777216），未指定时保留 1000000，自动保存使用同一上限
两条路径均保留深度 8、节点 2000 和不可序列化结果拒绝，字符预算按 UTF-16 code units 计算，输出文件字节数按 UTF-8 计算
`tmp:` 文件另受临时输出配额约束，超限返回当前上限，并保留脚本已完成、输出失败的状态

绝对 `scriptFile` 与 `output` 路径须位于 Server 当前工作目录或本次 Server 会话的受控临时目录内，系统临时目录的其他位置与 Downloads 不自动列入允许根
`PATH_NOT_ALLOWED` 的 `error.context.allowedRoots` 给出实际范围，使用其中的 `cwd:` 或 `tmp:` 路径

响应包含 stale-context 策略、`retryAttempted`、限量的 `retryReason` 与最终 `frameContext`，其中记录 Extension frame、parent frame、URL、CDP frame 与 execution context ID
同 URL frame 仅在所选 DOM iframe 无法唯一确认目标时拒绝执行；Extension 重载后可继续访问原 iframe，探测上下文失效时输出 warning 并停止监听

已可用 iframe 的选择不等待兄弟 frame 加载完成，后台页面定时器限频不延长 frame 探测等待，脚本派发前取消或超时会释放探测资源，保持该脚本未执行

可信 Function 编译策略拒绝返回 `CSP_BLOCKED`，脚本未执行；页面 `throw` 或 Promise rejection 保留原错误与已执行状态，错误文案中的 `CSP`、`Content Security Policy` 或 `unsafe-eval` 不改变来源

### manage - 页面与环境管理

| Action             | 描述                                             |
| ------------------ | ------------------------------------------------ |
| `newPage`          | 新建受控页面/Tab                                 |
| `pageMetadata`     | 读取或设置页面的 `taskHint`、`note`              |
| `closePage`        | 两种模式关闭页面并返回 `affected.before/after`   |
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
| `dialog`           | 观察或处理对话框                                 |
| `networkCapture`   | 启停原请求、正文和流消息采集                     |
| `route`            | 匹配并处理暂停请求                               |
| `httpAuth`         | 设置或清除限定范围的 HTTP 挑战凭证               |
| `download`         | 观察、等待和保存原下载文件                       |

原生 tab/window/group 配置使用 Extension 模式，`activatePage` 同时支持 CDP
操作已有对象时，用 `targetId`、`targetIds`、`windowId` 或 `groupId` 明确指定目标，返回 `affected.before/after`，分组结果还返回 `tabsBefore/tabsAfter`
`ungroupPages` 由 Chrome 删除空组，成员的受控权限保持不变

窗口显示操作和分组名称、颜色、折叠更新按显式 `windowId` 或 `groupId` 执行，允许包含非托管成员，成员页面权限保持不变
整组移动和关闭整窗要求全部受影响成员受控，加入或解除指定页面分组只检查指定页面，无关成员变化不阻止有效选择
默认在现有普通窗口后台创建页面，窗口包含非托管 tab 时也沿用该路径

Extension 的 `clearCache` 返回 `UNSUPPORTED_MODE`，保留全部内容
清 Cookie 使用带 `url` 或 `domain` 过滤的 `cookies(action="clear")`，清 storage 或 cache 使用 CDP 模式
`focusWindow` 在观测到目标窗口已聚焦后返回成功，否则返回 `WINDOW_FOCUS_NOT_OBSERVED`
`closeWindow` 遇到混有非托管 tab 的窗口时返回 `WINDOW_HAS_UNMANAGED_TABS`

持久的 `adoptPage`、`releasePage` 目标变更与指定 tab 的操作串行执行，并发多事件 input 始终留在指定 tab，持久目标变更在该操作结束后生效
CDP 的 `activatePage` 保留默认操作目标，返回该 backend 能读取的字段，`active` 和系统窗口焦点状态保持不可用

Extension 的 `viewport`、`userAgent`、`emulate`、原始 `cdp` 和 precise `evaluate` 支持受控 `about:blank` 页面，Chrome 内部页和 Extension 页继续受原生访问限制
不带 `device` 的 `manage(action="emulate")` 直接查询本地设备目录，无需有效页面，携带页面条件时明确拒绝；实际设置设备继续校验目标页面和条件

#### `newPage`

参数：`url`、 `windowId`、 `index`、 `active`、 `pinned`、 `openerTabId`、 `groupId`、 `timeout`、 `taskHint`、 `note`

`active` 默认 false，`groupId=-1` 不分组，显式位置不受默认显示分组改变

#### `updatePage`

参数：`url`、 `active`、 `pinned`、 `highlighted`、 `muted`、 `autoDiscardable`、 `openerTabId`

必须传 `targetId`，只支持 `active=true` 且不聚焦窗口，`active=false` 在任何更新前拒绝

#### `groupPages`

参数：`targetIds`、 `groupId`、 `windowId`、 `title`、 `color`、 `collapsed`

省略 `groupId` 时在成员原窗口创建分组，跨窗口成员须指定 `windowId`，加入已有组仅传 `targetIds/groupId`

#### `ungroupPages`

参数：`targetIds`

解除分组，保留受控能力

#### `updateGroup`

参数：`groupId`、 `title`、 `color`、 `collapsed`

空名称及 false 折叠值按原值设置

#### `moveGroup`

参数：`groupId`、 `windowId`、 `index`

移动全部成员，`index=-1` 表示窗口末尾

#### `newWindow`

参数：`url` 或 `urls`、 `targetId`、 `windowType`、 `focused`、 `incognito`、 `left`、 `top`、 `width`、 `height`、
`windowState`、 `setSelfAsOpener`

normal 支持多 URL 及同时移入已有受控页，popup 只接受一个页面，所有新建页受控且分别记录创建来源

#### `updateWindow` / `resizeWindow`

参数：`windowId`、 `left`、 `top`、 `width`、 `height`、 `windowState`、 `focused`、 `drawAttention`

应用 Chrome 支持的窗口配置并返回观测状态

`updateWindow` 与 `resizeWindow` 修改状态或几何后等待浏览器观测稳定，非 normal 窗口同时请求 `windowState="normal"`
和 bounds 时，状态转换完成后才应用一次几何参数，OS 调整后的几何按实际值返回
有界等待内仍未观测到稳定状态时，
`WINDOW_UPDATE_NOT_OBSERVED`
返回部分执行状态及最后观测的窗口信息，再次更新前用 `browse list` 检查实际状态
Chrome 因窗口超出可见屏幕范围而拒绝 bounds 时，使用当前屏幕可用区域内的坐标和尺寸；响应保留原始几何错误，不附带页面激活提示

`browse list` 默认 `details="summary"`，返回页面标识、URL/标题、位置、managed/revision 和元数据
传 `details="full"` 获取选中、静音、自动丢弃、来源 tab ID 和可用原生只读属性，false 值保留
`targetIds` 与 `managedOnly=true` 筛选页面及所属窗口、分组；`totalTargetCount`、`totalWindowCount` 和 `totalTabCount` 区分总量与选中数量
窗口通过 `targetIds` 引用页面，完整结果以 `favIconInline=true` 标明未内联的 favicon data URL

分组保留名称、颜色、折叠/共享、窗口、首个成员位置和成员 ID，颜色属于分组
原生只读属性用于回显，写入仍按各动作支持的字段校验；列表操作只读取这些元数据，保持页面正文、导航和焦点不变
旧 Extension 只返回分组摘要、未提供成员数组时，按同次响应的窗口和 tab 归属恢复组成员及首个成员位置，summary/full 和筛选共用该结果
完全没有分组信息时，响应省略 `groups` 并用 warning 说明原因；`groups: []` 表示没有分组，只提供一个成员数组等畸形分组数据返回错误

页面和分组移动接受 `index=-1`，新建页的 index 非负，来源 tab 与显式分组、窗口必须位于同一窗口，固定页不能在分组中创建
窗口状态与位置/尺寸的冲突、动作不支持的字段在修改前拒绝，CDP 对不支持的 Chrome UI 配置明确报错
`newWindow` 的 `url` 与 `urls` 互斥，在 normal 窗口中可与 `targetId` 同时使用；popup 只接受单个 URL 或一个已有页面

明确的创建前拒绝保留 `actionExecuted=false`、`actionStatus="not_started"` 和 `failureStage="preflight"`
更新在执行前拒绝时保留原 revision，原生更新已派发后的失败仍使 revision 失效

`emulate` 在两个 backend 中设置设备视口、像素密度、触摸能力和 User-Agent，`viewport`
恢复桌面视口与页面缩放并关闭触摸模拟，User-Agent 通过 `userAgent` 单独恢复

**Stealth 模式档位**（CDP launch 参数，通过 `browse action=launch stealth=...` 设置）：

- `off` — 关闭反检测（纯净模式，适合测试/CI）
- `safe`（默认）— 最小改动（移除 `navigator.webdriver`、清理 CDP 痕迹）
- `aggressive` — 增加少量 WebGL/插件/语言等指纹修补（不等于完整伪装）

页面管理使用 30000 ms 请求期限，`newPage` 传入 `timeout` 时采用该值，排队变更超期后在派发前返回错误
未附页面条件的 `pageMetadata` 使用显式 target 独立读取、更新或清空，同页或其他页面的长等待期间均可执行，每个请求保留自己的 URL/revision 条件；带条件的备注操作仍串行检查条件

分组操作与页面解除受控按涉及页面串行执行，持锁期间重新核对原生成员和权限；创建页面使用 `active`，`activate` 仅适用于 `movePage`

### 浏览器事件与原文件

点击下载链接、打开对话框或发起请求前准备观察，随后按返回的 `ref` 读取或处理对应事件
这些操作使用 `targetId` 指定的受控页面或当前默认页，默认目标改变后，引用仍指向原页面

| `manage` action  | 嵌套命令                                                        | 结果                                                    |
| ---------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| `dialog`         | `dialog:{op:"watch"\|"stop"\|"accept"\|"dismiss",ref?,text?}`   | 观察对话框，或处理一个已观察弹窗，`text` 为 prompt 答复 |
| `networkCapture` | `capture:{op:"start"\|"stop",include?:["body","stream"]}`       | 记录原请求，可选采集正文及 WebSocket/SSE 消息           |
| `route`          | `route:{op:"add"\|"remove"\|"continue"\|"fulfill"\|"fail",...}` | 匹配页面请求，或处理一个已观察的暂停请求                |
| `httpAuth`       | `auth:{op:"set"\|"clear",...}`                                  | 为明确的 Server/Proxy 挑战范围设置凭证                  |
| `download`       | `download:{op:"watch"\|"stop"\|"wait"\|"save",...}`             | 标识下载，等待原生状态，保存可取得的原始字节            |

#### 处理对话框

```text
manage(action="dialog", targetId="PAGE_ID", dialog={op:"watch"})
input(targetId="PAGE_ID", events=[{type:"click", target:{css:"#show-prompt"}}])
logs(type="dialog", targetId="PAGE_ID")
manage(action="dialog", dialog={op:"accept", ref:"DIALOG_REF", text:"答复"})
```

阻塞操作的对话框返回 `DIALOG_OPEN` 和引用，处理后检查原操作结果
原请求被弹窗阻塞期间，事件读取与处理仍可使用，`dismiss` 省略 `text`，`stop` 结束观察，读取日志保持弹窗原状

#### 读取原响应

```text
manage(action="networkCapture", targetId="PAGE_ID", capture={op:"start", include:["body","stream"]})
logs(type="network", targetId="PAGE_ID", view="details")
logs(type="network", view="responseBody", ref="REQUEST_REF", output="tmp:response.bin")
```

`details` 保留请求身份、重定向跳次、基础 headers、ExtraInfo headers 和完整性
`requestBody` 读取原 POST 数据，`responseBody` 读取协议提供的实体正文，显式 `output` 保存解码后的原始字节
内联正文使用 `{encoding:"utf8"|"base64",data}`，正文不可用或已被淘汰时返回错误，multipart 文件段和重定向正文受原生协议能力限制
单份正文须小于 16 MiB，headers、`cookieLine` 等 Cookie metadata 副本和 URL 中的认证字段会脱敏；`Location`、`Content-Location`、`Referer` 等 URL header 在结构化 metadata 和原始握手文本中均遮蔽用户信息与敏感查询值，显式请求的正文内容保持原始字节

`view="stream"` 按观察顺序返回 WebSocket 方向／opcode 和 SSE 消息，消费有界缓存时检查截断、`dropped` 和 `evicted` 字段
使用 `capture:{op:"stop"}` 结束采集

#### 继续或模拟匹配请求

添加路由时传 `urlPattern`，可选 `stage:"Request"|"Response"`
从 `logs(type="network",view="paused")` 取得暂停请求引用，再处理该请求：

```text
manage(action="route", targetId="PAGE_ID", route={op:"add", urlPattern:"https://example.com/api/*"})
logs(type="network", targetId="PAGE_ID", view="paused")
manage(action="route", route={op:"fulfill", ref:"PAUSED_REF", response:{status:200, body:{encoding:"utf8",data:"mock"}}})
```

`continue` 接受可选的 `request:{url?,method?,headers?,body?}`，headers 使用 `{name,value}` 数组
`fulfill` 要求 `response:{status,statusText?,headers?,body?}`，`fail` 接受原生 `errorReason`，默认 `Aborted`
使用 `op:"remove"` 和规则引用删除规则，未匹配请求立即继续
匹配请求暂停超过 30 秒，或发生取消、导航、解除受控、所属连接断开时，中止未解决的请求
原生命令回执丢失时保留未知状态，不自动重发，`clear` 清除读取缓存，活动暂停请求和弹窗保留处理引用
原始 `manage cdp` 的 Fetch 命令共用这些归属与清理规则

HTTP 认证使用 `auth:{op:"set",scope:{source:"Server"|"Proxy",origin,realm?},username,password}`
凭证只在内存中用于该页面和精确的挑战范围，失败后重复挑战会取消
通过 `logs(type="network",view="auth")` 读取脱敏状态，`auth:{op:"clear"}` 清除凭证

#### 保存下载文件

```text
manage(action="download", targetId="PAGE_ID", download={op:"watch",urlPattern:"https://example.com/files/*"})
input(targetId="PAGE_ID", events=[{type:"click",target:{css:"a.download"}}])
logs(type="download", targetId="PAGE_ID")
manage(action="download", download={op:"wait",ref:"DOWNLOAD_REF",timeout:30000})
manage(action="download", download={op:"save",ref:"DOWNLOAD_REF",output:"tmp:attachment.bin"})
```

原生下载 GUID 和状态区分“下载完成”与“原文件可交付”，`save` 要求下载已完成且 `artifact="available"`
保存操作使用截获的原响应，不重新请求下载 URL，原生 Save As、blob 下载或浏览器安全限制可使文件不可用，结果会说明原因
共享浏览器的下载策略保持原值，这条收件路径同样要求正文小于 16 MiB，`download:{op:"stop"}` 结束观察并释放拦截

引用绑定 Server 实例、页面和连接代次，失效或其他实例的引用会被拒绝
处理 Cloudflare 前结束当前 Fetch 控制并暂停这些观察，再解除 debugger 附加；查看返回的 `browserEvents` 状态，验证完成后按需显式重新开始观察
新增事件操作要求 Server 与 Extension 构建匹配，缺少原生能力时在启用拦截前报告限制
CDP 认证与响应捕获在连接请求结束后继续有效，后续每次工具调用使用各自的超时与取消信号

`cleanupFailures` 保留字符串数组，配套 `cleanupFailureDetails` 记录发生时间、阶段、已观测 ref 或 request ID、目标、owner 与 session generation
每个 controller 最多保存 20 条，dispose 时清除；新 controller 从空记录开始，已经返回的详情保留原始归属

### logs - 浏览器日志

| Type       | 描述                                         |
| ---------- | -------------------------------------------- |
| `console`  | 控制台日志（支持级别过滤）                   |
| `network`  | 请求摘要、详情、正文、暂停请求、认证及流消息 |
| `dialog`   | 对话框引用及待处理／关闭状态                 |
| `download` | 原生下载状态及原文件可用性                   |

参数：`output` 将结果保存到文件，console 日志统一返回公开级别 `error`、`warning`、`info`、`debug`，浏览器原始的 `warn`、
`log` 等级会在过滤和返回前转换，清空 fallback
console 日志会保留 hook，debugger 采集恢复后，fallback 采集会停用；仍指向 MCP
wrapper 的 console 方法会恢复，页面之后安装的 wrapper 保持不变
独立的 fallback console 调用即使时间戳和文本相同，也会保留各自的级别和次数；重复读取已排空的批次不会再次追加，恢复 debugger 采集时，待排空调用各保留一次，对应 Runtime 历史回放不重复追加，已清除的 fallback 调用保持已清除，缓冲区保留最新 1000 条
network 日志在 `loadingFinished` 或 `loadingFailed`
时才完成记录，不会在收到 headers 时提前结束，因此 body 失败会同时保留 HTTP status 和
`errorText`，传输中的 body 也会继续计入 `networkidle`，日志尽量返回 `method`、
`url`、`status`、`timestamp`、`duration`，URL
query 中常见的认证、签名、密码和 token 参数会在内联响应、diagnostics 和 显式 `output` 文件中替换为 `[REDACTED]`，并返回
`urlRedacted`、`urlOriginalLength` 和
`redactedQueryParameters`，内联 network 结果会把脱敏后的单条 URL 限制为 2048 字符，截断时返回 `urlLength` 和
`urlTruncated: true`，`urlPattern` 支持 `*` 匹配任意长度字符、`?` 匹配单个字符，`tabId`
指定目标 Tab（Extension 模式），`frame` 不适用于日志
network 各视图中的 `urlPattern` 按请求 URL 过滤，包含暂停请求和认证事件，过滤后再应用 `limit`；`clear` 保留仍需处理的请求

Extension debugger 不可用时，network 每次读取都会刷新 performance 记录并标记
`source="performance"`；状态使用浏览器提供的 `responseStatus`，无法取得时为
`0`，未知请求方法保留空值，重复读取保留记录序列号；`clear`
清除 MCP 记录并推进当前文档的读取边界，不清除网页共享的 performance 数据，新文档重新建立边界，读取失败返回错误，不冒充空日志

CDP 网络日志在响应体传输失败时保留 HTTP 状态，每个请求只记录一次终态，临时选择其他页面时保留各目标独立的日志
清除日志只删除已缓冲记录，在途请求保留到最终事件，清除后完成的请求会出现在新日志中

### cookies - Cookie 管理

| Action   | 描述                                                   |
| -------- | ------------------------------------------------------ |
| `get`    | 获取 Cookie                                            |
| `set`    | 设置 Cookie                                            |
| `delete` | 删除 Cookie                                            |
| `clear`  | 在 URL 或域名范围内删除 Cookie，可用 `name` 进一步过滤 |

所有 action 支持 `targetId`、`partitionKey:{topLevelSite?,hasCrossSiteAncestor?}` 和对应后端的存储范围：Extension 使用 `storeId`，CDP 使用 `browserContextId`
Extension 将目标页映射到原生 CookieStore，显式 store 与目标冲突时拒绝，不适用当前后端的范围字段返回错误
省略这些字段时沿用原 URL/domain 行为，`get` 至少需要一个非空白 name、domain 或 url，存储上下文和其他条件只进一步限定这个读取范围，导出文件遵守相同校验

URL 过滤在 target 与 browser context 作用域下同样遵守 Cookie 路径边界，Path 为 `/app` 的 Cookie 匹配 `/app/info`，`/apple/info` 会将其排除

`clear` 必须指定 url 或 domain，name 仅进一步缩小范围，CDP 删除保留所选 Cookie 的完整 name、原始 domain、path、partition 与 browser context，省略 target 时在清除开始固定当前页的存储上下文，分区身份无法序列化时在删除前拒绝

CDP clear 的 count 统计紧邻删除前检查为存在、请求收到 ACK 后检查为消失的 Cookie 身份，`countSemantics="observed_present_then_absent"` 标识该状态比较，acknowledged 统计原生 ACK，alreadyAbsent 统计预检查时已消失的身份，matched 与 attempted 分别表示候选总数和已开始删除的步骤数，网页并发修改可发生在两次观察之间，Extension 沿用原生移除确认计数

CDP 在首次删除、验证或连接清理失败时停止，返回 COOKIE_CLEAR_PARTIAL，保留已知 count、ACK 数、失败或未知步骤、未处理数量、阶段与原始原因，动作状态保留先前修改并返回 retryable=false，临时 session detach 失败也保留此前 ACK 和已经验证的消失状态

删除已经发送、ACK 尚未收到时，连接关闭、主动关闭、超时或取消均计为 unknown，首项未知返回 `actionStatus="unknown"`，此前已有 ACK 时保留 partial，failed 统计明确拒绝、未派发的删除步骤，以及 ACK 后仍存在的身份，删除尝试后的未分类错误保持未知，后续删除停止

MCP 取消会停止排队的 Cookie 请求、连接等待及两个后端的后续删除，CDP 保留此前确认的进度和未收到 ACK 的删除未知结果，临时 attach 在取消或超时后继续负责接收原生响应，迟到成功获得的 session 使用独立 1000 ms 预算分离，清理失败时日志保留命令及 session 身份，归属记录保持到连接关闭，删除不重放，Extension RPC 在回包前取消时返回该 RPC 结果未知，Extension 在当前原生调用结算后停止剩余移除

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

### 嵌套 frame 操作

两种后端的 iframe 选择器和索引均覆盖 open ShadowRoot，跨源与 OOPIF frame 准备使用原请求期限，脚本派发前超时返回 `actionExecuted=false`、`actionStatus="not_started"`，并尝试恢复原默认目标

```
// 通过 CSS 选择器指定 iframe
evaluate(script="document.title", frame="iframe#main")

// 通过索引指定 iframe
extract(type="text", frame=0)

// 每一步相对于当前父 frame 定位，CDP 同时支持 OOPIF
evaluate(script="document.title", frame=["iframe#outer", "iframe#inner"])

// 在 iframe 内输入
input(events=[
  { type: "mousedown", target: { label: "用户名" } },
  { type: "mouseup" },
  { type: "type", text: "admin" }
], frame="iframe.login-frame")
```

CSS 选择器和数字索引按父文档的 DOM
iframe 顺序定位，DOM 中不存在的子 frame（包括其他 Extension 加入的 frame）不会改变索引，也不会成为候选目标，所选元素无法对应到唯一
Chrome
frame 时返回 `FRAME_IDENTITY_UNAVAILABLE`，不会选择其他 frame；precise
evaluate 按含 query 和 fragment 的完整 URL 定位，并按所选 DOM iframe 区分 URL 相同的 frame，包括
`about:srcdoc`，无法确认身份时拒绝执行

frame 定位失败分别返回 `INVALID_FRAME_SELECTOR`、`FRAME_NOT_IFRAME` 或 `FRAME_NOT_FOUND`，读取注入区分
`INVALID_SELECTOR`、`FRAME_STALE_CONTEXT`、`FRAME_INJECTION_DENIED`、`FRAME_SCRIPT_FAILED`、 `FRAME_INJECTION_FAILED` 和
`FRAME_SCRIPT_NO_RESULT`，并报告注入或脚本结果阶段，无结果不等于 selector 非法，空文本、空元素数组、null 属性值和 void
脚本调用保持原语义，错误不会重放脚本；成功定位后的读取失败在
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
- **iframe**：嵌套定位使用选择器／索引数组，XPath 保持原生文档作用域

## 兼容客户端

| 客户端              | 状态 |
| ------------------- | ---- |
| Claude Code         | ✅   |
| Claude Desktop      | ✅   |
| Cursor              | ✅   |
| Windsurf            | ✅   |
| 其他 MCP 兼容客户端 | ✅   |

## 许可证

MIT 许可证 - 详见 [LICENSE](LICENSE)

## 相关项目

- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP 规范
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) - CDP 文档
