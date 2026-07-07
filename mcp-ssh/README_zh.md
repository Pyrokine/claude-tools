# MCP-SSH

[English](README.md) | 中文

一个功能完善的 SSH MCP 服务器，适用于 AI 助手（Claude、Cursor、Windsurf 等）

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.19-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io/)

![Linux](https://img.shields.io/badge/Linux-tested-success)
![macOS](https://img.shields.io/badge/macOS-untested-yellow)
![Windows](https://img.shields.io/badge/Windows-untested-yellow)

## 功能特性

- **多种认证方式**：密码、SSH 密钥
- **SSH Config 支持**：读取 `~/.ssh/config`，支持 Host 多别名、`Host *` 继承、ProxyJump（`user@host:port` 格式）
- **连接管理**：连接池复用、心跳保持、自动重连
- **会话持久化**：会话信息保存，支持重连
- **命令执行**：
    - 基础执行（带超时）
    - PTY 模式（用于 `top`、`htop` 等交互式命令）
    - `sudo` 执行
    - `su` 切换用户执行
    - 批量执行
    - 多主机并行执行
- **持久化 PTY 会话**：用于长时间运行的交互式命令（top、htop、tmux、vim 等）
    - 输出缓冲区，支持轮询读取
    - 发送按键和命令
    - 窗口大小调整
- **文件操作**：上传、下载、读取、写入、目录列表（通过 SFTP）
- **智能同步**：目录同步，优先使用 rsync（无 rsync 时自动回退到 SFTP）
- **环境配置**：LANG、LC_ALL、自定义环境变量
- **跳板机支持**：通过堡垒机连接

## 兼容客户端

| 客户端            | 状态 |
|----------------|----|
| Claude Code    | ✅  |
| Claude Desktop | ✅  |
| Cursor         | ✅  |
| Windsurf       | ✅  |
| Continue.dev   | ✅  |
| Cline          | ✅  |
| 其他 MCP 兼容客户端   | ✅  |

## 安装

需要 Node.js 20.19 或更新版本。

### npm（推荐）

```bash
npm install -g @pyrokine/mcp-ssh
claude mcp add ssh -- mcp-ssh
```

### 从源码安装

```bash
git clone https://github.com/Pyrokine/claude-tools.git
cd claude-tools/mcp-ssh
npm install
npm run build
claude mcp add ssh -- node "$PWD/dist/index.js"
```

## 配置

### Claude Code

```bash
# npm 安装
claude mcp add ssh -- mcp-ssh

# 源码构建
claude mcp add ssh -- node /path/to/mcp-ssh/dist/index.js
```

### Claude Desktop / 其他客户端

添加到 MCP 配置文件（如 `~/.claude/settings.json` 或客户端特定配置）：

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": [
        "/path/to/mcp-ssh/dist/index.js"
      ]
    }
  }
}
```

## 可用工具（30 个）

### 连接管理

| 工具                  | 描述                          |
|---------------------|-----------------------------|
| `ssh_connect`       | 建立 SSH 连接（支持 ~/.ssh/config） |
| `ssh_disconnect`    | 关闭连接                        |
| `ssh_list_sessions` | 列出活跃会话                      |
| `ssh_reconnect`     | 重新连接断开的会话                   |
| `ssh_config_list`   | 列出 ~/.ssh/config 中的 Host    |

### 命令执行

| 工具                  | 描述                 |
|---------------------|--------------------|
| `ssh_exec`          | 执行命令（支持 PTY 模式）    |
| `ssh_exec_as_user`  | 以其他用户身份执行（通过 `su`） |
| `ssh_exec_sudo`     | 使用 `sudo` 执行       |
| `ssh_exec_batch`    | 批量执行多条命令           |
| `ssh_exec_parallel` | 在多台主机上并行执行命令       |
| `ssh_quick_exec`    | 一次性执行：连接、执行、断开     |
| `ssh_exec_script`   | 上传并执行远端临时脚本        |

### 文件操作

| 工具               | 描述                     |
|------------------|------------------------|
| `ssh_upload`     | 上传本地文件到远程              |
| `ssh_download`   | 从远程下载文件到本地             |
| `ssh_read_file`  | 读取远程文件内容               |
| `ssh_write_file` | 写入内容到远程文件              |
| `ssh_list_dir`   | 列出远程目录内容               |
| `ssh_file_info`  | 获取文件/目录元数据             |
| `ssh_mkdir`      | 创建远程目录                 |
| `ssh_sync`       | 智能同步（优先 rsync，回退 SFTP） |

### PTY 会话（持久化交互式终端）

| 工具               | 描述                                      |
|------------------|-----------------------------------------|
| `ssh_pty_start`  | 启动持久化 PTY 会话（用于 top、htop、tmux 等）        |
| `ssh_pty_write`  | 向 PTY 发送数据（按键、命令）                       |
| `ssh_pty_read`   | 读取 PTY 输出（screen 模式：当前屏幕，raw 模式：ANSI 流） |
| `ssh_pty_resize` | 调整 PTY 窗口大小                             |
| `ssh_pty_close`  | 关闭 PTY 会话                               |
| `ssh_pty_list`   | 列出所有 PTY 会话                             |

### 端口转发

| 工具                   | 描述                    |
|----------------------|-----------------------|
| `ssh_forward_local`  | 本地端口转发（ssh -L）：访问远程服务 |
| `ssh_forward_remote` | 远程端口转发（ssh -R）：暴露本地服务 |
| `ssh_forward_close`  | 关闭端口转发                |
| `ssh_forward_list`   | 列出所有端口转发              |

## 使用示例

### 使用 SSH Config（推荐）

如果已在 `~/.ssh/config` 中配置了主机：

```
# 列出可用主机
ssh_config_list()

