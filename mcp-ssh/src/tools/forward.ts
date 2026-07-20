/**
 * 端口转发工具组
 *
 * ssh_forward_local, ssh_forward_remote, ssh_forward_close, ssh_forward_list
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { sessionManager } from '../session-manager.js'
import { formatError, formatResult } from './utils.js'

// ========== Schemas ==========

// 仅允许 loopback 地址监听，防止把端口暴露到外网
const loopbackHostSchema = z
    .string()
    .refine((s) => s === '127.0.0.1' || s === '::1' || s === 'localhost', {
        message: '仅支持 loopback 地址（127.0.0.1 / ::1 / localhost），禁止 0.0.0.0 等公网监听',
    })
    .default('127.0.0.1')

const forwardLocalSchema = z.object({
    alias: z.string().describe('连接别名'),
    localPort: z.number().describe('本地监听端口'),
    remoteHost: z.string().describe('远程目标主机'),
    remotePort: z.number().describe('远程目标端口'),
    localHost: loopbackHostSchema.describe(
        '本地监听地址，仅允许 loopback（127.0.0.1 / ::1 / localhost），默认 127.0.0.1'
    ),
})

const forwardRemoteSchema = z.object({
    alias: z.string().describe('连接别名'),
    remotePort: z.number().int().min(0).max(65535).describe('远程监听端口，传 0 时由服务器动态分配'),
    localHost: z.string().describe('本地目标地址'),
    localPort: z.number().describe('本地目标端口'),
    remoteHost: loopbackHostSchema.describe(
        '远程监听地址，仅允许 loopback（127.0.0.1 / ::1 / localhost），默认 127.0.0.1'
    ),
})

const forwardCloseSchema = z.object({
    forwardId: z.string().describe('端口转发 ID'),
    mode: z.enum(['graceful', 'force']).optional().describe('关闭模式，默认 graceful；force 会销毁活跃连接'),
    timeoutMs: z.number().int().positive().max(60000).optional().describe('等待底层 listener 释放的超时，默认 5000ms'),
})

const forwardListSchema = z.object({})

// ========== Handlers ==========

async function handleForwardLocal(args: z.infer<typeof forwardLocalSchema>) {
    try {
        const { forwardId, localPort } = await sessionManager.forwardLocal(
            args.alias,
            args.localPort,
            args.remoteHost,
            args.remotePort,
            args.localHost
        )
        return formatResult({
            success: true,
            forwardId,
            type: 'local',
            localPort,
            message: `Local forward: ${args.localHost}:${localPort} -> ${args.remoteHost}:${args.remotePort}`,
        })
    } catch (error) {
        return formatError(error)
    }
}

async function handleForwardRemote(args: z.infer<typeof forwardRemoteSchema>) {
    try {
        const { forwardId, remotePort } = await sessionManager.forwardRemote(
            args.alias,
            args.remotePort,
            args.localHost,
            args.localPort,
            args.remoteHost
        )
        return formatResult({
            success: true,
            forwardId,
            type: 'remote',
            remotePort,
            message: `Remote forward: ${args.remoteHost}:${remotePort} -> ${args.localHost}:${args.localPort}`,
        })
    } catch (error) {
        return formatError(error)
    }
}

async function handleForwardClose(args: z.infer<typeof forwardCloseSchema>) {
    try {
        const result = await sessionManager.forwardClose(args.forwardId, {
            mode: args.mode,
            timeoutMs: args.timeoutMs,
        })
        return formatResult({
            ...result,
            message: result.success ? `Forward closed: ${args.forwardId}` : `Forward close failed: ${args.forwardId}`,
        })
    } catch (error) {
        return formatError(error)
    }
}

async function handleForwardList() {
    try {
        const forwards = sessionManager.forwardList()
        return formatResult({
            success: true,
            count: forwards.length,
            forwards,
        })
    } catch (error) {
        return formatError(error)
    }
}

// ========== Register ==========

export function registerForwardTools(server: McpServer): void {
    server.registerTool(
        'ssh_forward_local',
        {
            description: `创建本地端口转发（类似 ssh -L）

本地监听指定端口，将连接转发到远程主机

用途：访问远程内网服务
示例：ssh_forward_local(alias="server", localPort=8080, remoteHost="<service-host>", remotePort=80)
效果：访问本地 localhost:8080 会转发到远程服务 <service-host>:80`,
            inputSchema: forwardLocalSchema,
        },
        (args) => handleForwardLocal(args)
    )

    server.registerTool(
        'ssh_forward_remote',
        {
            description: `创建远程端口转发（类似 ssh -R）

远程监听指定端口，将连接转发到本地

用途：将本地服务暴露到远程
示例：ssh_forward_remote(alias="server", remotePort=8080, localHost="127.0.0.1", localPort=3000)
效果：远程访问 localhost:8080 会转发到本地的 127.0.0.1:3000
传 remotePort=0 时由服务器动态分配端口，返回结果中的 remotePort 是实际监听端口`,
            inputSchema: forwardRemoteSchema,
        },
        (args) => handleForwardRemote(args)
    )

    server.registerTool(
        'ssh_forward_close',
        {
            description: `关闭端口转发

默认 graceful 模式，等待底层 listener 确认释放后才返回成功。force 模式会先销毁活跃连接。
关闭失败或超时时保留 forward 状态，可使用同一 forwardId 重试。`,
            inputSchema: forwardCloseSchema,
        },
        (args) => handleForwardClose(args)
    )

    server.registerTool(
        'ssh_forward_list',
        {
            description: '列出所有端口转发',
            inputSchema: forwardListSchema,
        },
        () => handleForwardList()
    )
}
