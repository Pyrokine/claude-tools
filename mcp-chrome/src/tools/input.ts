/**
 * input 工具
 *
 * 键鼠输入：键盘、鼠标及任意组合（事件序列）
 *
 * 设计原则：
 * - 事件序列模型：所有键鼠操作本质是事件序列
 * - 支持任意组合：Ctrl+Alt+A+左键+右键+拖拽
 * - humanize 可选：行为模拟是可选功能
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { generateBezierPath, getMouseMoveDelay, getTypingDelay, randomDelay } from '../anti-detection/index.js'
import { formatErrorResponse, formatResponse, getSession, getUnifiedSession } from '../core/index.js'
import type { InputEvent, Target } from '../core/types.js'
import { targetToFindParams, targetZodSchema } from './schema.js'

/**
 * InputEvent schema
 */
const inputEventSchema = z.object({
    type: z
        .enum([
            'keydown',
            'keyup',
            'click',
            'mousedown',
            'mouseup',
            'mousemove',
            'wheel',
            'touchstart',
            'touchmove',
            'touchend',
            'type',
            'wait',
            'select',
            'replace',
            'drag',
        ])
        .describe('事件类型'),
    key: z.string().optional().describe('按键（keydown/keyup）'),
    commands: z
        .array(z.string())
        .optional()
        .describe(
            '浏览器编辑命令（keydown 专用），如 ["selectAll"]、["copy"]、["paste"]、["cut"]、["undo"]、["redo"]，触发原生编辑命令，优先于纯键盘事件'
        )
        .describe('用于跨平台快捷键场景，需要 inputMode=precise'),
    button: z.enum(['left', 'middle', 'right', 'back', 'forward']).optional().describe('鼠标按钮'),
    clickCount: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('鼠标点击次数（click，默认 1，设为 2 触发双击事件，设为 3 触发三击事件）'),
    target: targetZodSchema
        .optional()
        .describe(
            '目标元素（mousemove/touchstart/touchmove 必填；click/mousedown/wheel/type/drag 可选；select/replace 可选；drag 时为拖拽源）'
        ),
    to: targetZodSchema.optional().describe('拖拽目标元素（drag 事件必填）'),
    steps: z.number().optional().describe('移动步数（mousemove/touchmove）'),
    deltaX: z.number().optional().describe('水平滚动量'),
    deltaY: z.number().optional().describe('垂直滚动量'),
    text: z.string().max(10000).optional().describe('输入文本（type，最大 10000 字符）或替换文本（replace）'),
    delay: z.number().min(0).max(100).optional().describe('按键间隔毫秒（type 事件最大 100ms，避免长时延 DoS）'),
    ms: z.number().optional().describe('等待毫秒'),
    find: z.string().optional().describe('要查找并选中的文本（select/replace）'),
    nth: z.number().optional().describe('第 N 个匹配（select/replace，从 0 开始，默认 0 即第一个）'),
    dispatch: z
        .boolean()
        .optional()
        .describe(
            '使用 dispatch 模式输入（type），直接设置 value 并触发 input/change 事件，兼容 React/Vue 等框架的受控组件，默认 false 使用键盘事件'
        ),
    force: z
        .boolean()
        .optional()
        .describe(
            '强制执行（click），跳过可操作性检查（可见性、遮挡检测等），直接在目标元素上触发事件，用于已知需要绕过检查的场景'
        ),
})

/**
 * input 参数 schema
 */
const inputSchema = z.object({
    events: z.array(inputEventSchema).describe('事件序列'),
    humanize: z.boolean().optional().describe('启用人类行为模拟（贝塞尔曲线移动、随机延迟）'),
    tabId: z
        .string()
        .optional()
        .describe(
            '目标 Tab ID（可选，仅 Extension 模式），不指定则使用当前 attach 的 tab，可操作非当前 attach 的 tab，CDP 模式下不支持此参数'
        ),
    timeout: z.number().optional().describe('超时毫秒'),
    frame: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
            'iframe 定位（可选，仅 Extension 模式），CSS 选择器（如 "iframe#main"）或索引（如 0），不指定则在主框架操作'
        ),
})

/**
 * input 工具处理器
 */
async function handleInput(args: z.infer<typeof inputSchema>): Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
}> {
    try {
        const unifiedSession = getUnifiedSession()
        const mode = unifiedSession.getMode()
        const humanize = args.humanize ?? false

        return await unifiedSession.withTabId(args.tabId, async () => {
            return await unifiedSession.withFrame(args.frame, async () => {
                // 根据连接模式选择执行方式
                const warnings: string[] = []
                if (mode === 'extension') {
                    // Extension 模式：使用 debugger API
                    for (const event of args.events) {
                        const w = await executeEventExtension(
                            unifiedSession,
                            event as InputEvent,
                            humanize,
                            args.timeout
                        )
                        if (w) {
                            warnings.push(w)
                        }
                    }
                } else {
                    // CDP 模式：逐事件分发（无 Extension bridge）
                    const session = getSession()
                    for (const event of args.events) {
                        if (event.type === 'select' || event.type === 'replace') {
                            // select/replace 通过 unifiedSession（内部自适应双模式）
                            const w = await executeEventExtension(
                                unifiedSession,
                                event as InputEvent,
                                humanize,
                                args.timeout
                            )
                            if (w) {
                                warnings.push(w)
                            }
                        } else {
                            await executeEvent(session, event as InputEvent, humanize, args.timeout)
                        }
                    }
                }

                const result: Record<string, unknown> = {
                    success: true,
                    eventsExecuted: args.events.length,
                    mode,
                }
                if (warnings.length > 0) {
                    result.warnings = warnings
                }
                return formatResponse(result)
            }) // withFrame
        }) // withTabId
    } catch (error) {
        return formatErrorResponse(error)
    }
}

