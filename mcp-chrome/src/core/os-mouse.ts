/**
 * 系统级鼠标点击（Turnstile Cloudflare iframe）
 *
 * Linux: xdotool，目标坐标用当前 X11 活动窗口原点加窗口边距，且窗口标题必须对应该测试页，不使用 Chrome screenX
 * macOS: cliclick 沿路径移动后点击；没有则 osascript System Events
 * Windows: PowerShell SetCursorPos 沿路径移动后 mouse_event
 */
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { generateBezierPath, getMouseMoveDelay } from '../anti-detection/behavior.js'
import { sanitizeErrorMessage } from './error-sanitizer.js'
import { OsMouseError, TimeoutError } from './errors.js'
import { remainingNavigationTimeout, withNavigationBudget } from './utils.js'

const execFileDefault = promisify(execFileCallback)
const EXEC_TIMEOUT_MS = 5_000
const PATH_EXEC_TIMEOUT_MS = 15_000
const MAX_PATH_STEPS = 36
const MIN_PATH_STEPS = 12

export type ExecFileFn = (
    file: string,
    args: readonly string[],
    options?: { timeout?: number; signal?: AbortSignal }
) => Promise<{ stdout: string; stderr: string }>

export type SleepFn = (ms: number) => Promise<void>

export interface ViewportMetrics {
    screenX: number
    screenY: number
    innerWidth: number
    innerHeight: number
    outerWidth: number
    outerHeight: number
    devicePixelRatio: number
}

export interface ScreenClickPoint {
    x: number
    y: number
}

interface FocusedWindowGeometry extends ScreenClickPoint {
    width: number
    height: number
    insets: { left: number; right: number; bottom: number } | null
}

export type TurnstileClickSource = 'page' | 'iframe'

export interface TurnstileOsClickInput {
    clickPoint?: ScreenClickPoint | null
    screenPoint?: ScreenClickPoint | null
    viewport?: ViewportMetrics | null
    clickSource?: TurnstileClickSource | null
    clickTargetKind?: 'widget' | 'verify' | null
    title?: string | null
    url?: string
}

export type NativePointerProbe = () => Promise<{ position: ScreenClickPoint; since: number }>

