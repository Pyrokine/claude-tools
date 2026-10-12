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
- Extension 模式的 `adoptPage`
  只标记受控页面，不授予内容读取、脚本或写权限；普通读取需在 popup 获取单页授权，测试操作可用 `newPage` 创建页面
- 单页普通读取授权覆盖 text、HTML、attribute、computed
  style 与 state，不开放任意 JavaScript、CDP/debugger、input 或 screenshot
- `tmp:` 文件只属于当前 MCP server 会话；重启后需重新生成，需保留的文件应在服务器退出前保存到 `cwd:`

本地零配置自动连接保持不变，刷新 Extension 或重启 MCP client 后不需要手动点击“连接”

## 兼容客户端

| 客户端              | 状态 |
| ------------------- | ---- |
| Claude Code         | ✅   |
| Claude Desktop      | ✅   |
| Cursor              | ✅   |
| Windsurf            | ✅   |
| 其他 MCP 兼容客户端 | ✅   |

## 安装

需要 Node.js 20.19 或更新版本。

### npm

```bash
npm install -g @pyrokine/mcp-chrome
claude mcp add chrome -- mcp-chrome
npm root -g
```

Extension 模式需要打开 `chrome://extensions/`，启用开发者模式，点击“加载已解压的扩展程序”，选择
`<npm-root>/@pyrokine/mcp-chrome/extension/dist`。

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

Extension 模式需要在 Chrome 中加载 `extension/dist`。

### Windows CDP 启动

Chrome 自动查找 Windows App Paths、`PATH`、已安装的 Chrome channels、Chromium、Chrome for Testing，以及
`MCP_CHROME_PORTABLE_DIR` 或 `%USERPROFILE%\\.mcp-chrome\\portable`，也可以在 PowerShell 中启动独立的 CDP 浏览器：

```powershell
& '<npm-root>\@pyrokine\mcp-chrome\scripts\start-chrome.ps1' -Port 9222
# 也可显式指定便携版可执行文件和独立 profile：
& '<npm-root>\@pyrokine\mcp-chrome\scripts\start-chrome.ps1' -Port 9222 -ExecutablePath 'C:\Browsers\chrome.exe' -ProfileDir 'C:\Temp\mcp-chrome-profile'
```

随后调用
`browse(action="connect", port=9222)`。脚本让 Chrome 进程保持前台运行，并报告退出码；使用独立 profile，避免请求被已有 Chrome 实例接管。

## 快速开始

### 模式一：Extension 模式（推荐）

Extension 模式操控你现有的 Chrome——共享登录状态、Cookie 和浏览上下文，

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
表示 Chrome 仍在执行旧的已解压 Extension，需要在 `chrome://extensions/` 刷新该 Extension。旧版 Extension 缺少
`network_challenge_state` 时会回退为 tab 标题和 DOM 的 Challenge 检测，bundle identity 不会关闭零配置自动连接，

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
popup 关闭“允许无 token 本地连接”。关闭后会立即取消进行中的 health
check、WebSocket 握手和已安排的重连，旧的无 token 连接尝试不会在策略更新后重新连入，

### 模式二：CDP 模式（回退）

CDP 模式启动或连接独立的 Chrome 实例，适用于未安装 Extension 或需要无头/隔离的场景，

```bash
# 启动带远程调试的 Chrome
google-chrome --remote-debugging-port=9222
```

```
browse(action="connect", port=9222)
browse(action="open", url="https://example.com")
```

