import { randomBytes, randomUUID } from 'node:crypto'
import type { ClientChannel } from 'ssh2'
import type {
    OperationCancelResult,
    OperationInfo,
    OperationReadResult,
    OperationStartOptions,
    OperationStatus,
} from './types.js'

export const DEFAULT_OPERATION_MAX_OUTPUT_BYTES = 1024 * 1024
export const HARD_OPERATION_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
export const DEFAULT_OPERATION_READ_BYTES = 64 * 1024
export const HARD_OPERATION_READ_BYTES = 1024 * 1024
export const DEFAULT_OPERATION_RETENTION_MS = 60 * 60_000
export const MAX_OPERATION_RETENTION_MS = 24 * 60 * 60_000

const MARKER_PREFIX = '__MCP_SSH_OPERATION__'
const MARKER_LINE_LIMIT = 512

export interface OperationDependencies {
    openStream(alias: string, command: string, marker: string, options: OperationStartOptions): Promise<ClientChannel>
    cancelRemote(
        alias: string,
        pid: number,
        marker: string,
        processGroup: boolean,
        options: OperationStartOptions
    ): Promise<{ success: boolean; error?: string }>
}

type PendingTermination =
    { type: 'close'; code: number | null; signal: string | null } | { type: 'error'; error: Error }

interface OperationRecord {
    operationId: string
    alias: string
    command: string
    marker: string
    status: OperationStatus
    pid: number | null
    processGroup: boolean
    markerVerified: boolean
    cancelRequested: boolean
    cancelInFlight: boolean
    pendingTermination: PendingTermination | null
    startedAt: number
    finishedAt: number | null
    expiresAt: number | null
    retentionMs: number
    exitCode: number | null
    signal: string | null
    stdout: Buffer
    stderr: Buffer
    stdoutBytes: number
    stderrBytes: number
    stdoutTruncated: boolean
    stderrTruncated: boolean
    maxOutputBytes: number
    markerBuffer: Buffer
    stream: ClientChannel
    options: OperationStartOptions
    error?: string
}

export class OperationManager {
    private readonly operations = new Map<string, OperationRecord>()
    private readonly sweeper: NodeJS.Timeout

    constructor(
        private readonly dependencies: OperationDependencies,
        private readonly now: () => number = Date.now
    ) {
        this.sweeper = setInterval(() => this.sweepExpired(), 60_000)
        this.sweeper.unref?.()
    }

    async start(alias: string, command: string, options: OperationStartOptions = {}): Promise<OperationInfo> {
        const operationId = `op_${randomUUID()}`
        const marker = randomBytes(32).toString('hex')
        const maxOutputBytes = this.normalizeMaxOutputBytes(options.maxOutputBytes)
        const retentionMs = this.normalizeRetentionMs(options.retentionMs)
        const stream = await this.dependencies.openStream(alias, command, marker, options)
        const record: OperationRecord = {
            operationId,
            alias,
            command,
            marker,
            status: 'starting',
            pid: null,
            processGroup: false,
            markerVerified: false,
            cancelRequested: false,
            cancelInFlight: false,
            pendingTermination: null,
            startedAt: this.now(),
            finishedAt: null,
            expiresAt: null,
            retentionMs,
            exitCode: null,
            signal: null,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            stdoutBytes: 0,
            stderrBytes: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
            maxOutputBytes,
            markerBuffer: Buffer.alloc(0),
            stream,
            options: { ...options, maxOutputBytes, retentionMs },
        }

        this.operations.set(operationId, record)
        this.attachStream(record)
        return this.info(record)
    }

    status(operationId: string): OperationInfo {
        return this.info(this.requireOperation(operationId))
    }

