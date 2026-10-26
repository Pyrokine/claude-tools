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
import { OpenSshError, resolveOpenSshConfig } from '../openssh.js'
import { parseProxyJump, parseSSHConfig } from '../ssh-config.js'
import { sshPortSchema } from './schema.js'
import { expandTilde, formatError, formatResult } from './utils.js'

const remotePlatformSchema = z.enum(['posix', 'windows'])
const commandShellSchema = z.enum(['posix', 'cmd', 'powershell'])
const remotePathStyleSchema = z.enum(['posix', 'win32', 'sftp-posix'])
const rsyncProfileSchema = z.enum(['posix', 'native-win32', 'msys2', 'cygwin'])

const templateJumpHostSchema = z.object({
    agent: z.string().optional(),
    remotePlatform: remotePlatformSchema.optional(),
    commandShell: commandShellSchema.optional(),
    remotePathStyle: remotePathStyleSchema.optional(),
    host: z.string(),
    user: z.string(),
    password: z.string().optional(),
    keyPath: z.string().optional(),
    port: sshPortSchema.optional(),
    readyTimeout: z.number().int().positive().max(600000).optional(),
})

const connectionTemplateSchema = z.object({
    backend: z.enum(['ssh2', 'openssh']).optional(),
    controlPath: z.string().optional(),
    configPath: z.string().optional(),
    configHost: z.string().optional(),
    host: z.string().optional(),
    user: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    keyPath: z.string().optional(),
    privateKeyPath: z.string().optional(),
    agent: z.string().optional(),
    remotePlatform: remotePlatformSchema.optional(),
    commandShell: commandShellSchema.optional(),
    remotePathStyle: remotePathStyleSchema.optional(),
    rsyncExecutable: z.string().optional(),
    rsyncProfile: rsyncProfileSchema.optional(),
    port: sshPortSchema.optional(),
    alias: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    defaultEnv: z.record(z.string(), z.string()).optional(),
    runAs: z.string().optional(),
    keepaliveInterval: z.number().int().positive().optional(),
    readyTimeout: z.number().int().positive().max(600000).optional(),
    jumpHost: templateJumpHostSchema.optional(),
})

type ConnectionTemplate = z.infer<typeof connectionTemplateSchema>

function loadTemplates(): Record<string, unknown> {
    const fromEnv = process.env.SSH_MCP_TEMPLATES
    const source =
        fromEnv ??
        (() => {
            const filePath = path.join(os.homedir(), '.mcp-ssh', 'templates.json')
            return fs.existsSync(filePath) ? fs.readFileSync(expandTilde(filePath), 'utf-8') : undefined
        })()
    if (!source) {
        return {}
    }

    const parsed: unknown = JSON.parse(source)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('SSH templates must be an object keyed by template name')
    }
    return parsed as Record<string, unknown>
}

