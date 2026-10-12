import type { ElementInfo, ReadPageResult, ScreenshotResult } from '../types'
import { ExpectedOperationError } from '../types/expected-errors'
import {
    ActionableClickSchema,
    ChallengeInspectSchema,
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
    ViewportMetricsSchema,
} from '../types/schemas'
import {
    type ActionContext,
    assertManagedTab,
    assertReadableTab,
    assertScriptable,
    getFrameOffset,
    getTargetTabId,
    isRestrictedUrl,
} from './action-utils'
import { DebuggerBlockedError, DebuggerManager } from './debugger-manager'
import { assertScreenshotBase64Budget, assertScreenshotBudget } from './screenshot-budget'
import { readGrantDocumentId } from './read-grants'
import { isCreatedTab } from './tab-state'
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
    inspectChallengePage,
    installActionabilityHelpers,
    performActionableClick,
    performClick,
    performDragAndDrop,
    performScroll,
    performType,
} from './page-scripts'

// 注入函数类型：chrome.scripting 在运行时通过 JSON 序列化传参，类型层用 unknown 兜底
type InjectableFunc<R> = (...args: never[]) => R | Promise<R>

// 页面注入脚本可能抛出的预期错误模式
// page-scripts.ts 在页面上下文执行，无法 import ExpectedOperationError
// 在这里集中识别这些模式并包装为 ExpectedOperationError，供 index.ts 用 instanceof 判断
const EXPECTED_INJECTION_PATTERNS = [
    /Invalid CSS selector/,
    /Invalid XPath/,
    /Element with refId .* not found/,
    /Cannot access/,
    /Frame with ID \d+ is showing error page/i,
]

function wrapInjectionError(error: unknown): Error {
    const msg = error instanceof Error ? error.message : String(error)
    if (EXPECTED_INJECTION_PATTERNS.some((p) => p.test(msg))) {
        return new ExpectedOperationError(msg)
    }
    return error instanceof Error ? error : new Error(msg)
}

function structuredOperationError(
    code: string,
    message: string,
    suggestion: string,
    context: Record<string, unknown>
): ExpectedOperationError {
    return new ExpectedOperationError(JSON.stringify({ error: { code, message, suggestion, context } }))
}

export class ContentHandler {
    constructor(private debuggerManager: DebuggerManager) {}

    async readPage(params: unknown, context: ActionContext): Promise<ReadPageResult> {
        const p = ReadPageSchema.parse(params) ?? {}
        const { tabId, documentId, expectedUrl } = await this.getReadableScriptableTabId(
            p.tabId,
            context,
            'read_page',
            p.frameId
        )
        const result = await this.injectScript<ReadPageResult>(
            tabId,
            p.frameId,
            generateAccessibilityTree,
            [
                p.filter || 'all',
                p.depth ?? 15,
                p.maxLength ?? null,
                p.refId ?? null,
                documentId ? (expectedUrl ?? null) : null,
            ],
            documentId
        )
        if (result === undefined || result === null) {
            throw new Error('Failed to read page')
        }
        await this.assertReadableDocumentUnchanged(tabId, p.frameId, documentId, expectedUrl, context, 'read_page')
        if (p.frameId !== undefined && result.interactiveElements) {
            result.interactiveElements = result.interactiveElements.map((item) => ({ ...item, frameId: p.frameId }))
        }
        return result
    }

