/**
 * SSH File Operations - 文件操作
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { SFTPWrapper, Stats } from 'ssh2';
import { sessionManager } from './session-manager.js';
import { FileInfo, TransferProgress } from './types.js';

/**
 * 上传文件
 */
export async function uploadFile(
  alias: string,
  localPath: string,
  remotePath: string,
  onProgress?: (progress: TransferProgress) => void
): Promise<{ success: boolean; size: number }> {
  if (!fs.existsSync(localPath)) {
    throw new Error(`Local file not found: ${localPath}`);
  }

  const sftp = await sessionManager.getSftp(alias);
  const stats = fs.statSync(localPath);
  const totalSize = stats.size;

  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(localPath);
    const writeStream = sftp.createWriteStream(remotePath);
    let settled = false;

    const cleanup = (err?: Error) => {
      if (settled) return;
      settled = true;
      sftp.end();
      if (err) reject(err);
    };

    let transferred = 0;

    readStream.on('data', (chunk: Buffer) => {
      transferred += chunk.length;
      if (onProgress) {
        onProgress({
          transferred,
          total: totalSize,
          percent: totalSize > 0 ? Math.round((transferred / totalSize) * 100) : 100,
        });
      }
    });

    readStream.on('error', (err: Error) => cleanup(err));
    writeStream.on('error', (err: Error) => cleanup(err));

    writeStream.on('close', () => {
      if (!settled) {
        settled = true;
        sftp.end();
        resolve({ success: true, size: totalSize });
      }
    });

    readStream.pipe(writeStream);
  });
}

/**
 * 下载文件
 */
export async function downloadFile(
  alias: string,
  remotePath: string,
  localPath: string,
  onProgress?: (progress: TransferProgress) => void
): Promise<{ success: boolean; size: number }> {
  const sftp = await sessionManager.getSftp(alias);

  // 获取远程文件大小
  const stats = await new Promise<Stats>((resolve, reject) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) reject(err);
      else resolve(stats);
    });
  });
  const totalSize = stats.size;

  // 确保本地目录存在
  const localDir = path.dirname(localPath);
  if (!fs.existsSync(localDir)) {
    fs.mkdirSync(localDir, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const readStream = sftp.createReadStream(remotePath);
    const writeStream = fs.createWriteStream(localPath);
    let settled = false;

    const cleanup = (err?: Error) => {
      if (settled) return;
      settled = true;
      sftp.end();
      if (err) reject(err);
    };

    let transferred = 0;

    readStream.on('data', (chunk: Buffer) => {
      transferred += chunk.length;
      if (onProgress) {
        onProgress({
          transferred,
          total: totalSize,
          percent: totalSize > 0 ? Math.round((transferred / totalSize) * 100) : 100,
        });
      }
    });

    readStream.on('error', (err: Error) => cleanup(err));
    writeStream.on('error', (err: Error) => cleanup(err));

    writeStream.on('close', () => {
      if (!settled) {
        settled = true;
        sftp.end();
        resolve({ success: true, size: totalSize });
      }
    });

    readStream.pipe(writeStream);
  });
}

/**
 * 读取远程文件内容
 */
export async function readFile(
  alias: string,
  remotePath: string,
  maxBytes: number = 1024 * 1024  // 默认最大 1MB
): Promise<{ content: string; size: number; truncated: boolean }> {
  const sftp = await sessionManager.getSftp(alias);

  // 获取文件大小
  const stats = await new Promise<Stats>((resolve, reject) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) reject(err);
      else resolve(stats);
    });
  });

  const actualSize = stats.size;
  const truncated = actualSize > maxBytes;

  // 处理空文件
  if (actualSize === 0) {
    sftp.end();
    return { content: '', size: 0, truncated: false };
  }

  const readSize = Math.min(actualSize, maxBytes);

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    const readStream = sftp.createReadStream(remotePath, {
      start: 0,
      end: readSize - 1,
    });

    readStream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    readStream.on('end', () => {
      sftp.end();
      const content = Buffer.concat(chunks).toString('utf-8');
      resolve({
        content,
        size: actualSize,
        truncated,
      });
    });

    readStream.on('error', (err: Error) => {
      sftp.end();
      reject(err);
    });
  });
}

/**
 * 写入远程文件
 */
export async function writeFile(
  alias: string,
  remotePath: string,
  content: string,
  append: boolean = false
): Promise<{ success: boolean; size: number }> {
  const sftp = await sessionManager.getSftp(alias);
  const flags = append ? 'a' : 'w';

  return new Promise((resolve, reject) => {
    const writeStream = sftp.createWriteStream(remotePath, { flags });

    writeStream.on('close', () => {
      sftp.end();
      resolve({ success: true, size: content.length });
    });

    writeStream.on('error', (err: Error) => {
      sftp.end();
      reject(err);
    });

    writeStream.write(content);
    writeStream.end();
  });
}

