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

## 可用工具（35 个）

### 连接管理

| 工具                  | 描述                          |
|---------------------|-----------------------------|
| `ssh_connect`       | 建立 SSH 连接（支持 ~/.ssh/config） |
| `ssh_disconnect`    | 关闭连接                        |
| `ssh_list_sessions` | 列出精简会话，可选详情或字段筛选             |
| `ssh_reconnect`     | 重新连接断开的会话                   |
| `ssh_config_list`   | 列出 ~/.ssh/config 中的 Host    |

`ssh_list_sessions()` 默认只返回 `alias`、规范化 `identity`、`runAs`、`connected` 和 `lastUsedAt`，使用 `detail=true` 获取连接详情，或通过 `fields=[...]` 选择字段，任何模式都不返回 `keyPath`

`ssh_reconnect` 会在发布替代连接前，使绑定旧 client 的 operation、PTY、forward 和传输能力缓存失效；自动重连 timer 绑定发起调度的 session 和 client，不会断开同一 alias 下后来发布的新会话；旧 client 延迟到达的 `close` 不会让过期资源继续挂在同一 alias 下；通过 jump host 建立目标连接时，如果取消发生在 `forwardOut` pending 阶段，延迟 callback 返回的 channel 会先销毁再结束连接请求

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

### 可跟踪任务

| 工具                     | 描述                           |
|------------------------|------------------------------|
| `ssh_operation_start`  | 启动可跟踪的长时间远端命令               |
| `ssh_operation_status` | 读取状态、PID、退出码和输出计数            |
| `ssh_operation_read`   | 按字节偏移读取有上限的 stdout 和 stderr   |
| `ssh_operation_cancel` | 校验任务 marker 后发送 TERM            |
| `ssh_operation_list`   | 列出未过期任务，可按 alias 过滤           |

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

`ssh_connect` 返回实际发布会话的 `identity`、`loginUser`、`runAs`、`reused`、`defaultEnvKeys`、`envKeys`，以及同一 `user@host:port` identity 下已连接 alias 的 `reusableSessions`，并发调用只有在完整会话配置一致时才复用同一 alias，包括 endpoint、认证、`runAs`、环境变量、jump host、keepalive 和 timeout；pending 或 active 连接的配置冲突时会被拒绝，即使 `user@host:port` identity 相同，template 缺失时返回可用模板名，`configHost` 缺失时返回 SSH config 候选并提示调用 `ssh_config_list`

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

### 可跟踪的长时间命令

需要命令跨越一次同步工具调用继续执行时，使用 operation 工具组：

```
ssh_operation_start(alias="server", command="long-running-job", maxOutputBytes=1048576, startTimeoutMs=30000)
ssh_operation_status(operationId="op_xxx")
ssh_operation_read(operationId="op_xxx", stdoutOffset=0, stderrOffset=0, maxBytes=65536)
ssh_operation_cancel(operationId="op_xxx")
```

start 返回不可预测的 `operationId`，服务端在请求 SSH channel 前创建记录，保存有硬上限的 stdout 和 stderr，并在校验每个任务独立的 marker 后记录远端 PID；`startTimeoutMs` 限制 channel 建立等待，默认 30 秒、最大 10 分钟，超时错误的 details 返回 `operationId`，对应记录进入可查询的 `unknown` 终态，在旧 channel request 返回或 alias 断开前拒绝同 alias 的另一次 pending start；`maxOutputBytes` 默认 1 MiB、最大 8 MiB，`retentionMs` 默认 1 小时、最大 24 小时，`ssh_operation_read.maxBytes` 默认 64 KiB、最大 1 MiB，marker 和 PID 未完成校验时拒绝取消，shell profile 在 marker 前写入的 stderr 会保留为任务输出，包括未换行 preamble 后紧接 marker 的情况；使用 operation marker 前缀但 token 不匹配、长度超限或进程元数据无效时，记录进入 `failed` 终态、关闭 channel 并开始 retention 计时；断开或替换 SSH session 后才返回的 exec、sudo、SFTP、PTY start 和 operation start callback 都会被拒绝并销毁 channel，sudo callback 在 timeout 后返回时也会先关闭，不会写入密码；operation listener 会在 SSH exec callback 返回前安装，极短命令即使立即输出 marker 并关闭，也会进入终态并设置 `finishedAt` 和 `expiresAt`；SSH 会话在 tracked command 运行期间断开后状态变为 `unknown`，不会声称远端进程已经停止，`ssh_exec` 保持原有同步 timeout 行为

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

