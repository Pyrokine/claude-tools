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
import { ElementNotFoundError } from './errors.js'
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
import { escapeXPathString } from './utils.js'

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
    /** 超时时间（毫秒），默认 30000 */
    timeout?: number
    /** 第 N 个匹配元素（从 0 开始，默认 0 即第一个） */
    nth?: number
    /** 获取当前 URL 的回调（用于错误上下文） */
    getUrl?: () => string | undefined
}

/**
 * 转义 JavaScript 字符串
 */
function escapeJSString(str: string): string {
    return str
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
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
    private readonly timeout: number
    private readonly deadline: number
    private readonly nth: number
    private readonly getUrl?: () => string | undefined

    constructor(
        private cdp: CDPClient,
        private target: Target,
        private sessionId?: string,
        options: LocatorOptions = {}
    ) {
        this.timeout = options.timeout ?? DEFAULT_TIMEOUT
        this.deadline = Date.now() + this.timeout
        this.nth = options.nth ?? 0
        this.getUrl = options.getUrl
    }

    /**
     * 查找元素，返回节点 ID（带重试）
     */
    async find(): Promise<NodeId> {
        this.logs = []
        this.log(`定位元素: ${JSON.stringify(this.target)}`)

        if (isCoordinateTarget(this.target)) {
            // 坐标定位不需要 NodeId
            throw new Error('坐标定位不支持 find()，请使用 getClickablePoint()')
        }

        return withRetry(() => this.findInternal(), { timeout: this.remaining() })
    }

    /**
     * 获取元素中心坐标（用于点击）
     */
    async getClickablePoint(): Promise<Point> {
        if (isCoordinateTarget(this.target)) {
            return { x: this.target.x, y: this.target.y }
        }

        const nodeId = await this.find()
        const box = await this.getBoxModel(nodeId)

        return {
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
        }
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
     * @returns 函数返回值
     */
    async evaluateOn<T>(fn: string): Promise<T> {
        const nodeId = await this.find()

        // 将 nodeId 转换为 RemoteObjectId
        const { object } = (await this.send('DOM.resolveNode', {
            nodeId,
        })) as { object: { objectId: string } }

        if (!object?.objectId) {
            throw new ElementNotFoundError(this.target, this.timeout, this.logs, this.getUrl?.())
        }

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
        const { role, name } = this.target as { role: string; name?: string }
        this.log(`使用可访问性树定位: role=${role}, name=${name ?? '(any)'}${this.nth > 0 ? `, nth=${this.nth}` : ''}`)

        // 启用可访问性
        await this.send('Accessibility.enable')

        // queryAXTree 比 getFullAXTree 更高效：仅返回匹配 role/name 的节点
        const queryParams: Record<string, unknown> = { role }
        if (name !== undefined) {
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

        // 对所有匹配节点计数（含无 backendDOMNodeId 的节点），确保 nth 语义正确
        let matchCount = 0
        for (const node of nodes) {
            if (matchCount < this.nth) {
                ++matchCount
                continue
            }
            if (node.backendDOMNodeId) {
                this.log(
                    `找到元素: backendDOMNodeId=${node.backendDOMNodeId}${this.nth > 0 ? `（第 ${this.nth} 个）` : ''}`
                )
                // 将 backendDOMNodeId 转换为 nodeId
                const { nodeIds } = (await this.send('DOM.pushNodesByBackendIdsToFrontend', {
                    backendNodeIds: [node.backendDOMNodeId],
                })) as { nodeIds: number[] }
                if (nodeIds.length > 0 && nodeIds[0] !== 0) {
                    return nodeIds[0]
                }
            }
        }

        throw new ElementNotFoundError(this.target, this.timeout, this.logs, this.getUrl?.())
    }

    /**
     * 通过文本内容定位
     */
    private async findByText(): Promise<NodeId> {
        const { text, exact = false } = this.target as {
            text: string
            exact?: boolean
        }
        this.log(`使用文本内容定位: text=${text}, exact=${exact}${this.nth > 0 ? `, nth=${this.nth}` : ''}`)

        // 使用 XPath 查找包含文本的元素（正确转义引号）
        // 用 . 而非 text()：text() 只匹配直接子文本节点，. 匹配完整 textContent
        const escapedText = escapeXPathString(text)
        const xpath = exact ? `//*[normalize-space(.)=${escapedText}]` : `//*[contains(.,${escapedText})]`

        return this.findByXPathInternal(xpath)
    }

    /**
     * 通过 label 定位
     */
    private async findByLabel(): Promise<NodeId> {
        const { label, exact = false } = this.target as {
            label: string
            exact?: boolean
        }
        this.log(`使用 label 定位: label=${label}, exact=${exact}${this.nth > 0 ? `, nth=${this.nth}` : ''}`)

        // 转义 JS 字符串
        const escapedLabel = escapeJSString(label)

        // 使用 Runtime.evaluate 执行复杂查询
        const { result } = (await this.send('Runtime.evaluate', {
            expression: `
        (function() {
          const targetLabel = "${escapedLabel}";
          const isExact = ${exact};
          const nth = ${this.nth};
          const labels = document.querySelectorAll('label');
          let matchCount = 0;
          for (const label of labels) {
            const text = label.textContent?.trim() ?? '';
            const match = isExact ? text === targetLabel : text.includes(targetLabel);
            if (match) {
              let found = null;
              // 1. 通过 for 属性找关联元素
              if (label.htmlFor) {
                const input = document.getElementById(label.htmlFor);
                if (input) found = input;
              }
              // 2. 找 label 内部的 input
              if (!found) {
                const inner = label.querySelector('input, select, textarea');
                if (inner) found = inner;
              }
              // 3. 通过 label.id 推断（如 userName-label → #userName）
              if (!found && label.id && label.id.endsWith('-label')) {
                const inputId = label.id.slice(0, -6);
                const input = document.getElementById(inputId);
                if (input) found = input;
              }
              // 4. 在父元素的相邻兄弟中查找 input
              if (!found) {
                const parent = label.parentElement;
                if (parent) {
                  for (const sibling of parent.parentElement?.children ?? []) {
                    if (sibling === parent) continue;
                    const input = sibling.querySelector('input, select, textarea');
                    if (input) { found = input; break; }
                  }
                }
              }
              if (found) {
                if (matchCount < nth) { ++matchCount; continue; }
                return found;
              }
            }
          }
          return null;
        })()
      `,
            returnByValue: false,
        })) as { result: { objectId?: string } }

        if (!result.objectId) {
            throw new ElementNotFoundError(this.target, this.timeout, this.logs, this.getUrl?.())
        }

        return this.objectIdToNodeId(result.objectId)
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
        const { css, text, exact = false } = this.target as { css: string; text: string; exact?: boolean }
        this.log(
            `使用 CSS+text 组合定位: css=${css}, text=${text}, exact=${exact}${this.nth > 0 ? `, nth=${this.nth}` : ''}`
        )

        const escapedCSS = escapeJSString(css)
        const escapedText = escapeJSString(text)

        const { result } = (await this.send('Runtime.evaluate', {
            expression: `
        (function() {
          const elements = document.querySelectorAll("${escapedCSS}");
          const target = "${escapedText}";
          const isExact = ${exact};
          const nth = ${this.nth};
          let matchCount = 0;
          for (const el of elements) {
            const content = (el.textContent ?? '').trim();
            if (isExact ? content === target : content.includes(target)) {
              if (matchCount < nth) { ++matchCount; continue; }
              return el;
            }
          }
          return null;
        })()
      `,
            returnByValue: false,
        })) as { result: { objectId?: string } }

        if (!result.objectId) {
            throw new ElementNotFoundError(this.target, this.timeout, this.logs, this.getUrl?.())
        }

        return this.objectIdToNodeId(result.objectId)
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
        // 确保 DOM 已启用
        const { root } = (await this.send('DOM.getDocument')) as {
            root: { nodeId: number }
        }

        if (this.nth > 0) {
            // nth > 0：用 querySelectorAll 取第 nth 个
            const { nodeIds } = (await this.send('DOM.querySelectorAll', {
                nodeId: root.nodeId,
                selector: css,
            })) as { nodeIds: number[] }

            if (this.nth >= nodeIds.length) {
                this.log(`第 ${this.nth} 个匹配元素不存在（共 ${nodeIds.length} 个）: ${css}`)
                throw new ElementNotFoundError(this.target, this.timeout, this.logs, this.getUrl?.())
            }

            this.log(`找到元素: nodeId=${nodeIds[this.nth]}（第 ${this.nth} 个）`)
            return nodeIds[this.nth]
        }

        const { nodeId } = (await this.send('DOM.querySelector', {
            nodeId: root.nodeId,
            selector: css,
        })) as { nodeId: number }

        if (nodeId === 0) {
            this.log(`元素未找到: ${css}`)
            throw new ElementNotFoundError(this.target, this.timeout, this.logs, this.getUrl?.())
        }

        this.log(`找到元素: nodeId=${nodeId}`)
        return nodeId
    }

    /**
     * XPath 定位内部实现
     */
    private async findByXPathInternal(xpath: string): Promise<NodeId> {
        const escapedXPath = escapeJSString(xpath)

        if (this.nth > 0) {
            // nth > 0：用 ORDERED_NODE_SNAPSHOT_TYPE 取第 nth 个
            const nthExpr =
                `(function() { var r = document.evaluate('${escapedXPath}', document, null, ` +
                `XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); ` +
                `return r.snapshotLength > ${this.nth} ? r.snapshotItem(${this.nth}) : null })()`
            const { result } = (await this.send('Runtime.evaluate', {
                expression: nthExpr,
                returnByValue: false,
            })) as { result: { objectId?: string; subtype?: string } }

            if (!result.objectId || result.subtype === 'null') {
                this.log(`第 ${this.nth} 个匹配元素不存在: ${xpath}`)
                throw new ElementNotFoundError(this.target, this.timeout, this.logs, this.getUrl?.())
            }

            return this.objectIdToNodeId(result.objectId)
        }

        // 使用 Runtime.evaluate 执行 XPath
        const xpathExpr =
            `document.evaluate('${escapedXPath}', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)` +
            `.singleNodeValue`
        const { result } = (await this.send('Runtime.evaluate', {
            expression: xpathExpr,
            returnByValue: false,
        })) as { result: { objectId?: string } }

        if (!result.objectId) {
            this.log(`元素未找到: ${xpath}`)
            throw new ElementNotFoundError(this.target, this.timeout, this.logs, this.getUrl?.())
        }

        return this.objectIdToNodeId(result.objectId)
    }

    /**
     * 将 RemoteObject ID 转换为 NodeId
     */
    private async objectIdToNodeId(objectId: RemoteObjectId): Promise<NodeId> {
        // DOM.requestNode 需要 DOM 树已初始化（通过 DOM.getDocument）
        await this.send('DOM.getDocument')

        const { nodeId } = (await this.send('DOM.requestNode', {
            objectId,
        })) as { nodeId: number }

        if (nodeId === 0) {
            throw new ElementNotFoundError(this.target, this.timeout, this.logs, this.getUrl?.())
        }

        this.log(`找到元素: nodeId=${nodeId}`)
        return nodeId
    }

    /**
     * 获取元素边界框
     */
    private async getBoxModel(nodeId: NodeId): Promise<Box> {
        const { model } = (await this.send('DOM.getBoxModel', { nodeId })) as {
            model: { content: number[] }
        }

        // content 是 [x1,y1, x2,y2, x3,y3, x4,y4] 格式的四个角坐标
        const [x1, y1, x2, , , , , y4] = model.content

        return {
            x: x1,
            y: y1,
            width: x2 - x1,
            height: y4 - y1,
        }
    }

    /**
     * 发送 CDP 命令
     *
     * 使用 deadline 剩余时间而非静态 timeout，确保单个 CDP 命令不会超出整体预算，
     * withRetry() 在重试间隙检查 deadline，此处保证单命令在当前 tick 内也受预算约束
     */
    private send<T>(method: string, params?: object): Promise<T> {
        return this.cdp.send(method, params, this.sessionId, this.remaining())
    }

    /**
     * deadline 剩余时间（至少 1ms，防止 0 被当作无超时）
     */
    private remaining(): number {
        return Math.max(1, this.deadline - Date.now())
    }

    /**
     * 记录日志
     */
    private log(message: string): void {
        this.logs.push(message)
    }
}