/**
 * 列出目录内容
 */
export async function listDir(
  alias: string,
  remotePath: string,
  showHidden: boolean = false
): Promise<FileInfo[]> {
  const sftp = await sessionManager.getSftp(alias);

  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (err, list) => {
      if (err) {
        sftp.end();
        reject(err);
        return;
      }

      const files: FileInfo[] = list
        .filter((item) => showHidden || !item.filename.startsWith('.'))
        .map((item) => ({
          name: item.filename,
          path: path.posix.join(remotePath, item.filename),
          size: item.attrs.size,
          isDirectory: (item.attrs.mode & 0o40000) !== 0,
          isFile: (item.attrs.mode & 0o100000) !== 0,
          isSymlink: (item.attrs.mode & 0o120000) !== 0,
          permissions: formatPermissions(item.attrs.mode),
          owner: item.attrs.uid,
          group: item.attrs.gid,
          mtime: new Date(item.attrs.mtime * 1000),
          atime: new Date(item.attrs.atime * 1000),
        }))
        .sort((a, b) => {
          // 目录在前
          if (a.isDirectory !== b.isDirectory) {
            return a.isDirectory ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });

      sftp.end();
      resolve(files);
    });
  });
}

/**
 * 获取文件信息
 */
export async function getFileInfo(
  alias: string,
  remotePath: string
): Promise<FileInfo> {
  const sftp = await sessionManager.getSftp(alias);

  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (err, stats) => {
      sftp.end();

      if (err) {
        reject(err);
        return;
      }

      resolve({
        name: path.posix.basename(remotePath),
        path: remotePath,
        size: stats.size,
        isDirectory: (stats.mode & 0o40000) !== 0,
        isFile: (stats.mode & 0o100000) !== 0,
        isSymlink: (stats.mode & 0o120000) !== 0,
        permissions: formatPermissions(stats.mode),
        owner: stats.uid,
        group: stats.gid,
        mtime: new Date(stats.mtime * 1000),
        atime: new Date(stats.atime * 1000),
      });
    });
  });
}

/**
 * 检查文件是否存在
 */
export async function fileExists(
  alias: string,
  remotePath: string
): Promise<boolean> {
  const sftp = await sessionManager.getSftp(alias);

  return new Promise((resolve) => {
    sftp.stat(remotePath, (err) => {
      sftp.end();
      resolve(!err);
    });
  });
}

/**
 * 创建目录
 */
export async function mkdir(
  alias: string,
  remotePath: string,
  recursive: boolean = false
): Promise<boolean> {
  if (recursive) {
    // 通过 exec 实现递归创建
    const result = await sessionManager.exec(alias, `mkdir -p "${remotePath}"`);
    return result.exitCode === 0;
  }

  const sftp = await sessionManager.getSftp(alias);
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (err) => {
      sftp.end();
      if (err) reject(err);
      else resolve(true);
    });
  });
}

/**
 * 删除文件
 */
export async function removeFile(
  alias: string,
  remotePath: string
): Promise<boolean> {
  const sftp = await sessionManager.getSftp(alias);
  return new Promise((resolve, reject) => {
    sftp.unlink(remotePath, (err) => {
      sftp.end();
      if (err) reject(err);
      else resolve(true);
    });
  });
}

/**
 * 检查远程是否安装 rsync
 */
