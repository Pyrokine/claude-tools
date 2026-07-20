# MCP-Chrome

[English](README.md) | 中文

Chrome 浏览器自动化 MCP Server，双模式架构：**Extension 模式**（推荐）操控现有浏览器，**CDP 模式**（回退）启动独立实例

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.19-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io/)

## 功能特性

- **双模式**：Extension 模式共享登录状态；CDP 模式用于无头/隔离场景
- **8 个统一工具**：基于 action 的设计，覆盖浏览、输入、提取、等待、执行、管理、Cookie、日志
- **多 Tab 并行**：`tabId` 参数支持对任意 Tab 操作，无需切换焦点
- **iframe 穿透**：`frame` 参数支持操作 iframe 内元素（CSS 选择器或索引，Extension 模式）
- **语义化定位**：11 种元素定位方式（role、text、label、css、css+文本组合、xpath、坐标等）
- **自动等待**：内置可点击性、可输入性检测，基于 deadline 的超时预算机制
- **双输入模式**：`precise`（debugger API，可绕过 CSP）或 `stealth`（JS 注入，无调试横幅）
- **智能输出**：裸 `return` 语句自动 IIFE 包裹；大结果（>100KB）自动写入文件；`output` 对字符串写入原始文本
- **多服务器**：Extension 自动发现并同时连接多个 MCP Server 实例
- **反检测**：可选的指纹伪装和行为模拟
- **结构化错误**：每个错误包含 code、message、suggestion、context

## 兼容客户端

| 客户端            | 状态 |
|----------------|----|
| Claude Code    | ✅  |
| Claude Desktop | ✅  |
| Cursor         | ✅  |
| Windsurf       | ✅  |
| 其他 MCP 兼容客户端   | ✅  |

## 安装

需要 Node.js 20.19 或更新版本。

### npm

```bash
npm install -g @pyrokine/mcp-chrome
claude mcp add chrome -- mcp-chrome
npm root -g
```

Extension 模式需要打开 `chrome://extensions/`，启用开发者模式，点击“加载已解压的扩展程序”，选择 `<npm-root>/@pyrokine/mcp-chrome/extension/dist`。

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
      "args": [
        "/path/to/mcp-chrome/dist/index.js"
      ]
    }
  }
}
```

**第三步：连接**

Extension 通过 HTTP/WebSocket 自动连接 MCP Server（端口 19222-19299），点击工具栏图标可查看连接状态，`browse(action="connect")` 和本地 `/api/info` 会返回当前活动 Extension 后台 bundle 的 hash，并与 server 附带的 bundle 比较，`bundleStatus="stale"` 表示 Chrome 仍在执行旧的已解压 Extension，需要在 `chrome://extensions/` 刷新该 Extension，旧版 Extension 未上报 hash 时仍可连接，bundle identity 不会关闭零配置自动连接，

```
browse(action="list")          // 列出所有 Tab
browse(action="open", url="https://example.com")
extract(type="screenshot")
```

**配对 token**

Extension 模式默认保留零配置本地自动连接，在多用户机器、CI runner、或不可信本地进程可访问 `127.0.0.1:19222-19299` 的容器环境中，启动 MCP server 时设置 `MCP_CHROME_PAIRING_TOKEN`，再在 Extension popup 中输入同一个 token：

```bash
MCP_CHROME_PAIRING_TOKEN="your-token" node /path/to/mcp-chrome/dist/index.js
```

需要强制配对 token 时，在 server 设置 `MCP_CHROME_ALLOW_INSECURE_NO_TOKEN=0`，并在 Extension popup 关闭“允许无 token 本地连接”，

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

> Extension 已连接时，所有工具自动使用 Extension 模式，仅当 Extension 不可用时才激活 CDP 模式，

## 可用工具（8 个）

### browse - 浏览器管理与导航

