/**
 * 公共 Schema 定义
 *
 * Target Zod Schema 和定位参数转换
 */

import { z } from 'zod'
import type { Target } from '../core/types.js'
import type { SemanticTarget } from '../core/dom-helpers.js'

export const pageTargetIdSchema = z.string().min(1).optional()
const frameStepSchema = z.union([z.string().min(1), z.number().int().nonnegative()])
export const frameZodSchema = z.union([frameStepSchema, z.array(frameStepSchema).min(1)]).optional()
export const pageConditionSchema = {
    expectedUrl: z.string().optional().describe('动作执行前要求页面 URL 与此值一致；不一致时不执行'),
    expectedRevision: z
        .string()
        .min(1)
        .optional()
        .describe('动作执行前要求页面 revision 与此值一致；从 browse list 获取'),
}

export function resolvePageTargetId(args: { targetId?: string; tabId?: string }): string | undefined {
    if (args.targetId !== undefined && args.tabId !== undefined && args.targetId !== args.tabId) {
        throw new Error('targetId 与 tabId 不一致，未执行页面操作')
    }
    return args.targetId ?? args.tabId
}

/**
 * Target Zod Schema（运行时校验）
 *
 * 支持的定位方式：
 * - role/name: 可访问性树定位
 * - text: 文本内容定位
 * - label: 表单 label 定位
 * - placeholder: 输入框占位符定位
 * - title: title 属性定位
 * - alt: alt 属性定位
 * - testId: data-testid 定位
 * - css: CSS 选择器定位
 * - xpath: XPath 定位
 * - x/y: 坐标定位
 */
const targetObjectSchema = z.intersection(
    z.union([
        z.object({
            role: z.string().describe('ARIA role（如 button、link、textbox）'),
            name: z.string().optional().describe('可访问名称（可选）'),
            exact: z.boolean().optional().describe('是否精确匹配（默认 false）'),
        }),
        // CSS+text 必须在纯 text / 纯 CSS 之前：z.object strip 未知字段
        z.object({
            css: z.string().describe('CSS 选择器'),
            text: z.string().describe('文本内容'),
            exact: z.boolean().optional().describe('是否精确匹配（默认 false）'),
        }),
        z.object({
            text: z.string().describe('文本内容'),
            exact: z.boolean().optional().describe('是否精确匹配（默认 false）'),
        }),
        z.object({
            label: z.string().describe('label 文本'),
            exact: z.boolean().optional().describe('是否精确匹配（默认 false）'),
        }),
        z.object({
            placeholder: z.string().describe('placeholder 文本'),
            exact: z.boolean().optional().describe('是否精确匹配（默认 false）'),
        }),
        z.object({
            title: z.string().describe('title 属性值'),
            exact: z.boolean().optional().describe('是否精确匹配（默认 false）'),
        }),
        z.object({
            alt: z.string().describe('alt 属性值'),
            exact: z.boolean().optional().describe('是否精确匹配（默认 false）'),
        }),
        z.object({ testId: z.string().describe('data-testid 值') }),
        z.object({ css: z.string().describe('CSS 选择器') }),
        z.object({ xpath: z.string().describe('XPath 表达式') }),
        z.object({
            x: z.number().describe('X 坐标（像素）'),
            y: z.number().describe('Y 坐标（像素）'),
        }),
    ]),
    z.object({
        nth: z.number().int().min(0).optional().describe('第 N 个匹配元素（从 0 开始，默认 0 即第一个）'),
    })
)

/**
 * Target Zod Schema（运行时校验）
 *
 * 支持对象形式或 JSON 字符串形式（兼容某些客户端的序列化行为）
 */
export const targetZodSchema = z.preprocess((val) => {
    // 如果是字符串，尝试解析为 JSON
    if (typeof val === 'string') {
        try {
            return JSON.parse(val)
        } catch {
            return val
        }
    }
    return val
}, targetObjectSchema)

/**
 * 转义 CSS 属性选择器中的值（防止引号注入）
 */
function escapeAttrValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * 转义 XPath 字符串字面量（实现已移至 core/utils.ts）
 */

/**
 * 从 Target 中提取 exact 标志
 */
function getExact(target: Target): boolean {
    return (target as { exact?: boolean }).exact ?? false
}

