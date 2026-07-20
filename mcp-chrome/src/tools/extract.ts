/**
 * extract 工具
 *
 * 提取页面内容：
 * - text: 文本内容
 * - html: HTML 源码（可选附带图片元信息或图片数据）
 * - frameHtml: iframe HTML 源码（Extension 模式，支持跨域 iframe）
 * - attribute: 元素属性
 * - screenshot: 截图
 * - state: 页面状态（精简的可交互元素列表）
 * - metadata: 页面元信息（title/og/jsonLd 等）
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { readFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { z } from 'zod'
import {
    CWD_PATH_PREFIX,
    formatErrorResponse,
    formatResponse,
    getSession,
    getUnifiedSession,
    resolveScopedOutputPath,
    TMP_PATH_PREFIX,
    writePrivateFile,
} from '../core/index.js'
import type { Target } from '../core/types.js'
import { comparePngImages, MAX_COMPARE_PIXELS, MAX_COMPARE_PNG_BYTES, readPngHeader } from './png.js'
import { targetToFindParams, targetZodSchema } from './schema.js'
import { sanitizeUrlRecords } from './network-sanitizer.js'
import { buildTargetDiagnostics, TargetTimeoutError } from './target-diagnostics.js'

/** 图片元信息 */
interface ImageInfo {
    index: number
    src: string
    dataSrc: string
    alt: string
    width: number
    height: number
    naturalWidth: number
    naturalHeight: number
}

/** 图片数据（base64） */
interface ImageData {
    base64: string | null
    mimeType: string
}

/** 无 output 时附录返回的最大图片数 */
const MAX_APPENDIX_IMAGES = 20

/**
 * extract 参数 schema
 */
const extractSchema = z.object({
    type: z
        .enum(['text', 'html', 'frameHtml', 'attribute', 'screenshot', 'state', 'metadata', 'diagnosticBundle'])
        .describe('提取类型'),
    target: targetZodSchema
        .optional()
        .describe(
            '目标元素（attribute 必填；text/html 可选，省略则提取整个页面；screenshot 可选用于元素截图；state 可选（仅 Extension）用于返回目标子树；metadata 不需要）'
        ),
    attribute: z.string().optional().describe('属性名（attribute）'),
    images: z
        .enum(['info', 'data'])
        .optional()
        .describe('图片提取模式（仅 html 类型有效），info: 元信息（src/alt/尺寸）；data: 含图片数据'),
    fullPage: z.boolean().optional().describe('是否全页面截图（screenshot）'),
    scale: z
        .number()
        .optional()
        .describe('截图缩放比例（screenshot fullPage），默认 1，设为 0.5 可降低分辨率加速大页面截图'),
    format: z
        .enum(['png', 'jpeg', 'webp'])
        .optional()
        .describe('截图格式（screenshot），默认 png，jpeg/webp 体积更小，复杂页面推荐 jpeg 减少超时'),
    quality: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('截图质量（screenshot，仅 jpeg/webp 有效），0-100，推荐 80'),
    clip: z
        .object({
            x: z.number(),
            y: z.number(),
            width: z.number().positive(),
            height: z.number().positive(),
        })
        .optional()
        .describe('坐标区域截图（screenshot），单位为 CSS 像素'),
    compareWith: z.string().optional().describe('截图对比基准 PNG 路径，遵循 output 相同的 tmp:/cwd: 路径规则'),
    diffOutput: z.string().optional().describe('截图对比差异图输出路径，遵循 output 相同的 tmp:/cwd: 路径规则'),
    output: z
        .string()
        .optional()
        .describe(
            `输出文件路径（可选），相对路径默认写入 ${TMP_PATH_PREFIX}，持久化到仓库请显式写 ${CWD_PATH_PREFIX}，images=data 时作为输出目录路径`
        ),
    tabId: z
        .string()
        .optional()
        .describe(
            '目标 Tab ID（可选，仅 Extension 模式），不指定则使用当前 attach 的 tab，可操作非当前 attach 的 tab，CDP 模式下不支持此参数'
        ),
    depth: z.number().optional().describe('DOM 遍历深度限制（state），默认 15，减小可降低返回数据量'),
    mode: z
        .enum(['accessibility', 'domsnapshot'])
        .optional()
        .describe(
            '页面状态提取模式（state 类型有效），accessibility=可访问性树（默认，与原 read_page 一致），domsnapshot=CDP DOMSnapshot 全量快照（仅 CDP 模式）'
        ),
    timeout: z.number().optional().describe('等待目标元素超时'),
    frame: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
            'iframe 定位（可选，仅 Extension 模式），CSS 选择器（如 "iframe#main"）或索引（如 0），不指定则在主框架操作'
        ),
})

/**
 * extract 工具处理器
 */
type ExtractArgs = z.infer<typeof extractSchema>

type ExtractToolResponse = {
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
    isError?: boolean
}

interface ExtractContext {
    unifiedSession: ReturnType<typeof getUnifiedSession>
    session: ReturnType<typeof getSession>
    useExtension: boolean
}

async function handleExtract(args: ExtractArgs): Promise<ExtractToolResponse> {
    try {
        const unifiedSession = getUnifiedSession()

        // 多 tab 并行：临时切换到指定 tab
        return await unifiedSession.withTabId(args.tabId, async () => {
            return await unifiedSession.withFrame(args.frame, async () => {
                const useExtension = unifiedSession.getMode() === 'extension'
                const frameHtmlError = validateFrameHtmlArgs(args, useExtension)
                if (frameHtmlError) {
                    return frameHtmlError
                }
                const session = getSession()

                // Extension 路径：等待目标元素出现（如果指定了 target + timeout）
                if (useExtension && args.target && args.timeout !== undefined) {
                    await waitForTargetExtension(unifiedSession, args.target, args.timeout, args.frame)
                }

                return handleExtractInFrame({ unifiedSession, session, useExtension }, args)
            }) // withFrame
        }) // withTabId
    } catch (error) {
        return formatErrorResponse(error)
    }
}

