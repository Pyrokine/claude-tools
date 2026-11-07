# mcp-chrome 发版前回归清单

本清单用于在 Claude
Code 会话内由 agent 按用例 ID 顺序执行；所有必跑用例 PASS，条件用例 PASS 或按明确前置条件记录 SKIP，KNOWN-LIMIT 已登记到附录
A，才能执行
`npm publish`

本文件只维护可复用的测试指导、用例定义、验收标准和长期限制，不记录单次执行结果、日期化回归记录或发版日志

`test/run-all.js`
是独立冷启动 smoke（运行 demoqa），定位为可选补充，仅覆盖 smoke-level 的工具调用，不做行为级断言，真正回归以本清单为准

---

## 0. 跑法（agent-driven，在 CC 内）

### 0.1 前置条件

**执行总纲**：按本清单用例顺序执行，默认状态为必跑；禁止操作用户已有 tab，禁止清除全局缓存或 cookies，只能操作 agent 创建的
managed 测试 tab 和测试创建的
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

| 载体          | 位置                                                     | 作用                                   |
| ------------- | -------------------------------------------------------- | -------------------------------------- |
| test-page     | `file:///<repo>/mcp-chrome/extension/test-page.html`     | 受控页面，覆盖 14 个 region 和行为断言 |
| test-csp-page | `file:///<repo>/mcp-chrome/extension/test-csp-page.html` | 受控严格 CSP 页面                      |
| demoqa        | `https://demoqa.com/`                                    | 可选外部站点，网络不可达时跳过         |

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

定向回归入口：`test/review-navigation.test.js`、`test/review-events.test.js`、`test/review-input.test.js`、`test/review-c31-cookies.test.js`、`test/review-c31-cancellation.test.js`、`test/review-c31-wheel.test.js`、`test/review-c31f-cookies.test.js`、`test/review-c31f-release.test.js`、`test/review-c31f2-cookies.test.js`、`test/review-c31f3-cancellation.test.js`，Extension 专用回归由现有 Vite 入口加载对应的 `review-input`、`review-c31-cookies`、`review-c31f2-cookies`、`review-c31f3-management` 与 `review-c31-wheel` 测试

| 编号      | 条件与入口                                                                                                   | 验收                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| C30-01    | 将源码包解压到独立目录，干净安装、构建并启动实际 stdio 入口                                                  | initialize 与 tools/list 成功，精确列出八个工具，Cookie 源码与其测试可加载                                     |
| C30-02    | 四种 CDP 导航已由生产等待器确认完成，驱动第一次状态读取发生超时、目标消失或预算耗尽                          | 保留 completed、metadata 阶段与 retryable=false；真正的导航等待失败、派发拒绝、无历史和正常读取各自保持原状态  |
| C30-03    | 两后端预取消、真实队列中取消、派发后取消、连接等待和 Challenge 等待                                          | 派发前取消为零变更，派发后保留执行事实；同一请求 signal 贯穿锁与后端，监听器和 timer 释放，后续请求仍可执行    |
| C30-04    | blocked/exempted Cookie metadata，包括缺省 cookie 对象，通过公开 logs 读取 inline 和 output                  | cookieLine、header 和 Cookie 对象中的合成凭据均被脱敏，原因字段保留，显式 requestBody/responseBody 字节不变    |
| C30-05    | closed、ACK、下一 opening 在同批帧到达，另验证 ACK 前后分批顺序、错误和断连                                  | 下一 ref 保持可处理，旧 ref 的完成、失败或重复操作只更新其自身状态；accept、dismiss 和 prompt 文本均正确       |
| C30-06    | host 自身 shadow 子节点、嵌套 host、slot、普通 DOM 和独立 overlay                                            | 两后端正常组件可点击，独立 overlay 继续返回 covered，拒绝时没有点击派发                                        |
| C30-07    | Shadow 内的 stealth、force、后台单击与 controlled 输入                                                       | click、key、input 到达 host/document 监听器且只发送一次；mouseenter、change 保留局部语义，后台执行保留 warning |
| C30-08    | precise/stealth 的坐标 wheel，选中 frame、元素 target、无 target、取消与到期                                 | 坐标直接派发且不发空 find；frame-local 点和身份传到底层，无 target 沿用当前位置，取消或到期后无额外滚动        |
| C30-09    | 公开 cookies get/clear 对比 /app、/app/、/app/info、/apple/info 与 target/context、domain、secure、partition | /app Cookie 不匹配 /apple/info，删除命令集合仅含匹配项，其他作用域的合成 Cookie 保持                           |
| C30-10    | 两端干净安装后读取锁条目和实际 package.json                                                                  | version、resolved 与实际包版本一致；未安装的 optional／其他平台包单独记录                                      |
| G038/G090 | 输入已完成，验证暂不可用、context/object 失效、停滞读取或脚本失败                                            | 顶层 retryable=false，验证自身重试标记保留；只读检查在原 deadline 内恢复，任意脚本失败立即返回对应状态         |
| G064/G124 | 元素不可操作，以及页面含 CSS/script、隐藏表单、密码和超过 500 字符的正文                                     | 元素错误提示与页面隐藏区分；文本只取渲染文字和可见非密码值，actual 包含命中文字且有界                          |

| 编号   | 条件与入口                                                                                                                           | 验收                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C31-01 | 同名 Cookie 的不同 path、原始 host-only/domain、partition 与 BrowserContext；枚举后消失、空 ACK 和不可序列化分区                     | 删除使用精确身份并保留其他集合；CDP count 仅统计删除前存在且 ACK 后检查为消失的身份，acknowledged 与 alreadyAbsent 分别计数；不可精确表达的分区在删除前拒绝 |
| C31-02 | Challenge 只读窗口查询、移动与按下后取消；launch 两次 HTTP、端口复用、spawn 前与握手阶段取消                                         | 尚未派发的移动、点击、profile 与进程保持零次；按下后只允许有界释放；只清理本次未交付进程，保留正常单次启动、焦点/权限拒绝与已存在浏览器                     |
| C31-03 | 两输入模式的同文档、解析后导航、helper 后导航和 frame 移除；动作注入结果未知对照                                                     | helper 和 wheel 固定同一 documentIds；派发前身份变化时新旧文档均无输入并返回 not_started；已派发后通用拒绝保持 unknown；frame-local 坐标及原 frame 恢复有效 |
| C31-04 | 第一项、中途、最后一项删除拒绝，已派发后 ACK 丢失，以及删除完成后临时 session detach 失败                                            | 公开 COOKIE_CLEAR_PARTIAL 保留 count、ACK、失败/未知与未处理数量、phase 和 cause，retryable=false；停止后无后续删除；detach 失败保留此前确认进度            |
| C31-05 | 两后端的 bare get、target/context/store-only、空白 name/domain/url、仅 secure/session/path/partition 与 output；三种合法过滤各自对照 | 非空白 name/domain/url 至少一项，在 Cookie API 与导出文件创建前拒绝不合格请求；合法读取保持范围与内容                                                       |

| 编号     | 条件与入口                                                                                                                                      | 验收                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| C31F-01  | 通过真实 CDPClient 在首项、中途和最后一项删除已发送、ACK 前被动或主动关闭；派发前断连、原生拒绝、正常 ACK、真实 timer 与取消对照                | 在途关闭计 unknown，保留方法与原因；首项 unknown、前序已有 ACK 时 partial；明确拒绝与未派发单独计 failed，后续零删除                     |
| C31F-02  | 公开 browse 的 down 完成后取消，延迟必要 up；随后发起同 tab 导航和 input，覆盖释放成功、失败、5000 ms 清理预算到期、正常慢释放和查询/移动时取消 | 释放完成或有界清理结算前，后续导航及输入零派发；失败或超时保留 releaseStatus=unknown 和明确错误；查询/press 前取消及时结束，队列继续可用 |
| C31F-03A | precise/stealth、主文档/iframe 的坐标水平与垂直输入，正负方向、最近容器方向到边界及 CSS 水平对照                                                | 选择请求轴上该方向仍有范围的最近祖先；水平独占容器不因 Y 条件被跳过；viewport 保持正确位置，frame-local 坐标有效                         |
| C31F-03B | 普通 DOM/Shadow 内部，目标、祖先和 document 的显式非 passive 监听器取消；无取消对照                                                             | 有效取消后容器及 viewport 无额外默认滚动；已派发事件仍为 completed、eventsExecuted=1、retryable=false                                    |
| C31F-03C | wheel 命中开放 ShadowRoot 内部，记录 inner/root/host/document，外层有效取消及普通 DOM 对照                                                      | composed=true，host/document 收到事件；外层取消阻止默认滚动；原文档身份、导航拒绝与未知状态回归保持                                      |

| 编号     | 条件与入口                                                                                                                                                                                | 验收                                                                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C31F2-01 | 真实 SDK Client/McpServer 的 tools/call 与 notifications/cancelled，保留生产 requestContext provider 和驱动选择；首项/中途 ACK 前取消、已取消入口、临时 session 清理及 Extension 批次对照 | 服务端 signal 已 aborted 后才放行在途回执，后续新增删除为 0；CDP 保留前序 count/ACK 和在途 unknown；Extension 发出 cancel，生产循环停止；SDK 抑制已取消请求回包 |
| C31F2-02 | column-reverse、row-reverse、vertical-rl、LTR/RTL，起点/中间/两端、正负输入与 CSS 对照；两模式和主文档/iframe                                                                             | 浏览器实际位移决定该轴是否已消费，反向范围正常滚动自身；真实没有移动且允许传播时由有范围祖先滚动                                                                |
| C31F2-03 | X/Y 的 contain/none/auto，边界与中间、正负输入及混合轴                                                                                                                                    | contain/none 到边界后对应轴的祖先保持位置，auto 允许传播，中间仍可滚动自身；混合输入分别核对每轴的独立原生单轴参照                                              |

| 编号     | 条件与入口                                                                                                                                  | 验收                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| C31F3-01 | 真实 SDK 的首项/中途临时 attach ACK 前取消、同连接重复取消、原生拒绝、删除 ACK 前取消及清理失败；真实 Chrome 同 context 已附加 A 与未附加 B | 后续零删除，迟到成功 sid 有界回收，重复取消不累积遗失 session；A 的 session 保持可用，清理失败保留日志与命令归属，不重放删除                 |
| C31F3-02 | 公开前序 extract 持锁，六类窗口/分组动作排队取消；生产 ActionHandler/TabHandler 在异步读取期间取消或到期、多步变更及关闭清理                | 服务端确认取消后才释放前序，后续零变更；原生关闭前取消/到期时零 remove，部分变更保留 partial，关闭后的受控状态清理完成；ref 控制仍可独立执行 |
| C31F3-03 | 真实 SDK 的 extract 排队/在途/预取消、原 timeout 对照、HTML/图片目录真实输出及原子写入各阶段                                                | 排队取消零读取/输出，在途取消发送 cancel，后续元信息和图片读取停止；取消后不发布新文件，已完成文件保留，临时文件清理完成，队列继续可用       |
| C31F3-04 | body auto/contain/none、body hidden、root hidden、root auto + contain、body 独立滚动，X/Y 正负、两模式与主文档/iframe                       | 分别比较事件命中及 root/body/viewport 位置；传播 overflow 的 body 不额外阻断，hidden/clip viewport 不主动滚动，独立 body 正常滚动            |
| C31F3-05 | nested hidden/clip/visible 与 auto/contain/none，X/Y 正负、两模式与主文档/iframe，保留普通 auto/scroll 及独立混合轴对照                     | hidden 自身不滚且 contain/none 阻止对应轴，auto 允许传播，clip/visible 不按该滚动容器边界阻止，未受限轴保持原规则                            |

| 编号     | 条件与入口                                                                                                                                                                          | 验收                                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C31F4-01 | 实际 SDK → Bridge/HttpServer → 生产 HttpClient cancel → ActionHandler／状态模块；adopt、grant、revoke、metadata、release 的内部排队、身份读取、存储提交，以及授权跨 generation 刷新 | 两端确认取消后释放读取，本请求未提交的 set 为 0，原状态保持；已提交状态同步内存，创建后的登记与关闭后的清理完成，正常与 deadline 对照保持                |
| C31F4-02 | Cookie、普通日志、事件日志、manage 保存、evaluate 显式／自动保存、extract 对照；实际 open、write、close、rename 与日志 manifest 阶段                                                | 原 signal/deadline 到最终发布；未派发的 rename 与后续 manifest 为 0，旧文件与已发布文件保持，临时文件清理，脚本 completed 事实保持，事件保存独立于页面锁 |
| C31F4-03 | html/body 的 layout、paint、style、size、inline-size、content、strict，content-visibility、container-type；正常传播与独立 body 控制                                                 | 显式与隐式实际 containment 分别核对，独立 body 正常滚动，真正传播源跳过自身边界，root/body/viewport 的实际位置与原生一致                                 |
| C31F4-04 | inline／contents／block、hidden／auto、auto／contain／none、空范围与边界，两轴正负及 iframe                                                                                         | 无适用滚动盒的节点不消费 overscroll；真实 hidden 容器自身不滚，实际容器的边界策略保持，比较目标与祖先的位置                                              |
| C31F4-05 | fixed／absolute 跨过非包含块祖先，普通流、relative／transform／contain／perspective／filter／will-change 包含块及目标自身可滚动                                                     | 目标命中相同，跳过无关面板，实际包含块继续参与；比较目标、面板、root/body/viewport，覆盖两模式、两轴正负与主文档／iframe                                 |

| 编号     | 条件与入口                                                                                                                                                                                     | 验收                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C31F5-01 | flow-root list-item、inline flow-root list-item、-webkit-box、-webkit-inline-box 的 auto 滚动与 hidden + contain/none，flow-root、普通 inline、block 正常控制                                  | 按外部／内部 display 和主盒判断滚动资格，比较自身、祖先和 viewport；真实零范围容器保留边界，非原子 inline list-item 保持非滚动盒行为                                      |
| C31F5-02 | 非原子 inline list-item 的 transform／contain:layout；block + will-change:contain；inline、inline-block、will-change:content-visibility／filter 控制；absolute/fixed、Shadow、root/body 使用点 | 无效包含块不进入滚动链，保留原生有效定位关系，分别核对滚动盒、transform 与 containment 资格；两模式、主文档／iframe、两轴正负与目标命中保持                               |
| C31F5-03 | 实际 SDK 的原生预算计时器，读取派发后墙钟位于 deadline−1／deadline、未改真实时钟；同文案页面 throw／reject、true、正常 false；input/evaluate 完成状态                                          | 读取或预算超时为 unavailable，脚本异常为 error，正常 false 为 not_matched；严格保留 70 ms，主动作只执行一次，顶层 retryable=false，校验重试标记独立，pending RPC 最终为 0 |

