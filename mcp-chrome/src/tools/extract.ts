/**
 * extract 工具
 *
 * 提取页面内容：
 * - text: 文本内容
 * - html: HTML 源码（可选附带图片元信息或图片数据）
 * - attribute: 元素属性
 * - screenshot: 截图
 * - state: 页面状态（精简的可交互元素列表）
 * - metadata: 页面元信息（title/og/jsonLd 等）
 */

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {mkdir, writeFile} from 'fs/promises'
import {basename, dirname, extname, join} from 'path'
import {z} from 'zod'
import {formatErrorResponse, formatResponse, getSession, getUnifiedSession} from '../core/index.js'
import type {Target} from '../core/types.js'
import {targetToFindParams, targetZodSchema} from './schema.js'

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
                                   type: z.enum(['text', 'html', 'attribute', 'screenshot', 'state', 'metadata'])
                                          .describe('提取类型'),
                                   target: targetZodSchema.optional().describe(
                                       '目标元素（attribute 必填；text/html 可选，省略则提取整个页面；screenshot 可选用于元素截图；state 可选（仅 Extension）用于返回目标子树；metadata 不需要）'),
                                   attribute: z.string().optional().describe('属性名（attribute）'),
                                   images: z.enum(['info', 'data']).optional().describe(
                                       '图片提取模式（仅 html 类型有效）。info: 元信息（src/alt/尺寸）；data: 含图片数据'),
                                   fullPage: z.boolean().optional().describe('是否全页面截图（screenshot）'),
                                   scale: z.number().optional().describe(
                                       '截图缩放比例（screenshot fullPage）。默认 1，设为 0.5 可降低分辨率加速大页面截图'),
                                   format: z.enum(['png', 'jpeg', 'webp']).optional().describe(
                                       '截图格式（screenshot）。默认 png，jpeg/webp 体积更小，复杂页面推荐 jpeg 减少超时'),
                                   quality: z.number().min(0).max(100).optional().describe(
                                       '截图质量（screenshot，仅 jpeg/webp 有效）。0-100，推荐 80'),
                                   output: z.string()
                                            .optional()
                                            .describe('输出文件路径（可选）。若指定，结果写入文件；否则返回内容。images=data 时作为输出目录路径'),
                                   tabId: z.string().optional().describe(
                                       '目标 Tab ID（可选，仅 Extension 模式）。不指定则使用当前 attach 的 tab。可操作非当前 attach 的 tab。CDP 模式下不支持此参数'),
                                   timeout: z.number().optional().describe('等待目标元素超时'),
                                   frame: z.union([z.string(), z.number()]).optional().describe(
                                       'iframe 定位（可选，仅 Extension 模式）。CSS 选择器（如 "iframe#main"）或索引（如 0）。不指定则在主框架操作'),
                               })

/**
 * extract 工具处理器
 */