`ssh_upload` 返回本地路径策略诊断、远端父目录探测、远端目标元数据和可选校验结果，`atomic=true` 使用不可预测的同目录临时路径和 SFTP 独占创建，返回 `diagnostics.tempRemotePath`，先对临时文件完成全部请求的校验，再 rename 到目标路径；响应使用 `finalRemotePath` 表示最终目标，`verifiedRemotePath` 表示实际执行校验的路径，atomic 校验还会返回 `verifiedTempRemotePath`，`verification.actual.remotePath` 始终描述真正被校验的文件，即使该临时路径随后已被 rename，最终状态需要结合 `targetReplaced` 和 `targetReplacementStatus` 判断；已有目标通过 OpenSSH `posix-rename@openssh.com` 扩展替换，新目标使用标准 SFTP rename；客户端无法发出 rename 请求时返回 `operationStatus="failed"`、`targetReplaced=false` 和 `targetReplacementStatus="not_replaced"`，请求发出后的错误无法证明服务端是否已提交，返回 `operationStatus="unknown"`、`targetReplaced=null` 和 `targetReplacementStatus="unknown"`，重试前应先检查目标内容；两种失败都会尝试清理临时文件；`verifySize`、`verifyMd5`、`verifyMode`、`verifyOwner`、`verifyMtime` 会追加显式传输校验，父目录和目标探测、递归建目录、文件哈希、rename、临时文件清理都使用 SFTP，普通上传不依赖 GNU `stat`、`md5sum`、`sha256sum`、`mkdir`、`mv` 或 `rm`，可用于禁用 exec 的 SFTP-only 服务和 BSD 系统，显式目录 manifest 校验仍会执行远端 shell 命令

`ssh_download` 先写入目标同目录的临时文件，SFTP 流关闭且传输字节数与 SFTP `stat` 报告的大小一致后再 rename 到本地目标；下载失败、提前截断或取消时会删除临时文件，已有本地目标保持原内容，SFTP 目录列表在构造子路径前会拒绝空名称、`.`、`..`、NUL 和路径分隔符

命令执行结果在远端命令非零退出且没有 stdout/stderr 时返回 `emptyOutputFailure=true`，同时给出 effective user、cwd 和可用的后续读取建议，`ssh_read_file` 默认读取 1 MiB，`maxBytes` 超过 16 MiB 时会在远端传输前拒绝，返回 `total_size`、`read_offset`、`read_bytes`、`remaining_bytes`、`sample_kind` 和 `truncated`，调用方可以区分完整读取、头部样本、尾部样本、字节范围和行范围

### 使用 rsync 或 SFTP 同步目录

智能同步只在直连且存在已校验 key path 或可用 SSH agent 时选择 rsync，password、inline key、jump host 和其他无法安全交给 OpenSSH 的路由直接使用 SFTP：

```
// 同步本地目录到远程（上传）
ssh_sync(
  alias="server",
  localPath="/local/project",
  remotePath="/remote/project",
  direction="upload"
)
// 返回 selectedTransport、decisionReason、各阶段耗时和传输计数

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

// 使用有界 manifest 校验目录
ssh_sync(
  ...,
  verify={count: true, sha256: true, owner: true, mode: true, staleFiles: true}
)

// 校验传输前存在且应由 --delete 删除的条目已经消失
ssh_sync(..., delete=true, verify={deletions: true})
```

目录源路径在 rsync 和 SFTP 模式下都表示“把源目录内容同步到目标根目录”，目录源使用 `recursive=false` 会被明确拒绝，相对排除模式按源目录下的相对路径匹配，不含 `/` 的模式匹配每一级 basename

目录校验会生成有界的本地和远端 manifest，可比较条目数、SHA-256 root manifest、owner、mode、旧文件和删除结果，`verify.deletions=true` 必须同时设置 `delete=true`，工具会在传输前记录目标目录，只检查这些删除候选是否消失，`staleFiles` 则独立检查目标端全部额外条目，响应只返回摘要和最多 20 个 mismatch 样本，不返回完整 manifest，默认上限为 10000 个条目、单文件 256 MiB、总哈希字节 1 GiB，可通过 `verify.maxEntries`、`verify.maxFileBytes` 和 `verify.maxTotalBytes` 提高到最多 50000 个条目、单文件 4 GiB、总哈希字节 16 GiB，遇到被跳过的 symlink 或不支持的文件系统条目时，校验会明确返回 `skipped`，不会报告部分匹配成功

请求校验后，mismatch、skipped 或校验错误都会令顶层 `success=false`，`transferSuccess` 仍单独表示传输是否完成，`verificationStatus`、`verificationSuccess` 和 `failedChecks` 描述校验结果，SFTP 单文件同步还会返回本地和远端的 size、mode 或 permissions、mtime、owner/group，以及通过 SFTP 流读取计算的 SHA-256 对比，upload 单文件使用 `verifyOwner` 和 `verifyMode`，目录逐项校验使用 `verify.owner` 和 `verify.mode`

