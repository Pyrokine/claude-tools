# mcp-ssh 回归测试用例

每次发版前，agent 在 CC 会话内按章节顺序执行所有必跑用例，只有全部 PASS 或已登记为 KNOWN-LIMIT 才能发版

本文件只维护可复用的测试指导、用例定义、验收标准和长期限制，不记录单次执行结果、日期化回归记录或发版日志

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

**预期**：白名单内不存在的路径返回明确的 `ENOENT`/`no such file` 错误，不挂死，错误中的 `connectionStep="key_read"`
；白名单外路径单独返回安全校验错误，不要求回显原始路径

### connect-agent-none-01

**步骤**：使用本次测试创建的 SSH config，分别在目标 Host 和 `Host *` 设置
`IdentityAgent none`；覆盖密码、私钥、ProxyJump 私钥，以及显式参数和模板提供 agent 的情况；在 mock
ssh2 中设置一个环境 socket，连接后重连，再用可用密钥执行隔离的 rsync fixture

**预期**：`none` 不作为 socket 预检，不传给 ssh2，也不使用
`SSH_AUTH_SOCK`；密码和私钥连接可完成；目标与跳板机配置即使含私钥也保留 `none`；显式 agent 优先于模板，模板优先于 SSH
config；重连和配置 fingerprint 保留禁用语义；外部 ssh/rsync 不继承环境 socket，ssh 参数含
`IdentityAgent=none`，密钥仍可使用 rsync；其他不存在的显式 socket 仍拒绝连接

### connect-no-delay-01

**步骤**：执行持久回归，在直连和跳板底层 socket 创建后记录客户端 `setNoDelay` 调用；连接失败后检查 pending 状态，再按
`sync-parallel-01` 用自有原生 sshd 测量小文件同步，检查大文件校验和重连

**预期**：每个新客户端在调用 `connect` 后启用
`setNoDelay(true)`，连接失败不残留 pending 状态；跳板与重连使用同一设置，SFTP-only、内容校验和超时语义保持，不使用诊断 preload 代替当前代码验收

### connect-ready-timeout-01

**步骤**：连接一个可建立 TCP 但不完成 SSH ready 的受控目标，设置 `readyTimeout=1000`

**预期**：在有界时间内失败，返回 `failureStage="ready_timeout"`、`connectionStep="target_connect"` 和提高 `readyTimeout`
的 suggestion；jumpHost 未单独设置 `readyTimeout` 时继承顶层值

### reconnect-01

**步骤**：

1. connect 成功
2. 模拟服务端 close（`ssh_exec` 一个长时间命令然后服务端 timeout）
3. `ssh_reconnect(alias=...)`

**预期**：重连成功，原 alias 可继续 exec；调用旧 client `end()` 前，绑定旧连接的 operation 进入
`unknown`，PTY 和 forward 被关闭，rsync capability cache 被清除；新 client ready 后旧 client 才触发 `close`
也不会遗留旧资源或阻止新 remote
forward 注册 dispatcher；旧 session 安排的自动重连 timer 在同 alias 已发布新 session 后不得调用 reconnect 或断开新 client

### connect-mutex-01: per-alias mutex（C.8 验证）

**步骤**：并发 2 次完整配置相同的
`ssh_connect(configHost="<alias>")`；在第一条连接仍为 pending 时，再使用同一 alias 分别改变 host、认证、`runAs`、环境变量或 jump
host 发起连接

**预期**：配置相同的两次调用都返回 success，但底层只建一个连接，第二次复用 pending
Promise；任一连接语义不同的调用立即拒绝，不得复用 pending Promise

### connect-template-01: template + runAs

**步骤**：设置 `SSH_MCP_TEMPLATES`，包含 host/user/port/runAs/defaultEnv；
`ssh_connect(template="<template>", alias="<alias>")`；`ssh_exec(alias="<alias>", command="whoami && echo $TEST_ENV")`

**预期**：whoami 返回 runAs 用户，环境变量来自 defaultEnv；`ssh_exec(..., useLoginUser=true)` 返回登录用户；connect 返回
`identity`、`loginUser`、`runAs`、`reused`、`defaultEnvKeys`；`ssh_list_sessions` 返回 canonical `identity`

### connect-template-validation-01: template 字段校验

**步骤**：在 `SSH_MCP_TEMPLATES` 或 `~/.mcp-ssh/templates.json` 中定义一个端口为 `0`、小数、超过 `65535`
或 jumpHost 缺少 `user` 的模板，再调用 `ssh_connect(template=<template>)`

**预期**：连接请求不会发出，错误包含模板名和无效字段路径，不包含密码、私钥内容、keyPath 或完整模板配置

### connect-reusable-sessions-01: 同 identity alias 候选

**步骤**：

1. `ssh_connect(host=<host>, user=<user>, keyPath=<path>, alias="mcp-test-a")`
2. `ssh_connect(host=<host>, user=<user>, keyPath=<path>, alias="mcp-test-b")`

**预期**：第二次 connect 返回 `identity`，`reusableSessions` 含 `mcp-test-a`，并给出可直接复用已有 alias 的 suggestion

### connect-alias-conflict-01: alias 配置冲突

**步骤**：

1. `ssh_connect(host=<host-a>, user=<user>, keyPath=<path>, alias="mcp-conflict", runAs="app", env={REGION:"one"})`
2. 使用同一 alias 分别改变 host、认证、`runAs`、环境变量或 jump host 再调用 `ssh_connect`

**预期**：每个配置冲突的 connect 都被拒绝，包括 identity 相同但会话语义不同的情况；错误包含 existing identity、requested
identity 和更换 alias 或先 disconnect 的 suggestion；成功响应中的 identity、loginUser、runAs 和 env
keys 来自实际发布的 session

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

**步骤**：先 connect 两个 alias（可指向同 host 不同 alias），再
`ssh_exec_parallel(aliases=[a1, a2], command="hostname")`

**预期**：两个 alias 都返回 hostname

### exec-sudo-identity-01

**步骤**：建立含连接级 `runAs` 的会话，分别以默认参数、显式 `runAs` 和 `useLoginUser=true` 调用
`ssh_exec_sudo`，密码和无密码分支都覆盖

**预期**：两条分支与 `ssh_exec` 使用相同身份优先级。返回的 `effectiveUser` 依次反映连接级用户、参数用户或登录用户

### quick-exec-timeout-01

**步骤**：并发执行两个 `ssh_quick_exec`，分别设置短 `readyTimeout` 和独立命令 `timeout`

**预期**：每次调用使用独立临时连接，不互相 disconnect。连接阶段只受 `readyTimeout` 限制，连接成功后的命令只受 `timeout`
限制

### exec-timeout-01

**步骤**：`ssh_exec(alias=..., command="sleep 5", timeout=2000)`

