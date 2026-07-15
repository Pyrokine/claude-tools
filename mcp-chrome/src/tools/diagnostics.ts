import { sanitizeErrorMessage } from '../core/error-sanitizer.js'
import { formatErrorResponse, formatResponse, getUnifiedSession } from '../core/index.js'

export type DiagnosticsStatus = 'disabled' | 'collected' | 'unavailable' | 'error'

interface DiagnosticsStart {
    consoleCount: number
    networkCount: number
}

export interface DiagnosticsResult {
    diagnosticsStatus: DiagnosticsStatus
    diagnostics?: Record<string, unknown>
    diagnosticsError?: string
}

function errorSummary(error: unknown): string {
    return sanitizeErrorMessage(error instanceof Error ? error.message : String(error)).slice(0, 500)
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
            start: { consoleCount: consoleLogs.length, networkCount: network.length },
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
        return {
            diagnosticsStatus: 'collected',
            diagnostics: {
                console: consoleLogs
                    .slice(started.start.consoleCount)
                    .filter((item) => ['error', 'warning', 'warn'].includes(item.level))
                    .slice(-20),
                failedRequests: network
                    .slice(started.start.networkCount)
                    .filter((item) => item.errorText || (item.status !== undefined && item.status >= 400))
                    .slice(-20),
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
    if (!text) return

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