| Action    | 描述                    |
|-----------|-----------------------|
| `launch`  | 启动新 Chrome 实例（CDP 模式） |
| `connect` | 连接已运行的 Chrome（CDP 模式） |
| `list`    | 列出所有页面/Tab            |
| `attach`  | 附加到指定页面/Tab           |
| `open`    | 导航到 URL               |
| `back`    | 后退                    |
| `forward` | 前进                    |
| `refresh` | 刷新                    |
| `close`   | 关闭浏览器连接               |

Extension 特有：`list` 返回 flat `targets` 数组和树状 `windows`，每个 target 含 `managed`（Tab 是否由 MCP Chrome 受控）、
`isActive`（是否为当前操作目标）、
`windowId`、`index`、`pinned`、`incognito`、`status`（`loading`/`complete`），树状结构含 `windowCount`、`focusedWindowId`、
`activeTargetId` 和每个窗口按顺序排列的 `tabs`，可区分每个窗口内的 active tab 和当前人眼看到的 focused window 页面，`open`
自动创建 Tab 分组（cyan 色），`open`、`back`、`forward`、`refresh` 支持 `diagnostics=true`，返回动作期间新增的 console
warning/error 和失败网络请求摘要，也覆盖首次 `open` 自动创建页面的场景，

### input - 键鼠输入

事件序列模型，支持任意组合：

| 事件类型                                    | 描述                                                 |
|-----------------------------------------|----------------------------------------------------|
| `keydown` / `keyup`                     | 按键按下/释放                                            |
| `click`                                 | 点击（含可操作性检查：可见性、是否启用、遮挡检测、自动滚动）                     |
| `mousedown` / `mouseup`                 | 鼠标按下/释放                                            |
| `mousemove`                             | 鼠标移动                                               |
| `wheel`                                 | 滚轮滚动                                               |
| `touchstart` / `touchmove` / `touchend` | 触摸事件                                               |
| `type`                                  | 输入文本                                               |
| `wait`                                  | 事件间暂停                                              |
| `select`                                | 按内容选中文本（鼠标模拟）                                      |
| `replace`                               | 查找并替换文本                                            |
| `drag`                                  | HTML5 拖放（MAIN 世界 DragEvent，需 `target` 源 + `to` 目标） |
| `editorContext`                         | 读取当前编辑器和选区上下文                                      |
| `editorInsert`                          | 在当前编辑器选区插入文本                                       |
| `editorCommand`                         | 执行 `bold`、`insertOrderedList` 等浏览器编辑命令             |

参数：`humanize` 启用贝塞尔曲线移动和随机延迟，`diagnostics=true` 返回动作后新增 console warning/error 和失败网络请求，
`postCondition` 会在事件发送后等待页面状态，便于区分输入事件已发送和页面业务状态已完成，`postCondition.timeout` 默认 3000
ms、最大 60000 ms，`postCondition.interval` 默认 100 ms、范围 50-5000 ms，`tabId` 指定目标 Tab，`frame` 指定目标 iframe（CSS
选择器或索引），均限 Extension 模式，传入任一作用域时，动作、诊断和 post-condition 使用该目标作用域选定的同一个 backend，

**`click` 专属参数**：`force: true` 跳过可操作性检查（适用于测试隐藏元素等场景），可操作性失败返回 `ACTIONABILITY_FAILED`，包含
`rect`、`clickPoint`、遮挡元素、候选遮挡物和修复建议，
**`type` 专属参数**：`mode="controlled"` 或 `dispatch: true` 直接设置 `.value` 并触发 `input`/`change` 事件，兼容
React/Vue 等框架的受控组件（键盘事件无法触发状态更新时使用），需要非坐标型 `target`，仅限 Extension 模式，受控输入和目标查找失败时返回结构化
context，包含 `target`、`matchCount`、`nth`、`activeElement`、`selection` 和候选控件，password input 的 value 不进入失败诊断，
失败响应也会脱敏 input 事件传入的 `find` 和替换 `text`，`select` 和 `replace` 的事件级 `nth` 表示文本第 N 次出现，嵌套的
`target.nth` 表示第 N 个目标元素，两者都从 0 开始并可同时使用，CDP 模式的 locator target 不依赖 Extension refId，

**`keydown` 专属参数**：

