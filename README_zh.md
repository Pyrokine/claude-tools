# claude-tools

[English](./README.md)

Claude Code 的 MCP Server 和 Skill 工具集

## 工具列表

| 工具                   | 类型       | 功能                                               |
| ---------------------- | ---------- | -------------------------------------------------- |
| [mcp-claude-history]   | MCP Server | 搜索、查看和导出对话历史                           |
| [mcp-chrome]           | MCP Server | 通过 Extension 或 CDP 操作 Chrome 浏览器           |
| [mcp-ssh]              | MCP Server | SSH 连接、命令执行和文件传输                       |
| [skill-cc-session-fix] | Skill      | 诊断并修复 session JSONL 的 resume 失败与恢复错位  |
| [skill-elenchus]       | Skill      | 按证据评审差异、完整快照和方案，独立分析有明确预算 |

[mcp-claude-history]: ./mcp-claude-history
[mcp-chrome]: ./mcp-chrome
[mcp-ssh]: ./mcp-ssh
[skill-cc-session-fix]: ./skill-cc-session-fix
[skill-elenchus]: ./skill-elenchus

## 安装

TypeScript MCP Server 需要 Node.js 20.19 或更新版本，History server 源码构建需要 Rust
1.88 或更新版本，也可以直接使用 Release 里的预编译二进制

### mcp-ssh

```bash
npm install -g @pyrokine/mcp-ssh
claude mcp add ssh -- mcp-ssh
```

### mcp-chrome

```bash
npm install -g @pyrokine/mcp-chrome
claude mcp add chrome -- mcp-chrome
npm root -g
```

Extension 模式需要打开 `chrome://extensions/`，启用开发者模式，点击“加载已解压的扩展程序”，选择
`<npm-root>/@pyrokine/mcp-chrome/extension/dist`

### mcp-claude-history