/**
 * 隐式 ARIA role → HTML 标签/选择器 映射
 *
 * 浏览器为特定 HTML 元素自动赋予隐式 ARIA role（如 <button> → button），
 * 仅匹配 [role="button"] 会遗漏这些元素，此映射补齐隐式匹配
 * 参考：https://www.w3.org/TR/html-aria/#docconformance
 */
const IMPLICIT_ROLE_SELECTORS: Record<string, string[]> = {
    button: ['button', 'input[type="submit"]', 'input[type="button"]', 'input[type="reset"]', 'summary'],
    link: ['a[href]', 'area[href]'],
    textbox: [
        'input:not([type])',
        'input[type="text"]',
        'input[type="email"]',
        'input[type="url"]',
        'input[type="tel"]',
        'input[type="search"]',
        'input[type="password"]',
        'textarea',
        '[contenteditable="true"]',
    ],
    checkbox: ['input[type="checkbox"]'],
    radio: ['input[type="radio"]'],
    combobox: ['select', 'input[list]'],
    listbox: ['select'],
    searchbox: ['input[type="search"]'],
    heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    image: ['img'],
    img: ['img'],
    navigation: ['nav'],
    main: ['main'],
    banner: ['header'],
    contentinfo: ['footer'],
    region: ['section[aria-label]', 'section[aria-labelledby]'],
    article: ['article'],
    complementary: ['aside'],
    form: ['form[aria-label]', 'form[aria-labelledby]'],
    table: ['table'],
    list: ['ul', 'ol', 'menu'],
    listitem: ['li'],
}

/**
 * 将 Target 对象解析为 find() 所需的查询参数
 *
 * 统一处理各种定位方式到 {selector, text, xpath} 的映射，
 * 避免在 extract/input/wait 中重复编写相同逻辑
 *
 * exact 语义（默认 false）：
 * - CSS 属性（placeholder/title/alt）：false → *= 子串匹配，true → = 精确匹配
 * - text：false → Extension find 的 includes 子串匹配，true → DOM 精确匹配
 * - label：按控件的标签和 aria-labelledby 引用计算名称
 * - role：CSS 筛选候选，再按实际 role 和可访问名称过滤
 * - testId/css/xpath：exact 不影响
 * - role 值自动 lowercase（ARIA role 不区分大小写）
 */
export function targetToFindParams(target: Target & { nth?: number }): {
    selector?: string
    text?: string
    xpath?: string
    nth?: number
    semantic?: SemanticTarget
} {
    let selector: string | undefined
    let text: string | undefined
    let xpath: string | undefined
    let semantic: SemanticTarget | undefined
    if ('css' in target && target.css) {
        selector = target.css
        if ('text' in target) {
            text = target.text
            semantic = { exact: getExact(target) }
        }
    } else if ('xpath' in target && target.xpath) {
        xpath = target.xpath
    } else if ('text' in target) {
        text = target.text
        semantic = { exact: getExact(target) }
    } else if ('role' in target && target.role) {
        const role = target.role.toLowerCase()
        const implicit = IMPLICIT_ROLE_SELECTORS[role] ?? []
        selector = ['[role="' + escapeAttrValue(role) + '"]', ...implicit].join(',')
        semantic = { role, ...('name' in target ? { name: target.name } : {}), exact: getExact(target) }
    } else if ('label' in target) {
        selector = 'input,select,textarea,button,meter,output,progress,[aria-label],[aria-labelledby]'
        semantic = { label: target.label, exact: getExact(target) }
    } else if ('placeholder' in target) {
        selector = '[placeholder' + (getExact(target) ? '=' : '*=') + '"' + escapeAttrValue(target.placeholder) + '"]'
    } else if ('title' in target) {
        selector = '[title' + (getExact(target) ? '=' : '*=') + '"' + escapeAttrValue(target.title) + '"]'
    } else if ('alt' in target) {
        selector = '[alt' + (getExact(target) ? '=' : '*=') + '"' + escapeAttrValue(target.alt) + '"]'
    } else if ('testId' in target) {
        selector = '[data-testid="' + escapeAttrValue(target.testId) + '"]'
    }
    return { selector, text, xpath, nth: target.nth, ...(semantic ? { semantic } : {}) }
}
