/**
 * 浏览器启动器
 *
 * 负责启动 Chrome 浏览器进程并获取 CDP 端点
 */

import { ChildProcess, spawn, spawnSync } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { homedir, platform } from 'os'
import { join, win32 } from 'path'
import { BrowserNotFoundError, TimeoutError } from '../core/errors.js'
import { DEFAULT_TIMEOUT, type LaunchOptions } from '../core/types.js'

/**
 * 默认 profile 目录（固定路径，保留 cookies 和登录状态）
 */
const DEFAULT_PROFILE_DIR = join(homedir(), '.mcp-chrome', 'profile')

/**
 * Chrome 可执行文件的常见路径
 */
const CHROME_PATHS: Record<string, string[]> = {
    linux: [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
    ],
    darwin: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    win32: [],
}

/**
 * 查找 Chrome 可执行文件
 */
const WINDOWS_CHANNELS = [
    'Google\\Chrome\\Application\\chrome.exe',
    'Google\\Chrome Beta\\Application\\chrome.exe',
    'Google\\Chrome Dev\\Application\\chrome.exe',
    'Google\\Chrome SxS\\Application\\chrome.exe',
    'Chromium\\Application\\chrome.exe',
    'Google\\Chrome for Testing\\chrome-win64\\chrome.exe',
    'Google\\Chrome for Testing\\chrome-win32\\chrome.exe',
]

/** Windows App Paths is consulted by ShellExecute, not by Node spawn; query it explicitly. */
function readWindowsAppPaths(): string[] {
    const paths: string[] = []
    for (const hive of ['HKCU', 'HKLM']) {
        for (const view of ['32', '64']) {
            for (const name of ['chrome.exe', 'chromium.exe']) {
                const key = `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}`
                const result = spawnSync('reg.exe', ['query', key, '/ve', `/reg:${view}`], {
                    encoding: 'utf8',
                    windowsHide: true,
                    timeout: 2000,
                })
                if (result.status === 0) {
                    const value = result.stdout.match(/REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i)?.[1]?.trim()
                    if (value) {
                        paths.push(value.replace(/%([^%]+)%/g, (raw, key: string) => process.env[key] ?? raw))
                    }
                }
            }
        }
    }
    return paths
}

/** Injectable candidates keep Windows discovery testable without a Windows host. */
export function windowsChromeCandidates(
    env: NodeJS.ProcessEnv = process.env,
    registryPaths: string[] = readWindowsAppPaths()
): string[] {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(
        (value): value is string => !!value
    )
    const pathEntries = (env.Path ?? env.PATH ?? '').split(';').filter(Boolean)
    const portableRoots = [
        env.MCP_CHROME_PORTABLE_DIR,
        win32.join(env.USERPROFILE ?? homedir(), '.mcp-chrome', 'portable'),
    ].filter((value): value is string => !!value)
    return [
        ...registryPaths,
        ...pathEntries.flatMap((dir) => ['chrome.exe', 'chromium.exe'].map((name) => win32.join(dir, name))),
        ...roots.flatMap((root) => WINDOWS_CHANNELS.map((channel) => win32.join(root, channel))),
        ...portableRoots.flatMap((root) => [
            win32.join(root, 'chrome.exe'),
            win32.join(root, 'chrome-win64', 'chrome.exe'),
            win32.join(root, 'chrome-win32', 'chrome.exe'),
        ]),
    ]
}

export function findChrome(): string | null {
    const paths = platform() === 'win32' ? windowsChromeCandidates() : (CHROME_PATHS[platform()] ?? [])
    return paths.find((path) => existsSync(path)) ?? null
}

/**
 * 浏览器启动器
 */
export class BrowserLauncher {
    private process: ChildProcess | null = null
    private _port: number = 0

    get port(): number {
        return this._port
    }

    /**
     * 启动浏览器
     */
    async launch(options: LaunchOptions = {}): Promise<string> {
        const {
            executablePath,
            port = 0,
            incognito = false,
            headless = false,
            userDataDir,
            timeout = DEFAULT_TIMEOUT,
        } = options

        // 查找 Chrome
        const chromePath = executablePath ?? findChrome()
        if (!chromePath) {
            throw new BrowserNotFoundError()
        }

        // executablePath 校验：用户显式提供的路径必须存在且不在系统敏感目录
        if (executablePath) {
            if (!existsSync(executablePath)) {
                throw new Error(`executablePath 不存在: ${executablePath}`)
            }
            const lowered = executablePath.toLowerCase()
            const suspicious = ['/etc/', '/dev/', '/proc/', '/sys/', '/boot/']
            if (suspicious.some((p) => lowered.includes(p))) {
                console.warn(
                    `[launcher] 警告: executablePath 包含敏感系统目录前缀（${executablePath}），请确认路径正确`
                )
            }
        }

        // userDataDir 校验：警告非常用位置（避免误指向系统目录）
        if (userDataDir) {
            const lowered = userDataDir.toLowerCase()
            const home = homedir().toLowerCase()
            const tmp = ['/tmp/', '/var/tmp/']
            const isSafe = lowered.startsWith(home) || tmp.some((p) => lowered.startsWith(p))
            if (!isSafe) {
                console.warn(
                    `[launcher] 警告: userDataDir 不在常见位置（${userDataDir}），建议使用 ~/.mcp-chrome/ 或 /tmp/ 下的目录`
                )
            }
        }

        // 构建启动参数
        const args = this.buildArgs({ port, incognito, headless, userDataDir })

        // 启动进程
        this.process = spawn(chromePath, args, {
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        })

        // 等待 CDP 端点就绪
        return this.waitForEndpoint(timeout)
    }