export async function checkRsync(alias: string): Promise<boolean> {
  try {
    const result = await sessionManager.exec(alias, 'which rsync');
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 智能文件同步（优先使用 rsync）
 *
 * @param alias SSH 连接别名
 * @param localPath 本地路径
 * @param remotePath 远程路径
 * @param direction 同步方向：'upload' 或 'download'
 * @param options 同步选项
 */
export async function syncFiles(
  alias: string,
  localPath: string,
  remotePath: string,
  direction: 'upload' | 'download',
  options: {
    delete?: boolean;       // 删除目标端多余文件
    dryRun?: boolean;       // 仅显示将执行的操作
    exclude?: string[];     // 排除模式
    recursive?: boolean;    // 递归同步目录
  } = {}
): Promise<{
  success: boolean;
  method: 'rsync' | 'sftp';
  filesTransferred?: number;
  bytesTransferred?: number;
  output?: string;
}> {
  // 检查远程 rsync
  const hasRsync = await checkRsync(alias);

  if (hasRsync) {
    // 使用 rsync（通过远程端执行）
    return syncWithRsync(alias, localPath, remotePath, direction, options);
  } else {
    // 回退到 SFTP
    return syncWithSftp(alias, localPath, remotePath, direction, options);
  }
}

/**
 * 转义 shell 路径参数
 */
function escapeShellPath(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

/**
 * 使用 rsync 同步文件
 * 通过本地执行 rsync 连接到远程（需要密钥认证或 ssh-agent）
 */
async function syncWithRsync(
  alias: string,
  localPath: string,
  remotePath: string,
  direction: 'upload' | 'download',
  options: {
    delete?: boolean;
    dryRun?: boolean;
    exclude?: string[];
    recursive?: boolean;
  }
): Promise<{
  success: boolean;
  method: 'rsync' | 'sftp';
  filesTransferred?: number;
  bytesTransferred?: number;
  output?: string;
}> {
  // 检查本地是否有 rsync
  let hasLocalRsync = false;
  try {
    execSync('which rsync', { stdio: 'pipe' });
    hasLocalRsync = true;
  } catch {}

  if (!hasLocalRsync) {
    // 本地没有 rsync，回退到 SFTP
    return syncWithSftp(alias, localPath, remotePath, direction, options);
  }

  // 获取会话信息以构建 rsync 命令
  const sessions = sessionManager.listSessions();
  const sessionInfo = sessions.find(s => s.alias === alias);
  if (!sessionInfo) {
    throw new Error(`Session '${alias}' not found`);
  }

  // 构建 rsync 参数
  const args: string[] = ['-avz', '--progress'];

  if (options.delete) {
    args.push('--delete');
  }
  if (options.dryRun) {
    args.push('--dry-run');
  }
  if (options.recursive === false) {
    args.push('--dirs');  // 不递归，只传输目录本身
  }
  if (options.exclude) {
    for (const pattern of options.exclude) {
      args.push(`--exclude=${escapeShellPath(pattern)}`);
    }
  }

  // 构建 rsync 命令（本地执行）
  // 注意：这需要密钥认证或 ssh-agent，密码认证不支持
  const sshCmd = `ssh -p ${sessionInfo.port} -o StrictHostKeyChecking=no -o BatchMode=yes`;
  const remoteSpec = `${sessionInfo.username}@${sessionInfo.host}:${escapeShellPath(remotePath)}`;
  const rsyncCmd = direction === 'upload'
    ? `rsync ${args.join(' ')} -e "${sshCmd}" ${escapeShellPath(localPath)} ${remoteSpec}`
    : `rsync ${args.join(' ')} -e "${sshCmd}" ${remoteSpec} ${escapeShellPath(localPath)}`;

  try {
    const result = execSync(rsyncCmd, {
      encoding: 'utf-8',
      timeout: 600000,  // 10 分钟超时
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // 解析 rsync 输出统计文件数
    const lines = result.split('\n');
    let filesTransferred = 0;
    for (const line of lines) {
      if (line.trim() && !line.startsWith('sending') && !line.startsWith('receiving') && !line.startsWith('total')) {
        filesTransferred++;
      }
    }

    return {
      success: true,
      method: 'rsync',
      filesTransferred,
      output: result,
    };
  } catch {
    // rsync 失败（可能是密码认证），回退到 SFTP
    return syncWithSftp(alias, localPath, remotePath, direction, options);
  }
}

/**
 * 使用 SFTP 同步文件
 */
async function syncWithSftp(
  alias: string,
  localPath: string,
  remotePath: string,
  direction: 'upload' | 'download',
  options: {
    delete?: boolean;
    dryRun?: boolean;
    exclude?: string[];
    recursive?: boolean;
  }
): Promise<{
  success: boolean;
  method: 'rsync' | 'sftp';
  filesTransferred?: number;
  bytesTransferred?: number;
  output?: string;
}> {
  // SFTP 模式不支持 delete 选项
  const warnings: string[] = [];
  if (options.delete) {
    warnings.push('delete option is not supported in SFTP mode (requires rsync)');
  }

  if (options.dryRun) {
    return {
      success: true,
      method: 'sftp',
      output: 'Dry run mode: would transfer files via SFTP' + (warnings.length ? `. Warning: ${warnings.join('; ')}` : ''),
    };
  }

  try {
    let result: { fileCount: number; totalSize: number } | { success: boolean; size: number };

    if (direction === 'upload') {
      // 检查是否是目录
      const stats = fs.statSync(localPath);
      if (stats.isDirectory() && options.recursive !== false) {
        result = await uploadDirectory(alias, localPath, remotePath, options.exclude);
        return {
          success: true,
          method: 'sftp',
          filesTransferred: result.fileCount,
          bytesTransferred: result.totalSize,
          output: warnings.length ? `Warning: ${warnings.join('; ')}` : undefined,
        };
      } else {
        result = await uploadFile(alias, localPath, remotePath);
        return {
          success: result.success,
          method: 'sftp',
          filesTransferred: 1,
          bytesTransferred: result.size,
          output: warnings.length ? `Warning: ${warnings.join('; ')}` : undefined,
        };
      }
    } else {
      // 下载
      const info = await getFileInfo(alias, remotePath);
      if (info.isDirectory && options.recursive !== false) {
        result = await downloadDirectory(alias, remotePath, localPath, options.exclude);
        return {
          success: true,
          method: 'sftp',
          filesTransferred: result.fileCount,
          bytesTransferred: result.totalSize,
          output: warnings.length ? `Warning: ${warnings.join('; ')}` : undefined,
        };
      } else {
        result = await downloadFile(alias, remotePath, localPath);
        return {
          success: result.success,
          method: 'sftp',
          filesTransferred: 1,
          bytesTransferred: result.size,
          output: warnings.length ? `Warning: ${warnings.join('; ')}` : undefined,
        };
      }
    }
  } catch (err: any) {
    return {
      success: false,
      method: 'sftp',
      output: err.message,
    };
  }
}

/**
 * 递归上传目录
 */
async function uploadDirectory(
  alias: string,
  localPath: string,
  remotePath: string,
  exclude?: string[]
): Promise<{ fileCount: number; totalSize: number }> {
  let fileCount = 0;
  let totalSize = 0;

  // 确保远程目录存在
  await mkdir(alias, remotePath, true);

  const items = fs.readdirSync(localPath);
  for (const item of items) {
    // 检查排除模式
    if (exclude && exclude.some(pattern => matchPattern(item, pattern))) {
      continue;
    }

    const itemLocalPath = path.join(localPath, item);
    const itemRemotePath = path.posix.join(remotePath, item);
    const stats = fs.statSync(itemLocalPath);

    if (stats.isDirectory()) {
      const result = await uploadDirectory(alias, itemLocalPath, itemRemotePath, exclude);
      fileCount += result.fileCount;
      totalSize += result.totalSize;
    } else if (stats.isFile()) {
      await uploadFile(alias, itemLocalPath, itemRemotePath);
      fileCount++;
      totalSize += stats.size;
    }
  }

  return { fileCount, totalSize };
}

/**
 * 递归下载目录
 */
async function downloadDirectory(
  alias: string,
  remotePath: string,
  localPath: string,
  exclude?: string[]
): Promise<{ fileCount: number; totalSize: number }> {
  let fileCount = 0;
  let totalSize = 0;

  // 确保本地目录存在
  if (!fs.existsSync(localPath)) {
    fs.mkdirSync(localPath, { recursive: true });
  }

  const items = await listDir(alias, remotePath, true);
  for (const item of items) {
    // 检查排除模式
    if (exclude && exclude.some(pattern => matchPattern(item.name, pattern))) {
      continue;
    }

    const itemLocalPath = path.join(localPath, item.name);

    if (item.isDirectory) {
      const result = await downloadDirectory(alias, item.path, itemLocalPath, exclude);
      fileCount += result.fileCount;
      totalSize += result.totalSize;
    } else if (item.isFile) {
      await downloadFile(alias, item.path, itemLocalPath);
      fileCount++;
      totalSize += item.size;
    }
  }

  return { fileCount, totalSize };
}

/**
 * 简单的模式匹配（支持 * 和 ?）
 */
function matchPattern(name: string, pattern: string): boolean {
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // 转义特殊字符
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexPattern}$`).test(name);
}

/**
 * 格式化权限字符串
 */
function formatPermissions(mode: number): string {
  const types: Record<number, string> = {
    0o40000: 'd',
    0o120000: 'l',
    0o100000: '-',
  };

  let type = '-';
  for (const [mask, char] of Object.entries(types)) {
    if ((mode & parseInt(mask)) !== 0) {
      type = char;
      break;
    }
  }

  const perms = [
    (mode & 0o400) ? 'r' : '-',
    (mode & 0o200) ? 'w' : '-',
    (mode & 0o100) ? 'x' : '-',
    (mode & 0o040) ? 'r' : '-',
    (mode & 0o020) ? 'w' : '-',
    (mode & 0o010) ? 'x' : '-',
    (mode & 0o004) ? 'r' : '-',
    (mode & 0o002) ? 'w' : '-',
    (mode & 0o001) ? 'x' : '-',
  ];

  return type + perms.join('');
}