**预期**：timeout 错误明确，不挂死；返回 `failureKind="timeout"`、`timedOut=true`、
`stdoutHead/stdoutTail/stderrHead/stderrTail`、`stdoutBytes/stderrBytes`、`recommendedReadCommand`；`loadProfile=true`
时 suggestions 含 `loadProfile=false` 或提高 timeout

### exec-max-output-01

**步骤**：`ssh_exec(alias=..., command="yes x | head -1000", maxOutputSize=100)`

**预期**：返回 `stdoutTruncated=true`、`stdoutBytes`、`stderrBytes`、`stdoutHead`、`stdoutTail`、`maxOutputSize` 和
`recommendedReadCommand`

### exec-utf8-chunks-01

**步骤**：故障注入把中文 BMP 字符和四字节 emoji 分散到多个 stdout/stderr data
chunk，在普通 exec 和带密码的 sudo 分支分别执行；最后一个 chunk 后触发 close

**预期**：stdout/stderr 与原文一致，不含替换字符；`stdoutBytes`/`stderrBytes`
等于原始 Buffer 字节数；close 时处理增量解码器残余，重复终态事件不追加输出

### exec-command-risk-01

**步骤**：只在 mock handler 中输入下列命令检查 `ssh_exec`
风险分类，不在真实主机执行：`grep -R secret /tmp`、`python app.py`、`tail -f /tmp/x`、`kill 1`、`systemctl restart x`、`echo secret-marker`、`su - appuser -c whoami`、`curl --token=xxx`，另用 cmd 的
`taskkill /F /PID 1` 和 PowerShell 的 `Remove-Item -Recurse C:\\Test` 测试

**预期**：只读搜索、普通解释器和敏感词输出不误报；破坏性、提权、凭据参数、进程控制和资源使用分别返回对应的
`commandRisk.categories` 与 `signals`

### exec-command-risk-heredoc-01

**步骤**：仅调用分类函数和 mock `ssh_exec`/`ssh_exec_batch` handler，不在真实主机执行覆盖
`python3 -I - <<'PY'\nprint(oct(0o100600 & 0o777))\nPY`，以及引用、未引用、部分引用、反斜杠引用、空 delimiter、`<<-`
和同一命令的多个 here-doc，正文包含普通 `rm`、Python 位运算、`it's`、引号与
`&`，delimiter 后追加命令对照大小写不同、尾部多字、空格缩进和续行的 delimiter，以及 here-string 和引用或转义的 `<<` 文本

**预期**：正文普通文本不产生 Shell 风险，delimiter 精确匹配后恢复检查，`<<-`
只移除行首 tab 引用及部分引用 delimiter 关闭正文展开；未引用正文中的
`$()`、反引号和嵌套命令替换仍报告对应风险双引号参数内有效命令替换会报告，单引号和转义后的替换文本不报告 mock
handler 收到原始命令，分类不改变执行次数、`success`、退出码或输出，执行失败仍按原结果返回

### exec-command-risk-background-01

**步骤**：仅调用分类函数和 mock handler，以 `sleep 1 &` 分别在 EOF、空格、tab 和换行结尾测试覆盖 here-doc
delimiter 后、引用或转义参数后、重定向后，以及命令替换内的后台操作对照 `&&`、`2>&1`、`3<&0`、`&>`、引用内的 `&`、转义
`\\&` 和 Python `-c` 位运算

**预期**：后台操作返回 `level="high"`、`categories=["process-control"]`、`signals=["background_task"]`
逻辑连接、重定向、引用和转义文本不被当作后台操作，cmd 和 PowerShell 既有分类回归保持通过 Linux 上的 mock 与分类回归不代表 Windows 原生验证

### exec-script-01

**步骤**：`ssh_exec_script(alias=..., script="set -e\nwhoami\npwd", cwd="/tmp")`

**预期**：脚本执行成功，默认不返回 remotePath；连接级 `runAs` 或参数 `runAs`
生效时脚本仍保持 700 私有权限并能由目标用户执行； `keepScript=true` 时返回 remotePath 且远端文件存在

### exec-script-upload-timeout-01

**步骤**：故障注入让 `mktemp` 成功，但 SFTP write stream 不完成；调用
`ssh_exec_script(alias=..., script="printf never", timeout=25)`

**预期**：上传阶段在请求的 timeout 内失败，错误说明 SFTP 状态未知；不进入 chmod 或脚本执行阶段；默认清理开启时仍尝试删除远端临时文件

### log-query-recipe-01

**步骤**：写入 `/tmp/mcp-log-test/app.log`，用 `ssh_exec_script` 执行只读脚本，把
`grep -n -I -F "ERROR" /tmp/mcp-log-test/*.log | head -100` 写到 `/tmp/mcp-log-test/errors.txt`，再用
`ssh_read_file(alias=..., remotePath="/tmp/mcp-log-test/errors.txt", maxBytes=65536)` 读取

**预期**：`ssh_exec_script` 成功，`ssh_read_file` 返回内容包含 ERROR 行，并带
`read_offset`、`read_bytes`、`sample_kind`、 `remaining_bytes` 元数据

### exec-cwd-env-failure-01

**步骤**：调用 `ssh_exec(alias=..., cwd="/tmp/mcp-cwd-does-not-exist", env={"MCP_TEST":"1"})`，用户命令分别包含
`printf ignored; touch /tmp/mcp-cwd-env-executed`、换行后 `touch`、`false || touch`；在 `runAs + loadProfile`
路径重复故障注入

**预期**：均返回非零退出，目标文件不存在；`cd` 失败后不得执行 `export` 或完整用户命令中的任何部分；在 Bash 下执行
`set -o pipefail`、数组和 `[[ ... ]]` 时仍使用 Bash 语义，不得强制改用 `/bin/sh`

### operation-lifecycle-01

**步骤**：

1. `ssh_operation_start(alias=..., command="printf start; sleep 30; printf done")`
2. `ssh_operation_status(operationId=...)`
3. `ssh_operation_read(operationId=..., maxBytes=65536)`
4. `ssh_operation_cancel(operationId=...)`
5. 再次读取 status 和 output

**预期**：start 返回不可预测的 `operationId`，状态从 `starting/running` 进入
`cancelled`；status 返回已校验的 PID 和 marker 状态；read 返回字节偏移及有上限的 stdout/stderr；cancel 只在 marker 校验后执行

### operation-exit-code-01

**前置条件**：自有 Linux/POSIX Shell 环境；普通进程和会话首进程场景需要支持等待退出的 `setsid`

**步骤**：使用公开 `ssh_operation_start/status/read`，分别启动零退出、非零退出、带诊断 stderr 的零退出、 `sh` 不支持的
`set -euo pipefail` 以及显式 `bash -lc` 对照；在自有 SSH
fixture 中，让原 wrapper 分别从普通进程和会话首进程启动，再限制自有 PATH 使 `setsid` 不可见，重复零/非零退出