/**
 * 文本坐标定位结果
 *
 * DOM 文本节点返回字符坐标（用于鼠标选择）；
 * input/textarea 返回 selectionRange 索引（用于 setSelectionRange）
 */
interface TextLocateResult {
    type: 'coords'
    startX: number
    startY: number
    endX: number
    endY: number
    /** 被替换文本是否被格式化标签包裹（如 <code>、<strong>） */
    formatted?: string
}

interface InputLocateResult {
    type: 'input'
    selectionStart: number
    selectionEnd: number
}

/**
 * 通过真实鼠标事件选中页面文本
 *
 * 两种策略：
 * - DOM 文本节点：TreeWalker + Range API 获取字符坐标 → Click + Shift+Click 模拟选区
 * - input/textarea：聚焦元素 → setSelectionRange() 直接设置选区
 *
 * @returns 格式化标签名（如 "code"），若被替换文本在格式化节点内
 */
/**
 * 如果 target 是选择器类型，先通过 actionableClick 聚焦
 * select/replace 事件用，保证选区建立前 activeElement 就是目标
 */
async function focusTargetForCommands(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    target: Target,
    timeout?: number
): Promise<void> {
    if ('x' in target || 'y' in target) {
        return
    }
    const params = targetToFindParams(target as Target & { nth?: number })
    const els = await unifiedSession.find(params.selector, params.text, params.xpath, timeout)
    const nth0 = params.nth ?? 0
    if (els.length <= nth0) {
        return
    }
    await unifiedSession.evaluate(
        `(() => {
            const ref = window.__mcpElementMap?.[${JSON.stringify(els[nth0].refId)}]
            const el = ref?.deref()
            if (!(el instanceof HTMLElement)) {
                throw new Error('命令聚焦目标不存在')
            }
            el.focus()
            return document.activeElement === el
        })()`,
        undefined,
        timeout
    )
}

async function focusTargetIfNeeded(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    target: Target | undefined,
    nth: number | undefined,
    timeout?: number
): Promise<void> {
    if (!target || 'x' in target || 'y' in target) {
        return
    }
    const params = targetToFindParams(target as Target & { nth?: number })
    const els = await unifiedSession.find(params.selector, params.text, params.xpath, timeout)
    const nth0 = params.nth ?? nth ?? 0
    if (els.length > nth0) {
        try {
            await unifiedSession.actionableClick(els[nth0].refId)
        } catch (err) {
            // 失败时不中断（可能是 contenteditable 不接受 click focus），但记录 warning
            console.warn('[MCP] focusTargetIfNeeded 聚焦失败，select/replace 将回退到 mouseClick 聚焦:', err)
        }
    }
}

