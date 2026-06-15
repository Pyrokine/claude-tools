/**
 * 命令执行工具组
 *
 * ssh_exec, ssh_exec_as_user, ssh_exec_sudo,
 * ssh_exec_batch, ssh_quick_exec, ssh_exec_parallel
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import * as fileOps from '../file-ops.js'
import { sessionManager } from '../session-manager.js'
import type { ExecResult } from '../types.js'
import { escapeShellArg, formatError, formatResult } from './utils.js' // ========== Schemas ==========

// ========== Schemas ==========

const execSchema = z.object({
    alias: z.string().describe('连接别名'),
    command: z.string().describe('要执行的命令'),
    timeout: z
        .number()
        .optional()
        .describe('超时（毫秒），默认 30000，长时间命令可设更大值如 600000（10 分钟），或用 ssh_pty_start 替代'),
    cwd: z.string().optional().describe('工作目录（可选）'),
    env: z.record(z.string(), z.string()).optional().describe('额外环境变量'),
    pty: z.boolean().optional().describe('是否使用 PTY 模式（用于 top 等交互式命令）'),
    maxOutputSize: z.number().optional().describe('最大输出字符数，超过后截断并返回提示'),
    runAs: z.string().optional().describe('本次命令使用的目标用户，覆盖连接级 runAs'),
    useLoginUser: z.boolean().optional().describe('设为 true 时跳过连接级 runAs，直接以登录用户执行'),
    loadProfile: z.boolean().optional().describe('runAs 执行时是否加载目标用户 shell 配置，默认 true'),
})

const execAsUserSchema = z.object({
    alias: z.string().describe('连接别名'),
    command: z.string().describe('要执行的命令'),
    targetUser: z.string().optional().describe('目标用户名，不传时使用连接级 runAs'),
    timeout: z.number().optional().describe('超时（毫秒）'),
    cwd: z.string().optional().describe('工作目录（可选）'),
    env: z.record(z.string(), z.string()).optional().describe('额外环境变量'),
    maxOutputSize: z.number().optional().describe('最大输出字符数，超过后截断并返回提示'),
    loadProfile: z
        .boolean()
        .optional()
        .describe('是否加载目标用户的 shell 配置（默认 true），profile 加载慢导致超时时设为 false'),
})

const execSudoSchema = z.object({
    alias: z.string().describe('连接别名'),
    command: z.string().describe('要执行的命令'),
    sudoPassword: z.string().optional().describe('sudo 密码（如果需要）'),
    timeout: z.number().optional().describe('超时（毫秒）'),
    maxOutputSize: z.number().optional().describe('最大输出字符数，超过后截断并返回提示'),
})

const execBatchSchema = z.object({
    alias: z.string().describe('连接别名'),
    commands: z.array(z.string()).describe('命令列表'),
    stopOnError: z.boolean().optional().describe('遇到错误是否停止，默认 true'),
    timeout: z.number().optional().describe('每条命令的超时（毫秒）'),
})

const quickExecSchema = z.object({
    host: z.string().describe('服务器地址'),
    user: z.string().describe('用户名'),
    command: z.string().describe('要执行的命令'),
    password: z.string().optional().describe('密码'),
    keyPath: z.string().optional().describe('密钥路径'),
    port: z.number().optional().describe('端口'),
    timeout: z.number().optional().describe('超时（毫秒）'),
})

const execParallelSchema = z.object({
    aliases: z.array(z.string()).describe('连接别名列表'),
    command: z.string().describe('要执行的命令'),
    timeout: z.number().optional().describe('每个命令的超时（毫秒），默认 30000'),
})

const execScriptSchema = z.object({
    alias: z.string().describe('连接别名'),
    script: z.string().describe('脚本内容'),
    interpreter: z.string().optional().describe('解释器，默认 bash'),
    targetUser: z.string().optional().describe('目标用户名，优先级高于 runAs'),
    runAs: z.string().optional().describe('本次脚本使用的目标用户'),
    cwd: z.string().optional().describe('工作目录（可选）'),
    env: z.record(z.string(), z.string()).optional().describe('额外环境变量'),
    timeout: z.number().optional().describe('超时（毫秒）'),
    keepScript: z.boolean().optional().describe('是否保留远端临时脚本，默认 false'),
    maxOutputSize: z.number().optional().describe('最大输出字符数，超过后截断并返回提示'),
})

// ========== Handlers ==========

type CommandRisk = {
    level: 'medium' | 'high'
    categories: string[]
    signals: string[]
    suggestion: string
}

function pushRisk(categories: Set<string>, signals: string[], category: string, signal: string): void {
    categories.add(category)
    signals.push(signal)
}

function classifyCommandRisk(command: string): CommandRisk | undefined {
    const signals: string[] = []
    const categories = new Set<string>()
    const pipeCount = (command.match(/\|/g) ?? []).length
    const lowerCommand = command.toLowerCase()
    if (command.length > 500) {
        pushRisk(categories, signals, 'long-running', 'long_command')
    }
    if (/\bgrep\s+(?:-\S*R|--recursive)\b/.test(command)) {
        pushRisk(categories, signals, 'long-running', 'recursive_grep')
    }
    if (/\bfind\b/.test(command) && !/\s-maxdepth\s+\d+/.test(command)) {
        pushRisk(categories, signals, 'long-running', 'unbounded_find')
    }
    if (/\b(?:python|python3|node|perl|ruby)\b/.test(command)) {
        pushRisk(categories, signals, 'script-execution', 'interpreter_script')
    }
    if (/\bsleep\s+\d{2,}\b/.test(command) || /\b(?:tail\s+-f|journalctl\s+-f|watch|top|htop)\b/.test(command)) {
        pushRisk(categories, signals, 'long-running', 'long_running')
    }
    if (pipeCount >= 3) {
        pushRisk(categories, signals, 'long-running', 'long_pipeline')
    }
    if (/(?:^|[;&])\s*[^;&]+&\s*(?:$|[;&])/.test(command)) {
        pushRisk(categories, signals, 'process-control', 'background_task')
    }
    if (/\b(?:rm\s+-[a-zA-Z]*r|dd\s+if=|mkfs|fdisk|parted|shutdown|reboot)\b/.test(lowerCommand)) {
        pushRisk(categories, signals, 'destructive', 'destructive_command')
    }
    if (/\b(?:kill|pkill|killall)\b/.test(lowerCommand)) {
        pushRisk(categories, signals, 'process-control', 'process_control')
    }
    if (/\b(?:systemctl|service|docker|kubectl)\s+(?:restart|stop|kill|delete|rm|down)\b/.test(lowerCommand)) {
        pushRisk(categories, signals, 'service-control', 'service_control')
    }
    if (/\b(?:password|passwd|token|authorization|cookie|secret|private[_-]?key)\b/i.test(command)) {
        pushRisk(categories, signals, 'credential-bearing', 'credential_bearing')
    }
    if (/\bsu\s+-?\s*[a-zA-Z_][a-zA-Z0-9_-]*\s+-c\b/.test(command)) {
        pushRisk(categories, signals, 'user-switch', 'direct_su_command')
    }
    if (signals.length === 0) {
        return undefined
    }
    const highCategories = new Set(['destructive', 'process-control', 'service-control', 'long-running'])
    const level = Array.from(categories).some((category) => highCategories.has(category)) ? 'high' : 'medium'
    return {
        level,
        categories: Array.from(categories),
        signals,
        suggestion: signals.includes('direct_su_command')
            ? '建议使用 ssh_exec 的 runAs 参数或 ssh_exec_as_user，避免手写 su 命令造成引用和环境加载差异'
            : level === 'high'
              ? '考虑用 ssh_exec_script、ssh_pty_start，或把输出重定向到远端文件后用 ssh_read_file 分块读取'
              : '如输出较大，请设置 maxOutputSize 或重定向到远端文件后分块读取',
    }
}

async function handleExec(args: z.infer<typeof execSchema>) {
    try {
        const result = await sessionManager.exec(args.alias, args.command, {
            timeout: args.timeout,
            cwd: args.cwd,
            env: args.env,
            pty: args.pty,
            maxOutputSize: args.maxOutputSize,
            runAs: args.runAs,
            useLoginUser: args.useLoginUser,
            loadProfile: args.loadProfile,
        })
        return formatResult({ ...result, commandRisk: classifyCommandRisk(args.command) })
    } catch (error) {
        return formatError(error)
    }
}

async function handleExecAsUser(args: z.infer<typeof execAsUserSchema>) {
    try {
        if (args.targetUser) {
            const result = await sessionManager.execAsUser(args.alias, args.command, args.targetUser, {
                timeout: args.timeout,
                cwd: args.cwd,
                env: args.env,
                maxOutputSize: args.maxOutputSize,
                loadProfile: args.loadProfile,
            })
            return formatResult({ ...result, commandRisk: classifyCommandRisk(args.command) })
        }
        const result = await sessionManager.exec(args.alias, args.command, {
            timeout: args.timeout,
            cwd: args.cwd,
            env: args.env,
            maxOutputSize: args.maxOutputSize,
            loadProfile: args.loadProfile,
        })
        return formatResult({ ...result, commandRisk: classifyCommandRisk(args.command) })
    } catch (error) {
        return formatError(error)
    }
}

async function handleExecSudo(args: z.infer<typeof execSudoSchema>) {
    try {
        const result = await sessionManager.execSudo(args.alias, args.command, args.sudoPassword, {
            timeout: args.timeout,
            maxOutputSize: args.maxOutputSize,
        })
        return formatResult(result)
    } catch (error) {
        return formatError(error)
    }
}

async function handleExecBatch(args: z.infer<typeof execBatchSchema>) {
    try {
        const stopOnError = args.stopOnError !== false
        type BatchEntry =
            | ({ index: number; command: string } & ExecResult)
            | { index: number; command: string; success: false; error: string }
        const results: BatchEntry[] = []

        for (let i = 0; i < args.commands.length; i++) {
            try {
                const execResult = await sessionManager.exec(args.alias, args.commands[i], { timeout: args.timeout })
                results.push({
                    index: i,
                    command: args.commands[i],
                    ...execResult,
                })
                if (execResult.exitCode !== 0 && stopOnError) {
                    break
                }
            } catch (err) {
                results.push({
                    index: i,
                    command: args.commands[i],
                    success: false,
                    error: err instanceof Error ? err.message : String(err),
                })
                if (stopOnError) {
                    break
                }
            }
        }

        return formatResult({
            success: results.every((r) => r.success),
            total: args.commands.length,
            executed: results.length,
            results,
        })
    } catch (error) {
        return formatError(error)
    }
}

async function handleQuickExec(args: z.infer<typeof quickExecSchema>) {
    const tempAlias = `_quick_${Date.now()}`
    try {
        await sessionManager.connect({
            host: args.host,
            port: args.port || 22,
            username: args.user,
            password: args.password,
            privateKeyPath: args.keyPath,
            alias: tempAlias,
        })
        const result = await sessionManager.exec(tempAlias, args.command, { timeout: args.timeout })
        return formatResult(result)
    } catch (error) {
        return formatError(error)
    } finally {
        sessionManager.disconnect(tempAlias)
    }
}

async function handleExecParallel(args: z.infer<typeof execParallelSchema>) {
    try {
        const execPromises = args.aliases.map(async (alias) => {
            try {
                const execResult = await sessionManager.exec(alias, args.command, { timeout: args.timeout })
                return {
                    alias,
                    success: execResult.success,
                    exitCode: execResult.exitCode,
                    stdout: execResult.stdout,
                    stderr: execResult.stderr,
                    duration: execResult.duration,
                }
            } catch (err) {
                return {
                    alias,
                    success: false,
                    error: err instanceof Error ? err.message : String(err),
                }
            }
        })

        const results = await Promise.all(execPromises)
        return formatResult({
            success: results.every((r) => r.success),
            total: args.aliases.length,
            results,
        })
    } catch (error) {
        return formatError(error)
    }
}

async function cleanupRemoteScript(alias: string, remotePath: string): Promise<string | undefined> {
    try {
        const result = await sessionManager.exec(alias, `rm -f ${escapeShellArg(remotePath)}`, {
            timeout: 10000,
            useLoginUser: true,
            maxOutputSize: 4096,
        })
        if (result.success) {
            return undefined
        }
        return result.stderr || result.stdout || `cleanup failed with exit code ${result.exitCode}`
    } catch (error) {
        return error instanceof Error ? error.message : String(error)
    }
}

function validateScriptUser(username: string | undefined): void {
    if (username !== undefined && !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(username)) {
        throw new Error(`Invalid username: ${username}`)
    }
}

function resolveScriptUsers(args: z.infer<typeof execScriptSchema>): { effectiveUser?: string; loginUser?: string } {
    const session = sessionManager.listSessions().find((item) => item.alias === args.alias)
    return {
        effectiveUser: args.targetUser ?? args.runAs ?? session?.runAs,
        loginUser: session?.username,
    }
}

async function prepareRemoteScript(
    alias: string,
    remotePath: string,
    effectiveUser: string | undefined,
    loginUser: string | undefined,
    timeout: number | undefined
): Promise<void> {
    const quotedPath = escapeShellArg(remotePath)
    const ownershipCommand =
        effectiveUser && effectiveUser !== loginUser ? `chown ${escapeShellArg(effectiveUser)} ${quotedPath} && ` : ''
    const result = await sessionManager.exec(alias, `${ownershipCommand}chmod 700 ${quotedPath}`, {
        timeout,
        useLoginUser: true,
        maxOutputSize: 4096,
    })
    if (!result.success) {
        const reason = result.stderr || result.stdout || `exit code ${result.exitCode}`
        throw new Error(`prepare remote script failed: ${reason}`)
    }
}

async function handleExecScript(args: z.infer<typeof execScriptSchema>) {
    let remotePath: string | undefined
    try {
        const interpreter = args.interpreter ?? 'bash'
        const { effectiveUser, loginUser } = resolveScriptUsers(args)
        validateScriptUser(effectiveUser)

        const tempResult = await sessionManager.exec(args.alias, 'mktemp /tmp/mcp-ssh-script.XXXXXX', {
            timeout: args.timeout,
            useLoginUser: true,
            maxOutputSize: 4096,
        })
        remotePath = tempResult.stdout.trim()
        if (!tempResult.success || remotePath.length === 0) {
            return formatResult({ success: false, error: tempResult.stderr || 'mktemp failed' })
        }

        await fileOps.writeFile(args.alias, remotePath, args.script, false)
        await prepareRemoteScript(args.alias, remotePath, effectiveUser, loginUser, args.timeout)

        const command = `${escapeShellArg(interpreter)} ${escapeShellArg(remotePath)}`
        const execOptions = {
            timeout: args.timeout,
            cwd: args.cwd,
            env: args.env,
            maxOutputSize: args.maxOutputSize,
            runAs: args.targetUser ?? args.runAs,
        }
        const result = args.targetUser
            ? await sessionManager.execAsUser(args.alias, command, args.targetUser, execOptions)
            : await sessionManager.exec(args.alias, command, execOptions)
        const cleanupWarning =
            remotePath && args.keepScript !== true ? await cleanupRemoteScript(args.alias, remotePath) : undefined

        return formatResult({
            ...result,
            remotePath: args.keepScript ? remotePath : undefined,
            kept: args.keepScript === true,
            cleanupWarning,
        })
    } catch (error) {
        const cleanupWarning =
            remotePath && args.keepScript !== true ? await cleanupRemoteScript(args.alias, remotePath) : undefined
        if (cleanupWarning) {
            return formatResult({
                success: false,
                error: error instanceof Error ? error.message : String(error),
                cleanupWarning,
            })
        }
        return formatError(error)
    }
}

// ========== Register ==========

export function registerExecTools(server: McpServer): void {
    server.registerTool(
        'ssh_exec',
        {
            description: `在远程服务器执行命令

返回: stdout, stderr, exitCode, duration`,
            inputSchema: execSchema,
        },
        (args) => handleExec(args)
    )

    server.registerTool(
        'ssh_exec_as_user',
        {
            description: `以其他用户身份执行命令（通过 su 切换）

适用场景: SSH 以管理员账号登录，但需要以应用用户执行命令

默认加载目标用户的 shell 配置以获取环境变量，如果 profile 加载耗时过长导致超时，设 loadProfile=false 跳过
支持 bash(.bashrc)、zsh(.zshrc) 及其他 shell(.profile)

示例: ssh_exec_as_user(alias="server", command="whoami", targetUser="appuser")`,
            inputSchema: execAsUserSchema,
        },
        (args) => handleExecAsUser(args)
    )

    server.registerTool(
        'ssh_exec_sudo',
        {
            description: '使用 sudo 执行命令',
            inputSchema: execSudoSchema,
        },
        (args) => handleExecSudo(args)
    )

    server.registerTool(
        'ssh_exec_batch',
        {
            description: `批量执行多条命令，每条命令在独立 SSH channel 中执行，环境变量不共享

如需命令间共享环境（如 export 变量），用分号拼接为单条命令通过 ssh_exec 执行`,
            inputSchema: execBatchSchema,
        },
        (args) => handleExecBatch(args)
    )

    server.registerTool(
        'ssh_quick_exec',
        {
            description: '一次性执行命令（自动连接、执行、断开），适用于单次命令，不需要保持连接',
            inputSchema: quickExecSchema,
        },
        (args) => handleQuickExec(args)
    )

    server.registerTool(
        'ssh_exec_parallel',
        {
            description: `在多个已连接的会话上并行执行同一命令

示例：
- ssh_exec_parallel(aliases=["server1", "server2"], command="uptime")

返回每个主机的执行结果`,
            inputSchema: execParallelSchema,
        },
        (args) => handleExecParallel(args)
    )

    server.registerTool(
        'ssh_exec_script',
        {
            description: '上传远端临时脚本并执行，默认执行后清理脚本',
            inputSchema: execScriptSchema,
        },
        (args) => handleExecScript(args)
    )
}
