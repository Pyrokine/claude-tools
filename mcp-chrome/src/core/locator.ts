/**
 * 元素定位器
 *
 * 统一的元素定位逻辑，支持多种定位方式：
 * - 可访问性树（role/name）
 * - 文本内容
 * - CSS 选择器
 * - XPath
 * - 坐标
 *
 * 设计原则：
 * - 封装：隐藏定位细节，暴露简洁接口
 * - 以对象取代基本类型：Target 对象而非字符串
 */

import type { CDPClient } from '../cdp/client.js'
import { installDomHelpers, type DomQuery } from './dom-helpers.js'
import { ElementNotFoundError, StructuredToolError } from './errors.js'
import { withRetry } from './retry.js'
import {
    type Box,
    DEFAULT_TIMEOUT,
    isAltTarget,
    isCoordinateTarget,
    isCSSTarget,
    isCSSTextTarget,
    isLabelTarget,
    isPlaceholderTarget,
    isRoleTarget,
    isTestIdTarget,
    isTextTarget,
    isTitleTarget,
    isXPathTarget,
    type Point,
    type Target,
} from './types.js'
import { sanitizeErrorMessage } from './error-sanitizer.js'

/**
 * CDP DOM 节点 ID
 */
type NodeId = number

/**
 * CDP Remote Object ID
 */
type RemoteObjectId = string

/**
 * Locator 选项
 */
export interface LocatorOptions {
    contextId?: number
    localPoint?: (timeout: number) => Promise<boolean>
    mapPoint?: (point: Point, timeout: number) => Promise<Point>
    mapViewportPoint?: (point: Point, timeout: number) => Promise<Point>
    /** 超时时间（毫秒），默认 30000 */
    timeout?: number
    /** 第 N 个匹配元素（从 0 开始，默认 0 即第一个） */
    nth?: number
    /** 获取当前 URL 的回调（用于错误上下文） */
    getUrl?: () => string | undefined
}

/**
 * 转义 CSS 属性选择器值
 * CSS.escape() 的 polyfill
 */