> 已连接的 Extension 是所有工具的默认模式，Extension 不可用时才回退到 CDP。`browse(action="connect", port=9222)`
> 会为后续工具显式选择 CDP；调用不带 port 的 `browse(action="connect")`
> 会回到 Extension。仅因回退而建立的 CDP 连接会在 Extension 重连后让出默认模式，

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
`windowCount`、`focusedWindowId`、`activeTargetId` 和每个窗口按顺序排列的 `tabs`。`defaultTargetId`
是默认操作目标，CDP 不用选中的操作目标推断浏览器前台页面，`open`
自动创建 Tab 分组（cyan 色），`open`、`back`、`forward`、`refresh` 支持 `diagnostics=true`，返回动作期间新增的 console
warning/error 和失败网络请求摘要，也覆盖首次 `open` 自动创建页面的场景。两个 driver 的 `open` 和 `refresh` 都支持
`wait="load"`、`wait="domcontentloaded"` 和
`wait="networkidle"`。等待器会在命令前建立，并绑定命令产生的新主文档，上一导航的迟到生命周期事件不会提前完成等待。CDP模式的
`networkidle` 等待当前主 frame loader 的 `networkIdle`
事件；Extension 模式会等待当前文档完成、所有已跟踪响应 body 结束和 500
ms 静默窗口。请求跟踪发生丢失时返回超时，不会误报空闲。`close` 必须传
`targetId`，且只关闭该页面，不会关闭整个 CDP 连接，

Extension 模式的 `back/forward`
优先使用浏览器原生历史，只有原生 API 明确报告无历史时才允许尝试页面脚本；受限 URL 和浏览器错误页不注入没有可用历史时返回
`navigated=false`，其他原生错误保留；execution
context 失效或浏览器拒绝向错误页注入时，仍返回操作失败，Extension 将其记录为预期操作警告；任意 debugger 命令不自动重放

页面类工具在两种 backend 中都接受 `targetId`，旧版 `tabId`
仍可用；同时提供时两者必须一致。显式目标只作用于当前操作，结束后恢复原默认目标。`browse.close` 和 `manage.closePage`
必须显式指定 ID。页面动作成功或失败时，响应中的 `pageContext`
包含实际目标及来源（`explicit`、`default`、`created`、`reused`、`unconfirmed`）、前后 URL/revision、默认目标前后状态，以及 Extension 报告的浏览器活动目标；创建页面失败且未返回创建 ID 时标为
`unconfirmed`。CDP 的活动状态标为不可用，不把操作目标当作前台页面。

临时目标的恢复结果通过 `pageContext.targetRestoration` 单独报告，`restored` 表示恢复原默认目标，`cleared`
表示原先无默认目标并清除临时选择，`previous_target_closed` 表示原默认页已关闭并清除选择，`failed`
表示恢复或清理失败并清除临时选择；`error` 与 `cleanupError` 分别保存对应错误信息

主动作结果或原错误保留，已完成的输入不会重放，也不会报为未执行；`browse attach` 与 `manage adoptPage`
继续持久选择默认目标，并发响应记录各自实际操作的页面

`browse.list` 返回各页面的 revision 和元数据。revision 由 backend
epoch 与单页计数构成；Extension 跟踪主 frame 导航和 MCP 动作，CDP 跟踪已附加页面的导航，并保守计入发出的变更命令，包括 evaluate。网页自身的任意 DOM 更改不在跟踪范围内，条件动作前应重新获取 URL/revision。`browse`
导航/关闭、`input`、`evaluate` 及适用的 `manage` 页面动作接受 `expectedUrl` 和
`expectedRevision`；backend 检查不符时返回
`ACTION_PRECONDITION_FAILED`，不发送对应页面动作，复合动作在首个变更命令前检查，不在每个事件前重复检查；失败或超时后如已产生部分效果，revision 仍可能变化

`browse` 仅 `open`、`back`、`forward`、`refresh`、`close` 接受这两个条件，`attach` 等其他动作在改变目标前返回
`INVALID_ARGUMENT`

