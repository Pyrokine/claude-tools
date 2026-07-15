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

**步骤**：`ssh_connect(host=..., user=..., keyPath="~/.ssh/mcp-nonexistent-key")`

**预期**：白名单内不存在的路径返回明确的 `ENOENT`/`no such file` 错误，不挂死，错误中的 `connectionStep="key_read"`；白名单外路径单独返回安全校验错误，不要求回显原始路径

### connect-ready-timeout-01

**步骤**：连接一个可建立 TCP 但不完成 SSH ready 的受控目标，设置 `readyTimeout=1000`

**预期**：在有界时间内失败，返回 `failureStage="ready_timeout"`、`connectionStep="target_connect"` 和提高 `readyTimeout` 的 suggestion；jumpHost 未单独设置 `readyTimeout` 时继承顶层值

### reconnect-01

**步骤**：

1. connect 成功
2. 模拟服务端 close（`ssh_exec` 一个长时间命令然后服务端 timeout）
3. `ssh_reconnect(alias=...)`

**预期**：重连成功，原 alias 可继续 exec

### connect-mutex-01: per-alias mutex（C.8 验证）

**步骤**：并发 2 次 `ssh_connect(configHost="<alias>")`

**预期**：两次都返回 success（同一 alias），但底层只建一个连接，第二次复用 pending Promise

### connect-template-01: template + runAs

**步骤**：设置 `SSH_MCP_TEMPLATES`，包含 host/user/port/runAs/defaultEnv；
`ssh_connect(template="<template>", alias="<alias>")`；`ssh_exec(alias="<alias>", command="whoami && echo $TEST_ENV")`

**预期**：whoami 返回 runAs 用户，环境变量来自 defaultEnv；`ssh_exec(..., useLoginUser=true)` 返回登录用户；connect 返回
`identity`、`loginUser`、`runAs`、`reused`、`defaultEnvKeys`；`ssh_list_sessions` 返回 canonical `identity`

### connect-reusable-sessions-01: 同 identity alias 候选

**步骤**：

1. `ssh_connect(host=<host>, user=<user>, keyPath=<path>, alias="mcp-test-a")`
2. `ssh_connect(host=<host>, user=<user>, keyPath=<path>, alias="mcp-test-b")`

**预期**：第二次 connect 返回 `identity`，`reusableSessions` 含 `mcp-test-a`，并给出可直接复用已有 alias 的 suggestion

### connect-alias-conflict-01: alias identity 冲突

**步骤**：

1. `ssh_connect(host=<host-a>, user=<user>, keyPath=<path>, alias="mcp-conflict")`
2. `ssh_connect(host=<host-b>, user=<user>, keyPath=<path>, alias="mcp-conflict")`

**预期**：第二次 connect 被拒绝，错误包含 existing identity、requested identity 和更换 alias 或先 disconnect 的 suggestion

---

## 3. 命令执行（exec / exec_as_user / exec_batch / exec_parallel / exec_sudo）

### exec-01: 基本

**步骤**：`ssh_exec(alias=..., command="echo hello && whoami")`

**预期**：stdout 含 "hello"，exitCode=0；返回 `loginUser`、`effectiveUser`、`identity`、`envInjectedKeys`

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

**预期**：timeout 错误明确，不挂死；返回 `failureKind="timeout"`、`timedOut=true`、
`stdoutHead/stdoutTail/stderrHead/stderrTail`、`stdoutBytes/stderrBytes`、`recommendedReadCommand`；`loadProfile=true` 时
suggestions 含 `loadProfile=false` 或提高 timeout

### exec-max-output-01

**步骤**：`ssh_exec(alias=..., command="yes x | head -1000", maxOutputSize=100)`

**预期**：返回 `stdoutTruncated=true`、`stdoutBytes`、`stderrBytes`、`stdoutHead`、`stdoutTail`、`maxOutputSize` 和
`recommendedReadCommand`

### exec-command-risk-01

**步骤**：分别执行或 dry-run 观察 `ssh_exec` 响应中的风险分类：`find /tmp`、`grep -R secret /tmp`、`sleep 60`、
`tail -f /tmp/x`、`cmd1 | cmd2 | cmd3 | cmd4`、`kill 1`、`systemctl restart x`、`echo secret-marker`、
`su - appuser -c whoami`

