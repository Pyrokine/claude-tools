# MCP-SSH

[English](README.md) | 中文

一个功能完善的 SSH MCP 服务器，适用于 AI 助手（Claude、Cursor、Windsurf 等）

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io/)

## 功能特性

- **多种认证方式**：密码、SSH 密钥、SSH Agent
- **连接管理**：连接池复用、心跳保持、自动重连
- **会话持久化**：会话信息保存，支持重连
- **命令执行**：
  - 基础执行（带超时）
  - PTY 模式（用于 `top`、`htop` 等交互式命令）
  - `sudo` 执行
  - `su` 切换用户执行
  - 批量执行
- **持久化 PTY 会话**：用于长时间运行的交互式命令（top、htop、tmux、vim 等）
  - 输出缓冲区，支持轮询读取
  - 发送按键和命令
  - 窗口大小调整
- **文件操作**：上传、下载、读取、写入、目录列表（通过 SFTP）
- **智能同步**：目录同步，优先使用 rsync（无 rsync 时自动回退到 SFTP）
- **环境配置**：LANG、LC_ALL、自定义环境变量
- **跳板机支持**：通过堡垒机连接

## 兼容客户端

| 客户端 | 状态 |
|--------|------|
| Claude Code | ✅ |
| Claude Desktop | ✅ |
| Cursor | ✅ |
| Windsurf | ✅ |
| Continue.dev | ✅ |
| Cline | ✅ |
| 其他 MCP 兼容客户端 | ✅ |

## 安装

### npm（推荐）

```bash
npm install -g @pyrokine/mcp-ssh
```

### 从源码安装

```bash
git clone https://github.com/Pyrokine/claude-mcp-tools.git
cd claude-mcp-tools/ssh
npm install
npm run build
```

## 配置

### Claude Code

```bash
claude mcp add ssh -- node /path/to/mcp-ssh/dist/index.js
```

### Claude Desktop / 其他客户端

添加到 MCP 配置文件（如 `~/.claude/settings.json` 或客户端特定配置）：

```json
{
  "mcpServers": {
    "ssh": {
      "command": "node",
      "args": ["/path/to/mcp-ssh/dist/index.js"]
    }
  }
}
```

## 可用工具（27 个）

### 连接管理

| 工具 | 描述 |
|------|------|
| `ssh_connect` | 建立 SSH 连接并保持心跳 |
| `ssh_disconnect` | 关闭连接 |
| `ssh_list_sessions` | 列出活跃会话 |
| `ssh_reconnect` | 重新连接断开的会话 |

### 命令执行

| 工具 | 描述 |
|------|------|
| `ssh_exec` | 执行命令（支持 PTY 模式） |
| `ssh_exec_as_user` | 以其他用户身份执行（通过 `su`） |
| `ssh_exec_sudo` | 使用 `sudo` 执行 |
| `ssh_exec_batch` | 批量执行多条命令 |
| `ssh_quick_exec` | 一次性执行：连接、执行、断开 |

### 文件操作

| 工具 | 描述 |
|------|------|
| `ssh_upload` | 上传本地文件到远程 |
| `ssh_download` | 从远程下载文件到本地 |
| `ssh_read_file` | 读取远程文件内容 |
| `ssh_write_file` | 写入内容到远程文件 |
| `ssh_list_dir` | 列出远程目录内容 |
| `ssh_file_info` | 获取文件/目录元数据 |
| `ssh_mkdir` | 创建远程目录 |
| `ssh_sync` | 智能同步（优先 rsync，回退 SFTP） |

### PTY 会话（持久化交互式终端）

| 工具 | 描述 |
|------|------|
| `ssh_pty_start` | 启动持久化 PTY 会话（用于 top、htop、tmux 等） |
| `ssh_pty_write` | 向 PTY 发送数据（按键、命令） |
| `ssh_pty_read` | 读取 PTY 输出（screen 模式：当前屏幕，raw 模式：ANSI 流） |
| `ssh_pty_resize` | 调整 PTY 窗口大小 |
| `ssh_pty_close` | 关闭 PTY 会话 |
| `ssh_pty_list` | 列出所有 PTY 会话 |

### 端口转发

