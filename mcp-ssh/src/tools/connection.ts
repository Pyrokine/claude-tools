/**
 * 连接管理工具组
 *
 * ssh_connect, ssh_disconnect, ssh_list_sessions, ssh_reconnect, ssh_config_list
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { z } from 'zod'
import { sessionManager } from '../session-manager.js'
import { parseProxyJump, parseSSHConfig } from '../ssh-config.js'
import { expandTilde, formatError, formatResult } from './utils.js'

type ConnectionTemplate = {
    configHost?: string
    host?: string
    user?: string
    username?: string
    password?: string
    keyPath?: string
    privateKeyPath?: string
    port?: number
    alias?: string
    env?: Record<string, string>
    defaultEnv?: Record<string, string>
    runAs?: string
    keepaliveInterval?: number
    readyTimeout?: number
}

function loadTemplates(): Record<string, ConnectionTemplate> {
    const fromEnv = process.env.SSH_MCP_TEMPLATES
    if (fromEnv) {
        return JSON.parse(fromEnv) as Record<string, ConnectionTemplate>
    }

    const filePath = path.join(os.homedir(), '.mcp-ssh', 'templates.json')
    if (!fs.existsSync(filePath)) {
        return {}
    }
    return JSON.parse(fs.readFileSync(expandTilde(filePath), 'utf-8')) as Record<string, ConnectionTemplate>
}

function getTemplate(name?: string): ConnectionTemplate {
    if (!name) {
        return {}
    }
    const templates = loadTemplates()
    const template = templates[name]
    if (!template) {
        const available = Object.keys(templates)
        const suggestion = available.length
            ? `Available templates: ${available.slice(0, 20).join(', ')}`
            : 'No templates found. Define SSH_MCP_TEMPLATES or ~/.mcp-ssh/templates.json'
        throw new Error(`Template '${name}' not found. ${suggestion}`)
    }
    return template
}

function mergeEnv(
    templateEnv: Record<string, string> | undefined,
    argsEnv: Record<string, string> | undefined
): Record<string, string> | undefined {
    const merged = { ...templateEnv, ...argsEnv }
    return Object.keys(merged).length > 0 ? merged : undefined
}

// ========== Schemas ==========

const connectSchema = z.object({
    template: z.string().optional().describe('连接模板名，从 SSH_MCP_TEMPLATES 或 ~/.mcp-ssh/templates.json 读取'),
    configHost: z.string().optional().describe('使用 ~/.ssh/config 中的 Host 配置（推荐）'),
    configPath: z.string().optional().describe('SSH 配置文件路径（默认 ~/.ssh/config）'),
    host: z.string().optional().describe('服务器地址（使用 configHost 时可省略）'),
    user: z.string().optional().describe('用户名（使用 configHost 时可省略）'),
    password: z.string().optional().describe('密码'),
    keyPath: z.string().optional().describe('SSH 私钥路径'),
    port: z.number().optional().describe('SSH 端口，默认 22'),
    alias: z.string().optional().describe('连接别名（可选，默认使用 configHost 或 host）'),
    env: z.record(z.string(), z.string()).optional().describe('环境变量'),
    defaultEnv: z.record(z.string(), z.string()).optional().describe('连接级默认环境变量'),
    runAs: z.string().optional().describe('连接级默认执行用户，后续 ssh_exec 默认以该用户执行'),
    keepaliveInterval: z.number().int().positive().optional().describe('心跳间隔（毫秒），默认 30000'),
    readyTimeout: z
        .number()
        .int()
        .positive()
        .max(600000)
        .optional()
        .describe('等待 SSH ready 的超时（毫秒），默认 30000'),
    jumpHost: z
        .object({
            host: z.string().describe('跳板机地址'),
            user: z.string().describe('跳板机用户名'),
            password: z.string().optional().describe('跳板机密码'),
            keyPath: z.string().optional().describe('跳板机私钥路径'),
            port: z.number().optional().describe('跳板机端口，默认 22'),
            readyTimeout: z
                .number()
                .int()
                .positive()
                .max(600000)
                .optional()
                .describe('跳板机等待 SSH ready 的超时（毫秒），默认继承顶层 readyTimeout'),
        })
        .optional()
        .describe('跳板机配置'),
})

const disconnectSchema = z.object({
    alias: z.string().describe('连接别名'),
})

const sessionFieldSchema = z.enum([
    'alias',
    'identity',
    'runAs',
    'connected',
    'lastUsedAt',
    'host',
    'port',
    'username',
    'authMethod',
    'connectedAt',
    'hasJumpHost',
])

const listSessionsSchema = z.object({
    detail: z.boolean().optional().describe('返回不含 keyPath 的连接详情'),
    fields: z.array(sessionFieldSchema).max(12).optional().describe('只返回指定字段；任何模式都不返回 keyPath'),
})

const reconnectSchema = z.object({
    alias: z.string().describe('连接别名'),
})

const configListSchema = z.object({
    configPath: z.string().optional().describe('SSH 配置文件路径（默认 ~/.ssh/config）'),
})

// ========== Handlers ==========

async function handleConnect(args: z.infer<typeof connectSchema>) {
    try {
        const template = getTemplate(args.template)
        const configHost = args.configHost ?? template.configHost
        let host = args.host ?? template.host
        let user = args.user ?? template.user ?? template.username
        let port = args.port ?? template.port
        let keyPath = args.keyPath ?? template.keyPath ?? template.privateKeyPath
        const password = args.password ?? template.password
        const requestedAlias = args.alias ?? template.alias ?? configHost
        const runAs = args.runAs ?? template.runAs
        const defaultEnv = mergeEnv(template.defaultEnv, args.defaultEnv)
        const env = mergeEnv(template.env, args.env)
        const keepaliveInterval = args.keepaliveInterval ?? template.keepaliveInterval
        const readyTimeout = args.readyTimeout ?? template.readyTimeout
        let jumpHostResolved:
            | {
                  host: string
                  port: number
                  username: string
                  password?: string
                  privateKeyPath?: string
              }
            | undefined

        if (configHost) {
            const allHosts = parseSSHConfig(args.configPath)
            const hostConfig = allHosts.find((h) => h.host === configHost)
            if (!hostConfig) {
                return formatResult({
                    success: false,
                    error: `Host '${configHost}' not found in SSH config`,
                    candidates: allHosts.map((item) => item.host).slice(0, 20),
                    suggestion: '调用 ssh_config_list 查看完整 Host 列表，或直接传 host/user/port',
                })
            }
            // 显式参数优先于 config 值
            host = host || hostConfig.hostName || hostConfig.host
            user = user || hostConfig.user
            port = port || hostConfig.port
            keyPath = keyPath || hostConfig.identityFile

            // 解析 ProxyJump（支持 user@host:port 格式）
            if (hostConfig.proxyJump) {
                const parsed = parseProxyJump(hostConfig.proxyJump)
                if (parsed) {
                    // 先尝试在 config 中查找对应的 Host
                    const jumpHostConfig = allHosts.find((h) => h.host === parsed.host)
                    if (jumpHostConfig) {
                        // 使用 config 中的配置，但 parsed 的 user/port 优先
                        const jumpUser = parsed.user || jumpHostConfig.user
                        if (!jumpUser) {
                            return formatResult({
                                success: false,
                                error: `ProxyJump '${parsed.host}' is missing user`,
                                suggestion: '在 ProxyJump 中使用 user@host，或为跳板机 Host 配置 User',
                            })
                        }
                        jumpHostResolved = {
                            host: jumpHostConfig.hostName || jumpHostConfig.host,
                            port: parsed.port || jumpHostConfig.port || 22,
                            username: jumpUser,
                            privateKeyPath: jumpHostConfig.identityFile,
                        }
                    } else {
                        // 直接使用 parsed 的值
                        if (!parsed.user) {
                            return formatResult({
                                success: false,
                                error: `ProxyJump '${parsed.host}' is missing user`,
                                suggestion: '在 ProxyJump 中使用 user@host，或为跳板机 Host 配置 User',
                            })
                        }
                        jumpHostResolved = {
                            host: parsed.host,
                            port: parsed.port || 22,
                            username: parsed.user,
                        }
                    }
                }
            }
        }

        if (!host || !user) {
            return formatResult({
                success: false,
                error: 'host and user are required (either directly or via configHost)',
            })
        }

        // 手动指定的 jumpHost 优先级高于 ProxyJump
        const jumpHost = args.jumpHost
            ? {
                  host: args.jumpHost.host,
                  port: args.jumpHost.port || 22,
                  username: args.jumpHost.user,
                  password: args.jumpHost.password,
                  privateKeyPath: args.jumpHost.keyPath,
                  readyTimeout: args.jumpHost.readyTimeout ?? readyTimeout,
              }
            : jumpHostResolved

        const finalPort = port || 22
        const finalAlias = requestedAlias || `${user}@${host}:${finalPort}`
        const identity = `${user}@${host}:${finalPort}`
        const sessionsBeforeConnect = sessionManager.listSessionDetails()
        const reused = sessionsBeforeConnect.some((session) => session.alias === finalAlias && session.connected)
        const reusableSessions = sessionsBeforeConnect
            .filter((session) => session.identity === identity && session.alias !== finalAlias && session.connected)
            .map((session) => ({ alias: session.alias, runAs: session.runAs, connectedAt: session.connectedAt }))
        const alias = await sessionManager.connect({
            host,
            port: finalPort,
            username: user,
            password,
            privateKeyPath: keyPath,
            alias: requestedAlias,
            template: args.template,
            runAs,
            defaultEnv,
            env,
            keepaliveInterval,
            readyTimeout,
            jumpHost,
        })
        return formatResult({
            success: true,
            alias,
            reused,
            identity,
            loginUser: user,
            runAs,
            host,
            port: finalPort,
            defaultEnvKeys: defaultEnv ? Object.keys(defaultEnv) : [],
            envKeys: env ? Object.keys(env) : [],
            reusableSessions,
            suggestion:
                reusableSessions.length > 0
                    ? '已有同 identity 的连接，可直接复用 reusableSessions 中的 alias'
                    : undefined,
            message: `Connected to ${identity}${jumpHost ? ' via jump host' : ''}`,
        })
    } catch (error) {
        return formatError(error)
    }
}

async function handleDisconnect(args: z.infer<typeof disconnectSchema>) {
    try {
        const success = sessionManager.disconnect(args.alias)
        return formatResult({
            success,
            message: success ? `Disconnected from ${args.alias}` : `Session ${args.alias} not found`,
        })
    } catch (error) {
        return formatError(error)
    }
}

async function handleListSessions(args: z.infer<typeof listSessionsSchema>) {
    try {
        const sessions =
            args.detail || args.fields ? sessionManager.listSessionDetails() : sessionManager.listSessions()
        const selected = args.fields
            ? sessions.map((session) => {
                  const record = session as unknown as Record<string, unknown>
                  return Object.fromEntries(
                      args.fields!.filter((field) => field in record).map((field) => [field, record[field]])
                  )
              })
            : sessions
        return formatResult({
            success: true,
            count: selected.length,
            detail: args.detail === true || args.fields !== undefined,
            sessions: selected,
        })
    } catch (error) {
        return formatError(error)
    }
}

async function handleReconnect(args: z.infer<typeof reconnectSchema>) {
    try {
        await sessionManager.reconnect(args.alias)
        return formatResult({ success: true, message: `Reconnected to ${args.alias}` })
    } catch (error) {
        return formatError(error)
    }
}

async function handleConfigList(args: z.infer<typeof configListSchema>) {
    try {
        const hosts = parseSSHConfig(args.configPath)
        return formatResult({
            success: true,
            count: hosts.length,
            hosts: hosts.map((h) => ({
                host: h.host,
                hostName: h.hostName,
                user: h.user,
                port: h.port,
                identityFile: h.identityFile,
                proxyJump: h.proxyJump,
            })),
        })
    } catch (error) {
        return formatError(error)
    }
}

// ========== Register ==========

export function registerConnectionTools(server: McpServer): void {
    server.registerTool(
        'ssh_connect',
        {
            description: [
                '建立 SSH 连接并保持会话，支持密码、密钥认证，支持跳板机',
                '',
                '可通过 configHost 参数使用 ~/.ssh/config 中的配置，无需重复填写连接信息',
                '支持 Host 多别名、Host * 全局默认继承、ProxyJump（user@host:port 格式）',
                '',
                '示例',
                '- 使用 ssh config，传入 configHost 为 "myserver"',
                '- 密钥认证，传入 host、user、keyPath',
                '- 跳板机，传入 host、user、keyPath 和 jumpHost 配置',
            ].join('\n'),
            inputSchema: connectSchema,
        },
        (args) => handleConnect(args)
    )

    server.registerTool(
        'ssh_disconnect',
        {
            description: '断开 SSH 连接',
            inputSchema: disconnectSchema,
        },
        (args) => handleDisconnect(args)
    )

    server.registerTool(
        'ssh_list_sessions',
        {
            description: '列出所有活跃的 SSH 会话',
            inputSchema: listSessionsSchema,
        },
        (args) => handleListSessions(args)
    )

    server.registerTool(
        'ssh_reconnect',
        {
            description: '重新连接已断开的会话',
            inputSchema: reconnectSchema,
        },
        (args) => handleReconnect(args)
    )

    server.registerTool(
        'ssh_config_list',
        {
            description: `列出 ~/.ssh/config 中配置的所有 Host

返回每个 Host 的配置信息（别名、地址、用户、端口、密钥路径等）`,
            inputSchema: configListSchema,
        },
        (args) => handleConfigList(args)
    )
}
