/**
 * mcp-chrome 核心类型定义
 *
 * 设计原则：
 * - 以对象取代基本类型（《重构》§7.3）
 * - Target 对象统一元素定位方式
 */

/** 全局默认超时（毫秒） */
export const DEFAULT_TIMEOUT = 30000

/** 修饰键位掩码（CDP Input.dispatchKeyEvent/MouseEvent 的 modifiers 字段） */
export const MODIFIER_KEYS: Record<string, number> = {
    Alt: 1,
    Control: 2,
    Meta: 4,
    Shift: 8,
}

// ==================== CDP Runtime 响应类型 ====================

/** CDP Runtime.evaluate / callFunctionOn 响应中的异常详情 */
export interface CdpExceptionDetails {
    text: string
    exception?: { className?: string; description?: string }
}

/** CDP Runtime.evaluate / callFunctionOn 响应中的结果对象 */
export interface CdpResultObject<T = unknown> {
    type: string
    subtype?: string
    className?: string
    description?: string
    value?: T
    objectId?: string
}

/** 从 CDP exceptionDetails 提取有用的错误信息（含完整堆栈） */
export function formatCdpException(details: CdpExceptionDetails): string {
    return details.exception?.description ?? details.text ?? 'Unknown error'
}

function buildSerializationHint(result?: CdpResultObject): { message: string; suggestion: string } {
    const typeName = result?.className ?? result?.subtype ?? result?.type ?? 'unknown'
    const description = result?.description ? ` (${result.description.substring(0, 200)})` : ''
    const className = result?.className ?? ''

    if (result?.subtype === 'node' || /^(?:HTML|SVG).*Element$/.test(className) || className === 'Text') {
        return {
            message: `返回值是 DOM 节点 ${typeName}${description}，不能直接 JSON 序列化`,
            suggestion:
                '请返回 textContent、outerHTML、getAttribute(...) 等简单字段，或改用 extract type="text"/"html"',
        }
    }
    if (className === 'NodeList' || className === 'HTMLCollection') {
        return {
            message: `返回值是 ${className}${description}，不能直接 JSON 序列化`,
            suggestion: '请用 Array.from(value).map(...) 提取需要的字段，例如 textContent、href、outerHTML',
        }
    }
    return {
        message: `返回值类型 ${typeName}${description} 无法序列化`,
        suggestion: '请在脚本中返回 JSON 可序列化的简单类型，或将需要的属性提取为简单对象',
    }
}

export function isKnownNonSerializableRemoteObject(result?: CdpResultObject): boolean {
    const className = result?.className ?? ''
    return (
        result?.subtype === 'node' ||
        /^(?:HTML|SVG).*Element$/.test(className) ||
        className === 'Text' ||
        className === 'NodeList' ||
        className === 'HTMLCollection'
    )
}

export class NonSerializableEvaluateResultError extends Error {
    readonly code = 'NON_SERIALIZABLE_EVALUATE_RESULT'
    readonly suggestion: string
    readonly context: Record<string, unknown>

    constructor(result?: CdpResultObject) {
        const hint = buildSerializationHint(result)
        super(hint.message)
        this.name = 'NonSerializableEvaluateResultError'
        this.suggestion = hint.suggestion
        this.context = {
            type: result?.type,
            subtype: result?.subtype,
            className: result?.className,
            description: result?.description,
        }
    }

    toJSON(): object {
        return {
            error: {
                code: this.code,
                message: this.message,
                suggestion: this.suggestion,
                context: this.context,
            },
        }
    }
}

export type EvaluateMaterializeLimit = 'depth' | 'nodes' | 'chars'

function evaluateLimitMessage(limit: EvaluateMaterializeLimit): string {
    switch (limit) {
        case 'depth':
            return 'evaluate 返回对象层级过深，已停止展开 CDP 远端对象'
        case 'nodes':
            return 'evaluate 返回对象节点数过多，已停止展开 CDP 远端对象'
        case 'chars':
            return 'evaluate 返回内容过大，已停止展开 CDP 远端对象'
    }
}

function evaluateLimitSuggestion(limit: EvaluateMaterializeLimit): string {
    switch (limit) {
        case 'depth':
            return '请在脚本中返回扁平对象、指定字段，或先 JSON.stringify 深层对象再返回字符串'
        case 'nodes':
            return '请在脚本中减少返回字段、分页结果，或返回字符串并配合 output 写入文件'
        case 'chars':
            return '请在脚本中只返回必要字段、分页结果，或返回字符串并配合 output 写入文件'
    }
}