export interface OsLeftClickDeps {
    deadline?: number
    signal?: AbortSignal
    platform?: NodeJS.Platform
    execFile?: ExecFileFn
    sleep?: SleepFn
    warn?: (message: string) => void
    from?: ScreenClickPoint
    path?: ScreenClickPoint[]
    refreshPoint?: (probe?: NativePointerProbe) => Promise<ScreenClickPoint>
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

function asInt(value: number): number {
    return Math.round(value)
}

function isEnoent(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

export function roundScreenPoint(x: number, y: number): ScreenClickPoint {
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
        throw new OsMouseError(
            'TURNSTILE_OS_CLICK_UNAVAILABLE',
            '无法把 Turnstile 点击坐标转换成屏幕坐标',
            '把受控测试页放到已经聚焦的窗口并保持该 tab 为活动页后重试；混合窗口不会调用 focusWindow',
            { x, y }
        )
    }
    return { x: asInt(x), y: asInt(y) }
}

export function chromeInsets(metrics: ViewportMetrics): { left: number; top: number } {
    const horizontal = Math.max(0, metrics.outerWidth - metrics.innerWidth)
    const vertical = Math.max(0, metrics.outerHeight - metrics.innerHeight)
    return {
        left: Math.round(horizontal / 2),
        top: Math.max(0, vertical - horizontal),
    }
}

export function asViewportMetrics(value: unknown): ViewportMetrics | null {
    if (!value || typeof value !== 'object') {
        return null
    }
    const record = value as Record<string, unknown>
    const screenX = record.screenX
    const screenY = record.screenY
    const innerWidth = record.innerWidth
    const innerHeight = record.innerHeight
    const outerWidth = record.outerWidth
    const outerHeight = record.outerHeight
    const devicePixelRatio = record.devicePixelRatio
    if (
        !isFiniteNumber(screenX) ||
        !isFiniteNumber(screenY) ||
        !isFiniteNumber(innerWidth) ||
        !isFiniteNumber(innerHeight) ||
        !isFiniteNumber(outerWidth) ||
        !isFiniteNumber(outerHeight) ||
        !isFiniteNumber(devicePixelRatio)
    ) {
        return null
    }
    return { screenX, screenY, innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio }
}

export function cssClientToScreen(
    point: ScreenClickPoint,
    metrics: ViewportMetrics,
    platform: NodeJS.Platform = process.platform
): ScreenClickPoint {
    const { left, top } = chromeInsets(metrics)
    let x = metrics.screenX + left + point.x
    let y = metrics.screenY + top + point.y
    if (platform === 'win32' && isFiniteNumber(metrics.devicePixelRatio) && metrics.devicePixelRatio > 0) {
        x *= metrics.devicePixelRatio
        y *= metrics.devicePixelRatio
    }
    return roundScreenPoint(x, y)
}

export function composeWindowClickPoint(
    clickPoint: ScreenClickPoint,
    metrics: ViewportMetrics,
    windowOrigin: FocusedWindowGeometry
): ScreenClickPoint {
    const scale = metrics.devicePixelRatio > 0 ? metrics.devicePixelRatio : 1
    const insets = windowOrigin.insets ?? { left: 0, right: 0, bottom: 0 }
    const contentWidth = windowOrigin.width - insets.left - insets.right
    const contentTop = windowOrigin.height - metrics.innerHeight * scale - insets.bottom
    if (
        Math.abs(contentWidth - metrics.innerWidth * scale) > 2 ||
        contentTop < 0 ||
        insets.left < 0 ||
        insets.right < 0 ||
        insets.bottom < 0
    ) {
        throw new OsMouseError(
            'TURNSTILE_OS_CLICK_UNAVAILABLE',
            'X11 窗口尺寸或边距与页面视口不符，拒绝系统鼠标点击',
            '重新检查受控页的窗口和缩放状态后再重试'
        )
    }
    return roundScreenPoint(
        windowOrigin.x + insets.left + clickPoint.x * scale,
        windowOrigin.y + contentTop + clickPoint.y * scale
    )
}

export function resolveScreenClickPoint(
    input: {
        clickPoint?: ScreenClickPoint | null
        screenPoint?: ScreenClickPoint | null
        viewport?: ViewportMetrics | null
    },
    platform: NodeJS.Platform = process.platform
): ScreenClickPoint {
    const viewport = input.viewport
    if (input.screenPoint && isFiniteNumber(input.screenPoint.x) && isFiniteNumber(input.screenPoint.y)) {
        if (platform === 'win32' && viewport) {
            const { left, top } = chromeInsets(viewport)
            return cssClientToScreen(
                {
                    x: input.screenPoint.x - viewport.screenX - left,
                    y: input.screenPoint.y - viewport.screenY - top,
                },
                viewport,
                platform
            )
        }
        return roundScreenPoint(input.screenPoint.x, input.screenPoint.y)
    }
    if (
        input.clickPoint &&
        viewport &&
        isFiniteNumber(input.clickPoint.x) &&
        isFiniteNumber(input.clickPoint.y) &&
        isFiniteNumber(viewport.screenX) &&
        isFiniteNumber(viewport.screenY) &&
        isFiniteNumber(viewport.innerWidth) &&
        isFiniteNumber(viewport.innerHeight) &&
        isFiniteNumber(viewport.outerWidth) &&
        isFiniteNumber(viewport.outerHeight)
    ) {
        return cssClientToScreen(input.clickPoint, viewport, platform)
    }
    throw new OsMouseError(
        'TURNSTILE_OS_CLICK_UNAVAILABLE',
        '无法把 Turnstile 点击坐标转换成屏幕坐标',
        '把受控测试页放到已经聚焦的窗口并保持该 tab 为活动页后重试；混合窗口不会调用 focusWindow'
    )
}

export function parseXdotoolShell(stdout: string): Record<string, string> {
    const result: Record<string, string> = {}
    for (const line of stdout.split(/\r?\n/)) {
        const sep = line.indexOf('=')
        if (sep <= 0) {
            continue
        }
        result[line.slice(0, sep)] = line.slice(sep + 1)
    }
    return result
}

function toolMissing(tool: string, suggestion: string): OsMouseError {
    return new OsMouseError('OS_MOUSE_UNAVAILABLE', `未找到系统鼠标工具 ${tool}`, suggestion, { tool })
}

function wrapExecError(tool: string, error: unknown, suggestion: string): OsMouseError | TimeoutError {
    if (error instanceof TimeoutError || error instanceof OsMouseError) {
        return error
    }
    if (isEnoent(error)) {
        return toolMissing(tool, suggestion)
    }
    const message = sanitizeErrorMessage(error)
    return new OsMouseError('OS_MOUSE_UNAVAILABLE', `系统鼠标点击失败: ${message}`, suggestion, { tool })
}

const CHROME_WINDOW_SUFFIX = /(?:^|[\s-])(?:google chrome(?: for testing)?|chromium(?:[- ]browser)?)$/i
const CHROME_TITLE_SUFFIX = /\s+-\s+(?:Google Chrome(?: for Testing)?|Chromium(?:[- ]Browser)?)$/i

export function isChromeWindowName(name: string): boolean {
    return CHROME_WINDOW_SUFFIX.test(name.trim())
}

export function windowNameMatchesPageTitle(windowName: string, pageTitle: string): boolean {
    const name = windowName.trim()
    const title = pageTitle.trim()
    if (!title || !isChromeWindowName(name)) {
        return false
    }
    return name.replace(CHROME_TITLE_SUFFIX, '').trim() === title
}

function pathStepCount(from: ScreenClickPoint, to: ScreenClickPoint): number {
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    return Math.min(MAX_PATH_STEPS, Math.max(MIN_PATH_STEPS, Math.floor(distance / 16)))
}

export function nearbyPathStart(target: ScreenClickPoint, from?: ScreenClickPoint | null): ScreenClickPoint {
    const local = roundScreenPoint(target.x - 72, target.y - 36)
    if (!from) {
        return local
    }
    if (Math.hypot(from.x - target.x, from.y - target.y) > 400) {
        return local
    }
    return roundScreenPoint(from.x, from.y)
}

export function buildOsMovePath(from: ScreenClickPoint, to: ScreenClickPoint): ScreenClickPoint[] {
    const start = roundScreenPoint(from.x, from.y)
    const end = roundScreenPoint(to.x, to.y)
    if (start.x === end.x && start.y === end.y) {
        return [end]
    }
    const raw = generateBezierPath(start, end, pathStepCount(start, end))
    const points = raw.map((point) => roundScreenPoint(point.x, point.y))
    const last = points[points.length - 1]
    if (!last || last.x !== end.x || last.y !== end.y) {
        points.push(end)
    }
    return points
}

function budgetedExecFile(execFile: ExecFileFn, deadline?: number, signal?: AbortSignal): ExecFileFn {
    return (file, args, options) =>
        withNavigationBudget(
            () =>
                execFile(file, args, {
                    ...options,
                    signal,
                    timeout:
                        deadline === undefined
                            ? options?.timeout
                            : Math.min(options?.timeout ?? EXEC_TIMEOUT_MS, remainingNavigationTimeout(deadline)),
                }),
            deadline,
            signal
        )
}

async function getLinuxPointer(execFile: ExecFileFn): Promise<ScreenClickPoint> {
    try {
        const { stdout } = await execFile('xdotool', ['getmouselocation', '--shell'], { timeout: EXEC_TIMEOUT_MS })
        const parsed = parseXdotoolShell(stdout)
        return roundScreenPoint(Number(parsed.X), Number(parsed.Y))
    } catch (error) {
        throw wrapExecError('xdotool', error, 'Linux 需要可用的 xdotool，且当前会话是 X11')
    }
}

export async function getFocusedWindowOrigin(
    deps: {
        platform?: NodeJS.Platform
        execFile?: ExecFileFn
        pageTitle?: string | null
        deadline?: number
        signal?: AbortSignal
    } = {}
): Promise<FocusedWindowGeometry> {
    deps.signal?.throwIfAborted()
    const platform = deps.platform ?? process.platform
    const execFile = budgetedExecFile(deps.execFile ?? execFileDefault, deps.deadline, deps.signal)
    const pageTitle = deps.pageTitle?.trim() ?? ''
    if (platform !== 'linux') {
        throw new OsMouseError(
            'OS_MOUSE_UNAVAILABLE',
            `当前平台 ${platform} 不使用 X11 窗口原点`,
            'Turnstile 系统鼠标在 Linux 上用 xdotool 读取聚焦窗口位置'
        )
    }
    if (!pageTitle) {
        throw new OsMouseError(
            'TURNSTILE_OS_CLICK_UNAVAILABLE',
            '缺少测试页标题，无法核对 X11 活动窗口',
            '先把只含该受控测试页的 Chrome 窗口聚焦，再重试；混合窗口不会调用 focusWindow'
        )
    }
    let windowId: string
    let windowName: string
    try {
        const activeWindow = await execFile('xdotool', ['getactivewindow'], { timeout: EXEC_TIMEOUT_MS })
        windowId = activeWindow.stdout.trim()
        if (!/^\d+$/.test(windowId)) {
            // noinspection ExceptionCaughtLocallyJS -- Report failure
            throw new Error('xdotool 返回了无效的活动窗口 ID')
        }
        const name = await execFile('xdotool', ['getwindowname', windowId], { timeout: EXEC_TIMEOUT_MS })
        windowName = name.stdout.trim()
    } catch (error) {
        throw wrapExecError('xdotool', error, 'Linux 需要可用的 xdotool，且当前会话是 X11')
    }
    if (!isChromeWindowName(windowName)) {
        throw new OsMouseError(
            'TURNSTILE_OS_CLICK_UNAVAILABLE',
            '当前 X11 活动窗口不是 Chrome，拒绝系统鼠标点击',
            '先把只含该受控测试页的 Chrome 窗口聚焦，再重试；混合窗口不会调用 focusWindow'
        )
    }
    if (!windowNameMatchesPageTitle(windowName, pageTitle)) {
        throw new OsMouseError(
            'TURNSTILE_OS_CLICK_UNAVAILABLE',
            '当前 X11 活动窗口不是该受控测试页，拒绝系统鼠标点击',
            '先把只含该受控测试页的 Chrome 窗口聚焦，再重试；混合窗口不会调用 focusWindow'
        )
    }
    let geometry: Record<string, string>
    try {
        const { stdout } = await execFile('xdotool', ['getwindowgeometry', '--shell', windowId], {
            timeout: EXEC_TIMEOUT_MS,
        })
        geometry = parseXdotoolShell(stdout)
    } catch (error) {
        throw wrapExecError('xdotool', error, 'Linux 需要可用的 xdotool，且当前会话是 X11')
    }
    const origin = roundScreenPoint(Number(geometry.X), Number(geometry.Y))
    const width = Number(geometry.WIDTH)
    const height = Number(geometry.HEIGHT)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new OsMouseError(
            'TURNSTILE_OS_CLICK_UNAVAILABLE',
            'X11 活动窗口缺少有效尺寸，拒绝系统鼠标点击',
            '重新检查受控页窗口后再重试'
        )
    }
    let frameProperties: string
    try {
        frameProperties = (
            await execFile('xprop', ['-id', windowId, '_GTK_FRAME_EXTENTS'], { timeout: EXEC_TIMEOUT_MS })
        ).stdout
    } catch (error) {
        throw wrapExecError('xprop', error, 'Linux 需要可用的 xprop 才能核对 X11 窗口边距')
    }
    const extents = frameProperties.match(
        /^_GTK_FRAME_EXTENTS\(CARDINAL\) = (?<left>\d+), (?<right>\d+), (?<top>\d+), (?<bottom>\d+)\s*$/m
    )
    if (!extents && !/^_GTK_FRAME_EXTENTS:\s+(?:not found\.|no such atom on any window\.)\s*$/m.test(frameProperties)) {
        throw new OsMouseError(
            'TURNSTILE_OS_CLICK_UNAVAILABLE',
            'X11 窗口边距无法核实，拒绝系统鼠标点击',
            '重新检查 xprop 和受控页窗口后再重试'
        )
    }
    return {
        ...origin,
        width,
        height,
        insets: extents ? { left: Number(extents[1]), right: Number(extents[2]), bottom: Number(extents[4]) } : null,
    }
}