async function selectText(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    findText: string,
    scopeTarget?: Target,
    nth = 0,
    timeout?: number
): Promise<string | undefined> {
    // 将 target 转为查询参数，传入注入脚本进行 DOM 查询
    let scopeSelector: string | null = null
    let scopeText: string | null = null
    let scopeXpath: string | null = null
    if (scopeTarget && !('x' in scopeTarget) && !('y' in scopeTarget)) {
        const params = targetToFindParams(scopeTarget as Target & { nth?: number })
        scopeSelector = params.selector ?? null
        scopeText = params.text ?? null
        scopeXpath = params.xpath ?? null
    }

    // Step 1: 注入脚本定位文本
    const result = await unifiedSession.evaluate<
        | TextLocateResult
        | InputLocateResult
        | { type: 'notfound' }
        | {
              type: 'noscope'
          }
        | null
    >(
        `function(findText, nth, scopeSelector, scopeText, scopeXpath) {
        // 确定搜索根节点
        var root = document.body;
        if (scopeXpath) {
            var xr = document.evaluate(scopeXpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            root = xr.singleNodeValue;
        } else if (scopeSelector) {
            var candidates = document.querySelectorAll(scopeSelector);
            if (scopeText) {
                for (var ci = 0; ci < candidates.length; ci++) {
                    if ((candidates[ci].textContent || '').includes(scopeText)) { root = candidates[ci]; break; }
                }
            } else {
                root = candidates[0];
            }
        } else if (scopeText) {
            var all = document.querySelectorAll('*');
            for (var ai = 0; ai < all.length; ai++) {
                if ((all[ai].textContent || '').includes(scopeText)) { root = all[ai]; break; }
            }
        }
        if (!root) return {type: 'noscope'};

        // input/textarea：value 不在 DOM 文本节点中
        var tag = root.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
            var val = root.value || '';
            var pos = -1;
            for (var n = 0; n <= nth; n++) {
                pos = val.indexOf(findText, pos + (n > 0 ? 1 : 0));
                if (pos === -1) return {type: 'notfound'};
            }
            // 原子化：定位到 input 同时完成 focus + setSelectionRange，避免外层 mouseClick 聚焦不可靠
            root.focus();
            if (typeof root.setSelectionRange === 'function') {
                root.setSelectionRange(pos, pos + findText.length);
            }
            return {type: 'input', selectionStart: pos, selectionEnd: pos + findText.length};
        }

        // 在子树中查找 input/textarea
        var inputs = root.querySelectorAll('input, textarea');
        for (var k = 0; k < inputs.length; k++) {
            var inp = inputs[k];
            var v = inp.value || '';
            var ip = -1;
            for (var n2 = 0; n2 <= nth; n2++) {
                ip = v.indexOf(findText, ip + (n2 > 0 ? 1 : 0));
                if (ip === -1) break;
            }
            if (ip !== -1) {
                inp.focus();
                if (typeof inp.setSelectionRange === 'function') {
                    inp.setSelectionRange(ip, ip + findText.length);
                }
                return {type: 'input', selectionStart: ip, selectionEnd: ip + findText.length};
            }
        }

        // DOM 文本节点：TreeWalker 遍历（限制规模防止大 DOM 阻塞）
        var MAX_TEXT_NODES = 10000;
        var MAX_TEXT_LENGTH = 500000;
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        var textNodes = [];
        var fullText = '';
        var node;
        while (node = walker.nextNode()) {
            if (textNodes.length >= MAX_TEXT_NODES || fullText.length >= MAX_TEXT_LENGTH) break;
            textNodes.push({node: node, start: fullText.length, length: node.textContent.length});
            fullText += node.textContent;
        }

        // 查找第 nth 个匹配
        var idx = -1;
        for (var m = 0; m <= nth; m++) {
            idx = fullText.indexOf(findText, idx + (m > 0 ? 1 : 0));
            if (idx === -1) return {type: 'notfound'};
        }

        function findNodeOffset(globalOffset) {
            for (var i = 0; i < textNodes.length; i++) {
                var tn = textNodes[i];
                if (globalOffset >= tn.start && globalOffset < tn.start + tn.length)
                    return {node: tn.node, offset: globalOffset - tn.start};
            }
            var last = textNodes[textNodes.length - 1];
            return {node: last.node, offset: last.length};
        }

        var range = document.createRange();
        var s = findNodeOffset(idx);
        range.setStart(s.node, s.offset);
        range.setEnd(s.node, Math.min(s.offset + 1, s.node.textContent.length));
        var sr = range.getBoundingClientRect();
        if (!sr.width && !sr.height) return {type: 'notfound'};

        var e = findNodeOffset(idx + findText.length - 1);
        range.setStart(e.node, e.offset);
        range.setEnd(e.node, Math.min(e.offset + 1, e.node.textContent.length));
        var er = range.getBoundingClientRect();
        if (!er.width && !er.height) return {type: 'notfound'};

        // 检测格式化标签（<code>、<strong>、<em> 等）
        var FORMAT_TAGS = {CODE:1, STRONG:1, EM:1, B:1, I:1, MARK:1, U:1, S:1, DEL:1, SUB:1, SUP:1};
        var formatted = '';
        var startNode = s.node.parentElement;
        var endNode = e.node.parentElement;
        if (startNode === endNode && startNode && FORMAT_TAGS[startNode.tagName]) {
            formatted = startNode.tagName.toLowerCase();
        }

        return {
            type: 'coords',
            startX: sr.x + 1,
            startY: sr.y + sr.height / 2,
            endX: er.x + er.width - 1,
            endY: er.y + er.height / 2,
            formatted: formatted || undefined
        };
    }`,
        undefined,
        timeout,
        [findText, nth, scopeSelector, scopeText, scopeXpath]
    )

    if (!result || result.type === 'noscope') {
        throw new Error(`未找到目标元素: ${JSON.stringify(scopeTarget)}`)
    }
    if (result.type === 'notfound') {
        throw new Error(
            scopeTarget
                ? `目标元素内未找到文本 "${findText}"${nth > 0 ? `（第 ${nth} 个匹配）` : ''}`
                : `未找到文本: "${findText}"${nth > 0 ? `（第 ${nth} 个匹配）` : ''}`
        )
    }

    if (result.type === 'input') {
        // 注入脚本已完成 focus + setSelectionRange（原子化，避免外层 mouseClick 聚焦不可靠）
        return undefined
    }

    // DOM 文本节点：鼠标选择
    const coords = result as TextLocateResult

    // iframe 坐标修正（precise 模式需要视口绝对坐标）
    const frameOffset = unifiedSession.getFrameOffset()
    if (frameOffset && unifiedSession.getInputMode() !== 'stealth') {
        coords.startX += frameOffset.x
        coords.startY += frameOffset.y
        coords.endX += frameOffset.x
        coords.endY += frameOffset.y
    }

    // Step 2: 模拟鼠标选择
    await unifiedSession.mouseMove(coords.startX, coords.startY)
    await unifiedSession.mouseClick('left')

    await unifiedSession.keyDown('Shift')
    await unifiedSession.mouseMove(coords.endX, coords.endY)
    await unifiedSession.mouseClick('left')
    await unifiedSession.keyUp('Shift')

    return coords.formatted
}

