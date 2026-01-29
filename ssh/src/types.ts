/**
 * SSH MCP Pro - 类型定义
 */

export interface SSHConnectionConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  privateKey?: string;
  passphrase?: string;
  alias?: string;
  // 高级配置
  keepaliveInterval?: number;  // 心跳间隔（毫秒）
  keepaliveCountMax?: number;  // 最大心跳失败次数
  readyTimeout?: number;       // 连接超时（毫秒）
  // 环境配置
  env?: Record<string, string>;  // 环境变量
  lang?: string;                  // LANG 设置
  shell?: string;                 // Shell 类型
  // 跳板机
  jumpHost?: SSHConnectionConfig;
}

export interface SSHSessionInfo {
  alias: string;
  host: string;
  port: number;
  username: string;
  connected: boolean;
  connectedAt: number;
  lastUsedAt: number;
  env?: Record<string, string>;
}

export interface ExecOptions {
  timeout?: number;      // 命令超时（毫秒）
  env?: Record<string, string>;  // 额外环境变量
  cwd?: string;          // 工作目录
  pty?: boolean;         // 是否使用 PTY
  maxOutputSize?: number; // 最大输出大小（字节），默认 10MB
  // PTY 配置
  rows?: number;
  cols?: number;
  term?: string;
}

export interface ExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;  // 执行时间（毫秒）
}

export interface FileInfo {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  permissions: string;
  owner: number;
  group: number;
  mtime: Date;
  atime: Date;
}

export interface TransferProgress {
  transferred: number;
  total: number;
  percent: number;
}

// 持久化存储的会话配置（不含敏感信息）
export interface PersistedSession {
  alias: string;
  host: string;
  port: number;
  username: string;
  connectedAt: number;
  env?: Record<string, string>;
}

// PTY 会话配置
export interface PtyOptions {
  rows?: number;
  cols?: number;
  term?: string;
  env?: Record<string, string>;
  cwd?: string;
  bufferSize?: number;  // 输出缓冲区大小，默认 1MB
}

// PTY 会话信息
export interface PtySessionInfo {
  id: string;
  alias: string;          // SSH 连接别名
  command: string;        // 启动命令
  rows: number;
  cols: number;
  createdAt: number;
  lastReadAt: number;
  bufferSize: number;     // 当前缓冲区大小
  active: boolean;
}

// 端口转发类型
export type ForwardType = 'local' | 'remote';

// 端口转发配置
export interface PortForwardConfig {
  type: ForwardType;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

// 端口转发信息
export interface PortForwardInfo {
  id: string;
  alias: string;          // SSH 连接别名
  type: ForwardType;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  createdAt: number;
  active: boolean;
}
