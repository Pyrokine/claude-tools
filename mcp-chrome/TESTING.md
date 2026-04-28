# mcp-chrome 发版前回归清单

本清单用于在 Claude Code 会话内由 agent 按用例 ID 顺序跑一遍，**全部 PASS 才能执行 `npm publish`**

`test/run-all.js` 是独立冷启动 smoke（跑 demoqa），**定位为可选补充**——覆盖 smoke-level 的工具调用，不做行为级断言，真正回归以本清单为准

---

## 0. 跑法（agent-driven，在 CC 内）

### 0.1 前置条件

**执行总纲**：按本清单用例顺序跑，全部 PASS 才放行，跑的过程中严守"不污染用户环境"——禁止操作用户已有
tab，禁止清全局缓存/cookies，只能动测试 tab 和测试创建的 `mcp_test_*` 前缀数据，任何与此冲突的用例就地标 SKIP

- Chrome Extension 已在 `chrome://extensions/` 刷新为最新 dist，popup 显示 **已连接**
- MCP server 已加载最新 dist（src 有任何改动 → `npm run build` → 重启 CC，否则跑到的是旧进程）
- 全程使用 `manage action=newPage` 创建的测试 tab，**严禁操作用户已有 tab**
- 所有浏览操作默认 `activated=false`（后台），**严禁抢占用户前台**
- 清理只针对测试 tab 和 `mcp_test_*` 前缀的 cookie，严禁 `cookies clear` 无过滤
- **output 文件路径必须在 mcp-chrome server cwd 内**（通常是 `./test-output/` 子目录），跑前确保该目录存在：
  `mkdir -p test-output`，跑后可清空

### 0.2 测试载体

| 载体            | 位置                                                   | 作用                                   |
|---------------|------------------------------------------------------|--------------------------------------|
| **test-page** | `file:///<repo>/mcp-chrome/extension/test-page.html` | 受控页面，12 region，可注入 evaluate 监听器做行为断言 |
| **demoqa**    | `https://demoqa.com/`                                | 真实站点，验证 iframe / modal / 动态表单 / 真实拖拽 |

每个用例在字段 `载体` 里标注 `test-page` / `demoqa` / `任意` / `N/A`

### 0.3 执行流程

```
for each tool chapter:
    for each case (按 ID 顺序):
        前置步骤
        执行"操作"里的 mcp 调用
        按"断言"逐条验证
        失败 → 标记 FAIL 并记录证据；不阻断其他用例（非 fail-fast）
    输出本章 PASS / FAIL 清单
最后汇总全部 FAIL 用例 ID
```

### 0.4 清理

- 每章结束：用 `manage closePage` 关掉本章创建的测试 tab
- cookie：只删 `mcp_test_` 前缀的测试 cookie
- localStorage / storage：每次在测试 tab 里做，关 tab 即清

---

## 0.5 通过标准总则

- **成功用例** —— 返回 `success=true` + 关键字段非空 + 页面 DOM 符合断言中具体值
- **错误用例** —— 抛 Error 或响应带 `error`，错误消息 **必须包含用例指定的关键词子串**
- **行为断言** —— 形如 "注入监听器读取 event.buttons=2"，必须是具体位置具体值，禁止 "差不多" "能跑就行"
- **快照式断言** —— 截图/html 的用例可接受 "文件生成 + 大小 > 0 + 格式正确"，不做像素 diff

---

## 0.6 用例 ID 规则

```
{tool}-{action|type}-{NN}[-变体]
```

例：

- `browse-list-01`
- `input-click-03-actionable`
- `input-keydown-05-modifier-commands`
- `extract-screenshot-02-fullpage`
- `err-stealth-commands-01`

FAIL 时只需报 ID + 失败断言即可

---

## 章节