Extension popup 可为一个非创建页面向当前连接的单个服务器实例授予普通读取权限，同一连接和文档未变化时，Service
Worker 重启后仍可读取；导航、关闭页面或断开连接后授权失效。`targetId` 和 `adoptPage`
均不能代替读取授权。授权覆盖定向文本、HTML、属性、计算样式及页面状态读取；任意脚本、debugger、截图、输入和 Cookie 访问不继承授权，现有 Cookie 工具仍按独立的 URL/name 过滤规则执行。`manage(action="pageMetadata", targetId=...)`
可以读取或更新
`taskHint`、`note`，列表还会显示创建与最近使用时间。这些元数据只在服务器进程中保存，关闭页面时删除，不参与内容读取授权。

### 访问验证

`open`、`back`、`forward`、`refresh`、`input` 和 `evaluate` 之后，MCP Chrome 会等待 Cloudflare JS Challenge 或 Turnstile
checkbox。Extension 模式下，导航先不启用 debugger 日志采集，连续八秒被动读取真实 tab 标题。interstitial 持续存在时，才检查可见 Turnstile 控件，找到后才点击。Extension
inspect 走 isolated world，检查前先卸掉 debugger。同页测试按钮走页面点击；出现 Cloudflare Turnstile
iframe 时，把 inspect 的 CSS 坐标换成屏幕坐标，系统鼠标沿路径移动、悬停后再按下抬起：Linux 用
`xdotool`，并以当前 X11 活动窗口原点加窗口边距为准，且窗口标题必须对应该测试页，不用 Chrome `screenX`，也不用
`outerHeight - innerHeight` 当顶栏；macOS 用 `cliclick` 或 System Events；Windows 用 PowerShell
`mouse_event`。widget 点 compact
Turnstile 卡片左侧 checkbox，宿主 wrapper 比卡片宽时也只点左侧卡片，不点文案。DOM 里已有 Cloudflare
iframe 时，即使 iframe 尺寸为 0，也走系统鼠标，不改用页面点击，后续宿主页 `Verify you are human` / `请验证您是真人`
按钮同样走系统鼠标。系统鼠标只在受控测试页已经是已聚焦窗口的活动 tab 时使用，混合窗口不会调用 `focusWindow`。

系统点击前会卸掉 debugger，再读一次视口。缺少系统鼠标工具或窗口未聚焦时返回可见错误，不会静默改用 CDP 点击。

widget 要连续两次 inspect 到同一坐标才点；系统鼠标从远处过来时从控件附近起步。同一类 checkbox 或 compact
widget 在同一次等待里最多点一次；Cloudflare 随后换成可见的 `Verify you are human` 或 `请验证您是真人`
按钮时，inspect 判成 `verify` 后再点一次。访问受 Cloudflare 保护的页面默认保持
`diagnostics=false`，因为 diagnostics 会启用 debugger 的 console 和 network 采集。

检测覆盖 `Just a moment...`、`请稍候…` 等标题、Challenge DOM、正文标记和 `Verify you are human` / `请验证您是真人`
控件。CDP 用 `Target.getTargetInfo` 读取实时标题。页面恢复后残留的 Cloudflare
iframe 不算等待中，缓存标题不参与判定。不会调用 CAPTCHA solver、不会自动重试导航，也不会导出 `cf_clearance`
的值。CDP 超时不代表网站在用户真实 Chrome 中无法通过，排查网站前先检查返回的 `mode`。

过盾成功时返回 `challengeResolved=true`、`challengeKind`、`waitedMs`、`clickedTurnstile` 和 `clearanceCookiePresent`
（只表示 cookie 名是否存在）。页面可见文案显示验证成功、正在等待源站时，响应还会含
`originResponsePending=true`，表示已过盾但目标页面尚未加载。隐藏的成功文案（例如 `display:none`
的标题）不算过盾，可见 Turnstile 勾选框仍视为等待中。Challenge 成功和失败响应都含 `mode`。超时返回 `CHALLENGE_TIMEOUT`
且 `retryable=true`，并带 `clickedTurnstile` 和实际观察到的 `challengeKind`（点过 Turnstile 时不会报成 `js`）。Access
denied 返回 `CHALLENGE_DENIED`。交互式验证码、Bot Fight
Mode 和 IP 声誉检查无法靠等待或点击 checkbox 完成。之后的正常主文档响应才会清掉 header 标记，普通 iframe 文档响应和清空网络日志都不会清掉它，

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

