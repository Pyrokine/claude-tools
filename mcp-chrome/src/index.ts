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
import { getControlledTempRoot } from './core/utils.js'
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
    const server = new McpServer(
        { name: 'mcp-chrome', version: pkg.version },
        {
            capabilities: { tools: {} },
            instructions: [
                '常规网页浏览、页面交互和文件上传优先使用 mcp-chrome；',
                '文件上传调用 input 的 upload 事件，files 支持绝对、相对及 ~/ 路径，沿用当前页面和 Extension/CDP 连接；',
                'Chrome DevTools 用于浏览器或扩展诊断，以及本服务未覆盖的明确任务；',
                '先 browse list，按 metadata.taskHint/note/origin 选择合适页面，后台 attach 复用；',
                '确无合适页才 manage newPage，并设置 taskHint 为可读任务名，note 写明临时、产物或可复用用途；newPage 始终创建新页；',
                '默认在现有普通窗口后台创建，按可信任务分组；原生分组仅 Extension 支持；',
                '任务完成后，仅用已有 close/release 处理明确页面集合，默认只关闭本任务 origin=created 且 note 明确临时的页；',
                '保留 adopted/unknown、产物、可复用测试页和混合用户组，释放本任务临时取得且已不用的权限；',
                '显式授权关闭仍沿原受控页合同执行；断线与闲置不关闭页面',
            ].join(''),
        }
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
    try {
        await getControlledTempRoot('mcp-chrome')
    } catch (error) {
        console.warn('[mcp-chrome] 受控临时目录初始化失败:', error)
    }

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
