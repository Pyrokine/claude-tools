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
    Alt: 1, Control: 2, Meta: 4, Shift: 8,
}

// ==================== CDP Runtime 响应类型 ====================

/** CDP Runtime.evaluate / callFunctionOn 响应中的异常详情 */
export interface CdpExceptionDetails {
    text: string;
    exception?: { className?: string; description?: string };
}

/** CDP Runtime.evaluate / callFunctionOn 响应中的结果对象 */
export interface CdpResultObject<T = unknown> {
    type: string;
    subtype?: string;
    className?: string;
    description?: string;
    value?: T;
}

/** 从 CDP exceptionDetails 提取有用的错误信息（含完整堆栈） */
export function formatCdpException(details: CdpExceptionDetails): string {
    return details.exception?.description ?? details.text ?? 'Unknown error'
}

/** 从 CDP result 提取返回值，不可序列化时抛出诊断错误 */
export function extractCdpValue<T>(result?: CdpResultObject<T>): T {
    if (!result || (result.value === undefined && result.type !== 'undefined')) {
        const typeName = result?.className ?? result?.subtype ?? result?.type ?? 'unknown'
        const preview  = result?.description ? ` (${result.description.substring(0, 200)})` : ''
        throw new Error(
            `返回值类型 ${typeName}${preview} 无法序列化。` +
            '请在脚本中用 JSON.stringify() 包装返回值，或将需要的属性提取为简单类型',
        )
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
    | { role: string; name?: string } // 可访问性树：getByRole
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
    | { x: number; y: number }; // 绝对坐标

/**
 * 坐标点
 */
export interface Point {
    x: number;
    y: number;
}

/**
 * 矩形区域
 */
export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * 鼠标按钮类型（参考 Puppeteer，支持 5 种）
 */
export type MouseButton = 'left' | 'middle' | 'right' | 'back' | 'forward';

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
    | 'replace';

/**
 * 输入事件
 */
export interface InputEvent {
    type: InputEventType;
    // 键盘参数
    key?: string;
    // 鼠标参数
    button?: MouseButton;
    target?: Target;
    // 移动参数
    steps?: number;
    // 滚轮参数
    deltaX?: number;
    deltaY?: number;
    // 输入文本参数
    text?: string;
    delay?: number;
    // 等待参数
    ms?: number;
    // 查找文本参数（select/replace 事件）
    find?: string;
    nth?: number;
}

/**
 * 页面加载等待条件
 */
export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle';

/**
 * 元素状态
 */
export type ElementState = 'visible' | 'hidden' | 'attached' | 'detached';

/**
 * 缓存类型
 */
export type CacheType = 'all' | 'cookies' | 'storage' | 'cache';

/**
 * Cookie SameSite 属性
 */
export type SameSite = 'Strict' | 'Lax' | 'None';

/**
 * Cookie 选项
 */
export interface CookieOptions {
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: SameSite;
}

/**
 * Cookie 数据
 */
export interface Cookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    size: number;
    httpOnly: boolean;
    secure: boolean;
    session: boolean;
    sameSite?: SameSite;
}

/**
 * 页面状态
 */
export interface PageState {
    url: string;
    title: string;
    viewport: {
        width: number;
        height: number;
    };
    // 只返回可交互元素，不是完整 DOM
    elements: Array<{
        role: string;
        name: string;
        description?: string;
        disabled?: boolean;
        checked?: boolean;
        value?: string;
    }>;
}

/**
 * 控制台日志条目
 */
export interface ConsoleLogEntry {
    level: string;
    text: string;
    timestamp: number;
    url?: string;
    lineNumber?: number;
}

/**
 * 网络请求条目
 */
export interface NetworkRequestEntry {
    url: string;
    method: string;
    status?: number;
    type: string;
    timestamp: number;
    duration?: number;
    size?: number;
}

/**
 * Target 信息（浏览器页面/tab）
 */
export interface TargetInfo {
    targetId: string;
    type: string;
    url: string;
    title: string;
    /** 是否复用了已运行的浏览器（launch 时如果连接到已有浏览器则为 true） */
    reused?: boolean;
}

/**
 * 反检测模式
 * - off: 关闭反检测（纯净模式，适合测试/CI）
 * - safe: 安全模式（最小改动，默认）
 * - aggressive: 激进模式（完整伪装，可能有副作用）
 */
export type StealthMode = 'off' | 'safe' | 'aggressive';

/**
 * 启动选项
 */
export interface LaunchOptions {
    executablePath?: string;
    port?: number;
    incognito?: boolean;
    headless?: boolean;
    userDataDir?: string;
    timeout?: number;
    /** 反检测模式，默认 'safe' */
    stealth?: StealthMode;
}

/**
 * 连接选项
 */
export interface ConnectOptions {
    host?: string;
    port: number;
    timeout?: number;
    /** 反检测模式，默认 'safe' */
    stealth?: StealthMode;
}

/**
 * 设备描述符
 */
export interface DeviceDescriptor {
    name: string;
    viewport: {
        width: number;
        height: number;
        deviceScaleFactor: number;
        isMobile: boolean;
        hasTouch: boolean;
    };
    userAgent: string;
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
            'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
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
            'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
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
            'Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
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
            'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36',
    },
}

/**
 * 判断 Target 类型的工具函数
 */
export function isRoleTarget(
    target: Target,
): target is { role: string; name?: string } {
    return 'role' in target
}

export function isTextTarget(
    target: Target,
): target is { text: string; exact?: boolean } {
    return 'text' in target && !('css' in target)
}

export function isLabelTarget(
    target: Target,
): target is { label: string; exact?: boolean } {
    return 'label' in target
}

export function isPlaceholderTarget(
    target: Target,
): target is { placeholder: string; exact?: boolean } {
    return 'placeholder' in target
}

export function isTitleTarget(
    target: Target,
): target is { title: string; exact?: boolean } {
    return 'title' in target
}

export function isAltTarget(
    target: Target,
): target is { alt: string; exact?: boolean } {
    return 'alt' in target
}

export function isTestIdTarget(
    target: Target,
): target is { testId: string } {
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

export function isCoordinateTarget(
    target: Target,
): target is { x: number; y: number } {
    return 'x' in target && 'y' in target
}