`events` 至少需要一个事件。参数：`humanize` 启用贝塞尔曲线移动和随机延迟，`diagnostics=true` 返回动作后新增 console
warning/error 和失败网络请求， `postCondition`
会在事件发送后等待页面状态，便于区分输入事件已发送和页面业务状态已完成，`postCondition.timeout` 默认 3000 ms、最大 60000
ms，`postCondition.interval` 默认 100 ms、范围 50-5000 ms。`postCondition.script` 可传表达式、函数、async
function 或 Promise 表达式；函数会被调用，最终 Promise 值会被等待后再判定，抛错或 reject 会让检查失败。`targetId`（或旧版
`tabId`）在两种 backend 中指定页面；`frame`
在 Extension 模式中指定 iframe（CSS 选择器或索引），传入任一作用域时，动作、诊断和 post-condition 使用该目标作用域选定的同一个 backend，

**`click` 专属参数**：`force: true` 必须提供 `forceReason` 和非坐标型元素
`target`，它会跳过可操作性检查（适用于测试隐藏元素等场景），但仍只分发标准 DOM 鼠标事件序列，不会直接调用框架私有 handler 中键、右键和多击采用同一检查规则，坐标型或省略 target 的点击不能使用 force，可操作性失败返回
`ACTIONABILITY_FAILED`，包含 `rect`、`clickPoint`、遮挡元素、候选遮挡物和修复建议， **`type`
专属参数**：`mode="controlled"` 或 `dispatch: true` 直接设置 `.value` 并触发 `input`/`change`
事件，兼容 React/Vue 等框架的受控组件（键盘事件无法触发状态更新时使用），需要非坐标型
`target`，仅限 Extension 模式，受控输入和目标查找失败时返回结构化 context，包含 `locator`、`matchCount`、`nth`
和有数量上限的 `candidates`，选区相关错误另含编辑器与选区状态，password
input 的 value 不进入失败诊断，失败响应也会脱敏 input 事件传入的 `find` 和替换 `text`，`select` 和 `replace` 的事件级
`nth` 表示文本第 N 次出现，嵌套的 `target.nth` 表示第 N 个目标元素，两者都从 0 开始并可同时使用，CDP 模式的 locator
target 不依赖 Extension refId，

**`keydown` 专属参数**：

- `commands`：触发浏览器原生编辑命令（如 `["selectAll"]`、`["copy"]`、`["paste"]`、`["cut"]`、`["undo"]`、`["redo"]`
  ），成功表示浏览器已接受命令分发，页面结果需用 `postCondition` 或 `extract`
  验证，仅 precise 模式可用，stealth 模式下抛错（CDP commands API 没有 JS 事件等价物）
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

参数：`output` 将结果保存到文件（`images=data` 时为输出目录），`images`（`info`/`data`）提取 HTML 中的图片元信息或数据，
`frameHtml` 在 `frame` 路由后提取当前 iframe 文档，截图支持 `clip` 坐标区域、`compareWith` PNG 基准对比和 `diffOutput`
差异图输出，`diffOutput` 必须同时传 `compareWith`。指定 `target` 的截图未匹配、`nth`
越界或尺寸为零时返回目标错误，不会静默返回视口截图，截图响应包含
`metadata.format`、`width`、`height`、`dimensionSource`、`byteSize`、`fullPage`、`scale`、`clip` 和
`capabilities`。截图在执行前限制单边 16,384 像素、总计 12,000,000 像素、预计 RGBA 内存 48 MiB 和编码数据 25
MiB；基准 PNG 在读取前检查文件大小，对比在解码前限制单个 PNG 25
MiB 和 12,000,000 像素，解压时按已校验尺寸限制输出，并要求 scanline 长度精确匹配；损坏或异常膨胀的 PNG 会被拒绝，较大截图应使用
`clip` 或 `scale` 缩小。Extension hidden tab 截图返回 `HIDDEN_TAB_SCREENSHOT`，不会自动切前台，`state` 返回
`interactiveElements`，Extension 和 CDP 模式下 `metadata` 都返回
`frames`，如果其他 debugger 占用 precise 截图路径，可视区域 fallback 会返回 `degraded`、`fallback` 和
`limitations`；fallback 不支持的参数返回结构化 `SCREENSHOT_FALLBACK_UNSUPPORTED`，`targetId`（或旧版
`tabId`）在两种 backend 中指定页面，`frame` 仅在 Extension 模式中指定 iframe，

