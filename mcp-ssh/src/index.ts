#!/usr/bin/env node
/**
 * SSH MCP Pro - Main Server Entry
 *
 * A comprehensive SSH MCP Server for Claude Code
 *
 * Features:
 * - Multiple authentication methods (password, key, agent)
 * - Connection pooling with keepalive
 * - Session persistence
 * - Command execution (exec, sudo, su)
 * - File operations (upload, download, read, write)
 * - Environment configuration
 * - Jump host support
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import {
    registerConnectionTools,
    registerExecTools,
    registerFileTools,
    registerForwardTools,
    registerPtyTools,
} from './tools/index.js'

const server = new McpServer(
    { name: 'ssh-mcp-pro', version: '1.2.2' },
    { capabilities: { tools: {} } },
)

registerConnectionTools(server)
registerExecTools(server)
registerFileTools(server)
registerPtyTools(server)
registerForwardTools(server)

async function main() {
    // 防止父进程退出后成为孤儿进程持续占用 CPU
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
    process.stdin.on('end', () => process.exit(0))
    process.stdout.on('error', () => process.exit(0))
    process.stderr.on('error', () => process.exit(0))

    const transport = new StdioServerTransport()
    await server.connect(transport)
    console.error('SSH MCP Pro server started')
}

main().catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
})
