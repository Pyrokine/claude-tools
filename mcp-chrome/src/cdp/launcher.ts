/**
 * 浏览器启动器
 *
 * 负责启动 Chrome 浏览器进程并获取 CDP 端点
 */

import { ChildProcess, spawn } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
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
    win32: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ...(process.env.LOCALAPPDATA ? [`${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`] : []),
    ],
}

/**
 * 查找 Chrome 可执行文件
 */
export function findChrome(): string | null {
    const paths = CHROME_PATHS[platform()] ?? []

    for (const p of paths) {
        if (existsSync(p)) {
            return p
        }
    }

    return null
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

            const timer = setTimeout(() => {
                reject(new TimeoutError(`等待浏览器启动超时 (${timeout}ms)`))
            }, timeout)

            let stderr = ''
            const stderrStream = this.process.stderr

            const onStderr = (data: Buffer) => {
                stderr += data.toString()

                // 解析 DevTools listening on ws://...
                const match = stderr.match(/DevTools listening on (?<url>ws:\/\/\S+)/)
                if (match) {
                    clearTimeout(timer)
                    // 解析端口
                    const portMatch = match.groups!.url.match(/:(?<port>\d+)\//)
                    if (portMatch) {
                        this._port = parseInt(portMatch.groups!.port, 10)
                    }
                    // 端点已拿到，移除 listener 避免后续 stderr 持续累积内存
                    stderrStream?.removeListener('data', onStderr)
                    resolve(match.groups!.url)
                }
            }

            stderrStream?.on('data', onStderr)

            this.process.on('error', (error: Error) => {
                clearTimeout(timer)
                stderrStream?.removeListener('data', onStderr)
                reject(error)
            })

            this.process.on('exit', (code) => {
                clearTimeout(timer)
                stderrStream?.removeListener('data', onStderr)
                if (code === 0) {
                    // Chrome 退出码 0：通常是把请求委托给了已运行的实例后自行退出，
                    // 此时没有 DevTools 端点可连接
                    reject(
                        new Error(
                            '浏览器进程已退出（code 0），可能已有相同 profile 的 Chrome 实例在运行\n' +
                                '请关闭已运行的 Chrome 或指定不同的 userDataDir'
                        )
                    )
                } else if (code !== null) {
                    reject(new Error(`浏览器进程退出，代码: ${code}\n${stderr}`))
                }
            })
        })
    }
}