function validateFrameHtmlArgs(args: ExtractArgs, useExtension: boolean): ExtractToolResponse | undefined {
    if (args.type !== 'frameHtml') {
        return undefined
    }
    if (!useExtension) {
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        error: {
                            code: 'UNSUPPORTED_MODE',
                            message: 'frameHtml 需要 Extension 模式',
                            suggestion: '请连接 MCP Chrome Extension，并通过 frame 参数指定 iframe selector 或 index',
                        },
                    }),
                },
            ],
            isError: true,
        }
    }
    if (args.frame === undefined) {
        return formatErrorResponse(new Error('frameHtml 提取需要 frame 参数，例如 frame="iframe#main" 或 frame=0'))
    }
    return undefined
}

async function handleExtractInFrame(context: ExtractContext, args: ExtractArgs): Promise<ExtractToolResponse> {
    switch (args.type) {
        case 'text':
            return handleTextExtract(context, args)
        case 'html':
            return handleHtmlExtract(context, args)
        case 'frameHtml':
            return handleFrameHtmlExtract(context, args)
        case 'attribute':
            return handleAttributeExtract(context, args)
        case 'screenshot':
            return handleScreenshotExtract(context, args)
        case 'state':
            return handleStateExtract(context, args)
        case 'diagnosticBundle':
            return handleDiagnosticBundleExtract(context, args)
        case 'metadata':
            return handleMetadataExtract(context, args)
        default:
            return invalidExtractTypeResponse(args)
    }
}

async function handleTextExtract(
    { unifiedSession, session, useExtension }: ExtractContext,
    args: ExtractArgs
): Promise<ExtractToolResponse> {
    const text = useExtension
        ? await extractTextExtension(unifiedSession, args.target)
        : await extractText(session, args.target, args.timeout)
    if (args.output) {
        const outputPath = await writeOutputFile(args.output, text, 'utf-8')
        return formatResponse({ success: true, type: 'text', output: outputPath, size: text.length })
    }
    return formatResponse({ success: true, type: 'text', content: text })
}

async function handleHtmlExtract(context: ExtractContext, args: ExtractArgs): Promise<ExtractToolResponse> {
    const { unifiedSession, session, useExtension } = context
    if (args.images) {
        return handleHtmlWithImages(unifiedSession, session, useExtension, args)
    }

    const html = useExtension
        ? await extractHtmlExtension(unifiedSession, args.target)
        : await extractHTML(session, args.target, args.timeout)
    if (args.output) {
        const outputPath = await writeOutputFile(args.output, html, 'utf-8')
        return formatResponse({ success: true, type: 'html', output: outputPath, size: html.length })
    }
    return formatResponse({ success: true, type: 'html', content: html })
}

async function handleFrameHtmlExtract(
    { unifiedSession }: ExtractContext,
    args: ExtractArgs
): Promise<ExtractToolResponse> {
    const html = await extractHtmlExtension(unifiedSession, args.target)
    if (args.output) {
        const outputPath = await writeOutputFile(args.output, html, 'utf-8')
        return formatResponse({
            success: true,
            type: 'frameHtml',
            frame: args.frame,
            output: outputPath,
            size: html.length,
        })
    }
    return formatResponse({ success: true, type: 'frameHtml', frame: args.frame, content: html })
}

async function handleAttributeExtract(
    { unifiedSession, session, useExtension }: ExtractContext,
    args: ExtractArgs
): Promise<ExtractToolResponse> {
    if (!args.target) {
        return formatErrorResponse(new Error('attribute 提取需要 target 参数'))
    }
    if (!args.attribute) {
        return formatErrorResponse(new Error('attribute 提取需要 attribute 参数'))
    }

    const value = useExtension
        ? await extractAttributeExtension(unifiedSession, args.target, args.attribute)
        : await extractAttribute(session, args.target, args.attribute, args.timeout)
    return formatResponse({ success: true, type: 'attribute', attribute: args.attribute, value })
}

async function handleScreenshotExtract(
    { unifiedSession, useExtension }: ExtractContext,
    args: ExtractArgs
): Promise<ExtractToolResponse> {
    let clip: { x: number; y: number; width: number; height: number } | undefined
    if (args.target) {
        const { selector, text, xpath, nth: nthParam } = targetToFindParams(args.target as Target & { nth?: number })
        const nth = nthParam ?? 0
        const found = await unifiedSession.find(selector, text, xpath)
        if (found.length > nth) {
            const rect = found[nth].rect
            if (rect.width > 0 && rect.height > 0) {
                const scrollOffset =
                    args.frame === undefined ? await getPageScrollOffset(unifiedSession, args.timeout) : { x: 0, y: 0 }
                clip = {
                    x: rect.x + scrollOffset.x,
                    y: rect.y + scrollOffset.y,
                    width: rect.width,
                    height: rect.height,
                }
            }
        }
    }

    clip = args.clip ?? clip
    const fullPage = clip ? false : (args.fullPage ?? false)
    const scale = args.scale ?? 1
    const screenshot = await unifiedSession.screenshot({
        fullPage,
        scale: args.scale,
        format: args.format,
        quality: args.quality,
        clip,
    })
    const screenshotBuffer = Buffer.from(screenshot.data, 'base64')
    const encodedDimensions = readImageDimensions(screenshotBuffer, screenshot.format)
    const fallbackDimensions = encodedDimensions
        ? undefined
        : await getScreenshotFallbackDimensions(unifiedSession, clip, fullPage, scale, args.timeout)
    const dimensions = encodedDimensions ?? fallbackDimensions
    const metadata: Record<string, unknown> = {
        format: screenshot.format,
        width: dimensions?.width,
        height: dimensions?.height,
        dimensionSource: dimensions?.source,
        scale,
        fullPage,
        clip,
        size: screenshotBuffer.length,
        byteSize: screenshotBuffer.length,
        capabilities: screenshotCapabilities(useExtension),
    }
    if (args.compareWith) {
        if (screenshot.format !== 'png') {
            throw new Error('screenshot compare 仅支持 png 格式')
        }
        const baselinePath = await resolveScopedOutputPath(args.compareWith, 'mcp-chrome')
        const baseline = await readFile(baselinePath.absolutePath)
        const comparison = comparePngImages(baseline, screenshotBuffer)
        metadata.comparison = {
            pixelDiffRatio: comparison.pixelDiffRatio,
            differentPixels: comparison.differentPixels,
            totalPixels: comparison.totalPixels,
            width: comparison.width,
            height: comparison.height,
        }
        if (args.diffOutput) {
            const diffPath = await writeOutputFile(args.diffOutput, comparison.diffPng)
            metadata.comparison = { ...(metadata.comparison as Record<string, unknown>), diffOutput: diffPath }
        }
    }
    if (args.output) {
        const outputPath = await writeOutputFile(args.output, screenshotBuffer)
        return formatResponse({ success: true, type: 'screenshot', output: outputPath, metadata })
    }
    return {
        content: [
            { type: 'text', text: JSON.stringify({ success: true, type: 'screenshot', metadata }, null, 2) },
            {
                type: 'image',
                data: screenshot.data,
                mimeType: `image/${screenshot.format === 'jpeg' ? 'jpeg' : screenshot.format}`,
            },
        ],
    }
}

