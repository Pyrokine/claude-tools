/**
 * MCP Chrome Extension - Background Service Worker
 *
 * 负责：
 * 1. WebSocket 多连接管理（同时连接多个 MCP Server）
 * 2. 消息分发（按来源端口路由响应）
 * 3. Tab/TabGroup 管理
 */

import type {InternalMessage} from '../types'
import {ActionHandler} from './actions'
import {HttpClient} from './http-client'

// ==================== 全局状态 ====================

const httpClient    = new HttpClient()
const actionHandler = new ActionHandler()

// MCP 管理的 Tab Group ID
let mcpTabGroupId: number | null = null

// ==================== WebSocket 消息处理 ====================

httpClient.onMessage(async (message, port) => {
    const { id, action, params } = message

    try {
        const result = await actionHandler.execute(action, params, { mcpTabGroupId })
        httpClient.sendResponse(id, true, result, undefined, port)
    } catch (error) {
        console.error(`[MCP] Error executing ${action}:`, error)
        httpClient.sendResponse(id, false, null, error instanceof Error ? error.message : 'Unknown error', port)
    }
})

httpClient.onStatusChange((status, count) => {
    updateBadge(status, count)
    broadcastStatus(status, count)
})

// ==================== 内部消息处理 ====================

chrome.runtime.onMessage.addListener((message: InternalMessage, _sender, sendResponse) => {
    handleInternalMessage(message).then(sendResponse)
    return true // 异步响应
})

async function handleInternalMessage(message: InternalMessage): Promise<unknown> {
    switch (message.type) {
        case 'CONNECT':
            return httpClient.connect()

        case 'DISCONNECT':
            httpClient.disconnect()
            return { success: true }

        case 'GET_STATUS':
            return {
                connected: httpClient.isConnected(),
                ports: httpClient.getConnectedPorts(),
            }

        default:
            return { error: 'Unknown message type' }
    }
}

// ==================== Badge 更新 ====================

type ConnectionStatus = 'connected' | 'disconnected' | 'connecting'

function updateBadge(status: ConnectionStatus, count = 0) {
    const colors: Record<ConnectionStatus, string> = {
        connected: '#4CAF50',
        disconnected: '#9E9E9E',
        connecting: '#FFC107',
    }

    let badge: string
    if (status === 'connected') {
        badge = count > 1 ? String(count) : '✓'
    } else if (status === 'connecting') {
        badge = '…'
    } else {
        badge = ''
    }

    void chrome.action.setBadgeBackgroundColor({ color: colors[status] })
    void chrome.action.setBadgeText({ text: badge })
}

function broadcastStatus(status: ConnectionStatus, count: number) {
    chrome.runtime.sendMessage({
                                   type: 'STATUS_UPDATE',
                                   status,
                                   count,
                               }).catch(() => {
        // Popup 可能未打开
    })
}

// ==================== Tab Group 管理 ====================

// 导出供 ActionHandler 使用
export function setMcpTabGroupId(groupId: number | null) {
    mcpTabGroupId = groupId
}

// Tab 关闭时检查 TabGroup 是否为空
chrome.tabs.onRemoved.addListener(async (_tabId) => {
    if (mcpTabGroupId === null) {
        return
    }

    try {
        const tabs = await chrome.tabs.query({ groupId: mcpTabGroupId })
        if (tabs.length === 0) {
            mcpTabGroupId = null
        }
    } catch {
        mcpTabGroupId = null
    }
})

// 感知用户拖动 tab 到 MCP Chrome 分组
// Chrome 88+ 的 onUpdated 事件会在 tab 的 groupId 变化时触发
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (mcpTabGroupId === null) {
        return
    }
    // changeInfo 包含 groupId（Chrome 88+），TypeScript 类型可能未声明
    const info = changeInfo as chrome.tabs.TabChangeInfo & { groupId?: number }
    if (info.groupId === mcpTabGroupId) {
        console.log(`[MCP] Tab ${tabId} joined MCP Chrome group`)
    }
})

// ==================== Keep-Alive 机制 ====================

// 使用 chrome.alarms 定期唤醒 Service Worker 并保持连接
// 这样即使用户长时间不使用，下次打开时也能立即可用
const KEEPALIVE_ALARM = 'mcp-keepalive'

// chrome.alarms 最小周期为 1 分钟（Chrome 强制限制）
// WebSocket 心跳（15s ping）已能保持 Service Worker 存活，alarm 仅作断线重连备份
void chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 })

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM) {
        // 定期全量扫描：发现新 Server 或重连断开的
        void httpClient.connect()
    }
})

// ==================== 自动连接 ====================

// Service Worker 启动时立即尝试连接所有 MCP Server
setTimeout(() => {
    void httpClient.connect()
}, 500)
