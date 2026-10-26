/**
 * MCP Chrome Extension - Background Service Worker
 *
 * 负责：
 * 1. WebSocket 多连接管理（同时连接多个 MCP Server）
 * 2. 消息分发（按来源端口路由响应）
 * 3. Tab/TabGroup 管理
 */

import type { InternalMessage } from '../types'
import { isExpectedOperationError } from '../types/expected-errors'
import { recordDomFrameProbe } from './action-utils'
import { ActionHandler } from './actions'
import { HttpClient } from './http-client'
import { advancePageRevision, forgetPageRevision, getExistingTab } from './page-revision'
import { hasReadGrant, revokeReadGrants, revokeTabReadGrants, setReadGrant } from './read-grants'
import {
    getMcpTabGroupId,
    getMcpWindowId,
    restoreManagedTabs,
    setMcpTabGroupId,
    setMcpWindowId,
    unmarkManagedTab,
    updateManagedTabDocument,
    isManagedTab,
} from './tab-state'

// ==================== 全局状态 ====================

const httpClient = new HttpClient()
const actionHandler = new ActionHandler()
let connectionGeneration = 0
httpClient.onConnectionClosed((instanceId) => {
    void revokeReadGrants(instanceId).catch((error) => console.error('[MCP] Read grant cleanup failed:', error))
})

function sanitizeErrorMessage(message: string): string {
    return message.replace(/chrome-extension:\/\/[a-z0-9]{32}\/[^\s)"']*/g, 'chrome-extension://<redacted>/<redacted>')
}

function structuredErrorPayload(error: unknown): string | null {
    const json = (error as { toJSON?: () => object }).toJSON?.()
    if (!json) {
        return null
    }
    const body = json as { error?: { message?: unknown } }
    if (typeof body.error?.message === 'string') {
        body.error.message = sanitizeErrorMessage(body.error.message)
    }
    return JSON.stringify(body)
}

// ==================== WebSocket 消息处理 ====================

httpClient.onMessage(async (message, port) => {
    const { id, action, params } = message

    try {
        await restoreManagedTabs()
        const result = await actionHandler.execute(action, params, {
            mcpTabGroupId: getMcpTabGroupId(),
            mcpWindowId: getMcpWindowId(),
            serverInstanceId: httpClient.getServerInstanceId(port),
        })
        httpClient.sendResponse(id, true, result, undefined, port)
    } catch (error) {
        const rawMsg = error instanceof Error ? error.message : 'Unknown error'
        const msg = structuredErrorPayload(error) ?? sanitizeErrorMessage(rawMsg)
        // 预期的操作错误用 warn，不污染 Extension 错误面板
        if (isExpectedOperationError(error)) {
            console.warn(`[MCP] ${action}: ${rawMsg}`)
        } else {
            console.error(`[MCP] Error executing ${action}:`, error)
        }
        httpClient.sendResponse(id, false, null, msg, port)
    }
})

httpClient.onStatusChange((status, count) => {
    updateBadge(status, count)
    broadcastStatus(status, count)
})

// ==================== 内部消息处理 ====================

chrome.runtime.onMessage.addListener((message: InternalMessage, sender, sendResponse) => {
    handleInternalMessage(message, sender)
        .then(sendResponse)
        .catch((error) => sendResponse({ error: error instanceof Error ? error.message : String(error) }))
    return true // 异步响应
})

async function handleInternalMessage(message: InternalMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
    switch (message.type) {
        case 'CONNECT':
            return connectAfterRestore()

        case 'DISCONNECT':
            ++connectionGeneration
            httpClient.disconnect()
            return { success: true }

        case 'SET_PAIRING_TOKEN':
            await restoreManagedTabs()
            await httpClient.setPairingToken(message.token)
            return { success: true }

        case 'SET_ALLOW_INSECURE_NO_TOKEN':
            await restoreManagedTabs()
            await httpClient.setAllowInsecureNoToken(message.allow)
            return { success: true }

        case 'GET_STATUS': {
            await restoreManagedTabs()
            const servers = httpClient.getConnectedServers()
            const managed = Number.isSafeInteger(message.tabId) && isManagedTab({ id: message.tabId })
            const readAccess =
                Number.isSafeInteger(message.tabId) && !managed
                    ? await Promise.all(
                          servers.map(async (server) => ({
                              port: server.port,
                              allowed: await hasReadGrant(server.instanceId, message.tabId!),
                          }))
                      )
                    : []
            return {
                connected: httpClient.isConnected(),
                ports: httpClient.getConnectedPorts(),
                managed,
                readAccess,
                pairingTokenConfigured: await httpClient.hasPairingToken(),
                allowInsecureNoToken: await httpClient.isAllowInsecureNoToken(),
            }
        }

        case 'SET_READ_ACCESS': {
            if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('src/popup/popup.html')) {
                throw new Error('只读权限只能从 Extension popup 修改')
            }
            await restoreManagedTabs()
            if (
                !Number.isSafeInteger(message.tabId) ||
                !Number.isSafeInteger(message.port) ||
                typeof message.allow !== 'boolean'
            ) {
                throw new Error('tabId、port 或 allow 无效')
            }
            const instanceId = httpClient.getServerInstanceId(message.port)
            if (!instanceId) {
                throw new Error('目标 MCP Server 未连接或未提供连接身份')
            }
            const tab = await getExistingTab(message.tabId)
            const window = await chrome.windows.getLastFocused()
            if (tab.windowId !== window.id || !tab.active) {
                throw new Error('只能从 popup 授权当前窗口的活动页面')
            }
            if (isManagedTab(tab)) {
                throw new Error('受控页面无需普通只读授权')
            }
            await setReadGrant(instanceId, tab.id!, message.allow)
            return { success: true, allowed: message.allow }
        }

        case 'MCP_FRAME_PROBE':
            return recordDomFrameProbe(message, sender)

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
    chrome.runtime
        .sendMessage({
            type: 'STATUS_UPDATE',
            status,
            count,
        })
        .catch(() => {
            // Popup 可能未打开
        })
}

// ==================== Tab Group 管理 ====================

// MCP 专属窗口被关闭时重置（避免后续 newPage 再尝试复用已关闭的 windowId）
chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === getMcpWindowId()) {
        setMcpWindowId(null)
    }
})