**`attribute` 特殊前缀**：`computed:<属性名>` 返回 computed CSS 样式值（如 `computed:color`、`computed:font-size`），
`computed:*` 返回全部计算样式（300+ 属性，建议配合 `output` 写文件），

**`state` 专属参数**：`depth` 控制 DOM 遍历深度（默认 15），减小可降低大页面的返回数据量， `mode` 选择数据源 —
`accessibility`（默认，从无障碍树派生）或 `domsnapshot`（CDP `DOMSnapshot.captureSnapshot`，仅 CDP 模式，返回带 computed
style 的扁平节点数组，便于二次处理），

### wait - 等待条件

| For          | 描述                                         |
| ------------ | -------------------------------------------- |
| `element`    | 等待元素（visible/hidden/attached/detached） |
| `navigation` | 等待导航完成                                 |
| `time`       | 固定延迟                                     |
| `idle`       | 等待 DOM 或网络静默期                        |

参数：`targetId`（或旧版 `tabId`）在两种 backend 中指定页面，`frame` 在 Extension 模式中指定 iframe，

CDP 模式的 `visible` 要求 DOM 矩形宽高非零，且 CSS 不隐藏元素（`display:none` 或 `visibility:hidden/collapse`） `hidden`
接受这些隐藏状态或元素不存在，`attached` 和 `detached` 只检查元素是否存在

**`idle` 说明**：Extension 模式会在 `readyState === 'complete'` 后注入 `MutationObserver`，等待 `ms`
毫秒内无 DOM 变更；CDP 模式等待网络静默。两种模式的默认 `ms` 都是 500ms，响应返回 `idleKind` 和
`idlePeriodMs`，Extension 响应还返回 `domStable`，

### evaluate - JavaScript 执行

在页面上下文执行 JavaScript，

| 参数                 | 描述                                                    |
| -------------------- | ------------------------------------------------------- |
| `script`             | JavaScript 代码，裸 `return` 语句自动包裹 IIFE          |
| `scriptFile`         | 从本地文件读取脚本，与 `script` 二选一                  |
| `args`               | 传递给脚本的参数，script 须为函数表达式                 |
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
`..`，Windows 下也会拒绝 `:`，避免落到 NTFS alternate data stream，`output` 对字符串写原始文本，对其他类型写 JSON，

结果超过 100KB 时自动写入文件到受控的系统临时目录，返回文件路径和大小，返回 DOM 节点、`NodeList` 或 `HTMLCollection`
时返回 `NON_SERIALIZABLE_EVALUATE_RESULT`，并提示改为返回 `textContent`、`outerHTML`
等简单字段，结果展开或序列化失败时返回 `actionExecuted=true`、`actionStatus="completed"` 和
`failureStage="output"`，因为页面脚本已经完成，evaluate 即使在全局 `inputMode=stealth` 时也默认使用 `precise`，其
`postCondition` 检查与主动作使用相同 evaluate mode，`postCondition` 不传时， `success=true`
只表示脚本完成执行并返回；传入后如果超时仍不匹配，返回 `POST_CONDITION_FAILED` 和最后一次检查结果，iframe
precise 执行默认不在 execution context 失效后重放脚本，只有脚本无副作用时才应传
`staleContextRetry="readOnly"`，Extension 会在剩余 timeout 内重新解析 context，并最多重放一次，`Runtime.evaluate`
发出后发生 stale context 时返回
`actionExecuted=true`、`actionStatus="unknown"`，因为脚本可能已经产生部分副作用，但无法取得最终结果，

