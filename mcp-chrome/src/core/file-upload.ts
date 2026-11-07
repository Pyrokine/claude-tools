import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { lookup } from 'mime-types'
import { StructuredToolError } from './errors.js'

const UPLOAD_BYTE_LIMIT = 50 * 1024 * 1024

interface UploadFilePayload {
    name: string
    mimeType: string
    buffer: string
    lastModified: number
}

export interface UploadPageResult {
    success: boolean
    actionExecuted: boolean
    actionStatus: 'not_started' | 'completed' | 'failed' | 'unknown'
    error?: string
    files?: Array<{ name: string; size: number; mimeType: string; lastModified: number }>
}

export async function prepareUploadFiles(
    paths: string[],
    deadline: number,
    signal?: AbortSignal
): Promise<UploadFilePayload[]> {
    const active = (): void => {
        signal?.throwIfAborted()
        if (Date.now() >= deadline) {
            throw new Error('input timeout before upload assignment')
        }
    }
    let total = 0
    const checkSize = (size: number): void => {
        if (size >= UPLOAD_BYTE_LIMIT) {
            throw new StructuredToolError(
                'UPLOAD_TOO_LARGE',
                '上传文件的总大小必须小于 50 MiB',
                '请减少文件数量或大小',
                { actionExecuted: false, actionStatus: 'not_started', limitBytes: UPLOAD_BYTE_LIMIT }
            )
        }
    }
    const files = []
    for (const [index, path] of paths.entries()) {
        active()
        const resolved = resolve(
            path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
        )
        let timer: ReturnType<typeof setTimeout> | undefined
        let onAbort: (() => void) | undefined
        try {
            const stopped = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error('input timeout before upload file preflight')),
                    Math.max(0, Math.ceil(deadline - Date.now()))
                )
                onAbort = () => reject(signal?.reason ?? new Error('Upload cancelled before file preflight'))
                signal?.addEventListener('abort', onAbort, { once: true })
                if (signal?.aborted) {
                    onAbort()
                }
            })
            const info = await Promise.race([stat(resolved), stopped])
            active()
            if (!info.isFile()) {
                // noinspection ExceptionCaughtLocallyJS
                throw Object.assign(new Error('Not a regular file'), { code: 'NOT_REGULAR_FILE' })
            }
            total += info.size
            checkSize(total)
            files.push({ path: resolved, name: basename(resolved), lastModified: info.mtimeMs, index })
        } catch (error) {
            if (error instanceof StructuredToolError || signal?.aborted || Date.now() >= deadline) {
                throw error
            }
            throw fileReadError(index, basename(resolved), error)
        } finally {
            clearTimeout(timer)
            if (onAbort) {
                signal?.removeEventListener('abort', onAbort)
            }
        }
    }
    total = 0
    const payloads: UploadFilePayload[] = []
    for (const file of files) {
        active()
        const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - Date.now())))
        const readSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
        const stream = createReadStream(file.path, { signal: readSignal, highWaterMark: 64 * 1024 })
        try {
            const chunks: Buffer[] = []
            for await (const chunk of stream) {
                active()
                total += chunk.length
                checkSize(total)
                chunks.push(chunk as Buffer)
            }
            active()
            payloads.push({
                name: file.name,
                mimeType: lookup(file.name) || 'application/octet-stream',
                buffer: Buffer.concat(chunks).toString('base64'),
                lastModified: file.lastModified,
            })
        } catch (error) {
            if (error instanceof StructuredToolError || readSignal.aborted) {
                throw error
            }
            throw fileReadError(file.index, file.name, error)
        } finally {
            stream.destroy()
        }
    }
    active()
    return payloads
}

function fileReadError(index: number, name: string, error: unknown): StructuredToolError {
    const code = (error as NodeJS.ErrnoException | null)?.code ?? 'READ_FAILED'
    return new StructuredToolError(
        'UPLOAD_FILE_READ_FAILED',
        `无法读取第 ${index + 1} 个上传文件 ${name}（${code}）`,
        '请检查 Server 机器上的文件路径、文件类型和读取权限',
        { fileIndex: index, name, reason: code, actionExecuted: false, actionStatus: 'not_started' }
    )
}

