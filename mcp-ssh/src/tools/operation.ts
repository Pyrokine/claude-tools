import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
    DEFAULT_OPERATION_MAX_OUTPUT_BYTES,
    DEFAULT_OPERATION_READ_BYTES,
    DEFAULT_OPERATION_RETENTION_MS,
    HARD_OPERATION_MAX_OUTPUT_BYTES,
    HARD_OPERATION_READ_BYTES,
    MAX_OPERATION_RETENTION_MS,
} from '../operation-manager.js'
import { sessionManager } from '../session-manager.js'
import { formatError, formatResult } from './utils.js'

const operationStartSchema = z.object({
    alias: z.string().describe('连接别名'),
    command: z.string().describe('要在远端跟踪执行的命令'),
    cwd: z.string().optional().describe('工作目录（可选）'),
    env: z.record(z.string(), z.string()).optional().describe('额外环境变量'),
    runAs: z.string().optional().describe('本次命令使用的目标用户，覆盖连接级 runAs'),
    useLoginUser: z.boolean().optional().describe('设为 true 时跳过连接级 runAs，直接以登录用户执行'),
    loadProfile: z.boolean().optional().describe('runAs 执行时是否加载目标用户 shell 配置，默认 true'),
    maxOutputBytes: z
        .number()
        .int()
        .positive()
        .max(HARD_OPERATION_MAX_OUTPUT_BYTES)
        .optional()
        .describe(
            `内存输出硬上限，默认 ${DEFAULT_OPERATION_MAX_OUTPUT_BYTES} 字节，最大 ${HARD_OPERATION_MAX_OUTPUT_BYTES}`
        ),
    retentionMs: z
        .number()
        .int()
        .positive()
        .max(MAX_OPERATION_RETENTION_MS)
        .optional()
        .describe(
            `完成后的状态保留时间，默认 ${DEFAULT_OPERATION_RETENTION_MS}ms，最大 ${MAX_OPERATION_RETENTION_MS}ms`
        ),
})

const operationIdSchema = z.object({
    operationId: z.string().describe('tracked operation ID'),
})

const operationReadSchema = operationIdSchema.extend({
    stdoutOffset: z.number().int().nonnegative().optional().describe('stdout 起始字节偏移，默认 0'),
    stderrOffset: z.number().int().nonnegative().optional().describe('stderr 起始字节偏移，默认 0'),
    maxBytes: z
        .number()
        .int()
        .positive()
        .max(HARD_OPERATION_READ_BYTES)
        .optional()
        .describe(`本次读取总字节上限，默认 ${DEFAULT_OPERATION_READ_BYTES}，最大 ${HARD_OPERATION_READ_BYTES}`),
})

const operationListSchema = z.object({
    alias: z.string().optional().describe('按连接别名过滤'),
})

async function handleOperationStart(args: z.infer<typeof operationStartSchema>) {
    try {
        const operation = await sessionManager.operationStart(args.alias, args.command, {
            cwd: args.cwd,
            env: args.env,
            runAs: args.runAs,
            useLoginUser: args.useLoginUser,
            loadProfile: args.loadProfile,
            maxOutputBytes: args.maxOutputBytes,
            retentionMs: args.retentionMs,
        })
        return formatResult({ success: true, ...operation })
    } catch (error) {
        return formatError(error)
    }
}

async function handleOperationStatus(args: z.infer<typeof operationIdSchema>) {
    try {
        return formatResult({ success: true, ...sessionManager.operationStatus(args.operationId) })
    } catch (error) {
        return formatError(error)
    }
}

async function handleOperationRead(args: z.infer<typeof operationReadSchema>) {
    try {
        return formatResult({
            success: true,
            ...sessionManager.operationRead(args.operationId, {
                stdoutOffset: args.stdoutOffset,
                stderrOffset: args.stderrOffset,
                maxBytes: args.maxBytes,
            }),
        })
    } catch (error) {
        return formatError(error)
    }
}

async function handleOperationCancel(args: z.infer<typeof operationIdSchema>) {
    try {
        return formatResult(await sessionManager.operationCancel(args.operationId))
    } catch (error) {
        return formatError(error)
    }
}

async function handleOperationList(args: z.infer<typeof operationListSchema>) {
    try {
        const operations = sessionManager.operationList(args.alias)
        return formatResult({ success: true, count: operations.length, operations })
    } catch (error) {
        return formatError(error)
    }
}

export function registerOperationTools(server: McpServer): void {
    server.registerTool(
        'ssh_operation_start',
        {
            description: `启动可跟踪的长时间远端命令

返回不可预测的 operationId。输出保存在有硬上限的内存缓冲区中，完成后按 retentionMs 自动过期。
普通 ssh_exec 的同步和 timeout 行为不变。`,
            inputSchema: operationStartSchema,
        },
        (args) => handleOperationStart(args)
    )

    server.registerTool(
        'ssh_operation_status',
        {
            description: '查询 tracked operation 状态、远端 PID、输出计数和过期时间',
            inputSchema: operationIdSchema,
        },
        (args) => handleOperationStatus(args)
    )

    server.registerTool(
        'ssh_operation_read',
        {
            description: '按字节偏移读取 tracked operation 的有界 stdout/stderr 缓冲区',
            inputSchema: operationReadSchema,
        },
        (args) => handleOperationRead(args)
    )

    server.registerTool(
        'ssh_operation_cancel',
        {
            description: '校验远端 operation marker 后发送 TERM；marker 无法证明时拒绝取消',
            inputSchema: operationIdSchema,
        },
        (args) => handleOperationCancel(args)
    )

    server.registerTool(
        'ssh_operation_list',
        {
            description: '列出未过期的 tracked operations，可按 alias 过滤',
            inputSchema: operationListSchema,
        },
        (args) => handleOperationList(args)
    )
}