async function handleStateExtract(
    { unifiedSession, useExtension }: ExtractContext,
    args: ExtractArgs
): Promise<ExtractToolResponse> {
    if (args.mode === 'domsnapshot') {
        return handleDomSnapshotState(unifiedSession, useExtension, args)
    }

    let refId: string | undefined
    if (args.target && useExtension) {
        const { selector, text, xpath, nth: nthParam } = targetToFindParams(args.target as Target & { nth?: number })
        const nth = nthParam ?? 0
        const elements = await unifiedSession.find(selector, text, xpath)
        if (elements.length > 0 && nth < elements.length) {
            refId = elements[nth].refId
        }
    }

    const readPageOptions: { refId?: string; depth?: number } = {}
    if (refId) {
        readPageOptions.refId = refId
    }
    if (args.depth !== undefined) {
        readPageOptions.depth = args.depth
    }

    const state = await unifiedSession.readPage(Object.keys(readPageOptions).length > 0 ? readPageOptions : undefined)
    if (args.output) {
        const outputPath = await writeOutputFile(args.output, JSON.stringify(state, null, 2), 'utf-8')
        return formatResponse({ success: true, type: 'state', output: outputPath })
    }
    return formatResponse({ success: true, type: 'state', state })
}

async function handleDomSnapshotState(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    useExtension: boolean,
    args: ExtractArgs
): Promise<ExtractToolResponse> {
    if (useExtension) {
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        error: {
                            code: 'INVALID_ARGUMENT',
                            message: 'mode=domsnapshot 仅 CDP 模式支持，Extension 模式请用默认 accessibility',
                        },
                    }),
                },
            ],
            isError: true,
        }
    }
    const snapshot = await unifiedSession.sendCdpCommand('DOMSnapshot.captureSnapshot', {
        computedStyles: ['display', 'visibility', 'opacity'],
        includePaintOrder: false,
        includeDOMRects: true,
    })
    if (args.output) {
        const outputPath = await writeOutputFile(args.output, JSON.stringify(snapshot, null, 2), 'utf-8')
        return formatResponse({ success: true, type: 'state', mode: 'domsnapshot', output: outputPath })
    }
    return formatResponse({ success: true, type: 'state', mode: 'domsnapshot', snapshot })
}

async function handleDiagnosticBundleExtract(
    { unifiedSession, useExtension }: ExtractContext,
    args: ExtractArgs
): Promise<ExtractToolResponse> {
    const state = await unifiedSession.getLiveState().catch(() => null)
    const metadata = await unifiedSession.getMetadata()
    const frames = useExtension ? await unifiedSession.getFrames() : { frames: [] }
    await unifiedSession.enableConsole()
    await unifiedSession.enableNetwork()
    const consoleLogs = sanitizeUrlRecords(await unifiedSession.getConsoleLogs())
    const networkRequests = sanitizeUrlRecords(await unifiedSession.getNetworkRequests())
    const bundle = {
        schema: 'mcp-chrome.diagnosticBundle.v1',
        url: state?.url,
        title: state?.title,
        managed: state?.managed ?? false,
        mode: unifiedSession.getMode(),
        metadata,
        frames,
        consoleSummary: {
            total: consoleLogs.length,
            recentErrors: consoleLogs.filter((item) => ['error', 'warning', 'warn'].includes(item.level)).slice(-20),
        },
        networkSummary: {
            total: networkRequests.length,
            recentFailures: networkRequests
                .filter((item) => item.errorText || (item.status !== undefined && item.status >= 400))
                .slice(-20),
        },
        capabilities: {
            screenshot: true,
            hiddenTabScreenshot: useExtension,
            frames: useExtension,
        },
    }
    const summary = {
        url: bundle.url,
        title: bundle.title,
        managed: bundle.managed,
        mode: bundle.mode,
        frameCount: Array.isArray(frames.frames) ? frames.frames.length : 0,
        consoleErrors: bundle.consoleSummary.recentErrors.length,
        networkFailures: bundle.networkSummary.recentFailures.length,
    }
    if (args.output) {
        const outputPath = await writeOutputFile(args.output, JSON.stringify(bundle, null, 2), 'utf-8')
        return formatResponse({ success: true, type: 'diagnosticBundle', output: outputPath, summary })
    }
    return formatResponse({
        success: true,
        type: 'diagnosticBundle',
        summary: { ...summary, capabilities: bundle.capabilities },
        frames: bundle.frames,
        console: bundle.consoleSummary.recentErrors,
        failedRequests: bundle.networkSummary.recentFailures,
    })
}

async function handleMetadataExtract(
    { unifiedSession, useExtension }: ExtractContext,
    args: ExtractArgs
): Promise<ExtractToolResponse> {
    const metadata = await unifiedSession.getMetadata()
    const frames = useExtension ? await unifiedSession.getFrames() : { frames: [] }
    if (args.output) {
        const outputPath = await writeOutputFile(
            args.output,
            JSON.stringify({ ...metadata, ...frames }, null, 2),
            'utf-8'
        )
        return formatResponse({ success: true, type: 'metadata', output: outputPath })
    }
    return formatResponse({ success: true, type: 'metadata', ...metadata, ...frames })
}