- `commands`：触发浏览器原生编辑命令（如 `["selectAll"]`、`["copy"]`、`["paste"]`、`["cut"]`、`["undo"]`、`["redo"]`），成功表示浏览器已接受命令分发，页面结果需用
  `postCondition` 或 `extract` 验证，仅 precise 模式可用，stealth 模式下抛错（CDP commands API 没有 JS 事件等价物）
- 连续 `keydown` 同一 key 自动切换为 `rawKeyDown` + `autoRepeat`，模拟长按重复（与 Puppeteer 一致）

### extract - 内容提取

| Type         | 描述                       |
|--------------|--------------------------|
| `text`       | 提取文本内容                   |
| `html`       | 提取 HTML 源码               |
| `frameHtml`  | 提取指定 iframe 的 HTML       |
| `attribute`  | 提取元素属性                   |
| `screenshot` | 截图（支持 `target` 元素裁剪）     |
| `state`      | 获取页面状态（URL、标题、可交互元素）     |
| `metadata`   | 提取页面元信息（标题、OG、JSON-LD 等） |

参数：`output` 将结果保存到文件（`images=data` 时为输出目录），`images`（`info`/`data`）提取 HTML 中的图片元信息或数据，
`frameHtml` 在 `frame` 路由后提取当前 iframe 文档，截图支持 `clip` 坐标区域、`compareWith` PNG 基准对比和 `diffOutput`
差异图输出，截图响应包含 `metadata.format`、`width`、`height`、`dimensionSource`、`byteSize`、`fullPage`、`scale`、`clip` 和
`capabilities`，PNG 对比在解码前限制为单个 PNG 25 MiB 和 12,000,000 像素，超出时使用 `clip` 或 `scale` 缩小截图，Extension
hidden tab 截图返回 `HIDDEN_TAB_SCREENSHOT`，不会自动切前台，`state` 返回 `interactiveElements`，Extension 和 CDP 模式下
`metadata` 都返回 `frames`，如果其他 debugger 占用 precise 截图路径，可视区域 fallback 会返回 `degraded`、`fallback` 和
`limitations`；fallback 不支持的参数返回结构化 `SCREENSHOT_FALLBACK_UNSUPPORTED`，`tabId` 指定目标 Tab，`frame` 指定目标
iframe，均限 Extension 模式，

**`attribute` 特殊前缀**：`computed:<属性名>` 返回 computed CSS 样式值（如 `computed:color`、`computed:font-size`），
`computed:*` 返回全部计算样式（300+ 属性，建议配合 `output` 写文件），

**`state` 专属参数**：`depth` 控制 DOM 遍历深度（默认 15），减小可降低大页面的返回数据量，
`mode` 选择数据源 — `accessibility`（默认，从无障碍树派生）或 `domsnapshot`（CDP `DOMSnapshot.captureSnapshot`，仅 CDP 模式，返回带
computed style 的扁平节点数组，便于二次处理），

### wait - 等待条件

| For          | 描述                                     |
|--------------|----------------------------------------|
| `element`    | 等待元素（visible/hidden/attached/detached） |
| `navigation` | 等待导航完成                                 |
| `time`       | 固定延迟                                   |
| `idle`       | 等待页面加载完成 + DOM mutation 静默期            |

参数：`tabId` 指定目标 Tab，`frame` 指定目标 iframe，均限 Extension 模式，

**`idle` 说明**：`readyState === 'complete'` 后注入 `MutationObserver`，等待 `ms` 毫秒内无 DOM 变更（默认 500ms），返回
`domStable: true` 表示 DOM 已稳定，`domStable: false` 表示预算用完时 DOM 仍在变化，

### evaluate - JavaScript 执行

在页面上下文执行 JavaScript，