**预期**：status/read 的终态和退出码与实际命令一致，非零退出为 `failed`，零退出为
`completed`，stderr 非空不单独表示失败；marker、stdout/stderr 与 retention 元数据保留，不能将 `setsid`
派生时外层的提前退出当作业务完成；无 `setsid` 时
`processGroup=false`，仍保留真实退出码；持久回归必须执行实际 wrapper，不手工发射期望的退出码

### operation-cancel-shell-01

**前置条件**：自有 Linux 进程、可读取自身 `/proc/<pid>/environ`，本地 `sh` 和 Bash 可用

**步骤**：在两种 Shell 中分别为本次创建的单 PID 和进程组执行取消；故障注入使用错误 marker，确认拒绝且原进程继续存在，随后使用合法身份取消；公开 MCP 在普通进程和会话首进程中验证 marker/running、cancel、status/read 的完整链路

**预期**：错误身份不发送信号；合法身份成功发送 TERM，公开记录进入
`cancelled`，后续命令未执行，输出和系统终止诊断原样保留；清理阶段终止自有进程不计产品取消成功，不终止其他进程，不放宽 marker/PID 校验

### operation-marker-preamble-01

**步骤**：使用会向 stderr 写入 profile
warning 的账号启动 operation，warning 后再输出合法 marker；另用故障注入测试发送 warning、错误 token marker 和超长 marker

**预期**：合法 marker 前的 warning 保留在 operation stderr，状态进入 `running`；warning 未换行且 marker 紧随其后、marker
prefix 跨两个 data
chunk 时仍识别 marker，并只把 warning 保存到 stderr；使用 marker 前缀但 token、长度或进程元数据错误时状态进入 `failed`
终态，`finishedAt`/`expiresAt` 已设置且 channel 被销毁；marker 本身仍受 512 字节限制

### operation-early-close-01

**步骤**：故障注入让 `client.exec` callback 内的 channel 在 callback 返回前依次输出合法 marker 并触发 close

**预期**：operation listener 在 exec callback 返回前已经安装，start 返回 `completed` 终态，`markerVerified=true`，
`finishedAt` 非空且 `expiresAt=finishedAt+retentionMs`，不得永久停留在 `starting` 或 `running`

### operation-start-stale-session-01

**步骤**：故障注入延迟 `client.exec` callback，在 callback 返回前 disconnect；另一次在同 alias
reconnect 到新 client 后再释放旧 callback

**预期**：两种情况都拒绝 operation start，旧 callback 返回的 stream 被销毁，已创建的 operation
record 进入终态并按 retention 过期

### operation-start-timeout-01

**步骤**：故障注入让 SSH 服务端保持连接但不回应 operation 的 channel-open/exec request，设置
`startTimeoutMs=1000`；等待期间调用 list，并对同 alias 再启动一次 operation；超时后释放原 callback

**预期**：等待期间 list 可见 `starting` record，第二次 start 被拒绝并返回已有
`operationId`；首个 start 在 1 秒后返回 timeout，details 含同一 `operationId`，record 为 `unknown` 且设置
`finishedAt`/`expiresAt`；迟到 stream 被销毁，原 callback 返回或 alias 断开前不允许累积同 alias pending start

### session-callback-stale-01

**步骤**：分别延迟普通 exec、SFTP 和 PTY start
callback，在 callback 返回前 disconnect 并用同 alias 放入新 client，再释放旧 callback；另让 sudo exec
callback 在 timeout 后返回

**预期**：旧 session 的 exec、SFTP 和 PTY 资源都被销毁并拒绝发布，`ssh_pty_list` 不出现旧 PTY；sudo
stream 被关闭且不写入密码；目标连接在 jump host `forwardOut` pending 阶段被取消后，延迟返回的 jump
channel 同时执行 destroy 和 close

### operation-utf8-read-01

**步骤**：启动分块输出多字节 UTF-8 字符的 operation，多次调用 `ssh_operation_read`，让 `maxBytes`
落在字符中间，再使用 continuation byte 作为 offset 调用一次

**预期**：正常读取不会返回替换字符，`nextStdoutOffset` 停在完整字符边界；过小 `maxBytes` 或 continuation-byte
offset 返回明确 UTF-8 boundary 错误

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

**预期**：read 输出含 "pty_test"，返回 `lastInputAt`、`lastOutputAt`、`lastReadAt`、
`unreadRawBytes`、`rawBufferLimit`、`rawBufferTruncated`、`foregroundProcess`；list 项另含
`bufferSize`，close 后 ptyId 失效

### pty-02: top 全屏刷新

**步骤**：

1. `ssh_pty_start(alias=..., command="top -b -n 1")` → ptyId
2. 1s 后 `ssh_pty_read(ptyId=..., mode="screen")`
3. close

**预期**：命令自然结束后仍可读取最终 screen viewport（不含历史滚屏），含 PID/CPU 列头，返回
`active=false`；显式 close 后 ptyId 失效

### pty-03: raw 模式

**步骤**：`ssh_pty_read(ptyId=..., mode="raw")`

**预期**：包含 ANSI 转义序列原文

### pty-utf8-byte-limit-01

**步骤**：使用 4 到 7 字节的 `bufferSize`，把中文字符和 emoji 跨多个 data
chunk 写入 PTY，使总输出超过限制；依次执行 screen 读取、`raw clear=false`、默认 raw clear 和 list

**预期**：screen 正常解码；raw 的 `dataBase64`
解码后与保留的原始字节完全相同，包括边界处不完整 UTF-8 序列。`bufferSize`、`unreadRawBytes`、`rawBufferLimit`
按字节计数；溢出后 `rawBufferTruncated=true`。默认 raw
clear 的响应返回清理前计数和标志，随后 list 返回 0/false；screen 读取不清理 raw 状态

### pty-list-observability-01

**步骤**：创建 pty 后调用 `ssh_pty_list`

**预期**：会话项含 `lastInputAt`、`lastOutputAt`、`lastReadAt`、`bufferSize`、`unreadRawBytes`、
`rawBufferLimit`、`rawBufferTruncated`、`foregroundProcess`，三个 size 字段均按原始字节计数

### pty-write-backpressure-01

**步骤**：让 PTY 的输出读取端暂不消费，连续调用 `ssh_pty_write` 直到返回 `backpressured=true`

**预期**：响应仍为 `success=true` 和
`accepted=true`。backpressured 仅表示本地 buffer 达到高水位，不能报告输入未发送或已丢失

### pty-close-retry-01

**步骤**：故障注入 stream.close 或 terminal.dispose 失败后调用 `ssh_pty_close`，再移除故障重试

**预期**：首次返回 `failed` 或 `unknown`、`retryable=true`，`ssh_pty_list` 仍包含该会话。重试成功后才从列表移除

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

### forward-remotePort-zero-01

