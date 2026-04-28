import type { ElementInfo, ReadPageResult, ScreenshotResult } from '../types'
import { ExpectedOperationError } from '../types/expected-errors'
import {
    ActionableClickSchema,
    CheckActionabilitySchema,
    ClickSchema,
    DispatchInputSchema,
    DragAndDropSchema,
    EvaluateSchema,
    FindSchema,
    GetAttributeSchema,
    GetComputedStyleSchema,
    GetHtmlSchema,
    GetHtmlWithImagesSchema,
    GetMetadataSchema,
    GetTextSchema,
    ReadPageSchema,
    type ScreenshotInput,
    ScreenshotSchema,
    ScrollSchema,
    TypeSchema,
} from '../types/schemas'
import { assertScriptable, getFrameOffset, getTargetTabId, isRestrictedUrl } from './action-utils'
import { DebuggerBlockedError, DebuggerManager } from './debugger-manager'
import {
    type ActionabilityResult,
    checkActionability,
    dispatchInputToElement,
    executeCode,
    extractAttribute,
    extractHtml,
    extractHtmlWithImages,
    extractMetadata,
    extractText,
    findElements,
    generateAccessibilityTree,
    getComputedStyleFromElement,
    performActionableClick,
    performClick,
    performDragAndDrop,
    performScroll,
    performType,
} from './page-scripts'

// 注入函数类型：chrome.scripting 在运行时通过 JSON 序列化传参，类型层用 unknown 兜底
type InjectableFunc<R> = (...args: never[]) => R

// 页面注入脚本可能抛出的预期错误模式
// page-scripts.ts 在页面上下文执行，无法 import ExpectedOperationError
// 在这里集中识别这些模式并包装为 ExpectedOperationError，供 index.ts 用 instanceof 判断
const EXPECTED_INJECTION_PATTERNS = [
    /Invalid CSS selector/,
    /Invalid XPath/,
    /Element with refId .* not found/,
    /Cannot access/,
]

function wrapInjectionError(msg: string): Error {
    if (EXPECTED_INJECTION_PATTERNS.some((p) => p.test(msg))) {
        return new ExpectedOperationError(msg)
    }
    return new Error(msg)
}

export class ContentHandler {
    constructor(private debuggerManager: DebuggerManager) {}

