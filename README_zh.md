# claude-tools

[English](./README.md)

Claude Code 的 MCP Server 和 Skill 工具集

## 工具列表

| 工具                                           | 类型       | 功能                                              |
| ---------------------------------------------- | ---------- | ------------------------------------------------- |
| [mcp-claude-history](./mcp-claude-history)     | MCP Server | 搜索、查看和导出对话历史                          |
| [mcp-chrome](./mcp-chrome)                     | MCP Server | 通过 Extension 或 CDP 操作 Chrome 浏览器          |
| [mcp-ssh](./mcp-ssh)                           | MCP Server | SSH 连接、命令执行和文件传输                      |
| [skill-cc-session-fix](./skill-cc-session-fix) | Skill      | 诊断并修复 session JSONL 的 resume 失败与恢复错位 |
| [skill-elenchus](./skill-elenchus)             | Skill      | 用于代码评审和推理的多视角辩证分析                |

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

| 模块               | 版本  | 功能变化                                                                                                  |
| ------------------ | ----- | --------------------------------------------------------------------------------------------------------- |
| mcp-claude-history | 2.1.1 | 大记录索引搜索、来源目录分页、全文导出、精确来源恢复与 Windows 历史路径／私有导出修复                                                      |
| mcp-chrome         | 3.0.1 | 隐藏字段值保护、中键事件、编辑命令仅聚焦、目标／frame／期限修正、按操作对象管理窗口／分组与双后端能力修正 |
| mcp-ssh            | 3.1.0 | 复用已有 OpenSSH master、显式文件校验、目录筛选分页与 SFTP/输出修正                                       |

通过 `ssh_connect(backend="openssh", configHost="myserver")` 显式选择已有主连接复用，默认 ssh2 行为保留
`ssh_sync(verify={sha256: true})` 支持普通文件和目录，传输结果与校验结果分开报告

`ssh_list_dir` 支持名称／时间筛选与显式条数／字节预算，内部同步目录清单保持完整；使用 `history_search(mode="sources")`
对来源分组分页，再执行扫描；`output_content="full"` 将文件正文导出与响应预览分开处理，限制与失败处理见各模块 README

## 主版本迁移

子模块版本独立于仓库的 Release tag

- **mcp-chrome 3.0**：`manage(action="closePage")` 必须指定 `targetId`，操作已有浏览器页面前需 adopt；仅指定 `targetId`
  不授予权限，显式 adopt 后获得完整受控能力，`manage` 和 `browse list`
  支持原生页面、窗口、分组配置与成员状态，相对输出路径使用本会话所有的 `tmp:` 目录，持久输出使用 `cwd:`
- **mcp-ssh 3.0**：`maxOutputSize` 和 PTY `bufferSize`
  按原始 UTF-8 字节计量，消费输出时按字节设置预算并检查截断信息；PTY raw 读取返回清理前的计数
- **mcp-claude-history 2.0**：导出使用独立 bundle 目录和 manifest v2，请使用工具返回的实际路径，不再假定 `output`
  对应单个文件；`max_total` 限制最终紧凑 JSON 响应的 UTF-8 字节数，全集遍历使用 `history_search(mode="scan")`
  及绑定当前进程的 `next_query`，随后读取并释放
  `history_scan_metadata`；normal 保留排序、UUID 去重、regex 和 slice，精确 `source`
  用于消歧，合法超大记录通过索引检索，超出 regex 正文限制时明确报告不完整

参数合同和迁移示例见各模块 README

## 维护者 npm 发布

默认 npm 发版入口为 GitHub Actions 的
[npm Trusted Publishing 工作流](./.github/workflows/npm-publish.yml)，GitHub 每次通过 OIDC 自动取得短期 npm 凭证，无需手动创建、续期或粘贴 npm
token，本机 token 到期不影响这条发布路径

`@pyrokine/mcp-chrome` 和 `@pyrokine/mcp-ssh` 已分别配置 Trusted Publisher：GitHub owner 为 `Pyrokine`，仓库为
`claude-tools`，workflow 文件名为 `npm-publish.yml`，环境为 `npm-publish` Trusted
Publisher 和环境绑定属于一次性配置，仅在配置变化时维护，不列为每次发版步骤允许直接发布，无需另行授予 dist-tag 管理权限，GitHub 环境的部署分支必须仅允许
`main`

从 `main` 手动运行工作流，将 `expected_commit` 设置为已经批准的完整 commit SHA，`publish_chrome` 和 `publish_ssh`
默认均为 `false`，此时只构建、检查两个包并验证 GitHub 到 npm 的真实 OIDC token 交换，不发布版本，也不需要配置
`NPM_TOKEN` secret 构建 job 没有 OIDC 发布权限，认证 job 核对打包制品，不执行包的生命周期脚本

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

正式发版前，完成各模块回归指导、包内容检查和当次发版授权，再仅开启已经批准发布的模块开关工作流发布已核对的 tarball，并验证 registry 的
`gitHead`、integrity 和 `latest`，不会创建仓库 tag 或 GitHub Release npm 发布及验证完成后再创建仓库 release
tag，发布或 registry 验证失败时，先检查 registry 中的实际版本，再决定重试，工作流失败不代表版本尚未发布
