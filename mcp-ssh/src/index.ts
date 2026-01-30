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

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { sessionManager } from './session-manager.js';
import * as fileOps from './file-ops.js';
import { ExecOptions, PtyOptions } from './types.js';
import { parseSSHConfig, getHostConfig, parseProxyJump, SSHConfigHost } from './ssh-config.js';

// 创建 MCP Server
const server = new Server(
  {
    name: 'ssh-mcp-pro',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 工具定义
const tools: Tool[] = [
  // ========== 连接管理 ==========
  {
    name: 'ssh_connect',
    description: `建立 SSH 连接并保持会话。支持密码、密钥认证，支持跳板机。

可通过 configHost 参数使用 ~/.ssh/config 中的配置，无需重复填写连接信息。
支持 Host 多别名、Host * 全局默认继承、ProxyJump（user@host:port 格式）。

示例:
- 使用 ssh config: ssh_connect(configHost="myserver")
- 密钥认证: ssh_connect(host="192.168.1.1", user="root", keyPath="/home/.ssh/id_rsa")
- 跳板机: ssh_connect(host="内网IP", user="root", keyPath="...", jumpHost={host:"跳板机IP", user:"root", keyPath:"..."})`,
    inputSchema: {
      type: 'object',
      properties: {
        configHost: { type: 'string', description: '使用 ~/.ssh/config 中的 Host 配置（推荐）' },
        configPath: { type: 'string', description: 'SSH 配置文件路径（默认 ~/.ssh/config）' },
        host: { type: 'string', description: '服务器地址（使用 configHost 时可省略）' },
        user: { type: 'string', description: '用户名（使用 configHost 时可省略）' },
        password: { type: 'string', description: '密码' },
        keyPath: { type: 'string', description: 'SSH 私钥路径' },
        port: { type: 'number', description: 'SSH 端口，默认 22' },
        alias: { type: 'string', description: '连接别名（可选，默认使用 configHost 或 host）' },
        env: {
          type: 'object',
          description: '环境变量',
          additionalProperties: { type: 'string' },
        },
        keepaliveInterval: { type: 'number', description: '心跳间隔（毫秒），默认 30000' },
        jumpHost: {
          type: 'object',
          description: '跳板机配置',
          properties: {
            host: { type: 'string', description: '跳板机地址' },
            user: { type: 'string', description: '跳板机用户名' },
            password: { type: 'string', description: '跳板机密码' },
            keyPath: { type: 'string', description: '跳板机私钥路径' },
            port: { type: 'number', description: '跳板机端口，默认 22' },
          },
          required: ['host', 'user'],
        },
      },
    },
  },
  {
    name: 'ssh_disconnect',
    description: '断开 SSH 连接',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '连接别名' },
      },
      required: ['alias'],
    },
  },
  {
    name: 'ssh_list_sessions',
    description: '列出所有活跃的 SSH 会话',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'ssh_reconnect',
    description: '重新连接已断开的会话',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '连接别名' },
      },
      required: ['alias'],
    },
  },

  // ========== 命令执行 ==========
  {
    name: 'ssh_exec',
    description: `在远程服务器执行命令。

返回: stdout, stderr, exitCode, duration`,
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '连接别名' },
        command: { type: 'string', description: '要执行的命令' },
        timeout: { type: 'number', description: '超时（毫秒），默认 30000' },
        cwd: { type: 'string', description: '工作目录（可选）' },
        env: {
          type: 'object',
          description: '额外环境变量',
          additionalProperties: { type: 'string' },
        },
        pty: { type: 'boolean', description: '是否使用 PTY 模式（用于 top 等交互式命令）' },
      },
      required: ['alias', 'command'],
    },
  },
  {
    name: 'ssh_exec_as_user',
    description: `以其他用户身份执行命令（通过 su 切换）。

适用场景: SSH 以 root 登录，但需要以其他用户（如 caros）执行命令。

示例: ssh_exec_as_user(alias="server", command="whoami", targetUser="caros")`,
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '连接别名' },
        command: { type: 'string', description: '要执行的命令' },
        targetUser: { type: 'string', description: '目标用户名' },
        timeout: { type: 'number', description: '超时（毫秒）' },
      },
      required: ['alias', 'command', 'targetUser'],
    },
  },
  {
    name: 'ssh_exec_sudo',
    description: '使用 sudo 执行命令',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '连接别名' },
        command: { type: 'string', description: '要执行的命令' },
        sudoPassword: { type: 'string', description: 'sudo 密码（如果需要）' },
        timeout: { type: 'number', description: '超时（毫秒）' },
      },
      required: ['alias', 'command'],
    },
  },
  {
    name: 'ssh_exec_batch',
    description: '批量执行多条命令',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '连接别名' },
        commands: {
          type: 'array',
          items: { type: 'string' },
          description: '命令列表',
        },
        stopOnError: { type: 'boolean', description: '遇到错误是否停止，默认 true' },
        timeout: { type: 'number', description: '每条命令的超时（毫秒）' },
      },
      required: ['alias', 'commands'],
    },
  },
  {
    name: 'ssh_quick_exec',
    description: '一次性执行命令（自动连接、执行、断开）。适用于单次命令，不需要保持连接。',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: '服务器地址' },
        user: { type: 'string', description: '用户名' },
        command: { type: 'string', description: '要执行的命令' },
        password: { type: 'string', description: '密码' },
        keyPath: { type: 'string', description: '密钥路径' },
        port: { type: 'number', description: '端口', default: 22 },
        timeout: { type: 'number', description: '超时（毫秒）' },
      },
      required: ['host', 'user', 'command'],
    },
  },

  // ========== 文件操作 ==========
  {
    name: 'ssh_upload',
    description: '上传本地文件到远程服务器',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '连接别名' },
        localPath: { type: 'string', description: '本地文件路径' },
        remotePath: { type: 'string', description: '远程目标路径' },
      },
      required: ['alias', 'localPath', 'remotePath'],
    },
  },
  {
    name: 'ssh_download',
    description: '从远程服务器下载文件',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '连接别名' },
        remotePath: { type: 'string', description: '远程文件路径' },
        localPath: { type: 'string', description: '本地保存路径' },
      },
      required: ['alias', 'remotePath', 'localPath'],
    },
  },
  {
    name: 'ssh_read_file',
    description: '读取远程文件内容',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '连接别名' },
        remotePath: { type: 'string', description: '远程文件路径' },
        maxBytes: { type: 'number', description: '最大读取字节数，默认 1MB' },
      },
      required: ['alias', 'remotePath'],
    },
  },
  {
    name: 'ssh_write_file',
    description: '写入内容到远程文件',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '连接别名' },
        remotePath: { type: 'string', description: '远程文件路径' },
        content: { type: 'string', description: '要写入的内容' },
        append: { type: 'boolean', description: '是否追加模式，默认覆盖' },
      },
      required: ['alias', 'remotePath', 'content'],
    },
  },
  {
    name: 'ssh_list_dir',
    description: '列出远程目录内容',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '连接别名' },
        remotePath: { type: 'string', description: '远程目录路径' },
        showHidden: { type: 'boolean', description: '是否显示隐藏文件' },
      },
      required: ['alias', 'remotePath'],
    },
  },
  {
    name: 'ssh_file_info',
    description: '获取远程文件信息（大小、权限、修改时间等）',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '连接别名' },
        remotePath: { type: 'string', description: '远程路径' },
      },
      required: ['alias', 'remotePath'],
    },
  },
  {
    name: 'ssh_mkdir',
    description: '创建远程目录',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '连接别名' },
        remotePath: { type: 'string', description: '远程目录路径' },
        recursive: { type: 'boolean', description: '是否递归创建，默认 false' },
      },
      required: ['alias', 'remotePath'],
    },
  },
  {
    name: 'ssh_sync',
    description: `智能文件同步（支持目录递归）。

优先使用 rsync（如果本地和远程都安装了），否则回退到 SFTP。
rsync 可实现增量传输，对大目录同步效率更高。

用途：
- 同步本地目录到远程
- 从远程同步目录到本地
- 支持排除特定文件/目录

示例：
- 上传目录: ssh_sync(alias="server", localPath="/local/dir", remotePath="/remote/dir", direction="upload")
- 下载目录: ssh_sync(alias="server", localPath="/local/dir", remotePath="/remote/dir", direction="download")
- 排除文件: ssh_sync(..., exclude=["*.log", "node_modules"])`,
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '连接别名' },
        localPath: { type: 'string', description: '本地路径' },
        remotePath: { type: 'string', description: '远程路径' },
        direction: {
          type: 'string',
          enum: ['upload', 'download'],
          description: '同步方向：upload（本地到远程）或 download（远程到本地）',
        },
        delete: { type: 'boolean', description: '删除目标端多余文件（类似 rsync --delete）' },
        dryRun: { type: 'boolean', description: '仅显示将执行的操作，不实际传输' },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          description: '排除模式列表（支持 * 和 ? 通配符）',
        },
        recursive: { type: 'boolean', description: '递归同步目录，默认 true' },
      },
      required: ['alias', 'localPath', 'remotePath', 'direction'],
    },
  },

  // ========== PTY 会话（持久化交互式终端） ==========
  {
    name: 'ssh_pty_start',
    description: `启动持久化 PTY 会话，支持 top、htop、tmux 等交互式命令。

特点：
- 输出缓冲区持续收集数据
- 可通过 ssh_pty_read 轮询读取最新输出
- 可通过 ssh_pty_write 发送按键/命令

示例：
- 启动 top: ssh_pty_start(alias="server", command="top")
- 启动 tmux: ssh_pty_start(alias="server", command="tmux new -s work")`,
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '连接别名' },
        command: { type: 'string', description: '要执行的命令' },
        rows: { type: 'number', description: '终端行数，默认 24' },
        cols: { type: 'number', description: '终端列数，默认 80' },
        term: { type: 'string', description: '终端类型，默认 xterm-256color' },
        cwd: { type: 'string', description: '工作目录' },
        env: {
          type: 'object',
          description: '环境变量',
          additionalProperties: { type: 'string' },
        },
        bufferSize: { type: 'number', description: '输出缓冲区大小（字节），默认 1MB' },
      },
      required: ['alias', 'command'],
    },
  },
  {
    name: 'ssh_pty_write',
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
    inputSchema: {
      type: 'object',
      properties: {
        ptyId: { type: 'string', description: 'PTY 会话 ID' },
        data: { type: 'string', description: '要写入的数据' },
      },
      required: ['ptyId', 'data'],
    },
  },
  {
    name: 'ssh_pty_read',
    description: `读取 PTY 输出。

两种模式：
- screen（默认）：返回当前屏幕内容（解析后的纯文本，适合 top/btop/htop 等全屏刷新工具）
- raw：返回原始 ANSI 流（包含转义序列，适合需要完整终端数据的场景）

示例：
- 获取 top 当前画面: ssh_pty_read(ptyId="xxx")
- 获取原始输出: ssh_pty_read(ptyId="xxx", mode="raw")`,
    inputSchema: {
      type: 'object',
      properties: {
        ptyId: { type: 'string', description: 'PTY 会话 ID' },
        mode: { type: 'string', enum: ['screen', 'raw'], description: '输出模式：screen（当前屏幕）或 raw（原始流），默认 screen' },
        clear: { type: 'boolean', description: '(仅 raw 模式) 读取后是否清空缓冲区，默认 true' },
      },
      required: ['ptyId'],
    },
  },
  {
    name: 'ssh_pty_resize',
    description: '调整 PTY 窗口大小',
    inputSchema: {
      type: 'object',
      properties: {
        ptyId: { type: 'string', description: 'PTY 会话 ID' },
        rows: { type: 'number', description: '新的行数' },
        cols: { type: 'number', description: '新的列数' },
      },
      required: ['ptyId', 'rows', 'cols'],
    },
  },
  {
    name: 'ssh_pty_close',
    description: '关闭 PTY 会话',
    inputSchema: {
      type: 'object',
      properties: {
        ptyId: { type: 'string', description: 'PTY 会话 ID' },
      },
      required: ['ptyId'],
    },
  },
  {
    name: 'ssh_pty_list',
    description: '列出所有 PTY 会话',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // ========== 端口转发 ==========
  {
    name: 'ssh_forward_local',
    description: `创建本地端口转发（类似 ssh -L）。

本地监听指定端口，将连接转发到远程主机。

用途：访问远程内网服务
示例：ssh_forward_local(alias="server", localPort=8080, remoteHost="10.0.0.1", remotePort=80)
效果：访问本地 localhost:8080 会转发到远程内网的 10.0.0.1:80`,
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '连接别名' },
        localPort: { type: 'number', description: '本地监听端口' },
        remoteHost: { type: 'string', description: '远程目标主机' },
        remotePort: { type: 'number', description: '远程目标端口' },
        localHost: { type: 'string', description: '本地监听地址，默认 127.0.0.1' },
      },
      required: ['alias', 'localPort', 'remoteHost', 'remotePort'],
    },
  },
  {
    name: 'ssh_forward_remote',
    description: `创建远程端口转发（类似 ssh -R）。

远程监听指定端口，将连接转发到本地。

用途：将本地服务暴露到远程
示例：ssh_forward_remote(alias="server", remotePort=8080, localHost="127.0.0.1", localPort=3000)
效果：远程访问 localhost:8080 会转发到本地的 127.0.0.1:3000`,
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: '连接别名' },
        remotePort: { type: 'number', description: '远程监听端口' },
        localHost: { type: 'string', description: '本地目标地址' },
        localPort: { type: 'number', description: '本地目标端口' },
        remoteHost: { type: 'string', description: '远程监听地址，默认 127.0.0.1' },
      },
      required: ['alias', 'remotePort', 'localHost', 'localPort'],
    },
  },
  {
    name: 'ssh_forward_close',
    description: '关闭端口转发',
    inputSchema: {
      type: 'object',
      properties: {
        forwardId: { type: 'string', description: '端口转发 ID' },
      },
      required: ['forwardId'],
    },
  },
  {
    name: 'ssh_forward_list',
    description: '列出所有端口转发',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // ========== SSH Config ==========
  {
    name: 'ssh_config_list',
    description: `列出 ~/.ssh/config 中配置的所有 Host。

返回每个 Host 的配置信息（别名、地址、用户、端口、密钥路径等）。`,
    inputSchema: {
      type: 'object',
      properties: {
        configPath: { type: 'string', description: 'SSH 配置文件路径（默认 ~/.ssh/config）' },
      },
    },
  },

  // ========== 批量执行 ==========
  {
    name: 'ssh_exec_parallel',
    description: `在多个已连接的会话上并行执行同一命令。

示例：
- ssh_exec_parallel(aliases=["server1", "server2"], command="uptime")

返回每个主机的执行结果。`,
    inputSchema: {
      type: 'object',
      properties: {
        aliases: {
          type: 'array',
          items: { type: 'string' },
          description: '连接别名列表',
        },
        command: { type: 'string', description: '要执行的命令' },
        timeout: { type: 'number', description: '每个命令的超时（毫秒），默认 30000' },
      },
      required: ['aliases', 'command'],
    },
  },
];

