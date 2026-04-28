/**
 * IBrowserDriver — 浏览器驱动抽象接口
 *
 * 定义 ExtensionBridge 和 SessionManager 的共同操作契约，
 * UnifiedSessionManager 通过此接口消除 Extension/CDP 双路分支
 *
 * 迁移完成：UnifiedSessionManager 通过 driver 屏蔽 Extension/CDP 差异，
 * 业务操作统一走 driver.X，状态管理（getDriver/ensureExtensionConnected）保留作为入口
 */

import type { ConsoleLogEntry, NetworkRequestEntry } from './types.js'

// ==================== 共享类型 ====================

export interface NavigateOptions {
    wait?: 'load' | 'domcontentloaded' | 'networkidle'
    timeout?: number
}

export interface GoBackResult {
    navigated: boolean
    url?: string
    title?: string
}

export interface ScreenshotOptions {
    fullPage?: boolean
    scale?: number
    format?: 'png' | 'jpeg' | 'webp' | string
    quality?: number
    clip?: { x: number; y: number; width: number; height: number }
}

export interface ScreenshotResult {
    data: string
    format: string
}

export interface ConsoleLogOptions {
    level?: string
    pattern?: string
    clear?: boolean
}

export interface NetworkRequestOptions {
    urlPattern?: string
    clear?: boolean
}

export interface CookieFilter {
    url?: string
    name?: string
    domain?: string
    path?: string
    secure?: boolean
    session?: boolean
}

export interface SetCookieParams {
    name: string
    value: string
    url?: string
    domain?: string
    path?: string
    httpOnly?: boolean
    secure?: boolean
    sameSite?: string
    expirationDate?: number
    session?: boolean
}

export interface FindResult {
    refId: string
    tag: string
    text: string
    rect: { x: number; y: number; width: number; height: number }
}

export interface ImageInfo {
    index: number
    src: string
    dataSrc: string
    alt: string
    width: number
    height: number
    naturalWidth: number
    naturalHeight: number
}

export interface HtmlWithImagesResult {
    html: string
    images: ImageInfo[]
}

export interface ReadPageResult {
    pageContent: string
    viewport: { width: number; height: number }
    error?: string
}

export interface ReadPageOptions {
    filter?: string
    depth?: number
    maxLength?: number
    refId?: string
}

export interface ActionableClickResult {
    success: boolean
    error?: string
    reason?: string
    coveringElement?: string
}

export interface DispatchInputResult {
    success: boolean
    error?: string
}

export interface DragAndDropResult {
    success: boolean
    error?: string
    code?: string
}

export interface InputKeyOptions {
    key?: string
    code?: string
    text?: string
    unmodifiedText?: string
    location?: number
    isKeypad?: boolean
    autoRepeat?: boolean
    windowsVirtualKeyCode?: number
    modifiers?: number
    commands?: string[]
}

export type InputKeyType = 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char'
export type InputMouseType = 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel'
export type InputTouchType = 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel'

export interface InputMouseOptions {
    button?: 'left' | 'middle' | 'right' | 'back' | 'forward' | 'none'
    clickCount?: number
    deltaX?: number
    deltaY?: number
    modifiers?: number
}

export interface InputTouchPoint {
    x: number
    y: number
    radiusX?: number
    radiusY?: number
    force?: number
    id?: number
}

export interface FrameResolveResult {
    frameId: number
    offset: { x: number; y: number } | null
}

export interface DriverState {
    url: string
    title: string
}

export interface ListedTarget {
    id: number | string
    targetId?: string
    url: string
    title: string
    type?: string
    active?: boolean
    windowId?: number
    index?: number
    groupId?: number
    pinned?: boolean
    incognito?: boolean
    managed?: boolean
    status?: string
}

export interface NewTabResult {
    targetId: string
    url: string
    title: string
    type?: string
}

// ==================== 接口定义 ====================

/**
 * 浏览器驱动接口
 *
 * 实现者：ExtensionBridge（bridge.ts），SessionManager（session.ts）
 * 消费者：UnifiedSessionManager（unified-session.ts）
 *
 * 设计约定：
 * - Extension 独有的能力（refId 操作、stealth、iframe、actionable、dispatch、drag/drop）
 *   在 CDP 实现里 throw（保持业务语义而非伪造结果）
 * - precise 输入接口（inputKey/inputMouse/inputTouch/inputType）两侧实现一致语义
 * - modifiers 由调用方维护并通过 options 传入，driver 不持有键盘修饰键状态
 */
export interface IBrowserDriver {
    // ---- 导航 ----
    navigate(url: string, options?: NavigateOptions): Promise<void>
    goBack(timeout?: number): Promise<GoBackResult>
    goForward(timeout?: number): Promise<GoBackResult>
    reload(ignoreCache?: boolean, waitUntil?: string, timeout?: number): Promise<void>

    // ---- 截图 ----
    screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult>

    // ---- 页面读取 ----
    readPage(options?: ReadPageOptions): Promise<ReadPageResult>
    getPageHtml(selector?: string, outer?: boolean): Promise<string>
    getPageText(selector?: string): Promise<string>
    getHtmlWithImages(selector?: string, outer?: boolean): Promise<HtmlWithImagesResult>
    getMetadata(): Promise<Record<string, unknown>>

    // ---- 元素查找 ----
    find(selector?: string, text?: string, xpath?: string, timeout?: number): Promise<FindResult[]>

