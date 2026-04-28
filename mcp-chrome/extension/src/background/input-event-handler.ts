import { InputKeySchema, InputMouseSchema, InputTouchSchema, InputTypeSchema } from '../types/schemas'
import { getTargetTabId } from './action-utils'
import { DebuggerManager } from './debugger-manager'

export class InputEventHandler {
    /** 按 tabId 维护当前按下的鼠标按键 mask（W3C MouseEvent.buttons），
     *  用于在 mouseMoved 事件中正确报告"按住按键移动"的状态，
     *  让 sortablejs/react-dnd HTML5-fallback 等基于 event.buttons 检测拖拽的库正常工作 */
    private buttonsState = new Map<number, number>()

    constructor(private debuggerManager: DebuggerManager) {}

    /** 清理 tab 关闭后的鼠标状态，防止内存泄漏 */
    cleanupTab(tabId: number): void {
        this.buttonsState.delete(tabId)
    }

    async inputKey(params: unknown): Promise<{ success: boolean }> {
        const p = InputKeySchema.parse(params)

        const tabId = await getTargetTabId(p.tabId)
        await this.debuggerManager.ensureAttached(tabId)

        const cdpParams: Record<string, unknown> = {
            type: p.type,
        }

        if (p.key) {
            cdpParams.key = p.key
        }
        if (p.code) {
            cdpParams.code = p.code
        }
        if (p.text) {
            cdpParams.text = p.text
        }
        if (p.unmodifiedText) {
            cdpParams.unmodifiedText = p.unmodifiedText
        }
        if (p.location !== undefined) {
            cdpParams.location = p.location
        }
        if (p.isKeypad) {
            cdpParams.isKeypad = p.isKeypad
        }
        if (p.autoRepeat) {
            cdpParams.autoRepeat = p.autoRepeat
        }
        if (p.windowsVirtualKeyCode !== undefined) {
            cdpParams.windowsVirtualKeyCode = p.windowsVirtualKeyCode
        }
        if (p.nativeVirtualKeyCode !== undefined) {
            cdpParams.nativeVirtualKeyCode = p.nativeVirtualKeyCode
        }
        if (p.modifiers !== undefined) {
            cdpParams.modifiers = p.modifiers
        }
        if (p.commands && p.commands.length > 0) {
            cdpParams.commands = p.commands
        }

        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', cdpParams)

        return { success: true }
    }

    async inputMouse(params: unknown): Promise<{ success: boolean }> {
        const p = InputMouseSchema.parse(params)

        const tabId = await getTargetTabId(p.tabId)

        // mouseWheel: chrome.debugger sendCommand for Input.dispatchMouseEvent(mouseWheel) never resolves
        // in Extension mode — dispatch WheelEvent via scripting.executeScript instead
        if (p.type === 'mouseWheel') {
            const frameIds = [p.frameId ?? 0]
            const results = await chrome.scripting.executeScript({
                target: { tabId, frameIds },
                world: 'MAIN',
                func: (x: number, y: number, deltaX: number, deltaY: number) => {
                    const el = document.elementFromPoint(x, y)
                    const target = el ?? document.documentElement
                    target.dispatchEvent(
                        new WheelEvent('wheel', {
                            bubbles: true,
                            cancelable: true,
                            deltaX,
                            deltaY,
                            deltaMode: 0,
                            clientX: x,
                            clientY: y,
                        })
                    )
                    // 直接滚动最近的可滚动祖先
                    let node: Element | null = target
                    while (node) {
                        const style = window.getComputedStyle(node)
                        const overflowY = style.overflowY
                        if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
                            node.scrollBy(deltaX, deltaY)
                            return { success: true }
                        }
                        node = node.parentElement
                    }
                    window.scrollBy(deltaX, deltaY)
                    return { success: true }
                },
                args: [p.x, p.y, p.deltaX ?? 0, p.deltaY ?? 0],
            })
            return (results[0]?.result as { success: boolean }) ?? { success: true }
        }

        await this.debuggerManager.ensureAttached(tabId)

        const cdpParams: Record<string, unknown> = {
            type: p.type,
            x: p.x,
            y: p.y,
        }

        if (p.button && p.button !== 'none') {
            cdpParams.button = p.button
        }
        if (p.clickCount !== undefined) {
            cdpParams.clickCount = p.clickCount
        }
        if (p.modifiers !== undefined) {
            cdpParams.modifiers = p.modifiers
        }

        // CDP 需要 buttons 位掩码（W3C MouseEvent.buttons）才能正确触发 DOM mousedown/mouseup listener
        // Input.dispatchMouseEvent 不带 buttons 时，Chrome 视作"无按键按下"，独立 mousedown 不派发 DOM 事件
        // Left=1 Right=2 Middle=4 Back=8 Forward=16
        const BUTTON_MASK: Record<string, number> = { left: 1, right: 2, middle: 4, back: 8, forward: 16 }
        const effectiveButton = p.button && p.button !== 'none' ? p.button : undefined

