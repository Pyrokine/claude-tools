/**
 * Action 处理器共享工具函数
 *
 * 纯工具函数，不依赖任何实例状态，可被多个 handler 模块直接 import 使用
 */

import { ExpectedOperationError } from '../types/expected-errors'

export interface ActionContext {
    mcpTabGroupId: number | null
    mcpWindowId: number | null
}

export function isRestrictedUrl(url: string | undefined): boolean {
    if (!url) {
        return true
    }
    return (
        url === 'about:blank' ||
        url.startsWith('about:') ||
        url.startsWith('chrome://') ||
        url.startsWith('chrome-extension://')
    )
}

export async function assertScriptable(tabId: number): Promise<void> {
    const tab = await chrome.tabs.get(tabId)
    if (isRestrictedUrl(tab.url)) {
        throw new ExpectedOperationError(
            `Cannot execute on restricted URL "${tab.url}". Navigate to an http/https page first.`
        )
    }
}

export async function getTargetTabId(tabId?: number): Promise<number> {
    if (tabId !== undefined && tabId !== null) {
        try {
            await chrome.tabs.get(tabId)
        } catch {
            throw new ExpectedOperationError(`Tab ${tabId} 不存在（可能已被关闭）`)
        }
        return tabId
    }

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!activeTab?.id) {
        throw new ExpectedOperationError('No active tab found')
    }
    return activeTab.id
}

/**
 * 递归计算 iframe 在页面坐标系中的偏移量
 *
 * 对于嵌套 iframe，递归累加各层偏移，
 * 当多个 iframe 共享同一 URL 时，优先按同 URL 的出现顺序匹配，
 * clientLeft/clientTop 补偿 iframe 的 border，确保坐标指向内容区域起点
 */
export async function getFrameOffset(tabId: number, frameId: number): Promise<{ x: number; y: number } | null> {
    const allFrames = await chrome.webNavigation.getAllFrames({ tabId })
    if (!allFrames) {
        return null
    }

    const targetFrame = allFrames.find((f) => f.frameId === frameId)
    if (!targetFrame || targetFrame.parentFrameId === -1) {
        return null
    }

    // 受限 URL 无法执行脚本获取偏移
    const tab = await chrome.tabs.get(tabId)
    if (isRestrictedUrl(tab.url)) {
        return null
    }

    // 递归获取父 frame 的偏移（嵌套 iframe 时需要累加）
    let parentOffset = { x: 0, y: 0 }
    if (targetFrame.parentFrameId !== 0) {
        const po = await getFrameOffset(tabId, targetFrame.parentFrameId)
        if (po) {
            parentOffset = po
        }
    }

    // 在父框架中找到同级 iframe，按 URL 和索引匹配目标
    const siblingFrames = allFrames.filter(
        (f) => f.parentFrameId === targetFrame.parentFrameId && f.frameId !== targetFrame.parentFrameId
    )
    const frameIndex = siblingFrames.findIndex((f) => f.frameId === frameId)
    const sameUrlFrames = siblingFrames.filter((f) => f.url === targetFrame.url)
    const sameUrlIndex = sameUrlFrames.findIndex((f) => f.frameId === frameId)

    const results = await chrome.scripting.executeScript({
        target: {
            tabId,
            frameIds: [targetFrame.parentFrameId],
        },
        world: 'MAIN',
        func: (frameUrl: string, frameIndex: number, sameUrlIndex: number) => {
            const iframes = Array.from(document.querySelectorAll('iframe, frame')) as HTMLIFrameElement[]

            const urlMatches = frameUrl ? iframes.filter((iframe) => iframe.src === frameUrl) : []
            let target: HTMLIFrameElement | undefined

            if (urlMatches.length === 1) {
                target = urlMatches[0]
            } else if (sameUrlIndex >= 0 && sameUrlIndex < urlMatches.length) {
                target = urlMatches[sameUrlIndex]
            } else if (frameIndex >= 0 && frameIndex < iframes.length) {
                target = iframes[frameIndex]
            } else if (urlMatches.length > 0) {
                target = urlMatches[0]
            }

            if (!target) {
                return null
            }
            const rect = target.getBoundingClientRect()
            return {
                x: rect.x + target.clientLeft,
                y: rect.y + target.clientTop,
            }
        },
        args: [targetFrame.url, frameIndex, sameUrlIndex],
    })

    const localOffset = results[0]?.result as { x: number; y: number } | null
    if (!localOffset) {
        return null
    }

    return {
        x: parentOffset.x + localOffset.x,
        y: parentOffset.y + localOffset.y,
    }
}