    read(
        operationId: string,
        options: { stdoutOffset?: number; stderrOffset?: number; maxBytes?: number } = {}
    ): OperationReadResult {
        const record = this.requireOperation(operationId)
        const maxReadBytes = this.normalizeReadBytes(options.maxBytes)
        const stdoutOffset = this.normalizeOffset(options.stdoutOffset, record.stdout.length, 'stdoutOffset')
        const stderrOffset = this.normalizeOffset(options.stderrOffset, record.stderr.length, 'stderrOffset')
        this.ensureUtf8Boundary(record.stdout, stdoutOffset, 'stdoutOffset')
        this.ensureUtf8Boundary(record.stderr, stderrOffset, 'stderrOffset')
        const stdoutEnd = this.utf8SafeEnd(
            record.stdout,
            stdoutOffset,
            Math.min(record.stdout.length, stdoutOffset + maxReadBytes),
            'stdout'
        )
        const stdout = record.stdout.subarray(stdoutOffset, stdoutEnd)
        const remaining = maxReadBytes - stdout.length
        const stderrEnd = this.utf8SafeEnd(
            record.stderr,
            stderrOffset,
            Math.min(record.stderr.length, stderrOffset + remaining),
            'stderr'
        )
        const stderr = record.stderr.subarray(stderrOffset, stderrEnd)

        return {
            ...this.info(record),
            stdout: stdout.toString('utf8'),
            stderr: stderr.toString('utf8'),
            stdoutOffset,
            stderrOffset,
            nextStdoutOffset: stdoutEnd,
            nextStderrOffset: stderrEnd,
            readBytes: stdout.length + stderr.length,
            maxReadBytes,
        }
    }

    async cancel(operationId: string): Promise<OperationCancelResult> {
        const record = this.requireOperation(operationId)
        if (record.status !== 'starting' && record.status !== 'running') {
            return {
                ...this.info(record),
                success: false,
                cancelRequested: record.cancelRequested,
                retryable: false,
                verificationError: `Operation is ${record.status}`,
            }
        }
        if (!record.markerVerified || record.pid === null) {
            return {
                ...this.info(record),
                success: false,
                cancelRequested: false,
                retryable: true,
                verificationError: 'Remote operation marker has not been verified',
            }
        }

        if (record.cancelInFlight) {
            return {
                ...this.info(record),
                success: false,
                cancelRequested: record.cancelRequested,
                retryable: true,
                verificationError: 'Remote cancellation is already in progress',
            }
        }

        record.cancelInFlight = true
        let result: { success: boolean; error?: string }
        try {
            result = await this.dependencies.cancelRemote(
                record.alias,
                record.pid,
                record.marker,
                record.processGroup,
                record.options
            )
        } catch (error) {
            record.cancelInFlight = false
            this.finishPendingTermination(record)
            throw error
        }
        record.cancelInFlight = false
        if (result.success) {
            record.cancelRequested = true
        }
        this.finishPendingTermination(record)
        return {
            ...this.info(record),
            success: result.success,
            cancelRequested: record.cancelRequested,
            retryable: !result.success,
            ...(result.error ? { verificationError: result.error } : {}),
        }
    }

    list(alias?: string): OperationInfo[] {
        this.sweepExpired()
        return Array.from(this.operations.values())
            .filter((record) => alias === undefined || record.alias === alias)
            .map((record) => this.info(record))
    }

    markAliasDisconnected(alias: string): void {
        for (const record of this.operations.values()) {
            if (record.alias === alias && (record.status === 'starting' || record.status === 'running')) {
                record.status = 'unknown'
                record.error = 'SSH session disconnected before remote process state could be confirmed'
                this.finish(record)
            }
        }
    }

    sweepExpired(): void {
        const now = this.now()
        for (const [operationId, record] of this.operations) {
            if (record.expiresAt !== null && record.expiresAt <= now) {
                this.operations.delete(operationId)
            }
        }
    }

    close(): void {
        clearInterval(this.sweeper)
    }

    private attachStream(record: OperationRecord): void {
        record.stream.on('data', (data: Buffer) => {
            record.stdoutBytes += data.length
            this.appendOutput(record, 'stdout', data)
        })
        record.stream.stderr.on('data', (data: Buffer) => {
            this.consumeMarker(record, data)
        })
        record.stream.on('error', (error: Error) => {
            if (record.cancelInFlight) {
                record.pendingTermination ??= { type: 'error', error }
                return
            }
            this.finishStreamError(record, error)
        })
        record.stream.on('close', (code: number | null, signal?: string) => {
            const close = { type: 'close' as const, code, signal: signal ?? null }
            if (record.cancelInFlight) {
                record.pendingTermination ??= close
                return
            }
            this.finishStreamClose(record, close.code, close.signal)
        })
    }