/**
 * 验证事件参数（两种执行模式共享），避免在 Extension/CDP 两个 switch 中重复校验
 */
function validateEvent(event: InputEvent): void {
    if (event.commands && event.commands.length > 0 && event.type !== 'keydown') {
        throw new Error(
            `commands 参数只能用于 keydown 事件，当前事件类型为 ${event.type}，如需触发编辑命令，请把 commands 放在 keydown 事件上`
        )
    }
    switch (event.type) {
        case 'keydown':
        case 'keyup':
            if (!event.key) {
                throw new Error(`${event.type} 事件需要 key 参数`)
            }
            break
        case 'wait':
            if (event.ms === undefined) {
                throw new Error('wait 事件需要 ms 参数')
            }
            break
    }
}

/**
 * Extension 模式：执行单个事件
 *
 * @returns 可选警告信息（如格式丢失提示）
 */
async function executeEventExtension(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    event: InputEvent,
    humanize: boolean,
    timeout?: number
): Promise<string | undefined> {
    validateEvent(event)
    switch (event.type) {
        case 'keydown': {
            if (unifiedSession.getInputMode() === 'stealth' && event.commands && event.commands.length > 0) {
                throw new Error(
                    'commands 参数不支持 stealth 输入模式，请先调用 manage action=inputMode inputMode=precise 切换后重试'
                )
            }
            if (event.commands && event.commands.length > 0 && event.target) {
                await focusTargetForCommands(unifiedSession, event.target, timeout)
            }
            await unifiedSession.keyDown(event.key!, event.commands)
            break
        }

        case 'keyup': {
            await unifiedSession.keyUp(event.key!)
            break
        }

        case 'click': {
            const button = event.button ?? 'left'
            const clickCount = event.clickCount ?? 1
            if (event.target) {
                // 坐标型 target：不过 actionableClick，但仍需 getTargetPointExtension 做 iframe offset 修正
                if ('x' in event.target && 'y' in event.target) {
                    const point = await getTargetPointExtension(unifiedSession, event.target, timeout)
                    await unifiedSession.mouseMove(point.x, point.y)
                    await unifiedSession.mouseClick(button, clickCount)
                    break
                }
                // 左键单击：优先用 actionable click（带可操作性检查、自动滚动、遮挡检测）
                // 非左键 / 多击：actionableClick 依赖 HTMLElement.click() 只能触发单次左键，必须走坐标路径
                if (button === 'left' && clickCount === 1) {
                    const {
                        selector,
                        text: searchText,
                        xpath,
                        nth: nthParam,
                    } = targetToFindParams(event.target as Target & { nth?: number })
                    const elements = await unifiedSession.find(selector, searchText, xpath, timeout)
                    const nth = nthParam ?? 0
                    if (elements.length > 0 && nth < elements.length) {
                        const refId = elements[nth].refId
                        const result = await unifiedSession.actionableClick(refId, event.force)
                        if (!result.success) {
                            throw new Error(result.error || 'Click failed')
                        }
                        break
                    }
                }
                // fallback: 找不到 refId 或需走坐标路径时
                // refId 透传：stealth 模式下嵌套 iframe overlay 场景绕过 elementFromPoint
                const point = await getTargetPointExtension(unifiedSession, event.target, timeout)
                await unifiedSession.mouseMove(point.x, point.y)
                await unifiedSession.mouseClick(
                    button,
                    clickCount,
                    typeof point.refId === 'string' ? point.refId : undefined
                )
                break
            }
            await unifiedSession.mouseClick(button, clickCount)
            break
        }

        case 'mousedown': {
            if (event.target) {
                const point = await getTargetPointExtension(unifiedSession, event.target, timeout)
                await unifiedSession.mouseMove(point.x, point.y)
            }
            await unifiedSession.mouseDown(event.button ?? 'left')
            break
        }

        case 'mouseup': {
            await unifiedSession.mouseUp(event.button ?? 'left')
            break
        }

        case 'mousemove': {
            if (!event.target) {
                throw new Error('mousemove 事件需要 target 参数')
            }
            const point = await getTargetPointExtension(unifiedSession, event.target, timeout)

            if (humanize && event.steps && event.steps > 1) {
                const path = generateBezierPath(unifiedSession.getMousePosition(), point, event.steps)
                for (const p of path) {
                    await unifiedSession.mouseMove(p.x, p.y)
                    await randomDelay(getMouseMoveDelay(), getMouseMoveDelay() * 2)
                }
            } else {
                await unifiedSession.mouseMove(point.x, point.y)
            }
            break
        }

        case 'wheel': {
            if (event.target) {
                const {
                    selector,
                    text,
                    xpath,
                    nth: nthParam,
                } = targetToFindParams(event.target as Target & { nth?: number })
                const elements = await unifiedSession.find(selector, text, xpath, timeout)
                const nth = nthParam ?? 0
                if (elements.length > nth) {
                    // 用 refId 直接滚动目标元素（支持视口外元素）
                    await unifiedSession.scroll(event.deltaX ?? 0, event.deltaY ?? 0, elements[nth].refId)
                    break
                }
                // 找不到元素时 fallback 到坐标方式
                const point = await getTargetPointExtension(unifiedSession, event.target, timeout)
                await unifiedSession.mouseMove(point.x, point.y)
            }
            await unifiedSession.mouseWheel(event.deltaX ?? 0, event.deltaY ?? 0)
            break
        }

        case 'touchstart': {
            if (!event.target) {
                throw new Error('touchstart 事件需要 target 参数')
            }
            const point = await getTargetPointExtension(unifiedSession, event.target, timeout)
            await unifiedSession.touchStart(point.x, point.y)
            break
        }

        case 'touchmove': {
            if (!event.target) {
                throw new Error('touchmove 事件需要 target 参数')
            }
            const point = await getTargetPointExtension(unifiedSession, event.target, timeout)
            await unifiedSession.touchMove(point.x, point.y)
            break
        }

        case 'touchend': {
            await unifiedSession.touchEnd()
            break
        }

        case 'type': {
            if (!event.text) {
                throw new Error('type 事件需要 text 参数')
            }

            // dispatch 模式：直接设置 value + 触发事件（兼容 React/Vue 受控组件）
            if (event.dispatch) {
                // 定位目标元素
                if (!event.target) {
                    throw new Error('dispatch 模式需要 target 参数定位输入元素')
                }
                if ('x' in event.target && 'y' in event.target) {
                    throw new Error('dispatch 模式不支持坐标型 target，请使用 CSS 选择器、role 或文本定位')
                }
                const {
                    selector,
                    text: searchText,
                    xpath,
                    nth: nthParam,
                } = targetToFindParams(event.target as Target & { nth?: number })
                const elements = await unifiedSession.find(selector, searchText, xpath, timeout)
                const nth = nthParam ?? 0
                if (elements.length === 0 || nth >= elements.length) {
                    throw new Error('目标元素未找到')
                }
                const refId = elements[nth].refId

                // 通过 Extension ISOLATED 世界执行 dispatch（访问 __mcpElementMap）
                // 参考 Playwright fill()：nativeInputValueSetter + dispatchEvent
                const result = await unifiedSession.dispatchInput(refId, event.text)
                if (!result.success) {
                    throw new Error(result.error || 'dispatch 输入失败')
                }
                break
            }

            // 默认模式：键盘事件
            // 如果有 target，先点击目标（聚焦）
            if (event.target) {
                const point = await getTargetPointExtension(unifiedSession, event.target, timeout)
                await unifiedSession.mouseMove(point.x, point.y)
                await unifiedSession.mouseClick('left')
            } else {
                const hasActiveFocus = await unifiedSession.evaluate<boolean>(
                    '!!document.activeElement && ' +
                        'document.activeElement !== document.body && ' +
                        'document.activeElement !== document.documentElement'
                )
                if (!hasActiveFocus) {
                    throw new Error('type 事件在无 target 时需要页面已有焦点元素，请提供 target 或先 click 目标元素')
                }
            }

            const delay = event.delay ?? 0
            if (humanize) {
                for (const char of event.text) {
                    await unifiedSession.typeText(char)
                    await randomDelay(getTypingDelay(delay), getTypingDelay(delay) * 1.5)
                }
            } else {
                await unifiedSession.typeText(event.text, delay)
            }
            break
        }

        case 'wait': {
            await new Promise((resolve) => setTimeout(resolve, event.ms!))
            break
        }

        case 'select': {
            if (!event.find) {
                throw new Error('select 事件需要 find 参数')
            }
            // 自动聚焦目标元素（selectText 内 mouseClick focus 对 React 等场景不可靠）
            await focusTargetIfNeeded(unifiedSession, event.target, event.nth, timeout)
            await selectText(unifiedSession, event.find, event.target, event.nth, timeout)
            break
        }

        case 'replace': {
            if (!event.find) {
                throw new Error('replace 事件需要 find 参数')
            }
            if (event.text === undefined) {
                throw new Error('replace 事件需要 text 参数')
            }
            // 自动聚焦目标元素
            await focusTargetIfNeeded(unifiedSession, event.target, event.nth, timeout)
            // Step 1: 选中文本
            const formatted = await selectText(unifiedSession, event.find, event.target, event.nth, timeout)
            // 轮询等待选区同步（最多 500ms）
            let selectionConfirmed = false
            for (let i = 0; i < 25; i++) {
                const hasSelection = await unifiedSession.evaluate<boolean>(
                    `(function() {
                        var el = document.activeElement;
                        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
                            return el.selectionStart !== el.selectionEnd;
                        }
                        var sel = window.getSelection();
                        return sel && !sel.isCollapsed;
                    })()`
                )
                if (hasSelection) {
                    selectionConfirmed = true
                    break
                }
                await new Promise((resolve) => setTimeout(resolve, 20))
            }
            if (!selectionConfirmed) {
                throw new Error(`选区同步失败：文本 "${event.find}" 已定位但未能建立选区，无法执行替换`)
            }

            // Step 2: 检测可编辑性并替换
            const replaceResult = await unifiedSession.evaluate<'ok' | 'readonly' | 'fallback'>(
                `function(replacementText) {
                var el = document.activeElement;
                // input/textarea：使用 setRangeText 直接替换选区
                if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.setRangeText) {
                    if (el.readOnly || el.disabled) return 'readonly';
                    el.setRangeText(replacementText, el.selectionStart, el.selectionEnd, 'end');
                    el.dispatchEvent(new Event('input', {bubbles: true}));
                    return 'ok';
                }
                // 检测 contenteditable
                var sel = window.getSelection();
                if (!sel || sel.isCollapsed) return 'readonly';
                var anchor = sel.anchorNode;
                var editable = anchor instanceof Element ? anchor : anchor && anchor.parentElement;
                while (editable && !editable.isContentEditable && editable !== document.body) {
                    editable = editable.parentElement;
                }
                if (!editable || !editable.isContentEditable) return 'readonly';
                // contenteditable：execCommand 让浏览器自行产出事件序列
                if (document.execCommand('insertText', false, replacementText)) return 'ok';
                return 'fallback';
            }`,
                undefined,
                timeout,
                [event.text]
            )
            if (replaceResult === 'readonly') {
                throw new Error(`目标元素不可编辑，已选中文本 "${event.find}" 但无法替换`)
            }
            if (replaceResult === 'fallback') {
                // Fallback: 键盘输入覆盖选区
                await unifiedSession.typeText(event.text)
            }
            if (formatted) {
                return `替换的文本原在 <${formatted}> 标签内，替换后格式可能丢失`
            }
            break
        }

        case 'drag': {
            if (!event.target) {
                throw new Error('drag 事件需要 target 参数（拖拽源）')
            }
            if (!event.to) {
                throw new Error('drag 事件需要 to 参数（拖拽目标）')
            }
            // drag 仅支持选择器类 target（CSS/text/xpath/ARIA 等），不支持坐标
            // 理由：drag 依赖 refId 在 Extension ISOLATED 世界 dispatchEvent，坐标无法生成 refId
            if ('x' in event.target || 'y' in event.target) {
                throw new Error('drag 的 target 不支持坐标类型，请使用选择器（css/text/xpath/role 等）')
            }
            if ('x' in event.to || 'y' in event.to) {
                throw new Error('drag 的 to 不支持坐标类型，请使用选择器（css/text/xpath/role 等）')
            }
            // 用 find 定位确认元素存在（支持 ARIA/testId 等高级定位），拿 refId 传入 extension 侧 dispatchEvent
            const srcParams = targetToFindParams(event.target as Target & { nth?: number })
            const dstParams = targetToFindParams(event.to as Target & { nth?: number })
            const srcNth = srcParams.nth ?? 0
            const dstNth = dstParams.nth ?? 0

            // 执行 drag，失败时重试一次（React 重渲染可能导致 refId 失效）
            const attemptDrag = async (): Promise<{ success: boolean; error?: string; code?: string }> => {
                const srcEls = await unifiedSession.find(srcParams.selector, srcParams.text, srcParams.xpath, timeout)
                const dstEls = await unifiedSession.find(dstParams.selector, dstParams.text, dstParams.xpath, timeout)
                if (srcEls.length <= srcNth) {
                    throw new Error(`drag 源元素未找到: ${JSON.stringify(event.target)}`)
                }
                if (dstEls.length <= dstNth) {
                    throw new Error(`drag 目标元素未找到: ${JSON.stringify(event.to)}`)
                }
                return unifiedSession.dragAndDrop(srcEls[srcNth].refId, dstEls[dstNth].refId)
            }

            let dragResult = await attemptDrag()
            let retried = false
            // 仅对 refId 失效（REF_STALE）重试：源/目标元素从 DOM 移除，典型是 React 重渲染
            if (!dragResult.success && dragResult.code === 'REF_STALE') {
                console.warn('[MCP] drag refId 失效，自动重试一次:', dragResult.error)
                dragResult = await attemptDrag()
                retried = true
            }
            if (!dragResult.success) {
                throw new Error(dragResult.error || 'drag 执行失败')
            }
            if (retried) {
                return 'drag 因 refId 失效已自动重试一次（可能是 React 等框架重渲染导致）'
            }
            break
        }

        default:
            throw new Error(`未知事件类型: ${(event as { type: string }).type}`)
    }
}

