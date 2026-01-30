/**
 * SSH Config Parser
 *
 * 解析 ~/.ssh/config 文件，提取 Host 配置
 * 支持：
 * - Host 多别名（Host a b c）
 * - Host * 全局默认配置继承
 * - ProxyJump 解析（支持 user@host:port 格式）
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SSHConfigHost {
  host: string;           // Host 别名
  hostName?: string;      // 实际地址
  user?: string;          // 用户名
  port?: number;          // 端口
  identityFile?: string;  // 私钥路径
  proxyJump?: string;     // 跳板机（原始字符串，可能是 user@host:port 格式）
}

/** ProxyJump 解析结果 */
export interface ParsedProxyJump {
  user?: string;
  host: string;
  port?: number;
}

/** 内部使用的配置块 */
interface ConfigBlock {
  patterns: string[];     // Host 行的所有模式/别名
  config: Omit<SSHConfigHost, 'host'>;
}

/**
 * 解析 host:port 或 [ipv6]:port
 * 返回 { host, port }，host 不含方括号
 */
function parseHostPort(s: string): { host: string; port?: number } {
  // IPv6 方括号格式: [addr]:port 或 [addr]
  if (s.startsWith('[')) {
    const closeBracket = s.indexOf(']');
    if (closeBracket !== -1) {
      const host = s.slice(1, closeBracket);  // 去掉方括号
      const rest = s.slice(closeBracket + 1);
      if (rest.startsWith(':')) {
        const parsedPort = parseInt(rest.slice(1), 10);
        if (!isNaN(parsedPort)) {
          return { host, port: parsedPort };
        }
      }
      return { host };
    }
  }

  // 检测裸 IPv6（多个冒号但无方括号）：安全失败，当作 host-only
  const colonCount = (s.match(/:/g) || []).length;
  if (colonCount >= 2) {
    return { host: s };
  }

  // 普通格式: host:port 或 host
  const colonIndex = s.lastIndexOf(':');
  if (colonIndex !== -1) {
    const host = s.slice(0, colonIndex);
    const portStr = s.slice(colonIndex + 1);
    const parsedPort = parseInt(portStr, 10);
    if (!isNaN(parsedPort)) {
      return { host, port: parsedPort };
    }
  }
  return { host: s };
}

/**
 * 解析 ProxyJump 字符串
 * 支持格式：host, user@host, host:port, user@host:port, [ipv6]:port
 * 注意：只解析第一跳，不支持逗号分隔的多跳链路
 */
export function parseProxyJump(proxyJump: string): ParsedProxyJump | null {
  if (!proxyJump) {
    return null;
  }

  // 取第一跳（如果有逗号分隔）
  const firstJump = proxyJump.split(',')[0].trim();
  if (!firstJump) {
    return null;
  }

  let user: string | undefined;

  // 解析 user@... 格式
  const atIndex = firstJump.indexOf('@');
  if (atIndex !== -1) {
    user = firstJump.slice(0, atIndex);
    const rest = firstJump.slice(atIndex + 1);
    const { host, port } = parseHostPort(rest);
    return { user, host, port };
  }

  const { host, port } = parseHostPort(firstJump);
  return { user, host, port };
}

/**
 * 展开 ~ 路径
 */
function expandTilde(filePath: string): string {
  if (filePath.startsWith('~')) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

/**
 * 剥离行尾注释
 * "value # comment" -> "value"
 */
function stripInlineComment(value: string): string {
  // 查找不在引号内的 #
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (!inQuote && (ch === '"' || ch === "'")) {
      inQuote = true;
      quoteChar = ch;
    } else if (inQuote && ch === quoteChar) {
      inQuote = false;
    } else if (!inQuote && ch === '#') {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

/**
 * 解析 SSH config 文件
 * 支持 Host 多别名和 Host * 继承
 * 跳过 Match 块（避免条件配置被误应用）
 */
export function parseSSHConfig(configPath?: string): SSHConfigHost[] {
  const filePath = configPath || path.join(os.homedir(), '.ssh', 'config');

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // 第一遍：收集所有配置块
  const blocks: ConfigBlock[] = [];
  let currentBlock: ConfigBlock | null = null;
  let globalDefaults: Omit<SSHConfigHost, 'host'> = {};
  let inMatchBlock = false;  // 跳过 Match 块

  for (const line of lines) {
    const trimmed = line.trim();

    // 跳过空行和注释
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // 解析 key value（支持 = 和空格分隔）
    const match = trimmed.match(/^(\S+)\s*[=\s]\s*(.+)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    const keyLower = key.toLowerCase();
    const value = stripInlineComment(rawValue);

    if (keyLower === 'host') {
      // Host 块开始，结束 Match 块
      inMatchBlock = false;

      // 保存上一个 block
      if (currentBlock) {
        blocks.push(currentBlock);
      }

      // Host 行可能有多个别名/模式，用空格分隔
      const patterns = value.split(/\s+/).filter(p => p.length > 0);
      currentBlock = { patterns, config: {} };
    } else if (keyLower === 'match') {
      // Match 块开始，跳过直到下一个 Host
      inMatchBlock = true;
      // 保存当前 block（如果有）
      if (currentBlock) {
        blocks.push(currentBlock);
        currentBlock = null;
      }
    } else if (!inMatchBlock && currentBlock) {
      // 解析配置项（不在 Match 块内）
      switch (keyLower) {
        case 'hostname':
          currentBlock.config.hostName = value;
          break;
        case 'user':
          currentBlock.config.user = value;
          break;
        case 'port':
          currentBlock.config.port = parseInt(value, 10);
          break;
        case 'identityfile':
          currentBlock.config.identityFile = expandTilde(value);
          break;
        case 'proxyjump':
          currentBlock.config.proxyJump = value;
          break;
      }
    }
  }

  // 保存最后一个 block
  if (currentBlock && !inMatchBlock) {
    blocks.push(currentBlock);
  }

  // 第二遍：提取 Host * 的全局默认配置
  for (const block of blocks) {
    if (block.patterns.length === 1 && block.patterns[0] === '*') {
      globalDefaults = { ...block.config };
      break;
    }
  }

  // 第三遍：展开所有 Host，应用继承
  const hosts: SSHConfigHost[] = [];

  for (const block of blocks) {
    for (const pattern of block.patterns) {
      // 跳过通配符模式（*, *.example.com 等）
      if (pattern.includes('*') || pattern.includes('?')) {
        continue;
      }

      // 合并配置：全局默认 + 当前块配置
      const merged: SSHConfigHost = {
        host: pattern,
        ...globalDefaults,
        ...block.config,
      };

      hosts.push(merged);
    }
  }

  return hosts;
}

/**
 * 根据 Host 名称获取配置
 */
export function getHostConfig(hostName: string, configPath?: string): SSHConfigHost | null {
  const hosts = parseSSHConfig(configPath);
  return hosts.find(h => h.host === hostName) || null;
}