**预期**：返回 `commandRisk.categories` 和 `commandRisk.signals`，覆盖
long-running、process-control、service-control、credential-bearing、user-switch；直接 `su - user -c` 给出改用 `runAs` 或
`ssh_exec_as_user` 的 suggestion

### exec-script-01

**步骤**：`ssh_exec_script(alias=..., script="set -e\nwhoami\npwd", cwd="/tmp")`

**预期**：脚本执行成功，默认不返回 remotePath；连接级 `runAs` 或参数 `runAs` 生效时脚本仍保持 700 私有权限并能由目标用户执行；
`keepScript=true` 时返回 remotePath 且远端文件存在

### log-query-recipe-01

**步骤**：写入 `/tmp/mcp-log-test/app.log`，用 `ssh_exec_script` 执行只读脚本，把
`grep -n -I -F "ERROR" /tmp/mcp-log-test/*.log | head -100` 写到 `/tmp/mcp-log-test/errors.txt`，再用
`ssh_read_file(alias=..., remotePath="/tmp/mcp-log-test/errors.txt", maxBytes=65536)` 读取

**预期**：`ssh_exec_script` 成功，`ssh_read_file` 返回内容包含 ERROR 行，并带 `read_offset`、`read_bytes`、`sample_kind`、
`remaining_bytes` 元数据

### operation-lifecycle-01

**步骤**：

1. `ssh_operation_start(alias=..., command="printf start; sleep 30; printf done")`
2. `ssh_operation_status(operationId=...)`
3. `ssh_operation_read(operationId=..., maxBytes=65536)`
4. `ssh_operation_cancel(operationId=...)`
5. 再次读取 status 和 output

**预期**：start 返回不可预测的 `operationId`，状态从 `starting/running` 进入 `cancelled`；status 返回已校验的 PID 和
marker 状态；read 返回字节偏移及有上限的 stdout/stderr；cancel 只在 marker 校验后执行

### operation-utf8-read-01

**步骤**：启动分块输出多字节 UTF-8 字符的 operation，多次调用 `ssh_operation_read`，让 `maxBytes` 落在字符中间，再使用 continuation byte 作为 offset 调用一次

**预期**：正常读取不会返回替换字符，`nextStdoutOffset` 停在完整字符边界；过小 `maxBytes` 或 continuation-byte offset 返回明确 UTF-8 boundary 错误

### operation-disconnect-01

**步骤**：启动 `sleep 60` operation 后调用 `ssh_disconnect(alias=...)`，再查询 operation status

**预期**：状态为 `unknown`，结果明确说明远端进程状态无法确认，不报告任务已经停止

### operation-output-limit-01

**步骤**：启动持续输出命令，设置 `maxOutputBytes=1024`，完成后分块调用 `ssh_operation_read`

**预期**：实际输出计数继续增长，保存输出不超过 1024 字节，返回 truncation 字段；单次 read 受 `maxBytes` 限制

---

## 4. PTY 会话（pty_*）

### pty-01: 启动 + 读取 + 写入 + 关闭

**步骤**：

1. `ssh_pty_start(alias=..., command="bash")` → ptyId
2. `ssh_pty_write(ptyId=..., data="echo pty_test\r")`
3. 等 100ms
4. `ssh_pty_read(ptyId=..., mode="screen")`
5. `ssh_pty_close(ptyId=...)`

**预期**：read 输出含 "pty_test"，返回 `lastInputAt`、`lastOutputAt`、`lastReadAt`、`unreadRawBytes`、`rawBufferLimit`、
`foregroundProcess`，close 后 ptyId 失效

### pty-02: top 全屏刷新

**步骤**：

1. `ssh_pty_start(alias=..., command="top -b -n 1")` → ptyId
2. 1s 后 `ssh_pty_read(ptyId=..., mode="screen")`
3. close

**预期**：命令自然结束后仍可读取最终 screen viewport（不含历史滚屏），含 PID/CPU 列头，返回 `active=false`；显式 close 后 ptyId 失效

### pty-03: raw 模式

**步骤**：`ssh_pty_read(ptyId=..., mode="raw")`