function getTemplate(name?: string): ConnectionTemplate {
    if (!name) {
        return {}
    }
    let templates: Record<string, unknown>
    try {
        templates = loadTemplates()
    } catch (error) {
        throw new Error(
            `Template '${name}' could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
            {
                cause: error,
            }
        )
    }
    const rawTemplate = templates[name]
    if (!rawTemplate) {
        const available = Object.keys(templates)
        const suggestion = available.length
            ? `Available templates: ${available.slice(0, 20).join(', ')}`
            : 'No templates found. Define SSH_MCP_TEMPLATES or ~/.mcp-ssh/templates.json'
        throw new Error(`Template '${name}' not found. ${suggestion}`)
    }
    const parsed = connectionTemplateSchema.safeParse(rawTemplate)
    if (!parsed.success) {
        const issue = parsed.error.issues[0]
        const field = issue.path.length > 0 ? issue.path.join('.') : '<root>'
        throw new Error(`Template '${name}' is invalid at ${field}: ${issue.message}`)
    }
    return parsed.data
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
    backend: z
        .enum(['ssh2', 'openssh'])
        .optional()
        .describe('连接后端，默认 ssh2；openssh 仅复用用户已有 master，失败不新建连接'),
    controlPath: z.string().optional().describe('OpenSSH master 的 socket 路径，默认取 ssh -G 的 ControlPath'),
    template: z.string().optional().describe('连接模板名，从 SSH_MCP_TEMPLATES 或 ~/.mcp-ssh/templates.json 读取'),
    configHost: z.string().optional().describe('使用 ~/.ssh/config 中的 Host 配置（推荐）'),
    configPath: z.string().optional().describe('SSH 配置文件路径（默认 ~/.ssh/config）'),
    host: z.string().optional().describe('服务器地址（使用 configHost 时可省略）'),
    user: z.string().optional().describe('用户名（使用 configHost 时可省略）'),
    password: z.string().optional().describe('密码'),
    keyPath: z.string().optional().describe('SSH 私钥路径'),
    agent: z.string().optional().describe('SSH agent socket 或 Windows OpenSSH named pipe 路径'),
    remotePlatform: remotePlatformSchema.optional().describe('远端平台，默认 posix；Windows 须明确设置 windows'),
    commandShell: commandShellSchema.optional().describe('远端命令 shell，POSIX 默认 posix，Windows 默认 powershell'),
    remotePathStyle: remotePathStyleSchema.optional().describe('远端 SFTP 路径格式，Windows 默认 win32'),
    rsyncExecutable: z.string().optional().describe('远端 rsync 可执行文件路径'),
    rsyncProfile: rsyncProfileSchema.optional().describe('rsync 环境：posix、native-win32、msys2 或 cygwin'),
    port: sshPortSchema.optional().describe('SSH 端口，默认 22'),
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
            agent: z.string().optional().describe('跳板机 SSH agent socket 路径'),
            remotePlatform: remotePlatformSchema.optional(),
            commandShell: commandShellSchema.optional(),
            remotePathStyle: remotePathStyleSchema.optional(),
            port: sshPortSchema.optional().describe('跳板机端口，默认 22'),
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
    'backend',
    'masterReused',
    'identityStatus',
    'masterPid',
    'observedLogin',
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
    'remotePlatform',
    'commandShell',
    'remotePathStyle',
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
        const backend = args.backend ?? template.backend ?? 'ssh2'
        const configPath = args.configPath ?? template.configPath
        let controlPath = args.controlPath ?? template.controlPath
        const configHost = args.configHost ?? template.configHost
        let host = args.host ?? template.host
        let user = args.user ?? template.user ?? template.username
        let port = args.port ?? template.port
        let keyPath = args.keyPath ?? template.keyPath ?? template.privateKeyPath
        const password = args.password ?? template.password
        let agent = args.agent ?? template.agent
        const remotePlatform = args.remotePlatform ?? template.remotePlatform ?? 'posix'
        const commandShell =
            args.commandShell ?? template.commandShell ?? (remotePlatform === 'windows' ? 'powershell' : 'posix')
        if ((remotePlatform === 'windows') !== (commandShell !== 'posix')) {
            throw new Error('commandShell must match remotePlatform')
        }
        const remotePathStyle =
            args.remotePathStyle ?? template.remotePathStyle ?? (remotePlatform === 'windows' ? 'win32' : 'posix')
        const rsyncExecutable = args.rsyncExecutable ?? template.rsyncExecutable
        const rsyncProfile = args.rsyncProfile ?? template.rsyncProfile
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
                  agent?: string
              }
            | undefined

        if (backend === 'openssh') {
            if (
                password !== undefined ||
                keyPath !== undefined ||
                agent !== undefined ||
                args.jumpHost ||
                template.jumpHost
            ) {
                throw new OpenSshError(
                    'OpenSSH master reuse does not accept new authentication or jumpHost parameters',
                    {
                        code: 'unsupported_backend',
                        backend,
                        capability: 'new_authentication',
                        retryable: false,
                    }
                )
            }
            if (
                remotePlatform !== 'posix' ||
                commandShell !== 'posix' ||
                remotePathStyle !== 'posix' ||
                (rsyncProfile && rsyncProfile !== 'posix')
            ) {
                throw new OpenSshError('OpenSSH master reuse requires a POSIX remote shell and path style', {
                    code: 'unsupported_backend',
                    backend,
                    capability: 'platform',
                    retryable: false,
                })
            }
            const resolved = await resolveOpenSshConfig({
                configHost,
                configPath,
                host,
                username: user,
                port,
                controlPath,
                readyTimeout,
            })
            host = resolved.host
            user = resolved.username
            port = resolved.port
            controlPath = resolved.controlPath
        } else if (controlPath !== undefined) {
            throw new OpenSshError('controlPath requires backend=openssh', {
                code: 'invalid_openssh_config',
                backend,
                retryable: false,
            })
        } else if (configHost) {
            const allHosts = parseSSHConfig(configPath)
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
            host = host ?? hostConfig.hostName ?? hostConfig.host
            user = user ?? hostConfig.user
            port = port ?? hostConfig.port
            keyPath = keyPath ?? hostConfig.identityFile
            // IdentityAgent 指定的 agent 优先于进程环境，仅在未显式传参时使用
            const configAgent = hostConfig.identityAgent
            if (agent === undefined && configAgent && (!keyPath || configAgent === 'none')) {
                agent = configAgent
            }

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
                            port: parsed.port ?? jumpHostConfig.port ?? 22,
                            username: jumpUser,
                            privateKeyPath: jumpHostConfig.identityFile,
                            agent:
                                jumpHostConfig.identityAgent === 'none' || !jumpHostConfig.identityFile
                                    ? jumpHostConfig.identityAgent
                                    : undefined,
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
                            port: parsed.port ?? 22,
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
        const requestedJumpHost = args.jumpHost ?? template.jumpHost
        const jumpHost = requestedJumpHost
            ? {
                  host: requestedJumpHost.host,
                  port: requestedJumpHost.port ?? 22,
                  username: requestedJumpHost.user,
                  password: requestedJumpHost.password,
                  privateKeyPath: requestedJumpHost.keyPath,
                  agent: requestedJumpHost.agent,
                  remotePlatform: requestedJumpHost.remotePlatform,
                  commandShell: requestedJumpHost.commandShell,
                  remotePathStyle: requestedJumpHost.remotePathStyle,
                  readyTimeout: requestedJumpHost.readyTimeout ?? readyTimeout,
              }
            : jumpHostResolved

        const finalPort = port ?? 22
        const finalAlias = requestedAlias ?? `${user}@${host}:${finalPort}`
        const identity = `${user}@${host}:${finalPort}`
        const sessionsBeforeConnect = sessionManager.listSessionDetails()
        const reused = sessionsBeforeConnect.some((session) => session.alias === finalAlias && session.connected)
        const reusableSessions = sessionsBeforeConnect
            .filter((session) => session.identity === identity && session.alias !== finalAlias && session.connected)
            .map((session) => ({ alias: session.alias, runAs: session.runAs, connectedAt: session.connectedAt }))
        const alias = await sessionManager.connect({
            backend,
            controlPath,
            host,
            port: finalPort,
            username: user,
            password,
            privateKeyPath: keyPath,
            agent,
            remotePlatform,
            commandShell,
            remotePathStyle,
            rsyncExecutable,
            rsyncProfile,
            alias: finalAlias,
            template: args.template,
            runAs,
            defaultEnv,
            env,
            keepaliveInterval,
            readyTimeout,
            jumpHost,
        })
        const connected = sessionManager.getSessionConnectionInfo(alias)
        return formatResult({
            success: true,
            backend: connected.backend,
            masterReused: connected.masterReused,
            identityStatus: connected.identityStatus,
            masterPid: connected.masterPid,
            observedLogin: connected.observedLogin,
            alias: connected.alias,
            reused,
            identity: connected.identity,
            loginUser: connected.loginUser,
            runAs: connected.runAs,
            remotePlatform: connected.remotePlatform,
            commandShell: connected.commandShell,
            remotePathStyle: connected.remotePathStyle,
            keyAclStatus: connected.keyAclStatus,
            host: connected.host,
            port: connected.port,
            defaultEnvKeys: connected.defaultEnvKeys,
            envKeys: connected.envKeys,
            reusableSessions,
            suggestion:
                reusableSessions.length > 0
                    ? '已有同 identity 的连接，可直接复用 reusableSessions 中的 alias'
                    : undefined,
            message: `Connected to ${connected.identity}${connected.hasJumpHost ? ' via jump host' : ''}`,
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
                identityAgent: h.identityAgent,
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
                '建立 SSH 会话，默认 ssh2 支持密码、密钥和跳板机；backend=openssh 仅复用用户已有主连接，失败不新建连接或重新认证',
                'OpenSSH 后端沿用用户 master 的信任，支持 POSIX 命令、后台操作和 rsync 同步；断开 alias 保留用户 master，未适配能力明确报错',
                '',
                '可通过 configHost 参数使用 ~/.ssh/config 中的配置，无需重复填写连接信息；模板会在连接前校验端口和嵌套 jumpHost 字段',
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
