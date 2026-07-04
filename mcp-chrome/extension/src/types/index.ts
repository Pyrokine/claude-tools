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

export interface TabsListParams {
    windowId?: number
    active?: boolean
}

export interface TabsCreateParams {
    url?: string
    active?: boolean
    windowId?: number
    groupId?: number
    waitUntil?: WaitUntil
    timeout?: number
}

export interface TabsCloseParams {
    tabId: number
}

export interface TabsActivateParams {
    tabId: number
}

export interface TabsAdoptParams {
    tabId: number
}

export interface TabsReleaseParams {
    tabId: number
}

export interface TabsMoveParams {
    tabId: number
    windowId?: number
    index?: number
    active?: boolean
}

export interface TabsReorderParams {
    tabId: number
    index: number
}

export interface TabsPinParams {
    tabId: number
    pinned: boolean
}

export type BrowserWindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen' | 'locked-fullscreen'

export interface WindowFocusParams {
    windowId: number
}

export interface WindowResizeParams {
    windowId: number
    left?: number
    top?: number
    width?: number
    height?: number
    state?: BrowserWindowState
}

export interface WindowCreateParams {
    url?: string
    focused?: boolean
    incognito?: boolean
    left?: number
    top?: number
    width?: number
    height?: number
    state?: BrowserWindowState
}

export interface WindowCloseParams {
    windowId: number
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

export interface NavigateParams {
    tabId?: number
    url: string
    waitUntil?: WaitUntil
    timeout?: number
}

export interface GoBackParams {
    tabId?: number
    waitUntil?: WaitUntil
    timeout?: number
}

export interface GoForwardParams {
    tabId?: number
    waitUntil?: WaitUntil
    timeout?: number
}

export interface ReloadParams {
    tabId?: number
    ignoreCache?: boolean
    waitUntil?: WaitUntil
    timeout?: number
}

// ==================== 页面内容 ====================

export type A11yFilter = 'all' | 'interactive' | 'visible'

export interface ReadPageParams {
    tabId?: number
    frameId?: number
    filter?: A11yFilter
    depth?: number
    maxLength?: number
    refId?: string
}

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

export interface ScreenshotParams {
    tabId?: number
    format?: 'png' | 'jpeg' | 'webp'
    quality?: number
    fullPage?: boolean
    scale?: number // 缩放比例（默认 1），低于 1 可降低分辨率加速全页截图
    clip?: { x: number; y: number; width: number; height: number }
}

export interface ScreenshotResult {
    data: string
    format: string
    degraded?: boolean
    fallback?: string
    limitations?: string[]
}

// ==================== DOM 操作 ====================

export interface ClickParams {
    tabId?: number
    frameId?: number
    refId: string
}

export interface TypeParams {
    tabId?: number
    frameId?: number
    refId: string
    text: string
    clear?: boolean
}

export interface ScrollParams {
    tabId?: number
    frameId?: number
    x?: number
    y?: number
    refId?: string
}

export interface EvaluateParams {
    tabId?: number
    frameId?: number
    code: string
}

export interface FindParams {
    tabId?: number
    frameId?: number
    selector?: string
    text?: string
    xpath?: string
}

export interface ResolveFrameParams {
    tabId?: number
    frame: string | number
}

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

export interface FrameInfo {
    index: number
    frameId: number
    parentFrameId: number
    url: string
    title?: string
    name?: string
    selector?: string
    rect?: { x: number; y: number; width: number; height: number }
}

// ==================== Cookies ====================

/**
 * chrome.cookies.getAll 支持的过滤参数
 */
export interface CookiesGetParams {
    url?: string
    name?: string
    domain?: string
    path?: string
    secure?: boolean
    session?: boolean
}

/**
 * chrome.cookies.set 支持的参数
 */
export interface CookiesSetParams {
    url: string
    name: string
    value?: string
    domain?: string
    path?: string
    secure?: boolean
    httpOnly?: boolean
    sameSite?: 'no_restriction' | 'lax' | 'strict' | 'unspecified'
    expirationDate?: number
}

/**
 * chrome.cookies.remove 需要的参数
 */
export interface CookiesDeleteParams {
    url: string
    name: string
}

/**
 * cookies clear 支持的过滤参数（复用 get 的过滤）
 */
export interface CookiesClearParams {
    url?: string
    domain?: string
    name?: string
}

// ==================== Tab Groups ====================

export type TabGroupColor = `${chrome.tabGroups.Color}`

export interface TabGroupCreateParams {
    tabIds: number[]
    title?: string
    color?: TabGroupColor
}

export interface TabGroupAddParams {
    tabId: number
    groupId?: number
}

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

export type InternalMessage =
    | StatusUpdateMessage
    | ConnectMessage
    | DisconnectMessage
    | GetStatusMessage
    | SetPairingTokenMessage

// ==================== Debugger (CDP) 操作 ====================

export interface DebuggerAttachParams {
    tabId?: number
}

export interface DebuggerDetachParams {
    tabId?: number
}

export interface DebuggerSendParams {
    tabId?: number
    method: string
    params?: Record<string, unknown>
}

export interface KeyEventParams {
    tabId?: number
    type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char'
    key?: string
    code?: string
    text?: string
    unmodifiedText?: string
    location?: number
    isKeypad?: boolean
    autoRepeat?: boolean
    windowsVirtualKeyCode?: number
    nativeVirtualKeyCode?: number
    modifiers?: number
    commands?: string[]
}

export interface MouseEventParams {
    tabId?: number
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel'
    x: number
    y: number
    button?: 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward'
    clickCount?: number
    deltaX?: number
    deltaY?: number
    modifiers?: number
}

export interface TouchEventParams {
    tabId?: number
    type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel'
    touchPoints: Array<{
        x: number
        y: number
        radiusX?: number
        radiusY?: number
        force?: number
        id?: number
    }>
    modifiers?: number
}

export interface ConsoleMessage {
    source: string
    level: string
    text: string
    timestamp: number
    url?: string
    lineNumber?: number
}

export interface NetworkRequest {
    url: string
    method: string
    status?: number
    type: string
    timestamp: number
    duration?: number
    errorText?: string
}
