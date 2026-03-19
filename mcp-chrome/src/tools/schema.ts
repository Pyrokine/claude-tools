/**
 * 公共 Schema 定义
 *
 * Target Zod Schema 和定位参数转换
 */

import {z} from 'zod'
import type {Target} from '../core/types.js'

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
                 nth: z.number().int().min(0).optional()
                       .describe('第 N 个匹配元素（从 0 开始，默认 0 即第一个）'),
             }),
)

/**
 * Target Zod Schema（运行时校验）
 *
 * 支持对象形式或 JSON 字符串形式（兼容某些客户端的序列化行为）
 */
export const targetZodSchema = z.preprocess(
    (val) => {
        // 如果是字符串，尝试解析为 JSON
        if (typeof val === 'string') {
            try {
                return JSON.parse(val)
            } catch {
                return val
            }
        }
        return val
    },
    targetObjectSchema,
)

/**
 * 转义 CSS 属性选择器中的值（防止引号注入）
 */
function escapeAttrValue(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * 转义 XPath 字符串字面量（处理包含引号的值）
 */
function escapeXPathString(str: string): string {
    if (!str.includes('\'')) {
        return `'${str}'`
    }
    if (!str.includes('"')) {
        return `"${str}"`
    }
    // 同时包含单双引号：用 concat 拼接
    const parts: string[] = []
    let current           = ''
    for (const char of str) {
        if (char === '\'') {
            if (current) {
                parts.push(`'${current}'`)
            }
            parts.push(`"'"`)
            current = ''
        } else {
            current += char
        }
    }
    if (current) {
        parts.push(`'${current}'`)
    }
    return `concat(${parts.join(',')})`
}

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
 * 仅匹配 [role="button"] 会遗漏这些元素。此映射补齐隐式匹配。
 * 参考：https://www.w3.org/TR/html-aria/#docconformance
 */
const IMPLICIT_ROLE_SELECTORS: Record<string, string[]> = {
    button: ['button', 'input[type="submit"]', 'input[type="button"]', 'input[type="reset"]', 'summary'],
    link: ['a[href]', 'area[href]'],
    textbox: [
        'input:not([type])', 'input[type="text"]', 'input[type="email"]',
        'input[type="url"]', 'input[type="tel"]', 'input[type="search"]',
        'input[type="password"]', 'textarea', '[contenteditable="true"]',
    ],
    checkbox: ['input[type="checkbox"]'],
    radio: ['input[type="radio"]'],
    combobox: ['select'],
    heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    image: ['img[alt]'],
    img: ['img[alt]'],
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
 * 隐式 ARIA role → XPath self:: 条件映射
 *
 * 用于 role+name 组合定位：需要 xpath 表达多来源可访问名称过滤。
 * 与 IMPLICIT_ROLE_SELECTORS 内容对应，只是语法不同。
 */
const IMPLICIT_ROLE_XPATH: Record<string, string> = {
    button: 'self::button or self::input[@type="submit"] or self::input[@type="button"] or self::input[@type="reset"] or self::summary',
    link: 'self::a[@href] or self::area[@href]',
    textbox: 'self::input[not(@type)] or self::input[@type="text"] or self::input[@type="email"] or self::input[@type="url"] or self::input[@type="tel"] or self::input[@type="search"] or self::input[@type="password"] or self::textarea or self::*[@contenteditable="true"]',
    checkbox: 'self::input[@type="checkbox"]',
    radio: 'self::input[@type="radio"]',
    combobox: 'self::select',
    heading: 'self::h1 or self::h2 or self::h3 or self::h4 or self::h5 or self::h6',
    image: 'self::img[@alt]',
    img: 'self::img[@alt]',
    navigation: 'self::nav',
    main: 'self::main',
    banner: 'self::header',
    contentinfo: 'self::footer',
    region: 'self::section[@aria-label or @aria-labelledby]',
    article: 'self::article',
    complementary: 'self::aside',
    form: 'self::form[@aria-label or @aria-labelledby]',
    table: 'self::table',
    list: 'self::ul or self::ol or self::menu',
    listitem: 'self::li',
}

/**
 * 将 Target 对象解析为 find() 所需的查询参数
 *
 * 统一处理各种定位方式到 {selector, text, xpath} 的映射，
 * 避免在 extract/input/wait 中重复编写相同逻辑。
 *
 * exact 语义（默认 false）：
 * - CSS 属性（placeholder/title/alt）：false → *= 子串匹配，true → = 精确匹配
 * - text：false → Extension find 的 includes 子串匹配，true → xpath 精确匹配
 * - label：xpath 同时匹配 aria-label、<label for> 关联、<label> 内嵌控件
 * - role：无 name 时 CSS 匹配隐式+显式 role；有 name 时 xpath 匹配多来源可访问名称
 * - testId/css/xpath：exact 不影响
 * - role 值自动 lowercase（ARIA role 不区分大小写）
 */
export function targetToFindParams(target: Target & { nth?: number }): {
    selector?: string; text?: string; xpath?: string; nth?: number
} {
    let selector: string | undefined
    let text: string | undefined
    let xpath: string | undefined

    if ('css' in target && target.css) {
        selector = target.css
        // CSS + 文本组合定位：先 CSS 筛选，再按 text 过滤
        if ('text' in target && (target as { text?: string }).text) {
            text = (target as { text: string }).text
        }
    } else if ('xpath' in target && target.xpath) {
        xpath = target.xpath
    } else if ('text' in target && target.text) {
        if (getExact(target)) {
            // 精确匹配：通过 xpath 匹配 textContent 完全相等的元素
            xpath = `//*[normalize-space(.)=${escapeXPathString(target.text)}]`
        } else {
            text = target.text
        }
    } else if ('role' in target && target.role) {
        const roleLower = target.role.toLowerCase()

        if ('name' in target && target.name) {
            // role + name：xpath 同时匹配隐式/显式 role 和多来源可访问名称
            const roleConditions = [`@role=${escapeXPathString(roleLower)}`]
            const implicitXPath  = IMPLICIT_ROLE_XPATH[roleLower]
            if (implicitXPath) {
                roleConditions.push(implicitXPath)
            }
            const nameStr = escapeXPathString(target.name)
            // 多来源可访问名称：textContent, aria-label, title, placeholder, alt, value, label-for
            // 注意：@value 读 HTML attribute（初始值），脚本动态写入的值需用 evaluate 定位
            const nameConditions = [
                `contains(.,${nameStr})`,
                `contains(@aria-label,${nameStr})`,
                `contains(@title,${nameStr})`,
                `contains(@placeholder,${nameStr})`,
                `contains(@alt,${nameStr})`,
                `contains(@value,${nameStr})`,
                `@id=//label[contains(.,${nameStr})]/@for`,
            ].join(' or ')
            xpath                = `//*[(${roleConditions.join(' or ')}) and (${nameConditions})]`
        } else {
            // role only：CSS 选择器匹配隐式标签 + 显式 role
            const escapedRole = escapeAttrValue(roleLower)
            const selectors   = [`[role="${escapedRole}"]`]
            const implicit    = IMPLICIT_ROLE_SELECTORS[roleLower]
            if (implicit) {
                selectors.push(...implicit)
            }
            selector = selectors.join(',')
        }
    } else if ('label' in target && target.label) {
        // xpath 同时匹配 aria-label、<label for="id"> 关联、<label> 内嵌控件
        const xpathStr     = escapeXPathString(target.label)
        const formControls = 'self::input or self::select or self::textarea'
        if (getExact(target)) {
            const labelMatch = `normalize-space(.)=${xpathStr}`
            xpath            = `//*[@aria-label=${xpathStr}]`
                               +
                               ` | //*[@id=//label[${labelMatch}]/@for]`
                               +
                               ` | //label[${labelMatch}]/descendant::*[${formControls}]`
                               +
                               ` | //label[${labelMatch}]/following-sibling::*[${formControls}][1]`
                               +
                               ` | //label[${labelMatch}]/parent::*/following-sibling::*[1]/descendant::*[${formControls}]`
        } else {
            const labelMatch = `contains(.,${xpathStr})`
            xpath            = `//*[contains(@aria-label,${xpathStr})]`
                               +
                               ` | //*[@id=//label[${labelMatch}]/@for]`
                               +
                               ` | //label[${labelMatch}]/descendant::*[${formControls}]`
                               +
                               ` | //label[${labelMatch}]/following-sibling::*[${formControls}][1]`
                               +
                               ` | //label[${labelMatch}]/parent::*/following-sibling::*[1]/descendant::*[${formControls}]`
        }
    } else if ('placeholder' in target && target.placeholder) {
        const escaped = escapeAttrValue(target.placeholder)
        selector      = getExact(target) ? `[placeholder="${escaped}"]` : `[placeholder*="${escaped}"]`
    } else if ('title' in target && target.title) {
        const escaped = escapeAttrValue(target.title)
        selector      = getExact(target) ? `[title="${escaped}"]` : `[title*="${escaped}"]`
    } else if ('alt' in target && target.alt) {
        const escaped = escapeAttrValue(target.alt)
        selector      = getExact(target) ? `[alt="${escaped}"]` : `[alt*="${escaped}"]`
    } else if ('testId' in target && target.testId) {
        selector = `[data-testid="${escapeAttrValue(target.testId)}"]`
    }

    return { selector, text, xpath, nth: (target as { nth?: number }).nth }
}

