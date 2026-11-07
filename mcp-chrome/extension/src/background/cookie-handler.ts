import { ExpectedOperationError } from '../types/expected-errors'
import { CookiesClearSchema, CookiesDeleteSchema, CookiesGetSchema, CookiesSetSchema } from '../types/schemas'
import { type ActionContext, assertActionActive, assertManagedTab, assertReadableTab } from './action-utils'

interface CookieScope {
    targetId?: string
    storeId?: string
    browserContextId?: string
    partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean }
}

export class CookieHandler {
    async cookiesGet(params: unknown, context?: ActionContext): Promise<chrome.cookies.Cookie[]> {
        const p = CookiesGetSchema.parse(params) ?? {}
        if (![p.url, p.domain, p.name].some((value) => value !== undefined && value.trim().length > 0)) {
            throw new ExpectedOperationError(
                'cookies action=get 必须带 name/domain/url 至少一个过滤参数（避免读取全量 cookies）'
            )
        }
        const storeId = await this.resolveStore(p, context)
        if (context) {
            assertActionActive(context)
        }
        const filter: chrome.cookies.GetAllDetails = {
            ...(p.url ? { url: p.url } : {}),
            ...(p.name ? { name: p.name } : {}),
            ...(p.domain ? { domain: p.domain } : {}),
            ...(p.path ? { path: p.path } : {}),
            ...(p.secure !== undefined ? { secure: p.secure } : {}),
            ...(p.session !== undefined ? { session: p.session } : {}),
            ...(storeId !== undefined ? { storeId } : {}),
            ...(p.partitionKey !== undefined ? { partitionKey: p.partitionKey } : {}),
        }
        return chrome.cookies.getAll(filter)
    }

    async cookiesSet(params: unknown, context?: ActionContext): Promise<{ success: boolean }> {
        const p = CookiesSetSchema.parse(params)
        if (p.expirationDate !== undefined && p.expirationDate > 100_000_000_000) {
            throw new ExpectedOperationError('expirationDate 必须是 Unix 秒级时间戳，不能使用毫秒级 Date.now()')
        }
        const storeId = await this.resolveStore(p, context, true)
        if (context) {
            assertActionActive(context)
        }
        const cookie = await chrome.cookies.set({
            url: p.url,
            name: p.name,
            value: p.value || '',
            domain: p.domain,
            path: p.path,
            secure: p.secure,
            httpOnly: p.httpOnly,
            sameSite: p.sameSite,
            expirationDate: p.expirationDate,
            ...(storeId !== undefined ? { storeId } : {}),
            ...(p.partitionKey !== undefined ? { partitionKey: p.partitionKey } : {}),
        })
        if (!cookie) {
            throw new ExpectedOperationError(`cookie 设置失败: ${p.name} @ ${p.url}`)
        }
        return { success: true }
    }

    async cookiesDelete(params: unknown, context?: ActionContext): Promise<{ success: boolean }> {
        const p = CookiesDeleteSchema.parse(params)
        const storeId = await this.resolveStore(p, context, true)
        if (context) {
            assertActionActive(context)
        }
        await chrome.cookies.remove({
            url: p.url,
            name: p.name,
            ...(storeId !== undefined ? { storeId } : {}),
            ...(p.partitionKey !== undefined ? { partitionKey: p.partitionKey } : {}),
        })
        return { success: true }
    }

    async cookiesClear(params: unknown, context?: ActionContext): Promise<{ success: boolean; count: number }> {
        const p = CookiesClearSchema.parse(params) ?? {}
        if (!p.url && !p.domain) {
            throw new ExpectedOperationError(
                'cookies action=clear 必须带 url 或 domain 过滤参数，name 只能在该范围内进一步过滤（避免跨站误删同名 cookie）'
            )
        }
        const storeId = await this.resolveStore(p, context, true)
        if (context) {
            assertActionActive(context)
        }
        const cookies = await chrome.cookies.getAll({
            ...(p.url ? { url: p.url } : {}),
            ...(p.domain ? { domain: p.domain } : {}),
            ...(p.name ? { name: p.name } : {}),
            ...(storeId !== undefined ? { storeId } : {}),
            ...(p.partitionKey !== undefined ? { partitionKey: p.partitionKey } : {}),
        })
        let count = 0
        let failed = 0
        let attempted = 0
        try {
            for (const cookie of cookies) {
                if (context) {
                    assertActionActive(context)
                }
                const protocol = cookie.secure ? 'https:' : 'http:'
                const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
                ++attempted
                try {
                    const removed = await chrome.cookies.remove({
                        url: `${protocol}//${domain}${cookie.path}`,
                        name: cookie.name,
                        storeId: cookie.storeId,
                        ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
                    })
                    if (removed) {
                        ++count
                    } else {
                        ++failed
                    }
                } catch (error) {
                    ++failed
                    console.warn('[MCP] cookie 删除失败:', cookie.name, error)
                }
            }
            if (context) {
                assertActionActive(context)
            }
        } catch (error) {
            if (attempted === 0) {
                throw error
            }
            throw new ExpectedOperationError(
                JSON.stringify({
                    error: {
                        code: 'COOKIE_CLEAR_PARTIAL',
                        message: 'Cookie 清除已停止',
                        context: {
                            count,
                            failed,
                            attempted,
                            unprocessed: cookies.length - attempted,
                            cause: error instanceof Error ? error.message : String(error),
                            actionExecuted: true,
                            actionStatus: 'partial',
                            retryable: false,
                        },
                    },
                })
            )
        }
        if (failed) {
            throw new ExpectedOperationError(
                JSON.stringify({
                    error: {
                        code: 'COOKIE_CLEAR_PARTIAL',
                        message: '部分 Cookie 删除失败',
                        context: { count, failed, actionExecuted: true, retryable: false },
                    },
                })
            )
        }
        return { success: true, count }
    }

    private async resolveStore(
        scope: CookieScope,
        context?: ActionContext,
        write = false
    ): Promise<string | undefined> {
        if (context) {
            assertActionActive(context)
        }
        if (scope.browserContextId !== undefined) {
            throw new ExpectedOperationError('browserContextId 仅适用于 CDP，未操作 Cookie')
        }
        if (scope.targetId === undefined) {
            return scope.storeId
        }
        if (!/^\d+$/.test(scope.targetId) || !context) {
            throw new ExpectedOperationError('Cookie targetId 需要有效的页面与授权上下文，未操作')
        }
        const tabId = Number(scope.targetId)
        if (write) {
            await assertManagedTab(tabId, context, 'cookies_write')
        } else {
            await assertReadableTab(tabId, context, 'cookies_get')
        }
        assertActionActive(context)
        const stores = await chrome.cookies.getAllCookieStores()
        const matches = stores.filter((store) => store.tabIds.includes(tabId))
        if (matches.length !== 1 || (scope.storeId !== undefined && scope.storeId !== matches[0].id)) {
            throw new ExpectedOperationError('CookieStore 与目标页面不唯一或不一致，未操作 Cookie')
        }
        return matches[0].id
    }
}