| 参数              | 描述                                                          |
|-----------------|-------------------------------------------------------------|
| `script`        | JavaScript 代码，裸 `return` 语句自动包裹 IIFE                        |
| `scriptFile`    | 从本地文件读取脚本（与 `script` 二选一，相对路径默认走受控临时目录，仓库内文件请显式写 `cwd:`）    |
| `args`          | 传递给脚本的参数（script 须为函数表达式）                                    |
| `mode`          | `precise`（默认，debugger API）或 `stealth`（JS 注入）                |
| `staleContextRetry` | iframe stale context 策略，`never`（默认）或 `readOnly`             |
| `output`        | 将结果保存到文件（相对路径默认走受控临时目录，写入仓库请显式写 `cwd:`，字符串写原始文本，其他类型写 JSON） |
| `tabId`         | 指定目标 Tab（Extension 模式）                                      |
| `frame`         | 指定目标 iframe（CSS 选择器或索引，Extension 模式）                        |
| `timeout`       | 端到端超时预算（毫秒）                                                 |
| `diagnostics`   | 执行后返回新增 console warning/error 和失败网络请求摘要                     |
| `postCondition` | 执行后等待文本、selector、URL 片段或脚本结果匹配                              |

`script` 和 `scriptFile` 至少提供一个，互斥使用，相对 `scriptFile` 和 `output` 路径默认写到 `mcp-chrome`
管理的系统临时目录，需要把文件留在当前工作目录时，用 `cwd:relative/path` 显式指定，相对路径会拒绝 `..`，Windows 下也会拒绝
`:`，避免落到 NTFS alternate data stream，

结果超过 100KB 时自动写入文件到受控的系统临时目录，返回文件路径和大小，返回 DOM 节点、`NodeList` 或 `HTMLCollection` 时返回
`NON_SERIALIZABLE_EVALUATE_RESULT`，并提示改为返回 `textContent`、`outerHTML` 等简单字段，结果展开或序列化失败时返回
`actionExecuted=true`、`actionStatus="completed"` 和 `failureStage="output"`，因为页面脚本已经完成，evaluate 即使在全局
`inputMode=stealth` 时也默认使用 `precise`，其 `postCondition` 检查与主动作使用相同 evaluate mode，`postCondition` 不传时，
`success=true` 只表示脚本完成执行并返回；传入后如果超时仍不匹配，返回 `POST_CONDITION_FAILED` 和最后一次检查结果，iframe
precise 执行默认不在 execution context 失效后重放脚本，只有脚本无副作用时才应传 `staleContextRetry="readOnly"`，Extension
会在剩余 timeout 内重新解析 context，并最多重放一次，`Runtime.evaluate` 发出后发生 stale context 时返回 `actionExecuted=true`、`actionStatus="unknown"`，因为脚本可能已经产生部分副作用，但无法取得最终结果，

### manage - 页面与环境管理

| Action         | 描述                                   |
|----------------|--------------------------------------|
| `newPage`      | 新建受控页面/Tab                           |
| `closePage`    | 关闭受控页面并返回 `affected.before/after`    |
| `adoptPage`    | 将已有 Tab 标记为受控页，不切前台                  |
| `releasePage`  | 将受控页移出管理，不关闭页面                       |
| `movePage`     | 将受控 Tab 移到指定窗口或 index                |
| `reorderPage`  | 调整受控 Tab 在当前窗口内的顺序                   |
| `pinPage`      | 固定受控 Tab                             |
| `unpinPage`    | 取消固定受控 Tab                           |
| `activatePage` | 激活受控 Tab 并聚焦所在窗口                     |
| `focusWindow`  | 聚焦显式指定的窗口                            |
| `resizeWindow` | 调整显式指定窗口的尺寸或状态                       |
| `newWindow`    | 新建受控窗口                               |
| `closeWindow`  | 仅当窗口内全是 managed tab 时关闭窗口            |
| `clearCache`   | 清除缓存/存储（清除 Cookie 请用 `cookies` 工具）   |
| `viewport`     | 设置视口大小                               |
| `userAgent`    | 设置 User-Agent                        |
| `emulate`      | 设备模拟（iPhone、iPad 等）                  |
| `inputMode`    | 查询或设置输入模式（`precise` / `stealth`）     |
| `stealth`      | 注入反检测脚本                              |
| `cdp`          | 发送原始 CDP 命令（高级，如 `Runtime.evaluate`） |

