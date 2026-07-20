# MCP-SSH

English | [中文](README_zh.md)

SSH MCP Server for AI assistants (Claude, Cursor, Windsurf, etc.)

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.19-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io/)

![Linux](https://img.shields.io/badge/Linux-tested-success)
![macOS](https://img.shields.io/badge/macOS-untested-yellow)
![Windows](https://img.shields.io/badge/Windows-untested-yellow)

## Features

- **Multiple Authentication**: Password, SSH key
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

| Client                    | Status |
|---------------------------|--------|
| Claude Code               | ✅      |
| Claude Desktop            | ✅      |
| Cursor                    | ✅      |
| Windsurf                  | ✅      |
| Continue.dev              | ✅      |
| Cline                     | ✅      |
| Any MCP-compatible client | ✅      |

## Installation

Requires Node.js 20.19 or newer.

### npm (Recommended)

```bash
npm install -g @pyrokine/mcp-ssh
claude mcp add ssh -- mcp-ssh
```

### From Source

```bash
git clone https://github.com/Pyrokine/claude-tools.git
cd claude-tools/mcp-ssh
npm install
npm run build
claude mcp add ssh -- node "$PWD/dist/index.js"
```

## Configuration

### Claude Code

```bash
# npm installation
claude mcp add ssh -- mcp-ssh

# source build
claude mcp add ssh -- node /path/to/mcp-ssh/dist/index.js
```

### Claude Desktop / Other Clients

Add to your MCP settings (e.g., `~/.claude/settings.json` or client-specific config):

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

## Available Tools (35 tools)

### Connection Management

| Tool                | Description                                       |
|---------------------|---------------------------------------------------|
| `ssh_connect`       | Establish SSH connection (supports ~/.ssh/config) |
| `ssh_disconnect`    | Close connection                                  |
| `ssh_list_sessions` | List brief sessions; optional detail/field selection |
| `ssh_reconnect`     | Reconnect a disconnected session                  |
| `ssh_config_list`   | List hosts from ~/.ssh/config                     |

`ssh_list_sessions()` returns only `alias`, canonical `identity`, `runAs`, `connected`, and `lastUsedAt`. Use `detail=true` for connection details or `fields=[...]` to select fields. Neither mode returns `keyPath`.

`ssh_reconnect` invalidates operations, PTYs, forwards, and cached transfer capability bound to the old client before the replacement connection is published. Automatic reconnect timers are bound to the session and client that scheduled them, so an old timer cannot disconnect a newer session with the same alias. A delayed `close` from the old client cannot leave stale resources attached to the alias. If a target connection is cancelled while a jump-host `forwardOut` is pending, a channel returned by the delayed callback is destroyed before the connection attempt fails.

### Command Execution

| Tool                | Description                                   |
|---------------------|-----------------------------------------------|
| `ssh_exec`          | Execute command (supports PTY mode)           |
| `ssh_exec_as_user`  | Execute as different user (via `su`)          |
| `ssh_exec_sudo`     | Execute with `sudo`                           |
| `ssh_exec_batch`    | Execute multiple commands sequentially        |
| `ssh_exec_parallel` | Execute command on multiple hosts in parallel |
| `ssh_quick_exec`    | One-shot: connect, execute, disconnect        |
| `ssh_exec_script`   | Upload and run a temporary remote script      |

### Tracked operations

| Tool                   | Description                                      |
|------------------------|--------------------------------------------------|
| `ssh_operation_start`  | Start a tracked long-running remote command      |
| `ssh_operation_status` | Read status, PID, exit code, and output counters |
| `ssh_operation_read`   | Read bounded stdout and stderr by byte offset     |
| `ssh_operation_cancel` | Verify the operation marker, then send TERM       |
| `ssh_operation_list`   | List unexpired operations, optionally by alias    |

### File Operations

| Tool             | Description                              |
|------------------|------------------------------------------|
| `ssh_upload`     | Upload local file to remote server       |
| `ssh_download`   | Download remote file to local            |
| `ssh_read_file`  | Read remote file content                 |
| `ssh_write_file` | Write content to remote file             |
| `ssh_list_dir`   | List remote directory contents           |
| `ssh_file_info`  | Get file/directory metadata              |
| `ssh_mkdir`      | Create remote directory                  |
| `ssh_sync`       | Smart sync with rsync (fallback to SFTP) |

### PTY Sessions (Persistent Interactive Terminal)

| Tool             | Description                                                          |
|------------------|----------------------------------------------------------------------|
| `ssh_pty_start`  | Start persistent PTY session (for top, htop, tmux, etc.)             |
| `ssh_pty_write`  | Send data to PTY (keystrokes, commands)                              |
| `ssh_pty_read`   | Read PTY output (screen mode: current screen, raw mode: ANSI stream) |
| `ssh_pty_resize` | Resize PTY window                                                    |
| `ssh_pty_close`  | Close PTY session                                                    |
| `ssh_pty_list`   | List all PTY sessions                                                |

### Port Forwarding

| Tool                 | Description                                            |
|----------------------|--------------------------------------------------------|
| `ssh_forward_local`  | Local port forwarding (ssh -L): access remote services |
| `ssh_forward_remote` | Remote port forwarding (ssh -R): expose local services |
| `ssh_forward_close`  | Close port forwarding                                  |
| `ssh_forward_list`   | List all port forwards                                 |

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

Each host result keeps the same execution metadata as `ssh_exec`, including `failureKind`, `effectiveUser`, `cwd`,
truncation fields, and diagnostic suggestions. `ssh_exec_parallel` limits one call to 32 aliases, runs up to 4 hosts at
a time by default (configurable with `maxConcurrency`, max 8), and accepts `maxOutputSize` to cap each host result.

### Basic: Connect and Execute

```
ssh_connect(host="<server-host>", user="root", keyPath="/home/.ssh/id_rsa", alias="myserver")
ssh_exec(alias="myserver", command="ls -la /home")
ssh_disconnect(alias="myserver")
```

### Connection Templates and runAs

Templates can be provided through `SSH_MCP_TEMPLATES` or `~/.mcp-ssh/templates.json`. Explicit tool arguments override
template values.

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

`ssh_connect` returns `identity`, `loginUser`, `runAs`, `reused`, `defaultEnvKeys`, `envKeys`, and `reusableSessions`
from the session that was actually published. Concurrent calls reuse an alias only when the complete session configuration
matches, including endpoint, authentication, `runAs`, environment, jump host, keepalive, and timeout settings. A conflicting
pending or active connection is rejected even when its `user@host:port` identity is unchanged. Missing templates include
available template names when they can be loaded. Missing `configHost` returns SSH config candidates and suggests
`ssh_config_list`.

### Jump Host (Bastion)

Connect to internal server via jump host:

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

### Switch User Execution (su)

Perfect for scenarios where you SSH as root but need to run commands as another user:

```
1. ssh_connect(host="<server-host>", user="root", keyPath="/home/.ssh/id_rsa", alias="server")
2. ssh_exec_as_user(alias="server", command="whoami", targetUser="appuser")
   // Output: appuser
```

By default, shell profile is loaded to ensure environment variables are available (since `su -c` creates a
non-interactive shell which doesn't execute rc files). Supports bash (`.bashrc`), zsh (`.zshrc`), and other shells (
`.profile`). Disable with `loadProfile=false` if not needed.

`ssh_exec` and `ssh_exec_as_user` return execution metadata: `loginUser`, `effectiveUser`, `identity`, `cwd`,
`resolvedCwd`, `shell`, `profileLoaded`, `envInjectedKeys`, `failureKind`, `stdoutBytes`, `stderrBytes`, and truncation
hints. Large output returns `stdoutHead`, `stdoutTail`, `stderrHead`, `stderrTail`, and `recommendedReadCommand`.
Timeout errors include the same head/tail fields from output produced before the timeout. Commands with destructive,
process-control, service-control, credential-bearing, unbounded `find`, recursive `grep`, long pipelines, background
tasks, direct `su - user -c`, or long-running patterns return a `commandRisk` block with `categories` and `signals`.

### Tracked long-running commands

Use tracked operations when a command must continue beyond one synchronous tool call:

```
ssh_operation_start(alias="server", command="long-running-job", maxOutputBytes=1048576, startTimeoutMs=30000)
ssh_operation_status(operationId="op_xxx")
ssh_operation_read(operationId="op_xxx", stdoutOffset=0, stderrOffset=0, maxBytes=65536)
ssh_operation_cancel(operationId="op_xxx")
```

The start call returns an unpredictable `operationId`. The server creates the record before requesting the SSH channel, keeps bounded stdout and stderr buffers, records the remote PID after verifying a per-operation marker, and expires terminal records after `retentionMs`. `startTimeoutMs` bounds channel setup, defaults to 30 seconds, and accepts up to 10 minutes. A timeout returns the `operationId` in error details, keeps a queryable `unknown` record, and blocks another pending start on that alias until the original channel request settles or the alias is disconnected. `maxOutputBytes` defaults to 1 MiB and accepts up to 8 MiB. `retentionMs` defaults to 1 hour and accepts up to 24 hours. `ssh_operation_read.maxBytes` defaults to 64 KiB and accepts up to 1 MiB. Cancellation is refused until the marker and PID are verified. Stderr written by a shell profile before the marker is retained as operation output, including an unterminated preamble immediately followed by the marker. A line that uses the operation marker prefix with the wrong token or invalid process metadata ends the
record as `failed`, closes its channel, and starts the configured retention period. Delayed exec, sudo, SFTP, PTY-start,
and operation-start callbacks from a disconnected or replaced SSH session are rejected and their channels are destroyed.
A sudo callback that arrives after timeout is also closed before any password is written. Operation listeners are installed
inside the SSH exec callback before it returns, so a short command that emits its marker and closes immediately still enters
a terminal state with `finishedAt` and `expiresAt` set. If the SSH session disconnects while a tracked command is active,
its status becomes `unknown`; the server does not claim that the remote process stopped. `ssh_exec` keeps its existing
synchronous timeout behavior.

### Interactive Commands (PTY mode)

For commands that need a terminal:

```
ssh_exec(alias="server", command="top -b -n 1", pty=true)
```

### Temporary Script Execution and Log Query Recipe

```
ssh_exec_script(alias="server", script="set -e\nwhoami\npwd", cwd="/tmp", runAs="appuser")
```

Use `ssh_exec_script` for log discovery and filtering, then use `ssh_read_file` to read large result files in chunks:

```
ssh_exec_script(
  alias="server",
  script="find /var/log/app -maxdepth 1 -type f -printf '%T@ %p\\n' | sort -nr | head -20 > /tmp/mcp-log-files.txt\ngrep -n -I -F 'ERROR' /var/log/app/*.log | head -100 > /tmp/mcp-log-errors.txt",
  timeout=30000
)
ssh_read_file(alias="server", remotePath="/tmp/mcp-log-errors.txt", maxBytes=65536)
```

This keeps log querying in the general command and file tools instead of adding a separate log-specific MCP surface.

### With Environment Variables

```
ssh_connect(
  host="<server-host>",
  user="root",
  keyPath="/home/.ssh/id_rsa",
  env={"LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8"}
)
```

### Quick One-shot Execution

No need to manage connections for single commands:

```
ssh_quick_exec(
  host="<server-host>",
  user="root",
  keyPath="/home/.ssh/id_rsa",
  command="uptime"
)
```

### File Operations

```
// Upload
ssh_upload(alias="server", localPath="/tmp/config.json", remotePath="/etc/app/config.json")
ssh_upload(alias="server", localPath="/tmp/config.json", remotePath="/etc/app/config.json", atomic=true, verifySize=true, verifyMd5=true, verifyMode="0644")
// Directories return UPLOAD_PATH_IS_DIRECTORY. Large files complete with a suggestion and recommended ssh_sync call.

// Download
ssh_download(alias="server", remotePath="/var/log/app.log", localPath="/tmp/app.log")

// Read file content
ssh_read_file(alias="server", remotePath="/etc/hosts")
ssh_read_file(alias="server", remotePath="/var/log/app.log", tail=true, maxBytes=65536)
ssh_read_file(alias="server", remotePath="/var/log/app.log", offset=1048576, maxBytes=65536)
ssh_read_file(alias="server", remotePath="/var/log/app.log", lineRange="120-180")
```

`ssh_upload` returns local path policy diagnostics, remote parent probing, remote target metadata, and optional
verification checks. `atomic=true` writes an unpredictable same-directory temporary path with exclusive SFTP creation,
returns `diagnostics.tempRemotePath`, verifies the temporary file, and renames it only after every requested check passes.
Responses distinguish `finalRemotePath` from the actual verification target: `verifiedRemotePath` identifies the path that
was probed, and atomic verification also returns `verifiedTempRemotePath`. `verification.actual.remotePath` continues to
describe the file that was actually verified, even after that temporary path has been renamed. Interpret the final state
with `targetReplaced` and `targetReplacementStatus`. An existing target is replaced with the OpenSSH
`posix-rename@openssh.com` extension; a new target uses standard SFTP
rename. If the client cannot send the rename request, the response reports `operationStatus="failed"`,
`targetReplaced=false`, and `targetReplacementStatus="not_replaced"`. An error returned after the request was sent cannot
prove whether the server committed it, so the response reports `operationStatus="unknown"`, `targetReplaced=null`, and
`targetReplacementStatus="unknown"`; inspect the target before retrying. Temporary-file cleanup is attempted in both
cases. `verifySize`, `verifyMd5`, `verifyMode`, `verifyOwner`, and `verifyMtime` add explicit transfer checks. Parent and
target probes, recursive directory creation, file hashing, rename, and temporary-file cleanup use SFTP. The standard
upload path works on SFTP-only servers and does not require GNU `stat`, `md5sum`, `sha256sum`, `mkdir`, `mv`, or `rm`
commands. Explicit directory manifest verification still runs remote shell commands.

`ssh_download` writes to a same-directory temporary file and renames it over the requested local path after the SFTP
stream closes and the transferred byte count matches the size reported by SFTP `stat`. A failed, truncated, or aborted
download removes the temporary file and leaves an existing local target unchanged. SFTP directory listings reject empty
names, `.` and `..`, NUL bytes, and path separators before constructing child paths.

Command execution results include `emptyOutputFailure=true` when the remote command exits non-zero without
stdout/stderr, with the effective user, cwd, and a suggested follow-up read command when available.
`ssh_read_file` defaults to 1 MiB and rejects `maxBytes` above 16 MiB before remote transfer. It returns `total_size`,
`read_offset`, `read_bytes`, `remaining_bytes`, `sample_kind`, and `truncated` so callers can distinguish a full read
from a head, tail, byte range, or line range sample.

### Directory sync with rsync or SFTP

Smart sync selects rsync only for a direct connection with a validated key path or usable SSH agent. Password, inline-key, jump-host, and other routes that cannot be passed safely to OpenSSH use SFTP directly:

```
// Sync local directory to remote (upload)
ssh_sync(
  alias="server",
  localPath="/local/project",
  remotePath="/remote/project",
  direction="upload"
)
// Returns selectedTransport, decisionReason, stage durations, and transfer counters

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

// Upload one file and verify remote owner/mode after transfer
ssh_sync(..., direction="upload", verifyOwner="appuser", verifyMode="0644")

// Verify a directory with bounded manifests
ssh_sync(
  ...,
  verify={count: true, sha256: true, owner: true, mode: true, staleFiles: true}
)

// Verify that entries present before --delete were removed
ssh_sync(..., delete=true, verify={deletions: true})
```

A directory source always means “copy the source directory contents into the destination root” in both rsync and SFTP
mode. Directory sources reject `recursive=false`. Relative exclude patterns are evaluated against the path below the
source root; patterns without `/` match each basename.

Directory verification builds bounded local and remote manifests. It can compare entry count, a SHA-256 root manifest,
owner, mode, stale entries, and deletion results. `verify.deletions=true` requires `delete=true`; it records the destination
before transfer and only checks whether those deletion candidates disappeared. `staleFiles` independently checks every
extra destination entry. The response contains summaries and at most 20 mismatch samples, not the full manifest. The
default limits are 10,000 entries, 256 MiB per hashed file, and 1 GiB total hashed bytes. Set `verify.maxEntries`,
`verify.maxFileBytes`, and `verify.maxTotalBytes` to raise them, up to 50,000 entries, 4 GiB per file, and 16 GiB total.
Symlinks or unsupported filesystem entries that were skipped make verification explicitly `skipped` instead of
reporting a partial match.

If verification is requested, a mismatch, skipped check, or verification error sets top-level `success=false` while
`transferSuccess` still reports whether transfer completed. `verificationStatus`, `verificationSuccess`, and
`failedChecks` describe the verification outcome. SFTP single-file transfers also include local and remote size,
mode or permissions, mtime, owner/group, and a streamed SFTP SHA-256 comparison. `verifyOwner` and `verifyMode` apply
to upload single-file sync; use `verify.owner` and `verify.mode` for directory manifests.

Rsync is selected only for a direct connection with a validated key path or usable SSH agent. Password, inline-key, and
jump-host sessions use SFTP because their route or credentials cannot be passed safely to a separate OpenSSH process.
`preflightTimeout`, `connectTimeout`, and `operationTimeout` independently bound capability probing, rsync SSH setup, and
the overall transfer; their defaults are 10 seconds, 30 seconds, and 10 minutes. When the session is not eligible for
rsync, the response returns `rsyncProbe.status="skipped"` with the route decision reason instead of omitting the probe.
Rsync mode sets
`StrictHostKeyChecking=accept-new`. SFTP does not support `delete=true`; such a request fails explicitly instead of
claiming deletion. If you require strict host key verification and management, use SFTP mode.

### Persistent PTY Sessions (top, tmux, etc.)

For interactive commands that continuously refresh or require ongoing interaction:

```
// 1. Start a PTY session with top
ssh_pty_start(alias="server", command="top", rows=24, cols=80)
// Returns: { "ptyId": "pty_1_1234567890" }

// 2. Read current output (polling)
ssh_pty_read(ptyId="pty_1_1234567890")
// Returns: { "data": "top - 10:30:15 up 5 days...", "active": true, "unreadRawBytes": 123, "foregroundProcess": "top" }

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

`ssh_pty_read` and `ssh_pty_list` expose `lastInputAt`, `lastOutputAt`, `lastReadAt`, `unreadRawBytes`,
`rawBufferLimit`, and `foregroundProcess` so long-running sessions can be monitored without reading the full raw stream.
When a finite command exits naturally, its final screen remains readable with `active=false` until explicit close or the
closed-session retention expires (5 minutes by default, configurable with `SSH_MCP_PTY_CLOSED_RETENTION_MS`).

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
// Local forward: access remote MySQL (<service-host>:3306) via localhost:13306
ssh_forward_local(alias="server", localPort=13306, remoteHost="<service-host>", remotePort=3306)

// Remote forward: expose local dev server (3000) to remote port 8080
ssh_forward_remote(alias="server", remotePort=8080, localHost="127.0.0.1", localPort=3000)

// Ask the SSH server to allocate a remote port; use remotePort from the result
ssh_forward_remote(alias="server", remotePort=0, localHost="127.0.0.1", localPort=3000)

// List all forwards
ssh_forward_list()

// Close after the listener is released
ssh_forward_close(forwardId="fwd_1_xxx", mode="graceful", timeoutMs=5000)

// Destroy active connections, then release the listener
ssh_forward_close(forwardId="fwd_1_xxx", mode="force", timeoutMs=5000)
```

A successful close means the local `server.close` or remote `unforwardIn` callback completed. The result includes
`listenerReleased`, `remoteUnforwarded`, `activeConnections`, `closeMode`, and `retryable`. Timeout or callback failure
keeps the forward in `ssh_forward_list`, so the same `forwardId` can be retried. After a successful local close, the port
can be rebound immediately. `remotePort=0` returns the actual allocated port and uses that port for incoming connection
routing and `unforwardIn`.

Forward creation is tracked before `listen` or `forwardIn` completes. Disconnect cancels pending creation, closes a local
listener if it appears later, and removes a remotely allocated listener returned by a delayed callback. A forward stops
accepting new local or remote connections as soon as close begins. Delayed `forwardOut`, close, and unforward callbacks
check the same lifecycle record before changing state, so a closed forward cannot reappear in `ssh_forward_list`. Each local
connection tracks both the local socket and the SSH `forwardOut` channel. Closing or failing either side destroys the other, and force close returns only after both sides are destroyed and `activeConnections` reaches zero. Pending `forwardOut` requests are limited to 32 per alias, and a close waits for every callback. If the SSH server never answers a channel-open request, close times out, keeps the forward retryable, and rejects another local forward on the same alias so pending ssh2 channels cannot accumulate. Disconnect the alias to release a channel request that never completes.

## Configuration Options

### Connection Options

| Option              | Type   | Default        | Description                    |
|---------------------|--------|----------------|--------------------------------|
| `host`              | string | *required*     | Server address                 |
| `user`              | string | *required*     | Username                       |
| `password`          | string | -              | Password authentication        |
| `keyPath`           | string | -              | Path to SSH private key        |
| `port`              | number | 22             | SSH port                       |
| `alias`             | string | auto-generated | Connection alias for reference |
| `template`          | string | -              | Template name                  |
| `env`               | object | -              | Environment variables          |
| `defaultEnv`        | object | -              | Default env for this session   |
| `runAs`             | string | -              | Default execution user         |
| `keepaliveInterval` | number | 30000          | Keepalive interval in ms       |
| `readyTimeout`      | number | 30000          | Wait for SSH ready in ms, max 600000 |
| `jumpHost.readyTimeout` | number | top-level value | Jump-host ready timeout, max 600000 |

Connection failures return `failureStage`, `retryable`, and a bounded suggestion. `failureStage` is one of `preflight`, `authentication`, `ready_timeout`, `transport_or_handshake`, or `unknown`; multi-hop failures may also include `connectionStep` as `key_read`, `jump_connect`, `jump_forward`, or `target_connect`.

### Exec Options

| Option          | Type    | Default       | Description                                |
|-----------------|---------|---------------|--------------------------------------------|
| `timeout`       | number  | 30000         | Command timeout in ms                      |
| `cwd`           | string  | -             | Working directory                          |
| `env`           | object  | -             | Additional environment variables           |
| `pty`           | boolean | false         | Enable PTY mode for interactive commands   |
| `maxOutputSize` | number  | 10 MB chars   | Output truncation limit                    |
| `runAs`         | string  | session runAs | Per-command execution user                 |
| `useLoginUser`  | boolean | false         | Skip session-level runAs                   |
| `loadProfile`   | boolean | true          | Load target user's shell profile for runAs |

When `cwd` or `env` is set, the generated shell command chains `cd` and each validated `export` with `&&`, then runs the
entire requested command as one escaped `eval` argument in the active login shell. A failed directory change or export
prevents every part of the requested command from running, including text after `;`, newlines, or `||`, while Bash/Zsh
syntax keeps the same interpreter semantics as a direct SSH command.

## Security

### Path Whitelist for Key/Config Files

`keyPath` (private key) and `configPath` (SSH config) must reside under one of the following directories:

- `~/.ssh/` — user SSH directory
- `/etc/ssh/` — system-wide SSH directory

To allow additional directories, set the `SSH_MCP_ALLOWED_KEY_DIRS` environment variable, separated by `:` on
Linux/macOS or `;` on Windows:

```bash
export SSH_MCP_ALLOWED_KEY_DIRS=/opt/secrets:/var/lib/keys
```

Files outside the whitelist are rejected with `Invalid private key path: ...` or `Invalid config path: ...`.

### Optional File-Ops Path Whitelist

`ssh_upload`, `ssh_download`, `ssh_sync` accept arbitrary local paths by default. To restrict them to specific
directories (recommended for shared environments), set `SSH_MCP_FILE_OPS_ALLOW_DIRS` (paths separated by Node's
`path.delimiter` — `:` on POSIX, `;` on Windows):

```bash
export SSH_MCP_FILE_OPS_ALLOW_DIRS=/tmp:/home/me/work
```

When set, any local path outside the whitelist is rejected and symlinks are resolved via `realpath`.
`ssh_sync(direction="upload", followSymlinks=true)` is rejected before transport selection while the whitelist is active.
A symlink can change between validation and transfer, and rsync cannot bind the validated target to the later `-L` read.
Keep `followSymlinks=false`, or copy regular files into an allowed directory before syncing.

### File Size Limits

- Private key files: max 64 KB
- SSH config files: max 1 MB

Files exceeding these limits are rejected before being read.

### Symlink Handling in `ssh_sync`

`ssh_sync(direction="upload", ...)` handles local symlinks differently depending on the underlying transport:

| `followSymlinks`  | SFTP path                                                  | rsync path                                                                  |
|-------------------|------------------------------------------------------------|-----------------------------------------------------------------------------|
| `false` (default) | Skipped, returned in `skippedSymlinks`, printed as warning | Skipped via `--no-links`                                                     |
| `true`            | Followed: link target contents are uploaded                | Followed via rsync `-L` / `--copy-links`: link target contents are uploaded |

Both transports skip device and special filesystem entries. SFTP returns `skippedUnsupported` and up to 10 sample paths;
rsync uses `--no-devices --no-specials`. Directory verification also reports skipped symlinks and unsupported entries and
does not treat an incomplete manifest as a match.

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