# 使用配置的主机名连接
ssh_connect(configHost="myserver")
ssh_exec(alias="myserver", command="uptime")

# 使用自定义配置文件路径
ssh_connect(configHost="myserver", configPath="/custom/path/config")
```

支持的 SSH config 特性：

- `Host` 多别名（如 `Host a b c`）
- `Host *` 全局默认继承（仅第一个 `Host *` 块）
- `HostName`、`User`、`Port`、`IdentityFile`
- `ProxyJump`，支持 `user@host:port` 格式（仅第一跳）
- 显式参数优先于 config 值（如 `ssh_connect(configHost="x", user="覆盖值")`）

**不支持**（跳过）：

- `Include` 指令
- `Match` 块（整个块跳过直到下一个 `Host`）
- 通配符模式（如 `Host *.example.com`）

**行为说明**：

- 多个 `Host *` 块：仅使用第一个
- 重复的 Host 定义：`ssh_config_list` 显示全部，`ssh_connect` 使用第一个
- ProxyJump 中的 IPv6：使用方括号格式 `[2001:db8::1]:22`

### 多主机并行执行

在多个已连接的主机上并行执行同一命令：

```
1. ssh_connect(configHost="server1")
2. ssh_connect(configHost="server2")
3. ssh_connect(configHost="server3")
4. ssh_exec_parallel(aliases=["server1", "server2", "server3"], command="uptime")
```

每台主机的结果保留与 `ssh_exec` 相同的执行元数据，包括 `failureKind`、`effectiveUser`、`cwd`、截断字段和诊断建议。
`ssh_exec_parallel` 单次最多 32 个 alias，默认最多并发 4 台主机，可用 `maxConcurrency` 调整（最大 8），并支持 `maxOutputSize`
限制每台主机的输出

### 基础：连接和执行

```
ssh_connect(host="<server-host>", user="root", keyPath="/home/.ssh/id_rsa", alias="myserver")
ssh_exec(alias="myserver", command="ls -la /home")
ssh_disconnect(alias="myserver")
```

### 连接模板和 runAs

模板可以通过 `SSH_MCP_TEMPLATES` 或 `~/.mcp-ssh/templates.json` 提供，工具显式参数优先于模板值

```json
{
    "app-dev": {
        "host": "<server-host>",
        "port": 22,
        "user": "root",
        "runAs": "appuser",
        "defaultEnv": {
            "APP_ENV": "dev"
        }
    }
}
```

```
ssh_connect(template="app-dev", alias="app-dev")
ssh_exec(alias="app-dev", command="whoami && echo $APP_ENV")
ssh_exec(alias="app-dev", command="whoami", useLoginUser=true)
```

`ssh_connect` 返回 `identity`、`loginUser`、`runAs`、`reused`、`defaultEnvKeys`、`envKeys`，以及同一 `user@host:port` identity
下已连接 alias 的 `reusableSessions`，同一个 alias 连接到不同 identity 会被拒绝，并返回现有 identity 和请求
identity，template 缺失时返回可用模板名，`configHost` 缺失时返回 SSH config 候选并提示调用 `ssh_config_list`

### 跳板机

通过跳板机连接内网服务器：

```
ssh_connect(
  host="<internal-host>",
  user="root",
  keyPath="/home/.ssh/id_rsa",
  alias="internal",
  jumpHost={
    host: "bastion.example.com",
    user: "admin",
    keyPath: "/home/.ssh/bastion_key"
  }
)
```

### 切换用户执行（su）

适用于 SSH 以 root 登录，但需要以其他用户执行命令的场景：

```
1. ssh_connect(host="<server-host>", user="root", keyPath="/home/.ssh/id_rsa", alias="server")
2. ssh_exec_as_user(alias="server", command="whoami", targetUser="appuser")
   // 输出: appuser