// Tab 关闭时检查 TabGroup 是否为空，并清理 per-tab 状态
chrome.tabs.onRemoved.addListener(async (tabId) => {
    // 清理 ActionHandler 中的 per-tab 内存（防止长时间运行后内存泄漏）
    actionHandler.cleanupTab(tabId)
    forgetPageRevision(tabId)
    void revokeTabReadGrants(tabId).catch((error) => console.warn('[MCP] Read grant cleanup failed:', error))
    void unmarkManagedTab(tabId).catch((error) => {
        console.warn('[MCP] managed tab storage cleanup failed:', error)
    })

    const groupId = getMcpTabGroupId()
    if (groupId === null) {
        return
    }

    try {
        const tabs = await chrome.tabs.query({ groupId })
        if (tabs.length === 0) {
            setMcpTabGroupId(null)
        }
    } catch {
        setMcpTabGroupId(null)
    }
})

// 感知用户拖动 tab 到 MCP Chrome 分组
// Chrome 88+ 的 onUpdated 事件会在 tab 的 groupId 变化时触发
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const groupId = getMcpTabGroupId()
    if (groupId === null) {
        return
    }
    // changeInfo 包含 groupId（Chrome 88+），TypeScript 类型可能未声明
    const info = changeInfo as chrome.tabs.OnUpdatedInfo & { groupId?: number }
    if (info.groupId === groupId) {
        console.log(`[MCP] Tab ${tabId} joined MCP Chrome group`)
    }
})

// revision 仅追踪导航事件与 MCP 发起的动作，不观察页面自主的 DOM 变更
chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) {
        advancePageRevision(details.tabId)
        void updateManagedTabDocument(details.tabId).catch((error) =>
            console.warn('[MCP] Managed page document update failed:', error)
        )
        void revokeTabReadGrants(details.tabId).catch((error) =>
            console.warn('[MCP] Read grant navigation cleanup failed:', error)
        )
    }
})
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId === 0) {
        advancePageRevision(details.tabId)
        void revokeTabReadGrants(details.tabId).catch((error) =>
            console.warn('[MCP] Read grant navigation cleanup failed:', error)
        )
    }
})
chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
    if (details.frameId === 0) {
        advancePageRevision(details.tabId)
        void revokeTabReadGrants(details.tabId).catch((error) =>
            console.warn('[MCP] Read grant navigation cleanup failed:', error)
        )
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
        void connectAfterRestore().catch((error) => console.error('[MCP] Auto-connect failed:', error))
    }
})

// ==================== 自动连接 ====================

async function connectAfterRestore(): Promise<{ connected: number; ports: number[] }> {
    const requestedGeneration = connectionGeneration
    await restoreManagedTabs()
    if (requestedGeneration !== connectionGeneration) {
        return { connected: 0, ports: [] }
    }
    return httpClient.connect()
}

// Service Worker 启动即恢复权限，成功后才连接 MCP Server
void connectAfterRestore().catch((error) => console.error('[MCP] Auto-connect failed:', error))
