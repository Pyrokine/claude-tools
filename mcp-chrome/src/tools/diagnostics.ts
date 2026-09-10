import { sanitizeErrorMessage } from '../core/error-sanitizer.js'
import { formatErrorResponse, formatResponse, getUnifiedSession } from '../core/index.js'
import { sanitizeUrlRecords } from './network-sanitizer.js'

export type DiagnosticsStatus = 'disabled' | 'collected' | 'unavailable' | 'error'

interface DiagnosticsStart {
    consoleLastEntry?: string
    networkLastEntry?: string
}

export interface DiagnosticsResult {
    diagnosticsStatus: DiagnosticsStatus
    diagnostics?: Record<string, unknown>
    diagnosticsError?: string
}

function errorSummary(error: unknown): string {
    return sanitizeErrorMessage(error instanceof Error ? error.message : String(error)).slice(0, 500)
}

function entryMarker(entry: unknown): string {
    return JSON.stringify(entry)
}

function entriesSince<T>(entries: T[], lastEntry: string | undefined): { entries: T[]; truncated: boolean } {
    if (!lastEntry) {
        return { entries, truncated: false }
    }

    for (let index = entries.length - 1; index >= 0; --index) {
        if (entryMarker(entries[index]) === lastEntry) {
            return { entries: entries.slice(index + 1), truncated: false }
        }
    }

    // 旧 marker 已从环形缓冲淘汰，返回当前可用事件而不是伪装成没有增量
    return { entries, truncated: true }
}

export async function startDiagnostics(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    enabled: boolean | undefined
): Promise<{ start?: DiagnosticsStart; result: DiagnosticsResult }> {
    if (!enabled) {
        return { result: { diagnosticsStatus: 'disabled' } }
    }
    try {
        await unifiedSession.enableConsole()
        await unifiedSession.enableNetwork()
        const consoleLogs = await unifiedSession.getConsoleLogs()
        const network = await unifiedSession.getNetworkRequests()
        return {
            start: {
                consoleLastEntry: consoleLogs.length > 0 ? entryMarker(consoleLogs[consoleLogs.length - 1]) : undefined,
                networkLastEntry: network.length > 0 ? entryMarker(network[network.length - 1]) : undefined,
            },
            result: { diagnosticsStatus: 'collected' },
        }
    } catch (error) {
        return {
            result: {
                diagnosticsStatus: 'unavailable',
                diagnosticsError: errorSummary(error),
            },
        }
    }
}

export async function finishDiagnostics(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    started: { start?: DiagnosticsStart; result: DiagnosticsResult }
): Promise<DiagnosticsResult> {
    if (!started.start) {
        return started.result
    }
    try {
        const consoleLogs = await unifiedSession.getConsoleLogs()
        const network = await unifiedSession.getNetworkRequests()
        const consoleDelta = entriesSince(consoleLogs, started.start.consoleLastEntry)
        const networkDelta = entriesSince(network, started.start.networkLastEntry)
        return {
            diagnosticsStatus: 'collected',
            diagnostics: {
                console: sanitizeUrlRecords(
                    consoleDelta.entries.filter((item) => ['error', 'warning', 'warn'].includes(item.level)).slice(-20)
                ),
                failedRequests: sanitizeUrlRecords(
                    networkDelta.entries
                        .filter((item) => item.errorText || (item.status !== undefined && item.status >= 400))
                        .slice(-20)
                ),
                truncated: consoleDelta.truncated || networkDelta.truncated,
            },
        }
    } catch (error) {
        return {
            diagnosticsStatus: 'error',
            diagnosticsError: errorSummary(error),
        }
    }
}

export function appendDiagnostics(target: Record<string, unknown>, result: DiagnosticsResult): void {
    target.diagnosticsStatus = result.diagnosticsStatus
    if (result.diagnostics) {
        target.diagnostics = result.diagnostics
    }
    if (result.diagnosticsError) {
        target.diagnosticsError = result.diagnosticsError
    }
}

type ToolResponse = {
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
}

export function appendDiagnosticsToResponse(response: ToolResponse, result: DiagnosticsResult): void {
    const text = response.content[0]?.text
    if (!text) {
        return
    }

    try {
        const payload = JSON.parse(text) as Record<string, unknown>
        appendDiagnostics(payload, result)
        response.content[0].text = JSON.stringify(payload, null, 2)
    } catch {
        // 保留无法解析的原始响应
    }
}

export async function withDiagnosticsResponse<T extends Record<string, unknown>>(
    unifiedSession: ReturnType<typeof getUnifiedSession>,
    enabled: boolean | undefined,
    action: () => Promise<T>
): Promise<ToolResponse> {
    const diagnostics = await startDiagnostics(unifiedSession, enabled)
    try {
        const result = await action()
        appendDiagnostics(result, await finishDiagnostics(unifiedSession, diagnostics))
        return formatResponse(result)
    } catch (error) {
        const response = formatErrorResponse(error)
        appendDiagnosticsToResponse(response, await finishDiagnostics(unifiedSession, diagnostics))
        return response
    }
}
