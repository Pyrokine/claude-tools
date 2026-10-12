/**
 * MCP 协议测试辅助
 *
 * 封装与 mcp-chrome 的 JSON-RPC 通信
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * MCP 客户端：通过 stdio 与 MCP Server 通信
 */
export class McpClient {
    constructor() {
        this.client = null;
        this.transport = null;
    }

    /**
     * 启动 MCP Server 并使用官方 SDK 完成初始化握手
     */
    async start() {
        const serverPath = resolve(__dirname, '..', 'dist', 'index.js');
        const env = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined));
        this.transport = new StdioClientTransport({
            command: process.execPath,
            args: [serverPath],
            env,
            stderr: 'pipe',
        });
        this.transport.stderr?.on('data', (chunk) => {
            if (process.env.DEBUG) {
                process.stderr.write(`[server] ${chunk}`);
            }
        });
        this.client = new Client({ name: 'mcp-chrome-test', version: '1.0.0' });
        await this.client.connect(this.transport);
    }

    /**
     * 返回 SDK 握手结果，并等待 Extension 自动连接
     */
    async initialize() {
        if (!this.client) {
            throw new Error('MCP client has not started');
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return {
            capabilities: this.client.getServerCapabilities(),
            serverInfo: this.client.getServerVersion(),
            instructions: this.client.getInstructions(),
        };
    }

    /**
     * 列出 MCP 工具
     */
    async listTools() {
        if (!this.client) {
            throw new Error('MCP client has not started');
        }
        return this.client.listTools();
    }

    /**
     * 调用 MCP 工具
     */
    async callTool(name, args = {}) {
        if (!this.client) {
            throw new Error('MCP client has not started');
        }
        return this.client.callTool({ name, arguments: args });
    }

    /**
     * 关闭连接
     */
    async close() {
        if (this.client) {
            await this.client.close();
            this.client = null;
            this.transport = null;
        }
    }
}

/**
 * 解析工具响应内容
 */
export function parseToolResult(result) {
    if (!result?.content?.length) {
        return null;
    }
    const content = result.content[0];
    if (content.type === 'text') {
        try {
            return JSON.parse(content.text);
        } catch {
            return content.text;
        }
    }
    if (content.type === 'image') {
        return { type: 'image', data: content.data, mimeType: content.mimeType };
    }
    return content;
}

/**
 * 测试结果输出
 */
export class TestReporter {
    constructor() {
        this.results = [];
        this.startTime = Date.now();
    }

    pass(name) {
        this.results.push({ name, status: 'PASS' });
        console.log(`  ✓ ${name}`);
    }

    fail(name, error) {
        this.results.push({ name, status: 'FAIL', error: String(error) });
        console.log(`  ✗ ${name}: ${error}`);
    }

    skip(name, reason) {
        this.results.push({ name, status: 'SKIP', reason });
        console.log(`  - ${name} (${reason})`);
    }

    summary() {
        const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
        const pass = this.results.filter((r) => r.status === 'PASS').length;
        const fail = this.results.filter((r) => r.status === 'FAIL').length;
        const skip = this.results.filter((r) => r.status === 'SKIP').length;
        const total = this.results.length;

        console.log('\n' + '='.repeat(50));
        console.log(`Results: ${pass} passed, ${fail} failed, ${skip} skipped / ${total} total (${elapsed}s)`);
        console.log('='.repeat(50));

        if (fail > 0) {
            console.log('\nFailed tests:');
            for (const r of this.results.filter((r) => r.status === 'FAIL')) {
                console.log(`  - ${r.name}: ${r.error}`);
            }
        }

        return fail === 0;
    }
}
