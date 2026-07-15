# mcp-chrome 发版前回归清单

本清单用于在 Claude Code 会话内由 agent 按用例 ID 顺序跑一遍，**全部 PASS 才能执行 `npm publish`**

`test/run-all.js` 是独立冷启动 smoke（跑 demoqa），**定位为可选补充**——覆盖 smoke-level 的工具调用，不做行为级断言，真正回归以本清单为准

---

## 0. 跑法（agent-driven，在 CC 内）

### 0.1 前置条件

**执行总纲**：按本清单用例顺序跑，全部 PASS 才放行，跑的过程中严守"不污染用户环境"——禁止操作用户已有
tab，禁止清全局缓存/cookies，只能动测试 tab 和测试创建的 `mcp_test_*` 前缀数据，任何与此冲突的用例就地标 SKIP

- Chrome Extension 已在 `chrome://extensions/` 刷新为最新 dist，popup 显示 **已连接**
- CC 重启后 Extension 应自动连接本地 MCP Server；除非测试强制 token 或手动连接流程，否则“需要点连接”不能作为发版前置条件
- MCP server 已加载最新 dist（src 有任何改动 → `npm run build` → 重启 CC，否则跑到的是旧进程）
- 全程使用 `manage action=newPage` 创建的测试 tab，**严禁操作用户已有 tab**
- 所有浏览操作默认 `activated=false`（后台）；只有截图 compare 等需要可见 renderer 的用例可临时 `manage activatePage`
  ，且目标必须是 agent 自己创建的 managed 测试 tab
- 清理只针对测试 tab 和 `mcp_test_*` 前缀的 cookie，严禁 `cookies clear` 无过滤
- output 相对路径默认写入 mcp-chrome 受控临时目录；需要保留在仓库内时使用 `cwd:test-output/...`，跑前确认 `test-output`
  存在，跑后可清空

### 0.2 测试载体

| 载体            | 位置                                                   | 作用                                   |
|---------------|------------------------------------------------------|--------------------------------------|
| **test-page** | `file:///<repo>/mcp-chrome/extension/test-page.html` | 受控页面，13 region，可注入 evaluate 监听器做行为断言 |
| **demoqa**    | `https://demoqa.com/`                                | 可选真实站点补充；外部网络不可达时不得阻塞发版门禁 |