```

默认加载 shell 配置以确保环境变量可用（`su -c` 创建非交互式 shell，不会自动执行 rc 文件），支持 bash（`.bashrc`）、zsh（`.zshrc`
）及其他 shell（`.profile`），如不需要可设置 `loadProfile=false`

`ssh_exec` 和 `ssh_exec_as_user` 返回执行元数据：`loginUser`、`effectiveUser`、`identity`、`cwd`、`resolvedCwd`、`shell`、
`profileLoaded`、`envInjectedKeys`、`failureKind`、`stdoutBytes`、`stderrBytes` 和截断提示，大输出会返回 `stdoutHead`、
`stdoutTail`、`stderrHead`、`stderrTail` 和 `recommendedReadCommand`，timeout 错误也包含超时前已经产生的 head/tail 输出，包含
destructive、process-control、service-control、credential-bearing、未限制 `find`、递归 `grep`、长管道、后台任务、直接
`su - user -c` 或长运行模式的命令会返回带 `categories` 和 `signals` 的 `commandRisk`

### 交互式命令（PTY 模式）

用于需要终端的命令：

```
ssh_exec(alias="server", command="top -b -n 1", pty=true)
```

### 临时脚本执行和日志查询 recipe

```
ssh_exec_script(alias="server", script="set -e\nwhoami\npwd", cwd="/tmp", runAs="appuser")
```

日志发现和过滤使用 `ssh_exec_script`，大结果再用 `ssh_read_file` 分块读取：

```
ssh_exec_script(
  alias="server",
  script="find /var/log/app -maxdepth 1 -type f -printf '%T@ %p\\n' | sort -nr | head -20 > /tmp/mcp-log-files.txt\ngrep -n -I -F 'ERROR' /var/log/app/*.log | head -100 > /tmp/mcp-log-errors.txt",
  timeout=30000
)
ssh_read_file(alias="server", remotePath="/tmp/mcp-log-errors.txt", maxBytes=65536)
```

日志查询由通用命令和文件工具组合完成，不再提供独立的日志专用 MCP 工具

### 设置环境变量

```
ssh_connect(
  host="<server-host>",
  user="root",
  keyPath="/home/.ssh/id_rsa",
  env={"LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8"}
)
```

### 快速一次性执行

无需管理连接，适用于单次命令：

```
ssh_quick_exec(
  host="<server-host>",
  user="root",
  keyPath="/home/.ssh/id_rsa",
  command="uptime"
)
```

### 文件操作

```
// 上传
ssh_upload(alias="server", localPath="/tmp/config.json", remotePath="/etc/app/config.json")
ssh_upload(alias="server", localPath="/tmp/config.json", remotePath="/etc/app/config.json", atomic=true, verifySize=true, verifyMd5=true, verifyMode="0644")
// 目录返回 UPLOAD_PATH_IS_DIRECTORY，大文件上传成功后会提示优先使用 ssh_sync，并返回推荐调用

// 下载
ssh_download(alias="server", remotePath="/var/log/app.log", localPath="/tmp/app.log")

// 读取文件内容
ssh_read_file(alias="server", remotePath="/etc/hosts")
ssh_read_file(alias="server", remotePath="/var/log/app.log", tail=true, maxBytes=65536)
ssh_read_file(alias="server", remotePath="/var/log/app.log", offset=1048576, maxBytes=65536)
ssh_read_file(alias="server", remotePath="/var/log/app.log", lineRange="120-180")
```

`ssh_upload` 返回本地路径策略诊断、远端父目录探测、远端目标元数据和可选校验结果，`atomic=true` 会先上传到同目录临时文件，再
rename 到目标路径，`verifySize`、`verifyMd5`、`verifyMode`、`verifyOwner`、`verifyMtime` 会追加显式传输后校验，命令执行结果在远端命令非零退出且没有
stdout/stderr 时返回
`emptyOutputFailure=true`，同时给出 effective user、cwd 和可用的后续读取建议，`ssh_read_file` 默认读取 1 MiB，`maxBytes` 超过
16 MiB 时会在远端传输前拒绝，返回 `total_size`、`read_offset`、`read_bytes`、
`remaining_bytes`、`sample_kind` 和 `truncated`，调用方可以区分完整读取、头部样本、尾部样本、字节范围和行范围

### 目录同步（rsync）

智能同步会自动检测 rsync 可用性，使用 rsync 进行高效增量传输：

```
// 同步本地目录到远程（上传）
ssh_sync(
  alias="server",
  localPath="/local/project",
  remotePath="/remote/project",
  direction="upload"
)
// 返回: { method: "rsync", filesTransferred: 42, ... }