**步骤**：`ssh_forward_remote(alias=..., remotePort=0, localHost="127.0.0.1", localPort=3000)`，记录返回的 `remotePort`
，通过该端口访问本地服务，再关闭 forward

**预期**：返回的 `remotePort` 为服务器实际分配的非零端口，list 使用同一端口，关闭时 `unforwardIn` 也使用该端口

### forward-pending-disconnect-01

**步骤**：故障注入延迟 local `listen`、remote `forwardIn` 和 local `forwardOut` callback，在 callback 完成前执行
`ssh_disconnect` 或 close，再释放 callback

**预期**：pending creation 立即失败且不会进入 list；延迟出现的本地 listener 被关闭，延迟分配的远端 listener 被
`unforwardIn`；同 alias 最多发出 32 个 pending `forwardOut`，后续本地连接直接关闭；local forward 的 `forwardOut`
callback 尚未返回时，force close 在 timeout 后返回 `success=false`、`retryable=true` 并保留状态，同 alias 新建 local
forward 被拒绝；callback 返回后 stream 被销毁，再用原 forwardId close 成功，已关闭状态不会被 callback 重新发布

### forward-list-01

**步骤**：建 2 个转发后 `ssh_forward_list`

**预期**：返回数组含两条记录。每条有 `lifecycle` 和 `acceptingConnections`，active 时为 `active`/`true`

### forward-list-closing-01

**步骤**：创建有活跃连接的 local forward，使用很短 timeout 调用 graceful close 后立即调用 `ssh_forward_list`

**预期**：转发仍在列表中，`lifecycle="closing"`、`acceptingConnections=false`。使用同一 forwardId force
close 后，列表项消失

### forward-close-graceful-01

**步骤**：创建 local forward，记录实际端口，调用
`ssh_forward_close(forwardId=..., mode="graceful", timeoutMs=5000)`，返回后立即在本地 bind 同一端口

**预期**：返回
`success=true`、`listenerReleased=true`、`closeMode="graceful"`，同一端口可立即 bind，forward 已从 list 删除

### forward-close-force-01

**步骤**：创建 local forward 并保持一个活跃连接，先用极短 timeout 执行 graceful close，再用同一 forwardId 执行
`ssh_forward_close(..., mode="force")`

**预期**：graceful timeout 返回 `success=false`、`retryable=true`，forward 仍在 list；force 同时销毁本地 socket 和 SSH
`forwardOut` channel，返回 `activeConnections=0`，等待 listener 释放后才删除状态

### forward-close-remote-failure-01

**步骤**：创建 remote forward，模拟 `unforwardIn` callback 失败或超时，再调用 list；另在 callback pending 期间触发新的
`tcp connection`

**预期**：失败返回
`remoteUnforwarded=false`、`retryable=true`，forward 状态保留，可使用同一 ID 重试；closing 期间的新连接被 reject，不会增加
`activeConnections` 或遗留 stream/socket；callback 完成后重试成功

### forward-close-remote-force-01

**步骤**：创建 remote forward，接收一条指向本地测试服务的活跃连接，再调用
`ssh_forward_close(forwardId=..., mode="force", timeoutMs=1000)`；让 stream 和 socket 的 close/error 都能到达

**预期**：首次 close 返回
`success=true`、`remoteUnforwarded=true`、`activeConnections=0`，不需要重试；同一连接两端事件只计数一次，forward 从 list 删除

### forward-idle-timeout-01: idle-timeout 主动回收（C.7 验证）

**步骤**：建 forward 后无连接活动一段时间（或测试时改阈值）

**预期**：长时间无连接的 forward 自动关闭并 console.warn

---

## 6. 文件操作（upload / download / sync / read / write / file_info / list_dir / mkdir）

### file-write-read-01

**步骤**：

1. `ssh_write_file(alias=..., remotePath="/tmp/mcp-test-write", content="hello\n")`
2. `ssh_read_file(alias=..., remotePath="/tmp/mcp-test-write")`

**预期**：read 返回 "hello\n"，并包含
`total_size`、`read_offset`、`read_bytes`、`remaining_bytes`、`sample_kind`、`truncated`

### file-append-01

**步骤**：`ssh_write_file(alias=..., remotePath=..., content="more\n", append=true)` 后 `ssh_read_file`

**预期**：返回 `hello`、换行、`more`、换行

### file-read-range-01

**步骤**：写入 200 行测试文件后分别调用 `ssh_read_file(..., tail=true, maxBytes=64)`、
`ssh_read_file(..., offset=128, maxBytes=64)`、`ssh_read_file(..., lineRange="120-130")`

**预期**：返回内容符合尾部、字节范围和行范围；`sample_kind` 分别为 `tail`、`range`、`line_range`

### file-read-utf8-range-01

**步骤**：写入含多字节 UTF-8 字符的文件，让 `maxBytes` 落在字符中间，使用响应中的 `next_offset`
发起下一次读取；另传入字符中间的显式 `offset`

**预期**：每次 `content` 只含完整字符，并返回 `requested_offset`、实际 `read_offset`、`read_end` 和
`next_offset`。中间偏移返回 UTF-8 boundary 错误，不返回替换字符

### file-read-encoding-boundary-01

**步骤**：通过公开 `ssh_read_file` handler 读取 UTF-16LE/BE 的普通字符、代理对、BOM 和 EOF 无效编码；将 `maxBytes`
分别设为 1、2、3 和能容纳完整字符的值，使用 `next_offset` 继续；把 code unit 和代理对分散到不同 SFTP chunk；另用
`binary=true` 每次读取一个字节

**预期**：预算不足时明确返回
`maxBytes is too small`，不成功返回零进度页；只裁掉预算造成的末尾不完整字符，EOF 处奇数字节、孤立代理和完整无效编码返回错误；BOM 已消耗的字节计入前移，不因正文为空报预算不足；read
stream 不请求超过 `maxBytes` 的字节；binary 原样返回所有字节并持续前移

### file-read-line-metadata-01

**步骤**：对 UTF-8、UTF-16LE/BE 和 binary，以公开 handler 读取 `hello\r\nworld\r\n` 的
`lineRange="1-2"`；预算覆盖第一行内部、完整第一行、第二行内部和完整两行；再用非 ASCII 字符验证解码丢弃末尾不完整字符的情况，改变 chunk 边界并覆盖 UTF-16 奇数字节预算

**预期**：`line_start`、`line_end` 和 `final_line_terminated` 只描述 `read_bytes`
对应的返回前缀；第一行截断仍有行号，完整第一行后没有返回第二行字节时不能计入第二行；CRLF 和 UTF-16 换行宽度正确；binary 部分 code
unit 原样返回；metadata 不发起额外远端读取

### file-sftp-timeout-01

**步骤**：故障注入 SFTP 的 stat、readdir、read stream、write stream 或 rename callback 不返回，对任一文件工具传入短
`timeout`

**预期**：在指定时间后返回 `operationStatus="unknown"` 和
`retryable=true`，迟到 callback 不得发布 success。重试前检查实际远端或本地状态

