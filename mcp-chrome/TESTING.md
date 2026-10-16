# mcp-chrome 发版前回归清单

本清单用于在 Claude
Code 会话内由 agent 按用例 ID 顺序执行；所有必跑用例 PASS，条件用例 PASS 或按明确前置条件记录 SKIP，KNOWN-LIMIT 已登记到附录 A，才能执行
`npm publish`

本文件只维护可复用的测试指导、用例定义、验收标准和长期限制，不记录单次执行结果、日期化回归记录或发版日志

`test/run-all.js`
是独立冷启动 smoke（运行 demoqa），定位为可选补充，仅覆盖 smoke-level 的工具调用，不做行为级断言，真正回归以本清单为准

---

## 0. 跑法（agent-driven，在 CC 内）

### 0.1 前置条件

**执行总纲**：按本清单用例顺序执行，默认状态为必跑；禁止操作用户已有 tab，禁止清除全局缓存或 cookies，只能操作 agent 创建的 managed 测试 tab 和测试创建的
`mcp_test_*` 前缀数据；需要激活页面、聚焦窗口、创建窗口或启动浏览器的用例只能在独立测试浏览器中作为条件用例执行

- Chrome Extension 已在 `chrome://extensions/` 刷新为最新 dist，popup 显示 **已连接**；调用
  `browse(action="connect")`，确认 `extension.bundleStatus="match"`，活动 `extensionBackgroundBundleHash` 与
  `expectedBackgroundBundleHash` 相同，不能只比较manifest version
- CC 重启后 Extension 应自动连接本地 MCP Server；除非测试强制 token 或手动连接流程，否则“需要点连接”不能作为发版前置条件
- MCP server 已加载最新 dist（src 有任何改动 → `npm run build` → 重启 CC，否则跑到的是旧进程）
- 全程使用 `manage action=newPage` 创建的测试 tab， **严禁操作用户已有 tab**
- 所有浏览操作保持 `activated=false` 并在后台执行；常规回归不调用
  `browse activate=true`、`manage activatePage`、`manage focusWindow` 或 `manage newWindow`
- 清理只针对测试 tab 和 `mcp_test_*` 前缀的 cookie，严禁 `cookies clear` 无过滤
- output 相对路径默认写入当前 server 会话的受控临时目录；需要保留在仓库内时使用 `cwd:test-output/...`，跑前确认
  `test-output` 存在，跑后仅清理本次用例创建的文件

### 0.2 测试载体

| 载体              | 位置                                                     | 作用                                   |
| ----------------- | -------------------------------------------------------- | -------------------------------------- |
| **test-page**     | `file:///<repo>/mcp-chrome/extension/test-page.html`     | 受控页面，覆盖 14 个 region 和行为断言 |
| **test-csp-page** | `file:///<repo>/mcp-chrome/extension/test-csp-page.html` | 受控严格 CSP 页面                      |
| **demoqa**        | `https://demoqa.com/`                                    | 可选外部站点，网络不可达时跳过         |

每个用例在字段 `载体` 里标注 `test-page` / `test-csp-page` / `demoqa` / `任意` / `N/A`；发版门禁优先使用本地受控页面和
`about:blank`，外部站点只作补充观察，导航超时或网络不可达时记录 SKIP，并执行对应受控页面用例

### 0.3 执行流程

```
for each tool chapter:
    for each case (按 ID 顺序):
        判断必跑、条件或 KNOWN-LIMIT 状态
        条件用例的前置条件不具备 → 标记 SKIP 并记录原因
        否则执行"操作"里的 MCP 调用
        按"断言"逐条验证
        失败 → 标记 FAIL 并记录证据；不阻断其他用例（非 fail-fast）
    输出本章 PASS / FAIL / SKIP 清单
最后汇总全部 FAIL 和 SKIP 用例 ID
```

### 0.4 清理

- 每章结束：用 `manage closePage` 关掉本章创建的测试 tab
- cookie：只删 `mcp_test_` 前缀的测试 cookie
- localStorage / storage：每次在测试 tab 里做，关 tab 即清

---

## 0.5 通过标准总则

- 未标注状态的用例是必跑用例，必须 PASS
- 标注 `状态：条件` 的用例仅在列出的前置条件不具备时允许 SKIP，并在当前会话或临时结果中记录缺失条件
- 标注 `状态：KNOWN-LIMIT` 的用例必须在附录 A 登记，按登记条件验收
- 任意 FAIL、未声明的 SKIP 或缺少明确理由的 SKIP 都阻止发版
- **成功用例**：返回 `success=true`、关键字段非空、页面 DOM 符合断言中的具体值
- **错误用例**：抛 Error 或响应带 `error`，错误消息必须包含用例指定的关键词子串
- **行为断言**：形如“注入监听器读取 event.buttons=2”，必须验证具体位置和具体值
- **快照式断言**：截图或 HTML 用例可接受“文件生成、大小 > 0、格式正确”，不做像素 diff

---

## 0.6 用例 ID 规则

```
{tool}-{action|type}-{NN}[-变体]
```

例：

- `browse-list-01`
- `input-click-03-actionable`
- `input-keydown-05-modifier-commands`
- `extract-screenshot-02-full-page`
- `err-stealth-commands-01`

FAIL 时只需报 ID + 失败断言即可

### 0.7 隔离自动回归

无需连接真实浏览器的行为回归使用以下命令：

```bash
npm test
npm run test:extension
```

验收标准：

- server smoke 必须通过 SDK stdio transport 完成 initialize 和 tools/list，并精确返回
  `browse`、`input`、`extract`、`wait`、`cookies`、`logs`、`evaluate`、`manage` 八个工具
- Extension 页面创建保留默认 30 秒加载等待与 5 秒 RPC 传输余量，显式 `timeout=0` 不替换成默认值
- `open`、`back`、`forward`、`refresh`
  从请求入口起共用 timeout，页面选择、队列、协议、加载、Challenge、诊断和恢复不重新开始等待；导航 RPC 不额外增加传输余量，零预算不派发导航
- 过期队列不执行 handler；解除前序阻塞后不产生迟到导航，后续请求仍在前序实际动作结束后执行
- 导航传输超时且结果未知时保留 `actionExecuted="unknown"`、`actionStatus="unknown"` 和
  `retryable=false`，不重放动作；after 只接受实时快照，无法取得时为 null 并含 contextError
- 目标恢复预算耗尽时清除本地临时选择、单独报告恢复失败并保留主动作结果；Challenge 准备、检查降级与点击阶段预算耗尽后不继续派发后续动作
- Challenge 点击、detach 和检查 RPC 携带剩余 deadline；分别阻塞队列和页面校验，到期后不调用 handler 或原生注入、detach
- 系统鼠标在路径移动、悬停、窗口读取和 fallback 之间耗尽预算后，不再启动后续进程
- CDP 按下响应超时时向原连接、原 session 尝试释放，目标选择变化不改变清理对象；释放失败保留原失败并有可见日志
- 只读 Challenge 检查超时保留主动作状态并返回 `CHALLENGE_TIMEOUT`；未知点击返回 `TIMEOUT`、已知主动作状态、
  `verificationStatus="unknown"`、`verificationActionExecuted` 和 `retryable=false`，不重放动作
- CDP 历史等待接受当前 session 主 frame 的 BFCache 恢复、同文档或 load 完成事件，不接受普通 frame
  commit、子 frame 或其他 session 的完成事件，完成或失败后清理监听器
- CDP 导航只接受当前主 frame loader 的目标生命周期事件；同文档 `networkidle`
  必须等待导航后发起的请求结束并持续静默 500ms
- Extension 跨文档导航只接受本次主文档的 `documentId`；同文档导航还必须匹配动作前的 `documentId`
  和规范化后的目标 URL；事件先完成后 action 失败仍须返回 action 错误
- Extension evaluate 必须等待 Promise；显式 timeout 到期后，未完成的 Promise 返回 `Evaluation timeout after <N>ms`
- Chrome scripting 注入参数必须可 JSON 序列化，普通读取和 iframe 定位不传入 `undefined`；分别验证缺省参数、
  `matchIndex=0` 和 `timeout=0`，未指定 URL 时允许读取，实际 URL 不匹配时仍拒绝读取
- 连接策略变化必须立即取消 health check、CONNECTING WebSocket 和重连 timer；旧 socket 的 close 不能删除同端口的新连接
- fallback console 并发读取必须按 tab 串行并原子清空注入缓冲；Service
  Worker 重启后 debugger 恢复仍须卸载旧 hook，同一日志不重复，页面后装的 console wrapper 不被覆盖
- 超过 60 秒但未收到 `loadingFinished` 或 `loadingFailed` 的请求仍保持 pending；容量丢失或 debugger
  detach 后，`networkidle` 必须保持 timeout，直到新 root Document 开始或 tab cleanup
- PNG 解码必须拒绝重复 IHDR、IEND 后附加 chunk、超量解压和 scanline 缺失，并保留合法 RGB/RGBA 输入
- `tmp:` 输出位于带归属标记的单次 server 会话目录，超过 256 项或 128 MiB 时拒绝写入；成功写入 `tmp:` 的响应包含
  `retention` 清理条件，`cwd:`
  响应不包含；启动清理只删除归属已确认、超过 24 小时且所属进程已退出的会话，不删除旧版文件或 `cwd:` 文件