// 带排除模式
ssh_sync(
  alias="server",
  localPath="/local/project",
  remotePath="/remote/project",
  direction="upload",
  exclude=["*.log", "node_modules", ".git"]
)

// 从远程下载
ssh_sync(
  alias="server",
  localPath="/local/backup",
  remotePath="/remote/data",
  direction="download"
)

// 试运行（预览，不实际传输）
ssh_sync(..., dryRun=true)

// 上传单文件后校验远端 owner/mode
ssh_sync(..., direction="upload", verifyOwner="appuser", verifyMode="0644")
```

如果远程或本地没有 rsync，会自动回退到 SFTP，同步响应包含 `transport`、`duration`、`dryRun`、`stats`、`commandSummary` 和
`diagnostics`，其中 `diagnostics` 包含本地路径策略和远端父目录探测结果，SFTP 单文件传输会返回 `verification`，包含本地和远端的
size、mode 或 permissions、mtime、owner/group，以及远端支持 `sha256sum` 时的 SHA-256 对比，upload 单文件同步可用
`verifyOwner` 和 `verifyMode` 追加基于远端元数据的 `ownerMode` 校验，目录同步不递归扫描 owner/mode，会返回 skipped
verification 说明

**注意**：rsync 模式使用 SSH 密钥/代理认证，并设置 `StrictHostKeyChecking=accept-new`（首次连接会自动接受主机密钥），
如需严格的主机密钥验证与管理，请使用 SFTP 模式

### 持久化 PTY 会话（top、tmux 等）

用于持续刷新或需要持续交互的命令：

```
// 1. 启动 top 的 PTY 会话
ssh_pty_start(alias="server", command="top", rows=24, cols=80)
// 返回: { "ptyId": "pty_1_1234567890" }

// 2. 读取当前输出（轮询）
ssh_pty_read(ptyId="pty_1_1234567890")
// 返回: { "data": "top - 10:30:15 up 5 days...", "active": true, "unreadRawBytes": 123, "foregroundProcess": "top" }

// 3. 发送命令（如退出 top）
ssh_pty_write(ptyId="pty_1_1234567890", data="q")

// 4. 完成后关闭
ssh_pty_close(ptyId="pty_1_1234567890")
```

tmux 会话示例：

```
// 启动 tmux
ssh_pty_start(alias="server", command="tmux new -s work")

// 在 tmux 中发送命令
ssh_pty_write(ptyId="pty_1_xxx", data="ls -la\r")

// 读取输出
ssh_pty_read(ptyId="pty_1_xxx")