// 注册工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result: unknown;

    switch (name) {
      // ========== 连接管理 ==========
      case 'ssh_connect': {
        // 解析 configHost
        let host = args.host as string | undefined;
        let user = args.user as string | undefined;
        let port = args.port as number | undefined;
        let keyPath = args.keyPath as string | undefined;
        const configPath = args.configPath as string | undefined;
        let jumpHostResolved: { host: string; port: number; username: string; password?: string; privateKeyPath?: string } | undefined;

        if (args.configHost) {
          const allHosts = parseSSHConfig(configPath);
          const hostConfig = allHosts.find(h => h.host === args.configHost);
          if (!hostConfig) {
            throw new Error(`Host '${args.configHost}' not found in SSH config`);
          }
          // 显式参数优先于 config 值
          host = host || hostConfig.hostName || hostConfig.host;
          user = user || hostConfig.user;
          port = port || hostConfig.port;
          keyPath = keyPath || hostConfig.identityFile;

          // 解析 ProxyJump（支持 user@host:port 格式）
          if (hostConfig.proxyJump) {
            const parsed = parseProxyJump(hostConfig.proxyJump);
            if (parsed) {
              // 先尝试在 config 中查找对应的 Host
              const jumpHostConfig = allHosts.find(h => h.host === parsed.host);
              if (jumpHostConfig) {
                // 使用 config 中的配置，但 parsed 的 user/port 优先
                jumpHostResolved = {
                  host: jumpHostConfig.hostName || jumpHostConfig.host,
                  port: parsed.port || jumpHostConfig.port || 22,
                  username: parsed.user || jumpHostConfig.user || 'root',
                  privateKeyPath: jumpHostConfig.identityFile,
                };
              } else {
                // 直接使用 parsed 的值
                jumpHostResolved = {
                  host: parsed.host,
                  port: parsed.port || 22,
                  username: parsed.user || 'root',
                };
              }
            }
          }
        }

        if (!host || !user) {
          throw new Error('host and user are required (either directly or via configHost)');
        }

        // 手动指定的 jumpHost 优先级高于 ProxyJump
        const jumpHostArg = args.jumpHost as { host: string; user: string; password?: string; keyPath?: string; port?: number } | undefined;
        const jumpHost = jumpHostArg ? {
          host: jumpHostArg.host,
          port: jumpHostArg.port || 22,
          username: jumpHostArg.user,
          password: jumpHostArg.password,
          privateKeyPath: jumpHostArg.keyPath,
        } : jumpHostResolved;

        const alias = await sessionManager.connect({
          host,
          port: port || 22,
          username: user,
          password: args.password as string | undefined,
          privateKeyPath: keyPath,
          alias: (args.alias as string | undefined) || (args.configHost as string | undefined),
          env: args.env as Record<string, string> | undefined,
          keepaliveInterval: args.keepaliveInterval as number | undefined,
          jumpHost,
        });
        result = {
          success: true,
          alias,
          message: `Connected to ${user}@${host}:${port || 22}${jumpHost ? ' via jump host' : ''}`,
        };
        break;
      }

      case 'ssh_disconnect': {
        const success = sessionManager.disconnect(args.alias as string);
        result = {
          success,
          message: success
            ? `Disconnected from ${args.alias}`
            : `Session ${args.alias} not found`,
        };
        break;
      }

      case 'ssh_list_sessions': {
        const sessions = sessionManager.listSessions();
        result = {
          success: true,
          count: sessions.length,
          sessions,
        };
        break;
      }

      case 'ssh_reconnect': {
        await sessionManager.reconnect(args.alias as string);
        result = { success: true, message: `Reconnected to ${args.alias}` };
        break;
      }

      // ========== 命令执行 ==========
      case 'ssh_exec': {
        const execResult = await sessionManager.exec(
          args.alias as string,
          args.command as string,
          {
            timeout: args.timeout as number | undefined,
            cwd: args.cwd as string | undefined,
            env: args.env as Record<string, string> | undefined,
            pty: args.pty as boolean | undefined,
          }
        );
        result = execResult;
        break;
      }

      case 'ssh_exec_as_user': {
        const execResult = await sessionManager.execAsUser(
          args.alias as string,
          args.command as string,
          args.targetUser as string,
          { timeout: args.timeout as number | undefined }
        );
        result = execResult;
        break;
      }

      case 'ssh_exec_sudo': {
        const execResult = await sessionManager.execSudo(
          args.alias as string,
          args.command as string,
          args.sudoPassword as string | undefined,
          { timeout: args.timeout as number | undefined }
        );
        result = execResult;
        break;
      }

      case 'ssh_exec_batch': {
        const commands = args.commands as string[];
        const stopOnError = args.stopOnError !== false;
        const timeout = args.timeout as number | undefined;
        const results: any[] = [];

        for (let i = 0; i < commands.length; i++) {
          try {
            const execResult = await sessionManager.exec(
              args.alias as string,
              commands[i],
              { timeout }
            );
            results.push({
              index: i,
              command: commands[i],
              ...execResult,
            });
            if (execResult.exitCode !== 0 && stopOnError) {
              break;
            }
          } catch (err: any) {
            results.push({
              index: i,
              command: commands[i],
              success: false,
              error: err.message,
            });
            if (stopOnError) break;
          }
        }

        result = {
          success: results.every((r) => r.success),
          total: commands.length,
          executed: results.length,
          results,
        };
        break;
      }

      case 'ssh_quick_exec': {
        const tempAlias = `_quick_${Date.now()}`;
        try {
          await sessionManager.connect({
            host: args.host as string,
            port: (args.port as number) || 22,
            username: args.user as string,
            password: args.password as string | undefined,
            privateKeyPath: args.keyPath as string | undefined,
            alias: tempAlias,
          });
          const execResult = await sessionManager.exec(
            tempAlias,
            args.command as string,
            { timeout: args.timeout as number | undefined }
          );
          result = execResult;
        } finally {
          sessionManager.disconnect(tempAlias);
        }
        break;
      }

      // ========== 文件操作 ==========
      case 'ssh_upload': {
        const uploadResult = await fileOps.uploadFile(
          args.alias as string,
          args.localPath as string,
          args.remotePath as string
        );
        result = { ...uploadResult, message: `Uploaded to ${args.remotePath}` };
        break;
      }

      case 'ssh_download': {
        const downloadResult = await fileOps.downloadFile(
          args.alias as string,
          args.remotePath as string,
          args.localPath as string
        );
        result = { ...downloadResult, message: `Downloaded to ${args.localPath}` };
        break;
      }

      case 'ssh_read_file': {
        const readResult = await fileOps.readFile(
          args.alias as string,
          args.remotePath as string,
          args.maxBytes as number | undefined
        );
        result = { success: true, ...readResult };
        break;
      }

      case 'ssh_write_file': {
        const writeResult = await fileOps.writeFile(
          args.alias as string,
          args.remotePath as string,
          args.content as string,
          args.append as boolean | undefined
        );
        result = writeResult;
        break;
      }

      case 'ssh_list_dir': {
        const files = await fileOps.listDir(
          args.alias as string,
          args.remotePath as string,
          args.showHidden as boolean | undefined
        );
        result = {
          success: true,
          path: args.remotePath,
          count: files.length,
          files,
        };
        break;
      }

      case 'ssh_file_info': {
        const info = await fileOps.getFileInfo(
          args.alias as string,
          args.remotePath as string
        );
        result = { success: true, ...info };
        break;
      }

      case 'ssh_mkdir': {
        const success = await fileOps.mkdir(
          args.alias as string,
          args.remotePath as string,
          args.recursive as boolean | undefined
        );
        result = { success, path: args.remotePath };
        break;
      }

      case 'ssh_sync': {
        const syncResult = await fileOps.syncFiles(
          args.alias as string,
          args.localPath as string,
          args.remotePath as string,
          args.direction as 'upload' | 'download',
          {
            delete: args.delete as boolean | undefined,
            dryRun: args.dryRun as boolean | undefined,
            exclude: args.exclude as string[] | undefined,
            recursive: args.recursive as boolean | undefined,
          }
        );
        result = {
          ...syncResult,
          direction: args.direction,
          localPath: args.localPath,
          remotePath: args.remotePath,
        };
        break;
      }

      // ========== PTY 会话 ==========
      case 'ssh_pty_start': {
        const ptyId = await sessionManager.ptyStart(
          args.alias as string,
          args.command as string,
          {
            rows: args.rows as number | undefined,
            cols: args.cols as number | undefined,
            term: args.term as string | undefined,
            cwd: args.cwd as string | undefined,
            env: args.env as Record<string, string> | undefined,
            bufferSize: args.bufferSize as number | undefined,
          }
        );
        result = {
          success: true,
          ptyId,
          message: `PTY session started: ${args.command}`,
        };
        break;
      }

      case 'ssh_pty_write': {
        const success = sessionManager.ptyWrite(
          args.ptyId as string,
          args.data as string
        );
        result = { success, ptyId: args.ptyId };
        break;
      }

      case 'ssh_pty_read': {
        const readResult = sessionManager.ptyRead(
          args.ptyId as string,
          {
            mode: (args.mode as 'screen' | 'raw') || 'screen',
            clear: args.clear !== false,
          }
        );
        result = {
          success: true,
          ptyId: args.ptyId,
          mode: args.mode || 'screen',
          ...readResult,
        };
        break;
      }

      case 'ssh_pty_resize': {
        const success = sessionManager.ptyResize(
          args.ptyId as string,
          args.rows as number,
          args.cols as number
        );
        result = { success, ptyId: args.ptyId };
        break;
      }

      case 'ssh_pty_close': {
        const success = sessionManager.ptyClose(args.ptyId as string);
        result = {
          success,
          message: success
            ? `PTY session closed: ${args.ptyId}`
            : `PTY session not found: ${args.ptyId}`,
        };
        break;
      }

      case 'ssh_pty_list': {
        const ptySessions = sessionManager.ptyList();
        result = {
          success: true,
          count: ptySessions.length,
          sessions: ptySessions,
        };
        break;
      }

      // ========== 端口转发 ==========
      case 'ssh_forward_local': {
        const forwardId = await sessionManager.forwardLocal(
          args.alias as string,
          args.localPort as number,
          args.remoteHost as string,
          args.remotePort as number,
          (args.localHost as string) || '127.0.0.1'
        );
        result = {
          success: true,
          forwardId,
          type: 'local',
          message: `Local forward: ${args.localHost || '127.0.0.1'}:${args.localPort} -> ${args.remoteHost}:${args.remotePort}`,
        };
        break;
      }

      case 'ssh_forward_remote': {
        const forwardId = await sessionManager.forwardRemote(
          args.alias as string,
          args.remotePort as number,
          args.localHost as string,
          args.localPort as number,
          (args.remoteHost as string) || '127.0.0.1'
        );
        result = {
          success: true,
          forwardId,
          type: 'remote',
          message: `Remote forward: ${args.remoteHost || '127.0.0.1'}:${args.remotePort} -> ${args.localHost}:${args.localPort}`,
        };
        break;
      }

      case 'ssh_forward_close': {
        const success = sessionManager.forwardClose(args.forwardId as string);
        result = {
          success,
          message: success
            ? `Forward closed: ${args.forwardId}`
            : `Forward not found: ${args.forwardId}`,
        };
        break;
      }

      case 'ssh_forward_list': {
        const forwards = sessionManager.forwardList();
        result = {
          success: true,
          count: forwards.length,
          forwards,
        };
        break;
      }

      // ========== SSH Config ==========
      case 'ssh_config_list': {
        const hosts = parseSSHConfig(args.configPath as string | undefined);
        result = {
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
        };
        break;
      }

      // ========== 批量执行 ==========
      case 'ssh_exec_parallel': {
        const aliases = args.aliases as string[];
        const command = args.command as string;
        const timeout = args.timeout as number | undefined;

        const execPromises = aliases.map(async (alias) => {
          try {
            const execResult = await sessionManager.exec(alias, command, { timeout });
            return {
              alias,
              success: execResult.success,
              exitCode: execResult.exitCode,
              stdout: execResult.stdout,
              stderr: execResult.stderr,
              duration: execResult.duration,
            };
          } catch (err: any) {
            return {
              alias,
              success: false,
              error: err.message,
            };
          }
        });

        const results = await Promise.all(execPromises);
        result = {
          success: results.every(r => r.success),
          total: aliases.length,
          results,
        };
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: false,
              error: error.message || String(error),
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
});

// 启动服务器
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('SSH MCP Pro server started');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
