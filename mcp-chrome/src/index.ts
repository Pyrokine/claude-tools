#!/usr/bin/env node

/**
 * mcp-chrome - 浏览器自动化 MCP Server
 *
 * 基于 Chrome DevTools Protocol (CDP) 的浏览器自动化工具
 *
 * 特点：
 * - 8 个精简工具（browse、input、extract、wait、cookies、logs、evaluate、manage）
 * - 可访问性树定位（稳定、语义化）
 * - 内置反检测（指纹伪装、CDP 痕迹清理）
 * - 事件序列模型（支持任意键鼠组合）
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFileSync } from 'node:fs'

import { getUnifiedSession } from './core/index.js'
import {
    registerBrowseTool,
    registerCookiesTool,
    registerEvaluateTool,
    registerExtractTool,
    registerInputTool,
    registerLogsTool,
    registerManageTool,
    registerWaitTool,
} from './tools/index.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string }

/**
 * 创建 MCP Server
 */
function createServer(): McpServer {
    const server = new McpServer({ name: 'mcp-chrome', version: pkg.version }, { capabilities: { tools: {} } })

    registerBrowseTool(server)
    registerInputTool(server)
    registerExtractTool(server)
    registerWaitTool(server)
    registerCookiesTool(server)
    registerLogsTool(server)
    registerEvaluateTool(server)
    registerManageTool(server)

    return server
}

/**
 * 清理资源
 */
async function cleanup(): Promise<void> {
    try {
        // 关闭统一会话（包括 Extension 和 CDP）
        await getUnifiedSession().close()
    } catch {
        // 忽略清理错误
    }
}

/**
 * 主函数
 */
async function main(): Promise<void> {
    // 全局错误兜底：防止未捕获的异常/rejection 杀死进程
    // 检测 EPIPE：父进程（Claude Code）退出后 stdio 断开，写日志会持续 EPIPE 形成死循环
    process.on('uncaughtException', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') {
            process.exit(0)
        }
        try {
            console.error('[MCP] Uncaught exception:', error)
        } catch {
            process.exit(1)
        }
    })
    process.on('unhandledRejection', (reason) => {
        try {
            console.error('[MCP] Unhandled rejection:', reason)
        } catch {
            process.exit(1)
        }
    })

    // 启动 Extension HTTP/WebSocket 服务器
    await getUnifiedSession().startExtensionServer()

    const server = createServer()
    const transport = new StdioServerTransport()

    await server.connect(transport)

    // 父进程退出时 stdin 关闭，主动退出防止成为孤儿进程
    process.stdin.on('end', async () => {
        await cleanup()
        process.exit(0)
    })

    // stdout/stderr 写入失败（EPIPE）时直接退出
    process.stdout.on('error', () => process.exit(0))
    process.stderr.on('error', () => process.exit(0))

    // 优雅退出
    process.on('SIGINT', async () => {
        await cleanup()
        await server.close()
        process.exit(0)
    })

    process.on('SIGTERM', async () => {
        await cleanup()
        await server.close()
        process.exit(0)
    })
}

main().catch(async (error) => {
    console.error('启动失败:', error)
    await cleanup()
    process.exit(1)
})