function invalidExtractTypeResponse(args: ExtractArgs): ExtractToolResponse {
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    error: { code: 'INVALID_ARGUMENT', message: `未知提取类型: ${args.type}` },
                }),
            },
        ],
        isError: true,
    }
}

// ==================== HTML + 图片提取 ====================

/** 写入文件前自动创建父目录，并收敛到受控范围 */
async function writeOutputFile(path: string, data: string | Buffer, encoding?: BufferEncoding): Promise<string> {
    const resolvedPath = await resolveScopedOutputPath(path, 'mcp-chrome')
    await writePrivateFile(resolvedPath.absolutePath, data, encoding)
    return resolvedPath.absolutePath
}

interface PageScrollOffset {
    x: number
    y: number
}

async function getPageScrollOffset(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    timeout: number | undefined
): Promise<PageScrollOffset> {
    return unifiedSession.evaluate<PageScrollOffset>(
        '(() => ({ x: window.scrollX || 0, y: window.scrollY || 0 }))()',
        undefined,
        timeout
    )
}

interface ImageDimensions {
    width: number
    height: number
    source: 'encoded' | 'captureArea'
}

async function getScreenshotFallbackDimensions(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    clip: { x: number; y: number; width: number; height: number } | undefined,
    fullPage: boolean,
    scale: number,
    timeout: number | undefined
): Promise<ImageDimensions | undefined> {
    if (clip) {
        return {
            width: Math.round(clip.width * scale),
            height: Math.round(clip.height * scale),
            source: 'captureArea',
        }
    }
    try {
        const size = await unifiedSession.evaluate<{ width: number; height: number }>(
            fullPage
                ? '(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))()'
                : '(() => ({ width: window.innerWidth, height: window.innerHeight }))()',
            undefined,
            timeout
        )
        return {
            width: Math.round(size.width * scale),
            height: Math.round(size.height * scale),
            source: 'captureArea',
        }
    } catch {
        return undefined
    }
}

function screenshotCapabilities(useExtension: boolean): Record<string, unknown> {
    return {
        formats: ['png', 'jpeg', 'webp'],
        clip: true,
        fullPage: true,
        scale: true,
        hiddenTabScreenshot: useExtension,
        compare: {
            formats: ['png'],
            maxBytes: MAX_COMPARE_PNG_BYTES,
            maxPixels: MAX_COMPARE_PIXELS,
        },
    }
}

function readImageDimensions(buffer: Buffer, format: string, fallback?: ImageDimensions): ImageDimensions | undefined {
    try {
        if (format === 'png') {
            return { ...readPngHeader(buffer), source: 'encoded' }
        }
        if (format === 'jpeg') {
            const size = readJpegDimensions(buffer)
            return size ? { ...size, source: 'encoded' } : fallback
        }
        if (format === 'webp') {
            const size = readWebpDimensions(buffer)
            return size ? { ...size, source: 'encoded' } : fallback
        }
    } catch {
        return fallback
    }
    return fallback
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } | undefined {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
        return undefined
    }
    let offset = 2
    while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
            offset++
            continue
        }
        while (buffer[offset] === 0xff) {
            offset++
        }
        const marker = buffer[offset++]
        if (marker === 0xd9 || marker === 0xda) {
            return undefined
        }
        const segmentLength = buffer.readUInt16BE(offset)
        if (segmentLength < 2 || offset + segmentLength > buffer.length) {
            return undefined
        }
        if (
            (marker >= 0xc0 && marker <= 0xc3) ||
            (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) ||
            (marker >= 0xcd && marker <= 0xcf)
        ) {
            return {
                height: buffer.readUInt16BE(offset + 3),
                width: buffer.readUInt16BE(offset + 5),
            }
        }
        offset += segmentLength
    }
    return undefined
}

function readWebpDimensions(buffer: Buffer): { width: number; height: number } | undefined {
    if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
        return undefined
    }
    let offset = 12
    while (offset + 8 <= buffer.length) {
        const chunkType = buffer.toString('ascii', offset, offset + 4)
        const chunkSize = buffer.readUInt32LE(offset + 4)
        const data = offset + 8
        if (data + chunkSize > buffer.length) {
            return undefined
        }
        if (chunkType === 'VP8X' && chunkSize >= 10) {
            return {
                width: 1 + buffer.readUIntLE(data + 4, 3),
                height: 1 + buffer.readUIntLE(data + 7, 3),
            }
        }
        if (chunkType === 'VP8L' && chunkSize >= 5 && buffer[data] === 0x2f) {
            const bits = buffer.readUInt32LE(data + 1)
            return {
                width: (bits & 0x3fff) + 1,
                height: ((bits >> 14) & 0x3fff) + 1,
            }
        }
        if (
            chunkType === 'VP8 ' &&
            chunkSize >= 10 &&
            buffer[data + 3] === 0x9d &&
            buffer[data + 4] === 0x01 &&
            buffer[data + 5] === 0x2a
        ) {
            return {
                width: buffer.readUInt16LE(data + 6) & 0x3fff,
                height: buffer.readUInt16LE(data + 8) & 0x3fff,
            }
        }
        offset += 8 + chunkSize + (chunkSize % 2)
    }
    return undefined
}

/**
 * 处理 html + images 提取
 */