**预期**：包含 ANSI 转义序列原文

### pty-list-observability-01

**步骤**：创建 pty 后调用 `ssh_pty_list`

**预期**：会话项含 `lastInputAt`、`lastOutputAt`、`lastReadAt`、`unreadRawBytes`、`rawBufferLimit`、`foregroundProcess`

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

### forward-close-graceful-01

**步骤**：创建 local forward，记录实际端口，调用
`ssh_forward_close(forwardId=..., mode="graceful", timeoutMs=5000)`，返回后立即在本地 bind 同一端口

**预期**：返回 `success=true`、`listenerReleased=true`、`closeMode="graceful"`，同一端口可立即 bind，forward 已从 list 删除

### forward-close-force-01

**步骤**：创建 local forward 并保持一个活跃连接，先用极短 timeout 执行 graceful close，再用同一 forwardId 执行
`ssh_forward_close(..., mode="force")`

**预期**：graceful timeout 返回 `success=false`、`retryable=true`，forward 仍在 list；force 销毁活跃连接并等待 listener 释放，成功后删除状态

### forward-close-remote-failure-01

**步骤**：创建 remote forward，模拟 `unforwardIn` callback 失败或超时，再调用 list

**预期**：返回 `remoteUnforwarded=false`、`retryable=true`，forward 状态保留，可使用同一 ID 重试；callback 完成后重试成功

### forward-idle-timeout-01: idle-timeout 主动回收（C.7 验证）

**步骤**：建 forward 后无连接活动一段时间（或测试时改阈值）

**预期**：长时间无连接的 forward 自动关闭并 console.warn

---

## 6. 文件操作（upload / download / sync / read / write / file_info / list_dir / mkdir）

### file-write-read-01

**步骤**：

1. `ssh_write_file(alias=..., remotePath="/tmp/mcp-test-write", content="hello\n")`
2. `ssh_read_file(alias=..., remotePath="/tmp/mcp-test-write")`

**预期**：read 返回 "hello\n"，并包含 `total_size`、`read_offset`、`read_bytes`、`remaining_bytes`、`sample_kind`、`truncated`

### file-append-01

**步骤**：`ssh_write_file(alias=..., remotePath=..., content="more\n", append=true)` 后 `ssh_read_file`

**预期**：返回 "hello\nmore\n"

### file-read-range-01

**步骤**：写入 200 行测试文件后分别调用 `ssh_read_file(..., tail=true, maxBytes=64)`、
`ssh_read_file(..., offset=128, maxBytes=64)`、`ssh_read_file(..., lineRange="120-130")`

**预期**：返回内容符合尾部、字节范围和行范围；`sample_kind` 分别为 `tail`、`range`、`line_range`

### file-read-limit-01

**步骤**：`ssh_read_file(alias=..., remotePath="/tmp/mcp-test-write", maxBytes=16777217)`

**预期**：schema 层拒绝请求，不发起远端传输；文档说明默认 1 MiB，最大 16 MiB

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

**预期**：返回 "abc\n"；upload 响应含 `diagnostics.local`、`diagnostics.remoteParent`、`verification.local`、
`verification.remote`

### upload-02-directory-reject

**步骤**：`ssh_upload(alias=..., localPath="/tmp", remotePath="/tmp/mcp-up-dir")`

**预期**：返回 `success=false`、`code="UPLOAD_PATH_IS_DIRECTORY"`，suggestion 指向 `ssh_sync`

### upload-03-large-file-suggestion

**步骤**：上传超过 100MB 的单文件

**预期**：上传成功时返回 `suggestion` 和 `recommendedSync`，提示大文件优先使用 `ssh_sync`

### upload-04-atomic-verify

**步骤**：本地 `echo "abc" > /tmp/mcp-up-verify.txt`；
`ssh_upload(alias=..., localPath="/tmp/mcp-up-verify.txt", remotePath="/tmp/mcp-up-verify-r.txt", atomic=true, verifySize=true, verifyMd5=true, verifyMode="0644")`

**预期**：返回 `atomic=true`；`diagnostics.tempRemotePath` 存在；`verification.checks.size=true`、
`verification.checks.md5=true`，`verification.remote.mode` 可用于判断 mode 校验结果；目标文件内容为 "abc\n"