Tab/window 管理动作仅支持 Extension 模式，改变浏览器可见状态的动作必须显式传 `targetId` 或 `windowId`，并返回
`affected.before/after`，`focusWindow` 只有在观测到目标窗口已聚焦后才返回成功，否则返回
`WINDOW_FOCUS_NOT_OBSERVED`，`closeWindow` 遇到混有非托管 tab 的窗口会返回 `WINDOW_HAS_UNMANAGED_TABS`

**Stealth 模式档位**（CDP launch 参数，通过 `browse action=launch stealth=...` 设置）：

- `off` — 关闭反检测（纯净模式，适合测试/CI）
- `safe`（默认）— 最小改动（移除 `navigator.webdriver`、清理 CDP 痕迹）
- `aggressive` — 增加少量 WebGL/插件/语言等指纹修补（不等于完整伪装）

### logs - 浏览器日志

| Type      | 描述                |
|-----------|-------------------|
| `console` | 控制台日志（支持级别过滤）     |
| `network` | 网络请求日志（支持 URL 过滤） |

参数：`output` 将结果保存到文件，console 日志统一返回公开级别 `error`、`warning`、`info`、`debug`，浏览器原始的 `warn`、
`log` 等级会在过滤和返回前转换，network 日志包含已完成请求、HTTP 4xx/5xx 响应和加载失败请求，尽量返回 `errorText`、`method`、
`url`、`status`、`timestamp`、`duration`，URL query 中常见的认证、签名、密码和 token 参数会在内联响应、diagnostics 和
显式 `output` 文件中替换为 `[REDACTED]`，并返回 `urlRedacted`、`urlOriginalLength` 和 `redactedQueryParameters`，内联
network 结果会把脱敏后的单条 URL 限制为 2048 字符，截断时返回 `urlLength` 和 `urlTruncated: true`，`urlPattern` 支持
`*` 匹配任意长度字符、`?` 匹配单个字符，`tabId` 指定目标 Tab（Extension 模式），`frame` 不适用于日志，

### cookies - Cookie 管理

| Action   | 描述                                            |
|----------|-----------------------------------------------|
| `get`    | 获取 Cookie                                     |
| `set`    | 设置 Cookie                                     |
| `delete` | 删除 Cookie                                     |
| `clear`  | 按过滤参数删除 Cookie（`name`/`domain`/`url`，必须 ≥1 个） |

**说明**：`clear` 必须指定 `name`、`domain`、`url` 中至少一个过滤参数，否则拒绝调用以避免误清用户登录态

## Target：统一元素定位器

所有工具使用统一的 `Target` 类型定位元素：

```typescript
// 按可访问性（推荐 - 最稳定）
{ role: "button", name: "提交" }

// 按可访问性精确匹配名称
{ role: "button", name: "提交", exact: true }

// 按文本内容
{ text: "点击这里", exact: true }

// 按表单 label
{
    label: "邮箱"
}

// 按 placeholder
{
    placeholder: "请输入姓名"
}

// 按 title 属性
{
    title: "关闭对话框"
}

// 按 alt 文本（图片）
{
    alt: "头像"
}

// 按 test ID
{
    testId: "submit-button"
}

// 按 CSS 选择器
{
    css: "#login-form .submit-btn"
}

// 多匹配消歧（从 0 开始）
{ css: ".ant-select-input", nth: 1 }

// 按 CSS + 文本（按文本内容过滤）
{ css: "button", text: "提交", exact: true }

// 按 XPath
{
    xpath: "//button[@type='submit']"
}

// 按坐标
{ x: 100, y: 200 }
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
// 生成：<系统临时目录>/claude-tools/mcp-chrome/page/content.html, images/*, index.json

// 获取 HTML + 图片数据（内联返回，最多 20 张）
extract(type="html", target={ css: ".card" }, images="data")
```

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