/**
 * Extension 模式：获取目标点坐标
 *
 * iframe 坐标系修正：
 * - 原始坐标 {x, y}：用户意图为 iframe 相对坐标
 *   - precise 模式需加 offset 转为视口绝对坐标（CDP 用绝对坐标）
 *   - stealth 模式直接使用（在 iframe 内派发，本身就是相对坐标）
 * - 元素定位：find() 返回视口绝对坐标
 *   - precise 模式直接使用
 *   - stealth 模式需减 offset 转为 iframe 相对坐标
 */
async function getTargetPointExtension(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    target: Target,
    timeout?: number
): Promise<{ x: number; y: number; refId?: string }> {
    const frameOffset = unifiedSession.getFrameOffset()
    const isStealth = unifiedSession.getInputMode() === 'stealth'

    // 原始坐标：用户意图为 iframe 相对坐标
    if ('x' in target && 'y' in target) {
        if (frameOffset && !isStealth) {
            // precise: 转为视口绝对坐标
            return { x: target.x + frameOffset.x, y: target.y + frameOffset.y }
        }
        return { x: target.x, y: target.y }
    }

    const { selector, text, xpath, nth: nthParam } = targetToFindParams(target as Target & { nth?: number })
    const elements = await unifiedSession.find(selector, text, xpath, timeout)
    if (elements.length === 0) {
        throw new Error(`未找到目标元素: ${JSON.stringify(target)}`)
    }

    const nth = nthParam ?? 0
    if (nth >= elements.length) {
        throw new Error(`第 ${nth} 个匹配元素不存在（共 ${elements.length} 个）`)
    }

    // 视口外时滚动后重新取 rect：与 actionableClick (left+single) 行为对齐，
    // 否则非左键 / 多击的坐标路径在视口外坐标 dispatch，浏览器找不到元素，事件丢失
    const refId = elements[nth].refId
    const iframeRelRect = await unifiedSession.evaluate<{
        x: number
        y: number
        width: number
        height: number
    } | null>(
        `(() => {
            const ref = window.__mcpElementMap?.[${JSON.stringify(refId)}];
            const el = ref?.deref();
            if (!el) return null;
            const r = el.getBoundingClientRect();
            if (r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth) {
                el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            }
            const r2 = el.getBoundingClientRect();
            return { x: r2.x, y: r2.y, width: r2.width, height: r2.height };
        })()`
    )

    // refId 失效等异常：fallback 到原始 find rect（父视口绝对）
    if (!iframeRelRect) {
        const rect = elements[nth].rect
        const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
        if (frameOffset && isStealth) {
            return { x: point.x - frameOffset.x, y: point.y - frameOffset.y, refId }
        }
        return { ...point, refId }
    }

    // 主 frame：iframeRelRect 就是父视口绝对
    if (!frameOffset) {
        return {
            x: iframeRelRect.x + iframeRelRect.width / 2,
            y: iframeRelRect.y + iframeRelRect.height / 2,
            refId,
        }
    }

    // iframe + stealth：消费者（chrome.scripting in iframe）需要 iframe 相对
    if (isStealth) {
        return {
            x: iframeRelRect.x + iframeRelRect.width / 2,
            y: iframeRelRect.y + iframeRelRect.height / 2,
            refId,
        }
    }

    // iframe + precise：消费者（chrome.debugger）需要父视口绝对。
    // scrollIntoView({block:'center'}) 会 cascade 到父框架，导致 frameOffset 与父绝对 rect 都过期，
    // refetch find() 让 content-handler 重新计算 frameOffset 并返回最新父绝对 rect
    const refreshed = await unifiedSession.find(selector, text, xpath, timeout)
    const rect = refreshed[nth]?.rect ?? elements[nth].rect
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, refId }
}

