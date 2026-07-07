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
import { postConditionSchema, waitForPostCondition } from './post-condition.js'
import { targetToFindParams, targetZodSchema } from './schema.js'

const INPUT_WAIT_MAX_MS = 60_000

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
            'editorContext',
            'editorInsert',
            'editorCommand',
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
    ms: z
        .number()
        .int()
        .min(0)
        .max(INPUT_WAIT_MAX_MS)
        .optional()
        .describe('等待毫秒（wait 事件最大 60000ms，且不能超过 input 剩余 timeout）'),
    find: z.string().optional().describe('要查找并选中的文本（select/replace）'),
    nth: z.number().optional().describe('第 N 个匹配（select/replace，从 0 开始，默认 0 即第一个）'),
    command: z.string().optional().describe('浏览器编辑命令（editorCommand），如 bold、italic、insertOrderedList'),
    mode: z
        .enum(['keyboard', 'controlled'])
        .optional()
        .describe('输入模式（type），keyboard=键盘事件，controlled=直接设置 value 并触发 input/change 事件'),
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
    forceReason: z.string().optional().describe('force=true 时必填，说明为什么需要跳过可操作性检查'),
})

/**
 * input 参数 schema
 */
const inputSchema = z.object({
    events: z.array(inputEventSchema).describe('事件序列'),
    humanize: z.boolean().optional().describe('启用人类行为模拟（贝塞尔曲线移动、随机延迟）'),
    diagnostics: z.boolean().optional().describe('执行后返回新增 console error/warning 和失败网络请求摘要'),
    postCondition: postConditionSchema
        .optional()
        .describe('动作执行后要验证的页面状态；不传时 success 只表示事件已发出，不表示业务结果已达成'),
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

class StructuredToolError extends Error {
    constructor(
        private readonly code: string,
        message: string,
        private readonly suggestion: string,
        private readonly context: Record<string, unknown>
    ) {
        super(message)
        this.name = 'StructuredToolError'
    }

    toJSON(): object {
        return {
            error: {
                code: this.code,
                message: this.message,
                suggestion: this.suggestion,
                context: this.context,
            },
        }
    }
}

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
                const diagnosticsStart = args.diagnostics ? await captureDiagnosticsStart(unifiedSession) : undefined
                const warnings: string[] = []
                const eventResults: unknown[] = []
                const session = mode === 'extension' ? undefined : getSession()
                const inputStartedAt = Date.now()
                for (const event of args.events) {
                    const eventTimeout =
                        args.timeout === undefined
                            ? undefined
                            : Math.max(0, args.timeout - (Date.now() - inputStartedAt))
                    if (eventTimeout !== undefined && eventTimeout <= 0) {
                        throw new Error(`input 超时 (${args.timeout}ms)`)
                    }
                    const result = await executeInputEvent(
                        { unifiedSession, session, mode, humanize, timeout: eventTimeout },
                        event as InputEvent
                    )
                    if (typeof result === 'string') {
                        warnings.push(result)
                    } else if (result) {
                        eventResults.push(result)
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
                if (eventResults.length > 0) {
                    result.eventResults = eventResults
                }
                if (args.postCondition) {
                    result.postCondition = await waitForPostCondition(unifiedSession, args.postCondition, 'input')
                }
                if (diagnosticsStart) {
                    result.diagnostics = await captureDiagnosticsDelta(unifiedSession, diagnosticsStart)
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

interface TextSelectionDiagnostics {
    scope: Record<string, unknown>
    activeElement: Record<string, unknown> | null
    selection: Record<string, unknown>
    candidates: Array<Record<string, unknown>>
}

interface DiagnosticsStart {
    consoleCount: number
    networkCount: number
}

type InputEventResult = string | Record<string, unknown> | undefined

interface InputExecutionContext {
    unifiedSession: ReturnType<typeof getUnifiedSession>
    session?: ReturnType<typeof getSession>
    mode: ReturnType<ReturnType<typeof getUnifiedSession>['getMode']>
    humanize: boolean
    timeout?: number
}

const unifiedOnlyEventTypes = new Set<InputEvent['type']>([
    'select',
    'replace',
    'editorContext',
    'editorInsert',
    'editorCommand',
])

async function executeInputEvent(context: InputExecutionContext, event: InputEvent): Promise<InputEventResult> {
    if (context.mode === 'extension' || unifiedOnlyEventTypes.has(event.type)) {
        return executeUnifiedEvent(context.unifiedSession, event, context.humanize, context.timeout)
    }
    if (!context.session) {
        throw new Error('CDP 输入事件缺少 session')
    }
    await executeCdpEvent(context.session, event, context.humanize, context.timeout)
    return undefined
}

async function captureDiagnosticsStart(
    unifiedSession: ReturnType<typeof getUnifiedSession>
): Promise<DiagnosticsStart> {
    await unifiedSession.enableConsole()
    await unifiedSession.enableNetwork()
    const consoleLogs = await unifiedSession.getConsoleLogs()
    const network = await unifiedSession.getNetworkRequests()
    return { consoleCount: consoleLogs.length, networkCount: network.length }
}

async function captureDiagnosticsDelta(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    start: DiagnosticsStart
): Promise<Record<string, unknown>> {
    const consoleLogs = await unifiedSession.getConsoleLogs()
    const network = await unifiedSession.getNetworkRequests()
    return {
        console: consoleLogs
            .slice(start.consoleCount)
            .filter((item) => ['error', 'warning', 'warn'].includes(item.level))
            .slice(-20),
        failedRequests: network
            .slice(start.networkCount)
            .filter((item) => item.errorText || (item.status !== undefined && item.status >= 400))
            .slice(-20),
    }
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
): Promise<boolean> {
    if ('x' in target || 'y' in target) {
        return true
    }
    const params = targetToFindParams(target as Target & { nth?: number })
    const els = await unifiedSession.find(params.selector, params.text, params.xpath, timeout)
    const nth0 = params.nth ?? 0
    if (els.length <= nth0) {
        return false
    }
    const focused = await unifiedSession.evaluate(
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
    return focused === true
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

async function collectTextSelectionDiagnostics(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    findText: string,
    scopeTarget: Target | undefined,
    nth: number,
    scopeSelector: string | null,
    scopeText: string | null,
    scopeXpath: string | null,
    timeout?: number
): Promise<TextSelectionDiagnostics> {
    return await unifiedSession.evaluate<TextSelectionDiagnostics>(
        `function(findText, nth, scopeTarget, scopeSelector, scopeText, scopeXpath) {
        function selectorFor(el) {
            if (!(el instanceof Element)) return null;
            if (el.id) return '#' + CSS.escape(el.id);
            var parts = [];
            var current = el;
            while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
                var part = current.tagName.toLowerCase();
                if (current.classList && current.classList.length) {
                    part += '.' + Array.from(current.classList).slice(0, 2).map(function(cls) { return CSS.escape(cls); }).join('.');
                }
                var parent = current.parentElement;
                if (parent) {
                    var siblings = Array.from(parent.children).filter(function(child) { return child.tagName === current.tagName; });
                    if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
                }
                parts.unshift(part);
                current = parent;
            }
            return parts.join(' > ');
        }
        function summarizeElement(el) {
            if (!(el instanceof Element)) return null;
            var rect = el.getBoundingClientRect();
            var value = 'value' in el ? String(el.value || '') : '';
            var text = (el.innerText || el.textContent || value || '').replace(new RegExp('\\\\s+', 'g'), ' ').trim();
            return {
                tag: el.tagName.toLowerCase(),
                id: el.id || undefined,
                selector: selectorFor(el),
                text: text.slice(0, 160),
                valuePreview: value ? value.slice(0, 160) : undefined,
                visible: rect.width > 0 && rect.height > 0,
                disabled: Boolean(el.disabled),
                readOnly: Boolean(el.readOnly),
                contentEditable: Boolean(el.isContentEditable),
                bounds: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}
            };
        }
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
        var candidateElements = [];
        if (root instanceof Element) {
            candidateElements.push(root);
            candidateElements = candidateElements.concat(Array.from(root.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"], button, a')).slice(0, 12));
        }
        var active = document.activeElement;
        var selection = window.getSelection();
        return {
            scope: {
                target: scopeTarget,
                nth: nth,
                findText: findText,
                selector: scopeSelector,
                text: scopeText,
                xpath: scopeXpath,
                rootFound: Boolean(root)
            },
            activeElement: summarizeElement(active),
            selection: {
                text: selection ? selection.toString().slice(0, 160) : '',
                collapsed: selection ? selection.isCollapsed : true,
                anchorNode: selection && selection.anchorNode ? selection.anchorNode.nodeName : null,
                focusNode: selection && selection.focusNode ? selection.focusNode.nodeName : null,
                inputSelection: active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') ? {
                    selectionStart: active.selectionStart,
                    selectionEnd: active.selectionEnd,
                    valuePreview: String(active.value || '').slice(0, 160)
                } : undefined
            },
            candidates: candidateElements.map(summarizeElement).filter(Boolean)
        };
    }`,
        undefined,
        timeout,
        [findText, nth, scopeTarget ?? null, scopeSelector, scopeText, scopeXpath]
    )
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
        const diagnostics = await collectTextSelectionDiagnostics(
            unifiedSession,
            findText,
            scopeTarget,
            nth,
            scopeSelector,
            scopeText,
            scopeXpath,
            timeout
        )
        throw new StructuredToolError(
            'TEXT_SCOPE_NOT_FOUND',
            `未找到目标元素: ${JSON.stringify(scopeTarget)}`,
            '请检查 target 是否能定位到包含目标文本的元素，或先用 extract(state) 查看可交互元素',
            diagnostics as unknown as Record<string, unknown>
        )
    }
    if (result.type === 'notfound') {
        const diagnostics = await collectTextSelectionDiagnostics(
            unifiedSession,
            findText,
            scopeTarget,
            nth,
            scopeSelector,
            scopeText,
            scopeXpath,
            timeout
        )
        throw new StructuredToolError(
            'TEXT_NOT_FOUND',
            scopeTarget
                ? `目标元素内未找到文本 "${findText}"${nth > 0 ? `（第 ${nth} 个匹配）` : ''}`
                : `未找到文本: "${findText}"${nth > 0 ? `（第 ${nth} 个匹配）` : ''}`,
            '请检查 find 文本、nth 序号和 target 范围；context.candidates 提供了当前范围内的候选文本和 selector',
            diagnostics as unknown as Record<string, unknown>
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

async function executeEditingCommands(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    commands: string[],
    timeout?: number
): Promise<Record<string, unknown>> {
    const result = await unifiedSession.evaluate<{
        success: boolean
        executed: Array<{ command: string; success: boolean }>
        selection?: Record<string, unknown>
    }>(
        `function(commands) {
            function summarizeSelection() {
                var active = document.activeElement;
                if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
                    return {
                        type: active.tagName.toLowerCase(),
                        selectionStart: active.selectionStart,
                        selectionEnd: active.selectionEnd,
                        selectedText: String(active.value || '').slice(active.selectionStart || 0, active.selectionEnd || 0)
                    };
                }
                var selection = window.getSelection();
                return {
                    type: 'document',
                    text: selection ? selection.toString() : '',
                    collapsed: selection ? selection.isCollapsed : true
                };
            }
            function commandSelectAll() {
                var active = document.activeElement;
                if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && typeof active.select === 'function') {
                    active.select();
                    active.dispatchEvent(new Event('select', {bubbles: true}));
                    return true;
                }
                if (active && active.isContentEditable) {
                    var range = document.createRange();
                    range.selectNodeContents(active);
                    var selection = window.getSelection();
                    if (!selection) return false;
                    selection.removeAllRanges();
                    selection.addRange(range);
                    return true;
                }
                return document.execCommand('selectAll');
            }
            var executed = commands.map(function(command) {
                if (command === 'selectAll') {
                    return {command: command, success: commandSelectAll()};
                }
                if (['copy', 'cut', 'paste', 'undo', 'redo'].indexOf(command) !== -1) {
                    return {command: command, success: document.execCommand(command)};
                }
                return {command: command, success: false};
            });
            return {success: executed.every(function(item) { return item.success; }), executed: executed, selection: summarizeSelection()};
        }`,
        undefined,
        timeout,
        [commands]
    )
    if (!result.success) {
        throw new StructuredToolError(
            'EDIT_COMMAND_FAILED',
            `编辑命令执行失败: ${commands.join(', ')}`,
            '请确认当前页面已有可编辑焦点，或给 keydown 事件提供 target 参数',
            result as unknown as Record<string, unknown>
        )
    }
    return result as unknown as Record<string, unknown>
}

/**
 * 验证事件参数（两种执行模式共享），避免在 Extension/CDP 两个 switch 中重复校验
 */
function requiredEventParam(event: InputEvent, name: keyof InputEvent): never {
    throw new Error(`events[].${String(name)} 是 ${event.type} 事件的必填参数`)
}

function validateEvent(event: InputEvent): void {
    if (event.commands && event.commands.length > 0 && event.type !== 'keydown') {
        throw new Error(
            `events[].commands 只能用于 keydown 事件，当前事件类型为 ${event.type}，如需触发编辑命令，请把 commands 放在 keydown 事件上`
        )
    }
    if (event.force && !event.forceReason) {
        throw new Error('events[].forceReason 在 force=true 时必填')
    }
    switch (event.type) {
        case 'keydown':
        case 'keyup':
            if (!event.key) {
                requiredEventParam(event, 'key')
            }
            break
        case 'mousemove':
        case 'touchstart':
        case 'touchmove':
            if (!event.target) {
                requiredEventParam(event, 'target')
            }
            break
        case 'type':
            if (event.text === undefined) {
                requiredEventParam(event, 'text')
            }
            break
        case 'select':
            if (!event.find) {
                requiredEventParam(event, 'find')
            }
            break
        case 'replace':
            if (!event.find) {
                requiredEventParam(event, 'find')
            }
            if (event.text === undefined) {
                requiredEventParam(event, 'text')
            }
            break
        case 'drag':
            if (!event.target) {
                throw new Error('drag 事件需要 target 参数')
            }
            if (!event.to) {
                throw new Error('drag 事件需要 to 参数')
            }
            break
        case 'editorInsert':
            if (!event.text) {
                requiredEventParam(event, 'text')
            }
            break
        case 'editorCommand':
            if (!event.command) {
                requiredEventParam(event, 'command')
            }
            break
        case 'wait':
            if (event.ms === undefined) {
                requiredEventParam(event, 'ms')
            }
            break
    }
}

interface UnifiedInputContext {
    unifiedSession: ReturnType<typeof getUnifiedSession>
    humanize: boolean
    timeout?: number
}

type UnifiedInputHandler = (context: UnifiedInputContext, event: InputEvent) => Promise<InputEventResult>

async function executeUnifiedEvent(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    event: InputEvent,
    humanize: boolean,
    timeout?: number
): Promise<InputEventResult> {
    validateEvent(event)
    const handler = unifiedInputHandlers[event.type]
    if (!handler) {
        throw new Error(`未知事件类型: ${(event as { type: string }).type}`)
    }
    return handler({ unifiedSession, humanize, timeout }, event)
}

const unifiedInputHandlers: Record<InputEvent['type'], UnifiedInputHandler> = {
    keydown: handleUnifiedKeyDown,
    keyup: handleUnifiedKeyUp,
    click: handleUnifiedClick,
    mousedown: handleUnifiedMouseDown,
    mouseup: handleUnifiedMouseUp,
    mousemove: handleUnifiedMouseMove,
    wheel: handleUnifiedWheel,
    touchstart: handleUnifiedTouchStart,
    touchmove: handleUnifiedTouchMove,
    touchend: handleUnifiedTouchEnd,
    type: handleUnifiedType,
    wait: handleUnifiedWait,
    select: handleUnifiedSelect,
    replace: handleUnifiedReplace,
    editorContext: handleUnifiedEditorContext,
    editorInsert: handleUnifiedEditorInsert,
    editorCommand: handleUnifiedEditorCommand,
    drag: handleUnifiedDrag,
}

async function handleUnifiedKeyDown(
    { unifiedSession, timeout }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    if (unifiedSession.getInputMode() === 'stealth' && event.commands && event.commands.length > 0) {
        throw new Error(
            'commands 参数不支持 stealth 输入模式，请先调用 manage action=inputMode inputMode=precise 切换后重试'
        )
    }
    if (event.commands && event.commands.length > 0 && event.target) {
        const focused = await focusTargetForCommands(unifiedSession, event.target, timeout)
        if (!focused) {
            throw new Error('commands 目标未找到或未成功聚焦')
        }
    }
    await unifiedSession.keyDown(event.key!, event.commands)
    if (event.commands && event.commands.length > 0) {
        return await executeEditingCommands(unifiedSession, event.commands, timeout)
    }
    return undefined
}

async function handleUnifiedKeyUp(
    { unifiedSession }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    await unifiedSession.keyUp(event.key!)
    return undefined
}

async function handleUnifiedClick(
    { unifiedSession, timeout }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    const button = event.button ?? 'left'
    const clickCount = event.clickCount ?? 1
    if (!event.target) {
        await unifiedSession.mouseClick(button, clickCount)
        return undefined
    }

    if ('x' in event.target && 'y' in event.target) {
        const point = await getTargetPointExtension(unifiedSession, event.target, timeout)
        await unifiedSession.mouseMove(point.x, point.y)
        await unifiedSession.mouseClick(button, clickCount)
        return undefined
    }

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
            const result = await unifiedSession.actionableClick(elements[nth].refId, event.force === true)
            if (!result.success) {
                throw new StructuredToolError(
                    'ACTIONABILITY_FAILED',
                    result.error || 'Click failed',
                    result.suggestions?.[0] ??
                        '请根据 context.rect、context.clickPoint 和 context.coveringElement 调整 target',
                    result as unknown as Record<string, unknown>
                )
            }
            return undefined
        }
    }

    const point = await getTargetPointExtension(unifiedSession, event.target, timeout)
    await unifiedSession.mouseMove(point.x, point.y)
    await unifiedSession.mouseClick(button, clickCount, typeof point.refId === 'string' ? point.refId : undefined)
    return undefined
}

async function handleUnifiedMouseDown(
    { unifiedSession, timeout }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    if (event.target) {
        const point = await getTargetPointExtension(unifiedSession, event.target, timeout)
        await unifiedSession.mouseMove(point.x, point.y)
    }
    await unifiedSession.mouseDown(event.button ?? 'left')
    return undefined
}

async function handleUnifiedMouseUp(
    { unifiedSession }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    await unifiedSession.mouseUp(event.button ?? 'left')
    return undefined
}

async function handleUnifiedMouseMove(
    { unifiedSession, humanize, timeout }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    const point = await getTargetPointExtension(unifiedSession, event.target!, timeout)

    if (humanize && event.steps && event.steps > 1) {
        const path = generateBezierPath(unifiedSession.getMousePosition(), point, event.steps)
        for (const p of path) {
            await unifiedSession.mouseMove(p.x, p.y)
            await randomDelay(getMouseMoveDelay(), getMouseMoveDelay() * 2)
        }
    } else {
        await unifiedSession.mouseMove(point.x, point.y)
    }
    return undefined
}

async function handleUnifiedWheel(
    { unifiedSession, timeout }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    if (event.target) {
        const { selector, text, xpath, nth: nthParam } = targetToFindParams(event.target as Target & { nth?: number })
        const elements = await unifiedSession.find(selector, text, xpath, timeout)
        const nth = nthParam ?? 0
        if (elements.length > nth) {
            await unifiedSession.scroll(event.deltaX ?? 0, event.deltaY ?? 0, elements[nth].refId)
            return undefined
        }
        const point = await getTargetPointExtension(unifiedSession, event.target, timeout)
        await unifiedSession.mouseMove(point.x, point.y)
    }
    await unifiedSession.mouseWheel(event.deltaX ?? 0, event.deltaY ?? 0)
    return undefined
}

async function handleUnifiedTouchStart(
    { unifiedSession, timeout }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    const point = await getTargetPointExtension(unifiedSession, event.target!, timeout)
    await unifiedSession.touchStart(point.x, point.y)
    return undefined
}

async function handleUnifiedTouchMove(
    { unifiedSession, timeout }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    const point = await getTargetPointExtension(unifiedSession, event.target!, timeout)
    await unifiedSession.touchMove(point.x, point.y)
    return undefined
}

async function handleUnifiedTouchEnd({ unifiedSession }: UnifiedInputContext): Promise<InputEventResult> {
    await unifiedSession.touchEnd()
    return undefined
}

async function handleUnifiedType(
    { unifiedSession, humanize, timeout }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    if (event.mode === 'controlled' || event.dispatch) {
        await inputControlled(unifiedSession, event, timeout)
        return undefined
    }

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
        for (const char of event.text!) {
            await unifiedSession.typeText(char)
            await randomDelay(getTypingDelay(delay), getTypingDelay(delay) * 1.5)
        }
    } else {
        await unifiedSession.typeText(event.text!, delay)
    }
    return undefined
}

function ensureWaitFitsTimeout(ms: number, timeout: number | undefined): void {
    if (timeout !== undefined && ms > timeout) {
        throw new Error(`events[].ms (${ms}ms) 超过 input 剩余 timeout (${timeout}ms)`)
    }
}

async function handleUnifiedWait({ timeout }: UnifiedInputContext, event: InputEvent): Promise<InputEventResult> {
    ensureWaitFitsTimeout(event.ms!, timeout)
    await new Promise((resolve) => setTimeout(resolve, event.ms!))
    return undefined
}

async function handleUnifiedSelect(
    { unifiedSession, timeout }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    await focusTargetIfNeeded(unifiedSession, event.target, event.nth, timeout)
    await selectText(unifiedSession, event.find!, event.target, event.nth, timeout)
    return undefined
}

async function handleUnifiedReplace(
    { unifiedSession, timeout }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    await focusTargetIfNeeded(unifiedSession, event.target, event.nth, timeout)
    const formatted = await selectText(unifiedSession, event.find!, event.target, event.nth, timeout)
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

    const replaceResult = await unifiedSession.evaluate<'ok' | 'readonly' | 'fallback'>(
        `function(replacementText) {
        var el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.setRangeText) {
            if (el.readOnly || el.disabled) return 'readonly';
            el.setRangeText(replacementText, el.selectionStart, el.selectionEnd, 'end');
            el.dispatchEvent(new Event('input', {bubbles: true}));
            return 'ok';
        }
        var sel = window.getSelection();
        if (!sel || sel.isCollapsed) return 'readonly';
        var anchor = sel.anchorNode;
        var editable = anchor instanceof Element ? anchor : anchor && anchor.parentElement;
        while (editable && !editable.isContentEditable && editable !== document.body) {
            editable = editable.parentElement;
        }
        if (!editable || !editable.isContentEditable) return 'readonly';
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
        await unifiedSession.typeText(event.text!)
    }
    if (formatted) {
        return `替换的文本原在 <${formatted}> 标签内，替换后格式可能丢失`
    }
    return undefined
}

async function handleUnifiedEditorContext(
    { unifiedSession, timeout }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    return (await editorAction(unifiedSession, 'context', event, timeout)) as Record<string, unknown>
}

async function handleUnifiedEditorInsert(
    { unifiedSession, timeout }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    await editorAction(unifiedSession, 'insert', event, timeout)
    return undefined
}

async function handleUnifiedEditorCommand(
    { unifiedSession, timeout }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    await editorAction(unifiedSession, 'command', event, timeout)
    return undefined
}

async function handleUnifiedDrag(
    { unifiedSession, timeout }: UnifiedInputContext,
    event: InputEvent
): Promise<InputEventResult> {
    if (!event.target) {
        throw new Error('drag 事件需要 target 参数')
    }
    if (!event.to) {
        throw new Error('drag 事件需要 to 参数')
    }
    if ('x' in event.target || 'y' in event.target) {
        throw new Error('drag 的 target 不支持坐标类型，请使用选择器（css/text/xpath/role 等）')
    }
    if ('x' in event.to || 'y' in event.to) {
        throw new Error('drag 的 to 不支持坐标类型，请使用选择器（css/text/xpath/role 等）')
    }

    const srcParams = targetToFindParams(event.target as Target & { nth?: number })
    const dstParams = targetToFindParams(event.to as Target & { nth?: number })
    const srcNth = srcParams.nth ?? 0
    const dstNth = dstParams.nth ?? 0

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
    if (!dragResult.success && dragResult.code === 'REF_STALE') {
        console.warn('[MCP] drag refId 失效，自动重试一次:', dragResult.error)
        dragResult = await attemptDrag()
        retried = true
    }
    if (!dragResult.success) {
        throw new Error(dragResult.error || 'drag 执行失败')
    }
    return retried ? 'drag 因 refId 失效已自动重试一次（可能是 React 等框架重渲染导致）' : undefined
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
async function inputControlled(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    event: InputEvent,
    timeout?: number
): Promise<void> {
    if (!event.target) {
        throw new Error('controlled 输入需要 target 参数定位输入元素')
    }
    if ('x' in event.target && 'y' in event.target) {
        throw new Error('controlled 输入不支持坐标型 target，请使用 CSS 选择器、role 或文本定位')
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
        throw new StructuredToolError(
            'TARGET_NOT_FOUND',
            `controlled 输入目标未找到: ${JSON.stringify(event.target)}`,
            '请检查 target 是否能定位到 input、textarea、select 或 contenteditable 元素；context.candidates 提供当前页面候选元素',
            await buildTargetDiagnosticContext(unifiedSession, event.target, elements.length, nth, timeout)
        )
    }
    const result = await unifiedSession.dispatchInput(elements[nth].refId, event.text ?? '')
    if (!result.success) {
        throw new StructuredToolError(
            'CONTROLLED_INPUT_FAILED',
            result.error || 'controlled 输入失败',
            '请检查目标元素是否可编辑、未 disabled，并确认当前 frame 与 target 匹配',
            await buildTargetDiagnosticContext(
                unifiedSession,
                event.target,
                elements.length,
                nth,
                timeout,
                result.error || 'controlled 输入失败'
            )
        )
    }
}

async function buildTargetDiagnosticContext(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    target: Target,
    matchCount: number,
    nth: number,
    timeout?: number,
    reason = '目标元素未找到'
): Promise<Record<string, unknown>> {
    let page: unknown
    try {
        page = await unifiedSession.evaluate(
            `(() => {
                const active = document.activeElement;
                const selection = window.getSelection();
                const candidates = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"], button, a, [role="button"], [role="textbox"], [role="combobox"]')).slice(0, 20);
                return {
                    activeElement: active ? {
                        tag: active.tagName.toLowerCase(),
                        id: active.id || undefined,
                        className: typeof active.className === 'string' ? active.className : undefined,
                        text: (active.textContent || '').trim().slice(0, 80),
                        value: 'value' in active ? active.value : undefined,
                        selectionStart: 'selectionStart' in active ? active.selectionStart : undefined,
                        selectionEnd: 'selectionEnd' in active ? active.selectionEnd : undefined
                    } : null,
                    selection: {
                        text: selection ? selection.toString().slice(0, 160) : '',
                        collapsed: selection ? selection.isCollapsed : true,
                        anchorNode: selection && selection.anchorNode ? selection.anchorNode.nodeName : null,
                        focusNode: selection && selection.focusNode ? selection.focusNode.nodeName : null
                    },
                    candidates: candidates.map(function(el) {
                        const rect = el.getBoundingClientRect();
                        return {
                            tag: el.tagName.toLowerCase(),
                            id: el.id || undefined,
                            role: el.getAttribute('role') || undefined,
                            text: (el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 80),
                            visible: rect.width > 0 && rect.height > 0,
                            disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
                            bounds: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}
                        };
                    })
                };
            })()`,
            undefined,
            timeout
        )
    } catch (err) {
        page = { diagnosticError: err instanceof Error ? err.message : String(err) }
    }
    return { reason, target, matchCount, nth, page }
}

async function editorAction(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    action: 'context' | 'insert' | 'command',
    event: InputEvent,
    timeout?: number
): Promise<unknown> {
    if (event.target) {
        const focused = await focusTargetForCommands(unifiedSession, event.target, timeout)
        if (!focused) {
            throw new Error('editor 目标未找到或未成功聚焦')
        }
    }

    return unifiedSession.evaluate(
        `function(action, text, command) {
            var active = document.activeElement;
            var sel = window.getSelection();
            var editable = active;
            if (!editable || editable === document.body || editable === document.documentElement) {
                var anchor = sel && sel.anchorNode;
                editable = anchor instanceof Element ? anchor : anchor && anchor.parentElement;
                while (editable && !editable.isContentEditable && editable !== document.body) {
                    editable = editable.parentElement;
                }
            }
            var isInput = !!active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
            var isEditable = !!editable && editable.isContentEditable;
            if (!isInput && !isEditable) {
                throw new Error('editor 事件需要已聚焦 input、textarea 或 contenteditable 元素');
            }

            if (action === 'context') {
                var selectedText = '';
                if (isInput) {
                    selectedText = active.value.slice(active.selectionStart || 0, active.selectionEnd || 0);
                } else if (sel) {
                    selectedText = sel.toString();
                }
                return {
                    activeElement: active ? {
                        tag: active.tagName.toLowerCase(),
                        id: active.id || undefined,
                        isContentEditable: !!active.isContentEditable,
                        selectionStart: isInput ? active.selectionStart : undefined,
                        selectionEnd: isInput ? active.selectionEnd : undefined
                    } : null,
                    editableElement: editable ? {
                        tag: editable.tagName.toLowerCase(),
                        id: editable.id || undefined,
                        isContentEditable: !!editable.isContentEditable
                    } : null,
                    selectedText: selectedText,
                    selectionCollapsed: isInput ? active.selectionStart === active.selectionEnd : !sel || sel.isCollapsed
                };
            }

            if (action === 'insert') {
                if (isInput) {
                    active.setRangeText(text, active.selectionStart || 0, active.selectionEnd || 0, 'end');
                    active.dispatchEvent(new Event('input', {bubbles: true}));
                    active.dispatchEvent(new Event('change', {bubbles: true}));
                    return {success: true};
                }
                if (document.execCommand('insertText', false, text)) {
                    return {success: true};
                }
                throw new Error('editorInsert 无法插入文本');
            }

            if (!document.execCommand(command, false, text || null)) {
                throw new Error('editorCommand 执行失败: ' + command);
            }
            return {success: true, command: command};
        }`,
        undefined,
        timeout,
        [action, event.text ?? '', event.command ?? '']
    )
}

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
    const nth = nthParam ?? 0
    if (elements.length === 0) {
        throw new StructuredToolError(
            'TARGET_NOT_FOUND',
            `未找到目标元素: ${JSON.stringify(target)}`,
            '请检查 target 是否正确，或先用 extract type=state 查看 interactiveElements 候选',
            await buildTargetDiagnosticContext(unifiedSession, target, elements.length, nth, timeout)
        )
    }

    if (nth >= elements.length) {
        throw new StructuredToolError(
            'TARGET_INDEX_OUT_OF_RANGE',
            `第 ${nth} 个匹配元素不存在（共 ${elements.length} 个）`,
            '请降低 nth，或先用 extract type=state 查看当前匹配到的候选元素',
            await buildTargetDiagnosticContext(
                unifiedSession,
                target,
                elements.length,
                nth,
                timeout,
                '目标元素序号越界'
            )
        )
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

    // iframe + precise：消费者（chrome.debugger）需要父视口绝对，
    // scrollIntoView({block:'center'}) 会 cascade 到父框架，导致 frameOffset 与父绝对 rect 都过期，
    // refetch find() 让 content-handler 重新计算 frameOffset 并返回最新父绝对 rect
    const refreshed = await unifiedSession.find(selector, text, xpath, timeout)
    const rect = refreshed[nth]?.rect ?? elements[nth].rect
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, refId }
}

interface CdpInputContext {
    session: ReturnType<typeof getSession>
    humanize: boolean
    timeout?: number
}

type CdpInputHandler = (context: CdpInputContext, event: InputEvent) => Promise<void>

async function executeCdpEvent(
    session: ReturnType<typeof getSession>,
    event: InputEvent,
    humanize: boolean,
    timeout?: number
): Promise<void> {
    validateEvent(event)
    const handler = cdpInputHandlers[event.type]
    if (!handler) {
        throw new Error(`未知事件类型: ${(event as { type: string }).type}`)
    }
    await handler({ session, humanize, timeout }, event)
}

const cdpInputHandlers: Partial<Record<InputEvent['type'], CdpInputHandler>> = {
    keydown: handleCdpKeyDown,
    keyup: handleCdpKeyUp,
    click: handleCdpClick,
    mousedown: handleCdpMouseDown,
    mouseup: handleCdpMouseUp,
    mousemove: handleCdpMouseMove,
    wheel: handleCdpWheel,
    touchstart: handleCdpTouchStart,
    touchmove: handleCdpTouchMove,
    touchend: handleCdpTouchEnd,
    type: handleCdpType,
    wait: handleCdpWait,
    drag: handleCdpDrag,
}

async function handleCdpKeyDown({ session }: CdpInputContext, event: InputEvent): Promise<void> {
    await session.keyDown(event.key!, event.commands)
}

async function handleCdpKeyUp({ session }: CdpInputContext, event: InputEvent): Promise<void> {
    await session.keyUp(event.key!)
}

async function handleCdpClick({ session, humanize, timeout }: CdpInputContext, event: InputEvent): Promise<void> {
    if (event.target) {
        await moveToTarget(session, event.target, humanize, timeout)
    }
    const cdpButton = event.button ?? 'left'
    const cdpClickCount = event.clickCount ?? 1
    for (let i = 1; i <= cdpClickCount; i++) {
        await session.mouseDown(cdpButton, i)
        await session.mouseUp(cdpButton, i)
    }
}

async function handleCdpMouseDown({ session, humanize, timeout }: CdpInputContext, event: InputEvent): Promise<void> {
    if (event.target) {
        await moveToTarget(session, event.target, humanize, timeout)
    }
    await session.mouseDown(event.button ?? 'left')
}

async function handleCdpMouseUp({ session }: CdpInputContext, event: InputEvent): Promise<void> {
    await session.mouseUp(event.button ?? 'left')
}

async function handleCdpMouseMove({ session, humanize, timeout }: CdpInputContext, event: InputEvent): Promise<void> {
    await moveToTarget(session, event.target!, humanize, timeout, event.steps)
}

async function handleCdpWheel({ session, humanize, timeout }: CdpInputContext, event: InputEvent): Promise<void> {
    if (event.target) {
        await moveToTarget(session, event.target, humanize, timeout)
    }
    await session.mouseWheel(event.deltaX ?? 0, event.deltaY ?? 0)
}

async function handleCdpTouchStart({ session, timeout }: CdpInputContext, event: InputEvent): Promise<void> {
    const point = await getTargetPoint(session, event.target!, timeout)
    await session.touchStart(point.x, point.y)
}

async function handleCdpTouchMove({ session, humanize, timeout }: CdpInputContext, event: InputEvent): Promise<void> {
    const point = await getTargetPoint(session, event.target!, timeout)

    if (humanize && event.steps && event.steps > 1) {
        const current = session.getBehaviorSimulator().getCurrentPosition()
        const path = generateBezierPath(current, point, event.steps)
        for (const p of path) {
            await session.touchMove(p.x, p.y)
            await randomDelay(5, 15)
        }
    } else {
        await session.touchMove(point.x, point.y)
    }
}

async function handleCdpTouchEnd({ session }: CdpInputContext): Promise<void> {
    await session.touchEnd()
}

async function handleCdpType({ session, humanize, timeout }: CdpInputContext, event: InputEvent): Promise<void> {
    if (event.dispatch || event.mode === 'controlled') {
        throw new Error('controlled/dispatch 输入需要 Extension 连接，当前为 CDP 模式')
    }
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
        for (const char of event.text!) {
            await session.type(char)
            await randomDelay(getTypingDelay(delay), getTypingDelay(delay) * 1.5)
        }
    } else {
        await session.type(event.text!, delay)
    }
}

async function handleCdpWait({ timeout }: CdpInputContext, event: InputEvent): Promise<void> {
    ensureWaitFitsTimeout(event.ms!, timeout)
    await new Promise((resolve) => setTimeout(resolve, event.ms!))
}

async function handleCdpDrag(): Promise<void> {
    throw new Error('drag 事件仅在 Extension 模式下可用，当前为 CDP 模式')
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

最短示例：
  click: {events:[{type:"click",target:{css:"button[type=submit]"}}]}
  type: {events:[{type:"type",target:{css:"input[name=q]"},text:"hello"}]}
  controlled type: {events:[{type:"type",mode:"controlled",target:{css:"input[name=q]"},text:"hello"}]}
  replace: {events:[{type:"replace",target:{css:"textarea"},find:"old",text:"new"}]}
注意：纯键盘事件（不带 commands）仅保证 JS keyboard event 可被监听，不保证触发浏览器原生编辑行为；
      全选/复制/粘贴等语义用 commands；"全选并替换文本"用 select/replace 事件更简洁；
      commands 仅支持 inputMode=precise，stealth 模式下会报错`,
            inputSchema: inputSchema,
        },
        (args) => handleInput(args)
    )
}