只有直连且存在已校验 key path 或可用 SSH agent 时才选择 rsync，password、inline key 和 jump host 会使用 SFTP，因为独立 OpenSSH 进程无法安全继承对应路由或认证材料，`preflightTimeout`、`connectTimeout` 和 `operationTimeout` 分别限制能力预检、rsync SSH 建连和完整传输，默认值为 10 秒、30 秒和 10 分钟，不具备 rsync 条件的 session 会返回 `rsyncProbe.status="skipped"` 和路由判定原因，不再省略 probe，rsync 模式设置 `StrictHostKeyChecking=accept-new`，SFTP 不支持 `delete=true`，此类请求会明确失败，不会报告已经删除，如需严格的主机密钥验证与管理，请使用 SFTP 模式

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
`foregroundProcess`，便于观察长时间运行的会话，无需读取完整 raw 流，有限命令自然结束后仍可读取最终 screen，返回 `active=false`，
直到显式 close 或 closed session 保留期结束，默认 5 分钟，可通过 `SSH_MCP_PTY_CLOSED_RETENTION_MS` 调整

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

// 由 SSH 服务器动态分配远程端口，使用返回结果中的 remotePort
ssh_forward_remote(alias="server", remotePort=0, localHost="127.0.0.1", localPort=3000)

// 列出所有转发
ssh_forward_list()

// listener 释放后返回成功
ssh_forward_close(forwardId="fwd_1_xxx", mode="graceful", timeoutMs=5000)

// 销毁活跃连接后释放 listener
ssh_forward_close(forwardId="fwd_1_xxx", mode="force", timeoutMs=5000)
```

关闭成功表示本地 `server.close` 或远端 `unforwardIn` callback 已完成，结果包含 `listenerReleased`、`remoteUnforwarded`、`activeConnections`、`closeMode` 和 `retryable`，超时或 callback 失败时 forward 仍保留在 `ssh_forward_list`，可以使用同一 `forwardId` 重试，本地转发关闭成功后端口可立即重新 bind，`remotePort=0` 会返回实际分配端口，后续连接路由和 `unforwardIn` 都使用该端口

forward 在 `listen` 或 `forwardIn` 完成前就进入生命周期管理，disconnect 会取消 pending creation；延迟返回的本地 listener 会被关闭，延迟分配的远端 listener 会被移除；close 开始后立即拒绝新的本地或远端连接，`forwardOut`、close 和 unforward 的延迟 callback 修改状态前会检查同一生命周期记录，已关闭的 forward 不会重新出现在 `ssh_forward_list`；每条本地转发连接同时跟踪本地 socket 和 SSH `forwardOut` channel，任一端关闭或失败都会销毁另一端，force close 只在两端都销毁且 `activeConnections` 归零后返回；每个 alias 最多允许 32 个 pending `forwardOut` 请求，close 会等待全部 callback；如果 SSH 服务端始终不回应 channel-open，请求会超时并保留可重试的 forward，同时拒绝同 alias 新建 local forward，避免 ssh2 pending channel 继续累积，此时断开 alias 才能释放始终不返回的底层请求

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
| `readyTimeout`      | number | 30000 | 等待 SSH ready 的超时，最大 600000 毫秒 |
| `jumpHost.readyTimeout` | number | 继承顶层值 | 跳板机等待 SSH ready 的超时，最大 600000 毫秒 |

连接失败返回 `failureStage`、`retryable` 和限量建议，`failureStage` 为 `preflight`、`authentication`、`ready_timeout`、`transport_or_handshake` 或 `unknown`，多跳连接还可能返回 `connectionStep`，取值为 `key_read`、`jump_connect`、`jump_forward` 或 `target_connect`

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

传入 `cwd` 或 `env` 时，生成的 shell 命令会用 `&&` 连接 `cd` 和每个通过校验的 `export`，再把完整用户命令作为当前登录 shell 的一个转义后 `eval` 参数执行；目录切换或环境变量注入失败后，用户命令的任何部分都不会执行，包括 `;`、换行或 `||` 后的内容，同时 Bash/Zsh 专有语法保持与直接 SSH 命令相同的解释器语义

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

设置后，白名单外的本地路径会被拒绝，symlink 会通过 `realpath` 解析；白名单生效时，`ssh_sync(direction="upload", followSymlinks=true)` 会在选择 transport 前被拒绝，symlink 可在校验和传输之间改变目标，rsync 也无法把预检目标绑定到后续 `-L` 读取；应保持 `followSymlinks=false`，或先把普通文件复制到允许目录再同步

### 文件大小上限

- 私钥文件：最大 64 KB
- SSH 配置文件：最大 1 MB

超过上限的文件在读取前即被拒绝

### `ssh_sync` 的 symlink 处理

`ssh_sync(direction="upload", ...)` 对本地 symlink 的处理因底层传输方式而异：

| `followSymlinks` | SFTP 路径                                | rsync 路径                                   |
|------------------|----------------------------------------|--------------------------------------------|
| `false`（默认）      | 跳过，写入 `skippedSymlinks` 字段，warning 中提示 | 通过 `--no-links` 跳过                        |
| `true`           | 跟随：上传链接目标内容                            | 通过 rsync `-L` / `--copy-links` 跟随：上传链接目标内容 |

两种传输都会跳过 device 和特殊文件系统条目，SFTP 返回 `skippedUnsupported` 和最多 10 个样本路径，rsync 使用 `--no-devices --no-specials`，目录校验也会报告被跳过的 symlink 和不支持条目，不会把不完整 manifest 当成匹配成功

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