### manage - 页面与环境管理

| Action         | 描述                                             |
| -------------- | ------------------------------------------------ |
| `newPage`      | 新建受控页面/Tab                                 |
| `pageMetadata` | 读取或设置页面的 `taskHint`、`note`              |
| `closePage`    | 关闭受控页面并返回 `affected.before/after`       |
| `adoptPage`    | 将已有 Tab 标记为受控页，不切前台                |
| `releasePage`  | 将受控页移出管理，不关闭页面                     |
| `movePage`     | 将受控 Tab 移到指定窗口或 index                  |
| `reorderPage`  | 调整受控 Tab 在当前窗口内的顺序                  |
| `pinPage`      | 固定受控 Tab                                     |
| `unpinPage`    | 取消固定受控 Tab                                 |
| `activatePage` | 激活受控 Tab 并聚焦所在窗口                      |
| `focusWindow`  | 聚焦显式指定的窗口                               |
| `resizeWindow` | 调整显式指定窗口的尺寸或状态                     |
| `newWindow`    | 新建受控窗口                                     |
| `closeWindow`  | 仅当窗口内全是 managed tab 时关闭窗口            |
| `clearCache`   | 清除缓存/存储（清除 Cookie 请用 `cookies` 工具） |
| `viewport`     | 设置视口大小                                     |
| `userAgent`    | 设置 User-Agent                                  |
| `emulate`      | 设备模拟（iPhone、iPad 等）                      |
| `inputMode`    | 查询或设置输入模式（`precise` / `stealth`）      |
| `stealth`      | 注入反检测脚本                                   |
| `cdp`          | 发送原始 CDP 命令（高级，如 `Runtime.evaluate`） |

Tab/window 管理动作仅支持 Extension 模式，改变浏览器可见状态的动作必须显式传 `targetId` 或 `windowId`，并返回
`affected.before/after`。Extension 模式不支持 `clearCache`，会返回 `UNSUPPORTED_MODE` 且不清除任何内容；清 Cookie 请用带
`url` 或 `domain` 过滤的 `cookies(action="clear")`，清 storage 或 cache 请改用 CDP 模式。`focusWindow`
只有在观测到目标窗口已聚焦后才返回成功，否则返回 `WINDOW_FOCUS_NOT_OBSERVED`，`closeWindow`
遇到混有非托管 tab 的窗口会返回 `WINDOW_HAS_UNMANAGED_TABS`。持久的 `adoptPage`、`releasePage`
目标变更与指定 tab 的操作串行执行，并发多事件 input 会始终留在指定 tab，持久目标变更会在该操作结束后生效

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
`log` 等级会在过滤和返回前转换。清空 fallback
console 日志会保留 hook。debugger 采集恢复后，fallback 采集会停用；仍指向 MCP
wrapper 的 console 方法会恢复，页面之后安装的 wrapper 保持不变。network 日志在 `loadingFinished` 或 `loadingFailed`
时才完成记录，不会在收到 headers 时提前结束，因此 body 失败会同时保留 HTTP status 和
`errorText`，传输中的 body 也会继续计入 `networkidle`。日志尽量返回 `method`、
`url`、`status`、`timestamp`、`duration`，URL
query 中常见的认证、签名、密码和 token 参数会在内联响应、diagnostics 和 显式 `output` 文件中替换为 `[REDACTED]`，并返回
`urlRedacted`、`urlOriginalLength` 和
`redactedQueryParameters`，内联 network 结果会把脱敏后的单条 URL 限制为 2048 字符，截断时返回 `urlLength` 和
`urlTruncated: true`，`urlPattern` 支持 `*` 匹配任意长度字符、`?` 匹配单个字符，`tabId`
指定目标 Tab（Extension 模式），`frame` 不适用于日志，