    private finishPendingTermination(record: OperationRecord): void {
        const pending = record.pendingTermination
        record.pendingTermination = null
        if (!pending) {
            return
        }
        if (pending.type === 'error') {
            this.finishStreamError(record, pending.error)
            return
        }
        this.finishStreamClose(record, pending.code, pending.signal)
    }

    private finishStreamError(record: OperationRecord, error: Error): void {
        if (record.status === 'unknown' || record.finishedAt !== null) {
            return
        }
        record.status = 'failed'
        record.error = error.message
        this.finish(record)
    }

    private finishStreamClose(record: OperationRecord, code: number | null, signal: string | null): void {
        if (record.status === 'unknown' || record.finishedAt !== null) {
            return
        }
        record.exitCode = code
        record.signal = signal
        if (record.cancelRequested) {
            record.status = 'cancelled'
        } else if (!record.markerVerified) {
            record.status = 'failed'
            record.error = 'Remote operation exited before its marker was verified'
        } else {
            record.status = code === 0 ? 'completed' : 'failed'
        }
        this.finish(record)
    }

    private consumeMarker(record: OperationRecord, data: Buffer): void {
        if (record.markerVerified) {
            record.stderrBytes += data.length
            this.appendOutput(record, 'stderr', data)
            return
        }
        record.markerBuffer = Buffer.concat([record.markerBuffer, data])
        const newline = record.markerBuffer.indexOf(0x0a)
        if (newline < 0) {
            if (record.markerBuffer.length > MARKER_LINE_LIMIT) {
                record.status = 'failed'
                record.error = 'Remote operation marker exceeded the allowed length'
                record.stderrBytes += record.markerBuffer.length
                this.appendOutput(record, 'stderr', record.markerBuffer)
                record.markerBuffer = Buffer.alloc(0)
            }
            return
        }

        const line = record.markerBuffer.subarray(0, newline).toString('utf8').trim()
        const remainder = record.markerBuffer.subarray(newline + 1)
        record.markerBuffer = Buffer.alloc(0)
        const expectedPrefix = `${MARKER_PREFIX}:${record.marker}:`
        if (!line.startsWith(expectedPrefix)) {
            record.status = 'failed'
            record.error = 'Remote operation marker did not match the local operation'
            const invalidMarker = Buffer.from(`${line}\n`)
            record.stderrBytes += invalidMarker.length + remainder.length
            this.appendOutput(record, 'stderr', invalidMarker)
            this.appendOutput(record, 'stderr', remainder)
            return
        }

        const [pidText, groupText] = line.slice(expectedPrefix.length).split(':')
        const pid = Number(pidText)
        if (!Number.isSafeInteger(pid) || pid <= 0 || (groupText !== '0' && groupText !== '1')) {
            record.status = 'failed'
            record.error = 'Remote operation marker contained invalid process metadata'
            return
        }
        record.pid = pid
        record.processGroup = groupText === '1'
        record.markerVerified = true
        record.status = 'running'
        record.stderrBytes += remainder.length
        this.appendOutput(record, 'stderr', remainder)
    }

    private appendOutput(record: OperationRecord, stream: 'stdout' | 'stderr', data: Buffer): void {
        const storedBytes = record.stdout.length + record.stderr.length
        const available = Math.max(0, record.maxOutputBytes - storedBytes)
        const stored = data.subarray(0, available)
        record[stream] = Buffer.concat([record[stream], stored])
        if (stored.length < data.length) {
            if (stream === 'stdout') {
                record.stdoutTruncated = true
            } else {
                record.stderrTruncated = true
            }
        }
    }

    private finish(record: OperationRecord): void {
        if (record.finishedAt !== null) {
            return
        }
        record.finishedAt = this.now()
        record.expiresAt = record.finishedAt + record.retentionMs
    }