function escapeCSSAttributeValue(str: string): string {
    return str.replace(/["\\]/g, '\\$&')
}

/**
 * 元素定位器
 */
export class Locator {
    private logs: string[] = []
    private observation: { matchCount: number | null; lastLocatorState: string } = {
        matchCount: null,
        lastLocatorState: 'unobserved',
    }

    private readonly timeout: number
    private readonly deadline: number
    private readonly nth: number
    private readonly getUrl?: () => string | undefined
    private readonly contextId?: number

    constructor(
        private cdp: CDPClient,
        private target: Target,
        private sessionId?: string,
        private options: LocatorOptions = {}
    ) {
        this.timeout = options.timeout ?? DEFAULT_TIMEOUT
        this.deadline = Date.now() + this.timeout
        this.nth = options.nth ?? 0
        this.getUrl = options.getUrl
        this.contextId = options.contextId
    }

    get lastObservation(): Readonly<{ matchCount: number | null; lastLocatorState: string }> {
        return { ...this.observation }
    }

    /**
     * 查找元素，返回节点 ID（带重试）
     */
    async find(retry = true): Promise<NodeId> {
        this.logs = []
        this.log(`定位元素: ${JSON.stringify(this.target)}`)

        if (isCoordinateTarget(this.target)) {
            // 坐标定位不需要 NodeId
            throw new Error('坐标定位不支持 find()，请使用 getClickablePoint()')
        }

        return retry ? withRetry(() => this.findInternal(), { timeout: this.remaining() }) : this.findInternal()
    }

    /**
     * 获取元素中心坐标（用于点击）
     */
    async getClickablePoint(): Promise<Point> {
        if (isCoordinateTarget(this.target)) {
            const point = { x: this.target.x, y: this.target.y }
            return this.options.mapPoint ? this.options.mapPoint(point, this.remaining()) : point
        }

        if (await this.options.localPoint?.(this.remaining())) {
            // Chrome omits inherited iframe CSS zoom from same-session selector quads.
            const point = await this.evaluateOn<Point>(
                `function(){const r=this.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}`
            )
            return this.options.mapPoint!(point, this.remaining())
        }
        const nodeId = await this.find()
        const { model } = await this.send<{ model: { content: number[] } }>('DOM.getBoxModel', { nodeId })
        const quad = model.content
        const point = { x: (quad[0] + quad[4]) / 2, y: (quad[1] + quad[5]) / 2 }
        return this.options.mapViewportPoint ? this.options.mapViewportPoint(point, this.remaining()) : point
    }

    /**
     * 获取元素边界框
     */
    async getBoundingBox(): Promise<Box> {
        if (isCoordinateTarget(this.target)) {
            return { x: this.target.x, y: this.target.y, width: 0, height: 0 }
        }

        const nodeId = await this.find()
        return this.getBoxModel(nodeId)
    }

    /**
     * 在找到的元素上执行函数
     *
     * @param fn 要执行的函数字符串，元素作为第一个参数
     * @param retry 是否在定位失败时按当前预算重试
     * @returns 函数返回值
     */
    async evaluateOn<T>(fn: string, retry = true): Promise<T> {
        const nodeId = await this.find(retry)

        // 将 nodeId 转换为 RemoteObjectId
        const { object } = (await this.send('DOM.resolveNode', {
            nodeId,
        })) as { object: { objectId: string } }

        if (!object?.objectId) {
            this.observation.lastLocatorState = 'node_resolution_failed'
            throw this.notFound()
        }

        try {
            // 在元素上执行函数
            const { result, exceptionDetails } = (await this.send('Runtime.callFunctionOn', {
                objectId: object.objectId,
                functionDeclaration: fn,
                returnByValue: true,
            })) as {
                result: { value: T }
                exceptionDetails?: { text: string }
            }

            if (exceptionDetails) {
                throw new Error(`执行失败: ${exceptionDetails.text}`)
            }

            return result.value
        } finally {
            await this.cdp
                .send('Runtime.releaseObject', { objectId: object.objectId }, this.sessionId)
                .catch((error: unknown) => {
                    console.warn('[MCP] Locator object cleanup failed:', sanitizeErrorMessage(error))
                })
        }
    }

    /**
     * 查找元素的内部实现（单次尝试）
     */
    private async findInternal(): Promise<NodeId> {
        if (isRoleTarget(this.target)) {
            return this.findByAccessibility()
        }
        // CSS+text 必须在纯 text / 纯 CSS 之前：{css, text} 同时满足三者
        if (isCSSTextTarget(this.target)) {
            return this.findByCSSAndText()
        }
        if (isTextTarget(this.target)) {
            return this.findByText()
        }
        if (isLabelTarget(this.target)) {
            return this.findByLabel()
        }
        if (isPlaceholderTarget(this.target)) {
            return this.findByPlaceholder()
        }
        if (isTitleTarget(this.target)) {
            return this.findByTitle()
        }
        if (isAltTarget(this.target)) {
            return this.findByAlt()
        }
        if (isTestIdTarget(this.target)) {
            return this.findByTestId()
        }
        if (isCSSTarget(this.target)) {
            return this.findByCSS()
        }
        if (isXPathTarget(this.target)) {
            return this.findByXPath()
        }

        throw new Error(`不支持的 target 类型: ${JSON.stringify(this.target)}`)
    }

    /**
     * 通过可访问性树定位
     */
    private async findByAccessibility(): Promise<NodeId> {
        const {
            role: requestedRole,
            name,
            exact = false,
        } = this.target as { role: string; name?: string; exact?: boolean }
        const role = requestedRole.toLowerCase() === 'img' ? 'image' : requestedRole.toLowerCase()
        this.log(
            `使用可访问性树定位: role=${role}, name=${name ?? '(any)'}, exact=${exact}${
                this.nth > 0 ? `, nth=${this.nth}` : ''
            }`
        )

        // 启用可访问性
        await this.send('Accessibility.enable')

        // queryAXTree 必须指定根节点，accessibleName 仅用于精确匹配
        const root =
            this.contextId === undefined
                ? ((await this.send('DOM.getDocument')) as { root: { nodeId: number } }).root
                : { nodeId: await this.queryDom({ selector: ':root' }, 0) }
        const queryParams: Record<string, unknown> = { nodeId: root.nodeId, role }
        if (exact && name !== undefined) {
            queryParams.accessibleName = name
        }
        const { nodes } = (await this.send('Accessibility.queryAXTree', queryParams)) as {
            nodes: Array<{
                nodeId: string
                role: { value: string }
                name?: { value: string }
                backendDOMNodeId?: number
            }>
        }

        const matchingNodes = nodes.filter(
            (node) =>
                node.role.value === role &&
                (name === undefined || (exact ? node.name?.value === name : node.name?.value.includes(name)))
        )

        this.observeMatches(matchingNodes.length)
        const node = matchingNodes[this.nth]
        if (node?.backendDOMNodeId) {
            this.log(`找到元素: backendDOMNodeId=${node.backendDOMNodeId}（第 ${this.nth} 个）`)
            const { nodeIds } = (await this.send('DOM.pushNodesByBackendIdsToFrontend', {
                backendNodeIds: [node.backendDOMNodeId],
            })) as { nodeIds: number[] }
            if (nodeIds[0]) {
                return nodeIds[0]
            }
        }
        if (node) {
            this.observation.lastLocatorState = 'node_resolution_failed'
        }

        throw this.notFound()
    }

    /**
     * 通过文本内容定位
     */
    private async findByText(): Promise<NodeId> {
        const { text, exact = false } = this.target as { text: string; exact?: boolean }
        return this.queryDom({ text, exact })
    }

    /**
     * 通过 label 定位
     */
    private async findByLabel(): Promise<NodeId> {
        const { label, exact = false } = this.target as { label: string; exact?: boolean }
        return this.queryDom({
            selector: 'input,select,textarea,button,meter,output,progress,[aria-label],[aria-labelledby]',
            semantic: { label, exact },
        })
    }

    /**
     * 通过 placeholder 定位
     */
    private async findByPlaceholder(): Promise<NodeId> {
        const { placeholder, exact = false } = this.target as {
            placeholder: string
            exact?: boolean
        }
        this.log(
            `使用 placeholder 定位: placeholder=${placeholder}, exact=${exact}${
                this.nth > 0 ? `, nth=${this.nth}` : ''
            }`
        )

        const escaped = escapeCSSAttributeValue(placeholder)
        const css = exact ? `[placeholder="${escaped}"]` : `[placeholder*="${escaped}"]`

        return this.findByCSSInternal(css)
    }

    /**
     * 通过 title 属性定位
     */
    private async findByTitle(): Promise<NodeId> {
        const { title, exact = false } = this.target as {
            title: string
            exact?: boolean
        }
        this.log(`使用 title 属性定位: title=${title}, exact=${exact}${this.nth > 0 ? `, nth=${this.nth}` : ''}`)

        const escaped = escapeCSSAttributeValue(title)
        const css = exact ? `[title="${escaped}"]` : `[title*="${escaped}"]`

        return this.findByCSSInternal(css)
    }

    /**
     * 通过 alt 属性定位
     */
    private async findByAlt(): Promise<NodeId> {
        const { alt, exact = false } = this.target as {
            alt: string
            exact?: boolean
        }
        this.log(`使用 alt 属性定位: alt=${alt}, exact=${exact}${this.nth > 0 ? `, nth=${this.nth}` : ''}`)

        const escaped = escapeCSSAttributeValue(alt)
        const css = exact ? `[alt="${escaped}"]` : `[alt*="${escaped}"]`

        return this.findByCSSInternal(css)
    }

    /**
     * 通过 data-testid 定位
     */
    private async findByTestId(): Promise<NodeId> {
        const { testId } = this.target as { testId: string }
        this.log(`使用 data-testid 定位: testId=${testId}${this.nth > 0 ? `, nth=${this.nth}` : ''}`)

        const escaped = escapeCSSAttributeValue(testId)
        return this.findByCSSInternal(`[data-testid="${escaped}"]`)
    }

    /**
     * 通过 CSS 选择器定位
     */
    private async findByCSS(): Promise<NodeId> {
        const { css } = this.target as { css: string }
        this.log(`使用 CSS 选择器定位: css=${css}`)

        return this.findByCSSInternal(css)
    }

    /**
     * 通过 CSS + 文本组合定位
     */
    private async findByCSSAndText(): Promise<NodeId> {
        const target = this.target as { css: string; text: string; exact?: boolean }
        return this.queryDom({ selector: target.css, text: target.text, exact: target.exact })
    }

    /**
     * 通过 XPath 定位
     */
    private async findByXPath(): Promise<NodeId> {
        const { xpath } = this.target as { xpath: string }
        this.log(`使用 XPath 定位: xpath=${xpath}`)

        return this.findByXPathInternal(xpath)
    }

    /**
     * CSS 选择器定位内部实现
     */
    private async findByCSSInternal(css: string): Promise<NodeId> {
        return this.queryDom({ selector: css })
    }

    /**
     * XPath 定位内部实现
     */
    private async findByXPathInternal(xpath: string): Promise<NodeId> {
        return this.queryDom({ xpath })
    }

    private async queryDom(query: DomQuery, index = this.nth): Promise<NodeId> {
        const expression =
            '(function(){(' +
            installDomHelpers.toString() +
            ')();const matches=globalThis.__mcpDomHelpers.query(' +
            JSON.stringify(query) +
            ');return {node:matches[' +
            index +
            ']??null,count:matches.length};})()'
        const { result, exceptionDetails } = await this.send<{
            result: { objectId?: string }
            exceptionDetails?: { text?: string; exception?: { className?: string; description?: string } }
        }>('Runtime.evaluate', { expression, returnByValue: false })
        if (exceptionDetails) {
            const exception = exceptionDetails.exception
            const message = exception?.description ?? exceptionDetails.text ?? 'DOM query failed'
            if (
                (query.selector || query.xpath) &&
                (exception?.className === 'SyntaxError' ||
                    (exception?.className === 'DOMException' && /^SyntaxError:/.test(message)))
            ) {
                throw new StructuredToolError('INVALID_SELECTOR', message, '请检查 target 的 CSS 或 XPath 表达式', {
                    phase: 'script_result',
                    actionExecuted: false,
                    actionStatus: 'not_started',
                    retryable: false,
                })
            }
            throw new Error(message)
        }
        if (!result.objectId) {
            throw this.notFound()
        }
        try {
            const { result: properties } = await this.send<{
                result: Array<{ name: string; value?: { value?: number; objectId?: string; subtype?: string } }>
            }>('Runtime.getProperties', { objectId: result.objectId, ownProperties: true })
            this.observeMatches(properties.find((item) => item.name === 'count')?.value?.value ?? 0)
            const node = properties.find((item) => item.name === 'node')?.value
            if (!node?.objectId || node.subtype === 'null') {
                throw this.notFound()
            }
            return await this.objectIdToNodeId(node.objectId)
        } finally {
            await this.cdp
                .send('Runtime.releaseObject', { objectId: result.objectId }, this.sessionId)
                .catch((error: unknown) => {
                    console.warn('[MCP] DOM query object cleanup failed:', sanitizeErrorMessage(error))
                })
        }
    }

    /**
     * 将 RemoteObject ID 转换为 NodeId
     */
    private async objectIdToNodeId(objectId: RemoteObjectId): Promise<NodeId> {
        try {
            // DOM.requestNode 需要 DOM 树已初始化（通过 DOM.getDocument）
            await this.send('DOM.getDocument')

            const { nodeId } = (await this.send('DOM.requestNode', {
                objectId,
            })) as { nodeId: number }

            if (nodeId === 0) {
                this.observation.lastLocatorState = 'node_resolution_failed'
                throw this.notFound()
            }

            this.observation.lastLocatorState = 'found'
            this.log(`找到元素: nodeId=${nodeId}`)
            return nodeId
        } finally {
            await this.cdp.send('Runtime.releaseObject', { objectId }, this.sessionId).catch((error: unknown) => {
                console.warn('[MCP] Locator object cleanup failed:', sanitizeErrorMessage(error))
            })
        }
    }

    /**
     * 获取元素边界框
     */
    private async getBoxModel(nodeId: NodeId): Promise<Box> {
        const { model } = (await this.send('DOM.getBoxModel', { nodeId })) as {
            model: { content: number[] }
        }

        // content 是 [x1,y1, x2,y2, x3,y3, x4,y4] 格式的四个角坐标
        const xs = model.content.filter((_, index) => index % 2 === 0)
        const ys = model.content.filter((_, index) => index % 2 === 1)
        const x = Math.min(...xs)
        const y = Math.min(...ys)
        return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
    }

    /**
     * 发送 CDP 命令
     *
     * 使用 deadline 剩余时间而非静态 timeout，确保单个 CDP 命令不会超出整体预算，
     * withRetry() 在重试间隙检查 deadline，此处保证单命令在当前 tick 内也受预算约束
     */
    private send<T>(method: string, params?: object): Promise<T> {
        const scoped =
            method === 'Runtime.evaluate' && this.contextId !== undefined
                ? { ...params, contextId: this.contextId }
                : params
        return this.cdp.send(method, scoped, this.sessionId, this.remaining())
    }

    /**
     * deadline 剩余时间（至少 1ms，防止 0 被当作无超时）
     */
    private remaining(): number {
        return Math.max(1, this.deadline - Date.now())
    }

    private observeMatches(matchCount: number): void {
        this.observation = {
            matchCount,
            lastLocatorState: matchCount === 0 ? 'not_found' : this.nth >= matchCount ? 'index_out_of_range' : 'found',
        }
    }

    private notFound(): ElementNotFoundError {
        if (this.observation.lastLocatorState === 'unobserved' || this.observation.lastLocatorState === 'found') {
            this.observation.lastLocatorState = 'not_found'
        }
        return new ElementNotFoundError(this.target, this.timeout, this.logs, this.getUrl?.(), this.lastObservation)
    }

    /**
     * 记录日志
     */
    private log(message: string): void {
        this.logs.push(message)
    }
}
