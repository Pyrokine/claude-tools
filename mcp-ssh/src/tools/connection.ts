/**
 * 连接管理工具组
 *
 * ssh_connect, ssh_disconnect, ssh_list_sessions, ssh_reconnect, ssh_config_list
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {z} from 'zod'
import {sessionManager} from '../session-manager.js'
import {parseProxyJump, parseSSHConfig} from '../ssh-config.js'
import {formatError, formatResult} from './utils.js'

// ========== Schemas ==========

const connectSchema = z.object({
                                   configHost: z.string()
                                                .optional()
                                                .describe('使用 ~/.ssh/config 中的 Host 配置（推荐）'),
                                   configPath: z.string().optional().describe('SSH 配置文件路径（默认 ~/.ssh/config）'),
                                   host: z.string().optional().describe('服务器地址（使用 configHost 时可省略）'),
                                   user: z.string().optional().describe('用户名（使用 configHost 时可省略）'),
                                   password: z.string().optional().describe('密码'),
                                   keyPath: z.string().optional().describe('SSH 私钥路径'),
                                   port: z.number().optional().describe('SSH 端口，默认 22'),
                                   alias: z.string().optional().describe('连接别名（可选，默认使用 configHost 或 host）'),
                                   env: z.record(z.string()).optional().describe('环境变量'),
                                   keepaliveInterval: z.number().optional().describe('心跳间隔（毫秒），默认 30000'),
                                   jumpHost: z.object({
                                                          host: z.string().describe('跳板机地址'),
                                                          user: z.string().describe('跳板机用户名'),
                                                          password: z.string().optional().describe('跳板机密码'),
                                                          keyPath: z.string().optional().describe('跳板机私钥路径'),
                                                          port: z.number().optional().describe('跳板机端口，默认 22'),
                                                      }).optional().describe('跳板机配置'),
                               })

const disconnectSchema = z.object({
                                      alias: z.string().describe('连接别名'),
                                  })

const listSessionsSchema = z.object({})

const reconnectSchema = z.object({
                                     alias: z.string().describe('连接别名'),
                                 })

const configListSchema = z.object({
                                      configPath: z.string()
                                                   .optional()
                                                   .describe('SSH 配置文件路径（默认 ~/.ssh/config）'),
                                  })

// ========== Handlers ==========

async function handleConnect(args: z.infer<typeof connectSchema>) {
    try {
        // 解析 configHost
        let host    = args.host
        let user    = args.user
        let port    = args.port
        let keyPath = args.keyPath
        let jumpHostResolved: {
                                  host: string;
                                  port: number;
                                  username: string;
                                  password?: string;
                                  privateKeyPath?: string
                              } | undefined

        if (args.configHost) {
            const allHosts   = parseSSHConfig(args.configPath)
            const hostConfig = allHosts.find(h => h.host === args.configHost)
            if (!hostConfig) {
                return formatResult({success: false, error: `Host '${args.configHost}' not found in SSH config`})
            }
            // 显式参数优先于 config 值
            host    = host || hostConfig.hostName || hostConfig.host
            user    = user || hostConfig.user
            port    = port || hostConfig.port
            keyPath = keyPath || hostConfig.identityFile

            // 解析 ProxyJump（支持 user@host:port 格式）
            if (hostConfig.proxyJump) {
                const parsed = parseProxyJump(hostConfig.proxyJump)
                if (parsed) {
                    // 先尝试在 config 中查找对应的 Host
                    const jumpHostConfig = allHosts.find(h => h.host === parsed.host)
                    if (jumpHostConfig) {
                        // 使用 config 中的配置，但 parsed 的 user/port 优先
                        jumpHostResolved = {
                            host: jumpHostConfig.hostName || jumpHostConfig.host,
                            port: parsed.port || jumpHostConfig.port || 22,
                            username: parsed.user || jumpHostConfig.user || 'root',
                            privateKeyPath: jumpHostConfig.identityFile,
                        }
                    } else {
                        // 直接使用 parsed 的值
                        jumpHostResolved = {
                            host: parsed.host,
                            port: parsed.port || 22,
                            username: parsed.user || 'root',
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
        const jumpHost = args.jumpHost ? {
            host: args.jumpHost.host,
            port: args.jumpHost.port || 22,
            username: args.jumpHost.user,
            password: args.jumpHost.password,
            privateKeyPath: args.jumpHost.keyPath,
        } : jumpHostResolved

        const alias = await sessionManager.connect({
                                                       host,
                                                       port: port || 22,
                                                       username: user,
                                                       password: args.password,
                                                       privateKeyPath: keyPath,
                                                       alias: args.alias || args.configHost,
                                                       env: args.env,
                                                       keepaliveInterval: args.keepaliveInterval,
                                                       jumpHost,
                                                   })
        return formatResult({
                                success: true,
                                alias,
                                message: `Connected to ${user}@${host}:${port || 22}${jumpHost ?
                                                                                      ' via jump host' :
                                                                                      ''}`,
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
                                message: success
                                         ? `Disconnected from ${args.alias}`
                                         : `Session ${args.alias} not found`,
                            })
    } catch (error) {
        return formatError(error)
    }
}

async function handleListSessions() {
    try {
        const sessions = sessionManager.listSessions()
        return formatResult({
                                success: true,
                                count: sessions.length,
                                sessions,
                            })
    } catch (error) {
        return formatError(error)
    }
}

async function handleReconnect(args: z.infer<typeof reconnectSchema>) {
    try {
        await sessionManager.reconnect(args.alias)
        return formatResult({success: true, message: `Reconnected to ${args.alias}`})
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
                                hosts: hosts.map(h => ({
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
    server.registerTool('ssh_connect', {
        description: `建立 SSH 连接并保持会话。支持密码、密钥认证，支持跳板机。

可通过 configHost 参数使用 ~/.ssh/config 中的配置，无需重复填写连接信息。
支持 Host 多别名、Host * 全局默认继承、ProxyJump（user@host:port 格式）。

示例:
- 使用 ssh config: ssh_connect(configHost="myserver")
- 密钥认证: ssh_connect(host="192.168.1.1", user="root", keyPath="/home/.ssh/id_rsa")
- 跳板机: ssh_connect(host="内网IP", user="root", keyPath="...", jumpHost={host:"跳板机IP", user:"root", keyPath:"..."})`,
        inputSchema: connectSchema,
    }, (args) => handleConnect(args))

    server.registerTool('ssh_disconnect', {
        description: '断开 SSH 连接',
        inputSchema: disconnectSchema,
    }, (args) => handleDisconnect(args))

    server.registerTool('ssh_list_sessions', {
        description: '列出所有活跃的 SSH 会话',
        inputSchema: listSessionsSchema,
    }, () => handleListSessions())

    server.registerTool('ssh_reconnect', {
        description: '重新连接已断开的会话',
        inputSchema: reconnectSchema,
    }, (args) => handleReconnect(args))

    server.registerTool('ssh_config_list', {
        description: `列出 ~/.ssh/config 中配置的所有 Host。

返回每个 Host 的配置信息（别名、地址、用户、端口、密钥路径等）。`,
        inputSchema: configListSchema,
    }, (args) => handleConfigList(args))
}