export async function resolveTurnstileOsClickPoint(
    input: TurnstileOsClickInput,
    deps: { platform?: NodeJS.Platform; execFile?: ExecFileFn; deadline?: number; signal?: AbortSignal } = {}
): Promise<ScreenClickPoint> {
    deps.signal?.throwIfAborted()
    const platform = deps.platform ?? process.platform
    if (input.clickPoint && input.viewport) {
        const { x, y } = input.clickPoint
        const { innerWidth, innerHeight } = input.viewport
        if (!isFiniteNumber(x) || !isFiniteNumber(y) || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
            throw new OsMouseError(
                'TURNSTILE_OS_CLICK_UNAVAILABLE',
                'Turnstile 点击坐标不在当前页面视口内',
                '重新检查页面状态后再重试；系统鼠标不会点击受控测试页之外的位置',
                { x, y, innerWidth, innerHeight }
            )
        }
    }
    if (platform === 'linux' && input.clickPoint && input.viewport) {
        const origin = await getFocusedWindowOrigin({ ...deps, pageTitle: input.title })
        deps.signal?.throwIfAborted()
        return composeWindowClickPoint(input.clickPoint, input.viewport, origin)
    }
    return resolveScreenClickPoint(input, platform)
}

async function moveLinuxPath(
    path: ScreenClickPoint[],
    execFile: ExecFileFn,
    sleep: SleepFn,
    pressAndRelease?: (file: string, down: readonly string[], up: readonly string[]) => Promise<void>
): Promise<void> {
    try {
        for (const point of path) {
            await execFile('xdotool', ['mousemove', String(point.x), String(point.y)], {
                timeout: EXEC_TIMEOUT_MS,
            })
            await sleep(getMouseMoveDelay())
        }
        await sleep(80 + Math.random() * 80)
        if (pressAndRelease) {
            await pressAndRelease('xdotool', ['mousedown', '1'], ['mouseup', '1'])
        } else {
            await execFile('xdotool', ['click', '--delay', '80', '1'], { timeout: EXEC_TIMEOUT_MS })
        }
    } catch (error) {
        throw wrapExecError('xdotool', error, 'Linux 需要可用的 xdotool，且当前会话是 X11')
    }
}