/**
 * CDP 模式：执行单个事件
 */
async function executeEvent(
    session: ReturnType<typeof getSession>,
    event: InputEvent,
    humanize: boolean,
    timeout?: number
): Promise<void> {
    validateEvent(event)
    switch (event.type) {
        case 'keydown': {
            await session.keyDown(event.key!, event.commands)
            break
        }

        case 'keyup': {
            await session.keyUp(event.key!)
            break
        }

        case 'click': {
            if (event.target) {
                await moveToTarget(session, event.target, humanize, timeout)
            }
            const cdpButton = event.button ?? 'left'
            const cdpClickCount = event.clickCount ?? 1
            for (let i = 1; i <= cdpClickCount; i++) {
                await session.mouseDown(cdpButton, i)
                await session.mouseUp(cdpButton, i)
            }
            break
        }

        case 'mousedown': {
            // 如果有 target，先移动到目标位置
            if (event.target) {
                await moveToTarget(session, event.target, humanize, timeout)
            }
            await session.mouseDown(event.button ?? 'left')
            break
        }

        case 'mouseup': {
            await session.mouseUp(event.button ?? 'left')
            break
        }

        case 'mousemove': {
            if (!event.target) {
                throw new Error('mousemove 事件需要 target 参数')
            }
            await moveToTarget(session, event.target, humanize, timeout, event.steps)
            break
        }

        case 'wheel': {
            // 如果有 target，先移动到目标位置
            if (event.target) {
                await moveToTarget(session, event.target, humanize, timeout)
            }
            await session.mouseWheel(event.deltaX ?? 0, event.deltaY ?? 0)
            break
        }

        case 'touchstart': {
            if (!event.target) {
                throw new Error('touchstart 事件需要 target 参数')
            }
            const point = await getTargetPoint(session, event.target, timeout)
            await session.touchStart(point.x, point.y)
            break
        }

        case 'touchmove': {
            if (!event.target) {
                throw new Error('touchmove 事件需要 target 参数')
            }
            const point = await getTargetPoint(session, event.target, timeout)

            if (humanize && event.steps && event.steps > 1) {
                // 人类化触屏移动
                const current = session.getBehaviorSimulator().getCurrentPosition()
                const path = generateBezierPath(current, point, event.steps)
                for (const p of path) {
                    await session.touchMove(p.x, p.y)
                    await randomDelay(5, 15)
                }
            } else {
                await session.touchMove(point.x, point.y)
            }
            break
        }

        case 'touchend': {
            await session.touchEnd()
            break
        }

        case 'type': {
            if (!event.text) {
                throw new Error('type 事件需要 text 参数')
            }
            if (event.dispatch) {
                throw new Error('dispatch 模式需要 Extension 连接，当前为 CDP 模式')
            }
            // 如果有 target，先点击目标（聚焦），使用 input 等待类型
            if (event.target) {
                await moveToTarget(session, event.target, humanize, timeout, undefined, 'input')
                await session.mouseDown('left')
                await session.mouseUp('left')
            } else {
                const hasActiveFocus = await session.evaluate<boolean>(
                    '!!document.activeElement && ' +
                        'document.activeElement !== document.body && ' +
                        'document.activeElement !== document.documentElement'
                )
                if (!hasActiveFocus) {
                    throw new Error('type 事件在无 target 时需要页面已有焦点元素，请提供 target 或先 click 目标元素')
                }
            }

            const delay = event.delay ?? 0
            if (humanize) {
                // 人类化打字
                for (const char of event.text) {
                    await session.type(char)
                    await randomDelay(getTypingDelay(delay), getTypingDelay(delay) * 1.5)
                }
            } else {
                await session.type(event.text, delay)
            }
            break
        }

        case 'wait': {
            await new Promise((resolve) => setTimeout(resolve, event.ms!))
            break
        }

        default:
            // drag 仅在 Extension 模式可用，给出明确错误而非通用"未知事件类型"
            if ((event as { type: string }).type === 'drag') {
                throw new Error('drag 事件仅在 Extension 模式下可用，当前为 CDP 模式')
            }
            throw new Error(`未知事件类型: ${(event as { type: string }).type}`)
    }
}

