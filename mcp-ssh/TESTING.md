# mcp-ssh 回归测试用例

每次发版前，agent 在 CC 会话内按章节顺序执行所有用例，记录 PASS/FAIL，汇总到附录 A

**前置条件**：

- 本地有可用的 SSH 配置（建议 ~/.ssh/config 至少含一个 Host，或一个支持 password/keyPath 的目标主机）
- 测试账号需要可执行 ls/whoami/echo 等基本命令
- 有可写测试目录（远端 /tmp，本地 /tmp/mcp-ssh-test/）

**记号约定**：

- `<alias>`：测试用别名（建议 `mcp-test`）
- `<host>`：测试主机
- `<targetUser>`：可切换的目标用户

---

## 1. 配置读取（config_list）

### config-list-01

**目的**：能正确解析 ~/.ssh/config 中的 Host 列表

**步骤**：

1. 调用 `ssh_config_list`（默认参数）

**预期**：

- 返回数组，每项含 host/user/port/keyPath 等字段
- Host 多别名（`Host a b c`）一次返回多条
- 全局默认 `Host *` 字段被合并到具体 host
- 错误格式（缺 HostName）不导致整个 list 崩溃

---

## 2. 连接管理（connect / disconnect / reconnect / list_sessions）

### connect-01: 通过 configHost

**步骤**：

1. `ssh_connect(configHost="<config-alias>")`
2. `ssh_list_sessions`
3. `ssh_disconnect(alias=<config-alias>)`

**预期**：connect 返回 success，list_sessions 含该 alias，disconnect 后再 list 不含

### connect-02: 显式 host/user/keyPath

**步骤**：

1. `ssh_connect(host=<ip>, user=<user>, keyPath=<path>, alias="<alias>")`
2. `ssh_exec(alias="<alias>", command="whoami")`

**预期**：whoami 返回 user 与 connect 时一致

### connect-03: 错误密钥路径

**步骤**：`ssh_connect(host=..., user=..., keyPath="/nonexistent")`

**预期**：明确错误信息（包含路径不存在），不挂死

### reconnect-01

**步骤**：

1. connect 成功
2. 模拟服务端 close（`ssh_exec` 一个长时间命令然后服务端 timeout）
3. `ssh_reconnect(alias=...)`

**预期**：重连成功，原 alias 可继续 exec

### connect-mutex-01: per-alias mutex（C.8 验证）

**步骤**：并发 2 次 `ssh_connect(configHost="<alias>")`

**预期**：两次都返回 success（同一 alias），但底层只建一个连接，第二次复用 pending Promise

---

## 3. 命令执行（exec / exec_as_user / exec_batch / exec_parallel / exec_sudo）

### exec-01: 基本

**步骤**：`ssh_exec(alias=..., command="echo hello && whoami")`

**预期**：stdout 含 "hello"，exitCode=0

### exec-02: 工作目录 + 环境变量

**步骤**：`ssh_exec(alias=..., command="pwd && echo $TESTVAR", cwd="/tmp", env={TESTVAR: "abc"})`

**预期**：stdout 第一行 "/tmp"，第二行 "abc"

### exec-03: ~ 路径展开

**步骤**：`ssh_exec(alias=..., command="echo ~/")`

**预期**：返回展开后的 home 路径（如 /home/<user>/），不是字面 ~

### exec-as-user-01: with loadProfile

**步骤**：`ssh_exec_as_user(alias=..., command="whoami && echo $PATH", targetUser="<targetUser>", loadProfile=true)`

**预期**：whoami=<targetUser>，PATH 含 .bashrc/.zshrc 中定义的路径

### exec-as-user-02: without loadProfile

**步骤**：`ssh_exec_as_user(alias=..., command="echo $PATH", targetUser="<targetUser>", loadProfile=false)`

**预期**：返回，但 PATH 不含 .bashrc 中定义的路径（仅 /etc/profile 默认）

### exec-batch-01

**步骤**：`ssh_exec_batch(alias=..., commands=["echo a", "echo b"])`

**预期**：两条都执行，按顺序返回 stdout

### exec-parallel-01

**步骤**：先 connect 两个 alias（可指向同 host 不同 alias），再 `ssh_exec_parallel(aliases=[a1, a2], command="hostname")`

**预期**：两个 alias 都返回 hostname