export class EvaluateResultTooLargeError extends Error {
    readonly code = 'EVALUATE_RESULT_TOO_LARGE'
    readonly suggestion: string

    constructor(readonly context: Record<string, unknown> & { exceeded: EvaluateMaterializeLimit }) {
        super(evaluateLimitMessage(context.exceeded))
        this.name = 'EvaluateResultTooLargeError'
        this.suggestion = evaluateLimitSuggestion(context.exceeded)
    }

    toJSON(): object {
        return {
            error: {
                code: this.code,
                message: this.message,
                suggestion: this.suggestion,
                context: this.context,
            },
        }
    }
}

/** 从 CDP result 提取返回值，不可序列化时抛出诊断错误 */
export function extractCdpValue<T>(result?: CdpResultObject<T>): T {
    if (!result || (result.value === undefined && result.type !== 'undefined')) {
        throw new NonSerializableEvaluateResultError(result)
    }
    return result.value as T
}

/**
 * 统一的元素定位目标
 *
 * 支持多种定位方式：
 * - 语义化定位（推荐，稳定性高）
 * - 传统定位（CSS/XPath）
 * - 坐标定位
 */
export type Target =
    // 语义化定位（推荐，参考 Playwright）
    | { role: string; name?: string; exact?: boolean } // 可访问性树：getByRole
    | { text: string; exact?: boolean } // 文本内容：getByText
    | { label: string; exact?: boolean } // 关联 label：getByLabel
    | { placeholder: string; exact?: boolean } // 占位符：getByPlaceholder
    | { title: string; exact?: boolean } // title 属性：getByTitle
    | { alt: string; exact?: boolean } // alt 属性：getByAltText
    | { testId: string } // data-testid：getByTestId
    // 传统定位
    | { css: string } // CSS 选择器
    | { css: string; text: string; exact?: boolean } // CSS + 文本组合
    | { xpath: string } // XPath
    // 坐标定位
    | { x: number; y: number } // 绝对坐标

/**
 * 坐标点
 */
export interface Point {
    x: number
    y: number
}

/**
 * 矩形区域
 */
export interface Box {
    x: number
    y: number
    width: number
    height: number
}

/**
 * 鼠标按钮类型（参考 Puppeteer，支持 5 种）
 */
export type MouseButton = 'left' | 'middle' | 'right' | 'back' | 'forward'

/**
 * 输入事件类型
 */
export type InputEventType =
    | 'keydown'
    | 'keyup'
    | 'click'
    | 'mousedown'
    | 'mouseup'
    | 'mousemove'
    | 'wheel'
    | 'touchstart'
    | 'touchmove'
    | 'touchend'
    | 'type'
    | 'wait'
    | 'select'
    | 'replace'
    | 'drag'
    | 'editorContext'
    | 'editorInsert'
    | 'editorCommand'

/**
 * 输入事件
 */
export interface InputEvent {
    type: InputEventType
    // 键盘参数
    key?: string
    commands?: string[]
    // 鼠标参数
    button?: MouseButton
    clickCount?: number
    target?: Target
    // 拖拽目标（drag 事件）
    to?: Target
    // 移动参数
    steps?: number
    // 滚轮参数
    deltaX?: number
    deltaY?: number
    // 输入文本参数
    text?: string
    delay?: number
    // 等待参数
    ms?: number
    // 查找文本参数（select/replace 事件）
    find?: string
    nth?: number
    // 编辑器命令参数（editorCommand 事件）
    command?: string
    // dispatch / controlled 模式（type 事件）
    dispatch?: boolean
    mode?: 'keyboard' | 'controlled'
    // 强制执行（click 事件）
    force?: boolean
    forceReason?: string
}

/**
 * 页面加载等待条件
 */
export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle'

/**
 * 元素状态
 */
export type ElementState = 'visible' | 'hidden' | 'attached' | 'detached'

/**
 * 缓存类型
 *
 * 不含 'cookies'：cookies 清除统一走 cookies action=clear（强制要求 name/domain/url 过滤）
 */
export type CacheType = 'all' | 'storage' | 'cache'

/**
 * Cookie SameSite 属性
 */
export type SameSite = 'Strict' | 'Lax' | 'None'

/**
 * Cookie 数据
 */
export interface Cookie {
    name: string
    value: string
    domain: string
    path: string
    expires: number
    size: number
    httpOnly: boolean
    secure: boolean
    session: boolean
    sameSite?: SameSite
}