| 编号       | 条件与入口                                                                                                                                                                                 | 验收                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| C31F6-01   | 合法 MathML math→mtext→HTML span 的 block math／inline math；SVG viewport、foreignObject 与 HTML 子盒；聚焦文本 input 的 computed clip 内部横滚；普通 HTML、表单及真实零范围控制           | 比较实际命中、自身、祖先及 viewport，真实滚动盒和边界保留，普通 SVG 不因 block/hidden 声明形成虚假边界                                             |
| C31F6-02-A | ruby-text 的 transform／translate／rotate／scale／perspective／will-change:transform；ruby-text filter、table-row transform、inline／atomic inline／block 控制                             | 按各属性适用资格判断，保留有效 filter 和表格包含块，非适用盒不改变固定目标的滚动链                                                                 |
| C31F6-02-B | 内置 will-change 属性名的大写、混合大小写和多值；当前 Chrome 生效的 -webkit 别名；小写、unknown／custom ident／stacking-only 控制                                                          | 大小写与有效别名保持实际包含块效果，CSS.supports 仅作为语法记录，行为由定位与滚动对照验收                                                          |
| C31F6-02-C | computed preserve-3d 及 used-flat 条件、offset-path、明确 offset-position 和相关 hint；flat、none、normal／auto、独立 distance／rotate、backface 的实际 3D 条件、container-type 控制       | 区分属性族、computed/used 值与盒资格，分别比较真实包含块、命中及滚动                                                                               |
| C31F6-02-D | HTML→SVG→foreignObject→HTML 的默认包含块，以及显式 transform／layout containment 对照；fixed／absolute                                                                                     | 默认嵌入关系和显式属性均保持真实定位与滚动链                                                                                                       |
| C31F6-02-E | light DOM 的 fixed／absolute 目标投影到 transformed block slot，composed 路径为 inner→slot→middle→host→outer，offsetParent 返回同 root 的 host；移除 slot transform 对照                   | 更近的有效 composed 包含块优先，middle 正常消费；静态 slot 控制恢复 host 布局链，覆盖两模式、主文档／iframe 与 X 轴代表                            |
| C31F6-03   | 实际 SDK＋生产 CDPClient＋真实 Chrome：读取中断、iframe[／div[ 原生 SyntaxError、页面异常字符串转换再次抛错、主动作 ACK 后总 deadline 到期；普通 throw／reject、true／false、组合 AND 控制 | 传输／环境读取不可用为 unavailable，页面或选择器错误为 error；总期限到期零验证派发，主动作一次且 completed、顶层 retryable=false，校验自身重试独立 |
| C31F6-04   | 真实 keydown→wheel／mouse→keyup，Ctrl／Shift／Alt／Meta／Ctrl+Shift；move/down/up、click/contextmenu、precise 右键、force/ref/actionable_click；无修饰键和 precise 原生控制                | 事件四字段完整保留，应用监听器动作及 preventDefault 生效，释放后字段清零，原有无修饰键默认行为保持                                                 |
| C31F6-05   | 实际 SDK＋真实 Chrome 的普通、translate、scale2 点与 scale2 selector；边框、origin、嵌套 scale／rotate／skew／反射、OOPIF；Extension precise 与 stealth、touch／drag 共享入口              | 以真实命中验收当前输入视口映射，selector 无重复变换，滚动后重新取得几何；不可靠／失效映射当前事件零派发，保留前序完成事实及 target/frame 恢复      |
| C31F6-06   | 实际 SDK：Shift down，timeout=5000，false 检查 timeout=4000／interval=2000，确认本地等待后取消；后继 500 ms evaluate／400 ms input；既有按键、正常持键、在途读取和清理失败对照             | 取消及时结束等待，新增键得到有界释放后解除锁，既有键保持；DOM／内部键状态、timer／监听器终态分别验证，SDK 抑制取消业务回包与内部 handler 记录分开  |
| C31F6-07   | 无取消竞争：第一请求真实派发并占锁 900 ms，第二请求 timeout=250；evaluate／input 对照，以及真正派发后 ACK 不明控制                                                                         | 未开始请求零脚本派发，可信 false／status／queue 与全部顶层字段一致；已派发未知保持 unknown，完成事实保持，动作不重放                               |
| C31F6-08   | 8 次 ±0.25／+0.5／+1，合法 wait.ms=50；方向反转、目标／文档变化、页面自行滚动、短长间隔、方向边界及 snap 小数对照                                                                          | 逐事件与最终累计分别核对；量化暂未产生位移仍由当前容器消费，真实边界按策略传播，snap／clamp 差值不成为后续残差                                     |
| C31F6-09   | 监听器移除 target／container、reparent，preventDefault 后移除、无变更、合法页面自行滚动、passive／stopPropagation 控制                                                                     | 不误滚新父容器或无关 viewport，保留页面滚动与有效取消；reparent 的旧 outer 按原生稳定观察比较，不强行规定固定增量                                  |
| C31F6-10   | CSS zoom:2、transform:scale(2)、嵌套 zoom、frame 继承及元素／viewport 单位，两轴正负和边界传播                                                                                             | 元素增量按有效 CSS zoom 换算，一般 transform scale 保持原输入增量语义，viewport 单位独立验收                                                       |
| C31F6-11   | standards／quirks 的 body block／contents、hidden／auto，root visible／显式 overflow 与 containment 控制                                                                                   | 无主盒 body 不提供 viewport overflow，quirks 的特殊 client／scroll 尺寸如实记录，主盒与尺寸分别判断                                                |
| C31F6-SNAP | 100 px mandatory 列表从 400 输入 ±40，含 contain；proximity、无 snap 和 +200 控制，等待至少 800 ms 且取得 8 次稳定样本                                                                     | 接受程序化吸附终点，另记录原生 wheel 终点；按此兼容性合同判断，其他滚动偏差仍独立验收                                                              |

| 编号     | 条件与入口                                                                                                                                                                | 验收                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| C31F7-01 | 安装当前 Extension，通过实际 SDK、生产 sendCommand/handleMessage 和 parser，主文档／iframe 的验证 marker 后原生 terminate；evaluate/input、页面同文案及非法方法／参数控制 | 原生中断为 unavailable，页面异常和协议参数错误为 error，保留 native method/code/message；主动作一次且 completed，顶层 retryable=false，子校验重试独立 |
| C31F7-02 | 普通／变换 iframe，scroll 监听器将目标 left 从 80 改为 240，move/down-up/touch/click、两模式及 CDP；touchstart 后再移位以产生真实 touchmove                               | 滚动事件与其监听器完成后读取当前局部几何，断言事件发生时的目标、rect 和实际坐标，并取得独立原生参照；协议整数取整单列，目标失效时当前事件零派发       |
| C31F7-03 | 自然 200 ms 总预算，仅保持已成功完成的第一份 page_snapshot ACK，evaluate/input 用户动作零派发；迟到 ACK、真正 unknown、completed 和队列控制                               | 顶层 false/not_started/context，pageContext.contextPhase=before，原 RPC unknown 保留在 error 详情，原 Error 对象和类型保持，后继动作不重放            |
| C31F7-04 | foreignObject 自身 overflow:auto，以及 hidden+contain/none，两轴正负；普通 SVG、foreignObject 内 HTML 盒控制                                                              | 自身可滚动时优先消费，hidden 边界正确阻断，普通 SVG 不形成虚假边界，两种 Extension 模式共享行为                                                       |
| C31F7-05 | 高 99.8／宽 219.8、zoom 2 的真实末端，整数尺寸与内部位置对照；120 和连续八次 0.25，X/Y、RTL／反向布局及 auto/contain/none                                                 | 当前调用栈内区分真实末端与尚未量化的输入，实际末端立即按策略传播；ScrollTimeline 的空值、实时值和浮点端点精度分别记录，保留 transform 与 snap 控制    |
| C31F7-06 | 同容器每次替换命中子节点、监听器每次 scrollBy50、两者组合；八次 0.25、间隔 50 ms，preventDefault 及新容器／文档、外部位置、zoom、方向和 snap 控制                         | 同容器余量连续，事件内页面位移与工具位移分别计算，事件间独立位置变化仍重置，分别核对 402／802 及每步位置，不把 clamp/snap 差值作为后续余量            |
| C31F7-07 | 坐标专项正常结束和资源关闭失败控制，另保留业务失败与清理失败同时发生                                                                                                      | 使用真实 close API，各资源独立关闭，正常无 cleanupError，任何清理失败产生非零退出，原业务错误与资源终态保留                                           |

| 编号     | 条件与入口                                                                                                                                                                                     | 验收                                                                                                                                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C31F8-01 | 主文档／iframe、precise／stealth，普通 scroll、stopPropagation、stopImmediatePropagation 和 Window capture 阻断；滚动监听器将目标 left 从 80 改为 240，mousemove 与 down-up                    | 可见页面完成滚动与渲染步骤后读取当前局部矩形，传播阻断不耗尽取点预算；实际事件命中目标且位于事件当时的矩形中心，独立原生参照命中相同目标                                                                            |
| C31F8-02 | light DOM 目标通过 assignedSlot 投影到 Shadow 滚动盒，沿 slot／host 路径滚动，覆盖 C31F8-01 的传播、frame 和输入模式条件                                                                       | 使用实际滚动盒完成后的布局取点，事件坐标与当前 frame-local 矩形一致，目标引用失效控制保持                                                                                                                           |
| C31F8-03 | 初始 before 快照成功后，保持已成功完成的第二份条件快照 ACK，自然 300 ms 总预算到期；evaluate 使用真实 expectedUrl，input 使用真实 expectedRevision；Extension／CDP、复用 Error 与迟到 ACK 控制 | 主脚本／输入零派发，顶层 false/not_started/precondition，pageContext.contextPhase=precondition，原 Error 身份及辅助 RPC unknown 保留；真实动作 unknown、completed 后元信息失败和后继请求保持原语义                  |
| C31F8-BG | 自有后台主文档／iframe，precise／stealth 的 mousemove 与 down-up，滚动监听器阻断传播，另有独立原生参照                                                                                         | 页面始终 hidden，取点按当前布局完成，不等待暂停的动画帧；precise 返回 NATIVE_INPUT_UNAVAILABLE、false/not_started、retryable=false，eventsExecuted=0，原生派发及工具 DOM 事件均为 0；stealth 完成且命中当前目标中心 |

| 编号     | 条件与入口                                                                                                                                        | 验收                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C31F9-01 | 真实 SDK 调用中的目标列表、选择、frame、Challenge、diagnostics、globalThis 与逐事件准备回执未知；主脚本／输入实际派发及前序事件控制               | 主动作未派发时为 false/not_started/context，条件读取使用 precondition，前序事件保留；原 Error、码与辅助 unknown 保留，真正派发后未知仍为 unknown，迟到回执不重放 |
| C31F9-02 | precise／stealth、参数／无参数下的可信 Function 编译策略拒绝、同 CSP 文案页面 throw／reject 和用户脚本内部 eval 拒绝                              | 仅可信编译拒绝返回 CSP_BLOCKED 且脚本未开始，页面异常保留原文与来源；分别记录受控矩阵和真实浏览器 CSP 结果                                                       |
| C31F9-03 | controlled 输入的普通容器、disabled、readonly、file input，以及合法 input／textarea／select／contenteditable                                      | 不支持的目标在 focus、setter 与 input/change 前拒绝，合法控件保留原生 setter，文本和事件只更新一次                                                               |
| C31F9-04 | 一个显式页面长等待期间读取／更新另一页面的无条件 pageMetadata，再对照带 expectedUrl／expectedRevision 的备注请求                                  | 无条件备注按显式目标独立完成，其他请求保持其页面和 frame；带条件备注仍按串行条件检查，失败保留原备注                                                             |
| C31F9-05 | 前序动作持锁，newPage 的显式 timeout 在队列中耗尽，另对照默认管理期限、正常创建与取消                                                             | 超期请求返回明确错误且零创建，默认期限为 30000 ms；后继请求仍可执行，已派发动作保留实际结果                                                                      |
| C31F9-06 | 同一浏览器事件 controller 发生超过 20 次具名清理失败，包含可观测 ref、request ID、target、owner 和 native session，再 dispose 并创建新 controller | 字符串与详情逐项对应，只保留最新 20 条；时间、阶段和归属正确，dispose 清除记录，新 controller 为空，已返回详情保持原归属                                         |

| 编号     | 条件与入口                                                                                                                                         | 验收                                                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| C31F9-07 | 主文档／iframe、precise／stealth、mousemove／down-up，真实 visible→hidden、hidden→visible 及两种往返转换，转换发生在取点准备期间                   | 保留真实 visibilitychange 时间和状态；结束时按当前布局取点，输入命中事件当时的矩形中心；precise 不可用时明确拒绝且零输入；转换不等待暂停的 rAF       |
| C31F9-08 | 主文档／iframe、precise／stealth、mousemove／down-up，document、rAF 与嵌套滚动盒的监听器触发后续滚动                                               | 最终滚动监听器处理完成后取得当前局部几何；实际事件命中目标中心，独立原生参照命中相同目标；持续滚动在原期限结束且该事件零输入                         |
| C31F9-09 | CDP precise、Extension precise／stealth 的主文档／iframe，真实滚动监听器改变目标位置后的 click／touch                                              | 保留相邻输入入口，事件坐标与当时 rect 一致，独立原生鼠标／触摸参照命中同一目标                                                                       |
| C31F9-10 | CSS＋exact 文本区分评分 2／-2；role=tab、name 的部分与精确匹配，嵌套 span、隐藏后代及显式名称优先级；主文档／iframe、两后端和 Extension 两输入模式 | 精确评分只命中正值；tab 等内容命名角色取得可见后代名称，点击实际选中对应 tab；原标签优先级与隐藏规则保持                                             |
| C31F9-11 | 使用 README 的 TagInput 示例输入文字、显式 Enter down/up，在主文档／iframe、CDP precise 与 Extension precise／stealth 下提交                       | 真实页面生成对应标签且 postCondition 匹配；记录事件完成数和页面标签文本，具体业务站点按实际控件另验                                                  |
| C31F9-12 | 两后端先 download watch，再点击本地 HTTP attachment，等待独立 Chrome 完成下载，读取 download 日志                                                  | 文件内容正确，日志提供 completed 的原生下载 ref 和可用原始附件，stop 结束观察；隔离 profile 的下载目录由测试载体指定                                 |
| C31F9-13 | 预算回调在 deadline−1 交付，对照导航等待、队列、Extension RPC、诊断准备与后续页面包装                                                              | 保留原回调立即结束合同；RPC 仍为 unknown 并发送 cancel，handler 清空；诊断传播同一预算 Error，预算结束后零额外上下文读取，原 C-P6/C31F5/C02/C19 保持 |

| 编号           | 条件与入口                                                                                                                                             | 验收                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| C31F10-01      | 主动作的 frame 准备回执保持期间，同页／跨页无条件 pageMetadata 读取、更新、null 清空，以及带自身条件的串行控制                                         | 无条件备注独立完成且不继承或消费主动作条件；URL 改变后主动作按原条件拒绝，零业务效果，条件与 frame 在请求结束后清除                 |
| C31F10-02      | 预算回调在 deadline−1 结算，覆盖 list、snapshot、diagnostics 各阶段与已按下键的释放                                                                    | 原预算 Error 与动作事实保持；结算后停止新增业务和后读，独立有界清理释放按键；业务派发与清理分别计数，迟到 ACK 不恢复请求            |
| C31F10-03      | 页面 throw／reject 的 JSON 文本含 CSP 或业务 code、context 和额外字段，对照真实类型化工具错误及正常结构化返回                                          | 页面消息按原文输出，页面字段不改变顶层动作事实，不生成焦点建议；可信工具错误与正常返回结构保持                                      |
| C31F10-04      | primitive 字符串 throw／reject，参数／无参数、主文档／iframe、CDP precise 与 Extension precise／stealth；公共提取器另验空串、0、false、null、undefined | 保留无 description 时的 primitive value，已有 description／堆栈优先；原动作失败与来源保持                                           |
| C31F10-05      | input／textarea／select 位于 disabled fieldset 内，对照首个 legend 和普通可用控件                                                                      | 有效禁用时拒绝且零 focus、setter 和输入事件；首个 legend 内合法控件可更新                                                           |
| C31F10-06      | ordinary 与 customized built-in 的 input／textarea／select，对照原生 setter 缺失                                                                       | 按实际表单接口选择原生 setter，更新和 input/change 各一次；setter 缺失时明确失败且零副作用                                          |
| C31F10-FOREIGN | 同源 iframe 创建控件后 adopt 至当前文档，保留 foreign prototype，并对照 adopt 的 file input                                                            | CSS 定位到同一节点，ownerDocument 为当前文档且 local instanceof 为 false；合法控件正常更新，file 在 focus 和输入事件前拒绝          |
| C31F10-CASCADE | 祖先滚动后依次滚动一个或两个非祖先 sibling，最终监听器移动目标；主文档／iframe、precise／stealth、mousemove／down-up                                   | 保留真实滚动和输入时序，实际事件命中当时的目标中心，独立原生参照命中相同目标；模型另验 Shadow root 的非冒泡通知、传播阻断及资源清理 |
| C31F10-T01     | 准备阶段超期后的目标恢复，分别读取 restored／failed 的真实终态                                                                                         | restored 对应原目标，failed 对应清空目标和恢复错误；主动作零派发、辅助 unknown、前序进度与清理状态按原断言验收                      |

| 编号       | 条件与入口                                                                                                                                | 验收                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| C31F11-01  | stealth 返回循环对象、BigInt、toJSON 抛错、Node、NodeList、HTMLCollection，对照正常结构化返回；主文档／iframe、参数／无参数               | 脚本执行一次，序列化失败为 NON_SERIALIZABLE_EVALUATE_RESULT，actionExecuted=true、completed/output、retryable=false；正常返回值保持 |
| C31F11-02  | throw／Promise.reject 空字符串，对照页面抛出伪造 output 标记及同名结构化错误 JSON；两后端、precise／stealth、主文档／iframe、参数／无参数 | 空原文保持，页面 JSON 按原文返回，类别仍为页面动作失败，页面字段不改变顶层 completed／failed 事实                                   |
| C31F11-03  | open／refresh／back／forward 的生产导航等待在请求 deadline−1 或 deadline 结算；三类等待器分别对照整请求期限与较短子操作期限               | 整请求结算保存并传播同一预算 Error，停止后续页面与诊断读取，导航只派发一次且保持 unknown／非重试；较短等待超时保留剩余请求预算      |
| C31F11-T01 | adopt 控件在主动作前检查 localInstance=false、foreignInstance=true；另用正确／错误 realm 观测记录检验前提断言                             | 错误 realm 在业务派发前拒绝；真实 Chrome 合法控件更新和 adopted file 零输入副作用保持                                               |
| C31F11-OBS | 另一 Shadow root 内 sibling 级联、提前注册的 document capture 监听器触发级联后阻断传播、目标稳定时无关 scroller 持续滚动                  | 按实际事件命中、事件时 rect、动作终态和期限裁定；保留原生时序和独立参照，无关滚动保持目标可操作                                     |

| 编号        | 条件与入口                                                                                                                                                                                                                                     | 验收                                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C31F12-01   | 返回值完成 Promise 等待后的 Proxy getPrototypeOf、Node 及集合诊断 getter 抛错；JSON.stringify 抛错或返回非法／空／非字符串结果、错误详情 JSON 结构无效；对照合法 undefined／函数／0／false／null／空字符串及 revoked Proxy 的 Promise adoption | 输出检查、结果及错误详情解析异常保持 NON_SERIALIZABLE_EVALUATE_RESULT、completed/output、actionExecuted=true、retryable=false；摘要生成失败保留原文并报告具体失败；合法返回值保持，Promise 等待拒绝与页面主动抛错保持页面动作失败 |
| C31F12-02   | back／forward 主命令明确拒绝、重复拒绝、正常完成、无历史、请求取消和断连                                                                                                                                                                       | 返回原 Error，局部等待的 timer、事件与 disconnected 监听器立即释放；主命令不重放，局部取消不结束仍有效的请求预算，后继请求可用                                                                                                    |
| C31F12-O-S1 | 准备开始后由滚动监听器新建外部 open Shadow root，再在该 root 中滚动并移动目标                                                                                                                                                                  | 每次稳定采样纳入新 root；保留实际输入时 rect、命中、当前返回快照与后续级联终态，按实际错误命中裁定                                                                                                                                |
| C31F12-O-S2 | 同一外部源在 scroll 监听器中同步再次滚动，数次后才移动目标；对照无关 rAF 滚动与重复使用的事件对象                                                                                                                                              | 用 scroll 至 scrollend 的偏移变化识别同步后续滚动；同次传播保留首个观察偏移，后续派发更新采样；相关同步级联等待结束，无关 rAF 滚动保持稳定目标可操作，全部监听器按原期限清理                                                      |

| 编号                | 条件与入口                                                                                                                                         | 验收                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| C31F13-AUX          | mousemove、非左键 click、touchstart、mousedown 的坐标准备求值在类型检查、摘要生成、结果解析或错误详情解析失败，主文档／iframe，对照前序键盘事件    | 首个输入未派发时 false/not_started/context，零坐标输入；前序已确认输入保持计数，辅助错误原完成事实与原错误码保持，后续事件不派发                     |
| C31F13-DIAG         | 首次输出异常后，错误摘要序列化返回坏 JSON、空串、缺字段、JSON null、非字符串数值或 null；主文档／iframe、参数／无参数                              | error.context.originalOutputError 保留首次诊断，后续解析错误及 completed/output 保持；页面主动抛错的原文与来源保持                                   |
| C31F13-SCROLL-OBS   | 稳定目标旁的持续同步自滚动，precise／stealth、主文档／iframe、mousemove／down-up，纳入默认观察条件，也可用 COORD_FILTER 含 sync-unrelated 定向执行 | 原 completed 可操作性断言保持；主输入命中当时目标矩形，独立原生参照保持同一滚动负载且命中相同目标，返回后监听器与 MessagePort 已释放，取消时零主输入 |
| C31F14-FRAME-PROBE  | 可用的所选 iframe 旁有注入拒绝或持续加载的兄弟 frame，分别延迟父页面 isolated／MAIN world 的 500 ms 定时器，对照普通本地文件页                     | selector／index 映射保持真实 sender、document 与 owner 校验；所选 iframe 正常读取，未依赖页面定时器，兄弟 frame 的不可用原因可见                     |
| C31F14-FRAME-CANCEL | child listener 安装、DOM 与 CDP owner 探测等待期间取消、请求期限耗尽或等待 API 拒绝，随后执行同 tab 请求                                           | 安装等待按 Extension 计时和请求期限结束，不可用原因可见；主脚本未派发时保留 false/not_started；探测资源释放，晚到探测拒绝，后继请求可用              |

C31F9／C31F10 的阶段、错误、管理与清理控制位于 `test/finding-regressions.test.js`、`test/browser-events.test.js`，请求条件隔离与预算 SDK 条件通过 `test/review-c31f10-request-lifecycle.test.js` 纳入常规测试；Extension 编译、controlled 及 Shadow 事件控制由现有 Vite 测试入口执行
滚动等待单测执行生产生成脚本，核对级联、隐藏、可见性转换、持续滚动期限，以及所有 scroll／scrollend／visibilitychange 监听器、rAF、计时器和 MessagePort 的清理；`test/review-scroll-settlement.test.js` 纳入 `npm test`，覆盖无关循环滚动、有限级联、持续目标移动和取消后的清理
frame 探测模型由 Extension 的 ER-08 执行实际注入函数，页面计时器调用直接失败，ER-08a 验证 listener 安装等待的默认期限、取消、请求期限和迟到拒绝；受控计时回调提前 1 ms 时，核对继续等待原绝对期限、TIMEOUT 分类和主脚本零派发；原生验收在独立 Chrome 中使用实际 Extension API，控制的页面计时器或原生 API 延迟须与自然后台限频分别记录

C31F6／C31F7／C31F8／C31F9／C31F10 验收按语义子条件记录来源、输入、实际命中、事件字段、位置／页面计数和资源终态，实际 SDK、注册 handler、原生参照序列／事件与布局观测分别计数
真实浏览器结果与 VM／合成协议结果分开，受控 Date 仅用于声明的总预算边界；原 C02 的 70 ms 真实期限和 C19 的 1 ms／原断言保持，首次失败与最终结果分别保存到执行材料

两端构建完成后，使用同一 Chrome 执行 C31F6 专项入口，第二个参数可指定 JSON 结果位置：

```bash
node test/review-c31f6-lifecycle-native.mjs /path/to/chrome [OUTPUT_JSON]
node test/review-c31f6-wheel-native.mjs /path/to/chrome [OUTPUT_JSON]
node test/review-c31f6-coordinates-native.mjs /path/to/chrome [OUTPUT_JSON]
```

lifecycle 使用实际 SDK 与生产 CDPClient，wheel 使用安装当前生产模块的 Extension handler，coordinates 使用实际 SDK、生产 Bridge 参数和安装的 ActionHandler；coordinates 的测试载体传输与正式 Extension 发现连接分别判断，具体受控条件和调用分类记录在各入口的结果中
wheel 默认执行全部语义条件，`C31F6_WHEEL_ONLY=1` 限定滚动分区，`C31F6_CASE_FILTER` 用正则筛选滚动条件 ID；定向结果按实际选择记录，不替代完整验收
coordinates 的 `COORD_MODE=cdp|extension` 选择后端，`COORD_FILTER` 用正则筛选条件 ID；`^extension-late-metadata-` 覆盖已匹配校验之后、页面信息读取期间到期／取消的主文档与 iframe 控制，核对原 tab/session 的 native keyup、原文档键终态、默认页／父文档无按键、handler 结束与 500 ms evaluate／400 ms input 后继请求
晚 metadata 控制仅保持真实成功 page_snapshot 的响应交付，等待使用生产预算／取消 helper；实际 SDK 回包、内部 handler 完成、DOM 事件与测试页最终清理分别记录
lifecycle 的 `C31F6_LIFECYCLE_FILTER` 按条件名称筛选，`execution-(terminated|timeout)$` 对比原生终止／原生超时和同文案页面异常；终止由独立观测连接在收到脚本 console marker 后执行 Runtime.terminateExecution，原生超时组将同一验证函数与参数改由 Runtime.evaluate 的 1 ms 期限执行，本地请求期限保持，记录实际原生错误码与页面异常来源
coordinates 的 `^dynamic-zoom-` 在同一输入请求内由 wheel 监听器改变 iframe／祖先 zoom，比较 1→2、2→1、1→1、单层／嵌套与 point／selector 的实际命中；`^zoom-anchor-` 核对独立 rotate／负 scale 参考盒拒绝、零原生派发和前序 wait 完成事实

C31F7 条件复用上述三个入口：coordinates 的 `^c31f7-origin-` 核对真实原生终止及页面同文案，`^c31f7-before-snapshot-` 核对主动作零派发与原 RPC unknown，`^c31f7-scroll-` 核对实际滚动监听器之后的取点和原生命中；wheel 的 `^c31f7-` 覆盖 foreignObject 自身、分数末端和同容器余量，`^c31f7-boundary-probe-` 为纵轴八组基础观测

C31F8 使用 coordinates 的 `COORD_MODE=extension COORD_FILTER='^c31f8-'`：`^c31f8-scroll-` 覆盖传播与 assignedSlot，`^c31f8-condition-snapshot-` 保持第二份条件快照，`^c31f8-hidden-` 分别核对后台 precise 明确拒绝与 stealth 成功；单测 `finding-regressions.test.js` 的 C31F8 条件覆盖两后端、两种 expected 条件、原 Error 复用、迟到 ACK 和后继请求

C31F9 使用 coordinates 的 `^c31f9-csp-`、`^c31f9-visibility-`、`^c31f9-cascade-`、`^c31f9-adjacent-` 和 `^c31f9-semantic-` 过滤器分别执行真实 CSP、可见性、滚动级联、相邻输入与语义定位条件，`^c31f9-taginput-` 验证标签提交示例，`^c31f9-download-` 复核下载观察与真实文件的对应关系
CSP 页面由本地 HTTP 服务发送真实策略 header；页面异常、动态编译拒绝和用户脚本内部 eval 拒绝分别验收
可见性条件使用真实 tab 转换，并保持页面 rAF／MessageChannel 准备回调至转换结束；document／rAF／nested 级联条件均在同一个 scroller 上二次滚动

C31F10 的 `^c31f10-controlled-` 验证 disabled fieldset、first legend、customized built-in 与同源 adopt 控件；`^c31f10-primitive-` 验证真实浏览器 primitive 字符串异常；`^c31f10-cascade-` 验证祖先、单 sibling 与 two-sibling 的真实滚动级联
常规 SDK 条件隔离与 deadline−1 预算结算由 `test/review-c31f10-request-lifecycle.test.js` 执行，受控 Extension peer 和时钟边界在结果中注明；真实 Node/V8 Inspector 的异常响应与真实 Chrome 结果分别记录
C31F11 的常规输出与导航回归由 `test/review-c31f11-output.test.js`、`test/review-c31f11-navigation.test.js` 执行；coordinates 的 `^c31f11-output-` 验证真实浏览器空异常、可信输出失败与正常返回，`^c31f11-observation-` 记录三项坐标观察的真实时序和命中
外来 realm 用例在主动作前断言 localInstance=false、foreignInstance=true，错误前提直接终止该用例

额外边界调查使用 `C31F7_BOUNDARY_OBSERVATIONS=1` 配合 `C31F6_WHEEL_ONLY=1`、`C31F6_CASE_FILTER=^c31f7-boundary-listener-`，记录监听器同次改变尺寸并在内部／末端间移位的原生路由；各次原生结果分别保留，差异仍返回 FAIL 和非零退出，原生路由未稳定时保持未裁定并单独统计

同阶段边界验收在独立进程中增加 `C31F7_WHEEL_PHASE_CONTROL=1`，仍筛选上述边界条件并限定滚动分区；每份工具及原生输入都在配置页面期间推进虚拟时钟，输入前暂停时钟，使监听器执行期间保持相同的渲染阶段，结果注明 `renderPhaseControl`，位置仍按原 0.02 CSS px 容差逐项比较，事件次数、原始输入和等待预算保持

同阶段条件应覆盖 X／Y、auto／contain／none、内部到末端及末端到内部，并与相同条件的原生对原生重复控制一起判断；原生对原生出现差异时保留 FAIL，恢复调查，默认时钟的原始调查结果继续单列

Extension 模型同时验证监听器改变尺寸后的起始路径、范围归零、有效取消和三个 overscroll 策略；`remove-target`、`remove-container`、reparent、小数余量及程序化吸附仍由原默认矩阵验收

wheel 入口筛选 `^integer$` 并使用 `WHEEL_CLEANUP_FAILURE=http`，在实际关闭 HTTP 后注入一次具名清理失败，应保留原业务结果、完成 Chrome、日志、pipe 和 profile 清理，并返回 ERROR 和非零退出；再同时设置 `WHEEL_BUSINESS_FAILURE=integer`，核对 `businessStatus=FAIL`、受控业务错误、`cleanupErrors` 与最终资源状态

coordinates 的 `COORD_CLEANUP_FAILURE=session` 在实际关闭该资源后产生一次具名清理失败，用单个正常条件执行时应得到 ERROR 和非零退出；核对 observer、Chrome、HTTP 和 pipe 仍完成清理，完整正常运行应无 cleanupError；再与 `COORD_BUSINESS_FAILURE=ordinary-point-mousemove` 同用，筛选该条件，核对最终 FAIL、原业务错误和具名清理错误同时保留

安装 Extension 的四个 TypeScript 测试入口使用 test/tsconfig.json，继承现有 Extension 编译选项，执行无输出语义检查：

```bash
node node_modules/typescript7/bin/tsc -p test/tsconfig.json --noEmit
```

`test/review-c31f5-post-condition.test.js` 通过实际 SDK 和生产注册入口、UnifiedSession、Bridge／HttpServer 验证期限分类，socket 和浏览器结果为受控合成数据，纯自有脚本在 Node 中执行；确定性边界只在读取派发后固定 Date.now，setTimeout 采样保留原生调用与句柄，未改时钟的 70 ms 组单独保留

```bash
node --test test/review-c31f5-post-condition.test.js test/review-input.test.js
```

原生 wheel 矩阵保留既有组，`source="report"` 标记原报告九组 display 与七组 fixed 包含块场景，两模式和两种 frame 共 64 对；`source="extended"` 单独标记相邻布局扩展，包括 block ruby 的 auto／hidden + contain 及普通 inline ruby 控制，分别记录实际发出的公开输入和原生参照，失败前置不增加调用计数

`test/review-c31f4-cancellation.test.js` 使用现有 Vite 从 `test/review-c31f4-extension.ts` 构建当前生产模块，Chrome API 和 socket 为受控接口，请求与取消由实际 SDK、HttpClient、ActionHandler 执行，文件发布使用真实本地文件系统

C19 的 origin-wait 字段传递语义中，verification-failure 保留 1 ms 和原 not_matched 断言，使用受控时钟完成正常 false 读取后再推进期限，合成返回值保持生产的 matched 对象形状
C02 的表达式／函数／async／Promise／false／抛错语义使用内置受控时钟；真实预算测试保留 70 ms 及 unavailable／retryable=true 断言，单独记录读取与预算时序，完整运行与定向运行的结果分别保存在对应执行材料中

Cookie 原生资源回归使用独立 profile、BrowserContext、A/B 页面和合成 Cookie，先构建 Server，再执行：

```bash
node test/review-c31f3-cookie-native.mjs /path/to/chrome [OUTPUT_JSON]
```

该入口保持原生连接直到资源存活与回收断言完成，取消通过实际 SDK 通知，pipe 仅控制指定 ACK 交付；构造 attach 拒绝时等待 getTargets 确认目标消失，再派发 attach 并核对其原生错误，另保留成功 attach 后关闭页面的控制，sdkCalls 在实际调用发出时计数，completedChecks 单独记录；命名的清理失败场景注入一次 detach 协议拒绝，分别记录真实资源存活、可见未知状态及探针最终清理

原生 wheel 回归需要支持 Extensions.loadUnpacked 的 Chrome 和 Extension 开发依赖，在 mcp-chrome 目录先完成两端构建，再执行：

```bash
node test/review-c31f2-native.mjs /path/to/chrome
```

该入口创建独立 headless 浏览器、profile、测试 Extension 与本地合成页面，保留生产 driver 选择、tab/frame 作用域、input cleanup 和 Bridge/HttpServer，命令输运与页面元信息由测试适配，结果写入本次临时目录并输出路径，可用第二个路径参数指定 JSON 位置；单轴输入比较目标自身、container/祖先/root/body/viewport 的完整原生 wheel 位置，混合输入使用重建页面上的 X-only、Y-only 原生事件分别比较，记录原始快照及事件 isTrusted

原生浏览器定向验收使用独立 profile、隔离 CDP 浏览器或隔离 Extension 和合成页面、Cookie；记录真实 frameId、documentId、旧新文档的 wheel/滚动计数及 Cookie 保留集合，页面脚本或 VM 回归与真实 Extension／桌面行为分别记录

验收标准：

- server smoke 必须通过 SDK stdio transport 完成 initialize 和 tools/list，并精确返回
  `browse`、`input`、`extract`、`wait`、`cookies`、`logs`、`evaluate`、`manage` 八个工具
- `F032`：默认页被外部关闭后，完整 tabs 与 topology 入口均清除失效默认 ID，不选择其他页；`targetIds` 和 `managedOnly`
  过滤子集保留仍存在的默认页
- `F038`：在 depth 边界读取嵌套 span 的确认、取消按钮，名称完整；ARIA/label 优先级、隐藏内容及 password 值保护保持有效
- `F041`：extract 的页面准备、frame、目标等待、read_page 和上下文元信息共用总预算，已派发超时保留 unknown 且不重放，零预算不派发读取
- `F072`：在隔离编辑器中确认默认 precise 换行派发 Enter；controlled 完整替换和 editorInsert 选区插入不派发
  Enter，末尾空选区用于追加，业务页面的提交与草稿须单独验收
- `F074`：dispatch_input 的空结果或缺少布尔 success 返回结构化 unknown，单次派发不重放；合法 null/void 辅助读取及 CH-13 的
  contenteditable、原生 value setter 仍成立
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
- 超过 60 秒但未收到 `loadingFinished` 或 `loadingFailed` 的请求仍保持 pending；容量丢失时 `networkidle`
  保持 timeout，直到新 root Document 开始或 tab cleanup；debugger detach 或 Network 观测未建立时返回明确观测错误
- `CS-N03`：让 CDP 输入序列阻塞在首次按键 RPC，同时请求 Extension
  connect；后者须等待输入和目标恢复，第二个按键仍发送到 CDP，结束后保留新模式
- `CS-N05`：同时连接 Extension 与显式 CDP，向 CDP target 传入 `frame`；成功解析或报告 CDP frame 错误，Extension 默认页的计数器不变
- `CS-N01`：在 CDP 页面 A 留下日志，临时在 B 执行 evaluate，再读 A/B 日志；各页日志保留且互不混用，显式
  clear、关闭目标和连接重置按各自范围清理
- `CS-N02`：模拟收到 200 响应头后响应体失败；保留 status 与 errorText，只记录一次终态；正常 body 完成后清理关联，其他 session
  事件不改变结果
- `CS-N04`：precise、stealth 与 CDP 分别覆盖 keydown/keyup 的准备过期、队列过期和末次 RPC 迟到；后续事件不执行，unknown
  不自动重放，剩余预算贯穿到 Extension
  deadline 和 CDP send
- `CE-R05`：首次 storage 读取延迟返回旧 true，其间显式设 false；下一次发现服务器仍拒绝无 token 连接；缺省设置继续自动连接本地
  Server
- `CE-N01`：两个同 URL iframe 在探测与 native
  owner 查询之间重排、保持相同数量；仍按 document/frame 身份选择原目标，document 失效时明确失败，副作用计数器不变
- `CE-N02`：分别让分组移动先执行、release 先执行、成员在等待锁期间变化；涉及成员按确定顺序串行，锁内重新检查权限与成员，拒绝分支无
  native
  move；向混合分组加入自有受控页仍保持原有权限合同
- `CE-N04`：后台 fulfilled 响应含 storage
  error 时，popup 显示保存失败、恢复按钮可用，并保留未保存 token 文本；不要求手动点击连接才能恢复正常调用
- `CE-N05`：diagnostics 关闭时显式 networkidle 仍在导航前建立 Network 观测；进行中的请求、启用失败和中途 detach 均不返回假空闲；默认
  load 不启用额外观测
- `DOC-C01`：newPage/updatePage 等不适用 action 传入 activate 时，在任何操作前拒绝；newPage 的 active 与 movePage 的
  activate 分别按既有合同工作
- 连续截图或激活超时：先核对当前 Server 与 Extension
  bundle 身份；受控测试页连续失败后检查公开错误与 pageContext，再用新 context 执行普通读取；只有当前构建实际复现时才能判定旧故障仍存在，不增加全局
  timeout
- PNG 解码必须拒绝重复 IHDR、IEND 后附加 chunk、超量解压和 scanline 缺失，并保留合法 RGB/RGBA 输入
- `tmp:` 输出位于带归属标记的单次 server 会话目录，超过 256 项或 128 MiB 时拒绝写入；成功写入 `tmp:` 的响应包含
  `retention` 清理条件，`cwd:`
  响应不包含；启动清理只删除归属已确认、超过 24 小时且所属进程已退出的会话，不删除旧版文件或 `cwd:` 文件
- 输出路径中的 Windows
  ADS、保留设备名、非法字符及组件末尾空格/点号必须在创建目录前被拒绝；Windows 上文件内容写入前必须验证私有 DACL，缺少
  PowerShell 或校验失败时返回
  `privacy_not_enforced_on_windows`

---

## 章节

1. [browse](#1-browse) — 9 actions
2. [cookies](#2-cookies) — 4 actions
3. [evaluate](#3-evaluate) — 2 modes + 参数矩阵
4. [extract](#4-extract) — 内容、状态与截图
5. [input](#5-input) — 键鼠、编辑与文件事件
6. [logs](#6-logs) — console、network、dialog、download
7. [manage](#7-manage) — 页面、环境与事件操作
8. [wait](#8-wait) — 4 types
9. [错误分支 / 边界](#9-错误分支--边界)
10. [test-page region 索引](#10-test-page-region-索引)
11. [npm 发布包](#11-npm-发布包)
12. [浏览器事件与定位上下文](#12-浏览器事件与定位上下文)
13. [CH 专项回归](#ch-专项回归)
14. [页面恢复与响应错误专项](#页面恢复与响应错误专项)
15. [Windows 兼容与页面授权专项](#windows-兼容与页面授权专项)
16. [已知限制](#附录-a已知限制--known-limit)

---

## 1. browse

### 请求、身份与资源反例

- `CH-03/04`：通过注册的 input/evaluate/wait callback 传入 SDK
  signal，覆盖预取消、排队取消、异步 attach/权限校验期间取消；释放原队列后页面计数器保持不变，输入后续事件不执行，本次按下的修饰键释放，正常请求仍可执行
- `CH-05/10/17`：发送一次副作用后断连，结果为 unknown、retryable=false、执行次数为 1；裸 return 在派发前包装，运行时主动抛出的同名
  SyntaxError 不重放；最终回执在
  deadline 前完成、本地恢复跨过期限时仍为 completed，真正迟到回执仍为 unknown
- `CH-06/07/19`：页面同时包含祖先、嵌套 span 组合文本和两个同名控件，纯文本只选择最内层完整匹配，nth 顺序确定；显式 XPath
  保留祖先顺序；非零尺寸的 visibility:hidden/collapse 对
  visible 不成功，对 hidden 成功；初始缺失的 hidden/detached 单次查询即成功，协议错误仍失败
- `CH-08/15/22`：先设定 390×844、DPR=2 的视口，再执行 fullPage，成功和失败后设备配置不变；检查内联与文件 metadata 中的
  degraded/fallback/limitations；
  捕获窗口图像期间触发 A→B→A，图像被丢弃，onActivated 监听清理，稳定 A 的对照成功
- `CH-09/20`：在途请求开始后调用独立 idle 等待，再 clear 日志，等待必须持续到请求结束加静默期；结束或失败只生成一条新记录，其他
  session 事件不改变等待
    - CDP 中分别创建 Blob 和 HTTP Worker，确认收到消息并结束 Worker 后，独立 idle 和同文档 `networkidle` 成功；覆盖等待前和等待期间的
      Worker 请求，保留原生 `requestWillBeSent` 的 `loaderId` 与终态事件记录
    - 使用普通页面 Fetch 和外部 Script 对照，覆盖等待前和等待期间发起请求；请求结束加静默期后才成功，超时、取消和断连清理等待器；清除日志后完成的有效请求仍可读取
    - 空 `loaderId` 标识 Worker 请求，其缺失终态不阻止页面静默；普通页面 Script 仍参与等待，判定保持网络静默合同
- `CH-11/18`：展开 length=3、仅索引 0 有值的数组和自有 **proto**
  数据键，分别保留尾部空槽与自有键；超预算 length 拒绝；定位、双采样、滚动和异常路径的句柄在最后消费者之后释放
- `CH-12/13`：连续读取四批各 1000 条 fallback console，后台只保留最近 1000 条、sequence 递增，clear 后为空；controlled
  contenteditable 替换完整文本并派发 input/change，input/textarea/select 的 value 行为保持原样
- `CH-14`：手动暂停后 keepalive 与普通 Worker 恢复均保持断开，Connect 恢复；完整 Extension
  reload 和浏览器重启后无需点击连接，自动发现服务器
- `CH-16`：仅用合成 token 验证 v2
  health、ready、hello、command、response、cancel、ping/pong，拒绝缺失 MAC、篡改 payload、方向反射、旧 session、乱序和重放；转发
  health 的终止端点不能派发裸命令；
  响应仅能返回原 socket；默认无 token 对照仍自动连接，旧严格协议返回明确诊断
- `CH-21/23`：唯一 URL 从 frame A 移到 B 时拒绝向 B 派发，默认副作用脚本不重放；touch
  precise 与 stealth 均向原 document 派发局部坐标，start/move/end/cancel 的目标一致，文档变化后拒绝继续
- `CH-T01/L01`：smoke 在 text+image 内容中按 type 查找图片，工具错误和缺图仍失败；隔离 PATH 只提供 chromium-browser 时
  headless 脚本选择该命令，端口和参数原样转发
- `CH-IMAGE-BUDGET`：生成超过 2 MiB 的单图、累计超过 8
  MiB 的图片和 25 张正常图片，确认单图/请求预算与 20 张附录限制分别生效；目录逐张写入，索引及内联标注保留省略原因

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
- 备注：不带 `port` 的 `connect` 回到 Extension，只有显式传 `port` 才选择 CDP；`legacy`
  表示旧 Extension 未上报 hash，`stale` 表示浏览器仍在运行旧 bundle，这两种状态都不阻断自动连接

### browse-list-01

- 前置：已连接
- 操作：`browse { action: "list" }`
- 断言：
    - `success=true`
    - `targets` 是非空数组
    - 每个元素包含 `targetId / type / url / title / mode / managed / isActive / windowId / index`
    - 默认 `details=summary`，Extension 返回 `windowCount / windows[].targetIds` 窗口关系
    - Chrome 有聚焦窗口时，`focusedWindowId` 指向该窗口，`activeTargetId` 指向该窗口的活动页面；所有窗口
      `focused=false` 时省略这两个字段，各窗口仍保留自己的 `activeTabId`
    - 窗口成员 ID 按 index 顺序排列，不重复完整 tab 对象，完整原生属性通过 `details=full` 获取
    - `targetIds` 和 `managedOnly=true` 筛选页面及所属关系，保留 revision/managed 与 false 原生值
    - favicon data URL 不出现在响应中，完整结果标为 `favIconInline=true`；列表不导航、激活或读取正文
- 载体：N/A

### browse-list-03-summary-filter

- 前置：同一测试窗口内有受控与已 release 的自有页面，包含分组和原生 false 属性，至少一个页面的 favicon 为 data URL
- 操作：分别请求缺省 list、`details=full`、`targetIds=[<T>]`、`managedOnly=true` 及两种筛选组合
- 断言：缺省摘要包含 targetId/managed/revision，完整模式保留原生 false 属性；窗口以 targetIds
  引用页面，不重复完整对象；筛选后窗口和分组只引用返回页面，total 计数保留全集数量；data
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
  `ExpectedOperationError`，保留错误消息，每次只执行一次调用、不返回假成功；截图尺寸预读失败后不附加 debugger；后台按既有策略记录
  warning 并发送失败响应，真实程序异常保留原错误对象
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
- 断言：返回 `INVALID_ARGUMENT`，消息要求至少一个非空 `name`、`domain` 或 `url` 过滤参数；
  `actionExecuted=false`、`actionStatus=not_started`、`retryable=false`，未返回 Cookie 数据
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
  finding-regressions 分别验证无结果、context 失效、注入拒绝、脚本错误、合法空文本/空数组/null 属性和 void 调用；Server
  回归验证错误类型、frame 信息及页面作用域恢复，不以无结果断定
  selector 非法，不重放脚本
- 载体：自有 iframe fixture
- 清理：仅删除本次增加的 fixture

### evaluate-precise-08-stale-default-no-replay

- 范围：Extension precise iframe；CDP 的原生错误和相同副作用计数对照见下一用例
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

- 范围：Extension precise iframe 的 `readOnly` 重试；CDP 对该策略在脚本派发前返回 `DRIVER_CAPABILITY_ERROR`，
  `actionExecuted=false`、`actionStatus="not_started"`、`retryable=false`，独立读取副作用计数保持 0
- CDP `never` 对照：使用上一用例的实际 context 销毁前置，保留原生 `CDP_ERROR`，返回 `actionExecuted=true`、
  `actionStatus="unknown"`、`retryable=false`，独立读取副作用计数为 1
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
- 反例：同 URL iframe 的 owner 探测在重试解析时遇到原生
  `No document with id`，在原 timeout 内重新取得当前 document，记录用户脚本执行次数为 2，解析次数独立计数；解析失败不再执行脚本，权限拒绝立即失败，默认
  `never` 保持执行 1 次
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
- 回归：现有 finding-regressions 覆盖协议 fallback 的参数传播及远端对象释放；CDP、stealth 和 iframe 的既有文件输出分别验证，不用
  mock 代替公开 MCP
- 载体：自有大对象 fixture
- 清理：仅删除本次输出

### evaluate-output-quota-01

- 前置：独立、有任务归属标记的临时环境；只填充本次 server 的输出目录，不使用用户已有目录
- 操作：分别使临时条目和字节配额达到上限，通过公开 `evaluate` 执行带唯一计数器的自有常量脚本并指定 `tmp:` 输出
- 断言：返回 `TEMP_OUTPUT_QUOTA_EXCEEDED`，context 包含
  `limits`、`usage`、`remaining`、`requested`、`projected`；完整扫描时占用和剩余准确，提前停止时
  `usage.complete=false`、占用为下界，`remaining`/`projected` 为 null
- 断言：`actionExecuted=true`、`actionStatus=completed`、`failureStage=output`、`retryable=false`
  ，计数器仅增加一次，已有文件内容不变，未创建拒绝路径的目录
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
  matched，wait、logs、extract 都命中 T2；T1 的 title、输入值和页面文本不变；每项操作后分别对 T1、T2 提取目标元素，确认没有改变默认目标或写错
  tab
- 截图条件：仅在两个测试页均具备可用 compositor
  frame 时增加截图核验；后台 Extension 页明确返回不可见错误时记录原因，不激活用户页面，目标隔离断言仍必须执行
- 载体：两个 test-page managed tab
- 清理：关闭 T1、T2

### evaluate-diagnostics-01

- 前置：自有 HTTP 测试页面的 `/mcp_diag_404` 明确返回 404
- 操作：

    ```javascript
    evaluate({
        script: "(async () => { console.warn('mcp_diag_warn'); " +
            "const response = await fetch('/mcp_diag_404'); " +
            "await response.text(); return response.status })()",
        diagnostics: true,
    })
    ```

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

- 状态：条件，与 `extract-screenshot-01-viewport` 复用同一独立测试环境
- 操作：`extract { type: "screenshot", fullPage: true, output: "cwd:test-output/mcp-fs.png" }`
- 断言：文件尺寸 > viewport-only 截图（test-page 总高明显大于视口）
- 载体：test-page

### extract-screenshot-03-jpeg

- 状态：条件，与 `extract-screenshot-01-viewport` 复用同一独立测试环境
- 操作：`extract { type: "screenshot", format: "jpeg", quality: 80, output: "cwd:test-output/mcp-s.jpg" }`
- 断言：`file ./test-output/mcp-s.jpg` 识别为 JPEG
- 清理：`rm ./test-output/mcp-s.jpg`

### extract-screenshot-04-element

- 状态：条件，与 `extract-screenshot-01-viewport` 复用同一独立测试环境
- 操作：`extract { type: "screenshot", target: { css: "#btn-id" }, output: "cwd:test-output/mcp-el.png" }`
- 断言：文件存在，尺寸 < 全页截图（仅包含按钮）；目标元素滚动后仍应截到元素本身，不应返回空白区域
- 清理：`rm ./test-output/mcp-el.png`

### extract-screenshot-05-scale

- 状态：条件，与 `extract-screenshot-01-viewport` 复用同一独立测试环境
- 操作：`extract { type: "screenshot", fullPage: true, scale: 0.5, output: "cwd:test-output/mcp-half.png" }`
- 断言：文件尺寸显著小于 scale=1 的 full-page 截图
- 清理：`rm ./test-output/mcp-half.png`

### extract-screenshot-06-clip

- 状态：条件，与 `extract-screenshot-01-viewport` 复用同一独立测试环境
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

- 状态：条件，与 `extract-screenshot-01-viewport` 复用同一独立测试环境
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
- 日志计数：自有页仅产生 warning 时，`summary.consoleErrors=0`，warning 明细保留；加入一条 error 后计数为 1，inline 与文件输出均只统计 error
- 页面状态：显式目标 T 与默认目标不同，读取后默认目标保持不变，不导航、激活或聚焦页面
- 清理：只删除本用例新建的诊断文件

### extract-state-01-whole

- 操作：`extract { type: "state" }`
- 断言：返回结构 `{ state: { pageContent, viewport, interactiveElements } }`，`pageContent` 非空字符串（含 accessibility
  tree 文本），`viewport.width/height` 为数字，`interactiveElements`
  含 role/name/selector/visible/disabled/bounds/covered
- 隐藏值保护：仅在自有页给 `input[type=hidden]` 与 `input[type=password]`
  设置自造 sentinel，分别读取默认整页、指定子树和 `output` 文件，`pageContent` 与 `interactiveElements[].name`
  均不含这些值
- getter 对照：在上述两类自有输入元素上安装会计数并抛错的 value getter，默认 `all`
  和目标子树均成功返回，getter 读取次数为 0；隐藏元素仍保留类型、标签和
  `visible=false`，带 aria-label、label、placeholder 或 title 的元素保留名称
- 普通值对照：同页无 aria-label、label、placeholder 或 title 的普通 text input 使用非空短 value，`interactiveElements[].value` 与 `pageContent` 保留当前值，`name` 不以 value 代替；submit input 的长标签保留
- 显式脚本、HTML、属性和普通 `extract(type=text)` 保持各自原有合同
- 载体：test-page

### extract-state-02-target

- 操作：`extract { type: "state", target: { css: ".section:nth-child(2)" } }`
- 断言：返回子树 `pageContent`，只包含 region 1 内的 heading/button/textbox 等节点
- CDP 对照：CSS、XPath、role/name、nth 与坐标目标限定同一子树，`depth=0` 可保留匹配的 input 本身；普通值与隐藏／密码值保护采用整页规则
- 失败对照：不存在的元素或无命中的坐标返回明确错误，选择范围保持，不返回整页内容
- 载体：test-page

### extract-state-03-depth

- 操作：`extract { type: "state", depth: 3 }`
- 断言：返回 `pageContent`（accessibility tree 输出为扁平文本，depth 参数影响生成逻辑但返回格式不直接体现层数）
- 载体：test-page

### extract-state-04-domsnapshot

- 前置：准备受控测试页，分别使用 CDP 和 Extension
- 操作：`extract { type: "state", mode: "domsnapshot" }`
- 断言：返回 `snapshot.documents` 数组（CDP `DOMSnapshot.captureSnapshot` 原始结果），含 `nodes` / `layout` /
  `textBoxes`
- 文件对照：传入 `output`，文件包含同一目标的原始完整快照
- 载体：test-page

### extract-state-05-domsnapshot-scopes-and-permissions

- 操作：分别在两种 backend 中给整页 DOMSnapshot 传入 `frame`、`target` 或 `depth`
- 断言：返回 `INVALID_ARGUMENT`，不读取被忽略选择范围之外的快照
- 权限对照：Extension 中普通只读授权页仍拒绝 debugger 快照，受控页可读取
- 载体：自有测试页

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
- 重载恢复：记录受控页 T 的原生主文档 documentId，在独立测试浏览器原生重载 Extension 并核对新构建连接身份后，复用原页面和同一
  iframe
  selector，连续两次 inline 和一次 `output` 读取均返回原文档 URL/title 和
  `managed=true`，备注保持，回读文件与 inline 一致，frames 中保留该 iframe 的 selector/rect；原生 documentId
  保持，不刷新、导航、替换目标或重新 adopt
- 恢复边界：正常导航后再次重载可恢复当前文档；release 后重启和重载均不恢复完整权限；用隔离故障注入验证跨浏览器代际的相同
  tab
  ID、不同 documentId 不授予权限，缺少 documentId 时原本合法的 create/adopt 和同代际 Worker 恢复仍可用，跨 reload
  恢复受限并有可见说明
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
- Extension 后台对照：测试页保持 inactive，独立读取
  `document.visibilityState=hidden`，普通元素点击在本次预算内完成，业务计数只增加一次；原生鼠标移动无响应不能阻断已有原子元素点击，不激活页面或重放业务动作
- 注册回归：precise/stealth、主页面/iframe 与 force 对照中，普通元素点击不调用原生或脚本鼠标移动，保留原子点击、可操作性检查和
  force 语义，并更新逻辑鼠标位置；坐标、多键、多击和 humanize
  的既有路径继续分别验收
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
- 追加变体：公开 evaluate 聚焦同一元素，使用 Range.selectNodeContents 和 collapse (false) 建立末尾光标，再用不带 target 的
  type 输入
  `OWNED_APPEND`
- 断言：textContent 严格等于追加前全文加 `OWNED_APPEND`，原有文本保持；不再次点击改变已建立的光标位置

### input-type-04-delay

- 操作：分别使用 Extension stealth、Extension precise 和 CDP，执行 `type` `text:"abc", delay:50`
- 断言：stealth 在首字符前不等待，共两次字符间隔，耗时 ≥ 2 × 50 ms = 100 ms；precise 与 CDP 在每个字符后等待，共三次，耗时 ≥ 3 × 50 ms = 150 ms
- 页面定时器节流会增加实际耗时，三种路径均须在请求 deadline 内完成并返回完整 `abc`

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
- 阶段预算回归（注册 input 入口）：1000ms 中定位消耗 400ms，后续检查最多取得 600ms；定位、检查或最终坐标读取耗尽预算后，不派发动作，
  `eventsExecuted=0`、
  `actionExecuted=false`；预算充足时正常执行
- 计时：分别记录工具总耗时与服务内部预算，工具总耗时包含传输和结果处理，不能单独用于判定阶段预算是否重新起算；阶段预算由注册入口回归核对
- 载体：test-page

### input-type-07-timeout-stop

- 前置：本任务受控 test-page 的 textarea 已清空并获焦，注入 input 计数器；iframe 输入中超时变体使用仅含一个唯一 URL iframe 的自有父页，目标文档、textarea 和计数器已就绪
- 准备阶段对照：另保留含兄弟 iframe 的自有父页；若整体预算在身份验证期间耗尽，返回 `eventsExecuted=0`、`actionExecuted=false`、`actionStatus="not_started"`，目标文本和 input 计数保持不变；该对照单独记录
- 操作：`timeout=1000`，先输入 20 个 `x`、`delay=100`，再排入 `text="after-timeout"` 的 type 事件；分别验证 Extension
  precise/stealth 主文档和 iframe，以及独立 CDP 主文档
- 断言：返回错误、`eventsExecuted=0`、`actionStatus="unknown"`、`retryable=false`；已收到执行回执时 `actionExecuted=true`，RPC 已派发但回执未知时 `actionExecuted="unknown"`
- 独立回读：已有文本长度大于 0 且小于 20，不包含 `after-timeout`；立即读取 value/input 计数，1200ms 后再次读取，两次结果一致，调用不等待全部字符输入完才返回
- 载体：test-page、本任务唯一 URL iframe、独立 CDP 测试会话

### input-type-08-extended-budget

- 前置：本任务 textarea 已清空并获焦，Extension precise 已连接
- 操作：`timeout=45000`，输入 330 个 `x`、`delay=100`
- 断言：整体输入耗时超过 30000ms，仍在本次预算内成功完成，`eventsExecuted=1`、`actionStatus="completed"`，独立读取 value 为全部
  330 个字符，没有固定 30000ms
  RPC 超时
- 载体：test-page

### input-type-09-humanize-budget

- 前置：本任务 textarea 已清空并获焦，注入 input 计数器
- 操作：`humanize=true`、`timeout=400`，先输入 100 个 `x`、`delay=100`，再排入 `text="after-timeout"`
  的 type 事件；覆盖 Extension precise、Extension stealth 与独立 CDP
- 断言：返回错误、`eventsExecuted=0`、`actionStatus="unknown"`、`retryable=false`，只留下部分文本，后续 marker 未输入；立即读取
  value/input 计数，
  1200ms 后再次读取，两次结果一致，逐字符输入没有重置整体预算
- 换行对照：重置 textarea 后，在充足预算内用 `humanize=true` 输入 `a\r\nb\rc`，value 必须为
  `a\nb\nc`，CRLF 只产生一个换行
- 载体：test-page

### input-type-10-enter-cleanup

- 前置：Extension precise 已连接，使用本任务受控 textarea，记录 Enter 的 keydown/keyup
- 操作：输入 `\nafter`，分别在 Enter keyDown 回执后、char 回执后取消请求或使请求期限到达；自动边界反例由
  `extension/test/finding-regressions.test.js` 的 R-02 用例执行
- 断言：已经派发的 Enter 均尝试 keyUp 释放，后续 `after`
  未输入；取消发生在 keyDown 前时不派发任何按键；keyDown 回执失败时仍尝试释放
- 载体：test-page、自动边界回归

### input-type-11-partial-revision

- 前置：隔离 ActionHandler/InputEventHandler，保留真实 revision 检查，仅替换 Chrome 按键接口
- 操作：输入 `AB`，分别在 A 回执后取消或超期；输入 `\nafter`，在 Enter keyDown 回执后取消或超期；另在首次派发前取消
- 断言：收到回执后的动作上下文为 `actionExecuted=true`、`actionStatus=partial`、`retryable=false`，后续字符不派发，Enter 尝试
  keyUp，旧 expectedRevision 的下一次操作被拒绝
- 对照：首次派发前为 not_started、无按键且 revision 不变；公开 input 序列仍使用其 unknown 结果合同，保留已派发状态并禁止自动重放
- 载体：自动边界回归，真实浏览器使用自有后台测试页检查文本与 revision

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

Extension precise 在自有后台测试页执行以下用例，监听器同时记录按键、修饰键、repeat 与 `document.visibilityState`；主文档和 iframe 分别执行，`browse list` 中实际活动页与窗口焦点保持原值，结束后的独立读取和 `postCondition` 均观察原文档可见状态

### input-keydown-01a-background-focus-lifecycle

- 前置：自有后台页、precise 模式、确定原焦点模拟关闭的调试会话，记录实际活动页、默认目标和文档可见状态
- 操作：发送普通按键、修饰键、repeat 与 selectAll，读取事件和选区，再读取结束后的可见状态
- 断言：原生事件和命令生效，临时模拟期间文档报告 `visible`，响应包含对应 `warnings`，结束后恢复原设置，再执行后置验证；实际活动页、窗口焦点和默认目标保持
- 状态对照：原已开启的模拟保持开启；后台复用会话的原状态未知时返回 `KEYBOARD_FOCUS_STATE_UNKNOWN`、`not_started`，按键零派发且保留原设置
- 生命周期对照：SDK／Extension 定向回归覆盖准备超时、按下后取消、请求到期、连接断开、文档替换、调试会话变化和迟到回执；需要释放的本请求新增按键与焦点恢复分别尝试，原先按住的键保留，清理失败通过 `keyboardFocusCleanup` 返回
- 执行状态对照：准备失败保持 `not_started`，已派发且回执未知保持 `unknown`，动作已完成但恢复失败保持 `completed` 并返回失败结果；纯 type、controlled、stealth 与 CDP 保留原输入路径

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

### input-keydown-04a-commands-coordinate-focus

- 前置：自有测试页包含未选中的 checkbox、带 href 的链接、text input、contenteditable、disabled
  input 和无 tabindex 的 div，监听鼠标事件并记录 URL；Extension
  precise 和独立 CDP 分别执行，Extension 另包含 iframe 变体
- 操作：按各元素当前中心坐标发送
  `{type:"keydown",key:"a",commands:["selectAll"],target:{x:X,y:Y}}`，成功时发送对应 keyup；iframe 坐标使用所选文档的局部坐标
- 断言：成功目标成为 activeElement，checkbox 保持未选中，URL、点击及 mousedown/mouseup 计数不变；text
  input 的选区覆盖原值，contenteditable 可被后续 editorContext 读取；默认目标和 frame 在成功或失败后恢复
- 错误对照：视口外坐标返回 `TARGET_NOT_FOUND`，disabled 或不可聚焦目标返回
  `TARGET_FOCUS_FAILED`，focus 抛错保留错误；所有失败均不派发 commands 或后续事件，不通过点击尝试恢复焦点
- 期限对照：注册入口分别使坐标查找或 focus 消耗全部预算，后续命令和 editor 操作均不执行；成功分支逐层传递剩余预算，CDP
  坐标聚焦不调用不支持坐标的 Locator.find
- stealth 对照：commands 在任何查找、focus 或鼠标动作前返回既有不支持错误

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

- 前置：在自有测试页监听 mousedown、mouseup、click、auxclick、dblclick 与 contextmenu，测试函数分别使用坐标和 refId
- 操作：`button:"middle"`，分别使用 `clickCount:1`、`2` 和 `3`，另执行独立的 middle mousedown/mouseup
- 断言：每次按下 `button=1`、`buttons=4`，每次释放 `buttons=0`，随后派发
  `auxclick`；多击 detail 依次递增，不派发 click、dblclick 或 contextmenu，独立 mouseup 同样使用 auxclick

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
- 已移动后超时：`eventsExecuted=0`、`actionExecuted=true`、`actionStatus="unknown"`、`retryable=false`
  ，不把已执行的鼠标移动报告为未执行，不自动重放
- 注册入口回归：模拟时钟使首个移动耗尽预算后，只允许一次移动、不点击；覆盖 humanized
  click/mousemove、普通 click/mousedown、type 的目标聚焦及 CDP 直线分步；另验证定位和 driver 准备消耗后传递剩余时间、RPC/Extension
  队列及实际页面脚本拒绝过期派发
- 同类调用方回归：命令与 editor 的坐标聚焦只定位并 focus，查找或 focus 到期后不执行后续动作；select/replace
  的坐标鼠标准备到期后停止，文本选择的第二次移动到期后不点击且释放 Shift，
  动作和释放均失败时保留原动作错误；replace 的选区轮询耗尽预算后不更新文本，预算充足时正常替换；CDP
  touchmove 直接与分步移动到期后不执行后续触摸点和事件
- 计时保留端到端测量，服务内部未采集时明确记录，不用模拟时钟结果代替公开验收
- 载体：test-page

### 5.10 timeout / nth

### target-index-01

- 前置：自有页包含 80 个同类可编辑元素、独立拖动源与目标，以及超过 200 个含相同文本的元素，另在 iframe 中放置相同结构
- 两种 backend 验证 `nth=0/49/50/60/79` 命中指定元素，`nth=80` 越界；CSS、XPath、CSS+text、纯文本超过 200 的索引和坐标目标分别验证，默认
  find 候选仍最多 50 条
- Extension 验证命令聚焦、select/replace 聚焦、wheel、drag 两端、controlled 输入、非左键/多击坐标和滚动后重新定位；extract
  验证截图、HTML+images 及定向读取前的等待
- 对存在的高索引元素，`attached`、`visible` 成功，`hidden`、`detached` 持续等待；隐藏后仅 `hidden` 成功，移除后 `hidden`、
  `detached` 成功；协议错误和断连均保持失败或等待
- 单目标查询的 0/1 结果不充当匹配总量，未经统计的 `matchCount` 为 null；保留 CDP Locator 已观察到 15 个匹配、`nth=30`
  时的真实计数，诊断候选仍最多 10 条

### input-timeout-01

- 操作：`input { timeout: 500, events: [{type:"click", target:{css:"#nonexistent"}}] }`
- 断言：在 500ms+ε 内抛错；Extension 返回 `TARGET_NOT_FOUND` 或 timeout 类错误，未找到目标时 `context` 含
  `locator/matchCount/nth/currentUrl/candidates`；CDP 保留 `ELEMENT_NOT_FOUND` 及 `target/timeout/url` 诊断
- 两端均验证 `eventsExecuted=0`、`actionExecuted=false`，计时记录工具执行时间，另列传输开销

### 5.11 upload

上传使用合成文件和自有 localhost 页面，接收端仅监听本机地址；Extension 与 CDP 分别通过当前构建的公开 `input` 入口执行
测试前列出并复用明确属于本任务的后台页，保持用户页和业务连接；记录 Server 构建与 Extension bundle 身份，确认响应中的实际 backend
合成文件放在私有临时目录，测试进程在导入模块前设置私有 HOME/USERPROFILE，完成后清理本任务资源

### input-upload-01-single

- 前置：自有页包含文件控件及接收端，准备带中文文件名、已知完整字节和修改时间的普通文件，监听 input/change
- 操作：`input {events:[{type:"upload", target:{css:"input[type=file]"}, files:["./附件.txt"]}]}`，另以绝对路径及 `~/` 路径对照
- 断言：控件文件名、大小、MIME、修改时间与文件一致，事件顺序为 input→change；站点提交后，接收端文件名和完整字节与源文件一致
- 结果摘要包含文件名、大小、MIME 和事件信息，响应不包含文件正文、base64 或本地绝对路径

### input-upload-02-multiple-hidden-nth

- 前置：两个同类文件控件，第二个隐藏且带 multiple，准备两个内容不同的合成二进制文件
- 操作：使用 CSS、XPath、label 和 `target.nth` 定位第二个控件，传两个文件路径
- 断言：仅选定控件更新，FileList 顺序与路径列表一致，两个文件的接收字节完整；操作保持后台，不打开文件选择框

### input-upload-03-clear

- 前置：文件控件已选中合成文件
- 操作：对同一目标发送 `files:[]`
- 断言：files.length=0，依次收到 input/change，返回完成状态与空文件摘要

### input-upload-04-frame

- 前置：Extension 自有页的主文档和 iframe 各有同名文件控件
- 操作：分别用 CSS frame 选择器和 frame 索引上传，读取对应 iframe 状态并提交到本机接收端
- 断言：仅所选 iframe 更新，postCondition 也在所选 frame 执行，主文档不变；CDP 显式 frame 参数遵守已有能力限制

### input-upload-05-mode-csp

- 前置：自有普通页和严格 CSP 页，明确选择当前 inputMode
- 操作：默认 precise 在两页上传；stealth 在允许注入的页上传，并在 CSP 阻止脚本的页验证错误
- 断言：成功路径保持文件字节及事件顺序，受 CSP 阻止时返回明确错误；inputMode 和 backend 保持原选择，同一上传不重放

### input-upload-06-preflight

- 操作：分别省略 files、传非字符串列表、指定坐标目标、非文件控件、目录、缺失或不可读文件，以及向单选控件传多个文件
- 断言：返回明确错误，原文件选择及事件计数不变；文件预检失败为 `actionExecuted=false`、`actionStatus="not_started"`
- 对照：以可读文件替换失败路径后，正常上传成功

### input-upload-07-size-budget

- 前置：准备接近 50 MiB 预算的合成文件，以及总大小恰好达到 50 MiB 和超过预算的列表
- 操作：Extension 和 CDP 各自通过真实公开入口上传预算内文件，并提交至本机接收端；另执行两个超限列表
- 断言：预算内完整字节可接收，超限在修改控件前失败，保留原选择；读取中增长至预算的文件同样在赋值前拒绝
- 计量：记录真实传输耗时和大小；协议 mock 结果不替代浏览器大载荷验收

### input-upload-08-cancel-timeout

- 前置：受控文件预检／读取夹具或临近预算的大文件，监听赋值与事件计数
- 操作：分别在预检和读取期间取消、耗尽 input timeout；另在同一序列先完成一个可计数事件再使 upload 预提交失败
- 断言：取消和到期后停止后续读取与事件，零文件赋值；首事件为 upload 时返回 not_started，已有事件完成时保留实际 eventsExecuted 和执行状态
- 预检延迟对照：stat 等待超过预算或收到取消时及时返回，释放请求锁；迟到的 stat 成功或失败均不继续读取、修改页面或产生未处理异常
- 后续独立读取确认无延迟赋值，临时引用、打开文件和 CDP 对象得到清理

### input-upload-09-target-lifecycle

- 前置：测试夹具使读取暂停，已定位原文件控件
- 操作：读取期间导航或替换原控件，再恢复读取；分别覆盖同号 refId 的新文档和同 selector 的新元素
- 断言：原目标失效时明确失败，新文档或新元素保持不变；请求临时引用一次消费并按 deadline 清理，CDP 远程对象释放

### input-upload-10-verification-unknown

- 前置：自有页监听 change 并发送到本机接收端，另有 change 后自动清空的控件
- 操作：正常上传、自动清空上传、上传后故意不满足 postCondition；测试传输夹具另模拟提交后回执丢失
- 断言：正常及自动清空路径均收到完整字节，结果保留赋值时摘要；postCondition 失败保留已完成动作，change 仅触发一次
- 回执丢失返回 `actionStatus="unknown"`、`retryable=false`，同一请求不重新赋值、不改换 backend，实际状态由独立读取判断

### input-upload-11-read-only

- 前置：只用本任务合成页演示 read grant，另准备可统计本地读取次数的测试夹具
- 操作：仅授予读取权限后执行 upload，再按明确授权 adopt 同一测试页并重试
- 断言：只读页在本地文件读取前拒绝，读取计数和页面赋值计数均为零；adopt 后正常上传，权限检查沿现有受控页机制执行

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

### logs-console-05-identical-fallback-events

- 前置：在自有页取得浏览器原生 debugger attach 拒绝，启用 fallback console hook；若浏览器允许多个 debugger，原生 fallback
  条件项标为未验证，固定时钟回归仍独立执行
- 操作：固定同一毫秒依次调用 `console.warn('same')`、`console.error('same')`、`console.error('same')`，读取全部日志及 error
  过滤结果
- 断言：全部结果包含三条独立事件及递增 sequence，error 结果包含两条；再次读取保持条数及 sequence，并发排空后也不增加同一批记录
- 对照：clear 后为空，hook 继续采集；连续 1005 条相同日志只保留最新 1000 条；Service Worker 恢复及 debugger 切换后保留待排空的独立事件，卸载
  hook 时保留页面之后安装的 wrapper
- 切换对照：保留浏览器 Runtime 历史，fallback 中连续两次相同 console 调用后恢复 debugger，结果恰好两条；已读取事件的 sequence 保持，clear 过的事件不重新出现，切换后的新调用以及其他 frame 的独立日志各保留一次

### logs-network-01

- 前置：attach 到 test-page，先调用 `logs { type:"network" }` 启用采集，再执行

    ```javascript
    evaluate({
        script: "(async()=>{const response=await fetch('/mcp_missing_resource?network-first');" +
            "const body=await response.text();return {status:response.status,bodyLength:body.length}})()",
    })
    ```

- 操作：响应体消费完成，或独立观察到该请求的 `loadingFinished/loadingFailed` 后，调用 `logs { type: "network" }`
- 断言：返回数组非空，实际包含本次请求，每项含 url/method/status 或 errorText 中可由当前浏览器提供的值；fetch 返回 Response
  不作为请求完成证据
- 刷新对照：首次读取后再次发起唯一 URL 的 fetch，等待同样的完成条件，后续 logs 必须出现该请求，不以旧的页面或 iframe 条目冒充新
  fetch
- debugger 不可用对照为条件项：须取得浏览器对当前 Extension 的原生 attach 拒绝，且只读会话证明也失败；只有外部 holder
  存在不满足此前置，Chrome 允许多个客户端时记录该条件项未验证，
  不伪造拒绝或改写原失败
- 满足此前置时：日志 `source="performance"`，浏览器提供响应状态时保留实际状态，并在该来源重复以下增量与清除对照
- 增量对照：连续读取不会重复增加记录或改变已有序列号，字段相同的两次请求仍保留两项；diagnostics 只包含动作后的新增失败请求
- 清除对照：`clear:true` 后读取不再返回已清除记录，随后新 fetch 可取得；不调用网页的
  `clearResourceTimings`，原页面 resource entries 保留，新文档重新读取
- CDP 持续处理对照：连接工具请求的默认 30 秒期限结束后，在自有页启用合成 HTTP 认证与正文捕获，等待 fetch 及正文消费完成；自动继续请求、匹配凭证处理和原响应正文读取均须成功，cleanupFailures 为空
- 请求隔离对照：连接请求到期或取消不终止后续原生事件处理，事件的异步后续命令保持该归属；后续显式调用自身到期或取消时仍按原期限停止，已派发结果未知时保留 unknown
- 载体：test-page

### logs-network-02-url-pattern

- 前置：接 `logs-network-01`
- 操作：`logs { type:"network", urlPattern:"*mcp_missing_resource*" }`
- 断言：每项 url 匹配模式
- 两种 backend 的 summary／details／stream／paused／auth 分别覆盖匹配与不匹配的请求 URL，暂停事件按嵌套 `request.url` 选择，认证事件保留可过滤的请求 URL
- 同时匹配两项且 `limit=1` 时，`count=1`、`totalBuffered=2`；指定 ref 后仍应用 URL 条件，输出中的合成凭证保持脱敏
- `clear:true` 清除匹配的普通记录，保留仍需显式处理的暂停请求和认证事件；读取操作不发送继续、拒绝或认证命令

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
  `logs { type:"network" }`、`logs { type:"network", output:"tmp:mcp-network-redacted.json" }`，并读取 diagnostics 中的
  failed
  request
- 断言：内联响应、output 文件和 diagnostics 均不包含两个 sentinel，URL 对应值为 `[REDACTED]`，并返回
  `urlRedacted === true`、原始 URL 长度和 `redactedQueryParameters`

### page-url-01-credential-redaction

- 前置：自有测试页 URL query 包含 `ticket=mcp-ticket-sentinel`、`%74oken=mcp-token-sentinel` 和普通参数 `name=report`
  ，页面正文保持无凭证内容
- 操作：读取 browse 的 summary/full 列表、attach、页面管理响应和 extract 的 state/metadata/diagnosticBundle，包含其 output
  文件；在该页执行一个成功动作和一个定位失败动作
- 断言：公开页面 URL 及成功／失败 `pageContext.before/after` 隐去两个 sentinel，普通参数保留，并返回脱敏标记、原始长度和参数名；管理响应的
  before/after、窗口 tabs 和分组 tabsBefore/tabsAfter 同样脱敏
- 断言：原生 pendingUrl/favIconUrl 含认证参数时，返回对应字段名前缀的脱敏标记
- 操作：使用原始 URL 作为 expectedUrl 执行页面动作，并让用户脚本返回一个自有合成 URL 对象
- 断言：条件比较使用原始 URL，用户脚本对象不被改写；重复序列化页面响应保留原始长度，不修改内部页面 URL

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
- 验证：窗口、index 和 groupId 保持原值，text/evaluate/input/screenshot/logs 拒绝完整操作，debugger 与 console
  采集状态清理；清理被浏览器阻止时权限仍撤销且返回
  `warnings`
- 缓存对照：先记录唯一 console
  marker，仅清浏览器 Runtime 历史后确认工具缓冲仍包含它；release、重新 adopt 后工具不再返回该缓存，结合 Runtime
  的真实回放事件区分浏览器历史和工具缓冲
- fallback hook 生命周期为条件项：沿用 `logs-network-01`
  的真实 debugger 拒绝前置，确认 hook 已安装后验证收取日志、release 卸载和原 console 函数恢复，外部连接保持；前置不成立时明确该项未验证，正常
  debugger、权限与缓存清理仍必须验证
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
- 断言：Extension 返回 `success=true`、`affected.after.active=true`
- CDP 对照：为默认操作页 D 和待激活页 T 分别指定 ID，通过 `manage activatePage targetId=<T>`
  激活，独立观察 T 已成为前台页；默认操作目标仍为 D，affected 只返回实际可读字段，不构造 `active` 或窗口焦点

### manage-focusWindow-01

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：agent 在该环境中创建测试窗口 W，不存在用户窗口、tab 或登录态
- 操作：`manage { action:"focusWindow", windowId:<W> }`
- 断言：`success=true`，`affected.after.focused=true`
- 成员对照：分别在全部受控、混合成员和全部非托管的自有窗口执行，显式窗口聚焦均可用，非托管成员权限不变

### manage-resizeWindow-01

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：在该环境中先 newWindow 创建测试窗口 W
- 操作：`manage { action:"resizeWindow", windowId:<W>, width:900, height:700 }`
- 断言：`success=true`，`affected.before/after` 存在，`affected.after.width` 和 `affected.after.height`
  接近设置值，等待后独立 `browse list details=full` 的窗口几何与响应一致
- 恢复对照：记录 normal 基准，将 W 最大化，再用一次 `resizeWindow windowState=normal`
  同时传入基准位置和尺寸，首次恢复返回 normal，独立读取与基准及响应一致，不靠重复同一恢复请求满足断言
- 混合成员对照：解除其中一个自有 tab 的托管后重复尺寸与状态调整，结果可用，成员权限保持不变
- 清理：将本用例解除托管的自有页重新 adopt，再执行 `manage closeWindow windowId=<W>`

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
- 操作：

    ```text
    manage {
      action:"newPage", url:<测试页URL>, windowId:<W>, index:0,
      active:false, pinned:true, openerTabId:<O>, groupId:-1
    }
    ```

- 断言：创建页位于 W，固定、来源 ID、活动状态及不分组的结果正确，默认显示分组不改变显式位置，返回状态与 `browse list`
  一致
- 负例：窗口、来源 tab 和分组不属于同一窗口，或 pinned=true 与已有分组同时指定时，创建前拒绝；跨窗口冲突返回
  `actionExecuted=false`、`actionStatus="not_started"`、`failureStage="preflight"`，独立 list 确认没有新增页
- 默认创建对照：省略原生位置参数创建自有页，自动显示分组后的实际窗口与创建窗口一致，不移入其他窗口
- 混合缓存窗口：在默认 MCP 窗口中解除一个自有页的托管，再不带位置参数创建页面，新页仍位于原窗口，窗口数量不增加，新页受控，非托管成员权限不变
- 错误对照：缓存窗口关闭后使用现有普通窗口；没有普通窗口或原生查询失败时明确报错，窗口数量不增加
- 清理：关闭新建测试页

### manage-updatePage-01-native-state

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：准备受控测试页 T 与同窗口内的来源页 O
- 操作：分别修改
  `url/active/pinned/highlighted/muted/autoDiscardable/openerTabId`，active 只设置 true，其他可逆布尔字段再设置
  false，导航后等待测试页载入
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
- 前置：准备全部受控、混合成员和全部非托管的自有测试组 G
- 操作：更新 title、九种合法 color 和 collapsed，设置 `title=""` 与 `collapsed=false`
- 断言：实际组属性与 `affected.after`、`browse list.groups` 一致，空字符串与 false 不被替换，颜色只属于分组
- 权限对照：名称、颜色和折叠变化不授予非托管成员读取、输入或 debugger 权限
- 负例：非法颜色、无配置、负 groupId、目标组不存在或 readonly shared 写入时拒绝

### manage-moveGroup-01-window-and-index

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：准备所有成员均受控的组 G 与独立测试窗口 W
- 操作：`moveGroup groupId=<G> windowId=<W> index=-1`，再按可用 index 调整位置
- 断言：整组及成员均移入 W，实际顺序、首个成员位置和窗口归属回显正确，成员受控状态不变
- 非托管成员对照：解除一个自有成员的托管后请求整组移动，在移动前拒绝，组及成员位置不变

### manage-ungroupPages-01-retain-control

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：测试组 G 只包含受控页 T1/T2
- 操作：分别解除 T1 和剩余 T2 的分组
- 断言：成员 groupId=-1 且 managed=true，最后一个成员离组后 Chrome 删除空组，读取和输入能力保留

### manage-groupPages-02-unrelated-member-change

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：准备受控目标页 T 和同组的其他自有页 U，用隔离 Extension API 包装在前后快照之间改变 U 的分组归属
- 操作：分别请求 T 创建分组、加入指定组、解除分组；另对有效 groupId 更新显示属性
- 断言：无关 U 的变化不阻止有效目标操作，U 的权限不变
- 目标对照：排队期间 T 解除托管、窗口或分组身份改变时，成员操作仍在副作用前拒绝；整组移动继续拒绝成员集合变化

### manage-newWindow-02-multiple-urls-and-existing-tab

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：准备已 adopt 的普通自有测试页 T，记录其创建来源
- 操作：创建 normal 窗口并指定多个 urls，创建单页面 popup；另创建 normal 窗口时同时提供 `targetId=<T>` 与 urls
- 断言：所有新建页均受控，指定 T 移入新窗口且保持原创建来源，额外页面分别记录为新建，位置/尺寸、focused、incognito 和
  setSelfAsOpener 按 Chrome 支持情况验证，不把移动 T 标成新建
- 负例：同时提供 url 与 urls、popup 多 URL、popup 同时提供已有 targetId 与额外 URL、非法状态/尺寸组合或迁移到不同隐身状态时拒绝，独立
  list 确认没有新增窗口、外溢页面或移动已有页
- 清理：只关闭自有测试窗口

### manage-updateWindow-01-native-state

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：准备自有窗口 W，分别覆盖全部受控、混合成员和全部非托管状态
- 操作：修改位置、尺寸、normal/minimized/maximized/fullscreen 状态、focused 与 drawAttention，分别读取实际窗口状态
- 断言：参数到达 Chrome，状态转换和几何稳定后返回浏览器观测值，不把 OS 调整后的尺寸伪装成输入值，focused=true 只有观测到焦点才报成功
- 首次恢复：分别从 maximized/minimized/fullscreen 用单次 `updateWindow windowState=normal`
  恢复原 normal 基准位置和尺寸，`affected.after.state=normal`，等待后独立 `browse list details=full`
  与响应及有效基准一致，不允许第二次恢复请求掩盖首次失败
- 负例：状态与 bounds 冲突、focused/state 冲突或无效窗口 ID 时拒绝，窗口显示变化不赋予成员页面权限
- 越界对照：请求明显超出当前可用屏幕范围的 bounds，保留 Chrome 原生错误，不附带 activatePage/focusWindow 提示；隐藏 HTTP
  页的截图错误继续返回其可见性说明

### manage-configuration-01-backend-and-argument-errors

- 操作：在 CDP 模式调用 `focusWindow/updateWindow/groupPages`
  等 Extension 原生 UI 配置动作及带原生 UI 参数的 newPage；在 Extension 模式给动作传不适用字段、未知字段或 readonly 字段
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
- 页面独立对照：无默认目标、默认页已关闭，以及显式 targetId 不存在时返回同一目录，不读取页面或改变默认目标
- 条件对照：目录查询携带 `expectedUrl` 或 `expectedRevision` 时返回
  `INVALID_ARGUMENT`；实际设置 device 继续校验目标和条件

### manage-blank-page-01-debugger-capabilities

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：Extension 中创建受控 `about:blank` 页 T
- 操作：对 T 设置 viewport、userAgent、emulate，并用 precise
  evaluate 读取实际值；分别在 inputMode 为 precise 和 stealth 时执行管理动作
- 断言：原生命令与 resize 事件链完成，视口、UA、触摸等按请求生效，precise
  evaluate 返回实际值，管理动作不依赖脚本注入模式
- 权限对照：非托管页、仅普通只读授权页，以及 `chrome://`、`chrome-extension://` 受限页仍按各自权限拒绝

### extract-frame-06-unavailable-sibling

- 状态：条件，仅在独立测试浏览器环境中执行
- 前置：准备包含有效 iframe T 和自有 sibling
  U 的受控页面，在独立 Extension 中分别注入 U 缺失 documentId 或 U 探测脚本拒绝的故障
- 操作：选择 T 读取正文和状态，随后提取父页 metadata；再选择 U 执行相同读取
- 断言：T 可用，metadata 的 `unavailableFrames` 和 U 对应的 `unavailableReason` 标明错误；选择 U 返回
  `FRAME_IDENTITY_UNAVAILABLE`，不操作 T 或其他 iframe
- 身份对照：父文档变化、选中 frame 映射不唯一时仍拒绝，探测与对象清理完整，有副作用脚本不自动重放

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

真实站点只作补充观察，不加入发版门禁，进入 Cloudflare 站点前，先用 `browse { action: "list" }` 确认
`mode="extension"`，不传 `port`，也不传
`diagnostics=true`，CDP 模式超时只能记录为 CDP 路径未完成，不能写成网站或用户真实 Chrome 无法通过

### browse-challenge-01-js-wait

- 前置：attach 到 test-page，点击 `#challenge-js-btn`
- 操作：`evaluate { script:"document.title" }`
- 断言：约 1.2s 后 `success=true`，`mode="extension"`，`result === "MCP Chrome 测试页面"`，`#challenge-status` 为
  `js-resolved`，恢复发生在八秒被动等待内时不得启用 debugger 或执行 page evaluate
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
    - 先在普通页通过 precise evaluate 建立 debugger，再触发两阶段验证；覆盖最大化无 client shadow 与 125% 缩放窗口，提示条退出动画期间，即使视口尺寸尚未更新，仍按当前内容原点更新系统鼠标终点，保持原 timeout、各控件一次 trusted 点击及业务一次执行
    - Linux 路径悬停后，以独立的 `mousemove_relative` 阶段往返 1 px；同一 frame、同一文档与同一页面元素内收到本次两条 trusted pointer 事件，指针返回原位后读取当前内容原点；重新定位时再次完成路径、悬停与校准，原路径悬停断言保持
    - 活动页、焦点和标题拒绝条件同时检查绝对移动与相对校准命令为零；观察器在成功、失败、取消和超时后清理，缺少可信事件时在按下前返回明确错误
    - 按下前活动 tab、焦点、窗口标题或验证控件阶段发生变化时，返回明确错误且不按下；坐标更新遇到取消或原 deadline 到达时保持零按下
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

## 12. 浏览器事件与定位上下文

前置：使用自有 localhost 服务、合成文件、测试 Cookie 和合成认证凭证，记录服务端请求次数与动作计数器
原生测试使用独立 profile 或已受控的可复用测试页，核对加载构建与当前源码匹配
Extension 原生用例要求可加载测试 Extension 的浏览器；条件不具备时记录具体限制，并独立完成协议回归
对下载使用本用例创建的目录，按原始字节比较文件，不执行下载内容

| 用例 ID                    | 操作                                                                                                                            | 验收结果                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| capability-launch-01       | Extension 可用时分别省略、显式传入 headless、incognito、profile、executablePath 或 port                                         | 默认使用 Extension；显式进程参数生效并返回实际 CDP 模式，已有 CDP 冲突在新副作用前拒绝                                                                                                                   |
| capability-storage-01      | 在正常 HTTP 文档和禁止 storage 访问的文档清理站点存储                                                                           | 正常状态实际清除；Runtime 异常返回错误，保留已发生动作信息                                                                                                                                               |
| capability-click-01        | 监听 pointerdown、mousedown、mouseup、click，在 precise 默认左键、stealth 和 force 下点击                                       | 活动且可渲染的页使用原生输入；后台默认元素单击使用合成事件并返回 warnings；后台坐标或其他原生动作在派发前拒绝；stealth／force 保留明确的合成语义和遮挡处理                                               |
| capability-name-01         | 多个 aria-labelledby 引用、隐藏标签、Shadow 内重名 ID、6000 层 span 和隐藏文件控件 label                                        | 名称优先级、中文相邻字符和引用所在树正确；state 保留名称及普通当前值，password／hidden／file 值未被读取                                                                                                  |
| capability-shadow-01       | 用 CSS、text、role、label、nth 执行点击、聚焦、select／replace、state 和上传                                                    | open shadowRoot 可操作、去重且顺序稳定，命中和焦点指向实际控件；XPath 保持原生文档范围                                                                                                                   |
| capability-frame-01        | 同源／跨源两层 frame、OOPIF 和 Shadow 内 iframe，执行 evaluate、点击、坐标、上传，再读取原默认目标；增加 context 准备超时与取消 | 每层按父文档及 open ShadowRoot 解析，输入绑定所属 session，坐标正确，上传字节一致，退出后恢复原目标；准备使用原请求期限，派发前失败保留 not_started 和零业务执行，重排或文档变化时保留真实身份或明确失败 |
| capability-cookie-01       | 在两个测试 CookieStore／partition 中设置同名 Cookie，按 target/store/partition 执行 get、set、delete、clear                     | 范围完整传播，其他测试范围保留；后端不支持的字段和 store 冲突在操作前拒绝；部分 clear 失败报告实际数量                                                                                                   |
| capability-cf-01           | 内嵌控件完成后保留容器，随后 reset／过期；增加第二控件、其他表单 response、隐藏模板和残留 iframe                                | 只将有正确完成证据的控件视为完成；有效 pending 继续等待，普通恢复页面不滚动或重复点击，response 内容不出现在结果                                                                                         |
| capability-cf-02           | input 或 evaluate 执行一次后触发新 Challenge，并预先配置 Fetch 路由                                                             | 不重放业务动作；后续验证失败保留已执行状态；本实例暂停请求先中止，Fetch 释放结果可见；清理未确认时保留实际连接状态                                                                                       |
| capability-dialog-01       | watch 后触发 alert／confirm／prompt，原请求阻塞期间通过 logs 获取引用并接受／取消                                               | 读取和处理不等待原页面锁，不自动接受未知弹窗；确认实际关闭，再检查原动作的最终效果；旧引用及其他实例引用拒绝                                                                                             |
| capability-body-01         | 单次 POST、重定向及二进制响应，故意乱序投递 ExtraInfo                                                                           | 按请求和跳次返回 headers 及完整性，正文 output 与原始字节一致；服务端未收到额外请求；不可用正文明确失败                                                                                                  |
| capability-exception-01    | 页面异步抛错并附带 sourceURL                                                                                                    | console error 入口保留未捕获异常、来源与位置，过滤及清理语义保持有效                                                                                                                                     |
| capability-route-01        | 添加匹配规则，读取 paused 后分别 continue、改写、fulfill、fail，并覆盖重复处理、取消、导航与断开                                | 处理绑定同一暂停引用，未匹配请求立即继续；预期 mock 不到达真实服务；过期请求 Aborted，回执未知保留原实例归属且不重发；原生校验拒绝保留可处理引用                                                         |
| capability-auth-01         | 配置 Server 与 Proxy 的 origin／realm，与 route／download 同时启用，触发匹配、不匹配和重复失败挑战                              | 只在明确范围使用合成凭证，失败重复挑战取消；日志脱敏，clear、CF 暂停与所属会话结束后凭证清除                                                                                                             |
| capability-stream-01       | WebSocket 双向文本／二进制及 SSE，增加超长消息和缓存压力                                                                        | 来源、方向、opcode、序号和消息一致；握手原始 headers 文本及其中 URL 的凭证脱敏；超长／淘汰／丢失状态可见；clear 不改变活动请求控制                                                                       |
| capability-download-01     | watch 后下载合成附件，观察 GUID 与终态，wait 后 save 到私有 output                                                              | 原始一次请求，原响应与原生下载及保存产物逐字节一致；completed 与 artifact availability 分开，正文小于 16 MiB；不可用或超额不重新请求                                                                     |
| capability-event-cancel-01 | 通过公开 MCP 入口取消下载等待、正文读取及原始 Fetch 操作；另在派发前取消                                                        | signal 贯穿后端请求范围，派发前无副作用；已派发操作保留真实已执行／未知状态，暂停请求按其生命周期结束                                                                                                    |

协议回归对应 `test/browser-events.test.js`、`test/browser-native-transitions.test.js`、`test/capability-regressions.test.js`
以及 Extension 标准回归入口导入的 `extension/test/browser-events.test.js`
协议替身检查身份、清理与错误合同，原生验收分别检查真实事件、文件和页面效果

## CH 专项回归

- `ch-input-01`: 对 `#edit-number` 执行 replace，确认不调用 selection API，返回 `requestedValue`、`actualValue`，并派发
  `input` 与 `change`
- `ch-input-02`: 对 `#edit-date` 执行 select，确认返回 `UNSUPPORTED_SELECTION` 及 tag、input type、current
  value、requested find、推荐模式
- `ch-postcondition-01`: 已完成动作后的 false selector 返回 `actionStatus=completed`、`verificationStatus=not_matched`、
  `failureStage=verification`
- `ch-postcondition-02`: 两种 backend 的原生 frame/context/debugger 不可用返回
  `verificationStatus=unavailable`，覆盖真实
  `Runtime.callFunctionOn: Cannot find context with specified id`；页面验证脚本抛出相同完整文案、无前缀文案或 debugger
  文案时仍返回
  `error`，同步 throw 与异步 reject 都验证；已完成动作保留 `actionStatus=completed` 和
  `failureStage=verification`，独立读取业务计数为 1，不重放主动作
- `ch-timeout-01`: 在自有页初始化 started/completed 计数，通过两种 backend 的 `manage cdp Runtime.evaluate`
  设置 1ms 协议 timeout，脚本先增加 started，再执行有界计算并增加 completed；独立读取实际计数，原生
  `Execution was terminated`（含实际 CDP 方法前缀）返回
  `actionExecuted=true`、`actionStatus=unknown`、`retryable=false`，保留原错误码且不重放；两种 backend 的 evaluate
  分别使用有界执行超时，记录真实原生终止、
  `Runtime`
  脚本命令的 `Internal error` 或执行中 RPC timeout；这些结果未知的错误均不可直接重试，不把 RPC
  timeout 改称原生终止，调用前超时仍保留未执行及可重试状态；页面主动抛出的同名异常仍为动作失败；本地注册 callback 回归须用
  CDPClient 实际消息转换覆盖
  `Runtime.evaluate`、`Runtime.callFunctionOn`、`Runtime.runScript`，同时保留普通参数错误和非脚本命令的负例
- `ch-target-01`: 两种 backend 的 input、extract、wait 定位失败返回 locator、targetType、nth、currentUrl、tabId、managed、frame、
  matchCount、最多 10 个候选和 lastLocatorState；15 个匹配元素、`nth=30`、`timeout=500ms`
  返回真实 `matchCount=15`，不把候选上限或 nth 越界当作总匹配数；CDP input/extract 保留 `ELEMENT_NOT_FOUND`
  及原 URL/logs，wait 保留
  `TIMEOUT`，不附与定位无关的焦点提示；诊断与动作共用原 deadline，失败目标/frame 作用域退出前读取，不重新派发动作；故障注入验证未知匹配数或
  managed 为 null，诊断失败有
  diagnosticError，不覆盖主错误或探测恢复后的默认页；沿用
  `ch-password-01` 的完整响应脱敏断言
- `ch-port-01`: 无 server 时 Extension 的聚合扫描摘要与重连消息均为 debug，不为每个候选端口输出 warning/error
- `ch-port-02`: 已识别 MCP
  server 的 token/proof 不匹配或认证协议不完整时，输出一条限量 warning；同一摘要自动重连时不重复，拒绝消失后再出现须重新告警；显式
  disconnect 后重新开始报告
- `ch-port-03`: 发现集合依次为 A、A、同数量不同端口 B、空、空、A，恰好输出四条发现摘要，每次仍检查完整 78 个端口；显式断开后相同集合重新报告，过期
  generation 的迟到结果不改变当前发现及拒绝摘要
- `ch-pause-restore-01`：在同一 Worker 中使暂停状态首次读取失败，再恢复存储，分别通过 CONNECT、GET_STATUS
  和既有自动连接入口重试；受控页权限恢复失败时继续拒绝连接，恢复成功后再连
- `ch-pause-restore-02`：阻塞旧暂停读取后执行 DISCONNECT，另使暂停状态写入失败；断开立即停止本地连接，写入失败明确返回错误，迟到读取不能覆盖新选择，不增加用户点击步骤
- `ch-cdp-01`: 在自有页禁用 Debugger 域，再调用 `Debugger.getScriptSource`，返回 `CDP_ERROR` 与
  `domain_not_enabled`；显式启用后使用无效 scriptId，返回
  `resource_not_found`，保留 method、targetId、原生 message 及可用的 code，两次调用均失败且不自动重试
- `ch-cdp-02`: 在 Extension 模式请求浏览器级命令及不存在的方法，保留能力拒绝、`Not allowed` 权限拒绝和
  `method_not_found`；资源查询中的 not found 不升级为整个域不支持；未知原生异常保持错误，不伪装为成功
- `ch-cdp-03`: 通过 `manage cdp Runtime.evaluate` 设置
  `returnByValue=true`，脚本增加自有计数后返回自引用对象，验证 Chrome 实际产生的原生序列化拒绝；注册 callback 和 Extension
  边界反例分别覆盖
  `Object couldn't be returned by value` 与 `Object reference chain is too long`，错误保留
  `CDP_ERROR`、`actionExecuted=true`、`actionStatus=unknown`、`retryable=false`，独立读取计数只增加一次；iframe
  precise 使用相同断言，`readOnly` 策略也不重放序列化失败
- `ch-cdp-04`: 页面脚本主动抛出与原生序列化、关闭 tab 或调试错误相同的文本，仍是脚本异常并保留
  `retryable=false`；原生页面快照及权限检查遇到实际关闭目标时返回失败和 warning，其他查询错误保持原身份
- `ch-frame-01`: iframe 导航销毁 context 后，默认 `staleContextRetry=never` 不重放有副作用脚本；显式 `readOnly`
  时最多重放一次，并返回策略、retry 和最终 frame/context 摘要
- `ch-frame-02`: 两个相同 URL iframe 无法唯一确认所选 DOM owner 时返回 bounded
  candidates 并拒绝执行；身份可确认时命中所选 iframe，不按 URL 列表顺序选择
- `ch-frame-03`: 页面 DOM iframe 与 `webNavigation`
  额外 frame 同时存在时，selector 和 index 都按 DOM 元素身份命中目标，无法建立唯一映射时返回
  `FRAME_IDENTITY_UNAVAILABLE`
- `ch-frame-04`: 使用已启用开发者模式的独立 Chrome
  profile 和独立测试 Server，阻止测试扩展访问其他 MCP 端口；加载修复前制品并访问自有 iframe，再在相同扩展路径更新及原生重载，保留页面不导航；新
  worker 构建身份匹配后重复读取 iframe，
  结果正确且没有新增 ERROR，真实重载结果与 VM 故障注入分别记录
- `ch-frame-05`: 故障注入覆盖 chrome/runtime 缺失、sendMessage 同步与异步 context
  invalidated、旧监听及安装标记共存；失效探测产生可见 warning 并移除自身监听，普通消息拒绝保留诊断且无
  ACK，新请求不触发旧协议；两条父端探测均保留随机 token、document 与唯一候选验证，
  结束后拒绝迟到身份上报并释放 CDP 对象
- `ch-password-01`: 仅用自造 password value、input `find` 和替换 `text` sentinel，分别执行 Extension/CDP 的
  `select`/`replace` 成功与失败、selector/nth 和 post-condition 对照；完整响应及 `error.logs` 定位日志均不得泄露 sentinel，诊断正文返回
  `redacted=true` 与
  `reason="sensitive_input_or_unresolved_target"`，动作和验证状态保持正确；同页有 password 字段时，普通输入仍返回新增
  console/network 诊断；
  下一次普通请求不继承密码保护状态
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
- `ch-challenge-05`: 目标页已恢复后，仅残留 Cloudflare iframe 或旧 pending
  header 不继续判 pending，不触发滚动或点击；可见的验证 widget、verify 控件或正文仍保持等待
- `ch-challenge-06`: 两种 backend 分别覆盖中文标题 `请稍候…` 和普通标题下可见正文“正在进行安全验证”，均判为 JS
  Challenge，等待超时前业务计数为 0，正文恢复后业务动作最多执行一次；隐藏标记和无标记普通页面直接继续，没有固定八秒等待
- `ch-challenge-07`: CDP 用 `Target.getTargetInfo` 读标题，启动时不启用 `Runtime.enable`
- `ch-challenge-08`:
  Extension 在 Challenge 标题持续期间的前八秒只读真实 tab 标题，不 inspect、evaluate 或附加
  debugger；标题恢复后完成有界可见内容检查，无验证证据时立即返回；普通页面的
  evaluate/input 在检查后保留已有自有 debugger 连接，普通标题下发现可见验证控件或仍需验证的正文后才卸除，只有源站响应等待时保留连接，Challenge
  标题下首次 inspect 前卸除
- `ch-challenge-09`:
  Extension 八秒后仍出现可见 Turnstile 才检查并点击；同一类 checkbox/widget 在同一次等待里只点一次，换成可见的
  `Verify you are human` / `请验证您是真人` 按钮后 inspect 判成 `verify`
  再点一次；第一次 inspect 未看到控件时继续查，Extension inspect 走 isolated
  world 且不先挂 debugger，旧 Extension 才回退 stealth/precise，不立刻当纯 JS
  Challenge；同一坐标连续两次 inspect 后才点击；test-page 假按钮走页面点击，Cloudflare
  iframe 只在已聚焦窗口的活动受控 tab 上用系统鼠标，沿路径移动、悬停后再按下抬起，widget 点 compact
  Turnstile 卡片左侧 checkbox，宿主 wrapper 比卡片宽时也只点左侧卡片，Linux 用当前 X11 活动窗口原点加窗口边距且窗口标题必须对应该测试页，不用
  Chrome
  `screenX`，也不用 `outerHeight - innerHeight` 当顶栏，点击前卸掉 debugger 再读视口，DOM 里已有 Cloudflare
  iframe 时即使尺寸为 0 也走系统鼠标，后续宿主页验证按钮同样走系统鼠标，混合窗口不调用
  `focusWindow`；普通编辑区等无关 div 不因尺寸匹配成为 widget；Linux 用 `xprop` 的 GTK frame
  extents 与实际 client 窗口尺寸核对内容原点，覆盖不对称 shadow、缩放与无 client
  shadow 的窗口；按 `browse-challenge-02-turnstile-click` 覆盖 debugger 提示条在路径移动期间消失的坐标更新，数据不符或工具缺失时拒绝点击；原生截图中的控件位置、系统鼠标终点和页面实际 click/change 事件须一致，英文、中文均完成
  checkbox 到 verify 的两阶段变化，不能以 xdotool
  exit 0 替代；缺少系统鼠标工具或窗口未聚焦返回可见错误，不静默改用 CDP 点击；`diagnostics=true` 不用于 Cloudflare 实测
- `ch-challenge-10`: 使用真实旧 Extension，保留版本、bundle 身份与原调用；缺少 `page_snapshot`
  时，无条件 adopt 和导航仍可执行， `pageContext.before/after` 的 `revision=null`
  并附能力 warning，页面 URL 实时变化；显式 `expectedUrl` 或 `expectedRevision` 在派发前返回
  `DRIVER_CAPABILITY_ERROR`、`actionExecuted=false` 和
  `actionStatus="not_started"`，目标状态不变 evaluate 与 input 的两类条件分别验证顶层状态和 error.context 一致，
  `failureStage="precondition"`，
  input 的
  `eventsExecuted=0`；每次拒绝后独立读取脚本计数、输入状态和 URL，确认均未变化旧 Extension 实际返回
  `Unknown action: network_challenge_state` 时记录 server
  warning，回退到标题和 DOM 检测，不中断无条件导航或重放脚本其他接口的 Unknown
  action 不代替该负例；真实旧 Extension 只返回组摘要、缺少 tabIds/targetIds 时，按同次 windows/tabs 中的 groupId
  恢复实际成员和首个成员位置，summary/full、
  targetIds、managedOnly 及空交集分别验证，原生 false 属性和 totalTabCount 保留，无额外 RPC；完全缺少 groups
  时，页面和窗口仍可列出，省略未知 groups 并有能力 warning；
  本地反例区分缺失、合法空数组、合法旧摘要、只提供一个成员数组及 null/非数组等畸形 groups，现代分组成员过滤不变，未知 RPC
  错误继续失败；恢复当前 Extension 后，公开 connect 再次确认版本与 bundle
  match
- `ch-challenge-11`: Cloudflare 可见文案明示验证成功但源站未响应时返回
  `originResponsePending=true`；两种 backend 的 evaluate 在成功、动作失败、后置验证不匹配及输出失败时均保留
  `challengeResolved`、`challengeKind`、`waitedMs`、`clickedTurnstile`、`clearanceCookiePresent`
  和源站等待状态，每次脚本只执行一次；隐藏成功文案和仍显示的 Turnstile 勾选框不算验证完成，也不把目标页写成已加载
- `ch-challenge-12`: 两种 backend 的 open、back、forward、refresh 完成验证并进入业务页后，顶层 URL／title
  使用当前页面信息，与 pageContext.after 的最终 URL 一致，敏感 URL 参数继续脱敏，原导航只执行一次；attach
  和无历史的 back／forward 保持原请求数量，后者保留 navigated=false 并跳过 Challenge；Extension 对只有一个历史项、方向已到边界、受限页和失效主 frame 均及时结束信号等待，保留有效页面历史的既有处理；源站等待时保留
  originResponsePending 语义；最终信息读取共用原 timeout，超时或目标消失返回实际错误，error.context 保留
  actionExecuted=true、actionStatus=completed、failureStage=metadata、retryable=false，独立读取页面后核验结果

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
- 断言：第一组缺省动作及 before/after 都属于 A，默认目标前后为 A；第二组缺省动作及快照属于 C，持久选择响应的默认目标由 A 变为
  C；同一请求嵌套不死锁，`creatingPage`
  的 created/reused/unconfirmed 语义保留

### page-response-errors-01

- 前置：独立测试页的当前 URL/revision 已记录
- 操作：通过公开注册 callback 对 `browse refresh` 与 `manage closePage` 分别提交旧 revision、无读取授权和已消失目标；对
  `manage` 非页面 handler 注入异步拒绝
- 断言：响应保持结构化 `error.code` 和 `pageContext`，旧 revision 错误包含
  `actualUrl`/`actualRevision`，拒绝前不发生输入或关闭；非页面 handler 使用既有错误格式，异步 rejection 不泄漏为纯文本

## Windows 兼容与页面授权专项

以下用例只使用新建的独立测试页，用户原有 Tab 保持导航、打开和活动状态；C4 的授权负例只在独立测试 Chrome
profile 中执行，无需浏览器的回归由 `npm test` 和 `npm run test:extension` 覆盖；Windows 原生行为只有在 Windows
runner/主机实际执行后才算完成

### win-page-target-01（C1、C2）

- 前置：在独立 Extension 测试环境创建 T1/T2，默认目标保持 T1；在独立 CDP 测试环境创建 P1/P2
- 操作：分别用 `evaluate`、`extract`、`input`、`wait`、`logs` 的 `targetId=T2/P2` 读取或修改测试页；随后
  `browse list`；再传旧版 `tabId`，以及同时传入冲突的 `tabId`/`targetId`
- 断言：两种 backend 都命中显式目标，不改变浏览器焦点与默认目标；响应 `pageContext`
  列出实际 ID、来源、操作前后 URL/revision、默认目标前后状态；动作失败的响应也包含
  `pageContext`，但目标状态读取失败时前后快照为 null；Extension 报告 Chrome 活动目标，CDP 标记为 unavailable；冲突 ID
  在执行前被拒绝
- 负例：`browse close` 和 `manage closePage` 缺少 targetId 时均不关闭页面；指定 ID 只关闭指定的测试页

### win-page-condition-01（C3）

- 前置：在独立测试页记录 `browse list` 的 URL/revision，并保存输入框原始值
- 操作：对 `input` 和 `evaluate` 传不匹配的 `expectedUrl` 或过期 `expectedRevision`；对
  `browse back/forward/refresh/close` 与可用的 `manage` 页面动作重复负例；最后用新快照执行多事件 input
- 断言：不匹配时返回 `ACTION_PRECONDITION_FAILED`，响应的
  `error.context.actionExecuted=false`（input/evaluate 顶层同时返回
  `actionExecuted=false`、`actionStatus=not_started`），输入框、导航历史和测试页均未变化；匹配时首个变更动作执行，多事件不因自身
  revision 增加而中止；导航或操作后获取的新
  revision 与旧值不同
- 说明：revision 不覆盖网页自主的所有 DOM 修改；服务进程或 Extension Service Worker 重启后旧 epoch 必须失效

### win-read-grant-01（C4）

- 前置：只在隔离 Chrome profile 中创建普通测试页 U 和由 Extension 创建的 T，连接两个测试服务器实例
- 操作：授权前尝试读取 U；通过服务器 A 调用
  `manage grantReadAccess targetId=<U>`，无需 popup 点击；分别通过服务器 A/B 对 U 执行带 target 的 text、HTML（含
  images=info）、attribute、
  computed:color、state 提取及 JS、截图、输入；调用
  `manage revokeReadAccess` 后重试读取并重新授权；重启前对 T 使用 precise 脚本和输入，重启 Service
  Worker 后读取 U 同一文档，并对 T 再次执行 precise 脚本和输入，独立检查效果；再导航 U 并重复读取
- 断言：授权前两台服务器均不能读取；授权后仅 A 可做普通读取，含 CSS+text、XPath、坐标和 nth 定位；找不到 state 目标时不能返回整页；B
  仍被拒绝；JS/debugger、截图、输入及写动作不因授权开放；
  同一连接和文档保持不变时 Service
  Worker 重启仍可读取，导航和关闭后权限失效；显式 adopt
  U 后无需 popup 只读授权即可进行完整受控操作，release 后完整权限停止；T 的自有 debugger 连接在 Worker 重启后继续可用，原生轨迹须证明
  attach 冲突、有效
  `Runtime.getIsolateId`、后续成功动作且未 detach T 的既有连接
- 恢复竞态：Worker 停止后，通过关闭非受控唤醒页使其重新启动，并在初始化尚未完成时触发关闭事件，原有多个存活受控页全部保留；原生记录分别证明
  Worker-only
  restart 和 Extension reload，不用后者代替前者，初始化完成后的关闭作为对照
- 存储反例：分别使代际标记准备、状态读取、local
  状态提交及后续授权/撤销提交失败，恢复失败保持可见，连接和依赖授权的操作等待恢复成功，既有自动连接入口可重试；提交失败不发布内存权限，成功撤销后重启及重载不恢复，
  失败后的串行更新仍可执行，迟到导航事件不恢复已 release 的页面
- 外部拒绝为条件项：沿用 `logs-network-01` 的真实原生拒绝前置；满足时返回
  `DEBUGGER_BLOCKED`，不能通过 detach 外部连接制造通过；Chrome 允许多客户端时不将合法 attach 成功判为接管，缺少前置则记录该条件项未验证
- 断言：撤销、server instance、documentId、URL 或同 epoch
  revision 变化后授权失效；授权和撤销不改变默认目标、焦点或 revision；注入 storage 失败返回错误
- 断言：授予 A 读取权限后，依次对 U 执行因非受控而被拒绝的
  `updatePage/pinPage/unpinPage/movePage/reorderPage/activatePage` 和
  `browse open/back/forward/refresh/close`；每次拒绝均不发出原生写动作，revision、URL、documentId、焦点和默认目标保持，A
  仍可读取，B 仍被拒绝
- 限制：Cookie 工具的独立作用范围按现有过滤规则测试，不把普通只读授权当成 Cookie 权限

### create-partial-result-01

- 前置：隔离 mock 的 storage、group、navigation、CDP attach 和 RPC 失败注入可用，浏览器真实回归只使用自有测试资产
- 操作：通过 newPage、newWindow 与 browse launch 在创建后注入失败；另使创建 RPC 结果未知，记录旧默认页
- 断言：已知创建 ID、窗口、实际 managed、actionExecuted、actionStatus 与 failureStage 保留到公开错误响应；未知创建结果返回
  unknown，pageContext.targetId
  不使用旧默认页；不自动重复创建或删除
- 验证：本地回归分别覆盖 Extension
  handler、Bridge、UnifiedSession、公开注册 callback 和 CDP；真实 MCP 调用检查部分失败后的 list 与页面上下文，本地 mock
  不替代发版回归

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
- 断言：找到正确可执行文件；带空格路径可启动并连接；Chrome 收到 signal 而提前退出时立即报告信号及 stderr，不等待通用超时；清理独立测试进程和
  profile

### win-screenshot-budget-01（C7）

- 前置：独立受控测试页，准备超过 25 MiB 的测试 PNG 基准文件与可截取的安全小区域
- 操作：分别请求超过单边 16,384、总计 12,000,000 像素或 48
  MiB 估算内存的截图；传入超大 PNG 基准；最后对小区域执行截图和比较
- 断言：尺寸超预算在 capture 前拒绝，超大基准在读取和解码前返回
  `baseline PNG 超过 26214400 字节`；普通截图与对比使用同一预算；小区域截图及 PNG 对比正常

### task-pages-01-persistence-and-native-groups

- 前置：独立 Extension 测试环境，仅包含自有普通窗口和自有测试页
- 先 list，按任务名称及备注后台 attach 复用，无合适页面才 newPage，并传 taskHint/note
- 同任务两次创建返回不同页面及相同可信组，组名可读，创建页不激活，窗口数量不增加
- 保留第二个 Server 连接，仅重启第一个 Server；Extension 自动重连且其他连接保持，Server 延迟启动时沿既有退避继续发现，显式断开取消重试
- Server 重启及 Extension 重载后，来源、备注和组关系保持，后续同任务页复用可信组
- 两个 Server 并发创建及原生 groupId 变更事件与登记交错时，只产生一个可信任务组
- 更新 taskHint/note 后 list、topology、metadata 返回同一最新值；全部成员同名后更新组名
- 旧 v1 记录迁移为 unknown，仍可 attach 和使用受控操作；同名用户组及混合成员组不被认领
- 移动、关闭或成员变化后清理失效关系；备注更新中的 origin/documentId/groupId 无法改变来源与权限
- storage 写入失败返回错误，旧值保留，不报告成功；显式授权 close 可关闭 adopted/unknown 受控页
- 默认清理保留产物、可复用测试页和 adopted/unknown，断线及闲置不关闭页面
- CDP 对照：纯 taskHint/note 正常创建并记录，原生 UI 配置继续明确拒绝

### navigation-wait-02-live-state-and-url-display

- 两种 backend 的 wait navigation 均脱敏认证查询参数；分别执行 browse close 与 manage closePage，响应返回 affected.before/after，affected.before.url 采用同一脱敏规则
- 导航错误与导航超时文案执行相同脱敏，普通查询参数、内部导航和 expectedUrl 使用原值
- CDP 等待完成后，在原 deadline 剩余预算内读取实时 URL/title，覆盖同文档、跨文档及恢复导航
- 实时状态失败或预算耗尽时返回 waitCompleted=true、failureStage=snapshot，不返回旧 URL/title，不重复导航

## 附录 A：已知限制 / KNOWN-LIMIT

- `err-drag-refId-stale-01` — 需要 V8 GC 才能让 WeakRef deref 失败，从外部 mcp 工具无法稳定构造， 靠静态代码 review +
  `dist` 字面量 + 正常 drag 端到端 smoke 保证
- `input-keydown-05-commands-copy-paste` — 依赖剪贴板权限，无权限或 headless 下跳过
