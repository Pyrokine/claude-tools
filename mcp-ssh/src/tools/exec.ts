/**
 * 命令执行工具组
 *
 * ssh_exec, ssh_exec_as_user, ssh_exec_sudo,
 * ssh_exec_batch, ssh_quick_exec, ssh_exec_parallel
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { sessionManager } from '../session-manager.js'
import type { ExecResult } from '../types.js'
import { formatError, formatResult } from './utils.js' // ========== Schemas ==========

// ========== Schemas ==========

const execSchema = z.object({
    alias: z.string().describe('连接别名'),
    command: z.string().describe('要执行的命令'),
    timeout: z
        .number()
        .optional()
        .describe('超时（毫秒），默认 30000，长时间命令可设更大值如 600000（10 分钟），或用 ssh_pty_start 替代'),
    cwd: z.string().optional().describe('工作目录（可选）'),
    env: z.record(z.string()).optional().describe('额外环境变量'),
    pty: z.boolean().optional().describe('是否使用 PTY 模式（用于 top 等交互式命令）'),
})

const execAsUserSchema = z.object({
    alias: z.string().describe('连接别名'),
    command: z.string().describe('要执行的命令'),
    targetUser: z.string().describe('目标用户名'),
    timeout: z.number().optional().describe('超时（毫秒）'),
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

// ========== Handlers ==========

async function handleExec(args: z.infer<typeof execSchema>) {
    try {
        const result = await sessionManager.exec(args.alias, args.command, {
            timeout: args.timeout,
            cwd: args.cwd,
            env: args.env,
            pty: args.pty,
        })
        return formatResult(result)
    } catch (error) {
        return formatError(error)
    }
}

async function handleExecAsUser(args: z.infer<typeof execAsUserSchema>) {
    try {
        const result = await sessionManager.execAsUser(args.alias, args.command, args.targetUser, {
            timeout: args.timeout,
            loadProfile: args.loadProfile,
        })
        return formatResult(result)
    } catch (error) {
        return formatError(error)
    }
}

async function handleExecSudo(args: z.infer<typeof execSudoSchema>) {
    try {
        const result = await sessionManager.execSudo(args.alias, args.command, args.sudoPassword, {
            timeout: args.timeout,
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

适用场景: SSH 以 root 登录，但需要以其他用户（如 caros）执行命令

默认加载目标用户的 shell 配置以获取环境变量，如果 profile 加载耗时过长导致超时，设 loadProfile=false 跳过
支持 bash(.bashrc)、zsh(.zshrc) 及其他 shell(.profile)

示例: ssh_exec_as_user(alias="server", command="whoami", targetUser="caros")`,
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
}