### file-read-limit-01

**步骤**：`ssh_read_file(alias=..., remotePath="/tmp/mcp-test-write", maxBytes=16777217)`

**预期**：schema 层拒绝请求，不发起远端传输；文档说明默认 1 MiB，最大 16 MiB

### file-info-01

**步骤**：`ssh_file_info(alias=..., remotePath="/tmp/mcp-test-write")`

**预期**：含 size、mtime、数值 `mode` 和 `permissions`；对 4755、2644、1755 等权限分别返回完整特殊位及对应的 `s/S/t/T`
展示

### list-dir-01

**步骤**：在自有测试目录准备超过 100 个条目，调用
`ssh_list_dir(alias=..., remotePath=<test-dir>, showHidden=false)`，不传名称、时间或分页参数，再用 `showHidden=true`
重复

**预期**：响应保持 `{success, path, count, files}`，`files`
含全部可见条目，目录优先并按名称排序，不附加分页字段；`showHidden=true` 包含点开头名称，单独传 `timeout` 仍保持完整响应

### list-dir-filter-01

**步骤**：为自有文件设置连续秒级 mtime，以 `namePattern="*.log"`、带时区的 `modifiedAfter` 和 `modifiedBefore`
联合查询；覆盖起点、终点、等价时区、亚毫秒边界、相等起止、隐藏文件、空匹配、区分大小写、字面
`+`/`[]`、换行和多字节名称，再输入无时区时间、无效日期和起点晚于终点的区间

**预期**：名称、时间和隐藏文件条件取交集，区间起点包含、终点不包含，相等起止返回空结果；名称通配复用同步 exclude 的
`*`/`?` 语义；非法参数在 SFTP 读取前拒绝

### list-dir-page-01

**步骤**：在稳定的自有目录以 `namePattern="*"` 查询，未指定条数或字节预算；再以较小 `limit` 和 `maxBytes` 反复使用
`next_offset` 续查，覆盖末页、空目录、超过末尾的偏移，以及负数、小数或超出安全整数范围的参数

**预期**：有界模式默认最多 100 条、65536 UTF-8 字节；`count` 为本页条数，`total_count`
为匹配总数，`next_offset=offset+count`，`has_more`
准确；稳定目录所有分页的并集与完整列表一致，无重复或遗漏，末尾空页保留请求偏移；非法数值在远端读取前拒绝

### list-dir-byte-01

**步骤**：准备含中文、四字节字符、引号和换行的条目，按实际响应 `content[0].text`
计算 UTF-8 字节数，分别使用恰好可容纳与少一个字节的
`maxBytes`；覆盖分页元数据也无法容纳、首项超预算、已有前缀可返回但下一项超预算，以及偏移位数变化

**预期**：成功 JSON 文本连同元数据和格式空白不超预算，不按字符串字符数或仅条目正文计费；条目无法完整返回时使用
`LIST_DIR_MAX_BYTES_TOO_SMALL` 与 `requiredBytes` 报错，错误响应保留
`offset`/`next_offset`，不返回无进度成功页，不跳过超预算条目；错误诊断不受成功响应预算约束

### list-dir-internal-01

**步骤**：公开目录调用返回有界页后，直接内部 `listDir`
读取超过 100 项的同一目录；通过 SFTP 递归下载并请求 count、SHA-256 和 staleFiles 校验，覆盖隐藏文件、子目录及排序靠后的文件；另让被筛选或分页排除的条目含非法名称

**预期**：内部列表完整，递归下载和目录校验不受公开分页默认值影响；传输和校验结果匹配完整自有目录，非法名称仍在构造子路径前拒绝；完整
`readdir` 后的响应分页不代表远端增量或快照一致性

### list-dir-stdio-01

**前置条件**：Linux、ssh 和 sshd 可用，测试账号可创建 loopback SSH/SFTP 服务；只使用临时 HOME、临时密钥和自有 master

**步骤**：执行 `test/openssh.test.mjs` 中的公开 stdio SFTP 目录用例，核对 initialize 的 server name/version，检查
`tools/list` 六个新字段，再经 `tools/call` 完成名称／时间交集、续页、字节错误及完整下载校验；用显式 OpenSSH master
alias 请求有界目录列表

**预期**：独立 stdio 进程的注册与实际 SFTP 结果一致，默认后端仍为 ssh2，OpenSSH alias 返回现有
`unsupported_backend`，不转用 ssh2/SFTP 或新增认证，关闭测试 MCP 后自有 master 仍存活；该结果只证明被测试的独立进程，当前用户 Host 加载身份单独核验

### mkdir-01

**步骤**：`ssh_mkdir(alias=..., remotePath="/tmp/mcp-test-dir/sub", recursive=true)` 后
`ssh_list_dir(/tmp/mcp-test-dir)`

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

**步骤**：本地 `echo "abc" > /tmp/mcp-up-verify.txt`，再调用：

```text
ssh_upload(
    alias=...,
    localPath="/tmp/mcp-up-verify.txt",
    remotePath="/tmp/mcp-up-verify-r.txt",
    atomic=true,
    verifySize=true,
    verifyMd5=true,
    verifyMode="0644"
)
```

**预期**：返回 `atomic=true`；`diagnostics.tempRemotePath` 包含不可预测随机段，临时文件使用 SFTP `wx` 独占创建；
`finalRemotePath` 为最终目标，`verifiedRemotePath` 与 `verifiedTempRemotePath` 指向临时校验路径，
`verification.actual.remotePath` 与该临时路径相同；校验通过后才 rename，目标文件内容为 "abc\n"，临时路径不再存在，
`targetReplaced=true`

### upload-special-mode-verify-01

**步骤**：让 SFTP stat 返回 mode 4755，分别以 `verifyMode="0755"`、`verifyMode="4755"` 和 `verifyMode="-rwsr-xr-x"`
执行单文件 upload 校验

**预期**：0755 校验失败，4755 和权限文本校验成功；实际结果保留数值 mode 和
`-rwsr-xr-x`，判断不依赖 permissions 文本反向转换；创建新内容时仍只使用 0777 范围内的权限位

### upload-atomic-verification-failure-01

**步骤**：远端目标先写入 `original`，执行 `atomic=true` 上传并故障注入 size、MD5、mode、owner 或 mtime 任一校验失败

**预期**：返回 `success=false`、`transferSuccess=true`、`targetReplaced=false`，远端目标仍为
`original`，临时文件已删除且未调用rename

### upload-atomic-rename-01

**步骤**：分别对已存在目标和不存在目标执行 `atomic=true` 上传；故障注入 rename
API 同步抛错，以及 rename 请求发出后 callback 返回错误