CSS 选择器和数字索引按父文档的 DOM iframe 顺序定位，DOM 中不存在的子 frame（包括其他 Extension 加入的 frame）不会改变索引，也不会成为候选目标，所选元素无法对应到唯一 Chrome frame 时返回 `FRAME_IDENTITY_UNAVAILABLE`，不会选择其他 frame

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
  `127.0.0.1:19222-19299` 的环境中，应使用 `MCP_CHROME_PAIRING_TOKEN`，或设置 `MCP_CHROME_ALLOW_INSECURE_NO_TOKEN=0`，WebSocket 握手要求 `chrome-extension://`
  Origin 头，可挡掉浏览器页面和 curl，但拦不住同 UID 的本地恶意进程
- Extension 模式：共享浏览器会话，请仅在受信任的机器上使用
- CDP 模式：通过 DevTools Protocol 提供完整浏览器控制能力
- 默认端口仅绑定到 127.0.0.1（本地访问）
- `evaluate` 工具可执行任意 JavaScript
- `manage cdp` 操作可发送任意 CDP 命令
- 网络 URL 中的常见认证参数默认会脱敏，但 console 文本和非标准参数名仍可能包含敏感信息

### 反检测（stealth）—— 实际能力

`stealth` 模式（`safe` / `aggressive`）仅覆盖少量指纹面：

- **覆盖**：`navigator.webdriver`、`cdc_*` 属性、User-Agent 字符串、若干 WebGL vendor/renderer 值、Chrome runtime 属性
- **不覆盖**：Canvas 指纹、AudioContext 指纹、Font 枚举、TLS 层指纹（JA3/JA4）、CDP attach 横幅（"Chrome 正受自动化软件控制"
  ）、扩展自身存在的探测
- **警告**：禁止使用本功能绕过商业 anti-bot 服务（Cloudflare Turnstile、Akamai、DataDome、PerimeterX），真实的 bot
  检测发生在多个我们无法在页面内部修补的层级

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

input 和 evaluate 返回值追加 `actionExecuted`、`actionStatus`、`verificationStatus`、`failureStage` 和 `retryable`。验证状态分为 `matched`、`not_matched`、`unavailable`、`error`；debugger 超时且无法证明脚本已停止时，动作状态为 `unknown`。页面脚本抛异常时返回 `actionExecuted=true` 和 `actionStatus="failed"`；结果展开或序列化失败时返回 `actionStatus="completed"` 和 `failureStage="output"`。diagnostics 是附加能力，失败时返回 `diagnosticsStatus`，不会覆盖主动作结果。browse 和 wait 的主动作失败时，也会保留失败前已收集的 diagnostics。目标诊断会读取当前 tab 的实时状态，不依赖 attach 时缓存的 URL 和标题。

`replace` 仅对 `textarea` 以及 `text`、`search`、`tel`、`url`、`password` 类型的 input 使用文本选区。其他 input 类型通过原生完整 value 更新，并返回请求值与浏览器规范化后的实际值。对不支持选区的类型单独执行 `select` 会返回 `UNSUPPORTED_SELECTION`。CDP 模式下，`select` 和 `replace` 的 locator target 通过 CDP locator 聚焦，不调用 Extension refId。password value 不进入 input 失败 context 和 text post-condition 观测值，失败响应还会脱敏传入的 `find` 和替换 `text`。目标超时返回限量的 locator、tab、frame、匹配数和候选上下文。显式 `tabId` 或 `frame` 作用域会在 input、wait、logs、extract 开始前确定活动 backend，动作和验证使用同一个目标 backend。precise iframe evaluate 默认使用 `staleContextRetry="never"`，context 失效时不重放脚本；`readOnly` 允许 Extension 校验 frame identity 并解析新 execution context 后重放一次。响应包含策略、`retryAttempted`、限量的 `retryReason`，以及最终 Extension frame、parent frame、URL、CDP frame 和 execution context ID 组成的 `frameContext`，重复 URL 导致 frame 不唯一时拒绝选择任一 frame。端口扫描会把普通的 WebSocket open 前失败聚合为 debug；已识别 MCP server 的认证或协议拒绝只在摘要变化时输出一条限量 warning。
