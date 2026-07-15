export type VerificationStatus = 'not_requested' | 'matched' | 'mismatched' | 'skipped' | 'error'

export type TransferOutcome = {
    success: boolean
    transferSuccess: boolean
    verificationRequested: boolean
    verificationSuccess?: boolean
    verificationStatus: VerificationStatus
    failedChecks: string[]
    expected?: unknown
    actual?: unknown
}

function collectChecks(value: unknown, prefix: string, failed: string[], skipped: string[]): void {
    if (!value || typeof value !== 'object') {
        return
    }
    const record = value as Record<string, unknown>
    if (record.skipped === true) {
        skipped.push(prefix || 'verification')
    }
    if (record.checks && typeof record.checks === 'object') {
        for (const [name, matched] of Object.entries(record.checks as Record<string, unknown>)) {
            if (matched !== true) {
                failed.push(prefix ? `${prefix}.${name}` : name)
            }
        }
    }
    if ('hashMatch' in record && record.hashMatch !== true) {
        failed.push(prefix ? `${prefix}.sha256` : 'sha256')
    }
    for (const [name, child] of Object.entries(record)) {
        if (name === 'checks' || name === 'expected' || name === 'actual' || name === 'local' || name === 'remote') {
            continue
        }
        if (child && typeof child === 'object') {
            collectChecks(child, prefix ? `${prefix}.${name}` : name, failed, skipped)
        }
    }
}

export function buildTransferOutcome(
    transferSuccess: boolean,
    verificationRequested: boolean,
    verification?: Record<string, unknown>,
    verificationError?: unknown
): TransferOutcome {
    if (!verificationRequested) {
        return {
            success: transferSuccess,
            transferSuccess,
            verificationRequested: false,
            verificationStatus: 'not_requested',
            failedChecks: [],
        }
    }
    if (verificationError !== undefined) {
        return {
            success: false,
            transferSuccess,
            verificationRequested: true,
            verificationSuccess: false,
            verificationStatus: 'error',
            failedChecks: ['verification_error'],
        }
    }
    if (!transferSuccess && verification === undefined) {
        return {
            success: false,
            transferSuccess: false,
            verificationRequested: true,
            verificationSuccess: false,
            verificationStatus: 'skipped',
            failedChecks: ['verification'],
        }
    }
    const failedChecks: string[] = []
    const skipped: string[] = []
    collectChecks(verification, '', failedChecks, skipped)
    const verificationSuccess = skipped.length === 0 && failedChecks.length === 0
    return {
        success: transferSuccess && verificationSuccess,
        transferSuccess,
        verificationRequested: true,
        verificationSuccess,
        verificationStatus: skipped.length > 0 ? 'skipped' : verificationSuccess ? 'matched' : 'mismatched',
        failedChecks: skipped.length > 0 ? [...new Set([...failedChecks, ...skipped])] : [...new Set(failedChecks)],
        expected: verification?.expected,
        actual: verification?.actual ?? verification?.remote,
    }
}