async function clickDarwin(
    path: ScreenClickPoint[],
    execFile: ExecFileFn,
    warn: (message: string) => void,
    pressAndRelease?: (file: string, down: readonly string[], up: readonly string[]) => Promise<void>,
    beforeFallbackClick?: () => Promise<boolean>
): Promise<void> {
    const moves = path.map((point) => `m:${point.x},${point.y}`)
    try {
        await execFile('cliclick', ['-e', '12', ...moves, 'w:120', ...(pressAndRelease ? [] : ['c:.'])], {
            timeout: PATH_EXEC_TIMEOUT_MS,
        })
        if (pressAndRelease) {
            await pressAndRelease('cliclick', ['dd:.'], ['du:.'])
        }
        return
    } catch (error) {
        if (!isEnoent(error)) {
            throw wrapExecError('cliclick', error, 'macOS 需要辅助功能权限，或安装 cliclick')
        }
        warn('[MCP] macOS 未安装 cliclick，使用 osascript 完成点击，鼠标不会沿拟人路径移动')
    }
    if (beforeFallbackClick && !(await beforeFallbackClick())) {
        return
    }
    const end = path[path.length - 1]
    if (!end) {
        throw new OsMouseError(
            'TURNSTILE_OS_CLICK_UNAVAILABLE',
            '系统鼠标路径为空，无法点击',
            '把受控测试页放到已经聚焦的窗口并保持该 tab 为活动页后重试；混合窗口不会调用 focusWindow'
        )
    }
    try {
        await execFile('osascript', ['-e', `tell application "System Events" to click at {${end.x}, ${end.y}}`], {
            timeout: EXEC_TIMEOUT_MS,
        })
    } catch (error) {
        throw wrapExecError('osascript', error, 'macOS 需要辅助功能权限，或安装 cliclick 后重试')
    }
}