async function handleHtmlWithImages(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    session: ReturnType<typeof getSession>,
    useExtension: boolean,
    args: z.infer<typeof extractSchema>
): Promise<{
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
    isError?: boolean
}> {
    const { selector, nth: nthParam } = args.target
        ? targetToFindParams(args.target as Target & { nth?: number })
        : { selector: undefined, nth: undefined }
    const nth = nthParam ?? 0

    let result: { html: string; images: ImageInfo[] }

    if (selector && nth > 0) {
        // nth > 0：用 evaluate 取第 N 个匹配元素
        result = await unifiedSession.evaluate<{ html: string; images: ImageInfo[] }>(
            `(function(s, n) {
                var els = document.querySelectorAll(s);
                if (n >= els.length) return {html: '', images: []};
                var root = els[n];
                var html = root.outerHTML;
                var imgList = [];
                if (root.tagName === 'IMG') imgList.push(root);
                root.querySelectorAll('img').forEach(function(img) { imgList.push(img); });
                var images = [];
                for (var i = 0; i < imgList.length; i++) {
                    var img = imgList[i];
                    images.push({index: i, src: img.src, dataSrc: (function() {
                        var raw = img.dataset.src || img.dataset.lazySrc || img.dataset.original || '';
                        if (!raw) return ''; try { return new URL(raw, location.href).href } catch(e) { return raw }
                    })(), alt: img.alt, width: img.width, height: img.height,
                        naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight});
                }
                return {html: html, images: images};
            })`,
            undefined,
            undefined,
            [selector, nth]
        )
    } else {
        result = useExtension
            ? await unifiedSession.getHtmlWithImages(selector)
            : await extractHtmlWithImagesCdp(session, selector, args.timeout)
    }

    if (args.images === 'info') {
        // info 模式：HTML + 图片元信息
        const payload = { type: 'html' as const, content: result.html, images: result.images }
        if (args.output) {
            const outputPath = await writeOutputFile(args.output, JSON.stringify(payload, null, 2), 'utf-8')
            return formatResponse({
                success: true,
                type: 'html',
                output: outputPath,
                imageCount: result.images.length,
            })
        }
        return formatResponse({
            success: true,
            ...payload,
        })
    }

    // data 模式：获取图片数据
    const appendixMode = !args.output
    const imageDataList = await fetchImageData(
        unifiedSession,
        result.images,
        appendixMode ? MAX_APPENDIX_IMAGES : undefined
    )

    if (args.output) {
        const outputDir = (await resolveScopedOutputPath(args.output, 'mcp-chrome')).absolutePath
        // 写入目录
        await writeImageDirectory(outputDir, result.html, result.images, imageDataList)
        return formatResponse({
            success: true,
            type: 'html',
            output: outputDir,
            imageCount: result.images.length,
            index: join(outputDir, 'index.json'),
        })
    }

    // 无 output：MCP 附录方式返回
    return buildImageAppendixResponse(result.html, result.images, imageDataList)
}

/**
 * CDP 模式：提取 HTML + 图片元信息
 */
async function extractHtmlWithImagesCdp(
    session: ReturnType<typeof getSession>,
    selector?: string,
    timeout?: number
): Promise<{ html: string; images: ImageInfo[] }> {
    if (selector) {
        const locator = session.createLocator({ css: selector }, timeout !== undefined ? { timeout } : undefined)
        return locator.evaluateOn<{ html: string; images: ImageInfo[] }>(`function() {
            var html = this.outerHTML;
            var imgList = [];
            if (this.tagName === 'IMG') imgList.push(this);
            this.querySelectorAll('img').forEach(function(img) { imgList.push(img); });
            var images = [];
            for (var i = 0; i < imgList.length; i++) {
                var img = imgList[i];
                images.push({index: i, src: img.src, dataSrc: (function() {
                    var raw = img.dataset.src || img.dataset.lazySrc || img.dataset.original || '';
                    if (!raw) return ''; try { return new URL(raw, location.href).href } catch(e) { return raw }
                })(), alt: img.alt, width: img.width, height: img.height,
                    naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight});
            }
            return {html: html, images: images};
        }`)
    }

    return session.evaluate<{ html: string; images: ImageInfo[] }>(`(function() {
        var html = document.documentElement.outerHTML;
        var imgs = document.querySelectorAll('img');
        var images = [];
        for (var i = 0; i < imgs.length; i++) {
            var img = imgs[i];
            images.push({index: i, src: img.src, dataSrc: (function() {
                var raw = img.dataset.src || img.dataset.lazySrc || img.dataset.original || '';
                if (!raw) return ''; try { return new URL(raw, location.href).href } catch(e) { return raw }
            })(), alt: img.alt, width: img.width, height: img.height,
                naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight});
        }
        return {html: html, images: images};
    })()`)
}

/**
 * 获取图片数据
 *
 * 策略：
 * 1. data: URL → 直接解码
 * 2. CDP Page.getResourceContent（批量） → 从浏览器缓存读取（零网络请求）
 *
 * @param unifiedSession 会话管理器，用于 CDP 资源获取
 * @param images 图片元信息列表
 * @param limit 最多获取前 N 张图片数据（附录模式限流），超出的返回 null
 */
async function fetchImageData(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    images: ImageInfo[],
    limit?: number
): Promise<ImageData[]> {
    const effectiveLimit = limit ?? images.length

    // 第一趟：解析 data: URL + 收集需要 CDP 获取的 URL（去重）
    const preResolved: (ImageData | null)[] = []
    const cdpUrlSet = new Set<string>()
    for (let i = 0; i < images.length; i++) {
        const img = images[i]
        const effectiveSrc = img.src || img.dataSrc

        if (i >= effectiveLimit || !effectiveSrc) {
            preResolved.push({ base64: null, mimeType: 'image/png' })
            continue
        }

        if (effectiveSrc.startsWith('data:')) {
            const match = effectiveSrc.match(/^data:(?<mime>[^;]+);base64,(?<data>.+)$/)
            preResolved.push(
                match
                    ? { base64: match.groups!.data, mimeType: match.groups!.mime }
                    : { base64: null, mimeType: 'image/png' }
            )
            continue
        }

        if (!effectiveSrc.startsWith('http')) {
            preResolved.push({ base64: null, mimeType: guessMimeType(effectiveSrc) })
            continue
        }

        // 只有 src 非空（浏览器实际请求过的）才走 CDP 缓存
        if (img.src) {
            cdpUrlSet.add(img.src)
        }
        preResolved.push(null) // 需要进一步获取
    }

    // 第二趟：批量 CDP 获取
    const cdpResults = await unifiedSession.getResourceContentBatch([...cdpUrlSet])

    // 第三趟：组装结果，CDP 未命中的返回 null
    const results: ImageData[] = []

    for (let i = 0; i < images.length; i++) {
        if (preResolved[i] !== null) {
            results.push(preResolved[i]!)
            continue
        }

        const img = images[i]
        const effectiveSrc = img.src || img.dataSrc
        const mimeType = guessMimeType(effectiveSrc)

        // 尝试 CDP 缓存
        if (img.src && cdpResults.has(img.src)) {
            const resource = cdpResults.get(img.src)!
            if (resource.base64Encoded) {
                results.push({ base64: resource.content, mimeType })
            } else {
                results.push({ base64: Buffer.from(resource.content).toString('base64'), mimeType })
            }
            continue
        }

        // CDP 缓存未命中，不使用 Node.js fetch（避免绕过浏览器同源策略）
        results.push({ base64: null, mimeType })
    }

    return results
}

