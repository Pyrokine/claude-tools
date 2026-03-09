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

import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {z} from 'zod'
import {generateBezierPath, getMouseMoveDelay, getTypingDelay, randomDelay} from '../anti-detection/index.js'
import {formatErrorResponse, formatResponse, getSession, getUnifiedSession} from '../core/index.js'
import type {InputEvent, Target} from '../core/types.js'
import {targetToFindParams, targetZodSchema} from './schema.js'

/**
 * InputEvent schema
 */
const inputEventSchema = z.object({
                                      type: z.enum([
                                                       'keydown', 'keyup', 'click', 'mousedown', 'mouseup', 'mousemove',
                                                       'wheel', 'touchstart', 'touchmove', 'touchend', 'type', 'wait',
                                                       'select', 'replace',
                                                   ]).describe('事件类型'),
                                      key: z.string().optional().describe('按键（keydown/keyup）'),
                                      button: z.enum(['left', 'middle', 'right', 'back', 'forward'])
                                               .optional()
                                               .describe('鼠标按钮'),
                                      target: targetZodSchema.optional().describe(
                                          '目标元素（mousemove/touchstart/touchmove 必填；click/mousedown/wheel/type 可选，用于先定位再操作；select/replace 可选，用于限定搜索范围）'),
                                      steps: z.number().optional().describe('移动步数（mousemove/touchmove）'),
                                      deltaX: z.number().optional().describe('水平滚动量'),
                                      deltaY: z.number().optional().describe('垂直滚动量'),
                                      text: z.string().optional().describe('输入文本（type）或替换文本（replace）'),
                                      delay: z.number().optional().describe('按键间隔毫秒'),
                                      ms: z.number().optional().describe('等待毫秒'),
                                      find: z.string().optional().describe('要查找并选中的文本（select/replace）'),
                                      nth: z.number().optional().describe(
                                          '第 N 个匹配（select/replace，从 0 开始，默认 0 即第一个）'),
                                  })

/**
 * input 参数 schema
 */
const inputSchema = z.object({
                                 events: z.array(inputEventSchema).describe('事件序列'),
                                 humanize: z.boolean().optional().describe('启用人类行为模拟（贝塞尔曲线移动、随机延迟）'),
                                 tabId: z.string().optional().describe(
                                     '目标 Tab ID（可选，仅 Extension 模式）。不指定则使用当前 attach 的 tab。可操作非当前 attach 的 tab。CDP 模式下不支持此参数'),
                                 timeout: z.number().optional().describe('超时毫秒'),
                                 frame: z.union([z.string(), z.number()]).optional().describe(
                                     'iframe 定位（可选，仅 Extension 模式）。CSS 选择器（如 "iframe#main"）或索引（如 0）。不指定则在主框架操作'),
                             })

/**
 * input 工具处理器
 */