从 [GitHub Releases](https://github.com/Pyrokine/claude-tools/releases) 下载二进制，将其放入 `PATH`，然后配置 Claude
Code：

```bash
claude mcp add mcp-claude-history -- mcp-claude-history --mcp
```

各子目录 README 提供源码构建说明和不同 MCP 客户端的 JSON 配置

## 子模块版本

- mcp-claude-history 2.2.0：会话名称、大规模历史精确检索、来源目录分页、全文导出、精确来源恢复与私有导出目录

- mcp-chrome 3.1.0：本地文件上传、字段值保护、任务页面管理、Cloudflare 完成状态、open Shadow DOM 与嵌套 frame、对话框、原响应与下载收件、请求控制、限定范围的 HTTP 认证及 WebSocket/SSE 观察

- mcp-ssh 3.2.0：解释器独立参数、传输进度、已有 OpenSSH master 复用、显式文件校验、目录筛选分页与 SFTP/输出修正

- skill-elenchus 1.2.0：差异、完整快照和设计范围，证据分级与共享评审预算

创建 Chrome 任务页面时使用 `taskHint` 和 `note`，Extension 任务分组跨重载保留名称和创建来源，新建前查看并复用已有页
默认在已有窗口后台创建页面，任务结束后仅关闭明确为本任务创建的临时页，保留用户页面和可复用产物

使用 `input` 的 `{type:"upload", target:{css:"input[type=file]"}, files:["./review.zip"]}` 在 Extension 或 CDP 模式选择本地文件
路径属于 MCP Server 所在机器，`files:[]` 清空选择，文件总大小须低于 50 MiB，站点收件验证见[上传示例](./mcp-chrome/README_zh.md#上传本地文件)

用 `manage` 准备对话框、下载或网络观察，再按 `logs` 返回的引用处理对应弹窗、保存原附件或读取同一次请求的正文
请求控制与 HTTP 认证限定在受控页面，见[浏览器事件与原文件](./mcp-chrome/README_zh.md#浏览器事件与原文件)

通过 `ssh_connect(backend="openssh", configHost="myserver")`
显式选择已有主连接复用，默认 ssh2 后端使用 known-host 信任记录：未知主机在认证前记录，变化或撤销的 key
明确拒绝；首次连接需要独立身份保证时，预置信任记录
`ssh_sync(verify={sha256: true})` 支持普通文件和目录，传输结果与校验结果分开报告

`ssh_list_dir` 支持名称／时间筛选与显式条数／字节预算，内部同步目录清单保持完整；使用 `history_search(mode="sources")`
对来源分组分页，再执行扫描；`output_content="full"` 将文件正文导出与响应预览分开处理，限制与失败处理见各模块 README

## 主版本迁移

子模块版本独立于仓库的 Release tag

- **mcp-chrome 3.0**：`manage(action="closePage")` 必须指定 `targetId`，用户页面的普通读取使用 `grantReadAccess`，
  已授权修改使用 `adoptPage`；仅指定 `targetId` 不授予权限，显式 adopt 后获得完整受控能力，`manage` 和 `browse list`
  支持原生页面、窗口、分组配置与成员状态，相对输出路径使用本会话所有的 `tmp:` 目录，持久输出使用 `cwd:`
- **mcp-ssh 3.0**：`maxOutputSize` 和 PTY `bufferSize`
  按原始 UTF-8 字节计量，消费输出时按字节设置预算并检查截断信息；PTY raw 读取返回清理前的计数
- **mcp-claude-history 2.0**：导出使用独立 bundle 目录和 manifest v2，请使用工具返回的实际路径，不再假定 `output`
  对应单个文件；`max_total` 限制最终紧凑 JSON 响应的 UTF-8 字节数，全集遍历使用 `history_search(mode="scan")`
  及绑定当前进程的 `next_query`，随后读取并释放
  `history_scan_metadata`；normal 保留排序、UUID 去重、regex 和 slice，精确 `source`
  用于消歧，合法超大记录通过索引检索，超出 regex 正文限制时明确报告不完整

参数合同和迁移示例见各模块 README

## 评审与验证

`/elenchus mode=full .` 在没有 diff 时仍评审仓库快照，`mode=diff` 保留改动评审，`mode=design`
用于方案判断，报告区分实际运行、源码支持与需要验证的条件，覆盖记录和共享审查预算见 [Elenchus](./skill-elenchus)

[跨平台工作流](./.github/workflows/windows-tests.yml) 覆盖 Ubuntu、Windows 和 macOS，包含 Node.js 20.19.0、Rust
1.88 及 Python 会话修复夹具，Release 和 npm 认证任务依赖同一次工作流提交的这些检查，自动门禁与各模块回归指导及当次发布授权共同使用

## 格式化

在仓库根目录执行 `npm ci`，为 IDE 和命令行安装同一份锁定的 Prettier 3.9.5：

```bash
npm ci
npm run format:check
```

Prettier 负责其支持文件的排版，rustfmt 负责 Rust，ESLint 和 Stylelint 保留代码质量检查
根目录 `.prettierrc` 和 `.editorconfig` 规定 4 空格和 LF，JS/TS 字符串优先单引号，HTML 属性与 JSON 使用双引号
仅 `*.js` 保留语句分号，TS、MJS、CJS 延续省略分号的风格，Markdown 保留正文换行和嵌入代码排版
无扩展名的 `.prettierrc` 使用严格 JSON，并通过专用 `parser: json` 规则保持自身排版

`.gitattributes` 将 Git 文本检出固定为 LF，即使启用了 `core.autocrlf=true`，二进制内容保持原样

120 列是排版参考宽度，完整 URL、字符串字面量和保留换行的正文超过该宽度时，采用格式化器的输出

根目录的 `format:check` 检查全部受支持的公共文件，包含根配置、workflow、模块源码与测试、Extension HTML 和 Skill 文档
执行 `npm run format` 格式化相同范围，`.prettierignore` 排除私有设置与运行状态、依赖、构建产物、缓存、任务记录和自动生成的锁文件

模块命令使用相同的根配置和忽略规则，检查范围限定为对应模块目录：

```bash
npm --prefix mcp-chrome run format:check
npm --prefix mcp-ssh run format:check
cargo fmt --manifest-path mcp-claude-history/Cargo.toml --check
```

在对应 TypeScript 模块执行 `npm run format`，或在 Rust 模块执行 `cargo fmt` 应用格式化
安装 Chrome Server、Extension 和 SSH 的开发依赖后，在根目录执行 `npm run test:format`，
检查 CLI 文件覆盖、有效规则及 Prettier/ESLint、Prettier/Stylelint 重复修复后的内容，验证语义诊断仍然生效
现有跨平台工作流执行 `format:check` 和 `test:format`

对格式化器管理的源码执行 CCG 质量检查时，完成上述格式检查，再使用
`/ccg:verify-quality mcp-chrome/src mcp-ssh/src mcp-claude-history/src --skip-line-length`
该参数将文本行长规则交给格式化器，保留文件覆盖、类型检查和其他质量检查

在 JetBrains IDE 中安装并启用与其 build 兼容的 Prettier 插件
共享的 `.idea/prettier.xml` 使用 **Automatic configuration** 和根格式规则，根目录与模块包均锁定 Prettier 3.9.5
项目设置启用 **Run on 'Reformat Code' action**（`Ctrl+Alt+L`）和 **Run on save**，
覆盖 JS/TS、JSON、样式文件、Vue/Astro、Markdown、HTML、YAML 和 `.prettierrc`
设置位置为 **Settings → Languages & Frameworks → JavaScript → Prettier**

在 **Settings → Tools → Actions on Save → Reformat code** 中，仅选择 Prettier 覆盖范围之外的文件类型，该选择保存在本项目私有 workspace 中
保留 ESLint 语义修复、**Optimize imports** 和 **Rearrange entries**，有依赖关系的对象在构造函数中按依赖顺序初始化
共享项目样式采用 HTML 属性双引号，项目 inspection 按文件范围将行宽交给 Prettier/rustfmt、缩进检查交给 Prettier，其他代码检查保持启用
其他编辑器使用相同的格式化器锁定版本和仓库配置
共享的 `.idea/compiler.xml` 将 TypeScript 语言服务指向已安装的 `mcp-ssh/node_modules/@typescript/old/lib`，支持正常的 import 优化
现有构建命令继续使用 TypeScript 7，兼容包的 API 包装入口无法启动实际语言服务会话

## 维护者 npm 发布

默认 npm 发版入口为 GitHub Actions 的
[npm Trusted Publishing 工作流](./.github/workflows/npm-publish.yml)，GitHub 每次通过 OIDC 自动取得短期 npm
凭证，无需手动创建、续期或粘贴 npm
token，本机 token 到期不影响这条发布路径

`@pyrokine/mcp-chrome` 和 `@pyrokine/mcp-ssh` 已分别配置 Trusted Publisher：GitHub owner 为 `Pyrokine`，仓库为
`claude-tools`，workflow 文件名为 `npm-publish.yml`，环境为 `npm-publish`

Trusted Publisher 和环境绑定属于一次性配置，仅在配置变化时维护，不列为每次发版步骤；
权限设置允许直接发布，无需另行授予 dist-tag 管理权限；GitHub 环境的部署分支必须仅允许 `main`

从 `main` 手动运行工作流，将 `expected_commit` 设置为已经批准的完整 commit SHA，`publish_chrome` 和 `publish_ssh`
默认均为 `false`，此时只构建、检查两个包并验证 GitHub 到 npm 的真实 OIDC token 交换，不发布版本，也不需要配置
`NPM_TOKEN` secret；构建 job 没有 OIDC 发布权限，认证 job 核对打包制品，不执行包的生命周期脚本

将 `APPROVED_FULL_SHA` 替换为当次批准的完整 SHA，执行以下命令只验证、不发布：

```bash
gh workflow run npm-publish.yml \
  --repo Pyrokine/claude-tools \
  --ref main \
  -f expected_commit=APPROVED_FULL_SHA \
  -f publish_chrome=false \
  -f publish_ssh=false
```

本机直接执行 `npm publish` 属于单独明确授权的操作，仍需本机 npm 鉴权

正式发版前，完成各模块回归指导、包内容检查和当次发版授权，再仅开启已经批准发布的模块开关；
工作流发布已核对的 tarball，并验证 registry 的 `gitHead`、integrity 和 `latest`，不会创建仓库 tag 或 GitHub Release

npm 发布及验证完成后再创建仓库 release tag；发布或 registry 验证失败时，先检查 registry 中的实际版本，再决定重试，
失败工作流的实际发布状态以 registry 查询结果为准