// 函数会序列化到目标 frame，保持自包含，避免捕获 Node 或模块变量
// 校验异常统一转换为结构化执行状态
export function uploadInPage(
    this: Element | undefined,
    operation: 'prepare' | 'commit' | 'cleanup',
    key: string,
    refId: string | null,
    deadline: number,
    count: number,
    payloads: UploadFilePayload[] = []
): UploadPageResult {
    const root = globalThis as unknown as Record<
        string,
        { element: WeakRef<HTMLInputElement>; timer: ReturnType<typeof setTimeout> }
    >
    let actionExecuted = false
    try {
        const previous = root[key]
        if (operation === 'cleanup') {
            if (previous) {
                clearTimeout(previous.timer)
                delete root[key]
            }
            return { success: true, actionExecuted: false, actionStatus: 'not_started' }
        }
        let element: Element | undefined
        if (operation === 'prepare') {
            const map = (globalThis as unknown as { __mcpElementMap?: Record<string, WeakRef<Element>> })
                .__mcpElementMap
            element = refId ? map?.[refId]?.deref() : this
            if (element instanceof HTMLLabelElement) {
                element = element.control ?? undefined
            }
        } else {
            element = previous?.element.deref()
            if (previous) {
                clearTimeout(previous.timer)
                delete root[key]
            }
        }
        if (Date.now() >= deadline) {
            // noinspection ExceptionCaughtLocallyJS
            throw new Error('input timeout before upload assignment')
        }
        if (!element?.isConnected || element.ownerDocument !== document) {
            // noinspection ExceptionCaughtLocallyJS
            throw new Error('上传目标已移除或页面已导航')
        }
        if (!(element instanceof HTMLInputElement) || element.type !== 'file') {
            // noinspection ExceptionCaughtLocallyJS
            throw new Error('upload target 必须是 input[type=file] 或关联的 label')
        }
        if (element.webkitdirectory) {
            // noinspection ExceptionCaughtLocallyJS
            throw new Error('upload 不支持目录上传')
        }
        if (count > 1 && !element.multiple) {
            // noinspection ExceptionCaughtLocallyJS
            throw new Error('上传多个文件需要 input[type=file][multiple]')
        }
        if (operation === 'prepare') {
            root[key] = {
                element: new WeakRef(element),
                timer: setTimeout(() => delete root[key], Math.max(1, deadline - Date.now())),
            }
            return { success: true, actionExecuted: false, actionStatus: 'not_started' }
        }
        const transfer = new DataTransfer()
        for (const payload of payloads) {
            const binary = atob(payload.buffer)
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; ++i) {
                bytes[i] = binary.charCodeAt(i)
            }
            transfer.items.add(
                new File([bytes], payload.name, { type: payload.mimeType, lastModified: payload.lastModified })
            )
        }
        if (Date.now() >= deadline) {
            // noinspection ExceptionCaughtLocallyJS
            throw new Error('input timeout before upload assignment')
        }
        actionExecuted = true
        element.files = transfer.files
        const files = Array.from(element.files ?? [], (file) => ({
            name: file.name,
            size: file.size,
            mimeType: file.type,
            lastModified: file.lastModified,
        }))
        if (
            files.length !== transfer.files.length ||
            files.some((file, i) => file.name !== transfer.files[i].name || file.size !== transfer.files[i].size)
        ) {
            return { success: false, actionExecuted, actionStatus: 'failed', error: '浏览器未接受完整文件列表' }
        }
        element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
        element.dispatchEvent(new Event('change', { bubbles: true }))
        return { success: true, actionExecuted, actionStatus: 'completed', files }
    } catch (error) {
        return {
            success: false,
            actionExecuted,
            actionStatus: actionExecuted ? 'unknown' : 'not_started',
            error: error instanceof Error ? error.message : '上传失败',
        }
    }
}
