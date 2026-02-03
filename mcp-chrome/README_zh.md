# MCP-Chrome

[English](README.md) | 中文

基于 Chrome DevTools Protocol (CDP) 的浏览器自动化 MCP Server。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io/)

## 功能特性

- **原生 CDP**：直接通过 Chrome DevTools Protocol 通信，无 Puppeteer/Playwright 依赖
- **8 个统一工具**：从 30+ 细粒度工具精简为 8 个基于 action 的工具
- **语义化定位**：10 种元素定位方式（role、text、label、css、xpath、坐标等）
- **自动等待**：内置可点击性、可输入性检测
- **结构化错误**：每个错误包含 code、message、suggestion、context
- **反检测**：可选的指纹伪装和行为模拟

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
git clone https://github.com/Pyrokine/claude-mcp-tools.git
cd claude-mcp-tools/mcp-chrome
npm install
npm run build
```

## 快速开始

### 1. 启动带远程调试的 Chrome

```bash
# 有界面
./scripts/start-chrome.sh

# 无头模式
./scripts/start-chrome-headless.sh

# 或手动启动：
google-chrome --remote-debugging-port=9222
```

### 2. 配置 MCP 客户端

#### Claude Code

```bash
claude mcp add chrome -- node /path/to/mcp-chrome/dist/index.js
```

#### Claude Desktop / 其他客户端

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

## 可用工具（8 个）

### browse - 浏览器管理与导航

| Action    | 描述                                        |
|-----------|-------------------------------------------|
| `launch`  | 启动新 Chrome 实例                             |
| `connect` | 连接已运行的 Chrome（需要 --remote-debugging-port） |
| `list`    | 列出所有可用页面/目标                               |
| `attach`  | 附加到指定页面                                   |
| `open`    | 导航到 URL                                   |
| `back`    | 后退                                        |
| `forward` | 前进                                        |
| `refresh` | 刷新                                        |
| `close`   | 关闭浏览器                                     |

**反检测模式**（用于 `launch`/`connect`）：

| 模式           | 描述                                   |
|--------------|--------------------------------------|
| `off`        | 关闭 - 纯净模式，适合测试/CI                    |
| `safe`       | 最小改动（默认） - 移除 webdriver 标识、清理 CDP 痕迹 |
| `aggressive` | 完整伪装 - 插件、WebGL、语言等（可能有副作用）          |

### input - 键鼠输入

事件序列模型，支持任意组合：

| 事件类型                                    | 描述      |
|-----------------------------------------|---------|
| `keydown` / `keyup`                     | 按键按下/释放 |
| `mousedown` / `mouseup`                 | 鼠标按下/释放 |
| `mousemove`                             | 鼠标移动    |
| `wheel`                                 | 滚轮滚动    |
| `touchstart` / `touchmove` / `touchend` | 触摸事件    |
| `type`                                  | 输入文本    |
| `wait`                                  | 事件间暂停   |

### extract - 内容提取

| Type         | 描述                   |
|--------------|----------------------|
| `text`       | 提取文本内容               |
| `html`       | 提取 HTML 源码           |
| `attribute`  | 提取元素属性               |
| `screenshot` | 截图                   |
| `state`      | 获取页面状态（URL、标题、可交互元素） |

### wait - 等待条件

| For          | 描述                                     |
|--------------|----------------------------------------|
| `element`    | 等待元素（visible/hidden/attached/detached） |
| `navigation` | 等待导航完成                                 |
| `time`       | 固定延迟                                   |
| `idle`       | 等待网络空闲                                 |

### manage - 页面与环境管理

| Action       | 描述                  |
|--------------|---------------------|
| `newPage`    | 新建页面/标签页            |
| `closePage`  | 关闭页面                |
| `clearCache` | 清除缓存/cookies/存储     |
| `viewport`   | 设置视口大小              |
| `userAgent`  | 设置 User-Agent       |
| `emulate`    | 设备模拟（iPhone、iPad 等） |

### logs - 浏览器日志

| Type      | 描述                |
|-----------|-------------------|
| `console` | 控制台日志（支持级别过滤）     |
| `network` | 网络请求日志（支持 URL 过滤） |

### cookies - Cookie 管理

| Action   | 描述           |
|----------|--------------|
| `get`    | 获取 cookies   |
| `set`    | 设置 cookie    |
| `delete` | 删除 cookie    |
| `clear`  | 清空所有 cookies |

### evaluate - JavaScript 执行

在页面上下文执行任意 JavaScript。

## Target：统一元素定位器

所有工具使用统一的 `Target` 类型定位元素：

```typescript
// 按可访问性（推荐 - 最稳定）
{ role: "button", name: "提交" }