    /**
     * 关闭浏览器
     */
    close(): void {
        if (this.process && !this.process.killed) {
            this.process.kill('SIGTERM')
            this.process = null
        }
    }

    /**
     * 构建启动参数
     */
    private buildArgs(options: {
        port: number
        incognito: boolean
        headless: boolean
        userDataDir?: string
    }): string[] {
        const args = [
            `--remote-debugging-port=${options.port}`,
            // 显式绑定到 loopback,防止 Chrome 在某些平台/版本默认监听全网卡造成端口暴露
            '--remote-debugging-address=127.0.0.1',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-breakpad',
            '--disable-component-extensions-with-background-pages',
            '--disable-component-update',
            '--disable-default-apps',
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--disable-features=TranslateUI',
            '--disable-hang-monitor',
            '--disable-ipc-flooding-protection',
            '--disable-popup-blocking',
            '--disable-prompt-on-repost',
            '--disable-renderer-backgrounding',
            '--disable-sync',
            '--enable-features=NetworkService,NetworkServiceInProcess',
            '--force-color-profile=srgb',
            '--metrics-recording-only',
            '--password-store=basic',
            '--use-mock-keychain',
        ]

        if (options.incognito) {
            args.push('--incognito')
        }

        if (options.headless) {
            args.push('--headless=new')
        }

        // 必须指定 user-data-dir，否则会复用已运行的 Chrome 实例导致启动失败
        // 默认使用固定目录 ~/.mcp-chrome/profile，保留 cookies 和登录状态
        const userDataDir = options.userDataDir ?? DEFAULT_PROFILE_DIR
        // 确保目录存在（mode 0o700 限制仅创建者可读）
        if (!existsSync(userDataDir)) {
            mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
        }
        args.push(`--user-data-dir=${userDataDir}`)

        // 打开一个空白页
        args.push('about:blank')

        return args
    }

    /**
     * 等待 CDP 端点就绪
     */
    private waitForEndpoint(timeout: number): Promise<string> {
        return new Promise((resolve, reject) => {
            if (!this.process) {
                reject(new Error('浏览器进程未启动'))
                return
            }

            let settled = false
            let stderr = ''
            let stderrLineBuffer = ''
            const stderrStream = this.process.stderr
            const timer = setTimeout(() => {
                fail(new TimeoutError(`等待浏览器启动超时 (${timeout}ms)`), true)
            }, timeout)

            const cleanup = () => {
                clearTimeout(timer)
                stderrStream?.removeListener('data', onStderr)
                this.process?.removeListener('error', onError)
                this.process?.removeListener('exit', onExit)
            }
            const finish = (url: string) => {
                if (settled) {
                    return
                }
                settled = true
                cleanup()
                resolve(url)
            }
            const fail = (error: Error, killProcess = false) => {
                if (settled) {
                    return
                }
                settled = true
                cleanup()
                if (killProcess && this.process && !this.process.killed) {
                    this.process.kill()
                    this.process = null
                }
                reject(error)
            }
            const onStderr = (data: Buffer) => {
                const chunk = data.toString()
                stderr += chunk
                stderrLineBuffer += chunk

                let newlineIndex = stderrLineBuffer.indexOf('\n')
                while (newlineIndex >= 0) {
                    const line = stderrLineBuffer.slice(0, newlineIndex).replace(/\r$/, '')
                    stderrLineBuffer = stderrLineBuffer.slice(newlineIndex + 1)
                    const match = line.match(/DevTools listening on (?<url>ws:\/\/\S+)\s*$/)
                    if (match) {
                        try {
                            const endpoint = new URL(match.groups!.url)
                            if (
                                endpoint.protocol === 'ws:' &&
                                endpoint.port &&
                                /^\/devtools\/browser\/[^/]+$/.test(endpoint.pathname)
                            ) {
                                this._port = parseInt(endpoint.port, 10)
                                finish(endpoint.href)
                                return
                            }
                        } catch {
                            // 忽略不完整或无效的 endpoint 行，继续等待下一条完整 stderr 行
                        }
                    }
                    newlineIndex = stderrLineBuffer.indexOf('\n')
                }
            }
            const onError = (error: Error) => {
                fail(error)
            }
            const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
                if (signal) {
                    fail(new Error(`浏览器进程收到信号 ${signal} 后退出\n${stderr}`))
                } else if (code === 0) {
                    // Chrome 退出码 0：通常是把请求委托给了已运行的实例后自行退出，
                    // 此时没有 DevTools 端点可连接
                    fail(
                        new Error(
                            '浏览器进程已退出（code 0），可能已有相同 profile 的 Chrome 实例在运行\n' +
                                '请关闭已运行的 Chrome 或指定不同的 userDataDir'
                        )
                    )
                } else if (code !== null) {
                    fail(new Error(`浏览器进程退出，代码: ${code}\n${stderr}`))
                }
            }

            stderrStream?.on('data', onStderr)
            this.process.on('error', onError)
            this.process.on('exit', onExit)
        })
    }
}