    async screenshot(params: unknown, context: ActionContext): Promise<ScreenshotResult> {
        const p = ScreenshotSchema.parse(params) ?? {}
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'screenshot')
        if (p.clip) {
            assertScreenshotBudget(p.clip.width, p.clip.height, p.scale ?? 1)
        } else {
            const dimensions = await chrome.scripting
                .executeScript({
                    target: { tabId, frameIds: [0] },
                    func: (fullPage: boolean) => ({
                        width: fullPage ? document.documentElement.scrollWidth : window.innerWidth,
                        height: fullPage ? document.documentElement.scrollHeight : window.innerHeight,
                    }),
                    args: [p.fullPage ?? false],
                })
                .catch((error: unknown) => {
                    throw wrapInjectionError(error)
                })
            const size = dimensions[0]?.result
            if (!size) {
                throw new Error('screenshot: 无法读取页面尺寸，未执行截图')
            }
            assertScreenshotBudget(size.width, size.height, p.fullPage ? (p.scale ?? 1) : 1)
        }

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
            throw structuredOperationError(
                'HIDDEN_TAB_SCREENSHOT',
                'screenshot 需要 tab 可见，当前 tab 处于 hidden 状态',
                'Extension 截图依赖可见 renderer，请用 manage 的 activatePage 或 focusWindow 动作，' +
                    '也可在 CDP/headless 测试浏览器中截图',
                { tabId, visibilityState: visibility.value }
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

            assertScreenshotBudget(width, height, p.scale ?? 1)
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
                assertScreenshotBase64Budget(result.data)
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
            ...(p.clip ? { clip: { ...p.clip, scale: p.scale ?? 1 }, captureBeyondViewport: true } : {}),
        })) as { data: string }

        assertScreenshotBase64Budget(result.data)
        return {
            data: result.data,
            format: p.format || 'png',
        }
    }

    async click(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = ClickSchema.parse(params)
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'click')
        return this.injectScript<{ success: boolean }>(tabId, p.frameId, performClick, [p.refId])
    }

    async actionableClick(
        params: unknown,
        context: ActionContext
    ): Promise<Partial<ActionabilityResult> & { success: boolean; error?: string }> {
        const p = ActionableClickSchema.parse(params)

        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'actionable_click')

        // 渐进退避重试（参考 Playwright dom.ts:300）
        const delays = [0, 20, 100, 100, 500]
        let lastResult: (Partial<ActionabilityResult> & { success: boolean; error?: string }) | null = null
        for (let attempt = 0; attempt <= delays.length; attempt++) {
            if (attempt > 0) {
                await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]))
            }

            await this.injectScript<void>(tabId, p.frameId, installActionabilityHelpers, [])
            lastResult = await this.injectScript<Partial<ActionabilityResult> & { success: boolean; error?: string }>(
                tabId,
                p.frameId,
                performActionableClick,
                [p.refId, p.force ?? false]
            )

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
            ...lastResult,
            success: false,
            error:
                lastResult?.reason === 'covered'
                    ? `Element is covered by ${lastResult.coveringElement} after ${delays.length} retries`
                    : `Element not actionable: ${lastResult?.reason} after ${delays.length} retries`,
            reason: lastResult?.reason,
            coveringElement: lastResult?.coveringElement,
        }
    }

    async checkActionabilityAction(params: unknown, context: ActionContext): Promise<ActionabilityResult> {
        const p = CheckActionabilitySchema.parse(params)
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'check_actionability')
        await this.injectScript<void>(tabId, p.frameId, installActionabilityHelpers, [])
        return this.injectScript<ActionabilityResult>(tabId, p.frameId, checkActionability, [p.refId])
    }

    async dispatchInputAction(params: unknown, context: ActionContext): Promise<{ success: boolean; error?: string }> {
        const p = DispatchInputSchema.parse(params)
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'dispatch_input')
        return this.injectScript<{ success: boolean; error?: string }>(tabId, p.frameId, dispatchInputToElement, [
            p.refId,
            p.text ?? '',
        ])
    }

    async dragAndDropAction(
        params: unknown,
        context: ActionContext
    ): Promise<{ success: boolean; error?: string; code?: string }> {
        const p = DragAndDropSchema.parse(params)
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'drag_and_drop')
        return this.injectScript<{ success: boolean; error?: string; code?: string }>(
            tabId,
            p.frameId,
            performDragAndDrop,
            [p.srcRefId, p.dstRefId]
        )
    }

    async getComputedStyleAction(params: unknown, context: ActionContext): Promise<string | null> {
        const p = GetComputedStyleSchema.parse(params)
        const { tabId, documentId, expectedUrl } = await this.getReadableScriptableTabId(
            p.tabId,
            context,
            'get_computed_style',
            p.frameId
        )
        const value = await this.injectScript<string | null>(
            tabId,
            p.frameId,
            getComputedStyleFromElement,
            [p.refId, p.prop ?? '', documentId ? (expectedUrl ?? null) : null],
            documentId
        )
        await this.assertReadableDocumentUnchanged(
            tabId,
            p.frameId,
            documentId,
            expectedUrl,
            context,
            'get_computed_style'
        )
        return value
    }

    async type(params: unknown, context: ActionContext): Promise<{ success: boolean }> {
        const p = TypeSchema.parse(params)
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'type')
        return this.injectScript<{ success: boolean }>(tabId, p.frameId, performType, [
            p.refId,
            p.text,
            p.clear ?? false,
        ])
    }

    async scroll(
        params: unknown,
        context: ActionContext
    ): Promise<{ success: boolean; scrollX: number; scrollY: number }> {
        const p = ScrollSchema.parse(params) ?? {}
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'scroll')
        return this.injectScript<{ success: boolean; scrollX: number; scrollY: number }>(
            tabId,
            p.frameId,
            performScroll,
            [p.x || 0, p.y || 0, p.refId ?? null]
        )
    }

    async evaluate(
        params: unknown,
        context: ActionContext
    ): Promise<{ success: boolean; result?: string; error?: string }> {
        const p = EvaluateSchema.parse(params)
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'evaluate')
        // world: 'MAIN' 在页面上下文中执行（绕过 Extension CSP，但页面 CSP 仍可拦截）
        return this.injectScript<{ success: boolean; result?: string; error?: string }>(tabId, p.frameId, executeCode, [
            p.code,
            ...(p.timeout !== undefined ? [p.timeout] : []),
        ])
    }

    async getViewportMetrics(
        params: unknown,
        context: ActionContext
    ): Promise<{
        screenX: number
        screenY: number
        innerWidth: number
        innerHeight: number
        outerWidth: number
        outerHeight: number
        devicePixelRatio: number
    }> {
        const p = ViewportMetricsSchema.parse(params)
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'viewport_metrics')
        const results = await chrome.scripting
            .executeScript({
                target: { tabId, frameIds: [p.frameId ?? 0] },
                world: 'ISOLATED',
                func: () => ({
                    screenX: Number(window.screenX),
                    screenY: Number(window.screenY),
                    innerWidth: Number(window.innerWidth),
                    innerHeight: Number(window.innerHeight),
                    outerWidth: Number(window.outerWidth),
                    outerHeight: Number(window.outerHeight),
                    devicePixelRatio: Number(window.devicePixelRatio || 1),
                }),
            })
            .catch((error: unknown) => {
                throw wrapInjectionError(error)
            })
        const injectionError = (results[0] as { error?: { message?: string } })?.error
        if (injectionError) {
            throw wrapInjectionError(injectionError.message || String(injectionError))
        }
        const metrics = results[0]?.result
        if (!metrics) {
            throw new Error('viewport_metrics 未返回视口')
        }
        return metrics
    }

    async inspectChallenge(
        params: unknown,
        context: ActionContext
    ): Promise<{
        title: string
        url: string
        selectorHits: string[]
        deniedHits: string[]
        textHits: string[]
        originResponsePending: boolean
        turnstilePresent: boolean
        clickPoint: { x: number; y: number } | null
        clickTargetKind: 'verify' | 'widget' | null
        clickSource: 'page' | 'iframe' | null
        screenPoint: { x: number; y: number } | null
        viewport: {
            screenX: number
            screenY: number
            innerWidth: number
            innerHeight: number
            outerWidth: number
            outerHeight: number
            devicePixelRatio: number
        }
    }> {
        const p = ChallengeInspectSchema.parse(params)
        const tabId = await this.getManagedScriptableTabId(p.tabId, context, 'challenge_inspect')
        const results = await chrome.scripting
            .executeScript({
                target: { tabId, frameIds: [p.frameId ?? 0] },
                world: 'ISOLATED',
                func: inspectChallengePage,
                args: [
                    {
                        challengeSelectors: p.challengeSelectors,
                        deniedSelectors: p.deniedSelectors,
                        widgetSelectors: p.widgetSelectors,
                        verifyButtonSelectors: p.verifyButtonSelectors,
                        frameSelectors: p.frameSelectors,
                        titleNeedles: p.titleNeedles,
                        textMarkers: p.textMarkers,
                        originResponsePendingTextMarkers: p.originResponsePendingTextMarkers,
                    },
                ],
            })
            .catch((error: unknown) => {
                throw wrapInjectionError(error)
            })
        const injectionError = (results[0] as { error?: { message?: string } })?.error
        if (injectionError) {
            throw wrapInjectionError(injectionError.message || String(injectionError))
        }
        const snapshot = results[0]?.result
        if (!snapshot) {
            throw new Error('challenge_inspect 未返回页面状态')
        }
        return snapshot
    }

    async find(params: unknown, context: ActionContext): Promise<ElementInfo[]> {
        const p = FindSchema.parse(params) ?? {}
        const frameId = p.frameId ?? 0
        const { tabId, documentId, expectedUrl } = await this.getReadableTabId(p.tabId, context, 'find', frameId)

        // 受限 URL 返回空数组（而非抛异常，避免 auto-wait 轮询时大量错误）
        const tab = await chrome.tabs.get(tabId)
        if (isRestrictedUrl(tab.url)) {
            return []
        }

        const data = await this.injectScript<ElementInfo[] | { error: string } | undefined>(
            tabId,
            frameId,
            findElements,
            [
                p.selector ?? null,
                p.text ?? null,
                p.xpath ?? null,
                documentId ? (expectedUrl ?? null) : null,
                p.point ?? null,
                ...(p.matchIndex !== undefined ? [p.matchIndex] : []),
            ],
            documentId
        )

        if (data === undefined || data === null) {
            throw new Error(
                `find 脚本未返回结果（selector="${p.selector ?? ''}" text="${p.text ?? ''}" ` +
                    `xpath="${p.xpath ?? ''}"），可能是 selector 非法或 frame 不可注入`
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

        await this.assertReadableDocumentUnchanged(tabId, frameId, documentId, expectedUrl, context, 'find')
        return elements
    }

    async getText(params: unknown, context: ActionContext): Promise<{ text: string }> {
        const p = GetTextSchema.parse(params) ?? {}
        const { tabId, documentId, expectedUrl } = await this.getReadableScriptableTabId(
            p.tabId,
            context,
            'get_text',
            p.frameId
        )
        const data = await this.injectScript<{ text: string; error?: string } | undefined>(
            tabId,
            p.frameId,
            extractText,
            [p.selector ?? null, documentId ? (expectedUrl ?? null) : null, p.refId ?? null],
            documentId
        )
        if (data === undefined || data === null) {
            throw new Error(`extractText 脚本未返回结果（selector="${p.selector ?? ''}"），可能是 frame 不可注入`)
        }
        if (data.error) {
            throw wrapInjectionError(data.error)
        }
        await this.assertReadableDocumentUnchanged(tabId, p.frameId, documentId, expectedUrl, context, 'get_text')
        return { text: data.text }
    }

    async getHtml(params: unknown, context: ActionContext): Promise<{ html: string }> {
        const p = GetHtmlSchema.parse(params) ?? {}
        const { tabId, documentId, expectedUrl } = await this.getReadableScriptableTabId(
            p.tabId,
            context,
            'get_html',
            p.frameId
        )
        const data = await this.injectScript<{ html: string; error?: string } | undefined>(
            tabId,
            p.frameId,
            extractHtml,
            [p.selector ?? null, p.outer ?? true, documentId ? (expectedUrl ?? null) : null, p.refId ?? null],
            documentId
        )
        if (data === undefined || data === null) {
            throw new Error(`extractHtml 脚本未返回结果（selector="${p.selector ?? ''}"），可能是 frame 不可注入`)
        }
        if (data.error) {
            throw wrapInjectionError(data.error)
        }
        await this.assertReadableDocumentUnchanged(tabId, p.frameId, documentId, expectedUrl, context, 'get_html')
        return { html: data.html }
    }

    async getHtmlWithImages(
        params: unknown,
        context: ActionContext
    ): Promise<{
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
        const { tabId, documentId, expectedUrl } = await this.getReadableScriptableTabId(
            p.tabId,
            context,
            'get_html_with_images',
            p.frameId
        )
        const data = await this.injectScript<{
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
        }>(
            tabId,
            p.frameId,
            extractHtmlWithImages,
            [p.selector ?? null, p.outer ?? true, documentId ? (expectedUrl ?? null) : null, p.refId ?? null],
            documentId
        )
        await this.assertReadableDocumentUnchanged(
            tabId,
            p.frameId,
            documentId,
            expectedUrl,
            context,
            'get_html_with_images'
        )
        return data
    }

    async getAttribute(params: unknown, context: ActionContext): Promise<{ value: string | null }> {
        const p = GetAttributeSchema.parse(params)
        const { tabId, documentId, expectedUrl } = await this.getReadableScriptableTabId(
            p.tabId,
            context,
            'get_attribute',
            p.frameId
        )
        const data = await this.injectScript<{ value: string | null } | undefined>(
            tabId,
            p.frameId,
            extractAttribute,
            [p.selector ?? null, p.refId ?? null, p.attribute, documentId ? (expectedUrl ?? null) : null],
            documentId
        )
        if (data === undefined || data === null) {
            throw new Error(
                `extractAttribute 脚本未返回结果（selector="${p.selector ?? ''}" attribute="${p.attribute}"），可能是 selector 非法`
            )
        }
        await this.assertReadableDocumentUnchanged(tabId, p.frameId, documentId, expectedUrl, context, 'get_attribute')
        return data
    }

    async getMetadata(params: unknown, context: ActionContext): Promise<Record<string, unknown>> {
        const p = GetMetadataSchema.parse(params) ?? {}
        const { tabId, documentId, expectedUrl } = await this.getReadableScriptableTabId(
            p.tabId,
            context,
            'get_metadata',
            p.frameId
        )
        const data = await this.injectScript<Record<string, unknown>>(
            tabId,
            p.frameId,
            extractMetadata,
            [documentId ? (expectedUrl ?? null) : null],
            documentId
        )
        await this.assertReadableDocumentUnchanged(tabId, p.frameId, documentId, expectedUrl, context, 'get_metadata')
        return data
    }

    private async assertReadableDocumentUnchanged(
        tabId: number,
        frameId: number | undefined,
        documentId: string | undefined,
        expectedUrl: string | undefined,
        context: ActionContext,
        operation: string
    ): Promise<void> {
        if (!documentId) {
            return
        }
        const current = await this.getReadableTabId(tabId, context, operation, frameId)
        if (current.documentId !== documentId || current.expectedUrl !== expectedUrl) {
            throw new ExpectedOperationError(`${operation} 页面或授权已变化，未读取`)
        }
    }

    private async getReadableTabId(
        tabId: number | undefined,
        context: ActionContext,
        operation: string,
        frameId = 0
    ): Promise<{ tabId: number; documentId?: string; expectedUrl?: string }> {
        const resolvedTabId = await getTargetTabId(tabId)
        const readable = await assertReadableTab(resolvedTabId, context, operation)
        if (!readable.documentId || frameId === 0) {
            return { tabId: resolvedTabId, documentId: readable.documentId, expectedUrl: readable.tab.url }
        }
        const frame = await chrome.webNavigation.getFrame({ tabId: resolvedTabId, frameId })
        if (
            !frame?.documentId ||
            (await readGrantDocumentId(context.serverInstanceId, resolvedTabId)) !== readable.documentId
        ) {
            throw new ExpectedOperationError(`${operation} 页面或 iframe 已变化，未读取`)
        }
        return { tabId: resolvedTabId, documentId: frame.documentId, expectedUrl: frame.url }
    }

    private async getReadableScriptableTabId(
        tabId: number | undefined,
        context: ActionContext,
        operation: string,
        frameId = 0
    ): Promise<{ tabId: number; documentId?: string; expectedUrl?: string }> {
        const target = await this.getReadableTabId(tabId, context, operation, frameId)
        await assertScriptable(target.tabId)
        return target
    }

    private async getManagedTabId(
        tabId: number | undefined,
        context: ActionContext,
        operation: string
    ): Promise<number> {
        const resolvedTabId = await getTargetTabId(tabId)
        await assertManagedTab(resolvedTabId, context, operation)
        return resolvedTabId
    }

    private async getManagedScriptableTabId(
        tabId: number | undefined,
        context: ActionContext,
        operation: string
    ): Promise<number> {
        const resolvedTabId = await this.getManagedTabId(tabId, context, operation)
        await assertScriptable(resolvedTabId)
        return resolvedTabId
    }

    /**
     * 在目标 tab/frame 上执行 chrome.scripting.executeScript，返回脚本结果
     * 处理 injection 层错误（如 selector 非法、frame 不可注入）
     */
    private async injectScript<R>(
        tabId: number,
        frameId: number | undefined,
        func: InjectableFunc<R>,
        args: unknown[],
        documentId?: string
    ): Promise<R> {
        const results = await chrome.scripting
            .executeScript({
                target: documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [frameId ?? 0] },
                func: func as (...a: unknown[]) => R,
                args: args as never[],
                world: isCreatedTab(tabId) ? 'MAIN' : 'ISOLATED',
            })
            .catch((error: unknown) => {
                throw wrapInjectionError(error)
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
            throw structuredOperationError(
                'DEBUGGER_BLOCKED_SCREENSHOT_UNAVAILABLE',
                'debugger 被占用，且当前 tab 不是窗口内 active tab，无法通过 captureVisibleTab 截图',
                '请关闭占用 debugger 的扩展，或只在 managed 测试页上显式 activatePage 后重试；不要激活用户工作 tab',
                { tabId, fallback: 'captureVisibleTab', active: tab.active }
            )
        }
        // captureVisibleTab 只能截可视区域、只支持 png/jpeg；遇到 fullPage/clip/scale/webp
        // 应明确报错而非静默降级，避免上层拿到「viewport-only 但 success=true」或「PNG 字节贴 webp mimeType」
        if (p?.fullPage) {
            throw structuredOperationError(
                'SCREENSHOT_FALLBACK_UNSUPPORTED',
                'debugger 被占用时的 screenshot fallback 不支持 fullPage',
                '请关闭占用 debugger 的扩展后重试；fallback 只能截取当前可视区域',
                { tabId, fallback: 'captureVisibleTab', unsupported: 'fullPage' }
            )
        }
        if (p?.clip) {
            throw structuredOperationError(
                'SCREENSHOT_FALLBACK_UNSUPPORTED',
                'debugger 被占用时的 screenshot fallback 不支持 clip',
                '请关闭占用 debugger 的扩展后重试；fallback 不支持区域裁剪',
                { tabId, fallback: 'captureVisibleTab', unsupported: 'clip' }
            )
        }
        if (p?.scale !== undefined && p.scale !== 1) {
            throw structuredOperationError(
                'SCREENSHOT_FALLBACK_UNSUPPORTED',
                'debugger 被占用时的 screenshot fallback 不支持 scale',
                '请关闭占用 debugger 的扩展后重试；fallback 不支持缩放截图',
                { tabId, fallback: 'captureVisibleTab', unsupported: 'scale', scale: p.scale }
            )
        }
        if (p?.format && p.format !== 'jpeg' && p.format !== 'png') {
            throw structuredOperationError(
                'SCREENSHOT_FALLBACK_UNSUPPORTED',
                `debugger 被占用时的 screenshot fallback 不支持 format="${p.format}"`,
                '请关闭占用 debugger 的扩展后重试；fallback 仅支持 png/jpeg',
                { tabId, fallback: 'captureVisibleTab', unsupported: 'format', format: p.format }
            )
        }
        const format = p?.format === 'jpeg' ? 'jpeg' : 'png'
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
            format,
            quality: p?.quality,
        })
        const data = dataUrl.split(',')[1]
        assertScreenshotBase64Budget(data)
        return {
            data,
            format,
            degraded: true,
            fallback: 'captureVisibleTab',
            limitations: ['viewport-only'],
        }
    }
}
