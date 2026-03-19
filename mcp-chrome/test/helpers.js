/**
 * MCP 协议测试辅助
 *
 * 封装与 mcp-chrome 的 JSON-RPC 通信
 */

import {spawn} from 'child_process'
import {dirname, resolve} from 'path'
import {fileURLToPath} from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * MCP 客户端：通过 stdio 与 MCP Server 通信
 */
export class McpClient {
    constructor() {
        this.process = null
        this.requestId = 0
        this.pending = new Map()  // id -> {resolve, reject}
        this.buffer = ''
    }

    /**
     * 启动 MCP Server 进程
     */
    async start() {
        const serverPath = resolve(__dirname, '..', 'dist', 'index.js')
        this.process = spawn('node', [serverPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
        })

        // 解析 stdout 的 JSON-RPC 消息
        this.process.stdout.on('data', (chunk) => {
            this.buffer += chunk.toString()
            this._processBuffer()
        })

        // stderr 输出日志（不影响协议）
        this.process.stderr.on('data', (chunk) => {
            // 静默，除非调试
            if (process.env.DEBUG) {
                process.stderr.write(`[server] ${chunk}`)
            }
        })

        this.process.on('exit', (code) => {
            // 拒绝所有 pending 请求
            for (const [, { reject }] of this.pending) {
                reject(new Error(`Server exited with code ${code}`))
            }
            this.pending.clear()
        })

        // 等待进程启动
        await new Promise(resolve => setTimeout(resolve, 1000))
    }

    /**
     * MCP 初始化握手
     */
    async initialize() {
        const result = await this.request('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'mcp-chrome-test', version: '1.0.0' },
        })

        // 发送 initialized 通知
        this.notify('notifications/initialized', {})

        // 等待 Extension 连接
        await new Promise(resolve => setTimeout(resolve, 2000))

        return result
    }

    /**
     * 调用 MCP 工具
     */
    async callTool(name, args = {}) {
        return this.request('tools/call', { name, arguments: args })
    }

    /**
     * 发送 JSON-RPC 请求
     */
    request(method, params) {
        return new Promise((resolve, reject) => {
            const id = ++this.requestId
            this.pending.set(id, { resolve, reject })

            const message = JSON.stringify({
                                               jsonrpc: '2.0',
                                               id,
                                               method,
                                               params,
                                           })

            this._send(message)

            // 超时
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id)
                    reject(new Error(`Request timeout: ${method}`))
                }
            }, 30000)
        })
    }

    /**
     * 发送 JSON-RPC 通知（无 id，无响应）
     */
    notify(method, params) {
        const message = JSON.stringify({
                                           jsonrpc: '2.0',
                                           method,
                                           params,
                                       })
        this._send(message)
    }

    /**
     * 关闭连接
     */
    async close() {
        if (this.process) {
            this.process.kill()
            this.process = null
        }
    }

    // ==================== 内部方法 ====================

    _send(message) {
        const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`
        this.process.stdin.write(header + message)
    }

    _processBuffer() {
        while (true) {
            // 查找 Content-Length 头
            const headerEnd = this.buffer.indexOf('\r\n\r\n')
            if (headerEnd === -1) {
                break
            }

            const header = this.buffer.slice(0, headerEnd)
            const match = header.match(/Content-Length:\s*(\d+)/i)
            if (!match) {
                // 无效头，跳过
                this.buffer = this.buffer.slice(headerEnd + 4)
                continue
            }

            const contentLength = parseInt(match[1])
            const bodyStart = headerEnd + 4
            const bodyEnd = bodyStart + contentLength

            if (this.buffer.length < bodyEnd) {
                break
            }  // 数据不完整

            const body = this.buffer.slice(bodyStart, bodyEnd)
            this.buffer = this.buffer.slice(bodyEnd)

            try {
                const message = JSON.parse(body)
                this._handleMessage(message)
            } catch {
                // 解析失败，忽略
            }
        }
    }

    _handleMessage(message) {
        if (message.id !== undefined && this.pending.has(message.id)) {
            const { resolve, reject } = this.pending.get(message.id)
            this.pending.delete(message.id)

            if (message.error) {
                reject(new Error(message.error.message || JSON.stringify(message.error)))
            } else {
                resolve(message.result)
            }
        }
    }
}

/**
 * 解析工具响应内容
 */
export function parseToolResult(result) {
    if (!result?.content?.length) {
        return null
    }
    const content = result.content[0]
    if (content.type === 'text') {
        try {
            return JSON.parse(content.text)
        } catch {
            return content.text
        }
    }
    if (content.type === 'image') {
        return { type: 'image', data: content.data, mimeType: content.mimeType }
    }
    return content
}

/**
 * 测试结果输出
 */
export class TestReporter {
    constructor() {
        this.results = []
        this.startTime = Date.now()
    }

    pass(name) {
        this.results.push({ name, status: 'PASS' })
        console.log(`  ✓ ${name}`)
    }

    fail(name, error) {
        this.results.push({ name, status: 'FAIL', error: String(error) })
        console.log(`  ✗ ${name}: ${error}`)
    }

    skip(name, reason) {
        this.results.push({ name, status: 'SKIP', reason })
        console.log(`  - ${name} (${reason})`)
    }

    summary() {
        const elapsed = (
            (
                Date.now() - this.startTime
            ) / 1000
        ).toFixed(1)
        const pass = this.results.filter(r => r.status === 'PASS').length
        const fail = this.results.filter(r => r.status === 'FAIL').length
        const skip = this.results.filter(r => r.status === 'SKIP').length
        const total = this.results.length

        console.log('\n' + '='.repeat(50))
        console.log(`Results: ${pass} passed, ${fail} failed, ${skip} skipped / ${total} total (${elapsed}s)`)
        console.log('='.repeat(50))

        if (fail > 0) {
            console.log('\nFailed tests:')
            for (const r of this.results.filter(r => r.status === 'FAIL')) {
                console.log(`  - ${r.name}: ${r.error}`)
            }
        }

        return fail === 0
    }
}