/**
 * 写入图片目录
 *
 * 生成结构：
 *   {output}/
 *     content.html
 *     images/
 *       0-photo.jpg
 *       1-icon.png
 *     index.json
 */
async function writeImageDirectory(
    outputDir: string,
    html: string,
    images: ImageInfo[],
    imageDataList: ImageData[]
): Promise<void> {
    const imagesDir = join(outputDir, 'images')

    // 写入 HTML
    await writePrivateFile(join(outputDir, 'content.html'), html, 'utf-8')

    // 写入图片文件 + 构建索引（相同 src 去重）
    const indexEntries: Array<{
        index: number
        src: string
        alt: string
        width: number
        height: number
        file: string | null
    }> = []
    const writtenFiles = new Map<string, string>() // src → file path

    for (let i = 0; i < images.length; i++) {
        const img = images[i]
        const data = imageDataList[i]
        const src = img.src || img.dataSrc
        let file: string | null = null

        if (data.base64) {
            // 相同 src 复用已写入的文件
            const existing = writtenFiles.get(src)
            if (existing) {
                file = existing
            } else {
                const ext = mimeToExt(data.mimeType)
                const safeName = sanitizeFilename(src)
                const filename = `${i}-${safeName}${ext}`
                file = `images/${filename}`
                await writePrivateFile(join(imagesDir, filename), Buffer.from(data.base64, 'base64'))
                writtenFiles.set(src, file)
            }
        }

        indexEntries.push({
            index: img.index,
            src: img.src || img.dataSrc,
            alt: img.alt,
            width: img.width,
            height: img.height,
            file,
        })
    }

    // 写入索引
    await writePrivateFile(
        join(outputDir, 'index.json'),
        JSON.stringify(
            {
                html: 'content.html',
                images: indexEntries,
            },
            null,
            2
        ),
        'utf-8'
    )
}

/**
 * 构造附录式 MCP 响应
 *
 * 返回格式：
 * [text: JSON summary]
 * [text: --- Images ---]
 * [text: [0] url  alt  WxH]
 * [image: base64 data]
 * ...
 */
function buildImageAppendixResponse(
    html: string,
    images: ImageInfo[],
    imageDataList: ImageData[]
): {
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
} {
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []

    // 主体 JSON
    content.push({
        type: 'text',
        text: JSON.stringify({
            success: true,
            type: 'html',
            content: html,
            imageCount: images.length,
        }),
    })

    if (images.length === 0) {
        return { content }
    }

    content.push({ type: 'text', text: '\n--- Images ---' })

    /** Claude API 支持的 image block 格式 */
    const SUPPORTED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

    const limit = Math.min(images.length, MAX_APPENDIX_IMAGES)
    for (let i = 0; i < images.length; i++) {
        const img = images[i]
        const data = imageDataList[i]
        const effectiveSrc = img.src || img.dataSrc

        // 图片标注
        const sizeStr = img.naturalWidth ? `${img.naturalWidth}×${img.naturalHeight}` : `${img.width}×${img.height}`
        const altStr = img.alt ? `  alt="${img.alt}"` : ''
        content.push({ type: 'text', text: `\n[${img.index}] ${effectiveSrc}${altStr}  ${sizeStr}` })

        // 在限制内且有数据时附带图片（SVG 等不支持的格式跳过 image block）
        if (i < limit && data.base64 && SUPPORTED_IMAGE_MIMES.has(data.mimeType)) {
            content.push({ type: 'image', data: data.base64, mimeType: data.mimeType })
        }
    }

    if (images.length > MAX_APPENDIX_IMAGES) {
        content.push({
            type: 'text',
            text: `\n（共 ${images.length} 张图片，仅前 ${MAX_APPENDIX_IMAGES} 张附带数据，使用 output 参数导出全部图片）`,
        })
    }

    return { content }
}

// ==================== MIME / 文件名工具 ====================

/** 从 URL 或扩展名推断 MIME 类型 */
function guessMimeType(url: string): string {
    let ext: string
    try {
        ext = extname(new URL(url, 'http://x').pathname).toLowerCase()
    } catch {
        return 'image/png'
    }
    const map: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.bmp': 'image/bmp',
        '.avif': 'image/avif',
    }
    return map[ext] ?? 'image/png'
}

/** MIME 类型转文件扩展名 */
function mimeToExt(mimeType: string): string {
    const map: Record<string, string> = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/svg+xml': '.svg',
        'image/x-icon': '.ico',
        'image/bmp': '.bmp',
        'image/avif': '.avif',
    }
    return map[mimeType] ?? '.png'
}

/** 从 URL 提取安全的文件名片段 */
function sanitizeFilename(url: string): string {
    try {
        const name = basename(new URL(url, 'http://x').pathname)
        // 去掉扩展名，只保留字母数字和连字符
        const stem = name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_')
        return stem.substring(0, 40) || 'image'
    } catch {
        return 'image'
    }
}

// ==================== 原有提取函数 ====================

/**
 * 提取文本内容
 */
async function extractText(session: ReturnType<typeof getSession>, target?: Target, timeout?: number): Promise<string> {
    if (target) {
        const locator = session.createLocator(target, timeout !== undefined ? { timeout } : undefined)
        const text = await locator.evaluateOn<string>(`function() {
      return this.textContent ?? '';
    }`)
        return text ?? ''
    }

    return session.evaluate<string>('document.body.innerText')
}

