/**
 * PTY 会话工具组
 *
 * ssh_pty_start, ssh_pty_write, ssh_pty_read, ssh_pty_resize, ssh_pty_close, ssh_pty_list
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {z} from 'zod'
import {sessionManager} from '../session-manager.js'
import {formatError, formatResult} from './utils.js'

// ========== Schemas ==========

const ptyStartSchema = z.object({
                                    alias: z.string().describe('连接别名'),
                                    command: z.string().describe('要执行的命令'),
                                    rows: z.number().optional().describe('终端行数，默认 24'),
                                    cols: z.number().optional().describe('终端列数，默认 80'),
                                    term: z.string().optional().describe('终端类型，默认 xterm-256color'),
                                    cwd: z.string().optional().describe('工作目录'),
                                    env: z.record(z.string()).optional().describe('环境变量'),
                                    bufferSize: z.number().optional().describe('输出缓冲区大小（字节），默认 1MB'),
                                })

const ptyWriteSchema = z.object({
                                    ptyId: z.string().describe('PTY 会话 ID'),
                                    data: z.string().describe('要写入的数据'),
                                })

const ptyReadSchema = z.object({
                                   ptyId: z.string().describe('PTY 会话 ID'),
                                   mode: z.enum(['screen', 'raw']).optional().describe(
                                       '输出模式：screen（当前屏幕）或 raw（原始流），默认 screen'),
                                   clear: z.boolean()
                                           .optional()
                                           .describe('(仅 raw 模式) 读取后是否清空缓冲区，默认 true'),
                               })

const ptyResizeSchema = z.object({
                                     ptyId: z.string().describe('PTY 会话 ID'),
                                     rows: z.number().describe('新的行数'),
                                     cols: z.number().describe('新的列数'),
                                 })

const ptyCloseSchema = z.object({
                                    ptyId: z.string().describe('PTY 会话 ID'),
                                })

const ptyListSchema = z.object({})

// ========== Handlers ==========

async function handlePtyStart(args: z.infer<typeof ptyStartSchema>) {
    try {
        const ptyId = await sessionManager.ptyStart(
            args.alias,
            args.command,
            {
                rows: args.rows,
                cols: args.cols,
                term: args.term,
                cwd: args.cwd,
                env: args.env,
                bufferSize: args.bufferSize,
            },
        )
        return formatResult({
                                success: true,
                                ptyId,
                                message: `PTY session started: ${args.command}`,
                            })
    } catch (error) {
        return formatError(error)
    }
}

async function handlePtyWrite(args: z.infer<typeof ptyWriteSchema>) {
    try {
        const success = sessionManager.ptyWrite(args.ptyId, args.data)
        return formatResult({success, ptyId: args.ptyId})
    } catch (error) {
        return formatError(error)
    }
}

async function handlePtyRead(args: z.infer<typeof ptyReadSchema>) {
    try {
        const readResult = sessionManager.ptyRead(
            args.ptyId,
            {
                mode: args.mode || 'screen',
                clear: args.clear !== false,
            },
        )
        return formatResult({
                                success: true,
                                ptyId: args.ptyId,
                                mode: args.mode || 'screen',
                                ...readResult,
                            })
    } catch (error) {
        return formatError(error)
    }
}

async function handlePtyResize(args: z.infer<typeof ptyResizeSchema>) {
    try {
        const success = sessionManager.ptyResize(args.ptyId, args.rows, args.cols)
        return formatResult({success, ptyId: args.ptyId})
    } catch (error) {
        return formatError(error)
    }
}

async function handlePtyClose(args: z.infer<typeof ptyCloseSchema>) {
    try {
        const success = sessionManager.ptyClose(args.ptyId)
        return formatResult({
                                success,
                                message: success
                                         ? `PTY session closed: ${args.ptyId}`
                                         : `PTY session not found: ${args.ptyId}`,
                            })
    } catch (error) {
        return formatError(error)
    }
}

async function handlePtyList() {
    try {
        const ptySessions = sessionManager.ptyList()
        return formatResult({
                                success: true,
                                count: ptySessions.length,
                                sessions: ptySessions,
                            })
    } catch (error) {
        return formatError(error)
    }
}

// ========== Register ==========

export function registerPtyTools(server: McpServer): void {
    server.registerTool('ssh_pty_start', {
        description: `启动持久化 PTY 会话，支持 top、htop、tmux 等交互式命令。

特点：
- 输出缓冲区持续收集数据
- 可通过 ssh_pty_read 轮询读取最新输出
- 可通过 ssh_pty_write 发送按键/命令

示例：
- 启动 top: ssh_pty_start(alias="server", command="top")
- 启动 tmux: ssh_pty_start(alias="server", command="tmux new -s work")`,
        inputSchema: ptyStartSchema,
    }, (args) => handlePtyStart(args))

    server.registerTool('ssh_pty_write', {
        description: `向 PTY 写入数据（按键、命令）。

常用控制序列：
- 回车: "\\r" 或 "\\n"
- Ctrl+C: "\\x03"
- Ctrl+D: "\\x04"
- Ctrl+Z: "\\x1a"
- 上箭头: "\\x1b[A"
- 下箭头: "\\x1b[B"

示例：
- 发送命令: ssh_pty_write(ptyId="xxx", data="ls -la\\r")
- 退出 top: ssh_pty_write(ptyId="xxx", data="q")`,
        inputSchema: ptyWriteSchema,
    }, (args) => handlePtyWrite(args))

    server.registerTool('ssh_pty_read', {
        description: `读取 PTY 输出。

两种模式：
- screen（默认）：返回当前屏幕内容（解析后的纯文本，适合 top/btop/htop 等全屏刷新工具）
- raw：返回原始 ANSI 流（包含转义序列，适合需要完整终端数据的场景）

示例：
- 获取 top 当前画面: ssh_pty_read(ptyId="xxx")
- 获取原始输出: ssh_pty_read(ptyId="xxx", mode="raw")`,
        inputSchema: ptyReadSchema,
    }, (args) => handlePtyRead(args))

    server.registerTool('ssh_pty_resize', {
        description: '调整 PTY 窗口大小',
        inputSchema: ptyResizeSchema,
    }, (args) => handlePtyResize(args))

    server.registerTool('ssh_pty_close', {
        description: '关闭 PTY 会话',
        inputSchema: ptyCloseSchema,
    }, (args) => handlePtyClose(args))

    server.registerTool('ssh_pty_list', {
        description: '列出所有 PTY 会话',
        inputSchema: ptyListSchema,
    }, () => handlePtyList())
}
