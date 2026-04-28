import { CookiesClearSchema, CookiesDeleteSchema, CookiesGetSchema, CookiesSetSchema } from '../types/schemas'

export class CookieHandler {
    async cookiesGet(params: unknown): Promise<chrome.cookies.Cookie[]> {
        const p = CookiesGetSchema.parse(params) ?? {}

        const filter: chrome.cookies.GetAllDetails = {}
        if (p.url) {
            filter.url = p.url
        }
        if (p.name) {
            filter.name = p.name
        }
        if (p.domain) {
            filter.domain = p.domain
        }
        if (p.path) {
            filter.path = p.path
        }
        if (p.secure !== undefined) {
            filter.secure = p.secure
        }
        if (p.session !== undefined) {
            filter.session = p.session
        }

        return await chrome.cookies.getAll(filter)
    }

    async cookiesSet(params: unknown): Promise<{ success: boolean }> {
        const p = CookiesSetSchema.parse(params)

        await chrome.cookies.set({
            url: p.url,
            name: p.name,
            value: p.value || '',
            domain: p.domain,
            path: p.path,
            secure: p.secure,
            httpOnly: p.httpOnly,
            sameSite: p.sameSite,
            expirationDate: p.expirationDate,
        })

        return { success: true }
    }

    async cookiesDelete(params: unknown): Promise<{ success: boolean }> {
        const p = CookiesDeleteSchema.parse(params)

        await chrome.cookies.remove({
            url: p.url,
            name: p.name,
        })

        return { success: true }
    }

    async cookiesClear(params: unknown): Promise<{ success: boolean; count: number }> {
        const p = CookiesClearSchema.parse(params) ?? {}

        // 二层校验：禁止无过滤清全站（避免误删用户登录态）
        if (!p.url && !p.domain && !p.name) {
            throw new Error('cookies action=clear 必须带 name/domain/url 至少一个过滤参数（项目规范）')
        }

        const filter: chrome.cookies.GetAllDetails = {}
        if (p.url) {
            filter.url = p.url
        }
        if (p.domain) {
            filter.domain = p.domain
        }
        if (p.name) {
            filter.name = p.name
        }

        const cookies = await chrome.cookies.getAll(filter)
        let count = 0

        for (const cookie of cookies) {
            const protocol = cookie.secure ? 'https:' : 'http:'
            // cookie.domain 可能有前导点（如 .example.com），需要去掉以构建有效 URL
            const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
            const url = `${protocol}//${domain}${cookie.path}`
            try {
                await chrome.cookies.remove({ url, name: cookie.name })
                count++
            } catch (err) {
                console.warn('[MCP] cookie 删除失败:', cookie.name, err)
            }
        }

        return { success: true, count }
    }
}
