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
        __mcpElementMap?: Record<string, WeakRef<Element>>;
        __mcpRefCounter?: number;
    }
}

;(window as Window).__mcpElementMap = (window as Window).__mcpElementMap || {}
;(window as Window).__mcpRefCounter = (window as Window).__mcpRefCounter || 0

console.log('[MCP] Content script loaded')
