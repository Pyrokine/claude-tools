/**
 * 转义 XPath 字符串字面量（处理包含引号的值）
 *
 * 例如: "It's a \"test\"" => concat('It', "'", 's a "test"')
 */
export function escapeXPathString(str: string): string {
    if (!str.includes("'")) {
        return `'${str}'`
    }
    if (!str.includes('"')) {
        return `"${str}"`
    }
    // 同时包含单双引号，使用 concat() 拼接
    const parts: string[] = []
    let current = ''
    for (const char of str) {
        if (char === "'") {
            if (current) {
                parts.push(`'${current}'`)
                current = ''
            }
            parts.push(`"'"`)
        } else {
            current += char
        }
    }
    if (current) {
        parts.push(`'${current}'`)
    }
    return `concat(${parts.join(', ')})`
}