/**
 * 移动到目标位置
 */
async function moveToTarget(
    session: ReturnType<typeof getSession>,
    target: Target,
    humanize: boolean,
    timeout?: number,
    steps?: number,
    waitType: 'click' | 'input' | 'none' = 'click'
): Promise<void> {
    const point = await getTargetPoint(session, target, timeout, waitType)
    const simulator = session.getBehaviorSimulator()

    if (humanize) {
        // 人类化鼠标移动（贝塞尔曲线）
        const path = generateBezierPath(simulator.getCurrentPosition(), point, steps)
        for (const p of path) {
            await session.mouseMove(p.x, p.y)
            await randomDelay(getMouseMoveDelay(), getMouseMoveDelay() * 2)
        }
    } else if (steps && steps > 1) {
        // 直线移动，分步
        const current = simulator.getCurrentPosition()
        for (let i = 1; i <= steps; i++) {
            const t = i / steps
            const x = current.x + (point.x - current.x) * t
            const y = current.y + (point.y - current.y) * t
            await session.mouseMove(x, y)
        }
    } else {
        // 直接移动
        await session.mouseMove(point.x, point.y)
    }
}

/**
 * 获取目标点坐标（带自动等待）
 */
async function getTargetPoint(
    session: ReturnType<typeof getSession>,
    target: Target,
    timeout?: number,
    waitType: 'click' | 'input' | 'none' = 'click'
): Promise<{ x: number; y: number }> {
    // 如果是坐标，直接返回
    if ('x' in target && 'y' in target) {
        return { x: target.x, y: target.y }
    }

    // 使用 Locator 定位元素
    const locator = session.createLocator(target, { timeout })
    const nodeId = await locator.find()

    // 根据操作类型执行自动等待
    if (waitType !== 'none') {
        const autoWait = session.createAutoWait({ timeout })
        if (waitType === 'click') {
            await autoWait.waitForClickable(nodeId)
        } else if (waitType === 'input') {
            await autoWait.waitForInputReady(nodeId)
        }
    }

    return locator.getClickablePoint()
}