    // ---- 元素操作（refId 类，仅 Extension 真实支持，CDP 实现 throw） ----
    /** Extension 真做；CDP throw（CDP 模式应通过 input 工具坐标点击） */
    click(refId: string): Promise<void>
    actionableClick(refId: string, force?: boolean): Promise<ActionableClickResult>
    dispatchInput(refId: string, text: string): Promise<DispatchInputResult>
    dragAndDrop(srcRefId: string, dstRefId: string): Promise<DragAndDropResult>
    getComputedStyle(refId: string, prop: string): Promise<string | null>
    typeRef(refId: string, text: string, clear?: boolean): Promise<void>
    scrollAt(x: number, y: number, refId?: string): Promise<void>
    getAttribute(selector: string | undefined, refId: string | undefined, attribute: string): Promise<string | null>

    // ---- 输入（precise） ----
    inputKey(type: InputKeyType, options?: InputKeyOptions): Promise<void>
    inputMouse(type: InputMouseType, x: number, y: number, options?: InputMouseOptions): Promise<void>
    inputTouch(type: InputTouchType, touchPoints: InputTouchPoint[]): Promise<void>
    inputType(text: string, delay?: number): Promise<void>

    // ---- Stealth (仅 Extension，CDP 实现 throw) ----
    stealthKey(key: string, type: 'down' | 'up' | 'press', modifiers: string[]): Promise<void>
    stealthClick(x: number, y: number, button?: string, clickCount?: number, refId?: string): Promise<void>
    stealthMouse(type: string, x: number, y: number, button?: string): Promise<void>
    stealthType(text: string, delay?: number): Promise<void>
    stealthInject(): Promise<void>

    // ---- Cookie ----
    getCookies(filter?: CookieFilter): Promise<
        Array<{
            name: string
            value: string
            domain: string
            path: string
            httpOnly: boolean
            secure: boolean
            sameSite?: string
            expirationDate?: number
            session?: boolean
        }>
    >
    setCookie(params: SetCookieParams): Promise<void>
    deleteCookie(url: string, name: string): Promise<void>
    /**
     * 清除 cookies，合同条款：filter 必须至少含 url/domain/name 中的一项,
     * 实现层应拒绝无过滤的全站清除（防止误清登录态）
     */
    clearCookies(filter?: CookieFilter): Promise<{ count: number }>

    // ---- 日志 ----
    consoleEnable(): Promise<void>
    networkEnable(): Promise<void>
    getConsoleLogs(options?: ConsoleLogOptions): Promise<ConsoleLogEntry[]>
    getNetworkRequests(options?: NetworkRequestOptions): Promise<NetworkRequestEntry[]>

    // ---- Tab / 状态 ----
    listTargets(): Promise<ListedTarget[]>
    newPage(url?: string, timeout?: number): Promise<NewTabResult>
    closePage(targetId?: string): Promise<void>
    activatePage(targetId: string): Promise<void>
    selectPage(targetId: string): Promise<void>
    getCurrentTargetId(): string | null
    setCurrentTargetId(targetId: string | null): void
    getState(): DriverState | null

    // ---- iframe（仅 Extension） ----
    /** 仅 Extension 模式支持；CDP throw */
    resolveFrame(frame: string | number): Promise<FrameResolveResult>
    getCurrentFrameId(): number
    setCurrentFrameId(frameId: number): void
    /**
     * 在指定 iframe 中执行 JS（precise 模式，Extension 通过 contextId 绕过 CSP），
     * CDP 实现 throw 'iframe 穿透需要 Extension 模式'
     */
    evaluateInFrame(
        frameId: number,
        expression: string,
        timeout?: number
    ): Promise<{
        result?: { value?: unknown }
        exceptionDetails?: { text: string; exception?: { className?: string; description?: string } }
    }>

    // ---- CDP 命令直通 ----
    /**
     * 发送 CDP 命令；
     * Extension：经 chrome.debugger.sendCommand 转发；
     * CDP：自动识别 browser-level 域（Target/Browser/SystemInfo/DeviceAccess/IO）走 sendBrowserCommand，其他走 send
     */
    debuggerSend(method: string, params?: Record<string, unknown>, tabId?: number, timeout?: number): Promise<unknown>

    // ---- 通用 evaluate ----
    /**
     * 执行 JS 代码（一次性调用），返回 JSON 反序列化的结果，
     * Extension stealth 路径：通过 chrome.scripting.executeScript（受 CSP 限制）；
     * Extension precise 路径：通过 debugger.Runtime.evaluate（绕 CSP）；
     * CDP：通过 Runtime.evaluate / callFunctionOn
     */
    evaluate(code: string, args?: unknown[], timeout?: number): Promise<unknown>
}

/** 类型守卫：判断是否为 Extension 实现 */
export interface IExtensionDriverExtras {
    /** Extension 模式特有：等待 WebSocket 重连 */
    waitForConnection(timeout?: number): Promise<boolean>
    /** Extension 模式特有：是否已连接 */
    isConnected(): boolean
    /** Extension 模式特有：当前 tabId（chrome tab 数字 ID） */
    getCurrentTabIdNumber?(): number | null
    /** Extension 模式特有：直接设置 tabId（绕过 attach） */
    setCurrentTabIdNumber?(tabId: number | null): void
}

// ==================== 通用错误 ====================

/**
 * 当某个接口能力在当前 driver 实现下不可用时抛出，
 * 上层 (UnifiedSessionManager) 据此分支 fallback 或转换错误信息
 */
export class DriverCapabilityError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'DriverCapabilityError'
    }
}