### cookies - Cookie 管理

| Action   | 描述                                                   |
| -------- | ------------------------------------------------------ |
| `get`    | 获取 Cookie                                            |
| `set`    | 设置 Cookie                                            |
| `delete` | 删除 Cookie                                            |
| `clear`  | 在 URL 或域名范围内删除 Cookie，可用 `name` 进一步过滤 |

**说明**：`clear` 必须指定 `url` 或 `domain`。`name` 只能在该范围内进一步过滤，避免误删其他站点的同名 Cookie。返回的
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

`tmp:` 路径属于当前 server 会话。临时输出整个会话最多 256 项、128
MiB；启动时只清理超过 24 小时且所属进程已退出的带归属标记目录。成功写入 `tmp:` 文件或目录的响应会返回 `retention`
清理条件，`cwd:` 响应不带此字段。重启后仍需通过 MCP 访问的文件使用
`cwd:`。输出路径拒绝 Windows 保留设备名、ADS、非法字符以及末尾空格或点号；Windows 上写入敏感内容前须验证私有 DACL。

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
frame 时返回 `FRAME_IDENTITY_UNAVAILABLE`，不会选择其他frame

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
- **警告**：这些修补不能过 Cloudflare。JS Challenge 和 Turnstile
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
`retryable`。验证状态分为
`matched`、`not_matched`、`unavailable`、`error`；debugger 超时且无法证明脚本已停止时，动作状态为
`unknown`。页面脚本抛异常时返回 `actionExecuted=true` 和 `actionStatus="failed"`；结果展开或序列化失败时返回
`actionStatus="completed"` 和 `failureStage="output"`。页面前置条件不符时，input 和 evaluate 返回
`actionExecuted=false`、`actionStatus="not_started"`。diagnostics 是附加能力，失败时返回
`diagnosticsStatus`，不会覆盖主动作结果。browse 和 wait 的主动作失败时，也会保留失败前已收集的 diagnostics。目标诊断会读取当前 tab 的实时状态，不依赖 attach 时缓存的 URL 和标题。

`replace` 仅对 `textarea` 以及 `text`、`search`、`tel`、`url`、`password`
类型的 input 使用文本选区。其他 input 类型通过原生完整 value 更新，并返回请求值与浏览器规范化后的实际值。对不支持选区的类型单独执行
`select` 会返回 `UNSUPPORTED_SELECTION`。CDP模式下，`select` 和 `replace` 的 locator target 通过 CDP
locator 聚焦，不调用 Extension refId。password value 不进入 input 失败 context 和 text
post-condition 观测值，失败响应还会脱敏传入的 `find` 和替换
`text`。目标超时返回限量的locator、tab、frame、匹配数和候选上下文。显式 `tabId` 或 `frame`
作用域会在 input、wait、logs、extract 开始前确定活动 backend，动作和验证使用同一个目标 backend。precise iframe
evaluate 默认使用 `staleContextRetry="never"`，context 失效时不重放脚本； `readOnly` 允许 Extension 校验 frame
identity 并解析新 execution context 后重放一次。响应包含策略、`retryAttempted`、限量的 `retryReason`，以及最终 Extension
frame、parent frame、URL、CDP frame 和 execution context ID 组成的
`frameContext`，重复 URL 导致 frame 不唯一时拒绝选择任一 frame。端口扫描会把普通的 WebSocket
open 前失败聚合为 debug；已识别 MCP server 的认证或协议拒绝只在摘要变化时输出一条限量 warning。
