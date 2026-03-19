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
    { name: 'ssh-mcp-pro', version: '1.1.2' },
    { capabilities: { tools: {} } },
)

registerConnectionTools(server)
registerExecTools(server)
registerFileTools(server)
registerPtyTools(server)
registerForwardTools(server)

async function main() {
    const transport = new StdioServerTransport()
    await server.connect(transport)
    console.error('SSH MCP Pro server started')
}

main().catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
})
