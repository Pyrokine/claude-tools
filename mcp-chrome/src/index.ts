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

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'

import {getUnifiedSession} from './core/index.js'
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

/**
 * 创建 MCP Server
 */
function createServer(): McpServer {
    const server = new McpServer(
        { name: 'mcp-chrome', version: '1.3.0' },
        { capabilities: { tools: {} } },
    )

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
    process.on('uncaughtException', (error) => {
        console.error('[MCP] Uncaught exception:', error)
    })
    process.on('unhandledRejection', (reason) => {
        console.error('[MCP] Unhandled rejection:', reason)
    })

    // 启动 Extension HTTP/WebSocket 服务器
    await getUnifiedSession().startExtensionServer()

    const server    = createServer()
    const transport = new StdioServerTransport()

    await server.connect(transport)

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