function windowsClickScript(path: ScreenClickPoint[], phase: 'click' | 'move' | 'down' | 'up' = 'click'): string {
    const moves = path.map(
        (point) => `[Win32.OsMouse]::SetCursorPos(${point.x}, ${point.y}); Start-Sleep -Milliseconds 8`
    )
    const memberDefinition = [
        '[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
        '[DllImport("user32.dll")] public static extern void mouse_event(',
        'uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);',
    ].join(' ')
    return [
        `Add-Type -MemberDefinition '${memberDefinition}' -Name OsMouse -Namespace Win32 -PassThru | Out-Null`,
        ...(phase === 'move' || phase === 'click' ? [...moves, 'Start-Sleep -Milliseconds 80'] : []),
        ...(phase === 'down' || phase === 'click' ? ['[Win32.OsMouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)'] : []),
        ...(phase === 'click' ? ['Start-Sleep -Milliseconds 50'] : []),
        ...(phase === 'up' || phase === 'click' ? ['[Win32.OsMouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)'] : []),
    ].join('; ')
}

async function clickWin32(
    path: ScreenClickPoint[],
    execFile: ExecFileFn,
    pressAndRelease?: (file: string, down: readonly string[], up: readonly string[]) => Promise<void>
): Promise<void> {
    try {
        await execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', windowsClickScript(path, pressAndRelease ? 'move' : 'click')],
            {
                timeout: PATH_EXEC_TIMEOUT_MS,
            }
        )
        if (pressAndRelease) {
            const args = ['-NoProfile', '-NonInteractive', '-Command']
            await pressAndRelease(
                'powershell.exe',
                [...args, windowsClickScript([], 'down')],
                [...args, windowsClickScript([], 'up')]
            )
        }
    } catch (error) {
        throw wrapExecError('powershell.exe', error, 'Windows 需要可用的 PowerShell，才能发送系统鼠标点击')
    }
}

