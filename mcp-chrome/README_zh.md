# MCP-Chrome

[English](README.md) | 中文

Chrome 浏览器自动化 MCP Server，双模式架构：**Extension 模式**（推荐）操控现有浏览器，**CDP 模式**（回退）启动独立实例

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io/)

## 功能特性

- **双模式**：Extension 模式共享登录状态；CDP 模式用于无头/隔离场景
- **8 个统一工具**：基于 action 的设计，覆盖浏览、输入、提取、等待、执行、管理、Cookie、日志
- **多 Tab 并行**：`tabId` 参数支持对任意 Tab 操作，无需切换焦点
- **iframe 穿透**：`frame` 参数支持操作 iframe 内元素（CSS 选择器或索引，Extension 模式）
- **语义化定位**：11 种元素定位方式（role、text、label、css、css+文本组合、xpath、坐标等）
- **自动等待**：内置可点击性、可输入性检测，基于 deadline 的超时预算机制
- **双输入模式**：`precise`（debugger API，可绕过 CSP）或 `stealth`（JS 注入，无调试横幅）
- **智能输出**：裸 `return` 语句自动 IIFE 包裹；大结果（>100KB）自动落盘；`output` 对字符串写入原始文本
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

```bash
npm install -g @pyrokine/mcp-chrome
```

或从源码安装：

```bash
git clone https://github.com/Pyrokine/claude-tools.git
cd claude-tools/mcp-chrome
npm install
npm run build
```

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
# Claude Code
claude mcp add chrome -- node /path/to/mcp-chrome/dist/index.js
```

```json
// Claude Desktop / 其他客户端
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

Extension 通过 HTTP/WebSocket 自动连接 MCP Server（端口 19222-19299），点击工具栏图标可查看连接状态，

```
browse(action="list")          // 列出所有 Tab
browse(action="open", url="https://example.com")
extract(type="screenshot")
```

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

Extension 特有：`list` 返回额外字段：`managed`（Tab 是否在 MCP Chrome 分组中）、`isActive`（是否为当前操作目标）、
`windowId`、`index`、`pinned`、`incognito`、`status`（`loading`/`complete`），`open` 自动创建 Tab 分组（cyan 色），

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

参数：`humanize` 启用贝塞尔曲线移动和随机延迟，`tabId` 指定目标 Tab，`frame` 指定目标 iframe（CSS 选择器或索引），均限
Extension 模式，

**`click` 专属参数**：`force: true` 跳过可操作性检查（适用于测试隐藏元素等场景），
**`type` 专属参数**：`dispatch: true` 直接设置 `.value` 并触发 `input`/`change` 事件，兼容 React/Vue
等框架的受控组件（键盘事件无法触发状态更新时使用），需要非坐标型 `target`，仅限 Extension 模式，

**`keydown` 专属参数**：

- `commands`：触发浏览器原生编辑命令（如 `["selectAll"]`、`["copy"]`、`["paste"]`、`["cut"]`、`["undo"]`、`["redo"]`），仅
  precise 模式可用，stealth 模式下抛错（CDP commands API 没有 JS 事件等价物）
- 连续 `keydown` 同一 key 自动切换为 `rawKeyDown` + `autoRepeat`，模拟长按重复（与 Puppeteer 一致）

### extract - 内容提取

| Type         | 描述                       |
|--------------|--------------------------|
| `text`       | 提取文本内容                   |
| `html`       | 提取 HTML 源码               |
| `attribute`  | 提取元素属性                   |
| `screenshot` | 截图（支持 `target` 元素裁剪）     |
| `state`      | 获取页面状态（URL、标题、可交互元素）     |
| `metadata`   | 提取页面元信息（标题、OG、JSON-LD 等） |

参数：`output` 将结果保存到文件（`images=data` 时为输出目录），`images`（`info`/`data`）提取 HTML 中的图片元信息或数据，`tabId`
指定目标 Tab，`frame` 指定目标 iframe，均限 Extension 模式，

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

| 参数           | 描述                                           |
|--------------|----------------------------------------------|
| `script`     | JavaScript 代码，裸 `return` 语句自动包裹 IIFE         |
| `scriptFile` | 从本地文件读取脚本（与 `script` 二选一，相对路径默认走受控临时目录，仓库内文件请显式写 `cwd:`） |
| `args`       | 传递给脚本的参数（script 须为函数表达式）                     |
| `mode`       | `precise`（默认，debugger API）或 `stealth`（JS 注入） |
| `output`     | 将结果保存到文件（相对路径默认走受控临时目录，写入仓库请显式写 `cwd:`，字符串写原始文本，其他类型写 JSON） |
| `tabId`      | 指定目标 Tab（Extension 模式）                       |
| `frame`      | 指定目标 iframe（CSS 选择器或索引，Extension 模式）         |
| `timeout`    | 端到端超时预算（毫秒）                                  |

`script` 和 `scriptFile` 至少提供一个，互斥使用。相对 `scriptFile` 和 `output` 路径默认写到 `mcp-chrome` 管理的系统临时目录。需要把文件留在当前工作目录时，用 `cwd:relative/path` 显式指定。相对路径会拒绝 `..`，Windows 下也会拒绝 `:`，避免落到 NTFS alternate data stream，

结果超过 100KB 时自动落盘到受控的系统临时目录，返回文件路径和大小，

### manage - 页面与环境管理

| Action       | 描述                                   |
|--------------|--------------------------------------|
| `newPage`    | 新建页面/Tab                             |
| `closePage`  | 关闭页面                                 |
| `clearCache` | 清除缓存/存储（清除 Cookie 请用 `cookies` 工具）   |
| `viewport`   | 设置视口大小                               |
| `userAgent`  | 设置 User-Agent                        |
| `emulate`    | 设备模拟（iPhone、iPad 等）                  |
| `inputMode`  | 查询或设置输入模式（`precise` / `stealth`）     |
| `stealth`    | 注入反检测脚本                              |
| `cdp`        | 发送原始 CDP 命令（高级，如 `Runtime.evaluate`） |

**Stealth 模式档位**（CDP launch 参数，通过 `browse action=launch stealth=...` 设置）：

- `off` — 关闭反检测（纯净模式，适合测试/CI）
- `safe`（默认）— 最小改动（移除 `navigator.webdriver`、清理 CDP 痕迹）
- `aggressive` — 增加少量 WebGL/插件/语言等指纹修补（不等于完整伪装）

### logs - 浏览器日志

| Type      | 描述                |
|-----------|-------------------|
| `console` | 控制台日志（支持级别过滤）     |
| `network` | 网络请求日志（支持 URL 过滤） |

参数：`output` 将结果保存到文件，`tabId` 指定目标 Tab（Extension 模式），`frame` 不适用于日志，

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

- **信任边界**：本服务器无应用层认证，仅依赖 `127.0.0.1` 绑定 + 同 UID 信任，与 Playwright、Puppeteer、chrome-launcher
  采用同一信任模型。禁止部署在多用户系统、CI runner、`--net=host` 容器等不可信代码可访问
  `127.0.0.1:19222-19299` 的环境中。WebSocket 握手要求 `chrome-extension://` Origin 头，可挡掉浏览器页面和 curl，
  但拦不住同 UID 的本地恶意进程
- Extension 模式：共享浏览器会话，请仅在受信任的机器上使用
- CDP 模式：通过 DevTools Protocol 提供完整浏览器控制能力
- 默认端口仅绑定到 127.0.0.1（本地访问）
- `evaluate` 工具可执行任意 JavaScript
- `manage cdp` 操作可发送任意 CDP 命令
- 网络日志可能包含敏感信息

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