async function handleInput(args: z.infer<typeof inputSchema>): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}> {
    try {
        const unifiedSession = getUnifiedSession()
        const mode           = unifiedSession.getMode()
        const humanize       = args.humanize ?? false

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
                            args.timeout,
                        )
                        if (w) {
                            warnings.push(w)
                        }
                    }
                } else {
                    // CDP 模式：使用原有逻辑
                    const session = getSession()
                    for (const event of args.events) {
                        if (event.type === 'select' || event.type === 'replace') {
                            // select/replace 通过 unifiedSession（内部自适应双模式）
                            const w = await executeEventExtension(
                                unifiedSession,
                                event as InputEvent,
                                humanize,
                                args.timeout,
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
    startX: number;
    startY: number;
    endX: number;
    endY: number
    /** 被替换文本是否被格式化标签包裹（如 <code>、<strong>） */
    formatted?: string
}

interface InputLocateResult {
    type: 'input'
    selectionStart: number;
    selectionEnd: number
    focusX?: number;
    focusY?: number
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
async function selectText(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    findText: string,
    scopeTarget?: Target,
    nth = 0,
    timeout?: number,
): Promise<string | undefined> {
    // 将 target 转为查询参数，传入注入脚本进行 DOM 查询
    let scopeSelector: string | null = null
    let scopeText: string | null     = null
    let scopeXpath: string | null    = null
    if (scopeTarget && !('x' in scopeTarget) && !('y' in scopeTarget)) {
        const params  = targetToFindParams(scopeTarget as Target & { nth?: number })
        scopeSelector = params.selector ?? null
        scopeText     = params.text ?? null
        scopeXpath    = params.xpath ?? null
    }

    // Step 1: 注入脚本定位文本
    const result = await unifiedSession.evaluate<TextLocateResult | InputLocateResult | { type: 'notfound' } | {
        type: 'noscope'
    } | null>(
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
                var r = inp.getBoundingClientRect();
                return {type: 'input', selectionStart: ip, selectionEnd: ip + findText.length,
                    focusX: r.x + r.width / 2, focusY: r.y + r.height / 2};
            }
        }

        // DOM 文本节点：TreeWalker 遍历
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        var textNodes = [];
        var fullText = '';
        var node;
        while (node = walker.nextNode()) {
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
    }`, undefined, timeout, [findText, nth, scopeSelector, scopeText, scopeXpath])

    if (!result || result.type === 'noscope') {
        throw new Error(`未找到目标元素: ${JSON.stringify(scopeTarget)}`)
    }
    if (result.type === 'notfound') {
        throw new Error(scopeTarget
                        ? `目标元素内未找到文本 "${findText}"${nth > 0 ? `（第 ${nth} 个匹配）` : ''}`
                        : `未找到文本: "${findText}"${nth > 0 ? `（第 ${nth} 个匹配）` : ''}`)
    }

    if (result.type === 'input') {
        // input/textarea：聚焦 + setSelectionRange
        const r = result as InputLocateResult
        if (r.focusX !== undefined && r.focusY !== undefined) {
            let x = r.focusX
            let y = r.focusY
            const frameOffset = unifiedSession.getFrameOffset()
            if (frameOffset && unifiedSession.getInputMode() !== 'stealth') {
                x += frameOffset.x
                y += frameOffset.y
            }
            await unifiedSession.mouseMove(x, y)
            await unifiedSession.mouseClick('left')
        } else if (scopeTarget) {
            const point = await getTargetPointExtension(unifiedSession, scopeTarget, timeout)
            await unifiedSession.mouseMove(point.x, point.y)
            await unifiedSession.mouseClick('left')
        }
        await unifiedSession.evaluate<void>(`function(start, end) {
            var el = document.activeElement;
            if (el && el.setSelectionRange) el.setSelectionRange(start, end);
        }`, undefined, timeout, [result.selectionStart, result.selectionEnd])
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
 * Extension 模式：执行单个事件
 *
 * @returns 可选警告信息（如格式丢失提示）
 */
async function executeEventExtension(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    event: InputEvent,
    humanize: boolean,
    timeout?: number,
): Promise<string | undefined> {
    switch (event.type) {
        case 'keydown': {
            if (!event.key) {
                throw new Error('keydown 事件需要 key 参数')
            }
            await unifiedSession.keyDown(event.key)
            break
        }

        case 'keyup': {
            if (!event.key) {
                throw new Error('keyup 事件需要 key 参数')
            }
            await unifiedSession.keyUp(event.key)
            break
        }

        case 'click': {
            if (event.target) {
                const point = await getTargetPointExtension(unifiedSession, event.target, timeout)
                await unifiedSession.mouseMove(point.x, point.y)
            }
            await unifiedSession.mouseClick(event.button ?? 'left')
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

            // 如果有 target，先点击目标（聚焦）
            if (event.target) {
                const point = await getTargetPointExtension(unifiedSession, event.target, timeout)
                await unifiedSession.mouseMove(point.x, point.y)
                await unifiedSession.mouseClick('left')
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
            if (!event.ms) {
                throw new Error('wait 事件需要 ms 参数')
            }
            await new Promise(resolve => setTimeout(resolve, event.ms))
            break
        }

        case 'select': {
            if (!event.find) {
                throw new Error('select 事件需要 find 参数')
            }
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
            // Step 1: 选中文本
            const formatted = await selectText(unifiedSession, event.find, event.target, event.nth, timeout)
            // 等待编辑器同步选区状态
            await new Promise(resolve => setTimeout(resolve, 50))

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
            }`, undefined, timeout, [event.text])
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
    timeout?: number,
): Promise<{ x: number; y: number }> {
    const frameOffset = unifiedSession.getFrameOffset()
    const isStealth   = unifiedSession.getInputMode() === 'stealth'

    // 原始坐标：用户意图为 iframe 相对坐标
    if ('x' in target && 'y' in target) {
        if (frameOffset && !isStealth) {
            // precise: 转为视口绝对坐标
            return {x: target.x + frameOffset.x, y: target.y + frameOffset.y}
        }
        return {x: target.x, y: target.y}
    }

    const {selector, text, xpath, nth: nthParam} = targetToFindParams(target as Target & { nth?: number })
    const elements                               = await unifiedSession.find(selector, text, xpath, timeout)
    if (elements.length === 0) {
        throw new Error(`未找到目标元素: ${JSON.stringify(target)}`)
    }

    const nth = nthParam ?? 0
    if (nth >= elements.length) {
        throw new Error(`第 ${nth} 个匹配元素不存在（共 ${elements.length} 个）`)
    }
    const rect  = elements[nth].rect
    const point = {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
    }

    // 元素定位：find() 返回视口绝对坐标
    if (frameOffset && isStealth) {
        // stealth: 转回 iframe 相对坐标
        return {x: point.x - frameOffset.x, y: point.y - frameOffset.y}
    }
    return point
}

/**
 * CDP 模式：执行单个事件
 */
async function executeEvent(
    session: ReturnType<typeof getSession>,
    event: InputEvent,
    humanize: boolean,
    timeout?: number,
): Promise<void> {
    switch (event.type) {
        case 'keydown': {
            if (!event.key) {
                throw new Error('keydown 事件需要 key 参数')
            }
            await session.keyDown(event.key)
            break
        }

        case 'keyup': {
            if (!event.key) {
                throw new Error('keyup 事件需要 key 参数')
            }
            await session.keyUp(event.key)
            break
        }

        case 'click': {
            if (event.target) {
                await moveToTarget(session, event.target, humanize, timeout)
            }
            await session.mouseDown(event.button ?? 'left')
            await session.mouseUp(event.button ?? 'left')
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
                const path    = generateBezierPath(current, point, event.steps)
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
            // 如果有 target，先点击目标（聚焦），使用 input 等待类型
            if (event.target) {
                await moveToTarget(session, event.target, humanize, timeout, undefined, 'input')
                await session.mouseDown('left')
                await session.mouseUp('left')
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
            if (!event.ms) {
                throw new Error('wait 事件需要 ms 参数')
            }
            await new Promise((resolve) => setTimeout(resolve, event.ms))
            break
        }

        default:
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
    waitType: 'click' | 'input' | 'none' = 'click',
): Promise<void> {
    const point     = await getTargetPoint(session, target, timeout, waitType)
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
    waitType: 'click' | 'input' | 'none' = 'click',
): Promise<{ x: number; y: number }> {
    // 如果是坐标，直接返回
    if ('x' in target && 'y' in target) {
        return {x: target.x, y: target.y}
    }

    // 使用 Locator 定位元素
    const locator = session.createLocator(target, {timeout})
    const nodeId  = await locator.find()

    // 根据操作类型执行自动等待
    if (waitType !== 'none') {
        const autoWait = session.createAutoWait({timeout})
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
    server.registerTool('input', {
        description: `键鼠输入：键盘、鼠标及任意组合

组合键需拆分为独立事件。示例（Ctrl+A 全选）：
  events: [
    {type: "keydown", key: "Control"},
    {type: "keydown", key: "a"},
    {type: "keyup", key: "a"},
    {type: "keyup", key: "Control"}
  ]`,
        inputSchema: inputSchema,
    }, (args) => handleInput(args))
}
