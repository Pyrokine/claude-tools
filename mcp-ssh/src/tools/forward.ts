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
    remotePort: z.number().describe('远程监听端口'),
    localHost: z.string().describe('本地目标地址'),
    localPort: z.number().describe('本地目标端口'),
    remoteHost: loopbackHostSchema.describe(
        '远程监听地址，仅允许 loopback（127.0.0.1 / ::1 / localhost），默认 127.0.0.1'
    ),
})

const forwardCloseSchema = z.object({
    forwardId: z.string().describe('端口转发 ID'),
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
        const forwardId = await sessionManager.forwardRemote(
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
            message: `Remote forward: ${args.remoteHost}:${args.remotePort} -> ${args.localHost}:${args.localPort}`,
        })
    } catch (error) {
        return formatError(error)
    }
}

async function handleForwardClose(args: z.infer<typeof forwardCloseSchema>) {
    try {
        const success = sessionManager.forwardClose(args.forwardId)
        return formatResult({
            success,
            message: success ? `Forward closed: ${args.forwardId}` : `Forward not found: ${args.forwardId}`,
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
示例：ssh_forward_local(alias="server", localPort=8080, remoteHost="10.0.0.1", remotePort=80)
效果：访问本地 localhost:8080 会转发到远程内网的 10.0.0.1:80`,
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
效果：远程访问 localhost:8080 会转发到本地的 127.0.0.1:3000`,
            inputSchema: forwardRemoteSchema,
        },
        (args) => handleForwardRemote(args)
    )

    server.registerTool(
        'ssh_forward_close',
        {
            description: '关闭端口转发',
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
