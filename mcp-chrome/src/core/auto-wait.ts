/**
 * 自动等待机制
 *
 * 参考 Puppeteer Locator 的自动等待：
 * - waitForEnabled: 等待元素可用
 * - waitForStableBoundingBox: 等待位置稳定
 * - ensureInViewport: 确保元素在视口内
 *
 * 核心思想：操作前自动检查元素状态，失败则重试，而非立即报错
 */

import type { CDPClient } from '../cdp/client.js'
import { StructuredToolError } from './errors.js'
import { withRetry } from './retry.js'
import { DEFAULT_TIMEOUT, type Box } from './types.js'

/**
 * AutoWait 选项
 */
export interface AutoWaitOptions {
    /** 超时时间（毫秒），默认 30000 */
    timeout?: number
}

/**
 * 自动等待类
 */
export class AutoWait {
    private readonly timeout: number
    private readonly deadline: number

    constructor(
        private cdp: CDPClient,
        private sessionId: string,
        options: AutoWaitOptions = {}
    ) {
        this.timeout = options.timeout ?? DEFAULT_TIMEOUT
        this.deadline = Date.now() + this.timeout
    }

    /**
     * 等待元素可用（非禁用状态）
     *
     * 参考：Puppeteer #waitForEnabledIfNeeded
     * 对于表单控件（BUTTON, INPUT, SELECT, TEXTAREA），检查是否有 disabled 属性
     */
    async waitForEnabled(nodeId: number): Promise<void> {
        await withRetry(
            async () => {
                const { object } = (await this.send('DOM.resolveNode', { nodeId })) as {
                    object: { objectId: string }
                }

                const { result } = (await this.send('Runtime.callFunctionOn', {
                    objectId: object.objectId,
                    functionDeclaration: `function() {
            if (!(this instanceof HTMLElement)) return true;
            const formControls = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'];
            if (!formControls.includes(this.nodeName)) return true;
            return !this.hasAttribute('disabled');
          }`,
                    returnByValue: true,
                })) as { result: { value: boolean } }

                if (!result.value) {
                    throw new Error('元素处于禁用状态')
                }
            },
            { timeout: this.remaining() }
        )
    }

    /**
     * 等待元素位置稳定（两次采样对比）
     *
     * 参考：Puppeteer #waitForStableBoundingBoxIfNeeded
     * 采样间隔由 Node 计时，不依赖后台页面的动画帧
     */
    async waitForStableBoundingBox(nodeId: number): Promise<void> {
        await withRetry(
            async () => {
                const { object } = (await this.send('DOM.resolveNode', { nodeId })) as {
                    object: { objectId: string }
                }
                const params = {
                    objectId: object.objectId,
                    functionDeclaration: `function() {
                        const { x, y, width, height } = this.getBoundingClientRect();
                        return { x, y, width, height };
                    }`,
                    returnByValue: true,
                }
                const { result: first } = (await this.send('Runtime.callFunctionOn', params)) as {
                    result: { value: Box }
                }
                await new Promise((resolve) => setTimeout(resolve, Math.min(32, this.remaining())))
                const { result: second } = (await this.send('Runtime.callFunctionOn', params)) as {
                    result: { value: Box }
                }
                if (
                    first.value.x !== second.value.x ||
                    first.value.y !== second.value.y ||
                    first.value.width !== second.value.width ||
                    first.value.height !== second.value.height
                ) {
                    throw new Error('元素位置不稳定')
                }
            },
            { timeout: this.remaining() }
        )
    }

