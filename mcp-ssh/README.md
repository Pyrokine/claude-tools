# MCP-SSH

English | [中文](README_zh.md)

A comprehensive SSH MCP Server for AI assistants (Claude, Cursor, Windsurf, etc.)

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io/)

![Linux](https://img.shields.io/badge/Linux-tested-success)
![macOS](https://img.shields.io/badge/macOS-untested-yellow)
![Windows](https://img.shields.io/badge/Windows-untested-yellow)

## Features

- **Multiple Authentication**: Password, SSH key, SSH agent
- **SSH Config Support**: Read `~/.ssh/config` with Host aliases, `Host *` inheritance, ProxyJump (`user@host:port`)
- **Connection Management**: Connection pooling, keepalive, auto-reconnect
- **Session Persistence**: Sessions info saved for reconnection
- **Command Execution**:
  - Basic exec with timeout
  - PTY mode (for interactive commands like `top`, `htop`)
  - `sudo` execution
  - `su` (switch user) execution - *run commands as different user*
  - Batch execution
  - Parallel execution on multiple hosts
- **Persistent PTY Sessions**: For long-running interactive commands (top, htop, tmux, vim, etc.)
  - Output buffering with polling read
  - Send keystrokes and commands
  - Window resize support
- **File Operations**: Upload, download, read, write, list directory (via SFTP)
- **Smart Sync**: Directory sync with rsync (auto-fallback to SFTP if rsync unavailable)
- **Environment Configuration**: LANG, LC_ALL, custom env vars
- **Jump Host Support**: Connect through bastion hosts

## Compatible Clients

| Client | Status |
|--------|--------|
| Claude Code | ✅ |
| Claude Desktop | ✅ |
| Cursor | ✅ |
| Windsurf | ✅ |
| Continue.dev | ✅ |
| Cline | ✅ |
| Any MCP-compatible client | ✅ |

## Installation

### npm (Recommended)

```bash
npm install -g @pyrokine/mcp-ssh
```

### From Source

```bash
git clone https://github.com/Pyrokine/claude-mcp-tools.git
cd claude-mcp-tools/mcp-ssh
npm install
npm run build
```

## Configuration

### Claude Code

```bash
claude mcp add ssh -- node /path/to/mcp-ssh/dist/index.js
```

### Claude Desktop / Other Clients

Add to your MCP settings (e.g., `~/.claude/settings.json` or client-specific config):

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

## Available Tools (29 tools)

### Connection Management

| Tool | Description |
|------|-------------|
| `ssh_connect` | Establish SSH connection (supports ~/.ssh/config) |
| `ssh_disconnect` | Close connection |
| `ssh_list_sessions` | List active sessions |
| `ssh_reconnect` | Reconnect a disconnected session |
| `ssh_config_list` | List hosts from ~/.ssh/config |

### Command Execution

| Tool | Description |
|------|-------------|
| `ssh_exec` | Execute command (supports PTY mode) |
| `ssh_exec_as_user` | Execute as different user (via `su`) |
| `ssh_exec_sudo` | Execute with `sudo` |
| `ssh_exec_batch` | Execute multiple commands sequentially |
| `ssh_exec_parallel` | Execute command on multiple hosts in parallel |
| `ssh_quick_exec` | One-shot: connect, execute, disconnect |

### File Operations

| Tool | Description |
|------|-------------|
| `ssh_upload` | Upload local file to remote server |
| `ssh_download` | Download remote file to local |
| `ssh_read_file` | Read remote file content |
| `ssh_write_file` | Write content to remote file |
| `ssh_list_dir` | List remote directory contents |
| `ssh_file_info` | Get file/directory metadata |
| `ssh_mkdir` | Create remote directory |
| `ssh_sync` | Smart sync with rsync (fallback to SFTP) |

### PTY Sessions (Persistent Interactive Terminal)

| Tool | Description |
|------|-------------|
| `ssh_pty_start` | Start persistent PTY session (for top, htop, tmux, etc.) |
| `ssh_pty_write` | Send data to PTY (keystrokes, commands) |
| `ssh_pty_read` | Read PTY output (screen mode: current screen, raw mode: ANSI stream) |
| `ssh_pty_resize` | Resize PTY window |
| `ssh_pty_close` | Close PTY session |
| `ssh_pty_list` | List all PTY sessions |

### Port Forwarding

| Tool | Description |
|------|-------------|
| `ssh_forward_local` | Local port forwarding (ssh -L): access remote services |
| `ssh_forward_remote` | Remote port forwarding (ssh -R): expose local services |
| `ssh_forward_close` | Close port forwarding |
| `ssh_forward_list` | List all port forwards |

## Usage Examples

### Using SSH Config (Recommended)

If you have hosts configured in `~/.ssh/config`:

```
# List available hosts
ssh_config_list()

# Connect using config host name
ssh_connect(configHost="myserver")
ssh_exec(alias="myserver", command="uptime")

# Use custom config file path
ssh_connect(configHost="myserver", configPath="/custom/path/config")
```

Supported SSH config features:
- `Host` with multiple aliases (e.g., `Host a b c`)
- `Host *` global defaults inheritance (first `Host *` block only)
- `HostName`, `User`, `Port`, `IdentityFile`
- `ProxyJump` with `user@host:port` format (first hop only)
- Explicit parameters override config values (e.g., `ssh_connect(configHost="x", user="override")`)

**Not supported** (skipped):
- `Include` directive
- `Match` blocks (entire block skipped until next `Host`)
- Wildcard patterns (e.g., `Host *.example.com`)

**Behavior notes**:
- Multiple `Host *` blocks: only first is used
- Duplicate Host definitions: `ssh_config_list` shows all, `ssh_connect` uses first
- IPv6 in ProxyJump: use bracket notation `[2001:db8::1]:22`

### Parallel Execution on Multiple Hosts

Execute the same command on multiple connected hosts:

```
1. ssh_connect(configHost="server1")
2. ssh_connect(configHost="server2")
3. ssh_connect(configHost="server3")
4. ssh_exec_parallel(aliases=["server1", "server2", "server3"], command="uptime")
```

### Basic: Connect and Execute

```
ssh_connect(host="192.168.1.100", user="root", keyPath="/home/.ssh/id_rsa", alias="myserver")
ssh_exec(alias="myserver", command="ls -la /home")
ssh_disconnect(alias="myserver")
```

### Jump Host (Bastion)

Connect to internal server via jump host:

```
ssh_connect(
  host="10.0.0.5",
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

### Switch User Execution (su)

Perfect for scenarios where you SSH as root but need to run commands as another user:

```
1. ssh_connect(host="192.168.1.100", user="root", password="xxx", alias="server")
2. ssh_exec_as_user(alias="server", command="whoami", targetUser="appuser")
   // Output: appuser
```

### Interactive Commands (PTY mode)

For commands that need a terminal:

```
ssh_exec(alias="server", command="top -b -n 1", pty=true)
```

### With Environment Variables

```
ssh_connect(
  host="192.168.1.100",
  user="root",
  password="xxx",
  env={"LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8"}
)
```

### Quick One-shot Execution

No need to manage connections for single commands:

```
ssh_quick_exec(
  host="192.168.1.100",
  user="root",
  password="xxx",
  command="uptime"
)
```

### File Operations

```
// Upload
ssh_upload(alias="server", localPath="/tmp/config.json", remotePath="/etc/app/config.json")

// Download
ssh_download(alias="server", remotePath="/var/log/app.log", localPath="/tmp/app.log")

// Read file content
ssh_read_file(alias="server", remotePath="/etc/hosts")
```

### Directory Sync (with rsync)

Smart sync automatically detects rsync availability and uses it for efficient incremental transfer:

```
// Sync local directory to remote (upload)
ssh_sync(
  alias="server",
  localPath="/local/project",
  remotePath="/remote/project",
  direction="upload"
)
// Returns: { method: "rsync", filesTransferred: 42, ... }

// Sync with exclude patterns
ssh_sync(
  alias="server",
  localPath="/local/project",
  remotePath="/remote/project",
  direction="upload",
  exclude=["*.log", "node_modules", ".git"]
)

// Download from remote
ssh_sync(
  alias="server",
  localPath="/local/backup",
  remotePath="/remote/data",
  direction="download"
)

// Dry run (preview without actual transfer)
ssh_sync(..., dryRun=true)
```

If rsync is not available on remote or local, it automatically falls back to SFTP.

**Note**: rsync mode uses SSH key/agent authentication and disables strict host key checking (`StrictHostKeyChecking=no`) for convenience. If you require host key verification, use SFTP mode instead.

### Persistent PTY Sessions (top, tmux, etc.)

For interactive commands that continuously refresh or require ongoing interaction:

```
// 1. Start a PTY session with top
ssh_pty_start(alias="server", command="top", rows=24, cols=80)
// Returns: { "ptyId": "pty_1_1234567890" }

// 2. Read current output (polling)
ssh_pty_read(ptyId="pty_1_1234567890")
// Returns: { "data": "top - 10:30:15 up 5 days...", "active": true }

// 3. Send commands (e.g., quit top)
ssh_pty_write(ptyId="pty_1_1234567890", data="q")

// 4. Close when done
ssh_pty_close(ptyId="pty_1_1234567890")
```

tmux session example:

```
// Start tmux
ssh_pty_start(alias="server", command="tmux new -s work")

// Send commands in tmux
ssh_pty_write(ptyId="pty_1_xxx", data="ls -la\r")

// Read output
ssh_pty_read(ptyId="pty_1_xxx")

// Detach tmux (Ctrl+B, D)
ssh_pty_write(ptyId="pty_1_xxx", data="\x02d")
```

Common control sequences:
- Enter: `\r` or `\n`
- Ctrl+C: `\x03`
- Ctrl+D: `\x04`
- Ctrl+Z: `\x1a`
- Arrow Up: `\x1b[A`
- Arrow Down: `\x1b[B`

### Port Forwarding

Access remote internal services or expose local services:

```
// Local forward: access remote MySQL (10.0.0.5:3306) via localhost:13306
ssh_forward_local(alias="server", localPort=13306, remoteHost="10.0.0.5", remotePort=3306)

// Remote forward: expose local dev server (3000) to remote port 8080
ssh_forward_remote(alias="server", remotePort=8080, localHost="127.0.0.1", localPort=3000)

// List all forwards
ssh_forward_list()

// Close forward
ssh_forward_close(forwardId="fwd_1_xxx")
```

## Configuration Options

### Connection Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | string | *required* | Server address |
| `user` | string | *required* | Username |
| `password` | string | - | Password authentication |
| `keyPath` | string | - | Path to SSH private key |
| `port` | number | 22 | SSH port |
| `alias` | string | auto-generated | Connection alias for reference |
| `env` | object | - | Environment variables |
| `keepaliveInterval` | number | 30000 | Keepalive interval in ms |

### Exec Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `timeout` | number | 30000 | Command timeout in ms |
| `cwd` | string | - | Working directory |
| `env` | object | - | Additional environment variables |
| `pty` | boolean | false | Enable PTY mode for interactive commands |

## Project Structure

```
mcp-ssh/
├── src/
│   ├── index.ts           # MCP Server entry, tool definitions
│   ├── session-manager.ts # Connection pool, exec, keepalive
│   ├── file-ops.ts        # SFTP file operations
│   └── types.ts           # TypeScript type definitions
├── dist/                  # Compiled JavaScript
├── package.json
├── tsconfig.json
└── README.md
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Related Projects

- [Model Context Protocol](https://modelcontextprotocol.io/) - The MCP specification
- [MCP Servers](https://github.com/modelcontextprotocol/servers) - Official MCP server implementations