/**
 * 页面状态
 */
export interface PageState {
    url: string
    title: string
    viewport: {
        width: number
        height: number
    }
    // 只返回可交互元素，不是完整 DOM
    elements: Array<{
        role: string
        name: string
        description?: string
        disabled?: boolean
        checked?: boolean
        value?: string
    }>
}

/**
 * 控制台日志条目
 */
export interface ConsoleLogEntry {
    source?: string
    level: string
    text: string
    timestamp: number
    url?: string
    lineNumber?: number
}

/**
 * 网络请求条目
 */
export interface NetworkRequestEntry {
    url: string
    method: string
    status?: number
    type: string
    timestamp: number
    duration?: number
    size?: number
    errorText?: string
}

/**
 * Target 信息（浏览器页面/tab）
 */
export interface TargetInfo {
    targetId: string
    type: string
    url: string
    title: string
    managed?: boolean
    /** 是否复用了已运行的浏览器（launch 时如果连接到已有浏览器则为 true） */
    reused?: boolean
}

/**
 * 反检测模式
 * - off: 关闭反检测（纯净模式，适合测试/CI）
 * - safe: 安全模式（最小改动，默认）
 * - aggressive: 激进模式（增加少量 WebGL/插件/语言指纹修补,不等于完整伪装）
 */
export type StealthMode = 'off' | 'safe' | 'aggressive'

/**
 * 启动选项
 */
export interface LaunchOptions {
    executablePath?: string
    port?: number
    incognito?: boolean
    headless?: boolean
    userDataDir?: string
    timeout?: number
    /** 反检测模式，默认 'safe' */
    stealth?: StealthMode
}

/**
 * 连接选项
 */
export interface ConnectOptions {
    host?: string
    port: number
    timeout?: number
    /** 反检测模式，默认 'safe' */
    stealth?: StealthMode
}

/**
 * 设备描述符
 */
export interface DeviceDescriptor {
    name: string
    viewport: {
        width: number
        height: number
        deviceScaleFactor: number
        isMobile: boolean
        hasTouch: boolean
    }
    userAgent: string
}

/**
 * 常用设备描述符
 */
export const devices: Record<string, DeviceDescriptor> = {
    'iPhone 13': {
        name: 'iPhone 13',
        viewport: {
            width: 390,
            height: 844,
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true,
        },
        userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) ' +
            'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
    },
    'iPhone 14': {
        name: 'iPhone 14',
        viewport: {
            width: 390,
            height: 844,
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true,
        },
        userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
            'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    },
    'iPad Pro': {
        name: 'iPad Pro',
        viewport: {
            width: 1024,
            height: 1366,
            deviceScaleFactor: 2,
            isMobile: true,
            hasTouch: true,
        },
        userAgent:
            'Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) ' +
            'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
    },
    'Pixel 5': {
        name: 'Pixel 5',
        viewport: {
            width: 393,
            height: 851,
            deviceScaleFactor: 2.75,
            isMobile: true,
            hasTouch: true,
        },
        userAgent:
            'Mozilla/5.0 (Linux; Android 11; Pixel 5) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36',
    },
}

/**
 * 判断 Target 类型的工具函数
 */
export function isRoleTarget(target: Target): target is { role: string; name?: string; exact?: boolean } {
    return 'role' in target
}

export function isTextTarget(target: Target): target is { text: string; exact?: boolean } {
    return 'text' in target && !('css' in target)
}

export function isLabelTarget(target: Target): target is { label: string; exact?: boolean } {
    return 'label' in target
}

export function isPlaceholderTarget(target: Target): target is { placeholder: string; exact?: boolean } {
    return 'placeholder' in target
}

export function isTitleTarget(target: Target): target is { title: string; exact?: boolean } {
    return 'title' in target
}

export function isAltTarget(target: Target): target is { alt: string; exact?: boolean } {
    return 'alt' in target
}

export function isTestIdTarget(target: Target): target is { testId: string } {
    return 'testId' in target
}

export function isCSSTextTarget(target: Target): target is { css: string; text: string; exact?: boolean } {
    return 'css' in target && 'text' in target
}

export function isCSSTarget(target: Target): target is { css: string } {
    return 'css' in target && !('text' in target)
}

export function isXPathTarget(target: Target): target is { xpath: string } {
    return 'xpath' in target
}

export function isCoordinateTarget(target: Target): target is { x: number; y: number } {
    return 'x' in target && 'y' in target
}