async function handleExtract(args: z.infer<typeof extractSchema>): Promise<{
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
    isError?: boolean;
}> {
    try {
        const unifiedSession = getUnifiedSession()
        const useExtension   = unifiedSession.isExtensionConnected()
        const session        = getSession()

        // 多 tab 并行：临时切换到指定 tab
        return await unifiedSession.withTabId(args.tabId, async () => {
            return await unifiedSession.withFrame(args.frame, async () => {

                // Extension 路径：等待目标元素出现（如果指定了 target + timeout）
                if (useExtension && args.target && args.timeout !== undefined) {
                    await waitForTargetExtension(unifiedSession, args.target, args.timeout)
                }

                switch (args.type) {
                    case 'text': {
                        const text = useExtension
                                     ? await extractTextExtension(unifiedSession, args.target)
                                     : await extractText(session, args.target, args.timeout)
                        if (args.output) {
                            await writeOutputFile(args.output, text, 'utf-8')
                            return formatResponse({
                                                      success: true,
                                                      type: 'text',
                                                      output: args.output,
                                                      size: text.length,
                                                  })
                        }
                        return formatResponse({
                                                  success: true,
                                                  type: 'text',
                                                  content: text,
                                              })
                    }

                    case 'html': {
                        // 带图片提取的增强路径
                        if (args.images) {
                            return await handleHtmlWithImages(unifiedSession, session, useExtension, args)
                        }

                        // 原有路径：纯 HTML
                        const html = useExtension
                                     ? await extractHtmlExtension(unifiedSession, args.target)
                                     : await extractHTML(session, args.target, args.timeout)
                        if (args.output) {
                            await writeOutputFile(args.output, html, 'utf-8')
                            return formatResponse({
                                                      success: true,
                                                      type: 'html',
                                                      output: args.output,
                                                      size: html.length,
                                                  })
                        }
                        return formatResponse({
                                                  success: true,
                                                  type: 'html',
                                                  content: html,
                                              })
                    }

                    case 'attribute': {
                        if (!args.target) {
                            return {
                                content: [
                                    {
                                        type: 'text',
                                        text: JSON.stringify({
                                                                 error: {
                                                                     code: 'INVALID_ARGUMENT',
                                                                     message: 'attribute 提取需要 target 参数',
                                                                 },
                                                             }),
                                    },
                                ],
                                isError: true,
                            }
                        }
                        if (!args.attribute) {
                            return {
                                content: [
                                    {
                                        type: 'text',
                                        text: JSON.stringify({
                                                                 error: {
                                                                     code: 'INVALID_ARGUMENT',
                                                                     message: 'attribute 提取需要 attribute 参数',
                                                                 },
                                                             }),
                                    },
                                ],
                                isError: true,
                            }
                        }

                        let value: string | null
                        if (useExtension) {
                            value = await extractAttributeExtension(unifiedSession, args.target, args.attribute)
                        } else {
                            value = await extractAttribute(session, args.target, args.attribute, args.timeout)
                        }

                        return formatResponse({
                                                  success: true,
                                                  type: 'attribute',
                                                  attribute: args.attribute,
                                                  value,
                                              })
                    }

                    case 'screenshot': {
                        // 有 target 时获取元素区域用于裁剪（支持所有 target 类型）
                        let clip: { x: number; y: number; width: number; height: number } | undefined
                        if (args.target) {
                            if (useExtension) {
                                const {selector, text, xpath, nth: nthParam} = targetToFindParams(args.target as Target & { nth?: number })
                                const nth = nthParam ?? 0
                                const found = await unifiedSession.find(selector, text, xpath)
                                if (found.length > nth) {
                                    const rect = found[nth].rect
                                    if (rect.width > 0 && rect.height > 0) {
                                        // find() 返回视口绝对坐标（已包含 iframe 坐标修正）
                                        clip = rect
                                    }
                                }
                            } else {
                                const {selector, text, xpath, nth: nthParam} = targetToFindParams(args.target as Target & { nth?: number })
                                const nth = nthParam ?? 0
                                const rect = await session.evaluate<{ x: number; y: number; width: number; height: number } | null>(
                                    `function(selector, text, xpath, nth) {
                                        function toRect(el) {
                                            var r = el.getBoundingClientRect();
                                            return {x: r.x, y: r.y, width: r.width, height: r.height};
                                        }

                                        function findByXPath(xp, n) {
                                            var r = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                                            return r.snapshotLength > n ? r.snapshotItem(n) : null;
                                        }

                                        function findBySelector(sel, txt, n) {
                                            var els = document.querySelectorAll(sel);
                                            var matchCount = 0;
                                            for (var i = 0; i < els.length; ++i) {
                                                var el = els[i];
                                                if (txt) {
                                                    var content = (el.textContent || '').trim();
                                                    if (!content.includes(txt)) continue;
                                                }
                                                if (matchCount < n) { ++matchCount; continue; }
                                                return el;
                                            }
                                            return null;
                                        }

                                        function findByText(txt, n) {
                                            var root = document.body || document.documentElement;
                                            if (!root) return null;
                                            var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
                                            var matchCount = 0;
                                            var el = walker.currentNode;
                                            while (el) {
                                                var content = (el.textContent || '').trim();
                                                if (content && content.includes(txt)) {
                                                    if (matchCount < n) { ++matchCount; }
                                                    else { return el; }
                                                }
                                                el = walker.nextNode();
                                            }
                                            return null;
                                        }

                                        var el = null;
                                        if (xpath) {
                                            el = findByXPath(xpath, nth);
                                        } else if (selector) {
                                            el = findBySelector(selector, text, nth);
                                        } else if (text) {
                                            el = findByText(text, nth);
                                        }

                                        return el ? toRect(el) : null;
                                    }`,
                                    [selector ?? null, text ?? null, xpath ?? null, nth],
                                )
                                if (rect && rect.width > 0 && rect.height > 0) {
                                    clip = rect
                                }
                            }
                        }

                        const base64 = await unifiedSession.screenshot({
                                                                           fullPage: clip ? false : (args.fullPage ?? false),
                                                                           scale: args.scale,
                                                                           format: args.format,
                                                                           quality: args.quality,
                                                                           clip,
                                                                       })
                        if (args.output) {
                            // 写入文件
                            await writeOutputFile(args.output, Buffer.from(base64, 'base64'))
                            return formatResponse({
                                                      success: true,
                                                      type: 'screenshot',
                                                      output: args.output,
                                                  })
                        }
                        // 返回 base64 图片
                        return {
                            content: [
                                {
                                    type: 'image',
                                    data: base64,
                                    mimeType: `image/${args.format === 'jpeg' ? 'jpeg' : args.format ?? 'png'}`,
                                },
                            ],
                        }
                    }

                    case 'state': {
                        // 有 target 时获取子树的无障碍状态
                        let refId: string | undefined
                        if (args.target && useExtension) {
                            const {selector, text, xpath, nth: nthParam} = targetToFindParams(args.target as Target & { nth?: number })
                            const nth = nthParam ?? 0
                            const elements = await unifiedSession.find(selector, text, xpath)
                            if (elements.length > 0 && nth < elements.length) {
                                refId = elements[nth].refId
                            }
                        }

                        const state = await unifiedSession.readPage(refId ? {refId} : undefined)
                        if (args.output) {
                            await writeOutputFile(args.output, JSON.stringify(state, null, 2), 'utf-8')
                            return formatResponse({
                                                      success: true,
                                                      type: 'state',
                                                      output: args.output,
                                                  })
                        }
                        return formatResponse({
                                                  success: true,
                                                  type: 'state',
                                                  state,
                                              })
                    }

                    case 'metadata': {
                        const metadata = await unifiedSession.getMetadata()
                        if (args.output) {
                            await writeOutputFile(args.output, JSON.stringify(metadata, null, 2), 'utf-8')
                            return formatResponse({
                                                      success: true,
                                                      type: 'metadata',
                                                      output: args.output,
                                                  })
                        }
                        return formatResponse({
                                                  success: true,
                                                  type: 'metadata',
                                                  ...metadata,
                                              })
                    }

                    default:
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                                             error: {
                                                                 code: 'INVALID_ARGUMENT',
                                                                 message: `未知提取类型: ${args.type}`,
                                                             },
                                                         }),
                                },
                            ],
                            isError: true,
                        }
                }

            }) // withFrame
        }) // withTabId
    } catch (error) {
        return formatErrorResponse(error)
    }
}