| 工具 | 描述 |
|------|------|
| `ssh_forward_local` | 本地端口转发（ssh -L）：访问远程服务 |
| `ssh_forward_remote` | 远程端口转发（ssh -R）：暴露本地服务 |
| `ssh_forward_close` | 关闭端口转发 |
| `ssh_forward_list` | 列出所有端口转发 |

## 使用示例

### 基础：连接和执行

```
1. ssh_connect(host="192.168.1.100", user="root", password="xxx", alias="myserver")
2. ssh_exec(alias="myserver", command="ls -la /home")
3. ssh_disconnect(alias="myserver")
```

### 切换用户执行（su）

适用于 SSH 以 root 登录，但需要以其他用户执行命令的场景：

```
1. ssh_connect(host="192.168.1.100", user="root", password="xxx", alias="server")
2. ssh_exec_as_user(alias="server", command="whoami", targetUser="appuser")
   // 输出: appuser
```

### 交互式命令（PTY 模式）

用于需要终端的命令：

```
ssh_exec(alias="server", command="top -b -n 1", pty=true)
```

### 设置环境变量

```
ssh_connect(
  host="192.168.1.100",
  user="root",
  password="xxx",
  env={"LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8"}
)
```

### 快速一次性执行

无需管理连接，适用于单次命令：

```
ssh_quick_exec(
  host="192.168.1.100",
  user="root",
  password="xxx",
  command="uptime"
)
```

### 文件操作

```
// 上传
ssh_upload(alias="server", localPath="/tmp/config.json", remotePath="/etc/app/config.json")

// 下载
ssh_download(alias="server", remotePath="/var/log/app.log", localPath="/tmp/app.log")

// 读取文件内容
ssh_read_file(alias="server", remotePath="/etc/hosts")
```

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
```

如果远程或本地没有 rsync，会自动回退到 SFTP。

**注意**：rsync 模式使用 SSH 密钥/代理认证，并禁用严格主机密钥检查（`StrictHostKeyChecking=no`）以方便使用。如需主机密钥验证，请使用 SFTP 模式。

### 持久化 PTY 会话（top、tmux 等）

用于持续刷新或需要持续交互的命令：

```
// 1. 启动 top 的 PTY 会话
ssh_pty_start(alias="server", command="top", rows=24, cols=80)
// 返回: { "ptyId": "pty_1_1234567890" }

// 2. 读取当前输出（轮询）
ssh_pty_read(ptyId="pty_1_1234567890")
// 返回: { "data": "top - 10:30:15 up 5 days...", "active": true }

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
// 本地转发：通过 localhost:13306 访问远程 MySQL (10.0.0.5:3306)
ssh_forward_local(alias="server", localPort=13306, remoteHost="10.0.0.5", remotePort=3306)

// 远程转发：将本地开发服务器 (3000) 暴露到远程端口 8080
ssh_forward_remote(alias="server", remotePort=8080, localHost="127.0.0.1", localPort=3000)

// 列出所有转发
ssh_forward_list()

// 关闭转发
ssh_forward_close(forwardId="fwd_1_xxx")
```

## 配置选项

### 连接选项

| 选项 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `host` | string | *必需* | 服务器地址 |
| `user` | string | *必需* | 用户名 |
| `password` | string | - | 密码认证 |
| `keyPath` | string | - | SSH 私钥路径 |
| `port` | number | 22 | SSH 端口 |
| `alias` | string | 自动生成 | 连接别名，用于后续引用 |
| `env` | object | - | 环境变量 |
| `keepaliveInterval` | number | 30000 | 心跳间隔（毫秒） |

### 执行选项

| 选项 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `timeout` | number | 30000 | 命令超时（毫秒） |
| `cwd` | string | - | 工作目录 |
| `env` | object | - | 额外环境变量 |
| `pty` | boolean | false | 启用 PTY 模式（用于交互式命令） |

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

## 路线图

- [ ] 动态端口转发（SOCKS 代理）
- [ ] SSH Agent 转发
- [ ] 命令历史和审计日志
- [ ] 多主机并行执行
- [ ] SSH 配置文件（~/.ssh/config）自动发现

## 贡献

欢迎贡献！请随时提交 Pull Request。

## 许可证

MIT 许可证 - 详见 [LICENSE](LICENSE)。

## 相关项目

- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP 规范
- [MCP Servers](https://github.com/modelcontextprotocol/servers) - 官方 MCP 服务器实现
