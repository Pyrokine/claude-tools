/**
 * MCP Chrome Extension 类型定义
 */

// ==================== Tab 相关 ====================

export interface TabInfo {
    id: number
    url: string
    title: string
    active: boolean
    windowId: number
    index: number
    groupId: number
    pinned: boolean
    incognito: boolean
    managed: boolean // 是否属于 MCP Chrome 分组
    status: string
}

export interface ManagedTabChangeResult {
    success: boolean
    targetId: string
    windowId: number
    before: TabInfo
    after: TabInfo | null
}

export interface ManagedWindowChangeResult {
    success: boolean
    windowId: number
    targetId?: string
    before?: WindowInfo | null
    after?: WindowInfo | null
}

export interface WindowInfo {
    id: number
    focused: boolean
    type: string
    state?: string
    incognito: boolean
    alwaysOnTop: boolean
    left?: number
    top?: number
    width?: number
    height?: number
    tabCount: number
    activeTabId?: number
    tabs: TabInfo[]
}

export interface TabGroupInfo {
    id: number
    title: string
    color: string
    windowId: number
    collapsed: boolean
}

export interface BrowserTopology {
    windowCount: number
    focusedWindowId?: number
    activeTargetId?: string
    windows: WindowInfo[]
    groups: TabGroupInfo[]
}

// ==================== 导航相关 ====================

export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle'

// ==================== 页面内容 ====================

export interface ReadPageResult {
    pageContent: string
    viewport: {
        width: number
        height: number
    }
    interactiveElements?: Array<{
        refId: string
        role: string
        name: string
        selector: string
        visible: boolean
        disabled: boolean
        bounds: { x: number; y: number; width: number; height: number }
        covered: boolean
        frameId?: number
    }>
    error?: string
}

export interface ScreenshotResult {
    data: string
    format: string
    degraded?: boolean
    fallback?: string
    limitations?: string[]
}

// ==================== DOM 操作 ====================

export interface ElementInfo {
    refId: string
    tag: string
    text: string
    rect: {
        x: number
        y: number
        width: number
        height: number
    }
}

// ==================== Cookies ====================

// ==================== Tab Groups ====================

// ==================== 内部消息 ====================

export interface StatusUpdateMessage {
    type: 'STATUS_UPDATE'
    status: 'connected' | 'disconnected' | 'connecting'
}

export interface ConnectMessage {
    type: 'CONNECT'
}

export interface DisconnectMessage {
    type: 'DISCONNECT'
}

export interface GetStatusMessage {
    type: 'GET_STATUS'
}

export interface SetPairingTokenMessage {
    type: 'SET_PAIRING_TOKEN'
    token: string
}

export interface SetAllowInsecureNoTokenMessage {
    type: 'SET_ALLOW_INSECURE_NO_TOKEN'
    allow: boolean
}

export interface FrameProbeMessage {
    type: 'MCP_FRAME_PROBE'
    token: string
    index: number
}

export type InternalMessage =
    | StatusUpdateMessage
    | ConnectMessage
    | DisconnectMessage
    | GetStatusMessage
    | SetPairingTokenMessage
    | SetAllowInsecureNoTokenMessage
    | FrameProbeMessage

// ==================== Debugger (CDP) 操作 ====================

export interface ConsoleMessage {
    /** 单个 tab 内单调递增，用于 diagnostics 增量读取 */
    sequence?: number
    source: string
    level: string
    text: string
    timestamp: number
    url?: string
    lineNumber?: number
}

export interface NetworkRequest {
    /** 单个 tab 内单调递增，用于 diagnostics 增量读取 */
    sequence?: number
    url: string
    method: string
    status?: number
    type: string
    timestamp: number
    duration?: number
    errorText?: string
    /** Cloudflare 响应头 cf-mitigated: challenge 的归一化结果 */
    challenge?: boolean
}