每个用例在字段 `载体` 里标注 `test-page` / `demoqa` / `任意` / `N/A`。发版门禁优先使用 `test-page` 和 `about:blank` 受控页面；外部站点只作补充观察，导航超时或网络不可达时记录 SKIP，并执行对应受控页面用例

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
4. [extract](#4-extract) — 7 types
5. [input](#5-input) — 14 event types
6. [logs](#6-logs) — 2 types
7. [manage](#7-manage) — 18 actions
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
    - Extension 模式返回 `windows` 树，包含 `windowCount / focusedWindowId / activeTargetId / windows[].tabs[]`
    - `windows[].tabs[]` 按 `index` 升序排列，每个窗口最多一个 `active=true` tab
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

### browse-open-03-diagnostics-first-page

- 前置：当前没有 attach 页面，或 attach 状态为空
- 操作：`browse { action: "open", url: "about:blank", wait: "load", diagnostics: true }`
- 断言：`success=true`，响应含 `diagnostics.console` 和 `diagnostics.failedRequests` 数组，首次自动创建页面时也返回
  diagnostics
- 载体：N/A

### browse-open-02-wait-networkidle

- 前置：attach 到 test tab
- 操作：`browse { action: "open", url: "file:///<repo>/mcp-chrome/extension/test-page.html#networkidle", wait: "networkidle" }`
- 断言：`success=true`，`url` 以 `file:///` 开头且包含 `#networkidle`，返回耗时包含 networkidle 静默等待
- 载体：test-page

### browse-back-01

- 前置：测试 tab open 到 `file:///<repo>/mcp-chrome/extension/test-page.html#page-a` → 再 open 到 `file:///<repo>/mcp-chrome/extension/test-page.html#page-b`，形成两页历史
- 操作：`browse { action: "back" }`
- 断言：`success=true`，当前 URL 回到 `#page-a`
- 载体：test-page
- 备注：`chrome.tabs.goBack` 在 `chrome.tabs.update` 产生的历史栈上可能失败，实现里用 `history.back()` fallback

### browse-forward-01

- 前置：接 `browse-back-01` 之后
- 操作：`browse { action: "forward" }`
- 断言：`success=true`，当前 URL 回到 `#page-b`
- 载体：test-page

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

### browse-managed-guard-01

- 前置：`browse list` 找到 managed=false 的用户 tab，但只 attach activate=false，不导航不关闭
- 操作：`browse { action:"open", url:"about:blank" }`
- 断言：返回 `UNMANAGED_TAB`，建议使用 managed=true 测试 tab 或 manage newPage
- 载体：N/A

### browse-list-02-mode-field

- 前置：Extension 模式已接管
- 操作：`browse { action: "list" }`
- 断言：至少一个 target 的 `mode === "extension"`；确认不是 CDP-only
- 载体：N/A

---

## 2. cookies

### cookies-get-01

- 前置：attach 到任意 managed test tab
- 操作：`cookies { action: "get" }`（不带 name/domain/url 过滤）
- 断言：返回错误，消息包含 `必须带 name/domain/url 至少一个过滤参数`
- 载体：任意
- 备注：get 不允许无过滤读取全量 cookie，后续读取用 name、domain 或 url 收窄范围

### cookies-get-02-domain-filter

- 前置：先 set `mcp_test_domain` 到 `https://mcp-chrome.test/`
- 操作：`cookies { action: "get", domain: "mcp-chrome.test" }`
- 断言：每个 cookie 的 domain 字段以 `mcp-chrome.test` 结尾或相等，且能读到 `mcp_test_domain`
- 载体：任意
- 清理：`cookies delete name=mcp_test_domain url=https://mcp-chrome.test/`

### cookies-get-03-url-filter

- 前置：先 set `mcp_test_url` 到 `https://mcp-chrome.test/`
- 操作：`cookies { action: "get", url: "https://mcp-chrome.test/" }`
- 断言：返回 cookies 与 `mcp-chrome.test` 匹配，且能读到 `mcp_test_url`
- 载体：任意
- 清理：`cookies delete name=mcp_test_url url=https://mcp-chrome.test/`

### cookies-get-04-secure-only

- 前置：先 set secure cookie `mcp_test_secure` 到 `https://mcp-chrome.test/`
- 操作：`cookies { action: "get", url: "https://mcp-chrome.test/", secure: true }`
- 断言：每个返回的 cookie 的 `secure=true`，且能读到 `mcp_test_secure`
- 载体：任意
- 清理：`cookies delete name=mcp_test_secure url=https://mcp-chrome.test/`

### cookies-get-05-output-json

- 前置：先 set `mcp_test_output` 到 `https://mcp-chrome.test/`
- 操作：`cookies { action: "get", domain: "mcp-chrome.test", output: "cwd:test-output/mcp-test-cookies.json" }`
- 断言：
    - `success=true`
    - `./test-output/mcp-test-cookies.json` 存在且为合法 JSON
- 载体：任意
- 清理：`cookies delete name=mcp_test_output url=https://mcp-chrome.test/`，删除 `./test-output/mcp-test-cookies.json`

### cookies-set-01

- 前置：attach 到任意 managed test tab
- 操作：`cookies { action: "set", name: "mcp_test_a", value: "1", url: "https://mcp-chrome.test/" }`
- 断言：`success=true`，随后 `cookies get name=mcp_test_a url=https://mcp-chrome.test/` 能读到 value=1
- 载体：任意（cookie 的 url 字段使用受控测试域名，不访问外网）
- 清理：`cookies delete name=mcp_test_a url=https://mcp-chrome.test/`

### cookies-set-02-with-attrs

- 操作：
  `cookies { action: "set", name: "mcp_test_b", value: "2", url: "https://mcp-chrome.test/", secure: true, httpOnly: true, sameSite: "Lax", expirationDate: <Math.floor(Date.now()/1000)+3600> }`
- 断言：读回后 value、secure、httpOnly、sameSite、expirationDate 一致；`expirationDate` 必须是 Unix 秒级时间戳
- 清理：`cookies delete name=mcp_test_b url=https://mcp-chrome.test/`

### cookies-delete-01

- 前置：先 set mcp_test_c 到 `https://mcp-chrome.test/`
- 操作：`cookies { action: "delete", name: "mcp_test_c", url: "https://mcp-chrome.test/" }`
- 断言：`success=true`，再 get 找不到
- 载体：任意

### cookies-clear-01-domain

- 状态：**SKIP**（与 MEMORY "只删 mcp_test_* 前缀" 冲突，clear 无 name 过滤，domain=mcp-chrome.test 会清同域非测试 cookie）
- 前置：先 set mcp_test_d 到 mcp-chrome.test
- 操作：`cookies { action: "clear", domain: "mcp-chrome.test" }`
- 断言：`success=true`，之后 `cookies get domain=mcp-chrome.test` 不含 mcp_test_d
- 载体：任意
- 注意：**不得运行无参数的 clear**，会清所有 cookie；手工跑时用独立 Chrome profile
- 替代验证：用 `cookies delete name=mcp_test_d url=https://mcp-chrome.test/` 清理测试 cookie

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

- 前置：在受控临时目录准备 `mcp-eval.js`
- 操作：`evaluate { scriptFile: "tmp:mcp-eval.js" }`
- 断言：`result === 42`
- 载体：任意

### evaluate-precise-09-output

- 操作：`evaluate { script: "'hello world'", output: "tmp:mcp-eval-out.txt" }`
- 断言：文件存在，内容为 `hello world`（不带引号）
- 载体：任意

### evaluate-default-precise-01

- 前置：`manage inputMode stealth`
- 操作：`evaluate { script: "const value = 41; value + 1", postCondition: { script: "const ready = true; ready" } }`
- 断言：未显式传 `mode` 时仍返回 `result === 42`，`postCondition.verificationStatus === "matched"`
- 载体：任意

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

### evaluate-diagnostics-01

- 操作：`evaluate { script: "console.warn('mcp_diag_warn'); fetch('/mcp_diag_404')", diagnostics: true }`
- 断言：返回 `diagnostics.console` 含 warning，`diagnostics.failedRequests` 含失败请求摘要
- 载体：test-page

### evaluate-nonserializable-01-dom-node

- 操作：`evaluate { script: "document.body" }`
- 断言：返回 `isError=true`，`error.code === "NON_SERIALIZABLE_EVALUATE_RESULT"`，`error.suggestion` 含 `outerHTML` 或
  `textContent`
- 载体：test-page

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

- 操作：`extract { type: "html", target: { css: "body" }, images: "data", output: "cwd:test-output/mcp-test-html" }`
- 断言：`./test-output/mcp-test-html/index.json` 存在且记录 img 元信息
- 载体：test-page
- 清理：`rm -rf ./test-output/mcp-test-html`
- 备注：test-page 使用 data URI 图片，不会生成独立图片文件；真实 URL 图片会写入 images/ 子目录

### extract-attribute-01

- 操作：`extract { type: "attribute", target: { css: "#test-link" }, attribute: "href" }`
- 断言：`result === "https://example.com"`
- 载体：test-page

### extract-attribute-02-not-found

- 操作：`extract { type: "attribute", target: { css: "#btn-id" }, attribute: "data-nonexistent" }`
- 断言：`result === null` 或空字符串（按实现）
- 载体：test-page

### extract-screenshot-01-viewport

- 前置：测试 tab 处于可见状态（其窗口 focused 且 tab active）；对 managed 测试 tab 执行 `manage activatePage` 后等待约 800ms 再截图
- 操作：`extract { type: "screenshot", output: "cwd:test-output/mcp-shot.png" }`
- 断言：
    - `success=true`
    - `./test-output/mcp-shot.png` 存在，`file` 命令识别为 PNG，尺寸 > 10KB
- 载体：test-page
- 清理：`rm ./test-output/mcp-shot.png`
- 备注：hidden tab 下返回 `error.code === "HIDDEN_TAB_SCREENSHOT"`，不会自动切前台

### extract-screenshot-02-fullpage

- 操作：`extract { type: "screenshot", fullPage: true, output: "cwd:test-output/mcp-fs.png" }`
- 断言：文件尺寸 > viewport-only 截图（test-page 总高明显大于视口）
- 载体：test-page

### extract-screenshot-03-jpeg

- 操作：`extract { type: "screenshot", format: "jpeg", quality: 80, output: "cwd:test-output/mcp-s.jpg" }`
- 断言：`file ./test-output/mcp-s.jpg` 识别为 JPEG
- 清理：`rm ./test-output/mcp-s.jpg`

### extract-screenshot-04-element

- 操作：`extract { type: "screenshot", target: { css: "#btn-id" }, output: "cwd:test-output/mcp-el.png" }`
- 断言：文件存在，尺寸 < 全页截图（仅包含按钮）；目标元素滚动后仍应截到元素本身，不应返回空白区域
- 清理：`rm ./test-output/mcp-el.png`

### extract-screenshot-05-scale

- 操作：`extract { type: "screenshot", fullPage: true, scale: 0.5, output: "cwd:test-output/mcp-half.png" }`
- 断言：文件尺寸显著小于 scale=1 的 fullpage 截图
- 清理：`rm ./test-output/mcp-half.png`

### extract-screenshot-06-clip

- 操作：
  `extract { type: "screenshot", clip: { x: 0, y: 0, width: 200, height: 120 }, output: "cwd:test-output/mcp-clip.png" }`
- 断言：返回 `metadata.clip` 与入参一致，`metadata.width/height/byteSize/format/dimensionSource/capabilities`
  存在，文件存在且尺寸小于全页截图
- 清理：`rm ./test-output/mcp-clip.png`

### extract-screenshot-07-compare

- 前置：attach test-page，必要时对 managed 测试 tab 执行 `manage activatePage`；点击 `#compare-reset-btn` 后调用
  `extract { type: "screenshot", target: { css: "#compare-box" }, output: "cwd:test-output/mcp-before.png" }`
- 操作：点击 `#compare-toggle-btn` 后调用
  `extract { type: "screenshot", target: { css: "#compare-box" }, compareWith: "cwd:test-output/mcp-before.png", diffOutput: "cwd:test-output/mcp-diff.png", output: "cwd:test-output/mcp-after.png" }`
- 断言：返回 `metadata.comparison.pixelDiffRatio > 0`、`differentPixels > 0`、`totalPixels > 0`，差异图文件存在
- 边界：使用超过 25 MiB 或 12,000,000 像素的 PNG 作为 `compareWith` 时返回明确错误，提示使用 `clip` 或 `scale`
- 清理：`rm ./test-output/mcp-before.png ./test-output/mcp-after.png ./test-output/mcp-diff.png`

### extract-state-01-whole

- 操作：`extract { type: "state" }`
- 断言：返回结构 `{ state: { pageContent, viewport, interactiveElements } }`，`pageContent` 非空字符串（含 accessibility
  tree 文本），`viewport.width/height` 为数字，`interactiveElements` 含 role/name/selector/visible/disabled/bounds/covered
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
- 断言：返回含 `url / title / description / charset / viewport / og / twitter / jsonLd / alternates / feeds / frames`
  （部分字段可 null/undefined），`frames` 含 index/frameId/parentFrameId/url/title/name/selector/rect，Extension 和 CDP
  模式都应返回 frames 数组
- 载体：test-page

### extract-frame-01

- 操作：`extract { type: "text", target: { css: "#frame-btn" }, frame: "iframe#test-frame" }`
- 断言：`result === "Frame Button"`
- 载体：test-page

### extract-frameHtml-01

- 操作：`extract { type: "frameHtml", frame: "iframe#test-frame" }`
- 断言：返回 `type === "frameHtml"`，`content` 含 `frame-btn`
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

### input-click-08-actionability-diagnostics

- 前置：test-page region 12 应有一个被遮挡的 button（z-index overlay）
- 操作：`input { events: [{type:"click", target:{css:"#covered-btn"}}] }`
- 断言：返回 `isError=true`，`error.code === "ACTIONABILITY_FAILED"`，`error.context` 含 `rect`、`clickPoint`、
  `coveringElement`、`candidates`

### input-click-09-synthetic-event

- 前置：attach 到 test-page，清空 `#mouse-log`
- 操作：`input { events: [{type:"click", target:{role:"button", name:"单击测试", exact:true}}] }`
- 断言：`#mouse-log.textContent` 包含 `单击测试 click`
- 载体：test-page

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

- 前置：attach 到 test-page，清空 `#controlled-input`，并把 `data-input-events/data-change-events` 置为 `0`
- 操作：`input { events: [{type:"type", target:{css:"#controlled-input"}, text:"abc", dispatch:true}] }`
- 断言：`#controlled-input.value === "abc"`，`#controlled-result.textContent` 包含 `controlled input: abc`，`data-input-events` 大于 0
- 载体：test-page

### input-type-05-controlled

- 前置：attach 到 test-page，清空 `#controlled-input`，并把 `data-input-events/data-change-events` 置为 `0`
- 操作：`input { events: [{type:"type", target:{css:"#controlled-input"}, text:"abc", mode:"controlled"}], diagnostics:true }`
- 断言：value 更新并触发 input/change；失败时错误包含 matchCount、activeElement、candidates；diagnostics 字段存在
- 载体：test-page

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

### input-select-04-target-nth

- 前置：注入两个 `.mcp-nth-target` textarea，第二个 value 为 `"a a a"`
- 操作：`input { events: [{type:"select", target:{css:".mcp-nth-target", nth:1}, find:"a", nth:1}] }`
- 断言：聚焦第二个 textarea，并选中其中第 2 个 `"a"`，事件级 `nth` 没有覆盖 `target.nth`

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

### 5.8 editor 专项

### input-editor-01-context

- 前置：focus 到 #edit-contenteditable，并选中一段文本
- 操作：`input { events: [{type:"editorContext", target:{css:"#edit-contenteditable"}}] }`
- 断言：返回 `eventResults[0].editableElement.isContentEditable=true`，`selectedText` 与当前选区一致

### input-editor-02-insert

- 前置：focus 到 #edit-contenteditable
- 操作：`input { events: [{type:"editorInsert", target:{css:"#edit-contenteditable"}, text:" inserted"}] }`
- 断言：`#edit-contenteditable.textContent` 包含 `inserted`，当前 inline 格式未被整块替换

### input-editor-03-command

- 前置：focus 到 #edit-contenteditable，并选中文本
- 操作：`input { events: [{type:"editorCommand", target:{css:"#edit-contenteditable"}, command:"bold"}] }`
- 断言：目标内容出现加粗效果或 DOM 中出现 `<b>`/`<strong>` 包裹

### 5.9 stealth 专项

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
- 断言：在 500ms+ε 内抛错，错误 `code` 为 `TARGET_NOT_FOUND` 或 timeout 类错误，`context` 含
  `target/matchCount/nth/page.activeElement/page.selection/page.candidates`

---

## 6. logs

### logs-console-01

- 前置：attach test-page，click #log-info（触发 console.log）
- 操作：`logs { type: "console" }`
- 断言：返回数组包含 `{level:"info", text:"[MCP-TEST] Info message"}`

### logs-console-02-error-filter

- 操作：`logs { type: "console", level: "error" }`
- 断言：只返回 error 级别

### logs-console-02-info-filter

- 前置：触发 `console.log("mcp_info_filter")`
- 操作：`logs { type: "console", level: "info" }`
- 断言：结果包含 `{level:"info", text:"mcp_info_filter"}`，不返回原始 `level:"log"`

### logs-console-03-limit

- 操作：触发 5 条日志，再 `logs { type:"console", limit: 3 }`
- 断言：返回 3 条

### logs-console-04-clear

- 操作：`logs { type:"console", clear:true }`，再 `logs console` 无参
- 断言：第二次调用返回空数组

### logs-network-01

- 前置：attach 到 test-page，执行 `evaluate { script:"fetch('/mcp_missing_resource').catch(()=>{})" }`
- 操作：`logs { type: "network" }`
- 断言：返回数组非空，每项含 url/method/status 或 errorText 中可由当前浏览器提供的值
- 载体：test-page

### logs-network-02-url-pattern

- 前置：接 `logs-network-01`
- 操作：`logs { type:"network", urlPattern:"*mcp_missing_resource*" }`
- 断言：每项 url 匹配模式

### logs-network-03-failed-request

- 前置：attach 到 test-page，执行 `evaluate { script:"fetch('/mcp_missing_resource').catch(()=>{})" }` 或
  `browse/evaluate diagnostics=true` 触发失败请求
- 操作：`logs { type:"network" }`
- 断言：返回数组含失败请求或 4xx/5xx 请求，字段含 `url/method/status/errorText/timestamp/duration` 中可由当前浏览器提供的值

### logs-network-04-inline-url-limit

- 前置：通过 image 或 fetch 触发长度超过 2048 的 data URL 网络记录
- 操作：`logs { type:"network" }`
- 断言：对应记录 `url.length === 2048`，`urlLength` 等于原始长度，`urlTruncated === true`
- 操作：`logs { type:"network", output:"tmp:mcp-network-logs.json" }`
- 断言：输出文件中的对应记录保留完整 URL，不含内联截断

### logs-output-01

- 操作：`logs { type:"console", output:"cwd:test-output/mcp-logs.json" }`
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
- 断言：`success=true`，返回 `affected.before.targetId=<T>` 且 `affected.after=null`，`browse list` 找不到 T

### manage-adoptPage-01

- 前置：`browse list` 找到一个 `managed=false` 的目标 T，只读取列表，不导航不激活
- 操作：`manage { action:"adoptPage", targetId:<T> }`
- 断言：`success=true`，`managedBefore=false`，`managedAfter=true`，再次 `browse list` 中 T 为 `managed=true`
- 清理：执行 `manage releasePage targetId=<T>`，不要关闭用户已有 tab

### manage-releasePage-01

- 前置：先 newPage 创建受控 tab T
- 操作：`manage { action:"releasePage", targetId:<T> }`
- 断言：`success=true`，`managedBefore=true`，再次 `browse list` 中 T 为 `managed=false`
- 清理：重新 `adoptPage` 后执行 `closePage` 关闭测试 tab

### manage-movePage-01

- 前置：先 newWindow 创建测试窗口 W，再 newPage 创建受控 tab T
- 操作：`manage { action:"movePage", targetId:<T>, windowId:<W>, index:0 }`
- 断言：`success=true`，返回 `affected.before/after`，`affected.after.windowId=<W>` 且 `affected.after.index=0`
- 清理：关闭测试窗口或测试 tab

### manage-reorderPage-01

- 前置：同一测试窗口内创建两个受控 tab T1/T2
- 操作：`manage { action:"reorderPage", targetId:<T2>, index:0 }`
- 断言：`success=true`，`affected.before.index != affected.after.index`，再次 `browse list` 中 T2 排在 index 0

### manage-pinPage-01

- 前置：先 newPage 创建 T
- 操作：`manage { action:"pinPage", targetId:<T> }`
- 断言：`success=true`，`affected.before.pinned=false`，`affected.after.pinned=true`
- 清理：`manage unpinPage targetId=<T>` 后关闭 T

### manage-unpinPage-01

- 前置：先将测试 tab T 执行 `pinPage`
- 操作：`manage { action:"unpinPage", targetId:<T> }`
- 断言：`success=true`，`affected.before.pinned=true`，`affected.after.pinned=false`

### manage-activatePage-01

- 状态：只在需要可见 renderer 的用例或本地手动发版验证中执行，目标必须是 agent 自己创建的 managed 测试 tab T
- 前置：只使用 agent 自己创建的测试 tab T
- 操作：`manage { action:"activatePage", targetId:<T> }`
- 断言：`success=true`，`affected.after.active=true`

### manage-focusWindow-01

- 状态：**SKIP**（会抢占前台，常规回归不执行）
- 前置：只使用 agent 自己创建的测试窗口 W
- 操作：`manage { action:"focusWindow", windowId:<W> }`
- 断言：`success=true`，`affected.after.focused=true`

### manage-resizeWindow-01

- 前置：先 newWindow 创建测试窗口 W，不使用用户窗口
- 操作：`manage { action:"resizeWindow", windowId:<W>, width:900, height:700 }`
- 断言：`success=true`，`affected.before/after` 存在，`affected.after.width` 和 `affected.after.height` 接近设置值
- 清理：`manage closeWindow windowId=<W>`

### manage-newWindow-01

- 前置：仅在独立测试窗口场景执行
- 操作：`manage { action:"newWindow", url:"about:blank", focused:false }`
- 断言：`success=true`，返回 `affected.windowId` 和 `affected.targetId`，`affected.after.tabs[]` 全部 `managed=true`
- 清理：`manage closeWindow windowId=<affected.windowId>`

### manage-closeWindow-01

- 前置：先 newWindow 创建测试窗口 W，确认窗口内全是 managed tab
- 操作：`manage { action:"closeWindow", windowId:<W> }`
- 断言：`success=true`，`affected.before.windowId=<W>`，`affected.after=null`，再次 `browse list` 找不到 W

### manage-closeWindow-02-unmanaged-guard

- 前置：`browse list` 找到含 `managed=false` tab 的用户窗口 W，只读取列表，不聚焦不导航
- 操作：`manage { action:"closeWindow", windowId:<W> }`
- 断言：返回 `WINDOW_HAS_UNMANAGED_TABS`，窗口仍存在

### manage-viewport-01

- 操作：`manage { action:"viewport", width:800, height:600 }`
- 断言：`success=true`；随后 `extract screenshot fullPage=false` 尺寸约 800x600

### manage-userAgent-01

- 操作：`manage { action:"userAgent", userAgent:"MCP-Test/1.0" }`
- 断言：`evaluate "navigator.userAgent"` 返回 "MCP-Test/1.0"

### manage-emulate-01-iphone

- 操作：`manage { action:"emulate", device:"iPhone 13" }`
- 断言：`evaluate "navigator.userAgent"` 含 "iPhone"，`navigator.maxTouchPoints` 为 1，`visualViewport.width` 与
  `document.documentElement.clientWidth` 约 390

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

- 前置：attach 全新 test-page，执行 evaluate 创建 Web Worker，每 50ms 更新一次 `#burst-mutation-target`，1s 后停止
- 操作：`wait { for:"idle", ms:500, timeout:8000 }`
- 断言：`success=true`，随后读取 `#burst-mutation-target.dataset.workerTick` 大于 0，返回时间在 mutation 结束并达到 500ms DOM 静默后
- 载体：test-page

### wait-idle-02-timeout

- 前置：attach test-page，执行 evaluate 创建 Web Worker，每 50ms 更新一次 `#burst-mutation-target`，2s 后停止
- 操作：`wait { for:"idle", ms:500, timeout:1200 }`
- 断言：返回 timeout 错误，消息包含 `DOM 未达到 500ms 静默`
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

- 前置：attach 到 test-page，先执行 `evaluate { script:"(() => { document.title = 'mcp-nav-start'; setTimeout(() => { document.title = 'mcp-nav-done'; location.hash = 'mcp-nav-' + Date.now(); }, 100); return true; })()" }`
- 操作：`wait { for:"navigation", timeout:3000 }`
- 断言：wait 返回，新 title 为 `mcp-nav-done`，URL hash 包含 `mcp-nav-`
- 载体：test-page

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

### err-output-outside-allowed-roots-01

- 操作：`evaluate { script:"'x'", output:"/etc/passwd" }`
- 断言：抛错，消息含允许范围或 outside

### err-scriptFile-outside-allowed-roots-01

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
| 13 screenshot compare | 固定截图差异区域                   | #compare-box, #compare-toggle-btn, #compare-reset-btn                                               |

**本清单引用但 test-page 尚未覆盖的元素**（待补区）：

- 无（横向滚动容器 `#scroll-container-x` 和截图差异区域 `#compare-box` 已补）

---

## 附录 A：已知限制 / KNOWN-LIMIT

- `err-drag-refId-stale-01` — 需要 V8 GC 才能让 WeakRef deref 失败，从外部 mcp 工具无法稳定构造，
  靠静态代码 review + `dist` 字面量 + 正常 drag 端到端 smoke 保证
- `input-keydown-05-commands-copy-paste` — 依赖剪贴板权限，无权限或 headless 下跳过
- `err-iframe-offset-01` srcdoc iframe — `chrome.scripting.executeScript` 不能注入 `about:srcdoc` frame
  （Chromium 限制 [crbug.com/40232842](https://issues.chromium.org/40232842)）；
  走 scripting 路径的 `input click` 在 srcdoc iframe 内找不到元素，`evaluate frame=...` 走 CDP 不受影响；
  有 `src` 属性的真实 iframe 不受影响


## CH-01 至 CH-07 聚焦回归

- `ch-input-01`: 对 `#edit-number` 执行 replace，确认不调用 selection API，返回 `requestedValue`、`actualValue`，并派发 `input` 与 `change`
- `ch-input-02`: 对 `#edit-date` 执行 select，确认返回 `UNSUPPORTED_SELECTION` 及 tag、input type、current value、requested find、推荐模式
- `ch-postcondition-01`: 已完成动作后的 false selector 返回 `actionStatus=completed`、`verificationStatus=not_matched`、`failureStage=verification`
- `ch-postcondition-02`: frame/context/debugger 不可用返回 `verificationStatus=unavailable`，不伪装为 `not_matched`
- `ch-timeout-01`: 1ms debugger timeout 返回 `actionStatus=unknown`，不宣称页面脚本未执行
- `ch-target-01`: input、extract、wait 的 target timeout 返回 locator、target type、nth、URL、tabId、managed、frame、match count、最多 10 个候选和 last state
- `ch-port-01`: 无 server 时 Extension 只输出聚合 debug 摘要，不为每个候选端口输出 warning/error
- `ch-port-02`: 已识别 MCP server 的 token/proof 不匹配或认证协议不完整时，输出一条限量 warning；同一摘要重连时不重复刷屏
- `ch-frame-01`: iframe 导航销毁 context 后 precise evaluate 仅重试一次，并返回 retry 和最终 frame/context 摘要
- `ch-frame-02`: 两个相同 URL iframe 返回 bounded candidates 并拒绝选择任一 frame
- `ch-diagnostics-01`: restricted URL 导航到普通 URL 且 `diagnostics=true`，主导航成功，返回 `diagnosticsStatus=unavailable` 与原始摘要
- `ch-diagnostics-02`: browse 或 wait 主动作失败且 `diagnostics=true` 时，错误响应保留 `diagnosticsStatus`、新增 console/network 摘要或采集错误

无需浏览器的聚焦测试执行 `npm test`，真实 MCP runtime 回归仍需按本文件用例顺序在受控测试 tab 中执行