**预期**：已有目标使用 OpenSSH `posix-rename@openssh.com` 扩展，不存在目标使用标准 SFTP rename；同步抛错返回
`operationStatus="failed"`、`targetReplaced=false`、`targetReplacementStatus="not_replaced"`，原目标不变；callback 错误返回
`operationStatus="unknown"`、`targetReplaced=null`、`targetReplacementStatus="unknown"`，调用方需要检查目标后再重试；两种失败都尝试清理临时文件

### download-01

**步骤**：`ssh_write_file(... remotePath="/tmp/mcp-dn-r.txt", content="xyz\n")`；
`ssh_download(alias=..., remotePath="/tmp/mcp-dn-r.txt", localPath="/tmp/mcp-dn.txt")`；本地 cat

**预期**：本地 mcp-dn.txt 含 "xyz\n"，响应含 `atomic=true`，目标目录不残留 `.mcp-tmp-*` 文件

### download-mode-01

**步骤**：分别下载到不存在的目标，以及 mode 为 0600、0750、4755 的既有普通文件；传输暂停在临时文件已创建、尚未完成的阶段检查临时 mode

**预期**：传输中的临时文件为 0600；新目标最终为 0600；0600 和 0750 目标保留原 `rwx`
位；4755 目标最终为 0755，不复制 setuid/setgid/sticky；内容均在完整传输后原子替换

### download-nonregular-target-01

**步骤**：把本地目标分别设为 symlink、目录和 FIFO，再调用 `ssh_download`

**预期**：三类目标都在 SFTP stat/read stream 创建前被拒绝；symlink 指向的文件保持不变，同目录不产生临时文件

### download-atomic-failure-01

**步骤**：本地目标先写入 `original`，分别故障注入 SFTP read stream 在写入部分数据后报错，以及无错误但在 `stat.size`
之前提前EOF

**预期**：两种情况都返回失败，本地目标仍为 `original`，同目录临时文件已删除

### sftp-only-upload-01

**步骤**：使用仅开放 SFTP、拒绝 exec 的账号执行普通 `ssh_upload`、`ssh_download`、`ssh_mkdir(recursive=true)`
和带 MD5/size/mode 校验的单文件上传；在 BSD 主机重复普通上传

**预期**：父目录和目标探测、递归建目录、哈希、rename 与清理均通过 SFTP 完成，不调用 GNU
`stat`、`md5sum`、`sha256sum`、`mkdir`、 `mv` 或 `rm`；显式目录 manifest 校验不属于此用例

### list-dir-hostile-name-01

**步骤**：故障注入 SFTP `readdir`，分别返回空名称、`../escape`、绝对路径、含 `/`、含 `\\`、`.`、`..` 和 NUL 的 filename

**预期**：每个输入都在构造本地或远端子路径前被拒绝，不创建白名单外文件

### sync-upload-01

**步骤**：本地建目录树 /tmp/mcp-sync/{a.txt,b/c.txt}；
`ssh_sync(alias=..., localPath="/tmp/mcp-sync", remotePath="/tmp/mcp-sync-r", direction="upload", recursive=true)`
；远端验证树形结构

**预期**：

- 远端文件全部存在；sync 优先用 rsync（如可用），否则回退 SFTP
- 返回 `transport`、`duration`、`dryRun`、`stats`、`diagnostics.localBefore`、`diagnostics.localAfter` 和
  `diagnostics.remoteParent`；stats 含 added/updated/deleted/skipped/failed
- SFTP 单文件同步的底层 size、mode/permissions、mtime 和 SHA-256 对比位于 `transportVerification`
- 用户请求的 `verifyOwner`、`verifyMode` 或目录 `verify` 结果位于顶层 `verification`

### sync-exclude-01

**步骤**：建立 `sub/cache/ignored.log` 和 `other/cache/kept.log`，调用 `ssh_sync(..., exclude=["sub/cache/**"])`

**预期**：排除模式按源目录下相对路径解释，`sub/cache/ignored.log` 不传输，`other/cache/kept.log` 保留；不含 `/`
的模式继续按 basename 匹配

### sync-follow-symlink-allowlist-01

**步骤**：设置 `SSH_MCP_FILE_OPS_ALLOW_DIRS=/tmp/mcp-allowed`，对允许目录内的普通源目录调用
`ssh_sync(..., followSymlinks=true)`，分别让 rsync 和 SFTP 成为候选 transport

**预期**：请求在 transport 选择前被拒绝，错误说明 `followSymlinks=true` 不能与 `SSH_MCP_FILE_OPS_ALLOW_DIRS`
组合使用，SFTP channel、rsync capability probe 和文件传输均未启动；改用 `followSymlinks=false`
后，允许目录内的普通文件可以同步

### sync-directory-root-01

**步骤**：分别触发 rsync 和 SFTP，把本地目录 `/tmp/mcp-sync` 同步到目标 `/tmp/mcp-sync-r`

**预期**：两种 transport 都把源目录内容放到目标根目录，不额外生成 `/tmp/mcp-sync-r/mcp-sync`；目录源传 `recursive=false`
时明确拒绝

### sync-directory-verify-01

**步骤**：对含子目录和文件的目录调用
`ssh_sync(..., verify={count:true, sha256:true, owner:true, mode:true, staleFiles:true})`

**预期**：传输完成且所有已请求校验项一致时返回 `transferSuccess=true`、`verificationStatus="matched"`
和目录 summary；owner 或 mode 不一致时返回 `success=false`、`transferSuccess=true`、`verificationStatus="mismatched"`
及对应的 `checks.owner=false` 或
`checks.mode=false`，不自动 chown/chmod，完整 manifest 不进入响应，mismatch 样本不超过 20 个

SFTP 新目录使用目标端默认权限，新下载文件使用 0600，覆盖既有普通文件保留其 rwx 正例应准备 owner 和 mode 均匹配的目标；负例保留目录 mode 不同或新下载文件 mode 不同的场景，确认校验失败没有被传输成功掩盖显式修改自有目标权限后重复同步，确认所有请求项匹配时成功，工具不代替调用方修改权限

### sync-directory-special-mode-01

**步骤**：在源目录中创建 setuid、setgid 和 sticky
mode 条目，生成本地与远端 manifest；再分别清除目标 manifest 中的特殊位并比较 `verify.mode`

**预期**：manifest 使用四位八进制 mode；特殊位一致时匹配，任一特殊位不同都返回 `checks.mode=false` 和 mode mismatch 样本

### sync-directory-delete-verify-01

**步骤**：使用 direct key path 或 SSH agent 的 rsync eligible session，目标目录先放入源目录没有的 `stale.txt`，调用
`ssh_sync(..., delete=true, verify={deletions:true})`；另用 password/SFTP session 验证拒绝路径

**预期**：rsync 路径在传输前采集目标 baseline，传输后 `checks.deletions=true`、`summary.deletionCandidates=1`、
`summary.deletedEntries=1`；SFTP 路径明确返回不支持 `delete=true`；只传 `verify.deletions=true` 而未传 `delete=true`
时返回 `DELETION_VERIFICATION_REQUIRES_DELETE`