- 输出路径中的 Windows
  ADS、保留设备名、非法字符及组件末尾空格/点号必须在创建目录前被拒绝；Windows 上文件内容写入前必须验证私有 DACL，缺少 PowerShell 或校验失败时返回
  `privacy_not_enforced_on_windows`

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
11. [npm 发布包](#11-npm-发布包)

---

## 1. browse

### browse-launch-01

- 状态：条件，仅在独立测试浏览器环境中且当前没有可复用浏览器时执行
- 前置：该环境不包含用户窗口、tab 或登录态
- 操作：`browse { action: "launch" }`
- 断言：`success=true`，并返回新浏览器的连接模式
- 载体：N/A
- 清理：关闭本用例启动的独立测试浏览器

### browse-connect-01

- 前置：Chrome 已开启且 Extension 自动连接，CDP 精确连接只在另有独立调试实例时测试
- 操作：`browse { action: "connect" }`；需要验证 CDP 时另行调用 `browse { action: "connect", port: 9222 }`
- 断言：不带 `port` 时 `mode="extension"`，并返回
  `extension.helloReceived=true`、`extension.bundleStatus="match"`，活动 hash 与预期 hash 相同；带 `port` 时
  `mode="cdp"`
- 载体：N/A
- 备注：不带 `port` 的 `connect` 回到 Extension。只有显式传 `port` 才选择 CDP；`legacy`
  表示旧 Extension 未上报 hash，`stale` 表示浏览器仍在运行旧 bundle，这两种状态都不阻断自动连接

### browse-list-01

- 前置：已连接
- 操作：`browse { action: "list" }`
- 断言：
    - `success=true`
    - `targets` 是非空数组
    - 每个元素包含 `targetId / type / url / title / mode / managed / isActive / windowId / index`
    - 默认 `details=summary`，Extension 返回窗口关系，包含
      `windowCount / focusedWindowId / activeTargetId / windows[].targetIds`
    - 窗口成员 ID 按 index 顺序排列，不重复完整 tab 对象，完整原生属性通过 `details=full` 获取
    - `targetIds` 和 `managedOnly=true` 筛选页面及所属关系，保留 revision/managed 与 false 原生值
    - favicon data URL 不出现在响应中，完整结果标为 `favIconInline=true`；列表不导航、激活或读取正文
- 载体：N/A

### browse-list-03-summary-filter

- 前置：同一测试窗口内有受控与已 release 的自有页面，包含分组和原生 false 属性，至少一个页面的 favicon 为 data URL
- 操作：分别请求缺省 list、`details=full`、`targetIds=[<T>]`、`managedOnly=true` 及两种筛选组合
- 断言：缺省摘要包含 targetId/managed/revision，完整模式保留原生 false 属性；窗口以 targetIds 引用页面，不重复完整对象；筛选后窗口和分组只引用返回页面，total 计数保留全集数量；data
  URL 不内联；不读取正文或改变导航、焦点

### browse-attach-01-background

- 前置：用 `manage newPage` 创建 managed 测试 tab T，并从 browse list 取得 T 的 targetId
- 操作：`browse { action: "attach", targetId: <T>, activate: false }`
- 断言：`success=true`，`activated=false`，后续工具 `manage newPage` 仍可工作
- 载体：test-page
- 清理：关闭 T

### browse-attach-02-activate

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：agent 在该环境中用 newPage 创建测试 tab，不存在用户窗口、tab 或登录态
- 操作：`browse { action: "attach", targetId: <testTabId>, activate: true }`
- 断言：`success=true`，`activated=true`，该测试 tab 成为活动页面
- 载体：test-page
- 清理：关闭测试 tab

### browse-open-01

- 前置：当前 attach 到某 test tab
- 操作：`browse { action: "open", url: "about:blank", wait: "load" }`
- 断言：`success=true`，`url` 字段为 `about:blank`
- 载体：N/A

### browse-open-03-diagnostics-first-page

- 前置：当前没有 attach 页面，或 attach 状态为空
- 操作：`browse { action: "open", url: "about:blank", wait: "load", diagnostics: true }`
- 断言：`success=true`，响应含 `diagnostics.console` 和 `diagnostics.failedRequests`
  数组，首次自动创建页面时也返回diagnostics
- 载体：N/A

### browse-open-02-wait-networkidle

- 前置：attach 到 test tab

- 操作：

    ```text
    browse {
        action: "open",
        url: "file:///<repo>/mcp-chrome/extension/test-page.html#networkidle",
        wait: "networkidle"
    }
    ```

- 断言：`success=true`，`url` 以 `file:///` 开头且包含 `#networkidle`，返回耗时包含 networkidle 静默等待
- 载体：test-page

### browse-back-01

- 前置：测试 tab open 到 `file:///<repo>/mcp-chrome/extension/test-page.html#page-a` → 再 open 到
  `file:///<repo>/mcp-chrome/extension/test-page.html#page-b`，形成两页历史
- 操作：`browse { action: "back" }`
- 断言：`success=true`，当前 URL 回到 `#page-a`
- 载体：test-page
- 备注：`chrome.tabs.goBack` 明确返回无历史错误时，只在可注入且非错误页的文档上尝试
  `history.back()`；其他原生错误不触发脚本

### browse-forward-01

- 前置：接 `browse-back-01` 之后
- 操作：`browse { action: "forward" }`
- 断言：`success=true`，当前 URL 回到 `#page-b`
- 载体：test-page

### browse-history-errors-01

- 载体：Extension handler 单测，`npm run test:extension`
- 操作：对 back/forward 分别模拟普通页及 `chrome://`
  页的原生导航成功、无历史、普通原生错误；无历史分支覆盖普通文档、`chrome://`、浏览器错误页、不存在的主 frame 和注入时文档变为错误页
- 断言：原生成功不注入脚本；仅明确无历史且文档可注入时执行一次页面历史；受限 URL、错误页和不存在的主 frame 不注入，无历史返回
  `navigated=false`；其他原生失败保留原错误；注入拒绝保持失败，失败后定时器和导航监听立即清理

### extension-operation-errors-01

- 载体：Extension handler 单测，`npm run test:extension`
- 操作：让 `debugger_send` 返回 `Cannot find context with specified id`；对
  `get_text`、`viewport_metrics`、`challenge_inspect` 和截图尺寸预读分别模拟注入 Promise 拒绝，覆盖
  `Frame with ID 0 is showing error page` 与 `Cannot access a chrome:// URL`；每个入口重复普通程序异常负例
- 断言：这些浏览器条件均抛出
  `ExpectedOperationError`，保留错误消息，每次只执行一次调用、不返回假成功；截图尺寸预读失败后不附加 debugger；后台按既有策略记录 warning 并发送失败响应，真实程序异常保留原错误对象
- 实际浏览器验收：只在受控测试页制造导航竞态或网络错误，检查失败响应和 Extension console，不在用户页面上操作

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
- 操作：`browse { action: "close", targetId: <T> }`
- 断言：`success=true`，再 `browse list` 找不到该 targetId
- 载体：test-page
- 备注：Extension 和 CDP 模式都只关闭 `targetId` 指定的页面

### browse-close-02-target-required

- 前置：已连接
- 操作：`browse { action: "close" }`
- 断言：返回 `INVALID_ARGUMENT`，消息包含 `targetId`
- 载体：N/A

### browse-managed-guard-01

- 前置：用 `manage newPage` 创建测试 tab T，记录原 URL，再执行 `manage releasePage targetId=<T>` 并确认
  `managed=false`，最后 `browse attach targetId=<T> activate=false`
- 操作：`browse { action:"open", url:"about:blank" }`
- 断言：返回 `UNMANAGED_TAB`，T 的 URL 保持原值，建议使用 managed=true 测试 tab 或 manage newPage
- 载体：test-page
- 清理：执行 `manage adoptPage targetId=<T>` 后关闭 T

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

    ```text
    cookies {
        action: "set",
        name: "mcp_test_b",
        value: "2",
        url: "https://mcp-chrome.test/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        expirationDate: <Math.floor(Date.now() / 1000) + 3600>
    }
    ```

- 断言：读回后 value、secure、httpOnly、sameSite、expirationDate 一致；`expirationDate` 必须是 Unix 秒级时间戳
- 清理：`cookies delete name=mcp_test_b url=https://mcp-chrome.test/`

### cookies-delete-01

- 前置：先 set mcp_test_c 到 `https://mcp-chrome.test/`
- 操作：`cookies { action: "delete", name: "mcp_test_c", url: "https://mcp-chrome.test/" }`
- 断言：`success=true`，再 get 找不到
- 载体：任意

### cookies-clear-01-domain-name

- 前置：先 set `mcp_test_d` 到 `https://mcp-chrome.test/`
- 操作：`cookies { action: "clear", domain: "mcp-chrome.test", name: "mcp_test_d" }`
- 断言：`success=true`，之后 `cookies get domain=mcp-chrome.test name=mcp_test_d` 不含该 cookie
- 载体：任意
- 清理：无

### cookies-clear-02-scope-required

- 前置：任意 managed test tab
- 操作：`cookies { action: "clear", name: "mcp_test_d" }`
- 断言：返回 `INVALID_ARGUMENT`，消息包含 `url 或 domain`
- 载体：任意

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

### evaluate-empty-args-01

- 前置：独立测试页和其 iframe，Extension precise/stealth 与独立 CDP 模式可用
- 操作：对返回可序列化值的零参函数显式传 `args=[]`；对普通表达式省略 args；iframe 使用相同输入
- 断言：空数组调用函数一次并返回结果，省略 args 不调用裸函数；CDP 和 Extension 主 frame
  precise 使用 callFunctionOn，stealth 与 iframe 的表达式为零参调用，非空参数继续传递

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

### evaluate-precise-07a-frame-identity

- 前置：attach 到含 `iframe#test-frame` 的 managed HTTP tab，增加另一个 srcdoc iframe，使两个 frame URL 都为
  `about:srcdoc`，记录 `iframe#test-frame` 在 `document.querySelectorAll('iframe, frame')` 中的索引
- 操作：分别以 `frame:"iframe#test-frame"` 和上一步得到的数字索引读取 `#frame-btn` 文本
- 断言：两次都返回 `Frame Button`，不会命中其他 frame；所选 DOM iframe 无法映射到唯一 frameId 时返回
  `FRAME_IDENTITY_UNAVAILABLE`，不得按 `webNavigation` 顺序选择 frame
- 载体：独立 managed test tab

### evaluate-precise-07b-frame-diagnostics

- 前置：自有 managed HTTP tab，包含唯一的非空 iframe、普通 div 和独立计数器；先记录 DOM iframe 索引与正常文本
- 操作：分别用不存在的 iframe selector、非法 iframe selector、普通 div selector 和越界索引调用
  `evaluate`，脚本仅增加自有计数器
- 断言：分别返回 `FRAME_NOT_FOUND`、`INVALID_FRAME_SELECTOR`、`FRAME_NOT_IFRAME` 和 `FRAME_NOT_FOUND`，context 的
  `phase=frame_resolution` 与 `selectionStatus` 对应，脚本未执行，计数器不变
- 操作：在已正确定位的 iframe 内通过 `extract(type=text)` 使用非法元素 selector，再读取正常元素
- 断言：非法元素 selector 返回 `INVALID_SELECTOR`，保留 `injection` 或 `script_result` 阶段和 `pageContext.frameContext`
  的 DOM 索引、frame ID、可取得的 documentId；正常提取仍返回原文本，不选择其他 frame
- 断言：frame URL 诊断不含认证、query 或 fragment，长度不超过 500 字符；data/javascript URL 只返回协议，无法解析时明确
  `url=null`、`urlStatus=unavailable`
- 回归：Extension
  finding-regressions 分别验证无结果、context 失效、注入拒绝、脚本错误、合法空文本/空数组/null 属性和 void 调用；Server 回归验证错误类型、frame 信息及页面作用域恢复，不以无结果断定 selector 非法，不重放脚本
- 载体：自有 iframe fixture
- 清理：仅删除本次增加的 fixture

### evaluate-precise-08-stale-default-no-replay

- 前置：在独立测试浏览器 attach 到本任务 managed test-page，使用
  `manage { action: "activatePage", targetId: "<测试页 ID>" }` 激活该页，并通过 `evaluate` 确认
  `document.visibilityState === "visible"`，后台计时节流不满足本用例前置
- 前置：在主框架执行以下一次性测试前置，等待目标脚本首次进入 1000ms 等待后，才安排 300ms 重载，使用
  `startedAt`、`reloadedAt` 核对时序，跨工具调用的调度间隔不作为 context 销毁证据

    ```javascript
    ;(() => {
        window.__mcp_stale_side_effect = 0
        window.__mcp_stale_fixture = { startedAt: null, reloadedAt: null }
        const frame = document.getElementById('test-frame')
        const source = frame.srcdoc
        const child = frame.contentWindow
        const nativeTimeout = child.setTimeout
        child.setTimeout = function (callback, delay, ...args) {
            if (delay !== 1000) {
                return nativeTimeout.call(child, callback, delay, ...args)
            }
            child.setTimeout = nativeTimeout
            window.__mcp_stale_fixture.startedAt = Date.now()
            const timer = nativeTimeout.call(child, callback, delay, ...args)
            window.setTimeout(() => {
                window.__mcp_stale_fixture.reloadedAt = Date.now()
                frame.srcdoc = source
            }, 300)
            return timer
        }
        return { ready: true }
    })()
    ```

- 操作：前置返回 `ready=true` 后执行以下调用，不传 `staleContextRetry`

    ```text
    evaluate {
        frame: "iframe#test-frame",
        timeout: 4000,
        script: `(async () => {
            parent.__mcp_stale_side_effect++;
            await new Promise(resolve => setTimeout(resolve, 1000));
            return parent.__mcp_stale_side_effect;
        })()`
    }
    ```

- 断言：返回
  `FRAME_STALE_CONTEXT`，`staleContextRetry === "never"`，`retryAttempted === false`、`actionExecuted === true`、
  `actionStatus === "unknown"`；在主框架读取 `window.__mcp_stale_side_effect === 1`，证明有副作用脚本没有自动重放
- 断言：主框架的 `__mcp_stale_fixture.startedAt` 与 `reloadedAt`
  均非空，`0 < reloadedAt - startedAt < 1000`，重载发生在目标脚本等待期间
- 载体：独立 managed test-page
- 清理：重新载入独立页，移除测试前置；目标脚本没有开始等待时也必须恢复原 setTimeout

### evaluate-precise-09-stale-readonly-retry

- 前置：重新载入独立 managed test-page，按上一用例确认测试页可见，执行一次性测试前置，确认
  `ready=true`，不要预先启动重载计时

- 操作：执行

    ```text
    evaluate {
        frame: "iframe#test-frame",
        timeout: 5000,
        staleContextRetry: "readOnly",
        script: `(async () => {
            await new Promise(resolve => setTimeout(resolve, 1000));
            return document.getElementById("frame-btn").textContent;
        })()`
    }
    ```

- 断言：`success=true`，`result === "Frame Button"`，`staleContextRetry === "readOnly"`，`retryAttempted === true`，
  `frameContext.executionContextId` 非空；脚本本身不写页面状态
- 断言：主框架的 `__mcp_stale_fixture.startedAt` 与 `reloadedAt`
  均非空，`0 < reloadedAt - startedAt < 1000`；副作用计数保持为 0
- 载体：独立 managed test-page
- 清理：重新载入独立页，移除测试前置

### evaluate-precise-10-scriptFile

- 前置：在受控临时目录准备 `mcp-eval.js`
- 操作：`evaluate { scriptFile: "tmp:mcp-eval.js" }`
- 断言：`result === 42`
- 载体：任意

### evaluate-precise-11-output

- 操作：`evaluate { script: "'hello world'", output: "tmp:mcp-eval-out.txt" }`
- 断言：文件存在，内容为 `hello world`（不带引号）
- 载体：任意

### evaluate-output-large-object-01

- 前置：自有无凭证页面、全新输出文件、独立计数器；不要重复失败脚本
- 操作：分别用表达式和 `args=[]` 返回 `{ fixture: '字😀'.repeat(400000), count: ++fixtureCounter }`，显式指定 `output`
- 断言：文件 JSON 和自有数据完全一致，UTF-8 字节数正确、私有权限有效，MCP 响应只返回路径与状态，不内联大对象，每次调用计数器只增加一次
- 对照：新计数器、不指定 `output` 的 Extension precise 主 frame 调用返回
  `EVALUATE_RESULT_TOO_LARGE`，当前字符上限为 1000000；显式文件输出超过 16
  Mi 字符预算时拒绝，上限为 16777216，深度 8、节点 2000 与循环对象拒绝保留
- 断言：拒绝后
  `actionExecuted=true`、`actionStatus=completed`、`failureStage=output`、`retryable=false`，已有文件不变，无自动重放
- 回归：现有 finding-regressions 覆盖协议 fallback 的参数传播及远端对象释放；CDP、stealth 和 iframe 的既有文件输出分别验证，不用 mock 代替公开 MCP
- 载体：自有大对象 fixture
- 清理：仅删除本次输出

### evaluate-output-quota-01

- 前置：独立、有任务归属标记的临时环境；只填充本次 server 的输出目录，不使用用户已有目录
- 操作：分别使临时条目和字节配额达到上限，通过公开 `evaluate` 执行带唯一计数器的自有常量脚本并指定 `tmp:` 输出
- 断言：返回 `TEMP_OUTPUT_QUOTA_EXCEEDED`，context 包含
  `limits`、`usage`、`remaining`、`requested`、`projected`；完整扫描时占用和剩余准确，提前停止时
  `usage.complete=false`、占用为下界，`remaining`/`projected` 为 null
- 断言：`actionExecuted=true`、`actionStatus=completed`、`failureStage=output`、`retryable=false`，计数器仅增加一次，已有文件内容不变，未创建拒绝路径的目录
- 回归：现有 `finding-regressions.test.js`
  覆盖条目、字节、单文件、覆盖失败、覆盖同大小文件和部分扫描；成功状态不能代替公开 MCP 验收
- 恢复：使用 `cwd:` 指定仓库内路径保存后续输出，不自动重放已执行脚本
- 载体：隔离输出 fixture；缺少独立临时环境时为条件用例
- 清理：仅删除本次 fixture，保留用户输出

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

- 前置：用 `manage newPage` 创建 `test-csp-page`，提取 `#csp-marker` 并确认页面载入完成
- 操作：`evaluate { script: "1+1", mode: "stealth" }`
- 断言：返回错误，消息包含 `Content Security Policy`、`CSP`、`blocked` 或 `Cannot access`，不得返回 `result === 2`
- 载体：test-csp-page
- 清理：关闭测试 tab

### evaluate-tabId-01

- 前置：用 `manage newPage` 创建 managed 测试 tab T1 和 T2，保持 attach 在 T1，并把两个页面标题设为不同值
- 操作：`evaluate { script: "document.title", tabId: "<T2>" }`
- 断言：`result` 等于 T2 的标题，T1 的标题保持不变
- 载体：test-page
- 清理：关闭 T1 和 T2

### scope-tabId-01-backend-consistency

- 前置：创建两个 managed test tab T1 和 T2，当前 attach 保持在 T1；T1、T2 的 title 和 `#text-input`
  初始值不同，在 T2 触发一条唯一 console warning
- 操作：分别对 T2 的 `tabId` 调用：
    1. `input` 给 `#text-input` 输入唯一值，并用 `postCondition.script` 检查同一值
    2. `wait for=element` 等待 T2 独有 selector
    3. `logs type=console` 读取 T2 的唯一 warning
    4. `extract type=text` 读取 T2 独有文本
- 断言：input 返回 `mode === "extension"` 且 post-condition
  matched，wait、logs、extract 都命中 T2；T1 的 title、输入值和页面文本不变；每项操作后分别对 T1、T2 提取目标元素，确认没有改变默认目标或写错 tab
- 截图条件：仅在两个测试页均具备可用 compositor
  frame 时增加截图核验；后台 Extension 页明确返回不可见错误时记录原因，不激活用户页面，目标隔离断言仍必须执行
- 载体：两个 test-page managed tab
- 清理：关闭 T1、T2

### evaluate-diagnostics-01

- 前置：自有 HTTP 测试页面的 `/mcp_diag_404` 明确返回 404
- 操作：`evaluate { script: "(async () => { console.warn('mcp_diag_warn'); const response = await fetch('/mcp_diag_404'); await response.text(); return response.status })()", diagnostics: true }`
- 断言：返回 `diagnostics.console` 含 warning，`diagnostics.failedRequests` 含失败请求摘要
- 载体：test-page

### evaluate-non-serializable-01-dom-node

- 操作：`evaluate { script: "document.body" }`
- 断言：返回 `isError=true`，`error.code === "NON_SERIALIZABLE_EVALUATE_RESULT"`，`error.suggestion` 含 `outerHTML` 或
  `textContent`，并返回 `actionExecuted === true`、`actionStatus === "completed"`、`failureStage === "output"`、
  `retryable === false`
- 载体：test-page

---

## 4. extract

### extract-text-01-whole-page

- 前置：attach 到 test-page
- 操作：`extract { type: "text" }`
- 断言：
    - `success=true`
    - `content` 字符串包含 "MCP Chrome 测试页面"、"ID 定位按钮"、"拖拽我"
- 载体：test-page

### extract-text-02-css

- 操作：`extract { type: "text", target: { css: "#btn-id" } }`
- 断言：`content === "ID 定位按钮"`
- 载体：test-page

### extract-text-03-role

- 操作：`extract { type: "text", target: { role: "button", name: "TestId 定位按钮" } }`
- 断言：`content === "TestId 定位按钮"`
- 载体：test-page

### extract-text-04-text

- 操作：`extract { type: "text", target: { text: "文本链接测试" } }`
- 断言：`content` 包含 "文本链接测试"
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
- 断言：`content === "TestId 定位按钮"`
- 载体：test-page

### extract-text-10-xpath

- 操作：`extract { type: "text", target: { xpath: "//button[@id='btn-id']" } }`
- 断言：`content === "ID 定位按钮"`
- 载体：test-page

### extract-text-11-nth

- 前置：test-page 有多个 `<button>`
- 操作：`extract { type: "text", target: { css: "button", nth: 1 } }`
- 断言：定位到 **全文档第 2 个** button（nth 是 `document.querySelectorAll(css)` 的索引，不是 section 内的索引）
- 载体：test-page

### extract-text-12-css-text-combo

- 操作：`extract { type: "text", target: { css: "button", text: "单击测试" } }`
- 断言：`content === "单击测试"`
- 载体：test-page

### extract-text-13-coords

- 前置：用 `evaluate` 执行以下脚本，获取 `#btn-id` 的中心坐标

    ```js
    ;(() => {
        const rect = document.getElementById('btn-id').getBoundingClientRect()
        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
        }
    })()
    ```

- 操作：`extract { type: "text", target: { x: <X>, y: <Y> } }`
- 断言：`content === "ID 定位按钮"`
- 载体：test-page

### extract-text-14-rendered-region

- 前置：使用自有测试页，在一个 HTML 区域放入可见的中文与 emoji、`style`、不执行的 `script type="application/json"`、
  `display:none` 子节点及 SVG 文本，再准备一个 `visibility:hidden` 文本节点
- 操作：分别提取整页、`target={css:"body"}` 和区域；通过独立 `evaluate` 取得对应 `innerText`
  作对照，显式选择隐藏节点及 SVG 节点，再选择 `innerText` 为空的节点
- 断言：HTML 读取与对应 `innerText` 相同，渲染区域不含后代样式、脚本源码或隐藏后代文本；显式选择的 `display:none`
  节点遵循浏览器 `innerText` 规则，SVG 文本保留，空 `innerText` 不回退到 `textContent`
- 验证：CDP 和 Extension 分别执行；Extension 包含 selector/ref 路径，缺失或已断开的 ref 保持空结果，URL 校验仍有效
- 载体：自有测试页，新增测试节点使用后删除

### extract-html-01-whole

- 操作：`extract { type: "html" }`
- 断言：`content` 含 `<html`、`<body`、`id="btn-id"`
- 载体：test-page

### extract-html-02-element

- 操作：`extract { type: "html", target: { css: "#btn-id" } }`
- 断言：`content` 以 `<button` 开头，含 `id="btn-id"`
- 载体：test-page

### extract-html-03-images-info

- 前置：test-page region 8 有 #test-image
- 操作：`extract { type: "html", target: { css: "body" }, images: "info" }`
- 断言：返回的 `images` 数组含 `#test-image` 的 src/alt/尺寸， **不含 base64 data**
- 载体：test-page

### extract-html-04-images-data

- 操作：`extract { type: "html", target: { css: "body" }, images: "data", output: "cwd:test-output/mcp-test-html" }`
- 断言：`./test-output/mcp-test-html/index.json` 存在且记录 img 元信息
- 载体：test-page
- 清理：`rm -rf ./test-output/mcp-test-html`
- 备注：test-page 使用 data URI 图片，不会生成独立图片文件；真实 URL 图片会写入 images/ 子目录

### extract-attribute-01

- 操作：`extract { type: "attribute", target: { css: "#test-link" }, attribute: "href" }`
- 断言：`value === "https://example.com"`
- 载体：test-page

### extract-attribute-02-not-found

- 操作：`extract { type: "attribute", target: { css: "#btn-id" }, attribute: "data-nonexistent" }`
- 断言：`value === null`
- 载体：test-page

### extract-screenshot-01-viewport

- 状态：条件，仅在独立 CDP/headless 测试浏览器，或不含用户资产的独立 Extension 测试窗口中执行
- 前置：CDP/headless 模式可保持后台；Extension 模式需要测试 tab 是独立测试窗口内的活动 tab，页面载入后等待约 800ms
- 操作：`extract { type: "screenshot", output: "cwd:test-output/mcp-shot.png" }`
- 断言：
    - `success=true`
    - `./test-output/mcp-shot.png` 存在，`file` 命令识别为 PNG，尺寸 > 10KB
- 载体：test-page
- 清理：`rm ./test-output/mcp-shot.png`
- 能力声明：Extension 与 CDP 的 `metadata.capabilities.hiddenTabScreenshot` 均为 false，inline 与文件输出相同
- 隐藏页：在独立 Extension 测试环境创建后台页，回读 `document.visibilityState=hidden` 后截图，返回
  `HIDDEN_TAB_SCREENSHOT`；再次回读仍为 hidden，默认目标不变，不通过激活用户窗口或用户 tab 规避
- 窗口对照：仅在自有独立浏览器创建 `focused=false` 的窗口，核对页面 active 与窗口 focused 的原生状态，再读取
  `document.visibilityState`；visible 页截图后实际查看图片，hidden 页按明确错误验收，不将 active 当作可见性证明

### extract-screenshot-02-full-page

- 状态：条件，与 `extract-screenshot-01-viewport` 使用相同的独立测试环境
- 操作：`extract { type: "screenshot", fullPage: true, output: "cwd:test-output/mcp-fs.png" }`
- 断言：文件尺寸 > viewport-only 截图（test-page 总高明显大于视口）
- 载体：test-page

### extract-screenshot-03-jpeg

- 状态：条件，与 `extract-screenshot-01-viewport` 使用相同的独立测试环境
- 操作：`extract { type: "screenshot", format: "jpeg", quality: 80, output: "cwd:test-output/mcp-s.jpg" }`
- 断言：`file ./test-output/mcp-s.jpg` 识别为 JPEG
- 清理：`rm ./test-output/mcp-s.jpg`

### extract-screenshot-04-element

- 状态：条件，与 `extract-screenshot-01-viewport` 使用相同的独立测试环境
- 操作：`extract { type: "screenshot", target: { css: "#btn-id" }, output: "cwd:test-output/mcp-el.png" }`
- 断言：文件存在，尺寸 < 全页截图（仅包含按钮）；目标元素滚动后仍应截到元素本身，不应返回空白区域
- 清理：`rm ./test-output/mcp-el.png`

### extract-screenshot-05-scale

- 状态：条件，与 `extract-screenshot-01-viewport` 使用相同的独立测试环境
- 操作：`extract { type: "screenshot", fullPage: true, scale: 0.5, output: "cwd:test-output/mcp-half.png" }`
- 断言：文件尺寸显著小于 scale=1 的 full-page 截图
- 清理：`rm ./test-output/mcp-half.png`

### extract-screenshot-06-clip

- 状态：条件，与 `extract-screenshot-01-viewport` 使用相同的独立测试环境
- 操作：

    ```text
    extract {
        type: "screenshot",
        clip: { x: 0, y: 0, width: 200, height: 120 },
        output: "cwd:test-output/mcp-clip.png"
    }
    ```

- 断言：返回 `metadata.clip` 与入参一致，`metadata.width/height/byteSize/format/dimensionSource/capabilities`
  存在，文件存在且尺寸小于全页截图
- 清理：`rm ./test-output/mcp-clip.png`

### extract-screenshot-07-compare

- 状态：条件，与 `extract-screenshot-01-viewport` 使用相同的独立测试环境
- 前置：attach 到 managed test-page，点击 `#compare-reset-btn` 后调用
  `extract { type: "screenshot", target: { css: "#compare-box" }, output: "cwd:test-output/mcp-before.png" }`

- 操作：点击 `#compare-toggle-btn` 后调用

    ```text
    extract {
        type: "screenshot",
        target: { css: "#compare-box" },
        compareWith: "cwd:test-output/mcp-before.png",
        diffOutput: "cwd:test-output/mcp-diff.png",
        output: "cwd:test-output/mcp-after.png"
    }
    ```

- 断言：返回 `metadata.comparison.pixelDiffRatio > 0`、`differentPixels > 0`、`totalPixels > 0`，差异图文件存在
- 边界：使用超过 25 MiB 或 12,000,000 像素的 PNG 作为 `compareWith` 时返回明确错误，提示使用 `clip` 或 `scale`
- 清理：`rm ./test-output/mcp-before.png ./test-output/mcp-after.png ./test-output/mcp-diff.png`

### extract-diagnostic-bundle-01-capabilities

- 前置：分别使用自有 Extension 与 CDP 测试页，不读取业务日志或认证材料
- 操作：`extract { type: "diagnosticBundle", targetId: T }`，再以相同参数增加
  `output: "cwd:test-output/mcp-diagnostic.json"`，读取返回路径的 JSON
- 断言：inline 的 `summary.capabilities` 与文件的 `capabilities` 相同，
  `screenshot=true`、`hiddenTabScreenshot=false`、`frames=true`，两种模式结果一致
- 页面状态：显式目标 T 与默认目标不同，读取后默认目标保持不变，不导航、激活或聚焦页面
- 清理：只删除本用例新建的诊断文件

### extract-state-01-whole

- 操作：`extract { type: "state" }`
- 断言：返回结构 `{ state: { pageContent, viewport, interactiveElements } }`，`pageContent` 非空字符串（含 accessibility
  tree 文本），`viewport.width/height` 为数字，`interactiveElements`
  含 role/name/selector/visible/disabled/bounds/covered
- 密码保护：仅在自有页写入自造 password sentinel，分别读取整页、指定 password 子树和 `output` 文件， `pageContent` 与
  `interactiveElements[].name`
  均不含密码值；带标签、placeholder 或 title 的密码框保留名称，普通输入值保持可读，实际函数回归以抛错的 password value
  getter 验证自动命名不读取该值
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
- 断言：返回 `snapshot.documents` 数组（CDP `DOMSnapshot.captureSnapshot` 原始结果），含 `nodes` / `layout` /
  `textBoxes`
- 载体：test-page
- KNOWN-LIMIT：Extension 模式下抛 INVALID_ARGUMENT（仅 CDP 支持）

### extract-state-05-domsnapshot-ext-error

- 操作（Extension 模式）：`extract { type: "state", mode: "domsnapshot" }`
- 断言：返回 `error.code === 'INVALID_ARGUMENT'`，message 提示仅 CDP 支持
- 载体：任意

### extract-metadata-01

- 操作：`extract { type: "metadata" }`
- 断言：返回含 `url / title / description / charset / viewport / og / twitter / jsonLd / alternates / feeds / frames`
  （部分字段可 null/undefined），`frames`
  含 index/frameId/parentFrameId/url/title/name/selector/rect，Extension 和 CDP 模式都应返回 frames 数组
- 受控页备注：通过 `manage(pageMetadata, targetId=T, taskHint="owned-task", note="owned-note")`
  设置本任务页面备注，再次提取 metadata，返回实际 `managed` 与
  `metadata.createdBy/createdAt/lastUsedAt/taskHint/note`，创建、备注字段与 `browse list`、`manage pageMetadata`
  相同，最近使用时间可随读取更新；CDP 的 `managed` 返回 false，不要求或调用 Extension-only 的 adoptPage
- 文件与 iframe：传 `output` 后回读文件，字段与 inline 相同；Extension 指定本任务 iframe 时，文档标题属于 iframe，
  `managed` 与备注仍属于页面 T，读取不执行 adopt、导航或激活
- 重载恢复：独立测试浏览器自动重载 Extension 并核对新构建连接身份后，复用原页面和同一 iframe
  selector，连续两次 inline 和一次 `output`
  读取均返回原文档 URL/title，回读文件与 inline 一致，frames 中保留该 iframe 的 selector/rect；不刷新、导航或替换目标
- 实例与失败：另一独立 Server 返回未知创建来源和空备注，不继承原 Server 的任务提示；关闭目标或目标状态读取失败返回错误，不能将缺失状态返回成
  `managed=false` 的成功结果；只读页面的 false 值保留，元信息不授权输入或脚本
- 载体：test-page，不操作业务页面

### extract-frame-01

- 操作：`extract { type: "text", target: { css: "#frame-btn" }, frame: "iframe#test-frame" }`
- 断言：`content === "Frame Button"`
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
- 断言：detail 序列 [1,1,1,2,2,2,3,3,3] + dblclick (detail=2)

### input-click-08-force

- 前置：test-page region 12 应有一个被遮挡的 button（z-index overlay）
- 操作：`input { events: [{type:"click", target:{css:"#covered-btn"}, force:true, forceReason:"验证覆盖层下按钮的强制点击行为"}] }`
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
- 断言：`#textarea.value` 包含换行，split ('\n').length === 2

### input-type-03-contenteditable

- 前置：将本任务 `#edit-contenteditable.textContent` 重置为 `Editable baseline`，记录原文
- 操作：`type` target=#edit-contenteditable，text=`OWNED_INPUT`
- 断言：textContent 包含一次
  `OWNED_INPUT`，移除该 marker 后仍为原文；precise/CDP 在点击建立的光标位置插入，不要求自动移到末尾
- 追加变体：公开 evaluate 聚焦同一元素，使用 Range.selectNodeContents 和 collapse(false) 建立末尾光标，再用不带 target 的 type 输入
  `OWNED_APPEND`
- 断言：textContent 严格等于追加前全文加 `OWNED_APPEND`，原有文本保持；不再次点击改变已建立的光标位置

### input-type-04-delay

- 操作：`type` `text:"abc", delay:50`
- 断言：整个 type 耗时 >= 3 * 50ms = 150ms

### input-type-05-dispatch

- 前置：attach 到 test-page，清空 `#controlled-input`，并把 `data-input-events/data-change-events` 置为 `0`
- 操作：`input { events: [{type:"type", target:{css:"#controlled-input"}, text:"abc", dispatch:true}] }`
- 断言：`#controlled-input.value === "abc"`，`#controlled-result.textContent` 包含 `controlled input: abc`，
  `data-input-events` 大于 0
- 载体：test-page

### input-type-05-controlled

- 前置：attach 到 test-page，清空 `#controlled-input`，并把 `data-input-events/data-change-events` 置为 `0`
- 操作：
  `input { events: [{type:"type", target:{css:"#controlled-input"}, text:"abc", mode:"controlled"}], diagnostics:true }`
- 断言：value 更新并触发 input/change；失败时错误包含 matchCount、activeElement、candidates；diagnostics 字段存在
- 载体：test-page

### input-type-06-crlf-normalize

- 前置：CDP 使用本任务的后台 test-page，以只读 evaluate 记录
  `document.visibilityState === "hidden"`，操作后再次核对，不激活页面
- 操作：在 Extension precise/stealth 与独立 CDP 中，把包含 `line1`、CRLF 和 `line2` 的文本输入已清空的 `#textarea`
- 断言：`textarea.value` 依次包含 `line1`、LF 和 `line2`（CRLF 被归一化为一个 LF）；页面监听到的 keydown/keyup 计数相等
- 后台点击变体（CDP）：点击同一自有页面的按钮，通过页面计数器核对一次点击，页面保持后台
- 位置检查回归：暂停动画帧不阻塞稳定采样；x/y/width/height 任一变化后重试，持续变化在预算内失败
- 阶段预算回归（注册 input 入口）：1000ms 中定位消耗 400ms，后续检查最多取得 600ms；定位、检查或最终坐标读取耗尽预算后，不派发动作，`eventsExecuted=0`、`actionExecuted=false`；预算充足时正常执行
- 计时：分别记录工具总耗时与服务内部预算，工具总耗时包含传输和结果处理，不能单独用于判定阶段预算是否重新起算；阶段预算由注册入口回归核对
- 载体：test-page

### input-type-07-timeout-stop

- 前置：本任务受控 test-page 的 textarea 已清空并获焦，注入 input 计数器；iframe 变体使用本任务创建的唯一 URL
  frame，避免同 URL frame 歧义
- 操作：`timeout=1000`，先输入 20 个 `x`、`delay=100`，再排入 `text="after-timeout"` 的 type 事件；分别验证 Extension
  precise/stealth 主文档和 iframe，以及独立 CDP 主文档
- 断言：返回错误、`eventsExecuted=0`、`actionExecuted=true`、`actionStatus="unknown"`、`retryable=false`，已有文本长度大于 0 且小于 20，不包含
  `after-timeout`；立即读取 value/input 计数，1200ms 后再次读取，两次结果一致，调用不等待全部字符输入完才返回
- 载体：test-page、本任务唯一 URL iframe、独立 CDP 测试会话

### input-type-08-extended-budget

- 前置：本任务 textarea 已清空并获焦，Extension precise 已连接
- 操作：`timeout=45000`，输入 330 个 `x`、`delay=100`
- 断言：整体输入耗时超过 30000ms，仍在本次预算内成功完成，`eventsExecuted=1`、`actionStatus="completed"`，独立读取 value 为全部 330 个字符，没有固定 30000ms
  RPC 超时
- 载体：test-page

### input-type-09-humanize-budget

- 前置：本任务 textarea 已清空并获焦，注入 input 计数器
- 操作：`humanize=true`、`timeout=400`，先输入 100 个 `x`、`delay=100`，再排入 `text="after-timeout"`
  的 type 事件；覆盖 Extension precise、Extension stealth 与独立 CDP
- 断言：返回错误、`eventsExecuted=0`、`actionStatus="unknown"`、`retryable=false`，只留下部分文本，后续 marker 未输入；立即读取 value/input 计数，1200ms 后再次读取，两次结果一致，逐字符输入没有重置整体预算
- 换行对照：重置 textarea 后，在充足预算内用 `humanize=true` 输入 `a\r\nb\rc`，value 必须为
  `a\nb\nc`，CRLF 只产生一个换行
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

### input-select-05-cdp-locator-matrix

- 前置：在独立 CDP 测试会话中启动或连接专用 Chrome，确保 Extension 未接管该会话；打开 test-page，并给 `#edit-input`、
  `#edit-textarea`、`#edit-contenteditable` 写入各自唯一文本
- 操作：对三个元素分别执行 locator target 的 `select`，每次使用唯一 `find` 文本
- 断言：每次 input 响应的 `mode === "cdp"`；input/textarea 的 `selectionStart`、`selectionEnd`
  匹配目标文本，contenteditable的 `window.getSelection().toString()` 等于目标文本；错误或响应中不出现 Extension
  refId 依赖
- 载体：test-page，CDP 模式

### input-replace-03-cdp-locator-matrix

- 前置：延续 `input-select-05-cdp-locator-matrix`，重置三个元素的内容
- 操作：对 `#edit-input`、`#edit-textarea`、`#edit-contenteditable` 分别执行 locator target 的 `replace`
- 断言：每次 input 响应的
  `mode === "cdp"`；input/textarea 的 value 和 contenteditable 的 textContent 都只替换指定 occurrence；用 `extract`
  读取三个目标，并截图确认页面显示值一致
- 载体：test-page，CDP 模式

### input-password-01-failure-redaction

- 前置：在 managed test tab 注入 `input[type=password]#mcp-password`，value 设为
  `password-value-sentinel`，页面和 console 中不写这些 sentinel

- 操作：执行以下调用，其中 `find` 不存在以触发失败

    ```text
    input {
        events: [{
            type: "replace",
            target: { css: "#mcp-password" },
            find: "password-find-sentinel",
            text: "password-replacement-sentinel"
        }],
        diagnostics: true
    }
    ```

- 断言：响应为失败；序列化后的完整响应不包含 `password-value-sentinel`、`password-find-sentinel`、
  `password-replacement-sentinel`，包含 `redacted` 标记或
  `[REDACTED]`；随后提取 password 元素和截图，确认页面仍存在且 value 未被修改
- 载体：test-page

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

- 状态：KNOWN-LIMIT，见附录 A
- 前置：浏览器已授予剪贴板权限，`#text-input` 已全选 "hello"
- 操作：`[{keydown, key:"c", commands:["copy"]}, {keyup, key:"c"}]`，随后切到 #textarea 再 `commands:["paste"]`
- 断言：copy 和 paste 调用均返回成功，不出现二次 `document.execCommand` 导致的 `EDIT_COMMAND_FAILED`；
  `#textarea.value === "hello"`
- 备注：命令成功只表示浏览器接受分发，页面结果以读取 `#textarea.value` 为准；无剪贴板权限时按附录 A 的 KNOWN-LIMIT 验收

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
- 断言：监听器记录序列：mousedown detail=1, mouseup detail=1, click detail=1, mousedown detail=2, mouseup detail=2,
  click detail=2, dblclick detail=2

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
- 预算对照：Extension precise、stealth 和 CDP 分别执行，使用独立测试浏览器中的自有页面；预算充足时点击计数增加 1
- 到期对照：独立读取自有按钮坐标和点击计数，发送 `timeout:1500`、`humanize:true`，事件依次为
  `mousemove`（坐标目标、`steps:1000`）、相同目标的 `click`
  及一个可计数事件；返回 timeout，后续事件不执行，立即读取及公开 `wait`
  1250ms 后再次读取，点击计数均不增加，不等待完整路径完成才返回
- 已移动后超时：`eventsExecuted=0`、`actionExecuted=true`、`actionStatus="unknown"`、`retryable=false`，不把已执行的鼠标移动报告为未执行，不自动重放
- 注册入口回归：模拟时钟使首个移动耗尽预算后，只允许一次移动、不点击；覆盖 humanized
  click/mousemove、普通 click/mousedown、type 的目标聚焦及 CDP 直线分步；另验证定位和 driver 准备消耗后传递剩余时间、RPC/Extension 队列及实际页面脚本拒绝过期派发
- 同类调用方回归：命令与 select/replace 的坐标聚焦到期后不执行后续动作，文本选择的第二次移动到期后不点击且释放 Shift，动作和释放均失败时保留原动作错误；replace 的选区轮询耗尽预算后不更新文本，预算充足时正常替换；CDP
  touchmove 直接与分步移动到期后不执行后续触摸点和事件
- 计时保留端到端测量，服务内部未采集时明确记录，不用模拟时钟结果代替公开验收
- 载体：test-page

### 5.10 timeout / nth

### input-timeout-01

- 操作：`input { timeout: 500, events: [{type:"click", target:{css:"#nonexistent"}}] }`
- 断言：在 500ms+ε 内抛错；Extension 返回 `TARGET_NOT_FOUND` 或 timeout 类错误，未找到目标时 `context` 含
  `locator/matchCount/nth/currentUrl/candidates`；CDP 保留 `ELEMENT_NOT_FOUND` 及 `target/timeout/url` 诊断
- 两端均验证 `eventsExecuted=0`、`actionExecuted=false`，计时记录工具执行时间，另列传输开销

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

- 前置：attach 到 test-page，先调用 `logs { type:"network" }` 启用采集，再执行
  `evaluate { script:"(async()=>{const response=await fetch('/mcp_missing_resource?network-first');const body=await response.text();return {status:response.status,bodyLength:body.length}})()" }`
- 操作：响应体消费完成，或独立观察到该请求的 `loadingFinished/loadingFailed` 后，调用 `logs { type: "network" }`
- 断言：返回数组非空，实际包含本次请求，每项含 url/method/status 或 errorText 中可由当前浏览器提供的值；fetch 返回 Response 不作为请求完成证据
- 刷新对照：首次读取后再次发起唯一 URL 的 fetch，等待同样的完成条件，后续 logs 必须出现该请求，不以旧的页面或 iframe 条目冒充新 fetch
- debugger 不可用对照为条件项：须取得浏览器对当前 Extension 的原生 attach 拒绝，且只读会话证明也失败；只有外部 holder 存在不满足此前置，Chrome 允许多个客户端时记录该条件项未验证，不伪造拒绝或改写原失败
- 满足此前置时：日志 `source="performance"`，浏览器提供响应状态时保留实际状态，并在该来源重复以下增量与清除对照
- 增量对照：连续读取不会重复增加记录或改变已有序列号，字段相同的两次请求仍保留两项；diagnostics 只包含动作后的新增失败请求
- 清除对照：`clear:true` 后读取不再返回已清除记录，随后新 fetch 可取得；不调用网页的
  `clearResourceTimings`，原页面 resource entries 保留，新文档重新读取
- 载体：test-page

### logs-network-02-url-pattern

- 前置：接 `logs-network-01`
- 操作：`logs { type:"network", urlPattern:"*mcp_missing_resource*" }`
- 断言：每项 url 匹配模式

### logs-network-03-failed-request

- 前置：attach 到 test-page，执行 `evaluate { script:"fetch('/mcp_missing_resource').catch(()=>{})" }` 或
  `browse/evaluate diagnostics=true` 触发失败请求
- 操作：`logs { type:"network" }`
- 断言：返回数组含失败请求或 4xx/5xx 请求，字段含 `url/method/status/errorText/timestamp/duration`
  中可由当前浏览器提供的值

### logs-network-04-inline-url-limit

- 前置：通过 image 或 fetch 触发长度超过 2048 的 data URL 网络记录
- 操作：`logs { type:"network" }`
- 断言：对应记录 `url.length === 2048`，`urlLength` 等于原始长度，`urlTruncated === true`
- 操作：`logs { type:"network", output:"tmp:mcp-network-logs.json" }`
- 断言：输出文件中的对应记录保留完整 URL，不含内联截断

### logs-network-05-credential-redaction

- 前置：通过 fetch 触发 URL query 含 `authorization=mcp-auth-sentinel`、`access_token=mcp-token-sentinel` 的请求
- 操作：分别调用
  `logs { type:"network" }`、`logs { type:"network", output:"tmp:mcp-network-redacted.json" }`，并读取 diagnostics 中的 failed
  request
- 断言：内联响应、output 文件和 diagnostics 均不包含两个 sentinel，URL 对应值为 `[REDACTED]`，并返回
  `urlRedacted === true`、原始 URL 长度和 `redactedQueryParameters`

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

- 前置：用 `manage newPage` 创建测试 tab T，再执行 `manage releasePage targetId=<T>` 并确认 `managed=false`
- 操作：`manage { action:"adoptPage", targetId:<T> }`
- 断言：`success=true`，`managedBefore=false`，`managedAfter=true`，再次 `browse list` 中 T 为 `managed=true`
- 验证：不申请 popup 只读权限，执行定向 text/HTML、输入并读取输入框值、evaluate、截图和日志；与新建受控页相同，截图使用可见的自有测试页
- 清理：关闭 T

### manage-releasePage-01

- 前置：先 newPage 创建受控 tab T
- 操作：`manage { action:"releasePage", targetId:<T> }`
- 断言：`success=true`，`managedBefore=true`，再次 `browse list` 中 T 为 `managed=false`
- 验证：窗口、index 和 groupId 保持原值，text/evaluate/input/screenshot/logs 拒绝完整操作，debugger 与 console 采集状态清理；清理被浏览器阻止时权限仍撤销且返回
  `warnings`
- 缓存对照：先记录唯一 console
  marker，仅清浏览器 Runtime 历史后确认工具缓冲仍包含它；release、重新 adopt 后工具不再返回该缓存，结合 Runtime 的真实回放事件区分浏览器历史和工具缓冲
- fallback hook 生命周期为条件项：沿用 `logs-network-01`
  的真实 debugger 拒绝前置，确认 hook 已安装后验证收取日志、release 卸载和原 console 函数恢复，外部连接保持；前置不成立时明确该项未验证，正常 debugger、权限与缓存清理仍必须验证
- 清理：重新 `adoptPage` 后执行 `closePage` 关闭测试 tab

### manage-movePage-01

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：在该环境中先 newWindow 创建测试窗口 W，再 newPage 创建受控 tab T
- 操作：`manage { action:"movePage", targetId:<T>, windowId:<W>, index:0 }`
- 断言：`success=true`，返回 `affected.before/after`，`affected.after.windowId=<W>` 且 `affected.after.index=0`
- 清理：关闭测试窗口或测试 tab

### manage-reorderPage-01

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：在该环境的同一测试窗口内创建两个受控 tab T1/T2
- 操作：`manage { action:"reorderPage", targetId:<T2>, index:0 }`
- 断言：`success=true`，`affected.before.index != affected.after.index`，再次 `browse list` 中 T2 排在 index 0

### manage-pinPage-01

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：在该环境中先 newPage 创建 T
- 操作：`manage { action:"pinPage", targetId:<T> }`
- 断言：`success=true`，`affected.before.pinned=false`，`affected.after.pinned=true`
- 清理：`manage unpinPage targetId=<T>` 后关闭 T

### manage-unpinPage-01

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：在该环境中先将测试 tab T 执行 `pinPage`
- 操作：`manage { action:"unpinPage", targetId:<T> }`
- 断言：`success=true`，`affected.before.pinned=true`，`affected.after.pinned=false`

### manage-activatePage-01

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：agent 在该环境中创建 managed 测试 tab T，不存在用户窗口、tab 或登录态
- 操作：`manage { action:"activatePage", targetId:<T> }`
- 断言：`success=true`，`affected.after.active=true`

### manage-focusWindow-01

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：agent 在该环境中创建测试窗口 W，不存在用户窗口、tab 或登录态
- 操作：`manage { action:"focusWindow", windowId:<W> }`
- 断言：`success=true`，`affected.after.focused=true`

### manage-resizeWindow-01

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：在该环境中先 newWindow 创建测试窗口 W
- 操作：`manage { action:"resizeWindow", windowId:<W>, width:900, height:700 }`
- 断言：`success=true`，`affected.before/after` 存在，`affected.after.width` 和 `affected.after.height`
  接近设置值，等待后独立 `browse list details=full` 的窗口几何与响应一致
- 恢复对照：记录 normal 基准，将 W 最大化，再用一次 `resizeWindow windowState=normal`
  同时传入基准位置和尺寸，首次恢复返回 normal，独立读取与基准及响应一致，不靠重复同一恢复请求满足断言
- 清理：`manage closeWindow windowId=<W>`

### manage-newWindow-01

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：该环境不包含用户窗口、tab 或登录态
- 操作：`manage { action:"newWindow", url:"about:blank", focused:false }`
- 断言：`success=true`，返回 `affected.windowId` 和 `affected.targetId`，`affected.after.tabs[]` 全部 `managed=true`
- 清理：`manage closeWindow windowId=<affected.windowId>`

### manage-closeWindow-01

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：在该环境中先 newWindow 创建测试窗口 W，确认窗口内全是 managed tab
- 操作：`manage { action:"closeWindow", windowId:<W> }`
- 断言：`success=true`，`affected.windowId=<W>`、`affected.before.id=<W>`，`affected.after=null`，再次 `browse list`
  找不到 W

### manage-closeWindow-02-unmanaged-guard

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：在该环境中用 `manage newWindow` 创建窗口 W 和测试 tab T，再执行 `manage releasePage targetId=<T>` 并确认 W 含
  `managed=false` tab
- 操作：`manage { action:"closeWindow", windowId:<W> }`
- 断言：返回 `WINDOW_HAS_UNMANAGED_TABS`，窗口仍存在
- 清理：重新 adopt T，再关闭 W

### manage-newPage-02-native-options

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：准备测试窗口 W 及该窗口内的受控来源页 O
- 操作：`manage { action:"newPage", url:<测试页URL>, windowId:<W>, index:0, active:false, pinned:true, openerTabId:<O>, groupId:-1 }`
- 断言：创建页位于 W，固定、来源 ID、活动状态及不分组的结果正确，默认显示分组不改变显式位置，返回状态与 `browse list`
  一致
- 负例：窗口、来源 tab 和分组不属于同一窗口，或 pinned=true 与已有分组同时指定时，创建前拒绝；跨窗口冲突返回
  `actionExecuted=false`、`actionStatus="not_started"`、`failureStage="preflight"`，独立 list 确认没有新增页
- 默认创建对照：省略原生位置参数创建自有页，自动显示分组后的实际窗口与创建窗口一致，不移入其他窗口
- 清理：关闭新建测试页

### manage-updatePage-01-native-state

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：准备受控测试页 T 与同窗口内的来源页 O
- 操作：分别修改
  `url/active/pinned/highlighted/muted/autoDiscardable/openerTabId`，active 只设置 true，其他可逆布尔字段再设置 false，导航后等待测试页载入
- 断言：每个字段到达 Chrome，`affected.before/after`
  和平铺/窗口 tab 列表反映实际状态，false 不被忽略，active 不隐式聚焦窗口
- 负例：active=false（含同时 muted=true 或 highlighted=true）、缺少配置、跨窗口来源 ID、过期
  `expectedRevision`、未受控目标以及写入 readonly 字段均拒绝，独立 list 确认原字段与 revision 不变

### manage-groupPages-01-create-and-members

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：准备同窗口内的两个受控测试页 T1/T2，以及自有、未受控测试页 U 所在的分组 G
- 操作：`groupPages targetIds=[T1,T2] title=<名称> color=purple collapsed=false`，再将 T1 加入已有 G
- 断言：新组与已有组的实际成员、颜色和窗口通过顶层 `browse list.groups` 回显，包含
  `tabIds/targetIds`，省略 windowId 时保留成员原窗口，U 不因其他受控页加入而获得读取或输入权限
- 负例：待加入列表含未受控页，或跨窗口成员未指定 windowId 时，首次变更前拒绝；显式指定目的窗口时可移动受控成员

### manage-updateGroup-01-properties

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：准备所有成员均受控的测试组 G
- 操作：更新 title、九种合法 color 和 collapsed，设置 `title=""` 与 `collapsed=false`
- 断言：实际组属性与 `affected.after`、`browse list.groups` 一致，空字符串与 false 不被替换，颜色只属于分组
- 负例：非法颜色、无配置、负 groupId、readonly shared 写入或组内存在未受控成员时拒绝

### manage-moveGroup-01-window-and-index

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：准备所有成员均受控的组 G 与独立测试窗口 W
- 操作：`moveGroup groupId=<G> windowId=<W> index=-1`，再按可用 index 调整位置
- 断言：整组及成员均移入 W，实际顺序、首个成员位置和窗口归属回显正确，成员受控状态不变

### manage-ungroupPages-01-retain-control

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：测试组 G 只包含受控页 T1/T2
- 操作：分别解除 T1 和剩余 T2 的分组
- 断言：成员 groupId=-1 且 managed=true，最后一个成员离组后 Chrome 删除空组，读取和输入能力保留

### manage-newWindow-02-multiple-urls-and-existing-tab

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：准备已 adopt 的普通自有测试页 T，记录其创建来源
- 操作：创建 normal 窗口并指定多个 urls，创建单页面 popup；另创建 normal 窗口时同时提供 `targetId=<T>` 与 urls
- 断言：所有新建页均受控，指定 T 移入新窗口且保持原创建来源，额外页面分别记录为新建，位置/尺寸、focused、incognito 和 setSelfAsOpener 按 Chrome 支持情况验证，不把移动 T 标成新建
- 负例：同时提供 url 与 urls、popup 多 URL、popup 同时提供已有 targetId 与额外 URL、非法状态/尺寸组合或迁移到不同隐身状态时拒绝，独立 list 确认没有新增窗口、外溢页面或移动已有页
- 清理：只关闭自有测试窗口

### manage-updateWindow-01-native-state

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：窗口 W 内所有页受控
- 操作：修改位置、尺寸、normal/minimized/maximized/fullscreen 状态、focused 与 drawAttention，分别读取实际窗口状态
- 断言：参数到达 Chrome，状态转换和几何稳定后返回浏览器观测值，不把 OS 调整后的尺寸伪装成输入值，focused=true 只有观测到焦点才报成功
- 首次恢复：分别从 maximized/minimized/fullscreen 用单次 `updateWindow windowState=normal`
  恢复原 normal 基准位置和尺寸，`affected.after.state=normal`，等待后独立 `browse list details=full`
  与响应及有效基准一致，不允许第二次恢复请求掩盖首次失败
- 负例：状态与 bounds 冲突、focused/state 冲突及混合窗口更新拒绝，缓存的 MCP window ID 不赋予额外权限

### manage-configuration-01-backend-and-argument-errors

- 操作：在 CDP 模式调用 Chrome
  UI 配置动作及带原生 UI 参数的 newPage；在 Extension 模式给动作传不适用字段、未知字段或 readonly 字段
- 断言：CDP 返回能力错误且未创建/修改页面，参数错误在变更前拒绝，无静默忽略及假成功

### manage-viewport-01

- 操作：`manage { action:"viewport", width:800, height:600 }`
- 断言：`success=true`；随后 `extract screenshot fullPage=false` 尺寸约 800x600

### manage-userAgent-01

- 操作：`manage { action:"userAgent", userAgent:"MCP-Test/1.0" }`
- 断言：`evaluate "navigator.userAgent"` 返回 "MCP-Test/1.0"

### manage-emulate-01-iphone

- 前置：记录测试页的 UA 和视口尺寸；页面含 `width=device-width` 的 viewport meta
- 操作：`manage { action:"emulate", device:"iPhone 13" }`
- 断言：`evaluate "navigator.userAgent"` 含 "iPhone"，`navigator.maxTouchPoints` 为 1，`devicePixelRatio`
  为 3，`visualViewport.width` 与 `document.documentElement.clientWidth` 约 390
- 恢复：调用 `manage viewport` 恢复原尺寸，验证
  `devicePixelRatio=1`、`navigator.maxTouchPoints=0`；UA 仍为 iPhone，再调用 `manage userAgent` 恢复原 UA
- 覆盖：分别验证 Extension 与 CDP

### manage-emulate-02-list

- 操作：`manage { action:"emulate" }`（不带 device）
- 断言：返回 devices 列表，包含 "iPhone 13"、"iPad Pro" 等

### manage-inputMode-01

- 操作：`manage { action:"inputMode", inputMode:"stealth" }`
- 断言：设置返回 `success=true`、`inputMode="stealth"`；随后 `manage { action:"inputMode" }` 返回
  `currentMode="stealth"`

### manage-stealth-01

- 前置：Extension 模式，CDP 的注入等级在 `browse connect/launch` 时设置
- 操作：`manage { action:"stealth" }`，向当前受控页注入已有反检测脚本
- 断言：`success=true`，随后独立读取 navigator.webdriver 不为 true，页面 URL 与既有 User-Agent 不变；此动作不接受等级参数

### manage-cdp-01-raw

- 操作：`manage { action:"cdp", cdpMethod:"Runtime.evaluate", cdpParams:{expression:"1+1"} }`
- 断言：返回 `{ result: { type:"number", value:2 } }`

---

## 8. wait

计时用例在同一调用进程内用单调时钟记录 MCP 请求发送与响应接收时间；保留实际测量值和传输开销，参数回显不作为耗时证据，两个手工工具调用之间的间隔不计入工具执行时间

### wait-time-01

- 操作：`wait { for:"time", ms:300 }`
- 断言：在 Server handler 入口与退出采集的单调时钟耗时 ≈ 300ms（允许 ±
  100ms）；另保留公开调用端到端耗时及其差值，不把传输和宿主调度计入 handler 容差

### wait-idle-01

- 前置：attach 全新 test-page，执行 evaluate 创建 Web Worker，每 50ms 更新一次 `#burst-mutation-target`，1s 后停止
- 操作：`wait { for:"idle", ms:500, timeout:8000 }`
- 断言：`success=true`，随后读取 `#burst-mutation-target.dataset.workerTick`
  大于 0，返回时间在 mutation 结束并达到 500ms DOM 静默后
- 载体：test-page

### wait-idle-02-timeout

- 前置：attach test-page，执行 evaluate 创建 Web Worker，每 50ms 更新一次
  `#burst-mutation-target`，最多 60s 后停止；记录最后一次 mutation 时间，覆盖工具调用间隔
- 操作：`wait { for:"idle", ms:500, timeout:1200 }`
- 断言：返回 timeout 错误，消息包含 `DOM 未达到 500ms 静默`
- 清理：取得结果后立即终止该 Worker，验证等待期间 mutation 未停止
- 载体：test-page

### wait-element-01-visible

- 前置：刷新本任务 test-page，确认 `#show-later-target` 为 `display:none`，click "5 秒后显示元素" 按钮后立即发送 wait
- 操作：`wait { for:"element", target:{css:"#show-later-target"}, state:"visible", timeout:6000 }`
- 断言：在约 5s 后返回成功，CDP 不因隐藏元素没有 box model 提前失败；CDP 另验 `visibility:hidden/collapse`
  与零尺寸不满足 visible，hidden 状态立即成功
- 计时前置：记录初始 hidden、点击与 shown 的页面时间，以及 wait 的实际开始和返回时间；wait 必须在 shown 前开始并在 shown 后返回
- 宿主调用间隔超过 5s 时，在自有测试页延长显示延时与等待预算，按已记录的延时验证；仅在元素已显示后返回成功不覆盖本项
- 载体：test-page

### wait-element-02-hidden

- 前置：`#show-later-target` 已可见
- 操作：evaluate 设 display=none，随后 `wait element hidden`
- 断言：立即返回成功

### wait-element-03-attached / 04-detached

- 操作：针对 `attached/detached` 状态的等待
- 断言：按状态正确返回

### wait-navigation-01

- 前置：attach 到 test-page，执行 evaluate 创建 Web Worker，每 500ms 更新一次 title 和 URL hash，连续更新 120 次
- 操作：`wait { for:"navigation", timeout:5000 }`
- 断言：wait 返回，title 和 URL hash 均含 `mcp-nav-`
- 载体：test-page
- 清理：终止 Web Worker 并刷新测试 tab

### wait-timeout-01

- 操作：`wait { for:"element", target:{css:"#nonexistent"}, timeout:500 }`
- 断言：约 500ms 后抛 timeout 错误

---

## 9. 错误分支 / 边界

### Cloudflare 实测约束

真实站点只作补充观察，不加入发版门禁。进入 Cloudflare 站点前，先用 `browse { action: "list" }` 确认
`mode="extension"`，不传 `port`，也不传
`diagnostics=true`。CDP 模式超时只能记录为 CDP 路径未完成，不能写成网站或用户真实 Chrome 无法通过。

### browse-challenge-01-js-wait

- 前置：attach 到 test-page，点击 `#challenge-js-btn`
- 操作：`evaluate { script:"document.title" }`
- 断言：约 1.2s 后 `success=true`，`mode="extension"`，`result === "MCP Chrome 测试页面"`，`#challenge-status` 为
  `js-resolved`。恢复发生在八秒被动等待内时不得启用 debugger 或执行 page evaluate
- 载体：test-page

### browse-challenge-02-turnstile-click

- 前置：attach 到 test-page，点击 `#challenge-turnstile-btn`
- 操作：`evaluate { script:"document.getElementById('challenge-status').textContent" }`

- 断言：
    - 八秒被动等待后返回 `turnstile-resolved`，`#challenge-verify` 被点击，标题恢复为 `MCP Chrome 测试页面`
    - 八秒前不得启用 debugger 或点击控件；第一次 inspect 未看到控件时，仍须继续检查 Turnstile
    - 同一坐标连续两次 inspect 后才点击；同一等待内，同一类控件持续可见时只点击一次
    - checkbox 真正替换成文案精确为 `Verify you are human` / `请验证您是真人` 的可见 `button` 后，inspect 判成 `verify`
      再点一次；两种文案分别验证，不只修改原 input 的 value，无关或隐藏 button 不作为验证控件
    - test-page 假按钮走页面点击；真实 Cloudflare iframe 只在已聚焦窗口的活动受控 tab 上用系统鼠标
    - 系统鼠标沿路径移动、悬停后再按下抬起；widget 点击 compact Turnstile 卡片左侧 checkbox
    - 宿主 wrapper 比卡片宽时也只点左侧卡片；Linux 使用当前 X11 活动窗口原点加窗口边距，并校验窗口标题
    - Linux 不使用 Chrome `screenX`，也不把 `outerHeight - innerHeight` 当作顶栏高度
    - Extension inspect 走 isolated world，检查前卸掉 debugger；点击前再次卸掉 debugger 并读取视口
    - DOM 已有 Cloudflare iframe 时，即使尺寸为 0 也走系统鼠标；后续宿主页验证按钮也走系统鼠标
    - 混合窗口不调用 `focusWindow`
- 载体：test-page

### browse-challenge-03-denied

- 前置：attach 到 test-page，点击 `#challenge-denied-btn`
- 操作：`evaluate { script:"1+1" }`
- 断言：返回 `CHALLENGE_DENIED`，`challengeKind="denied"`，`retryable=false`，脚本未执行
- 载体：test-page

### browse-challenge-04-timeout

- 前置：attach 到 test-page，点击 `#challenge-turnstile-btn` 后立即把 `#challenge-verify` 设为 `display:none` 并保持标题
  `Just a moment...`
- 操作：`evaluate { script:"1+1", timeout:800 }`
- 断言：返回 `CHALLENGE_TIMEOUT`，`retryable=true`，`autoRetry=false`，`clickedTurnstile`
  与实际是否点击一致；点过 checkbox 后超时 `challengeKind="turnstile"`，不得因未 inspect 的标题快照报成 `js`
- 载体：test-page

### browse-challenge-05-leftover-iframe

- 前置：`npm test` 中 CH-08 leftover host：标题已不是 `Just a moment...`，主文档无
  `#cf-please-wait`，header 仍标 pending
- 操作：`waitForChallenge({ action: "open" })`
- 断言：视为已过，`challengeKind="none"`，不点击残留 iframe，不因残留 iframe 返回 `CHALLENGE_TIMEOUT`
- 载体：N/A

### browse-challenge-06-origin-pending

- 前置：`npm test` 中 CH-08 origin-pending
  host：Cloudflare 页面可见文案为“验证成功。正在等待 example.com 响应”，无可见 Turnstile 勾选框
- 操作：`waitForChallenge({ action: "open" })`
- 断言：返回成功和 `challengeResolved=true`、`challengeKind="js"`、`originResponsePending=true`，不得返回
  `CHALLENGE_TIMEOUT`，也不得把目标页写成已加载
- 载体：N/A

### err-closed-page-01

- 前置：自有独立 Extension 测试环境，Server 与 Extension 构建匹配；用 `browse list`
  确认本次控制页，复用该页并记录目标 ID，设置 `keydown` 计数为 0；本用例不使用业务页或 popup 授权
- 操作：
    1. 创建第二个自有受控页，`active=false`，用 `browse attach` 选择它，`activate=false`，读取 metadata 确认页面存在
    2. 在仍存活的控制页执行抛出 `No tab with id: <第二页 ID>.` 的脚本，保留其错误；用自有浏览器的原生 CDP
       `Target.closeTarget` 关闭第二页，不通过会清理默认选择的 MCP 关闭动作
    3. 对关闭页分别执行显式 `targetId` 和默认目标的 `input { events:[{type:"keydown", key:"a"}] }`，随后用 `browse list`
       确认关闭页已消失，独立读取控制页计数
    4. 显式 attach 控制页，发送一次相同输入，独立读取计数
- 断言：
    - 两次关闭页输入返回 `TARGET_NOT_FOUND`，`error.context.targetId` 为关闭页，`nativeMessage` 保留原生缺页错误
    - 两次输入均为
      `eventsExecuted=0`、`actionExecuted=false`、`retryable=false`，`pageContext.before/after=null`，目标来源分别为
      `explicit` 和 `default`，失败请求不改变默认目标，不派发到控制页或重放
    - 失败输入后的控制页计数为 0，显式选择控制页后的一次输入使计数为 1
    - 控制页脚本抛出的同文案仍为脚本异常，不归类为 `TARGET_NOT_FOUND`
- 载体：自有独立 Extension 浏览器、test-page

### err-empty-input-events-01

- 操作：`input { events: [] }`
- 断言：返回 `INVALID_ARGUMENT`，消息包含 `events 至少需要一个事件`，且 `actionExecuted=false`
- 载体：任意

### err-evaluate-script-xor-01

- 操作：`evaluate { script:"1+1", scriptFile:"tmp:script.js" }`，以及 `evaluate {}`
- 断言：两次都返回 `INVALID_ARGUMENT`，消息包含 `script 与 scriptFile 必须且只能提供一个`
- 载体：任意

### err-screenshot-target-01

- 前置：attach 到 test-page
- 操作：`extract { type:"screenshot", target:{ css:"#does-not-exist" } }`
- 断言：返回 `TARGET_NOT_FOUND`，不返回成功截图或视口图片
- 载体：test-page

### err-screenshot-diff-output-01

- 前置：attach 到 test-page
- 操作：`extract { type:"screenshot", diffOutput:"tmp:diff.png" }`
- 断言：SDK 参数校验返回 JSON-RPC `-32602`，消息包含 `diffOutput 需要 compareWith`，不执行截图
- 载体：test-page

### manage-clearCache-extension-01

- 前置：Extension 模式已连接
- 操作：`manage { action:"clearCache", cacheType:"cache" }`
- 断言：返回 `UNSUPPORTED_MODE`、`actionPerformed=false`，不返回 `success=true`
- 载体：任意

### err-stealth-commands-01

- 前置：`inputMode=stealth`
- 操作：`input { events:[{type:"keydown", key:"a", commands:["selectAll"]}] }`
- 断言：抛错，消息包含 "commands 参数不支持 stealth 输入模式"

### err-commands-on-keyup-01

- 前置：`inputMode=precise`
- 操作：`input { events:[{type:"keyup", key:"a", commands:["selectAll"]}] }`
- 断言：返回错误，消息明确说明 `events[].commands` 只能用于 `keydown`，当前事件类型为 `keyup`，页面输入与监听计数不变

### err-modifiers-no-pollution-01

- 前置：`inputMode=stealth`，注入 keydown 监听器
- 操作：
    ```
    1. input { events: [{keydown, key:"Control", commands:["selectAll"]}] }  // 应抛错
    2. manage inputMode precise
    3. input { events: [{keydown, key:"b"}, {keyup, key:"b"}] }
    ```
- 断言：最后一次 keydown 的监听结果为 `ctrlKey=false`；第一条失败命令未改变 UnifiedSession.modifiers

### err-drag-refId-stale-01

- 前置：构造 React 重渲染场景导致 refId 失效（当前外部难构造；此用例标 **KNOWN-LIMIT**，靠静态保证）
- 断言：N/A，记录到"已知限制"

### err-invalid-selector-01

- 操作：`extract { type:"text", target:{css:"###"} }`（非法 CSS）
- 断言：抛错，消息含 "selector" 或 "invalid"

### err-invalid-tabId-01

- 操作：`evaluate { script:"1+1", tabId:"99999999" }`
- 断言：返回 `TARGET_NOT_FOUND`，`actionExecuted=false`、`retryable=false`，消息标明目标页面不存在；控制页计数不变

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

- 前置：在仓库与 MCP 会话临时根目录之外创建本次测试专用目录和无害文本文件，记录内容与 hash
- 操作：`evaluate { script:"'x'", output:"<测试文件的绝对路径>" }`；另以 `cwd:../result.txt` 检查语法拒绝，以
  `cwd:./<测试目录>/result.txt` 检查合法点组件
- 断言：根外输出返回 `PATH_NOT_ALLOWED`，`error.context.cwd` 与 server 实际工作目录一致，`allowedRoots`
  明确；文件内容和 hash 未变，相对 `..` 返回 `INVALID_ARGUMENT` 且不误报 Windows 组件，合法点组件写入指定根内位置
- 清理：只删除本次测试创建的目录和文件

### err-scriptFile-outside-allowed-roots-01

- 前置：在允许根目录之外创建本次测试专用文件，内容为 `1+1`
- 操作：`evaluate { scriptFile:"<测试文件的绝对路径>" }`；另使用 `cwd:../script.js` 检查父目录组件
- 断言：根外输入返回 `PATH_NOT_ALLOWED`，上下文显示实际 cwd 与允许根；父目录组件返回
  `INVALID_ARGUMENT`，不读取或执行根外脚本
- 清理：只删除本次测试创建的目录和文件

### err-drag-no-source-01

- 操作：`input { events:[{type:"drag", target:{css:"#nonexistent"}, to:{css:"#drop-target"}}] }`
- 断言：抛错，消息含 "drag 源元素未找到"

### err-iframe-offset-01

- 前置：attach test-page，region 10 的 iframe#test-frame
- 操作：`input { frame:"iframe#test-frame", events:[{type:"click", target:{css:"#frame-btn"}}] }`
- 断言：iframe 内的 `#frame-btn` textContent 变为 "Clicked"（iframe 坐标 offset 正确处理）
- 载体：test-page

---

## 10. test-page region 索引

test-page.html 现有 region（供用例引用）：

| Region                | 用途                        |
| --------------------- | --------------------------- |
| 1 定位                | 各种 locator 测试           |
| 2 输入                | input/textarea 输入         |
| 3 键盘                | 键盘事件日志                |
| 4 鼠标                | click/dblclick/contextmenu  |
| 5 拖拽                | drag-source / drop-target   |
| 6 滚动                | 内容溢出容器（纵向 + 横向） |
| 7 日志                | 触发不同级别 console        |
| 8 媒体                | 图片 / 链接                 |
| 9 select/replace      | 三种场景                    |
| 10 iframe             | 跨框架交互                  |
| 11 wait               | 延迟/哈希/burst mutation    |
| 12 force + combo keys | 覆盖层 + 组合键输入         |
| 13 screenshot compare | 固定截图差异区域            |
| 14 challenge wait     | JS / Turnstile / denied     |

关键 id：

- 1：`#btn-id`、`#input-placeholder`、`#input-title`、`#link-test`、`[data-testid='test-button']`
- 2：`#text-input`、`#textarea`、`#input-result`
- 3：`#key-display`、`#key-log`
- 4：`#click-test`、`#dblclick-test`、`#contextmenu-test`、`#mouse-log`
- 5：`#drag-source`、`#drop-target`、`#drag-log`
- 6：`#scroll-container`、`#scroll-middle`、`#scroll-bottom`、`#scroll-container-x`、 `#scroll-x-left/middle/right`
- 7：`#log-info`、`#log-warn`、`#log-error`、`#log-custom`
- 8：`#test-image`、`#test-link`
- 9：`#edit-input`、`#edit-textarea`、`#edit-contenteditable`
- 10：`#test-frame`、`#frame-btn`、`#frame-input`、`#frame-result`
- 11：`#show-later-btn`、`#show-later-target`、`#hashnav-btn`、`#burst-mutation-btn`、 `#burst-mutation-target`
- 12：`#covered-btn`、`#combo-input`
- 13：`#compare-box`、`#compare-toggle-btn`、`#compare-reset-btn`
- 14：`#challenge-js-btn`、`#challenge-turnstile-btn`、`#challenge-denied-btn`、`#challenge-status`

**本清单引用但 test-page 尚未覆盖的元素**（待补充）：

- 无（横向滚动容器 `#scroll-container-x` 和截图差异区域 `#compare-box` 已补）

---

## 11. npm 发布包

### package-clean-build-01

- 操作：先在 `dist/__stale-package-probe__.js` 写入测试内容，再执行 `npm pack --dry-run --json`
- 断言：发包生命周期重新构建 server，输出文件清单不含测试文件；不含已删除的
  `dist/extension/native-host-installer.*`、`dist/extension/socket-server.*`、`dist/extension/ws-server.*` 或
  `dist/native-host/`
- 载体：N/A
- 清理：构建失败时删除测试文件；构建成功后测试文件应已被自动删除

### package-content-01

- 操作：把 `npm pack --json` 生成的 tarball 解压到仓库外临时目录，检查文件清单和文本内容
- 断言：包内不含 `TESTING.md`、`test-csp-page.html`、仓库外绝对路径或本机用户目录；package version、Extension version 和
  `extension/dist/manifest.json` version 完全一致
- 载体：N/A
- 清理：删除解压目录和 tarball

---

## 附录 A：已知限制 / KNOWN-LIMIT

- `err-drag-refId-stale-01` — 需要 V8 GC 才能让 WeakRef deref 失败，从外部 mcp 工具无法稳定构造， 靠静态代码 review +
  `dist` 字面量 + 正常 drag 端到端 smoke 保证
- `input-keydown-05-commands-copy-paste` — 依赖剪贴板权限，无权限或 headless 下跳过

## CH 专项回归

- `ch-input-01`: 对 `#edit-number` 执行 replace，确认不调用 selection API，返回 `requestedValue`、`actualValue`，并派发
  `input` 与 `change`
- `ch-input-02`: 对 `#edit-date` 执行 select，确认返回 `UNSUPPORTED_SELECTION` 及 tag、input type、current
  value、requested find、推荐模式
- `ch-postcondition-01`: 已完成动作后的 false selector 返回 `actionStatus=completed`、`verificationStatus=not_matched`、
  `failureStage=verification`
- `ch-postcondition-02`: frame/context/debugger 不可用返回 `verificationStatus=unavailable`，不伪装为 `not_matched`
- `ch-timeout-01`: 在自有页初始化 started/completed 计数，通过两种 backend 的 `manage cdp Runtime.evaluate`
  设置 1ms 协议 timeout，脚本先增加 started，再执行有界计算并增加 completed；独立读取实际计数，原生
  `Execution was terminated`（含实际 CDP 方法前缀）返回
  `actionExecuted=true`、`actionStatus=unknown`、`retryable=false`，保留原错误码且不重放；两种 backend 的 evaluate 分别使用有界执行超时，记录真实原生终止、`Runtime`
  脚本命令的 `Internal error` 或执行中 RPC timeout；这些结果未知的错误均不可直接重试，不把 RPC
  timeout 改称原生终止，调用前超时仍保留未执行及可重试状态；页面主动抛出的同名异常仍为动作失败；本地注册 callback 回归须用 CDPClient 实际消息转换覆盖
  `Runtime.evaluate`、`Runtime.callFunctionOn`、`Runtime.runScript`，同时保留普通参数错误和非脚本命令的负例
- `ch-target-01`: input、extract、wait 的 target timeout 返回 locator、target
  type、nth、URL、tabId、managed、frame、match count、最多 10 个候选和 last state
- `ch-port-01`: 无 server 时 Extension 的聚合扫描摘要与重连消息均为 debug，不为每个候选端口输出 warning/error
- `ch-port-02`: 已识别 MCP
  server 的 token/proof 不匹配或认证协议不完整时，输出一条限量 warning；同一摘要重连时不重复刷屏
- `ch-frame-01`: iframe 导航销毁 context 后，默认 `staleContextRetry=never` 不重放有副作用脚本；显式 `readOnly`
  时最多重放一次，并返回策略、retry 和最终 frame/context 摘要
- `ch-frame-02`: 两个相同 URL iframe 无法唯一确认所选 DOM owner 时返回 bounded
  candidates 并拒绝执行；身份可确认时命中所选 iframe，不按 URL 列表顺序选择
- `ch-frame-03`: 页面 DOM iframe 与 `webNavigation`
  额外 frame 同时存在时，selector 和 index 都按 DOM 元素身份命中目标，无法建立唯一映射时返回
  `FRAME_IDENTITY_UNAVAILABLE`
- `ch-password-01`: 仅用自造 password value、input `find` 和替换 `text` sentinel，分别执行 Extension/CDP 的
  `select`/`replace` 成功与失败、selector/nth 和 post-condition 对照；完整响应不得泄露 sentinel，诊断正文返回
  `redacted=true` 与
  `reason="sensitive_input_or_unresolved_target"`，动作和验证状态保持正确；同页有 password 字段时，普通输入仍返回新增 console/network 诊断；下一次普通请求不继承密码保护状态
- `ch-backend-01`: 显式 `tabId`
  的 input、wait、logs、extract 在目标作用域内选择 backend，动作、诊断和验证都命中同一个 managed tab
- `ch-cdp-selection-01`: CDP 模式对 input、textarea、contenteditable 的 locator `select` 和 `replace`
  成功，不调用 Extension refId 或 `actionableClick`
- `ch-diagnostics-01`: restricted URL 导航到普通 URL 且 `diagnostics=true`，主导航成功，返回
  `diagnosticsStatus=unavailable` 与原始摘要
- `ch-diagnostics-02`: browse 或 wait 主动作失败且 `diagnostics=true` 时，错误响应保留
  `diagnosticsStatus`、新增 console/network 摘要或采集错误
- `ch-challenge-01`: JS Challenge 等待标题和 DOM 标记消失后返回成功，不返回交接错误
- `ch-challenge-02`: Turnstile checkbox 在真实浏览器中被点击后页面恢复
- `ch-challenge-03`: Access denied 返回 `CHALLENGE_DENIED`
- `ch-challenge-04`: 超时返回 `CHALLENGE_TIMEOUT`，`retryable=true`，响应不包含 cookie 值；点过 checkbox 时
  `challengeKind="turnstile"` 且 `clickedTurnstile=true`，未 inspect 的标题快照不得覆盖该类型
- `ch-challenge-05`: 目标页已恢复后，残留 Cloudflare iframe 不继续判 pending
- `ch-challenge-06`: 中文标题 `请稍候…` 或正文“正在进行安全验证”仍判为 JS Challenge
- `ch-challenge-07`: CDP 用 `Target.getTargetInfo` 读标题，启动时不启用 `Runtime.enable`
- `ch-challenge-08`: Extension 在前八秒只读真实 tab 标题，不附加 debugger；标题恢复后直接返回
- `ch-challenge-09`:
  Extension 八秒后仍出现可见 Turnstile 才检查并点击；同一类 checkbox/widget 在同一次等待里只点一次，换成可见的
  `Verify you are human` / `请验证您是真人` 按钮后 inspect 判成 `verify`
  再点一次；第一次 inspect 未看到控件时继续查，Extension inspect 走 isolated
  world 且不先挂 debugger，旧 Extension 才回退 stealth/precise，不立刻当纯 JS
  Challenge；同一坐标连续两次 inspect 后才点击；test-page 假按钮走页面点击，Cloudflare
  iframe 只在已聚焦窗口的活动受控 tab 上用系统鼠标，沿路径移动、悬停后再按下抬起，widget 点 compact
  Turnstile 卡片左侧 checkbox，宿主 wrapper 比卡片宽时也只点左侧卡片，Linux 用当前 X11 活动窗口原点加窗口边距且窗口标题必须对应该测试页，不用 Chrome
  `screenX`，也不用 `outerHeight - innerHeight` 当顶栏，点击前卸掉 debugger 再读视口，DOM 里已有 Cloudflare
  iframe 时即使尺寸为 0 也走系统鼠标，后续宿主页验证按钮同样走系统鼠标，混合窗口不调用
  `focusWindow`；普通编辑区等无关 div 不因尺寸匹配成为 widget；Linux 用 `xprop` 的 GTK frame
  extents 与实际 client 窗口尺寸核对内容原点，覆盖不对称 shadow、缩放与无 client
  shadow 的窗口，数据不符或工具缺失时拒绝点击；原生截图中的控件位置、系统鼠标终点和页面实际 click/change 事件须一致，英文、中文均完成 checkbox 到 verify 的两阶段变化，不能以 xdotool
  exit 0 替代；缺少系统鼠标工具或窗口未聚焦返回可见错误，不静默改用 CDP 点击；`diagnostics=true` 不用于 Cloudflare 实测
- `ch-challenge-10`: 使用真实旧 Extension，保留版本、bundle 身份与原调用；缺少 `page_snapshot`
  时，无条件 adopt 和导航仍可执行， `pageContext.before/after` 的 `revision=null`
  并附能力 warning，页面 URL 实时变化；显式 `expectedUrl` 或 `expectedRevision` 在派发前返回
  `DRIVER_CAPABILITY_ERROR`、`actionExecuted=false` 和
  `actionStatus="not_started"`，目标状态不变 evaluate 与 input 的两类条件分别验证顶层状态和 error.context 一致，`failureStage="precondition"`，input 的
  `eventsExecuted=0`；每次拒绝后独立读取脚本计数、输入状态和 URL，确认均未变化旧 Extension 实际返回
  `Unknown action: network_challenge_state` 时记录 server
  warning，回退到标题和 DOM 检测，不中断无条件导航或重放脚本其他接口的 Unknown
  action 不代替该负例；恢复当前 Extension 后，公开 connect 再次确认版本与 bundle match
- `ch-challenge-11`: Cloudflare 可见文案明示验证成功但源站未响应时返回
  `originResponsePending=true`；两种 backend 的 evaluate 在成功、动作失败、后置验证不匹配及输出失败时均保留
  `challengeResolved`、`challengeKind`、`waitedMs`、`clickedTurnstile`、`clearanceCookiePresent`
  和源站等待状态，每次脚本只执行一次；隐藏成功文案和仍显示的 Turnstile 勾选框不算验证完成，也不把目标页写成已加载

无需浏览器的聚焦测试执行 `npm test`，真实 MCP runtime 回归仍需按本文件用例顺序在受控测试 tab 中执行

## 页面恢复与响应错误专项

聚焦自动化用例位于 `test/finding-regressions.test.js` 的 C-R1/C-R2/C-R3，运行
`npm test`，模拟 driver 的证据只验证服务器作用域和响应，不代替真实浏览器回归

### page-restoration-01

- 前置：隔离测试环境有默认页 A 和显式目标 B，并可对恢复阶段的 `listTargets`、`selectPage`、detach 注入失败
- 操作：分别在 Extension/CDP 执行 B 的动作，覆盖恢复成功、列表查询失败、重新选择失败、A 在动作期间关闭、原先无默认目标，以及主动作和恢复同时失败
- 断言：主结果或原错误保留，`pageContext.targetRestoration` 分别报告 `restored`、`failed`、`previous_target_closed` 或
  `cleared`；恢复失败后默认目标为 null，CDP
  detach 失败也不残留 session/target；下一缺省调用不使用 B，不携带上一请求的恢复信息

### page-restoration-input-01

- 前置：隔离测试页有可观测的输入计数，默认页 A 与目标 B 分开
- 操作：对 B 输入一次并让恢复查询失败；再分别在输入完成、部分事件完成及派发超时后注入外层清理失败
- 断言：输入只派发一次，已完成结果保持 `actionExecuted=true` 与 `actionStatus=completed`；部分与 `unknown`
  状态不报成功，`eventsExecuted` 反映完成事件数，响应不泄露输入文本

### page-context-concurrency-01

- 前置：默认页 A、显式页 B 与持久目标 C，动作可用 Promise 门控制完成时机
- 操作：暂停 B 的显式动作并提交缺省动作；恢复后检查二者响应；再分别暂停 `browse attach` 与 `manage adoptPage`
  选择 C，并提交缺省动作
- 断言：第一组缺省动作及 before/after 都属于 A，默认目标前后为 A；第二组缺省动作及快照属于 C，持久选择响应的默认目标由 A 变为 C；同一请求嵌套不死锁，`creatingPage`
  的 created/reused/unconfirmed 语义保留

### page-response-errors-01

- 前置：独立测试页的当前 URL/revision 已记录
- 操作：通过公开注册 callback 对 `browse refresh` 与 `manage closePage` 分别提交旧 revision、无读取授权和已消失目标；对
  `manage` 非页面 handler 注入异步拒绝
- 断言：响应保持结构化 `error.code` 和 `pageContext`，旧 revision 错误包含
  `actualUrl`/`actualRevision`，拒绝前不发生输入或关闭；非页面 handler 使用既有错误格式，异步 rejection 不泄漏为纯文本

## Windows 兼容与页面授权专项

以下用例只使用新建的独立测试页。不得导航、关闭或激活用户原有 Tab；C4 的授权负例只在独立测试 Chrome
profile 中执行。无需浏览器的回归由 `npm test` 和 `npm run test:extension` 覆盖；Windows 原生行为只有在 Windows
runner/主机实际执行后才算完成。

### win-page-target-01（C1、C2）

- 前置：在独立 Extension 测试环境创建 T1/T2，默认目标保持 T1；在独立 CDP 测试环境创建 P1/P2
- 操作：分别用 `evaluate`、`extract`、`input`、`wait`、`logs` 的 `targetId=T2/P2` 读取或修改测试页；随后
  `browse list`；再传旧版 `tabId`，以及同时传入冲突的 `tabId`/`targetId`
- 断言：两种 backend 都命中显式目标，不改变浏览器焦点与默认目标；响应 `pageContext`
  列出实际 ID、来源、操作前后 URL/revision、默认目标前后状态；动作失败的响应也包含
  `pageContext`，但目标状态读取失败时前后快照为 null；Extension 报告 Chrome 活动目标，CDP 标记为 unavailable；冲突 ID 在执行前被拒绝
- 负例：`browse close` 和 `manage closePage` 缺少 targetId 时均不关闭页面；指定 ID 只关闭指定的测试页

### win-page-condition-01（C3）

- 前置：在独立测试页记录 `browse list` 的 URL/revision，并保存输入框原始值
- 操作：对 `input` 和 `evaluate` 传不匹配的 `expectedUrl` 或过期 `expectedRevision`；对
  `browse back/forward/refresh/close` 与可用的 `manage` 页面动作重复负例；最后用新快照执行多事件 input
- 断言：不匹配时返回 `ACTION_PRECONDITION_FAILED`，响应的
  `error.context.actionExecuted=false`（input/evaluate 顶层同时返回
  `actionExecuted=false`、`actionStatus=not_started`），输入框、导航历史和测试页均未变化；匹配时首个变更动作执行，多事件不因自身 revision 增加而中止；导航或操作后获取的新 revision 与旧值不同
- 说明：revision 不覆盖网页自主的所有 DOM 修改；服务进程或 Extension Service Worker 重启后旧 epoch 必须失效

### win-read-grant-01（C4）

- 前置：只在隔离 Chrome profile 中创建普通测试页 U 和由 Extension 创建的 T，连接两个测试服务器实例
- 操作：授权前尝试读取 U；通过服务器 A 调用
  `manage grantReadAccess targetId=<U>`，无需 popup 点击；分别通过服务器 A/B 对 U 执行带 target 的 text、HTML（含 images=info）、attribute、computed:color、state 提取及 JS、截图、输入；调用
  `manage revokeReadAccess` 后重试读取并重新授权；重启前对 T 使用 precise 脚本和输入，重启 Service
  Worker 后读取 U 同一文档，并对 T 再次执行 precise 脚本和输入，独立检查效果；再导航 U 并重复读取
- 断言：授权前两台服务器均不能读取；授权后仅 A 可做普通读取，含 CSS+text、XPath、坐标和 nth 定位；找不到 state 目标时不能返回整页；B 仍被拒绝；JS/debugger、截图、输入及写动作不因授权开放；同一连接和文档保持不变时 Service
  Worker 重启仍可读取，导航和关闭后权限失效；显式 adopt
  U 后无需 popup 只读授权即可进行完整受控操作，release 后完整权限停止；T 的自有 debugger 连接在 Worker 重启后继续可用，原生轨迹须证明 attach 冲突、有效
  `Runtime.getIsolateId`、后续成功动作且未 detach T 的既有连接
- 外部拒绝为条件项：沿用 `logs-network-01` 的真实原生拒绝前置；满足时返回
  `DEBUGGER_BLOCKED`，不能通过 detach 外部连接制造通过；Chrome 允许多客户端时不将合法 attach 成功判为接管，缺少前置则记录该条件项未验证
- 断言：撤销、server instance、documentId、URL 或同 epoch
  revision 变化后授权失效；授权和撤销不改变默认目标、焦点或 revision；注入 storage 失败返回错误
- 断言：授予 A 读取权限后，依次对 U 执行因非受控而被拒绝的
  `updatePage/pinPage/unpinPage/movePage/reorderPage/activatePage` 和
  `browse open/back/forward/refresh/close`；每次拒绝均不发出原生写动作，revision、URL、documentId、焦点和默认目标保持，A 仍可读取，B 仍被拒绝
- 限制：Cookie 工具的独立作用范围按现有过滤规则测试，不把普通只读授权当成 Cookie 权限

### create-partial-result-01

- 前置：隔离 mock 的 storage、group、navigation、CDP attach 和 RPC 失败注入可用，浏览器真实回归只使用自有测试资产
- 操作：通过 newPage、newWindow 与 browse launch 在创建后注入失败；另使创建 RPC 结果未知，记录旧默认页
- 断言：已知创建 ID、窗口、实际 managed、actionExecuted、actionStatus 与 failureStage 保留到公开错误响应；未知创建结果返回 unknown，pageContext.targetId 不使用旧默认页；不自动重复创建或删除
- 验证：本地回归分别覆盖 Extension
  handler、Bridge、UnifiedSession、公开注册 callback 和 CDP；真实 MCP 调用检查部分失败后的 list 与页面上下文，本地 mock 不替代发版回归

### win-page-metadata-01（C5）

- 前置：新建独立测试页 T，并从 `browse list` 获取 ID
- 操作：调用 `manage(pageMetadata, targetId=T, taskHint="demo", note="test")`，再次读取并关闭 T
- 断言：列表与元数据响应显示创建时间、创建来源和最近使用时间；`taskHint/note`
  可读取与清除；关闭后清理，不参与页面读取权限判定；服务器重启后进程内元数据不声称持久化

### win-page-metadata-condition-01

- 前置：从 `browse list` 取得自有测试页 T 的 URL/revision，设置基线 `taskHint` 与 `note`
- 操作：用有效 `expectedUrl`/`expectedRevision`
  读取、更新和清空备注；分别传入错误 URL 与过期 revision，对读取和写入请求都执行负例，再不带条件独立回读
- 断言：有效条件执行成功；不匹配返回
  `ACTION_PRECONDITION_FAILED`、`actionExecuted=false`，原备注和任务提示不变；错误保留 T 的页面上下文；默认选择与读取权限不改变，不执行导航或激活
- 验证：CDP 和 Extension 分别执行，关闭 T 后元数据仍清理，服务器实例隔离保持

### win-chrome-launch-01（C6；仅 Windows）

- 前置：Windows 主机上可用 Chrome 或 Chromium；准备独立的无登录 profile
- 操作：分别核查 App Paths、PATH、已安装 Chrome channels、Chrome for
  Testing 与受控便携目录的可执行文件发现；在 PowerShell 使用
  `scripts/start-chrome.ps1 -Port 9222 -ProfileDir <独立目录>`，随后对受控 CDP 端口调用 `browse connect`
- 断言：找到正确可执行文件；带空格路径可启动并连接；Chrome 收到 signal 而提前退出时立即报告信号及 stderr，不等待通用超时；清理独立测试进程和 profile

### win-screenshot-budget-01（C7）

- 前置：独立受控测试页，准备超过 25 MiB 的测试 PNG 基准文件与可截取的安全小区域
- 操作：分别请求超过单边 16,384、总计 12,000,000 像素或 48
  MiB 估算内存的截图；传入超大 PNG 基准；最后对小区域执行截图和比较
- 断言：尺寸超预算在 capture 前拒绝，超大基准在读取和解码前返回
  `baseline PNG 超过 26214400 字节`；普通截图与对比使用同一预算；小区域截图及 PNG 对比正常