    /**
     * 确保元素在视口内
     *
     * 参考：Puppeteer #ensureElementIsInTheViewportIfNeeded
     * 如果元素不在视口内，自动滚动到视口中
     */
    async ensureInViewport(nodeId: number): Promise<void> {
        const { object } = (await this.send('DOM.resolveNode', { nodeId })) as {
            object: { objectId: string }
        }

        // 检查是否在视口内
        const { result: isInViewport } = (await this.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: `function() {
        const rect = this.getBoundingClientRect();
        return rect.top >= 0 && rect.left >= 0 &&
               rect.bottom <= window.innerHeight &&
               rect.right <= window.innerWidth;
      }`,
            returnByValue: true,
        })) as { result: { value: boolean } }

        // 如果不在视口内，滚动到视口中
        if (!isInViewport.value) {
            await this.send('Runtime.callFunctionOn', {
                objectId: object.objectId,
                functionDeclaration: `function() {
          this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        }`,
            })

            // 等待滚动完成
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
    }

    /**
     * 等待元素可见
     *
     * 检查元素的 visibility 不为 hidden，且有非空边界框
     */
    async waitForVisible(nodeId: number): Promise<void> {
        await withRetry(
            async () => {
                const { object } = (await this.send('DOM.resolveNode', { nodeId })) as {
                    object: { objectId: string }
                }

                const { result } = (await this.send('Runtime.callFunctionOn', {
                    objectId: object.objectId,
                    functionDeclaration: `function() {
            const style = window.getComputedStyle(this);
            if (style.visibility === 'hidden') return false;
            if (style.display === 'none') return false;
            const rect = this.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }`,
                    returnByValue: true,
                })) as { result: { value: boolean } }

                if (!result.value) {
                    throw new Error('元素不可见')
                }
            },
            { timeout: this.remaining() }
        )
    }

    /**
     * 执行点击前的所有等待检查
     *
     * 包括：enabled + stableBoundingBox + inViewport
     */
    async waitForClickable(nodeId: number): Promise<void> {
        await this.waitForVisible(nodeId)
        await this.waitForEnabled(nodeId)
        await this.waitForStableBoundingBox(nodeId)
        await this.ensureInViewport(nodeId)
        await withRetry(
            async () => {
                const { object } = (await this.send('DOM.resolveNode', { nodeId })) as {
                    object: { objectId: string }
                }
                const { result } = (await this.send('Runtime.callFunctionOn', {
                    objectId: object.objectId,
                    functionDeclaration: `function() {
                    const rect = this.getBoundingClientRect();
                    const clickPoint = {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
                    const top = document.elementFromPoint(clickPoint.x, clickPoint.y);
                    const describe = el => el.tagName.toLowerCase() + (el.id ? '#' + CSS.escape(el.id) : '');
                    const plainRect = r => ({x: r.x, y: r.y, width: r.width, height: r.height});
                    const covered = top !== this && !(top && this.contains(top));
                    return {
                        actionable: this.isConnected && !covered,
                        reason: !this.isConnected ? 'not-connected' : !top ? 'not-in-viewport' : 'covered',
                        rect: plainRect(rect), clickPoint,
                        coveringElement: covered && top ? describe(top).slice(0, 500) : undefined,
                        candidates: document.elementsFromPoint(clickPoint.x, clickPoint.y).slice(0, 10).map(el => ({
                            tag: el.tagName.toLowerCase(), selector: describe(el).slice(0, 500),
                            text: (el.textContent || '').trim().slice(0, 160), rect: plainRect(el.getBoundingClientRect())
                        }))
                    };
                }`,
                    returnByValue: true,
                })) as { result: { value: Record<string, unknown> & { actionable: boolean } } }
                if (!result.value.actionable) {
                    throw new StructuredToolError(
                        'ACTIONABILITY_FAILED',
                        '点击目标无法接收鼠标事件，未执行点击',
                        '请根据 rect、clickPoint 和 coveringElement 关闭遮罩或调整 target；直接触发目标事件需明确使用 force',
                        result.value
                    )
                }
            },
            { timeout: this.remaining() }
        )
    }

    /**
     * 执行输入前的所有等待检查
     *
     * 包括：visible + enabled + stableBoundingBox + inViewport
     */
    async waitForInputReady(nodeId: number): Promise<void> {
        await this.waitForVisible(nodeId)
        await this.waitForEnabled(nodeId)
        await this.waitForStableBoundingBox(nodeId)
        await this.ensureInViewport(nodeId)
    }

    /**
     * 发送 CDP 命令
     *
     * 使用 deadline 剩余时间，确保单命令不超出整体预算
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
}