/**
 * 提取 HTML
 */
async function extractHTML(session: ReturnType<typeof getSession>, target?: Target, timeout?: number): Promise<string> {
    if (target) {
        const locator = session.createLocator(target, timeout !== undefined ? { timeout } : undefined)
        return await locator.evaluateOn<string>(`function() {
      return this.outerHTML;
    }`)
    }

    return session.evaluate<string>('document.documentElement.outerHTML')
}

/**
 * 提取属性
 */
async function extractAttribute(
    session: ReturnType<typeof getSession>,
    target: Target,
    attribute: string,
    timeout?: number
): Promise<string | null> {
    const locator = session.createLocator(target, timeout !== undefined ? { timeout } : undefined)

    // computed style: computed:color → getComputedStyle(el).color
    if (attribute.startsWith('computed:')) {
        const prop = attribute.slice('computed:'.length)
        if (prop === '*') {
            return locator.evaluateOn<string>(`function() {
        var cs = window.getComputedStyle(this);
        var obj = {};
        for (var i = 0; i < cs.length; i++) { obj[cs[i]] = cs.getPropertyValue(cs[i]); }
        return JSON.stringify(obj);
      }`)
        }
        return locator.evaluateOn<string | null>(`function() {
      return window.getComputedStyle(this).getPropertyValue(${JSON.stringify(prop)});
    }`)
    }

    // 使用 JSON.stringify 安全转义属性名，防止 JS 注入
    return locator.evaluateOn<string | null>(`function() {
    return this.getAttribute(${JSON.stringify(attribute)});
  }`)
}

/**
 * Extension 模式：提取文本
 * 支持所有 Target 形式（css/xpath/text/role/label 等）
 */
async function extractTextExtension(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    target?: Target
): Promise<string> {
    if (!target) {
        return unifiedSession.getText()
    }
    if ('x' in target && 'y' in target && typeof target.x === 'number' && typeof target.y === 'number') {
        const expr =
            '(function(x, y) { var el = document.elementFromPoint(x, y); ' +
            "return el ? (el.textContent || '') : '' })"
        return unifiedSession.evaluate<string>(expr, undefined, undefined, [target.x, target.y])
    }
    const { selector, text, xpath, nth: nthParam } = targetToFindParams(target as Target & { nth?: number })
    const nth = nthParam ?? 0

    if (selector) {
        if (text) {
            const expr =
                '(function(s, t, n) { var els = Array.from(document.querySelectorAll(s))' +
                '.filter(function(e) { return (e.textContent || "").includes(t); }); ' +
                "return n < els.length ? (els[n].textContent || '') : '' })"
            return unifiedSession.evaluate<string>(expr, undefined, undefined, [selector, text, nth])
        }
        if (nth > 0) {
            const expr =
                '(function(s, n) { var els = document.querySelectorAll(s); ' +
                "return n < els.length ? (els[n].textContent || '') : '' })"
            return unifiedSession.evaluate<string>(expr, undefined, undefined, [selector, nth])
        }
        return unifiedSession.getText(selector)
    }

    // xpath/text 定位：通过 evaluate 在页面上下文中查找
    if (xpath) {
        const expr =
            '(function(xp, n) { var r = document.evaluate(xp, document, null, ' +
            'XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); ' +
            "return n < r.snapshotLength ? (r.snapshotItem(n).textContent || '') : '' })"
        return unifiedSession.evaluate<string>(expr, undefined, undefined, [xpath, nth])
    }
    if (text) {
        const expr =
            '(function(t, n) { var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); ' +
            'var found = []; var seen = new WeakSet(); var node; ' +
            'while ((node = walker.nextNode())) { if (node.textContent && node.textContent.includes(t) ' +
            '&& node.parentElement && !seen.has(node.parentElement)) { ' +
            'seen.add(node.parentElement); found.push(node.parentElement); } } ' +
            "return n < found.length ? (found[n].textContent || '') : '' })"
        return unifiedSession.evaluate<string>(expr, undefined, undefined, [text, nth])
    }
    return unifiedSession.getText()
}

/**
 * Extension 模式：提取 HTML
 * 支持所有 Target 形式（css/xpath/text/role/label 等）
 */
async function extractHtmlExtension(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    target?: Target,
    outer = true
): Promise<string> {
    if (!target) {
        return unifiedSession.getHtml(undefined, outer)
    }
    const prop = outer ? 'outerHTML' : 'innerHTML'
    if ('x' in target && 'y' in target && typeof target.x === 'number' && typeof target.y === 'number') {
        const expr =
            '(function(x, y, p) { var el = document.elementFromPoint(x, y); ' + "return el ? (el[p] || '') : '' })"
        return unifiedSession.evaluate<string>(expr, undefined, undefined, [target.x, target.y, prop])
    }
    const { selector, text, xpath, nth: nthParam } = targetToFindParams(target as Target & { nth?: number })
    const nth = nthParam ?? 0

    if (selector) {
        if (text) {
            const expr =
                '(function(s, t, n, p) { var els = Array.from(document.querySelectorAll(s))' +
                '.filter(function(e) { return (e.textContent || "").includes(t); }); ' +
                "return n < els.length ? (els[n][p] || '') : '' })"
            return unifiedSession.evaluate<string>(expr, undefined, undefined, [selector, text, nth, prop])
        }
        if (nth > 0) {
            const expr =
                '(function(s, n, p) { var els = document.querySelectorAll(s); ' +
                "return n < els.length ? (els[n][p] || '') : '' })"
            return unifiedSession.evaluate<string>(expr, undefined, undefined, [selector, nth, prop])
        }
        return unifiedSession.getHtml(selector, outer)
    }

    if (xpath) {
        const expr =
            '(function(xp, n, p) { var r = document.evaluate(xp, document, null, ' +
            'XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); ' +
            "return n < r.snapshotLength ? (r.snapshotItem(n)[p] || '') : '' })"
        return unifiedSession.evaluate<string>(expr, undefined, undefined, [xpath, nth, prop])
    }
    if (text) {
        const expr =
            '(function(t, n, p) { var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); ' +
            'var found = []; var seen = new WeakSet(); var node; ' +
            'while ((node = walker.nextNode())) { if (node.textContent && node.textContent.includes(t) ' +
            '&& node.parentElement && !seen.has(node.parentElement)) { ' +
            'seen.add(node.parentElement); found.push(node.parentElement); } } ' +
            "return n < found.length ? (found[n][p] || '') : '' })"
        return unifiedSession.evaluate<string>(expr, undefined, undefined, [text, nth, prop])
    }
    return unifiedSession.getHtml(undefined, outer)
}