// ==================== HTML + 图片提取 ====================

/** 写入文件前自动创建父目录 */
async function writeOutputFile(path: string, data: string | Buffer, encoding?: BufferEncoding): Promise<void> {
    await mkdir(dirname(path), {recursive: true})
    await writeFile(path, data, encoding)
}

/**
 * 处理 html + images 提取
 */
async function handleHtmlWithImages(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    session: ReturnType<typeof getSession>,
    useExtension: boolean,
    args: z.infer<typeof extractSchema>,
): Promise<{
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
    isError?: boolean;
}> {
    const {selector, nth: nthParam} = args.target
                                      ? targetToFindParams(args.target as Target & { nth?: number })
                                      : {selector: undefined, nth: undefined}
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
                    images.push({index: i, src: img.src, dataSrc: (function() { var raw = img.dataset.src || img.dataset.lazySrc || img.dataset.original || ''; if (!raw) return ''; try { return new URL(raw, location.href).href } catch(e) { return raw } })(), alt: img.alt, width: img.width, height: img.height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight});
                }
                return {html: html, images: images};
            })`,
            undefined, undefined, [selector, nth],
        )
    } else {
        result = useExtension
                 ? await unifiedSession.getHtmlWithImages(selector)
                 : await extractHtmlWithImagesCdp(session, selector, args.timeout)
    }

    if (args.images === 'info') {
        // info 模式：HTML + 图片元信息
        const payload = {type: 'html' as const, content: result.html, images: result.images}
        if (args.output) {
            await writeOutputFile(args.output, JSON.stringify(payload, null, 2), 'utf-8')
            return formatResponse({
                                      success: true,
                                      type: 'html',
                                      output: args.output,
                                      imageCount: result.images.length,
                                  })
        }
        return formatResponse({
                                  success: true,
                                  ...payload,
                              })
    }

    // data 模式：获取图片数据
    const appendixMode  = !args.output
    const imageDataList = await fetchImageData(
        unifiedSession,
        result.images,
        appendixMode ? MAX_APPENDIX_IMAGES : undefined,
    )

    if (args.output) {
        // 写入目录
        await writeImageDirectory(args.output, result.html, result.images, imageDataList)
        return formatResponse({
                                  success: true,
                                  type: 'html',
                                  output: args.output,
                                  imageCount: result.images.length,
                                  index: join(args.output, 'index.json'),
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
    timeout?: number,
): Promise<{ html: string; images: ImageInfo[] }> {
    if (selector) {
        const locator = session.createLocator({css: selector}, timeout !== undefined ? {timeout} : undefined)
        return locator.evaluateOn<{ html: string; images: ImageInfo[] }>(`function() {
            var html = this.outerHTML;
            var imgList = [];
            if (this.tagName === 'IMG') imgList.push(this);
            this.querySelectorAll('img').forEach(function(img) { imgList.push(img); });
            var images = [];
            for (var i = 0; i < imgList.length; i++) {
                var img = imgList[i];
                images.push({index: i, src: img.src, dataSrc: (function() { var raw = img.dataset.src || img.dataset.lazySrc || img.dataset.original || ''; if (!raw) return ''; try { return new URL(raw, location.href).href } catch(e) { return raw } })(), alt: img.alt, width: img.width, height: img.height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight});
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
            images.push({index: i, src: img.src, dataSrc: (function() { var raw = img.dataset.src || img.dataset.lazySrc || img.dataset.original || ''; if (!raw) return ''; try { return new URL(raw, location.href).href } catch(e) { return raw } })(), alt: img.alt, width: img.width, height: img.height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight});
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
    limit?: number,
): Promise<ImageData[]> {
    const effectiveLimit = limit ?? images.length

    // 第一趟：解析 data: URL + 收集需要 CDP 获取的 URL（去重）
    const preResolved: (ImageData | null)[] = []
    const cdpUrlSet = new Set<string>()
    for (let i = 0; i < images.length; i++) {
        const img = images[i]
        const effectiveSrc = img.src || img.dataSrc

        if (i >= effectiveLimit || !effectiveSrc) {
            preResolved.push({base64: null, mimeType: 'image/png'})
            continue
        }

        if (effectiveSrc.startsWith('data:')) {
            const match = effectiveSrc.match(/^data:([^;]+);base64,(.+)$/)
            preResolved.push(match ? {base64: match[2], mimeType: match[1]} : {base64: null, mimeType: 'image/png'})
            continue
        }

        if (!effectiveSrc.startsWith('http')) {
            preResolved.push({base64: null, mimeType: guessMimeType(effectiveSrc)})
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
                results.push({base64: resource.content, mimeType})
            } else {
                results.push({base64: Buffer.from(resource.content).toString('base64'), mimeType})
            }
            continue
        }

        // CDP 缓存未命中，不使用 Node.js fetch（避免绕过浏览器同源策略）
        results.push({base64: null, mimeType})
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
    imageDataList: ImageData[],
): Promise<void> {
    const imagesDir = join(outputDir, 'images')
    await mkdir(imagesDir, {recursive: true})

    // 写入 HTML
    await writeFile(join(outputDir, 'content.html'), html, 'utf-8')

    // 写入图片文件 + 构建索引（相同 src 去重）
    const indexEntries: Array<{
        index: number; src: string; alt: string
        width: number; height: number; file: string | null
    }> = []
    const writtenFiles = new Map<string, string>() // src → file path

    for (let i = 0; i < images.length; i++) {
        const img  = images[i]
        const data = imageDataList[i]
        const src  = img.src || img.dataSrc
        let file: string | null = null

        if (data.base64) {
            // 相同 src 复用已写入的文件
            const existing = writtenFiles.get(src)
            if (existing) {
                file = existing
            } else {
                const ext      = mimeToExt(data.mimeType)
                const safeName = sanitizeFilename(src)
                const filename = `${i}-${safeName}${ext}`
                file           = `images/${filename}`
                await writeFile(join(imagesDir, filename), Buffer.from(data.base64, 'base64'))
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
    await writeFile(join(outputDir, 'index.json'), JSON.stringify({
        html: 'content.html',
        images: indexEntries,
    }, null, 2), 'utf-8')
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
    imageDataList: ImageData[],
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
        return {content}
    }

    content.push({type: 'text', text: '\n--- Images ---'})

    /** Claude API 支持的 image block 格式 */
    const SUPPORTED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

    const limit = Math.min(images.length, MAX_APPENDIX_IMAGES)
    for (let i = 0; i < images.length; i++) {
        const img  = images[i]
        const data = imageDataList[i]
        const effectiveSrc = img.src || img.dataSrc

        // 图片标注
        const sizeStr = img.naturalWidth ? `${img.naturalWidth}×${img.naturalHeight}` : `${img.width}×${img.height}`
        const altStr  = img.alt ? `  alt="${img.alt}"` : ''
        content.push({type: 'text', text: `\n[${img.index}] ${effectiveSrc}${altStr}  ${sizeStr}`})

        // 在限制内且有数据时附带图片（SVG 等不支持的格式跳过 image block）
        if (i < limit && data.base64 && SUPPORTED_IMAGE_MIMES.has(data.mimeType)) {
            content.push({type: 'image', data: data.base64, mimeType: data.mimeType})
        }
    }

    if (images.length > MAX_APPENDIX_IMAGES) {
        content.push({
            type: 'text',
            text: `\n（共 ${images.length} 张图片，仅前 ${MAX_APPENDIX_IMAGES} 张附带数据。使用 output 参数导出全部图片）`,
        })
    }

    return {content}
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
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png', '.gif': 'image/gif',
        '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon', '.bmp': 'image/bmp',
        '.avif': 'image/avif',
    }
    return map[ext] ?? 'image/png'
}

/** MIME 类型转文件扩展名 */
function mimeToExt(mimeType: string): string {
    const map: Record<string, string> = {
        'image/jpeg': '.jpg', 'image/png': '.png',
        'image/gif': '.gif', 'image/webp': '.webp',
        'image/svg+xml': '.svg', 'image/x-icon': '.ico',
        'image/bmp': '.bmp', 'image/avif': '.avif',
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
async function extractText(
    session: ReturnType<typeof getSession>,
    target?: Target,
    timeout?: number,
): Promise<string> {
    if (target) {
        const locator = session.createLocator(target, timeout !== undefined ? {timeout} : undefined)
        const text    = await locator.evaluateOn<string>(`function() {
      return this.textContent ?? '';
    }`)
        return text ?? ''
    }

    return session.evaluate<string>('document.body.innerText')
}

/**
 * 提取 HTML
 */
async function extractHTML(
    session: ReturnType<typeof getSession>,
    target?: Target,
    timeout?: number,
): Promise<string> {
    if (target) {
        const locator = session.createLocator(target, timeout !== undefined ? {timeout} : undefined)
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
    timeout?: number,
): Promise<string | null> {
    const locator = session.createLocator(target, timeout !== undefined ? {timeout} : undefined)
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
    target?: Target,
): Promise<string> {
    if (!target) {
        return unifiedSession.getText()
    }
    const {selector, text, xpath, nth: nthParam} = targetToFindParams(target as Target & { nth?: number })
    const nth = nthParam ?? 0

    if (selector) {
        if (nth > 0) {
            return unifiedSession.evaluate<string>(
                `(function(s, n) { var els = document.querySelectorAll(s); return n < els.length ? (els[n].textContent || '') : '' })`,
                undefined, undefined, [selector, nth],
            )
        }
        return unifiedSession.getText(selector)
    }

    // xpath/text 定位：通过 evaluate 在页面上下文中查找
    if (xpath) {
        return unifiedSession.evaluate<string>(
            `(function(xp, n) { var r = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); return n < r.snapshotLength ? (r.snapshotItem(n).textContent || '') : '' })`,
            undefined, undefined, [xpath, nth],
        )
    }
    if (text) {
        return unifiedSession.evaluate<string>(
            `(function(t, n) { var els = document.querySelectorAll('*'); var found = []; for (var i = 0; i < els.length; i++) { var cn = els[i].childNodes; for (var j = 0; j < cn.length; j++) { if (cn[j].nodeType === 3 && cn[j].textContent && cn[j].textContent.includes(t)) { found.push(els[i]); break; } } } return n < found.length ? (found[n].textContent || '') : '' })`,
            undefined, undefined, [text, nth],
        )
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
    outer = true,
): Promise<string> {
    if (!target) {
        return unifiedSession.getHtml(undefined, outer)
    }
    const {selector, text, xpath, nth: nthParam} = targetToFindParams(target as Target & { nth?: number })
    const nth = nthParam ?? 0
    const prop = outer ? 'outerHTML' : 'innerHTML'

    if (selector) {
        if (nth > 0) {
            return unifiedSession.evaluate<string>(
                `(function(s, n, p) { var els = document.querySelectorAll(s); return n < els.length ? (els[n][p] || '') : '' })`,
                undefined, undefined, [selector, nth, prop],
            )
        }
        return unifiedSession.getHtml(selector, outer)
    }

    if (xpath) {
        return unifiedSession.evaluate<string>(
            `(function(xp, n, p) { var r = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); return n < r.snapshotLength ? (r.snapshotItem(n)[p] || '') : '' })`,
            undefined, undefined, [xpath, nth, prop],
        )
    }
    if (text) {
        return unifiedSession.evaluate<string>(
            `(function(t, n, p) { var els = document.querySelectorAll('*'); var found = []; for (var i = 0; i < els.length; i++) { var cn = els[i].childNodes; for (var j = 0; j < cn.length; j++) { if (cn[j].nodeType === 3 && cn[j].textContent && cn[j].textContent.includes(t)) { found.push(els[i]); break; } } } return n < found.length ? (found[n][p] || '') : '' })`,
            undefined, undefined, [text, nth, prop],
        )
    }
    return unifiedSession.getHtml(undefined, outer)
}

/**
 * Extension 模式：提取属性
 */
async function extractAttributeExtension(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    target: Target,
    attribute: string,
): Promise<string | null> {
    const {selector, text, xpath, nth: nthParam} = targetToFindParams(target as Target & { nth?: number })

    // xpath/text 定位需要先 find 得到 refId，再获取属性
    if (xpath || text) {
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
        if (nth > 0) {
            return unifiedSession.evaluate<string | null>(
                `(function(s, n, a) { var els = document.querySelectorAll(s); return n < els.length ? els[n].getAttribute(a) : null })`,
                undefined, undefined, [selector, nth, attribute],
            )
        }
        return unifiedSession.getAttribute(selector, undefined, attribute)
    }

    return null
}

/**
 * Extension 模式：等待目标元素出现
 *
 * 在 extract 操作前轮询 find()，直到找到匹配元素或超时。
 * 用于实现 extract 的 timeout 参数语义。
 */
async function waitForTargetExtension(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    target: Target,
    timeout: number,
): Promise<void> {
    const startTime                              = Date.now()
    const retryDelay                             = 100
    const {selector, text, xpath, nth: nthParam} = targetToFindParams(target as Target & { nth?: number })
    const nth                                    = nthParam ?? 0
    let lastError: Error | null                  = null

    while (true) {
        const elapsed = Date.now() - startTime
        if (elapsed >= timeout) {
            const msg = `等待目标元素超时 (${timeout}ms)`
            throw new Error(lastError ? `${msg}: ${lastError.message}` : msg)
        }

        if (!unifiedSession.isExtensionConnected()) {
            lastError = new Error('Extension 未连接')
            await new Promise(r => setTimeout(r, retryDelay))
            continue
        }

        try {
            const remaining = timeout - elapsed
            const elements  = await unifiedSession.find(selector, text, xpath, remaining)
            if (elements.length > nth) {
                return
            }
        } catch (err) {
            // 暂时性错误（RPC 超时、发送失败、连接断开）可重试，其他确定性错误立即抛出
            if (err instanceof
                Error &&
                /Request timeout|Failed to send|disconnect|未连接|stopped|replaced/i.test(err.message)) {
                lastError = err
                await new Promise(r => setTimeout(r, retryDelay))
                continue
            }
            throw err
        }

        await new Promise(r => setTimeout(r, retryDelay))
    }
}

/**
 * 注册 extract 工具
 */
export function registerExtractTool(server: McpServer): void {
    server.registerTool('extract', {
        description: '提取页面内容：文本、HTML（可附带图片）、属性、截图、状态、页面元信息',
        inputSchema: extractSchema,
    }, (args) => handleExtract(args))
}