async function resolveMovePath(
    target: ScreenClickPoint,
    deps: OsLeftClickDeps,
    execFile: ExecFileFn
): Promise<ScreenClickPoint[]> {
    if (deps.path && deps.path.length > 0) {
        return deps.path.map((point) => roundScreenPoint(point.x, point.y))
    }
    let from = deps.from
    if (!from && (deps.platform ?? process.platform) === 'linux') {
        from = await getLinuxPointer(execFile)
    }
    from = nearbyPathStart(target, from)
    return buildOsMovePath(from, target)
}

export async function osLeftClick(x: number, y: number, deps: OsLeftClickDeps = {}): Promise<void> {
    const point = roundScreenPoint(x, y)
    deps.signal?.throwIfAborted()
    const platform = deps.platform ?? process.platform
    const execFile = budgetedExecFile(deps.execFile ?? execFileDefault, deps.deadline, deps.signal)
    const sleep: SleepFn = (ms) =>
        withNavigationBudget(
            () =>
                deps.sleep
                    ? deps.sleep(
                          deps.deadline === undefined ? ms : Math.min(ms, remainingNavigationTimeout(deps.deadline))
                      )
                    : delay(ms, undefined, { signal: deps.signal }),
            deps.deadline,
            deps.signal
        )
    const beforePress = async (): Promise<boolean> => {
        if (!deps.refreshPoint) {
            return true
        }
        const probe: NativePointerProbe = async () => {
            const position = await getLinuxPointer(execFile)
            if (!position) {
                throw new OsMouseError('TURNSTILE_OS_CLICK_UNAVAILABLE', '无法读取当前原生指针', '检查 X11 指针状态')
            }
            const since = Date.now()
            const step = position.x > 0 ? -1 : 1
            await execFile('xdotool', ['mousemove_relative', '--', String(step), '0'], { timeout: EXEC_TIMEOUT_MS })
            await execFile('xdotool', ['mousemove_relative', '--', String(-step), '0'], { timeout: EXEC_TIMEOUT_MS })
            return { position, since }
        }
        const updated = await withNavigationBudget(
            () => deps.refreshPoint!(platform === 'linux' ? probe : undefined),
            deps.deadline,
            deps.signal
        )
        const refreshed = roundScreenPoint(updated.x, updated.y)
        if (refreshed.x === point.x && refreshed.y === point.y) {
            return true
        }
        await osLeftClick(refreshed.x, refreshed.y, { ...deps, from: point, path: undefined })
        return false
    }
    const pressAndRelease =
        deps.signal === undefined && !deps.refreshPoint
            ? undefined
            : async (file: string, down: readonly string[], up: readonly string[]): Promise<void> => {
                  if (!(await beforePress())) {
                      return
                  }
                  deps.signal?.throwIfAborted()
                  if (deps.deadline !== undefined) {
                      remainingNavigationTimeout(deps.deadline)
                  }
                  try {
                      await execFile(file, down, { timeout: EXEC_TIMEOUT_MS })
                      await sleep(50)
                  } finally {
                      // A dispatched press may have reached the OS even when its subprocess was cancelled.
                      await withNavigationBudget(
                          () => (deps.execFile ?? execFileDefault)(file, up, { timeout: EXEC_TIMEOUT_MS }),
                          Date.now() + EXEC_TIMEOUT_MS
                      ).catch((error: unknown) => {
                          throw new OsMouseError(
                              'OS_MOUSE_UNAVAILABLE',
                              `系统鼠标释放失败，按键状态未知: ${sanitizeErrorMessage(error)}`,
                              '检查系统鼠标按键状态，释放按键后再继续操作',
                              {
                                  tool: file,
                                  failureStage: 'release',
                                  releaseStatus: 'unknown',
                                  actionExecuted: 'unknown',
                                  actionStatus: 'unknown',
                                  retryable: false,
                              }
                          )
                      })
                  }
              }
    const warn = deps.warn ?? console.warn
    const path = await resolveMovePath(point, { ...deps, platform }, execFile)
    if (platform === 'linux') {
        await moveLinuxPath(path, execFile, sleep, pressAndRelease)
        return
    }
    if (platform === 'darwin') {
        await clickDarwin(path, execFile, warn, pressAndRelease, deps.refreshPoint ? beforePress : undefined)
        return
    }
    if (platform === 'win32') {
        await clickWin32(path, execFile, pressAndRelease)
        return
    }
    throw new OsMouseError(
        'OS_MOUSE_UNAVAILABLE',
        `当前平台 ${platform} 不支持系统鼠标点击`,
        'Turnstile 系统鼠标点击只支持 Linux、macOS 和 Windows',
        { platform }
    )
}