/**
 * Extension 模式：提取属性
 */
async function extractAttributeExtension(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    target: Target,
    attribute: string
): Promise<string | null> {
    if ('x' in target && 'y' in target && typeof target.x === 'number' && typeof target.y === 'number') {
        if (attribute.startsWith('computed:')) {
            const prop = attribute.slice('computed:'.length)
            const expr =
                '(function(x, y, p) { var el = document.elementFromPoint(x, y); ' +
                'return el ? window.getComputedStyle(el).getPropertyValue(p) : null })'
            return unifiedSession.evaluate<string | null>(expr, undefined, undefined, [target.x, target.y, prop])
        }
        const expr =
            '(function(x, y, a) { var el = document.elementFromPoint(x, y); ' +
            'return el ? el.getAttribute(a) : null })'
        return unifiedSession.evaluate<string | null>(expr, undefined, undefined, [target.x, target.y, attribute])
    }
    const { selector, text, xpath, nth: nthParam } = targetToFindParams(target as Target & { nth?: number })

    // computed style: computed:color → getComputedStyle(el)
    if (attribute.startsWith('computed:')) {
        const prop = attribute.slice('computed:'.length)
        return extractComputedStyleExtension(unifiedSession, selector, text, xpath, nthParam ?? 0, prop)
    }

    // xpath 定位（含 text+xpath）或 text 且无 selector 时：先 find 得到 refId，再获取属性
    if (xpath || (text && !selector)) {
        const elements = await unifiedSession.find(selector, text, xpath)
        if (elements.length > 0) {
            const nth = nthParam ?? 0
            if (nth >= elements.length) {
                throw new Error(`第 ${nth} 个匹配元素不存在（共 ${elements.length} 个）`)
            }
            return unifiedSession.getAttribute(undefined, elements[nth].refId, attribute)
        }
        return null
    }

    if (selector) {
        const nth = nthParam ?? 0
        if (text) {
            // selector + text 组合：find 已实现 AND 过滤
            const elements = await unifiedSession.find(selector, text, undefined)
            if (nth >= elements.length) {
                return null
            }
            return unifiedSession.getAttribute(undefined, elements[nth].refId, attribute)
        }
        if (nth > 0) {
            const expr =
                '(function(s, n, a) { var els = document.querySelectorAll(s); ' +
                'return n < els.length ? els[n].getAttribute(a) : null })'
            return unifiedSession.evaluate<string | null>(expr, undefined, undefined, [selector, nth, attribute])
        }
        return unifiedSession.getAttribute(selector, undefined, attribute)
    }

    return null
}

/**
 * Extension 模式：提取 computed style
 */
async function extractComputedStyleExtension(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    selector: string | undefined,
    text: string | undefined,
    xpath: string | undefined,
    nth: number,
    prop: string
): Promise<string | null> {
    const elements = await unifiedSession.find(selector, text, xpath)
    if (elements.length === 0 || nth >= elements.length) {
        return null
    }
    const refId = elements[nth].refId

    // 通过 Extension ISOLATED 世界执行（访问 __mcpElementMap），避免 MAIN 世界找不到 refId
    return unifiedSession.getComputedStyle(refId, prop)
}

/**
 * Extension 模式：等待目标元素出现
 *
 * 在 extract 操作前轮询 find()，直到找到匹配元素或超时，
 * 用于实现 extract 的 timeout 参数语义
 */
async function waitForTargetExtension(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    target: Target,
    timeout: number,
    frame?: string | number
): Promise<void> {
    if ('x' in target && 'y' in target) {
        return
    }

    const startTime = Date.now()
    const retryDelay = 100
    const { selector, text, xpath, nth: nthParam } = targetToFindParams(target as Target & { nth?: number })
    const nth = nthParam ?? 0
    let lastError: Error | null = null
    let matchCount = 0
    let candidates: Array<{
        tag: string
        text: string
        rect: { x: number; y: number; width: number; height: number }
    }> = []

    while (true) {
        const elapsed = Date.now() - startTime
        if (elapsed >= timeout) {
            throw new TargetTimeoutError(
                await buildTargetDiagnostics(unifiedSession, target, {
                    nth,
                    timeout,
                    frame,
                    matchCount,
                    lastState: 'attached',
                    lastError,
                    candidates,
                })
            )
        }

        const remaining = timeout - elapsed
        if (!unifiedSession.isExtensionConnected()) {
            lastError = new Error('Extension 未连接')
            await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelay, remaining)))
            continue
        }

        try {
            const elements = await unifiedSession.find(selector, text, xpath, remaining)
            matchCount = elements.length
            candidates = elements
            if (elements.length > nth) {
                return
            }
        } catch (err) {
            // 暂时性错误（RPC 超时、发送失败、连接断开）可重试，其他确定性错误立即抛出
            if (
                err instanceof Error &&
                /Request timeout|Failed to send|disconnect|未连接|stopped|replaced/i.test(err.message)
            ) {
                lastError = err
                const retryRemaining = timeout - (Date.now() - startTime)
                if (retryRemaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelay, retryRemaining)))
                }
                continue
            }
            throw err
        }

        const retryRemaining = timeout - (Date.now() - startTime)
        if (retryRemaining > 0) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelay, retryRemaining)))
        }
    }
}

/**
 * 注册 extract 工具
 */
export function registerExtractTool(server: McpServer): void {
    server.registerTool(
        'extract',
        {
            description: `提取页面内容：文本、HTML（可附带图片）、iframe HTML、属性、截图、状态、页面元信息`,
            inputSchema: extractSchema,
        },
        (args) => handleExtract(args)
    )
}
