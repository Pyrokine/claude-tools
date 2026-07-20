/**
 * MCP Chrome Extension - Content Script
 *
 * 主要功能通过 chrome.scripting.executeScript 在 background 中注入执行
 * 这里只做基础初始化
 */

export {}

// 初始化元素映射
declare global {
    interface Window {
        __mcpElementMap?: Record<string, WeakRef<Element>>
        __mcpRefCounter?: number
    }
}

window.__mcpElementMap = window.__mcpElementMap || {}
window.__mcpRefCounter = window.__mcpRefCounter || 0

window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; token?: string; index?: number } | null
    if (
        event.source !== window.parent ||
        data?.type !== 'mcp-frame-probe' ||
        typeof data.token !== 'string' ||
        data.token.length > 100 ||
        !Number.isInteger(data.index) ||
        (data.index ?? -1) < 0
    ) {
        return
    }

    const source = event.source as Window
    void chrome.runtime
        .sendMessage({ type: 'MCP_FRAME_PROBE', token: data.token, index: data.index })
        .then((response: { accepted?: boolean } | undefined) => {
            if (!response?.accepted) return
            source.postMessage({ type: 'mcp-frame-probe-ack', token: data.token, index: data.index }, '*')
        })
        .catch((error) => {
            console.warn('[MCP] iframe identity probe failed:', error instanceof Error ? error.message : String(error))
        })
})

console.log('[MCP] Content script loaded')