        let buttons = this.buttonsState.get(tabId) ?? 0
        if (p.type === 'mousePressed') {
            const bit = effectiveButton ? (BUTTON_MASK[effectiveButton] ?? 1) : 1
            buttons |= bit
            this.buttonsState.set(tabId, buttons)
            cdpParams.buttons = buttons
        } else if (p.type === 'mouseReleased') {
            const bit = effectiveButton ? (BUTTON_MASK[effectiveButton] ?? 0) : 0
            buttons &= ~bit
            if (buttons === 0) {
                this.buttonsState.delete(tabId)
            } else {
                this.buttonsState.set(tabId, buttons)
            }
            cdpParams.buttons = buttons
        } else if (p.type === 'mouseMoved') {
            // mouseMoved 时复用 buttonsState：拖拽期间 buttons 应反映当前持续按下的按键
            // 让基于 event.buttons 检测的 JS 拖拽库（sortablejs HTML5-fallback、react-dnd HTML5-fallback）正常工作
            cdpParams.buttons = buttons
        }

        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', cdpParams)

        return { success: true }
    }

    async inputTouch(params: unknown): Promise<{ success: boolean }> {
        const p = InputTouchSchema.parse(params)

        const tabId = await getTargetTabId(p.tabId)

        // CDP Input.dispatchTouchEvent 在 Extension chrome.debugger 模式下挂起（同 mouseWheel）
        // 改用 chrome.scripting.executeScript 注入 TouchEvent 合成派发
        const frameIds = [p.frameId ?? 0]
        const results = await chrome.scripting.executeScript({
            target: { tabId, frameIds },
            world: 'MAIN',
            func: (
                type: string,
                touchPoints: Array<{
                    x: number
                    y: number
                    id?: number
                    radiusX?: number
                    radiusY?: number
                    force?: number
                    rotationAngle?: number
                }>
            ) => {
                const eventTypeMap: Record<string, string> = {
                    touchStart: 'touchstart',
                    touchEnd: 'touchend',
                    touchMove: 'touchmove',
                    touchCancel: 'touchcancel',
                }
                const eventType = eventTypeMap[type]
                if (!eventType) {
                    return { success: false, error: `Unknown touch event type: ${type}` }
                }

                const firstPoint = touchPoints[0]
                const target = firstPoint
                    ? (document.elementFromPoint(firstPoint.x, firstPoint.y) ?? document.documentElement)
                    : document.documentElement

                const touches = touchPoints.map(
                    (pt, i) =>
                        new Touch({
                            identifier: pt.id ?? i,
                            target,
                            clientX: pt.x,
                            clientY: pt.y,
                            screenX: pt.x,
                            screenY: pt.y,
                            radiusX: pt.radiusX ?? 0.5,
                            radiusY: pt.radiusY ?? 0.5,
                            rotationAngle: pt.rotationAngle ?? 0,
                            force: pt.force ?? 0.5,
                        })
                )

                // touchend/cancel 时 touches 和 targetTouches 应为空（该触点已结束），changedTouches 是结束的触点
                const isEnding = type === 'touchEnd' || type === 'touchCancel'
                const evt = new TouchEvent(eventType, {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    touches: isEnding ? [] : touches,
                    targetTouches: isEnding ? [] : touches,
                    changedTouches: touches,
                })
                target.dispatchEvent(evt)
                return { success: true }
            },
            args: [p.type, p.touchPoints],
        })

        const result = results[0]?.result as { success: boolean; error?: string } | undefined
        if (result && !result.success && result.error) {
            throw new Error(result.error)
        }
        return { success: true }
    }

    async inputType(params: unknown): Promise<{ success: boolean }> {
        const p = InputTypeSchema.parse(params)

        const tabId = await getTargetTabId(p.tabId)
        await this.debuggerManager.ensureAttached(tabId)

        const delay = p.delay ?? 0
        // 归一化换行：\r\n 和 \r 都视作单个 \n，避免 \r\n 触发两次 Enter
        const text = p.text.replace(/\r\n?/g, '\n')

        for (const char of text) {
            if (char === '\n') {
                // Enter: CDP 对 char='\n' 会丢弃，改为分发 Enter 键事件
                const enterParams = {
                    key: 'Enter',
                    code: 'Enter',
                    windowsVirtualKeyCode: 13,
                    nativeVirtualKeyCode: 13,
                }
                await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
                    type: 'keyDown',
                    ...enterParams,
                })
                await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
                    type: 'char',
                    text: '\r',
                    ...enterParams,
                })
                await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
                    type: 'keyUp',
                    ...enterParams,
                })
            } else {
                await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
                    type: 'char',
                    text: char,
                })
            }

            if (delay > 0) {
                await new Promise((r) => setTimeout(r, delay))
            }
        }

        return { success: true }
    }
}