### download-01

**步骤**：`ssh_write_file(... remotePath="/tmp/mcp-dn-r.txt", content="xyz\n")`；
`ssh_download(alias=..., remotePath="/tmp/mcp-dn-r.txt", localPath="/tmp/mcp-dn.txt")`；本地 cat

**预期**：本地 mcp-dn.txt 含 "xyz\n"

### sync-upload-01

**步骤**：本地建目录树 /tmp/mcp-sync/{a.txt,b/c.txt}；
`ssh_sync(alias=..., localPath="/tmp/mcp-sync", remotePath="/tmp/mcp-sync-r", direction="upload", recursive=true)`
；远端验证树形结构

**预期**：远端文件全部存在；sync 应优先用 rsync（如可用）回退 SFTP；返回 `transport`、`duration`、`dryRun`、`stats`、
`diagnostics.localBefore`、`diagnostics.localAfter`、`diagnostics.remoteParent`，stats 含 added/updated/deleted/skipped/failed；SFTP
单文件同步的底层 size、mode/permissions、mtime 和 SHA-256 对比位于 `transportVerification`，用户请求的 `verifyOwner`、
`verifyMode` 或目录 `verify` 结果位于顶层 `verification`

### sync-exclude-01

**步骤**：建立 `sub/cache/ignored.log` 和 `other/cache/kept.log`，调用 `ssh_sync(..., exclude=["sub/cache/**"])`

**预期**：排除模式按源目录下相对路径解释，`sub/cache/ignored.log` 不传输，`other/cache/kept.log` 保留；不含 `/` 的模式继续按 basename 匹配

### sync-directory-root-01

**步骤**：分别触发 rsync 和 SFTP，把本地目录 `/tmp/mcp-sync` 同步到目标 `/tmp/mcp-sync-r`

**预期**：两种 transport 都把源目录内容放到目标根目录，不额外生成 `/tmp/mcp-sync-r/mcp-sync`；目录源传 `recursive=false` 时明确拒绝

### sync-directory-verify-01

**步骤**：对含子目录和文件的目录调用 `ssh_sync(..., verify={count:true, sha256:true, owner:true, mode:true, staleFiles:true})`

**预期**：登录用户与本地 owner 一致时返回 `transferSuccess=true`、`verificationStatus="matched"` 和目录 summary；owner 不一致时应明确返回 `mismatched` 和限量样本，不能自动 chown；完整 manifest 不进入响应，mismatch 样本不超过 20 个

### sync-directory-delete-verify-01

**步骤**：使用 direct key path 或 SSH agent 的 rsync eligible session，目标目录先放入源目录没有的 `stale.txt`，调用 `ssh_sync(..., delete=true, verify={deletions:true})`；另用 password/SFTP session 验证拒绝路径

**预期**：rsync 路径在传输前采集目标 baseline，传输后 `checks.deletions=true`、`summary.deletionCandidates=1`、`summary.deletedEntries=1`；SFTP 路径明确返回不支持 `delete=true`；只传 `verify.deletions=true` 而未传 `delete=true` 时返回 `DELETION_VERIFICATION_REQUIRES_DELETE`

### sync-directory-skipped-verify-01

**步骤**：目录中放入 symlink 和 FIFO，使用默认 `followSymlinks=false` 调用带 `verify` 的 `ssh_sync`

**预期**：传输返回 symlink/unsupported 的 skipped 数量和限量样本；校验返回 `skipped`，顶层 `success=false`，同时保留实际 `transferSuccess`

### sync-transport-selection-01

**步骤**：分别使用 direct key path、SSH agent、password、inline key 和 jumpHost session 调用 `ssh_sync`

**预期**：direct 已校验 key path 或可用 agent 可选择 rsync；password、inline key、jumpHost 选择 SFTP；响应包含 `selectedTransport`、`decisionReason`、`rsyncProbe` 和阶段耗时，未进入 rsync 探测时 `rsyncProbe.status="skipped"` 并返回 reason，probe timeout/transport error 不缓存为“rsync 不存在”

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

**预期**：白名单生效，未设环境变量时不限制；失败响应包含 local、remoteParent 诊断

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