/**
 * 注册 input 工具
 */
export function registerInputTool(server: McpServer): void {
    server.registerTool(
        'input',
        {
            description: `键鼠输入：键盘、鼠标及任意组合

推荐操作顺序：
1. 先用 extract type=state 或 type=html 了解页面结构
2. 用 CSS 选择器 + nth 精确定位元素（避免坐标点击）
3. 再 input click/type 操作目标元素

组合键拆分为独立事件示例（修饰键 + 字母键）：
  events: [
    {type: "keydown", key: "Control"},
    {type: "keydown", key: "a"},
    {type: "keyup", key: "a"},
    {type: "keyup", key: "Control"}
  ]

浏览器编辑命令（selectAll/copy/paste/cut/undo/redo 等）需用 commands 字段，跨平台可靠：
  events: [
    {type: "keydown", key: "a", commands: ["selectAll"]},
    {type: "keyup", key: "a"}
  ]
注意：纯键盘事件（不带 commands）仅保证 JS keyboard event 可被监听，不保证触发浏览器原生编辑行为；
      全选/复制/粘贴等语义用 commands；"全选并替换文本"用 select/replace 事件更简洁；
      commands 仅支持 inputMode=precise，stealth 模式下会报错`,
            inputSchema: inputSchema,
        },
        (args) => handleInput(args)
    )
}