### sync-directory-skipped-verify-01

**步骤**：目录中放入 symlink 和 FIFO，使用默认 `followSymlinks=false` 调用带 `verify` 的 `ssh_sync`

**预期**：传输返回 symlink/unsupported 的 skipped 数量和限量样本；校验返回 `skipped`，顶层 `success=false`，同时保留实际
`transferSuccess`

### sync-transport-selection-01

**步骤**：分别使用 direct key path、SSH agent、password、inline key 和 jumpHost session 调用 `ssh_sync`

**预期**：direct 已校验 key path 或可用 agent 可选择 rsync；password、inline key、jumpHost 选择 SFTP；响应包含
`selectedTransport`、`decisionReason`、`rsyncProbe` 和阶段耗时，未进入 rsync 探测时 `rsyncProbe.status="skipped"`
并返回reason，probe timeout/transport error 不缓存为“rsync 不存在”

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

**步骤**：用 mock 分别让远端 rsync 探测失败，以及在 rsync 已开始传输后返回非零退出码

**预期**：探测阶段失败时 `selectedTransport` 和 `fallbackReason` 表明使用 SFTP；传输开始后失败时返回
`operationStatus="unknown"`，不再发起第二次 SFTP 传输

### security-ssh-config-hostname-01: ssh-config hostname 字符白名单（C.5 验证）

**步骤**：编辑 `~/.ssh/config` 加入恶意 host：

```
Host evil
  HostName "1.2.3.4 -oProxyCommand=/bin/sh"
```

然后 `ssh_connect(configHost="evil")`

**预期**：解析时拒绝（包含 -o / 引号 / 空格的 hostname 不应被接受）

---

## 8. npm 发布包

### package-clean-build-01

**步骤**：先在 `dist/__stale-package-probe__.js` 写入测试内容，再执行 `npm pack --dry-run --json`

**预期**：发包生命周期重新构建 server，输出文件清单不含测试文件或其他已从 `src` 删除的构建产物；包内不含
`TESTING.md`、仓库外绝对路径或本机用户目录

**清理**：构建失败时删除测试文件；构建成功后测试文件应已被自动删除

---

## 9. Windows 与跨平台兼容性（S1-S14）

本节的 mock/fixture 回归运行
`npm test`，覆盖公开工具注册、SessionManager、SFTP 和 shell 构造；Windows 原生验收必须在隔离的 Windows runner 或 Windows
OpenSSH 测试端执行；Linux 上通过模拟分支不能标为原生 PASS

### win-connect-shell-01（S1-S3、S11-S12）

在 Windows 机器用可用的 OpenSSH named pipe、Pageant 和 Cygwin/MSYS
agent 分别连接测试主机，检查连接结果、ssh2 实际认证以及 `ssh_sync`
capability；路径含空格和 Unicode 的私钥先用安全 DACL、再用 Everyone 可读 DACL、无法读取 ACL 的条件和显式拒绝当前身份读取文件内容的 DACL 测试；安全私钥可用，不安全时返回
`key_acl_insecure`，无法验证或无法实际读取时返回 `key_acl_unverified`，不得报告 `key_path_usable`，不修改已有私钥；SSH
config 的 `IdentityFile`、`IdentityAgent` 覆盖引号、`~\\`、盘符、UNC 和转义空格；连接 POSIX 与 Windows 各一台，用
`cwd/env`、`&&`、分号、带空格值验证选定 shell 的命令分组；Windows `runAs`、`ssh_exec_as_user` 和 `ssh_exec_sudo`
必须在发送远端命令前返回 `unsupported_remote_platform`

### win-script-operation-01（S4、S6）

在隔离 Windows OpenSSH 主机用 PowerShell 和 cmd 分别执行含空格路径、中文字符的 `ssh_exec_script`，确认 `.ps1` 的 UTF-8
BOM 和 `.cmd` 的代码页 65001 使内容正确执行；检查临时 `.ps1/.cmd`
在脚本正文写入前为私有 DACL；拒绝 ACL 操作时脚本不执行且空文件被清理；启动 tracked
operation，读取 PID、创建时间、marker 校验状态；对正确身份取消并确认进程树结束；将 PID 重用、创建时间不符、marker 不符和进程元数据不可读分别故障注入；不得仅因关闭 SSH
channel 就返回取消成功；无法验证身份时 `cancellationStatus` 应为 `unknown` 或 `unsupported`

### win-file-sync-01（S5、S7-S10、S13）

通过仅支持 SFTP 的测试账号读取 UTF-8、带 BOM 的 UTF-16LE/BE、GBK 和 CRLF 文件的 `lineRange`；`binary=true`
解码 base64 后与原文件逐字节相同；对目录 manifest 使用 `maxEntries/maxFileBytes/maxTotalBytes`
测试有限结果，Windows 的 POSIX owner/mode 参数必须拒绝，`verify.aclSddl` 则验证根目录 DACL；对 native
Win32、MSYS2、Cygwin 配置独立 rsync profile，用带空格的盘符及 UNC 双向同步，观察
`-e`、远端 executable 和路径映射；本地或远端 rsync 不可用时应显示 SFTP
fallback 原因；模拟 rsync 传输开始后失败，不应再启动 SFTP 重传；分别让 SFTP 服务支持和不支持
`posix-rename@openssh.com`，后者应在上传前拒绝覆盖旧文件；PTY 输出插入非 UTF-8 字节及不完整多字节序列，`dataBase64`
解码结果必须与保留的原始字节相等；exec 超过输出字节预算时不得截断半个字符

### win-upload-case-preflight-01

**前置**：Windows 本地源目录使用支持大小写敏感标志的 NTFS，并具备执行
`fsutil.exe file setCaseSensitiveInfo <空目录> enable` 的权限；创建名称后核对目录项确实同时存在
无法启用时，仅将依赖同名不同大小写源文件的子用例标为条件 SKIP，保留 fsutil 的错误原因；不同名称的用例继续执行

**步骤**：在区分大小写的本地文件系统建立 `a.txt` 和
`A.txt`，分别上传到已存在的 Windows 大小写敏感和不敏感目录；使用密码 SFTP 和密钥 rsync 两条路径；覆盖 file-directory、嵌套目录、Unicode 名称、exclude、默认跳过链接、followSymlinks、循环目录链接和 dry-run；故障注入父目录不存在、exec 不可用、超时、截断响应和缺字段；无候选目录使用只支持 SFTP 的账号，POSIX 目标也执行大小写不同的文件上传

