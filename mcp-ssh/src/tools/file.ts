/**
 * 文件操作工具组
 *
 * ssh_upload, ssh_download, ssh_read_file, ssh_write_file,
 * ssh_list_dir, ssh_file_info, ssh_mkdir, ssh_sync
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {z} from 'zod'
import * as fileOps from '../file-ops.js'
import {formatError, formatResult} from './utils.js'

// ========== Schemas ==========

const uploadSchema = z.object({
                                  alias: z.string().describe('连接别名'),
                                  localPath: z.string().describe('本地文件路径'),
                                  remotePath: z.string().describe('远程目标路径'),
                              })

const downloadSchema = z.object({
                                    alias: z.string().describe('连接别名'),
                                    remotePath: z.string().describe('远程文件路径'),
                                    localPath: z.string().describe('本地保存路径'),
                                })

const readFileSchema = z.object({
                                    alias: z.string().describe('连接别名'),
                                    remotePath: z.string().describe('远程文件路径'),
                                    maxBytes: z.number().optional().describe('最大读取字节数，默认 1MB'),
                                })

const writeFileSchema = z.object({
                                     alias: z.string().describe('连接别名'),
                                     remotePath: z.string().describe('远程文件路径'),
                                     content: z.string().describe('要写入的内容'),
                                     append: z.boolean().optional().describe('是否追加模式，默认覆盖'),
                                 })

const listDirSchema = z.object({
                                   alias: z.string().describe('连接别名'),
                                   remotePath: z.string().describe('远程目录路径'),
                                   showHidden: z.boolean().optional().describe('是否显示隐藏文件'),
                               })

const fileInfoSchema = z.object({
                                    alias: z.string().describe('连接别名'),
                                    remotePath: z.string().describe('远程路径'),
                                })

const mkdirSchema = z.object({
                                 alias: z.string().describe('连接别名'),
                                 remotePath: z.string().describe('远程目录路径'),
                                 recursive: z.boolean().optional().describe('是否递归创建，默认 false'),
                             })

const syncSchema = z.object({
                                alias: z.string().describe('连接别名'),
                                localPath: z.string().describe('本地路径'),
                                remotePath: z.string().describe('远程路径'),
                                direction: z.enum(['upload', 'download'])
                                            .describe('同步方向：upload（本地到远程）或 download（远程到本地）'),
                                delete: z.boolean().optional().describe('删除目标端多余文件（类似 rsync --delete）'),
                                dryRun: z.boolean().optional().describe('仅显示将执行的操作，不实际传输'),
                                exclude: z.array(z.string()).optional().describe('排除模式列表（支持 * 和 ? 通配符）'),
                                recursive: z.boolean().optional().describe('递归同步目录，默认 true'),
                            })

// ========== Handlers ==========

async function handleUpload(args: z.infer<typeof uploadSchema>) {
    try {
        const uploadResult = await fileOps.uploadFile(args.alias, args.localPath, args.remotePath)
        return formatResult({...uploadResult, message: `Uploaded to ${args.remotePath}`})
    } catch (error) {
        return formatError(error)
    }
}

async function handleDownload(args: z.infer<typeof downloadSchema>) {
    try {
        const downloadResult = await fileOps.downloadFile(args.alias, args.remotePath, args.localPath)
        return formatResult({...downloadResult, message: `Downloaded to ${args.localPath}`})
    } catch (error) {
        return formatError(error)
    }
}

async function handleReadFile(args: z.infer<typeof readFileSchema>) {
    try {
        const readResult = await fileOps.readFile(args.alias, args.remotePath, args.maxBytes)
        return formatResult({success: true, ...readResult})
    } catch (error) {
        return formatError(error)
    }
}

async function handleWriteFile(args: z.infer<typeof writeFileSchema>) {
    try {
        const result = await fileOps.writeFile(args.alias, args.remotePath, args.content, args.append)
        return formatResult(result)
    } catch (error) {
        return formatError(error)
    }
}

async function handleListDir(args: z.infer<typeof listDirSchema>) {
    try {
        const files = await fileOps.listDir(args.alias, args.remotePath, args.showHidden)
        return formatResult({
                                success: true,
                                path: args.remotePath,
                                count: files.length,
                                files,
                            })
    } catch (error) {
        return formatError(error)
    }
}

async function handleFileInfo(args: z.infer<typeof fileInfoSchema>) {
    try {
        const info = await fileOps.getFileInfo(args.alias, args.remotePath)
        return formatResult({success: true, ...info})
    } catch (error) {
        return formatError(error)
    }
}

async function handleMkdir(args: z.infer<typeof mkdirSchema>) {
    try {
        const success = await fileOps.mkdir(args.alias, args.remotePath, args.recursive)
        return formatResult({success, path: args.remotePath})
    } catch (error) {
        return formatError(error)
    }
}

async function handleSync(args: z.infer<typeof syncSchema>) {
    try {
        const syncResult = await fileOps.syncFiles(
            args.alias,
            args.localPath,
            args.remotePath,
            args.direction,
            {
                delete: args.delete,
                dryRun: args.dryRun,
                exclude: args.exclude,
                recursive: args.recursive,
            },
        )
        return formatResult({
                                ...syncResult,
                                direction: args.direction,
                                localPath: args.localPath,
                                remotePath: args.remotePath,
                            })
    } catch (error) {
        return formatError(error)
    }
}

// ========== Register ==========

export function registerFileTools(server: McpServer): void {
    server.registerTool('ssh_upload', {
        description: '上传本地文件到远程服务器',
        inputSchema: uploadSchema,
    }, (args) => handleUpload(args))

    server.registerTool('ssh_download', {
        description: '从远程服务器下载文件',
        inputSchema: downloadSchema,
    }, (args) => handleDownload(args))

    server.registerTool('ssh_read_file', {
        description: '读取远程文件内容',
        inputSchema: readFileSchema,
    }, (args) => handleReadFile(args))

    server.registerTool('ssh_write_file', {
        description: '写入内容到远程文件',
        inputSchema: writeFileSchema,
    }, (args) => handleWriteFile(args))

    server.registerTool('ssh_list_dir', {
        description: '列出远程目录内容',
        inputSchema: listDirSchema,
    }, (args) => handleListDir(args))

    server.registerTool('ssh_file_info', {
        description: '获取远程文件信息（大小、权限、修改时间等）',
        inputSchema: fileInfoSchema,
    }, (args) => handleFileInfo(args))

    server.registerTool('ssh_mkdir', {
        description: '创建远程目录',
        inputSchema: mkdirSchema,
    }, (args) => handleMkdir(args))

    server.registerTool('ssh_sync', {
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
        inputSchema: syncSchema,
    }, (args) => handleSync(args))
}