// 按文本内容
{ text: "点击这里", exact: true }

// 按表单 label
{ label: "邮箱" }

// 按 placeholder
{ placeholder: "请输入姓名" }

// 按 title 属性
{ title: "关闭对话框" }

// 按 alt 文本（图片）
{ alt: "头像" }

// 按 test ID
{ testId: "submit-button" }

// 按 CSS 选择器
{ css: "#login-form .submit-btn" }

// 按 XPath
{ xpath: "//button[@type='submit']" }

// 按坐标
{ x: 100, y: 200 }
```

## 使用示例

### 基础：连接和导航

```
browse(action="connect", port=9222)
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

### 复杂：Ctrl+点击 + 人类行为模拟

```
input(events=[
  { type: "keydown", key: "Control" },
  { type: "mousedown", target: { css: ".item" }, button: "left" },
  { type: "mouseup" },
  { type: "keyup", key: "Control" }
], humanize=true)
```

### 截图

```
// 全页面
extract(type="screenshot", fullPage=true)

// 指定元素
extract(type="screenshot", target={ css: "#chart" })
```

### 等待元素

```
wait(for="element", target={ text: "加载完成" }, state="visible")
```

## 架构

```
┌─────────────────┐
│   MCP 客户端     │
│ (Claude 等)     │
└────────┬────────┘
         │ stdio (JSON-RPC)
         ▼
┌─────────────────┐
│   MCP-Chrome    │
│   (8 个工具)    │
│  ├─ core/       │  Session, Locator, AutoWait
│  ├─ cdp/        │  原生 CDP 客户端
│  └─ tools/      │  工具实现
└────────┬────────┘
         │ WebSocket (CDP)
         ▼
┌─────────────────┐
│  Chrome 浏览器   │
│  (端口 9222)    │
└─────────────────┘
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
│   │   ├── session.ts        # 会话管理
│   │   ├── locator.ts        # 元素定位器
│   │   ├── auto-wait.ts      # 自动等待机制
│   │   ├── retry.ts          # 重试逻辑
│   │   ├── types.ts          # 类型定义
│   │   └── errors.ts         # 错误类型
│   ├── cdp/                  # CDP 层
│   │   ├── client.ts         # WebSocket CDP 客户端
│   │   └── launcher.ts       # Chrome 启动器
│   └── anti-detection/       # 反检测（可选）
│       ├── injection.ts
│       └── behavior.ts
├── scripts/
│   ├── start-chrome.sh
│   └── start-chrome-headless.sh
└── package.json
```

## 安全说明

- CDP 提供完整的浏览器控制能力，请仅在受信任的机器上使用
- 默认调试端口仅绑定到 127.0.0.1
- `evaluate` 工具可执行任意 JavaScript
- 网络日志可能包含敏感信息

## 已知限制

- **单会话**：当前仅支持一个浏览器会话
- **仅 Chrome**：仅支持 Chrome/Chromium 浏览器（不支持 Firefox/Safari）

## 许可证

MIT 许可证 - 详见 [LICENSE](LICENSE)。

## 相关项目

- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP 规范
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) - CDP 文档