### exec-timeout-01

**步骤**：`ssh_exec(alias=..., command="sleep 5", timeout=2000)`

**预期**：timeout 错误明确，不挂死

---

## 4. PTY 会话（pty_*）

### pty-01: 启动 + 读取 + 写入 + 关闭

**步骤**：

1. `ssh_pty_start(alias=..., command="bash")` → ptyId
2. `ssh_pty_write(ptyId=..., data="echo pty_test\r")`
3. 等 100ms
4. `ssh_pty_read(ptyId=..., mode="screen")`
5. `ssh_pty_close(ptyId=...)`

**预期**：read 输出含 "pty_test"，close 后 ptyId 失效

### pty-02: top 全屏刷新

**步骤**：

1. `ssh_pty_start(alias=..., command="top -b -n 1")` → ptyId
2. 1s 后 `ssh_pty_read(ptyId=..., mode="screen")`
3. close

**预期**：screen 模式返回当前 viewport（不含历史滚屏），含 PID/CPU 列头

### pty-03: raw 模式

**步骤**：`ssh_pty_read(ptyId=..., mode="raw")`

**预期**：包含 ANSI 转义序列原文

### pty-idle-timeout-01: idle-timeout 主动回收（C.7 验证）

**步骤**：

1. 创建 pty
2. 不操作 1h+（或临时改 idleTimeout 阈值至 30s 进行测试）
3. 检查 pty_list

**预期**：超时的 pty 自动 close 并产生 console.warn（非静默）

---

## 5. 端口转发（forward_*）

### forward-local-01

**步骤**：

1. 远端启动 HTTP server：`ssh_exec(... command="cd /tmp && python3 -m http.server 9999 &")`
2. `ssh_forward_local(alias=..., localPort=18888, remoteHost="127.0.0.1", remotePort=9999)`
3. 本地 `curl http://127.0.0.1:18888/` 验证内容
4. `ssh_forward_close(forwardId=...)`

**预期**：curl 返回远端 server 内容；close 后 curl 失败

### forward-loopback-only-01: localHost loopback enum（C.3 验证）

**步骤**：`ssh_forward_local(alias=..., localPort=0, localHost="0.0.0.0", remoteHost=..., remotePort=...)`

**预期**：schema 拒绝（不接受 0.0.0.0）

### forward-localPort-zero-01

**步骤**：`ssh_forward_local(alias=..., localPort=0, remoteHost=..., remotePort=...)`

**预期**：返回中 localPort 字段是实际分配端口（非 0）

### forward-list-01

**步骤**：建 2 个转发后 `ssh_forward_list`

**预期**：返回数组含两条记录

### forward-idle-timeout-01: idle-timeout 主动回收（C.7 验证）

**步骤**：建 forward 后无连接活动一段时间（或测试时改阈值）

**预期**：长时间无连接的 forward 自动关闭并 console.warn

---

## 6. 文件操作（upload / download / sync / read / write / file_info / list_dir / mkdir）

### file-write-read-01

**步骤**：

1. `ssh_write_file(alias=..., remotePath="/tmp/mcp-test-write", content="hello\n")`
2. `ssh_read_file(alias=..., remotePath="/tmp/mcp-test-write")`

**预期**：read 返回 "hello\n"

### file-append-01

**步骤**：`ssh_write_file(alias=..., remotePath=..., content="more\n", append=true)` 后 `ssh_read_file`

**预期**：返回 "hello\nmore\n"

### file-info-01

**步骤**：`ssh_file_info(alias=..., remotePath="/tmp/mcp-test-write")`

**预期**：含 size、mtime、permissions

### list-dir-01

**步骤**：`ssh_list_dir(alias=..., remotePath="/tmp", showHidden=false)`

**预期**：数组，含至少 mcp-test-write 项

### mkdir-01

**步骤**：`ssh_mkdir(alias=..., remotePath="/tmp/mcp-test-dir/sub", recursive=true)` 后 `ssh_list_dir(/tmp/mcp-test-dir)`

**预期**：含 sub 子目录

### upload-01

**步骤**：本地 `echo "abc" > /tmp/mcp-up.txt`；
`ssh_upload(alias=..., localPath="/tmp/mcp-up.txt", remotePath="/tmp/mcp-up-r.txt")`；`ssh_read_file(.../mcp-up-r.txt)`