**预期**：传输和目录创建前完成共享预检；大小写不敏感目标出现实际碰撞时返回 `windows_filename_collision`
且零传输，已存在的敏感目录可保留两个名称；候选语义无法验证时返回 `case_semantics_unverified`
且零写入，不能转用其他传输继续；查询使用 Windows `GetFileInformationByHandleEx` 的 `FileCaseSensitiveInfo` 和
`CompareStringOrdinal`，不能用本地 lowercase 作为最终证据；不从祖先推断尚不存在目录的标志，dry-run 不创建目录；exclude 和链接处理与上传一致；没有候选时不新增 exec/PowerShell 要求，POSIX 名称语义不变

### win-path-permission-risk-01（S9、S11、S14）

用本地和远端均含空格的 Win32/UNC 路径运行 list/mkdir、单文件与目录同步，检查最终 basename、父目录与目标位置；下载中断和既有目标文件被锁住时应保留原文件且清理临时文件；检查 Windows 会话产物及临时下载的 DACL 仅授权当前身份、SYSTEM 与 Administrators；分别运行无害
`grep -R secret`、普通 Python/Node、cmd 的 `taskkill /F`、PowerShell 的 `Remove-Item -Recurse`
和包含凭据参数的命令，风险字段按 shell 区分

## 10. 反馈修复与 OpenSSH 主连接复用

本节自动化入口为 `npm test`，其中 `test/openssh.test.mjs` 使用临时 HOME、临时密钥、loopback
sshd 和测试自有 master，真实 OpenSSH 用例要求 Linux、ssh、sshd、rsync 和 strace 在其他平台保留相应条件状态，不把模拟结果标为本机原生通过；所有清理只针对测试创建的进程和文件

### feedback-readdir-empty-01

让远端 READDIR 连续返回两个合法空页，再返回文件和协议 EOF，生成目录 manifest 预期空页之后的文件进入 count/hash，只有 EOF 结束枚举；持续空页受调用期限限制

### feedback-upload-timeout-01

分别让上传预检 stat、校验 stat、MD5 流和原子上传失败后的 unlink 不返回，使用较短 timeout 预期每个阶段在指定期限内返回，校验失败保留原目标，清理失败通过 cleanupWarning 明确报告

### feedback-read-bom-01

读取起始 BOM 与后续 U+FEFF 并存的 UTF-8、UTF-16LE/BE 文件，覆盖 offset、tail、lineRange、auto 和显式编码，预期只按文件起始位置处理 BOM，非零偏移和后续行开头的 U+FEFF 保留为正文，返回的字节偏移可继续分页

UTF-16 的显式 offset 为奇数字节时，auto 和显式编码均返回字符边界错误；tail 按编码调整到下一个完整字符，binary 保留原始字节

### feedback-partial-transfer-01

先成功上传父目录文件，再让子目录文件失败；另让并发文件中的一项失败，其余已经发出的请求结束预期失败结果保留已知 filesTransferred、bytesTransferred、added/updated/failed，已启动的请求结算后再报告；超时状态可为 unknown，不报告全零成功项

### feedback-terminal-utf8-01

tracked
operation 运行时输出部分多字节字符，先读取，再补齐字符；另一操作在残缺后缀处结束预期运行中可等待后续字节，终态残缺后缀返回明确编码错误并保留原缓冲，不无限返回空页；存储预算截断仍按已有 truncated 和偏移合同处理

### sync-single-file-verify-01

通过仅支持 SFTP 的账号和 OpenSSH
master 分别执行文件与目录目标的双向单文件同步，覆盖空文件、普通内容、Unicode/空格名称及覆盖请求 verify.sha256、owner、mode，以及 Windows 文件 ACL，预期检查实际目标文件并返回 kind=single_file；内容摘要与本地独立 SHA-256 一致，传输和校验状态分开报告 count/deletions/staleFiles 的单文件请求、已知源文件超出哈希预算的请求在传输前拒绝；内容在校验期间变化时明确失败

### sync-symlink-advice-01

下载包含符号链接的目录并请求完整校验，预期 transferSuccess 保留实际结果，校验明确 skipped，说明排除链接后重试下载建议不要求设置仅用于 upload 的 followSymlinks；默认上传和下载均保持原有跳过链接策略

### openssh-reuse-parallel-01

终端预先建立测试 master，通过公开 MCP
stdio 执行 initialize、tools/list 和 tools/call，使用 backend=openssh 与同一 configHost 预期连接返回有效目标、masterReused、masterPid 和 identityStatus=master_trusted；同 alias 两个命令与一次目录同步并发完成，探测、传输和校验均使用该 master，不先建立 ssh2
session 覆盖 cwd、env、输出上限、远端退出 255 和独立 shell，连接结果不把配置与 PID 描述为独立远端身份认证

### openssh-lifecycle-01

同一 alias 启动两项操作，取消其中一项，再断开 alias；保留用户终端命令和另一个 alias；最后关闭测试 MCP 进程预期仅目标操作收到经过 PID/marker 验证的取消请求，同 alias 其余操作在单项取消后继续；alias 断开使其未确认终态的操作为 unknown，用户 master、终端及其他 alias 保持工作 MCP 退出只关闭自身通道和本机子进程组，不发送 -O
exit/stop

### openssh-reuse-only-01

覆盖 master 预先不存在、失效、socket 被替换、alias 配置冲突及观察到的登录用户不符；在预检与实际命令之间让 socket 消失预期明确失败，strace 的 connect 记录只出现已有 AF_UNIX
socket 尝试，不出现 AF_INET/AF_INET6
SSH 连接，sshd 的新认证计数为零；实际复用失败路径执行失败代理，不把连接被防火墙拒绝当作验收成功

### openssh-capability-01

请求 password/key/agent/jumpHost、PTY、forward、独立 SFTP 工具、临时脚本上传或 Windows 组合；同步时移除本机/远端 rsync 或所需 GNU 工具预期在相关副作用之前返回具体能力错误，不转用 ssh2/SFTP，不新建 master；脚本不创建临时远端文件，显式 configPath 保留路径和文件大小校验

## 测试清理

测试结束后删除本次创建的远端和本地测试目录，关闭本次创建的 forward、PTY、operation 和 SSH session

命令超时后如果测试端口仍被监听，先按 PID、命令和测试工作目录确认进程确属本次测试，再终止该进程；无法确认时不得操作

## 附录 A：已知限制 / KNOWN-LIMIT

- forward-idle-timeout-01 / pty-idle-timeout-01：默认 idleTimeout 1h，测试时建议改阈值或跳过等待
- exec-as-user-02 假设目标用户 .bashrc/.zshrc 中含 PATH 修改，否则与 with-loadProfile 输出可能一致
- path-whitelist-01（C.10 SSH_MCP_FILE_OPS_ALLOW_DIRS）：需重启 server 设置环境变量，CC 当前进程内无法直接执行
- sync-shared-sftp-01（D.1）/ sync-parallel-01（D.7）：性能验证依赖深目录或大量文件，跳过
- ssh-config 临时配置必须放 ~/.ssh/ 或 /etc/ssh/ 下（configPath 路径白名单生效，更严格保护已默认开启）