1. [browse](#1-browse) — 9 actions
2. [cookies](#2-cookies) — 4 actions
3. [evaluate](#3-evaluate) — 2 modes + 参数矩阵
4. [extract](#4-extract) — 6 types
5. [input](#5-input) — 14 event types
6. [logs](#6-logs) — 2 types
7. [manage](#7-manage) — 9 actions
8. [wait](#8-wait) — 4 types
9. [错误分支 / 边界](#9-错误分支--边界)
10. [test-page region 索引](#10-test-page-region-索引)

---

## 1. browse

### browse-launch-01

- 前置：无（假设已由用户 launch；CC 内通常用 connect，不实际触发 launch）
- 操作：跳过（launch 一般由用户手动，CC 不主动 launch 以免开新窗口）
- 断言：N/A
- 载体：N/A
- 备注：CC 场景下 launch 不在 agent 回归范围，可选手工跑 `browse launch` 并检查返回 `success=true`

### browse-connect-01

- 前置：Chrome 已开启且有 debug 端口
- 操作：`browse { action: "connect" }`（不带 port 参数自动探测；带 port=9222 精确）
- 断言：`success=true`，响应 `mode` 字段为 `cdp` 或 `extension`
- 载体：N/A
- 备注：CC 常态由 Extension 模式接管，`connect` 是 CDP 模式入口

### browse-list-01

- 前置：已连接
- 操作：`browse { action: "list" }`
- 断言：
    - `success=true`
    - `targets` 是非空数组
    - 每个元素包含 `targetId / type / url / title / mode / managed / isActive / windowId / index`
- 载体：N/A

### browse-attach-01-background

- 前置：已 list 得到目标 targetId
- 操作：`browse { action: "attach", targetId: <id>, activate: false }`
- 断言：`success=true`，`activated=false`，后续工具 `manage newPage` 仍可工作
- 载体：任意

### browse-attach-02-activate

- 状态：**SKIP**（与 MEMORY 全局 "禁止 activate=true" 规则冲突，测试流程不走 activate）
- 前置：agent 自己先 newPage 创建一个 test tab（不要用用户 tab）
- 操作：`browse { action: "attach", targetId: <testTabId>, activate: true }`
- 断言：`success=true`，`activated=true`，该 test tab 被带到前台
- 载体：test-page
- 清理：关闭 test tab

### browse-open-01

- 前置：当前 attach 到某 test tab
- 操作：`browse { action: "open", url: "about:blank", wait: "load" }`
- 断言：`success=true`，`url` 字段为 `about:blank`
- 载体：N/A

### browse-open-02-wait-networkidle

- 前置：attach 到 test tab
- 操作：`browse { action: "open", url: "https://example.com", wait: "networkidle" }`
- 断言：`success=true`，返回耗时明显长于 load（真正等 idle）
- 载体：demoqa / example.com

### browse-back-01

- 前置：测试 tab open 到 example.com → 再 open 到 example.org，形成两页历史
- 操作：`browse { action: "back" }`
- 断言：`success=true`，当前 url 回到 example.com
- 载体：任意
- 备注：`chrome.tabs.goBack` 在 `chrome.tabs.update` 产生的历史栈上可能失败，实现里用 `history.back()` fallback

### browse-forward-01

- 前置：接 `browse-back-01` 之后
- 操作：`browse { action: "forward" }`
- 断言：`success=true`，url 回到 example.org
- 载体：任意

### browse-refresh-01

- 前置：attach 到 test-page，先 evaluate 注入 `window.__marker = Date.now()`
- 操作：`browse { action: "refresh", wait: "load" }`
- 断言：`success=true`，refresh 后 `window.__marker` 不再存在（刷新成功）
- 载体：test-page

### browse-refresh-02-ignore-cache

- 前置：同上
- 操作：`browse { action: "refresh", ignoreCache: true }`
- 断言：`success=true`
- 载体：test-page

### browse-close-01

- 前置：agent 自己 newPage 创建 test tab T
- 操作：`browse { action: "close" }`（extension 模式下等价于 `manage closePage targetId=T`）
- 断言：`success=true`，再 `browse list` 找不到该 targetId
- 载体：test-page
- 备注：extension 模式下 `browse close` 实际关的是当前 attach 的 tab，CDP 模式下关闭浏览器会话

### browse-list-02-mode-field

- 前置：Extension 模式已接管
- 操作：`browse { action: "list" }`
- 断言：至少一个 target 的 `mode === "extension"`；确认不是 CDP-only
- 载体：N/A

---

## 2. cookies

### cookies-get-01

- 前置：attach 到 demoqa.com
- 操作：`cookies { action: "get" }`（不带过滤）
- 断言：`success=true`，返回数组（可能为空）
- 载体：demoqa
- 备注：无过滤会返回浏览器全部 cookie（可能数百条超出 token 限制），跑前可先只看 count 或 output 到文件

### cookies-get-02-domain-filter

- 前置：attach 到 demoqa.com
- 操作：`cookies { action: "get", domain: "demoqa.com" }`
- 断言：每个 cookie 的 domain 字段以 `demoqa.com` 结尾或相等
- 载体：demoqa

### cookies-get-03-url-filter

- 前置：attach 任一 tab
- 操作：`cookies { action: "get", url: "https://demoqa.com/" }`
- 断言：返回 cookies 与 `demoqa.com` 匹配
- 载体：任意

### cookies-get-04-secure-only

- 操作：`cookies { action: "get", secure: true }`
- 断言：每个返回的 cookie 的 `secure=true`
- 载体：任意

### cookies-get-05-output-json

- 操作：`cookies { action: "get", domain: "demoqa.com", output: "./test-output/mcp-test-cookies.json" }`
- 断言：
    - `success=true`
    - `./test-output/mcp-test-cookies.json` 存在且为合法 JSON
- 载体：demoqa
- 清理：`rm ./test-output/mcp-test-cookies.json`

### cookies-set-01

- 前置：attach 到 test-page（file://）
- 操作：`cookies { action: "set", name: "mcp_test_a", value: "1", url: "https://demoqa.com/" }`
- 断言：`success=true`，随后 `cookies get name=mcp_test_a url=https://demoqa.com/` 能读到 value=1
- 载体：demoqa（file:// 无法写 cookie，url 字段必填 https 地址）
- 清理：`cookies delete name=mcp_test_a url=https://demoqa.com/`

### cookies-set-02-with-attrs

- 操作：
  `cookies { action: "set", name: "mcp_test_b", value: "2", url: "https://demoqa.com/", secure: true, httpOnly: true, sameSite: "Lax", expirationDate: <now+3600> }`
- 断言：读回后所有属性一致
- 清理：`cookies delete name=mcp_test_b url=https://demoqa.com/`

### cookies-delete-01

- 前置：先 set mcp_test_c
- 操作：`cookies { action: "delete", name: "mcp_test_c", url: "https://demoqa.com/" }`
- 断言：`success=true`，再 get 找不到
- 载体：demoqa

### cookies-clear-01-domain

- 状态：**SKIP**（与 MEMORY "只删 mcp_test_* 前缀" 冲突，clear 无 name 过滤，domain=demoqa.com 会清包括用户跟踪/登录 cookie）
- 前置：先 set mcp_test_d 到 demoqa.com
- 操作：`cookies { action: "clear", domain: "demoqa.com" }`
- 断言：`success=true`，之后 `cookies get domain=demoqa.com` 不含 mcp_test_d
- 载体：demoqa
- 注意：**不得运行无参数的 clear**，会清所有 cookie；手工跑时用独立 Chrome profile
- 替代验证：用 `cookies delete name=mcp_test_d url=https://demoqa.com/` 清理测试 cookie

---

## 3. evaluate

### evaluate-precise-01-expression

- 前置：attach 到 test-page
- 操作：`evaluate { script: "1+1" }`
- 断言：`success=true`，`result === 2`
- 载体：test-page

### evaluate-precise-02-iife

- 操作：`evaluate { script: "(function(){return document.title})()" }`
- 断言：`result === "MCP Chrome 测试页面"`
- 载体：test-page

### evaluate-precise-03-dom-read

- 操作：`evaluate { script: "document.getElementById('btn-id').textContent" }`
- 断言：`result === "ID 定位按钮"`
- 载体：test-page

### evaluate-precise-04-args

- 操作：`evaluate { script: "(a,b) => a+b", args: [3, 4] }`
- 断言：`result === 7`
- 载体：任意

### evaluate-precise-05-async

- 操作：`evaluate { script: "(async () => { await new Promise(r=>setTimeout(r,50)); return 'done' })()" }`
- 断言：`result === "done"`
- 载体：任意

### evaluate-precise-06-frame-selector

- 前置：attach 到 test-page（region 10 有 iframe#test-frame）
- 操作：`evaluate { script: "document.getElementById('frame-btn').textContent", frame: "iframe#test-frame" }`
- 断言：`result === "Frame Button"`
- 载体：test-page

### evaluate-precise-07-frame-index

- 操作：`evaluate { script: "document.body.textContent", frame: 0 }`
- 断言：与 frame:"iframe#test-frame" 返回结果一致
- 载体：test-page

### evaluate-precise-08-scriptFile

- 前置：`echo "42" > ./test-output/mcp-eval.js`
- 操作：`evaluate { scriptFile: "./test-output/mcp-eval.js" }`
- 断言：`result === 42`
- 载体：任意
- 清理：`rm ./test-output/mcp-eval.js`

### evaluate-precise-09-output

- 操作：`evaluate { script: "'hello world'", output: "./test-output/mcp-eval-out.txt" }`
- 断言：文件存在，内容为 `hello world`（不带引号）
- 载体：任意
- 清理：`rm ./test-output/mcp-eval-out.txt`

### evaluate-stealth-01

- 前置：`manage inputMode stealth`（注：evaluate 的 mode 与 inputMode 无关，这里仅验证 evaluate 自身的 stealth 模式）
- 操作：`evaluate { script: "1+1", mode: "stealth" }`
- 断言：`result === 2`
- 载体：任意

### evaluate-stealth-02-csp-limit

- 状态：**可选**（需要用户已有带严格 CSP 的 tab；MEMORY 禁止 agent 抢用户 tab，无法自建严格 CSP 的测试环境，Phase 1 环境下
  SKIP）
- 前置：attach 到带严格 CSP 的页面（如 github.com）
- 操作：`evaluate { script: "1+1", mode: "stealth" }`
- 断言：允许两种结果：① `success=true`（CSP 允许）② 错误消息包含 "CSP" 或 "blocked"
- 载体：github.com 或任何带严格 CSP 的站点

### evaluate-tabId-01

- 前置：attach 到 T1（test-page），tabId=T1 已知
- 操作：`evaluate { script: "document.title", tabId: "<T1>" }`
- 断言：`result === "MCP Chrome 测试页面"`
- 载体：test-page
- 备注：双 tab 对比可选（需自建第二个 managed test tab，Phase 1 环境可 SKIP）

---

## 4. extract

### extract-text-01-whole-page

- 前置：attach 到 test-page
- 操作：`extract { type: "text" }`
- 断言：
    - `success=true`
    - `result` 字符串包含 "MCP Chrome 测试页面"、"ID 定位按钮"、"拖拽我"
- 载体：test-page

### extract-text-02-css

- 操作：`extract { type: "text", target: { css: "#btn-id" } }`
- 断言：`result === "ID 定位按钮"`
- 载体：test-page

### extract-text-03-role

- 操作：`extract { type: "text", target: { role: "button", name: "TestId 定位按钮" } }`
- 断言：`result === "TestId 定位按钮"`
- 载体：test-page

### extract-text-04-text

- 操作：`extract { type: "text", target: { text: "文本链接测试" } }`
- 断言：`result` 包含 "文本链接测试"
- 载体：test-page

### extract-text-05-label

- 操作：`extract { type: "text", target: { label: "placeholder 输入框" } }`
- 断言：定位到 #input-placeholder 输入框（value 可能为空，但不报错）
- 载体：test-page

### extract-text-06-placeholder

- 操作：`extract { type: "text", target: { placeholder: "在这里输入" } }`
- 断言：定位到 #text-input，成功返回（可能空字符串）
- 载体：test-page

### extract-text-07-title

- 操作：`extract { type: "text", target: { title: "title 输入框" } }`
- 断言：定位到 #input-title
- 载体：test-page

### extract-text-08-alt

- 操作：`extract { type: "text", target: { alt: "测试图片" } }`
- 断言：定位到 #test-image（img 的 text 可为空）
- 载体：test-page

### extract-text-09-testid

- 操作：`extract { type: "text", target: { testId: "test-button" } }`
- 断言：`result === "TestId 定位按钮"`
- 载体：test-page

### extract-text-10-xpath

- 操作：`extract { type: "text", target: { xpath: "//button[@id='btn-id']" } }`
- 断言：`result === "ID 定位按钮"`
- 载体：test-page

### extract-text-11-nth

- 前置：test-page 有多个 `<button>`
- 操作：`extract { type: "text", target: { css: "button", nth: 1 } }`
- 断言：定位到**全文档第 2 个** button（nth 是 `document.querySelectorAll(css)` 的索引，不是 section 内的索引）
- 载体：test-page

### extract-text-12-css-text-combo

- 操作：`extract { type: "text", target: { css: "button", text: "单击测试" } }`
- 断言：`result === "单击测试"`
- 载体：test-page

### extract-text-13-coords

- 前置：用 `evaluate` 获取 #btn-id 的中心坐标：
  `(() => { const r = document.getElementById('btn-id').getBoundingClientRect(); return {x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)} })()`
- 操作：`extract { type: "text", target: { x: <X>, y: <Y> } }`
- 断言：`result === "ID 定位按钮"`
- 载体：test-page

### extract-html-01-whole

- 操作：`extract { type: "html" }`
- 断言：`result` 含 `<html`、`<body`、`id="btn-id"`
- 载体：test-page

### extract-html-02-element

- 操作：`extract { type: "html", target: { css: "#btn-id" } }`
- 断言：`result` 以 `<button` 开头，含 `id="btn-id"`
- 载体：test-page

### extract-html-03-images-info

- 前置：test-page region 8 有 #test-image
- 操作：`extract { type: "html", target: { css: "body" }, images: "info" }`
- 断言：返回的 `images` 数组含 `#test-image` 的 src/alt/尺寸，**不含 base64 data**
- 载体：test-page

### extract-html-04-images-data

- 操作：`extract { type: "html", target: { css: "body" }, images: "data", output: "./test-output/mcp-test-html" }`
- 断言：`./test-output/mcp-test-html/index.json` 存在且记录 img 元信息
- 载体：test-page
- 清理：`rm -rf ./test-output/mcp-test-html`
- 备注：test-page 使用 data URI 图片，不会生成独立图片文件；真实 URL 图片会落盘到 images/ 子目录

### extract-attribute-01

- 操作：`extract { type: "attribute", target: { css: "#test-link" }, attribute: "href" }`
- 断言：`result === "https://example.com"`
- 载体：test-page

### extract-attribute-02-not-found

- 操作：`extract { type: "attribute", target: { css: "#btn-id" }, attribute: "data-nonexistent" }`
- 断言：`result === null` 或空字符串（按实现）
- 载体：test-page

### extract-screenshot-01-viewport

- 前置：测试 tab 处于可见状态（其窗口 focused 且 tab active）
- 操作：`extract { type: "screenshot", output: "./test-output/mcp-shot.png" }`
- 断言：
    - `success=true`
    - `./test-output/mcp-shot.png` 存在，`file` 命令识别为 PNG，尺寸 > 10KB
- 载体：test-page
- 清理：`rm ./test-output/mcp-shot.png`
- 备注：hidden tab 下会抛错 "screenshot 需要 tab 可见"

### extract-screenshot-02-fullpage

- 操作：`extract { type: "screenshot", fullPage: true, output: "./test-output/mcp-fs.png" }`
- 断言：文件尺寸 > viewport-only 截图（test-page 总高明显大于视口）
- 载体：test-page

### extract-screenshot-03-jpeg

- 操作：`extract { type: "screenshot", format: "jpeg", quality: 80, output: "./test-output/mcp-s.jpg" }`
- 断言：`file ./test-output/mcp-s.jpg` 识别为 JPEG
- 清理：`rm ./test-output/mcp-s.jpg`

### extract-screenshot-04-element

- 操作：`extract { type: "screenshot", target: { css: "#btn-id" }, output: "./test-output/mcp-el.png" }`
- 断言：文件存在，尺寸 < 全页截图（仅包含按钮）
- 清理：`rm ./test-output/mcp-el.png`

### extract-screenshot-05-scale

- 操作：`extract { type: "screenshot", fullPage: true, scale: 0.5, output: "./test-output/mcp-half.png" }`
- 断言：文件尺寸显著小于 scale=1 的 fullpage 截图
- 清理：`rm ./test-output/mcp-half.png`

### extract-state-01-whole

- 操作：`extract { type: "state" }`
- 断言：返回结构 `{ state: { pageContent, viewport } }`，`pageContent` 非空字符串（含 accessibility tree 文本），
  `viewport.width/height` 为数字
- 载体：test-page

### extract-state-02-target

- 操作：`extract { type: "state", target: { css: ".section:nth-child(2)" } }`
- 断言：返回子树 `pageContent`，只包含 region 1 内的 heading/button/textbox 等节点
- 载体：test-page

### extract-state-03-depth

- 操作：`extract { type: "state", depth: 3 }`
- 断言：返回 `pageContent`（accessibility tree 输出为扁平文本，depth 参数影响生成逻辑但返回格式不直接体现层数）
- 载体：test-page

### extract-state-04-domsnapshot (CDP-only)

- 前置：跑前需 CDP 模式（不在 Extension 模式下测试）
- 操作：`extract { type: "state", mode: "domsnapshot" }`
- 断言：返回 `snapshot.documents` 数组（CDP `DOMSnapshot.captureSnapshot` 原始结果），含 `nodes` / `layout` / `textBoxes`
- 载体：test-page
- KNOWN-LIMIT：Extension 模式下抛 INVALID_ARGUMENT（仅 CDP 支持）

### extract-state-05-domsnapshot-ext-error

- 操作（Extension 模式）：`extract { type: "state", mode: "domsnapshot" }`
- 断言：返回 `error.code === 'INVALID_ARGUMENT'`，message 提示仅 CDP 支持
- 载体：任意

### extract-metadata-01

- 操作：`extract { type: "metadata" }`
- 断言：返回含 `url / title / description / charset / viewport / og / twitter / jsonLd / alternates / feeds`（部分字段可
  null/undefined）
- 载体：demoqa 或 test-page

### extract-frame-01

- 操作：`extract { type: "text", target: { css: "#frame-btn" }, frame: "iframe#test-frame" }`
- 断言：`result === "Frame Button"`
- 载体：test-page

---

## 5. input

> 以下用例默认 inputMode=precise，stealth 专项在 5.X-stealth 分节，测试载体默认 test-page，特殊情况标注

### 5.1 click / mousedown / mouseup

### input-click-01-css

- 前置：attach test-page，先 `evaluate "document.getElementById('mouse-log').textContent=''"` 清空
- 操作：`input { events: [{type:"click", target:{css:"#click-test"}}] }`
- 断言：evaluate 读 `#mouse-log` textContent，包含 "单击测试"（onclick 记日志）
- 载体：test-page

### input-click-02-role

- 操作：`input { events: [{type:"click", target:{role:"button", name:"TestId 定位按钮"}}] }`
- 断言：`success=true`，`eventsExecuted: 1`

### input-click-03-coords

- 操作：先 extract state 找坐标，再 `input { events: [{type:"click", target:{x:<X>,y:<Y>}}] }`
- 断言：目标按钮的 onclick 触发

### input-click-04-right

- 前置：注入 contextmenu 监听器
- 操作：`input { events: [{type:"click", target:{css:"#contextmenu-test"}, button:"right"}] }`
- 断言：监听器记录 1 次 contextmenu 事件，且没有 click 事件

### input-click-05-middle

- 操作：同上，`button:"middle"`
- 断言：auxclick 或 button=1 的事件被触发

### input-click-06-doubleclick

- 前置：注入 dblclick 监听器
- 操作：`input { events: [{type:"click", target:{css:"#dblclick-test"}, clickCount:2}] }`
- 断言：
    - mousedown/mouseup/click 各 2 次（detail=1 和 detail=2）
    - dblclick 1 次（detail=2）

### input-click-07-triple

- 操作：`input { events: [{type:"click", ..., clickCount:3}] }`
- 断言：detail 序列 [1,1,1,2,2,2,3,3,3] + dblclick(detail=2)

### input-click-08-force

- 前置：test-page region 12 应有一个被遮挡的 button（z-index overlay）
- 操作：`input { events: [{type:"click", target:{css:"#covered-btn"}, force:true}] }`
- 断言：click 触发（跳过 actionability 检查）

### input-click-09-react-synthetic

- 前置：attach 到 demoqa.com/buttons
- 操作：`input { events: [{type:"click", target:{role:"button", name:"Click Me"}}] }`
- 断言：页面显示 "You have done a dynamic click"（React onClick 触发）
- 载体：demoqa

### input-mousedown-01

- 前置：注入 mousedown 监听器，precise 模式
- 操作：`input { events: [{type:"mousedown", target:{css:"#click-test"}}] }`
- 断言：监听器收到 1 次 mousedown，`event.buttons=1`

### input-mouseup-01

- 前置：接 mousedown 之后
- 操作：`input { events: [{type:"mouseup", target:{css:"#click-test"}}] }`
- 断言：监听器收到 mouseup，`event.buttons=0`

### 5.2 mousemove / wheel / touch

### input-mousemove-01

- 操作：`input { events: [{type:"mousemove", target:{css:"#scroll-container"}, steps:5}] }`
- 断言：注入 mousemove 监听器，至少收到 1 次事件

### input-wheel-01-vertical

- 前置：attach test-page，scroll-container 初始 scrollTop=0
- 操作：`input { events: [{type:"wheel", target:{css:"#scroll-container"}, deltaY:200}] }`
- 断言：evaluate 读 scroll-container.scrollTop > 0

### input-wheel-02-horizontal

- 前置：`#scroll-container-x` 初始 scrollLeft=0
- 操作：`input { events: [{type:"wheel", target:{css:"#scroll-container-x"}, deltaX:200}] }`
- 断言：scrollLeft > 0

### input-touchstart-01

- 前置：注入 touchstart 监听器
- 操作：`input { events: [{type:"touchstart", target:{css:"#btn-id"}}] }`
- 断言：监听器收到 1 次 touchstart

### input-touchmove-01

- 操作：`touchmove` 配 target 和 steps
- 断言：touchmove 事件触发

### input-touchend-01

- 操作：`touchend`
- 断言：touchend 事件触发

### 5.3 type

### input-type-01-input

- 前置：click #text-input 使其获焦，或内置 target 让 type 先点击
- 操作：`input { events: [{type:"type", target:{css:"#text-input"}, text:"hello"}] }`
- 断言：`#text-input.value === "hello"`

### input-type-02-textarea

- 操作：`type` target=#textarea，`text:"line1\nline2"`
- 断言：`#textarea.value` 包含换行，split('\n').length === 2

### input-type-03-contenteditable

- 操作：`type` target=#edit-contenteditable
- 断言：`#edit-contenteditable.textContent` 追加了文本

### input-type-04-delay

- 操作：`type` `text:"abc", delay:50`
- 断言：整个 type 耗时 >= 3 * 50ms = 150ms

### input-type-05-dispatch

- 前置：attach React 框架页面（demoqa 的某个受控 input）
- 操作：`type { dispatch: true, ... }`
- 断言：React 状态更新（受控组件 value 反映）
- 载体：demoqa

### input-type-06-crlf-normalize

- 操作：`type { text: "line1\r\nline2" }` 到 #textarea
- 断言：textarea.value 为 "line1\nline2"（\r\n 被归一化）
- 载体：test-page

### 5.4 wait（event 内的 wait）

### input-wait-01

- 操作：`input { events: [{type:"wait", ms:300}] }`
- 断言：整体耗时 >= 300ms

### 5.5 select / replace

### input-select-01-input

- 前置：`#text-input.value="hello world"`
- 操作：`input { events: [{type:"select", target:{css:"#text-input"}, find:"world"}] }`
- 断言：evaluate 读 selectionStart=6, selectionEnd=11

### input-select-02-contenteditable

- 操作：同上但 target 是 #edit-contenteditable，内容中 find 指定词
- 断言：`window.getSelection().toString()` 等于查找词

### input-select-03-nth

- 前置：文本中 "a" 出现多次
- 操作：`input { events: [{type:"select", target:{css:"#edit-textarea"}, find:"a", nth:1}] }`
- 断言：选中第 2 个 "a"

### input-replace-01-input

- 前置：`#text-input.value="hello world"`
- 操作：`input { events: [{type:"replace", target:{css:"#text-input"}, find:"world", text:"mcp"}] }`
- 断言：`value === "hello mcp"`

### input-replace-02-textarea

- 操作：replace 目标 #textarea
- 断言：value 文本被替换

### 5.6 drag

### input-drag-01

- 前置：attach test-page；`#drag-source` 和 `#drop-target` 就位
- 操作：`input { events: [{type:"drag", target:{css:"#drag-source"}, to:{css:"#drop-target"}}] }`
- 断言：`#drop-target.textContent === "已放置!"`；`#drag-log.textContent` 含 "drop"

### input-drag-02-reject-coords

- 操作：`input { events: [{type:"drag", target:{x:100,y:100}, to:{css:"#drop-target"}}] }`
- 断言：抛错，消息含 "drag 的 target 不支持坐标类型"

### input-drag-03-no-to

- 操作：`input { events: [{type:"drag", target:{css:"#drag-source"}}] }`
- 断言：抛错，消息含 "drag 事件需要 to 参数"

### 5.7 keydown / keyup

### input-keydown-01-simple

- 前置：注入 keydown 监听器
- 操作：`input { events: [{type:"keydown", key:"a"}, {type:"keyup", key:"a"}] }`
- 断言：监听器收到 keydown key="a", ctrlKey=false

### input-keydown-02-special

- 操作：`key:"Enter"` / `"Tab"` / `"ArrowDown"`
- 断言：监听器对应 key 值匹配

### input-keydown-03-modifier

- 前置：注入监听器
- 操作：`[{keydown, key:"Control"}, {keydown, key:"c"}, {keyup, key:"c"}, {keyup, key:"Control"}]`
- 断言：第 2 个 keydown 的 ctrlKey=true；最后一个 keyup 之后 ctrlKey=false

### input-keydown-04-commands-precise

- 前置：inputMode=precise，#text-input value="hello world"，focus 到它
- 操作：`[{keydown, key:"a", commands:["selectAll"]}, {keyup, key:"a"}]`
- 断言：`#text-input.selectionStart=0, selectionEnd=11`，selectedText="hello world"

### input-keydown-05-commands-copy-paste

- 前置：`#text-input` 已全选 "hello"
- 操作：`[{keydown, key:"c", commands:["copy"]}, {keyup, key:"c"}]`，随后切到 #textarea 再 `commands:["paste"]`
- 断言：`#textarea.value === "hello"`
- 备注：需要剪贴板权限；无权限时可跳过此条

### input-keydown-06-rawkeydown-autorepeat

- 前置：注入 keydown 监听器，记录 `event.repeat` 标志（浏览器原生 KeyboardEvent.repeat）
- 操作：`[{keydown, key:"a"}, {keydown, key:"a"}, {keyup, key:"a"}]`（同一 key 连续 keydown 触发长按）
- 断言：第 2 个 keydown 的 `repeat === true`（CDP 路径会发 `rawKeyDown` + `autoRepeat: true`）
- 载体：test-page

### 5.8 stealth 专项

### input-stealth-click-01-buttons

- 前置：`manage inputMode=stealth`，注入 mouseup/click/contextmenu 监听器
- 操作：`click { button:"right", target:{css:"#contextmenu-test"} }`
- 断言：
    - mousedown buttons=2（右键 W3C 位掩码）
    - mouseup buttons=0（release 态）
    - 触发 contextmenu，不触发 click

### input-stealth-click-02-left-buttons

- 操作：左键 click
- 断言：mousedown buttons=1，mouseup buttons=0

### input-stealth-click-03-middle-buttons

- 操作：`button:"middle"`
- 断言：mousedown buttons=4（W3C middle 位掩码）

### input-stealth-click-04-doubleclick-detail

- 操作：`clickCount:2` 到 #dblclick-test
- 断言：监听器记录序列：mousedown detail=1, mouseup detail=1, click detail=1, mousedown detail=2, mouseup detail=2, click
  detail=2, dblclick detail=2

### input-stealth-type-01

- 前置：stealth 模式，先 click #text-input
- 操作：`type { text:"stealth" }`
- 断言：`#text-input.value === "stealth"`

### input-stealth-keydown-01

- 操作：stealth 模式，`keydown/keyup key="a"`
- 断言：`eventsExecuted: 2`，无错误

### 5.9 humanize

### input-humanize-01

- 操作：`input { humanize:true, events:[{type:"click", target:{css:"#click-test"}}] }`
- 断言：click 成功，整体耗时 > 非 humanize 模式（贝塞尔曲线 + 随机延迟）
- 载体：test-page

### 5.10 timeout / nth

### input-timeout-01

- 操作：`input { timeout: 500, events: [{type:"click", target:{css:"#nonexistent"}}] }`
- 断言：在 500ms+ε 内抛错，错误消息包含 "未找到" 或 "timeout"

---

## 6. logs

### logs-console-01

- 前置：attach test-page，click #log-info（触发 console.log）
- 操作：`logs { type: "console" }`
- 断言：返回数组包含 `{level:"info", text:"[MCP-TEST] Info message"}`

### logs-console-02-level-filter

- 操作：`logs { type: "console", level: "error" }`
- 断言：只返回 error 级别

### logs-console-03-limit

- 操作：触发 5 条日志，再 `logs { type:"console", limit: 3 }`
- 断言：返回 3 条

### logs-console-04-clear

- 操作：`logs { type:"console", clear:true }`，再 `logs console` 无参
- 断言：第二次调用返回空数组

### logs-network-01

- 前置：open 到 demoqa（会发网络请求）
- 操作：`logs { type: "network" }`
- 断言：返回数组非空，每项含 url/method/status
- 载体：demoqa

### logs-network-02-url-pattern

- 操作：`logs { type:"network", urlPattern:"*demoqa.com*" }`
- 断言：每项 url 匹配模式

### logs-output-01

- 操作：`logs { type:"console", output:"./test-output/mcp-logs.json" }`
- 断言：文件存在且为合法 JSON 数组
- 清理：`rm ./test-output/mcp-logs.json`

---

## 7. manage

### manage-newPage-01

- 操作：`manage { action: "newPage" }`
- 断言：`success=true`，返回 `target.targetId` 非空；`browse list` 中能找到
- 清理：`manage closePage targetId=<id>`

### manage-closePage-01

- 前置：先 newPage 创建 T
- 操作：`manage { action:"closePage", targetId:<T> }`
- 断言：`success=true`，`browse list` 找不到 T

### manage-viewport-01

- 操作：`manage { action:"viewport", width:800, height:600 }`
- 断言：`success=true`；随后 `extract screenshot fullPage=false` 尺寸约 800x600

### manage-userAgent-01

- 操作：`manage { action:"userAgent", userAgent:"MCP-Test/1.0" }`
- 断言：`evaluate "navigator.userAgent"` 返回 "MCP-Test/1.0"

### manage-emulate-01-iphone

- 操作：`manage { action:"emulate", device:"iPhone 13" }`
- 断言：`evaluate "navigator.userAgent"` 含 "iPhone"，`evaluate "window.innerWidth"` 约 390

### manage-emulate-02-list

- 操作：`manage { action:"emulate" }`（不带 device）
- 断言：返回 devices 列表，包含 "iPhone 13"、"iPad Pro" 等

### manage-inputMode-01

- 操作：`manage { action:"inputMode", inputMode:"stealth" }`
- 断言：`success=true`，`currentMode="stealth"`；随后 `manage inputMode` 无参返回 "stealth"

### manage-stealth-01

- 操作：`manage { action:"stealth", stealth:"safe" }`（反检测等级切换）
- 断言：`success=true`

### manage-cdp-01-raw

- 操作：`manage { action:"cdp", cdpMethod:"Runtime.evaluate", cdpParams:{expression:"1+1"} }`
- 断言：返回 `{ result: { type:"number", value:2 } }`

---

## 8. wait

### wait-time-01

- 操作：`wait { for:"time", ms:300 }`
- 断言：耗时 ≈ 300ms（允许 ± 100ms）

### wait-idle-01

- 前置：attach test-page，触发 burst mutation（region 11 按钮）
- 操作：`wait { for:"idle", ms:500 }`
- 断言：返回时间接近 mutation 结束后 500ms
- 载体：test-page

### wait-element-01-visible

- 前置：attach test-page，click "5 秒后显示元素" 按钮
- 操作：`wait { for:"element", target:{css:"#show-later-target"}, state:"visible", timeout:6000 }`
- 断言：在约 5s 后返回成功
- 载体：test-page

### wait-element-02-hidden

- 前置：`#show-later-target` 已可见
- 操作：evaluate 设 display=none，随后 `wait element hidden`
- 断言：立即返回成功

### wait-element-03-attached / 04-detached

- 操作：针对 `attached/detached` 状态的等待
- 断言：按状态正确返回

### wait-navigation-01

- 前置：attach 到 example.com
- 操作：`wait { for:"navigation", timeout:3000 }`，同时用 evaluate 触发 `location.href="example.org"`
- 断言：wait 返回，新 url=example.org
- 载体：example.com/.org

### wait-timeout-01

- 操作：`wait { for:"element", target:{css:"#nonexistent"}, timeout:500 }`
- 断言：约 500ms 后抛 timeout 错误

---

## 9. 错误分支 / 边界

### err-stealth-commands-01

- 前置：`inputMode=stealth`
- 操作：`input { events:[{type:"keydown", key:"a", commands:["selectAll"]}] }`
- 断言：抛错，消息包含 "commands 参数不支持 stealth 输入模式"

### err-commands-on-keyup-01

- 前置：`inputMode=precise`
- 操作：`input { events:[{type:"keyup", key:"a", commands:["selectAll"]}] }`
- 断言：抛错，消息包含 "commands 参数只能用于 keydown 事件"

### err-modifiers-no-pollution-01

- 前置：`inputMode=stealth`，注入 keydown 监听器
- 操作：
  ```
  1. input { events: [{keydown, key:"Control", commands:["selectAll"]}] }  // 应抛错
  2. manage inputMode precise
  3. input { events: [{keydown, key:"b"}, {keyup, key:"b"}] }
  ```
- 断言：第 3 步监听器收到的 keydown `ctrlKey=false`（UnifiedSession.modifiers 未被第 1 步污染）

### err-drag-refId-stale-01

- 前置：构造 React 重渲染场景导致 refId 失效（当前外部难构造；此用例标 **KNOWN-LIMIT**，靠静态保证）
- 断言：N/A，记录到"已知限制"

### err-invalid-selector-01

- 操作：`extract { type:"text", target:{css:"###"} }`（非法 CSS）
- 断言：抛错，消息含 "selector" 或 "invalid"

### err-invalid-tabId-01

- 操作：`evaluate { script:"1+1", tabId:"99999999" }`
- 断言：抛错，消息含 "tab" 或 "not found"

### err-evaluate-throw-01

- 操作：`evaluate { script:"throw new Error('boom')" }`
- 断言：返回错误或 result 含 error 字段，消息含 "boom"

### err-wait-element-timeout-01

- 操作：`wait { for:"element", target:{css:"#never"}, timeout:500 }`
- 断言：timeout 错误

### err-non-scriptable-tab-01

- 前置：attach 到 chrome://extensions（扩展页，不可脚本化）
- 操作：`evaluate { script:"1+1" }`
- 断言：抛错，消息含 "cannot be scripted" 或类似
- 载体：chrome:// 页面

### err-output-outside-cwd-01

- 操作：`evaluate { script:"'x'", output:"/etc/passwd" }`
- 断言：抛错，消息含 "cwd" 或 "outside"

### err-scriptFile-outside-cwd-01

- 操作：`evaluate { scriptFile:"/etc/passwd" }`
- 断言：抛错，路径越界拒绝

### err-drag-no-source-01

- 操作：`input { events:[{type:"drag", target:{css:"#nonexistent"}, to:{css:"#drop-target"}}] }`
- 断言：抛错，消息含 "drag 源元素未找到"

### err-iframe-offset-01

- 前置：attach test-page，region 10 的 iframe#test-frame
- 操作：`input { events:[{type:"click", target:{css:"#frame-btn"}, frame:"iframe#test-frame"}] }`
- 断言：iframe 内的 `#frame-btn` textContent 变为 "Clicked"（iframe 坐标 offset 正确处理）
- 载体：test-page

---

## 10. test-page region 索引

test-page.html 现有 region（供用例引用）：

| Region                | 用途                         | 关键 id                                                                                               |
|-----------------------|----------------------------|-----------------------------------------------------------------------------------------------------|
| 1 定位                  | 各种 locator 测试              | #btn-id, #input-placeholder, #input-title, #link-test, [data-testid='test-button']                  |
| 2 输入                  | input/textarea 输入          | #text-input, #textarea, #input-result                                                               |
| 3 键盘                  | 键盘事件日志                     | #key-display, #key-log                                                                              |
| 4 鼠标                  | click/dblclick/contextmenu | #click-test, #dblclick-test, #contextmenu-test, #mouse-log                                          |
| 5 拖拽                  | drag-source / drop-target  | #drag-source, #drop-target, #drag-log                                                               |
| 6 滚动                  | 内容溢出容器（纵向 + 横向）            | #scroll-container, #scroll-middle, #scroll-bottom, #scroll-container-x, #scroll-x-left/middle/right |
| 7 日志                  | 触发不同级别 console             | #log-info, #log-warn, #log-error, #log-custom                                                       |
| 8 媒体                  | 图片 / 链接                    | #test-image, #test-link                                                                             |
| 9 select/replace      | 三种场景                       | #edit-input, #edit-textarea, #edit-contenteditable                                                  |
| 10 iframe             | 跨框架交互                      | #test-frame, #frame-btn, #frame-input, #frame-result                                                |
| 11 wait               | 延迟/哈希/burst mutation       | #show-later-btn, #show-later-target, #hashnav-btn, #burst-mutation-btn, #burst-mutation-target      |
| 12 force + combo keys | 覆盖层 + 组合键输入                | #covered-btn, #combo-input                                                                          |

**本清单引用但 test-page 尚未覆盖的元素**（待补区）：

- 无（横向滚动容器 `#scroll-container-x` 已补）

---

## 附录 A：已知限制 / KNOWN-LIMIT

- `err-drag-refId-stale-01` — 需要 V8 GC 才能让 WeakRef deref 失败，从外部 mcp 工具无法稳定构造，
  靠静态代码 review + `dist` 字面量 + 正常 drag 端到端 smoke 保证
- `input-keydown-05-commands-copy-paste` — 依赖剪贴板权限，无权限或 headless 下跳过
- `err-iframe-offset-01` srcdoc iframe — `chrome.scripting.executeScript` 不能注入 `about:srcdoc` frame
  （Chromium 限制 [crbug.com/40232842](https://issues.chromium.org/40232842)）；
  走 scripting 路径的 `input click` 在 srcdoc iframe 内找不到元素，`evaluate frame=...` 走 CDP 不受影响；
  有 `src` 属性的真实 iframe 不受影响
