/**
 * Extension 通信链路上的 typed Error,替代字符串匹配
 *
 * 用于 unified-session / http-server 在 Extension 断开 / 注入失败 / 协议异常时的 catch 分支判断
 */

export class ExtensionDisconnectedError extends Error {
    constructor(message = 'Extension disconnected') {
        super(message)
        this.name = 'ExtensionDisconnectedError'
    }
}

export class ExtensionNotConnectedError extends Error {
    constructor(message = 'Extension not connected') {
        super(message)
        this.name = 'ExtensionNotConnectedError'
    }
}

export class ExtensionScriptError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ExtensionScriptError'
    }
}

export class ExtensionRequestTimeoutError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ExtensionRequestTimeoutError'
    }
}

/** 判断是否是 Extension 断开类错误（含原 string-match 的兼容判断） */
export function isExtensionDisconnected(err: unknown): boolean {
    if (err instanceof ExtensionDisconnectedError) {
        return true
    }
    if (err instanceof Error) {
        return err.message.includes('Extension disconnected') || err.message.includes('Connection replaced')
    }
    return false
}