// 分离 tmux（Ctrl+B, D）
ssh_pty_write(ptyId="pty_1_xxx", data="\x02d")
```

`ssh_pty_read` 和 `ssh_pty_list` 返回 `lastInputAt`、`lastOutputAt`、`lastReadAt`、`unreadRawBytes`、`rawBufferLimit`、
`foregroundProcess`，便于观察长时间运行的会话，无需读取完整 raw 流

常用控制序列：

- 回车: `\r` 或 `\n`
- Ctrl+C: `\x03`
- Ctrl+D: `\x04`
- Ctrl+Z: `\x1a`
- 上箭头: `\x1b[A`
- 下箭头: `\x1b[B`

### 端口转发

访问远程内网服务或暴露本地服务：

```
// 本地转发：通过 localhost:13306 访问远程 MySQL (<service-host>:3306)
ssh_forward_local(alias="server", localPort=13306, remoteHost="<service-host>", remotePort=3306)

// 远程转发：将本地开发服务器 (3000) 暴露到远程端口 8080
ssh_forward_remote(alias="server", remotePort=8080, localHost="127.0.0.1", localPort=3000)

// 列出所有转发
ssh_forward_list()

// 关闭转发
ssh_forward_close(forwardId="fwd_1_xxx")
```

## 配置选项

### 连接选项

| 选项                  | 类型     | 默认值   | 描述          |
|---------------------|--------|-------|-------------|
| `host`              | string | *必需*  | 服务器地址       |
| `user`              | string | *必需*  | 用户名         |
| `password`          | string | -     | 密码认证        |
| `keyPath`           | string | -     | SSH 私钥路径    |
| `port`              | number | 22    | SSH 端口      |
| `alias`             | string | 自动生成  | 连接别名，用于后续引用 |
| `template`          | string | -     | 连接模板名       |
| `env`               | object | -     | 环境变量        |
| `defaultEnv`        | object | -     | 连接级默认环境变量   |
| `runAs`             | string | -     | 默认执行用户      |
| `keepaliveInterval` | number | 30000 | 心跳间隔（毫秒）    |

### 执行选项

| 选项              | 类型      | 默认值       | 描述                     |
|-----------------|---------|-----------|------------------------|
| `timeout`       | number  | 30000     | 命令超时（毫秒）               |
| `cwd`           | string  | -         | 工作目录                   |
| `env`           | object  | -         | 额外环境变量                 |
| `pty`           | boolean | false     | 启用 PTY 模式（用于交互式命令）     |
| `maxOutputSize` | number  | 10 MB 字符  | 输出截断上限                 |
| `runAs`         | string  | 连接级 runAs | 本次命令执行用户               |
| `useLoginUser`  | boolean | false     | 跳过连接级 runAs            |
| `loadProfile`   | boolean | true      | runAs 时加载目标用户 shell 配置 |

## 安全

### 私钥/配置文件路径白名单

`keyPath`（私钥）和 `configPath`（SSH 配置文件）必须位于以下目录之一：

- `~/.ssh/` — 用户 SSH 目录
- `/etc/ssh/` — 系统 SSH 目录

如需扩展白名单，设置环境变量 `SSH_MCP_ALLOWED_KEY_DIRS`，Linux/macOS 用 `:` 分隔，Windows 用 `;` 分隔：

```bash
export SSH_MCP_ALLOWED_KEY_DIRS=/opt/secrets:/var/lib/keys
```

白名单外的文件会被拒绝，错误信息为 `Invalid private key path: ...` 或 `Invalid config path: ...`

### 可选：文件操作路径白名单

`ssh_upload`、`ssh_download`、`ssh_sync` 默认接受任意本地路径，如需在共享环境下限定到指定目录（推荐），
设置 `SSH_MCP_FILE_OPS_ALLOW_DIRS`（路径分隔符跟随 Node `path.delimiter`：POSIX 用 `:`，Windows 用 `;`）：

```bash
export SSH_MCP_FILE_OPS_ALLOW_DIRS=/tmp:/home/me/work
```

设置后，白名单外的本地路径会被拒绝，symlink 会通过 `realpath` 解析以防逃逸；未设置时不做限制（保留灵活性）

### 文件大小上限

- 私钥文件：最大 64 KB
- SSH 配置文件：最大 1 MB

超过上限的文件在读取前即被拒绝

### `ssh_sync` 的 symlink 处理

`ssh_sync(direction="upload", ...)` 对本地 symlink 的处理因底层传输方式而异：

| `followSymlinks` | SFTP 路径                                | rsync 路径                                   |
|------------------|----------------------------------------|--------------------------------------------|
| `false`（默认）      | 跳过，写入 `skippedSymlinks` 字段，warning 中提示 | 按 symlink 本身复制（rsync 默认：保留链接，不上传目标内容）      |
| `true`           | 跟随：上传链接目标内容                            | 通过 rsync `-L` / `--copy-links` 跟随：上传链接目标内容 |

两个默认模式都安全（都不会上传链接目标内容），差异仅在于目标端是否保留 symlink：SFTP 完全跳过不传，rsync 保留为 symlink

## 项目结构

```
mcp-ssh/
├── src/
│   ├── index.ts           # MCP Server 入口，工具定义
│   ├── session-manager.ts # 连接池、执行、心跳
│   ├── file-ops.ts        # SFTP 文件操作
│   └── types.ts           # TypeScript 类型定义
├── dist/                  # 编译后的 JavaScript
├── package.json
├── tsconfig.json
└── README.md
```

## 贡献

欢迎贡献！请随时提交 Pull Request

## 许可证

MIT 许可证 - 详见 [LICENSE](LICENSE)

## 相关项目

- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP 规范
- [MCP Servers](https://github.com/modelcontextprotocol/servers) - 官方 MCP 服务器实现