    async readPage(params: unknown): Promise<ReadPageResult> {
        const p = ReadPageSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)
        const result = await this.injectScript<ReadPageResult>(tabId, p.frameId, generateAccessibilityTree, [
            p.filter || 'all',
            p.depth ?? 15,
            p.maxLength ?? null,
            p.refId ?? null,
        ])
        if (result === undefined || result === null) {
            throw new Error('Failed to read page')
        }
        return result
    }

    async screenshot(params: unknown): Promise<ScreenshotResult> {
        const p = ScreenshotSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)

        try {
            // 使用 debugger API 截图（不需要 tab 在前台）
            await this.debuggerManager.ensureAttached(tabId)
        } catch (err) {
            if (err instanceof DebuggerBlockedError) {
                return this.screenshotFallback(tabId, p)
            }
            throw err
        }

        // hidden tab 下 Page.captureScreenshot 因 renderer pipeline 暂停会挂起超时
        // 明确报错，不静默 timeout
        const { result: visibility } = (await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
            expression: 'document.visibilityState',
            returnByValue: true,
        })) as { result: { value: string } }
        if (visibility?.value === 'hidden') {
            throw new ExpectedOperationError(
                'screenshot 需要 tab 可见；当前 tab 处于 hidden 状态，请先把目标 tab/窗口带到前台或 activate 该 tab'
            )
        }

        if (p.fullPage) {
            // 获取页面完整尺寸
            const sizeExpr =
                'JSON.stringify({' +
                'width: document.documentElement.scrollWidth, ' +
                'height: document.documentElement.scrollHeight})'
            const { result: sizeResult } = (await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
                expression: sizeExpr,
                returnByValue: true,
            })) as { result: { value: string } }
            let width: number, height: number
            try {
                ;({ width, height } = JSON.parse(sizeResult.value))
            } catch {
                throw new Error('无法获取页面尺寸，document.documentElement 可能不可用')
            }

            // 临时设置视口为页面完整尺寸
            await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
                width,
                height,
                deviceScaleFactor: p.scale ?? 1,
                mobile: false,
            })

            try {
                const effectiveFormat = p.format || 'png'
                const result = (await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
                    format: effectiveFormat,
                    ...(p.quality !== undefined && effectiveFormat !== 'png' ? { quality: p.quality } : {}),
                })) as { data: string }
                return { data: result.data, format: effectiveFormat }
            } finally {
                try {
                    await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride')
                } catch {
                    // cleanup 失败不覆盖原始错误
                }
            }
        }

        const effectiveFormat = p.format || 'png'
        const result = (await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
            format: effectiveFormat,
            ...(p.quality !== undefined && effectiveFormat !== 'png' ? { quality: p.quality } : {}),
            ...(p.clip ? { clip: { ...p.clip, scale: p.scale ?? 1 } } : {}),
        })) as { data: string }

        return {
            data: result.data,
            format: p.format || 'png',
        }
    }

    async click(params: unknown): Promise<{ success: boolean }> {
        const p = ClickSchema.parse(params)
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)
        return this.injectScript<{ success: boolean }>(tabId, p.frameId, performClick, [p.refId])
    }

    async actionableClick(params: unknown): Promise<{
        success: boolean
        error?: string
        reason?: string
        coveringElement?: string
    }> {
        const p = ActionableClickSchema.parse(params)

        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)

        // 渐进退避重试（参考 Playwright dom.ts:300）
        const delays = [0, 20, 100, 100, 500]
        let lastResult: { success: boolean; error?: string; reason?: string; coveringElement?: string } | null = null
        for (let attempt = 0; attempt <= delays.length; attempt++) {
            if (attempt > 0) {
                await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]))
            }

            lastResult = await this.injectScript<{
                success: boolean
                error?: string
                reason?: string
                coveringElement?: string
            }>(tabId, p.frameId, performActionableClick, [p.refId, p.force ?? false])

            if (lastResult.success) {
                return lastResult
            }

            // 不可恢复的错误：不重试
            if (
                lastResult.reason === 'not-connected' ||
                lastResult.reason === 'not-enabled' ||
                lastResult.reason === 'pointer-events-none'
            ) {
                return lastResult
            }

            // 可恢复的错误（covered / not-in-viewport / not-visible）：继续重试
        }

        // 所有重试耗尽，直接使用最后一次结果（避免额外 IPC 调用）
        return {
            success: false,
            error:
                lastResult?.reason === 'covered'
                    ? `Element is covered by ${lastResult.coveringElement} after ${delays.length} retries`
                    : `Element not actionable: ${lastResult?.reason} after ${delays.length} retries`,
            reason: lastResult?.reason,
            coveringElement: lastResult?.coveringElement,
        }
    }

    async checkActionabilityAction(params: unknown): Promise<ActionabilityResult> {
        const p = CheckActionabilitySchema.parse(params)
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)
        return this.injectScript<ActionabilityResult>(tabId, p.frameId, checkActionability, [p.refId])
    }

    async dispatchInputAction(params: unknown): Promise<{ success: boolean; error?: string }> {
        const p = DispatchInputSchema.parse(params)
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)
        return this.injectScript<{ success: boolean; error?: string }>(tabId, p.frameId, dispatchInputToElement, [
            p.refId,
            p.text ?? '',
        ])
    }

    async dragAndDropAction(params: unknown): Promise<{ success: boolean; error?: string; code?: string }> {
        const p = DragAndDropSchema.parse(params)
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)
        return this.injectScript<{ success: boolean; error?: string; code?: string }>(
            tabId,
            p.frameId,
            performDragAndDrop,
            [p.srcRefId, p.dstRefId]
        )
    }

    async getComputedStyleAction(params: unknown): Promise<string | null> {
        const p = GetComputedStyleSchema.parse(params)
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)
        return this.injectScript<string | null>(tabId, p.frameId, getComputedStyleFromElement, [p.refId, p.prop ?? ''])
    }

    async type(params: unknown): Promise<{ success: boolean }> {
        const p = TypeSchema.parse(params)
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)
        return this.injectScript<{ success: boolean }>(tabId, p.frameId, performType, [
            p.refId,
            p.text,
            p.clear ?? false,
        ])
    }

    async scroll(params: unknown): Promise<{ success: boolean; scrollX: number; scrollY: number }> {
        const p = ScrollSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)
        return this.injectScript<{ success: boolean; scrollX: number; scrollY: number }>(
            tabId,
            p.frameId,
            performScroll,
            [p.x || 0, p.y || 0, p.refId ?? null]
        )
    }

    async evaluate(params: unknown): Promise<{ success: boolean; result?: string; error?: string }> {
        const p = EvaluateSchema.parse(params)
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)
        // world: 'MAIN' 在页面上下文中执行（绕过 Extension CSP，但页面 CSP 仍可拦截）
        return this.injectScript<{ success: boolean; result?: string; error?: string }>(tabId, p.frameId, executeCode, [
            p.code,
        ])
    }

    async find(params: unknown): Promise<ElementInfo[]> {
        const p = FindSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)
        const frameId = p.frameId ?? 0

        // 受限 URL 返回空数组（而非抛异常，避免 auto-wait 轮询时大量错误）
        const tab = await chrome.tabs.get(tabId)
        if (isRestrictedUrl(tab.url)) {
            return []
        }

        const data = await this.injectScript<ElementInfo[] | { error: string } | undefined>(
            tabId,
            frameId,
            findElements,
            [p.selector ?? null, p.text ?? null, p.xpath ?? null]
        )

        if (data === undefined || data === null) {
            throw new Error(
                `find 脚本未返回结果（selector="${p.selector ?? ''}" text="${p.text ?? ''}" xpath="${p.xpath ?? ''}"），可能是 selector 非法或 frame 不可注入`
            )
        }
        if (typeof data === 'object' && !Array.isArray(data) && 'error' in data) {
            throw new Error(data.error)
        }
        let elements = data as ElementInfo[]

        // iframe 坐标修正：将 iframe 内相对坐标转为页面绝对坐标
        if (frameId !== 0 && elements.length > 0) {
            const offset = await getFrameOffset(tabId, frameId)
            if (offset) {
                elements = elements.map((el) => ({
                    ...el,
                    rect: {
                        x: el.rect.x + offset.x,
                        y: el.rect.y + offset.y,
                        width: el.rect.width,
                        height: el.rect.height,
                    },
                }))
            }
        }

        return elements
    }

    async getText(params: unknown): Promise<{ text: string }> {
        const p = GetTextSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)
        const data = await this.injectScript<{ text: string; error?: string } | undefined>(
            tabId,
            p.frameId,
            extractText,
            [p.selector ?? null]
        )
        if (data === undefined || data === null) {
            throw new Error(`extractText 脚本未返回结果（selector="${p.selector ?? ''}"），可能是 frame 不可注入`)
        }
        if (data.error) {
            throw wrapInjectionError(data.error)
        }
        return { text: data.text }
    }

    async getHtml(params: unknown): Promise<{ html: string }> {
        const p = GetHtmlSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)
        const data = await this.injectScript<{ html: string; error?: string } | undefined>(
            tabId,
            p.frameId,
            extractHtml,
            [p.selector ?? null, p.outer ?? true]
        )
        if (data === undefined || data === null) {
            throw new Error(`extractHtml 脚本未返回结果（selector="${p.selector ?? ''}"），可能是 frame 不可注入`)
        }
        if (data.error) {
            throw wrapInjectionError(data.error)
        }
        return { html: data.html }
    }

    async getHtmlWithImages(params: unknown): Promise<{
        html: string
        images: Array<{
            index: number
            src: string
            dataSrc: string
            alt: string
            width: number
            height: number
            naturalWidth: number
            naturalHeight: number
        }>
    }> {
        const p = GetHtmlWithImagesSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)
        return this.injectScript<{
            html: string
            images: Array<{
                index: number
                src: string
                dataSrc: string
                alt: string
                width: number
                height: number
                naturalWidth: number
                naturalHeight: number
            }>
        }>(tabId, p.frameId, extractHtmlWithImages, [p.selector ?? null, p.outer ?? true])
    }

    async getAttribute(params: unknown): Promise<{ value: string | null }> {
        const p = GetAttributeSchema.parse(params)
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)
        const data = await this.injectScript<{ value: string | null } | undefined>(tabId, p.frameId, extractAttribute, [
            p.selector ?? null,
            p.refId ?? null,
            p.attribute,
        ])
        if (data === undefined || data === null) {
            throw new Error(
                `extractAttribute 脚本未返回结果（selector="${p.selector ?? ''}" attribute="${p.attribute}"），可能是 selector 非法`
            )
        }
        return data
    }

    async getMetadata(params: unknown): Promise<Record<string, unknown>> {
        const p = GetMetadataSchema.parse(params) ?? {}
        const tabId = await getTargetTabId(p.tabId)
        await assertScriptable(tabId)
        return this.injectScript<Record<string, unknown>>(tabId, p.frameId, extractMetadata, [])
    }

    /**
     * 在目标 tab/frame 上执行 chrome.scripting.executeScript，返回脚本结果
     * 处理 injection 层错误（如 selector 非法、frame 不可注入）
     */
    private async injectScript<R>(
        tabId: number,
        frameId: number | undefined,
        func: InjectableFunc<R>,
        args: unknown[]
    ): Promise<R> {
        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frameId ?? 0] },
            func: func as (...a: unknown[]) => R,
            args: args as never[],
            world: 'MAIN',
        })
        const injectionError = (results[0] as { error?: { message?: string } })?.error
        if (injectionError) {
            throw wrapInjectionError(injectionError.message || String(injectionError))
        }
        return results[0]?.result as R
    }

    /** debugger 被占用时通过 captureVisibleTab 截图（仅可视区域） */
    private async screenshotFallback(tabId: number, p: ScreenshotInput): Promise<ScreenshotResult> {
        const tab = await chrome.tabs.get(tabId)
        if (!tab.active) {
            throw new Error(
                'screenshot fallback 路径需要 tab 在其窗口内为 active；debugger 被占用时无法对非 active tab 截图'
            )
        }
        // captureVisibleTab 只能截可视区域、只支持 png/jpeg；遇到 fullPage/clip/scale/webp
        // 应明确报错而非静默降级，避免上层拿到「viewport-only 但 success=true」或「PNG 字节贴 webp mimeType」
        if (p?.fullPage) {
            throw new Error(
                'screenshot fallback 不支持 fullPage（captureVisibleTab 仅可视区域）；请关闭占用 debugger 的扩展（如 React DevTools）后重试'
            )
        }
        if (p?.clip) {
            throw new Error(
                'screenshot fallback 不支持 clip 参数（captureVisibleTab 不支持区域裁剪）；请关闭占用 debugger 的扩展后重试'
            )
        }
        if (p?.scale !== undefined && p.scale !== 1) {
            throw new Error(
                'screenshot fallback 不支持 scale 参数（captureVisibleTab 不支持缩放）；请关闭占用 debugger 的扩展后重试'
            )
        }
        if (p?.format && p.format !== 'jpeg' && p.format !== 'png') {
            throw new Error(
                `screenshot fallback 不支持 format="${p.format}"（captureVisibleTab 仅支持 png/jpeg）；请关闭占用 debugger 的扩展后重试`
            )
        }
        const format = p?.format === 'jpeg' ? 'jpeg' : 'png'
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
            format,
            quality: p?.quality,
        })
        const data = dataUrl.split(',')[1]
        return { data, format }
    }
}
