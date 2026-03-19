/**
 * 浏览器启动器
 *
 * 负责启动 Chrome 浏览器进程并获取 CDP 端点
 */

import {ChildProcess, spawn} from 'child_process'
import {existsSync, mkdirSync} from 'fs'
import {homedir, platform} from 'os'
import {join} from 'path'
import {BrowserNotFoundError, TimeoutError} from '../core/errors.js'
import {DEFAULT_TIMEOUT, type LaunchOptions} from '../core/types.js'

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
        ...(process.env.LOCALAPPDATA
            ? [`${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`]
            : []),
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
    private _port: number                = 0

    get port(): number {
        return this._port
    }

    /**
     * 启动浏览器
     */
    async launch(options: LaunchOptions = {}): Promise<string> {
        const {
                  executablePath,
                  port      = 0,
                  incognito = false,
                  headless  = false,
                  userDataDir,
                  timeout   = DEFAULT_TIMEOUT,
              } = options

        // 查找 Chrome
        const chromePath = executablePath ?? findChrome()
        if (!chromePath) {
            throw new BrowserNotFoundError()
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
        port: number;
        incognito: boolean;
        headless: boolean;
        userDataDir?: string;
    }): string[] {
        const args = [
            `--remote-debugging-port=${options.port}`,
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
        // 确保目录存在
        if (!existsSync(userDataDir)) {
            mkdirSync(userDataDir, { recursive: true })
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

            this.process.stderr?.on('data', (data: Buffer) => {
                stderr += data.toString()

                // 解析 DevTools listening on ws://...
                const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/)
                if (match) {
                    clearTimeout(timer)
                    // 解析端口
                    const portMatch = match[1].match(/:(\d+)\//)
                    if (portMatch) {
                        this._port = parseInt(portMatch[1], 10)
                    }
                    resolve(match[1])
                }
            })

            this.process.on('error', (error: Error) => {
                clearTimeout(timer)
                reject(error)
            })

            this.process.on('exit', (code) => {
                clearTimeout(timer)
                if (code === 0) {
                    // Chrome 退出码 0：通常是把请求委托给了已运行的实例后自行退出，
                    // 此时没有 DevTools 端点可连接
                    reject(new Error(
                        '浏览器进程已退出（code 0），可能已有相同 profile 的 Chrome 实例在运行。\n'
                        + '请关闭已运行的 Chrome 或指定不同的 userDataDir',
                    ))
                } else if (code !== null) {
                    reject(new Error(`浏览器进程退出，代码: ${code}\n${stderr}`))
                }
            })
        })
    }
}