    private info(record: OperationRecord): OperationInfo {
        return {
            operationId: record.operationId,
            alias: record.alias,
            status: record.status,
            pid: record.pid,
            processGroup: record.processGroup,
            markerVerified: record.markerVerified,
            cancelRequested: record.cancelRequested,
            startedAt: record.startedAt,
            finishedAt: record.finishedAt,
            expiresAt: record.expiresAt,
            retentionMs: record.retentionMs,
            exitCode: record.exitCode,
            signal: record.signal,
            stdoutBytes: record.stdoutBytes,
            stderrBytes: record.stderrBytes,
            stdoutStoredBytes: record.stdout.length,
            stderrStoredBytes: record.stderr.length,
            stdoutTruncated: record.stdoutTruncated,
            stderrTruncated: record.stderrTruncated,
            maxOutputBytes: record.maxOutputBytes,
            ...(record.error ? { error: record.error } : {}),
        }
    }

    private requireOperation(operationId: string): OperationRecord {
        this.sweepExpired()
        const record = this.operations.get(operationId)
        if (!record) {
            throw new Error(`Operation '${operationId}' not found or expired`)
        }
        return record
    }

    private normalizeMaxOutputBytes(value: number | undefined): number {
        const normalized = value ?? DEFAULT_OPERATION_MAX_OUTPUT_BYTES
        if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > HARD_OPERATION_MAX_OUTPUT_BYTES) {
            throw new Error(`maxOutputBytes must be between 1 and ${HARD_OPERATION_MAX_OUTPUT_BYTES}`)
        }
        return normalized
    }

    private normalizeReadBytes(value: number | undefined): number {
        const normalized = value ?? DEFAULT_OPERATION_READ_BYTES
        if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > HARD_OPERATION_READ_BYTES) {
            throw new Error(`maxBytes must be between 1 and ${HARD_OPERATION_READ_BYTES}`)
        }
        return normalized
    }

    private normalizeRetentionMs(value: number | undefined): number {
        const normalized = value ?? DEFAULT_OPERATION_RETENTION_MS
        if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > MAX_OPERATION_RETENTION_MS) {
            throw new Error(`retentionMs must be between 1 and ${MAX_OPERATION_RETENTION_MS}`)
        }
        return normalized
    }

    private normalizeOffset(value: number | undefined, length: number, field: string): number {
        const normalized = value ?? 0
        if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > length) {
            throw new Error(`${field} must be between 0 and ${length}`)
        }
        return normalized
    }

    private ensureUtf8Boundary(buffer: Buffer, offset: number, field: string): void {
        if (offset < buffer.length && this.isUtf8ContinuationByte(buffer[offset])) {
            throw new Error(`${field} must point to a UTF-8 character boundary`)
        }
    }

    private utf8SafeEnd(buffer: Buffer, start: number, requestedEnd: number, stream: string): number {
        const limitedByMaxBytes = requestedEnd < buffer.length
        let end = requestedEnd
        if (limitedByMaxBytes) {
            while (end > start && this.isUtf8ContinuationByte(buffer[end])) {
                --end
            }
        }
        end = this.trimIncompleteUtf8Sequence(buffer, start, end)
        if (end === start && requestedEnd > start && limitedByMaxBytes) {
            throw new Error(`maxBytes is too small to read the next UTF-8 character from ${stream}`)
        }
        return end
    }

    private trimIncompleteUtf8Sequence(buffer: Buffer, start: number, end: number): number {
        if (end <= start) {
            return end
        }
        let sequenceStart = end - 1
        while (sequenceStart > start && this.isUtf8ContinuationByte(buffer[sequenceStart])) {
            --sequenceStart
        }
        const expectedLength = this.utf8SequenceLength(buffer[sequenceStart])
        return sequenceStart + expectedLength > end ? sequenceStart : end
    }

    private utf8SequenceLength(value: number): number {
        if ((value & 0x80) === 0) {
            return 1
        }
        if ((value & 0xe0) === 0xc0) {
            return 2
        }
        if ((value & 0xf0) === 0xe0) {
            return 3
        }
        if ((value & 0xf8) === 0xf0) {
            return 4
        }
        return 1
    }

    private isUtf8ContinuationByte(value: number): boolean {
        return (value & 0xc0) === 0x80
    }
}