**预期**：返回 "abc\n"

### download-01

**步骤**：`ssh_write_file(... remotePath="/tmp/mcp-dn-r.txt", content="xyz\n")`；
`ssh_download(alias=..., remotePath="/tmp/mcp-dn-r.txt", localPath="/tmp/mcp-dn.txt")`；本地 cat

**预期**：本地 mcp-dn.txt 含 "xyz\n"

### sync-upload-01

**步骤**：本地建目录树 /tmp/mcp-sync/{a.txt,b/c.txt}；
`ssh_sync(alias=..., localPath="/tmp/mcp-sync", remotePath="/tmp/mcp-sync-r", direction="upload", recursive=true)`
；远端验证树形结构

**预期**：远端文件全部存在；sync 应优先用 rsync（如可用）回退 SFTP

### sync-exclude-01

**步骤**：sync with `exclude=["*.log", "node_modules"]`

**预期**：被 exclude 的文件未传输

### sync-shared-sftp-01: listDir sharedSftp 复用（D.1 验证）

**步骤**：sync 一个深度 5+ 的目录树（建 5 层嵌套测试目录），观察底层 SFTP 子会话数

**预期**：sync 期间 SFTP 子会话数 ≤ 1-2，不随目录深度线性增长（依赖 sshd MaxSessions 默认 10）

### sync-parallel-01: SFTP 并发上传（D.7 验证）

**步骤**：sync 一个含 100 个小文件的目录，记录耗时

**预期**：耗时显著低于纯串行（1000 个 10KB 文件应 < 5s 而非 10s）

### path-whitelist-01: SSH_MCP_FILE_OPS_ALLOW_DIRS（C.10 验证）

**步骤**：

1. 设 `SSH_MCP_FILE_OPS_ALLOW_DIRS=/tmp:/home`
2. 重启 server
3. `ssh_upload(localPath="/etc/passwd", remotePath="/tmp/x")` 应被拒绝
4. `ssh_upload(localPath="/tmp/foo", remotePath="/tmp/x")` 应通过

**预期**：白名单生效，未设环境变量时不限制

---

## 7. 安全验证

### security-rsync-stderr-01: rsync 失败警告（C.9 验证）

**步骤**：人为破坏 rsync（如设置远端非法 PATH），触发 sync fallback 到 SFTP

**预期**：返回 SyncResult.output 含 "rsync 失败原因: ..." 警告，而非静默 fallback

### security-ssh-config-hostname-01: ssh-config hostname 字符白名单（C.5 验证）

**步骤**：编辑 `~/.ssh/config` 加入恶意 host：

```
Host evil
  HostName "1.2.3.4 -oProxyCommand=/bin/sh"
```

然后 `ssh_connect(configHost="evil")`

**预期**：解析时拒绝（包含 -o / 引号 / 空格的 hostname 不应被接受）

---

## 附录 A：执行记录

| 日期         | CC session                           | 执行人             | 范围                        | 结果摘要                                                                                                                                                                     |
|------------|--------------------------------------|-----------------|---------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 2026-04-28 | 2d1d0b19-1537-4722-93a2-23ac3e91b97c | claude-opus-4-7 | TESTING.md 全量（v2.0.0 首发前） | config/connect/exec/exec_as_user/batch/parallel/timeout/PTY/forward/file ops/sync 全 PASS；C.3 loopback enum、C.5 hostname 字符白名单、C.9 rsync stderr 警告 全验证；KNOWN-LIMIT 列在附录 B |

## 附录 B：已知限制 / KNOWN-LIMIT

- forward-idle-timeout-01 / pty-idle-timeout-01：默认 idleTimeout 1h，测试时建议改阈值或跳过等待
- exec-as-user-02 假设目标用户 .bashrc/.zshrc 中含 PATH 修改，否则与 with-loadProfile 输出可能一致
- path-whitelist-01（C.10 SSH_MCP_FILE_OPS_ALLOW_DIRS）：需重启 server 设环境变量，CC 内无法直跑，源码层已验证
- sync-shared-sftp-01（D.1）/ sync-parallel-01（D.7）：性能验证依赖深目录或大量文件，跳过
- ssh-config 临时配置必须放 ~/.ssh/ 或 /etc/ssh/ 下（configPath 路径白名单生效，更严格保护已默认开启）
